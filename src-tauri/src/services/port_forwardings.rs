use rusqlite::{params, Connection, OptionalExtension};

use crate::AppState;
use crate::models::data::{Account, Host, PortForwarding};
use crate::services::certificates::load_cert_content;
use crate::services::common::{resolve_secret, store_secret_or_clear};
use crate::services::keys::load_key_content;
use crate::services::logs::append_log;
use crate::ssh::session::SshConfig;
use crate::utils::sqlite;

/// 从数据库读取全部规则（status 为占位值，实际连接状态由调用方按内存隧道派生）。
/// socks_password 按与 host 密码一致的方式从密钥链 resolve（供前端编辑回填）。
fn query_all_port_forwardings() -> Result<Vec<PortForwarding>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host_id, listen_host, listen_port, target_host, target_port, status, description, created_at, last_used, socks_username, socks_password
             FROM port_forwardings ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PortForwarding {
                id: row.get(0)?,
                name: row.get(1)?,
                rule_type: row.get(2)?,
                host_id: row.get(3)?,
                listen_host: row.get(4)?,
                listen_port: row.get(5)?,
                target_host: row.get(6)?,
                target_port: row.get(7)?,
                status: row.get(8)?,
                description: row.get(9)?,
                created_at: row.get(10)?,
                last_used: row.get(11)?,
                socks_username: row.get(12)?,
                socks_password: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut rules: Vec<PortForwarding> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for rule in &mut rules {
        rule.socks_password = resolve_secret(
            rule.socks_password.take(),
            &format!("portforwardings/{}/socks_password", rule.id),
        );
    }
    Ok(rules)
}

/// 隧道连接状态真相源：状态存于内存 TunnelManager，不落库。
/// 返回规则时按「当前活跃隧道」覆盖 status，避免 DB 状态与事实脱节
/// （删除/编辑/看门狗/异常退出都不再需要同步 DB 状态）。
#[tauri::command]
pub async fn list_port_forwardings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PortForwarding>, String> {
    let mut rules = query_all_port_forwardings()?;
    let active: std::collections::HashSet<String> = state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .list()
        .into_iter()
        .collect();
    for rule in &mut rules {
        rule.status = if active.contains(&rule.id) {
            "connected".to_string()
        } else {
            "disconnected".to_string()
        };
    }
    Ok(rules)
}

/// 校验端口转发规则的端口范围与转发类型（后端兜底：IPC 可绕过前端校验，防止 u16 截断）。
fn validate_port_forwarding(rule: &PortForwarding) -> Result<(), String> {
    if rule.listen_port == 0 || rule.listen_port > 65535 {
        return Err("监听端口必须在 1-65535 之间".to_string());
    }
    if rule.target_port > 65535 {
        return Err("目标端口必须在 0-65535 之间".to_string());
    }
    match rule.rule_type.as_str() {
        "local" | "remote" | "dynamic" => {}
        _ => return Err(format!("不支持的转发类型：{}", rule.rule_type)),
    }
    Ok(())
}

#[tauri::command]
pub async fn save_port_forwarding(
    state: tauri::State<'_, AppState>,
    mut rule: PortForwarding,
) -> Result<PortForwarding, String> {
    validate_port_forwarding(&rule)?;

    let conn = sqlite::open_connection()?;
    let is_new = rule.id.trim().is_empty();
    if !is_new {
        // 编辑运行中的规则：先停止旧隧道，避免 DB 参数已更新但隧道仍按旧参数监听
        let _ = state
            .tunnels
            .lock()
            .map_err(|e| e.to_string())?
            .stop(&rule.id);
    }
    if is_new {
        rule.id = sqlite::new_id("pf");
        if rule.created_at.trim().is_empty() {
            rule.created_at = sqlite::now_iso();
        }
    }
    if rule.listen_host.trim().is_empty() {
        rule.listen_host = "127.0.0.1".to_string();
    }
    // status 不再持久化真相：统一落 disconnected 占位，实际状态由 list 按内存隧道派生
    rule.status = "disconnected".to_string();

    // SOCKS5 认证密码走系统密钥链，DB 列仅存空占位（不落明文）
    let socks_password = std::mem::take(&mut rule.socks_password);
    store_secret_or_clear(
        &format!("portforwardings/{}/socks_password", rule.id),
        socks_password.as_deref(),
    )?;
    rule.socks_password = None;

    conn.execute(
        "INSERT INTO port_forwardings (
            id, name, type, host_id, listen_host, listen_port, target_host, target_port, status, description, created_at, last_used, socks_username, socks_password
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            host_id = excluded.host_id,
            listen_host = excluded.listen_host,
            listen_port = excluded.listen_port,
            target_host = excluded.target_host,
            target_port = excluded.target_port,
            status = excluded.status,
            description = excluded.description,
            created_at = excluded.created_at,
            last_used = excluded.last_used,
            socks_username = excluded.socks_username,
            socks_password = excluded.socks_password",
        params![
            rule.id,
            rule.name,
            rule.rule_type,
            rule.host_id,
            rule.listen_host,
            rule.listen_port,
            rule.target_host,
            rule.target_port,
            rule.status,
            rule.description,
            rule.created_at,
            rule.last_used,
            rule.socks_username,
            rule.socks_password,
        ],
    )
    .map_err(|e| e.to_string())?;

    append_log(
        &conn,
        "info",
        &format!(
            "{} port forwarding rule {}",
            if is_new { "Created" } else { "Updated" },
            rule.name
        ),
        Some("portforwarding"),
    )?;

    Ok(rule)
}

