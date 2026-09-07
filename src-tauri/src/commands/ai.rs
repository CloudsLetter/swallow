//! Tauri 命令：AI 助手（OpenAI 兼容端点代理 + SSE 流式转发）。
//!
//! 前端把对话历史与上下文发进来，后端代理请求用户配置的 base_url，
//! 把 delta 通过 `tauri::ipc::Channel` 逐段推回（流式打字机效果）。
//! api_key 只存在于本地 config.toml，不落库、不进日志。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::config::global_config::GlobaConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式聊天：逐段推送增量文本（channel 消息即 delta 字符串）。
/// 结束时发送一条以 "\u{1}DONE" 开头的控制消息，前端据此收尾。
#[tauri::command]
pub async fn ai_chat(
    config_state: State<'_, GlobaConfig>,
    messages: Vec<AiChatMessage>,
    channel: Channel<String>,
) -> Result<(), String> {
    let (base_url, api_key, model) = {
        let guard = config_state.config.read().map_err(|e| e.to_string())?;
        let ai = &guard.ai;
        let base = ai.base_url.trim().trim_end_matches('/').to_string();
        (base, ai.api_key.clone(), ai.model.clone())
    };

    if base_url.is_empty() || model.is_empty() {
        return Err("请先在「设置 → AI 助手」中配置 API 地址与模型".into());
    }
    if api_key.is_empty() {
        return Err("请先在「设置 → AI 助手」中配置 API Key".into());
    }

    let url = format!("{base_url}/chat/completions");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // 截断错误体，避免超长 HTML 错误页刷屏
        let body = body.chars().take(500).collect::<String>();
        return Err(format!("AI 服务返回 {status}: {body}"));
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("AI 流式响应中断: {e}"))?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE 以空行分隔事件；逐事件解析 data: 行
        while let Some(pos) = sse_buf.find("\n\n") {
            let event = sse_buf[..pos].to_string();
            sse_buf.drain(..pos + 2);
            for line in event.lines() {
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    let _ = channel.send("\u{1}DONE".into());
                    return Ok(());
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                    continue;
                };
                if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        let _ = channel.send(delta.to_string());
                    }
                }
            }
        }
    }
    let _ = channel.send("\u{1}DONE".into());
    Ok(())
}
