# Swallow 云同步（Rust 后端）详细设计

> 范围：`src-tauri/src/services/cloud_sync.rs`（1465 行）、`src-tauri/src/utils/crypto.rs`、`cloud-server/`。
> 对照代码版本：v0.3.0（packet v2、双向合并、`cloud_sync_state` / `cloud_test_connection` 已上线）。
> 目标读者：后续维护者 / 重构执行者。本文描述**现状是什么、为什么这样设计**，以及**哪里有坑、下一步往哪改**。
> 总览级内容见 `docs/BACKEND_DESIGN.md` §8；本文是它的详细展开。

---

## 0. 目标与非目标

### 目标

- **零知识**：自建服务器只保存密文，无法读取主机、凭据、密钥、配置任何明文。
- **一条密钥搞定**：用户只填「服务器地址 + 服务器密钥」，`server_key` 同时承担**寻址鉴权**与**密钥派生输入**两个职责。
- **多设备收敛**：同一 `server_key` 的任意设备之间，能力范围内做到最终一致（主机 / 账号 / 密钥 / 证书 / SFTP / 转发 / 片段 / 桌面连接 / 已知主机 / 监控 / 配置）。
- **凭据不落在同步通道之外**：跨设备恢复后密码立即可用（走 keyring），而 DB 列与落盘 JSON 永不含明文。

### 非目标

- 不做账号体系、不做设备注册与管理端：服务器无用户概念，`server_key` 就是全部凭据。
  ⚠️ 这一条在**团队空间**方向上会被有限度突破：§15 是设想，**§16 是已细化的服务端协议规格**（服务器将持有成员公钥、凭据哈希与权限位，仍不接触任何明文业务数据），**§17 是再往上一层的身份体系设想**（会进一步持有身份与设备关系）。三者都是路线图，不是现状。
- 不做增量同步 / 操作日志（CRDT、ot/merge）——当前是**全量快照**。
- 不做删除传播：删除动作**不会**同步（无 tombstone，见 §13）。
- `cloud-server/server.cjs` 是**参考实现**（零依赖 Node）：已内置 TLS（`HTTPS_KEY`/`HTTPS_CERT`）、可选 Bearer 鉴权（`REQUIRE_TOKEN`）、写限流（`RATE_LIMIT`）与版本历史（`HISTORY_KEEP`），但生产部署仍建议外层再加反向代理与访问控制。它**额外提供**了版本历史 / 回滚与 `ETag` 条件请求等能力（§5.2），客户端尚未接线。

### 术语

| 术语 | 含义 |
| --- | --- |
| `server_key` | 用户自定密钥。既是 URL 路径段（寻址 + 弱鉴权），又是 PBKDF2 的口令输入 |
| packet | 一次同步的载荷：全部类目的 JSON 快照（`CloudPacket`） |
| blob | 服务器上的密文文件，文件名 = `server_key` 的 URL 安全编码 |
| 方向 | `upload` / `download` / `bidirectional` 三选一 |
| 类目 | packet 内的一个 `Vec`/`Option` 字段（hosts / keys / settings …） |

---

## 1. 全局视图

### 1.1 组件

```
┌──────────── 客户端（Tauri 单进程） ────────────┐
│ 前端 CloudSettings.tsx                        │
│   │ invoke cloud_sync_now(direction)          │
│   ▼                                           │
│ services/cloud_sync.rs                        │
│   ├ collect_packet()   DB + keyring → JSON     │
│   ├ apply_packet()     JSON → DB + keyring     │
│   ├ merge_packet_new_only()  双向下载半程       │
│   └ utils/crypto.rs    AES-256-GCM             │
│        │ reqwest (30s timeout)                │
└────────┼──────────────────────────────────────┘
         │  POST/GET  HTTP(S)  {base}/{urlencode(server_key)}
         ▼
┌──── cloud-server/server.cjs（参考实现）────┐
│  data/<safeName(server_key)>   只存密文文本   │
└────────────────────────────────────────────┘
```

### 1.2 一次上传的调用链（`upload`）

```
cloud_sync_now("upload")                       cloud_sync.rs:1127
 ├ read_cloud_config()  读内存态 Config.cloud   :158
 ├ 校验 enabled / server_key 非空               :1133
 ├ collect_packet()                             :312
 │   ├ cloud.sync_hosts    → hosts/accounts/sftp/forwardings/remote_conns/known_hosts/monitor_state
 │   ├ cloud.sync_keys     → keys(含私钥公钥) / certificates(含内容)
 │   ├ cloud.sync_snippets → snippets
 │   └ cloud.sync_settings → settings 八段（cloud 段剔除）
 ├ serde_json::to_vec → crypto::encrypt(server_key, json)  → "v1.{salt}.{nonce}.{cipher}"
 ├ upload_packet()  POST {base}/{key}，content-type: text/plain   :968
 ├ append_log_i18n("logMessages.cloudUploaded")
 └ write_sync_state()  落 cloud-sync-state.json
```

`download` / `bidirectional` 在前半程把 `upload_packet` 换成 `download_packet`（GET），并多一步版本闸门与 `apply_packet` / `merge_packet_new_only`（见 §6）。

### 1.3 关键设计决策一览

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 传输形态 | 全量 JSON 快照 | 实现简单、无状态；代价是随数据量线性增长（见 §13） |
| 加密边界 | 客户端加密，服务器零知识 | 自建服务器的信任模型最弱假设 |
| 密钥来源 | `server_key` 单密钥 | 少一个需要用户保管的秘密；代价是无法轮换（§11） |
| 合并粒度 | 条目级（按 `id`），无字段级 | 数据本身是「行」语义，字段级合并需要 per-field 时间戳 |
| 冲突策略 | 同 id 不让双方互相覆盖（方向相关，见 §7） | 无法比较「谁更新」（packet 无 per-item 时间戳），故保守 |
| 恢复落点 | DB 行 + keyring（密码类） | 与项目既有凭据模型一致：DB 列恒空串占位 |

---

## 2. 加密封装（`utils/crypto.rs`）

### 2.1 包格式

```
v1.{salt_b64}.{nonce_b64}.{cipher_b64}
```

| 字段 | 长度 | 说明 |
| --- | --- | --- |
| `v1` | 字面量 | 加密封装版本。`decrypt` 严格要求 `parts.len() == 4 && parts[0] == "v1"` |
| salt | 16 B 随机（`OsRng`） | PBKDF2 的 salt，**每次加密都重新生成** |
| nonce | 12 B 随机（`OsRng`） | AES-GCM nonce |
| cipher | 变长 | AES-256-GCM 密文（含 GCM tag） |

### 2.2 密钥派生

```rust
PBKDF2-SHA256(server_key, salt, 100_000 iterations) → 32 B AES-256 key
```

- `PBKDF2_ITERATIONS = 100_000`（`crypto.rs:11`）。每次上传/下载各派生一次，跑在 async 命令里（**当前是本线程 CPU 密集**，单次约几十毫秒；数据量大时值得挪进 `spawn_blocking`，见 §14）。
- `server_key` 为空直接拒绝（`encrypt` / `decrypt` 均校验），避免「空密钥加密出的数据人人可解」。
- 随机 salt + nonce 保证同明文两次加密结果不同（有单测 `unique_salt_and_nonce` 断言）。
- **多设备为什么能各自解开同一份数据**（常见误解：以为每台设备各有不同的密钥）：
  - **密钥从不传输**。传输的是派生的两个**输入**：`server_key` 由用户在每台设备上**手工输入**；`salt` 是**明文写在密文里**随包走的（`v1.{salt}.…`）。
  - 二者相加 ⇒ 任何一台设备都能**独立算出同一把 32 B 密钥**，全程没有密钥交换、没有设备配对、服务器也不参与其中。这就是 README 里「多台设备用同一个 key 才能互相解密」的确切含义，也是唯一的信任来源（**带外**：口令永远不进网络）。
  - 换个说法：`server_key` 不是「一把密钥」，而是**唯一的口令**。`derive_key` 是纯函数，所以「密钥相同」不是同步的结果，而是「输入相同」的必然结果。
  - 对称的推论：`server_key` 泄漏 + 能读到服务器上的密文（salt 就在里面）= 全部主机、凭据、私钥、配置都可解。§11.4 的「文件名即 key 编码」之所以值得单列，就是因为这条推论。
- **凭据（主机密码 / 私钥）如何跨设备**：keyring **不参与同步**。它们是先被 `resolve_secret` 解析成明文、进 packet、被上面这把密钥整体加密送出，落地时再由 `store_secret_or_clear` 写进**接收端自己的 keyring**（详见 §4.2）。
- **代价：包格式无 `kdf` 标识**，所以换 `server_key` 会让旧密文**永久不可解**，也没有「用新口令包裹旧 DEK」的迁移路径。见 §11.3 与 §14 第 8 步。

### 2.3 已知取舍

- **无 AAD**：密文未绑定 `server_key`、端点或版本号。攻击者可在同一 `server_key` 下互换 blob 内容（换包攻击），但无法伪造明文（GCM 认证仍有效）——受害场景是「把 A 设备数据塞给 B 设备」，而两者本就共享同一信任域，风险可接受。
- **加密封装版本与 packet 版本正交**：`v1.` 是**传输封装**版本，`CloudPacket.version` 是**载荷结构**版本。升级其一不影响另一个。
- **GCM 明文上限**：单包 2^39-256 bit 内安全；参考服务器另有 50 MB body 上限（`server.cjs:64`，`MAX_BODY_MB`），先触发的是后者。

---

## 3. 数据包（packet v2）

### 3.1 结构（`CloudPacket`，`cloud_sync.rs:127`）

```rust
struct CloudPacket {
    version: u32,            // = 2，必填（无 serde default，缺失即解析失败）
    created_at: String,      // RFC3339，产生于 collect_packet
    hosts: Vec<Host>,
    accounts: Vec<Account>,
    sftp_connections: Vec<SftpConnection>,
    port_forwardings: Vec<PortForwarding>,
    keys: Vec<SyncedKey>,          // 记录 + private_key/public_key 明文 PEM
    certificates: Vec<SyncedCert>, // 记录 + cert_content/private_key_content
    snippets: Vec<Snippet>,
    remote_conns: Vec<RemoteConn>,       // v2 新增：VNC/RDP 会话簿
    known_hosts: Vec<SyncedKnownHost>,   // v2 新增
    monitor_state: Option<MonitorState>, // v2 新增
    settings: Option<SyncedSettings>,    // v2 新增：八段
}
```

- 除 `version` / `created_at` 外**全部带 `#[serde(default)]`**：老包缺字段 → 空集合，不会解析失败。
- 结构体**没有** `deny_unknown_fields`：未来 v3 的新字段在老客户端会被静默忽略，随后被 **版本闸门** 拦下（§6.2）——这正是想要的降级行为。
- `SyncedKey` / `SyncedCert` 用 `#[serde(flatten)]` 把记录字段摊平到对象顶层（`KeyRecordForSync` 单独再声明一遍是历史原因，见 §13-7）。
- 全部结构 `rename_all = "camelCase"`，与 IPC 契约一致。

### 3.2 版本矩阵

| packet 版本 | 本客户端 | 说明 |
| --- | --- | --- |
| 无 / v0 | ❌ 解析失败 | `version` 无默认值 |
| v1 | ✅ 可读（`MIN_READABLE_VERSION = 1`） | 缺 `remote_conns`/`known_hosts`/`monitor_state`/`settings`，按空处理 |
| **v2** | ✅ 读写（`PACKET_VERSION = 2`） | 当前版本 |
| v3+ | ❌ 报错拒收 | 版本闸门在解密解析**之后**、apply **之前**（`cloud_sync.rs:1183`、`:1220`） |

老客户端读取新包：v3 包的 `version` 能解析出来 → 命中 `packet.version > PACKET_VERSION` → 返回「云端数据版本不兼容：本地支持 v1-v2，云端 v3」。

---

## 4. 类目映射与开关

### 4.1 四个总开关 → 十一个类目

`Config.cloud`（`models/config.rs:42`）的 4 个布尔量决定 packet 里出现哪些类目，**收集与恢复两侧都按同一批开关判断**——这是保证「关掉某类目后两个方向都不动它」的关键。

