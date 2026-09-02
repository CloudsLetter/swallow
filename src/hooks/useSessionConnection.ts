import { useCallback, useRef, useState } from 'react';
import * as sftpPool from '../components/sftpPool';
import * as terminalPool from '../components/terminalPool';
import { useTabStore } from '../store/tabStore';
import type { ConnectionStep } from '../components/terminalPool';

/** 会话池适配接口：SSH 与 SFTP 池对外暴露一致的进度/状态 API。 */
export interface SessionPool {
  getConnectionSteps: (id: string) => ConnectionStep[] | undefined;
  setConnectionSteps: (id: string, steps: ConnectionStep[]) => void;
  getShowProgress: (id: string) => boolean;
  setShowProgress: (id: string, show: boolean) => void;
  isConnecting: (id: string) => boolean;
  markConnecting: (id: string, connecting: boolean) => void;
  isConnected: (id: string) => boolean;
  markConnected: (id: string, connected: boolean) => void;
  getConnectFunction: (id: string) => (() => Promise<void>) | undefined;
  setConnectFunction: (id: string, fn: (() => Promise<void>) | null) => void;
}

export const sshSessionPool: SessionPool = {
  getConnectionSteps: terminalPool.getConnectionSteps,
  setConnectionSteps: terminalPool.setConnectionSteps,
  getShowProgress: terminalPool.getShowProgress,
  setShowProgress: terminalPool.setShowProgress,
  isConnecting: terminalPool.isConnecting,
  markConnecting: terminalPool.markConnecting,
  isConnected: terminalPool.isConnected,
  markConnected: terminalPool.markConnected,
  getConnectFunction: terminalPool.getConnectFunction,
  setConnectFunction: terminalPool.setConnectFunction,
};

export const sftpSessionPool: SessionPool = {
  getConnectionSteps: sftpPool.getConnectionSteps,
  setConnectionSteps: sftpPool.setConnectionSteps,
  getShowProgress: sftpPool.getShowProgress,
  setShowProgress: sftpPool.setShowProgress,
  isConnecting: sftpPool.isConnecting,
  markConnecting: sftpPool.markConnecting,
  isConnected: sftpPool.isConnected,
  markConnected: sftpPool.markConnected,
  getConnectFunction: sftpPool.getConnectFunction,
  setConnectFunction: sftpPool.setConnectFunction,
};

/** 定位 sessionId 所属的标签；分屏标签的会话存在 panes 里（返回 paneId）。 */
function locateSessionTab(sessionId: string): { tabId: string; paneId: string | null } | null {
  const { tabs } = useTabStore.getState();
  const direct = tabs.find((tab) => tab.sessionId === sessionId);
  if (direct) return { tabId: direct.id, paneId: null };
  for (const tab of tabs) {
    if (tab.type === 'split') {
      const pane = tab.panes?.find((p) => p.sessionId === sessionId);
      if (pane) return { tabId: tab.id, paneId: pane.id };
    }
  }
  return null;
}

/**
 * 统一管理连接进度状态（steps / showProgress / isConnecting）与本地 state、
 * 会话池之间的同步，并提供取消 / 关闭 / 重试三个处理函数。
 * 视图只需保留自己的连接流程与阶段定义。
 */
export function useSessionConnection(sessionId: string | undefined, pool: SessionPool) {
  const [showProgress, setShowProgressState] = useState(false);
  const [steps, setStepsState] = useState<ConnectionStep[]>([]);
  const [isConnecting, setIsConnectingState] = useState(false);
  const cancelRef = useRef(false);

  const setSteps = useCallback(
    (next: ConnectionStep[]) => {
      setStepsState(next);
      if (sessionId) pool.setConnectionSteps(sessionId, next);
    },
    [sessionId, pool],
  );

  const updateStep = useCallback(
    (id: string, status: ConnectionStep['status'], message?: string) => {
      setStepsState((prev) => {
        const next = prev.map((step) =>
          step.id === id ? { ...step, status, message } : step
        );
        if (sessionId) pool.setConnectionSteps(sessionId, next);
        return next;
      });
    },
    [sessionId, pool],
  );

  const setProgressVisible = useCallback(
    (visible: boolean) => {
      setShowProgressState(visible);
      if (sessionId) pool.setShowProgress(sessionId, visible);
    },
    [sessionId, pool],
  );

  const setConnecting = useCallback(
    (connecting: boolean) => {
      setIsConnectingState(connecting);
      if (sessionId) pool.markConnecting(sessionId, connecting);
    },
    [sessionId, pool],
  );

  const markConnected = useCallback(
    (connected: boolean) => {
      if (sessionId) pool.markConnected(sessionId, connected);
    },
    [sessionId, pool],
  );

  const handleCancelConnection = useCallback(() => {
    cancelRef.current = true;
    setConnecting(false);
    setProgressVisible(false);
    if (!sessionId) return;
    const located = locateSessionTab(sessionId);
    if (!located) return;
    const { closeTab, closePane } = useTabStore.getState();
    if (located.paneId) closePane(located.tabId, located.paneId);
    else closeTab(located.tabId);
  }, [sessionId, setConnecting, setProgressVisible]);

  const handleCloseProgress = useCallback(() => {
    setProgressVisible(false);
    if (!sessionId) return;
    const hasError = steps.some((step) => step.status === 'error');
    if (hasError) {
      setConnecting(false);
      pool.setConnectionSteps(sessionId, []);
      pool.setConnectFunction(sessionId, null);
      const located = locateSessionTab(sessionId);
      if (!located) return;
      const { closeTab, closePane } = useTabStore.getState();
      if (located.paneId) closePane(located.tabId, located.paneId);
      else closeTab(located.tabId);
    }
  }, [sessionId, steps, setConnecting, setProgressVisible, pool]);

  const handleRetryConnection = useCallback(() => {
    if (!sessionId) return;
    const connectFn = pool.getConnectFunction(sessionId);
    if (connectFn) {
      pool.markConnected(sessionId, false);
      connectFn();
    }
  }, [sessionId, pool]);

  return {
    showProgress,
    steps,
    isConnecting,
    cancelRef,
    setSteps,
    updateStep,
    setProgressVisible,
    setConnecting,
    markConnected,
    handleCancelConnection,
    handleCloseProgress,
    handleRetryConnection,
  };
}
