use anyhow::{Context, Result};
use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::ssh::session::{JumpTransport, SshConfig, SshSession};

/// 单次采集命令：一条命令分节输出（==NAME== 标记），减少 SSH 往返。
/// 依赖 Linux `/proc` 与常见 coreutils（ps/ss/awk/sort/uniq/df/tail/grep），跨发行版稳定。
const COLLECT_CMD: &str = r#"
echo '==HOST=='; cat /proc/sys/kernel/hostname 2>/dev/null
echo '==KERNEL=='; uname -sr 2>/dev/null || cat /proc/sys/kernel/osrelease 2>/dev/null
echo '==ARCH=='; uname -m 2>/dev/null
echo '==UPTIME=='; cat /proc/uptime 2>/dev/null
echo '==LOAD=='; cat /proc/loadavg 2>/dev/null
echo '==CORES=='; grep -c '^processor' /proc/cpuinfo 2>/dev/null
echo '==CPU=='; grep -E '^cpu ' /proc/stat 2>/dev/null
echo '==MEM=='; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|Shmem|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo '==DISK=='; df -kP 2>/dev/null | tail -n +2
echo '==NET=='; cat /proc/net/dev 2>/dev/null | tail -n +3
echo '==TOPCPU=='; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu --no-headers 2>/dev/null | head -n 5
echo '==TOPMEM=='; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-rss --no-headers 2>/dev/null | head -n 5
echo '==DISKIO=='; cat /proc/diskstats 2>/dev/null
echo '==TCP=='; ss -tan 2>/dev/null | tail -n +2 | awk '{print $1}' | sort | uniq -c
"#;

