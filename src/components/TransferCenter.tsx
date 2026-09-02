import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ArrowUpDown as IconArrows } from 'lucide-react';
import { useTransferStore } from '../store/transferStore';
import { SftpTransferPanel } from './SftpTransferPanel';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/**
 * 右上角传输列表入口：存在传输任务时显示入口按钮（活跃数徽标），
 * 点击展开全局面板（Portal 渲染到 body，脱离 Topbar 上下文）。
 * 点击按钮/面板之外的任意空白处自动关闭。
 */
export function TransferCenter() {
  const transfers = useTransferStore((state) => state.transfers);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 任务全部清除后自动收起面板
  useEffect(() => {
    if (transfers.length === 0) setOpen(false);
  }, [transfers.length]);

  // 点击空白处关闭：按钮与面板都不在点击目标内时收起
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inButton = buttonRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inButton && !inPanel) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  const { t } = useTranslation();

  if (transfers.length === 0) return null;

  const activeCount = transfers.filter((t) => t.status === 'active').length;
  const errorCount = transfers.filter((t) => t.status === 'error').length;
  const badge = activeCount > 0 ? activeCount : errorCount > 0 ? errorCount : transfers.length;

  return (
    <>
      <div ref={buttonRef} className="flex h-full items-center">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'relative h-full w-9 shrink-0 rounded-none border-r border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            open && 'bg-accent text-foreground',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => setOpen((v) => !v)}
          title={open ? t('transfer.collapseList') : t('transfer.listCount', { count: transfers.length })}
          aria-label={t('transfer.transferList')}
        >
          <IconArrows
            size={16}
            strokeWidth={2}
            className={cn(
              activeCount > 0 && 'animate-pulse',
              errorCount > 0 && activeCount === 0 && 'text-destructive',
            )}
          />
          <span
            className={cn(
              'absolute top-0.5 right-0.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none',
              errorCount > 0 && activeCount === 0
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {badge}
          </span>
        </Button>
      </div>
      {/* Portal 到 body：不受 Topbar 拖拽区/样式上下文影响 */}
      {open &&
        createPortal(
          <div ref={panelRef}>
            <SftpTransferPanel variant="global" title={t('transfer.allTransfers')} />
          </div>,
          document.body,
        )}
    </>
  );
}
