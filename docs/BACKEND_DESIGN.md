# Swallow Rust 后端系统设计文档

> 范围：`src-tauri/`（Tauri 2 + Rust）。对照代码版本：v0.2.2 之后（russh 主路径 + ssh2 回退、packet v2 云同步）。
> 目标读者：后续维护者 / 重构执行者。本文描述**现状是什么、为什么这样设计**，以及**下一步往哪里改**。

---

## 0. 目标与非目标

### 目标

- 一套 Rust 后端同时服务 8 类会话：SSH 终端 / SFTP / Telnet / 本地 shell / VNC / RDP / MOSH / 串口，外加端口转发隧道、免 Agent 服务器监控、云同步。
- 凭据与密钥材料**永不以明文落盘**：密码进系统钥匙串，密钥/证书内容进 SQLite，连接时只用临时文件或纯内存。
- 交互延迟优先：按键直达、输出合帧渲染，不为了吞吐牺牲实时性。

### 非目标

- 不做移动端（另有项目承载，见 `docs/mobile-porting.md`，本仓库忽略）。
- 不做多窗口；会话以 `session_id` 为键，单进程内管理。
- 云同步的 `cloud-server/server.cjs` 只是参考实现，不在本后端设计范围内（只定义协议）。

---

## 1. 技术栈与进程模型

| 选型       | 版本 / 说明                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| Tauri    | 2.x，`#[tauri::command]` + `invoke_handler!` 注册（见 `src/lib.rs`）                                     |
| 异步运行时    | tokio `full`（见 `Cargo.toml:33`）                                                                    |
| SSH 主后端  | russh `=0.60.1`，`[patch.crates-io]` 指向 `vendor/russh`（RustCrypto rc 冲突的本地补丁，见 `Cargo.toml:95-101`） |
| SSH 回退后端 | ssh2 `0.9`（`vendored-openssl`，仅 DSA / 老设备 / 传统 PEM 时启用）                                            |
| 数据库      | rusqlite `0.32`（`bundled`，单文件 `data.sqlite3`）                                                      |
| 凭据       | keyring `3`（按 OS 切 backend：`windows-native` / `apple-native` / `sync-secret-service`）              |
| 云同步加密    | AES-256-GCM + PBKDF2-SHA256（10 万次），包格式 `v1.{salt}.{nonce}.{cipher}`（见 `utils/crypto.rs`）           |
| 错误       | anyhow（内部）+ `Result<_, String>`（IPC 边界，待改造，见 §12）                                                  |

进程模型：单 Tauri 主进程。前端经 `invoke` 调命令，后端经 `app.emit("session-{id}", SessionEvent)` 推事件（见 `src/session_events.rs`）。**命令是请求/响应，事件是单向推送**，两者不混用。

---

## 2. 目录结构与分层

