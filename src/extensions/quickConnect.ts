import type { LucideIcon } from 'lucide-react';
import {
  Monitor as IconMonitor,
  Network as IconNetwork,
  Radio as IconRadio,
  ScreenShare as IconScreenShare,
  Usb as IconUsb,
} from 'lucide-react';
import { TelnetCard } from '../pages/quickConnect/TelnetCard';
import { VncCard } from '../pages/quickConnect/VncCard';
import { RdpCard } from '../pages/quickConnect/RdpCard';
import { MoshCard } from '../pages/quickConnect/MoshCard';
import { SerialCard } from '../pages/quickConnect/SerialCard';
import type { QuickConnectCardProps } from '../pages/quickConnect/types';

/**
 * 内部扩展点：快速连接协议磁贴注册表。
 *
 * 加新协议 = 新建卡片组件 + 此处注册一行（表单按需展开渲染）。
 * QuickConnect.tsx 只负责布局/展开/主机列表，不再手写磁贴清单。
 * 注意这是内部注册表，不对外承诺 ABI。
 */
export interface ProtocolTile {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  descKey: string;
  Component: React.ComponentType<QuickConnectCardProps>;
}

export const PROTOCOL_TILES: ProtocolTile[] = [
  { id: 'telnet', icon: IconNetwork, titleKey: 'quickConnect.telnetTitle', descKey: 'quickConnect.telnetDesc', Component: TelnetCard },
  { id: 'vnc', icon: IconMonitor, titleKey: 'quickConnect.vncTitle', descKey: 'quickConnect.vncDesc', Component: VncCard },
  { id: 'rdp', icon: IconScreenShare, titleKey: 'quickConnect.rdpTitle', descKey: 'quickConnect.rdpDesc', Component: RdpCard },
  { id: 'mosh', icon: IconRadio, titleKey: 'quickConnect.moshTitle', descKey: 'quickConnect.moshDesc', Component: MoshCard },
  { id: 'serial', icon: IconUsb, titleKey: 'quickConnect.serialTitle', descKey: 'quickConnect.serialDesc', Component: SerialCard },
];

export function getProtocolTile(id: string): ProtocolTile | undefined {
  return PROTOCOL_TILES.find((t) => t.id === id);
}
