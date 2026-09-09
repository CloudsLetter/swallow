import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Folder as IconFolder,
  File as IconFile,
  ArrowLeft as IconArrowLeft,
  Home as IconHome,
  RefreshCw as IconRefresh,
  Upload as IconUpload,
  HardDrive as IconDrive,
  ChevronDown as IconChevronDown,
  Loader2 as IconLoader,
  Server as IconServer,
} from 'lucide-react';
import { homeDir } from '@tauri-apps/api/path';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { listLocalDirectory, MIME_LOCAL, MIME_LEFT_REMOTE, MIME_REMOTE, type LocalDirListing } from '../services/localFs';
import { sftpListDir } from '../services/sessionService';
import { LIST_COLS, LIST_COLS_PERM } from './sftpListColumns';
import type { FileItem } from './sftpPool';

export interface LeftRemoteInfo {
  sessionId: string;
  hostName: string;
}

interface LocalBrowserProps {
  /** 非 null = 左栏显示另一台主机的 SFTP；null = 本机目录 */
  leftRemote: LeftRemoteInfo | null;
  leftBusy: boolean;
  hostOptions: { id: string; name: string }[];
  /** 点击某台已保存主机（发起连接） */
  onPickHost: (hostId: string) => void;
  /** 断开左栏远程源，回到本机 */
  onReleaseRemote: () => void;
  /** 本机选中文件 → 上传到远程当前目录（仅本机模式） */
  onUploadFiles: (localPaths: string[]) => Promise<void>;
  /** 右栏文件拖入左栏：dir 为左栏当前目录（本机路径或另一台主机路径），由父级路由下载/流式复制 */
  onFileFromRight: (name: string, dir: string) => Promise<void>;
}

interface Row {
  key: string;
  name: string;
  isDir: boolean;
  sizeText: string;
  mtime: string;
  /** 本机无；另一台主机的远端文件为权限串（如 755 / drwxr-xr-x），未知为 '-'/'—' */
  permsText: string;
  /** 本机文件绝对路径 / 左栏远程文件的远端完整路径（用于拖拽） */
  fullPath: string;
}

function fmtSize(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)}GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function fmtTime(secs: number): string {
  if (!secs) return '';
  return new Date(secs * 1000).toLocaleString();
}

/** 空/未知时间或权限 → '—'，避免出现整列空白。 */
function cellText(v: string | undefined): string {
  const s = (v ?? '').trim();
  return s && s !== '-' ? s : '—';
}