| 开关 | 类目（packet 字段） | counts key | 来源 | 凭据落点（keyring key） |
| --- | --- | --- | --- | --- |
| `sync_hosts` | `hosts` | `hosts` | `services::hosts::list_hosts` | `hosts/{id}/password`、`hosts/{id}/proxy_password` |
| 〃 | `accounts` | `accounts` | `services::accounts::list_accounts` | `accounts/{id}/password` |
| 〃 | `sftp_connections` | `sftpConnections` | `services::sftp_connections::list_sftp_connections` | `sftp/{id}/password`、`sftp/{id}/passphrase` |
| 〃 | `port_forwardings` | `portForwardings` | 本文件 `collect_port_forwardings`（直查 SQL） | `portforwardings/{id}/socks_password` |
| 〃 | `remote_conns` | `remoteConns` | `services::remotes::list_remote_conns` | `remote/{id}/password` |
| 〃 | `known_hosts` | `knownHosts` | 本文件 `collect_known_hosts`（直查 SQL） | — |
| 〃 | `monitor_state` | `monitor` | `services::monitor_state::monitor_get_state` | — |
| `sync_keys` | `keys` | `keys` | 本文件 `collect_keys` + `keys::load_key_content` | — （内容在 packet 里） |
| 〃 | `certificates` | `certificates` | 本文件 `collect_certificates` | — |
| `sync_snippets` | `snippets` | `snippets` | `services::snippets::list_snippets` | — |
| `sync_settings` | `settings` | `settings`（恒记 1） | 本文件 `collect_settings` | — （`cloud` 段永不进包） |

### 4.2 凭据模型（本模块的隐式契约）

- 所有列表函数（`list_hosts` / `list_accounts` / …）在读取时已经调用 `resolve_secret(db_value, key)`：**DB 列为空串时回落到 keyring**，把明文填进返回的结构体。因此 `collect_packet` 拿到的 `Host.password` 是**明文**，会进 JSON、再被整体加密。
- 恢复侧走 `store_secret_or_clear(key, Some(明文))` 写 keyring，同时 SQL 里把 `password` 列**硬编码为空串**（`cloud_sync.rs:450`、`:460`、`:523`、`:566`）。DB 与 keyring 的职责边界因此严格保持。
- ⚠️ **失败静默**：`resolve_secret` 在 keyring 读失败时只 `eprintln!` 并返回 `None`（`services/common.rs:18-24`）。此时该条目的密码**不会被同步**，但 packet 照常生成、报告照常显示成功——跨设备恢复后表现为「主机在、密码没了」。见 §13-4。

### 4.3 settings 八段（`SyncedSettings`，`cloud_sync.rs:93`）

`appearance` / `terminal` / `ssh` / `security` / `advanced` / `ai` / `context_menu` / `monitor_alerts`，每段都是 `serde_json::Value` 原样透传。

- **`cloud` 段永不进包**：否则会把 `server_key`、服务器地址同步出去，形成自我引用与凭据外泄。
- 传输用 `serde_json::Value` 而非强类型，是为了**前向兼容**：老客户端恢复新版本写下的 settings 时，只要目标段结构能反序列化就接受，不能则整段跳过（`restore_settings` 里逐段 `if let Ok(...)`）。
- `application`、`shortcuts`、`file_version` 不在同步范围（前者是设备本地状态，后两者是本地行为偏好）。

---

## 5. 传输与服务器协议

### 5.1 URL 构造（`build_base_url`，`cloud_sync.rs:912`）

规则按顺序：

1. `server_host` 为空 → 报错「未配置服务器地址」。
2. 不含 `http://` / `https://` 前缀 → **默认补 `https://`**。
   ⇒ 用明文 HTTP 必须显式写 `http://`，否则会以 https 去连 http 端口而失败。
3. `server_port != 0` 且 `server_host` 里**没有**显式端口 → 追加 `:{port}`。
4. 末尾 `/` 归一化，再拼 `/` + `url_encode_path_segment(server_key)`。

`host_has_explicit_port`（`:933`）的判定细节：去掉 scheme 后数冒号——0 个视为无端口；`[` 开头按 IPv6 处理，只有含 `]:` 才算带端口；否则「恰好 1 个冒号」视为带端口。**IPv6 裸地址（`::1`）不会被误判**。

`url_encode_path_segment`（`:951`）只保留 `A-Za-z0-9-._~`，其余按字节 `%XX`。所以 `server_key = "my key"` → 路径 `my%20key`。服务器侧 `decodeURIComponent` 还原后作为文件名。

### 5.2 端点清单

**客户端实际使用的端点**：

| 端点 | 方法 | 用途 | 客户端实现 | 参考服务器 |
| --- | --- | --- | --- | --- |
| `/{server_key}` | POST | 上传密文（body 即密文文本） | `upload_packet` :968 | ✅ |
| `/{server_key}` | GET | 下载密文 | `download_packet` :994 | ✅ |
| `/{server_key}/meta` | GET | 服务端元信息（version/updated_at/size） | `fetch_meta` :1040 | ✅（v2 已补） |
| `/{root}/healthz` | GET | 连通性探测 | `cloud_test_connection` :1054 | ✅（v2 已补） |

**参考服务器额外提供、客户端尚未使用的端点**（curl 或后续 UI 可用）：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/{server_key}` | HEAD | 只取元信息响应头，不传 body |
| `/{server_key}` | DELETE | 删除当前密文（先归档，仍可回滚恢复） |
| `/{server_key}/versions` | GET | 版本列表（含当前版本，倒序） |
| `/{server_key}/versions/{version}` | GET | 取指定版本的密文 |
| `/{server_key}/rollback?version=N` | POST | 回滚到指定版本（追加为新版本，不丢历史） |
| `/` | GET | 服务描述与端点清单（免鉴权，便于排障） |

**并发控制**：上传可带 `If-Match: "v{n}"`（乐观锁，不匹配 → `412`）或 `If-None-Match: *`（仅当云端无数据才允许写）；下载带 `If-None-Match` 命中 → `304`。见 §14 第 3、9 步，客户端接线尚未开始。

⚠️ **历史缺口（已于 2026-09-17 修复）**：`cloud-server/server.cjs` 曾只有 `/{key}` 的 GET/POST（119 行），**没有 `/healthz` 与 `/meta`**。当时的两条后果：

- 后果 A：「测试连接」按钮对着参考服务器**必然失败**——`/{healthz}` 被当成 `server_key = "healthz"` 查文件 → 404 → 客户端返回「服务器返回 HTTP 404」。
- 后果 B：`/meta` 永远拿不到 → `CloudMeta::default()`（version 0、时间空、size 0）→ `cloud-sync-state.json` 的 `last_cloud_version` 恒为 0。

现已补全（`server.cjs` 665 行，`SERVER_VERSION = 2`），并对 `/meta` 同时输出 `updatedAt` 与 `updated_at` **双拼写**，因此 §13-8 的命名修正可以在服务端不动的前提下独立完成。客户端侧的「探测失败即降级」逻辑（`.ok()` + 状态过滤）保留，仍可对接第三方未实现这些端点的服务端。

### 5.3 HTTP 细节

- `reqwest::Client::builder().timeout(30s)`（`upload_packet` / `download_packet`），`cloud_test_connection` 用 10s。
- 请求头 `content-type: text/plain`；密文本身就是文本（`v1.…`），不需要 multipart。
- 每次调用**新建 Client**：无连接复用收益，但避免长驻连接与状态；同步是低频操作，可接受。
- 状态码只判 `is_success()`，非 2xx 一律转成「上传失败/下载失败：服务器返回 HTTP {code}」。
- **无重试、无退避**：失败即失败，由用户或定时器下次再触发。

---

## 6. 三个方向的语义

### 6.1 对照表

| 方向 | 读云端 | 写本地 | 写云端 | 同 id 冲突 |
| --- | --- | --- | --- | --- |
| `upload` | — | — | ✅ 覆盖（服务端整文件覆写） | 不涉及（不读云端） |
| `download` | ✅ | ✅ **upsert，云端为准** | — | **云端覆盖本地** |
| `bidirectional` | ✅ | ✅ **仅新增**（本地已有则跳过） | ✅ 覆盖 | **保留本地**，计入 `skipped` |

⚠️ **这是本模块最需要记住的一点：两个「下载类」方向的冲突语义是相反的。**

- `download` = 用户显式说「从云端恢复」，语义是**以云端为准**，用 `ON CONFLICT(id) DO UPDATE` 全字段覆盖本地同名条目。
- `bidirectional` = 自动合并，无法判断谁新，采取**保守策略：本地优先**，只把云端独有的条目搬进来，同 id 的记一条 `skipped`（reason:「本地已存在（id …），保留本地版本」）。

设计与实现依据见 `apply_packet` 头注释（`:850-852`）与 `merge_packet_new_only`（`:1263`）。

### 6.2 `download` 逐步

```
1. GET {base}/{key}                       → 密文文本
2. crypto::decrypt(server_key, text)      → JSON bytes（密钥不符则「解密失败：服务器密钥不匹配或数据已损坏」）
3. serde_json::from_slice::<CloudPacket>  → 结构体（失败 →「云端数据解析失败（版本不兼容或密钥不匹配）」）
4. 版本闸门 v1..v2                         → 越界报错
5. apply_packet()                         → 逐类目 restore_*，统计 counts / skipped
6. 若恢复过 settings → app.emit("cloud-config-changed")
7. append_log_i18n + write_sync_state
```

### 6.3 `bidirectional` 逐步

```
1..4. 同上（下载 + 解密 + 解析 + 版本闸门）
5. merge_packet_new_only()     仅新增 + 收集重复项
6. settings 段：restore_settings() 整段覆盖（不走「仅新增」）
7. collect_packet() 重新采集合并后的本地全量
8. encrypt + upload_packet()   把合并结果回传，使云端与本地一致
9. emit cloud-config-changed（若包里有 settings）
10. write_sync_state
```

要点：

- **第 5 步是「下载半程」，第 7-8 步是「上传半程」**，两端最终一致靠「本地 = 云端 ∪ 本地」这个并集上传来实现。
- 重复项用闭包收集三元组再统一转换（`:1271-1275` 注释解释了原因：闭包借用冲突）。
- **settings 不参与「仅新增」**：它没有 id，只能整段覆盖——这是双向合并里唯一的「本地会被覆盖」的类目。⚠️ 也就是说，双向同步在多设备场景下，**配置段是后同步者覆盖先同步者的**。
- `counts` 的语义在本方向下是「本次从云端新增到本地的条数」，不是总条目数。

---

## 7. 合并与冲突策略（逐类目）

| 类目 | `download`（云端为准） | `bidirectional`（本地优先） | 特殊规则 |
| --- | --- | --- | --- |
| hosts / accounts / sftp / forwardings / remote_conns | `ON CONFLICT(id) DO UPDATE` 全字段覆盖 | 仅插入本地不存在的 id | 覆盖含 `group_name/tags/favorite/backend/algo_profile/os_auto` 等本地偏好字段 |
| keys / certificates | upsert 记录 + 覆盖内容列 | 仅新增 id | 恢复时把 `*_path` 置 NULL，只留内容列（与「材料入 DB」的既有约定一致） |
| snippets | upsert 全字段 | 仅新增 | — |
| known_hosts | 见下 | 同左 | 按 `host + key_type` 去重，本地已存在则跳过 |
| monitor_state | 见下 | 同左 | 引用校验后整行覆盖 |
| settings | 八段整段覆盖 | 八段整段覆盖 | 无 id，无法「仅新增」 |

### 7.1 known_hosts 的特例

不走 id 匹配（本地 id 是新生成的 `kh_*`，与云端不同），而是按**业务键 `host + key_type`** 判重（`restore_known_hosts`，`:721`）：

```
本地已存在 (host, key_type)  → 记 skipped「本地已存在相同信任条目，保留本地」，不插入
否则                          → 插入新行：
   id          = sqlite::new_id("kh")
   key_data    = raw_line 的第 3 个空白分隔字段（空则空串）
   fingerprint = 包里有就用，没有则 compute_fingerprint(key_data) 现算
   last_used/added_date = 包里为空则用 now_iso()
