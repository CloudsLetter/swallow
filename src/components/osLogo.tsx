/**
 * 远端操作系统图标：连接服务器后由 osDetected 事件驱动（标签栏/主机列表/图标库共用）。
 *
 * 图标资源为 Simple Icons 开源品牌 SVG（src/assets/os-icons/*，自带品牌色），
 * 直接以 <img> 渲染保留彩色辨识度（黑色源已统一提亮为中灰，深浅背景均可读）。
 * 后端 normalize_os_id / Tab.osId / host.icon `os:` 前缀共用同一套 osId 契约；
 * 未知 osId 一律返回 null（调用方回退默认图标）。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { OS_ICON_URLS } from '../assets/os-icons/index';

interface OsLogoProps {
  osId?: string;
  size?: number;
  className?: string;
}

/** 是否为库内已知 osId（未知则不替换默认图标）。 */
export function hasOsLogo(osId?: string): boolean {
  return !!osId && !!OS_ICON_URLS[osId];
}

/** 内置图标库（osLogo 全集）：主机图标选择器/默认 osId 列表使用。 */
export const OS_PRESET_IDS: string[] = Object.keys(OS_ICON_URLS);

/** 本机（local 会话）平台判定：win→windows、mac→macos、其余→linux。 */
export function localPlatformOsId(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
  return 'linux';
}

/** OS 图标：品牌色 <img> 渲染，未知 osId 返回 null。 */
export function OsLogo({ osId, size = 14, className }: OsLogoProps) {
  if (!osId || !OS_ICON_URLS[osId]) return null;
  return (
    <img
      src={OS_ICON_URLS[osId]}
      alt=""
      draggable={false}
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

/**
 * 主机图标渲染（读取 host.icon 字段）：
 * - `os:<id>` → 内置 OS 品牌图标（OsLogo 单色）
 * - `data:image/...` → 自定义图片内容（base64 data URL，原样彩色显示）
 * - `file:<绝对路径>` → 本地图片文件（经 convertFileSrc 走 asset 协议）
 * - 其它/空 → null（调用方回退默认）
 */
export function HostIcon({
  icon,
  size = 16,
  className,
  rounded,
}: {
  icon?: string;
  size?: number;
  className?: string;
  rounded?: boolean;
}) {
  if (!icon) return null;
  if (icon.startsWith('os:')) {
    return <OsLogo osId={icon.slice(3)} size={size} className={className} />;
  }
  let src: string | null = null;
  if (icon.startsWith('data:image/')) {
    src = icon;
  } else if (icon.startsWith('file:')) {
    const path = icon.slice(5);
    if (path) src = convertFileSrc(path);
  }
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
        borderRadius: rounded ? '4px' : undefined,
      }}
    />
  );
}
