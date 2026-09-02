import { useEffect } from 'react';
import { useConfigStore } from '../store/config';
import type { ThemeColors } from '../types/config';
import { applyThemeColors, applyScrollbarConfig } from './themeUtils';
import useThemeStore, { applyUiScale, applyWindowEffect } from '../store/themeStore';
import { defaultColors } from '../default/themeColors';

export function useTheme() {
  const config = useConfigStore((s) => s.config);

  useEffect(() => {
    if (!config) return;

    const appearance = config.appearance;
    const themeStore = useThemeStore.getState();

    themeStore.setFontFamilyStart(appearance.font_family);
    themeStore.setFontSizeStart(appearance.font_size);
    // 应用界面缩放（zoom 是 WebView 级持久状态，启动/配置变更都要显式校正）
    void applyUiScale(appearance.ui_scale ?? 1.0);
    // 应用窗口毛玻璃效果（Windows）
    void applyWindowEffect(appearance.window_effect ?? 'none');

    let themeId = appearance.active_theme_id;

    // 跟随系统亮暗：仅在仍使用默认主题时自动切换亮/暗；
    // 手动选择的主题（如玻璃主题）优先，不被自动检测覆盖
    if (
      config.appearance.auto_detect_system_theme &&
      (themeId === 'default-theme-dark' || themeId === 'default-theme-light')
    ) {
      themeId = themeStore.isDarkMode() ? 'default-theme-dark' : 'default-theme-light';
    }

    const preset = appearance.themes.find((t) => t.id === themeId);
    if (preset) {
      applyThemeColors(preset.colors as ThemeColors, { themeId });
    }else {
      applyThemeColors(defaultColors as ThemeColors, { themeId: 'default-theme-dark' });
    }

    // 应用滚动条配置（覆盖式开关 + 宽度）
    applyScrollbarConfig({
      scrollbar_overlay: appearance.scrollbar_overlay,
      scrollbar_width: appearance.scrollbar_width,
    });

    if (appearance.auto_detect_system_theme) {
      themeStore.listenDarkModeChanges();
      return () => {
        themeStore.unlistenDarkModeChanges();
      };
    }

    themeStore.unlistenDarkModeChanges();

  }, [config]);
}

export default useTheme;