```
src/
  lib.rs               # AppState + run() + invoke_handler 注册表（唯一入口）
  main.rs
  session_events.rs    # SessionEvent 枚举 + emit_session_event（前后端事件契约）
  os_drop_paths.rs     # Windows WebView2 拖拽桥（cfg(windows)）
  commands/            # IPC 装配层：参数校验 + 调 session/services + 返回 ConnectResult
    mod.rs             # ConnectResult + read_connection_timeout
    ssh.rs             # ssh_connect/write/resize/disconnect/list + 后端选择 + ssh2 回退
    tunnel.rs          # start/stop/list_port_forwards（隧道建连装配）
    sftp.rs / telnet.rs / local.rs / serial.rs / monitor.rs
    mosh.rs / vnc.rs / rdp.rs / ai.rs / misc.rs
  ssh/                 # SSH 协议层（双后端实现，不懂 DB、不懂前端）
    session.rs         # ssh2：SshConfig / 建连 / shell / 读线程 / 写退避 / OS 探测
    manager.rs         # ssh2 会话注册表（HashMap + disconnect handler 自清理）
    russh_backend.rs   # russh：connect/认证/主机密钥回调/算法预设/跳板
    russh_shell.rs     # russh 交互 shell：读写分离 + 输出泵
    russh_tunnel.rs    # russh 隧道
    tunnel.rs          # ssh2 隧道 + TunnelManager
    host_keys.rs       # 主机密钥校验/待确认 token/accept 分派
  services/            # 数据 + 业务服务（DB + keyring，原则上不调 SSH）
    hosts.rs / accounts.rs / keys.rs / certificates.rs
    sftp_connections.rs / snippets.rs / known_hosts.rs / remotes.rs
    port_forwardings.rs  # ⚠️ 例外：含 resolve_host_ssh_config（应迁往 ssh/auth，见 §17）
    sessions.rs / session_log.rs / logs.rs / monitor_state.rs
    cloud_sync.rs      # 云同步 packet v1/v2 + 上传/下载/双向合并
    local_fs.rs / common.rs / mod.rs
  models/
    data.rs            # DB 行结构（Host/Account/KeyRecord/.../PortForwarding）
    config.rs          # Config 全量配置（含 context_menu / monitor_alerts）
    log.rs / mod.rs
  config/
    global_config.rs   # GlobaConfig（内存态 Config，见 §9）
    global_enum.rs / mod.rs
  utils/
    sqlite.rs          # open_connection + init_database + ensure_column 迁移
    secrets.rs         # keyring 读写删
    crypto.rs          # 云同步加解密
    file.rs / path.rs / init.rs / mod.rs
  local/ / monitor/ / mosh/ / rdp/ / serial/ / sftp/ / telnet/ / vnc/ / platforms/
```

### 分层规则（现状 → 目标）

| 层            | 职责                                  | 现状问题                                                                                 |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `commands/*` | 纯装配：读配置、选后端、调 session、返回            | 基本达标；`ssh.rs` 的回退判定保留在此层是对的                                                          |
| `ssh/*`      | 纯协议：建连/认证/通道/泵，不碰 DB                | 达标；唯 `host_os_probe_policy` 回查 `services/hosts`（可接受，探测策略）                            |
| `services/*` | DB + keyring CRUD                   | **破例**：`port_forwardings::resolve_host_ssh_config` 在拼 `SshConfig`（应迁到 `ssh/auth.rs`） |
| `utils/*`    | sqlite/secrets/crypto/path/file/log | 达标；缺统一错误类型                                                                           |
| `models/*`   | serde 行结构                           | 达标；`Host` 的 `password` 等字段是传输占位，DB 列恒空（见 §10）                                        |

---

## 3. 运行时状态（`lib.rs:AppState`）

```rust
pub struct AppState {
    ssh: Mutex<SshManager>,        // ssh2 交互会话
    sftp: Mutex<SftpManager>,
    telnet: Mutex<TelnetManager>,
    local: Mutex<LocalShellManager>,
    tunnels: Mutex<TunnelManager>, // 端口转发（russh/ssh2 混合 RunningTunnel）
    monitor: Mutex<MonitorManager>,
    serial: Mutex<SerialManager>,
    vnc: Mutex<VncManager>,
    rdp: Mutex<RdpManager>,
    mosh: Mutex<MoshManager>,
    russh_shells: Mutex<HashMap<String, Arc<ShellSession>>>, // russh 交互主路径
    transfer_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>, // SFTP 取消标志
}
```

要点：

- 10 个 Manager + 2 张表，全是 `std::sync::Mutex`。**async 上下文中只允许短持锁**（clone 出 `Arc` 后立即释放，不跨 `.await`）——`commands/ssh.rs` 的注释inse多处强调这一点。
- `GlobaConfig`（`config/global_config.rs`）另行 `manage`，内存态 `RwLock<Config>`，是配置的唯一真相源（见 §9）。
- `run()` 的 `setup` 只做三件事：装 rustls ring provider、Windows 下透明 WebView + 拖拽桥、后台线程跑 `utils::init::init()`（config + DB + session-logs 目录）后关 splash。

---

## 4. 命令层（`commands/*`）

每个协议一个文件，函数签名模式统一：

```
{proto}_connect(state, config_state, app_handle, session_id, config, cols, rows) -> ConnectResult
{proto}_write(state, session_id, data)
{proto}_resize(state, session_id, cols, rows)
{proto}_disconnect(state, session_id)
{proto}_list_sessions(state) -> Vec<String>
```