#[tauri::command]
pub async fn delete_port_forwarding(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // 先停止可能正在运行的隧道，否则规则删除后隧道仍占端口/连接，成为无法停止的孤儿
    let _ = state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .stop(&id);

    let conn = sqlite::open_connection()?;
    let name: Option<String> = conn
        .query_row("SELECT name FROM port_forwardings WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM port_forwardings WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;

    append_log(
        &conn,
        "info",
        &format!(
            "Deleted port forwarding rule {}",
            name.unwrap_or_else(|| "unknown".to_string())
        ),
        Some("portforwarding"),
    )?;
    Ok(())
}

/// 测试转发目标的 TCP 连通性（验证 remote 规则的目标可达）。
/// 注意：这验证的是目标主机的网络可达性，不建立 SSH 隧道。
/// DNS 解析 + 连接整体限制在 10s 内返回，避免慢 DNS 让前端长时间挂起。
#[tauri::command]
pub async fn test_port_forward_target(target_host: String, target_port: u16) -> Result<bool, String> {
    use std::time::Duration;

    let addr = format!("{}:{}", target_host, target_port);
    let probe = tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        let sock_addr = addr
            .to_socket_addrs()
            .map_err(|e| format!("无法解析目标地址 {addr}: {e}"))?
            .next()
            .ok_or_else(|| format!("没有解析到 {addr} 的地址"))?;
        match TcpStream::connect_timeout(&sock_addr, Duration::from_secs(5)) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    });

    match tokio::time::timeout(Duration::from_secs(10), probe).await {
        Ok(Ok(result)) => result,
        Ok(Err(join_err)) => Err(format!("测试任务失败: {join_err}")),
        Err(_) => Err("测试超时，请稍后重试".to_string()),
    }
}

// ==================== 隧道连接辅助 ====================

