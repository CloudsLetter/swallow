import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
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
} from 'lucide-react';
import { ConnectionProgress } from './ConnectionProgress';
import { useSessionConnection, sftpSessionPool } from '../hooks/useSessionConnection';
import {
  acceptHostKey,
  sftpConnect,
  sftpDisconnect,
  sftpCreateDir,
  sftpDeleteFile,
  sftpRemoveDirRecursive,
  sftpDownloadFileProgress,
  sftpListDir,
  sftpRename,
  sftpChmod,
  sftpSearchFiles,
  sftpUploadChunk,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { ask, save, open } from '@tauri-apps/plugin-dialog';
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

/** 分块传输的块大小（字节），与后端 TRANSFER_CHUNK_BYTES 一致。 */
const TRANSFER_CHUNK = 1024 * 1024;

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

export function SftpView({ sessionId, isActive = true, sftpConfig }: SftpViewProps) {
  const { t } = useTranslation();
  // UI 本地状态（从池中同步）
  const [currentPath, setCurrentPathLocal] = useState(sftpConfig?.remotePath || '/');
  const [files, setFilesLocal] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFilesLocal] = useState<Set<string>>(new Set());
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
            const accepted = await ask(
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
  const uploadFiles = async (dropped: DroppedUpload) => {
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
    for (const { relativePath, file } of files) {
      const taskId = addTransfer({
        name: relativePath,
        kind: 'upload',
        status: 'active',
        done: 0,
        total: file.size,
        sessionId,
        host: sftpConfig?.host,
        protocol: sftpConfig?.protocol || 'sftp',
      });
      try {
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

  const handleUploadClick = () => {
    fileInputRef.current?.click();
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
    const dropped = await collectDroppedFiles(dataTransfer);
    if (dropped.files.length === 0) {
      toast.error(t('sftp.dropReadFailed'));
      return;
    }
    await uploadFiles(dropped);
  };

  useEffect(() => {
    if (!isActive) return;

    const handleDragEnter = (event: NativeDragEvent) => {
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const handleDragOver = (event: NativeDragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
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
        const cancelToken = `dl-${sessionId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const taskId = addTransfer({
          name: entry.name,
          kind: 'download',
          status: 'active',
          done: 0,
          total: 0,
          sessionId,
          remotePath: remoteChild,
          host: sftpConfig?.host,
          protocol: sftpConfig?.protocol || 'sftp',
          cancelToken,
        });
        try {
          await sftpDownloadFileProgress(sessionId!, remoteChild, localChild, 0, cancelToken);
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
    const selected = files.filter((file) => file.type !== 'directory' && selectedFiles.has(file.name));
    if (selected.length === 0 || !sessionId) return;
    // 逐个下载（每个独立保存对话框 + 传输任务），失败不中断后续
    for (const item of selected) {
      await handleDownload(item);
    }
  };

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

  // 选中的「文件」数（排除目录）：下载只作用于文件，避免选中目录时下载按钮/计数误报
  const selectedFileCount = files.filter((f) => f.type !== 'directory' && selectedFiles.has(f.name)).length;

  if (!sftpConfig) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">{t('sftp.invalidConfig')}</div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full flex-col"
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
        <div className="flex h-full flex-col">
          {/* 工具栏 */}
          <div className="flex items-center gap-2 border-b border-border bg-muted p-3">
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

            {/* 当前路径（面包屑，点击分段跳转） */}
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-3 py-1.5 text-sm">
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

            {/* 操作按钮 */}
            <div className="flex items-center gap-1">
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
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelected} />

          {/* 文件列表（支持拖拽上传到当前目录，空白区右键快捷操作） */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="relative flex-1 overflow-auto">
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
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-destructive/5 px-4 py-2 backdrop-blur">
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
                {loading ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">{t('common.loading')}</div>
                ) : files.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    {t('sftp.emptyDir')}
                    {isConnected(sessionId ?? '') ? t('sftp.emptyDirDropHint') : ''}
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left transition-colors hover:text-foreground"
                            onClick={() => toggleSort('name')}
                          >
                            {t('sftp.tableName')}{sortIndicator('name')}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left transition-colors hover:text-foreground"
                            onClick={() => toggleSort('size')}
                          >
                            {t('sftp.tableSize')}{sortIndicator('size')}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-left transition-colors hover:text-foreground"
                            onClick={() => toggleSort('modified')}
                          >
                            {t('sftp.tableModified')}{sortIndicator('modified')}
                          </button>
                        </TableHead>
                        <TableHead>{t('sftp.tablePermissions')}</TableHead>
                        <TableHead>{t('common.actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedFiles.map((file) => {
                        const multiSelected = selectedFiles.has(file.name) && selectedFiles.size > 1;
                        return (
                          <ContextMenu key={file.name}>
                            <ContextMenuTrigger asChild>
                              <TableRow
                                className={selectedFiles.has(file.name) ? 'bg-primary/10 hover:bg-primary/10' : ''}
                                onDoubleClick={(e) => {
                                  // 双击落在交互元素（复选框/操作按钮）上时不触发行级双击，避免与单击冲突
                                  if ((e.target as HTMLElement).closest('button')) return;
                                  handleDoubleClick(file);
                                }}
                              >
                      <TableCell>
                        <Checkbox
                          checked={selectedFiles.has(file.name)}
                          onCheckedChange={() => toggleSelection(file.name)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {file.type === 'directory' ? (
                            <IconFolder size={18} className="text-amber-600" strokeWidth={2} />
                          ) : (
                            <IconFile size={18} className="text-muted-foreground" strokeWidth={2} />
                          )}
                          <span className="text-sm">{file.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatFileSize(file.size)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{file.modified}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">{file.permissions}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {file.type !== 'directory' && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-muted-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownload(file);
                              }}
                              title={t('sftp.download')}
                            >
                              <IconDownload size={14} strokeWidth={2} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRename(file);
                            }}
                            title={t('sftp.rename')}
                          >
                            <IconPencil size={14} strokeWidth={2} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(file);
                            }}
                            title={t('common.delete')}
                          >
                            <IconTrash size={14} strokeWidth={2} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
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
                              <ContextMenuItem onClick={() => handleChmod(file)}>
                                <IconShield size={15} className="mr-2" /> {t('sftp.chmod')}
                              </ContextMenuItem>
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
                </TableBody>
              </Table>
            )}
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
        </div>
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
}
