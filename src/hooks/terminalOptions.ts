import type { ITerminalOptions } from '@xterm/xterm';
import type { Terminal } from '../types/config';

/**
 * 把 config.terminal 的配置映射为 xterm.js 的 ITerminalOptions。
 * 与 TerminalSettings 设置页一一对应，确保设置项真正作用到终端实例。
 */
/**
 * 内置的符号回退字体家族名（随应用打包，见 index.css 的 @font-face）。
 * 因为它一定存在，所以放在回退链最前面 —— 符号渲染与用户系统装了什么无关。
 * ⚠️ 必须与 index.css 中 @font-face 的 font-family 完全一致。
 */
export const BUNDLED_SYMBOL_FONT = 'JetBrains Mono Symbol';

/**
 * 随应用打包的「可选主字体」家族名，与设置页（TerminalSettings）下拉里的预设一一对应。
 *
 * 这些字体随应用分发（见 index.css 中的同名 @font-face），因此**用户无需自行安装**；
 * 名字必须与下拉 value 的第一个 token 同串，否则会被当作缺失而回退到 monospace
 * （Windows 上 = Consolas，缺 ▽△），也就是白白内置。
 *
 * ⚠️ 必须与 index.css 中对应 @font-face 的 font-family 完全一致。
 */
export const BUNDLED_PRIMARY_FONTS = ['Source Code Pro'];

/** 全部内置字体家族：创建任何 xterm 实例前都必须预载。 */
const BUNDLED_FONT_FAMILIES = [BUNDLED_SYMBOL_FONT, ...BUNDLED_PRIMARY_FONTS];

/**
 * 终端缺字形时的符号回退字体链（按优先级）。
 *
 * ⚠️ 首位是随应用打包的内置字体（JetBrains Mono Variable，296KB，
 * 覆盖 100~800 全部字重），其余为系统字体兜底：内置字体没有的码位
 * （如中文、Nerd 图标）继续往后找。
 */
const SYMBOL_FALLBACK_FONTS = [
  `'${BUNDLED_SYMBOL_FONT}'`,
  "'Cascadia Mono'",
  "'Cascadia Code'",
  "'DejaVu Sans Mono'",
  'Menlo',
];

/**
 * 预加载**全部内置字体**，解析后表示字形可安全用于测量。
 *
 * ⚠️ 必须在创建任何 xterm 实例之前 await：xterm 6.0 的代码里**完全没有**
 * document.fonts 相关逻辑（已核对 node_modules 产物），也就是说异步字体在首次
 * 测量之后才加载完成，它也**不会重新测量单元格宽度** —— 后果就是列宽按回退
 * 字体算出来、渲染却用内置字体，出现错位（正是我们要修的那类问题）。
 * 可选主字体（Source Code Pro）同理：它在设置里被选中时若尚未加载，栅格会先按
 * 兜底字体的格宽建好，尤其换字体是运行时发生的，所以这里一并预载。
 *
 * 内置字体是本地资源（已嵌入应用），正常在毫秒级完成；仍加超时兜底，
 * 避免字体损坏时把启动流程卡死。
 */
export function preloadBundledFonts(timeoutMs = 3000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const load = Promise.all(
    BUNDLED_FONT_FAMILIES.flatMap((family) => [
      document.fonts.load(`400 14px "${family}"`),
      document.fonts.load(`700 14px "${family}"`),
    ]),
  )
    .then(() => document.fonts.ready)
    .then(() => undefined)
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
  return Promise.race([load, timeout]);
}

/**
 * CSS 泛型族（关键字）。符号回退必须插在它们之前，
 * 否则会先被 monospace 解析出的 Courier New 之类吃掉（它同样缺 ▽△）。
 */
const GENERIC_FONT_FAMILIES = new Set([
  'monospace',
  'ui-monospace',
  'serif',
  'ui-serif',
  'sans-serif',
  'ui-sans-serif',
  'system-ui',
  'cursive',
  'fantasy',
  'math',
  'emoji',
  'fangsong',
]);

/** 未配置字体时的兜底栈，与 TerminalSettings 下拉默认项保持一致。 */
const DEFAULT_FONT_FAMILY = "Consolas, 'Courier New', monospace";

/** 去掉字体名外层引号并小写，用于去重比较。 */
function normalizeFontName(token: string): string {
  return token.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
}

/** 按逗号切分 CSS 字体栈，尊重引号内的逗号。 */
function splitFontStack(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 在字体栈中补入符号回退字体，插在第一个泛型族之前。
 * - 已含回退字体时按原顺序保留，不重复插入；
 * - 空/未配置时回退到默认字体栈；
 * - 无泛型族时追加到末尾。
 *
 * 这是「用户配置 → 实际渲染字体栈」的唯一收口，因此无需迁移既有 config.toml，
 * 已保存的字体选择也能自动获得符号回退。
 */
export function withSymbolFallback(fontFamily?: string): string {
  const base = (fontFamily ?? '').trim() || DEFAULT_FONT_FAMILY;
  const tokens = splitFontStack(base);
  const existing = new Set(tokens.map(normalizeFontName));
  const missing = SYMBOL_FALLBACK_FONTS.filter((f) => !existing.has(normalizeFontName(f)));
  if (missing.length === 0) return tokens.join(', ');

  const genericAt = tokens.findIndex((tk) => GENERIC_FONT_FAMILIES.has(normalizeFontName(tk)));
  const insertAt = genericAt === -1 ? tokens.length : genericAt;
  return [...tokens.slice(0, insertAt), ...missing, ...tokens.slice(insertAt)].join(', ');
}

export function buildXtermOptions(t: Terminal): ITerminalOptions {
  return {
    // 字体（补符号回退：Consolas / Courier New 缺 U+25BD 等空心几何符号）
    fontFamily: withSymbolFallback(t.font_family),
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
    // ⚠️ xterm 6.0 起 fastScrollModifier 选项被移除（Alt 硬编码），
    // fastScrollSensitivity 倍率继续生效。
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
