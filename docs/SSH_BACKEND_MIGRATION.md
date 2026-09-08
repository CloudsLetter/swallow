# SSH 后端评估与端口转发迁移方案

调研日期：2026-09-07
涉及代码：`src-tauri/src/ssh/{session,tunnel}.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/services/port_forwardings.rs`

---

> ## ✅ 状态更新（2026-09-08）：依赖已解锁，隧道已迁 russh
>
> 顶部旧「阻塞」声明已过期。实际进展：
> 1. **依赖打通（09-07 晚，commit b862a54）**：russh `=0.60.1` + 仅 vendor russh 一 crate
>    （`src-tauri/vendor/russh`，样板同 swallow-mobile）；pkcs5 stable 0.8.0 API 改名在 vendor
>    内适配（`generate_pbkdf2_sha256_aes256cbc`）。cargo check 全绿。
> 2. **隧道已迁移 russh（commit 55c7b89）**：`ssh/russh_backend.rs`（连接/认证/主机密钥
>    DB 校验/跳板递归/Handler 回调：check_server_key 拒绝未知指纹→上层转待确认 token，
>    disconnected 事件驱动感知）+ `ssh/russh_tunnel.rs`（local/remote/dynamic SOCKS5，
>    事件驱动 accept + 每连接 1 task，`copy_bidirectional` 替代双 OS 线程桥）。
>    `lib.rs start_port_forward` 已走 russh；TunnelManager 值类型 = RunningTunnel 枚举
>    （Ssh2 路径保留可回退）。**前端 IPC 零改动**。
> 3. 隧道 P0 双缺陷（30s 自断 / 单 Session 大锁并发串行）已随隧道 russh 化根治。
> 4. **尚未迁移**：终端交互会话（ssh/session.rs start_shell 读线程路径）。见 §9。
> 5. 明确边界不变：SFTP / monitor / VNC / MOSH 保持 ssh2；不引入 russh-sftp。

---

## 0. 结论速览

| 问题 | 严重度 | 结论 |
|---|---|---|
| 空闲转发连接约 30 秒后自断 | **P0 功能缺陷** | ssh2 下修不了，必须换 russh |
| 单 Session 大锁导致并发串行 | **P0 并发缺陷** | ssh2 下无解（唯一绕法不可接受） |
| accept 循环 10ms 轮询 | P1 浪费 | 不换库也能修 |
| 每条隧道一个看门狗线程 | P1 浪费 | 不换库也能修 |
| SFTP / 终端 / monitor / VNC | — | **保持 ssh2，不要动** |

执行顺序：先修 P1（当天）→ 抽 `ConnectionPlan` 接缝（半天）→ 端口转发换 russh（2~3 天）。

---

## 1. ssh2 vs russh：事实对比

### 1.1 版本与维护（2026-09-07 查证）

| | ssh2 | russh |
|---|---|---|
| 最新版 | 0.9.6（上一版 0.9.5 = 2025-02，约 19 个月一更） | 0.63.2（2026-09-03，周更） |
| 归属 | alexcrichton/ssh2-rs | warp-tech/russh（Warp 终端在养） |
| 2026 年动作 | 基本只有修补 | 迁移上游 `ssh-key`、`mlkem768x25519-sha256` 后量子 KEX、strict KEX |
| README 自述 | 「要 async 请移步 async-ssh2 / async-ssh2-lite」 | 原生 async |
| 生产用户 | 25 万次/月下载 | Warpgate、Devolutions Gateway、Yazi |

本项目 `Cargo.lock` 锁的是 ssh2 0.9.6。

### 1.2 能力矩阵

| 能力 | ssh2 | russh |
|---|---|---|
| 密码 / 公钥 / 键盘交互 | 有 | 有 |
| OpenSSH 证书 | 有（需 libssh2 ≥ 1.11） | `authenticate_openssh_cert`，原生 |
| 内存密钥（不落盘） | `userauth_pubkey_memory`，**需 openssl 后端** | `PrivateKey::from_openssh(&str)`，纯内存 |
| SSH agent | 有 | 有（`authenticate_publickey_with` + `Signer`） |
| known_hosts（含 `\|1\|salt\|hash`） | `KnownHosts` API | `russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path}` |
| local / remote / dynamic 转发 | 有 | 有（`channel_open_direct_tcpip` / `tcpip_forward` / `direct-streamlocal`） |
| X11 / agent forwarding 通道 | 无 | 有 |
| **ssh-dss（DSA）** | **有** | **无**（详见 1.3 DSA 说明） |
| SFTP | `ssh2::Sftp` 内置同步，成熟 | `russh-sftp`，异步，较新 |

### 1.3 依赖与构建

- ssh2 现状：`features = ["vendored-openssl", "openssl-on-win32"]`，clean build 需要 **perl + C 编译 OpenSSL + libssh2**。
- russh：纯 Rust，但**强制二选一加密后端**：
  - `ring`（**推荐**）：本项目 `rustls = { features = ["ring", "std"] }`，ring 已在依赖树里编译。crates.io 版 ring 在 Windows x86_64 带预编译 asm，**不需要 perl / NASM**，只要 VS Build Tools。
  - `aws-lc-rs`：需要 **cmake**，别选。
