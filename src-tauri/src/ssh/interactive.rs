//! SSH keyboard-interactive（RFC 4256）认证的「答案中转」。
//!
//! ## 为什么需要中转
//! 两后端（ssh2 / russh）的挑战-应答回调都在握手过程中同步/同任务执行，**拿不到
//! 前端输入**。因此沿用主机密钥确认那套「中断 → 前端收集 → 重连」范式：
//!
//! 1. 认证时服务器下发 prompts，若中转表里答案不足 → 返回 [`AuthChallengeRequired`]；
//! 2. 前端弹框收集后调 `submit_ssh_auth_answers`，把**累积**答案按 `user@host:port` 存下；
//! 3. 前端重连同一条连接，认证代码按序取用答案；若服务器还要问 → 回到第 1 步。
//!
//! ## 为什么用 `user@host:port` 而不是 token
//! 重连要经过 6 条不同的连接命令（终端 / SFTP / 监控 / MOSH / 隧道 / VNC），逐个
//! 加参数改动面太大；同一目标即可命中。答案**取用即删除**（单次有效），避免串到
//! 另一个并发连接上。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 一条交互提示。`echo = false` 表示敏感输入（前端用密码框渲染）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    pub prompt: String,
    pub echo: bool,
}

/// 需要前端提问后才能继续认证（携带本轮要问的内容）。
#[derive(Debug)]
pub struct AuthChallengeRequired {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 服务器给的说明文字（可能为空）
    pub instructions: String,
    pub prompts: Vec<AuthPrompt>,
}

impl std::fmt::Display for AuthChallengeRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SSH keyboard-interactive challenge required for {}@{}:{}",
            self.user, self.host, self.port
        )
    }
}

impl std::error::Error for AuthChallengeRequired {}

/// 待用答案：`user@host:port` → 累积答案（按提问顺序排列）。
static PENDING_ANSWERS: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Vec<String>>> {
    PENDING_ANSWERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 答案表的键。
pub fn scope_key(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{host}:{port}")
}

/// 前端提交答案：覆盖写入该目标的**累积**答案（第 N 轮应包含前 N-1 轮已答过的）。
pub fn stash_answers(user: &str, host: &str, port: u16, answers: Vec<String>) {
    pending()
        .lock()
        .unwrap()
        .insert(scope_key(user, host, port), answers);
}

/// 取回并移除该目标的答案。认证尝试一开始就取走，保证单次有效。
pub fn take_answers(user: &str, host: &str, port: u16) -> Vec<String> {
    pending()
        .lock()
        .unwrap()
        .remove(&scope_key(user, host, port))
        .unwrap_or_default()
}

/// 构造「需要提问」错误（anyhow 版，供返回 `anyhow::Result` 的路径）。
pub fn require_challenge(
    user: &str,
    host: &str,
    port: u16,
    instructions: &str,
    prompts: Vec<AuthPrompt>,
) -> anyhow::Error {
    require_challenge_typed(user, host, port, instructions, prompts).into()
}

/// 同 [`require_challenge`]，但返回具体类型。
///
/// ⚠️ 供返回 `Box<dyn Error + Send + Sync>` 的模块（如 SFTP）使用：`anyhow::Error`
/// 转进 `Box<dyn Error>` 后具体类型会变成 `anyhow::Error` 本身，上层
/// `downcast_ref::<AuthChallengeRequired>()` 必然失败 —— 错误被静默降级成普通
/// 认证失败，前端不弹验证码框（与 `host_keys::require_approval_typed` 同因）。
pub fn require_challenge_typed(
    user: &str,
    host: &str,
    port: u16,
    instructions: &str,
    prompts: Vec<AuthPrompt>,
) -> AuthChallengeRequired {
    AuthChallengeRequired {
        host: host.to_string(),
        port,
        user: user.to_string(),
        instructions: instructions.to_string(),
        prompts,
    }
}

/// 从脚本答案里按序取 `count` 条；不足返回 `None`（说明还缺用户输入）。
pub fn take_scripted(scripted: &mut Vec<String>, count: usize) -> Option<Vec<String>> {
    if scripted.len() < count {
        return None;
    }
    Some(scripted.drain(..count).collect())
}

/// ssh2 的 `KeyboardInteractivePrompt` 实现：按序回填中转来的答案。
///
/// libssh2 的回调是**同步且不能返回错误**，所以这里在答案不足时：
/// 记录本轮提示 → 返回等长空串（让 libssh2 立刻认证失败）→ 由调用方把
/// [`challenge`](Self::challenge) 转成 [`AuthChallengeRequired`] 抛出。
pub struct ScriptedPrompter {
    scripted: Vec<String>,
    challenge: Option<(String, Vec<AuthPrompt>)>,
}

impl ScriptedPrompter {
    pub fn new(scripted: Vec<String>) -> Self {
        Self {
            scripted,
            challenge: None,
        }
    }

    /// 若本轮答案不足，取回「需要前端提问」的内容。
    pub fn into_challenge(self) -> Option<(String, Vec<AuthPrompt>)> {
        self.challenge
    }
}

impl ssh2::KeyboardInteractivePrompt for ScriptedPrompter {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        instructions: &str,
        prompts: &[ssh2::Prompt<'a>],
    ) -> Vec<String> {
        if let Some(answers) = take_scripted(&mut self.scripted, prompts.len()) {
            return answers;
        }
        if self.challenge.is_none() {
            self.challenge = Some((
                instructions.to_string(),
                prompts
                    .iter()
                    .map(|p| AuthPrompt {
                        prompt: p.text.to_string(),
                        echo: p.echo,
                    })
                    .collect(),
            ));
        }
        vec![String::new(); prompts.len()]
    }
}
