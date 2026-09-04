import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { cleanTerminalText, logTimestamp } from '../lib/ansiClean';

export type SessionLogFormat = 'plain' | 'ansi-vt' | 'replay';

/**
 * 会话日志记录（对标 Xshell「记录日志」）：
 * 把 SSH 会话的内容落盘成 .log 文件，或写成可回放的 .replay.jsonl 文件。
 *
 * 数据流分工：
 * - terminalPool（输出汇聚点 attachListeners / 输入汇聚点 enqueueWriteToTargets）
 *   把原始 VT 数据喂给本模块的 appendOutput / appendInput；
 * - 本模块按设置格式化为 `[时间] 内容` 或带相对时间的 JSONL 事件 → 追加进内存缓冲 → 500ms 节流批量调后端 append；
 * - 后端（services/session_log.rs）负责真实落盘 + 会话登记。
 *
 * 录制状态是「会话级」状态（keyed by sessionId，存模块级），跨组件实例保持有效。
 *
 * 输出格式约定（可读性优先）：
 *   - 普通日志只记录终端输出，每个非空输出行以 `[HH:MM:SS] ` 开头；plain 清洗控制序列，ansi-vt 保留输出中的控制序列；
 *   ⚠️ 输入可能含密码等敏感内容（sudo 等不回显场景），记录前用户需知晓（对标 Xshell 行为）。
 */

interface SessionLog {
  /** 自动生成的落盘路径。 */
  path: string;
  /** 输出格式：plain 清洗控制序列，ansi-vt 保留原始 VT 数据。 */
  format: SessionLogFormat;
  /** 回放格式的会话起始时间，用于计算事件相对时间。 */
  startedAtMs: number;
  /** 待刷盘的缓冲（清洗后文本）。 */
  buf: string;
  /** 输出是否位于新行起点，用于为每行添加时间前缀。 */
  outputAtLineStart: boolean;
  /** 节流定时器（500ms 无新内容则刷盘）。 */
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 当前串行刷盘链（防止并发 append 交错）。 */
  flushing: Promise<void>;
  /** 上一次写入 xterm 状态快照的时间，仅 replay 格式使用。 */
  lastSnapshotAtMs: number;
}

const sessionLogs = new Map<string, SessionLog>();

