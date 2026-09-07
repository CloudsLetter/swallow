import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useTabStore } from '../store/tabStore';

/**
 * 会话通知桥：消费 terminalPool 派发的全局「会话意外断开」事件，
 * 决定是否弹应用内通知。
 *
 * 判定：断开发生在**非当前激活标签**的会话上才通知（激活标签断线用户
 * 正在看终端、已有画面反馈）；同一会话 30s 冷却防重连抖动刷屏。
 */
const COOLDOWN_MS = 30_000;

export function SessionNotifications() {
  const { t } = useTranslation();

  useEffect(() => {
    const lastToast = new Map<string, number>();

    const onDisconnected = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail?.sessionId) return;
      const { sessionId } = detail;

      // 冷却：同一会话短时间内重复断开不反复弹
      const now = Date.now();
      const last = lastToast.get(sessionId) ?? 0;
      if (now - last < COOLDOWN_MS) return;
      lastToast.set(sessionId, now);

      const { tabs, activeTabId, focusTab } = useTabStore.getState();
      const tab = tabs.find((t) => t.sessionId === sessionId);
      // 找不到标签（已关闭）或断开的正是当前激活会话 → 静默
      if (!tab || tab.id === activeTabId || tab.type === 'home') return;

      toast.warning(t('notify.sessionDisconnected', { name: tab.name }), {
        duration: 8000,
        action: {
          label: t('notify.view'),
          onClick: () => focusTab(tab.id),
        },
      });
    };

    window.addEventListener('swallow:session-disconnected', onDisconnected);
    return () => window.removeEventListener('swallow:session-disconnected', onDisconnected);
  }, [t]);

  return null;
}
