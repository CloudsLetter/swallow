import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CornerDownLeft as IconSend,
  Loader2 as IconLoader,
  Sparkles as IconSparkles,
  TerminalSquare as IconTerminal,
  Trash2 as IconTrash,
  X as IconX,
} from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { aiChat } from '../services/dataService';
import { serializeTerminalBuffer } from './terminalPool';
import { useTabStore } from '../store/tabStore';
import { cn } from '../lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const STORAGE_KEY = 'swallow-ai-chat-history';

/** 加载本地会话历史（localStorage 持久化，刷新不丢） */
function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/**
 * AI 助手聊天面板（嵌入右侧功能面板的「AI」分区，原右下浮球 + Sheet 抽屉已并入）。
 * - 流式输出（后端 ai_chat 经 Channel 推送 delta）
 * - 可一键注入当前终端会话的屏幕输出作为上下文
 * - 历史保存在 localStorage（轻量持久化）；面板常驻挂载，分区间切换不丢会话状态
 */
export function AiChatPanel() {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [context, setContext] = useState<string | null>(null);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      // 存储满等异常静默忽略
    }
  }, [messages]);

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

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');

    const history = [...messages, { role: 'user' as const, content: text }];
    setMessages(history);
    setStreaming(true);

    // 组装请求：system + 历史 + 上下文
    const payload: { role: string; content: string }[] = [
      {
        role: 'system',
        content:
          '你是 Swallow 终端客户端内置的 AI 助手，帮助用户处理 SSH/运维/命令行相关问题。' +
          '回答简洁、可操作，代码与命令用 markdown 代码块。用户可能附带终端输出作为上下文。',
      },
    ];
    if (context) {
      payload.push({
        role: 'system',
        content: `以下是用户当前终端会话的最近输出，供参考：\n\`\`\`\n${context}\n\`\`\``,
      });
    }
    for (const msg of history) {
      payload.push({ role: msg.role, content: msg.content });
    }

    setMessages([...history, { role: 'assistant', content: '' }]);
    try {
      await aiChat(payload, (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + delta };
          }
          return next;
        });
      });
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
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具行：清空会话 */}
      <div className="flex h-8 shrink-0 items-center justify-end border-b border-sidebar-border pr-1">
        <Button variant="ghost" size="icon-xs" className="h-6 w-6" title={t('ai.clearHistory')} onClick={() => setMessages([])}>
          <IconTrash size={13} />
        </Button>
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
            <IconSparkles size={20} />
            {t('ai.emptyHint')}
          </div>
        )}
        {messages.map((msg, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 消息列表只追加
            key={index}
            className={cn(
              'max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs leading-relaxed',
              msg.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted text-foreground',
            )}
          >
            {msg.content || (streaming && index === messages.length - 1 ? '…' : '')}
          </div>
        ))}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 space-y-2 border-t border-sidebar-border p-2.5">
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
          className="min-h-[56px] resize-none text-xs"
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
    </div>
  );
}
