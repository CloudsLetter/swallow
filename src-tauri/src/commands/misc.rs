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

