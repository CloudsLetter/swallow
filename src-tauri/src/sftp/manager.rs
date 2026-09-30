use super::session::SftpSession;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// SFTP 会话管理器：内置 RwLock，与 ssh/telnet/local/serial 管理器同构。
/// 命令层取 Arc 引用后立刻释放锁，长操作（下载/上传/读目录）不再阻塞其他会话命令，
/// 也不再需要 AppState 外层再包一层 Mutex（双重锁已消除，见 lib.rs AppState）。
pub struct SftpManager {
    sessions: Arc<RwLock<HashMap<String, Arc<SftpSession>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<SftpSession>> {
        self.sessions.read().unwrap_or_else(|e| e.into_inner()).get(session_id).cloned()
    }

    /// 直接插入已建立的会话（连接在外部完成，持锁时间最短，避免慢连接阻塞全局）。
    pub fn insert_session(&self, session_id: String, session: SftpSession) {
        self.sessions.write().unwrap_or_else(|e| e.into_inner()).insert(session_id, Arc::new(session));
    }

    /// 断开会话：从表中移除（正在执行的命令持有 Arc 引用时，连接会延迟到其结束才真正关闭）。
    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        self.sessions
            .write()
            .unwrap()
            .remove(session_id)
            .map(|_| ())
            .ok_or_else(|| format!("Session {} not found", session_id))
    }

    /// 断开所有会话（应用退出时调用）：SFTP 会话无网络握手，clear 即弃。
    pub fn disconnect_all(&self) {
        self.sessions.write().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.read().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect()
    }
}
