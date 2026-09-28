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
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { copyText } from '../lib/clipboard';
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
  /** 远端操作系统探测结果（连接成功后、shell 建立前） */
  onOsDetected?: (os: string) => void;
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
  // 标记右键粘贴监听是否已绑定（须在 terminal.open() 之后，element 才存在）
  rightClickBound?: boolean;
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
  // 连接早期（组件 handlers 未注册时）到达的 osDetected 结果，注册时回放
  pendingOs?: string;
  // 自动重连状态（会话级，跨组件实例，避免分屏重挂载后丢失计数）
  reconnectAttempts?: number;
  silentReconnect?: boolean;
  // 本次会话是否曾成功连上（progress ready 置位）：意外断开通知据此跳过「从未连上的失败」，
  // 避免首次连接失败的 error/断开也打扰用户
  everConnected?: boolean;
  // 输出缓冲：handlers 尚未注册时（挂载竞态/重挂载间隙）到达的会话输出先缓存，
  // registerEventHandlers 时回放，保证连接早期输出（Last login / motd）不丢失
  pendingOutputs?: string[];
  // 缓存中已累计的字节数（避免逐条 join 求长的 O(n²)）
  pendingOutputBytes?: number;
  // —— 输出背压水位（noteOutputQueued/noteOutputDrained 维护）——
  // write 已下发未解析完的字节数（write 回调触发即该块解析完成）
  outputInflight?: number;
  // 已通知后端暂停读取（SSH 路径产生 TCP 背压；其余会话类型后端 no-op）
  outputPaused?: boolean;
  // —— 渲染引擎管理（WebGL 上下文预算）——
  // 当前挂载的 WebglAddon（切换/卸载引擎时 dispose；context 丢失时重建）
  renderAddon?: WebglAddon;
  // WebGL context 连续丢失次数（激活标签时清零；>3 次退回 DOM 直到重新激活）
  contextLossRetries?: number;
  // 终端是否处于激活标签（激活标签才持 WebGL context——浏览器有 ~8-16 个
  // WebGL context 硬上限，超限最老的被静默驱逐 → 黑屏）
  isVisible?: boolean;
  // 实际生效的渲染引擎（配置选 webgl 但 GPU 关/加载失败时降级 dom；canvas 暂时禁用同走 dom）
  renderEngine?: TerminalRenderEngine;
  // 缓冲区查找 addon（查找条通过 getSearchAddon 拿实例调 findNext/findPrevious）
  search?: SearchAddon;
  // 会话内容序列化 addon（复制全部缓冲：copyTerminalBufferToClipboard）
  serialize?: SerializeAddon;
  // 查找快捷键回调：组件挂载时 setFindToggleHandler 注册，触发查找条开/关
  onFindToggle?: () => void;
  // 右键菜单请求回调：TerminalView 注册后右键走自定义菜单（x/y 为视口坐标）
  onContextMenuRequest?: (x: number, y: number) => void;
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

/** 设置渲染引擎 addon（先卸载现有渲染 addon，切换/重建共用此入口）。
 *  - dom：不加载任何 addon（xterm 内置默认）；
 *  - canvas：⚠️ 暂时禁用——已随 xterm 6.0 卸载依赖（TODO(xterm 6): addon 无 6.x 兼容版、停更于 5.x 线），
 *    偏好降级 dom；官方出 6.x 版后：pnpm add @xterm/addon-canvas，再在下方恢复 CanvasAddon 加载分支；
 *  - webgl：仅当 gpu 开关开启时尝试 WebglAddon（6.0 配套 0.19.0），失败降级 dom（不回退 canvas）。
 *  GPU 驱动重置/显存换页导致 context 丢失时自动重建，反复丢失（>3 次）退回 DOM 直到重新激活。
 *  返回实际生效的引擎。 */
function applyRenderAddon(
  sessionId: string,
  engine: TerminalRenderEngine,
  gpu: boolean,
): TerminalRenderEngine {
  const item = pool[sessionId];
  if (!item) return 'dom';
  if (item.renderAddon) {
    try {
      item.renderAddon.dispose();
    } catch {
      // context 已丢失的 addon dispose 可能抛错，忽略
    }
    item.renderAddon = undefined;
  }
  if (engine !== 'webgl' || !gpu) return 'dom';
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      if (item.renderAddon === addon) item.renderAddon = undefined;
      const retries = (item.contextLossRetries ?? 0) + 1;
      item.contextLossRetries = retries;
      console.warn(`[${sessionId}] WebGL context 丢失（驱动重置/显存换页），第 ${retries} 次重建`);
      if (retries > 3) {
        console.warn(`[${sessionId}] WebGL context 反复丢失，退回 DOM 渲染（重新激活标签时重试）`);
        return;
      }
      if (pool[sessionId]) {
        item.renderEngine = applyRenderAddon(sessionId, 'webgl', true);
      }
    });
    item.terminal.loadAddon(addon);
    item.renderAddon = addon;
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
  pool[sessionId] = item;
  if (render) {
    item.renderEngine = applyRenderAddon(sessionId, render.engine, render.gpu);
  }
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

