use serde::Serialize;
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
}

/// 向指定会话的事件通道发送统一事件。
pub fn emit_session_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
    event: &SessionEvent,
) {
    let _ = app.emit(&format!("session-{}", session_id), event);
}
