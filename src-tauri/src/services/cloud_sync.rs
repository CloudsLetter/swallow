//! 云同步：将本地数据（主机/账号/密钥/证书/SFTP 连接/端口转发/片段/配置）打包成
//! JSON，用 server_key 派生的 AES-256-GCM 密钥加密后，通过自建 HTTP 服务器上传/下载。
//!
//! 协议约定（与自建服务器配合）：
//!   - 端点：`http(s)://{host}:{port}/{server_key}`（server_key 本身作为路径段，既鉴权又派生加密密钥）
//!   - 上传：`POST`，body 为加密后的数据包文本（`v1.{salt}.{nonce}.{cipher}`）
//!   - 下载：`GET`，返回体为加密后的数据包文本
//!
//! 加密方案：server_key + 随机 salt 经 PBKDF2-SHA256(100k) 派生 32 字节密钥，AES-256-GCM 加密。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::models::data::{
    Account, CertificateRecord, Host, PortForwarding, SftpConnection, Snippet,
};
use crate::services::common::{store_secret_or_clear, to_tags_json};
use crate::services::logs::append_log_i18n;
use crate::utils::crypto;
use crate::utils::sqlite;

/// 数据包版本号。v2 新增：桌面连接（remote_conns）、已知主机（known_hosts）、
/// 监控状态（monitor_state），以及 settings 全段（含 ai/context_menu/monitor_alerts）。
const PACKET_VERSION: u32 = 2;
/// 本地可读取的最低包版本（v1 老包仍可下载恢复）。
const MIN_READABLE_VERSION: u32 = 1;

/// 同步结果统计（返回给前端展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 本次同步动作：upload | download
    pub direction: String,
    /// 成功同步的各类目条目数（key 为类目名）
    pub counts: HashMap<String, usize>,
    /// 同步时间（RFC3339）
    pub timestamp: String,
    /// 本次跳过的条目（冲突/校验失败等），供前端展示明细
    #[serde(default)]
    pub skipped: Vec<SyncSkipped>,
}

/// 同步跳过条目：冲突或校验失败时记录原因，不阻断整批。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSkipped {
    pub category: String,
    pub name: String,
    pub reason: String,
}

/// 密钥条目：密钥记录 + 密钥内容（私钥/公钥明文 PEM）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedKey {
    #[serde(flatten)]
    record: KeyRecordForSync,
    private_key: Option<String>,
    public_key: Option<String>,
}

/// 密钥记录（与 `KeyRecord` 一致，字段名直接复用，避免 `type` 关键字序列化问题）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyRecordForSync {
    id: String,
    name: String,
    #[serde(rename = "type")]
    key_type: String,
    fingerprint: String,
    created_at: String,
    size: u32,
    source: Option<String>,
}

/// 证书条目：证书记录 + 证书内容 + 配套私钥。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedCert {
    #[serde(flatten)]
    record: CertificateRecord,
    cert_content: Option<String>,
    private_key_content: Option<String>,
}

/// 设置同步子集：只同步用户关心的配置，排除 cloud 自身凭据（server_key 等）。
/// v2 起同步全部可同步段（appearance/terminal/ssh/security/advanced/ai/
/// context_menu/monitor_alerts），用 serde_json::Value 原样透传；cloud 段永不进包。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedSettings {
    #[serde(default)]
    appearance: serde_json::Value,
    #[serde(default)]
    terminal: serde_json::Value,
    #[serde(default)]
    ssh: serde_json::Value,
    #[serde(default)]
    security: serde_json::Value,
    #[serde(default)]
    advanced: serde_json::Value,
    #[serde(default)]
    ai: serde_json::Value,
    #[serde(default)]
    context_menu: serde_json::Value,
    #[serde(default)]
    monitor_alerts: serde_json::Value,
}

/// 已知主机同步条目（raw_line 足以重建全部字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedKnownHost {
    host: String,
    key_type: String,
    fingerprint: String,
    last_used: String,
    added_date: String,
    raw_line: String,
}

/// 完整数据包：上传/下载的载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudPacket {
    version: u32,
    created_at: String,
    #[serde(default)]
    hosts: Vec<Host>,
    #[serde(default)]
    accounts: Vec<Account>,
    #[serde(default)]
    sftp_connections: Vec<SftpConnection>,
    #[serde(default)]
    port_forwardings: Vec<PortForwarding>,
    #[serde(default)]
    keys: Vec<SyncedKey>,
    #[serde(default)]
    certificates: Vec<SyncedCert>,
    #[serde(default)]
    snippets: Vec<Snippet>,
    /// 桌面连接（VNC/RDP 会话簿，v2 新增）
    #[serde(default)]
    remote_conns: Vec<crate::services::remotes::RemoteConn>,
    /// 已知主机信任条目（v2 新增）
    #[serde(default)]
    known_hosts: Vec<SyncedKnownHost>,
    /// 监控页状态（v2 新增）
    #[serde(default)]
    monitor_state: Option<crate::services::monitor_state::MonitorState>,
    #[serde(default)]
    settings: Option<SyncedSettings>,
}

/// 读取云同步配置（从内存态全局配置，避免反复读盘/重写 config.toml 的副作用）。
fn read_cloud_config(
    config_state: &tauri::State<'_, crate::config::global_config::GlobaConfig>,
) -> Result<crate::models::config::Cloud, String> {
    config_state
        .config
        .read()
        .map(|guard| guard.cloud.clone())
        .map_err(|e| e.to_string())
}

// ==================== 数据收集（DB + 密钥链 → 数据包） ====================

