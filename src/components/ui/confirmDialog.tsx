//! Promise 化的 shadcn 确认框：替代 @tauri-apps/plugin-dialog 的系统 ask()。
//!
//! 调用形态刻意与系统版一致 —— `ask(message, options)` → `confirmDialog(message, options)`，
//! 调用方无需改动内部逻辑，也保留 `await` 语义（返回 Promise<boolean>）。
//!
//! 挂载要求：必须有且仅有一处 `<ConfirmDialogHost />`（App 根部）。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

export interface ConfirmDialogOptions {
  /** 标题；缺省用「确认」（AlertDialog 必须有 Title，属无障碍要求） */
  title?: string;
  /** warning/error 视为破坏性操作 → 确认按钮标红，与删除类语义一致 */
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}

interface PendingConfirm {
  message: string;
  options: ConfirmDialogOptions;
  resolve: (ok: boolean) => void;
  /** 幂等守卫：确认按钮触发的 onClick 与随后的 onOpenChange(false) 只会有一次生效 */
  settled: boolean;
}

/** 由 Host 挂载时注入；未挂载时 confirmDialog 按「取消」兜底，避免调用方 await 永久挂起。 */
let openConfirm: ((pending: PendingConfirm) => void) | null = null;

export function confirmDialog(message: string, options: ConfirmDialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!openConfirm) {
      console.warn('[confirmDialog] ConfirmDialogHost 未挂载，已按「取消」处理：', message);
      resolve(false);
      return;
    }
    openConfirm({ message, options, resolve, settled: false });
  });
}

/** 全局唯一宿主：挂在 App 根部，与 <Toaster /> 并列。 */
export function ConfirmDialogHost() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    openConfirm = setPending;
    return () => {
      if (openConfirm === setPending) openConfirm = null;
    };
  }, []);

  const settle = (ok: boolean) => {
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resolve(ok);
    setPending(null);
  };

  const destructive = pending?.options.kind === 'warning' || pending?.options.kind === 'error';

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        // Esc / 外部关闭都落到这条；确认与取消按钮已在各自 onClick 里先结算
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          {/* 长且不可分的串（主机密钥指纹、URL、路径）会让文本顶出卡片：
              AlertDialogContent/Header 都是 CSS Grid，grid item 默认 min-width:auto，
              min-content 会被无空格长串撑大。这里必须同时给两条 ——
              min-w-0 取消自动最小尺寸；break-all 让长串参与 min-content 计算并可就地折行
              （注意 break-words = overflow-wrap:break-word **不参与** intrinsic sizing，救不了 Grid）。 */}
          <AlertDialogTitle className="min-w-0 break-all">
            {pending?.options.title ?? t('common.confirm')}
          </AlertDialogTitle>
          <AlertDialogDescription className="min-w-0 break-all">{pending?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {pending?.options.cancelLabel ?? t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={() => settle(true)}>
            {pending?.options.okLabel ?? t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