/** 远端路径拼接（父目录或目标路径）。 */
function joinRemote(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`;
  return `${parent.endsWith('/') ? parent : `${parent}/`}${name}`;
}

/** 远端父目录（根返回 null）。 */
function remoteParent(p: string): string | null {
  if (!p || p === '/') return null;
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

/** SFTP 双栏左侧：本机目录 ⇄ 另一台主机的 SFTP（表格样式与右栏一致，各占 50%）。 */
export function LocalBrowser({
  leftRemote,
  leftBusy,
  hostOptions,
  onPickHost,
  onReleaseRemote,
  onUploadFiles,
  onFileFromRight,
}: LocalBrowserProps) {
  const { t } = useTranslation();
  const isRemoteMode = !!leftRemote;

  const [path, setPath] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dragRemoteOver, setDragRemoteOver] = useState(false);

  const load = useCallback(
    async (dir: string | null | undefined) => {
      setLoading(true);
      setError('');
      try {
        if (isRemoteMode && leftRemote) {
          const target = dir == null ? '/' : dir;
          const items = await sftpListDir(leftRemote.sessionId, target);
          setRows(
            items.map((it: FileItem) => ({
              key: it.name,
              name: it.name,
              isDir: it.type === 'directory',
              sizeText: it.type === 'directory' ? '—' : fmtSize(it.size),
              mtime: it.modified,
              permsText: it.permissions,
              fullPath: joinRemote(target, it.name),
            })),
          );
          setParentPath(remoteParent(target));
          setPath(target);
        } else {
          const res: LocalDirListing = await listLocalDirectory(dir ?? '');
          setRows(
            res.entries.map((e) => ({
              key: e.path,
              name: e.name,
              isDir: e.isDir,
              sizeText: e.isDir ? '—' : fmtSize(e.size),
              mtime: e.modified ? fmtTime(e.modified) : '',
              permsText: '',
              fullPath: e.path,
            })),
          );
          setParentPath(res.parent);
          setPath(res.path);
        }
        setSel(new Set());
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [isRemoteMode, leftRemote],
  );

  // 模式切换或首挂载：定位到本机主目录 / 远端根目录
  useEffect(() => {
    if (isRemoteMode && leftRemote) {
      void load('/');
      return;
    }
    if (!loading && !isRemoteMode) {
      void homeDir()
        .then((h) => load(h))
        .catch(() => load(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRemoteMode, leftRemote?.sessionId]);

  const goUp = () => void load(parentPath);
  const goHome = () => (isRemoteMode ? void load('/') : void load(null));

  const selectedLocalPaths = useMemo(
    () => rows.filter((r) => !r.isDir && sel.has(r.name)).map((r) => r.fullPath),
    [rows, sel],
  );

  const toggleSelect = (name: string, isDir: boolean) => {
    if (isDir) return;
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const uploadSelected = async () => {
    if (selectedLocalPaths.length === 0) return;
    try {
      await onUploadFiles(selectedLocalPaths);
      setSel(new Set());
    } catch (e) {
      console.error('Local upload failed:', e);
    }
  };

  /** 右栏（远程）行拖入左栏 */
  const handleFileFromRightDrop = async (e: DragEvent) => {
    const data = e.dataTransfer.getData(MIME_REMOTE);
    if (!data) return;
    e.preventDefault();
    setDragRemoteOver(false);
    const dir = path ?? '';
    for (const name of data.split('\n').filter(Boolean)) {
      try {
        await onFileFromRight(name, dir);
        await load(path);
      } catch (err) {
        console.error('Drop into left failed:', err);
        toast.error(String(err));
      }
    }
  };

  /** 左栏行拖出（本机文件 → MIME_LOCAL；另一台主机文件 → MIME_LEFT_REMOTE 携带远端路径） */
  const handleDragStart = (e: DragEvent, row: Row) => {
    if (row.isDir) return;
    e.dataTransfer.setData(isRemoteMode ? MIME_LEFT_REMOTE : MIME_LOCAL, row.fullPath);
    e.dataTransfer.setData('text/plain', row.fullPath);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const label = path && path.length > 64 ? `…${path.slice(-60)}` : path;

  return (
    <div className="flex h-full w-0 min-w-0 flex-1 flex-col">
      {/* 栏头：与右栏工具栏同构；源可切「本机 / 已存主机」 */}
      <div className="flex items-center gap-2 border-b border-border bg-muted p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1"
              disabled={leftBusy}
              title={leftBusy ? t('sftp.leftConnecting') : undefined}
            >
              {leftBusy ? (
                <IconLoader size={15} className="animate-spin" />
              ) : isRemoteMode ? (
                <IconServer size={15} strokeWidth={2} />
              ) : (
                <IconDrive size={15} strokeWidth={2} />
              )}
              <span className="max-w-24 truncate">{isRemoteMode ? leftRemote!.hostName : t('sftp.sourceLocal')}</span>
              <IconChevronDown size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>{t('sftp.sourcePicker')}</DropdownMenuLabel>
            {isRemoteMode ? (
              <DropdownMenuItem onClick={onReleaseRemote}>
                <IconDrive size={14} className="mr-2" />
                {t('sftp.sourceLocal')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {hostOptions.map((h) => (
              <DropdownMenuItem
                key={h.id}
                onClick={() => onPickHost(h.id)}
                disabled={isRemoteMode && leftRemote?.hostName === h.name}
              >
                <IconServer size={14} className="mr-2" />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
              </DropdownMenuItem>
            ))}
            {hostOptions.length === 0 && <DropdownMenuItem disabled>{t('sftp.sourceNoHosts')}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="icon" onClick={goUp} disabled={!parentPath || leftBusy} title={t('sftp.upDir')}>
          <IconArrowLeft size={18} strokeWidth={2} />
        </Button>
        <Button variant="ghost" size="icon" onClick={goHome} disabled={leftBusy} title={t('sftp.localRootBtn')}>
          <IconHome size={18} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load(path)}
          disabled={loading || leftBusy}
          title={t('common.refresh')}
        >
          <IconRefresh size={18} strokeWidth={2} className={loading ? 'animate-spin' : ''} />
        </Button>

        {/* 当前路径（本机或另一台主机） */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          title={path ?? ''}
        >
          <span className="truncate font-mono text-muted-foreground">{label || t('sftp.sourceLocal')}</span>
        </div>

        {!isRemoteMode && (
          <Button
            size="sm"
            className="h-8 shrink-0"
            disabled={selectedLocalPaths.length === 0}
            onClick={() => void uploadSelected()}
            title={t('sftp.localUploadHint')}
          >
            <IconUpload size={15} strokeWidth={2} />
            {t('sftp.localUpload', { count: selectedLocalPaths.length })}
          </Button>
        )}
      </div>

      {/* 文件列表（与右栏同构：shadcn ScrollArea 滚动容器，不隐藏滚动条）+ 右栏拖入落区 */}
      <div
        className={cn(
          'relative min-h-0 flex-1',
          dragRemoteOver && 'ring-2 ring-inset ring-primary/40',
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MIME_REMOTE)) {
            e.preventDefault();
            setDragRemoteOver(true);
          }
        }}
        onDragLeave={() => setDragRemoteOver(false)}
        onDrop={handleFileFromRightDrop}
      >
        {dragRemoteOver && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md bg-primary/10">
            <span className="rounded-md border border-primary/40 bg-background/90 px-3 py-1 text-xs text-primary">
              {isRemoteMode
                ? t('sftp.dropToRemoteCopy', { host: leftRemote!.hostName })
                : t('sftp.dropLocalDownload', { dir: label ?? '' })}
            </span>
          </div>
        )}
        <ScrollArea className="h-full w-full">
          {error ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-destructive">
              {error}
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {isRemoteMode ? t('sftp.emptyDir') : t('sftp.localEmpty')}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col">
              {/* 表头（与右栏同构：行式表头 + 共享列模板；本机无权限列，远端源才显示） */}
              <div
                className={cn(
                  'grid h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium text-muted-foreground',
                  isRemoteMode ? LIST_COLS_PERM : LIST_COLS,
                )}
              >
                <span className="min-w-0" />
                <span className="truncate">{t('sftp.tableName')}</span>
                <span className="truncate">{t('sftp.tableSize')}</span>
                <span className="truncate">{t('sftp.tableModified')}</span>
                {isRemoteMode && <span className="truncate">{t('sftp.tablePermissions')}</span>}
              </div>
              {rows.map((row) => (
                <div
                  key={row.key}
                  draggable={!row.isDir && !leftBusy}
                  onDragStart={(e) => handleDragStart(e, row)}
                  onDoubleClick={() => row.isDir && void load(row.fullPath)}
                  onClick={(e) => {
                    // 行级单击选中文件（目录靠双击进入）；落在复选框（Radix 按钮）上不抢，
                    // 否则 checkbox onCheckedChange + 冒泡行点击会双重翻转、勾不上
                    if (row.isDir) return;
                    if ((e.target as HTMLElement).closest('button')) return;
                    toggleSelect(row.name, row.isDir);
                  }}
                  className={cn(
                    'grid min-h-9 items-center gap-2 border-b border-border/70 px-3 text-sm transition-colors',
                    isRemoteMode ? LIST_COLS_PERM : LIST_COLS,
                    !row.isDir && sel.has(row.name) ? 'bg-primary/10 hover:bg-primary/10' : 'hover:bg-accent/40',
                  )}
                >
                  <div className="flex min-w-0 items-center">
                    <Checkbox
                      checked={!row.isDir && sel.has(row.name)}
                      disabled={row.isDir}
                      onCheckedChange={() => toggleSelect(row.name, row.isDir)}
                    />
                  </div>
                  <div className="flex min-w-0 items-center gap-2" title={row.name}>
                    {row.isDir ? (
                      <IconFolder size={16} className="shrink-0 text-warning" strokeWidth={2} />
                    ) : (
                      <IconFile size={16} className="shrink-0 text-muted-foreground" strokeWidth={2} />
                    )}
                    <span className="min-w-0 truncate text-sm">{row.name}</span>
                  </div>
                  <div className="min-w-0 truncate text-sm tabular-nums text-muted-foreground">{row.sizeText}</div>
                  <div className="min-w-0 truncate text-sm text-muted-foreground" title={row.mtime}>
                    {cellText(row.mtime)}
                  </div>
                  {isRemoteMode && (
                    <div className="min-w-0 truncate font-mono text-sm text-muted-foreground" title={row.permsText}>
                      {cellText(row.permsText)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
