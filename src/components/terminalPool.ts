import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { ImageAddon } from '@xterm/addon-image';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  sshWrite,
  sshResize,
  telnetWrite,
  localShellWrite,
  localShellResize,
  serialWrite,
  moshWrite,
  moshResize,
} from '../services/sessionService';
import type { SessionEvent } from '../types/session';
import { useConfigStore } from '../store/config';
import { matchesShortcut, shortcutOrDefault } from '../lib/hotkeys';
import { appendOutput, appendInput, forceStopSessionLog } from './sessionLog';

export interface ConnectionStep {
  id: string;
  label: string;
  status: 'pending' | 'loading' | 'success' | 'error';
  message?: string;
}

/** 会话事件回调集合：当前挂载组件注册的最新回调，事件监听据此转发。 */
interface TerminalEventHandlers {
  onOutput: (data: string) => void;
  onDisconnect: () => void;
  onError: (msg: string) => void;
  onProgress?: (stage: string) => void;
}

type PoolItem = {
  terminal: Terminal;
  fit: FitAddon;
  attachedEl: HTMLElement | null;
  // 延迟复核字体加载/浏览器重排后的单元格宽度，避免最后一列被裁剪
  fitCorrectionRaf?: number;
  fitCorrectionTimer?: number;
  // tauri session 事件监听器的取消函数（pool 存在期间保留）
  unlistenSession?: () => void;
  // 标记 onData 是否已绑定
  onDataBound?: boolean;
  // 标记复制/粘贴/铃声等交互是否已绑定
  interactionsBound?: boolean;
  // 标记 SSH 连接状态
  isConnected?: boolean;
  // 标记是否正在连接
  isConnecting?: boolean;
  // 保存连接进度状态
  connectionSteps?: ConnectionStep[];
  // 保存连接函数引用（用于重试/自动重连）
  connectFunction?: () => Promise<void>;
  // 保存进度窗口显示状态
  showProgress?: boolean;
  // 会话事件回调（当前挂载组件注册；分屏重挂载后由新组件覆盖，避免 stale closure）
  eventHandlers?: TerminalEventHandlers;
  // 自动重连状态（会话级，跨组件实例，避免分屏重挂载后丢失计数）
  reconnectAttempts?: number;
  silentReconnect?: boolean;
  // 输出缓冲：handlers 尚未注册时（挂载竞态/重挂载间隙）到达的会话输出先缓存，
  // registerEventHandlers 时回放，保证连接早期输出（Last login / motd）不丢失
  pendingOutputs?: string[];
  // 实际生效的渲染引擎（配置选 webgl 但 GPU 关/加载失败时降级 dom；canvas 暂时禁用同走 dom）
  renderEngine?: TerminalRenderEngine;
  // 缓冲区查找 addon（查找条通过 getSearchAddon 拿实例调 findNext/findPrevious）
  search?: SearchAddon;
  // 会话内容序列化 addon（复制全部缓冲：copyTerminalBufferToClipboard）
  serialize?: SerializeAddon;
  // 查找快捷键回调：组件挂载时 setFindToggleHandler 注册，触发查找条开/关
  onFindToggle?: () => void;
};

/** xterm 渲染引擎（与后端 config.terminal.render_engine 对齐）。 */
export type TerminalRenderEngine = 'dom' | 'canvas' | 'webgl';

const pool: Record<string, PoolItem> = {};

// 每会话的输入写入串行队列：长按会产生高频 onData，串行化避免并发 sshWrite
// （IPC 洪泛）压垮后端，进而导致连接被对端断开。
const writeQueues: Record<string, Promise<unknown>> = {};

// 会话协议类型（ssh / telnet / local），广播写入时据此选择正确的后端命令
const sessionTypes: Record<string, 'ssh' | 'telnet' | 'local' | 'serial' | 'mosh'> = {};

// 最近一次已发出的 PTY 尺寸，避免一次 fit 触发多个重复 IPC。
const lastPtyResize: Record<string, string> = {};

export function setSessionType(sessionId: string, type: 'ssh' | 'telnet' | 'local' | 'serial' | 'mosh') {
  sessionTypes[sessionId] = type;
}

export function getSessionType(sessionId: string): 'ssh' | 'telnet' | 'local' | 'serial' | 'mosh' {
  return sessionTypes[sessionId] ?? 'ssh';
}