- ⚠️ **陷阱：`russh` 的 `default = ["flate2", "aws-lc-rs", "rsa"]`。** 直接 `russh = "0.63"` 会把 aws-lc-rs 拉进来（要 cmake，等于把 C 工具链请回来，白换一次库）。**必须 `default-features = false` 再手动挑**。
- ⚠️ **陷阱：`rsa` feature 不能省。** `russh/rsa = ["ssh-key/rsa", "ssh-key/rsa-sha1", ...]`，关掉它 RSA 私钥解析不了——而绝大多数服务器的主机密钥仍是 RSA。
- 二进制体积：russh + ssh-key 及相关加密 crate 约 +2~4MB（release strip 后）。项目已带 ironrdp + mosh + vendored OpenSSL，可接受。

**关于 DSA：** russh 有 `dsa = ["ssh-key/dsa"]` feature，但它**只透传给 ssh-key 用于私钥解析**——russh 协议栈源码里没有任何 `ssh-dss` 常量（`grep -rn "ssh-dss" src/` 零命中），协商表不提供该算法。所以「russh 连不上只支持 DSA 的老交换机」这个结论**依然成立**，开 `dsa` feature 救不了。

**关于 ssh-key 版本：** russh 0.60 依赖的是 `internal-russh-forked-ssh-key = "=0.6.18"`（一个 fork 包名，不是 crates.io 上的官方 `ssh-key`）；0.63 起已迁移到上游 `ssh-key`（2026-05 commit #709）。→ 代码里**优先用 `russh::keys::ssh_key::*` 的 re-export**，这样 fork / 上游切换都不受影响。只有在需要 russh 没给你开的 feature（如 `pem`）时才额外加依赖，且版本必须完全一致（见 5.3 的 pem feature 坑）。

### 1.4 依赖冲突实测矩阵（2026-09-07，全部经 `cargo check` 验证）

| russh 版本 | 冲突点 | 失败形态 |
|---|---|---|
| 0.63.x / 0.62.x | `curve25519-dalek ^5`（stable） | 解析失败：picky(ironrdp) 锁 `=5.0.0-rc.1`，rc.1 < 5.0.0 不满足 `^5` |
| 0.61.x | `curve25519-dalek =5.0.0-rc.0`（精确） | 解析失败：rc.0 ≠ rc.1 |
| 0.60.3 | `aes-gcm =0.11.0-rc.3`（精确） | 解析失败：picky 锁 `=0.11.0-rc.4` |
| 0.60.0 | `curve25519-dalek 5.0.0-pre.6`(^)、`pkcs5 0.8.0-rc.13`(^) | 解析成功，**编译失败**：pkcs8 stable 0.11.0 把 pkcs5 拉成 stable 0.8.0，fork ssh-key 0.6.18 按 rc.13 API（`generate_pbkdf2_sha256_aes128cbc`）编译不过 |
| 0.59.0 / 0.58.1 / 0.57.1 | `rand 0.9 + rand_core =0.10.0-rc-3` | 解析失败：tokio-tungstenite 0.30 → tungstenite 0.30 → rand 0.10.2(stable) 要 `rand_core ^0.10.0` |
| 0.56.0 | `rand 0.8 + rand_core 0.6.4`（stable，解析通过） | **编译失败**：fork ssh-key `0.6.16+upstream-0.6.7` 的 rsa 依赖被解析到新版（rand_core 0.10.1），fork 代码按 rand_core 0.6 API 写（`CryptoRngCore` trait 不匹配） |

根因：russh 0.57+ 与 ironrdp→picky 都在 RustCrypto **pre-release 过渡期**，两边对
`curve25519-dalek` / `aes-gcm` / `pkcs5` / `pkcs8` / `rand_core` 的精确锁互相撞车；
russh 0.56 的 fork ssh-key 又被"当前 crates.io 最新 rsa"半新旧坑死。
0.63 需等 `curve25519-dalek 5.0.0` 稳定且 picky 解锁 rc.1 才能解析。

---

## 2. 端口转发现有实现的三个问题

### 2.1 P0：空闲的转发连接会被自己关掉（约 30 秒）

**证据链：**

1. `ssh/session.rs:360` — `session.set_timeout(timeout_secs.saturating_mul(1000))`。
   ssh2 文档原文：*Set the timeout in milliseconds for how long a blocking libssh2 function call may wait until it considers the situation an error.*
2. `timeout_secs` 来自 `lib.rs` 的 `read_connection_timeout(&config_state)`，兜底值 `DEFAULT_CONNECTION_TIMEOUT_SECS = 30`（`ssh/session.rs:19`）。
3. 隧道的 Session 是**阻塞模式**：`set_blocking(false)` 只在 `ssh/session.rs:496` 的 `start_shell`（终端路径）里调用，`establish_authenticated_session`（端口转发走它，**`lib.rs:775` 前的 `lib.rs:746`**）不调。
4. `ssh/tunnel.rs:311` 的 `bridge()`：

```rust
// SSH -> TCP
let handle = { thread::spawn(move || { let _ = io::copy(&mut r, &mut w); ... }) };
// TCP -> SSH
let _ = io::copy(&mut r, &mut w);
// 本地侧已关闭：通知远端 channel 结束并等待关闭
let _ = channel.send_eof();
let _ = channel.wait_close();
```

**推断（需实测验证）：** SSH→TCP 方向的 `io::copy` 阻塞在 `libssh2_channel_read_ex`，若该通道 30 秒内没有数据到达，libssh2 返回超时错误 → `io::copy` 返回 `Err` → 被 `let _ =` 吞掉 → 该方向终止 → 紧接着 `send_eof()` + `wait_close()` → **整条转发连接被关闭**。

**影响：** SOCKS5 代理下浏览器的 keep-alive 连接、数据库客户端空闲连接、长轮询接口，静置 30 秒后断线。这是用户能直接感知到的故障。

