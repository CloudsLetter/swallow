//! russh 交互终端会话（SSH shell）——ssh2 主路径迁移的交互侧。
//!
//! 模型（docs/SSH_BACKEND_MIGRATION.md §9，API 已对 vendor russh 0.60.1 实证）：
//! - 认证/主机密钥/跳板全部复用 `russh_backend::connect()`，本模块只管「起 shell 会话」；
//! - **spawn() 内同步完成**连接 + PTY + shell：错误（含 HostKeyApprovalRequired）可透传
//!   给装配层 downcast 转前端待确认；随后把已打开的 channel 交给后台输出泵 task
//!   `run_output_pump`（只做 `wait()` 读远端输出并推事件）；
//! - 写走 `Handle::data` 直发（按键级小包单包零排队，长粘贴 16KB 分片），
//!   resize 走 `window_change` 直发——输入不再经 mpsc/select 排队，无输出阻塞延迟；
//! - 会话事件与 ssh2 读线程同协议：`session-{id}` 的 Output/Progress/Disconnected/Error。
//!
//! ssh2 保留作为 DSA/老设备回退后端：回退判定在命令装配层（`is_ssh2_fallback_eligible`，
//! 同隧道），不在此模块。
#![allow(dead_code)]

use anyhow::{Context, Result};

use crate::session_events::{emit_session_event, OutputBatcher, SessionEvent};
use crate::services::logs::write_log;
use crate::ssh::russh_backend::{connect as russh_connect, ClientHandler, RusshConnection};
use crate::ssh::session::SshConfig;
use crate::AppState;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};

/// 运行中的 russh shell 会话句柄（值类型，放入 AppState.russh_shells）。
/// 写半端与读半端分离：写半端 Clone 后给 IPC 写路径直用（Send+Sync+'static），
/// 读半端留给后台输出泵——输入不再经 mpsc/select 排队，无输出阻塞延迟。
pub struct ShellSession {
    writer: std::sync::Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<russh::client::Msg>>>,
    /// 输出流控：true = 前端 write 缓冲积压超水位，泵暂停消费通道数据。
    /// 消费停止 → 有界 channel mpsc（channel_buffer_size=100 条）填满 →
    /// russh 事件循环阻塞 → SSH 窗口耗尽 → 服务端停发，端到端 TCP 背压、内存有界。
    output_paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ShellSession {
    /// 直写输入：按键级小包（≤256B）单包直发，零排队；
    /// 长数据（粘贴）按 writable_packet_size 切片逐片直发，尊重服务端窗口。
    pub async fn write(&self, data: Vec<u8>) -> Result<()> {
        let writer = self.writer.clone();
        let mut guard = writer.lock().await;
        write_data_windowed(&mut *guard, &data).await
    }

    /// 重设 PTY 尺寸（window_change 走写半端直发，不经 mpsc 排队）。
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.writer
            .lock()
            .await
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| anyhow::anyhow!("shell resize 失败: {e}"))
    }

    /// 输出流控开关（前端水位检测触发；见 output_paused 字段注释）。
    pub fn set_output_paused(&self, paused: bool) {
        self.output_paused
            .store(paused, std::sync::atomic::Ordering::Relaxed);
    }

    /// 请求停止并断开（幂等；Drop 也会兜底断开）。
    pub fn stop(&self) {
        let writer = self.writer.clone();
        tauri::async_runtime::spawn(async move {
            let _ = writer.lock().await.close().await;
        });
    }
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 输入直写：按键级小包（≤256B）单次直发，零排队；
/// 长数据（粘贴）按服务端窗口切片逐片直发，每片独立 SSH 包、无 mpsc 串行等待。
/// 旧路径（mpsc 1024 + make_writer + select 复用）的问题：
/// 高频输出时 select 的输出臂持续就绪，写命令在 rx 队列后排队，
/// 按键要等输出处理完才发出 → 体感「跳跃式延迟」。
async fn write_data_windowed(
    writer: &mut russh::ChannelWriteHalf<russh::client::Msg>,
    data: &[u8],
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    if data.is_empty() {
        return Ok(());
    }
    if data.len() <= 256 {
        let mut w = writer.make_writer();
        return w
            .write_all(data)
            .await
            .map_err(|e| anyhow::anyhow!("shell 写失败: {e}"));
    }
    let mut rest = data;
    while !rest.is_empty() {
        let n = writer.writable_packet_size().await.max(1).min(rest.len());
        let mut w = writer.make_writer();
        w.write_all(&rest[..n])
            .await
            .map_err(|e| anyhow::anyhow!("shell 写失败: {e}"))?;
        rest = &rest[n..];
    }
    Ok(())
}

