use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::session_events::{emit_session_event, SessionEvent};

/// 本地终端配置（本地 shell / WSL，无网络连接）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    /// shell 类型："cmd" | "powershell" | "pwsh" | "wsl" | "bash"
    pub shell: String,
    /// WSL 发行版名（shell = "wsl" 时可选；空 = 默认发行版）
    pub wsl_distro: Option<String>,
}

/// 根据 shell 类型构造启动命令。cmd/powershell 注入 `chcp 65001` 把输出统一为 UTF-8
/// （中文系统默认 GBK 代码页，否则终端显示乱码）；wsl/bash 默认 UTF-8 无需处理。
fn shell_command(config: &LocalShellConfig) -> CommandBuilder {
    match config.shell.as_str() {
        "powershell" => {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.args(["-NoExit", "-Command", "chcp 65001 > $null"]);
            cmd
        }
        "pwsh" => {
            let mut cmd = CommandBuilder::new("pwsh.exe");
            cmd.args(["-NoExit", "-Command", "chcp 65001 > $null"]);
            cmd
        }
        "wsl" => {
            let mut cmd = CommandBuilder::new("wsl.exe");
            if let Some(distro) = config.wsl_distro.as_deref() {
                if !distro.trim().is_empty() {
                    cmd.args(["-d", distro.trim()]);
                }
            }
            cmd
        }
        "bash" => CommandBuilder::new("bash.exe"),
        _ => {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/k", "chcp 65001>nul"]);
            cmd
        }
    }
}

pub struct LocalShellSession {
    /// PTY master：用于 resize（reader/writer 从它派生）。
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// 写入端（take_writer 只能调用一次）。
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 子进程句柄：用于 wait/kill。
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}

impl LocalShellSession {
    pub fn connect(
        config: LocalShellConfig,
        session_id: String,
        cols: u32,
        rows: u32,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.clamp(1, u16::MAX as u32) as u16,
                cols: cols.clamp(1, u16::MAX as u32) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("创建本地 PTY 失败: {e}"))?;
        let (slave, master) = (pair.slave, pair.master);

        let cmd = shell_command(&config);
        let child = slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动本地 shell 失败: {e}"))?;
        // spawn 后 slave 可释放（子进程独立存活，master 负责 IO 与 resize）
        drop(slave);

        let writer = master
            .take_writer()
            .map_err(|e| format!("获取 PTY 写入端失败: {e}"))?;

        Ok(Self {
            master: Arc::new(Mutex::new(master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            session_id,
            is_connected: Arc::new(Mutex::new(true)),
            disconnect_handler: Arc::new(Mutex::new(None)),
        })
    }

    /// 注册会话退出（子进程退出/读端 EOF）时由 manager 执行的回调。
    pub fn set_disconnect_handler(&self, handler: Box<dyn FnOnce() + Send>) {
        *self.disconnect_handler.lock().unwrap() = Some(handler);
    }

    /// 启动输出读取线程：从 PTY master 读子进程输出并 emit 到 session-{id}。
    pub fn start_read_loop<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let session_id = self.session_id.clone();
        let master = self.master.clone();
        let child = self.child.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();

        // 读线程建立时先取 reader（读端独立于写端，可并发）
        let reader = {
            let m = master.lock().unwrap();
            m.try_clone_reader()
        };
        let mut reader = match reader {
            Ok(r) => r,
            Err(e) => {
                emit_session_event(
                    &app_handle,
                    &session_id,
                    &SessionEvent::Error {
                        message: format!("获取 PTY 读端失败: {e}"),
                    },
                );
                emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                *is_connected.lock().unwrap() = false;
                let handler = disconnect_handler.lock().unwrap().take();
                if let Some(handler) = handler {
                    handler();
                }
                return;
            }
        };

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            // 跨 read 的 UTF-8 增量解码缓冲（多字节字符可能跨 8192 边界）
            let mut utf8_pending: Vec<u8> = Vec::with_capacity(8192 + 4);
            loop {
                if !*is_connected.lock().unwrap() {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        // slave 关闭（子进程退出）：EOF
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                    Ok(n) => {
                        utf8_pending.extend_from_slice(&buffer[..n]);
                        // 只把「已完整」前缀转字符串发出，不完整尾部留给下次 read
                        let mut idx = 0;
                        while idx < utf8_pending.len() {
                            match std::str::from_utf8(&utf8_pending[idx..]) {
                                Ok(_) => {
                                    let s = String::from_utf8(utf8_pending.split_off(idx))
                                        .unwrap_or_default();
                                    if !s.is_empty() {
                                        emit_session_event(
                                            &app_handle,
                                            &session_id,
                                            &SessionEvent::Output { data: s },
                                        );
                                    }
                                    idx = 0;
                                    break;
                                }
                                Err(e) => {
                                    let valid = e.valid_up_to();
                                    if valid > 0 {
                                        let s = String::from_utf8(
                                            utf8_pending[idx..idx + valid].to_vec(),
                                        )
                                        .unwrap_or_default();
                                        idx += valid;
                                        emit_session_event(
                                            &app_handle,
                                            &session_id,
                                            &SessionEvent::Output { data: s },
                                        );
                                    } else if e.error_len().is_none() {
                                        break; // 不完整序列，等下次补齐
                                    } else {
                                        // 非法字节：替换 U+FFFD
                                        let bad = e.error_len().unwrap_or(1);
                                        idx += bad;
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
                        if idx > 0 {
                            utf8_pending.drain(..idx);
                        }
                    }
                    Err(e) => {
                        // 读错误：正常退出（子进程关闭管道）或异常，统一按断开处理
                        let _ = e;
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                }
            }

            *is_connected.lock().unwrap() = false;
            // 尽力回收子进程（可能已退出，忽略错误）
            let mut child_guard = child.lock().unwrap();
            let _ = child_guard.wait();

            let handler = disconnect_handler.lock().unwrap().take();
            if let Some(handler) = handler {
                handler();
            }
        });
    }

    pub fn write_data(&self, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        if !*self.is_connected.lock().unwrap() {
            return Err("本地终端会话已断开".to_string());
        }
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("写入本地终端失败: {e}"))?;
        writer.flush().map_err(|e| format!("刷新本地终端失败: {e}"))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows: rows.clamp(1, u16::MAX as u32) as u16,
                cols: cols.clamp(1, u16::MAX as u32) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整本地终端尺寸失败: {e}"))
    }

    pub fn disconnect(&self) -> Result<(), String> {
        *self.is_connected.lock().unwrap() = false;
        // kill 子进程：读线程的 read 会随管道关闭返回 EOF/错误而退出
        let mut child = self.child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        Ok(())
    }
}
