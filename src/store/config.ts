import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "../types/config";

// 串行保存队列：保证多次 updateConfig 落盘顺序与提交顺序一致，
// 避免并发 invoke 乱序导致旧配置覆盖新配置。
let saveChain: Promise<void> = Promise.resolve();

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
      // 等待尚未完成的保存落盘，避免重新加载读到旧状态后再被覆盖
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

    // 入队保存；每次保存入队时的快照，保证顺序
    saveChain = saveChain
      .catch(() => undefined)
      .then(() => invoke<void>("update_config", { config: snapshot }))
      .catch((e) => {
        console.error("Failed to save config:", e);
        set({ error: String(e) });
      });
  },

  /* =======================
   * Save to Rust
   * ======================= */
  saveConfig: async () => {
    const config = get().config;
    if (!config) return;

    saveChain = saveChain
      .catch(() => undefined)
      .then(() => invoke<void>("update_config", { config }))
      .catch((e) => {
        set({ error: String(e) });
      });
    await saveChain;
  },
}));
