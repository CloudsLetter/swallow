import { invoke } from '@tauri-apps/api/core';
import type { FileItem } from '../components/sftpPool';

export interface SshSessionConfig {
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password?: string;
  key_path?: string;
  key_id?: string;
  cert_path?: string;
  cert_id?: string;
  passphrase?: string;
}

export interface SftpSessionConfig {
  host: string;
  port: number;
  username: string;
  protocol?: string;
  auth_type: string;
  password?: string;
  key_path?: string;
  key_id?: string;
  passphrase?: string;
}

/** 连接命令返回结果：connected 或需要主机密钥确认。 */
export interface ConnectResult {
  status: 'connected' | 'needsHostKeyApproval';
  fingerprint?: string;
  host: string;
  port: number;
  /** 待确认主机密钥 token：确认时回传给 acceptHostKey（后端凭此取回完整配置，不经 IPC 往返密钥） */
  hostKeyToken?: string;
  /** 后端自建会话时返回的会话 id（监控等）；前端传 id 的命令为 undefined */
  sessionId?: string;
}

/** 建立 SSH 终端会话。 */
export function sshConnect(
  sessionId: string,
  config: SshSessionConfig,
  cols: number,
  rows: number,
): Promise<ConnectResult> {
  return invoke<ConnectResult>('ssh_connect', { sessionId, config, cols, rows });
}

/** 确认信任主机密钥并写入 known_hosts（首次连接确认后调用，凭 token 经跳板机重建连接验证）。 */
export function acceptHostKey(
  token: string,
  expectedFingerprint: string,
): Promise<void> {
  return invoke<void>('accept_host_key', { token, expectedFingerprint });
}

/** 向 SSH 会话写入输入。 */
export function sshWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>('ssh_write', { sessionId, data });
}

/** 调整 SSH PTY 尺寸。 */
export function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('ssh_resize', { sessionId, cols, rows });
}

/** 请求后端断开 SSH 会话（调用方负责捕获错误，通常 fire-and-forget）。 */
export function disconnectSsh(sessionId: string): Promise<void> {
  return invoke<void>('ssh_disconnect', { sessionId });
}

// ==================== Telnet ====================

export interface TelnetSessionConfig {
  host: string;
  port: number;
}

/** 建立 telnet 会话（无认证，明文协议）。 */
export function telnetConnect(sessionId: string, config: TelnetSessionConfig): Promise<ConnectResult> {
  return invoke<ConnectResult>('telnet_connect', { sessionId, config });
}

/** 向 telnet 会话写入输入。 */
export function telnetWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>('telnet_write', { sessionId, data });
}

/** 断开 telnet 会话。 */
export function telnetDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('telnet_disconnect', { sessionId });
}

// ==================== Local Shell (PTY) ====================

export interface LocalShellConfig {
  shell: string;
  wslDistro?: string;
}

/** 建立本地 shell 会话（cmd/powershell/pwsh/wsl/bash，PTY 伪终端）。 */
export function localShellConnect(
  sessionId: string,
  config: LocalShellConfig,
  cols: number,
  rows: number,
): Promise<ConnectResult> {
  return invoke<ConnectResult>('local_shell_connect', { sessionId, config, cols, rows });
}

/** 向本地 shell 会话写入输入。 */
export function localShellWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>('local_shell_write', { sessionId, data });
}

/** 调整本地 shell PTY 尺寸。 */
export function localShellResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('local_shell_resize', { sessionId, cols, rows });
}

/** 断开本地 shell 会话（kill 子进程）。 */
export function localShellDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('local_shell_disconnect', { sessionId });
}

/** 建立 SFTP/FTP 会话。 */
export function sftpConnect(sessionId: string, config: SftpSessionConfig): Promise<ConnectResult> {
  return invoke<ConnectResult>('sftp_connect', { sessionId, config });
}

/** 断开 SFTP/FTP 会话（重连前用于清掉死会话，避免快速路径误判已连接）。 */
export function sftpDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('sftp_disconnect', { sessionId });
}

/** 读取 SFTP 远端目录列表。 */
export function sftpListDir(sessionId: string, path: string): Promise<FileItem[]> {
  return invoke<FileItem[]>('sftp_list_dir', { sessionId, path });
}

/** 下载 SFTP 远端文件（返回原始字节数组）。 */
export function sftpDownloadFile(sessionId: string, remotePath: string): Promise<number[]> {
  return invoke<number[]>('sftp_download_file', { sessionId, remotePath });
}

/** 下载 SFTP 远端文件并直接写入本地目标路径。 */
export function sftpDownloadFileTo(
  sessionId: string,
  remotePath: string,
  targetPath: string,
): Promise<void> {
  return invoke<void>('sftp_download_file_to', { sessionId, remotePath, targetPath });
}

/** 上传文件到 SFTP 远端路径（≤100MB 单次整传；数据直接传二进制，避免 Array.from 大数组拷贝）。 */
export function sftpUploadFile(
  sessionId: string,
  localData: Uint8Array,
  remotePath: string,
): Promise<void> {
  return invoke<void>('sftp_upload_file', {
    sessionId,
    localData,
    remotePath,
  });
}

/**
 * 后端直读本地文件流式上传（绕开大文件 IPC 序列化开销，速度接近下载）。
 * WebView2 的 File 对象带 path 时前端走此通道；进度经 'sftp-transfer' 事件上报。
 */
export function sftpUploadLocal(
  sessionId: string,
  localPath: string,
  remotePath: string,
  cancelToken?: string,
): Promise<void> {
  return invoke<void>('sftp_upload_local', { sessionId, localPath, remotePath, cancelToken });
}

