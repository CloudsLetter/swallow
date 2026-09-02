use super::session::LocalShellSession;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct LocalShellManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LocalShellSession>>>>,
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 插入已建立的会话，并挂接退出时自动移除的 handler（避免残留死会话）。
    pub fn insert_session(&self, session_id: String, session: LocalShellSession) {
        {
            let sessions = self.sessions.clone();
            let id = session_id.clone();
            session.set_disconnect_handler(Box::new(move || {
                sessions.lock().unwrap().remove(&id);
            }));
        }
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id, Arc::new(session));
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<LocalShellSession>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// 移除会话在锁内（快），断开（kill 子进程）在锁外。
    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.disconnect()?;
        }
        Ok(())
    }

    /// 尽力断开所有会话（应用退出时调用）。
    pub fn disconnect_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, session) in sessions.drain() {
            let _ = session.disconnect();
        }
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

impl Default for LocalShellManager {
    fn default() -> Self {
        Self::new()
    }
}
