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

function luma({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 侧栏面板跟随终端主题（左右面板共用）：
 * - 图片背景 / 透明背景终端 → 面板背景**纯透明**（无毛玻璃 blur），直接露出
 *   下层背景图/应用背景；文字与边框按终端前景色的亮度配白/黑弱对比层。
 * - 纯色背景终端 → 以终端背景色为底（不透明），按亮度覆盖局部 CSS 变量
 *   （--sidebar* / --muted* / --foreground / --primary / --border / --input）。
 * 文字统一用终端主题前景色（--foreground），保证与终端字体同色。
 */
export function buildPanelTheme(
  terminalBackground: string,
  terminalForeground: string | null,
  hasImage: boolean,
  _extend: boolean,
) {
  const fg = parseRgb(terminalForeground || '');
  const rgb = parseRgb(terminalBackground);
  const raw = (terminalBackground || '').trim().toLowerCase();
  const clearBg = hasImage || raw === 'transparent' || /^rgba?\([^)]*,\s*0\s*\)$/.test(raw);

  // —— 透明/图片背景：面板纯透明，去毛玻璃 ——
  if (clearBg) {
    // 无法拿到前景色推导文字/边框对比 → 保持应用默认面板外观（安全兜底）
    if (!fg && !rgb) return { style: {} as CSSProperties };
    const base = fg ?? rgb!;
    const dark = luma(base) < 150;
    const fgColor = fg ? `rgb(${fg.r}, ${fg.g}, ${fg.b})` : dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
    const vars: Record<string, string> = {
      '--sidebar': 'transparent',
      '--sidebar-foreground': fgColor,
      '--foreground': fgColor,
      '--muted-foreground': fgColor,
      '--panel-faint': fgColor,
      '--panel-badge-bg': dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
      '--panel-badge-fg': fgColor,
      '--sidebar-border': dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      '--sidebar-accent': dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)',
      '--muted': dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)',
      '--primary': dark ? '#818cf8' : '#4f46e5',
      '--border': dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      '--input': dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)',
      '--color-scrollbar-thumb': fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.4)` : dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
      '--color-scrollbar-thumb-hover': fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.6)` : dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)',
    };
    return { style: { ...vars } as CSSProperties };
  }

  // —— 纯色背景：不透明面板底 ——
  if (!rgb) return { style: {} as CSSProperties }; // 未知色：保持应用默认
  const dark = luma(rgb) < 150;
  const fgColor = fg ? `rgb(${fg.r}, ${fg.g}, ${fg.b})` : dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';
  const vars: Record<string, string> = {
    '--sidebar': `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
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
    vars['--color-scrollbar-thumb'] = fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.4)` : 'rgba(255,255,255,0.3)';
    vars['--color-scrollbar-thumb-hover'] = fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.6)` : 'rgba(255,255,255,0.5)';
  } else {
    vars['--sidebar-border'] = 'rgba(0,0,0,0.1)';
    vars['--sidebar-accent'] = 'rgba(0,0,0,0.05)';
    vars['--muted'] = 'rgba(0,0,0,0.06)';
    vars['--primary'] = '#4f46e5';
    vars['--color-scrollbar-thumb'] = fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.4)` : 'rgba(0,0,0,0.25)';
    vars['--color-scrollbar-thumb-hover'] = fg ? `rgba(${fg.r}, ${fg.g}, ${fg.b}, 0.6)` : 'rgba(0,0,0,0.45)';
  }
  vars['--border'] = vars['--sidebar-border'];
  vars['--input'] = dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
  return { style: { ...vars } as CSSProperties };
}
