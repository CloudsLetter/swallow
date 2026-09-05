import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { message } from '@tauri-apps/plugin-dialog';
import type { QuickConnectCardProps } from './types';

/** RDP 快速连接（NLA 认证：用户名/密码必填；初始分辨率由 RdpView 按容器尺寸决定）。 */
export function RdpCard({ onOpenSession }: Pick<QuickConnectCardProps, 'onOpenSession'>) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(3389);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleConnect = () => {
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    if (!trimmedHost) {
      void message(t('quickConnect.rdpHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    if (!trimmedUser) {
      void message(t('quickConnect.rdpUsernameRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    onOpenSession(`rdp:${trimmedHost}:${port}`, 'rdp', {
      rdpConfig: { host: trimmedHost, port, username: trimmedUser, password },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        type="text"
        placeholder={t('quickConnect.rdpHost')}
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
        onChange={(e) => setPort(Number(e.target.value) || 3389)}
        className="h-8 w-20 shrink-0"
      />
      <Input
        type="text"
        placeholder={t('quickConnect.rdpUsername')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleConnect();
        }}
        className="h-8 w-40 shrink-0"
      />
      <Input
        type="password"
        placeholder={t('quickConnect.rdpPassword')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleConnect();
        }}
        className="h-8 w-40 shrink-0"
      />
      <Button size="sm" className="h-8 shrink-0" onClick={handleConnect}>
        {t('quickConnect.rdpConnect')}
      </Button>
    </div>
  );
}
