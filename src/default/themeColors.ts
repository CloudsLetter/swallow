import { ThemeColors } from "../types/config";

// 前端兜底默认色（中性石墨 Zinc · 暗色，靛蓝仅点缀选中态/主按钮/焦点环），与 Rust 后端 dark_theme 保持一致。
export const defaultColors: ThemeColors = {
  primary: '#818cf8',
  primary_light: '#a5b4fc',
  primary_dark: '#6366f1',

  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  info: '#22d3ee',

  text_primary: '#f4f4f5',
  text_muted: '#a1a1aa',
  text_secondary: '#d4d4d8',
  text_tertiary: '#71717a',
  text_disabled: '#52525b',
  text_placeholder: '#71717a',
  text_link: '#a5b4fc',

  bg_primary: '#131316',
  surface: '#1b1b1f',
  surface_elevated: '#232329',

  btn_primary_bg: '#818cf8',
  btn_primary_text: '#1e1b4b',
  btn_primary_hover: '#a5b4fc',
  btn_secondary_bg: '#232329',
  btn_secondary_text: '#e4e4e7',
  btn_danger_bg: '#e11d48',
  btn_danger_text: '#ffffff',

  border_primary: '#2e2e34',
  border_focus: '#818cf8',
  input_bg: '#1b1b1f',
  input_text: '#f4f4f5',
  input_placeholder: '#71717a',
  control_disabled_bg: '#1b1b1f',
  control_disabled_text: '#71717a',
  focus_ring: '#818cf8',

  topbar_bg: '#131316',
  tab_bg: '#1b1b1f',
  tab_bg_active: '#232329',
  tab_text_color: '#a1a1aa',
  tab_text_color_active: '#f4f4f5',
  tab_icon_color: '#71717a',
  tab_icon_color_active: '#a5b4fc',
  tab_border_color: '#2e2e34',
  window_control_btn_icon_color: '#a1a1aa',

  context_menu_bg: '#232329',
  context_menu_border: '#2e2e34',
  context_menu_shadow: 'rgba(0, 0, 0, 0.55)',
  context_menu_item_text: '#e4e4e7',
  context_menu_item_hover: '#2b2b32',
  context_menu_item_disabled: '#71717a',

  sidemenu_bg: '#101014',
  menu_border_primary: '#2e2e34',
  sidemenu_text: '#a1a1aa',
  sidemenu_text_active: '#f4f4f5',

  scrollbar_track: '#131316',
  scrollbar_thumb: '#3f3f46',
  scrollbar_thumb_hover: '#52525b',
  overlay: 'rgba(9, 9, 11, 0.72)',
  divider: '#26262c',

  selected_bg: '#3730a3',
  selected_text: '#c7d2fe',
  hover_bg: '#232329',
  active_bg: '#2b2b32',

  shadow_sm: '0 1px 2px rgba(0, 0, 0, 0.35)',
  shadow_md: '0 14px 30px rgba(0, 0, 0, 0.30)',
  shadow_lg: '0 24px 48px rgba(0, 0, 0, 0.38)',
  shadow_xl: '0 36px 72px rgba(0, 0, 0, 0.45)',

  high_contrast_text: '#ffffff',

  panel_bg: '#1b1b1f',
  panel_border: '#2e2e34',
};
