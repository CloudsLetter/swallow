import { create } from 'zustand';
import { disposeTerminal, unattachListeners } from '../components/terminalPool';
import { disposeSftpSession } from '../components/sftpPool';
import { disconnectSsh, disconnectSftp, telnetDisconnect, localShellDisconnect } from '../services/sessionService';
import type { SessionReplayData } from '../services/sessionReplay';
import {
  type SplitLayout,
  type SplitDirection,
  leaf,
  leafCount,
  insertLeaf,
  removeLeaf,
  updateRatio,
  layoutFromIds,
  MAX_SPLIT_PANES,
} from './splitLayout';

export type TabType = 'home' | 'terminal' | 'telnet' | 'local' | 'sftp' | 'replay' | 'quick-connect' | 'split';

export interface SshTabConfig {
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password?: string;
  key_path?: string;
  key_id?: string;
  cert_path?: string;
  cert_id?: string;
  passphrase?: string;
  /** 来源主机条目 id（Hosts 页连接时传入，用于连接状态精准匹配；QuickConnect 等无来源时为 undefined） */
  hostId?: string;
}

export interface TelnetTabConfig {
  host: string;
  port: number;
}

export interface LocalTabConfig {
  shell: string;
  wslDistro?: string;
}

export interface SftpTabConfig {
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
  /** 来源 Sftp 连接条目 id（Sftp 页连接时传入，用于连接状态精准匹配） */
  connectionId?: string;
}

export interface ReplayTabConfig {
  path: string;
  replay: SessionReplayData;
}

/** 分屏里的单个 pane（一个 SSH/SFTP 会话）。FTP 会话 type 同为 'sftp'，靠 protocol 区分。 */
export interface SplitPane {
  id: string;
  type: 'terminal' | 'sftp';
  sessionId: string;
  name: string;
  sshConfig?: SshTabConfig;
  sftpConfig?: SftpTabConfig;
}

export interface Tab {
  id: string;
  name: string;
  sessionId: string | null;
  isActive: boolean;
  type: TabType;
  sshConfig?: SshTabConfig;
  telnetConfig?: TelnetTabConfig;
  localConfig?: LocalTabConfig;
  sftpConfig?: SftpTabConfig;
  replayConfig?: ReplayTabConfig;
  // 仅 split 标签使用：pane 扁平列表（供查找）+ 布局树（供渲染）
  panes?: SplitPane[];
  splitLayout?: SplitLayout;
  /** 运行期标记：恢复的密码类会话（无密码）跳过自动连接，等待用户重连（不持久化） */
  skipAutoConnect?: boolean;
}

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  /** 最近关闭的标签（仅 terminal/sftp，供恢复；最多保留 10 条） */
  recentlyClosed: Tab[];

  // API 方法
  createTab: (config?: {
    sessionId?: string | null;
    name?: string;
    type?: Tab['type'];
    sshConfig?: Tab['sshConfig'];
    telnetConfig?: Tab['telnetConfig'];
    localConfig?: Tab['localConfig'];
    sftpConfig?: Tab['sftpConfig'];
    replayConfig?: Tab['replayConfig'];
    skipAutoConnect?: boolean;
  }) => string;
  closeTab: (tabId: string) => void;
  focusTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  // 将 tabId 移到 beforeTabId 之前（null = 移到最后）；home 不可移动
  reorderTab: (tabId: string, beforeTabId: string | null) => void;
  // 合并：把 sourceTab 的会话并入 targetTab，按 direction 分屏；source 移除但不断开会话
  mergeTabIntoTab: (targetTabId: string, sourceTabId: string, direction: SplitDirection) => void;
  // 关闭 split 里的一个 pane（断开该会话并清理）
  closePane: (tabId: string, paneId: string) => void;
  // 把 split 里的一个 pane 移出为独立标签
  unmergePane: (tabId: string, paneId: string) => void;
  // 调整某个内部分割节点的比例
  setSplitRatio: (tabId: string, nodeId: string, ratio: number) => void;
  // 恢复最近关闭的标签（重新创建标签并连接）
  restoreLastClosedTab: () => void;

  // 键盘快捷键辅助
  focusNextTab: () => void;
  focusPrevTab: () => void;
}

