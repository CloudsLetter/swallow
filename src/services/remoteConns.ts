import { invoke } from '@tauri-apps/api/core';

/** 桌面连接（VNC/RDP）会话簿条目。 */
export interface RemoteConn {
  id: string;
  name: string;
  protocol: 'vnc' | 'rdp';
  host: string;
  port: number;
  /** RDP 用户名 */
  username?: string;
  /** VNC 密码 / RDP 密码（VNC 经 SSH 隧道时也在此） */
  password?: string;
  /** VNC 经 SSH 隧道：跳板主机 id（复用该主机已存认证） */
  jumpHostId?: string;
  created: string;
}

export function listRemoteConns(): Promise<RemoteConn[]> {
  return invoke<RemoteConn[]>('list_remote_conns');
}

export function saveRemoteConn(conn: RemoteConn): Promise<RemoteConn> {
  return invoke<RemoteConn>('save_remote_conn', { connItem: conn });
}

export function deleteRemoteConn(id: string): Promise<void> {
  return invoke<void>('delete_remote_conn', { id });
}
