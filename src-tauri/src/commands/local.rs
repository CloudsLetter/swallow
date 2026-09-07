//! Tauri 命令：local 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::commands::ConnectResult;
use crate::AppState;

use crate::local::{LocalShellConfig, LocalShellSession};
use crate::services::logs::write_log;
use crate::session_events::emit_session_event;


// ==================== Local Shell (PTY) Commands ====================

#[tauri::command]
pub async fn local_shell_connect(
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
pub async fn local_shell_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
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
pub async fn local_shell_resize(
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
pub async fn local_shell_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
pub async fn local_shell_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.local.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

