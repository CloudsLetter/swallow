/**
 * 主机指纹确认去重：初次连接同一台主机时，主终端/状态监控/文件浏览等并发连接会各自
 * 触发「主机密钥确认」。这里以 (host:port:fingerprint) 为键共享同一次确认——首个
 * 连接弹窗，其余连接直接复用其结果（点一次「信任」，三个连接全部放行；拒绝则全部拒绝）。
 */
const inflight = new Map<string, Promise<boolean>>();

export function dedupeHostKeyConfirm(
  key: string,
  show: () => Promise<boolean>,
): Promise<boolean> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = show().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}
