import { invoke } from '@tauri-apps/api/core';

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  accountId?: string;
  username: string;
  status: 'connected' | 'disconnected' | 'error';
  lastConnected?: string;
  authType?: 'password' | 'key' | 'certificate' | 'none';
  password?: string;
  keyId?: string;
  certificateId?: string;
  useProxy?: boolean;
  proxyHostId?: string;
  proxyAuthType?: 'password' | 'key' | 'certificate' | 'none';
  proxyKeyId?: string;
  proxyCertId?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

export interface Account {
  id: string;
  name: string;
  username: string;
  authType: 'password' | 'key' | 'certificate';
  password?: string;
  keyId?: string;
  certificateId?: string;
  description?: string;
  createdAt: string;
  lastUsed?: string;
  tags?: string[];
}

export interface Key {
  id: string;
  name: string;
  type: 'RSA' | 'ED25519' | 'ECDSA';
  fingerprint: string;
  createdAt: string;
  size: number;
  keyPath?: string;
  publicKeyPath?: string;
  source?: string;
}

export interface SftpConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'ftp' | 'sftp';
  username: string;
  authType: 'password' | 'publickey';
  password?: string;
  keyPath?: string;
  passphrase?: string;
  keyId?: string;
  remotePath: string;
  lastAccessed?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  /** i18n 消息 key（参数化日志）；有值时优先用 t(logKey, params) 渲染 */
  logKey?: string;
  /** i18n 参数（JSON 字符串，如 {"name":"xx"}） */
  params?: string;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  category: string;
  tags?: string[];
  createdAt: string;
  lastUsed?: string;
}

export interface KnownHost {
  id: string;
  host: string;
  keyType: string;
  fingerprint: string;
  lastUsed: string;
  addedDate: string;
  /** known_hosts 文件中的原始条目（含主机名、算法、公钥 base64） */
  rawLine: string;
}

export interface PortForwarding {
  id: string;
  name: string;
  /** 规则类型：local | remote | dynamic */
  type: 'local' | 'remote' | 'dynamic';
  /** 关联的 SSH 主机 ID（用于建立隧道的跳转主机） */
  hostId?: string;
  /** 监听地址，默认 127.0.0.1 */
  listenHost: string;
  listenPort: number;
  /** 目标主机（local/remote 转发用，dynamic 转发可省略） */
  targetHost?: string;
  targetPort: number;
  status: 'connected' | 'disconnected' | 'error';
  description?: string;
  createdAt: string;
  lastUsed?: string;
  /** SOCKS5 代理认证用户名（dynamic 转发可选，配置后启用 RFC 1929 认证） */
  socksUsername?: string;
  /** SOCKS5 代理认证密码（dynamic 转发可选，编辑回填用） */
  socksPassword?: string;
}

export interface CreateKeyPairRequest {
  name: string;
  type: 'RSA' | 'ED25519' | 'ECDSA';
  size: number;
  passphrase?: string;
}

export interface ImportKeyRequest {
  name: string;
  privateKeyBase64?: string;
  publicKeyBase64?: string;
  privateFileName?: string;
  publicFileName?: string;
}

export interface ImportKeyTextRequest {
  name: string;
  privateKey?: string;
  publicKey?: string;
}

export interface KeyContent {
  publicKey?: string;
  privateKey?: string;
}

export interface CertContent {
  certContent?: string;
  privateKey?: string;
}

export interface ExportedKeyFile {
  fileName: string;
  contentBase64: string;
}

export interface Certificate {
  id: string;
  name: string;
  certType: 'user' | 'host';
  type: 'RSA' | 'ED25519' | 'ECDSA' | string;
  fingerprint: string;
  createdAt: string;
  certPath?: string;
  privateKeyPath?: string;
  /** 是否已绑定配套私钥（内容存数据库，此标志用于判断能否用于 SSH 认证） */
  hasPrivateKey?: boolean;
  principals: string[];
  validAfter?: string;
  validBefore?: string;
  source?: string;
}

export interface ImportCertRequest {
  name: string;
  certBase64: string;
  certFileName?: string;
  privateKeyBase64?: string;
  privateKeyFileName?: string;
}

type LogFilter = {
  level?: string;
  search?: string;
};

async function findById<T extends { id: string }>(
  listFn: () => Promise<T[]>,
  id: string,
  label: string,
): Promise<T> {
  const items = await listFn();
  const found = items.find((item) => item.id === id);
  if (!found) {
    throw new Error(`${label} not found`);
  }
  return found;
}

export async function getHosts(): Promise<Host[]> {
  return invoke<Host[]>('list_hosts');
}

