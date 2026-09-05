//! RDP 会话泵：IronRDP 协议客户端 ↔ 前端 WebSocket。
//!
//! 上行（Rust → 前端）：
//! - Binary：脏矩形瓦片帧（`FRAME_MAGIC` 开头，见 `FrameEncoder`）；
//! - Text(JSON)：status / error / closed / pointer 控制事件。
//! 下行（前端 → Rust，Text(JSON)）：
//! - `{type:"input", op:{kind:"mouseMove"|"mouseButton"|"wheel"|"key", ...}}`；
//! - `{type:"resize", width, height}`。
//!
//! 键盘：优先按 `KeyboardEvent.code`（物理位置）映射 RDP set-1 scancode（RDP 是
//! 物理位置语义，与服务器键盘布局无关）；无映射且为单字符时走 Unicode 键事件
//! （符号 / 组合字符兜底），二者只取其一防重复输入。

use crate::rdp::{bridge, FRAME_KIND_TILES, FRAME_MAGIC, TILE_SIZE};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use ironrdp_client::config::Config;
use ironrdp_client::rdp::{RdpClient, RdpInputEvent, RdpOutputEvent};
use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use serde::Deserialize;
use smallvec::{smallvec, SmallVec};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message;

use super::manager::RdpEntry;

/// 协议泵收尾时等待优雅断开的窗口。
const GRACEFUL_DISCONNECT_SECS: u64 = 3;
/// 空闲时检查 stop 标志的周期（stop 命中后 ≤250ms 内收尾）。
const STOP_POLL_INTERVAL_MS: u64 = 250;
/// RdpClient 输出事件队列深度：每事件为全屏 RGBA（1080p ≈ 8MB），过深徒增内存。
const OUTPUT_CHANNEL_CAPACITY: usize = 4;

// ==================== WS 消息（下行 JSON 控制事件） ====================

fn ev_error(message: String) -> Message {
    Message::text(serde_json::json!({ "type": "error", "message": message }).to_string())
}

/// `message` 为 Some 表示异常终止（协议错误 / 会话错误），None 表示正常断开。
fn ev_closed(message: Option<String>) -> Message {
    let mut v = serde_json::json!({ "type": "closed" });
    if let Some(m) = message {
        v["message"] = serde_json::Value::String(m);
    }
    Message::text(v.to_string())
}

fn ev_pointer(shape: &str) -> Message {
    Message::text(serde_json::json!({ "type": "pointer", "shape": shape }).to_string())
}

fn ev_pointer_bitmap(width: u16, height: u16, hotspot_x: u16, hotspot_y: u16, rgba: &[u8]) -> Message {
    let rgba = base64::engine::general_purpose::STANDARD.encode(rgba);
    Message::text(
        serde_json::json!({
            "type": "pointer",
            "shape": "bitmap",
            "width": width,
            "height": height,
            "hotspotX": hotspot_x,
            "hotspotY": hotspot_y,
            "rgba": rgba,
        })
        .to_string(),
    )
}

// ==================== WS 消息（上行：输入 / 分辨率） ====================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsClientMessage {
    #[serde(rename = "type")]
    kind: String,
    op: Option<InputOp>,
    width: Option<u16>,
    height: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InputOp {
    MouseMove { x: u16, y: u16 },
    MouseButton { button: String, pressed: bool },
    Wheel { vertical: bool, units: i16 },
    Key { code: String, key: String, pressed: bool },
    /// IME 组合完成的整段文本：按字符依次发 Unicode 按下/抬起对。
    Text { text: String },
}

