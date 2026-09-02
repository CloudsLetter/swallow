import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus as IconMinus, Square as IconSquare, Maximize2 as IconRectangle, X as IconX } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const appWindow = getCurrentWindow();

export function WindowControls() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const checkMaximized = async () => {
      setIsMaximized(await appWindow.isMaximized());
    };
    checkMaximized();

    appWindow.onResized(checkMaximized).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => {
    void appWindow.minimize();
  };

  const handleMaximize = () => {
    if (isMaximized) {
      void appWindow.unmaximize();
      setIsMaximized(false);
    } else {
      void appWindow.maximize();
      setIsMaximized(true);
    }
  };

  const handleClose = () => {
    void appWindow.close();
  };

  const base =
    'inline-flex h-full w-11 shrink-0 cursor-default items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent';

  return (
    <div
      className="flex h-full shrink-0 items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        className={base}
        onClick={handleMinimize}
        aria-label={t('window.minimize')}
        title={t('window.minimize')}
      >
        <IconMinus size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={base}
        onClick={handleMaximize}
        aria-label={isMaximized ? t('window.restore') : t('window.maximize')}
        title={isMaximized ? t('window.restore') : t('window.maximize')}
      >
        {isMaximized ? (
          <IconRectangle size={16} strokeWidth={2} />
        ) : (
          <IconSquare size={16} strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        className="win-close-btn inline-flex h-full w-11 shrink-0 cursor-default items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-primary-foreground active:bg-destructive active:text-primary-foreground"
        onClick={handleClose}
        aria-label={t('window.close')}
        title={t('window.close')}
      >
        <IconX size={16} strokeWidth={2} />
      </button>
    </div>
  );
}
