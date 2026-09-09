import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
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
  ChevronRight as IconChevronRight,
  FolderOpen as IconFolderOpen,
  ExternalLink as IconOpen,
  ClipboardCopy as IconCopy,
  Server as IconServer,
} from 'lucide-react';
import { homeDir } from '@tauri-apps/api/path';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { listLocalDirectory, MIME_LOCAL, MIME_REMOTE, type LocalDirListing } from '../services/localFs';
import { LIST_COLS } from './sftpListColumns';

interface LocalBrowserProps {
  hostOptions: { id: string; name: string }[];
  /** 点击某台已保存主机（左栏切到远端源，由父级渲染 SftpPane） */
  onPickHost: (hostId: string) => void;
  /** 本机选中文件 → 上传到远程当前目录（走右栏传输管线） */
  onUploadFiles: (localPaths: string[]) => Promise<void>;
  /** 右栏文件拖入左栏：dir 为本机当前目录，由父级路由下载 */
  onFileFromRight: (name: string, dir: string) => Promise<void>;
}

interface Row {
  key: string;
  name: string;
  isDir: boolean;
  sizeText: string;
  mtime: string;
  /** 本机文件绝对路径（用于拖拽） */
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

/** 空时间 → '—'，避免出现整列空白。 */
function cellText(v: string | undefined): string {
  const s = (v ?? '').trim();
  return s && s !== '-' ? s : '—';
}

/** 本机路径分段（供面包屑逐级跳转）：每段携带「点到该级时的目标路径」。
 *  支持 Windows 盘符（C:\...）、UNC（\\srv\share）、POSIX（/a/b）。 */
function localPathSegments(p: string): { name: string; target: string }[] {
  const out: { name: string; target: string }[] = [];
  if (p.startsWith('/')) {
    let acc = '';
    for (const part of p.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`;
      out.push({ name: part, target: acc });
    }
    return out;
  }
  if (p.startsWith('\\\\')) {
    const parts = p.split('\\').filter(Boolean);
    let acc = '\\\\';
    parts.forEach((part, i) => {
      acc = `${acc}${part}${i < parts.length - 1 ? '\\' : ''}`;
      out.push({ name: part, target: acc });
    });
    return out;
  }
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length && /^[A-Za-z]:$/.test(parts[0])) {
    let acc = `${parts[0]}\\`;
    out.push({ name: parts[0], target: acc });
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc}${parts[i]}\\`;
      out.push({ name: parts[i], target: acc });
    }
    return out;
  }
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part;
    out.push({ name: part, target: acc });
  }
  return out;
}

