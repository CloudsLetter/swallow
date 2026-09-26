use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::services::common::{resolve_secret, store_secret_or_clear};
use crate::services::transfer;
use crate::utils::sqlite;

/// 桌面连接（VNC/RDP）会话簿条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConn {
    pub id: String,
    pub name: String,
    /// "vnc" | "rdp"
    pub protocol: String,
    pub host: String,
    pub port: u16,
    /// RDP 用户名（VNC 直连无）
    pub username: Option<String>,
    /// VNC 密码 / RDP 密码（经 SSH 隧道时 VNC 密码在此）；空则连接时让远端提示
    pub password: Option<String>,
    /// VNC 经 SSH 隧道：跳板主机 id（复用该主机已存认证，不重复存凭据）
    pub jump_host_id: Option<String>,
    pub created: String,
}

impl Default for RemoteConn {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            protocol: "vnc".into(),
            host: String::new(),
            port: 5900,
            username: None,
            password: None,
            jump_host_id: None,
            created: String::new(),
        }
    }
}

fn secret_key(id: &str) -> String {
    format!("remote/{id}/password")
}

#[tauri::command]
pub fn list_remote_conns() -> Result<Vec<RemoteConn>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, protocol, host, port, username, password, jump_host_id, created
             FROM remote_conns ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let mut c = RemoteConn {
                id: row.get(0)?,
                name: row.get(1)?,
                protocol: row.get(2)?,
                host: row.get(3)?,
                port: row.get(4)?,
                username: row.get(5)?,
                password: row.get(6)?,
                jump_host_id: row.get(7)?,
                created: row.get(8)?,
            };
            c.password = resolve_secret(c.password.take(), &secret_key(&c.id));
            Ok(c)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

const EXPORT_CATEGORY: &str = "remoteConns";

/// 收集桌面连接用于导出，按需脱敏。
fn export_items(include_secrets: bool) -> Result<Vec<RemoteConn>, String> {
    let mut items = list_remote_conns()?;
    if !include_secrets {
        for item in &mut items {
            transfer::scrub(&mut item.password);
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn export_remote_conns(include_secrets: bool) -> Result<String, String> {
    let items = export_items(include_secrets)?;
    transfer::build(EXPORT_CATEGORY, include_secrets, items)
}

#[tauri::command]
pub fn export_remote_conns_to(target_path: String, include_secrets: bool) -> Result<usize, String> {
    let items = export_items(include_secrets)?;
    let count = items.len();
    let content = transfer::build(EXPORT_CATEGORY, include_secrets, items)?;
    transfer::write_to(&target_path, &content, count)
}

/// 导入桌面连接：追加语义（清空 id 后逐条新建）。
///
/// ⚠️ `jump_host_id` 指向该文件之外的主机条目。若宿主机库不匹配，
/// 该字段会成为悬空引用（表现为「VNC 隧道跳板机不存在」）。导入时
/// 按原值保留而不清空——先如实搬运，让用户在 UI 上看到并自行修正。
#[tauri::command]
pub fn import_remote_conns_text(text: String) -> Result<usize, String> {
    let (items, _) = transfer::parse::<RemoteConn>(EXPORT_CATEGORY, &text)?;
    let mut count = 0usize;
    for mut item in items {
        item.id = String::new();
        save_remote_conn(item)?;
        count += 1;
    }
    Ok(count)
}


#[tauri::command]
pub fn save_remote_conn(mut conn_item: RemoteConn) -> Result<RemoteConn, String> {
    let conn = sqlite::open_connection()?;
    let is_new = conn_item.id.trim().is_empty();
    if is_new {
        conn_item.id = sqlite::new_id("remote");
        conn_item.created = chrono::Utc::now().to_rfc3339();
    }
    let password = std::mem::take(&mut conn_item.password);
    store_secret_or_clear(&secret_key(&conn_item.id), password.as_deref())?;

    conn.execute(
        "INSERT INTO remote_conns (id, name, protocol, host, port, username, password, jump_host_id, created)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            protocol = excluded.protocol,
            host = excluded.host,
            port = excluded.port,
            username = excluded.username,
            password = excluded.password,
            jump_host_id = excluded.jump_host_id,
            created = excluded.created",
        params![
            conn_item.id,
            conn_item.name,
            conn_item.protocol,
            conn_item.host,
            conn_item.port,
            conn_item.username,
            password, // 已 take，回填占位列（实际内容在密钥链）
            conn_item.jump_host_id,
            conn_item.created,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn_item)
}

#[tauri::command]
pub fn delete_remote_conn(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    conn.execute("DELETE FROM remote_conns WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
