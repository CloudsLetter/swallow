//! Tauri 命令：serial 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::commands::ConnectResult;
use crate::AppState;

use crate::serial::{SerialConfig, SerialSession};
use crate::services::logs::write_log;
use crate::session_events::emit_session_event;


// ==================== Serial Commands ====================

#[tauri::command]
pub async fn serial_list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .map_err(|e| format!("无法枚举串口: {e}"))
}

#[tauri::command]
pub async fn serial_connect(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SerialConfig,
) -> Result<ConnectResult, String> {
    if session_id.trim().is_empty() {
        return Err("串口 session id 不能为空。".to_string());
    }
    let port = config.port.clone();

    // 复用已建立会话（切换标签/重挂载重复 connect 时避免重复打开设备）
    {
        let manager = state.serial.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(port.clone(), 0));
        }
    }

    // 打开串口是阻塞系统调用（设备占用/驱动），放阻塞线程池
    let open_cfg = config.clone();
    let sid_for_open = session_id.clone();
    let session = tauri::async_runtime::spawn_blocking(move || {
        let mut s = SerialSession::open(&open_cfg)?;
        s.set_session_id(sid_for_open);
        Ok::<SerialSession, String>(s)
    })
    .await
    .map_err(|e| format!("串口打开任务异常: {e}"))??;

    // 竞态兜底：打开期间若已有同 id 会话（并发 connect），丢弃本次新开句柄
    // （session 在此处 drop → 端口立即释放），避免两个会话抢占同一设备
    {
        let manager = state.serial.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(port.clone(), 0));
        }
        manager.insert_session(session_id.clone(), session);
    }

    // 启动读循环并推进连接进度（串口无 ssh/auth/shell 阶段，快速推进到 ready）
    if let Some(session) = {
        let manager = state.serial.lock().map_err(|e| e.to_string())?;
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
        progress("tcp", Some(&port));
        progress("ssh", None);
        progress("auth", None);
        progress("shell", None);
        session.start_read_loop(app_handle.clone());
        progress("ready", None);
    }

    let _ = write_log(
        "info",
        &format!("Serial connected to {port} ({} baud)", config.baud_rate),
        Some("serial"),
    );

    Ok(ConnectResult::connected(port, 0))
}

#[tauri::command]
pub async fn serial_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = {
        let manager = state.serial.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("串口会话 {} 不存在", session_id))?
    };
    tauri::async_runtime::spawn_blocking(move || session.write_data(&data))
        .await
        .map_err(|e| format!("串口写入任务异常: {e}"))?
}

#[tauri::command]
pub async fn serial_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let manager = state.serial.lock().map_err(|e| e.to_string())?;
    manager.disconnect(&session_id)
}

#[tauri::command]
pub async fn serial_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.serial.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

