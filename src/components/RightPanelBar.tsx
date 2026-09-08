import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy as IconCopy,
  PanelRightClose as IconPanelClose,
  Search as IconSearch,
  RadioTower as IconBroadcast,
  Settings as IconSettings,
  SquareTerminal as IconTerminal,
  Zap as IconSnippet,
} from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Slider } from './ui/slider';
import { cn } from '@/lib/utils';
import { usePanelStore, type RightPanelSection } from '../store/panelStore';
import { useConfigStore } from '../store/config';
import { useTabStore } from '../store/tabStore';
import { useBroadcastStore } from '../store/broadcast';
import { useUiPage } from '../store/uiPage';
import { useTerminalBackground } from '../hooks/useTerminalBackground';
import { buildPanelTheme } from './panelTheme';
import { SwitchRow } from '../pages/settingsComponents/shared';
import {
  getSnippets,
  useSnippet as useSnippetApi,
  type Snippet,
} from '../services/dataService';
import {
  copyTerminalBufferToClipboard,
  enqueueWriteToTargets,
  focusTerminal,
  isConnected,
  listPool,
} from './terminalPool';
import type { Config } from '../types/config';

/** 当前激活标签的终端会话（terminal/telnet/local/serial/mosh 共用终端池），无则 undefined。 */
function useActiveTerminalSession(): string | undefined {
  return useTabStore((s) => {
    const tab = s.tabs.find((item) => item.id === s.activeTabId);
    if (!tab || !['terminal', 'telnet', 'local', 'serial', 'mosh'].includes(tab.type)) return undefined;
    return tab.sessionId ?? undefined;
  });
}

// ==================== 终端操作分区 ====================

/**
 * 终端操作分区（原终端右上悬浮操作栏并入）：广播开关、复制全部输出、查找。
 * 查找经 panelStore.findRequest 定向打开对应终端会话的查找条（TerminalView 消费）。
 */
