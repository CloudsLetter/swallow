//! SSH 认证链路（§17-1）：主机/账号/跳板机解析 + 密钥/证书材料装载的唯一实现。
//!
//! services 层只供原始行数据（`load_host` / `load_account` 仍在
//! `services::port_forwardings`，pub(crate) 可见），所有「拼 SshConfig」的逻辑收拢到此：
//! - `resolve_host_ssh_config`：按 host_id 解析完整配置（含账号优先、跳板递归、材料填充）
//! - `prepare_ssh_auth_material`：前端直传的 SshConfig 做 key/cert 内容填充（终端/MOSH/VNC 隧道）
//! - `fill_sftp_key_material`：SFTP 公钥认证的材料填充
//! 各命令层只调这三个入口，不再各自手写 DB 查询与材料装载。

use rusqlite::Connection;

use crate::models::data::{Account, Host};
use crate::services::certificates::load_cert_content;
use crate::services::keys::load_key_content;
use crate::services::port_forwardings::{load_account, load_host};
use crate::ssh::session::SshConfig;
use crate::utils::sqlite;

/// 解析指定主机用于建立连接的 SSH 认证配置（账号优先、主机回退），
/// 并读取密钥/证书内容填充，与终端连接走同一套认证链路。
/// 主机配置了跳板机时，一并解析跳板机配置填入 `config.proxy`（递归支持链式跳板，防循环）。
pub fn resolve_host_ssh_config(conn: &Connection, host_id: &str) -> Result<SshConfig, String> {
    let mut visited = std::collections::HashSet::new();
    resolve_host_ssh_config_inner(conn, host_id, &mut visited)
}

fn resolve_host_ssh_config_inner(
    conn: &Connection,
    host_id: &str,
    visited: &mut std::collections::HashSet<String>,
) -> Result<SshConfig, String> {
    if !visited.insert(host_id.to_string()) {
        return Err("检测到跳板机循环引用，请检查主机间的跳板机配置。".to_string());
    }
    let host = load_host(conn, host_id)?.ok_or_else(|| "SSH 主机不存在或已被删除".to_string())?;

    let mut username = host.username.clone();
    let mut auth_type = host.auth_type.clone().unwrap_or_default();
    let mut password = host.password.clone();
    let mut key_id = host.key_id.clone();
    let mut cert_id = host.certificate_id.clone();
    if let Some(account_id) = host.account_id.clone() {
        if let Some(account) = load_account(conn, &account_id)? {
            (username, auth_type, password, key_id, cert_id) =
                merge_account_auth(&host, Some(&account));
        }
    }

    let mut config = SshConfig {
        backend: String::new(),
        algo_profile: String::new(),
        host: host.host.clone(),
        port: host.port,
        username,
        auth_type,
        password,
        key_path: None,
        cert_path: None,
        passphrase: None,
        key_id,
        private_key: None,
        public_key: None,
        cert_id,
        cert_content: None,
        cert_private_key: None,
        proxy: None,
    };

    fill_auth_content(conn, &mut config)?;

    // 跳板机：引用已有主机（proxy_host_id）或内联配置（proxy_host + proxy_port）
    if host.use_proxy.unwrap_or(false) {
        let proxy_config = if let Some(proxy_host_id) = host.proxy_host_id.clone() {
            // 递归解析被引用的跳板机主机（会继续处理其自身的跳板机，visited 防循环）
            resolve_host_ssh_config_inner(conn, &proxy_host_id, visited)?
        } else if let (Some(proxy_host), Some(proxy_port)) =
            (host.proxy_host.clone(), host.proxy_port)
        {
            resolve_inline_proxy_config(conn, &host, proxy_host, proxy_port)?
        } else {
            return Err("该主机配置了跳板机，但跳板机地址或主机引用不完整。".to_string());
        };
        config.proxy = Some(Box::new(proxy_config));
    }

    Ok(config)
}

/// 解析内联跳板机配置（直接填写的跳板机地址/端口/用户名/认证），读取其密钥/证书内容。
fn resolve_inline_proxy_config(
    conn: &Connection,
    host: &Host,
    proxy_host: String,
    proxy_port: u16,
) -> Result<SshConfig, String> {
    let auth_type = host.proxy_auth_type.clone().unwrap_or_default();
    let mut config = SshConfig {
        backend: String::new(),
        algo_profile: String::new(),
        host: proxy_host,
        port: proxy_port,
        username: host.proxy_username.clone().unwrap_or_default(),
        auth_type,
        password: host.proxy_password.clone(),
        key_path: None,
        cert_path: None,
        passphrase: None,
        key_id: host.proxy_key_id.clone(),
        private_key: None,
        public_key: None,
        cert_id: host.proxy_cert_id.clone(),
        cert_content: None,
        cert_private_key: None,
        proxy: None,
    };
    fill_auth_content(conn, &mut config)?;
    Ok(config)
}

