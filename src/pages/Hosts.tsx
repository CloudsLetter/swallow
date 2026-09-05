import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import {
  getHosts,
  addHost,
  removeHost,
  updateHost,
  getAccounts,
  getKeys,
  getCertificates,
  getPortForwardings,
  type Host,
  type Account,
  type Key,
  type Certificate,
} from '../services/dataService';
import {
  Server as IconServer,
  Plus as IconPlus,
  Pencil as IconEdit,
  Trash2 as IconTrash,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  Copy as IconCopy,
  Check as IconCheck,
  AlertTriangle as IconAlert,
  MoreHorizontal as IconMore,
  RefreshCw as IconRefresh,
  Terminal as IconTerminal,
  FolderOpen as IconFolderOpen,
  Globe as IconGlobe,
  Lock as IconLock,
  KeyRound as IconKeyRound,
  ShieldCheck as IconShieldCheck,
  Monitor as IconMonitor,
  Radio as IconRadio,
  Usb as IconUsb,
} from 'lucide-react';
import { useTabStore } from '../store/tabStore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
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
import { message, ask } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { setQuickConnectIntent } from '../services/quickConnectIntent';

type ViewMode = 'grid' | 'list';
type AuthFilter = 'all' | 'password' | 'key' | 'certificate' | 'proxy';
type ProxyMode = 'existing' | 'manual';
type AuthSource = 'account' | 'manual';
type SupportedAccount = Account & { authType: 'password' | 'key' | 'certificate' };

const sectionClass = 'flex flex-col gap-3 rounded-lg bg-muted/40 p-4';
const noticeWarningClass =
  'rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning';

