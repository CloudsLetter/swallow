import { useTabStore, Tab, canMergeTabs } from '../store/tabStore';
import { useConfigStore } from '../store/config';
import { type SplitDirection } from '../store/splitLayout';
import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X as IconX,
  Plus as IconPlus,
  Home as IconHome,
  EllipsisVertical as IconDotsVertical,
  Terminal as IconTerminal,
  Folder as IconFolder,
  Network as IconNetwork,
  Zap as IconZap,
  LayoutGrid as IconLayoutGrid,
  PlayCircle as IconPlayCircle,
} from 'lucide-react';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '@/lib/utils';

// 标签固定宽度（桌面应用标准：标签不伸缩填满，右侧留白作为窗口拖拽区）
const TAB_WIDTH = 160;
// 新建/更多按钮宽度
const TAB_BUTTON_WIDTH = 44;
// 保留的最小拖拽区宽度（保证标签栏右侧始终有可拖动窗口的空白）
const MIN_DRAG_REGION_WIDTH = 40;

/** 按标签类型映射协议图标，让 SSH/SFTP/Telnet/本地终端一眼可辨。 */
function tabIcon(type: Tab['type']) {
  switch (type) {
    case 'sftp':
      return IconFolder;
    case 'telnet':
      return IconNetwork;
    case 'local':
      return IconZap;
    case 'quick-connect':
      return IconZap;
    case 'split':
      return IconLayoutGrid;
    case 'replay':
      return IconPlayCircle;
    default:
      return IconTerminal;
  }
}

/** 拖拽落点：reorder=排序，merge=合并（带方向）。 */
type DragTarget =
  | { kind: 'reorder'; targetId: string }
  | { kind: 'merge'; targetId: string; direction: SplitDirection };

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  // 终端背景延伸至顶栏激活：选中标签背景透明（透出终端背景），与延伸视觉统一
  extendActive?: boolean;
  dragOverClass?: string;
  onClose: (tabId: string) => void;
  onFocus: (tabId: string) => void;
  onDragStart: (e: React.DragEvent, tabId: string) => void;
  onDragOver: (e: React.DragEvent, tabId: string) => void;
  onDrop: (e: React.DragEvent, tabId: string) => void;
  onDragEnd: () => void;
}

function TabItem({ tab, isActive, extendActive, dragOverClass, onClose, onFocus, onDragStart, onDragOver, onDrop, onDragEnd }: TabItemProps) {
  const { t } = useTranslation();
  const [isClosing, setIsClosing] = useState(false);
  const Icon = tabIcon(tab.type);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsClosing(true);
    // 延迟执行关闭，让动画完成
    setTimeout(() => {
      onClose(tab.id);
    }, 200);
  };

  return (
    <div
      draggable
      onClick={() => onFocus(tab.id)}
      onAuxClick={(e) => {
        // 中键点击关闭（桌面应用标配）
        if (e.button === 1) handleClose(e);
      }}
      onDragStart={(e) => onDragStart(e, tab.id)}
      onDragOver={(e) => onDragOver(e, tab.id)}
      onDrop={(e) => onDrop(e, tab.id)}
      onDragEnd={onDragEnd}
      className={cn(
        'tab-item group relative flex h-full cursor-pointer select-none items-center gap-2 px-3',
        // 延伸模式：选中/未选中/hover 用文字透明度阶梯形成清晰色差（背景已透明，只能靠文字区分）；
        // 普通模式：保持主题色背景方案
        isActive
          ? extendActive
            ? 'bg-transparent text-foreground'
            : 'bg-accent text-foreground'
          : extendActive
            ? 'text-foreground/45 hover:bg-accent/20 hover:text-foreground/90'
            : 'text-muted-foreground hover:bg-accent/60',
        dragOverClass,
        isClosing ? 'tab-closing' : 'tab-enter',
      )}
      style={{
        WebkitAppRegion: 'no-drag',
        width: TAB_WIDTH,
        flexShrink: 0,
        transition: 'all 0.2s ease-in-out',
        animation: isClosing ? 'tabExit 0.2s ease-in-out forwards' : 'tabEnter 0.2s ease-in-out',
      } as React.CSSProperties}
      role="tab"
      aria-selected={isActive}
      title={tab.name}
    >
      {/* 活动标签顶部指示条：普通模式主题色；延伸模式由 .topbar-extend 按背景对比前景接管 */}
      {isActive && (
        <span
          className={cn(
            'tab-active-bar absolute inset-x-2.5 top-0 h-0.5 rounded-full',
            extendActive ? 'bg-foreground' : 'bg-primary',
          )}
        />
      )}
      {Icon && <Icon size={14} strokeWidth={2} className="shrink-0 opacity-80" />}
      <span className="flex-1 truncate text-sm">{tab.name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          'h-4 w-4 shrink-0 rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground',
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={handleClose}
        aria-label={t('tabs.closeNamed', { name: tab.name })}
      >
        <IconX size={12} strokeWidth={2} />
      </Button>
    </div>
  );
}

