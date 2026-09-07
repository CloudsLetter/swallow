import { create } from 'zustand';

/**
 * 全局面板状态（跨组件共享，供 Topbar / TerminalSidePanel / RightPanelBar / TerminalView 联动）：
 * - leftPanelOpen：终端左侧面板（状态/文件）开关。与 localStorage `swallow.terminalPanel.v1`
 *   的 open 字段双向同步（width/section 仍由 TerminalSidePanel 管理）；
 * - 右侧功能面板（指令 / 终端 / 设置）：open / 宽度 / 分区持久化到
 *   localStorage `swallow.rightPanel.v1`。终端操作栏的悬浮按钮（复制全文/查找/广播/
 *   快捷指令）全部并入面板分区，快捷指令按钮经 openRightSection 跳转；
 * - aiOpen：AI 助手抽屉（独立 Sheet，不并入右面板）；
 * - findRequest：右面板「查找」按钮 → 定向打开对应终端会话的查找条（nonce 保证重复触发）。
 */

const LEFT_PREFS_KEY = 'swallow.terminalPanel.v1';
const RIGHT_PREFS_KEY = 'swallow.rightPanel.v1';

export type RightPanelSection = 'commands' | 'terminal' | 'settings';

const RIGHT_MIN_WIDTH = 200;
const RIGHT_MAX_WIDTH = 480;

function readLeftOpen(): boolean {
  try {
    const raw = localStorage.getItem(LEFT_PREFS_KEY);
    if (raw) return !!((JSON.parse(raw) as { open?: boolean }).open);
  } catch {
    // 损坏数据按默认展开处理
  }
  return true;
}

function persistLeftOpen(open: boolean) {
  try {
    const raw = localStorage.getItem(LEFT_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(LEFT_PREFS_KEY, JSON.stringify({ ...parsed, open }));
  } catch {
    // 忽略写入失败（隐私模式等）
  }
}

interface RightPrefs {
  open: boolean;
  width: number;
  section: RightPanelSection;
}

function clampRightWidth(w: number): number {
  return Math.min(RIGHT_MAX_WIDTH, Math.max(RIGHT_MIN_WIDTH, Math.round(w)));
}

function readRightPrefs(): RightPrefs {
  try {
    const raw = localStorage.getItem(RIGHT_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RightPrefs>;
      return {
        open: !!parsed.open,
        width: clampRightWidth(parsed.width ?? 280),
        section:
          parsed.section === 'commands' || parsed.section === 'terminal' ? parsed.section : 'settings',
      };
    }
  } catch {
    // 损坏数据按默认处理
  }
  return { open: false, width: 280, section: 'settings' };
}

function persistRightPrefs(prefs: RightPrefs) {
  try {
    localStorage.setItem(RIGHT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略写入失败
  }
}

let findNonce = 0;

interface PanelState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelSection: RightPanelSection;
  rightPanelWidth: number;
  aiOpen: boolean;
  findRequest: { sessionId: string; nonce: number } | null;
  setLeftPanelOpen: (v: boolean) => void;
  toggleLeftPanel: () => void;
  setRightPanelOpen: (v: boolean) => void;
  toggleRightPanel: () => void;
  setRightPanelSection: (s: RightPanelSection) => void;
  setRightPanelWidth: (w: number) => void;
  /** 打开右侧面板并切到指定分区；已在该分区时再调用 = 收起（按钮天然的开关语义） */
  openRightSection: (s: RightPanelSection) => void;
  setAiOpen: (v: boolean) => void;
  requestTerminalFind: (sessionId: string) => void;
  clearFindRequest: () => void;
}

const initialRight = readRightPrefs();

export const usePanelStore = create<PanelState>((set) => ({
  leftPanelOpen: readLeftOpen(),
  rightPanelOpen: initialRight.open,
  rightPanelSection: initialRight.section,
  rightPanelWidth: initialRight.width,
  aiOpen: false,
  findRequest: null,
  setLeftPanelOpen: (v) => {
    persistLeftOpen(v);
    set({ leftPanelOpen: v });
  },
  toggleLeftPanel: () =>
    set((s) => {
      persistLeftOpen(!s.leftPanelOpen);
      return { leftPanelOpen: !s.leftPanelOpen };
    }),
  setRightPanelOpen: (v) =>
    set((s) => {
      persistRightPrefs({ open: v, width: s.rightPanelWidth, section: s.rightPanelSection });
      return { rightPanelOpen: v };
    }),
  toggleRightPanel: () =>
    set((s) => {
      const open = !s.rightPanelOpen;
      persistRightPrefs({ open, width: s.rightPanelWidth, section: s.rightPanelSection });
      return { rightPanelOpen: open };
    }),
  setRightPanelSection: (section) =>
    set((s) => {
      persistRightPrefs({ open: s.rightPanelOpen, width: s.rightPanelWidth, section });
      return { rightPanelSection: section };
    }),
  setRightPanelWidth: (width) =>
    set((s) => {
      const w = clampRightWidth(width);
      persistRightPrefs({ open: s.rightPanelOpen, width: w, section: s.rightPanelSection });
      return { rightPanelWidth: w };
    }),
  openRightSection: (section) =>
    set((s) => {
      const shouldClose = s.rightPanelOpen && s.rightPanelSection === section;
      persistRightPrefs({ open: !shouldClose, width: s.rightPanelWidth, section });
      return shouldClose
        ? { rightPanelOpen: false }
        : { rightPanelOpen: true, rightPanelSection: section };
    }),
  setAiOpen: (v) => set({ aiOpen: v }),
  requestTerminalFind: (sessionId) =>
    set({ findRequest: { sessionId, nonce: ++findNonce } }),
  clearFindRequest: () => set({ findRequest: null }),
}));