**复现方法：**
1. 建一条 local 转发（或 dynamic SOCKS5）规则并启动。
2. `curl` 或浏览器走代理发一个请求，拿到响应。
3. **静置 35 秒**，再发第二个请求。
4. 观察：若第 2 次请求失败 / 代理连接被关闭，即确认。同时在日志里加一行打印 `io::copy` 的 Err 值（`e.kind()` 应为 `TimedOut`）。

### 2.2 P0：单 Session 大锁，并发退化为串行

**源码事实（ssh2-0.9.6）：**

```rust
// session.rs
pub struct Session { inner: Arc<Mutex<SessionInner>> }        // 一个 Session 一把锁

// channel.rs —— 每个 channel 的读写都要这把锁
fn lock(&self) -> LockedStream<'_> {
    let sess = self.channel_inner.sess.lock();                // session 级
    ...
    raw::libssh2_channel_read_ex(...)                          // 整个调用期间持锁
}

// session.rs —— 这些方法走同一把 self.inner() 锁
pub fn channel_direct_tcpip(...)   // 开新转发通道
pub fn keepalive_send(...)         // 看门狗探活
pub fn channel_forward_listen(...) // 远程转发监听
```

**后果：**

1. `bridge()` 阻塞等待数据时**一直握着整把 Session 锁**（最多握 30 秒，见 2.1）。
2. 同一隧道规则下的其他连接：读、写、`channel_direct_tcpip` 开新通道，**全部排队**。
3. SOCKS5 下浏览器并发 6~20 条连接 → 退化成串行。
4. 互相等待时形成停顿：连接 A 握锁等服务端响应，连接 B 想发请求必须先拿到锁，而服务端可能要等 B 的请求才回 A。表现为「卡住约 30 秒后一批连接一起断」。
5. 看门狗 `is_alive() → keepalive_send()` 也要这把锁，可能被饿死 → **误判断线，把一条活着的隧道清理掉**。

**为什么只有端口转发踩到：** 它是全项目唯一在单个 Session 上开多个并发 channel 的场景。终端是一个 Session 一个 channel，VNC 是单通道，monitor 是每台主机独立 Session——都不争这把锁。

**ssh2 下的唯一绕法：** 每条转发连接单独建一个 SSH Session（锁粒度降到每连接一把）。代价是每开一个网页连接就要做一次 SSH 握手 + 认证（秒级延迟），SOCKS5 场景不可接受。

→ **这是端口转发必须用 russh 的硬理由。**

### 2.3 P1：线程模型与轮询开销

`ssh/tunnel.rs`：

| 位置 | 现象 |
|---|---|
| `spawn_local_loop` (195) / `spawn_dynamic_loop` (224) | `WouldBlock` + `thread::sleep(10ms)` 轮询 accept，**每秒空转 100 次** |
| `bridge()` (311) | 每连接 2 个 OS 线程（spawn 一个 + 当前线程） |
| `lib.rs` 看门狗 | 每条隧道一个线程，`thread::sleep(3s)` 循环 + `keepalive_send()` |
| `bridge()` (314-315) | 只给 TCP 设了 300s 读写超时，**SSH 侧无超时兜底** |

---

## 3. 顺手可修（不换库，当天可合）

### 3.1 accept 的 10ms 轮询

现状：

```rust
Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
    thread::sleep(Duration::from_millis(10));
}
```

改法（二选一）：
- **简单**：listener 不设 nonblocking，直接阻塞 `accept()`；停止时从外部 `connect` 一下自己的监听端口把 accept 唤醒（self-pipe 套路）。
- **干净**：`socket2`/`mio` 的 `Poll` 注册 listener + 一个 eventfd/管道作为停止信号，`poll(None)` 阻塞等待。

验收：启动隧道后 CPU 占用应接近 0。

### 3.2 每条隧道一个看门狗线程

现状：`lib.rs` 里 `start_port_forward` 成功后 `thread::spawn` 一个 `sleep(3s)` 循环。

改法：全局一个巡检线程，`Arc<Mutex<HashMap<rule_id, Weak<SshTunnel>>>>`，每 3 秒遍历一次。

验收：10 条隧道运行时线程数从 ~30+ 降到 ~1。

### 3.3 bridge 超时不对称

`bridge()` 只给 TCP 设了 300s 超时，SSH 侧无超时兜底。

**✅ 已实施（2026-09-07）**：`lib.rs` `start_port_forward` 在 `establish_authenticated_session`
返回后、`start_tunnel` 前调用 `established.session.set_timeout(0)`。作用与边界：

- 修好两处 30s 自杀：① 数据桥 `bridge()` 的 SSH→TCP `io::copy`（空闲连接 30s 后
  超时返回 Err，随即 `send_eof` + `wait_close` 拆线）；② **remote（ssh -R）转发的
  `listener.accept()` 监听循环**——阻塞 accept 同样吃 session 超时，30s 无新连接就
  Err break，整条远程转发停摆。
- 不影响握手/认证：`establish_authenticated_session` 内的 `set_timeout(timeout_secs * 1000)`
  仍在（TCP 已连但对端不应答 SSH banner 时仍受超时保护），归零发生在连接返回之后。
- 不影响终端：终端 Session 是非阻塞模式（`set_blocking(false)`），libssh2 超时只作用于
  阻塞调用。

⚠️ 缓解不是根治：设 0 后「自断」消失，但 §2.2 的单 Session 大锁并发串行仍在
（忙时停顿甚至更久，锁握得更长）。真修复需 russh 迁移（§1.4：被上游依赖冲突阻塞）。

---

## 4. 接缝设计：ConnectionPlan

### 4.1 现状

