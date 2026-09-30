import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN';

// 首包只内联默认语言（zh-CN，~80KB 源码）；en-US 按需动态加载——任一时刻只用一种
// 语言，非激活语言打进首包是纯浪费。init 后立即后台预取 en，用户切语言时几乎必然就绪。
i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': {
      translation: zhCN,
    },
  },
  lng: 'zh-CN',
  // 双语文案严格同步（缺键视为 bug）；en 未装载的窗口期回退到 zh 优于显示原始 key
  fallbackLng: 'zh-CN',
  // 资源是部分内置的：en 由 addResourceBundle 在运行时装载，不参与 init
  partialBundledLanguages: true,
  interpolation: {
    escapeValue: false,
  },
});

let enLoaded = false;

/** 确保 en-US 资源已装载（语言切换前 await；启动时后台预取）。幂等。 */
export async function ensureEnLoaded(): Promise<void> {
  if (enLoaded) return;
  const enUS = (await import('./locales/en-US')).default;
  i18n.addResourceBundle('en-US', 'translation', enUS, true, true);
  enLoaded = true;
}

// 后台预取：不阻塞首屏；失败仅告警（切换语言时会重试）
void ensureEnLoaded().catch((e) => console.warn('[i18n] en-US 预取失败:', e));

export default i18n;
