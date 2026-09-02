import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';
import { TransferCenter } from './TransferCenter';
import { useTabStore } from '../store/tabStore';
import { useConfigStore } from '../store/config';
import { cn } from '@/lib/utils';

export function Topbar() {
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
      <WindowControls />
    </div>
  );
}