/// `KeyboardEvent.code` → RDP set-1 scancode（扩展键标志, 基础码）。
/// 物理位置语义：与本地键盘布局无关（US 布局坐标即 RDP 期望值）。
fn scancode_for(code: &str) -> Option<(bool, u8)> {
    let sc: u8 = match code {
        "Escape" => 0x01,
        "Digit1" => 0x02,
        "Digit2" => 0x03,
        "Digit3" => 0x04,
        "Digit4" => 0x05,
        "Digit5" => 0x06,
        "Digit6" => 0x07,
        "Digit7" => 0x08,
        "Digit8" => 0x09,
        "Digit9" => 0x0A,
        "Digit0" => 0x0B,
        "Minus" => 0x0C,
        "Equal" => 0x0D,
        "Backspace" => 0x0E,
        "Tab" => 0x0F,
        "KeyQ" => 0x10,
        "KeyW" => 0x11,
        "KeyE" => 0x12,
        "KeyR" => 0x13,
        "KeyT" => 0x14,
        "KeyY" => 0x15,
        "KeyU" => 0x16,
        "KeyI" => 0x17,
        "KeyO" => 0x18,
        "KeyP" => 0x19,
        "BracketLeft" => 0x1A,
        "BracketRight" => 0x1B,
        "Enter" => 0x1C,
        "ControlLeft" => 0x1D,
        "KeyA" => 0x1E,
        "KeyS" => 0x1F,
        "KeyD" => 0x20,
        "KeyF" => 0x21,
        "KeyG" => 0x22,
        "KeyH" => 0x23,
        "KeyJ" => 0x24,
        "KeyK" => 0x25,
        "KeyL" => 0x26,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29,
        "ShiftLeft" => 0x2A,
        "Backslash" => 0x2B,
        "KeyZ" => 0x2C,
        "KeyX" => 0x2D,
        "KeyC" => 0x2E,
        "KeyV" => 0x2F,
        "KeyB" => 0x30,
        "KeyN" => 0x31,
        "KeyM" => 0x32,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "ShiftRight" => 0x36,
        "NumpadMultiply" => 0x37,
        "AltLeft" => 0x38,
        "Space" => 0x39,
        "CapsLock" => 0x3A,
        "F1" => 0x3B,
        "F2" => 0x3C,
        "F3" => 0x3D,
        "F4" => 0x3E,
        "F5" => 0x3F,
        "F6" => 0x40,
        "F7" => 0x41,
        "F8" => 0x42,
        "F9" => 0x43,
        "F10" => 0x44,
        "NumLock" => 0x45,
        "ScrollLock" => 0x46,
        "Numpad7" => 0x47,
        "Numpad8" => 0x48,
        "Numpad9" => 0x49,
        "NumpadSubtract" => 0x4A,
        "Numpad4" => 0x4B,
        "Numpad5" => 0x4C,
        "Numpad6" => 0x4D,
        "NumpadAdd" => 0x4E,
        "Numpad1" => 0x4F,
        "Numpad2" => 0x50,
        "Numpad3" => 0x51,
        "Numpad0" => 0x52,
        "NumpadDecimal" => 0x53,
        "F11" => 0x57,
        "F12" => 0x58,
        // ---- 扩展键（0xE0 前缀）----
        "MetaLeft" => return Some((true, 0x5B)),
        "MetaRight" => return Some((true, 0x5C)),
        "ContextMenu" => return Some((true, 0x5D)),
        "Insert" => return Some((true, 0x52)),
        "Home" => return Some((true, 0x47)),
        "PageUp" => return Some((true, 0x49)),
        "Delete" => return Some((true, 0x53)),
        "End" => return Some((true, 0x4F)),
        "PageDown" => return Some((true, 0x51)),
        "ArrowUp" => return Some((true, 0x48)),
        "ArrowLeft" => return Some((true, 0x4B)),
        "ArrowRight" => return Some((true, 0x4D)),
        "ArrowDown" => return Some((true, 0x50)),
        "NumpadDivide" => return Some((true, 0x35)),
        "NumpadEnter" => return Some((true, 0x1C)),
        "ControlRight" => return Some((true, 0x1D)),
        "AltRight" => return Some((true, 0x38)),
        "PrintScreen" => return Some((true, 0x37)),
        _ => return None,
    };
    Some((false, sc))
}

