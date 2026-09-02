use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::session_events::{emit_session_event, SessionEvent};

/// 终端写入退避上限（毫秒）。
const MAX_WRITE_BACKOFF_MS: u64 = 64;
/// 单次 write_data 总超时（秒）。
const WRITE_DEADLINE_SECS: u64 = 30;

/// telnet 连接配置（无认证，明文协议）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
}

pub struct TelnetSession {
    stream: Arc<Mutex<TcpStream>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}

/// telnet 可接受的协商选项：BINARY(0) / ECHO(1) / SGA(3)。
fn is_acceptable_option(opt: u8) -> bool {
    matches!(opt, 0 | 1 | 3)
}

/// 把输入转为 telnet NVT 换行约定（CR / LF / CRLF 统一为 CRLF）。
fn to_nvt(data: &str) -> String {
    let mut out = String::with_capacity(data.len() + 8);
    let mut chars = data.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            out.push_str("\r\n");
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
        } else if ch == '\n' {
            out.push_str("\r\n");
        } else {
            out.push(ch);
        }
    }
    out
}

/// 处理 telnet 字节流：剥离 IAC 协商序列返回纯数据，并发送协商响应。
/// 返回 (纯数据, 未处理完的尾部字节) —— 尾部是跨 read 边界的不完整 IAC 序列，
/// 由调用方暂存到下次 read 拼接。
fn process_telnet(buffer: &[u8], stream: &mut TcpStream) -> (Vec<u8>, Vec<u8>) {
    let mut out = Vec::with_capacity(buffer.len());
    let mut i = 0;
    while i < buffer.len() {
        if buffer[i] != 0xFF {
            out.push(buffer[i]);
            i += 1;
            continue;
        }
        // IAC 命令
        if i + 1 >= buffer.len() {
            break; // 不完整 IAC，留到下次
        }
        match buffer[i + 1] {
            0xFF => {
                out.push(0xFF); // IAC IAC → 字面量 0xFF
                i += 2;
            }
            0xFB => {
                // WILL：服务器声明愿做某选项
                if i + 2 >= buffer.len() {
                    break;
                }
                let opt = buffer[i + 2];
                let resp = if is_acceptable_option(opt) {
                    [0xFF, 0xFD, opt] // DO
                } else {
                    [0xFF, 0xFE, opt] // DONT
                };
                let _ = stream.write_all(&resp);
                i += 3;
            }
            0xFC => {
                // WONT：服务器拒绝
                if i + 2 >= buffer.len() {
                    break;
                }
                let _ = stream.write_all(&[0xFF, 0xFE, buffer[i + 2]]); // DONT
                i += 3;
            }
            0xFD => {
                // DO：要求客户端做某选项
                if i + 2 >= buffer.len() {
                    break;
                }
                let opt = buffer[i + 2];
                let resp = if is_acceptable_option(opt) {
                    [0xFF, 0xFB, opt] // WILL
                } else {
                    [0xFF, 0xFC, opt] // WONT
                };
                let _ = stream.write_all(&resp);
                i += 3;
            }
            0x0FE => {
                // DONT：要求客户端不做
                if i + 2 >= buffer.len() {
                    break;
                }
                let _ = stream.write_all(&[0xFF, 0xFC, buffer[i + 2]]); // WONT
                i += 3;
            }
            0xFA => {
                // SB 子协商：跳过直到 IAC SE
                let mut j = i + 2;
                let mut found = false;
                while j + 1 < buffer.len() {
                    if buffer[j] == 0xFF && buffer[j + 1] == 0xF0 {
                        found = true;
                        break;
                    }
                    j += 1;
                }
                if found {
                    i = j + 2;
                } else {
                    break; // 不完整 SB，留到下次
                }
            }
            _ => {
                i += 2; // 未知 IAC 命令，跳过
            }
        }
    }
    let remaining = buffer[i..].to_vec();
    (out, remaining)
}

