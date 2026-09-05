import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X as IconX, Check as IconCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card';
import { Spinner } from './ui/spinner';
import { Steps, type StepItem } from './ui/steps';
import { cn } from '@/lib/utils';

type ConnectionStep = StepItem;

interface ConnectionProgressProps {
  visible: boolean;
  steps: ConnectionStep[];
  onClose?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
}

/** 连接状态页（shadcn/ui）：标题 + 横向节点步骤条 + 底部紧凑日志框。 */
export function ConnectionProgress({ visible, steps, onClose, onRetry, onCancel }: ConnectionProgressProps) {
  // 步骤状态变化累积为日志（隐藏期间也持续记录，hooks 必须在提前 return 之前）
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => {
    if (!visible) return;
    steps.forEach((step) => {
      const entry =
        step.status === 'loading'
          ? `[INFO] ${step.label}...`
          : step.status === 'success'
            ? `[SUCCESS] ${step.label}${step.message ? `: ${step.message}` : ''}`
            : step.status === 'error'
              ? `[ERROR] ${step.label}${step.message ? `: ${step.message}` : ''}`
              : null;
      if (!entry) return;
      setLogs((prev) => (prev.includes(entry) ? prev : [...prev, entry]));
    });
  }, [steps, visible]);

  const { t } = useTranslation();

  if (!visible) return null;

  const hasError = steps.some((s) => s.status === 'error');
  const isComplete = steps.length > 0 && steps.every((s) => s.status === 'success');
  const isConnecting = steps.some((s) => s.status === 'loading');
  // 当前进行/出错的步骤说明（单行展示）
  const activeStep = steps.find((s) => s.status === 'loading' || s.status === 'error');

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Card className="w-[460px] max-w-[92vw] shadow-xl">
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            {isComplete ? (
              <IconCheck size={16} className="text-success" />
            ) : hasError ? (
              <IconX size={16} className="text-destructive" />
            ) : (
              <Spinner className="size-4 text-primary" />
            )}
            {isComplete ? t('connection.connected') : hasError ? t('connection.failed') : t('connection.connecting')}
          </CardTitle>
          <CardAction className="flex items-center gap-1">
            {isConnecting && onCancel && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            )}
            {isComplete && onClose && (
              <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('common.close')}>
                <IconX size={14} />
              </Button>
            )}
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-3.5 p-4">
          {/* 节点式步骤条：完成一个过程点亮一个节点 */}
          <Steps steps={steps} />

          {/* 当前进行/出错步骤的说明 */}
          {activeStep?.message && (
            <p
              className={cn(
                'truncate text-xs',
                activeStep.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
              title={activeStep.message}
            >
              {activeStep.message}
            </p>
          )}

          {/* 错误时的操作 */}
          {hasError && (onRetry || onClose) && (
            <div className="flex gap-2">
              {onRetry && (
                <Button onClick={onRetry} className="flex-1">
                  {t('common.retry')}
                </Button>
              )}
              {onClose && (
                <Button variant="secondary" onClick={onClose} className="flex-1">
                  {t('common.close')}
                </Button>
              )}
            </div>
          )}

          {/* 底部紧凑日志框 */}
          {logs.length > 0 && (
            <div className="rounded-md border border-border bg-muted/50 p-2">
              <div className="mb-1 text-[10px] font-medium text-muted-foreground">{t('connection.logs')}</div>
              <div className="flex max-h-20 flex-col gap-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {logs.map((log, index) => (
                  <div
                    key={index}
                    className={cn(
                      'break-all',
                      log.includes('[ERROR]') && 'text-destructive',
                      log.includes('[SUCCESS]') && 'text-success',
                      log.includes('[INFO]') && 'text-foreground',
                    )}
                  >
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
