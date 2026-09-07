import { create } from 'zustand';

/**
 * 全局面板状态（跨组件共享，供 Topbar / TerminalSidePanel / RightPanelBar 联动）：
 * - leftPanelOpen：终端左侧面板（状态/文件）开关。与 localStorage `swallow.terminalPanel.v1`
 *   的 open 字段双向同步（width/section 仍由 TerminalSidePanel 管理）；
 * - 右侧功能面板（快捷指令 / AI / 设置）：open / 宽度 / 分区持久化到
 *   localStorage `swallow.rightPanel.v1`。AI 与快捷指令原为悬浮抽屉/弹窗，
 *   现并入面板分区，Topbar AI 按钮与终端「快捷指令」按钮都经 openRightSection 跳转。
 */

const LEFT_PREFS_KEY = 'swallow.terminalPanel.v1';
const RIGHT_PREFS_KEY = 'swallow.rightPanel.v1';

export type RightPanelSection = 'commands' | 'ai' | 'settings';

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
        section: parsed.section === 'ai' || parsed.section === 'commands' ? parsed.section : 'settings',
      };
    }
  } catch {
    // 损坏数据按默认处理
  }
  return { open: false, width: 280, section: 'settings' };
}

interface PanelState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelSection: RightPanelSection;
  rightPanelWidth: number;
  setLeftPanelOpen: (v: boolean) => void;
  toggleLeftPanel: () => void;
  setRightPanelOpen: (v: boolean) => void;
  toggleRightPanel: () => void;
  setRightPanelSection: (s: RightPanelSection) => void;
  setRightPanelWidth: (w: number) => void;
  /** 打开右侧面板并切到指定分区；已在该分区时再调用 = 收起（按钮天然的开关语义） */
  openRightSection: (s: RightPanelSection) => void;
}

const initialRight = readRightPrefs();

export const usePanelStore = create<PanelState>((set) => ({
  leftPanelOpen: readLeftOpen(),
  rightPanelOpen: initialRight.open,
  rightPanelSection: initialRight.section,
  rightPanelWidth: initialRight.width,
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
      try {
        localStorage.setItem(RIGHT_PREFS_KEY, JSON.stringify({ open: v, width: s.rightPanelWidth, section: s.rightPanelSection }));
      } catch {
        // 忽略写入失败
      }
      return { rightPanelOpen: v };
    }),
  toggleRightPanel: () =>
    set((s) => {
      const open = !s.rightPanelOpen;
      try {
        localStorage.setItem(RIGHT_PREFS_KEY, JSON.stringify({ open, width: s.rightPanelWidth, section: s.rightPanelSection }));
      } catch {
        // 忽略写入失败
      }
      return { rightPanelOpen: open };
    }),
  setRightPanelSection: (section) =>
    set((s) => {
      try {
        localStorage.setItem(RIGHT_PREFS_KEY, JSON.stringify({ open: s.rightPanelOpen, width: s.rightPanelWidth, section }));
      } catch {
        // 忽略写入失败
      }
      return { rightPanelSection: section };
    }),
  setRightPanelWidth: (width) =>
    set((s) => {
      const w = clampRightWidth(width);
      try {
        localStorage.setItem(RIGHT_PREFS_KEY, JSON.stringify({ open: s.rightPanelOpen, width: w, section: s.rightPanelSection }));
      } catch {
        // 忽略写入失败
      }
      return { rightPanelWidth: w };
    }),
  openRightSection: (section) =>
    set((s) => {
      const shouldClose = s.rightPanelOpen && s.rightPanelSection === section;
      try {
        localStorage.setItem(
          RIGHT_PREFS_KEY,
          JSON.stringify({ open: !shouldClose, width: s.rightPanelWidth, section }),
        );
      } catch {
        // 忽略写入失败
      }
      return shouldClose
        ? { rightPanelOpen: false }
        : { rightPanelOpen: true, rightPanelSection: section };
    }),
}));
