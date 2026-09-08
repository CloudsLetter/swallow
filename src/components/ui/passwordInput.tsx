import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';

interface PasswordInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  id?: string;
  /** 追加到输入框的 class（默认已预留右侧眼睛位 pr-9） */
  className?: string;
}

/** 密码输入（shadcn Password input recipe）：Input + 眼睛显隐切换。
 *  编辑已存凭据时值默认为明文载入但被 type=password 遮盖，点眼睛可查看明文。
 *  主机/账号/跳板/SFTP/VNC/RDP/私钥口令等密码位共用。 */
export function PasswordInput({
  value,
  onChange,
  placeholder,
  onKeyDown,
  id,
  className,
}: PasswordInputProps) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const label = t(show ? 'common.hidePassword' : 'common.showPassword');
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        aria-label={label}
        className={cn('pr-9', className)}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        title={label}
        aria-label={label}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}
