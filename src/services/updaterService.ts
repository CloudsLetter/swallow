import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import i18n from '../i18n/i18n';

let checking = false;
let progressToastId: string | number | undefined;

/**
 * 检查并应用更新（tauri-plugin-updater + CrabNebula Cloud 分发）。
 *
 * - interactive = true（用户手动点击「检查更新」按钮）：
 *   无更新 → 绿色 toast 提示已是最新；有更新 → 原生确认框，同意后下载并重启。
 * - interactive = false（启动自动检查）：
 *   全程静默，发现新版本仅以 toast 轻提示；任何失败都不打扰。
 */
export async function checkForAppUpdates(options: { interactive?: boolean } = {}): Promise<void> {
  const { interactive = false } = options;
  if (checking) return;
  checking = true;

  let update: Awaited<ReturnType<typeof check>> = null;
  try {
    update = await check();
    if (!update) {
      if (interactive) toast.success(i18n.t('update.upToDate'));
      return;
    }
  } catch (e) {
    // 未配置 endpoint / 网络异常 / 非打包环境：自动检查静默，手动提示
    if (interactive) toast.error(i18n.t('update.checkFailed', { message: String(e) }));
    return;
  } finally {
    checking = false;
  }

  // 自动检查：不主动弹窗，仅提示用户可去设置页更新
  if (!interactive) {
    toast.info(i18n.t('update.availableToast', { version: update.version }), { duration: 6000 });
    return;
  }

  // 手动检查：确认后下载并安装
  const confirmed = await ask(i18n.t('update.confirmBody', { version: update.version }), {
    title: i18n.t('update.confirmTitle'),
    kind: 'info',
    okLabel: i18n.t('update.confirmOk'),
    cancelLabel: i18n.t('update.confirmCancel'),
  });
  if (!confirmed) return;

  try {
    progressToastId = toast.loading(i18n.t('update.downloading'), { id: progressToastId });
    await update.downloadAndInstall((event) => {
      if (event.event === 'Progress' && event.data.chunkLength) {
        toast.loading(i18n.t('update.downloadProgress', { mb: (event.data.chunkLength / 1048576).toFixed(1) }), {
          id: progressToastId,
        });
      }
    });
    toast.success(i18n.t('update.installDone'), { id: progressToastId });
    // Windows：downloadAndInstall 已交由 NSIS 安装器处理并退出，到不了这里；
    // macOS/Linux 需主动 relaunch 加载新版本
    await relaunch();
  } catch (e) {
    toast.error(i18n.t('update.downloadFailed', { message: String(e) }), { id: progressToastId });
  }
}
