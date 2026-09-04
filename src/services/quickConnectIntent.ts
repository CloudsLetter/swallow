/**
 * QuickConnect 页的「初始意图」通道：Hosts 等页面点「串口终端」快捷入口时，
 * 打开 quick-connect 标签并让该页滚动/高亮到对应协议卡片。
 *
 * 刻意不用全局状态库：意图是一次性信号，消费即清，避免跨页面常驻污染。
 */

export type QuickConnectIntent = 'serial';

let intent: QuickConnectIntent | null = null;

/** 设置一次性的初始意图（Hosts 页快捷入口调用）。 */
export function setQuickConnectIntent(v: QuickConnectIntent) {
  intent = v;
}

/** QuickConnect 挂载时消费：取走并清空。返回 null 表示无意图。 */
export function consumeQuickConnectIntent(): QuickConnectIntent | null {
  const v = intent;
  intent = null;
  return v;
}
