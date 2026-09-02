import { Upload as IconUpload, Download as IconDownload, Eye as IconEye, EyeOff as IconEyeOff, Loader2 as IconLoader } from 'lucide-react';
import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '../../components/ui/switch';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { SectionTitle } from './shared';
import { cloudSyncNow } from '../../services/dataService';
import type { Cloud } from '../../types/config';

export function CloudSettings() {
  const { t } = useTranslation();
  const [showServerKey, setShowServerKey] = useState(false);
  const [syncing, setSyncing] = useState<'upload' | 'download' | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // 用 ref 追踪进行中的同步，避免定时器/按钮并发触发时重复提交
  const syncingRef = useRef(false);

  const updateCloudConfig = (updates: Partial<Cloud>) => {
    if (!config) return;
    updateConfig({
      ...config,
      cloud: {
        ...config.cloud,
        ...updates,
      },
    });
  };

  const runSync = async (direction: 'upload' | 'download') => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(direction);
    try {
      const report = await cloudSyncNow(direction);
      setLastSync(new Date(report.timestamp).toLocaleString());
      toast.success(
        direction === 'upload'
          ? t('settings.cloudSyncUploaded')
          : t('settings.cloudSyncRestored'),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      syncingRef.current = false;
      setSyncing(null);
    }
  };

  // 定时自动同步：enabled 且 sync_policy 非「手动」，且 sync_interval >= 5 分钟时生效。
  // 按 sync_policy 决定方向：仅上传=upload、仅下载=download、双向/其它=upload。
  useEffect(() => {
    if (!config) return;
    const { enabled, sync_interval, sync_policy } = config.cloud;
    if (!enabled || sync_policy === 3 || !sync_interval || sync_interval < 5) return;

    const direction: 'upload' | 'download' = sync_policy === 1 ? 'download' : 'upload';
    const timer = window.setInterval(() => {
      void runSync(direction);
    }, sync_interval * 60 * 1000);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.cloud.enabled, config?.cloud.sync_interval, config?.cloud.sync_policy]);

  if (!config) {
    return <div>{t('common.loading')}</div>;
  }

  const syncSwitch = (key: 'sync_hosts' | 'sync_keys' | 'sync_settings' | 'sync_snippets', label: string, desc: string) => (
    <div className="flex items-center justify-between">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={config.cloud[key]} onCheckedChange={(checked) => updateCloudConfig({ [key]: checked })} />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 提示 */}
      <div className="rounded-lg border border-border bg-muted p-4">
        <p className="text-sm">{t('settings.cloudSyncDesc')}</p>
      </div>

      {/* 启用云同步 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{t('settings.enableCloudSync')}</Label>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.enableCloudSyncDesc')}</p>
          </div>
          <Switch checked={config.cloud.enabled} onCheckedChange={(checked) => updateCloudConfig({ enabled: checked })} />
        </div>
      </div>

      {/* 服务器配置 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.serverConfig')}</SectionTitle>

        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.serverAddress')}</Label>
            <Input
              type="text"
              value={config.cloud.server_host}
              onChange={(e) => updateCloudConfig({ server_host: e.target.value })}
              placeholder="sync.example.com"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="mb-2 block text-sm font-medium">{t('settings.port')}</Label>
              <Input
                type="number"
                min="1"
                max="65535"
                value={config.cloud.server_port}
                onChange={(e) => updateCloudConfig({ server_port: Number(e.target.value) })}
              />
            </div>

            <div>
              <Label className="mb-2 block text-sm font-medium">{t('settings.syncInterval')}</Label>
              <Input
                type="number"
                min="5"
                max="1440"
                step="5"
                value={config.cloud.sync_interval}
                onChange={(e) => updateCloudConfig({ sync_interval: Number(e.target.value) })}
              />
            </div>
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.serverKey')}</Label>
            <div className="relative">
              <Input
                type={showServerKey ? 'text' : 'password'}
                value={config.cloud.server_key}
                onChange={(e) => updateCloudConfig({ server_key: e.target.value })}
                placeholder={t('settings.serverKeyPlaceholder')}
                className="pr-10 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                onClick={() => setShowServerKey(!showServerKey)}
                aria-label={showServerKey ? t('settings.hideKey') : t('settings.showKey')}
              >
                {showServerKey ? <IconEyeOff size="16" /> : <IconEye size="16" />}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.serverKeyDesc')}</p>
          </div>

          <div>
            <Label className="mb-2 block text-sm font-medium">{t('settings.syncPolicy')}</Label>
            <Select
              value={String(config.cloud.sync_policy)}
              onValueChange={(v) => updateCloudConfig({ sync_policy: Number(v) as 0 | 1 | 2 | 3 })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('settings.syncPolicyUploadOnly')}</SelectItem>
                <SelectItem value="1">{t('settings.syncPolicyDownloadOnly')}</SelectItem>
                <SelectItem value="2">{t('settings.syncPolicyBidirectional')}</SelectItem>
                <SelectItem value="3">{t('settings.syncPolicyManual')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.syncPolicyDesc')}</p>
          </div>
        </div>
      </div>

      {/* 同步内容 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <SectionTitle>{t('settings.syncContent')}</SectionTitle>
        <div className="flex flex-col gap-3">
          {syncSwitch('sync_hosts', t('settings.syncHosts'), t('settings.syncHostsDesc'))}
          {syncSwitch('sync_keys', t('settings.syncKeys'), t('settings.syncKeysDesc'))}
          {syncSwitch('sync_settings', t('settings.syncSettings'), t('settings.syncSettingsDesc'))}
          {syncSwitch('sync_snippets', t('settings.syncSnippets'), t('settings.syncSnippetsDesc'))}
        </div>
      </div>

      {/* 操作 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex gap-3">
          <Button
            disabled={syncing !== null || !config.cloud.enabled}
            onClick={() => void runSync('upload')}
          >
            {syncing === 'upload' ? <IconLoader size={16} className="animate-spin" /> : <IconUpload size={16} />}
            {t('settings.syncNow')}
          </Button>
          <Button
            variant="secondary"
            disabled={syncing !== null || !config.cloud.enabled}
            onClick={() => void runSync('download')}
          >
            {syncing === 'download' ? <IconLoader size={16} className="animate-spin" /> : <IconDownload size={16} />}
            {t('settings.restoreFromCloud')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('settings.lastSync')}: {lastSync ?? t('settings.never')}
          {config.cloud.enabled && config.cloud.sync_policy !== 3 && config.cloud.sync_interval >= 5
            ? ` | ${t('settings.nextSync')}: ${config.cloud.sync_interval} ${t('settings.minutes')} ${t('settings.after')}`
            : ''}
        </p>
      </div>
    </div>
  );
}
