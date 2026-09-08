//! A/B 压测：ssh2 vs russh —— 单连接并发 exec 读吞吐 + 空闲存活。
//!
//! 背景：ssh2 的 Session 是全局大锁（任一 channel 阻塞读期间整把锁被握），
//! 同一连接上并发通道会退化成串行；russh 事件循环 + 每通道 task 天然并发。
//! 本 harness 在两库各自的"单连接"上开 C 个并发 exec，远端灌等量数据，
//! 测聚合吞吐随并发的变化；顺带验证空闲 N 秒后连接仍可 exec（30s 自断回归）。
//!
//! 用法：
//! ```text
//! # 快速冒烟（默认 mb=16、repeats=1、无 idle，~20s）
//! cargo run --example ssh_ab -- --password xxx user host
//! # 完整对拍（吞吐多档 ×3 取中位 + 空闲 40s 验活）
//! cargo run --example ssh_ab -- --password xxx --mb 64 --repeats 3 --idle-secs 40 user host
//! # 短命令并发（锁串行判据，纯 CPU 侧不受链路影响）
//! cargo run --example ssh_ab -- --password xxx --short-rounds 30 user host
//! ```
//! 远端需 Linux sshd；测的是纯通道吞吐（exec `dd if=/dev/zero bs=1M count=<mb>`）。
//! 主机密钥信任任意（本工具只做性能对拍，不校验指纹）。

use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::load_secret_key;
use russh::keys::PrivateKeyWithHashAlg;
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};



struct Cli {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key: Option<PathBuf>,
    concurrency: Vec<usize>,
    mb: u64,
    idle_secs: u64,
    /// 每档重复次数：单次测量易受网络/对端瞬时抖动干扰，多轮取中位数更可信
    repeats: u64,
    /// true：跳过吞吐只跑「并发短命令 ops/s」
    short_only: bool,
    /// >0：追加 SFTP 上传/下载对拍（远端家目录文件，纯单通道真实文件 IO）
    sftp_mb: u64,
    /// SFTP 写块大小（MiB）：验证 ssh2 慢是否 chunk 策略所致（russh-sftp 默认并发写流水）
    chunk_mb: f64,
    /// >0：追加「并发短命令」场景——每 worker 顺序 exec `echo ok` 若干轮，
    /// 统计 ops/s。大文件吞吐会被网卡封顶，短命令比的是「每命令过锁+握手」，
    /// 用于暴露 ssh2 单 Session 大锁的串行特性。
    short_rounds: u64,
}

fn parse_cli() -> Option<Cli> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cli = Cli {
        host: String::new(),
        port: 22,
        user: String::new(),
        password: None,
        key: None,
        concurrency: vec![1, 2, 4, 8],
        mb: 16,
        idle_secs: 0,
        repeats: 1,
        short_only: false,
        sftp_mb: 0,
        chunk_mb: 0.25,
        short_rounds: 0,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => cli.port = it.next()?.parse().ok()?,
            "--user" => cli.user = it.next()?.clone(),
            "--password" => cli.password = Some(it.next()?.clone()),
            "--key" => cli.key = Some(PathBuf::from(it.next()?)),
            "--short-rounds" => cli.short_rounds = it.next()?.parse().ok()?,            "--concurrency" => {
                cli.concurrency = it
                    .next()?
                    .split(',')
                    .filter_map(|s| s.trim().parse().ok())
                    .collect()
            }
            "--mb" => cli.mb = it.next()?.parse().ok()?,
            "--repeats" => cli.repeats = it.next()?.parse().ok()?,
            "--short-only" => cli.short_only = true,
            "--sftp-mb" => cli.sftp_mb = it.next()?.parse().ok()?,
            "--chunk-mb" => cli.chunk_mb = it.next()?.parse().ok()?,
            "--idle-secs" => cli.idle_secs = it.next()?.parse().ok()?,
            _ if cli.user.is_empty() => cli.user = a.clone(),
            _ if cli.host.is_empty() => cli.host = a.clone(),
            _ => return None,
        }
    }
    (cli.user != "" && cli.host != "" && (cli.password.is_some() || cli.key.is_some())).then_some(cli)
}

