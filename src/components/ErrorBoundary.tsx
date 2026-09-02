import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}
interface State {
  hasError: boolean;
}

/** 渲染错误边界：子树渲染抛错时显示 fallback 而非让整棵 React 树白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      console.error('[ErrorBoundary]', error, info);
    } catch {
      /* 兜底：连 console 都不可用时静默 */
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
