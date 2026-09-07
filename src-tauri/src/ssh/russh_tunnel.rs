//! russh 版端口转发隧道：local / remote / dynamic(SOCKS5) 三种转发。
//!
//! 与 ssh2 版（ssh/tunnel.rs）的结构性差异（docs/SSH_BACKEND_MIGRATION.md §6）：
//! - accept 循环事件驱动（`tokio::select!` + watch 停止信号），无 10ms 轮询空转；
//! - 每个转发连接 1 个 tokio task（`copy_bidirectional`），无 2 线程桥；
//! - keepalive 由 russh Config（keepalive_interval/keepalive_max）自动处理；
//! - 单连接上的多个 channel 完全并发，无 ssh2 Session 大锁串行问题。
//!
//! 停止信号：watch(false) 唤醒 accept 循环 + disconnect 断开 SSH 会话双保险。

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use russh::client::Handle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::models::data::PortForwarding;
use crate::ssh::russh_backend::{ClientHandler, RusshConnection};
use crate::ssh::tunnel::is_loopback_host;

/// 运行中的 russh 端口转发隧道。
pub struct RusshTunnel {
    #[allow(dead_code)]
    rule_id: String,
    /// 连接句柄（Handle 非 Clone，用 Arc 共享给 accept 循环与连接处理 task）
    handle: Arc<Handle<ClientHandler>>,
    stop_tx: watch::Sender<bool>,
}

impl RusshTunnel {
    pub fn stop(&self) {
        // 先发停止信号唤醒 accept 循环，再断开 SSH 会话（远端撤销 remote 监听、
        // 后续通道全部失败）。
        //
        // ⚠️ disconnect 只投递一条消息，但 block_on 绝不能在 tokio worker 线程上
        // 调用——stop() 可能来自 async command（stop_port_forward）或
        // TunnelManager::insert（替换旧隧道），这些都在 runtime 内运行，
        // block_on 会 panic「Cannot start a runtime from within a runtime」。
        // 因此：在 runtime 内就 spawn 独立任务投递；只有同步上下文
        // （如 RunEvent::ExitRequested 的 stop_all 清理）才 block_on 保证送达。
        let _ = self.stop_tx.send(true);
        let handle = Arc::clone(&self.handle);
        let disconnect = async move {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "Tunnel stopped", "en")
                .await;
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            tauri::async_runtime::spawn(disconnect);
        } else {
            let _ = tauri::async_runtime::block_on(disconnect);
        }
    }

}

/// 根据规则建立 russh 隧道并启动后台监听 task。
/// remote 规则的本地回连目标已在 `connect()` 时写入 Handler（回调驱动），
/// 这里只负责 local / dynamic 的本地监听与转发循环。
pub async fn start_russh_tunnel(
    rule: &PortForwarding,
    conn: RusshConnection,
) -> Result<RusshTunnel> {
    let rule_id = rule.id.clone();
    let rule_type = rule.rule_type.clone();
    let handle = Arc::new(conn.handle);
    let (stop_tx, stop_rx) = watch::channel(false);

    // 监听地址统一兜底（与 ssh2 版 start_tunnel 完全一致）：空值回退 loopback
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
                bail!(
                    "出于安全考虑，本地转发仅允许绑定回环地址（127.0.0.1 / ::1 / localhost），当前监听地址 {listen_host} 会暴露到外部网络"
                );
            }
            let target = target_host
                .filter(|s| !s.is_empty())
                .context("本地转发需要指定目标主机")?;
            let listener = tokio::net::TcpListener::bind((listen_host.as_str(), listen_port))
                .await
                .with_context(|| {
                    format!("本地端口 {listen_host}:{listen_port} 无法监听（可能已被占用）")
                })?;
            spawn_local_loop(
                listener,
                Arc::clone(&handle),
                target,
                target_port,
                stop_rx,
            );
        }
        "remote" => {
            // tcpip_forward 请求服务器在远端监听；新连接经 Handler 的
            // server_channel_open_forwarded_tcpip 回调回连本地目标。
            // listen_port=0 时返回服务器分配的实际端口（当前 UI 不使用，仅校验成功）。
            let _bound = handle
                .tcpip_forward(&listen_host, listen_port as u32)
                .await
                .with_context(|| {
                    format!(
                        "远程转发监听失败：SSH 服务器拒绝在 {listen_host}:{listen_port} 上监听（可能原因：服务器禁用了 TCP 转发、远程端口被占用，或监听地址非回环地址需开启 GatewayPorts）"
                    )
                })?;
        }
        "dynamic" => {
            // SOCKS5 认证：配置了用户名+密码才允许非回环绑定（与 ssh2 版一致）
            let socks_auth = match (&rule.socks_username, &rule.socks_password) {
                (Some(u), Some(p)) if !u.trim().is_empty() && !p.is_empty() => {
                    Some((u.clone(), p.clone()))
                }
                _ => None,
            };
            if socks_auth.is_none() && !is_loopback_host(&listen_host) {
                bail!(
                    "出于安全考虑，未配置认证的动态转发（SOCKS5）仅允许绑定回环地址（127.0.0.1 / ::1 / localhost），当前监听地址 {listen_host} 会形成开放代理；如需绑定非回环地址，请先配置代理用户名与密码"
                );
            }
            let listener = tokio::net::TcpListener::bind((listen_host.as_str(), listen_port))
                .await
                .with_context(|| {
                    format!("本地端口 {listen_host}:{listen_port} 无法监听（可能已被占用）")
                })?;
            spawn_dynamic_loop(listener, Arc::clone(&handle), socks_auth, stop_rx);
        }
        other => bail!("不支持的转发类型：{other}"),
    }

    Ok(RusshTunnel {
        rule_id,
        handle,
        stop_tx,
    })
}

