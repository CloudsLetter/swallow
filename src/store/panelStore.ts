import { create } from 'zustand';

/**
 * 全局面板开关状态（跨组件共享，供 Topbar / TerminalSidePanel / QuickSettingsPanel 联动）：
 * - leftPanelOpen：终端左侧面板（状态/文件）开关。与 localStorage `swallow.terminalPanel.v1`
 *   的 open 字段双向同步（该 key 的 width/section 仍由 TerminalSidePanel 管理），
 *   使 Topbar 开关与面板自身的收起/展开按钮保持单一事实来源；
 * - rightPanelOpen：右侧快捷设置面板开关（纯内存，不持久化，默认关闭）；
 * - aiOpen：AI 助手抽屉开关（纯内存，默认关闭）。
 */

const LEFT_PREFS_KEY = 'swallow.terminalPanel.v1';

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

interface PanelState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  aiOpen: boolean;
  setLeftPanelOpen: (v: boolean) => void;
  toggleLeftPanel: () => void;
  setRightPanelOpen: (v: boolean) => void;
  toggleRightPanel: () => void;
  setAiOpen: (v: boolean) => void;
}

export const usePanelStore = create<PanelState>((set) => ({
  leftPanelOpen: readLeftOpen(),
  rightPanelOpen: false,
  aiOpen: false,
  setLeftPanelOpen: (v) => {
    persistLeftOpen(v);
    set({ leftPanelOpen: v });
  },
  toggleLeftPanel: () =>
    set((s) => {
      persistLeftOpen(!s.leftPanelOpen);
      return { leftPanelOpen: !s.leftPanelOpen };
    }),
  setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setAiOpen: (v) => set({ aiOpen: v }),
}));
