//! Tauri 命令：rdp 域（自 lib.rs 拆分，行为不变）。

use tauri::State;

use crate::AppState;

use crate::rdp::{RdpConnectRequest, RdpConnectResult};


// ==================== RDP Commands ====================

#[tauri::command]
pub async fn rdp_connect(
    state: State<'_, AppState>,
    request: RdpConnectRequest,
) -> Result<RdpConnectResult, String> {
    // 输入校验
    if request.session_id.trim().is_empty() {
        return Err("RDP session id 不能为空。".to_string());
    }
    if request.host.trim().is_empty() {
        return Err("RDP 主机地址不能为空。".to_string());
    }
    if request.port == 0 {
        return Err("RDP 端口无效。".to_string());
    }
    if request.username.trim().is_empty() {
        return Err("RDP 用户名不能为空。".to_string());
    }

    // 构建协议配置（纯内存；IronRDP 内部完成 NLA/CredSSP 认证与 TLS）
    let destination =
        ironrdp_client::config::Destination::new(format!("{}:{}", request.host.trim(), request.port))
            .map_err(|e| format!("RDP 目标地址无效: {e}"))?;
    let mut builder = ironrdp_client::config::ConfigBuilder::new()
        .with_destination(destination)
        .with_username(request.username.trim())
        .with_password(request.password)
        .with_client_build(14) // 0.1.4
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_client_name("swallow")
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS);
    if let (Some(w), Some(h)) = (request.width, request.height) {
        if w > 0 && h > 0 {
            builder = builder.with_desktop_width(w).with_desktop_height(h);
        }
    }
    let config = builder.build().map_err(|e| format!("RDP 配置无效: {e}"))?;

    // 只绑定 loopback（禁止 0.0.0.0/局域网）；RDP 连接本身由会话任务异步完成
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法创建本地监听端口: {e}"))?;

    let manager = state.rdp.lock().map_err(|e| e.to_string())?;
    manager.start(&request.session_id, listener, config, request.generation)
}

#[tauri::command]
pub async fn rdp_disconnect(
    state: State<'_, AppState>,
    session_id: String,
    // 只停止该代际的会话；None = 停止当前注册会话（手动断开/标签关闭）
    generation: Option<u64>,
) -> Result<(), String> {
    let manager = state.rdp.lock().map_err(|e| e.to_string())?;
    match generation {
        Some(gen) => manager.stop_generation(&session_id, gen),
        None => manager.stop(&session_id),
    }
}

#[tauri::command]
pub async fn rdp_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.rdp.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}