/**
 * 分块上传：truncate=true 覆盖创建（首块），false 追加到文件末尾。
 * 前端按块读取本地文件调用，实现非阻塞传输与进度展示。
 */
export function sftpUploadChunk(
  sessionId: string,
  remotePath: string,
  data: Uint8Array,
  truncate: boolean,
): Promise<void> {
  return invoke<void>('sftp_upload_chunk', { sessionId, remotePath, data, truncate });
}

/**
 * 流式下载并写入本地目标路径：后端分块读取并推进度事件 `sftp-transfer`，
 * 事件载荷 { sessionId, remotePath, done, total }。
 * offset 用于断点续传：非 0 时从远端该字节处继续，本地文件追加写入。
 * cancelToken 可选：用于「结束任务」时中断下载。
 */
export function sftpDownloadFileProgress(
  sessionId: string,
  remotePath: string,
  targetPath: string,
  offset = 0,
  cancelToken?: string,
): Promise<void> {
  return invoke<void>('sftp_download_file_progress', {
    sessionId,
    remotePath,
    targetPath,
    offset,
    cancelToken,
  });
}

/** 取消进行中的下载（置位后端取消标志）。 */
export function sftpCancelTransfer(cancelToken: string): Promise<void> {
  return invoke<void>('sftp_cancel_transfer', { cancelToken });
}

/** 删除 SFTP 远端文件。 */
export function sftpDeleteFile(sessionId: string, remotePath: string): Promise<void> {
  return invoke<void>('sftp_delete_file', { sessionId, remotePath });
}

/** 删除 SFTP 远端目录。 */
export function sftpDeleteDir(sessionId: string, remotePath: string): Promise<void> {
  return invoke<void>('sftp_delete_dir', { sessionId, remotePath });
}

/** 递归删除 SFTP 远端目录（含所有子文件和子目录）。 */
export function sftpRemoveDirRecursive(sessionId: string, remotePath: string): Promise<void> {
  return invoke<void>('sftp_remove_dir_recursive', { sessionId, remotePath });
}

/** 修改 SFTP 远端文件/目录权限（mode 为八进制，如 0o755）。 */
export function sftpChmod(sessionId: string, remotePath: string, mode: number): Promise<void> {
  return invoke<void>('sftp_chmod', { sessionId, remotePath, mode });
}

/** 递归搜索远端文件名（大小写不敏感），返回匹配的完整路径列表。 */
export function sftpSearchFiles(sessionId: string, rootPath: string, query: string): Promise<string[]> {
  return invoke<string[]>('sftp_search_files', { sessionId, rootPath, query });
}

/** 创建 SFTP 远端目录。 */
export function sftpCreateDir(sessionId: string, remotePath: string): Promise<void> {
  return invoke<void>('sftp_create_dir', { sessionId, remotePath });
}

/** 重命名 SFTP 远端文件或目录。 */
export function sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  return invoke<void>('sftp_rename', { sessionId, oldPath, newPath });
}

/** 请求后端断开 SFTP/FTP 会话。 */
export function disconnectSftp(sessionId: string): Promise<void> {
  return invoke<void>('sftp_disconnect', { sessionId });
}

/** 查询本地文件大小（字节），不存在返回 0。用于下载断点续传判断。 */
export function localFileSize(path: string): Promise<number> {
  return invoke<number>('local_file_size', { path });
}

// ==================== Serial (COM/tty) ====================

export interface SerialSessionConfig {
  port: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'odd' | 'even';
  flowControl?: 'none' | 'hardware';
}

/** 枚举本机可用串口（Windows COM* / POSIX /dev/tty*）。 */
export function serialListPorts(): Promise<string[]> {
  return invoke<string[]>('serial_list_ports');
}

/** 打开串口会话（无认证；端口/波特率/校验等由 config 携带）。 */
export function serialConnect(
  sessionId: string,
  config: SerialSessionConfig,
): Promise<ConnectResult> {
  return invoke<ConnectResult>('serial_connect', { sessionId, config });
}

/** 向串口写入输入。 */
export function serialWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>('serial_write', { sessionId, data });
}

/** 断开串口会话（幂等；重连前清死会话）。 */
export function serialDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('serial_disconnect', { sessionId });
}

// ==================== VNC ====================

/** SSH 隧道传输配置（经 SSH 访问内网 VNC 服务）。 */
export interface VncSshTransportConfig {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshAuthType: string;
  sshPassword?: string;
  sshKeyId?: string;
  sshKeyPath?: string;
  sshPassphrase?: string;
  targetHost: string;
  targetPort: number;
}

export interface VncSessionConfig {
  host: string;
  port: number;
  password?: string;
  shared?: boolean;
  ssh?: VncSshTransportConfig;
}

export interface VncConnectResult {
  sessionId: string;
  /** 本地 WebSocket 地址；SSH 主机密钥待确认时为 undefined */
  wsUrl?: string;
  /** 待确认主机信息（hostKeyToken 非空时） */
  host?: string;
  port?: number;
  fingerprint?: string;
  hostKeyToken?: string;
}

/** 建立 VNC 会话：Rust 侧起本地 loopback WebSocket<->TCP 桥，返回 ws 地址。 */
export function vncConnect(
  sessionId: string,
  config: VncSessionConfig,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>('vnc_connect', {
    request: { sessionId, ...config },
  });
}

/** 断开 VNC 会话（幂等）。 */
export function vncDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('vnc_disconnect', { sessionId });
}

/** 列出当前 VNC 会话 id。 */
export function vncListSessions(): Promise<string[]> {
  return invoke<string[]>('vnc_list_sessions');
}
