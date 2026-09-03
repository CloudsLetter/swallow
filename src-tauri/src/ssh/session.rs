use anyhow::{Context, Result};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use ssh2::{Channel, CheckResult, HashType, HostKeyType, KnownHostKeyFormat, Session};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::session_events::{emit_session_event, SessionEvent};

/// 连接超时兜底值（秒），配置缺失或锁中毒时使用。
pub(crate) const DEFAULT_CONNECTION_TIMEOUT_SECS: u32 = 30;

/// 终端写入退避上限：WouldBlock 时从 1ms 指数退避到此值，避免忙循环占锁饿死读线程。
const MAX_WRITE_BACKOFF_MS: u64 = 64;
/// 单次 write_data 的总超时：超过则认为对端不再排空（挂起/已断开），放弃并报错，
/// 避免长按/粘贴时前端写队列无限堆积。
const WRITE_DEADLINE_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" | "key" | "certificate"
    pub password: Option<String>,
    pub key_path: Option<String>,
    /// OpenSSH 证书文件（-cert.pub），certificate 认证时必填
    pub cert_path: Option<String>,
    pub passphrase: Option<String>,
    /// 密钥数据库记录 ID：key 认证时后端据此读取密钥内容
    pub key_id: Option<String>,
    /// 密钥私钥内容（后端在连接前从数据库填充，用于内存认证，不落盘）
    pub private_key: Option<String>,
    /// 密钥公钥内容（同上）
    pub public_key: Option<String>,
    /// 证书数据库记录 ID：certificate 认证时后端据此读取证书与私钥内容
    pub cert_id: Option<String>,
    /// OpenSSH 证书内容（-cert.pub 明文），后端从数据库填充，不落盘
    pub cert_content: Option<String>,
    /// 证书配套私钥内容（明文），后端从数据库填充，不落盘
    pub cert_private_key: Option<String>,
    /// 跳板机（ProxyJump）配置：连接目标前先认证该跳板机，再经 direct-tcpip 连目标。
    /// 支持递归嵌套（链式跳板），由调用方保证无循环引用。
    pub proxy: Option<Box<SshConfig>>,
}

/// 跳板机传输层：持有「跳板机会话 + 桥接线程句柄」，必须与目标会话同生命周期。
///
/// ssh2 的 `Session::set_tcp_stream` 只接受真实 OS socket（`AsRawFd`/`AsRawSocket`），
/// 无法直接绑定 direct-tcpip 通道，故用本地 loopback 对做桥接：一端交给目标会话，
/// 另一端与跳板机通道双向 `io::copy`（桥接线程）。
///
/// drop 顺序保证：目标会话（含其 socket）先 drop → 桥接线程读到 EOF 退出 →
/// 本结构 drop 时主动断跳板机会话并 join 桥接线程，杜绝 use-after-free 与线程泄漏。
pub struct JumpTransport {
    session: Session,
    bridge: Option<std::thread::JoinHandle<()>>,
}

impl Drop for JumpTransport {
    fn drop(&mut self) {
        // 主动断开跳板机会话，使桥接线程的通道读写立即失败退出，避免 join 无限挂起
        let _ = self.session.disconnect(None, "Proxy jump closed", None);
        if let Some(handle) = self.bridge.take() {
            let _ = handle.join();
        }
    }
}

/// 已完成认证的连接结果：目标会话 + 可选的跳板机传输层。
pub struct EstablishedSession {
    pub session: Session,
    pub jump: Option<JumpTransport>,
}

pub struct SshSession {
    session: Arc<Mutex<Session>>,
    channel: Arc<Mutex<Option<Channel>>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
    /// 跳板机传输层：随本会话存活，断开时一并释放。
    #[allow(dead_code)]
    jump: Option<JumpTransport>,
}

/// 主机密钥校验结果。
#[derive(Debug, Clone)]
pub enum HostKeyCheck {
    Matched,
    Unknown { fingerprint: String },
}

