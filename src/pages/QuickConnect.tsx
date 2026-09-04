import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search as IconSearch,
  Server as IconServer,
  Clock as IconClock,
  Network as IconNetwork,
  Zap as IconZap,
  Monitor as IconMonitor,
  Usb as IconUsb,
  RefreshCw as IconRefresh,
  ChevronDown as IconChevronDown,
  ChevronUp as IconChevronUp,
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
import { serialListPorts } from '../services/sessionService';
import { consumeQuickConnectIntent } from '../services/quickConnectIntent';
import { useTabStore, type VncTabConfig } from '../store/tabStore';
import { useOnlineHosts } from '../store/uiState';
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
  // VNC 快速连接（直连；可展开经 SSH 隧道）
  const [vncHost, setVncHost] = useState('');
  const [vncPort, setVncPort] = useState(5900);
  const [vncPassword, setVncPassword] = useState('');
  const [vncViaSsh, setVncViaSsh] = useState(false);
  const [vncSshHostId, setVncSshHostId] = useState('');
  // 串口快速连接
  const [serialPort, setSerialPort] = useState('');
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [serialBaud, setSerialBaud] = useState('115200');
  const [serialShowAdvanced, setSerialShowAdvanced] = useState(false);
  const [serialDataBits, setSerialDataBits] = useState('8');
  const [serialStopBits, setSerialStopBits] = useState('1');
  const [serialParity, setSerialParity] = useState<'none' | 'odd' | 'even'>('none');
  const [serialFlow, setSerialFlow] = useState<'none' | 'hardware'>('none');
  // 外部「串口终端」快捷入口定位：滚动到串口卡并短暂高亮
  const serialCardRef = useRef<HTMLDivElement>(null);
  const [serialHighlight, setSerialHighlight] = useState(false);
  const { createTab, closeTab, activeTabId } = useTabStore();
  const { t } = useTranslation();

  // 消费一次性意图（Hosts 页点「串口终端」）：滚动 + 高亮串口卡
  useEffect(() => {
    if (consumeQuickConnectIntent() !== 'serial') return;
    setSerialHighlight(true);
    const timer = window.setTimeout(() => setSerialHighlight(false), 1800);
    // 等本帧渲染完成后滚动（页面可能刚创建）
    requestAnimationFrame(() => {
      serialCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.clearTimeout(timer);
  }, []);

  // 枚举本机串口
  const refreshSerialPorts = () => {
    void serialListPorts()
      .then((list) => setSerialPorts(list))
      .catch((e) => {
        console.warn('Failed to list serial ports:', e);
        setSerialPorts([]);
      });
  };
  useEffect(() => {
    refreshSerialPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const openSessionTab = (name: string, type: 'terminal' | 'telnet' | 'local' | 'vnc' | 'serial', config: Record<string, unknown>) => {
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

  // 快速连接 VNC（无密码留空：连接后如服务端要求再由 noVNC 弹窗补交）。
  // vncViaSsh = 经 SSH 隧道：跳板主机复用其已存认证（密码/密钥），目标为上方 VNC 主机:端口。
  const handleConnectVnc = async () => {
    const host = vncHost.trim();
    if (!host) {
      void message(t('quickConnect.vncHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    let sshConfig: VncTabConfig['ssh'];
    if (vncViaSsh) {
      const jump = hosts.find((h) => h.id === vncSshHostId);
      if (!jump) {
        void message(t('quickConnect.vncJumpRequired'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
      const auth = resolveHostSshAuth(jump, accounts, keys, certs);
      if (auth.error) {
        void message(auth.error, { title: t('quickConnect.cannotConnect'), kind: 'warning' });
        return;
      }
      if (auth.authType === 'certificate' || auth.authType === 'none') {
        void message(t('quickConnect.vncJumpUnsupported'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
      sshConfig = {
        sshHost: jump.host,
        sshPort: jump.port,
        sshUsername: auth.username,
        sshAuthType: auth.authType === 'key' ? 'key' : 'password',
        sshPassword: auth.password,
        sshKeyId: auth.authType === 'key' ? auth.keyId : undefined,
        targetHost: host,
        targetPort: vncPort,
      };
    }
    openSessionTab(`vnc:${host}:${vncPort}`, 'vnc', {
      vncConfig: {
        host,
        port: vncPort,
        password: vncPassword || undefined,
        shared: true,
        ssh: sshConfig,
      },
    });
  };

  // 快速连接串口（无认证；参数默认 8N1 无流控，高级区可调）
  const handleConnectSerial = () => {
    const port = serialPort.trim();
    if (!port) {
      void message(t('quickConnect.serialPortRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    openSessionTab(`serial:${port}`, 'serial', {
      serialConfig: {
        port,
        baudRate: Number(serialBaud) || 115200,
        dataBits: Number(serialDataBits) as 5 | 6 | 7 | 8,
        stopBits: Number(serialStopBits) as 1 | 2,
        parity: serialParity,
        flowControl: serialFlow,
      },
    });
  };

  // 过滤 + 按最近连接时间排序（最近连接来自 DB last_connected；在线状态纯内存实时合并）
  const online = useOnlineHosts((s) => s.online);
  const filteredHosts = hosts
    .filter(
      (host) =>
        host.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        host.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
        host.username.toLowerCase().includes(searchQuery.toLowerCase()),
    )
    .map(
      (host): Host =>
        online.has(`${host.host}:${host.port}`) && host.status !== 'connected'
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

        {/* VNC（占满第二行；可经 SSH 隧道） */}
        <div className="rounded-lg border border-border bg-card p-3 md:col-span-2">
          <div className="flex items-center gap-3">
            <span className="flex w-32 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium">
              <IconMonitor size={15} className="text-muted-foreground" />
              {t('quickConnect.vncTitle')}
            </span>
          <Input
            type="text"
            placeholder={t('quickConnect.vncHost')}
            value={vncHost}
            onChange={(e) => setVncHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConnectVnc();
            }}
            className="h-8 min-w-0 max-w-[24rem] flex-1"
          />
          <Input
            type="number"
            value={vncPort}
            min={1}
            max={65535}
            onChange={(e) => setVncPort(Number(e.target.value) || 5900)}
            className="h-8 w-16 shrink-0"
          />
          <Input
            type="password"
            placeholder={t('quickConnect.vncPassword')}
            value={vncPassword}
            onChange={(e) => setVncPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConnectVnc();
            }}
            className="h-8 w-40 shrink-0"
          />
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-8 shrink-0 px-2 text-xs', vncViaSsh && 'bg-primary/10 text-primary')}
            onClick={() => setVncViaSsh((v) => !v)}
            title={t('quickConnect.vncViaSshHint')}
          >
            {t('quickConnect.vncViaSsh')}
          </Button>
          <Button size="sm" className="h-8 shrink-0" onClick={() => void handleConnectVnc()}>
            {t('quickConnect.vncConnect')}
          </Button>
          </div>

          {/* SSH 隧道展开：跳板主机（复用其已存认证），目标 = 上方 VNC 主机:端口 */}
          {vncViaSsh && (
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-[8.75rem]">
              <span className="text-xs text-muted-foreground">{t('quickConnect.vncJumpHost')}</span>
              <Select value={vncSshHostId} onValueChange={setVncSshHostId}>
                <SelectTrigger className="h-8 w-64">
                  <SelectValue placeholder={t('quickConnect.vncJumpPlaceholder')} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {hosts
                    .filter((h) => !h.useProxy)
                    .map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name} · {h.host}:{h.port}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">{t('quickConnect.vncTargetHint')}</span>
            </div>
          )}
        </div>

        {/* 串口（占满整行；高级参数折叠） */}
        <div
          ref={serialCardRef}
          className={cn(
            'rounded-lg border bg-card p-3 transition-all duration-300 md:col-span-2',
            serialHighlight ? 'border-primary ring-2 ring-primary/40' : 'border-border',
          )}
        >
          <div className="flex items-center gap-3">
            <span className="flex w-32 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium">
              <IconUsb size={15} className="text-muted-foreground" />
              {t('quickConnect.serialTitle')}
            </span>
            <Input
              type="text"
              placeholder={t('quickConnect.serialPort')}
              value={serialPort}
              onChange={(e) => setSerialPort(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConnectSerial();
              }}
              className="h-8 w-40 shrink-0"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground"
              title={t('quickConnect.serialRefresh')}
              onClick={refreshSerialPorts}
            >
              <IconRefresh size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
              onClick={() => setSerialShowAdvanced((v) => !v)}
            >
              {t('quickConnect.serialAdvanced')}
              {serialShowAdvanced ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
            </Button>
            <Button size="sm" className="ml-auto h-8 shrink-0" onClick={() => void handleConnectSerial()}>
              {t('quickConnect.serialConnect')}
            </Button>
          </div>

          {/* 检测到的端口快捷选择 */}
          {serialPorts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[7.5rem]">
              <span className="text-xs text-muted-foreground">{t('quickConnect.serialDetected')}</span>
              {serialPorts.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSerialPort(p)}
                  className={
                    'h-6 rounded-md border px-2 font-mono text-xs transition-colors ' +
                    (serialPort === p
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent')
                  }
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* 高级参数（折叠）：波特率/数据位/停止位/校验/流控 */}
          {serialShowAdvanced && (
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 pl-[7.5rem] sm:grid-cols-3 xl:grid-cols-5">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialBaud')}</p>
                <Select value={serialBaud} onValueChange={setSerialBaud}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map(
                      (b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialDataBits')}</p>
                <Select value={serialDataBits} onValueChange={setSerialDataBits}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['5', '6', '7', '8'].map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialStopBits')}</p>
                <Select value={serialStopBits} onValueChange={setSerialStopBits}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['1', '2'].map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialParity')}</p>
                <Select value={serialParity} onValueChange={(v) => setSerialParity(v as 'none' | 'odd' | 'even')}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['none', 'odd', 'even'] as const).map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`quickConnect.parity.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialFlow')}</p>
                <Select value={serialFlow} onValueChange={(v) => setSerialFlow(v as 'none' | 'hardware')}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['none', 'hardware'] as const).map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`quickConnect.flow.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
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
