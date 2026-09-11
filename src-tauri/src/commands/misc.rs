//! Tauri 命令：misc 域（自 lib.rs 拆分，行为不变）。

use tauri::{Manager, State};


use crate::config::global_config::GlobaConfig;
use crate::config::{global_config, global_enum};
use crate::utils::path;


#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub async fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splash_window) = app.get_webview_window("splashscreen") {
        splash_window.close().map_err(|e| e.to_string())?;
    }
    
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.show().map_err(|e| e.to_string())?;
        main_window.set_focus().map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

#[tauri::command]
pub fn apply_window_effect(app: tauri::AppHandle, effect: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        match effect.as_str() {
            // 新式 DWM backdrop（Win11 22H2+）：失焦保持；旧系统失败时回退 tauri 旧 API
            "acrylic" => apply_system_backdrop(&window, 3)
                .or_else(|_| set_tauri_effect(&window, "acrylic")), // DWMSBT_TRANSIENTWINDOW
            "mica" => apply_system_backdrop(&window, 2)
                .or_else(|_| set_tauri_effect(&window, "mica")), // DWMSBT_MAINWINDOW
            "blur" => apply_system_backdrop(&window, 0)
                .or_else(|_| set_tauri_effect(&window, "blur")), // blur 无新式 backdrop
            _ => {
                // none：清掉新式 backdrop（DWMSBT_NONE）+ 旧 API 效果
                let _ = apply_system_backdrop(&window, 0);
                let _ = window.set_effects(None);
                Ok(())
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, effect);
        Ok(())
    }
}

/// 应用 Windows 11 22H2+ 的**新式** DWM backdrop（`DWMWA_SYSTEMBACKDROP_TYPE`）：
/// - 3 = DWMSBT_TRANSIENTWINDOW：新式 Acrylic（失焦保持、无老 API 拖拽卡顿）
/// - 2 = DWMSBT_MAINWINDOW：Mica
/// - 0 = DWMSBT_NONE：清除
/// 返回 Ok 表示新式 API 生效；Err（系统 < 22H2 / 调用失败）由调用方回退旧 API。
#[cfg(target_os = "windows")]
fn apply_system_backdrop(window: &tauri::WebviewWindow, backdrop_type: i32) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};

    // tauri 的 HWND 是 windows::Win32::Foundation::HWND（newtype 包装 *mut c_void），取 .0 传给 windows-sys
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("获取窗口句柄失败: {e}"))?
        .0;
    // DWMWINDOWATTRIBUTE 是 i32 类型，函数参数要求 u32，需显式转换
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &backdrop_type as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };
    if hr >= 0 {
        Ok(())
    } else {
        Err(format!("DwmSetWindowAttribute 失败: HRESULT {hr:#x}"))
    }
}

/// 回退：用 tauri 内置 set_effects（内部走 window-vibrancy 旧 API）。
#[cfg(target_os = "windows")]
fn set_tauri_effect(window: &tauri::WebviewWindow, effect: &str) -> Result<(), String> {
    use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
    let effect = match effect {
        "acrylic" => Effect::Acrylic,
        "mica" => Effect::Mica,
        _ => Effect::Blur,
    };
    window
        .set_effects(Some(
            EffectsBuilder::new()
                .effect(effect)
                .state(EffectState::Active)
                .radius(0.)
                .color(Color(0, 0, 0, 125))
                .build(),
        ))
        .map_err(|e| format!("应用窗口效果失败: {e}"))
}

#[tauri::command]
pub fn get_config(state: State<GlobaConfig>) -> crate::models::config::Config {
   state.config.read().unwrap().clone()
}

#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    crate::utils::file::read_image_as_data_url(&path).map_err(|e| e.to_string())
}

/// 查询本地文件大小（字节），用于下载断点续传判断。文件不存在返回 0。
#[tauri::command]
pub fn local_file_size(path: String) -> Result<u64, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(meta.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}

