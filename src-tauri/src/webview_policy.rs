//! 关闭 WebView2/Chromium 的原生能力：输入自动填充建议、密码保存提示、
//! 缩放、脚本弹窗、以及生产环境的 DevTools。
//!
//! 为什么走 Settings API 而不是命令行开关：WebView2 的未知命令行参数会被静默忽略，
//! 出问题时毫无线索；而 `ICoreWebView2Settings*` 的 setter 有明确的版本要求与返回值，
//! 一行 `let _ =` 就能在不支持的版本上安全跳过。
//!
//! ## 关掉的项与理由
//! 1. `SetIsGeneralAutofillEnabled(false)` —— 关掉输入框的自动填充建议下拉。
//! 2. `SetIsPasswordAutosaveEnabled(false)` —— 关掉「保存密码？」的原生弹窗。
//!    （本应用的密码存系统钥匙串，浏览器存一份只会泄密。）
//! 3. 缩放：Windows 侧的滚轮缩放由窗口配置 `zoomHotkeysEnabled: false`
//!    控制（Tauri 会据此关掉 WebView2 的 `IsZoomControlEnabled`，并覆盖
//!    macOS/Linux 的缩放注入）；这里只补窗口配置覆盖不到的**触控板捏合**
//!    （Settings5 的 `IsPinchZoomEnabled`）。缩放后终端 fit 算出的行列会失真
//!    且无 UI 可复位，所以两路都要关。
//! 4. `SetAreDefaultScriptDialogsEnabled(false)` —— 关掉 `window.alert` / `confirm`
//!    / `prompt` 的原生弹窗。仓库内这三者已零使用（确认框全部走 shadcn）。
//! 5. `SetAreDevToolsEnabled(dev)` —— 生产禁 DevTools；debug 构建保留（dev 要用 F12）。
//!
//! ## 刻意不动的项
//! - **默认右键菜单**：前端已有带白名单的 `contextmenu` 拦截（`App.tsx`），既关掉了
//!   原生菜单、又保留了文件列表等自定义菜单；原生一刀切会让输入框失去右键复制粘贴。
//! - 状态栏、内置错误页等：无用户可见影响，保持默认。

use tauri::{AppHandle, Manager};

/// 给所有窗口的 WebView2 应用上述策略。非 Windows 平台为空实现。
#[cfg(target_os = "windows")]
pub(crate) fn attach(app: &AppHandle) {
    use tauri::webview::PlatformWebview;

    // debug 断言：`tauri dev` 与本地调试构建为 true，发布构建为 false
    let dev = cfg!(debug_assertions);

    let windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .map(|(_, w)| w)
        .collect();
    for window in windows {
        let _ = window.with_webview(move |platform| {
            apply_policy(&platform, dev);
        });
    }

    fn apply_policy(platform: &PlatformWebview, dev: bool) {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Settings4, ICoreWebView2Settings5,
        };
        use windows_core::Interface;

        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => return,
        };
        let settings = match unsafe { core.Settings() } {
            Ok(settings) => settings,
            Err(_) => return,
        };

        // Settings4（WebView2 98+）：自动填充建议 + 密码保存提示
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = unsafe { s4.SetIsGeneralAutofillEnabled(false) };
            let _ = unsafe { s4.SetIsPasswordAutosaveEnabled(false) };
        }
        // Settings5（WebView2 111+）：触控板捏合缩放
        if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
            let _ = unsafe { s5.SetIsPinchZoomEnabled(false) };
        }
        // 基础 Settings：脚本弹窗 / DevTools
        //（滚轮缩放由窗口配置 zoomHotkeysEnabled 负责，这里不再重复设置）
        let _ = unsafe { settings.SetAreDefaultScriptDialogsEnabled(false) };
        let _ = unsafe { settings.SetAreDevToolsEnabled(dev) };
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn attach(_app: &AppHandle) {}
