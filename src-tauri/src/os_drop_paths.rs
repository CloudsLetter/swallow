//! WebView2 原生桥：把拖拽进应用的文件真实路径交给前端。
//!
//! 背景：Chromium/WebView2 的 DOM `File` 对象在 JS 层**不暴露本地绝对路径**，
//! 因此拖拽上传只能走 IPC 慢通道。WebView2 提供 WebMessageObjects 机制：
//! 页面用 `window.chrome.webview.postMessageWithAdditionalObjects(msg, files)`
//! 把 DOM File 传给宿主，宿主在 `WebMessageReceived` 事件的
//! `AdditionalObjects` 里把每个对象 cast 成 `ICoreWebView2File`，
//! 通过 `Path` 属性取得绝对路径 —— 前端再据此走后端直读满速上传。
//!
//! 前端约定：消息字符串格式 `swallow-os-files::<requestId>`；宿主解析出
//! requestId 并把路径数组通过 `sftp-os-drop-paths` 事件回传
//! `{ requestId, paths }`（顺序与传入的 files 一致）。

use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
pub(crate) fn attach(app: &AppHandle) {
    use tauri::webview::PlatformWebview;
    use webview2_com::WebMessageReceivedEventHandler;

    // 对所有 webview window 注册（当前应用单主窗，遍历以兼容未来多窗）
    let windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .map(|(_, w)| w)
        .collect();
    for window in windows {
        let app = app.clone();
        let _ = window.with_webview(move |platform| {
            register_on_platform(&app, &platform);
        });
    }

    fn register_on_platform(app: &AppHandle, platform: &PlatformWebview) {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => return,
        };
        let app = app.clone();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                handle_web_message(&app, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
    }
}

/// 解析一条 WebMessage：格式 `swallow-os-files::<requestId>` + 附加 File 对象列表。
#[cfg(target_os = "windows")]
fn handle_web_message(
    app: &AppHandle,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
) {
    use serde::Serialize;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use windows_core::{Interface, PWSTR};

    const PREFIX: &str = "swallow-os-files::";

    // 1) 消息文本（requestId 载体）
    let mut message = PWSTR::null();
    if unsafe { args.TryGetWebMessageAsString(&mut message) }.is_err() {
        return;
    }
    let Ok(message) = (unsafe { message.to_string() }) else {
        return;
    };
    let Some(request_id) = message.strip_prefix(PREFIX) else {
        return; // 其它消息（tauri 自身 IPC 等）不属我们管
    };
    if request_id.is_empty() {
        return;
    }

    // 2) 取 AdditionalObjects（需新版本参数接口；老 runtime cast 失败即静默降级）
    let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
        return;
    };
    let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else {
        return;
    };

    // 3) 遍历附加对象，逐个尝试 cast 成 CoreWebView2File 拿 Path
    let mut count = 0u32;
    if unsafe { objects.Count(&mut count) }.is_err() {
        return;
    }
    let mut paths: Vec<String> = Vec::with_capacity(count as usize);
    for i in 0..count {
        let Ok(item) = (unsafe { objects.GetValueAtIndex(i) }) else {
            continue;
        };
        let Ok(file) = item.cast::<ICoreWebView2File>() else {
            continue; // 附加对象里有非 File 时跳过
        };
        let mut path = PWSTR::null();
        if unsafe { file.Path(&mut path) }.is_err() || path.is_null() {
            continue;
        }
        if let Ok(p) = unsafe { path.to_string() } {
            if !p.is_empty() {
                paths.push(p);
            }
        }
    }
    if paths.is_empty() {
        return;
    }

    // 4) 回传前端（事件字段自动 camelCase）
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct OsDropPaths<'a> {
        request_id: &'a str,
        paths: Vec<String>,
    }
    let _ = app.emit(
        "sftp-os-drop-paths",
        OsDropPaths {
            request_id,
            paths,
        },
    );
}
