import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { message } from '@tauri-apps/plugin-dialog';
import type { QuickConnectCardProps } from './types';

/** MOSH 快速连接（SSH 引导：密码认证；密钥/证书走 Hosts 页入口）。 */
export function MoshCard({ onOpenSession }: Pick<QuickConnectCardProps, 'onOpenSession'>) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleConnect = () => {
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    if (!trimmedHost) {
      void message(t('quickConnect.moshHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!trimmedUser) {
      void message(t('quickConnect.moshUsernameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    onOpenSession(`mosh:${trimmedHost}:${port}`, 'mosh', {
      moshConfig: {
        host: trimmedHost,
        port,
        username: trimmedUser,
        auth_type: 'password',
        password,
      },
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="text"
          placeholder={t('quickConnect.moshHost')}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConnect();
          }}
          className="h-8 min-w-0 max-w-[16rem] flex-1"
        />
        <Input
          type="number"
          value={port}
          min={1}
          max={65535}
          onChange={(e) => setPort(Number(e.target.value) || 22)}
          className="h-8 w-20 shrink-0"
        />
        <Input
          type="text"
          placeholder={t('quickConnect.moshUsername')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConnect();
          }}
          className="h-8 w-40 shrink-0"
        />
        <Input
          type="password"
          placeholder={t('quickConnect.moshPassword')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConnect();
          }}
          className="h-8 w-40 shrink-0"
        />
        <Button size="sm" className="h-8 shrink-0" onClick={handleConnect}>
          {t('quickConnect.moshConnect')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('quickConnect.moshHint')}</p>
    </div>
  );
}
