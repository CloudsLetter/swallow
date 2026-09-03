use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::ssh::session::{require_approval, verify_host_key, HostKeyCheck, SshConfig, userauth_pubkey_from_content};

/// 单文件整体传输大小上限（字节）：整文件内存传输的保护线（分块传输不受此限制）。
const MAX_FILE_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;

/// 分块传输的块大小（字节）。
const TRANSFER_CHUNK_BYTES: usize = 1024 * 1024;

/// FTP 控制连接池的空闲连接上限：连接数软上限，覆盖「浏览目录 + 一个长传输」的典型并发。
/// 并发峰值可临时超出（超出部分用完即弃），避免阻塞等待。
const FTP_POOL_MAX_CONNS: usize = 4;

/// 为 TCP 流启用 keepalive（尽力而为，失败不阻断连接）：
/// 空闲后服务器/中间设备静默断开时（半开连接），系统在 keepalive 周期内探测到对端不可达，
/// 后续读写立即失败，避免 readdir 等操作挂满整个 I/O 超时。
fn enable_tcp_keepalive(tcp: &TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let socket = SockRef::from(tcp);
    if socket.set_keepalive(true).is_ok() {
        let _ = socket.set_tcp_keepalive(&TcpKeepalive::new().with_time(Duration::from_secs(30)));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_protocol")]
    pub protocol: String, // "ftp" or "sftp"
    pub auth_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    /// 密钥库密钥 ID：连接时由后端按 ID 读取密钥内容填充 private_key/public_key
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub private_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub public_key: Option<String>,
}

fn default_protocol() -> String {
    "sftp".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileType {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "directory")]
    Directory,
    #[serde(rename = "symlink")]
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileItem {
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: FileType,
    pub size: u64,
    pub modified: String,
    pub permissions: String,
}

/// 解析 FTP `LIST` 命令的一行输出为 `FileItem`（纯函数，便于单元测试）。
/// 按行拆分并解码 FTP 数据：优先 UTF-8，失败回退 GB18030（兼容 GBK 中文文件名的
/// 老式服务器，如 NAS/SmbFTPD——UTF-8 解析会把这些字节变乱码）。
fn decode_ftp_lines(raw: &[u8]) -> Vec<String> {
    raw.split(|b| *b == b'\n')
        .filter_map(|line_bytes| {
            let mut line = line_bytes;
            while line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if line.is_empty() {
                return None;
            }
            Some(match std::str::from_utf8(line) {
                Ok(s) => s.to_string(),
                Err(_) => encoding_rs::GB18030.decode(line).0.into_owned(),
            })
        })
        .collect()
}

/// 走 raw 数据通道执行一个目录数据命令（LIST/MLSD/NLST），返回解码后的行。
/// custom_data_command 拿原始字节：绕开 suppaftp 高层读取的 lossy；收尾读 226。
fn raw_ftp_lines(
    ftp: &mut suppaftp::FtpStream,
    cmd: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    use std::io::Read;
    let (_, mut data_stream) = ftp
        .custom_data_command(cmd, &[suppaftp::Status::AboutToSend])
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
    let mut raw: Vec<u8> = Vec::new();
    data_stream
        .read_to_end(&mut raw)
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
    ftp.close_data_connection(data_stream)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
    Ok(decode_ftp_lines(&raw))
}

/// 目录排序：目录在前、其余按名字。
fn sort_dir_items(files: &mut [FileItem]) {
    files.sort_by(|a, b| {
        use std::cmp::Ordering;
        match (&a.file_type, &b.file_type) {
            (FileType::Directory, FileType::Directory) => a.name.cmp(&b.name),
            (FileType::Directory, _) => Ordering::Less,
            (_, FileType::Directory) => Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });
}

/// 解析 MLSD（RFC 3659）一行：`type=dir;size=…;modify=…; name`。
/// 名字在首个空格之后（可含空格）；文件名可能被 URL 转义（%XX），保持原样显示。
fn parse_mlsd_entry(line: &str) -> Option<FileItem> {
    let sp = line.find(' ')?;
    let facts = &line[..sp];
    let name = line[sp + 1..].trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mut size: u64 = 0;
    let mut file_type = FileType::File;
    for seg in facts.split(';') {
        if let Some(v) = seg.strip_prefix("size=") {
            if let Ok(s) = v.parse() {
                size = s;
            }
        } else if let Some(v) = seg.strip_prefix("type=") {
            file_type = match v {
                "dir" | "cdir" | "pdir" => FileType::Directory,
                s if s.contains("slink") || s.contains("symlink") => FileType::Symlink,
                _ => FileType::File,
            };
        }
    }
    Some(FileItem {
        name: name.to_string(),
        file_type,
        size,
        modified: String::new(),
        permissions: String::new(),
    })
}

/// NLST 兜底：只有名字，无法区分目录/文件（类型按文件处理，进目录会再报错提示）。
fn parse_nlst_entry(name: &str) -> Option<FileItem> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some(FileItem {
        name: name.to_string(),
        file_type: FileType::File,
        size: 0,
        modified: String::new(),
        permissions: String::new(),
    })
}

/// 标准 Unix 格式：`drwxr-xr-x   5 user  group       170 Dec 16 10:00 dirname`。
/// 文件名可能含空格（取第 9 列及之后）；行格式不完整（<9 列）返回 None（跳过）。
fn parse_ftp_list_entry(entry: &str) -> Option<FileItem> {
    let parts: Vec<&str> = entry.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }

    let permissions = parts[0];
    let is_dir = permissions.starts_with('d');
    let is_link = permissions.starts_with('l');

    // 文件名可能包含空格，所以取第 9 列之后的所有部分
    let name = parts[8..].join(" ");

    let file_type = if is_dir {
        FileType::Directory
    } else if is_link {
        FileType::Symlink
    } else {
        FileType::File
    };

    // 尝试解析大小（第 5 列），非数字回退为 0
    let size = parts
        .get(4)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    // 组合日期和时间（第 6、7、8 列）
    let modified = format!(
        "{} {} {}",
        parts.get(5).unwrap_or(&"-"),
        parts.get(6).unwrap_or(&"-"),
        parts.get(7).unwrap_or(&"-")
    );

    Some(FileItem {
        name,
        file_type,
        size,
        modified,
        permissions: permissions.to_string(),
    })
}

