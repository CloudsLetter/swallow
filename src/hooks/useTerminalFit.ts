import { useEffect, useRef } from 'react';
import { createOrGetTerminal, fitTerminal } from '../components/terminalPool';

/**
 * 集中管理终端尺寸适配（原分散在 TerminalView 的 5 处重复 fit + PTY 同步）：
 * - 窗口 resize（非激活标签跳过——keep-alive 下 display:none 容器 fit 得 0x0 会破坏后端 PTY）
 * - 标签切回激活时 refit（display:none 期间容器尺寸归零，切回后重新适配）
 * - 分屏拖动分隔条 resizeSignal 变化时 refit
 * xterm 的 resize 事件由 terminalPool 统一同步到后端 PTY；这里不再在调用点
 * 重复发 resize IPC，避免延迟校准等其他 resize 路径与此处出现遗漏或竞态。
 */
export function useTerminalFit(opts: {
  sessionId?: string;
  isActive: boolean;
  resizeSignal?: number;
}) {
  const { sessionId, isActive, resizeSignal } = opts;

  // ref 镜像：监听器/回调取最新值而不重建订阅
  const activeRef = useRef(isActive);
  useEffect(() => {
    activeRef.current = isActive;
  }, [isActive]);
  const prevSignal = useRef(resizeSignal);

  const refit = () => {
    const id = sessionId;
    if (!id) return;
    try {
      const poolItem = createOrGetTerminal(id);
      if (!poolItem?.fit || !poolItem.terminal) return;
      ensureObserver(poolItem.terminal);
      fitTerminal(id);
    } catch (e) {
      console.warn('Refit terminal failed:', e);
    }
  };
  const refitRef = useRef(refit);
  refitRef.current = refit;

  // ResizeObserver：捕捉非窗口级尺寸变化（右面板收起/展开、侧栏、布局兄弟变化）。
  // window resize 监听覆盖不到这些（webview 本身没变），此前右面板收起不会 auto-fit。
  const roRef = useRef<ResizeObserver | null>(null);
  const observedEl = useRef<Element | null>(null);
  const ensureObserver = (term: { element?: HTMLElement | null }) => {
    const el = term.element;
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (observedEl.current === el && roRef.current) return;
    roRef.current?.disconnect();
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (activeRef.current) refitRef.current();
      });
    });
    ro.observe(el);
    roRef.current = ro;
    observedEl.current = el;
  };
  // 卸载时断开（sessionId 固定即一次）
  useEffect(
    () => () => {
      roRef.current?.disconnect();
      roRef.current = null;
      observedEl.current = null;
    },
    [sessionId],
  );

  // 窗口尺寸变化（保持与激活状态同步判断，同原 isActiveRef 语义）
  useEffect(() => {
    const onResize = () => {
      if (!sessionId || !activeRef.current) return;
      refitRef.current();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sessionId]);

  // 标签切回激活：display:none 期间容器尺寸归零，切回后重新适配
  useEffect(() => {
    if (!isActive || !sessionId) return;
    const rafId = requestAnimationFrame(() => refitRef.current());
    return () => cancelAnimationFrame(rafId);
  }, [isActive, sessionId]);

  // 分屏拖动分隔条：外部尺寸变化信号递增 → 重新适配
  useEffect(() => {
    if (resizeSignal === prevSignal.current || !sessionId) return;
    prevSignal.current = resizeSignal;
    const rafId = requestAnimationFrame(() => refitRef.current());
    return () => cancelAnimationFrame(rafId);
  }, [resizeSignal, sessionId]);
}
