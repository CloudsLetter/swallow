import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileText as IconFileText, Clapperboard as IconReplay, RefreshCw as IconRefresh, History as IconHistory } from 'lucide-react';
import { useConfigStore } from '../store/config';
import { useTabStore } from '../store/tabStore';
import { listSessionLogs, readSessionLog, type SessionLogFile } from '../services/sessionLogs';
import { readSessionReplay } from '../services/sessionReplay';
import { cleanTerminalText } from '../lib/ansiClean';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { cn } from '@/lib/utils';

/**
 * 会话日志文件列表（Logs 页）：浏览本机已落盘的会话记录。
 * - .replay.jsonl → 「回放」在只读 xterm 时间轴上重放（复用 SessionReplay 通路）
 * - .log（plain/ansi-vt）→ 「查看」清洗 ANSI 后只读展示
 * 列表来自后端 session_log_list（按修改时间倒序），读取用 session_log_read。
 */
export function SessionLogFiles() {
  const { t } = useTranslation();
  const directory = useConfigStore((s) => s.config?.terminal?.session_log_directory ?? '');
  const [files, setFiles] = useState<SessionLogFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<{ path: string; name: string; text: string } | null>(null);

  const loadFiles = useCallback(async () => {
    if (!directory) return;
    setLoading(true);
    try {
      setFiles(await listSessionLogs(directory));
    } catch (e) {
      console.error('Failed to list session logs:', e);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [directory]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const openReplay = async (file: SessionLogFile) => {
    try {
      const data = await readSessionReplay(file.path);
      useTabStore.getState().createTab({
        type: 'replay',
        name: `${t('logs.replayTitle')}: ${data.label || file.name}`,
        sessionId: null,
        replayConfig: { path: file.path, replay: data },
      });
    } catch (e) {
      console.error('Failed to open session replay:', e);
      toast.error(t('logs.replayOpenFailed'));
    }
  };

  const openTextView = async (file: SessionLogFile) => {
    try {
      const raw = await readSessionLog(file.path);
      setViewing({ path: file.path, name: file.name, text: cleanTerminalText(raw) });
    } catch (e) {
      console.error('Failed to read session log:', e);
      toast.error(t('logs.readFailed'));
    }
  };

  if (!directory) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <IconHistory size={15} className="text-muted-foreground" />
          {t('logs.sessionLogs')}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('logs.noLogsDir')}</p>
      </div>
    );
  }

  const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(1)}KB`);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <IconHistory size={15} className="text-muted-foreground" />
          {t('logs.sessionLogs')}
          {files.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">{t('logs.sessionLogCount', { count: files.length })}</span>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={() => void loadFiles()} aria-label={t('common.refresh')} title={t('common.refresh')}>
          <IconRefresh size={14} />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('logs.noSessionLogs')}</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto p-1.5 panel-scroll">
          {files.slice(0, 30).map((file) => {
            const replay = file.kind === 'replay';
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => void (replay ? openReplay(file) : openTextView(file))}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
                  title={file.path}
                >
                  {replay ? (
                    <IconReplay size={13} className="shrink-0 text-primary/80" />
                  ) : (
                    <IconFileText size={13} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
                  <Badge variant="outline" className={cn('shrink-0 font-normal', replay ? 'text-primary' : 'text-muted-foreground')}>
                    {replay ? t('logs.kindReplay') : t('logs.kindText')}
                  </Badge>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtSize(file.size)}</span>
                  <span className="shrink-0 text-muted-foreground/70">
                    {file.modified ? new Date(file.modified * 1000).toLocaleString() : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* 纯文本日志查看 */}
      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-[720px]">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{viewing?.name}</DialogTitle>
          </DialogHeader>
          <pre className="overlay-scrollbar max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {viewing?.text}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
