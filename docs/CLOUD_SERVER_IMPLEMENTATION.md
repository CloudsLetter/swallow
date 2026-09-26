# Swallow 云同步服务端实现技术文档

> 对象：`cloud-server/server.cjs`——Swallow 云同步的**自建参考服务器**。
>
> 本文档是**实现对照说明**（读代码用），不是使用手册。使用与部署请看 [`cloud-server/README.md`](../cloud-server/README.md)；客户端侧的详细设计与后续路线（§16 成员制空间规格、§17 身份体系）看 [`docs/CLOUD_SYNC_DESIGN.md`](./CLOUD_SYNC_DESIGN.md)。
>
> 文档版本：v1.0（对应服务端 `SERVER_VERSION = 2`，665 行）
> 更新时间：2026-09-17
> 运行环境：Node.js ≥ 18，**零第三方依赖**（只用 `http`/`https`/`fs`/`path`/`crypto`）

---

## 1. 定位与边界

### 1.1 它是什么

一个**盲存储**：只按 `server_key` 寻址、原样收发明文字符串（内容是客户端加密后的密文），并提供版本历史与条件请求。

| 属性 | 值 |
| --- | --- |
| 职责 | 按 key 存一份 blob + 元信息 + 历史版本 |
| 密码学参与度 | **零**。不派生密钥、不解密、不校验密文格式 |
| 信任假设 | 服务器可能被入侵/拖库 → 因此它手上只有密文 |
| 体积 | 665 行，单文件，零依赖 |

### 1.2 它不是什么

- **不是生产级中间件**：默认无鉴权、无限流、无 TLS；这些是开关而非默认。
- **不是账号系统**：服务器不认识「用户」，`server_key` 既是寻址段也是（弱）凭据。成员制与身份体系分别是 `CLOUD_SYNC_DESIGN.md` 的 §16、§17（**均未实现**）。
- **不做内容校验**：不检查密文格式（`v1.{salt}.{nonce}.{cipher}`），也不验证 GCM tag——那是客户端的事。

### 1.3 不变量（改代码时必须守住）

1. **永不解析 blob 内容**——不 trim、不 JSON.parse、不 base64 解码，字节原样进出。
2. **永不存储任何可解密材料**——没有密钥、没有口令、没有「用户密码哈希」。
3. **日志不出现 `server_key` 明文**——只出现 SHA-256 前 8 位指纹（`fingerprint()`，:99）。
4. **路径由 `safeName()` 编码 + `blobPath()` 校验后**才能落到文件系统（:73–84）。

---

## 2. 代码结构

单文件按「基础设施 → 领域逻辑 → HTTP → 路由 → 启动」排列，段落之间用 `// ----` 分隔。

| 行号 | 段落 | 职责 |
| --- | --- | --- |
| 1–44 | 文件头注释 | 协议约定、目录布局、环境变量、安全提示（**改行为先改这里**） |
| 46–68 | 依赖与配置 | 5 个内置模块 + `envInt()` 解析环境变量 |
| 70–113 | 路径与指纹 | `safeName` / `blobPath` / `metaPath` / `historyDir` / `historyPath` / `fingerprint` / `etagOf` / `statOrNull` |
| 115–159 | 元信息读写 | `readSidecar` / `currentMeta` / `writeSidecar`（原子写） |
| 161–238 | 历史版本 | `listHistory` / `versionInfo` / `archiveCurrent` / `pruneHistory` / `writeBlob` / `rollbackTo` |
| 240–315 | HTTP 小工具 | 条件请求解析、响应头、日志、统一出口 `reply()`、`readBody()` |
| 317–335 | 限流与鉴权 | `hits` Map / `rateLimited` / `checkAuth` |
| 337–412 | `handleBlob` | GET/HEAD/POST/PUT/DELETE 五分支 |
| 414–435 | `handleMeta` | 元信息 + 历史概况 |
| 437–460 | `handleVersionList` | 版本列表 |
| 462–482 | `handleVersionFetch` | 取指定版本 |
| 484–525 | `handleRollback` | 回滚（追加语义） |
| 527–544 | `serviceDescriptor` | `GET /` 的响应体 |
| 546–634 | `route` / `handler` | 逐段解码 → 分派；最外层 catch 兜 500 |
| 636–663 | `start` | 建目录 → 选 http/https → 设超时 → listen + 启动横幅 |

