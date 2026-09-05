import { ReactNode, useEffect } from 'react';
import { Topbar } from '../components/Topbar';
import { useTabStore } from '../store/tabStore';
import { useConfigStore } from '../store/config';
import { useGlobalState } from '../store/state';
import { useTheme } from '../hooks/useTheme';
import { matchesShortcut } from '../lib/hotkeys';
import { useVncKeyboard } from '../store/vncKeyboard';
interface LayoutProps {
  children: ReactNode;
  onSettingsClick?: () => void;
}

export function Layout({ children }: LayoutProps) {
  useTheme();
  const { createTab, closeTab, focusNextTab, focusPrevTab, restoreLastClosedTab } = useTabStore();
  const config = useConfigStore((state) => state.config);
  const globalState = useGlobalState((state) =>state);
  // 键盘快捷键
  useEffect(() => {
    if (!config) return;
    // 如果 shortcuts 被禁用，则不注册监听

    if (config.shortcuts.enabled === false) return;
    if (globalState.settingShortcutsEnabled === false) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // VNC 键盘独占中：应用快捷键让路，按键完整流向远端桌面
      if (useVncKeyboard.getState().captured) return;
      // 新标签
      if (matchesShortcut(e, config.shortcuts.new_tab)) {
        e.preventDefault();
        createTab({ name: `Terminal ${Date.now()}`, type: 'quick-connect' });
      }
      // 关闭标签
      else if (matchesShortcut(e, config.shortcuts.close_tab)) {
        e.preventDefault();
        const { activeTabId } = useTabStore.getState();
        if (activeTabId) closeTab(activeTabId);
      }
      // 下一个标签
      else if (matchesShortcut(e, config.shortcuts.next_tab)) {
        e.preventDefault();
        focusNextTab();
      }
      // 上一个标签
      else if (matchesShortcut(e, config.shortcuts.prev_tab)) {
        e.preventDefault();
        focusPrevTab();
      }
      // 恢复最近关闭的标签（Ctrl+Shift+T，浏览器/编辑器通用惯例）
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        restoreLastClosedTab();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [config, createTab, closeTab, focusNextTab, focusPrevTab,globalState]);

  return (
    <div className="layout-wrapper flex flex-col bg-background" style={{ width: '100%', height: '100%' }}>
      {/* Topbar - 与侧边栏折叠条等高 44px */}
      <div style={{ height: '44px', flexShrink: 0 }}>
        <Topbar />
      </div>

      {/* 主内容区域 - 占据剩余空间 */}
      <div className="main-content" style={{ flex: 1, minHeight: 0, width: '100%' }}>
        {children}
      </div>
    </div>
  );
}

