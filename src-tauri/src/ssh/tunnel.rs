use anyhow::{Context, Result};
use ssh2::{Channel, Listener, Session};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener as StdTcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::models::data::PortForwarding;
use crate::ssh::session::JumpTransport;

/// 运行中的端口转发隧道句柄。
///
/// 持有已认证的 SSH 会话与停止信号。隧道一旦建立，监听循环在后台线程运行，
/// 每个入站连接各自派生线程做双向数据转发；`stop` 会置停止位并断开 SSH 会话，
/// 使阻塞中的 accept/read 立即返回从而退出所有后台线程。
pub struct SshTunnel {
    #[allow(dead_code)]
    rule_id: String,
    session: Session,
    /// 跳板机传输层（无跳板机时为 None）：随隧道存活，drop 时释放跳板机连接。
    #[allow(dead_code)]
    jump: Option<JumpTransport>,
    running: Arc<AtomicBool>,
}

impl SshTunnel {
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        // 断开会话会中断阻塞中的 libssh2 accept/read，让后台线程退出
        let _ = self.session.disconnect(None, "Tunnel stopped", None);
    }

    /// 隧道是否仍在运行（未被 stop、未意外断开）。
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 检测底层 SSH 会话是否仍存活（发送 keepalive 探测包）。
    pub fn is_alive(&self) -> bool {
        self.session.keepalive_send().is_ok()
    }
}

/// 端口转发隧道注册表：rule_id -> 运行中的隧道。
#[derive(Clone)]
pub struct TunnelManager {
    tunnels: Arc<Mutex<HashMap<String, Arc<SshTunnel>>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册（或替换）某规则的隧道；若已存在同名隧道则先停止旧的。
    pub fn insert(&self, rule_id: String, tunnel: Arc<SshTunnel>) {
        let mut tunnels = self.tunnels.lock().unwrap();
        if let Some(old) = tunnels.insert(rule_id, tunnel) {
            old.stop();
        }
    }

    /// 停止指定规则的隧道。返回是否确实停止了一个。
    pub fn stop(&self, rule_id: &str) -> bool {
        if let Some(tunnel) = self.tunnels.lock().unwrap().remove(rule_id) {
            tunnel.stop();
            true
        } else {
            false
        }
    }

    /// 尽力停止所有隧道（应用退出时调用）。
    pub fn stop_all(&self) {
        let tunnels = self.tunnels.lock().unwrap();
        for (_, tunnel) in tunnels.iter() {
            tunnel.stop();
        }
    }

    #[allow(dead_code)]
    pub fn is_running(&self, rule_id: &str) -> bool {
        self.tunnels.lock().unwrap().contains_key(rule_id)
    }

