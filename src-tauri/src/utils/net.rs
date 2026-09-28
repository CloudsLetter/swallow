//! 网络 socket 小工具：跨会话类型复用的 TCP 层配置。

use std::net::TcpStream;
use std::time::Duration;

/// 为 TCP 流启用 keepalive（尽力而为，失败不阻断连接）：
/// 空闲后服务器/中间设备静默断开时（半开连接），系统在 keepalive 周期内探测到对端
/// 不可达，后续读写立即失败，避免读操作挂满整个 I/O 超时。
/// SSH/SFTP 类会话另有 SSH 层 keepalive（libssh2 set_keepalive / russh Config），
/// 本函数面向无协议层心跳的裸 TCP 会话（Telnet 等）与 TCP 兜底探测。
pub fn enable_tcp_keepalive(tcp: &TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let socket = SockRef::from(tcp);
    if socket.set_keepalive(true).is_ok() {
        let _ = socket.set_tcp_keepalive(&TcpKeepalive::new().with_time(Duration::from_secs(30)));
    }
}