/** 按偏好加载 xterm 渲染引擎 addon（open 前 load，xterm open 时按注册渲染器绘制）。
 *  - dom：不加载任何 addon（xterm 内置默认）；
 *  - canvas：⚠️ 暂时禁用——已随 xterm 6.0 卸载依赖（TODO(xterm 6): addon 无 6.x 兼容版、停更于 5.x 线），
 *    偏好降级 dom；官方出 6.x 版后：pnpm add @xterm/addon-canvas，再在下方恢复 CanvasAddon 加载分支；
 *  - webgl：仅当 gpu 开关开启时尝试 WebglAddon（6.0 配套 0.19.0），失败降级 dom（不回退 canvas）。
 *  返回实际生效的引擎。 */
function applyRenderAddon(
  terminal: Terminal,
  engine: TerminalRenderEngine,
  gpu: boolean,
): TerminalRenderEngine {
  if (engine === 'dom' || engine === 'canvas' || !gpu) return 'dom';
  try {
    terminal.loadAddon(new WebglAddon());
    return 'webgl';
  } catch (e) {
    console.warn('[render] WebGL 渲染引擎加载失败，降级 DOM:', e);
    return 'dom';
  }
}

export function createOrGetTerminal(
  sessionId: string,
  options?: ITerminalOptions,
  render?: { engine: TerminalRenderEngine; gpu: boolean },
) {
  if (pool[sessionId]) return pool[sessionId];

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    allowProposedApi: true,
    ...options,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  // Unicode 11 宽度表（老款稳定 addon）：activate 只 register '11' provider、不切换
  // activeVersion。实际生效宽度规则由下方 unicode-graphemes 决定（自动切
  // '15-graphemes'，U15 表已覆盖 U11）；如需改用 U11 表需手动
  // terminal.unicode.activeVersion = '11'（会失去 grapheme cluster）。
  try {
    terminal.loadAddon(new Unicode11Addon());
  } catch (e) {
    console.warn('[unicode11] Unicode11Addon 加载失败:', e);
  }

  // 组合字形（ZWJ emoji/国旗等）宽度修正：官方 experimental addon，
  // activate 内部自动注册并切 activeVersion='15-graphemes'；
  // 依赖 allowProposedApi（new Terminal 已开，见下方 options），load 一次全局生效。
  try {
    terminal.loadAddon(new UnicodeGraphemesAddon());
  } catch (e) {
    console.warn('[unicode-graphemes] UnicodeGraphemesAddon 加载失败:', e);
  }

  // 可点击 URL：仅 Ctrl/Cmd+点击 打开（普通点击不劫持，避免误触/与框选冲突）。
  // open 前 load 即可，xterm open 时会对 buffer 做链接标注。
  try {
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        openUrl(uri).catch((e) => console.warn(`[web-links] 打开 ${uri} 失败:`, e));
      }),
    );
  } catch (e) {
    console.warn('[web-links] WebLinksAddon 加载失败:', e);
  }

  // 终端内嵌图片（SIXEL / iTerm2 协议）：被动 addon，仅在程序输出图片序列时激活。
  // 0.9.0 起 sixel 解码用内嵌 WASM，要求 WebView CSP script-src 含 'wasm-unsafe-eval'
  //（见 tauri.conf.json），否则解码被拦、图片不渲染。
  try {
    terminal.loadAddon(new ImageAddon());
  } catch (e) {
    console.warn('[image] ImageAddon 加载失败:', e);
  }

  // 缓冲区查找（findNext/findPrevious + 高亮装饰，查找条 UI 在 TerminalView）
  const search = new SearchAddon();
  terminal.loadAddon(search);
  // 会话内容序列化（「复制全部内容」：TerminalView 动作栏按钮触发）
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  // 所有 xterm.resize（窗口、分屏、字体重排、延迟校准）都从这里同步到真实 PTY。
  // 这比在各个调用点手工通知可靠：任何新增的 resize 路径也不会再漏同步。
  terminal.onResize(({ cols, rows }) => {
    notifyPtyResize(sessionId, cols, rows);
  });

  const item: PoolItem = { terminal, fit, search, serialize: serializeAddon, attachedEl: null };
  if (render) {
    item.renderEngine = applyRenderAddon(terminal, render.engine, render.gpu);
  }
  pool[sessionId] = item;
  return pool[sessionId];
}

