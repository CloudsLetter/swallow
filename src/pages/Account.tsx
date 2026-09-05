import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import { Pencil, Plus, Tag, Trash2, User, LayoutGrid, List, Search, RefreshCw, MoreHorizontal as IconMore } from 'lucide-react';
import { getAccounts, addAccount, removeAccount, updateAccount, getKeys, getCertificates, getHosts, type Account, type Key, type Certificate } from '../services/dataService';
import { AuthTypeIcon } from '../components/AuthTypeIcon';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { CardGridSkeleton, ListTableSkeleton } from '../components/ui/listSkeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { message, ask } from '@tauri-apps/plugin-dialog';

type ViewMode = 'grid' | 'list';

interface AccountForm {
  name: string;
  username: string;
  password: string;
  keyId: string;
  certificateId: string;
  description: string;
  tags: string;
}

const EMPTY_FORM: AccountForm = {
  name: '',
  username: '',
  password: '',
  keyId: '',
  certificateId: '',
  description: '',
  tags: '',
};

const sectionClass = 'flex flex-col gap-3 rounded-lg bg-muted/40 p-4';

function getAuthTypeText(authType: Account['authType']) {
  switch (authType) {
    case 'key':
      return i18n.t('account.authTypeKey');
    case 'certificate':
      return i18n.t('account.authTypeCertificate');
    default:
      return i18n.t('account.authTypePassword');
  }
}

