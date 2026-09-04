import { useState } from 'react';
import {
  Plus as IconPlus,
  Copy as IconCopy,
  Pencil as IconPencil,
  Trash2 as IconTrash,
} from 'lucide-react';
import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { Slider } from '../../components/ui/slider';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../../components/ui/sheet';
import type { TerminalThemePreset, TerminalThemeColors, Config } from '../../types/config';
import { cn } from '@/lib/utils';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { SectionTitle, SwitchRow } from './shared';

const STANDARD_ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const BRIGHT_ANSI_KEYS = ['bright_black', 'bright_red', 'bright_green', 'bright_yellow', 'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_white'] as const;
const BASIC_COLOR_KEYS = ['foreground', 'background', 'cursor', 'cursor_accent', 'selection'] as const;

/** 颜色 key → 友好显示名（foreground → Foreground，bright_black → Bright black，cursor_accent → Cursor accent）。 */
const colorLabel = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function TerminalSettings() {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const [editingTheme, setEditingTheme] = useState<TerminalThemePreset | null>(null);
  const [isCreatingTheme, setIsCreatingTheme] = useState(false);
  const [newThemeName, setNewThemeName] = useState('');

  if (!config) return null;

  // 始终从 store 读最新 config，避免闭包捕获渲染时的旧值，
  // 否则「新建主题」后紧接「设为当前」会拿旧 themes 覆盖掉刚建的主题。
  const getLatestConfig = () => useConfigStore.getState().config;

  const updateTerminalConfig = (updates: Partial<Config['terminal']>) => {
    const cfg = getLatestConfig();
    if (!cfg) return;
    updateConfig({ ...cfg, terminal: { ...cfg.terminal, ...updates } });
  };

  const updateSSHConfig = (updates: Partial<Config['ssh']>) => {
    const cfg = getLatestConfig();
    if (!cfg) return;
    updateConfig({ ...cfg, ssh: { ...cfg.ssh, ...updates } });
  };

  const activeTheme = config.terminal.themes.find((t) => t.id === config.terminal.active_theme_id);

  const addTheme = (input: { name: string; colors: TerminalThemeColors }): string => {
    const cfg = getLatestConfig();
    if (!cfg) return '';
    const newTheme: TerminalThemePreset = {
      id: `terminal-theme-${Date.now()}`,
      name: input.name,
      colors: input.colors,
      built_in: false,
    };
    updateConfig({
      ...cfg,
      terminal: { ...cfg.terminal, themes: [...cfg.terminal.themes, newTheme] },
    });
    return newTheme.id;
  };

  const updateTheme = (themeId: string, updates: Partial<TerminalThemePreset>) => {
    const cfg = getLatestConfig();
    if (!cfg) return;
    updateConfig({
      ...cfg,
      terminal: {
        ...cfg.terminal,
        themes: cfg.terminal.themes.map((t) => (t.id === themeId ? { ...t, ...updates } : t)),
      },
    });
  };

  const deleteTheme = (themeId: string) => {
    const cfg = getLatestConfig();
    if (!cfg) return;
    updateConfig({
      ...cfg,
      terminal: { ...cfg.terminal, themes: cfg.terminal.themes.filter((t) => t.id !== themeId) },
    });
  };

  const handleCreateTheme = () => {
    const name = newThemeName.trim();
    if (!name) return;
    const cfg = getLatestConfig();
    const baseTheme = cfg?.terminal.themes.find((t) => t.built_in) ?? cfg?.terminal.themes[0];
    if (!baseTheme) return;
    const newThemeId = addTheme({ name, colors: baseTheme.colors });
    setNewThemeName('');
    setIsCreatingTheme(false);
    if (newThemeId) {
      updateTerminalConfig({ active_theme_id: newThemeId });
    }
  };

  const handleUpdateThemeColor = (colorKey: keyof TerminalThemeColors, value: string) => {
    if (!editingTheme) return;
    const updatedColors = { ...editingTheme.colors, [colorKey]: value };
    setEditingTheme({ ...editingTheme, colors: updatedColors });
    updateTheme(editingTheme.id, { colors: updatedColors });
  };

  const colorChips = (colors: TerminalThemeColors, keys: readonly string[], size: 'lg' | 'sm') => (
    <div className={cn('flex gap-1.5', size === 'sm' && 'flex-wrap gap-1')}>
      {keys.map((key) => (
        <div
          key={key}
          className={cn(
            'rounded border border-border',
            size === 'lg' ? 'h-8 w-8' : 'h-5 w-5',
          )}
          style={{ backgroundColor: (colors as unknown as Record<string, string>)[key] }}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 当前颜色方案 */}
      {activeTheme && (
        <div className="rounded-lg border border-border bg-card p-4">
          <Label className="mb-3 block text-sm font-medium">{t('settings.terminalColorScheme')}</Label>
          <div className="flex items-center gap-3">
            {colorChips(activeTheme.colors, ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'], 'lg')}
            <div className="flex-1">
              <div className="font-semibold">{activeTheme.name}</div>
              <div className="text-sm text-muted-foreground">
                {activeTheme.built_in ? t('settings.builtInColorScheme') : t('settings.customColorScheme')}
              </div>
            </div>
            <div className="flex gap-1">
              {!activeTheme.built_in && (
                <Button variant="ghost" size="icon-sm" onClick={() => setEditingTheme(activeTheme)} aria-label={t('settings.editColorScheme')}>
                  <IconPencil size={14} />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  const newThemeId = addTheme({
                    name: `${activeTheme.name} (${t('common.copy')})`,
                    colors: activeTheme.colors,
                  });
                  if (newThemeId) updateTerminalConfig({ active_theme_id: newThemeId });
                }}
                aria-label={t('common.copy')}
              >
                <IconCopy size={14} />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 颜色方案列表 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold">
            {t('settings.availableColorSchemes')} ({config.terminal.themes.length})
          </h3>
          <Button onClick={() => setIsCreatingTheme(true)}>
            <IconPlus size={16} />
            {t('settings.createColorScheme')}
          </Button>
        </div>

        <div className="overlay-scrollbar grid max-h-[300px] grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {config.terminal.themes.map((theme) => {
            const isActive = theme.id === config.terminal.active_theme_id;
            return (
              <div
                key={theme.id}
                onClick={() => updateTerminalConfig({ active_theme_id: theme.id })}
                className={cn(
                  'cursor-pointer rounded-lg border p-3 transition-all',
                  isActive ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40',
                )}
              >
                <div className="mb-2 flex items-start justify-between">
                  <div className="flex-1">
                    <div className="text-sm font-semibold">{theme.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {theme.built_in ? t('settings.builtInColorScheme') : t('settings.customColorScheme')}
                    </div>
                  </div>
                  {!theme.built_in && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTheme(theme);
                        }}
                        aria-label={t('settings.editColorScheme')}
                      >
                        <IconPencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await ask(t('settings.deleteColorSchemeConfirm', { name: theme.name }), { title: t('settings.deleteConfirm'), kind: 'warning' })) {
                            deleteTheme(theme.id);
                          }
                        }}
                        aria-label={t('common.delete')}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </div>
                  )}
                </div>
                {colorChips(theme.colors, STANDARD_ANSI_KEYS, 'sm')}
              </div>
            );
          })}
        </div>
      </div>

      {/* 字体设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.fontSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.terminalFontFamily')}</Label>
            <Select value={config.terminal.font_family} onValueChange={(v) => updateTerminalConfig({ font_family: v })}>
              <SelectTrigger className="w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Consolas, 'Courier New', monospace">Consolas</SelectItem>
                <SelectItem value="'Cascadia Code', Consolas, monospace">Cascadia Code</SelectItem>
                <SelectItem value="'Fira Code', monospace">Fira Code</SelectItem>
                <SelectItem value="'JetBrains Mono', monospace">JetBrains Mono</SelectItem>
                <SelectItem value="'Source Code Pro', monospace">Source Code Pro</SelectItem>
                <SelectItem value="Monaco, Menlo, monospace">Monaco</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="mb-2 block text-sm font-medium">
                {t('settings.terminalFontSize')}: {config.terminal.font_size}px
              </Label>
              <Slider
                value={[config.terminal.font_size]}
                min={10}
                max={24}
                step={1}
                onValueChange={(v) => updateTerminalConfig({ font_size: v[0] })}
              />
            </div>
            <div>
              <Label className="mb-2 block text-sm font-medium">
                {t('settings.lineHeight')}: {config.terminal.line_height}
              </Label>
              <Slider
                value={[config.terminal.line_height]}
                min={1}
                max={2}
                step={0.1}
                onValueChange={(v) => updateTerminalConfig({ line_height: v[0] })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 光标设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.cursorSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.cursorStyle')}</Label>
            <div className="grid grid-cols-3 gap-3">
              {(['block', 'underline', 'bar'] as const).map((style) => (
                <Button
                  key={style}
                  variant={config.terminal.cursor_style === style ? 'default' : 'outline'}
                  onClick={() => updateTerminalConfig({ cursor_style: style })}
                >
                  {style === 'block' && `▋ ${t('settings.cursorBlock')}`}
                  {style === 'underline' && `_ ${t('settings.cursorUnderline')}`}
                  {style === 'bar' && `| ${t('settings.cursorBar')}`}
                </Button>
              ))}
            </div>
          </div>

          <SwitchRow
            label={t('settings.cursorBlink')}
            desc={t('settings.cursorBlinkDesc')}
            checked={config.terminal.cursor_blink}
            onCheckedChange={(v) => updateTerminalConfig({ cursor_blink: v })}
          />
        </div>
      </div>

      {/* 外观设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.appearanceSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.transparentBackground')}
            desc={t('settings.transparentBackgroundDesc')}
            checked={config.terminal.allow_transparent_background}
            onCheckedChange={(v) => updateTerminalConfig({ allow_transparent_background: v })}
          />

          <SwitchRow
            label={t('settings.extendBgToTopbar')}
            desc={t('settings.extendBgToTopbarDesc')}
            checked={config.terminal.extend_background_to_topbar}
            onCheckedChange={(v) => updateTerminalConfig({ extend_background_to_topbar: v })}
          />

          <div>
            <Label className="mb-2 block text-sm font-medium">
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
            label={t('settings.drawBoldInBright')}
            desc={t('settings.drawBoldInBrightDesc')}
            checked={config.terminal.draw_bold_text_in_bright_colors}
            onCheckedChange={(v) => updateTerminalConfig({ draw_bold_text_in_bright_colors: v })}
          />
        </div>
      </div>

      {/* 渲染设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.renderSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.renderEngine')}</Label>
            <Select
              value={config.terminal.render_engine ?? 'dom'}
              onValueChange={(v) =>
                updateTerminalConfig({ render_engine: v as Config['terminal']['render_engine'] })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dom">{t('settings.renderEngineDom')}</SelectItem>
                {/* TODO(xterm 6): @xterm/addon-canvas 无 6.x 兼容版，已随 xterm 6.0 卸载依赖；官方发布后：
                    pnpm add @xterm/addon-canvas + 恢复 terminalPool 的 CanvasAddon 加载分支 + 去掉本项 disabled */}
                <SelectItem value="canvas" disabled>
                  {t('settings.renderEngineCanvas')}
                </SelectItem>
                <SelectItem value="webgl">{t('settings.renderEngineWebgl')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.renderEngineDesc')}</p>
          </div>

          <SwitchRow
            label={t('settings.gpuAcceleration')}
            desc={t('settings.gpuAccelerationDesc')}
            checked={config.terminal.gpu_acceleration ?? true}
            disabled={(config.terminal.render_engine ?? 'dom') !== 'webgl'}
            onCheckedChange={(v) => updateTerminalConfig({ gpu_acceleration: v })}
          />
          <p className="text-xs text-muted-foreground">{t('settings.renderNewTerminalHint')}</p>
        </div>
      </div>

      {/* 背景图片 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.backgroundImage')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">{t('settings.backgroundImageDesc')}</p>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  directory: false,
                  filters: [
                    {
                      name: 'Image',
                      extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
                    },
                  ],
                });
                if (typeof selected === 'string' && selected) {
                  updateTerminalConfig({ background_image: selected });
                }
              }}
            >
              {t('settings.selectBackgroundImage')}
            </Button>
            {config.terminal.background_image && (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => updateTerminalConfig({ background_image: '' })}
              >
                {t('settings.clearBackgroundImage')}
              </Button>
            )}
          </div>

          {config.terminal.background_image && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-mono">{config.terminal.background_image}</span>
            </div>
          )}

          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.backgroundImageOpacity')}: {Math.round(config.terminal.background_image_opacity * 100)}%
            </Label>
            <Slider
              value={[config.terminal.background_image_opacity]}
              min={0.1}
              max={1}
              step={0.05}
              onValueChange={(v) => updateTerminalConfig({ background_image_opacity: v[0] })}
            />
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.backgroundImageBlur')}: {config.terminal.background_image_blur}px
            </Label>
            <Slider
              value={[config.terminal.background_image_blur]}
              min={0}
              max={40}
              step={1}
              onValueChange={(v) => updateTerminalConfig({ background_image_blur: v[0] })}
            />
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.selectionOpacity')}: {Math.round((config.terminal.selection_opacity ?? 0.4) * 100)}%
            </Label>
            <Slider
              value={[config.terminal.selection_opacity ?? 0.4]}
              min={0.1}
              max={1}
              step={0.05}
              onValueChange={(v) => updateTerminalConfig({ selection_opacity: v[0] })}
            />
          </div>
        </div>
      </div>

      {/* 滚动设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.scrollSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.scrollback')}: {config.terminal.scrollback} {t('settings.scrollbackLines')}
            </Label>
            <Input
              type="number"
              min={100}
              max={50000}
              step={1000}
              value={config.terminal.scrollback}
              onChange={(e) => updateTerminalConfig({ scrollback: Number(e.target.value) })}
            />
          </div>

          <SwitchRow
            label={t('settings.scrollOnInput')}
            desc={t('settings.scrollOnInputDesc')}
            checked={config.terminal.scroll_on_input}
            onCheckedChange={(v) => updateTerminalConfig({ scroll_on_input: v })}
          />
        </div>
      </div>

      {/* 行为设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.behaviorSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.copyOnSelect')}
            desc={t('settings.copyOnSelectDesc')}
            checked={config.terminal.copy_on_select}
            onCheckedChange={(v) => updateTerminalConfig({ copy_on_select: v })}
          />
          <SwitchRow
            label={t('settings.rightClickSelectWord')}
            desc={t('settings.rightClickSelectWordDesc')}
            checked={config.terminal.right_click_selects_word}
            onCheckedChange={(v) => updateTerminalConfig({ right_click_selects_word: v })}
          />

          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.bellStyle')}</Label>
            <div className="grid grid-cols-4 gap-2">
              {(['none', 'visual', 'sound', 'both'] as const).map((style) => (
                <Button
                  key={style}
                  variant={config.terminal.bell_style === style ? 'default' : 'outline'}
                  onClick={() => updateTerminalConfig({ bell_style: style })}
                >
                  {t(`settings.bell${style.charAt(0).toUpperCase() + style.slice(1)}` as never)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SSH 设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.sshSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.connectionTimeout')}: {config.ssh.connection_timeout} {t('settings.seconds')}
            </Label>
            <Input
              type="number"
              min={5}
              max={120}
              value={config.ssh.connection_timeout}
              onChange={(e) => updateSSHConfig({ connection_timeout: Number(e.target.value) })}
            />
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.keepAliveInterval')}: {config.ssh.keep_alive_interval} {t('settings.seconds')}
            </Label>
            <Input
              type="number"
              min={30}
              max={300}
              step={30}
              value={config.ssh.keep_alive_interval}
              onChange={(e) => updateSSHConfig({ keep_alive_interval: Number(e.target.value) })}
            />
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">
              {t('settings.defaultPort')}: {config.ssh.default_port}{' '}
              <Badge variant="secondary">{t('settings.notEffective')}</Badge>
            </Label>
            <Input
              type="number"
              min={1}
              max={65535}
              value={config.ssh.default_port}
              onChange={(e) => updateSSHConfig({ default_port: Number(e.target.value) })}
            />
          </div>

          <SwitchRow
            label={t('settings.autoReconnect')}
            desc={t('settings.autoReconnectDesc')}
            checked={config.ssh.auto_reconnect}
            onCheckedChange={(v) => updateSSHConfig({ auto_reconnect: v })}
          />

          {config.ssh.auto_reconnect && (
            <div>
              <Label className="mb-2 block text-sm font-medium">
                {t('settings.maxReconnectAttempts')}: {config.ssh.max_reconnect_attempts}
              </Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={config.ssh.max_reconnect_attempts}
                onChange={(e) => updateSSHConfig({ max_reconnect_attempts: Number(e.target.value) })}
              />
            </div>
          )}

          <SwitchRow
            label={t('settings.compression')}
            desc={t('settings.compressionDesc')}
            checked={config.ssh.compression}
            onCheckedChange={(v) => updateSSHConfig({ compression: v })}
            notEffective
          />
        </div>
      </div>

      {/* SSH 会话日志 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.sessionLogSettings')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.sessionLogEnabled')}
            desc={t('settings.sessionLogEnabledDesc')}
            checked={config.terminal.session_log_enabled ?? false}
            onCheckedChange={(v) => updateTerminalConfig({ session_log_enabled: v })}
          />

          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.sessionLogDirectory')}</Label>
            <div className="flex items-center gap-2">
              <Input
                value={config.terminal.session_log_directory ?? ''}
                onChange={(e) => updateTerminalConfig({ session_log_directory: e.target.value })}
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder={t('settings.sessionLogDirectoryPlaceholder')}
              />
              <Button
                variant="secondary"
                onClick={async () => {
                  const selected = await open({ directory: true, multiple: false });
                  if (typeof selected === 'string' && selected) {
                    updateTerminalConfig({ session_log_directory: selected });
                  }
                }}
              >
                {t('settings.selectDirectory')}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.sessionLogDirectoryDesc')}</p>
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.sessionLogFormat')}</Label>
            <Select
              value={config.terminal.session_log_format ?? 'plain'}
              onValueChange={(v) => updateTerminalConfig({ session_log_format: v as Config['terminal']['session_log_format'] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="plain">{t('settings.sessionLogFormatPlain')}</SelectItem>
                  <SelectItem value="ansi-vt">{t('settings.sessionLogFormatAnsiVt')}</SelectItem>
                  <SelectItem value="replay">{t('settings.sessionLogFormatReplay')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.sessionLogFormatDesc')}</p>
          </div>
        </div>
      </div>

      {/* 新建颜色方案抽屉 */}
      <Sheet open={isCreatingTheme} onOpenChange={(open) => !open && setIsCreatingTheme(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('settings.createColorScheme')}</SheetTitle>
          </SheetHeader>
          <div>
            <Label className="mb-1.5 block text-xs font-medium">{t('settings.colorSchemeName')}</Label>
            <Input
              type="text"
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              placeholder={t('settings.colorSchemeNamePlaceholder')}
              autoFocus
            />
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setIsCreatingTheme(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateTheme} disabled={!newThemeName.trim()}>
              {t('common.create')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* 编辑颜色方案抽屉 */}
      <Sheet open={!!editingTheme} onOpenChange={(open) => !open && setEditingTheme(null)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>
              {t('settings.editColorScheme')}: {editingTheme?.name}
            </SheetTitle>
          </SheetHeader>
          {editingTheme && (
            <div className="flex flex-col gap-3.5">
              {!editingTheme.built_in && (
                <div>
                  <Label className="mb-1.5 block text-xs font-medium">{t('settings.colorSchemeName')}</Label>
                  <Input
                    type="text"
                    value={editingTheme.name}
                    onChange={(e) => {
                      setEditingTheme({ ...editingTheme, name: e.target.value });
                      updateTheme(editingTheme.id, { name: e.target.value });
                    }}
                  />
                </div>
              )}

              {/* 标准色（主机表单同款卡片风格） */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground">{t('settings.standardColors')}</div>
                <div className="grid grid-cols-2 gap-2">
                  {STANDARD_ANSI_KEYS.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={editingTheme.colors[key]}
                          onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                          className="size-10 shrink-0 cursor-pointer rounded-md p-0.5"
                        disabled={editingTheme.built_in}
                      />
                      <div className="flex-1">
                        <Label className="mb-1 block text-xs font-medium capitalize">{key}</Label>
                        <Input
                          type="text"
                          value={editingTheme.colors[key]}
                          onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                          className="h-8 px-2 font-mono text-xs"
                          disabled={editingTheme.built_in}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 亮色（ANSI 8-15） */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground">{t('settings.brightColors')}</div>
                <div className="grid grid-cols-2 gap-2">
                  {BRIGHT_ANSI_KEYS.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={editingTheme.colors[key]}
                        onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                        className="size-10 shrink-0 cursor-pointer rounded-md p-0.5"
                        disabled={editingTheme.built_in}
                      />
                      <div className="flex-1">
                        <Label className="mb-1 block text-xs font-medium">{colorLabel(key)}</Label>
                        <Input
                          type="text"
                          value={editingTheme.colors[key]}
                          onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                          className="h-8 px-2 font-mono text-xs"
                          disabled={editingTheme.built_in}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 基础颜色：文字 / 背景 / 光标 / 选区 */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground">{t('settings.terminalBaseColors')}</div>
                <div className="grid grid-cols-2 gap-2">
                  {BASIC_COLOR_KEYS.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={editingTheme.colors[key]}
                        onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                        className="size-10 shrink-0 cursor-pointer rounded-md p-0.5"
                        disabled={editingTheme.built_in}
                      />
                      <div className="flex-1">
                        <Label className="mb-1 block text-xs font-medium">{colorLabel(key)}</Label>
                        <Input
                          type="text"
                          value={editingTheme.colors[key]}
                          onChange={(e) => handleUpdateThemeColor(key, e.target.value)}
                          className="h-8 px-2 font-mono text-xs"
                          disabled={editingTheme.built_in}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {editingTheme.built_in && (
                <div className="rounded-lg border border-border bg-muted p-3 text-muted-foreground">
                  <p className="text-xs">{t('settings.builtInThemeNote')}</p>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