`ssh/session.rs:346` `establish_authenticated_session` 做了五件事，其中 1、3 是后端无关的，2、4、5 是 ssh2 专属：

```rust
let (tcp, jump) = establish_transport(config, timeout_secs, on_progress)?;  // 1 传输层（含跳板递归）
let mut session = Session::new()?;                                          // 2 ssh2 专属
session.set_tcp_stream(tcp); session.set_timeout(...); session.handshake()?;
match verify_host_key(&session, &config.host, config.port)? { ... }         // 3 主机密钥（ssh2 KnownHosts）
match config.auth_type.as_str() { ... }                                     // 4 认证（部分 ssh2 专属）
if !session.authenticated() { bail!(...) }                                  // 5 ssh2 专属
Ok(EstablishedSession { session, jump })    // ← 返回值把 ssh2::Session 焊死
```

`SshConfig`（`ssh/session.rs:28`）本身**已经是纯数据**（host/port/username/auth_type/password/private_key/public_key/cert_content/cert_private_key/passphrase/proxy），可以直接当后端无关的输入，不需要另造一套配置结构。

### 4.2 目标结构

新增 `src-tauri/src/ssh/plan.rs`：

```rust
/// 后端无关的连接意图：从 SshConfig 解析出的「目标 + 认证材料 + 跳板链」。
/// 不含任何 ssh2 / russh 类型。
pub struct ConnectionPlan {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMaterial,
    /// 跳板链（递归），None 表示直连
    pub proxy: Option<Box<SshConfig>>,
    pub timeout_secs: u32,
}

/// 认证材料：把「DB 内容 / 文件路径」两种来源统一成枚举，
/// 后端各自决定怎么用（ssh2 走临时文件，russh 走内存解析）。
pub enum AuthMaterial {
    Password(String),
    KeyInline { private_key: String, public_key: Option<String>, passphrase: Option<String> },
    KeyFile { path: PathBuf, passphrase: Option<String> },
    CertInline { cert: String, private_key: String, passphrase: Option<String> },
    CertFile { cert: PathBuf, key: PathBuf, passphrase: Option<String> },
}

impl SshConfig {
    /// 把现有 auth_type + 各内容/路径字段解析成 AuthMaterial。
    /// 逻辑与现在 establish_authenticated_session 里的 match 完全一致，只是搬到此处。
    pub fn to_plan(&self, timeout_secs: u32) -> Result<ConnectionPlan>;
}
```

然后两个后端各自实现同一签名：

```rust
// ssh/backend_ssh2.rs
pub fn connect(plan: &ConnectionPlan, on_progress: &dyn Fn(&str, Option<&str>))
    -> Result<EstablishedSession>;

// ssh/backend_russh.rs
pub async fn connect(plan: &ConnectionPlan, on_progress: &dyn Fn(&str, Option<&str>))
    -> Result<RusshConnection>;
```

主机密钥校验也抽出来（两侧都只是「给定指纹 → 查 known_hosts → 返回 Matched / Unknown」）：

```rust
pub enum HostKeyDecision { Matched, Unknown { fingerprint: String } }
pub fn decide_host_key(fingerprint: &str, host: &str, port: u16) -> Result<HostKeyDecision>;
pub fn learn_host_key(host: &str, port: u16, key_material: &str) -> Result<()>;
```

`require_approval` / `PENDING_HOST_KEYS` / `accept_host_key` 这套流程**完全不动**，两个后端共用（它只依赖 `SshConfig` + 指纹串，与 SSH 库无关）。

### 4.3 迁移步骤与验收

1. 新增 `ssh/plan.rs`，把 `establish_authenticated_session` 里的认证 match 原样搬进 `to_plan()`（含 KeyFile / CertFile 回退分支）。
2. `establish_authenticated_session` 改为调用 `plan`，行为**逐分支保持一致**——特别是文件路径回退仍走 `userauth_pubkey_file`，不要顺手改成内存认证（`userauth_pubkey_memory` 需要 openssl 后端，改了有构建风险）。
3. 验收：`cargo test ssh::` + 手工连一遍 password / key（DB 内容）/ key（文件路径）/ certificate 四种，行为与改前一致。

这一步是纯重构，**功能零变化**，可以单独提交、随时回滚。

---

## 5. russh 后端实现

### 5.1 依赖

```toml
# src-tauri/Cargo.toml
russh = { version = "0.63", default-features = false, features = ["ring", "rsa", "flate2"] }
# 不要加 russh-sftp —— SFTP 继续走 ssh2
```

三个 feature 缺一不可：

| feature | 作用 | 省略后果 |
|---|---|---|
| `ring` | 加密后端 | 编译不过（至少一个后端） |
| `rsa` | `ssh-key/rsa` + `rsa-sha1` | **RSA 私钥解析不了**，多数服务器连不上 |
| `flate2` | zlib 压缩 | 对端 offer `zlib@openssh.com` 时协商受限 |

`default-features = false` 是必须的——默认的 `aws-lc-rs` 要 cmake。

注意与 `rustls` 的 `ring` 保持同一版本，避免依赖树里出现两个 ring。

### 5.2 Handler

```rust
use russh::{client, keys::ssh_key::PublicKey};

pub struct ClientHandler {
    /// check_server_key 里写入首次遇到的未知指纹，供上层转成待确认错误
    pub unknown_fingerprint: Arc<Mutex<Option<String>>>,
    /// 远程转发回调需要知道本地目标地址
    pub host: String,
    pub port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        match host_keys::decide_host_key(&fp, &self.host, self.port) {
            HostKeyDecision::Matched => Ok(true),
            HostKeyDecision::Unknown { fingerprint } => {
                *self.unknown_fingerprint.lock().unwrap() = Some(fingerprint);
                Ok(false)   // 拒绝 → 上层据此转 HostKeyApprovalRequired
            }
        }
    }
    // 其余回调用默认实现即可（隧道不需要 data / channel 回调，
    // 远程转发才需要 server_channel_open_forwarded_tcpip）
}
```

