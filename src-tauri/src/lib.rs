mod ssh;
mod models;
mod config;
mod sftp;
mod services;
mod session_events;
mod telnet;
mod local;
mod utils;
mod monitor;
#[cfg(target_os = "windows")]
mod os_drop_paths;

use ssh::{SshConfig, SshManager, SshSession, TunnelManager};
use sftp::{SftpConfig, SftpManager, SftpSession, FileItem};
use telnet::{TelnetConfig, TelnetManager, TelnetSession};
use local::{LocalShellConfig, LocalShellManager, LocalShellSession};
use monitor::{MonitorManager, MonitorSession, MonitorSnapshot};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use std::thread;
use std::time::Duration;
use crate::config::global_config::GlobaConfig;
use crate::config::{global_config, global_enum};
use crate::utils::path;
use crate::services::logs::write_log;
use crate::services::keys::load_key_content;
use crate::services::certificates::load_cert_content;
use crate::utils::sqlite;
use crate::session_events::emit_session_event;

/// 应用运行时状态：SSH/SFTP 会话管理器随 App 生命周期创建与销毁。
struct AppState {
    ssh: Mutex<SshManager>,
    sftp: Mutex<SftpManager>,
    telnet: Mutex<TelnetManager>,
    local: Mutex<LocalShellManager>,
    tunnels: Mutex<TunnelManager>,
    monitor: Mutex<MonitorManager>,
    /// 传输取消标志表：cancel_token -> AtomicBool（下载中断用）
    transfer_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            ssh: Mutex::new(SshManager::new()),
            sftp: Mutex::new(SftpManager::new()),
            telnet: Mutex::new(TelnetManager::new()),
            local: Mutex::new(LocalShellManager::new()),
            tunnels: Mutex::new(TunnelManager::new()),
            monitor: Mutex::new(MonitorManager::new()),
            transfer_cancels: Mutex::new(HashMap::new()),
        }
    }
}

/// 连接命令返回结果：connected 或需要主机密钥确认。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    status: String,
    fingerprint: Option<String>,
    host: String,
    port: u16,
    /// 待确认主机密钥的 token：前端确认后回传给 accept_host_key（凭此从后端取回完整配置）
    host_key_token: Option<String>,
    /// 后端生成的会话 id（监控等由后端自建会话的命令使用；终端等前端传 id 的命令为 None）
    session_id: Option<String>,
}

impl ConnectResult {
    fn connected(host: String, port: u16) -> Self {
        Self {
            status: "connected".into(),
            fingerprint: None,
            host,
            port,
            host_key_token: None,
            session_id: None,
        }
    }

    fn connected_with_session(host: String, port: u16, session_id: String) -> Self {
        Self {
            status: "connected".into(),
            fingerprint: None,
            host,
            port,
            host_key_token: None,
            session_id: Some(session_id),
        }
    }

    fn needs_host_key_approval(host: String, port: u16, fingerprint: String, token: String) -> Self {
        Self {
            status: "needsHostKeyApproval".into(),
            fingerprint: Some(fingerprint),
            host,
            port,
            host_key_token: Some(token),
            session_id: None,
        }
    }
}