/** 注册/清除右键菜单请求回调（TerminalView 挂载时注册，卸载时清空）。 */
export function setContextMenuHandler(sessionId: string, cb: ((x: number, y: number) => void) | undefined) {
  const item = pool[sessionId];
  if (item) item.onContextMenuRequest = cb;
}

/** 取右键菜单请求回调（bindRightClickPaste 内部消费）。 */
export function getContextMenuHandler(sessionId: string): ((x: number, y: number) => void) | undefined {
  return pool[sessionId]?.onContextMenuRequest;
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
  await copyText(text);
  return true;
}

/** 序列化当前 xterm 缓冲，供会话回放保存定位快照。
 *  scrollbackLines：纳入序列化的回滚行数；洪泛期传 0（仅视口）——
 *  万行级全量拼接是渲染回调热路径上最大的纯 JS 块。 */
export function serializeTerminalBuffer(sessionId: string, scrollbackLines?: number): string | undefined {
  const addon = pool[sessionId]?.serialize;
  if (!addon) return undefined;
  try {
    return addon.serialize({ scrollback: scrollbackLines ?? 10000 });
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
    // 优先走统一 copyText（Tauri 剪贴板插件 + 可选自动清除），
    // 失败回退 navigator.clipboard。
    copyText(text).catch(() => navigator.clipboard.writeText(text).catch(() => {}));
  }
}

export function copySessionSelection(sessionId: string): boolean {
  const terminal = pool[sessionId]?.terminal;
  if (!terminal || !terminal.hasSelection()) return false;
  copySelection(terminal);
  return true;
}

export function selectWordAtCursor(sessionId: string): void {
  const term = pool[sessionId]?.terminal as unknown as { selectWord?: () => void } | undefined;
  term?.selectWord?.();
}

export function selectAllSession(sessionId: string): void {
  pool[sessionId]?.terminal.selectAll();
}

