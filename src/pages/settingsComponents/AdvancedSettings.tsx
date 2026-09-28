import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { toast } from 'sonner';
import { ask } from '@tauri-apps/plugin-dialog';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { SectionTitle, SwitchRow } from './shared';
import { checkForAppUpdates } from '../../services/updaterService';
import { clearAppCache, deleteAllData, resetAppSettings } from '../../services/dataService';

export function AdvancedSettings() {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [busyDanger, setBusyDanger] = useState<string | null>(null);

  if (!config) return null;

  const runDanger = async (key: 'cache' | 'reset' | 'wipe', fn: () => Promise<string | void>, doneKey: string) => {
    const confirmed = await ask(t(`settings.dangerConfirm_${key}`), {
      title: t('settings.dangerZone'),
      kind: 'warning',
    });
    if (!confirmed) return;
    setBusyDanger(key);
    try {
      const msg = await fn();
      toast.success(typeof msg === 'string' && msg ? msg : t(doneKey));
      await loadConfig();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyDanger(null);
    }
  };

  const updateSecurityConfig = (updates: Partial<typeof config.security>) => {
    updateConfig({ ...config, security: { ...config.security, ...updates } });
  };

  const updateAdvancedConfig = (updates: Partial<typeof config.advanced>) => {
    updateConfig({ ...config, advanced: { ...config.advanced, ...updates } });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 安全设置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.securitySettings')}</SectionTitle>
        <div className="flex w-full flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Label className="text-sm font-medium">{t('settings.clearClipboard')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.clearClipboardDesc')}</p>
            </div>
            <Input
              type="number"
              value={config.security.clear_clipboard_after}
              onChange={(e) => updateSecurityConfig({ clear_clipboard_after: Number(e.target.value) })}
              className="w-40"
            />
          </div>
        </div>
      </div>

      {/* 应用行为 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.appBehavior')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.autoSave')}
            desc={t('settings.autoSaveDesc')}
            checked={config.advanced.auto_save}
            onCheckedChange={(v) => updateAdvancedConfig({ auto_save: v })}
          />
          <SwitchRow
            label={t('settings.restoreSessions')}
            desc={t('settings.restoreSessionsDesc')}
            checked={config.advanced.restore_sessions}
            onCheckedChange={(v) => updateAdvancedConfig({ restore_sessions: v })}
          />
          <SwitchRow
            label={t('settings.confirmExit')}
            desc={t('settings.confirmExitDesc')}
            checked={config.advanced.confirm_on_close}
            onCheckedChange={(v) => updateAdvancedConfig({ confirm_on_close: v })}
          />
          <SwitchRow
            label={t('settings.minimizeToTray')}
            desc={t('settings.minimizeToTrayDesc')}
            checked={config.advanced.minimize_to_tray}
            onCheckedChange={(v) => updateAdvancedConfig({ minimize_to_tray: v })}
          />
        </div>
      </div>

      {/* 日志和调试 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.logsAndDebug')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Label className="text-sm font-medium">{t('settings.maxLogs')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.maxLogsDesc')}</p>
            </div>
            <Input
              type="number"
              min={0}
              value={config.advanced.max_logs}
              onChange={(e) => updateAdvancedConfig({ max_logs: Number(e.target.value) })}
              className="w-40"
            />
          </div>
          <SwitchRow
            label={t('settings.debugMode')}
            desc={t('settings.debugModeDesc')}
            checked={config.advanced.debug_mode}
            onCheckedChange={(v) => updateAdvancedConfig({ debug_mode: v })}
          />
        </div>
      </div>

      {/* 更新 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.updatesSection')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.checkUpdates')}
            desc={t('settings.checkUpdatesDesc')}
            checked={config.advanced.check_updates}
            onCheckedChange={(v) => updateAdvancedConfig({ check_updates: v })}
          />
          <Button
            className="w-full"
            disabled={checkingUpdate}
            onClick={() => {
              setCheckingUpdate(true);
              void checkForAppUpdates({ interactive: true }).finally(() => setCheckingUpdate(false));
            }}
          >
            {checkingUpdate ? t('settings.checkingForUpdates') : t('settings.checkForUpdates')}
          </Button>
        </div>
      </div>

      {/* 关于信息 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.about')}</SectionTitle>
        <div className="flex flex-col gap-2 text-sm">
          <p>
            <span className="font-medium">{t('settings.version')}:</span> 0.3.0
          </p>
          <p>
            <span className="font-medium">{t('settings.techStack')}:</span> Tauri 2 + React 19 + TypeScript
          </p>
          <p>
            <span className="font-medium">{t('settings.repository')}:</span>{' '}
            <a
              href="https://github.com/CloudsLetter/swallow"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              https://github.com/CloudsLetter/swallow
            </a>
          </p>
          <p>
            <span className="font-medium">{t('settings.author')}:</span> CloudsLetter
          </p>
        </div>
        <div className="mt-4 flex gap-2 border-t border-border pt-4">
          <Button variant="outline" className="flex-1" disabled title={t('settings.comingSoon')}>
            {t('settings.changelog')}
          </Button>
          <Button variant="outline" className="flex-1" disabled title={t('settings.comingSoon')}>
            {t('settings.license')}
          </Button>
        </div>
      </div>

      {/* 危险操作 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle danger>{t('settings.dangerZone')}</SectionTitle>
        <div className="flex flex-col gap-3">
          <Button
            variant="outline"
            className="w-full justify-start"
            disabled={busyDanger !== null}
            onClick={() => void runDanger('cache', clearAppCache, 'settings.dangerDone_cache')}
          >
            {busyDanger === 'cache' ? t('common.loading') : t('settings.clearCache')}
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            disabled={busyDanger !== null}
            onClick={() =>
              void runDanger('reset', async () => {
                await resetAppSettings();
              }, 'settings.dangerDone_reset')
            }
          >
            {busyDanger === 'reset' ? t('common.loading') : t('settings.resetSettings')}
          </Button>
          <Button
            variant="destructive"
            className="w-full"
            disabled={busyDanger !== null}
            onClick={() => void runDanger('wipe', deleteAllData, 'settings.dangerDone_wipe')}
          >
            {busyDanger === 'wipe' ? t('common.loading') : t('settings.deleteAllData')}
          </Button>
        </div>
      </div>
    </div>
  );
}
