use std::fs;
use std::process::Command;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};

use crate::models::data::{
    CreateKeyPairRequest, ExportedKeyFile, ImportKeyRequest, ImportKeyTextRequest, KeyContent, KeyRecord,
};
use crate::services::logs::append_log_i18n;
use crate::utils::sqlite;

fn load_key_record(conn: &Connection, id: &str) -> Result<KeyRecord, String> {
    conn.query_row(
        "SELECT id, name, key_type, fingerprint, created_at, size, key_path, public_key_path, source
         FROM keys WHERE id = ?1",
        params![id],
        |row| {
            Ok(KeyRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                key_type: row.get(2)?,
                fingerprint: row.get(3)?,
                created_at: row.get(4)?,
                size: row.get(5)?,
                key_path: row.get(6)?,
                public_key_path: row.get(7)?,
                source: row.get(8)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}


fn save_key_record(conn: &Connection, mut key: KeyRecord) -> Result<KeyRecord, String> {
    let is_new = key.id.trim().is_empty();
    if is_new {
        key.id = sqlite::new_id("key");
        if key.created_at.trim().is_empty() {
            key.created_at = sqlite::now_iso();
        }
    }

    conn.execute(
        "INSERT INTO keys (id, name, key_type, fingerprint, created_at, size, key_path, public_key_path, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            key_type = excluded.key_type,
            fingerprint = excluded.fingerprint,
            created_at = excluded.created_at,
            size = excluded.size,
            key_path = excluded.key_path,
            public_key_path = excluded.public_key_path,
            source = excluded.source",
        params![
            key.id,
            key.name,
            key.key_type,
            key.fingerprint,
            key.created_at,
            key.size,
            key.key_path,
            key.public_key_path,
            key.source
        ],
    )
    .map_err(|e| e.to_string())?;

    append_log_i18n(
        conn,
        "info",
        if is_new { "logMessages.keyCreated" } else { "logMessages.keyUpdated" },
        Some(serde_json::json!({ "name": key.name })),
        Some("keys"),
    )?;

    Ok(key)
}


/// 将密钥内容（明文 PEM 文本）写入 keys 表的 private_key/public_key 列。
/// 密钥材料不再落盘成文件，统一由数据库托管。
fn save_key_content(
    conn: &Connection,
    id: &str,
    private_key: Option<&str>,
    public_key: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE keys SET private_key = ?1, public_key = ?2 WHERE id = ?3",
        params![private_key, public_key, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从数据库读取密钥内容，供 SSH 内存认证与详情展示使用。
pub fn load_key_content(
    conn: &Connection,
    id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    conn.query_row(
        "SELECT private_key, public_key FROM keys WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "该密钥已被删除或不存在，请到“账号/主机”页重新选择密钥。".to_string())
}


/// 将 ssh-keygen 输出的原始算法名（如 `ssh-ed25519` / `ssh-rsa` / `ecdsa-sha2-nistp256`）
/// 规范化为前端 `Key.type` 枚举使用的 `ED25519` / `RSA` / `ECDSA`。
fn normalize_key_type(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("ed25519") {
        "ED25519".to_string()
    } else if lower.contains("ecdsa") {
        "ECDSA".to_string()
    } else {
        "RSA".to_string()
    }
}


fn run_ssh_keygen(args: &[&str]) -> Result<(), String> {
    let output = Command::new("ssh-keygen")
        .args(args)
        .output()
        .map_err(|e| format!("ssh-keygen not available: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}


fn derive_public_key(private_key_path: &str) -> Result<String, String> {
    let output = Command::new("ssh-keygen")
        .args(["-y", "-f", private_key_path])
        .output()
        .map_err(|e| format!("ssh-keygen not available: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 通过 `ssh-keygen -l -f <pub>` 解析公钥真实位数（输出首段即 bits），
/// 失败时回退到 4096，避免导入密钥时位数硬编码导致显示不准确。
fn derive_key_size(public_key_path: &str) -> u32 {
    let Ok(output) = Command::new("ssh-keygen")
        .args(["-l", "-f", public_key_path])
        .output()
    else {
        return 4096;
    };
    if !output.status.success() {
        return 4096;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .and_then(|bits| bits.parse::<u32>().ok())
        .unwrap_or(4096)
}

/// 从内存中的私钥内容派生公钥：写入临时目录后调用 ssh-keygen -y，用完自动清理。
/// 不用 NamedTempFile——它在 Windows 上持有独占句柄，ssh-keygen fopen 会报 Permission denied。
fn derive_public_key_from_content(private_key: &str) -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let file = dir.path().join("key");
    fs::write(&file, private_key).map_err(|e| e.to_string())?;
    derive_public_key(&file.to_string_lossy())
}

/// 从内存中的公钥内容解析真实位数：写入临时目录后调用 ssh-keygen -l，失败回退 4096。
fn derive_key_size_from_content(public_key: &str) -> u32 {
    let Ok(dir) = tempfile::tempdir() else {
        return 4096;
    };
    let file = dir.path().join("key.pub");
    if fs::write(&file, public_key).is_err() {
        return 4096;
    }
    derive_key_size(&file.to_string_lossy())
}


#[tauri::command]
pub fn list_keys() -> Result<Vec<KeyRecord>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare("SELECT id, name, key_type, fingerprint, created_at, size, key_path, public_key_path, source FROM keys ORDER BY name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KeyRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                key_type: row.get(2)?,
                fingerprint: row.get(3)?,
                created_at: row.get(4)?,
                size: row.get(5)?,
                key_path: row.get(6)?,
                public_key_path: row.get(7)?,
                source: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn save_key(mut key: KeyRecord) -> Result<KeyRecord, String> {
    let conn = sqlite::open_connection()?;
    if key.source.is_none() {
        key.source = Some("record".to_string());
    }
    save_key_record(&conn, key)
}

/// 仅删除应用托管目录（keys_dir）内的密钥文件，避免误删用户外部私钥。

fn remove_managed_key_file(path: &str) {
    let Ok(target) = fs::canonicalize(path) else {
        // 文件不存在或无法解析，无需删除
        return;
    };
    let Ok(keys_dir) = fs::canonicalize(sqlite::keys_dir()) else {
        // 托管目录不可用时不做删除
        return;
    };

    if target.starts_with(&keys_dir) && target != keys_dir {
        let _ = fs::remove_file(path);
    } else {
        eprintln!("Skipped deleting key file outside managed directory: {}", path);
    }
}


#[tauri::command]
pub fn delete_key(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let key = conn
        .query_row(
            "SELECT id, name, key_type, fingerprint, created_at, size, key_path, public_key_path, source
             FROM keys WHERE id = ?1",
            params![id],
            |row| {
                Ok(KeyRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key_type: row.get(2)?,
                    fingerprint: row.get(3)?,
                    created_at: row.get(4)?,
                    size: row.get(5)?,
                    key_path: row.get(6)?,
                    public_key_path: row.get(7)?,
                    source: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(key) = key else {
        return Ok(());
    };

    if let Some(path) = &key.key_path {
        remove_managed_key_file(path);
    }
    if let Some(path) = &key.public_key_path {
        remove_managed_key_file(path);
    }

    conn.execute("DELETE FROM keys WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    append_log_i18n(
        &conn,
        "info",
        "logMessages.keyDeleted",
        Some(serde_json::json!({ "name": key.name })),
        Some("keys"),
    )?;
    Ok(())
}


#[tauri::command]
pub fn create_key_pair(request: CreateKeyPairRequest) -> Result<KeyRecord, String> {
    let conn = sqlite::open_connection()?;
    let id = sqlite::new_id("key");
    let file_stem = sqlite::sanitize_file_stem(&format!("{}-{}", request.name, &id));
    let private_path = sqlite::keys_dir().join(&file_stem);
    let public_path = private_path.with_extension("pub");
    let private_str = private_path.to_string_lossy().to_string();
    let passphrase = request.passphrase.unwrap_or_default();

    let mut args = vec!["-t", request.key_type.as_str(), "-f", private_str.as_str(), "-N", passphrase.as_str(), "-C", request.name.as_str()];
    let size_owned;
    if request.key_type.eq_ignore_ascii_case("RSA") {
        size_owned = request.size.to_string();
        args.push("-b");
        args.push(size_owned.as_str());
    } else if request.key_type.eq_ignore_ascii_case("ECDSA") {
        size_owned = if request.size == 0 { "256".to_string() } else { request.size.to_string() };
        args.push("-b");
        args.push(size_owned.as_str());
    }

    run_ssh_keygen(&args)?;

    let public_key = fs::read_to_string(&public_path).map_err(|e| e.to_string())?;
    let private_key = fs::read_to_string(&private_path).map_err(|e| e.to_string())?;
    let (raw_type, fingerprint) = sqlite::parse_public_key(&public_key);

    // 内容已读入内存，删除临时文件——密钥材料改存数据库，不再落盘
    let _ = fs::remove_file(&private_path);
    let _ = fs::remove_file(&public_path);

    let key = KeyRecord {
        id: id.clone(),
        name: request.name,
        key_type: normalize_key_type(&raw_type),
        fingerprint,
        created_at: sqlite::now_iso(),
        // 用 ssh-keygen -l 解析实际生成位数，而非用户输入值：
        // ED25519 固定 256、ECDSA 用户未填时用默认 256，直接用 request.size 会显示 0。
        size: derive_key_size_from_content(&public_key),
        key_path: None,
        public_key_path: None,
        source: Some("generated".to_string()),
    };

    let key = save_key_record(&conn, key)?;
    save_key_content(&conn, &key.id, Some(&private_key), Some(&public_key))?;
    Ok(key)
}


#[tauri::command]
pub fn import_key_file(request: ImportKeyRequest) -> Result<KeyRecord, String> {
    let conn = sqlite::open_connection()?;
    let id = sqlite::new_id("key");

    let mut private_key_content: Option<String> = None;
    let mut public_key_content: Option<String> = None;

    if let Some(private_base64) = request.private_key_base64 {
        let bytes = STANDARD.decode(private_base64).map_err(|e| e.to_string())?;
        private_key_content = Some(String::from_utf8_lossy(&bytes).trim().to_string());
    }

    if let Some(public_base64) = request.public_key_base64 {
        let bytes = STANDARD.decode(public_base64).map_err(|e| e.to_string())?;
        public_key_content = Some(String::from_utf8_lossy(&bytes).trim().to_string());
    }

    // 仅提供私钥时，尝试从私钥派生公钥
    if public_key_content.is_none() {
        if let Some(private) = &private_key_content {
            if let Ok(derived) = derive_public_key_from_content(private) {
                public_key_content = Some(derived);
            }
        }
    }

    let public_key = public_key_content.ok_or_else(|| {
        "Import requires a public key file or a private key that ssh-keygen can derive a public key from".to_string()
    })?;
    let (key_type, fingerprint) = sqlite::parse_public_key(&public_key);
    let size = derive_key_size_from_content(&public_key);

    let key = KeyRecord {
        id: id.clone(),
        name: request.name,
        key_type: normalize_key_type(&key_type),
        fingerprint,
        created_at: sqlite::now_iso(),
        size,
        key_path: None,
        public_key_path: None,
        source: Some("imported".to_string()),
    };

    let key = save_key_record(&conn, key)?;
    save_key_content(&conn, &key.id, private_key_content.as_deref(), Some(&public_key))?;
    Ok(key)
}


/// 从用户粘贴的文本导入密钥：内容直接入库，不再落盘。
/// 与 `import_key_file` 的区别是入参为明文文本而非 base64 文件内容。
#[tauri::command]
pub fn import_key_text(request: ImportKeyTextRequest) -> Result<KeyRecord, String> {
    let conn = sqlite::open_connection()?;
    let id = sqlite::new_id("key");

    let private_key_content = request
        .private_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut public_key_content = request
        .public_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if public_key_content.is_none() {
        if let Some(private) = &private_key_content {
            if let Ok(derived) = derive_public_key_from_content(private) {
                public_key_content = Some(derived);
            }
        }
    }

    let public_key = public_key_content.ok_or_else(|| {
        "粘贴内容无效：需要公钥文本，或能从私钥派生出公钥的私钥文本".to_string()
    })?;
    let (key_type, fingerprint) = sqlite::parse_public_key(&public_key);
    let size = derive_key_size_from_content(&public_key);

    let key = KeyRecord {
        id: id.clone(),
        name: request.name,
        key_type: normalize_key_type(&key_type),
        fingerprint,
        created_at: sqlite::now_iso(),
        size,
        key_path: None,
        public_key_path: None,
        source: Some("imported".to_string()),
    };

    let key = save_key_record(&conn, key)?;
    save_key_content(&conn, &key.id, private_key_content.as_deref(), Some(&public_key))?;
    Ok(key)
}


#[tauri::command]
pub fn export_key_file(id: String) -> Result<ExportedKeyFile, String> {
    let conn = sqlite::open_connection()?;
    let key = load_key_record(&conn, &id)?;
    let (private_key, public_key) = load_key_content(&conn, &id)?;

    if let Some(private) = private_key {
        return Ok(ExportedKeyFile {
            file_name: format!("{}.key", key.name),
            content_base64: STANDARD.encode(private.as_bytes()),
        });
    }
    if let Some(public) = public_key {
        return Ok(ExportedKeyFile {
            file_name: format!("{}.pub", key.name),
            content_base64: STANDARD.encode(public.as_bytes()),
        });
    }
    Err("No key content found for export".to_string())
}


/// 将密钥源文件复制到用户通过保存对话框选择的目标路径（Tauri 2 下
/// `<a download>` 失效，改由后端直接落盘）。
#[tauri::command]
pub fn export_key_file_to(id: String, target_path: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let key = load_key_record(&conn, &id)?;
    let (private_key, public_key) = load_key_content(&conn, &id)?;
    let content = private_key
        .or(public_key)
        .ok_or_else(|| "No key content found for export".to_string())?;
    fs::write(&target_path, content).map_err(|e| e.to_string())?;
    append_log_i18n(
        &conn,
        "info",
        "logMessages.keyExported",
        Some(serde_json::json!({ "name": key.name })),
        Some("keys"),
    )?;
    Ok(())
}


/// 读取密钥内容（公钥/私钥），供前端「密钥详情」抽屉展示与 SSH 内存认证使用。
#[tauri::command]
pub fn read_key_content(id: String) -> Result<KeyContent, String> {
    let conn = sqlite::open_connection()?;
    let (private_key, public_key) = load_key_content(&conn, &id)?;
    Ok(KeyContent {
        public_key,
        private_key,
    })
}

