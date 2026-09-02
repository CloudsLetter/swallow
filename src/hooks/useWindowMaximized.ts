import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

/**
 * Hook to detect if the window is maximized
 * @returns {boolean} true if window is maximized, false otherwise
 */
export function useWindowMaximized(): boolean {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // 初始化时检查窗口状态
    const checkMaximized = async () => {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    };
    checkMaximized();

    // 监听窗口大小变化
    const unlisten = appWindow.onResized(async () => {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return isMaximized;
}