/// 本地转发（ssh -L）：accept 循环事件驱动；开通道在循环内 await（毫秒级 RPC），
/// 数据泵 spawn 独立 task，单连接阻塞不影响其他连接。
fn spawn_local_loop(
    listener: tokio::net::TcpListener,
    handle: Arc<Handle<ClientHandler>>,
    target_host: String,
    target_port: u16,
    mut stop_rx: watch::Receiver<bool>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((mut tcp, _)) = accepted else { break };
                    // 开通道限时：服务器无响应时不能让 accept 循环无限挂起
                    // （否则后续新连接全部排队，只有 stop 能解围）
                    let opened = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        handle.channel_open_direct_tcpip(
                            target_host.clone(),
                            target_port as u32,
                            "127.0.0.1",
                            0,
                        ),
                    )
                    .await;
                    match opened {
                        Ok(Ok(ch)) => {
                            tauri::async_runtime::spawn(async move {
                                let mut ch = ch.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
                                // ChannelCloseOnDrop：drop 时自动 close，无需手工 EOF/wait
                            });
                        }
                        Ok(Err(e)) => {
                            eprintln!("direct-tcpip to {target_host}:{target_port} failed: {e}");
                        }
                        Err(_) => {
                            eprintln!("direct-tcpip to {target_host}:{target_port} timed out");
                        }
                    }
                }
            }
        }
    });
}

/// 动态转发（SOCKS5）：连接处理整体 spawn（握手可能被慢客户端拖住，
/// 不能阻塞 accept 循环），Handle 以 Arc 共享。
fn spawn_dynamic_loop(
    listener: tokio::net::TcpListener,
    handle: Arc<Handle<ClientHandler>>,
    socks_auth: Option<(String, String)>,
    mut stop_rx: watch::Receiver<bool>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((tcp, _)) = accepted else { break };
                    let handle = Arc::clone(&handle);
                    let socks_auth = socks_auth.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_socks5(handle, tcp, socks_auth).await;
                    });
                }
            }
        }
    });
}

/// 处理一个 SOCKS5 连接：方法协商 / RFC 1929 认证 / CONNECT，逻辑与 ssh2 版
/// handle_socks5 逐行对应，仅换成 async IO；握手全程 15s 超时兜底
/// （替代原来的 set_read_timeout，防慢客户端挂住 task）。
async fn handle_socks5(
    handle: Arc<Handle<ClientHandler>>,
    mut tcp: tokio::net::TcpStream,
    socks_auth: Option<(String, String)>,
) {
    // 握手 + 认证 + CONNECT 解析 + 开通道 + 成功响应，整体限时 15s：
    // 超时/失败时客户端连接直接关闭（握手函数内部已写过对应错误响应）
    let opened = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let (target_host, target_port) = socks5_handshake(&mut tcp, &socks_auth).await?;
        // 打开 direct-tcpip 通道；失败按 RFC 写「connection not allowed」
        let channel = handle
            .channel_open_direct_tcpip(target_host.clone(), target_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|_| {
                // 尽力通知客户端（此时无法区分具体失败原因）
                socks5_handshake_error(&mut tcp, 0x05)
            })?;
        // 成功响应（bind addr 填 0.0.0.0:0，客户端通常忽略）
        tcp.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await?;
        tcp.flush().await?;
        Ok::<_, std::io::Error>((channel, target_host, target_port))
    })
    .await;
    match opened {
        Ok(Ok((channel, _target_host, _target_port))) => {
            // 5. 数据转发（1 task，无锁；ChannelCloseOnDrop 自动收尾）
            let mut ch = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
        }
        Ok(Err(_)) | Err(_) => {
            // 失败/超时：连接随即 drop，无需额外清理
        }
    }
}