impl TelnetSession {
    pub fn connect(
        config: TelnetConfig,
        session_id: String,
        timeout_secs: u32,
    ) -> Result<Self, String> {
        let timeout = timeout_secs.max(1);
        let addr = format!("{}:{}", config.host, config.port);
        let sock_addr = addr
            .to_socket_addrs()
            .map_err(|e| format!("Failed to resolve {addr}: {e}"))?
            .next()
            .ok_or_else(|| format!("No address resolved for telnet host: {addr}"))?;
        let stream = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(timeout as u64))
            .map_err(|e| format!("Failed to connect to {addr}: {e}"))?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        stream.set_nonblocking(true).map_err(|e| e.to_string())?;
        Ok(Self {
            stream: Arc::new(Mutex::new(stream)),
            session_id,
            is_connected: Arc::new(Mutex::new(true)),
            disconnect_handler: Arc::new(Mutex::new(None)),
        })
    }

    /// 注册会话退出（EOF/错误/断开）时由 manager 执行的回调。
    pub fn set_disconnect_handler(&self, handler: Box<dyn FnOnce() + Send>) {
        *self.disconnect_handler.lock().unwrap() = Some(handler);
    }

    /// 启动输出读取线程：处理 telnet 协商并把纯数据 emit 到 session-{id}。
    pub fn start_read_loop<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let session_id = self.session_id.clone();
        let stream_arc = self.stream.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            // telnet 协商的跨块缓冲（不完整的 IAC 序列留到下次）
            let mut pending: Vec<u8> = Vec::new();
            // UTF-8 跨块解码缓冲
            let mut utf8_pending: Vec<u8> = Vec::with_capacity(8192 + 4);
            loop {
                if !*is_connected.lock().unwrap() {
                    break;
                }
                let mut stream_guard = stream_arc.lock().unwrap();
                match stream_guard.read(&mut buffer) {
                    Ok(0) => {
                        drop(stream_guard);
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&buffer[..n]);
                        let (mut data, remaining) = process_telnet(&pending, &mut stream_guard);
                        pending = remaining;
                        drop(stream_guard);
                        if !data.is_empty() {
                            // UTF-8 增量解码（与 SSH 读线程一致），避免多字节字符跨块乱码
                            utf8_pending.append(&mut data);
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
                                        } else {
                                            // 开头即不完整序列或非法字节
                                            if e.error_len().is_none() {
                                                break; // 不完整，等下次补齐
                                            }
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
                            // 清掉已消费的前缀
                            if idx > 0 {
                                utf8_pending.drain(..idx);
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        drop(stream_guard);
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(e) => {
                        drop(stream_guard);
                        emit_session_event(
                            &app_handle,
                            &session_id,
                            &SessionEvent::Error {
                                message: e.to_string(),
                            },
                        );
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                }
            }

            *is_connected.lock().unwrap() = false;
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
        let telnet_data = to_nvt(data);
        let bytes = telnet_data.as_bytes();
        let mut remaining = bytes;
        let mut backoff_ms: u64 = 1;
        let deadline = std::time::Instant::now() + Duration::from_secs(WRITE_DEADLINE_SECS);

        while !remaining.is_empty() {
            if !*self.is_connected.lock().unwrap() {
                return Err("Telnet session disconnected while writing".to_string());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Timed out writing to telnet (peer not draining)".to_string());
            }
            let mut stream = self.stream.lock().map_err(|e| e.to_string())?;
            match stream.write(remaining) {
                Ok(n) if n > 0 => {
                    remaining = &remaining[n..];
                    backoff_ms = 1;
                }
                Ok(_) => {
                    drop(stream);
                    thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(MAX_WRITE_BACKOFF_MS);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    drop(stream);
                    thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(MAX_WRITE_BACKOFF_MS);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        *self.is_connected.lock().unwrap() = false;
        let stream = self.stream.lock().map_err(|e| e.to_string())?;
        stream.shutdown(Shutdown::Both).map_err(|e| e.to_string())
    }
}
