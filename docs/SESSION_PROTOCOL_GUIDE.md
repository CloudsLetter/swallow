# 新增会话协议接入指南（SSH/Telnet/Serial/VNC 同构路径）

> 目标：仓库内加一个新会话协议（如 RDP、FTP 终端化、蓝牙串口等）时，按本文档照单执行，
> 不必再从 telnet / serial / vnc 三套实现反推接入点。
> 参考实现：`telnet/`（最简单，无认证流式文本）、`serial/`（阻塞读 + 参数校验）、`vnc/`（桥接 + 代际并发）。

## 0. 先决定两件事

1. **会话形态**：文本流（复用 xterm 终端体系，走 terminalPool）还是特殊视图（VNC 的 noVNC / 未来 RDP）？
   - 文本流：`TerminalView` + terminalPool 分发，接入成本最低。
   - 特殊视图：独立组件 + 独立会话管理（参考 `components/VncView.tsx`），不走 xterm。
2. **事件通道**：文本流统一走后端 `SessionEvent`（`Output`/`Disconnected`/`Error`/`Progress`）emit 到
   `session-{id}`；连接进度 `stage` 固定为 `tcp/ssh/auth/shell/ready`（与前端 buildConnectionSteps 顺序对应）。
   特殊视图可走 invoke 返回值 + 组件自有事件（VNC 用 noVNC 回调，不用 session 事件）。

## 1. 后端 checklist（Rust）

### 1.1 依赖
- `Cargo.toml` 加 crate。⚠️ 本机 cargo 用 tuna 镜像，可能只有较新大版本（如 serialport 只有 4.x，
  0.x 旧线会解析失败）——先 `cargo add` 或手写后以编译错误反推 API，不要假设版本。
- 阻塞 I/O 库（ssh2/serialport 等）的调用一律放 `tauri::async_runtime::spawn_blocking`，禁止在 async 命令里直跑。

### 1.2 模块结构（`src-tauri/src/<proto>/`）
```
mod.rs      # 类型（Config/Result，serde camelCase）+ 常量 + 子模块声明 + pub use
session.rs  # 会话：打开/读写/断开；文本流含阻塞读线程 emit 事件；断开置空唤醒读线程
manager.rs  # 会话注册表：短锁取 Arc→立即释放→再执行；后台任务结束自查自删（token 比较防误删）
```
- 会话表放 `Arc<Mutex<HashMap>>` 共享给后台任务自查自删；对外 manager 用 `Mutex<Manager>` 包在 AppState。
- 重复 sessionId 语义：文本流「先查复用再建连」（serial 的教训：先开设备后查会泄漏句柄/占端口）。

### 1.3 lib.rs 接线（4 处，缺一不可）
1. `mod <proto>;` + `use <proto>::{...};`
2. `AppState` 加字段 `xxx: Mutex<XxxManager>` 并在 `AppState::new`/default 初始化。
3. 命令：`xxx_connect` / `xxx_write` / `xxx_disconnect` / `xxx_list_sessions`（照抄 monitor 或 serial 的
   `State<'_, AppState>` 签名），并加入 `generate_handler![...]`。
4. `RunEvent::ExitRequested` 清理块追加 `manager.stop_all()`。
- 连接命令网络等待全部在锁外完成后再进锁 `manager.start(...)`，绝不在持锁时 await。
- 文本流 connect 成功前按阶段 `emit Progress { stage }`（tcp→auth→…→ready），前端进度条依赖它。

### 1.4 参数校验与单测
- connect 入口校验非空/端口/枚举范围；可复用的参数归一化放 session 模块顶层函数，便于单测。
- 每个模块补 `#[cfg(test)]`：参数校验、拒绝/断开路径、往返 echo（VNC 有 ws<->tcp echo 全套示例）。

## 2. 前端 checklist（TypeScript/React）

### 2.1 服务与分发（文本流）
- `services/sessionService.ts`：`xxxConnect/Write/Disconnect/ListSessions` invoke（参数自动 camelCase）。
- `components/terminalPool.ts`：`setSessionType(sessionId, type)` 类型联合加新值；
  `enqueueWriteToTargets` 写分支（`if (st === 'xxx') return xxxWrite(id, data)`）；
  Telnet/Serial/Local 已示范「连接函数 + 断开函数」如何注入 TerminalView。
