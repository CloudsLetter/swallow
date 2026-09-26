// Swallow 云同步自建参考服务器（零依赖，Node.js >= 18 的内置 http/https/fs/crypto）。
//
// 协议约定（与 src-tauri/src/services/cloud_sync.rs 对应）：
//
//   密文数据
//     GET    /{server_key}                 下载密文
//     HEAD   /{server_key}                 只取元信息响应头（不传 body）
//     POST   /{server_key}                 上传密文（body = `v1.{salt}.{nonce}.{cipher}`）
//     DELETE /{server_key}                 删除当前密文（先归档，仍可回滚恢复）
//
//   元信息与探活
//     GET    /{server_key}/meta            版本号 / 时间戳 / 字节数 / ETag
//     GET    /healthz                      连通性探测 → {"ok":true}（免鉴权）
//     GET    /                             服务描述与端点清单（免鉴权，便于排障）
//
//   版本历史（防「一次误同步把本地配置全冲掉」）
//     GET    /{server_key}/versions                版本列表（含当前版本）
//     GET    /{server_key}/versions/{version}      取指定版本的密文
//     POST   /{server_key}/rollback                回滚到指定版本（追加为新版本，不丢历史）
//
// 并发控制：上传可带 `If-Match: "<etag>"`（乐观锁），不匹配返回 412；
// 也可带 `If-None-Match: *` 表示「仅当云端还没有数据时才允许写」。
//
// 目录布局（DATA_DIR，默认 ./data）：
//   <blob>              当前密文（文件名 = server_key 的 URL 安全编码）
//   <blob>.meta.json    版本号与时间戳等元信息（原子写）
//   <blob>.history/     历史版本归档，文件名 = v{version}
//
// 环境变量：
//   PORT=8787               监听端口
//   HOST=0.0.0.0            监听地址（本机测试可用 127.0.0.1）
//   DATA_DIR=./data         密文目录
//   MAX_BODY_MB=50          单次上传体积上限
//   HISTORY_KEEP=20         保留的历史版本数（0 = 关闭版本历史）
//   REQUIRE_TOKEN=...       启用 Bearer 鉴权（Authorization: Bearer <token>；healthz/描述页除外）
//   RATE_LIMIT=30           每 IP 每分钟写次数上限（0 = 关闭）
//   LOG_REQUESTS=0          关闭逐请求日志（默认开启；key 只以指纹出现，不落明文）
//   HTTPS_KEY / HTTPS_CERT  启用 HTTPS 的 PEM 路径
//
// 安全提示（生产环境必读）：
//   - 默认无鉴权、无限流：仅放可信内网；公网暴露前设置 REQUIRE_TOKEN + 反向代理 + TLS。
//   - server_key 决定加密强度：用足够长且随机的密钥，丢失则云端数据无法解密。
//   - 磁盘文件名是 server_key 的编码（而非哈希）：能读取 DATA_DIR 的人可还原 key 并解密全部数据。
//     在意这一点时请在文件系统层做权限隔离。（改成哈希会导致既有部署找不到旧数据，故未默认启用。）

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = 2;

function envInt(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : fallback;
}

const PORT = envInt('PORT', 8787, 0);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_BODY = envInt('MAX_BODY_MB', 50, 1) * 1024 * 1024;
const HISTORY_KEEP = envInt('HISTORY_KEEP', 20, 0);
const RATE_LIMIT = envInt('RATE_LIMIT', 0, 0);
const REQUIRE_TOKEN = (process.env.REQUIRE_TOKEN || '').trim();
const LOG_REQUESTS = process.env.LOG_REQUESTS !== '0';

// ---------------------------------------------------------------- 路径与指纹

// 数据文件名：对 server_key 做 URL 安全编码，避免路径穿越与特殊字符问题
function safeName(key) {
  return encodeURIComponent(key).replace(/%/g, '_');
}

// 路径穿越加固：`..` / `.` 等 key 编码后仍是 `..`，必须挡住（否则会写到 DATA_DIR 之外）
function blobPath(key) {
  const full = path.resolve(DATA_DIR, safeName(key));
  if (path.dirname(full) !== DATA_DIR) {
    throw new Error('unsafe server key');
  }
  return full;
}

