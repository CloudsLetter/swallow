import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * 设置页共享组件：
 * - SectionTitle：分组标题（h3，统一 mb-4 / text-base / font-bold，可选 danger 变体）
 * - SwitchRow：开关行（label + 可选 desc + Switch，可选 notEffective 徽章）
 */

export function SectionTitle({
  children,
  danger = false,
  className,
}: {
  children: React.ReactNode;
  danger?: boolean;
  className?: string;
}) {
  return (
    <h3 className={cn('mb-4 text-base font-bold', danger && 'text-destructive', className)}>
      {children}
    </h3>
  );
}

export function SwitchRow({
  label,
  desc,
  checked,
  onCheckedChange,
  notEffective = false,
  disabled = false,
}: {
  label: React.ReactNode;
  desc?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  notEffective?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between">
      <div className="min-w-0">
        <Label className="text-sm font-medium">
          {label}
          {notEffective && <Badge variant="secondary">{t('settings.notEffective')}</Badge>}
        </Label>
        {desc && <p className="mt-1 text-xs text-muted-foreground">{desc}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
