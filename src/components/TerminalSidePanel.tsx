import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask, save } from '@tauri-apps/plugin-dialog';
import {
  Activity as IconActivity,
  ArrowUp as IconArrowUp,
  Download as IconDownload,
  File as IconFile,
  Folder as IconFolder,
  Link as IconLink,
  PanelLeftClose as IconPanelClose,
  PanelLeftOpen as IconPanelOpen,
  RefreshCw as IconRefresh,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useOnlineHosts } from '../store/uiState';
import { useConfigStore } from '../store/config';
import type { SshTabConfig } from '../store/tabStore';
import {
  acceptHostKey,
  sftpConnect,
  sftpDisconnect,
  sftpListDir,
  sftpDownloadFileTo,
} from '../services/sessionService';
import type { SftpSessionConfig } from '../services/sessionService';
import {
  monitorStart,
  monitorCollect,
  monitorStop,
  type MonitorSnapshot,
} from '../services/monitorService';
import { disposeSftpSession, type FileItem } from './sftpPool';
import { useTerminalBackground } from '../hooks/useTerminalBackground';

// ==================== 偏好持久化 ====================

const PREFS_KEY = 'swallow.terminalPanel.v1';
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

type PanelSection = 'status' | 'files';

interface PanelPrefs {
  open: boolean;
  width: number;
  section: PanelSection;
}

function loadPanelPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelPrefs>;
      return {
        open: !!parsed.open,
        width: clampWidth(parsed.width ?? 260),
        section: parsed.section === 'files' ? 'files' : 'status',
      };
    }
  } catch {
    // 损坏的偏好按默认处理
  }
  return { open: true, width: 260, section: 'status' };
}

function savePanelPrefs(prefs: PanelPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略写入失败（隐私模式等）
  }
}

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

// ==================== 格式化工具 ====================

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

/** 主机开机时长（与监控页一致的天/时/分格式）。 */
function formatUptime(secs: number): string {
  if (!secs || secs <= 0) return '0m';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** 本会话已连接时长（时:分:秒 / 分:秒）。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function joinRemotePath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function parentOf(path: string): string | null {
  if (!path || path === '/') return null;
  const trimmed = path.replace(/\/+$/, '') || '/';
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx) || '/';
}

