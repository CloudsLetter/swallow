/**
 * AI 工具层：给 AI 助手提供「感知与操作软件」的接口（OpenAI function calling）。
 *
 * - TOOL_SCHEMAS：工具的 OpenAI function 定义（随请求透传给端点）
 * - executeToolCall：单个工具调用的执行入口；send_to_terminal 属高危操作，
 *   必须经 requestConfirm 回调取得用户确认后才执行（由 UI 层实现确认交互）
 * - aggregateToolCallDelta：SSE 增量的 tool_calls 聚合（按 index 拼接 id/name/arguments）
 *
 * 工具循环（调用 → 执行 → 结果回传 → 续轮）由 AiAssistant 组件驱动。
 */
import { invoke } from '@tauri-apps/api/core';
import { useTabStore, type Tab } from '../store/tabStore';
import { useConfigStore } from '../store/config';
import {
  enqueueWriteToTargets,
  getConnectionSteps,
  isConnected,
  serializeTerminalBuffer,
} from '../components/terminalPool';
import { getHosts, getKnownHosts, getSnippets } from './dataService';
import type { MonitorSnapshot } from './monitorService';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 会话类标签类型（与 useActiveTerminalSession 口径一致） */
const SESSION_TAB_TYPES: Tab['type'][] = ['terminal', 'telnet', 'local', 'serial', 'mosh'];

/** 工具的 OpenAI function 定义（透传给 /chat/completions 的 tools 字段） */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'get_terminal_output',
      description:
        '读取指定（默认当前激活）终端会话的屏幕缓冲区输出。用户问「终端里怎么了/刚才报了什么错」时用它。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标终端会话 ID，缺省为当前激活会话' },
          maxChars: { type: 'number', description: '返回的最大字符数，默认 12000' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: '列出当前打开的终端类标签页（SSH/Telnet/本地/串口/MOSH）及其连接状态。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_hosts',
      description: '列出已保存的 SSH 主机（名称/地址/端口/用户名/认证方式），不含任何凭据。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_snippets',
      description: '列出用户保存的快捷指令（命令片段），可推荐用户使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_terminal',
      description:
        '向指定（默认当前激活）终端会话发送一条命令并回车执行。高危操作：框架会先弹出确认框，用户允许后才真正执行。调用前应在回复文本中说明你要执行什么、为什么。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令（不需要带换行）' },
          sessionId: { type: 'string', description: '目标终端会话 ID，缺省为当前激活会话' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnose_connection',
      description:
        '排查某台保存主机连不上的原因（认证/主机密钥/代理/会话报错）。只读。先调 list_hosts 拿到候选主机，再以 hostName 调用本工具；它会返回该主机的脱敏连接配置、known_hosts 信任状态与相关开放会话的失败阶段，据此给出分步建议（不要回传/猜测密码）。',
      parameters: {
        type: 'object',
        properties: {
          hostName: { type: 'string', description: '要诊断的已保存主机名称（来自 list_hosts）' },
        },
        required: ['hostName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_monitor',
      description:
        '读取某台主机的实时状态监控采样（CPU/内存/磁盘/网络/负载/TCP/Top 进程），回答「服务器为什么卡/内存够不够/磁盘满了没」这类问题。只读。缺省 hostName 时返回当前有监控会话的第一台主机。没有监控会话时告知用户先连接并开启监控。',
      parameters: {
        type: 'object',
        properties: {
          hostName: { type: 'string', description: '要读取监控的主机名称（来自 list_hosts），缺省自动选' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_session_logs',
      description:
        '列出本机保存的会话日志文件（纯文本 .log 或回放 .replay.jsonl），按时间倒序，最多 50 个。用户问「查会话记录/刚才那次操作记录」或需要日志复盘时先用它找到目标日志，再调 read_session_log。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session_log',
      description:
        '读取指定会话日志文件的文本内容（返回尾部最多 8000 字符）。日志是终端回显的原始输出，可能包含用户键入的命令甚至口令，属敏感操作：框架会先弹确认框，用户允许后才读取。只在用户明确要求分析某次会话记录时使用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '日志文件完整路径（来自 list_session_logs 的 path 字段）' },
        },
        required: ['path'],
      },
    },
  },
] as const;

/** 解析目标终端会话：显式 sessionId 优先，否则取当前激活的终端类标签 */
function resolveTargetSession(sessionId?: string): { sessionId: string; tabName: string } | undefined {
  const { tabs, activeTabId } = useTabStore.getState();
  if (sessionId) {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    return { sessionId, tabName: tab?.name ?? sessionId };
  }
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active || !SESSION_TAB_TYPES.includes(active.type) || !active.sessionId) return undefined;
  return { sessionId: active.sessionId, tabName: active.name };
}