/// FTP 控制连接池：解决 suppaftp 单连接模型下，长传输（流式下载）独占唯一控制连接、
/// 导致同会话的 list/删除/重命名等操作全部阻塞的问题。
///
/// 每个操作经 `with_conn` 借用一个空闲连接（无空闲则新建），用完归还；连接失效则丢弃重建。
/// 复用前以 `noop()` 探活，规避服务器静默断开后的半开连接。所有文件操作均使用绝对路径，
/// 因此连接复用时 cwd 状态残留不影响正确性（仅 `list_dir` 依赖 cwd，用前自行 `cwd` 切换）。
/// 上传进度读取器：包装本地文件 reader，每次 read 推进 done 并回调 `(done, total)`。
/// suppaftp 的 `put_file` 无原生进度钩子，用它包一层在 FTP 上传时也能逐块回报进度；
/// 同时检查 `cancel` 标志（置位即返回 Interrupted），补上 FTP 单数据连接无法中断的短板。
struct ProgressReader<'a, R: std::io::Read, F: FnMut(u64, u64)> {
    inner: R,
    done: u64,
    total: u64,
    on_progress: F,
    cancel: Option<&'a std::sync::atomic::AtomicBool>,
}

impl<R: std::io::Read, F: FnMut(u64, u64)> std::io::Read for ProgressReader<'_, R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::sync::atomic::Ordering;
        if self.cancel.map_or(false, |c| c.load(Ordering::Relaxed)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfer cancelled",
            ));
        }
        let n = self.inner.read(buf)?;
        if n == 0 {
            // EOF：补发一帧完成进度（覆盖 0 字节文件与恰好整块读尽的 final 帧）
            (self.on_progress)(self.done, self.total);
        } else {
            self.done += n as u64;
            (self.on_progress)(self.done, self.total);
        }
        Ok(n)
    }
}

struct FtpPool {
    idle: std::sync::Mutex<Vec<suppaftp::FtpStream>>,
    host: String,
    port: u16,
    username: String,
    password: String,
    timeout_secs: u32,
    /// 当前池内连接总数（含借出未还），用于归还时判断是否超上限
    total: AtomicUsize,
    /// MLSD 能力缓存：None=未知 / Some(true)=支持 / Some(false)=不支持（直接跳过 MLSD）
    mlsd_ok: std::sync::Mutex<Option<bool>>,
}

/// 借出的 FTP 连接守卫：`Drop` 时归还或丢弃。
struct FtpConn<'a> {
    stream: Option<suppaftp::FtpStream>,
    pool: &'a FtpPool,
    dirty: bool,
}

impl<'a> FtpConn<'a> {
    fn stream(&mut self) -> &mut suppaftp::FtpStream {
        self.stream.as_mut().expect("FtpConn already released")
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
    }
}

impl<'a> Drop for FtpConn<'a> {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.take() {
            self.pool.release(stream, self.dirty);
        }
    }
}

