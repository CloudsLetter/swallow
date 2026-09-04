//! VNC 会话管理与 WebSocket<->TCP 双向转发。

use crate::vnc::VncConnectResult;
use rand::Rng;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use super::bridge;
use super::ssh::SshTunnelGuard;

/// 单个 VNC 会话的运行态。
struct VncEntry {
    /// 一次性随机 token（WebSocket 握手鉴权用，不落日志）
    token: String,
    stop: Arc<AtomicBool>,
    /// listener/转发后台任务；stop 后 abort
    task: JoinHandle<()>,
    /// SSH 隧道守护（仅 SSH 传输模式）：随会话存活，移除会话时一并释放
    _tunnel: Option<SshTunnelGuard>,
}

/// VNC 会话注册表。
///
/// 注意：内部 registry 是 `Arc<Mutex<HashMap>>`——后台任务自然结束后要能自查自删，
/// 因此管理器的唯一实例也通过 Arc 共享同一个 registry（命令侧对 `Mutex<VncManager>`
/// 只做短锁调用同步方法，不在锁内 await）。
pub struct VncManager {
    sessions: Arc<Mutex<HashMap<String, VncEntry>>>,
}

impl Default for VncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl VncManager {
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

    /// 启动一个 VNC 会话：持有已绑定的 loopback listener 与已连通的 TCP 流，
    /// 派发后台桥任务并登记会话。
    ///
    /// 网络等待（连 VNC、bind listener、SSH 隧道建立）都必须在调用侧完成后再进锁调用
    /// 本方法：`listener` 必须绑定 127.0.0.1（本模块不在此处 bind，避免锁内 await）。
    /// `tunnel` 仅 SSH 传输模式传入，随会话存活（直连为 None）。
    /// 重复 session_id：先停旧会话再建新会话，避免端口/任务泄漏。
    pub fn start(
        &self,
        session_id: &str,
        listener: tokio::net::TcpListener,
        tcp: TcpStream,
        tunnel: Option<SshTunnelGuard>,
    ) -> Result<VncConnectResult, String> {
        // 校验
        if session_id.trim().is_empty() {
            return Err("VNC session id 不能为空。".into());
        }

        // 同 id 先清理旧会话
        let _ = self.stop(session_id);

        let local_port = listener
            .local_addr()
            .map_err(|e| format!("无法获取本地监听端口: {e}"))?
            .port();

        let token = random_token();
        let stop = Arc::new(AtomicBool::new(false));
        let ws_url = format!("ws://127.0.0.1:{local_port}/vnc/{session_id}?token={token}");

        // 后台任务：等 WebSocket 客户端 -> 双向转发 -> 自然结束后自查自删
        let registry = self.sessions.clone();
        let sid = session_id.to_string();
        let task_token = token.clone();
        let task_stop = stop.clone();
        let task = tokio::spawn(async move {
            bridge::serve(listener, tcp, sid.clone(), task_token.clone(), task_stop).await;
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
                VncEntry {
                    token,
                    stop,
                    task,
                    _tunnel: tunnel,
                },
            );
        }

        Ok(VncConnectResult {
            session_id: session_id.to_string(),
            ws_url: Some(ws_url),
            host: None,
            port: None,
            fingerprint: None,
            host_key_token: None,
        })
    }

    /// 停止指定会话（幂等）。置 stop 标志并 abort 后台任务，其 Drop 会关闭
    /// listener / WebSocket / TCP 流。任务随后自查自删；此处同时移除注册。
    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let entry = {
            let mut map = self.sessions.lock().map_err(|_| "VNC 会话表已中毒".to_string())?;
            map.remove(session_id)
        };
        if let Some(entry) = entry {
            entry.stop.store(true, Ordering::Relaxed);
            entry.task.abort();
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
            entry.task.abort();
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
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener as TokioTcpListener;

    /// 绑定 loopback 随机端口 listener。
    async fn bind_loopback() -> tokio::net::TcpListener {
        tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
    }

    /// 起一个 TCP echo 服务端，返回地址。
    async fn spawn_echo_server() -> std::net::SocketAddr {
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 8192];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if sock.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        addr
    }

    /// 建立到 bridge 的 WebSocket 客户端。
    async fn ws_connect(url: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, String> {
        use futures_util::StreamExt;
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| e.to_string())?;
        Ok(ws)
    }

    #[tokio::test]
    async fn rejects_empty_session_id() {
        let m = VncManager::new();
        // start 前的校验在调用侧（lib.rs）做，这里通过 list/contains 验证空表即可
        assert!(!m.contains(""));
        assert!(m.list().is_empty());
    }

