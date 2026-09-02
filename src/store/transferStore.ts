import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sftpCancelTransfer } from '../services/sessionService';

/** 后端流式下载推送的进度事件载荷。 */
export interface TransferProgressEvent {
  sessionId: string;
  remotePath: string;
  done: number;
  total: number;
}

/** 传输任务（上传/下载）。状态按 sessionId 隔离保存（跨标签切换保留、互不干扰）。 */
export interface TransferTask {
  id: number;
  name: string;
  kind: 'upload' | 'download';
  status: 'active' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  error?: string;
  /** 下载任务用于匹配后端进度事件的远程路径 */
  remotePath?: string;
  /** 所属会话（标签），按此隔离 */
  sessionId?: string;
  /** 主机名（列表展示用） */
  host?: string;
  /** 传输协议类型（sftp / ftp） */
  protocol?: string;
  /** 实时速率（字节/秒），由进度更新计算，展示层按 500ms 刷新 */
  rate?: number;
  /** 下载任务的取消令牌（传给后端，结束任务时置位中断） */
  cancelToken?: string;
  /** 已请求取消：上传循环据此中断，下载据此标记状态 */
  cancelRequested?: boolean;
}

interface TransferStore {
  transfers: TransferTask[];
  addTransfer: (task: Omit<TransferTask, 'id' | 'rate'>) => number;
  updateTransfer: (id: number, patch: Partial<Omit<TransferTask, 'id' | 'rate'>>) => void;
  /** 按会话 + 远程路径匹配下载任务并更新进度（供后端进度事件调用） */
  updateTransferProgress: (sessionId: string, remotePath: string, done: number, total: number) => void;
  /** 结束任务：下载中断后端流、上传置位取消标志，任务标记为已取消 */
  cancelTransfer: (id: number) => void;
  dismissTransfer: (id: number) => void;
  clearTransfers: () => void;
}

let transferCounter = 0;

// 已请求取消的任务 id 集合（模块级真相源）。
// 上传取消是协作式的：SftpView 上传循环每块检查此标志；而「清除所有」会清空 transfers 数组，
// 若把取消标志只存在 transfer 对象里，清空后上传循环就读不到、上传仍在后台继续。
// 因此独立存放，dismissTransfer 时才真正移除。
const cancelRequestedIds = new Set<number>();

/** 判断某任务是否已被请求取消（供上传循环等协作式取消逻辑使用）。 */
export function isCancelRequested(id: number): boolean {
  return cancelRequestedIds.has(id);
}

// 速率采样表（非响应式）：taskId -> { time, done, rate }
// 速率 = 每次进度更新时的瞬时速率经 EMA(α=0.4) 平滑；无新数据时指数衰减避免虚高
const rateSamples = new Map<number, { time: number; done: number; rate: number }>();

function computeRate(id: number, done: number): number {
  const now = Date.now();
  const prev = rateSamples.get(id);
  if (!prev) {
    rateSamples.set(id, { time: now, done, rate: 0 });
    return 0;
  }
  const dt = (now - prev.time) / 1000;
  let rate: number;
  if (dt > 0) {
    const instant = (done - prev.done) / dt;
    rate = instant > 0 ? instant : prev.rate * 0.8;
    rate = prev.rate > 0 ? prev.rate * 0.6 + rate * 0.4 : rate;
  } else {
    rate = prev.rate;
  }
  rateSamples.set(id, { time: now, done, rate });
  return rate;
}

function clearRateSample(id: number) {
  rateSamples.delete(id);
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  transfers: [],

  addTransfer: (task) => {
    const id = ++transferCounter;
    set((state) => ({
      transfers: [...state.transfers, { ...task, id, rate: 0 }],
    }));
    return id;
  },

  updateTransfer: (id, patch) =>
    set((state) => ({
      transfers: state.transfers.map((task) => {
        if (task.id !== id) return task;
        const next = { ...task, ...patch };
        if (patch.done !== undefined) {
          next.rate = computeRate(id, next.done);
        }
        if (next.status === 'done' || next.status === 'error') {
          clearRateSample(id);
        }
        return next;
      }),
    })),

  updateTransferProgress: (sessionId, remotePath, done, total) =>
    set((state) => ({
      transfers: state.transfers.map((task) => {
        const matches =
          task.status === 'active' &&
          task.kind === 'download' &&
          task.sessionId === sessionId &&
          task.remotePath === remotePath;
        if (!matches) return task;
        const next = { ...task, done, total };
        next.rate = computeRate(task.id, done);
        return next;
      }),
    })),

  // 结束任务：下载 → 置位后端取消标志中断流；上传 → 置位取消标志供循环感知
  cancelTransfer: (id) => {
    const task = get().transfers.find((t) => t.id === id);
    if (!task || task.status !== 'active') return;
    if (task.kind === 'download' && task.cancelToken) {
      void sftpCancelTransfer(task.cancelToken).catch(() => {});
    }
    cancelRequestedIds.add(id);
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, cancelRequested: true, status: 'cancelled' } : t,
      ),
    }));
    clearRateSample(id);
  },

  dismissTransfer: (id) => {
    clearRateSample(id);
    cancelRequestedIds.delete(id);
    set((state) => ({
      transfers: state.transfers.filter((task) => task.id !== id),
    }));
  },

  clearTransfers: () => {
    rateSamples.clear();
    set({ transfers: [] });
  },
}));

/** 任务列表按所属会话分组（供全局面板展示）。 */
export function groupTransfersBySession(transfers: TransferTask[]): Map<string, TransferTask[]> {
  const map = new Map<string, TransferTask[]>();
  for (const task of transfers) {
    const key = task.sessionId || '';
    const list = map.get(key) ?? [];
    list.push(task);
    map.set(key, list);
  }
  return map;
}

let progressUnlisten: UnlistenFn | undefined;

/**
 * 初始化全局下载进度监听（App 启动时调用一次）。
 * 与视图解耦：无论 SftpView 是否挂载/何时挂载，后端进度事件都会更新到 store，
 * 传输面板（标签内 + 全局）从 store 读取即可实时刷新。
 */
export function initTransferProgressListener() {
  if (progressUnlisten) return;
  void listen<TransferProgressEvent>('sftp-transfer', (event) => {
    const { sessionId, remotePath, done, total } = event.payload;
    useTransferStore.getState().updateTransferProgress(sessionId, remotePath, done, total);
  }).then((unlisten) => {
    progressUnlisten = unlisten;
  });
}
