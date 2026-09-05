import { Lock, KeyRound, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 认证方式小图标（Hosts/Account/Keys/Certificates 卡片共用，比徽章轻量）：
 *  密码=锁 / 密钥=钥匙 / 证书=盾牌，颜色与 authBadge 语义一致（info/violet/teal）。 */
const map: Record<string, { Icon: typeof Lock; cls: string }> = {
  password: { Icon: Lock, cls: 'text-info' },
  key: { Icon: KeyRound, cls: 'text-violet-600 dark:text-violet-400' },
  certificate: { Icon: ShieldCheck, cls: 'text-teal-600 dark:text-teal-400' },
  none: { Icon: Lock, cls: 'text-muted-foreground' },
};

export function AuthTypeIcon({
  authType,
  size = 12,
  className,
  title,
}: {
  authType?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const { Icon, cls } = map[authType ?? 'none'] ?? map.none;
  return (
    <span className={cn('shrink-0', className)} title={title} aria-hidden={!title}>
      <Icon size={size} strokeWidth={2} className={cls} />
    </span>
  );
}
