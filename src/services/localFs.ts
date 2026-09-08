import { invoke } from '@tauri-apps/api/core';

export interface LocalFsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface LocalDirListing {
  path: string;
  parent: string | null;
  entries: LocalFsEntry[];
}

/** 栏间拖拽数据 MIME（应用内 HTML5 DnD，与系统拖拽通道区分）。 */
export const MIME_LOCAL = 'application/x-swallow-local';
export const MIME_REMOTE = 'application/x-swallow-remote';
/** 左栏为「另一台主机」时，其文件行拖拽携带的远端路径 */
export const MIME_LEFT_REMOTE = 'application/x-swallow-left-remote';

/** 列出本机目录（path 为空时返回盘符/根视图）。 */
export function listLocalDirectory(path: string): Promise<LocalDirListing> {
  return invoke<LocalDirListing>('list_local_directory', { path });
}