/// 建立 russh shell 会话：连接 + 认证 + PTY + shell 全部在本函数 await 完成，
/// 失败（含主机密钥待确认）直接返回给调用方；成功后才把 channel 交给后台
/// select task 并返回句柄。`keepalive_secs` 透传 russh `keepalive_interval`
///（见 [`russh_connect`]），与用户配置一致；0 = 跟随 russh 默认。
/// `compression` 见 [`russh_connect`]。
pub async fn spawn(
    app: AppHandle,
    config: &SshConfig,
    session_id: String,
    timeout_secs: u32,
    cols: u32,
    rows: u32,
    keepalive_secs: u32,
    compression: bool,
    output_channel: Channel<InvokeResponseBody>,
) -> Result<ShellSession> {
    // 连接进度：转发到会话事件（前端连接步骤：tcp/ssh/auth/shell/ready）。
    let app_progress = app.clone();
    let sid_progress = session_id.clone();
    let on_progress = move |stage: &str, message: Option<&str>| {
        emit_session_event(
            &app_progress,
            &sid_progress,
            &SessionEvent::Progress {
                stage: stage.to_string(),
                message: message.map(|s| s.to_string()),
            },
        );
    };
    let on_progress_ref: &(dyn Fn(&str, Option<&str>) + Send + Sync) = &on_progress;

    // 断线原因透出：连接层死亡时 russh 事件循环 disconnected 回调触发，emit Error
    // 事件（对齐 ssh2 读线程错误路径）+ 落日志，排障有实锤。normal_close 标记
    // 「正常结束」（exit / 手动断开先关通道再 handle.disconnect，回调收到的
    // Error(Disconnect) 是自致断开而非故障），置位后抑制误报。
    let normal_close = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let on_disconnected = {
        let app_d = app.clone();
        let sid_d = session_id.clone();
        let normal_close = normal_close.clone();
        std::sync::Arc::new(move |reason: &str| {
            if normal_close.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            emit_session_event(
                &app_d,
                &sid_d,
                &SessionEvent::Error {
                    message: format!("SSH 连接已断开：{reason}"),
                },
            );
            let _ = write_log(
                "warn",
                &format!("SSH session {sid_d} disconnected: {reason}"),
                Some("ssh"),
            );
        })
    };

    // 连接/握手/认证（含跳板）。未知主机密钥 → 抛 HostKeyApprovalRequired，
    // 经 `?` 透传到装配层 downcast 转 needs_host_key_approval。
    let RusshConnection { handle, .. } =
        russh_connect(config, timeout_secs, None, on_progress_ref, Some(on_disconnected), keepalive_secs, compression)
            .await
            .context("russh 连接/认证失败")?;

    // 交互会话通道：PTY + shell（同步完成）。
    let channel = handle
        .channel_open_session()
        .await
        .context("打开会话通道失败")?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .context("请求 PTY 失败")?;
    channel
        .request_shell(true)
        .await
        .context("启动 shell 失败")?;
    emit_session_event(
        &app,
        &session_id,
        &SessionEvent::Progress {
            stage: "shell".into(),
            message: None,
        },
    );

    let (read_half, write_half) = channel.split();
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(write_half));
    let output_paused = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let session = ShellSession {
        writer: writer.clone(),
        output_paused: output_paused.clone(),
    };
    // handle 所有权移交输出泵：远端断开时由它显式 disconnect 并清会话表
    tauri::async_runtime::spawn(run_output_pump(
        app,
        session_id,
        read_half,
        handle,
        normal_close,
        output_paused,
        output_channel,
    ));
    Ok(session)
}