impl FtpPool {
    fn new(
        host: String,
        port: u16,
        username: String,
        password: String,
        timeout_secs: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pool = FtpPool {
            idle: std::sync::Mutex::new(Vec::new()),
            host,
            port,
            username,
            password,
            timeout_secs: timeout_secs.max(1),
            total: AtomicUsize::new(0),
            mlsd_ok: std::sync::Mutex::new(None),
        };
        // 预热首个连接：连接失败立即报错，保持「连接即验证凭据」的语义
        let conn = pool.connect_stream()?;
        pool.total.fetch_add(1, Ordering::Relaxed);
        pool.idle.lock().unwrap().push(conn);
        Ok(pool)
    }

    /// 建立并登录一个新的 FTP 控制连接。
    fn connect_stream(
        &self,
    ) -> Result<suppaftp::FtpStream, Box<dyn std::error::Error + Send + Sync>> {
        let addr = format!("{}:{}", self.host, self.port);
        let sock_addr = addr
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| format!("Failed to resolve FTP host: {addr}"))?;

        // 预建 TCP 流并设置读写超时：服务器无响应时连接/登录/命令响应有界，
        // 不会永久挂起拖慢整个应用（suppaftp 内部新建的流无法单独设置超时）。
        let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(self.timeout_secs as u64))?;
        tcp.set_nodelay(true)?;
        enable_tcp_keepalive(&tcp);
        // 命令交互阶段超时收紧到最多 15 秒：半开连接时 LIST/PWD 等不会挂满连接超时
        let io_timeout = Duration::from_secs(self.timeout_secs.min(15) as u64);
        tcp.set_read_timeout(Some(io_timeout))?;
        tcp.set_write_timeout(Some(io_timeout))?;
        let mut ftp_stream = suppaftp::FtpStream::connect_with_stream(tcp)?;
        ftp_stream.login(&self.username, &self.password)?;
        // 开启 UTF8 模式（RFC 2640）：否则服务器默认按本地码页（GBK）收发，中文路径
        // 会 550 / 列表字节非 UTF-8。不支持此命令的老服务器忽略即可（调用方已有兜底解码）。
        let _ = ftp_stream.opts("UTF8", Some("ON"));
        Ok(ftp_stream)
    }

    /// 借出一个连接：优先复用空闲（探活失败丢弃重建），无空闲则新建。
    fn acquire(&self) -> Result<FtpConn<'_>, Box<dyn std::error::Error + Send + Sync>> {
        loop {
            let candidate = self.idle.lock().unwrap().pop();
            match candidate {
                Some(mut conn) => {
                    if conn.noop().is_ok() {
                        return Ok(FtpConn {
                            stream: Some(conn),
                            pool: self,
                            dirty: false,
                        });
                    }
                    // 探活失败：半开连接，直接丢弃（不再归还）
                    self.total.fetch_sub(1, Ordering::Relaxed);
                }
                None => break,
            }
        }
        let conn = self.connect_stream()?;
        self.total.fetch_add(1, Ordering::Relaxed);
        Ok(FtpConn {
            stream: Some(conn),
            pool: self,
            dirty: false,
        })
    }

    /// 归还连接：干净连接入空闲池（超上限则丢弃）；脏连接直接丢弃。
    fn release(&self, stream: suppaftp::FtpStream, dirty: bool) {
        if dirty {
            self.total.fetch_sub(1, Ordering::Relaxed);
            return;
        }
        let mut idle = self.idle.lock().unwrap();
        if idle.len() < FTP_POOL_MAX_CONNS {
            idle.push(stream);
        } else {
            self.total.fetch_sub(1, Ordering::Relaxed);
        }
    }

    /// 借出连接执行 `f`，操作失败则标记连接为脏（丢弃而非归还），下次自动重建。
    fn with_conn<T, F>(&self, f: F) -> Result<T, Box<dyn std::error::Error + Send + Sync>>
    where
        F: FnOnce(&mut suppaftp::FtpStream) -> Result<T, Box<dyn std::error::Error + Send + Sync>>,
    {
        let mut conn = self.acquire()?;
        let result = f(conn.stream());
        if result.is_err() {
            conn.mark_dirty();
        }
        result
    }
}

enum SessionType {
    Ftp(FtpPool),
    Sftp {
        _tcp: TcpStream,
        _session: Arc<Session>,
        sftp: Sftp,
    },
}

pub struct SftpSession {
    session_type: SessionType,
    /// SFTP 会话的应用层 keepalive 线程停止标志（FTP 会话为 None）
    keepalive_stop: Option<Arc<AtomicBool>>,
}