export async function addHost(host: Omit<Host, 'id'>): Promise<Host> {
  return invoke<Host>('save_host', { host: { ...host, id: '' } });
}

export async function removeHost(id: string): Promise<void> {
  await invoke('delete_host', { id });
}

/** 连接成功后回写最近连接时间（供「最近连接」排序显示）。 */
export async function touchHostLastConnected(host: string, port: number): Promise<void> {
  await invoke('touch_host_last_connected', { host, port });
}

export async function updateHost(id: string, updates: Partial<Host>): Promise<Host> {
  const current = await findById(getHosts, id, 'Host');
  return invoke<Host>('save_host', { host: { ...current, ...updates, id } });
}

export async function getKeys(): Promise<Key[]> {
  return invoke<Key[]>('list_keys');
}

export async function addKey(key: Omit<Key, 'id'>): Promise<Key> {
  return invoke<Key>('save_key', {
    key: {
      ...key,
      id: '',
    },
  });
}

export async function removeKey(id: string): Promise<void> {
  await invoke('delete_key', { id });
}

export async function createKeyPair(request: CreateKeyPairRequest): Promise<Key> {
  return invoke<Key>('create_key_pair', { request });
}

export async function importKeyFile(request: ImportKeyRequest): Promise<Key> {
  return invoke<Key>('import_key_file', { request });
}

export async function importKeyText(request: ImportKeyTextRequest): Promise<Key> {
  return invoke<Key>('import_key_text', { request });
}

export async function readKeyContent(id: string): Promise<KeyContent> {
  return invoke<KeyContent>('read_key_content', { id });
}

export async function exportKeyFile(id: string): Promise<ExportedKeyFile> {
  return invoke<ExportedKeyFile>('export_key_file', { id });
}

export async function exportKeyFileTo(id: string, targetPath: string): Promise<void> {
  await invoke('export_key_file_to', { id, targetPath });
}

export async function getCertificates(): Promise<Certificate[]> {
  return invoke<Certificate[]>('list_certificates');
}

export async function importCertificate(request: ImportCertRequest): Promise<Certificate> {
  return invoke<Certificate>('import_certificate', { request });
}

export async function removeCertificate(id: string): Promise<void> {
  await invoke('delete_certificate', { id });
}

export async function exportCertificateFile(id: string): Promise<ExportedKeyFile> {
  return invoke<ExportedKeyFile>('export_certificate', { id });
}

export async function exportCertificateFileTo(id: string, targetPath: string): Promise<void> {
  await invoke('export_certificate_file_to', { id, targetPath });
}

export async function readCertificateContent(id: string): Promise<CertContent> {
  return invoke<CertContent>('read_cert_content', { id });
}

export async function getAccounts(): Promise<Account[]> {
  return invoke<Account[]>('list_accounts');
}

export async function addAccount(account: Omit<Account, 'id' | 'createdAt'>): Promise<Account> {
  return invoke<Account>('save_account', {
    account: {
      ...account,
      id: '',
      createdAt: new Date().toISOString(),
    },
  });
}

export async function removeAccount(id: string): Promise<void> {
  await invoke('delete_account', { id });
}

export async function updateAccount(id: string, updates: Partial<Account>): Promise<Account> {
  const current = await findById(getAccounts, id, 'Account');
  return invoke<Account>('save_account', { account: { ...current, ...updates, id } });
}

export async function getSftp(): Promise<SftpConnection[]> {
  return invoke<SftpConnection[]>('list_sftp_connections');
}

export async function addSftpConnection(conn: Omit<SftpConnection, 'id'>): Promise<SftpConnection> {
  return invoke<SftpConnection>('save_sftp_connection', {
    connection: {
      ...conn,
      id: '',
    },
  });
}

/** 保存 SFTP/FTP 连接（后端 upsert：带 id 更新，id 为空新建）。 */
export async function saveSftpConnection(
  conn: Omit<SftpConnection, 'id'> & { id?: string },
): Promise<SftpConnection> {
  return invoke<SftpConnection>('save_sftp_connection', {
    connection: {
      ...conn,
      id: conn.id || '',
    },
  });
}

export async function removeSftpConnection(id: string): Promise<void> {
  await invoke('delete_sftp_connection', { id });
}

export async function testSftpConnection(id: string): Promise<boolean> {
  return invoke<boolean>('test_sftp_connection', { id });
}

export async function getSnippets(): Promise<Snippet[]> {
  return invoke<Snippet[]>('list_snippets');
}

export async function addSnippet(snippet: Omit<Snippet, 'id' | 'createdAt'>): Promise<Snippet> {
  return invoke<Snippet>('save_snippet', {
    snippet: {
      ...snippet,
      id: '',
      createdAt: new Date().toISOString(),
    },
  });
}

