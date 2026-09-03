import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  Loader2,
  Plus,
  Server,
  Square,
  X,
} from 'lucide-react';
import { getHosts, getAccounts, getKeys, getCertificates, type Host, type Account, type Key, type Certificate } from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { acceptHostKey } from '../services/sessionService';
import { monitorStart, monitorCollect, monitorStop, monitorGetState, monitorSaveState, type MonitorSnapshot, type TopProcess } from '../services/monitorService';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { cn } from '@/lib/utils';

// ==================== 工具函数 ====================

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(secs: number): string {
  if (!secs || secs <= 0) return '0m';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function percent(used: number, total: number): number {
  if (!total) return 0;
  return (used / total) * 100;
}

function memPercent(snap: MonitorSnapshot): number {
  return percent(snap.memUsed, snap.memTotal);
}

/** 网速汇总：所有接口 rx/tx 之和。 */
function totalNet(snap: MonitorSnapshot): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const n of snap.net) {
    rx += n.rxBytesPerSec;
    tx += n.txBytesPerSec;
  }
  return { rx, tx };
}

/** 磁盘 I/O 汇总：所有设备 rx/wx 之和。 */
function totalDiskIo(snap: MonitorSnapshot): { rx: number; wx: number } {
  let rx = 0;
  let wx = 0;
  for (const d of snap.disksIo) {
    rx += d.rxBytesPerSec;
    wx += d.wxBytesPerSec;
  }
  return { rx, wx };
}

/** 卡片/详情副标题：hostname 未知时回退到主机名，kernel 未知时不显示。 */
function hostLine(snap: MonitorSnapshot | null, fallbackName: string): string {
  if (!snap) return '';
  const host = snap.hostname && snap.hostname !== 'unknown' ? snap.hostname : fallbackName;
  const kernel = snap.kernel && snap.kernel !== 'unknown' ? snap.kernel : '';
  return [host, kernel].filter(Boolean).join(' · ');
}

/** 告警级别：CPU/内存取最大值，≥90 critical、≥75 warn、否则 none。 */
function alertLevel(snap: MonitorSnapshot | null): 'none' | 'warn' | 'critical' {
  if (!snap) return 'none';
  const max = Math.max(snap.cpuUsage, memPercent(snap));
  if (max >= 90) return 'critical';
  if (max >= 75) return 'warn';
  return 'none';
}

/** 告警级别对应的 CPU 环颜色。 */
function alertColor(level: 'none' | 'warn' | 'critical'): string {
  if (level === 'critical') return '#ef4444';
  if (level === 'warn') return '#f59e0b';
  return 'var(--primary)';
}

// ==================== 可视化子组件 ====================

/** 环形仪表：percent 0-100，圆心显示大数值 + 单位，字号随尺寸自适应。 */
function Gauge({
  percent: value,
  size = 130,
  strokeWidth,
  color,
  valueText,
  unit,
}: {
  percent: number;
  size?: number;
  strokeWidth?: number;
  color: string;
  valueText: string;
  unit?: string;
}) {
  const sw = strokeWidth ?? Math.max(8, Math.round(size * 0.1));
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const dash = (clamped / 100) * c;
  const valueFontSize = Math.max(13, Math.round(size * 0.17));
  const unitFontSize = Math.max(9, Math.round(size * 0.085));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        style={{ stroke: 'var(--border)' }}
        strokeWidth={sw}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y={unit ? '48%' : '50%'}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: 'var(--foreground)', fontSize: valueFontSize, fontWeight: 500 }}
      >
        {valueText}
      </text>
      {unit && (
        <text
          x="50%"
          y="68%"
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fill: 'var(--muted-foreground)', fontSize: unitFontSize }}
        >
          {unit}
        </text>
      )}
    </svg>
  );
}