// ---------------- ssh2 side (blocking, per-worker OS thread) ----------------

fn ssh2_connect(cli: &Cli) -> Result<Arc<Mutex<ssh2::Session>>, String> {
    let tcp = TcpStream::connect((cli.host.as_str(), cli.port)).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("handshake: {e}"))?;
    // harness：信任任意主机密钥（性能对拍不校验指纹）
    if let Some(pw) = &cli.password {
        sess.userauth_password(&cli.user, pw)
            .map_err(|e| format!("password auth: {e}"))?;
    } else if let Some(key) = &cli.key {
        sess.userauth_pubkey_file(&cli.user, None, key, None)
            .map_err(|e| format!("key auth: {e}"))?;
    }
    if !sess.authenticated() {
        return Err("not authenticated".into());
    }
    Ok(Arc::new(Mutex::new(sess)))
}

fn ssh2_exec_once(
    sess: &Arc<Mutex<ssh2::Session>>,
    cmd: &str,
) -> Result<u64, String> {
    let mut channel = {
        let s = sess.lock().unwrap();
        let mut ch = s.channel_session().map_err(|e| e.to_string())?;
        ch.exec(cmd).map_err(|e| e.to_string())?;
        ch
    };
    let mut buf = Vec::new();
    channel.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    // 必须显式 close + wait_close：高频连开 channel 若不释放，会耗尽对端
    // 单连接通道上限（sshd MaxSessions 默认 10）→ 后续 open 全部失败
    let _ = channel.close();
    let _ = channel.wait_close();
    Ok(buf.len() as u64)
}

fn run_ssh2_level(sess: &Arc<Mutex<ssh2::Session>>, c: usize, cmd: &str) -> Result<f64, String> {
    let start = Instant::now();
    let handles: Vec<_> = (0..c)
        .map(|_| {
            let sess = Arc::clone(sess);
            let cmd = cmd.to_string();
            std::thread::spawn(move || ssh2_exec_once(&sess, &cmd))
        })
        .collect();
    let mut ok = 0usize;
    for h in handles {
        if h.join().map_err(|_| "thread panicked".to_string())?.is_ok() {
            ok += 1;
        }
    }
    let secs = start.elapsed().as_secs_f64();
    let _ = ok;
    Ok((c as f64 * cmd_mb(cmd) as f64) / secs) // MB/s 按预期字节计（并发满通道）
}

fn cmd_mb(cmd: &str) -> u64 {
    // "dd if=/dev/zero bs=1M count=N 2>/dev/null" 里取 N
    cmd.split_whitespace()
        .find_map(|t| t.strip_prefix("count=").and_then(|v| v.parse::<u64>().ok()))
        .unwrap_or(0)
}

