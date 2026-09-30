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
   state.config.read().unwrap_or_else(|e| e.into_inner()).clone()
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

/// 导出配置子集（外观 / 终端 / SSH / 安全 / 高级 / AI / 右键菜单 / 监控告警）。
///
/// ⚠️ `cloud` 段**永不导出**：它含 `server_key`（解密云端全部数据的根密钥）
/// 与服务器地址，落进文件就等于把钥匙写成明文。这与云同步「cloud 段永不进包」
/// 是同一条规则，且两侧共用 `collect_settings`，不会各自漂移。
#[tauri::command]
pub fn export_settings(state: State<GlobaConfig>) -> Result<String, String> {
    let settings = crate::services::cloud_sync::collect_settings(&state)?;
    crate::services::transfer::build("settings", false, vec![settings])
}

#[tauri::command]
pub fn export_settings_to(state: State<GlobaConfig>, target_path: String) -> Result<usize, String> {
    let content = export_settings(state)?;
    crate::services::transfer::write_to(&target_path, &content, 1)
}

/// 从导出文件恢复配置。只覆盖文件里出现的段落，且 `cloud` 段永不覆盖——
/// 导入一份配置文件不会动到你当前的 `server_key`（复用 `restore_settings`，
/// 该安全属性对云同步与导入两条路径同时成立）。
#[tauri::command]
pub fn import_settings_text(state: State<GlobaConfig>, text: String) -> Result<usize, String> {
    let (items, _) =
        crate::services::transfer::parse::<crate::services::cloud_sync::SyncedSettings>(
            "settings", &text,
        )?;
    let settings = items
        .into_iter()
        .next()
        .ok_or_else(|| "文件里没有配置内容".to_string())?;
    crate::services::cloud_sync::restore_settings(&state, &settings)?;
    // 日志条数上限来自 advanced 段，恢复后要同步给日志模块（与云同步路径一致）
    let max_logs = state
        .config
        .read()
        .map(|c| c.advanced.max_logs)
        .map_err(|e| e.to_string())?;
    crate::services::logs::set_max_logs(max_logs);
    Ok(1)
}

// 原 restore_config_table（全量备份的分表写入）随 export_app_config /
// import_app_config 一并移除：各类目现在有自己的导入命令，凭据处理由各自的
// save_* 负责（内部即写入密钥链并清空 DB 明文列），不再需要这层统一转发。

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

