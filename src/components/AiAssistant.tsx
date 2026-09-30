import { useEffect, useMemo, useRef, useState } from 'react';
import { useConfigStore } from '../store/config';
import { useTranslation } from 'react-i18next';
import {
  Bot as IconBot,
  Check as IconCheck,
  Copy as IconCopy,
  CornerDownLeft as IconSend,
  Loader2 as IconLoader,
  MessageSquarePlus as IconNewChat,
  Play as IconPlay,
  Sparkles as IconSparkles,
  Square as IconSquare,
  TerminalSquare as IconTerminal,
  Trash2 as IconTrash,
  User as IconUser,
  Wrench as IconWrench,
  X as IconX,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { aiChat } from '../services/dataService';
import {
  aggregateToolCallDelta,
  executeToolCall,
  finishToolCalls,
  getToolSchemas,
  type ToolCall,
} from '../services/aiTools';
import { serializeTerminalBuffer } from './terminalPool';
import { isTerminalLike } from '../extensions/protocols';
import { useTabStore } from '../store/tabStore';
import { AssistantMarkdown } from './ai/AssistantMarkdown';
import { cn } from '../lib/utils';

/** 工具调用在 UI 中的状态 */
interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'running' | 'done' | 'denied';
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息：本轮发起的工具调用（结果与状态随执行更新） */
  toolCalls?: ToolCallInfo[];
  /** tool 消息：回传给 LLM 的结果 */
  toolCallId?: string;
  name?: string;
}

/** 一段独立会话：多会话按记录存储，可切换/删除 */
interface AiConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** 对话模式：agent = 启用工具（可操作终端）；ask = 纯问答 */
type ChatMode = 'agent' | 'ask';
/** 思考强度：'' = 不传（默认），low/medium/high = OpenAI reasoning_effort */
type ReasoningEffort = '' | 'low' | 'medium' | 'high';

const CONVS_KEY = 'swallow-ai-conversations';
const ACTIVE_CONV_KEY = 'swallow-ai-active-conversation';
const LEGACY_HISTORY_KEY = 'swallow-ai-chat-history';
const MODE_KEY = 'swallow-ai-mode';
const EFFORT_KEY = 'swallow-ai-effort';
const MAX_MESSAGES = 60;
/** 工具循环轮次上限（一轮 = LLM 一次完整响应 + 其工具执行），防失控 */
const MAX_TOOL_ROUNDS = 8;

const SYSTEM_PROMPT =
  '你是 Swallow 终端客户端内置的 AI 助手，帮助用户处理 SSH/运维/命令行相关问题。' +
  '你可以使用工具感知与操作软件：读取终端输出（get_terminal_output）、查询会话/主机/快捷指令' +
  '（list_sessions/list_hosts/list_snippets）、向终端发送命令（send_to_terminal，框架会弹确认框由用户把关）。' +
  '需要了解终端现状时主动调用工具，不要凭空假设。回答简洁、可操作，代码与命令用 markdown 代码块。';

