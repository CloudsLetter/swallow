//! russh 后端：端口转发隧道的连接、认证、主机密钥与客户端回调。
//!
//! 背景：ssh2 的 Session 是一把全局大锁，端口转发是唯一在单 Session 上开
//! 多个并发 channel 的场景，阻塞读会串行化所有转发连接（详见
//! docs/SSH_BACKEND_MIGRATION.md §2）。隧道层因此切换到 russh（tokio 异步、
//! 每连接独立 channel、无 Session 级锁）；终端/SFTP/monitor/VNC 仍走 ssh2。
//!
//! 主机密钥信任源与 ssh2 路径一致：SQLite（`known_host_key_entries`），
//! 校验语义与指纹格式统一在 `ssh::session::check_known_host_entry` /
//! `fingerprint_from_blob`（两后端共用）；未知密钥复用 PENDING_HOST_KEYS →
//! accept_host_key 确认链路，且确认时用同一后端重建（两库协商的 host key
//! 算法可能不同，跨后端重建指纹必然不一致）。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use russh::client::{self, Handle};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{Certificate, PrivateKey, PrivateKeyWithHashAlg};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::ssh::host_keys::{
    check_known_host_entry, fingerprint_from_blob, require_approval_russh, HostKeyCheck,
};
use crate::ssh::session::SshConfig;

/// Handler 自定义错误：russh 要求 `Handler::Error: From<russh::Error> + Send + Debug`，
/// 包一层 anyhow 以便在回调里携带中文上下文（如主机密钥 Mismatch 的具体原因）。
#[derive(Debug)]
pub struct HandlerError(anyhow::Error);

impl std::fmt::Display for HandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HandlerError {}

impl From<russh::Error> for HandlerError {
    fn from(e: russh::Error) -> Self {
        Self(e.into())
    }
}

impl From<anyhow::Error> for HandlerError {
    fn from(e: anyhow::Error) -> Self {
        Self(e)
    }
}

/// 握手阶段捕获的服务器主机密钥（accept_host_key 的 russh 重建路径用）。
#[derive(Clone)]
pub(crate) struct ServerKeyInfo {
    /// OpenSSH 算法名（如 "ssh-ed25519" / "ssh-rsa"），DB 记录用
    pub algorithm: String,
    /// OpenSSH wire blob（与 accept_host_key 写入的 ssh2 blob 同格式）
    pub blob: Vec<u8>,
}

/// russh 客户端回调：主机密钥校验、断线标记、远程转发回连。
pub struct ClientHandler {
    /// 正在连接的目标主机（check_server_key 用）
    pub host: String,
    pub port: u16,
    /// check_server_key 拒绝未知密钥时写入的指纹（connect 返回后由上层读取，
    /// 转成 HostKeyApprovalRequired 走前端确认流程）
    pub unknown_fingerprint: Arc<Mutex<Option<String>>>,
    /// 握手阶段无条件记录服务器主机密钥（含算法与 blob），
    /// accept_host_key 的 russh 重建路径据此写入 DB
    pub server_key: Arc<Mutex<Option<ServerKeyInfo>>>,
    /// remote（ssh -R）转发的本地回连目标；非 remote 规则为 None
    pub forward_target: Option<(String, u16)>,
    /// 连接断开通知（事件驱动替代看门狗轮询）：事件循环 disconnected 回调触发，
    /// 由上层做清理与前端状态推送。跳板机会话共享同一闭包（跳板断 = 整条隧道断）。
    pub on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl client::Handler for ClientHandler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let blob = server_public_key
            .to_bytes()
            .map_err(|e| HandlerError(anyhow::anyhow!("无法序列化主机公钥: {e}")))?;
        let fingerprint = fingerprint_from_blob(&blob);
        let algorithm = server_public_key.algorithm().as_str().to_string();
        let allowed = match check_known_host_entry(&self.host, self.port, &algorithm, &blob)? {
            HostKeyCheck::Matched => true,
            HostKeyCheck::Unknown { .. } => {
                // 拒绝握手，connect 会以错误结束；上层读 unknown_fingerprint
                // 转成待确认流程（token 里保存完整配置与来源后端）
                *self.unknown_fingerprint.lock().unwrap() = Some(fingerprint);
                false
            }
        };
        // 无条件记录（握手只回调一次），accept_host_key 的 russh 重建路径据此写库
        *self.server_key.lock().unwrap() = Some(ServerKeyInfo { algorithm, blob });
        Ok(allowed)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // remote（ssh -R）：服务器把远端的新连接通过本通道推回来，回连本地目标。
        // 数据泵不能占住事件循环：spawn 独立 task，回调立即返回。
        let Some((target_host, target_port)) = self.forward_target.clone() else {
            // 非 remote 规则收到该回调（服务器主动推流）：直接关闭通道即可
            return Ok(());
        };
        tauri::async_runtime::spawn(async move {
            let mut ch = channel.into_stream();
            match tokio::net::TcpStream::connect((target_host.as_str(), target_port)).await {
                Ok(mut tcp) => {
                    let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
                }
                Err(e) => {
                    eprintln!("remote forward: connect local target {target_host}:{target_port} failed: {e}");
                }
            }
            // ChannelCloseOnDrop：ch drop 时自动向远端发送 close
        });
        Ok(())
    }

    async fn disconnected(
        &mut self,
        _reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        // 事件驱动断线感知：立即通知上层清理（幂等），替代 3s 轮询看门狗
        if let Some(cb) = &self.on_disconnected {
            cb();
        }
        Ok(())
    }
}

