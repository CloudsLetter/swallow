import { useState, useEffect, lazy, Suspense, type ReactNode } from 'react';
import { SideMenu } from '../components/SideMenu';
import { TerminalView } from '../components/TerminalView';
import { SftpView } from '../components/SftpView';
import { SplitView } from '../components/SplitView';
import { QuickConnect } from './QuickConnect';
import { useTabStore, Tab } from '../store/tabStore';
import { useUiPage } from '../store/uiPage';
import { Hosts } from './Hosts';
import { AccountPage } from './Account';
import { Keys } from './Keys';
import { Certificates } from './Certificates';
import { KnownHosts } from './KnownHosts';
import { Sftp } from './Sftp';
import { Snippets } from './Snippets';
import { Logs } from './Logs';
import { PortForwarding } from './PortForwarding';
import { SettingsPage } from './Settings';
import { Monitor } from './Monitor';
import { ReplayView } from '../components/ReplayView';

// VNC 按需加载：noVNC 是重依赖，静态 import 会拖慢首屏；且其加载失败不应拖垮
// 普通终端等其他标签（只影响真正打开 VNC 标签时）。
const VncView = lazy(() =>
  import('../components/VncView').then((m) => ({ default: m.VncView })),
);

// RDP 按需加载：与 VNC 同理（协议端在 Rust，此处只是 canvas 渲染器）
const RdpView = lazy(() =>
  import('../components/RdpView').then((m) => ({ default: m.RdpView })),
);

// home 侧边栏页面（全部常驻挂载，按 currentPage 显隐，保留各页面内部状态）
const HOME_PAGES: Record<string, ReactNode> = {
  hosts: <Hosts />,
  account: <AccountPage />,
  keys: <Keys />,
  certificates: <Certificates />,
  knownhosts: <KnownHosts />,
  portforwarding: <PortForwarding />,
  sftp: <Sftp />,
  snippets: <Snippets />,
  logs: <Logs />,
  monitor: <Monitor />,
  settings: <SettingsPage />,
};

export function Home() {
  const { activeTabId, tabs } = useTabStore();
  const [currentPage, setCurrentPage] = useState<string>('hosts');
  // 首次访问才挂载，之后 keep-alive（避免启动时一次性加载全部页面数据）
  const [mountedPages, setMountedPages] = useState<Set<string>>(() => new Set(['hosts']));

  const homeTab = tabs.find((t: Tab) => t.type === 'home');
  const isHomeActive = activeTabId === (homeTab?.id ?? 'home-tab');

  // 向 keep-alive 页面广播「当前可见页面」（切到会话标签时置 null）
  useEffect(() => {
    useUiPage.getState().setHomePage(isHomeActive ? currentPage : null);
  }, [currentPage, isHomeActive]);

  // 非 home 标签（terminal / sftp / quick-connect）
  const sessionTabs = tabs.filter((t: Tab) => t.type !== 'home');

  const handleMenuItemClick = (itemId: string) => {
    setCurrentPage(itemId);
    setMountedPages((prev) => {
      if (prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.add(itemId);
      return next;
    });
  };

  // 全局命令条等外部入口的跳转请求：激活 home 标签并切到目标页面
  const pendingNav = useUiPage((s) => s.pendingNav);
  useEffect(() => {
    if (!pendingNav) return;
    useUiPage.getState().setPendingNav(null);
    const homeTabId = homeTab?.id ?? 'home-tab';
    if (activeTabId !== homeTabId) {
      useTabStore.getState().focusTab(homeTabId);
    }
    handleMenuItemClick(pendingNav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav]);

  return (
    <div className="home-grid flex" style={{ width: '100%', height: '100%' }}>
      {/* 侧边菜单：home 标签激活时显示（keep-alive 保留折叠状态） */}
      <div style={{ display: isHomeActive ? 'block' : 'none', height: '100%', flexShrink: 0 }}>
        <SideMenu onItemClick={handleMenuItemClick} activePage={currentPage} />
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* home 标签内容区：keep-alive 所有已访问的侧边栏页面 */}
        <div
          style={{
            display: isHomeActive ? 'block' : 'none',
            flex: 1,
            minHeight: 0,
          }}
        >
          {Object.entries(HOME_PAGES)
            .filter(([key]) => mountedPages.has(key))
            .map(([key, node]) => (
              <div
                key={key}
                className={currentPage === key ? 'animate-fade-in' : undefined}
                style={{ display: currentPage === key ? 'block' : 'none', height: '100%' }}
              >
                {node}
              </div>
            ))}
        </div>

        {/* session 标签内容区：每个标签 keep-alive，切换时不卸载 */}
        {sessionTabs.map((tab: Tab) => {
          const isActive = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              style={{ display: isActive ? 'block' : 'none', flex: 1, minHeight: 0 }}
            >
              {tab.type === 'terminal' ? (
                <TerminalView
                  sessionId={tab.sessionId || undefined}
                  sshConfig={tab.sshConfig}
                  skipAutoConnect={tab.skipAutoConnect}
                  isActive={isActive}
                />
              ) : tab.type === 'telnet' ? (
                <TerminalView
                  sessionId={tab.sessionId || undefined}
                  telnetConfig={tab.telnetConfig}
                  skipAutoConnect={tab.skipAutoConnect}
                  isActive={isActive}
                />
              ) : tab.type === 'local' ? (
                <TerminalView
                  sessionId={tab.sessionId || undefined}
                  localConfig={tab.localConfig}
                  skipAutoConnect={tab.skipAutoConnect}
                  isActive={isActive}
                />
              ) : tab.type === 'serial' && tab.serialConfig ? (
                <TerminalView
                  sessionId={tab.sessionId || undefined}
                  serialConfig={tab.serialConfig}
                  skipAutoConnect={tab.skipAutoConnect}
                  isActive={isActive}
                />
              ) : tab.type === 'mosh' && tab.moshConfig ? (
                <TerminalView
                  sessionId={tab.sessionId || undefined}
                  moshConfig={tab.moshConfig}
                  skipAutoConnect={tab.skipAutoConnect}
                  isActive={isActive}
                />
              ) : tab.type === 'sftp' ? (
                <SftpView
                  sessionId={tab.sessionId || undefined}
                  sftpConfig={tab.sftpConfig}
                  isActive={isActive}
                />
              ) : tab.type === 'vnc' && tab.vncConfig ? (
                <Suspense fallback={null}>
                  <VncView
                    sessionId={tab.sessionId || undefined}
                    vncConfig={tab.vncConfig}
                    skipAutoConnect={tab.skipAutoConnect}
                  />
                </Suspense>
              ) : tab.type === 'rdp' && tab.rdpConfig ? (
                <Suspense fallback={null}>
                  <RdpView
                    sessionId={tab.sessionId || undefined}
                    rdpConfig={tab.rdpConfig}
                    skipAutoConnect={tab.skipAutoConnect}
                  />
                </Suspense>
              ) : tab.type === 'split' ? (
                <SplitView
                  tabId={tab.id}
                  panes={tab.panes || []}
                  layout={tab.splitLayout}
                  isActive={isActive}
                />
              ) : tab.type === 'replay' && tab.replayConfig ? (
                <ReplayView replayConfig={tab.replayConfig} />
              ) : (
                <QuickConnect />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
