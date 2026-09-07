import { useTranslation } from 'react-i18next';
import {
  Bot as IconBot,
  Settings as IconSettings,
  X as IconX,
} from 'lucide-react';
import { usePanelStore } from '../store/panelStore';
import { useConfigStore } from '../store/config';
import { useUiPage } from '../store/uiPage';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Slider } from './ui/slider';
import { SwitchRow } from '../pages/settingsComponents/shared';
import type { Config } from '../types/config';
import { cn } from '@/lib/utils';

/**
 * 右侧快捷设置面板（Topbar 右上角开关控制显隐）：
 * 高频终端设置的快速入口——AI 助手、颜色方案切换、字号、
 * 透明背景/背景不透明度/延伸到顶栏；完整设置走「打开全部设置」跳设置页。
 * 固定定位悬挂在顶栏之下、内容之上（不挤压布局），关闭时滑出屏外。
 */
export function QuickSettingsPanel() {
  const { t } = useTranslation();
  const open = usePanelStore((s) => s.rightPanelOpen);
  const setAiOpen = usePanelStore((s) => s.setAiOpen);
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
    <aside
      className={cn(
        'fixed bottom-0 right-0 top-[44px] z-[45] w-[280px] border-l border-border bg-background shadow-lg transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      )}
      aria-hidden={!open}
    >
      <div className="flex h-full flex-col">
        {/* 头部 */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
          <span className="text-sm font-medium">{t('panel.quickSettings')}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7"
            onClick={() => usePanelStore.getState().setRightPanelOpen(false)}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <IconX size={14} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
          {/* AI 助手 */}
          <Button variant="outline" className="h-8 w-full justify-start gap-2 text-xs" onClick={() => setAiOpen(true)}>
            <IconBot size={14} className="text-primary" />
            {t('panel.aiAssistant')}
          </Button>

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
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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
      </div>
    </aside>
  );
}
