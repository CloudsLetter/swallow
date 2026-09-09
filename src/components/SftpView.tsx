import { Fragment, useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { once } from '@tauri-apps/api/event';
import { join as joinPath, tempDir } from '@tauri-apps/api/path';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  Folder as IconFolder,
  File as IconFile,
  Download as IconDownload,
  Upload as IconUpload,
  RefreshCw as IconRefresh,
  Home as IconHome,
  ArrowLeft as IconArrowLeft,
  FolderPlus as IconFolderPlus,
  Pencil as IconPencil,
  Shield as IconShield,
  Search as IconSearch,
  Trash2 as IconTrash,
  ChevronRight as IconChevronRight,
  ArrowUpDown as IconArrowUpDown,
  ArrowUp as IconArrowUp,
  ArrowDown as IconArrowDown,
  ClipboardCopy as IconClipboard,
  FolderOpen as IconFolderOpen,
  X as IconX,
  AlertTriangle as IconAlert,
  HardDrive as IconDrive,
  Loader2 as IconLoader,
  Server as IconServer,
  MoreHorizontal as IconMoreHorizontal,
} from 'lucide-react';
import { ExternalLink as IconExternalLink } from 'lucide-react';
import { ConnectionProgress } from './ConnectionProgress';
import { LocalBrowser } from './LocalBrowser';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { MIME_LOCAL, MIME_LEFT_REMOTE, MIME_REMOTE } from '../services/localFs';
import { useSessionConnection, sftpSessionPool } from '../hooks/useSessionConnection';
import { touchHostLastConnected, getHosts, getAccounts, getKeys, getCertificates } from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { cn } from '@/lib/utils';
import {
  acceptHostKey,
  sftpConnect,
  sftpDisconnect,
  sftpCreateDir,
  sftpDeleteFile,
  sftpRemoveDirRecursive,
  sftpDownloadFileProgress,
  sftpListDir,
  sftpRename,  sftpChmod,
  sftpSearchFiles,
  sftpUploadChunk,
  sftpUploadFile,
  sftpUploadLocal,
  sftpStreamCopy,
  localFileSize,
} from '../services/sessionService';
import {
  createOrGetSftpSession,
  isConnected,
  isConnecting as checkIsConnecting,
  getCurrentPath,
  setCurrentPath as setCurrentPathInPool,
  getFiles,
  setFiles as setFilesInPool,
  getSelectedFiles,
  setSelectedFiles as setSelectedFilesInPool,
  getConnectionSteps,
  setConnectFunction,
  getConnectFunction,
  getShowProgress,
  type ConnectionStep,
  type FileItem,
} from './sftpPool';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { LIST_COLS_FTP, LIST_COLS_PERM } from './sftpListColumns';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { ask, save, open } from '@tauri-apps/plugin-dialog';
import { dedupeHostKeyConfirm } from '../lib/hostKeyConfirm';
import { toast } from 'sonner';
import { useTransferStore, isCancelRequested } from '../store/transferStore';
import { SftpTransferPanel } from './SftpTransferPanel';

interface SftpViewProps {
  sessionId?: string;
  isActive?: boolean;
  sftpConfig?: {
    name: string;
    host: string;
    port: number;
    protocol: string;
    username: string;
    authType: string;
    password?: string;
    keyPath?: string;
    keyId?: string;
    passphrase?: string;
    remotePath: string;
  };
}

type SortKey = 'name' | 'size' | 'modified';

/** 分块传输的块大小（字节）。单次整传的上限与后端 MAX_FILE_TRANSFER_BYTES 一致。
 *  ⚠️ 4MB（非更大）：无 path 的 IPC 分块在慢链路上单块需在会话 60s 超时内完成，
 *  8MB 在低带宽（<130KB/s）下会超时失败。直读路径不受此限制（后端 1MB 块循环）。 */
const TRANSFER_CHUNK = 4 * 1024 * 1024;
const MAX_SINGLE_UPLOAD = 100 * 1024 * 1024;

/** 拖拽收集到的待上传内容：需创建的目录（相对路径）+ 待上传的文件（相对路径）。 */
interface DroppedUpload {
  dirs: string[];
  files: { relativePath: string; file: File }[];
}

/** 递归读取一个 FileSystemEntry（文件或目录），收集目录列表与文件列表。 */
function readEntryTree(entry: FileSystemEntry, base: string, out: DroppedUpload): Promise<void> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (file) => {
          out.files.push({ relativePath: base ? `${base}/${entry.name}` : entry.name, file });
          resolve();
        },
        () => resolve(),
      );
    });
  }
  if (entry.isDirectory) {
    const dirPath = base ? `${base}/${entry.name}` : entry.name;
    out.dirs.push(dirPath);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return new Promise((resolve) => {
      const readBatch = () => {
        reader.readEntries(
          async (entries) => {
            if (entries.length === 0) {
              resolve();
              return;
            }
            for (const child of entries) {
              await readEntryTree(child, dirPath, out);
            }
            // readEntries 每次最多返回 100 条，需循环直到为空
            readBatch();
          },
          () => resolve(),
        );
      };
      readBatch();
    });
  }
  return Promise.resolve();
}

// WebView2 原生桥能力（postMessageWithAdditionalObjects → 宿主 AdditionalObjects → CoreWebView2File）
interface ChromeWebviewHost {
  postMessageWithAdditionalObjects?: (message: string, objects: ArrayLike<File>) => void;
}
declare global {
  interface Window {
    chrome?: { webview?: ChromeWebviewHost };
  }
}

/**
 * 经 WebView2 原生桥（WebMessageObjects）获取拖入文件的真实本地路径。
 * DOM File 在 JS 层不暴露路径；宿主（os_drop_paths.rs）从 AdditionalObjects 提取
 * CoreWebView2File.Path 后以 `sftp-os-drop-paths` 事件回传（顺序与 files 一致）。
 * 能力不可用 / 宿主无响应（600ms）→ 全 undefined，调用方走 IPC 慢通道兜底。
 */
