import type { LucideIcon } from 'lucide-react';
import {
  Folder as IconFolder,
  Home as IconHome,
  LayoutGrid as IconLayoutGrid,
  Monitor as IconMonitor,
  Network as IconNetwork,
  PlayCircle as IconPlayCircle,
  Radio as IconRadio,
  ScreenShare as IconScreenShare,
  Terminal as IconTerminal,
  Usb as IconUsb,
  Zap as IconZap,
} from 'lucide-react';
import type { TabType } from '../store/tabStore';

/**
 * 内部扩展点：协议注册表。
 *
 * TabBar / 命令面板 / AI 工具 / Home 侧栏显隐之前各自手写一份
 *「类型 → 图标 / 是否终端类」的映射，加新协议要改 N 处。
 * 现在只改这里一处。注意这是内部注册表，不对外承诺 ABI。
 */
export interface ProtocolDefinition {
  id: TabType;
  icon: LucideIcon;
  /** 终端类会话：共用 TerminalView 渲染，可进 AI 工具/广播/会话列表 */
  terminalLike: boolean;
  /** 激活时显示左右面板（TerminalSidePanel / RightPanelBar） */
  sidePanel: boolean;
}

export const PROTOCOLS: Record<TabType, ProtocolDefinition> = {
  home: { id: 'home', icon: IconHome, terminalLike: false, sidePanel: false },
  terminal: { id: 'terminal', icon: IconTerminal, terminalLike: true, sidePanel: true },
  telnet: { id: 'telnet', icon: IconNetwork, terminalLike: true, sidePanel: false },
  local: { id: 'local', icon: IconZap, terminalLike: true, sidePanel: false },
  serial: { id: 'serial', icon: IconUsb, terminalLike: true, sidePanel: false },
  sftp: { id: 'sftp', icon: IconFolder, terminalLike: false, sidePanel: false },
  vnc: { id: 'vnc', icon: IconMonitor, terminalLike: false, sidePanel: false },
  rdp: { id: 'rdp', icon: IconScreenShare, terminalLike: false, sidePanel: false },
  mosh: { id: 'mosh', icon: IconRadio, terminalLike: true, sidePanel: true },
  replay: { id: 'replay', icon: IconPlayCircle, terminalLike: false, sidePanel: false },
  'quick-connect': { id: 'quick-connect', icon: IconZap, terminalLike: false, sidePanel: false },
  split: { id: 'split', icon: IconLayoutGrid, terminalLike: false, sidePanel: false },
};

export function getProtocol(type: TabType): ProtocolDefinition {
  return PROTOCOLS[type] ?? PROTOCOLS.terminal;
}

/** 终端类会话类型（AI 工具 / 广播 / 会话列表共用，替代各处手写数组）。 */
export function terminalLikeTypes(): TabType[] {
  return (Object.keys(PROTOCOLS) as TabType[]).filter((t) => PROTOCOLS[t].terminalLike);
}

/** 单个类型是否为终端类（替代 `['terminal','telnet',...].includes(tab.type)` 手写）。 */
export function isTerminalLike(type: TabType): boolean {
  return PROTOCOLS[type]?.terminalLike ?? false;
}

/** 该标签激活时是否显示左右面板。 */
export function hasSidePanel(type: TabType | undefined): boolean {
  return !!type && (PROTOCOLS[type]?.sidePanel ?? false);
}