关键设计（以 `commands/ssh.rs` 为例）：

1. **会话复用检查**：先查 `ssh.manager` 再查 `russh_shells`，存在即直接返回 `connected`（标签切换/重挂载不重复建连）。
2. **认证材料装载**（`prepare_ssh_auth_material`）：按 `key_id` / `cert_id` 从 DB 读内容进内存，不落盘。
3. **后端选择**：`ssh.ssh_backend ∈ {auto|russh|ssh2}`（空串按 auto）+ 主机级 `host.backend` 覆盖。
   - `auto`（默认）：先 russh，`is_ssh2_fallback_eligible(&e)` 才回退 ssh2（DSA / 传统 PEM / 无共同算法）。
   - 主机密钥 `Mismatch` / `KeyChanged` / 待确认流程**永不回退**（安全错误换后端只会复现）。
4. **线程模型**：russh 路径纯 async 直接 await；ssh2 路径包进 `spawn_blocking`（阻塞 I/O 不占 tokio worker）。
5. **写路径**：russh 会话 clone `Arc<ShellSession>` 出锁再 await；ssh2 会话包进 `spawn_blocking(session.write_data)`。

`commands/tunnel.rs` 同理：russh 建连 + `on_disconnected` 事件回调 + 进度事件（`port-forward-status`），失败才走 ssh2 `establish_authenticated_session` + `start_tunnel`。

---

## 5. SSH 双后端设计

### 5.1 为什么有两个后端

- russh：纯 Rust async，无 Session 级大锁，并发 channel 不串行化——**交互终端与隧道的主路径**。
- ssh2（libssh2）：同步阻塞 API，Session 是全局锁，但兼容 DSA 主机密钥 / DSA 客户端 key / 传统 PEM——**仅作回退**。
- `vendor/russh` + `[patch.crates-io]` 是因为 ironrdp→picky 把 RustCrypto 锁成 `=` 精确 pre 版本，0.60.2+ 无法收敛。**不要 `cargo update` russh**，升级要整体核对。

### 5.2 `SshConfig`（`ssh/session.rs`）

前后端共用同一配置结构：`host/port/username/auth_type/password/key_id/private_key/public_key/cert_id/cert_content/cert_private_key/passphrase/proxy/backend/algo_profile`。`proxy: Option<Box<SshConfig>>` 天然支持链式跳板（解析层防循环，见 `port_forwardings::resolve_host_ssh_config_inner` 的 visited 集）。

### 5.3 传输层差异

|           | ssh2（`establish_transport`）                                | russh（`russh_backend::connect_inner`）                                                       |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 直连        | `TcpStream::connect_timeout` + `set_nodelay(true)`         | tokio TCP + `nodelay: true`（client Config）                                                  |
| 跳板        | loopback 对桥接（`set_tcp_stream` 只要真实 socket）+ `io::copy` 双向泵 | direct-tcpip channel 直接作传输层，无桥接                                                             |
| keepalive | 读线程按 `keep_alive_interval` 调 `keepalive_send()`            | `keepalive_interval: 30s / keepalive_max: 3`，`inactivity_timeout: None`（空闲自断是 bug 级语义，隧道禁用） |
| 算法        | libssh2 默认全开                                               | `preferred_for_algo_profile`：`""` 现代优先+老算法追加兜底；`legacy` 老算法置顶；`hardened` 去 ssh-rsa          |

### 5.4 主机密钥（`ssh/host_keys.rs` + 两后端回调）

- 信任源唯一：SQLite `known_hosts`（`known_host_key_entries()` 装载，`insert_known_host` 写入，`[host]:port` 非标端口格式）。
- 未知密钥 → 两后端都转 `HostKeyApprovalRequired` → 前端弹指纹确认 → `accept_host_key(token, fingerprint)` 按**原后端重建验证**（两库协商的 host key 算法可能不同，跨后端重建指纹必 mismatch）。
- 确认后失效 OS 探测缓存（`invalidate_os_cache`）。

### 5.5 OS 探测（`ssh/session.rs:probe_remote_os`）

