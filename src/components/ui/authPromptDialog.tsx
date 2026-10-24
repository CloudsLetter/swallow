//! Promise 化的 shadcn 提问框：给 SSH keyboard-interactive（验证码 / OTP / MFA）收集答案。
//!
//! 与 `confirmDialog` 同构（全局单例宿主 + Promise），区别是需要支持多条输入：
//! 服务器一次可能问多个 prompt，`echo === false` 的用密码框渲染。
//!
//! 注意这里只负责「收集」，不负责重连——重连由调用方（如 terminalConnect）在拿到
//! 答案后自行发起，与主机密钥确认同一条「中断 → 收集 → 重连」范式。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input } from './input';

export interface AuthPromptField {
  prompt: string;
  echo: boolean;
}

export interface AuthPromptRequest {
  /** 标题；缺省用「需要验证」 */
  title?: string;
  /** 服务器附带的说明文字（可能为空） */
  instructions?: string;
  prompts: AuthPromptField[];
}

interface PendingPrompt extends AuthPromptRequest {
  resolve: (answers: string[] | null) => void;
  settled: boolean;
}

/** 由宿主挂载时注入；未挂载时按「取消」兜底，避免调用方 await 永久挂起。 */
let openPrompt: ((pending: PendingPrompt) => void) | null = null;

/** 弹框收集答案；用户取消返回 null。 */
export function promptForAnswers(request: AuthPromptRequest): Promise<string[] | null> {
  return new Promise((resolve) => {
    if (!openPrompt) {
      console.warn('[promptForAnswers] AuthPromptHost 未挂载，已按「取消」处理');
      resolve(null);
      return;
    }
    openPrompt({ ...request, resolve, settled: false });
  });
}

/** 全局唯一宿主：挂在 App 根部，与 <Toaster /> / <ConfirmDialogHost /> 并列。 */
export function AuthPromptHost() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [values, setValues] = useState<string[]>([]);

  useEffect(() => {
    openPrompt = setPending;
    return () => {
      if (openPrompt === setPending) openPrompt = null;
    };
  }, []);

  // 每来一轮新请求就清空输入
  useEffect(() => {
    setValues(pending ? pending.prompts.map(() => '') : []);
  }, [pending]);

  const settle = (answers: string[] | null) => {
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resolve(answers);
    setPending(null);
  };

  const fields = pending?.prompts ?? [];

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-all">
            {pending?.title ?? t('connection.authPromptTitle')}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-all">
            {pending?.instructions || t('connection.authPromptBody')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            settle(values);
          }}
        >
          {fields.map((field, index) => (
            <label key={index} className="flex flex-col gap-1">
              <span className="min-w-0 break-all text-xs text-muted-foreground">{field.prompt}</span>
              <Input
                autoFocus={index === 0}
                type={field.echo ? 'text' : 'password'}
                value={values[index] ?? ''}
                onChange={(e) => {
                  const next = [...values];
                  next[index] = e.target.value;
                  setValues(next);
                }}
              />
            </label>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit">{t('connection.authPromptSubmit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