/// 单次采集快照（字段 camelCase 序列化，供前端直接消费）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub hostname: String,
    pub kernel: String,
    /// CPU 架构（uname -m，如 x86_64 / aarch64）；uname 缺失时为空串
    pub arch: String,
    /// 系统运行时长（秒）
    pub uptime_secs: u64,
    pub load_1: f32,
    pub load_5: f32,
    pub load_15: f32,
    pub cpu_cores: u32,
    /// CPU 使用率（0-100）：100 - idle%，iowait 计入占用；首次采集无基线返回 0
    pub cpu_usage: f32,
    /// CPU 细分（各自占总 jiffies 百分比）：用户态 / 内核态 / IO 等待 / 被窃取
    pub cpu_user: f32,
    pub cpu_system: f32,
    pub cpu_iowait: f32,
    pub cpu_steal: f32,
    /// 内存总量 / 已用 / 可用（字节）。mem_used = total - available（可用口径）。
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_available: u64,
    /// 物理空闲内存（MemFree，字节）
    pub mem_free: u64,
    /// buff/cache（Buffers+Cached+SReclaimable-Shmem，字节），free 命令口径
    pub mem_buff_cache: u64,
    /// 交换分区总量 / 已用（字节）
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<DiskUsage>,
    /// 磁盘 I/O 速率（字节/秒）
    pub disks_io: Vec<DiskIo>,
    pub net: Vec<NetRate>,
    /// TCP 连接状态统计（ss -tan）
    pub tcp: TcpStats,
    /// CPU / 内存占用最高的进程（ps 快照，各 5 个）
    pub top_cpu: Vec<TopProcess>,
    pub top_mem: Vec<TopProcess>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub filesystem: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
    /// 使用率（0-100）
    pub percent: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskIo {
    pub device: String,
    /// 读速率（字节/秒）
    pub rx_bytes_per_sec: u64,
    /// 写速率（字节/秒）
    pub wx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRate {
    pub interface: String,
    /// 入流量（字节/秒）
    pub rx_bytes_per_sec: u64,
    /// 出流量（字节/秒）
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TcpStats {
    pub established: u32,
    pub time_wait: u32,
    pub close_wait: u32,
    pub syn_sent: u32,
    /// 监听中的端口数
    pub listening: u32,
    /// 非 LISTEN 的连接总数
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcess {
    pub pid: u32,
    pub user: String,
    pub name: String,
    /// ps 统计的 CPU 占比（进程生命周期平均，非瞬时）
    pub cpu_percent: f32,
    pub mem_percent: f32,
    pub mem_bytes: u64,
}

/// CPU 细分量占用的百分比结果（内部结构）。
#[derive(Debug, Clone, Copy, Default)]
struct CpuPct {
    usage: f32,
    user: f32,
    system: f32,
    iowait: f32,
    steal: f32,
}

/// `/proc/stat` cpu 行的原始 jiffies 采样（供两次采样求差值）。
#[derive(Debug, Clone, Copy)]
struct CpuSample {
    total: u64,
    user: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    steal: u64,
}

/// 监控会话：独立建立一条 SSH 连接（与终端会话互不干扰），复用终端同套认证链路
/// （含跳板机 ProxyJump、密钥/证书内容认证）。速率类指标（CPU/网络/磁盘 I/O）需
/// 两次采样求差，故缓存上次采样值。
pub struct MonitorSession {
    session: Session,
    #[allow(dead_code)]
    jump: Option<JumpTransport>,
    /// 上次 /proc/stat 的 CPU 采样
    prev_cpu: Option<CpuSample>,
    /// 上次各接口 (rx_bytes, tx_bytes)
    prev_net: Option<HashMap<String, (u64, u64)>>,
    /// 上次各磁盘 (sectors_read, sectors_written)
    prev_disk: Option<HashMap<String, (u64, u64)>>,
    /// 上次采样时刻（速率换算共用）
    prev_sample_at: Option<Instant>,
}

impl MonitorSession {
    pub fn connect(config: &SshConfig, timeout_secs: u32) -> Result<Self> {
        let established = SshSession::establish_authenticated_session(config, timeout_secs, &|_, _| {})?;
        Ok(Self {
            session: established.session,
            jump: established.jump,
            prev_cpu: None,
            prev_net: None,
            prev_disk: None,
            prev_sample_at: None,
        })
    }

    /// 执行一条命令并读取 stdout（阻塞，采集命令均为毫秒级本地读取）。
    fn exec(&self, cmd: &str) -> Result<String> {
        let mut channel = self.session.channel_session()?;
        channel.exec(cmd)?;
        let mut out = String::new();
        channel.read_to_string(&mut out).context("读取采集命令输出失败")?;
        let _ = channel.close();
        let _ = channel.wait_close();
        Ok(out)
    }

    pub fn collect(&mut self) -> Result<MonitorSnapshot> {
        let raw = self.exec(COLLECT_CMD)?;
        let now = Instant::now();
        let dt_secs = self
            .prev_sample_at
            .map(|t| now.duration_since(t).as_secs_f64())
            .unwrap_or(0.0);

        let hostname = first_line(&raw, "HOST").unwrap_or_else(|| "unknown".to_string());
        let kernel = first_line(&raw, "KERNEL").unwrap_or_else(|| "unknown".to_string());
        // 架构读不到（uname 缺失）时为空串而非 unknown，前端直接不显示
        let arch = first_line(&raw, "ARCH").unwrap_or_default();
        let uptime_secs = section(&raw, "UPTIME")
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<f64>().ok())
            .map(|v| v as u64)
            .unwrap_or(0);
        let (load_1, load_5, load_15) = parse_load(&section(&raw, "LOAD"));
        let cpu_cores = section(&raw, "CORES").trim().parse::<u32>().unwrap_or(0);
        let mem = parse_mem(&section(&raw, "MEM"));
        let disks = parse_disks(&section(&raw, "DISK"));
        let net_now = parse_net(&section(&raw, "NET"));
        let disk_now = parse_diskstats(&section(&raw, "DISKIO"));
        let top_cpu = parse_top_processes(&section(&raw, "TOPCPU"));
        let top_mem = parse_top_processes(&section(&raw, "TOPMEM"));
        let tcp = parse_tcp(&section(&raw, "TCP"));

        // CPU：两次采样 jiffies 差值。usage = 100 - idle%（iowait/steal 计入占用），
        // user/system/iowait/steal 各自占比，四项之和 ≈ usage（guest 等忽略）
        let cpu_sample = parse_cpu(&section(&raw, "CPU"));
        let cpu = match (self.prev_cpu, cpu_sample) {
            (Some(p), Some(c)) => {
                let dt = c.total.saturating_sub(p.total);
                if dt > 0 {
                    let ratio = |cur: u64, prev: u64| -> f32 {
                        ((cur.saturating_sub(prev)) as f32 / dt as f32 * 100.0).clamp(0.0, 100.0)
                    };
                    CpuPct {
                        usage: 100.0 - ratio(c.idle, p.idle),
                        user: ratio(c.user, p.user),
                        system: ratio(c.system, p.system),
                        iowait: ratio(c.iowait, p.iowait),
                        steal: ratio(c.steal, p.steal),
                    }
                } else {
                    CpuPct::default()
                }
            }
            _ => CpuPct::default(),
        };
        self.prev_cpu = cpu_sample;

        // 网络速率：字节差 / 时间间隔
        let mut net = Vec::new();
        if let Some(prev) = &self.prev_net {
            if dt_secs > 0.0 {
                for (iface, (rx, tx)) in &net_now {
                    if let Some((prx, ptx)) = prev.get(iface) {
                        net.push(NetRate {
                            interface: iface.clone(),
                            rx_bytes_per_sec: (rx.saturating_sub(*prx) as f64 / dt_secs) as u64,
                            tx_bytes_per_sec: (tx.saturating_sub(*ptx) as f64 / dt_secs) as u64,
                        });
                    }
                }
            }
        }
        self.prev_net = Some(net_now);

        // 磁盘 I/O 速率：扇区差 × 512 / 时间间隔
        let mut disks_io = Vec::new();
        if let Some(prev) = &self.prev_disk {
            if dt_secs > 0.0 {
                for (dev, (rs, ws)) in &disk_now {
                    if let Some((prs, pws)) = prev.get(dev) {
                        disks_io.push(DiskIo {
                            device: dev.clone(),
                            rx_bytes_per_sec: (rs.saturating_sub(*prs).saturating_mul(512) as f64 / dt_secs) as u64,
                            wx_bytes_per_sec: (ws.saturating_sub(*pws).saturating_mul(512) as f64 / dt_secs) as u64,
                        });
                    }
                }
            }
        }
        self.prev_disk = Some(disk_now);
        self.prev_sample_at = Some(now);

        let mem_total = mem.get("MemTotal").copied().unwrap_or(0);
        let mem_available = mem.get("MemAvailable").copied().unwrap_or(0);
        let swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
        let swap_free = mem.get("SwapFree").copied().unwrap_or(0);
        // buff/cache（free 口径）：Buffers + Cached + SReclaimable - Shmem，至少 0
        let mem_buff_cache = mem
            .get("Buffers")
            .copied()
            .unwrap_or(0)
            .saturating_add(mem.get("Cached").copied().unwrap_or(0))
            .saturating_add(mem.get("SReclaimable").copied().unwrap_or(0))
            .saturating_sub(mem.get("Shmem").copied().unwrap_or(0));

        Ok(MonitorSnapshot {
            hostname,
            kernel,
            arch,
            uptime_secs,
            load_1,
            load_5,
            load_15,
            cpu_cores,
            cpu_usage: cpu.usage,
            cpu_user: cpu.user,
            cpu_system: cpu.system,
            cpu_iowait: cpu.iowait,
            cpu_steal: cpu.steal,
            mem_total,
            mem_used: mem_total.saturating_sub(mem_available),
            mem_available,
            mem_free: mem.get("MemFree").copied().unwrap_or(0),
            mem_buff_cache,
            swap_total,
            swap_used: swap_total.saturating_sub(swap_free),
            disks,
            disks_io,
            net,
            tcp,
            top_cpu,
            top_mem,
        })
    }

    pub fn disconnect(&self) {
        let _ = self.session.disconnect(None, "Monitor closed", None);
    }
}

/// 会话池：与 SshManager 同构，短锁取 Arc、立即释放后再执行。
pub struct MonitorManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<MonitorSession>>>>>,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn insert(&self, session_id: String, session: MonitorSession) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id, Arc::new(Mutex::new(session)));
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<Mutex<MonitorSession>>> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(session_id).cloned()
    }

    pub fn remove(&self, session_id: &str) -> Option<Arc<Mutex<MonitorSession>>> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(session_id)
    }

    pub fn list(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    }

    pub fn disconnect_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, session) in sessions.drain() {
            if let Ok(guard) = session.lock() {
                guard.disconnect();
            }
        }
    }
}