/** 统一的「无可用会话」返回文本（给 LLM，而非 UI） */
const NO_SESSION = '当前没有激活的终端会话（用户可能停在主页或非终端标签页）。';

export interface ToolExecResult {
  /** 回传给 LLM 的 tool 消息内容 */
  result: string;
  /** send_to_terminal 被用户拒绝时为 true（UI 显示「已拒绝」） */
  denied: boolean;
}

/**
 * 执行一个工具调用。requestConfirm 仅在执行高危工具（send_to_terminal）时调用，
 * 返回 true 表示用户允许执行。
 */
export async function executeToolCall(
  call: ToolCall,
  requestConfirm: (call: ToolCall) => Promise<boolean>,
): Promise<ToolExecResult> {
  let args: Record<string, unknown> = {};
  if (call.arguments.trim()) {
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return { result: `工具参数不是合法 JSON：${call.arguments.slice(0, 200)}`, denied: false };
    }
  }

  switch (call.name) {
    case 'get_terminal_output': {
      const target = resolveTargetSession(args.sessionId as string | undefined);
      if (!target) return { result: NO_SESSION, denied: false };
      const text = serializeTerminalBuffer(target.sessionId);
      if (!text?.trim()) return { result: `会话「${target.tabName}」的终端缓冲区当前为空。`, denied: false };
      const max = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.min(args.maxChars, 40000) : 12000;
      const trimmed = text.length > max ? text.slice(-max) : text;
      return { result: `会话「${target.tabName}」的终端输出（尾部 ${trimmed.length} 字符）：\n\`\`\`\n${trimmed}\n\`\`\``, denied: false };
    }

    case 'list_sessions': {
      const { tabs } = useTabStore.getState();
      const sessions = tabs
        .filter((t) => SESSION_TAB_TYPES.includes(t.type))
        .map((t) => ({
          name: t.name,
          type: t.type,
          sessionId: t.sessionId ?? null,
          connected: t.sessionId ? isConnected(t.sessionId) : false,
          isActive: t.id === useTabStore.getState().activeTabId,
        }));
      if (sessions.length === 0) return { result: '当前没有打开任何终端类标签页。', denied: false };
      return { result: `当前打开的终端会话：\n${JSON.stringify(sessions, null, 2)}`, denied: false };
    }

    case 'list_hosts': {
      try {
        const hosts = await getHosts();
        // 只挑非敏感字段，绝不回传凭据
        const brief = hosts.map((h) => ({
          name: h.name,
          host: h.host,
          port: h.port,
          username: h.username,
          authType: h.authType ?? null,
        }));
        if (brief.length === 0) return { result: '还没有保存任何主机。', denied: false };
        return { result: `已保存的主机（共 ${brief.length} 台）：\n${JSON.stringify(brief, null, 2)}`, denied: false };
      } catch (e) {
        return { result: `读取主机列表失败：${String(e)}`, denied: false };
      }
    }

    case 'list_snippets': {
      try {
        const snippets = await getSnippets();
        const brief = snippets.map((s) => ({ name: s.name, command: s.command, category: s.category ?? null }));
        if (brief.length === 0) return { result: '还没有保存任何快捷指令。', denied: false };
        return { result: `快捷指令（共 ${brief.length} 条）：\n${JSON.stringify(brief, null, 2)}`, denied: false };
      } catch (e) {
        return { result: `读取快捷指令失败：${String(e)}`, denied: false };
      }
    }

    case 'send_to_terminal': {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return { result: 'command 参数为空，未执行。', denied: false };
      const target = resolveTargetSession(args.sessionId as string | undefined);
      if (!target) return { result: NO_SESSION, denied: false };

      const allowed = await requestConfirm(call);
      if (!allowed) return { result: `用户拒绝了本次命令执行（${command.slice(0, 100)}）。不要擅自重试，先询问用户。`, denied: true };

      enqueueWriteToTargets([target.sessionId], command.trimEnd() + '\r');
      return { result: `命令已发送到会话「${target.tabName}」并回车执行：${command.slice(0, 200)}`, denied: false };
    }

    case 'diagnose_connection': {
      try {
        const hostName = typeof args.hostName === 'string' ? args.hostName : '';
        if (!hostName.trim()) return { result: '缺少 hostName 参数。', denied: false };
        const hosts = await getHosts();
        const host = hosts.find((h) => h.name === hostName);
        if (!host) {
          const names = hosts.map((h) => h.name).join('、') || '（空）';
          return {
            result: `未找到名为「${hostName}」的保存主机。请先调 list_hosts 核对名称（现有：${names}）。`,
            denied: false,
          };
        }
        // —— 脱敏连接配置（绝不回传 password/key/cert 内容）——
        const lines: string[] = [
          `主机「${host.name}」连接诊断：`,
          `目标 ${host.host}:${host.port}  用户 ${host.username || '(缺省)'}  认证方式 ${host.authType || '未知'}`,
          `密钥/证书：${host.keyId ? '已绑定 key' : '无 key'}${host.certificateId ? ' + cert' : ''}`,
        ];
        if (host.useProxy) {
          const proxyHosts = await getHosts();
          const proxy = proxyHosts.find((p) => p.id === host.proxyHostId);
          lines.push(`经代理：${proxy ? `${proxy.name} (${proxy.host}:${proxy.port})` : `hostId=${host.proxyHostId}（未找到）`}`);
        } else {
          lines.push('直连（无代理）');
        }
        // —— known_hosts 信任状态 ——
        try {
          const known = await getKnownHosts();
          const relevant = known.filter((k) => k.host.includes(host.host));
          if (relevant.length === 0) {
            lines.push('known_hosts：该主机**未被信任**（首次连接会要求确认指纹；若是换机/改密钥后也会拒绝）');
          } else {
            lines.push(`known_hosts：已信任 ${relevant.length} 条 → ${relevant.map((k) => `${k.keyType} ${k.fingerprint.slice(0, 16)}…`).join('、')}`);
          }
        } catch (e) {
          lines.push(`known_hosts 读取失败：${String(e)}`);
        }
        // —— 关联的开放会话与失败阶段 ——
        const { tabs } = useTabStore.getState();
        const related = tabs.filter((tab) => {
          if (tab.type === 'terminal') {
            const cfg = (tab as unknown as { sshConfig?: { host?: string; hostId?: string } }).sshConfig;
            return cfg?.hostId === host.id || cfg?.host === host.host;
          }
          if (tab.type === 'mosh') {
            const cfg = (tab as unknown as { moshConfig?: { host?: string; hostId?: string } }).moshConfig;
            return cfg?.hostId === host.id || cfg?.host === host.host;
          }
          return false;
        });
        if (related.length === 0) {
          lines.push('开放会话：无（需要重连后复现，或检查主机地址可达性）');
        } else {
          lines.push('开放会话：');
          for (const tab of related) {
            const sid = tab.sessionId;
            const status = sid && isConnected(sid) ? '已连接' : sid ? '未连接' : '无 session';
            lines.push(`- 「${tab.name}」${tab.type} ${status}`);
            if (sid) {
              const steps = getConnectionSteps(sid) ?? [];
              const failed = steps.filter((s) => s.status === 'error');
              const active = steps.find((s) => s.status === 'loading');
              if (failed.length > 0) {
                for (const s of failed) lines.push(`  失败阶段「${s.label}」：${s.message || '无详情'}`);
              } else if (active) {
                lines.push(`  正在「${active.label}」阶段…`);
              } else if (steps.length > 0) {
                lines.push(`  阶段：${steps.map((s) => `${s.label}:${s.status === 'success' ? 'ok' : s.status}`).join(' → ')}`);
              }
            }
          }
        }
        return { result: lines.join('\n'), denied: false };
      } catch (e) {
        return { result: `诊断执行失败：${String(e)}`, denied: false };
      }
    }

    case 'read_monitor': {
      try {
        const hostName = typeof args.hostName === 'string' ? args.hostName : '';
        const hosts = await getHosts();
        const host = hostName ? hosts.find((h) => h.name === hostName) : undefined;
        if (hostName && !host) {
          return { result: `未找到名为「${hostName}」的主机，请先调 list_hosts 核对。`, denied: false };
        }
        const ids = await invoke<string[]>('monitor_list_sessions');
        if (!ids || ids.length === 0) {
          return { result: '当前没有活动的监控会话（左侧面板未开监控或已关闭）。请让用户先连接主机并开启左侧「状态」监控，之后再来读取。', denied: false };
        }
        // 匹配：hostName → 该主机的监控会话；否则取第一个（尽力还原主机名）
        let sid: string | undefined;
        let sidHostName: string | undefined;
        if (host) {
          const prefix = `monitor-${host.id}-`;
          sid = ids.find((i) => i.startsWith(prefix));
          sidHostName = host.name;
        }
        if (!sid) {
          sid = ids[0];
          // 从 id 前缀还原 hostId（hostId 假设无 '-'，monitor 会话 id 形如 monitor-{hostId}-{ts}）
          const stripped = sid.startsWith('monitor-') ? sid.slice('monitor-'.length) : '';
          const dash = stripped.lastIndexOf('-');
          const hostIdGuess = dash > 0 ? stripped.slice(0, dash) : stripped;
          sidHostName = hosts.find((h) => h.id === hostIdGuess)?.name ?? '未知主机';
          if (host && hostName) {
            return { result: `主机「${host.name}」没有活动的监控会话（当前监控的是「${sidHostName}」）。请确认该主机的状态监控已开启。`, denied: false };
          }
        }
        if (!sid) return { result: '无可用监控会话。', denied: false };
        const snap = await invoke<MonitorSnapshot>('monitor_collect', { sessionId: sid });
        const fmt = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)}G` : n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${(n / 1024).toFixed(0)}K`);
        const out: string[] = [
          `监控（${sidHostName} / ${snap.hostname}，${snap.kernel} ${snap.arch}）：`,
          `运行 ${Math.floor(snap.uptimeSecs / 3600)}h${Math.floor((snap.uptimeSecs % 3600) / 60)}m  负载 ${snap.load1}/${snap.load5}/${snap.load15}（${snap.cpuCores} 核）`,
          `CPU ${snap.cpuUsage.toFixed(1)}%（user ${snap.cpuUser.toFixed(1)}/sys ${snap.cpuSystem.toFixed(1)}/iowait ${snap.cpuIowait.toFixed(1)}/steal ${snap.cpuSteal.toFixed(1)}）`,
          `内存 已用 ${fmt(snap.memUsed)} / ${fmt(snap.memTotal)}（可用 ${fmt(snap.memAvailable)}，buff/cache ${fmt(snap.memBuffCache)}）`,
          `交换 ${snap.swapTotal > 0 ? `${fmt(snap.swapUsed)} / ${fmt(snap.swapTotal)}` : '未启用'}`,
        ];
        const diskTop = [...snap.disks].sort((a, b) => b.percent - a.percent).slice(0, 6);
        if (diskTop.length > 0) out.push(`磁盘：${diskTop.map((d) => `${d.mount} ${d.percent}%`).join('，')}`);
        if (snap.net.length > 0) {
          out.push(`网络：${snap.net.map((n) => `${n.interface} ↓${fmt(n.rxBytesPerSec)}/s ↑${fmt(n.txBytesPerSec)}/s`).join('，')}`);
        }
        out.push(`TCP established ${snap.tcp.established} / timewait ${snap.tcp.timeWait} / closewait ${snap.tcp.closeWait}`);
        if (snap.topCpu.length > 0) out.push(`CPU Top：${snap.topCpu.slice(0, 5).map((p) => `${p.name}(${p.pid}) ${p.cpuPercent.toFixed(1)}%`).join('，')}`);
        if (snap.topMem.length > 0) out.push(`内存 Top：${snap.topMem.slice(0, 5).map((p) => `${p.name}(${p.pid}) ${fmt(p.memBytes)}`).join('，')}`);
        return { result: out.join('\n'), denied: false };
      } catch (e) {
        return { result: `读取监控失败：${String(e)}`, denied: false };
      }
    }

    case 'list_session_logs': {
      try {
        const directory = useConfigStore.getState().config?.terminal?.session_log_directory ?? '';
        if (!directory) return { result: '尚未配置会话日志目录。', denied: false };
        const files = await invoke<
          { path: string; name: string; kind: string; size: number; modified: number }[]
        >('session_log_list', { directory });
        if (!files || files.length === 0) {
          return { result: '日志目录为空：还没有任何会话日志（需在「设置 → 终端 → 会话日志」开启记录后产生）。', denied: false };
        }
        const brief = files.slice(0, 50).map((f) => {
          const d = f.modified ? new Date(f.modified * 1000).toLocaleString() : '';
          return `- ${f.name} [${f.kind}] ${(f.size / 1024).toFixed(1)}KB ${d}\n  path: ${f.path}`;
        });
        return { result: `本机会话日志（共 ${files.length} 个，取最近 ${Math.min(files.length, 50)}）：\n${brief.join('\n')}`, denied: false };
      } catch (e) {
        return { result: `枚举日志失败：${String(e)}`, denied: false };
      }
    }

    case 'read_session_log': {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path.trim()) return { result: '缺少 path 参数，请先用 list_session_logs 找到目标日志。', denied: false };
      const allowed = await requestConfirm(call);
      if (!allowed) return { result: `用户拒绝读取日志文件 ${path.slice(0, 120)}。不要擅自重试，先询问用户。`, denied: true };
      try {
        const text = await invoke<string>('session_log_read', { path });
        const max = 8000;
        const trimmed = text.length > max ? text.slice(-max) : text;
        return {
          result: `日志「${path.split(/[\\/]/).pop() ?? path}」共 ${text.length} 字符，返回尾部 ${trimmed.length} 字符（含终端回显，可能含用户输入）：\n\`\`\`\n${trimmed}\n\`\`\``,
          denied: false,
        };
      } catch (e) {
        return { result: `读取日志失败：${String(e)}`, denied: false };
      }
    }

    default:
      return { result: `未知工具：${call.name}`, denied: false };
  }
}

/**
 * 聚合 SSE 流式 tool_calls 增量（OpenAI 协议：按 index 分片，
 * id/name 仅首片携带，arguments 多片追加）。
 */
export function aggregateToolCallDelta(
  pending: Map<number, ToolCall>,
  calls: Record<string, unknown>[],
): void {
  for (const raw of calls) {
    const index = typeof raw.index === 'number' ? raw.index : 0;
    const fn = (raw.function ?? {}) as { name?: string; arguments?: string };
    const existing = pending.get(index) ?? { id: '', name: '', arguments: '' };
    pending.set(index, {
      id: existing.id || (typeof raw.id === 'string' ? raw.id : ''),
      name: existing.name || (fn.name ?? ''),
      arguments: existing.arguments + (fn.arguments ?? ''),
    });
  }
}

/** 把聚合结果转成有序数组（按 index 升序），过滤掉不完整的条目 */
export function finishToolCalls(pending: Map<number, ToolCall>): ToolCall[] {
  return [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.id && call.name);
}
