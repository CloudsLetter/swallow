import { useMemo } from 'react';
import { useTabStore } from '../store/tabStore';

export interface ActiveSshTargets {
  /** 命中主机条目 id（优先匹配） */
  byHostId: Set<string>;
  /** 兜底：无 hostId 来源会话按 host:port 匹配 */
  byAddr: Set<string>;
}

/** 计算一份标签树的活跃 SSH 会话键。纯函数，供模块级缓存复用。 */
function computeActiveSshTargets(tabs: ReturnType<typeof useTabStore.getState>['tabs']): ActiveSshTargets {
  const byHostId = new Set<string>();
  const byAddr = new Set<string>();
  const collect = (config?: { host?: string; port?: number; hostId?: string }) => {
    if (!config?.host) return;
    if (config.hostId) byHostId.add(config.hostId);
    byAddr.add(`${config.host}:${config.port ?? 22}`);
  };
  for (const tab of tabs) {
    if (tab.type === 'split') {
      for (const pane of tab.panes || []) {
        if (pane.type === 'terminal') collect(pane.sshConfig);
      }
    } else if (tab.type === 'terminal') {
      collect(tab.sshConfig);
    }
  }
  return { byHostId, byAddr };
}

/** 模块级共享缓存：同一 tabs 引用只计算一次，多页面（主机页/快速链接/
 *  右侧状态栏）共享同一份派生集，避免各自 useMemo 重复遍历。 */
let shared: { tabs: ReturnType<typeof useTabStore.getState>['tabs']; value: ActiveSshTargets } | null = null;

/**
 * 活跃 SSH 会话键 —— 直接从标签树（tabStore，唯一事实源）派生，判定主机
 * 「已连接/在线」。标签/分屏关闭即从树移除 → 状态自动回落，无残留、无需
 * 事件/注销兜底（事件驱动在多销毁路径下必然漏路径）。
 *
 * 只收集 terminal（SSH）标签及其分屏 pane；SFTP 文件浏览等会话不算
 * （连接类型隔离，与主机页历史语义一致）。
 */
export function useActiveSshTargets(): ActiveSshTargets {
  const tabs = useTabStore((s) => s.tabs);
  return useMemo(() => {
    if (shared?.tabs === tabs) return shared.value;
    const value = computeActiveSshTargets(tabs);
    shared = { tabs, value };
    return value;
  }, [tabs]);
}
