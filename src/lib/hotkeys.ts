/**
 * 快捷键绑定解析与匹配（全局标签切换 / 终端复制粘贴等共用）。
 * 绑定字符串格式："Ctrl+Shift+C"、"Ctrl+T"、"Ctrl+Shift+→" 等，大小写不敏感，
 * 支持 ←→↑↓（映射 arrowleft/right/up/down）。
 */

export function parseShortcut(shortcut: string) {
  const parts = shortcut
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    ctrl: parts.some((p) => p.toLowerCase() === 'ctrl'),
    shift: parts.some((p) => p.toLowerCase() === 'shift'),
    alt: parts.some((p) => p.toLowerCase() === 'alt'),
    meta: parts.some((p) => p.toLowerCase() === 'meta'),
    key: (parts[parts.length - 1] || '').toLowerCase(),
  };
}

const KEY_MAP: Record<string, string> = {
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown',
};

/** 检查键盘事件是否匹配某条快捷键绑定（空绑定永不匹配）。 */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parsed = parseShortcut(shortcut);
  if (!parsed.key) return false;
  const normalizedKey = KEY_MAP[parsed.key] || parsed.key;
  const eventKey = e.key.toLowerCase();
  return (
    e.ctrlKey === parsed.ctrl &&
    e.shiftKey === parsed.shift &&
    e.altKey === parsed.alt &&
    e.metaKey === parsed.meta &&
    eventKey === normalizedKey
  );
}

/** 若绑定为空（老配置未存新字段）时返回的默认绑定 */
export function shortcutOrDefault(binding: string | undefined, fallback: string): string {
  return binding && binding.trim() ? binding : fallback;
}
