import { invoke } from '@tauri-apps/api/core';

/** 会话日志文件元数据（session_log_list 返回，camelCase 已映射）。 */
export interface SessionLogFile {
  path: string;
  name: string;
  /** 'replay' = .replay.jsonl 时间轴回放；'plain' = .log 纯文本/ANSI */
  kind: 'plain' | 'replay';
  size: number;
  modified: number;
}

/** 枚举会话日志目录（按修改时间倒序，缺目录返回空）。 */
export function listSessionLogs(directory: string): Promise<SessionLogFile[]> {
  return invoke<SessionLogFile[]>('session_log_list', { directory });
}

/** 读取单个会话日志文件全文。 */
export function readSessionLog(path: string): Promise<string> {
  return invoke<string>('session_log_read', { path });
}
