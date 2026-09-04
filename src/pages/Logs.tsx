import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import { getLogs, clearLogs, type LogEntry } from '../services/dataService';
import { readSessionReplay } from '../services/sessionReplay';
import { useTabStore } from '../store/tabStore';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Search as IconSearch, RefreshCw as IconRefresh, Trash2 as IconTrash, ScrollText as IconScrollText, AlertTriangle as IconAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { message, ask, open as dialogOpen } from '@tauri-apps/plugin-dialog';

type LevelFilter = 'all' | LogEntry['level'];

const filterChips: { key: LevelFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'error', label: 'logs.levelError' },
  { key: 'warn', label: 'logs.levelWarn' },
  { key: 'info', label: 'logs.levelInfo' },
  { key: 'debug', label: 'logs.levelDebug' },
];

const levelBadge = (level: LogEntry['level']) => {
  const map = {
    error: { text: i18n.t('logs.levelError'), cls: 'bg-destructive/10 text-destructive' },
    warn: { text: i18n.t('logs.levelWarn'), cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    info: { text: i18n.t('logs.levelInfo'), cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
    debug: { text: i18n.t('logs.levelDebug'), cls: 'bg-muted text-muted-foreground' },
  } as const;
  const item = map[level];
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', item.cls)}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          level === 'error' && 'bg-destructive',
          level === 'warn' && 'bg-amber-500',
          level === 'info' && 'bg-blue-500',
          level === 'debug' && 'bg-muted-foreground/40',
        )}
      />
      {item.text}
    </Badge>
  );
};

/** 解析日志 i18n 参数（后端存 JSON 字符串）。 */
const parseLogParams = (params?: string): Record<string, string> => {
  if (!params) return {};
  try {
    const parsed = JSON.parse(params);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

/** 渲染日志消息：参数化日志按 i18n key 翻译；传统日志原文显示。 */
const renderLogMessage = (log: LogEntry) => {
  if (log.logKey) {
    const translated = i18n.t(log.logKey, parseLogParams(log.params));
    // t 找不到 key 时返回 key 本身——此时回退原文
    return translated === log.logKey ? log.message : translated;
  }
  return log.message;
};

export function Logs() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadLogs();
  }, [levelFilter, searchQuery]);

  useEffect(() => {
    // 当过滤条件改变时，重置到第一页
    setCurrentPage(1);
  }, [levelFilter, searchQuery]);

  // ============ 键盘快捷键 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getLogs({
        level: levelFilter === 'all' ? undefined : levelFilter,
        search: searchQuery || undefined,
      });
      setLogs(data);
    } catch (loadError) {
      console.error('Failed to load logs:', loadError);
      setError(t('logs.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    const confirmed = await ask(t('logs.clearConfirmBody', { count: logs.length }), {
      title: t('common.clearConfirm'),
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await clearLogs();
      await loadLogs();
    } catch (clearError) {
      console.error('Failed to clear logs:', clearError);
      await message(t('logs.clearFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleOpenReplay = async () => {
    try {
      const selected = await dialogOpen({
        multiple: false,
        directory: false,
        filters: [{ name: 'Swallow Session Logs', extensions: ['jsonl', 'replay', 'log'] }],
      });
      if (typeof selected !== 'string' || !selected) return;
      const data = await readSessionReplay(selected);
      useTabStore.getState().createTab({
        type: 'replay',
        name: `${t('logs.replayTitle')}: ${data.label || t('logs.replayTitle')}`,
        sessionId: null,
        replayConfig: { path: selected, replay: data },
      });
    } catch (openError) {
      console.error('Failed to open session replay:', openError);
      await message(t('logs.replayOpenFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  // ============ 分页计算 ============
  const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedLogs = logs.slice(startIndex, startIndex + pageSize);

  const renderLoading = () => (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-24">{t('logs.tableLevel')}</TableHead>
            <TableHead className="w-44">{t('logs.tableTime')}</TableHead>
            <TableHead className="w-28">{t('logs.tableSource')}</TableHead>
            <TableHead>{t('logs.tableMessage')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 10 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-5 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-full max-w-md" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconScrollText size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">
        {searchQuery || levelFilter !== 'all' ? t('logs.emptySearch') : t('logs.emptyNone')}
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchQuery || levelFilter !== 'all'
          ? t('logs.emptySearchDesc')
          : t('logs.emptyNoneDesc')}
      </p>
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <IconAlert size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('logs.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-6" onClick={() => void loadLogs()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('logs.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('logs.recordCount', { count: logs.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('logs.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg pl-8"
            />
          </div>
          <Button variant="secondary" onClick={() => void handleOpenReplay()} title={t('logs.openReplay')}>
            <IconScrollText size={16} />
            {t('logs.openReplay')}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void loadLogs()} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button variant="destructive" onClick={() => void handleClear()} disabled={logs.length === 0} title={t('logs.clearTitle')}>
            <IconTrash size={16} strokeWidth={2} />
            {t('logs.clear')}
          </Button>
        </div>
      </div>

      {/* ===== 级别筛选 chips ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {filterChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setLevelFilter(chip.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              levelFilter === chip.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {t(chip.label)}
          </button>
        ))}
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : error && logs.length === 0 ? (
          renderError()
        ) : logs.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <Table>
              <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-24">{t('logs.tableLevel')}</TableHead>
                  <TableHead className="w-44">{t('logs.tableTime')}</TableHead>
                  <TableHead className="w-28">{t('logs.tableSource')}</TableHead>
                  <TableHead>{t('logs.tableMessage')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedLogs.map((log) => (
                  <TableRow key={log.id} className="transition-colors hover:bg-accent/40">
                    <TableCell>{levelBadge(log.level)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {new Date(log.timestamp).toLocaleString(i18n.language)}
                    </TableCell>
                    <TableCell>
                      {log.source ? (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          {log.source}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="break-words text-sm text-foreground">{renderLogMessage(log)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ===== 分页控件 ===== */}
      {!loading && logs.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{t('logs.perPage')}</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="h-8 w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
            <span>{t('logs.entriesTotal', { count: logs.length })}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => p - 1)}
            >
              {t('logs.prevPage')}
            </Button>
            <span className="text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => p + 1)}
            >
              {t('logs.nextPage')}
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}