/** 取会话的 SearchAddon 实例（无则 undefined），供查找条调 findNext/findPrevious。 */
export function getSearchAddon(sessionId: string): SearchAddon | undefined {
  return pool[sessionId]?.search;
}

/** 注册/清除「查找快捷键」回调（TerminalView 挂载时注册，卸载时清空）。 */
export function setFindToggleHandler(sessionId: string, cb: (() => void) | undefined) {
  const item = pool[sessionId];
  if (item) item.onFindToggle = cb;
}

/** 把键盘焦点还给 xterm（查找条关闭/点空白后调用）。 */
export function focusTerminal(sessionId: string) {
  pool[sessionId]?.terminal.focus();
}

/** 把当前会话完整缓冲（含滚动区）序列化为纯文本并复制到剪贴板；无 addon/空内容返回 false。 */
export async function copyTerminalBufferToClipboard(sessionId: string): Promise<boolean> {
  const addon = pool[sessionId]?.serialize;
  if (!addon) return false;
  // excludeModes：去掉 DECSET 等模式序列，得到干净文本（保留 alt buffer，所见即所得）
  const text = addon.serialize({ excludeModes: true });
  if (!text.trim()) return false;
  await writeText(text);
  return true;
}

/** 序列化当前 xterm 缓冲，供会话回放保存定位快照。 */
export function serializeTerminalBuffer(sessionId: string): string | undefined {
  const addon = pool[sessionId]?.serialize;
  if (!addon) return undefined;
  try {
    return addon.serialize({ scrollback: 10000 });
  } catch (e) {
    console.warn(`[${sessionId}] Failed to serialize terminal buffer:`, e);
    return undefined;
  }
}

/**
 * 将当前 xterm 尺寸同步到真实 PTY。
 * - SSH/local 有 PTY；telnet 没有窗口尺寸概念。
 * - 未连接时不发送，连接命令会使用 terminal.cols/rows 初始化 PTY。
 * - 同一尺寸只发一次；失败时清掉记录，下一次 resize 可重试。
 */
function notifyPtyResize(sessionId: string, cols: number, rows: number) {
  const item = pool[sessionId];
  if (!item?.isConnected || cols < 1 || rows < 1) return;

  const kind = getSessionType(sessionId);
  // mosh 无本地 PTY，但尺寸需经协议同步到 mosh-server（与 local/ssh 同等对待）
  const resize =
    kind === 'local'
      ? localShellResize
      : kind === 'ssh'
        ? sshResize
        : kind === 'mosh'
          ? moshResize
          : null;
  if (!resize) return;

  const key = `${cols}x${rows}`;
  if (lastPtyResize[sessionId] === key) return;
  lastPtyResize[sessionId] = key;

  resize(sessionId, cols, rows).catch((error: unknown) => {
    // 允许下一次尺寸变化重新尝试，避免瞬时 IPC/断线错误永久锁死同步。
    if (lastPtyResize[sessionId] === key) delete lastPtyResize[sessionId];
    console.warn(`[${sessionId}] PTY resize notify error:`, error);
  });
}

/** 连接成功后强制把当前尺寸发给 PTY，覆盖连接期间发生的布局变化。 */
export function syncPtySize(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  notifyPtyResize(sessionId, item.terminal.cols, item.terminal.rows);
}

/** 把终端外观配置（字体/光标/滚动等）动态应用到已存在的终端实例。 */
export function applyTerminalOptions(sessionId: string, options: ITerminalOptions) {
  const item = pool[sessionId];
  if (!item) return;
  try {
    item.terminal.options = options;
  } catch (e) {
    console.warn('Failed to apply terminal options', e);
  }
}

function copySelection(terminal: Terminal) {
  if (!terminal.hasSelection()) return;
  const text = terminal.getSelection();
  if (text) {
    // 优先走 Tauri 剪贴板插件（WebView 的 navigator.clipboard 读取不可靠），
    // 失败回退 navigator.clipboard。
    writeText(text).catch(() => navigator.clipboard.writeText(text).catch(() => {}));
  }
}

async function pasteToTerminal(terminal: Terminal) {
  let text = '';
  try {
    text = await readText();
  } catch {
    // 回退到 WebView 剪贴板 API
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = '';
    }
  }
  if (text) terminal.paste(text);
}

