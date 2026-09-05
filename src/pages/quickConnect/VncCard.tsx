import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { message } from '@tauri-apps/plugin-dialog';
import type { VncTabConfig } from '../../store/tabStore';
import { resolveHostSshAuth } from '../../services/sshAuthResolver';
import { cn } from '@/lib/utils';
import type { QuickConnectCardProps } from './types';

/** VNC 快速连接（直连；可展开经 SSH 隧道，跳板主机复用其已存认证）。 */
export function VncCard({ onOpenSession, hosts, accounts, keys, certs }: QuickConnectCardProps) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(5900);
  const [password, setPassword] = useState('');
  const [viaSsh, setViaSsh] = useState(false);
  const [sshHostId, setSshHostId] = useState('');

  const handleConnect = async () => {
    const trimmed = host.trim();
    if (!trimmed) {
      void message(t('quickConnect.vncHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    let sshConfig: VncTabConfig['ssh'];
    if (viaSsh) {
      const jump = hosts.find((h) => h.id === sshHostId);
      if (!jump) {
        void message(t('quickConnect.vncJumpRequired'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
      const auth = resolveHostSshAuth(jump, accounts, keys, certs);
      if (auth.error) {
        void message(auth.error, { title: t('common.tip'), kind: 'warning' });
        return;
      }
      if (auth.authType === 'certificate' || auth.authType === 'none') {
        void message(t('quickConnect.vncJumpUnsupported'), { title: t('common.tip'), kind: 'warning' });
        return;
      }
      sshConfig = {
        sshHost: jump.host,
        sshPort: jump.port,
        sshUsername: auth.username,
        sshAuthType: auth.authType === 'key' ? 'key' : 'password',
        sshPassword: auth.password,
        sshKeyId: auth.authType === 'key' ? auth.keyId : undefined,
        targetHost: trimmed,
        targetPort: port,
      };
    }
    onOpenSession(`vnc:${trimmed}:${port}`, 'vnc', {
      vncConfig: {
        host: trimmed,
        port,
        password: password || undefined,
        shared: true,
        ssh: sshConfig,
      },
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="text"
          placeholder={t('quickConnect.vncHost')}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConnect();
          }}
          className="h-8 min-w-0 max-w-[24rem] flex-1"
        />
        <Input
          type="number"
          value={port}
          min={1}
          max={65535}
          onChange={(e) => setPort(Number(e.target.value) || 5900)}
          className="h-8 w-20 shrink-0"
        />
        <Input
          type="password"
          placeholder={t('quickConnect.vncPassword')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConnect();
          }}
          className="h-8 w-40 shrink-0"
        />
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 shrink-0 px-2 text-xs', viaSsh && 'bg-primary/10 text-primary')}
          onClick={() => setViaSsh((v) => !v)}
          title={t('quickConnect.vncViaSshHint')}
        >
          {t('quickConnect.vncViaSsh')}
        </Button>
        <Button size="sm" className="h-8 shrink-0" onClick={() => void handleConnect()}>
          {t('quickConnect.vncConnect')}
        </Button>
      </div>

      {/* SSH 隧道展开：跳板主机（复用其已存认证），目标 = 上方 VNC 主机:端口 */}
      {viaSsh && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('quickConnect.vncJumpHost')}</span>
          <Select value={sshHostId} onValueChange={setSshHostId}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder={t('quickConnect.vncJumpPlaceholder')} />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {hosts
                .filter((h) => !h.useProxy)
                .map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name} · {h.host}:{h.port}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{t('quickConnect.vncTargetHint')}</span>
        </div>
      )}
    </div>
  );
}
