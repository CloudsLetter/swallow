//! chmod 三栏勾选矩阵：所有者/组/其他 × 读/写/执行，实时回写八进制（如 755）。
//! 自 SftpView 拆出（仅 chmod 对话框使用）。

import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '../ui/checkbox';

export function ChmodMatrix({ value, onChange }: { value: string; onChange: (octal: string) => void }) {
  const { t } = useTranslation();
  // 8 进制 → [所有者 r,w,x, 组 r,w,x, 其他 r,w,x]
  const bits = useMemo(() => {
    const digits = value.replace(/[^0-7]/g, '').slice(-3).padStart(3, '0').split('').map(Number);
    const out: boolean[] = [];
    for (const d of digits) {
      out.push((d & 4) !== 0, (d & 2) !== 0, (d & 1) !== 0);
    }
    return out;
  }, [value]);

  const toggle = (idx: number) => {
    const next = [...bits];
    next[idx] = !next[idx];
    const digits = [0, 1, 2].map(
      (g) => (next[g * 3] ? 4 : 0) + (next[g * 3 + 1] ? 2 : 0) + (next[g * 3 + 2] ? 1 : 0),
    );
    onChange(digits.join(''));
  };

  const symbolic = (digit: number) => `${digit & 4 ? 'r' : '-'}${digit & 2 ? 'w' : '-'}${digit & 1 ? 'x' : '-'}`;
  const digits = value.replace(/[^0-7]/g, '').slice(-3).padStart(3, '0').split('').map(Number);
  const rows: { label: string; offset: number }[] = [
    { label: t('sftp.permRead'), offset: 0 },
    { label: t('sftp.permWrite'), offset: 1 },
    { label: t('sftp.permExecute'), offset: 2 },
  ];

  return (
    <div>
      <div className="grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-y-2 text-sm">
        <span />
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permOwner')}</span>
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permGroup')}</span>
        <span className="text-center font-medium text-muted-foreground">{t('sftp.permOther')}</span>
        {rows.map((row) => (
          <Fragment key={row.offset}>
            <span className="flex items-center gap-1.5">{row.label}</span>
            {[0, 3, 6].map((group) => (
              <span key={`${group}-${row.offset}`} className="flex justify-center">
                <Checkbox
                  checked={bits[group + row.offset]}
                  onCheckedChange={() => toggle(group + row.offset)}
                />
              </span>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 font-mono text-xs text-muted-foreground">
        <span>{t('sftp.chmod')}:</span>
        <span>{digits.join('')}</span>
        <span>{digits.map(symbolic).join('')}</span>
      </div>
    </div>
  );
}