function playBellSound() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 800;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => void ctx.close();
  } catch {
    // 忽略音频不可用
  }
}

/**
 * 向目标会话写入数据（广播/单会话通用）：按各会话协议类型分流 ssh/telnet/local 命令，
 * 经会话级写队列串行化（高频输入不压垮后端 IPC）。替代各处手写 targets+分流+enqueue 重复块。
 */
export function enqueueWriteToTargets(targets: string[], data: string) {
  for (const id of targets) {
    // 会话日志记录：输入按目标会话记录（广播时每个接收会话都记，语义准确）；
    // 录制未开启时 appendInput 内部直接返回。
    appendInput(id, data);
    const write = () => {
      const st = getSessionType(id);
      if (st === 'telnet') return telnetWrite(id, data);
      if (st === 'local') return localShellWrite(id, data);
      if (st === 'serial') return serialWrite(id, data);
      if (st === 'mosh') return moshWrite(id, data);
      return sshWrite(id, data);
    };
    enqueueWrite(id, () =>
      write().catch((error: unknown) => {
        console.error(`Failed to write to terminal (${id}):`, error);
      }),
    );
  }
}

/**
 * 绑定终端复制/粘贴/全选与铃声交互（每个终端仅一次）。
 * - Ctrl+Shift+C 复制选区、Ctrl+Shift+V 粘贴、Ctrl+Shift+A 全选
 *   （Ctrl+C/V 在终端是 SIGINT / 字面量，不能占用）
 * - copy_on_select：选中即复制
 * - bell_style：visual 闪烁 / sound 提示音
 */
export function setupTerminalInteractions(sessionId: string) {
  const item = pool[sessionId];
  if (!item || item.interactionsBound) return;
  item.interactionsBound = true;
  const terminal = item.terminal;

  terminal.attachCustomKeyEventHandler((event) => {
    // 只在 keydown 处理，避免 keyup 重复触发
    if (event.type !== 'keydown') return true;

    // 复制/粘贴/全选键位可自定义（设置 → 快捷键），老配置缺字段时回退默认
    const sc = useConfigStore.getState().config?.shortcuts;
    const bindCopy = shortcutOrDefault(sc?.terminal_copy, 'Ctrl+Shift+C');
    const bindPaste = shortcutOrDefault(sc?.terminal_paste, 'Ctrl+Shift+V');
    const bindSelectAll = shortcutOrDefault(sc?.terminal_select_all, 'Ctrl+Shift+A');
    // 注意：这里与全局快捷键共用同一 KeyboardEvent 语义（ctrlKey/shiftKey/altKey/metaKey）
    if (matchesShortcut(event, bindCopy)) {
      copySelection(terminal);
      return false;
    }
    if (matchesShortcut(event, bindPaste)) {
      // preventDefault 阻止系统把剪贴板写入 xterm 隐藏输入框——否则同一快捷键会
      // 先走系统粘贴事件、再走我们手动粘贴，导致「粘贴两次」。
      event.preventDefault();
      void pasteToTerminal(terminal);
      return false;
    }
    if (matchesShortcut(event, bindSelectAll)) {
      event.preventDefault();
      terminal.selectAll();
      return false;
    }
    // 缓冲区查找（固定 Ctrl+Shift+F，与主流终端一致）；回调由 TerminalView 注册
    if (matchesShortcut(event, 'Ctrl+Shift+F')) {
      event.preventDefault();
      pool[sessionId]?.onFindToggle?.();
      return false;
    }
    return true;
  });

  terminal.onSelectionChange(() => {
    const cfg = useConfigStore.getState().config;
    if (cfg?.terminal?.copy_on_select) {
      copySelection(terminal);
    }
  });

  terminal.onBell(() => {
    const cfg = useConfigStore.getState().config;
    if (cfg?.terminal?.enable_bell === false) return;
    const style = cfg?.terminal?.bell_style ?? 'none';
    if (style === 'visual' || style === 'both') {
      const el = terminal.element;
      if (el) {
        el.classList.remove('xterm-bell-flash');
        // 强制回流以支持连续响铃时重播动画
        void el.offsetWidth;
        el.classList.add('xterm-bell-flash');
      }
    }
    if (style === 'sound' || style === 'both') {
      playBellSound();
    }
  });
}