impl Default for MonitorManager {
    fn default() -> Self {
        Self::new()
    }
}

// ==================== 解析辅助 ====================

/// 取出 `==NAME==` 标记之后、下一个 `==` 标记之前的内容。
/// ⚠️ 返回内容总以换行开头（`echo '==NAME=='` 自带换行）——逐行解析须跳过空行。
fn section<'a>(raw: &'a str, name: &str) -> &'a str {
    let marker = format!("=={}==", name);
    let Some(start) = raw.find(&marker) else {
        return "";
    };
    let rest = &raw[start + marker.len()..];
    let end = rest.find("\n==").unwrap_or(rest.len());
    &rest[..end]
}

/// 取 section 内第一个非空行。
/// ⚠️ 不能 `lines().next()`：section 总以换行开头（echo 自带），首行是空行。
fn first_line(raw: &str, name: &str) -> Option<String> {
    section(raw, name)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// 解析 `/proc/stat` 的 `cpu` 行（跳过前导空行），返回细分量采样。
fn parse_cpu(section: &str) -> Option<CpuSample> {
    let line = section.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    let vals: Vec<u64> = it.filter_map(|s| s.parse().ok()).collect();
    if vals.len() < 5 {
        return None;
    }
    let g = |i: usize| vals.get(i).copied().unwrap_or(0);
    let total: u64 = vals.iter().sum();
    Some(CpuSample {
        total,
        user: g(0) + g(1),
        system: g(2) + g(5) + g(6),
        idle: g(3),
        iowait: g(4),
        steal: g(7),
    })
}

/// 解析 `/proc/loadavg`：前三列为 1/5/15 分钟负载。
fn parse_load(section: &str) -> (f32, f32, f32) {
    let mut it = section.split_whitespace();
    let l1 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l5 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let l15 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    (l1, l5, l15)
}

/// 解析 `/proc/meminfo` 的几行，键为 MemTotal/MemAvailable/SwapTotal/SwapFree，
/// 值为字节（原始单位 kB，×1024）。
fn parse_mem(section: &str) -> HashMap<String, u64> {
    section
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let key = it.next()?.trim_end_matches(':').to_string();
            let kb: u64 = it.next()?.parse().ok()?;
            Some((key, kb.saturating_mul(1024)))
        })
        .collect()
}

