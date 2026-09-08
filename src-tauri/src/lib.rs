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
use std::time::Duration;
use crate::config::global_config::GlobaConfig;

/// 应用运行时状态：SSH/SFTP 会话管理器随 App 生命周期创建与销毁。
pub struct AppState {
    ssh: Mutex<SshManager>,
    sftp: Mutex<SftpManager>,
    telnet: Mutex<TelnetManager>,
    local: Mutex<LocalShellManager>,
    tunnels: Mutex<TunnelManager>,
    monitor: Mutex<MonitorManager>,
    serial: Mutex<SerialManager>,
    vnc: Mutex<VncManager>,
    rdp: Mutex<RdpManager>,
    mosh: Mutex<MoshManager>,
    /// 传输取消标志表：cancel_token -> AtomicBool（下载中断用）
    transfer_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            ssh: Mutex::new(SshManager::new()),
            sftp: Mutex::new(SftpManager::new()),
            telnet: Mutex::new(TelnetManager::new()),
            local: Mutex::new(LocalShellManager::new()),
            tunnels: Mutex::new(TunnelManager::new()),
            monitor: Mutex::new(MonitorManager::new()),
            serial: Mutex::new(SerialManager::new()),
            vnc: Mutex::new(VncManager::new()),
            rdp: Mutex::new(RdpManager::new()),
            mosh: Mutex::new(MoshManager::new()),
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
            commands::telnet::telnet_connect,
            commands::telnet::telnet_write,
            commands::telnet::telnet_disconnect,
            commands::telnet::telnet_list_sessions,
            commands::local::local_shell_connect,
            commands::local::local_shell_write,
            commands::local::local_shell_resize,
            commands::local::local_shell_disconnect,
            commands::local::local_shell_list_sessions,
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
            commands::sftp::sftp_download_file,
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
            services::hosts::list_hosts,
            services::hosts::save_host,
            services::hosts::delete_host,
            services::hosts::touch_host_last_connected,
            services::remotes::list_remote_conns,
            services::remotes::save_remote_conn,
            services::remotes::delete_remote_conn,
            services::local_fs::list_local_directory,
            services::accounts::list_accounts,
            services::accounts::save_account,
            services::accounts::delete_account,
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
            services::snippets::list_snippets,
            services::snippets::save_snippet,
            services::snippets::delete_snippet,
            services::snippets::mark_snippet_used,
            services::port_forwardings::list_port_forwardings,
            services::port_forwardings::save_port_forwarding,
            services::port_forwardings::delete_port_forwarding,
            services::port_forwardings::test_port_forward_target,
            services::logs::list_logs,
            services::logs::clear_logs,
            services::known_hosts::list_known_hosts,
            services::known_hosts::refresh_known_hosts,
            services::known_hosts::delete_known_host,
            services::known_hosts::clear_known_hosts,
            services::known_hosts::export_known_hosts,
            services::known_hosts::export_known_hosts_to,
            services::cloud_sync::cloud_sync_now,
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
                
                // 模拟额外的初始化步骤
                thread::sleep(Duration::from_millis(500));
                
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "正在加载资源..."
                    }));
                }
                
                thread::sleep(Duration::from_millis(500));
                
                if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash_window.emit("init-status", serde_json::json!({
                        "message": "准备就绪"
                    }));
                }
                
                thread::sleep(Duration::from_millis(300));
                
                // 关闭 splash screen，显示主窗口
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
                // 尽力断开所有 SSH/SFTP 会话，避免退出后残留连接
                let state = app_handle.state::<AppState>();
                let ssh_guard = state.ssh.lock();
                if let Ok(manager) = ssh_guard {
                    manager.disconnect_all();
                }
                let sftp_guard = state.sftp.lock();
                if let Ok(mut manager) = sftp_guard {
                    manager.disconnect_all();
                }
                let telnet_guard = state.telnet.lock();
                if let Ok(manager) = telnet_guard {
                    manager.disconnect_all();
                }
                let local_guard = state.local.lock();
                if let Ok(manager) = local_guard {
                    manager.disconnect_all();
                }
                let tunnels_guard = state.tunnels.lock();
                if let Ok(manager) = tunnels_guard {
                    manager.stop_all();
                }
                let monitor_guard = state.monitor.lock();
                if let Ok(manager) = monitor_guard {
                    manager.disconnect_all();
                }
                let serial_guard = state.serial.lock();
                if let Ok(manager) = serial_guard {
                    manager.disconnect_all();
                }
                let vnc_guard = state.vnc.lock();
                if let Ok(manager) = vnc_guard {
                    manager.stop_all();
                }
                let rdp_guard = state.rdp.lock();
                if let Ok(manager) = rdp_guard {
                    manager.stop_all();
                }
                let mosh_guard = state.mosh.lock();
                if let Ok(manager) = mosh_guard {
                    manager.disconnect_all();
                }
            }
        });
}
