/// <reference types="vite/client" />

// 扩展 React CSSProperties 类型以支持 WebkitAppRegion
import 'react';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}
