import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rdpConnect, rdpDisconnect } from '../services/sessionService';
import type { RdpTabConfig } from '../store/tabStore';
import { useVncKeyboard } from '../store/vncKeyboard';
import { useConfigStore } from '../store/config';
import { useTerminalBackground } from '../hooks/useTerminalBackground';
import { TerminalBackdrop } from './TerminalBackdrop';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '@/lib/utils';

type RdpStatus = 'idle' | 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error';

interface RdpViewProps {
  sessionId?: string;
  rdpConfig?: RdpTabConfig;
  /** 恢复的会话缺少密码：跳过自动连接，等待用户输入密码后连接 */
  skipAutoConnect?: boolean;
}

/** 帧消息头（小端）：[RDF][1][1] width u16, height u16, tile u8, count u32 */
const FRAME_HEADER_LEN = 14;

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8Array;
}

/** 解析后端瓦片帧；协议不符返回 null。 */
function parseFrame(buf: ArrayBuffer): { width: number; height: number; tiles: Tile[] } | null {
  if (buf.byteLength < FRAME_HEADER_LEN) return null;
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x52 || bytes[1] !== 0x44 || bytes[2] !== 0x46 || bytes[3] !== 1 || bytes[4] !== 1) {
    return null;
  }
  const dv = new DataView(buf);
  const width = dv.getUint16(5, true);
  const height = dv.getUint16(7, true);
  const count = dv.getUint32(10, true);
  const tiles: Tile[] = [];
  let off = FRAME_HEADER_LEN;
  for (let i = 0; i < count; i++) {
    if (off + 8 > buf.byteLength) return null;
    const x = dv.getUint16(off, true);
    const y = dv.getUint16(off + 2, true);
    const w = dv.getUint16(off + 4, true);
    const h = dv.getUint16(off + 6, true);
    off += 8;
    const len = w * h * 4;
    if (off + len > buf.byteLength) return null;
    tiles.push({ x, y, w, h, data: new Uint8Array(buf, off, len) });
    off += len;
  }
  return { width, height, tiles };
}

