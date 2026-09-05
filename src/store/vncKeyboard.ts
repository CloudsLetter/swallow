import { create } from 'zustand';

/**
 * VNC 键盘独占标记：noVNC 聚焦时置位，Layout 的应用级快捷键
 * （新建/关闭/切换标签）检测到标记后让路，按键完整流向远端桌面。
 * 点击工具栏（桌面容器外）自动释放，点击桌面区域重新捕获。
 */
interface VncKeyboardStore {
  captured: boolean;
  setCaptured: (v: boolean) => void;
}

export const useVncKeyboard = create<VncKeyboardStore>((set) => ({
  captured: false,
  setCaptured: (v) => set({ captured: v }),
}));
