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
import { useTabStore, type Tab } from '../store/tabStore';
import {
  enqueueWriteToTargets,
  isConnected,
  serializeTerminalBuffer,
} from '../components/terminalPool';
import { getHosts, getSnippets } from './dataService';

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