export function RdpView({ sessionId, rdpConfig, skipAutoConnect }: RdpViewProps) {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const { terminalBackground, backgroundImageUrl } = useTerminalBackground(config, true);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 隐形输入框：承接键盘焦点与 IME 组合（canvas 上直接收键盘无法触发输入法）
  const keyInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgDataRef = useRef<ImageData | null>(null);
  const remoteSizeRef = useRef<{ width: number; height: number } | null>(null);
  const viewOnlyRef = useRef(false);
  const composingRef = useRef(false);
  const patchRafRef = useRef(0);
  // 鼠标移动合并：pointermove 事件频率远高于需要，rAF 内只发最新位置
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveRafRef = useRef(0);

  /**
   * 连接代际：与 VncView 同语义。每次 startConnect 占位、卸载/断开作废旧代；
   * 所有 await 之后与 WS 事件回调一律校验 gen === genRef.current，杜绝
   * StrictMode 双挂载 / 快速重连下旧连接事件把新会话界面打成已断开。
   */
  const genRef = useRef(0);
  // 连接配置在连接开始时固定；rdpConfig 对象身份变化不触发自动重连
  const configRef = useRef<RdpTabConfig | undefined>(rdpConfig);
  configRef.current = rdpConfig;
  // 密码在连接时确定（初始来自配置，恢复会话由用户补交）
  const passwordRef = useRef<string | undefined>(rdpConfig?.password);

  const [status, setStatus] = useState<RdpStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fitView, setFitView] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [needPassword, setNeedPassword] = useState(!rdpConfig?.password);
  const [passwordInput, setPasswordInput] = useState('');

  const teardownSocket = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
    }
  }, []);

  /** 发送输入操作（viewOnly 或未连接时静默丢弃）。 */
  const sendInput = useCallback((op: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || viewOnlyRef.current) return;
    ws.send(JSON.stringify({ type: 'input', op }));
  }, []);

  /** 请求服务器调整桌面分辨率（可能触发后端自动重连，均由 IronRDP 处理）。 */
  const sendResize = useCallback((width: number, height: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || viewOnlyRef.current) return;
    const w = Math.min(3840, Math.max(320, Math.floor(width)));
    const h = Math.min(2160, Math.max(240, Math.floor(height)));
    ws.send(JSON.stringify({ type: 'resize', width: w, height: h }));
  }, []);

  /** 把最新帧原子刷到画布（rAF 合帧：一次消息流只 put 一次）。
   *  整帧 put 而非脏矩形局部 put——局部画会随远端拆分出现可见的块状渐进刷新
   *  （官方 viewer 即为每次 redraw 整窗 blit 的原子呈现模型），整帧 8MB put
   *  在 1080p 下 ~3ms，与官方等价。 */
  const scheduleFlush = useCallback(() => {
    if (patchRafRef.current) return;
    patchRafRef.current = requestAnimationFrame(() => {
      patchRafRef.current = 0;
      const canvas = canvasRef.current;
      const imgData = imgDataRef.current;
      if (!canvas || !imgData) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(imgData, 0, 0);
    });
  }, []);

  /** 应用一帧瓦片：先确保画布/ImageData 与远端分辨率一致，再逐行贴片。 */
  const applyFrame = useCallback(
    (frame: { width: number; height: number; tiles: Tile[] }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const resized =
        canvas.width !== frame.width ||
        canvas.height !== frame.height ||
        !imgDataRef.current ||
        remoteSizeRef.current?.width !== frame.width ||
        remoteSizeRef.current?.height !== frame.height;
      if (resized) {
        canvas.width = frame.width;
        canvas.height = frame.height;
        imgDataRef.current = new ImageData(frame.width, frame.height);
        remoteSizeRef.current = { width: frame.width, height: frame.height };
      }
      const imgData = imgDataRef.current;
      if (!imgData) return;
      const w = frame.width;
      for (const tile of frame.tiles) {
        for (let r = 0; r < tile.h; r++) {
          const src = r * tile.w * 4;
          const dst = ((tile.y + r) * w + tile.x) * 4;
          imgData.data.set(tile.data.subarray(src, src + tile.w * 4), dst);
        }
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  /** 按服务器下发的指针形状更新 CSS 光标。 */
  const applyPointer = useCallback((msg: Record<string, unknown>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const shape = msg.shape;
    if (shape === 'hidden') {
      canvas.style.cursor = 'none';
      return;
    }
    if (shape === 'bitmap' && typeof msg.rgba === 'string') {
      const width = Number(msg.width) || 0;
      const height = Number(msg.height) || 0;
      if (width > 0 && height > 0 && width * height * 4 <= 128 * 128 * 4) {
        const bin = atob(msg.rgba);
        const rgba = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) rgba[i] = bin.charCodeAt(i);
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
          const hx = Number(msg.hotspotX) || 0;
          const hy = Number(msg.hotspotY) || 0;
          canvas.style.cursor = `url(${c.toDataURL()}) ${hx} ${hy}, default`;
          return;
        }
      }
    }
    canvas.style.cursor = 'default';
  }, []);

  /** 开始（或重连）RDP：请求后端建会话拿 wsUrl，再连本地 WebSocket。 */
  const startConnect = useCallback(async () => {
    const cfg = configRef.current;
    if (!cfg || !sessionId) {
      setStatus('error');
      setErrorMsg(t('rdp.missingConfig'));
      return;
    }
    const gen = ++genRef.current;
    teardownSocket();
    setStatus('starting');
    setErrorMsg(null);

    const container = containerRef.current;
    // 初始桌面分辨率取容器 CSS 尺寸（连接时容器必已挂载；异常兜底 1280×800）
    const width = Math.min(2560, Math.max(800, Math.floor(container?.clientWidth || 1280)));
    const height = Math.min(1600, Math.max(600, Math.floor(container?.clientHeight || 800)));

    let wsUrl: string;
    try {
      const result = await rdpConnect(sessionId, {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        password: passwordRef.current || '',
        width,
        height,
        generation: gen,
      });
      if (gen !== genRef.current) {
        // 本代已被取代/组件已卸载：精确清掉本代刚建的会话（后端仅停本代）
        void rdpDisconnect(sessionId, gen).catch(() => {});
        return;
      }
      wsUrl = result.wsUrl;
    } catch (err) {
      if (gen !== genRef.current) return;
      setStatus('error');
      setErrorMsg(String(err));
      return;
    }
    if (gen !== genRef.current) return;
    setStatus('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      void rdpDisconnect(sessionId, gen).catch(() => {});
      if (gen !== genRef.current) return;
      setStatus('error');
      setErrorMsg(String(err));
      return;
    }
    wsRef.current = ws;

    ws.onmessage = (e: MessageEvent) => {
      if (gen !== genRef.current) return;
      if (e.data instanceof ArrayBuffer) {
        const frame = parseFrame(e.data);
        if (frame) {
          // 首帧即视为画面就绪
          setStatus('connected');
          applyFrame(frame);
        }
        return;
      }
      // 控制消息（JSON 文本）
      try {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        const type = msg.type;
        if (type === 'pointer') {
          applyPointer(msg);
        } else if (type === 'error') {
          setStatus('error');
          setErrorMsg(typeof msg.message === 'string' ? msg.message : t('rdp.error'));
          teardownSocket();
        } else if (type === 'closed') {
          setStatus('disconnected');
          if (typeof msg.message === 'string' && msg.message) setErrorMsg(msg.message);
          teardownSocket();
        }
      } catch {
        /* 未知文本消息忽略 */
      }
    };
    ws.onclose = () => {
      if (gen !== genRef.current) return;
      setStatus((s) => (s === 'connected' || s === 'connecting' ? 'disconnected' : s));
      if (wsRef.current === ws) wsRef.current = null;
    };
    ws.onerror = () => {
      if (gen !== genRef.current) return;
      setStatus((s) => (s === 'connecting' ? 'error' : s));
    };
  }, [sessionId, teardownSocket, t, applyFrame, applyPointer]);

  // 挂载自动连接（skipAutoConnect / 缺密码 = 恢复会话，等待用户补交密码）
  useEffect(() => {
    if (skipAutoConnect || !rdpConfig?.password) {
      setStatus('disconnected');
      setNeedPassword(true);
      return;
    }
    void startConnect();
    return () => {
      // 卸载 / StrictMode 重挂：作废在途流程，按代停掉本实例建的会话
      const staleGen = genRef.current;
      genRef.current += 1;
      teardownSocket();
      if (sessionId) void rdpDisconnect(sessionId, staleGen).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // viewOnly 同步到 ref（输入回调读 ref，避免 stale closure）
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (viewOnly) keyInputRef.current?.blur();
  }, [viewOnly]);

  // 容器尺寸变化 → 防抖后请求服务器同步桌面分辨率
  useEffect(() => {
    if (status !== 'connected') return;
    const container = containerRef.current;
    if (!container) return;
    let timer = 0;
    let lastW = remoteSizeRef.current?.width ?? 0;
    let lastH = remoteSizeRef.current?.height ?? 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const w = Math.floor(container.clientWidth);
        const h = Math.floor(container.clientHeight);
        // 尺寸基本未变（或处于 fit 缩放的往返抖动）不触发重连
        if (w > 0 && h > 0 && (Math.abs(w - lastW) > 40 || Math.abs(h - lastH) > 40)) {
          lastW = w;
          lastH = h;
          sendResize(w, h);
        }
      }, 600);
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [status, sendResize]);

  // 键盘独占：隐形输入框聚焦期间应用快捷键让路（Layout 的窗口级监听不再抢键）；
  // 失焦/窗口失焦时释放全部修饰键——否则按下 Ctrl 后点别处，keyup 丢失，
  // 远端 Ctrl 永远按住，之后所有点击都变成 Ctrl+点（「好多操作没法执行」的主因）
  const releaseModifiers = useCallback(() => {
    for (const code of [
      'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
      'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
    ]) {
      sendInput({ kind: 'key', code, key: '', pressed: false });
    }
  }, [sendInput]);

  useEffect(() => {
    const el = keyInputRef.current;
    if (!el) return;
    const onFocus = () => useVncKeyboard.getState().setCaptured(true);
    const onBlur = () => {
      useVncKeyboard.getState().setCaptured(false);
      releaseModifiers();
    };
    const onWindowBlur = () => releaseModifiers();
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      window.removeEventListener('blur', onWindowBlur);
      useVncKeyboard.getState().setCaptured(false);
    };
  }, [releaseModifiers]);

  // 原生滚轮监听（非 passive）：React 的 onWheel 是 passive，preventDefault 无效
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const size = remoteSizeRef.current;
      if (!size) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.min(size.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * size.width)));
      const y = Math.min(size.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * size.height)));
      sendInput({ kind: 'mouseMove', x, y });
      const clampI16 = (v: number) => Math.min(32767, Math.max(-32768, Math.round(v)));
      if (Math.abs(e.deltaY) > 0.01) {
        sendInput({ kind: 'wheel', vertical: true, units: clampI16(-e.deltaY * 1.2) });
      }
      if (Math.abs(e.deltaX) > 0.01) {
        sendInput({ kind: 'wheel', vertical: false, units: clampI16(-e.deltaX * 1.2) });
      }
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [sendInput]);

  // 组件卸载兜底清理 rAF
  useEffect(
    () => () => {
      if (patchRafRef.current) cancelAnimationFrame(patchRafRef.current);
      if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    },
    [],
  );

  // ---- 鼠标/键盘输入 ----

  /** 容器 CSS 坐标 → 远端桌面像素坐标。 */
  const toRemote = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = remoteSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.min(size.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * size.width)));
    const y = Math.min(size.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * size.height)));
    return { x, y };
  }, []);

  const handlePointerMove = (e: React.PointerEvent) => {
    const pos = toRemote(e);
    if (!pos) return;
    // rAF 合并：一场移动风暴只发最新坐标（远端 20/s 足够，且减轻后端队列）
    pendingMoveRef.current = pos;
    if (moveRafRef.current) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = 0;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending) sendInput({ kind: 'mouseMove', x: pending.x, y: pending.y });
    });
  };

  const handlePointerButton = (e: React.PointerEvent, pressed: boolean) => {
    const pos = toRemote(e);
    if (!pos) return;
    // DOM button: 0 left / 1 middle / 2 right / 3 x1(back) / 4 x2(forward)
    const button = ['left', 'middle', 'right', 'x1', 'x2'][e.button] || 'left';
    sendInput({ kind: 'mouseButton', button, pressed });
    if (pressed) {
      // 捕获指针：拖拽出画布仍能收到 pointerup，远端鼠标键不会卡在按下
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      keyInputRef.current?.focus({ preventScroll: true });
    }
  };

  // 全部按键（含 F5/F11/F12）一律拦截转发远端：放行任何一个都会在本地产生
  // 副作用（F5 直接刷新整个应用、连接当场断开）；独占标记让 Layout 的
  // 标签快捷键让路，stopPropagation 阻断其他 window 级监听
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (composingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    sendInput({ kind: 'key', code: e.code, key: e.key, pressed: true });
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (composingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    sendInput({ kind: 'key', code: e.code, key: e.key, pressed: false });
  };

  const handleCompositionEnd = (e: React.CompositionEvent) => {
    composingRef.current = false;
    if (e.data) sendInput({ kind: 'text', text: e.data });
  };

  const submitPassword = () => {
    const pwd = passwordInput.trim();
    if (!pwd) return;
    passwordRef.current = pwd;
    setNeedPassword(false);
    setPasswordInput('');
    void startConnect();
  };

  const handleDisconnect = () => {
    genRef.current += 1;
    teardownSocket();
    setStatus('disconnected');
    if (sessionId) void rdpDisconnect(sessionId).catch(() => {});
  };

  /** 发送 Ctrl-Alt-Del（三个 scancode 键按下后延时释放）。 */
  const sendCtrlAltDel = () => {
    const keys = [
      { code: 'ControlLeft', key: 'Control' },
      { code: 'AltLeft', key: 'Alt' },
      { code: 'Delete', key: 'Delete' },
    ];
    for (const k of keys) sendInput({ kind: 'key', code: k.code, key: k.key, pressed: true });
    window.setTimeout(() => {
      for (const k of keys) sendInput({ kind: 'key', code: k.code, key: k.key, pressed: false });
    }, 120);
  };

  const connected = status === 'connected';
  const size = remoteSizeRef.current;
  const title = rdpConfig ? `${rdpConfig.host}:${rdpConfig.port}` : '';

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--color-background)' }}>
      {/* 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        <span className="mr-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              connected ? 'bg-success' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
            )}
          />
          <span className="truncate">{title || t('rdp.title')}</span>
          {connected && size && (
            <span className="shrink-0 tabular-nums">
              {size.width}×{size.height}
            </span>
          )}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={fitView ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setFitView((v) => !v)}
          >
            {t('rdp.fitWindow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected}
            onClick={() => setViewOnly((v) => !v)}
          >
            {t(viewOnly ? 'rdp.viewOnlyOn' : 'rdp.viewOnly')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected || viewOnly}
            title={t('rdp.ctrlAltDel')}
            onClick={sendCtrlAltDel}
          >
            {t('rdp.ctrlAltDel')}
          </Button>
          {connected ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleDisconnect}>
              {t('rdp.disconnect')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void startConnect()}>
              {t('rdp.reconnect')}
            </Button>
          )}
        </div>
      </div>

      {/* 桌面容器：fit=等比缩放居中，original=原始尺寸可滚动 */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
        style={{ overflow: fitView ? 'hidden' : 'auto', display: 'flex' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 背景层：与终端一致的主题底色/背景图（连接中与桌面缩放留边不再透白） */}
        <TerminalBackdrop
          extendToTopbar={false}
          solid={terminalBackground}
          imageUrl={backgroundImageUrl}
          blur={config?.terminal?.background_image_blur ?? 0}
          opacity={config?.terminal?.background_image_opacity ?? 0.7}
        />
        <div
          className={cn(
            'flex',
            fitView ? 'min-h-0 w-full items-center justify-center' : 'min-w-max',
          )}
          style={fitView ? { height: '100%' } : undefined}
        >
          <canvas
            ref={canvasRef}
            tabIndex={-1}
            className={cn('select-none', connected ? 'block' : 'hidden')}
            style={
              fitView
                ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                : undefined
            }
            onPointerMove={handlePointerMove}
            onPointerDown={(e) => handlePointerButton(e, true)}
            onPointerUp={(e) => handlePointerButton(e, false)}
            onPointerLeave={() => {
              /* 指针离开画布：不发送，远端保持最后位置 */
            }}
          />

        </div>

        {/* 隐形输入框：键盘焦点与 IME 载体；pointer-events 关闭不影响鼠标 */}
        <input
          ref={keyInputRef}
          type="text"
          aria-hidden
          className="pointer-events-none absolute size-px resize-none border-none bg-transparent p-0 opacity-0 outline-none"
          style={{ left: 0, bottom: 0 }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
        />

        {/* 连接中遮罩 */}
        {(status === 'starting' || status === 'connecting') && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground backdrop-blur-[1px]">
            <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
            <span>{t('rdp.connecting')}</span>
          </div>
        )}

        {/* 错误遮罩 */}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 text-center">
            <p className="max-w-md break-words text-sm text-destructive">{errorMsg || t('rdp.error')}</p>
            <Button size="sm" onClick={() => void startConnect()}>
              {t('rdp.retry')}
            </Button>
          </div>
        )}

        {/* 断连/未连接遮罩 */}
        {(status === 'disconnected' || status === 'idle') && !needPassword && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('rdp.disconnected')}</p>
            <Button size="sm" onClick={() => void startConnect()}>
              {t('rdp.reconnect')}
            </Button>
          </div>
        )}

        {/* 缺密码（恢复的会话）：输入凭据后连接 */}
        {needPassword && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6">
            <p className="text-sm text-muted-foreground">{t('rdp.needPassword')}</p>
            <Input
              autoFocus
              type="password"
              value={passwordInput}
              placeholder={t('rdp.passwordPlaceholder')}
              className="w-64"
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPassword();
              }}
            />
            <Button size="sm" disabled={!passwordInput} onClick={submitPassword}>
              {t('rdp.passwordSubmit')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
