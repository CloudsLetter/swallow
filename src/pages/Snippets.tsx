import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n/i18n';
import {
  getSnippets,
  addSnippet,
  updateSnippet,
  removeSnippet,
  useSnippet as useSnippetApi,
  type Snippet,
} from '../services/dataService';
import {
  Plus as IconPlus,
  Pencil as IconEdit,
  Copy as IconCopy,
  Check as IconCheck,
  Trash2 as IconTrash,
  Terminal as IconTerminal,
  Tag as IconTag,
  LayoutGrid as IconLayoutGrid,
  List as IconList,
  Search as IconSearch,
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { CardGridSkeleton, ListTableSkeleton } from '../components/ui/listSkeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { message, ask } from '@tauri-apps/plugin-dialog';

type ViewMode = 'grid' | 'list';

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border bg-card p-4';

interface SnippetForm {
  name: string;
  command: string;
  category: string;
  tags: string;
  description: string;
}

const EMPTY_FORM: SnippetForm = { name: '', command: '', category: '', tags: '', description: '' };

const CATEGORY_META: Record<string, string> = {
  docker: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  git: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ssh: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  network: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  nginx: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  system: 'bg-muted text-muted-foreground',
};

const categoryBadge = (category: string) => {
  const cls = CATEGORY_META[category] || 'bg-muted text-muted-foreground';
  return <Badge variant="outline" className={cn('font-normal', cls)}>{category || i18n.t('snippets.uncategorized')}</Badge>;
};

export function Snippets() {
  const { t } = useTranslation();
  // ============ 数据状态 ============
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============ UI 状态 ============
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ============ 表单状态 ============
  const [form, setForm] = useState<SnippetForm>(EMPTY_FORM);

  useEffect(() => {
    void loadSnippets();
  }, []);

  // ============ 键盘快捷键 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadSnippets = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnippets(await getSnippets());
    } catch (loadError) {
      console.error('Failed to load snippets:', loadError);
      setError(t('snippets.loadFailedMsg'));
    } finally {
      setLoading(false);
    }
  };

  // ============ 表单逻辑 ============
  const openCreate = () => {
    setEditingSnippet(null);
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  };

  const openEdit = (snippet: Snippet) => {
    setEditingSnippet(snippet);
    setForm({
      name: snippet.name,
      command: snippet.command,
      category: snippet.category,
      tags: snippet.tags?.join(', ') || '',
      description: snippet.description || '',
    });
    setSheetOpen(true);
  };

  const isFormValid = Boolean(form.name.trim() && form.command.trim() && form.category.trim());

  const handleSave = async () => {
    const nextName = form.name.trim();
    const nextCommand = form.command.trim();
    const nextCategory = form.category.trim();
    if (!nextName) {
      await message(t('snippets.formNameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!nextCommand) {
      await message(t('snippets.formCommandRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!nextCategory) {
      await message(t('snippets.formCategoryRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }

    const data = {
      name: nextName,
      command: nextCommand,
      category: nextCategory,
      description: form.description.trim() || undefined,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    try {
      if (editingSnippet) {
        await updateSnippet(editingSnippet.id, data);
      } else {
        await addSnippet(data);
      }
      setSheetOpen(false);
      setEditingSnippet(null);
      await loadSnippets();
    } catch (saveError) {
      console.error('Failed to save snippet:', saveError);
      await message(t('common.saveFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleRemove = async (snippet: Snippet) => {
    const confirmed = await ask(t('snippets.deleteConfirmBody', { name: snippet.name }), { title: t('common.deleteConfirm'), kind: 'warning' });
    if (!confirmed) return;
    try {
      await removeSnippet(snippet.id);
      await loadSnippets();
    } catch (removeError) {
      console.error('Failed to remove snippet:', removeError);
      await message(t('common.deleteFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  const handleCopy = async (snippet: Snippet) => {
    try {
      await navigator.clipboard.writeText(snippet.command);
      setCopiedId(snippet.id);
      window.setTimeout(() => setCopiedId((current) => (current === snippet.id ? null : current)), 1500);
      await useSnippetApi(snippet.id);
      await loadSnippets();
    } catch (copyError) {
      console.error('Failed to copy snippet:', copyError);
      await message(t('snippets.copyFailed'), { title: t('common.error'), kind: 'error' });
    }
  };

  // ============ 派生数据 ============
  const filteredSnippets = snippets.filter((snippet) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      snippet.name.toLowerCase().includes(query) ||
      snippet.command.toLowerCase().includes(query) ||
      snippet.category.toLowerCase().includes(query) ||
      snippet.description?.toLowerCase().includes(query) ||
      snippet.tags?.some((tag) => tag.toLowerCase().includes(query))
    );
  });

  const groups = [...new Set(filteredSnippets.map((snippet) => snippet.category || t('snippets.uncategorized')))]
    .sort((a, b) => a.localeCompare(b))
    .map((category) => ({
      key: category,
      label: category,
      items: filteredSnippets.filter((snippet) => (snippet.category || t('snippets.uncategorized')) === category),
    }));

  const fieldLabel = (children: React.ReactNode) => <Label className="mb-1.5 block text-xs font-medium">{children}</Label>;
  const fieldHint = (children: React.ReactNode) => <p className="mt-2 text-xs text-muted-foreground">{children}</p>;

  const renderSnippetCard = (snippet: Snippet) => {
    return (
      <div
        key={snippet.id}
        className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <IconTerminal size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{snippet.name}</span>
            {categoryBadge(snippet.category)}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={snippet.command}
          >
            <span className="select-none text-muted-foreground/60">$ </span>
            {snippet.command}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => void handleCopy(snippet)}
            title={t('snippets.copyCommand')}
            aria-label={t('snippets.copyCommand')}
          >
            {copiedId === snippet.id ? <IconCheck size={14} strokeWidth={2} /> : <IconCopy size={14} strokeWidth={2} />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={t('common.moreActions')}>
                <IconMore size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(snippet)}>
                <IconEdit size={15} className="mr-2" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(snippet)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderSnippetRow = (snippet: Snippet) => (
    <TableRow key={snippet.id} className="group transition-colors hover:bg-accent/40">
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <IconTerminal size={15} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{snippet.name}</span>
            {snippet.tags && snippet.tags.length > 0 && (
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <IconTag size={11} />
                {snippet.tags.slice(0, 3).join(', ')}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{categoryBadge(snippet.category)}</TableCell>
      <TableCell className="max-w-0">
        <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {snippet.command}
        </code>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {snippet.lastUsed ? new Date(snippet.lastUsed).toLocaleString('zh-CN') : t('snippets.neverUsed')}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void handleCopy(snippet)}
            title={t('snippets.copyCommand')}
          >
            {copiedId === snippet.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copiedId === snippet.id ? t('common.copied') : t('common.copy')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('common.moreActions')}
              >
                <IconMore size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(snippet)}>
                <IconEdit size={15} className="mr-2" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(snippet)}>
                <IconTrash size={15} className="mr-2" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );

  const renderLoading = () =>
    viewMode === 'grid' ? (
      <CardGridSkeleton />
    ) : (
      <ListTableSkeleton
        colCount={7}
        head={
          <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[26%] min-w-[200px]">{t('snippets.tableSnippet')}</TableHead>
                          <TableHead>{t('snippets.tableCategory')}</TableHead>
                          <TableHead>{t('snippets.tableCommand')}</TableHead>
                          <TableHead>{t('snippets.tableLastUsed')}</TableHead>
                          <TableHead className="w-28 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        }
      />
    );

  const renderEmpty = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconTerminal size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{searchQuery ? t('snippets.emptySearch') : t('snippets.emptyNone')}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {searchQuery
          ? t('snippets.emptySearchDesc', { query: searchQuery })
          : t('snippets.emptyNoneDesc')}
      </p>
      {!searchQuery && (
        <Button className="mt-6" onClick={openCreate}>
          <IconPlus size={16} /> {t('snippets.createSnippet')}
        </Button>
      )}
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <IconAlert size={30} strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold">{t('common.loadFailed')}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{error || t('snippets.loadFailedDesc')}</p>
      <Button variant="secondary" className="mt-6" onClick={() => void loadSnippets()}>
        <IconRefresh size={16} /> {t('common.retry')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* ===== 页头 ===== */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-base font-semibold text-foreground">{t('snippets.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('snippets.snippetCount', { count: filteredSnippets.length })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 max-w-[360px] flex-1">
            <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t('snippets.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg pl-8"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7',
                viewMode === 'grid' && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
              )}
              onClick={() => setViewMode('grid')}
              aria-label={t('common.gridView')}
              title={t('common.gridView')}
            >
              <IconLayoutGrid size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7',
                viewMode === 'list' && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
              )}
              onClick={() => setViewMode('list')}
              aria-label={t('common.listView')}
              title={t('common.listView')}
            >
              <IconList size={15} />
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void loadSnippets()} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <IconRefresh size={16} />
          </Button>
          <Button onClick={openCreate} title={t('snippets.createSnippet')}>
            <IconPlus size={16} strokeWidth={2} />
            {t('snippets.add')}
          </Button>
        </div>
      </div>

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : error && snippets.length === 0 ? (
          renderError()
        ) : filteredSnippets.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground">{group.label}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                {viewMode === 'grid' ? (
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
                    {group.items.map((snippet) => renderSnippetCard(snippet))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                      <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="w-[26%] min-w-[200px]">{t('snippets.tableSnippet')}</TableHead>
                          <TableHead>{t('snippets.tableCategory')}</TableHead>
                          <TableHead>{t('snippets.tableCommand')}</TableHead>
                          <TableHead>{t('snippets.tableLastUsed')}</TableHead>
                          <TableHead className="w-28 text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{group.items.map((snippet) => renderSnippetRow(snippet))}</TableBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ===== 新建/编辑片段抽屉 ===== */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{editingSnippet ? t('snippets.editSnippet') : t('snippets.createSnippet')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3.5">
            {/* 基本信息 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('snippets.basicInfo')}</div>
                <div className="text-xs text-muted-foreground">{t('snippets.basicInfoDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('snippets.snippetName')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('snippets.snippetNamePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  {fieldLabel(
                    <>
                      {t('snippets.category')} <span className="text-destructive">*</span>
                    </>,
                  )}
                  <Input
                    type="text"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder={t('snippets.categoryPlaceholder')}
                  />
                </div>
                <div>
                  {fieldLabel(t('snippets.tags'))}
                  <Input
                    type="text"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder={t('snippets.tagsPlaceholder')}
                  />
                </div>
              </div>
              {fieldHint(t('snippets.categoryHint'))}
            </div>

            {/* 命令内容 */}
            <div className={sectionClass}>
              <div>
                <div className="text-sm font-semibold text-foreground">{t('snippets.commandSection')}</div>
                <div className="text-xs text-muted-foreground">{t('snippets.commandSectionDesc')}</div>
              </div>
              <div>
                {fieldLabel(
                  <>
                    {t('snippets.command')} <span className="text-destructive">*</span>
                  </>,
                )}
                <Textarea
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  rows={4}
                  className="font-mono text-sm"
                  placeholder={t('snippets.commandPlaceholder')}
                />
              </div>
            </div>

            {/* 备注 */}
            <div className={sectionClass}>
              <div>
                {fieldLabel(t('common.description'))}
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder={t('snippets.descriptionPlaceholder')}
                />
              </div>
            </div>
          </div>
          <SheetFooter>
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!isFormValid}>
              {editingSnippet ? t('snippets.saveChanges') : t('snippets.createSnippetAction')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
