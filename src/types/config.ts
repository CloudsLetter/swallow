export interface Config {
  application: Application;
  cloud: Cloud;
  appearance: Appearance;
  terminal: Terminal;
  ssh: SshSettings;
  shortcuts: ShortcutBinding;
  security: Security;
  advanced: Advanced;
  file_version: FileVersion;
}

export interface Application {
  initialized: boolean;
  // 初次使用引导已完成
  onboarding_done?: boolean;
}

export interface FileVersion {
  version: string;
}

export interface Cloud {
  enabled: boolean;
  server_host: string;
  server_port: number;
  server_key: string;
  sync_policy: number; // 0: upload only, 1: download only, 2: bidirectional, 3: manual
  sync_interval: number;
  sync_hosts: boolean;
  sync_keys: boolean;
  sync_settings: boolean;
  sync_snippets: boolean;
}

export interface Appearance {
  auto_detect_system_theme: boolean;
  active_theme_id: string;
  themes: ThemePreset[];
  font_family: string;
  font_size: number;
  language: string;
  // 滚动条：覆盖式（不占布局宽度）与宽度（px）
  scrollbar_overlay: boolean;
  scrollbar_width: number;
  // 界面缩放（WebView zoom 倍率，1.0 = 100%）：低分辨率屏整体放大 UI
  ui_scale: number;
  // 窗口毛玻璃效果："none" | "acrylic" | "mica" | "blur"（Windows 专属）
  window_effect: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
  built_in: boolean;
}

export interface ThemeColors {
  // 主题色
  primary: string;
  primary_light: string;
  primary_dark: string;

  // 语义色
  success: string;
  warning: string;
  error: string;
  info: string;

  // 文本色
  text_primary: string;
  text_muted: string;
  text_secondary: string;
  text_tertiary: string;
  text_disabled: string;
  text_placeholder: string;
  text_link: string;

  // 表面层
  bg_primary: string;
  surface: string;
  surface_elevated: string;

  // 按钮
  btn_primary_bg: string;
  btn_primary_text: string;
  btn_primary_hover: string;
  btn_secondary_bg: string;
  btn_secondary_text: string;
  btn_danger_bg: string;
  btn_danger_text: string;

  // 控件 / 边框 / 输入
  border_primary: string;
  border_focus: string;
  input_bg: string;
  input_text: string;
  input_placeholder: string;
  control_disabled_bg: string;
  control_disabled_text: string;
  focus_ring: string;

  // 顶部栏与标签
  topbar_bg: string;
  tab_bg: string;
  tab_bg_active: string;
  tab_text_color: string;
  tab_text_color_active: string;
  tab_icon_color: string;
  tab_icon_color_active: string;
  tab_border_color: string;
  window_control_btn_icon_color: string;

  // 菜单 / 右键
  context_menu_bg: string;
  context_menu_border: string;
  context_menu_shadow: string;
  context_menu_item_text: string;
  context_menu_item_hover: string;
  context_menu_item_disabled: string;

  // 侧边菜单
  sidemenu_bg: string;
  menu_border_primary: string;
  sidemenu_text: string;
  sidemenu_text_active: string;

  // 滚动条 / 覆盖 / 分隔线
  scrollbar_track: string;
  scrollbar_thumb: string;
  scrollbar_thumb_hover: string;
  overlay: string;
  divider: string;

  // 交互状态
  selected_bg: string;
  selected_text: string;
  hover_bg: string;
  active_bg: string;

  // 阴影层级
  shadow_sm: string;
  shadow_md: string;
  shadow_lg: string;
  shadow_xl: string;

  // 可访问性与高对比
  high_contrast_text: string;

  // 面板
  panel_bg: string;
  panel_border: string;
}

export interface Terminal {
  // 主题
  active_theme_id: string;
  themes: TerminalThemePreset[];

  // 字体
  font_family: string;
  font_size: number;
  line_height: number;
  font_weight: number;
  font_weight_bold: number;

  // 光标
  cursor_style: "block" | "underline" | "bar";
  cursor_blink: boolean;
  cursor_width: number;

  // 滚动
  scrollback: number;
  scroll_sensitivity: number;
  fast_scroll_modifier: "alt" | "shift" | "ctrl" | "none";
  fast_scroll_sensitivity: number;

  // 外观
  background_opacity: number;
  allow_transparent_background: boolean;
  draw_bold_text_in_bright_colors: boolean;

  // 背景图片（本地路径或 http(s)/data URL）
  background_image: string;
  background_image_opacity: number;
  background_image_blur: number;
  // 终端背景延伸至顶部标签栏（Topbar 透出终端背景色/背景图）
  extend_background_to_topbar: boolean;
  // 选中文本背景透明度（0.0 全透明 - 1.0 实色，默认 0.4）
  selection_opacity: number;

  // 行为
  enable_bell: boolean;
  bell_style: "none" | "visual" | "sound" | "both";
  right_click_selects_word: boolean;
  copy_on_select: boolean;
  scroll_on_input: boolean;

  // 兼容性
  legacy_color_scheme: "default" | "solarized-dark" | "monokai" | "dracula";
  auto_connect: boolean;

  // 渲染引擎（dom | canvas | webgl；webgl 即 GPU 渲染，默认 dom 保持既有行为）
  render_engine: "dom" | "canvas" | "webgl";
  // GPU 加速总开关：关闭时即便引擎选了 webgl 也降级用 canvas
  gpu_acceleration: boolean;
}

export interface TerminalThemePreset {
  id: string;
  name: string;
  colors: TerminalThemeColors;
  built_in: boolean;
}

export interface TerminalThemeColors {
  // ANSI 颜色 (0-15)
  black: string;          // ANSI 0
  red: string;            // ANSI 1
  green: string;          // ANSI 2
  yellow: string;         // ANSI 3
  blue: string;           // ANSI 4
  magenta: string;        // ANSI 5
  cyan: string;           // ANSI 6
  white: string;          // ANSI 7
  bright_black: string;   // ANSI 8
  bright_red: string;     // ANSI 9
  bright_green: string;   // ANSI 10
  bright_yellow: string;  // ANSI 11
  bright_blue: string;    // ANSI 12
  bright_magenta: string; // ANSI 13
  bright_cyan: string;    // ANSI 14
  bright_white: string;   // ANSI 15

  // 终端基础颜色
  foreground: string;     // 前景色（默认文本）
  background: string;     // 背景色
  cursor: string;         // 光标颜色
  cursor_accent: string;  // 光标高亮色
  selection: string;      // 选中文本背景色
}

export interface SshSettings {
  connection_timeout: number;
  keep_alive_interval: number;
  auto_reconnect: boolean;
  max_reconnect_attempts: number;
  default_port: number;
  compression: boolean;
}

export interface ShortcutBinding {
  new_tab: string;
  close_tab: string;
  next_tab: string;
  prev_tab: string;
  copy: string;
  paste: string;
  find: string;
  // 终端内复制/粘贴/全选（默认 Ctrl+Shift+C/V/A，可自定义）
  terminal_copy: string;
  terminal_paste: string;
  terminal_select_all: string;
  enabled: boolean;
}

export interface Security {
  encrypt_passwords: boolean;
  session_timeout: number;
  lock_on_suspend: boolean;
  clear_clipboard_after: number;
}

export interface Advanced {
  auto_save: boolean;
  restore_sessions: boolean;
  confirm_on_close: boolean;
  minimize_to_tray: boolean;
  max_logs: number;
  enable_debug_log: boolean;
  // 调试模式：打开前端 console 面板（尝试开发者工具）
  debug_mode: boolean;
  check_updates: boolean;
  send_analytics: boolean;
}