import type { ReactNode } from 'react';
import { Search as IconSearch } from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/**
 * 全应用统一的列表页页头（Hosts/Keys/Account/Certificates/KnownHosts/Sftp/
 * Snippets/Monitor/PortForwarding/Logs/Settings 共用）：
 * - 左：标题（15px semibold）+ 副标题（12px muted），基线对齐；
 * - 右：搜索框（w-64）+ 操作区；
 * - 下方可选筛选行（chips/select/开关），由调用方传入。
 * 收敛前各页 min-h-11/px-4/gap 等细微不一致，视觉节奏统一为 h-12/px-5。
 */
export function PageHeader({
  title,
  subtitle,
  search,
  actions,
  filters,
}: {
  title: string;
  subtitle?: string;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    inputRef?: React.RefObject<HTMLInputElement | null>;
  };
  actions?: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <>
      <div className="flex h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {search && (
            <div className="relative w-64 min-w-0 max-w-[50%]">
              <IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={search.inputRef}
                type="text"
                placeholder={search.placeholder}
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                className="h-8 w-full pl-8 text-xs"
              />
            </div>
          )}
          {actions}
        </div>
      </div>
      {filters && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
          {filters}
        </div>
      )}
    </>
  );
}

/** 筛选 chip（Hosts/PortForwarding 共用）：pill 选中态。 */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-medium transition-colors duration-150',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** 视图切换（网格/列表）分段控件。 */
export function ViewToggle({
  mode,
  onChange,
  gridLabel,
  listLabel,
  GridIcon,
  ListIcon,
}: {
  mode: 'grid' | 'list';
  onChange: (m: 'grid' | 'list') => void;
  gridLabel: string;
  listLabel: string;
  GridIcon: React.ComponentType<{ size?: number | string; className?: string }>;
  ListIcon: React.ComponentType<{ size?: number | string; className?: string }>;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-muted/70 p-0.5" role="group" aria-label="view">
      {(
        [
          { key: 'grid', label: gridLabel, Icon: GridIcon },
          { key: 'list', label: listLabel, Icon: ListIcon },
        ] as const
      ).map(({ key, label, Icon }) => (
        <Button
          key={key}
          variant="ghost"
          size="icon"
          className={cn(
            'size-7 rounded-full',
            mode === key && 'bg-background text-foreground shadow-xs hover:bg-background hover:text-foreground',
          )}
          onClick={() => onChange(key)}
          aria-label={label}
          aria-pressed={mode === key}
          title={label}
        >
          <Icon size={14} className="size-3.5" />
        </Button>
      ))}
    </div>
  );
}

/** 列表分组小节标题（圆点 + 名称 + 计数徽章）。 */
export function SectionHeading({
  tone,
  label,
  count,
}: {
  tone: 'success' | 'error' | 'muted';
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          tone === 'success' ? 'bg-success' : tone === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
        )}
      />
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{label}</h3>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

/** 空状态（图标 + 标题 + 描述 + 可选操作）。 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        {icon}
      </div>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** 错误状态（图标 + 标题 + 描述 + 重试）。 */
export function ErrorState({
  icon,
  title,
  description,
  retryLabel,
  onRetry,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        {icon}
      </div>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      <Button variant="secondary" className="mt-5" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

/** 管理卡片容器：收敛各页 hover 上浮 + 阴影的不一致（Hosts 上浮/Monitor 不上浮/阴影深浅不一）。
 * 统一：无位移（避免布局抖动，符合 pro-rules Stable Interaction States），
 * hover 仅描边加深 + 底色微变，过渡 150ms。 */
export function ManageCard({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-xl bg-card p-3 ring-1 ring-border/50 transition-colors duration-150 hover:bg-accent/40 hover:ring-border',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 管理卡片图标槽：32px 圆角矩形 + muted 底。 */
export function ManageCardIcon({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      {children}
    </div>
  );
}