    pub fn list(&self) -> Vec<String> {
        self.tunnels.lock().unwrap().keys().cloned().collect()
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 根据规则建立隧道并启动后台监听循环。
/// `jump` 为可选的跳板机传输层（目标主机经跳板机连接时传入），隧道持有它以保持跳板连接存活。
pub fn start_tunnel(
    rule: &PortForwarding,
    session: Session,
    jump: Option<JumpTransport>,
) -> Result<SshTunnel> {
    let running = Arc::new(AtomicBool::new(true));
    let rule_id = rule.id.clone();
    let rule_type = rule.rule_type.clone();
    // 监听地址统一兜底：空值（旧数据可能遗留）回退为 loopback，避免 local/dynamic
    // 绑定 0.0.0.0 暴露到所有接口，也避免 remote 以空串发起 tcpip-forward 被拒。
    let listen_host = {
        let h = rule.listen_host.trim();
        if h.is_empty() {
            "127.0.0.1".to_string()
        } else {
            h.to_string()
        }
    };
    let listen_port = u16::try_from(rule.listen_port).context("监听端口超出 1-65535 范围")?;
    let target_host = rule.target_host.clone().map(|s| s.trim().to_string());
    let target_port = u16::try_from(rule.target_port).context("目标端口超出 0-65535 范围")?;

    match rule_type.as_str() {
        "local" => {
            if !is_loopback_host(&listen_host) {
                anyhow::bail!(
                    "出于安全考虑，本地转发仅允许绑定回环地址（127.0.0.1 / ::1 / localhost），当前监听地址 {listen_host} 会暴露到外部网络"
                );
            }
            let target = target_host
                .filter(|s| !s.is_empty())
                .context("本地转发需要指定目标主机")?;
            let listener = bind_local(&listen_host, listen_port)?;
            spawn_local_loop(listener, session.clone(), target, target_port, running.clone());
        }
        "remote" => {
            let target = target_host
                .filter(|s| !s.is_empty())
                .context("远程转发需要指定目标主机")?;
            let (listener, _bound_port) = session
                .channel_forward_listen(listen_port, Some(&listen_host), None)
                .with_context(|| {
                    format!(
                        "远程转发监听失败：SSH 服务器拒绝在 {}:{} 上监听（可能原因：服务器禁用了 TCP 转发、远程端口被占用，或监听地址非回环地址需开启 GatewayPorts）",
                        listen_host, listen_port
                    )
                })?;
            spawn_remote_loop(listener, target, target_port, running.clone());
        }
        "dynamic" => {
            // SOCKS5 认证：配置了用户名+密码才允许非回环绑定（否则强制回环，防开放代理）
            let socks_auth = match (&rule.socks_username, &rule.socks_password) {
                (Some(u), Some(p)) if !u.trim().is_empty() && !p.is_empty() => {
                    Some((u.clone(), p.clone()))
                }
                _ => None,
            };
            if socks_auth.is_none() && !is_loopback_host(&listen_host) {
                anyhow::bail!(
                    "出于安全考虑，未配置认证的动态转发（SOCKS5）仅允许绑定回环地址（127.0.0.1 / ::1 / localhost），当前监听地址 {listen_host} 会形成开放代理；如需绑定非回环地址，请先配置代理用户名与密码"
                );
            }
            let listener = bind_local(&listen_host, listen_port)?;
            spawn_dynamic_loop(listener, session.clone(), running.clone(), socks_auth);
        }
        _ => anyhow::bail!("不支持的转发类型：{}", rule_type),
    }

    Ok(SshTunnel {
        rule_id,
        session,
        jump,
        running,
    })
}

/// 判断监听地址是否为回环地址（防止 local/dynamic 转发被绑定到所有网卡暴露服务）。
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == "localhost" || h == "::1" || h.starts_with("127.")
}

fn bind_local(listen_host: &str, listen_port: u16) -> Result<StdTcpListener> {
    let addr = (listen_host, listen_port);
    let listener = StdTcpListener::bind(addr)
        .with_context(|| format!("本地端口 {listen_host}:{listen_port} 无法监听（可能已被占用）"))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// 本地转发（ssh -L）：本地监听 -> 通过 SSH 转发到远程目标。
fn spawn_local_loop(
    listener: StdTcpListener,
    session: Session,
    target_host: String,
    target_port: u16,
    running: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((tcp, _)) => {
                    let session = session.clone();
                    let host = target_host.clone();
                    thread::spawn(move || forward_direct_tcpip(session, tcp, &host, target_port));
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });
}

/// 动态转发（SOCKS5）：本地监听 -> 解析 SOCKS5 请求 -> 通过 SSH 转发到动态目标。
/// socks_auth 为 None 时仅接受无认证连接；Some 时强制 RFC 1929 用户名/密码认证。
fn spawn_dynamic_loop(
    listener: StdTcpListener,
    session: Session,
    running: Arc<AtomicBool>,
    socks_auth: Option<(String, String)>,
) {
    thread::spawn(move || {
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((tcp, _)) => {
                    let session = session.clone();
                    let socks_auth = socks_auth.clone();
                    thread::spawn(move || handle_socks5(session, tcp, socks_auth));
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });
}

/// 远程转发（ssh -R）：远程监听 -> 接受转发回来的连接 -> 回连本地目标。
fn spawn_remote_loop(
    mut listener: Listener,
    target_host: String,
    target_port: u16,
    running: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok(channel) => {
                    let host = target_host.clone();
                    thread::spawn(move || forward_remote_to_local(channel, &host, target_port));
                }
                Err(e) => {
                    if running.load(Ordering::SeqCst) {
                        eprintln!("remote forward accept error: {e}");
                    }
                    break;
                }
            }
        }
    });
}

