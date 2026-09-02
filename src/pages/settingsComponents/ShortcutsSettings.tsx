import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../store/config';
import { useState, useEffect } from 'react';
import { Keyboard as IconKeyboard } from 'lucide-react';
import { useGlobalState } from '../../store/state';
import { Switch } from '../../components/ui/switch';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Kbd } from '../../components/ui/kbd';

export function ShortcutsSettings() {
  const { t } = useTranslation();
  const globalState = useGlobalState((state) => state);
  const config = useConfigStore((state) => state.config);

  const updateConfig = useConfigStore((state) => state.updateConfig);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const DEFAULT_SHORTCUTS: Record<string, string> = {
    new_tab: 'Ctrl+T',
    close_tab: 'Ctrl+W',
    next_tab: 'Ctrl+Shift+→',
    prev_tab: 'Ctrl+Shift+←',
    copy: 'Ctrl+C',
    paste: 'Ctrl+V',
    find: 'Ctrl+F',
    terminal_copy: 'Ctrl+Shift+C',
    terminal_paste: 'Ctrl+Shift+V',
    terminal_select_all: 'Ctrl+Shift+A',
  };

  // 与默认值合并：老 config 未存 terminal_* 时也显示并可用（保存后落盘）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interface 无 index signature，展开合并即可
  const mergedShortcuts = (s: any) => ({ ...DEFAULT_SHORTCUTS, ...s });

  const [localShortcuts, setLocalShortcuts] = useState<Record<string, string | boolean>>(() =>
    config?.shortcuts ? mergedShortcuts(config.shortcuts) : { ...DEFAULT_SHORTCUTS },
  );

  if (!config) return null;

  useEffect(() => {
    if (config?.shortcuts) setLocalShortcuts(mergedShortcuts(config.shortcuts));
  }, [config?.shortcuts]);

  // 进入该设置页时临时禁用快捷键，离开时恢复
  useEffect(() => {
    globalState.toggleShortcuts();
    return () => {
      globalState.toggleShortcuts();
    };
  }, []);

  const handleShortcutChange = (key: string, value: string) => {
    setLocalShortcuts((data) => ({ ...data, [key]: value }));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, actionKey: string) => {
    e.preventDefault();

    const keys: string[] = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    if (e.metaKey) keys.push('Meta');

    const specialKeys: Record<string, string> = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
    };

    let keyName = e.key;

    if (specialKeys[e.key]) {
      keyName = specialKeys[e.key];
    } else if (keyName.length === 1) {
      keyName = keyName.toUpperCase();
    }

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    keys.push(keyName);
    const shortcut = keys.join('+');
    handleShortcutChange(actionKey, shortcut);
    setEditingKey(null);
  };

  const isDirty = JSON.stringify(localShortcuts) !== JSON.stringify(config.shortcuts);

  return (
    <div className="flex flex-col gap-4">
      {/* 提示 */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted p-4">
        <IconKeyboard size={20} className="mt-0.5 text-primary" />
        <div>
          <p className="mb-1 text-sm">
            <strong>{t('common.tip')}：</strong>
            {t('settings.shortcutsHint')}
          </p>
          <p className="text-xs text-muted-foreground">{t('settings.shortcutsDesc')}</p>
        </div>
      </div>

      {/* 启用/禁用快捷键 */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div>
          <Label className="text-sm font-medium">{t('settings.shortcuts')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.toggleShortcutsDesc')}</p>
        </div>
        <Switch
          checked={config.shortcuts?.enabled}
          onCheckedChange={(checked) =>
            updateConfig({ ...config, shortcuts: { ...config.shortcuts, enabled: checked } })
          }
        />
      </div>

      {/* 快捷键列表 */}
      <div className="flex flex-col gap-3">
        {Object.entries(localShortcuts)
          .filter(([k]) => k !== 'enabled')
          .map(([actionKey, binding]) => (
            <div
              key={actionKey}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <div className="flex-1">
                <span className="text-sm font-medium">{t(`shortcuts.${actionKey}`)}</span>
              </div>

              {editingKey === actionKey ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={String(binding)}
                    readOnly
                    onKeyDown={(e) => handleKeyDown(e, actionKey)}
                    onBlur={() => setEditingKey(null)}
                    autoFocus
                    placeholder={t('settings.shortcutsPlaceholder')}
                    className="h-8 w-40 border-primary bg-primary/10 text-center font-mono"
                  />
                  <Button variant="ghost" onClick={() => setEditingKey(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : (
                <Kbd
                  onClick={() => setEditingKey(actionKey)}
                  className="pointer-events-auto w-40 cursor-pointer justify-center font-mono text-sm transition-colors hover:bg-accent"
                >
                  {String(binding)}
                </Kbd>
              )}
            </div>
          ))}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            updateConfig({ ...config, shortcuts: { ...(localShortcuts as unknown as typeof config.shortcuts) } });
          }}
          disabled={!isDirty}
        >
          {t('common.save')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setLocalShortcuts({ ...config.shortcuts });
            setEditingKey(null);
          }}
          disabled={!isDirty}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setLocalShortcuts({ ...DEFAULT_SHORTCUTS });
            setEditingKey(null);
          }}
        >
          {t('common.resetToDefault')}
        </Button>
      </div>
    </div>
  );
}