/// 按中位数打印一档多次测量的结果（min / median / max）。
fn print_stat(c: usize, samples: &mut Vec<f64>) {
    if samples.is_empty() {
        println!("  concurrency {c:>2} : ERROR (无有效样本)");
        return;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let med = samples[samples.len() / 2];
    println!(
        "  concurrency {c:>2} : {med:8.1} MB/s  (min {:7.1} / max {:7.1}, n={})",
        samples[0],
        samples[samples.len() - 1],
        samples.len()
    );
}

fn run_ssh2_short(sess: &Arc<Mutex<ssh2::Session>>, c: usize, rounds: u64) -> Result<f64, String> {    let start = Instant::now();
    let handles: Vec<_> = (0..c)
        .map(|_| {
            let sess = Arc::clone(sess);
            std::thread::spawn(move || {
                let mut ok = 0u64;
                for _ in 0..rounds {
                    if ssh2_exec_once(&sess, "echo ok").is_ok() {
                        ok += 1;
                    }
                }
                ok
            })
        })
        .collect();
    let mut done = 0u64;
    for h in handles {
        done += h.join().map_err(|_| "thread panicked".to_string())?;
    }
    Ok(done as f64 / start.elapsed().as_secs_f64())
}

// ---------------- russh side (tokio) ----------------

#[derive(Default)]
struct PermitAll {}

impl client::Handler for PermitAll {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn russh_connect(cli: &Cli) -> Result<Arc<client::Handle<PermitAll>>, String> {
    let cfg = Arc::new(client::Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None, // ⚠️ 设了会复刻 ssh2 的"空闲自断"
        ..<_>::default()
    });
    let mut handle = client::connect(cfg, (cli.host.as_str(), cli.port), PermitAll {})
        .await
        .map_err(|e| format!("connect: {e}"))?;
    if let Some(pw) = &cli.password {
        let r = handle
            .authenticate_password(&cli.user, pw)
            .await
            .map_err(|e| e.to_string())?;
        if !r.success() {
            return Err("password auth failed".into());
        }
    } else if let Some(key) = &cli.key {
        let key_pair = load_secret_key(key, None).map_err(|e| format!("load key: {e}"))?;
        // best_supported_rsa_hash → Result<Option<Option<HashAlg>>>，双层 flatten 到 Option
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten();
        let r = handle
            .authenticate_publickey(&cli.user, PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash))
            .await
            .map_err(|e| e.to_string())?;
        if !r.success() {
            return Err("key auth failed".into());
        }
    }
    Ok(Arc::new(handle))
}

async fn russh_exec_once(handle: Arc<client::Handle<PermitAll>>, cmd: String) -> Result<u64, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel.exec(true, cmd).await.map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    loop {
        let Some(msg) = channel.wait().await else {
            break;
        };
        match msg {
            ChannelMsg::Data { ref data } => total += data.len() as u64,
            ChannelMsg::ExitStatus { .. } => break,
            _ => {}
        }
    }
    Ok(total)
}

async fn run_russh_level(
    handle: Arc<client::Handle<PermitAll>>,
    c: usize,
    cmd: String,
) -> Result<f64, String> {
    let start = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..c {
        let h = Arc::clone(&handle);
        let cmd = cmd.clone();
        tasks.push(tokio::spawn(async move { russh_exec_once(h, cmd).await }));
    }
    let mut ok = 0usize;
    for t in tasks {
        if t.await.map_err(|_| "task panicked".to_string())?.is_ok() {
            ok += 1;
        }
    }
    let secs = start.elapsed().as_secs_f64();
    let _ = ok;
    Ok((c as f64 * cmd_mb(&cmd) as f64) / secs)
}

async fn run_russh_short(
    handle: Arc<client::Handle<PermitAll>>,
    c: usize,
    rounds: u64,
) -> Result<f64, String> {
    let start = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..c {
        let h = Arc::clone(&handle);
        tasks.push(tokio::spawn(async move {
            let mut done = 0u64;
            for _ in 0..rounds {
                if russh_exec_once(Arc::clone(&h), "echo ok".into()).await.is_ok() {
                    done += 1;
                }
            }
            done
        }));
    }
    let mut total = 0u64;
    for t in tasks {
        total += t.await.map_err(|_| "task panicked".to_string())?;
    }
    Ok(total as f64 / start.elapsed().as_secs_f64())
}

const SFTP_BENCH_PATH: &str = "ssh_ab_sftp_bench.bin";

