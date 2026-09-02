import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X as IconX,
  ExternalLink as IconExternalLink,
  Terminal as IconTerminal,
  FolderOpen as IconFolderOpen,
} from 'lucide-react';
import { TerminalView } from './TerminalView';
import { SftpView } from './SftpView';
import { useTabStore, type SplitPane } from '../store/tabStore';
import { type SplitLayout, leaf, MIN_RATIO, MAX_RATIO } from '../store/splitLayout';
import { Button } from './ui/button';

interface SplitViewProps {
  tabId: string;
  panes: SplitPane[];
  layout?: SplitLayout;
  // 所在标签是否激活（keep-alive 下非激活容器 display:none，子终端需据此跳过 fit）
  isActive?: boolean;
}

interface PaneViewProps {
  tabId: string;
  pane: SplitPane;
  isActive: boolean;
  resizeSignal: number;
}

/** 单个 pane：标题栏 + TerminalView/SftpView。 */
function PaneView({ tabId, pane, isActive, resizeSignal }: PaneViewProps) {
  const { t } = useTranslation();
  const { closePane, unmergePane } = useTabStore();
  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      {/* pane 标题栏 */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2">
        {pane.type === 'terminal' ? (
          <IconTerminal size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <IconFolderOpen size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {pane.name}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => unmergePane(tabId, pane.id)}
          title={t('split.moveOutToNewTab')}
        >
          <IconExternalLink size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => closePane(tabId, pane.id)}
          title={t('split.closeSplit')}
        >
          <IconX size={12} />
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        {pane.type === 'terminal' ? (
          <TerminalView
            sessionId={pane.sessionId}
            sshConfig={pane.sshConfig}
            isActive={isActive}
            resizeSignal={resizeSignal}
          />
        ) : (
          <SftpView sessionId={pane.sessionId} sftpConfig={pane.sftpConfig} isActive={isActive} />
        )}
      </div>
    </div>
  );
}

interface DividerProps {
  horizontal: boolean; // true = 左右布局的分隔条（拖动调整宽度）
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onDragEnd: () => void;
}

/** 分隔条：拖动调整其父节点两侧的比例。 */
function Divider({ horizontal, ratio, onRatioChange, onDragEnd }: DividerProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ start: number; startRatio: number; total: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const total = horizontal ? parent.offsetWidth : parent.offsetHeight;
    if (total <= 0) return;
    dragRef.current = {
      start: horizontal ? e.clientX : e.clientY,
      startRatio: ratio,
      total,
    };

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pos = horizontal ? ev.clientX : ev.clientY;
      let next = drag.startRatio + (pos - drag.start) / drag.total;
      next = Math.max(MIN_RATIO, Math.min(MAX_RATIO, next));
      onRatioChange(next);
    };

    const onUp = () => {
      dragRef.current = null;
      onDragEnd();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      className={
        horizontal
          ? 'shrink-0 cursor-col-resize border-border bg-border transition-colors hover:bg-primary/60'
          : 'shrink-0 cursor-row-resize border-border bg-border transition-colors hover:bg-primary/60'
      }
      style={horizontal ? { width: 3 } : { height: 3 }}
      title={t('split.dragToResize')}
    />
  );
}

/** 分屏容器：递归渲染 row/col 分割树（VS Code 式，最多 4 个 pane）。 */
export function SplitView({ tabId, panes, layout, isActive = true }: SplitViewProps) {
  const { setSplitRatio } = useTabStore();
  // 拖动分隔条后递增，通知终端重新 fit 到新尺寸
  const [resizeSignal, setResizeSignal] = useState(0);

  const panesById = useMemo(() => {
    const map = new Map<string, SplitPane>();
    for (const p of panes) map.set(p.id, p);
    return map;
  }, [panes]);

  // 布局缺失时兜底为单叶子（正常不会发生，split 标签始终带 layout）
  const root = layout ?? (panes[0] ? leaf(panes[0].id) : leaf(''));

  const renderNode = (node: SplitLayout): ReactNode => {
    if (node.kind === 'leaf') {
      const pane = panesById.get(node.paneId);
      if (!pane) return null;
      return (
        <PaneView
          key={node.paneId}
          tabId={tabId}
          pane={pane}
          isActive={isActive}
          resizeSignal={resizeSignal}
        />
      );
    }

    const horizontal = node.kind === 'row';
    return (
      <div
        key={node.id}
        className={horizontal ? 'flex h-full w-full min-h-0 min-w-0' : 'flex h-full w-full min-h-0 min-w-0 flex-col'}
      >
        <div
          className="min-h-0 min-w-0"
          style={
            horizontal
              ? { flex: '0 0 auto', width: `${node.ratio * 100}%` }
              : { flex: '0 0 auto', height: `${node.ratio * 100}%` }
          }
        >
          {renderNode(node.a)}
        </div>
        <Divider
          horizontal={horizontal}
          ratio={node.ratio}
          onRatioChange={(r) => setSplitRatio(tabId, node.id, r)}
          onDragEnd={() => setResizeSignal((s) => s + 1)}
        />
        <div className="min-h-0 min-w-0" style={{ flex: '1 1 0' }}>
          {renderNode(node.b)}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full w-full" style={{ overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
      {renderNode(root)}
    </div>
  );
}
