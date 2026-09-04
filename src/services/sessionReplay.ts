import { invoke } from '@tauri-apps/api/core';

export interface SessionReplayEvent {
  at: number;
  direction: 'input' | 'output';
  data: string;
}

export interface SessionReplaySnapshot {
  at: number;
  data: string;
}

export interface SessionReplayData {
  label: string;
  startedAt?: string;
  events: SessionReplayEvent[];
  snapshots: SessionReplaySnapshot[];
  duration: number;
}

function legacyLabel(path: string): string {
  const name = path.split(/[\\/]/).pop() || 'Session log';
  return name.replace(/\.(?:replay\.)?jsonl$|\.log$/i, '') || 'Session log';
}

function readLegacySessionLog(content: string, path: string): SessionReplayData {
  if (!content.trim()) throw new Error('Empty session log');
  const label = content.match(/(?:会话|Session):\s*(.+)/)?.[1]?.trim() || legacyLabel(path);
  return {
    label,
    events: [{ at: 0, direction: 'output', data: content }],
    snapshots: [],
    duration: 0,
  };
}

/** 读取并校验 Swallow replay JSONL；回放只消费 output，不会执行 input。 */
export async function readSessionReplay(path: string): Promise<SessionReplayData> {
  const content = await invoke<string>('session_log_read', { path });
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error('Empty session log');

  let firstRecord: Record<string, unknown>;
  try {
    firstRecord = JSON.parse(lines[0]) as Record<string, unknown>;
  } catch {
    // 兼容早期的带时间戳 .log：作为静态输出打开，不伪造输入事件。
    return readLegacySessionLog(content, path);
  }

  const meta = firstRecord;
  if (
    !meta ||
    meta.type !== 'swallow-replay' ||
    meta.version !== 1
  ) {
    throw new Error('Not a supported Swallow replay file');
  }

  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid replay record at line ${index + 1}`);
    }
  });

  const events = records
    .slice(1)
    .filter((record) => record.type === 'event')
    .map((record, index): SessionReplayEvent => {
      const at = typeof record.at === 'number' ? record.at : Number(record.at);
      const direction = record.direction;
      if (
        !Number.isFinite(at) ||
        at < 0 ||
        (direction !== 'input' && direction !== 'output') ||
        typeof record.data !== 'string'
      ) {
        throw new Error(`Invalid replay event at record ${index + 2}`);
      }
      return { at, direction, data: record.data };
    })
    .sort((a, b) => a.at - b.at);

  const snapshots = records
    .filter((record) => record.type === 'snapshot')
    .map((record, index): SessionReplaySnapshot => {
      const at = typeof record.at === 'number' ? record.at : Number(record.at);
      if (!Number.isFinite(at) || at < 0 || typeof record.data !== 'string') {
        throw new Error(`Invalid replay snapshot at record ${index + 1}`);
      }
      return { at, data: record.data };
    })
    .sort((a, b) => a.at - b.at);

  return {
    label: typeof meta.label === 'string' ? meta.label : '',
    startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : undefined,
    events,
    snapshots,
    duration: events.reduce((max, event) => Math.max(max, event.at), 0),
  };
}