export async function pasteToSession(sessionId: string): Promise<void> {
  const terminal = pool[sessionId]?.terminal;
  if (terminal) await pasteToTerminal(terminal);
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

// 输入直发：单次按键直接 IPC，不再 15ms 微批等待。
// 旧微批（WRITE_BATCH_MS=15）的问题：每次按键固定 +15ms 发出延迟，
// 连续输入时按键在批里排队攒批 → 体感「一顿一顿」。IPC 洪泛防护改由
// 下面的串行队列承担（同会话同时只在途一个 invoke，按序完成）。
const WRITE_BATCH_MAX = 256 * 1024;

/** 按会话类型分流的单次写。 */
function sendToSession(id: string, payload: string) {
  const st = getSessionType(id);
  if (st === 'telnet') return telnetWrite(id, payload);
  if (st === 'local') return localShellWrite(id, payload);
  if (st === 'serial') return serialWrite(id, payload);
  if (st === 'mosh') return moshWrite(id, payload);
  return sshWrite(id, payload);
}

/**
 * 向目标会话写入数据（广播/单会话通用）：按各会话协议类型分流 ssh/telnet/local 命令，
 * 经会话级写队列串行化（高频输入不压垮后端 IPC）。替代各处手写 targets+分流+enqueue 重复块。
 *
 * 时序语义（按键实时性的关键）：
 * - 短输入（单次按键/短串，≤64 字符）直接进串行队列立即发送，不攒批、不等待；
 * - 长输入（粘贴/宏/补全补全，>64 字符）才按 256KB 切片分段，避免单次 IPC 过大阻塞队列。
 */
const WRITE_DIRECT_MAX = 64;

export function enqueueWriteToTargets(targets: string[], data: string) {
  for (const id of targets) {
    // 会话日志记录：输入按目标会话记录（广播时每个接收会话都记，语义准确）；
    // 录制未开启时 appendInput 内部直接返回。
    appendInput(id, data);
    if (data.length <= WRITE_DIRECT_MAX) {
      enqueueWrite(id, () =>
        sendToSession(id, data).catch((error: unknown) => {
          console.error(`Failed to write to terminal (${id}):`, error);
        }),
      );
      continue;
    }
    // 长输入分片：每片独立入队，保持顺序（append 序=发送序）
    for (let i = 0; i < data.length; i += WRITE_BATCH_MAX) {
      const chunk = data.slice(i, i + WRITE_BATCH_MAX);
      enqueueWrite(id, () =>
        sendToSession(id, chunk).catch((error: unknown) => {
          console.error(`Failed to write to terminal (${id}):`, error);
        }),
      );
    }
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
    // 缓冲区查找（默认 Ctrl+Shift+F，可自定义）；回调由 TerminalView 注册
    const bindFind = shortcutOrDefault(sc?.terminal_find, 'Ctrl+Shift+F');
    if (matchesShortcut(event, bindFind)) {
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
      // 会话级标记与全局通知（不依赖组件 handlers——非激活/后台会话断开时无组件在听）
      if (event.kind === 'progress' && event.stage === 'ready') {
        const pi = pool[sessionId];
        if (pi) pi.everConnected = true;
      }
      // 意外断线：只有「本会话曾成功连上」才算（首次连接失败的断开不打扰）。
      // disposeTerminal 会先 unlisten，用户主动关闭不会走到这里 → 无需额外意图标记。
      if (event.kind === 'disconnected') {
        const pi = pool[sessionId];
        if (pi?.everConnected) {
          window.dispatchEvent(
            new CustomEvent('swallow:session-disconnected', { detail: { sessionId } }),
          );
        }
      }
      // 输出统一走 deliverOutput：事件与二进制 IPC 通道两条路共用
      //（日志缓冲 + handlers 缺位缓冲 + rAF 合并渲染都在里面）
      if (event.kind === 'output') {
        deliverOutput(sessionId, event.data);
        return;
      }
      const handlers = pool[sessionId]?.eventHandlers;
      if (!handlers) {
        // osDetected 同样可能早于事件监听建立（连接早期 emit）——缓存待注册回放，
        // 否则竞态下会「时灵时不灵」（某发行版图标不出现）
        if (event.kind === 'osDetected') {
          const itemRef = pool[sessionId];
          if (itemRef && !itemRef.pendingOs) itemRef.pendingOs = event.os;
        }
        return;
      }
      switch (event.kind) {
        case 'disconnected':
          handlers.onDisconnect();
          break;
        case 'error':
          handlers.onError(event.message);
          break;
        case 'progress':
          handlers.onProgress?.(event.stage);
          break;
        case 'osDetected':
          handlers.onOsDetected?.(event.os);
          break;
      }
    });
  } catch (e) {
    // ignore if not available in environment
  }
}

/** 会话输出统一入口（事件与二进制 IPC 通道共用）：
 *  先喂会话日志缓冲（不经 React，高频也不影响渲染），再经 rAF 合并渲染分发；
 *  handlers 未注册（连接早期竞态/重挂载间隙）时先进缓冲、注册时回放——
 *  否则 Last login / motd 等早期输出会丢失。仅缓存 output，限长约 1MB 防爆。 */
export function deliverOutput(sessionId: string, data: string) {
  appendOutput(sessionId, data);
  const handlers = pool[sessionId]?.eventHandlers;
  if (!handlers) {
    const itemRef = pool[sessionId];
    if (itemRef) {
      // 长度用计数器累计：join 全量求长在连接早期洪泛窗口是 O(n²)
      if (itemRef.pendingOutputBytes === undefined) {
        itemRef.pendingOutputs = [];
        itemRef.pendingOutputBytes = 0;
      }
      if (itemRef.pendingOutputBytes + data.length <= 1024 * 1024) {
        itemRef.pendingOutputs!.push(data);
        itemRef.pendingOutputBytes += data.length;
      }
    }
    return;
  }
  queueOutput(pool[sessionId], data, handlers.onOutput);
}

// —— 输出背压（流控）水位 ——
// xterm.write 异步解析，回调触发即该块解析完成；回调滞后量即积压。
// 超高水位 → 通知后端暂停读 socket（SSH 路径产生 TCP 背压，其余类型后端 no-op），
// 低于低水位恢复。积压期间顺带做一次性 DOM→WebGL 渲染升级（GPU 允许时）。
const OUTPUT_PAUSE_HIGH_BYTES = 4 * 1024 * 1024;
const OUTPUT_RESUME_LOW_BYTES = 1 * 1024 * 1024;

