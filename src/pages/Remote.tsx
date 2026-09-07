import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plus as IconPlus,
  Pencil as IconPencil,
  Trash2 as IconTrash,
  Play as IconPlay,
  Monitor as IconMonitor,
  ScreenShare as IconScreenShare,
} from 'lucide-react';
import { useTabStore, type VncTabConfig } from '../store/tabStore';
import { getHosts, getAccounts, getKeys, getCertificates, type Host, type Account, type Key, type Certificate } from '../services/dataService';
import { resolveHostSshAuth } from '../services/sshAuthResolver';
import { listRemoteConns, saveRemoteConn, deleteRemoteConn, type RemoteConn } from '../services/remoteConns';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { cn } from '@/lib/utils';

/** VNC/RDP 会话簿：把远程桌面存成可复用条目，点连接即开标签。 */
export function Remote() {
  const { t } = useTranslation();
  const createTab = useTabStore((s) => s.createTab);

  const [items, setItems] = useState<RemoteConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [hosts, setHosts] = useState<Host[]>([]);
  // 表单（新建/编辑共用；null 表示关闭）
  const [form, setForm] = useState<RemoteConn | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listRemoteConns());
    } catch (e) {
      console.error('Failed to load remote conns:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setForm({
      id: '',
      name: '',
      protocol: 'vnc',
      host: '',
      port: 5900,
      username: '',
      password: '',
      jumpHostId: undefined,
      created: '',
    });
    // 跳板下拉需要主机清单
    void getHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  };

  const openEdit = (item: RemoteConn) => {
    setForm({ ...item });
    void getHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast.warning(t('remote.nameRequired'));
      return;
    }
    if (!form.host.trim()) {
      toast.warning(t('remote.hostRequired'));
      return;
    }
    if (form.protocol === 'vnc' && form.jumpHostId && !hosts.some((h) => h.id === form.jumpHostId)) {
      toast.warning(t('remote.jumpRequired'));
      return;
    }
    try {
      const saved = await saveRemoteConn({
        ...form,
        name: form.name.trim(),
        host: form.host.trim(),
        username: form.username?.trim() || undefined,
        password: form.password?.trim() || undefined,
        jumpHostId: form.protocol === 'vnc' ? form.jumpHostId : undefined,
      });
      toast.success(form.id ? t('remote.updated') : t('remote.created'));
      setForm(null);
      // 用返回的规范化条目更新列表
      setItems((list) => {
        const rest = list.filter((c) => c.id !== saved.id);
        return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const remove = async (item: RemoteConn) => {
    const ok = await ask(t('remote.deleteConfirm', { name: item.name }), {
      title: t('common.deleteConfirm'),
      kind: 'warning',
    });
    if (!ok) return;
    try {
      await deleteRemoteConn(item.id);
      setItems((list) => list.filter((c) => c.id !== item.id));
      toast.success(t('remote.deleted'));
    } catch (e) {
      toast.error(String(e));
    }
  };

  /** 解析会话簿条目 → 建 vnc/rdp 标签（VNC 隧道复用跳板主机已存认证，凭据不落本表）。 */
  const connect = async (item: RemoteConn) => {
    try {
      if (item.protocol === 'rdp') {
        createTab({
          name: `${item.name} (RDP)`,
          type: 'rdp',
          rdpConfig: {
            host: item.host,
            port: item.port,
            username: item.username ?? '',
            password: item.password || undefined,
          },
        });
        return;
      }
      // VNC
      let ssh: VncTabConfig['ssh'];
      if (item.jumpHostId) {
        const jump = hosts.find((h) => h.id === item.jumpHostId) ?? (await getHosts()).find((h) => h.id === item.jumpHostId);
        if (!jump) {
          void message(t('remote.jumpMissing'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        const [accounts, keys, certs]: [Account[], Key[], Certificate[]] = await Promise.all([
          getAccounts().catch(() => []),
          getKeys().catch(() => []),
          getCertificates().catch(() => []),
        ]);
        const auth = resolveHostSshAuth(jump, accounts, keys, certs);
        if (auth.error) {
          void message(auth.error, { title: t('common.tip'), kind: 'warning' });
          return;
        }
        if (auth.authType === 'certificate' || auth.authType === 'none') {
          void message(t('remote.jumpUnsupported'), { title: t('common.tip'), kind: 'warning' });
          return;
        }
        ssh = {
          sshHost: jump.host,
          sshPort: jump.port,
          sshUsername: auth.username,
          sshAuthType: auth.authType === 'key' ? 'key' : 'password',
          sshPassword: auth.password,
          sshKeyId: auth.authType === 'key' ? auth.keyId : undefined,
          targetHost: item.host,
          targetPort: item.port,
        };
      }
      createTab({
        name: `${item.name} (VNC)`,
        type: 'vnc',
        vncConfig: {
          host: item.host,
          port: item.port,
          password: item.password || undefined,
          shared: true,
          ...(ssh ? { ssh } : {}),
        },
      });
    } catch (e) {
      console.error('Failed to connect remote:', e);
      toast.error(String(e));
    }
  };

  const jumpName = (id?: string) => hosts.find((h) => h.id === id)?.name;

  return (
    <div className="flex h-full flex-col">
      {/* 页头 */}
      <div className="flex min-h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{t('menu.desktop')}</h2>
        <Button size="sm" onClick={openNew}>
          <IconPlus size={16} strokeWidth={2} />
          {t('remote.add')}
        </Button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <IconMonitor size={28} strokeWidth={1.5} className="mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('remote.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const vnc = item.protocol === 'vnc';
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    {vnc ? <IconMonitor size={15} strokeWidth={2} /> : <IconScreenShare size={15} strokeWidth={2} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                        {vnc ? 'VNC' : 'RDP'}
                      </Badge>
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {item.host}:{item.port}
                      {!vnc && item.username ? `  ${item.username}` : ''}
                      {vnc && item.jumpHostId ? `  via ${jumpName(item.jumpHostId) ?? ''}` : ''}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => void connect(item)}>
                    <IconPlay size={14} strokeWidth={2} />
                    {t('remote.connect')}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(item)} title={t('common.edit')} aria-label={t('common.edit')}>
                    <IconPencil size={15} strokeWidth={2} />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => void remove(item)} title={t('common.delete')} aria-label={t('common.delete')}>
                    <IconTrash size={15} strokeWidth={2} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新建/编辑表单 */}
      <Sheet open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <SheetContent side="right" className="w-[400px]">
          <SheetHeader>
            <SheetTitle>{form?.id ? t('remote.edit') : t('remote.add')}</SheetTitle>
          </SheetHeader>
          {form && (
            <div className="flex flex-col gap-4 py-4">
              <div>
                <Label className="mb-1.5 block text-xs">{t('remote.protocol')}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(['vnc', 'rdp'] as const).map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant={form.protocol === p ? 'default' : 'outline'}
                      onClick={() => setForm({ ...form, protocol: p, port: p === 'vnc' ? 5900 : 3389, jumpHostId: undefined })}
                    >
                      {p === 'vnc' ? 'VNC' : 'RDP'}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">{t('remote.name')}</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="workstation" />
              </div>
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <div>
                  <Label className="mb-1.5 block text-xs">{t('remote.host')}</Label>
                  <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10" />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">{t('remote.port')}</Label>
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
              {form.protocol === 'vnc' ? (
                <>
                  <div>
                    <Label className="mb-1.5 block text-xs">{t('remote.passwordOptional')}</Label>
                    <Input
                      type="password"
                      value={form.password ?? ''}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={t('remote.passwordPlaceholder')}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2">
                    <div>
                      <span className="text-xs font-medium">{t('remote.viaSsh')}</span>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{t('remote.viaSshDesc')}</p>
                    </div>
                    <Switch
                      checked={!!form.jumpHostId}
                      onCheckedChange={(v) => setForm({ ...form, jumpHostId: v ? hosts[0]?.id : undefined })}
                    />
                  </div>
                  {form.jumpHostId && (
                    <div>
                      <Label className="mb-1.5 block text-xs">{t('remote.jumpHost')}</Label>
                      <Select
                        value={form.jumpHostId || ''}
                        onValueChange={(v) => setForm({ ...form, jumpHostId: v })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder={t('remote.selectHost')} />
                        </SelectTrigger>
                        <SelectContent>
                          {hosts.length === 0 ? (
                            <SelectItem value="__none__" disabled>
                              {t('remote.noHosts')}
                            </SelectItem>
                          ) : (
                            hosts.map((h) => (
                              <SelectItem key={h.id} value={h.id}>
                                {h.name} ({h.host}:{h.port})
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div>
                    <Label className="mb-1.5 block text-xs">{t('remote.username')}</Label>
                    <Input
                      value={form.username ?? ''}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      placeholder="Administrator"
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs">{t('remote.passwordOptional')}</Label>
                    <Input
                      type="password"
                      value={form.password ?? ''}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <SheetFooter>
            <Button
              variant="secondary"
              onClick={() => setForm(null)}
              className={cn('mr-auto')}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={!form}>
              {t('common.save')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
