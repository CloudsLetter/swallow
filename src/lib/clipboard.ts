import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useConfigStore } from '../store/config';

/** 进行中的剪贴板清除定时器（多处复制共用一个：最新一次复制的时间为准）。 */
let clearTimer: number | null = null;

/**
 * 复制文本到剪贴板。设置开启「自动清除剪贴板」（security.clear_clipboard_after，
 * 单位秒，0 = 关闭）时，到期后清空剪贴板——密码/主机指纹/密钥等敏感内容复制后
 * 不在剪贴板滞留。所有用户主动复制入口统一走本函数。
 */
export async function copyText(text: string): Promise<void> {
  await writeText(text);
  const secs = useConfigStore.getState().config?.security?.clear_clipboard_after ?? 0;
  if (secs <= 0) return;
  if (clearTimer !== null) window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    clearTimer = null;
    // 清空 = 写入空串（插件无独立 clear API；失败静默，不影响用户体验）
    void writeText('').catch(() => {});
  }, secs * 1000);
}