impl Drop for SftpSession {
    fn drop(&mut self) {
        // 会话销毁时通知 keepalive 线程退出，避免线程泄漏
        if let Some(stop) = &self.keepalive_stop {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

impl SftpSession {
    pub fn connect(
        config: SftpConfig,
        timeout_secs: u32,
        keep_alive_interval: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        match config.protocol.as_str() {
            "ftp" => Self::connect_ftp(config, timeout_secs),
            "sftp" => Self::connect_sftp(config, timeout_secs, keep_alive_interval),
            _ => Err(format!("Unsupported protocol: {}", config.protocol).into()),
        }
    }

    fn connect_ftp(
        config: SftpConfig,
        timeout_secs: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let password = config
            .password
            .ok_or_else(|| "Password required for FTP authentication".to_string())?;
        let pool = FtpPool::new(
            config.host,
            config.port,
            config.username,
            password,
            timeout_secs,
        )?;
        Ok(Self {
            session_type: SessionType::Ftp(pool),
            keepalive_stop: None,
        })
    }

    fn connect_sftp(
        config: SftpConfig,
        timeout_secs: u32,
        keep_alive_interval: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let timeout_secs = timeout_secs.max(1);

        // 建立 TCP 连接
        let addr = format!("{}:{}", config.host, config.port);
        let sock_addr = addr
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| format!("Failed to resolve SFTP host: {addr}"))?;
        let tcp =
            TcpStream::connect_timeout(&sock_addr, Duration::from_secs(timeout_secs as u64))?;
        tcp.set_nodelay(true)?;
        // TCP keepalive：半开连接（服务器静默断开）在 keepalive 周期内被系统探测，
        // 后续读写立即失败而非挂满 I/O 超时。
        enable_tcp_keepalive(&tcp);

        // 创建 SSH 会话
        let mut session = Session::new()?;
        session.set_tcp_stream(tcp.try_clone()?);
        // 建立阶段（握手/主机密钥/认证）使用完整连接超时
        session.set_timeout(timeout_secs.saturating_mul(1000));
        session.handshake()?;

        // 与 SSH 终端一致：匹配放行；未知密钥交由前端确认后写入 known_hosts
        match verify_host_key(&session, &config.host, config.port)? {
            HostKeyCheck::Matched => {}
            HostKeyCheck::Unknown { fingerprint } => {
                // SFTP 不支持跳板机，待确认主机总是直连；构造仅含 host/port 的 SshConfig
                // 注册待确认（accept_host_key 重建连接只做握手拿指纹，不认证）
                let ssh_config = SshConfig {
                    host: config.host.clone(),
                    port: config.port,
                    username: String::new(),
                    auth_type: String::new(),
                    password: None,
                    key_path: None,
                    cert_path: None,
                    passphrase: None,
                    key_id: None,
                    private_key: None,
                    public_key: None,
                    cert_id: None,
                    cert_content: None,
                    cert_private_key: None,
                    proxy: None,
                };
                return Err(require_approval(ssh_config, fingerprint).into());
            }
        }

        // 认证
        match config.auth_type.as_str() {
            "password" => {
                if let Some(password) = config.password {
                    session.userauth_password(&config.username, &password)?;
                } else {
                    return Err("Password required for password authentication".into());
                }
            }
            "publickey" => {
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
                    let passphrase = config.passphrase.as_deref();
                    session.userauth_pubkey_file(
                        &config.username,
                        None,
                        Path::new(&key_path),
                        passphrase,
                    )?;
                } else {
                    return Err("Key path required for public key authentication".into());
                }
            }
            _ => return Err("Unsupported authentication type".into()),
        }

        if !session.authenticated() {
            return Err("Authentication failed".into());
        }

        // 交互阶段：I/O 超时收紧到最多 15 秒（半开连接/服务器无响应时读目录不会挂满连接超时）。
        // ⚠️ 但不能小于传输需求：大文件分块上传在慢链路上单块（open+写+等 ack）可能远超 15s，
        // 会触发 libssh2 Session(-9) 超时。折中取 60s：响应检测仍有界，4MB 块低至 ~70KB/s 也不超时。
        let io_timeout_ms = timeout_secs.min(60).saturating_mul(1000);
        session.set_timeout(io_timeout_ms);

        // 打开 SFTP 通道
        let sftp = session.sftp()?;

        // 包装为 Arc 供 keepalive 线程共享（ssh2::Session 线程安全，内部有锁）
        let session_arc = Arc::new(session);

        // 应用层 keepalive 线程：按配置间隔发送 SSH keepalive 包，保住 NAT/防火墙映射，
        // 避免空闲一段时间后连接被静默掐断（否则下次刷新/操作要等 I/O 超时才发现连接已死）。
        let keepalive_stop = Arc::new(AtomicBool::new(false));
        if keep_alive_interval > 0 {
            let ka_session = session_arc.clone();
            let ka_stop = keepalive_stop.clone();
            thread::spawn(move || {
                let mut last = std::time::Instant::now();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    if ka_stop.load(Ordering::Relaxed) {
                        break;
                    }
                    if last.elapsed() >= Duration::from_secs(keep_alive_interval as u64) {
                        // keepalive 失败说明连接已死：静默忽略，后续操作会立即失败（TCP keepalive 兜底）
                        let _ = ka_session.keepalive_send();
                        last = std::time::Instant::now();
                    }
                }
            });
        }

        Ok(Self {
            session_type: SessionType::Sftp {
                _tcp: tcp,
                _session: session_arc,
                sftp,
            },
            keepalive_stop: Some(keepalive_stop),
        })
    }

