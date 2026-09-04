//! 串口（Serial/COM）终端会话模块。
//!
//! 对标 telnet：无认证、纯字节流；阻塞线程读 → session-{id} Output 事件；
//! 写路径阻塞 + 退避重试。串口无 EOF/连接语义，断开 = 关闭句柄。

pub mod manager;
pub mod session;

pub use manager::SerialManager;
pub use session::{SerialConfig, SerialSession};

/// 读线程唤醒间隔：串口用 read_timeout 轮询，保证 disconnect 及时生效。
pub const PORT_READ_TIMEOUT_MS: u64 = 100;
