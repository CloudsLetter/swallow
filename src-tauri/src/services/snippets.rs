use rusqlite::{params, OptionalExtension};

use crate::models::data::Snippet;
use crate::services::common::{parse_tags, to_tags_json};
use crate::services::logs::append_log;
use crate::utils::sqlite;

#[tauri::command]
pub fn list_snippets() -> Result<Vec<Snippet>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, description, category, tags_json, created_at, last_used
             FROM snippets ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let tags_json: Option<String> = row.get(5)?;
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                description: row.get(3)?,
                category: row.get(4)?,
                tags: parse_tags(tags_json),
                created_at: row.get(6)?,
                last_used: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn save_snippet(mut snippet: Snippet) -> Result<Snippet, String> {
    let conn = sqlite::open_connection()?;
    let is_new = snippet.id.trim().is_empty();
    if is_new {
        snippet.id = sqlite::new_id("snippet");
        if snippet.created_at.trim().is_empty() {
            snippet.created_at = sqlite::now_iso();
        }
    }
    conn.execute(
        "INSERT INTO snippets (id, name, command, description, category, tags_json, created_at, last_used)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            command = excluded.command,
            description = excluded.description,
            category = excluded.category,
            tags_json = excluded.tags_json,
            created_at = excluded.created_at,
            last_used = excluded.last_used",
        params![
            snippet.id,
            snippet.name,
            snippet.command,
            snippet.description,
            snippet.category,
            to_tags_json(&snippet.tags),
            snippet.created_at,
            snippet.last_used
        ],
    )
    .map_err(|e| e.to_string())?;
    append_log(
        &conn,
        "info",
        &format!("{} snippet {}", if is_new { "Created" } else { "Updated" }, snippet.name),
        Some("snippets"),
    )?;
    Ok(snippet)
}


#[tauri::command]
pub fn delete_snippet(id: String) -> Result<(), String> {
    let conn = sqlite::open_connection()?;
    let name: Option<String> = conn
        .query_row("SELECT name FROM snippets WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    append_log(
        &conn,
        "info",
        &format!("Deleted snippet {}", name.unwrap_or_else(|| "unknown".to_string())),
        Some("snippets"),
    )?;
    Ok(())
}


#[tauri::command]
pub fn mark_snippet_used(id: String) -> Result<Snippet, String> {
    let conn = sqlite::open_connection()?;
    let now = sqlite::now_iso();
    conn.execute("UPDATE snippets SET last_used = ?1 WHERE id = ?2", params![now, id])
        .map_err(|e| e.to_string())?;
    list_snippets()?
        .into_iter()
        .find(|snippet| snippet.id == id)
        .ok_or_else(|| "Snippet not found".to_string())
}
