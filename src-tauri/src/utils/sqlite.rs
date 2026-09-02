use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use chrono::{DateTime, Local, Utc};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::utils::path::{app_data_dir, home_dir};

const DATABASE_FILE: &str = "data.sqlite3";

pub fn db_path() -> PathBuf {
    app_data_dir().join(DATABASE_FILE)
}

pub fn open_connection() -> Result<Connection, String> {
    Connection::open(db_path()).map_err(|e| e.to_string())
}

pub fn init_database() -> Result<(), String> {
    let conn = open_connection()?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS hosts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            account_id TEXT,
            username TEXT NOT NULL,
            status TEXT NOT NULL,
            last_connected TEXT,
            auth_type TEXT,
            password TEXT,
            key_id TEXT,
            use_proxy INTEGER,
            proxy_host_id TEXT,
            proxy_auth_type TEXT,
            proxy_key_id TEXT,
            proxy_cert_id TEXT,
            proxy_host TEXT,
            proxy_port INTEGER,
            proxy_username TEXT,
            proxy_password TEXT
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT,
            key_id TEXT,
            certificate_id TEXT,
            description TEXT,
            created_at TEXT NOT NULL,
            last_used TEXT,
            tags_json TEXT
        );

        CREATE TABLE IF NOT EXISTS keys (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            key_type TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            size INTEGER NOT NULL,
            key_path TEXT,
            public_key_path TEXT,
            source TEXT
        );

        CREATE TABLE IF NOT EXISTS certificates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cert_type TEXT NOT NULL,
            key_type TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            cert_path TEXT,
            private_key_path TEXT,
            principals_json TEXT,
            valid_after TEXT,
            valid_before TEXT,
            source TEXT,
            cert_content TEXT,
            private_key_content TEXT
        );

        CREATE TABLE IF NOT EXISTS sftp_connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT,
            key_path TEXT,
            passphrase TEXT,
            key_id TEXT,
            remote_path TEXT NOT NULL,
            last_accessed TEXT
        );

        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            description TEXT,
            category TEXT NOT NULL,
            tags_json TEXT,
            created_at TEXT NOT NULL,
            last_used TEXT
        );

        CREATE TABLE IF NOT EXISTS logs (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            source TEXT,
            log_key TEXT,
            params TEXT
        );

        CREATE TABLE IF NOT EXISTS known_hosts (
            id TEXT PRIMARY KEY,
            host TEXT NOT NULL,
            key_type TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            last_used TEXT NOT NULL,
            added_date TEXT NOT NULL,
            raw_line TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS port_forwardings (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            host_id TEXT,
            listen_host TEXT NOT NULL,
            listen_port INTEGER NOT NULL,
            target_host TEXT,
            target_port INTEGER NOT NULL,
            status TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            last_used TEXT,
            socks_username TEXT,
            socks_password TEXT
        );

        CREATE TABLE IF NOT EXISTS monitor_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            host_ids TEXT NOT NULL DEFAULT '[]',
            auto_start INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    ensure_column(&conn, "logs", "log_key", "TEXT")?;
    ensure_column(&conn, "logs", "params", "TEXT")?;
    ensure_column(&conn, "hosts", "account_id", "TEXT")?;
    ensure_column(&conn, "hosts", "certificate_id", "TEXT")?;
    ensure_column(&conn, "hosts", "proxy_cert_id", "TEXT")?;
    ensure_column(&conn, "sftp_connections", "key_id", "TEXT")?;
    ensure_column(&conn, "keys", "key_path", "TEXT")?;
    ensure_column(&conn, "keys", "public_key_path", "TEXT")?;
    ensure_column(&conn, "keys", "source", "TEXT")?;
    ensure_column(&conn, "keys", "private_key", "TEXT")?;
    ensure_column(&conn, "keys", "public_key", "TEXT")?;
    ensure_column(&conn, "certificates", "cert_content", "TEXT")?;
    ensure_column(&conn, "certificates", "private_key_content", "TEXT")?;
    ensure_column(&conn, "port_forwardings", "socks_username", "TEXT")?;
    ensure_column(&conn, "port_forwardings", "socks_password", "TEXT")?;

    normalize_key_type_values(&conn)?;
    migrate_key_files_to_db(&conn)?;
    migrate_cert_files_to_db(&conn)?;

    bootstrap_known_hosts(&conn)?;

    // 一次性迁移：旧明文凭据尽力搬入系统密钥链后清空列
    migrate_plaintext_secrets(&conn);

    // 隧道连接状态是内存态（存于 TunnelManager），不在 DB 持久化，无需重置 status 列
    Ok(())
}