shell 通道打开**之前**执行（三条独立简单命令，兼容 csh/tcsh）：`uname -s` + `cat /etc/os-release` + `cat /etc/redhat-release` 兜底。`normalize_os_id` 与前端 `osLogo` key 对齐。策略：主机已手动设图标或 `os_auto=false` 则跳过；命中 `OS_CACHE` 不再发命令；结果经 `SessionEvent::OsDetected` 上报，前端回写 `host.icon`。

---

## 6. 会话与事件模型

### 6.1 事件契约（`session_events.rs`）

```rust
pub enum SessionEvent {
    Output { data: String },
    Disconnected,
    Error { message: String },
    Progress { stage: String, message: Option<String> }, // tcp/ssh/auth/shell/ready
    OsDetected { os: String },
}
```

通道名 `session-{session_id}`。**不要新增事件类型**：新需求先看能否装进现有五种（进度 message 足够表达阶段细节）。

### 6.2 russh shell 会话（`ssh/russh_shell.rs`，延迟优化后的形态）

- `spawn()` 内同步完成 connect + PTY + shell，失败（含待确认）直接透传；成功后 `channel.split()`：
  - `ChannelWriteHalf`（Send+Sync）→ `Arc<tokio::Mutex<…>>` 给 `ShellSession`，IPC 写/resize 直用；
  - `ChannelReadHalf` → 后台 `run_output_pump`，只做 `wait()` + 增量 UTF-8 解码 + emit。
- **读写彻底分离**：写不再经 mpsc/select 排队，高频输出不再阻塞按键（此前 `tokio::select!` 输出臂持续就绪导致写排队，是“跳跃延迟”的主因之一）。
- 写分片：小包（≤256B）单次直发；长数据按 `writable_packet_size()` 切片，尊重服务端窗口。
- 泵退出即视为远端结束：显式 disconnect + emit `Disconnected` + 清 `russh_shells`（否则复用检查把死会话当活会话）。

### 6.3 ssh2 会话（`ssh/session.rs`，回退路径）

- `start_shell` 后起阻塞读线程：8KB 块读 + 跨块 UTF-8 增量解码 + `WouldBlock` 时 10→100ms 指数退避（空闲省 CPU、有数据立即复位）。
- 写 `write_data`：`WouldBlock`/写 0 时 1→64ms 退避，30s deadline，**绝不调 `flush()`**（libssh2 flush 语义是丢接收缓冲，会丢回显）。
- `disconnect_handler`（`manager.rs`）：EOF/错误时从注册表自移除，防僵尸会话。

---

## 7. 延迟设计（输入→回显全链路）

```
按键 → xterm onData → enqueueWriteToTargets → invoke ssh_write
  → ShellSession::write（直发） → SSH 包 → 服务端回显
  → run_output_pump → emit Output → listen 回调 → rAF 合并 → terminal.write
```

三条铁律（都是已踩过的坑）：

1. **输入不攒批**：前端短输入（≤64 字符，`WRITE_DIRECT_MAX`）直接进串行队列立即发送；长粘贴按 256KB 切片。15ms 微批已删除（每个按键固定 +15ms 是可感知的“肉”。
2. **读写不互斥**：russh 读写半端分离；ssh2 读写各持短锁，写退避期间释放 channel 锁让读线程排空。
3. **输出合帧**：前端 `queueOutput` 把同 rAF 内的 Output 事件合并成一次 `terminal.write`，与刷新率对齐；replay 快照只在合并块上跑一次。

串行队列（`enqueueWrite`）保留：同会话同时只在途一个 invoke，按序完成，防 IPC 洪泛压垮后端。不允许为了“更快”而并发写同一会话。

---

## 8. 数据层（`utils/sqlite.rs` + `services/*`）

### 表（`init_database`）

`hosts` / `accounts` / `keys` / `certificates` / `sftp_connections` / `snippets` / `logs` / `known_hosts` / `remote_conns` / `port_forwardings` / `monitor_state`。

