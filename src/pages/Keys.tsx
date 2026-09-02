import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import {
  createKeyPair,
  exportKeyFile,
  exportKeyFileTo,
  getKeys,
  importKeyFile,
  importKeyText,
  readKeyContent,
  removeKey,
  getAccounts,
  getHosts,
  type Key,
  type KeyContent,
} from '../services/dataService';
import {
  Key as IconKey,
  Plus as IconPlus,
  Upload as IconExport,
  Download as IconImport,
  Trash2 as IconTrash,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  Eye as IconEye,
  EyeOff as IconEyeOff,
  Copy as IconCopy,
  Check as IconCheck,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { message, ask, save } from '@tauri-apps/plugin-dialog';

type ViewMode = 'grid' | 'list';
type ActionMode = 'create' | 'import' | null;
type TypeFilter = 'all' | Key['type'];
type ImportMethod = 'file' | 'text';

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border bg-card p-4';

const keyTypeBadge = (type: Key['type']) => {
  const map: Record<Key['type'], string> = {
    RSA: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    ED25519: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    ECDSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };
  return <Badge variant="outline" className={cn('font-normal', map[type])}>{type}</Badge>;
};

const sourceLabel = (source?: string) =>
  source === 'generated'
    ? i18n.t('keys.sourceGenerated')
    : source === 'imported'
      ? i18n.t('keys.sourceImported')
      : i18n.t('keys.sourceRecord');

const filterChips: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'RSA', label: 'RSA' },
  { key: 'ED25519', label: 'ED25519' },
  { key: 'ECDSA', label: 'ECDSA' },
];

/** 类型 → 默认密钥长度 */
const DEFAULT_SIZE: Record<Key['type'], string> = {
  RSA: '2048',
  ED25519: '256',
  ECDSA: '256',
};

const readFileAsBase64 = async (file: File | null): Promise<string | undefined> => {
  if (!file) return undefined;
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
};