/** 单条 flush 的落盘阈值：超过 64KB 立即刷，不等 500ms（大输出流不积压）。 */
const FLUSH_BATCH_BYTES = 64 * 1024;
/** 无新内容静默 500ms 后强制刷盘。 */
const FLUSH_IDLE_MS = 500;
/** replay 文件每秒最多写入一个 xterm 状态快照，避免重复保存整屏缓冲。 */
const REPLAY_SNAPSHOT_INTERVAL_MS = 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 会话开始时间（完整时间戳，写入文件头）。 */
function fullTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${logTimestamp(d)}`;
}

/** 清洗 + 换行规约：\r\n→\n，孤立 \r→\n（进度条覆盖段成独立行）。 */
function cleanAndNormalize(data: string): string {
  return cleanTerminalText(data)
    // SSH 常见的 \r\r\n 只应落成一个换行，避免日志凭空出现空行。
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * 把输出按行写成 `[时间] 内容`。
 * ansi-vt 模式只在行首插入时间，不改动其余 ANSI/VT 控制序列；
 * plain 模式传入的文本已经清洗并把回车规约成换行。
 */
function appendTimedOutput(log: SessionLog, data: string) {
  for (let i = 0; i < data.length; i += 1) {
    // 空行不写入无意义的 [时间] 前缀，只保留换行本身。
    if (log.outputAtLineStart && data[i] === '\n') {
      log.buf += '\n';
      continue;
    }
    if (log.outputAtLineStart) {
      log.buf += `[${logTimestamp()}] `;
      log.outputAtLineStart = false;
    }
    const char = data[i];
    log.buf += char;
    if (char === '\n') log.outputAtLineStart = true;
  }
}

function appendReplayEvent(log: SessionLog, direction: 'input' | 'output', data: string) {
  log.buf += `${JSON.stringify({
    type: 'event',
    at: Math.max(0, Date.now() - log.startedAtMs),
    direction,
    data,
  })}\n`;
}

/** 写入由 xterm + SerializeAddon 生成的终端状态快照，用于时间轴快速定位。 */
export function appendReplaySnapshot(sessionId: string, serialized: string) {
  const log = getLog(sessionId);
  if (!log || log.format !== 'replay' || !serialized) return;
  const now = Date.now();
  if (now - log.lastSnapshotAtMs < REPLAY_SNAPSHOT_INTERVAL_MS) return;
  log.lastSnapshotAtMs = now;
  log.buf += `${JSON.stringify({
    type: 'snapshot',
    at: Math.max(0, now - log.startedAtMs),
    data: serialized,
  })}\n`;
  if (log.buf.length >= FLUSH_BATCH_BYTES) enqueueFlush(sessionId, log);
  else scheduleFlush(sessionId, log);
}

function getLog(sessionId: string): SessionLog | undefined {
  return sessionLogs.get(sessionId);
}

/** 是否有会话正在记录日志。 */
export function isSessionLogging(sessionId: string): boolean {
  return sessionLogs.has(sessionId);
}

/** 串行追加一次落盘（同一会话的 append 按序执行，后端同文件不会交错）。 */
function enqueueFlush(sessionId: string, log: SessionLog) {
  log.flushing = log.flushing
    .catch(() => {})
    .then(async () => {
      if (!log.buf) return;
      const chunk = log.buf;
      log.buf = '';
      try {
        await invoke('session_log_append', { sessionId, content: chunk });
      } catch (e) {
        // 落盘失败（文件被删/权限）：丢弃本批并告警，避免无限重试
        console.warn(`[session-log] ${sessionId} append failed, chunk dropped:`, e);
      }
    });
}

function scheduleFlush(sessionId: string, log: SessionLog) {
  if (log.flushTimer) clearTimeout(log.flushTimer);
  log.flushTimer = setTimeout(() => {
    log.flushTimer = undefined;
    enqueueFlush(sessionId, log);
  }, FLUSH_IDLE_MS);
}

/** 输出追加（terminalPool 输出事件喂入）。 */
export function appendOutput(sessionId: string, data: string) {
  const log = getLog(sessionId);
  if (!log) return;
  if (log.format === 'replay') {
    appendReplayEvent(log, 'output', data);
  } else {
    const output = log.format === 'plain' ? cleanAndNormalize(data) : data;
    appendTimedOutput(log, output);
  }
  if (log.buf.length >= FLUSH_BATCH_BYTES) {
    enqueueFlush(sessionId, log);
  } else {
    scheduleFlush(sessionId, log);
  }
}

/** 输入追加：普通日志不重复记录 SSH 回显，replay 格式保留输入事件但回放时不执行。 */
export function appendInput(sessionId: string, data: string) {
  const log = getLog(sessionId);
  if (!log) return;
  if (log.format === 'replay') {
    appendReplayEvent(log, 'input', data);
    if (log.buf.length >= FLUSH_BATCH_BYTES) enqueueFlush(sessionId, log);
    else scheduleFlush(sessionId, log);
    return;
  }
  // 普通日志以终端输出为准：SSH 开启回显时输入已经包含在输出里，
  // 再写一份会造成 in: 重复；无回显输入仅在 replay 事件里保留。
}

/** 开始记录：后端登记 + 写文件头。label 用于文件头标识（主机名/用户名等）。 */
export async function startSessionLog(
  sessionId: string,
  path: string,
  label: string,
  format: SessionLogFormat = 'plain',
): Promise<void> {
  if (sessionLogs.has(sessionId)) return; // 幂等
  const startedAtMs = Date.now();
  const startedAt = logTimestamp();
  const header = format === 'replay'
    ? `${JSON.stringify({
        type: 'swallow-replay',
        version: 1,
        startedAt: new Date(startedAtMs).toISOString(),
        label,
      })}\n`
    : `[${startedAt}] ===== Swallow 会话日志 =====\n` +
      `[${startedAt}] 时间: ${fullTimestamp()}\n` +
      (label ? `[${startedAt}] 会话: ${label}\n` : '') +
      `[${startedAt}] =============================\n`;
  await invoke('session_log_start', { sessionId, path, header });
  const log: SessionLog = {
    path,
    format,
    startedAtMs,
    buf: '',
    outputAtLineStart: true,
    flushTimer: undefined,
    flushing: Promise.resolve(),
    lastSnapshotAtMs: -Infinity,
  };
  sessionLogs.set(sessionId, log);
}

/** 生成自动记录使用的日志文件路径，不弹出保存对话框。 */
export async function createSessionLogPath(
  directory: string,
  label: string,
  format: SessionLogFormat = 'plain',
): Promise<string> {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = (label || 'terminal').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const extension = format === 'replay' ? 'replay.jsonl' : 'log';
  return join(directory, `${safe}-${stamp}.${extension}`);
}

/** 停止记录：刷净缓冲 + 后端收尾。返回日志文件路径。 */
export async function stopSessionLog(sessionId: string): Promise<string | null> {
  const log = sessionLogs.get(sessionId);
  if (!log) return null;
  if (log.flushTimer) {
    clearTimeout(log.flushTimer);
    log.flushTimer = undefined;
  }
  await log.flushing.catch(() => {});
  enqueueFlush(sessionId, log);
  await log.flushing.catch(() => {});
  sessionLogs.delete(sessionId);
  try {
    const path = await invoke<string | null>('session_log_close', { sessionId });
    return path ?? log.path;
  } catch (e) {
    console.warn(`[session-log] ${sessionId} close failed:`, e);
    return log.path;
  }
}

/**
 * 会话生命周期兜底（tab 关闭/断线 dispose 时由 terminalPool 调用）：
 * 不等待完成（fire-and-forget），保证异常路径也刷盘收尾。
 */
export function forceStopSessionLog(sessionId: string) {
  void stopSessionLog(sessionId);
}
