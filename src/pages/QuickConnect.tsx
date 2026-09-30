import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search as IconSearch,
  Server as IconServer,
  Clock as IconClock,
} from 'lucide-react';
import {
  getHosts,
  getAccounts,
  getKeys,
  getCertificates,
  type Host,
  type Account,
  type Key,
  type Certificate,
} from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { consumeQuickConnectIntent } from '../services/quickConnectIntent';
import { useTabStore, type TabType } from '../store/tabStore';
import { useActiveSshTargets } from '../hooks/useActiveSshTargets';
import { cn } from '@/lib/utils';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { message } from '@tauri-apps/plugin-dialog';
import { LocalShellChips } from './quickConnect/LocalShellChips';
import { PROTOCOL_TILES, getProtocolTile } from '../extensions/quickConnect';
import type { QuickConnectCardProps } from './quickConnect/types';

export function QuickConnect() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  // 当前展开的协议磁贴（单开；null = 全部收起）
  const [openProtocol, setOpenProtocol] = useState<string | null>(null);
  // 外部「串口终端」快捷入口定位：展开串口卡并短暂高亮
  const expandedRef = useRef<HTMLDivElement>(null);
  const [serialHighlight, setSerialHighlight] = useState(false);
  const { createTab, closeTab, activeTabId } = useTabStore();
  const { t } = useTranslation();

  // 消费一次性意图（Hosts 页点「串口终端」）：展开串口磁贴 + 滚动 + 高亮
  useEffect(() => {
    if (consumeQuickConnectIntent() !== 'serial') return;
    setOpenProtocol('serial');
    setSerialHighlight(true);
    const timer = window.setTimeout(() => setSerialHighlight(false), 1800);
    requestAnimationFrame(() => {
      expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const withTimeout = <T,>(p: Promise<T>, fallback: T, ms = 15000): Promise<T> =>
      Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
    const loadHosts = async () => {
      const [hostList, accountList, keyList, certList] = await Promise.all([
        withTimeout(getHosts().catch(() => [] as Host[]), [] as Host[]),
        withTimeout(getAccounts().catch(() => [] as Account[]), [] as Account[]),
        withTimeout(getKeys().catch(() => [] as Key[]), [] as Key[]),
        withTimeout(getCertificates().catch(() => [] as Certificate[]), [] as Certificate[]),
      ]);
      if (cancelled) return;
      setHosts(hostList);
      setAccounts(accountList);
      setKeys(keyList);
      setCerts(certList);
    };
    loadHosts().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 打开连接标签并关闭当前快速连接标签。 */
  const openSessionTab = (name: string, type: TabType, config: Record<string, unknown>) => {
    createTab({ name, type, ...config } as Parameters<typeof createTab>[0]);
    if (activeTabId) closeTab(activeTabId);
  };

  const handleConnectHost = async (host: Host) => {
    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    if (auth.error) {
      await message(auth.error, { title: t('quickConnect.cannotConnect'), kind: 'warning' });
      return;
    }
    openSessionTab(host.name, 'terminal', {
      sshConfig: {
        host: host.host,
        port: host.port,
        username: auth.username,
        auth_type: auth.authType,
        password: auth.password,
        key_id: auth.authType === 'key' ? auth.keyId : undefined,
        cert_id: auth.authType === 'certificate' ? auth.certId : undefined,
        passphrase: undefined,
        hostId: host.id,
      },
    });
  };

  // 过滤 + 按最近连接时间排序（最近连接来自 DB last_connected）
  // 在线状态与主机页同源：直接从标签树派生（有活动 SSH 标签即在线，关标签即回落）
  const { byHostId, byAddr } = useActiveSshTargets();
  const filteredHosts = hosts
    .filter(
      (host) =>
        host.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        host.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
        host.username.toLowerCase().includes(searchQuery.toLowerCase()),
    )
    .map(
      (host): Host =>
        (byHostId.has(host.id) || byAddr.has(`${host.host}:${host.port}`)) &&
        host.status !== 'connected'
          ? { ...host, status: 'connected' }
          : host,
    );
  const recentHosts = [...filteredHosts].sort((a, b) => {
    if (!a.lastConnected && !b.lastConnected) return 0;
    if (!a.lastConnected) return 1;
    if (!b.lastConnected) return -1;
    return new Date(b.lastConnected).getTime() - new Date(a.lastConnected).getTime();
  });

  /** 状态小圆点（比徽章更紧凑）。 */
  const StatusDot = ({ status }: { status: Host['status'] }) => {
    const color =
      status === 'connected'
        ? 'bg-success'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40';
    return <span className={cn('size-1.5 shrink-0 rounded-full', color)} />;
  };

  const formatLastConnected = (lastConnected?: string) => {
    if (!lastConnected) return t('quickConnect.disconnected');
    return new Date(lastConnected).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const openTile = (openProtocol ? getProtocolTile(openProtocol) : undefined) ?? null;
  const cardProps: QuickConnectCardProps = {
    onOpenSession: openSessionTab,
    hosts,
    accounts,
    keys,
    certs,
    highlight: serialHighlight,
  };

  return (
    <div className="flex h-full flex-col">
      {/* 页头：标题 + 搜索 */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <h2 className="text-xl font-semibold tracking-tight">{t('quickConnect.title')}</h2>
        <div className="relative w-80 max-w-[50%]">
          <IconSearch
            size="16"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            placeholder={t('quickConnect.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
      </div>

      <div className="shrink-0 border-b border-border pb-4">
        {/* 本地终端：一键 chips（点击直接打开对应 shell） */}
        <LocalShellChips onOpenSession={openSessionTab} />

        {/* 远程协议磁贴：点选展开表单（单开），收起时只占两行高度 */}
        <div className="px-6 pt-1">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            {t('quickConnect.protocolsSection')}
          </p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
            {PROTOCOL_TILES.map((tile) => {
              const active = openProtocol === tile.id;
              const Icon = tile.icon;
              return (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => setOpenProtocol(active ? null : tile.id)}
                  className={cn(
                    'group flex flex-col gap-1 rounded-lg p-3 text-left transition-all',
                    active
                      ? 'bg-primary/10 ring-1 ring-inset ring-primary/35 shadow-[inset_0_1px_0_0_color-mix(in_oklab,var(--primary)_18%,transparent)]'
                      : 'bg-card hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon size={15} className={cn(active ? 'text-primary' : 'text-muted-foreground')} />
                    {t(tile.titleKey)}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {t(tile.descKey)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 展开的协议表单（单开） */}
          {openTile && (() => {
            const OpenIcon = openTile.icon;
            const OpenComponent = openTile.Component;
            return (
              <div
                ref={expandedRef}
                className={cn(
                  'mt-3 rounded-lg bg-card p-3 ring-1 ring-border/60',
                  openTile.id === 'serial' && serialHighlight
                    ? 'ring-2 ring-primary/40' : ''
                )}
              >
                <div className="mb-2.5 flex items-center gap-1.5 text-sm font-medium">
                  <OpenIcon size={15} className="text-primary" />
                  {t(openTile.titleKey)}
                </div>
                <OpenComponent {...cardProps} />
              </div>
            );
          })()}
        </div>
      </div>

      {/* 主机列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {recentHosts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <IconServer size={48} strokeWidth={1.5} className="mb-4 opacity-50" />
            <p className="text-lg">{t('quickConnect.noHosts')}</p>
            <p className="mt-2 text-sm">{t('quickConnect.noHostsDesc')}</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <IconClock size={16} />
              <span>{t('quickConnect.recent')}</span>
              <span className="text-xs text-muted-foreground/60">({recentHosts.length})</span>
            </div>
            <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[36%]">{t('quickConnect.tableHost')}</TableHead>
                    <TableHead className="w-[32%]">{t('quickConnect.tableAddress')}</TableHead>
                    <TableHead className="w-[20%]">{t('quickConnect.tableLastConnected')}</TableHead>
                    <TableHead className="w-[12%] text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentHosts.map((host) => (
                    <TableRow key={host.id}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            <IconServer size={15} />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{host.name}</div>
                            <div className="truncate font-mono text-xs text-muted-foreground">
                              {host.username}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-sm">
                            {host.host}:{host.port}
                          </span>
                          <StatusDot status={host.status} />
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatLastConnected(host.lastConnected)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => handleConnectHost(host)}>
                          {t('quickConnect.connect')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