/// 首次连接遇到未知主机密钥：需要前端确认后才能写入 known_hosts。
/// 携带 host/port 供前端展示，token 供前端回传（`accept_host_key` 凭 token 从后端
/// 内存取回待确认主机的完整配置，避免密钥/证书明文经 IPC 往返）。
#[derive(Debug)]
pub struct HostKeyApprovalRequired {
    pub fingerprint: String,
    pub host: String,
    pub port: u16,
    pub token: String,
}

impl std::fmt::Display for HostKeyApprovalRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Host key approval required: {}", self.fingerprint)
    }
}

impl std::error::Error for HostKeyApprovalRequired {}

/// 待确认主机密钥条目：前端确认后凭 token 取回，经（可能的）跳板机重建连接验证指纹。
struct PendingHostKey {
    config: SshConfig,
}

/// 待确认主机密钥表：token -> 待确认主机完整配置。进程级内存，应用重启即清空；
/// 前端取消确认时残留少量条目（低频、无敏感落盘，可接受）。
static PENDING_HOST_KEYS: OnceLock<Mutex<HashMap<String, PendingHostKey>>> = OnceLock::new();

fn pending_host_keys() -> &'static Mutex<HashMap<String, PendingHostKey>> {
    PENDING_HOST_KEYS.get_or_init(|| Mutex::new(HashMap::new()))
}

static HOST_KEY_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成待确认主机密钥的唯一 token。
fn new_host_key_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = HOST_KEY_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("hk-{nanos}-{seq}")
}

/// 记录「待确认主机」的完整配置（含跳板机），返回其 token，供前端确认后回传。
fn register_pending_host_key(config: SshConfig) -> String {
    let token = new_host_key_token();
    pending_host_keys()
        .lock()
        .unwrap()
        .insert(token.clone(), PendingHostKey { config });
    token
}

/// 取回（并移除）某 token 对应的待确认主机配置。
fn take_pending_host_key(token: &str) -> Option<SshConfig> {
    pending_host_keys()
        .lock()
        .unwrap()
        .remove(token)
        .map(|e| e.config)
}

/// 记录待确认主机并返回 HostKeyApprovalRequired（供 SSH/SFTP 连接与 accept_host_key 使用）。
pub(crate) fn require_approval(config: SshConfig, fingerprint: String) -> anyhow::Error {
    let token = register_pending_host_key(config.clone());
    HostKeyApprovalRequired {
        fingerprint,
        host: config.host,
        port: config.port,
        token,
    }
    .into()
}

/// 用数据库中的密钥内容做公钥认证：把内容写入系统临时文件后调用
/// `userauth_pubkey_file`，认证结束（无论成败）临时文件随 NamedTempFile 析构
/// 立即删除，实现「密钥持久化在数据库、连接时不残留磁盘文件」。
pub fn userauth_pubkey_from_content(
    session: &Session,
    username: &str,
    private_key: &str,
    public_key: Option<&str>,
    passphrase: Option<&str>,
) -> Result<()> {
    // 用 tempdir + fs::write（写后即关闭句柄）：NamedTempFile 在 Windows 上持有独占句柄，
    // 会导致 libssh2 读取临时文件时报 Permission denied。
    let dir = tempfile::tempdir()?;
    let private_path = dir.path().join("key");
    fs::write(&private_path, private_key)?;

    let public_path = match public_key {
        Some(pk) => {
            let p = dir.path().join("key.pub");
            fs::write(&p, pk)?;
            Some(p)
        }
        None => None,
    };

    Ok(session.userauth_pubkey_file(
        username,
        public_path.as_deref(),
        &private_path,
        passphrase,
    )?)
}

