import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from './config';
import type { ThemeColors } from '../types/config';
import { applyThemeColors } from '../hooks/themeUtils';
import { defaultColors } from '../default/themeColors';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

let _mql: MediaQueryList | null = null;
let _mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;

/** 应用 WebView 界面缩放（1.0 = 100%）。失败静默（旧环境无该能力时 UI 仍可用）。 */
export async function applyUiScale(scale: number) {
  const clamped = Math.min(2.0, Math.max(0.5, scale));
  try {
    await getCurrentWebviewWindow().setZoom(clamped);
    // zoom 改变布局视口宽度：通知所有 TerminalView 重新 fit 并同步后端 PTY 尺寸
    window.dispatchEvent(new Event('resize'));
  } catch (e) {
    console.warn('Failed to set UI zoom:', e);
  }
}

/** 应用窗口毛玻璃效果（Windows）：none/acrylic/mica/blur。有效果时 body 背景透明透出毛玻璃。 */
export async function applyWindowEffect(effect: string) {
  // 有毛玻璃时：body 渐变背景改透明，让系统毛玻璃透出；关闭时恢复
  document.documentElement.classList.toggle('window-effect', effect !== 'none');
  try {
    await invoke('apply_window_effect', { effect });
  } catch (e) {
    console.warn('Failed to apply window effect:', e);
  }
}

interface ThemeStore {
  fontFamily: string;
  fontSize: number;
  uiScale: number;
  windowEffect: string;
  autoDetectSystemTheme?: boolean;

  isDarkMode: () => boolean;
  setFontFamilyStart: (f: string) => void;
  setFontSizeStart: (s: number) => void;
  setThemeMode: (m: boolean) => void;
  setActiveThemeId: (id: string, forDark?: boolean) => void;
  setFontFamily: (f: string) => void;
  setFontSize: (s: number) => void;
  setUiScale: (s: number) => void;
  setWindowEffect: (e: string) => void;
  syncFromConfig: () => void;
  doAutoDetectTheme: (e: any) => void;
  listenDarkModeChanges: () => void;
  unlistenDarkModeChanges: () => void;
  setAutoDetectSystemDarkMode: (e: boolean) => void;
}

export const useThemeStore = create<ThemeStore>()(
  persist((set, get) => ({
    themeMode: 'dark',
    activeLightThemeId: null,
    activeDarkThemeId: null,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 14,
    uiScale: 1.0,
    windowEffect: 'none',

    setThemeMode: (m: boolean) => {
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (cfg) {
        cfgStore.updateConfig({
          ...cfg,
          appearance: { ...cfg.appearance, auto_detect_system_theme: m },
        });
      }
      set({ autoDetectSystemTheme: m });
    },

    isDarkMode() {
     return window.matchMedia('(prefers-color-scheme: dark)').matches
    },

    setActiveThemeId: (id: string) => {
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (!cfg) return;

      cfgStore.updateConfig({
        ...cfg,
        appearance: { ...cfg.appearance, active_theme_id: id },
      });

    const preset = cfg.appearance.themes.find((t) => t.id === id);
    
    if (preset) {
      applyThemeColors(preset.colors as ThemeColors, { themeId: id });
    }else {
      applyThemeColors(defaultColors as ThemeColors, { themeId: 'default-theme-dark' });
    }

  },


    setFontFamilyStart: (f: string) => {
        document.documentElement.style.setProperty('--app-font-family', f);
    },

    setFontSizeStart: (s: number) => {
        document.documentElement.style.setProperty('--app-font-size', `${s}px`);
    },


    setFontFamily: (f: string) => {
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (cfg) {
        cfgStore.updateConfig({
          ...cfg,
          appearance: { ...cfg.appearance, font_family: f },
        });
      }
      // apply immediately
      try {
        document.documentElement.style.setProperty('--app-font-family', f);
      } catch {}
      set({ fontFamily: f });
    },

    setFontSize: (s: number) => {
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (cfg) {
        cfgStore.updateConfig({
          ...cfg,
          appearance: { ...cfg.appearance, font_size: s },
        });
      }
      try {
        document.documentElement.style.setProperty('--app-font-size', `${s}px`);
      } catch {}
      set({ fontSize: s });
    },

    setUiScale: (s: number) => {
      const clamped = Math.min(2.0, Math.max(0.5, s));
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (cfg) {
        cfgStore.updateConfig({
          ...cfg,
          appearance: { ...cfg.appearance, ui_scale: clamped },
        });
      }
      set({ uiScale: clamped });
      void applyUiScale(clamped);
    },

    setWindowEffect: (e: string) => {
      const cfgStore = useConfigStore.getState();
      const cfg = cfgStore.config;
      if (cfg) {
        cfgStore.updateConfig({
          ...cfg,
          appearance: { ...cfg.appearance, window_effect: e },
        });
      }
      set({ windowEffect: e });
      void applyWindowEffect(e);
    },

    syncFromConfig: () => {
      const cfg = useConfigStore.getState().config;
      if (!cfg) return;
      const a = cfg.appearance;
      set({
        autoDetectSystemTheme: a.auto_detect_system_theme,
        fontFamily: a.font_family,
        fontSize: a.font_size,
        uiScale: a.ui_scale ?? 1.0,
        windowEffect: a.window_effect ?? 'none',
      });
      // 启动/配置同步时应用界面缩放与窗口效果
      void applyUiScale(a.ui_scale ?? 1.0);
      void applyWindowEffect(a.window_effect ?? 'none');
    },

    doAutoDetectTheme: (e: any) => {
      const cfg = useConfigStore.getState().config;
      if (!cfg?.appearance.auto_detect_system_theme) return;

      let themeId = '';
        if (e.matches) {
          themeId = 'default-theme-dark';
        } else {
          themeId = 'default-theme-light';
        }
      get().setActiveThemeId(themeId);
    },

  listenDarkModeChanges: () => {
  if (_mql) return;
  _mql = window.matchMedia('(prefers-color-scheme: dark)');
  _mqlHandler = (e: MediaQueryListEvent) => get().doAutoDetectTheme(e);

  if (typeof _mql.addEventListener === 'function') {
    _mql.addEventListener('change', _mqlHandler);
  } else if (typeof (_mql as any).addListener === 'function') {
    (_mql as any).addListener(_mqlHandler);
  }
},

unlistenDarkModeChanges: () => {
  if (!_mql || !_mqlHandler) return;

  if (typeof _mql.removeEventListener === 'function') {
    _mql.removeEventListener('change', _mqlHandler);
  } else if (typeof (_mql as any).removeListener === 'function') {
    (_mql as any).removeListener(_mqlHandler);
  }

  _mql = null;
  _mqlHandler = null;
},

setAutoDetectSystemDarkMode(e: boolean) {

  const cfg = useConfigStore.getState().config;
  if (!cfg) return;
  useConfigStore.getState().updateConfig({
    ...cfg,
    appearance: { ...cfg.appearance, auto_detect_system_theme: e },
  });



  
  if (e) {
      const themeId = useThemeStore.getState().isDarkMode()
      ? 'default-theme-dark'
      : 'default-theme-light';
      get().setActiveThemeId(themeId);

      get().listenDarkModeChanges();

  } else {
      get().unlistenDarkModeChanges();
  }


},


  }), { name: 'swallow-theme' })
);

export default useThemeStore;
