//! Tauri 命令层：按协议/域拆分的 `#[tauri::command]` 实现（自 lib.rs 拆分）。
//! `lib.rs` 只保留 `run()`、`AppState` 与 `generate_handler!` 注册。

pub mod ai;
pub mod local;
pub mod misc;
pub mod monitor;
pub mod mosh;
pub mod rdp;
pub mod serial;
pub mod sftp;
pub mod ssh;
pub mod telnet;
pub mod tunnel;
pub mod vnc;

use serde::Serialize;
use tauri::State;

use crate::config::global_config::GlobaConfig;
use crate::ssh::session;

/// 连接命令返回结果：connected 或需要主机密钥确认。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub status: String,
    pub fingerprint: Option<String>,
    pub host: String,
    pub port: u16,
    /// 待确认主机密钥的 token：前端确认后回传给 accept_host_key（凭此从后端取回完整配置）
    pub host_key_token: Option<String>,
    /// 后端生成的会话 id（监控等由后端自建会话的命令使用；终端等前端传 id 的命令为 None）
    pub session_id: Option<String>,
    /// keyboard-interactive 本轮待回答的提示（status == "needsAuthInteraction" 时非空）
    pub auth_prompts: Option<Vec<crate::ssh::interactive::AuthPrompt>>,
    /// 服务器附带的说明文字（验证码提示的上文，可能为空）
    pub auth_instructions: Option<String>,
    /// 认证用的用户名：前端提交答案时必须原样回传。后端按 `user@host:port` 命中答案表，
    /// 经跳板机时该 user 可能与前端传入的不同，故由后端给出而不是前端自行拼接。
    pub auth_user: Option<String>,
}

impl ConnectResult {
    #[allow(dead_code)]
    pub fn connected(host: String, port: u16) -> Self {
        Self {
            status: "connected".into(),
            fingerprint: None,
            host,
            port,
            host_key_token: None,
            session_id: None,
            auth_prompts: None,
            auth_instructions: None,
            auth_user: None,
        }
    }

    pub fn connected_with_session(host: String, port: u16, session_id: String) -> Self {
        Self {
            status: "connected".into(),
            fingerprint: None,
            host,
            port,
            host_key_token: None,
            session_id: Some(session_id),
            auth_prompts: None,
            auth_instructions: None,
            auth_user: None,
        }
    }

    pub fn needs_host_key_approval(host: String, port: u16, fingerprint: String, token: String) -> Self {
        Self {
            status: "needsHostKeyApproval".into(),
            fingerprint: Some(fingerprint),
            host,
            port,
            host_key_token: Some(token),
            session_id: None,
            auth_prompts: None,
            auth_instructions: None,
            auth_user: None,
        }
    }

    /// keyboard-interactive：把本轮要问的提示交给前端，由前端弹框收集后重连。
    pub fn needs_auth_interaction(
        host: String,
        port: u16,
        user: String,
        instructions: String,
        prompts: Vec<crate::ssh::interactive::AuthPrompt>,
    ) -> Self {
        Self {
            status: "needsAuthInteraction".into(),
            fingerprint: None,
            host,
            port,
            host_key_token: None,
            session_id: None,
            auth_prompts: Some(prompts),
            auth_instructions: Some(instructions),
            auth_user: Some(user),
        }
    }
}

pub(crate) fn read_connection_timeout(config_state: &State<'_, GlobaConfig>) -> u32 {
    config_state
        .config
        .read()
        .map(|guard| guard.ssh.connection_timeout)
        .unwrap_or(session::DEFAULT_CONNECTION_TIMEOUT_SECS)
}
