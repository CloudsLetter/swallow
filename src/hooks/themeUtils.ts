import type { ThemeColors, TerminalThemeColors } from '../types/config';

type ThemeMode = 'light' | 'dark';

interface ApplyThemeColorsOptions {
  themeId?: string;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function setCssVariables(root: HTMLElement, variables: Record<string, string>, prefix = '') {
  Object.entries(variables).forEach(([key, value]) => {
    if (!value) return;
    root.style.setProperty(`${prefix}${key}`, value);
  });
}

function parseHexColor(color: string): RgbColor | null {
  const hex = color.trim().replace('#', '');
  if (![3, 4, 6, 8].includes(hex.length)) return null;

  const normalized = hex.length <= 4
    ? hex.split('').map((char) => char + char).join('')
    : hex;

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);

  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function parseRgbColor(color: string): RgbColor | null {
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const [r, g, b] = match[1]
    .split(',')
    .slice(0, 3)
    .map((channel) => Number.parseFloat(channel.trim()));

  if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
  return { r, g, b };
}

function parseColor(color: string): RgbColor | null {
  if (!color) return null;
  if (color.startsWith('#')) return parseHexColor(color);
  if (color.startsWith('rgb')) return parseRgbColor(color);
  return null;
}

function toRelativeLuminance({ r, g, b }: RgbColor) {
  const normalize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };

  const [red, green, blue] = [normalize(r), normalize(g), normalize(b)];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function pickColor(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) ?? '';
}

export function resolveThemeMode(colors: ThemeColors): ThemeMode {
  const background = parseColor(
    pickColor(colors.bg_primary, colors.surface, colors.panel_bg)
  );

  if (background) {
    return toRelativeLuminance(background) < 0.35 ? 'dark' : 'light';
  }

  return colors.text_primary?.trim().toLowerCase() === '#ffffff' ? 'dark' : 'light';
}

export function buildShadcnThemeVariables(colors: ThemeColors) {
  return {
    background: pickColor(colors.bg_primary, colors.surface, '#ffffff'),
    foreground: pickColor(colors.text_primary, '#111827'),
    card: pickColor(colors.panel_bg, colors.surface_elevated, colors.surface, '#ffffff'),
    'card-foreground': pickColor(colors.text_primary, '#111827'),
    popover: pickColor(colors.context_menu_bg, colors.surface_elevated, colors.panel_bg, '#ffffff'),
    'popover-foreground': pickColor(colors.context_menu_item_text, colors.text_primary, '#111827'),
    primary: pickColor(colors.primary, colors.btn_primary_bg, '#2563eb'),
    'primary-foreground': pickColor(colors.btn_primary_text, colors.high_contrast_text, '#ffffff'),
    secondary: pickColor(colors.btn_secondary_bg, colors.surface, '#f3f4f6'),
    'secondary-foreground': pickColor(colors.btn_secondary_text, colors.text_secondary, colors.text_primary, '#111827'),
    muted: pickColor(colors.surface, colors.surface_elevated, '#f3f4f6'),
    'muted-foreground': pickColor(colors.text_muted, colors.text_tertiary, '#6b7280'),
    accent: pickColor(colors.hover_bg, colors.active_bg, colors.surface_elevated, '#f3f4f6'),
    'accent-foreground': pickColor(colors.text_primary, '#111827'),
    destructive: pickColor(colors.btn_danger_bg, colors.error, '#dc2626'),
    border: pickColor(colors.border_primary, colors.panel_border, '#d1d5db'),
    input: pickColor(colors.border_primary, colors.input_bg, '#d1d5db'),
    ring: pickColor(colors.focus_ring, colors.border_focus, colors.primary, '#93c5fd'),
    'chart-1': pickColor(colors.primary, '#2563eb'),
    'chart-2': pickColor(colors.info, '#0891b2'),
    'chart-3': pickColor(colors.success, '#059669'),
    'chart-4': pickColor(colors.warning, '#d97706'),
    'chart-5': pickColor(colors.error, '#dc2626'),
    radius: '0.5rem',
    sidebar: pickColor(colors.sidemenu_bg, colors.surface, '#f8fafc'),
    'sidebar-foreground': pickColor(colors.sidemenu_text, colors.text_secondary, '#334155'),
    'sidebar-primary': pickColor(colors.primary, colors.btn_primary_bg, '#2563eb'),
    'sidebar-primary-foreground': pickColor(colors.btn_primary_text, colors.high_contrast_text, '#ffffff'),
    'sidebar-accent': pickColor(colors.active_bg, colors.hover_bg, colors.surface_elevated, '#e2e8f0'),
    'sidebar-accent-foreground': pickColor(colors.sidemenu_text_active, colors.text_primary, '#0f172a'),
    'sidebar-border': pickColor(colors.menu_border_primary, colors.border_primary, '#cbd5e1'),
    'sidebar-ring': pickColor(colors.focus_ring, colors.border_focus, colors.primary, '#93c5fd'),
    success: pickColor(colors.success, '#059669'),
    warning: pickColor(colors.warning, '#d97706'),
    info: pickColor(colors.info, '#0284c7'),
  };
}

