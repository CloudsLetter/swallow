import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search as IconSearch,
  Server as IconServer,
  Clock as IconClock,
  Network as IconNetwork,
  Zap as IconZap,
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
import { useTabStore } from '../store/tabStore';
import { cn } from '@/lib/utils';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { message } from '@tauri-apps/plugin-dialog';

/** 本地终端可选的 shell 类型。 */
const SHELL_OPTIONS = [
  { value: 'cmd', label: 'cmd' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'wsl', label: 'WSL' },
  { value: 'bash', label: 'Git Bash' },
] as const;

export function QuickConnect() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [telnetHost, setTelnetHost] = useState('');
  const [telnetPort, setTelnetPort] = useState(23);
  const [localShell, setLocalShell] = useState('cmd');
  const { createTab, closeTab, activeTabId } = useTabStore();
  const { t } = useTranslation();

  useEffect(() => {
    const loadHosts = async () => {
      const [hostList, accountList, keyList, certList] = await Promise.all([
        getHosts(),
        getAccounts(),
        getKeys(),
        getCertificates().catch(() => [] as Certificate[]),
      ]);
      setHosts(hostList);
      setAccounts(accountList);
      setKeys(keyList);
      setCerts(certList);
    };
    loadHosts();
  }, []);

  /** 打开连接标签并关闭当前快速连接标签。 */
  const openSessionTab = (name: string, type: 'terminal' | 'telnet' | 'local', config: Record<string, unknown>) => {
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

  // 快速 telnet 连接（无认证，明文协议）
  const handleConnectTelnet = async () => {
    const host = telnetHost.trim();
    if (!host) {
      await message(t('quickConnect.telnetHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    openSessionTab(`telnet:${host}`, 'telnet', { telnetConfig: { host, port: telnetPort } });
  };

  // 启动本地终端（cmd/powershell/pwsh/wsl/bash）
  const handleConnectLocal = () => {
    openSessionTab(`${localShell} (local)`, 'local', { localConfig: { shell: localShell } });
  };

  // 过滤 + 按最近连接时间排序
  const filteredHosts = hosts.filter(
    (host) =>
      host.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      host.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
      host.username.toLowerCase().includes(searchQuery.toLowerCase()),
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
        ? 'bg-emerald-500'
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

  return (
    <div className="flex h-full flex-col">
      {/* 页头：标题 + 搜索 */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <h2 className="text-lg font-semibold">{t('quickConnect.title')}</h2>
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

      {/* 快捷入口：Telnet + 本地终端并排卡片（单行紧凑） */}
      <div className="grid shrink-0 grid-cols-1 gap-3 border-b border-border px-6 py-4 md:grid-cols-2">
        {/* Telnet */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <span className="flex w-24 shrink-0 items-center gap-1.5 text-sm font-medium">
            <IconNetwork size={15} className="text-muted-foreground" />
            {t('quickConnect.telnetTitle')}
          </span>
          <Input
            type="text"
            placeholder={t('quickConnect.telnetHost')}
            value={telnetHost}
            onChange={(e) => setTelnetHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConnectTelnet();
            }}
            className="h-8 min-w-0 flex-1"
          />
          <Input
            type="number"
            value={telnetPort}
            min={1}
            max={65535}
            onChange={(e) => setTelnetPort(Number(e.target.value) || 23)}
            className="h-8 w-16 shrink-0"
          />
          <Button size="sm" className="h-8 shrink-0" onClick={() => void handleConnectTelnet()}>
            {t('quickConnect.telnetConnect')}
          </Button>
        </div>

        {/* 本地终端 */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <span className="flex w-24 shrink-0 items-center gap-1.5 text-sm font-medium">
            <IconZap size={15} className="text-muted-foreground" />
            {t('quickConnect.localShell')}
          </span>
          <Select value={localShell} onValueChange={setLocalShell}>
            <SelectTrigger className="h-8 min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHELL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 shrink-0" onClick={() => void handleConnectLocal()}>
            {t('quickConnect.localConnect')}
          </Button>
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
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('quickConnect.tableHost')}</TableHead>
                    <TableHead>{t('quickConnect.tableAddress')}</TableHead>
                    <TableHead>{t('quickConnect.tableLastConnected')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentHosts.map((host) => (
                    <TableRow key={host.id}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <IconServer size={15} />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{host.name}</div>
                            <div className="truncate text-xs text-muted-foreground">
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
                      <TableCell className="text-sm text-muted-foreground">
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