const authBadge = (authType: Account['authType']) => {
  const map = {
    password: { label: i18n.t('account.authTypePassword'), cls: 'bg-info/10 text-info' },
    key: { label: i18n.t('account.authTypeKey'), cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    certificate: { label: i18n.t('account.authTypeCertificate'), cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  } as const;
  const item = map[authType];
  return <Badge variant="outline" className={cn('font-normal', item.cls)}>{item.label}</Badge>;
};

export function AccountPage() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [authType, setAuthType] = useState<Account['authType']>('password');
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const [accountList, keyList, certList] = await Promise.all([
        getAccounts(),
        getKeys().catch(() => [] as Key[]),
        getCertificates().catch(() => [] as Certificate[]),
      ]);
      setAccounts(accountList);
      setKeys(keyList);
      setCerts(certList);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingAccount(null);
    setForm(EMPTY_FORM);
    setAuthType('password');
    setSheetOpen(true);
  };

  const openEdit = (account: Account) => {
    setEditingAccount(account);
    setAuthType(account.authType);
    setForm({
      name: account.name,
      username: account.username,
      password: account.password || '',
      keyId: account.keyId || '',
      certificateId: account.certificateId || '',
      description: account.description || '',
      tags: account.tags?.join(', ') || '',
    });
    setSheetOpen(true);
  };

  const isFormValid = (() => {
    if (!form.name.trim() || !form.username.trim()) return false;
    if (authType === 'key' && !form.keyId.trim()) return false;
    if (authType === 'certificate' && !form.certificateId.trim()) return false;
    return true;
  })();

  const handleSave = async () => {
    const nextName = form.name.trim();
    const nextUsername = form.username.trim();

    if (!nextName) {
      await message(t('account.formNameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!nextUsername) {
      await message(t('account.formUsernameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (authType === 'key' && !form.keyId.trim()) {
      await message(t('account.formKeyRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (authType === 'certificate' && !form.certificateId.trim()) {
      await message(t('account.formCertRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    const accountData = {
      name: nextName,
      username: nextUsername,
      authType,
      password: authType === 'password' ? form.password || undefined : undefined,
      keyId: authType === 'key' ? form.keyId.trim() || undefined : undefined,
      certificateId: authType === 'certificate' ? form.certificateId.trim() || undefined : undefined,
      description: form.description.trim() || undefined,
      tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    };

    try {
      if (editingAccount) {
        await updateAccount(editingAccount.id, accountData);
      } else {
        await addAccount(accountData);
      }
      await loadAccounts();
      setSheetOpen(false);
      setEditingAccount(null);
    } catch (error) {
      console.error('Failed to save account:', error);
      await message(t('common.saveFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleRemove = async (account: Account) => {
    // 引用检查：被主机绑定的账号删除前需明确告知影响
    let refNote = '';
    try {
      const hostList = await getHosts();
      const refs = hostList
        .filter((host) => host.accountId === account.id)
        .map((host) => t('account.refHost', { name: host.name }));
      if (refs.length) {
        refNote = t('account.refNote', { refs: refs.join('、') });
      }
    } catch {
      // 引用检查失败不阻塞删除流程
    }

    const confirmed = await ask(refNote + t('account.deleteConfirmBody', { name: account.name }), {
      title: t('common.deleteConfirm'),
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await removeAccount(account.id);
      await loadAccounts();
    } catch (error) {
      console.error('Failed to remove account:', error);
      await message(t('common.deleteFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const filteredAccounts = accounts.filter((account) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      account.name.toLowerCase().includes(query) ||
      account.username.toLowerCase().includes(query) ||
      account.description?.toLowerCase().includes(query) ||
      account.tags?.some((tag) => tag.toLowerCase().includes(query))
    );
  });

  const fieldLabel = (children: React.ReactNode) => (
    <Label className="mb-1.5 block text-xs font-medium">{children}</Label>
  );
  const fieldHint = (children: React.ReactNode) => (
    <p className="mt-2 text-xs text-muted-foreground">{children}</p>
  );

  const renderLoading = () =>
    viewMode === 'grid' ? (
      <CardGridSkeleton />
    ) : (
      <ListTableSkeleton
        colCount={5}
        head={
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-[32%] min-w-[240px]">{t('account.tableAccount')}</TableHead>
            <TableHead>{t('account.tableAuth')}</TableHead>
            <TableHead>{t('account.tableDescription')}</TableHead>
            <TableHead>{t('account.tableTags')}</TableHead>
            <TableHead className="w-28 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        }
      />
    );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <User size={24} strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-semibold tracking-tight">{searchQuery ? t('account.emptySearch') : t('account.emptyNone')}</h3>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
        {searchQuery
          ? t('account.emptySearchDesc', { query: searchQuery })
          : t('account.emptyNoneDesc')}
      </p>
      {!searchQuery && (
        <div className="mt-5 flex items-center gap-2">
          <Button onClick={openCreate}>
            <Plus size={16} /> {t('account.createAccount')}
          </Button>
        </div>
      )}
    </div>
  );

  const renderAccountCard = (account: Account) => {
    return (
      <div
        key={account.id}
        className="group flex items-center gap-2.5 rounded-lg bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/50 hover:shadow-md"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-accent">
          <User size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{account.name}</span>
            <AuthTypeIcon authType={account.authType} title={getAuthTypeText(account.authType)} />
            {account.tags && account.tags.length > 0 && (
              <Badge variant="secondary" className="max-w-24 shrink-0 gap-1 px-1.5 py-0 text-[10px] font-normal">
                <Tag size={10} />
                <span className="truncate">{account.tags[0]}</span>
                {account.tags.length > 1 && `+${account.tags.length - 1}`}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{account.username}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => openEdit(account)}
            title={t('account.edit')}
            aria-label={t('account.edit')}
          >
            <Pencil size={14} strokeWidth={2} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-8"
                aria-label={t('common.moreActions')}
              >
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRemove(account)}>
                <Trash2 size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground">{t('account.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('account.accountCount', { count: filteredAccounts.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('account.searchPlaceholder')}
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
              <LayoutGrid size={15} />
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
              <List size={15} />
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={loadAccounts} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <RefreshCw size={16} />
          </Button>
          <Button onClick={openCreate} title={t('account.createAccount')}>
            <Plus size={16} strokeWidth={2} />
            {t('account.add')}
          </Button>
        </div>
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : filteredAccounts.length === 0 ? (
          renderEmpty()
        ) : viewMode === 'grid' ? (
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
            {filteredAccounts.map((account) => renderAccountCard(account))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border/60">
            <Table>
              <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[32%] min-w-[240px]">{t('account.tableAccount')}</TableHead>
                  <TableHead>{t('account.tableAuth')}</TableHead>
                  <TableHead>{t('account.tableDescription')}</TableHead>
                  <TableHead>{t('account.tableTags')}</TableHead>
                  <TableHead className="w-28 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((account) => (
                  <TableRow key={account.id} className="group transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
                    <TableCell className="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <User size={16} strokeWidth={2} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{account.name}</div>
                          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{account.username}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{authBadge(account.authType)}</TableCell>
                    <TableCell className="max-w-0 truncate text-sm text-muted-foreground">
                      {account.description || t('account.noDescription')}
                    </TableCell>
                    <TableCell>
                      {account.tags && account.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {account.tags.slice(0, 2).map((tag, tagIndex) => (
                            <Badge key={tagIndex} variant="secondary" className="gap-1">
                              <Tag size={12} />
                              {tag}
                            </Badge>
                          ))}
                          {account.tags.length > 2 && (
                            <span className="text-xs text-muted-foreground">+{account.tags.length - 2}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t('account.noTags')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => openEdit(account)}
                        >
                          <Pencil size={16} strokeWidth={2} />
                          {t('account.edit')}
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
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRemove(account)}>
                              <Trash2 size={15} className="mr-2" /> {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ===== 新增/编辑抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{editingAccount ? t('account.editAccount') : t('account.createAccount')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('account.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('account.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('account.accountName')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Admin Account"
                />
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('common.username')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="admin"
                />
              </div>
              <div>
                {fieldLabel(t('account.description'))}
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder={t('account.descriptionPlaceholder')}
                />
              </div>
              <div>
                {fieldLabel(t('account.tags'))}
                <Input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="production, admin"
                />
                {fieldHint(t('account.tagsHint'))}
              </div>
            </div>

            {/* 认证方式 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('account.authSection')}</div>
                <div className="text-xs text-muted-foreground">{t('account.authSectionDesc')}</div>
              </div>
              <div>
                {fieldLabel(t('account.authType'))}
                <Select value={authType} onValueChange={(v) => setAuthType(v as Account['authType'])}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">{t('account.authTypePasswordOption')}</SelectItem>
                    <SelectItem value="key">{t('account.authTypeKeyOption')}</SelectItem>
                    <SelectItem value="certificate">{t('account.authTypeCertOption')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {authType === 'password' && (
                <div>
                  {fieldLabel(t('common.password'))}
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="••••••••"
                  />
                  {fieldHint(t('account.passwordHint'))}
                </div>
              )}
              {authType === 'key' && (
                <div>
                  {fieldLabel(
                    <>
                      {t('account.sshKey')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Select value={form.keyId || undefined} onValueChange={(v) => setForm({ ...form, keyId: v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={keys.length ? t('account.selectKey') : t('account.noKeys')} />
                    </SelectTrigger>
                    <SelectContent>
                      {keys.map((key) => (
                        <SelectItem key={key.id} value={key.id}>
                          {key.name}（{key.type}）
                        </SelectItem>
                      ))}
                      {form.keyId && !keys.some((key) => key.id === form.keyId) && (
                        <SelectItem value={form.keyId}>{t('account.deletedKey', { id: form.keyId })}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {fieldHint(keys.length ? t('account.keyHint') : t('account.keyHintNoKeys'))}
                </div>
              )}
              {authType === 'certificate' && (
                <div>
                  {fieldLabel(
                    <>
                      {t('account.cert')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Select value={form.certificateId || undefined} onValueChange={(v) => setForm({ ...form, certificateId: v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={certs.length ? t('account.selectCert') : t('account.noCerts')} />
                    </SelectTrigger>
                    <SelectContent>
                      {certs.map((cert) => (
                        <SelectItem key={cert.id} value={cert.id}>
                          {cert.name}（{t(cert.certType === 'host' ? 'account.certHost' : 'account.certUser')}{t('account.cert')}）
                        </SelectItem>
                      ))}
                      {form.certificateId && !certs.some((cert) => cert.id === form.certificateId) && (
                        <SelectItem value={form.certificateId}>{t('account.deletedCert', { id: form.certificateId })}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {fieldHint(certs.length ? t('account.certHint') : t('account.certHintNoCerts'))}
                </div>
              )}
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!isFormValid}>
              {editingAccount ? t('account.saveChanges') : t('account.addAccount')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
