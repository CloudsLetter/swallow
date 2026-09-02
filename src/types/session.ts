/** 统一会话事件，与后端 SessionEvent 的 payload 对齐。 */
export type SessionEvent =
  | { kind: 'output'; data: string }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }
  | { kind: 'progress'; stage: string; message?: string | null };
