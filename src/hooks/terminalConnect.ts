//! 终端连接编排 hook：连接分派（ssh/telnet/local/serial/mosh）+ 主机密钥确认循环
//! + 会话日志自动启动 + 连接进度步骤构建。自 TerminalView 拆出——
//! 状态与处理器归进度 hook（useSessionConnection），本文件只做「发起连接」这件事。

import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  acceptHostKey,
  disconnectSsh,
  sshConnect,
  localShellConnect,
  localShellDisconnect,
  moshConnect,
  moshDisconnect,
  serialConnect,
  serialDisconnect,
  telnetConnect,
  telnetDisconnect,
  toCommandError,
} from '../services/sessionService';
import {
  createOrGetTerminal,
  fitTerminal,
  getConnectionSteps,
  getSilentReconnect,
  resetReconnectAttempts,
  setSilentReconnect,
  type ConnectionStep,
} from '../components/terminalPool';
import { getHosts, touchHostLastConnected, updateHost } from '../services/dataService';
import { dedupeHostKeyConfirm } from '../lib/hostKeyConfirm';
import { useConfigStore } from '../store/config';
import {
  createSessionLogPath,
  forceStopSessionLog,
  isSessionLogging,
  startSessionLog,
} from '../components/sessionLog';
import { toast } from 'sonner';

export type TerminalConnectMode = 'ssh' | 'telnet' | 'local' | 'serial' | 'mosh';

