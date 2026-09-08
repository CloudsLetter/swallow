import { create } from 'zustand';

/**
 * 「激活终端正在连接」全局标志：连接动画要覆盖到左右面板之上。
 * 布局据此把左面板压为 0 / 隐藏右面板，让终端内容区全宽承载连接动画
 * （比在面板上方叠 fixed 遮罩更可靠——不依赖层叠上下文）。
 */
interface AppConnectingState {
  active: boolean;
  setActive: (v: boolean) => void;
}

export const useAppConnecting = create<AppConnectingState>((set) => ({
  active: false,
  setActive: (v) => set({ active: v }),
}));