/// 解析 `df -kP` 输出：filesystem 1024-blocks used available capacity% mountpoint。
/// 只保留真实块设备（filesystem 以 `/` 开头），过滤 tmpfs/devtmpfs 等内存文件系统。
fn parse_disks(section: &str) -> Vec<DiskUsage> {
    section
        .lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }
            let filesystem = parts[0];
            if !filesystem.starts_with('/') {
                return None;
            }
            let total: u64 = parts[1].parse::<u64>().ok()?.saturating_mul(1024);
            let used: u64 = parts[2].parse::<u64>().ok()?.saturating_mul(1024);
            let percent: f32 = parts[4].trim_end_matches('%').parse().ok()?;
            let mount = parts[5..].join(" ");
            Some(DiskUsage {
                filesystem: filesystem.to_string(),
                mount,
                total,
                used,
                percent,
            })
        })
        .collect()
}

/// 解析 `/proc/net/dev`：iface -> (rx_bytes, tx_bytes)。跳过回环 lo。
fn parse_net(section: &str) -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    for l in section.lines() {
        let parts: Vec<&str> = l.split_whitespace().collect();
        if parts.len() < 10 {
            continue;
        }
        let iface = parts[0].trim_end_matches(':');
        if iface == "lo" {
            continue;
        }
        let rx: u64 = parts[1].parse().unwrap_or(0);
        let tx: u64 = parts[9].parse().unwrap_or(0);
        map.insert(iface.to_string(), (rx, tx));
    }
    map
}

