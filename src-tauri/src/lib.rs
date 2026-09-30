mod ssh;
mod models;
mod config;
mod sftp;
mod services;
mod session_events;
mod telnet;
mod local;
mod utils;
mod monitor;
mod serial;
mod vnc;
mod rdp;
mod mosh;
#[cfg(target_os = "windows")]
mod os_drop_paths;

use ssh::{SshManager, TunnelManager};
use ssh::russh_shell::ShellSession;
use sftp::SftpManager;
use telnet::TelnetManager;
use local::LocalShellManager;
use monitor::MonitorManager;
use serial::SerialManager;
use vnc::VncManager;
use rdp::RdpManager;
use mosh::MoshManager;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Manager};
use std::thread;
use crate::config::global_config::GlobaConfig;

/// 应用运行时状态：各 Manager 自带锁（RwLock/DashMap/Arc 包装），
/// AppState 只持有实例、不再外包 Mutex——消除双重锁，tunnel/monitor/sftp 互不阻塞。
/// 例外：russh_shells / transfer_cancels 是裸 HashMap，仍需 Mutex（tokio 回调内只做
/// 短锁 get/clone/remove，不跨 await，见 commands/ssh.rs 注释）。
pub struct AppState {
    ssh: SshManager,
    sftp: SftpManager,
    telnet: TelnetManager,
    local: LocalShellManager,
    tunnels: TunnelManager,
    monitor: MonitorManager,
    serial: SerialManager,
    vnc: VncManager,
    rdp: RdpManager,
    mosh: MoshManager,
    /// russh 交互终端会话表（新主后端；ssh2 作 DSA/老设备回退留在 `ssh` manager）
    russh_shells: Mutex<HashMap<String, std::sync::Arc<ShellSession>>>,
    /// 传输取消标志表：cancel_token -> AtomicBool（下载中断用）
    transfer_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            ssh: SshManager::new(),
            sftp: SftpManager::new(),
            telnet: TelnetManager::new(),
            local: LocalShellManager::new(),
            tunnels: TunnelManager::new(),
            monitor: MonitorManager::new(),
            serial: SerialManager::new(),
            vnc: VncManager::new(),
            rdp: RdpManager::new(),
            mosh: MoshManager::new(),
            russh_shells: Mutex::new(HashMap::new()),
            transfer_cancels: Mutex::new(HashMap::new()),
        }
    }
}

pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    let config = utils::file::init_config().expect("init config failed");
    services::logs::set_max_logs(config.advanced.max_logs);
    tauri::Builder::default()
        .manage(GlobaConfig {
            config: Arc::new(RwLock::new(config))
        })
        .manage(AppState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 更新器：CrabNebula Cloud 分发 + minisign 校验
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 进程：更新下载完成后 relaunch 重启
        .plugin(tauri_plugin_process::init())
        // 单实例：再次启动时聚焦/还原已存在的主窗口，而不是新开一个
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_chat,
            commands::misc::greet,
            commands::misc::close_splashscreen,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_list_sessions,
            commands::ssh::ssh_set_output_paused,
            commands::telnet::telnet_connect,
            commands::telnet::telnet_write,
            commands::telnet::telnet_disconnect,
            commands::telnet::telnet_list_sessions,
            commands::local::local_shell_connect,
            commands::local::local_shell_write,
            commands::local::local_shell_resize,
            commands::local::local_shell_disconnect,
            commands::local::local_shell_list_sessions,
            commands::local::local_shell_list_profiles,
            commands::ssh::accept_host_key,
            commands::monitor::monitor_start,
            commands::monitor::monitor_collect,
            commands::monitor::monitor_stop,
            commands::monitor::monitor_list_sessions,
            commands::vnc::vnc_connect,
            commands::vnc::vnc_disconnect,
            commands::vnc::vnc_list_sessions,
            commands::rdp::rdp_connect,
            commands::rdp::rdp_disconnect,
            commands::rdp::rdp_list_sessions,
            commands::mosh::mosh_connect,
            commands::mosh::mosh_write,
            commands::mosh::mosh_resize,
            commands::mosh::mosh_disconnect,
            commands::mosh::mosh_list_sessions,
            commands::serial::serial_list_ports,
            commands::serial::serial_connect,
            commands::serial::serial_write,
            commands::serial::serial_disconnect,
            commands::serial::serial_list_sessions,
            commands::misc::apply_window_effect,
            commands::tunnel::start_port_forward,
            commands::tunnel::stop_port_forward,
            commands::tunnel::list_active_port_forwards,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_download_file_to,
            commands::sftp::sftp_download_file_to,
            commands::sftp::sftp_upload_file,
            commands::sftp::sftp_delete_file,
            commands::sftp::sftp_delete_dir,
            commands::sftp::sftp_remove_dir_recursive,
            commands::sftp::sftp_create_dir,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_search_files,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_stream_copy,
            commands::sftp::sftp_upload_chunk,
            commands::sftp::sftp_upload_local,
            commands::sftp::sftp_download_file_progress,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_disconnect,
            commands::sftp::sftp_list_sessions,
            commands::misc::get_config,
            commands::misc::update_config,
            commands::misc::read_image_as_data_url,
            commands::misc::local_file_size,
            commands::misc::read_text_file_for_import,
            commands::misc::export_settings,
            commands::misc::export_settings_to,
            commands::misc::import_settings_text,
            commands::misc::clear_app_cache,
            commands::misc::reset_app_settings,
            commands::misc::delete_all_data,
            services::hosts::list_hosts,
            services::hosts::save_host,
            services::hosts::delete_host,
            services::hosts::touch_host_last_connected,
            services::hosts::export_hosts,
            services::hosts::export_hosts_to,
            services::hosts::import_hosts_text,
            services::hosts::toggle_host_favorite,
            services::remotes::list_remote_conns,
            services::remotes::save_remote_conn,
            services::remotes::delete_remote_conn,
            services::remotes::export_remote_conns,
            services::remotes::export_remote_conns_to,
            services::remotes::import_remote_conns_text,
            services::local_fs::list_local_directory,
            services::accounts::list_accounts,
            services::accounts::save_account,
            services::accounts::delete_account,
            services::accounts::export_accounts,
            services::accounts::export_accounts_to,
            services::accounts::import_accounts_text,
            services::keys::list_keys,
            services::keys::save_key,
            services::keys::delete_key,
            services::keys::create_key_pair,
            services::keys::import_key_file,
            services::keys::import_key_text,
            services::keys::export_key_file,
            services::keys::export_key_file_to,
            services::keys::read_key_content,
            services::certificates::list_certificates,
            services::certificates::import_certificate,
            services::certificates::delete_certificate,
            services::certificates::export_certificate,
            services::certificates::export_certificate_file_to,
            services::certificates::read_cert_content,
            services::sftp_connections::list_sftp_connections,
            services::sftp_connections::save_sftp_connection,
            services::sftp_connections::delete_sftp_connection,
            services::sftp_connections::test_sftp_connection,
            services::sftp_connections::export_sftp_connections,
            services::sftp_connections::export_sftp_connections_to,
            services::sftp_connections::import_sftp_connections_text,
            services::snippets::list_snippets,
            services::snippets::save_snippet,
            services::snippets::delete_snippet,
            services::snippets::mark_snippet_used,
            services::snippets::export_snippets,
            services::snippets::export_snippets_to,
            services::snippets::import_snippets_text,
            services::port_forwardings::list_port_forwardings,
            services::port_forwardings::save_port_forwarding,
            services::port_forwardings::delete_port_forwarding,
            services::port_forwardings::test_port_forward_target,
            services::port_forwardings::export_port_forwardings,
            services::port_forwardings::export_port_forwardings_to,
            services::port_forwardings::import_port_forwardings_text,
            services::logs::list_logs,
            services::logs::clear_logs,
            services::known_hosts::list_known_hosts,
            services::known_hosts::refresh_known_hosts,
            services::known_hosts::delete_known_host,
            services::known_hosts::clear_known_hosts,
            services::known_hosts::export_known_hosts,
            services::known_hosts::export_known_hosts_to,
            services::known_hosts::import_known_hosts_text,
            services::cloud_sync::cloud_sync_now,
            services::cloud_sync::cloud_sync_state,
            services::cloud_sync::cloud_test_connection,
            services::sessions::save_open_sessions,
            services::sessions::load_open_sessions,
            services::session_log::session_log_start,
            services::session_log::session_log_append,
            services::session_log::session_log_close,
            services::session_log::session_log_read,
            services::session_log::session_log_list,
            services::monitor_state::monitor_get_state,
            services::monitor_state::monitor_save_state,
        ])
        .setup(|_app| {
            // rustls 0.23 CryptoProvider：依赖图同时启用 ring（reqwest 链）与 aws-lc-rs
            //（ironrdp-tls 链），rustls 无法自动二选一，任何使用方首次建 TLS 时会 panic。
            // 进程级显式安装一次（RDP / 云同步 / 更新器等所有 rustls 使用方共用）；
            // 已安装过则 Err，忽略即可。
            let _ = rustls::crypto::ring::default_provider().install_default();

            // 系统托盘：advanced.minimize_to_tray 开启时关窗进托盘，托盘是唯一唤回/退出
            // 入口（隐藏窗口无任务栏表项）。左键单击 = 唤回主窗口；菜单 = 显示 / 退出，
            // 菜单文案按配置语言选择。关闭拦截本身在前端 onCloseRequested 做（hide）。
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let zh = _app
                    .state::<GlobaConfig>()
                    .config
                    .read()
                    .map(|guard| guard.appearance.language.starts_with("zh"))
                    .unwrap_or(true);
                let (show_text, quit_text) = if zh {
                    ("显示主窗口", "退出")
                } else {
                    ("Show Window", "Quit")
                };
                let show = MenuItem::with_id(_app, "tray-show", show_text, true, None::<&str>)?;
                let quit = MenuItem::with_id(_app, "tray-quit", quit_text, true, None::<&str>)?;
                let menu = Menu::with_items(_app, &[&show, &quit])?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(_app.default_window_icon().expect("missing window icon").clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray-show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "tray-quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(_app)?;
            }

            // WebView2 默认是不透明白色背景，会盖住 transparent 窗口的毛玻璃/壁纸，
            // 启动时必须显式设为全透明（否则透明窗口表现为白底）
            #[cfg(target_os = "windows")]
            {
                use tauri::webview::Color;
                if let Some(webview) = _app.get_webview_window("main") {
                    let _ = webview.set_background_color(Some(Color(0, 0, 0, 0)));
                }
                // 正式桥：WebView2 WebMessageReceived → AdditionalObjects → CoreWebView2File.Path
                // （拖拽上传的 DOM File 无 JS 路径，此桥在原生层取真实路径 emit 回前端直读满速）
                os_drop_paths::attach(_app.handle());
            }
            let app_handle = _app.handle().clone();
            
            // 在后台线程执行初始化
            thread::spawn(move || {
                // 发送初始化状态到 splash screen
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "正在初始化配置..."
                    }));
                }
                
                // 执行初始化
                if let Err(e) = utils::init::init() {
                    eprintln!("初始化失败: {}", e);
                }

                // 关闭 splash screen，显示主窗口
                //（初始化本身是毫秒级：建目录 + 配置已加载；不人为 sleep 拖慢启动）
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.close();
                }
                
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            });
            
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 退出清理放后台线程做：disconnect_all 含网络 I/O（channel.close/
                // wait_close），在事件回调里同步执行会拖住退出流程，表现为点 X 后卡死。
                // 后台线程里尽力断开，进程退出会兜底回收。
                let handle = app_handle.clone();
                std::thread::spawn(move || {
                    cleanup_all_sessions(&handle);
                });
            }
        });
}

/// 退出时的会话清理（后台线程调用）：各 manager 先 drain 出锁再逐个断开，
/// 任何一个慢连接都不会卡住其他 manager 的清理。
fn cleanup_all_sessions(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    state.ssh.disconnect_all();
    let russh_guard = state.russh_shells.lock();
    if let Ok(map) = russh_guard {
        for shell in map.values() {
            shell.stop();
        }
    }
    state.sftp.disconnect_all();
    state.telnet.disconnect_all();
    state.local.disconnect_all();
    state.tunnels.stop_all();
    state.monitor.disconnect_all();
    state.serial.disconnect_all();
    state.vnc.stop_all();
    state.rdp.stop_all();
    state.mosh.disconnect_all();
}
