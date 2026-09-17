import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap as IconZap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { QuickConnectCardProps } from './types';
import { localShellListProfiles, type LocalShellProfile } from '../../services/sessionService';

/** 本地终端：一键 chips，点击直接打开对应 shell 标签（无需表单）。
 * profile 来自后端探测（local_shell_list_profiles）：不可用的 shell 不下发、
 * 不渲染；WSL 每个发行版是独立入口；加载失败时回退静态列表。 */
export function LocalShellChips({ onOpenSession }: Pick<QuickConnectCardProps, 'onOpenSession'>) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<LocalShellProfile[] | null>(null);

  useEffect(() => {
    void localShellListProfiles()
      .then((list) => setProfiles(list.filter((p) => p.available)))
      .catch(() => setProfiles([]));
  }, []);

  const items = profiles ?? [];
  if (profiles !== null && profiles.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-6 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <IconZap size={14} aria-hidden="true" />
        {t('quickConnect.localShell')}
      </span>
      {profiles === null ? (
        <span className="text-xs text-muted-foreground">…</span>
      ) : (
        items.map((p) => (
          <button
            key={p.shell + (p.wslDistro ?? '') + (p.exePath ?? '')}
            type="button"
            onClick={() =>
              onOpenSession(`${p.label} (local)`, 'local', {
                localConfig: {
                  shell: p.shell,
                  ...(p.wslDistro ? { wslDistro: p.wslDistro } : {}),
                  ...(p.exePath ? { exePath: p.exePath } : {}),
                },
              })
            }
            title={p.exePath ?? (p.wslDistro ? `WSL: ${p.wslDistro}` : p.shell)}
            className={cn(
              'h-7 rounded-md bg-card px-2.5 text-xs font-medium text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))
      )}
    </div>
  );
}
