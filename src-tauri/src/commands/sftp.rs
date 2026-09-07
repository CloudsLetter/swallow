//! Tauri 命令：sftp 域（自 lib.rs 拆分，行为不变）。

use tauri::{Emitter, State};

use crate::commands::read_connection_timeout;
use crate::commands::ConnectResult;
use crate::AppState;

use crate::sftp::{SftpConfig, SftpSession, FileItem};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde::Serialize;
use crate::config::global_config::GlobaConfig;
use crate::services::logs::write_log;
use crate::services::keys::load_key_content;
use crate::utils::sqlite;


// ==================== SFTP Commands ====================

#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, AppState>,
    config_state: State<'_, GlobaConfig>,
    session_id: String,
    config: SftpConfig,
) -> Result<ConnectResult, String> {
    let timeout_secs = read_connection_timeout(&config_state);
    let keep_alive_interval = config_state
        .config
        .read()
        .map(|guard| guard.ssh.keep_alive_interval)
        .unwrap_or(60);
    let mut config = config;

    // 公钥认证：根据 key_id 从密钥库读取密钥内容（与 SSH 终端一致，不落盘）
    if config.protocol == "sftp" && config.auth_type == "publickey" {
        if let Some(key_id) = config.key_id.clone() {
            let conn = sqlite::open_connection()?;
            let (private_key, public_key) = load_key_content(&conn, &key_id)?;
            if private_key.is_none() && public_key.is_none() {
                return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
            }
            config.private_key = private_key;
            config.public_key = public_key;
        }
    }

    // 先检查会话是否已存在（快速路径，避免重复连接）
    {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        if manager.get_session(&session_id).is_some() {
            return Ok(ConnectResult::connected(config.host, config.port));
        }
    }

    // 连接不持全局锁，且挪到阻塞线程池执行：
    // 慢连接/无响应服务器既不会阻塞其他 SFTP/FTP 命令，也不再占用 tokio 异步 worker 线程
    // （async 命令内直接跑阻塞 I/O，多个慢连接会占满 worker 导致全局 IPC 排队变慢）。
    let connect_config = config.clone();
    let connect_result = tauri::async_runtime::spawn_blocking(move || {
        SftpSession::connect(connect_config, timeout_secs, keep_alive_interval)
    })
    .await
    .map_err(|e| format!("Connection task failed: {e}"))?;
    let session = match connect_result {
        Ok(session) => session,
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
            let _ = write_log(
                "error",
                &format!(
                    "{} connection failed to {}@{}:{}: {}",
                    config.protocol.to_uppercase(),
                    config.username,
                    config.host,
                    config.port,
                    e
                ),
                Some("sftp"),
            );
            return Err(format!("SFTP connection failed: {}", e));
        }
    };

    // 连接成功后加锁插入（持锁时间最短）
    let mut manager = state.sftp.lock().map_err(|e| e.to_string())?;
    if manager.get_session(&session_id).is_some() {
        return Ok(ConnectResult::connected(config.host, config.port));
    }
    manager.insert_session(session_id, session);

    let _ = write_log(
        "info",
        &format!(
            "{} connected to {}@{}:{}",
            config.protocol.to_uppercase(),
            config.username,
            config.host,
            config.port
        ),
        Some("sftp"),
    );

    Ok(ConnectResult::connected(config.host, config.port))
}

#[tauri::command]
pub async fn sftp_list_dir(state: State<'_, AppState>, session_id: String, path: String) -> Result<Vec<FileItem>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 锁已释放 + 阻塞线程池执行：读目录不再排队等待其他会话/传输完成，也不占异步 worker
    let result = tauri::async_runtime::spawn_blocking(move || session.list_dir(&path))
        .await
        .map_err(|e| format!("List task failed: {e}"))?;
    result.map_err(|e| format!("Failed to list directory: {}", e))
}

#[tauri::command]
pub async fn sftp_download_file(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<Vec<u8>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || session.download_file(&remote_path))
        .await
        .map_err(|e| format!("Download task failed: {e}"))?;
    result.map_err(|e| format!("Failed to download file: {}", e))
}

