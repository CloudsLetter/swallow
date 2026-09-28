use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Emitter;

/// 统一会话事件：按 kind 区分，序列化为 `{ "kind": "...", ... }`。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionEvent {
    Output { data: String },
    Disconnected,
    Error { message: String },
    /// 连接进度：stage 为 tcp/ssh/auth/shell/ready 之一，表示该阶段已完成。
    Progress { stage: String, message: Option<String> },
    /// 远端操作系统探测结果（连接成功后、shell 建立前检测），os 为归一化标识
    /// （ubuntu/debian/centos/rhel/fedora/arch/windows/macos/linux 等，见 ssh/session.rs）。
    OsDetected { os: String },
}

/// 向指定会话的事件通道发送统一事件。
pub fn emit_session_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
    event: &SessionEvent,
) {
    let _ = app.emit(&format!("session-{}", session_id), event);
}

/// 输出最终去向：合并后的文本块交给谁。
pub type OutputSink = Box<dyn FnMut(&str) + Send>;

/// 输出批量合并器：把逐块到达的输出攒成低频大块再交给 sink。
///
/// 背景：逐块下发时，大流量输出（cat 大文件 / 编译日志刷屏）每秒产生数千个
/// IPC 消息——Rust 端 serde 逐条序列化 + IPC 派发 + 前端逐条解析分发，
/// 会打满 WebView 主线程 → 整个应用卡死。合并后消息频率 ≤ 每 MAX_DELAY 一发，
/// 交互回显（少量字符）附加延迟同样 ≤ MAX_DELAY（约一帧，无感）。
///
/// 用法（各协议读循环统一模式）：
/// - 每个输出片段 `push()`（达到硬上限时立即发出，限制单条体积与内存）；
/// - 循环每次迭代（含空闲分支）调一次 `flush_if_due()`——保证输出停流后
///   残留 ≤ 一个轮询周期内送达，不依赖后续数据触发；
/// - 循环退出（EOF/断开/正常结束）后、发 Disconnected 前 `flush()` 清残留。
pub struct OutputBatcher {
    buf: String,
    last_flush: Instant,
    sink: OutputSink,
}

impl OutputBatcher {
    /// 合并窗口：交互回显的最大附加延迟（≈一帧，无感）。
    /// russh 泵的阻塞 wait 需以此时长做超时唤醒（空闲期醒来 flush_if_due），
    /// 流控暂停时的检查周期也复用此时长。
    pub const MAX_DELAY: Duration = Duration::from_millis(16);
    /// 缓冲硬上限：突发超大输出时立即发出，避免单条体积与内存无界增长。
    const HARD_CAP_BYTES: usize = 256 * 1024;

    pub fn new(sink: OutputSink) -> Self {
        Self {
            buf: String::new(),
            last_flush: Instant::now(),
            sink,
        }
    }

    /// 事件通道 sink（telnet/local/serial/mosh）：SessionEvent::Output emit。
    pub fn event_sink<R: tauri::Runtime>(app: tauri::AppHandle<R>, session_id: String) -> OutputSink {
        Box::new(move |data: &str| {
            emit_session_event(&app, &session_id, &SessionEvent::Output { data: data.to_string() });
        })
    }

    /// IPC 二进制通道 sink（SSH 终端）：Raw 字节直发，绕过 JSON 序列化/转义。
    /// Tauri 对 >1KB 的 Raw 载荷走 fetch 原始字节路径，前端收到 ArrayBuffer。
    pub fn channel_sink(channel: Channel<InvokeResponseBody>) -> OutputSink {
        Box::new(move |data: &str| {
            let _ = channel.send(InvokeResponseBody::Raw(data.as_bytes().to_vec()));
        })
    }

    /// 追加一段输出；缓冲达到硬上限时立即发出。
    pub fn push(&mut self, data: &str) {
        self.buf.push_str(data);
        if self.buf.len() >= Self::HARD_CAP_BYTES {
            self.flush();
        }
    }

    /// 到期未发则发出（每次轮询调用；空缓冲零开销）。
    pub fn flush_if_due(&mut self) {
        if !self.buf.is_empty() && self.last_flush.elapsed() >= Self::MAX_DELAY {
            self.flush();
        }
    }

    /// 无条件发出缓冲中的残留输出（幂等）。
    pub fn flush(&mut self) {
        self.last_flush = Instant::now();
        if self.buf.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.buf);
        (self.sink)(&data);
    }
}
