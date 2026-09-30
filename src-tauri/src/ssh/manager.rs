use crate::ssh::session::SshSession;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub struct SshManager {
    // RwLock 而非 Mutex：读路径（每次击键/resize 的 get_session、list）远多于
    // 写路径（连接/断开），读读并行避免高频击键在多标签下互相排队。
    sessions: Arc<RwLock<HashMap<String, Arc<SshSession>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 插入已建立的会话（连接在外部完成，持锁时间最短）：
    /// 同时挂接会话退出（EOF/错误/断开）时自动从注册表移除的 handler，避免残留死会话。
    pub fn insert_session(&self, session_id: String, session: SshSession) {
        {
            let sessions = self.sessions.clone();
            let id = session_id.clone();
            session.set_disconnect_handler(Box::new(move || {
                sessions.write().unwrap_or_else(|e| e.into_inner()).remove(&id);
            }));
        }
        let mut sessions = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        sessions.insert(session_id, Arc::new(session));
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<SshSession>> {
        let sessions = self.sessions.read().unwrap_or_else(|e| e.into_inner());
        sessions.get(session_id).cloned()
    }

    pub fn disconnect(&self, session_id: &str) -> Result<()> {
        // 移除在锁内（快），断开（网络 I/O）在锁外：避免慢断开阻塞其他 SSH 命令
        let session = {
            let mut sessions = self.sessions.write().unwrap_or_else(|e| e.into_inner());
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.disconnect()?;
        }
        Ok(())
    }

    /// 尽力断开所有会话（应用退出时调用）：先 drain 出锁，
    /// 再逐个断开——断开是网络 I/O（channel.close/wait_close），
    /// 绝不能在持锁状态下做，否则会卡住所有并发命令。
    pub fn disconnect_all(&self) {
        let sessions: Vec<_> = {
            let mut guard = self.sessions.write().unwrap_or_else(|e| e.into_inner());
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            let _ = session.disconnect();
        }
    }

    pub fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.read().unwrap_or_else(|e| e.into_inner());
        sessions.keys().cloned().collect()
    }
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}
