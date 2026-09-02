import { ThemeColors } from "../types/config";

// 前端兜底默认色（现代靛蓝 Indigo · 暗色），与 Rust 后端 dark_theme 保持一致。
export const defaultColors: ThemeColors = {
  primary: '#818cf8',
  primary_light: '#a5b4fc',
  primary_dark: '#6366f1',

  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  info: '#22d3ee',

  text_primary: '#eef2ff',
  text_muted: '#94a3b8',
  text_secondary: '#cbd5e1',
  text_tertiary: '#64748b',
  text_disabled: '#475569',
  text_placeholder: '#64748b',
  text_link: '#a5b4fc',

  bg_primary: '#0f172a',
  surface: '#1e293b',
  surface_elevated: '#273449',

  btn_primary_bg: '#818cf8',
  btn_primary_text: '#1e1b4b',
  btn_primary_hover: '#a5b4fc',
  btn_secondary_bg: '#273449',
  btn_secondary_text: '#e2e8f0',
  btn_danger_bg: '#e11d48',
  btn_danger_text: '#ffffff',

  border_primary: '#334155',
  border_focus: '#818cf8',
  input_bg: '#1e293b',
  input_text: '#eef2ff',
  input_placeholder: '#64748b',
  control_disabled_bg: '#1e293b',
  control_disabled_text: '#64748b',
  focus_ring: '#818cf8',

  topbar_bg: '#0f172a',
  tab_bg: '#1e293b',
  tab_bg_active: '#273449',
  tab_text_color: '#94a3b8',
  tab_text_color_active: '#eef2ff',
  tab_icon_color: '#64748b',
  tab_icon_color_active: '#a5b4fc',
  tab_border_color: '#334155',
  window_control_btn_icon_color: '#94a3b8',

  context_menu_bg: '#1e293b',
  context_menu_border: '#334155',
  context_menu_shadow: 'rgba(2, 6, 23, 0.50)',
  context_menu_item_text: '#e2e8f0',
  context_menu_item_hover: '#273449',
  context_menu_item_disabled: '#64748b',

  sidemenu_bg: '#111c33',
  menu_border_primary: '#334155',
  sidemenu_text: '#94a3b8',
  sidemenu_text_active: '#eef2ff',

  scrollbar_track: '#0f172a',
  scrollbar_thumb: '#334155',
  scrollbar_thumb_hover: '#475569',
  overlay: 'rgba(2, 6, 23, 0.72)',
  divider: '#334155',

  selected_bg: '#3730a3',
  selected_text: '#c7d2fe',
  hover_bg: '#273449',
  active_bg: '#312e81',

  shadow_sm: '0 1px 2px rgba(2, 6, 23, 0.34)',
  shadow_md: '0 14px 30px rgba(2, 6, 23, 0.28)',
  shadow_lg: '0 24px 48px rgba(2, 6, 23, 0.36)',
  shadow_xl: '0 36px 72px rgba(2, 6, 23, 0.42)',

  high_contrast_text: '#ffffff',

  panel_bg: '#1e293b',
  panel_border: '#334155',
};
