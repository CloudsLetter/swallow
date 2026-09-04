//! VNC 会话模块。
//!
//! 职责边界（按 docs/VNC_IMPLEMENTATION.md）：
//! - Rust 只做「本地 WebSocket <-> VNC TCP」透明桥，不解析 RFB、不处理 framebuffer；
//!   RFB 握手/认证/画面/输入全部由前端 noVNC 完成。
//! - 桥只监听 127.0.0.1，每个会话使用随机 token 鉴权，URL 不携带密码与远端 TCP 目标。

mod bridge;
mod manager;
mod ssh;

pub use manager::VncManager;
pub use ssh::{open_ssh_tunnel, SshTunnelGuard};

use serde::{Deserialize, Serialize};

/// SSH 隧道传输配置（阶段 D）：与 SSH 终端配置分离建模，不伪装成 SshConfig。
/// 直连模式下为 None。字段按 camelCase 与前端对齐。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTransportConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_username: String,
    pub ssh_auth_type: String,
    pub ssh_password: Option<String>,
    pub ssh_key_id: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_passphrase: Option<String>,
    /// 目标 VNC 服务主机（经 SSH 隧道访问）
    pub target_host: String,
    pub target_port: u16,
}

/// 前端发起 VNC 会话的请求结构。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    /// 透明桥不需要 VNC 密码；保留字段仅为前端透传 noVNC credentials 与后续兼容。
    /// 不允许写入 URL、日志或持久化会话文件。
    pub password: Option<String>,
    pub shared: Option<bool>,
    /// SSH 隧道传输（None = 直连 VNC）
    pub ssh: Option<SshTransportConfig>,
}

/// 连接命令返回。
///
/// - 直连/隧道成功：`ws_url` 为 Some（本地 WebSocket 地址），其余字段 None；
/// - SSH 主机密钥待确认：`ws_url` 为 None，`host_key_token`/`fingerprint`/`host`/`port`
///   携带确认信息——前端确认后调 `accept_host_key(token, fingerprint)` 再重试本命令。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnectResult {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key_token: Option<String>,
}

/// 直连 VNC 建立 TCP 的超时（秒），文档建议 10~30s。
pub const VNC_CONNECT_TIMEOUT_SECS: u64 = 15;
/// 无客户端连入 WebSocket 时 listener 的自清窗口（秒），防止孤儿 listener。
pub const VNC_HANDSHAKE_WINDOW_SECS: u64 = 120;