/// 解析 `/proc/diskstats`：整块盘 -> (sectors_read, sectors_written)。
/// 只保留 minor==0（整盘，排除 sda1 等分区避免重复计数），跳过 loop/ram/zram 等虚拟设备。
fn parse_diskstats(section: &str) -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    for l in section.lines() {
        let parts: Vec<&str> = l.split_whitespace().collect();
        if parts.len() < 10 || parts[1] != "0" {
            continue;
        }
        let device = parts[2];
        if device.starts_with("loop")
            || device.starts_with("ram")
            || device.starts_with("zram")
            || device.starts_with("sr")
            || device.starts_with("fd")
        {
            continue;
        }
        let sectors_read: u64 = parts[5].parse().unwrap_or(0);
        let sectors_written: u64 = parts[9].parse().unwrap_or(0);
        map.insert(device.to_string(), (sectors_read, sectors_written));
    }
    map
}

/// 解析 `ps -eo pid,user,pcpu,pmem,rss,comm` 输出行：pid user pcpu pmem rss comm
/// （comm 含空格时从右恢复前 5 列）。
fn parse_top_processes(section: &str) -> Vec<TopProcess> {
    section
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() {
                return None;
            }
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }
            let pid: u32 = parts[0].parse().ok()?;
            let user = parts[1].to_string();
            let cpu_percent: f32 = parts[2].parse().ok()?;
            let mem_percent: f32 = parts[3].parse().ok()?;
            let rss_kb: u64 = parts[4].parse().ok()?;
            let name = parts[5..].join(" ");
            Some(TopProcess {
                pid,
                user,
                name,
                cpu_percent,
                mem_percent,
                mem_bytes: rss_kb.saturating_mul(1024),
            })
        })
        .collect()
}