function applyThemeMode(root: HTMLElement, mode: ThemeMode, options?: ApplyThemeColorsOptions) {
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
  root.dataset.themeMode = mode;

  if (options?.themeId) {
    root.dataset.themeId = options.themeId;
  }
}

export function applyThemeColors(colors: ThemeColors, options?: ApplyThemeColorsOptions) {
  const root = document.documentElement;
  const legacyVariables = Object.fromEntries(
    Object.entries(colors)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => [`color-${key.replace(/_/g, '-')}`, value as string])
  );

  setCssVariables(root, legacyVariables, '--');
  setCssVariables(root, buildShadcnThemeVariables(colors), '--');
  applyThemeMode(root, resolveThemeMode(colors), options);
}

/**
 * 应用滚动条配置（悬浮开关 + 宽度）到 <html>：
 * - 设 --scrollbar-width 驱动全局/终端/可滚动容器的滚动条宽度（配合 scrollbar-gutter: stable 占位）；
 * - 正向语义：默认（无 class）即「悬浮胶囊 + gutter 稳定占位」；scrollbar_overlay=false 时加
 *   .no-overlay-scrollbar 回退传统实色轨道滚动条。
 */
export function applyScrollbarConfig(appearance?: {
  scrollbar_overlay?: boolean;
  scrollbar_width?: number;
}) {
  const root = document.documentElement;
  const width = Math.min(20, Math.max(4, Math.round(appearance?.scrollbar_width ?? 10)));
  root.style.setProperty('--scrollbar-width', `${width}px`);
  root.classList.toggle('no-overlay-scrollbar', appearance?.scrollbar_overlay === false);
}

export function buildTerminalTheme(colors: TerminalThemeColors) {
  const map: Record<string, string> = {
    foreground: colors.foreground,
    background: colors.background,
    cursor: colors.cursor,
    cursorAccent: colors.cursor_accent,
    // 选区背景保持实色：xterm DomRenderer 内部会 blend(背景, 选区色) 生成不透明色，
    // 真正的「半透明」由 .xterm-selection div 的 CSS opacity 实现（见 index.css，CSS 变量 --xterm-selection-opacity）
    selectionBackground: colors.selection,

    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,

    brightBlack: colors.bright_black,
    brightRed: colors.bright_red,
    brightGreen: colors.bright_green,
    brightYellow: colors.bright_yellow,
    brightBlue: colors.bright_blue,
    brightMagenta: colors.bright_magenta,
    brightCyan: colors.bright_cyan,
    brightWhite: colors.bright_white,
  };

  const theme: Record<string, string> = {};
  Object.entries(map).forEach(([key, value]) => {
    if (value) theme[key] = value;
  });

  return theme;
}

export default { applyThemeColors };
