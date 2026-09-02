use super::session::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;

/// SFTP 会话管理器：session 以 `Arc` 存放，命令层可取引用后立刻释放全局锁，
/// 长操作（下载/上传/读目录）不再阻塞其他会话命令。
pub struct SftpManager {
    sessions: HashMap<String, Arc<SftpSession>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<SftpSession>> {
        self.sessions.get(session_id).cloned()
    }

    /// 直接插入已建立的会话（连接在外部完成，持锁时间最短，避免慢连接阻塞全局）。
    pub fn insert_session(&mut self, session_id: String, session: SftpSession) {
        self.sessions.insert(session_id, Arc::new(session));
    }

    /// 断开会话：从表中移除（正在执行的命令持有 Arc 引用时，连接会延迟到其结束才真正关闭）。
    pub fn disconnect(&mut self, session_id: &str) -> Result<(), String> {
        self.sessions
            .remove(session_id)
            .map(|_| ())
            .ok_or_else(|| format!("Session {} not found", session_id))
    }

    /// 断开所有会话（应用退出时调用）。
    pub fn disconnect_all(&mut self) {
        self.sessions.clear();
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}
