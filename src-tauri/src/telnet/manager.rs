use super::session::TelnetSession;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub struct TelnetManager {
    // RwLock 而非 Mutex：读路径（每次击键/resize 的 get_session）远多于写路径
    //（连接/断开），读读并行避免高频击键在多标签下互相排队。
    sessions: Arc<RwLock<HashMap<String, Arc<TelnetSession>>>>,
}

impl TelnetManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 插入已建立的会话，并挂接退出时自动移除的 handler（避免残留死会话）。
    pub fn insert_session(&self, session_id: String, session: TelnetSession) {
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

    pub fn get_session(&self, session_id: &str) -> Option<Arc<TelnetSession>> {
        self.sessions.read().unwrap().get(session_id).cloned()
    }

    /// 移除在锁内（快），断开（网络 I/O）在锁外。
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

    /// 尽力断开所有会话（应用退出时调用）：先 drain 出锁再断开，
    /// shutdown 是网络 I/O，不能在持锁状态下做。
    pub fn disconnect_all(&self) {
        let sessions: Vec<_> = {
            let mut guard = self.sessions.write().unwrap();
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            let _ = session.disconnect();
        }
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.read().unwrap().keys().cloned().collect()
    }
}

impl Default for TelnetManager {
    fn default() -> Self {
        Self::new()
    }
}