/// 已建立的 russh 连接：目标连接 + 可选的跳板机连接（随本连接存活，drop 即释放）。
pub struct RusshConnection {
    pub handle: Handle<ClientHandler>,
    /// 跳板机连接（含其自身的可能上级跳板）。handle drop 后 russh 事件循环
    /// 自动结束并断开底层 TCP，无需像 ssh2 版那样手工 disconnect + join。
    _jump: Option<Box<RusshConnection>>,
}

/// 传递给 russh 的任意传输层：直连 TCP 或跳板机 direct-tcpip 通道统一装箱。
/// （Rust 的 trait object 只允许一个非 auto trait，故先合成一个组合 trait。）
trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncReadWrite for T {}
type BoxedTransport = Box<dyn AsyncReadWrite>;

/// 建立已完成握手 + 主机密钥校验 + 认证的 russh 连接（尚未开任何转发通道）。
///
/// `forward_target`：remote（ssh -R）规则的本地回连目标，供 Handler 回调使用；
/// local/dynamic 传 None。跳板机递归复用本函数，认证链路与 ssh2 版一一对应。
pub async fn connect(
    config: &SshConfig,
    timeout_secs: u32,
    forward_target: Option<(String, u16)>,
    on_progress: &(dyn Fn(&str, Option<&str>) + Send + Sync),
    on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
) -> Result<RusshConnection> {
    connect_inner(
        config,
        timeout_secs,
        forward_target,
        on_progress,
        Arc::new(Mutex::new(None)),
        true,
        on_disconnected,
    )
    .await
}

