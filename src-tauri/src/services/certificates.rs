use std::fs;
use std::path::Path;
use std::process::Command;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::data::{CertContent, CertificateRecord, ExportedKeyFile, ImportCertRequest};
use crate::services::logs::append_log_i18n;
use crate::utils::sqlite;

const CERT_COLUMNS: &str =
    "id, name, cert_type, key_type, fingerprint, created_at, cert_path, private_key_path, principals_json, valid_after, valid_before, source, private_key_content";

fn row_to_record(row: &Row) -> rusqlite::Result<CertificateRecord> {
    let principals_json: Option<String> = row.get(8)?;
    let principals = principals_json
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .unwrap_or_default();
    let private_key_content: Option<String> = row.get(12)?;
    let has_private_key = private_key_content
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    Ok(CertificateRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        cert_type: row.get(2)?,
        key_type: row.get(3)?,
        fingerprint: row.get(4)?,
        created_at: row.get(5)?,
        cert_path: row.get(6)?,
        private_key_path: row.get(7)?,
        has_private_key,
        principals,
        valid_after: row.get(9)?,
        valid_before: row.get(10)?,
        source: row.get(11)?,
    })
}

fn load_record(conn: &Connection, id: &str) -> Result<Option<CertificateRecord>, String> {
    conn.query_row(
        &format!("SELECT {CERT_COLUMNS} FROM certificates WHERE id = ?1"),
        params![id],
        row_to_record,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn insert_record(
    conn: &Connection,
    cert: &CertificateRecord,
    cert_content: Option<&str>,
    private_key_content: Option<&str>,
) -> Result<(), String> {
    let principals_json =
        serde_json::to_string(&cert.principals).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO certificates (id, name, cert_type, key_type, fingerprint, created_at, cert_path, private_key_path, principals_json, valid_after, valid_before, source, cert_content, private_key_content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            cert.id,
            cert.name,
            cert.cert_type,
            cert.key_type,
            cert.fingerprint,
            cert.created_at,
            cert.cert_path,
            cert.private_key_path,
            principals_json,
            cert.valid_after,
            cert.valid_before,
            cert.source,
            cert_content,
            private_key_content,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取证书内容（证书 + 配套私钥），供前端「证书详情」抽屉展示使用。
#[tauri::command]
pub fn read_cert_content(id: String) -> Result<CertContent, String> {
    let conn = sqlite::open_connection()?;
    let (cert_content, private_key) = load_cert_content(&conn, &id)?;
    Ok(CertContent {
        cert_content,
        private_key,
    })
}

/// 从数据库读取证书内容（证书 + 配套私钥），供 SSH 证书认证与导出使用。
pub fn load_cert_content(
    conn: &Connection,
    id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    conn.query_row(
        "SELECT cert_content, private_key_content FROM certificates WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "该证书已被删除或不存在，请到“证书”页重新导入。".to_string())
}

#[tauri::command]
pub fn list_certificates() -> Result<Vec<CertificateRecord>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CERT_COLUMNS} FROM certificates ORDER BY name COLLATE NOCASE ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_record)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// ssh-keygen -L 解析出的证书元数据
struct CertMeta {
    cert_type: String,
    key_type: String,
    fingerprint: String,
    valid_after: Option<String>,
    valid_before: Option<String>,
    principals: Vec<String>,
}

fn normalize_key_type(algo: &str) -> String {
    let algo = algo.to_lowercase();
    if algo.contains("ed25519") {
        "ED25519".to_string()
    } else if algo.contains("ecdsa") {
        "ECDSA".to_string()
    } else if algo.contains("rsa") {
        "RSA".to_string()
    } else {
        algo.to_uppercase()
    }
}

/// 用 ssh-keygen -L 解析 OpenSSH 证书，提取类型、指纹、有效期与 principals。
fn inspect_certificate(cert_path: &Path) -> Result<CertMeta, String> {
    let output = Command::new("ssh-keygen")
        .arg("-L")
        .arg("-f")
        .arg(cert_path.to_string_lossy().as_ref())
        .output()
        .map_err(|e| format!("ssh-keygen not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("证书文件无效或无法解析: {stderr}"));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut cert_type = String::new();
    let mut key_type = String::new();
    let mut fingerprint = String::new();
    let mut valid_after: Option<String> = None;
    let mut valid_before: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("Type:") {
            // 例: Type: ssh-ed25519-cert-v01@openssh.com user certificate
            if trimmed.contains("user certificate") {
                cert_type = "user".to_string();
            } else if trimmed.contains("host certificate") {
                cert_type = "host".to_string();
            }
            if let Some(algo) = trimmed.split_whitespace().nth(1) {
                let base = algo.split("-cert").next().unwrap_or(algo);
                key_type = normalize_key_type(base);
            }
        } else if trimmed.starts_with("Public key:") {
            // 例: Public key: ED25519-CERT SHA256:xxxx
            if let Some(fp) = trimmed.split_whitespace().find(|t| t.starts_with("SHA256:")) {
                fingerprint = fp.to_string();
            }
        } else if trimmed.starts_with("Valid:") {
            // 例: Valid: from 2026-01-01T00:00:00 to 2027-01-01T00:00:00 / Valid: forever
            let rest = trimmed.trim_start_matches("Valid:").trim();
            if rest.starts_with("from") {
                let rest = rest.trim_start_matches("from").trim();
                let mut parts = rest.splitn(2, " to ");
                let after = parts.next().unwrap_or("").trim();
                let before = parts.next().unwrap_or("").trim();
                if !after.is_empty() {
                    valid_after = Some(after.to_string());
                }
                if !before.is_empty() {
                    valid_before = Some(before.to_string());
                }
            }
        }
    }

    // principals 单独遍历提取：跟在 "Principals:" 之后的缩进行，直到下一个字段头（含冒号）
    let mut principals: Vec<String> = Vec::new();
    let mut collecting = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Principals:") {
            collecting = true;
            continue;
        }
        if collecting {
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.contains(": ") || trimmed.ends_with(':') {
                break;
            }
            principals.push(trimmed.to_string());
        }
    }

    if cert_type.is_empty() {
        return Err("无法识别证书类型（非 OpenSSH 用户/主机证书）".to_string());
    }
    if fingerprint.is_empty() {
        fingerprint = "SHA256:invalid".to_string();
    }
    if key_type.is_empty() {
        key_type = "UNKNOWN".to_string();
    }

    Ok(CertMeta {
        cert_type,
        key_type,
        fingerprint,
        valid_after,
        valid_before,
        principals,
    })
}

#[tauri::command]
pub fn import_certificate(request: ImportCertRequest) -> Result<CertificateRecord, String> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err("证书名称不能为空".to_string());
    }

    let conn = sqlite::open_connection()?;
    let id = sqlite::new_id("cert");

    // 证书内容（base64 → 明文），直接入库，不再落盘
    let cert_bytes = STANDARD
        .decode(request.cert_base64.trim())
        .map_err(|e| format!("证书文件 Base64 解码失败: {e}"))?;
    if cert_bytes.is_empty() {
        return Err("证书文件内容为空".to_string());
    }
    let cert_content = String::from_utf8_lossy(&cert_bytes).to_string();

    // 配套私钥（可选，SSH 认证时需要）
    let private_key_content = match request.private_key_base64 {
        Some(data) if !data.trim().is_empty() => {
            let bytes = STANDARD
                .decode(data.trim())
                .map_err(|e| format!("私钥 Base64 解码失败: {e}"))?;
            if bytes.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&bytes).to_string())
            }
        }
        _ => None,
    };

    // 解析证书元数据（同时验证证书有效性）：写入临时目录内的文件后 ssh-keygen -L，用完即删。
    // 不能用 NamedTempFile——它在 Windows 上持有独占文件句柄，导致 ssh-keygen 打开时报
    // "fopen ... Permission denied"。改用 tempdir + fs::write（写后即关闭句柄）。
    let meta = {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let cert_file = dir.path().join("cert.pub");
        fs::write(&cert_file, &cert_content).map_err(|e| e.to_string())?;
        inspect_certificate(&cert_file)?
    };

    let cert = CertificateRecord {
        id,
        name,
        cert_type: meta.cert_type,
        key_type: meta.key_type,
        fingerprint: meta.fingerprint,
        created_at: sqlite::now_iso(),
        cert_path: None,
        private_key_path: None,
        has_private_key: private_key_content.is_some(),
        principals: meta.principals,
        valid_after: meta.valid_after,
        valid_before: meta.valid_before,
        source: Some("imported".to_string()),
    };

    insert_record(&conn, &cert, Some(&cert_content), private_key_content.as_deref())?;
    append_log_i18n(
        &conn,
        "info",
        "logMessages.certImported",
        Some(serde_json::json!({ "name": cert.name })),
        Some("certificates"),
    )?;

    Ok(cert)
}