```

设计意图：**信任决策不可被远端悄悄改写**。已知主机代表「用户曾确认过这台机器的密钥」，若允许云端覆盖本地，等于让另一台（可能已被入侵的）设备替你改变信任锚。所以这里**连 `download` 方向也只增不改**。

### 7.2 monitor_state 的特例

`restore_monitor_state`（`:770`）把 `host_ids` 逐个与本地 `hosts` 比对：**本地不存在的主机 id 被剔除**并记 `skipped`「本地无此主机，监控项已剔除」，然后用 `monitor_save_state(kept, auto_start)` 整行覆盖。

理由：监控项是指向主机的引用，跨设备恢复时主机可能尚未同步或已删除；留下悬空 id 会让监控页尝试连一个不存在的主机。

### 7.3 引用完整性

各类目的外键（`hosts.key_id`、`accounts.certificate_id`、`port_forwardings.host_id`、`remote_conns.jump_host_id` 等）都是**普通列，数据库未开启 `PRAGMA foreign_keys`**（`utils/sqlite.rs` 无该 pragma），且 `apply_packet` 的恢复顺序是**按类目而非按依赖**（hosts 先于 keys/certificates 写入）。

- 现状可行：因为没有 FK 约束，写入顺序不影响成败；引用方只存 id 字符串，被引用方稍后落库即可自洽。
- 风险：若将来开启 FK 或引入严格校验，必须先把恢复顺序改成拓扑序（keys/certs → hosts → forwardings/remotes）。

---

## 8. 状态持久化与调度

### 8.1 `cloud-sync-state.json`

位于 `utils::path::app_data_dir()`（即系统 data 目录下的应用目录），由 `read_sync_state` / `write_sync_state`（`:1101`、`:1109`）读写。

| 字段 | 写入时机 | 当前用途 |
| --- | --- | --- |
| `last_sync_at` | 每个方向成功后 | 设置页显示「上次同步时间」 |
| `last_direction` | 同上 | 仅记录 |
| `last_cloud_updated_at` | download / bidirectional | 仅记录（服务端 /meta 缺失时恒空） |
| `last_cloud_version` | download / bidirectional | 仅记录（同上恒 0） |

⚠️ 该文件**只用于展示**，不参与任何决策：没有「云端版本变了才同步」的判断，也没有用它做冲突裁决。写入失败被 `let _ =` 吞掉（`:1112`），不影响同步结果。`upload` 方向会把 `last_cloud_*` 显式重置为空/0。

### 8.2 调度：定时器在前端

`sync_interval` / `sync_policy`（`Config.cloud`）**后端完全不用**（全仓 grep 只有定义与前端使用点）。真正的定时器在 `CloudSettings.tsx:100-115`：

```
生效条件：cloud.enabled && sync_policy !== 3（非手动） && sync_interval >= 5（分钟）
方向映射：0 → upload、1 → download、2 → bidirectional
实现：window.setInterval(interval * 60 * 1000)
```

⚠️ **两个限制**：

1. 定时器挂在设置页组件的 `useEffect` 上——**离开设置页即卸载**，自动同步停止。当前实现实际上等价于「打开设置页时按间隔同步」。
2. 关闭 / 后台驻留期间不同步，也没有「启动时补一次」的逻辑。

结论：自动同步目前是**页面级定时器**，不是后台服务。真要「多设备自动收敛」，应把调度下沉到 Rust（`tokio::spawn` + 配置变更重启任务），前端只做展示与手动触发。见 §14-1。

### 8.3 前端侧的并发保护

`CloudSettings.tsx:29` 用 `useRef` 布尔 `syncingRef` 在入口处挡并发（`if (syncingRef.current) return`），配合 `syncing` state 禁用三个按钮。这是**纯 UI 层防护**：后端 `cloud_sync_now` 没有互斥量，若从别处（未来新增的调度器、多窗口）同时调用，会出现两次全量上传互相覆盖。见 §13-3。

---

## 9. 命令面与前端契约

### 9.1 三条命令（`lib.rs:224-226`）

| 命令 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `cloud_sync_now` | `(app, config_state, direction: String)` | `SyncReport` | 主入口；`direction` 非法值返回「不支持的同步方向：{x}」 |
| `cloud_sync_state` | `()` | `SyncStateFile` | 读状态文件，供设置页展示 |
| `cloud_test_connection` | `(config_state)` | `CloudMeta` | 连通性探测 |

前置校验（`cloud_sync_now`）：`enabled == false` → 「云同步未启用，请先在设置中开启」；`server_key` 空 → 「未配置服务器密钥（server_key）」。

### 9.2 返回类型

```rust
SyncReport { direction, counts: HashMap<String, usize>, timestamp, skipped: Vec<SyncSkipped> }
SyncSkipped { category, name, reason }
```

- `counts` 的 key 全集：`hosts`、`accounts`、`sftpConnections`、`portForwardings`、`remoteConns`、`knownHosts`、`monitor`、`keys`、`certificates`、`snippets`、`settings`。
- `skipped.category` 的取值：`knownHosts`（本地已有信任条目）、`monitor`（主机不存在）、以及双向合并的 8 个类目名（本地已有同 id）。
- 三个结构体与 `SyncStateFile` 均 `rename_all = "camelCase"`，前端类型见 `services/dataService.ts:514-545`。

### 9.3 事件

| 事件 | 触发 | 消费方 |
| --- | --- | --- |
| `cloud-config-changed` | download / bidirectional 且包里含 `settings` 时 | `App.tsx:141-150` → `loadConfig()` 重读配置，使主题 / 字体 / 快捷键等**即时生效**（无需重启） |

设计要点：`restore_settings` 已经**同时**更新内存态 `GlobaConfig` 与落盘 `config.toml`，事件只负责驱动前端 UI 重读——所以「恢复后不重启也生效」是内存态更新保证的，事件是补充而不是前提。

### 9.4 UI 行为（`CloudSettings.tsx`）

- 三个按钮：立即上传（`upload`）/ 从云端恢复（`download`）/ 双向同步（`bidirectional`）。
- **非 upload 方向有二次确认弹窗**（`ask(...kind: 'warning')`）——因为会覆盖本地数据。
- 报告展示：`counts` 求和为成功数，`skipped` 数量一并提示。
- 同步进行中三个按钮同时禁用。

---

## 10. 错误处理

### 10.1 文案对照（后端 → 用户可见）

| 触发点 | 文案 |
| --- | --- |
| 未启用 | 云同步未启用，请先在设置中开启 |
| 缺 server_key | 未配置服务器密钥（server_key） |
| 缺服务器地址 | 未配置服务器地址 |
| 加密前密钥为空 | 服务器密钥为空，无法加密 / 无法解密 |
| 上传非 2xx | 上传失败：服务器返回 HTTP {code} |
| 下载非 2xx | 下载失败：服务器返回 HTTP {code} |
| 网络层 | 上传失败/下载失败: {reqwest error} |
| 密文格式不对 | 数据包格式无效（分段数 ≠ 4 或前缀非 v1） |
| base64 解码失败 | salt / nonce / 密文解码失败: {e} |
| GCM 认证失败 | 解密失败：服务器密钥不匹配或数据已损坏 |
| JSON 解析失败 | 云端数据解析失败（版本不兼容或密钥不匹配） |
| 版本越界 | 云端数据版本不兼容：本地支持 v{min}-v{max}，云端 v{n} |
| 方向非法 | 不支持的同步方向：{x} |

### 10.2 现状问题

- 全部经 `Result<_, String>` 冒泡到前端 `String(e)` 展示，**没有错误码**，前端无法据错误类型做差异化处理（比如「服务器密钥不对」本可以引导用户去改密钥，现在只能看字符串）。与 `BACKEND_DESIGN.md` §12 的改造方向一致。
- 「数据已损坏」与「密钥不匹配」在 GCM 层**不可区分**（认证标签就是一个），文案只能并列，这是密码学本性，不是缺陷。
- 部分类目失败会**中断整个 apply**（`?` 直接返回），此时前面已写入的类目不会回滚（见 §13-2）。

---

## 11. 安全分析

### 11.1 威胁模型与对策

| 威胁 | 现状 | 评价 |
| --- | --- | --- |
| 服务器被拖库 | 只有密文，AES-256-GCM + PBKDF2-SHA256(100k) | 达标（前提：`server_key` 足够强） |
| 中间人 | 依赖 TLS；未提供 `https://` 前缀时也默认走 https | 部分达标：**没有证书固定（pinning）**；用户若填 `http://` 则完全明文暴露密文与 key（key 在 URL 路径里） |
| 密钥爆破 | 无长度/强度校验，任意字符串皆可 | ⚠️ `server_key` 同时是**URL 路径**，弱 key（如 `123456`）可被离线爆破 100k PBKDF2 后解密 |
| 重放 / 换包 | 无 nonce 计数、无 AAD、无时间戳校验 | 见 §2.3，同信任域内可接受 |
| 越权访问 | 猜测/遍历 `server_key` 即可读写 | ⚠️ 参考服务器 v2 提供**可选的写限流**（`RATE_LIMIT`）与 **Bearer 鉴权**（`REQUIRE_TOKEN`），但**默认都关闭**；路径仍是凭据，开启鉴权后路径 key 依旧是解密密钥 |
| 本地落盘 | DB 列空串 + keyring；同步状态文件不含秘密 | 同步状态侧达标；⚠️ 但 `server_key` 本身明文存于 `config.toml`——见 §11.3 末条 |
| 内存残留 | 明文（密码、私钥 PEM）在 `String` 中不擦除 | ⚠️ 与 `BACKEND_DESIGN.md` §10 同一待办：`zeroize::Zeroizing` |

### 11.2 设计上值得肯定的两点

1. **`server_key` 不作为服务器的「账号」**：服务器不存 key 与密文的映射之外的任何信息，也没有用户表——降低服务端被入侵后的信息价值，也让「自建一个能用的服务器」的门槛降到 665 行零依赖 Node（`server.cjs` v2）。
2. **配置段排除 `cloud`**：避免同步把 `server_key` 自己写进云端（一种常见的自我引用漏洞）。

### 11.3 待补

- 密钥轮换：当前 `server_key` 一旦更换，旧云端数据**永久不可解**（PBKDF2 输入变了），且没有「新 key 解密旧数据再加密」的迁移路径。建议：packet 里带 `kdf` 标识 + 明文层加密（信封加密，DEK 由 `server_key` 包裹），使换 key 只需重包 DEK。
- 强度校验：前端输入框至少提示「建议 ≥ 32 字符随机串」，后端拒绝过短 key（可配置阈值）。
- 流量侧：`server_key` 出现在 URL 路径 → 会进反向代理访问日志。建议改为 `Authorization` 头携带（服务器与客户端同步小改）。
- ⚠️ **`server_key` 的静态存放是当前最弱的一环**：它是 `models/config.rs:46` 的一个普通 `String` 字段，明文躺在 `config.toml` 里（`utils/file.rs` 走 `toml::to_string_pretty` 明文原子写）。而 keyring 里只有 6 类凭据项——`hosts/{id}/password`、`hosts/{id}/proxy_password`、`accounts/{id}/password`、`sftp/{id}/password`、`sftp/{id}/passphrase`、`portforwardings/{id}/socks_password`，**没有 `cloud/server_key`**（`utils/secrets.rs`，service 名 `swallow`）。也就是说：**keyring 保护了锁，没有保护钥匙串**——主机密码受 OS 保护，而能解密全部主机密码的那把口令只是明文文本。改法：把 `server_key` 也放进 keyring（`Cloud` 只留 `key_stored` 布尔；注意 Linux 无 secret service 时的降级路径），长期则走信封加密让 `server_key` 退化为包裹 DEK 的 KEK。

### 11.4 服务端新增能力的性质（2026-09-17）

参考服务器 v2 引入版本历史、条件请求、鉴权与限流。**零知识模型未被削弱**——所有归档都是完整密文，服务器依旧无法解密任何一份——但有几条事实要在 UI 与文档层向用户讲清：

| 能力 | 安全性质 | 需要澄清的点 |
| --- | --- | --- |
| 版本历史（`HISTORY_KEEP`，默认 20） | 归档与当前 blob 同为密文，格式、加密强度完全一致 | 磁盘占用按份数线性增长；**「已经删掉的数据」在保留窗口内仍留在磁盘上** |
| `DELETE /{key}` | **软删除**：先把当前 blob 归档进 `.history/`，再移除当前文件 | 它保证的是「可回滚」，**不是「擦除」**。要真正抹除需手工清空 `DATA_DIR`，或用加密卷 |
| `POST /{key}/rollback` | 把历史版本**追加为新版本**，历史只增不减 | 回滚不是「撤销」，误回滚本身也会新增一版；这是有意设计（否则回滚不可逆） |
| `If-Match` / `If-None-Match` | 只比较版本号（`"v{n}"`），**不含内容哈希** | 能防「基于过期版本的盲覆盖」，防不了同版本号下的内容替换——§2.3 的换包威胁仍在 |
| `REQUIRE_TOKEN` | 鉴权与加密**正交**：token 决定「能不能读写」，`server_key` 决定「能不能解密」 | 开启后仍应做 §11.3 的「key 挪出 URL」，否则反代日志里留的依旧是解密密钥 |
| `RATE_LIMIT` | **单进程内存态**计数，进程重启即清零 | 多实例部署或容器频繁重启时限制会失效；要硬限流请在反代层做 |

另有一条与「拖库」直接相关、亦写入 `cloud-server/README.md` 的事实：**磁盘文件名是 `server_key` 的 URL 编码而非哈希**，因此能读 `DATA_DIR` 的人可还原出 key 并解密全部历史版本。改成哈希会让既有部署找不到旧数据，故未默认启用——在意这一点时请在文件系统层做权限隔离。

---

## 12. 测试现状

| 位置 | 用例 | 覆盖 |
| --- | --- | --- |
| `cloud_sync.rs:1443-1465` | `url_encode_path_segment_encodes_unsafe_chars`、`build_base_url_handles_scheme` | URL 编码、scheme 补全 |
| `utils/crypto.rs:90-121` | roundtrip、错误 key 失败、空 key 拒绝、salt/nonce 随机 | 加密封装本体 |

**完全缺失**（与 `BACKEND_DESIGN.md` §16 的建议一致）：

