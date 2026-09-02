export interface ConnectionStep {
  id: string;
  label: string;
  status: 'pending' | 'loading' | 'success' | 'error';
  message?: string;
}

export interface FileItem {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
  permissions: string;
}

type SftpPoolItem = {
  // SFTP 连接状态
  connected: boolean;
  isConnecting: boolean;
  
  // 文件浏览状态
  currentPath: string;
  files: FileItem[];
  selectedFiles: Set<string>;
  
  // 连接进度状态
  connectionSteps?: ConnectionStep[];
  
  // 连接函数（用于重试）
  connectFunction?: () => Promise<void>;
  
  // 进度窗口显示状态
  showProgress?: boolean;
};

const pool: Record<string, SftpPoolItem> = {};

export function createOrGetSftpSession(sessionId: string, initialPath: string = '/') {
  if (pool[sessionId]) return pool[sessionId];

  pool[sessionId] = {
    connected: false,
    isConnecting: false,
    currentPath: initialPath,
    files: [],
    selectedFiles: new Set(),
  };
  
  return pool[sessionId];
}

export function getSftpSession(sessionId: string): SftpPoolItem | undefined {
  return pool[sessionId];
}

export function disposeSftpSession(sessionId: string) {
  delete pool[sessionId];
}

// 连接状态管理
export function isConnected(sessionId: string): boolean {
  return pool[sessionId]?.connected ?? false;
}

export function isConnecting(sessionId: string): boolean {
  return pool[sessionId]?.isConnecting ?? false;
}

export function markConnected(sessionId: string, connected: boolean = true) {
  const item = pool[sessionId];
  if (item) {
    item.connected = connected;
    if (connected) {
      item.isConnecting = false;
    }
  }
}

export function markConnecting(sessionId: string, connecting: boolean = true) {
  const item = pool[sessionId];
  if (item) {
    item.isConnecting = connecting;
  }
}

// 文件浏览状态管理
export function getCurrentPath(sessionId: string): string {
  return pool[sessionId]?.currentPath ?? '/';
}

export function setCurrentPath(sessionId: string, path: string) {
  const item = pool[sessionId];
  if (item) {
    item.currentPath = path;
  }
}

export function getFiles(sessionId: string): FileItem[] {
  return pool[sessionId]?.files ?? [];
}

export function setFiles(sessionId: string, files: FileItem[]) {
  const item = pool[sessionId];
  if (item) {
    item.files = files;
  }
}

export function getSelectedFiles(sessionId: string): Set<string> {
  return pool[sessionId]?.selectedFiles ?? new Set();
}

export function setSelectedFiles(sessionId: string, selected: Set<string>) {
  const item = pool[sessionId];
  if (item) {
    item.selectedFiles = selected;
  }
}

// 连接进度管理
export function getConnectionSteps(sessionId: string): ConnectionStep[] | undefined {
  return pool[sessionId]?.connectionSteps;
}

export function setConnectionSteps(sessionId: string, steps: ConnectionStep[]) {
  const item = pool[sessionId];
  if (item) {
    item.connectionSteps = steps;
  }
}

// 连接函数管理
export function getConnectFunction(sessionId: string): (() => Promise<void>) | undefined {
  return pool[sessionId]?.connectFunction;
}

export function setConnectFunction(sessionId: string, fn: (() => Promise<void>) | null) {
  const item = pool[sessionId];
  if (item) {
    item.connectFunction = fn || undefined;
  }
}

// 进度窗口显示状态管理
export function getShowProgress(sessionId: string): boolean {
  const item = pool[sessionId];
  return item?.showProgress ?? false;
}

export function setShowProgress(sessionId: string, show: boolean) {
  const item = pool[sessionId];
  if (item) {
    item.showProgress = show;
  }
}

export function listSftpPool() {
  return Object.keys(pool);
}
