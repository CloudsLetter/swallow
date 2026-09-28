//! MOSH 会话注册表（文本流协议，SSH manager 同款模式）。

use crate::mosh::session::PumpCommand;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, RwLock};

/// 单个 MOSH 会话的运行态（泵线程收尾时经 removal_closure 自查自删）。
pub struct MoshSessionHandle {
    /// 输入/尺寸命令通道（mosh_write / mosh_resize 命令投递）
    pub input_tx: Sender<PumpCommand>,
    /// 停止标志：断开命令置位，泵线程 graceful shutdown 后退出
    pub stop: Arc<AtomicBool>,
}

pub struct MoshManager {
    // RwLock 而非 Mutex：读路径（get_handle 每次 mosh_write/resize 都走）远多于写路径。
    sessions: Arc<RwLock<HashMap<String, MoshSessionHandle>>>,
}

impl Default for MoshManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MoshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions
            .read()
            .map(|m| m.contains_key(session_id))
            .unwrap_or(false)
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions
            .read()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 构造「泵线程退出时自查自删」回调：需在 start_pump 之前拿到并交给它，
    /// 泵线程结束（异常/断开/服务器关闭）时移除本会话，防止残留死会话。
    pub fn removal_closure(&self, session_id: String) -> Box<dyn FnOnce() + Send> {
        let sessions = self.sessions.clone();
        Box::new(move || {
            if let Ok(mut map) = sessions.write() {
                map.remove(&session_id);
            }
        })
    }

    /// 注册会话（同 id 重复连接：先移除旧条目，句柄由旧泵线程的 stop 收尾）。
    pub fn insert_session(&self, session_id: String, handle: MoshSessionHandle) {
        if let Ok(mut map) = self.sessions.write() {
            if let Some(old) = map.remove(&session_id) {
                old.stop.store(true, Ordering::Relaxed);
            }
            map.insert(session_id, handle);
        }
    }

    pub fn get_handle(&self, session_id: &str) -> Option<(Sender<PumpCommand>, Arc<AtomicBool>)> {
        let sessions = self.sessions.read().ok()?;
        sessions
            .get(session_id)
            .map(|h| (h.input_tx.clone(), h.stop.clone()))
    }

    /// 断开指定会话（幂等）：移除注册并置 stop，泵线程自行优雅收尾。
    pub fn disconnect(&self, session_id: &str) {
        let handle = {
            let mut map = match self.sessions.write() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.remove(session_id)
        };
        if let Some(handle) = handle {
            handle.stop.store(true, Ordering::Relaxed);
        }
    }

    /// 尽力断开所有会话（应用退出时调用）。
    pub fn disconnect_all(&self) {
        let mut map = match self.sessions.write() {
            Ok(m) => m,
            Err(_) => return,
        };
        for (_, handle) in map.drain() {
            handle.stop.store(true, Ordering::Relaxed);
        }
    }
}