async function requestOsFilePaths(files: File[]): Promise<(string | undefined)[]> {
  const webview = window.chrome?.webview;
  const canPost =
    typeof webview?.postMessageWithAdditionalObjects === 'function' && files.length > 0;
  if (!canPost) return files.map(() => undefined);

  const requestId = `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fallback = files.map(() => undefined);
  return new Promise<(string | undefined)[]>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (paths: (string | undefined)[]) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(paths);
    };
    const timer = window.setTimeout(() => {
      finish(fallback);
      unlisten?.();
    }, 600);
    // 先注册一次性监听并 await 注册完成，再发消息——避免宿主回包早于监听注册而丢失
    void once<{ requestId: string; paths: string[] }>('sftp-os-drop-paths', (e) => {
      if (settled || e.payload.requestId !== requestId) return;
      const { paths } = e.payload;
      finish(files.map((_, i) => paths[i]));
    }).then((un) => {
      if (settled) {
        un();
        return;
      }
      unlisten = un;
      try {
        webview!.postMessageWithAdditionalObjects!(`swallow-os-files::${requestId}`, files);
      } catch {
        finish(fallback);
        un();
      }
    });
  });
}

/** 从拖拽数据收集待上传内容（文件 + 目录树，递归遍历）。 */
async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedUpload> {
  const out: DroppedUpload = { dirs: [], files: [] };
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        await readEntryTree(entry, '', out);
      } else {
        const file = item.getAsFile();
        if (file) out.files.push({ relativePath: file.name, file });
      }
    }
  }
  // items 不可用或未读到任何内容时，回退到 files 列表
  if (out.dirs.length === 0 && out.files.length === 0) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      out.files.push({ relativePath: file.name, file });
    }
  }
  return out;
}

/** 双栏复用的远端文件浏览器实例句柄：组合层跨栏操作时通过 ref 调用。 */
export interface SftpPaneHandle {
  /** 按本地真实路径批量上传到当前目录（走传输管线：任务 + 进度 + 可取消） */
  uploadPaths: (localPaths: string[]) => Promise<void>;
  /** 把当前目录下的远程条目下载/复制到指定本地目录（目录递归、文件走标准任务） */
  downloadTo: (name: string, dir: string) => Promise<void>;
  /** 重新加载当前目录列表 */
  refresh: () => void;
}

interface SftpPaneProps {
  sessionId?: string;
  isActive?: boolean;
  sftpConfig?: SftpViewProps['sftpConfig'];
  /** 行拖出时写入的 MIME（右栏 MIME_REMOTE；左栏远端 MIME_LEFT_REMOTE） */
  dragMime?: string;
  /** 是否接管 window 级 OS 文件拖入上传（双栏时仅右栏开启，避免双实例重复响应） */
  windowDragUploads?: boolean;
  /** 工具栏最左侧插入的自定义区（左栏远端源切换下拉用，不破坏两栏对等布局） */
  toolbarPrefix?: React.ReactNode;
}

/** chmod 三栏勾选矩阵：所有者/组/其他 × 读/写/执行，实时回写八进制（如 755）。 */
function ChmodMatrix({ value, onChange }: { value: string; onChange: (octal: string) => void }) {
  const { t } = useTranslation();
  // 8 进制 → [所有者 r,w,x, 组 r,w,x, 其他 r,w,x]
  const bits = useMemo(() => {
    const digits = value.replace(/[^0-7]/g, '').slice(-3).padStart(3, '0').split('').map(Number);
    const out: boolean[] = [];
    for (const d of digits) {
      out.push((d & 4) !== 0, (d & 2) !== 0, (d & 1) !== 0);
    }
    return out;
  }, [value]);

  const toggle = (idx: number) => {
    const next = [...bits];
    next[idx] = !next[idx];
    const digits = [0, 1, 2].map(
      (g) => (next[g * 3] ? 4 : 0) + (next[g * 3 + 1] ? 2 : 0) + (next[g * 3 + 2] ? 1 : 0),
    );
    onChange(digits.join(''));
  };

  const symbolic = (digit: number) => `${digit & 4 ? 'r' : '-'}${digit & 2 ? 'w' : '-'}${digit & 1 ? 'x' : '-'}`;
  const digits = value.replace(/[^0-7]/g, '').slice(-3).padStart(3, '0').split('').map(Number);
  const rows: { label: string; offset: number }[] = [
    { label: t('sftp.permRead'), offset: 0 },
    { label: t('sftp.permWrite'), offset: 1 },
    { label: t('sftp.permExecute'), offset: 2 },
  ];

  return (
    <div>
      <div className="grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-y-2 text-sm">
        <span />
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permOwner')}</span>
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permGroup')}</span>
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permOther')}</span>
        {rows.map((row) => (
          <Fragment key={row.offset}>
            <span className="flex items-center gap-1.5">{row.label}</span>
            {[0, 3, 6].map((group) => (
              <span key={`${group}-${row.offset}`} className="flex justify-center">
                <Checkbox
                  checked={bits[group + row.offset]}
                  onCheckedChange={() => toggle(group + row.offset)}
                />
              </span>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 font-mono text-xs text-muted-foreground">
        <span>{t('sftp.chmod')}:</span>
        <span>{digits.join('')}</span>
        <span>{digits.map(symbolic).join('')}</span>
      </div>
    </div>
  );
}

/**
 * 单会话远端文件浏览器：工具栏 + 面包屑 + 文件列表 + 右键/对话框 + 传输面板 + 连接进度。
 * 双栏时右栏与「左栏远端源」各渲染一个实例，能力完全一致（重构目标：不再有残缺的左栏远端分支）。
 */
const SftpPane = forwardRef<SftpPaneHandle, SftpPaneProps>(function SftpPane(
  { sessionId, isActive = true, sftpConfig, dragMime = MIME_REMOTE, windowDragUploads = true, toolbarPrefix },
  ref,
) {
  const { t } = useTranslation();
  // UI 本地状态（从池中同步）
  const [currentPath, setCurrentPathLocal] = useState(sftpConfig?.remotePath || '/');
  const [files, setFilesLocal] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFilesLocal] = useState<Set<string>>(new Set());
  // 「用本机应用打开」的远程文件跟踪：临时下载到系统临时目录后交给默认程序，
  // 本地改动可一键回传（用户确认覆盖）
  const [openEdits, setOpenEdits] = useState<{ id: string; remotePath: string; localPath: string; name: string }[]>([]);
  const [promptState, setPromptState] = useState<{ mode: 'mkdir' | 'rename' | 'chmod'; value: string; itemName?: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  // 文件搜索状态
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 目录加载竞态保护：快速连续导航/刷新时只认最新一次请求，过期响应直接丢弃
  const loadSeqRef = useRef(0);
  // 目录加载错误（连接断开/路径错误等）：显示错误条 + 重新连接按钮，不误显示"目录为空"
  const [listError, setListError] = useState<string | null>(null);

  // 传输任务：细粒度订阅，避免每块进度更新触发整个 SftpView（含大文件列表）重渲染
  // 进度事件由全局监听（App 启动时 initTransferProgressListener）更新 store
  const hasTransfersInTab = useTransferStore((s) => s.transfers.some((t) => t.sessionId === sessionId));
  const addTransfer = useTransferStore((s) => s.addTransfer);
  const updateTransfer = useTransferStore((s) => s.updateTransfer);
  const dismissTransfer = useTransferStore((s) => s.dismissTransfer);
  const cancelTransfer = useTransferStore((s) => s.cancelTransfer);

  const scheduleTransferDismiss = (id: number, delay = 3000) => {
    setTimeout(() => dismissTransfer(id), delay);
  };

  // 清除本标签的所有传输任务（右键菜单）：进行中的先取消（触发后端中断/协作式取消），已结束的直接移除
  const dismissTransferBySession = () => {
    const current = useTransferStore.getState().transfers;
    current
      .filter((t) => t.sessionId === sessionId)
      .forEach((t) => {
        if (t.status === 'active') cancelTransfer(t.id);
        else dismissTransfer(t.id);
      });
  };

  // 连接进度状态（由 useSessionConnection 统一管理并同步到池）
  const {
    showProgress,
    steps: connectionSteps,
    isConnecting: isConnectingState,
    cancelRef: cancelConnectionRef,
    setSteps: setConnectionStepsLocal,
    updateStep,
    setProgressVisible: setShowProgress,
    setConnecting: setIsConnectingState,
    markConnected,
    handleCancelConnection,
    handleCloseProgress,
    handleRetryConnection,
  } = useSessionConnection(sessionId, sftpSessionPool);

  // 初始化或恢复会话状态
  useEffect(() => {
    if (!sessionId) return;

    createOrGetSftpSession(sessionId);

    if (isConnected(sessionId)) {
      const savedPath = getCurrentPath(sessionId);
      const savedFiles = getFiles(sessionId);
      const savedSelection = getSelectedFiles(sessionId);

      if (savedPath) setCurrentPathLocal(savedPath);
      if (savedFiles) {
        setFilesLocal(savedFiles);
      }
      if (savedSelection) setSelectedFilesLocal(savedSelection);
    }

    if (checkIsConnecting(sessionId)) {
      const savedSteps = getConnectionSteps(sessionId);
      if (savedSteps && savedSteps.length > 0) {
        setConnectionStepsLocal(savedSteps);
      }
      setIsConnectingState(true);
      setShowProgress(true);
    }

    const savedShowProgress = getShowProgress(sessionId);
    if (savedShowProgress && !checkIsConnecting(sessionId)) {
      const savedSteps = getConnectionSteps(sessionId);
      if (savedSteps) {
        setConnectionStepsLocal(savedSteps);
      }
      setShowProgress(true);
    }
  }, [sessionId, sftpConfig]);

  const loadFiles = async (path: string): Promise<boolean> => {
    if (!sessionId || !isConnected(sessionId)) return false;

    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const fileList = await sftpListDir(sessionId, path);
      // 期间又发起了新的加载/导航：本次结果已过期，丢弃避免覆盖新列表
      if (seq !== loadSeqRef.current) return false;
      setFilesLocal(fileList);
      setFilesInPool(sessionId, fileList);
      setListError(null);
      return true;
    } catch (error) {
      if (seq !== loadSeqRef.current) return false;
      console.error('Failed to load files:', error);
      // 保留旧列表 + 显示错误条：连接断开/路径错误时不误显示"目录为空"
      setListError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  // 重新连接：先清掉后端死会话（避免 sftp_connect 快速路径误判已连接），
  // 再重置连接状态并走池中的完整连接流程（含进度 UI 与目录加载）
  const handleReconnect = async () => {
    if (!sessionId) return;
    try {
      await sftpDisconnect(sessionId);
    } catch {
      // 会话不存在（已被清理）时继续重连
    }
    setListError(null);
    setCurrentPathLocal(sftpConfig?.remotePath || '/');
    setCurrentPathInPool(sessionId, sftpConfig?.remotePath || '/');
    markConnected(false);
    const connectFn = getConnectFunction(sessionId);
    if (connectFn) {
      void connectFn();
    }
  };

  // SFTP 连接逻辑
  useEffect(() => {
    if (!sessionId || !sftpConfig) return;
    if (isConnected(sessionId) || checkIsConnecting(sessionId)) return;

    const connectSFTP = async () => {
      cancelConnectionRef.current = false;
      setIsConnectingState(true);
      setShowProgress(true);

      const protocol = sftpConfig.protocol || 'sftp';
      const protocolName = protocol.toUpperCase();
      // 步骤与后端真实阶段对齐：连接（TCP+协议+认证在一次 sftpConnect 中完成）、读取目录、就绪
      const steps: ConnectionStep[] = [
        { id: 'connect', label: t('connection.stepConnect', { host: sftpConfig.host }), status: 'pending' },
        { id: 'list', label: t('connection.stepList'), status: 'pending' },
        { id: 'ready', label: t('connection.stepReady'), status: 'pending' },
      ];

      setConnectionStepsLocal(steps);

      try {
        // 真实连接：TCP + 协议初始化 + 身份验证由后端 sftpConnect 一次完成
        updateStep('connect', 'loading');
        const sessionConfig = {
          host: sftpConfig.host,
          port: sftpConfig.port,
          username: sftpConfig.username,
          protocol: sftpConfig.protocol || 'sftp',
          auth_type: sftpConfig.authType || 'password',
          password: sftpConfig.password,
          key_path: sftpConfig.keyPath,
          key_id: sftpConfig.keyId,
          passphrase: sftpConfig.passphrase,
        };
        try {
          let connectResult = await sftpConnect(sessionId, sessionConfig);
          while (connectResult.status === 'needsHostKeyApproval') {
            const fingerprint = connectResult.fingerprint ?? '';
            const accepted = await dedupeHostKeyConfirm(
              `${connectResult.host}:${connectResult.port}:${fingerprint}`,
              () =>
                ask(
                  t('connection.hostKeyBody', {
                    host: connectResult.host,
                    port: connectResult.port,
                    fingerprint,
                  }),
                  {
                    title: t('connection.hostKeyTitle'),
                    okLabel: t('connection.trustAndConnect'),
                    cancelLabel: t('connection.decline'),
                    kind: 'warning',
                  },
                ),
            );
            if (!accepted) {
              throw new Error(t('connection.declinedHostKey'));
            }
            await acceptHostKey(connectResult.hostKeyToken!, fingerprint);
            connectResult = await sftpConnect(sessionId, sessionConfig);
          }
          if (connectResult.status !== 'connected') {
            throw new Error(t('connection.connectionFailedStatus', { status: connectResult.status }));
          }
          if (cancelConnectionRef.current) throw new Error('User cancelled');
          updateStep(
            'connect',
            'success',
            `${protocolName} · ${sftpConfig.username}@${sftpConfig.host}:${sftpConfig.port}`,
          );
        } catch (err: unknown) {
          throw new Error(t('connection.sftpConnectFailed', { protocol: protocolName, message: err instanceof Error ? err.message : String(err) }));
        }

        markConnected(true);
        setIsConnectingState(false);
        // 最近连接时间落库（SFTP/FTP 会话）
        if (sftpConfig?.host) {
          touchHostLastConnected(sftpConfig.host, sftpConfig.port).catch(() => {});
        }

        // 真实读取目录
        updateStep('list', 'loading');
        const listOk = await loadFiles(sftpConfig.remotePath);
        if (cancelConnectionRef.current) throw new Error('User cancelled');
        if (listOk) {
          updateStep('list', 'success', t('connection.loadedPath', { path: sftpConfig.remotePath }));
        } else {
          // 连接本身已成功（TCP + 认证通过），仅目录列表读取失败：
          // 标记该步骤失败，但仍进入文件浏览器，由错误条提供重连/导航入口
          updateStep('list', 'error', t('connection.listFailed'));
        }

        updateStep('ready', 'success', t('connection.ready', { protocol: protocolName }));

        setTimeout(() => {
          setShowProgress(false);
        }, 800);
      } catch (error: unknown) {
        console.error('SFTP connection failed:', error);
        const latest = getConnectionSteps(sessionId) || steps;
        const currentStepId = latest.find((s) => s.status === 'loading')?.id || 'connect';
        updateStep(currentStepId, 'error', error instanceof Error ? error.message : t('connection.failed'));
        setIsConnectingState(false);
      }
    };

    setConnectFunction(sessionId, connectSFTP);
    connectSFTP();
  }, [sessionId, sftpConfig]);

  // 监听路径变化：导航到任意目录（含已访问过的）都重新加载列表，确保看到最新内容
  useEffect(() => {
    if (!sessionId || !isConnected(sessionId)) return;
    loadFiles(currentPath);
  }, [currentPath, sessionId]);

  const clearSelection = () => {
    const empty = new Set<string>();
    setSelectedFilesLocal(empty);
    if (sessionId) {
      setSelectedFilesInPool(sessionId, empty);
    }
  };

  // 移除单个已不存在于列表的选中项（删除后调用，避免残留失效选中）
  const removeFromSelection = (name: string) => {
    if (!selectedFiles.has(name)) return;
    const next = new Set(selectedFiles);
    next.delete(name);
    setSelectedFilesLocal(next);
    if (sessionId) {
      setSelectedFilesInPool(sessionId, next);
    }
  };

  const handleNavigate = (path: string) => {
    setCurrentPathLocal(path);
    if (sessionId) {
      setCurrentPathInPool(sessionId, path);
    }
    clearSelection();
    setListError(null);
  };

  const joinRemotePath = (name: string) => (currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);

  // 上传一批本地文件/目录（文件选择与拖拽共用）：先建目录再传文件，分块非阻塞 + 进度条
  // osPaths：与 files 等长的真实本地路径数组（WebView2 原生桥取回，仅拖拽来源有值）；
  // 命中则直读满速，否则回退 File.path / IPC 通道
  const uploadFiles = async (dropped: DroppedUpload, osPaths?: (string | undefined)[]) => {
    const { dirs, files } = dropped;
    if (files.length === 0 || !sessionId) return;

    let successCount = 0;
    const failures: string[] = [];

    // 1. 先按深度创建目录（浅层在前），目录已存在等错误忽略
    const sortedDirs = [...new Set(dirs)].sort(
      (a, b) => a.split('/').length - b.split('/').length,
    );
    for (const dir of sortedDirs) {
      try {
        await sftpCreateDir(sessionId, joinRemotePath(dir));
      } catch {
        // 目录已存在或创建失败：忽略，后续文件上传会因父目录缺失而明确报错
      }
    }

    // 2. 逐个上传文件（remotePath = currentPath 下的相对路径）
    for (const [idx, { relativePath, file }] of files.entries()) {
      const cancelToken = `ul-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const remotePath = joinRemotePath(relativePath);
      const taskId = addTransfer({
        name: relativePath,
        kind: 'upload',
        status: 'active',
        done: 0,
        total: file.size,
        sessionId,
        remotePath,
        host: sftpConfig?.host,
        protocol: sftpConfig?.protocol || 'sftp',
        cancelToken,
      });
      try {
        // 拖拽来源优先用 WebView2 原生桥取回的真实路径（osPaths 与 files 同序）；
        // 按钮/无桥环境回退 File.path（罕见，WebView2 已不暴露）与下方 IPC 通道。
        const localPath = osPaths?.[idx] ?? (file as File & { path?: string }).path;
        if (localPath) {
          if (isCancelRequested(taskId)) {
            throw new Error(t('sftp.cancelledError'));
          }
          await sftpUploadLocal(sessionId, localPath, remotePath, cancelToken);
          updateTransfer(taskId, { done: file.size, status: 'done' });
          scheduleTransferDismiss(taskId);
          successCount += 1;
          continue;
        }
        // 拖拽大文件无 path：走分块 IPC（较慢）。一次性提示建议改用上传按钮（直读满速）
        if (!localPath && file.size > MAX_SINGLE_UPLOAD) {
          const hintShown = window.sessionStorage.getItem('sftp-drag-hint-shown');
          if (!hintShown) {
            window.sessionStorage.setItem('sftp-drag-hint-shown', '1');
            toast.info(t('sftp.dragBigFileHint'), { duration: 6000 });
          }
        }
        // ≤100MB：单次整传（后端一次 open 流式写，无逐块 open/RTT 开销，上传不受限速）；
        // 数据一次读完经 IPC 传递。>100MB 走下方 8MB 分块（块大 → 打开次数 ÷8）
        if (file.size <= MAX_SINGLE_UPLOAD) {
          if (isCancelRequested(taskId)) {
            throw new Error(t('sftp.cancelledError'));
          }
          const data = new Uint8Array(await file.arrayBuffer());
          await sftpUploadFile(sessionId, data, joinRemotePath(relativePath));
          updateTransfer(taskId, { done: file.size });
          updateTransfer(taskId, { status: 'done' });
          scheduleTransferDismiss(taskId);
          successCount += 1;
          continue;
        }
        let offset = 0;
        // do-while 确保空文件（size=0）也至少上传一次：首块 truncate 会在远端创建 0 字节文件
        do {
          // 结束任务：每块前检查取消标志，中断上传循环
          if (isCancelRequested(taskId)) {
            throw new Error(t('sftp.cancelledError'));
          }
          const slice = file.slice(offset, offset + TRANSFER_CHUNK);
          const data = new Uint8Array(await slice.arrayBuffer());
          await sftpUploadChunk(sessionId, joinRemotePath(relativePath), data, offset === 0);
          offset += data.byteLength;
          updateTransfer(taskId, { done: offset });
        } while (offset < file.size);
        if (isCancelRequested(taskId)) {
          throw new Error(t('sftp.cancelledError'));
        }
        updateTransfer(taskId, { status: 'done' });
        scheduleTransferDismiss(taskId);
        successCount += 1;
      } catch (error) {
        // 已主动取消：store 已标 cancelled，定时移除即可，不计入失败
        if (isCancelRequested(taskId)) {
          scheduleTransferDismiss(taskId);
          continue;
        }
        updateTransfer(taskId, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (successCount > 0) {
      toast.success(
        successCount === 1
          ? t('sftp.uploadedFile', { name: files[0].relativePath })
          : t('sftp.uploadedFiles', { success: successCount, total: files.length }),
      );
    }
    if (failures.length > 0) {
      toast.error(
        t('sftp.uploadPartiallyFailed', {
          first: failures[0],
          more: failures.length > 1 ? t('sftp.uploadFailedMore', { count: failures.length }) : '',
        }),
      );
    }
    await loadFiles(currentPath);
  };

  const handleUploadClick = async () => {
    // Tauri 原生对话框选文件（返回真实路径 → 后端直读流式上传，速度≈下载，
    // 绕开浏览器 File 无路径 / IPC JSON 序列化瓶颈）
    if (!sessionId) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: t('sftp.uploadFile'),
    }).catch(() => null);
    if (!selected || (Array.isArray(selected) ? selected.length === 0 : !selected)) return;
    await uploadByPaths(Array.isArray(selected) ? selected : [selected]);
  };

  /** 按本地真实路径直接上传（后端直读文件，不经 IPC 数据搬运）。 */
  const uploadByPaths = async (localPaths: string[]) => {
    if (!sessionId || localPaths.length === 0) return;
    let successCount = 0;
    const failures: string[] = [];

    for (const localPath of localPaths) {
      const name = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || localPath;
      const cancelToken = `ul-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const taskId = addTransfer({
        name,
        kind: 'upload',
        status: 'active',
        done: 0,
        total: 0, // 后端直读：进度事件首帧会带来 total/done
        sessionId,
        remotePath: joinRemotePath(name), // 事件按 sessionId+remotePath 匹配任务（缺失则进度永远更新不上）
        host: sftpConfig?.host,
        protocol: sftpConfig?.protocol || 'sftp',
        cancelToken,
      });
      try {
        await sftpUploadLocal(sessionId, localPath, joinRemotePath(name), cancelToken);
        if (isCancelRequested(taskId)) {
          scheduleTransferDismiss(taskId);
          continue;
        }
        updateTransfer(taskId, { status: 'done' });
        scheduleTransferDismiss(taskId);
        successCount += 1;
      } catch (error) {
        if (isCancelRequested(taskId)) {
          scheduleTransferDismiss(taskId);
          continue;
        }
        updateTransfer(taskId, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (successCount > 0) {
      toast.success(
        successCount === 1
          ? t('sftp.uploadedFile', { name: localPaths[0].replace(/\\/g, '/').split('/').pop() })
          : t('sftp.uploadedFiles', { success: successCount, total: localPaths.length }),
      );
    }
    if (failures.length > 0) {
      toast.error(
        t('sftp.uploadPartiallyFailed', {
          first: failures[0],
          more: failures.length > 1 ? t('sftp.uploadFailedMore', { count: failures.length }) : '',
        }),
      );
    }
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    await uploadFiles({
      dirs: [],
      files: selectedFiles.map((file) => ({ relativePath: file.name, file })),
    });
  };

  // 拖拽上传：window 级捕获监听（捕获阶段先于任何元素执行，子元素无法拦截；
  // WebView2 下比 div 级 React 合成事件可靠——相关 target/types 判断均不可靠）。
  // 事件处理器不闭包组件变量（depth 计数 + 高亮）；drop 逻辑经 ref 转发拿最新闭包（currentPath/sessionId/uploadFiles）。
  const dragDepthRef = useRef(0);
  type NativeDragEvent = globalThis.DragEvent;
  const dropHandlerRef = useRef<(event: NativeDragEvent) => void>(() => {});
  dropHandlerRef.current = async (event: NativeDragEvent) => {
    if (!sessionId) return;
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    // 只认 OS 文件拖入（types 含 'Files'）。两栏内部的 MIME 拖拽（互传/流复制）由各栏落区接手，
    // 绝不能在这里响应——否则内部拖拽会误报「未读取到拖拽的文件」。
    if (!dataTransfer.types.includes('Files')) return;
    const dropped = await collectDroppedFiles(dataTransfer);
    if (dropped.files.length === 0) {
      toast.error(t('sftp.dropReadFailed'));
      return;
    }
    // 先经 WebView2 原生桥取真实路径（≤600ms 无响应自动回退 IPC 通道）
    const osPaths = await requestOsFilePaths(dropped.files.map((f) => f.file));
    await uploadFiles(dropped, osPaths);
  };

  useEffect(() => {
    if (!isActive || !windowDragUploads) return;

    const handleDragEnter = (event: NativeDragEvent) => {
      event.preventDefault();
      // 仅 OS 文件拖入才点亮拖拽遮罩；两栏内部 MIME 拖拽不触发上传 UI
      if (!event.dataTransfer?.types.includes('Files')) return;
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const handleDragOver = (event: NativeDragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (!event.dataTransfer?.types.includes('Files')) return;
      setIsDragOver(true);
    };
    const handleDragLeave = (event: NativeDragEvent) => {
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOver(false);
      }
    };
    const handleDrop = (event: NativeDragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      void dropHandlerRef.current(event);
    };

    window.addEventListener('dragenter', handleDragEnter, true);
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('dragleave', handleDragLeave, true);
    window.addEventListener('drop', handleDrop, true);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter, true);
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('dragleave', handleDragLeave, true);
      window.removeEventListener('drop', handleDrop, true);
    };
  }, [isActive]);

  // F5 刷新当前目录（仅激活标签响应，避免 keep-alive 下多实例重复刷新）
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        void loadFiles(currentPath);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, currentPath, sessionId]);

  const handleDownload = async (item: FileItem) => {
    // 目录不可下载；符号链接按文件处理（后端 sftp.open 会解引用到目标文件）
    if (item.type === 'directory' || !sessionId) return;

    let target: string | null = null;
    try {
      target = await save({
        title: t('sftp.downloadTitle'),
        defaultPath: item.name,
      });
    } catch (error) {
      console.error('[SftpDownload] save dialog error', error);
      toast.error(t('sftp.downloadDialogFailed', { message: String(error) }));
      return;
    }
    if (!target) return;

    // 断点续传：本地已有部分文件时询问是否从断点继续
    let offset = 0;
    if (item.size > 0) {
      const localSize = await localFileSize(target).catch(() => 0);
      if (localSize > 0 && localSize < item.size) {
        const resume = await ask(
          t('sftp.resumeDownloadPrompt', { name: item.name, done: localSize, total: item.size }),
          { title: t('sftp.downloadTitle'), kind: 'info', okLabel: t('sftp.resume'), cancelLabel: t('sftp.overwrite') },
        );
        if (resume) offset = localSize;
      }
    }

    // 用户已确认保存路径，才提示开始下载（取消对话框时不再误报）
    toast.info(t('sftp.startDownload', { name: item.name }));

    const remotePath = joinRemotePath(item.name);
    const cancelToken = `dl-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const taskId = addTransfer({
      name: item.name,
      kind: 'download',
      status: 'active',
      done: 0,
      total: 0,
      sessionId,
      remotePath,
      host: sftpConfig?.host,
      protocol: sftpConfig?.protocol || 'sftp',
      cancelToken,
    });
    try {
      await sftpDownloadFileProgress(sessionId, remotePath, target, offset, cancelToken);
      // 若期间被「结束任务」取消（store 已标 cancelled），不再标 done
      if (isCancelRequested(taskId)) {
        scheduleTransferDismiss(taskId);
        return;
      }
      updateTransfer(taskId, { status: 'done' });
      scheduleTransferDismiss(taskId);
    } catch (error) {
      console.error('[SftpDownload] invoke failed', error);
      // 已主动取消：保持 cancelled 状态，定时移除，不标 error
      if (isCancelRequested(taskId)) {
        scheduleTransferDismiss(taskId);
        return;
      }
      updateTransfer(taskId, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(t('sftp.downloadFailed', { message: String(error) }));
    }
  };

  // 递归下载目录：遍历远端目录树，逐个文件下载到本地对应路径（后端自动创建父目录）
  const downloadDirRecursive = async (
    remoteDir: string,
    localDir: string,
    results: { ok: number; failed: string[] },
  ) => {
    const entries = await sftpListDir(sessionId!, remoteDir);
    for (const entry of entries) {
      const remoteChild = remoteDir.endsWith('/')
        ? `${remoteDir}${entry.name}`
        : `${remoteDir}/${entry.name}`;
      const localChild = `${localDir}/${entry.name}`;
      if (entry.type === 'directory') {
        await downloadDirRecursive(remoteChild, localChild, results);
      } else {
        // 断点续传：本地已有完整文件则跳过，半成品则从断点续传，缺失则全量下载
        let offset = 0;
        if (entry.size > 0) {
          const localSize = await localFileSize(localChild).catch(() => 0);
          if (localSize === entry.size) {
            results.ok += 1; // 已完整，跳过（意外退出重下目录时不重复下载已完成文件）
            continue;
          }
          if (localSize > 0 && localSize < entry.size) {
            offset = localSize;
          }
        }
        const cancelToken = `dl-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const taskId = addTransfer({
          name: entry.name,
          kind: 'download',
          status: 'active',
          done: offset,
          total: entry.size > 0 ? entry.size : 0,
          sessionId,
          remotePath: remoteChild,
          host: sftpConfig?.host,
          protocol: sftpConfig?.protocol || 'sftp',
          cancelToken,
        });
        try {
          await sftpDownloadFileProgress(sessionId!, remoteChild, localChild, offset, cancelToken);
          if (isCancelRequested(taskId)) {
            scheduleTransferDismiss(taskId);
            continue;
          }
          updateTransfer(taskId, { status: 'done' });
          scheduleTransferDismiss(taskId);
          results.ok += 1;
        } catch (error) {
          updateTransfer(taskId, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          results.failed.push(remoteChild);
        }
      }
    }
  };

  // 下载目录：选择本地目标目录后递归下载
  const handleDownloadDir = async (item: FileItem) => {
    if (item.type !== 'directory' || !sessionId) return;
    let targetDir: string | null = null;
    try {
      targetDir = await open({ directory: true, title: t('sftp.downloadDirTitle') });
    } catch (error) {
      console.error('[SftpDownload] open dir dialog error', error);
      toast.error(t('sftp.downloadDialogFailed', { message: String(error) }));
      return;
    }
    if (!targetDir) return;

    toast.info(t('sftp.startDownload', { name: item.name }));
    const remoteBase = joinRemotePath(item.name);
    const localBase = `${targetDir}/${item.name}`;
    const results = { ok: 0, failed: [] as string[] };
    try {
      await downloadDirRecursive(remoteBase, localBase, results);
      if (results.ok > 0) {
        toast.success(t('sftp.downloadedDir', { count: results.ok }));
      }
      if (results.failed.length > 0) {
        toast.error(
          t('sftp.downloadPartiallyFailed', {
            first: results.failed[0],
            more: results.failed.length > 1 ? t('sftp.downloadFailedMore', { count: results.failed.length }) : '',
          }),
        );
      }
    } catch (error) {
      toast.error(t('sftp.downloadFailed', { message: String(error) }));
    }
  };

  const handleDownloadSelected = async () => {
    const selected = files.filter((file) => selectedFiles.has(file.name));
    if (selected.length === 0 || !sessionId) return;
    // 逐个下载（每个独立保存对话框 + 传输任务），失败不中断后续；目录复用 handleDownloadDir
    for (const item of selected) {
      if (item.type === 'directory') {
        await handleDownloadDir(item);
      } else {
        await handleDownload(item);
      }
    }
  };

  /** 打开远程文件到本机默认程序：临时下载 → 打开，并登记「编辑回传」跟踪。 */
  const handleOpenWithLocal = async (item: FileItem) => {
    if (item.type === 'directory' || !sessionId) return;
    try {
      const tmp = await tempDir();
      // 时间戳前缀避免同名/重复打开互相覆盖
      const localPath = await joinPath(tmp, `${Date.now()}-${item.name}`);
      await sftpDownloadFileProgress(sessionId, joinRemotePath(item.name), localPath, 0);
      const id = `${Date.now()}`;
      setOpenEdits((list) => [
        ...list,
        { id, remotePath: joinRemotePath(item.name), localPath, name: item.name },
      ]);
      await openPath(localPath);
      toast.success(t('sftp.openLocalDone', { name: item.name }));
    } catch (e) {
      console.error('[SftpOpenLocal] open failed:', e);
      toast.error(t('sftp.openLocalFailed', { message: String(e) }));
    }
  };

  /** 把「本机编辑」后的临时文件回传到远程（覆盖确认后执行）。 */
  const handleSaveBack = async (edit: { id: string; remotePath: string; name: string }) => {
    if (!sessionId) return;
    const ok = await ask(t('sftp.saveBackConfirm', { name: edit.name }), {
      title: t('sftp.downloadTitle'),
      kind: 'warning',
    });
    if (!ok) return;
    const editFull = openEdits.find((e) => e.id === edit.id);
    if (!editFull) return;
    try {
      await sftpUploadLocal(sessionId, editFull.localPath, edit.remotePath, `sftp-up-${edit.id}`);
      setOpenEdits((list) => list.filter((e) => e.id !== edit.id));
      toast.success(t('sftp.saveBackDone', { name: edit.name }));
    } catch (e) {
      toast.error(t('sftp.saveBackFailed', { message: String(e) }));
    }
  };

  /** 双栏：把本机文件批量上传到当前远程目录（顺序执行，任一失败不中断）。 */
  /** 跨栏入口：按本地真实路径批量上传到当前目录（左栏「上传」与拖入本机文件共用）。 */
  const uploadPaths = async (localPaths: string[]) => {
    await uploadByPaths(localPaths);
    await loadFiles(currentPath);
  };

  /** 跨栏入口：把当前目录条目下载/复制到指定本地目录（目录递归、文件走标准任务）。 */
  const downloadTo = async (name: string, dir: string) => {
    if (!sessionId) return;
    const item = files.find((f) => f.name === name);
    if (!item) throw new Error(`remote file not found: ${name}`);
    if (item.type === 'directory') {
      const remoteBase = joinRemotePath(item.name);
      const localBase = `${dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`}${item.name}`;
      const results = { ok: 0, failed: [] as string[] };
      await downloadDirRecursive(remoteBase, localBase, results);
      if (results.ok > 0) toast.success(t('sftp.downloadedDir', { count: results.ok }));
      if (results.failed.length > 0) {
        toast.error(
          t('sftp.downloadPartiallyFailed', {
            first: results.failed[0],
            more: results.failed.length > 1 ? t('sftp.downloadFailedMore', { count: results.failed.length }) : '',
          }),
        );
      }
      return;
    }
    const target = await joinPath(dir, item.name);
    let offset = 0;
    if (item.size > 0) {
      const localSize = await localFileSize(target).catch(() => 0);
      if (localSize > 0 && localSize < item.size) {
        const resume = await ask(t('sftp.resumeDownloadPrompt', { name: item.name, done: localSize, total: item.size }), {
          title: t('sftp.downloadTitle'),
          kind: 'info',
          okLabel: t('sftp.resume'),
          cancelLabel: t('sftp.overwrite'),
        });
        if (resume) offset = localSize;
      }
    }
    const remotePath = joinRemotePath(item.name);
    const cancelToken = `dl-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const taskId = addTransfer({
      name: item.name,
      kind: 'download',
      status: 'active',
      done: 0,
      total: 0,
      sessionId,
      remotePath,
      host: sftpConfig?.host,
      protocol: sftpConfig?.protocol || 'sftp',
      cancelToken,
    });
    try {
      await sftpDownloadFileProgress(sessionId, remotePath, target, offset, cancelToken);
      if (isCancelRequested(taskId)) {
        scheduleTransferDismiss(taskId);
        return;
      }
      updateTransfer(taskId, { status: 'done' });
      scheduleTransferDismiss(taskId);
      toast.success(t('sftp.downloadedToLocal', { name: item.name }));
    } catch (error) {
      if (isCancelRequested(taskId)) {
        scheduleTransferDismiss(taskId);
        return;
      }
      updateTransfer(taskId, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(t('sftp.downloadFailed', { message: String(error) }));
    }
  };

  // 跨栏操作句柄：组合层（SftpView）通过 ref 调用，实现左右栏互拖/上传
  useImperativeHandle(ref, () => ({
    uploadPaths,
    downloadTo,
    refresh: () => {
      void loadFiles(currentPath);
    },
  }));

  const handleDelete = async (item: FileItem) => {
    if (!sessionId) return;
    const isDir = item.type === 'directory';
    // 目录用更明确的递归删除提示（会连同所有子项一起删除）
    const ok = await ask(
      isDir
        ? t('sftp.deleteDirConfirmBody', { name: item.name })
        : t('sftp.deleteFileConfirmBody', { name: item.name }),
      { title: t('common.deleteConfirm'), kind: 'warning' },
    );
    if (!ok) return;

    try {
      if (isDir) {
        await sftpRemoveDirRecursive(sessionId, joinRemotePath(item.name));
      } else {
        await sftpDeleteFile(sessionId, joinRemotePath(item.name));
      }
      toast.success(t('sftp.deletedFile', { name: item.name }));
      removeFromSelection(item.name);
      await loadFiles(currentPath);
    } catch (error) {
      toast.error(t('sftp.deleteFailed', { message: String(error) }));
    }
  };

  // 批量删除选中的文件/目录（任一失败不中断后续）
  const handleDeleteSelected = async () => {
    if (!sessionId) return;
    const selected = files.filter((file) => selectedFiles.has(file.name));
    if (selected.length === 0) return;
    const ok = await ask(t('sftp.deleteSelectedConfirm', { count: selected.length }), { title: t('common.deleteConfirm'), kind: 'warning' });
    if (!ok) return;

    let success = 0;
    const failures: string[] = [];
    for (const item of selected) {
      try {
        if (item.type === 'directory') {
          await sftpRemoveDirRecursive(sessionId, joinRemotePath(item.name));
        } else {
          await sftpDeleteFile(sessionId, joinRemotePath(item.name));
        }
        success += 1;
      } catch {
        failures.push(item.name);
      }
    }
    if (success > 0) {
      toast.success(t('sftp.deletedSelected', { success, total: selected.length }));
    }
    if (failures.length > 0) {
      toast.error(t('sftp.deleteSelectedFailed', { names: failures.join('、') }));
    }
    clearSelection();
    await loadFiles(currentPath);
  };

  const copyRemotePath = (name: string) => {
    const path = joinRemotePath(name);
    navigator.clipboard
      .writeText(path)
      .then(() => toast.success(t('sftp.copiedRemotePath', { path })))
      .catch(() => toast.error(t('common.copyFailed')));
  };

  const handleCreateDir = () => {
    if (!sessionId) return;
    setPromptState({ mode: 'mkdir', value: '' });
  };

  // 打开搜索对话框
  const handleOpenSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchOpen(true);
  };

  // 递归搜索当前目录下的文件名
  const handleSearch = async () => {
    if (!sessionId || !searchQuery.trim()) return;
    setSearchLoading(true);
    try {
      const results = await sftpSearchFiles(sessionId, currentPath, searchQuery.trim());
      setSearchResults(results);
    } catch (e) {
      toast.error(t('sftp.searchFailed', { message: String(e) }));
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  // 点击搜索结果：跳转到其所在目录
  const handleSearchResultClick = (path: string) => {
    const parent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '/';
    setSearchOpen(false);
    handleNavigate(parent || '/');
  };

  const handleRename = (item: FileItem) => {
    if (!sessionId) return;
    setPromptState({ mode: 'rename', value: item.name, itemName: item.name });
  };

  const handleChmod = (item: FileItem) => {
    if (!sessionId) return;
    // 用当前权限（八进制字符串）作为初始值，如 "755" / "644"
    const current = /^\d+$/.test(item.permissions) ? item.permissions : '755';
    setPromptState({ mode: 'chmod', value: current, itemName: item.name });
  };

  const confirmPrompt = async () => {
    if (!promptState || !sessionId) return;
    const value = promptState.value.trim();
    if (!value) return;
    try {
      if (promptState.mode === 'mkdir') {
        await sftpCreateDir(sessionId, joinRemotePath(value));
        toast.success(t('sftp.createdDir', { name: value }));
      } else if (promptState.mode === 'rename') {
        const oldName = promptState.itemName || '';
        if (value === oldName) return;
        await sftpRename(sessionId, joinRemotePath(oldName), joinRemotePath(value));
        toast.success(t('sftp.renamedTo', { name: value }));
        clearSelection();
      } else {
        // chmod：解析八进制权限
        const mode = parseInt(value, 8);
        if (Number.isNaN(mode) || mode < 0 || mode > 0o7777) {
          toast.error(t('sftp.chmodInvalid'));
          return;
        }
        await sftpChmod(sessionId, joinRemotePath(promptState.itemName || ''), mode);
        toast.success(t('sftp.chmodDone', { name: promptState.itemName }));
      }
      await loadFiles(currentPath);
    } catch (error) {
      toast.error(
        promptState.mode === 'mkdir'
          ? t('sftp.createDirFailed', { message: String(error) })
          : promptState.mode === 'rename'
            ? t('sftp.renameFailed', { message: String(error) })
            : t('sftp.chmodFailed', { message: String(error) }),
      );
    } finally {
      setPromptState(null);
    }
  };

  const handleDoubleClick = (item: FileItem) => {
    if (item.type === 'directory') {
      const newPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
      handleNavigate(newPath);
    } else {
      handleDownload(item);
    }
  };

  const handleGoBack = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = '/' + parts.join('/');
    handleNavigate(newPath || '/');
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const toggleSelection = (fileName: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(fileName)) {
      newSelection.delete(fileName);
    } else {
      newSelection.add(fileName);
    }
    setSelectedFilesLocal(newSelection);
    if (sessionId) {
      setSelectedFilesInPool(sessionId, newSelection);
    }
  };

  // 排序：目录始终优先，组内按当前排序键
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    let cmp = 0;
    if (sortKey === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (sortKey === 'size') {
      cmp = a.size - b.size;
    } else {
      cmp = a.modified.localeCompare(b.modified);
    }
    return sortAsc ? cmp : -cmp;
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) {
      return <IconArrowUpDown size={12} className="opacity-40" />;
    }
    return sortAsc ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />;
  };

  // 面包屑分段
  const pathSegments = currentPath.split('/').filter(Boolean);

  // 选中条目数（含目录：目录走 handleDownloadDir 复用文件夹下载）
  const selectedFileCount = files.filter((f) => selectedFiles.has(f.name)).length;
  const canOpenLocal =
    selectedFileCount === 1 && !!files.find((f) => f.type !== 'directory' && selectedFiles.has(f.name));

  if (!sftpConfig) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">{t('sftp.invalidConfig')}</div>
    );
  }

  // FTP：无 POSIX 权限、LIST 亦不可靠给修改时间 → 隐藏权限列/修改时间列/chmod（含右键）
  const isFtp = (sftpConfig.protocol || 'sftp').toLowerCase() === 'ftp';
  const listCols = isFtp ? LIST_COLS_FTP : LIST_COLS_PERM;

  return (
    <div
      className="@container relative flex h-full w-full flex-col"
      style={{ width: '100%', height: '100%', overflow: 'hidden', boxSizing: 'border-box' }}
    >
      {/* 本标签的传输面板（按 sessionId 隔离，切走隐藏、切回保留） */}
      <SftpTransferPanel sessionId={sessionId} title={t('transfer.titleWithHost', { host: sftpConfig.host })} />
      {/* 连接中显示进度，连接后显示文件浏览器 */}
      {showProgress ? (
        <ConnectionProgress
          visible={showProgress}
          steps={connectionSteps}
          onClose={handleCloseProgress}
          onRetry={handleRetryConnection}
          onCancel={isConnectingState ? handleCancelConnection : undefined}
        />
      ) : (
        <>
          {/* 工具栏 */}
          <div className="flex items-center gap-2 border-b border-border bg-muted p-3">
            {toolbarPrefix}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleGoBack}
                disabled={currentPath === '/'}
                title={t('sftp.back')}
              >
                <IconArrowLeft size={18} strokeWidth={2} />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => handleNavigate('/')} title={t('sftp.root')}>
                <IconHome size={18} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => loadFiles(currentPath)}
                disabled={loading}
                title={t('common.refresh')}
              >
                <IconRefresh size={18} strokeWidth={2} className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>

            {/* 当前路径（面包屑，点击分段跳转）；超宽直接裁掉（overflow-x-hidden），不用滚动容器 */}
            <div
              className="flex h-9 min-w-0 flex-1 items-center gap-0.5 overflow-x-hidden whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm"
              title={currentPath}
            >
                <span className="shrink-0 text-muted-foreground">{sftpConfig.host}:</span>
                <button
                  type="button"
                  className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => handleNavigate('/')}
                  title={t('sftp.rootSegment')}
                >
                  /
                </button>
                {pathSegments.map((segment, index) => {
                  const target = '/' + pathSegments.slice(0, index + 1).join('/');
                  const isLast = index === pathSegments.length - 1;
                  return (
                    <span key={target} className="flex shrink-0 items-center gap-0.5">
                      <IconChevronRight size={12} className="text-muted-foreground/60" />
                      <button
                        type="button"
                        className={
                          isLast
                            ? 'rounded px-1 text-foreground'
                            : 'rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
                        }
                        onClick={() => handleNavigate(target)}
                      >
                        {segment}
                      </button>
                    </span>
                  );
                })}
            </div>

            {/* 操作按钮：宽屏完整组；窄栏（容器查询）收进「更多操作」二级菜单，不再溢出 */}
            <div className="hidden items-center gap-1 @[560px]:flex">
              <Button
                size="sm"
                onClick={handleUploadClick}
                disabled={!sessionId}
                title={t('sftp.uploadFile')}
              >
                <IconUpload size={16} strokeWidth={2} />
                {t('sftp.upload')}
              </Button>
              <Button
                size="sm"
                onClick={handleDownloadSelected}
                disabled={selectedFileCount === 0}
                title={t('sftp.downloadSelected')}
              >
                <IconDownload size={16} strokeWidth={2} />
                {t('sftp.download')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const target = files.find((f) => f.type !== 'directory' && selectedFiles.has(f.name));
                  if (target) void handleOpenWithLocal(target);
                }}
                disabled={!canOpenLocal}
                title={t('sftp.openWithLocal')}
              >
                <IconExternalLink size={16} strokeWidth={2} />
                {t('sftp.openWithLocal')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleOpenSearch}
                title={t('sftp.search')}
              >
                <IconSearch size={16} strokeWidth={2} />
                {t('sftp.search')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleCreateDir}
                title={t('sftp.newFolder')}
              >
                <IconFolderPlus size={16} strokeWidth={2} />
                {t('sftp.newFolder')}
              </Button>
            </div>
            <div className="flex items-center gap-1 @[560px]:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" title={t('common.moreActions')}>
                    <IconMoreHorizontal size={18} strokeWidth={2} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => void handleUploadClick()} disabled={!sessionId}>
                    <IconUpload size={15} className="mr-2" /> {t('sftp.uploadFile')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleDownloadSelected()} disabled={selectedFileCount === 0}>
                    <IconDownload size={15} className="mr-2" /> {t('sftp.downloadSelected')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      const target = files.find((f) => f.type !== 'directory' && selectedFiles.has(f.name));
                      if (target) void handleOpenWithLocal(target);
                    }}
                    disabled={!canOpenLocal}
                  >
                    <IconExternalLink size={15} className="mr-2" /> {t('sftp.openWithLocal')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleOpenSearch}>
                    <IconSearch size={15} className="mr-2" /> {t('sftp.search')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleCreateDir}>
                    <IconFolderPlus size={15} className="mr-2" /> {t('sftp.newFolder')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelected} />

          {/* 本机编辑跟踪：临时下载的文件等待回传 */}
          {openEdits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card/50 px-3 py-1.5">
              <span className="text-[11px] text-muted-foreground">{t('sftp.editedHint')}</span>
              {openEdits.map((edit) => (
                <span
                  key={edit.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted px-2 py-0.5 font-mono text-[11px]"
                >
                  <IconFile size={12} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 max-w-48 truncate">{edit.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-primary hover:bg-primary/10"
                    title={t('sftp.saveBack')}
                    onClick={() => void handleSaveBack(edit)}
                  >
                    <IconUpload size={11} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    title={t('sftp.discardEdit')}
                    onClick={() => setOpenEdits((list) => list.filter((e) => e.id !== edit.id))}
                  >
                    <IconX size={11} />
                  </Button>
                </span>
              ))}
            </div>
          )}

          {/* 文件列表（支持拖拽上传到当前目录，空白区右键快捷操作） */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
                data-custom-contextmenu
              >
                {isDragOver && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5">
                    <div className="flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-primary/40 bg-background/80 px-8 py-5">
                      <IconUpload size={26} className="text-primary" strokeWidth={2} />
                      <span className="text-sm font-medium text-foreground">{t('sftp.dropToUpload')}</span>
                      <span className="text-xs text-muted-foreground">{t('sftp.dropMultiple')}</span>
                    </div>
                  </div>
                )}
                {/* 加载失败提示条：连接断开/路径错误时明确反馈，提供重新连接入口 */}
                {listError && (
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-destructive/5 px-4 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-destructive">
                      <IconAlert size={15} className="shrink-0" />
                      <span className="truncate">{t('sftp.listErrorPrefix', { message: listError })}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => void handleReconnect()}
                    >
                      <IconRefresh size={14} strokeWidth={2} />
                      {t('sftp.reconnect')}
                    </Button>
                  </div>
                )}
                <ScrollArea className="min-h-0 w-full flex-1">
                {loading && files.length === 0 ? (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">{t('common.loading')}</div>
                ) : files.length === 0 ? (
                  <div className="flex h-full w-full items-center justify-center px-4 text-center text-muted-foreground">
                    {t('sftp.emptyDir')}
                    {isConnected(sessionId ?? '') ? t('sftp.emptyDirDropHint') : ''}
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-col">
                    {/* 表头（与左栏同构：行式表头 + 共享列模板 → 无固定整表宽，永不横向溢出） */}
                    <div
                      className={cn(
                        'grid h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium text-muted-foreground',
                        listCols,
                      )}
                    >
                      <span className="min-w-0" />
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1 overflow-hidden text-left transition-colors hover:text-foreground"
                        onClick={() => toggleSort('name')}
                      >
                        <span className="truncate">{t('sftp.tableName')}</span>
                        <span className="shrink-0">{sortIndicator('name')}</span>
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1 overflow-hidden text-left transition-colors hover:text-foreground"
                        onClick={() => toggleSort('size')}
                      >
                        <span className="truncate">{t('sftp.tableSize')}</span>
                        <span className="shrink-0">{sortIndicator('size')}</span>
                      </button>
                      {!isFtp && (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 overflow-hidden text-left transition-colors hover:text-foreground"
                          onClick={() => toggleSort('modified')}
                        >
                          <span className="truncate">{t('sftp.tableModified')}</span>
                          <span className="shrink-0">{sortIndicator('modified')}</span>
                        </button>
                      )}
                      {!isFtp && <span className="truncate">{t('sftp.tablePermissions')}</span>}
                    </div>
                      {sortedFiles.map((file) => {
                        const multiSelected = selectedFiles.has(file.name) && selectedFiles.size > 1;
                        const selected = selectedFiles.has(file.name);
                        return (
                          <ContextMenu key={file.name}>
                            <ContextMenuTrigger asChild>
                            <div
                              draggable={file.type !== 'directory'}
                              onContextMenu={(e) => {
                                // 行右键只开行级菜单：阻断冒泡到外层「空白区」ContextMenuTrigger，
                                // 否则两个嵌套 trigger 都响应 contextmenu，外层后开会把行菜单顶掉
                                e.stopPropagation();
                              }}
                              onDragStart={(e) => {
                                if (file.type === 'directory') return;
                                e.dataTransfer.setData(dragMime, file.name);
                                e.dataTransfer.setData('text/plain', file.name);
                                e.dataTransfer.effectAllowed = 'copy';
                              }}
                              onDoubleClick={(e) => {
                                // 双击落在交互元素（复选框/操作按钮）上时不触发行级双击，避免与单击冲突
                                if ((e.target as HTMLElement).closest('button')) return;
                                handleDoubleClick(file);
                              }}
                              className={cn(
                                'group grid min-h-9 items-center gap-2 border-b border-border/70 px-3 text-sm transition-colors',
                                listCols,
                                selected ? 'bg-primary/10 hover:bg-primary/10' : 'hover:bg-accent/40',
                              )}
                            >
                              <div className="flex min-w-0 items-center">
                                <Checkbox
                                  checked={selected}
                                  onCheckedChange={() => toggleSelection(file.name)}
                                />
                              </div>
                              <div className="flex min-w-0 items-center gap-2" title={file.name}>
                                {file.type === 'directory' ? (
                                  <IconFolder size={16} className="shrink-0 text-warning" strokeWidth={2} />
                                ) : (
                                  <IconFile size={16} className="shrink-0 text-muted-foreground" strokeWidth={2} />
                                )}
                                <span className="min-w-0 truncate text-sm">{file.name}</span>
                              </div>
                              <div className="min-w-0 truncate text-sm tabular-nums text-muted-foreground">
                                {file.type === 'directory' ? '—' : formatFileSize(file.size)}
                              </div>
                              {!isFtp && (
                                <div className="min-w-0 truncate text-sm text-muted-foreground" title={file.modified}>
                                  {file.modified.trim() && file.modified !== '-' ? file.modified : '—'}
                                </div>
                              )}
                              {!isFtp && (
                                <div
                                  className="min-w-0 truncate font-mono text-sm text-muted-foreground"
                                  title={file.permissions}
                                >
                                  {file.permissions.trim() && file.permissions !== '-' ? file.permissions : '—'}
                                </div>
                              )}
                            </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-52">
                              {file.type === 'directory' ? (
                                <>
                                  <ContextMenuItem onClick={() => handleDoubleClick(file)}>
                                    <IconFolderOpen size={15} className="mr-2" /> {t('sftp.open')}
                                  </ContextMenuItem>
                                  <ContextMenuItem onClick={() => void handleDownloadDir(file)}>
                                    <IconDownload size={15} className="mr-2" /> {t('sftp.downloadDir')}
                                  </ContextMenuItem>
                                </>
                              ) : (
                                <ContextMenuItem onClick={() => handleDownload(file)}>
                                  <IconDownload size={15} className="mr-2" /> {t('sftp.download')}
                                </ContextMenuItem>
                              )}
                              {selectedFileCount > 1 && (
                                <ContextMenuItem onClick={() => void handleDownloadSelected()}>
                                  <IconDownload size={15} className="mr-2" /> {t('sftp.downloadSelectedN', { count: selectedFileCount })}
                                </ContextMenuItem>
                              )}
                              <ContextMenuItem onClick={() => copyRemotePath(file.name)}>
                                <IconClipboard size={15} className="mr-2" /> {t('sftp.copyRemotePath')}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              {multiSelected && (
                                <ContextMenuItem
                                  className="text-destructive"
                                  onClick={() => void handleDeleteSelected()}
                                >
                                  <IconTrash size={15} className="mr-2" /> {t('sftp.deleteSelectedN', { count: selectedFiles.size })}
                                </ContextMenuItem>
                              )}
                              <ContextMenuItem onClick={() => handleRename(file)}>
                                <IconPencil size={15} className="mr-2" /> {t('sftp.rename')}
                              </ContextMenuItem>
                              {!isFtp && (
                                <ContextMenuItem onClick={() => handleChmod(file)}>
                                  <IconShield size={15} className="mr-2" /> {t('sftp.chmod')}
                                </ContextMenuItem>
                              )}
                              <ContextMenuItem
                                className="text-destructive"
                                onClick={() => void handleDelete(file)}
                              >
                                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                  </div>
                )}
                </ScrollArea>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <ContextMenuItem onClick={() => loadFiles(currentPath)}>
                <IconRefresh size={15} className="mr-2" /> {t('common.refresh')}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCreateDir}>
                <IconFolderPlus size={15} className="mr-2" /> {t('sftp.newFolder')}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleUploadClick}>
                <IconUpload size={15} className="mr-2" /> {t('sftp.uploadFile')}
              </ContextMenuItem>
              {hasTransfersInTab && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => dismissTransferBySession()}>
                    <IconX size={15} className="mr-2" /> {t('sftp.clearTabTransfers')}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </>
      )}

      {/* 新建目录 / 重命名 / 修改权限 输入对话框 */}
      <Dialog open={promptState !== null} onOpenChange={(open) => { if (!open) setPromptState(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {promptState?.mode === 'mkdir'
                ? t('sftp.newFolderTitle')
                : promptState?.mode === 'rename'
                  ? t('sftp.renameTitle')
                  : t('sftp.chmodTitle')}
            </DialogTitle>
          </DialogHeader>
          {promptState?.mode === 'chmod' ? (
            <ChmodMatrix
              value={promptState?.value || '755'}
              onChange={(octal) => setPromptState((prev) => (prev ? { ...prev, value: octal } : prev))}
            />
          ) : (
            <Input
              autoFocus
              value={promptState?.value ?? ''}
              onChange={(e) => setPromptState((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
              placeholder={
                promptState?.mode === 'mkdir'
                  ? t('sftp.inputDirName')
                  : promptState?.mode === 'rename'
                    ? t('sftp.inputNewName')
                    : t('sftp.chmodPlaceholder')
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmPrompt();
              }}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromptState(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmPrompt} disabled={!promptState?.value.trim()}>
              {t('sftp.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 文件搜索对话框 */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('sftp.searchTitle')}</DialogTitle>
          </DialogHeader>
          <div className="relative mb-2">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch();
              }}
              placeholder={t('sftp.searchFileNamePlaceholder')}
              className="pl-8"
            />
          </div>
          <div className="overlay-scrollbar max-h-72 overflow-y-auto pr-1">
            {searchLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('common.loading')}
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
                {searchQuery.trim() ? t('sftp.searchEmpty') : t('sftp.searchHint')}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {searchResults.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => handleSearchResultClick(path)}
                    className="truncate rounded-md px-3 py-2 text-left font-mono text-xs text-foreground transition-colors hover:bg-accent"
                    title={path}
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSearchOpen(false)}>
              {t('common.close')}
            </Button>
            <Button onClick={() => void handleSearch()} disabled={!searchQuery.trim() || searchLoading}>
              {t('sftp.search')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

/** 双栏 SFTP 视图：左栏（本机 ⇄ 另一台主机）+ 右栏远端，两侧各渲染一个能力对等的 SftpPane。 */
export function SftpView({ sessionId, isActive = true, sftpConfig }: SftpViewProps) {
  const { t } = useTranslation();
  const rightPaneRef = useRef<SftpPaneHandle>(null);

  // 左栏远程源：解析认证后交给 SftpPane 自管连接（进度/主机密钥/重连全套复用右栏逻辑）
  const [leftRemote, setLeftRemote] = useState<{
    sessionId: string;
    hostName: string;
    config: NonNullable<SftpViewProps['sftpConfig']>;
  } | null>(null);
  const [leftBusy, setLeftBusy] = useState(false);
  const [hostOptions, setHostOptions] = useState<{ id: string; name: string }[]>([]);
  // 拖拽高亮：右栏被拖入（本机/左栏远端）；左栏远端被拖入（右栏文件）
  const [dragLocalOver, setDragLocalOver] = useState(false);
  const [dragRightOver, setDragRightOver] = useState(false);

  // 左栏主机选择器选项（已保存主机）
  useEffect(() => {
    void getHosts()
      .then((hs) => setHostOptions(hs.map((h) => ({ id: h.id, name: h.name }))))
      .catch(() => setHostOptions([]));
  }, []);

  // 组件卸载时断开左栏远程会话
  const leftRemoteRef = useRef(leftRemote);
  useEffect(() => {
    leftRemoteRef.current = leftRemote;
  }, [leftRemote]);
  useEffect(
    () => () => {
      const cur = leftRemoteRef.current;
      if (cur) void sftpDisconnect(cur.sessionId).catch(() => {});
    },
    [],
  );

  /** 左栏连接另一台已保存主机：解析认证 → 组配置 → SftpPane 接管连接流程。 */
  const attachLeftRemote = async (hostId: string) => {
    if (!sessionId || leftBusy) return;
    const host = (await getHosts()).find((h) => h.id === hostId);
    if (!host) return;
    if (leftRemote?.hostName === host.name) return;
    setLeftBusy(true);
    try {
      if (leftRemote) {
        try {
          await sftpDisconnect(leftRemote.sessionId);
        } catch {
          /* 忽略旧会话清理失败 */
        }
        setLeftRemote(null);
      }
      const [accounts, keys, certs] = await Promise.all([
        getAccounts().catch(() => []),
        getKeys().catch(() => []),
        getCertificates().catch(() => []),
      ]);
      const auth = resolveHostSshAuth(host, accounts, keys, certs);
      if (auth.error) {
        toast.warning(auth.error);
        return;
      }
      if (auth.authType === 'certificate' || auth.authType === 'none') {
        toast.warning(t('sftp.leftUnsupported'));
        return;
      }
      setLeftRemote({
        sessionId: `sftp-left-${Date.now()}`,
        hostName: host.name,
        config: {
          name: host.name,
          host: host.host,
          port: host.port,
          username: auth.username,
          protocol: 'sftp',
          authType: auth.authType === 'key' ? 'publickey' : 'password',
          password: auth.password,
          keyId: auth.authType === 'key' ? auth.keyId : undefined,
          remotePath: '/',
        },
      });
    } finally {
      setLeftBusy(false);
    }
  };

  /** 断开左栏远程源，回到本机目录。 */
  const releaseLeftRemote = async () => {
    const cur = leftRemote;
    setLeftRemote(null);
    if (cur) {
      try {
        await sftpDisconnect(cur.sessionId);
      } catch {
        /* ignore */
      }
    }
  };

  /** 右栏文件拖入左栏（本机模式）：下载到左栏当前目录。 */
  const handleFileFromRight = async (name: string, dir: string) => {
    await rightPaneRef.current?.downloadTo(name, dir);
  };

  /** 右栏文件拖入左栏（远端模式）：流式复制到左栏当前目录（不落本地磁盘）。 */
  const handleRemoteDropToLeft = async (name: string) => {
    if (!sessionId || !leftRemote) return;
    const srcBase = getCurrentPath(sessionId) || '/';
    const src = srcBase === '/' ? `/${name}` : `${srcBase}/${name}`;
    const dstBase = getCurrentPath(leftRemote.sessionId) || '/';
    const dst = dstBase === '/' ? `/${name}` : `${dstBase}/${name}`;
    await sftpStreamCopy(sessionId, src, leftRemote.sessionId, dst);
    toast.success(t('sftp.streamCopied', { name }));
  };

  /** 左栏远端文件拖入右栏：流式复制到右栏当前目录（不落本地磁盘）。 */
  const handleLeftRemoteDropToRight = async (raw: string) => {
    if (!sessionId || !leftRemote) return;
    const name = raw.split('/').filter(Boolean).pop() ?? 'file';
    const dstBase = getCurrentPath(sessionId) || '/';
    const dst = dstBase === '/' ? `/${name}` : `${dstBase}/${name}`;
    await sftpStreamCopy(leftRemote.sessionId, raw, sessionId, dst);
    toast.success(t('sftp.streamCopied', { name }));
    rightPaneRef.current?.refresh();
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* 左栏：本机目录 ⇄ 另一台主机（远端时渲染完整 SftpPane，能力与右栏对等） */}
      {leftRemote ? (
        <div
          className={cn(
            'flex h-full w-0 min-w-0 flex-1 flex-col',
            dragRightOver && 'ring-2 ring-inset ring-primary/40',
          )}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(MIME_REMOTE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragRightOver(true);
            }
          }}
          onDragLeave={() => setDragRightOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragRightOver(false);
            const names = e.dataTransfer.getData(MIME_REMOTE);
            if (!names) return;
            void (async () => {
              for (const name of names.split('\n').filter(Boolean)) {
                try {
                  await handleRemoteDropToLeft(name);
                } catch (err) {
                  toast.error(String(err));
                }
              }
            })();
          }}
        >
          <SftpPane
            key={leftRemote.sessionId}
            sessionId={leftRemote.sessionId}
            sftpConfig={leftRemote.config}
            isActive
            dragMime={MIME_LEFT_REMOTE}
            windowDragUploads={false}
            toolbarPrefix={
              /* 源切换（本机 ⇄ 已存主机）：仅一个图标按钮，内嵌工具栏保持两栏对等 */
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    disabled={leftBusy}
                    title={leftRemote.hostName}
                  >
                    {leftBusy ? (
                      <IconLoader size={16} className="animate-spin" />
                    ) : (
                      <IconServer size={16} strokeWidth={2} />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuLabel>{t('sftp.sourcePicker')}</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => void releaseLeftRemote()}>
                    <IconDrive size={14} className="mr-2" />
                    {t('sftp.sourceLocal')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {hostOptions.map((h) => (
                    <DropdownMenuItem
                      key={h.id}
                      onClick={() => void attachLeftRemote(h.id)}
                      disabled={leftRemote.hostName === h.name}
                    >
                      <IconServer size={14} className="mr-2" />
                      <span className="min-w-0 flex-1 truncate">{h.name}</span>
                    </DropdownMenuItem>
                  ))}
                  {hostOptions.length === 0 && (
                    <DropdownMenuItem disabled>{t('sftp.sourceNoHosts')}</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        </div>
      ) : (
        <LocalBrowser
          hostOptions={hostOptions}
          onPickHost={(hostId) => void attachLeftRemote(hostId)}
          onUploadFiles={async (paths) => {
            await rightPaneRef.current?.uploadPaths(paths);
          }}
          onFileFromRight={handleFileFromRight}
        />
      )}

      {/* 右栏：远端主会话；接收本机/左栏远端拖入 */}
      <div
        className={cn(
          'flex h-full min-w-0 flex-1 flex-col border-l border-border',
          dragLocalOver && 'bg-primary/5',
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MIME_LOCAL) || e.dataTransfer.types.includes(MIME_LEFT_REMOTE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDragLocalOver(true);
          }
        }}
        onDragLeave={() => setDragLocalOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragLocalOver(false);
          // 本机文件 → 直接上传到右栏当前目录
          const rawLocal = e.dataTransfer.getData(MIME_LOCAL);
          if (rawLocal) {
            void rightPaneRef.current?.uploadPaths(rawLocal.split('\n').filter(Boolean));
            return;
          }
          // 左栏为另一台主机 → 流式复制到右栏当前目录（不落本地磁盘）
          const rawLeftRemote = e.dataTransfer.getData(MIME_LEFT_REMOTE);
          if (rawLeftRemote) {
            void handleLeftRemoteDropToRight(rawLeftRemote);
          }
        }}
      >
        <SftpPane
          ref={rightPaneRef}
          sessionId={sessionId}
          sftpConfig={sftpConfig}
          isActive={isActive}
          dragMime={MIME_REMOTE}
        />
      </div>
    </div>
  );
}