/** 输出块入队：积压超高水位时触发后端暂停与渲染升级。 */
export function noteOutputQueued(sessionId: string, bytes: number) {
  const item = pool[sessionId];
  if (!item) return;
  item.outputInflight = (item.outputInflight ?? 0) + bytes;
  if (!item.outputPaused && item.outputInflight >= OUTPUT_PAUSE_HIGH_BYTES) {
    item.outputPaused = true;
    void invoke('ssh_set_output_paused', { sessionId, paused: true }).catch(() => {});
    emitFloodEvent(sessionId, true);
    maybeUpgradeRenderer(sessionId);
  }
}

/** 输出块解析完成：积压低于低水位时恢复后端读取。 */
export function noteOutputDrained(sessionId: string, bytes: number) {
  const item = pool[sessionId];
  if (!item) return;
  item.outputInflight = Math.max(0, (item.outputInflight ?? 0) - bytes);
  if (item.outputPaused && item.outputInflight < OUTPUT_RESUME_LOW_BYTES) {
    item.outputPaused = false;
    void invoke('ssh_set_output_paused', { sessionId, paused: false }).catch(() => {});
    emitFloodEvent(sessionId, false);
  }
}

// 洪泛状态变化广播：热路径降级决策（背景层暂停 blur 等）在组件侧监听
const emitFloodEvent = (sessionId: string, active: boolean) => {
  window.dispatchEvent(new CustomEvent('swallow:output-flood', { detail: { sessionId, active } }));
};

/** 输出洪泛中（流控暂停或积压仍高）：快照瘦身 / 背景层减负等热路径降级决策用。 */
export function isOutputFlooded(sessionId: string): boolean {
  const item = pool[sessionId];
  if (!item) return false;
  return item.outputPaused === true || (item.outputInflight ?? 0) >= OUTPUT_RESUME_LOW_BYTES;
}

/** 洪泛期渲染升级：仅激活标签——后台标签不可见，DOM 渲染零合成成本且不占
 *  WebGL context 预算，升级无意义；用户显式关 GPU 则尊重配置。 */
function maybeUpgradeRenderer(sessionId: string) {
  const item = pool[sessionId];
  if (!item || !item.isVisible || item.renderEngine === 'webgl') return;
  const cfg = useConfigStore.getState().config;
  if (!cfg?.terminal?.gpu_acceleration) return;
  item.renderEngine = applyRenderAddon(sessionId, 'webgl', true);
  if (item.renderEngine === 'webgl') {
    console.info(`[${sessionId}] 输出洪泛：渲染引擎 DOM → WebGL`);
  }
}

/** 标签激活：恢复可见标记与用户配置的目标引擎，清 context 丢失重试计数。
 *  背景：浏览器 WebGL context 有 ~8-16 个硬上限，超限最老的被静默驱逐（黑屏）——
 *  只有激活标签持 WebGL，后台标签降级 DOM（不可见时 DOM 零渲染成本）。 */
export function activateTerminalRenderer(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  item.isVisible = true;
  item.contextLossRetries = 0;
  const cfg = useConfigStore.getState().config;
  const want = cfg?.terminal?.render_engine ?? 'dom';
  const gpu = cfg?.terminal?.gpu_acceleration ?? true;
  // canvas 6.x 无兼容 addon，视同 dom
  const target = want === 'webgl' ? 'webgl' : 'dom';
  if (item.renderEngine !== target) {
    item.renderEngine = applyRenderAddon(sessionId, target, gpu);
  }
}

/** 标签转后台：卸载 WebGL context 让出预算。 */
export function deactivateTerminalRenderer(sessionId: string) {
  const item = pool[sessionId];
  if (!item) return;
  item.isVisible = false;
  if (item.renderEngine === 'webgl') {
    item.renderEngine = applyRenderAddon(sessionId, 'dom', false);
  }
}

