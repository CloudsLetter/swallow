import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ask } from '@tauri-apps/plugin-dialog';
import type { ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ConnectionProgress } from './ConnectionProgress';
import { useConfigStore } from '../store/config';
import { buildTerminalTheme } from '../hooks/themeUtils';
import { buildXtermOptions, hexToRgba } from '../hooks/terminalOptions';
import { useTerminalFit } from '../hooks/useTerminalFit';
import { useTerminalBackground } from '../hooks/useTerminalBackground';
import { TerminalBackdrop } from './TerminalBackdrop';
import { useSessionConnection, sshSessionPool } from '../hooks/useSessionConnection';
import { acceptHostKey, sshConnect, disconnectSsh, telnetConnect, telnetDisconnect, localShellConnect, localShellDisconnect } from '../services/sessionService';
import { touchHostLastConnected } from '../services/dataService';
import { useOnlineHosts } from '../store/uiState';
import type { Config } from '../types/config';
import {
  createOrGetTerminal,
  fitTerminal,
  attachTerminal,
  detachTerminal,
  attachListeners,
  registerEventHandlers,
  isOnDataBound,
  markOnDataBound,
  isConnected,
  isConnecting as checkIsConnecting,
  getConnectionSteps,
  setConnectFunction,
  getConnectFunction,
  getShowProgress,
  listPool,
  enqueueWriteToTargets,
  applyTerminalOptions,
  setupTerminalInteractions,
  getReconnectAttempts,
  incrementReconnectAttempts,
  resetReconnectAttempts,
  setSilentReconnect,
  getSilentReconnect,
  getSearchAddon,
  setFindToggleHandler,
  focusTerminal,
  copyTerminalBufferToClipboard,
  serializeTerminalBuffer,
  setSessionType,
  type ConnectionStep,
} from './terminalPool';
import {
  isSessionLogging,
  createSessionLogPath,
  forceStopSessionLog,
  appendReplaySnapshot,
  startSessionLog,
} from './sessionLog';
import { SnippetPicker } from './SnippetPicker';
import { useBroadcastStore } from '../store/broadcast';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  ArrowDown as IconArrowDown,
  ArrowUp as IconArrowUp,
  Copy as IconCopy,
  RadioTower as IconBroadcast,
  Search as IconSearch,
  X as IconX,
  Zap as IconSnippet,
} from 'lucide-react';
import type { ISearchOptions } from '@xterm/addon-search';
import { toast } from 'sonner';

// onError 事件可能高频到达：500ms 内去重，避免 toast 刷屏
let lastErrorToastAt = 0;

// 缓冲区查找高亮配色（SearchAddon decorations 只接受 #RRGGBB 纯色；
// 黄/橙对浅色与深色终端背景都可读，后续可按主题收敛到配置）
const SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#FDE047',
  matchBorder: '#EAB308',
  matchOverviewRuler: '#EAB308',
  activeMatchBackground: '#F59E0B',
  activeMatchBorder: '#B45309',
  activeMatchColorOverviewRuler: '#F59E0B',
};

/** 由 terminal 配置生成完整 xterm 选项（含主题与背景透明度）。 */
function buildTerminalOptions(cfg: Config['terminal']): ITerminalOptions {
  const options = buildXtermOptions(cfg);
  const themes = cfg.themes || [];
  const preset = themes.find((t) => t.id === cfg.active_theme_id) || themes[0];
  const hasBackgroundImage = !!cfg.background_image;

  if (preset && preset.colors) {
    const theme = buildTerminalTheme(preset.colors);
    if (hasBackgroundImage) {
      // 有背景图片：xterm 自身背景置为全透明，让图片层透出（图片层用 opacity 做压暗）
      theme.background = 'rgba(0, 0, 0, 0)';
      options.allowTransparency = true;
    } else if (cfg.allow_transparent_background && cfg.background_opacity < 1) {
      theme.background = hexToRgba(preset.colors.background, cfg.background_opacity);
      options.allowTransparency = true;
    }
    options.theme = theme;
  }
  return options;
}

export type TerminalConnectMode = 'ssh' | 'telnet' | 'local';

