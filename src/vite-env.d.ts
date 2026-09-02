/// <reference types="vite/client" />

// 扩展 React CSSProperties 类型以支持 WebkitAppRegion
import 'react';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

// 声明 xterm.js 模块（如果类型声明缺失）
declare module '@xterm/xterm' {
  export class Terminal {
    constructor(options?: any);
    open(container: HTMLElement): void;
    write(data: string): void;
    writeln(data: string): void;
    onData(callback: (data: string) => void): { dispose: () => void };
    loadAddon(addon: any): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-fit' {          
  export class FitAddon {
    fit(): void;
  }
}