/// 向客户端尽力写一个 SOCKS5 失败响应（reply 为 RFC 1928 错误码）后返回错误。
fn socks5_handshake_error(tcp: &mut tokio::net::TcpStream, reply: u8) -> std::io::Error {
    // try_write：同步尽力写（不等待），失败也无所谓——连接马上关闭
    let _ = tcp.try_write(&[0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    std::io::Error::new(
        std::io::ErrorKind::Other,
        format!("direct-tcpip open failed (socks reply {reply})"),
    )
}

/// SOCKS5 前置握手（方法协商 + 认证 + CONNECT 请求解析），
/// 成功返回 (目标主机, 目标端口)；失败时已向客户端写出对应错误响应。
async fn socks5_handshake(
    tcp: &mut tokio::net::TcpStream,
    socks_auth: &Option<(String, String)>,
) -> std::io::Result<(String, u16)> {
    // 1. 方法协商
    let mut buf = [0u8; 2];
    tcp.read_exact(&mut buf).await?;
    if buf[0] != 0x05 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not socks5",
        ));
    }
    let nmethods = buf[1] as usize;
    if nmethods == 0 || nmethods > 255 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad nmethods",
        ));
    }
    let mut methods = vec![0u8; nmethods];
    tcp.read_exact(&mut methods).await?;

    match socks_auth {
        None => {
            if !methods.contains(&0x00) {
                let _ = tcp.write_all(&[0x05, 0xFF]).await;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "no acceptable method",
                ));
            }
            tcp.write_all(&[0x05, 0x00]).await?;
        }
        Some((expected_user, expected_pass)) => {
            if !methods.contains(&0x02) {
                let _ = tcp.write_all(&[0x05, 0xFF]).await;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "no username/password method",
                ));
            }
            tcp.write_all(&[0x05, 0x02]).await?;
            tcp.flush().await?;

            // RFC 1929：ver=0x01 ulen username plen password
            let mut head = [0u8; 2];
            tcp.read_exact(&mut head).await?;
            if head[0] != 0x01 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "bad auth version",
                ));
            }
            let ulen = head[1] as usize;
            let mut username = vec![0u8; ulen];
            tcp.read_exact(&mut username).await?;
            let mut plen = [0u8; 1];
            tcp.read_exact(&mut plen).await?;
            let mut password = vec![0u8; plen[0] as usize];
            tcp.read_exact(&mut password).await?;
            if username == expected_user.as_bytes() && password == expected_pass.as_bytes() {
                tcp.write_all(&[0x01, 0x00]).await?;
            } else {
                let _ = tcp.write_all(&[0x01, 0x01]).await;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "auth failed",
                ));
            }
        }
    }
    let _ = tcp.flush().await;

    // 2. CONNECT 请求
    let mut head = [0u8; 4];
    tcp.read_exact(&mut head).await?;
    if head[0] != 0x05 || head[2] != 0x00 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad request",
        ));
    }
    let cmd = head[1];
    let atyp = head[3];
    if cmd != 0x01 {
        // 仅支持 CONNECT
        let _ = tcp.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "command not supported",
        ));
    }
    let Some(target_host) = read_socks_addr(tcp, atyp).await else {
        let _ = tcp.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad address",
        ));
    };
    let mut portbuf = [0u8; 2];
    tcp.read_exact(&mut portbuf).await?;
    let target_port = u16::from_be_bytes(portbuf);
    Ok((target_host, target_port))
}

