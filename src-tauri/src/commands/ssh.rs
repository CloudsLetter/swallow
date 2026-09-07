//! Tauri 命令：ssh 域（自 lib.rs 拆分，行为不变）。

use tauri::{Emitter, State};

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::AppState;

use crate::ssh::{SshConfig, SshSession};
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;
use crate::services::keys::load_key_content;
use crate::services::certificates::load_cert_content;
use crate::utils::sqlite;


/// 密钥/证书认证材料装载：按 key_id/cert_id 从 DB 读内容入内存（不落盘）。
/// SSH 终端与 MOSH 引导共用同一认证链路，保证行为一致。
pub(crate) fn prepare_ssh_auth_material(mut config: SshConfig) -> Result<SshConfig, String> {
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
    Ok(config)
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
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

    // 密钥/证书认证：根据 key_id/cert_id 从数据库读取内容用于内存认证（不落盘）
    let config = prepare_ssh_auth_material(config)?;

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
            if let Some(approval) = e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>() {
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
pub async fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
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
pub async fn ssh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
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
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
pub async fn ssh_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.ssh.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

#[tauri::command]
pub fn accept_host_key(
    config_state: State<'_, GlobaConfig>,
    token: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    let timeout_secs = read_connection_timeout(&config_state);
    crate::ssh::host_keys::accept_host_key(&token, &expected_fingerprint, timeout_secs)
        .map_err(|e| format!("Failed to accept host key: {}", e))
}