export async function attachListeners(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  if (item.unlistenSession) return; // already attached

  try {
    item.unlistenSession = await listen<SessionEvent>(`session-${sessionId}`, (e) => {
      const event = e.payload;
      // 会话日志记录：输出在分发前先喂给日志缓冲（不经 React，高频也不影响渲染）。
      // 放在 handlers 判断之前，保证连接早期缓冲/重连间隙的输出也不漏记。
      if (event.kind === 'output') {
        appendOutput(sessionId, event.data);
      }
      // 事件监听只建立一次，但回调始终转发到「当前挂载组件注册的最新回调」，
      // 这样标签合并/分屏重挂载后，断线/进度事件仍指向新组件实例而非已卸载的旧实例。
      const handlers = pool[sessionId]?.eventHandlers;
      if (!handlers) {
        // handlers 未注册（连接早期竞态 / 组件重挂载间隙）：输出先进缓冲，
        // registerEventHandlers 时回放——否则 Last login / motd 等早期输出会丢失。
        // 仅缓存 output，且限长防爆（约 1MB 上限）。
        if (event.kind === 'output') {
          const itemRef = pool[sessionId];
          if (itemRef) {
            const buf = itemRef.pendingOutputs ?? (itemRef.pendingOutputs = []);
            if (buf.join('').length < 1024 * 1024) buf.push(event.data);
          }
        }
        return;
      }
      switch (event.kind) {
        case 'output':
          handlers.onOutput(event.data);
          break;
        case 'disconnected':
          handlers.onDisconnect();
          break;
        case 'error':
          handlers.onError(event.message);
          break;
        case 'progress':
          handlers.onProgress?.(event.stage);
          break;
      }
    });
  } catch (e) {
    // ignore if not available in environment
  }
}

/** 注册会话事件回调：组件每次挂载时调用，覆盖旧实例的 stale 回调。 */
export function registerEventHandlers(sessionId: string, handlers: TerminalEventHandlers) {
  const item = pool[sessionId];
  if (!item) return;
  item.eventHandlers = handlers;
  // 回放缓冲的早期输出（连接成功到组件注册之间的 motd / Last login 等），
  // 回放后清空，避免重复
  if (item.pendingOutputs && item.pendingOutputs.length > 0) {
    const pending = item.pendingOutputs;
    item.pendingOutputs = [];
    for (const chunk of pending) {
      try {
        handlers.onOutput(chunk);
      } catch (e) {
        console.warn(`[${sessionId}] Failed to replay pending output:`, e);
      }
    }
  }
}

export function unattachListeners(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  try { if (item.unlistenSession) item.unlistenSession(); } catch (e) {}
  item.unlistenSession = undefined;
}

export function attachTerminal(sessionId: string, container: HTMLElement) {
  const item = pool[sessionId];
  if (!item) return null;

  // 终端已经 open 过一次（有 element）时，xterm 的 open() 再次调用是 no-op（只同步
  // 浏览器 window，不会把 element 挂到新容器），必须手动移动已有 DOM 节点。
  // 否则标签合并/分屏重挂载后终端会脱离文档树，显示空白。
  const existingEl = item.terminal.element;
  if (existingEl) {
    if (existingEl.parentElement !== container) {
      container.appendChild(existingEl);
    }
  } else {
    item.terminal.open(container);
  }

  item.attachedEl = container;
  fitTerminal(sessionId);
  return item.terminal;
}

/**
 * 适配终端尺寸，并修正 FitAddon 在非整数 CSS 宽度下的末列裁剪。
 *
 * FitAddon 使用 dimensions.css.cell.width 计算 cols，而渲染器还会按 DPR
 * 把单元格栅格化到 device.cell.width。两者存在亚像素差时，误差会累积到
 * 最后一列，`w` 这类字形就会被 terminal-view 的 overflow:hidden 裁掉。
 * 以两种测量值中较大的一个重新预算列数，并保留 0.5px 栅格化余量，
 * 保证绘制宽度不会贴到 viewport 的裁剪边界。
 */
export function fitTerminal(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;

  try {
    // 先走官方实现，处理正常的行列适配以及字体/配置刚变化的情况。
    item.fit.fit();
    correctTerminalColumns(item);
    scheduleFitCorrection(item);
  } catch (e) {
    // 字体尚未完成测量或终端尚未挂载时，保留 FitAddon 的容错行为。
    console.warn(`[${sessionId}] Failed to fit terminal:`, e);
  }
}

