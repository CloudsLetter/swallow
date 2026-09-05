//! 串口会话：打开 COM/tty 端口、阻塞读线程 emit 输出、写路径阻塞重试。

use crate::serial::PORT_READ_TIMEOUT_MS;
use crate::session_events::{emit_session_event, SessionEvent};
use encoding_rs::{CoderResult, Encoding};
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
    /// 校验：none/odd/even + mark/space（软件模拟，见 MsbMode；默认 none）
    pub parity: Option<String>,
    /// 流控：none/hardware/software（默认 none；software = XON/XOFF）
    pub flow_control: Option<String>,
    /// 字符集（默认 utf-8）：设备端输出/输入的编码，如 gb18030（GBK/GB2312 兼容）、big5、latin1
    pub charset: Option<String>,
}

/// Mark/Space 校验的软件模拟模式。
///
/// serialport crate 不支持 mark/space parity，但「7 数据位 + 恒定校验位」的帧
/// 与「8 数据位、最高位恒定」逐位相同：底层开 8N1，用第 8 数据位充当校验位——
/// 发方向把 MSB 置成校验值（mark=1 / space=0），收方向剥掉 MSB 再解码。
/// 仅支持 7 数据位帧（8 数据位 + mark/space = 9-bit 帧，标准 UART 无法表达）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsbMode {
    /// Mark：校验位恒 1（发方向 |0x80）
    Force1,
    /// Space：校验位恒 0（发方向 &0x7F）
    Force0,
}

impl MsbMode {
    fn from_parity(p: &str) -> Option<Self> {
        match p {
            "mark" => Some(Self::Force1),
            "space" => Some(Self::Force0),
            _ => None,
        }
    }

    /// 发方向：把每字节最高位修成校验位值。
    pub fn apply_msb(&self, bytes: &mut [u8]) {
        for b in bytes.iter_mut() {
            *b = match self {
                Self::Force1 => *b | 0x80,
                Self::Force0 => *b & 0x7F,
            };
        }
    }
}

/// 收方向：剥掉最高位（mark 帧的 b7 恒 1、space 恒 0，均非数据）。
fn strip_msb(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        *b &= 0x7F;
    }
}

/// 流式解码一段设备端字节到 UTF-8（append 到 out）。
///
/// `decode_to_string` 只写入 dst 的空闲容量、不自动扩容——容量不足时返回
/// OutputFull 且剩余输入不消费。因此这里循环扩容重试直到输入全部消费；
/// 多字节字符跨读边界由 decoder 内部缓冲处理，malformed 字节替换 U+FFFD。
fn decode_chunk(decoder: &mut encoding_rs::Decoder, chunk: &[u8], out: &mut String) {
    let mut src = chunk;
    loop {
        if src.is_empty() {
            return;
        }
        out.reserve(src.len() * 4 + 4);
        let (result, read, _replaced) = decoder.decode_to_string(src, out, false);
        src = &src[read..];
        match result {
            CoderResult::InputEmpty => return,
            CoderResult::OutputFull => continue,
        }
    }
}

/// 流式编码 UTF-8 文本为设备端字节（append 到 out）。
///
/// 同样循环扩容重试：unmappable 字符会替换成数字字符引用（如 &#128512;），
/// 输出可能比输入膨胀数倍。注意必须用 `encode_from_utf8_to_vec`（写入 Vec 的
/// 空闲容量）——裸的 `encode_from_utf8(&mut [u8])` 只按切片长度写，传入空
/// Vec 会永远 OutputFull（死循环）。
fn encode_chunk(encoder: &mut encoding_rs::Encoder, src: &str, out: &mut Vec<u8>) {
    let mut input = src;
    loop {
        if input.is_empty() {
            return;
        }
        out.reserve(input.len() * 4 + 8);
        let (result, read, _had_errors) = encoder.encode_from_utf8_to_vec(input, out, true);
        input = &input[read..];
        match result {
            CoderResult::InputEmpty => return,
            CoderResult::OutputFull => continue,
        }
    }
}

/// 校验 + 归一化串口参数（返回可直接 open 的参数；mark/space 返回 8N1 + MSB 模式）。
pub fn normalized_params(
    cfg: &SerialConfig,
) -> Result<(String, u32, DataBits, StopBits, Parity, FlowControl, Option<MsbMode>), String> {
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
    let parity_str = cfg.parity.as_deref().unwrap_or("none");
    let msb = MsbMode::from_parity(parity_str);
    let (data_bits, parity) = match (parity_str, msb) {
        ("none", _) => (data_bits, Parity::None),
        ("odd", _) => (data_bits, Parity::Odd),
        ("even", _) => (data_bits, Parity::Even),
        (_, Some(mode)) => {
            // 软件模拟：底层开 8N1（第 8 数据位当恒定校验位），要求设备为 7 数据位帧
            if cfg.data_bits.unwrap_or(7) != 7 {
                return Err(
                    "mark/space 校验（软件模拟）仅支持 7 数据位帧，请把数据位设为 7。".to_string(),
                );
            }
            let _ = mode;
            (DataBits::Eight, Parity::None)
        }
        (_, None) => return Err(format!("不支持的校验方式: {parity_str}")),
    };
    let flow_control = match cfg.flow_control.as_deref().unwrap_or("none") {
        "none" => FlowControl::None,
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        other => return Err(format!("不支持的流控方式: {other}")),
    };
    Ok((port.to_string(), cfg.baud_rate, data_bits, stop_bits, parity, flow_control, msb))
}

