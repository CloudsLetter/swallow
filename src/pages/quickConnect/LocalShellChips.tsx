import { useTranslation } from 'react-i18next';
import { Zap as IconZap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { QuickConnectCardProps } from './types';

/** 本地终端可选的 shell 类型。 */
const SHELL_OPTIONS = [
  { value: 'cmd', label: 'cmd' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'wsl', label: 'WSL' },
  { value: 'bash', label: 'Git Bash' },
] as const;

/** 本地终端：一键 chips，点击直接打开对应 shell 标签（无需表单）。 */
export function LocalShellChips({ onOpenSession }: Pick<QuickConnectCardProps, 'onOpenSession'>) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2 px-6 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <IconZap size={14} />
        {t('quickConnect.localShell')}
      </span>
      {SHELL_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() =>
            onOpenSession(`${opt.value} (local)`, 'local', { localConfig: { shell: opt.value } })
          }
          className={cn(
            'h-7 rounded-md bg-card px-2.5 text-xs font-medium text-muted-foreground',
            'transition-colors hover:bg-accent hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
