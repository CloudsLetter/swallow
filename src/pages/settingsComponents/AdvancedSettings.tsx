import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Label } from '../../components/ui/label';
import { SectionTitle, SwitchRow } from './shared';

export function AdvancedSettings() {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  if (!config) return null;

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
          <SwitchRow
            label={t('settings.encryptPasswords')}
            desc={t('settings.encryptPasswordsDesc')}
            checked={config.security.encrypt_passwords}
            onCheckedChange={(v) => updateSecurityConfig({ encrypt_passwords: v })}
            notEffective
          />

          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Label className="text-sm font-medium">
                {t('settings.sessionTimeout')}
                <Badge variant="secondary">{t('settings.notEffective')}</Badge>
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.sessionTimeoutDesc')}</p>
            </div>
            <Input
              type="number"
              value={config.security.session_timeout}
              onChange={(e) => updateSecurityConfig({ session_timeout: Number(e.target.value) })}
              className="w-40"
            />
          </div>

          <SwitchRow
            label={t('settings.lockOnSuspend')}
            desc={t('settings.lockOnSuspendDesc')}
            checked={config.security.lock_on_suspend}
            onCheckedChange={(v) => updateSecurityConfig({ lock_on_suspend: v })}
            notEffective
          />

          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Label className="text-sm font-medium">
                {t('settings.clearClipboard')}
                <Badge variant="secondary">{t('settings.notEffective')}</Badge>
              </Label>
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
            notEffective
          />
          <SwitchRow
            label={t('settings.restoreSessions')}
            desc={t('settings.restoreSessionsDesc')}
            checked={config.advanced.restore_sessions}
            onCheckedChange={(v) => updateAdvancedConfig({ restore_sessions: v })}
            notEffective
          />
          <SwitchRow
            label={t('settings.confirmExit')}
            desc={t('settings.confirmExitDesc')}
            checked={config.advanced.confirm_on_close}
            onCheckedChange={(v) => updateAdvancedConfig({ confirm_on_close: v })}
            notEffective
          />
          <SwitchRow
            label={t('settings.minimizeToTray')}
            desc={t('settings.minimizeToTrayDesc')}
            checked={config.advanced.minimize_to_tray}
            onCheckedChange={(v) => updateAdvancedConfig({ minimize_to_tray: v })}
            notEffective
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
            label={t('settings.enableDebugLogs')}
            desc={t('settings.enableDebugLogsDesc')}
            checked={config.advanced.enable_debug_log}
            onCheckedChange={(v) => updateAdvancedConfig({ enable_debug_log: v })}
            notEffective
          />
          <SwitchRow
            label={t('settings.debugMode')}
            desc={t('settings.debugModeDesc')}
            checked={config.advanced.debug_mode}
            onCheckedChange={(v) => updateAdvancedConfig({ debug_mode: v })}
          />
        </div>
      </div>

      {/* 更新和统计 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.updatesAndAnalytics')}</SectionTitle>
        <div className="flex flex-col gap-4">
          <SwitchRow
            label={t('settings.checkUpdates')}
            desc={t('settings.checkUpdatesDesc')}
            checked={config.advanced.check_updates}
            onCheckedChange={(v) => updateAdvancedConfig({ check_updates: v })}
            notEffective
          />
          <SwitchRow
            label={t('settings.sendAnalytics')}
            desc={t('settings.sendAnalyticsDesc')}
            checked={config.advanced.send_analytics}
            onCheckedChange={(v) => updateAdvancedConfig({ send_analytics: v })}
            notEffective
          />
          <Button className="w-full" disabled title={t('settings.notEffective')}>
            {t('settings.checkForUpdates')}
          </Button>
        </div>
      </div>

      {/* 关于信息 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.about')}</SectionTitle>
        <div className="flex flex-col gap-2 text-sm">
          <p>
            <span className="font-medium">{t('settings.version')}:</span> 0.1.0
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
          <Button variant="outline" className="w-full justify-start" disabled title={t('settings.comingSoon')}>
            {t('settings.clearCache')}
          </Button>
          <Button variant="outline" className="w-full justify-start" disabled title={t('settings.comingSoon')}>
            {t('settings.resetSettings')}
          </Button>
          <Button variant="destructive" className="w-full" disabled title={t('settings.comingSoon')}>
            {t('settings.deleteAllData')}
          </Button>
        </div>
      </div>
    </div>
  );
}
