//! Tauri 命令：vnc 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::AppState;

use crate::vnc::{VncConnectRequest, VncConnectResult};
use std::time::Duration;


// ==================== VNC Commands ====================

#[tauri::command]
pub async fn vnc_connect(
    state: State<'_, AppState>,
    request: VncConnectRequest,
) -> Result<VncConnectResult, String> {
    // 输入校验
    if request.session_id.trim().is_empty() {
        return Err("VNC session id 不能为空。".to_string());
    }

    let timeout_secs = crate::vnc::VNC_CONNECT_TIMEOUT_SECS as u32;

    // ---- SSH 隧道模式：认证 + direct-tcpip 泵到本地 loopback（阻塞 ssh2 放阻塞线程池）----
    if let Some(ssh_transport) = request.ssh {
        let sid = request.session_id.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            crate::vnc::open_ssh_tunnel(&ssh_transport, timeout_secs)
        })
        .await
        .map_err(|e| format!("SSH 隧道任务异常: {e}"))?;

        match outcome {
            Ok((std_tcp, guard)) => {
                std_tcp
                    .set_nonblocking(true)
                    .map_err(|e| format!("无法切换隧道流为非阻塞: {e}"))?;
                let tcp =
                    tokio::net::TcpStream::from_std(std_tcp).map_err(|e| e.to_string())?;
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("无法创建本地监听端口: {e}"))?;
                let manager = state.vnc.lock().map_err(|e| e.to_string())?;
                return manager.start(&sid, listener, tcp, Some(guard), request.generation);
            }
            Err(e) => {
                // SSH 主机密钥待确认：复用 ssh/session 的 pending 机制与 accept_host_key
                if let Some(approval) =
                    e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>()
                {
                    return Ok(VncConnectResult {
                        session_id: request.session_id.clone(),
                        ws_url: None,
                        host: Some(approval.host.clone()),
                        port: Some(approval.port),
                        fingerprint: Some(approval.fingerprint.clone()),
                        host_key_token: Some(approval.token.clone()),
                    });
                }
                return Err(format!("SSH 隧道连接失败: {e}"));
            }
        }
    }

    // ---- 直连模式 ----
    if request.host.trim().is_empty() {
        return Err("VNC 主机地址不能为空。".to_string());
    }
    if request.port == 0 {
        return Err("VNC 端口无效。".to_string());
    }

    // 直连目标 TCP（带超时；网络等待都在 manager 锁外完成）
    let host = request.host.clone();
    let tcp = tokio::time::timeout(
        Duration::from_secs(crate::vnc::VNC_CONNECT_TIMEOUT_SECS),
        tokio::net::TcpStream::connect((host.as_str(), request.port)),
    )
    .await
    .map_err(|_| format!("连接 VNC 服务 {host}:{} 超时。", request.port))?
    .map_err(|e| format!("无法连接 VNC 服务 {host}:{}: {e}", request.port))?;

    // 只绑定 loopback（禁止 0.0.0.0/局域网）
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法创建本地监听端口: {e}"))?;

    let manager = state.vnc.lock().map_err(|e| e.to_string())?;
    manager.start(&request.session_id, listener, tcp, None, request.generation)
}

#[tauri::command]
pub async fn vnc_disconnect(
    state: State<'_, AppState>,
    session_id: String,
    // 只停止该代际的会话；None = 停止当前注册会话（手动断开/标签关闭）
    generation: Option<u64>,
) -> Result<(), String> {
    let manager = state.vnc.lock().map_err(|e| e.to_string())?;
    match generation {
        Some(gen) => manager.stop_generation(&session_id, gen),
        None => manager.stop(&session_id),
    }
}

#[tauri::command]
pub async fn vnc_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.vnc.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}