迁移策略：`CREATE TABLE IF NOT EXISTS` + `ensure_column` 逐列补（如 `hosts.group_name/tags_json/favorite/backend/algo_profile/os_auto`、`port_forwardings.auto_connect/socks_*`）。**现状缺失**：无 `user_version` 版本表、无 WAL（见 §17 改造项）。

连接管理：每次 `open_connection()` 新开连接，用完即关。简单可靠，但高频路径（日志、隧道状态）注意别在循环里反复 open。

### 凭据模型（`services/common.rs` + `utils/secrets.rs`）

- `resolve_secret(db_value, key)`：DB 明文优先（未迁移旧数据），否则读 keyring。
- `store_secret_or_clear(key, value)`：空值即删 keyring 条目。
- 命名：`hosts/{id}/password`、`hosts/{id}/proxy_password`、`accounts/{id}/password`、`sftp/{id}/password|passphrase`、`portforwardings/{id}/socks_password`、`remote/{id}/password`。
- DB 中对应列恒存空串占位。**keyring 无枚举 API**，批量清理（如 `delete_all_data`）必须按表扫 id 逐个删——`commands/misc.rs:delete_secrets_by_prefix` 就是这么做的，remote/monitor 纳入时别漏。

### 云同步（`services/cloud_sync.rs`）

- packet `VERSION=2`，`MIN_READABLE_VERSION=1`（v1 老包仍可读）。
- v2 新增：`remote_conns`、`known_hosts`、`monitor_state`、`settings` 全段（appearance/terminal/ssh/security/advanced/ai/context_menu/monitor_alerts）。`cloud` 段永不进包。
- 方向：`upload` / `download` / `bidirectional`。双向 = 云端新增条目落本地（同 id 保留本地并计入 `skipped`）→ settings 覆盖 → 全量回传。`SyncReport{counts, skipped, timestamp}` + 落盘 `cloud-sync-state.json`。
- `known_hosts` 按 host+key_type 去重（保留本地信任）；`monitor_state` 剔除本地不存在的主机并计入跳过。
- 命令：`cloud_sync_now` / `cloud_sync_state` / `cloud_test_connection`（`GET /healthz` + `/{key}/meta`）。

---

## 9. 配置（`models/config.rs` + `config/global_config.rs`）

- 文件 `config.toml`（`CONFIG_FILE`），缺字段 serde default 兜底，损坏则备份 `.toml.bak` 后回默认（`utils/file.rs:init_config`）。
- 内存态 `GlobaConfig { config: RwLock<Config> }`，`get_config` 克隆读，`update_config` 全量写 + 落盘 + `set_max_logs`。
- 前端 `store/config.ts` 经 `saveChain` 串行落盘，防并发乱序覆盖。
- 段：application / cloud / appearance（含 themes） / terminal（含 themes/render_engine/session_log/autocomplete/右键行为）/ ssh（timeout/keepalive/重连/backend）/ shortcuts / security / advanced / ai（多 profile）/ context_menu（右键宏）/ monitor_alerts（阈值+冷却）。

---

## 10. 安全设计

| 环节          | 实现                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 密码/口令       | keyring only，DB 列清空                                                                                                          |
| 密钥/证书内容     | SQLite `private_key/public_key/cert_content/private_key_content` 列                                                           |
| 连接时使用       | ssh2：`tempdir + fs::write` 后 `userauth_pubkey_file`，dir 析构即删（Windows 下 `NamedTempFile` 独占句柄会导致 libssh2 拒绝访问，故不用）；russh：纯内存解析 |
| 云同步         | AES-256-GCM，server_key 经 PBKDF2-SHA256(100k) + 随机 salt 派生，服务端只存密文                                                            |
| known_hosts | 纯 DB，不读不写 `~/.ssh/known_hosts`                                                                                               |
| 会话恢复        | 密码/passphrase 永不落 `sessions.json`，恢复后需手动重连                                                                                   |

待补（见 §17）：内存 Secret 用 `zeroize::Zeroizing` 包裹，`Drop` 清零；目前是普通 `String`。

---

## 11. 日志与可观测