fn read_connection_timeout(config_state: &State<'_, GlobaConfig>) -> u32 {
    config_state
        .config
        .read()
        .map(|guard| guard.ssh.connection_timeout)
        .unwrap_or(ssh::session::DEFAULT_CONNECTION_TIMEOUT_SECS)
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splash_window) = app.get_webview_window("splashscreen") {
        splash_window.close().map_err(|e| e.to_string())?;
    }
    
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.show().map_err(|e| e.to_string())?;
        main_window.set_focus().map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    app_handle: tauri::AppHandle,
    session_id: String,
    mut config: SshConfig,
    cols: u32,
    rows: u32,
) -> Result<ConnectResult, String> {
    let timeout_secs = read_connection_timeout(&config_state);
    let keep_alive_interval = config_state
        .config
        .read()
        .map(|guard| guard.ssh.keep_alive_interval)
        .unwrap_or(60);

    // 如果会话已存在则复用（避免在切换标签或重挂载时重复建立连接）——短暂持锁
    {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host, config.port));
        }
    }

    // 密钥认证：根据 key_id 从数据库读取密钥内容，用于内存认证（不落盘）
    if config.auth_type == "key" {
        if let Some(key_id) = config.key_id.clone() {
            let conn = sqlite::open_connection()?;
            let (private_key, public_key) = load_key_content(&conn, &key_id)?;
            if private_key.is_none() && public_key.is_none() {
                return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
            }
            config.private_key = private_key;
            config.public_key = public_key;
        } else if config.private_key.is_none() && config.key_path.is_none() {
            return Err("密钥认证缺少可用的密钥，请到“账号/主机”页重新选择密钥。".to_string());
        }
    }

    // 证书认证：根据 cert_id 从数据库读取证书与配套私钥内容，用于临时文件认证（不落盘）
    if config.auth_type == "certificate" {
        if let Some(cert_id) = config.cert_id.clone() {
            let conn = sqlite::open_connection()?;
            let (cert_content, private_key) = load_cert_content(&conn, &cert_id)?;
            if cert_content.is_none() {
                return Err("该证书的内容未存储，请重新导入证书。".to_string());
            }
            if private_key.is_none() {
                return Err(
                    "该证书未绑定配套私钥，无法完成 SSH 认证，请到“证书”页重新导入并附上私钥。"
                        .to_string(),
                );
            }
            config.cert_content = cert_content;
            config.cert_private_key = private_key;
        }
    }

    // 建连挪到阻塞线程池：不持全局锁、不占 tokio 异步 worker（慢连接不再拖慢其他命令）
    let connect_config = config.clone();
    let connect_session_id = session_id.clone();
    let progress_app = app_handle.clone();
    let progress_session_id = session_id.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        // 分阶段连接进度：emit 到 session-{id}，前端据此真实展示进度（替代假进度条）
        let on_progress = |stage: &str, message: Option<&str>| {
            let _ = progress_app.emit(
                &format!("session-{}", progress_session_id),
                crate::session_events::SessionEvent::Progress {
                    stage: stage.to_string(),
                    message: message.map(|s| s.to_string()),
                },
            );
        };
        SshSession::connect(connect_config, connect_session_id, timeout_secs, &on_progress)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;

    let session = match connect_result {
        Ok(session) => session,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<ssh::session::HostKeyApprovalRequired>() {
                // 待确认的可能是跳板机而非目标主机，用 approval 携带的真实 host/port 与 token
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            {
                let _ = write_log(
                    "error",
                    &format!(
                        "SSH connection failed to {}@{}:{}: {}",
                        config.username, config.host, config.port, e
                    ),
                    Some("ssh"),
                );
            }
            return Err(format!("SSH connection failed: {}", e));
        }
    };

    // 插入会话（短暂持锁，避免重复插入）
    {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host, config.port));
        }
        manager.insert_session(session_id.clone(), session);
    }

    // 获取会话并启动 shell（不持全局锁）
    if let Some(session) = {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        manager.get_session(&session_id)
    } {
        if let Err(e) = session.start_shell(app_handle, cols, rows, keep_alive_interval) {
            // shell 启动失败时移除会话，避免残留无 shell 的僵尸会话
            let _ = {
                let manager = state.ssh.lock().map_err(|e| e.to_string())?;
                manager.disconnect(&session_id)
            };
            let _ = write_log(
                "error",
                &format!(
                    "SSH shell start failed for {}@{}:{}: {}",
                    config.username, config.host, config.port, e
                ),
                Some("ssh"),
            );
            return Err(format!("Failed to start shell: {}", e));
        }
    }

    let _ = write_log(
        "info",
        &format!("SSH connected to {}@{}:{}", config.username, config.host, config.port),
        Some("ssh"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
async fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?
    };
    // 写入挪到阻塞线程池：不持全局锁、不占 tokio 异步 worker
    // （长按高频输入时，阻塞的终端写入不会拖慢全局 IPC）
    tauri::async_runtime::spawn_blocking(move || session.write_data(&data))
        .await
        .map_err(|e| format!("Write task failed: {e}"))?
        .map_err(|e| format!("Failed to write data: {}", e))
}

#[tauri::command]
async fn ssh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let session = {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?
    };
    // 锁已释放
    session
        .resize_pty(cols, rows)
        .map_err(|e| format!("Failed to resize PTY: {}", e))
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    // 移除会话在锁内（快），断开握手（网络 I/O）在 manager 内部锁外执行
    let result = {
        let manager = state.ssh.lock().map_err(|e| e.to_string())?;
        manager
            .disconnect(&session_id)
            .map_err(|e| format!("Failed to disconnect: {}", e))
    };
    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "{} SSH session {}",
            if result.is_ok() { "Disconnected" } else { "Failed to disconnect" },
            session_id
        ),
        Some("ssh"),
    );
    result
}

#[tauri::command]
async fn ssh_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.ssh.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

// ==================== Telnet Commands ====================

#[tauri::command]
async fn telnet_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: TelnetConfig,
) -> Result<ConnectResult, String> {
    let timeout_secs = read_connection_timeout(&config_state);

    // 快速路径：会话已存在则复用
    {
        let manager = state.telnet.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host.clone(), config.port));
        }
    }

    // 建连挪到阻塞线程池（不占 tokio worker，慢连接不拖慢全局 IPC）
    let connect_config = config.clone();
    let connect_session_id = session_id.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        TelnetSession::connect(connect_config, connect_session_id, timeout_secs)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;

    let session = match connect_result {
        Ok(session) => session,
        Err(e) => {
            let _ = write_log(
                "error",
                &format!(
                    "Telnet connection failed to {}:{}: {}",
                    config.host, config.port, e
                ),
                Some("telnet"),
            );
            return Err(format!("Telnet connection failed: {e}"));
        }
    };

    // 插入会话（短暂持锁）
    {
        let manager = state.telnet.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host.clone(), config.port));
        }
        manager.insert_session(session_id.clone(), session);
    }

    // 启动读循环并推进连接进度（telnet 无 ssh/auth/shell 阶段，快速推进到 ready）
    if let Some(session) = {
        let manager = state.telnet.lock().map_err(|e| e.to_string())?;
        manager.get_session(&session_id)
    } {
        let progress = |stage: &str, message: Option<&str>| {
            emit_session_event(
                &app_handle,
                &session_id,
                &crate::session_events::SessionEvent::Progress {
                    stage: stage.to_string(),
                    message: message.map(|s| s.to_string()),
                },
            );
        };
        progress("tcp", Some(&format!("{}:{}", config.host, config.port)));
        progress("ssh", None);
        progress("auth", None);
        progress("shell", None);
        session.start_read_loop(app_handle.clone());
        progress("ready", None);
    }

    let _ = write_log(
        "info",
        &format!("Telnet connected to {}:{}", config.host, config.port),
        Some("telnet"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
async fn telnet_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let manager = state.telnet.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("Telnet session {} not found", session_id))?
    };
    // 写入挪到阻塞线程池（长按高频输入时不占 tokio worker）
    tauri::async_runtime::spawn_blocking(move || session.write_data(&data))
        .await
        .map_err(|e| format!("Write task failed: {e}"))?
        .map_err(|e| format!("Failed to write data: {}", e))
}

