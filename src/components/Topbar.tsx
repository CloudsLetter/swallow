import { PanelLeft as IconPanelLeft, PanelRight as IconPanelRight, Bot as IconBot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';
import { TransferCenter } from './TransferCenter';
import { Button } from './ui/button';
import { useTabStore } from '../store/tabStore';
import { useConfigStore } from '../store/config';
import { usePanelStore } from '../store/panelStore';
import { cn } from '@/lib/utils';

export function Topbar() {
  const { t } = useTranslation();
  // 终端背景延伸：激活标签是终端类（terminal/telnet/local）且设置开启时，
  // Topbar 背景透明，透出下方 fixed 全窗的终端背景层
  const config = useConfigStore((s) => s.config);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const extendEnabled = !!config?.terminal?.extend_background_to_topbar;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const extendActive =
    extendEnabled &&
    !!activeTab &&
    (activeTab.type === 'terminal' || activeTab.type === 'telnet' || activeTab.type === 'local');

  // 全局面板开关（左侧终端面板 / 右侧快捷设置 / AI 助手）
  const leftPanelOpen = usePanelStore((s) => s.leftPanelOpen);
  const rightPanelOpen = usePanelStore((s) => s.rightPanelOpen);
  const aiOpen = usePanelStore((s) => s.aiOpen);
  const toggleLeftPanel = usePanelStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePanelStore((s) => s.toggleRightPanel);
  const setAiOpen = usePanelStore((s) => s.setAiOpen);

  // 左侧面板仅 SSH/MOSH 标签挂载，其余标签下按钮禁用
  const leftPanelAvailable = !!activeTab && (activeTab.type === 'terminal' || activeTab.type === 'mosh');

  // 顶栏按钮统一风格：通高方角 + 右边框（与传输中心入口一致），激活态高亮
  const panelButtonClass = (active: boolean) =>
    cn(
      'h-full w-9 shrink-0 rounded-none border-r border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      active && 'bg-accent text-foreground',
    );
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <div
      className={cn(
        'topbar relative z-50 flex h-full items-center border-b',
        // 延伸模式下分割线透明，顶栏与终端背景视觉一体；颜色由 .topbar-extend 变量接管（按背景亮度高对比）
        extendActive
          ? 'topbar-extend border-b-transparent bg-transparent'
          : 'border-b-border bg-background backdrop-blur-xl',
      )}
      data-tauri-drag-region=""
      style={{
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      <div data-tauri-drag-region="" style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <TabBar />
      </div>
      <TransferCenter />
      <Button
        variant="ghost"
        size="icon"
        className={panelButtonClass(leftPanelAvailable && leftPanelOpen)}
        style={noDrag}
        disabled={!leftPanelAvailable}
        onClick={toggleLeftPanel}
        title={t('panel.leftPanel')}
        aria-label={t('panel.leftPanel')}
      >
        <IconPanelLeft size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={panelButtonClass(rightPanelOpen)}
        style={noDrag}
        onClick={toggleRightPanel}
        title={t('panel.quickSettings')}
        aria-label={t('panel.quickSettings')}
      >
        <IconPanelRight size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={panelButtonClass(aiOpen)}
        style={noDrag}
        onClick={() => setAiOpen(!aiOpen)}
        title={t('panel.aiAssistant')}
        aria-label={t('panel.aiAssistant')}
      >
        <IconBot size={16} />
      </Button>
      <WindowControls />
    </div>
  );
}
