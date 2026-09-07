import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot as IconBot,
  Check as IconCheck,
  CornerDownLeft as IconSend,
  Loader2 as IconLoader,
  Play as IconPlay,
  Sparkles as IconSparkles,
  Square as IconSquare,
  TerminalSquare as IconTerminal,
  Trash2 as IconTrash,
  Wrench as IconWrench,
  X as IconX,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { aiChat } from '../services/dataService';
import {
  aggregateToolCallDelta,
  executeToolCall,
  finishToolCalls,
  TOOL_SCHEMAS,
  type ToolCall,
} from '../services/aiTools';
import { serializeTerminalBuffer } from './terminalPool';
import { useTabStore } from '../store/tabStore';
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

const STORAGE_KEY = 'swallow-ai-chat-history';
/** 工具循环轮次上限（一轮 = LLM 一次完整响应 + 其工具执行），防失控 */
const MAX_TOOL_ROUNDS = 8;

const SYSTEM_PROMPT =
  '你是 Swallow 终端客户端内置的 AI 助手，帮助用户处理 SSH/运维/命令行相关问题。' +
  '你可以使用工具感知与操作软件：读取终端输出（get_terminal_output）、查询会话/主机/快捷指令' +
  '（list_sessions/list_hosts/list_snippets）、向终端发送命令（send_to_terminal，框架会弹确认框由用户把关）。' +
  '需要了解终端现状时主动调用工具，不要凭空假设。回答简洁、可操作，代码与命令用 markdown 代码块。';

/** 加载本地会话历史（localStorage 持久化，刷新不丢；兼容纯文本旧格式） */
function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** 工具卡片的参数摘要行（克制：一行文本，不展开 JSON） */
function summarizeArgs(call: ToolCallInfo): string {
  try {
    const args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    if (call.name === 'send_to_terminal') return String(args.command ?? '');
    if (call.name === 'get_terminal_output') return String(args.sessionId ?? '当前会话');
    return '';
  } catch {
    return call.arguments.slice(0, 60);
  }
}

/**
 * AI 助手侧栏：独立右侧抽屉聊天面板（不并入右侧功能面板）。
 * - Agent 化：AI 可调用工具读取终端/查询数据/发送命令（send_to_terminal 需用户逐条确认）
 * - 流式输出（后端 ai_chat 经 Channel 推送结构化事件）
 * - 可一键注入当前终端会话的屏幕输出作为上下文；历史保存在 localStorage
 */
export function AiAssistant({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  /** 等待用户确认的 send_to_terminal 调用 ID（确认交互期间工具循环挂起） */
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);
  const confirmResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);

  // 流式期间滚动跟随
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // 历史持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-60)));
    } catch {
      // 存储满等异常静默忽略
    }
  }, [messages]);

  // 抽屉关闭时若有挂起的命令确认，视为拒绝（避免工具循环永久挂起）
  useEffect(() => {
    if (!open) {
      confirmResolveRef.current?.(false);
      confirmResolveRef.current = null;
      setPendingConfirmId(null);
    }
  }, [open]);

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
    if (!['terminal', 'telnet', 'local', 'serial', 'mosh'].includes(tab.type)) return undefined;
    return tab.sessionId ?? undefined;
  };

  const grabContext = () => {
    const sessionId = activeTerminalSession();
    if (!sessionId) return;
    const text = serializeTerminalBuffer(sessionId);
    if (!text?.trim()) return;
    // 只保留尾部（上下文上限在设置里配置，默认 12000 字符）
    const max = 12000;
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
    setStreaming(true);

    try {
      // working 为本轮循环的本地真值（含 user 消息），渲染层每次全量替换
      let working: ChatMessage[] = [...messages, { role: 'user', content: text }];
      setMessages(working);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        // 局部刷新：流式期间 working 尚未包含本条 assistant 消息
        const flush = () => setMessages([...working, { ...assistantMsg }]);

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
          TOOL_SCHEMAS,
        );

        const calls = finishToolCalls(pending);
        if (calls.length === 0 || finishReason !== 'tool_calls') {
          working = [...working, assistantMsg];
          setMessages(working);
          break;
        }

        // 有工具调用：先落 assistant 消息（工具卡片显示「执行中」），再逐个执行
        assistantMsg.toolCalls = calls.map((c) => ({ ...c, status: 'running' as const }));
        working = [...working, assistantMsg];
        setMessages([...working]);

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
          setMessages([...working]);
        }
        // 工具结果已回传，进入下一轮让 LLM 消化结果
      }
    } catch (error) {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          next[next.length - 1] = { ...last, content: `⚠️ ${String(error)}` };
        }
        return next;
      });
    } finally {
      setStreaming(false);
      setPendingConfirmId(null);
      confirmResolveRef.current = null;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[420px] flex-col gap-0 p-0 sm:max-w-[420px]">
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <IconBot size={16} className="text-primary" />
            {t('ai.panelTitle')}
          </SheetTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" title={t('ai.clearHistory')} onClick={() => setMessages([])}>
              <IconTrash size={14} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
              <IconX size={14} />
            </Button>
          </div>
        </SheetHeader>

        {/* 消息列表（tool 消息不单独渲染，结果并进发起它的工具卡片） */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
              <IconSparkles size={20} />
              {t('ai.emptyHint')}
            </div>
          )}
          {messages.map((msg, index) => {
            if (msg.role === 'tool') return null;
            const isLast = index === messages.length - 1;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 消息列表只追加
                key={index}
                className="space-y-1.5"
              >
                <div
                  className={cn(
                    'max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs leading-relaxed',
                    msg.role === 'user'
                      ? 'ml-auto bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                  )}
                >
                  {msg.content || (streaming && isLast && msg.role === 'assistant' ? '…' : '')}
                </div>

                {/* 工具调用卡片 */}
                {msg.toolCalls?.map((call) => {
                  const awaitingConfirm = pendingConfirmId === call.id;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 工具卡片随消息静态追加
                    <div key={call.id} className="ml-2 max-w-[92%] rounded-md border border-border/60 bg-background/50 text-[11px]">
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <IconWrench size={11} className="shrink-0 text-muted-foreground" />
                        <span className="shrink-0 font-medium">{call.name}</span>
                        {summarizeArgs(call) && (
                          <span className="truncate text-muted-foreground">{summarizeArgs(call)}</span>
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
                        <div className="border-t border-border/60 px-2 py-1.5">
                          <div className="mb-1.5 flex items-center gap-1 text-foreground">
                            <IconPlay size={10} className="text-amber-500" />
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
                        <details className="border-t border-border/60 px-2 py-1.5">
                          <summary className="cursor-pointer text-muted-foreground">{t('ai.toolResult')}</summary>
                          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground">
                            {call.result}
                          </pre>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* 输入区 */}
        <div className="space-y-2 border-t p-3">
          {context && (
            <div className="flex items-center justify-between rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1 truncate">
                <IconTerminal size={11} />
                {t('ai.contextAttached', { chars: context.length })}
              </span>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setContext(null)}
                aria-label={t('common.delete')}
              >
                <IconX size={11} />
              </button>
            </div>
          )}
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('ai.inputPlaceholder')}
            className="min-h-[64px] resize-none text-xs"
          />
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              disabled={streaming}
              onClick={grabContext}
              title={t('ai.attachContext')}
            >
              <IconTerminal size={12} />
              {t('ai.attachContext')}
            </Button>
            <Button size="sm" className="h-7 text-[11px]" disabled={streaming || !input.trim()} onClick={() => void send()}>
              {streaming ? <IconLoader size={12} className="animate-spin" /> : <IconSend size={12} />}
              {t('ai.send')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