#[tauri::command]
async fn telnet_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let result = {
        let manager = state.telnet.lock().map_err(|e| e.to_string())?;
        manager
            .disconnect(&session_id)
            .map_err(|e| format!("Failed to disconnect: {}", e))
    };
    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "{} Telnet session {}",
            if result.is_ok() { "Disconnected" } else { "Failed to disconnect" },
            session_id
        ),
        Some("telnet"),
    );
    result
}

#[tauri::command]
async fn telnet_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.telnet.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

// ==================== Local Shell (PTY) Commands ====================

#[tauri::command]
async fn local_shell_connect(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: LocalShellConfig,
    cols: u32,
    rows: u32,
) -> Result<ConnectResult, String> {
    // 快速路径：会话已存在则复用
    {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected("localhost".to_string(), 0));
        }
    }

    // 建连（启动本地进程 + PTY）挪到阻塞线程池，不占 tokio worker
    let connect_config = config.clone();
    let connect_session_id = session_id.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        LocalShellSession::connect(connect_config, connect_session_id, cols, rows)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;

    let session = match connect_result {
        Ok(session) => session,
        Err(e) => {
            let _ = write_log(
                "error",
                &format!("Local shell start failed ({}): {}", config.shell, e),
                Some("local"),
            );
            return Err(format!("Local shell failed to start: {e}"));
        }
    };

    // 插入会话（短暂持锁）
    {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected("localhost".to_string(), 0));
        }
        manager.insert_session(session_id.clone(), session);
    }

    // 启动读循环并快速推进进度（本地终端无 tcp/ssh/auth 阶段）
    if let Some(session) = {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        manager.get_session(&session_id)
    } {
        let progress = |stage: &str, message: Option<&str>| {
            emit_session_event(
                &app_handle,
                &session_id,
                &crate::session_events::SessionEvent::Progress {
                    stage: stage.to_string(),
                    message: message.map(|s| s.to_string()),
                },
            );
        };
        progress("tcp", Some("local"));
        progress("ssh", None);
        progress("auth", None);
        progress("shell", Some(&config.shell));
        session.start_read_loop(app_handle.clone());
        progress("ready", None);
    }

    let _ = write_log(
        "info",
        &format!("Local shell started: {}", config.shell),
        Some("local"),
    );

    Ok(ConnectResult::connected("localhost".to_string(), 0))
}

#[tauri::command]
async fn local_shell_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("Local shell session {} not found", session_id))?
    };
    tauri::async_runtime::spawn_blocking(move || session.write_data(&data))
        .await
        .map_err(|e| format!("Write task failed: {e}"))?
        .map_err(|e| format!("Failed to write data: {}", e))
}

#[tauri::command]
async fn local_shell_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let session = {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("Local shell session {} not found", session_id))?
    };
    session
        .resize(cols, rows)
        .map_err(|e| format!("Failed to resize PTY: {}", e))
}

#[tauri::command]
async fn local_shell_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let result = {
        let manager = state.local.lock().map_err(|e| e.to_string())?;
        manager
            .disconnect(&session_id)
            .map_err(|e| format!("Failed to disconnect: {}", e))
    };
    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "{} local shell session {}",
            if result.is_ok() { "Disconnected" } else { "Failed to disconnect" },
            session_id
        ),
        Some("local"),
    );
    result
}

#[tauri::command]
async fn local_shell_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.local.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

#[tauri::command]
fn accept_host_key(
    config_state: State<'_, GlobaConfig>,
    token: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    let timeout_secs = read_connection_timeout(&config_state);
    ssh::session::accept_host_key(&token, &expected_fingerprint, timeout_secs)
        .map_err(|e| format!("Failed to accept host key: {}", e))
}

#[tauri::command]
fn apply_window_effect(app: tauri::AppHandle, effect: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        match effect.as_str() {
            // 新式 DWM backdrop（Win11 22H2+）：失焦保持；旧系统失败时回退 tauri 旧 API
            "acrylic" => apply_system_backdrop(&window, 3)
                .or_else(|_| set_tauri_effect(&window, "acrylic")), // DWMSBT_TRANSIENTWINDOW
            "mica" => apply_system_backdrop(&window, 2)
                .or_else(|_| set_tauri_effect(&window, "mica")), // DWMSBT_MAINWINDOW
            "blur" => apply_system_backdrop(&window, 0)
                .or_else(|_| set_tauri_effect(&window, "blur")), // blur 无新式 backdrop
            _ => {
                // none：清掉新式 backdrop（DWMSBT_NONE）+ 旧 API 效果
                let _ = apply_system_backdrop(&window, 0);
                let _ = window.set_effects(None);
                Ok(())
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, effect);
        Ok(())
    }
}