/// 读取单条端口转发规则（内部使用：解析 socks_password 供隧道认证）。
pub fn load_port_forwarding(conn: &Connection, id: &str) -> Result<Option<PortForwarding>, String> {
    let mut rule = conn
        .query_row(
            "SELECT id, name, type, host_id, listen_host, listen_port, target_host, target_port, status, description, created_at, last_used, socks_username, socks_password
             FROM port_forwardings WHERE id = ?1",
            params![id],
            |row| {
                Ok(PortForwarding {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    rule_type: row.get(2)?,
                    host_id: row.get(3)?,
                    listen_host: row.get(4)?,
                    listen_port: row.get(5)?,
                    target_host: row.get(6)?,
                    target_port: row.get(7)?,
                    status: row.get(8)?,
                    description: row.get(9)?,
                    created_at: row.get(10)?,
                    last_used: row.get(11)?,
                    socks_username: row.get(12)?,
                    socks_password: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(r) = rule.as_mut() {
        r.socks_password = resolve_secret(
            r.socks_password.take(),
            &format!("portforwardings/{}/socks_password", r.id),
        );
    }
    Ok(rule)
}

/// 更新最近使用时间（隧道建立成功时调用；连接状态本身由内存 TunnelManager 派生，不落库）。
pub fn touch_last_used(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE port_forwardings SET last_used = ?1 WHERE id = ?2",
        params![sqlite::now_iso(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_host(conn: &Connection, id: &str) -> Result<Option<Host>, String> {
    conn.query_row(
        "SELECT id, name, host, port, account_id, username, status, last_connected, auth_type, password,
                key_id, certificate_id, use_proxy, proxy_host_id, proxy_auth_type, proxy_key_id,
                proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password
         FROM hosts WHERE id = ?1",
        params![id],
        |row| {
            let mut host = Host {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                account_id: row.get(4)?,
                username: row.get(5)?,
                status: row.get(6)?,
                last_connected: row.get(7)?,
                auth_type: row.get(8)?,
                password: row.get(9)?,
                key_id: row.get(10)?,
                certificate_id: row.get(11)?,
                use_proxy: row.get(12)?,
                proxy_host_id: row.get(13)?,
                proxy_auth_type: row.get(14)?,
                proxy_key_id: row.get(15)?,
                proxy_cert_id: row.get(16)?,
                proxy_host: row.get(17)?,
                proxy_port: row.get(18)?,
                proxy_username: row.get(19)?,
                proxy_password: row.get(20)?,
            };
            host.password = resolve_secret(host.password.take(), &format!("hosts/{}/password", id));
            host.proxy_password =
                resolve_secret(host.proxy_password.take(), &format!("hosts/{}/proxy_password", id));
            Ok(host)
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn load_account(conn: &Connection, id: &str) -> Result<Option<Account>, String> {
    conn.query_row(
        "SELECT id, name, username, auth_type, password, key_id, certificate_id,
                description, created_at, last_used
         FROM accounts WHERE id = ?1",
        params![id],
        |row| {
            let mut account = Account {
                id: row.get(0)?,
                name: row.get(1)?,
                username: row.get(2)?,
                auth_type: row.get(3)?,
                password: row.get(4)?,
                key_id: row.get(5)?,
                certificate_id: row.get(6)?,
                description: row.get(7)?,
                created_at: row.get(8)?,
                last_used: row.get(9)?,
                tags: None,
            };
            account.password =
                resolve_secret(account.password.take(), &format!("accounts/{}/password", id));
            Ok(account)
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 解析指定主机用于建立隧道的 SSH 认证配置（账号优先、主机回退），
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

    // 账号优先：存在关联账号则用账号的认证信息，否则回退主机自身字段
    let mut username = host.username.clone();
    let mut auth_type = host.auth_type.clone().unwrap_or_default();
    let mut password = host.password.clone();
    let mut key_id = host.key_id.clone();
    let mut cert_id = host.certificate_id.clone();
    if let Some(account_id) = host.account_id.clone() {
        if let Some(account) = load_account(conn, &account_id)? {
            username = account.username;
            auth_type = account.auth_type;
            password = account.password;
            key_id = account.key_id;
            cert_id = account.certificate_id;
        }
    }

    let mut config = SshConfig {
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

/// 根据 auth_type 从数据库读取密钥/证书内容填充到 config（key/certificate 认证），
/// 主配置与跳板机配置共用此逻辑。
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

#[cfg(test)]
mod tests {
    use super::validate_port_forwarding;
    use crate::models::data::PortForwarding;

    fn make_rule(listen_port: u32, target_port: u32, rule_type: &str) -> PortForwarding {
        PortForwarding {
            id: String::new(),
            name: "测试规则".into(),
            rule_type: rule_type.into(),
            host_id: None,
            listen_host: "127.0.0.1".into(),
            listen_port,
            target_host: Some("target.internal".into()),
            target_port,
            status: String::new(),
            description: None,
            created_at: String::new(),
            last_used: None,
            socks_username: None,
            socks_password: None,
        }
    }

    #[test]
    fn valid_ports_and_types_pass() {
        assert!(validate_port_forwarding(&make_rule(1, 0, "local")).is_ok());
        assert!(validate_port_forwarding(&make_rule(65535, 65535, "remote")).is_ok());
        assert!(validate_port_forwarding(&make_rule(1080, 0, "dynamic")).is_ok());
    }

    #[test]
    fn listen_port_zero_is_rejected() {
        assert!(validate_port_forwarding(&make_rule(0, 80, "local")).is_err());
    }

    #[test]
    fn listen_port_over_65535_is_rejected() {
        assert!(validate_port_forwarding(&make_rule(65536, 80, "local")).is_err());
    }

    #[test]
    fn target_port_over_65535_is_rejected() {
        assert!(validate_port_forwarding(&make_rule(1080, 65536, "local")).is_err());
    }

    #[test]
    fn target_port_zero_is_allowed_for_dynamic() {
        // dynamic 转发无固定目标，target_port 允许为 0
        assert!(validate_port_forwarding(&make_rule(1080, 0, "dynamic")).is_ok());
    }

    #[test]
    fn invalid_type_is_rejected() {
        assert!(validate_port_forwarding(&make_rule(1080, 80, "socks")).is_err());
    }
}
