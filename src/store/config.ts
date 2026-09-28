import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "../types/config";

// 串行保存队列：保证多次 updateConfig 落盘顺序与提交顺序一致，
// 避免并发 invoke 乱序导致旧配置覆盖新配置。
let saveChain: Promise<void> = Promise.resolve();

// 落盘去抖：滑条类设置（字号/透明度/模糊）拖动时每帧触发 updateConfig，
// 逐次全量写 config.toml 是磁盘写放大——500ms 内合并为最后一次快照。
// loadConfig/saveConfig 前先冲刷挂起的保存，避免读到旧盘状态后被覆盖。
let saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: Config | null = null;

function flushPendingSave(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = undefined;
  }
  const snapshot = pendingSave;
  pendingSave = null;
  if (!snapshot) return;
  saveChain = saveChain
    .catch(() => undefined)
    .then(() => invoke<void>("update_config", { config: snapshot }))
    .catch((e) => console.error("Failed to save config:", e));
}

interface ConfigState {
  config: Config | null;
  loading: boolean;
  error?: string;

  // actions
  loadConfig: () => Promise<void>;
  setConfig: (config: Config) => void;
  updateConfig: (patch: Partial<Config>) => void;
  saveConfig: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,

  /* =======================
   * Load from Rust
   * ======================= */
  loadConfig: async () => {
    set({ loading: true, error: undefined });

    try {
      // 冲刷挂起的去抖保存并等待落盘完成，避免重新加载读到旧状态后再被覆盖
      flushPendingSave();
      await saveChain.catch(() => undefined);

      set({ config: null });
      const config = await invoke<Config>("get_config");

      set({ config });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /* =======================
   * Replace whole config
   * ======================= */
  setConfig: (config) => set({ config }),

  /* =======================
   * Shallow patch update
   * ======================= */
  updateConfig: (patch) => {
    set((state) => ({
      config: state.config
        ? { ...state.config, ...patch }
        : state.config,
    }));

    const snapshot = get().config;
    if (!snapshot) return;

    // 入队去抖保存：pendingSave 恒指向最新快照，500ms 无新变更才统一落盘
    pendingSave = snapshot;
    if (!saveDebounceTimer) {
      saveDebounceTimer = setTimeout(flushPendingSave, 500);
    }
  },

  /* =======================
   * Save to Rust
   * ======================= */
  saveConfig: async () => {
    const config = get().config;
    if (!config) return;

    // 显式保存：冲刷挂起的去抖快照，再把当前内存态入队，最后等待链空
    pendingSave = config;
    flushPendingSave();
    await saveChain.catch(() => undefined);
  },
}));