/// 单个输入操作 → 协议输入事件（Database 会做状态跟踪与编码）。
fn operations_for(op: InputOp) -> SmallVec<[Operation; 4]> {
    match op {
        InputOp::MouseMove { x, y } => smallvec![Operation::MouseMove(MousePosition { x, y })],
        InputOp::MouseButton { button, pressed } => {
            let b = match button.as_str() {
                "left" => MouseButton::Left,
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                "x1" => MouseButton::X1,
                "x2" => MouseButton::X2,
                _ => return SmallVec::new(),
            };
            if pressed {
                smallvec![Operation::MouseButtonPressed(b)]
            } else {
                smallvec![Operation::MouseButtonReleased(b)]
            }
        }
        InputOp::Wheel { vertical, units } => smallvec![Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: units,
        })],
        // IME 组合文本：逐字符 Unicode 按下/抬起（Database 跟踪 unicode 按键状态）
        InputOp::Text { text } => text
            .chars()
            .flat_map(|c| [Operation::UnicodeKeyPressed(c), Operation::UnicodeKeyReleased(c)])
            .collect(),
        InputOp::Key { code, key, pressed } => match scancode_for(&code) {
            Some((ext, sc)) => {
                let sc = Scancode::from_u8(ext, sc);
                if pressed {
                    smallvec![Operation::KeyPressed(sc)]
                } else {
                    smallvec![Operation::KeyReleased(sc)]
                }
            }
            // 无 scancode 映射的单字符（符号 / 组合字符）：Unicode 键事件兜底
            None => {
                let chars: Vec<char> = key.chars().collect();
                if chars.len() != 1 {
                    return SmallVec::new();
                }
                let c = chars[0];
                if pressed {
                    smallvec![Operation::UnicodeKeyPressed(c)]
                } else {
                    smallvec![Operation::UnicodeKeyReleased(c)]
                }
            }
        },
    }
}

// ==================== 瓦片差分帧编码 ====================

/// IronRDP 全屏帧 → 脏矩形瓦片二进制消息。
///
/// 二进制布局（小端）：
/// `[RDF][ver=1][kind=1] width:u16 height:u16 tile:u8 count:u32`
/// 之后每瓦片：`tx:u16 ty:u16 tw:u16 th:u16` + RGBA 数据（tw*th*4 字节）。
/// 首帧 prev 全零 → 全屏作为瓦片集合下发；分辨率变化整体重置。
struct FrameEncoder {
    /// 上一帧像素（与 IronRDP 输出同格式 u32，直接比较避免逐字节转换）
    prev: Vec<u32>,
    width: u16,
    height: u16,
    sent_any: bool,
}

const TILE: usize = TILE_SIZE as usize;

impl FrameEncoder {
    fn new() -> Self {
        Self {
            prev: Vec::new(),
            width: 0,
            height: 0,
            sent_any: false,
        }
    }

    /// 输入为 IronRDP `RdpOutputEvent::Image` 的全屏像素（`u32::from_be_bytes([0,r,g,b])`）。
    /// 返回 None = 与上帧完全一致，无需发送。
    ///
    /// 性能关键：diff 直接在 u32 上比较（等价 4 字节 memcmp），只为脏瓦片行做
    /// RGBA 转换——典型更新（光标闪烁/局部重绘）每帧只转换极小区域，
    /// 避免整屏 8MB 的两趟内存搬运。
    fn encode(&mut self, pixels: &[u32], width: u16, height: u16) -> Option<Vec<u8>> {
        if width == 0
            || height == 0
            || pixels.len() != u32::from(width) as usize * u32::from(height) as usize
        {
            return None;
        }
        let w = width as usize;
        let h = height as usize;
        if self.width != width || self.height != height {
            // 填充不可能由 [0,r,g,b] 组成的值，强制首帧/尺寸变化后全脏
            self.prev = vec![u32::MAX; pixels.len()];
            self.width = width;
            self.height = height;
            self.sent_any = false;
        }

        let tiles_x = w.div_ceil(TILE);
        let tiles_y = h.div_ceil(TILE);
        let mut tiles: Vec<u8> = Vec::new();
        let mut count: u32 = 0;

        for ty in 0..tiles_y {
            for tx in 0..tiles_x {
                let x0 = tx * TILE;
                let y0 = ty * TILE;
                let tw = TILE.min(w - x0);
                let th = TILE.min(h - y0);
                let mut changed = !self.sent_any;
                if !changed {
                    for row in 0..th {
                        let off = (y0 + row) * w + x0;
                        if pixels[off..off + tw] != self.prev[off..off + tw] {
                            changed = true;
                            break;
                        }
                    }
                }
                if !changed {
                    continue;
                }
                count += 1;
                tiles.extend_from_slice(&(x0 as u16).to_le_bytes());
                tiles.extend_from_slice(&(y0 as u16).to_le_bytes());
                tiles.extend_from_slice(&(tw as u16).to_le_bytes());
                tiles.extend_from_slice(&(th as u16).to_le_bytes());
                for row in 0..th {
                    let off = (y0 + row) * w + x0;
                    for p in &pixels[off..off + tw] {
                        let be = p.to_be_bytes(); // [0, r, g, b]
                        tiles.extend_from_slice(&[be[1], be[2], be[3], 0xFF]);
                    }
                }
            }
        }

        if count == 0 {
            return None;
        }

        let mut msg = Vec::with_capacity(12 + tiles.len());
        msg.extend_from_slice(&FRAME_MAGIC);
        msg.push(1); // version
        msg.push(FRAME_KIND_TILES);
        msg.extend_from_slice(&width.to_le_bytes());
        msg.extend_from_slice(&height.to_le_bytes());
        msg.push(TILE_SIZE);
        msg.extend_from_slice(&count.to_le_bytes());
        msg.extend_from_slice(&tiles);

        // prev 更新为当前帧（逐行已在比较中跳过相同行，此处整块拷贝最快）
        self.prev.copy_from_slice(pixels);
        self.sent_any = true;
        Some(msg)
    }
}