/// 通过 SSH direct-tcpip 通道把本地 TCP 连接转发到远程目标。
fn forward_direct_tcpip(session: Session, tcp: TcpStream, target_host: &str, target_port: u16) {
    match session.channel_direct_tcpip(target_host, target_port, None) {
        Ok(channel) => bridge(channel, tcp),
        Err(e) => eprintln!("direct-tcpip to {target_host}:{target_port} failed: {e}"),
    }
}

/// 把远程转发回来的通道回连到本地目标。
fn forward_remote_to_local(channel: Channel, target_host: &str, target_port: u16) {
    let addr = format!("{target_host}:{target_port}");
    let sock = match addr
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    {
        Some(s) => s,
        None => {
            eprintln!("无法解析本地目标 {addr}");
            return;
        }
    };
    match TcpStream::connect_timeout(&sock, Duration::from_secs(10)) {
        Ok(tcp) => bridge(channel, tcp),
        Err(e) => eprintln!("连接本地目标 {addr} 失败: {e}"),
    }
}

/// 在 SSH channel 与本地 TCP 流之间做双向数据泵。
///
/// 用 `channel.stream(0)` 克隆出读写两端（Stream 为 Arc 句柄，可并发），
/// 一个线程负责 SSH -> TCP，当前线程负责 TCP -> SSH；TCP 关闭后向 channel
/// 发送 EOF 并等待远端关闭。
fn bridge(mut channel: Channel, tcp: TcpStream) {
    // 数据阶段设空闲超时：防止半开连接/挂起客户端让 io::copy 无限阻塞占线程
    // （正常传输持续有数据，300s 空闲超时不会影响长连接）
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(300)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(300)));
    let tcp_read = match tcp.try_clone() {
        Ok(t) => t,
        Err(_) => return,
    };
    let tcp_write = tcp;

    let ssh_read = channel.stream(0);
    let ssh_write = channel.stream(0);

    // SSH -> TCP
    let handle = {
        let mut r = ssh_read;
        let mut w = tcp_write;
        thread::spawn(move || {
            let _ = io::copy(&mut r, &mut w);
            let _ = w.flush();
        })
    };

    // TCP -> SSH
    let mut r = tcp_read;
    let mut w = ssh_write;
    let _ = io::copy(&mut r, &mut w);
    // 注意：不要对 ssh_write 调 flush()。ssh2 的 Stream::flush 映射到
    // libssh2_channel_flush_ex，语义是「丢弃接收缓冲未读数据」，会把
    // SSH->TCP 方向（handle 线程正在读取）的转发数据丢掉。write 本身已即时下发。

    // 本地侧已关闭：通知远端 channel 结束并等待关闭
    let _ = channel.send_eof();
    let _ = channel.wait_close();
    let _ = handle.join();
}

