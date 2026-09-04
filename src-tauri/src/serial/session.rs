//! 串口会话：打开 COM/tty 端口、阻塞读线程 emit 输出、写路径阻塞重试。

use crate::serial::PORT_READ_TIMEOUT_MS;
use crate::session_events::{emit_session_event, SessionEvent};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// 单次 write_data 总超时（秒）。
const WRITE_DEADLINE_SECS: u64 = 30;
/// 写退避上限（毫秒）。
const MAX_WRITE_BACKOFF_MS: u64 = 64;

/// 串口连接配置（camelCase 与前端对齐）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    /// 端口名：Windows `COM3` / POSIX `/dev/ttyUSB0`（列表来自 serial_list_ports）
    pub port: String,
    pub baud_rate: u32,
    /// 数据位：5/6/7/8（默认 8）
    pub data_bits: Option<u8>,
    /// 停止位：1/2（默认 1）
    pub stop_bits: Option<u8>,
    /// 校验：none/odd/even（默认 none）
    pub parity: Option<String>,
    /// 流控：none/hardware（默认 none）
    pub flow_control: Option<String>,
}

/// 校验 + 归一化串口参数（返回可直接 open 的参数）。
pub fn normalized_params(
    cfg: &SerialConfig,
) -> Result<(String, u32, DataBits, StopBits, Parity, FlowControl), String> {
    let port = cfg.port.trim();
    if port.is_empty() {
        return Err("串口端口不能为空，请先选择 COM/tty 端口。".to_string());
    }
    if cfg.baud_rate == 0 {
        return Err("波特率不能为 0。".to_string());
    }
    let data_bits = match cfg.data_bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => return Err("数据位仅支持 5/6/7/8。".to_string()),
    };
    let stop_bits = match cfg.stop_bits.unwrap_or(1) {
        1 => StopBits::One,
        2 => StopBits::Two,
        _ => return Err("停止位仅支持 1/2。".to_string()),
    };
    let parity = match cfg.parity.as_deref().unwrap_or("none") {
        "none" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        other => return Err(format!("不支持的校验方式: {other}")),
    };
    let flow_control = match cfg.flow_control.as_deref().unwrap_or("none") {
        "none" => FlowControl::None,
        "hardware" => FlowControl::Hardware,
        other => return Err(format!("不支持的流控方式: {other}")),
    };
    Ok((port.to_string(), cfg.baud_rate, data_bits, stop_bits, parity, flow_control))
}

pub struct SerialSession {
    /// 串口句柄（None = 已断开）。阻塞读超时轮询，disconnect 置 None 唤醒读线程。
    port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}

impl SerialSession {
    /// 打开串口（阻塞、短时）。不启动读线程；由 connect 命令 open 后调 start_read_loop。
    pub fn open(config: &SerialConfig) -> Result<Self, String> {
        let (port_name, baud_rate, data_bits, stop_bits, parity, flow_control) =
            normalized_params(config)?;

        let port = serialport::new(&port_name, baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .flow_control(flow_control)
            // 串口无连接概念：打开失败（占用/不存在）即报错
            .timeout(Duration::from_millis(PORT_READ_TIMEOUT_MS))
            .open()
            .map_err(|e| format!("无法打开串口 {port_name}: {e}"))?;

        Ok(Self {
            port: Arc::new(Mutex::new(Some(port))),
            session_id: String::new(),
            is_connected: Arc::new(Mutex::new(true)),
            disconnect_handler: Arc::new(Mutex::new(None)),
        })
    }

    /// 打开后注入 session id（连接命令创建后设置，避免构造参数冗长）。
    pub fn set_session_id(&mut self, session_id: String) {
        self.session_id = session_id;
    }

    /// 注册会话退出回调（读线程收尾时执行，manager 据此从注册表移除）。
    pub fn set_disconnect_handler(&self, handler: Box<dyn FnOnce() + Send>) {
        *self.disconnect_handler.lock().unwrap() = Some(handler);
    }

    /// 启动输出读取线程：阻塞读（100ms 超时轮询）→ UTF-8 增量解码 → Output 事件。
    pub fn start_read_loop<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let session_id = self.session_id.clone();
        let port_arc = self.port.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut utf8_pending: Vec<u8> = Vec::with_capacity(8192 + 4);
            let mut disconnected: Option<String> = None;

            loop {
                if !*is_connected.lock().unwrap() {
                    break;
                }
                let read_result = {
                    let mut guard = port_arc.lock().unwrap();
                    match guard.as_mut() {
                        None => {
                            drop(guard);
                            break;
                        }
                        Some(port) => port.read(&mut buffer),
                    }
                };
                match read_result {
                    Ok(0) => {
                        // 串口一般不会返回 0；防呆处理：视为瞬时无数据
                        thread::sleep(Duration::from_millis(10));
                    }
                    Ok(n) => {
                        utf8_pending.extend_from_slice(&buffer[..n]);
                        flush_utf8(&mut utf8_pending, &app_handle, &session_id, &mut disconnected);
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::Interrupted =>
                    {
                        // read_timeout 到期：无新数据，周期醒来检查断开标志
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => {
                        disconnected = Some(format!("串口读取失败: {e}"));
                        break;
                    }
                }
            }

            *is_connected.lock().unwrap() = false;
            // 释放句柄（读循环已结束，无人持锁）
            if let Ok(mut guard) = port_arc.lock() {
                *guard = None;
            }
            if let Some(msg) = disconnected {
                emit_session_event(&app_handle, &session_id, &SessionEvent::Error {
                    message: msg,
                });
            }
            emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
            let handler = disconnect_handler.lock().unwrap().take();
            if let Some(handler) = handler {
                handler();
            }
        });
    }

