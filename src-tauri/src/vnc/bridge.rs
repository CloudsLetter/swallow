//! WebSocket <-> TCP 双向转发桥。
//!
//! 只做协议转换：Binary payload -> TCP 字节；TCP 字节 -> Binary payload；
//! Close/生命周期 -> 关闭对端。不解析 RFB，不解码任何画面数据。
//! 只允许 Binary 消息；Text 消息被拒绝（Close 1003）。

use crate::vnc::VNC_HANDSHAKE_WINDOW_SECS;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::protocol::Message;

const BUFFER_SIZE: usize = 128 * 1024;
/// 桥空闲时检查 stop 标志的周期（stop 命中后 ≤250ms 内收尾）。
const STOP_POLL_INTERVAL_MS: u64 = 250;

/// 校验 WebSocket 握手请求：路径必须为 `/vnc/<session_id>` 且 query 携带正确 token。
fn request_valid(req: &Request, session_id: &str, token: &str) -> bool {
    if req.uri().path() != format!("/vnc/{session_id}") {
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

/// 会话桥主循环：等待第一个合法 WebSocket 客户端，握手鉴权通过后开始双向转发；
/// 连接结束（任一侧关闭）后返回。无客户端在窗口期内连入则自行退出（自清）。
pub async fn serve(
    listener: TcpListener,
    tcp: TcpStream,
    session_id: String,
    token: String,
    stop: Arc<AtomicBool>,
) {
    let session_id = session_id.clone();
    let token = token.clone();

    // 客户端关闭 WebSocket 后向 TCP 侧传播关闭
    let mut window = Box::pin(tokio::time::sleep(Duration::from_secs(VNC_HANDSHAKE_WINDOW_SECS)));

    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }

        // 校验用数据移入闭包
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
                    }).await;
                    match r {
                        Ok(ws) => Some(ws),
                        Err(_) => {
                            // 非法握手：继续等待合法客户端（可重试）
                            continue;
                        }
                    }
                }
                Err(_) => return,
            },
        };

        let Some(ws) = accepted else {
            // 窗口到期无人连入：自清（listener 随本函数返回而关闭）
            return;
        };

        // 关闭 Nagle：降低鼠标键盘小包延迟
        let _ = tcp.set_nodelay(true);

        relay(ws, tcp, stop.clone()).await;
        return;
    }
}

/// 双向转发：select 单循环，避免 split 后无法优雅收尾的问题。
async fn relay(mut ws: tokio_tungstenite::WebSocketStream<TcpStream>, mut tcp: TcpStream, stop: Arc<AtomicBool>) {
    let mut buf = [0u8; BUFFER_SIZE];

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        tokio::select! {
            // WebSocket -> TCP
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if tcp.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    // Text 消息拒绝：VNC 桥只接受二进制
                    Some(Ok(Message::Text(_))) => {
                        let _ = ws.send(Message::Close(None)).await;
                        break;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    // Ping/Pong/Frame 等由 tungstenite 协议层内部处理，其余忽略
                    _ => {}
                }
            }
            // TCP -> WebSocket
            n = tcp.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => {
                        // TCP EOF：通知 WebSocket 侧关闭
                        let _ = ws.send(Message::Close(None)).await;
                        break;
                    }
                    Ok(n) => {
                        if ws.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            // 周期检查 stop（disconnect 会 abort 任务，此处为兜底）
            _ = tokio::time::sleep(Duration::from_millis(STOP_POLL_INTERVAL_MS)) => {}
        }
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
            .uri("/vnc/sess-1?token=abc123")
            .body(())
            .unwrap();
        assert!(request_valid(&req, "sess-1", "abc123"));
        assert!(!request_valid(&req, "sess-1", "wrong"));
        assert!(!request_valid(&req, "sess-2", "abc123"));
    }
}
