//! RDP 远程桌面会话模块（IronRDP）。
//!
//! 职责边界（对齐 docs/VNC_IMPLEMENTATION.md 的桥接模式）：
//! - Rust 内跑 IronRDP 协议客户端（NLA/CredSSP 认证、位图解码全在原生侧），
//!   解码后的画面经「32px 脏矩形瓦片差分」压缩后通过本地 WebSocket 推给前端 canvas；
//! - 鼠标/键盘/分辨率事件由前端经同一 WebSocket 下发（JSON 文本），Rust 应用到
//!   `ironrdp_input::Database` 再注入协议栈；
//! - 桥只监听 127.0.0.1，每会话随机 token 鉴权；URL 不携带密码与远端目标。
//!
//! 与 VNC 桥的区别：VNC 的 Rust 是透明字节桥（协议在前端 noVNC）；RDP 的 Rust 是
//! 完整协议端，WebSocket 上跑的是本模块自定义的帧/控制消息协议。

mod bridge;
mod manager;
mod session;

pub use manager::RdpManager;

use serde::{Deserialize, Serialize};

/// 前端发起 RDP 会话的请求结构（字段 camelCase 与前端对齐）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    /// NLA/CredSSP 用户名与密码。仅内存持有，不落 URL、日志或持久化会话文件。
    pub username: String,
    pub password: String,
    /// 初始桌面分辨率（前端按容器尺寸计算）。None = IronRDP 默认。
    pub width: Option<u16>,
    pub height: Option<u16>,
    /// 连接代际：同 sessionId 只允许新代覆盖旧代（参考 VNC generation 机制）。
    #[serde(default)]
    pub generation: u64,
}

/// 连接命令返回：`ws_url` 为本地 WebSocket 地址（带 token）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectResult {
    pub session_id: String,
    pub ws_url: String,
}

/// 无客户端连入 WebSocket 时 listener 的自清窗口（秒），防止孤儿 listener。
pub const RDP_HANDSHAKE_WINDOW_SECS: u64 = 120;

/// 帧消息起始 magic：`b"RDF"` + 版本 1（后随 kind）。
pub const FRAME_MAGIC: [u8; 3] = [b'R', b'D', b'F'];
/// 帧消息 kind：脏矩形瓦片帧。
pub const FRAME_KIND_TILES: u8 = 1;
/// 瓦片边长（像素，正方形）。
pub const TILE_SIZE: u8 = 32;
