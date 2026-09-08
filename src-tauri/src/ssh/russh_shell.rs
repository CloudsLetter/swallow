//! russh 交互终端会话（SSH shell）——ssh2 主路径迁移的交互侧。
//!
//! 模型（docs/SSH_BACKEND_MIGRATION.md §9，API 已对 vendor russh 0.60.1 实证）：
//! - 认证/主机密钥/跳板全部复用 `russh_backend::connect()`，此模块只管「起 shell 会话」；
//! - `channel.wait()` 需 `&mut channel` → 单 task `tokio::select!` 独占 channel：
//!   远端输出臂 `wait()` 推事件；本地命令臂（Write/Resize/Stop）走 mpsc 汇入；
//! - 写用 `channel.make_writer()`（AsyncWrite + 'static），resize 用 `window_change`；
//! - 会话事件与 ssh2 读线程同协议：`session-{id}` 的 Output/Progress/Disconnected/Error。
//!
//! ssh2 保留作为 DSA/老设备回退后端：本模块是「默认 russsh、失败按错误类别回退 ssh2」
//! 迁移里的 russh 半边；回退策略在 lib.rs 装配层决定，不在此处。
//! 尚未接入 lib.rs 命令层（swallow 里程碑内先编译保真），故允许 dead_code。
#![allow(dead_code)]

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::session_events::{emit_session_event, SessionEvent};
use crate::ssh::russh_backend::{connect as russh_connect, RusshConnection};
use crate::ssh::session::SshConfig;
use tauri::AppHandle;

/// 命令通道：外部（IPC 写/重设尺寸）经 mpsc 汇入独占 channel 的 select task。
enum ShellCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Stop,
}

/// 运行中的 russh shell 会话句柄（值类型，放入会话表）。
pub struct ShellSession {
    tx: mpsc::Sender<ShellCmd>,
}

impl ShellSession {
    pub fn write(&self, data: Vec<u8>) -> Result<()> {
        self.tx
            .try_send(ShellCmd::Write(data))
            .map_err(|e| anyhow::anyhow!("shell 写通道已关闭: {e}"))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.tx
            .try_send(ShellCmd::Resize(cols, rows))
            .map_err(|e| anyhow::anyhow!("shell resize 通道已关闭: {e}"))
    }

    /// 请求停止并断开（幂等；Drop 也会兜底发 Stop）。
    pub fn stop(&self) {
        let _ = self.tx.try_send(ShellCmd::Stop);
    }
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        let _ = self.tx.try_send(ShellCmd::Stop);
    }
}

/// 建立 russh shell 会话并启动 select task，返回后即可 write/resize。
/// `cols/rows`：初始 PTY 尺寸（后续 resize 覆盖）。
pub async fn spawn(
    app: AppHandle,
    config: &SshConfig,
    session_id: String,
    timeout_secs: u32,
    cols: u32,
    rows: u32,
) -> Result<ShellSession> {
    // 连接进度：转发到会话事件（前端连接步骤：tcp/ssh/auth/shell/ready 顺序对齐）。
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

    let (tx, rx) = mpsc::channel::<ShellCmd>(1024);
    let _join = tauri::async_runtime::spawn(run(
        app,
        session_id,
        config.clone(),
        timeout_secs,
        cols,
        rows,
        rx,
        Arc::new(on_progress),
    ));
    Ok(ShellSession { tx })
}

async fn run(
    app: AppHandle,
    session_id: String,
    config: SshConfig,
    timeout_secs: u32,
    cols: u32,
    rows: u32,
    mut rx: mpsc::Receiver<ShellCmd>,
    on_progress: Arc<dyn Fn(&str, Option<&str>) + Send + Sync>,
) {
    let res = run_inner(
        &app,
        &session_id,
        &config,
        timeout_secs,
        cols,
        rows,
        &mut rx,
        on_progress,
    )
    .await;
    if let Err(e) = res {
        // 顶层失败（连接/握手/建会话）：错误 + 断开事件，前端按既有逻辑关掉进度并回显。
        emit_session_event(&app, &session_id, &SessionEvent::Error { message: e.to_string() });
        emit_session_event(&app, &session_id, &SessionEvent::Disconnected);
    }
}

