use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub account_id: Option<String>,
    pub username: String,
    pub status: String,
    pub last_connected: Option<String>,
    pub auth_type: Option<String>,
    pub password: Option<String>,
    pub key_id: Option<String>,
    pub certificate_id: Option<String>,
    pub use_proxy: Option<bool>,
    pub proxy_host_id: Option<String>,
    pub proxy_auth_type: Option<String>,
    pub proxy_key_id: Option<String>,
    pub proxy_cert_id: Option<String>,
    pub proxy_host: Option<String>,
    pub proxy_port: Option<u16>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_id: Option<String>,
    pub certificate_id: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
    pub last_used: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: String,
    pub fingerprint: String,
    pub created_at: String,
    pub size: u32,
    pub key_path: Option<String>,
    pub public_key_path: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateKeyPairRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: String,
    pub size: u32,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportKeyRequest {
    pub name: String,
    pub private_key_base64: Option<String>,
    pub public_key_base64: Option<String>,
    pub private_file_name: Option<String>,
    pub public_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportedKeyFile {
    pub file_name: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportKeyTextRequest {
    pub name: String,
    pub private_key: Option<String>,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyContent {
    pub public_key: Option<String>,
    pub private_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CertificateRecord {
    pub id: String,
    pub name: String,
    /// 证书类型：user | host
    pub cert_type: String,
    /// 底层密钥类型：RSA | ED25519 | ECDSA
    #[serde(rename = "type")]
    pub key_type: String,
    pub fingerprint: String,
    pub created_at: String,
    /// OpenSSH 证书文件（-cert.pub），旧版本字段，内容已入 DB 后置空
    pub cert_path: Option<String>,
    /// 配套私钥文件，旧版本字段，内容已入 DB 后置空
    pub private_key_path: Option<String>,
    /// 是否已绑定配套私钥（由 private_key_content 推导，供前端判断能否用于 SSH 认证）
    pub has_private_key: bool,
    pub principals: Vec<String>,
    pub valid_after: Option<String>,
    pub valid_before: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CertContent {
    pub cert_content: Option<String>,
    pub private_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportCertRequest {
    pub name: String,
    pub cert_base64: String,
    pub cert_file_name: Option<String>,
    pub private_key_base64: Option<String>,
    pub private_key_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    /// 关联的密钥库密钥 ID（优先于 key_path）
    pub key_id: Option<String>,
    pub remote_path: String,
    pub last_accessed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub category: String,
    pub tags: Option<Vec<String>>,
    pub created_at: String,
    pub last_used: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub source: Option<String>,
    /// i18n 消息 key（日志消息参数化翻译）；None = 传统 message 原文
    pub log_key: Option<String>,
    /// i18n 参数（JSON 字符串，如 {"name":"xx"}）
    pub params: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub level: Option<String>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub id: String,
    pub host: String,
    pub key_type: String,
    pub fingerprint: String,
    pub last_used: String,
    pub added_date: String,
    /// known_hosts 文件中的原始条目（含主机名、算法、公钥 base64），供详情抽屉展示
    pub raw_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortForwarding {
    pub id: String,
    pub name: String,
    /// 规则类型：local | remote | dynamic
    #[serde(rename = "type")]
    pub rule_type: String,
    /// 关联的 SSH 主机 ID（用于建立隧道的跳转主机）
    pub host_id: Option<String>,
    /// 监听地址，默认 127.0.0.1
    pub listen_host: String,
    pub listen_port: u32,
    /// 目标主机（local/remote 转发用，dynamic 转发可省略）
    pub target_host: Option<String>,
    pub target_port: u32,
    /// 连接状态：connected | disconnected | error。实际状态由 list 按内存隧道派生，不落库。
    #[serde(default)]
    pub status: String,
    pub description: Option<String>,
    pub created_at: String,
    pub last_used: Option<String>,
    /// SOCKS5 代理认证用户名（dynamic 转发可选；配置后启用 RFC 1929 认证）
    pub socks_username: Option<String>,
    /// SOCKS5 代理认证密码（存系统密钥链，DB 列仅占位，不返回前端）
    pub socks_password: Option<String>,
}