/// 应用 Windows 11 22H2+ 的**新式** DWM backdrop（`DWMWA_SYSTEMBACKDROP_TYPE`）：
/// - 3 = DWMSBT_TRANSIENTWINDOW：新式 Acrylic（失焦保持、无老 API 拖拽卡顿）
/// - 2 = DWMSBT_MAINWINDOW：Mica
/// - 0 = DWMSBT_NONE：清除
/// 返回 Ok 表示新式 API 生效；Err（系统 < 22H2 / 调用失败）由调用方回退旧 API。
#[cfg(target_os = "windows")]
fn apply_system_backdrop(window: &tauri::WebviewWindow, backdrop_type: i32) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};

    // tauri 的 HWND 是 windows::Win32::Foundation::HWND（newtype 包装 *mut c_void），取 .0 传给 windows-sys
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("获取窗口句柄失败: {e}"))?
        .0;
    // DWMWINDOWATTRIBUTE 是 i32 类型，函数参数要求 u32，需显式转换
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &backdrop_type as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };
    if hr >= 0 {
        Ok(())
    } else {
        Err(format!("DwmSetWindowAttribute 失败: HRESULT {hr:#x}"))
    }
}

/// 回退：用 tauri 内置 set_effects（内部走 window-vibrancy 旧 API）。
#[cfg(target_os = "windows")]
fn set_tauri_effect(window: &tauri::WebviewWindow, effect: &str) -> Result<(), String> {
    use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
    let effect = match effect {
        "acrylic" => Effect::Acrylic,
        "mica" => Effect::Mica,
        _ => Effect::Blur,
    };
    window
        .set_effects(Some(
            EffectsBuilder::new()
                .effect(effect)
                .state(EffectState::Active)
                .radius(0.)
                .color(Color(0, 0, 0, 125))
                .build(),
        ))
        .map_err(|e| format!("应用窗口效果失败: {e}"))
}

// ==================== Port Forwarding Tunnel Commands ====================

