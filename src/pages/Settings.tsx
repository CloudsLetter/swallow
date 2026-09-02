import { useState } from 'react';
import {
  Download as IconDownload,
  Upload as IconUpload,
  RotateCw as IconReload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AppearanceSettings,
  TerminalSettings,
  ShortcutsSettings,
  CloudSettings,
  AdvancedSettings,
} from './settingsComponents';
import { useConfigStore } from '../store/config';
import { Button } from '../components/ui/button';
import { cn } from '@/lib/utils';

type configTab = 'appearance' | 'terminal' | 'shortcuts' | 'cloud' | 'advanced';

export function SettingsPage() {
  const { t } = useTranslation();
  const loadConfig = useConfigStore((state) => state.loadConfig);

  const [activeTab, setActiveTab] = useState<configTab>('appearance');

  const tabs: { id: configTab; label: string }[] = [
    { id: 'appearance', label: t('settings.appearance') },
    { id: 'terminal', label: t('settings.terminal') },
    { id: 'shortcuts', label: t('settings.shortcuts') },
    { id: 'cloud', label: t('settings.cloud') },
    { id: 'advanced', label: t('settings.advanced') },
  ];

  const renderSettings = () => {
    switch (activeTab) {
      case 'appearance':
        return <AppearanceSettings />;
      case 'terminal':
        return <TerminalSettings />;
      case 'shortcuts':
        return <ShortcutsSettings />;
      case 'cloud':
        return <CloudSettings />;
      case 'advanced':
        return <AdvancedSettings />;
      default:
        return <AppearanceSettings />;
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('settings.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('settings.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled title={t('settings.comingSoon')}>
            <IconDownload size={16} />
            {t('settings.import')}
          </Button>
          <Button variant="secondary" disabled title={t('settings.comingSoon')}>
            <IconUpload size={16} />
            {t('settings.export')}
          </Button>
          <Button variant="secondary" onClick={() => loadConfig()}>
            <IconReload size={16} />
            {t('settings.reload')}
          </Button>
        </div>
      </div>

      {/* ===== 子菜单 chips ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="overlay-scrollbar flex-1 p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">{renderSettings()}</div>
      </div>
    </div>
  );
}
