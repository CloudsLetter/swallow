/**
 * 终端命令历史与补全候选（对标 Termius 自动补全的本地数据源）。
 *
 * 数据源两层：
 * 1. localStorage 持久化的「实际发送过的命令」（前端 onData 拦截整行，跨会话累积，
 *    同一命令去重置顶 → 高频命令自然排前），上限 400 条。
 * 2. 内置常用命令词库（ls/cd/systemctl/docker…）：新用户空历史也有底座可提示。
 *
 * 注意：无远端 shell agent，历史只来自「Swallow 里实际发出去的命令行」；
 * 其它终端/直接 ssh 的历史不可见（这是本地实现的边界）。
 */
const STORAGE_KEY = 'swallow.commandHistory.v1';
const MAX_ENTRIES = 400;

interface HistoryEntry {
  cmd: string;
  ts: number;
}

let cache: HistoryEntry[] | null = null;

function load(): HistoryEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    cache = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.cmd === 'string') : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify((cache ?? []).slice(0, MAX_ENTRIES)));
  } catch {
    // 存储满等异常静默忽略
  }
}

/** 空白压缩 + 过滤无意义行（纯标点/单字符编辑键残留等） */
function normalizeCommand(raw: string): string | null {
  const cmd = raw.replace(/\s+/g, ' ').trim();
  if (!cmd || cmd.length > 500) return null;
  // 过滤明显不是命令的输入：单字符、纯符号、vim 编辑键组合等残留
  if (cmd.length <= 1) return null;
  if (/^[^a-zA-Z0-9_/.-]+$/.test(cmd)) return null;
  return cmd;
}

/** 记录一条实际发送的命令（去重置顶）。 */
export function recordCommand(raw: string): void {
  const cmd = normalizeCommand(raw);
  if (!cmd) return;
  const list = load();
  const idx = list.findIndex((e) => e.cmd === cmd);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift({ cmd, ts: Date.now() });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  persist();
}

/** 清空命令历史（隐私：设置页可调用）。 */
export function clearCommandHistory(): void {
  cache = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/** 内置常用命令底座：无历史数据时也有提示（前缀升序）。 */
const COMMON_COMMANDS = [
  'ls', 'ls -la', 'cd', 'cd ..', 'pwd', 'clear', 'history',
  'cat', 'tail', 'tail -f', 'less', 'head', 'grep', 'find', 'which',
  'vim', 'nano',
  'whoami', 'uptime', 'uname -a', 'df -h', 'free -h', 'top', 'htop', 'ps aux',
  'sudo', 'sudo -i', 'mkdir', 'rm', 'rm -rf', 'mv', 'cp', 'chmod', 'chown',
  'tar', 'unzip', 'zip', 'curl', 'wget', 'ping', 'traceroute', 'netstat -tulpn',
  'ss -tulpn', 'ip a', 'ifconfig', 'systemctl', 'systemctl status', 'systemctl restart',
  'journalctl -xe', 'docker ps', 'docker logs', 'docker-compose up -d',
  'git', 'git status', 'git log --oneline', 'git pull', 'git push', 'git commit -m',
  'npm', 'npm install', 'npm run dev', 'pnpm', 'pnpm install', 'yarn', 'node', 'python3',
  'make', 'apt update', 'apt install', 'yum update', 'export', 'source', 'echo', 'man',
  'scp', 'ssh', 'rsync',
].sort();

/**
 * 前缀匹配候选：本地历史（最近使用序）+ 静态词库兜底，去重，最多 limit 条。
 * prefix 内部空白压缩、去尾空格——支持「systemctl rest」→「systemctl restart」这类
 * 跨词匹配（压缩空白后整串前缀比较）。
 */
export function suggestCommands(rawPrefix: string, limit = 8): string[] {
  const prefix = rawPrefix.replace(/\s+/g, ' ').trimEnd();
  if (prefix.length < 2) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (cmd: string) => {
    const c = cmd.trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  for (const entry of load()) {
    if (entry.cmd.startsWith(prefix)) push(entry.cmd);
  }
  for (const cmd of COMMON_COMMANDS) {
    if (cmd.startsWith(prefix)) push(cmd);
  }
  return out.slice(0, limit);
}