/// 密钥/证书认证材料装载：按 key_id/cert_id 从 DB 读内容入内存（不落盘）。
/// SSH 终端与 MOSH 引导共用同一认证链路，保证行为一致。
pub fn prepare_ssh_auth_material(mut config: SshConfig) -> Result<SshConfig, String> {
    let conn = sqlite::open_connection()?;
    fill_auth_content_loose(&conn, &mut config)?;
    Ok(config)
}

/// SFTP 公钥认证的材料填充（protocol == "sftp" && auth_type == "publickey" 时调用）。
pub fn fill_sftp_key_material(
    conn: &Connection,
    key_id: Option<&str>,
    private_key: &mut Option<String>,
    public_key: &mut Option<String>,
) -> Result<(), String> {
    if let Some(key_id) = key_id {
        let (private, public) = load_key_content(conn, key_id)?;
        if private.is_none() && public.is_none() {
            return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
        }
        *private_key = private;
        *public_key = public;
    }
    Ok(())
}

/// 账号对象合并到主机字段：账号优先、主机回退（resolve_host_ssh_config_inner 的抽取）。
pub(crate) fn merge_account_auth(
    host: &Host,
    account: Option<&Account>,
) -> (String, String, Option<String>, Option<String>, Option<String>) {
    let mut username = host.username.clone();
    let mut auth_type = host.auth_type.clone().unwrap_or_default();
    let mut password = host.password.clone();
    let mut key_id = host.key_id.clone();
    let mut cert_id = host.certificate_id.clone();
    if let Some(account) = account {
        username = account.username.clone();
        auth_type = account.auth_type.clone();
        password = account.password.clone();
        key_id = account.key_id.clone();
        cert_id = account.certificate_id.clone();
    }
    (username, auth_type, password, key_id, cert_id)
}

/// 根据 auth_type 从数据库读取密钥/证书内容填充到 config（key/certificate 认证），
/// 主配置与跳板机配置共用此逻辑。password 缺失即报错（DB 解析路径：严格）。
fn fill_auth_content(conn: &Connection, config: &mut SshConfig) -> Result<(), String> {
    match config.auth_type.as_str() {
        "key" => {
            if let Some(kid) = config.key_id.clone() {
                let (private_key, public_key) = load_key_content(conn, &kid)?;
                if private_key.is_none() && public_key.is_none() {
                    return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
                }
                config.private_key = private_key;
                config.public_key = public_key;
            } else {
                return Err("密钥认证缺少可用的密钥，请到“账号/主机”页重新选择密钥。".to_string());
            }
        }
        "certificate" => {
            if let Some(cid) = config.cert_id.clone() {
                let (cert_content, private_key) = load_cert_content(conn, &cid)?;
                if cert_content.is_none() {
                    return Err("该证书的内容未存储，请重新导入证书。".to_string());
                }
                if private_key.is_none() {
                    return Err(
                        "该证书未绑定配套私钥，无法完成 SSH 认证，请到“证书”页重新导入并附上私钥。"
                            .to_string(),
                    );
                }
                config.cert_content = cert_content;
                config.cert_private_key = private_key;
            } else {
                return Err("证书认证缺少证书，请到“账号/主机”页重新选择证书。".to_string());
            }
        }
        "password" => {
            if config.password.is_none() {
                return Err("密码认证缺少密码，请到“账号/主机”页重新填写密码。".to_string());
            }
        }
        _ => {
            return Err(format!("不支持的认证类型：{}", config.auth_type));
        }
    }
    Ok(())
}

/// 前端直传 SshConfig 的材料填充（宽松版）：key/cert 有 id 才查 DB；
/// 无 id 时允许内存字段（private_key/key_path）直通，由后端连接时决定；
/// password/agent 等不校验（连接时由认证层报错）。
fn fill_auth_content_loose(conn: &Connection, config: &mut SshConfig) -> Result<(), String> {
    if config.auth_type == "key" {
        if let Some(key_id) = config.key_id.clone() {
            let (private_key, public_key) = load_key_content(conn, &key_id)?;
            if private_key.is_none() && public_key.is_none() {
                return Err("该密钥的内容未存储，请重新导入或生成密钥。".to_string());
            }
            config.private_key = private_key;
            config.public_key = public_key;
        } else if config.private_key.is_none() && config.key_path.is_none() {
            return Err("密钥认证缺少可用的密钥，请到“账号/主机”页重新选择密钥。".to_string());
        }
    }

    if config.auth_type == "certificate" {
        if let Some(cert_id) = config.cert_id.clone() {
            let (cert_content, private_key) = load_cert_content(conn, &cert_id)?;
            if cert_content.is_none() {
                return Err("该证书的内容未存储，请重新导入证书。".to_string());
            }
            if private_key.is_none() {
                return Err(
                    "该证书未绑定配套私钥，无法完成 SSH 认证，请到“证书”页重新导入并附上私钥。"
                        .to_string(),
                );
            }
            config.cert_content = cert_content;
            config.cert_private_key = private_key;
        }
    }
    Ok(())
}
