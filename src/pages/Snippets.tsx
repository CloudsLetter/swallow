import { useState, useEffect, useRef } from 'react';
import { copyText } from '../lib/clipboard';
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
  RefreshCw as IconRefresh,
  AlertTriangle as IconAlert,
  MoreHorizontal as IconMore,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { CategoryTransferButtons } from '../components/CategoryTransfer';
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
import {
  EmptyState,
  ErrorState,
  ManageCard,
  ManageCardIcon,
  PageHeader,
  SectionHeading,
  ViewToggle,
} from '../components/PageHeader';

type ViewMode = 'grid' | 'list';

const sectionClass = 'flex flex-col gap-3 rounded-lg bg-muted/40 p-4';

interface SnippetForm {
  name: string;
  command: string;
  category: string;
  tags: string;
  description: string;
}

const EMPTY_FORM: SnippetForm = { name: '', command: '', category: '', tags: '', description: '' };

const CATEGORY_META: Record<string, string> = {
  docker: 'bg-info/10 text-info',
  git: 'bg-warning/10 text-warning',
  ssh: 'bg-success/10 text-success',
  network: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
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
      await copyText(snippet.command);
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
      <ManageCard key={snippet.id}>
        <ManageCardIcon>
          <IconTerminal size={15} strokeWidth={2} aria-hidden="true" />
        </ManageCardIcon>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{snippet.name}</span>
            {categoryBadge(snippet.category)}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={snippet.command}
          >
            <span className="select-none text-muted-foreground/60" aria-hidden="true">$ </span>
            {snippet.command}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            className="size-8"
            onClick={() => void handleCopy(snippet)}
            title={t('snippets.copyCommand')}
            aria-label={`${t('snippets.copyCommand')} ${snippet.name}`}
          >
            {copiedId === snippet.id ? <IconCheck size={14} strokeWidth={2} aria-hidden="true" /> : <IconCopy size={14} strokeWidth={2} aria-hidden="true" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className="size-8" aria-label={`${t('common.moreActions')} ${snippet.name}`}>
                <IconMore size={14} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(snippet)}>
                <IconEdit size={15} className="mr-2" aria-hidden="true" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(snippet)}>
                <IconTrash size={15} className="mr-2" aria-hidden="true" /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ManageCard>
    );
  };

  const renderSnippetRow = (snippet: Snippet) => (
    <TableRow key={snippet.id} className="transition-colors hover:bg-accent/40">
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <ManageCardIcon>
            <IconTerminal size={15} strokeWidth={2} aria-hidden="true" />
          </ManageCardIcon>
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{snippet.name}</span>
            {snippet.tags && snippet.tags.length > 0 && (
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <IconTag size={11} aria-hidden="true" />
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
      <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        {snippet.lastUsed ? new Date(snippet.lastUsed).toLocaleString('zh-CN') : t('snippets.neverUsed')}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCopy(snippet)}
            title={t('snippets.copyCommand')}
            aria-label={`${t('snippets.copyCommand')} ${snippet.name}`}
          >
            {copiedId === snippet.id ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />}
            {copiedId === snippet.id ? t('common.copied') : t('common.copy')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-7"
                aria-label={`${t('common.moreActions')} ${snippet.name}`}
              >
                <IconMore size={15} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(snippet)}>
                <IconEdit size={15} className="mr-2" aria-hidden="true" /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => void handleRemove(snippet)}>
                <IconTrash size={15} className="mr-2" aria-hidden="true" /> {t('common.delete')}
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

  const hasFilter = searchQuery !== '';
  const renderEmpty = () => (
    <EmptyState
      icon={<IconTerminal size={24} strokeWidth={1.5} aria-hidden="true" />}
      title={hasFilter ? t('snippets.emptySearch') : t('snippets.emptyNone')}
      description={
        hasFilter ? t('snippets.emptySearchDesc', { query: searchQuery }) : t('snippets.emptyNoneDesc')
      }
      action={
        !hasFilter ? (
          <Button onClick={openCreate}>
            <IconPlus size={15} aria-hidden="true" /> {t('snippets.createSnippet')}
          </Button>
        ) : undefined
      }
    />
  );

  const renderError = () => (
    <ErrorState
      icon={<IconAlert size={24} strokeWidth={1.5} aria-hidden="true" />}
      title={t('common.loadFailed')}
      description={error || t('snippets.loadFailedDesc')}
      retryLabel={t('common.retry')}
      onRetry={() => void loadSnippets()}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('snippets.title')}
        subtitle={t('snippets.snippetCount', { count: filteredSnippets.length })}
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: t('snippets.searchPlaceholder'),
          inputRef: searchRef,
        }}
        actions={
          <>
            <ViewToggle
              mode={viewMode}
              onChange={setViewMode}
              gridLabel={t('common.gridView')}
              listLabel={t('common.listView')}
              GridIcon={IconLayoutGrid}
              ListIcon={IconList}
            />
            <Button variant="ghost" size="icon" onClick={() => void loadSnippets()} aria-label={t('common.refresh')} title={t('common.refresh')}>
              <IconRefresh size={15} aria-hidden="true" />
            </Button>
            <CategoryTransferButtons
              category="snippets"
              label={t('menu.snippets')}
              defaultFileName="swallow-snippets.json"
              onImported={loadSnippets}
            />
            <Button onClick={openCreate} title={t('snippets.createSnippet')}>
              <IconPlus size={15} strokeWidth={2} aria-hidden="true" />
              {t('snippets.add')}
            </Button>
          </>
        }
      />

      {/* ===== 内容区域 ===== */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          renderLoading()
        ) : error && snippets.length === 0 ? (
          renderError()
        ) : filteredSnippets.length === 0 ? (
          renderEmpty()
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5">
                <SectionHeading tone="muted" label={group.label} count={group.items.length} />
                {viewMode === 'grid' ? (
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))' }}>
                    {group.items.map((snippet) => renderSnippetCard(snippet))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
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