/// 读取文本文件内容（主机导入用：读用户选择的 JSON / ssh_config 文件）。
#[tauri::command]
pub fn read_text_file_for_import(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 10 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("文件过大（上限 10MB）".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 导出全部应用配置为 JSON（含 config.toml 全段 + DB 全表，不含密钥链凭据明文）。
#[tauri::command]
pub fn export_app_config(state: State<GlobaConfig>) -> Result<String, String> {
    let config = state.config.read().map_err(|e| e.to_string())?.clone();
    let conn = crate::utils::sqlite::open_connection()?;
    let hosts = crate::services::hosts::list_hosts()?;
    let accounts = crate::services::accounts::list_accounts()?;
    let keys = crate::services::keys::list_keys()?;
    let certs = crate::services::certificates::list_certificates()?;
    let sftp = crate::services::sftp_connections::list_sftp_connections()?;
    let snippets = crate::services::snippets::list_snippets()?;
    let known_hosts: Vec<crate::models::data::KnownHostEntry> = conn
        .prepare("SELECT id, host, key_type, fingerprint, last_used, added_date, raw_line FROM known_hosts")
        .and_then(|mut s| {
            s.query_map([], |row| {
                Ok(crate::models::data::KnownHostEntry {
                    id: row.get(0)?,
                    host: row.get(1)?,
                    key_type: row.get(2)?,
                    fingerprint: row.get(3)?,
                    last_used: row.get(4)?,
                    added_date: row.get(5)?,
                    raw_line: row.get(6)?,
                })
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        })
        .map_err(|e| e.to_string())?;
    let packet = serde_json::json!({
        "app": "swallow",
        "version": 1,
        "exportedAt": crate::utils::sqlite::now_iso(),
        "config": config,
        "hosts": hosts,
        "accounts": accounts,
        "keys": keys,
        "certificates": certs,
        "sftpConnections": sftp,
        "snippets": snippets,
        "knownHosts": known_hosts,
    });
    serde_json::to_string_pretty(&packet).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_app_config_to(state: State<GlobaConfig>, target_path: String) -> Result<(), String> {
    let content = export_app_config(state)?;
    std::fs::write(&target_path, content).map_err(|e| e.to_string())
}

/// 从备份 JSON 恢复：覆盖 config.toml + 全表 upsert（密钥链凭据按包内明文回写）。
#[tauri::command]
pub fn import_app_config(state: State<GlobaConfig>, text: String) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "无法识别：不是 Swallow 配置备份文件".to_string())?;
    if v.get("app").and_then(|a| a.as_str()) != Some("swallow") {
        return Err("无法识别：不是 Swallow 配置备份文件".to_string());
    }
    let mut counts = serde_json::Map::new();
    if let Ok(config) = serde_json::from_value::<crate::models::config::Config>(v.get("config").cloned().unwrap_or_default()) {
        {
            let mut guard = state.config.write().map_err(|e| e.to_string())?;
            *guard = config.clone();
        }
        let config_path = path::app_config_dir().join(global_config::CONFIG_FILE);
        crate::utils::file::write_file_generic(&config_path, &config, global_enum::FileFormat::Toml)
            .map_err(|e| e.to_string())?;
        crate::services::logs::set_max_logs(config.advanced.max_logs);
        counts.insert("settings".into(), serde_json::json!(1));
    }
    let conn = crate::utils::sqlite::open_connection()?;
    let tables: &[(&str, &str)] = &[
        ("hosts", "hosts"),
        ("accounts", "accounts"),
        ("keys", "keys"),
        ("certificates", "certificates"),
        ("sftpConnections", "sftpConnections"),
        ("snippets", "snippets"),
        ("knownHosts", "knownHosts"),
    ];
    for (json_key, label) in tables {
        let arr = v.get(*json_key).and_then(|a| a.as_array()).cloned().unwrap_or_default();
        if arr.is_empty() {
            continue;
        }
        let n = restore_config_table(&conn, json_key, &arr)?;
        counts.insert((*label).into(), serde_json::json!(n));
    }
    Ok(serde_json::Value::Object(counts))
}

/// 备份恢复的分表写入：复用各服务的 save_*（走密钥链 + 日志），id 清空后当新记录插入。
fn restore_config_table(conn: &rusqlite::Connection, key: &str, arr: &[serde_json::Value]) -> Result<usize, String> {
    use crate::services::common::store_secret_or_clear;
    let mut n = 0;
    for item in arr {
        match key {
            "hosts" => {
                let mut h: crate::models::data::Host = serde_json::from_value(item.clone()).map_err(|e| e.to_string())?;
                let password = std::mem::take(&mut h.password);
                let proxy_password = std::mem::take(&mut h.proxy_password);
                h.id = String::new();
                let saved = crate::services::hosts::save_host(h)?;
                store_secret_or_clear(&format!("hosts/{}/password", saved.id), password.as_deref())?;
                store_secret_or_clear(&format!("hosts/{}/proxy_password", saved.id), proxy_password.as_deref())?;
                n += 1;
            }
            "accounts" => {
                let mut a: crate::models::data::Account = serde_json::from_value(item.clone()).map_err(|e| e.to_string())?;
                let password = std::mem::take(&mut a.password);
                a.id = String::new();
                let saved = crate::services::accounts::save_account(a)?;
                store_secret_or_clear(&format!("accounts/{}/password", saved.id), password.as_deref())?;
                n += 1;
            }
            "keys" => {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("restored").to_string();
                let private = item.get("privateKey").or(item.get("private_key")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let public = item.get("publicKey").or(item.get("public_key")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                if private.is_empty() && public.is_empty() {
                    continue;
                }
                crate::services::keys::import_key_text(crate::models::data::ImportKeyTextRequest {
                    name,
                    private_key: if private.is_empty() { None } else { Some(private) },
                    public_key: if public.is_empty() { None } else { Some(public) },
                })?;
                n += 1;
            }
            "certificates" => {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("restored").to_string();
                let cert = item.get("certContent").or(item.get("cert_content")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                if cert.is_empty() {
                    continue;
                }
                let private = item.get("privateKeyContent").or(item.get("private_key_content")).and_then(|x| x.as_str()).map(|s| s.to_string());
                let to_b64 = |s: &str| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, s.as_bytes());
                crate::services::certificates::import_certificate(crate::models::data::ImportCertRequest {
                    name,
                    cert_base64: to_b64(&cert),
                    cert_file_name: None,
                    private_key_base64: private.as_deref().map(to_b64),
                    private_key_file_name: None,
                })?;
                n += 1;
            }
            "sftpConnections" => {
                let mut c: crate::models::data::SftpConnection = serde_json::from_value(item.clone()).map_err(|e| e.to_string())?;
                let password = std::mem::take(&mut c.password);
                let passphrase = std::mem::take(&mut c.passphrase);
                c.id = String::new();
                let saved = crate::services::sftp_connections::save_sftp_connection(c)?;
                store_secret_or_clear(&format!("sftp/{}/password", saved.id), password.as_deref())?;
                store_secret_or_clear(&format!("sftp/{}/passphrase", saved.id), passphrase.as_deref())?;
                n += 1;
            }
            "snippets" => {
                let mut s: crate::models::data::Snippet = serde_json::from_value(item.clone()).map_err(|e| e.to_string())?;
                s.id = String::new();
                crate::services::snippets::save_snippet(s)?;
                n += 1;
            }
            "knownHosts" => {
                let host = item.get("host").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let key_type = item.get("keyType").or(item.get("key_type")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let fingerprint = item.get("fingerprint").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let raw_line = item.get("rawLine").or(item.get("raw_line")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                if host.is_empty() || key_type.is_empty() {
                    continue;
                }
                conn.execute(
                    "INSERT INTO known_hosts (id, host, key_type, fingerprint, last_used, added_date, key_data, raw_line) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7)",
                    rusqlite::params![crate::utils::sqlite::new_id("kh"), host, key_type, fingerprint, crate::utils::sqlite::now_iso(), crate::utils::sqlite::now_iso(), raw_line],
                )
                .map_err(|e| e.to_string())?;
                n += 1;
            }
            _ => {}
        }
    }
    Ok(n)
}

/// 清缓存：删应用缓存目录 + 会话日志目录（保留 DB 与配置）。
#[tauri::command]
pub fn clear_app_cache() -> Result<String, String> {
    use crate::utils::path::{app_cache_dir, app_data_dir};
    let mut removed = Vec::new();
    for dir in [app_cache_dir().join(""), app_data_dir().join("session-logs")] {
        if dir.exists() {
            let count = std::fs::read_dir(&dir).map(|r| r.count()).unwrap_or(0);
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            let _ = std::fs::create_dir_all(&dir);
            removed.push(format!("{}（{} 项）", dir.display(), count));
        }
    }
    if removed.is_empty() {
        return Ok("缓存已是空的".to_string());
    }
    Ok(format!("已清理：{}", removed.join("、")))
}

/// 重置所有设置：config.toml 恢复默认（DB 数据不动）。
#[tauri::command]
pub fn reset_app_settings(state: State<GlobaConfig>) -> Result<(), String> {
    let default = crate::models::config::Config::default();
    {
        let mut guard = state.config.write().map_err(|e| e.to_string())?;
        *guard = default.clone();
    }
    let config_path = path::app_config_dir().join(global_config::CONFIG_FILE);
    crate::utils::file::write_file_generic(&config_path, &default, global_enum::FileFormat::Toml)
        .map_err(|e| e.to_string())?;
    crate::services::logs::set_max_logs(default.advanced.max_logs);
    Ok(())
}

/// 删除所有数据：清空全部业务表 + 密钥链凭据 + 会话/日志文件（不可恢复）。
#[tauri::command]
pub fn delete_all_data(state: State<GlobaConfig>) -> Result<String, String> {
    let conn = crate::utils::sqlite::open_connection()?;
    for prefix in ["hosts/", "accounts/", "sftp/", "portforwardings/"] {
        delete_secrets_by_prefix(&conn, prefix);
    }
    for table in ["hosts", "accounts", "keys", "certificates", "sftp_connections", "snippets", "logs", "known_hosts", "port_forwardings", "remote_conns"] {
        conn.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM monitor_state", []).map_err(|e| e.to_string())?;
    {
        let mut guard = state.config.write().map_err(|e| e.to_string())?;
        let keep_cloud = guard.cloud.clone();
        *guard = crate::models::config::Config::default();
        guard.cloud = keep_cloud;
    }
    {
        let guard = state.config.read().map_err(|e| e.to_string())?;
        let config_path = path::app_config_dir().join(global_config::CONFIG_FILE);
        crate::utils::file::write_file_generic(&config_path, &*guard, global_enum::FileFormat::Toml)
            .map_err(|e| e.to_string())?;
    }
    for name in ["sessions.json"] {
        let _ = std::fs::remove_file(crate::utils::path::app_data_dir().join(name));
    }
    Ok("全部业务数据已删除（配置已重置，云同步凭据保留）".to_string())
}

/// 批量清理密钥链凭据：按账户名前缀匹配删除（keyring 无枚举 API，按 DB 现有 id 逐个删）。
fn delete_secrets_by_prefix(conn: &rusqlite::Connection, prefix: &str) {
    let table = if prefix.starts_with("hosts/") {
        "hosts"
    } else if prefix.starts_with("accounts/") {
        "accounts"
    } else if prefix.starts_with("portforwardings/") {
        "port_forwardings"
    } else {
        "sftp_connections"
    };
    let ids: Vec<String> = conn
        .prepare(&format!("SELECT id FROM {table}"))
        .and_then(|mut s| s.query_map([], |row| row.get(0)).and_then(|r| r.collect::<Result<Vec<_>, _>>()))
        .unwrap_or_default();
    let suffixes: &[&str] = if prefix.starts_with("hosts/") {
        &["password", "proxy_password"]
    } else if prefix.starts_with("accounts/") {
        &["password"]
    } else if prefix.starts_with("portforwardings/") {
        &["socks_password"]
    } else {
        &["password", "passphrase"]
    };
    for id in &ids {
        for suffix in suffixes {
            let _ = crate::utils::secrets::delete_secret(&format!("{prefix}{id}/{suffix}"));
        }
    }
}

#[tauri::command]
pub fn update_config(state: State<GlobaConfig>, config: crate::models::config::Config) -> Result<(), String> {
    let mut guard = state.config.write().map_err(|_| "lock failed")?;
    *guard = config;

    let config_dir = path::app_config_dir();
    let config_path = config_dir.join(global_config::CONFIG_FILE);

    crate::utils::file::write_file_generic(&config_path, &*guard, global_enum::FileFormat::Toml).map_err(|e| e.to_string())?;
    crate::services::logs::set_max_logs(guard.advanced.max_logs);
    Ok(())
}

