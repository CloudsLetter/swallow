use rusqlite::params;

use crate::models::data::KnownHostEntry;
use crate::services::logs::append_log_i18n;
use crate::utils::sqlite;

#[tauri::command]
pub fn list_known_hosts() -> Result<Vec<KnownHostEntry>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, host, key_type, fingerprint, last_used, added_date, raw_line
             FROM known_hosts ORDER BY host COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KnownHostEntry {
                id: row.get(0)?,
                host: row.get(1)?,
                key_type: row.get(2)?,
                fingerprint: row.get(3)?,
                last_used: row.get(4)?,
                added_date: row.get(5)?,
                raw_line: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 已知主机已改为 DB 存储（连接校验/信任写入均走 DB），无需再与系统文件同步；
/// 保留此命令名仅为前端刷新入口：直接返回当前 DB 列表。
#[tauri::command]
pub fn refresh_known_hosts() -> Result<Vec<KnownHostEntry>, String> {
    list_known_hosts()
}

#[tauri::command]
pub fn delete_known_host(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    conn.execute("DELETE FROM known_hosts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    append_log_i18n(&conn, "info", "logMessages.knownHostDeleted", None, Some("known_hosts"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_known_hosts() -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    conn.execute("DELETE FROM known_hosts", []).map_err(|e| e.to_string())?;
    append_log_i18n(&conn, "warn", "logMessages.knownHostCleared", None, Some("known_hosts"))?;
    Ok(())
}

/// 导出全部信任条目为 OpenSSH 兼容文本（从 DB raw_line 拼接）。
fn export_content() -> Result<String, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare("SELECT raw_line FROM known_hosts ORDER BY host COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .join("\n"))
}

#[tauri::command]
pub fn export_known_hosts() -> Result<String, String> {
    export_content()
}

/// 将信任条目写入用户通过保存对话框选择的目标路径
/// （Tauri 2 下 `<a download>` 失效，改由后端直接落盘）。
#[tauri::command]
pub fn export_known_hosts_to(target_path: String) -> Result<(), String> {
    let content = export_content()?;
    std::fs::write(&target_path, content).map_err(|e| e.to_string())
}