- `components/TerminalView.tsx`：props 加 `xxxConfig`；连接前判定会话模式并 `setSessionType`；
  连接分支 / 取消分支（断开清理孤儿会话）/ `buildConnectionSteps(mode, opts, t)` 加 mode 与文案。

### 2.2 标签体系（所有协议都要）
- `store/tabStore.ts`：
  - `TabType` 联合加 `'xxx'`；新增 `XxxTabConfig`；`Tab` 接口加 `xxxConfig?`。
  - `disposeSession` 加断开分支（文本流走 terminalPool 清理 + 对应 disconnect 命令）；
    `closeTab` 里 disposeSession 的类型联合、`recentlyClosed` 记录条件、`restoreLastClosedTab` 恢复字段
    三处同步加，漏一处 = 关闭不释放 / 恢复丢配置。
  - `canMergeTabs`：若 SplitPane.type 不支持该类型，source/target 命中即返回 false（VNC 已示范）。
- `pages/Home.tsx`：type-switch 渲染分支（keep-alive，非激活 display:none 不卸载）。
- `App.tsx`：sessions.json `persist` 类型联合 + 恢复数组类型；**剥密码/口令再落盘**（含嵌套，VNC 的 ssh 就是嵌套）；
  `skipAutoConnect` 语义——只有「恢复后必然失败」才 skip（SSH 密码认证缺密码）；**无交互兜底型缺密码不要 skip**
  （直连 VNC 靠 noVNC 弹窗兜底，参考 88fadc7 修复）。
- `components/TabBar.tsx`：图标 case（lucide 里挑）+ 标题（若标签名有默认逻辑）。

### 2.3 入口与文案
- `pages/QuickConnect.tsx`：加协议卡（风格对齐现卡：label 定宽 + 输入 + 按钮）；
  若入口来自 Hosts 主机：菜单项 + 弹窗（参考 Hosts VNC）；跨页定位用一次性 intent 模块（`services/quickConnectIntent.ts`）。
- `src/i18n/locales/{zh-CN,en-US}.ts`：协议相关 key 双语文案一次补齐。

## 3. 安全 / 持久化红线
- 密码、passphrase、私钥材料：内存对象可携带，**sessions.json 一律剥除再落盘**（含 config 嵌套字段）。
- 会话 URL / 日志 / 持久化文件不得携带任何凭据或远端目标（VNC 用随机 token 鉴权本地桥，URL 只含 token）。
- 文本流日志录制沿用 session_log 链路即可（输入行打 `in:` 前缀，敏感内容与 Xshell 同风险）。

## 4. 验证 checklist
1. `cargo check`（0 error，尽量 0 warning）→ `cargo test`（新模块 + 全量回归）。
2. `unset NODE_OPTIONS && npx tsc --noEmit`（注意先 unset，本机 NODE_OPTIONS 注入会干扰）。
3. `pnpm build`（VNC/Serial 懒加载已示范按需 chunk；无强需求勿用 manualChunks——只在打包生效，dev 走 ESM）。
4. 真机清单：QuickConnect 打开 → 收发/画面 → 参数或凭据错误提示 → 关标签资源释放 →
   断连重连 → 应用重启自动恢复（缺凭据会话应跳过并允许手动重连）。
5. 发布前核对 README 协议清单与任何蓝图文档（docs/*），标注实现状态。

## 5. 高频坑速查
- Rust 函数参数不能写 `///` doc 注释（用 `//`）。
- emit 事件 payload 需 `#[serde(rename_all="camelCase")]`（命令参数自动转，事件不会）。
- 并发：同一 sessionId 的 connect/disconnect 会乱序——需要「代际」就参考 VNC generation
  （新代可覆盖旧代，旧代迟到被拒，disconnect 可带代际精确停）。
- 前端取消标记别用「被下次 mount 重置的布尔」（StrictMode 双挂载会复活旧流程）——用单调 ref 计数。
- Windows 下拖放/临时文件等平台差异见仓库根记忆（`.workbuddy/memory`），不在此重复。
