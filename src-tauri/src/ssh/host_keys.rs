//! 主机密钥信任与确认链路（ssh2 / russh 两后端共用）。
//!
//! 信任源为 SQLite（`known_host_key_entries`），非系统 `~/.ssh/known_hosts`。
//! 校验语义对齐 OpenSSH：按「(主机, 密钥算法)」独立记录与比对——ssh2(libssh2)
//! 与 russh 对持有多把 host key 的服务器可能协商出不同算法的公钥，per-type
//! 才能让两边各自确认、互不干扰。指纹统一从 OpenSSH wire blob 计算
//! （`SHA256:` + base64_nopad），两后端输出逐字节一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Result};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use ssh2::{HashType, HostKeyType, Session};

use crate::ssh::session::{establish_transport, SshConfig};
use crate::utils::sqlite;

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
    /// 记录待确认来源后端：确认时用同一后端重建连接。
    /// ssh2 与 russh 协商的主机密钥算法可能不同（服务器持有多把 host key 时），
    /// 跨后端重建会导致指纹必然不一致（第一次连接算的 expected ≠ 重建的 got）。
    backend: PendingBackend,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PendingBackend {
    Ssh2,
    Russh,
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
fn register_pending_host_key(config: SshConfig, backend: PendingBackend) -> String {
    let token = new_host_key_token();
    pending_host_keys()
        .lock()
        .unwrap()
        .insert(token.clone(), PendingHostKey { config, backend });
    token
}

/// 取回（并移除）某 token 对应的待确认主机配置与来源后端。
fn take_pending_host_key(token: &str) -> Option<(SshConfig, PendingBackend)> {
    pending_host_keys()
        .lock()
        .unwrap()
        .remove(token)
        .map(|e| (e.config, e.backend))
}

/// 记录待确认主机并返回 HostKeyApprovalRequired（ssh2 路径：SSH/SFTP 等）。
pub(crate) fn require_approval(config: SshConfig, fingerprint: String) -> anyhow::Error {
    require_approval_backend(config, fingerprint, PendingBackend::Ssh2)
}

/// russh 路径的待确认记录：确认时用 russh 重建连接，
/// 保证 expected 指纹与首次连接协商到的是同一把主机密钥。
pub(crate) fn require_approval_russh(config: SshConfig, fingerprint: String) -> anyhow::Error {
    require_approval_backend(config, fingerprint, PendingBackend::Russh)
}

fn require_approval_backend(
    config: SshConfig,
    fingerprint: String,
    backend: PendingBackend,
) -> anyhow::Error {
    let token = register_pending_host_key(config.clone(), backend);
    HostKeyApprovalRequired {
        fingerprint,
        host: config.host,
        port: config.port,
        token,
    }
    .into()
}

/// 校验主机密钥（ssh2 会话侧入口）：匹配放行，未知返回指纹（不自动写入），
/// 同类型密钥不一致 / 校验失败拒绝。
pub(crate) fn verify_host_key(session: &Session, host: &str, port: u16) -> Result<HostKeyCheck> {
    let Some((key, host_key_type)) = session.host_key() else {
        bail!("Host key unavailable after handshake");
    };
    let type_name = host_key_type_name(host_key_type)?;
    check_known_host_entry(host, port, type_name, key)
}

/// 主机密钥 DB 校验（两个后端共用的语义与实现）：
/// 按「(主机, 密钥算法)」独立判断，而非同主机任意条目。
///
/// 为什么必须 per-type：ssh2(libssh2) 与 russh 协商主机密钥的算法偏好不同，
/// 对持有多把 host key（RSA + ed25519 + …）的服务器，两边可能各自拿到不同算法
/// 的公钥。若按同主机任意条目比对，一边确认后另一边必报 Mismatch（互踢）。
/// OpenSSH 的 known_hosts 本就是多算法条目并存，此处对齐该语义：
/// - 同类型有记录且 blob 一致 → Matched；
/// - 同类型无记录 → Unknown（走确认流程，确认后按类型追加记录，互不影响）；
/// - 同类型有记录但 blob 不一致 → Mismatch（主机变更 / 中间人，拒绝）。
pub(crate) fn check_known_host_entry(
    host: &str,
    port: u16,
    key_type_name: &str,
    key_blob: &[u8],
) -> Result<HostKeyCheck> {
    // 非 22 端口按 OpenSSH 的 [host]:port 记录（与 accept_host_key 写入规则一致）
    let check_host = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };

    let mut has_entry = false;
    for (entry_host, entry_type, key_data) in
        sqlite::known_host_key_entries().map_err(|e| anyhow::anyhow!(e))?
    {
        if entry_host != check_host || entry_type != key_type_name {
            continue;
        }
        has_entry = true;
        // OpenSSH wire blob 首字段即算法名，blob 相等 ⇔ 主机密钥完全一致
        if STANDARD
            .decode(&key_data)
            .map(|blob| blob == key_blob)
            .unwrap_or(false)
        {
            return Ok(HostKeyCheck::Matched);
        }
    }

    if has_entry {
        bail!(
            "Host key mismatch for {host}:{port} — the host may have changed or this could be a man-in-the-middle attack"
        );
    }
    Ok(HostKeyCheck::Unknown {
        fingerprint: fingerprint_from_blob(key_blob),
    })
}

