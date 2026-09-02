import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getSnippets,
  useSnippet as useSnippetApi,
  type Snippet,
} from '../services/dataService';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Search as IconSearch, Terminal as IconTerminal } from 'lucide-react';

interface SnippetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选中某条指令后回调（command 为纯命令文本，调用方负责发送并追加回车） */
  onPick: (command: string) => void;
}

/** 终端快捷指令选择器：搜索 + 分组列表，选中后把命令发回当前终端会话执行。 */
export function SnippetPicker({ open, onOpenChange, onPick }: SnippetPickerProps) {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    void getSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]));
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return snippets;
    const q = query.trim().toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.tags?.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [snippets, query]);

  const groups = useMemo(() => {
    const keys = [...new Set(filtered.map((s) => s.category || t('snippets.uncategorized')))].sort(
      (a, b) => a.localeCompare(b),
    );
    return keys.map((key) => ({
      key,
      items: filtered.filter((s) => (s.category || t('snippets.uncategorized')) === key),
    }));
  }, [filtered, t]);

  const handlePick = (snippet: Snippet) => {
    onPick(snippet.command);
    void useSnippetApi(snippet.id).catch(() => {});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('snippets.title')}</DialogTitle>
        </DialogHeader>

        <div className="relative mb-2">
          <IconSearch
            size={15}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('snippets.searchPlaceholder')}
            className="pl-8"
          />
        </div>

        <div className="overlay-scrollbar max-h-80 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
              <IconTerminal size={22} className="mb-2 opacity-50" />
              {query ? t('snippets.emptySearch') : t('snippets.emptyNone')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                    <span>{group.key}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10px]">{group.items.length}</span>
                  </div>
                  {group.items.map((snippet) => (
                    <button
                      key={snippet.id}
                      type="button"
                      onClick={() => handlePick(snippet)}
                      className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{snippet.name}</span>
                        {snippet.category && (
                          <Badge variant="outline" className="h-4 shrink-0 rounded-sm px-1 text-[10px]">
                            {snippet.category}
                          </Badge>
                        )}
                      </span>
                      <code className="truncate font-mono text-xs text-muted-foreground">{snippet.command}</code>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