const newId = () => `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const newConversation = (): AiConversation => ({
  id: newId(),
  title: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
});

/** 会话列表加载（含旧版单会话 history 的一次性迁移） */
function loadConversations(): AiConversation[] {
  try {
    const raw = localStorage.getItem(CONVS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as AiConversation[];
      if (Array.isArray(list) && list.length > 0) return list;
    }
    // 旧版单会话迁移
    const legacy = localStorage.getItem(LEGACY_HISTORY_KEY);
    if (legacy) {
      const messages = JSON.parse(legacy) as ChatMessage[];
      if (Array.isArray(messages) && messages.length > 0) {
        localStorage.removeItem(LEGACY_HISTORY_KEY);
        return [{ ...newConversation(), messages }];
      }
    }
  } catch {
    // 损坏则重置
  }
  return [newConversation()];
}

function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_CONV_KEY);
}

function loadMode(): ChatMode {
  return localStorage.getItem(MODE_KEY) === 'ask' ? 'ask' : 'agent';
}

function loadEffort(): ReasoningEffort {
  const v = localStorage.getItem(EFFORT_KEY);
  return v === 'low' || v === 'medium' || v === 'high' ? v : '';
}

/** 工具卡片的参数摘要行（克制：一行文本，不展开 JSON）。
 *  recognized 工具给定制摘要，未知工具回退截断原文（注册表加新工具不用改这里）。 */
function summarizeArgs(call: ToolCallInfo): string {
  try {
    const args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    const firstString = (key: string) => {
      const v = args[key];
      return typeof v === 'string' && v ? v : '';
    };
    if (call.name === 'send_to_terminal') return firstString('command');
    if (call.name === 'get_terminal_output') return firstString('sessionId') || '当前会话';
    if (call.name === 'diagnose_connection' || call.name === 'read_monitor') return firstString('hostName');
    if (call.name === 'read_session_log') return (firstString('path').split(/[\\/]/).pop() ?? '');
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    const v = args[keys[0]];
    return typeof v === 'string' ? v.slice(0, 60) : '';
  } catch {
    return call.arguments.slice(0, 60);
  }
}

/** 消息悬停复制按钮（VS Code Copilot Chat 式：hover 才现身） */
function MessageCopy({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title={t('ai.copyMessage')}
      aria-label={t('ai.copyMessage')}
      className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 hover:text-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          // 剪贴板不可用静默忽略
        }
      }}
    >
      {copied ? <IconCheck size={12} className="text-emerald-500" /> : <IconCopy size={12} />}
    </button>
  );
}

/** 消息头像列：AI = 主色调圆底 sparkle；用户 = 中性圆底人形 */
function MessageAvatar({ role }: { role: 'user' | 'assistant' }) {
  return role === 'assistant' ? (
    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
      <IconSparkles size={12} className="text-primary" />
    </div>
  ) : (
    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted">
      <IconUser size={12} className="text-muted-foreground" />
    </div>
  );
}

/**
 * AI 助手侧栏：VS Code Copilot Chat 形态的多会话对话窗口。
 * - 多会话按记录存储（localStorage），标题取首条提问，可切换/新建/删除
 * - 头部第二行：模型（档案）选择、思考强度（OpenAI 兼容协议 reasoning_effort）、Agent/问答模式
 * - Agent 模式：AI 可调用工具读取终端/查询数据/发送命令（send_to_terminal 需用户逐条确认）
 * - 流式输出（后端 ai_chat 经 Channel 推送结构化事件）；消息贴底排布
 */
export function AiAssistant({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<AiConversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = loadActiveId();
    return stored ?? '';
  });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(loadMode);
  const [effort, setEffort] = useState<ReasoningEffort>(loadEffort);
  /** 等待用户确认的 send_to_terminal 调用 ID（确认交互期间工具循环挂起） */
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);
  const confirmResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);

  const aiConfig = useConfigStore((state) => state.config?.ai);
  const activeProfile = aiConfig?.profiles?.find((p) => p.id === aiConfig.active_profile);
  const isAnthropic = activeProfile?.protocol === 'anthropic';

  // 激活会话兜底：存储里找不到时取第一条（或补建一条）
  const activeConv =
    conversations.find((c) => c.id === activeId) ?? conversations[0] ?? newConversation();
  const messages = activeConv.messages;
  const conversationItems = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  const persistConversations = (list: AiConversation[]) => {
    setConversations(list);
    try {
      localStorage.setItem(CONVS_KEY, JSON.stringify(list.slice(-30)));
    } catch {
      // 存储满等异常静默忽略
    }
  };

  const switchConversation = (id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_CONV_KEY, id);
  };

  /** 更新激活会话的消息（标题取首条提问截断） */
  const updateActiveMessages = (msgs: ChatMessage[]) => {
    const list = conversations.map((c) => {
      if (c.id !== activeConv.id) return c;
      const firstUser = msgs.find((m) => m.role === 'user')?.content ?? '';
      return {
        ...c,
        messages: msgs.slice(-MAX_MESSAGES),
        title: c.title || firstUser.slice(0, 30),
        updatedAt: Date.now(),
      };
    });
    persistConversations(list);
  };

  const createConversation = () => {
    const conv = newConversation();
    persistConversations([conv, ...conversations]);
    switchConversation(conv.id);
  };

  const deleteConversation = (id: string) => {
    let list = conversations.filter((c) => c.id !== id);
    if (list.length === 0) list = [newConversation()];
    persistConversations(list);
    if (id === activeConv.id) switchConversation(list[0].id);
  };

  // 流式期间滚动跟随
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // 抽屉关闭时若有挂起的命令确认，视为拒绝（避免工具循环永久挂起）
  useEffect(() => {
    if (!open) {
      confirmResolveRef.current?.(false);
      confirmResolveRef.current = null;
      setPendingConfirmId(null);
    }
  }, [open]);

  const setModePersisted = (m: ChatMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const setEffortPersisted = (e: ReasoningEffort) => {
    setEffort(e);
    if (e) localStorage.setItem(EFFORT_KEY, e);
    else localStorage.removeItem(EFFORT_KEY);
  };

  /** 高危工具确认回调：挂起工具循环，等用户在卡片上点「允许/拒绝」 */
  const requestConfirm = (call: ToolCall): Promise<boolean> =>
    new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setPendingConfirmId(call.id);
    });

  const answerConfirm = (allowed: boolean) => {
    confirmResolveRef.current?.(allowed);
    confirmResolveRef.current = null;
    setPendingConfirmId(null);
  };

  const activeTerminalSession = () => {
    const tab = tabs.find((item) => item.id === activeTabId);
    if (!tab) return undefined;
    if (!isTerminalLike(tab.type)) return undefined;
    return tab.sessionId ?? undefined;
  };

  const grabContext = () => {
    const sessionId = activeTerminalSession();
    if (!sessionId) return;
    const text = serializeTerminalBuffer(sessionId);
    if (!text?.trim()) return;
    // 只保留尾部：上下文上限读设置（AI 助手 → context_max_chars，默认 12000 字符）
    const max = useConfigStore.getState().config?.ai?.context_max_chars ?? 12000;
    setContext(text.length > max ? text.slice(-max) : text);
  };

  /** 组装 OpenAI 兼容请求消息（system + 可选终端上下文 + 历史，含 tool 角色） */
  const toApiMessages = (history: ChatMessage[]): unknown[] => {
    const payload: unknown[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (context) {
      payload.push({
        role: 'system',
        content: `以下是用户当前终端会话的最近输出，供参考：\n\`\`\`\n${context}\n\`\`\``,
      });
    }
    for (const msg of history) {
      if (msg.role === 'user') {
        payload.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const m: Record<string, unknown> = { role: 'assistant', content: msg.content || '' };
        if (msg.toolCalls?.length) {
          m.tool_calls = msg.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          }));
        }
        payload.push(m);
      } else {
        payload.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
      }
    }
    return payload;
  };

  /** Agent 主循环：LLM 响应 → 执行其工具调用 → 结果回传 → 续轮，直至纯文本回答或达轮次上限 */
  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setStreaming(true);

    try {
      // working 为本轮循环的本地真值（含 user 消息），渲染层每次全量替换
      let working: ChatMessage[] = [...messages, { role: 'user', content: text }];
      updateActiveMessages(working);
      // 问答模式不带工具：LLM 直接文本作答，一轮结束
      const tools = mode === 'agent' ? getToolSchemas() : undefined;
      const chatOptions = effort ? { effort } : undefined;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        // 局部刷新：流式期间 working 尚未包含本条 assistant 消息
        const flush = () => updateActiveMessages([...working, { ...assistantMsg }]);

        const pending = new Map<number, ToolCall>();
        let finishReason = 'stop';
        await aiChat(
          toApiMessages(working),
          (event) => {
            if (event.type === 'text') {
              assistantMsg.content += event.content;
              flush();
            } else if (event.type === 'tool_calls') {
              aggregateToolCallDelta(pending, event.calls);
            } else if (event.type === 'finish') {
              finishReason = event.reason;
            }
          },
          tools,
          chatOptions,
        );

        const calls = finishToolCalls(pending);
        if (calls.length === 0 || finishReason !== 'tool_calls') {
          working = [...working, assistantMsg];
          updateActiveMessages(working);
          break;
        }

        // 有工具调用：先落 assistant 消息（工具卡片显示「执行中」），再逐个执行
        assistantMsg.toolCalls = calls.map((c) => ({ ...c, status: 'running' as const }));
        working = [...working, assistantMsg];
        updateActiveMessages([...working]);

        for (let i = 0; i < assistantMsg.toolCalls!.length; i++) {
          const call: ToolCall = {
            id: assistantMsg.toolCalls![i].id,
            name: assistantMsg.toolCalls![i].name,
            arguments: assistantMsg.toolCalls![i].arguments,
          };
          const exec = await executeToolCall(call, requestConfirm);
          // 原对象引用更新（working 内共享），触发渲染换新数组
          assistantMsg.toolCalls![i].status = exec.denied ? 'denied' : 'done';
          assistantMsg.toolCalls![i].result = exec.result;
          working = [...working, { role: 'tool', toolCallId: call.id, name: call.name, content: exec.result }];
          updateActiveMessages([...working]);
        }
        // 工具结果已回传，进入下一轮让 LLM 消化结果
      }
    } catch (error) {
      setConversations((prev) => {
        const next = prev.map((c) => {
          if (c.id !== activeConv.id) return c;
          const msgs = [...c.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            msgs[msgs.length - 1] = { ...last, content: `⚠️ ${String(error)}` };
          }
          return { ...c, messages: msgs };
        });
        try {
          localStorage.setItem(CONVS_KEY, JSON.stringify(next.slice(-30)));
        } catch {
          // 忽略
        }
        return next;
      });
    } finally {
      setStreaming(false);
      setPendingConfirmId(null);
      confirmResolveRef.current = null;
    }
  };

  /** 输入框自动增高（上限 ~7 行） */
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  };

  /** 下拉项通用文案：会话标题缺省显示占位 */
  const convTitle = (c: AiConversation) => c.title || t('ai.defaultTitle');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b px-4 py-2.5">
          {/* 无障碍：radix Dialog 要求 Title，视觉上由会话下拉承担 */}
          <SheetTitle className="sr-only">{t('ai.panelTitle')}</SheetTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent"
                title={t('ai.switchConversation')}
              >
                <IconBot size={16} className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{convTitle(activeConv)}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem onClick={createConversation}>
                <IconNewChat size={13} className="mr-2" />
                {t('ai.newConversation')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {conversationItems.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  className={cn('group/conv', c.id === activeConv.id && 'bg-accent/60')}
                  onClick={() => switchConversation(c.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{convTitle(c)}</span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/conv:opacity-100"
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              title={t('ai.clearHistory')}
              onClick={() => updateActiveMessages([])}
            >
              <IconTrash size={14} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
              <IconX size={14} />
            </Button>
          </div>
        </SheetHeader>

        {/* 第二行：模型 / 思考强度 / 模式 */}
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
          {/* 模型（档案）选择：切换激活档案并持久化 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={activeProfile ? `${activeProfile.name} · ${activeProfile.model}` : t('ai.modelNone')}
              >
                <IconBot size={10} className="shrink-0" />
                <span className="max-w-[140px] truncate">
                  {activeProfile ? activeProfile.model || activeProfile.name : t('ai.modelNone')}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {(aiConfig?.profiles ?? []).map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  className={cn(p.id === aiConfig?.active_profile && 'bg-accent/60')}
                  onClick={() => {
                    if (!aiConfig) return;
                    useConfigStore.getState().updateConfig({
                      ai: { ...aiConfig, active_profile: p.id },
                    });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {p.name} <span className="text-muted-foreground">· {p.model}</span>
                  </span>
                  {p.id === aiConfig?.active_profile && <IconCheck size={12} className="shrink-0 text-primary" />}
                </DropdownMenuItem>
              ))}
              {(aiConfig?.profiles?.length ?? 0) === 0 && (
                <DropdownMenuItem disabled>{t('ai.modelNone')}</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 思考强度：OpenAI 兼容协议 reasoning_effort；Anthropic 暂不支持（禁用） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={isAnthropic}>
              <button
                type="button"
                disabled={isAnthropic}
                title={isAnthropic ? t('ai.effortOpenaiOnly') : t('ai.effort')}
                className={cn(
                  'flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] transition-colors',
                  isAnthropic
                    ? 'cursor-not-allowed border-border/40 text-muted-foreground/50'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  effort && !isAnthropic && 'border-primary/40 text-primary',
                )}
              >
                {effort
                  ? t(effort === 'low' ? 'ai.effortLow' : effort === 'medium' ? 'ai.effortMedium' : 'ai.effortHigh')
                  : t('ai.effort')}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {(
                [
                  ['', 'ai.effortOff'],
                  ['low', 'ai.effortLow'],
                  ['medium', 'ai.effortMedium'],
                  ['high', 'ai.effortHigh'],
                ] as const
              ).map(([value, key]) => (
                <DropdownMenuItem
                  key={key}
                  className={cn(effort === value && 'bg-accent/60')}
                  onClick={() => setEffortPersisted(value)}
                >
                  <span className="min-w-0 flex-1">{t(key)}</span>
                  {effort === value && <IconCheck size={12} className="shrink-0 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center rounded-md border border-border/70 p-0.5">
            {(
              [
                ['agent', 'ai.modeAgent'],
                ['ask', 'ai.modeAsk'],
              ] as const
            ).map(([value, key]) => (
              <button
                key={value}
                type="button"
                title={t(key)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  mode === value ? 'bg-primary/15 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setModePersisted(value)}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        {/* 消息列表（tool 消息不单独渲染，结果并进发起它的工具卡片）；内容贴底排布 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
          <div className="flex min-h-full flex-col justify-end gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <IconSparkles size={20} className="text-primary" />
                </div>
                <p className="whitespace-pre-line text-xs text-muted-foreground">{t('ai.emptyHint')}</p>
                <div className="flex w-full max-w-[300px] flex-col items-stretch gap-1.5 pt-1">
                  {[t('ai.prompt1'), t('ai.prompt2'), t('ai.prompt3')].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="rounded-lg border border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        setInput(prompt);
                        textareaRef.current?.focus();
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, index) => {
              if (msg.role === 'tool') return null;
              const isLast = index === messages.length - 1;
              const streamingHere = streaming && isLast && msg.role === 'assistant';
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 消息列表只追加
                  key={index}
                  className="group/msg flex gap-2"
                >
                  <MessageAvatar role={msg.role} />

                  <div className="min-w-0 flex-1 space-y-1.5">
                    {msg.role === 'user' ? (
                      <div className="whitespace-pre-wrap break-words rounded-lg rounded-tl-sm bg-muted/60 px-3 py-2 text-xs leading-relaxed">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="space-y-1.5 text-xs leading-relaxed">
                        {msg.content ? <AssistantMarkdown content={msg.content} /> : null}
                        {streamingHere && (
                          <span
                            className="inline-block h-3 w-1.5 animate-pulse rounded-[1px] bg-foreground/70 align-[-2px]"
                            aria-label={t('ai.thinking')}
                          />
                        )}
                        {!msg.content && !streamingHere && <span className="text-muted-foreground">…</span>}
                      </div>
                    )}

                    {/* 工具调用卡片 */}
                    {msg.toolCalls?.map((call) => {
                      const awaitingConfirm = pendingConfirmId === call.id;
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 工具卡片随消息静态追加
                        <div key={call.id} className="overflow-hidden rounded-lg border border-border/60 bg-background/50 text-[11px]">
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                            <IconWrench size={11} className="shrink-0 text-muted-foreground" />
                            <span className="shrink-0 font-medium">{call.name}</span>
                            {summarizeArgs(call) && (
                              <span className="truncate font-mono text-muted-foreground">{summarizeArgs(call)}</span>
                            )}
                            <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                              {call.status === 'running' && <IconLoader size={10} className="animate-spin" />}
                              {call.status === 'running' && t('ai.toolRunning')}
                              {call.status === 'done' && <IconCheck size={10} className="text-emerald-500" />}
                              {call.status === 'denied' && <IconSquare size={10} />}
                              {call.status === 'denied' && t('ai.toolDenied')}
                            </span>
                          </div>

                          {/* 确认交互：高危工具（发命令/读日志）等待用户放行 */}
                          {awaitingConfirm && (
                            <div className="border-t border-border/60 bg-muted/30 px-2.5 py-1.5">
                              <div className="mb-1.5 flex items-center gap-1 text-foreground">
                                <IconPlay size={10} className="shrink-0 text-amber-500" />
                                {call.name === 'read_session_log' ? t('ai.confirmReadLog') : t('ai.confirmCommand')}
                              </div>
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => answerConfirm(false)}
                                >
                                  {t('ai.deny')}
                                </Button>
                                <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => answerConfirm(true)}>
                                  {t('ai.allow')}
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* 工具结果（默认折叠，点击展开） */}
                          {call.result && (
                            <details className="border-t border-border/60 px-2.5 py-1.5">
                              <summary className="cursor-pointer text-muted-foreground">{t('ai.toolResult')}</summary>
                              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                                {call.result}
                              </pre>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* 悬停复制（assistant 渲染原文复制，不受 markdown 影响） */}
                  <MessageCopy text={msg.content} />
                </div>
              );
            })}
          </div>
        </div>

        {/* 输入区：内嵌容器——上下文 chip 与按钮都在容器内 */}
        <div className="border-t p-3">
          <div className="rounded-xl border bg-background p-2 transition-colors focus-within:border-ring">
            {context && (
              <div className="mb-1.5 flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1">
                  <IconTerminal size={11} className="shrink-0" />
                  <span className="truncate">{t('ai.contextAttached', { chars: context.length })}</span>
                </span>
                <button
                  type="button"
                  className="shrink-0 hover:text-foreground"
                  onClick={() => setContext(null)}
                  aria-label={t('common.delete')}
                >
                  <IconX size={11} />
                </button>
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t('ai.inputPlaceholder')}
              className="min-h-[44px] resize-none border-0 bg-transparent px-1 py-1 text-xs shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 gap-1 text-[11px]', context ? 'text-primary' : 'text-muted-foreground')}
                disabled={streaming}
                onClick={grabContext}
                title={t('ai.attachContext')}
              >
                <IconTerminal size={12} />
                {t('ai.attachContext')}
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1 text-[11px]"
                disabled={streaming || !input.trim()}
                onClick={() => void send()}
              >
                {streaming ? <IconLoader size={12} className="animate-spin" /> : <IconSend size={12} />}
                {t('ai.send')}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
