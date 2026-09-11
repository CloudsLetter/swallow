use rusqlite::{params, OptionalExtension};

use crate::models::data::Host;
use crate::services::common::{parse_tags, resolve_secret, store_secret_or_clear, to_tags_json};
use crate::services::logs::append_log_i18n;
use crate::utils::secrets;
use crate::utils::sqlite;

/// 连接时的 OS 探测策略：取主机的 (icon 是否已设置, os_auto)。
/// 无该主机行（快速连接/未入库）视为 (false, true)（自动探测）。
pub fn host_os_probe_policy(host: &str, port: u16) -> (bool, bool) {
    let default = (false, true);
    let Ok(conn) = sqlite::open_connection() else { return default };
    let Ok(mut stmt) = conn
        .prepare("SELECT icon, os_auto FROM hosts WHERE host = ?1 AND port = ?2")
    else {
        return default;
    };
    let Ok(mut rows) = stmt
        .query_map(params![host, i64::from(port)], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)? != 0,
            ))
        })
    else {
        return default;
    };
    match rows.next().transpose() {
        Ok(Some((icon, auto))) => (icon.is_some(), auto),
        _ => default,
    }
}


#[tauri::command]
pub fn list_hosts() -> Result<Vec<Host>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, port, account_id, username, status, last_connected, auth_type, password,
                    key_id, certificate_id, use_proxy, proxy_host_id, proxy_auth_type, proxy_key_id,
                    proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password, icon, backend,
                    algo_profile, os_auto, group_name, tags_json, favorite
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
                icon: row.get(21)?,
                backend: row.get(22)?,
                algo_profile: row.get(23)?,
                os_auto: row.get::<_, i64>(24)? != 0,
                group: row.get(25).unwrap_or_default(),
                tags: parse_tags(row.get(26)?),
                favorite: row.get::<_, i64>(27).unwrap_or(0) != 0,
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
            proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password, icon, backend,
            algo_profile, os_auto, group_name, tags_json, favorite
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16,
            ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
            ?26, ?27, ?28
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
            proxy_password = excluded.proxy_password,
            icon = excluded.icon,
            backend = excluded.backend,
            algo_profile = excluded.algo_profile,
            os_auto = excluded.os_auto,
            group_name = excluded.group_name,
            tags_json = excluded.tags_json,
            favorite = excluded.favorite",
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
            host.proxy_password,
            host.icon,
            host.backend,
            host.algo_profile,
            host.os_auto,
            host.group,
            to_tags_json(&host.tags),
            host.favorite as i64
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

/// 导出全部主机为 JSON（含凭据明文：调用前已弹确认，文件只写用户选定的目标路径）。
#[tauri::command]
pub fn export_hosts() -> Result<String, String> {
    let hosts = list_hosts()?;
    serde_json::to_string_pretty(&hosts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_hosts_to(target_path: String) -> Result<usize, String> {
    let content = export_hosts()?;
    let count: usize = serde_json::from_str::<Vec<Host>>(&content)
        .map(|v| v.len())
        .unwrap_or(0);
    std::fs::write(&target_path, content).map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn toggle_host_favorite(id: String) -> Result<Host, String> {
    let conn = sqlite::open_connection()?;
    conn.execute(
        "UPDATE hosts SET favorite = CASE WHEN favorite IS NULL OR favorite = 0 THEN 1 ELSE 0 END WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    list_hosts()?
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| "主机不存在".to_string())
}

/// 从 JSON 导入主机：解析 Swallow 导出格式或 ~/.ssh/config 文本（二者其一）。
/// 返回成功导入条数；失败整批报错、不写半截数据。
#[tauri::command]
pub fn import_hosts_text(text: String) -> Result<usize, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("导入内容为空".to_string());
    }
    if let Ok(items) = serde_json::from_str::<Vec<Host>>(trimmed) {
        return import_host_records(items);
    }
    if let Ok(item) = serde_json::from_str::<Host>(trimmed) {
        return import_host_records(vec![item]);
    }
    let parsed = parse_ssh_config(trimmed);
    if parsed.is_empty() {
        return Err("无法识别：既不是 Swallow 主机 JSON，也不是 ~/.ssh/config 格式".to_string());
    }
    import_host_records(parsed)
}

fn import_host_records(mut items: Vec<Host>) -> Result<usize, String> {
    for item in &mut items {
        item.id = String::new();
        if item.status.trim().is_empty() {
            item.status = "disconnected".to_string();
        }
        if item.port == 0 {
            item.port = 22;
        }
        if item.username.trim().is_empty() {
            item.username = "root".to_string();
        }
        if item.auth_type.as_deref().unwrap_or("").is_empty() {
            item.auth_type = Some(if item.password.as_deref().unwrap_or("").is_empty() {
                "none".to_string()
            } else {
                "password".to_string()
            });
        }
    }
    let mut count = 0;
    for item in items {
        save_host(item)?;
        count += 1;
    }
    Ok(count)
}

/// 极简 ~/.ssh/config 解析：Host 别名 + HostName + Port + User（ProxyJump 映射为 proxyHost 内联）。
fn parse_ssh_config(text: &str) -> Vec<Host> {
    #[derive(Default)]
    struct Block {
        name: String,
        hostname: String,
        port: u16,
        user: String,
        proxy: String,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Block> = None;
    let flush = |c: &mut Option<Block>, out: &mut Vec<Block>| {
        if let Some(b) = c.take() {
            if !b.name.is_empty() && b.name != "*" {
                out.push(b);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or("").to_lowercase();
        let value = parts.next().unwrap_or("").trim().trim_matches('"').to_string();
        if key == "host" {
            flush(&mut current, &mut blocks);
            let first = value.split_whitespace().next().unwrap_or("").to_string();
            if first.contains('*') || first.contains('?') || first.is_empty() {
                continue;
            }
            current = Some(Block { name: first, port: 22, user: "root".into(), ..Default::default() });
        } else if let Some(b) = current.as_mut() {
            match key.as_str() {
                "hostname" => b.hostname = value,
                "port" => b.port = value.parse().unwrap_or(22),
                "user" => b.user = value,
                "proxyjump" => b.proxy = value.split(',').next().unwrap_or("").trim().to_string(),
                _ => {}
            }
        }
    }
    flush(&mut current, &mut blocks);
    blocks
        .into_iter()
        .map(|b| {
            let addr = if b.hostname.is_empty() { b.name.clone() } else { b.hostname };
            let use_proxy = !b.proxy.is_empty();
            Host {
                name: b.name,
                host: addr,
                port: if b.port == 0 { 22 } else { b.port },
                username: if b.user.is_empty() { "root".into() } else { b.user },
                status: "disconnected".into(),
                auth_type: Some("none".into()),
                use_proxy: Some(use_proxy),
                proxy_host: if use_proxy { Some(b.proxy) } else { None },
                proxy_port: if use_proxy { Some(22) } else { None },
                ..Default::default()
            }
        })
        .collect()
}
