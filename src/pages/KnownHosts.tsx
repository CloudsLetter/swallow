import { useState, useEffect, useRef } from 'react';
import { copyText } from '../lib/clipboard';
import { useTranslation } from 'react-i18next';
import { useUiPage } from '../store/uiPage';
import {
  Trash2 as IconTrash,
  ShieldCheck as IconShield,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  Copy as IconCopy,
  Check as IconCheck,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import {
  clearKnownHosts,
  getKnownHosts,
  refreshKnownHosts,
  removeKnownHost,
  type KnownHost,
} from '../services/dataService';
import { Button } from '../components/ui/button';
import { CategoryTransferButtons } from '../components/CategoryTransfer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Skeleton } from '../components/ui/skeleton';
import { CardGridSkeleton, ListTableSkeleton } from '../components/ui/listSkeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  EmptyState,
  ErrorState,
  ManageCard,
  ManageCardIcon,
  PageHeader,
  SectionHeading,
  ViewToggle,
} from '../components/PageHeader';
import { message, ask } from '@tauri-apps/plugin-dialog';

type ViewMode = 'grid' | 'list';

/** 加密算法短名：ssh-ed25519 → ED25519（仅展示用） */
const formatKeyType = (keyType: string) => keyType.replace(/^ssh-/, '').toUpperCase();

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
  // Home 页面 keep-alive：每次切换到本页（或从会话标签切回本页）自动刷新列表。
  // 已有数据时静默刷新（不重放骨架屏）；仅首次进入/无数据时显示骨架。
  const homePage = useUiPage((s) => s.homePage);
  const isPageActive = homePage === 'knownhosts';

  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  useEffect(() => {
    if (isPageActive) {
      setError(null);
      const silent = hostsRef.current.length > 0;
      if (!silent) setLoading(true);
      refreshKnownHosts()
        .then((list) => setHosts(list))
        .catch((refreshError) => {
          console.error('Failed to auto-refresh known hosts:', refreshError);
          setError(t('knownHosts.refreshFailed'));
        })
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPageActive]);

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

  // 导出（OpenSSH 文本）与导入统一由 <CategoryTransferButtons> 承担

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
      await copyText(host.fingerprint);
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
      await copyText(detailHost.rawLine);
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
      <ManageCard key={host.id} onClick={() => openDetail(host)}>
        <ManageCardIcon>
          <IconShield size={15} strokeWidth={2} aria-hidden="true" />
        </ManageCardIcon>
        <div className="min-w-0 flex-1">
          {/* 主机地址独占一行，不被协议徽章挤掉 */}
          <span
            className="block truncate font-mono text-sm font-medium text-foreground"
            title={host.host}
          >
            {host.host}
          </span>
          <div
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={host.fingerprint || undefined}
          >
            {host.fingerprint || '—'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            className="size-8"
            onClick={() => void handleCopyFingerprint(host)}
            title={t('knownHosts.copyFingerprint')}
            aria-label={`${t('knownHosts.copyFingerprint')} ${host.host}`}
          >
            {copiedId === host.id ? <IconCheck size={14} strokeWidth={2} aria-hidden="true" /> : <IconCopy size={14} strokeWidth={2} aria-hidden="true" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={`${t('common.moreActions')} ${host.host}`}>
                <IconMore size={14} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleDelete(host)}>
                <IconTrash size={15} className="mr-2" aria-hidden="true" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ManageCard>
    );
  };

  const renderHostRow = (host: KnownHost) => (
    <TableRow
      key={host.id}
      className="cursor-pointer transition-colors hover:bg-accent/40"
      onClick={() => openDetail(host)}
    >
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <ManageCardIcon>
            <IconShield size={15} strokeWidth={2} aria-hidden="true" />
          </ManageCardIcon>
          <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">{host.host}</span>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="font-mono text-xs uppercase tracking-wider text-primary/80">{formatKeyType(host.keyType)}</span>
      </TableCell>
      <TableCell className="max-w-0">
        <code className="block truncate font-mono text-xs text-muted-foreground">{host.fingerprint}</code>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">{host.lastUsed}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="secondary"
            size="icon"
            className="size-7"
            onClick={() => void handleCopyFingerprint(host)}
            title={t('knownHosts.copyFingerprint')}
            aria-label={`${t('knownHosts.copyFingerprint')} ${host.host}`}
          >
            {copiedId === host.id ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-7"
                aria-label={`${t('common.moreActions')} ${host.host}`}
              >
                <IconMore size={15} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleDelete(host)}>
                <IconTrash size={15} className="mr-2" aria-hidden="true" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );

  const renderLoading = () => (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="size-1.5 rounded-full" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-7 rounded-full" />
        </div>
        {viewMode === 'grid' ? (
          <CardGridSkeleton />
        ) : (
          <ListTableSkeleton
            colCount={5}
            head={
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-[30%] min-w-[220px]">{t('knownHosts.tableHost')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('knownHosts.tableKeyType')}</TableHead>
                    <TableHead>{t('knownHosts.tableFingerprint')}</TableHead>
                    <TableHead>{t('knownHosts.tableLastUsed')}</TableHead>
                    <TableHead className="w-24 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            }
          />
        )}
      </section>
    </div>
  );

  const renderEmpty = () => (
    <EmptyState
      icon={<IconShield size={24} strokeWidth={1.5} aria-hidden="true" />}
      title={searchTerm ? t('knownHosts.emptySearch') : t('knownHosts.emptyNone')}
      description={
        searchTerm ? t('knownHosts.emptySearchDesc', { query: searchTerm }) : t('knownHosts.emptyNoneDesc')
      }
    />
  );

  const renderError = () => (
    <ErrorState
      icon={<IconAlert size={24} strokeWidth={1.5} aria-hidden="true" />}
      title={t('common.loadFailed')}
      description={error || t('knownHosts.loadFailedDesc')}
      retryLabel={t('common.retry')}
      onRetry={() => void loadKnownHosts()}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('knownHosts.title')}
        subtitle={t('knownHosts.hostCount', { count: filteredHosts.length })}
        search={{
          value: searchTerm,
          onChange: setSearchTerm,
          placeholder: t('knownHosts.searchPlaceholder'),
          inputRef: searchRef,
        }}
        actions={
          <>
            <ViewToggle
              mode={viewMode}
              onChange={setViewMode}
              gridLabel={t('common.gridView')}
              listLabel={t('common.listView')}
              GridIcon={IconLayoutGrid}
              ListIcon={IconList}
            />
            <Button variant="ghost" size="icon" onClick={() => void handleRefreshFile()} aria-label={t('common.refresh')} title={t('knownHosts.refreshFileTitle')}>
              <IconRefresh size={15} aria-hidden="true" />
            </Button>
            <CategoryTransferButtons
              category="knownHosts"
              label={t('menu.knownHosts')}
              defaultFileName="known_hosts"
              onImported={loadKnownHosts}
            />
            <Button variant="destructive" onClick={() => void handleDeleteAll()} disabled={hosts.length === 0} title={t('knownHosts.clearAllTitle')}>
              <IconTrash size={15} strokeWidth={2} aria-hidden="true" />
              {t('knownHosts.clear')}
            </Button>
          </>
        }
      />

      {/* ===== 安全提示 ===== */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/5 px-5 py-2 text-xs text-warning">
        <IconAlert size={14} className="shrink-0" aria-hidden="true" />
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
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <SectionHeading
                  tone="muted"
                  label={group.key.replace('ssh-', '').toUpperCase()}
                  count={group.items.length}
                />
                {viewMode === 'list' ? (
                  <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[30%] min-w-[220px]">{t('knownHosts.tableHost')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('knownHosts.tableKeyType')}</TableHead>
                          <TableHead>{t('knownHosts.tableFingerprint')}</TableHead>
                          <TableHead>{t('knownHosts.tableLastUsed')}</TableHead>
                          <TableHead className="w-24 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((host) => renderHostRow(host))}</TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))' }}>
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
              <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-4">
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('knownHosts.basicInfo')}</div>
                  <div className="text-xs text-muted-foreground">{t('knownHosts.basicInfoDesc')}</div>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-2.5 text-xs">
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.tableHost')}</div>
                    <div className="mt-0.5 truncate font-mono text-foreground">{detailHost.host}</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('knownHosts.tableKeyType')}</div>
                    <div className="mt-0.5 truncate font-mono text-foreground">{detailHost.keyType}</div>
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
              <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-4">
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
