import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Trash2 as IconTrash,
  ShieldCheck as IconShield,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  Copy as IconCopy,
  Check as IconCheck,
  Upload as IconExport,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import {
  clearKnownHosts,
  exportKnownHostsTo,
  getKnownHosts,
  refreshKnownHosts,
  removeKnownHost,
  type KnownHost,
} from '../services/dataService';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Skeleton } from '../components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { message, ask, save } from '@tauri-apps/plugin-dialog';

type ViewMode = 'grid' | 'list';

const keyTypeBadgeCls = (keyType: string) => {
  const map: Record<string, string> = {
    'ssh-ed25519': 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    ED25519: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    'ssh-rsa': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    RSA: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    ECDSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };
  return map[keyType] || 'bg-muted text-muted-foreground';
};

const keyTypeBadge = (keyType: string) => (
  <Badge variant="outline" className={cn('font-normal', keyTypeBadgeCls(keyType))}>
    {keyType.replace('ssh-', '').toUpperCase()}
  </Badge>
);

export function KnownHosts() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [detailHost, setDetailHost] = useState<KnownHost | null>(null);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadKnownHosts();
  }, []);

  // ============ 键盘快捷键 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        setSearchTerm('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadKnownHosts = async () => {
    setLoading(true);
    setError(null);
    try {
      setHosts(await getKnownHosts());
    } catch (loadError) {
      console.error('Failed to load known hosts:', loadError);
      setError(t('knownHosts.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  // ============ 操作逻辑 ============
  const handleDelete = async (host: KnownHost) => {
    const confirmed = await ask(t('knownHosts.deleteConfirmBody', { host: host.host }), {
      title: t('common.deleteConfirm'),
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await removeKnownHost(host.id);
      await loadKnownHosts();
    } catch (removeError) {
      console.error('Failed to delete known host:', removeError);
      await message(t('common.deleteFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleDeleteAll = async () => {
    const confirmed = await ask(t('knownHosts.clearConfirmBody', { count: hosts.length }), {
      title: t('common.clearConfirm'),
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await clearKnownHosts();
      await loadKnownHosts();
    } catch (clearError) {
      console.error('Failed to clear known hosts:', clearError);
      await message(t('knownHosts.clearFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleExport = async () => {
    try {
      const target = await save({
        title: t('knownHosts.exportTitle'),
        defaultPath: 'known_hosts',
      });
      if (!target) return;
      await exportKnownHostsTo(target);
    } catch (exportError) {
      console.error('Failed to export known hosts:', exportError);
      await message(t('knownHosts.exportFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleRefreshFile = async () => {
    setLoading(true);
    setError(null);
    try {
      setHosts(await refreshKnownHosts());
    } catch (refreshError) {
      console.error('Failed to refresh known hosts:', refreshError);
      setError(t('knownHosts.refreshFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyFingerprint = async (host: KnownHost) => {
    try {
      await navigator.clipboard.writeText(host.fingerprint);
      setCopiedId(host.id);
      window.setTimeout(() => setCopiedId((current) => (current === host.id ? null : current)), 1500);
    } catch (copyError) {
      console.error('Failed to copy fingerprint:', copyError);
      await message(t('knownHosts.copyFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const openDetail = (host: KnownHost) => {
    setCopiedRaw(false);
    setDetailHost(host);
  };

  const handleCopyRawLine = async () => {
    if (!detailHost?.rawLine) return;
    try {
      await navigator.clipboard.writeText(detailHost.rawLine);
      setCopiedRaw(true);
      window.setTimeout(() => setCopiedRaw(false), 1500);
    } catch (copyError) {
      console.error('Failed to copy raw line:', copyError);
      await message(t('knownHosts.copyFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  // ============ 派生数据 ============
  const filteredHosts = hosts.filter(
    (host) =>
      host.host.toLowerCase().includes(searchTerm.toLowerCase()) ||
      host.fingerprint.toLowerCase().includes(searchTerm.toLowerCase()) ||
      host.keyType.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const groups = [...new Set(filteredHosts.map((host) => host.keyType))]
    .sort((a, b) => a.localeCompare(b))
    .map((keyType) => ({
      key: keyType,
      items: filteredHosts.filter((host) => host.keyType === keyType),
    }));

  const renderHostCard = (host: KnownHost) => {
    return (
      <div
        key={host.id}
        className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
        onClick={() => openDetail(host)}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <IconShield size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-sm font-medium text-foreground">{host.host}</span>
            {keyTypeBadge(host.keyType)}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={host.fingerprint || undefined}>
            {host.fingerprint || '—'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            className="size-8"
            onClick={() => void handleCopyFingerprint(host)}
            title={t('knownHosts.copyFingerprint')}
            aria-label={t('knownHosts.copyFingerprint')}
          >
            {copiedId === host.id ? <IconCheck size={14} strokeWidth={2} /> : <IconCopy size={14} strokeWidth={2} />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleDelete(host)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderHostRow = (host: KnownHost) => (
    <TableRow
      key={host.id}
      className="group cursor-pointer transition-colors hover:bg-accent/40"
      onClick={() => openDetail(host)}
    >
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <IconShield size={15} strokeWidth={2} />
          </div>
          <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">{host.host}</span>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{keyTypeBadge(host.keyType)}</TableCell>
      <TableCell className="max-w-0">
        <code className="block truncate font-mono text-xs text-muted-foreground">{host.fingerprint}</code>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{host.lastUsed}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="secondary"
            size="icon"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void handleCopyFingerprint(host)}
            title={t('knownHosts.copyFingerprint')}
          >
            {copiedId === host.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('common.moreActions')}
              >
                <IconMore size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleDelete(host)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );

  const renderLoading = () => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="gap-0 p-0">
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconShield size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{searchTerm ? t('knownHosts.emptySearch') : t('knownHosts.emptyNone')}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchTerm
          ? t('knownHosts.emptySearchDesc', { query: searchTerm })
          : t('knownHosts.emptyNoneDesc')}
      </p>
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <IconAlert size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('knownHosts.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-6" onClick={() => void loadKnownHosts()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('knownHosts.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('knownHosts.hostCount', { count: filteredHosts.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('knownHosts.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg pl-8"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7',
                viewMode === 'grid' && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
              )}
              onClick={() => setViewMode('grid')}
              aria-label={t('common.gridView')}
              title={t('common.gridView')}
            >
              <IconLayoutGrid size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7',
                viewMode === 'list' && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
              )}
              onClick={() => setViewMode('list')}
              aria-label={t('common.listView')}
              title={t('common.listView')}
            >
              <IconList size={15} />
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void handleRefreshFile()} aria-label={t('common.refresh')} title={t('knownHosts.refreshFileTitle')}>
            <IconRefresh size={16} />
          </Button>
          <Button variant="secondary" onClick={() => void handleExport()} disabled={hosts.length === 0} title={t('knownHosts.exportFileTitle')}>
            <IconExport size={16} strokeWidth={2} />
            {t('knownHosts.export')}
          </Button>
          <Button variant="destructive" onClick={() => void handleDeleteAll()} disabled={hosts.length === 0} title={t('knownHosts.clearAllTitle')}>
            <IconTrash size={16} strokeWidth={2} />
            {t('knownHosts.clear')}
          </Button>
        </div>
      </div>

      {/* ===== 安全提示 ===== */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/5 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
        <IconAlert size={14} className="shrink-0" />
        {t('knownHosts.safetyNote')}
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : error && hosts.length === 0 ? (
          renderError()
        ) : filteredHosts.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground">
                    {group.key.replace('ssh-', '').toUpperCase()}
                  </h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                {viewMode === 'list' ? (
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[30%] min-w-[220px]">{t('knownHosts.tableHost')}</TableHead>
                          <TableHead>{t('knownHosts.tableKeyType')}</TableHead>
                          <TableHead>{t('knownHosts.tableFingerprint')}</TableHead>
                          <TableHead>{t('knownHosts.tableLastUsed')}</TableHead>
                          <TableHead className="w-24 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((host) => renderHostRow(host))}</TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
                    {group.items.map((host) => renderHostCard(host))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 已知主机详情抽屉 ===== */}
      <Sheet open={!!detailHost} onOpenChange={(open) => !open && setDetailHost(null)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('knownHosts.hostDetail')}</SheetTitle>
          </SheetHeader>
          {detailHost ? (
            <div className="flex flex-col gap-3.5">
              {/* 基本信息 */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('knownHosts.basicInfo')}</div>
                  <div className="text-xs text-muted-foreground">{t('knownHosts.basicInfoDesc')}</div>
                </div>
                <div className="flex items-center gap-1.5">{keyTypeBadge(detailHost.keyType)}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-2.5 text-xs">
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.tableHost')}</div>
                    <div className="mt-0.5 truncate font-mono text-foreground">{detailHost.host}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.metaAddedAt')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailHost.addedDate || '—'}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.metaLastUsed')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailHost.lastUsed || '—'}</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.tableFingerprint')}</div>
                    <div className="mt-0.5 break-all font-mono text-muted-foreground">{detailHost.fingerprint || '—'}</div>
                  </div>
                </div>
              </div>

              {/* 原始条目 */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{t('knownHosts.rawEntry')}</div>
                    <div className="text-xs text-muted-foreground">{t('knownHosts.rawEntryDesc')}</div>
                  </div>
                  <Button variant="secondary" size="sm" className="h-7" onClick={() => void handleCopyRawLine()}>
                    {copiedRaw ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    {copiedRaw ? t('knownHosts.copied') : t('knownHosts.copy')}
                  </Button>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground">
                  {detailHost.rawLine || t('knownHosts.noRawEntry')}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