function metaPath(key) {
  return `${blobPath(key)}.meta.json`;
}

function historyDir(key) {
  return `${blobPath(key)}.history`;
}

function historyPath(key, version) {
  return path.join(historyDir(key), `v${version}`);
}

// 日志里只出现 key 的指纹，绝不打印 key 本身（它就是解密全部数据的凭据）
function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function etagOf(version) {
  return `"v${version}"`;
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 元信息读写

function readSidecar(key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(key), 'utf8'));
    const updatedAt = parsed.updatedAt || parsed.updated_at || null;
    return {
      version: Number(parsed.version) || 0,
      createdAt: parsed.createdAt || parsed.created_at || updatedAt,
      updatedAt,
      size: Number(parsed.size) || 0,
      deletedAt: parsed.deletedAt || null,
    };
  } catch {
    return null;
  }
}

// 当前状态：sidecar 优先，缺失时按文件系统推断（兼容没有 sidecar 的历史数据）
function currentMeta(key) {
  const sidecar = readSidecar(key);
  const stat = statOrNull(blobPath(key));
  if (!stat) {
    if (sidecar && (sidecar.version > 0 || sidecar.deletedAt)) {
      return { ...sidecar, exists: false };
    }
    return null;
  }
  const fallbackAt = stat.mtime.toISOString();
  return {
    version: sidecar && sidecar.version > 0 ? sidecar.version : 1,
    createdAt: (sidecar && sidecar.createdAt) || fallbackAt,
    updatedAt: (sidecar && sidecar.updatedAt) || fallbackAt,
    deletedAt: (sidecar && sidecar.deletedAt) || null,
    size: stat.size,
    exists: true,
  };
}

function writeSidecar(key, meta) {
  const target = metaPath(key);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta), 'utf8');
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------- 历史版本

