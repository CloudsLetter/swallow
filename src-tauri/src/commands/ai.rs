//! Tauri 命令：AI 助手（OpenAI 兼容端点代理 + SSE 流式转发）。
//!
//! 后端只做「协议代理」：messages 与 tools 由前端原样透传（前端负责组装
//! OpenAI 消息结构与工具循环），SSE 增量解析后以结构化 JSON 事件经
//! `tauri::ipc::Channel` 推回。api_key 只存在于本地 config.toml，不落库、不进日志。
//!
//! Channel 消息协议（每条为一个 JSON 字符串）：
//! - `{"type":"text","content":"..."}`              —— 文本增量
//! - `{"type":"tool_calls","calls":[...原始数组]}`   —— 工具调用增量（前端按 index 聚合）
//! - `{"type":"finish","reason":"stop|tool_calls"}`  —— 本轮结束原因
//! - `\u{1}DONE`                                     —— 流结束控制消息（兼容旧协议）

use futures_util::StreamExt;
use tauri::ipc::Channel;
use tauri::State;

use crate::config::global_config::GlobaConfig;

/// 流式聊天：逐事件推送（channel 消息为 JSON 字符串，协议见模块注释）。
/// messages/tools 为 OpenAI 兼容 JSON 的原样透传（前端组装，含 tool_calls/tool 角色）。
#[tauri::command]
pub async fn ai_chat(
    config_state: State<'_, GlobaConfig>,
    messages: Vec<serde_json::Value>,
    tools: Option<serde_json::Value>,
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
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if let Some(tools) = tools {
        // 空数组不透传，避免部分端点对空 tools 报错
        let is_empty = tools.as_array().map_or(true, |a| a.is_empty());
        if !is_empty {
            body["tools"] = tools;
        }
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
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
                let delta = &value["choices"][0]["delta"];
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        let _ = channel.send(serde_json::json!({ "type": "text", "content": text }).to_string());
                    }
                }
                // 工具调用增量原样转发（前端按 index 聚合 id/name/arguments）
                if let Some(calls) = delta["tool_calls"].as_array() {
                    if !calls.is_empty() {
                        let _ = channel.send(
                            serde_json::json!({ "type": "tool_calls", "calls": calls }).to_string(),
                        );
                    }
                }
                if let Some(reason) = value["choices"][0]["finish_reason"].as_str() {
                    let _ = channel.send(
                        serde_json::json!({ "type": "finish", "reason": reason }).to_string(),
                    );
                }
            }
        }
    }
    let _ = channel.send("\u{1}DONE".into());
    Ok(())
}