1. packet v1 老包可读性（构造 v1 JSON → 断言解析出空集合而非报错）。
2. v2 roundtrip：collect → encrypt → decrypt → apply → 再 collect，断言集合一致（需要可注入的 DB）。
3. `merge_packet_new_only` 的 skip 语义：同 id 保留本地、云端独有才插入。
4. `known_hosts` 按 `host+key_type` 去重的边界（同 host 不同 key_type 应各留一条）。
5. `monitor_state` 引用剔除。
6. `host_has_explicit_port` 的 IPv6 分支（纯函数，最易补）。

其中 1/3/4/6 是纯函数或纯结构体路径，**不需要网络与真实 DB**，改造成本最低，建议优先补。

**服务端（`cloud-server/server.cjs` v2）**：端点行为已用 **38 项 curl 冒烟测试**逐项人工验证——探活与描述页、上传/下载/HEAD、`/meta` 双拼写、版本递增与归档、`If-Match` → 412、`If-None-Match: *` → 412、`If-None-Match` 命中 → 304、空 body → 400、回滚（含 noop 与不存在版本 404）、软删除后仍可回滚、`REQUIRE_TOKEN` → 401、`RATE_LIMIT` → 429、`HISTORY_KEEP=2` 裁剪、无 sidecar 老数据降级、路径穿越与 `%2F` 型 key 拦截。

⚠️ 但**没有任何自动化测试**：`cloud-server/` 下无 test 脚本、未接入 CI，回归只能靠人工重跑。这是当前最值得补的一块——服务端零依赖（仅 Node 内置模块），用 `node:test` + `fetch` 就能覆盖上表全部场景。

---

## 13. 缺陷与偏差清单

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | ~~参考服务器未实现 `/healthz` / `/meta`~~ **已修复（2026-09-17）** | ~~「测试连接」对参考实现必失败；云端版本信息恒空~~ | ✅ `server.cjs` v2 已补全 `/healthz`、`/{key}/meta`（双拼写）、版本历史与回滚、ETag/条件请求、DELETE、鉴权与限流。详见 §5.2 |
| 2 | `apply_packet` 逐条 `execute`，**无事务** | 中途失败（磁盘满/约束冲突）会留下「一半云端、一半本地」的混合态，且已写入部分不回滚 | 包一层 `conn.transaction()`；或先解析校验全部记录再统一写入 |
| 3 | 后端无同步互斥 | 两个调用并发时互相覆盖（定时器 + 手动点击在 UI 层已挡，但后端不设防） | `AppState` 加 `Mutex<()>`/`AtomicBool` 同步闸门，忙时直接返回「同步进行中」 |
| 4 | `resolve_secret` keyring 失败静默 | 密码可能不进 packet，但报告显示成功 → 跨设备恢复后「主机在、密码丢」 | 收集阶段统计「密码缺失」条数并放进 `SyncReport.skipped`，让用户可见 |
| 5 | 无删除传播（无 tombstone） | A 设备删除主机后同步，B 设备上该主机**依然存在**，并被回传复活 | packet 增加 `deleted: [{table, id, at}]`，配合 `updated_at` 做墓碑回收 |
| 6 | 无 per-item `updated_at` | 双向合并只能「本地优先」，无法做真正的时间序 LWW；多设备交替编辑会长期分叉 | 各表加 `updated_at`（或 `rev`），packet 携带，双向合并按时间戳裁决 |
| 7 | `KeyRecordForSync` 重复声明 `KeyRecord` 字段 | 两处定义易不同步（新增字段只改一处 → 静默丢字段） | 直接复用 `models::data::KeyRecord`，用 `#[serde(rename = "type")]` 处理关键字 |
| 8 | `CloudMeta` 缺 `rename_all = "camelCase"` | 序列化为 `updated_at`，前端读 `meta.updatedAt` 恒 undefined → 「服务器 OK（含元信息）」分支永不显示 | 加 `#[serde(rename_all = "camelCase")]`（正是项目 IPC 铁律的漏网点） |
| 9 | `download_packet` 的 `/meta` 探测重复发两次请求 | `meta` 变量先探测再丢弃、随后 `fetch_meta` 又请求一次 | 探测结果直接解析使用，去掉 `fetch_meta` 的重复调用 |
| 10 | 全量快照上传 | 数据量增大后每次同步的加密 + 上传成本线性上升；参考服务器 50 MB 上限 | 中期做按类目/按条目的增量协商；至少先加 gzip（JSON 压缩率通常 > 80%） |
| 11 | `settings` 在双向合并中是整段覆盖 | 多设备时配置段互相覆盖，非「字段级合并」 | 若需要，按字段做 diff merge（每段是 `Value`，可递归合并） |
| 12 | PBKDF2 在主线程跑 | 数据量大时阻塞 async 执行器 | 挪进 `spawn_blocking`；或缓存派生密钥（同一次同步内 salt 固定，本可复用） |

---

## 14. 演进路线（建议顺序）

1. **调度下沉 + 后端互斥**（修 §13-3、§8-2）：`AppState` 加同步闸门；`sync_interval` / `sync_policy` 改由 Rust 侧 `tokio` 任务驱动，前端只做展示。这一步同时让「关闭设置页也在同步」成立，是自动同步真正可用的前提。
2. ~~**补服务端 `/healthz` + `/meta`**（§13-1）~~ ✅ **已完成（2026-09-17）**：`server.cjs` 重写为 v2（665 行），除补全两个端点外还顺带加了**版本历史与回滚**（每次上传前归档旧 blob）、`ETag` / `If-Match` / `If-None-Match` 条件请求、`HEAD`、`DELETE`（先归档可恢复）、`REQUIRE_TOKEN` Bearer 鉴权、`RATE_LIMIT` 限流、`LOG_REQUESTS` 逐请求日志（key 只记指纹）、路径穿越加固与原子写。已用 38 项 curl 冒烟测试逐端点验证。**客户端尚未接线**（版本历史/回滚没有 UI，条件请求未发）。
3. **事务化 apply**（§13-2）+ **收集侧缺失凭据上报**（§13-4）：都是「让现状更可信」的低风险改动。
4. **客户端接入版本历史 UI**：服务端能力已就绪（上一步），客户端只需加「查看历史版本 / 回滚」入口，即可把「一次误同步」从灾难降级为一次回滚。纯客户端改动，不动加密与协议。
5. **`CloudMeta` 命名修正**（§13-8）+ 顺手清掉 `/meta` 的重复请求（§13-9）：一个字段注解 + 一次调用删除。服务端已同时输出 `updatedAt` 与 `updated_at`，两边可以各自独立修。
6. **补单测**（§12 的 1/3/4/6）：把合并语义用测试钉死，再动合并算法。
7. **加 `updated_at` + 墓碑**（§13-5、§13-6）：数据模型升级（packet v3），双向合并从「保守不动」升级为「时间序 LWW + 可传播删除」。需要先做数据迁移与兼容闸门。
8. **信封加密 + 密钥轮换**（§11.3）：让 `server_key` 可换；顺带把 `server_key` 从 URL 路径挪到请求头。
9. **增量同步**（§13-10）：在第 7 步的时间戳基础上做「只传输变化条目」，配合 gzip。
10. **多空间**（团队空间路线 L，§15.2）：`Config.cloud` 从单份扩为多份，实现「工作 / 个人 / 客户」隔离。**无前置依赖**，可与 1–6 并行推进。更靠后的三层依次是：**§15** 团队空间设想 → **§16** 成员制空间的服务端协议规格（15 个端点的完整契约、邀请与 rekey 时序、迁移步骤、验收用例）→ **§17** 身份 / 账户体系设想（多空间登录、按身份投递邀请、设备管理）。注意 §16 硬依赖本清单第 7、8 步，§17 硬依赖 §16。

---

## 15. 专题：团队空间（用户组）设想

> ⚠️ 本节是**路线图设想**，不是现状。现状仍是「单 `server_key` = 单空间、服务器无用户概念」（§0），代码里没有任何成员/角色/权限设施。

### 15.1 动机：两个现状痛点

- **共用一个 key 就是当前全部的协作能力。** 小团队共享主机库（同一批生产机、同一套跳板与凭据）时只有两条路：各自维护一份配置靠人工对齐，或共用同一个 `server_key`。后者意味着**没有成员概念**——谁都能上传、谁都能覆盖、谁走了都无法撤销（换 key 等于让所有人重新配置一遍）。
- **全量快照模型在多写者下是台数据丢失机器。** 现状的「后写者覆盖」在单人多设备时勉强可用（§6.2），一旦出现第二个写者（同事的设备），A 删除的主机会被 B 复活（无墓碑，§13-5）、同 id 编辑永远本地优先（无时间戳，§13-6），`settings` 段更是双方整段互覆（§6.3）。

所以「团队空间」不是孤立功能，而是**对 §14 第 7、8 步的组合消费**：

| 依赖 | 为什么在团队场景是硬依赖 |
| --- | --- |
| §14-7 `updated_at` + 墓碑 | 多写者必须有时间序裁决与删除传播，否则必然丢数据 |
| §14-8 信封加密 | 成员进出要能换密钥，而不能重传/重加密全量数据 |

### 15.2 先选路线：L（多空间）还是 H（成员制）

| | 路线 L：多空间 | 路线 H：成员制空间 |
| --- | --- | --- |
| 核心 | `Config.cloud` 从单份变多份，每个空间独立 `server_key` / 开关 / 方向 / 自动同步策略 | 一个空间多成员，各有独立凭据与权限 |
| 服务器改动 | **零** | 成员表 + Bearer 鉴权 + 空间元数据 |
| 加密改动 | **零** | 三层密钥（DEK + 每成员**公钥**封装；对称 KEK 为降级变体，见 §16.4） |
| packet 改动 | **零** | v3（per-item 时间戳 + 墓碑） |
| 能否撤销单人 | ❌ 换 key = 全员重配 | ✅ 重包 DEK |
| 能否区分身份 / 审计 | ❌ | ✅ |
| 前置依赖 | 无 | §14-7、§14-8 |
| 改动面 | 配置层 + 设置页（约一屏 UI + 配置迁移） | 服务端 + 加密 + 合并算法，跨三层 |

**建议先做 L。** 理由：

1. 不碰加密与服务器，风险最低，且立刻有实用价值——「工作 / 个人 / 客户 A」隔离是单人也想要的能力；
2. L 会在配置层立起「空间」这个外壳，H 只是在其上加成员维度，不返工；
3. §14 的 7/8 步各自独立有价值（多设备正确性、可换 key），可以在 L 之后从容推进。

注意 L 的空间是**纯本地配置分组**（id 本地生成），服务器侧仍是 `server_key` 路径寻址，因此不需要 `space_id`；只有 H 才需要引入服务器侧空间标识。

### 15.3 路线 H 的密钥层次

> ⚠️ **本小节已被 §16.4 修订**：细化规格时改成了**非对称**方案（成员公钥封装 DEK，`sealed.` 信封），因为对称 KEK 强迫邀请码携带一个真秘密（§16.7 的两把锁）。下面的对称描述作为**降级变体**的参照保留（§16.4 注 2）。

```
现状：  AES key   = PBKDF2(server_key, salt)        ← 一把钥匙既是身份又是内容密钥
目标：  DEK       = 32B 随机（真正加密业务数据）
        KEK_i     = PBKDF2(member_secret_i, salt_i) ← 每成员一份
        wrapped_i = AES-GCM(KEK_i, DEK)             ← 服务器只存这个包裹
```

读取链：`member_secret → KEK_i → 解 wrapped_i → DEK → 解 blob`
新增成员：把 `space_id` + 一次性邀请码给新人 → 他本地生成自己的 KEK → 服务器追加一条 wrapped
撤销成员：删除他的 wrapped → 生成 `DEK'` → 重包给剩余成员 → 用 `DEK'` 重新加密 blob

⚠️ **必须向用户讲清的边界**（这是零知识 + 可撤销的固有代价，不是实现偷懒）：

- **历史数据无法收回**：被撤销者已下载的明文与旧 DEK 无法远程抹除。撤销只能保证「换 DEK 之后写入的数据他读不到」。
- 重新加密全量 blob 是 O(数据量) 操作，需要**双 DEK 过渡期**（读旧写新）或接受停机窗口。
- 若成员只用非对称密钥（CI/服务器场景），可用 ed25519 替代 PBKDF2——项目已有该依赖（russh 链路），好处是邀请不必传对称秘密。

### 15.4 服务器侧模型与泄漏面

服务器新增的都是**元数据**（仍不接触任何明文业务数据）：

```
spaces/{space_id}/
  meta.json      space_id / owner_member_id / created_at / epoch / etag / blob_version
  members.json   member_id / role / added_at / revoked_at / token_hash / kdf 参数
  keys.json      { "<epoch>": { member_id: wrapped_dek } }   ← 每成员保留最近 2 个 epoch
  pending.json   待 owner 处理的加入申请（member_id / public_key，服务器不解析）
  invites.json   invite_id / expires_at / used_at（服务器只登记，不持有邀请码内容）
  blob           ← 现有密文文件，改由 space_id 寻址
```

