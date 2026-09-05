import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import {
  getPortForwardings,
  addPortForwarding,
  updatePortForwarding,
  removePortForwarding,
  testPortForwardTarget,
  startPortForward,
  stopPortForward,
  getHosts,
  type PortForwarding,
  type Host,
} from '../services/dataService';
import { acceptHostKey } from '../services/sessionService';
import { listen } from '@tauri-apps/api/event';
import {
  Cable as IconCable,
  Plus as IconPlus,
  Pencil as IconEdit,
  Trash2 as IconTrash,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  MoreHorizontal as IconMore,
  Zap as IconZap,
  Play as IconPlay,
  Power as IconPower,
  Loader2 as IconLoader,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
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
type RuleType = PortForwarding['type'];
type TypeFilter = 'all' | RuleType;

const sectionClass = 'flex flex-col gap-3 rounded-lg bg-muted/40 p-4';

function normalizeRuleStatus(status?: PortForwarding['status']): 'connected' | 'disconnected' | 'error' {
  if (status === 'connected') return 'connected';
  if (status === 'error') return 'error';
  return 'disconnected';
}

const TYPE_META: Record<RuleType, { label: string; desc: string; cls: string }> = {
  local: { label: 'portForwarding.typeLocal', desc: 'portForwarding.typeLocalDesc', cls: 'bg-info/10 text-info' },
  remote: { label: 'portForwarding.typeRemote', desc: 'portForwarding.typeRemoteDesc', cls: 'bg-warning/10 text-warning' },
  dynamic: { label: 'portForwarding.typeDynamic', desc: 'portForwarding.typeDynamicDesc', cls: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
};

const typeMeta = (type: string) =>
  TYPE_META[type as RuleType] ?? {
    label: type || 'common.unknown',
    desc: '',
    cls: 'bg-muted text-muted-foreground',
  };

const typeBadge = (type: RuleType) => {
  const meta = typeMeta(type);
  return <Badge variant="outline" className={cn('font-normal', meta.cls)}>{i18n.t(meta.label)}</Badge>;
};

/** 状态角标：已连接=绿点（光晕）/ 错误=红点 / 未连接=灰点（不显示文字，hover 提示状态）。 */
const statusDot = (status: PortForwarding['status']) => {
  const normalized = normalizeRuleStatus(status);
  const text = i18n.t(
    normalized === 'connected'
      ? 'portForwarding.statusConnected'
      : normalized === 'error'
        ? 'portForwarding.statusError'
        : 'portForwarding.statusDisconnected',
  );
  const cls =
    normalized === 'connected'
      ? 'bg-success ring-2 ring-success/20'
      : normalized === 'error'
        ? 'bg-destructive ring-2 ring-destructive/20'
        : 'bg-muted-foreground/40';
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', cls)} title={text} />;
};

const filterChips: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'local', label: 'portForwarding.typeLocal' },
  { key: 'remote', label: 'portForwarding.typeRemote' },
  { key: 'dynamic', label: 'portForwarding.typeDynamic' },
];

interface RuleForm {
  name: string;
  type: RuleType;
  hostId: string;
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  description: string;
  socksUsername: string;
  socksPassword: string;
}

const EMPTY_FORM: RuleForm = {
  name: '',
  type: 'local',
  hostId: '',
  listenHost: '127.0.0.1',
  listenPort: 1080,
  targetHost: '',
  targetPort: 80,
  description: '',
  socksUsername: '',
  socksPassword: '',
};

