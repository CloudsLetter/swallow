//! Tauri 命令：AI 助手（多协议代理 + SSE 流式转发）。
//!
//! 后端按当前激活档案的 `protocol` 分派：
//! - "openai"：OpenAI 兼容 Chat Completions（DeepSeek/Moonshot/Qwen/OpenRouter/
//!   Ollama/Gemini OpenAI 兼容端点等）
//! - "anthropic"：Anthropic Messages API（Claude），OpenAI 消息/工具结构与 SSE
//!   事件在此归一化为统一事件协议，前端 agent 循环不感知协议差异
//!
//! messages 与 tools 由前端原样透传（OpenAI 兼容格式，前端负责组装与工具循环），
//! api_key 只存在于本地 config.toml，不落库、不进日志。
//!
//! Channel 消息协议（每条为一个 JSON 字符串，两种协议输出一致）：
//! - `{"type":"text","content":"..."}`              —— 文本增量
//! - `{"type":"tool_calls","calls":[...增量数组]}`   —— 工具调用增量（前端按 index 聚合）
//! - `{"type":"finish","reason":"stop|tool_calls"}`  —— 本轮结束原因
//! - `\u{1}DONE`                                     —— 流结束控制消息

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::config::global_config::GlobaConfig;
use crate::models::config::{Ai, AiProfile};

/// 解析当前激活档案：active_profile 匹配 → profiles 第一个 → 旧单档案字段 fallback。
/// 返回 None 表示尚未配置（UI 提示去设置页）。
fn resolve_profile(ai: &Ai) -> Option<AiProfile> {
    if !ai.profiles.is_empty() {
        let candidate = ai
            .profiles
            .iter()
            .find(|p| p.id == ai.active_profile)
            .or_else(|| ai.profiles.first())?;
        if candidate.base_url.trim().is_empty() || candidate.model.trim().is_empty() {
            return None;
        }
        return Some(candidate.clone());
    }
    // 旧 config.toml 兼容：单档案字段按 openai 协议使用
    if !ai.base_url.trim().is_empty() && !ai.model.trim().is_empty() {
        return Some(AiProfile {
            id: "legacy".into(),
            name: "Default".into(),
            protocol: "openai".into(),
            base_url: ai.base_url.clone(),
            api_key: ai.api_key.clone(),
            model: ai.model.clone(),
        });
    }
    None
}

/// 流式聊天：逐事件推送（channel 消息为 JSON 字符串，协议见模块注释）。
#[tauri::command]
pub async fn ai_chat(
    config_state: State<'_, GlobaConfig>,
    messages: Vec<Value>,
    tools: Option<Value>,
    channel: Channel<String>,
) -> Result<(), String> {
    let profile = {
        let guard = config_state.config.read().map_err(|e| e.to_string())?;
        let profile = resolve_profile(&guard.ai)
            .ok_or_else(|| "请先在「设置 → AI 助手」中添加并完善一个 AI 档案".to_string())?;
        if profile.api_key.trim().is_empty() {
            return Err("请先在「设置 → AI 助手」中为当前档案配置 API Key".into());
        }
        profile
    };

    match profile.protocol.as_str() {
        "anthropic" => chat_anthropic(&profile, messages, tools, channel).await,
        _ => chat_openai(&profile, messages, tools, channel).await,
    }
}

/// SSE 读取骨架：按空行分帧，逐条「data: 」行回调处理；任意 handler 返回 Ok(false)
/// 表示流应立即结束（已发送 DONE）。
async fn stream_sse<F>(
    resp: reqwest::Response,
    mut on_data: F,
) -> Result<(), String>
where
    F: FnMut(&Value) -> Result<bool, String>,
{
    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("AI 流式响应中断: {e}"))?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = sse_buf.find("\n\n") {
            let event = sse_buf[..pos].to_string();
            sse_buf.drain(..pos + 2);
            for line in event.lines() {
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if !on_data(&value)? {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn send_json(channel: &Channel<String>, value: Value) {
    let _ = channel.send(value.to_string());
}

// ---------------------------------------------------------------------------
// OpenAI 兼容协议
// ---------------------------------------------------------------------------

async fn chat_openai(
    profile: &AiProfile,
    messages: Vec<Value>,
    tools: Option<Value>,
    channel: Channel<String>,
) -> Result<(), String> {
    let base = profile.base_url.trim().trim_end_matches('/');
    let url = format!("{base}/chat/completions");

    let mut body = json!({
        "model": profile.model,
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
        .bearer_auth(&profile.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }

    stream_sse(resp, |value| {
        if data_done(value) {
            send_json(&channel, json!("\u{1}DONE"));
            return Ok(false);
        }
        let delta = &value["choices"][0]["delta"];
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                send_json(&channel, json!({ "type": "text", "content": text }));
            }
        }
        // 工具调用增量原样转发（前端按 index 聚合 id/name/arguments）
        if let Some(calls) = delta["tool_calls"].as_array() {
            if !calls.is_empty() {
                send_json(&channel, json!({ "type": "tool_calls", "calls": calls }));
            }
        }
        if let Some(reason) = value["choices"][0]["finish_reason"].as_str() {
            send_json(&channel, json!({ "type": "finish", "reason": reason }));
        }
        Ok(true)
    })
    .await?;

    send_json(&channel, json!("\u{1}DONE"));
    Ok(())
}

/// OpenAI 的 [DONE] 终止帧
fn data_done(value: &Value) -> bool {
    value.as_str() == Some("[DONE]")
}

// ---------------------------------------------------------------------------
// Anthropic Messages 协议
// ---------------------------------------------------------------------------

/// OpenAI 消息结构 → Anthropic messages/system：system 提取合并、tool_calls →
/// tool_use block、tool 结果 → tool_result block（连续结果归并进同一条 user 消息，
/// 连续同角色消息一并合并以满足 Anthropic 交替约束）。
fn map_messages_to_anthropic(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("");
        match role {
            "system" => {
                if let Some(c) = msg["content"].as_str() {
                    if !c.trim().is_empty() {
                        system_parts.push(c.to_string());
                    }
                }
            }
            "user" => {
                let text = msg["content"].as_str().unwrap_or("");
                push_anthropic_message(&mut out, "user", vec![json!({ "type": "text", "text": text })]);
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                let text = msg["content"].as_str().unwrap_or("");
                if !text.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if let Some(calls) = msg["tool_calls"].as_array() {
                    for call in calls {
                        let input: Value = serde_json::from_str(
                            call["function"]["arguments"].as_str().unwrap_or("{}"),
                        )
                        .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": call["id"],
                            "name": call["function"]["name"],
                            "input": input,
                        }));
                    }
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                push_anthropic_message(&mut out, "assistant", blocks);
            }
            "tool" => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": msg["tool_call_id"],
                    "content": msg["content"].as_str().unwrap_or(""),
                });
                // 连续 tool 结果合并进上一条 user 消息（Anthropic 交替约束）
                if let Some(last) = out.last_mut() {
                    if last["role"] == "user" && last["content"].is_array() {
                        last["content"].as_array_mut().unwrap().push(block);
                        continue;
                    }
                }
                out.push(json!({ "role": "user", "content": [block] }));
            }
            _ => {}
        }
    }
    (system_parts.join("\n\n"), out)
}

