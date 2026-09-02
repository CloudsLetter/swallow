import type { ITerminalOptions } from '@xterm/xterm';
import type { Terminal } from '../types/config';

/**
 * 把 config.terminal 的配置映射为 xterm.js 的 ITerminalOptions。
 * 与 TerminalSettings 设置页一一对应，确保设置项真正作用到终端实例。
 */
export function buildXtermOptions(t: Terminal): ITerminalOptions {
  return {
    // 字体
    fontFamily: t.font_family,
    fontSize: t.font_size,
    lineHeight: t.line_height,
    fontWeight: t.font_weight,
    fontWeightBold: t.font_weight_bold,

    // 光标
    cursorStyle: t.cursor_style,
    cursorBlink: t.cursor_blink,
    cursorWidth: t.cursor_width,

    // 滚动
    scrollback: t.scrollback,
    scrollSensitivity: t.scroll_sensitivity,
    fastScrollModifier: t.fast_scroll_modifier,
    fastScrollSensitivity: t.fast_scroll_sensitivity,
    scrollOnUserInput: t.scroll_on_input,

    // 外观 / 行为
    drawBoldTextInBrightColors: t.draw_bold_text_in_bright_colors,
    allowTransparency: t.allow_transparent_background,
    rightClickSelectsWord: t.right_click_selects_word,

    // 允许通过 options 动态覆盖主题等（xterm 建议开启）
    allowProposedApi: true,
  };
}

/**
 * 把 #rrggbb / #rgb 十六进制颜色转为 rgba()，用于终端背景透明度。
 * 解析失败时回退为不透明。
 */
export function hexToRgba(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const clean = (hex || '').trim().replace(/^#/, '');
  let r = 0;
  let g = 0;
  let b = 0;

  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }

  if ([r, g, b].some(Number.isNaN)) {
    return hex;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
