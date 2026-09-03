import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import {
  getSftp,
  saveSftpConnection,
  removeSftpConnection,
  testSftpConnection,
  getKeys,
  getHosts,
  getAccounts,
  getCertificates,
  type SftpConnection,
  type Key,
  type Host,
  type Account,
  type Certificate,
} from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import {
  Folder as IconFolder,
  Plus as IconPlus,
  Pencil as IconEdit,
  Play as IconPlayerPlay,
  Trash2 as IconTrash,
  Server as IconServer,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import { useTabStore } from '../store/tabStore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CardGridSkeleton, ListTableSkeleton } from '../components/ui/listSkeleton';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ask } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';

type ViewMode = 'grid' | 'list';
type ProtocolFilter = 'all' | SftpConnection['protocol'];

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border bg-card p-4';

const filterChips: { key: ProtocolFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'sftp', label: 'sftp.filterSftp' },
  { key: 'ftp', label: 'sftp.filterFtp' },
];

const protocolBadge = (protocol: SftpConnection['protocol']) => (
  <Badge
    variant="outline"
    className={cn(
      'font-normal',
      protocol === 'sftp'
        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    )}
  >
    {protocol.toUpperCase()}
  </Badge>
);

const formatLastAccessed = (lastAccessed?: string) => {
  if (!lastAccessed) return i18n.t('sftp.notAccessed');
  return new Date(lastAccessed).toLocaleString('zh-CN');
};

interface SftpForm {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  remotePath: string;
}

const EMPTY_FORM: SftpForm = {
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  keyId: '',
  keyPath: '',
  passphrase: '',
  remotePath: '/',
};

