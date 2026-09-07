import {
  Bot as IconBot,
  PanelLeft as IconPanelLeft,
  PanelRight as IconPanelRight,
} from 'lucide-react';
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

  // 全局面板状态
  const toggleLeftPanel = usePanelStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePanelStore((s) => s.toggleRightPanel);
  const aiOpen = usePanelStore((s) => s.aiOpen);
  const setAiOpen = usePanelStore((s) => s.setAiOpen);

  // 首页没有左右面板，按钮整体隐藏；左侧面板仅 SSH/MOSH 标签挂载，其余标签禁用
  const isHomeActive = activeTab?.type === 'home';
  const leftPanelAvailable = !!activeTab && (activeTab.type === 'terminal' || activeTab.type === 'mosh');

  // 顶栏按钮统一风格：普通 ghost 图标（无通高边框、无激活高亮）
  const topbarButtonClass = 'h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground';
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
      {!isHomeActive && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className={topbarButtonClass}
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
            className={topbarButtonClass}
            style={noDrag}
            onClick={toggleRightPanel}
            title={t('panel.rightPanel')}
            aria-label={t('panel.rightPanel')}
          >
            <IconPanelRight size={16} />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={topbarButtonClass}
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