/** 构建连接进度步骤（tcp/ssh/auth/shell/ready），顺序与后端 Progress 事件一致。 */
function buildConnectionSteps(
  mode: TerminalConnectMode,
  opts: { telnetHost?: string; shell?: string; authType?: string },
  t: TFunction,
): ConnectionStep[] {
  const authLabel =
    mode === 'telnet'
      ? t('connection.stepConnect', { host: opts.telnetHost })
      : mode === 'local'
        ? t('connection.stepLocalShell', { shell: opts.shell })
        : t('connection.stepAuth', { authType: opts.authType });
  return [
    { id: 'tcp', label: t('connection.stepTcp'), status: 'pending' },
    { id: 'ssh', label: t('connection.stepSsh'), status: 'pending' },
    { id: 'auth', label: authLabel, status: 'pending' },
    { id: 'shell', label: t('connection.stepShell'), status: 'pending' },
    { id: 'ready', label: t('connection.stepReady'), status: 'pending' },
  ];
}

/** SSH 建连 + 主机密钥确认循环：首次遇到未信任主机密钥时弹确认，用户 trust 后重试连接。 */
async function connectSshWithHostKeyApproval(
  sessionId: string,
  sshConfig: TerminalSshConfig,
  cols: number,
  rows: number,
  t: TFunction,
) {
  let result = await sshConnect(sessionId, sshConfig, cols, rows);
  while (result.status === 'needsHostKeyApproval') {
    const fingerprint = result.fingerprint ?? '';
    const accepted = await ask(
      t('connection.hostKeyBody', { host: result.host, port: result.port, fingerprint }),
      {
        title: t('connection.hostKeyTitle'),
        kind: 'warning',
        okLabel: t('connection.trustAndConnect'),
        cancelLabel: t('common.cancel'),
      },
    );
    if (!accepted) {
      throw new Error(t('connection.declinedHostKey'));
    }
    await acceptHostKey(result.hostKeyToken!, fingerprint);
    result = await sshConnect(sessionId, sshConfig, cols, rows);
  }
  return result;
}

/** 按设置自动开始 SSH 会话日志；不弹出保存对话框。 */
async function startConfiguredSshLog(sessionId: string, label: string): Promise<boolean> {
  const cfg = useConfigStore.getState().config;
  if (!cfg?.terminal.session_log_enabled || isSessionLogging(sessionId)) return false;
  const directory = cfg.terminal.session_log_directory?.trim();
  if (!directory) throw new Error('session log directory is empty');
  const format = cfg.terminal.session_log_format ?? 'plain';
  const path = await createSessionLogPath(directory, label, format);
  await startSessionLog(sessionId, path, label, format);
  return true;
}

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
}

interface TerminalViewProps {
  sessionId?: string;
  sshConfig?: TerminalSshConfig;
  telnetConfig?: TerminalTelnetConfig;
  localConfig?: TerminalLocalConfig;
  // 标签是否处于激活状态（keep-alive 下用于切回时重新 fit 终端）
  isActive?: boolean;
  // 外部尺寸变化信号（分屏拖分隔条后递增），触发重新 fit + resize PTY
  resizeSignal?: number;
  // 跳过自动连接（恢复的无密码密码类会话：等待用户手动重连）
  skipAutoConnect?: boolean;
}