/// 用数据库中的证书内容做证书认证：证书与配套私钥写入系统临时文件后调用
/// `userauth_pubkey_file`（证书作为 publickey 传入），认证结束临时文件随
/// NamedTempFile 析构立即删除，实现「证书持久化在数据库、连接时不残留磁盘文件」。
fn userauth_cert_from_content(
    session: &Session,
    username: &str,
    cert_content: &str,
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    // 用 tempdir + fs::write（写后即关闭句柄），避免 NamedTempFile 在 Windows 上占用
    // 独占句柄导致 libssh2 fopen 报 Permission denied。
    let dir = tempfile::tempdir()?;
    let cert_path = dir.path().join("cert.pub");
    fs::write(&cert_path, cert_content)?;
    let key_path = dir.path().join("cert.key");
    fs::write(&key_path, private_key)?;

    Ok(session.userauth_pubkey_file(
        username,
        Some(&cert_path),
        &key_path,
        passphrase,
    )?)
}

/// 跳板机桥接线程：在本地 loopback 对的一端与跳板机 direct-tcpip 通道间做双向数据泵。
/// channel 与 socket 都 move 进线程，线程退出时一并释放（stream 先于 channel drop，安全）。
fn spawn_jump_bridge(mut channel: Channel, remote_side: TcpStream) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        // 数据阶段空闲超时：防止半开连接让 io::copy 无限阻塞占线程
        let _ = remote_side.set_read_timeout(Some(Duration::from_secs(300)));
        let _ = remote_side.set_write_timeout(Some(Duration::from_secs(300)));
        let ssh_read = channel.stream(0);
        let ssh_write = channel.stream(0);
        let sock_read = match remote_side.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let sock_write = remote_side;

        // SSH -> socket
        let handle = {
            let mut r = ssh_read;
            let mut w = sock_write;
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut r, &mut w);
                let _ = w.flush();
            })
        };

        // socket -> SSH（当前线程）
        {
            let mut r = sock_read;
            let mut w = ssh_write;
            let _ = std::io::copy(&mut r, &mut w);
        }

        // 本地侧已关闭：通知远端 channel 结束并等待关闭，使 SSH->socket 方向退出。
        // 注意：这里不调用 stream.flush()，语义同 terminal 写路径（避免丢数据）。
        let _ = channel.send_eof();
        let _ = channel.wait_close();
        let _ = handle.join();
    })
}

/// 建立到目标主机的传输层 TCP 连接：直连，或经跳板机 direct-tcpip 桥接到本地 loopback 对。
/// 返回「目标会话可绑定的 TcpStream」与「可选的跳板机传输层」；跳板机传输层须由调用方
/// 随目标会话一同持有（否则桥接线程断开会话失效）。
fn establish_transport(
    config: &SshConfig,
    timeout_secs: u32,
    on_progress: &dyn Fn(&str, Option<&str>),
) -> Result<(TcpStream, Option<JumpTransport>)> {
    if let Some(proxy) = config.proxy.as_deref() {
        // 先建立（认证）跳板机会话；递归调用支持链式跳板（解析层已防循环）。
        let jump_established =
            SshSession::establish_authenticated_session(proxy, timeout_secs, on_progress)?;
        let channel = jump_established
            .session
            .channel_direct_tcpip(&config.host, config.port, None)
            .with_context(|| {
                format!(
                    "跳板机 {} 无法建立到 {}:{} 的直连通道（服务器可能禁用了 TCP 转发）",
                    proxy.host, config.host, config.port
                )
            })?;

        // ssh2 的 Session 只能绑定真实 OS socket（set_tcp_stream 要求 AsRawFd/AsRawSocket），
        // 不能直接绑定 direct-tcpip 通道。故用本地 loopback 对做桥接：一端交给目标会话，
        // 另一端与跳板机通道双向 io::copy（桥接线程）。
        let listener =
            TcpListener::bind("127.0.0.1:0").context("无法为跳板机连接创建本地桥接监听")?;
        let addr = listener.local_addr()?;
        let local_side = TcpStream::connect(addr).context("无法连接跳板机本地桥接")?;
        let (remote_side, _) = listener.accept().context("无法接受跳板机本地桥接连接")?;
        // 关闭 Nagle：loopback 对承载 SSH 交互小包，避免小写延迟
        let _ = local_side.set_nodelay(true);
        let _ = remote_side.set_nodelay(true);

        let bridge = spawn_jump_bridge(channel, remote_side);
        on_progress(
            "tcp",
            Some(&format!(
                "{}:{}（经跳板机 {}）",
                config.host, config.port, proxy.host
            )),
        );
        Ok((
            local_side,
            Some(JumpTransport {
                session: jump_established.session,
                bridge: Some(bridge),
            }),
        ))
    } else {
        let addr = format!("{}:{}", config.host, config.port);
        let sock_addr = addr
            .to_socket_addrs()
            .with_context(|| format!("Failed to resolve {}", addr))?
            .next()
            .context("No address resolved for SSH host")?;
        let tcp =
            TcpStream::connect_timeout(&sock_addr, Duration::from_secs(timeout_secs as u64))
                .with_context(|| format!("Failed to connect to {}", addr))?;
        // 关闭 Nagle：终端交互是大量小写（单次按键），否则小包会被延迟等待 ACK，
        // 与对端 delayed-ACK 叠加会引入可观延迟，快速输入时尤为明显。
        let _ = tcp.set_nodelay(true);
        on_progress("tcp", Some(&addr));
        Ok((tcp, None))
    }
}

