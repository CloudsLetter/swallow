//! MOSH 引导（SSH exec 启动 mosh-server）与数据面泵线程。

use crate::mosh::MOSH_BOOTSTRAP_READ_TIMEOUT_SECS;
use crate::session_events::{emit_session_event, SessionEvent};
use crate::ssh::session::SshSession;
use anyhow::{anyhow, Context, Result};
use mosh_rs::key::Base64Key;
use mosh_rs::session::MoshSession;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 泵线程收到的命令（前端写/尺寸/断开都汇到这一条通道）。
pub enum PumpCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
}

/// 引导结果：mosh-server 返回的 UDP 端口与会话密钥（仅内存传递）。
pub struct MoshBootstrap {
    pub port: u16,
    pub key: String,
}

/// 从 mosh-server 输出中解析 `MOSH CONNECT <port> <key>` 行（官方 ≥1.3 协议）。
fn parse_mosh_connect(output: &str) -> Option<(u16, String)> {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("MOSH CONNECT ") {
            let mut it = rest.split_whitespace();
            // 单行格式坏时继续扫后续行，不提前放弃
            if let (Some(port), Some(key)) = (it.next()?.parse::<u16>().ok(), it.next()) {
                if key.len() == 44 {
                    return Some((port, key.to_string()));
                }
            }
        }
    }
    None
}

enum BootstrapRead {
    Found(MoshBootstrap),
    /// stdout 结束（EOF/超时）且没有 MOSH CONNECT 行：mosh-server 启动失败
    NotFound,
    Io(anyhow::Error),
}

/// 边读 stdout 边尝试解析，看到 MOSH CONNECT 立即返回——**不等 EOF**：
/// mosh-server new 打印后后台化，其子进程可能继承 stdout，等 EOF 会让
/// 每次连接都白等满超时（官方 mosh 脚本同款：读到位就走）。
fn read_until_mosh_connect(channel: &mut ssh2::Channel) -> BootstrapRead {
    let deadline = Instant::now() + Duration::from_secs(MOSH_BOOTSTRAP_READ_TIMEOUT_SECS);
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            return BootstrapRead::NotFound;
        }
        match channel.read(&mut buf) {
            Ok(0) => return BootstrapRead::NotFound, // EOF：进程退出且无 CONNECT 行
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if let Some((port, key)) =
                    parse_mosh_connect(&String::from_utf8_lossy(&out))
                {
                    return BootstrapRead::Found(MoshBootstrap { port, key });
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                return BootstrapRead::Io(
                    anyhow::Error::from(e).context("读取 mosh-server 输出失败"),
                )
            }
        }
    }
}

