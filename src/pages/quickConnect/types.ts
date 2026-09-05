import type { Account, Certificate, Host, Key } from '../../services/dataService';

/** QuickConnect 可发起的会话标签类型。 */
export type QuickConnectSessionType =
  | 'terminal'
  | 'telnet'
  | 'local'
  | 'vnc'
  | 'rdp'
  | 'mosh'
  | 'serial';

/** 打开会话标签（由页面注入：创建标签并关闭当前 QuickConnect 标签）。 */
export type OpenSessionFn = (
  name: string,
  type: QuickConnectSessionType,
  config: Record<string, unknown>,
) => void;

/** 协议卡片统一 props：主页把数据/回调一次性下发，卡片各自取用。 */
export interface QuickConnectCardProps {
  onOpenSession: OpenSessionFn;
  /** 主机/账号/凭据数据（VNC 跳板、协议入口复用主机认证时使用） */
  hosts: Host[];
  accounts: Account[];
  keys: Key[];
  certs: Certificate[];
  /** 外部定位高亮（Hosts 页「串口终端」快捷入口 → 串口卡片） */
  highlight?: boolean;
}
