use std::fs;

use crate::utils::path::app_data_dir;

/// 保存打开的标签会话（终端/SFTP）的文件名。
const SESSIONS_FILE: &str = "sessions.json";

/// 保存打开的标签会话。`data` 为前端序列化的 JSON 字符串（标签数组）。
/// 后端仅做透传落盘，不解析结构（避免前后端字段契约耦合）。
/// 密码/passphrase 由前端在序列化前剔除，不落明文。
#[tauri::command]
pub fn save_open_sessions(data: String) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SESSIONS_FILE);
    fs::write(path, data).map_err(|e| e.to_string())
}

/// 读取上次保存的标签会话（JSON 字符串）。文件不存在时返回空数组。
#[tauri::command]
pub fn load_open_sessions() -> Result<String, String> {
    let path = app_data_dir().join(SESSIONS_FILE);
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}
