import { create } from 'zustand';

/**
 * Home 侧边栏当前激活页面（内存发布-订阅）：Home 每次切换页面时写入，
 * 供 keep-alive 页面（如已知主机）在重新可见时刷新数据。
 */
interface UiPageState {
  homePage: string | null;
  setHomePage: (page: string | null) => void;
  /** 待处理的页面跳转请求（全局命令条等外部入口发起，Home 消费后清空） */
  pendingNav: string | null;
  setPendingNav: (page: string | null) => void;
}

export const useUiPage = create<UiPageState>((set) => ({
  homePage: null,
  setHomePage: (page) => set({ homePage: page }),
  pendingNav: null,
  setPendingNav: (page) => set({ pendingNav: page }),
}));
