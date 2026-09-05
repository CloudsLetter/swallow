//! MOSH 会话模块（mosh-rs + SSH 引导）。
//!
//! 职责边界：
//! - 引导（bootstrap）：复用 SSH 认证链路（`ssh::session::establish_authenticated_session`，
//!   含主机密钥确认/跳板机/密钥证书）远程执行 `mosh-server new`，解析
//!   `MOSH CONNECT <port> <key>`（官方 ≥1.3 协议）后即关闭 SSH；
//! - 数据面：`mosh_rs::session::MoshSession` 直连 UDP（SSP + AES-OCB3），泵线程把
//!   `render()` 的增量 ANSI 差分 emit 到 `session-{id}`，输入/尺寸经命令通道注入；
//! - 会话密钥仅内存持有，不落 URL、日志或持久化文件。
//!
//! 与本地 shell 同属「文本流」协议：前端复用 TerminalView + terminalPool 全套。

pub mod manager;
pub mod session;

pub use manager::{MoshManager, MoshSessionHandle};

/// 引导读输出的兜底超时（秒）：mosh-server new 打印 MOSH CONNECT 后即退出。
pub const MOSH_BOOTSTRAP_READ_TIMEOUT_SECS: u64 = 15;