    /// 写入数据（阻塞句柄 + 退避重试，与 telnet 写路径一致）。
    pub fn write_data(&self, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let bytes = data.as_bytes();
        let mut remaining = bytes;
        let mut backoff_ms: u64 = 1;
        let deadline = std::time::Instant::now() + Duration::from_secs(WRITE_DEADLINE_SECS);

        while !remaining.is_empty() {
            if !*self.is_connected.lock().unwrap() {
                return Err("串口会话已断开，无法写入。".to_string());
            }
            if std::time::Instant::now() >= deadline {
                return Err("写入串口超时（设备未响应）。".to_string());
            }
            let mut guard = self.port.lock().map_err(|e| e.to_string())?;
            match guard.as_mut() {
                None => return Err("串口会话已断开。".to_string()),
                Some(port) => match port.write(remaining) {
                    Ok(n) if n > 0 => {
                        remaining = &remaining[n..];
                        backoff_ms = 1;
                    }
                    Ok(_) => {
                        drop(guard);
                        thread::sleep(Duration::from_millis(backoff_ms));
                        backoff_ms = (backoff_ms * 2).min(MAX_WRITE_BACKOFF_MS);
                    }
                    Err(e) => return Err(format!("写入串口失败: {e}")),
                },
            }
        }
        Ok(())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        *self.is_connected.lock().unwrap() = false;
        // 释放句柄唤醒读线程（读线程会补发 Disconnected 事件并自查自删）
        if let Ok(mut guard) = self.port.lock() {
            *guard = None;
        }
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        *self.is_connected.lock().unwrap()
    }
}

/// 把累积字节按 UTF-8 增量边界刷成 Output 事件；非法字节替换 U+FFFD。
fn flush_utf8<R: tauri::Runtime>(
    pending: &mut Vec<u8>,
    app: &tauri::AppHandle<R>,
    session_id: &str,
    disconnected: &mut Option<String>,
) {
    let mut idx = 0;
    loop {
        if idx >= pending.len() {
            break;
        }
        match std::str::from_utf8(&pending[idx..]) {
            Ok(_) => {
                let s = String::from_utf8(pending.split_off(idx)).unwrap_or_default();
                if !s.is_empty() {
                    emit_session_event(app, session_id, &SessionEvent::Output { data: s });
                }
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    let s = String::from_utf8(pending[idx..idx + valid].to_vec()).unwrap_or_default();
                    emit_session_event(app, session_id, &SessionEvent::Output { data: s });
                    idx += valid;
                } else if e.error_len().is_none() {
                    break; // 不完整，等下次数据补齐
                } else {
                    let bad = e.error_len().unwrap_or(1);
                    idx += bad;
                    emit_session_event(
                        app,
                        session_id,
                        &SessionEvent::Output {
                            data: "\u{FFFD}".to_string(),
                        },
                    );
                }
            }
        }
    }
    if idx > 0 {
        pending.drain(..idx);
    }
    let _ = disconnected;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> SerialConfig {
        SerialConfig {
            port: "COM3".into(),
            baud_rate: 115200,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
        }
    }

    #[test]
    fn empty_port_rejected() {
        let mut c = base();
        c.port = "  ".into();
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn zero_baud_rejected() {
        let mut c = base();
        c.baud_rate = 0;
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn bad_data_bits_rejected() {
        let mut c = base();
        c.data_bits = Some(9);
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn bad_stop_bits_rejected() {
        let mut c = base();
        c.stop_bits = Some(3);
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn bad_parity_rejected() {
        let mut c = base();
        c.parity = Some("mark".into());
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn bad_flow_control_rejected() {
        let mut c = base();
        c.flow_control = Some("soft".into());
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn defaults_normalized_to_8n1() {
        let (_, _, db, sb, p, fc) = normalized_params(&base()).unwrap();
        assert_eq!(db, DataBits::Eight);
        assert_eq!(sb, StopBits::One);
        assert_eq!(p, Parity::None);
        assert_eq!(fc, FlowControl::None);
    }
}
