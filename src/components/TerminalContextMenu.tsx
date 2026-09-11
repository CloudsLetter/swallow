import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClipboardPaste as IconPaste,
  Copy as IconCopy,
  MousePointerClick as IconSelectWord,
  TextSelect as IconSelectAll,
  Search as IconSearch,
  Zap as IconZap,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { useConfigStore } from '../store/config';
import {
  copySessionSelection,
  enqueueWriteToTargets,
  isConnected,
  listPool,
  pasteToSession,
  selectAllSession,
  selectWordAtCursor,
  setContextMenuHandler,
} from './terminalPool';
import { useBroadcastStore } from '../store/broadcast';
import { usePanelStore } from '../store/panelStore';
import { toast } from 'sonner';

interface TerminalContextMenuProps {
  sessionId?: string;
  children: React.ReactNode;
}

/**
 * 终端自定义右键菜单（Radix ContextMenu，接管 xterm 区域右键）：
 * - 复制选中 / 粘贴 / 选中单词 / 全选 / 查找：走 terminalPool 会话级能力；
 * - 自定义宏：设置 → 终端 → 右键菜单维护，点击把命令发到当前会话（广播开启时发全部）。
 * 无 sessionId（未连接）时只显示粘贴/宏（宏需已连接才可发送）。
 */
export function TerminalContextMenu({ sessionId, children }: TerminalContextMenuProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const macros = useConfigStore((s) => s.config?.context_menu ?? []);

  useEffect(() => {
    if (!sessionId) return;
    setContextMenuHandler(sessionId, (x, y) => setPos({ x, y }));
    return () => setContextMenuHandler(sessionId, undefined);
  }, [sessionId]);

  // pool 的 mousedown（capture）已 preventDefault，Radix 靠 contextmenu 事件打开；
  // 这里补发一次合成 contextmenu，保证菜单在右键点弹出。
  useEffect(() => {
    if (!pos) return;
    const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
    const target = el?.closest('.xterm-screen') ?? el;
    if (target) {
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: pos.x,
          clientY: pos.y,
        }),
      );
    }
    const clear = () => setPos(null);
    window.addEventListener('click', clear, { once: true });
    return () => window.removeEventListener('click', clear);
  }, [pos]);

  const connected = !!sessionId && isConnected(sessionId);

  const doCopy = () => {
    if (!sessionId) return;
    if (!copySessionSelection(sessionId)) toast.info(t('terminal.bufferEmpty'));
  };
  const doPaste = () => {
    if (sessionId) void pasteToSession(sessionId);
  };
  const doSelectWord = () => {
    if (sessionId) selectWordAtCursor(sessionId);
  };
  const doSelectAll = () => {
    if (sessionId) selectAllSession(sessionId);
  };
  const doFind = () => {
    if (sessionId) usePanelStore.getState().requestTerminalFind(sessionId);
  };
  const runMacro = (command: string) => {
    if (!sessionId || !connected) return;
    const targets = useBroadcastStore.getState().enabled
      ? listPool().filter((id) => isConnected(id))
      : [sessionId];
    enqueueWriteToTargets(targets, command.trimEnd() + '\r');
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild data-custom-contextmenu>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuLabel>{t('terminal.contextTitle')}</ContextMenuLabel>
        <ContextMenuItem onClick={doCopy} disabled={!sessionId}>
          <IconCopy size={14} className="mr-1" /> {t('terminal.contextCopy')}
        </ContextMenuItem>
        <ContextMenuItem onClick={doPaste} disabled={!sessionId}>
          <IconPaste size={14} className="mr-1" /> {t('terminal.contextPaste')}
        </ContextMenuItem>
        <ContextMenuItem onClick={doSelectWord} disabled={!sessionId}>
          <IconSelectWord size={14} className="mr-1" /> {t('terminal.contextSelectWord')}
        </ContextMenuItem>
        <ContextMenuItem onClick={doSelectAll} disabled={!sessionId}>
          <IconSelectAll size={14} className="mr-1" /> {t('terminal.contextSelectAll')}
        </ContextMenuItem>
        <ContextMenuItem onClick={doFind} disabled={!sessionId}>
          <IconSearch size={14} className="mr-1" /> {t('terminal.find')}
        </ContextMenuItem>
        {macros.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>{t('terminal.contextMacros')}</ContextMenuLabel>
            {macros.slice(0, 12).map((m) => (
              <ContextMenuItem key={m.id} onClick={() => runMacro(m.command)} disabled={!connected}>
                <IconZap size={14} className="mr-1" />
                <span className="truncate">{m.name}</span>
              </ContextMenuItem>
            ))}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