let tabCounter = 0;

/**
 * 生成全局唯一的 tab id / sessionId。
 * ⚠️ tabCounter 是模块级变量：开发 HMR / 模块重载会重置为 0，若仅靠计数序号，
 * 重载后新建的标签会与旧标签共用 id / sessionId → 两个标签指向同一后端会话，
 * 出现「连接 A 却显示 B」的串台。追加时间戳 + 随机后缀保证跨重载唯一。
 */
function uniqueTabIds() {
  const seq = ++tabCounter;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id: `tab-${seq}-${suffix}`, sessionId: `session-${seq}-${suffix}` };
}

/** 断开一个会话并清理对应资源（尽力而为，不抛异常）。 */
function disposeSession(type: 'terminal' | 'telnet' | 'local' | 'sftp', sessionId: string) {
  if (type === 'sftp') {
    void disconnectSftp(sessionId).catch((error) => {
      console.warn(`Failed to disconnect SFTP session ${sessionId}:`, error);
    });
    try {
      disposeSftpSession(sessionId);
    } catch (error) {
      console.warn('Failed to dispose SFTP session:', error);
    }
  } else {
    // terminal / telnet / local 共用 terminalPool（xterm + 事件监听），仅断开命令不同
    if (type === 'terminal') {
      void disconnectSsh(sessionId).catch((error) => {
        console.warn(`Failed to disconnect SSH session ${sessionId}:`, error);
      });
    } else if (type === 'telnet') {
      void telnetDisconnect(sessionId).catch((error) => {
        console.warn(`Failed to disconnect telnet session ${sessionId}:`, error);
      });
    } else {
      void localShellDisconnect(sessionId).catch((error) => {
        console.warn(`Failed to disconnect local shell session ${sessionId}:`, error);
      });
    }
    try {
      unattachListeners(sessionId);
      disposeTerminal(sessionId);
    } catch (error) {
      console.warn('Failed to dispose terminal:', error);
    }
  }
}

/** 把 tab 转成 pane（复用 sessionId，不断开会话）。 */
function paneOf(tab: Tab): SplitPane {
  return {
    id: `pane-${tab.sessionId || tab.id}`,
    type: tab.type as 'terminal' | 'sftp',
    sessionId: tab.sessionId || '',
    name: tab.name,
    sshConfig: tab.sshConfig,
    sftpConfig: tab.sftpConfig,
  };
}

/**
 * 合并分组：决定两个 pane/tab 能否合并。
 * - terminal 只跟 terminal 合并
 * - sftp 只跟 sftp 合并、ftp 只跟 ftp 合并（按 protocol 区分）
 */
function mergeGroupOfPane(pane: SplitPane): string {
  if (pane.type === 'terminal') return 'terminal';
  return `sftp:${pane.sftpConfig?.protocol ?? 'sftp'}`;
}

function mergeGroupOfTab(tab: Tab): string {
  if (tab.type === 'terminal') return 'terminal';
  if (tab.type === 'sftp') return `sftp:${tab.sftpConfig?.protocol ?? 'sftp'}`;
  if (tab.type === 'split') {
    const first = tab.panes?.[0];
    if (!first) return 'split:empty';
    return mergeGroupOfPane(first);
  }
  return `other:${tab.type}`;
}

/** 判断 source 能否作为 pane 合并进 target（类型/协议一致 + 未达上限 + 合法类型）。 */
export function canMergeTabs(source: Tab, target: Tab): boolean {
  if (!source || !target) return false;
  if (target.type === 'home' || target.type === 'quick-connect') return false;
  if (source.type === 'home' || source.type === 'quick-connect' || source.type === 'split') return false;
  if (mergeGroupOfTab(target) !== mergeGroupOfTab(source)) return false;
  if (target.type === 'split') {
    const count = target.splitLayout ? leafCount(target.splitLayout) : (target.panes?.length ?? 0);
    if (count >= MAX_SPLIT_PANES) return false;
  }
  return true;
}