---

## 3. 配置项

全部通过环境变量，解析集中在 `envInt(name, fallback, min)`（:54）：非有限数回落默认值，否则 `Math.max(min, trunc)` 做下限钳制。

| 变量 | 默认 | 钳制 | 语义 | 实现要点 |
| --- | --- | --- | --- | --- |
| `PORT` | `8787` | ≥0 | 监听端口 | — |
| `HOST` | `0.0.0.0` | — | 监听地址 | 本机测试用 `127.0.0.1` |
| `DATA_DIR` | `./data` | — | 密文根目录 | `path.resolve` 归一化（:63） |
| `MAX_BODY_MB` | `50` | ≥1 | 单次上传上限 | 乘 1024² 后存为 `MAX_BODY` |
| `HISTORY_KEEP` | `20` | ≥0 | 历史保留份数 | `0` = 关闭归档与裁剪 |
| `RATE_LIMIT` | `0` | ≥0 | 每 IP 每分钟**写**次数 | `0` = 关闭；只作用于 POST/PUT |
| `REQUIRE_TOKEN` | 空 | — | 启用 Bearer 鉴权 | `.trim()` 后判空 |
| `LOG_REQUESTS` | 开 | — | 逐请求日志 | 判据是 `!== '0'`，**只有显式设 0 才关** |
| `HTTPS_KEY` / `HTTPS_CERT` | 空 | — | TLS | 两者**同时**提供才启用（:639） |

---

## 4. 存储模型

### 4.1 目录布局

```
DATA_DIR/
  <blob>                当前密文，文件名 = safeName(server_key)
  <blob>.meta.json      sidecar：版本号 / 时间戳 / 字节数 / deletedAt
  <blob>.history/
    v1 ... vN           历史归档，内容为当时的密文
```

### 4.2 元信息：sidecar 优先，文件系统兜底

`currentMeta(key)`（:134）是**唯一的元信息真源**，两条路径：

| 情况 | 结果 |
| --- | --- |
| blob 存在 + sidecar 存在 | `version` 取 sidecar；`createdAt`/`updatedAt` 缺失时回落 mtime；`size` 一律取**真实 `stat().size`** |
| blob 存在 + **无 sidecar**（历史数据） | 视为 `version = 1`，时间取 `mtime` |
| blob 不存在 + sidecar 有 `version>0` 或 `deletedAt` | 返回 `{ ...sidecar, exists: false }`——**用于 DELETE 后保留版本号连续** |
| blob 不存在 + sidecar 也无意义 | 返回 `null`（当作「无数据」→ 404） |

⚠️ 这条降级路径是**兼容 2026-09 之前无 sidecar 的老数据**的关键（冒烟测试第 33–36 项专门覆盖）：老文件能被正常读出、能被后续写入归档，版本从 1 递增。

### 4.3 写入顺序与原子性

`writeBlob(key, content)`（:203）的顺序是刻意的：

```
1. mkdir DATA_DIR
2. 写临时文件  <blob>.tmp-{pid}-{ts}
3. archiveCurrent()   ← 把「当前版本」copy 进 history
4. renameSync(tmp → <blob>)   ← 原子替换
5. writeSidecar()     ← 同样是 tmp + rename
6. pruneHistory()
```

- 失败时（3/4 抛错）删除临时文件并**原样抛出**，当前数据不受影响。
- 归档用 `copyFileSync` 而非 `rename`：**复制失败时现有数据完好**（:184 注释）。
- ⚠️ **已知的弱一致性窗口**：blob 与 sidecar 是**两次**独立原子操作，不是一个事务。若在第 4 步与第 5 步之间进程崩溃，磁盘上会是「新 blob + 旧 sidecar」——此时 `version` 落后一代，而 `size` 因为取自 `stat` 是对的。下一次写入会算出重复的版本号并覆盖同名归档。**目前不做补偿**；要根治需要把 sidecar 内容并入 blob（或引入 WAL），代价大于收益。

### 4.4 版本号推进规则