#[tauri::command]
async fn start_port_forward(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    rule_id: String,
) -> Result<ConnectResult, String> {
    let conn = sqlite::open_connection()?;
    let rule = services::port_forwardings::load_port_forwarding(&conn, &rule_id)?
        .ok_or_else(|| "端口转发规则不存在或已被删除".to_string())?;

    let host_id = rule
        .host_id
        .clone()
        .ok_or_else(|| "该规则未指定 SSH 主机，无法建立隧道".to_string())?;

    // 解析主机认证（账号优先/主机回退）并读取密钥/证书内容，与终端连接同链路
    let config = services::port_forwardings::resolve_host_ssh_config(&conn, &host_id)?;

    let timeout_secs = read_connection_timeout(&config_state);
    // 隧道建连挪到阻塞线程池：不占 tokio 异步 worker（慢连接不拖慢全局 IPC）
    let connect_config = config.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        ssh::session::SshSession::establish_authenticated_session(&connect_config, timeout_secs, &|_, _| {})
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;
    let established = match connect_result {
        Ok(est) => est,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<ssh::session::HostKeyApprovalRequired>() {
                // 待确认的可能是跳板机而非目标主机，用 approval 携带的真实 host/port 与 token
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            let _ = write_log(
                "error",
                &format!(
                    "Port forward tunnel SSH connection failed to {}@{}:{}: {}",
                    config.username, config.host, config.port, e
                ),
                Some("portforwarding"),
            );
            return Err(format!("SSH connection failed: {}", e));
        }
    };

    // 建立隧道并启动后台监听循环（跳板机传输层一并持有，保证跳板连接存活）
    let tunnel = ssh::tunnel::start_tunnel(&rule, established.session, established.jump)
        .map_err(|e| format!("Failed to start tunnel: {}", e))?;

    let tunnel_arc = Arc::new(tunnel);
    let manager = {
        let guard = state.tunnels.lock().map_err(|e| e.to_string())?;
        guard.insert(rule_id.clone(), tunnel_arc.clone());
        guard.clone()
    };

    services::port_forwardings::touch_last_used(&conn, &rule_id)?;

    // 看门狗：检测隧道 SSH 会话是否意外断开（网络中断/服务器重启等），
    // 断开后自动清理注册表与数据库状态，避免 UI 一直显示「已连接」。
    let watch_rule_id = rule_id.clone();
    let watch_name = rule.name.clone();
    thread::spawn(move || {
        let mut failures = 0u32;
        loop {
            thread::sleep(Duration::from_secs(3));
            if !tunnel_arc.is_running() {
                break; // 已被主动 stop
            }
            if tunnel_arc.is_alive() {
                failures = 0;
            } else {
                failures += 1;
                // 连续两次 keepalive 失败才判定断开，降低网络抖动误判
                if failures >= 2 {
                    manager.stop(&watch_rule_id);
                    // 通知前端即时刷新该规则的状态（状态由内存隧道派生，无需写 DB）
                    let _ = app.emit(
                        "port-forward-status",
                        serde_json::json!({ "ruleId": watch_rule_id, "status": "disconnected" }),
                    );
                    let _ = write_log(
                        "warn",
                        &format!("Port forward tunnel lost connection: {}", watch_name),
                        Some("portforwarding"),
                    );
                    break;
                }
            }
        }
    });

    let _ = write_log(
        "info",
        &format!(
            "Port forward tunnel started: {} ({}:{} -> {}:{})",
            rule.name,
            rule.listen_host,
            rule.listen_port,
            rule.target_host.as_deref().unwrap_or("SOCKS5"),
            rule.target_port
        ),
        Some("portforwarding"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
async fn stop_port_forward(state: State<'_, AppState>, rule_id: String) -> Result<(), String> {
    let stopped = state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .stop(&rule_id);
    if stopped {
        let _ = write_log("info", "Port forward tunnel stopped", Some("portforwarding"));
    }
    Ok(())
}

#[tauri::command]
async fn list_active_port_forwards(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.tunnels.lock().map_err(|e| e.to_string())?.list())
}

// ==================== Server Monitor Commands ====================

#[tauri::command]
async fn monitor_start(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    host_id: String,
) -> Result<ConnectResult, String> {
    // 后端自建监控会话 id（监控页不是标签，无前端 sessionId）
    let session_id = format!(
        "monitor-{}-{}",
        host_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    // 解析主机认证（账号优先/主机回退，含跳板机 + 密钥/证书内容），与终端连接同链路
    let conn = sqlite::open_connection()?;
    let config = services::port_forwardings::resolve_host_ssh_config(&conn, &host_id)?;

    let timeout_secs = read_connection_timeout(&config_state);
    let connect_config = config.clone();
    // 建连挪到阻塞线程池：不占 tokio 异步 worker（慢连接不拖慢全局 IPC）
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        MonitorSession::connect(&connect_config, timeout_secs)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;

    let session = match connect_result {
        Ok(session) => session,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<ssh::session::HostKeyApprovalRequired>() {
                // 待确认的可能是跳板机而非目标主机，用 approval 携带的真实 host/port 与 token
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            let _ = write_log(
                "error",
                &format!(
                    "Monitor SSH connection failed to {}@{}:{}: {}",
                    config.username, config.host, config.port, e
                ),
                Some("monitor"),
            );
            return Err(format!("监控连接失败: {e}"));
        }
    };

    {
        let manager = state.monitor.lock().map_err(|e| e.to_string())?;
        manager.insert(session_id.clone(), session);
    }

    Ok(ConnectResult::connected_with_session(
        config.host,
        config.port,
        session_id,
    ))
}

#[tauri::command]
async fn monitor_collect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MonitorSnapshot, String> {
    let session = {
        let manager = state.monitor.lock().map_err(|e| e.to_string())?;
        manager
            .get(&session_id)
            .ok_or_else(|| format!("监控会话 {} 不存在", session_id))?
    };
    // 采集挪到阻塞线程池（exec + 阻塞读），不占 tokio 异步 worker
    tauri::async_runtime::spawn_blocking(move || -> Result<MonitorSnapshot, String> {
        let mut guard = session.lock().map_err(|e| e.to_string())?;
        guard.collect().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("采集任务失败: {e}"))?
}

#[tauri::command]
async fn monitor_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let removed = {
        let manager = state.monitor.lock().map_err(|e| e.to_string())?;
        manager.remove(&session_id)
    };
    if let Some(session) = removed {
        if let Ok(guard) = session.lock() {
            guard.disconnect();
        }
    }
    Ok(())
}

#[tauri::command]
async fn monitor_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.monitor.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}

// ==================== SFTP Commands ====================

#[tauri::command]
async fn sftp_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    session_id: String,
    config: SftpConfig,
) -> Result<ConnectResult, String> {
    let timeout_secs = read_connection_timeout(&config_state);
    let keep_alive_interval = config_state
        .config
        .read()
        .map(|guard| guard.ssh.keep_alive_interval)
        .unwrap_or(60);
    let mut config = config;

    // 公钥认证：根据 key_id 从密钥库读取密钥内容（与 SSH 终端一致，不落盘）
    if config.protocol == "sftp" && config.auth_type == "publickey" {
        if let Some(key_id) = config.key_id.clone() {
            let conn = sqlite::open_connection()?;
            let (private_key, public_key) = load_key_content(&conn, &key_id)?;
            if private_key.is_none() && public_key.is_none() {
                return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
            }
            config.private_key = private_key;
            config.public_key = public_key;
        }
    }

    // 先检查会话是否已存在（快速路径，避免重复连接）
    {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host, config.port));
        }
    }

    // 连接不持全局锁，且挪到阻塞线程池执行：
    // 慢连接/无响应服务器既不会阻塞其他 SFTP/FTP 命令，也不再占用 tokio 异步 worker 线程
    // （async 命令内直接跑阻塞 I/O，多个慢连接会占满 worker 导致全局 IPC 排队变慢）。
    let connect_config = config.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        SftpSession::connect(connect_config, timeout_secs, keep_alive_interval)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;
    let session = match connect_result {
        Ok(session) => session,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<ssh::session::HostKeyApprovalRequired>() {
                // 待确认的可能是跳板机而非目标主机，用 approval 携带的真实 host/port 与 token
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            let _ = write_log(
                "error",
                &format!(
                    "{} connection failed to {}@{}:{}: {}",
                    config.protocol.to_uppercase(),
                    config.username,
                    config.host,
                    config.port,
                    e
                ),
                Some("sftp"),
            );
            return Err(format!("SFTP connection failed: {}", e));
        }
    };

    // 连接成功后加锁插入（持锁时间最短）
    let mut manager = state.sftp.lock().map_err(|e| e.to_string())?;
    if manager.get_session(&session_id).is_some() {
        return Ok(ConnectResult::connected(config.host, config.port));
    }
    manager.insert_session(session_id, session);

    let _ = write_log(
        "info",
        &format!(
            "{} connected to {}@{}:{}",
            config.protocol.to_uppercase(),
            config.username,
            config.host,
            config.port
        ),
        Some("sftp"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
async fn sftp_list_dir(state: State<'_, AppState>, session_id: String, path: String) -> Result<Vec<FileItem>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 锁已释放 + 阻塞线程池执行：读目录不再排队等待其他会话/传输完成，也不占异步 worker
    let result = tauri::async_runtime::spawn_blocking(move || session.list_dir(&path))
        .await
        .map_err(|e| format!("List task failed: {e}"))?;
    result.map_err(|e| format!("Failed to list directory: {}", e))
}

#[tauri::command]
async fn sftp_download_file(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<Vec<u8>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || session.download_file(&remote_path))
        .await
        .map_err(|e| format!("Download task failed: {e}"))?;
    result.map_err(|e| format!("Failed to download file: {}", e))
}

/// 直接下载到用户通过保存对话框选择的目标路径（Tauri 2 下
/// `<a download>` 失效，改由后端落盘，避免整文件经 IPC 往返）。
#[tauri::command]
async fn sftp_download_file_to(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    target_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 锁已释放 + 阻塞线程池：整文件下载期间列表刷新/其他传输不再被阻塞
    let data = tauri::async_runtime::spawn_blocking(move || session.download_file(&remote_path))
        .await
        .map_err(|e| format!("Download task failed: {e}"))?
        .map_err(|e| format!("Failed to download file: {}", e))?;
    std::fs::write(&target_path, data).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
async fn sftp_upload_file(
    state: State<'_, AppState>,
    session_id: String,
    local_data: Vec<u8>,
    remote_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.upload_file(&local_data, &remote_path))
            .await
            .map_err(|e| format!("Upload task failed: {e}"))?;
    result.map_err(|e| format!("Failed to upload file: {}", e))
}

#[tauri::command]
async fn sftp_delete_file(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.delete_file(&remote_path))
            .await
            .map_err(|e| format!("Delete task failed: {e}"))?;
    result.map_err(|e| format!("Failed to delete file: {}", e))
}