/// 前端确认后调用：凭 token 从内存取回待确认主机的完整配置，用与首次连接
/// 相同的后端重建连接、校验指纹一致后，把主机密钥按算法写入 DB。
/// 密钥/证书内容不经 IPC 往返。
pub fn accept_host_key(token: &str, expected_fingerprint: &str, timeout_secs: u32) -> Result<()> {
    let timeout_secs = timeout_secs.max(1);
    // 取回（并移除）待确认配置；过期/不存在则报错，前端需重新连接重新生成
    let (config, backend) = take_pending_host_key(token)
        .ok_or_else(|| anyhow::anyhow!("主机密钥确认已过期或不存在，请重新连接"))?;

    match backend {
        PendingBackend::Ssh2 => accept_host_key_ssh2(&config, expected_fingerprint, timeout_secs),
        // russh 首次连接弹出的确认必须用 russh 重建：两库协商的 host key
        // 算法可能不同，跨后端重建必然指纹不一致
        PendingBackend::Russh => {
            // ⚠️ 本命令是 sync command（不在 tokio worker 上），正常路径
            // try_current 为 Err → tauri block_on 安全。若未来有人把它改成
            // async command 或从 runtime 内调用，block_on 会 panic（与
            // RusshTunnel::stop 同款），故用 block_in_place 防御性兜底——
            // 它把当前 worker 线程让渡出去，允许在 runtime 内安全阻塞等待。
            match tokio::runtime::Handle::try_current() {
                Err(_) => tauri::async_runtime::block_on(
                    crate::ssh::russh_backend::verify_and_learn_host_key(
                        &config,
                        expected_fingerprint,
                        timeout_secs,
                    ),
                ),
                Ok(rt) => tokio::task::block_in_place(|| {
                    rt.block_on(crate::ssh::russh_backend::verify_and_learn_host_key(
                        &config,
                        expected_fingerprint,
                        timeout_secs,
                    ))
                }),
            }
        }
    }
}

/// ssh2 路径的确认：重建连接 → 指纹比对 → 按算法写 DB。
fn accept_host_key_ssh2(
    config: &SshConfig,
    expected_fingerprint: &str,
    timeout_secs: u32,
) -> Result<()> {
    // 经跳板机（或直连）重建到目标主机的 TCP 连接；跳板机传输层随函数作用域存活
    let (tcp, _jump) = establish_transport(config, timeout_secs, &|_, _| {})?;

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    session.set_timeout(timeout_secs.saturating_mul(1000));
    session.handshake()?;

    let actual_fingerprint = host_key_fingerprint(&session);
    if actual_fingerprint != expected_fingerprint {
        bail!(
            "Host key fingerprint mismatch: expected {}, got {}",
            expected_fingerprint,
            actual_fingerprint
        );
    }

    let Some((key, host_key_type)) = session.host_key() else {
        bail!("Host key unavailable after handshake");
    };
    let key_type_name = host_key_type_name(host_key_type)?;

    // 信任写入 DB；非 22 端口按 OpenSSH 的 [host]:port 记录
    let add_host = if config.port == 22 {
        config.host.clone()
    } else {
        format!("[{}]:{}", config.host, config.port)
    };
    sqlite::insert_known_host(&add_host, key_type_name, &STANDARD.encode(key))
        .map_err(|e| anyhow::anyhow!(e))?;

    Ok(())
}

/// libssh2 HostKeyType → OpenSSH 算法名（DB 记录用）。
fn host_key_type_name(host_key_type: HostKeyType) -> Result<&'static str> {
    Ok(match host_key_type {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => bail!("Unsupported host key type"),
    })
}

/// 计算 OpenSSH 风格的 SHA256 主机密钥指纹（ssh2 会话侧）。
fn host_key_fingerprint(session: &Session) -> String {
    session
        .host_key_hash(HashType::Sha256)
        .map(|hash| format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
        .unwrap_or_else(|| "SHA256:unknown".to_string())
}

/// 对 OpenSSH wire blob 计算 SHA256 指纹（"SHA256:" + base64_nopad）。
/// russh 后端用它保证与 ssh2 侧输出格式逐字节一致。
pub(crate) fn fingerprint_from_blob(blob: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(blob)))
}
