// Swallow 云同步自建参考服务器（零依赖，Node.js >= 18 内置 http/https/fs）。
//
// 协议约定（与 src-tauri/src/services/cloud_sync.rs 对应）：
//   - 端点：`/{server_key}`（server_key 作为路径段，既鉴权又用于客户端派生加密密钥）
//   - 上传：POST，body 为加密后的数据包文本（`v1.{salt}.{nonce}.{cipher}`）
//   - 下载：GET，返回加密后的数据包文本
//   - 服务器不接触明文，只把密文落盘到 data/ 目录（文件名 = server_key 的 URL 安全编码）
//
// 运行：
//   node server.js                # 默认 0.0.0.0:8787
//   PORT=9000 node server.js      # 指定端口
//   HTTPS_KEY=... HTTPS_CERT=... node server.js   # 启用 HTTPS（提供 PEM 路径）
//
// 客户端在 Swallow「设置 → 云同步」里填：
//   服务器地址：http://<本机IP>:8787（或 https://...）
//   端口：8787（可留 0，服务器地址里带上端口即可）
//   服务器密钥：任意自定密钥（两端保持一致）

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');

// 数据文件名：对 server_key 做 URL 安全编码，避免路径穿越与特殊字符问题
function safeName(key) {
  return encodeURIComponent(key).replace(/%/g, '_');
}

function blobPath(key) {
  return path.join(DATA_DIR, safeName(key));
}

function readBlob(key) {
  const p = blobPath(key);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function writeBlob(key, content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(blobPath(key), content, 'utf8');
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));

  if (!key) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('missing server key');
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('payload too large');
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        writeBlob(key, body);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(e));
      }
    });
    return;
  }

  if (req.method === 'GET') {
    const blob = readBlob(key);
    if (blob === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no data');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(blob);
    return;
  }

  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('method not allowed');
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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Swallow 云同步服务器已启动：${hasTls ? 'https' : 'http'}://0.0.0.0:${PORT}`,
    );
    console.log(`密文数据目录：${DATA_DIR}`);
    console.log('注意：服务器只存密文，无法读取你的明文数据。');
  });
}

start();