⚠️ `check_server_key` 返回 `Ok(false)` 后 `connect` 会失败，具体的错误变体需要跑一次 smoke test 确认（不同版本可能是 disconnect 而非 Err）。上层逻辑统一处理：先读 `unknown_fingerprint`，非空就返回 `HostKeyApprovalRequired`，否则透传原错误。

### 5.3 连接与认证

```rust
use tokio::io::{AsyncRead, AsyncWrite};

/// connect_stream 吃任意 AsyncRead + AsyncWrite；直连与跳板两种传输层
/// 统一装箱成 trait object，避免为两级跳板写两份泛型代码。
/// （tokio 为 Box<T: ?Sized + AsyncRead/AsyncWrite + Unpin> 提供了 blanket impl，
///   若编译不过则退回到「两变体 enum + 两处 connect_stream 调用」的写法。）
type BoxedTransport = Box<dyn AsyncRead + AsyncWrite + Unpin + Send>;

pub struct RusshConnection {
    pub handle: client::Handle<ClientHandler>,
    /// 跳板机连接（若有）：必须随本连接存活，drop 即释放，不再需要手工 disconnect+join
    _jump: Option<Box<RusshConnection>>,
}

pub async fn connect(plan: &ConnectionPlan, on_progress: &dyn Fn(&str, Option<&str>))
    -> Result<RusshConnection>
{
    let config = Arc::new(client::Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        // ⚠️ 千万别设 inactivity_timeout！语义等同于「空闲 N 秒就断开」，
        //    正是 2.1 那个 bug 的 russh 版本。官方示例里的 5 秒是给一次性命令用的。
        inactivity_timeout: None,
        ..<_>::default()
    });

    // 传输层：直连 or 递归跳板
    let (transport, jump): (BoxedTransport, Option<Box<RusshConnection>>) = match &plan.proxy {
        None => {
            let tcp = tokio::net::TcpStream::connect((&*plan.host, plan.port)).await?;
            (Box::new(tcp), None)
        }
        Some(proxy_cfg) => {
            // 递归连接跳板机，再开 direct-tcpip 通道当传输层
            let jump_conn = Box::new(
                connect(&proxy_cfg.to_plan(plan.timeout_secs)?, on_progress).await?
            );
            let ch = jump_conn.handle
                .channel_open_direct_tcpip(&plan.host, plan.port as u32, "127.0.0.1", 0)
                .await?;
            // ★ 关键：通道本身就是 AsyncRead+AsyncWrite，无需 loopback 对桥接
            (Box::new(ch.into_stream()), Some(jump_conn))
        }
    };

    let handler = ClientHandler {
        unknown_fingerprint: Arc::new(Mutex::new(None)),
        host: plan.host.clone(),
        port: plan.port,
    };
    let mut handle = client::connect_stream(config, transport, handler).await?;

    // 认证：全部走内存，不需要临时文件
    match &plan.auth {
        AuthMaterial::Password(p) => {
            let r = handle.authenticate_password(&plan.username, p).await?;
            if !r.success() { anyhow::bail!("密码认证失败"); }
        }
        AuthMaterial::KeyInline { private_key, passphrase, .. } => {
            let key = load_private_key_from_memory(private_key, passphrase.as_deref())?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let r = handle.authenticate_publickey(
                &plan.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            ).await?;
            if !r.success() { anyhow::bail!("公钥认证失败"); }
        }
        AuthMaterial::CertInline { cert, private_key, .. } => {
            let key  = load_private_key_from_memory(private_key, None)?;
            let cert = russh::keys::ssh_key::Certificate::from_openssh(cert)?;
            let r = handle
                .authenticate_openssh_cert(&plan.username, Arc::new(key), cert)
                .await?;
            if !r.success() { anyhow::bail!("证书认证失败"); }
        }
        // KeyFile / CertFile：先 std::fs::read_to_string 读进内存，再走上面两条
        _ => { /* 读文件后同上 */ }
    }

    Ok(RusshConnection { handle, _jump: jump })
}
```

`load_private_key_from_memory` 按 PEM 头分派（**实现时先确认 DB 里存的是哪种格式**）：

```rust
fn load_private_key_from_memory(pem: &str, passphrase: Option<&str>)
    -> Result<russh::keys::ssh_key::PrivateKey>
{
    let mut key = if pem.contains("OPENSSH PRIVATE KEY") {
        russh::keys::ssh_key::PrivateKey::from_openssh(pem)?
    } else if pem.contains("BEGIN PRIVATE KEY") {
        russh::keys::ssh_key::PrivateKey::from_pkcs8_pem(pem.as_bytes())?
    } else if pem.contains("RSA PRIVATE KEY") {
        russh::keys::ssh_key::PrivateKey::from_pkcs1_pem(pem.as_bytes())?
    } else if pem.contains("EC PRIVATE KEY") {
        russh::keys::ssh_key::PrivateKey::from_sec1_pem(pem.as_bytes())?
    } else {
        anyhow::bail!("无法识别的私钥格式");
    };
    if let Some(pass) = passphrase {
        if key.is_encrypted() {
            key = key.decrypt(pass)?;   // ssh-key 的 decrypt 返回新 PrivateKey
        }
    }
    Ok(key)
}
```

