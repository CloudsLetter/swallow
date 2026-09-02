interface TerminalBackdropProps {
  /** 背景延伸至顶栏：渲染 fixed 全窗层（覆盖 Topbar 区域） */
  extendToTopbar: boolean;
  /** 终端纯色背景（图片场景为压暗底色） */
  solid: string;
  /** 背景图片 URL（已解析） */
  imageUrl: string | null;
  blur: number;
  opacity: number;
}

/**
 * 终端背景层：统一渲染「纯色底 + 可选背景图」。
 * 两种形态：
 * - 背景延伸至顶栏：fixed 全窗层（zIndex 0），顶栏透出同一背景，视觉一体；
 * - 普通：absolute 层外扩 (blur+12)px，由外层 overflow:hidden 裁掉 blur 晕边。
 * ⚠️ blur=0 时不设置 filter——`filter: blur(0px)` 也会强制 Chromium 走离屏合成路径，
 * 4K/2K 大图会被 WebView2 降采样再合成 → 全图模糊。
 */
export function TerminalBackdrop({ extendToTopbar, solid, imageUrl, blur, opacity }: TerminalBackdropProps) {
  const showImage = !!imageUrl && blur >= 0;

  const imageLayer = (position: 'fixed' | 'absolute', inset: number | string) =>
    showImage ? (
      <div
        aria-hidden
        style={{
          position,
          inset,
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
          opacity,
          pointerEvents: 'none',
        }}
      />
    ) : null;

  if (extendToTopbar) {
    return (
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, backgroundColor: solid, pointerEvents: 'none' }}>
        {imageLayer('absolute', 0)}
      </div>
    );
  }
  // 非延伸：只有带背景图时才需要独立层（纯色由终端容器自身背景承担）
  return imageLayer('absolute', -(blur || 0) - 12);
}