/// 解析 `ss -tan | awk '{print $1}' | sort | uniq -c` 输出：每行 "count STATE"。
/// ss 的状态名含连字符（TIME-WAIT），统一转下划线。
fn parse_tcp(section: &str) -> TcpStats {
    let mut stats = TcpStats::default();
    let mut total = 0u32;
    for l in section.lines() {
        let parts: Vec<&str> = l.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let count: u32 = parts[0].parse().unwrap_or(0);
        let state = parts[1].replace('-', "_");
        if state == "LISTEN" {
            stats.listening += count;
            continue;
        }
        total += count;
        match state.as_str() {
            "ESTAB" | "ESTABLISHED" => stats.established += count,
            "TIME_WAIT" => stats.time_wait += count,
            "CLOSE_WAIT" => stats.close_wait += count,
            "SYN_SENT" => stats.syn_sent += count,
            _ => {}
        }
    }
    stats.total = total;
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟 COLLECT_CMD 的真实输出结构：`==NAME==` 标记后紧跟换行（echo 自带）。
    /// 这正是 parse_cpu 曾踩的坑：section 以 `\n` 开头，lines().next() 是空行。
    fn sample_output() -> String {
        "==HOST==\nmyhost\n==KERNEL==\nLinux 5.15.0-91-generic\n==ARCH==\nx86_64\n==UPTIME==\n1234.56 7890.12\n==LOAD==\n0.50 0.40 0.30 1/234 5678\n==CORES==\n4\n==CPU==\ncpu  10000 200 3000 50000 1000 0 200 0 0 0\n==MEM==\nMemTotal:       16000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1000000 kB\n==DISK==\n/dev/sda1         10240000   2000000   7740000  21% /\ntmpfs              1000000      1000    999000   1% /dev/shm\n==NET==\n  eth0: 1000000  1000    0    0    0     0          0         0   200000   200    0    0    0     0       0          0\n  lo:    20000   100    0    0    0     0          0         0    20000   100    0    0    0     0       0          0\n"
            .to_string()
    }

    #[test]
    fn first_line_skips_leading_newline() {
        let raw = sample_output();
        // ⚠️ 回归：section 以换行开头，lines().next() 是空行——first_line 必须跳过空行
        assert_eq!(first_line(&raw, "HOST").as_deref(), Some("myhost"));
        assert_eq!(first_line(&raw, "KERNEL").as_deref(), Some("Linux 5.15.0-91-generic"));
        assert_eq!(first_line(&raw, "ARCH").as_deref(), Some("x86_64"));
    }

    #[test]
    fn section_starts_with_newline_but_extracts_correctly() {
        let raw = sample_output();
        assert_eq!(section(&raw, "HOST").trim(), "myhost");
        assert_eq!(section(&raw, "CORES").trim(), "4");
        // CPU section 以换行开头（echo 自带换行），首行是空行
        assert!(section(&raw, "CPU").starts_with('\n'));
    }

    #[test]
    fn parse_cpu_handles_leading_newline() {
        let raw = sample_output();
        let parsed = parse_cpu(&section(&raw, "CPU"));
        assert!(parsed.is_some(), "parse_cpu 对带前导换行的 section 必须返回 Some");
        let cpu = parsed.unwrap();
        // 字段: cpu 10000 200 3000 50000 1000 0 200 0 0 0
        assert_eq!(cpu.total, 64400); // 各字段之和
        assert_eq!(cpu.user, 10200); // user + nice
        assert_eq!(cpu.system, 3200); // system + irq + softirq
        assert_eq!(cpu.idle, 50000);
        assert_eq!(cpu.iowait, 1000);
        assert_eq!(cpu.steal, 0);
    }

    #[test]
    fn parse_mem_converts_kb_to_bytes() {
        let mem = parse_mem(&section(&sample_output(), "MEM"));
        assert_eq!(mem.get("MemTotal"), Some(&(16_000_000_u64 * 1024)));
        assert_eq!(mem.get("SwapFree"), Some(&(1_000_000_u64 * 1024)));
    }

    #[test]
    fn parse_disks_filters_virtual_fs() {
        let disks = parse_disks(&section(&sample_output(), "DISK"));
        assert_eq!(disks.len(), 1, "tmpfs 等虚拟文件系统应被过滤");
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].percent, 21.0);
    }

    #[test]
    fn parse_net_skips_loopback() {
        let net = parse_net(&section(&sample_output(), "NET"));
        assert_eq!(net.len(), 1, "lo 应被跳过");
        assert_eq!(net.get("eth0"), Some(&(1_000_000_u64, 200_000_u64)));
    }

    #[test]
    fn parse_diskstats_keeps_whole_disks_only() {
        let raw = "==DISKIO==\n8 0 sda 1000 200 50000 300 100 50 60000 200 0 0 0\n8 1 sda1 1000 200 50000 300 100 50 60000 200 0 0 0\n7 0 loop0 0 0 0 0 0 0 0 0 0 0 0 0\n253 0 vda 1 2 3 4 5 6 7 8 9 10 11 12\n";
        let io = parse_diskstats(&section(&raw, "DISKIO"));
        assert_eq!(io.len(), 2, "分区(minor!=0)与 loop 应被排除");
        assert_eq!(io.get("sda"), Some(&(50_000_u64, 60_000_u64)));
        assert_eq!(io.get("vda"), Some(&(3_u64, 7_u64)));
    }

    #[test]
    fn parse_tcp_counts_by_state() {
        let raw = "==TCP==\n  5 ESTAB\n  3 TIME-WAIT\n  2 CLOSE-WAIT\n  1 SYN-SENT\n  4 LISTEN\n  1 FIN-WAIT-2\n";
        let tcp = parse_tcp(&section(&raw, "TCP"));
        assert_eq!(tcp.established, 5);
        assert_eq!(tcp.time_wait, 3);
        assert_eq!(tcp.close_wait, 2);
        assert_eq!(tcp.syn_sent, 1);
        assert_eq!(tcp.listening, 4);
        assert_eq!(tcp.total, 12); // 5+3+2+1+1
    }

    #[test]
    fn parse_top_processes_handles_spaces_in_name() {
        let raw = "==TOPCPU==\n1234 root 12.3 1.5  204800 some daemon\n5678 www-data  2.0 0.1   4096 nginx\n";
        let procs = parse_top_processes(&section(&raw, "TOPCPU"));
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "some daemon");
        assert_eq!(procs[0].cpu_percent, 12.3);
        assert_eq!(procs[0].mem_bytes, 204_800 * 1024);
        assert_eq!(procs[1].name, "nginx");
    }
}