⚠️ **pem feature 坑（动手前先确认）：**

- `from_openssh`（解析 `-----BEGIN OPENSSH PRIVATE KEY-----`）——**不需要额外 feature**，开箱可用。
- `from_pkcs8_pem` / `from_pkcs1_pem` / `from_sec1_pem` —— 需要 ssh-key 的 `pem` feature。**russh 0.60 传给 ssh-key 的 features 里没有 `pem`**（只有 `ed25519 / p256 / p384 / p521 / encryption / ppk / hazmat-allow-insecure-rsa-keys`），也就是这几条路径**默认调不到**。

处理顺序：

1. **先查 DB 里密钥表存的是什么格式。** 现代 `ssh-keygen` 默认生成的就是 OpenSSH 新格式，若全是这种，走 `from_openssh` 一条路即可，**不需要碰 pem feature**。
2. 若确有传统 PEM（PKCS#1 / PKCS#8 / SEC1），在 Cargo.toml 补一个**与 russh 内部完全同版本**的 ssh-key 并开 `pem`：

```toml
# 版本必须和 `cargo tree | grep ssh-key` 显示的完全一致，否则会编译出两个 ssh-key、类型不通用
ssh-key = { version = "=0.6.18", features = ["pem", "alloc", "ed25519", "rsa"] }
```

3. 若 russh 用的仍是 fork 包名（`internal-russh-forked-ssh-key`），此法失效——此时改用兜底：**在密钥导入/写入 DB 时就规范化成 OpenSSH 格式**（`ssh-keygen -p -f <key> -N ""` 会把私钥重写为 OpenSSH 格式），后端只认一种格式。

公钥认证的完整写法（照抄官方示例）：

```rust
let key_pair = russh::keys::ssh_key::PrivateKey::from_openssh(private_key_pem)  // 内存解析
    .or_else(|_| russh::keys::load_secret_key(path, passphrase))?;   // 文件回退
let hash = handle.best_supported_rsa_hash().await?.flatten();        // 服务器侧 RSA 哈希协商
let auth = handle
    .authenticate_publickey(&plan.username, PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash))
    .await?;
if !auth.success() { anyhow::bail!("公钥认证失败"); }
```

> `russh::keys::ssh_key::PrivateKey::from_openssh` 支持 OpenSSH 新格式（含 `-----BEGIN OPENSSH PRIVATE KEY-----`），带 passphrase 的加密私钥需再 `.decrypt(passphrase)`。传统 PEM 的注意事项见上方「pem feature 坑」。

### 5.4 跳板机

ssh2 现状（`ssh/session.rs:301` 附近）：`TcpListener::bind("127.0.0.1:0")` + 两个 `TcpStream` + `spawn_jump_bridge`（2 个 `io::copy` 线程）→ **每级跳板 3 个 OS 线程 + 一组 loopback socket**。

russh：如上 5.3，`channel.into_stream()` 直接当下一跳的传输层，`connect_stream` 吃下去。多级跳板就是递归，N 级 = N 个 task，无 loopback、无桥接线程。

生命周期：跳板连接作为 `_jump` 字段被目标连接持有，drop 顺序天然正确（目标先释放 → 跳板通道 EOF → 跳板连接释放），不再需要 `JumpTransport` 里那套 `disconnect + join` 的手工保证。

### 5.5 主机密钥

两侧等价，见 4.2 的 `decide_host_key` / `learn_host_key`。russh 侧用：

```rust
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
```

支持 `|1|salt|hash` 混淆条目，与 OpenSSH 互操作。

---

## 6. 隧道 russh 实现

`ssh/tunnel.rs` 的 SOCKS5 解析部分（350~495 行）几乎可以原样保留，只把 `std::io::Read/Write` 换成 `tokio::io::AsyncReadExt/AsyncWriteExt` 并加 `.await`。

### 6.1 local（ssh -L）

```rust
async fn spawn_local_loop(
    listener: tokio::net::TcpListener,
    handle: client::Handle<ClientHandler>,   // Handle 是 Clone，可跨 task 共享
    target_host: String,
    target_port: u16,
    running: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        while running.load(Ordering::SeqCst) {
            let Ok((mut tcp, _)) = listener.accept().await else { break };
            let h = handle.clone();
            let host = target_host.clone();
            tokio::spawn(async move {
                match h.channel_open_direct_tcpip(host, target_port as u32, "127.0.0.1", 0).await {
                    Ok(ch) => {
                        let mut ch = ch.into_stream();     // AsyncRead + AsyncWrite
                        let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
                        // ChannelCloseOnDrop 在 drop 时自动 close，无需手工 send_eof/wait_close
                    }
                    Err(e) => eprintln!("direct-tcpip 失败: {e}"),
                }
            });
        }
    });
}
```

对比现状：每连接 2 个 OS 线程 → 1 个 tokio task；10ms 轮询 → 事件驱动；手工 `send_eof/wait_close` → `ChannelCloseOnDrop`；那个「别调 flush」的注释整段消失。

### 6.2 remote（ssh -R）

```rust
let bound = handle.tcpip_forward(&listen_host, listen_port as u32).await?;  // port=0 时返回实际端口
```

服务端发起的连接通过 Handler 回调进入：

```rust
impl client::Handler for ClientHandler {
    fn server_channel_open_forwarded_tcpip(
        &mut self, channel: Channel<Msg>,
        _connected_address: &str, _connected_port: u32,
        _originator_address: &str, _originator_port: u32,
        _session: &mut Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            let mut ch = channel.into_stream();
            let mut local = tokio::net::TcpStream::connect((target_host, target_port)).await?;
            let _ = tokio::io::copy_bidirectional(&mut ch, &mut local).await;
            Ok(())
        }
    }
}
```