function listHistory(key) {
  const dir = historyDir(key);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => /^v(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function versionInfo(key, version) {
  const stat = statOrNull(historyPath(key, version));
  return {
    version,
    size: stat ? stat.size : 0,
    updatedAt: stat ? stat.mtime.toISOString() : null,
    etag: etagOf(version),
  };
}

// 归档当前密文为 v{version}。复制而非移动：写入失败时现有数据不受影响。
function archiveCurrent(key, meta) {
  if (HISTORY_KEEP <= 0) return null;
  if (!meta || !meta.exists) return null;
  fs.mkdirSync(historyDir(key), { recursive: true });
  fs.copyFileSync(blobPath(key), historyPath(key, meta.version));
  return meta.version;
}

function pruneHistory(key) {
  if (HISTORY_KEEP <= 0) return;
  const versions = listHistory(key);
  const excess = versions.slice(0, Math.max(0, versions.length - HISTORY_KEEP));
  for (const version of excess) {
    fs.rmSync(historyPath(key, version), { force: true });
  }
}

// 落盘新版本：临时文件 → 归档旧版本 → 原子改名 → 写 sidecar → 裁剪历史
function writeBlob(key, content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = currentMeta(key);
  const now = new Date().toISOString();
  const next = {
    version: (current && current.version ? current.version : 0) + 1,
    createdAt: (current && current.createdAt) || now,
    updatedAt: now,
    size: Buffer.byteLength(content, 'utf8'),
    deletedAt: null,
  };

  const target = blobPath(key);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  let archived = null;
  try {
    archived = archiveCurrent(key, current);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  writeSidecar(key, next);
  pruneHistory(key);
  return { meta: next, archived, etag: etagOf(next.version) };
}

// 回滚：把历史版本 v{target} 的内容作为新版本写回（保留全部历史，不覆盖任何版本）
function rollbackTo(key, target) {
  const source = historyPath(key, target);
  if (!fs.existsSync(source)) return null;
  const content = fs.readFileSync(source, 'utf8');
  const written = writeBlob(key, content);
  return { written, rolledBackTo: target };
}

// ---------------------------------------------------------------- HTTP 小工具

function parseEtagList(header) {
  return String(header)
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''));
}

function ifMatchSatisfied(header, currentVersion) {
  if (header === undefined) return true;
  const wanted = parseEtagList(header);
  if (wanted.includes('*')) return currentVersion > 0;
  return wanted.includes(etagOf(currentVersion));
}

function ifNoneMatchHit(header, currentVersion) {
  if (header === undefined || currentVersion <= 0) return false;
  const seen = parseEtagList(header);
  return seen.includes('*') || seen.includes(etagOf(currentVersion));
}

function blobHeaders(meta) {
  return {
    'cache-control': 'no-store',
    etag: etagOf(meta.version),
    'x-blob-version': String(meta.version),
    'x-blob-size': String(meta.size),
    'x-blob-updated-at': meta.updatedAt || '',
  };
}

function logRequest(req, ctx, status, bytes) {
  if (!LOG_REQUESTS || ctx.op === 'healthz') return;
  const key = ctx.key ? `key=${fingerprint(ctx.key)}` : 'key=-';
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${ctx.op} ${key} -> ${status} ${bytes}B ${Date.now() - ctx.started}ms`,
  );
}

// 统一出口：写响应 + 记一条日志（HEAD 不写 body）
function reply(req, res, ctx, status, body, opts = {}) {
  const isText = typeof body === 'string';
  const payload = isText ? body : JSON.stringify(body);
  const headers = {
    'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(opts.headers || {}),
  };
  res.writeHead(status, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(payload);
  logRequest(req, ctx, status, Buffer.byteLength(payload, 'utf8'));
}

function readBody(req, res, ctx, onDone) {
  let body = '';
  let finished = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (finished) return;
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY) {
      finished = true;
      reply(req, res, ctx, 413, 'payload too large');
      req.destroy();
    }
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    onDone(body);
  });
  req.on('error', () => {
    finished = true;
  });
}

// ---------------------------------------------------------------- 限流与鉴权

const hits = new Map();

function rateLimited(ip) {
  if (RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const windowStart = now - 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear(); // 防内存膨胀
  return arr.length > RATE_LIMIT;
}

function checkAuth(req) {
  if (!REQUIRE_TOKEN) return true;
  return (req.headers.authorization || '') === `Bearer ${REQUIRE_TOKEN}`;
}

// ---------------------------------------------------------------- 路由处理

function handleBlob(req, res, ctx) {
  const { key } = ctx;

  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = currentMeta(key);
    if (!meta || !meta.exists) return reply(req, res, ctx, 404, 'no data');
    if (ifNoneMatchHit(req.headers['if-none-match'], meta.version)) {
      res.writeHead(304, blobHeaders(meta));
      res.end();
      logRequest(req, ctx, 304, 0);
      return;
    }
    const content = fs.readFileSync(blobPath(key), 'utf8');
    return reply(req, res, ctx, 200, content, { headers: blobHeaders(meta) });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    if (rateLimited(req.socket.remoteAddress || 'unknown')) {
      return reply(req, res, ctx, 429, 'rate limited, try later');
    }
    const current = currentMeta(key);
    const currentVersion = current && current.version ? current.version : 0;
    if (!ifMatchSatisfied(req.headers['if-match'], currentVersion)) {
      return reply(req, res, ctx, 412, {
        error: 'precondition failed',
        version: currentVersion,
        etag: etagOf(currentVersion),
      });
    }
    if (ifNoneMatchHit(req.headers['if-none-match'], currentVersion)) {
      return reply(req, res, ctx, 412, {
        error: 'already exists',
        version: currentVersion,
        etag: etagOf(currentVersion),
      });
    }
    return readBody(req, res, ctx, (body) => {
      if (!body.trim()) {
        // 空包只可能是客户端 bug；拒绝掉以免把云端数据抹成空
        return reply(req, res, ctx, 400, 'empty body');
      }
      const written = writeBlob(key, body);
      reply(req, res, ctx, 200, 'ok', {
        headers: {
          ...blobHeaders(written.meta),
          'x-blob-archived': written.archived === null ? '' : String(written.archived),
        },
      });
    });
  }

  if (req.method === 'DELETE') {
    const meta = currentMeta(key);
    if (!meta || !meta.exists) return reply(req, res, ctx, 404, 'no data');
    const archived = archiveCurrent(key, meta);
    fs.rmSync(blobPath(key), { force: true });
    writeSidecar(key, {
      version: meta.version,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      size: meta.size,
      deletedAt: new Date().toISOString(),
    });
    pruneHistory(key);
    return reply(req, res, ctx, 200, {
      ok: true,
      archived,
      version: meta.version,
      note: 'current blob deleted; history retained, rollback still works',
    });
  }

  return reply(req, res, ctx, 405, 'method not allowed');
}

function handleMeta(req, res, ctx) {
  const meta = currentMeta(ctx.key);
  if (!meta || !meta.exists) return reply(req, res, ctx, 404, 'no data');
  const versions = listHistory(ctx.key);
  return reply(req, res, ctx, 200, {
    version: meta.version,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    size: meta.size,
    etag: etagOf(meta.version),
    // 兼容当前客户端：CloudMeta 现按 snake_case 反序列化（见 docs/CLOUD_SYNC_DESIGN.md §13-8）。
    // 两种拼写同时给出，客户端补上 rename_all = "camelCase" 后无需改服务端。
    updated_at: meta.updatedAt,
    created_at: meta.createdAt,
    history: {
      count: versions.length,
      oldestVersion: versions.length ? versions[0] : null,
      newestVersion: versions.length ? versions[versions.length - 1] : null,
      limit: HISTORY_KEEP,
    },
  });
}

function handleVersionList(req, res, ctx) {
  const meta = currentMeta(ctx.key);
  const versions = [];
  if (meta && meta.exists) {
    versions.push({
      version: meta.version,
      size: meta.size,
      updatedAt: meta.updatedAt,
      etag: etagOf(meta.version),
      current: true,
    });
  }
  for (const version of listHistory(ctx.key)) {
    versions.push({ ...versionInfo(ctx.key, version), current: false });
  }
  versions.sort((a, b) => b.version - a.version);
  return reply(req, res, ctx, 200, {
    currentVersion: meta ? meta.version : 0,
    deleted: Boolean(meta && !meta.exists),
    count: versions.length,
    historyLimit: HISTORY_KEEP,
    versions,
  });
}

function handleVersionFetch(req, res, ctx, version) {
  const meta = currentMeta(ctx.key);
  if (meta && meta.exists && meta.version === version) {
    const content = fs.readFileSync(blobPath(ctx.key), 'utf8');
    return reply(req, res, ctx, 200, content, { headers: blobHeaders(meta) });
  }
  const stat = statOrNull(historyPath(ctx.key, version));
  if (!stat) {
    return reply(req, res, ctx, 404, { error: 'version not found', version });
  }
  const content = fs.readFileSync(historyPath(ctx.key, version), 'utf8');
  return reply(req, res, ctx, 200, content, {
    headers: {
      'cache-control': 'no-store',
      etag: etagOf(version),
      'x-blob-version': String(version),
      'x-blob-size': String(stat.size),
      'x-blob-updated-at': stat.mtime.toISOString(),
    },
  });
}

function handleRollback(req, res, ctx) {
  return readBody(req, res, ctx, (body) => {
    const fromQuery = ctx.url.searchParams.get('version');
    let target = Number.NaN;
    if (fromQuery !== null) target = Number(fromQuery);
    else {
      try {
        target = Number(JSON.parse(body || '{}').version);
      } catch {
        target = Number.NaN;
      }
    }
    if (!Number.isInteger(target) || target <= 0) {
      return reply(req, res, ctx, 400, { error: 'invalid version' });
    }
    const meta = currentMeta(ctx.key);
    if (meta && meta.exists && meta.version === target) {
      return reply(req, res, ctx, 200, {
        ok: true,
        noop: true,
        version: target,
        etag: etagOf(target),
      });
    }
    const result = rollbackTo(ctx.key, target);
    if (!result) {
      return reply(req, res, ctx, 404, {
        error: 'version not found',
        version: target,
        available: listHistory(ctx.key),
      });
    }
    return reply(req, res, ctx, 200, {
      ok: true,
      noop: false,
      rolledBackTo: result.rolledBackTo,
      version: result.written.meta.version,
      etag: result.written.etag,
      updatedAt: result.written.meta.updatedAt,
    });
  });
}

function serviceDescriptor() {
  return {
    service: 'swallow-cloud',
    serverVersion: SERVER_VERSION,
    time: new Date().toISOString(),
    auth: REQUIRE_TOKEN ? 'bearer' : 'none',
    historyKeep: HISTORY_KEEP,
    endpoints: [
      'GET|HEAD|POST|DELETE /{server_key}',
      'GET /{server_key}/meta',
      'GET /{server_key}/versions',
      'GET /{server_key}/versions/{version}',
      'POST /{server_key}/rollback?version=N',
      'GET /healthz',
      'GET /',
    ],
  };
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // 逐段解码：server_key 里的 `/` 是 %2F，不会被拆成路由段
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const ctx = { key: null, op: '-', started: Date.now(), url };

  if (segments.length === 0) {
    ctx.op = 'describe';
    return reply(req, res, ctx, 200, serviceDescriptor());
  }

  // 健康检查（免鉴权，供客户端「测试连接」与容器探活）
  if (segments.length === 1 && segments[0] === 'healthz' && req.method === 'GET') {
    ctx.op = 'healthz';
    return reply(req, res, ctx, 200, {
      ok: true,
      service: 'swallow-cloud',
      serverVersion: SERVER_VERSION,
      time: new Date().toISOString(),
    });
  }

  if (!checkAuth(req)) {
    ctx.op = 'auth';
    return reply(req, res, ctx, 401, 'unauthorized');
  }

  const key = segments[0];
  const rest = segments.slice(1);
  ctx.key = key;

  if (!key) {
    ctx.op = 'blob';
    return reply(req, res, ctx, 400, 'missing server key');
  }

  try {
    if (rest.length === 0) {
      ctx.op = 'blob';
      return handleBlob(req, res, ctx);
    }
    if (rest.length === 1 && rest[0] === 'meta' && req.method === 'GET') {
      ctx.op = 'meta';
      return handleMeta(req, res, ctx);
    }
    if (rest.length === 1 && rest[0] === 'versions' && req.method === 'GET') {
      ctx.op = 'versions';
      return handleVersionList(req, res, ctx);
    }
    if (rest.length === 2 && rest[0] === 'versions' && req.method === 'GET') {
      const version = Number(rest[1]);
      ctx.op = 'version';
      if (!Number.isInteger(version) || version <= 0) {
        return reply(req, res, ctx, 400, { error: 'invalid version' });
      }
      return handleVersionFetch(req, res, ctx, version);
    }
    if (rest.length === 1 && rest[0] === 'rollback' && req.method === 'POST') {
      ctx.op = 'rollback';
      return handleRollback(req, res, ctx);
    }
  } catch (e) {
    return reply(req, res, ctx, 500, String((e && e.message) || e));
  }

  ctx.op = 'unknown';
  return reply(req, res, ctx, 404, { error: 'unknown endpoint', path: url.pathname });
}

function handler(req, res) {
  try {
    route(req, res);
  } catch (e) {
    try {
      reply(req, res, { key: null, op: 'error', started: Date.now() }, 500, String((e && e.message) || e));
    } catch {
      /* 响应已发出，忽略 */
    }
  }
}

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const hasTls = process.env.HTTPS_KEY && process.env.HTTPS_CERT;
  const server = hasTls
    ? https.createServer(
        {
          key: fs.readFileSync(process.env.HTTPS_KEY),
          cert: fs.readFileSync(process.env.HTTPS_CERT),
        },
        handler,
      )
    : http.createServer(handler);

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.listen(PORT, HOST, () => {
    console.log(`Swallow 云同步服务器已启动：${hasTls ? 'https' : 'http'}://${HOST}:${PORT}`);
    console.log(`密文数据目录：${DATA_DIR}`);
    console.log(`鉴权：${REQUIRE_TOKEN ? '已启用（Bearer）' : '未启用（仅内网使用）'}`);
    console.log(`写限流：${RATE_LIMIT > 0 ? `${RATE_LIMIT} 次/分钟/IP` : '未启用'}`);
    console.log(`版本历史：${HISTORY_KEEP > 0 ? `保留最近 ${HISTORY_KEEP} 份` : '已关闭'}`);
    console.log(`单次上传上限：${Math.round(MAX_BODY / 1024 / 1024)} MB`);
    console.log('注意：服务器只存密文，无法读取你的明文数据。');
  });
}

start();