- `services/logs.rs`：`logs` 表 + `MAX_LOGS`（AtomicU32，默认 1000，配置刷新）。`append_log`（明文）/ `append_log_i18n`（key+params，前端按语言渲染）。`write_log` 每次 open 新连接——**高频路径禁用**（keepalive、隧道看门狗、采集循环只在失败时记）。
- 会话日志（`services/session_log.rs` + 前端 `sessionLog.ts`）：start/append/close 三命令，open-写-关无长驻句柄；前端 500ms 节流 + 64KB 阈值刷盘；replay 格式 1s 最多一个快照。
- 诊断现状：`eprintln!` 散落各处。改造方向：`tracing` + `tauri-plugin-log`，按 `session_id` 打 span（见 §17）。

---

## 12. 错误处理（现状 → 目标）

现状：`Result<T, String>` 贯穿 IPC 边界，前端只能 `String(e)` 展示，i18n 靠后端 `log_key` 曲线救国。

目标：

```rust
#[derive(thiserror::Error, Debug)]
pub enum SshError {
    #[error("auth failed")] Auth,
    #[error("host key mismatch: {0}")] HostKeyMismatch(String),
    #[error("no common algorithm")] NoCommonAlgo,
    #[error("timeout")] Timeout,
    // ...
}
// IPC 只传 { code, message, detail }，前端按 code 做 i18n + 重试策略
```

`thiserror` 已在依赖里（`Cargo.toml:35`），只需逐步替换。先从 `ssh/*` 开始，再到 tunnel/monitor。

---

## 13. 并发模型

| 场景            | 规则                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| tokio async 内 | 用 `tokio::sync::Mutex` 或无锁结构；`std::MutexGuard` 绝不跨 `.await`（`commands/ssh.rs` 已有多处“clone 出锁再 await”注释）               |
| ssh2 阻塞 I/O   | 一律 `spawn_blocking`，不占 tokio worker；慢建连/慢断开不许持 `AppState` 锁                                                          |
| 会话注册表         | 短持锁 insert/remove/get；读写泵只持有会话级 `Arc`                                                                                |
| 前端 IPC        | 同会话串行（`enqueueWrite` 链），跨会话并发；resize 去重（`lastPtyResize`）                                                             |
| 长锁隐患          | `AppState` 的 10 个 `std::Mutex<Manager>` 是下一步改造重点（换 `tokio::sync::Mutex` 或 `DashMap<session_id, Arc<Session>>`，见 §17） |

russh client Config（`russh_backend.rs`）：`nodelay: true`、`keepalive_interval: 30s / max: 3`、`inactivity_timeout: None`。vendor 默认 `window_size: 2MB / maximum_packet_size: 32K / channel_buffer_size: 100`，调优时从这里下手（先测再改）。

---

## 14. 各协议模块速览

| 模块       | 后端文件                                      | 要点                                                                           |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| SFTP     | `sftp/*` + `commands/sftp.rs`             | `SftpManager` 会话表；直读上传/分块/断点续传/`transfer_cancels` 取消；FTP 共用通道（`protocol` 区分） |
| Telnet   | `telnet/*`                                | 明文无认证；无 PTY resize 语义                                                        |
| 本地 shell | `local/*`                                 | portable-pty；`local_file_size` 供断点续传                                         |
| 串口       | `serial/*`                                | serialport 枚举 + encoding_rs 字符集；写即时不批                                        |
| 监控       | `monitor/*` + `services/monitor_state.rs` | 独立 SSH 会话采集，2s 轮询（前端并发窗 3），阈值告警在前端做                                          |
| VNC/RDP  | `vnc/*` + `rdp/*`                         | Rust 起本地 loopback 桥，前端经 WebSocket 收发；`generation` 代际防旧代误杀                    |
| MOSH     | `mosh/*`                                  | SSH 引导（`mosh-server new`）+ UDP 数据面；认证链路与 ssh 共用                              |
| AI       | `commands/ai.rs`                          | OpenAI 兼容协议透传，多 profile 在配置层                                                 |
| 杂项       | `commands/misc.rs`                        | config 读写、图片 dataURL、备份导入导出、危险区（清缓存/重置/删全量）                                  |

---

## 15. 前后端契约

