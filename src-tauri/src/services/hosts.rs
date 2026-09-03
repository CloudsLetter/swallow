use rusqlite::{params, OptionalExtension};

use crate::models::data::Host;
use crate::services::common::{resolve_secret, store_secret_or_clear};
use crate::services::logs::append_log_i18n;
use crate::utils::secrets;
use crate::utils::sqlite;

#[tauri::command]
pub fn list_hosts() -> Result<Vec<Host>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, port, account_id, username, status, last_connected, auth_type, password,
                    key_id, certificate_id, use_proxy, proxy_host_id, proxy_auth_type, proxy_key_id,
                    proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password
             FROM hosts ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let mut host = Host {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                account_id: row.get(4)?,
                username: row.get(5)?,
                status: row.get(6)?,
                last_connected: row.get(7)?,
                auth_type: row.get(8)?,
                password: row.get(9)?,
                key_id: row.get(10)?,
                certificate_id: row.get(11)?,
                use_proxy: row.get(12)?,
                proxy_host_id: row.get(13)?,
                proxy_auth_type: row.get(14)?,
                proxy_key_id: row.get(15)?,
                proxy_cert_id: row.get(16)?,
                proxy_host: row.get(17)?,
                proxy_port: row.get(18)?,
                proxy_username: row.get(19)?,
                proxy_password: row.get(20)?,
            };
            host.password = resolve_secret(host.password.take(), &format!("hosts/{}/password", host.id));
            host.proxy_password =
                resolve_secret(host.proxy_password.take(), &format!("hosts/{}/proxy_password", host.id));
            Ok(host)
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn save_host(mut host: Host) -> Result<Host, String> {
    let conn = sqlite::open_connection()?;
    let is_new = host.id.trim().is_empty();
    if is_new {
        host.id = sqlite::new_id("host");
        if host.status.trim().is_empty() {
            host.status = "disconnected".to_string();
        }
    }

    // 凭据写入系统密钥链，数据库列清空（不再落盘明文）
    let password = std::mem::take(&mut host.password);
    let proxy_password = std::mem::take(&mut host.proxy_password);
    store_secret_or_clear(&format!("hosts/{}/password", host.id), password.as_deref())?;
    store_secret_or_clear(&format!("hosts/{}/proxy_password", host.id), proxy_password.as_deref())?;

    conn.execute(
        "INSERT INTO hosts (
            id, name, host, port, account_id, username, status, last_connected, auth_type, password,
            key_id, certificate_id, use_proxy, proxy_host_id, proxy_auth_type, proxy_key_id,
            proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16,
            ?17, ?18, ?19, ?20, ?21
         )
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            host = excluded.host,
            port = excluded.port,
            account_id = excluded.account_id,
            username = excluded.username,
            status = excluded.status,
            last_connected = excluded.last_connected,
            auth_type = excluded.auth_type,
            password = excluded.password,
            key_id = excluded.key_id,
            certificate_id = excluded.certificate_id,
            use_proxy = excluded.use_proxy,
            proxy_host_id = excluded.proxy_host_id,
            proxy_auth_type = excluded.proxy_auth_type,
            proxy_key_id = excluded.proxy_key_id,
            proxy_cert_id = excluded.proxy_cert_id,
            proxy_host = excluded.proxy_host,
            proxy_port = excluded.proxy_port,
            proxy_username = excluded.proxy_username,
            proxy_password = excluded.proxy_password",
        params![
            host.id,
            host.name,
            host.host,
            host.port,
            host.account_id,
            host.username,
            host.status,
            host.last_connected,
            host.auth_type,
            host.password,
            host.key_id,
            host.certificate_id,
            host.use_proxy,
            host.proxy_host_id,
            host.proxy_auth_type,
            host.proxy_key_id,
            host.proxy_cert_id,
            host.proxy_host,
            host.proxy_port,
            host.proxy_username,
            host.proxy_password
        ],
    )
    .map_err(|e| e.to_string())?;

    append_log_i18n(
        &conn,
        "info",
        if is_new { "logMessages.hostCreated" } else { "logMessages.hostUpdated" },
        Some(serde_json::json!({ "name": host.name })),
        Some("hosts"),
    )?;

    Ok(host)
}


#[tauri::command]
pub fn delete_host(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let name: Option<String> = conn
        .query_row("SELECT name FROM hosts WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM hosts WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;

    // 同步清理密钥链条目，避免残留
    let _ = secrets::delete_secret(&format!("hosts/{}/password", id));
    let _ = secrets::delete_secret(&format!("hosts/{}/proxy_password", id));

    append_log_i18n(
        &conn,
        "info",
        "logMessages.hostDeleted",
        Some(serde_json::json!({ "name": name.unwrap_or_else(|| "unknown".to_string()) })),
        Some("hosts"),
    )?;

    Ok(())
}

/// 连接成功后回写最近连接时间（last_connected），供「最近连接」排序/时间显示。
/// 按 host + port 定位（快速连接无 host id 也能覆盖）。
#[tauri::command]
pub fn touch_host_last_connected(host: String, port: u16) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    conn.execute(
        "UPDATE hosts SET last_connected = ?1 WHERE host = ?2 AND port = ?3",
        rusqlite::params![crate::utils::sqlite::now_iso(), host, port],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
