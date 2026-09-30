//! AI 回复的 markdown 渲染：代码块（语言标签 + 复制）、行内代码、GFM 表格等。
//! 自适应窄面板（420px 抽屉），字号与消息列表一致。

import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check as IconCheck, Copy as IconCopy } from 'lucide-react';

/** 递归抽取 React 子树中的纯文本（用于复制代码块原始内容） */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  const el = node as { props?: { children?: ReactNode } };
  if (el.props) return extractText(el.props.children);
  return '';
}

/** 代码块：语言标签 + 悬停复制按钮 + 横向滚动 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeEl = Array.isArray(children) ? children[0] : children;
  const className =
    typeof codeEl === 'object' && codeEl !== null && 'props' in (codeEl as object)
      ? ((codeEl as { props?: { className?: string } }).props?.className ?? '')
      : '';
  const lang = /language-([\w-]+)/.exec(className)?.[1];
  const raw = extractText(children);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1 text-[10px] text-muted-foreground">
        <span className="font-mono">{lang ?? 'code'}</span>
        <button
          type="button"
          className="transition-colors hover:text-foreground"
          aria-label="copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(raw);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            } catch {
              // 剪贴板不可用静默忽略
            }
          }}
        >
          {copied ? <IconCheck size={11} className="text-emerald-500" /> : <IconCopy size={11} />}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 text-[11px] leading-relaxed">
        <code className="font-mono">{raw}</code>
      </pre>
    </div>
  );
}

/** 行内代码 */
function InlineCode({ children }: { children?: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>
  );
}

export const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-2 text-xs leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children }) =>
            /language-/.test(className ?? '') ? (
              <code className="font-mono">{children}</code>
            ) : (
              <InlineCode>{children}</InlineCode>
            ),
          p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border/60 bg-muted/50 px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border/60 px-2 py-1 align-top">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-2.5 text-muted-foreground">{children}</blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
