import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { message } from '@tauri-apps/plugin-dialog';
import type { QuickConnectCardProps } from './types';

/** Telnet 快速连接（无认证，明文协议）。 */
export function TelnetCard({ onOpenSession }: Pick<QuickConnectCardProps, 'onOpenSession'>) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(23);

  const handleConnect = async () => {
    const trimmed = host.trim();
    if (!trimmed) {
      await message(t('quickConnect.telnetHostRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    onOpenSession(`telnet:${trimmed}`, 'telnet', { telnetConfig: { host: trimmed, port } });
  };

  return (
    <div className="flex items-center gap-3">
      <Input
        type="text"
        placeholder={t('quickConnect.telnetHost')}
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
        onChange={(e) => setPort(Number(e.target.value) || 23)}
        className="h-8 w-20 shrink-0"
      />
      <Button size="sm" className="h-8 shrink-0" onClick={() => void handleConnect()}>
        {t('quickConnect.telnetConnect')}
      </Button>
    </div>
  );
}