字段级定义、原子性与并发要求见 **§16.9**；加入流程与 rekey 的时序见 §16.7 / §16.8。

- `token_hash` 的算法由**零依赖约束**决定：用 Node 内置 `crypto.scrypt`（Argon2id / bcrypt 在零依赖下都不可用）。参数与取舍见 §16.3。相比现状「路径即凭据」是安全性**提升**。
- `member_token` 走 `Authorization: Bearer`，**不再出现在 URL 路径**，顺带修掉 §11.3 的反代日志泄漏问题。
- ⚠️ **泄漏面增量**（团队化不可避免，需在 UI 里向用户说明）：

| 服务器现在能知道 | 仍然不知道 |
| --- | --- |
| 成员数量、加入 / 离开时间 | 主机、账号、密码、私钥、配置的任何内容 |
| 每人的上传 / 下载频率、blob 大小与版本号 | 条目数量、分组、标签、会话内容 |
| 空间创建时间、最后活跃时间 | —— |

对多数自建场景可接受。若要隐藏「成员数」，服务器就只能存一串 token 哈希而不存 member_id——但审计能力随之消失，二者不可兼得。

### 15.5 端点演进

> **本节只给形状；完整契约（15 个端点的请求/响应/状态码、角色矩阵、邀请与 rekey 时序、错误码、迁移步骤、验收用例）见 §16。**

| 端点 | 方法 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| `/spaces` | POST | 创建空间（首个成员即 owner） | 🔓 + `SPACE_CREATE_TOKEN` |
| `/spaces/{spaceId}` | GET / HEAD / PUT / DELETE | blob 读写；PUT 需 `If-Match: <etag>` | Bearer（DELETE 仅 owner） |
| `/spaces/{spaceId}/me` | GET | 一次取全：自己的 `wrappedDek`(±上一个 epoch) / `epoch` / `role` / `etag` | Bearer |
| `/spaces/{spaceId}/members[/{memberId}]` | GET / PUT / DELETE | 列成员、写入包裹、撤销 | Bearer（PUT/DELETE 仅 owner） |
| `/spaces/{spaceId}/invites` · `/join` · `/pending` | POST / GET | 邀请登记、新人加入、owner 取待处理申请 | 混合，见 §16.5 |
| `/spaces/{spaceId}/rekey` | POST | 原子替换全部 `wrappedDek` 并递增 `epoch` | 仅 owner |
| `/spaces/{spaceId}/meta` · `/versions*` · `/rollback` | GET / POST | 元信息与版本历史（复用 v2） | Bearer |
| `/healthz` · `/` | GET | 探活与服务描述（免鉴权） | 无 |

⚠️ **零知识下的权限是「协议级」而非「密码学级」**：服务器能按 role 拒绝 `viewer` 的 PUT，但无法阻止他解密后另存他处。角色只能约束行为，不能约束认知。

### 15.6 共享范围与角色

复用现有的 `Host.group` / `Host.tags`（`models/data.rs:41`、`:43`）：

| 范围 | 实现 | 说明 |
| --- | --- | --- |
| 空间级 | 默认，全部类目 | 等于现状语义 + 多成员 |
| 分组级 | `collect_packet` 增加 group 白名单过滤 | 只把命中分组的主机放进包——「前端组给你、生产组给他」 |
| 条目级 | 每条带 `owner_member_id`（packet v3 新字段） | 实为「空间内的私人分区」，只在自己设备间同步 |

⚠️ **凭据才是团队化的真正难点**：现状 `Host.password` 是明文进包（§4.2），共享主机就等于**共享密码**。建议把凭据拆成独立开关，默认**不随主机共享**——组员看到主机条目，但密码栏需自填（keyring 里带 `owner_member_id` 作用域）。这比「全员共用一个 sudo 密码」安全得多。

角色只需最小三档：

| 角色 | 权限 |
| --- | --- |
| owner | 增删成员、调整共享范围、读写 |
| editor | 读写业务数据 |
| viewer | 只读（服务器拒绝 PUT；客户端隐藏写入口） |

### 15.7 并发、迁移与兼容

**（1）并发是最大的实现差距。** 现状「后写者赢」在团队下不可接受。必须给 PUT 加 `If-Match: etag`，冲突时服务器返回 412 → 客户端重新下载 → **三方合并**（base = 上次同步的 blob，local = 当前，remote = 云端）→ 重试。这套地基与 §14-9 的增量同步是同一套，值得一次做对。

**（2）迁移可以平滑。** 老 `server_key` 空间在服务器上平移为「单成员空间」，DEK 直接取现 PBKDF2 派生值（**不换密钥**，老数据照样可解）；新建空间直接走新模型。过渡期 URL 路径同时接受 `server_key` 与 `space_id`（按格式区分），逐空间升级。

**（3）空间模型与 packet 版本正交**（§2.3）：空间只改变「谁来拿 DEK」，不改 blob 内的 JSON 结构。packet 升 v3 由 15.7(1) 的时间戳/墓碑驱动，两件事可分别推进。

**（4）邀请码的带外分发已被 §16.7 降级为「可选便利」。** 本小节原判断是「零知识下服务器不能代传 `member_secret`，只能传加入申请」，因此要求邀请码带外分发。§16.7 改用**成员公钥**后，带外传输的只有 `inviteId` + `inviteSecret`（**不参与任何密钥派生**）与公钥，服务器可以合法代传公钥——所以「必须带外」这条约束不再成立。真正的闸门变成 **owner 对 `/pending` 的人工审批**，UI 必须有清晰的「核对公钥指纹 → 批准」动作。

### 15.8 非目标与反模式

- 不做 SSO / OIDC / LDAP 对接——企业目录集成请走自建网关，不进本客户端。
- 不做条目级 ACL（每台机器一份权限表）——维护成本远超收益。
- 不做服务器端「成员通讯录 / 在线状态」。
- ⚠️ **反模式**：
  - 全员共用一个 `member_token`（等于没做成员，且无法撤销）；
  - 把 `space_key` 直接当 Bearer token 交给服务器（等于交出解密能力）；
  - 为了让服务器校验权限而在服务器存明文「成员 ↔ 数据」映射（这会摧毁零知识的全部收益）。

### 15.9 风险小结

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 密钥层数从 1 变 3，用户配错 | 高 | UI 把复杂度藏起来：创建空间一键生成（自动生成密钥对）、加入 = 粘贴邀请码 + owner 审批；`server_key` 这个用户概念在迁移后保留为兼容材料（§16.10） |
| 撤销语义被误解为「远程擦除」 | 中 | UI 明示「已同步过的数据无法回收」 |
| 重加密全量 blob 的窗口期 | 中 | 双 DEK 过渡（读旧写新），或大空间上做「撤销后首次写入时惰性重加密」 |
| 服务器元数据泄漏成员信息 | 中 | 文档化可见面；提供「单成员空间」等价现状模式 |
| 加密 + 合并 + 服务器 + UI 交叉改动 | 高 | 严格按 15.2 的两条路线分段，每段独立可用 |

---

## 16. 服务端协议规格：成员制空间（可实施）

> 定位：§15 讲「为什么这么做、代价是什么」，本节讲「具体怎么做」。这是**待实现的规格**，不是现状——`cloud-server/server.cjs` v2 目前只实现了 `/{server_key}` 单密钥模型。
>
> 与服务端 v2 的关系：v2 已经具备本规格依赖的两块地基——**Bearer 鉴权**（`REQUIRE_TOKEN`）与 **ETag + 版本历史**（并发裁决、rekey 后回滚）。本节是在其上扩展，不是重写。

### 16.1 设计约束

| 约束 | 说明 |
| --- | --- |
| 零依赖（服务端） | 服务器只能用 Node 内置 `http`/`https`/`fs`/`crypto`/`path`。**这决定了 token 哈希算法**（见 §16.3）。注意：服务器**不参与任何密码学操作**——所有封装/解封都在客户端，服务器只是字节搬运工 |
| 零知识不退化 | 服务器新增的全是元数据与「包裹后的密钥」。绝不出现 `DEK`、任何私钥、任何能直接解密的对称秘密 |
| 路径不使用凭据 | 空间寻址用随机 `spaceId`，**凭据走 `Authorization: Bearer`**——顺带修掉 §11.3 的反代日志泄漏 |
| 与 v2 端点共存 | `/spaces/...` 是新增前缀；老的 `/{serverKey}` 原样保留（迁移见 §16.10） |
| 算法复用现有依赖 | 对称部分沿用 `utils/crypto.rs` 的 PBKDF2-SHA256(100k) + AES-256-GCM；**成员密钥的包裹改用非对称方案**：`x25519-dalek` + `hkdf` + `aes-gcm`，三者**都已在 `Cargo.lock` 解析树中**（russh 链路拉入，见 §16.4 注 1） |
| 带外只传非秘密 | §16.7 的邀请流程中，任何带外传输的内容（`inviteId`、公钥）**都不是秘密**。这是相对早期方案的硬性改进目标 |

### 16.2 标识与命名

| 标识 | 生成方 | 格式 | 说明 |
| --- | --- | --- | --- |
| `spaceId` | 客户端（创建者） | base64url(16B)，22 字符，`[A-Za-z0-9_-]` | 服务器不生成，避免引入随机数质量与碰撞责任；**必须校验格式**，这是防路径穿越的第一道闸 |
| `memberId` | 客户端（本人） | 同上 | 每成员一个，创建者即 owner 的 memberId |
| `inviteId` | 客户端（owner） | 同上 | 一次性邀请的登记标识 |
| `memberToken` | 客户端（本人） | base64url(32B)，43 字符 | 只在上报时明文传输一次（TLS），服务器存哈希 |

- **保留首段**：服务器必须拒绝把 `spaces` / `healthz` / `index` 之外的任何**保留字**当作 legacy `server_key`，同时在创建空间时拒绝与保留字同名的 `spaceId`。老 `server_key` 侧也要拒绝 `spaces`（否则路由歧义）。
- 路径语法：`/spaces/{spaceId}[...]`、legacy `/…`。二者**逐段解码**（同 v2 的 `%2F` 处理），`blobPath` 式的 `path.dirname` 校验在空间目录上照做一遍。

### 16.3 凭据与鉴权

- ⚠️ **`memberToken` 只是认证凭据，不含任何解密能力**。它泄漏的后果是「能冒充该成员读写密文」，**不是「能解开数据」**——解密能力只存在于成员的 X25519 私钥里（§16.4）。这是相对「对称 `member_secret` + KEK」方案的关键改进，也是 §16.7 敢把邀请内容公开传输的前提。
- 上报：`Authorization: Bearer <memberToken>`。服务器**不存 token 明文**，只存 `tokenHash`。
- ⚠️ **哈希算法订正：用 `SHA-256`，不要用 scrypt**。上一版此处写的是「scrypt，因为零依赖下 Argon2id/bcrypt 不可用」——方向对，但**前提用错了**：慢 KDF（scrypt / Argon2id / bcrypt）是为**低熵人类密码**设计的，用来抬高字典攻击成本。而 `memberToken` 是 **32B（256 位）随机值**，根本没有暴力搜索空间——服务器被拖库后，攻击者面对的是 SHA-256 的 256 位原像，套任何 KDF 都不会让它更难。
  - 代价差别是实的：scrypt 每次鉴权约 **30–60 ms + 32 MB 内存**，同步服务器每个请求都付一遍，高并发下还会被内存放大击穿。
  - 实现：存 `sha256(memberToken)`，比对用 `crypto.timingSafeEqual`。`inviteSecret`（同样 32B 随机）同理。
  - **唯一需要慢 KDF 的场景是「引入人类可记忆的密码」**——而 §17 明确不建议那样做（零知识下密码没有加密价值，只增加可拖库的攻击面）。若将来真要做，成员记录里保留 `kdf` 字段即可前向兼容地加。
  - 补充：§15.4 原写的「Argon2id 或 bcrypt」同样应作废——零依赖下 Node 内置两者都没有，且即使有也不该用在随机 token 上。
- ⚠️ **撤销必须即时生效**：鉴权时除了比对 token，还要检查该成员的 `revokedAt` 是否为空。仅靠「删掉成员记录」不够——已签发的 token 仍在客户端手里，必须在每次请求上做角色与撤销状态判定。
- `REQUIRE_TOKEN`（部署级口令）与 `memberToken` 是**两层**，都不与加密挂钩：前者管「谁能访问这个部署」，后者管「你是谁、能做什么」。

### 16.4 密钥层次与三代信封

成员密钥用**非对称**方案：私钥不出本机，公钥可以随便传（甚至贴群里）。

```
成员密钥对 (sk_i 仅存本机, pk_i 上传)
        │
        └─ seal(pk_i, DEK) ──▶ wrapped_dek_i ──▶ DEK ──▶ blob = AES-GCM(DEK, packet_json)
```