/// 处理一个 SOCKS5 连接（支持无认证或 RFC 1929 用户名/密码认证 + CONNECT 命令）。
fn handle_socks5(session: Session, mut tcp: TcpStream, socks_auth: Option<(String, String)>) {
    // 握手阶段设短超时，防止客户端连接后不发数据导致线程无限挂起
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
    // 1. 方法协商
    let mut buf = [0u8; 2];
    if tcp.read_exact(&mut buf).is_err() {
        return;
    }
    if buf[0] != 0x05 {
        return;
    }
    let nmethods = buf[1] as usize;
    if nmethods == 0 {
        return;
    }
    let mut methods = vec![0u8; nmethods];
    if tcp.read_exact(&mut methods).is_err() {
        return;
    }

    match &socks_auth {
        None => {
            // 无认证：仅接受 no-auth（0x00）
            if !methods.contains(&0x00) {
                let _ = tcp.write_all(&[0x05, 0xFF]);
                return;
            }
            if tcp.write_all(&[0x05, 0x00]).is_err() {
                return;
            }
        }
        Some((expected_user, expected_pass)) => {
            // 要求 username/password 认证（0x02）
            if !methods.contains(&0x02) {
                let _ = tcp.write_all(&[0x05, 0xFF]);
                return;
            }
            if tcp.write_all(&[0x05, 0x02]).is_err() {
                return;
            }
            let _ = tcp.flush();

            // RFC 1929 认证请求：ver=0x01 ulen username plen password
            let mut head = [0u8; 2];
            if tcp.read_exact(&mut head).is_err() {
                return;
            }
            if head[0] != 0x01 {
                return;
            }
            let ulen = head[1] as usize;
            let mut username = vec![0u8; ulen];
            if tcp.read_exact(&mut username).is_err() {
                return;
            }
            let mut plen = [0u8; 1];
            if tcp.read_exact(&mut plen).is_err() {
                return;
            }
            let mut password = vec![0u8; plen[0] as usize];
            if tcp.read_exact(&mut password).is_err() {
                return;
            }
            if username == expected_user.as_bytes() && password == expected_pass.as_bytes() {
                if tcp.write_all(&[0x01, 0x00]).is_err() {
                    return;
                }
            } else {
                let _ = tcp.write_all(&[0x01, 0x01]);
                return;
            }
        }
    }
    let _ = tcp.flush();

    // 2. 请求
    let mut head = [0u8; 4];
    if tcp.read_exact(&mut head).is_err() {
        return;
    }
    if head[0] != 0x05 || head[2] != 0x00 {
        return;
    }
    let cmd = head[1];
    let atyp = head[3];
    if cmd != 0x01 {
        // 仅支持 CONNECT
        let _ = tcp.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        return;
    }
    let target_host = match read_socks_addr(&mut tcp, atyp) {
        Some(h) => h,
        None => {
            let _ = tcp.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return;
        }
    };
    let mut portbuf = [0u8; 2];
    if tcp.read_exact(&mut portbuf).is_err() {
        return;
    }
    let target_port = u16::from_be_bytes(portbuf);

    // 3. 打开 direct-tcpip 通道
    let channel = match session.channel_direct_tcpip(&target_host, target_port, None) {
        Ok(c) => c,
        Err(_) => {
            let _ = tcp.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return;
        }
    };

    // 4. 成功响应（bind addr 填 0.0.0.0:0，客户端通常忽略）
    if tcp.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).is_err() {
        return;
    }
    let _ = tcp.flush();

    // 5. 数据转发
    bridge(channel, tcp);
}

/// 解析 SOCKS5 目标地址：IPv4 / 域名 / IPv6。
fn read_socks_addr(tcp: &mut TcpStream, atyp: u8) -> Option<String> {
    match atyp {
        0x01 => {
            let mut ip = [0u8; 4];
            tcp.read_exact(&mut ip).ok()?;
            Some(format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]))
        }
        0x04 => {
            let mut ip = [0u8; 16];
            tcp.read_exact(&mut ip).ok()?;
            Some(std::net::Ipv6Addr::from(ip).to_string())
        }
        0x03 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).ok()?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).ok()?;
            Some(String::from_utf8_lossy(&name).to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn loopback_hosts_are_recognized() {
        for host in [
            "127.0.0.1",
            "127.0.0.2",
            "127.255.255.255",
            "::1",
            "localhost",
            "LOCALHOST",
            "LocalHost",
            " 127.0.0.1 ",
        ] {
            assert!(is_loopback_host(host), "应识别为回环地址: {host}");
        }
    }

    #[test]
    fn non_loopback_hosts_are_rejected() {
        for host in [
            "0.0.0.0",
            "10.0.0.1",
            "192.168.1.1",
            "::",
            "example.com",
            "",
            "127",
        ] {
            assert!(!is_loopback_host(host), "不应识别为回环地址: {host}");
        }
    }
}