function getAuthTypeText(authType?: Host['authType'] | Account['authType']) {
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

function isSupportedHostAccount(account: Account): account is SupportedAccount {
  return account.authType === 'password' || account.authType === 'key' || account.authType === 'certificate';
}

function normalizeHostAuthType(
  authType?: Host['authType'] | Account['authType'],
): 'password' | 'key' | 'certificate' | 'none' {
  if (authType === 'password') return 'password';
  if (authType === 'key') return 'key';
  if (authType === 'certificate') return 'certificate';
  return 'none';
}

function normalizeHostStatus(status?: Host['status']): 'connected' | 'disconnected' | 'error' {
  if (status === 'connected') return 'connected';
  if (status === 'error') return 'error';
  return 'disconnected';
}

function findHostAccount(host: Host, accounts: SupportedAccount[]): SupportedAccount | undefined {
  if (!host.accountId) return undefined;
  return accounts.find((account) => account.id === host.accountId);
}

const authBadge = (authType: 'password' | 'key' | 'certificate' | 'none') => {
  const map = {
    password: { label: i18n.t('hosts.authTypePassword'), cls: 'bg-info/10 text-info' },
    key: { label: i18n.t('hosts.authTypeKey'), cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    certificate: { label: i18n.t('hosts.authTypeCertificate'), cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
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
const statusIcon = (status: Host['status']) => (
  <span
    className={cn('inline-block size-2 shrink-0 rounded-full', statusDotClass(status))}
    title={statusText(status)}
  />
);

/** 状态角标（卡片图标块右上角）：已连接=绿色对勾徽章 / 错误=红点 / 未连接=灰点。 */
const statusCornerBadge = (status: Host['status']) => {
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
const authIcon = (authType: 'password' | 'key' | 'certificate' | 'none') => {
  const map = {
    password: { Icon: IconLock, cls: 'text-info', label: i18n.t('hosts.authTypePassword') },
    key: { Icon: IconKeyRound, cls: 'text-violet-600 dark:text-violet-400', label: i18n.t('hosts.authTypeKey') },
    certificate: { Icon: IconShieldCheck, cls: 'text-teal-600 dark:text-teal-400', label: i18n.t('hosts.authTypeCertificate') },
    none: { Icon: IconLock, cls: 'text-muted-foreground', label: i18n.t('hosts.authNone') },
  } as const;
  const { Icon, cls, label } = map[authType];
  return (
    <span className="shrink-0" title={label} aria-label={label}>
      <Icon size={12} strokeWidth={2} className={cls} />
    </span>
  );
};

const filterChips: { key: AuthFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'password', label: 'hosts.authPassword' },
  { key: 'key', label: 'hosts.authKey' },
  { key: 'certificate', label: 'hosts.authCertificate' },
  { key: 'proxy', label: 'hosts.authProxy' },
];

export function Hosts() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<SupportedAccount[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const { createTab } = useTabStore();
  // 订阅活跃标签：实时派生主机连接状态（有该主机的 terminal/sftp 会话即视为已连接）
  const tabs = useTabStore((s) => s.tabs);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [authFilter, setAuthFilter] = useState<AuthFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 表单状态
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [authSource, setAuthSource] = useState<AuthSource>('account');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [manualAuthType, setManualAuthType] = useState<'password' | 'key' | 'certificate' | 'none'>('password');
  const [manualUsername, setManualUsername] = useState('');
  const [manualPassword, setManualPassword] = useState('');
  const [manualKeyId, setManualKeyId] = useState('');
  const [manualCertId, setManualCertId] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>('existing');
  const [selectedProxyHostId, setSelectedProxyHostId] = useState('');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState(22);
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyAuthType, setProxyAuthType] = useState<'password' | 'key' | 'certificate'>('password');
  const [proxyKeyId, setProxyKeyId] = useState('');
  const [proxyCertId, setProxyCertId] = useState('');

  // ============ 数据加载 ============
  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([loadHosts(), loadReferenceData()]);
      } finally {
        setLoading(false);
      }
    };
    void bootstrap();
  }, []);

  // ============ 键盘快捷键 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        setSearchQuery('');
      } else if (e.key.toLowerCase() === 'n' && !inField && !sheetOpen) {
        e.preventDefault();
        void openCreate();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  const loadHosts = async () => {
    try {
      setHosts(await getHosts());
      setError(null);
    } catch (loadError) {
      console.error('Failed to load hosts:', loadError);
      setError(t('hosts.loadFailedMsg'));
    }
  };

  const loadReferenceData = async () => {
    try {
      const [accountList, keyList, certList] = await Promise.all([
        getAccounts(),
        getKeys(),
        getCertificates().catch(() => [] as Certificate[]),
      ]);
      const supportedAccounts = accountList.filter(isSupportedHostAccount);
      setAccounts(supportedAccounts);
      setKeys(keyList);
      setCerts(certList);
      return supportedAccounts;
    } catch (loadError) {
      console.error('Failed to load accounts or keys:', loadError);
      return [];
    }
  };

  const refresh = () => {
    setLoading(true);
    setError(null);
    Promise.all([loadHosts(), loadReferenceData()]).finally(() => setLoading(false));
  };

  // ============ 解析辅助 ============
  const resolveHostAccount = (host: Host) => findHostAccount(host, accounts);
  const resolveHostUsername = (host: Host) => resolveHostAccount(host)?.username || host.username;
  const resolveHostAuthType = (host: Host) =>
    normalizeHostAuthType(resolveHostAccount(host)?.authType || host.authType);
  const resolveHostAccountName = (host: Host) => resolveHostAccount(host)?.name;

  // ============ 业务操作 ============
  const handleConnect = async (host: Host) => {
    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    if (auth.error) {
      await message(auth.error, { title: t('hosts.cannotConnect'), kind: 'warning' });
      return;
    }

    createTab({
      name: `${host.name} (${host.host})`,
      type: 'terminal',
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

  // 从主机一键打开 SFTP 文件浏览（复用主机的认证信息）
  const handleSftpConnect = (host: Host) => {
    if (host.useProxy) {
      toast.info(t('hosts.sftpNoJump'));
      return;
    }
    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    if (auth.error) {
      toast.warning(auth.error);
      return;
    }
    if (auth.authType === 'certificate') {
      toast.info(t('hosts.sftpNoCert'));
      return;
    }
    if (auth.authType === 'none') {
      toast.warning(t('hosts.sftpNoAuth'));
      return;
    }

    createTab({
      name: `SFTP: ${host.name}`,
      type: 'sftp',
      sftpConfig: {
        name: host.name,
        host: host.host,
        port: host.port,
        protocol: 'sftp',
        username: auth.username,
        authType: auth.authType === 'key' ? 'publickey' : 'password',
        password: auth.password,
        keyId: auth.keyId,
        passphrase: undefined,
        remotePath: '/',
      },
    });
  };

  // ============ VNC 快捷连接（主机菜单入口） ============
  const [vncDialogHost, setVncDialogHost] = useState<Host | null>(null);
  const [vncDialogPort, setVncDialogPort] = useState(5900);
  const [vncDialogPassword, setVncDialogPassword] = useState('');

  /** 打开 VNC 连接对话框（目标主机固定为所选主机，端口/密码可填）。 */
  const openVncDialog = (host: Host) => {
    setVncDialogHost(host);
    setVncDialogPort(5900);
    setVncDialogPassword('');
  };

  /** 确认：用主机地址直连 VNC（noVNC 会处理密码认证）。 */
  const handleVncConnect = () => {
    const host = vncDialogHost;
    if (!host) return;
    const port = Number(vncDialogPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      toast.warning(t('hosts.vncPortInvalid'));
      return;
    }
    createTab({
      name: `${host.name} (VNC)`,
      type: 'vnc',
      vncConfig: {
        host: host.host,
        port,
        password: vncDialogPassword.trim() || undefined,
        shared: true,
      },
    });
    setVncDialogHost(null);
  };

  /** MOSH 连接：SSH 引导复用主机完整认证链路（含跳板机/证书），数据面走 UDP。 */
  const handleMoshConnect = (host: Host) => {
    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    if (auth.error) {
      toast.warning(auth.error);
      return;
    }
    if (auth.authType === 'none') {
      toast.warning(t('hosts.sftpNoAuth'));
      return;
    }
    createTab({
      name: `${host.name} (MOSH)`,
      type: 'mosh',
      moshConfig: {
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

  /** 顶部工具栏「串口终端」：跳到 QuickConnect 的串口卡（滚动+高亮）。 */
  const handleSerialQuickConnect = () => {
    setQuickConnectIntent('serial');
    createTab({ name: t('quickConnect.serialTitle'), type: 'quick-connect' });
  };

  const handleRemove = async (id: string) => {
    // 引用检查：被端口转发规则或其他主机（跳板机）引用的主机删除前需明确告知影响
    let refNote = '';
    try {
      const [ruleList, hostList] = await Promise.all([getPortForwardings(), getHosts()]);
      const refs = [
        ...ruleList.filter((rule) => rule.hostId === id).map((rule) => t('hosts.refPortForwarding', { name: rule.name })),
        ...hostList.filter((host) => host.proxyHostId === id).map((host) => t('hosts.refJumpHost', { name: host.name })),
      ];
      if (refs.length) {
        refNote = t('hosts.refNote', { refs: refs.join('、') });
      }
    } catch {
      // 引用检查失败不阻塞删除流程
    }

    const confirmed = await ask(`${refNote}${t('hosts.deleteConfirmBody')}`, { title: t('common.deleteConfirm'), kind: 'warning' });
    if (confirmed) {
      await removeHost(id);
      await loadHosts();
    }
  };

  const handleCopyCommand = async (host: Host) => {
    const command = `ssh ${resolveHostUsername(host)}@${host.host} -p ${host.port}`;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(host.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch (copyError) {
      console.error('复制失败:', copyError);
    }
  };

  // ============ 表单逻辑 ============
  const resetForm = () => {
    setName('');
    setHost('');
    setPort(22);
    setSelectedAccountId('');
    setManualAuthType('password');
    setManualUsername('');
    setManualPassword('');
    setManualKeyId('');
    setManualCertId('');
    setUseProxy(false);
    setProxyMode('existing');
    setSelectedProxyHostId('');
    setProxyHost('');
    setProxyPort(22);
    setProxyUsername('');
    setProxyPassword('');
    setProxyAuthType('password');
    setProxyKeyId('');
    setProxyCertId('');
  };

  const openCreate = async () => {
    const latestAccounts = await loadReferenceData();
    resetForm();
    setEditingHost(null);
    setAuthSource(latestAccounts.length > 0 ? 'account' : 'manual');
    setSheetOpen(true);
  };

  const openEdit = async (host: Host) => {
    const latestAccounts = await loadReferenceData();
    const matchedAccount = findHostAccount(host, latestAccounts);

    setName(host.name);
    setHost(host.host);
    setPort(host.port);
    setEditingHost(host);
    setAuthSource(matchedAccount ? 'account' : 'manual');
    setSelectedAccountId(matchedAccount?.id || host.accountId || '');
    // 手动表单同样支持证书认证（通过证书 ID 关联）
    const hostManualType = normalizeHostAuthType(host.authType);
    setManualAuthType(hostManualType);
    setManualUsername(host.username || '');
    setManualPassword(host.password || '');
    setManualKeyId(host.keyId || '');
    setManualCertId(host.certificateId || '');
    setUseProxy(host.useProxy || false);

    const matchedProxyHost =
      (host.proxyHostId && hosts.find((item) => item.id === host.proxyHostId)) ||
      hosts.find(
        (item) =>
          item.id !== host.id &&
          item.host === host.proxyHost &&
          item.port === host.proxyPort &&
          item.username === host.proxyUsername,
      );

    setProxyMode(matchedProxyHost ? 'existing' : 'manual');
    setSelectedProxyHostId(matchedProxyHost?.id || '');
    setProxyHost(host.proxyHost || '');
    setProxyPort(host.proxyPort || 22);
    setProxyUsername(host.proxyUsername || '');
    setProxyPassword(host.proxyPassword || '');
    const proxyType = normalizeHostAuthType(host.proxyAuthType);
    setProxyAuthType(proxyType === 'key' || proxyType === 'certificate' ? proxyType : 'password');
    setProxyKeyId(host.proxyKeyId || '');
    setProxyCertId(host.proxyCertId || '');
    setSheetOpen(true);
  };

  const availableProxyHosts = hosts.filter((host) => host.id !== editingHost?.id);

  const handleSave = async () => {
    const selectedProxyHost = availableProxyHosts.find((host) => host.id === selectedProxyHostId);
    const selectedAccount = authSource === 'account'
      ? accounts.find((account) => account.id === selectedAccountId)
      : undefined;
    const selectedProxyAccount = selectedProxyHost ? resolveHostAccount(selectedProxyHost) : undefined;

    // 基本信息校验
    const nextName = name.trim();
    const nextHost = host.trim();
    if (!nextName) {
      await message(t('hosts.formNameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!nextHost) {
      await message(t('hosts.formHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!port || port < 1 || port > 65535) {
      await message(t('hosts.formPortInvalid'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    // 认证校验
    if (authSource === 'account' && !selectedAccount) {
      await message(t('hosts.formAccountRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    const nextManualUsername = manualUsername.trim();
    const nextManualPassword = manualPassword.trim();
    const nextManualKeyId = manualKeyId.trim();
    const nextManualCertId = manualCertId.trim();

    if (authSource !== 'account' && !nextManualUsername) {
      await message(t('hosts.formUsernameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (authSource !== 'account' && manualAuthType === 'key' && !nextManualKeyId) {
      await message(t('hosts.formKeyRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (authSource !== 'account' && manualAuthType === 'certificate' && !nextManualCertId) {
      await message(t('hosts.formCertRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    // 跳板机校验
    if (useProxy) {
      if (proxyMode === 'existing') {
        if (!selectedProxyHostId) {
          await message(t('hosts.formProxyHostRequired'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
      } else {
        if (!proxyHost.trim()) {
          await message(t('hosts.formProxyAddressRequired'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        if (!proxyPort || proxyPort < 1 || proxyPort > 65535) {
          await message(t('hosts.formProxyPortInvalid'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        if (!proxyUsername.trim()) {
          await message(t('hosts.formProxyUsernameRequired'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        if (proxyAuthType === 'key' && !proxyKeyId.trim()) {
          await message(t('hosts.formProxyKeyRequired'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        if (proxyAuthType === 'certificate' && !proxyCertId.trim()) {
          await message(t('hosts.formProxyCertRequired'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
      }
    }

    const hostData: Omit<Host, 'id'> = {
      name: nextName,
      host: nextHost,
      port,
      accountId: selectedAccount?.id,
      username: selectedAccount?.username || nextManualUsername,
      status: editingHost?.status || 'disconnected',
      authType: selectedAccount?.authType || manualAuthType,
      password: selectedAccount
        ? selectedAccount.authType === 'password'
          ? selectedAccount.password
          : undefined
        : manualAuthType === 'password'
          ? nextManualPassword
          : undefined,
      keyId: selectedAccount
        ? selectedAccount.authType === 'key'
          ? selectedAccount.keyId
          : undefined
        : manualAuthType === 'key'
          ? nextManualKeyId
          : undefined,
      certificateId: selectedAccount
        ? selectedAccount.authType === 'certificate'
          ? selectedAccount.certificateId
          : undefined
        : manualAuthType === 'certificate'
          ? nextManualCertId
          : undefined,
      useProxy,
      proxyHostId: useProxy && proxyMode === 'existing' ? selectedProxyHost?.id : undefined,
      proxyAuthType: useProxy
        ? proxyMode === 'existing'
          ? normalizeHostAuthType(selectedProxyAccount?.authType || selectedProxyHost?.authType)
          : proxyAuthType
        : undefined,
      proxyKeyId: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyAccount?.keyId ?? selectedProxyHost?.keyId
          : proxyAuthType === 'key'
            ? proxyKeyId.trim()
            : undefined
        : undefined,
      proxyCertId: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyAccount?.certificateId ?? selectedProxyHost?.certificateId
          : proxyAuthType === 'certificate'
            ? proxyCertId.trim()
            : undefined
        : undefined,
      proxyHost: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyHost?.host
          : proxyHost.trim()
        : undefined,
      proxyPort: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyHost?.port
          : proxyPort
        : undefined,
      proxyUsername: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyAccount?.username ?? selectedProxyHost?.username
          : proxyUsername.trim()
        : undefined,
      proxyPassword: useProxy
        ? proxyMode === 'existing'
          ? selectedProxyAccount?.password ?? selectedProxyHost?.password
          : proxyAuthType === 'password'
            ? proxyPassword
            : undefined
        : undefined,
    };

    if (editingHost) {
      await updateHost(editingHost.id, hostData);
    } else {
      await addHost(hostData);
    }

    setSheetOpen(false);
    setEditingHost(null);
    await loadHosts();
  };

  // ============ 派生数据 ============
  // 活跃 SSH 会话键：**只收集 terminal（SSH）标签**——主机「已连接」由 SSH 会话驱动，
  // SFTP 文件浏览会话不算（连接类型隔离）；hostId 精准匹配，无来源标签回退 host:port
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

  // 实时主机状态：优先按主机条目 id 精准匹配；无 hostId 来源的会话按地址兜底
  const liveHostStatus = (host: Host): 'connected' | 'disconnected' | 'error' => {
    if (activeSshKeys.byHostId.has(host.id)) return 'connected';
    if (activeSshKeys.byAddr.has(`${host.host}:${host.port}`)) return 'connected';
    return normalizeHostStatus(host.status);
  };

  const filteredHosts = hosts.filter((host) => {
    if (authFilter !== 'all') {
      if (authFilter === 'proxy' && !host.useProxy) return false;
      if (authFilter !== 'proxy') {
        const authType = resolveHostAuthType(host);
        if (authType !== authFilter) return false;
      }
    }
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const accountName = resolveHostAccountName(host)?.toLowerCase() || '';
    const username = resolveHostUsername(host).toLowerCase();
    return (
      host.name.toLowerCase().includes(query) ||
      host.host.toLowerCase().includes(query) ||
      username.includes(query) ||
      accountName.includes(query) ||
      host.port.toString().includes(query)
    );
  });

  const groups: { key: Host['status']; label: string; items: Host[] }[] = (
    [
      { key: 'connected', label: 'hosts.groupConnected', items: [] },
      { key: 'disconnected', label: 'hosts.groupDisconnected', items: [] },
      { key: 'error', label: 'hosts.groupError', items: [] },
    ] as { key: Host['status']; label: string; items: Host[] }[]
  )
    .map((group) => ({ ...group, items: filteredHosts.filter((h) => liveHostStatus(h) === group.key) }))
    .filter((group) => group.items.length > 0);

  const connectedCount = hosts.filter((h) => liveHostStatus(h) === 'connected').length;

  const selectedProxyHost = availableProxyHosts.find((host) => host.id === selectedProxyHostId);
  const selectedAccount =
    authSource === 'account'
      ? accounts.find((account) => account.id === selectedAccountId)
      : undefined;
  const selectedAccountKey = keys.find((key) => key.id === selectedAccount?.keyId);
  const selectedManualKey = keys.find((key) => key.id === manualKeyId);
  const selectedManualCert = certs.find((cert) => cert.id === manualCertId);
  const isAccountAuthMode = authSource === 'account';

  // 表单有效性：任一必填项不满足即禁用「添加/保存」按钮
  const isFormValid = (() => {
    if (!name.trim() || !host.trim()) return false;
    if (!port || port < 1 || port > 65535) return false;

    if (authSource === 'account') {
      if (!selectedAccountId) return false;
    } else {
      if (!manualUsername.trim()) return false;
      if (manualAuthType === 'key' && !manualKeyId.trim()) return false;
      if (manualAuthType === 'certificate' && !manualCertId.trim()) return false;
    }

    if (useProxy) {
      if (proxyMode === 'existing') {
        if (!selectedProxyHostId) return false;
      } else {
        if (!proxyHost.trim()) return false;
        if (!proxyPort || proxyPort < 1 || proxyPort > 65535) return false;
        if (!proxyUsername.trim()) return false;
        if (proxyAuthType === 'key' && !proxyKeyId.trim()) return false;
        if (proxyAuthType === 'certificate' && !proxyCertId.trim()) return false;
      }
    }

    return true;
  })();

  const formatLastConnected = (lastConnected?: string) => {
    if (!lastConnected) return t('hosts.neverConnected');
    return new Date(lastConnected).toLocaleString('zh-CN');
  };

  const fieldLabel = (children: React.ReactNode) => (
    <Label className="mb-1.5 block text-xs font-medium">{children}</Label>
  );
  const fieldHint = (children: React.ReactNode) => (
    <p className="mt-2 text-xs text-muted-foreground">{children}</p>
  );

  const renderHostCard = (host: Host) => {
    return (
      <div
        key={host.id}
        className="group flex items-center gap-2.5 rounded-lg bg-card p-3 ring-1 ring-foreground/[0.06] transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/50 hover:shadow-md"
      >
        {/* 图标块 + 状态角标 */}
        <div className="relative shrink-0">
          <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-accent">
            <IconServer size={15} strokeWidth={2} />
          </div>
          {statusCornerBadge(liveHostStatus(host))}
        </div>

        {/* 名称 + 地址 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{host.name}</span>
            {authIcon(resolveHostAuthType(host))}
            {host.useProxy && <IconServer size={12} className="shrink-0 text-warning" />}
          </div>
          <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted-foreground">
            <IconGlobe size={10} className="shrink-0 opacity-60" />
            {resolveHostUsername(host)}@{host.host}:{host.port}
          </div>
        </div>

        {/* 右侧操作：连接 + 更多菜单（SFTP/编辑/复制/删除收纳） */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => void handleConnect(host)}
            title={t('hosts.connect')}
            aria-label={t('hosts.connect')}
          >
            <IconTerminal size={14} strokeWidth={2} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-8"
                aria-label={t('hosts.moreActions')}
              >
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => handleSftpConnect(host)}>
                <IconFolderOpen size={15} className="mr-2" /> {t('hosts.openSftp')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openVncDialog(host)}>
                <IconMonitor size={15} className="mr-2" /> {t('hosts.openVnc')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleMoshConnect(host)}>
                <IconRadio size={15} className="mr-2" /> {t('hosts.openMosh')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void openEdit(host)}>
                <IconEdit size={15} className="mr-2" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleCopyCommand(host)}>
                {copiedId === host.id ? <IconCheck size={15} className="mr-2 text-success" /> : <IconCopy size={15} className="mr-2" />}
                {copiedId === host.id ? t('hosts.copiedCommand') : t('hosts.copySshCommand')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(host.id)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderHostRow = (host: Host) => {
    const authType = resolveHostAuthType(host);
    return (
      <TableRow key={host.id} className="group transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
        <TableCell className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-accent">
              <IconServer size={15} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{host.name}</span>
                {host.useProxy && <IconServer size={12} className="shrink-0 text-warning" />}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {resolveHostUsername(host)}@{host.host}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <span className="font-mono text-sm text-muted-foreground">{host.port}</span>
        </TableCell>
        <TableCell>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {authBadge(authType)}
            {host.useProxy && (
              <Badge variant="outline" className="gap-1 font-normal text-warning">
                <IconServer size={11} /> {t('hosts.jump')}
              </Badge>
            )}
            {resolveHostAccountName(host) && (
              <span className="truncate text-xs text-muted-foreground">{resolveHostAccountName(host)}</span>
            )}
          </div>
        </TableCell>
        <TableCell>{statusIcon(liveHostStatus(host))}</TableCell>
        <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
          {formatLastConnected(host.lastConnected)}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" onClick={() => void handleConnect(host)}>
              <IconTerminal size={14} strokeWidth={2} />
              {t('hosts.connect')}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => handleSftpConnect(host)}
              title={t('hosts.openSftp')}
            >
              <IconFolderOpen size={14} strokeWidth={2} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('hosts.moreActions')}
                >
                  <IconMore size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => openVncDialog(host)}>
                  <IconMonitor size={15} className="mr-2" /> {t('hosts.openVnc')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleMoshConnect(host)}>
                  <IconRadio size={15} className="mr-2" /> {t('hosts.openMosh')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void openEdit(host)}>
                  <IconEdit size={15} className="mr-2" /> {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleCopyCommand(host)}>
                  {copiedId === host.id ? <IconCheck size={15} className="mr-2 text-success" /> : <IconCopy size={15} className="mr-2" />}
                  {copiedId === host.id ? t('hosts.copiedCommand') : t('hosts.copySshCommand')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(host.id)}>
                  <IconTrash size={15} className="mr-2" /> {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
    );
  };

  const renderLoading = () => {
    const cardSkeleton = (i: number) => (
      <div key={i} className="flex items-center gap-2.5 rounded-lg bg-card p-3">
        <div className="relative shrink-0">
          <Skeleton className="size-8 rounded-lg" />
          <span className="absolute -right-1 -top-1 size-3 rounded-full bg-muted-foreground/10" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-3/5" />
        </div>
        <div className="flex shrink-0 gap-1">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
        </div>
      </div>
    );
    const rowSkeleton = (i: number) => (
      <TableRow key={i}>
        <TableCell>
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        </TableCell>
        <TableCell>
          <Skeleton className="h-3.5 w-8" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-5 w-16 rounded-full" />
        </TableCell>
        <TableCell>
          <Skeleton className="size-2 rounded-full" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-3.5 w-24" />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
          </div>
        </TableCell>
      </TableRow>
    );
    return (
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="size-1.5 rounded-full" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-7 rounded-full" />
          </div>
          {viewMode === 'grid' ? (
            <div
              className="grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}
            >
              {Array.from({ length: 6 }).map((_, i) => cardSkeleton(i))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border/60">
              <Table>
                <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="w-[42%] min-w-[240px]">{t('hosts.tableHost')}</TableHead>
                    <TableHead className="w-16">{t('hosts.tablePort')}</TableHead>
                    <TableHead>{t('hosts.tableAuth')}</TableHead>
                    <TableHead className="w-12">{t('hosts.tableStatus')}</TableHead>
                    <TableHead className="w-40">{t('hosts.tableLastConnected')}</TableHead>
                    <TableHead className="w-36 text-right">{t('hosts.tableActions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>{Array.from({ length: 6 }).map((_, i) => rowSkeleton(i))}</TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    );
  };

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <IconServer size={24} strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-semibold tracking-tight">{searchQuery || authFilter !== 'all' ? t('hosts.emptySearch') : t('hosts.emptyNone')}</h3>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
        {searchQuery || authFilter !== 'all'
          ? t('hosts.emptySearchDesc', { query: searchQuery || t('common.currentFilter') })
          : t('hosts.emptyNoneDesc')}
      </p>
      {!(searchQuery || authFilter !== 'all') && (
        <div className="mt-5 flex items-center gap-2">
          <Button onClick={() => void openCreate()}>
            <IconPlus size={16} /> {t('hosts.createHost')}
          </Button>
        </div>
      )}
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <IconAlert size={24} strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-semibold tracking-tight">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('hosts.loadFailed')}</p>
      <Button variant="secondary" className="mt-5" onClick={refresh}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground">{t('hosts.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t('hosts.hostCount', { count: filteredHosts.length })}
            {connectedCount > 0 && t('hosts.connectedCountSuffix', { count: connectedCount })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('hosts.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
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
          <Button variant="ghost" size="icon" onClick={refresh} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button variant="outline" onClick={handleSerialQuickConnect} title={t('hosts.serialTerminal')}>
            <IconUsb size={15} strokeWidth={2} />
            {t('hosts.serialTerminal')}
          </Button>
          <Button onClick={() => void openCreate()} title={t('hosts.createHost')}>
            <IconPlus size={16} strokeWidth={2} />
            {t('hosts.add')}
          </Button>
        </div>
      </div>

      {/* ===== 筛选 chips ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {filterChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setAuthFilter(chip.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              authFilter === chip.key
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
        ) : error && hosts.length === 0 ? (
          renderError()
        ) : filteredHosts.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      group.key === 'connected'
                        ? 'bg-success'
                        : group.key === 'error'
                          ? 'bg-destructive'
                          : 'bg-muted-foreground/40',
                    )}
                  />
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{t(group.label)}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                {viewMode === 'grid' ? (
                  <div
                    className="grid gap-2.5"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}
                  >
                    {group.items.map((host) => renderHostCard(host))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border/60">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[42%] min-w-[240px]">{t('hosts.tableHost')}</TableHead>
                          <TableHead className="w-16">{t('hosts.tablePort')}</TableHead>
                          <TableHead>{t('hosts.tableAuth')}</TableHead>
                          <TableHead className="w-12">{t('hosts.tableStatus')}</TableHead>
                          <TableHead className="w-40">{t('hosts.tableLastConnected')}</TableHead>
                          <TableHead className="w-36 text-right">{t('hosts.tableActions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((host) => renderHostRow(host))}</TableBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 新增/编辑主机抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{editingHost ? t('hosts.editHost') : t('hosts.createHost')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('hosts.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('hosts.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('common.name')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="host" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  {fieldLabel(
                    <>
                      {t('hosts.formHostAddress')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100"
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
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>
            </div>

            {/* 认证方式 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('hosts.authSection')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('hosts.authManualDesc')}
                </div>
              </div>

              <div>
                {fieldLabel(t('hosts.authSource'))}
                <Select value={authSource} onValueChange={(v) => setAuthSource(v as AuthSource)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="account" disabled={accounts.length === 0}>
                      {t('hosts.authSourceAccount')}
                    </SelectItem>
                    <SelectItem value="manual">{t('hosts.authSourceManual')}</SelectItem>
                  </SelectContent>
                </Select>
                {fieldHint(
                  isAccountAuthMode
                    ? t('hosts.authSourceAccountDesc')
                    : t('hosts.authSourceManualDesc'),
                )}
              </div>

              {isAccountAuthMode ? (
                <>
                  {accounts.length === 0 ? (
                    <div className={noticeWarningClass}>
                      <p className="text-sm">
                        {t('hosts.noAccountsHint')}
                      </p>
                    </div>
                  ) : (
                    <div>
                      {fieldLabel(
                        <>
                          {t('hosts.savedAccount')} <span className="text-destructive">*</span>
                        </>,
                      )}
                      <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('hosts.selectAccountPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.name} / {account.username} / {getAuthTypeText(account.authType)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {selectedAccount && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground">
                      <div>
                        <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.accountName')}</div>
                        <div className="mt-0.5 truncate">{selectedAccount.name}</div>
                      </div>
                      <div>
                        <div className="text-[11px] tracking-wide text-muted-foreground">{t('common.username')}</div>
                        <div className="mt-0.5 truncate">{selectedAccount.username}</div>
                      </div>
                      <div>
                        <div className="text-[11px] tracking-wide text-muted-foreground">{t('common.auth')}</div>
                        <div className="mt-0.5">{getAuthTypeText(selectedAccount.authType)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.accountKey')}</div>
                        <div className="mt-0.5 truncate text-muted-foreground">
                          {selectedAccount.authType === 'key'
                            ? selectedAccountKey?.name || selectedAccount.keyId || t('hosts.notSelected')
                            : t('hosts.notNeeded')}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div>
                    {fieldLabel(
                      <>
                        {t('common.username')} <span className="text-destructive">*</span>
                      </>,
                    )}
                    <Input
                      type="text"
                      value={manualUsername}
                      onChange={(e) => setManualUsername(e.target.value)}
                      placeholder="root"
                    />
                  </div>

                  <div>
                    {fieldLabel(t('account.authType'))}
                    <Select value={manualAuthType} onValueChange={(v) => setManualAuthType(v as 'password' | 'key' | 'certificate' | 'none')}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">{t('hosts.authTypePasswordOption')}</SelectItem>
                        <SelectItem value="key">{t('hosts.authTypeKeyOption')}</SelectItem>
                        <SelectItem value="certificate">{t('hosts.authTypeCertOption')}</SelectItem>
                        <SelectItem value="none">{t('hosts.authTypeNoneDesc')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {manualAuthType === 'password' && (
                    <div>
                      {fieldLabel(t('hosts.authTypePassword'))}
                      <Input
                        type="password"
                        value={manualPassword}
                        onChange={(e) => setManualPassword(e.target.value)}
                        placeholder="••••••••"
                      />
                    </div>
                  )}

                  {manualAuthType === 'key' && (
                    <div>
                      {fieldLabel(
                        <>
                          {t('hosts.accountKey')} <span className="text-destructive">*</span>
                        </>,
                      )}
                      <Select value={manualKeyId} onValueChange={setManualKeyId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('hosts.selectKeyPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {keys.map((key) => (
                            <SelectItem key={key.id} value={key.id}>
                              {key.name} / {key.type} / {key.fingerprint}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {fieldHint(
                        keys.length === 0
                          ? t('hosts.noKeysHint')
                          : selectedManualKey
                            ? t('hosts.currentKey', { name: selectedManualKey.name })
                            : t('hosts.keysFromManager'),
                      )}
                    </div>
                  )}

                  {manualAuthType === 'certificate' && (
                    <div>
                      {fieldLabel(
                        <>
                          {t('hosts.sshCertLabel')} <span className="text-destructive">*</span>
                        </>,
                      )}
                      <Select value={manualCertId} onValueChange={setManualCertId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('hosts.selectCertPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {certs.map((cert) => (
                            <SelectItem key={cert.id} value={cert.id}>
                              {cert.name} / {cert.type} / {cert.hasPrivateKey ? t('hosts.certBound') : t('hosts.certUnbound')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {fieldHint(
                        certs.length === 0
                          ? t('hosts.noCertsHint')
                          : selectedManualCert
                            ? t('hosts.currentCert', { name: selectedManualCert.name, suffix: selectedManualCert.hasPrivateKey ? '' : t('hosts.currentCertNoKey') })
                            : t('hosts.certsFromManager'),
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 跳板机 */}
            <div className={sectionClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('hosts.jumpSection')}</div>
                  <div className="text-xs text-muted-foreground">{t('hosts.jumpDesc')}</div>
                </div>
                <Switch checked={useProxy} onCheckedChange={setUseProxy} />
              </div>

              {useProxy && (
                <div className="flex flex-col gap-3">
                  {availableProxyHosts.length > 0 && (
                    <div className="flex flex-col gap-2.5">
                      <div className="text-xs font-medium text-muted-foreground">{t('hosts.jumpSource')}</div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={proxyMode === 'existing' ? 'default' : 'outline'}
                          onClick={() => setProxyMode('existing')}
                        >
                          {t('hosts.jumpExisting')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={proxyMode === 'manual' ? 'default' : 'outline'}
                          onClick={() => setProxyMode('manual')}
                        >
                          {t('hosts.jumpManual')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {proxyMode === 'existing' && availableProxyHosts.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      <div>
                        {fieldLabel(
                          <>
                            {t('hosts.jumpSelectHost')} <span className="text-destructive">*</span>
                          </>,
                        )}
                        <Select value={selectedProxyHostId} onValueChange={setSelectedProxyHostId}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('hosts.selectHostPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {availableProxyHosts.map((host) => (
                              <SelectItem key={host.id} value={host.id}>
                                {host.name} / {resolveHostUsername(host)}@{host.host}:{host.port}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedProxyHost && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground">
                          <div>
                            <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.jumpHostAddress')}</div>
                            <div className="mt-0.5 truncate font-mono">
                              {selectedProxyHost.host}:{selectedProxyHost.port}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.jumpHostUsername')}</div>
                            <div className="mt-0.5 truncate">{resolveHostUsername(selectedProxyHost)}</div>
                          </div>
                          <div>
                            <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.jumpHostAuth')}</div>
                            <div className="mt-0.5">{getAuthTypeText(resolveHostAuthType(selectedProxyHost))}</div>
                          </div>
                          <div>
                            <div className="text-[11px] tracking-wide text-muted-foreground">{t('hosts.jumpHostName')}</div>
                            <div className="mt-0.5 truncate text-muted-foreground">{selectedProxyHost.name}</div>
                          </div>
                          <p className="col-span-2 text-xs text-muted-foreground">{t('hosts.jumpReuseNote')}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2">
                          {fieldLabel(
                            <>
                              {t('hosts.jumpAddressRequired')} <span className="text-destructive">*</span>
                            </>,
                          )}
                          <Input
                            type="text"
                            value={proxyHost}
                            onChange={(e) => setProxyHost(e.target.value)}
                            placeholder="proxy.example.com"
                          />
                        </div>
                        <div>
                          {fieldLabel(
                            <>
                              {t('hosts.jumpPort')} <span className="text-destructive">*</span>
                            </>,
                          )}
                          <Input
                            type="number"
                            value={proxyPort}
                            onChange={(e) => setProxyPort(Number(e.target.value))}
                            min={1}
                            max={65535}
                          />
                        </div>
                      </div>
                      <div>
                        {fieldLabel(
                          <>
                            {t('hosts.jumpUsername')} <span className="text-destructive">*</span>
                          </>,
                        )}
                        <Input
                          type="text"
                          value={proxyUsername}
                          onChange={(e) => setProxyUsername(e.target.value)}
                          placeholder="proxy_user"
                        />
                      </div>
                      <div>
                        {fieldLabel(t('hosts.jumpAuthType'))}
                        <Select value={proxyAuthType} onValueChange={(v) => setProxyAuthType(v as 'password' | 'key' | 'certificate')}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="password">{t('hosts.authTypePassword')}</SelectItem>
                            <SelectItem value="key">{t('hosts.authTypeKey')}</SelectItem>
                            <SelectItem value="certificate">{t('hosts.authTypeCertificate')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {proxyAuthType === 'password' && (
                        <div>
                          {fieldLabel(t('hosts.jumpPassword'))}
                          <Input
                            type="password"
                            value={proxyPassword}
                            onChange={(e) => setProxyPassword(e.target.value)}
                            placeholder="••••••••"
                          />
                          {fieldHint(t('hosts.jumpPasswordHint'))}
                        </div>
                      )}
                      {proxyAuthType === 'key' && (
                        <div>
                          {fieldLabel(
                            <>
                              {t('hosts.jumpKey')} <span className="text-destructive">*</span>
                            </>,
                          )}
                          <Select value={proxyKeyId} onValueChange={setProxyKeyId}>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder={t('hosts.selectKeyPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {keys.map((key) => (
                                <SelectItem key={key.id} value={key.id}>
                                  {key.name} / {key.type} / {key.fingerprint}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fieldHint(t('hosts.jumpKeysFromManager'))}
                        </div>
                      )}
                      {proxyAuthType === 'certificate' && (
                        <div>
                          {fieldLabel(
                            <>
                              {t('hosts.jumpCert')} <span className="text-destructive">*</span>
                            </>,
                          )}
                          <Select value={proxyCertId} onValueChange={setProxyCertId}>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder={t('hosts.selectCertPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {certs.map((cert) => (
                                <SelectItem key={cert.id} value={cert.id}>
                                  {cert.name} / {cert.type} / {cert.hasPrivateKey ? t('hosts.certBound') : t('hosts.certUnbound')}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fieldHint(t('hosts.jumpCertHint'))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={!isFormValid}
            >
              {editingHost ? t('hosts.saveChanges') : t('hosts.addHost')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* VNC 快捷连接对话框：目标主机固定为所选主机，端口/密码可填 */}
      <Dialog
        open={!!vncDialogHost}
        onOpenChange={(o) => {
          if (!o) setVncDialogHost(null);
        }}
      >
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('hosts.vncDialogTitle')}</DialogTitle>
          </DialogHeader>
          {vncDialogHost && (
            <div className="space-y-3 py-1">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2">
                <span className="shrink-0 text-sm text-muted-foreground">{t('hosts.vncTarget')}</span>
                <span className="truncate font-mono text-sm font-medium">
                  {vncDialogHost.name} · {vncDialogHost.host}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vnc-port">{t('hosts.vncPort')}</Label>
                  <Input
                    id="vnc-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={vncDialogPort}
                    onChange={(e) => setVncDialogPort(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vnc-password">{t('hosts.vncPassword')}</Label>
                  <Input
                    id="vnc-password"
                    type="password"
                    value={vncDialogPassword}
                    placeholder={t('hosts.vncPasswordPlaceholder')}
                    onChange={(e) => setVncDialogPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleVncConnect();
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setVncDialogHost(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleVncConnect} disabled={!vncDialogHost}>
              {t('hosts.vncConnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