**DEK 的匿名封装（sealed box）**：

```
eph_sk ← 32B 随机（一次性，用完即弃）
ss     = X25519(eph_sk, pk_i)                          ← ECDH 共享秘密
k      = HKDF-SHA256(ss, salt = eph_pk, info = "swallow-dek-v1") → 32B
封装    = sealed.{eph_pk_b64}.{nonce_b64}.{cipher_b64}   where cipher = AES-GCM(k, DEK)
```

- 解封只需 `sk_i` 与封装里自带的 `eph_pk`，**不需要任何带外秘密**。这是 §16.7 能去掉「邀请码即凭据」的根本原因。
- ⚠️ **每次封装必须用新的 `eph_sk`**。若复用给同一成员：ECDH 秘密相同 → HKDF 输出相同 → 同一 AES-GCM 密钥下 reuse nonce 体系，属于灾难性误用。列为硬性要求（§16.13）。
- HKDF 的 `salt` 取 `eph_pk`（而非固定值），把「这一次会话」绑进派生，避免跨会话密钥撞车。

**三代信封格式并存**（迁移的关键，见 §16.10）：

| 格式 | 密钥来源 | 用途 |
| --- | --- | --- |
| `v1.{salt}.{nonce}.{cipher}` | `PBKDF2(passphrase, salt, 100k)` | **现状**：legacy 单密钥 blob；迁移后**只在读取旧 blob 时出现** |
| `v2.{nonce}.{cipher}` | 直接是 32B 密钥（DEK） | **新增**：blob 本体。不再需要 salt，因为 blob 层没有 KDF |
| `sealed.{eph_pk}.{nonce}.{cipher}` | `ECDH(eph_sk, pk_i)` → HKDF → 32B | **新增**：`wrapped_dek`。自描述，独立前缀，不与 `v1`/`v2` 混淆 |

- ⚠️ 客户端 `crypto.rs::decrypt` 目前硬校验 `parts.len() == 4 && parts[0] == "v1"`（`crypto.rs:58`），**必须改成按首段分派**。这是客户端接线工作的一部分。
- **epoch**：整数，从 1 起。`meta.epoch` 表示**当前 blob 用的是哪个 epoch 的 DEK**。
  - `keys.json` 按 epoch 分组存包裹：`{ "3": { memberId: "sealed.…" }, "2": { … } }`，每成员**保留最近 2 个 epoch**。
  - **读取规则**：用 `meta.epoch` 对应的 DEK 解 blob；GCM 认证失败则回退用 `epoch-1` 的 DEK 重试。这条 fallback 是「rekey 与重加密 blob 之间存在时间差」的唯一安全出口，**必须实现**。
  - 每次 rekey（epoch 递增）时，丢弃 `epoch ≤ current-1` 的旧包裹，窗口始终是 2。

**注 1：依赖可用性（已核实 `Cargo.lock`）**

| crate | 锁文件中版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| `x25519-dalek` | `3.0.0-rc.1` | russh 链路间接引入 | ECDH |
| `hkdf` | `0.12.4` | 已在解析树 | 共享秘密 → AEAD 密钥 |
| `aes-gcm` | `0.10.3` | 项目直接依赖 | AEAD |
| `ed25519-dalek` | `3.0.0-rc.1` | russh 链路间接引入 | §17 的签名认证 |

⚠️ **两个必须先处理掉的坑**：

1. 两个 dalek 都是 **`3.0.0-rc.1` 预发布版**。把它们提升为**直接依赖**前必须先跑 `cargo add` 验证解析——RustCrypto 的 pre 生态迭代快，与 ironrdp→picky 的 `=rc` 精确锁容易互斥（与项目「russh 0.60.1」那条结论同源）。
2. **`rand_core` 在树里有三个版本并存**（`0.6.4` / `0.9.5` / `0.10.1`）：项目直接依赖 `rand = "0.8"`（→ `rand_core 0.6.4`），而 `x25519-dalek 3.0.0-rc.1` 依赖 `rand_core 0.10.1`。**项目现有的 `OsRng` 因此喂不进 dalek 的 RNG 接口**（trait 版本不同）。绕法（推荐）：继续用现有 `OsRng` 生成 32 字节，再 `StaticSecret::from([u8; 32])`——绕开 RNG trait，避免为了这一处把 `rand` 整体升级。

**注 2：对称方案作为降级选项保留**

无 dalek 可用（或 CI / 脚本场景不便持有私钥）时，可退回「`member_secret` → PBKDF2 → KEK → AES-GCM 包裹 DEK」的对称方案。此时**代价会回来**：带外必须传一个真秘密，且「身份」与「解密能力」被绑死在同一串秘密上——正是 §16.7 想摆脱的东西。服务端协议**无需为此改动**：`wrapped_dek` 对服务器永远是不透明字节，`sealed.` 与 `v2.` 前缀由客户端自行解释。

### 16.5 端点契约

图例：🔓 = 无需鉴权，🔑 = 需 `memberToken`，👑 = 需 `owner` 角色。

**创建与成员**

| # | 端点 | 鉴权 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| 1 | `POST /spaces` | 🔓（见下注） | `{ spaceId, member: { memberId, memberToken, role:"owner", publicKey, wrappedDek }, meta:{ name? } }` | `201 { spaceId, memberId, role, etag, epoch }` |
| 2 | `POST /spaces/{id}/invites` | 👑 | `{ inviteId, expiresAt }` | `201 { inviteId, expiresAt }` |
| 3 | `POST /spaces/{id}/join` | 🔓（凭 `inviteId`） | `{ inviteId, memberId, memberToken, publicKey }` | `202 { status:"pending", memberId }` |
| 4 | `GET /spaces/{id}/pending` | 👑 | — | `200 { pending:[ { memberId, publicKey, requestedAt } ] }` |
| 5 | `PUT /spaces/{id}/members/{memberId}` | 👑 | `{ publicKey, wrappedDek, epoch }` | `200 { memberId, epoch }` |
| 6 | `GET /spaces/{id}/members` | 🔑 | — | `200 { members:[ { memberId, role, publicKey, addedAt, revokedAt } ], ownerMemberId }` |
| 7 | `DELETE /spaces/{id}/members/{memberId}` | 👑 | — | `200 { memberId, revokedAt }` |
| 8 | `POST /spaces/{id}/rekey` | 👑 | `{ epoch, wrappers:[ { memberId, wrappedDek } ] }` | `200 { epoch, etag }` |
| 9 | `GET /spaces/{id}/me` | 🔑 | — | `200 { memberId, role, epoch, wrappedDek, wrappedDekPrev?, publicKey, etag, blobVersion, deleted, pendingRekey? }` |

**Blob 与版本**（语义与 v2 一致，只换寻址与鉴权）

| # | 端点 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| 10 | `GET` / `HEAD` `{spaceId}` | 🔑 | 下载 / 取元信息响应头；`If-None-Match` 命中 → `304` |
| 11 | `PUT {spaceId}` | 🔑 + role ∈ {owner, editor} | 上传密文；**要求 `If-Match: "<etag>"`**，不匹配 → `412`；可用 `If-None-Match: *` 表示首写 |
| 12 | `DELETE {spaceId}` | 👑 | 软删除（先归档，可回滚） |
| 13 | `GET {spaceId}/meta` | 🔑 | `{ epoch, blobVersion, etag, size, createdAt, updatedAt, history:{…} }` |
| 14 | `GET {spaceId}/versions` · `/versions/{n}` · `POST /rollback` | 🔑（rollback 需 editor+） | 版本历史，复用 v2 实现 |

**注 1（`POST /spaces` 防护）**：该端点无法用 `memberToken` 鉴权（此时还没登记），否则就成了「任何人都能无限建空间」。部署侧二选一：
- `SPACE_CREATE_TOKEN=…` —— 创建时额外校验此部署级口令（推荐，与 `REQUIRE_TOKEN` 独立）；
- 或依赖内网 + `RATE_LIMIT`（保持零配置，但不防风控）。

**注 2（`/join` 的鉴权语义）**：`inviteId` 与 `inviteSecret` 共同构成「加入申请」的凭据，其中 `inviteSecret` 只做鉴权、**不参与任何密钥派生**（§16.7 的第一把锁）。服务器只做三件事——校验 `inviteId` 存在、`inviteSecret` 哈希匹配、未过期（`expiresAt`）且未被用过（`usedAt` 为空），然后写入 pending 并把 `usedAt` 置为 now。**服务器不解析 `publicKey` 的密码学内容**，只把它原样存下来交给 owner。

### 16.6 角色判定矩阵

| 操作 | owner | editor | viewer |
| --- | --- | --- | --- |
| 读 blob / meta / versions | ✅ | ✅ | ✅ |
| 写 blob（PUT） | ✅ | ✅ | ❌ `403` |
| 回滚 | ✅ | ✅ | ❌ `403` |
| 列成员 | ✅ | ✅ | ✅ |
| 增删成员 / 创建邀请 / rekey | ✅ | ❌ `403` | ❌ `403` |
| 删除空间 | ✅ | ❌ `403` | ❌ `403` |

- 判定顺序：**401**（无/坏 token）→ **403**（token 有效但角色不足）→ **404**（空间不存在）。顺序不能反：先 403 后 404 会泄漏"这个空间存在"。
- ⚠️ 重申 §15.5 的边界：这是**协议级**权限。服务器能拒绝 viewer 的 PUT，但拦不住他把解密后的内容另存或转发。

### 16.7 邀请与加入流程（两把锁，带外不含解密能力）

核心变化：**DEK 由 owner 用新人的公钥包裹**。于是带外传输的东西无论泄漏与否，都**不构成解密能力的泄漏**。

```
inviteCode = base64url({ v:1, spaceId, inviteId, inviteSecret, expiresAt })
             └── inviteSecret 只用于「让服务器接受你的加入申请」，与解密无关 ──┘
```

| 步骤 | 谁 | 动作 |
| --- | --- | --- |
| 1 | owner | `POST /spaces/{id}/invites { inviteId, inviteSecretHash, expiresAt }` —— 服务器只登记**哈希**（§16.5 #2） |
| 2 | owner → 新人 | 发出 `inviteCode`（IM / 邮件 / 面对面皆可） |
| 3 | 新人 | 本地生成：X25519 密钥对 `(sk, pk)`、`memberId`、`memberToken`，**均为随机**，私钥不出本机 |
| 4 | 新人 | `POST /spaces/{id}/join { inviteId, inviteSecret, memberId, memberToken, publicKey }` → `202` |
| 5 | owner | `GET /spaces/{id}/pending` → 看到申请（`publicKey` 指纹、`requestedAt`）→ **人工核对身份** |
| 6 | owner | 本地 `wrappedDek = seal(pk, DEK_current)` → `PUT /spaces/{id}/members/{memberId} { publicKey, wrappedDek, epoch }` |
| 7 | 新人 | `GET /me` → 用 `sk` 解封 → 拿到 DEK → 完成 |

**两把锁，缺一不可**——这是相对上一版设计的关键改进：

| 锁 | 拦住什么 | 单独被突破的后果 |
| --- | --- | --- |
| 第 4 步的 `inviteSecret` | 防止拿到 `spaceId` 的人随手产生 join 申请 | 攻击者能产生一条 pending（**但仍拿不到 DEK**） |
| 第 5 步的 **owner 人工审批** | 防止捡到邀请码的人混进来 | 需要 owner 看走眼才会放行 |

所以即使 `inviteCode` 被第三方看到，攻击者能拿到的也只是「让 owner 看到一条陌生公钥的申请」。**这与原设计的本质区别是：`inviteSecret` 不再参与任何密钥派生**，泄漏它的损失从「能解密全部数据」降为「能提交一条申请」。

要点与代价：

- **`inviteSecret` 与 `memberToken` 都是 32B 高熵随机值**，服务器存哈希用 **SHA-256 即可**，不需要 scrypt（理由见 §16.3 的修正）。
- **公钥可公开，由服务器代传**：第 4 步把 `publicKey` 交给服务器、第 5 步 owner 从 `/pending` 取回——服务器只是字节搬运工，**owner 与新人不必直接通信**。这消掉了 §15.7(4)「邀请码必须带外分发」的约束（现在带外只是「方便」，不是「必须」）。
- ⚠️ **owner 必须在线一次**（第 5–6 步）才能发放 DEK。这是取舍的对调：上一版牺牲带外安全性换「新人立刻可用」，本版牺牲即时可用换「带外无秘密」。
- ⚠️ **公钥指纹核对是新引入的、必须做进 UI 的安全动作**。`GET /pending` 要返回公钥指纹（SHA-256 前 16 位十六进制），UI 显著展示，让 owner 能和对方口头确认。**没有这一步，第 5 步的「人工审批」就是摆设**——攻击者捡到邀请码也能让 owner 误批。
- `pendingRekey`（§16.5 #9）的含义：第 4 步之后、第 6 步之前，新人处于「已加入但拿不到 DEK」的状态。

