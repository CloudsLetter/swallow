//! SSH 错误码（§17-2）：IPC 边界的结构化错误。
//!
//! 后端内部仍用 anyhow / String，命令层在返回前经 `SshError::classify`
//! 映射成 `{ code, message }`；前端按 `code` 做 i18n + 重试策略，
//! 不再逐字匹配中文错误串（`is_ssh2_fallback_eligible` 那种字符串匹配只保留一处）。

use serde::Serialize;

/// IPC 错误载荷：前端 `catch` 到的不再是裸字符串，而是此结构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    /// 机器可读码（`connection.failed` 的 i18n key 前缀已定，前端按此外挂分支）。
    pub code: &'static str,
    /// 人可读消息（中文，与旧 String 错误一致，前端 toast 直接可用）。
    pub message: String,
}

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// anyhow 错误 → 错误码。顺序重要：先判主机密钥（两种后端），再判回退类，
/// 再判认证类，最后网络类兜底。调用方直接 `Err(SshError::classify(&e))`，
/// tauri 会把 Serialize 结构序列化后抛给前端（前端 `String(err)` 仍可读，
/// `err.code` 可做分支——见 sessionService 的 CommandError 解析）。
pub struct SshError;

impl SshError {
    pub const HOST_KEY_APPROVAL: &'static str = "host-key-approval";
    pub const HOST_KEY_MISMATCH: &'static str = "host-key-mismatch";
    pub const NO_COMMON_ALGO: &'static str = "no-common-algo";
    pub const KEY_UNREADABLE: &'static str = "key-unreadable";
    pub const AUTH_FAILED: &'static str = "auth-failed";
    pub const TIMEOUT: &'static str = "timeout";
    pub const UNREACHABLE: &'static str = "unreachable";
    pub const UNKNOWN: &'static str = "unknown";

    pub fn classify(e: &anyhow::Error) -> IpcError {
        if e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>()
            .is_some()
        {
            return IpcError::new(
                Self::HOST_KEY_APPROVAL,
                format!("Host key approval required: {e:#}"),
            );
        }
        let msg = format!("{e:#}");
        if msg.contains("Host key mismatch")
            || msg.contains("主机密钥已变更")
            || msg.contains("KeyChanged")
        {
            return IpcError::new(Self::HOST_KEY_MISMATCH, msg);
        }
        if msg.contains("没有共同支持的 SSH 算法")
            || msg.contains("协商了未知的 SSH 算法")
            || msg.contains("NoCommonAlgo")
            || msg.contains("UnknownAlgo")
        {
            return IpcError::new(Self::NO_COMMON_ALGO, msg);
        }
        if msg.contains("无法解析私钥")
            || msg.contains("CouldNotReadKey")
            || msg.contains("该密钥的内容未存储")
            || msg.contains("密钥认证缺少可用的密钥")
        {
            return IpcError::new(Self::KEY_UNREADABLE, msg);
        }
        if msg.contains("Authentication failed")
            || msg.contains("认证失败")
            || msg.contains("auth failed")
            || msg.contains("userauth")
            || msg.contains("密码认证")
            || msg.contains("证书")
        {
            return IpcError::new(Self::AUTH_FAILED, msg);
        }
        if msg.contains("TimedOut")
            || msg.contains("timed out")
            || msg.contains("Timeout")
            || msg.contains("超时")
        {
            return IpcError::new(Self::TIMEOUT, msg);
        }
        if msg.contains("Failed to connect")
            || msg.contains("无法连接")
            || msg.contains("No address resolved")
            || msg.contains("Connection refused")
        {
            return IpcError::new(Self::UNREACHABLE, msg);
        }
        IpcError::new(Self::UNKNOWN, msg)
    }

    /// 纯字符串错误（旧 `Result<_, String>` 路径）的轻量分类：
    /// 只配看得出来的几类，其余 unknown。供 tunnel/monitor 等尚未 anyhow 化的命令用。
    /// 参数用 `impl AsRef<str>`：`map_err(SshError::classify_str)` 可直接挂在
    /// `Result<_, String>` 上（String: AsRef<str>），`&str` 字面量同样可用。
    pub fn classify_str(msg: impl AsRef<str>) -> IpcError {
        let msg = msg.as_ref();
        if msg.contains("主机密钥已变更") || msg.contains("Host key mismatch") {
            return IpcError::new(Self::HOST_KEY_MISMATCH, msg.to_string());
        }
        if msg.contains("没有共同支持的 SSH 算法")
            || msg.contains("协商了未知的 SSH 算法")
            || msg.contains("NoCommonAlgo")
            || msg.contains("UnknownAlgo")
            || msg.contains("无法解析私钥")
            || msg.contains("CouldNotReadKey")
        {
            return IpcError::new(Self::NO_COMMON_ALGO, msg.to_string());
        }
        if msg.contains("认证失败")
            || msg.contains("Authentication failed")
            || msg.contains("密码认证")
            || msg.contains("证书")
        {
            return IpcError::new(Self::AUTH_FAILED, msg.to_string());
        }
        if msg.contains("超时") || msg.contains("timed out") || msg.contains("Timeout") {
            return IpcError::new(Self::TIMEOUT, msg.to_string());
        }
        if msg.contains("无法连接") || msg.contains("Failed to connect") {
            return IpcError::new(Self::UNREACHABLE, msg.to_string());
        }
        IpcError::new(Self::UNKNOWN, msg.to_string())
    }
}

/// ssh2 回退判定（原 `commands/tunnel.rs::is_ssh2_fallback_eligible`，搬到此处统一）：
/// 纯 DSA 主机、无共同算法、传统 PEM 私钥 → 回退 ssh2；主机密钥变更/待确认/网络类不回退。
pub fn is_ssh2_fallback_eligible(e: &anyhow::Error) -> bool {
    let code = classify_bare(e);
    matches!(code, "no-common-algo" | "key-unreadable")
}

fn classify_bare(e: &anyhow::Error) -> &'static str {
    SshError::classify(e).code
}

#[cfg(test)]
mod tests {
    use super::SshError;

    fn err(msg: &str) -> anyhow::Error {
        anyhow::anyhow!(msg.to_string())
    }

    #[test]
    fn fallback_classes_map_to_ssh2() {
        assert_eq!(SshError::classify(&err("NoCommonAlgo: no matching algo")).code, "no-common-algo");
        assert_eq!(SshError::classify(&err("CouldNotReadKey")).code, "key-unreadable");
    }

    #[test]
    fn non_fallback_classes_stay() {
        assert_eq!(SshError::classify(&err("Host key mismatch for example.com")).code, "host-key-mismatch");
        assert_eq!(SshError::classify(&err("Authentication failed for root")).code, "auth-failed");
        assert_eq!(SshError::classify(&err("Failed to connect to 1.2.3.4")).code, "unreachable");
        assert_eq!(SshError::classify(&err("something else entirely")).code, "unknown");
    }

    #[test]
    fn str_classifier_covers_known_cases() {
        assert_eq!(SshError::classify_str("密码认证缺少密码，请重新填写").code, "auth-failed");
        assert_eq!(SshError::classify_str("连接超时").code, "timeout");
        assert_eq!(SshError::classify_str("???").code, "unknown");
    }
}
