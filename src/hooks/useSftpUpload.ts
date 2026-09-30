//! SFTP 上传编排 hook：拖拽目录树上传 / 上传按钮（后端直读）/ 分块 IPC 三通道
//! 的统一入口，含传输任务编排（任务卡 + 取消令牌 + 进度更新 + 结果 toast）。
//! 自 SftpView 拆出——状态与重载回调由视图注入。

import { toast } from 'sonner';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useTransferStore, isCancelRequested } from '../store/transferStore';
import {
  sftpCreateDir,
  sftpUploadChunk,
  sftpUploadFile,
  sftpUploadLocal,
} from '../services/sessionService';
import type { DroppedUpload } from '../components/sftp/droppedFiles';

/** 分块传输的块大小（字节）。单次整传的上限与后端 MAX_FILE_TRANSFER_BYTES 一致。
 *  ⚠️ 4MB（非更大）：无 path 的 IPC 分块在慢链路上单块需在会话 60s 超时内完成，
 *  8MB 在低带宽（<130KB/s）下会超时失败。直读路径不受此限制（后端 1MB 块循环）。 */
const TRANSFER_CHUNK = 4 * 1024 * 1024;
const MAX_SINGLE_UPLOAD = 100 * 1024 * 1024;

export interface SftpUploadDeps {
  sessionId: string;
  currentPath: string;
  host?: string;
  protocol: string;
  joinRemotePath: (name: string) => string;
  /** 上传完成后刷新当前目录列表 */
  reloadFiles: (path: string) => Promise<boolean>;
}

export function useSftpUpload({ sessionId, currentPath, host, protocol, joinRemotePath, reloadFiles }: SftpUploadDeps) {
  const { t } = useTranslation();
  const addTransfer = useTransferStore((s) => s.addTransfer);
  const updateTransfer = useTransferStore((s) => s.updateTransfer);
  const dismissTransfer = useTransferStore((s) => s.dismissTransfer);

  const scheduleTransferDismiss = (id: number, delay = 3000) => {
    setTimeout(() => dismissTransfer(id), delay);
  };

  /** 拖拽内容上传：先按深度建目录，再逐文件三通道分派（直读 → 整传 → 分块） */
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
        host,
        protocol,
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
        // 数据一次读完经 Raw IPC 传递。>100MB 走下方 4MB 分块（块大 → 打开次数 ÷8）
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
    await reloadFiles(currentPath);
  };

  /** 上传按钮：Tauri 原生对话框选文件（返回真实路径 → 后端直读流式上传，速度≈下载，
   *  绕开浏览器 File 无路径 / IPC 序列化瓶颈） */
  const handleUploadClick = async () => {
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
        host,
        protocol,
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

  return { uploadFiles, handleUploadClick, uploadByPaths };
}