/// 直接下载到用户通过保存对话框选择的目标路径（Tauri 2 下
/// `<a download>` 失效，改由后端落盘，避免整文件经 IPC 往返）。
#[tauri::command]
pub async fn sftp_download_file_to(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    target_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 锁已释放 + 阻塞线程池：整文件下载期间列表刷新/其他传输不再被阻塞
    let data = tauri::async_runtime::spawn_blocking(move || session.download_file(&remote_path))
        .await
        .map_err(|e| format!("Download task failed: {e}"))?
        .map_err(|e| format!("Failed to download file: {}", e))?;
    std::fs::write(&target_path, data).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, AppState>,
    session_id: String,
    local_data: Vec<u8>,
    remote_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.upload_file(&local_data, &remote_path))
            .await
            .map_err(|e| format!("Upload task failed: {e}"))?;
    result.map_err(|e| format!("Failed to upload file: {}", e))
}

#[tauri::command]
pub async fn sftp_delete_file(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.delete_file(&remote_path))
            .await
            .map_err(|e| format!("Delete task failed: {e}"))?;
    result.map_err(|e| format!("Failed to delete file: {}", e))
}

#[tauri::command]
pub async fn sftp_delete_dir(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.delete_dir(&remote_path))
            .await
            .map_err(|e| format!("Delete task failed: {e}"))?;
    result.map_err(|e| format!("Failed to delete directory: {}", e))
}

#[tauri::command]
pub async fn sftp_remove_dir_recursive(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 递归删除挪到阻塞线程池：遍历目录树 + 逐个删除期间不阻塞其他命令
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.remove_dir_recursive(&remote_path)
    })
    .await
    .map_err(|e| format!("Remove task failed: {e}"))?;
    result.map_err(|e| format!("Failed to remove directory: {}", e))
}

#[tauri::command]
pub async fn sftp_create_dir(state: State<'_, AppState>, session_id: String, remote_path: String) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.create_dir(&remote_path))
            .await
            .map_err(|e| format!("Create task failed: {e}"))?;
    result.map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
pub async fn sftp_chmod(state: State<'_, AppState>, session_id: String, remote_path: String, mode: u32) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || session.chmod(&remote_path, mode))
            .await
            .map_err(|e| format!("Chmod task failed: {e}"))?;
    result.map_err(|e| format!("Failed to change permissions: {}", e))
}

#[tauri::command]
pub async fn sftp_search_files(
    state: State<'_, AppState>,
    session_id: String,
    root_path: String,
    query: String,
) -> Result<Vec<String>, String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    // 递归搜索挪到阻塞线程池（遍历目录树期间不阻塞其他命令）
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.search_files(&root_path, &query, 500)
    })
    .await
    .map_err(|e| format!("Search task failed: {e}"))?;
    result.map_err(|e| format!("Failed to search files: {}", e))
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || session.rename(&old_path, &new_path))
        .await
        .map_err(|e| format!("Rename task failed: {e}"))?;
    result.map_err(|e| format!("Failed to rename: {}", e))
}

/// 分块上传进度事件载荷（下载由后端流式推进度时推送）。
/// 字段必须 camelCase 与前端 `TransferProgressEvent` 解构一致，
/// 否则 sessionId/remotePath 解构为 undefined，进度匹配永远失败。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgress {
    session_id: String,
    remote_path: String,
    done: u64,
    total: u64,
}

#[tauri::command]
pub async fn sftp_upload_chunk(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
    truncate: bool,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        session.upload_chunk(&remote_path, &data, truncate)
    })
    .await
    .map_err(|e| format!("Upload task failed: {e}"))?;
    result.map_err(|e| format!("Failed to upload chunk: {}", e))
}

#[tauri::command]
pub async fn sftp_upload_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    cancel_token: Option<String>,
) -> Result<(), String> {
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let progress_session = session_id.clone();
    let progress_path = remote_path.clone();
    // 清理远端半成品与取消标志需在阻塞任务之后使用 session/remote_path（闭包已 move 原值）
    let cleanup_session = session.clone();
    let cleanup_path = remote_path.clone();

    // 注册取消标志（「结束任务」由 sftp_cancel_transfer 置位 → 后端中断上传）
    let cancel_flag: Option<Arc<AtomicBool>> = match cancel_token.clone() {
        Some(token) => {
            let flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut cancels) = state.transfer_cancels.lock() {
                cancels.insert(token, flag.clone());
            }
            Some(flag)
        }
        None => None,
    };

    let result = tauri::async_runtime::spawn_blocking({
        let cancel_flag = cancel_flag.clone();
        move || {
            // 进度事件节流到 1 秒（结束帧立即发）
            let last_emit = std::cell::Cell::new(0u64);
            session
                .upload_local_file(
                    &local_path,
                    &remote_path,
                    |done, total| {
                        if done < total {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            if now.saturating_sub(last_emit.get()) < 1000 {
                                return;
                            }
                            last_emit.set(now);
                        }
                        let _ = app.emit(
                            "sftp-transfer",
                            SftpTransferProgress {
                                session_id: progress_session.clone(),
                                remote_path: progress_path.clone(),
                                done,
                                total,
                            },
                        );
                    },
                    cancel_flag.as_deref(),
                )
                .map_err(|e| format!("Failed to upload: {e}"))
        }
    })
    .await
    .map_err(|e| format!("Upload task failed: {e}"))?;

    // 主动取消：清理远端半成品文件（上传中断时远端可能残留不完整文件）
    if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
        let _ = cleanup_session.delete_file(&cleanup_path);
    }

    // 清理取消标志
    if let Some(token) = cancel_token {
        if let Ok(mut cancels) = state.transfer_cancels.lock() {
            cancels.remove(&token);
        }
    }
    result
}

