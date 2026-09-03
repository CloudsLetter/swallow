import { create } from 'zustand';

/**
 * 主机在线状态（纯内存，不落库、无 IPC）。
 * 键为 `${host}:${port}`，由会话生命周期写入：连接成功 → connect，断开 → disconnect。
 * 任何页面（快速链接 / 主机列表）都从这里派生状态点。
 */
interface OnlineHostsState {
  online: Set<string>;
  connect: (host: string, port: number) => void;
  disconnect: (host: string, port: number) => void;
  isOnline: (host: string, port: number) => boolean;
}

const key = (host: string, port: number) => `${host}:${port}`;

export const useOnlineHosts = create<OnlineHostsState>((set, get) => ({
  online: new Set(),
  connect: (host, port) =>
    set((s) => {
      const k = key(host, port);
      if (s.online.has(k)) return s;
      const next = new Set(s.online);
      next.add(k);
      return { online: next };
    }),
  disconnect: (host, port) =>
    set((s) => {
      const k = key(host, port);
      if (!s.online.has(k)) return s;
      const next = new Set(s.online);
      next.delete(k);
      return { online: next };
    }),
  isOnline: (host, port) => get().online.has(key(host, port)),
}));
