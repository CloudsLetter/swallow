/**
 * @novnc/novnc 本地类型声明（type-only，不引入任何 npm 依赖）。
 *
 * @novnc/novnc 是纯 JS 包，自身不带 .d.ts；按约定不装 @types/novnc__novnc，
 * 由本文件声明 VncView 用到的子集。若日后引入官方类型，删除本文件即可。
 */
declare module '@novnc/novnc' {
  interface RFBCredentials {
    password?: string;
    username?: string;
    target?: string;
  }

  interface RFBOptions {
    credentials?: RFBCredentials;
    /** 请求与现有会话共享同一桌面（默认 true） */
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    /** 缩放画布以适应当前容器 */
    scaleViewport: boolean;
    /** 视口裁切（配合外层滚动容器查看完整桌面） */
    clipViewport: boolean;
    /** 只读模式：禁止键盘/鼠标/剪贴板输入 */
    viewOnly: boolean;
    /** 向服务端请求改变分辨率（默认 false，不改远端布局） */
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;

    addEventListener(type: string, handler: EventListener): void;
    removeEventListener(type: string, handler: EventListener): void;
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    /** 点击画布是否自动聚焦（键盘独占开关用；默认 true） */
    focusOnClick: boolean;
    /** Tight/JPEG 画质 0-9（默认 6）：高 = 带宽大画质好，低 = 流畅 */
    qualityLevel: number;
    /** 发送单个按键（keysym 为 X11 keysym，code 为 KeyboardEvent.code 风格键名） */
    sendKey(keysym: number, code: string, down?: boolean): void;
  }
}
