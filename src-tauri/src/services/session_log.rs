// 会话日志记录服务：把 SSH 会话内容写入设置中的默认日志目录。
//
// 前端负责 VT 数据清洗与节流（见 src/lib/ansiClean.ts + sessionLog），本模块只做
// 「可靠落盘」这一件事：start 写文件头 → append 追加 → close 收尾。每次命令打开-写入-关闭
// （追加模式），无长驻句柄；前端按会话串行化调用，同会话内不会交错写。
//
// 对应会话生命周期：TerminalView 在连接前 start；tab 关闭/断线时前端兜底 close。

use crate::utils::sqlite;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

/// 会话日志状态（后端只关心 sessionId → 是否在记录 + 目标路径）。
/// 用 Mutex 防并发命令竞态；路径在 start 时记住，供 close 后置文件路径返回给前端。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static ACTIVE_LOGS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn active_logs() -> &'static Mutex<HashMap<String, String>> {
    ACTIVE_LOGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 开始记录会话日志：以覆盖模式新建文件并写入文件头，登记 sessionId。
/// path 由前端按设置目录自动生成；旧文件内容被清空。
#[tauri::command]
pub fn session_log_start(session_id: String, path: String, header: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建日志目录 {}: {e}", parent.display()))?;
    }
    // 覆盖写文件头（新日志不续在旧文件尾）
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("无法创建日志文件 {path}: {e}"))?;
    file.write_all(header.as_bytes())
        .map_err(|e| format!("写入日志文件头失败 {path}: {e}"))?;
    active_logs()
        .lock()
        .map_err(|e| format!("log registry poisoned: {}", e))?
        .insert(session_id.clone(), path);
    let _ = append_app_log("info", "logMessages.sessionLogStarted", &session_id);
    Ok(())
}

/// 追加一段会话日志内容（前端已清洗+节流，通常 500ms 一批）。
#[tauri::command]
pub fn session_log_append(session_id: String, content: String) -> Result<(), String> {
    let path = active_logs()
        .lock()
        .map_err(|e| format!("log registry poisoned: {}", e))?
        .get(&session_id)
        .cloned();
    let Some(path) = path else {
        // 未在记录（已 close / 从未 start）：静默忽略，避免前端竞态刷错
        return Ok(());
    };
    write_log_file(&path, &content)
}

/// 结束会话日志：移除登记，返回日志文件路径（前端 toast 展示）。
#[tauri::command]
pub fn session_log_close(session_id: String) -> Result<Option<String>, String> {
    let path = active_logs()
        .lock()
        .map_err(|e| format!("log registry poisoned: {}", e))?
        .remove(&session_id);
    if path.is_some() {
        let _ = append_app_log("info", "logMessages.sessionLogStopped", &session_id);
    }
    Ok(path)
}

/// 读取回放文件内容。仅用于前端选择文件后解析 JSONL，不会执行其中的任何输入。
#[tauri::command]
pub fn session_log_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("无法读取回放文件 {path}: {e}"))
}

/// 日志文件条目（AI 工具/日志页共用，仅元数据不含内容）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogFile {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: u64,
}

/// 枚举会话日志目录下的日志文件（.log 纯文本 / .replay.jsonl 回放），按修改时间倒序。
/// directory 缺省空时由命令方传入设置目录；失败返回空列表而非报错（无日志目录很常见）。
#[tauri::command]
pub fn session_log_list(directory: String) -> Vec<SessionLogFile> {
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = if name.ends_with(".replay.jsonl") {
            "replay"
        } else if name.ends_with(".log") {
            "plain"
        } else {
            continue;
        };
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        files.push(SessionLogFile {
            path: path.to_string_lossy().into_owned(),
            name,
            kind: kind.into(),
            size: meta.len(),
            modified,
        });
    }
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    files
}

/// 追加写文件（追加模式：不存在则创建）。
fn write_log_file(path: &str, content: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("无法打开日志文件 {path}: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入日志文件失败 {path}: {e}"))?;
    Ok(())
}

/// 往应用事件日志（Logs 页）记一条会话日志启停记录。
fn append_app_log(level: &str, key: &str, session_id: &str) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    crate::services::logs::append_log_i18n(
        &conn,
        level,
        key,
        Some(serde_json::json!({ "sessionId": session_id })),
        Some("session_log"),
    )
}