#[tauri::command]
pub async fn sftp_download_file_progress(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    target_path: String,
    offset: u64,
    cancel_token: Option<String>,
) -> Result<(), String> {
    let _ = write_log(
        "info",
        &format!("Download started: {} -> {}", remote_path, target_path),
        Some("sftp"),
    );
    // 取 Arc 引用后立即释放全局锁：整个下载过程不再阻塞其他会话命令（列表刷新/上传/删除）
    let session = {
        let manager = state.sftp.lock().map_err(|e| e.to_string())?;
        manager
            .get_session(&session_id)
            .ok_or_else(|| format!("SFTP session {} not found", session_id))?
    };
    let progress_session = session_id.clone();
    let progress_path = remote_path.clone();

    // 注册取消标志（支持「结束任务」）：下载中断时由 sftp_cancel_transfer 置位
    let cancel_flag: Option<Arc<AtomicBool>> = match cancel_token.clone() {
        Some(token) => {
            let flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut cancels) = state.transfer_cancels.lock() {
                cancels.insert(token, flag.clone());
            }
            Some(flag)
        }
        None => None,
    };

    // 尾部日志仍需要这两个路径：克隆一份供闭包外使用
    let log_remote = remote_path.clone();
    let log_target = target_path.clone();

    let result = tauri::async_runtime::spawn_blocking({
        // cancel_flag 克隆进阻塞任务，外部保留一份用于「取消时清理半成品文件」
        let cancel_flag = cancel_flag.clone();
        move || {
            // 进度事件节流到 1 秒（结束帧立即发），避免高速下载时高频 IPC 拖慢传输/UI
            let last_emit = std::cell::Cell::new(0u64);
            session
                .stream_download_to(
                    &remote_path,
                    &target_path,
                    offset,
                    |done, total| {
                        if done < total {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            if now.saturating_sub(last_emit.get()) < 1000 {
                                return;
                            }
                            last_emit.set(now);
                        }
                        let _ = app.emit(
                            "sftp-transfer",
                            SftpTransferProgress {
                                session_id: progress_session.clone(),
                                remote_path: progress_path.clone(),
                                done,
                                total,
                            },
                        );
                    },
                    cancel_flag.as_deref(),
                )
                .map_err(|e| format!("Failed to download: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Download task failed: {e}"))?;

    // 取消时清理本地半成品文件（结束任务不应残留不完整下载）
    if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
        let _ = std::fs::remove_file(&log_target);
    }

    // 清理取消标志
    if let Some(token) = cancel_token {
        if let Ok(mut cancels) = state.transfer_cancels.lock() {
            cancels.remove(&token);
        }
    }

    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "Download {}: {} ({} bytes)",
            if result.is_ok() { "completed" } else { "failed" },
            log_remote,
            std::fs::metadata(&log_target).map(|m| m.len()).unwrap_or(0)
        ),
        Some("sftp"),
    );
    result
}

/// 取消进行中的下载（置位取消标志，流式下载循环检测后中断）。
#[tauri::command]
pub async fn sftp_cancel_transfer(state: State<'_, AppState>, cancel_token: String) -> Result<(), String> {
    let cancels = state.transfer_cancels.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = cancels.get(&cancel_token) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {    let mut manager = state.sftp.lock().map_err(|e| e.to_string())?;
    let result = manager
        .disconnect(&session_id)
        .map_err(|e| format!("Failed to disconnect: {}", e));
    let _ = write_log(
        if result.is_ok() { "info" } else { "error" },
        &format!(
            "{} SFTP session {}",
            if result.is_ok() { "Disconnected" } else { "Failed to disconnect" },
            session_id
        ),
        Some("sftp"),
    );
    result
}




#[tauri::command]
pub async fn sftp_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.sftp.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}