#[tauri::command]
async fn sftp_delete_dir(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.delete_dir(&remote_path))
            .await
            .map_err(|e| format!("Delete task failed: {e}"))?;
    result.map_err(|e| format!("Failed to delete directory: {}", e))
}

#[tauri::command]
async fn sftp_remove_dir_recursive(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 递归删除挪到阻塞线程池：遍历目录树 + 逐个删除期间不阻塞其他命令
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.remove_dir_recursive(&remote_path)
    })
    .await
    .map_err(|e| format!("Remove task failed: {e}"))?;
    result.map_err(|e| format!("Failed to remove directory: {}", e))
}

#[tauri::command]
async fn sftp_create_dir(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.create_dir(&remote_path))
            .await
            .map_err(|e| format!("Create task failed: {e}"))?;
    result.map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
async fn sftp_chmod(state: State<'_, AppState>, session_id: String, remote_path: String, mode: u32) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.chmod(&remote_path, mode))
            .await
            .map_err(|e| format!("Chmod task failed: {e}"))?;
    result.map_err(|e| format!("Failed to change permissions: {}", e))
}

#[tauri::command]
async fn sftp_search_files(
    state: State<'_, AppState>,
    session_id: String,
    root_path: String,
    query: String,
) -> Result<Vec<String>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 递归搜索挪到阻塞线程池（遍历目录树期间不阻塞其他命令）
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.search_files(&root_path, &query, 500)
    })
    .await
    .map_err(|e| format!("Search task failed: {e}"))?;
    result.map_err(|e| format!("Failed to search files: {}", e))
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || session.rename(&old_path, &new_path))
        .await
        .map_err(|e| format!("Rename task failed: {e}"))?;
    result.map_err(|e| format!("Failed to rename: {}", e))
}

/// 分块上传进度事件载荷（下载由后端流式推进度时推送）。
/// 字段必须 camelCase 与前端 `TransferProgressEvent` 解构一致，
/// 否则 sessionId/remotePath 解构为 undefined，进度匹配永远失败。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgress {
    session_id: String,
    remote_path: String,
    done: u64,
    total: u64,
}

#[tauri::command]
async fn sftp_upload_chunk(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
    truncate: bool,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.upload_chunk(&remote_path, &data, truncate)
    })
    .await
    .map_err(|e| format!("Upload task failed: {e}"))?;
    result.map_err(|e| format!("Failed to upload chunk: {}", e))
}

#[tauri::command]
async fn sftp_upload_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    cancel_token: Option<String>,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let progress_session = session_id.clone();
    let progress_path = remote_path.clone();
    // 清理远端半成品与取消标志需在阻塞任务之后使用 session/remote_path（闭包已 move 原值）
    let cleanup_session = session.clone();
    let cleanup_path = remote_path.clone();

    // 注册取消标志（「结束任务」由 sftp_cancel_transfer 置位 → 后端中断上传）
    let cancel_flag: Option<Arc<AtomicBool>> = match cancel_token.clone() {
        Some(token) => {
            let flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut cancels) = state.transfer_cancels.lock() {
                cancels.insert(token, flag.clone());
            }
            Some(flag)
        }
        None => None,
    };

    let result = tauri::async_runtime::spawn_blocking({
        let cancel_flag = cancel_flag.clone();
        move || {
            // 进度事件节流到 1 秒（结束帧立即发）
            let last_emit = std::cell::Cell::new(0u64);
            session
                .upload_local_file(
                    &local_path,
                    &remote_path,
                    |done, total| {
                        if done < total {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            if now.saturating_sub(last_emit.get()) < 1000 {
                                return;
                            }
                            last_emit.set(now);
                        }
                        let _ = app.emit(
                            "sftp-transfer",
                            SftpTransferProgress {
                                session_id: progress_session.clone(),
                                remote_path: progress_path.clone(),
                                done,
                                total,
                            },
                        );
                    },
                    cancel_flag.as_deref(),
                )
                .map_err(|e| format!("Failed to upload: {e}"))
        }
    })
    .await
    .map_err(|e| format!("Upload task failed: {e}"))?;

    // 主动取消：清理远端半成品文件（上传中断时远端可能残留不完整文件）
    if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
        let _ = cleanup_session.delete_file(&cleanup_path);
    }

    // 清理取消标志
    if let Some(token) = cancel_token {
        if let Ok(mut cancels) = state.transfer_cancels.lock() {
            cancels.remove(&token);
        }
    }
    result
}