/// connect 的完整实现。`server_key`：由调用方创建并注入 Handler 的记录槽
/// （握手时无条件写入服务器主机密钥）；`do_auth=false` 用于主机密钥确认流程
/// （只需握手，不认证）。
async fn connect_inner(
    config: &SshConfig,
    timeout_secs: u32,
    forward_target: Option<(String, u16)>,
    on_progress: &(dyn Fn(&str, Option<&str>) + Send + Sync),
    server_key: Arc<Mutex<Option<ServerKeyInfo>>>,
    do_auth: bool,
    on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
) -> Result<RusshConnection> {
    let timeout_secs = timeout_secs.max(1);
    let timeout = Duration::from_secs(timeout_secs as u64);

    // 传输层：直连 TCP，或递归经跳板机 direct-tcpip 通道（通道本身即 AsyncRead+Write，
    // 无需 ssh2 那套 loopback 对桥接）
    let (transport, jump): (BoxedTransport, Option<Box<RusshConnection>>) = match &config.proxy {
        None => {
            let addr = format!("{}:{}", config.host, config.port);
            let tcp = tokio::time::timeout(
                timeout,
                tokio::net::TcpStream::connect((config.host.as_str(), config.port)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Failed to connect to {addr} (timed out)"))?
            .with_context(|| format!("Failed to connect to {addr}"))?;
            on_progress("tcp", Some(&addr));
            (Box::new(tcp), None)
        }
        Some(proxy) => {
            let jump_conn = Box::new(
                Box::pin(connect_inner(
                    proxy,
                    timeout_secs,
                    None,
                    on_progress,
                    Arc::new(Mutex::new(None)),
                    true,
                    on_disconnected.clone(),
                ))
                    .await
                    .with_context(|| {
                    format!("跳板机 {} 连接失败", proxy.host)
                })?,
            );
            let channel = tokio::time::timeout(
                timeout,
                jump_conn.handle.channel_open_direct_tcpip(
                    config.host.clone(),
                    config.port as u32,
                    "127.0.0.1",
                    0,
                ),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "跳板机 {} 建立 {}:{} 通道超时",
                    proxy.host,
                    config.host,
                    config.port
                )
            })?
            .with_context(|| {
                format!(
                    "跳板机 {} 无法建立到 {}:{} 的直连通道（服务器可能禁用了 TCP 转发）",
                    proxy.host, config.host, config.port
                )
            })?;
            on_progress(
                "tcp",
                Some(&format!(
                    "{}:{}（经跳板机 {}）",
                    config.host, config.port, proxy.host
                )),
            );
            (Box::new(channel.into_stream()), Some(jump_conn))
        }
    };

    // 连接期配置：nodelay 保持小包低延迟；keepalive 交给 russh 自动处理
    //（无需自建探活线程）；⚠️ inactivity_timeout 语义是「空闲 N 秒断开」，
    // 与 ssh2 那个 30s 自断 bug 同款，隧道场景必须留 None。
    let client_config = Arc::new(client::Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..<_>::default()
    });

    let unknown_fingerprint = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        unknown_fingerprint: Arc::clone(&unknown_fingerprint),
        server_key,
        forward_target,
        on_disconnected,
    };

    // 握手（含主机密钥校验回调）
    let mut handle: Handle<ClientHandler> = tokio::time::timeout(
        timeout,
        client::connect_stream(client_config, transport, handler),
    )
    .await
    .map_err(|_| anyhow::anyhow!("SSH handshake timed out"))?
    .map_err(|e| map_connect_error(e, &unknown_fingerprint, config))?;
    on_progress("ssh", None);

    // 认证（主机密钥确认流程跳过：只需握手即可拿到指纹）
    if do_auth {
        tokio::time::timeout(timeout, authenticate(&mut handle, config))
            .await
            .map_err(|_| anyhow::anyhow!("SSH authentication timed out"))??;
        on_progress("auth", Some(&config.username));
    }

    Ok(RusshConnection { handle, _jump: jump })
}

/// accept_host_key 的 russh 路径：用 russh 重建连接（与首次连接协商到同一把
/// host key），比对指纹后把密钥按算法写入 DB。只握手不认证（认证失败不影响
/// 主机密钥确认）。由 `ssh::session::accept_host_key` 按待确认后端分派调用。
pub(crate) async fn verify_and_learn_host_key(
    config: &SshConfig,
    expected_fingerprint: &str,
    timeout_secs: u32,
) -> Result<()> {
    let server_key: Arc<Mutex<Option<ServerKeyInfo>>> = Arc::new(Mutex::new(None));
    let _ = connect_inner(
        config,
        timeout_secs.max(1),
        None,
        &|_, _| {},
        Arc::clone(&server_key),
        false,
        None,
    )
    .await;

    let info = server_key
        .lock()
        .unwrap()
        .clone()
        .context("未能获取服务器主机密钥（握手未完成，请检查网络或跳板机）")?;
    let actual_fingerprint = fingerprint_from_blob(&info.blob);
    if actual_fingerprint != expected_fingerprint {
        bail!(
            "Host key fingerprint mismatch: expected {expected_fingerprint}, got {actual_fingerprint}"
        );
    }

    // 信任写入 DB（纯软件内管理）；非 22 端口按 OpenSSH 的 [host]:port 记录
    let add_host = if config.port == 22 {
        config.host.clone()
    } else {
        format!("[{}]:{}", config.host, config.port)
    };
    crate::utils::sqlite::insert_known_host(&add_host, &info.algorithm, &STANDARD.encode(&info.blob))
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(())
}

/// 认证分派：与 ssh2 版 establish_authenticated_session 的 auth_type 分支一一对应。
/// russh 全程内存解析（无临时文件）；私钥仅支持 OpenSSH 新格式（fork ssh-key
/// 未启用 pem feature，传统 PKCS#1/PKCS#8/SEC1 PEM 解析不可用）。
async fn authenticate(handle: &mut Handle<ClientHandler>, config: &SshConfig) -> Result<()> {
    authenticate_inner(handle, config)
        .await
        .map_err(map_russh_error)
}