**降级变体**：若走 §16.4 注 2 的对称方案，`inviteSecret` 必须重新承担密钥派生的职责，流程回到上一版形态——「邀请码 = 24h 内有效的成员凭据」的风险同步回归。

### 16.8 撤销与 rekey

撤销**必须与 rekey 成对执行**，否则被撤销者手上的 DEK 仍能解开后续所有 blob。

| 序 | 动作 | 原子性要求 |
| --- | --- | --- |
| 1 | `DELETE /members/{id}`：置 `revokedAt`，**立即**从鉴权生效（下次请求 401） | 单文件原子写 |
| 2 | owner 本地：新 `DEK'` = 随机 32B；对所有**未撤销**成员重包（含 owner 自己），写新 epoch | — |
| 3 | `POST /rekey`：一次性替换 `keys.json` 并递增 `meta.epoch` | ⚠️ **必须原子**：写临时文件 + `rename`。中途失败会出现「一部分人能解、一部分人不能」 |
| 4 | owner 用 `DEK'` 重加密当前 blob → `PUT`（带 `If-Match`） | 走正常 412 冲突流程 |

- 第 3 步之后、第 4 步之前，blob 仍是旧 DEK 加密的 —— 这正是 §16.4 的 `epoch-1` 回退要解决的窗口。
- 第 3 步会把被撤销者的包裹**整体丢弃**（不留任何 epoch），这是「撤销在协议层生效」的实际动作。
- **非对称方案让 rekey 变简单**：owner 只需要各成员的**公钥**就能重包，不需要任何人的秘密，也不需要谁在线配合——这是对称 KEK 方案做不到的（那时 owner 得持有每人的 `member_secret` 派生材料）。
- ⚠️ **不可收回的部分**：被撤销者此前已下载的明文、以及他手上前一个 epoch 的 DEK，都无法远程抹除。rekey 只保证「换 DEK 之后写入的数据他读不到」。UI 必须明说这是「踢出」而不是「远程擦除」，否则用户会误以为数据被收回了（§15.3、§15.9 同一结论）。

### 16.9 服务器存储布局

```
DATA_DIR/
  spaces/
    {spaceId}/
      meta.json      { spaceId, name?, ownerMemberId, createdAt, epoch, blobVersion, etag, updatedAt, deletedAt }
      members.json   [ { memberId, role, publicKey, addedAt, revokedAt, tokenHash } ]
      keys.json      { "<epoch>": { memberId: "sealed.…" } }   ← 每成员保留最近 2 个 epoch
      pending.json   [ { memberId, publicKey, requestedAt } ]
      invites.json   [ { inviteId, inviteSecretHash, expiresAt, usedAt, usedByMemberId } ]
      blob
      blob.history/v{n}
  {legacyServerKey}            ← 兼容保留（§16.10）
  {legacyServerKey}.meta.json
  {legacyServerKey}.history/
```

- 五个 JSON 全部**原子写**（临时文件 + `rename`），`members.json` / `keys.json` 的读改写需在进程内加锁（单进程 Node 下用一个 `Map` 做 per-space mutex 即可）。
- `members.json` 里存 `publicKey` 与 `tokenHash`——这正是服务器的职责边界：**它能验证「你是谁」（比对哈希）与「把包裹递给谁」（公钥是寻址信息），但不能替任何人解密**。`publicKey` 是公开材料，服务器读到它没有额外风险。
- `keys.json` 的值是 `sealed.…` 不透明字节，服务器**不解析**（验收用例 §16.15 第 9 条专门验证这一点）。
- `pending.json` 只存公钥与时间：owner 审批所需的材料，服务器无需理解其语义。

### 16.10 老 `server_key` 空间迁移

目标：**不重传数据、不重新加密 blob**，因为老 `server_key` 能被 owner 完整解密，不需要动数据本身。

1. **DEK 取现成值**：老方案的每个 blob 都是 `AES-GCM(PBKDF2(server_key, salt_of_that_blob))`。取**最新 blob 内嵌的 salt** 派生出那把密钥，**直接把它当作 DEK**。于是最新 blob 用新规则也读得开——**零数据搬运**。
2. 创建空间：`spaceId` 随机生成；owner **本地生成 X25519 密钥对** `(sk_owner, pk_owner)`，私钥存本机 keyring（`utils/secrets.rs`，service 名 `swallow`），用 `seal(pk_owner, DEK)` 写入 `keys.json` 的 `epoch = 1`；`meta.epoch = 1`。`server_key` 自此**只作为「能解开老 blob」的过渡材料**保留，不再参与新协议。
3. 把 blob 文件从 `{legacyKey}` 复制/移动到 `spaces/{spaceId}/blob`（**内容不变**），`blobVersion` 沿用或重置为 1；老文件保留一段时间作为退路。
4. **过渡期双寻址**：客户端先试 `/spaces/{id}`，收到 404 再回退 `/{serverKey}`；服务器两个路由都接受。
5. 老方案没有 epoch 概念，`meta.epoch` 从 1 起即可；`keys.json` 里只有 `"1"`。下一次 rekey 自然进入 epoch 2。

⚠️ 端到端加密层的**三代信封**（v1 / v2 / sealed）在这里都是必需的：第 1 步读的是 `v1` 老封装，第 2 步产出 `sealed` 包裹，**同一份 blob 要到迁移后第一次上传才变成 `v2`**。

⚠️ **`server_key` 不能立刻删**：`.history/` 里的历史版本各有自己的 salt、都是 `v1` 封装，要读它们仍然需要 `server_key`。所以迁移后它至少保留到「历史版本不再需要」为止——而它现在明文躺在 `config.toml`（§11.3 末条），这个待办因此更紧了。

### 16.11 错误码与语义

| 状态 | 何时 | 响应体 |
| --- | --- | --- |
| `400` | 标识格式非法（非 22 字符 base64url）、缺字段、`If-Match` 格式错 | `{ error, field? }` |
| `401` | 无/坏 `memberToken`，或成员已 `revokedAt` | `{ error:"unauthorized" }` |
| `403` | token 有效但角色不足 | `{ error:"forbidden", need:"owner" \| "editor" }` |
| `404` | 空间/版本/成员不存在 | `{ error, available? }` |
| `409` | `inviteId` 已被使用（§16.5 #3 重放） | `{ error:"invite used" }` |
| `410` | 邀请码已过期 | `{ error:"invite expired" }` |
| `412` | `If-Match` 不匹配（并发写） | `{ error:"precondition failed", etag, epoch }` |
| `413` | 超过 `MAX_BODY_MB` | `{ error }` |
| `429` | 超过 `RATE_LIMIT` | `{ error, retryAfter }` |

`412` 的响应**要带上当前 `etag` 与 `epoch`**——客户端需要它做三方合并（§15.7(1)），少一次往返。

### 16.12 零知识边界（相对 §15.4 的增量）

服务器在 §15.4 已知内容之外**新增可见**：角色分配、epoch 序号与变更次数（≈撤销/重包的频率）、邀请码的创建与使用时间、pending 成员数。

仍然**不可见**：`DEK`、任何 X25519 **私钥**、`inviteSecret`、业务数据任何内容。`wrappedDek`（`sealed.…`）对服务器是完全不透明的字节。

值得单独指出的**降级**：`publicKey` 是公开材料，服务器**可以**读到它——这不是泄漏，因为公钥的全部用途就是「让 owner 知道往哪封装」。真正的前提是**私钥永不上传**（§16.13 硬性要求）。对称方案下这里会是「服务器持有可被离线爆破的包裹」，非对称方案直接消掉了这个攻击面。

⚠️ 「重包频率」是新的侧信道：频繁 rekey 会向服务器暴露团队变动节奏。若在意，可把 rekey 与周期性轮换合并（固定周期做，而非仅撤销时做）。

### 16.13 安全清单

- [ ] `memberToken` 只在 TLS 上明文出现一次；日志**只记 token 指纹**（复用 v2 的 `fingerprint()` 套路）
- [ ] `tokenHash` / `inviteSecretHash` 用 **SHA-256**（不是 scrypt，理由见 §16.3），比对用 `timingSafeEqual`
- [ ] 客户端：**每次 `seal()` 必须生成新的 `eph_sk`**，绝不复用（§16.4）
- [ ] 客户端：解封前校验 `eph_pk` 与 `publicKey` 均为合法 X25519 点（32 字节、非低阶点），拒绝退化输入
- [ ] 每次请求判定 `revokedAt`（撤销即时生效），不依赖「记录消失」
- [ ] `spaceId` / `memberId` 严格正则校验后才拼路径（复用 v2 `blobPath` 的 `path.dirname` 校验）
- [ ] `publicKey` 只校验长度与字符集（32B base64url），**服务器不解析其密码学内容**
- [ ] `keys.json` / `members.json` 原子写 + per-space 进程内锁
- [ ] 邀请 `expiresAt` 由**服务器侧时间**判定，不信客户端；成功 join 即置 `usedAt`（防重放 → `409`）
- [ ] 限流按 `memberId` 维度**再加一层**（v2 的按 IP 在团队/NAT 场景不够）
- [ ] `POST /spaces` 受 `SPACE_CREATE_TOKEN` 保护（§16.5 注 1）
- [ ] 角色判定顺序 401 → 403 → 404，不泄漏空间存在性
- [ ] **`/pending` 必须返回公钥指纹，UI 必须显著展示**——否则 §16.7 的 owner 审批形同虚设
- [ ] 响应体**永不回显** `tokenHash` / `inviteSecretHash` 等内部字段（`/members` 只给 `publicKey` 与角色、时间）

### 16.14 对 `server.cjs` 的增补点（实现指引）

可直接复用的 v2 部件：`envInt` / `safeName` / `blobPath` 的穿越校验思路 / `etagOf` / `statOrNull` / `readSidecar` / `writeSidecar`（原子写）/ `listHistory` / `archiveCurrent` / `pruneHistory` / `blobHeaders` / `logRequest` / `reply` / `readBody` / `rateLimited` / `fingerprint`。

需新增：路由前缀分派（`segments[0] === 'spaces'` 与 legacy 分流）、`loadSpace()` / `saveSpace()` 系列（含 per-space 锁）、`authenticate()`（Bearer → memberId + role + revoked 判定）、`requireRole()` 中间件、§16.5 的 15 个端点处理器、`publicKey` 与 `wrappedDek` 的**原样存转**（服务器绝不解析其内容）。

⚠️ 顺带提一句：非对称方案的复杂度**几乎全在客户端**（密钥对生成/存储/封装/解封/指纹），服务端反而比对称方案更简单——它连 `kdf` 参数都不用存了。

⚠️ `SERVER_VERSION` 需递增（v2 → v3，或引入 `apiVersion`），并在 `GET /` 的服务描述里列出空间端点，便于排障。

### 16.15 验收用例（`curl` 可验证）

1. 建空间 → `201`；重复 `spaceId` → `409`；非法 `spaceId`（含 `/`、`..`、长度不符）→ `400`
2. 无 token 读 → `401`；viewer `PUT` → `403`；owner `PUT` → `200`
3. `If-Match` 过期 → `412`，且响应带当前 `etag` 与 `epoch`
4. 创建邀请 → `/join` 带**正确** `inviteSecret` → `202`；**缺或错的 `inviteSecret` → `401`**；同一 `inviteId` 再次 join → `409`；已过期 → `410`
5. owner `GET /pending` 拿到 `publicKey`（服务器不解析）；`PUT /members/{id}` 后新人 `GET /me` 拿到 `wrappedDek` 并**用私钥解封成功**
6. **公钥错配**：用 B 的公钥封装、拿 A 的私钥去解 → GCM 认证失败（必须失败，不得返回垃圾明文）
7. **封装不可复用**：对同一 `DEK` + 同一公钥连续 `seal()` 两次 → 两次输出**必须不同**（验证 `eph_sk` 每次新生成）
8. **inviteSecret 不参与解密**：从零构造一个「攻击者」流程——拿到 `inviteCode` 完成 join，但 owner**不审批** → 攻击者 `GET /me` 只能看到 `pendingRekey`，**在任何路径上都拿不到 DEK**
9. **公钥指纹一致**：`/pending`、`/members`、`/me` 三处返回的指纹互相一致，且等于本地对 `publicKey` 求 SHA-256 的结果
10. rekey：`epoch` 递增、`keys.json` 只剩 2 个 epoch、被撤销者条目**完全消失**
11. **撤销即刻生效**：`DELETE /members/{id}` 后其 token 立即 `401`
12. **epoch 回退**：rekey 后、blob 未重加密时，用 `epoch-1` 的 DEK 仍能读出旧 blob；重加密后只能用新 DEK
13. **服务端零解析**：把 `wrappedDek` 写成非密文的 `"hello"` 再取回，字节完全一致——证明服务器没有尝试解密
14. 迁移（§16.10）：对老 `{serverKey}` 数据执行迁移 → 用**由 `serverKey` + 最新 blob 内嵌 salt 派生出的 DEK** 能读出原 blob，**内容逐字节一致**，且期间**没有任何重加密上传**
15. 角色越权矩阵逐格验证（§16.6 共 6 行 × 3 列）
16. 限流按 member 生效：同一 IP 两个不同 token 各自计数
17. 降级变体（§16.4 注 2）：走对称 KEK 时同一套端点全部通过（除第 6、7 条按对称语义调整）

