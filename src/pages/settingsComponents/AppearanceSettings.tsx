import { useState } from 'react';
import {
  Plus as IconPlus,
  Copy as IconCopy,
  Trash2 as IconTrash,
  Pencil as IconPencil,
  ChevronDown as IconChevronDown,
  ChevronRight as IconChevronRight,
  Check as IconCheck,
} from 'lucide-react';
import { useConfigStore } from '../../store/config';
import { useThemeStore } from '../../store/themeStore';
import { useTranslation } from 'react-i18next';
import { Switch } from '../../components/ui/switch';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../../components/ui/sheet';
import type { ThemePreset, ThemeColors, Config } from '../../types/config';
import { colorGroups } from '../../exam/ColorGroups';
import { defaultColors } from '../../default/themeColors';
import { applyThemeColors } from '../../hooks/themeUtils';
import { cn } from '@/lib/utils';
import { ask } from '@tauri-apps/plugin-dialog';

const THEME_PREVIEW_KEYS: (keyof ThemeColors)[] = [
  'primary',
  'success',
  'warning',
  'error',
  'info',
  'bg_primary',
  'surface',
  'text_primary',
];

export function AppearanceSettings() {
  const { t } = useTranslation();

  const appearanceConfig = useConfigStore((state) => state.config?.appearance);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const [editingTheme, setEditingTheme] = useState<ThemePreset | null>(null);
  const [isCreatingTheme, setIsCreatingTheme] = useState(false);
  const [newThemeName, setNewThemeName] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['buttons']));

  if (!appearanceConfig || !config) return null;

  const themes = appearanceConfig.themes;

  // 变更一律读运行时最新配置快照，避免闭包捕获渲染时的旧 config，
  // 连续多次同步 update 互相覆盖（stale-closure）。
  const updateAppearanceConfig = (updates: Partial<Config['appearance']>) => {
    const current = useConfigStore.getState().config;
    if (!current) return;
    updateConfig({ appearance: { ...current.appearance, ...updates } });
  };

  const addTheme = (theme: Omit<ThemePreset, 'id' | 'built_in'>): string => {
    const newTheme: ThemePreset = {
      ...theme,
      id: `theme-${Date.now()}`,
      built_in: false,
    };
    const current = useConfigStore.getState().config;
    if (!current) return '';
    updateConfig({
      appearance: { ...current.appearance, themes: [...current.appearance.themes, newTheme] },
    });
    return newTheme.id;
  };

  const updateTheme = async (themeId: string, updates: Partial<ThemePreset>) => {
    const current = useConfigStore.getState().config;
    if (!current) return;
    updateConfig({
      appearance: {
        ...current.appearance,
        themes: current.appearance.themes.map((t) => (t.id === themeId ? { ...t, ...updates } : t)),
      },
    });
  };

  const deleteTheme = (themeId: string) => {
    const current = useConfigStore.getState().config;
    if (!current) return;
    updateConfig({
      appearance: { ...current.appearance, themes: current.appearance.themes.filter((t) => t.id !== themeId) },
    });
  };

  const duplicateTheme = (themeId: string) => {
    const theme = themes.find((t) => t.id === themeId);
    if (!theme) return null;
    return addTheme({ name: `${theme.name} (${t('common.copy')})`, colors: theme.colors });
  };

  const handleCreateTheme = () => {
    if (!newThemeName.trim()) return;
    addTheme({ name: newThemeName, colors: defaultColors });
    setNewThemeName('');
    setIsCreatingTheme(false);
  };

  const handleUpdateThemeColor = async (colorKey: keyof ThemeColors, value: string) => {
    if (!editingTheme) return;
    const updatedColors = { ...editingTheme.colors, [colorKey]: value };
    const updatedTheme = { ...editingTheme, colors: updatedColors };
    setEditingTheme(updatedTheme);
    await updateTheme(editingTheme.id, { colors: updatedColors });
    // 实时预览（themeUtils 已被多处静态引用，直接静态调用）
    applyThemeColors(updatedColors as ThemeColors);
  };

  const toggleSection = (section: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedSections(newExpanded);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 主题模式开关 */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div>
          <Label className="text-sm font-medium">{t('settings.followSystem')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.followSystemDesc')}</p>
        </div>
        <Switch
          checked={appearanceConfig.auto_detect_system_theme}
          onCheckedChange={(checked) => useThemeStore.getState().setAutoDetectSystemDarkMode(checked)}
        />
      </div>

      {/* 主题展示 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold">{t('settings.availableThemes')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.availableThemesDesc')}</p>
          </div>
          <Button
            onClick={() => {
              setIsCreatingTheme(true);
              setNewThemeName('');
            }}
          >
            <IconPlus size={16} />
            {t('settings.createTheme')}
          </Button>
        </div>

        {/* 主题列表 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {themes.map((theme) => {
            const isActive = theme.id === config.appearance.active_theme_id;
            return (
              <div
                key={theme.id}
                className={cn(
                  'cursor-pointer rounded-lg border p-4 transition-all',
                  isActive ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40',
                )}
                onClick={() => useThemeStore.getState().setActiveThemeId(theme.id)}
              >
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <h4 className="truncate text-sm font-semibold">{theme.name}</h4>
                    {isActive && (
                      <Badge className="shrink-0">
                        <IconCheck />
                      </Badge>
                    )}
                  </div>
                  <div className="ml-2 flex shrink-0 gap-1">
                    {!theme.built_in && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTheme(theme);
                        }}
                        aria-label={t('settings.editTheme')}
                      >
                        <IconPencil size={14} />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicateTheme(theme.id);
                      }}
                      aria-label={t('common.copy')}
                    >
                      <IconCopy size={14} />
                    </Button>
                    {!theme.built_in && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await ask(t('settings.deleteThemeConfirm', { name: theme.name }), { title: t('settings.deleteConfirm'), kind: 'warning' })) {
                            deleteTheme(theme.id);
                          }
                        }}
                        aria-label={t('settings.deleteTheme')}
                      >
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </div>
                </div>

                {/* 颜色预览 */}
                <div className="grid grid-cols-8 gap-1.5">
                  {THEME_PREVIEW_KEYS.map((colorKey) => {
                    const colorValue = theme.colors[colorKey];
                    return (
                      <div
                        key={colorKey}
                        className="aspect-square rounded border border-border transition-transform hover:scale-110"
                        style={{ backgroundColor: colorValue || '#ccc' }}
                        title={`${colorKey}: ${colorValue}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 界面字体 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('settings.fontFamily')}</Label>
            <Select value={config.appearance.font_family} onValueChange={(v) => useThemeStore.getState().setFontFamily(v)}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
                  {t('settings.systemDefault')}
                </SelectItem>
                <SelectItem value="'Microsoft YaHei', 微软雅黑, sans-serif">微软雅黑</SelectItem>
                <SelectItem value="'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans CN', sans-serif">
                  苹方/冬青黑
                </SelectItem>
                <SelectItem value="'Noto Sans SC', 'Noto Sans CJK SC', sans-serif">Noto Sans SC</SelectItem>
                <SelectItem value="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif">Segoe UI</SelectItem>
                <SelectItem value="'Roboto', 'Helvetica Neue', Arial, sans-serif">Roboto</SelectItem>
                <SelectItem value="Arial, Helvetica, sans-serif">Arial</SelectItem>
                <SelectItem value="'Source Sans Pro', sans-serif">Source Sans Pro</SelectItem>
                <SelectItem value="'Open Sans', sans-serif">Open Sans</SelectItem>
                <SelectItem value="'Inter', sans-serif">Inter</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('settings.fontSize')}</Label>
            <Input
              type="number"
              min="12"
              max="20"
              value={config.appearance.font_size}
              onChange={(e) => {
                const size = Number(e.target.value);
                useThemeStore.getState().setFontSize(size);
              }}
              className="w-40"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">{t('settings.uiScale')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.uiScaleDesc')}</p>
            </div>
            <Select
              value={String(config.appearance.ui_scale ?? 1.0)}
              onValueChange={(v) => useThemeStore.getState().setUiScale(Number(v))}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">100%</SelectItem>
                <SelectItem value="1.1">110%</SelectItem>
                <SelectItem value="1.25">125%</SelectItem>
                <SelectItem value="1.5">150%</SelectItem>
                <SelectItem value="0.9">90%</SelectItem>
                <SelectItem value="0.8">80%</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">{t('settings.windowEffect')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.windowEffectDesc')}</p>
            </div>
            <Select
              value={config.appearance.window_effect ?? 'none'}
              onValueChange={(v) => useThemeStore.getState().setWindowEffect(v)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('settings.windowEffectNone')}</SelectItem>
                <SelectItem value="acrylic">Acrylic（毛玻璃）</SelectItem>
                <SelectItem value="mica">Mica（Win11）</SelectItem>
                <SelectItem value="blur">Blur（模糊）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('settings.language')}</Label>
            <Select
              value={config.appearance.language}
              onValueChange={(v) => updateAppearanceConfig({ language: v as Config['appearance']['language'] })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">简体中文</SelectItem>
                <SelectItem value="en-US">English</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* 滚动条 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">{t('settings.scrollbarOverlay')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.scrollbarOverlayDesc')}</p>
            </div>
            <Switch
              checked={appearanceConfig.scrollbar_overlay}
              onCheckedChange={(checked) => updateAppearanceConfig({ scrollbar_overlay: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('settings.scrollbarWidth')}</Label>
            <Input
              type="number"
              min={4}
              max={20}
              value={appearanceConfig.scrollbar_width}
              onChange={(e) => {
                const w = Number(e.target.value);
                if (Number.isNaN(w)) return;
                updateAppearanceConfig({ scrollbar_width: Math.min(20, Math.max(4, Math.round(w))) });
              }}
              className="w-40"
            />
          </div>
        </div>
      </div>

      {/* 创建主题抽屉 */}
      <Sheet open={isCreatingTheme} onOpenChange={(open) => !open && setIsCreatingTheme(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('settings.createTheme')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            <div>
              <Label className="mb-1.5 block text-xs font-medium">{t('settings.themeName')}</Label>
              <Input
                type="text"
                value={newThemeName}
                onChange={(e) => setNewThemeName(e.target.value)}
                placeholder={t('settings.themeNamePlaceholder')}
                autoFocus
              />
            </div>
            <div className="rounded-lg border border-border bg-muted p-3 text-muted-foreground">
              <p className="text-xs">{t('settings.newThemeNote')}</p>
            </div>
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

      {/* 编辑主题抽屉 */}
      <Sheet open={!!editingTheme} onOpenChange={(open) => !open && setEditingTheme(null)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>
              {t('settings.editTheme')}: {editingTheme?.name}
            </SheetTitle>
          </SheetHeader>
          {editingTheme && (
            <div className="flex flex-col gap-3.5">
              {!editingTheme.built_in && (
                <div>
                  <Label className="mb-1.5 block text-xs font-medium">{t('settings.themeName')}</Label>
                  <Input
                    type="text"
                    value={editingTheme.name}
                    onChange={(e) => {
                      const updated = { ...editingTheme, name: e.target.value };
                      setEditingTheme(updated);
                      updateTheme(editingTheme.id, { name: e.target.value });
                    }}
                  />
                </div>
              )}

              {/* 颜色分组（主机表单同款卡片风格） */}
              <div className="flex flex-col gap-3.5">
                {colorGroups.map((group) => (
                  <div key={group.id} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Button
                      variant="ghost"
                      className="h-9 w-full justify-between rounded-none px-3"
                      onClick={() => toggleSection(group.id)}
                    >
                      <span className="text-sm font-medium">{t(`colorGroups.titles.${group.id}`)}</span>
                      {expandedSections.has(group.id) ? (
                        <IconChevronDown size={18} />
                      ) : (
                        <IconChevronRight size={18} />
                      )}
                    </Button>
                    {expandedSections.has(group.id) && (
                      <div className="grid grid-cols-1 gap-2 border-t border-border p-4">
                        {group.colors.map((color) => (
                          <div key={color.key} className="flex items-center gap-2">
                            <Input
                              type="color"
                              value={editingTheme.colors[color.key as keyof ThemeColors] || '#000000'}
                              onChange={(e) => handleUpdateThemeColor(color.key as keyof ThemeColors, e.target.value)}
                              className="size-10 shrink-0 cursor-pointer rounded-md p-0.5"
                              disabled={editingTheme.built_in}
                            />
                            <div className="min-w-0 flex-1">
                              <Label className="mb-1 block text-xs font-medium text-muted-foreground">{t(`colorGroups.labels.${color.key}`)}</Label>
                              <Input
                                type="text"
                                value={editingTheme.colors[color.key as keyof ThemeColors] || ''}
                                onChange={(e) => handleUpdateThemeColor(color.key as keyof ThemeColors, e.target.value)}
                                className="h-8 px-2 font-mono text-xs"
                                disabled={editingTheme.built_in}
                                placeholder="#000000"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
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