/// 失败路径：循环读 stderr（mosh-server 报错即退出，正常很快 EOF；带兜底超时）。
fn read_channel_stderr(channel: &mut ssh2::Channel) -> String {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match channel.stderr().read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// SSH 引导：远程执行 `mosh-server new`，拿到 UDP 端口与密钥后关闭 SSH 会话。
/// 主机密钥待确认时向上透出 `HostKeyApprovalRequired`（lib.rs 照 ssh_connect 处理）。
pub fn bootstrap(
    config: &crate::ssh::SshConfig,
    timeout_secs: u32,
    on_progress: &dyn Fn(&str, Option<&str>),
) -> Result<MoshBootstrap> {
    on_progress("tcp", None);
    let established =
        SshSession::establish_authenticated_session(config, timeout_secs.max(1), on_progress)?;
    let session = established.session;

    on_progress("shell", Some("启动 mosh-server"));
    // 官方 mosh 脚本同款：优先 C.UTF-8 locale；服务器没有时去掉 -l 重试一次
    let commands = [
        "mosh-server new -c 256 -l LANG=C.UTF-8",
        "mosh-server new -c 256",
    ];
    let mut stderr_tail = String::new();
    for (i, cmd) in commands.iter().enumerate() {
        let mut channel = session.channel_session().context("打开 SSH 通道失败")?;
        channel.exec(cmd).context("执行 mosh-server 失败")?;

        let read = read_until_mosh_connect(&mut channel);
        let boot = match read {
            BootstrapRead::Found(boot) => boot,
            BootstrapRead::Io(e) => return Err(e),
            BootstrapRead::NotFound => {
                let _ = channel.close();
                let _ = channel.wait_close();
                stderr_tail = read_channel_stderr(&mut channel);
                if i + 1 < commands.len() {
                    continue; // locale 类失败：去 -l 重试
                }
                break;
            }
        };
        let _ = channel.close();
        let _ = channel.wait_close();
        return Ok(boot);
    }

    let hint = stderr_tail
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("mosh-server 未返回 MOSH CONNECT 行（服务器未安装 mosh 或版本过旧，需 ≥1.3）");
    Err(anyhow!("mosh-server 启动失败: {hint}"))
}

/// 启动数据面泵线程：UDP 会话 → 增量 ANSI emit 到 `session-{id}`；
/// 输入/尺寸/停止经命令通道注入。线程结束（含断开）时 emit Disconnected 并
/// 调用 disconnect_handler（manager 据此自查自删）。
pub fn start_pump<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    session_id: String,
    host: String,
    port: u16,
    key_b64: String,
    cols: u16,
    rows: u16,
    input_rx: Receiver<PumpCommand>,
    stop: Arc<AtomicBool>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("mosh-{session_id}"))
        .spawn(move || {
            let key = match Base64Key::from_printable(&key_b64) {
                Ok(k) => k,
                Err(e) => {
                    emit_session_event(&app_handle, &session_id, &SessionEvent::Error {
                        message: format!("MOSH 会话密钥无效: {e}"),
                    });
                    finish(&app_handle, &session_id, &disconnect_handler);
                    return;
                }
            };
            let mut session = match MoshSession::connect_with_size(&host, port, &key, cols, rows) {
                Ok(s) => s,
                Err(e) => {
                    emit_session_event(&app_handle, &session_id, &SessionEvent::Error {
                        message: format!("MOSH UDP 连接失败 {host}:{port}: {e}"),
                    });
                    finish(&app_handle, &session_id, &disconnect_handler);
                    return;
                }
            };
            emit_session_event(&app_handle, &session_id, &SessionEvent::Progress {
                stage: "ready".to_string(),
                message: None,
            });

            loop {
                if stop.load(Ordering::Relaxed) {
                    session.shutdown();
                    break;
                }
                // 先排空积压输入，再泵网络（输入延迟 ≤ 泵间隔 50ms）
                while let Ok(cmd) = input_rx.try_recv() {
                    match cmd {
                        PumpCommand::Input(bytes) => session.send_input(&bytes),
                        PumpCommand::Resize(w, h) => session.send_resize(w as i32, h as i32),
                    }
                }
                match session.pump() {
                    Ok(_events) => {
                        // Resize/Bytes/EchoAck 等主机事件均已反映进 screen 状态，
                        // 统一由 render() 的差分输出表达，无需单独处理
                    }
                    Err(e) => {
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Error {
                            message: format!("MOSH 会话异常: {e}"),
                        });
                        break;
                    }
                }
                let bytes = session.render();
                if !bytes.is_empty() {
                    emit_session_event(&app_handle, &session_id, &SessionEvent::Output {
                        data: String::from_utf8_lossy(&bytes).to_string(),
                    });
                }
                if session.finished() {
                    break;
                }
            }
            finish(&app_handle, &session_id, &disconnect_handler);
        })
        .expect("启动 MOSH 泵线程失败")
}

fn finish<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    session_id: &str,
    disconnect_handler: &Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
) {
    emit_session_event(app_handle, session_id, &SessionEvent::Disconnected);
    if let Ok(mut slot) = disconnect_handler.lock() {
        if let Some(handler) = slot.take() {
            handler();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mosh_connect_line() {
        let out = "mosh-server (mosh 1.4.0) [build mosh 1.4.0]\n\
                   Copyright 2012 Keith Winstein\n\
                   MOSH CONNECT 60001 cgvnywysumakqkxinhcxblfxvbvscvhrtsrksdvywcx=\n\
                   \nPlease let us know if you have any questions";
        let (port, key) = parse_mosh_connect(out).expect("应解析出端口与密钥");
        assert_eq!(port, 60001);
        assert_eq!(key.len(), 44);
    }

    #[test]
    fn rejects_without_connect_line_or_bad_key() {
        assert!(parse_mosh_connect("MOSH START").is_none());
        assert!(parse_mosh_connect("MOSH CONNECT 60001 shortkey").is_none());
        assert!(parse_mosh_connect("").is_none());
    }

    #[test]
    fn scans_past_bad_connect_line() {
        // 前缀匹配但格式坏的行不应阻止后续合法行被解析
        let out = "MOSH CONNECT not-a-port\n\
                   MOSH CONNECT 60001 cgvnywysumakqkxinhcxblfxvbvscvhrtsrksdvywcx=";
        let (port, key) = parse_mosh_connect(out).expect("坏行后应继续扫描");
        assert_eq!(port, 60001);
        assert_eq!(key.len(), 44);
    }
}