/// ssh2：单 SFTP 会话上传（写满 mb MiB 零字节）→ 下载 → 清理，返回 (up, down) MB/s。
fn ssh2_sftp_bench(
    sess: &Arc<Mutex<ssh2::Session>>,
    path: &str,
    mb: u64,
    chunk_bytes: usize,
) -> Result<(f64, f64), String> {
    use std::io::{Read, Write};
    use ssh2::{OpenFlags, OpenType};
    use std::path::Path;

    let total: u64 = mb * 1024 * 1024;
    let sftp = sess.lock().unwrap().sftp().map_err(|e| e.to_string())?;
    let mib = 1024.0 * 1024.0;

    // upload
    let start = Instant::now();
    let mut f = sftp
        .open_mode(
            Path::new(path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )
        .map_err(|e| e.to_string())?;
    let chunk = vec![0u8; chunk_bytes];
    let mut sent: u64 = 0;
    while sent < total {
        let n = ((total - sent) as usize).min(chunk.len());
        f.write_all(&chunk[..n]).map_err(|e| e.to_string())?;
        sent += n as u64;
    }
    // 测量边界必须到 close 完成（close 才真正把缓冲写全 + 关句柄）
    f.close().map_err(|e| e.to_string())?;
    let up = total as f64 / mib / start.elapsed().as_secs_f64();

    // download
    let start = Instant::now();
    let mut f = sftp.open(Path::new(path)).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        got += n as u64;
    }
    let down = got as f64 / mib / start.elapsed().as_secs_f64();
    f.close().ok();
    let _ = sftp.unlink(Path::new(path));
    Ok((up, down))
}

/// russh-sftp：同上（SftpSession::new 吃 sftp subsystem 的 ChannelStream）。
async fn russh_sftp_bench(
    handle: Arc<client::Handle<PermitAll>>,
    path: String,
    mb: u64,
    chunk_bytes: usize,
) -> Result<(f64, f64), String> {
    use russh_sftp::client::SftpSession;

    let total: u64 = mb * 1024 * 1024;
    let mib = 1024.0 * 1024.0;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| e.to_string())?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp init: {e}"))?;

    // upload：close() 是完成点（消费式关闭会等齐所有写确认），计时到它结束
    let start = Instant::now();
    let mut f = sftp.create(path.clone()).await.map_err(|e| e.to_string())?;
    let chunk = vec![0u8; chunk_bytes];
    let mut sent: u64 = 0;
    while sent < total {
        let n = ((total - sent) as usize).min(chunk.len());
        f.write_all(&chunk[..n]).await.map_err(|e| e.to_string())?;
        sent += n as u64;
    }
    let _ = f.close().await.map_err(|e| e.to_string())?;
    let up = total as f64 / mib / start.elapsed().as_secs_f64();

    // download
    let start = Instant::now();
    let mut f = sftp.open(path.clone()).await.map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        got += n as u64;
    }
    let down = got as f64 / mib / start.elapsed().as_secs_f64();
    drop(f);
    let _ = sftp.remove_file(path).await;
    Ok((up, down))
}

// ---------------- main ----------------

