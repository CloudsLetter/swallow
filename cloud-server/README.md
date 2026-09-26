# Swallow 云同步自建参考服务器

零依赖的 Node.js 服务器（只需 Node >= 18 内置模块），配合 Swallow 客户端的「设置 → 云同步」使用。

服务器**只存密文**，不接触任何明文数据。

> 本文是**使用与部署**说明。想了解内部实现（端点逐条契约、存储与原子写、ETag 语义、安全缺口清单、运维与排障）请看 [`docs/CLOUD_SERVER_IMPLEMENTATION.md`](../docs/CLOUD_SERVER_IMPLEMENTATION.md)；客户端侧协议与后续路线（成员制空间 §16、身份体系 §17）看 [`docs/CLOUD_SYNC_DESIGN.md`](../docs/CLOUD_SYNC_DESIGN.md)。

## 协议

| 方法 | 端点 | 说明 |
| ---- | ---- | ---- |
| GET | `/{server_key}` | 下载当前密文；带 `If-None-Match` 命中时返回 `304` |
| HEAD | `/{server_key}` | 只取元信息响应头，不传 body |
| POST / PUT | `/{server_key}` | 上传密文（body 为 `v1.{salt}.{nonce}.{cipher}`） |
| DELETE | `/{server_key}` | 删除当前密文（**先归档**，仍可通过回滚恢复） |
| GET | `/{server_key}/meta` | 版本号 / 时间戳 / 字节数 / ETag / 历史概况 |
| GET | `/{server_key}/versions` | 版本列表（含当前版本，按版本号倒序） |
| GET | `/{server_key}/versions/{version}` | 取指定版本的密文 |
| POST | `/{server_key}/rollback?version=N` | 回滚到指定版本（**追加为新版本**，不丢历史） |
| GET | `/healthz` | 连通性探测 → `{"ok":true}`（免鉴权） |
| GET | `/` | 服务描述与端点清单（免鉴权，便于排障） |

- `server_key` 既是鉴权标识，也是客户端派生 AES-256-GCM 加密密钥的来源。
- 返回头含 `etag: "v{n}"`、`x-blob-version`、`x-blob-size`、`x-blob-updated-at`。
- **并发控制（乐观锁）**：上传可带 `If-Match: "v{n}"`，不匹配返回 `412`；也可带 `If-None-Match: *` 表示「仅当云端还没有数据时才允许写」。
- 密文按 `server_key` 落到 `data/` 目录，一个 key 一份数据。文件名是 key 的 URL 安全编码，`/` 等特殊字符会被编码（不参与路由分段）。

### 目录布局

```
data/
  <blob>                 当前密文
  <blob>.meta.json       版本号 / 时间戳 / 字节数（原子写）
  <blob>.history/v{n}    历史版本归档
```

没有 `.meta.json` 的**老数据会自动降级兼容**：视为 `version = 1`，时间戳取 mtime，下次上传时正常归档。

## 运行

```bash
node server.cjs                 # 默认 http://0.0.0.0:8787
HOST=127.0.0.1 node server.cjs  # 只监听本机

# 启用 HTTPS（需提供 PEM 证书与私钥路径）
HTTPS_KEY=/path/to/key.pem HTTPS_CERT=/path/to/cert.pem node server.cjs
```

### 环境变量

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 密文目录 |
| `MAX_BODY_MB` | `50` | 单次上传体积上限 |
| `HISTORY_KEEP` | `20` | 保留的历史版本数（`0` = 关闭版本历史） |
| `REQUIRE_TOKEN` | 空 | 启用 Bearer 鉴权；`healthz` 与描述页除外 |
| `RATE_LIMIT` | `0` | 每 IP 每分钟写次数上限（`0` = 关闭） |
| `LOG_REQUESTS` | 开 | 设为 `0` 关闭逐请求日志 |
| `HTTPS_KEY` / `HTTPS_CERT` | 空 | 同时提供时启用 HTTPS |

日志里 **key 只以 SHA-256 前 8 位指纹出现**，不落明文。

## 客户端配置

在 Swallow「设置 → 云同步」：

1. 启用云同步
2. 服务器地址：`http://<服务器IP>:8787`（本机测试可用 `http://127.0.0.1:8787`）
3. 端口：可填 `8787`，或填 `0` 并在服务器地址里带上端口
4. 服务器密钥：任意自定密钥（多台设备用同一个 key 才能互相解密）
5. 勾选要同步的内容，选择同步策略
6. 点「立即同步」上传，或在另一台设备点「从云端恢复」

> 客户端目前只用 GET / POST 两个端点，`/meta` 与 `/healthz` 仅用于「测试连接」。
> 版本历史与回滚已可用（curl 或后续 UI），但**尚未接入客户端界面**。

## 安全提示

- **默认无鉴权、无限流**，仅适合可信内网。公网暴露前请至少设置 `REQUIRE_TOKEN`，并加反向代理 + TLS。
- `server_key` 决定加密强度：请使用足够长且随机的密钥，并妥善保管（**丢失无法解密云端数据**）。
- ⚠️ 磁盘上的文件名是 `server_key` 的编码而非哈希——**能读取 `DATA_DIR` 的人可以还原 key 并解密全部数据**。在意这一点时请在文件系统层做权限隔离。（改成哈希会导致既有部署找不到旧数据，故未默认启用。）
- 服务器上的历史版本同样是密文，回滚不会产生明文中间态。
