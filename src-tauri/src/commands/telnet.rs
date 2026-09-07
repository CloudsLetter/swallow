//! Tauri 命令：telnet 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::AppState;

use crate::telnet::{TelnetConfig, TelnetSession};
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;
use crate::session_events::emit_session_event;


// ==================== Telnet Commands ====================

#[tauri::command]
pub async fn telnet_connect(
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
pub async fn telnet_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
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
pub async fn telnet_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
pub async fn telnet_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.telnet.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

