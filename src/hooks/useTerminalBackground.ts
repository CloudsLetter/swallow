import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Config } from '../types/config';

/** 把配置里的背景图片字段解析为可直接渲染的 URL（http/data 直用，本地路径转 data URL）。 */
async function resolveBackgroundImageUrl(path: string): Promise<string | null> {
  if (!path) return null;
  if (/^(https?:\/\/|data:)/i.test(path)) return path;
  try {
    return await invoke<string>('read_image_as_data_url', { path });
  } catch (e) {
    console.warn('Failed to read background image:', e);
    return null;
  }
}

/** 按背景色亮度挑选顶栏延伸前景：深背景→白字系，浅背景→深字系（保证任意终端背景下标签可读）。 */
function topbarExtendFg(background: string): { fg: string; fgDim: string; hoverBg: string } | null {
  const full = /^#?([0-9a-f]{6})$/i.exec(background.trim());
  const short = full ? null : /^#?([0-9a-f]{3})$/i.exec(background.trim());
  let r: number;
  let g: number;
  let b: number;
  if (full) {
    r = parseInt(full[1].slice(0, 2), 16);
    g = parseInt(full[1].slice(2, 4), 16);
    b = parseInt(full[1].slice(4, 6), 16);
  } else if (short) {
    r = parseInt(short[1][0] + short[1][0], 16);
    g = parseInt(short[1][1] + short[1][1], 16);
    b = parseInt(short[1][2] + short[1][2], 16);
  } else {
    return null;
  }
  const dark = 0.299 * r + 0.587 * g + 0.114 * b < 150;
  return dark
    ? { fg: 'rgba(255,255,255,0.95)', fgDim: 'rgba(255,255,255,0.55)', hoverBg: 'rgba(255,255,255,0.14)' }
    : { fg: 'rgba(15,23,42,0.92)', fgDim: 'rgba(15,23,42,0.55)', hoverBg: 'rgba(15,23,42,0.1)' };
}

/**
 * 终端外观派生（背景色/背景图/透明/顶栏延伸）+ 背景图 URL 解析 + 顶栏延伸对比前景注入。
 * 把原 TerminalView 内的派生计算、两个副作用（resolve url / set --topbar-ext-*）集中于此。
 */
export function useTerminalBackground(config?: Config | null, isActive = true) {
  const terminalTheme = config?.terminal?.themes?.find(
    (theme) => theme.id === config.terminal?.active_theme_id,
  );
  // 终端纯色背景（无背景图、非透明时兜底 xterm 下层底色）
  const terminalSolidBackground = terminalTheme?.colors?.background || 'var(--color-panel-bg)';
  const backgroundImagePath = config?.terminal?.background_image || '';
  const hasBackgroundImage = !!backgroundImagePath;
  // 启用透明背景且透明度 < 1：外层容器不设实色背景，让半透明终端透出应用背景
  const transparentEnabled =
    !!config?.terminal?.allow_transparent_background &&
    (config?.terminal?.background_opacity ?? 1) < 1;
  // 背景图片场景下外层铺实色主题背景，作为图片下方的压暗底色
  const terminalBackground = hasBackgroundImage
    ? terminalSolidBackground
    : transparentEnabled
      ? 'transparent'
      : terminalSolidBackground;
  // 终端背景延伸至顶部标签栏：背景层改为 fixed 全窗（含 Topbar 区域），容器自身透明
  const extendToTopbar = !!config?.terminal?.extend_background_to_topbar;

  // 背景图片路径 → 可渲染 URL（本地经后端转 data URL）
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!backgroundImagePath) {
      setBackgroundImageUrl(null);
      return;
    }
    resolveBackgroundImageUrl(backgroundImagePath).then((url) => {
      if (!cancelled) setBackgroundImageUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [backgroundImagePath]);

  // 延伸激活时，把按终端背景亮度挑选的前景变量注入全局（标签栏/窗口控件读取，见 index.css .topbar-extend）。
  // 仅当前激活标签的实例写入；不做 removeProperty（多个 keep-alive 实例共享变量，清理会造成竞态，
  // 且 .topbar-extend 作用域不存在时变量无消费者，残留无害）
  useEffect(() => {
    if (!extendToTopbar || !isActive) return;
    const palette = topbarExtendFg(terminalSolidBackground);
    if (!palette) return;
    const root = document.documentElement;
    root.style.setProperty('--topbar-ext-fg', palette.fg);
    root.style.setProperty('--topbar-ext-fg-dim', palette.fgDim);
    root.style.setProperty('--topbar-ext-hover-bg', palette.hoverBg);
  }, [extendToTopbar, isActive, terminalSolidBackground]);

  return {
    terminalSolidBackground,
    terminalBackground,
    hasBackgroundImage,
    backgroundImageUrl,
    extendToTopbar,
    transparentEnabled,
  };
}