/// 仅删除应用托管目录（certificates_dir）内的文件，避免误删用户外部文件。
fn remove_managed_cert_file(path: &str) {
    let Ok(target) = fs::canonicalize(path) else {
        return;
    };
    let Ok(dir) = fs::canonicalize(sqlite::certificates_dir()) else {
        return;
    };
    if target.starts_with(&dir) && target != dir {
        let _ = fs::remove_file(path);
    } else {
        eprintln!("Skipped deleting certificate file outside managed directory: {path}");
    }
}

#[tauri::command]
pub fn delete_certificate(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let Some(cert) = load_record(&conn, &id)? else {
        // 已不存在，视为删除成功（幂等）
        return Ok(());
    };

    if let Some(path) = &cert.cert_path {
        remove_managed_cert_file(path);
    }
    if let Some(path) = &cert.private_key_path {
        remove_managed_cert_file(path);
    }

    conn.execute("DELETE FROM certificates WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    append_log_i18n(
        &conn,
        "info",
        "logMessages.certDeleted",
        Some(serde_json::json!({ "name": cert.name })),
        Some("certificates"),
    )?;
    Ok(())
}

#[tauri::command]
pub fn export_certificate(id: String) -> Result<ExportedKeyFile, String> {
    let conn = sqlite::open_connection()?;
    let cert = load_record(&conn, &id)?.ok_or_else(|| "Certificate not found".to_string())?;
    let (cert_content, private_key_content) = load_cert_content(&conn, &id)?;

    if let Some(content) = cert_content {
        return Ok(ExportedKeyFile {
            file_name: format!("{}-cert.pub", cert.name),
            content_base64: STANDARD.encode(content.as_bytes()),
        });
    }

    if let Some(content) = private_key_content {
        return Ok(ExportedKeyFile {
            file_name: format!("{}.key", cert.name),
            content_base64: STANDARD.encode(content.as_bytes()),
        });
    }

    Err("No certificate file found for export".to_string())
}


/// 将证书内容（数据库托管）写出到用户通过保存对话框选择的目标路径（Tauri 2 下
/// `<a download>` 失效，改由后端直接落盘）。
#[tauri::command]
pub fn export_certificate_file_to(id: String, target_path: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let cert = load_record(&conn, &id)?.ok_or_else(|| "Certificate not found".to_string())?;
    let (cert_content, private_key_content) = load_cert_content(&conn, &id)?;
    let content = cert_content
        .or(private_key_content)
        .ok_or_else(|| "No certificate file found for export".to_string())?;
    fs::write(&target_path, content).map_err(|e| e.to_string())?;
    append_log_i18n(
        &conn,
        "info",
        "logMessages.certExported",
        Some(serde_json::json!({ "name": cert.name })),
        Some("certificates"),
    )?;
    Ok(())
}