回调里需要访问「本地目标地址」，做法：把 `target_host/target_port` 放进 `ClientHandler` 的字段里（Handler 在 `connect` 时构造）。

现状：`spawn_remote_loop` 用一个阻塞线程 `listener.accept()`，一次只能 accept 一个连接，且 `accept` 阻塞期间整条隧道无法处理其他事。russh 下是回调驱动，天然并发。

### 6.3 dynamic（SOCKS5）

`handle_socks5` 的方法协商 / RFC 1929 认证 / CONNECT 解析逻辑**逐行保留**，只做三处替换：

| 现状 | 改成 |
|---|---|
| `tcp.read_exact(&mut buf)` | `tcp.read_exact(&mut buf).await` |
| `tcp.write_all(&[...])` / `tcp.flush()` | `tcp.write_all(&[...]).await` / `tcp.flush().await` |
| `session.channel_direct_tcpip(...)` | `handle.channel_open_direct_tcpip(...).await?` |
| `bridge(channel, tcp)`（2 线程 + io::copy） | `copy_bidirectional(&mut ch.into_stream(), &mut tcp).await`（1 task） |

超时：握手阶段用 `tokio::time::timeout(Duration::from_secs(10), ...)` 包住，替代 `set_read_timeout`。

### 6.4 保活与看门狗

- russh 的 `Config.keepalive_interval` + `keepalive_max` 会自动发 OpenSSH keepalive 并处理对端响应，不需要自己写探活循环。
- `lib.rs` 里每条隧道一个 `sleep(3s)` 看门狗线程可以删掉：改为订阅 `handle.is_closed()`，或全局一个巡检 task 每 3 秒检查一次所有隧道。

---

## 7. 风险与验收清单

### 7.1 必须实测验证的点

| 项 | 方法 | 期望 |
|---|---|---|
| 2.1 的 30 秒自断 | 见 2.1 复现方法 | 换 russh 后静置 5 分钟连接仍存活 |
| 并发吞吐 | SOCKS5 代理下同时开 10 个网页/跑并行下载 | 吞吐随并发线性增长，不串行 |
| 认证四种路径 | password / key(DB) / key(文件) / certificate 各连一次 | 与 ssh2 行为一致 |
| known_hosts 三态 | 首次连接（TOFU 弹窗）/ 已存在（直连）/ 密钥变更（报错） | 与 ssh2 行为一致，`\|1\|salt\|hash` 条目可识别 |
| 跳板机 | 配置 proxy 后建隧道 | 与 ssh2 行为一致，无线程泄漏 |
| 私钥格式 | DB 里存的私钥内容走 `from_openssh` | 若失败按 5.3 说明做格式分派 |

### 7.2 已知风险

1. **错误文案会分裂。** ssh2 给的是 libssh2 错误串，russh 是自己的。同一个 `publickey` 失败，终端页和转发页会显示不同提示 → 需要一层统一映射。
2. **两套 known_hosts 实现**要对齐验收（见 7.1）。
3. **无 ssh-dss。** 老交换机/老路由连不上。若用户群里有这个需求，转发规则需要先判断主机算法，或保留 ssh2 作为 fallback。
4. **`inactivity_timeout` 陷阱**（见 5.3）：设了就会重现 2.1 同款 bug，务必留 `None`。
5. **窗口大小**：`Config.window_size` 默认可能偏小，高延迟链路上会限制吞吐。若实测吞吐不达标，调到 2MB 再测。

### 7.3 不做的部分（明确边界）

- 终端 / SFTP / monitor / VNC / MOSH **保持 ssh2**，不要顺手动。
- 不要引入 `russh-sftp`。
- 不要为了「统一」把 ssh2 的认证路径改成内存认证（有 openssl 构建风险）。

---

## 8. 实施顺序

| 步骤 | 内容 | 预估 | 验收 |
|---|---|---|---|
| 1 | 修 accept 10ms 轮询 + 合并看门狗线程 | 半天 | CPU 接近 0；10 条隧道线程数显著下降 |
| 2 | 确认 2.1 的 30 秒自断可复现（加日志） | 1 小时 | 拿到 `io::copy` 的错误类型证据 |
| 3 | 抽 `ConnectionPlan`（纯重构） | 半天 | `cargo test ssh::` + 四种认证手工回归 |
| 4 | 加 russh 依赖，`ssh/backend_russh.rs` 实现连接+认证 | 1 天 | 直连/跳板各连一次成功 |
| 5 | 隧道三类型换 russh（SOCKS5 逐行搬运） | 1 天 | 7.1 全表通过 |
| 6 | 错误文案统一映射 | 半天 | 终端页与转发页同一失败显示一致 |

前端**全程零改动**（IPC 契约不变）。

---

## 9. 下一阶段：终端交互会话 russh 迁移（2026-09-08 设计，API 已对 vendor 0.60.1 实证）

### 9.1 为什么做 / 边界

- 动机：SSH 主路径（终端）仍走 ssh2 阻塞读线程（`session.rs` 10ms WouldBlock 轮询 +
  大锁）。虽然终端单 channel 不踩「并发串行」，但统一到 russh 后可删 ssh2 阻塞线程模型、
  错误文案统一，并为后续移除 ssh2 依赖铺路。