type TerminalCoreForFit = {
  viewport?: { scrollBarWidth?: number };
  _renderService?: {
    dimensions?: {
      css?: { cell?: { width?: number } };
      device?: { cell?: { width?: number } };
    };
    clear?: () => void;
  };
};

// DOM 字形的抗锯齿/字体 hinting 可能在 cell 边界外占用约 1 个 CSS px。
// 余量太小会表现为：小窗口正常，窗口放大到某些列数时末列被裁半个字。
const CELL_EDGE_SAFETY_PX = 1.5;

/** 按实际渲染单元格宽度修正列数；不可测量时不干预原生 fit。 */
function correctTerminalColumns(item: PoolItem) {
  const element = item.terminal.element;
  const viewport = element?.querySelector<HTMLElement>('.xterm-viewport');
  if (!element || !viewport || viewport.clientWidth <= 0) return;

  const core = (item.terminal as unknown as { _core?: TerminalCoreForFit })._core;
  const dimensions = core?._renderService?.dimensions;
  const cssWidth = dimensions?.css?.cell?.width ?? 0;
  // xterm 5.5 暴露的是 device（物理像素）而不是 actual；换算回 CSS 像素后
  // 取较大值，避免 DPR 栅格化把最后一列推到裁剪边界。
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const deviceWidth = dimensions?.device?.cell?.width ?? 0;
  const deviceCssWidth = deviceWidth > 0 ? deviceWidth / dpr : 0;
  const cellWidth = Math.max(cssWidth, deviceCssWidth);
  if (!Number.isFinite(cellWidth) || cellWidth <= 0) return;

  // clientWidth 在传统滚动条下会扣除滚动条，但 Windows WebView 的覆盖式
  // scrollbar 不一定扣除；xterm 自己仍会用 fallback/实测值预留这段宽度。
  // 只补上 clientWidth 尚未扣掉的部分，避免文字叠到右侧 scrollbar 下方。
  const domScrollbarWidth = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
  const xtermScrollbarWidth = Math.max(0, core?.viewport?.scrollBarWidth ?? 0);
  const extraScrollbarWidth = Math.max(0, xtermScrollbarWidth - domScrollbarWidth);
  const availableWidth = viewport.clientWidth - extraScrollbarWidth;

  // 即使乘积数学上刚好等于边界，栅格化渲染与字体 hinting 仍可能
  // 向外取整，使最后一个字形（尤其是 w）被裁掉；保留 1.5px 安全余量。
  // 这可能让极少数临界宽度少一列，但不会把字符画到裁剪边界/滚动条下。
  const safeWidth = Math.max(0, availableWidth - CELL_EDGE_SAFETY_PX);
  const cols = Math.max(2, Math.floor(safeWidth / cellWidth));
  if (cols === item.terminal.cols) return;

  // xterm 的 resize 会触发渲染；clear 让旧渲染层不在重绘期间短暂残留。
  core?._renderService?.clear?.();
  item.terminal.resize(cols, item.terminal.rows);
}

/** 字体加载完成或 WebView 重排后再复核一次，覆盖首次 fit 时的旧字体度量。 */
function scheduleFitCorrection(item: PoolItem) {
  if (typeof window === 'undefined') return;
  if (item.fitCorrectionRaf !== undefined) cancelAnimationFrame(item.fitCorrectionRaf);
  if (item.fitCorrectionTimer !== undefined) clearTimeout(item.fitCorrectionTimer);

  item.fitCorrectionRaf = requestAnimationFrame(() => {
    item.fitCorrectionRaf = undefined;
    correctTerminalColumns(item);
    item.fitCorrectionTimer = window.setTimeout(() => {
      item.fitCorrectionTimer = undefined;
      correctTerminalColumns(item);
    }, 600);
  });
}

export function detachTerminal(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  // 不 dispose，保留实例和缓冲
  item.attachedEl = null;
  // 卸载后清空回调，避免组件已卸载后事件仍调用其 stale 闭包
  // （重挂载时会由 registerEventHandlers 重新注册）
  item.eventHandlers = undefined;
}