| 操作 | 版本变化 |
| --- | --- |
| 首次写入 | `0 → 1` |
| 普通上传 | `+1`，旧版本归档为 `v{旧版本}` |
| DELETE | **不变**，sidecar 记 `deletedAt` |
| DELETE 后再上传 | `+1`（承接 sidecar 的版本号，不重置） |
| 回滚到 `vN` | `+1`（新版本内容 = `vN` 的内容） |

---

## 5. 寻址与路径加固

```js
safeName(key)  = encodeURIComponent(key).replace(/%/g, '_')     // :73
blobPath(key)  = path.resolve(DATA_DIR, safeName(key))          // :78
                 ↑ 且必须满足 path.dirname(full) === DATA_DIR，否则抛 unsafe server key
```

为什么这样组合：

- `encodeURIComponent` 把 `/`、`..`、空格、控制字符等全部转义，得到**单段安全文件名**；
- 再把残留的 `%` 换成 `_`，避免「名字里带 `%` 被下游二次解码」这类问题；
- `blobPath` 再做一次 `dirname` 校验兜底——**双保险**，任一处被绕过都不会写出 `DATA_DIR`。

路由侧配合：`route()` 先按 `/` 切段、**逐段 `decodeURIComponent`**（:552），所以 `server_key` 里的 `/` 以 `%2F` 形式出现、不会被误当作路由分段。冒烟测试用 `//..`、`%2E%2E`、`team%2Falpha` 验证过：都不会写出目录外（`team/alpha` 落成单文件 `team_2Falpha`）。

⚠️ **反过来说**：文件名是 `server_key` 的**可逆编码**而非哈希。所以**能读 `DATA_DIR` 的人可以还原出 key，进而解密全部数据与全部历史版本**。改成哈希会破坏既有部署的向后兼容（旧文件找不到），故未默认启用——在意这一点请在文件系统层做权限隔离。（与 `CLOUD_SYNC_DESIGN.md` §11.4 同一结论。）

日志侧：`fingerprint(key)` = `sha256(key)` 前 8 位十六进制（:99），**只用于日志**，不足以反推 key。

---

## 6. 端点契约

`GET /healthz` 与 `GET /` **在鉴权之前**处理（免鉴权，供「测试连接」与容器探活）；其余全部经过 `checkAuth()`，因此**默认（未设 `REQUIRE_TOKEN`）时全部开放**。

### 6.1 `GET /`

服务描述与端点清单（`serviceDescriptor()`，:527）。响应：

```json
{
  "service": "swallow-cloud",
  "serverVersion": 2,
  "time": "2026-09-17T…Z",
  "auth": "none" | "bearer",
  "historyKeep": 20,
  "endpoints": ["GET|HEAD|POST|DELETE /{server_key}", "GET /{server_key}/meta", "…"]
}
```

用途是排障：一眼看到版本、鉴权模式、历史上限与支持的方法。

### 6.2 `GET /healthz`

```json
{ "ok": true, "service": "swallow-cloud", "serverVersion": 2, "time": "…" }
```

同时供客户端 `cloud_test_connection` 与容器 liveness 探针使用。⚠️ 该端点**不记日志**（`logRequest` 里显式跳过，:272），避免探针刷屏。

### 6.3 `/{server_key}` —— blob 本体

| 方法 | 前置条件 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET` | 有数据 | `200` + 密文文本 | `404 no data` |
| `GET` | `If-None-Match` 命中 | **`304`**（无 body，带 blob 头） | — |
| `HEAD` | 同 GET | `200` + 头、**无 body** | `404` |
| `POST` / `PUT` | 通过条件检查、body 非空 | `200 "ok"` + blob 头 + `x-blob-archived` | `400` / `412` / `413` / `429` |
| `DELETE` | 有数据 | `200 { ok, archived, version, note }` | `404` |
| 其他方法 | — | — | `405 method not allowed` |

**写路径的三道闸门**（顺序固定，:355–374）：

1. `rateLimited(remoteAddress)` → `429`
2. `If-Match` 不满足 → `412 { error:"precondition failed", version, etag }`
3. `If-None-Match` 命中（即云端已有数据）→ `412 { error:"already exists", version, etag }`
4. body 为空或全空白 → `400 empty body`

第 4 条的注释写明了动机：空包只可能是客户端 bug，**拒绝掉以免把云端数据抹成空**。

响应头由 `blobHeaders(meta)`（:261）统一给出：

```
etag: "v3"
x-blob-version: 3
x-blob-size: 12345
x-blob-updated-at: 2026-09-17T…Z
cache-control: no-store
```

写入成功另带 `x-blob-archived`：本次归档的旧版本号（未归档时为空串）。

### 6.4 `GET /{server_key}/meta`

```json
{
  "version": 3, "createdAt": "…", "updatedAt": "…", "size": 12345,
  "etag": "\"v3\"",
  "updated_at": "…", "created_at": "…",
  "history": { "count": 4, "oldestVersion": 1, "newestVersion": 4, "limit": 20 }
}
```

⚠️ **`updatedAt` 与 `updated_at` 双拼写是刻意为之**：客户端 `CloudMeta` 结构体目前缺 `#[serde(rename_all = "camelCase")]`，会按 snake_case 反序列化。两边同时给，使客户端的命名修正可以**独立进行、无需服务端配合**。（`CLOUD_SYNC_DESIGN.md` §13-8）