#[tauri::command]
async fn sftp_download_file_progress(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    target_path: String,
    offset: u64,
    cancel_token: Option<String>,
) -> Result<(), String> {
    let _ = write_log(
        "info",
        &format!("Download started: {} -> {}", remote_path, target_path),
        Some("sftp"),
    );
    // 取 Arc 引用后立即释放全局锁：整个下载过程不再阻塞其他会话命令（列表刷新/上传/删除）
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let progress_session = session_id.clone();
    let progress_path = remote_path.clone();

    // 注册取消标志（支持「结束任务」）：下载中断时由 sftp_cancel_transfer 置位
    let cancel_flag: Option<Arc<AtomicBool>> = match cancel_token.clone() {
        Some(token) => {
            let flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut cancels) = state.transfer_cancels.lock() {
                cancels.insert(token, flag.clone());
            }
            Some(flag)
        }
        None => None,
    };

    // 尾部日志仍需要这两个路径：克隆一份供闭包外使用
    let log_remote = remote_path.clone();
    let log_target = target_path.clone();

    let result = tauri::async_runtime::spawn_blocking({
        // cancel_flag 克隆进阻塞任务，外部保留一份用于「取消时清理半成品文件」
        let cancel_flag = cancel_flag.clone();
        move || {
            // 进度事件节流到 1 秒（结束帧立即发），避免高速下载时高频 IPC 拖慢传输/UI
            let last_emit = std::cell::Cell::new(0u64);
            session
                .stream_download_to(
                    &remote_path,
                    &target_path,
                    offset,
                    |done, total| {
                        if done < total {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            if now.saturating_sub(last_emit.get()) < 1000 {
                                return;
                            }
                            last_emit.set(now);
                        }
                        let _ = app.emit(
                            "sftp-transfer",
                            SftpTransferProgress {
                                session_id: progress_session.clone(),
                                remote_path: progress_path.clone(),
                                done,
                                total,
                            },
                        );
                    },
                    cancel_flag.as_deref(),
                )
                .map_err(|e| format!("Failed to download: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Download task failed: {e}"))?;

    // 取消时清理本地半成品文件（结束任务不应残留不完整下载）
    if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
        let _ = std::fs::remove_file(&log_target);
    }

    // 清理取消标志
    if let Some(token) = cancel_token {
        if let Ok(mut cancels) = state.transfer_cancels.lock() {
            cancels.remove(&token);
        }
    }

    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "Download {}: {} ({} bytes)",
            if result.is_ok() { "completed" } else { "failed" },
            log_remote,
            std::fs::metadata(&log_target).map(|m| m.len()).unwrap_or(0)
        ),
        Some("sftp"),
    );
    result
}

/// 取消进行中的下载（置位取消标志，流式下载循环检测后中断）。
#[tauri::command]
async fn sftp_cancel_transfer(state: State<'_, AppState>, cancel_token: String) -> Result<(), String> {
    let cancels = state.transfer_cancels.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = cancels.get(&cancel_token) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn sftp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {    let mut manager = state.sftp.lock().map_err(|e| e.to_string())?;
    let result = manager
        .disconnect(&session_id)
        .map_err(|e| format!("Failed to disconnect: {}", e));
    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "{} SFTP session {}",
            if result.is_ok() { "Disconnected" } else { "Failed to disconnect" },
            session_id
        ),
        Some("sftp"),
    );
    result
}




#[tauri::command]
async fn sftp_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.sftp.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}


#[tauri::command]
fn get_config(state: State<GlobaConfig>) -> models::config::Config {
   state.config.read().unwrap().clone()
}

#[tauri::command]
fn read_image_as_data_url(path: String) -> Result<String, String> {
    utils::file::read_image_as_data_url(&path).map_err(|e| e.to_string())
}

