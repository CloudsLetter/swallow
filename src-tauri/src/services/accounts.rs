use rusqlite::{params, OptionalExtension};

use crate::models::data::Account;
use crate::services::common::{parse_tags, resolve_secret, store_secret_or_clear, to_tags_json};
use crate::services::logs::append_log_i18n;
use crate::utils::secrets;
use crate::utils::sqlite;

#[tauri::command]
pub fn list_accounts() -> Result<Vec<Account>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, username, auth_type, password, key_id, certificate_id,
                    description, created_at, last_used, tags_json
             FROM accounts ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let tags_json: Option<String> = row.get(10)?;
            let mut account = Account {
                id: row.get(0)?,
                name: row.get(1)?,
                username: row.get(2)?,
                auth_type: row.get(3)?,
                password: row.get(4)?,
                key_id: row.get(5)?,
                certificate_id: row.get(6)?,
                description: row.get(7)?,
                created_at: row.get(8)?,
                last_used: row.get(9)?,
                tags: parse_tags(tags_json),
            };
            account.password = resolve_secret(account.password.take(), &format!("accounts/{}/password", account.id));
            Ok(account)
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn save_account(mut account: Account) -> Result<Account, String> {
    let conn = sqlite::open_connection()?;
    let is_new = account.id.trim().is_empty();
    if is_new {
        account.id = sqlite::new_id("account");
        if account.created_at.trim().is_empty() {
            account.created_at = sqlite::now_iso();
        }
    }

    // 凭据写入系统密钥链，数据库列清空（不再落盘明文）
    let password = std::mem::take(&mut account.password);
    store_secret_or_clear(&format!("accounts/{}/password", account.id), password.as_deref())?;

    conn.execute(
        "INSERT INTO accounts (
            id, name, username, auth_type, password, key_id, certificate_id,
            description, created_at, last_used, tags_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            username = excluded.username,
            auth_type = excluded.auth_type,
            password = excluded.password,
            key_id = excluded.key_id,
            certificate_id = excluded.certificate_id,
            description = excluded.description,
            created_at = excluded.created_at,
            last_used = excluded.last_used,
            tags_json = excluded.tags_json",
        params![
            account.id,
            account.name,
            account.username,
            account.auth_type,
            account.password,
            account.key_id,
            account.certificate_id,
            account.description,
            account.created_at,
            account.last_used,
            to_tags_json(&account.tags)
        ],
    )
    .map_err(|e| e.to_string())?;

    append_log_i18n(
        &conn,
        "info",
        if is_new { "logMessages.accountCreated" } else { "logMessages.accountUpdated" },
        Some(serde_json::json!({ "name": account.name })),
        Some("accounts"),
    )?;

    Ok(account)
}


#[tauri::command]
pub fn delete_account(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let name: Option<String> = conn
        .query_row("SELECT name FROM accounts WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM accounts WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;
    let _ = secrets::delete_secret(&format!("accounts/{}/password", id));
    append_log_i18n(
        &conn,
        "info",
        "logMessages.accountDeleted",
        Some(serde_json::json!({ "name": name.unwrap_or_else(|| "unknown".to_string()) })),
        Some("accounts"),
    )?;
    Ok(())
}
