import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import { FileBadge, Search, RefreshCw, Trash2, Upload as Export, Download as Import, LayoutGrid, List, Eye, EyeOff, MoreHorizontal as IconMore } from 'lucide-react';
import {
  getCertificates,
  importCertificate,
  removeCertificate,
  exportCertificateFile,
  exportCertificateFileTo,
  readCertificateContent,
  getAccounts,
  getHosts,
  type Certificate,
  type ImportCertRequest,
  type CertContent,
} from '../services/dataService';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
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

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border bg-card p-4';

const keyTypeBadge = (type: string) => {
  const map: Record<string, string> = {
    RSA: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    ED25519: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    ECDSA: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };
  return <Badge variant="outline" className={cn('font-normal', map[type] ?? 'bg-muted text-muted-foreground')}>{type}</Badge>;
};

const certTypeBadge = (certType: string) => (
  <Badge variant="outline" className="font-normal bg-violet-500/10 text-violet-600 dark:text-violet-400">
    {certType === 'host' ? i18n.t('certificates.hostCert') : i18n.t('certificates.userCert')}
  </Badge>
);

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

export function Certificates() {
  const { t } = useTranslation();

  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const [privateKeyFile, setPrivateKeyFile] = useState<File | null>(null);

  // 详情抽屉状态
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCert, setDetailCert] = useState<Certificate | null>(null);
  const [detailContent, setDetailContent] = useState<CertContent | null>(null);
  const [showPrivate, setShowPrivate] = useState(false);

  useEffect(() => {
    loadCertificates();
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

  const loadCertificates = async () => {
    setLoading(true);
    try {
      setCerts(await getCertificates());
    } catch (error) {
      console.error('Failed to load certificates:', error);
    } finally {
      setLoading(false);
    }
  };

  const openImport = () => {
    setName('');
    setCertFile(null);
    setPrivateKeyFile(null);
    setSheetOpen(true);
  };

  const isFormValid = Boolean(name.trim() && certFile);

  const handleImport = async () => {
    const nextName = name.trim();
    if (!nextName) {
      await message(t('certificates.formNameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!certFile) {
      await message(t('certificates.formFileRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    try {
      const request: ImportCertRequest = {
        name: nextName,
        certBase64: (await readFileAsBase64(certFile)) as string,
        certFileName: certFile.name,
        privateKeyBase64: await readFileAsBase64(privateKeyFile),
        privateKeyFileName: privateKeyFile?.name,
      };
      await importCertificate(request);
      await loadCertificates();
      setSheetOpen(false);
    } catch (error) {
      console.error('Failed to import certificate:', error);
      await message(t('certificates.importFailed', { message: String(error) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleRemove = async (id: string) => {
    // 引用检查：被账号或主机绑定的证书删除前需明确告知影响
    let refNote = '';
    try {
      const [accountList, hostList] = await Promise.all([getAccounts(), getHosts()]);
      const refs = [
        ...accountList.filter((account) => account.certificateId === id).map((account) => t('certificates.refAccount', { name: account.name })),
        ...hostList
          .filter((host) => host.certificateId === id || host.proxyCertId === id)
          .map((host) => t('certificates.refHost', { name: host.name })),
      ];
      if (refs.length) {
        refNote = t('certificates.refNote', { refs: refs.join('、') });
      }
    } catch {
      // 引用检查失败不阻塞删除流程
    }

    const confirmed = await ask(
      `${refNote}${t('certificates.deleteConfirmBody')}`,
      { title: t('common.deleteConfirm'), kind: 'warning' },
    );
    if (!confirmed) return;
    try {
      await removeCertificate(id);
      await loadCertificates();
    } catch (error) {
      console.error('Failed to remove certificate:', error);
      await message(t('common.deleteFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleExport = async (cert: Certificate) => {
    try {
      const exported = await exportCertificateFile(cert.id);
      const target = await save({
        title: t('certificates.exportTitle'),
        defaultPath: exported.fileName,
      });
      if (!target) return;
      await exportCertificateFileTo(cert.id, target);
    } catch (error) {
      console.error('Failed to export certificate:', error);
      await message(t('certificates.exportFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const openDetail = async (cert: Certificate) => {
    setDetailCert(cert);
    setDetailContent(null);
    setShowPrivate(false);
    setDetailOpen(true);
    try {
      setDetailContent(await readCertificateContent(cert.id));
    } catch (error) {
      console.error('Failed to read certificate content:', error);
    }
  };

  const filteredCerts = certs.filter((cert) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      cert.name.toLowerCase().includes(query) ||
      cert.type.toLowerCase().includes(query) ||
      cert.fingerprint.toLowerCase().includes(query) ||
      cert.principals.some((p) => p.toLowerCase().includes(query))
    );
  });

  const isExpired = (cert: Certificate) => {
    if (!cert.validBefore) return false;
    const before = new Date(cert.validBefore);
    return !Number.isNaN(before.getTime()) && before.getTime() < Date.now();
  };

  const fieldLabel = (children: React.ReactNode) => (
    <Label className="mb-1.5 block text-xs font-medium">{children}</Label>
  );
  const fieldHint = (children: React.ReactNode) => (
    <p className="mt-2 text-xs text-muted-foreground">{children}</p>
  );

  const renderLoading = () => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="gap-0 p-0">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-7 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <FileBadge size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{searchQuery ? t('certificates.emptySearch') : t('certificates.emptyNone')}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchQuery
          ? t('certificates.emptySearchDesc', { query: searchQuery })
          : t('certificates.emptyNoneDesc')}
      </p>
      {!searchQuery && (
        <div className="mt-6">
          <Button onClick={openImport}>
            <Import size={16} /> {t('certificates.importCert')}
          </Button>
        </div>
      )}
    </div>
  );

  const renderCertCard = (cert: Certificate) => {
    const expired = isExpired(cert);
    return (
      <div
        key={cert.id}
        className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <FileBadge size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{cert.name}</span>
            {certTypeBadge(cert.certType)}
            {expired && (
              <Badge variant="outline" className="gap-1 font-normal bg-red-500/10 text-red-600 dark:text-red-400">
                {t('common.expired')}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={cert.fingerprint || undefined}>
            {cert.fingerprint || cert.type}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => void openDetail(cert)}
            title={t('certificates.viewDetails')}
            aria-label={t('certificates.view')}
          >
            <Eye size={14} strokeWidth={2} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => handleExport(cert)} disabled={expired}>
                <Export size={15} className="mr-2" /> {t('certificates.exportCertFile')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRemove(cert.id)}>
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
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('certificates.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('certificates.certCount', { count: filteredCerts.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('certificates.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg pl-8"
            />
          </div>
          <Button variant="ghost" size="icon" onClick={loadCertificates} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <RefreshCw size={16} />
          </Button>
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
          <Button onClick={openImport} title={t('certificates.importCert')}>
            <Import size={16} strokeWidth={2} />
            {t('certificates.importCert')}
          </Button>
        </div>
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : filteredCerts.length === 0 ? (
          renderEmpty()
        ) : viewMode === 'grid' ? (
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
            {filteredCerts.map((cert) => renderCertCard(cert))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <Table>
              <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[36%] min-w-[240px]">{t('certificates.tableCert')}</TableHead>
                  <TableHead>{t('certificates.tableType')}</TableHead>
                  <TableHead>{t('certificates.tablePrincipals')}</TableHead>
                  <TableHead>{t('certificates.tableValidUntil')}</TableHead>
                  <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCerts.map((cert) => (
                  <TableRow key={cert.id} className="group transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
                    <TableCell className="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <FileBadge size={16} strokeWidth={2} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{cert.name}</div>
                          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{cert.fingerprint}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {certTypeBadge(cert.certType)}
                        {keyTypeBadge(cert.type)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-0">
                      {cert.principals.length ? (
                        <code className="block truncate font-mono text-xs text-muted-foreground">
                          {cert.principals.join(', ')}
                        </code>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t('common.none')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {isExpired(cert) ? (
                        <Badge variant="outline" className="font-normal bg-red-500/10 text-red-600 dark:text-red-400">
                          {t('common.expired')}
                        </Badge>
                      ) : cert.validBefore ? (
                        new Date(cert.validBefore).toLocaleString('zh-CN')
                      ) : (
                        t('common.permanent')
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => void openDetail(cert)}
                          title={t('certificates.viewDetails')}
                        >
                          <Eye size={14} strokeWidth={2} />
                          {t('certificates.view')}
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
                            <DropdownMenuItem onClick={() => handleExport(cert)} disabled={isExpired(cert)}>
                              <Export size={15} className="mr-2" /> {t('certificates.exportCertFile')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleRemove(cert.id)}>
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

      {/* ===== 导入抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('certificates.importCert')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('common.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('certificates.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('certificates.certName')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('certificates.certNamePlaceholder')}
                />
              </div>
            </div>

            {/* 证书文件 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('certificates.certFileSection')}</div>
                <div className="text-xs text-muted-foreground">{t('certificates.certFileDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('certificates.certFile')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="file"
                  accept=".pub,.pem"
                  onChange={(e) => setCertFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div>
                {fieldLabel(t('certificates.pairedKey'))}
                <Input
                  type="file"
                  accept=".pem,.key"
                  onChange={(e) => setPrivateKeyFile(e.target.files?.[0] ?? null)}
                />
                {fieldHint(t('certificates.pairedKeyHint'))}
              </div>
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleImport()} disabled={!isFormValid}>
              {t('certificates.import')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ===== 证书详情抽屉 ===== */}
      <Sheet open={detailOpen} onOpenChange={(open) => !open && setDetailOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{t('certificates.certDetail')}</SheetTitle>
          </SheetHeader>
          {detailCert ? (
            <div className="flex flex-col gap-3.5">
              {/* 基本信息 */}
              <div className={sectionClass}>
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('common.basicInfo')}</div>
                  <div className="text-xs text-muted-foreground">{t('certificates.certMetaDesc')}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  {certTypeBadge(detailCert.certType)}
                  {keyTypeBadge(detailCert.type)}
                  {isExpired(detailCert) && (
                    <Badge variant="outline" className="font-normal bg-red-500/10 text-red-600 dark:text-red-400">
                      {t('common.expired')}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-2.5 text-xs">
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.name')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailCert.name}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('certificates.privateKey')}</div>
                    <div className="mt-0.5 truncate text-foreground">{detailCert.hasPrivateKey ? t('common.bound') : t('common.unbound')}</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('certificates.validPeriod')}</div>
                    <div className="mt-0.5 truncate text-foreground">
                      {detailCert.validAfter || detailCert.validBefore
                        ? `${detailCert.validAfter ? new Date(detailCert.validAfter).toLocaleString('zh-CN') : '—'} ~ ${detailCert.validBefore ? new Date(detailCert.validBefore).toLocaleString('zh-CN') : t('common.permanent')}`
                        : t('common.permanent')}
                    </div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.fingerprint')}</div>
                    <div className="mt-0.5 break-all font-mono text-muted-foreground">{detailCert.fingerprint || '—'}</div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('certificates.metaPrincipals')}</div>
                    <div className="mt-0.5 break-all font-mono text-muted-foreground">
                      {detailCert.principals.length ? detailCert.principals.join(', ') : t('certificates.noPrincipals')}
                    </div>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <div className="text-[11px] text-muted-foreground">{t('common.storageLocation')}</div>
                    <div className="mt-0.5 truncate text-foreground">{t('common.databaseNoDisk')}</div>
                  </div>
                </div>
              </div>

              {/* 证书内容 */}
              <div className={sectionClass}>
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('certificates.certContent')}</div>
                  <div className="text-xs text-muted-foreground">{t('certificates.certContentDesc')}</div>
                </div>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground">
                  {detailContent ? detailContent.certContent || t('certificates.noCertContent') : t('common.loading')}
                </pre>
              </div>

              {/* 配套私钥 */}
              {detailContent?.privateKey && (
                <div className={sectionClass}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{t('certificates.pairedKeyTitle')}</div>
                      <div className="text-xs text-muted-foreground">{t('certificates.pairedKeyDesc')}</div>
                    </div>
                    <Button variant="secondary" size="sm" className="h-7" onClick={() => setShowPrivate((v) => !v)}>
                      {showPrivate ? <EyeOff size={14} /> : <Eye size={14} />}
                      {showPrivate ? t('common.hide') : t('common.show')}
                    </Button>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground">
                    {showPrivate ? detailContent.privateKey : t('certificates.hiddenPrivateKey')}
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
