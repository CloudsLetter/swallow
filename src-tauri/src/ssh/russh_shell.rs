//! russh 交互终端会话（SSH shell）——ssh2 主路径迁移的交互侧。
//!
//! 模型（docs/SSH_BACKEND_MIGRATION.md §9，API 已对 vendor russh 0.60.1 实证）：
//! - 认证/主机密钥/跳板全部复用 `russh_backend::connect()`，本模块只管「起 shell 会话」；
//! - **spawn() 内同步完成**连接 + PTY + shell：错误（含 HostKeyApprovalRequired）可透传
//!   给装配层 downcast 转前端待确认；随后把已打开的 channel 交给后台
//!   单 task `tokio::select!`：远端输出臂 `wait()` 推事件；本地命令臂走 mpsc；
//! - 写用 `channel.make_writer()`（AsyncWrite + 'static），resize 用 `window_change`；
//! - 会话事件与 ssh2 读线程同协议：`session-{id}` 的 Output/Progress/Disconnected/Error。
//!
//! ssh2 保留作为 DSA/老设备回退后端：回退判定在命令装配层（`is_ssh2_fallback_eligible`，
//! 同隧道），不在此模块。
#![allow(dead_code)]

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::session_events::{emit_session_event, SessionEvent};
use crate::ssh::russh_backend::{connect as russh_connect, ClientHandler, RusshConnection};
use crate::ssh::session::SshConfig;
use crate::AppState;
use tauri::{AppHandle, Manager};

/// 命令通道：外部（IPC 写/重设尺寸）经 mpsc 汇入独占 channel 的 select task。
enum ShellCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Stop,
}

/// 运行中的 russh shell 会话句柄（值类型，放入 AppState.russh_shells）。
pub struct ShellSession {
    tx: mpsc::Sender<ShellCmd>,
}

impl ShellSession {
    /// 异步背压写入：队列满时等待而不是丢输入（高频粘贴/广播时 select task 若被
    /// 大量输出占用，try_send 会满——丢键/丢粘贴不可接受）。
    pub async fn write(&self, data: Vec<u8>) -> Result<()> {
        self.tx
            .send(ShellCmd::Write(data))
            .await
            .map_err(|e| anyhow::anyhow!("shell 写通道已关闭: {e}"))
    }

    /// 重设 PTY 尺寸（数量少，仍走带背压的异步发送保证送达）。
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.tx
            .send(ShellCmd::Resize(cols, rows))
            .await
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

/// 建立 russh shell 会话：连接 + 认证 + PTY + shell 全部在本函数 await 完成，
/// 失败（含主机密钥待确认）直接返回给调用方；成功后才把 channel 交给后台
/// select task 并返回句柄。
pub async fn spawn(
    app: AppHandle,
    config: &SshConfig,
    session_id: String,
    timeout_secs: u32,
    cols: u32,
    rows: u32,
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

    // 连接/握手/认证（含跳板）。未知主机密钥 → 抛 HostKeyApprovalRequired，
    // 经 `?` 透传到装配层 downcast 转 needs_host_key_approval。
    let RusshConnection { handle, .. } =
        russh_connect(config, timeout_secs, None, on_progress_ref, None)
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

    let (tx, rx) = mpsc::channel::<ShellCmd>(1024);
    tauri::async_runtime::spawn(run_select(
        app,
        session_id,
        channel,
        handle,
        rx,
    ));
    Ok(ShellSession { tx })
}

/// 后台 select：channel 独占于此 task（`wait()` 需 &mut），本地命令经 rx 汇入。
async fn run_select(
    app: AppHandle,
    session_id: String,
    mut channel: russh::Channel<russh::client::Msg>,
    handle: russh::client::Handle<ClientHandler>,
    mut rx: mpsc::Receiver<ShellCmd>,
) {
    emit_session_event(
        &app,
        &session_id,
        &SessionEvent::Progress {
            stage: "ready".into(),
            message: None,
        },
    );

    let mut writer = channel.make_writer();
    let mut pending: Vec<u8> = Vec::with_capacity(8192 + 4);
    // remote_end：对端关闭/通道关闭/IO 错误（非主动）→ 需要给前端 Disconnected 事件并清会话表
    let mut remote_end = false;

    loop {
        tokio::select! {
            // 远端输出（服务器 → 客户端）
            msg = channel.wait() => {
                let Some(msg) = msg else {
                    remote_end = true;
                    break; // 事件循环侧已关闭
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
                                        emit_session_event(
                                            &app,
                                            &session_id,
                                            &SessionEvent::Output { data: text },
                                        );
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
                                            emit_session_event(
                                                &app,
                                                &session_id,
                                                &SessionEvent::Output { data: text },
                                            );
                                        }
                                    } else if !tail_incomplete {
                                        pending.drain(..e.error_len().unwrap_or(1));
                                        emit_session_event(
                                            &app,
                                            &session_id,
                                            &SessionEvent::Output {
                                                data: "\u{FFFD}".into(),
                                            },
                                        );
                                    } else {
                                        break; // 等下一块补全尾部
                                    }
                                }
                            }
                        }
                    }
                    russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::Close => {
                        remote_end = true;
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
                            emit_session_event(
                                &app,
                                &session_id,
                                &SessionEvent::Error { message: e.to_string() },
                            );
                            remote_end = true;
                            break;
                        }
                    }
                    ShellCmd::Resize(c, r) => {
                        if let Err(e) = channel.window_change(c, r, 0, 0).await {
                            emit_session_event(
                                &app,
                                &session_id,
                                &SessionEvent::Error { message: e.to_string() },
                            );
                            remote_end = true;
                            break;
                        }
                    }
                    ShellCmd::Stop => break, // 主动停止：不补 Disconnected（由调用方处理）
                }
            }
        }
    }

    // 结束：显式断开（eventloop 收到 disconnect 后关闭底层连接）。
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "Shell closed", "en")
        .await;
    if remote_end {
        // 远端/IO 导致的断开：通知前端 + 清会话表（否则 ssh_connect 复用检查会
        // 把已死的会话当成已连接，重连/再开全部假成功）。
        emit_session_event(&app, &session_id, &SessionEvent::Disconnected);
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut map) = state.russh_shells.lock() {
                map.remove(&session_id);
            }
        }
    }
}
