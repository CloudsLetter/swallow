//! Tauri 命令：ssh 域（自 lib.rs 拆分，行为不变）。

use tauri::{Emitter, State};

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::ssh::errors::{is_ssh2_fallback_eligible, IpcError, SshError};
use crate::AppState;

use crate::ssh::{SshConfig, SshSession};
use crate::ssh::auth::prepare_ssh_auth_material;
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
    cols: u32,
    rows: u32,
    on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<ConnectResult, IpcError> {
    let timeout_secs = read_connection_timeout(&config_state);
    // russh 原生 keepalive 间隔（秒）与 ssh2 路径共用同一配置项：
    // 0 = 用户关闭心跳 → russh Config 保持 None（不发 keepalive），行为与 ssh2 一致。
    let keep_alive_interval = config_state
        .config
        .read()
        .map(|guard| guard.ssh.keep_alive_interval)
        .unwrap_or(60);
    let compression = config_state
        .config
        .read()
        .map(|guard| guard.ssh.compression)
        .unwrap_or(false);

    // SSH 后端优先级：ssh.ssh_backend ∈ {"auto"|"russh"|"ssh2"}（空串按 auto）
    let ssh_backend = config_state
        .config
        .read()
        .map(|guard| guard.ssh.backend.clone())
        .unwrap_or_default();

    // 主机级覆盖：host.backend 非空（"russh"/"ssh2"）时优先于全局
    let host_backend = config.backend.trim().to_string();
    let ssh_backend_effective = if host_backend.is_empty() { ssh_backend } else { host_backend };

    // 快速路径：会话已存在则复用（避免在切换标签或重挂载时重复建立连接）——短暂持锁
    {
        if state.ssh.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host.clone(), config.port));
        }
    }

    // russh 后端会话复用同理
    if state.russh_shells.contains_key(&session_id) {
        return Ok(ConnectResult::connected(config.host.clone(), config.port));
    }

    // 密钥/证书认证：根据 key_id/cert_id 从数据库读取内容用于内存认证（不落盘）
    let config = prepare_ssh_auth_material(config).map_err(SshError::classify_str)?;

    // russh 主后端：连接+PTY+shell 同步完成（纯 async，不占阻塞线程）。
    // - HostKeyApprovalRequired → 转前端待确认流程（同隧道）；
    // - DSA/传统 PEM 等算法/解析类失败（russh 不支持）→ 落入下方 ssh2 回退路径；
    // - 其余失败直接报错（不误回退，安全类 Mismatch/KeyChanged 亦然）。
    // 模式：auto（默认）走下方逻辑；ssh2 直接跳过 russh；russh 禁回退。
    if ssh_backend_effective != "ssh2" {
        let spawn_result = crate::ssh::russh_shell::spawn(
            app_handle.clone(),
            &config,
            session_id.clone(),
            timeout_secs,
            cols,
            rows,
            keep_alive_interval,
            compression,
            on_output.clone(),
        )
        .await;
        match spawn_result {
            Ok(shell) => {
                // entry 原子性：并发同 id 连接时后来者直接丢弃（Drop 兜底断开），先到先得
                match state.russh_shells.entry(session_id.clone()) {
                    dashmap::Entry::Occupied(_) => {
                        return Ok(ConnectResult::connected(config.host.clone(), config.port));
                    }
                    dashmap::Entry::Vacant(vacant) => {
                        vacant.insert(std::sync::Arc::new(shell));
                    }
                }
                let _ = write_log(
                    "info",
                    &format!(
                        "SSH connected (russh) to {}@{}:{}",
                        config.username, config.host, config.port
                    ),
                    Some("ssh"),
                );
                return Ok(ConnectResult::connected(config.host.clone(), config.port));
            }
            Err(e) => {
                if let Some(approval) =
                    e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>()
                {
                    return Ok(ConnectResult::needs_host_key_approval(
                        approval.host.clone(),
                        approval.port,
                        approval.fingerprint.clone(),
                        approval.token.clone(),
                    ));
                }
                if is_ssh2_fallback_eligible(&e) && ssh_backend_effective != "russh" {
                    let _ = write_log(
                        "info",
                        &format!(
                            "Falling back to ssh2 shell backend for {}@{}:{} (russh: {})",
                            config.username, config.host, config.port, e
                        ),
                        Some("ssh"),
                    );
                } else {
                    let _ = write_log(
                        "error",
                        &format!(
                            "SSH connection failed (russh) to {}@{}:{}: {}",
                            config.username, config.host, config.port, e
                        ),
                        Some("ssh"),
                    );
                    return Err(SshError::classify(&e));
                }
            }
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
        SshSession::connect(
            connect_config,
            connect_session_id,
            timeout_secs,
            keep_alive_interval,
            compression,
            &on_progress,
            on_output,
        )
    })
    .await
    .map_err(|e| SshError::classify_str(&format!("Connection task failed: {e}")))?;

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
            return Err(SshError::classify(&e));
        }
    };

    // 插入会话（短暂持锁，避免重复插入）
    {
        if state.ssh.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host.clone(), config.port));
        }
        state.ssh.insert_session(session_id.clone(), session);
    }

    // 获取会话并启动 shell（不持全局锁）
    if let Some(session) = state.ssh.get_session(&session_id) {
        if let Err(e) = session.start_shell(app_handle, cols, rows, keep_alive_interval) {
            // shell 启动失败时移除会话，避免残留无 shell 的僵尸会话
            let _ = state.ssh.disconnect(&session_id);
            let _ = write_log(
                "error",
                &format!(
                    "SSH shell start failed for {}@{}:{}: {}",
                    config.username, config.host, config.port, e
                ),
                Some("ssh"),
            );
            return Err(SshError::classify(&e));
        }
    }

    let _ = write_log(
        "info",
        &format!("SSH connected to {}@{}:{}", config.username, config.host, config.port),
        Some("ssh"),
    );

    Ok(ConnectResult::connected(config.host.clone(), config.port))
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    // russh 会话：克隆句柄出分片锁后再 await（DashMap Ref 不能跨 await 持有）
    let russh = state.russh_shells.get(&session_id).map(|s| s.value().clone());
    if let Some(shell) = russh {
        return shell
            .write(data.into_bytes())
            .await
            .map_err(|e| format!("Failed to write data: {}", e));
    }
    let session = {
        state.ssh
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
    // russh 会话：克隆句柄出分片锁后再 await
    let russh = state.russh_shells.get(&session_id).map(|s| s.value().clone());
    if let Some(shell) = russh {
        return shell
            .resize(cols, rows)
            .await
            .map_err(|e| format!("Failed to resize PTY: {}", e));
    }
    let session = {
        state.ssh
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
    // russh 会话：移除表项 + 请求 select task 停止断开
    {
        if let Some((_, shell)) = state.russh_shells.remove(&session_id) {
            shell.stop();
            let _ = write_log(
                "info",
                &format!("Disconnected russh SSH session {}", session_id),
                Some("ssh"),
            );
            return Ok(());
        }
    }
    // 移除会话在锁内（快），断开握手（网络 I/O）在 manager 内部锁外执行
    let result = {
        state.ssh
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
    let mut ids = state.ssh.list_sessions();
    for k in state.russh_shells.iter() {
        let k = k.key();
        if !ids.contains(k) {
            ids.push(k.clone());
        }
    }
    Ok(ids)
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

/// 终端输出流控开关：前端 write 缓冲积压超水位时暂停后端读取、低于水位恢复。
/// 仅 SSH 路径（russh/ssh2）有真实背压语义；其他会话类型查不到即为无害 no-op。
#[tauri::command]
pub fn ssh_set_output_paused(
    state: State<'_, AppState>,
    session_id: String,
    paused: bool,
) -> Result<(), String> {
    let russh_shell = state.russh_shells.get(&session_id).map(|s| s.value().clone());
    if let Some(shell) = russh_shell {
        shell.set_output_paused(paused);
        return Ok(());
    }
    if let Some(session) = state.ssh.get_session(&session_id) {
        session.set_output_paused(paused);
    }
    Ok(())
}

