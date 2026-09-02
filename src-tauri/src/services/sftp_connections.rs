use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::config::global_config::GlobaConfig;
use crate::models::data::SftpConnection;
use crate::services::common::{resolve_secret, store_secret_or_clear};
use crate::services::keys::load_key_content;
use crate::services::logs::append_log;
use crate::sftp::{SftpConfig, SftpSession};
use crate::ssh::session::DEFAULT_CONNECTION_TIMEOUT_SECS;
use crate::utils::secrets;
use crate::utils::sqlite;

#[tauri::command]
pub fn list_sftp_connections() -> Result<Vec<SftpConnection>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, port, protocol, username, auth_type, password, key_path, passphrase, key_id, remote_path, last_accessed
             FROM sftp_connections ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let mut connection = SftpConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                protocol: row.get(4)?,
                username: row.get(5)?,
                auth_type: row.get(6)?,
                password: row.get(7)?,
                key_path: row.get(8)?,
                passphrase: row.get(9)?,
                key_id: row.get(10)?,
                remote_path: row.get(11)?,
                last_accessed: row.get(12)?,
            };
            connection.password =
                resolve_secret(connection.password.take(), &format!("sftp/{}/password", connection.id));
            connection.passphrase =
                resolve_secret(connection.passphrase.take(), &format!("sftp/{}/passphrase", connection.id));
            Ok(connection)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn save_sftp_connection(mut connection: SftpConnection) -> Result<SftpConnection, String> {
    let conn = sqlite::open_connection()?;
    let is_new = connection.id.trim().is_empty();
    if is_new {
        connection.id = sqlite::new_id("sftp");
    }

    // 凭据写入系统密钥链，数据库列清空（不再落盘明文）
    let password = std::mem::take(&mut connection.password);
    let passphrase = std::mem::take(&mut connection.passphrase);
    store_secret_or_clear(&format!("sftp/{}/password", connection.id), password.as_deref())?;
    store_secret_or_clear(&format!("sftp/{}/passphrase", connection.id), passphrase.as_deref())?;

    conn.execute(
        "INSERT INTO sftp_connections (
            id, name, host, port, protocol, username, auth_type, password, key_path, passphrase, key_id, remote_path, last_accessed
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            host = excluded.host,
            port = excluded.port,
            protocol = excluded.protocol,
            username = excluded.username,
            auth_type = excluded.auth_type,
            password = excluded.password,
            key_path = excluded.key_path,
            passphrase = excluded.passphrase,
            key_id = excluded.key_id,
            remote_path = excluded.remote_path,
            last_accessed = excluded.last_accessed",
        params![
            connection.id,
            connection.name,
            connection.host,
            connection.port,
            connection.protocol,
            connection.username,
            connection.auth_type,
            connection.password,
            connection.key_path,
            connection.passphrase,
            connection.key_id,
            connection.remote_path,
            connection.last_accessed
        ],
    )
    .map_err(|e| e.to_string())?;

    append_log(
        &conn,
        "info",
        &format!(
            "{} {} connection {}",
            if is_new { "Created" } else { "Updated" },
            connection.protocol.to_uppercase(),
            connection.name
        ),
        Some("sftp"),
    )?;

    Ok(connection)
}


#[tauri::command]
pub fn delete_sftp_connection(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let name: Option<String> = conn
        .query_row("SELECT name FROM sftp_connections WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sftp_connections WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;
    let _ = secrets::delete_secret(&format!("sftp/{}/password", id));
    let _ = secrets::delete_secret(&format!("sftp/{}/passphrase", id));
    append_log(
        &conn,
        "info",
        &format!("Deleted SFTP connection {}", name.unwrap_or_else(|| "unknown".to_string())),
        Some("sftp"),
    )?;
    Ok(())
}


#[tauri::command]
pub fn test_sftp_connection(
    config_state: State<'_, GlobaConfig>,
    id: String,
) -> Result<bool, String> {
    let conn = sqlite::open_connection()?;
    let timeout_secs = config_state
        .config
        .read()
        .map(|guard| guard.ssh.connection_timeout)
        .unwrap_or(DEFAULT_CONNECTION_TIMEOUT_SECS);
    let mut record = conn
        .query_row(
            "SELECT host, port, username, protocol, auth_type, password, key_path, passphrase, key_id
             FROM sftp_connections WHERE id = ?1",
            params![&id],
            |row| {
                Ok(SftpConnection {
                    id: String::new(),
                    name: String::new(),
                    host: row.get(0)?,
                    port: row.get(1)?,
                    protocol: row.get(3)?,
                    username: row.get(2)?,
                    auth_type: row.get(4)?,
                    password: row.get(5)?,
                    key_path: row.get(6)?,
                    passphrase: row.get(7)?,
                    key_id: row.get(8)?,
                    remote_path: String::new(),
                    last_accessed: None,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    record.password = resolve_secret(record.password.take(), &format!("sftp/{}/password", id));
    record.passphrase = resolve_secret(record.passphrase.take(), &format!("sftp/{}/passphrase", id));

    let mut config = SftpConfig {
        host: record.host.clone(),
        port: record.port,
        username: record.username.clone(),
        protocol: record.protocol.clone(),
        auth_type: record.auth_type.clone(),
        password: record.password.clone(),
        key_path: record.key_path.clone(),
        passphrase: record.passphrase.clone(),
        key_id: None,
        private_key: None,
        public_key: None,
    };

    // 公钥认证：按 key_id 从密钥库读取内容（与连接命令一致）
    if config.protocol == "sftp" && config.auth_type == "publickey" {
        if let Some(key_id) = record.key_id.clone() {
            match load_key_content(&conn, &key_id) {
                Ok((private_key, public_key)) => {
                    if private_key.is_none() && public_key.is_none() {
                        append_log(
                            &conn,
                            "error",
                            &format!("SFTP test failed for {}: key content missing ({})", record.host, key_id),
                            Some("sftp"),
                        )?;
                        return Ok(false);
                    }
                    config.private_key = private_key;
                    config.public_key = public_key;
                }
                Err(err) => {
                    let _ = append_log(
                        &conn,
                        "error",
                        &format!("SFTP test failed for {}: load key {}: {}", record.host, key_id, err),
                        Some("sftp"),
                    );
                    return Ok(false);
                }
            }
        }
    }

    // 测试连接短命：禁用应用层 keepalive（0 = 关闭）
    match SftpSession::connect(config, timeout_secs, 0) {
        Ok(_) => {
            append_log(
                &conn,
                "info",
                &format!("Tested {} connection successfully", record.host),
                Some("sftp"),
            )?;
            Ok(true)
        }
        Err(err) => {
            append_log(
                &conn,
                "error",
                &format!("SFTP test failed for {}: {}", record.host, err),
                Some("sftp"),
            )?;
            Ok(false)
        }
    }
}
