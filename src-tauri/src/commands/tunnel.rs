//! Tauri 命令：tunnel 域（自 lib.rs 拆分，行为不变）。

use tauri::{Emitter, State};

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::AppState;

use std::sync::Arc;
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;
use crate::utils::sqlite;


// ==================== Port Forwarding Tunnel Commands ====================

#[tauri::command]
pub async fn start_port_forward(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    rule_id: String,
) -> Result<ConnectResult, String> {
    let conn = sqlite::open_connection()?;
    let rule = crate::services::port_forwardings::load_port_forwarding(&conn, &rule_id)?
        .ok_or_else(|| "端口转发规则不存在或已被删除".to_string())?;

    let host_id = rule
        .host_id
        .clone()
        .ok_or_else(|| "该规则未指定 SSH 主机，无法建立隧道".to_string())?;

    // 解析主机认证（账号优先/主机回退）并读取密钥/证书内容，与终端连接同链路
    let config = crate::services::port_forwardings::resolve_host_ssh_config(&conn, &host_id)?;

    let timeout_secs = read_connection_timeout(&config_state);

    // remote（ssh -R）规则的本地回连目标：需在建连前写入 Handler（回调驱动）
    let forward_target = match rule.rule_type.as_str() {
        "remote" => {
            let target = rule
                .target_host
                .clone()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "远程转发需要指定目标主机".to_string())?;
            let port = u16::try_from(rule.target_port)
                .map_err(|_| "目标端口超出 0-65535 范围".to_string())?;
            Some((target, port))
        }
        _ => None,
    };

    // TunnelManager 克隆供断线通知闭包使用（TunnelManager 是 Arc 包装，克隆零成本）
    let manager = {
        let guard = state.tunnels.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    // 断线通知（事件驱动，替代 3s 轮询看门狗线程）：russh 事件循环断开时立即
    // 触发。仅当隧道已注册才做清理与前端推送——连接阶段的断线由 connect 的
    // 错误返回处理，不应误报「已连接隧道断开」。
    let on_disconnected = {
        let manager = manager.clone();
        let rule_id = rule_id.clone();
        let name = rule.name.clone();
        let app_handle = app.clone();
        Arc::new(move || {
            if manager.is_running(&rule_id) {
                manager.stop(&rule_id);
                // 通知前端即时刷新该规则的状态（状态由内存隧道派生，无需写 DB）
                let _ = app_handle.emit(
                    "port-forward-status",
                    serde_json::json!({ "ruleId": rule_id, "status": "disconnected" }),
                );
                let _ = write_log(
                    "warn",
                    &format!("Port forward tunnel lost connection: {name}"),
                    Some("portforwarding"),
                );
            }
        }) as Arc<dyn Fn() + Send + Sync>
    };

    // 连接进度：转发页没有 invoke 过程中的反馈通道，复用 port-forward-status
    // 事件推送 connecting 阶段（tcp → ssh → auth），前端状态点显示「连接中」。
    let progress_rule_id = rule_id.clone();
    let progress_app = app.clone();
    let on_progress = move |stage: &str, message: Option<&str>| {
        let _ = progress_app.emit(
            "port-forward-status",
            serde_json::json!({
                "ruleId": progress_rule_id,
                "status": "connecting",
                "stage": stage,
                "message": message,
            }),
        );
    };

    // 隧道建连已迁移 russh：端口转发是唯一在单 Session 上开多并发 channel 的场景，
    // ssh2 的全局大锁会把并发转发连接串行化（docs/SSH_BACKEND_MIGRATION.md §2）。
    // russh 是纯异步 IO，直接 await（不占阻塞 worker，也不会拖慢全局 IPC）。
    let connect_result = crate::ssh::russh_backend::connect(
        &config,
        timeout_secs,
        forward_target,
        &on_progress,
        Some(on_disconnected),
    )
    .await;
    let russh_conn = match connect_result {
        Ok(conn) => conn,
        Err(e) => {
            if let Some(approval) = e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>() {
                // 待确认的可能是跳板机而非目标主机，用 approval 携带的真实 host/port 与 token
                return Ok(ConnectResult::needs_host_key_approval(
                    approval.host.clone(),
                    approval.port,
                    approval.fingerprint.clone(),
                    approval.token.clone(),
                ));
            }
            // DSA/传统 PEM 兼容回退：russh 不支持 ssh-dss 主机密钥与 DSA/传统 PEM
            // 客户端私钥，这类算法协商/私钥解析失败自动回退 ssh2 后端（备份路径）。
            // 主机密钥安全类错误（Mismatch/KeyChanged）与待确认流程不回退。
            if is_ssh2_fallback_eligible(&e) {
                let _ = write_log(
                    "info",
                    &format!(
                        "Falling back to ssh2 tunnel backend for {}@{}:{} (russh: {})",
                        config.username, config.host, config.port, e
                    ),
                    Some("portforwarding"),
                );
                // ssh2 路径：与终端同链路建连（establish_authenticated_session），
                // 监听循环用 ssh2 版 start_tunnel。阻塞 I/O 全部在 spawn_blocking。
                let progress = Arc::new(on_progress);
                let connect_config = config.clone();
                let established = tauri::async_runtime::spawn_blocking(move || {
                    crate::ssh::session::SshSession::establish_authenticated_session(
                        &connect_config,
                        timeout_secs,
                        &*progress,
                    )
                })
                .await
                .map_err(|e| format!("Connection task failed: {e}"))?;
                let est = match established {
                    Ok(est) => est,
                    Err(e) => {
                        if let Some(approval) =
                            e.downcast_ref::<crate::ssh::host_keys::HostKeyApprovalRequired>()
                        {
                            return Ok(ConnectResult::needs_host_key_approval(
                                approval.host.clone(),
                                approval.port,
                                approval.fingerprint.clone(),
                                approval.token.clone(),
                            ));
                        }
                        return Err(format!("SSH connection failed: {}", e));
                    }
                };
                let rule_name = rule.name.clone();
                let rule_summary = format!(
                    "{}:{} -> {}:{}",
                    rule.listen_host,
                    rule.listen_port,
                    rule.target_host.as_deref().unwrap_or("SOCKS5"),
                    rule.target_port
                );
                let fallback_tunnel = tauri::async_runtime::spawn_blocking(move || {
                    crate::ssh::tunnel::start_tunnel(&rule, est.session, est.jump)
                })
                .await
                .map_err(|e| format!("Tunnel task failed: {e}"))?
                .map_err(|e| format!("Failed to start tunnel: {e}"))?;
                {
                    let guard = state.tunnels.lock().map_err(|e| e.to_string())?;
                    guard.insert(
                        rule_id.clone(),
                        Arc::new(crate::ssh::tunnel::RunningTunnel::Ssh2(Arc::new(
                            fallback_tunnel,
                        ))),
                    );
                }
                crate::services::port_forwardings::touch_last_used(&conn, &rule_id)?;
                let _ = write_log(
                    "info",
                    &format!(
                        "Port forward tunnel started (ssh2 fallback): {} ({})",
                        rule_name, rule_summary
                    ),
                    Some("portforwarding"),
                );
                return Ok(ConnectResult::connected(config.host, config.port));
            }
            let _ = write_log(
                "error",
                &format!(
                    "Port forward tunnel SSH connection failed to {}@{}:{}: {}",
                    config.username, config.host, config.port, e
                ),
                Some("portforwarding"),
            );
            return Err(format!("SSH connection failed: {}", e));
        }
    };

    // 建立隧道并启动后台监听 task（跳板机连接随 RusshConnection 存活，drop 自动释放）
    let tunnel = crate::ssh::russh_tunnel::start_russh_tunnel(&rule, russh_conn)
        .await
        .map_err(|e| format!("Failed to start tunnel: {}", e))?;

    let tunnel_arc = Arc::new(crate::ssh::tunnel::RunningTunnel::Russh(Arc::new(tunnel)));
    {
        let guard = state.tunnels.lock().map_err(|e| e.to_string())?;
        guard.insert(rule_id.clone(), tunnel_arc);
    }

    crate::services::port_forwardings::touch_last_used(&conn, &rule_id)?;

    let _ = write_log(
        "info",
        &format!(
            "Port forward tunnel started: {} ({}:{} -> {}:{})",
            rule.name,
            rule.listen_host,
            rule.listen_port,
            rule.target_host.as_deref().unwrap_or("SOCKS5"),
            rule.target_port
        ),
        Some("portforwarding"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
pub async fn stop_port_forward(state: State<'_, AppState>, rule_id: String) -> Result<(), String> {
    let stopped = state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .stop(&rule_id);
    if stopped {
        let _ = write_log("info", "Port forward tunnel stopped", Some("portforwarding"));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_active_port_forwards(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.tunnels.lock().map_err(|e| e.to_string())?.list())
}

/// 判断 russh 连接错误是否属于「兼容回退」范畴：纯 DSA 主机（无共同主机密钥/KEX
/// 算法）、DSA 或传统 PEM 客户端私钥（russh 无法解析/签名）。主机密钥变更、
/// 待确认流程、网络类错误不回退（回退只会得到同样的失败）。
pub(crate) fn is_ssh2_fallback_eligible(e: &anyhow::Error) -> bool {
    let msg = format!("{e:#}");
    msg.contains("没有共同支持的 SSH 算法")
        || msg.contains("协商了未知的 SSH 算法")
        || msg.contains("无法解析私钥")
        || msg.contains("NoCommonAlgo")
        || msg.contains("UnknownAlgo")
        || msg.contains("CouldNotReadKey")
}