- **保持不变**：前端 IPC 零改动（事件仍走 `session-{id}` Output/Disconnected/Error/Progress）；
  known_hosts 决策 / PENDING_HOST_KEYS / accept_host_key token 流程两端共用（host_keys.rs）；
  认证完全复用 `russh_backend::connect()`（已含 password/key/key文件/cert/agent + 跳板递归 +
  指纹校验，无需在 shell 模块重写）。

### 9.2 russh 0.60 客户端交互通道 API（vendor 实证）

- 打开会话通道：`handle.channel_open_session().await?` → `client::Channel<Msg>`（handle 来自
  `russh_backend::connect()` 返回的 `RusshConnection.handle`）。
- 请求 PTY：`channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?`
  （签名见 vendor channels/mod.rs:452，客户端那份在 452 起的 impl 块；方法实为 `request_pty`）。
- 起 shell：**`channel.request_shell(want_reply=true).await?`**（不是 start_shell；见 :476）。
- **读**（服务器→客户端）：不进 Handler 回调，改 `channel.wait().await -> Option<ChannelMsg>`
  （client impl :584）；`ChannelMsg::Data { data, .. }` 即远端输出，逐块 emit Output。
  Close / ExitStatus 对应断线语义。`wait()` 借 `&mut channel`。
- **写**：`channel.make_writer()` 返回 `impl AsyncWrite + 'static`（:618，内部克隆发送端，
  不借 channel 生命周期）→ 写 task/命令分支 `writer.write_all(bytes).await` 后 flush。
- **resize**：`channel.window_change(cols, rows, 0, 0).await?`（:537，也借 &self/channel）。
- 并发约束：`wait()` 需 `&mut channel`，写 writer 虽 'static 但共享同一 channel 时不可在
  另一 task 同时 `wait`（同一 Channel 只能被一个 await 者轮询）。→ **单 task select 模型**：
  channel 独占于一个 task，`tokio::select! { msg = channel.wait() => … , cmd = rx.recv() => … }`，
  cmd 分支处理 Write(写 writer) / Resize(window_change)；所有 IPC 写/重设尺寸经 mpsc 汇入该 task。

### 9.3 迁移落点（建议顺序，均可独立提交回滚）

1. `ssh/russh_shell.rs`：`ShellSession`（值持有 russh task JoinHandle + 写 mpsc + alive
   AtomicBool/oneshot）。`spawn(config: SshConfig, session_id, timeout, cols, rows, app_handle)`
   → connect() → open session → pty → shell → select 循环 emit（复用现有
   `emit_session_event(app_handle, &session_id, …)`，输出/断开/错误语义与 ssh2 读线程一致）。
2. 会话登记：shell 会话 id 沿用前端传入的 sessionId；lib.rs 侧用 `Mutex<HashMap<String, ShellSession>>`
   与 ssh2 manager 并列，由 session id 前缀或内部 backend 标记路由（建议「russh:` 前缀 ID，
   ssh2 逻辑只认原 ID，互不干扰；断开/重连路径按标记分派）。
3. 写命令 `ssh_write` / 重设尺寸 `ssh_resize`：先查 russh map，命中走 mpsc，未命中落 ssh2 原路。
4. 开关：`config.ssh.russh_shell`（default false）→ lib.rs 建连/重连入口读开关分流；
   隧道已是 russh 不受影响。真机回归通过后可翻默认。
5. 断开/取消/重连语义对齐 ssh2：断开 → 关 channel + drop handle（事件循环自停）→ emit
   Disconnected；重连 = disconnect 后按开关重建（与现有「先 disconnect 再 connect」流程同）。

### 9.4 风险与验收

- **已连接会话 keep-alive**：connect() 的 client::Config 已含 keepalive（隧道同款），
  `inactivity_timeout: None` 必须保留（否则空闲自断 bug 回归）。
- **PTY resize 时序**：resize 走 select 的 cmd 分支，连读高频输出时不丢包（select 公平轮询）。
- 验收：开关开启后四类认证连一次；滚屏/编译输出流畅（对比 ssh2）；断开感知 ≤1s；
  重连三次稳定；监控/SFTP/VNC 不受影响（未走该路径）。
- 失败回退：开关默认 false，russh 路径出问题不影响现有 ssh2 主路径发布。


---

## 10. SFTP russh-sftp A/B 实测与决策（2026-09-08，ssh_ab example）

环境：Windows→WSL sshd 直连 172.22.x.x，1024MiB 真实文件 ×3 中位（块 1MiB）：

| 方向 | ssh2 | russh-sftp | 结论 |
|---|---|---|---|
| 上传 | 150.8 MiB/s | 254.4 MiB/s | russh 1.69×（并发写流水） |
| 下载 | 158.1 MiB/s | 117.1 MiB/s | ssh2 1.35× |

- 两库各有擅场且稳定（±4%），**无净胜**。
- 生产 `upload_local_file` 已用 `TRANSFER_CHUNK_BYTES=1MiB` 大块（对应 bench 150 档），剩余差距只能靠 russh-sftp 整库迁移获得（含并发写流水）；成本（重写命令层/FTP 双态保留/断点进度全量回归）大于 ~1.7× 上传收益 → **SFTP 维持 ssh2，不迁 russh-sftp**。
- 备忘：ssh2 写块 256KB→1MiB 单文件上传 14→150（10×），凡是新增写远端路径一律 ≥1MiB 块（libssh2 逐小块同步等 ack 会退化到 ~14MiB/s）。
- 环境坑：**WSL2 localhost 转发方向不对称**——下载被桥卡在 ~20MiB/s（上传不受影响，210+），bench/验收须连 WSL 的 eth0 IP 直连（hostname -I）或真网卡，否则得到假象。