/// 查询本地文件大小（字节），用于下载断点续传判断。文件不存在返回 0。
#[tauri::command]
fn local_file_size(path: String) -> Result<u64, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(meta.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn update_config(state: State<GlobaConfig>, config: models::config::Config) -> Result<(), String> {
    let mut guard = state.config.write().map_err(|_| "lock failed")?;
    *guard = config;

    let config_dir = path::app_config_dir();
    let config_path = config_dir.join(global_config::CONFIG_FILE);

    utils::file::write_file_generic(&config_path, &*guard, global_enum::FileFormat::Toml).map_err(|e| e.to_string())?;
    services::logs::set_max_logs(guard.advanced.max_logs);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    let config = utils::file::init_config().expect("init config failed");
    services::logs::set_max_logs(config.advanced.max_logs);
    tauri::Builder::default()
        .manage(GlobaConfig {
            config: Arc::new(RwLock::new(config))
        })
        .manage(AppState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 更新器：CrabNebula Cloud 分发 + minisign 校验
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 进程：更新下载完成后 relaunch 重启
        .plugin(tauri_plugin_process::init())
        // 单实例：再次启动时聚焦/还原已存在的主窗口，而不是新开一个
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            greet,
            close_splashscreen,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_list_sessions,
            telnet_connect,
            telnet_write,
            telnet_disconnect,
            telnet_list_sessions,
            local_shell_connect,
            local_shell_write,
            local_shell_resize,
            local_shell_disconnect,
            local_shell_list_sessions,
            accept_host_key,
            monitor_start,
            monitor_collect,
            monitor_stop,
            monitor_list_sessions,
            apply_window_effect,
            start_port_forward,
            stop_port_forward,
            list_active_port_forwards,
            sftp_connect,
            sftp_list_dir,
            sftp_download_file,
            sftp_download_file_to,
            sftp_upload_file,
            sftp_delete_file,
            sftp_delete_dir,
            sftp_remove_dir_recursive,
            sftp_create_dir,
            sftp_chmod,
            sftp_search_files,
            sftp_rename,
            sftp_upload_chunk,
            sftp_upload_local,
            sftp_download_file_progress,
            sftp_cancel_transfer,
            sftp_disconnect,
            sftp_list_sessions,
            get_config,
            update_config,
            read_image_as_data_url,
            local_file_size,
            services::hosts::list_hosts,
            services::hosts::save_host,
            services::hosts::delete_host,
            services::hosts::touch_host_last_connected,
            services::accounts::list_accounts,
            services::accounts::save_account,
            services::accounts::delete_account,
            services::keys::list_keys,
            services::keys::save_key,
            services::keys::delete_key,
            services::keys::create_key_pair,
            services::keys::import_key_file,
            services::keys::import_key_text,
            services::keys::export_key_file,
            services::keys::export_key_file_to,
            services::keys::read_key_content,
            services::certificates::list_certificates,
            services::certificates::import_certificate,
            services::certificates::delete_certificate,
            services::certificates::export_certificate,
            services::certificates::export_certificate_file_to,
            services::certificates::read_cert_content,
            services::sftp_connections::list_sftp_connections,
            services::sftp_connections::save_sftp_connection,
            services::sftp_connections::delete_sftp_connection,
            services::sftp_connections::test_sftp_connection,
            services::snippets::list_snippets,
            services::snippets::save_snippet,
            services::snippets::delete_snippet,
            services::snippets::mark_snippet_used,
            services::port_forwardings::list_port_forwardings,
            services::port_forwardings::save_port_forwarding,
            services::port_forwardings::delete_port_forwarding,
            services::port_forwardings::test_port_forward_target,
            services::logs::list_logs,
            services::logs::clear_logs,
            services::known_hosts::list_known_hosts,
            services::known_hosts::refresh_known_hosts,
            services::known_hosts::delete_known_host,
            services::known_hosts::clear_known_hosts,
            services::known_hosts::export_known_hosts,
            services::known_hosts::export_known_hosts_to,
            services::cloud_sync::cloud_sync_now,
            services::sessions::save_open_sessions,
            services::sessions::load_open_sessions,
            services::session_log::session_log_start,
            services::session_log::session_log_append,
            services::session_log::session_log_close,
            services::session_log::session_log_read,
            services::monitor_state::monitor_get_state,
            services::monitor_state::monitor_save_state,
        ])
        .setup(|_app| {
            // WebView2 默认是不透明白色背景，会盖住 transparent 窗口的毛玻璃/壁纸，
            // 启动时必须显式设为全透明（否则透明窗口表现为白底）
            #[cfg(target_os = "windows")]
            {
                use tauri::webview::Color;
                if let Some(webview) = _app.get_webview_window("main") {
                    let _ = webview.set_background_color(Some(Color(0, 0, 0, 0)));
                }
                // 正式桥：WebView2 WebMessageReceived → AdditionalObjects → CoreWebView2File.Path
                // （拖拽上传的 DOM File 无 JS 路径，此桥在原生层取真实路径 emit 回前端直读满速）
                os_drop_paths::attach(_app.handle());
            }
            let app_handle = _app.handle().clone();
            
            // 在后台线程执行初始化
            thread::spawn(move || {
                // 发送初始化状态到 splash screen
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "正在初始化配置..."
                    }));
                }
                
                // 执行初始化
                if let Err(e) = utils::init::init() {
                    eprintln!("初始化失败: {}", e);
                }
                
                // 模拟额外的初始化步骤
                thread::sleep(Duration::from_millis(500));
                
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "正在加载资源..."
                    }));
                }
                
                thread::sleep(Duration::from_millis(500));
                
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "准备就绪"
                    }));
                }
                
                thread::sleep(Duration::from_millis(300));
                
                // 关闭 splash screen，显示主窗口
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.close();
                }
                
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            });
            
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 尽力断开所有 SSH/SFTP 会话，避免退出后残留连接
                let state = app_handle.state::<AppState>();
                let ssh_guard = state.ssh.lock();
                if let Ok(manager) = ssh_guard {
                    manager.disconnect_all();
                }
                let sftp_guard = state.sftp.lock();
                if let Ok(mut manager) = sftp_guard {
                    manager.disconnect_all();
                }
                let telnet_guard = state.telnet.lock();
                if let Ok(manager) = telnet_guard {
                    manager.disconnect_all();
                }
                let local_guard = state.local.lock();
                if let Ok(manager) = local_guard {
                    manager.disconnect_all();
                }
                let tunnels_guard = state.tunnels.lock();
                if let Ok(manager) = tunnels_guard {
                    manager.stop_all();
                }
                let monitor_guard = state.monitor.lock();
                if let Ok(manager) = monitor_guard {
                    manager.disconnect_all();
                }
            }
        });
}
