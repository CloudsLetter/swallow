import type { CSSProperties } from 'react';

/** 解析 hex/rgb/rgba 颜色为 rgb 分量（面板主题派生用），非法返回 null。 */
export function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const s = color.trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 8) hex = hex.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    const int = parseInt(hex, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/**
 * 侧栏面板跟随终端主题（左右面板共用）：
 * 以终端背景色为底，按亮度覆盖局部 CSS 变量（--sidebar* / --muted* / --foreground /
 * --primary / --border / --input），让面板内所有 shadcn 配色自动适配明暗。
 * 文字（含 Label / 辅助信息 / 徽章 / 分区切换）不分层级，统一直接用终端主题前景色；
 * 前景色不可解析时按背景亮度回退白/黑。背景/边框/徽章底色始终按背景亮度取白/黑。
 * 仅「背景图 + 延伸顶栏」时半透明 + 毛玻璃透出全窗背景层。
 */
export function buildPanelTheme(
  terminalBackground: string,
  terminalForeground: string | null,
  hasImage: boolean,
  extend: boolean,
) {
  const rgb = parseRgb(terminalBackground);
  // 主题色未知（var() 兜底 / 透明终端）：保持应用默认 sidebar 外观
  if (!rgb) return { style: {} as CSSProperties, translucent: false };
  const dark = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b < 150;
  // 只有「背景图 + 延伸顶栏」时下层才有全窗背景层可透（fixed 层含图片）
  const translucent = hasImage && extend;
  // 文字基色：终端前景色优先（全面板统一、无明暗分级），解析失败按背景亮度回退
  const fg = parseRgb(terminalForeground || '');
  const fgColor = fg ? `rgb(${fg.r}, ${fg.g}, ${fg.b})` : dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
  const vars: Record<string, string> = {
    '--sidebar': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${translucent ? 0.6 : 1})`,
    '--sidebar-foreground': fgColor,
    '--foreground': fgColor,
    '--muted-foreground': fgColor,
    '--panel-faint': fgColor,
    '--panel-badge-bg': dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    '--panel-badge-fg': fgColor,
  };
  if (dark) {
    vars['--sidebar-border'] = 'rgba(255,255,255,0.1)';
    vars['--sidebar-accent'] = 'rgba(255,255,255,0.08)';
    vars['--muted'] = 'rgba(255,255,255,0.09)';
    vars['--primary'] = '#818cf8';
    // 面板内滚动条滑块随终端亮度（深底 → 半透明白；覆写全局主题滑块色，融入终端观感）
    vars['--color-scrollbar-thumb'] = 'rgba(255,255,255,0.3)';
    vars['--color-scrollbar-thumb-hover'] = 'rgba(255,255,255,0.5)';
  } else {
    // 浅色终端同样成套覆盖，避免深色应用主题残留出「浅底白字」
    vars['--sidebar-border'] = 'rgba(0,0,0,0.1)';
    vars['--sidebar-accent'] = 'rgba(0,0,0,0.05)';
    vars['--muted'] = 'rgba(0,0,0,0.06)';
    vars['--primary'] = '#4f46e5';
    vars['--color-scrollbar-thumb'] = 'rgba(0,0,0,0.25)';
    vars['--color-scrollbar-thumb-hover'] = 'rgba(0,0,0,0.45)';
  }
  // 边框/输入底色随终端亮度，面板内 border-border / bg-input 元素同步融入终端配色
  vars['--border'] = vars['--sidebar-border'];
  vars['--input'] = dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
  const style = {
    ...vars,
    ...(translucent ? { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' } : {}),
  } as CSSProperties;
  return { style, translucent };
}
