//! Hosts 管理页共享类型与纯函数助手（自 Hosts.tsx 拆出）。

import i18n from '../../i18n/i18n';
import { Badge } from '../../components/ui/badge';
import {
  Check as IconCheck,
  Lock as IconLock,
  KeyRound as IconKeyRound,
  ShieldCheck as IconShieldCheck,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { Account, Host } from '../../services/dataService';

export type ViewMode = 'grid' | 'list';
export type AuthFilter = 'all' | 'password' | 'key' | 'certificate' | 'proxy';
export type ProxyMode = 'existing' | 'manual';
export type AuthSource = 'account' | 'manual';
export type SupportedAccount = Account & { authType: 'password' | 'key' | 'certificate' | 'agent' };

export const sectionClass = 'flex flex-col gap-3 rounded-lg bg-muted/40 p-4';
export const noticeWarningClass =
  'rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning';

export function getAuthTypeText(authType?: Host['authType'] | Account['authType']) {
  switch (authType) {
    case 'key':
      return i18n.t('hosts.authTypeKey');
    case 'certificate':
      return i18n.t('hosts.authTypeCertificate');
    case 'none':
      return i18n.t('hosts.authNone');
    default:
      return i18n.t('hosts.authTypePassword');
  }
}

export function isSupportedHostAccount(account: Account): account is SupportedAccount {
  return (
    account.authType === 'password' ||
    account.authType === 'key' ||
    account.authType === 'certificate' ||
    account.authType === 'agent'
  );
}


export function normalizeHostAuthType(
  authType?: Host['authType'] | Account['authType'],
): 'password' | 'key' | 'certificate' | 'agent' | 'none' {
  if (authType === 'password') return 'password';
  if (authType === 'key') return 'key';
  if (authType === 'certificate') return 'certificate';
  if (authType === 'agent') return 'agent';
  return 'none';
}

export function normalizeHostStatus(status?: Host['status']): 'connected' | 'disconnected' | 'error' {
  if (status === 'connected') return 'connected';
  if (status === 'error') return 'error';
  return 'disconnected';
}

export function findHostAccount(host: Host, accounts: SupportedAccount[]): SupportedAccount | undefined {
  if (!host.accountId) return undefined;
  return accounts.find((account) => account.id === host.accountId);
}

export const authBadge = (authType: 'password' | 'key' | 'certificate' | 'agent' | 'none') => {
  const map = {
    password: { label: i18n.t('hosts.authTypePassword'), cls: 'bg-info/10 text-info' },
    key: { label: i18n.t('hosts.authTypeKey'), cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    certificate: { label: i18n.t('hosts.authTypeCertificate'), cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
    agent: { label: i18n.t('hosts.authTypeAgent'), cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    none: { label: i18n.t('hosts.authNone'), cls: 'bg-muted text-muted-foreground' },
  } as const;
  const item = map[authType];
  return <Badge variant="outline" className={cn('font-normal', item.cls)}>{item.label}</Badge>;
};

/** 状态点色类（statusIcon 与卡片角标复用）：已连接=绿 / 错误=红 / 未连接=灰。 */
const statusDotClass = (status: Host['status']) => {
  const normalized = normalizeHostStatus(status);
  return normalized === 'connected'
    ? 'bg-success ring-2 ring-success/20'
    : normalized === 'error'
      ? 'bg-destructive ring-2 ring-destructive/20'
      : 'bg-muted-foreground/40';
};

/** 状态文本（图标 title / 角标 title 共用）。 */
const statusText = (status: Host['status']) => {
  const normalized = normalizeHostStatus(status);
  return normalized === 'connected'
    ? i18n.t('hosts.groupConnected')
    : normalized === 'error'
      ? i18n.t('common.error')
      : i18n.t('hosts.groupDisconnected');
};

/** 状态图标：纯圆点（不显示文字徽章，hover 提示状态）。 */
export const statusIcon = (status: Host['status']) => (
  <span
    className={cn('inline-block size-2 shrink-0 rounded-full', statusDotClass(status))}
    title={statusText(status)}
  />
);

/** 状态角标（卡片图标块右上角）：已连接=绿色对勾徽章 / 错误=红点 / 未连接=灰点。 */
export const statusCornerBadge = (status: Host['status']) => {
  const title = statusText(status);
  if (normalizeHostStatus(status) === 'connected') {
    return (
      <span
        className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-success text-white ring-2 ring-card"
        title={title}
      >
        <IconCheck size={8} strokeWidth={3.5} />
      </span>
    );
  }
  return (
    <span
      className={cn('absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card', statusDotClass(status))}
      title={title}
    />
  );
};

/** 认证方式小图标（卡片/列表信息补充，比徽章轻量）：密码=锁 / 密钥=钥匙 / 证书=盾牌。 */
export const authIcon = (authType: 'password' | 'key' | 'certificate' | 'agent' | 'none') => {
  const map = {
    password: { Icon: IconLock, cls: 'text-info', label: i18n.t('hosts.authTypePassword') },
    key: { Icon: IconKeyRound, cls: 'text-violet-600 dark:text-violet-400', label: i18n.t('hosts.authTypeKey') },
    certificate: { Icon: IconShieldCheck, cls: 'text-teal-600 dark:text-teal-400', label: i18n.t('hosts.authTypeCertificate') },
    agent: { Icon: IconKeyRound, cls: 'text-amber-600 dark:text-amber-400', label: i18n.t('hosts.authTypeAgent') },
    none: { Icon: IconLock, cls: 'text-muted-foreground', label: i18n.t('hosts.authNone') },
  } as const;
  const { Icon, cls, label } = map[authType];
  return (
    <span className="shrink-0" title={label} aria-label={label}>
      <Icon size={12} strokeWidth={2} className={cls} />
    </span>
  );
};

export const filterChips: { key: AuthFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'password', label: 'hosts.authPassword' },
  { key: 'key', label: 'hosts.authKey' },
  { key: 'certificate', label: 'hosts.authCertificate' },
  { key: 'proxy', label: 'hosts.authProxy' },
];

/** 主机自定义图标上传：SVG/超大文件原样存 data URL；位图压缩到 64px 内 PNG。 */
export async function compressIconFile(file: File): Promise<string> {
  const raw = await readFileAsDataURL(file);
  if (file.type === 'image/svg+xml' || file.size > 1_500_000) return raw;
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode'));
      img.src = raw;
    });
    if (!img.width || !img.height) return raw;
    const canvas = document.createElement('canvas');
    const scale = Math.min(64 / img.width, 64 / img.height, 1);
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return raw;
  }
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}

