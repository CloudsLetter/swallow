import { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { useTranslation } from 'react-i18next';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ask } from '@tauri-apps/plugin-dialog';
import { acceptHostKey, vncConnect, vncDisconnect } from '../services/sessionService';
import type { VncTabConfig } from '../store/tabStore';
import { useVncKeyboard } from '../store/vncKeyboard';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '@/lib/utils';

type VncStatus = 'idle' | 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error';

interface VncViewProps {
  sessionId?: string;
  vncConfig?: VncTabConfig;
  /** 恢复的会话缺少密码时跳过自动连接，等待用户手动连接 */
  skipAutoConnect?: boolean;
}

/** 为 RFB 事件挂监听（noVNC 类型声明不完整，事件按 CustomEvent 处理）。 */
function onRfb(rfb: RFB, type: string, handler: (detail: Record<string, unknown>) => void) {
  // noVNC 事件带 detail（{ clean?, reason?, text?, name? }）
  rfb.addEventListener(type, ((e: Event) => {
    handler(((e as CustomEvent).detail ?? {}) as Record<string, unknown>);
  }) as EventListener);
}

export function VncView({ sessionId, vncConfig, skipAutoConnect }: VncViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  /**
   * 连接代际：每次 startConnect 发起时 ++genRef 占位；组件卸载/主动断开时也 ++ 使旧代作废。
   * 所有 await 之后与 RFB 事件回调一律校验「gen === genRef.current」——旧代（StrictMode
   * 双挂载 / 快速重连留下的在途流程或旧 RFB）任何状态回写都忽略，杜绝「新连接实际存活、
   * 旧实例断开事件把界面打成已断开」的误报。不能用布尔 cancelledRef：它会被下一次 mount 重置。
   */
  const genRef = useRef(0);
  // 连接配置在连接开始时固定；vncConfig 对象身份变化不触发自动重连
  const configRef = useRef<VncTabConfig | undefined>(vncConfig);
  configRef.current = vncConfig;

  const [status, setStatus] = useState<VncStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [desktopName, setDesktopName] = useState<string | null>(null);
  const [fitView, setFitView] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [needPassword, setNeedPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  // 画质（noVNC qualityLevel 0-9）：高画质带宽大、流畅压缩高
  const [quality, setQuality] = useState(6);
  // 键盘独占：开启时画布聚焦期间应用级快捷键（新建/关闭/切换标签）让路给远端
  const [keyboardOn, setKeyboardOn] = useState(true);

  /** 关闭当前 RFB（不递增代际，供 startConnect 前清理旧实例） */
  const teardownRfb = useCallback(() => {
    const rfb = rfbRef.current;
    if (rfb) {
      // 先摘监听，避免 disconnect 事件回写状态
      try {
        (rfb as unknown as { removeAllListeners?: () => void }).removeAllListeners?.();
      } catch {
        /* noop */
      }
      rfb.disconnect();
      rfbRef.current = null;
    }
  }, []);

  /** 开始（或重连）VNC：先请求后端建桥拿 wsUrl，再让 noVNC 连上 */
  const startConnect = useCallback(async () => {
    const cfg = configRef.current;
    if (!cfg || !sessionId) {
      setStatus('error');
      setErrorMsg(t('vnc.missingConfig'));
      return;
    }
    // 本代占位：作废所有旧代在途流程与旧 RFB 的状态回写
    const gen = ++genRef.current;
    // 断掉旧实例（先摘监听，旧实例 disconnect 事件不会到达本代）
    teardownRfb();
    setStatus('starting');
    setErrorMsg(null);
    setNeedPassword(false);
    setDesktopName(null);

    let wsUrl: string | undefined;
    try {
      const result = await vncConnect(sessionId, {
        host: cfg.host,
        port: cfg.port,
        // 直连时密码仅交给 noVNC 完成 RFB 认证，不经后端、不进 URL
        password: cfg.password || undefined,
        shared: cfg.shared ?? true,
        ssh: cfg.ssh,
        generation: gen,
      });
      // 本代已被取代/组件已卸载：精确清掉本代刚建的桥（后端仅停本代，不误伤新代）
      if (gen !== genRef.current) {
        void vncDisconnect(sessionId, gen).catch(() => {});
        return;
      }
      // SSH 隧道首次遇到未知主机密钥：确认指纹后（写入 known_hosts）重试连接
      if (!result.wsUrl && result.hostKeyToken) {
        const confirmed = await ask(
          `${t('vnc.hostKeyFingerprint')}\n${result.fingerprint || ''}\n\n${result.host ?? ''}:${result.port ?? ''}`,
          {
            title: t('vnc.hostKeyTitle'),
            kind: 'warning',
            okLabel: t('vnc.hostKeyTrust'),
            cancelLabel: t('vnc.hostKeyCancel'),
          },
        );
        if (gen !== genRef.current) return;
        if (!confirmed) {
          setStatus('disconnected');
          return;
        }
        try {
          await acceptHostKey(result.hostKeyToken, result.fingerprint || '');
        } catch (err) {
          if (gen !== genRef.current) return;
          setStatus('error');
          setErrorMsg(String(err));
          return;
        }
        if (gen !== genRef.current) return;
        // 指纹已信任：重试本连接（将复用已写入的 known_hosts）；重试即新一代
        void startConnect();
        return;
      }
      wsUrl = result.wsUrl;
    } catch (err) {
      // 过期代失败静默（后端可能已由新代接管，无需提示）
      if (gen !== genRef.current) return;
      setStatus('error');
      setErrorMsg(String(err));
      return;
    }
    if (gen !== genRef.current || !containerRef.current) return;
    if (!wsUrl) {
      setStatus('error');
      setErrorMsg(t('vnc.error'));
      return;
    }

    // 容器复用前清空（RFB 会向容器 append 自身 DOM）
    containerRef.current.innerHTML = '';
    setRemoteClipboard(null);
    setStatus('connecting');

    let rfb: RFB;
    try {
      rfb = new RFB(containerRef.current, wsUrl, {
        credentials: cfg.password ? { password: cfg.password } : undefined,
        shared: cfg.shared ?? true,
      });
    } catch (err) {
      // RFB 构造失败：后端桥已建好但无人使用，按代清掉，避免泄漏到自清窗口
      void vncDisconnect(sessionId, gen).catch(() => {});
      if (gen !== genRef.current) return;
      setStatus('error');
      setErrorMsg(String(err));
      return;
    }
    rfbRef.current = rfb;

    // 初始视图参数
    rfb.scaleViewport = fitView;
    rfb.clipViewport = !fitView;
    rfb.viewOnly = viewOnly;
    rfb.resizeSession = false;
    rfb.qualityLevel = quality;
    rfb.focusOnClick = keyboardOn;

    // 事件一律只认本代：旧 RFB 的任何迟到事件不得覆盖新代状态（防「新连接存活却报断」）
    onRfb(rfb, 'connect', () => {
      if (gen !== genRef.current) return;
      setStatus('connected');
      setNeedPassword(false);
    });
    onRfb(rfb, 'disconnect', (detail) => {
      if (gen !== genRef.current) return;
      setStatus('disconnected');
      if (detail.clean === false && detail.message) {
        setErrorMsg(String(detail.message));
      }
      if (rfbRef.current === rfb) rfbRef.current = null;
    });
    onRfb(rfb, 'credentialsrequired', () => {
      if (gen !== genRef.current) return;
      // 未预先提供密码：弹输入框，sendCredentials 补交
      setNeedPassword(true);
    });
    onRfb(rfb, 'securityfailure', (detail) => {
      if (gen !== genRef.current) return;
      setStatus('error');
      setErrorMsg((detail.reason as string) || t('vnc.securityFailure'));
    });
    onRfb(rfb, 'desktopname', (detail) => {
      if (gen !== genRef.current) return;
      if (detail.name) setDesktopName(String(detail.name));
    });
    onRfb(rfb, 'clipboard', (detail) => {
      if (gen !== genRef.current) return;
      if (typeof detail.text === 'string') setRemoteClipboard(detail.text);
    });
    // bell 无操作（后续可做提示音）
  }, [sessionId, teardownRfb, t, fitView, viewOnly, quality, keyboardOn]);

  // 挂载自动连接（skipAutoConnect = 恢复会话缺密码，等待手动）
  useEffect(() => {
    if (skipAutoConnect) {
      setStatus('disconnected');
      return;
    }
    void startConnect();
    return () => {
      // 卸载 / StrictMode 重挂：作废在途流程与旧 RFB 事件，按代停掉本组件实例
      // 最后一代已建的桥（staleGen 与新一代不等则后端不误杀）
      const staleGen = genRef.current;
      genRef.current += 1;
      try {
        rfbRef.current?.disconnect();
      } catch {
        /* noop */
      }
      rfbRef.current = null;
      if (sessionId) void vncDisconnect(sessionId, staleGen).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 视图参数变化即时应用到已连接实例
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = fitView;
    rfb.clipViewport = !fitView;
  }, [fitView]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    if (viewOnly) useVncKeyboard.getState().setCaptured(false);
  }, [viewOnly]);

  // 画质变化即时应用
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.qualityLevel = quality;
  }, [quality, status]);

  // 键盘独占开关：关闭时移出焦点并释放标记
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.focusOnClick = keyboardOn;
    if (!keyboardOn) {
      rfbRef.current?.blur();
      useVncKeyboard.getState().setCaptured(false);
    }
  }, [keyboardOn]);

  // 画布聚焦跟踪：noVNC 的键盘挂在 canvas 元素上（真实 DOM focus），
  // 聚焦期间应用快捷键让路；焦点离开（点工具栏/其他区域）自动释放
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onFocusIn = () => {
      useVncKeyboard.getState().setCaptured(keyboardOn && !viewOnly);
    };
    const onFocusOut = () => {
      useVncKeyboard.getState().setCaptured(false);
    };
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      useVncKeyboard.getState().setCaptured(false);
    };
  }, [keyboardOn, viewOnly]);

  // 组件卸载兜底释放
  useEffect(() => () => useVncKeyboard.getState().setCaptured(false), []);

  /** 发送组合键到远端（按下后延迟统一释放，绕过本地/浏览器快捷键拦截）。 */
  const sendKeyCombo = (keys: [number, string][]) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    keys.forEach(([keysym, code]) => rfb.sendKey(keysym, code, true));
    window.setTimeout(() => {
      [...keys].reverse().forEach(([keysym, code]) => rfb.sendKey(keysym, code, false));
    }, 80);
  };

  const KEY_ACTIONS: { labelKey: string; keys: [number, string][] }[] = [
    { labelKey: 'vnc.ctrlAltDel', keys: [[0xffe3, 'ControlLeft'], [0xffe1, 'AltLeft'], [0xffff, 'Delete']] },
    { labelKey: 'vnc.keyAltTab', keys: [[0xffe9, 'AltLeft'], [0xff09, 'Tab']] },
    { labelKey: 'vnc.keyWin', keys: [[0xffeb, 'MetaLeft']] },
    { labelKey: 'vnc.keyCtrlShiftEsc', keys: [[0xffe3, 'ControlLeft'], [0xffe1, 'ShiftLeft'], [0xff1b, 'Escape']] },
    { labelKey: 'vnc.keyF5', keys: [[0xffc2, 'F5']] },
  ];

  const submitPassword = () => {
    const pwd = passwordInput.trim();
    if (!pwd) return;
    rfbRef.current?.sendCredentials({ password: pwd });
    setNeedPassword(false);
    setPasswordInput('');
  };

  const handleDisconnect = () => {
    // 作废在途流程与旧 RFB 事件（断开后再点重连会开新一代）
    genRef.current += 1;
    teardownRfb();
    setStatus('disconnected');
    if (sessionId) void vncDisconnect(sessionId).catch(() => {});
  };

  const handleCopyRemoteClipboard = async () => {
    if (!remoteClipboard) return;
    try {
      await writeText(remoteClipboard);
    } catch (err) {
      console.warn('copy remote clipboard failed:', err);
    }
  };

  const handlePasteLocalClipboard = async () => {
    try {
      const text = await readText();
      if (text) rfbRef.current?.clipboardPasteFrom(text);
    } catch (err) {
      console.warn('paste to remote clipboard failed:', err);
    }
  };

  const connected = status === 'connected';
  const title = desktopName || (vncConfig ? `${vncConfig.host}:${vncConfig.port}` : '');

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
          <span className="truncate">{title || t('vnc.title')}</span>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={fitView ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setFitView((v) => !v)}
          >
            {t('vnc.fitWindow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected}
            onClick={() => setViewOnly((v) => !v)}
          >
            {t(viewOnly ? 'vnc.viewOnlyOn' : 'vnc.viewOnly')}
          </Button>
          <Button
            variant={keyboardOn ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected}
            title={t('vnc.keyboardHint')}
            onClick={() =>
              setKeyboardOn((v) => {
                if (v) {
                  rfbRef.current?.blur();
                  useVncKeyboard.getState().setCaptured(false);
                }
                return !v;
              })
            }
          >
            {t(keyboardOn ? 'vnc.keyboardOn' : 'vnc.keyboard')}
          </Button>
          <Select value={String(quality)} onValueChange={(v) => setQuality(Number(v))}>
            <SelectTrigger className="h-6 w-[4.5rem] px-1.5 text-xs" title={t('vnc.quality')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9">{t('vnc.qualityHigh')}</SelectItem>
              <SelectItem value="6">{t('vnc.qualityBalanced')}</SelectItem>
              <SelectItem value="2">{t('vnc.qualitySmooth')}</SelectItem>
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={!connected || viewOnly}
                title={t('vnc.sendKeys')}
              >
                {t('vnc.sendKeys')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {KEY_ACTIONS.map((a) => (
                <DropdownMenuItem key={a.labelKey} onClick={() => sendKeyCombo(a.keys)}>
                  {t(a.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected || !remoteClipboard}
            title={t('vnc.copyRemote')}
            onClick={() => void handleCopyRemoteClipboard()}
          >
            {t('vnc.copyRemote')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!connected}
            title={t('vnc.pasteLocal')}
            onClick={() => void handlePasteLocalClipboard()}
          >
            {t('vnc.pasteLocal')}
          </Button>
          {connected ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleDisconnect}>
              {t('vnc.disconnect')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void startConnect()}>
              {t('vnc.reconnect')}
            </Button>
          )}
        </div>
      </div>

      {/* 桌面容器：fit=裁切隐藏，original=允许滚动查看完整画布 */}
      <div
        className="min-h-0 flex-1"
        style={{ overflow: fitView ? 'hidden' : 'auto', position: 'relative' }}
      >
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />

        {/* 连接中遮罩 */}
        {(status === 'starting' || status === 'connecting') && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground backdrop-blur-[1px]">
            <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
            <span>{t('vnc.connecting')}</span>
          </div>
        )}

        {/* 错误遮罩 */}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 text-center">
            <p className="max-w-md break-words text-sm text-destructive">{errorMsg || t('vnc.error')}</p>
            <Button size="sm" onClick={() => void startConnect()}>
              {t('vnc.retry')}
            </Button>
          </div>
        )}

        {/* 断连/未连接遮罩 */}
        {(status === 'disconnected' || status === 'idle') && !needPassword && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {skipAutoConnect ? t('vnc.missingPasswordHint') : t('vnc.disconnected')}
            </p>
            <Button size="sm" onClick={() => void startConnect()}>
              {t('vnc.reconnect')}
            </Button>
          </div>
        )}

        {/* 需要密码遮罩 */}
        {needPassword && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 p-6">
            <p className="text-sm text-muted-foreground">{t('vnc.needPassword')}</p>
            <Input
              autoFocus
              type="password"
              value={passwordInput}
              placeholder={t('vnc.passwordPlaceholder')}
              className="w-64"
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPassword();
              }}
            />
            <Button size="sm" disabled={!passwordInput} onClick={submitPassword}>
              {t('vnc.passwordSubmit')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
