use rusqlite::params;

use crate::models::data::KnownHostEntry;
use crate::services::logs::append_log_i18n;
use crate::services::transfer;
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

/// 极简 OpenSSH `known_hosts` 解析：`hosts key_type base64 [comment]`。
///
/// - 忽略空行与 `#` 注释
/// - 一行里的多个主机名（`a,b keytype data`）各自展开成一条
/// - 哈希主机名（`|1|...`）按原样保留——它是单向的，无法还原真实主机名
fn parse_known_hosts_text(text: &str) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (hosts, key_type) = match (parts.next(), parts.next()) {
            (Some(h), Some(k)) => (h, k),
            _ => continue,
        };
        if parts.next().is_none() {
            continue; // 缺 base64 密钥体，不是合法条目
        }
        for host in hosts.split(',') {
            let host = host.trim();
            if host.is_empty() {
                continue;
            }
            out.push((
                host.to_string(),
                key_type.to_string(),
                String::new(),
                line.to_string(),
            ));
        }
    }
    out
}

/// 导入信任条目：认 Swallow JSON 导出，也认 OpenSSH `known_hosts` 文本。
///
/// ⚠️ 去重键与云同步一致（`host` + `key_type`），且**只新增、不覆盖**：
/// 已知主机代表「用户曾确认过这台机器的密钥」，不该被一个导入文件悄悄改写
/// 信任锚（同 `restore_known_hosts` 的取舍）。
#[tauri::command]
pub fn import_known_hosts_text(text: String) -> Result<usize, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("导入内容为空".to_string());
    }
    // 以 JSON 起手就必须按 JSON 解析：失败要如实报错，不能退化成「把 JSON 当文本行」吞垃圾
    let records = if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let (items, _) = transfer::parse::<KnownHostEntry>("knownHosts", trimmed)?;
        items
            .into_iter()
            .map(|item| (item.host, item.key_type, item.fingerprint, item.raw_line))
            .collect::<Vec<_>>()
    } else {
        parse_known_hosts_text(trimmed)
    };
    if records.is_empty() {
        return Err("无法识别：既不是 Swallow 已知主机 JSON，也不是 known_hosts 文本".to_string());
    }

    let conn = sqlite::open_connection()?;
    let mut added = 0usize;
    let mut skipped = 0usize;
    for (host, key_type, fingerprint, raw_line) in records {
        if host.trim().is_empty() || key_type.trim().is_empty() {
            continue;
        }
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM known_hosts WHERE host = ?1 AND key_type = ?2",
                params![host, key_type],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists > 0 {
            skipped += 1;
            continue;
        }
        let key_data = raw_line
            .split_whitespace()
            .nth(2)
            .unwrap_or_default()
            .to_string();
        let fingerprint = if fingerprint.is_empty() {
            sqlite::compute_fingerprint(&key_data)
        } else {
            fingerprint
        };
        let now = sqlite::now_iso();
        conn.execute(
            "INSERT INTO known_hosts (id, host, key_type, fingerprint, last_used, added_date, key_data, raw_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                sqlite::new_id("kh"),
                host,
                key_type,
                fingerprint,
                now,
                now,
                key_data,
                raw_line,
            ],
        )
        .map_err(|e| e.to_string())?;
        added += 1;
    }

    append_log_i18n(
        &conn,
        "info",
        "logMessages.knownHostImported",
        Some(serde_json::json!({ "added": added, "skipped": skipped })),
        Some("known_hosts"),
    )?;
    Ok(added)
}
