use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::utils::sqlite;

/// 监控页持久化状态（单行表 monitor_state，id 恒为 1）：
/// - host_ids：正在监控的主机 id 列表（有序，前端添加顺序）
/// - auto_start：进入监控页时是否自动重连上次监控的主机
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorState {
    pub host_ids: Vec<String>,
    pub auto_start: bool,
}

/// 读取监控页持久化状态；无记录时返回默认（空列表 + 自动监控开）。
#[tauri::command]
pub fn monitor_get_state() -> Result<MonitorState, String> {
    let conn = sqlite::open_connection()?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT host_ids, auto_start FROM monitor_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (host_ids_json, auto_start) = row.unwrap_or_else(|| ("[]".to_string(), 1));
    let host_ids: Vec<String> = serde_json::from_str(&host_ids_json).unwrap_or_default();
    Ok(MonitorState {
        host_ids,
        auto_start: auto_start != 0,
    })
}

/// 覆盖保存监控页状态（整行 upsert）。
#[tauri::command]
pub fn monitor_save_state(host_ids: Vec<String>, auto_start: bool) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let host_ids_json = serde_json::to_string(&host_ids).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO monitor_state (id, host_ids, auto_start, updated_at)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
            host_ids = excluded.host_ids,
            auto_start = excluded.auto_start,
            updated_at = excluded.updated_at",
        params![host_ids_json, auto_start as i64, sqlite::now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
