import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search as IconSearch,
  Terminal as IconTerminal,
  Monitor as IconDeviceDesktop,
  User as IconUser,
  ArrowLeftRight as IconForward,
  Key as IconKey,
  FileBadge as IconCert,
  Lock as IconLock,
  Folder as IconFolder,
  FileText as IconFileText,
  Settings as IconSettings,
  Activity as IconActivity,
  Zap as IconZap,
} from 'lucide-react';
import {
  getHosts,
  getAccounts,
  getKeys,
  getCertificates,
  type Host,
  type Account,
  type Key,
  type Certificate,
} from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { useTabStore } from '../store/tabStore';
import { useUiPage } from '../store/uiPage';
import { message } from '@tauri-apps/plugin-dialog';
import { cn } from '@/lib/utils';
import { Kbd } from './ui/kbd';

/**
 * 全局命令条（Ctrl/⌘+K）：Raycast 风格快速切换器。
 * 搜主机回车直连、搜页面跳转、快捷动作直达。
 */

type PaletteGroup = 'hosts' | 'pages' | 'actions';

interface PaletteItem {
  id: string;
  group: PaletteGroup;
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  keywords: string;
  /** 状态点色类（主机项） */
  statusDot?: string;
  run: () => void | Promise<void>;
}

const PAGE_ITEMS: { id: string; labelKey: string; Icon: typeof IconDeviceDesktop }[] = [
  { id: 'hosts', labelKey: 'menu.hosts', Icon: IconDeviceDesktop },
  { id: 'account', labelKey: 'menu.account', Icon: IconUser },
  { id: 'portforwarding', labelKey: 'menu.portForwarding', Icon: IconForward },
  { id: 'keys', labelKey: 'menu.keys', Icon: IconKey },
  { id: 'certificates', labelKey: 'menu.certificates', Icon: IconCert },
  { id: 'knownhosts', labelKey: 'menu.knownHosts', Icon: IconLock },
  { id: 'sftp', labelKey: 'menu.sftp', Icon: IconFolder },
  { id: 'snippets', labelKey: 'menu.snippets', Icon: IconTerminal },
  { id: 'monitor', labelKey: 'menu.monitor', Icon: IconActivity },
  { id: 'logs', labelKey: 'menu.logs', Icon: IconFileText },
  { id: 'settings', labelKey: 'menu.settings', Icon: IconSettings },
];

export function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hosts, setHosts] = useState<Host[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const createTab = useTabStore((s) => s.createTab);

  // 全局快捷键 Ctrl/⌘+K 唤起
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 打开时加载数据并重置状态
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    void getHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
    void Promise.all([
      getAccounts().catch(() => [] as Account[]),
      getKeys().catch(() => [] as Key[]),
      getCertificates().catch(() => [] as Certificate[]),
    ]).then(([accountList, keyList, certList]) => {
      setAccounts(accountList);
      setKeys(keyList);
      setCerts(certList);
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const connectHost = async (host: Host) => {
    const auth = resolveHostSshAuth(host, accounts, keys, certs);
    if (auth.error) {
      await message(auth.error, { title: t('quickConnect.cannotConnect'), kind: 'warning' });
      return;
    }
    createTab({
      name: host.name,
      type: 'terminal',
      sshConfig: {
        host: host.host,
        port: host.port,
        username: auth.username,
        auth_type: auth.authType,
        password: auth.password,
        key_id: auth.authType === 'key' ? auth.keyId : undefined,
        cert_id: auth.authType === 'certificate' ? auth.certId : undefined,
        passphrase: undefined,
        hostId: host.id,
      },
    });
    close();
  };

  const navigateTo = (pageId: string) => {
    useUiPage.getState().setPendingNav(pageId);
    close();
  };

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();

    const hostItems: PaletteItem[] = hosts
      .filter((host) =>
        !q ||
        host.name.toLowerCase().includes(q) ||
        host.host.toLowerCase().includes(q) ||
        host.username.toLowerCase().includes(q) ||
        String(host.port).includes(q),
      )
      .sort((a, b) => {
        if (!a.lastConnected && !b.lastConnected) return 0;
        if (!a.lastConnected) return 1;
        if (!b.lastConnected) return -1;
        return new Date(b.lastConnected).getTime() - new Date(a.lastConnected).getTime();
      })
      .slice(0, q ? 8 : 5)
      .map((host) => ({
        id: `host-${host.id}`,
        group: 'hosts' as const,
        icon: (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <IconTerminal size={13} strokeWidth={2} />
          </span>
        ),
        label: host.name,
        subtitle: `${host.username}@${host.host}:${host.port}`,
        keywords: `${host.name} ${host.host} ${host.username}`,
        run: () => void connectHost(host),
      }));

    const pageItems: PaletteItem[] = PAGE_ITEMS.filter(
      (page) => !q || t(page.labelKey).toLowerCase().includes(q) || page.id.includes(q),
    ).map((page) => ({
      id: `page-${page.id}`,
      group: 'pages' as const,
      icon: (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <page.Icon size={13} strokeWidth={2} />
        </span>
      ),
      label: t(page.labelKey),
      keywords: `${t(page.labelKey)} ${page.id}`,
      run: () => navigateTo(page.id),
    }));

    const actionItems: PaletteItem[] = [
      {
        id: 'action-quick-connect',
        group: 'actions' as const,
        icon: (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <IconZap size={13} strokeWidth={2} />
          </span>
        ),
        label: t('palette.openQuickConnect'),
        keywords: `${t('palette.openQuickConnect')} quick-connect ssh vnc rdp mosh telnet serial`,
        run: () => {
          createTab({ name: t('quickConnect.title'), type: 'quick-connect' });
          close();
        },
      },
    ].filter((item) => !q || item.keywords.toLowerCase().includes(q));

    return [...hostItems, ...pageItems, ...actionItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hosts, accounts, keys, certs, t]);

  // 过滤后收敛选中索引
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  const runItem = (item: PaletteItem) => {
    void item.run();
  };

  const groupLabel = (group: PaletteGroup) =>
    group === 'hosts' ? t('hosts.title') : group === 'pages' ? t('palette.pages') : t('palette.actions');

  let lastGroup: PaletteGroup | null = null;
  let flatIndex = -1;

  return (
    // 命令条自己的遮罩层：点击空白关闭；Esc 在 input 的 onKeyDown 处理
    <div className="fixed inset-0 z-[80]" onMouseDown={close}>
      <div className="absolute inset-0 bg-[var(--overlay)]" />
      <div
        className="absolute left-1/2 top-[14%] w-[560px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-xl bg-popover shadow-xl ring-1 ring-foreground/10"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 搜索输入 */}
        <div className="flex h-12 items-center gap-2.5 border-b border-border/60 px-4">
          <IconSearch size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = items[selectedIndex];
                if (item) runItem(item);
              }
            }}
            placeholder={t('palette.placeholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          <Kbd>esc</Kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="overlay-scrollbar max-h-[380px] overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">{t('palette.empty')}</p>
          ) : (
            items.map((item) => {
              flatIndex += 1;
              const index = flatIndex;
              const showGroupHeader = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {showGroupHeader && (
                    <div className="px-2 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 first:pt-1">
                      {groupLabel(item.group)}
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => runItem(item)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                      index === selectedIndex ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{item.label}</span>
                      {item.subtitle && (
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    {item.statusDot && <span className={cn('size-1.5 shrink-0 rounded-full', item.statusDot)} />}
                    {index === selectedIndex && <Kbd>↵</Kbd>}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
