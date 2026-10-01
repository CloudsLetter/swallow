import { describe, expect, it } from 'vitest';
import {
  BUNDLED_PRIMARY_FONTS,
  BUNDLED_SYMBOL_FONT,
  preloadBundledFonts,
  withSymbolFallback,
} from './terminalOptions';

/** 内置字体（随应用打包，一定存在），回退链首位。 */
const BUNDLED = BUNDLED_SYMBOL_FONT;
/** 系统字体兜底（内置字体缺中文 / Nerd 图标时继续往后找）。 */
const SYSTEM_FALLBACKS = ['Cascadia Mono', 'Cascadia Code', 'DejaVu Sans Mono', 'Menlo'];

/** 断言：内置字体在首位、系统兜底都在，且全部排在泛型族 monospace 之前。 */
function expectSafe(stack: string) {
  const tokens = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const bundledAt = tokens.indexOf(BUNDLED.toLowerCase());
  expect(bundledAt).toBeGreaterThanOrEqual(0);
  for (const f of SYSTEM_FALLBACKS) {
    expect(tokens).toContain(f.toLowerCase());
  }
  // 内置字体必须早于泛型族 —— 否则会被 monospace 解析出的 Courier New 之类吃掉。
  // （不要求早于用户自己写的字体：用户显式列出的 Menlo 等本就该优先。）
  const monoAt = tokens.indexOf('monospace');
  if (monoAt !== -1) {
    expect(bundledAt).toBeLessThan(monoAt);
  }
  // 同样必须早于由本函数补入的同类系统兜底
  const cascadiaAt = tokens.indexOf('cascadia mono');
  if (cascadiaAt !== -1) {
    expect(bundledAt).toBeLessThan(cascadiaAt);
  }
}

describe('withSymbolFallback', () => {
  it('未配置时回退到默认栈并补入符号回退', () => {
    const out = withSymbolFallback();
    expect(out.startsWith('Consolas')).toBe(true);
    expect(out.endsWith('monospace')).toBe(true);
    expectSafe(out);
  });

  it('空串 / 纯空白 视为未配置', () => {
    expect(withSymbolFallback('')).toBe(withSymbolFallback());
    expect(withSymbolFallback('   ')).toBe(withSymbolFallback());
  });

  it('内置字体排在系统兜底之前（符号渲染不依赖宿主装了什么）', () => {
    const tokens = withSymbolFallback("Consolas, 'Courier New', monospace").split(',');
    const first = tokens[2].trim(); // 0=Consolas 1=Courier New 2=第一个补入项
    expect(first.replace(/["']/g, '')).toBe(BUNDLED);
  });

  it('用户当前的 Consolas 字体栈被补全（核心修复场景）', () => {
    const out = withSymbolFallback("Consolas, 'Courier New', monospace");
    expect(out).toBe(
      `Consolas, 'Courier New', '${BUNDLED}', 'Cascadia Mono', 'Cascadia Code', 'DejaVu Sans Mono', Menlo, monospace`,
    );
    expectSafe(out);
  });

  // 设置页 6 个预设逐个验证：除 Cascadia Code 外都缺符号回退
  const presets: Array<[string, string]> = [
    ['Consolas', "Consolas, 'Courier New', monospace"],
    ['Cascadia Code', "'Cascadia Code', Consolas, monospace"],
    ['Fira Code', "'Fira Code', monospace"],
    ['JetBrains Mono', "'JetBrains Mono', monospace"],
    ['Source Code Pro', "'Source Code Pro', monospace"],
    ['Monaco', 'Monaco, Menlo, monospace'],
  ];

  it.each(presets)('设置页预设「%s」补全后不再缺字形', (_label, preset) => {
    expectSafe(withSymbolFallback(preset));
  });

  it('已含部分回退字体时不重复插入', () => {
    const out = withSymbolFallback("'Cascadia Code', Consolas, monospace");
    expect(out.match(/Cascadia Code/g)).toHaveLength(1);
    expect(out).toBe(
      `'Cascadia Code', Consolas, '${BUNDLED}', 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, monospace`,
    );
  });

  it('已是完整安全栈时原样返回', () => {
    const safe = withSymbolFallback("Consolas, 'Courier New', monospace");
    expect(withSymbolFallback(safe)).toBe(safe);
  });

  it('幂等：重复调用结果稳定', () => {
    const once = withSymbolFallback('Consolas');
    expect(withSymbolFallback(once)).toBe(once);
  });

  it('无泛型族时追加到末尾', () => {
    const out = withSymbolFallback('Consolas');
    expect(out.startsWith('Consolas, ')).toBe(true);
    expect(out).toContain(`'${BUNDLED}'`);
    expect(out.includes('monospace')).toBe(false);
  });

  it('去重比较忽略引号与大小写', () => {
    const out = withSymbolFallback('cascadia mono, consolas, monospace');
    expect(out.toLowerCase().match(/cascadia mono/g)).toHaveLength(1);
  });

  it('用户已显式选中内置字体时不重复插入', () => {
    const out = withSymbolFallback(`'${BUNDLED}', monospace`);
    expect(out.toLowerCase().match(new RegExp(BUNDLED.toLowerCase(), 'g'))).toHaveLength(1);
  });

  it('尊重引号内的逗号', () => {
    const out = withSymbolFallback('"Weird, Name", monospace');
    expect(out.startsWith('"Weird, Name", ')).toBe(true);
    expectSafe(out);
  });
});

describe('preloadBundledFonts', () => {
  it('任何环境下都不抛错，且一定 resolve（带超时兜底）', async () => {
    await expect(preloadBundledFonts(30)).resolves.toBeUndefined();
  });
});

describe('BUNDLED_PRIMARY_FONTS（随应用分发的可选主字体）', () => {
  /**
   * ⚠️ 与 src/pages/settingsComponents/TerminalSettings.tsx 的下拉 value 对应。
   * 字体名必须与 index.css 中 @font-face 的 font-family **同串**，否则浏览器按
   * 「该字体不存在」处理，静默回退到 monospace（Windows 上 = Consolas，缺 ▽△）——
   * 内置等于白做，且症状与修复前完全一样，极难发现。
   */
  const PRESET_BY_FAMILY: Record<string, string> = {
    'Source Code Pro': "'Source Code Pro', monospace",
  };

  it.each(BUNDLED_PRIMARY_FONTS)('「%s」与设置页下拉 value 同串', (family) => {
    const preset = PRESET_BY_FAMILY[family];
    expect(preset, `缺少 ${family} 对应的下拉预设记录（请同步本表）`).toBeDefined();
    const first = preset.split(',')[0].trim().replace(/^["']|["']$/g, '');
    expect(first).toBe(family);
  });

  it.each(BUNDLED_PRIMARY_FONTS)('选中「%s」时仍补入符号回退（覆盖它缺的 ✗ ⚡）', (family) => {
    const out = withSymbolFallback(PRESET_BY_FAMILY[family]);
    expect(out.startsWith(`'${family}'`)).toBe(true);
    expect(out).toContain(`'${BUNDLED}'`);
    expectSafe(out);
  });

  it('内置主字体不会被误当作符号回退字体插入', () => {
    // 符号回退链只应含 BUNDLED_SYMBOL_FONT，主字体由用户显式选择才生效。
    const out = withSymbolFallback('Consolas, monospace');
    for (const family of BUNDLED_PRIMARY_FONTS) {
      expect(out).not.toContain(`'${family}'`);
    }
  });
});