impl SshSession {
    /// 建立已完成 TCP 连接 + 握手 + 主机密钥校验 + 认证的 SSH 会话（尚未启动 shell）。
    /// 终端连接与端口转发隧道共用此入口，保证认证链路只有一份实现。
    pub(crate) fn establish_authenticated_session(
        config: &SshConfig,
        timeout_secs: u32,
        on_progress: &dyn Fn(&str, Option<&str>),
    ) -> Result<EstablishedSession> {
        let timeout_secs = timeout_secs.max(1);

        // 建立传输层 TCP：直连，或经跳板机 direct-tcpip 桥接到本地 loopback 对。
        // 跳板机会话 + 桥接线程必须随目标会话存活，一并存入 EstablishedSession 返回。
        let (tcp, jump) = establish_transport(config, timeout_secs, on_progress)?;

        // 在（直连或跳板机桥接的）TCP 流上做目标主机 SSH 握手
        let mut session = Session::new()?;
        session.set_tcp_stream(tcp);
        session.set_timeout(timeout_secs.saturating_mul(1000));
        session.handshake()?;
        on_progress("ssh", None);

        // 主机密钥校验：匹配放行；未知密钥交由前端确认后再写入 known_hosts
        match verify_host_key(&session, &config.host, config.port)? {
            HostKeyCheck::Matched => {}
            HostKeyCheck::Unknown { fingerprint } => {
                return Err(require_approval(config.clone(), fingerprint));
            }
        }

        // 认证
        match config.auth_type.as_str() {
            "password" => {
                let password = config.password.as_ref()
                    .context("Password is required for password authentication")?;
                session.userauth_password(&config.username, password)?;
            }
            "key" => {
                if let Some(private_key) = config.private_key.as_deref() {
                    // 密钥内容存于数据库：写入临时文件认证，认证结束立即删除（用后即焚）
                    userauth_pubkey_from_content(
                        &session,
                        &config.username,
                        private_key,
                        config.public_key.as_deref(),
                        config.passphrase.as_deref(),
                    )?;
                } else if let Some(key_path) = config.key_path.as_deref() {
                    // 兼容旧数据 / 外部密钥文件场景：回退到文件认证
                    let key_path = PathBuf::from(key_path);
                    session.userauth_pubkey_file(
                        &config.username,
                        None,
                        &key_path,
                        config.passphrase.as_deref(),
                    )?;
                } else {
                    anyhow::bail!("No private key available for key authentication");
                }
            }
            "certificate" => {
                // OpenSSH 证书认证：证书文件作为 publickey、配套私钥作为 privatekey，
                // libssh2 ≥1.11 会以证书算法（*-cert-v01@openssh.com）完成认证。
                // 优先使用数据库中的证书内容（临时文件、用后即焚），兼容旧数据回退文件认证。
                if let (Some(cert_content), Some(cert_key)) = (
                    config.cert_content.as_deref(),
                    config.cert_private_key.as_deref(),
                ) {
                    userauth_cert_from_content(
                        &session,
                        &config.username,
                        cert_content,
                        cert_key,
                        config.passphrase.as_deref(),
                    )?;
                } else if let (Some(cert_path), Some(key_path)) = (
                    config.cert_path.as_deref(),
                    config.key_path.as_deref(),
                ) {
                    let cert_path = PathBuf::from(cert_path);
                    let key_path = PathBuf::from(key_path);

                    if !cert_path.exists() {
                        anyhow::bail!("Certificate file not found: {}", cert_path.display());
                    }
                    if !key_path.exists() {
                        anyhow::bail!("Private key file not found: {}", key_path.display());
                    }

                    session.userauth_pubkey_file(
                        &config.username,
                        Some(&cert_path),
                        &key_path,
                        config.passphrase.as_deref(),
                    )?;
                } else {
                    anyhow::bail!(
                        "Certificate authentication requires certificate content and private key"
                    );
                }
            }
            _ => anyhow::bail!("Unsupported authentication type: {}", config.auth_type),
        }

        if !session.authenticated() {
            anyhow::bail!("Authentication failed");
        }
        on_progress("auth", Some(&config.username));

        Ok(EstablishedSession { session, jump })
    }

