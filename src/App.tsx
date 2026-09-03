import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';

import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Toaster } from './components/ui/sonner';
import { OnboardingDialog } from './components/OnboardingDialog';
import { DebugConsole } from './components/DebugConsole';
import { ErrorBoundary } from './components/ErrorBoundary';
import './App.css';
import { useConfigStore } from './store/config';
import { initTransferProgressListener } from './store/transferStore';
import { useTabStore, type Tab } from './store/tabStore';
import { loadOpenSessions, saveOpenSessions, getHosts } from './services/dataService';
import { checkForAppUpdates } from './services/updaterService';
import i18next from './i18n/i18n';

function App() {
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

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
  // capture 阶段拦截，组件自定义右键菜单（如标签栏）自身的逻辑不受影响。
  useEffect(() => {
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
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
          type: 'terminal' | 'telnet' | 'local' | 'sftp';
          sshConfig?: Tab['sshConfig'];
          telnetConfig?: Tab['telnetConfig'];
          localConfig?: Tab['localConfig'];
          sftpConfig?: Tab['sftpConfig'];
        }>;
        const { createTab } = useTabStore.getState();
        for (const s of sessions) {
          // 密码认证会话的密码从不落盘 → 恢复后无凭据，跳过自动连接（等待用户重连），
          // 避免启动即报「无密码/无密钥」连接失败
          const passwordAuth = s.sshConfig?.auth_type === 'password' && !s.sshConfig.password;
          const sftpPasswordAuth = s.sftpConfig?.authType === 'password' && !s.sftpConfig.password;
          createTab({
            name: s.name,
            type: s.type,
            sshConfig: s.sshConfig,
            telnetConfig: s.telnetConfig,
            localConfig: s.localConfig,
            sftpConfig: s.sftpConfig,
            skipAutoConnect: passwordAuth || sftpPasswordAuth,
          });
        }
      } catch (e) {
        console.warn('Failed to restore sessions:', e);
      }
    })();
  }, [config]);

  // 标签变化时持久化当前打开的会话（仅 terminal/sftp，密码/passphrase 不落盘）
  useEffect(() => {
    const persist = () => {
      const { tabs } = useTabStore.getState();
      const sessions = tabs
        .filter((t) => t.type === 'terminal' || t.type === 'telnet' || t.type === 'local' || t.type === 'sftp')
        .map((t) => ({
          name: t.name,
          type: t.type,
          sshConfig: t.sshConfig ? { ...t.sshConfig, password: undefined, passphrase: undefined } : undefined,
          telnetConfig: t.telnetConfig,
          localConfig: t.localConfig,
          sftpConfig: t.sftpConfig ? { ...t.sftpConfig, password: undefined, passphrase: undefined } : undefined,
        }));
      void saveOpenSessions(JSON.stringify(sessions)).catch(() => {});
    };
    return useTabStore.subscribe(persist);
  }, []);

  return (
    <I18nextProvider i18n={i18next}>
      <DndProvider backend={HTML5Backend}>
        <Layout>
          <Home />
        </Layout>
        <Toaster position="top-center" />
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
      </DndProvider>
    </I18nextProvider>
  );
}

export default App;
