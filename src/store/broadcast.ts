import { create } from 'zustand';

/**
 * SSH 命令广播状态（全局，跨终端标签共享）。
 * 开启后，任意终端标签的键盘输入会同时发送到所有已连接的 SSH 会话，
 * 用于多台机器同步执行同一命令。
 */
interface BroadcastState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
  toggle: () => set((state) => ({ enabled: !state.enabled })),
}));