/** 解析 hex / rgb / rgba 颜色为 rgb 分量；'transparent'、'var(...)' 等返回 null。 */
function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const s = color.trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 8) hex = hex.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    const int = parseInt(hex, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/**
 * 面板跟随终端主题：以终端背景色为底，按亮度覆盖局部 CSS 变量（--sidebar* /
 * --muted* / --foreground / --primary），让面板内所有 shadcn 配色自动适配明暗。
 * 仅「背景图 + 延伸顶栏」时半透明 + 毛玻璃透出全窗背景层；纯色场景直接用同色不透明。
 */
function buildPanelTheme(terminalBackground: string, hasImage: boolean, extend: boolean) {
  const rgb = parseRgb(terminalBackground);
  // 主题色未知（var() 兜底 / 透明终端）：保持应用默认 sidebar 外观
  if (!rgb) return { style: {} as React.CSSProperties, translucent: false };
  const dark = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b < 150;
  // 只有「背景图 + 延伸顶栏」时下层才有全窗背景层可透（fixed 层含图片）
  const translucent = hasImage && extend;
  const vars: Record<string, string> = {
    '--sidebar': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${translucent ? 0.6 : 1})`,
  };
  if (dark) {
    vars['--sidebar-foreground'] = 'rgba(255,255,255,0.92)';
    vars['--foreground'] = 'rgba(255,255,255,0.92)';
    vars['--sidebar-border'] = 'rgba(255,255,255,0.1)';
    vars['--sidebar-accent'] = 'rgba(255,255,255,0.08)';
    vars['--muted'] = 'rgba(255,255,255,0.09)';
    vars['--muted-foreground'] = 'rgba(255,255,255,0.6)';
    vars['--primary'] = '#818cf8';
  }
  const style = {
    ...vars,
    ...(translucent ? { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' } : {}),
  } as React.CSSProperties;
  return { style, translucent };
}

/** 指标条颜色：≥90 危险红、≥75 警告橙、否则用指标专属色（与监控页告警色一致）。 */
function metricColor(value: number, color?: string): string {
  if (value >= 90) return 'var(--destructive)';
  if (value >= 75) return 'var(--warning)';
  return color ?? 'var(--primary)';
}

// ==================== 状态分区 ====================

/** 指标条：标签 + 数值 + 比例条（4px 细条；color 为指标专属色，告警阈值时变橙红）。 */
function MetricBar({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: number;
  detail: string;
  /** 正常状态的专属色（如 CPU 蓝 / 内存紫 / 磁盘绿）；超阈值自动切警告色 */
  color?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="truncate text-right tabular-nums">{detail}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: metricColor(value, color) }}
        />
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right tabular-nums">{value}</span>
    </div>
  );
}

/** 指标小节标题：紧凑大写小字。 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {children}
    </div>
  );
}

/** 双值小卡（TCP 连接等计数）：数字为主、标签为辅。 */
function MiniStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5">
      <div className="text-sm font-medium leading-none tabular-nums">{value}</div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** Top 进程行：进程名 + pid，右侧百分比。 */
function ProcessRow({ name, pid, value }: { name: string; pid: number; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate" title={`${name} (pid ${pid})`}>
        {name} <span className="text-muted-foreground/50">{pid}</span>
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

/** 终端标签的 auth_type → 展示标签（复用 Hosts 页文案）。 */
const AUTH_LABEL_KEY: Record<string, string> = {
  password: 'hosts.authTypePassword',
  key: 'hosts.authTypeKey',
  certificate: 'hosts.authTypeCertificate',
  agent: 'hosts.authTypeAgent',
  none: 'hosts.authTypeNone',
};

/** 指标专属色：CPU 蓝 / 内存紫 / Swap 橙 / 磁盘按挂载点轮换绿-青-蓝。 */
const CPU_COLOR = '#3b82f6';
const MEM_COLOR = '#a855f7';
const SWAP_COLOR = '#f59e0b';
const DISK_COLORS = ['#10b981', '#14b8a6', '#06b6d4', '#0ea5e9'];

interface StatusSectionProps {
  sshConfig?: SshTabConfig;
  /** 面板可见且处于状态分区时才建立/轮询监控会话 */
  active: boolean;
  /** 终端标签是否处于激活（非激活标签暂停轮询，会话保留） */
  tabActive: boolean;
}

function StatusSection({ sshConfig, active, tabActive }: StatusSectionProps) {
  const { t } = useTranslation();
  const hostId = sshConfig?.hostId;
  const hostKey = sshConfig ? `${sshConfig.host}:${sshConfig.port}` : '';
  const online = useOnlineHosts((s) => (hostKey ? s.online.has(hostKey) : false));

  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // 本会话连接时长（从在线状态跳变起算）
  const [elapsed, setElapsed] = useState(0);
  const connectedAtRef = useRef<number | null>(null);
  // 监控会话（后端自建 id）与连续失败计数
  const monitorIdRef = useRef<string | null>(null);
  const failCountRef = useRef(0);
  // 连续失败达到上限后停止自动轮询，等手动重试
  const [gaveUp, setGaveUp] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;
  // 用户拒绝过主机密钥确认：停止自动重试，等手动重试
  const approvalDeclinedRef = useRef(false);

  useEffect(() => {
    if (online) {
      if (!connectedAtRef.current) connectedAtRef.current = Date.now();
    } else {
      connectedAtRef.current = null;
      setElapsed(0);
    }
  }, [online]);

  // 每秒刷新连接时长
  useEffect(() => {
    if (!online) return;
    const timer = setInterval(() => {
      if (connectedAtRef.current) setElapsed(Date.now() - connectedAtRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [online]);

  // 监控会话生命周期 + 轮询：面板隐藏时停会话，标签非激活时只暂停轮询
  useEffect(() => {
    if (!active || !hostId || approvalDeclinedRef.current || gaveUp) return;
    let cancelled = false;

    const stopSession = () => {
      const id = monitorIdRef.current;
      monitorIdRef.current = null;
      if (id) void monitorStop(id).catch(() => {});
    };

    /** 建立监控会话（含主机密钥确认循环，与终端一致）。 */
    const ensureSession = async (): Promise<boolean> => {
      if (monitorIdRef.current) return true;
      setStarting(true);
      try {
        let result = await monitorStart(hostId);
        let rounds = 0;
        while (result.status === 'needsHostKeyApproval' && result.hostKeyToken && rounds < 2) {
          rounds += 1;
          const accepted = await ask(
            t('connection.hostKeyBody', {
              host: result.host,
              port: result.port,
              fingerprint: result.fingerprint ?? '',
            }),
            {
              title: t('connection.hostKeyTitle'),
              kind: 'warning',
              okLabel: t('connection.trustAndConnect'),
              cancelLabel: t('common.cancel'),
            },
          );
          if (!accepted) {
            approvalDeclinedRef.current = true;
            throw new Error(t('connection.declinedHostKey'));
          }
          await acceptHostKey(result.hostKeyToken, result.fingerprint ?? '');
          result = await monitorStart(hostId);
        }
        if (result.status !== 'connected' || !result.sessionId) {
          throw new Error(t('terminalPanel.monitorFailed'));
        }
        monitorIdRef.current = result.sessionId;
        failCountRef.current = 0;
        return true;
      } finally {
        if (!cancelled) setStarting(false);
      }
    };

    const tick = async () => {
      if (cancelled || !activeRef.current || !tabActiveRef.current) return;
      try {
        const ok = await ensureSession();
        if (!ok || cancelled || !monitorIdRef.current) return;
        const snap = await monitorCollect(monitorIdRef.current);
        if (cancelled) return;
        failCountRef.current = 0;
        setSnapshot(snap);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        failCountRef.current += 1;
        setError(String(e));
        // 连续失败视为会话已死：丢弃，下个 tick 重建
        if (failCountRef.current >= 2 && monitorIdRef.current) {
          stopSession();
        }
        // 连续失败达到上限：停止自动轮询（避免对失联主机无限重试），等手动重试
        if (failCountRef.current >= 4) {
          setGaveUp(true);
        }
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopSession();
      setSnapshot(null);
    };
  }, [active, hostId, retryNonce, gaveUp, t]);

  const manualRetry = () => {
    approvalDeclinedRef.current = false;
    failCountRef.current = 0;
    setError(null);
    setGaveUp(false);
    setRetryNonce((n) => n + 1);
  };

  if (!sshConfig) return null;

  const hostLabel = `${sshConfig.username}@${sshConfig.host}`;
  const hasMonitor = !!hostId;
  // 最忙网卡（rx+tx 之和最大者；其余接口在汇总里体现）
  const busiestNic =
    snapshot && snapshot.net.length > 0
      ? snapshot.net.reduce((a, b) =>
          b.rxBytesPerSec + b.txBytesPerSec > a.rxBytesPerSec + a.txBytesPerSec ? b : a,
        )
      : null;
  // 认证方式展示标签（复用 Hosts 页文案，缺失时回退原值）
  const authLabel = sshConfig.auth_type
    ? AUTH_LABEL_KEY[sshConfig.auth_type]
      ? t(AUTH_LABEL_KEY[sshConfig.auth_type], { defaultValue: sshConfig.auth_type })
      : sshConfig.auth_type
    : '—';

  return (
    <div className="space-y-4 p-3 text-xs">
      {/* 主机标识 + 在线状态 */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
            title={online ? t('terminalPanel.online') : t('terminalPanel.offline')}
          />
          <span className="truncate font-medium text-sm" title={hostLabel}>
            {hostLabel}
          </span>
        </div>
        <div className="pl-4 text-muted-foreground">
          {sshConfig.port}
          {online && connectedAtRef.current ? ` · ${t('terminalPanel.sessionDuration')} ${formatElapsed(elapsed)}` : ''}
        </div>
      </div>

      {hasMonitor ? (
        <div className="space-y-3">
          {error && !snapshot ? (
            <div className="space-y-2">
              <p className="break-all text-destructive">{t('terminalPanel.monitorFailed')}</p>
              <p className="break-all text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={manualRetry}>
                <IconRefresh size={12} strokeWidth={2} />
                {t('terminalPanel.retry')}
              </Button>
            </div>
          ) : starting && !snapshot ? (
            <p className="text-muted-foreground">{t('terminalPanel.monitorConnecting')}</p>
          ) : snapshot ? (
            <>
              {/* CPU：总使用率 + user/system/iowait 细分 + 负载 */}
              <div className="space-y-1">
                <MetricBar
                  label={t('terminalPanel.cpu')}
                  value={snapshot.cpuUsage}
                  detail={`${snapshot.cpuUsage.toFixed(1)}% · ${snapshot.cpuCores}C`}
                  color={CPU_COLOR}
                />
                <div className="text-[10px] tabular-nums text-muted-foreground/70">
                  us {snapshot.cpuUser.toFixed(1)} · sy {snapshot.cpuSystem.toFixed(1)} · wa {snapshot.cpuIowait.toFixed(1)}
                  {snapshot.cpuSteal > 0.05 ? ` · st ${snapshot.cpuSteal.toFixed(1)}` : ''}
                </div>
                <InfoRow
                  label={t('terminalPanel.load')}
                  value={`${snapshot.load1.toFixed(2)} / ${snapshot.load5.toFixed(2)} / ${snapshot.load15.toFixed(2)}`}
                />
              </div>

              {/* 内存：使用率 + 缓存/可用细分 */}
              <div className="space-y-1">
                <MetricBar
                  label={t('terminalPanel.memory')}
                  value={(snapshot.memUsed / Math.max(1, snapshot.memTotal)) * 100}
                  detail={`${formatBytes(snapshot.memUsed)} / ${formatBytes(snapshot.memTotal)}`}
                  color={MEM_COLOR}
                />
                <div className="text-[10px] tabular-nums text-muted-foreground/70">
                  {t('terminalPanel.cache')} {formatBytes(snapshot.memBuffCache)} · {t('terminalPanel.available')} {formatBytes(snapshot.memAvailable)}
                </div>
              </div>

              {snapshot.swapTotal > 0 && (
                <MetricBar
                  label={t('terminalPanel.swap')}
                  value={(snapshot.swapUsed / Math.max(1, snapshot.swapTotal)) * 100}
                  detail={`${formatBytes(snapshot.swapUsed)} / ${formatBytes(snapshot.swapTotal)}`}
                  color={SWAP_COLOR}
                />
              )}

              {/* 系统：主机名 / 内核 / 架构 / 开机时长 */}
              <div className="space-y-1 border-t border-sidebar-border pt-2">
                <SectionTitle>{t('terminalPanel.system')}</SectionTitle>
                <InfoRow label="Hostname" value={snapshot.hostname !== 'unknown' ? snapshot.hostname : '—'} />
                <InfoRow label="Kernel" value={snapshot.kernel !== 'unknown' ? snapshot.kernel : '—'} />
                <InfoRow label="Arch" value={snapshot.arch !== 'unknown' ? snapshot.arch : '—'} />
                <InfoRow label={t('terminalPanel.hostUptime')} value={formatUptime(snapshot.uptimeSecs)} />
              </div>

              {/* 磁盘：各挂载点用量 + I/O 速率 */}
              {snapshot.disks.length > 0 && (
                <div className="space-y-2 border-t border-sidebar-border pt-2">
                  <SectionTitle>{t('terminalPanel.disk')}</SectionTitle>
                  <div className="space-y-2">
                    {snapshot.disks.slice(0, 4).map((d, i) => (
                      <MetricBar
                        key={`${d.filesystem}-${d.mount}`}
                        label={d.mount}
                        value={d.percent}
                        detail={`${formatBytes(d.used)} / ${formatBytes(d.total)}`}
                        color={DISK_COLORS[i % DISK_COLORS.length]}
                      />
                    ))}
                  </div>
                  {snapshot.disksIo.length > 0 && (
                    <InfoRow
                      label={t('terminalPanel.diskIo')}
                      value={`${t('terminalPanel.read')} ↓${formatRate(snapshot.disksIo.reduce((a, d) => a + d.rxBytesPerSec, 0))} · ${t('terminalPanel.write')} ↑${formatRate(snapshot.disksIo.reduce((a, d) => a + d.wxBytesPerSec, 0))}`}
                    />
                  )}
                </div>
              )}

              {/* 网络：汇总速率 + 最忙网卡 */}
              <div className="space-y-1 border-t border-sidebar-border pt-2">
                <SectionTitle>{t('terminalPanel.network')}</SectionTitle>
                <InfoRow
                  label="↓ / ↑"
                  value={`${formatRate(snapshot.net.reduce((a, n) => a + n.rxBytesPerSec, 0))} / ${formatRate(snapshot.net.reduce((a, n) => a + n.txBytesPerSec, 0))}`}
                />
                {busiestNic && (
                  <InfoRow
                    label={t('terminalPanel.busiestNic')}
                    value={`${busiestNic.interface} ↓${formatRate(busiestNic.rxBytesPerSec)} ↑${formatRate(busiestNic.txBytesPerSec)}`}
                  />
                )}
              </div>

              {/* TCP 连接计数 */}
              <div className="space-y-1 border-t border-sidebar-border pt-2">
                <SectionTitle>{t('terminalPanel.tcp')}</SectionTitle>
                <div className="grid grid-cols-2 gap-1.5">
                  <MiniStat label="established" value={snapshot.tcp.established} />
                  <MiniStat label="time-wait" value={snapshot.tcp.timeWait} />
                  <MiniStat label="close-wait" value={snapshot.tcp.closeWait} />
                  <MiniStat label="listening" value={snapshot.tcp.listening} />
                </div>
              </div>

              {/* 资源占用 Top 进程 */}
              {(snapshot.topCpu.length > 0 || snapshot.topMem.length > 0) && (
                <div className="space-y-1.5 border-t border-sidebar-border pt-2">
                  <SectionTitle>{t('terminalPanel.processes')}</SectionTitle>
                  {snapshot.topCpu.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-muted-foreground/60">{t('terminalPanel.topCpu')}</div>
                      {snapshot.topCpu.slice(0, 3).map((p) => (
                        <ProcessRow key={`cpu-${p.pid}`} name={p.name} pid={p.pid} value={`${p.cpuPercent.toFixed(1)}%`} />
                      ))}
                    </div>
                  )}
                  {snapshot.topMem.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-muted-foreground/60">{t('terminalPanel.topMem')}</div>
                      {snapshot.topMem.slice(0, 3).map((p) => (
                        <ProcessRow key={`mem-${p.pid}`} name={p.name} pid={p.pid} value={`${p.memPercent.toFixed(1)}%`} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {error && (
                <p className="break-all text-muted-foreground/70">{error}</p>
              )}
              {gaveUp && (
                <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={manualRetry}>
                  <IconRefresh size={12} strokeWidth={2} />
                  {t('terminalPanel.retry')}
                </Button>
              )}
            </>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {/* 无监控（快速连接）：展示会话基础信息 */}
          <div className="space-y-1 rounded-md bg-muted/40 p-2">
            <InfoRow label={t('terminalPanel.protocol')} value="SSH" />
            <InfoRow label={t('terminalPanel.auth')} value={authLabel} />
          </div>
          <p className="rounded-md bg-muted/50 p-2 leading-relaxed text-muted-foreground">
            {t('terminalPanel.monitorHint')}
          </p>
        </div>
      )}
    </div>
  );
}

// ==================== 文件分区 ====================

interface FilesSectionProps {
  /** 终端会话 id（面板 SFTP 会话派生自它，保证唯一） */
  sessionId: string;
  sshConfig?: SshTabConfig;
  /** 面板可见且处于文件分区时才建立连接 */
  active: boolean;
}

function FilesSection({ sessionId, sshConfig, active }: FilesSectionProps) {
  const { t } = useTranslation();
  // 独立的 SFTP 会话 id：随终端会话派生，避免与终端/其他面板冲突
  const panelSessionId = `panel-sftp-${sessionId}`;
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [currentPath, setCurrentPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  // 连接中防重入（StrictMode 双挂载安全）
  const connectingRef = useRef(false);
  // 目录列表连续失败计数（≥2 转入重连 UI）
  const listFailCountRef = useRef(0);
  const approvalDeclinedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // 卸载（标签关闭/面板隐藏重建）时断开面板 SFTP 会话
  useEffect(() => {
    const id = panelSessionId;
    return () => {
      void sftpDisconnect(id).catch(() => {});
      disposeSftpSession(id);
    };
  }, [panelSessionId]);

  const buildConfig = useCallback((): SftpSessionConfig | null => {
    if (!sshConfig) return null;
    return {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      protocol: 'sftp',
      auth_type: sshConfig.auth_type,
      password: sshConfig.password,
      key_path: sshConfig.key_path,
      key_id: sshConfig.key_id,
      passphrase: sshConfig.passphrase,
    };
  }, [sshConfig]);

  /** 建连（含主机密钥确认循环，与终端一致）+ 列目录。 */
  const connectAndList = useCallback(async (path: string) => {
    const cfg = buildConfig();
    if (!cfg || connectingRef.current) return;
    connectingRef.current = true;
    setStatus('connecting');
    setError(null);
    try {
      let result = await sftpConnect(panelSessionId, cfg);
      let rounds = 0;
      while (result.status === 'needsHostKeyApproval' && result.hostKeyToken && rounds < 2) {
        rounds += 1;
        const accepted = await ask(
          t('connection.hostKeyBody', {
            host: result.host,
            port: result.port,
            fingerprint: result.fingerprint ?? '',
          }),
          {
            title: t('connection.hostKeyTitle'),
            kind: 'warning',
            okLabel: t('connection.trustAndConnect'),
            cancelLabel: t('common.cancel'),
          },
        );
        if (!accepted) {
          approvalDeclinedRef.current = true;
          throw new Error(t('connection.declinedHostKey'));
        }
        await acceptHostKey(result.hostKeyToken, result.fingerprint ?? '');
        result = await sftpConnect(panelSessionId, cfg);
      }
      if (result.status !== 'connected') {
        throw new Error(t('terminalPanel.filesConnectFailed'));
      }
      const items = await sftpListDir(panelSessionId, path);
      setStatus('connected');
      setCurrentPath(path);
      setPathInput(path);
      setFiles(sortFiles(items));
    } catch (e) {
      setStatus('error');
      setError(String(e));
    } finally {
      connectingRef.current = false;
    }
  }, [buildConfig, panelSessionId, t]);

  const listDir = useCallback(async (path: string) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const items = await sftpListDir(panelSessionId, path);
      setCurrentPath(path);
      setPathInput(path);
      setFiles(sortFiles(items));
      setStatus('connected');
      listFailCountRef.current = 0;
    } catch (e) {
      setError(String(e));
      // 连续失败视为 SFTP 会话已死：转入 error 态走重连 UI
      listFailCountRef.current += 1;
      if (listFailCountRef.current >= 2) {
        setStatus('error');
      }
    } finally {
      setLoading(false);
    }
  }, [loading, panelSessionId]);

  // 首次可见时自动连接
  useEffect(() => {
    if (activeRef.current && status === 'idle' && sshConfig) {
      void connectAndList('/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const retry = () => {
    approvalDeclinedRef.current = false;
    listFailCountRef.current = 0;
    setStatus('idle');
    setError(null);
    void connectAndList(currentPath || '/');
  };

  const openDir = (path: string) => {
    if (status === 'connected') void listDir(path);
  };

  const download = async (name: string) => {
    if (status !== 'connected' || downloading) return;
    const remotePath = joinRemotePath(currentPath, name);
    try {
      const target = await save({ defaultPath: name });
      if (!target) return;
      setDownloading(name);
      await sftpDownloadFileTo(panelSessionId, remotePath, target);
      toast.success(t('terminalPanel.downloadComplete'), { description: target });
    } catch (e) {
      toast.error(t('terminalPanel.downloadFailed'), { description: String(e) });
    } finally {
      setDownloading(null);
    }
  };

  if (!sshConfig) return null;

  const parent = parentOf(currentPath);

  return (
    <div className="flex h-full flex-col text-xs">
      {/* 路径工具条 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border p-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0"
          disabled={!parent || status !== 'connected'}
          onClick={() => parent && openDir(parent)}
          title={t('terminalPanel.parentDir')}
          aria-label={t('terminalPanel.parentDir')}
        >
          <IconArrowUp size={14} strokeWidth={2} />
        </Button>
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const p = pathInput.trim();
              if (p && status === 'connected') void listDir(p);
            }
          }}
          placeholder={t('terminalPanel.pathPlaceholder')}
          className="h-7 flex-1 border-transparent bg-transparent text-xs shadow-none focus-visible:ring-0"
          spellCheck={false}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0"
          disabled={status !== 'connected' || loading}
          onClick={() => void listDir(currentPath)}
          title={t('terminalPanel.refresh')}
          aria-label={t('terminalPanel.refresh')}
        >
          <IconRefresh size={13} strokeWidth={2} className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      {/* 列表区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {status === 'idle' || status === 'connecting' ? (
          <p className="p-2 text-muted-foreground">{t('terminalPanel.filesConnecting')}</p>
        ) : status === 'error' ? (
          <div className="space-y-2 p-2">
            <p className="break-all text-destructive">{t('terminalPanel.filesConnectFailed')}</p>
            {error && <p className="break-all text-muted-foreground">{error}</p>}
            <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={retry}>
              <IconRefresh size={12} strokeWidth={2} />
              {t('terminalPanel.retry')}
            </Button>
          </div>
        ) : loading && files.length === 0 ? (
          <p className="p-2 text-muted-foreground">…</p>
        ) : files.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('terminalPanel.emptyDir')}</p>
        ) : (
          <ul className="space-y-0.5">
            {files.map((item) => {
              const isDir = item.type === 'directory';
              return (
                <li
                  key={item.name}
                  className={cn(
                    'group flex items-center gap-1.5 rounded-md px-2 py-1',
                    isDir ? 'cursor-pointer hover:bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                  )}
                  title={`${item.type === 'symlink' ? '→ ' : ''}${joinRemotePath(currentPath, item.name)}\n${item.modified}${item.permissions ? ` · ${item.permissions}` : ''}`}
                  onClick={() => isDir && openDir(joinRemotePath(currentPath, item.name))}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {item.type === 'directory' ? (
                      <IconFolder size={14} strokeWidth={2} className="text-primary/80" />
                    ) : item.type === 'symlink' ? (
                      <IconLink size={14} strokeWidth={2} className="text-muted-foreground" />
                    ) : (
                      <IconFile size={14} strokeWidth={2} className="text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {!isDir && (
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">
                      {formatBytes(item.size)}
                    </span>
                  )}
                  {!isDir && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                      disabled={!!downloading}
                      onClick={(e) => {
                        e.stopPropagation();
                        void download(item.name);
                      }}
                      title={t('terminalPanel.download')}
                      aria-label={t('terminalPanel.download')}
                    >
                      <IconDownload
                        size={12}
                        strokeWidth={2}
                        className={cn(downloading === item.name && 'animate-pulse')}
                      />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && status === 'connected' && (
          <p className="break-all p-2 text-destructive/80">{error}</p>
        )}
      </div>
    </div>
  );
}

function sortFiles(files: FileItem[]): FileItem[] {
  return [...files].sort((a, b) => {
    const da = a.type === 'directory' ? 0 : 1;
    const db = b.type === 'directory' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

// ==================== 面板外壳 ====================

export interface TerminalSidePanelProps {
  sessionId?: string;
  sshConfig?: SshTabConfig;
  /** 终端标签是否处于激活状态（透传给分区控制轮询） */
  isActive: boolean;
  /** 渲染终端内容（接收 resizeSignal，供拖拽调宽/收展后重新 fit） */
  renderTerminal: (resizeSignal: number) => React.ReactNode;
}

/**
 * 终端左侧可伸缩面板：
 * - 收起/展开（宽度过渡动画），展开时可拖拽右缘调整宽度（200–480px）；
 * - 「状态」分区：主机在线状态 + 连接时长；主机来自主机列表时自动建立
 *   监控会话轮询 CPU/内存/磁盘/网络（面板隐藏即停，不占后台连接）；
 * - 「文件」分区：用终端同一套凭据建立独立 SFTP 连接浏览文件，
 *   支持目录导航/路径跳转/刷新/下载。
 * 偏好（开关/宽度/分区）持久化到 localStorage，跨标签、跨重启生效。
 */
export function TerminalSidePanel({ sessionId, sshConfig, isActive, renderTerminal }: TerminalSidePanelProps) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<PanelPrefs>(loadPanelPrefs);
  const [dragging, setDragging] = useState(false);
  const [resizeSignal, setResizeSignal] = useState(0);
  const config = useConfigStore((s) => s.config);
  // 面板背景跟随终端主题：与 TerminalView 同源计算终端背景，按亮度覆盖局部配色变量。
  // 用 terminalBackground（透明终端时为 'transparent' → 保持应用默认面板色，与终端一致地透出应用底色）
  const { terminalBackground, hasBackgroundImage, extendToTopbar } = useTerminalBackground(config, isActive);
  const panelTheme = buildPanelTheme(terminalBackground, hasBackgroundImage, extendToTopbar);
  const bump = useCallback(() => setResizeSignal((s) => s + 1), []);

  const updatePrefs = useCallback((updates: Partial<PanelPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...updates };
      savePanelPrefs(next);
      return next;
    });
  }, []);

  // 收展动画结束后重新 fit 终端（宽度过渡 200ms）
  useEffect(() => {
    const timer = setTimeout(bump, 230);
    return () => clearTimeout(timer);
  }, [prefs.open, bump]);

  // —— 拖拽调宽 ——
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: prefs.width };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const dx = dragState.current.startX - e.clientX;
    const width = clampWidth(dragState.current.startWidth + dx);
    if (width !== prefs.width) {
      updatePrefs({ width });
      bump();
    }
  };
  const onDragEnd = () => {
    dragState.current = null;
    setDragging(false);
  };

  const sectionActive = (section: PanelSection) => prefs.open && prefs.section === section;

  return (
    <div className={cn('flex h-full w-full', dragging && 'select-none')}>
      {/* 面板：收起时宽度归 0（overflow hidden），内容固定宽度避免过渡期回流 */}
      <aside
        className="relative h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
        style={{ width: prefs.open ? prefs.width : 0, zIndex: 2 }}
      >
        <div
          className={cn(
            'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
            !prefs.open && 'invisible',
          )}
          style={{ width: prefs.width, ...panelTheme.style }}
        >
          {/* 头部：分区切换 + 收起按钮 */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-1 border-b border-sidebar-border pl-1.5 pr-1">
            <div className="flex min-w-0 items-center gap-1">
              {(
                [
                  { id: 'status' as const, label: t('terminalPanel.status'), icon: <IconActivity size={13} strokeWidth={2} /> },
                  { id: 'files' as const, label: t('terminalPanel.files'), icon: <IconFolder size={13} strokeWidth={2} /> },
                ]
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => updatePrefs({ section: item.id })}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
                    prefs.section === item.id
                      ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
                      : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                  )}
                  aria-pressed={prefs.section === item.id}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 shrink-0"
              onClick={() => updatePrefs({ open: false })}
              title={t('terminalPanel.collapse')}
              aria-label={t('terminalPanel.collapse')}
            >
              <IconPanelClose size={15} strokeWidth={2} />
            </Button>
          </div>

          {/* 分区内容：状态分区随显隐挂载（隐藏即释放监控会话），
              文件分区保持挂载以复用 SFTP 连接，仅用 display 控制可见性 */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div style={{ display: prefs.section === 'status' ? 'block' : 'none', height: '100%', overflowY: 'auto' }}>
              {prefs.section === 'status' && (
                <StatusSection sshConfig={sshConfig} active={sectionActive('status')} tabActive={isActive} />
              )}
            </div>
            <div style={{ display: prefs.section === 'files' ? 'block' : 'none', height: '100%' }}>
              <FilesSection sessionId={sessionId || ''} sshConfig={sshConfig} active={sectionActive('files')} />
            </div>
          </div>

          {/* 拖拽手柄：右缘 8px 热区 */}
          <div
            className={cn(
              'absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize transition-colors',
              dragging ? 'bg-primary/30' : 'hover:bg-primary/20',
            )}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            role="separator"
            aria-orientation="vertical"
          />
        </div>
      </aside>

      {/* 终端区域 */}
      <div className="relative h-full min-w-0 flex-1">
        {renderTerminal(resizeSignal)}
        {!prefs.open && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute left-2 top-2 z-20 h-7 w-7 rounded-md bg-background/80"
            onClick={() => updatePrefs({ open: true })}
            title={t('terminalPanel.expand')}
            aria-label={t('terminalPanel.expand')}
          >
            <IconPanelOpen size={14} strokeWidth={2} />
          </Button>
        )}
      </div>
    </div>
  );
}
