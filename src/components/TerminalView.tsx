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
import { acceptHostKey, sshConnect, disconnectSsh, telnetConnect, telnetDisconnect, localShellConnect, localShellDisconnect, serialConnect, serialDisconnect, moshConnect, moshDisconnect } from '../services/sessionService';
import { touchHostLastConnected, getHosts, updateHost } from '../services/dataService';
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
import { useBroadcastStore } from '../store/broadcast';
import { usePanelStore } from '../store/panelStore';
import { useTabStore } from '../store/tabStore';
import { recordCommand, suggestCommands } from '../services/commandHistory';
import { localPlatformOsId } from './osLogo';
import { buildPanelTheme } from './panelTheme';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  ArrowDown as IconArrowDown,
  ArrowUp as IconArrowUp,
  X as IconX,
} from 'lucide-react';
import type { ISearchOptions } from '@xterm/addon-search';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

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

export type TerminalConnectMode = 'ssh' | 'telnet' | 'local' | 'serial' | 'mosh';

/** 构建连接进度步骤（tcp/ssh/auth/shell/ready），顺序与后端 Progress 事件一致。 */
function buildConnectionSteps(
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
    result = await moshConnect(sessionId, moshConfig, cols, rows);
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

interface TerminalViewProps {
  sessionId?: string;
  sshConfig?: TerminalSshConfig;
  telnetConfig?: TerminalTelnetConfig;
  localConfig?: TerminalLocalConfig;
  serialConfig?: TerminalSerialConfig;
  /** MOSH 会话：引导走 SSH（字段同 SSH 配置），数据面走 UDP（mosh-rs） */
  moshConfig?: TerminalSshConfig;
  // 标签是否处于激活状态（keep-alive 下用于切回时重新 fit 终端）
  isActive?: boolean;
  // 外部尺寸变化信号（分屏拖分隔条后递增），触发重新 fit + resize PTY
  resizeSignal?: number;
  // 跳过自动连接（恢复的无密码密码类会话：等待用户手动重连）
  skipAutoConnect?: boolean;
}

export function TerminalView({ sessionId, sshConfig, telnetConfig, localConfig, serialConfig, moshConfig, isActive = true, resizeSignal, skipAutoConnect }: TerminalViewProps) {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const terminalRef = useRef<HTMLDivElement>(null);
  const isAttachedRef = useRef(false);
  // 右侧功能面板「查找」按钮的定向打开请求（悬浮操作栏已整体并入面板）
  const findRequest = usePanelStore((s) => s.findRequest);

  // —— 缓冲区查找（SearchAddon 由 terminalPool 统一挂载，这里只做 UI 与状态）——
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState('');
  const [findResult, setFindResult] = useState<{
    resultIndex: number;
    resultCount: number;
  } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findEverOpenedRef = useRef(false);

  // —— 自动补全（对标 Termius：命令历史 + 静态词库候选浮层）——
  // onData 只绑定一次，闭包只能读 ref；state 仅镜像渲染（updateSuggest 双写防 stale）。
  // top 为浮层相对容器顶部的 px 定位（先贴输入行下方，渲染后按真实高度校正翻转）
  const [suggest, setSuggest] = useState<{ items: string[]; sel: number; top: number | null } | null>(null);
  const suggestRef = useRef<{ items: string[]; sel: number; top: number | null } | null>(null);
  const suggestPanelRef = useRef<HTMLDivElement>(null);
  /** 当前正在输入的命令行缓冲（可打印字符/退格维护，回车提交历史） */
  const inputBufRef = useRef('');
  const updateSuggest = (next: { items: string[]; sel: number; top: number | null } | null) => {
    const cur = suggestRef.current;
    if (cur === null && next === null) return;
    if (
      cur &&
      next &&
      cur.sel === next.sel &&
      cur.top === next.top &&
      cur.items.length === next.items.length &&
      cur.items.every((c, i) => c === next.items[i])
    ) {
      return;
    }
    suggestRef.current = next;
    setSuggest(next);
  };
  /** 命令自动补全总开关（config 镜像到 ref——onData 只绑一次，闭包内读 ref 防 stale） */
  const autocompleteRef = useRef(true);
  useEffect(() => {
    autocompleteRef.current = config?.terminal?.autocomplete_enabled ?? true;
    if (!autocompleteRef.current) {
      inputBufRef.current = '';
      updateSuggest(null);
    }
  }, [config?.terminal?.autocomplete_enabled]);

  // 读取 xterm 行度量（行高 = .xterm-screen 视口高度/行数；cursorY 为视口内光标行）
  const readRowMetrics = (): { rowH: number; cursorY: number; containerH: number } | null => {
    const el = terminalRef.current;
    const poolItem = sessionId ? createOrGetTerminal(sessionId) : undefined;
    const term = poolItem?.terminal;
    if (!el || !term || term.rows <= 0) return null;
    const screen = el.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen || !screen.offsetHeight) return null;
    const rowH = screen.offsetHeight / term.rows;
    if (!rowH || rowH <= 0) return null;
    return { rowH, cursorY: term.buffer.active.cursorY, containerH: el.offsetHeight };
  };

  /** 输入行下方的基准定位（不检查溢出，溢出由渲染后校正翻转） */
  const measureBaseTop = (): number | null => {
    const m = readRowMetrics();
    return m ? (m.cursorY + 1) * m.rowH : null;
  };

  // 窗口/面板缩放：浮层开着时按新行高重新定位（溢出校正交给下方 effect）
  useEffect(() => {
    const el = terminalRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const current = suggestRef.current;
      if (!current || current.top === null) return;
      const base = measureBaseTop();
      if (base !== null && base !== current.top) {
        updateSuggest({ ...current, top: base });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
    // biome-ignore lint/correctness/useExhaustiveDependencies: 观察容器 resize 即可
  }, [sessionId]);

  // 浮层渲染后：用真实面板高度校正——贴行下方会溢出容器底部时翻到输入行上方。
  // （顶部空间也不足时保持原位，避免与校正 effect 抖动）
  useEffect(() => {
    if (!suggest || !suggestPanelRef.current || suggest.top === null) return;
    const panelH = suggestPanelRef.current.offsetHeight;
    const m = readRowMetrics();
    if (!panelH || !m) return;
    if (suggest.top + panelH <= m.containerH + 1) return;
    const flipped = Math.max(0, m.cursorY * m.rowH - panelH);
    if (flipped !== suggest.top) {
      updateSuggest({ ...suggest, top: flipped });
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: 每次浮层内容/位置变化都校正一次
  }, [suggest]);

  // SSH 日志由设置中的开关控制：连接前自动开始，断开时由生命周期收尾。
  const sessionLabel = sshConfig
    ? `${sshConfig.username}@${sshConfig.host}`
    : moshConfig
      ? `${moshConfig.username}@${moshConfig.host}`
      : 'terminal';

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
  // 面板「查找」请求：匹配当前会话时打开查找条（消费后立即清除）
  useEffect(() => {
    if (!findRequest || !sessionId || findRequest.sessionId !== sessionId) return;
    usePanelStore.getState().clearFindRequest();
    findEverOpenedRef.current = true;
    setFindOpen(true);
  }, [findRequest, sessionId]);

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

  // 终端浮层（自动补全）跟随终端主题配色：以终端背景/前景/亮度派生局部 CSS 变量
  const activeThemeColors =
    config?.terminal?.themes?.find((t) => t.id === config.terminal.active_theme_id)?.colors ??
    config?.terminal?.themes?.[0]?.colors;
  const panelTheme = buildPanelTheme(
    terminalBackground,
    activeThemeColors?.foreground ?? null,
    !!config?.terminal?.background_image,
    extendToTopbar,
  );
  /** CSS 变量注入用（CSSProperties 类型不允许 --xxx 索引） */
  const panelVars = panelTheme.style as Record<string, string>;

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
        const isTelnet = !!telnetConfig && !sshConfig && !localConfig && !serialConfig && !moshConfig;
        const isLocal = !!localConfig && !sshConfig && !telnetConfig && !serialConfig && !moshConfig;
        const isSerial = !!serialConfig && !sshConfig && !telnetConfig && !localConfig && !moshConfig;
        const isMosh = !!moshConfig && !sshConfig && !telnetConfig && !localConfig && !serialConfig;
        setSessionType(
          sessionId,
          isTelnet ? 'telnet' : isLocal ? 'local' : isSerial ? 'serial' : isMosh ? 'mosh' : 'ssh',
        );

        // 附加到 DOM
        attachTerminal(sessionId, terminalRef.current);
        isAttachedRef.current = true;

        // 检查是否已经连接 / 正在连接
        const alreadyConnected = isConnected(sessionId);
        const currentlyConnecting = checkIsConnecting(sessionId);

        // 无 SSH/telnet/local/serial/mosh 配置：无法发起连接，仅显示欢迎信息
        if (!sshConfig && !telnetConfig && !localConfig && !serialConfig && !moshConfig) {
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
          const mode: TerminalConnectMode = isTelnet ? 'telnet' : isLocal ? 'local' : isSerial ? 'serial' : isMosh ? 'mosh' : 'ssh';
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
                { shell: localConfig!.shell, wslDistro: localConfig!.wslDistro },
                cols,
                rows,
              );
            } else if (isMosh) {
              // MOSH：SSH 引导（含主机密钥确认），数据面走 UDP
              connectResult = await connectMoshWithHostKeyApproval(sessionId, moshConfig!, cols, rows, t);
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
            markConnected(true);
            setIsConnectingState(false);
            resetReconnectAttempts(sessionId);
            // 在线状态走内存 + 最近连接时间落库（SSH 会话）
            if (sshConfig?.host) {
              useOnlineHosts.getState().connect(sshConfig.host, sshConfig.port);
              if (!silentReconnect) {
                touchHostLastConnected(sshConfig.host, sshConfig.port).catch(() => {});
              }
            } else if (moshConfig?.host) {
              useOnlineHosts.getState().connect(moshConfig.host, moshConfig.port);
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
          // 按当前输入行重新计算候选并刷新浮层（先贴输入行下方，溢出由渲染后校正）
          const recomputeSuggest = () => {
            if (!autocompleteRef.current) {
              updateSuggest(null);
              return;
            }
            const line = inputBufRef.current;
            if (line.length < 2) {
              updateSuggest(null);
              return;
            }
            const items = suggestCommands(line);
            if (items.length === 0) {
              updateSuggest(null);
              return;
            }
            updateSuggest({ items, sel: 0, top: measureBaseTop() });
          };

          terminal.onData((data: string) => {
            // 广播开启时，把输入同时发送到所有已连接的会话（ssh/telnet 各自走对应命令）
            const targets = useBroadcastStore.getState().enabled
              ? listPool().filter((id) => isConnected(id))
              : [sessionId];

            // —— 自动补全浮层打开时的键处理（吃键不转发）——
            const suggestion = suggestRef.current;
            if (suggestion) {
              if (data === '\x1b[A' || data === '\x1b[B') {
                // ↑/↓ 切换候选（循环）
                const delta = data === '\x1b[A' ? -1 : 1;
                const sel =
                  (suggestion.sel + delta + suggestion.items.length) % suggestion.items.length;
                updateSuggest({ ...suggestion, sel });
                return;
              }
              if (data === '\x1b') {
                // Esc：关闭浮层并放弃当前行缓冲（避免继续输入又弹回）
                inputBufRef.current = '';
                updateSuggest(null);
                return;
              }
              if (data === '\r') {
                // 回车：补全并执行 = 退格撤销已输入部分 → 候选全文 + 回车
                const chosen = suggestion.items[suggestion.sel] ?? suggestion.items[0];
                const backspaces = '\x7f'.repeat([...inputBufRef.current].length);
                enqueueWriteToTargets(targets, backspaces + chosen + '\r');
                recordCommand(chosen);
                inputBufRef.current = '';
                updateSuggest(null);
                return;
              }
            }

            // —— 输入行跟踪（命令历史 + 补全前缀）——
            if (data === '\r') {
              const line = inputBufRef.current;
              if (line.trim()) recordCommand(line);
              inputBufRef.current = '';
              updateSuggest(null);
              enqueueWriteToTargets(targets, data);
              return;
            }
            if (data === '\x7f' || data === '\x08') {
              // 退格：只截断尾字符；中途编辑光标位置无法追踪，前缀匹配以尾段为准
              inputBufRef.current = inputBufRef.current.slice(0, -1);
              recomputeSuggest();
              enqueueWriteToTargets(targets, data);
              return;
            }
            if (data.startsWith('\x1b') || /[\x00-\x1f]/.test(data)) {
              // 控制序列（方向键/进入 vim 等全屏程序）或粘贴含换行：行语境不可追踪 → 放弃缓冲
              inputBufRef.current = '';
              updateSuggest(null);
              enqueueWriteToTargets(targets, data);
              return;
            }
            // 普通可打印输入
            inputBufRef.current += data;
            if (inputBufRef.current.length > 200) inputBufRef.current = '';
            recomputeSuggest();
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
            // 本机（local）会话没有远端可探测：连接就绪时按本机平台直接标识系统
            if (stage === 'ready' && localConfig) {
              const { tabs, updateTab } = useTabStore.getState();
              const tab = tabs.find((t) => t.sessionId === sessionId);
              if (tab && !tab.osId) updateTab(tab.id, { osId: localPlatformOsId() });
            }
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
          onOsDetected: (os: string) => {
            // 连接成功后探测到远端 OS。图标采用「手动 > 探测」：
            // ①若该主机已手动设置图标（host.icon 非空）→ 尊重手动设置，标签显示它，
            //   探测结果不覆盖主机图标；
            // ②主机未设置任何图标 → 标签显示探测 os，并回写 host.icon 供主机列表用。
            const { tabs, updateTab } = useTabStore.getState();
            const tab = tabs.find((t) => t.sessionId === sessionId);
            const targetHost = sshConfig?.host ?? moshConfig?.host;
            const targetPort = sshConfig?.port ?? moshConfig?.port;
            if (!targetHost) return;
            void (async () => {
              try {
                const hosts = await getHosts();
                const host = hosts.find(
                  (h) => h.host === targetHost && h.port === (targetPort ?? 22),
                );
                if (host?.icon) {
                  // 手动/已设置图标：标签与之一致（os: 走 osId；图片直接透传），不触碰
                  if (host.icon.startsWith('os:')) {
                    const manualOs = host.icon.slice(3);
                    if (tab && (tab.osId !== manualOs || tab.customIcon)) {
                      updateTab(tab.id, { osId: manualOs, customIcon: undefined });
                    }
                  } else if (tab && tab.customIcon !== host.icon) {
                    updateTab(tab.id, { customIcon: host.icon, osId: undefined });
                  }
                  return;
                }
                // 未设置：标签用探测 os
                if (tab && tab.osId !== os) updateTab(tab.id, { osId: os });
                if (host) {
                  await updateHost(host.id, { icon: `os:${os}` });
                  window.dispatchEvent(new Event('hosts:icons-changed'));
                }
              } catch {
                // 主机回写失败不影响终端
              }
            })();
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
  }, [sessionId, sshConfig, moshConfig, localConfig]);

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

      {/* 自动补全浮层：贴输入命令行（光标行下方/上方，避免溢出）；配色跟随终端主题；
          ↑/↓ 选择、Enter 补全并执行、Esc 关闭、鼠标点选执行 */}
      {suggest && !showProgress && (
        <div
          ref={suggestPanelRef}
          className="absolute left-1.5 z-30 max-w-[70%] overflow-hidden rounded-md border border-border bg-background/95 shadow-md"
          style={{
            // 终端主题变量注入（可解析时覆盖底色/文字；解析失败则保持应用默认 class 兜底）
            ...(panelTheme.style as Record<string, string>),
            ...(panelVars['--sidebar'] ? { backgroundColor: 'var(--sidebar)' } : {}),
            ...(panelVars['--sidebar-foreground'] ? { color: 'var(--sidebar-foreground)' } : {}),
            ...(suggest.top !== null ? { top: suggest.top } : { bottom: 8 }),
          }}
        >
          <div className="flex max-h-44 flex-col overflow-y-auto py-0.5">
            {suggest.items.map((cmd, index) => (
              <button
                key={cmd}
                type="button"
                // mousedown 先行：避免点击导致 xterm 失焦/选中
                onMouseDown={(e) => {
                  e.preventDefault();
                  // 点击 = 补全并执行（与 Enter 一致）
                  const backspaces = '\x7f'.repeat([...inputBufRef.current].length);
                  const targets = useBroadcastStore.getState().enabled
                    ? listPool().filter((id) => isConnected(id))
                    : [sessionId ?? ''];
                  enqueueWriteToTargets(targets, backspaces + cmd + '\r');
                  recordCommand(cmd);
                  inputBufRef.current = '';
                  updateSuggest(null);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1 text-left font-mono text-xs',
                  index === suggest.sel ? 'bg-sidebar-accent text-foreground' : 'hover:bg-sidebar-accent/60',
                )}
              >
                <span className="text-muted-foreground">{index + 1}</span>
                <span className="truncate">{cmd}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
            <span>↑↓ 选择</span>
            <span>Enter 执行</span>
            <span>Esc 关闭</span>
          </div>
        </div>
      )}

      {/* 缓冲区查找条（Ctrl+Shift+F / 面板「查找」打开；Enter 下一个、Shift+Enter 上一个、Esc 关闭） */}
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

      {/* 快捷指令已并入右侧功能面板（openRightSection('commands')），此处不再有弹窗 */}

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