---

## 17. 专题：账户 / 身份体系设想

> ⚠️ 本节是**路线图设想**，不是现状；也**不是 §16 的前置**。§16 的成员制空间可以独立落地——它只需要「每成员一个密钥对」，并不需要服务器认得「一个人」。本节要解决的是：把「一个人 + 他的多台设备 + 他在多个空间里的成员身份」这三层组织起来。

### 17.1 动机：§16 留下的三个体验缺口

§16 落地后仍然别扭的地方，几乎都源于「服务器不知道你是谁」：

| 缺口 | §16 落地后的现状 | 身份体系能提供的 |
| --- | --- | --- |
| 多空间各记一套凭据 | 每个空间一份 `memberToken`，用户要在 N 个空间各配一次 | 一次登录，客户端自动列出「你在哪些空间、什么角色」 |
| 邀请靠人传 | 邀请码要发出去，owner 还要在 `/pending` 里人工核对公钥指纹 | 按身份投递：owner 选中「某人」，对方登录即收到申请 |
| 设备不可见 | 每台设备一个密钥对，服务器不知道它们属于谁 | 设备列表、用已有设备授权新设备、单设备撤销 |

⚠️ **反向也要说清**：身份体系**不解决**「邀请码要带外」——那个已由 §16.7 的公钥方案解决。它解决的是**发现与组织**。

### 17.2 为什么不用「邮箱 + 密码」

零知识系统里账号密码是坏主意，三个理由：

1. **密码没有加密价值**：数据是客户端加密的，服务器不需要知道任何秘密就能保护它；密码唯一的作用是让服务器「认得你」。既然如此，不值得为它承担密码学风险。
2. **它会变成新的可拖库目标**：服务器一旦存密码哈希，被拖库就有离线爆破面；而若为了「新设备恢复私钥」把私钥用密码加密后上传，**服务器就持有了可爆破的密钥材料**——零知识在这一步塌掉。
3. **它必然诱导出「密码找回」**：能找回就意味着有第三方能重置你的凭据。在零知识模型里，这等价于「有人能接管你的身份」。

**正确形态：密钥对 + 签名认证（无密码）。**

```
注册：本地生成 ed25519 密钥对 → 只上传公钥（+ 显示名）
登录：客户端请求 challenge → 服务器返回随机数 → 客户端用私钥签名 → 服务器验签
会话：短期会话 token（可过期、可撤销），后续请求用它
```

服务器存的只有公钥与显示名——**没有任何可爆破的东西**。

### 17.3 三层身份模型

| 层 | 标识 | 密钥 | 私钥位置 | 作用 |
| --- | --- | --- | --- | --- |
| 身份 | `identityId` + 显示名 | ed25519（签名） | 本机 keyring | 「一个人」：投递邀请、列空间、目录搜索 |
| 设备 | `deviceId` | 各自一对 ed25519 | 本机 keyring | 登录与签名；一台设备一把，可单独撤销 |
| 成员 | `memberId` | X25519（封装 DEK） | 本机 keyring | 某空间里的成员身份，用于解封 DEK（§16.4） |

关键约束：**`memberId` 与 `identityId` 不必一一对应**。同一身份在不同空间可以是不同 `memberId`（切断跨空间关联），也可以复用——这是 §17.9 要权衡的取舍。

### 17.4 私钥存放与多设备（最难的一环）

私钥**只存本机 keyring**（`utils/secrets.rs`，service 名 `swallow`，与现有 6 类凭据一致）。随之而来的是「新设备怎么拿到身份」：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **已有设备授权**（推荐默认） | 新设备生成自己的密钥对 → 显示配对码（含其公钥）→ 在已登录设备上确认 → 老设备为「新设备加入身份」签名 | ✅ 服务器上没有任何可爆破材料；❌ 需要一台已有设备在线 |
| **恢复码** | 注册时本地生成高熵恢复码（24 词 / 长 base32），抄写或打印保存；新设备输入后重建身份密钥 | ✅ 不需要其他设备；❌ 恢复码 ≈ 一份私钥备份，必须物理保管 |
| ❌ 服务器托管私钥 | 私钥用账号密码加密后上传 | **不做**——正是 17.2 要避开的：服务器持有可爆破的密钥材料 |
| ❌ 邮箱找回 | 靠邮箱验证重置身份 | **不做**——等于第三方能接管你的身份，零知识模型下不可接受 |

默认走「已有设备授权」；「恢复码」作为可选备份在注册后提示一次，并明确告知**它等同于你的身份**。

### 17.5 端点演进（叠加在 §16 之上）

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/identities` | POST | 注册：`identityId` + 设备公钥 + 显示名（与 `SPACE_CREATE_TOKEN` 同级防护） |
| `/identities/{id}/challenge` | POST | 取登录 challenge（随机数 + 有效期） |
| `/identities/{id}/session` | POST | 提交签名，换短期会话 token |
| `/identities/{id}/devices` · `/devices/{deviceId}` | GET / DELETE | 列设备、撤销单设备（需另一台设备或恢复码签名） |
| `/identities/{id}/spaces` | GET | 列出「我在哪些空间、什么角色、`epoch`、是否需要重新封装」 |
| `/identities/{id}/invitations` | GET | 待我处理的邀请（替代 §16.7 的手工传码路径） |
| `/directory?q=` | GET | 按显示名搜索身份（**默认关闭**，见 §17.6） |
| `/spaces/{id}/invites` | POST | 扩展：`{ …, inviteeIdentityId? }` —— 带此字段时走身份投递 |

⚠️ **会话 token 与 §16 的 `memberToken` 是两套东西**：前者证明「你是某身份」，后者证明「你是某空间的某成员」。**不要**在 §16 的鉴权里直接接受身份会话——否则一次身份登录就等价于所有空间的访问权。空间访问必须仍由空间成员身份判定（§16.6）。

### 17.6 泄漏面增量：服务器会看到「组织架构图」

这是最需要向用户交代的代价。叠加在 §15.4 与 §16.12 之上，服务器新增可见：**身份 ↔ 设备 ↔ 空间 ↔ 角色** 的完整关系、显示名、设备数量与各自活跃时间、邀请投递记录、目录搜索行为。

**零知识保护的是业务数据，保护不了「谁和谁在一起工作」这个事实。** 三个缓解手段：

1. **目录搜索默认关闭**，且开启后只对同空间成员可见；
2. **允许每空间使用独立 `memberId`**（切断跨空间关联——注意这也是个取舍：关联性消失的同时，"同一人在多空间"的审计能力也消失）；
3. **显示名允许化名**，不强制邮箱或真名。

### 17.7 命名约定：叫「身份」，不要叫「账号」

⚠️ **`账号` 在本项目已被占用**，指的是 SSH 登录账号：

| 现有占用 | 位置 |
| --- | --- |
| `menu.account: '账号'` | `src/i18n/locales/zh-CN.ts:94` |
| `account.title: 'Account Management'`（账户管理） | `src/i18n/locales/en-US.ts:1048` |
| `cloudCategory_accounts: '账号'` | `src/i18n/locales/zh-CN.ts:384` |
| `Account` 模型与 `accounts` 表 | `src-tauri/src/models/data.rs` |

所以云侧身份**必须另起名字**：中文**「身份」**（或「云身份」），英文 **`identity`**，i18n key 用 `identity.*` 前缀。§16 里「成员」已经指「空间里的成员」，第三个概念再叫「账号」会直接毁掉文案可读性。同理 `member` / `device` 也各有独立中文词（成员 / 设备）。

### 17.8 迁移与兼容

1. **身份层是纯新增**，不改动 §16 的任何契约；已有 `memberToken` 的成员继续走原路径。
2. **两套凭据长期并存**：可选收敛做法是让身份会话**换取**空间成员的 `memberToken`（服务器在换取时校验「身份 ↔ 成员」绑定），避免用户保存 N 个 token。
3. **`/identities/{id}/spaces` 是客户端启动主入口**：登录后拉一次就知道该为哪些空间准备包裹、哪些需要 owner 重新封装（`pendingRekey`）。
4. 老 `server_key` 空间的 owner 完成 §16.10 迁移后，顺手注册一个身份即可，不冲突。

### 17.9 非目标与反模式

- 不做 SSO / OIDC / LDAP / SAML——企业目录集成走自建网关（同 §15.8）。
- 不做「忘记密码」（没有密码）、不做服务器端通讯录 / 在线状态 / 即时消息。
- 不做管理员超权账号——「root 能看所有人数据」与零知识直接矛盾。
- ⚠️ **反模式**：
  - 身份会话直接授予所有空间访问权（绕过 §16.6 的角色判定）；
  - 用**低熵**的显示名 / 邮箱当 `identityId`（会变成枚举与关联攻击入口，`identityId` 必须随机）；
  - 为了让目录搜索好用而强制真实邮箱（把「组织架构图」升级成「实名组织架构图」）；
  - 在服务器存「身份 ↔ 明文成员」映射以便「方便管理」（摧毁零知识的全部收益）。

### 17.10 依赖次序与风险小结

**依赖**：本节**硬依赖 §16 落地**（没有空间 / 成员 / rekey，身份层没有承载体），而 §16 又硬依赖 §14 第 7、8 步。总顺序：

```
§14-7/8（多写者正确性 + 可换密钥）
   └─▶ §16（成员制空间：空间 / 成员 / 角色 / rekey / 迁移）
          └─▶ §17（身份：多空间登录、邀请投递、设备管理）
```

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 私钥丢失 = 该设备不再能解数据 | 高 | 「已有设备授权」+「恢复码」双路径；注册后强制提示备份 |
| 用户把「身份」误解为「权限」 | 中 | 文案明确区分「身份（你是谁）」与「成员角色（你能做什么）」 |
| 组织架构图泄漏 | 中 | §17.6 三条缓解；目录搜索默认关闭 |
| 与既有「账号」文案混淆 | 中 | §17.7 命名约定，落到 i18n 前缀 `identity.*` |
| 跨空间可关联性被利用 | 低–中 | 允许每空间独立 `memberId`（§17.3 的取舍） |
| 复杂度第三次翻倍 | 高 | 身份层必须**可缺席**：不注册身份时 §16 全部路径照旧可用 |

⚠️ 最后一条是本节最重要的工程约束：**身份层只能是可选的叠加，不能是 §16 的前置**。任何「不注册身份就不能协作」的设计都应被拒绝——那会让这个功能变成所有单机 / 小团队用户的门槛。

---

## 18. 附录：关键函数索引（`services/cloud_sync.rs`）

| 关心… | 看这里 |
| --- | --- |
| 常量 / 版本 | `PACKET_VERSION` :26、`MIN_READABLE_VERSION` :28 |
| 返回结构 | `SyncReport` :33、`SyncSkipped` :48 |
| packet 结构 | `CloudPacket` :127、`SyncedSettings` :93、`SyncedKnownHost` :115、`SyncedKey` :57、`SyncedCert` :81 |
| 采集 | `collect_packet` :312、`collect_keys` :171、`collect_certificates` :207、`collect_port_forwardings` :223、`collect_settings` :264、`collect_known_hosts` :285 |
| 恢复 | `apply_packet` :853、`restore_hosts` :436、`restore_accounts` :514、`restore_sftp_connections` :554、`restore_port_forwardings` :600、`restore_snippets` :652、`restore_remote_conns` :682、`restore_keys` :359、`restore_certificates` :392、`restore_known_hosts` :721、`restore_monitor_state` :770、`restore_settings` :799 |
| 合并（仅新增） | `merge_packet_new_only` :1264、`existing_ids` :1305、各 `merge_*_new_only` :1315-1441 |
| URL / 传输 | `build_base_url` :912、`host_has_explicit_port` :933、`url_encode_path_segment` :951、`upload_packet` :968、`download_packet` :994、`fetch_meta` :1040 |
| 命令 | `cloud_sync_now` :1127、`cloud_sync_state` :1118、`cloud_test_connection` :1054 |
| 状态文件 | `SyncStateFile` :1094、`read_sync_state` :1101、`write_sync_state` :1109 |
| 加密 | `utils/crypto.rs`：`encrypt` :29、`decrypt` :57、`derive_key` :17 |
| 服务端 | `cloud-server/server.cjs`（665 行，v2）、`cloud-server/README.md` |
| 前端 | `pages/settingsComponents/CloudSettings.tsx`、`services/dataService.ts:512-560`、`App.tsx:141-150` |