### 6.5 `GET /{server_key}/versions`

```json
{
  "currentVersion": 3,
  "deleted": false,
  "count": 4,
  "historyLimit": 20,
  "versions": [
    { "version": 3, "size": 12345, "updatedAt": "…", "etag": "\"v3\"", "current": true },
    { "version": 2, "size": 11000, "updatedAt": "…", "etag": "\"v2\"", "current": false }
  ]
}
```

当前版本排在最前，其余按版本号**倒序**。若 blob 已被 DELETE，`currentVersion` 保留最后版本号、`deleted` 为 `true`，列表里全部为历史项。

### 6.6 `GET /{server_key}/versions/{n}`

- `n` 非正整数 → `400 { error:"invalid version" }`
- `n` 等于当前版本 → 直接读当前 blob
- 否则读 `history/v{n}`；不存在 → `404 { error:"version not found", version }`
- 成功返回**密文原文**（`text/plain`），头带该版本的 `size` / `mtime`

### 6.7 `POST /{server_key}/rollback`

目标版本从**查询参数** `?version=N` 取；没有则尝试从 JSON body 的 `version` 字段取（:486–495）。

| 情况 | 响应 |
| --- | --- |
| 目标 == 当前版本 | `200 { ok:true, noop:true, version, etag }` |
| 目标在历史中 | `200 { ok:true, noop:false, rolledBackTo, version, etag, updatedAt }` |
| 目标不在历史中 | `404 { error:"version not found", version, available:[…] }` |
| 版本号非法 | `400 { error:"invalid version" }` |

⚠️ **回滚是「追加」不是「倒带」**：它把 `vN` 的内容作为**新版本**写入（走同一套 `writeBlob`），因此**历史只增不减**。这是有意设计——否则回滚本身不可逆。

---

## 7. 条件请求与并发

### 7.1 ETag 语义

- ETag 就是版本号：`etagOf(v) = "v{n}"`（:103），强 ETag 形式（带引号）。
- `parseEtagList`（:242）支持逗号分隔列表，并剥掉弱 ETag 前缀 `W/`。

| 请求头 | 判定函数 | 语义 | 失败响应 |
| --- | --- | --- | --- |
| `If-Match` | `ifMatchSatisfied`（:248） | 未提供 → 放行；`*` → 要求云端已有数据；否则要求列表含当前 etag | `412 precondition failed` |
| `If-None-Match`（写） | `ifNoneMatchHit`（:255） | 未提供或云端无数据 → 放行；`*` 或含当前 etag → 拒绝 | `412 already exists` |
| `If-None-Match`（读） | 同上 | 命中 → 不传 body | `304 Not Modified` |

### 7.2 这套机制能防什么、不能防什么

- ✅ **能防**：客户端基于**过期版本**的盲覆盖。典型场景是「A 设备下载后、B 设备已上传，A 又原样覆盖回去」。带上 `If-Match: "<etag>"` 即可让 A 拿到 412 并重新合并。
- ✅ **能防**：首写竞态（`If-None-Match: *`）。
- ❌ **不能防**：同一版本号下的**内容替换**（换包攻击）。因为 ETag 是版本号而非内容哈希——攻击者若能写同一个 key，可以把内容换成别的东西而版本号照旧。GCM 认证仍能保证「换进去的东西解不出有效明文」，但客户端拿不到「内容被动过」的信号。要根治得把 ETag 改成密文哈希。（`CLOUD_SYNC_DESIGN.md` §2.3 同一结论）