export function TerminalView({ sessionId, sshConfig, telnetConfig, localConfig, isActive = true, resizeSignal, skipAutoConnect }: TerminalViewProps) {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const terminalRef = useRef<HTMLDivElement>(null);
  const isAttachedRef = useRef(false);
  // 广播模式（全局，跨终端标签）与快捷指令弹窗
  const broadcastEnabled = useBroadcastStore((state) => state.enabled);
  const [snippetPickerOpen, setSnippetPickerOpen] = useState(false);

  // —— 缓冲区查找（SearchAddon 由 terminalPool 统一挂载，这里只做 UI 与状态）——
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState('');
  const [findResult, setFindResult] = useState<{
    resultIndex: number;
    resultCount: number;
  } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findEverOpenedRef = useRef(false);

  // SSH 日志由设置中的开关控制：连接前自动开始，断开时由生命周期收尾。
  const sessionLabel = sshConfig ? `${sshConfig.username}@${sshConfig.host}` : 'terminal';

  useEffect(() => {
    if (!sessionId || !sshConfig) return;
    if (!config?.terminal.session_log_enabled) {
      if (isSessionLogging(sessionId)) forceStopSessionLog(sessionId);
      return;
    }
    // keep-alive / 分屏重挂载时，若 SSH 已经连接，补上自动记录。
    if (isConnected(sessionId)) {
      void startConfiguredSshLog(sessionId, sessionLabel).catch((e) => {
        console.warn('[terminal] 自动开始 SSH 日志失败:', e);
      });
    }
  }, [config?.terminal.session_log_enabled, sessionId, sshConfig, sessionLabel]);

  const openFind = () => {
    findEverOpenedRef.current = true;
    setFindOpen(true);
  };
  const moveFind = (dir: 'next' | 'prev') => {
    if (!sessionId) return;
    const search = getSearchAddon(sessionId);
    if (!search) return;
    const term = findTerm.trim();
    if (!term) return;
    if (dir === 'next') {
      search.findNext(term, { decorations: SEARCH_DECORATIONS });
    } else {
      search.findPrevious(term, { decorations: SEARCH_DECORATIONS });
    }
  };
  const closeFind = () => {
    findEverOpenedRef.current = true;
    setFindOpen(false);
  };
  const copyAllBuffer = async () => {
    if (!sessionId) return;
    try {
      if (await copyTerminalBufferToClipboard(sessionId)) {
        toast.success(t('terminal.bufferCopied'));
      } else {
        toast.info(t('terminal.bufferEmpty'));
      }
    } catch (e) {
      console.warn('[terminal] 复制全部缓冲失败:', e);
    }
  };

  // 查找快捷键 Ctrl+Shift+F 回调：每次渲染都注册最新闭包（toggle 用函数式更新，
  // 避免 stale）；组件卸载时由下面带清理的 effect 清空。
  useEffect(() => {
    if (!sessionId) return;
    setFindToggleHandler(sessionId, () => {
      findEverOpenedRef.current = true;
      setFindOpen((v) => !v);
    });
  });

  useEffect(() => {
    if (!sessionId) return;
    const sid = sessionId; // 参数收窄不会进入闭包，先取到 const 再给清理函数用
    return () => setFindToggleHandler(sid, undefined);
  }, [sessionId]);

  // 打开时聚焦输入框；关闭时清高亮/结果并把焦点还给终端（未打开过则不动，避免挂载抢焦）
  useEffect(() => {
    if (!sessionId) return;
    if (findOpen) {
      requestAnimationFrame(() => findInputRef.current?.focus());
    } else if (findEverOpenedRef.current) {
      getSearchAddon(sessionId)?.clearDecorations();
      setFindResult(null);
      setFindTerm('');
      focusTerminal(sessionId);
    }
  }, [findOpen, sessionId]);

  // 输入变化即增量查找（高亮全部；计数由 onDidChangeResults 事件驱动）
  useEffect(() => {
    if (!findOpen || !sessionId) return;
    const search = getSearchAddon(sessionId);
    if (!search) return;
    const term = findTerm.trim();
    if (!term) {
      search.clearDecorations();
      setFindResult(null);
      return;
    }
    search.findNext(term, { incremental: true, decorations: SEARCH_DECORATIONS });
  }, [findOpen, findTerm, sessionId]);

  // 订阅查找结果计数（SearchAddon 每次 find 后广播当前 resultIndex / resultCount）
  useEffect(() => {
    if (!findOpen || !sessionId) return;
    const search = getSearchAddon(sessionId);
    if (!search) return;
    const sub = search.onDidChangeResults((r) => setFindResult(r));
    return () => sub.dispose();
  }, [findOpen, sessionId]);

  // 协议类型（组件级派生）：telnet/local 与 ssh 共用终端渲染，仅连接/写入命令不同
  // 尺寸适配 hook：窗口 resize / 激活 refit / 分屏 signal 统一处理 + 已连接时同步 PTY 尺寸
  useTerminalFit({ sessionId, isActive, resizeSignal });

  // 连接进度状态（由 useSessionConnection 统一管理并同步到终端池）
  const {
    showProgress,
    steps: connectionSteps,
    isConnecting: isConnectingState,
    cancelRef: cancelConnectionRef,
    setSteps: setConnectionStepsLocal,
    updateStep,
    setProgressVisible: setShowProgress,
    setConnecting: setIsConnectingState,
    markConnected,
    handleCancelConnection,
    handleCloseProgress,
    handleRetryConnection,
  } = useSessionConnection(sessionId, sshSessionPool);

  // 终端外观派生（背景色/背景图/透明/顶栏延伸）+ URL 解析 + 顶栏对比前景注入（见 useTerminalBackground）
  const { terminalBackground, backgroundImageUrl, extendToTopbar } = useTerminalBackground(config, isActive);

  useEffect(() => {
    if (!terminalRef.current || !sessionId) return;

    // 延迟初始化，确保 DOM 完全渲染
    const timeoutId = setTimeout(async () => {
      if (!terminalRef.current || !sessionId) return;

      try {
        // 从终端池获取或创建终端实例，并应用字体/光标/滚动/主题等外观配置
        const cfg = useConfigStore.getState().config;
        const poolItem = createOrGetTerminal(
          sessionId,
          cfg?.terminal ? buildTerminalOptions(cfg.terminal) : undefined,
          cfg?.terminal
            ? {
                engine: cfg.terminal.render_engine ?? 'dom',
                gpu: cfg.terminal.gpu_acceleration ?? true,
              }
            : undefined,
        );
        const terminal = poolItem.terminal;
        // 绑定复制/粘贴/全选/铃声（每个终端仅一次）
        setupTerminalInteractions(sessionId);

        // 必须在 attach/fit 之前确定协议类型：已连接的 Telnet 标签重挂载时，
        // attachTerminal 可能立即触发 resize，不能让它按默认 ssh 分支发送 PTY resize。
        const isTelnet = !!telnetConfig && !sshConfig && !localConfig;
        const isLocal = !!localConfig && !sshConfig && !telnetConfig;
        setSessionType(sessionId, isTelnet ? 'telnet' : isLocal ? 'local' : 'ssh');

        // 附加到 DOM
        attachTerminal(sessionId, terminalRef.current);
        isAttachedRef.current = true;

        // 检查是否已经连接 / 正在连接
        const alreadyConnected = isConnected(sessionId);
        const currentlyConnecting = checkIsConnecting(sessionId);

        // 无 SSH/telnet/local 配置：无法发起连接，仅显示欢迎信息
        if (!sshConfig && !telnetConfig && !localConfig) {
          terminal.writeln(t('connection.welcome'));
          terminal.writeln(t('connection.sessionIdLine', { sessionId }));
          terminal.writeln('');
          terminal.writeln(t('connection.configurePrompt'));
          return;
        }

        // 连接函数：每次挂载都重新定义并保存到终端池，供断线自动重连 / 手动重试使用。
        // 分屏合并/移出导致组件重挂载后，这里会覆盖掉旧实例的 stale 闭包。
        const connectSSH = async () => {
          cancelConnectionRef.current = false;
          const silentReconnect = getSilentReconnect(sessionId);
          setIsConnectingState(true);
          let autoLogStarted = false;

          // 重置并初始化连接步骤
          const mode: TerminalConnectMode = isTelnet ? 'telnet' : isLocal ? 'local' : 'ssh';
          const steps: ConnectionStep[] = buildConnectionSteps(
            mode,
            {
              telnetHost: telnetConfig?.host,
              shell: localConfig?.shell,
              authType: sshConfig?.auth_type,
            },
            t,
          );

          setConnectionStepsLocal(steps);
          if (!silentReconnect) {
            setShowProgress(true);
          }

          try {
            // 标记第一步为进行中，后续阶段由后端 Progress 事件真实驱动
            updateStep('tcp', 'loading');

            // 确保终端尺寸正确（在连接前再次 fit）
            try {
              fitTerminal(sessionId);
              // 等待一帧确保尺寸更新
              await new Promise((resolve) => requestAnimationFrame(resolve));
            } catch (e) {
              console.warn('Fit error before connection:', e);
            }

            const cols = terminal.cols;
            const rows = terminal.rows;

            if (cancelConnectionRef.current) throw new Error(t('connection.cancelledByUser'));

            // 在发起 SSH 连接前开始记录，避免漏掉登录提示等早期输出。
            if (sshConfig && useConfigStore.getState().config?.terminal.session_log_enabled) {
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
            } else if (isLocal) {
              // 本地 shell 无认证、无主机密钥确认
              connectResult = await localShellConnect(
                sessionId,
                { shell: localConfig!.shell, wslDistro: localConfig!.wslDistro },
                cols,
                rows,
              );
            } else {
              connectResult = await connectSshWithHostKeyApproval(sessionId, sshConfig!, cols, rows, t);
            }
            if (connectResult.status !== 'connected') {
              throw new Error(t('connection.connectionFailedStatus', { status: connectResult.status }));
            }
            // 取消已触发：后端可能已完成建连，主动断开避免孤儿会话
            if (cancelConnectionRef.current) {
              if (isTelnet) {
                await telnetDisconnect(sessionId).catch(() => {});
              } else if (isLocal) {
                await localShellDisconnect(sessionId).catch(() => {});
              } else {
                await disconnectSsh(sessionId).catch(() => {});
              }
              throw new Error(t('connection.cancelledByUser'));
            }

            // 连接进度已由后端 Progress 事件推进到 ready，直接进入后续处理

            // 标记为已连接，成功连接后重置自动重连计数（避免跨多次断连累计）
            markConnected(true);
            setIsConnectingState(false);
            resetReconnectAttempts(sessionId);
            // 在线状态走内存 + 最近连接时间落库（SSH 会话）
            if (sshConfig?.host) {
              useOnlineHosts.getState().connect(sshConfig.host, sshConfig.port);
              if (!silentReconnect) {
                touchHostLastConnected(sshConfig.host, sshConfig.port).catch(() => {});
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
              setShowProgress(false);

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
            setIsConnectingState(false);

            // 标记当前正在执行的步骤为失败（读最新状态，避免使用初始化时的 stale 数组）
            const latest = getConnectionSteps(sessionId) || steps;
            const currentStepId = latest.find((s) => s.status === 'loading')?.id || 'auth';
            updateStep(currentStepId, 'error', String(error));

            // 静默重连失败：显示进度窗口，便于用户手动重试
            if (wasSilentReconnect) {
              setShowProgress(true);
            }

            // 连接失败：右下角 toast 提示（终端保持干净，不打印错误文本）
            toast.error(t('connection.failed'), {
              description: String(error),
              id: `conn-${sessionId}`,
              duration: 6000,
            });
            console.error('SSH connection error:', error);

            // 失败后不自动关闭，等待用户操作
          }
        };

        // 绑定用户输入（幂等，只绑定一次）
        if (!isOnDataBound(sessionId)) {
          terminal.onData((data: string) => {
            // 广播开启时，把输入同时发送到所有已连接的会话（ssh/telnet 各自走对应命令）
            const targets = useBroadcastStore.getState().enabled
              ? listPool().filter((id) => isConnected(id))
              : [sessionId];
            enqueueWriteToTargets(targets, data);
          });
          markOnDataBound(sessionId, true);
        }

        // 注册会话事件回调（每次挂载覆盖旧实例 stale 回调）+ 建立事件监听（只建立一次，转发到最新回调）
        registerEventHandlers(sessionId, {
          onOutput: (data: string) => {
            try {
              // xterm.write 自带增量渲染；不要额外全屏 refresh——
              // 高频输出（motd/日志）时全量刷新会阻塞主线程导致终端「无响应」
              terminal.write(data, () => {
                appendReplaySnapshot(sessionId, serializeTerminalBuffer(sessionId) ?? '');
              });
            } catch (error) {
              console.error(`[${sessionId}] Failed to write data:`, error);
            }
          },
          onDisconnect: () => {
            forceStopSessionLog(sessionId);
            // 断开：右下角 toast 提示，不在终端打印
            toast.warning(t('connection.connectionClosed'), {
              id: `conn-${sessionId}`,
              duration: 4000,
            });
            markConnected(false);
            // 主机离线：内存状态移除（列表/快速链接页状态点实时回灰）
            if (sshConfig?.host) {
              useOnlineHosts.getState().disconnect(sshConfig.host, sshConfig.port);
            }
            const cfg = useConfigStore.getState().config;
            const maxAttempts = cfg?.ssh?.max_reconnect_attempts ?? 0;
            if (
              cfg?.ssh?.auto_reconnect &&
              maxAttempts > 0 &&
              getReconnectAttempts(sessionId) < maxAttempts
            ) {
              const attempt = incrementReconnectAttempts(sessionId);
              setSilentReconnect(sessionId, true);
              // 重连尝试：toast 提示（复用同一 id 覆盖，避免刷屏）
              toast.info(t('connection.reconnecting', { attempt, maxAttempts }), {
                id: `reconnect-${sessionId}`,
                duration: 2000,
              });
              setTimeout(() => {
                // 标签已关闭时不再重连
                if (!sessionId || !listPool().includes(sessionId)) return;
                const fn = getConnectFunction(sessionId);
                if (fn) void fn();
              }, 2000);
            } else {
              resetReconnectAttempts(sessionId);
            }
          },
          onError: (msg: string) => {
            // 会话错误：toast 提示（500ms 去重），不在终端打印
            const now = Date.now();
            if (now - lastErrorToastAt < 500) return;
            lastErrorToastAt = now;
            toast.error(t('connection.failed'), {
              description: msg,
              duration: 5000,
            });
          },
          onProgress: (stage: string) => {
            // 阶段进度：单调推进步骤（tcp/ssh/auth/shell/ready）
            const order = ['tcp', 'ssh', 'auth', 'shell', 'ready'];
            const idx = order.indexOf(stage);
            if (idx < 0) return;
            const current = getConnectionSteps(sessionId);
            if (!current || current.length === 0) return;
            setConnectionStepsLocal(
              current.map((s, i): ConnectionStep => {
                if (i <= idx) return { ...s, status: 'success' };
                if (i === idx + 1) return { ...s, status: 'loading' };
                return { ...s, status: 'pending' };
              }),
            );
          },
        });
        setConnectFunction(sessionId, connectSSH);
        await attachListeners(sessionId);

        // 已连接：终端实例已存在且已附加，无需重新连接
        if (alreadyConnected) return;

        // 正在连接中：恢复进度显示
        if (currentlyConnecting) {
          const savedSteps = getConnectionSteps(sessionId);
          if (savedSteps && savedSteps.length > 0) {
            setConnectionStepsLocal(savedSteps);
          }
          setIsConnectingState(true);
          setShowProgress(true);
          return;
        }

        // 检查是否应该显示进度窗口（处理连接刚完成的情况）
        const savedShowProgress = getShowProgress(sessionId);
        if (savedShowProgress) {
          const savedSteps = getConnectionSteps(sessionId);
          if (savedSteps) {
            setConnectionStepsLocal(savedSteps);
          }
          setShowProgress(true);
        }

        // 跳过自动连接：恢复的密码类会话（无密码凭据），只写恢复提示，等待用户手动重连
        if (skipAutoConnect) {
          terminal.writeln(t('connection.restoredNeedPassword'));
          terminal.writeln('');
          return;
        }

        // 启动连接
        connectSSH();
      } catch (error) {
        console.error('Terminal initialization error:', error);
      }
    }, 50);

    return () => {
      clearTimeout(timeoutId);

      // 组件卸载时只 detach，不销毁终端实例
      if (isAttachedRef.current && sessionId) {
        detachTerminal(sessionId);
        isAttachedRef.current = false;
      }
    };
  }, [sessionId, sshConfig, localConfig]);

  // 当配置改变（字体/光标/滚动/主题等）时，动态应用到已存在的终端。
  // ⚠️ 以「构建出的 xterm options 序列化」为 key：仅真正影响终端外观的字段变化才重设+fit。
  //    背景图 opacity/blur 等只影响 DOM 背景层（由 React 直接渲染），变化时不触碰 xterm——
  //    否则全量重设 options + fit 会引发重绘竞态（用户改图不透明度后提示符回来异常/重影）。
  const terminalOptionsKey = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const cfg = config;
    if (!cfg || !cfg.terminal) return;
    let options: ITerminalOptions;
    try {
      options = buildTerminalOptions(cfg.terminal);
    } catch (e) {
      console.warn('Build terminal options error', e);
      return;
    }
    const key = JSON.stringify(options);
    if (terminalOptionsKey.current === key) return; // 外观未变化：跳过
    terminalOptionsKey.current = key;
    try {
      const poolItem = createOrGetTerminal(sessionId);
      if (!poolItem?.terminal) return;
      applyTerminalOptions(sessionId, options);
      // 字体变化会改变 xterm 的 cell width，立即重新适配并触发亚像素校准。
      fitTerminal(sessionId);
    } catch (e) {
      console.warn('Terminal config update error', e);
    }
  }, [config, sessionId]);

  return (
    <div
      className="terminal-view"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        // 背景延伸时容器自身透明，由 fixed 全窗背景层提供（覆盖 Topbar）
        backgroundColor: extendToTopbar ? 'transparent' : terminalBackground,
        position: 'relative',
        zIndex: extendToTopbar ? 1 : undefined,
        // 选区半透明（驱动 .xterm-selection div 的 opacity，见 index.css）
        ['--xterm-selection-opacity' as string]: config?.terminal?.selection_opacity ?? 0.4,
        // 裁掉背景图外扩部分（防 blur 晕边）与子元素溢出
        overflow: 'hidden',
      }}
    >
      {/* 背景层：纯色底 + 可选背景图（extend 时 fixed 全窗覆盖 Topbar；否则 absolute 外扩防 blur 晕边）。
          内置 blur=0 不设 filter 的关键约束（防离屏降采样全图模糊），见 TerminalBackdrop */}
      <TerminalBackdrop
        extendToTopbar={extendToTopbar}
        solid={terminalBackground}
        imageUrl={backgroundImageUrl}
        blur={config?.terminal?.background_image_blur ?? 0}
        opacity={config?.terminal?.background_image_opacity ?? 0.7}
      />

      {/* 终端容器 - 始终存在，只是在显示进度时隐藏 */}
      <div
        ref={terminalRef}
        style={{
          width: '100%',
          height: '100%',
          visibility: showProgress ? 'hidden' : 'visible',
          overflow: 'hidden',
          boxSizing: 'border-box',
          position: 'relative',
        }}
      />

      {/* 浮动操作栏：复制全部 + 查找 + 广播 + 快捷指令（连接中隐藏） */}
      {!showProgress && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 rounded-md bg-background/80"
            onClick={copyAllBuffer}
            title={t('terminal.copyAllOutput')}
            aria-label={t('terminal.copyAllOutput')}
          >
            <IconCopy size={14} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 rounded-md bg-background/80"
            onClick={openFind}
            title={`${t('terminal.find')} (Ctrl+Shift+F)`}
            aria-label={t('terminal.find')}
          >
            <IconSearch size={14} strokeWidth={2} />
          </Button>
          <Button
            variant={broadcastEnabled ? 'default' : 'ghost'}
            size="icon-xs"
            className="h-7 w-7 rounded-md bg-background/80"
            onClick={() => useBroadcastStore.getState().toggle()}
            title={t('terminal.broadcast')}
            aria-label={t('terminal.broadcast')}
          >
            <IconBroadcast size={14} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 rounded-md bg-background/80"
            onClick={() => setSnippetPickerOpen(true)}
            title={t('terminal.snippets')}
            aria-label={t('terminal.snippets')}
          >
            <IconSnippet size={14} strokeWidth={2} />
          </Button>
        </div>
      )}

      {/* 缓冲区查找条（Ctrl+Shift+F / 搜索按钮打开；Enter 下一个、Shift+Enter 上一个、Esc 关闭） */}
      {!showProgress && findOpen && sessionId && (
        <div className="absolute bottom-2 right-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-md">
          <Input
            ref={findInputRef}
            value={findTerm}
            onChange={(e) => setFindTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                moveFind(e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder={t('terminal.findPlaceholder')}
            className="h-7 w-52 border-transparent bg-transparent text-xs shadow-none focus-visible:ring-0"
          />
          <span className="w-10 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
            {findTerm.trim()
              ? findResult && findResult.resultCount > 0
                ? `${findResult.resultIndex + 1}/${findResult.resultCount}`
                : '0/0'
              : ''}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 rounded-md"
            onClick={() => moveFind('prev')}
            title={t('terminal.findPrevious')}
            aria-label={t('terminal.findPrevious')}
          >
            <IconArrowUp size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 rounded-md"
            onClick={() => moveFind('next')}
            title={t('terminal.findNext')}
            aria-label={t('terminal.findNext')}
          >
            <IconArrowDown size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 rounded-md"
            onClick={closeFind}
            title={t('terminal.findClose')}
            aria-label={t('terminal.findClose')}
          >
            <IconX size={13} strokeWidth={2} />
          </Button>
        </div>
      )}

      {/* 快捷指令选择器 */}
      <SnippetPicker
        open={snippetPickerOpen}
        onOpenChange={setSnippetPickerOpen}
        onPick={(command) => {
          if (!sessionId) return;
          const data = command.trimEnd() + '\r';
          const targets = useBroadcastStore.getState().enabled
            ? listPool().filter((id) => isConnected(id))
            : [sessionId];
          enqueueWriteToTargets(targets, data);
        }}
      />

      {/* 进度窗口覆盖在终端上方 */}
      {showProgress && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
          <ConnectionProgress
            visible={showProgress}
            steps={connectionSteps}
            onClose={handleCloseProgress}
            onRetry={handleRetryConnection}
            onCancel={isConnectingState ? handleCancelConnection : undefined}
          />
        </div>
      )}
    </div>
  );
}
