//! SFTP 拖拽上传工具：目录树收集 + WebView2 原生桥取真实本地路径。
//! 自 SftpView 拆出（双栏两处上传入口共用）。

import { once } from '@tauri-apps/api/event';

/** 拖拽收集到的待上传内容：需创建的目录（相对路径）+ 待上传的文件（相对路径）。 */
export interface DroppedUpload {
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
export async function requestOsFilePaths(files: File[]): Promise<(string | undefined)[]> {
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
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedUpload> {
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