/// 解析字符集标签（utf-8/gb18030/big5/latin1 等 encoding_rs 支持的标签）。
pub fn resolve_charset(label: Option<&str>) -> Result<&'static Encoding, String> {
    Encoding::for_label(label.unwrap_or("utf-8").as_bytes())
        .ok_or_else(|| format!("不支持的字符集: {}", label.unwrap_or_default()))
}

pub struct SerialSession {
    /// 串口句柄（None = 已断开）。阻塞读超时轮询，disconnect 置 None 唤醒读线程。
    port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
    /// 设备端字符集：读 = 解码成 UTF-8 发前端；写 = 前端 UTF-8 编码回设备端编码
    encoding: &'static Encoding,
    /// mark/space 软件模拟模式（None = 真实校验位由硬件处理）
    msb: Option<MsbMode>,
}

impl SerialSession {
    /// 打开串口（阻塞、短时）。不启动读线程；由 connect 命令 open 后调 start_read_loop。
    pub fn open(config: &SerialConfig) -> Result<Self, String> {
        let (port_name, baud_rate, data_bits, stop_bits, parity, flow_control, msb) =
            normalized_params(config)?;
        let encoding = resolve_charset(config.charset.as_deref())?;

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
            encoding,
            msb,
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

    /// 启动输出读取线程：阻塞读（100ms 超时轮询）→ 按会话字符集流式解码 → Output 事件。
    pub fn start_read_loop<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let session_id = self.session_id.clone();
        let port_arc = self.port.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();
        // &'static Encoding 可跨线程 Copy；流式解码器内部处理多字节字符跨读边界
        let mut decoder = self.encoding.new_decoder();
        let msb = self.msb;

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut decoded_buf: Vec<u8> = Vec::with_capacity(8192);
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
                        // mark/space 软件模拟：先剥掉恒定校验位（第 8 位）再解码
                        let chunk: &[u8] = if msb.is_some() {
                            decoded_buf.clear();
                            decoded_buf.extend_from_slice(&buffer[..n]);
                            strip_msb(&mut decoded_buf);
                            &decoded_buf
                        } else {
                            &buffer[..n]
                        };
                        let mut s = String::new();
                        decode_chunk(&mut decoder, chunk, &mut s);
                        if !s.is_empty() {
                            emit_session_event(&app_handle, &session_id, &SessionEvent::Output { data: s });
                        }
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
    /// 前端输入为 UTF-8，先按会话字符集编码成设备端字节流。
    pub fn write_data(&self, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let mut encoded = Vec::new();
        {
            let mut encoder = self.encoding.new_encoder();
            encode_chunk(&mut encoder, data, &mut encoded);
        }
        // mark/space 软件模拟：把第 8 数据位修成恒定校验位值
        if let Some(mode) = self.msb {
            mode.apply_msb(&mut encoded);
        }
        let bytes = encoded.as_slice();
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
            charset: None,
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
        c.parity = Some("invalid".into());
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn mark_space_emulated_as_8n1() {
        for (p, mode) in [("mark", MsbMode::Force1), ("space", MsbMode::Force0)] {
            let mut c = base();
            c.parity = Some(p.into());
            // 未显式指定数据位时默认按 7 数据位帧处理
            let (_, _, db, _, parity, _, msb) = normalized_params(&c).unwrap();
            assert_eq!(db, DataBits::Eight, "底层应开 8 数据位");
            assert_eq!(parity, Parity::None, "校验位由软件模拟");
            assert_eq!(msb, Some(mode));
        }
    }

    #[test]
    fn mark_space_requires_7_data_bits() {
        let mut c = base();
        c.parity = Some("mark".into());
        c.data_bits = Some(8);
        assert!(normalized_params(&c).is_err());
        c.data_bits = Some(7);
        assert!(normalized_params(&c).is_ok());
    }

    #[test]
    fn msb_transform_roundtrip() {
        // mark：发方向置 1
        let mut bytes = b"ABC\x00".to_vec();
        MsbMode::Force1.apply_msb(&mut bytes);
        assert_eq!(bytes, vec![0xC1, 0xC2, 0xC3, 0x80]);
        // space：发方向清 0
        let mut bytes = b"ABC".to_vec();
        MsbMode::Force0.apply_msb(&mut bytes);
        assert_eq!(bytes, b"ABC".to_vec());
        // 收方向剥位：mark 帧还原成 ASCII
        let mut bytes = vec![0xC1u8, 0xC2, 0xC3];
        strip_msb(&mut bytes);
        assert_eq!(bytes, b"ABC".to_vec());
    }

    #[test]
    fn bad_flow_control_rejected() {
        let mut c = base();
        c.flow_control = Some("foo".into());
        assert!(normalized_params(&c).is_err());
    }

    #[test]
    fn defaults_normalized_to_8n1() {
        let (_, _, db, sb, p, fc, msb) = normalized_params(&base()).unwrap();
        assert_eq!(db, DataBits::Eight);
        assert_eq!(sb, StopBits::One);
        assert_eq!(p, Parity::None);
        assert_eq!(fc, FlowControl::None);
        assert_eq!(msb, None);
    }

    #[test]
    fn flow_and_charset_variants_accepted() {
        let mut c = base();
        c.flow_control = Some("software".into());
        let (_, _, _, _, _, fc, _) = normalized_params(&c).unwrap();
        assert_eq!(fc, FlowControl::Software);
        c.flow_control = Some("hardware".into());
        let (_, _, _, _, _, fc, _) = normalized_params(&c).unwrap();
        assert_eq!(fc, FlowControl::Hardware);
    }

    #[test]
    fn charset_resolved_and_rejected() {
        assert_eq!(resolve_charset(None).unwrap(), encoding_rs::UTF_8);
        assert_eq!(resolve_charset(Some("gb18030")).unwrap(), encoding_rs::GB18030);
        assert_eq!(resolve_charset(Some("big5")).unwrap(), encoding_rs::BIG5);
        assert_eq!(resolve_charset(Some("shift_jis")).unwrap(), encoding_rs::SHIFT_JIS);
        assert_eq!(resolve_charset(Some("euc-jp")).unwrap(), encoding_rs::EUC_JP);
        assert_eq!(resolve_charset(Some("euc-kr")).unwrap(), encoding_rs::EUC_KR);
        assert_eq!(resolve_charset(Some("koi8-r")).unwrap(), encoding_rs::KOI8_R);
        assert_eq!(resolve_charset(Some("windows-1251")).unwrap(), encoding_rs::WINDOWS_1251);
        // WHATWG 标准：latin1/iso-8859-1 标签映射到 windows-1252；
        // encoding_rs 实测 us-ascii 亦映射到 windows-1252（与规范的 UTF-8 不同），勿当 7 位 ASCII 用
        assert_eq!(resolve_charset(Some("latin1")).unwrap(), encoding_rs::WINDOWS_1252);
        assert_eq!(resolve_charset(Some("us-ascii")).unwrap(), encoding_rs::WINDOWS_1252);
        assert!(resolve_charset(Some("not-a-charset")).is_err());
    }

    #[test]
    fn decode_chunk_survives_capacity_expansion() {
        // 回归：decode_to_string 只用 dst 空闲容量，GB18030 的 0x80 → U+20AC（1 字节膨胀
        // 成 3 字节 UTF-8），大块输入若不循环扩容会静默丢数据
        let mut decoder = encoding_rs::GB18030.new_decoder();
        let input = vec![0x80u8; 30_000];
        let mut out = String::new();
        decode_chunk(&mut decoder, &input, &mut out);
        assert_eq!(out, "\u{20AC}".repeat(30_000));
    }

    #[test]
    fn decode_chunk_buffers_partial_multibyte_across_reads() {
        // GB18030「中」= D6 D0（2 字节），拆到两次读入不丢字
        let mut decoder = encoding_rs::GB18030.new_decoder();
        let mut out = String::new();
        decode_chunk(&mut decoder, &[0xD6], &mut out);
        assert!(out.is_empty());
        decode_chunk(&mut decoder, &[0xD0], &mut out);
        assert_eq!(out, "中");
    }

    #[test]
    fn encode_chunk_survives_unmappable_expansion() {
        // 回归：unmappable 字符替换成数字字符引用（4 字节 UTF-8 → 10 字节 ASCII），
        // 大块文本不循环扩容会静默丢数据
        let mut encoder = encoding_rs::BIG5.new_encoder();
        let input = "\u{1F600}".repeat(20_000);
        let mut out = Vec::new();
        encode_chunk(&mut encoder, &input, &mut out);
        assert_eq!(out, b"&#128512;".repeat(20_000));
    }

    #[test]
    fn encode_chunk_gb18030_bytes() {
        let mut encoder = encoding_rs::GB18030.new_encoder();
        let mut out = Vec::new();
        encode_chunk(&mut encoder, "hello 你好", &mut out);
        // 「你」= C4 E3、「好」= BA C3（GB18030 双字节，与 GBK 兼容）；ASCII 段 1:1
        assert_eq!(out, b"hello \xC4\xE3\xBA\xC3".to_vec());
    }
}
