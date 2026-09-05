//! 本地 WebSocket listener：等待前端连入并完成 token 握手鉴权。
//!
//! 与 VNC 桥不同：本桥只负责「拿到一个合法的 WebSocket 连接」，协议泵在 session.rs；
//! 整个会话生命周期只有一条 WS 连接（RDP 会话不可重挂），连接断开即会话结束。

use crate::rdp::RDP_HANDSHAKE_WINDOW_SECS;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::WebSocketStream;

/// 校验 WebSocket 握手请求：路径必须为 `/rdp/<session_id>` 且 query 携带正确 token。
fn request_valid(req: &Request, session_id: &str, token: &str) -> bool {
    if req.uri().path() != format!("/rdp/{session_id}") {
        return false;
    }
    query_token(req.uri().query()).as_deref() == Some(token)
}

fn query_token(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        if k == "token" {
            it.next().map(|v| v.to_string())
        } else {
            None
        }
    })
}

/// 在 listener 上等待前端 WebSocket 连入（鉴权通过），返回该连接。
/// 窗口期内无人连入或 stop 命中则返回 None（listener 随函数返回关闭）。
pub async fn accept_client(
    listener: TcpListener,
    session_id: String,
    token: String,
    stop: Arc<AtomicBool>,
) -> Option<WebSocketStream<tokio::net::TcpStream>> {
    let mut window = Box::pin(tokio::time::sleep(Duration::from_secs(
        RDP_HANDSHAKE_WINDOW_SECS,
    )));

    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }

        let check_sid = session_id.clone();
        let check_token = token.clone();
        let check_stop = stop.clone();
        let accepted = tokio::select! {
            biased;
            _ = &mut window => None,
            res = listener.accept() => match res {
                Ok((stream, _)) => {
                    let r = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| {
                        if request_valid(req, &check_sid, &check_token) && !check_stop.load(Ordering::Relaxed) {
                            Ok(resp)
                        } else {
                            // 拒绝（403）：客户端表现为握手失败
                            let deny: ErrorResponse = http::Response::builder()
                                .status(403)
                                .body(None)
                                .expect("valid 403 response");
                            Err(deny)
                        }
                    })
                    .await;
                    match r {
                        Ok(ws) => Some(ws),
                        Err(_) => continue, // 非法握手：继续等待合法客户端
                    }
                }
                Err(_) => return None,
            },
        };

        return accepted;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_token_parsing() {
        assert_eq!(query_token(Some("token=abc&x=1")), Some("abc".to_string()));
        assert_eq!(query_token(Some("x=1")), None);
        assert_eq!(query_token(None), None);
    }

    #[test]
    fn request_valid_checks_path_and_token() {
        let req = Request::builder()
            .uri("/rdp/sess-1?token=abc123")
            .body(())
            .unwrap();
        assert!(request_valid(&req, "sess-1", "abc123"));
        assert!(!request_valid(&req, "sess-1", "wrong"));
        assert!(!request_valid(&req, "sess-2", "abc123"));
        // VNC 路径不得匹配 RDP 桥
        let vnc_req = Request::builder()
            .uri("/vnc/sess-1?token=abc123")
            .body(())
            .unwrap();
        assert!(!request_valid(&vnc_req, "sess-1", "abc123"));
    }
}