export function Keys() {
  const { t } = useTranslation();

  // ============ 数据状态 ============
  const [keys, setKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ============ 详情抽屉状态 ============
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<Key | null>(null);
  const [detailContent, setDetailContent] = useState<KeyContent | null>(null);
  const [showPrivate, setShowPrivate] = useState(false);
  const [copiedPub, setCopiedPub] = useState(false);

  // ============ 表单状态 ============
  const [name, setName] = useState('');
  const [keyType, setKeyType] = useState<Key['type']>('RSA');
  const [keySize, setKeySize] = useState('2048');
  const [passphrase, setPassphrase] = useState('');
  const [privateFile, setPrivateFile] = useState<File | null>(null);
  const [publicFile, setPublicFile] = useState<File | null>(null);
  const [importMethod, setImportMethod] = useState<ImportMethod>('file');
  const [privateText, setPrivateText] = useState('');
  const [publicText, setPublicText] = useState('');

  useEffect(() => {
    void loadKeys();
  }, []);

  // ============ 键盘快捷键 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await getKeys());
    } catch (loadError) {
      console.error('Failed to load keys:', loadError);
      setError(t('keys.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  // ============ 表单逻辑 ============
  const openDrawer = (mode: Exclude<ActionMode, null>) => {
    setActionMode(mode);
    setName('');
    setKeyType('RSA');
    setKeySize('2048');
    setPassphrase('');
    setPrivateFile(null);
    setPublicFile(null);
    setImportMethod('file');
    setPrivateText('');
    setPublicText('');
    setSheetOpen(true);
  };

  const handleTypeChange = (type: Key['type']) => {
    setKeyType(type);
    // 密钥长度跟随类型联动（ED25519/ECDSA 固定 256）
    setKeySize(DEFAULT_SIZE[type]);
  };

  const isFormValid = (() => {
    if (!name.trim()) return false;
    if (actionMode === 'create') return true;
    if (actionMode === 'import') {
      return importMethod === 'file'
        ? Boolean(privateFile || publicFile)
        : Boolean(privateText.trim() || publicText.trim());
    }
    return false;
  })();

  const handleSave = async () => {
    const nextName = name.trim();
    if (!nextName) {
      await message(t('keys.formNameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (actionMode === 'import') {
      if (importMethod === 'file' && !privateFile && !publicFile) {
        await message(t('keys.formFileRequired'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
      if (importMethod === 'text' && !privateText.trim() && !publicText.trim()) {
        await message(t('keys.formTextRequired'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
    }

    try {
      if (actionMode === 'create') {
        await createKeyPair({
          name: nextName,
          type: keyType,
          size: parseInt(keySize),
          passphrase: passphrase || undefined,
        });
      }
      if (actionMode === 'import') {
        if (importMethod === 'file') {
          await importKeyFile({
            name: nextName,
            privateKeyBase64: await readFileAsBase64(privateFile),
            publicKeyBase64: await readFileAsBase64(publicFile),
            privateFileName: privateFile?.name,
            publicFileName: publicFile?.name,
          });
        } else {
          await importKeyText({
            name: nextName,
            privateKey: privateText.trim() || undefined,
            publicKey: publicText.trim() || undefined,
          });
        }
      }
      setSheetOpen(false);
      setActionMode(null);
      await loadKeys();
    } catch (saveError) {
      console.error('Failed to save key:', saveError);
      await message(t('keys.saveFailed', { message: String(saveError) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleRemove = async (key: Key) => {
    // 引用检查：被账号或主机绑定的密钥删除前需明确告知影响
    let refNote = '';
    try {
      const [accountList, hostList] = await Promise.all([getAccounts(), getHosts()]);
      const refs = [
        ...accountList.filter((account) => account.keyId === key.id).map((account) => t('keys.refAccount', { name: account.name })),
        ...hostList
          .filter((host) => host.keyId === key.id || host.proxyKeyId === key.id)
          .map((host) => t('keys.refHost', { name: host.name })),
      ];
      if (refs.length) {
        refNote = t('keys.refNote', { refs: refs.join('、') });
      }
    } catch {
      // 引用检查失败不阻塞删除流程
    }

    const confirmed = await ask(`${refNote}${t('keys.deleteConfirmBody', { name: key.name })}`, { title: t('common.deleteConfirm'), kind: 'warning' });
    if (!confirmed) {
      return;
    }
    try {
      await removeKey(key.id);
      await loadKeys();
    } catch (removeError) {
      console.error('Failed to remove key:', removeError);
      await message(t('common.deleteFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleExport = async (key: Key) => {
    try {
      const exported = await exportKeyFile(key.id);
      const target = await save({
        title: t('keys.exportTitle'),
        defaultPath: exported.fileName,
      });
      if (!target) return;
      await exportKeyFileTo(key.id, target);
    } catch (exportError) {
      console.error('Failed to export key:', exportError);
      await message(t('keys.exportFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const openDetail = async (key: Key) => {
    setDetailKey(key);
    setDetailContent(null);
    setShowPrivate(false);
    setCopiedPub(false);
    setDetailOpen(true);
    try {
      setDetailContent(await readKeyContent(key.id));
    } catch (detailError) {
      console.error('Failed to read key content:', detailError);
    }
  };

  const copyPublicKey = async () => {
    if (!detailContent?.publicKey) return;
    await navigator.clipboard.writeText(detailContent.publicKey);
    setCopiedPub(true);
    setTimeout(() => setCopiedPub(false), 1500);
  };

  // ============ 派生数据 ============
  const filteredKeys = keys.filter((key) => {
    if (typeFilter !== 'all' && key.type !== typeFilter) return false;
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      key.name.toLowerCase().includes(query) ||
      key.type.toLowerCase().includes(query) ||
      key.fingerprint.toLowerCase().includes(query)
    );
  });

  const groups: { key: Key['type']; label: string; items: Key[] }[] = (
    [
      { key: 'ED25519', label: 'ED25519', items: [] },
      { key: 'RSA', label: 'RSA', items: [] },
      { key: 'ECDSA', label: 'ECDSA', items: [] },
    ] as { key: Key['type']; label: string; items: Key[] }[]
  )
    .map((group) => ({ ...group, items: filteredKeys.filter((key) => key.type === group.key) }))
    .filter((group) => group.items.length > 0);

  const fieldLabel = (children: React.ReactNode) => <Label className="mb-1.5 block text-xs font-medium">{children}</Label>;
  const fieldHint = (children: React.ReactNode) => <p className="mt-2 text-xs text-muted-foreground">{children}</p>;

  const renderKeyCard = (key: Key) => {
    return (
      <div
        key={key.id}
        className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
        onClick={() => void openDetail(key)}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <IconKey size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{key.name}</span>
            {keyTypeBadge(key.type)}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={key.fingerprint || undefined}>
            {key.fingerprint || `${key.size} bits · ${sourceLabel(key.source)}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            className="size-8"
            onClick={() => void openDetail(key)}
            title={t('keys.viewDetails')}
            aria-label={t('keys.view')}
          >
            <IconEye size={14} strokeWidth={2} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void handleExport(key)}>
                <IconExport size={15} className="mr-2" /> {t('keys.export')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(key)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderKeyRow = (key: Key) => (
    <TableRow
      key={key.id}
      className="group cursor-pointer transition-colors hover:bg-accent/40"
      onClick={() => void openDetail(key)}
    >
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <IconKey size={15} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{key.name}</span>
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{key.fingerprint || '—'}</span>
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{keyTypeBadge(key.type)}</TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{key.size} bits</TableCell>
      <TableCell className="text-sm text-muted-foreground">{sourceLabel(key.source)}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{t('common.database')}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void openDetail(key)}
            title={t('keys.viewDetails')}
          >
            <IconEye size={14} strokeWidth={2} /> {t('keys.view')}
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
              <DropdownMenuItem onClick={() => void handleExport(key)}>
                <IconExport size={15} className="mr-2" /> {t('keys.export')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(key)}>
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
        <IconKey size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">
        {searchQuery || typeFilter !== 'all' ? t('keys.emptySearch') : t('keys.emptyNone')}
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchQuery || typeFilter !== 'all'
          ? t('keys.emptySearchDesc', { query: searchQuery || t('common.currentFilter') })
          : t('keys.emptyNoneDesc')}
      </p>
      {!(searchQuery || typeFilter !== 'all') && (
        <div className="mt-6 flex items-center gap-2">
          <Button variant="secondary" onClick={() => openDrawer('import')}>
            <IconImport size={16} /> {t('keys.import')}
          </Button>
          <Button onClick={() => openDrawer('create')}>
            <IconPlus size={16} /> {t('keys.createKey')}
          </Button>
        </div>
      )}
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <IconAlert size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('keys.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-6" onClick={() => void loadKeys()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('keys.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('keys.keyCount', { count: filteredKeys.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('keys.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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
          <Button variant="ghost" size="icon" onClick={() => void loadKeys()} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button variant="secondary" onClick={() => openDrawer('import')} title={t('keys.importKeyFile')}>
            <IconImport size={16} strokeWidth={2} />
            {t('keys.import')}
          </Button>
          <Button onClick={() => openDrawer('create')} title={t('keys.createKey')}>
            <IconPlus size={16} strokeWidth={2} />
            {t('keys.add')}
          </Button>
        </div>
      </div>

      {/* ===== 筛选 chips ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {filterChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setTypeFilter(chip.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              typeFilter === chip.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {t(chip.label)}
          </button>
        ))}
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : error && keys.length === 0 ? (
          renderError()
        ) : filteredKeys.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{group.label}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                {viewMode === 'grid' ? (
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
                    {group.items.map((key) => renderKeyCard(key))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[40%] min-w-[240px]">{t('keys.tableKey')}</TableHead>
                          <TableHead>{t('keys.tableType')}</TableHead>
                          <TableHead>{t('keys.tableLength')}</TableHead>
                          <TableHead>{t('keys.tableSource')}</TableHead>
                          <TableHead>{t('keys.tableStorage')}</TableHead>
                          <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((key) => renderKeyRow(key))}</TableBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 创建/导入密钥抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{actionMode === 'create' ? t('keys.createKey') : t('keys.importKey')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('common.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('keys.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('common.name')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('keys.keyNamePlaceholder')}
                />
              </div>
              {actionMode === 'create' && (
                <>
                  <div>
                    {fieldLabel(
                      <>
                        {t('keys.keyTypeRequired')} <span className="text-destructive">*</span>
                      </>,
                    )}
                    <Select value={keyType} onValueChange={(v) => handleTypeChange(v as Key['type'])}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ED25519">{t('keys.keyTypeEd25519')}</SelectItem>
                        <SelectItem value="RSA">{t('keys.keyTypeRsa')}</SelectItem>
                        <SelectItem value="ECDSA">{t('keys.keyTypeEcdsa')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    {fieldLabel(
                      <>
                        {t('keys.keySizeRequired')} <span className="text-destructive">*</span>
                      </>,
                    )}
                    <Select
                      value={keySize}
                      onValueChange={setKeySize}
                      disabled={keyType !== 'RSA'}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {keyType === 'RSA' ? (
                          <>
                            <SelectItem value="2048">{t('keys.keySize2048')}</SelectItem>
                            <SelectItem value="4096">{t('keys.keySize4096')}</SelectItem>
                          </>
                        ) : (
                          <SelectItem value="256">{t('keys.keySize256', { type: keyType })}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>

            {/* 创建：口令 / 导入：文件 */}
            {actionMode === 'create' && (
              <div className={sectionClass}>
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('keys.securityOptions')}</div>
                  <div className="text-xs text-muted-foreground">{t('keys.securityOptionsDesc')}</div>
                </div>
                <div>
                  {fieldLabel(t('keys.passphrase'))}
                  <Input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder={t('keys.passphrasePlaceholder')}
                  />
                  {fieldHint(t('keys.passphraseHint'))}
                </div>
              </div>
            )}

            {actionMode === 'import' && (
              <>
                {/* 导入方式 */}
                <div className={sectionClass}>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{t('keys.importMethod')}</div>
                    <div className="text-xs text-muted-foreground">{t('keys.importMethodDesc')}</div>
                  </div>
                  <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                    <Button
                      variant="ghost"
                      className={cn(
                        'h-7 flex-1',
                        importMethod === 'file' &&
                          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                      )}
                      onClick={() => setImportMethod('file')}
                    >
                      {t('keys.importFromFile')}
                    </Button>
                    <Button
                      variant="ghost"
                      className={cn(
                        'h-7 flex-1',
                        importMethod === 'text' &&
                          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                      )}
                      onClick={() => setImportMethod('text')}
                    >
                      {t('keys.importFromText')}
                    </Button>
                  </div>
                </div>

                {/* 密钥文件 / 密钥内容 */}
                <div className={sectionClass}>
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {importMethod === 'file' ? t('keys.keyFile') : t('keys.keyContent')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {importMethod === 'file' ? t('keys.keyFileDesc') : t('keys.keyContentDesc')}
                    </div>
                  </div>
                  {importMethod === 'file' ? (
                    <>
                      <div>
                        {fieldLabel(t('keys.privateKeyFile'))}
                        <Input
                          type="file"
                          accept=".pem,.key"
                          onChange={(e) => setPrivateFile(e.target.files?.[0] ?? null)}
                        />
                      </div>
                      <div>
                        {fieldLabel(t('keys.publicKeyFile'))}
                        <Input
                          type="file"
                          accept=".pub"
                          onChange={(e) => setPublicFile(e.target.files?.[0] ?? null)}
                        />
                        {fieldHint(t('keys.fileHint'))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        {fieldLabel(t('keys.privateKeyContent'))}
                        <Textarea
                          value={privateText}
                          onChange={(e) => setPrivateText(e.target.value)}
                          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
                          className="min-h-24 font-mono text-xs"
                          spellCheck={false}
                        />
                      </div>
                      <div>
                        {fieldLabel(t('keys.publicKeyContent'))}
                        <Textarea
                          value={publicText}
                          onChange={(e) => setPublicText(e.target.value)}
                          placeholder="ssh-ed25519 AAAA... comment"
                          className="min-h-20 font-mono text-xs"
                          spellCheck={false}
                        />
                        {fieldHint(t('keys.textHint'))}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!isFormValid}>
              {actionMode === 'create' ? t('keys.createKey') : t('keys.importKey')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ===== 密钥详情抽屉 ===== */}
      <Sheet open={detailOpen} onOpenChange={(open) => !open && setDetailOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('keys.keyDetail')}</SheetTitle>
          </SheetHeader>
          {detailKey ? (
            <div className="flex flex-col gap-3.5">
              {/* 基本信息 */}
              <div className={sectionClass}>
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('common.basicInfo')}</div>
                  <div className="text-xs text-muted-foreground">{t('keys.keyMetaDesc')}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  {keyTypeBadge(detailKey.type)}
                  <Badge variant="outline" className="font-normal">
                    {sourceLabel(detailKey.source)}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-2.5 text-xs">
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.name')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailKey.name}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.length')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailKey.size} bits</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.createdAt')}</div>
                    <div className="mt-0.5 truncate text-foreground">
                      {detailKey.createdAt ? new Date(detailKey.createdAt).toLocaleString('zh-CN') : '—'}
                    </div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.fingerprint')}</div>
                    <div className="mt-0.5 break-all font-mono text-muted-foreground">{detailKey.fingerprint || '—'}</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.storageLocation')}</div>
                    <div className="mt-0.5 truncate text-foreground">{t('common.databaseNoDisk')}</div>
                  </div>
                </div>
              </div>

              {/* 公钥内容 */}
              <div className={sectionClass}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{t('keys.publicKey')}</div>
                    <div className="text-xs text-muted-foreground">{t('keys.publicKeyDesc')}</div>
                  </div>
                  {detailContent?.publicKey && (
                    <Button variant="secondary" size="sm" className="h-7" onClick={() => void copyPublicKey()}>
                      {copiedPub ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      {copiedPub ? t('common.copied') : t('common.copy')}
                    </Button>
                  )}
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground">
                  {detailContent ? detailContent.publicKey || t('keys.publicKeyPlaceholder') : t('common.loading')}
                </pre>
              </div>

              {/* 私钥内容 */}
              {detailContent?.privateKey && (
                <div className={sectionClass}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{t('common.privateKey')}</div>
                      <div className="text-xs text-muted-foreground">{t('keys.privateKeyDesc')}</div>
                    </div>
                    <Button variant="secondary" size="sm" className="h-7" onClick={() => setShowPrivate((v) => !v)}>
                      {showPrivate ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                      {showPrivate ? t('common.hide') : t('common.show')}
                    </Button>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground">
                    {showPrivate ? detailContent.privateKey : t('keys.hiddenPrivateKey')}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
