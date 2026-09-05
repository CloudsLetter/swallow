import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw as IconRefresh,
  ChevronDown as IconChevronDown,
  ChevronUp as IconChevronUp,
} from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { serialListPorts } from '../../services/sessionService';
import { message } from '@tauri-apps/plugin-dialog';
import { cn } from '@/lib/utils';
import type { QuickConnectCardProps } from './types';

/** 串口快速连接（无认证；参数默认 8N1 无流控，高级区可调；端口列表按需扫描）。 */
export function SerialCard({ onOpenSession, highlight }: QuickConnectCardProps) {
  const { t } = useTranslation();
  const [port, setPort] = useState('');
  const [ports, setPorts] = useState<string[]>([]);
  const [baud, setBaud] = useState('115200');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dataBits, setDataBits] = useState('8');
  const [stopBits, setStopBits] = useState('1');
  const [parity, setParity] = useState<'none' | 'odd' | 'even'>('none');
  const [flow, setFlow] = useState<'none' | 'hardware'>('none');

  // 展开时才枚举本机串口（按需扫描，不再常驻页面时提前跑）
  useEffect(() => {
    void serialListPorts()
      .then((list) => setPorts(list))
      .catch((e) => {
        console.warn('Failed to list serial ports:', e);
        setPorts([]);
      });
  }, []);

  const handleConnect = () => {
    const trimmed = port.trim();
    if (!trimmed) {
      void message(t('quickConnect.serialPortRequired'), { title: t('common.tip'), kind: 'warning' });
      return;
    }
    onOpenSession(`serial:${trimmed}`, 'serial', {
      serialConfig: {
        port: trimmed,
        baudRate: Number(baud) || 115200,
        dataBits: Number(dataBits) as 5 | 6 | 7 | 8,
        stopBits: Number(stopBits) as 1 | 2,
        parity,
        flowControl: flow,
      },
    });
  };

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-all duration-300',
        highlight ? 'border-primary ring-2 ring-primary/40' : 'border-border/60',
      )}
    >
      <div className="flex items-center gap-3">
        <Input
          type="text"
          placeholder={t('quickConnect.serialPort')}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConnect();
          }}
          className="h-8 w-40 shrink-0"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          title={t('quickConnect.serialRefresh')}
          onClick={() => {
            void serialListPorts()
              .then((list) => setPorts(list))
              .catch(() => setPorts([]));
          }}
        >
          <IconRefresh size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {t('quickConnect.serialAdvanced')}
          {showAdvanced ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
        </Button>
        <Button size="sm" className="ml-auto h-8 shrink-0" onClick={handleConnect}>
          {t('quickConnect.serialConnect')}
        </Button>
      </div>

      {/* 检测到的端口快捷选择 */}
      {ports.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t('quickConnect.serialDetected')}</span>
          {ports.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPort(p)}
              className={
                'h-6 rounded-md border px-2 font-mono text-xs transition-colors ' +
                (port === p
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent')
              }
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* 高级参数（折叠）：波特率/数据位/停止位/校验/流控 */}
      {showAdvanced && (
        <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialBaud')}</p>
            <Select value={baud} onValueChange={setBaud}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialDataBits')}</p>
            <Select value={dataBits} onValueChange={setDataBits}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['5', '6', '7', '8'].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialStopBits')}</p>
            <Select value={stopBits} onValueChange={setStopBits}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['1', '2'].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialParity')}</p>
            <Select value={parity} onValueChange={(v) => setParity(v as 'none' | 'odd' | 'even')}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['none', 'odd', 'even'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`quickConnect.parity.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('quickConnect.serialFlow')}</p>
            <Select value={flow} onValueChange={(v) => setFlow(v as 'none' | 'hardware')}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['none', 'hardware'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`quickConnect.flow.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