// ==================== 会话主流程 ====================

fn self_remove(registry: &Arc<Mutex<HashMap<String, RdpEntry>>>, session_id: &str, token: &str) {
    if let Ok(mut map) = registry.lock() {
        // 仅当该会话仍是本实例（token 相同）时移除，避免误删重连后的新会话
        let same = map.get(session_id).map(|e| e.token == token).unwrap_or(false);
        if same {
            map.remove(session_id);
        }
    }
}

/// RDP 会话主流程：等前端 WebSocket 连入 → 启动 IronRDP 客户端 → 双向泵 →
/// 结束后优雅断开协议会话并自查自删注册表。
pub async fn run_session(
    config: Config,
    listener: tokio::net::TcpListener,
    session_id: String,
    token: String,
    stop: Arc<AtomicBool>,
    registry: Arc<Mutex<HashMap<String, RdpEntry>>>,
) {
    let Some(ws) = bridge::accept_client(listener, session_id.clone(), token.clone(), stop.clone()).await else {
        // 窗口期内前端未连入（或被 stop）：自清
        self_remove(&registry, &session_id, &token);
        return;
    };
    let (mut ws_tx, mut ws_rx) = ws.split();

    let (output_tx, mut output_rx) = mpsc::channel::<RdpOutputEvent>(OUTPUT_CHANNEL_CAPACITY);
    let client = RdpClient::new(config, output_tx);
    let input_sender = client.input_sender();
    // IronRDP 官方 viewer 同款：client.run() 的 future 因内部 connector 状态机的
    // higher-ranked lifetime 无法通过 tokio::spawn 的 Send 检查，改在专用线程跑
    // 独立 current-thread runtime；与泵之间用 tokio mpsc 通信（runtime 无关）。
    let thread_name = format!("rdp-client-{session_id}");
    let run_thread = std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(client.run());
        });

    let db = Mutex::new(Database::new());
    let mut encoder = FrameEncoder::new();
    let mut ws_alive = true;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        tokio::select! {
            biased;

            _ = tokio::time::sleep(Duration::from_millis(STOP_POLL_INTERVAL_MS)) => {}

            ev = output_rx.recv() => {
                match ev {
                    None => break, // client.run() 已结束
                    Some(first) => {
                        // 批量合并：突发更新（打字/滚屏会产生连发 Image 事件）只编码
                        // 最新一帧——Image 是全屏帧缓冲快照，中间帧必被新帧覆盖，
                        // 逐帧编码白做 N-1 次。指针/终止事件仍逐个处理。
                        let mut batch = vec![first];
                        while let Ok(e) = output_rx.try_recv() {
                            batch.push(e);
                        }
                        let mut out_msgs: Vec<Message> = Vec::new();
                        let mut latest_image: Option<(Vec<u32>, std::num::NonZeroU16, std::num::NonZeroU16)> = None;
                        let mut pump_done = false;
                        for event in batch {
                            match event {
                                RdpOutputEvent::Image { buffer, width, height } => {
                                    latest_image = Some((buffer, width, height));
                                }
                                RdpOutputEvent::PointerDefault => out_msgs.push(ev_pointer("default")),
                                RdpOutputEvent::PointerHidden => out_msgs.push(ev_pointer("hidden")),
                                RdpOutputEvent::PointerBitmap(p) => out_msgs.push(ev_pointer_bitmap(
                                    p.width, p.height, p.hotspot_x, p.hotspot_y, &p.bitmap_data,
                                )),
                                // 服务器侧指针位置事件：浏览器自绘光标，忽略
                                RdpOutputEvent::PointerPosition { .. } => {}
                                RdpOutputEvent::ConnectionFailure(e) => {
                                    out_msgs.push(ev_error(format!("{e:?}")));
                                    ws_alive = false;
                                    pump_done = true;
                                }
                                RdpOutputEvent::Terminated(result) => {
                                    let message = result.err().map(|e| format!("{e:?}"));
                                    out_msgs.push(ev_closed(message));
                                    ws_alive = false;
                                    pump_done = true;
                                }
                            }
                        }
                        if let Some((buffer, width, height)) = latest_image {
                            if let Some(data) = encoder.encode(&buffer, width.get(), height.get()) {
                                out_msgs.push(Message::Binary(data.into()));
                            }
                        }
                        for msg in out_msgs {
                            if ws_tx.send(msg).await.is_err() {
                                ws_alive = false;
                                break;
                            }
                        }
                        if pump_done || !ws_alive {
                            break;
                        }
                    }
                }
            }

            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(txt))) => {
                        let parsed = serde_json::from_str::<WsClientMessage>(&txt);
                        match parsed {
                            Ok(m) if m.kind == "input" => {
                                if let Some(op) = m.op {
                                    let ops = operations_for(op);
                                    if !ops.is_empty() {
                                        let events = db.lock().expect("rdp input db poisoned").apply(ops);
                                        let _ = input_sender.send(RdpInputEvent::FastPath(events));
                                    }
                                }
                            }
                            Ok(m) if m.kind == "resize" => {
                                if let (Some(w), Some(h)) = (m.width, m.height) {
                                    if w > 0 && h > 0 {
                                        let _ = input_sender.send(RdpInputEvent::Resize {
                                            width: w,
                                            height: h,
                                            scale_factor: 100,
                                            physical_size: None,
                                        });
                                    }
                                }
                            }
                            // 未知/畸形消息忽略（协议向前兼容）
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // 本协议客户端上行只允许 Text；二进制忽略
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    // 收尾：优雅断开 RDP 会话（服务器及时注销登录）——发送 Close 后等待 Terminated
    //（或通道关闭）；窗口期内未完成则放弃等待（线程随协议侧自然结束/进程退出回收，
    // output_rx 析构后 run() 下次发送输出即失败退出）。
    let _ = input_sender.send(RdpInputEvent::Close);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(GRACEFUL_DISCONNECT_SECS);
    let mut terminated_cleanly = false;
    loop {
        match tokio::time::timeout_at(deadline, output_rx.recv()).await {
            Ok(Some(RdpOutputEvent::Terminated(Err(e)))) => {
                if ws_alive {
                    let _ = ws_tx.send(ev_error(format!("{e:?}"))).await;
                }
                break;
            }
            Ok(Some(RdpOutputEvent::Terminated(Ok(_)))) => {
                terminated_cleanly = true;
                break;
            }
            // 忽略收尾期间的残余帧/指针事件
            Ok(Some(_)) => continue,
            Ok(None) => {
                terminated_cleanly = true;
                break;
            }
            Err(_) => break,
        }
    }
    if terminated_cleanly {
        if let Ok(handle) = run_thread {
            let _ = handle.join();
        }
    }
    if ws_alive {
        let _ = ws_tx.send(Message::Close(None)).await;
    }
    self_remove(&registry, &session_id, &token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scancode_table_common_keys() {
        assert_eq!(scancode_for("KeyA"), Some((false, 0x1E)));
        assert_eq!(scancode_for("Digit1"), Some((false, 0x02)));
        assert_eq!(scancode_for("Space"), Some((false, 0x39)));
        assert_eq!(scancode_for("F1"), Some((false, 0x3B)));
        // 扩展键
        assert_eq!(scancode_for("ArrowUp"), Some((true, 0x48)));
        assert_eq!(scancode_for("NumpadEnter"), Some((true, 0x1C)));
        assert_eq!(scancode_for("ControlRight"), Some((true, 0x1D)));
        // 无映射
        assert_eq!(scancode_for("IntlRo"), None);
        assert_eq!(scancode_for(""), None);
    }

    #[test]
    fn key_op_falls_back_to_unicode_for_unmapped_single_char() {
        let ops = operations_for(InputOp::Key {
            code: "IntlRo".into(),
            key: "ー".into(),
            pressed: true,
        });
        assert_eq!(ops.len(), 1);
        // 无映射且非单字符（IME 组合中的 Process 等）不产生输入
        let ops = operations_for(InputOp::Key {
            code: "IntlRo".into(),
            key: "ab".into(),
            pressed: true,
        });
        assert!(ops.is_empty());
        // 有映射的物理键走 scancode（不重复发 unicode）
        let ops = operations_for(InputOp::Key {
            code: "KeyA".into(),
            key: "a".into(),
            pressed: true,
        });
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn text_op_emits_press_release_per_char() {
        let ops = operations_for(InputOp::Text {
            text: "你好".into(),
        });
        assert_eq!(ops.len(), 4);
        assert!(matches!(ops[0], Operation::UnicodeKeyPressed('你')));
        assert!(matches!(ops[1], Operation::UnicodeKeyReleased('你')));
        assert!(matches!(ops[2], Operation::UnicodeKeyPressed('好')));
        assert!(matches!(ops[3], Operation::UnicodeKeyReleased('好')));
        let ops = operations_for(InputOp::Text { text: String::new() });
        assert!(ops.is_empty());
    }

    #[test]
    fn frame_encoder_first_frame_full_then_diff() {
        let mut enc = FrameEncoder::new();
        // 2x2 全黑帧（32px 瓦片下单瓦片）
        let black = vec![0xFF000000; 4];
        let msg = enc.encode(&black, 2, 2).expect("首帧必须发送");
        // header: 3 magic + ver + kind + w(2) + h(2) + tile + count(4) = 14
        assert_eq!(msg[0], b'R');
        assert_eq!(msg[1], b'D');
        assert_eq!(msg[2], b'F');
        assert_eq!(msg[3], 1);
        assert_eq!(msg[4], FRAME_KIND_TILES);
        assert_eq!(u16::from_le_bytes([msg[5], msg[6]]), 2);
        assert_eq!(u16::from_le_bytes([msg[7], msg[8]]), 2);
        assert_eq!(msg[9], TILE_SIZE);
        let count = u32::from_le_bytes([msg[10], msg[11], msg[12], msg[13]]);
        assert_eq!(count, 1);

        // 相同帧：无变化不发送
        assert!(enc.encode(&black, 2, 2).is_none());

        // 单像素变化：仍单瓦片
        let mut changed = black.clone();
        changed[0] = 0xFFFFFFFF;
        let msg = enc.encode(&changed, 2, 2).expect("变化帧必须发送");
        let count = u32::from_le_bytes([msg[10], msg[11], msg[12], msg[13]]);
        assert_eq!(count, 1);
        // 瓦片数据 = tw*th*4 = 16 字节
        assert_eq!(msg.len(), 14 + 8 + 16);
    }

    #[test]
    fn frame_encoder_resizes_reset_prev() {
        let mut enc = FrameEncoder::new();
        let frame = vec![0xFF000000; 4];
        assert!(enc.encode(&frame, 2, 2).is_some());
        // 分辨率变化后整帧重发
        let frame2 = vec![0xFF000000; 8];
        let msg = enc.encode(&frame2, 4, 2).expect("尺寸变化必须全发");
        let count = u32::from_le_bytes([msg[10], msg[11], msg[12], msg[13]]);
        assert_eq!(count, 1); // 4x2 仍在单瓦片内
        assert_eq!(u16::from_le_bytes([msg[5], msg[6]]), 4);
    }
}
