use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::models::data::{LogEntry, LogFilter};
use crate::utils::sqlite;

/// 日志保留上限（默认 1000），由配置在启动与保存时刷新。
static MAX_LOGS: AtomicU32 = AtomicU32::new(1000);

/// 设置日志保留上限。
pub fn set_max_logs(limit: u32) {
    MAX_LOGS.store(limit.max(1), Ordering::Relaxed);
}

fn max_logs() -> u32 {
    MAX_LOGS.load(Ordering::Relaxed)
}

pub(crate) fn append_log(conn: &Connection, level: &str, message: &str, source: Option<&str>) -> Result<(), String> {
    conn.execute(
        "INSERT INTO logs (id, timestamp, level, message, source, log_key, params) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
        params![
            sqlite::new_id("log"),
            sqlite::now_iso(),
            level,
            message,
            source
        ],
    )
    .map_err(|e| e.to_string())?;

    trim_logs(conn)
}

/// i18n 参数化日志：存 key + 参数（JSON），前端按当前语言翻译渲染（日志消息跟随界面语言）。
/// message 列留空字符串（兼容旧前端），log_key/params 供新前端使用。
pub(crate) fn append_log_i18n(
    conn: &Connection,
    level: &str,
    key: &str,
    params: Option<serde_json::Value>,
    source: Option<&str>,
) -> Result<(), String> {
    let params_json = params.map(|p| p.to_string());
    conn.execute(
        // 注意：message 列留空串（兼容旧前端），log_key/params 供新前端渲染；
        // 占位符必须连续 1..=7（rusqlite 按最大 ?7 计数，跳过 ?4 会 Got 6 needed 7）
        "INSERT INTO logs (id, timestamp, level, message, source, log_key, params) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            sqlite::new_id("log"),
            sqlite::now_iso(),
            level,
            "",
            source,
            key,
            params_json
        ],
    )
    .map_err(|e| e.to_string())?;

    trim_logs(conn)
}

/// 日志条数上限裁剪（新/老写入共用）。
fn trim_logs(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM logs
         WHERE id NOT IN (
           SELECT id FROM logs ORDER BY timestamp DESC LIMIT ?1
         )",
        params![max_logs() as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}


pub fn write_log(level: &str, message: &str, source: Option<&str>) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    append_log(&conn, level, message, source)
}

#[allow(dead_code)] // i18n 日志入口（预留，当前统一走 write_log 落库后再做前端翻译）
pub fn write_log_i18n(level: &str, key: &str, params: Option<serde_json::Value>, source: Option<&str>) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    append_log_i18n(&conn, level, key, params, source)
}


#[tauri::command]
pub fn list_logs(filter: Option<LogFilter>) -> Result<Vec<LogEntry>, String> {
    let conn = sqlite::open_connection()?;
    let mut entries = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, timestamp, level, message, source, log_key, params FROM logs ORDER BY timestamp DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                source: row.get(4)?,
                log_key: row.get(5)?,
                params: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let entry = row.map_err(|e| e.to_string())?;
        if let Some(ref filter) = filter {
            if let Some(ref level) = filter.level {
                if entry.level != *level {
                    continue;
                }
            }
            if let Some(ref search) = filter.search {
                let query = search.to_lowercase();
                let message_match = entry.message.to_lowercase().contains(&query);
                let source_match = entry
                    .source
                    .as_ref()
                    .map(|value| value.to_lowercase().contains(&query))
                    .unwrap_or(false);
                if !message_match && !source_match {
                    continue;
                }
            }
        }
        entries.push(entry);
    }

    Ok(entries)
}


#[tauri::command]
pub fn clear_logs() -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    conn.execute("DELETE FROM logs", []).map_err(|e| e.to_string())?;
    Ok(())
}