export function Sftp() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [connections, setConnections] = useState<SftpConnection[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [editingConnection, setEditingConnection] = useState<SftpConnection | null>(null);
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('all');
  const [testing, setTesting] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const { createTab } = useTabStore();
  // 订阅活跃标签：实时派生「已连接」状态（有该 host:port 的会话标签即在线）
  const tabs = useTabStore((s) => s.tabs);

  // 活跃会话键集合：**按连接类型隔离**——terminal（SSH）标签只匹配主机条目，
  // sftp 标签只匹配 Sftp 连接条目；均有 id 精准匹配 + 地址兜底两层
  const activeSshKeys = useMemo(() => {
    const byHostId = new Set<string>();
    const byAddr = new Set<string>();
    const collect = (config?: { host?: string; port?: number; hostId?: string }) => {
      if (!config?.host) return;
      if (config.hostId) byHostId.add(config.hostId);
      byAddr.add(`${config.host}:${config.port ?? 22}`);
    };
    for (const tab of tabs) {
      if (tab.type === 'split') {
        for (const pane of tab.panes || []) {
          if (pane.type === 'terminal') collect(pane.sshConfig);
        }
      } else if (tab.type === 'terminal') {
        collect(tab.sshConfig);
      }
    }
    return { byHostId, byAddr };
  }, [tabs]);

  const activeSftpKeys = useMemo(() => {
    const byConnId = new Set<string>();
    const byAddr = new Set<string>();
    const collect = (config?: { host?: string; port?: number; connectionId?: string }) => {
      if (!config?.host) return;
      if (config.connectionId) byConnId.add(config.connectionId);
      byAddr.add(`${config.host}:${config.port ?? 22}`);
    };
    for (const tab of tabs) {
      if (tab.type === 'split') {
        for (const pane of tab.panes || []) {
          if (pane.type === 'sftp') collect(pane.sftpConfig);
        }
      } else if (tab.type === 'sftp') {
        collect(tab.sftpConfig);
      }
    }
    return { byConnId, byAddr };
  }, [tabs]);

  /** 已知主机（Host 条目，SSH 侧）是否有活跃会话：hostId 精准匹配，回退地址。 */
  const isHostOnline = (host: Host) =>
    activeSshKeys.byHostId.has(host.id) ||
    activeSshKeys.byAddr.has(`${host.host}:${host.port}`);

  /** 某 SFTP 连接是否有活跃会话（SFTP 侧）：connectionId 精准匹配，回退地址。 */
  const isConnOnline = (conn: SftpConnection) =>
    activeSftpKeys.byConnId.has(conn.id) ||
    activeSftpKeys.byAddr.has(`${conn.host}:${conn.port}`);

  // ============ 表单状态 ============
  const [form, setForm] = useState<SftpForm>(EMPTY_FORM);
  const [protocol, setProtocol] = useState<'ftp' | 'sftp'>('sftp');
  const [authType, setAuthType] = useState<'password' | 'publickey'>('password');
  const [importHostId, setImportHostId] = useState('');

  useEffect(() => {
    void loadConnections();
    void getKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
    void getHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
    void getAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
    void getCertificates()
      .then(setCerts)
      .catch(() => setCerts([]));
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

  const loadConnections = async () => {
    setLoading(true);
    setError(null);
    try {
      setConnections(await getSftp());
    } catch (loadError) {
      console.error('Failed to load FTP connections:', loadError);
      setError(t('sftp.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  // ============ 表单逻辑 ============
  const openCreate = () => {
    setEditingConnection(null);
    setProtocol('sftp');
    setAuthType('password');
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  };

  const openEdit = (connection: SftpConnection) => {
    setEditingConnection(connection);
    setProtocol(connection.protocol);
    setAuthType(connection.authType);
    setForm({
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password || '',
      keyId: connection.keyId || '',
      keyPath: connection.keyPath || '',
      passphrase: connection.passphrase || '',
      remotePath: connection.remotePath,
    });
    setSheetOpen(true);
  };

  const handleProtocolChange = (value: string) => {
    const next = value as 'ftp' | 'sftp';
    setProtocol(next);
    // 协议切换时自动调整默认端口（仅新建时）；FTP 仅支持密码认证
    if (!editingConnection) {
      setForm((prev) => ({ ...prev, port: next === 'ftp' ? 21 : 22 }));
    }
    if (next === 'ftp') {
      setAuthType('password');
    }
  };

  // 从系统内已有主机导入连接配置（自动填充地址/端口/用户名与认证信息）
  const handleImportHost = (hostId: string) => {
    setImportHostId('');
    if (!hostId) return;
    const host = hosts.find((item) => item.id === hostId);
    if (!host) return;

    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    // 基础信息始终填充；远程路径保持默认根目录，名称沿用主机名（可改）
    const baseForm: SftpForm = {
      ...EMPTY_FORM,
      name: host.name,
      host: host.host,
      port: host.port,
      username: auth.username,
      remotePath: '/',
    };

    setProtocol('sftp');
    if (auth.authType === 'password' && auth.password) {
      setForm({ ...baseForm, password: auth.password });
      setAuthType('password');
      toast.success(t('sftp.importedFromHost', { name: host.name }));
    } else if (auth.authType === 'key' && auth.keyId) {
      setForm({ ...baseForm, keyId: auth.keyId });
      setAuthType('publickey');
      toast.success(t('sftp.importedFromHost', { name: host.name }));
    } else if (auth.authType === 'certificate') {
      // SFTP 暂不支持证书认证：仅导入主机信息，认证方式交给用户
      setForm(baseForm);
      setAuthType('password');
      toast.info(t('sftp.importedCertUnsupported', { name: host.name }));
    } else {
      setForm(baseForm);
      setAuthType('password');
      toast.warning(auth.error || t('sftp.importNoAuth', { name: host.name }));
    }
  };

  const isFormValid = (() => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) return false;
    if (form.port < 1 || form.port > 65535) return false;
    // SFTP 公钥认证：密钥库密钥或外部私钥路径至少填一个；FTP 仅支持密码
    if (protocol === 'sftp' && authType === 'publickey') {
      return Boolean(form.keyId.trim() || form.keyPath.trim());
    }
    if (protocol === 'ftp' && authType === 'publickey') return false;
    return true;
  })();

  const handleSave = async () => {
    const nextName = form.name.trim();
    const nextHost = form.host.trim();
    const nextUsername = form.username.trim();
    if (!nextName) {
      toast.warning(t('sftp.formNameRequired'));
      return;
    }
    if (!nextHost) {
      toast.warning(t('sftp.formHostRequired'));
      return;
    }
    if (!nextUsername) {
      toast.warning(t('sftp.formUsernameRequired'));
      return;
    }
    if (protocol === 'sftp' && authType === 'publickey' && !form.keyId.trim() && !form.keyPath.trim()) {
      toast.warning(t('sftp.formKeyRequired'));
      return;
    }
    if (protocol === 'ftp' && authType === 'publickey') {
      toast.warning(t('sftp.ftpPasswordOnly'));
      return;
    }

    const usePublicKey = authType === 'publickey' && protocol === 'sftp';
    const nextAuthType: SftpConnection['authType'] = usePublicKey ? 'publickey' : 'password';
    const connectionData = {
      id: editingConnection?.id,
      name: nextName,
      host: nextHost,
      port: form.port,
      protocol,
      username: nextUsername,
      authType: nextAuthType,
      password: !usePublicKey ? form.password || undefined : undefined,
      keyId: usePublicKey ? form.keyId.trim() || undefined : undefined,
      keyPath: usePublicKey ? form.keyPath.trim() || undefined : undefined,
      passphrase: usePublicKey ? form.passphrase || undefined : undefined,
      remotePath: form.remotePath.trim() || '/',
    };

    try {
      await saveSftpConnection(connectionData);
      setSheetOpen(false);
      setEditingConnection(null);
      toast.success(editingConnection ? t('sftp.updated') : t('sftp.created'));
      await loadConnections();
    } catch (saveError) {
      console.error('Failed to save connection:', saveError);
      toast.error(t('common.saveFailed'));
    }
  };

  const handleRemove = async (conn: SftpConnection) => {
    const confirmed = await ask(t('sftp.deleteConfirmBody', { name: conn.name }), { title: t('common.deleteConfirm'), kind: 'warning' });
    if (!confirmed) return;
    try {
      await removeSftpConnection(conn.id);
      toast.success(t('sftp.deleted', { name: conn.name }));
      await loadConnections();
    } catch (removeError) {
      console.error('Failed to remove connection:', removeError);
      toast.error(t('common.deleteFailed'));
    }
  };

  const handleTest = async (conn: SftpConnection) => {
    setTesting(conn.id);
    try {
      const success = await testSftpConnection(conn.id);
      if (success) {
        toast.success(t('sftp.testSuccess', { name: conn.name }));
      } else {
        toast.warning(t('sftp.testFailed', { name: conn.name }));
      }
    } catch (testError) {
      console.error('Failed to test connection:', testError);
      toast.error(t('sftp.testError'));
    } finally {
      setTesting(null);
    }
  };

  const handleConnect = (conn: SftpConnection) => {
    createTab({
      name: `${conn.protocol.toUpperCase()}: ${conn.name}`,
      type: 'sftp',
      sftpConfig: {
        name: conn.name,
        host: conn.host,
        port: conn.port,
        protocol: conn.protocol,
        username: conn.username,
        authType: conn.authType,
        password: conn.password,
        keyPath: conn.keyPath,
        keyId: conn.keyId,
        passphrase: conn.passphrase,
        remotePath: conn.remotePath,
        connectionId: conn.id,
      },
    });
  };

  // ============ 派生数据 ============
  const filteredConnections = connections.filter((conn) => {
    if (protocolFilter !== 'all' && conn.protocol !== protocolFilter) return false;
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      conn.name.toLowerCase().includes(query) ||
      conn.host.toLowerCase().includes(query) ||
      conn.remotePath.toLowerCase().includes(query) ||
      conn.username.toLowerCase().includes(query)
    );
  });

  const groups: { key: SftpConnection['protocol']; items: SftpConnection[] }[] = (
    [
      { key: 'sftp', items: [] },
      { key: 'ftp', items: [] },
    ] as { key: SftpConnection['protocol']; items: SftpConnection[] }[]
  )
    .map((group) => ({ ...group, items: filteredConnections.filter((conn) => conn.protocol === group.key) }))
    .filter((group) => group.items.length > 0);

  const fieldLabel = (children: React.ReactNode) => <Label className="mb-1.5 block text-xs font-medium">{children}</Label>;
  const fieldHint = (children: React.ReactNode) => <p className="mt-2 text-xs text-muted-foreground">{children}</p>;

  const renderConnCard = (conn: SftpConnection) => {
    return (
      <div
        key={conn.id}
        className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
      >
        <div className="relative shrink-0">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <IconFolder size={15} strokeWidth={2} />
          </div>
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card',
              isConnOnline(conn)
                ? 'bg-emerald-500 ring-emerald-500/20'
                : 'bg-muted-foreground/40',
            )}
            title={
              isConnOnline(conn)
                ? t('sftp.connected')
                : t('sftp.disconnected')
            }
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{conn.name}</span>
            {protocolBadge(conn.protocol)}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {conn.username}@{conn.host}:{conn.port}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => handleConnect(conn)}
            title={t('sftp.connect')}
            aria-label={t('sftp.connect')}
          >
            <IconServer size={14} strokeWidth={2} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void handleTest(conn)}>
                <IconPlayerPlay size={15} className="mr-2" /> {t('sftp.testConnection')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openEdit(conn)}>
                <IconEdit size={15} className="mr-2" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(conn)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderConnRow = (conn: SftpConnection) => (
    <TableRow key={conn.id} className="group transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative shrink-0">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
              <IconFolder size={15} strokeWidth={2} />
            </div>
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card',
                isConnOnline(conn)
                  ? 'bg-emerald-500 ring-emerald-500/20'
                  : 'bg-muted-foreground/40',
              )}
              title={isConnOnline(conn) ? t('sftp.connected') : t('sftp.disconnected')}
            />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{conn.name}</span>
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {conn.host}:{conn.port}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{protocolBadge(conn.protocol)}</TableCell>
      <TableCell className="max-w-0 truncate font-mono text-sm text-muted-foreground">{conn.remotePath}</TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatLastAccessed(conn.lastAccessed)}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="icon"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => handleConnect(conn)}
            title={t('sftp.connect')}
          >
            <IconServer size={14} strokeWidth={2} />
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
              <DropdownMenuItem onClick={() => void handleTest(conn)} disabled={testing === conn.id}>
                <IconPlayerPlay size={15} className="mr-2" /> {t('sftp.testConnection')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openEdit(conn)}>
                <IconEdit size={15} className="mr-2" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(conn)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );

  const renderLoading = () =>
    viewMode === 'grid' ? (
      <CardGridSkeleton />
    ) : (
      <ListTableSkeleton
        colCount={5}
        head={
          <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[32%] min-w-[240px]">{t('sftp.tableConnection')}</TableHead>
                          <TableHead>{t('sftp.tableProtocol')}</TableHead>
                          <TableHead>{t('sftp.tableRemotePath')}</TableHead>
                          <TableHead>{t('sftp.tableLastAccessed')}</TableHead>
                          <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        }
      />
    );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconFolder size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">
        {searchQuery || protocolFilter !== 'all' ? t('sftp.emptySearch') : t('sftp.emptyNone')}
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchQuery || protocolFilter !== 'all'
          ? t('sftp.emptySearchDesc', { query: searchQuery || t('common.currentFilter') })
          : t('sftp.emptyNoneDesc')}
      </p>
      {!(searchQuery || protocolFilter !== 'all') && (
        <Button className="mt-6" onClick={openCreate}>
          <IconPlus size={16} /> {t('sftp.createConnection')}
        </Button>
      )}
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <IconAlert size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('sftp.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-6" onClick={() => void loadConnections()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('sftp.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('sftp.connectionCount', { count: filteredConnections.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('sftp.searchPlaceholder')}
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
          <Button variant="ghost" size="icon" onClick={() => void loadConnections()} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button onClick={openCreate} title={t('sftp.createConnection')}>
            <IconPlus size={16} strokeWidth={2} />
            {t('sftp.add')}
          </Button>
        </div>
      </div>

      {/* ===== 筛选 chips ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {filterChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setProtocolFilter(chip.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              protocolFilter === chip.key
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
        ) : error && connections.length === 0 ? (
          renderError()
        ) : filteredConnections.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{group.key.toUpperCase()}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                {viewMode === 'grid' ? (
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
                    {group.items.map((conn) => renderConnCard(conn))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[32%] min-w-[240px]">{t('sftp.tableConnection')}</TableHead>
                          <TableHead>{t('sftp.tableProtocol')}</TableHead>
                          <TableHead>{t('sftp.tableRemotePath')}</TableHead>
                          <TableHead>{t('sftp.tableLastAccessed')}</TableHead>
                          <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((conn) => renderConnRow(conn))}</TableBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 新建/编辑连接抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{editingConnection ? t('sftp.editConnection') : t('sftp.createConnection')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 从已有主机导入 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('sftp.importFromHost')}</div>
                <div className="text-xs text-muted-foreground">{t('sftp.importFromHostDesc')}</div>
              </div>
              <Select value={importHostId} onValueChange={handleImportHost}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('sftp.selectHostPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {hosts.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('sftp.noHosts')}</div>
                  )}
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={host.id}>
                      <span className="flex items-center gap-1.5">
                        <span className="relative inline-flex">
                          <IconServer size={12} className="text-muted-foreground" />
                          <span
                            className={cn(
                              'absolute -right-1 -top-1 size-1.5 rounded-full ring-2 ring-popover',
                              isHostOnline(host)
                                ? 'bg-emerald-500'
                                : 'bg-muted-foreground/40',
                            )}
                          />
                        </span>
                        <span className="truncate">
                          {host.name}（{host.host}:{host.port}）
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldHint(t('sftp.importHint'))}
            </div>

            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('sftp.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('sftp.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('sftp.connectionName')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('sftp.connectionNamePlaceholder')}
                />
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('sftp.protocolType')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Select value={protocol} onValueChange={handleProtocolChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sftp">{t('sftp.protocolSftpOption')}</SelectItem>
                    <SelectItem value="ftp">{t('sftp.protocolFtpOption')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  {fieldLabel(
                    <>
                      {t('sftp.serverAddress')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Input
                    type="text"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder={t('sftp.serverAddressPlaceholder')}
                  />
                </div>
                <div>
                  {fieldLabel(
                    <>
                      {t('common.port')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>
              {fieldHint(t('sftp.ftpDefaultPortHint'))}
            </div>

            {/* 认证信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('sftp.authInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('sftp.authInfoDesc')}</div>
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
                  placeholder={t('common.username')}
                />
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('sftp.authMethod')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Select value={authType} onValueChange={(v) => setAuthType(v as 'password' | 'publickey')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">{t('sftp.authPasswordOption')}</SelectItem>
                    <SelectItem value="publickey" disabled={protocol === 'ftp'}>
                      {t('sftp.authPublicKeyOption')}
                    </SelectItem>
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
                    placeholder={t('sftp.passwordPlaceholder')}
                  />
                </div>
              )}
              {authType === 'publickey' && protocol === 'sftp' && (
                <>
                  <div>
                    {fieldLabel(t('sftp.keyStore'))}
                    <Select
                      value={form.keyId || undefined}
                      onValueChange={(v) => setForm({ ...form, keyId: v })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={keys.length ? t('sftp.selectKeyPlaceholder') : t('sftp.noKeys')} />
                      </SelectTrigger>
                      <SelectContent>
                        {keys.map((key) => (
                          <SelectItem key={key.id} value={key.id}>
                            {key.name}（{key.type}）
                          </SelectItem>
                        ))}
                        {form.keyId && !keys.some((key) => key.id === form.keyId) && (
                          <SelectItem value={form.keyId}>{t('sftp.deletedKey', { id: form.keyId })}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {fieldHint(
                      keys.length
                        ? t('sftp.keyStoreHint')
                        : t('sftp.keyStoreHintNoKeys'),
                    )}
                  </div>
                  <div>
                    {fieldLabel(t('sftp.keyPassphrase'))}
                    <Input
                      type="password"
                      value={form.passphrase}
                      onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
                      placeholder={t('sftp.keyPassphrasePlaceholder')}
                    />
                  </div>
                  <div>
                    {fieldLabel(t('sftp.externalKeyPath'))}
                    <Input
                      type="text"
                      value={form.keyPath}
                      onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                      placeholder={t('sftp.externalKeyPathPlaceholder')}
                    />
                    {fieldHint(t('sftp.externalKeyPathHint'))}
                  </div>
                </>
              )}
              <div>
                {fieldLabel(t('sftp.remotePath'))}
                <Input
                  type="text"
                  value={form.remotePath}
                  onChange={(e) => setForm({ ...form, remotePath: e.target.value })}
                  placeholder={t('sftp.remotePathPlaceholder')}
                />
                {fieldHint(t('sftp.remotePathHint'))}
              </div>
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!isFormValid}>
              {editingConnection ? t('sftp.saveChanges') : t('sftp.createConnectionAction')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