fn push_anthropic_message(out: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if let Some(last) = out.last_mut() {
        if last["role"].as_str() == Some(role) && last["content"].is_array() {
            last["content"].as_array_mut().unwrap().extend(blocks);
            return;
        }
    }
    out.push(json!({ "role": role, "content": blocks }));
}

/// OpenAI tools（function.parameters）→ Anthropic tools（input_schema）
fn map_tools_to_anthropic(tools: Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let mapped: Vec<Value> = arr
        .iter()
        .filter_map(|t| {
            let f = &t["function"];
            if f["name"].is_null() {
                return None;
            }
            let schema = if f["parameters"].is_null() {
                json!({ "type": "object", "properties": {} })
            } else {
                f["parameters"].clone()
            };
            Some(json!({
                "name": f["name"],
                "description": f["description"],
                "input_schema": schema,
            }))
        })
        .collect();
    if mapped.is_empty() {
        None
    } else {
        Some(json!(mapped))
    }
}

async fn chat_anthropic(
    profile: &AiProfile,
    messages: Vec<Value>,
    tools: Option<Value>,
    channel: Channel<String>,
) -> Result<(), String> {
    let base = profile.base_url.trim().trim_end_matches('/');
    let url = format!("{base}/v1/messages");

    let (system, api_messages) = map_messages_to_anthropic(&messages);
    let mut body = json!({
        "model": profile.model,
        "max_tokens": 8192,
        "stream": true,
        "messages": api_messages,
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if let Some(api_tools) = tools.and_then(map_tools_to_anthropic) {
        body["tools"] = api_tools;
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-api-key", profile.api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }

    stream_sse(resp, |value| {
        match value["type"].as_str().unwrap_or("") {
            // 流中错误（overloaded_error 等）：立即终止并上报
            "error" => {
                let msg = value["error"]["message"].as_str().unwrap_or("Anthropic 流错误");
                Err(format!("AI 服务错误: {msg}"))
            }
            "content_block_start" => {
                let block = &value["content_block"];
                if block["type"] == "tool_use" {
                    send_json(
                        &channel,
                        json!({
                            "type": "tool_calls",
                            "calls": [{
                                "index": value["index"].as_i64().unwrap_or(0),
                                "id": block["id"],
                                "function": { "name": block["name"], "arguments": "" },
                            }],
                        }),
                    );
                }
                Ok(true)
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta["text"].as_str() {
                            if !text.is_empty() {
                                send_json(&channel, json!({ "type": "text", "content": text }));
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(part) = delta["partial_json"].as_str() {
                            if !part.is_empty() {
                                send_json(
                                    &channel,
                                    json!({
                                        "type": "tool_calls",
                                        "calls": [{
                                            "index": value["index"].as_i64().unwrap_or(0),
                                            "function": { "arguments": part },
                                        }],
                                    }),
                                );
                            }
                        }
                    }
                    _ => {}
                }
                Ok(true)
            }
            "message_delta" => {
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    let normalized = if reason == "tool_use" { "tool_calls" } else { "stop" };
                    send_json(&channel, json!({ "type": "finish", "reason": normalized }));
                }
                Ok(true)
            }
            "message_stop" => {
                send_json(&channel, json!("\u{1}DONE"));
                Ok(false)
            }
            _ => Ok(true),
        }
    })
    .await?;

    send_json(&channel, json!("\u{1}DONE"));
    Ok(())
}

/// 非 2xx 错误体：截断到 500 字符，避免超长 HTML 错误页刷屏
async fn error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let body = body.chars().take(500).collect::<String>();
    format!("AI 服务返回 {status}: {body}")
}
