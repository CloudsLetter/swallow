import { invoke } from '@tauri-apps/api/core';
import type { ConnectResult } from './sessionService';

export interface DiskUsage {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  percent: number;
}

export interface DiskIo {
  device: string;
  rxBytesPerSec: number;
  wxBytesPerSec: number;
}

export interface NetRate {
  interface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface TcpStats {
  established: number;
  timeWait: number;
  closeWait: number;
  synSent: number;
  listening: number;
  total: number;
}

export interface TopProcess {
  pid: number;
  user: string;
  name: string;
  cpuPercent: number;
  memPercent: number;
  memBytes: number;
}

export interface MonitorSnapshot {
  hostname: string;
  kernel: string;
  arch: string;
  uptimeSecs: number;
  load1: number;
  load5: number;
  load15: number;
  cpuCores: number;
  cpuUsage: number;
  cpuUser: number;
  cpuSystem: number;
  cpuIowait: number;
  cpuSteal: number;
  memTotal: number;
  memUsed: number;
  memAvailable: number;
  memFree: number;
  memBuffCache: number;
  swapTotal: number;
  swapUsed: number;
  disks: DiskUsage[];
  disksIo: DiskIo[];
  net: NetRate[];
  tcp: TcpStats;
  topCpu: TopProcess[];
  topMem: TopProcess[];
}

/** 对某台主机建立独立的监控 SSH 连接（复用主机认证链路，含跳板机）。 */
export function monitorStart(hostId: string): Promise<ConnectResult> {
  return invoke<ConnectResult>('monitor_start', { hostId });
}

/** 采集一次系统指标快照。 */
export function monitorCollect(sessionId: string): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>('monitor_collect', { sessionId });
}

/** 断开监控会话。 */
export function monitorStop(sessionId: string): Promise<void> {
  return invoke<void>('monitor_stop', { sessionId });
}

/** 监控页持久化状态：正在监控的主机 id 列表 + 是否自动重连。 */
export interface MonitorState {
  hostIds: string[];
  autoStart: boolean;
}

/** 读取监控页持久化状态（无记录时为默认值）。 */
export function monitorGetState(): Promise<MonitorState> {
  return invoke<MonitorState>('monitor_get_state');
}

/** 覆盖保存监控页状态。 */
export function monitorSaveState(hostIds: string[], autoStart: boolean): Promise<void> {
  return invoke<void>('monitor_save_state', { hostIds, autoStart });
}