    pub fn connect(
        config: SshConfig,
        session_id: String,
        timeout_secs: u32,
        on_progress: &dyn Fn(&str, Option<&str>),
    ) -> Result<Self> {
        let established = Self::establish_authenticated_session(&config, timeout_secs, on_progress)?;
        Ok(Self {
            session: Arc::new(Mutex::new(established.session)),
            channel: Arc::new(Mutex::new(None)),
            session_id,
            is_connected: Arc::new(Mutex::new(true)),
            disconnect_handler: Arc::new(Mutex::new(None)),
            jump: established.jump,
        })
    }

    /// 注册会话退出（EOF/错误/断开）时由 manager 执行的回调。
    pub fn set_disconnect_handler(&self, handler: Box<dyn FnOnce() + Send>) {
        *self.disconnect_handler.lock().unwrap() = Some(handler);
    }
    
    pub fn start_shell<R: tauri::Runtime>(
        &self,
        app_handle: tauri::AppHandle<R>,
        cols: u32,
        rows: u32,
        keep_alive_interval: u32,
    ) -> Result<()> {
        let session = self.session.lock().unwrap();
        let mut channel = session.channel_session()?;
        
        // 请求 PTY 并设置正确的窗口大小
        channel.request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))?;
        channel.shell()?;
        emit_session_event(
            &app_handle,
            &self.session_id,
            &SessionEvent::Progress { stage: "shell".into(), message: None },
        );

        // 设置会话为非阻塞模式，以便后续读取返回 WouldBlock
        session.set_blocking(false);
        
        // 存储 channel
        *self.channel.lock().unwrap() = Some(channel);
        
        drop(session);
        
        let session_id = self.session_id.clone();
        let session_arc = self.session.clone();
        let channel_arc = self.channel.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();
        // 读线程闭包会 move app_handle，这里 clone 一份供末尾 ready 进度 emit 使用
        let ready_app = app_handle.clone();

        // 启动输出读取线程
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            // 跨 read 的 UTF-8 增量解码缓冲：多字节字符可能恰好落在 8192 字节
            // 边界，直接把每个块单独 from_utf8_lossy 会把被切开的字符替换成 �。
            // 这里把「尚未完整」的尾部字节暂存，待下次 read 补齐后再解码发出。
            let mut pending: Vec<u8> = Vec::with_capacity(8192 + 4);
            let mut last_keepalive = std::time::Instant::now();
            loop {
                if !*is_connected.lock().unwrap() {
                    break;
                }
                
                let mut channel_guard = channel_arc.lock().unwrap();
                if let Some(ref mut channel) = *channel_guard {
                    match channel.read(&mut buffer) {
                        Ok(0) => {
                            emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                            break;
                        }
                        Ok(n) => {
                            pending.extend_from_slice(&buffer[..n]);
                            // 只把「已完整」的前缀转成字符串发出，把不完整的尾部
                            // 字节留给下一次 read；非法字节按 lossy 语义替换为 U+FFFD。
                            while !pending.is_empty() {
                                match std::str::from_utf8(&pending) {
                                    Ok(_) => {
                                        let data = String::from_utf8(std::mem::take(&mut pending))
                                            .unwrap_or_default();
                                        if !data.is_empty() {
                                            emit_session_event(
                                                &app_handle,
                                                &session_id,
                                                &SessionEvent::Output { data },
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        let valid_up_to = e.valid_up_to();
                                        let incomplete_tail = e.error_len().is_none();
                                        if valid_up_to > 0 {
                                            let data = String::from_utf8(
                                                pending[..valid_up_to].to_vec(),
                                            )
                                            .unwrap_or_default();
                                            pending.drain(..valid_up_to);
                                            emit_session_event(
                                                &app_handle,
                                                &session_id,
                                                &SessionEvent::Output { data },
                                            );
                                        } else if incomplete_tail {
                                            // 开头即未完整序列（valid_up_to == 0）：等下次补齐
                                            break;
                                        } else {
                                            // 开头是非法字节：替换为 U+FFFD 后跳过
                                            let bad_len = e.error_len().unwrap_or(1);
                                            pending.drain(..bad_len);
                                            emit_session_event(
                                                &app_handle,
                                                &session_id,
                                                &SessionEvent::Output {
                                                    data: "\u{FFFD}".to_string(),
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                            last_keepalive = std::time::Instant::now();
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            // 没有数据可读：按配置间隔发送 keepalive，检测连接是否仍存活
                            if keep_alive_interval > 0
                                && last_keepalive.elapsed()
                                    >= std::time::Duration::from_secs(keep_alive_interval as u64)
                            {
                                if let Ok(session) = session_arc.lock() {
                                    match session.keepalive_send() {
                                        Ok(_) => {}
                                        Err(e) => {
                                            let io_err: std::io::Error = e.into();
                                            if io_err.kind() == std::io::ErrorKind::WouldBlock {
                                                // EAGAIN：非阻塞 socket 发送缓冲区满，暂时无法
                                                // 发送 keepalive，不代表连接断开，忽略、下次再试
                                            } else {
                                                eprintln!("SSH keepalive error: {}", io_err);
                                                emit_session_event(
                                                    &app_handle,
                                                    &session_id,
                                                    &SessionEvent::Error {
                                                        message: format!("Keepalive failed: {}", io_err),
                                                    },
                                                );
                                                emit_session_event(
                                                    &app_handle,
                                                    &session_id,
                                                    &SessionEvent::Disconnected,
                                                );
                                                break;
                                            }
                                        }
                                    }
                                }
                                last_keepalive = std::time::Instant::now();
                            }
                            drop(channel_guard);
                            thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => {
                            eprintln!("SSH read error: {}", e);
                            emit_session_event(
                                &app_handle,
                                &session_id,
                                &SessionEvent::Error {
                                    message: e.to_string(),
                                },
                            );
                            emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                            break;
                        }
                    }
                } else {
                    break;
                }
                
                drop(channel_guard);
            }
            
            // 清理
            *is_connected.lock().unwrap() = false;

            // 通知 manager 移除该会话，使重连可以建立新会话
            let handler = disconnect_handler.lock().unwrap().take();
            if let Some(handler) = handler {
                handler();
            }
        });
        emit_session_event(
            &ready_app,
            &self.session_id,
            &SessionEvent::Progress { stage: "ready".into(), message: None },
        );

        Ok(())
    }
    
    pub fn write_data(&self, data: &str) -> Result<()> {
        let bytes = data.as_bytes();
        if bytes.is_empty() {
            return Ok(());
        }

        let mut remaining = bytes;
        // 指数退避：有进展即重置；WouldBlock 时从 1ms 起翻倍，封顶 MAX_WRITE_BACKOFF_MS。
        // 退避期间绝不持有 channel 锁，保证读线程能拿到锁去排空发送窗口、响应 keepalive，
        // 避免长按高频输入时写路径独占锁饿死读线程 → 对端 keepalive 超时断连。
        let mut backoff_ms: u64 = 1;
        let deadline = std::time::Instant::now() + Duration::from_secs(WRITE_DEADLINE_SECS);

        while !remaining.is_empty() {
            // 会话已被读线程判死（EOF/错误）：立即放弃，避免对死通道空转重试
            if !*self.is_connected.lock().unwrap() {
                anyhow::bail!("SSH session disconnected while writing");
            }
            if std::time::Instant::now() >= deadline {
                anyhow::bail!(
                    "Timed out writing {} bytes to SSH channel (peer not draining)",
                    bytes.len()
                );
            }

            let mut channel_guard = self.channel.lock().unwrap();
            let Some(channel) = channel_guard.as_mut() else {
                anyhow::bail!("Channel not initialized");
            };
            match channel.write(remaining) {
                Ok(n) if n > 0 => {
                    remaining = &remaining[n..];
                    backoff_ms = 1;
                }
                Ok(_) => {
                    // 写 0 字节：发送窗口空，释放锁后退避重试
                    drop(channel_guard);
                    thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(MAX_WRITE_BACKOFF_MS);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // 非阻塞 socket 发送缓冲/窗口满：释放锁后退避重试（同 Ok(_) 分支）
                    drop(channel_guard);
                    thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(MAX_WRITE_BACKOFF_MS);
                }
                Err(e) => return Err(e.into()),
            }
        }

        // 注意：这里绝不能调用 channel.flush()。
        // ssh2 的 Stream/Channel 实现 `std::io::Write::flush` 映射到
        // libssh2_channel_flush_ex，其语义是「丢弃接收缓冲里尚未读出的数据」，
        // 而不是「刷出待发送数据」。在终端写路径调用它会把服务端回显/重绘输出丢掉
        // （表现为快速输入时字符变成空白/空格），并打乱接收窗口记账，最终导致对端断连。
        // channel.write() 本身已通过 _libssh2_transport_send 立即下发，无需 flush。
        Ok(())
    }
    
    pub fn resize_pty(&self, cols: u32, rows: u32) -> Result<()> {
        let mut channel_guard = self.channel.lock().unwrap();
        if let Some(ref mut channel) = *channel_guard {
            channel.request_pty_size(cols, rows, Some(0), Some(0))?;
            Ok(())
        } else {
            anyhow::bail!("Channel not initialized")
        }
    }
    
    pub fn disconnect(&self) -> Result<()> {
        *self.is_connected.lock().unwrap() = false;
        
        // 关闭 channel
        let mut channel_guard = self.channel.lock().unwrap();
        if let Some(ref mut channel) = *channel_guard {
            let _ = channel.close();
            let _ = channel.wait_close();
        }
        *channel_guard = None;
        
        // 断开 session
        let session = self.session.lock().unwrap();
        session.disconnect(None, "User disconnected", None)?;
        
        Ok(())
    }
    
    #[allow(dead_code)]
    pub fn is_connected(&self) -> bool {
        *self.is_connected.lock().unwrap()
    }
}

/// 校验主机密钥：匹配放行，未知返回指纹（不自动写入），不匹配/失败拒绝。
///
/// - 匹配：放行；
/// - 首次连接（NotFound）：返回 Unknown 指纹，由前端确认后调用 accept_host_key；
/// - 不匹配：拒绝（可能是主机变更或中间人攻击）；
/// - 校验失败：拒绝。
pub(crate) fn verify_host_key(session: &Session, host: &str, port: u16) -> Result<HostKeyCheck> {
    let Some((key, _host_key_type)) = session.host_key() else {
        anyhow::bail!("Host key unavailable after handshake");
    };

    // 信任源为 DB（纯软件内管理，不走系统 ~/.ssh/known_hosts）：
    // 把全部已信任条目装载进 libssh2 内存 known_hosts 再比对
    let mut known = session.known_hosts()?;
    for (entry_host, entry_type, key_data) in
        crate::utils::sqlite::known_host_key_entries().map_err(|e| anyhow::anyhow!(e))?
    {
        if let Ok(blob) = STANDARD.decode(&key_data) {
            if let Some(fmt) = key_format_from_name(&entry_type) {
                let _ = known.add(&entry_host, &blob, "", fmt);
            }
        }
    }

    match known.check_port(host, port, key) {
        CheckResult::Match => Ok(HostKeyCheck::Matched),
        CheckResult::NotFound => Ok(HostKeyCheck::Unknown {
            fingerprint: host_key_fingerprint(session),
        }),
        CheckResult::Mismatch => anyhow::bail!(
            "Host key mismatch for {}:{} — the host may have changed or this could be a man-in-the-middle attack",
            host,
            port
        ),
        CheckResult::Failure => anyhow::bail!(
            "Host key verification failed for {}:{}",
            host,
            port
        ),
    }
}

/// 前端确认后调用：凭 token 从内存取回待确认主机的完整配置，经（可能的）跳板机
/// 重建连接并校验指纹一致后，把主机密钥写入 known_hosts。密钥/证书内容不经 IPC 往返。
pub fn accept_host_key(token: &str, expected_fingerprint: &str, timeout_secs: u32) -> Result<()> {
    let timeout_secs = timeout_secs.max(1);
    // 取回（并移除）待确认配置；过期/不存在则报错，前端需重新连接重新生成
    let config = take_pending_host_key(token)
        .ok_or_else(|| anyhow::anyhow!("主机密钥确认已过期或不存在，请重新连接"))?;

    // 经跳板机（或直连）重建到目标主机的 TCP 连接；跳板机传输层随函数作用域存活
    let (tcp, _jump) = establish_transport(&config, timeout_secs, &|_, _| {})?;

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    session.set_timeout(timeout_secs.saturating_mul(1000));
    session.handshake()?;

    let actual_fingerprint = host_key_fingerprint(&session);
    if actual_fingerprint != expected_fingerprint {
        anyhow::bail!(
            "Host key fingerprint mismatch: expected {}, got {}",
            expected_fingerprint,
            actual_fingerprint
        );
    }

    let Some((key, host_key_type)) = session.host_key() else {
        anyhow::bail!("Host key unavailable after handshake");
    };

    // 信任写入 DB（纯软件内管理）；非 22 端口按 OpenSSH 的 [host]:port 记录
    let add_host = if config.port == 22 {
        config.host.clone()
    } else {
        format!("[{}]:{}", config.host, config.port)
    };
    let key_type_name = match host_key_type {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => anyhow::bail!("Unsupported host key type"),
    };
    crate::utils::sqlite::insert_known_host(&add_host, key_type_name, &STANDARD.encode(key))
        .map_err(|e| anyhow::anyhow!(e))?;

    Ok(())
}

/// 计算 OpenSSH 风格的 SHA256 主机密钥指纹。
fn host_key_fingerprint(session: &Session) -> String {
    session
        .host_key_hash(HashType::Sha256)
        .map(|hash| format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
        .unwrap_or_else(|| "SHA256:unknown".to_string())
}

/// OpenSSH 主机密钥算法名 → libssh2 KnownHostKeyFormat（DB 装载用）。
fn key_format_from_name(name: &str) -> Option<KnownHostKeyFormat> {
    match name {
        "ssh-rsa" | "rsa-sha2-256" | "rsa-sha2-512" => Some(KnownHostKeyFormat::SshRsa),
        "ssh-dss" => Some(KnownHostKeyFormat::SshDss),
        "ecdsa-sha2-nistp256" => Some(KnownHostKeyFormat::Ecdsa256),
        "ecdsa-sha2-nistp384" => Some(KnownHostKeyFormat::Ecdsa384),
        "ecdsa-sha2-nistp521" => Some(KnownHostKeyFormat::Ecdsa521),
        "ssh-ed25519" => Some(KnownHostKeyFormat::Ed25519),
        _ => None,
    }
}
