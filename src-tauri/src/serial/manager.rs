//! 串口会话注册表（与 telnet 同构）。

use super::session::SerialSession;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub struct SerialManager {
    // RwLock 而非 Mutex：读路径（get_session）远多于写路径（连接/断开），
    // 与 ssh/telnet/local 管理器保持一致。
    sessions: Arc<RwLock<HashMap<String, Arc<SerialSession>>>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 插入已建立的会话，并挂接退出时自动移除的 handler（避免残留死会话）。
    pub fn insert_session(&self, session_id: String, session: SerialSession) {
        {
            let sessions = self.sessions.clone();
            let id = session_id.clone();
            session.set_disconnect_handler(Box::new(move || {
                sessions.write().unwrap().remove(&id);
            }));
        }
        let mut sessions = self.sessions.write().unwrap();
        sessions.insert(session_id, Arc::new(session));
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<SerialSession>> {
        self.sessions.read().unwrap().get(session_id).cloned()
    }

    /// 移除在锁内（快），断开在锁外。
    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions.write().unwrap();
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.disconnect()?;
        }
        Ok(())
    }

    /// 尽力断开所有会话（应用退出时调用）。
    pub fn disconnect_all(&self) {
        let mut sessions = self.sessions.write().unwrap();
        for (_, session) in sessions.drain() {
            let _ = session.disconnect();
        }
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.read().unwrap().keys().cloned().collect()
    }
}

impl Default for SerialManager {
    fn default() -> Self {
        Self::new()
    }
}
