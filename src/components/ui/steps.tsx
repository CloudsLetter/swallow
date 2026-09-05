import { Check as IconCheck, X as IconX } from 'lucide-react';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';

export interface StepItem {
  id: string;
  label: string;
  status: 'pending' | 'loading' | 'success' | 'error';
  message?: string;
}

interface StepsProps {
  steps: StepItem[];
  /** 布局方向：horizontal=横向节点条（每完成一个点亮一个节点）；vertical=纵向列表 */
  orientation?: 'horizontal' | 'vertical';
  /** 是否显示节点下方/右侧的标签文本 */
  showLabels?: boolean;
  className?: string;
}

/** 步骤条（Stepper）：完成一个过程即点亮一个节点（shadcn 风格，基于语义色与 Spinner）。 */
export function Steps({ steps, orientation = 'horizontal', showLabels = true, className }: StepsProps) {
  const renderNode = (step: StepItem, index: number) => {
    const isDone = step.status === 'success';
    const isError = step.status === 'error';
    const isLoading = step.status === 'loading';
    return (
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
          isLoading && 'border-primary bg-primary/10 text-primary',
          isDone && 'border-success bg-success text-white',
          isError && 'border-destructive bg-destructive text-white',
          step.status === 'pending' && 'border-border bg-muted text-muted-foreground',
        )}
      >
        {isLoading ? (
          <Spinner className="size-3.5" />
        ) : isError ? (
          <IconX size={12} strokeWidth={3} />
        ) : isDone ? (
          <IconCheck size={12} strokeWidth={3} />
        ) : (
          <span className="text-[10px] font-medium">{index + 1}</span>
        )}
      </span>
    );
  };

  const labelClass = (step: StepItem) =>
    cn(
      'truncate text-[11px] leading-tight',
      step.status === 'loading' && 'text-primary',
      step.status === 'success' && 'text-foreground',
      step.status === 'error' && 'text-destructive',
      step.status === 'pending' && 'text-muted-foreground',
    );

  if (orientation === 'vertical') {
    return (
      <ol className={cn('flex flex-col', className)}>
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          return (
            <li key={step.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                {renderNode(step, index)}
                {!isLast && (
                  <span
                    className={cn(
                      'my-0.5 w-0.5 flex-1 rounded-full',
                      step.status === 'success' ? 'bg-success/60' : 'bg-border',
                    )}
                  />
                )}
              </div>
              <div className={cn('min-w-0 flex-1', !isLast && 'pb-4')}>
                <div className={labelClass(step)} title={step.label}>
                  {showLabels ? step.label : ''}
                </div>
                {step.message && (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={step.message}>
                    {step.message}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol className={cn('flex w-full items-start', className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return (
          <li key={step.id} className={cn('flex min-w-0 items-start', !isLast && 'flex-1')}>
            {/* 节点列：固定宽度，label 超长截断，避免溢出容器 */}
            <div className="flex w-16 shrink-0 flex-col items-center gap-1.5">
              {renderNode(step, index)}
              {showLabels && (
                <span className={cn('block w-full truncate text-center', labelClass(step))} title={step.label}>
                  {step.label}
                </span>
              )}
            </div>
            {/* 连接线：弹性伸缩吸收剩余空间 */}
            {!isLast && (
              <span
                className={cn(
                  'mx-1 mt-3 h-0.5 min-w-0 flex-1 -translate-y-px rounded-full',
                  step.status === 'success' ? 'bg-success/60' : 'bg-border',
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
