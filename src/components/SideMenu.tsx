import { useState } from 'react';
import {
  Monitor as IconDeviceDesktop,
  Key as IconKey,
  Folder as IconFolder,
  FileText as IconFileText,
  Settings as IconSettings,
  ChevronLeft as IconChevronLeft,
  ArrowLeftRight as IconForward,
  User as IconUser,
  Terminal as IconTerminal,
  Lock as IconLock,
  FileBadge as IconCert,
  Activity as IconActivity,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '@/lib/utils';

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface SideMenuProps {
  onItemClick?: (itemId: string) => void;
  activePage?: string;
}

export function SideMenu({ onItemClick, activePage }: SideMenuProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useTranslation();

  const menuItems: MenuItem[] = [
    { id: 'hosts', label: t('menu.hosts'), icon: <IconDeviceDesktop size={16} strokeWidth={2} /> },
    { id: 'account', label: t('menu.account'), icon: <IconUser size={16} strokeWidth={2} /> },
    { id: 'portforwarding', label: t('menu.portForwarding'), icon: <IconForward size={16} strokeWidth={2} /> },
    { id: 'keys', label: t('menu.keys'), icon: <IconKey size={16} strokeWidth={2} /> },
    { id: 'certificates', label: t('menu.certificates'), icon: <IconCert size={16} strokeWidth={2} /> },
    { id: 'knownhosts', label: t('menu.knownHosts'), icon: <IconLock size={16} strokeWidth={2} /> },
    { id: 'sftp', label: t('menu.sftp'), icon: <IconFolder size={16} strokeWidth={2} /> },
    { id: 'snippets', label: t('menu.snippets'), icon: <IconTerminal size={16} strokeWidth={2} /> },
    { id: 'monitor', label: t('menu.monitor'), icon: <IconActivity size={16} strokeWidth={2} /> },
    { id: 'logs', label: t('menu.logs'), icon: <IconFileText size={16} strokeWidth={2} /> },
    { id: 'settings', label: t('menu.settings'), icon: <IconSettings size={16} strokeWidth={2} /> },
  ];

  // 折叠/展开按钮：展开态为全宽（图标+文字）靠左，折叠态为居中图标
  const toggleButton = (
    <Button
      variant="ghost"
      className={cn(
        'flex h-11 w-full items-center gap-2 py-0! text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        collapsed ? 'justify-center gap-0 rounded-none! px-0' : 'justify-start rounded-md px-3',
      )}
      onClick={() => setCollapsed(!collapsed)}
      aria-label={collapsed ? t('menu.expandSidebar') : t('menu.collapseSidebar')}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <IconChevronLeft
          size={16}
          strokeWidth={2}
          className={cn('transition-transform duration-200', collapsed && 'rotate-180')}
        />
      </span>
      <span
        className={cn(
          'truncate text-xs font-medium transition-[opacity,max-width] duration-200',
          collapsed ? 'max-w-0 opacity-0' : 'max-w-[120px] opacity-100',
        )}
      >
        {t('menu.collapseSidebar')}
      </span>
    </Button>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <SidebarProvider
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
        className="h-full min-h-0 w-auto shrink-0"
      >
        <div
          className="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
          style={{
            width: collapsed ? 'var(--menu-width-collapsed)' : 'var(--menu-width)',
            transition: 'width 0.2s ease',
            overflow: 'hidden',
          }}
        >
          {/* 顶部工具条：折叠/展开按钮（紧凑，不放品牌） */}
          <div
            className={cn(
              'flex h-11 shrink-0 items-center border-b border-sidebar-border',
              collapsed ? 'justify-center px-0' : 'px-1',
            )}
          >
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>{toggleButton}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={10}>
                  {t('menu.expandSidebar')}
                </TooltipContent>
              </Tooltip>
            ) : (
              toggleButton
            )}
          </div>

          {/* 菜单 */}
          <SidebarContent className="flex-1 overflow-y-auto">
            <SidebarGroup className={collapsed ? 'p-0' : 'p-1'}>
              <SidebarMenu>
                {menuItems.map((item) => {
                  const isActive = activePage === item.id;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={isActive}
                        tooltip={
                          collapsed
                            ? { children: item.label, sideOffset: 10 }
                            : undefined
                        }
                        onClick={() => onItemClick?.(item.id)}
                        className={cn(
                          'h-11 text-sidebar-foreground transition-colors',
                          collapsed
                            ? 'justify-center gap-0 rounded-none! p-0!'
                            : 'justify-start gap-3 rounded-md py-0! px-3',
                        )}
                      >
                        {/* 统一图标容器尺寸，折叠/展开状态视觉一致 */}
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center',
                            isActive && 'text-primary',
                          )}
                        >
                          {item.icon}
                        </span>
                        <span
                          className={cn(
                            'truncate text-sm font-medium transition-[opacity,max-width] duration-200',
                            collapsed ? 'max-w-0 opacity-0' : 'max-w-[180px] opacity-100',
                          )}
                        >
                          {item.label}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