async fn authenticate_inner(
    handle: &mut Handle<ClientHandler>,
    config: &SshConfig,
) -> Result<()> {
    match config.auth_type.as_str() {
        "password" => {
            let password = config.password.as_ref().context(
                "Password is required for password authentication",
            )?;
            let result = handle
                .authenticate_password(&config.username, password)
                .await?;
            if !result.success() {
                bail!("Authentication failed");
            }
        }
        "key" => {
            if let Some(private_key) = config.private_key.as_deref() {
                // 密钥内容存于数据库：内存解析（用后即焚，连临时文件都不需要）
                authenticate_with_key(handle, &config.username, private_key, config.passphrase.as_deref()).await?;
            } else if let Some(key_path) = config.key_path.as_deref() {
                // 兼容旧数据 / 外部密钥文件场景：读入内存后走同一条路径
                let pem = std::fs::read_to_string(Path::new(key_path))
                    .with_context(|| format!("Failed to read private key file: {key_path}"))?;
                authenticate_with_key(handle, &config.username, &pem, config.passphrase.as_deref()).await?;
            } else {
                bail!("No private key available for key authentication");
            }
        }
        "certificate" => {
            if let (Some(cert_content), Some(cert_key)) = (
                config.cert_content.as_deref(),
                config.cert_private_key.as_deref(),
            ) {
                authenticate_with_cert(handle, &config.username, cert_content, cert_key, config.passphrase.as_deref()).await?;
            } else if let (Some(cert_path), Some(key_path)) = (
                config.cert_path.as_deref(),
                config.key_path.as_deref(),
            ) {
                if !Path::new(cert_path).exists() {
                    bail!("Certificate file not found: {cert_path}");
                }
                if !Path::new(key_path).exists() {
                    bail!("Private key file not found: {key_path}");
                }
                let cert_content = std::fs::read_to_string(cert_path)
                    .with_context(|| format!("Failed to read certificate file: {cert_path}"))?;
                let key_pem = std::fs::read_to_string(key_path)
                    .with_context(|| format!("Failed to read private key file: {key_path}"))?;
                authenticate_with_cert(handle, &config.username, &cert_content, &key_pem, config.passphrase.as_deref()).await?;
            } else {
                bail!("Certificate authentication requires certificate content and private key");
            }
        }
        "agent" => authenticate_with_agent(handle, &config.username).await?,
        other => bail!("Unsupported authentication type: {other}"),
    }
    Ok(())
}

/// SSH Agent 认证：枚举 agent 中的全部身份逐一尝试（签名由 agent 完成，
/// 私钥永不出 agent）。Windows 优先 Pageant，再试 OpenSSH Agent 服务的
/// 命名管道；Unix 走 SSH_AUTH_SOCK。
async fn authenticate_with_agent(handle: &mut Handle<ClientHandler>, username: &str) -> Result<()> {
    #[cfg(windows)]
    let mut agent = {
        use russh::keys::agent::client::AgentClient;
        match AgentClient::connect_pageant().await {
            Ok(client) => client.dynamic(),
            Err(_) => AgentClient::connect_named_pipe("\\\\.\\pipe\\openssh-ssh-agent")
                .await
                .context(
                    "未找到可用的 SSH Agent（请启动 OpenSSH Authentication Agent 服务或 Pageant）",
                )?
                .dynamic(),
        }
    };
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .context("无法连接 SSH Agent（请检查 SSH_AUTH_SOCK 环境变量）")?
        .dynamic();

    let identities = agent
        .request_identities()
        .await
        .context("SSH Agent 请求身份列表失败")?;
    if identities.is_empty() {
        bail!("SSH Agent 中没有可用密钥（请先用 ssh-add 添加）");
    }

    let mut last_err = String::new();
    for identity in &identities {
        let key = identity.public_key().into_owned();
        match handle
            .authenticate_publickey_with(username, key, None, &mut agent)
            .await
        {
            Ok(russh::client::AuthResult::Success) => return Ok(()),
            Ok(russh::client::AuthResult::Failure { .. }) => continue,
            Err(e) => last_err = e.to_string(),
        }
    }
    bail!(
        "SSH Agent 认证失败：服务器拒绝了 Agent 中的全部密钥 {last_err}"
    )
}