/** 由 panes + layout 生成拼接标题。 */
function joinPaneNames(panes: SplitPane[]): string {
  return panes.map((p) => p.name).join(' | ');
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [
    {
      id: 'home-tab',
      name: 'Home',
      sessionId: null,
      isActive: true,
      type: 'home',
    },
  ],
  activeTabId: 'home-tab',
  recentlyClosed: [],

  createTab: (config = {}) => {
    const { id: newTabId, sessionId: newSessionId } = uniqueTabIds();
    const newTab: Tab = {
      id: newTabId,
      name: config.name || `Tab ${tabCounter}`,
      sessionId: config.sessionId === undefined ? newSessionId : config.sessionId,
      isActive: false,
      type: config.type || 'terminal',
      sshConfig: config.sshConfig,
      telnetConfig: config.telnetConfig,
      localConfig: config.localConfig,
      sftpConfig: config.sftpConfig,
      replayConfig: config.replayConfig,
      skipAutoConnect: config.skipAutoConnect,
    };

    set((state: TabStore) => ({
      tabs: [...state.tabs, newTab],
    }));

    // 自动聚焦新标签
    get().focusTab(newTabId);
    return newTabId;
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get();

    // 不允许关闭 home-tab
    if (tabId === 'home-tab') return;

    // 不允许关闭最后一个标签
    if (tabs.length === 1) return;

    const tabIndex = tabs.findIndex((t: Tab) => t.id === tabId);
    if (tabIndex === -1) return;

    const closedTab = tabs[tabIndex];
    const newTabs = tabs.filter((t: Tab) => t.id !== tabId);

    // 通知后端断开并清理会话（尽力而为，不阻塞标签关闭）
    if (closedTab.type === 'split') {
      for (const pane of closedTab.panes || []) {
        disposeSession(pane.type, pane.sessionId);
      }
    } else if (closedTab.sessionId && (closedTab.type === 'terminal' || closedTab.type === 'telnet' || closedTab.type === 'local' || closedTab.type === 'sftp')) {
      disposeSession(closedTab.type, closedTab.sessionId);
    }

    // 记录到「最近关闭」栈（仅 terminal/telnet/local/sftp 单会话标签，最多保留 10 条）
    let recentlyClosed = get().recentlyClosed;
    if (closedTab.type === 'terminal' || closedTab.type === 'telnet' || closedTab.type === 'local' || closedTab.type === 'sftp') {
      recentlyClosed = [...recentlyClosed, closedTab];
      if (recentlyClosed.length > 10) recentlyClosed = recentlyClosed.slice(-10);
    }

    // 如果关闭的是当前活动标签，激活相邻标签
    let newActiveTabId = activeTabId;
    if (tabId === activeTabId) {
      // 优先激活其他 terminal 标签，如果没有则激活 home
      const nextTab = newTabs.find((t: Tab) => t.type !== 'home') || newTabs[0];
      newActiveTabId = nextTab.id;
    }

    // 更新标签列表和激活状态
    set({
      tabs: newTabs.map((t: Tab) => ({
        ...t,
        isActive: t.id === newActiveTabId,
      })),
      activeTabId: newActiveTabId,
      recentlyClosed,
    });
  },

  focusTab: (tabId: string) => {
    set((state: TabStore) => ({
      activeTabId: tabId,
      tabs: state.tabs.map((t: Tab) => ({
        ...t,
        isActive: t.id === tabId,
      })),
    }));
  },

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    set((state: TabStore) => ({
      tabs: state.tabs.map((t: Tab) =>
        t.id === tabId ? { ...t, ...updates } : t
      ),
    }));
  },

  reorderTabs: (fromIndex: number, toIndex: number) => {
    set((state: TabStore) => {
      const newTabs = [...state.tabs];
      const [movedTab] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, movedTab);
      return { tabs: newTabs };
    });
  },

  // 将 tabId 移到 beforeTabId 之前（null=移到最后）；home 不可移动
  reorderTab: (tabId: string, beforeTabId: string | null) => {
    set((state: TabStore) => {
      const tabs = [...state.tabs];
      const fromIdx = tabs.findIndex((t: Tab) => t.id === tabId);
      if (fromIdx === -1) return state;
      if (tabs[fromIdx].type === 'home') return state;
      const [moved] = tabs.splice(fromIdx, 1);
      let toIdx = beforeTabId ? tabs.findIndex((t: Tab) => t.id === beforeTabId) : tabs.length;
      if (toIdx === -1) toIdx = tabs.length;
      tabs.splice(toIdx, 0, moved);
      return { tabs };
    });
  },

  // 合并：把 sourceTab 的会话并入 targetTab，按 direction 分屏；source 移除但不断开会话
  mergeTabIntoTab: (targetTabId: string, sourceTabId: string, direction: SplitDirection) => {
    const { tabs } = get();
    const target = tabs.find((t: Tab) => t.id === targetTabId);
    const source = tabs.find((t: Tab) => t.id === sourceTabId);
    if (!target || !source || target.id === source.id) return;
    if (!canMergeTabs(source, target)) return;

    const incoming = paneOf(source);

    let currentLayout: SplitLayout;
    let currentPanes: SplitPane[];
    if (target.type === 'split') {
      currentLayout = target.splitLayout ?? layoutFromIds((target.panes || []).map((p) => p.id));
      currentPanes = target.panes || [];
    } else {
      const targetPane = paneOf(target);
      currentLayout = leaf(targetPane.id);
      currentPanes = [targetPane];
    }
    if (leafCount(currentLayout) >= MAX_SPLIT_PANES) return;

    const newLayout = insertLeaf(currentLayout, direction, incoming.id);
    const newPanes = [...currentPanes.filter((p) => p.id !== incoming.id), incoming];

    set((state: TabStore) => ({
      tabs: state.tabs
        .filter((t: Tab) => t.id !== source.id)
        .map((t: Tab) =>
          t.id === target.id
            ? {
                ...t,
                type: 'split' as TabType,
                sessionId: null,
                panes: newPanes,
                splitLayout: newLayout,
                name: joinPaneNames(newPanes),
              }
            : t,
        ),
    }));
    get().focusTab(target.id);
  },

  // 关闭 split 里的一个 pane（断开该会话并清理）；剩 1 个时降级为普通标签
  closePane: (tabId: string, paneId: string) => {
    const { tabs } = get();
    const tab = tabs.find((t: Tab) => t.id === tabId);
    if (!tab || tab.type !== 'split') return;
    const panes = tab.panes || [];
    const pane = panes.find((p) => p.id === paneId);
    const layout = tab.splitLayout;
    if (!pane || !layout) return;

    const newLayout = removeLeaf(layout, paneId);
    const newPanes = panes.filter((p) => p.id !== paneId);

    if (!newLayout || newPanes.length === 0) {
      // 关掉最后一个 pane 等价于关闭整个标签（closeTab 会 dispose 所有 pane）
      get().closeTab(tabId);
      return;
    }

    disposeSession(pane.type, pane.sessionId);

    if (newPanes.length === 1) {
      const only = newPanes[0];
      set((state: TabStore) => ({
        tabs: state.tabs.map((t: Tab) =>
          t.id === tabId
            ? {
                ...t,
                type: only.type,
                sessionId: only.sessionId,
                name: only.name,
                sshConfig: only.sshConfig,
                sftpConfig: only.sftpConfig,
                panes: undefined,
                splitLayout: undefined,
              }
            : t,
        ),
      }));
    } else {
      set((state: TabStore) => ({
        tabs: state.tabs.map((t: Tab) =>
          t.id === tabId
            ? { ...t, panes: newPanes, splitLayout: newLayout, name: joinPaneNames(newPanes) }
            : t,
        ),
      }));
    }
  },

  // 把 split 里的一个 pane 移出为独立标签（不断开会话）
  unmergePane: (tabId: string, paneId: string) => {
    const { tabs } = get();
    const tab = tabs.find((t: Tab) => t.id === tabId);
    if (!tab || tab.type !== 'split') return;
    const panes = tab.panes || [];
    const pane = panes.find((p) => p.id === paneId);
    const layout = tab.splitLayout;
    if (!pane || !layout) return;

    const newLayout = removeLeaf(layout, paneId);
    const newPanes = panes.filter((p) => p.id !== paneId);
    if (!newLayout || newPanes.length === 0) return; // 仅剩一个时无需移出

    const newTab: Tab = {
      id: uniqueTabIds().id,
      name: pane.name,
      sessionId: pane.sessionId,
      isActive: false,
      type: pane.type,
      sshConfig: pane.sshConfig,
      sftpConfig: pane.sftpConfig,
    };

    let next: Tab[];
    if (newPanes.length === 1) {
      const only = newPanes[0];
      next = tabs.map((t: Tab) =>
        t.id === tabId
          ? {
              ...t,
              type: only.type,
              sessionId: only.sessionId,
              name: only.name,
              sshConfig: only.sshConfig,
              sftpConfig: only.sftpConfig,
              panes: undefined,
              splitLayout: undefined,
            }
          : t,
      );
    } else {
      next = tabs.map((t: Tab) =>
        t.id === tabId
          ? { ...t, panes: newPanes, splitLayout: newLayout, name: joinPaneNames(newPanes) }
          : t,
      );
    }

    const splitIdx = next.findIndex((t: Tab) => t.id === tabId);
    next.splice(splitIdx + 1, 0, newTab);

    set({ tabs: next });
    get().focusTab(newTab.id);
  },

  setSplitRatio: (tabId: string, nodeId: string, ratio: number) => {
    set((state: TabStore) => ({
      tabs: state.tabs.map((t: Tab) => {
        if (t.id !== tabId || !t.splitLayout) return t;
        return { ...t, splitLayout: updateRatio(t.splitLayout, nodeId, ratio) };
      }),
    }));
  },

  focusNextTab: () => {
    const { tabs, activeTabId } = get();
    // 只在会话标签（terminal/sftp/quick-connect/split）间循环，跳过固定的 home 标签
    const sessionTabs = tabs.filter((t: Tab) => t.type !== 'home');
    if (sessionTabs.length === 0) return;
    const currentIndex = sessionTabs.findIndex((t: Tab) => t.id === activeTabId);
    // 当前在 home（index=-1）时，+1 后落到第一个会话标签
    const nextIndex = (currentIndex + 1) % sessionTabs.length;
    get().focusTab(sessionTabs[nextIndex].id);
  },

  focusPrevTab: () => {
    const { tabs, activeTabId } = get();
    const sessionTabs = tabs.filter((t: Tab) => t.type !== 'home');
    if (sessionTabs.length === 0) return;
    const currentIndex = sessionTabs.findIndex((t: Tab) => t.id === activeTabId);
    // 当前在 home（index=-1）时，-1 后落到最后一个会话标签
    const prevIndex = (currentIndex - 1 + sessionTabs.length) % sessionTabs.length;
    get().focusTab(sessionTabs[prevIndex].id);
  },

  // 恢复最近关闭的标签：重新创建标签（新 sessionId，复用原配置），挂载后自动重连
  restoreLastClosedTab: () => {
    const { recentlyClosed } = get();
    if (recentlyClosed.length === 0) return;
    const last = recentlyClosed[recentlyClosed.length - 1];
    const { id: newTabId, sessionId: newSessionId } = uniqueTabIds();
    const newTab: Tab = {
      id: newTabId,
      name: last.name,
      sessionId: newSessionId,
      isActive: false,
      type: last.type,
      sshConfig: last.sshConfig,
      telnetConfig: last.telnetConfig,
      localConfig: last.localConfig,
      sftpConfig: last.sftpConfig,
    };
    set((state: TabStore) => ({
      tabs: [...state.tabs, newTab],
      recentlyClosed: state.recentlyClosed.slice(0, -1),
    }));
    get().focusTab(newTabId);
  },
}));
