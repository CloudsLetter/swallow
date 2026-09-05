//! RDP 会话注册表（对齐 VNC manager 的代际/自查自删模式）。
//!
//! 注意：内部 registry 是 `Arc<Mutex<HashMap>>`——后台会话任务自然结束后要能自查自删，
//! 管理器实例与后台任务共享同一个 registry；命令侧对 `Mutex<RdpManager>` 只做短锁
//! 调用同步方法，绝不在锁内 await。

use crate::rdp::session;
use ironrdp_client::config::Config;
use rand::Rng;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

/// 单个 RDP 会话的运行态。
pub struct RdpEntry {
    /// 一次性随机 token（WebSocket 握手鉴权用，不落日志）
    pub token: String,
    /// 连接代际：同 sessionId 多代并发时区分新旧（只允许新代覆盖旧代）
    pub generation: u64,
    pub stop: Arc<AtomicBool>,
}

pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, RdpEntry>>>,
}

impl Default for RdpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RdpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 是否有该会话。
    #[allow(dead_code)]
    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|m| m.contains_key(session_id))
            .unwrap_or(false)
    }

    /// 当前会话 id 列表。
    pub fn list(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 启动一个 RDP 会话：持有已绑定的 loopback listener 与已构建的协议 Config，
    /// 派发会话任务并登记。网络等待（listener bind）与 Config 构建都必须在调用侧
    /// 完成后再进锁调用本方法。
    ///
    /// 代际守门与 VNC 相同：已有更新代会话时拒绝旧代覆盖（防 StrictMode 双挂载 /
    /// 重连竞态下旧请求杀掉新会话）；同 id 旧代（gen < 新 gen）先停再建。
    pub fn start(
        &self,
        session_id: &str,
        listener: TcpListener,
        config: Config,
        generation: u64,
    ) -> Result<crate::rdp::RdpConnectResult, String> {
        if session_id.trim().is_empty() {
            return Err("RDP session id 不能为空。".into());
        }

        // 代际守门：已有更新代会话时拒绝旧代覆盖
        {
            let map = self
                .sessions
                .lock()
                .map_err(|_| "RDP 会话表已中毒".to_string())?;
            if let Some(old) = map.get(session_id) {
                if old.generation >= generation {
                    return Err(format!(
                        "RDP 会话 {session_id} 已被更新的连接占用（代际 {} ≥ {}），本次请求已过期。",
                        old.generation, generation
                    ));
                }
            }
        }
        let _ = self.stop(session_id);

        let local_port = listener
            .local_addr()
            .map_err(|e| format!("无法获取本地监听端口: {e}"))?
            .port();

        let token = random_token();
        let stop = Arc::new(AtomicBool::new(false));
        let ws_url = format!("ws://127.0.0.1:{local_port}/rdp/{session_id}?token={token}");

        let registry = self.sessions.clone();
        let sid = session_id.to_string();
        let task_token = token.clone();
        let task_stop = stop.clone();
        // 会话任务自然结束（握手窗口到期/协议终止/stop 标志）后自查自删；句柄即弃（detach）
        let _task = tokio::spawn(async move {
            session::run_session(config, listener, sid.clone(), task_token.clone(), task_stop, registry.clone())
                .await;
            // 仅当该会话仍是本实例（token 相同）时移除，避免误删重连后的新会话
            if let Ok(mut map) = registry.lock() {
                let same = map
                    .get(&sid)
                    .map(|e| e.token == task_token)
                    .unwrap_or(false);
                if same {
                    map.remove(&sid);
                }
            }
        });

        if let Ok(mut map) = self.sessions.lock() {
            map.insert(
                session_id.to_string(),
                RdpEntry {
                    token,
                    generation,
                    stop,
                },
            );
        }

        Ok(crate::rdp::RdpConnectResult {
            session_id: session_id.to_string(),
            ws_url,
        })
    }

    /// 停止指定会话（幂等）：置 stop 标志，泵自行优雅断开并自查自删；此处同时移除注册。
    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let entry = {
            let mut map = self.sessions.lock().map_err(|_| "RDP 会话表已中毒".to_string())?;
            map.remove(session_id)
        };
        if let Some(entry) = entry {
            entry.stop.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// 仅当该 session 当前登记的是 `generation` 代会话时才停止（幂等）。
    /// 用于前端旧代清理：若会话已被新一代接管则不误杀。
    pub fn stop_generation(&self, session_id: &str, generation: u64) -> Result<(), String> {
        let entry = {
            let mut map = self.sessions.lock().map_err(|_| "RDP 会话表已中毒".to_string())?;
            match map.get(session_id) {
                Some(e) if e.generation == generation => map.remove(session_id),
                _ => None,
            }
        };
        if let Some(entry) = entry {
            entry.stop.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// 停止全部会话（应用退出时调用）。
    pub fn stop_all(&self) {
        let entries = self
            .sessions
            .lock()
            .map(|mut m| m.drain().map(|(_, e)| e).collect::<Vec<_>>())
            .unwrap_or_default();
        for entry in entries {
            entry.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// 生成 128-bit 不可预测 token（32 个十六进制字符）。
fn random_token() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdef";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..ALPHABET.len());
            ALPHABET[idx] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_session_id() {
        let m = RdpManager::new();
        assert!(!m.contains(""));
        assert!(m.list().is_empty());
    }
}
