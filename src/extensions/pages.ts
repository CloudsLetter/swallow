import type { lazy } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity as IconActivity,
  ArrowLeftRight as IconForward,
  FileBadge as IconCert,
  FileText as IconFileText,
  Folder as IconFolder,
  Key as IconKey,
  Lock as IconLock,
  Monitor as IconDeviceDesktop,
  ScreenShare as IconScreenShare,
  Settings as IconSettings,
  Terminal as IconTerminal,
  User as IconUser,
} from 'lucide-react';

/**
 * 内部扩展点：管理页注册表。
 *
 * SideMenu（菜单）/ Home（lazy chunk + keep-alive）/ CommandPalette（跳转项）
 * 之前各手写一份页面清单，加管理页要改三处。现在只改这里一处。
 * 注意这是内部注册表，不对外承诺 ABI。
 */
export interface PageDefinition {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  /** Home 首屏是否预挂载（hosts 预挂载，其余首次访问才拉 chunk）。 */
  preload: boolean;
  /** Home 侧 keep-alive 挂载的 lazy 组件名（Home.tsx 里 import 用）。 */
  component: string;
}

export const PAGES: PageDefinition[] = [
  { id: 'hosts', labelKey: 'menu.hosts', icon: IconDeviceDesktop, preload: true, component: 'Hosts' },
  { id: 'remote', labelKey: 'menu.desktop', icon: IconScreenShare, preload: false, component: 'Remote' },
  { id: 'account', labelKey: 'menu.account', icon: IconUser, preload: false, component: 'Account' },
  { id: 'portforwarding', labelKey: 'menu.portForwarding', icon: IconForward, preload: false, component: 'PortForwarding' },
  { id: 'keys', labelKey: 'menu.keys', icon: IconKey, preload: false, component: 'Keys' },
  { id: 'certificates', labelKey: 'menu.certificates', icon: IconCert, preload: false, component: 'Certificates' },
  { id: 'knownhosts', labelKey: 'menu.knownHosts', icon: IconLock, preload: false, component: 'KnownHosts' },
  { id: 'sftp', labelKey: 'menu.sftp', icon: IconFolder, preload: false, component: 'Sftp' },
  { id: 'snippets', labelKey: 'menu.snippets', icon: IconTerminal, preload: false, component: 'Snippets' },
  { id: 'monitor', labelKey: 'menu.monitor', icon: IconActivity, preload: false, component: 'Monitor' },
  { id: 'logs', labelKey: 'menu.logs', icon: IconFileText, preload: false, component: 'Logs' },
  { id: 'settings', labelKey: 'menu.settings', icon: IconSettings, preload: false, component: 'Settings' },
];

export type LazyPage = ReturnType<typeof lazy>;

/** Home.tsx 侧的 lazy 组件表（chunk 切分点保留，加页时同步加一行 import）。 */
export function pageLoaders(): Record<string, () => Promise<{ default: React.ComponentType }>> {
  return {
    Hosts: () => import('../pages/Hosts').then((m) => ({ default: m.Hosts })),
    Account: () => import('../pages/Account').then((m) => ({ default: m.AccountPage })),
    Remote: () => import('../pages/Remote').then((m) => ({ default: m.Remote })),
    Keys: () => import('../pages/Keys').then((m) => ({ default: m.Keys })),
    Certificates: () => import('../pages/Certificates').then((m) => ({ default: m.Certificates })),
    KnownHosts: () => import('../pages/KnownHosts').then((m) => ({ default: m.KnownHosts })),
    PortForwarding: () => import('../pages/PortForwarding').then((m) => ({ default: m.PortForwarding })),
    Sftp: () => import('../pages/Sftp').then((m) => ({ default: m.Sftp })),
    Snippets: () => import('../pages/Snippets').then((m) => ({ default: m.Snippets })),
    Logs: () => import('../pages/Logs').then((m) => ({ default: m.Logs })),
    Monitor: () => import('../pages/Monitor').then((m) => ({ default: m.Monitor })),
    Settings: () => import('../pages/Settings').then((m) => ({ default: m.SettingsPage })),
  };
}

export function getPage(id: string): PageDefinition | undefined {
  return PAGES.find((p) => p.id === id);
}