/// 解析 SOCKS5 目标地址：IPv4 / 域名 / IPv6（与 ssh2 版 read_socks_addr 一致）。
async fn read_socks_addr(tcp: &mut tokio::net::TcpStream, atyp: u8) -> Option<String> {
    match atyp {
        0x01 => {
            let mut ip = [0u8; 4];
            tcp.read_exact(&mut ip).await.ok()?;
            Some(format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]))
        }
        0x04 => {
            let mut ip = [0u8; 16];
            tcp.read_exact(&mut ip).await.ok()?;
            Some(std::net::Ipv6Addr::from(ip).to_string())
        }
        0x03 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await.ok()?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await.ok()?;
            Some(String::from_utf8_lossy(&name).to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod socks5_tests {
    //! SOCKS5 握手协议测试：起真实 loopback listener，测试侧扮演 SOCKS5 客户端，
    //! 断言服务端（socks5_handshake）的响应字节与解析出的目标地址。

    use super::socks5_handshake;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 建立一对 loopback 连接：返回（客户端流，服务端流）。
    async fn loopback_pair() -> (tokio::net::TcpStream, tokio::net::TcpStream) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (client, server)
    }

    /// 在独立 task 里跑服务端握手，返回 JoinHandle 供断言结果。
    fn run_handshake(
        mut server: tokio::net::TcpStream,
        auth: Option<(String, String)>,
    ) -> tokio::task::JoinHandle<std::io::Result<(String, u16)>> {
        tokio::spawn(async move { socks5_handshake(&mut server, &auth).await })
    }

    #[tokio::test]
    async fn no_auth_and_ipv4_connect() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        // 方法协商：客户端支持 no-auth
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        assert_eq!(resp, [0x05, 0x00]);
        // CONNECT 1.2.3.4:443（IPv4）
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x01, 0xBB])
            .await
            .unwrap();
        let (host, port) = task.await.unwrap().unwrap();
        assert_eq!((host.as_str(), port), ("1.2.3.4", 443));
    }

    #[tokio::test]
    async fn domain_connect() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        // CONNECT example.com:80（域名，len=11）
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&[0x00, 0x50]);
        client.write_all(&req).await.unwrap();
        let (host, port) = task.await.unwrap().unwrap();
        assert_eq!((host.as_str(), port), ("example.com", 80));
    }

    #[tokio::test]
    async fn ipv6_connect() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        // CONNECT 2001:db8::1（IPv6，16 字节）
        let mut addr = [0u8; 16];
        addr[0] = 0x20;
        addr[1] = 0x01;
        addr[2] = 0x0d;
        addr[3] = 0xb8;
        client
            .write_all(&[0x05, 0x01, 0x00, 0x04])
            .await
            .unwrap();
        client.write_all(&addr).await.unwrap();
        client.write_all(&[0x00, 0x50]).await.unwrap();
        let (host, port) = task.await.unwrap().unwrap();
        assert_eq!((host.as_str(), port), ("2001:db8::", 80));
    }

    #[tokio::test]
    async fn no_auth_method_mismatch_replies_ff() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        // 客户端只提供用户名/密码方法，服务端配置为无认证 → 拒绝
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        assert_eq!(resp, [0x05, 0xFF]);
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn password_auth_ok_and_domain() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, Some(("alice".to_string(), "s3cret".to_string())));
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        assert_eq!(resp, [0x05, 0x02]);
        // RFC 1929：ulen "alice" / plen "s3cret"
        let mut auth_req = vec![0x01, 5];
        auth_req.extend_from_slice(b"alice");
        auth_req.push(6);
        auth_req.extend_from_slice(b"s3cret");
        client.write_all(&auth_req).await.unwrap();
        let mut auth_resp = [0u8; 2];
        client.read_exact(&mut auth_resp).await.unwrap();
        assert_eq!(auth_resp, [0x01, 0x00]);
        // CONNECT example.org:8080
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 11];
        req.extend_from_slice(b"example.org");
        req.extend_from_slice(&[0x1F, 0x90]);
        client.write_all(&req).await.unwrap();
        let (host, port) = task.await.unwrap().unwrap();
        assert_eq!((host.as_str(), port), ("example.org", 8080));
    }

    #[tokio::test]
    async fn wrong_password_replies_failure() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, Some(("alice".to_string(), "s3cret".to_string())));
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        assert_eq!(resp, [0x05, 0x02]);
        let mut auth_req = vec![0x01, 5];
        auth_req.extend_from_slice(b"alice");
        auth_req.push(5);
        auth_req.extend_from_slice(b"nope!");
        client.write_all(&auth_req).await.unwrap();
        let mut auth_resp = [0u8; 2];
        client.read_exact(&mut auth_resp).await.unwrap();
        assert_eq!(auth_resp, [0x01, 0x01]);
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn bind_command_rejected() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).await.unwrap();
        // cmd=0x02 (BIND)——仅支持 CONNECT，应答 command not supported
        client
            .write_all(&[0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x01, 0xBB])
            .await
            .unwrap();
        // ⚠️ 不读响应：服务端写完错误应答即返回 Err 并 drop 流，
        // 未读数据在 Windows 上会触发 RST，客户端读取存在竞争。
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn non_socks5_handshake_fails() {
        let (mut client, server) = loopback_pair().await;
        let task = run_handshake(server, None);
        // SOCKS4 版本字节 → 直接失败
        client.write_all(&[0x04, 0x01, 0x00]).await.unwrap();
        assert!(task.await.unwrap().is_err());
    }
}
