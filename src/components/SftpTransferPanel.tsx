import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X as IconX,
  Check as IconCheck,
  AlertTriangle as IconAlert,
  Upload as IconUpload,
  Download as IconDownload,
  Square as IconStop,
} from 'lucide-react';
import { Progress } from './ui/progress';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';
import { useTransferStore, groupTransfersBySession } from '../store/transferStore';

interface SftpTransferPanelProps {
  /** 定位方式：default=标签内右下角（absolute）；global=全局面板（fixed 右上角） */
  variant?: 'default' | 'global';
  /** 仅显示指定会话的任务（标签内面板用）；为空则显示全部 */
  sessionId?: string;
  title?: string;
  className?: string;
}

/** 速率显示刷新频率（毫秒）：传输速度/ETA 每秒更新一次即可，避免高频重渲染。 */
const RATE_REFRESH_MS = 1000;

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${Math.round((bytes / Math.pow(k, i)) * 10) / 10} ${sizes[i]}`;
}

/** 速率格式化：单位自动换算为 B/s / KB/s / MB/s / GB/s，保留 1 位小数。 */
function formatSpeed(bytesPerSec: number) {
  if (!bytesPerSec || bytesPerSec <= 0) return '—';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(k)), sizes.length - 1);
  return `${(bytesPerSec / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** 剩余时间格式化（秒 → "Xs" / "Xm Ys" / "Xh Ym"）。 */
function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** 传输任务面板（shadcn/ui：Card + ScrollArea + Badge + Progress + Spinner）。 */
export function SftpTransferPanel({
  variant = 'default',
  sessionId,
  title,
  className,
}: SftpTransferPanelProps) {
  const { t } = useTranslation();
  const tasks = useTransferStore((state) =>
    sessionId ? state.transfers.filter((t) => t.sessionId === sessionId) : state.transfers,
  );
  const dismissTransfer = useTransferStore((state) => state.dismissTransfer);
  const cancelTransfer = useTransferStore((state) => state.cancelTransfer);

  // 「清除」= 真正结束：先中断所有进行中的任务，再移除列表
  const handleClearAll = () => {
    const active = useTransferStore.getState().transfers.filter((t) => t.status === 'active');
    active.forEach((t) => cancelTransfer(t.id));
    useTransferStore.getState().clearTransfers();
  };

  // 定时刷新：进行中任务的速率与 ETA 随时间滚动更新（数据更新驱动 + 心跳兜底）
  // 仅在有任务时注册 interval，避免每个 SFTP/FTP 标签空闲时也每 500ms 空转重渲染
  const [, setTick] = useState(0);
  const hasTasks = tasks.length > 0;
  useEffect(() => {
    if (!hasTasks) return;
    const timer = setInterval(() => setTick((t) => t + 1), RATE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasTasks]);

  if (tasks.length === 0) return null;

  const activeCount = tasks.filter((t) => t.status === 'active').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const errorCount = tasks.filter((t) => t.status === 'error').length;
  const isGlobal = variant === 'global';
  const groups = isGlobal ? groupTransfersBySession(tasks) : null;

  const renderTask = (task: (typeof tasks)[number]) => {
    const percent = task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0;
    const isActive = task.status === 'active';
    const isDone = task.status === 'done';
    const isError = task.status === 'error';
    const isCancelled = task.status === 'cancelled';
    // total 未知（服务器未返回大小）时只显示已传输量，不显示百分比
    const hasKnownTotal = task.total > 0;
    const rate = isActive ? formatSpeed(task.rate ?? 0) : null;
    const eta =
      isActive && hasKnownTotal && (task.rate ?? 0) > 0
        ? formatEta((task.total - task.done) / (task.rate ?? 0))
        : null;

    return (
      <div
        key={task.id}
        className={cn(
          'flex w-full min-w-0 flex-col gap-1 rounded-md border p-2',
          isError
            ? 'border-destructive/30 bg-destructive/5'
            : isCancelled
              ? 'border-border bg-muted/40'
              : isDone
                ? 'border-border bg-muted/30'
                : 'border-border bg-background',
        )}
      >
        {/* 行 1：传输类型图标 + 文件名 + 状态图标 + 结束/移除 */}
        <div className="flex w-full min-w-0 items-center gap-2">
          {task.kind === 'upload' ? (
            <IconUpload size={14} className="shrink-0 text-primary" strokeWidth={2} />
          ) : (
            <IconDownload size={14} className="shrink-0 text-primary" strokeWidth={2} />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task.name}>
            {task.name}
          </span>
          {isActive ? (
            // 传输中：shadcn Spinner 动态动画
            <Spinner className="size-3.5 shrink-0 text-primary" />
          ) : isError ? (
            // 出错：红色错误提示图标
            <IconAlert size={14} className="shrink-0 text-destructive" strokeWidth={2} />
          ) : isCancelled ? (
            // 已结束：灰色取消标记
            <IconX size={14} className="shrink-0 text-muted-foreground" strokeWidth={2} />
          ) : (
            // 成功：绿色成功状态
            <IconCheck size={14} className="shrink-0 text-emerald-600" strokeWidth={2} />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            onClick={() => (isActive ? cancelTransfer(task.id) : dismissTransfer(task.id))}
            title={isActive ? t('transfer.endTask') : t('common.remove')}
          >
            {isActive ? <IconStop size={12} strokeWidth={2.5} /> : <IconX size={12} />}
          </Button>
        </div>

        {/* 行 2：主机名 + 协议类型（shadcn Badge） */}
        <div className="flex w-full min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
            title={task.host}
          >
            {task.host || t('transfer.unknownHost')}
          </span>
          <Badge
            variant="outline"
            className="h-4 shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] font-medium text-primary"
          >
            {(task.protocol || 'SFTP').toUpperCase()}
          </Badge>
        </div>

        {/* 行 3：进度条 + 进度文本（总量未知的 FTP 上传显示不确定动画条） */}
        <div className="flex w-full min-w-0 items-center gap-2">
          {isActive && !hasKnownTotal ? (
            <div className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="transfer-indeterminate absolute inset-y-0 w-1/4 rounded-full bg-primary" />
            </div>
          ) : (
            <Progress value={percent} className="min-w-0 flex-1" />
          )}
          <span className="w-32 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {isDone
              ? t('transfer.done')
              : isError
                ? t('transfer.failed')
                : isCancelled
                  ? t('transfer.cancelled')
                  : hasKnownTotal
                    ? `${formatBytes(task.done)} / ${formatBytes(task.total)} (${percent}%)`
                    : t('transfer.downloaded', { size: formatBytes(task.done) })}
          </span>
        </div>

        {/* 行 4：实时速率与 ETA（active 时显示，速率优先于 ETA） */}
        {isActive && (rate || eta) && (
          <div className="flex w-full min-w-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span className="flex min-w-0 items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
              <IconDownload size={11} className="shrink-0 rotate-180" strokeWidth={2} />
              <span className="truncate">{rate}</span>
            </span>
            {eta && <span className="shrink-0">{t('transfer.etaRemaining', { eta })}</span>}
          </div>
        )}

        {/* 错误原因（出错时小字显示） */}
        {isError && task.error && (
          <p className="truncate text-[11px] text-destructive" title={task.error}>
            {task.error}
          </p>
        )}
      </div>
    );
  };

  return (
    <Card
      size="sm"
      className={cn(
        'w-[340px] gap-0 p-0 shadow-lg',
        // 高度约束：面板绝不超出所在容器/视口（修复样式越界）
        variant === 'default'
          ? 'absolute right-4 bottom-4 z-30 max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)]'
          : 'fixed top-[45px] right-2 z-50 max-h-[calc(100vh-96px)] max-w-[calc(100vw-16px)]',
        className,
      )}
    >
      {/* 头部：标题 + 计数（成功/失败小字 Badge）+ 全清（shadcn CardHeader/CardAction） */}
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border py-2 px-3">
        <CardTitle className="text-xs font-semibold">
          {title ?? t('transfer.title')}
          {activeCount > 0 ? t('transfer.activeCountSuffix', { count: activeCount }) : ''}
        </CardTitle>
        <CardAction className="flex items-center gap-1.5">
          {doneCount > 0 && (
            <Badge className="h-4 gap-0.5 rounded-sm bg-emerald-500/10 px-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <IconCheck size={10} strokeWidth={2} /> {doneCount}
            </Badge>
          )}
          {errorCount > 0 && (
            <Badge variant="destructive" className="h-4 gap-0.5 rounded-sm px-1 text-[10px] font-medium">
              <IconAlert size={10} strokeWidth={2} /> {errorCount}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleClearAll}
            title={activeCount > 0 ? t('transfer.endAllTasks') : t('transfer.clearAll')}
            className="text-muted-foreground"
          >
            <IconX size={14} />
          </Button>
        </CardAction>
      </CardHeader>

      {/* 任务列表（原生滚动容器：宽度行为完全可控，杜绝横向溢出） */}
      <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
          <div className="flex w-full min-w-0 flex-col gap-2">
            {isGlobal && groups ? (
              Array.from(groups.entries()).map(([sessionKey, groupTasks]) => (
                <div key={sessionKey} className="flex w-full min-w-0 flex-col gap-1.5">
                  <div className="flex w-full min-w-0 items-center gap-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                    <span className="min-w-0 truncate">{groupTasks[0]?.host || t('transfer.otherSessions')}</span>
                    <Badge variant="outline" className="h-4 shrink-0 rounded-sm px-1 text-[10px]">
                      {groupTasks.length}
                    </Badge>
                  </div>
                  {groupTasks.map(renderTask)}
                </div>
              ))
            ) : (
              tasks.map(renderTask)
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