async fn authenticate_with_key(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    private_key_pem: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    let key = load_private_key_from_memory(private_key_pem, passphrase)?;
    // RSA 服务器侧哈希算法协商；非 RSA 密钥该值被忽略
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await?;
    if !result.success() {
        bail!("Public key authentication failed");
    }
    Ok(())
}

async fn authenticate_with_cert(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    cert_openssh: &str,
    private_key_pem: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    let key = load_private_key_from_memory(private_key_pem, passphrase)?;
    let cert = Certificate::from_openssh(cert_openssh)
        .context("无法解析 OpenSSH 证书内容")?;
    let result = handle
        .authenticate_openssh_cert(username, Arc::new(key), cert)
        .await?;
    if !result.success() {
        bail!("Certificate authentication failed");
    }
    Ok(())
}

/// 内存解析私钥：OpenSSH 新格式（`-----BEGIN OPENSSH PRIVATE KEY-----`），
/// 加密私钥用 passphrase 解密。传统 PEM（PKCS#1/PKCS#8/SEC1）因 fork ssh-key
/// 未启用 pem feature 而不支持——错误信息直接说明，导入侧应规范化为 OpenSSH 格式。
fn load_private_key_from_memory(pem: &str, passphrase: Option<&str>) -> Result<PrivateKey> {
    let mut key = PrivateKey::from_openssh(pem)
        .context("无法解析私钥：当前仅支持 OpenSSH 新格式（ssh-keygen 默认格式），传统 PEM 请先转换")?;
    if key.is_encrypted() {
        let pass = passphrase.context("私钥已加密但未提供口令")?;
        key = key.decrypt(pass)?;
    }
    Ok(key)
}

/// connect_stream 失败的统一处理：未知主机密钥（check_server_key 返回 false）→
/// 转成 HostKeyApprovalRequired（russh 来源标记，确认时用 russh 重建）；其余错误透传。
fn map_connect_error(
    err: HandlerError,
    unknown_fingerprint: &Arc<Mutex<Option<String>>>,
    config: &SshConfig,
) -> anyhow::Error {
    if let Some(fp) = unknown_fingerprint.lock().unwrap().take() {
        return require_approval_russh(config.clone(), fp);
    }
    map_russh_error(err.0)
}

/// 把 russh 库错误映射为用户可读文案（表述习惯对齐终端页 ssh2 错误）。
/// 未覆盖的变体回落到原始错误串。
pub(crate) fn describe_russh_error(e: &russh::Error) -> String {
    use russh::Error as E;
    match e {
        E::ConnectionTimeout => "SSH 连接超时".into(),
        E::KeepaliveTimeout => "SSH keepalive 超时：服务器长时间无响应，连接已断开".into(),
        E::InactivityTimeout => "SSH 空闲超时断开".into(),
        E::Disconnect | E::HUP => "SSH 连接已被对端关闭".into(),
        E::NotAuthenticated => "SSH 会话未完成认证".into(),
        E::NoAuthMethod | E::UnsupportedAuthMethod => "服务器不支持所选的认证方式".into(),
        E::CouldNotReadKey => "无法解析私钥（可能格式不受支持或口令错误）".into(),
        E::NoCommonAlgo { .. } => "与服务器没有共同支持的 SSH 算法".into(),
        E::UnknownAlgo => "协商了未知的 SSH 算法".into(),
        E::KexInit | E::Kex => "SSH 密钥交换失败".into(),
        E::Version => "对端不是 SSH 服务器或协议版本不受支持".into(),
        E::PacketAuth | E::DecryptionError => "SSH 数据包校验失败（连接可能已被破坏）".into(),
        E::WrongServerSig => "服务器主机密钥签名校验失败".into(),
        E::KeyChanged { .. } => "服务器主机密钥已变更".into(),
        E::ChannelOpenFailure(_) => "服务器拒绝了通道打开请求".into(),
        E::SendError => "SSH 会话已关闭，无法发送数据".into(),
        E::IO(io) => return io.to_string(),
        other => other.to_string(),
    }
}

/// 认证路径的 russh 错误统一翻译（anyhow 链中 downcast russh::Error）。
pub(crate) fn map_russh_error(err: anyhow::Error) -> anyhow::Error {
    if let Some(re) = err.downcast_ref::<russh::Error>() {
        anyhow::anyhow!(describe_russh_error(re))
    } else {
        err
    }
}