### 7.3 并发模型

**单进程、无锁、同步文件 I/O**。风险点：

- Node 单线程 + 同步 `fs` 意味着**同一个 key 的两个并发写会被串行化**，但它们各自的「读当前版本 → 决定新版本号 → rename」不是原子的，仍可能出现**同名归档互相覆盖**（两个请求都读到 `version=3`，都写 `v4`）。
- 目前**没有** per-key 互斥。要根治需要引入 `Map<key, Promise>` 队列或改用文件锁。
- `RATE_LIMIT` 与历史裁剪都是尽力而为，不构成一致性保证。

---

## 8. 鉴权与限流

### 8.1 `checkAuth`（:332）

```js
if (!REQUIRE_TOKEN) return true;
return req.headers.authorization === `Bearer ${REQUIRE_TOKEN}`;
```

- **部署级**单一口令，不是成员级身份。与加密**正交**：token 决定「能不能读写」，`server_key` 决定「能不能解密」。
- 放行顺序保证 `healthz` 与 `GET /` 永不被 401 挡住。
- 401 时 `ctx.key` 仍为 `null`（key 在鉴权之后才赋值，:584），所以**未授权请求的日志不会出现 key 指纹**。

⚠️ 与后续路线的关系：`CLOUD_SYNC_DESIGN.md` §16 的 `memberToken` 是**成员级**鉴权（配合角色判定），与本项的部署级口令是两层，届时需并存而非替换。

### 8.2 `rateLimited`（:321）

滑动窗口实现：`Map<ip, number[]>` 存时间戳，每次过滤掉 60 秒前的记录再追加当前时间，超过阈值即拒。

- ⚠️ **只作用于写**（POST/PUT），读与 DELETE 不受限。
- ⚠️ **计数的是「尝试」而非「成功」**——被 412 拒掉的请求同样计入。
- ⚠️ **单进程内存态**：重启即清零；多实例部署时每个实例各算一份，限制失效。
- `hits.size > 10_000` 时**整体 `clear()`**（:328），粗放但避免了内存膨胀。
- ⚠️ **反代后面的坑**：取的是 `req.socket.remoteAddress`，**不读 `X-Forwarded-For`**。若前面挂了反向代理，所有请求都来自代理 IP，于是限流变成「全局限流」——正常用户会被误伤。生产部署要么在反代层做限流，要么改代码支持可信代理头。

---

## 9. HTTP 层细节

### 9.1 `reply()` —— 统一出口（:280）

- body 为 `string` → `text/plain; charset=utf-8`；否则 `JSON.stringify` + `application/json; charset=utf-8`。
- 一律 `cache-control: no-store`（`opts.headers` 可覆盖）。
- **`HEAD` 请求只写头、不写 body**（:289）。
- 出口处统一记一条访问日志，字节数按 UTF-8 实际长度算。

### 9.2 `readBody()` —— 边收边限（:294）

不用「收完再判长度」，而是在 `data` 事件里累计并检查 `MAX_BODY`：超限立即 `413` + `req.destroy()`，并用 `finished` 标志阻止后续 `end` 回调触发业务逻辑。这对**慢速大包**（slowloris 式）也是有效的。

### 9.3 访问日志格式（:271）

```
[2026-09-17T09:37:04.841Z] GET version key=c48a01f4 -> 404 42B 1ms
                            ↑op   ↑key 指纹    ↑状态 ↑字节 ↑耗时
```

- `op` 取值：`describe` / `healthz` / `auth` / `blob` / `meta` / `versions` / `version` / `rollback` / `unknown` / `error`。
- **不记 `healthz`**；`key` 只出指纹。
- 因为记了 `op`，可以直接 `grep '412'` 观察并发冲突、`grep '429'` 观察限流触发。

### 9.4 超时（:650）

```
server.requestTimeout  = 30_000   整请求
server.headersTimeout  = 10_000   收头
server.keepAliveTimeout = 5_000   连接复用
```

⚠️ 与客户端 `reqwest` 的 30s 超时是同一量级——若客户端上传大包且网络慢，可能撞上服务端 `requestTimeout`。数据量增大时应同步上调（或改用流式落盘）。