/// 后台输出泵：只做一件事——读半端 `wait()` 读远端输出并推事件。
/// 写/resize 走写半端直发（与读半端无锁竞争），输出不再阻塞输入 → 按键零排队延迟。
async fn run_output_pump(
    app: AppHandle,
    session_id: String,
    mut read_half: russh::ChannelReadHalf,
    handle: russh::client::Handle<ClientHandler>,
    normal_close: std::sync::Arc<std::sync::atomic::AtomicBool>,
    output_paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    output_channel: Channel<InvokeResponseBody>,
) {
    emit_session_event(
        &app,
        &session_id,
        &SessionEvent::Progress {
            stage: "ready".into(),
            message: None,
        },
    );

    let mut pending: Vec<u8> = Vec::with_capacity(8192 + 4);
    // 输出批量合并 + 二进制通道下发：逐块 JSON 事件洪泛会打满前端主线程
    //（大流量输出卡死整机）；Raw 载荷绕过 serde JSON 序列化/转义
    let mut batcher = OutputBatcher::new(OutputBatcher::channel_sink(output_channel));

    loop {
        // 流控暂停：不消费通道数据（有界 mpsc 填满 → 事件循环阻塞 → SSH 窗口耗尽
        // → 服务端停发），暂停期间只做到期 flush 与周期性醒来等待恢复
        if output_paused.load(std::sync::atomic::Ordering::Relaxed) {
            batcher.flush_if_due();
            tokio::time::sleep(OutputBatcher::MAX_DELAY).await;
            continue;
        }
        // 带超时等待：空闲期醒来 flush_if_due，保证缓冲残留 ≤ 一个合并窗口内送达
        let msg = match tokio::time::timeout(OutputBatcher::MAX_DELAY, read_half.wait()).await {
            Ok(msg) => msg,
            Err(_elapsed) => {
                batcher.flush_if_due();
                continue;
            }
        };
        let Some(msg) = msg else {
            break; // 事件循环侧已关闭 → 远端断开
        };
        match msg {
            russh::ChannelMsg::Data { ref data } => {
                pending.extend_from_slice(data);
                // 增量 UTF-8：只发完整前缀，尾部留给下一块；非法字节 lossy 替换。
                loop {
                    if pending.is_empty() {
                        break;
                    }
                    match std::str::from_utf8(&pending) {
                        Ok(_) => {
                            let text =
                                String::from_utf8(std::mem::take(&mut pending))
                                    .unwrap_or_default();
                            if !text.is_empty() {
                                batcher.push(&text);
                            }
                            break;
                        }
                        Err(e) => {
                            let valid = e.valid_up_to();
                            let tail_incomplete = e.error_len().is_none();
                            if valid > 0 {
                                let text = String::from_utf8(pending[..valid].to_vec())
                                    .unwrap_or_default();
                                pending.drain(..valid);
                                if !text.is_empty() {
                                    batcher.push(&text);
                                }
                            } else if !tail_incomplete {
                                pending.drain(..e.error_len().unwrap_or(1));
                                batcher.push("\u{FFFD}");
                            } else {
                                break; // 等下一块补全尾部
                            }
                        }
                    }
                }
            }
            russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::Close => {
                // 通道级正常结束（exit / 服务端关通道）：随后主动 handle.disconnect
                // 会触发 disconnected 回调，置位标记抑制「异常断线」误报
                normal_close.store(true, std::sync::atomic::Ordering::Relaxed);
                break;
            }
            _ => {}
        }
    }

    // 输出泵退出即视为远端结束：先发掉缓冲残留，再显式断开（eventloop 收到
    // disconnect 后关闭底层连接），通知前端 + 清会话表（否则 ssh_connect 复用
    // 检查会把已死的会话当成已连接）。
    batcher.flush();
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "Shell closed", "en")
        .await;
    emit_session_event(&app, &session_id, &SessionEvent::Disconnected);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut map) = state.russh_shells.lock() {
            map.remove(&session_id);
        }
    }
}