export interface TerminalSshConfig {
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

export interface TerminalTelnetConfig {
  host: string;
  port: number;
}

export interface TerminalLocalConfig {
  shell: string;
  wslDistro?: string;
  exePath?: string;
}

export interface TerminalSerialConfig {
  port: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'odd' | 'even' | 'mark' | 'space';
  flowControl?: 'none' | 'hardware' | 'software';
  /** 设备端字符集（默认 utf-8；gb18030/big5/latin1 等 encoding_rs 标签） */
  charset?: string;
}

/** 构建连接进度步骤（tcp/ssh/auth/shell/ready），顺序与后端 Progress 事件一致。 */
export function buildConnectionSteps(
  mode: TerminalConnectMode,
  opts: { telnetHost?: string; shell?: string; authType?: string; serialPort?: string },
  t: TFunction,
): ConnectionStep[] {
  const authLabel =
    mode === 'telnet'
      ? t('connection.stepConnect', { host: opts.telnetHost })
      : mode === 'local'
        ? t('connection.stepLocalShell', { shell: opts.shell })
        : mode === 'serial'
          ? t('connection.stepConnect', { host: opts.serialPort })
          : t('connection.stepAuth', { authType: opts.authType });
  const shellLabel = mode === 'mosh' ? t('connection.stepMoshServer') : t('connection.stepShell');
  return [
    { id: 'tcp', label: t('connection.stepTcp'), status: 'pending' },
    { id: 'ssh', label: t('connection.stepSsh'), status: 'pending' },
    { id: 'auth', label: authLabel, status: 'pending' },
    { id: 'shell', label: shellLabel, status: 'pending' },
    { id: 'ready', label: t('connection.stepReady'), status: 'pending' },
  ];
}

/** 主机密钥被重新信任（mismatch 换机/重装后确认）→ 该主机的 OS 占位图标
 *  已失效：清掉「自动探测写入的 os: 占位」并让重连重新探测（后端 trust 时已
 *  失效 OS_CACHE）。仅清自动来源（osAuto!==false）；手动选择的图标不动。 */
export async function resetAutoOsIconAfterTrust(host?: string, port?: number) {
  if (!host) return;
  try {
    const hosts = await getHosts();
    const h = hosts.find((x) => x.host === host && x.port === (port ?? 22));
    if (!h) return;
    if (h.icon?.startsWith('os:') && h.osAuto !== false) {
      await updateHost(h.id, { icon: undefined });
      window.dispatchEvent(new Event('hosts:icons-changed'));
    }
  } catch {
    // 重置失败不阻断连接
  }
}

/** SSH 建连 + 主机密钥确认循环：首次遇到未信任主机密钥时弹确认，用户 trust 后重试连接。 */
async function connectSshWithHostKeyApproval(
  sessionId: string,
  sshConfig: TerminalSshConfig,
  cols: number,
  rows: number,
  t: TFunction,
  onOutputData?: (chunk: ArrayBuffer) => void,
) {
  let result = await sshConnect(sessionId, sshConfig, cols, rows, onOutputData);
  while (result.status === 'needsHostKeyApproval') {
    const fingerprint = result.fingerprint ?? '';
    const accepted = await dedupeHostKeyConfirm(
      `${result.host}:${result.port}:${fingerprint}`,
      () =>
        ask(
          t('connection.hostKeyBody', { host: result.host, port: result.port, fingerprint }),
          {
            title: t('connection.hostKeyTitle'),
            kind: 'warning',
            okLabel: t('connection.trustAndConnect'),
            cancelLabel: t('common.cancel'),
          },
        ),
    );
    if (!accepted) {
      throw new Error(t('connection.declinedHostKey'));
    }
    await acceptHostKey(result.hostKeyToken!, fingerprint);
    // 换机/重装后重新信任：清自动 OS 占位，重连即重新探测新系统图标
    await resetAutoOsIconAfterTrust(sshConfig.host, sshConfig.port);
    result = await sshConnect(sessionId, sshConfig, cols, rows, onOutputData);
  }
  return result;
}

/** MOSH 引导 + 主机密钥确认循环：与 SSH 同链路（引导走 SSH，数据面走 UDP）。 */
async function connectMoshWithHostKeyApproval(
  sessionId: string,
  moshConfig: TerminalSshConfig,
  cols: number,
  rows: number,
  t: TFunction,
) {
  let result = await moshConnect(sessionId, moshConfig, cols, rows);
  while (result.status === 'needsHostKeyApproval') {
    const fingerprint = result.fingerprint ?? '';
    const accepted = await dedupeHostKeyConfirm(
      `${result.host}:${result.port}:${fingerprint}`,
      () =>
        ask(
          t('connection.hostKeyBody', { host: result.host, port: result.port, fingerprint }),
          {
            title: t('connection.hostKeyTitle'),
            kind: 'warning',
            okLabel: t('connection.trustAndConnect'),
            cancelLabel: t('common.cancel'),
          },
        ),
    );
    if (!accepted) {
      throw new Error(t('connection.declinedHostKey'));
    }
    await acceptHostKey(result.hostKeyToken!, fingerprint);
    // 换机/重装后重新信任：清自动 OS 占位，重连即重新探测新系统图标
    await resetAutoOsIconAfterTrust(moshConfig.host, moshConfig.port);
    result = await moshConnect(sessionId, moshConfig, cols, rows);
  }
  return result;
}

/** 按设置自动开始 SSH 会话日志；不弹出保存对话框。 */
export async function startConfiguredSshLog(sessionId: string, label: string): Promise<boolean> {
  const cfg = useConfigStore.getState().config;
  if (!cfg?.terminal.session_log_enabled || isSessionLogging(sessionId)) return false;
  const directory = cfg.terminal.session_log_directory?.trim();
  if (!directory) throw new Error('session log directory is empty');
  const format = cfg.terminal.session_log_format ?? 'plain';
  const path = await createSessionLogPath(directory, label, format);
  await startSessionLog(sessionId, path, label, format);
  return true;
}

/** createTerminalConnect 的上下文：视图侧注入状态与进度 hook 能力。 */
export interface TerminalConnectContext {
  sessionId: string;
  mode: TerminalConnectMode;
  sshConfig?: TerminalSshConfig;
  telnetConfig?: TerminalTelnetConfig;
  localConfig?: TerminalLocalConfig;
  serialConfig?: TerminalSerialConfig;
  moshConfig?: TerminalSshConfig;
  sessionLabel: string;
  /** 连接时刻的终端尺寸（cols/rows 用于 PTY 初始化） */
  getTerminalSize: () => { cols: number; rows: number };
  /** 连接前强制 fit 一次（进度卡可能改变过布局） */
  fitTerminalNow: () => void;
  cancelRef: MutableRefObject<boolean>;
  setConnecting: (connecting: boolean) => void;
  updateStep: (id: string, status: ConnectionStep['status'], message?: string) => void;
  setProgressVisible: (visible: boolean) => void;
  setSteps: (steps: ConnectionStep[]) => void;
  markConnected: (connected: boolean) => void;
  /** SSH 输出二进制 IPC 通道回调（Raw 字节 → 前端统一输出入口）；不传则后端无输出 */
  onSshOutput?: (chunk: ArrayBuffer) => void;
  t: TFunction;
}

/**
 * 构建终端连接函数（存入终端池供断线自动重连 / 手动重试调用）。
 * 分类型分派：ssh（含主机密钥确认循环）/ telnet / local / serial / mosh（SSH 引导）。
 * 返回的 connect() 每次调用都是完整的一次「连接尝试」。
 */
export function createTerminalConnect(ctx: TerminalConnectContext): () => Promise<void> {
  const {
    sessionId,
    mode,
    sshConfig,
    telnetConfig,
    localConfig,
    serialConfig,
    moshConfig,
    sessionLabel,
    t,
  } = ctx;
  const isTelnet = mode === 'telnet';
  const isLocal = mode === 'local';
  const isSerial = mode === 'serial';
  const isMosh = mode === 'mosh';

  return async () => {
    ctx.cancelRef.current = false;
    const silentReconnect = getSilentReconnect(sessionId);
    ctx.setConnecting(true);
    let autoLogStarted = false;

    // 重置并初始化连接步骤
    const steps: ConnectionStep[] = buildConnectionSteps(
      mode,
      {
        telnetHost: telnetConfig?.host,
        shell: localConfig?.shell,
        authType: sshConfig?.auth_type ?? moshConfig?.auth_type,
        serialPort: serialConfig?.port,
      },
      t,
    );

    ctx.setSteps(steps);
    if (!silentReconnect) {
      ctx.setProgressVisible(true);
    }

    try {
      // 标记第一步为进行中，后续阶段由后端 Progress 事件真实驱动
      ctx.updateStep('tcp', 'loading');

      // 确保终端尺寸正确（在连接前再次 fit）
      try {
        ctx.fitTerminalNow();
        // 等待一帧确保尺寸更新
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } catch (e) {
        console.warn('Fit error before connection:', e);
      }

      const { cols, rows } = ctx.getTerminalSize();

      if (ctx.cancelRef.current) throw new Error(t('connection.cancelledByUser'));

      // 在发起连接前开始记录，避免漏掉登录提示等早期输出。
      if ((sshConfig || moshConfig) && useConfigStore.getState().config?.terminal.session_log_enabled) {
        try {
          autoLogStarted = await startConfiguredSshLog(sessionId, sessionLabel);
        } catch (e) {
          // 日志是可选能力，落盘失败不阻断 SSH 连接。
          console.warn('[terminal] 自动开始 SSH 日志失败:', e);
        }
      }

      let connectResult;
      if (isTelnet) {
        // telnet 无认证、无主机密钥确认
        connectResult = await telnetConnect(sessionId, { host: telnetConfig!.host, port: telnetConfig!.port });
      } else if (isSerial) {
        // 串口无认证、无主机密钥确认（端口/波特率由配置携带）
        connectResult = await serialConnect(sessionId, {
          port: serialConfig!.port,
          baudRate: serialConfig!.baudRate,
          dataBits: serialConfig!.dataBits,
          stopBits: serialConfig!.stopBits,
          parity: serialConfig!.parity,
          flowControl: serialConfig!.flowControl,
          charset: serialConfig!.charset,
        });
      } else if (isLocal) {
        // 本地 shell 无认证、无主机密钥确认
        connectResult = await localShellConnect(
          sessionId,
          { shell: localConfig!.shell, wslDistro: localConfig!.wslDistro, exePath: localConfig!.exePath },
          cols,
          rows,
        );
      } else if (isMosh) {
        // MOSH：SSH 引导（含主机密钥确认），数据面走 UDP
        connectResult = await connectMoshWithHostKeyApproval(sessionId, moshConfig!, cols, rows, t);
      } else {
        connectResult = await connectSshWithHostKeyApproval(sessionId, sshConfig!, cols, rows, t, ctx.onSshOutput);
      }
      if (connectResult.status !== 'connected') {
        throw new Error(t('connection.connectionFailedStatus', { status: connectResult.status }));
      }
      // 取消已触发：后端可能已完成建连，主动断开避免孤儿会话
      if (ctx.cancelRef.current) {
        if (isTelnet) {
          await telnetDisconnect(sessionId).catch(() => {});
        } else if (isSerial) {
          await serialDisconnect(sessionId).catch(() => {});
        } else if (isLocal) {
          await localShellDisconnect(sessionId).catch(() => {});
        } else if (isMosh) {
          await moshDisconnect(sessionId).catch(() => {});
        } else {
          await disconnectSsh(sessionId).catch(() => {});
        }
        throw new Error(t('connection.cancelledByUser'));
      }

      // 连接进度已由后端 Progress 事件推进到 ready，直接进入后续处理

      // 标记为已连接，成功连接后重置自动重连计数（避免跨多次断连累计）
      ctx.markConnected(true);
      ctx.setConnecting(false);
      resetReconnectAttempts(sessionId);
      // 最近连接时间落库（SSH 会话）；在线状态由标签树派生（useActiveSshTargets）
      if (sshConfig?.host) {
        if (!silentReconnect) {
          touchHostLastConnected(sshConfig.host, sshConfig.port).catch(() => {});
        }
      } else if (moshConfig?.host) {
        if (!silentReconnect) {
          touchHostLastConnected(moshConfig.host, moshConfig.port).catch(() => {});
        }
      }
      if (silentReconnect) {
        setSilentReconnect(sessionId, false);
        // 重连成功：右下角 toast 提示，不在终端打印
        toast.success(t('connection.reconnectSuccess'), {
          id: `reconnect-${sessionId}`,
        });
      }

      // 延迟关闭进度窗口，让用户看到成功状态
      setTimeout(() => {
        ctx.setProgressVisible(false);

        // 关闭进度窗口后重新调整终端大小
        // 使用 requestAnimationFrame 确保 DOM 完全更新后再 fit
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const poolItem = createOrGetTerminal(sessionId);
            if (poolItem && poolItem.fit) {
              try {
                fitTerminal(sessionId);
              } catch (e) {
                console.warn('Failed to resize terminal:', e);
              }
            }
          });
        });
      }, 1500);
    } catch (error) {
      if (autoLogStarted) forceStopSessionLog(sessionId);
      const wasSilentReconnect = getSilentReconnect(sessionId);
      setSilentReconnect(sessionId, false);
      resetReconnectAttempts(sessionId);
      ctx.setConnecting(false);
      const cmdErr = toCommandError(error);

      // 标记当前正在执行的步骤为失败（读最新状态，避免使用初始化时的 stale 数组）
      const latest = getConnectionSteps(sessionId) || steps;
      const currentStepId = latest.find((s) => s.status === 'loading')?.id || 'auth';
      ctx.updateStep(currentStepId, 'error', cmdErr.message);

      // 静默重连失败：显示进度窗口，便于用户手动重试
      if (wasSilentReconnect) {
        ctx.setProgressVisible(true);
      }

      // 连接失败：右下角 toast 提示（终端保持干净，不打印错误文本）
      toast.error(t('connection.failed'), {
        description: cmdErr.message,
        id: `conn-${sessionId}`,
        duration: 6000,
      });
      console.error('SSH connection error:', cmdErr.code ?? 'unknown', cmdErr.message);

      // 失败后不自动关闭，等待用户操作
    }
  };
}
