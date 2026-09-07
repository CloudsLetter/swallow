//! Tauri 命令：monitor 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::AppState;

use crate::monitor::{MonitorSession, MonitorSnapshot};
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;
use crate::utils::sqlite;


// ==================== Server Monitor Commands ====================

#[tauri::command]
pub async fn monitor_start(
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
    let config = crate::services::port_forwardings::resolve_host_ssh_config(&conn, &host_id)?;

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
            if let Some(approval) = e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>() {
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
pub async fn monitor_collect(
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
pub async fn monitor_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
pub async fn monitor_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.monitor.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}