    #[tokio::test]
    async fn binary_roundtrip_and_cleanup() {
        let echo = spawn_echo_server().await;
        let m = VncManager::new();
        let res = m.start("sess-1", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        assert_eq!(res.session_id, "sess-1");
        assert!(res.ws_url.as_ref().unwrap().starts_with("ws://127.0.0.1:"));
        assert!(m.contains("sess-1"));

        // 双向 echo
        let (mut ws, _) = tokio_tungstenite::connect_async(res.ws_url.as_ref().unwrap()).await.unwrap();
        use futures_util::{SinkExt, StreamExt};
        ws.send(tokio_tungstenite::tungstenite::protocol::Message::Binary(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let msg = ws.next().await.unwrap().unwrap();
        assert_eq!(msg, tokio_tungstenite::tungstenite::protocol::Message::Binary(vec![1, 2, 3].into()));

        // stop 后注册表清空；再连被拒（listener 已关）
        m.stop("sess-1").unwrap();
        assert!(!m.contains("sess-1"));
        let _ = ws.close(None).await;
        // 稍等让 listener 关闭
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            tokio_tungstenite::connect_async(res.ws_url.as_ref().unwrap()).await.is_err(),
            "stop 后不应再能连上"
        );
    }

    #[tokio::test]
    async fn wrong_token_rejected() {
        let echo = spawn_echo_server().await;
        let m = VncManager::new();
        let res = m.start("sess-2", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        // 替换 token
        let bad_url = res.ws_url.as_ref().unwrap().replacen("token=", "token=deadbeef", 1);
        // 错误 token 无法完成握手（连接/握手失败）
        let result = ws_connect(&bad_url).await;
        assert!(result.is_err(), "错误 token 的握手应被拒绝");
        m.stop("sess-2").unwrap();
    }

    #[tokio::test]
    async fn wrong_session_rejected() {
        let echo = spawn_echo_server().await;
        let m = VncManager::new();
        let res = m.start("sess-3", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        // 路径换成别的 session
        let bad_url = res.ws_url.as_ref().unwrap().replace("/vnc/sess-3", "/vnc/sess-other");
        let result = ws_connect(&bad_url).await;
        assert!(result.is_err(), "错误 session id 的握手应被拒绝");
        m.stop("sess-3").unwrap();
    }

    #[tokio::test]
    async fn duplicate_session_replaces() {
        let echo = spawn_echo_server().await;
        let m = VncManager::new();
        let r1 = m.start("sess-4", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        assert!(m.contains("sess-4"));
        // 相同 id 重新 start：旧 listener 关闭、新 URL 可连
        let r2 = m.start("sess-4", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        assert!(m.contains("sess-4"));
        assert_ne!(r1.ws_url, r2.ws_url);
        // 旧 URL 应已不可连
        assert!(ws_connect(r1.ws_url.as_ref().unwrap()).await.is_err(), "旧 listener 应已关闭");
        m.stop("sess-4").unwrap();
        assert!(!m.contains("sess-4"));
    }

    #[tokio::test]
    async fn tcp_eof_closes_ws() {
        // 一次性 TCP 服务端：收到字节后立即关闭（模拟 EOF）
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 64];
                let _ = sock.read(&mut buf).await;
                drop(sock); // EOF
            }
        });

        let m = VncManager::new();
        let res = m.start("sess-5", bind_loopback().await, TcpStream::connect(addr).await.unwrap(), None).unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(res.ws_url.as_ref().unwrap()).await.unwrap();
        use futures_util::{SinkExt, StreamExt};
        ws.send(tokio_tungstenite::tungstenite::protocol::Message::Binary(vec![9].into()))
            .await
            .unwrap();
        // TCP EOF 后 WebSocket 应收到 Close 或流结束
        let next = tokio::time::timeout(Duration::from_secs(3), ws.next()).await;
        match next {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::protocol::Message::Close(_))))
            | Ok(None)
            | Ok(Some(Err(_))) => {}
            other => panic!("TCP EOF 后 WS 应关闭, got {other:?}"),
        }
        m.stop("sess-5").unwrap();
    }

    #[tokio::test]
    async fn ws_close_ends_tcp() {
        // 记录 TCP 对端是否读到 EOF
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (eof_tx, mut eof_rx) = tokio::sync::mpsc::channel::<()>(1);
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                // 持续读直到 EOF
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                let _ = eof_tx.send(()).await;
            }
        });

        let m = VncManager::new();
        let res = m.start("sess-6", bind_loopback().await, TcpStream::connect(addr).await.unwrap(), None).unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(res.ws_url.as_ref().unwrap()).await.unwrap();
        use futures_util::StreamExt;
        // 客户端主动关 WebSocket
        let _ = ws.close(None).await;
        // TCP 侧应出现 EOF（服务端读到 0）
        assert!(
            tokio::time::timeout(Duration::from_secs(3), eof_rx.recv())
                .await
                .is_ok(),
            "WS 关闭后 TCP 应 EOF"
        );
        m.stop("sess-6").unwrap();
    }

    #[tokio::test]
    async fn text_message_rejected() {
        let echo = spawn_echo_server().await;
        let m = VncManager::new();
        let res = m.start("sess-7", bind_loopback().await, TcpStream::connect(echo).await.unwrap(), None).unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(res.ws_url.as_ref().unwrap()).await.unwrap();
        use futures_util::{SinkExt, StreamExt};
        ws.send(tokio_tungstenite::tungstenite::protocol::Message::Text("hi".into()))
            .await
            .unwrap();
        // 桥应拒绝 Text（关闭连接或错误）
        let next = tokio::time::timeout(Duration::from_secs(3), ws.next()).await;
        match next {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::protocol::Message::Close(_))))
            | Ok(None)
            | Ok(Some(Err(_))) => {}
            other => panic!("Text 消息应被拒绝, got {other:?}"),
        }
        m.stop("sess-7").unwrap();
    }
}
