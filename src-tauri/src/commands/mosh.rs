//! Tauri 命令：mosh 域（自 lib.rs 拆分，行为不变）。

use tauri::{Emitter, State};

use crate::commands::read_connection_timeout;
use crate::commands::ssh::prepare_ssh_auth_material;
use crate::commands::ConnectResult;
use crate::AppState;

use crate::ssh::SshConfig;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use crate::config::global_config::GlobaConfig;


// ==================== MOSH Commands ====================

#[tauri::command]
pub async fn mosh_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
    cols: u32,
    rows: u32,
) -> Result<ConnectResult, String> {
    let timeout_secs = read_connection_timeout(&config_state);

    // 会话已存在则复用（标签切换/重挂载防重复建连）
    {
        let manager = state.mosh.lock().map_err(|e| e.to_string())?;
        if manager.contains(&session_id) {
            return Ok(ConnectResult::connected(config.host, config.port));
        }
    }

    // 引导认证与 SSH 终端同链路（key/cert 内容从 DB 读入内存）
    let config = prepare_ssh_auth_material(config)?;

    // SSH 引导：远程启动 mosh-server，拿 UDP 端口 + 会话密钥（阻塞线程池）
    let progress_app = app_handle.clone();
    let progress_session_id = session_id.clone();
    let boot_config = config.clone();
    let boot = tauri::async_runtime::spawn_blocking(move || {
        let on_progress = |stage: &str, message: Option<&str>| {
            let _ = progress_app.emit(
                &format!("session-{}", progress_session_id),
                crate::session_events::SessionEvent::Progress {
                    stage: stage.to_string(),
                    message: message.map(|s| s.to_string()),
                },
            );
        };
        crate::mosh::session::bootstrap(&boot_config, timeout_secs, &on_progress)
    })
    .await
    .map_err(|e| format!("MOSH 引导任务异常: {e}"))?;

    let boot = match boot {
        Ok(boot) => boot,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>() {
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            return Err(format!("MOSH 连接失败: {e}"));
        }
    };

    // 数据面泵线程：UDP + SSP，增量 ANSI emit 到 session-{id}
    let (input_tx, input_rx) = std::sync::mpsc::channel::<crate::mosh::session::PumpCommand>();
    let stop = Arc::new(AtomicBool::new(false));
    let removal = {
        let manager = state.mosh.lock().map_err(|e| e.to_string())?;
        manager.removal_closure(session_id.clone())
    };
    let disconnect_handler = Arc::new(Mutex::new(Some(removal)));
    crate::mosh::session::start_pump(
        app_handle,
        session_id.clone(),
        config.host.clone(),
        boot.port,
        boot.key,
        cols.clamp(1, 2000) as u16,
        rows.clamp(1, 1000) as u16,
        input_rx,
        stop.clone(),
        disconnect_handler,
    );

    {
        let manager = state.mosh.lock().map_err(|e| e.to_string())?;
        manager.insert_session(
            session_id,
            crate::mosh::MoshSessionHandle { input_tx, stop },
        );
    }

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
pub fn mosh_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let handle = {
        let manager = state.mosh.lock().map_err(|e| e.to_string())?;
        manager.get_handle(&session_id)
    };
    if let Some((input_tx, _)) = handle {
        let _ = input_tx.send(crate::mosh::session::PumpCommand::Input(data.into_bytes()));
    }
    Ok(())
}

#[tauri::command]
pub fn mosh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let handle = {
        let manager = state.mosh.lock().map_err(|e| e.to_string())?;
        manager.get_handle(&session_id)
    };
    if let Some((input_tx, _)) = handle {
        let _ = input_tx.send(crate::mosh::session::PumpCommand::Resize(
            cols.clamp(1, 2000) as u16,
            rows.clamp(1, 1000) as u16,
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn mosh_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let manager = state.mosh.lock().map_err(|e| e.to_string())?;
    manager.disconnect(&session_id);
    Ok(())
}

#[tauri::command]
pub fn mosh_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.mosh.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}