/** 迷你折线图：单系列 data 0-100。 */
function Sparkline({ data, color, height = 64 }: { data: number[]; color: string; height?: number }) {
  const width = 320;
  const n = data.length;
  if (n < 2) {
    return <div style={{ height }} className="flex items-center justify-center text-xs text-muted-foreground">—</div>;
  }
  const points = data
    .map((v, i) => {
      const x = (i / (n - 1)) * width;
      const y = height - (Math.max(0, Math.min(100, v)) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block">
      <polyline points={points} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** 迷你折线图：多系列，各自 0-100。 */
function MultiSparkline({
  series,
  height = 64,
}: {
  series: { data: number[]; color: string }[];
  height?: number;
}) {
  const width = 320;
  const n = Math.max(...series.map((s) => s.data.length), 0);
  if (n < 2) {
    return <div style={{ height }} className="flex items-center justify-center text-xs text-muted-foreground">—</div>;
  }
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block">
      {series.map((s, idx) => {
        const points = s.data
          .map((v, i) => {
            const x = (i / (n - 1)) * width;
            const y = height - (Math.max(0, Math.min(100, v)) / 100) * height;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        return (
          <polyline
            key={idx}
            points={points}
            fill="none"
            style={{ stroke: s.color }}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

/** 磁盘/网络等用量进度条。 */
function UsageBar({ percent: value, color }: { percent: number; color?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const resolved =
    color ?? (clamped >= 90 ? '#ef4444' : clamped >= 75 ? '#f59e0b' : '#10b981');
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${clamped}%`, backgroundColor: resolved }}
      />
    </div>
  );
}

/** 内存去向细分条：已用 / buff-cache / 物理空闲，free 命令风格。 */
function MemSplitBar({ snap, t }: { snap: MonitorSnapshot; t: (k: string) => string }) {
  const total = snap.memTotal;
  if (!total) return null;
  const used = Math.max(0, total - snap.memFree - snap.memBuffCache);
  const cache = Math.max(0, Math.min(snap.memBuffCache, total));
  const free = Math.max(0, total - used - cache);
  const pct = (v: number) => `${(v / total) * 100}%`;
  const segs = [
    { value: used, color: '#10b981' },
    { value: cache, color: '#0ea5e9' },
    { value: free, color: 'var(--muted-foreground)' },
  ];
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {segs.map((s, i) =>
          s.value > 0 ? (
            <div
              key={i}
              className="h-full shrink-0 transition-[width] duration-500"
              style={{ width: pct(s.value), backgroundColor: s.color, opacity: s.color === 'var(--muted-foreground)' ? 0.35 : 1 }}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
        {(
          [
            { color: '#10b981', value: used, label: t('monitor.memUsedText') },
            { color: '#0ea5e9', value: cache, label: t('monitor.memCached') },
            { color: 'var(--muted-foreground)', value: free, label: t('monitor.memFreeText') },
          ] as { color: string; value: number; label: string }[]
        ).map((s, i) => (
          <span key={i} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
            <span className="tabular-nums text-foreground">{formatBytes(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** CPU 细分：横向堆叠条 + 彩色图例（user/system/iowait/steal，空余 = idle）。 */
function CpuStackBar({ snap, t }: { snap: MonitorSnapshot; t: (k: string) => string }) {
  const segs = [
    { pct: snap.cpuUser, color: 'var(--primary)', label: t('monitor.cpuUser') },
    { pct: snap.cpuSystem, color: '#8b5cf6', label: t('monitor.cpuSystem') },
    { pct: snap.cpuIowait, color: '#f59e0b', label: t('monitor.cpuIowait') },
    { pct: snap.cpuSteal, color: '#ef4444', label: t('monitor.cpuSteal') },
  ];
  const busy = segs.reduce((s, x) => s + Math.max(0, x.pct), 0);
  const idle = Math.max(0, 100 - busy);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {segs.map(
          (s, i) =>
            s.pct >= 0.5 && (
              <div
                key={i}
                className="h-full shrink-0 transition-[width] duration-500"
                style={{ width: `${s.pct}%`, backgroundColor: s.color }}
              />
            ),
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {segs.map((s, i) => (
          <span key={i} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label} <span className="tabular-nums text-foreground">{s.pct.toFixed(1)}%</span>
          </span>
        ))}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-muted-foreground/30" />
          {t('monitor.idle')} <span className="tabular-nums text-foreground">{idle.toFixed(1)}%</span>
        </span>
      </div>
    </div>
  );
}

/** 进程列表（Top CPU / Top 内存 通用）。 */
function ProcList({ procs, emphasize }: { procs: TopProcess[]; emphasize: 'cpu' | 'mem' }) {
  if (procs.length === 0) return <p className="text-xs text-muted-foreground">—</p>;
  return (
    <div className="flex flex-col gap-1">
      {procs.map((p) => (
        <div key={p.pid} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1 text-xs">
          <span className="min-w-0 truncate text-foreground" title={`${p.user} · pid ${p.pid}`}>
            {p.name}
            <span className="ml-1 text-muted-foreground">{p.pid}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
            <span className={cn('w-11 text-right', emphasize === 'cpu' ? 'font-medium text-foreground' : '')}>
              {p.cpuPercent.toFixed(1)}%
            </span>
            <span className={cn('w-14 text-right', emphasize === 'mem' ? 'font-medium text-foreground' : '')}>
              {formatBytes(p.memBytes)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ==================== 监控项 ====================

interface MonitorItem {
  hostId: string;
  hostName: string;
  sessionId: string;
  snapshot: MonitorSnapshot | null;
  history: {
    cpu: number[];
    mem: number[];
    user: number[];
    system: number[];
    iowait: number[];
    steal: number[];
  };
  status: 'monitoring' | 'error';
  error?: string;
  /** 连续采集失败计数：≥3 次才判定断开，避免网络抖动误判 */
  failCount?: number;
}

const emptyHistory = () => ({
  cpu: [] as number[],
  mem: [] as number[],
  user: [] as number[],
  system: [] as number[],
  iowait: [] as number[],
  steal: [] as number[],
});

const pushHistory = (h: MonitorItem['history'], snap: MonitorSnapshot) => ({
  cpu: [...h.cpu, snap.cpuUsage].slice(-60),
  mem: [...h.mem, memPercent(snap)].slice(-60),
  user: [...h.user, snap.cpuUser].slice(-60),
  system: [...h.system, snap.cpuSystem].slice(-60),
  iowait: [...h.iowait, snap.cpuIowait].slice(-60),
  steal: [...h.steal, snap.cpuSteal].slice(-60),
});

// ==================== 页面 ====================

export function Monitor() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [selectedHostId, setSelectedHostId] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [items, setItems] = useState<MonitorItem[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sort, setSort] = useState<'manual' | 'cpu' | 'memory'>('manual');
  const [loading, setLoading] = useState(true);
  /** 自动监控开关：进入本页时自动重连上次监控的主机（持久化到数据库） */
  const [autoStart, setAutoStart] = useState(true);
  const autoStartRef = useRef(true);
  /** 持久化状态是否已从数据库读回 */
  const [stateLoaded, setStateLoaded] = useState(false);
  /** 上次持久化的主机 id 列表（等待自动恢复） */
  const [pendingHostIds, setPendingHostIds] = useState<string[]>([]);
  const restoreStartedRef = useRef(false);
  const itemsRef = useRef<MonitorItem[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    autoStartRef.current = autoStart;
  }, [autoStart]);

  /** 将当前监控主机列表持久化到数据库（开关状态随取最新）。 */
  const saveNow = useCallback((ids: string[]) => {
    void monitorSaveState(ids, autoStartRef.current).catch(() => {});
  }, []);

  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const detailItem = items.find((i) => i.sessionId === detailId) ?? null;

  // 排序后的卡片列表：CPU/内存按当前快照降序，未采到数据的排末尾
  const sortedItems = useMemo(() => {
    const arr = [...items];
    if (sort === 'cpu') {
      arr.sort((a, b) => (b.snapshot?.cpuUsage ?? -1) - (a.snapshot?.cpuUsage ?? -1));
    } else if (sort === 'memory') {
      arr.sort((a, b) => {
        const ma = a.snapshot ? memPercent(a.snapshot) : -1;
        const mb = b.snapshot ? memPercent(b.snapshot) : -1;
        return mb - ma;
      });
    }
    return arr;
  }, [items, sort]);

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      try {
        const [hostList, accountList, keyList, certList, monitorState] = await Promise.all([
          getHosts(),
          getAccounts(),
          getKeys(),
          getCertificates().catch(() => [] as Certificate[]),
          monitorGetState().catch(() => null),
        ]);
        setHosts(hostList);
        setAccounts(accountList);
        setKeys(keyList);
        setCerts(certList);
        if (monitorState) {
          setAutoStart(monitorState.autoStart);
          setPendingHostIds(monitorState.hostIds);
        }
      } catch (e) {
        console.error('Failed to load monitor reference data:', e);
      } finally {
        setLoading(false);
        setStateLoaded(true);
      }
    };
    void bootstrap();
  }, []);

  // 统一采集循环：每 2 秒遍历所有 monitoring 状态的监控项各采一次
  useEffect(() => {
    if (items.length === 0) return;
    let stopped = false;
    const tick = async () => {
      for (const item of itemsRef.current) {
        if (item.status !== 'monitoring') continue;
        try {
          const snap = await monitorCollect(item.sessionId);
          if (stopped) return;
          setItems((prev) =>
            prev.map((i) =>
              i.sessionId === item.sessionId
                ? {
                    ...i,
                    snapshot: snap,
                    status: 'monitoring',
                    failCount: 0,
                    history: pushHistory(i.history, snap),
                  }
                : i,
            ),
          );
        } catch (e) {
          if (stopped) return;
          setItems((prev) =>
            prev.map((i) => {
              if (i.sessionId !== item.sessionId) return i;
              const failCount = (i.failCount ?? 0) + 1;
              if (failCount >= 3) {
                return { ...i, status: 'error', error: String(e), failCount };
              }
              return { ...i, failCount };
            }),
          );
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [items.length]);

  const removeMonitor = (sessionId: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.sessionId !== sessionId);
      saveNow(next.map((i) => i.hostId));
      return next;
    });
    if (detailId === sessionId) setDetailId(null);
    void monitorStop(sessionId).catch(() => {});
  };

  const removeAll = () => {
    for (const item of itemsRef.current) {
      void monitorStop(item.sessionId).catch(() => {});
    }
    setItems(() => {
      saveNow([]);
      return [];
    });
    setDetailId(null);
  };

  /** 自动监控开关：只影响「下次进入本页是否自动重连」，主机列表始终持久化。 */
  const handleAutoStartChange = (checked: boolean) => {
    setAutoStart(checked);
    autoStartRef.current = checked;
    void monitorSaveState(itemsRef.current.map((i) => i.hostId), checked).catch(() => {});
  };

  /** 与主机建立监控连接（手动/自动恢复共用）。成功返回 true 并加入列表+持久化。 */
  const connectHost = useCallback(
    async (host: Host, silent = false): Promise<boolean> => {
      const auth = resolveHostSshAuth(host, accounts, keys, certs);
      if (auth.error) {
        if (!silent) toast.warning(auth.error);
        return false;
      }
      setConnectingId(host.id);
      try {
        let result = await monitorStart(host.id);
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
          if (!accepted) return false;
          await acceptHostKey(result.hostKeyToken!, fingerprint);
          result = await monitorStart(host.id);
        }
        if (result.status !== 'connected' || !result.sessionId) return false;
        const item: MonitorItem = {
          hostId: host.id,
          hostName: host.name,
          sessionId: result.sessionId!,
          snapshot: null,
          history: emptyHistory(),
          status: 'monitoring',
        };
        setItems((prev) => {
          const next = [...prev, item];
          saveNow(next.map((i) => i.hostId));
          return next;
        });
        return true;
      } catch (e) {
        if (!silent) {
          console.error('Failed to start monitor:', e);
          toast.error(t('monitor.startFailed', { message: String(e) }));
        }
        return false;
      } finally {
        setConnectingId(null);
      }
    },
    [accounts, keys, certs, saveNow, t],
  );

  const handleAdd = async () => {
    if (!selectedHost) {
      toast.warning(t('monitor.noHost'));
      return;
    }
    if (itemsRef.current.some((i) => i.hostId === selectedHost.id)) {
      toast.warning(t('monitor.alreadyMonitoring'));
      return;
    }
    if (await connectHost(selectedHost)) setSelectedHostId('');
  };

  // 进入本页且持久化数据就绪后，若「自动监控」开启则逐个静默重连上次监控的主机
  useEffect(() => {
    if (!stateLoaded || loading || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    if (!autoStart || pendingHostIds.length === 0) return;
    const restored: string[] = [];
    (async () => {
      for (const hostId of pendingHostIds) {
        const host = hosts.find((h) => h.id === hostId);
        if (!host) continue;
        if (itemsRef.current.some((i) => i.hostId === hostId)) {
          restored.push(hostId);
          continue;
        }
        if (await connectHost(host, true)) restored.push(hostId);
      }
      // 同步一次最终结果：失败/已删除的主机从持久化中剔除，避免每次进入都重试
      saveNow(restored);
    })();
  }, [stateLoaded, loading, autoStart, pendingHostIds, hosts, connectHost, saveNow]);

  const monitoredHostIds = new Set(items.map((i) => i.hostId));

  const renderCard = (item: MonitorItem) => {
    const snap = item.snapshot;
    const net = snap ? totalNet(snap) : { rx: 0, tx: 0 };
    const level = alertLevel(snap);
    const cpuColor = alertColor(level);

    return (
      <div
        key={item.sessionId}
        onClick={() => setDetailId(item.sessionId)}
        className={cn(
          'group cursor-pointer rounded-lg border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
          level === 'critical'
            ? 'border-red-500/60 hover:border-red-500'
            : level === 'warn'
              ? 'border-amber-500/60 hover:border-amber-500'
              : 'border-border hover:border-primary/25',
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-2 px-3 pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                item.status === 'error'
                  ? 'bg-destructive'
                  : snap
                    ? 'bg-emerald-500 ring-2 ring-emerald-500/20'
                    : 'bg-amber-500',
              )}
              title={item.status === 'error' ? t('monitor.offline') : t('monitor.monitoring')}
            />
            <span className="truncate text-sm font-medium text-foreground">{item.hostName}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              removeMonitor(item.sessionId);
            }}
            aria-label={t('monitor.stop')}
            title={t('monitor.stop')}
          >
            <X size={14} />
          </Button>
        </div>
        <p className="truncate px-3 text-xs text-muted-foreground">{hostLine(snap, item.hostName)}</p>

        {/* 主体 */}
        <div className="px-3 py-2">
          {item.status === 'error' ? (
            <div className="flex items-center gap-2 py-2 text-xs text-destructive">
              <Activity size={14} />
              {t('monitor.offline')}
            </div>
          ) : !snap ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              {t('monitor.collecting')}
            </div>
          ) : snap.memTotal === 0 && snap.cpuCores === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">{t('monitor.noData')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <span title={t('monitor.cpu')} className="flex shrink-0 items-center">
                <Gauge
                  percent={snap.cpuUsage}
                  size={82}
                  color={cpuColor}
                  valueText={snap.cpuUsage.toFixed(0)}
                  unit="%"
                />
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-muted-foreground">{t('monitor.memory')}</span>
                    <span
                      className="shrink-0 tabular-nums text-foreground"
                      title={`${Math.round(memPercent(snap))}%`}
                    >
                      {formatBytes(snap.memUsed)} / {formatBytes(snap.memTotal)}
                    </span>
                  </div>
                  <UsageBar percent={memPercent(snap)} color="#10b981" />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">{t('monitor.load')}</span>
                  <span className="shrink-0 tabular-nums text-foreground">{snap.load1.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">{t('monitor.network')}</span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-foreground">
                    <span className="flex items-center gap-1">
                      <ArrowDown size={11} className="text-emerald-500" />
                      {formatRate(net.rx)}
                    </span>
                    <span className="flex items-center gap-1">
                      <ArrowUp size={11} className="text-amber-500" />
                      {formatRate(net.tx)}
                    </span>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">TCP</span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-foreground">
                    <span className="text-emerald-500">{t('monitor.tcpEstab')} {snap.tcp.established}</span>
                    <span className="text-muted-foreground">{t('monitor.tcpTotal')} {snap.tcp.total}</span>
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('monitor.title')}</h2>
          {items.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {t('monitor.monitoringCount', { count: items.length })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedHostId} onValueChange={setSelectedHostId}>
            <SelectTrigger className="h-8 w-[240px]">
              <SelectValue placeholder={t('monitor.selectHost')} />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={h.id} disabled={monitoredHostIds.has(h.id)}>
                  {h.name} ({h.host}:{h.port})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => void handleAdd()} disabled={!selectedHostId || connectingId !== null}>
            {connectingId !== null ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {t('monitor.add')}
          </Button>
          <div className="flex items-center gap-1.5" title={t('monitor.autoStartDesc')}>
            <Switch
              id="monitor-auto-start"
              checked={autoStart}
              onCheckedChange={handleAutoStartChange}
              className="scale-90"
            />
            <label
              htmlFor="monitor-auto-start"
              className="cursor-pointer select-none whitespace-nowrap text-xs text-muted-foreground"
            >
              {t('monitor.autoStart')}
            </label>
          </div>
          {items.length > 0 && (
            <Button variant="outline" onClick={removeAll}>
              <Square size={14} />
              {t('monitor.removeAll')}
            </Button>
          )}
        </div>
      </div>

      {/* ===== 内容区 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Skeleton className="size-2 shrink-0 rounded-full" />
                    <Skeleton className="h-4 w-28" />
                  </div>
                  <Skeleton className="size-7 shrink-0 rounded-md" />
                </div>
                <Skeleton className="mt-3 h-24 w-full rounded-md" />
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Server size={24} />
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">{t('monitor.emptyHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 排序 */}
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('monitor.sortBy')}</span>
              <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                {(
                  [
                    { key: 'manual', label: t('monitor.sortManual') },
                    { key: 'cpu', label: t('monitor.cpu') },
                    { key: 'memory', label: t('monitor.memory') },
                  ] as { key: 'manual' | 'cpu' | 'memory'; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSort(opt.key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      sort === opt.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
              {sortedItems.map(renderCard)}
            </div>
          </div>
        )}
      </div>

      {/* ===== 详情弹窗 ===== */}
      <Dialog open={detailItem !== null} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <DialogContent className="flex w-[min(1000px,calc(100vw-3rem))] max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          {detailItem && (
            <>
              <DialogHeader className="flex-none px-6 pt-5 pb-3 pr-12">
                <DialogTitle className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      detailItem.status === 'error'
                        ? 'bg-destructive'
                        : detailItem.snapshot
                          ? 'bg-emerald-500 ring-2 ring-emerald-500/20'
                          : 'bg-amber-500',
                    )}
                  />
                  {detailItem.hostName}
                </DialogTitle>
                <DialogDescription>{hostLine(detailItem.snapshot, detailItem.hostName)}</DialogDescription>
              </DialogHeader>

              <div className="overlay-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-6">
                {detailItem.status === 'error' ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-destructive">
                    <Activity size={16} />
                    {t('monitor.offline')}
                  </div>
                ) : !detailItem.snapshot ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" />
                    {t('monitor.collecting')}
                  </div>
                ) : detailItem.snapshot.memTotal === 0 && detailItem.snapshot.cpuCores === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('monitor.noData')}</p>
                ) : (
                  <DetailBody item={detailItem} t={t} />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 详情主体：完整指标展示。 */
function DetailBody({ item, t }: { item: MonitorItem; t: (k: string, opts?: Record<string, unknown>) => string }) {
  const snap = item.snapshot!;
  const diskIo = totalDiskIo(snap);
  const net = totalNet(snap);

  return (
    <div className="flex flex-col gap-4">
      {/* 系统信息条 */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {snap.kernel && snap.kernel !== 'unknown' && <span>{snap.kernel}</span>}
        {snap.arch && snap.arch !== 'unknown' && <span>{snap.arch}</span>}
        <span>{t('monitor.cores')}: {snap.cpuCores}</span>
        <span>{t('monitor.uptime')}: {formatUptime(snap.uptimeSecs)}</span>
        <span>{t('monitor.load')}: {snap.load1.toFixed(2)} / {snap.load5.toFixed(2)} / {snap.load15.toFixed(2)}</span>
      </div>

      {/* 三仪表 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card p-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Cpu size={13} className="text-primary" />
            {t('monitor.cpu')}
          </span>
          <Gauge percent={snap.cpuUsage} size={104} color="var(--primary)" valueText={snap.cpuUsage.toFixed(0)} unit="%" />
          <span className="text-center text-[11px] leading-relaxed text-muted-foreground">
            {t('monitor.cpuUser')} {snap.cpuUser.toFixed(0)}% · {t('monitor.cpuSystem')} {snap.cpuSystem.toFixed(0)}% · {t('monitor.cpuIowait')} {snap.cpuIowait.toFixed(0)}%
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card p-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <HardDrive size={13} className="text-emerald-500" />
            {t('monitor.memory')}
          </span>
          <Gauge percent={memPercent(snap)} size={104} color="#10b981" valueText={Math.round(memPercent(snap)).toString()} unit="%" />
          <span className="text-center text-[11px] leading-relaxed text-muted-foreground">
            {t('monitor.memDetail', {
              used: formatBytes(snap.memUsed),
              total: formatBytes(snap.memTotal),
              avail: formatBytes(snap.memAvailable),
            })}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card p-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Activity size={13} className="text-amber-500" />
            {t('monitor.swap')}
          </span>
          <Gauge percent={percent(snap.swapUsed, snap.swapTotal)} size={104} color="#f59e0b" valueText={Math.round(percent(snap.swapUsed, snap.swapTotal)).toString()} unit="%" />
          <span className="text-center text-[11px] leading-relaxed text-muted-foreground">
            {t('monitor.memDetail', {
              used: formatBytes(snap.swapUsed),
              total: formatBytes(snap.swapTotal),
              avail: formatBytes(snap.swapTotal - snap.swapUsed),
            })}
          </span>
        </div>
      </div>

      {/* CPU 细分 + 历史 */}
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-xs font-medium text-foreground">{t('monitor.cpuBreakdown')}</span>
        <div className="mt-2">
          <CpuStackBar snap={snap} t={t} />
        </div>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('monitor.cpuHistory')}</span>
            <Sparkline data={item.history.cpu} color="var(--primary)" height={40} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('monitor.breakdownHistory')}</span>
            <MultiSparkline
              height={40}
              series={[
                { data: item.history.user, color: 'var(--primary)' },
                { data: item.history.system, color: '#8b5cf6' },
                { data: item.history.iowait, color: '#f59e0b' },
                { data: item.history.steal, color: '#ef4444' },
              ]}
            />
          </div>
        </div>
      </div>

      {/* 内存细分（去向：已用 / buff-cache / 物理空闲） */}
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-xs font-medium text-foreground">{t('monitor.memBreakdown')}</span>
        <div className="mt-2">
          <MemSplitBar snap={snap} t={t} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('monitor.memBreakdownHint')}</p>
      </div>

      {/* 进程占用 */}
      {(snap.topCpu.length > 0 || snap.topMem.length > 0) && (
        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-xs font-medium text-foreground">{t('monitor.topProcesses')}</span>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('monitor.topByCpu')}</span>
              <ProcList procs={snap.topCpu} emphasize="cpu" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('monitor.topByMem')}</span>
              <ProcList procs={snap.topMem} emphasize="mem" />
            </div>
          </div>
        </div>
      )}

      {/* 磁盘 I/O + TCP */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-xs font-medium text-foreground">{t('monitor.diskIo')}</span>
          {snap.disksIo.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('monitor.noData')}</p>
          ) : (
            <>
              <div className="mt-2 flex items-center gap-3 rounded-md border border-border/60 px-3 py-1.5 text-xs">
                <span className="flex items-center gap-1.5 tabular-nums text-foreground">
                  <ArrowDown size={11} className="text-emerald-500" />
                  {t('monitor.ioRead')} {formatRate(diskIo.rx)}
                </span>
                <span className="flex items-center gap-1.5 tabular-nums text-foreground">
                  <ArrowUp size={11} className="text-amber-500" />
                  {t('monitor.ioWrite')} {formatRate(diskIo.wx)}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {snap.disksIo.map((d) => (
                  <div key={d.device} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">{d.device}</span>
                    <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <ArrowDown size={11} className="text-emerald-500" />
                        {formatRate(d.rxBytesPerSec)}
                      </span>
                      <span className="flex items-center gap-1">
                        <ArrowUp size={11} className="text-amber-500" />
                        {formatRate(d.wxBytesPerSec)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-xs font-medium text-foreground">{t('monitor.tcp')}</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              { label: 'ESTAB', value: snap.tcp.established, color: 'text-emerald-500' },
              { label: 'TIME_WAIT', value: snap.tcp.timeWait, color: 'text-foreground' },
              { label: 'CLOSE_WAIT', value: snap.tcp.closeWait, color: 'text-amber-500' },
              { label: 'SYN_SENT', value: snap.tcp.synSent, color: 'text-foreground' },
            ].map((s) => (
              <div key={s.label} className="rounded-md border border-border/60 px-3 py-1.5">
                <p className={cn('text-base font-medium tabular-nums', s.color)}>{s.value}</p>
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('monitor.tcpTotal')} <span className="tabular-nums text-foreground">{snap.tcp.total}</span>
            {' · '}{t('monitor.tcpListen')} <span className="tabular-nums text-foreground">{snap.tcp.listening}</span>
          </p>
        </div>
      </div>

      {/* 磁盘容量 */}
      {snap.disks.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-xs font-medium text-foreground">{t('monitor.disk')}</span>
          <div className="mt-2 flex flex-col gap-2">
            {snap.disks.map((d) => (
              <div key={d.mount} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-foreground" title={d.filesystem}>{d.mount} <span className="text-muted-foreground">({d.filesystem})</span></span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatBytes(d.used)} / {formatBytes(d.total)}
                  </span>
                </div>
                <UsageBar percent={d.percent} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 网络 */}
      {snap.net.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-xs font-medium text-foreground">{t('monitor.network')}</span>
          {/* 总网络吞吐汇总 */}
          <div className="mt-2 flex items-center gap-4 rounded-md border border-border/60 px-3 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 tabular-nums text-foreground">
              <ArrowDown size={12} className="text-emerald-500" />
              {t('monitor.netTotalIn')} {formatRate(net.rx)}
            </span>
            <span className="flex items-center gap-1.5 tabular-nums text-foreground">
              <ArrowUp size={12} className="text-amber-500" />
              {t('monitor.netTotalOut')} {formatRate(net.tx)}
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {snap.net.map((n) => (
              <div key={n.interface} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-1.5 text-xs">
                <span className="font-medium text-foreground">{n.interface}</span>
                <div className="flex items-center gap-4 tabular-nums text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <ArrowDown size={11} className="text-emerald-500" />
                    {formatRate(n.rxBytesPerSec)}
                  </span>
                  <span className="flex items-center gap-1">
                    <ArrowUp size={11} className="text-amber-500" />
                    {formatRate(n.txBytesPerSec)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Monitor;