### 9.5 方法/路由未匹配

- 方法不在 `handleBlob` 支持集内 → `405`。
- 子路径不认识（如 `POST /{key}/meta`、`GET /{key}/nope`）→ `404 { error:"unknown endpoint", path }`。

⚠️ 一处不一致：`/meta` 只接受 `GET`，其他方法会落到 `404` 而非 `405`。对客户端无影响，但若将来做 OpenAPI 描述需注意。

---

## 10. 安全模型

### 10.1 零知识边界

| 服务器**能**知道 | 服务器**不能**知道 |
| --- | --- |
| 有多少个 key（及其指纹）、各自大小与版本号 | 主机、账号、密码、私钥、配置的任何内容 |
| 上传 / 下载的时间与频率 | 条目数量、分组、标签、会话内容 |
| 启用鉴权时：有人拿到了部署口令 | `server_key` 本身（它只在 URL 里出现，服务端不落盘） |
| 历史保留了几份 | 密文的明文含义 |

### 10.2 缺口清单

| # | 缺口 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | 文件名是 key 的**可逆编码** | 读 `DATA_DIR` 即可还原 key → 解密全部数据与历史 | 文件系统权限隔离；或改哈希（破坏兼容，需迁移脚本） |
| 2 | ETag 是版本号、**非内容哈希** | 防不了同版本号下的换包 | 改为密文哈希（需客户端一起改） |
| 3 | 无 per-key 写互斥 | 并发上传可能撞同名归档 | per-key 队列或文件锁 |
| 4 | blob 与 sidecar **非同一事务** | 崩溃窗口内 version 与内容不自洽 | 并入 blob 或 WAL |
| 5 | 限流按 IP、不读 `X-Forwarded-For` | 反代后退化为全局限流 | 支持可信代理头，或在反代层限流 |
| 6 | 限流/计数为**单进程内存态** | 多实例部署失效 | 外置或反代层 |
| 7 | `GET /` 免鉴权并披露版本/鉴权模式/历史上限 | 轻度信息泄露 | 可接受（排障价值更高）；介意则加鉴权 |
| 8 | 无成员、角色、邀请、撤销 | 无法安全地多人协作 | 见 `CLOUD_SYNC_DESIGN.md` §16 |
| 9 | 无身份概念 | 多空间登录需各配一份凭据 | 见 §17 |
| 10 | 无操作审计（谁在何时改了哪份） | 出事无法追责 | 与成员制一起做（届时「谁」才有意义） |

---

## 11. 运维

### 11.1 启动横幅

启动时打印一行一条的配置摘要（:655–661），**先看这个再排障**：

```
Swallow 云同步服务器已启动：http://127.0.0.1:8787
密文数据目录：/srv/swallow/data
鉴权：已启用（Bearer）
写限流：30 次/分钟/IP
版本历史：保留最近 20 份
单次上传上限：50 MB
注意：服务器只存密文，无法读取你的明文数据。
```

### 11.2 备份与迁移

- **备份**：直接复制 `DATA_DIR` 整个目录。⚠️ 必须**连 `.meta.json` 与 `.history/` 一起复制**——只复制 blob 会丢版本号（会降级成 `version = 1`）与全部历史。
- **迁移**：停服 → 复制目录 → 起服；无状态、无数据库、无需迁移脚本。
- **冷备份安全性**：备份里只有密文。但注意缺口 #1——**拿到目录就等于拿到 key**。

### 11.3 容量估算

```
磁盘 ≈ Σ(每个 key 的当前 blob) + Σ(每个 key 的 HISTORY_KEEP × 平均包大小)
```

包是 JSON 快照，压缩前典型几十 KB 到几 MB。`HISTORY_KEEP = 20` 意味着**历史可能占到 20 倍**。这符合版本历史的用途，但值得在部署时明确——不需要这么多历史就把它调小，或直接设 `0` 关闭（同时会关闭 DELETE 的可恢复性）。

### 11.4 排障路径

1. `GET /` → 确认版本、鉴权模式、历史上限。
2. `GET /healthz` → 确认服务活着（且此请求不刷日志）。
3. 看访问日志的 `op` 与状态码：
   - `412` 密集 → 多设备并发写，客户端应带 `If-Match` 并实现合并重试；
   - `429` → 限流触发（若挂了反代，见缺口 #5）；
   - `401` → 客户端 token 与服务端 `REQUIRE_TOKEN` 不一致；
   - `400 empty body` → 客户端在生成空包，应查客户端收集逻辑。
