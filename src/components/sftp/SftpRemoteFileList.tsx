//! SFTP 远端文件列表（虚拟化）：表头排序 + 视口内渲染行 + 行级右键菜单。
//! 自 SftpView 拆出：状态与处理器留在 SftpPane（需要会话上下文），本组件是纯展示层。

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Clipboard as IconClipboard,
  Download as IconDownload,
  File as IconFile,
  Folder as IconFolder,
  FolderOpen as IconFolderOpen,
  Pencil as IconPencil,
  Shield as IconShield,
  Trash2 as IconTrash,
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Checkbox } from '../ui/checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import type { FileItem } from '../sftpPool';
import { cn } from '@/lib/utils';

export type SortKey = 'name' | 'size' | 'modified';

export interface SftpRemoteFileListProps {
  /** 已排序的文件列表（排序在 SftpPane 完成） */
  sortedFiles: FileItem[];
  loading: boolean;
  emptyHint: React.ReactNode;
  isFtp: boolean;
  listCols: string;
  dragMime: string;
  onToggleSort: (key: SortKey) => void;
  sortIndicator: (key: SortKey) => React.ReactNode;
  selectedFiles: Set<string>;
  selectedFileCount: number;
  onToggleSelection: (name: string) => void;
  onOpen: (file: FileItem) => void;
  onDownload: (file: FileItem) => void;
  onDownloadDir: (file: FileItem) => void;
  onDownloadSelected: () => void | Promise<void>;
  onCopyRemotePath: (name: string) => void;
  onDeleteSelected: () => void | Promise<void>;
  onRename: (file: FileItem) => void;
  onChmod: (file: FileItem) => void;
  onDelete: (file: FileItem) => void;
  formatFileSize: (bytes: number) => string;
}

export function SftpRemoteFileList({
  sortedFiles,
  loading,
  emptyHint,
  isFtp,
  listCols,
  dragMime,
  onToggleSort,
  sortIndicator,
  selectedFiles,
  selectedFileCount,
  onToggleSelection,
  onOpen,
  onDownload,
  onDownloadDir,
  onDownloadSelected,
  onCopyRemotePath,
  onDeleteSelected,
  onRename,
  onChmod,
  onDelete,
  formatFileSize,
}: SftpRemoteFileListProps) {
  const { t } = useTranslation();
  // 大目录虚拟滚动：只渲染视口内的行（10k 条目目录不再生成十万级 DOM 节点）。
  // 行高固定 36px（min-h-9 + truncate 单行），measureElement 兜底精确测量。
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: sortedFiles.length,
    getScrollElement: () => listViewportRef.current,
    estimateSize: () => 36,
    overscan: 14,
  });

  return (
    <ScrollArea
      className="min-h-0 w-full flex-1"
      viewportRef={listViewportRef}
      viewportClassName="[&>div]:!block"
    >
      {loading && sortedFiles.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">{t('common.loading')}</div>
      ) : sortedFiles.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
          {emptyHint}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col">
          {/* 表头（行式表头 + 共享列模板 → 无固定整表宽，永不横向溢出） */}
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
              onClick={() => onToggleSort('name')}
            >
              <span className="truncate">{t('sftp.tableName')}</span>
              <span className="shrink-0">{sortIndicator('name')}</span>
            </button>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 overflow-hidden text-left transition-colors hover:text-foreground"
              onClick={() => onToggleSort('size')}
            >
              <span className="truncate">{t('sftp.tableSize')}</span>
              <span className="shrink-0">{sortIndicator('size')}</span>
            </button>
            {!isFtp && (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 overflow-hidden text-left transition-colors hover:text-foreground"
                onClick={() => onToggleSort('modified')}
              >
                <span className="truncate">{t('sftp.tableModified')}</span>
                <span className="shrink-0">{sortIndicator('modified')}</span>
              </button>
            )}
            {!isFtp && <span className="truncate">{t('sftp.tablePermissions')}</span>}
          </div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const file = sortedFiles[vi.index];
              const multiSelected = selectedFiles.has(file.name) && selectedFiles.size > 1;
              const selected = selectedFiles.has(file.name);
              return (
                <div
                  key={file.name}
                  ref={rowVirtualizer.measureElement}
                  data-index={vi.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <ContextMenu>
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
                          // 多选时把整批选中项一起带出（drop 侧按 \n 逐条处理）。
                          // 只写 file.name 的话，选中 3 个却只拖走光标下这 1 个。
                          // 目录行本身不可拖，选中集里的目录一并过滤
                          const names =
                            selectedFiles.size > 1 && selectedFiles.has(file.name)
                              ? sortedFiles
                                  .filter((f) => f.type !== 'directory' && selectedFiles.has(f.name))
                                  .map((f) => f.name)
                              : [file.name];
                          const payload = names.join('\n');
                          e.dataTransfer.setData(dragMime, payload);
                          e.dataTransfer.setData('text/plain', payload);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onDoubleClick={(e) => {
                          // 双击落在交互元素（复选框/操作按钮）上时不触发行级双击，避免与单击冲突
                          if ((e.target as HTMLElement).closest('button')) return;
                          onOpen(file);
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
                            onCheckedChange={() => onToggleSelection(file.name)}
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
                          <ContextMenuItem onClick={() => onOpen(file)}>
                            <IconFolderOpen size={15} className="mr-2" /> {t('sftp.open')}
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => void onDownloadDir(file)}>
                            <IconDownload size={15} className="mr-2" /> {t('sftp.downloadDir')}
                          </ContextMenuItem>
                        </>
                      ) : (
                        <ContextMenuItem onClick={() => onDownload(file)}>
                          <IconDownload size={15} className="mr-2" /> {t('sftp.download')}
                        </ContextMenuItem>
                      )}
                      {selectedFileCount > 1 && (
                        <ContextMenuItem onClick={() => void onDownloadSelected()}>
                          <IconDownload size={15} className="mr-2" /> {t('sftp.downloadSelectedN', { count: selectedFileCount })}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => onCopyRemotePath(file.name)}>
                        <IconClipboard size={15} className="mr-2" /> {t('sftp.copyRemotePath')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {multiSelected && (
                        <ContextMenuItem
                          className="text-destructive"
                          onClick={() => void onDeleteSelected()}
                        >
                          <IconTrash size={15} className="mr-2" /> {t('sftp.deleteSelectedN', { count: selectedFiles.size })}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => onRename(file)}>
                        <IconPencil size={15} className="mr-2" /> {t('sftp.rename')}
                      </ContextMenuItem>
                      {!isFtp && (
                        <ContextMenuItem onClick={() => onChmod(file)}>
                          <IconShield size={15} className="mr-2" /> {t('sftp.chmod')}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        className="text-destructive"
                        onClick={() => void onDelete(file)}
                      >
                        <IconTrash size={15} className="mr-2" /> {t('common.delete')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </ScrollArea>
  );
}