function TerminalSection() {
  const { t } = useTranslation();
  const activeSessionId = useActiveTerminalSession();
  const broadcastEnabled = useBroadcastStore((s) => s.enabled);
  const requestTerminalFind = usePanelStore((s) => s.requestTerminalFind);

  const copyAll = async () => {
    if (!activeSessionId) return;
    try {
      if (await copyTerminalBufferToClipboard(activeSessionId)) {
        toast.success(t('terminal.bufferCopied'));
      } else {
        toast.info(t('terminal.bufferEmpty'));
      }
    } catch (e) {
      console.warn('[terminal] 复制全部缓冲失败:', e);
    }
  };

  return (
    <div className="space-y-4 px-3 py-3">
      {/* 广播模式 */}
      <SwitchRow
        label={
          <span className="flex items-center gap-1.5 text-xs">
            <IconBroadcast size={13} className="shrink-0" />
            {t('terminal.broadcast')}
          </span>
        }
        desc={t('terminal.broadcastDesc')}
        checked={broadcastEnabled}
        onCheckedChange={() => useBroadcastStore.getState().toggle()}
      />

      {/* 操作行 */}
      <section>
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('panel.terminalOps')}</div>
        <div className="space-y-1">
          <button
            type="button"
            disabled={!activeSessionId}
            onClick={() => void copyAll()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <IconCopy size={13} className="shrink-0" />
            {t('terminal.copyAllOutput')}
          </button>
          <button
            type="button"
            disabled={!activeSessionId}
            onClick={() => activeSessionId && requestTerminalFind(activeSessionId)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <IconSearch size={13} className="shrink-0" />
            {t('terminal.find')}
            <span className="ml-auto text-[10px] opacity-60">Ctrl+Shift+F</span>
          </button>
        </div>
        {!activeSessionId && !broadcastEnabled && (
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">{t('panel.noActiveSession')}</p>
        )}
      </section>
    </div>
  );
}

// ==================== 指令分区 ====================

/**
 * 快捷指令分区（原终端操作栏的 SnippetPicker 弹窗并入于此）：
 * 搜索 + 分组列表，点击把命令发到当前激活终端会话（广播模式下发全部已连会话）。
 * 面板常驻挂载，列表随分区激活刷新，搜索词在分区间切换保留。
 */
function CommandsSection({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState('');

  // 激活时刷新列表（用户新建/编辑指令后回到面板可见）
  useEffect(() => {
    if (!active) return;
    void getSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]));
  }, [active]);

  const activeSessionId = useActiveTerminalSession();
  const broadcastEnabled = useBroadcastStore((s) => s.enabled);

  const filtered = useMemo(() => {
    if (!query.trim()) return snippets;
    const q = query.trim().toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.tags?.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [snippets, query]);

  const groups = useMemo(() => {
    const keys = [...new Set(filtered.map((s) => s.category || t('snippets.uncategorized')))].sort((a, b) =>
      a.localeCompare(b),
    );
    return keys.map((key) => ({
      key,
      items: filtered.filter((s) => (s.category || t('snippets.uncategorized')) === key),
    }));
  }, [filtered, t]);

  const handlePick = (snippet: Snippet) => {
    // 发送目标与原悬浮操作栏一致：广播开启时发全部已连会话，否则发当前会话
    const targets = useBroadcastStore.getState().enabled
      ? listPool().filter((id) => isConnected(id))
      : activeSessionId
        ? [activeSessionId]
        : [];
    if (targets.length === 0) return;
    enqueueWriteToTargets(targets, snippet.command.trimEnd() + '\r');
    void useSnippetApi(snippet.id).catch(() => {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 搜索 */}
      <div className="shrink-0 p-2 pb-1.5">
        <div className="relative">
          <IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('snippets.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
          />
        </div>
        {!activeSessionId && !broadcastEnabled && (
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t('panel.noActiveSession')}</p>
        )}
      </div>

      {/* 分组列表 */}
      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-xs text-muted-foreground">
            <IconTerminal size={20} className="mb-2 opacity-50" />
            {query ? t('snippets.emptySearch') : t('snippets.emptyNone')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                  <span>{group.key}</span>
                  <span className="rounded-full bg-muted px-1.5 text-[10px]">{group.items.length}</span>
                </div>
                {group.items.map((snippet) => (
                  <button
                    key={snippet.id}
                    type="button"
                    onClick={() => handlePick(snippet)}
                    className="flex flex-col gap-0.5 rounded-lg border border-sidebar-border bg-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
                    title={snippet.command}
                  >
                    <span className="flex items-center gap-1.5">
                      <IconSnippet size={11} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-medium text-foreground">{snippet.name}</span>
                    </span>
                    <code className="truncate font-mono text-[11px] text-muted-foreground">{snippet.command}</code>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ==================== 设置分区 ====================

/** 快捷设置分区：主题快速切换 + 字号 + 外观（透明/不透明度/延伸顶栏），完整设置走底部入口。 */
function SettingsSection() {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  if (!config) return null;

  // 始终从 store 读最新 config，避免连续滑块拖动时闭包捕获旧值互相覆盖
  const updateTerminalConfig = (updates: Partial<Config['terminal']>) => {
    const cfg = useConfigStore.getState().config;
    if (!cfg) return;
    updateConfig({ ...cfg, terminal: { ...cfg.terminal, ...updates } });
  };

  return (
    <div className="space-y-4 px-3 py-3">
      {/* 颜色方案快速切换 */}
      <section>
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('settings.terminalColorScheme')}</div>
        <div className="space-y-1">
          {config.terminal.themes.map((theme) => {
            const active = theme.id === config.terminal.active_theme_id;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => updateTerminalConfig({ active_theme_id: theme.id })}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                )}
                aria-pressed={active}
              >
                <span className="flex shrink-0 gap-0.5">
                  {(['red', 'green', 'yellow', 'blue'] as const).map((key) => (
                    <span
                      key={key}
                      className="h-3 w-3 rounded-sm border border-border"
                      style={{ backgroundColor: theme.colors[key] }}
                    />
                  ))}
                </span>
                <span className="truncate">{theme.name}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 字体大小 */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{t('settings.terminalFontSize')}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{config.terminal.font_size}px</span>
        </div>
        <Slider
          value={[config.terminal.font_size]}
          min={10}
          max={24}
          step={1}
          onValueChange={(v) => updateTerminalConfig({ font_size: v[0] })}
        />
      </section>

      {/* 外观 */}
      <section>
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('settings.appearanceSettings')}</div>
        <div className="space-y-3">
          <SwitchRow
            label={<span className="text-xs">{t('settings.transparentBackground')}</span>}
            checked={config.terminal.allow_transparent_background}
            onCheckedChange={(v) => updateTerminalConfig({ allow_transparent_background: v })}
          />
          <div>
            <Label className="mb-2 block text-xs">
              {t('settings.backgroundOpacity')}: {Math.round(config.terminal.background_opacity * 100)}%
            </Label>
            <Slider
              value={[config.terminal.background_opacity]}
              min={0.3}
              max={1}
              step={0.05}
              disabled={!config.terminal.allow_transparent_background}
              onValueChange={(v) => updateTerminalConfig({ background_opacity: v[0] })}
            />
          </div>
          <SwitchRow
            label={<span className="text-xs">{t('settings.extendBgToTopbar')}</span>}
            checked={config.terminal.extend_background_to_topbar}
            onCheckedChange={(v) => updateTerminalConfig({ extend_background_to_topbar: v })}
          />
        </div>
      </section>

      {/* 完整设置入口：复用命令条的 pendingNav 机制跳转 home 设置页 */}
      <Button
        variant="ghost"
        className="h-8 w-full justify-start gap-2 text-xs text-muted-foreground"
        onClick={() => {
          useUiPage.getState().setPendingNav('settings');
        }}
      >
        <IconSettings size={14} />
        {t('panel.openSettings')}
      </Button>
    </div>
  );
}

// ==================== 主面板 ====================

/**
 * 右侧功能面板（内嵌占位，与左侧终端面板对称）：
 * - 收起/展开（宽度过渡动画），展开时可拖拽左缘调整宽度（200–480px）；
 * - 「指令」：快捷指令搜索发送到终端（原悬浮弹窗并入）；
 * - 「终端」：广播 / 复制全部输出 / 查找（原悬浮操作栏并入）；
 * - 「设置」：主题快速切换等高频终端设置。AI 助手为独立抽屉，不在本面板。
 * 三个分区常驻挂载（display 切换可见），分区间切换不丢搜索状态；
 * 开关/宽度/分区由 usePanelStore 持久化，配色跟随终端主题（见 panelTheme）。
 */
export function RightPanelBar() {
  const { t } = useTranslation();
  const open = usePanelStore((s) => s.rightPanelOpen);
  const section = usePanelStore((s) => s.rightPanelSection);
  const width = usePanelStore((s) => s.rightPanelWidth);
  const setRightPanelOpen = usePanelStore((s) => s.setRightPanelOpen);
  const setRightPanelSection = usePanelStore((s) => s.setRightPanelSection);
  const setRightPanelWidth = usePanelStore((s) => s.setRightPanelWidth);
  const config = useConfigStore((s) => s.config);

  // 折叠右面板时把键盘焦点归还给当前激活的终端会话
  const activeSessionId = useActiveTerminalSession();
  const prevRightOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevRightOpenRef.current;
    prevRightOpenRef.current = open;
    if (wasOpen && !open && activeSessionId) {
      focusTerminal(activeSessionId);
    }
  }, [open, activeSessionId]);
  // 面板配色跟随终端主题（与左侧面板同源）；isActive=false 不参与顶栏延伸变量注入
  const { terminalBackground, terminalForeground, hasBackgroundImage, extendToTopbar } = useTerminalBackground(
    config,
    false,
  );
  const panelTheme = buildPanelTheme(terminalBackground, terminalForeground, hasBackgroundImage, extendToTopbar);

  // —— 拖拽调宽（手柄在面板左缘：向左拖 = 变宽，dx 取反向位移） ——
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const dx = dragState.current.startX - e.clientX;
    setRightPanelWidth(dragState.current.startWidth + dx);
  };
  const onDragEnd = () => {
    dragState.current = null;
    setDragging(false);
  };

  const sectionActive = (s: RightPanelSection) => open && section === s;

  return (
    <aside
      className={cn('relative h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out', dragging && 'select-none')}
      style={{ width: open ? width : 0, zIndex: 2 }}
    >
      <div
        className={cn(
          'flex h-full flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground',
          !open && 'invisible',
        )}
        style={{ width, ...panelTheme.style }}
      >
        {/* 头部：分区切换 + 收起按钮 */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-1 border-b border-sidebar-border pl-1 pr-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {(
              [
                { id: 'commands' as const, label: t('panel.commands'), icon: <IconTerminal size={13} strokeWidth={2} /> },
                { id: 'terminal' as const, label: t('panel.terminal'), icon: <IconBroadcast size={13} strokeWidth={2} /> },
                { id: 'settings' as const, label: t('panel.settings'), icon: <IconSettings size={13} strokeWidth={2} /> },
              ]
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setRightPanelSection(item.id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
                  section === item.id
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                )}
                aria-pressed={section === item.id}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 shrink-0"
            onClick={() => setRightPanelOpen(false)}
            title={t('terminalPanel.collapse')}
            aria-label={t('terminalPanel.collapse')}
          >
            <IconPanelClose size={15} strokeWidth={2} />
          </Button>
        </div>

        {/* 分区内容：指令/终端/设置都常驻挂载（display 切换可见性）——搜索状态在分区间切换不丢失 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <div style={{ display: section === 'commands' ? 'block' : 'none', height: '100%' }}>
            <CommandsSection active={sectionActive('commands')} />
          </div>
          <ScrollArea className="h-full" style={{ display: section === 'terminal' ? 'block' : 'none' }}>
            <TerminalSection />
          </ScrollArea>
          <ScrollArea className="h-full" style={{ display: section === 'settings' ? 'block' : 'none' }}>
            <SettingsSection />
          </ScrollArea>
        </div>

        {/* 拖拽手柄：左缘 8px 热区 */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize transition-colors',
            dragging ? 'bg-primary/30' : 'hover:bg-primary/20',
          )}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          role="separator"
          aria-orientation="vertical"
        />
      </div>
    </aside>
  );
}