    pub fn list_dir(&self, path: &str) -> Result<Vec<FileItem>, Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => self.list_dir_ftp(pool, path),
            SessionType::Sftp { sftp, .. } => self.list_dir_sftp(sftp, path),
        }
    }

    fn list_dir_ftp(
        &self,
        pool: &FtpPool,
        path: &str,
    ) -> Result<Vec<FileItem>, Box<dyn std::error::Error + Send + Sync>> {
        pool.with_conn(|ftp_stream| {
            // 切换到目标目录（列表命令需先 CWD；其余操作走绝对路径，不受 cwd 残留影响）
            let current_dir = ftp_stream.pwd()?;
            if path != current_dir {
                ftp_stream.cwd(path)?;
            }

            // 标准协商链：MLSD（结构化最稳）→ LIST（Unix 行，raw 字节 + GBK 兜底）→ NLST（仅名兜底）。
            // MLSD 结果缓存到连接池（一次失败后不再尝试）；LIST/NLST 都走 raw 数据通道，
            // 绕开 suppaftp 高层读取的 lossy，文件名不被破坏。
            let mlsd_cached = *pool.mlsd_ok.lock().unwrap();
            if mlsd_cached != Some(false) {
                match raw_ftp_lines(ftp_stream, "MLSD") {
                    Ok(lines) => {
                        *pool.mlsd_ok.lock().unwrap() = Some(true);
                        let mut files: Vec<FileItem> = lines
                            .iter()
                            .filter_map(|line| parse_mlsd_entry(line))
                            .collect();
                        sort_dir_items(&mut files);
                        return Ok(files);
                    }
                    Err(_) => {
                        // 服务器不支持 MLSD（命令未实现等）：缓存后走 LIST
                        *pool.mlsd_ok.lock().unwrap() = Some(false);
                    }
                }
            }

            match raw_ftp_lines(ftp_stream, "LIST") {
                Ok(lines) => {
                    let mut files: Vec<FileItem> = lines
                        .iter()
                        .filter_map(|line| parse_ftp_list_entry(line))
                        .collect();
                    sort_dir_items(&mut files);
                    Ok(files)
                }
                Err(_) => {
                    // LIST 异常（极老服务器）：NLST 仅拿名字兜底，类型按文件处理
                    let lines = raw_ftp_lines(ftp_stream, "NLST")?;
                    let mut files: Vec<FileItem> = lines
                        .iter()
                        .filter_map(|name| parse_nlst_entry(name))
                        .collect();
                    sort_dir_items(&mut files);
                    Ok(files)
                }
            }
        })
    }

    fn list_dir_sftp(
        &self,
        sftp: &Sftp,
        path: &str,
    ) -> Result<Vec<FileItem>, Box<dyn std::error::Error + Send + Sync>> {
        let dir_path = Path::new(path);
        let entries = sftp.readdir(dir_path)?;

        let mut files = Vec::new();
        for (path, stat) in entries {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let file_type = if stat.is_dir() {
                FileType::Directory
            } else if stat.file_type().is_symlink() {
                FileType::Symlink
            } else {
                FileType::File
            };

            let size = stat.size.unwrap_or(0);

            let modified = if let Some(mtime) = stat.mtime {
                use chrono::DateTime;
                let datetime = DateTime::from_timestamp(mtime as i64, 0)
                    .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
                datetime.format("%Y-%m-%d %H:%M:%S").to_string()
            } else {
                "-".to_string()
            };

            let permissions = if let Some(perm) = stat.perm {
                format!("{:o}", perm & 0o777)
            } else {
                "-".to_string()
            };

            files.push(FileItem {
                name,
                file_type,
                size,
                modified,
                permissions,
            });
        }

        files.sort_by(|a, b| {
            use std::cmp::Ordering;
            match (&a.file_type, &b.file_type) {
                (FileType::Directory, FileType::Directory) => a.name.cmp(&b.name),
                (FileType::Directory, _) => Ordering::Less,
                (_, FileType::Directory) => Ordering::Greater,
                _ => a.name.cmp(&b.name),
            }
        });

        Ok(files)
    }

    pub fn download_file(&self, remote_path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                // SIZE 命令并非所有 FTP 服务器都支持，失败时不阻塞下载
                if let Ok(size) = ftp_stream.size(remote_path) {
                    if size as u64 > MAX_FILE_TRANSFER_BYTES {
                        return Err(format!(
                            "File too large to download ({} bytes, limit {})",
                            size, MAX_FILE_TRANSFER_BYTES
                        )
                        .into());
                    }
                }
                let cursor = ftp_stream.retr_as_buffer(remote_path)?;
                Ok(cursor.into_inner())
            }),
            SessionType::Sftp { sftp, .. } => {
                let stat = sftp.stat(Path::new(remote_path))?;
                if let Some(size) = stat.size {
                    if size > MAX_FILE_TRANSFER_BYTES {
                        return Err(format!(
                            "File too large to download ({} bytes, limit {})",
                            size, MAX_FILE_TRANSFER_BYTES
                        )
                        .into());
                    }
                }
                let mut remote_file = sftp.open(Path::new(remote_path))?;
                let mut buffer = Vec::new();
                remote_file.read_to_end(&mut buffer)?;
                Ok(buffer)
            }
        }
    }

    pub fn upload_file(
        &self,
        local_data: &[u8],
        remote_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use std::io::Write;

        if local_data.len() as u64 > MAX_FILE_TRANSFER_BYTES {
            return Err(format!(
                "File too large to upload ({} bytes, limit {})",
                local_data.len(),
                MAX_FILE_TRANSFER_BYTES
            )
            .into());
        }

        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                ftp_stream.put_file(remote_path, &mut std::io::Cursor::new(local_data))?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                let mut remote_file = sftp.create(Path::new(remote_path))?;
                remote_file.write_all(local_data)?;
                Ok(())
            }
        }
    }

    pub fn delete_file(&self, remote_path: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                ftp_stream.rm(remote_path)?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                sftp.unlink(Path::new(remote_path))?;
                Ok(())
            }
        }
    }

    pub fn delete_dir(&self, remote_path: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                ftp_stream.rmdir(remote_path)?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                sftp.rmdir(Path::new(remote_path))?;
                Ok(())
            }
        }
    }

    /// 递归删除目录及其所有内容（先删子项，再删空目录）。
    /// 符号链接仅删除链接本身，不跟随进入（避免删除链接目标之外的内容）。
    pub fn remove_dir_recursive(
        &self,
        remote_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => {
                // 复用 list_dir_ftp 递归列出子项；rm/rmdir 用绝对路径，不受连接 cwd 残留影响
                let items = self.list_dir_ftp(pool, remote_path)?;
                for item in &items {
                    // 跳过 . 和 ..，避免无限递归
                    if item.name == "." || item.name == ".." {
                        continue;
                    }
                    let child = format!("{}/{}", remote_path.trim_end_matches('/'), item.name);
                    match item.file_type {
                        FileType::Directory => self.remove_dir_recursive(&child)?,
                        _ => self.delete_file(&child)?,
                    }
                }
                self.delete_dir(remote_path)?;
                Ok(())
            }
            SessionType::Sftp { sftp, .. } => {
                let dir = Path::new(remote_path);
                let entries = sftp.readdir(dir)?;
                for (entry, stat) in entries {
                    if stat.is_dir() {
                        self.remove_dir_recursive(entry.to_str().unwrap_or(""))?;
                    } else {
                        sftp.unlink(&entry)?;
                    }
                }
                sftp.rmdir(dir)?;
                Ok(())
            }
        }
    }

    pub fn create_dir(&self, remote_path: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                ftp_stream.mkdir(remote_path)?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                sftp.mkdir(Path::new(remote_path), 0o755)?;
                Ok(())
            }
        }
    }

    /// 修改远端文件/目录权限（仅 SFTP 支持；FTP 协议无标准 chmod）。
    pub fn chmod(&self, remote_path: &str, mode: u32) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Sftp { sftp, .. } => {
                // ssh2 无直接 chmod，通过 stat + setstat 更新权限位
                let mut stat = sftp.stat(Path::new(remote_path))?;
                stat.perm = Some(mode);
                sftp.setstat(Path::new(remote_path), stat)?;
                Ok(())
            }
            SessionType::Ftp(_) => {
                Err("FTP 协议不支持修改文件权限".into())
            }
        }
    }

    /// 递归搜索远端文件名（大小写不敏感），返回匹配的完整路径列表。
    /// 结果数上限 `max_results` 防止大目录树搜索过慢/内存过大。
    pub fn search_files(
        &self,
        root_path: &str,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut results = Vec::new();
        let q = query.to_lowercase();
        self.search_recursive(root_path, &q, max_results, &mut results)?;
        Ok(results)
    }

    fn search_recursive(
        &self,
        dir: &str,
        query: &str,
        max_results: usize,
        results: &mut Vec<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if results.len() >= max_results {
            return Ok(());
        }
        let entries = self.list_dir(dir)?;
        for entry in entries {
            if results.len() >= max_results {
                break;
            }
            let child = format!("{}/{}", dir.trim_end_matches('/'), entry.name);
            if entry.name.to_lowercase().contains(query) {
                results.push(child.clone());
            }
            if matches!(entry.file_type, FileType::Directory) {
                self.search_recursive(&child, query, max_results, results)?;
            }
        }
        Ok(())
    }

    pub fn rename(
        &self,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                ftp_stream.rename(old_path, new_path)?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                sftp.rename(Path::new(old_path), Path::new(new_path), None)?;
                Ok(())
            }
        }
    }

    /// 分块上传：`truncate=true` 时覆盖创建（首块），否则追加到文件末尾。
    /// 前端按 1MB 分块调用，实现非阻塞传输与进度展示。
    pub fn upload_chunk(
        &self,
        remote_path: &str,
        data: &[u8],
        truncate: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                if truncate {
                    ftp_stream.put_file(remote_path, &mut std::io::Cursor::new(data))?;
                } else {
                    ftp_stream.append_file(remote_path, &mut std::io::Cursor::new(data))?;
                }
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                use ssh2::{OpenFlags, OpenType};
                let mut flags = OpenFlags::WRITE | OpenFlags::CREATE;
                if truncate {
                    flags |= OpenFlags::TRUNCATE;
                }
                let mut remote_file = sftp.open_mode(Path::new(remote_path), flags, 0o644, OpenType::File)?;
                if !truncate {
                    remote_file.seek(SeekFrom::End(0))?;
                }
                remote_file.write_all(data)?;
                Ok(())
            }
        }
    }

    /// 流式上传**本地文件**：后端直读磁盘 → 写远端（SFTP 逐块循环，进度逐块回调）。
    /// 让上传绕开「前端读整文件 → IPC 序列化 → 后端」的高额开销（这是上传远慢于下载
    /// 的根因：下载是后端直写本地，不走 IPC）。FTP 经 `ProgressReader` 包装 `put_file`
    /// 的 reader，逐块回调进度（suppaftp 无原生进度钩子，用 Read 包装补上）。
    /// `cancel` 可选：置位后中断并返回取消错误。
    pub fn upload_local_file<F>(        &self,
        local_path: &str,
        remote_path: &str,
        mut on_progress: F,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    where
        F: FnMut(u64, u64),
    {
        use std::io::Read;
        use std::sync::atomic::Ordering;

        let is_cancelled = || cancel.map_or(false, |c| c.load(Ordering::Relaxed));
        let total = std::fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);

        match &self.session_type {
            SessionType::Sftp { sftp, .. } => {
                use ssh2::{OpenFlags, OpenType};
                let mut remote_file = sftp.open_mode(
                    Path::new(remote_path),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    0o644,
                    OpenType::File,
                )?;
                let mut local = std::fs::File::open(local_path)?;
                let mut buf = vec![0u8; TRANSFER_CHUNK_BYTES];
                let mut done: u64 = 0;
                loop {
                    if is_cancelled() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "Transfer cancelled",
                        )
                        .into());
                    }
                    let n = local.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    remote_file.write_all(&buf[..n])?;
                    done += n as u64;
                    on_progress(done, total);
                }
                on_progress(total, total);
                Ok(())
            }
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                let local = std::fs::File::open(local_path)?;
                let mut reader = ProgressReader {
                    inner: local,
                    done: 0,
                    total,
                    on_progress,
                    cancel,
                };
                ftp_stream.put_file(remote_path, &mut reader)?;
                Ok(())
            }),
        }
    }

    /// 流式下载：分块读取远端文件并写入本地目标路径，每写一块回调一次进度 `(done, total)`。
    /// 不限制文件大小（区别于整读内存接口），SFTP 真实分块；FTP 整读后分块写出（内存受限但进度平滑）。
    /// `cancel` 为可选的取消标志：每块读写前检查，置位后中断并返回取消错误（用于「结束任务」）。
    pub fn stream_download_to<F>(
        &self,
        remote_path: &str,
        target_path: &str,
        offset: u64,
        mut on_progress: F,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    where
        F: FnMut(u64, u64),
    {
        use std::sync::atomic::Ordering;

        // 确保本地目标父目录存在（递归下载目录时，子目录可能尚未创建）
        if let Some(parent) = Path::new(target_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let is_cancelled = || cancel.map_or(false, |c| c.load(Ordering::Relaxed));

        match &self.session_type {
            SessionType::Ftp(pool) => pool.with_conn(|ftp_stream| {
                let total = ftp_stream.size(remote_path).unwrap_or(0) as u64;
                // 断点续传：offset>0 时追加到本地已有文件，否则覆盖创建
                let mut local = if offset > 0 {
                    std::fs::OpenOptions::new().append(true).open(target_path)?
                } else {
                    std::fs::File::create(target_path)?
                };
                let mut done: u64 = offset;
                ftp_stream.retr(remote_path, |stream| {
                    let mut buf = vec![0u8; TRANSFER_CHUNK_BYTES];
                    // 跳过已下载的 offset 字节（网络流不支持 seek，用 take+copy 丢弃）
                    if offset > 0 {
                        let mut limited = (&mut *stream).take(offset);
                        std::io::copy(&mut limited, &mut std::io::sink())
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                    }
                    loop {
                        if is_cancelled() {
                            return Err(suppaftp::FtpError::ConnectionError(std::io::Error::new(
                                std::io::ErrorKind::Interrupted,
                                "Transfer cancelled",
                            )));
                        }
                        let n = stream
                            .read(&mut buf)
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                        if n == 0 {
                            break;
                        }
                        local
                            .write_all(&buf[..n])
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                        done += n as u64;
                        on_progress(done, total);
                    }
                    Ok(())
                })?;
                Ok(())
            }),
            SessionType::Sftp { sftp, .. } => {
                let stat = sftp.stat(Path::new(remote_path))?;
                let total = stat.size.unwrap_or(0);
                let mut remote_file = sftp.open(Path::new(remote_path))?;
                if offset > 0 {
                    remote_file.seek(SeekFrom::Start(offset))?;
                }
                let mut local = if offset > 0 {
                    std::fs::OpenOptions::new().append(true).open(target_path)?
                } else {
                    std::fs::File::create(target_path)?
                };
                let mut buf = vec![0u8; TRANSFER_CHUNK_BYTES];
                let mut done: u64 = offset;
                loop {
                    if is_cancelled() {
                        return Err("Transfer cancelled".into());
                    }
                    let n = remote_file.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    local.write_all(&buf[..n])?;
                    done += n as u64;
                    on_progress(done, total);
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_ftp_list_entry, FileType};

    #[test]
    fn parse_directory_entry() {
        let item = parse_ftp_list_entry("drwxr-xr-x   5 user  group       170 Dec 16 10:00 dirname")
            .expect("应解析成功");
        assert_eq!(item.name, "dirname");
        assert!(matches!(item.file_type, FileType::Directory));
        assert_eq!(item.size, 170);
        assert_eq!(item.modified, "Dec 16 10:00");
    }

    #[test]
    fn parse_regular_file() {
        let item = parse_ftp_list_entry("-rw-r--r--   1 user  group      1024 Dec 16 10:00 file.txt")
            .expect("应解析成功");
        assert_eq!(item.name, "file.txt");
        assert!(matches!(item.file_type, FileType::File));
        assert_eq!(item.size, 1024);
    }

    #[test]
    fn parse_symlink() {
        let item = parse_ftp_list_entry("lrwxrwxrwx   1 user  group        12 Dec 16 10:00 link -> target")
            .expect("应解析成功");
        assert!(matches!(item.file_type, FileType::Symlink));
        assert!(item.name.starts_with("link"), "符号链接名应以 link 开头: {}", item.name);
    }

    #[test]
    fn parse_name_with_spaces() {
        let item = parse_ftp_list_entry("-rw-r--r--   1 user  group      1024 Dec 16 10:00 my file.txt")
            .expect("应解析成功");
        assert_eq!(item.name, "my file.txt");
    }

    #[test]
    fn parse_incomplete_line_returns_none() {
        assert!(parse_ftp_list_entry("total 123").is_none());
        assert!(parse_ftp_list_entry("").is_none());
    }

    #[test]
    fn parse_non_numeric_size_falls_back_to_zero() {
        let item = parse_ftp_list_entry("-rw-r--r--   1 user  group       abc Dec 16 10:00 x")
            .expect("应解析成功");
        assert_eq!(item.size, 0);
    }
}