export function TabBar() {
  const { t } = useTranslation();
  const { tabs, focusTab, closeTab, createTab, reorderTab, mergeTabIntoTab } = useTabStore();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [maxVisibleTabs, setMaxVisibleTabs] = useState(10);
  // 拖拽状态
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);

  // 终端背景延伸至顶栏激活（与 Topbar 同判定）：选中标签背景透明化，融入终端背景
  const config = useConfigStore((s) => s.config);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const extendEnabled = !!config?.terminal?.extend_background_to_topbar;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const extendActive =
    extendEnabled &&
    !!activeTab &&
    (activeTab.type === 'terminal' || activeTab.type === 'telnet' || activeTab.type === 'local');

  // 分离 Home 标签和其他标签
  const homeTab = tabs.find((tab: Tab) => tab.type === 'home');
  const terminalTabs = tabs.filter((tab: Tab) => tab.type !== 'home');

  // 计算可见标签数量（标签固定宽度，右侧保留拖拽区）
  useEffect(() => {
    const calculateMaxTabs = () => {
      if (!scrollContainerRef.current) return;
      const containerWidth = scrollContainerRef.current.offsetWidth;
      const availableWidth = containerWidth - TAB_BUTTON_WIDTH - MIN_DRAG_REGION_WIDTH;
      const maxTabs = Math.max(1, Math.floor(availableWidth / TAB_WIDTH));
      setMaxVisibleTabs(maxTabs);
    };

    calculateMaxTabs();
    const observer = new ResizeObserver(calculateMaxTabs);
    if (scrollContainerRef.current) observer.observe(scrollContainerRef.current);
    window.addEventListener('resize', calculateMaxTabs);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', calculateMaxTabs);
    };
  }, []);

  // 分离可见标签和隐藏标签
  const hasOverflow = terminalTabs.length > maxVisibleTabs;
  const visibleTabs = hasOverflow ? terminalTabs.slice(0, maxVisibleTabs) : terminalTabs;
  const hiddenTabs = hasOverflow ? terminalTabs.slice(maxVisibleTabs) : [];

  const handleNewTab = () => {
    createTab({ name: t('tabs.newTab'), type: 'quick-connect' as Tab['type'] });
  };

  const handleCloseOthers = (tabId: string) => {
    tabs.forEach((t: Tab) => {
      if (t.id !== tabId && t.type !== 'home') {
        closeTab(t.id);
      }
    });
  };

  const handleCloseToRight = (tabId: string) => {
    const currentIndex = tabs.findIndex((t: Tab) => t.id === tabId);
    tabs.forEach((t: Tab, index: number) => {
      if (index > currentIndex && t.type !== 'home') {
        closeTab(t.id);
      }
    });
  };

  const handleCloseAll = () => {
    tabs.forEach((t: Tab) => {
      if (t.type !== 'home') {
        closeTab(t.id);
      }
    });
  };

  // 根据鼠标落点计算拖拽动作：左缘=排序，其余=按方向合并（不可合并则无动作）
  const computeDrop = (e: React.DragEvent, targetTabId: string): DragTarget | null => {
    if (!dragTabId || dragTabId === targetTabId) return null;
    const { tabs: current } = useTabStore.getState();
    const source = current.find((t: Tab) => t.id === dragTabId);
    const target = current.find((t: Tab) => t.id === targetTabId);
    if (!source || !target) return null;

    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const ratioX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const ratioY = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;

    // 左缘：拖拽排序（插到目标之前）
    if (ratioX < 0.18) {
      return { kind: 'reorder', targetId: targetTabId };
    }
    // 其余：按方向合并（类型/协议匹配且未达 4 个上限才允许）
    if (canMergeTabs(source, target)) {
      const direction: SplitDirection =
        ratioY < 0.3 ? 'up' : ratioY > 0.7 ? 'down' : ratioX < 0.5 ? 'left' : 'right';
      return { kind: 'merge', targetId: targetTabId, direction };
    }
    return null;
  };

  const dragClassFor = (tabId: string): string | undefined => {
    if (!dragTarget || dragTarget.targetId !== tabId) return undefined;
    if (dragTarget.kind === 'reorder') return 'tab-drag-over';
    return `tab-merge-${dragTarget.direction}`;
  };

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDragTabId(tabId);
    setDragTarget(null);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', tabId);
    } catch {
      // 某些环境 setData 受限，忽略
    }
  };

  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    if (!dragTabId || dragTabId === tabId) return;
    setDragTarget(computeDrop(e, tabId));
  };

  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    const action = computeDrop(e, targetTabId);
    if (action && dragTabId && dragTabId !== targetTabId) {
      if (action.kind === 'reorder') {
        reorderTab(dragTabId, targetTabId);
      } else {
        mergeTabIntoTab(targetTabId, dragTabId, action.direction);
      }
    }
    setDragTabId(null);
    setDragTarget(null);
  };

  const handleDragEnd = () => {
    setDragTabId(null);
    setDragTarget(null);
  };

  return (
    <div className="tab-bar flex h-full items-center" role="tablist">
      {/* 固定的 Home 按钮（宽度与侧边栏折叠宽度 64px 对齐） */}
      <Button
        variant="ghost"
        className="h-full w-16 shrink-0 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => homeTab && focusTab(homeTab.id)}
        aria-label="Home"
        title={t('common.home')}
      >
        <IconHome size={16} strokeWidth={2} />
      </Button>

      {/* 可见标签区域（包含标签、新建按钮和拖拽区） */}
      <div
        ref={scrollContainerRef}
        className="flex h-full items-center"
        style={{ flex: 1, minWidth: 0 }}
      >
        {visibleTabs.map((tab: Tab) => (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <div className="flex h-full" style={{ minWidth: 0 }}>
                <TabItem
                  tab={tab}
                  isActive={tab.isActive}
                  extendActive={extendActive}
                  dragOverClass={dragClassFor(tab.id)}
                  onClose={closeTab}
                  onFocus={focusTab}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {tab.type !== 'home' && (
                <ContextMenuItem onClick={() => closeTab(tab.id)}>{t('tabs.closeTab')}</ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => handleCloseOthers(tab.id)}>{t('tabs.closeOthers')}</ContextMenuItem>
              <ContextMenuItem onClick={() => handleCloseToRight(tab.id)}>{t('tabs.closeToRight')}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={handleCloseAll}>
                {t('tabs.closeAll')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}

        {/* 新建按钮 - 跟随在标签后面，未溢出时显示 */}
        {!hasOverflow && (
          <Button
            variant="ghost"
            className="h-full shrink-0 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag', width: TAB_BUTTON_WIDTH } as React.CSSProperties}
            onClick={handleNewTab}
            aria-label={t('tabs.newTab')}
            title={t('tabs.newTabCtrlT')}
          >
            <IconPlus size={16} strokeWidth={2} />
          </Button>
        )}

        {/* 拖拽区：标签栏右侧空白，用于拖动窗口 */}
        <div
          className="h-full flex-1"
          data-tauri-drag-region=""
          style={{ minWidth: MIN_DRAG_REGION_WIDTH }}
        />
      </div>

      {/* 更多菜单按钮 - 溢出时显示 */}
      {hasOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-full shrink-0 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
              style={{ WebkitAppRegion: 'no-drag', width: TAB_BUTTON_WIDTH } as React.CSSProperties}
              aria-label={t('tabs.more')}
              title={t('tabs.hiddenTabsCount', { count: hiddenTabs.length })}
            >
              <IconDotsVertical size={16} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[400px] overflow-y-auto">
            <DropdownMenuItem onClick={handleNewTab}>
              <IconPlus size={16} strokeWidth={2} />
              {t('shortcuts.new_tab')}
            </DropdownMenuItem>
            {hiddenTabs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('tabs.hiddenTabsLabel', { count: hiddenTabs.length })}</DropdownMenuLabel>
                {hiddenTabs.map((tab: Tab) => {
                  const HiddenIcon = tabIcon(tab.type);
                  return (
                    <DropdownMenuItem key={tab.id} onClick={() => focusTab(tab.id)}>
                      <HiddenIcon size={14} strokeWidth={2} className="shrink-0 opacity-70" />
                      <span className="flex-1 truncate">{tab.name}</span>
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
