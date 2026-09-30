import { useState, useEffect, lazy, Suspense, type ReactNode } from 'react';
import { SideMenu } from '../components/SideMenu';
import { TerminalView } from '../components/TerminalView';
import { TerminalSidePanel } from '../components/TerminalSidePanel';
import { RightPanelBar } from '../components/RightPanelBar';
import { SftpView } from '../components/SftpView';
import { SplitView } from '../components/SplitView';
import { QuickConnect } from './QuickConnect';
import { useTabStore, Tab } from '../store/tabStore';
import { hasSidePanel } from '../extensions/protocols';
import { PAGES, getPage, pageLoaders } from '../extensions/pages';
import { useAppConnecting } from '../store/appConnecting';
import { useUiPage } from '../store/uiPage';
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

// 侧边栏管理页全部按需加载：home 首标签只带 hosts chunk，其余菜单首次访问才拉取
// （配合下方 mountedPages 过滤：挂载即触发 import，未访问的页面不进首包）。
// 清单来源：extensions/pages（PAGES + pageLoaders），加页只改注册表 + 此处加一行 lazy。
const PAGE_IMPORTS = pageLoaders();
const LazyHosts = lazy(PAGE_IMPORTS.Hosts);
const LazyAccount = lazy(PAGE_IMPORTS.Account);
const LazyRemote = lazy(PAGE_IMPORTS.Remote);
const LazyKeys = lazy(PAGE_IMPORTS.Keys);
const LazyCertificates = lazy(PAGE_IMPORTS.Certificates);
const LazyKnownHosts = lazy(PAGE_IMPORTS.KnownHosts);
const LazyPortForwarding = lazy(PAGE_IMPORTS.PortForwarding);
const LazySftp = lazy(PAGE_IMPORTS.Sftp);
const LazySnippets = lazy(PAGE_IMPORTS.Snippets);
const LazyLogs = lazy(PAGE_IMPORTS.Logs);
const LazyMonitor = lazy(PAGE_IMPORTS.Monitor);
const LazySettings = lazy(PAGE_IMPORTS.Settings);

// 页面 id → lazy 组件（与 PAGES.component 对齐，加页时同步加一行）。
const PAGE_COMPONENTS: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  Hosts: LazyHosts,
  Account: LazyAccount,
  Remote: LazyRemote,
  Keys: LazyKeys,
  Certificates: LazyCertificates,
  KnownHosts: LazyKnownHosts,
  PortForwarding: LazyPortForwarding,
  Sftp: LazySftp,
  Snippets: LazySnippets,
  Logs: LazyLogs,
  Monitor: LazyMonitor,
  Settings: LazySettings,
};

// home 侧边栏页面（首次访问才挂载，按 currentPage 显隐，保留各页面内部状态）
const HOME_PAGES: Record<string, ReactNode> = Object.fromEntries(
  PAGES.map((p) => {
    const C = PAGE_COMPONENTS[p.component];
    return [p.id, (
      <Suspense fallback={<PageLoading />}>
        <C />
      </Suspense>
    )];
  }),
);

/** 页面 chunk 加载中的占位。 */
function PageLoading() {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>;
}

export function Home() {
  const { activeTabId, tabs } = useTabStore();
  const defaultPage = PAGES.find((p) => p.preload)?.id ?? PAGES[0]?.id ?? 'hosts';
  const [currentPage, setCurrentPage] = useState<string>(defaultPage);
  // 首次访问才挂载，之后 keep-alive（避免启动时一次性加载全部页面数据）
  const [mountedPages, setMountedPages] = useState<Set<string>>(() => new Set([defaultPage]));

  const homeTab = tabs.find((t: Tab) => t.type === 'home');
  const isHomeActive = activeTabId === (homeTab?.id ?? 'home-tab');
  // 左右面板与左侧 TerminalSidePanel 同显隐：注册表决定（terminal/mosh）
  const activeSessionTab = tabs.find((t: Tab) => t.id === activeTabId);
  const isSidePanelTab = hasSidePanel(activeSessionTab?.type);

  // 激活终端连接中：让出两侧面板（连接动画全宽不被遮挡）
  const connecting = useAppConnecting((s) => s.active);

  // 向 keep-alive 页面广播「当前可见页面」（切到会话标签时置 null）
  useEffect(() => {
    useUiPage.getState().setHomePage(isHomeActive ? currentPage : null);
  }, [currentPage, isHomeActive]);

  // 非 home 标签（terminal / sftp / quick-connect）
  const sessionTabs = tabs.filter((t: Tab) => t.type !== 'home');

  const handleMenuItemClick = (itemId: string) => {
    if (!getPage(itemId)) return;
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
                // SSH 终端：包一层可伸缩侧栏（主机状态 / 文件浏览）
                <TerminalSidePanel
                  sessionId={tab.sessionId || undefined}
                  sshConfig={tab.sshConfig}
                  isActive={isActive}
                  collapseOverride={connecting && isActive}
                  renderTerminal={(resizeSignal) => (
                    <TerminalView
                      sessionId={tab.sessionId || undefined}
                      sshConfig={tab.sshConfig}
                      skipAutoConnect={tab.skipAutoConnect}
                      isActive={isActive}
                      resizeSignal={resizeSignal}
                    />
                  )}
                />
              ) : tab.type === 'mosh' && tab.moshConfig ? (
                // MOSH：引导字段同 SSH，侧栏同样可用（监控/文件走 SSH 通道）
                <TerminalSidePanel
                  sessionId={tab.sessionId || undefined}
                  sshConfig={tab.moshConfig}
                  isActive={isActive}
                  collapseOverride={connecting && isActive}
                  renderTerminal={(resizeSignal) => (
                    <TerminalView
                      sessionId={tab.sessionId || undefined}
                      moshConfig={tab.moshConfig}
                      skipAutoConnect={tab.skipAutoConnect}
                      isActive={isActive}
                      resizeSignal={resizeSignal}
                    />
                  )}
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

      {/* 右侧功能面板（指令/终端/设置）：内嵌占位，展开时挤压内容区，配色跟随终端主题。
          与左侧 TerminalSidePanel 同显隐：仅终端/MOSH 标签激活时渲染（面板开关状态
          保留在 panelStore，切回终端类标签后自动恢复原样） */}
      {isSidePanelTab && !connecting && <RightPanelBar />}
    </div>
  );
}
