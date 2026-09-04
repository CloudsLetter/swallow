//! VNC 的 SSH 隧道传输：noVNC -> 本地桥 -> ssh2 direct-tcpip channel -> 远程 VNC。
//!
//! 复用 `ssh/session.rs` 的认证链路（主机密钥校验/确认 token/password/key 认证），
//! 不复制连接逻辑；阻塞的 ssh2 API 全部由调用方放入 spawn_blocking 执行。
//! 本文件只负责：把「已认证 SSH 会话」对目标 VNC 服务开的 direct-tcpip 通道，
//! 泵到本地 loopback TCP 流一端（另一端交给异步 WS<->TCP 桥）。

use crate::services::keys::load_key_content;
use crate::ssh::session::{EstablishedSession, SshConfig, SshSession};
use crate::utils::sqlite;
use crate::vnc::SshTransportConfig;
use anyhow::{Context, Result};
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

/// SSH 隧道守护：持有「SSH 会话 + 跳板机传输层 + 数据泵线程」，
/// 必须与 VNC 会话同生命周期，否则跳板机连接会提前断开。
pub struct SshTunnelGuard {
    established: EstablishedSession,
    pump: Option<thread::JoinHandle<()>>,
}

impl Drop for SshTunnelGuard {
    fn drop(&mut self) {
        // 主动断开会话，使数据泵线程的通道读写立即失败退出，避免 join 挂起
        let _ = self.established.session.disconnect(None, "vnc tunnel closed", None);
        if let Some(handle) = self.pump.take() {
            let _ = handle.join();
        }
    }
}

/// 密钥认证内容装载（与 ssh_connect 保持一致：key_id 优先查 DB，回退 key_path）。
fn enrich_key(config: &mut SshConfig) -> Result<()> {
    if config.auth_type == "key" {
        if let Some(key_id) = config.key_id.clone() {
            let conn = sqlite::open_connection().map_err(|e| anyhow::anyhow!(e))?;
            let (private_key, public_key) =
                load_key_content(&conn, &key_id).map_err(|e| anyhow::anyhow!(e))?;
            if private_key.is_none() && public_key.is_none() {
                anyhow::bail!("该密钥的内容未存储，请重新导入或生成密钥。");
            }
            config.private_key = private_key;
            config.public_key = public_key;
        } else if config.private_key.is_none() && config.key_path.is_none() {
            anyhow::bail!("密钥认证缺少可用的密钥，请到“账号/主机”页重新选择密钥。");
        }
    }
    Ok(())
}

/// 根据 VNC SSH 传输配置构建目标 SSH 的 SshConfig（不伪装成 SSH 终端配置）。
fn to_ssh_config(t: &SshTransportConfig) -> SshConfig {
    SshConfig {
        host: t.ssh_host.clone(),
        port: t.ssh_port,
        username: t.ssh_username.clone(),
        auth_type: t.ssh_auth_type.clone(),
        password: t.ssh_password.clone(),
        key_path: t.ssh_key_path.clone(),
        cert_path: None,
        passphrase: t.ssh_passphrase.clone(),
        key_id: t.ssh_key_id.clone(),
        private_key: None,
        public_key: None,
        cert_id: None,
        cert_content: None,
        cert_private_key: None,
        // 第一版不支持 VNC 隧道再叠 ProxyJump（终端/SFTP 的跳板不受影响）
        proxy: None,
    }
}

/// 在 SSH 会话与本地 loopback TCP 对的一端之间做双向数据泵。
/// 参考 `ssh/tunnel.rs::bridge`：`channel.stream(0)` 是 Arc 句柄可克隆并发使用。
fn spawn_pump(mut channel: ssh2::Channel, mut tcp: TcpStream) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        // 空闲超时：防止半开连接占线程
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
        {
            let mut r = tcp_read;
            let mut w = ssh_write;
            let _ = io::copy(&mut r, &mut w);
            let _ = channel.send_eof();
        }

        let _ = handle.join();
    })
}

/// 建立到 VNC 服务的 SSH 隧道：
/// 认证目标 SSH -> 开 direct-tcpip 到 (target_host, target_port) -> 泵到本地 loopback。
///
/// 返回本地 TCP 流（交给异步桥的一端）与守护对象。
/// 若目标 SSH 主机密钥未知，会返回 `HostKeyApprovalRequired`（anyhow error，可 downcast），
/// 由调用方走确认流程后再重试本函数。
pub fn open_ssh_tunnel(
    transport: &SshTransportConfig,
    timeout_secs: u32,
) -> Result<(TcpStream, SshTunnelGuard)> {
    // 目标校验
    if transport.ssh_host.trim().is_empty() {
        anyhow::bail!("SSH 主机地址不能为空。");
    }
    if transport.target_host.trim().is_empty() {
        anyhow::bail!("VNC 目标主机不能为空。");
    }
    if transport.ssh_port == 0 || transport.target_port == 0 {
        anyhow::bail!("SSH/VNC 端口无效。");
    }

    let mut config = to_ssh_config(transport);
    enrich_key(&mut config)?;

    // 认证（含主机密钥校验；未知密钥抛 HostKeyApprovalRequired）
    let established =
        SshSession::establish_authenticated_session(&config, timeout_secs, &|_, _| {})?;

    // 本地 loopback 对：一端返回给异步桥，另一端与 direct-tcpip 通道数据泵
    let listener =
        TcpListener::bind("127.0.0.1:0").context("无法为 SSH 隧道创建本地桥接监听")?;
    let addr = listener.local_addr()?;
    let local_side = TcpStream::connect(addr).context("无法连接 SSH 隧道本地桥接")?;
    let _ = local_side.set_nodelay(true);
    let (remote_side, _) = listener.accept().context("无法接受 SSH 隧道本地桥接连接")?;
    let _ = remote_side.set_nodelay(true);

    let channel = established
        .session
        .channel_direct_tcpip(&transport.target_host, transport.target_port, None)
        .with_context(|| {
            format!(
                "SSH {}:{} 无法建立到 VNC {}:{} 的直连通道（服务器可能禁用了 TCP 转发）",
                transport.ssh_host, transport.ssh_port, transport.target_host, transport.target_port
            )
        })?;

    let pump = spawn_pump(channel, remote_side);
    let guard = SshTunnelGuard {
        established,
        pump: Some(pump),
    };
    Ok((local_side, guard))
}