export async function updateSnippet(id: string, updates: Partial<Snippet>): Promise<Snippet> {
  const current = await findById(getSnippets, id, 'Snippet');
  return invoke<Snippet>('save_snippet', { snippet: { ...current, ...updates, id } });
}

export async function removeSnippet(id: string): Promise<void> {
  await invoke('delete_snippet', { id });
}

export async function useSnippet(id: string): Promise<Snippet> {
  return invoke<Snippet>('mark_snippet_used', { id });
}

export async function getLogs(filter?: LogFilter): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('list_logs', { filter });
}

export async function clearLogs(): Promise<void> {
  await invoke('clear_logs');
}

export async function getKnownHosts(): Promise<KnownHost[]> {
  return invoke<KnownHost[]>('list_known_hosts');
}

export async function refreshKnownHosts(): Promise<KnownHost[]> {
  return invoke<KnownHost[]>('refresh_known_hosts');
}

export async function removeKnownHost(id: string): Promise<void> {
  await invoke('delete_known_host', { id });
}

export async function clearKnownHosts(): Promise<void> {
  await invoke('clear_known_hosts');
}

export async function exportKnownHosts(): Promise<string> {
  return invoke<string>('export_known_hosts');
}

export async function exportKnownHostsTo(targetPath: string): Promise<void> {
  await invoke('export_known_hosts_to', { targetPath });
}

// ==================== 端口转发规则 ====================

export async function getPortForwardings(): Promise<PortForwarding[]> {
  return invoke<PortForwarding[]>('list_port_forwardings');
}

export async function addPortForwarding(
  rule: Omit<PortForwarding, 'id' | 'createdAt' | 'status'>,
): Promise<PortForwarding> {
  return invoke<PortForwarding>('save_port_forwarding', {
    rule: {
      ...rule,
      id: '',
      createdAt: new Date().toISOString(),
    },
  });
}

export async function updatePortForwarding(
  id: string,
  updates: Partial<PortForwarding>,
): Promise<PortForwarding> {
  const current = await findById(getPortForwardings, id, 'PortForwarding');
  return invoke<PortForwarding>('save_port_forwarding', {
    rule: { ...current, ...updates, id },
  });
}

export async function removePortForwarding(id: string): Promise<void> {
  await invoke('delete_port_forwarding', { id });
}

/** 测试转发目标的 TCP 连通性（验证目标可达，不建立 SSH 隧道）。 */
export async function testPortForwardTarget(
  targetHost: string,
  targetPort: number,
): Promise<boolean> {
  return invoke<boolean>('test_port_forward_target', { targetHost, targetPort });
}

/** 建立/断开端口转发隧道命令的返回结果。 */
export interface PortForwardConnectResult {
  status: 'connected' | 'needsHostKeyApproval';
  fingerprint?: string;
  host: string;
  port: number;
  /** 待确认主机密钥 token：确认时回传给 acceptHostKey */
  hostKeyToken?: string;
}

/** 建立端口转发隧道（按规则关联的 SSH 主机连接并启动转发）。 */
export async function startPortForward(ruleId: string): Promise<PortForwardConnectResult> {
  return invoke<PortForwardConnectResult>('start_port_forward', { ruleId });
}

/** 断开端口转发隧道。 */
export async function stopPortForward(ruleId: string): Promise<void> {
  await invoke('stop_port_forward', { ruleId });
}

/** 返回当前处于运行状态的隧道规则 ID 列表。 */
export async function listActivePortForwards(): Promise<string[]> {
  return invoke<string[]>('list_active_port_forwards');
}

// ==================== 云同步 ====================

/** 云同步结果统计。 */
export interface SyncReport {
  /** 本次同步动作：upload | download */
  direction: 'upload' | 'download';
  /** 各类目同步条数（key 为类目名，如 hosts/accounts/keys/snippets） */
  counts: Record<string, number>;
  /** 同步时间（RFC3339） */
  timestamp: string;
}

/** 立即执行一次云同步。direction: "upload" 上传本地数据；"download" 从云端恢复。 */
export async function cloudSyncNow(direction: 'upload' | 'download'): Promise<SyncReport> {
  return invoke<SyncReport>('cloud_sync_now', { direction });
}

// ==================== 会话持久化 ====================

/** 保存打开的标签会话（JSON 字符串，由前端序列化，密码/passphrase 已剔除）。 */
export async function saveOpenSessions(data: string): Promise<void> {
  return invoke<void>('save_open_sessions', { data });
}

/** 读取上次保存的标签会话（JSON 字符串）。 */
export async function loadOpenSessions(): Promise<string> {
  return invoke<string>('load_open_sessions');
}