export function disposeTerminal(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  if (item.fitCorrectionRaf !== undefined) cancelAnimationFrame(item.fitCorrectionRaf);
  if (item.fitCorrectionTimer !== undefined) clearTimeout(item.fitCorrectionTimer);
  
  // 先取消所有监听器
  unattachListeners(sessionId);
  // 会话日志兜底：tab 关闭/销毁时若仍在记录则收尾刷盘（fire-and-forget）
  forceStopSessionLog(sessionId);
  
  // 销毁终端实例
  try { item.terminal.dispose(); } catch (e) {}
  delete pool[sessionId];
  delete writeQueues[sessionId];
  delete sessionTypes[sessionId];
  delete lastPtyResize[sessionId];
}

export function isOnDataBound(sessionId: string): boolean {
  const item = pool[sessionId];
  return item ? !!item.onDataBound : false;
}

export function markOnDataBound(sessionId: string, bound: boolean = true) {
  const item = pool[sessionId];
  if (item) {
    item.onDataBound = bound;
  }
}

export function isConnected(sessionId: string): boolean {
  const item = pool[sessionId];
  return item ? !!item.isConnected : false;
}

export function isConnecting(sessionId: string): boolean {
  const item = pool[sessionId];
  return item ? !!item.isConnecting : false;
}

export function markConnected(sessionId: string, connected: boolean = true) {
  const item = pool[sessionId];
  if (item) {
    item.isConnected = connected;
    if (connected) {
      item.isConnecting = false;
      // 连接期间窗口/分屏/字体可能已改变尺寸；此时必须覆盖连接命令使用的旧值。
      syncPtySize(sessionId);
    } else {
      delete lastPtyResize[sessionId];
    }
  }
}

export function markConnecting(sessionId: string, connecting: boolean = true) {
  const item = pool[sessionId];
  if (item) {
    item.isConnecting = connecting;
  }
}

export function getConnectionSteps(sessionId: string): ConnectionStep[] | undefined {
  const item = pool[sessionId];
  return item?.connectionSteps;
}

export function setConnectionSteps(sessionId: string, steps: ConnectionStep[]) {
  const item = pool[sessionId];
  if (item) {
    item.connectionSteps = steps;
  }
}

export function getConnectFunction(sessionId: string): (() => Promise<void>) | undefined {
  const item = pool[sessionId];
  return item?.connectFunction;
}

export function setConnectFunction(sessionId: string, fn: (() => Promise<void>) | null) {
  const item = pool[sessionId];
  if (item) {
    item.connectFunction = fn || undefined;
  }
}

export function getShowProgress(sessionId: string): boolean {
  const item = pool[sessionId];
  return item?.showProgress ?? false;
}

export function setShowProgress(sessionId: string, show: boolean) {
  const item = pool[sessionId];
  if (item) {
    item.showProgress = show;
  }
}

export function listPool() {
  return Object.keys(pool);
}

// ==================== 自动重连状态（会话级，跨组件实例） ====================

export function getReconnectAttempts(sessionId: string): number {
  return pool[sessionId]?.reconnectAttempts ?? 0;
}

export function incrementReconnectAttempts(sessionId: string): number {
  const item = pool[sessionId];
  if (!item) return 0;
  item.reconnectAttempts = (item.reconnectAttempts ?? 0) + 1;
  return item.reconnectAttempts;
}

export function resetReconnectAttempts(sessionId: string) {
  const item = pool[sessionId];
  if (item) item.reconnectAttempts = 0;
}

export function setSilentReconnect(sessionId: string, silent: boolean) {
  const item = pool[sessionId];
  if (item) item.silentReconnect = silent;
}

export function getSilentReconnect(sessionId: string): boolean {
  return pool[sessionId]?.silentReconnect ?? false;
}

/**
 * 串行化写入：长按高频触发 onData 时，前一个写入完成后再发下一个，
 * 避免大量并发 sshWrite（IPC 洪泛）压垮后端/连接。
 * 队列内单个失败不影响后续写入（错误由调用方在 write 内自行处理）。
 */
export function enqueueWrite(sessionId: string, write: () => Promise<unknown>): void {
  const prev = writeQueues[sessionId] ?? Promise.resolve();
  writeQueues[sessionId] = prev.then(write).catch(() => {});
}

export function clearWriteQueue(sessionId: string) {
  delete writeQueues[sessionId];
}
