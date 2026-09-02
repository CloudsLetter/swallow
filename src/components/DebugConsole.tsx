import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';
interface Entry {
  level: Level;
  text: string;
  at: number;
}

const LEVEL_COLOR: Record<Level, string> = {
  log: 'text-foreground/80',
  info: 'text-sky-500',
  warn: 'text-amber-500',
  error: 'text-red-500',
  debug: 'text-muted-foreground',
};

const MAX_ENTRIES = 300;
const MAX_TEXT = 4000;

/** 捕获 console 的悬浮调试面板（调试模式开启时挂载，无需开发者工具也能看前端日志）。 */
export function DebugConsole() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<Entry[]>([]);
  const timerRef = useRef<number | null>(null);

  // console 劫持 + 定时批量刷新：高频 console 时不逐条 setState（避免把 React 压垮）
  useEffect(() => {
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const push = (level: Level) =>
      (...args: unknown[]) => {
        try {
          originals[level].apply(console, args);
        } catch {
          /* 原始输出异常也吞掉，避免把应用拖崩 */
        }
        try {
          const text = args
            .map((a) => {
              const s = typeof a === 'string' ? a : safeStringify(a);
              return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
            })
            .join(' ');
          bufferRef.current.push({ level, text, at: Date.now() });
          if (timerRef.current === null) {
            timerRef.current = window.setTimeout(() => {
              timerRef.current = null;
              const batch = bufferRef.current;
              bufferRef.current = [];
              if (batch.length) {
                setEntries((prev) => [...prev, ...batch].slice(-MAX_ENTRIES));
              }
            }, 30);
          }
        } catch {
          /* 捕获逻辑自身异常不影响应用 */
        }
      };
    console.log = push('log');
    console.info = push('info');
    console.warn = push('warn');
    console.error = push('error');
    console.debug = push('debug');
    return () => {
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
      console.debug = originals.debug;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, open]);

  return (
    <div className="fixed bottom-3 right-3 z-[60] flex flex-col items-end gap-2">
      {open && (
        <div className="flex max-h-[45vh] w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs font-medium">{t('settings.debugPanelTitle')}</span>
            <div className="flex items-center gap-1">
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                title={t('settings.debugClear')}
                onClick={() => setEntries([])}
              >
                <Trash2 size={13} />
              </button>
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                title={t('settings.debugClose')}
                onClick={() => setOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </div>
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
            onContextMenu={(e) => e.stopPropagation()}
          >
            {entries.length === 0 && (
              <p className="text-muted-foreground">{t('settings.debugEmpty')}</p>
            )}
            {entries.map((en, i) => (
              <div key={i} className="break-all">
                <span className={cn('mr-2 text-muted-foreground', LEVEL_COLOR[en.level])}>
                  {new Date(en.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className={LEVEL_COLOR[en.level]}>{en.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        className="flex size-9 items-center justify-center rounded-full border border-border bg-primary/10 text-primary shadow-md transition-colors hover:bg-primary/20"
        title={t('settings.debugPanelTitle')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return v.stack || v.message;
    const s = JSON.stringify(v, null, 0);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}