/** SFTP 双栏左侧：纯本机目录浏览（左栏为远端源时由父级渲染 SftpPane，不再有残缺的远端分支）。 */
export function LocalBrowser({
  hostOptions,
  onPickHost,
  onUploadFiles,
  onFileFromRight,
}: LocalBrowserProps) {
  const { t } = useTranslation();

  const [path, setPath] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dragRemoteOver, setDragRemoteOver] = useState(false);
  // 落区高亮 enter/leave 深度计数：跨子元素移动只增减计数，避免 dragleave+dragover 交替闪烁
  const dragRemoteDepth = useRef(0);

  const load = useCallback(async (dir: string | null | undefined) => {
    setLoading(true);
    setError('');
    try {
      const res: LocalDirListing = await listLocalDirectory(dir ?? '');
      setRows(
        res.entries.map((e) => ({
          key: e.path,
          name: e.name,
          isDir: e.isDir,
          sizeText: e.isDir ? '—' : fmtSize(e.size),
          mtime: e.modified ? fmtTime(e.modified) : '',
          fullPath: e.path,
        })),
      );
      setParentPath(res.parent);
      setPath(res.path);
      setSel(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首挂载：定位到本机主目录
  useEffect(() => {
    void homeDir()
      .then((h) => load(h))
      .catch(() => load(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = () => void load(parentPath);
  const goHome = () => void load(null);

  const selectedLocalPaths = useMemo(
    () => rows.filter((r) => !r.isDir && sel.has(r.name)).map((r) => r.fullPath),
    [rows, sel],
  );

  const toggleSelect = (name: string) => {
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

  /** 右栏（远程）行拖入左栏：下载到本机当前目录 */
  const handleFileFromRightDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragRemoteDepth.current = 0;
    setDragRemoteOver(false);
    const data = e.dataTransfer.getData(MIME_REMOTE);
    if (!data) return;
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

  /** 左栏行拖出：本机文件 → MIME_LOCAL */
  const handleDragStart = (e: DragEvent, row: Row) => {
    if (row.isDir) return;
    e.dataTransfer.setData(MIME_LOCAL, row.fullPath);
    e.dataTransfer.setData('text/plain', row.fullPath);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const label = path && path.length > 64 ? `…${path.slice(-60)}` : path;
  // 面包屑分段（本机：C:\a\b → 各级可点击跳转）
  const localSegs = path ? localPathSegments(path) : [];
  // 拖拽提示里的目标目录：用最后一段（如 Downloads），比整串截断路径更直观
  const dropDirName = path
    ? path.split(/[\\/]/).filter(Boolean).pop() || path
    : t('sftp.sourceLocal');

  // 兜底：拖拽被取消/在窗口外释放时可能收不到 dragleave/drop → dragend 时统一熄灭高亮
  useEffect(() => {
    const resetHighlight = () => {
      dragRemoteDepth.current = 0;
      setDragRemoteOver(false);
    };
    window.addEventListener('dragend', resetHighlight);
    return () => window.removeEventListener('dragend', resetHighlight);
  }, []);

  const copyLocalPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      toast.success(t('sftp.copyLocalPath'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };
  const openLocalFile = (p: string) => openPath(p).catch((e) => toast.error(String(e)));
  const revealLocal = (p: string) => revealItemInDir(p).catch((e) => toast.error(String(e)));
  const uploadSingle = async (p: string) => {
    try {
      await onUploadFiles([p]);
      setSel(new Set());
    } catch (e) {
      console.error('Local single upload failed:', e);
    }
  };

  return (
    <div className="@container flex h-full w-0 min-w-0 flex-1 flex-col">
      {/* 栏头：与右栏工具栏同构；源可切「本机 / 已存主机」 */}
      <div className="flex items-center gap-2 border-b border-border bg-muted p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1">
              <IconDrive size={15} strokeWidth={2} />
              <span className="max-w-24 truncate">{t('sftp.sourceLocal')}</span>
              <IconChevronDown size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>{t('sftp.sourcePicker')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {hostOptions.map((h) => (
              <DropdownMenuItem key={h.id} onClick={() => onPickHost(h.id)}>
                <IconServer size={14} className="mr-2" />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
              </DropdownMenuItem>
            ))}
            {hostOptions.length === 0 && <DropdownMenuItem disabled>{t('sftp.sourceNoHosts')}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="icon" onClick={goUp} disabled={!parentPath} title={t('sftp.upDir')}>
          <IconArrowLeft size={18} strokeWidth={2} />
        </Button>
        <Button variant="ghost" size="icon" onClick={goHome} title={t('sftp.localRootBtn')}>
          <IconHome size={18} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load(path)}
          disabled={loading}
          title={t('common.refresh')}
        >
          <IconRefresh size={18} strokeWidth={2} className={loading ? 'animate-spin' : ''} />
        </Button>

        {/* 当前路径（面包屑，分段可点击跳转上下级；h-9 与右栏面包屑框等高） */}
        <div
          className="flex h-9 min-w-0 flex-1 items-center gap-0.5 overflow-x-hidden whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm"
          title={path ?? ''}
        >
          {localSegs.length > 0 ? (
            localSegs.map((seg, index) => {
              const isLast = index === localSegs.length - 1;
              return (
                <span key={seg.target} className="flex shrink-0 items-center gap-0.5">
                  {index > 0 && <IconChevronRight size={12} className="text-muted-foreground/60" />}
                  <button
                    type="button"
                    className={
                      isLast
                        ? 'rounded px-1 font-mono text-foreground'
                        : 'rounded px-1 font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
                    }
                    onClick={() => void load(seg.target)}
                  >
                    {seg.name}
                  </button>
                </span>
              );
            })
          ) : (
            <span className="truncate font-mono text-muted-foreground">{label || t('sftp.sourceLocal')}</span>
          )}
        </div>

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
      </div>

      {/* 文件列表（与右栏同构：shadcn ScrollArea 滚动容器，不隐藏滚动条）+ 右键（空白区/行级）+ 右栏拖入落区 */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'relative min-h-0 flex-1',
              dragRemoteOver && 'ring-2 ring-inset ring-primary/40',
            )}
            data-custom-contextmenu
            onDragEnter={(e) => {
              if (e.dataTransfer.types.includes(MIME_REMOTE)) {
                e.preventDefault();
                dragRemoteDepth.current += 1;
                setDragRemoteOver(true);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(MIME_REMOTE)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDragLeave={() => {
              dragRemoteDepth.current = Math.max(0, dragRemoteDepth.current - 1);
              if (dragRemoteDepth.current === 0) setDragRemoteOver(false);
            }}
            onDrop={handleFileFromRightDrop}
          >
        {dragRemoteOver && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md bg-primary/10">
            <span className="rounded-md border border-primary/40 bg-background/90 px-3 py-1 text-xs text-primary">
              {t('sftp.dropLocalDownload', { dir: dropDirName })}
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
              {t('sftp.localEmpty')}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col">
              {/* 表头（与右栏同构：行式表头 + 共享列模板） */}
              <div
                className={cn(
                  'grid h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium text-muted-foreground',
                  LIST_COLS,
                )}
              >
                <span className="min-w-0" />
                <span className="truncate">{t('sftp.tableName')}</span>
                <span className="truncate">{t('sftp.tableSize')}</span>
                <span className="truncate">{t('sftp.tableModified')}</span>
              </div>
              {rows.map((row) => (
                <ContextMenu key={row.key}>
                  <ContextMenuTrigger asChild>
                <div
                  draggable={!row.isDir}
                  onContextMenu={(e) => e.stopPropagation()}
                  onDragStart={(e) => handleDragStart(e, row)}
                  onDoubleClick={() => row.isDir && void load(row.fullPath)}
                  className={cn(
                    'grid min-h-9 items-center gap-2 border-b border-border/70 px-3 text-sm transition-colors',
                    LIST_COLS,
                    !row.isDir && sel.has(row.name) ? 'bg-primary/10 hover:bg-primary/10' : 'hover:bg-accent/40',
                  )}
                >
                  <div className="flex min-w-0 items-center">
                    <Checkbox
                      checked={!row.isDir && sel.has(row.name)}
                      disabled={row.isDir}
                      onCheckedChange={() => toggleSelect(row.name)}
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
                  </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    {row.isDir ? (
                      <ContextMenuItem onClick={() => void revealLocal(row.fullPath)}>
                        <IconFolderOpen size={15} className="mr-2" /> {t('sftp.openInExplorer')}
                      </ContextMenuItem>
                    ) : (
                      <>
                        <ContextMenuItem onClick={() => void openLocalFile(row.fullPath)}>
                          <IconOpen size={15} className="mr-2" /> {t('sftp.openLocalFile')}
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => void uploadSingle(row.fullPath)}>
                          <IconUpload size={15} className="mr-2" /> {t('sftp.uploadFile')}
                        </ContextMenuItem>
                      </>
                    )}
                    <ContextMenuItem onClick={() => void copyLocalPath(row.fullPath)}>
                      <IconCopy size={15} className="mr-2" /> {t('sftp.copyLocalPath')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          )}
        </ScrollArea>
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={() => void load(path)}>
            <IconRefresh size={15} className="mr-2" /> {t('common.refresh')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => void uploadSelected()}
            disabled={selectedLocalPaths.length === 0}
          >
            <IconUpload size={15} className="mr-2" />
            {t('sftp.localUpload', { count: selectedLocalPaths.length })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