async fn run_inner(
    app: &AppHandle,
    session_id: &str,
    config: &SshConfig,
    timeout_secs: u32,
    cols: u32,
    rows: u32,
    rx: &mut mpsc::Receiver<ShellCmd>,
    on_progress: Arc<dyn Fn(&str, Option<&str>) + Send + Sync>,
) -> Result<()> {
    let on_progress_ref: &(dyn Fn(&str, Option<&str>) + Send + Sync) = on_progress.as_ref();
    let RusshConnection { handle, .. } = russh_connect(config, timeout_secs, None, on_progress_ref, None)
        .await
        .context("russh 连接/认证失败")?;

    let mut channel = handle
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
    on_progress("shell", None);

    let mut writer = channel.make_writer();
    let mut pending: Vec<u8> = Vec::with_capacity(8192 + 4);
    emit_session_event(app, session_id, &SessionEvent::Progress { stage: "ready".into(), message: None });

    loop {
        tokio::select! {
            // 远端输出（服务器 → 客户端）
            msg = channel.wait() => {
                let Some(msg) = msg else {
                    break; // 事件循环侧已关闭
                };
                match msg {
                    russh::ChannelMsg::Data { ref data } => {
                        // 跨块 UTF-8 增量解码（与 ssh2 读线程同语义）：只发完整前缀，
                        // 不完整的尾部字节留给下一次 Data；非法字节 lossy 替换。
                        pending.extend_from_slice(data);
                        while !pending.is_empty() {
                            match std::str::from_utf8(&pending) {
                                Ok(_) => {
                                    let text = String::from_utf8(std::mem::take(&mut pending))
                                        .unwrap_or_default();
                                    if !text.is_empty() {
                                        emit_session_event(
                                            app,
                                            session_id,
                                            &SessionEvent::Output { data: text },
                                        );
                                    }
                                }
                                Err(e) => {
                                    let valid = e.valid_up_to();
                                    let tail_incomplete = e.error_len().is_none();
                                    if valid > 0 {
                                        let text =
                                            String::from_utf8(pending[..valid].to_vec()).unwrap_or_default();
                                        pending.drain(..valid);
                                        if !text.is_empty() {
                                            emit_session_event(
                                                app,
                                                session_id,
                                                &SessionEvent::Output { data: text },
                                            );
                                        }
                                    } else if !tail_incomplete {
                                        // 非法字节（非“不完整尾部”）：占位替换后丢弃
                                        pending.drain(..e.error_len().unwrap_or(1));
                                        emit_session_event(
                                            app,
                                            session_id,
                                            &SessionEvent::Output { data: "\u{FFFD}".into() },
                                        );
                                    } else {
                                        break; // 等待下一块补全尾部
                                    }
                                }
                            }
                        }
                    }
                    russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::Close { .. } => {
                        break;
                    }
                    _ => {}
                }
            }
            // 本地命令（IPC 写 / 重设尺寸 / 停止）
            cmd = rx.recv() => {
                let Some(cmd) = cmd else {
                    break; // 会话句柄已 drop
                };
                match cmd {
                    ShellCmd::Write(data) => {
                        if let Err(e) = writer.write_all(&data).await {
                            emit_session_event(app, session_id, &SessionEvent::Error { message: e.to_string() });
                            break;
                        }
                    }
                    ShellCmd::Resize(c, r) => {
                        if let Err(e) = channel.window_change(c, r, 0, 0).await {
                            emit_session_event(app, session_id, &SessionEvent::Error { message: e.to_string() });
                            break;
                        }
                    }
                    ShellCmd::Stop => break,
                }
            }
        }
    }

    // 结束：断开会话（事件循环 drop 后自动关闭底层连接）
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "Shell closed", "en")
        .await;
    emit_session_event(app, session_id, &SessionEvent::Disconnected);
    Ok(())
}