4. `GET /{key}/meta` → 版本与历史概况；`GET /{key}/versions` → 逐版本。
5. 误覆盖 → `POST /{key}/rollback?version=N` 回滚。

### 11.5 反向代理注意

- `server_key` 里的 `/` 以 `%2F` 出现，反代**必须保留原样的 `%2F`**（不要解码后再转发）。测试时留意 `--path-as-is` 语义。
- 若开启 `REQUIRE_TOKEN`，记得允许 `Authorization` 头透传。
- 限流相关问题见缺口 #5。

---

## 12. 测试现状

### 12.1 已做（人工冒烟，38 项 curl）

用两个实例覆盖（基础实例 + 鉴权/限流实例），双花括号与路径穿越另测。覆盖清单：

| 组 | 用例 |
| --- | --- |
| 探活 | `GET /`、`GET /healthz` → 200 |
| 基本读写 | 空库 `meta` → 404；上传 → 下载；字节一致；`HEAD` 只回头 |
| 版本 | 第二次上传归档 v1、版本递增；`meta` 双拼写；`versions` 列表；取 v1 → 200；取 v99 → 404 |
| 条件请求 | `If-Match` 过期 → 412 / 正确 → 200；`If-None-Match: *` 已有数据 → 412；`If-None-Match` 命中 → 304 |
| 输入校验 | 空 body → 400；非法版本号 → 400；未知端点 → 404；不支持的方法 → 405 |
| 回滚 | 回滚到 v1 → 内容恢复；回滚到当前版本 → noop；回滚到不存在版本 → 404 |
| 删除 | DELETE → 200；之后 GET → 404；**但回滚仍成功**（软删除语义） |
| 鉴权 | 无 token → 401；带 token → 200；`healthz` 免鉴权 |
| 限流 | 阈值 3 时第 4 次写 → 429 |
| 历史裁剪 | `HISTORY_KEEP=2` 时 `.history/` 只剩 v1、v2 |
| 老数据降级 | 手工造无 sidecar 的文件 → `meta` 显示 version=1 + mtime；可继续上传并正常归档 |
| 路径加固 | `//..`、`%2E%2E`、`team%2Falpha` 均未写出 `DATA_DIR` |

### 12.2 缺口（重要）

⚠️ **没有任何自动化测试**：`cloud-server/` 下无 test 脚本、未接入 CI。上述 38 项**只能靠人工重跑**，任何改动都可能悄悄回归。

**建议补法**：服务端零依赖，用 Node 内置 `node:test` + 全局 `fetch`（Node ≥ 18）即可覆盖上述全部场景，不需要任何测试框架：

```js
// 骨架：起一个独立实例 + 独立 DATA_DIR，跑断言，最后关掉
const { spawn } = require('node:child_process');
// PORT=0 → 由内核分配端口；或固定一个高位端口 + 独立 DATA_DIR 隔离
```

补测时优先覆盖**容易回归且后果严重**的三项：`DELETE` 后可回滚、`HISTORY_KEEP=0` 时回滚应返回 404、老数据（无 sidecar）降级读取。

---

## 13. 变更记录

### v2（2026-09-17）

从 119 行两端点扩到 665 行。新增：

| 类别 | 内容 |
| --- | --- |
| 补缺口 | `GET /healthz`、`GET /{key}/meta`（双拼写）、`GET /` 服务描述 |
| 版本历史 | `versions` 列表 / 取版本 / `rollback`；上传前归档；`HISTORY_KEEP` 裁剪 |
| 并发 | `ETag` + `If-Match` / `If-None-Match`；读路径 `304` |
| 方法 | `HEAD`、`DELETE`（软删除，可回滚） |
| 运维 | `REQUIRE_TOKEN`、`RATE_LIMIT`、`LOG_REQUESTS`、`MAX_BODY_MB`、启动横幅、请求超时 |
| 加固 | `safeName` + `blobPath` 双重穿越防护、`writeSidecar` 原子写、空 body 拒绝、日志只记 key 指纹 |