export function PortForwarding() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [rules, setRules] = useState<PortForwarding[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingRule, setEditingRule] = useState<PortForwarding | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busyRuleIds, setBusyRuleIds] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // ============ 数据加载 ============
  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      try {
        const [ruleList, hostList] = await Promise.all([getPortForwardings(), getHosts()]);
        setRules(ruleList);
        setHosts(hostList);
      } catch (loadError) {
        console.error('Failed to load port forwardings:', loadError);
        setError(t('portForwarding.loadFailedMsg'));
      } finally {
        setLoading(false);
      }
    };
    void bootstrap();
  }, []);

  // ============ 隧道断开事件 ============
  // 后端看门狗检测到隧道意外断开时推送事件，前端即时刷新状态。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const attach = async () => {
      try {
        unlisten = await listen<{ ruleId: string; status: string }>(
          'port-forward-status',
          (event) => {
            // 用 payload 定向更新对应规则，避免全量 reload
            const { ruleId, status } = event.payload;
            setRules((prev) =>
              prev.map((r) => (r.id === ruleId ? { ...r, status: status as PortForwarding['status'] } : r)),
            );
          },
        );
      } catch (e) {
        console.error('Failed to listen port-forward-status:', e);
      }
    };
    void attach();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ruleList, hostList] = await Promise.all([getPortForwardings(), getHosts()]);
      setRules(ruleList);
      setHosts(hostList);
    } catch (loadError) {
      console.error('Failed to load port forwardings:', loadError);
      setError(t('portForwarding.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  // ============ 表单逻辑 ============
  const openCreate = () => {
    setEditingRule(null);
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  };

  const openEdit = (rule: PortForwarding) => {
    setEditingRule(rule);
    setForm({
      name: rule.name,
      type: rule.type,
      hostId: rule.hostId || '',
      listenHost: rule.listenHost || '127.0.0.1',
      listenPort: rule.listenPort,
      targetHost: rule.targetHost || '',
      targetPort: rule.targetPort,
      description: rule.description || '',
      socksUsername: rule.socksUsername || '',
      socksPassword: rule.socksPassword || '',
    });
    setSheetOpen(true);
  };

  const isFormValid = (() => {
    if (!form.name.trim()) return false;
    if (!form.listenPort || form.listenPort < 1 || form.listenPort > 65535) return false;
    if (form.type !== 'dynamic') {
      if (!form.targetHost.trim()) return false;
      if (!form.targetPort || form.targetPort < 1 || form.targetPort > 65535) return false;
    }
    return true;
  })();

  const handleSave = async () => {
    const nextName = form.name.trim();
    if (!nextName) {
      toast.warning(t('portForwarding.formNameRequired'));
      return;
    }
    if (!form.listenPort || form.listenPort < 1 || form.listenPort > 65535) {
      toast.warning(t('portForwarding.listenPortInvalid'));
      return;
    }
    if (form.type !== 'dynamic') {
      if (!form.targetHost.trim()) {
        toast.warning(t('portForwarding.targetHostRequired'));
        return;
      }
      if (!form.targetPort || form.targetPort < 1 || form.targetPort > 65535) {
        toast.warning(t('portForwarding.targetPortInvalid'));
        return;
      }
    }

    // 安全校验：local 转发仅限回环；dynamic 未配置认证时仅限回环，配置认证后允许非回环
    if (form.type === 'local') {
      const lh = form.listenHost.trim().toLowerCase();
      const isLoopback = lh === 'localhost' || lh === '::1' || lh.startsWith('127.');
      if (lh && !isLoopback) {
        toast.warning(t('portForwarding.localLoopbackOnly'));
        return;
      }
    }
    if (form.type === 'dynamic') {
      const lh = form.listenHost.trim().toLowerCase();
      const isLoopback = lh === 'localhost' || lh === '::1' || lh.startsWith('127.');
      const hasAuth = form.socksUsername.trim() !== '' && form.socksPassword !== '';
      if (lh && !isLoopback && !hasAuth) {
        toast.warning(t('portForwarding.dynamicLoopbackOnly'));
        return;
      }
    }

    const data = {
      name: nextName,
      type: form.type,
      hostId: form.hostId || undefined,
      listenHost: form.listenHost.trim() || '127.0.0.1',
      listenPort: form.listenPort,
      targetHost: form.type === 'dynamic' ? undefined : form.targetHost.trim(),
      targetPort: form.type === 'dynamic' ? 0 : form.targetPort,
      description: form.description.trim() || undefined,
      socksUsername: form.type === 'dynamic' ? form.socksUsername.trim() || undefined : undefined,
      socksPassword: form.type === 'dynamic' ? form.socksPassword || undefined : undefined,
    };
    try {
      if (editingRule) {
        await updatePortForwarding(editingRule.id, data);
      } else {
        await addPortForwarding(data);
      }
      setSheetOpen(false);
      setEditingRule(null);
      await refresh();
    } catch (saveError) {
      console.error('Failed to save rule:', saveError);
      toast.error(t('common.saveFailed'));
    }
  };

  const handleRemove = async (rule: PortForwarding) => {
    const confirmed = await ask(t('portForwarding.deleteConfirmBody', { name: rule.name }), {
      title: t('common.deleteConfirm'),
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await removePortForwarding(rule.id);
      await refresh();
    } catch (removeError) {
      console.error('Failed to remove rule:', removeError);
      toast.error(t('common.deleteFailed'));
    }
  };

  const handleTest = async (rule: PortForwarding) => {
    if (rule.type === 'dynamic') {
      toast.info(t('portForwarding.dynamicNoTarget'));
      return;
    }
    if (rule.type === 'local') {
      toast.info(t('portForwarding.localNoDirectTest'));
      return;
    }
    if (!rule.targetHost) {
      toast.info(t('portForwarding.noTargetHost'));
      return;
    }
    setTestingId(rule.id);
    try {
      const ok = await testPortForwardTarget(rule.targetHost, rule.targetPort);
      if (ok) {
        toast.success(t('portForwarding.targetReachable', { host: rule.targetHost, port: rule.targetPort }));
      } else {
        toast.warning(t('portForwarding.targetUnreachable', { host: rule.targetHost, port: rule.targetPort }));
      }
    } catch (testError) {
      console.error('Failed to test target:', testError);
      toast.error(t('portForwarding.testFailed'));
    } finally {
      setTestingId(null);
    }
  };

  /** 轻量刷新规则列表（连接/断开后同步状态，不触发整页骨架屏）。 */
  const reloadRules = async () => {
    try {
      setRules(await getPortForwardings());
      setError(null);
    } catch (loadError) {
      console.error('Failed to reload port forwardings:', loadError);
    }
  };

  // 并发操作保护：用集合记录所有正在操作的规则，避免多规则并发时互相覆盖 loading 态
  const markBusy = (id: string) => setBusyRuleIds((prev) => new Set(prev).add(id));
  const unmarkBusy = (id: string) =>
    setBusyRuleIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const handleConnect = async (rule: PortForwarding) => {
    if (!rule.hostId) {
      toast.warning(t('portForwarding.noSshHost'));
      return;
    }
    markBusy(rule.id);
    try {
      let result = await startPortForward(rule.id);
      while (result.status === 'needsHostKeyApproval') {
        const fingerprint = result.fingerprint ?? '';
        const accepted = await ask(
          t('connection.hostKeyBody', { host: result.host, port: result.port, fingerprint }),
          {
            title: t('connection.hostKeyTitle'),
            kind: 'warning',
            okLabel: t('connection.trustAndConnect'),
            cancelLabel: t('common.cancel'),
          },
        );
        if (!accepted) {
          return;
        }
        await acceptHostKey(result.hostKeyToken!, fingerprint);
        result = await startPortForward(rule.id);
      }
      if (result.status !== 'connected') {
        throw new Error(t('portForwarding.tunnelFailed', { status: result.status }));
      }
      toast.success(t('portForwarding.tunnelEstablished', { name: rule.name }));
      await reloadRules();
    } catch (connectError) {
      console.error('Failed to start port forward:', connectError);
      toast.error(t('portForwarding.connectFailed', { message: String(connectError) }));
      await reloadRules();
    } finally {
      unmarkBusy(rule.id);
    }
  };

  const handleDisconnect = async (rule: PortForwarding) => {
    markBusy(rule.id);
    try {
      await stopPortForward(rule.id);
      toast.success(t('portForwarding.tunnelDisconnected', { name: rule.name }));
      await reloadRules();
    } catch (disconnectError) {
      console.error('Failed to stop port forward:', disconnectError);
      toast.error(t('portForwarding.disconnectFailed'));
    } finally {
      unmarkBusy(rule.id);
    }
  };

  const handleToggle = async (rule: PortForwarding) => {
    if (normalizeRuleStatus(rule.status) === 'connected') {
      await handleDisconnect(rule);
    } else {
      await handleConnect(rule);
    }
  };

  // ============ 派生数据 ============
  const hostName = (id?: string) => hosts.find((h) => h.id === id)?.name || t('common.notSpecified');

  const filteredRules = rules.filter((rule) => {
    if (typeFilter !== 'all' && rule.type !== typeFilter) return false;
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      rule.name.toLowerCase().includes(query) ||
      rule.listenHost.toLowerCase().includes(query) ||
      rule.targetHost?.toLowerCase().includes(query) ||
      hostName(rule.hostId).toLowerCase().includes(query) ||
      String(rule.listenPort).includes(query)
    );
  });

  const groups: { key: PortForwarding['status']; label: string; items: PortForwarding[] }[] = (
    [
      { key: 'connected', label: t('portForwarding.statusConnected'), items: [] },
      { key: 'disconnected', label: t('portForwarding.statusDisconnected'), items: [] },
      { key: 'error', label: t('portForwarding.statusError'), items: [] },
    ] as { key: PortForwarding['status']; label: string; items: PortForwarding[] }[]
  )
    .map((group) => ({ ...group, items: filteredRules.filter((rule) => normalizeRuleStatus(rule.status) === group.key) }))
    .filter((group) => group.items.length > 0);

  const fieldLabel = (children: React.ReactNode) => <Label className="mb-1.5 block text-xs font-medium">{children}</Label>;
  const fieldHint = (children: React.ReactNode) => <p className="mt-2 text-xs text-muted-foreground">{children}</p>;

  const renderRuleCard = (rule: PortForwarding) => {
    return (
      <div
        key={rule.id}
        className="group flex items-center gap-2.5 rounded-lg bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/50 hover:shadow-md"
      >
        <div className="relative shrink-0">
          <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-accent">
            <IconCable size={15} strokeWidth={2} />
          </div>
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card',
              normalizeRuleStatus(rule.status) === 'connected'
                ? 'bg-success ring-success/20'
                : normalizeRuleStatus(rule.status) === 'error'
                  ? 'bg-destructive ring-destructive/20'
                  : 'bg-muted-foreground/40',
            )}
            title={
              i18n.t(
                normalizeRuleStatus(rule.status) === 'connected'
                  ? 'portForwarding.statusConnected'
                  : normalizeRuleStatus(rule.status) === 'error'
                    ? 'portForwarding.statusError'
                    : 'portForwarding.statusDisconnected',
              )
            }
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{rule.name}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {rule.listenHost}:{rule.listenPort}
            <span className="text-muted-foreground/60"> → </span>
            {rule.type === 'dynamic' ? 'SOCKS5' : `${rule.targetHost || '—'}:${rule.targetPort}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            variant={normalizeRuleStatus(rule.status) === 'connected' ? 'secondary' : 'default'}
            disabled={busyRuleIds.has(rule.id)}
            onClick={() => void handleToggle(rule)}
            title={
              normalizeRuleStatus(rule.status) === 'connected'
                ? t('portForwarding.disconnect')
                : t('portForwarding.connect')
            }
            aria-label={
              normalizeRuleStatus(rule.status) === 'connected'
                ? t('portForwarding.disconnect')
                : t('portForwarding.connect')
            }
          >
            {busyRuleIds.has(rule.id) ? (
              <IconLoader size={14} strokeWidth={2} className="animate-spin" />
            ) : normalizeRuleStatus(rule.status) === 'connected' ? (
              <IconPower size={14} strokeWidth={2} />
            ) : (
              <IconPlay size={14} strokeWidth={2} />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => openEdit(rule)}>
                <IconEdit size={15} className="mr-2" /> {t('portForwarding.edit')}
              </DropdownMenuItem>
              {rule.type === 'remote' && (
                <DropdownMenuItem onClick={() => void handleTest(rule)} disabled={testingId === rule.id}>
                  <IconZap size={15} className="mr-2" /> {t('portForwarding.testTarget')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(rule)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderRuleRow = (rule: PortForwarding) => (
    <TableRow key={rule.id} className="group transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-accent">
            <IconCable size={15} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{rule.name}</span>
            {rule.description && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{rule.description}</div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{typeBadge(rule.type)}</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-sm text-muted-foreground">
        {rule.listenHost}:{rule.listenPort}
      </TableCell>
      <TableCell className="max-w-0 whitespace-nowrap font-mono text-sm text-muted-foreground">
        {rule.type === 'dynamic' ? 'SOCKS5' : `${rule.targetHost || '-'}:${rule.targetPort}`}
      </TableCell>
      <TableCell className="max-w-0 truncate text-sm text-muted-foreground">{hostName(rule.hostId)}</TableCell>
      <TableCell>{statusDot(rule.status)}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant={normalizeRuleStatus(rule.status) === 'connected' ? 'secondary' : 'default'}
            disabled={busyRuleIds.has(rule.id)}
            onClick={() => void handleToggle(rule)}
          >
            {busyRuleIds.has(rule.id) ? (
              <IconLoader size={14} className="animate-spin" />
            ) : normalizeRuleStatus(rule.status) === 'connected' ? (
              <IconPower size={14} />
            ) : (
              <IconPlay size={14} />
            )}
            {normalizeRuleStatus(rule.status) === 'connected' ? t('portForwarding.disconnect') : t('portForwarding.connect')}
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
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => openEdit(rule)}>
                <IconEdit size={15} className="mr-2" /> {t('portForwarding.edit')}
              </DropdownMenuItem>
              {rule.type === 'remote' && (
                <DropdownMenuItem onClick={() => void handleTest(rule)} disabled={testingId === rule.id}>
                  <IconZap size={15} className="mr-2" /> {t('portForwarding.testTarget')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(rule)}>
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
        colCount={7}
        head={
          <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[26%] min-w-[200px]">{t('portForwarding.tableRule')}</TableHead>
                          <TableHead>{t('portForwarding.tableType')}</TableHead>
                          <TableHead>{t('portForwarding.tableListen')}</TableHead>
                          <TableHead>{t('portForwarding.tableTarget')}</TableHead>
                          <TableHead>{t('portForwarding.tableSshHost')}</TableHead>
                          <TableHead>{t('portForwarding.tableStatus')}</TableHead>
                          <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        }
      />
    );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <IconCable size={24} strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-semibold tracking-tight">
        {searchQuery || typeFilter !== 'all' ? t('portForwarding.emptySearch') : t('portForwarding.emptyNone')}
      </h3>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
        {searchQuery || typeFilter !== 'all'
          ? t('portForwarding.emptySearchDesc', { query: searchQuery || t('common.currentFilter') })
          : t('portForwarding.emptyNoneDesc')}
      </p>
      {!(searchQuery || typeFilter !== 'all') && (
        <div className="mt-5 flex items-center gap-2">
          <Button onClick={openCreate}>
            <IconPlus size={16} /> {t('portForwarding.createRule')}
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
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('portForwarding.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-5" onClick={() => void refresh()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground">{t('portForwarding.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('portForwarding.ruleCount', { count: filteredRules.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('portForwarding.searchPlaceholder')}
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
          <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button onClick={openCreate} title={t('portForwarding.createRule')}>
            <IconPlus size={16} strokeWidth={2} />
            {t('portForwarding.add')}
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
        ) : error && rules.length === 0 ? (
          renderError()
        ) : filteredRules.length === 0 ? (
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
                    {group.items.map((rule) => renderRuleCard(rule))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border/60">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[26%] min-w-[200px]">{t('portForwarding.tableRule')}</TableHead>
                          <TableHead>{t('portForwarding.tableType')}</TableHead>
                          <TableHead>{t('portForwarding.tableListen')}</TableHead>
                          <TableHead>{t('portForwarding.tableTarget')}</TableHead>
                          <TableHead>{t('portForwarding.tableSshHost')}</TableHead>
                          <TableHead>{t('portForwarding.tableStatus')}</TableHead>
                          <TableHead className="w-32 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((rule) => renderRuleRow(rule))}</TableBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 新建/编辑规则抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{editingRule ? t('portForwarding.editRule') : t('portForwarding.createRule')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('portForwarding.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('portForwarding.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('portForwarding.ruleName')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('portForwarding.ruleNamePlaceholder')}
                />
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('portForwarding.forwardType')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as RuleType })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_META) as RuleType[]).map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(TYPE_META[type].label)} - {t(TYPE_META[type].desc)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                {fieldLabel(t('portForwarding.sshHost'))}
                <Select value={form.hostId} onValueChange={(v) => setForm({ ...form, hostId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('portForwarding.selectSshHost')} />
                  </SelectTrigger>
                  <SelectContent>
                    {hosts.map((host) => (
                      <SelectItem key={host.id} value={host.id}>
                        {host.name} / {host.host}:{host.port}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldHint(
                  hosts.length === 0
                    ? t('portForwarding.noHostsHint')
                    : t('portForwarding.hostsHint'),
                )}
              </div>
            </div>

            {/* 转发参数 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('portForwarding.forwardParams')}</div>
                <div className="text-xs text-muted-foreground">
                  {form.type === 'local' && t('portForwarding.localParamDesc')}
                  {form.type === 'remote' && t('portForwarding.remoteParamDesc')}
                  {form.type === 'dynamic' && t('portForwarding.dynamicParamDesc')}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  {fieldLabel(t('portForwarding.listenAddress'))}
                  <Input
                    type="text"
                    value={form.listenHost}
                    onChange={(e) => setForm({ ...form, listenHost: e.target.value })}
                    placeholder="127.0.0.1"
                  />
                </div>
                <div>
                  {fieldLabel(
                    <>
                      {form.type === 'remote' ? t('portForwarding.remotePort') : t('portForwarding.listenPort')}{' '}
                      <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={form.listenPort}
                    onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) })}
                  />
                </div>
              </div>
              {form.type !== 'dynamic' && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    {fieldLabel(
                      <>
                        {form.type === 'remote' ? t('portForwarding.targetAddressLocal') : t('portForwarding.targetHost')}{' '}
                        <span className="text-destructive">*</span>
                      </>,
                    )}
                    <Input
                      type="text"
                      value={form.targetHost}
                      onChange={(e) => setForm({ ...form, targetHost: e.target.value })}
                      placeholder={form.type === 'remote' ? 'localhost' : 'db.internal'}
                    />
                  </div>
                  <div>
                    {fieldLabel(
                      <>
                        {t('portForwarding.targetPort')} <span className="text-destructive">*</span>
                      </>,
                    )}
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.targetPort}
                      onChange={(e) => setForm({ ...form, targetPort: Number(e.target.value) })}
                    />
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t('portForwarding.saveHint')}</p>
            </div>

            {/* 代理认证（仅动态转发） */}
            {form.type === 'dynamic' && (
              <div className={sectionClass}>
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('portForwarding.proxyAuth')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('portForwarding.proxyAuthDesc')}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    {fieldLabel(t('portForwarding.username'))}
                    <Input
                      type="text"
                      value={form.socksUsername}
                      onChange={(e) => setForm({ ...form, socksUsername: e.target.value })}
                      placeholder={t('portForwarding.optionalPlaceholder')}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    {fieldLabel(t('portForwarding.password'))}
                    <Input
                      type="password"
                      value={form.socksPassword}
                      onChange={(e) => setForm({ ...form, socksPassword: e.target.value })}
                      placeholder={t('portForwarding.optionalPlaceholder')}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 备注 */}
            <div className={sectionClass}>
              <div>
                {fieldLabel(t('common.description'))}
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder={t('portForwarding.descriptionPlaceholder')}
                />
              </div>
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!isFormValid}>
              {editingRule ? t('portForwarding.saveChanges') : t('portForwarding.createRuleAction')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