fn main() {
    let Some(cli) = parse_cli() else {
        eprintln!(
            "usage: ssh_ab [--port P] [--user U] (--password PW | --key K) [--concurrency 1,2,4,8] [--mb 16] [--repeats 1] [--short-only] [--short-rounds N] [--sftp-mb 0] [--idle-secs S] <user> <host>"
        );
        std::process::exit(2);
    };
    let cmd = format!("dd if=/dev/zero bs=1M count={} 2>/dev/null", cli.mb);

    // ---- ssh2 ----
    match ssh2_connect(&cli) {
        Ok(sess) => {
            if !cli.short_only {
                println!("== ssh2 (single session, exec concurrency) ==");
                for &c in &cli.concurrency {
                    let mut samples = Vec::new();
                    for _ in 0..cli.repeats {
                        match run_ssh2_level(&sess, c, &cmd) {
                            Ok(mbps) => samples.push(mbps),
                            Err(e) => {
                                println!("  concurrency {c:>2} : ERROR {e}");
                                break;
                            }
                        }
                    }
                    print_stat(c, &mut samples);
                }
            }
            if cli.short_rounds > 0 {
                println!("  [short-command ops/s]");
                for &c in &cli.concurrency {
                    match run_ssh2_short(&sess, c, cli.short_rounds) {
                        Ok(ops) => println!("  concurrency {c:>2} : {ops:9.0} ops/s"),
                        Err(e) => println!("  concurrency {c:>2} : ERROR {e}"),
                    }
                }
            }
            if cli.sftp_mb > 0 {
                let mut ups = Vec::new();
                let mut downs = Vec::new();
                let mut err: Option<String> = None;
                for _ in 0..cli.repeats {
                    match ssh2_sftp_bench(&sess, SFTP_BENCH_PATH, cli.sftp_mb, (cli.chunk_mb * 1024.0 * 1024.0) as usize) {
                        Ok((u, d)) => { ups.push(u); downs.push(d); }
                        Err(e) => { err = Some(e); break; }
                    }
                }
                if let Some(e) = err {
                    println!("  sftp: ERROR {e}");
                } else {
                    ups.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    downs.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    println!(
                        "  sftp: upload {} MB/s / download {} MB/s (mb={}, n={}, range up {}..{} down {}..{})",
                        ups[ups.len()/2], downs[downs.len()/2], cli.sftp_mb, ups.len(),
                        ups[0], ups[ups.len()-1], downs[0], downs[downs.len()-1]
                    );
                }
            }
            if cli.idle_secs > 0 {
                std::thread::sleep(Duration::from_secs(cli.idle_secs));
                let alive = ssh2_exec_once(&sess, "echo ok").is_ok();
                println!("  idle {idle}s still exec: {alive}", idle = cli.idle_secs);
            }
        }
        Err(e) => println!("ssh2 connect failed: {e}"),
    }

    // ---- russh ----
    println!();
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    rt.block_on(async {
        match russh_connect(&cli).await {
            Ok(handle) => {
                if !cli.short_only {
                    println!("== russh (single session, exec concurrency) ==");
                    for &c in &cli.concurrency {
                        let mut samples = Vec::new();
                        for _ in 0..cli.repeats {
                            match run_russh_level(Arc::clone(&handle), c, cmd.clone()).await {
                                Ok(mbps) => samples.push(mbps),
                                Err(e) => {
                                    println!("  concurrency {c:>2} : ERROR {e}");
                                    break;
                                }
                            }
                        }
                        print_stat(c, &mut samples);
                    }
                }
                if cli.short_rounds > 0 {
                    println!("  [short-command ops/s]");
                    for &c in &cli.concurrency {
                        match run_russh_short(Arc::clone(&handle), c, cli.short_rounds).await {
                            Ok(ops) => println!("  concurrency {c:>2} : {ops:9.0} ops/s"),
                            Err(e) => println!("  concurrency {c:>2} : ERROR {e}"),
                        }
                    }
                }
                if cli.sftp_mb > 0 {
                    let mut ups = Vec::new();
                    let mut downs = Vec::new();
                    let mut err: Option<String> = None;
                    for _ in 0..cli.repeats {
                        match russh_sftp_bench(Arc::clone(&handle), SFTP_BENCH_PATH.into(), cli.sftp_mb, (cli.chunk_mb * 1024.0 * 1024.0) as usize).await {
                            Ok((u, d)) => { ups.push(u); downs.push(d); }
                            Err(e) => { err = Some(e); break; }
                        }
                    }
                    if let Some(e) = err {
                        println!("  sftp: ERROR {e}");
                    } else {
                        ups.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        downs.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        println!(
                            "  sftp: upload {} MB/s / download {} MB/s (mb={}, n={}, range up {}..{} down {}..{})",
                            ups[ups.len()/2], downs[downs.len()/2], cli.sftp_mb, ups.len(),
                            ups[0], ups[ups.len()-1], downs[0], downs[downs.len()-1]
                        );
                    }
                }
                if cli.idle_secs > 0 {
                    tokio::time::sleep(Duration::from_secs(cli.idle_secs)).await;
                    let alive = russh_exec_once(Arc::clone(&handle), "echo ok".into())
                        .await
                        .is_ok();
                    println!("  idle {}s still exec: {alive}", cli.idle_secs);
                    // drop handle 即结束事件循环并断开（无需显式 disconnect）
                }
            }
            Err(e) => println!("russh connect failed: {e}"),
        }
    });

    // 无输出落盘意图：纯表格式对拍，脚本解析 stdout 即可
}
