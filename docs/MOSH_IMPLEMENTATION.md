# Swallow MOSH 实现技术文档

> 实现状态（2026-09-05）：MVP 已实现——QuickConnect / Hosts 连接入口、`mosh` 标签、
> SSH 引导 + mosh-rs 数据面泵、terminalPool 全链路复用。

## 1. 架构：SSH 引导 + mosh-rs 数据面

MOSH 客户端 = SSH 引导 + UDP 数据面（SSP 状态同步 + AES-OCB3 + 帧缓冲差分 + 终端仿真）。
Rust 生态出现了 wire-compatible 客户端 [`mosh-rs`](https://github.com/wilsonglasser/mosh-rs)
（crates.io 0.1.0，与官方 mosh-server 互通），Swallow 直接以其为数据面：

```text
[引导] mosh_connect ──复用 ssh::session 认证链路（主机密钥确认/跳板机/密钥证书）──►
        远程 exec "mosh-server new -c 256 -l LANG=C.UTF-8"（失败自动去 -l 重试）
        解析 stdout 的 "MOSH CONNECT <port> <key>"（官方 ≥1.3 协议），SSH 即断开
[数据面] 专用泵线程：mosh_rs::session::MoshSession::connect_with_size(host, port, key, cols, rows)
        循环：排空输入命令 → pump()（内部等 socket ≤50ms）→ render() 增量 ANSI
        → emit SessionEvent::Output 到 session-{id} → xterm 渲染
[输入]  mosh_write/mosh_resize 命令 → std::mpsc → 泵线程 send_input/send_resize
[收尾]  服务器关闭/异常/stop 标志 → shutdown() 优雅退出 → emit Disconnected → 自查自删
```

要点：
- **无 PTY、无子进程**：泵线程 `render()` 产出的是对 xterm 的增量 ANSI 差分
  （无变化时为空字节，重传帧零开销），与 ssh 读线程的 emit 模型完全同构；
- **输入延迟 ≤50ms**（mosh-rs 泵间隔），本地回显预测（prediction 模块）在协议层生效；
- **尺寸同步**：mosh 无本地 PTY，terminalPool `notifyPtyResize` 按 'mosh' 类型转发
  `mosh_resize`，泵线程 `send_resize` 经协议同步到服务器（不支持时自动断开重连）；
- 服务器侧要求：安装 mosh（≥1.3）并放行 UDP 60000-61000；**本地无需 mosh 客户端**。

## 2. 安全红线

- 会话密钥（MOSH CONNECT 行的 44 字符 base64）仅内存传递：不落日志（错误信息只带
  stderr 尾部）、不进 URL、sessions.json 不存；
- 前端 moshConfig 密码/口令持久化前剥除（App.tsx），恢复缺密码跳过自动连接
  （与 SSH 密码认证同语义）；
- 引导复用 SSH 主机密钥确认：未信任指纹 → `needsHostKeyApproval` → 前端弹窗 →
  `accept_host_key` 入库后重试（与 ssh_connect 完全一致）。

## 3. 集成清单（按 docs/SESSION_PROTOCOL_GUIDE.md）

- 后端：`mosh/{mod,session,manager}.rs`；命令 `mosh_connect/mosh_write/mosh_resize/
  mosh_disconnect/mosh_list_sessions`；AppState `mosh` 字段；ExitRequested 清理。
  ssh_connect 的 key/cert 认证材料装载提取为 `prepare_ssh_auth_material` 共用。
- 前端：`sessionService.mosh*`；terminalPool sessionTypes 加 `'mosh'`（write/resize
  分流）；TerminalView `moshConfig`（mode 'mosh' + 主机密钥确认循环 + 取消清理 +
  在线状态）；tabStore/TabBar（Radio 图标）/Home/QuickConnect 卡片/Hosts 菜单
  （`handleMoshConnect` 复用 resolveHostSshAuth，支持跳板机与证书）/App 持久化/i18n。

## 4. 已知限制 / 后续

1. `mosh-rs` 0.1.0 较新（2026-08），升级需整体核对 API（Cargo.toml 锁 minor）；
2. QuickConnect 卡片仅密码认证；密钥/证书/跳板机走 Hosts 页菜单入口；
3. 浮动窗口（mosh resize 协商）与 prediction 的 UI 呈现（状态条）未做；
4. 真机清单：Ubuntu `apt install mosh` → QuickConnect 连接 → 键鼠/中文/滚轮 →
   断网重连续连（mosh 核心卖点）→ 关标签释放 → 重启恢复。