**为什么加版本历史**：客户端现有的三个同步方向里有两个是**覆盖型**（`download` 覆盖本地；`bidirectional` 的 settings 段整段互覆），而全量快照的最大风险就是「一次误同步把本地配置全冲掉」。有了历史，误操作从灾难降级为一次回滚。服务器全程只搬运密文，**零知识一点不破**。

### v1

`/{server_key}` 的 GET/POST 两方法，单文件 119 行。

---

## 14. 与路线图的接口

服务端下一步（**均未实现**）在 `CLOUD_SYNC_DESIGN.md`：

| 文档 | 内容 | 需要在 `server.cjs` 上做什么 |
| --- | --- | --- |
| §16 | 成员制空间（空间 / 成员 / 角色 / 公钥封装 DEK / 邀请与 rekey / 老 `server_key` 迁移） | 新增 `/spaces/...` 前缀路由与 15 个端点；成员鉴权层（`memberToken` + 角色 + 撤销判定，**与部署级 `REQUIRE_TOKEN` 并存**）；per-space 原子写与进程内锁。**可复用**：`safeName`/`blobPath` 思路、`etagOf`、`writeSidecar`、`listHistory`/`archiveCurrent`/`pruneHistory`、`blobHeaders`、`reply`/`readBody`、`rateLimited`、`fingerprint`（§16.14 有完整清单） |
| §17 | 身份 / 账户体系（密钥对签名认证、设备管理、邀请投递） | 在 §16 之上再加 `/identities/...`；**空间访问仍必须由成员身份判定**，不得让身份会话直接授予空间权限 |

⚠️ 落地 §16 时 `SERVER_VERSION` 需递增（v2 → v3），并在 `GET /` 的 `endpoints` 里列出空间端点，保持「排障页能看到全部能力」这个约定。

---

## 15. 设计取舍速查

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 零依赖 vs 用框架 | 零依赖 | 降低自建门槛（`node server.cjs` 即跑）；也让审计成本可控 |
| sidecar vs 嵌进 blob | sidecar + 文件系统兜底 | 保持 blob 纯净（可被任意工具搬运）；老数据能降级读取 |
| 归档 copy vs rename | **copy** | 复制失败时现有数据完好 |
| 删除 硬 vs 软 | **软删除** | 与版本历史一致；代价是"删除"不等于"擦除"，需在 UI 说明 |
| ETag 用版本号 vs 内容哈希 | 版本号 | 便宜、能防盲覆盖；换包防护留给后续（缺口 #2） |
| 限流内存态 vs 外置 | 内存态 | 参考实现不求完备；缺口 #6 已记录 |
| 空包 接受 vs 拒绝 | **拒绝** | 空包只可能是客户端 bug，接受等于把云端抹成空 |
| 回滚 覆盖 vs 追加 | **追加** | 使回滚本身可逆——否则一次误回滚就再也回不去 |

---

## 附录：关键符号索引

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `SERVER_VERSION` | 52 | 服务端版本，出现在 `GET /` 与 `/healthz` |
| `envInt` | 54 | 环境变量解析 + 下限钳制 |
| `safeName` / `blobPath` | 73 / 78 | 文件名编码 + 穿越校验 |
| `fingerprint` | 99 | 日志用的 key 指纹 |
| `etagOf` | 103 | `"v{n}"` |
| `readSidecar` / `currentMeta` / `writeSidecar` | 117 / 134 / 154 | 元信息读写（含老数据降级） |
| `listHistory` / `archiveCurrent` / `pruneHistory` | 163 / 185 / 193 | 历史管理 |
| `writeBlob` | 203 | 唯一的落盘入口 |
| `rollbackTo` | 232 | 回滚（追加语义） |
| `ifMatchSatisfied` / `ifNoneMatchHit` | 248 / 255 | 条件请求判定 |
| `blobHeaders` | 261 | 统一响应头 |
| `reply` / `readBody` | 280 / 294 | 响应出口 / 边收边限 |
| `rateLimited` / `checkAuth` | 321 / 332 | 限流 / 鉴权 |
| `handleBlob` | 339 | blob 五方法分派 |
| `serviceDescriptor` | 527 | `GET /` 响应 |
| `route` / `handler` / `start` | 546 / 624 / 636 | 路由 / 兜底 / 启动 |
