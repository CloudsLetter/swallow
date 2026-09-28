import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';

import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { focusTerminal, isConnected, listPool } from './components/terminalPool';
import { Toaster } from './components/ui/sonner';
import { OnboardingDialog } from './components/OnboardingDialog';
import { SessionNotifications } from './components/SessionNotifications';
import { DebugConsole } from './components/DebugConsole';
import { CommandPalette } from './components/CommandPalette';
import { AiAssistant } from './components/AiAssistant';
import { ErrorBoundary } from './components/ErrorBoundary';
import './App.css';
import { useConfigStore } from './store/config';
import { usePanelStore } from './store/panelStore';
import { initTransferProgressListener } from './store/transferStore';
import { useTabStore, type Tab } from './store/tabStore';
import { loadOpenSessions, saveOpenSessions, getHosts } from './services/dataService';
import { checkForAppUpdates } from './services/updaterService';
import i18next from './i18n/i18n';

function App() {
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // AI 独立抽屉（顶栏 AI 按钮开关，与右侧功能面板解耦）
  const aiOpen = usePanelStore((s) => s.aiOpen);
  const setAiOpen = usePanelStore((s) => s.setAiOpen);

  // AI 抽屉收纳后把键盘焦点还给当前终端会话（与左右面板收起行为一致）
  const prevAiOpen = useRef(aiOpen);
  useEffect(() => {
    const wasOpen = prevAiOpen.current;
    prevAiOpen.current = aiOpen;
    if (wasOpen && !aiOpen) {
      const { tabs, activeTabId } = useTabStore.getState();
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.sessionId && ['terminal', 'telnet', 'local', 'serial', 'mosh'].includes(tab.type)) {
        focusTerminal(tab.sessionId);
      }
    }
  }, [aiOpen]);

  // 初次使用引导：config 未完成引导且主机列表为空（全新安装）时弹出一次
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingCheckedRef = useRef(false);
  useEffect(() => {
    if (!config || onboardingCheckedRef.current) return;
    if (config.application?.onboarding_done) return; // 已引导过（含老用户显式跳过）
    onboardingCheckedRef.current = true;
    void getHosts()
      .then((hosts) => {
        // 二次闸：已有主机数据的用户（老库）视为已在使用，不打扰
        if (hosts.length === 0) setShowOnboarding(true);
      })
      .catch(() => {});
  }, [config]);

  const finishOnboarding = () => {
    if (!config) return;
    updateConfig({
      application: { ...config.application, onboarding_done: true },
    });
  };

  // 初始化全局下载进度监听（与视图解耦，保证进度事件一定更新到 store）
  useEffect(() => {
    initTransferProgressListener();
  }, []);

  // 自动隐藏滚动条：两侧栏 .panel-scroll 用纯 CSS :hover 驱动
  // （进入面板淡入、移出淡出，行为对齐 xterm 自绘滑块，见 index.css），无需 JS。

  // 全局阻止 WebView2 对文件拖放的默认行为（dragDropEnabled:false 后不拦截，
  // 若不 preventDefault，拖文件到非 SFTP 区域会导致 webview 导航到本地文件/白屏）。
  // 具体上传逻辑由各视图（SftpView）自行处理。
  useEffect(() => {
    const preventDefault = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragenter', preventDefault, true);
    window.addEventListener('dragover', preventDefault, true);
    window.addEventListener('drop', preventDefault, true);
    return () => {
      window.removeEventListener('dragenter', preventDefault, true);
      window.removeEventListener('dragover', preventDefault, true);
      window.removeEventListener('drop', preventDefault, true);
    };
  }, []);

  // 禁用 WebView 原生右键菜单（复制/粘贴/检查元素等系统 UI）。
  // capture 阶段拦截。⚠️ 标注了 data-custom-contextmenu 的区域必须放行：
  // Radix ContextMenu 的打开逻辑在 event.defaultPrevented 时会被 composeEventHandlers
  // 跳过（checkForDefaultPrevented），全局 preventDefault 会把应用内所有
  // 自定义右键菜单静默废掉——放行后由 Radix 自己 preventDefault 抑制原生菜单。
  useEffect(() => {
    const preventContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-custom-contextmenu]')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', preventContextMenu, true);
    return () => document.removeEventListener('contextmenu', preventContextMenu, true);
  }, []);

  // 拦截 WebView/浏览器原生快捷键，避免刷新/开发者工具等破坏应用状态：
  // F5 / Ctrl+R 刷新、F12 / Ctrl+Shift+I / Ctrl+Shift+C / Ctrl+Shift+J 开发者工具
  // （Ctrl+Shift+C 在 Chromium 系是「检查元素」）、Ctrl+P 打印、Ctrl+U 查看源码、F11 全屏。
  // 只 preventDefault（不阻断传播），应用自定义快捷键与输入框编辑键不受影响。
  // DevTools 相关组合仅在【生产构建】拦截——开发模式（vite dev，import.meta.env.DEV）
  // 放行，让 F12 / Ctrl+Shift+I 能正常唤出原生开发者工具。
  useEffect(() => {
    const blockNativeKeys = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const refresh = k === 'f5' || (e.ctrlKey && k === 'r');
      const devtools =
        k === 'f12' ||
        (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'c' || k === 'j')) ||
        (e.ctrlKey && k === 'u');
      const reserved = (e.ctrlKey && (k === 'p' || k === 's')) || k === 'f11';
      if (refresh || (!import.meta.env.DEV && devtools) || reserved) e.preventDefault();
    };
    document.addEventListener('keydown', blockNativeKeys, true);
    return () => document.removeEventListener('keydown', blockNativeKeys, true);
  }, []);

  // 语言设置响应式生效：启动加载与设置修改都会触发切换
  useEffect(() => {
    if (config?.appearance?.language) {
      void i18next.changeLanguage(config.appearance.language);
    }
  }, [config?.appearance?.language]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 云同步恢复 settings 类目后，后端 emit 事件，这里重新加载配置让主题/字体等即时生效
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen('cloud-config-changed', () => {
      void loadConfig();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [loadConfig]);

  // 启动时自动检查更新（配置加载完成后触发一次；dev 环境无签名跳过，避免无谓网络请求）
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (!config || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    if (!config.advanced.check_updates) return;
    if (import.meta.env.DEV) return;
    void checkForAppUpdates({ interactive: false });
  }, [config]);

  // 启动时恢复上次打开的标签会话（配置加载完成后恢复，避免连接时缺配置）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!config || restoredRef.current) return;
    restoredRef.current = true;
    // 开关关闭：不恢复上次会话（sessions.json 保留，下次开启仍可恢复）
    if (!config.advanced.restore_sessions) return;
    void (async () => {
      try {
        const data = await loadOpenSessions();
        const sessions = JSON.parse(data) as Array<{
          name: string;
          type: 'terminal' | 'telnet' | 'local' | 'serial' | 'sftp' | 'vnc' | 'rdp' | 'mosh';
          sshConfig?: Tab['sshConfig'];
          telnetConfig?: Tab['telnetConfig'];
          localConfig?: Tab['localConfig'];
          serialConfig?: Tab['serialConfig'];
          sftpConfig?: Tab['sftpConfig'];
          vncConfig?: Tab['vncConfig'];
          rdpConfig?: Tab['rdpConfig'];
          moshConfig?: Tab['moshConfig'];
        }>;
        const { createTab } = useTabStore.getState();
        for (const s of sessions) {
          // 密码认证会话的密码从不落盘 → 恢复后无凭据，跳过自动连接（等待用户重连），
          // 避免启动即报「无密码/无密钥」连接失败
          const passwordAuth = s.sshConfig?.auth_type === 'password' && !s.sshConfig.password;
          const sftpPasswordAuth = s.sftpConfig?.authType === 'password' && !s.sftpConfig.password;
          // VNC 直连：缺 VNC 密码不跳过——无密码 VNC 本就该自动连，需要密码时
          // noVNC 会发 credentialsrequired 弹输入框兜底（区分不了「没存」与「本无密码」）。
          // VNC 走 SSH 隧道 + 密码认证：ssh 密码缺失时 ssh2 无交互兜底必然失败 → 跳过。
          const vncSshPasswordMissing =
            s.type === 'vnc' &&
            !!s.vncConfig?.ssh &&
            s.vncConfig.ssh.sshAuthType === 'password' &&
            !s.vncConfig.ssh.sshPassword;
          // RDP：NLA 密码从不落盘 → 恢复后必然认证失败 → 跳过自动连接，
          // RdpView 弹密码输入框兜底（用户补交后连接）
          const rdpPasswordMissing = s.type === 'rdp' && !s.rdpConfig?.password;
          // MOSH：引导认证与 SSH 同链路，密码类认证缺密码时跳过（与 SSH 一致）
          const moshPasswordMissing = s.type === 'mosh' && s.moshConfig?.auth_type === 'password' && !s.moshConfig.password;
          createTab({
            name: s.name,
            type: s.type,
            sshConfig: s.sshConfig,
            telnetConfig: s.telnetConfig,
            localConfig: s.localConfig,
            serialConfig: s.serialConfig,
            sftpConfig: s.sftpConfig,
            vncConfig: s.vncConfig,
            rdpConfig: s.rdpConfig,
            moshConfig: s.moshConfig,
            skipAutoConnect: passwordAuth || sftpPasswordAuth || vncSshPasswordMissing || rdpPasswordMissing || moshPasswordMissing,
          });
        }
      } catch (e) {
        console.warn('Failed to restore sessions:', e);
      }
    })();
  }, [config]);

  // 标签变化时持久化当前打开的会话（仅 terminal/sftp/vnc/rdp，密码/passphrase 不落盘）
  useEffect(() => {
    let lastSaved = '';
    const persist = () => {
      // auto_save 关闭时不落盘：sessions.json 保留旧内容，开启 restore_sessions 后
      // 仍可恢复到上次自动保存的状态（文件从不主动删除）
      if (!useConfigStore.getState().config?.advanced?.auto_save) return;
      const { tabs } = useTabStore.getState();
      const sessions = tabs
        .filter((t) => t.type === 'terminal' || t.type === 'telnet' || t.type === 'local' || t.type === 'serial' || t.type === 'sftp' || t.type === 'vnc' || t.type === 'rdp' || t.type === 'mosh')
        .map((t) => ({
          name: t.name,
          type: t.type,
          sshConfig: t.sshConfig ? { ...t.sshConfig, password: undefined, passphrase: undefined } : undefined,
          telnetConfig: t.telnetConfig,
          localConfig: t.localConfig,
          serialConfig: t.serialConfig,
          sftpConfig: t.sftpConfig ? { ...t.sftpConfig, password: undefined, passphrase: undefined } : undefined,
          vncConfig: t.vncConfig
            ? {
                ...t.vncConfig,
                password: undefined,
                ssh: t.vncConfig.ssh
                  ? { ...t.vncConfig.ssh, sshPassword: undefined, sshPassphrase: undefined }
                  : undefined,
              }
            : undefined,
          rdpConfig: t.rdpConfig ? { ...t.rdpConfig, password: undefined } : undefined,
          moshConfig: t.moshConfig ? { ...t.moshConfig, password: undefined, passphrase: undefined } : undefined,
        }));
      // tab 切换只改 activeTabId（不参与序列化）：内容没变化就不写盘，
      // 否则每次切标签都触发一次 sessions.json 全量写
      const json = JSON.stringify(sessions);
      if (json === lastSaved) return;
      lastSaved = json;
      void saveOpenSessions(json).catch(() => {});
    };
    return useTabStore.subscribe(persist);
  }, []);

  // 窗口关闭拦截（覆盖自定义按钮、原生标题栏与 Alt+F4 全部关闭路径）：
  // - minimize_to_tray：隐藏到系统托盘而不退出（托盘菜单可唤回/退出，Rust 侧建托盘）；
  // - 否则 confirm_on_close 且存在活动会话时弹确认框，取消则阻止关闭（无会话直接关）。
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      const cfg = useConfigStore.getState().config;
      if (cfg?.advanced.minimize_to_tray) {
        event.preventDefault();
        void win.hide();
        return;
      }
      if (!cfg?.advanced.confirm_on_close) return;
      const active = listPool().filter((id) => isConnected(id)).length;
      if (active === 0) return;
      event.preventDefault();
      const confirmed = await ask(String(i18next.t('settings.confirmExitMessage', { count: active })), {
        title: String(i18next.t('settings.confirmExit')),
        kind: 'warning',
      });
      if (confirmed) await win.destroy();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <I18nextProvider i18n={i18next}>
      <DndProvider backend={HTML5Backend}>
        <Layout>
          <Home />
        </Layout>
        <Toaster position="top-center" />
        <SessionNotifications />
        <OnboardingDialog
          open={showOnboarding}
          onOpenChange={setShowOnboarding}
          onFinish={finishOnboarding}
        />
        {config?.advanced?.debug_mode && (
          <ErrorBoundary>
            <DebugConsole />
          </ErrorBoundary>
        )}
        <CommandPalette />
        <AiAssistant open={aiOpen} onOpenChange={setAiOpen} />
      </DndProvider>
    </I18nextProvider>
  );
}

export default App;