/// 收集密钥（含内容）。
fn collect_keys(conn: &rusqlite::Connection) -> Result<Vec<SyncedKey>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, key_type, fingerprint, created_at, size, source
             FROM keys ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let records: Vec<KeyRecordForSync> = stmt
        .query_map([], |row| {
            Ok(KeyRecordForSync {
                id: row.get(0)?,
                name: row.get(1)?,
                key_type: row.get(2)?,
                fingerprint: row.get(3)?,
                created_at: row.get(4)?,
                size: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut keys = Vec::with_capacity(records.len());
    for record in records {
        let (private_key, public_key) = crate::services::keys::load_key_content(conn, &record.id)?;
        keys.push(SyncedKey {
            record,
            private_key,
            public_key,
        });
    }
    Ok(keys)
}

/// 收集证书（含内容）。
fn collect_certificates(conn: &rusqlite::Connection) -> Result<Vec<SyncedCert>, String> {
    let records = crate::services::certificates::list_certificates()?;
    let mut certs = Vec::with_capacity(records.len());
    for record in records {
        let (cert_content, private_key_content) =
            crate::services::certificates::load_cert_content(conn, &record.id)?;
        certs.push(SyncedCert {
            record,
            cert_content,
            private_key_content,
        });
    }
    Ok(certs)
}

/// 收集端口转发规则（含 socks_password，从密钥链解析）。
fn collect_port_forwardings() -> Result<Vec<PortForwarding>, String> {
    let conn = sqlite::open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host_id, listen_host, listen_port, target_host, target_port, status, description, created_at, last_used, auto_connect, socks_username, socks_password
             FROM port_forwardings ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let mut rules: Vec<PortForwarding> = stmt
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
                auto_connect: row.get::<_, i64>(12).unwrap_or(0) != 0,
                socks_username: row.get(13)?,
                socks_password: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for rule in &mut rules {
        rule.socks_password = crate::services::common::resolve_secret(
            rule.socks_password.take(),
            &format!("portforwardings/{}/socks_password", rule.id),
        );
    }
    Ok(rules)
}

/// 收集设置子集：从内存态配置摘出需要同步的段落（cloud 段永不进包）。
///
/// `pub(crate)`：配置的分类导出（`export_settings`）复用同一份口径，
/// 避免「云同步排除了 cloud 段、导出却没排除」这类两处规则漂移。
pub(crate) fn collect_settings(
    config_state: &tauri::State<'_, crate::config::global_config::GlobaConfig>,
) -> Result<SyncedSettings, String> {
    let config = config_state
        .config
        .read()
        .map(|guard| guard.clone())
        .map_err(|e| e.to_string())?;
    Ok(SyncedSettings {
        appearance: serde_json::to_value(config.appearance).unwrap_or_default(),
        terminal: serde_json::to_value(config.terminal).unwrap_or_default(),
        ssh: serde_json::to_value(config.ssh).unwrap_or_default(),
        security: serde_json::to_value(config.security).unwrap_or_default(),
        advanced: serde_json::to_value(config.advanced).unwrap_or_default(),
        ai: serde_json::to_value(config.ai).unwrap_or_default(),
        context_menu: serde_json::to_value(config.context_menu).unwrap_or_default(),
        monitor_alerts: serde_json::to_value(config.monitor_alerts).unwrap_or_default(),
    })
}

/// 收集已知主机信任条目。
fn collect_known_hosts(conn: &rusqlite::Connection) -> Result<Vec<SyncedKnownHost>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT host, key_type, fingerprint, last_used, added_date, raw_line
             FROM known_hosts ORDER BY host COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncedKnownHost {
                host: row.get(0)?,
                key_type: row.get(1)?,
                fingerprint: row.get(2)?,
                last_used: row.get(3)?,
                added_date: row.get(4)?,
                raw_line: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 根据 sync_* 开关收集本地数据为数据包。
fn collect_packet(
    config_state: &tauri::State<'_, crate::config::global_config::GlobaConfig>,
    cloud: &crate::models::config::Cloud,
) -> Result<CloudPacket, String> {
    let conn = sqlite::open_connection()?;
    let mut packet = CloudPacket {
        version: PACKET_VERSION,
        created_at: sqlite::now_iso(),
        hosts: Vec::new(),
        accounts: Vec::new(),
        sftp_connections: Vec::new(),
        port_forwardings: Vec::new(),
        keys: Vec::new(),
        certificates: Vec::new(),
        snippets: Vec::new(),
        remote_conns: Vec::new(),
        known_hosts: Vec::new(),
        monitor_state: None,
        settings: None,
    };

    if cloud.sync_hosts {
        packet.hosts = crate::services::hosts::list_hosts()?;
        packet.accounts = crate::services::accounts::list_accounts()?;
        packet.sftp_connections = crate::services::sftp_connections::list_sftp_connections()?;
        packet.port_forwardings = collect_port_forwardings()?;
        packet.remote_conns = crate::services::remotes::list_remote_conns()?;
        packet.known_hosts = collect_known_hosts(&conn)?;
        packet.monitor_state = crate::services::monitor_state::monitor_get_state().ok();
    }
    if cloud.sync_keys {
        packet.keys = collect_keys(&conn)?;
        packet.certificates = collect_certificates(&conn)?;
    }
    if cloud.sync_snippets {
        packet.snippets = crate::services::snippets::list_snippets()?;
    }
    if cloud.sync_settings {
        packet.settings = Some(collect_settings(config_state)?);
    }

    Ok(packet)
}

// ==================== 数据恢复（数据包 → DB + 密钥链） ====================

/// 恢复密钥（upsert 记录 + 内容）。
fn restore_keys(conn: &rusqlite::Connection, keys: &[SyncedKey]) -> Result<usize, String> {
    for key in keys {
        let r = &key.record;
        conn.execute(
            "INSERT INTO keys (id, name, key_type, fingerprint, created_at, size, key_path, public_key_path, source, private_key, public_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                key_type = excluded.key_type,
                fingerprint = excluded.fingerprint,
                created_at = excluded.created_at,
                size = excluded.size,
                source = excluded.source,
                private_key = excluded.private_key,
                public_key = excluded.public_key",
            rusqlite::params![
                r.id,
                r.name,
                r.key_type,
                r.fingerprint,
                r.created_at,
                r.size,
                r.source,
                key.private_key,
                key.public_key,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(keys.len())
}

/// 恢复证书（upsert 记录 + 内容）。
fn restore_certificates(
    conn: &rusqlite::Connection,
    certs: &[SyncedCert],
) -> Result<usize, String> {
    for cert in certs {
        let c = &cert.record;
        let principals_json = serde_json::to_string(&c.principals).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO certificates (id, name, cert_type, key_type, fingerprint, created_at, cert_path, private_key_path, principals_json, valid_after, valid_before, source, cert_content, private_key_content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                cert_type = excluded.cert_type,
                key_type = excluded.key_type,
                fingerprint = excluded.fingerprint,
                created_at = excluded.created_at,
                principals_json = excluded.principals_json,
                valid_after = excluded.valid_after,
                valid_before = excluded.valid_before,
                source = excluded.source,
                cert_content = excluded.cert_content,
                private_key_content = excluded.private_key_content",
            rusqlite::params![
                c.id,
                c.name,
                c.cert_type,
                c.key_type,
                c.fingerprint,
                c.created_at,
                principals_json,
                c.valid_after,
                c.valid_before,
                c.source,
                cert.cert_content,
                cert.private_key_content,
            ],
        )
        .map_err(|e| e.to_string())?;
        // has_private_key 是派生标志，不落库（读取时按 private_key_content 推导）
    }
    Ok(certs.len())
}

/// 恢复主机（upsert + 密码写密钥链）。
fn restore_hosts(conn: &rusqlite::Connection, hosts: &[Host]) -> Result<usize, String> {
    for host in hosts {
        let password = host.password.clone();
        let proxy_password = host.proxy_password.clone();
        store_secret_or_clear(&format!("hosts/{}/password", host.id), password.as_deref())?;
        store_secret_or_clear(
            &format!("hosts/{}/proxy_password", host.id),
            proxy_password.as_deref(),
        )?;

        conn.execute(
            "INSERT INTO hosts (id, name, host, port, account_id, username, status, last_connected, auth_type, password,
                    key_id, certificate_id, use_proxy, proxy_host_id, proxy_auth_type, proxy_key_id,
                    proxy_cert_id, proxy_host, proxy_port, proxy_username, proxy_password, icon, group_name, tags_json, favorite, backend, algo_profile, os_auto)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, '', ?20, ?21, ?22, ?23, ?24, ?25, ?26)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                account_id = excluded.account_id,
                username = excluded.username,
                status = excluded.status,
                last_connected = excluded.last_connected,
                auth_type = excluded.auth_type,
                password = '',
                key_id = excluded.key_id,
                certificate_id = excluded.certificate_id,
                use_proxy = excluded.use_proxy,
                proxy_host_id = excluded.proxy_host_id,
                proxy_auth_type = excluded.proxy_auth_type,
                proxy_key_id = excluded.proxy_key_id,
                proxy_cert_id = excluded.proxy_cert_id,
                proxy_host = excluded.proxy_host,
                proxy_port = excluded.proxy_port,
                proxy_username = excluded.proxy_username,
                proxy_password = '',
                icon = excluded.icon,
                group_name = excluded.group_name,
                tags_json = excluded.tags_json,
                favorite = excluded.favorite,
                backend = excluded.backend,
                algo_profile = excluded.algo_profile,
                os_auto = excluded.os_auto",
            rusqlite::params![
                host.id,
                host.name,
                host.host,
                host.port,
                host.account_id,
                host.username,
                host.status,
                host.last_connected,
                host.auth_type,
                host.key_id,
                host.certificate_id,
                host.use_proxy,
                host.proxy_host_id,
                host.proxy_auth_type,
                host.proxy_key_id,
                host.proxy_cert_id,
                host.proxy_host,
                host.proxy_port,
                host.proxy_username,
                host.icon,
                host.group,
                crate::services::common::to_tags_json(&host.tags),
                host.favorite as i64,
                host.backend,
                host.algo_profile,
                host.os_auto,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(hosts.len())
}

/// 恢复账号（upsert + 密码写密钥链）。
fn restore_accounts(conn: &rusqlite::Connection, accounts: &[Account]) -> Result<usize, String> {
    for account in accounts {
        let password = account.password.clone();
        store_secret_or_clear(
            &format!("accounts/{}/password", account.id),
            password.as_deref(),
        )?;
        conn.execute(
            "INSERT INTO accounts (id, name, username, auth_type, password, key_id, certificate_id, description, created_at, last_used, tags_json)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                username = excluded.username,
                auth_type = excluded.auth_type,
                password = '',
                key_id = excluded.key_id,
                certificate_id = excluded.certificate_id,
                description = excluded.description,
                created_at = excluded.created_at,
                last_used = excluded.last_used,
                tags_json = excluded.tags_json",
            rusqlite::params![
                account.id,
                account.name,
                account.username,
                account.auth_type,
                account.key_id,
                account.certificate_id,
                account.description,
                account.created_at,
                account.last_used,
                to_tags_json(&account.tags),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(accounts.len())
}

/// 恢复 SFTP 连接（upsert + 密码/passphrase 写密钥链）。
fn restore_sftp_connections(
    conn: &rusqlite::Connection,
    connections: &[SftpConnection],
) -> Result<usize, String> {
    for c in connections {
        let password = c.password.clone();
        let passphrase = c.passphrase.clone();
        store_secret_or_clear(&format!("sftp/{}/password", c.id), password.as_deref())?;
        store_secret_or_clear(&format!("sftp/{}/passphrase", c.id), passphrase.as_deref())?;

        conn.execute(
            "INSERT INTO sftp_connections (id, name, host, port, protocol, username, auth_type, password, key_path, passphrase, key_id, remote_path, last_accessed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, '', ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                protocol = excluded.protocol,
                username = excluded.username,
                auth_type = excluded.auth_type,
                password = '',
                key_path = excluded.key_path,
                passphrase = '',
                key_id = excluded.key_id,
                remote_path = excluded.remote_path,
                last_accessed = excluded.last_accessed",
            rusqlite::params![
                c.id,
                c.name,
                c.host,
                c.port,
                c.protocol,
                c.username,
                c.auth_type,
                c.key_path,
                c.key_id,
                c.remote_path,
                c.last_accessed,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(connections.len())
}

/// 恢复端口转发（upsert + socks_password 写密钥链）。
fn restore_port_forwardings(
    conn: &rusqlite::Connection,
    rules: &[PortForwarding],
) -> Result<usize, String> {
    for rule in rules {
        let socks_password = rule.socks_password.clone();
        store_secret_or_clear(
            &format!("portforwardings/{}/socks_password", rule.id),
            socks_password.as_deref(),
        )?;

        conn.execute(
            "INSERT INTO port_forwardings (id, name, type, host_id, listen_host, listen_port, target_host, target_port, status, description, created_at, last_used, auto_connect, socks_username, socks_password)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, '')
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
                auto_connect = excluded.auto_connect,
                socks_username = excluded.socks_username,
                socks_password = ''",
            rusqlite::params![
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
                rule.auto_connect as i64,
                rule.socks_username,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(rules.len())
}

/// 恢复片段。
fn restore_snippets(conn: &rusqlite::Connection, snippets: &[Snippet]) -> Result<usize, String> {
    for snippet in snippets {
        conn.execute(
            "INSERT INTO snippets (id, name, command, description, category, tags_json, created_at, last_used)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                command = excluded.command,
                description = excluded.description,
                category = excluded.category,
                tags_json = excluded.tags_json,
                created_at = excluded.created_at,
                last_used = excluded.last_used",
            rusqlite::params![
                snippet.id,
                snippet.name,
                snippet.command,
                snippet.description,
                snippet.category,
                to_tags_json(&snippet.tags),
                snippet.created_at,
                snippet.last_used,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(snippets.len())
}

/// 恢复桌面连接（upsert + 密码写密钥链）。
fn restore_remote_conns(
    conn: &rusqlite::Connection,
    items: &[crate::services::remotes::RemoteConn],
) -> Result<usize, String> {
    for item in items {
        let password = item.password.clone();
        store_secret_or_clear(
            &format!("remote/{}/password", item.id),
            password.as_deref(),
        )?;
        conn.execute(
            "INSERT INTO remote_conns (id, name, protocol, host, port, username, password, jump_host_id, created)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                protocol = excluded.protocol,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                password = '',
                jump_host_id = excluded.jump_host_id,
                created = excluded.created",
            rusqlite::params![
                item.id,
                item.name,
                item.protocol,
                item.host,
                item.port,
                item.username,
                item.jump_host_id,
                if item.created.trim().is_empty() { sqlite::now_iso() } else { item.created.clone() },
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(items.len())
}

/// 恢复已知主机（按 host+key_type 去重：云端条目不存在才插入，避免覆盖本地信任）。
fn restore_known_hosts(
    conn: &rusqlite::Connection,
    items: &[SyncedKnownHost],
    skipped: &mut Vec<SyncSkipped>,
) -> Result<usize, String> {
    let mut n = 0;
    for item in items {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM known_hosts WHERE host = ?1 AND key_type = ?2",
                rusqlite::params![item.host, item.key_type],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists > 0 {
            skipped.push(SyncSkipped {
                category: "knownHosts".into(),
                name: format!("{} ({})", item.host, item.key_type),
                reason: "本地已存在相同信任条目，保留本地".into(),
            });
            continue;
        }
        let key_data = item
            .raw_line
            .split_whitespace()
            .nth(2)
            .unwrap_or_default()
            .to_string();
        conn.execute(
            "INSERT INTO known_hosts (id, host, key_type, fingerprint, last_used, added_date, key_data, raw_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                sqlite::new_id("kh"),
                item.host,
                item.key_type,
                if item.fingerprint.is_empty() { sqlite::compute_fingerprint(&key_data) } else { item.fingerprint.clone() },
                if item.last_used.is_empty() { sqlite::now_iso() } else { item.last_used.clone() },
                if item.added_date.is_empty() { sqlite::now_iso() } else { item.added_date.clone() },
                key_data,
                if item.raw_line.is_empty() { format!("{} {} {}", item.host, item.key_type, "") } else { item.raw_line.clone() },
            ],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

/// 恢复监控页状态（host_ids 中本地不存在的主机被剔除并计入跳过）。
fn restore_monitor_state(
    state: &crate::services::monitor_state::MonitorState,
    skipped: &mut Vec<SyncSkipped>,
) -> Result<usize, String> {
    let local_hosts = crate::services::hosts::list_hosts()?;
    let local_ids: std::collections::HashSet<&str> =
        local_hosts.iter().map(|h| h.id.as_str()).collect();
    let kept: Vec<String> = state
        .host_ids
        .iter()
        .filter(|id| {
            let ok = local_ids.contains(id.as_str());
            if !ok {
                skipped.push(SyncSkipped {
                    category: "monitor".into(),
                    name: (*id).clone(),
                    reason: "本地无此主机，监控项已剔除".into(),
                });
            }
            ok
        })
        .cloned()
        .collect();
    crate::services::monitor_state::monitor_save_state(kept.clone(), state.auto_start)?;
    Ok(kept.len())
}

/// 恢复设置子集：合并到当前内存配置 + config.toml（仅覆盖非空段落，
/// 保留 cloud/server_key 等云端自身凭据）。同时更新内存态，使恢复立即生效。
///
/// `pub(crate)`：配置导入（`import_settings_text`）复用它，「cloud 段不覆盖」
/// 这条安全属性因此对两条路径同时成立。
pub(crate) fn restore_settings(
    config_state: &tauri::State<'_, crate::config::global_config::GlobaConfig>,
    settings: &SyncedSettings,
) -> Result<(), String> {
    // 以内存态为准，避免读盘竞态；cloud 段保留不覆盖
    let mut config = config_state
        .config
        .read()
        .map_err(|e| e.to_string())?
        .clone();
    if let Ok(appearance) = serde_json::from_value(settings.appearance.clone()) {
        config.appearance = appearance;
    }
    if let Ok(terminal) = serde_json::from_value(settings.terminal.clone()) {
        config.terminal = terminal;
    }
    if let Ok(ssh) = serde_json::from_value(settings.ssh.clone()) {
        config.ssh = ssh;
    }
    if let Ok(security) = serde_json::from_value(settings.security.clone()) {
        config.security = security;
    }
    if let Ok(advanced) = serde_json::from_value(settings.advanced.clone()) {
        config.advanced = advanced;
    }
    if let Ok(ai) = serde_json::from_value(settings.ai.clone()) {
        config.ai = ai;
    }
    if let Ok(context_menu) = serde_json::from_value(settings.context_menu.clone()) {
        config.context_menu = context_menu;
    }
    if let Ok(monitor_alerts) = serde_json::from_value(settings.monitor_alerts.clone()) {
        config.monitor_alerts = monitor_alerts;
    }

    // 写回内存态 + 落盘
    {
        let mut guard = config_state.config.write().map_err(|e| e.to_string())?;
        *guard = config.clone();
    }
    let config_dir = crate::utils::path::app_config_dir();
    let config_path = config_dir.join(crate::config::global_config::CONFIG_FILE);
    crate::utils::file::write_file_generic(
        &config_path,
        &config,
        crate::config::global_enum::FileFormat::Toml,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 将数据包恢复到本地 DB + 密钥链。返回各类目恢复条数 + 跳过明细。
/// 双向合并语义：download 方向同样只做「云端有、本地无则新增；同 id 以云端为准」，
/// 已知主机与监控引用做存在性校验（见 restore_known_hosts / restore_monitor_state）。
fn apply_packet(
    config_state: &tauri::State<'_, crate::config::global_config::GlobaConfig>,
    packet: &CloudPacket,
    cloud: &crate::models::config::Cloud,
) -> Result<(HashMap<String, usize>, Vec<SyncSkipped>), String> {
    let conn = sqlite::open_connection()?;
    let mut counts = HashMap::new();
    let mut skipped = Vec::new();

    if cloud.sync_hosts {
        counts.insert("hosts".into(), restore_hosts(&conn, &packet.hosts)?);
        counts.insert("accounts".into(), restore_accounts(&conn, &packet.accounts)?);
        counts.insert(
            "sftpConnections".into(),
            restore_sftp_connections(&conn, &packet.sftp_connections)?,
        );
        counts.insert(
            "portForwardings".into(),
            restore_port_forwardings(&conn, &packet.port_forwardings)?,
        );
        counts.insert(
            "remoteConns".into(),
            restore_remote_conns(&conn, &packet.remote_conns)?,
        );
        counts.insert(
            "knownHosts".into(),
            restore_known_hosts(&conn, &packet.known_hosts, &mut skipped)?,
        );
        if let Some(monitor) = &packet.monitor_state {
            counts.insert(
                "monitor".into(),
                restore_monitor_state(monitor, &mut skipped)?,
            );
        }
    }
    if cloud.sync_keys {
        counts.insert("keys".into(), restore_keys(&conn, &packet.keys)?);
        counts.insert(
            "certificates".into(),
            restore_certificates(&conn, &packet.certificates)?,
        );
    }
    if cloud.sync_snippets {
        counts.insert("snippets".into(), restore_snippets(&conn, &packet.snippets)?);
    }
    if cloud.sync_settings {
        if let Some(settings) = &packet.settings {
            restore_settings(config_state, settings)?;
        }
        counts.insert("settings".into(), 1);
    }

    Ok((counts, skipped))
}

// ==================== HTTP 传输 ====================

/// 构建服务器基础 URL。server_host 可含 `http(s)://` 前缀，未含则默认 https。
/// 若配置了 server_port（非 0 且未在 host 里显式带端口），拼接到 host 后。
fn build_base_url(cloud: &crate::models::config::Cloud) -> Result<String, String> {
    let host = cloud.server_host.trim();
    if host.is_empty() {
        return Err("未配置服务器地址".to_string());
    }
    let mut base = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    // 仅当 host 未显式带端口且 server_port 非 0 时追加端口
    if cloud.server_port != 0 && !host_has_explicit_port(host) {
        base = format!("{}:{}", base.trim_end_matches('/'), cloud.server_port);
    }
    let base = base.trim_end_matches('/');
    // server_key 直接作为路径段（鉴权 + 派生加密密钥）
    let key = url_encode_path_segment(&cloud.server_key);
    Ok(format!("{}/{}", base, key))
}

/// 判断 host 字符串是否已显式带端口（含 scheme 或裸 host:port 形式）。
fn host_has_explicit_port(host: &str) -> bool {
    // 去掉 scheme 前缀再判断，避免把 `https://` 里的 `//` 误判
    let without_scheme = host
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    // 形如 `example.com:8080` 或 `[::1]:8080`
    let colon_count = without_scheme.matches(':').count();
    if colon_count == 0 {
        return false;
    }
    // IPv6 裸地址（含多个冒号但无端口）如 `[::1]` 或 `::1` 视为无端口
    if without_scheme.starts_with('[') {
        return without_scheme.contains("]:");
    }
    colon_count == 1
}

/// 简单的 URL 路径段编码（仅对不安全字符做百分号编码）。
fn url_encode_path_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// 上传加密数据包。
async fn upload_packet(
    cloud: &crate::models::config::Cloud,
    payload: &str,
) -> Result<(), String> {
    let url = build_base_url(cloud)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("content-type", "text/plain")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("上传失败: {e}"))?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("上传失败：服务器返回 HTTP {}", status.as_u16()))
    }
}

/// 下载加密数据包（附带服务端元信息：版本/更新时间/大小，供双向合并判断）。
async fn download_packet(cloud: &crate::models::config::Cloud) -> Result<(String, CloudMeta), String> {
    let url = build_base_url(cloud)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    // 先读元信息（HEAD /meta），服务端不支持时降级为空元信息
    let meta = client
        .get(format!("{url}/meta"))
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())
        .map(|_| CloudMeta::default());
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 HTTP {}", status.as_u16()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let meta = match meta {
        Some(_) => fetch_meta(&client, url).await.unwrap_or_default(),
        None => CloudMeta::default(),
    };
    Ok((text, meta))
}

/// 服务端元信息（/meta 返回）：版本号 + 更新时间 + 字节数。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct CloudMeta {
    #[serde(default)]
    version: u64,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    size: u64,
}

async fn fetch_meta(client: &reqwest::Client, url: String) -> Result<CloudMeta, String> {
    let resp = client
        .get(format!("{url}/meta"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(CloudMeta::default());
    }
    resp.json::<CloudMeta>().await.map_err(|e| e.to_string())
}

/// 测试服务器连通性：GET /healthz 期望 200 + {"ok":true}。
#[tauri::command]
pub async fn cloud_test_connection(
    config_state: tauri::State<'_, crate::config::global_config::GlobaConfig>,
) -> Result<CloudMeta, String> {
    let cloud = read_cloud_config(&config_state)?;
    if cloud.server_host.trim().is_empty() {
        return Err("未配置服务器地址".to_string());
    }
    let url = build_base_url(&cloud)?;
    // 去掉末尾的 /{key} 得到根，再拼 /healthz
    let root = url.rsplit('/').collect::<Vec<_>>();
    let root = if root.len() > 1 {
        url.trim_end_matches(&format!("/{}", root[0]))
    } else {
        url.as_str()
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{}/healthz", root.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("服务器返回 HTTP {}", resp.status().as_u16()));
    }
    let meta = fetch_meta(&client, url).await.unwrap_or_default();
    Ok(meta)
}

// ==================== 对外命令 ====================

// ==================== 同步状态持久化 ====================

/// 同步状态文件（data 目录）：记录上次同步时间/方向/云端版本，供双向合并与 UI 展示。
const SYNC_STATE_FILE: &str = "cloud-sync-state.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncStateFile {
    last_sync_at: String,
    last_direction: String,
    last_cloud_updated_at: String,
    last_cloud_version: u64,
}

fn read_sync_state() -> SyncStateFile {
    let path = crate::utils::path::app_data_dir().join(SYNC_STATE_FILE);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_sync_state(state: &SyncStateFile) {
    let path = crate::utils::path::app_data_dir().join(SYNC_STATE_FILE);
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, text);
    }
}

/// 读取同步状态（前端展示上次同步时间）。
#[tauri::command]
pub fn cloud_sync_state() -> Result<SyncStateFile, String> {
    Ok(read_sync_state())
}

/// 立即执行一次同步。`direction`：`"upload"` 上传本地数据；`"download"` 从云端恢复；
/// `"bidirectional"` 双向合并：先下载云端包与本地按 id 合并（云端新条目写入本地），
/// 再把合并结果上传，实现两端最终一致。
/// 下载恢复 settings 类目后会直接更新内存态（无需重启），并 emit 事件通知前端刷新。
#[tauri::command]
pub async fn cloud_sync_now(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, crate::config::global_config::GlobaConfig>,
    direction: String,
) -> Result<SyncReport, String> {
    let cloud = read_cloud_config(&config_state)?;
    if !cloud.enabled {
        return Err("云同步未启用，请先在设置中开启".to_string());
    }
    if cloud.server_key.trim().is_empty() {
        return Err("未配置服务器密钥（server_key）".to_string());
    }

    let conn = sqlite::open_connection()?;

    match direction.as_str() {
        "upload" => {
            let packet = collect_packet(&config_state, &cloud)?;
            let json = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
            let encrypted = crypto::encrypt(&cloud.server_key, &json)?;
            upload_packet(&cloud, &encrypted).await?;

            let counts: HashMap<String, usize> = [
                ("hosts".to_string(), packet.hosts.len()),
                ("accounts".to_string(), packet.accounts.len()),
                ("sftpConnections".to_string(), packet.sftp_connections.len()),
                ("portForwardings".to_string(), packet.port_forwardings.len()),
                ("remoteConns".to_string(), packet.remote_conns.len()),
                ("knownHosts".to_string(), packet.known_hosts.len()),
                ("keys".to_string(), packet.keys.len()),
                ("certificates".to_string(), packet.certificates.len()),
                ("snippets".to_string(), packet.snippets.len()),
            ]
            .into_iter()
            .collect();

            append_log_i18n(&conn, "info", "logMessages.cloudUploaded", None, Some("cloud"))?;
            write_sync_state(&SyncStateFile {
                last_sync_at: sqlite::now_iso(),
                last_direction: "upload".into(),
                last_cloud_updated_at: String::new(),
                last_cloud_version: 0,
            });
            Ok(SyncReport {
                direction: "upload".into(),
                counts,
                timestamp: sqlite::now_iso(),
                skipped: Vec::new(),
            })
        }
        "download" => {
            let (encrypted, meta) = download_packet(&cloud).await?;
            let json = crypto::decrypt(&cloud.server_key, &encrypted)?;
            let packet: CloudPacket = serde_json::from_slice(&json).map_err(|e| {
                format!("云端数据解析失败（版本不兼容或密钥不匹配）: {e}")
            })?;
            if packet.version < MIN_READABLE_VERSION || packet.version > PACKET_VERSION {
                return Err(format!(
                    "云端数据版本不兼容：本地支持 v{}-v{}，云端 v{}",
                    MIN_READABLE_VERSION, PACKET_VERSION, packet.version
                ));
            }

            let (counts, skipped) = apply_packet(&config_state, &packet, &cloud)?;
            append_log_i18n(&conn, "info", "logMessages.cloudRestored", None, Some("cloud"))?;

            // 若恢复了 settings 类目，通知前端刷新（内存态已同步更新，事件用于驱动 UI 重读）
            if cloud.sync_settings && packet.settings.is_some() {
                let _ = app.emit("cloud-config-changed", serde_json::json!({}));
            }

            write_sync_state(&SyncStateFile {
                last_sync_at: sqlite::now_iso(),
                last_direction: "download".into(),
                last_cloud_updated_at: meta.updated_at,
                last_cloud_version: meta.version,
            });
            Ok(SyncReport {
                direction: "download".into(),
                counts,
                timestamp: sqlite::now_iso(),
                skipped,
            })
        }
        "bidirectional" => {
            // 双向合并：云端包先落本地（新增优先，同 id 以云端 updated 语义为准——
            // 本地无 updated 字段，保守策略：云端有、本地无则新增；同 id 已存在则保留本地
            // 并计入跳过，避免覆盖用户在本机的最新修改），再把合并后全量上传。
            let (encrypted, meta) = download_packet(&cloud).await?;
            let json = crypto::decrypt(&cloud.server_key, &encrypted)?;
            let packet: CloudPacket = serde_json::from_slice(&json).map_err(|e| {
                format!("云端数据解析失败（版本不兼容或密钥不匹配）: {e}")
            })?;
            if packet.version < MIN_READABLE_VERSION || packet.version > PACKET_VERSION {
                return Err(format!(
                    "云端数据版本不兼容：本地支持 v{}-v{}，云端 v{}",
                    MIN_READABLE_VERSION, PACKET_VERSION, packet.version
                ));
            }
            let (mut counts, mut skipped) = merge_packet_new_only(&packet, &cloud)?;
            if cloud.sync_settings {
                if let Some(settings) = &packet.settings {
                    restore_settings(&config_state, settings)?;
                }
                counts.insert("settings".into(), 1);
            }
            append_log_i18n(&conn, "info", "logMessages.cloudMerged", None, Some("cloud"))?;

            // 合并后再全量上传，使云端与本地一致
            let merged = collect_packet(&config_state, &cloud)?;
            let json = serde_json::to_vec(&merged).map_err(|e| e.to_string())?;
            let encrypted = crypto::encrypt(&cloud.server_key, &json)?;
            upload_packet(&cloud, &encrypted).await?;

            if cloud.sync_settings && packet.settings.is_some() {
                let _ = app.emit("cloud-config-changed", serde_json::json!({}));
            }
            write_sync_state(&SyncStateFile {
                last_sync_at: sqlite::now_iso(),
                last_direction: "bidirectional".into(),
                last_cloud_updated_at: meta.updated_at,
                last_cloud_version: meta.version,
            });
            // 合并方向的计数含义：本次从云端新增到本地的条数
            let _ = &mut skipped;
            Ok(SyncReport {
                direction: "bidirectional".into(),
                counts,
                timestamp: sqlite::now_iso(),
                skipped,
            })
        }
        other => Err(format!("不支持的同步方向：{other}")),
    }
}

/// 双向合并的下载半程：只新增本地没有的条目（同 id 保留本地，计入跳过）。
fn merge_packet_new_only(
    packet: &CloudPacket,
    cloud: &crate::models::config::Cloud,
) -> Result<(HashMap<String, usize>, Vec<SyncSkipped>), String> {
    let conn = sqlite::open_connection()?;
    let mut counts = HashMap::new();
    let mut skipped: Vec<SyncSkipped> = Vec::new();
    // 双向合并的跳过记录：闭包借用冲突，改为收集 (category, id, name) 三元组后统一转换
    let mut dupes: Vec<(String, String, String)> = Vec::new();
    let mut push_dupe = |category: &str, id: &str, name: &str| {
        dupes.push((category.into(), id.into(), name.into()));
    };

    if cloud.sync_hosts {
        counts.insert("hosts".into(), merge_hosts_new_only(&conn, &packet.hosts, &mut push_dupe)?);
        counts.insert("accounts".into(), merge_accounts_new_only(&conn, &packet.accounts, &mut push_dupe)?);
        counts.insert("sftpConnections".into(), merge_sftp_new_only(&conn, &packet.sftp_connections, &mut push_dupe)?);
        counts.insert("portForwardings".into(), merge_forwardings_new_only(&conn, &packet.port_forwardings, &mut push_dupe)?);
        counts.insert("remoteConns".into(), merge_remotes_new_only(&conn, &packet.remote_conns, &mut push_dupe)?);
        counts.insert("knownHosts".into(), restore_known_hosts(&conn, &packet.known_hosts, &mut skipped)?);
        if let Some(monitor) = &packet.monitor_state {
            counts.insert("monitor".into(), restore_monitor_state(monitor, &mut skipped)?);
        }
    }
    if cloud.sync_keys {
        counts.insert("keys".into(), merge_keys_new_only(&conn, &packet.keys, &mut push_dupe)?);
        counts.insert("certificates".into(), merge_certs_new_only(&conn, &packet.certificates, &mut push_dupe)?);
    }
    if cloud.sync_snippets {
        counts.insert("snippets".into(), merge_snippets_new_only(&conn, &packet.snippets, &mut push_dupe)?);
    }
    for (category, id, name) in dupes {
        skipped.push(SyncSkipped {
            category,
            name,
            reason: format!("本地已存在（id {id}），保留本地版本"),
        });
    }
    Ok((counts, skipped))
}

fn existing_ids(conn: &rusqlite::Connection, table: &str) -> std::collections::HashSet<String> {
    conn.prepare(&format!("SELECT id FROM {table}"))
        .and_then(|mut s| {
            s.query_map([], |row| row.get(0))
                .and_then(|rows| rows.collect::<Result<Vec<String>, _>>())
        })
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn merge_hosts_new_only(
    conn: &rusqlite::Connection,
    items: &[Host],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "hosts");
    let fresh: Vec<Host> = items.iter().filter(|h| {
        let is_new = !existing.contains(&h.id);
        if !is_new {
            skip("hosts", &h.id, &h.name);
        }
        is_new
    }).cloned().collect();
    restore_hosts(conn, &fresh)
}

fn merge_accounts_new_only(
    conn: &rusqlite::Connection,
    items: &[Account],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "accounts");
    let fresh: Vec<Account> = items.iter().filter(|a| {
        let is_new = !existing.contains(&a.id);
        if !is_new {
            skip("accounts", &a.id, &a.name);
        }
        is_new
    }).cloned().collect();
    restore_accounts(conn, &fresh)
}

fn merge_sftp_new_only(
    conn: &rusqlite::Connection,
    items: &[SftpConnection],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "sftp_connections");
    let fresh: Vec<SftpConnection> = items.iter().filter(|c| {
        let is_new = !existing.contains(&c.id);
        if !is_new {
            skip("sftpConnections", &c.id, &c.name);
        }
        is_new
    }).cloned().collect();
    restore_sftp_connections(conn, &fresh)
}

fn merge_forwardings_new_only(
    conn: &rusqlite::Connection,
    items: &[PortForwarding],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "port_forwardings");
    let fresh: Vec<PortForwarding> = items.iter().filter(|r| {
        let is_new = !existing.contains(&r.id);
        if !is_new {
            skip("portForwardings", &r.id, &r.name);
        }
        is_new
    }).cloned().collect();
    restore_port_forwardings(conn, &fresh)
}

fn merge_remotes_new_only(
    conn: &rusqlite::Connection,
    items: &[crate::services::remotes::RemoteConn],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "remote_conns");
    let fresh: Vec<crate::services::remotes::RemoteConn> = items.iter().filter(|r| {
        let is_new = !existing.contains(&r.id);
        if !is_new {
            skip("remoteConns", &r.id, &r.name);
        }
        is_new
    }).cloned().collect();
    restore_remote_conns(conn, &fresh)
}

fn merge_keys_new_only(
    conn: &rusqlite::Connection,
    items: &[SyncedKey],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "keys");
    let fresh: Vec<SyncedKey> = items.iter().filter(|k| {
        let is_new = !existing.contains(&k.record.id);
        if !is_new {
            skip("keys", &k.record.id, &k.record.name);
        }
        is_new
    }).cloned().collect();
    restore_keys(conn, &fresh)
}

fn merge_certs_new_only(
    conn: &rusqlite::Connection,
    items: &[SyncedCert],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "certificates");
    let fresh: Vec<SyncedCert> = items.iter().filter(|c| {
        let is_new = !existing.contains(&c.record.id);
        if !is_new {
            skip("certificates", &c.record.id, &c.record.name);
        }
        is_new
    }).cloned().collect();
    restore_certificates(conn, &fresh)
}

fn merge_snippets_new_only(
    conn: &rusqlite::Connection,
    items: &[Snippet],
    skip: &mut impl FnMut(&str, &str, &str),
) -> Result<usize, String> {
    let existing = existing_ids(conn, "snippets");
    let fresh: Vec<Snippet> = items.iter().filter(|s| {
        let is_new = !existing.contains(&s.id);
        if !is_new {
            skip("snippets", &s.id, &s.name);
        }
        is_new
    }).cloned().collect();
    restore_snippets(conn, &fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_path_segment_encodes_unsafe_chars() {
        assert_eq!(url_encode_path_segment("abc-123._~"), "abc-123._~");
        assert_eq!(url_encode_path_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn build_base_url_handles_scheme() {
        let cloud = crate::models::config::Cloud {
            server_host: "sync.example.com".into(),
            server_port: 0,
            server_key: "my key".into(),
            ..Default::default()
        };
        // server_port 未纳入 URL（路径段鉴权方案），这里仅验证 https 默认前缀 + 编码
        let url = build_base_url(&cloud).unwrap();
        assert_eq!(url, "https://sync.example.com/my%20key");
    }
}
