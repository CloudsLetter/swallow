import { useTranslation } from 'react-i18next';
import { Download as IconDownload, Upload as IconUpload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';

import { Button } from './ui/button';
import { exportCategoryTo, importCategoryText, type ExportCategory } from '../services/dataService';

interface CategoryTransferProps {
  /** 导出类目（与后端信封的 category 一致） */
  category: ExportCategory;
  /** 类目显示名，用于对话框标题与文件名，如「主机」 */
  label: string;
  /** 导出文件的默认文件名 */
  defaultFileName: string;
  /**
   * 该类目是否含秘密字段（密码 / 私钥口令）。
   * 为 true 时，导出前会询问「是否包含凭据」——**默认不含**，
   * 这样导出文件可以直接分享或进版本库。
   */
  hasSecrets?: boolean;
  /** 导入完成后回调，通常传各页面的重新加载函数 */
  onImported: () => void | Promise<void>;
  /**
   * 外观：`icon` 用于列表页工具栏（默认），`button` 用于设置页这类带文字的场合。
   */
  appearance?: 'icon' | 'button';
}

/**
 * 分类导入导出按钮组。
 *
 * 每个列表页共用一个组件：导出走「选路径 → 是否含凭据」两步，
 * 导入走「选文件 → 判断类别 → 追加写入」，类别不匹配会在后端被拦下。
 */
export function CategoryTransferButtons({
  category,
  label,
  defaultFileName,
  hasSecrets = false,
  onImported,
  appearance = 'icon',
}: CategoryTransferProps) {
  const { t } = useTranslation();

  const handleExport = async () => {
    try {
      const target = await save({
        title: t('importExport.exportTitleWith', { label }),
        defaultPath: defaultFileName,
      });
      if (!target) return;

      let includeSecrets = false;
      if (hasSecrets) {
        includeSecrets = await ask(t('importExport.secretsDetail'), {
          title: t('importExport.secretsQuestion'),
          kind: 'warning',
          okLabel: t('importExport.includeSecrets'),
          cancelLabel: t('importExport.excludeSecrets'),
        });
      }
      const count = await exportCategoryTo(category, target, includeSecrets);
      toast.success(t('importExport.exportDone', { count }));
    } catch (e) {
      console.error(`Failed to export ${category}:`, e);
      toast.error(t('importExport.exportFailed', { message: String(e) }));
    }
  };

  const handleImport = async () => {
    try {
      const selected = await open({ multiple: false, directory: false });
      const path = typeof selected === 'string' ? selected : null;
      if (!path) return;
      const text = await invoke<string>('read_text_file_for_import', { path });
      const count = await importCategoryText(category, text);
      toast.success(t('importExport.importDone', { count }));
      await onImported();
    } catch (e) {
      console.error(`Failed to import ${category}:`, e);
      toast.error(t('importExport.importFailed', { message: String(e) }));
    }
  };

  if (appearance === 'button') {
    return (
      <>
        <Button
          variant="secondary"
          onClick={() => void handleImport()}
          title={t('importExport.importTitle')}
        >
          <IconUpload size={16} aria-hidden="true" />
          {t('importExport.importTitle')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleExport()}
          title={t('importExport.exportTitle')}
        >
          <IconDownload size={16} aria-hidden="true" />
          {t('importExport.exportTitle')}
        </Button>
      </>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void handleExport()}
        aria-label={t('importExport.exportTitle')}
        title={t('importExport.exportTitle')}
      >
        <IconDownload size={15} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void handleImport()}
        aria-label={t('importExport.importTitle')}
        title={t('importExport.importTitle')}
      >
        <IconUpload size={15} aria-hidden="true" />
      </Button>
    </>
  );
}