- 调用：`invoke('{domain}_{verb}', {...})`，如 `ssh_connect/ssh_write/ssh_resize/ssh_disconnect`。
- 返回：`ConnectResult{status: connected|needsHostKeyApproval, fingerprint?, host, port, hostKeyToken?, sessionId?}`。
- 推送：`listen('session-{id}')` 收 `SessionEvent`；`port-forward-status` 收隧道状态；`cloud-config-changed` 触发前端重载配置。
- 类型镜像：`src-tauri/models/*.rs` ↔ `src/types/*` / `services/dataService.ts`，改一边必须改另一边（camelCase 由 serde `rename_all` 保证）。

---

## 16. 测试策略

现状：`cargo test` 81 项（parser/指纹/校验/SOCKS5 RDP/VNC 单元）+ `vitest` 16 项（splitLayout/sshAuthResolver）。**全是单机单元，无集成测试**。

建议补（按优先级）：

1. `docker openssh-server` 集成：connect（password/key）/ 跳板 / 隧道建连 / 重连 / DSA 回退各一个用例。
2. cloud_sync：packet v1 可读、v2 roundtrip、双向合并 skip 语义。
3. 延迟回归：mock channel 测写直发 + 输出合帧（断言无 mpsc 排队）。
4. 性能测试**必须用 release 包**（dev 构建依赖未优化，慢 10–50 倍，结论不可信；或临时开 `profile.dev.package."*"` opt-level 2，见 `Cargo.toml` 注释）。

---

## 17. 重构路线图（按顺序）

1. **抽 `ssh/auth.rs`**：把 `services/port_forwardings::resolve_host_ssh_config*` + `commands/ssh.rs::prepare_ssh_auth_material` 搬过去，services 只供原始行数据。消除跨层调用。
2. **统一 `SshError` code**：`thiserror` 枚举 + IPC `{code,message}`，前端按 code 做 i18n/重试。先 ssh，再 tunnel/monitor。
3. **换粗锁**：`AppState` 的 `Mutex<Manager>` → `tokio::sync::Mutex` 或 `DashMap<session_id, Arc<Session>>`；tunnel/monitor/sftp 互不阻塞。
4. **DB 加固**：`PRAGMA journal_mode=WAL` + `user_version` 版本表替代散装 `ensure_column`；`open_connection` 保持（简单可靠），高频路径复用句柄。
5. **内存 Secret 清零**：`zeroize::Zeroizing` 包 `private_key/cert_content/password`（需加依赖）。
6. **可观测**：`tracing` + `tauri-plugin-log`，session 级 span；高频路径禁 `write_log`。
7. **russh 升级**：等 ironrdp→picky 解锁后升 0.61+，去掉 `vendor/russh` patch；升级前全量跑 §16 集成测试。

---

## 18. 附录：关键文件索引

| 关心…       | 看这里                                                                      |
| --------- | ------------------------------------------------------------------------ |
| 启动/注册表    | `src/lib.rs`（AppState/run/invoke_handler）                                |
| SSH 装配/回退 | `src/commands/ssh.rs`、`src/commands/tunnel.rs:is_ssh2_fallback_eligible` |
| russh 交互  | `src/ssh/russh_shell.rs`（读写分离/输出泵/写分片）                                   |
| ssh2 交互   | `src/ssh/session.rs`（读线程/写退避/OS 探测，930 行核心）                              |
| 主机密钥      | `src/ssh/host_keys.rs`、`src/services/known_hosts.rs`                     |
| 事件契约      | `src/session_events.rs`                                                  |
| 前端写入/渲染   | `src/components/terminalPool.ts`（直发/串行队列/rAF 合并）                         |
| DB 表/迁移   | `src/utils/sqlite.rs:init_database`                                      |
| 密钥链       | `src/utils/secrets.rs`、`src/services/common.rs`                          |
| 云同步       | `src/services/cloud_sync.rs`（packet v2/双向合并/skip）                        |
| 配置        | `src/models/config.rs`、`src/config/global_config.rs`                     |
| 迁移史       | `docs/SSH_BACKEND_MIGRATION.md`（双后端决策背景）                                 |