/// 一次性迁移：把 keys 表中早期 create_key_pair 写入的原始算法名
/// （如 `ssh-ed25519` / `ssh-rsa` / `ecdsa-sha2-nistp256`）规范化为
/// `ED25519` / `RSA` / `ECDSA`，与前端 `Key.type` 枚举对齐。幂等。
fn normalize_key_type_values(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE keys SET key_type = 'ED25519' WHERE lower(key_type) LIKE '%ed25519%'",
        rusqlite::params![],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE keys SET key_type = 'ECDSA' WHERE lower(key_type) LIKE '%ecdsa%'",
        rusqlite::params![],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE keys SET key_type = 'RSA' WHERE lower(key_type) LIKE '%rsa%'",
        rusqlite::params![],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 一次性迁移：把旧版本存成文件的密钥内容读入数据库（keys.private_key/public_key），
/// 成功后删除托管目录内的旧文件，实现「密钥内容只存数据库、不再落盘」。幂等——
/// 仅处理内容列仍为 NULL 且文件路径仍存在的记录。
fn migrate_key_files_to_db(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, key_path, public_key_path FROM keys
             WHERE (private_key IS NULL OR private_key = '') OR (public_key IS NULL OR public_key = '')",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    for (id, key_path, public_key_path) in rows {
        let private = key_path.as_deref().and_then(|p| fs::read_to_string(p).ok());
        let public = public_key_path
            .as_deref()
            .and_then(|p| fs::read_to_string(p).ok());

        conn.execute(
            "UPDATE keys SET
                private_key = COALESCE(NULLIF(private_key, ''), ?1),
                public_key = COALESCE(NULLIF(public_key, ''), ?2)
             WHERE id = ?3",
            rusqlite::params![private, public, id],
        )
        .map_err(|e| e.to_string())?;

        // 内容成功读入才清空路径并删除旧文件；否则保留路径避免数据丢失
        let has_content = private.is_some() || public.is_some();
        if has_content {
            conn.execute(
                "UPDATE keys SET key_path = NULL, public_key_path = NULL WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
            for path in [key_path.as_deref(), public_key_path.as_deref()]
                .into_iter()
                .flatten()
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

/// 一次性迁移：把旧版本存成文件的证书内容读入数据库（certificates.cert_content/
/// private_key_content），成功后删除托管目录内的旧文件，实现「证书内容只存数据库、
/// 不再落盘」。幂等——仅处理内容列仍为 NULL 且文件路径仍存在的记录。
fn migrate_cert_files_to_db(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, cert_path, private_key_path FROM certificates
             WHERE (cert_content IS NULL OR cert_content = '')
                OR (private_key_content IS NULL OR private_key_content = '')",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    for (id, cert_path, private_key_path) in rows {
        let cert = cert_path.as_deref().and_then(|p| fs::read_to_string(p).ok());
        let private = private_key_path
            .as_deref()
            .and_then(|p| fs::read_to_string(p).ok());

        conn.execute(
            "UPDATE certificates SET
                cert_content = COALESCE(NULLIF(cert_content, ''), ?1),
                private_key_content = COALESCE(NULLIF(private_key_content, ''), ?2)
             WHERE id = ?3",
            rusqlite::params![cert, private, id],
        )
        .map_err(|e| e.to_string())?;

        // 内容成功读入才清空路径并删除旧文件；否则保留路径避免数据丢失
        let has_content = cert.is_some() || private.is_some();
        if has_content {
            conn.execute(
                "UPDATE certificates SET cert_path = NULL, private_key_path = NULL WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
            for path in [cert_path.as_deref(), private_key_path.as_deref()]
                .into_iter()
                .flatten()
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

fn migrate_plaintext_secrets(conn: &Connection) {
    migrate_secret_column(conn, "hosts", "password", "hosts/{id}/password");
    migrate_secret_column(conn, "hosts", "proxy_password", "hosts/{id}/proxy_password");
    migrate_secret_column(conn, "accounts", "password", "accounts/{id}/password");
    migrate_secret_column(conn, "sftp_connections", "password", "sftp/{id}/password");
    migrate_secret_column(conn, "sftp_connections", "passphrase", "sftp/{id}/passphrase");
}

fn migrate_secret_column(conn: &Connection, table: &str, column: &str, key_template: &str) {
    let sql = format!(
        "SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL AND {column} != ''"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(e) => {
            eprintln!("Failed to prepare secret migration for {table}.{column}: {e}");
            return;
        }
    };
    let rows = match stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("Failed to query secrets for migration {table}.{column}: {e}");
            return;
        }
    };

    for row in rows {
        let Ok((id, secret)) = row else {
            continue;
        };
        let key = key_template.replace("{id}", &id);
        match crate::utils::secrets::set_secret(&key, &secret) {
            Ok(()) => {
                let update = format!("UPDATE {table} SET {column} = '' WHERE id = ?1");
                if let Err(e) = conn.execute(&update, rusqlite::params![id]) {
                    eprintln!("Failed to clear migrated secret {table}.{column}: {e}");
                }
            }
            Err(e) => eprintln!("Failed to migrate secret {table}.{column} for {id} to keyring: {e}"),
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{prefix}-{nanos}")
}

pub fn keys_dir() -> PathBuf {
    let dir = app_data_dir().join("keys");
    fs::create_dir_all(&dir).expect("failed to create keys directory");
    dir
}

pub fn certificates_dir() -> PathBuf {
    let dir = app_data_dir().join("certificates");
    fs::create_dir_all(&dir).expect("failed to create certificates directory");
    dir
}

pub fn known_hosts_file_path() -> PathBuf {
    home_dir().join(".ssh").join("known_hosts")
}

pub fn read_known_hosts_file() -> Result<String, String> {
    let path = known_hosts_file_path();
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_known_hosts_file(content: &str) -> Result<(), String> {
    let path = known_hosts_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

pub fn sanitize_file_stem(input: &str) -> String {
    let sanitized: String = input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "key".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let has_column = columns
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|value| value == column);

    if !has_column {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn parse_public_key(public_key: &str) -> (String, String) {
    let parts: Vec<&str> = public_key.split_whitespace().collect();
    let key_type = parts.first().copied().unwrap_or("unknown").to_string();
    let fingerprint = parts
        .get(1)
        .map(|blob| compute_fingerprint(blob))
        .unwrap_or_else(|| "SHA256:invalid".to_string());
    (key_type, fingerprint)
}

fn bootstrap_known_hosts(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM known_hosts", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if count == 0 {
        refresh_known_hosts_table(conn)?;
    }

    Ok(())
}

pub fn refresh_known_hosts_table(conn: &Connection) -> Result<(), String> {
    let content = read_known_hosts_file()?;
    conn.execute("DELETE FROM known_hosts", []).map_err(|e| e.to_string())?;

    let file_modified = fs::metadata(known_hosts_file_path())
        .and_then(|meta| meta.modified())
        .ok()
        .map(|time| DateTime::<Local>::from(time).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string());

    for (line_no, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }

        let host = parts[0].to_string();
        let key_type = parts[1].to_string();
        let fingerprint = compute_fingerprint(parts[2]);
        let id = format!("kh-{}", line_no + 1);

        conn.execute(
            "INSERT INTO known_hosts (id, host, key_type, fingerprint, last_used, added_date, raw_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, host, key_type, fingerprint, file_modified, file_modified, line],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn compute_fingerprint(key_blob_base64: &str) -> String {
    match STANDARD.decode(key_blob_base64) {
        Ok(bytes) => {
            let digest = Sha256::digest(bytes);
            format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
        }
        Err(_) => "SHA256:invalid".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{compute_fingerprint, new_id, now_iso};

    #[test]
    fn new_id_has_prefix() {
        let id = new_id("pf");
        assert!(id.starts_with("pf-"), "id 应以前缀开头: {id}");
        assert!(id.len() > 3, "id 应含纳秒时间戳: {id}");
    }

    #[test]
    fn now_iso_is_rfc3339() {
        let s = now_iso();
        assert!(s.contains('T'), "应含 T 分隔符: {s}");
        assert!(s.contains('+') || s.contains('Z'), "应含时区: {s}");
    }

    #[test]
    fn compute_fingerprint_valid_base64() {
        // "aGVsbG8=" 是 "hello" 的 base64 编码
        let fp = compute_fingerprint("aGVsbG8=");
        assert!(fp.starts_with("SHA256:"), "应返回 SHA256 前缀: {fp}");
        assert!(fp.len() > 7, "指纹应非空: {fp}");
    }

    #[test]
    fn compute_fingerprint_invalid_base64() {
        assert_eq!(compute_fingerprint("!!!invalid!!!"), "SHA256:invalid");
    }
}
