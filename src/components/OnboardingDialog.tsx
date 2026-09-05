import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, ShieldCheck, Activity, ChevronRight, ArrowLeft, Terminal } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

type StepId = 0 | 1 | 2;

/**
 * 初次使用引导：3 步轻量引导（欢迎 → 能力 → 开始）。
 * 纯展示组件；是否弹出与完成标记由调用方（App）负责持久化。
 */
export function OnboardingDialog({
  open,
  onOpenChange,
  onFinish,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 完成 / 跳过：调用方负责把 config.application.onboarding_done 置 true */
  onFinish: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<StepId>(0);

  const close = () => {
    onFinish();
    onOpenChange(false);
  };

  const finish = () => {
    onFinish();
    onOpenChange(false);
  };

  const features = [
    { icon: Server, title: t('onboarding.featMultiProto'), desc: t('onboarding.featMultiProtoDesc') },
    { icon: ShieldCheck, title: t('onboarding.featSecurity'), desc: t('onboarding.featSecurityDesc') },
    { icon: Activity, title: t('onboarding.featMonitor'), desc: t('onboarding.featMonitorDesc') },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md border-border/60 px-6 py-7"
      >
        <DialogTitle className="sr-only">{t('onboarding.title')}</DialogTitle>

        {/* 步骤 1：欢迎 */}
        {step === 0 && (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Terminal size={30} strokeWidth={1.8} />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('onboarding.welcome')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('onboarding.welcomeDesc')}</p>
            </div>
            <ul className="w-full space-y-1.5 rounded-lg border border-border/60 bg-muted/40 p-3 text-left text-xs text-muted-foreground">
              <li>• {t('onboarding.welcomeItemSsh')}</li>
              <li>• {t('onboarding.welcomeItemSftp')}</li>
              <li>• {t('onboarding.welcomeItemLocal')}</li>
            </ul>
          </div>
        )}

        {/* 步骤 2：核心能力 */}
        {step === 1 && (
          <div className="flex flex-col gap-3 py-1">
            <div className="text-center">
              <h2 className="text-lg font-semibold">{t('onboarding.features')}</h2>
            </div>
            {features.map((f) => (
              <div
                key={f.title}
                className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-3"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <f.icon size={16} strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{f.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 步骤 3：开始使用 */}
        {step === 2 && (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-success/10 text-success">
              <ShieldCheck size={26} strokeWidth={1.8} />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('onboarding.ready')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t('onboarding.readyDesc')}
              </p>
            </div>
          </div>
        )}

        {/* 步骤指示点 */}
        <div className="flex items-center justify-center gap-1.5 pt-1">
          {([0, 1, 2] as const).map((i) => (
            <span
              key={i}
              className={cn(
                'h-1.5 rounded-full transition-all duration-200',
                i === step ? 'w-5 bg-primary' : 'w-1.5 bg-foreground/15',
              )}
            />
          ))}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={close}>
            {t('onboarding.skip')}
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep((s) => (s - 1) as StepId)}>
                <ArrowLeft size={14} />
                {t('onboarding.back')}
              </Button>
            )}
            {step < 2 ? (
              <Button size="sm" onClick={() => setStep((s) => (s + 1) as StepId)}>
                {t('onboarding.next')}
                <ChevronRight size={14} />
              </Button>
            ) : (
              <Button size="sm" onClick={finish}>
                {t('onboarding.getStarted')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