/** 注册会话事件回调：组件每次挂载时调用，覆盖旧实例的 stale 回调。 */
export function registerEventHandlers(sessionId: string, handlers: TerminalEventHandlers) {
  const item = pool[sessionId];
  if (!item) return;
  item.eventHandlers = handlers;
  // 回放连接早期到达的 OS 探测结果（osDetected emit 早于事件监听建立时可能被缓存）
  if (item.pendingOs && handlers.onOsDetected) {
    const os = item.pendingOs;
    item.pendingOs = undefined;
    try {
      handlers.onOsDetected(os);
    } catch (e) {
      console.warn(`[${sessionId}] Failed to replay pending os:`, e);
    }
  }
  // 回放缓冲的早期输出（连接成功到组件注册之间的 motd / Last login 等），
  // 回放后清空，避免重复（同样走 rAF 合并渲染，避免一次性 N 次 write 卡顿）
  if (item.pendingOutputs && item.pendingOutputs.length > 0) {
    const pending = item.pendingOutputs;
    item.pendingOutputs = [];
    item.pendingOutputBytes = 0;
    for (const chunk of pending) {
      queueOutput(item, chunk, (data) => {
        try {
          handlers.onOutput(data);
        } catch (e) {
          console.warn(`[${sessionId}] Failed to replay pending output:`, e);
        }
      });
    }
  }
}

/**
 * 输出合并渲染：同一帧内到达的多个 Output 事件攒成一次 terminal.write。
 * 旧路径每个事件一次 write → 高频输出（cat 大文件/vim 重绘）时每秒上百次
 * write + 回调，DOM 渲染器逐次重排 → 体感「跳跃」。rAF 合并后每帧最多一次 write，
 * 与浏览器刷新率对齐，输出如流水。回调（replay 快照）只在合并后的整块上跑一次。
 */
type OutputQueue = { chunks: string[]; scheduled: boolean; handler: (data: string) => void };

const outputQueues = new Map<string, OutputQueue>();

/** 反查 sessionId（pool key）。线性扫描仅在输出事件路径触发，开销可忽略。 */
function findSessionId(item: PoolItem): string | undefined {
  for (const k of Object.keys(pool)) {
    if (pool[k] === item) return k;
  }
  return undefined;
}

function queueOutput(
  item: PoolItem | undefined,
  data: string,
  handler: (data: string) => void,
) {
  if (!item) {
    handler(data);
    return;
  }
  const sessionId = findSessionId(item);
  if (!sessionId) {
    handler(data);
    return;
  }
  let q = outputQueues.get(sessionId);
  if (!q) {
    q = { chunks: [], scheduled: false, handler };
    outputQueues.set(sessionId, q);
  }
  q.handler = handler;
  q.chunks.push(data);
  if (q.scheduled) return;
  q.scheduled = true;
  requestAnimationFrame(() => {
    const cur = outputQueues.get(sessionId);
    outputQueues.delete(sessionId);
    if (!cur || cur.chunks.length === 0) return;
    const merged = cur.chunks.length === 1 ? cur.chunks[0] : cur.chunks.join('');
    try {
      cur.handler(merged);
    } catch (e) {
      console.error(`[${sessionId}] Failed to write merged output:`, e);
    }
  });
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
  // 绑定依赖 terminal.element 的监听（右键粘贴）——必须 open() 之后 element 才存在
  bindRightClickPaste(sessionId, item.terminal);
  return item.terminal;
}

/**
 * 右键行为（Windows Terminal / PuTTY 惯例 + 自定义菜单）：
 * - 注册了 onContextMenuRequest（TerminalView 常驻注册）→ 一律走自定义右键菜单；
 * - 未注册时回退旧行为：right_click_selects_word 优先选词，right_click_pastes 粘贴。
 * capture 阶段监听：先于 xterm 内部的 mousedown 处理执行，粘贴不被其吞掉。
 */
function bindRightClickPaste(sessionId: string, terminal: Terminal) {
  const item = pool[sessionId];
  const termEl = terminal.element;
  if (!item || !termEl || item.rightClickBound) return;
  item.rightClickBound = true;

  termEl.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 2) return;
      const menuCb = pool[sessionId]?.onContextMenuRequest;
      if (menuCb) {
        event.preventDefault();
        event.stopPropagation();
        menuCb(event.clientX, event.clientY);
        return;
      }
      const cfg = useConfigStore.getState().config;
      if (cfg?.terminal?.right_click_selects_word) return; // 右键选词优先
      if (!cfg?.terminal?.right_click_pastes) return; // 右键粘贴开关
      // 阻止 WebView 默认（系统菜单已在 App 全局禁用），并截断事件让 xterm
      // 不再做右键相关处理（清选区等），随后立即粘贴
      event.preventDefault();
      event.stopPropagation();
      terminal.focus();
      void pasteToTerminal(terminal);
    },
    true,
  );
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
