# AGENTS.md

本文件是 Swallow 仓库对 AI 编码代理（Claude Code / Codex / Cursor / Copilot / MiMoCode 等）的**唯一规范入口**。

开工前通读本文件；**动某个模块之前，先读第 7 节「深挖索引」里对应的那一份**。`.github/copilot-instructions.md` 只是指向本文件的薄壳，规范一律写在这里，不要在两处各写一份。

---

## 1. 项目速览

Swallow 是 Tauri 2 桌面终端客户端：**SSH / SFTP / Telnet / 本地 shell / VNC / RDP / MOSH / 串口**八类会话，外加服务器监控、密钥与证书管理、ProxyJump 与端口转发、可选自建云同步。对标 Xshell / Termius。

| 层 | 技术栈 |
|---|---|
| 前端 | React 19 + TypeScript 5.8（`strict`）+ Vite 8 + Tailwind CSS v4 + Zustand + react-i18next + xterm 6.0 + shadcn/ui(Radix) + react-dnd |
| 后端 | Rust + Tauri 2；ssh2 0.9.6（vendored-openssl）/ russh `=0.60.1`（vendor 内打过补丁）/ suppaftp 11 / portable-pty / rusqlite / keyring / tungstenite 0.30 |
| IPC | 前端 `invoke` 调命令；终端输出走事件 `session-{id}`（Output / Disconnected / Error / Progress） |

- 当前版本 **0.5.2**，**三处必须一致**：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（`src-tauri/Cargo.lock` 里的同名字段跟着走，发版时共 4 个文件）。
- 数据全部本机、无遥测，落在 `%APPDATA%\Swallow`：`config.toml` / `data.sqlite3` / `sessions.json`（序列化前剔除密码）。
- 依赖版本有硬锁（ssh2 / russh / suppaftp / tungstenite 等），**加依赖前先 `cargo add` 验证解析，别信 docs 上的版本号**，理由见 `.workbuddy/memory/TOPIC-backend.md`。

---

## 2. 命令

```bash
pnpm install              # 前端依赖（Node ≥ 20，只用 pnpm；npm/yarn 会破坏 lockfile）
pnpm tauri dev            # 开发模式（热重载）
pnpm tauri build          # 发布打包（exe / NSIS / MSI）
pnpm lint                 # ESLint（只查 src，风格规则全关）
pnpm lint:fix             # ESLint 自动修复
pnpm typecheck            # tsc --noEmit
pnpm test                 # 单测（vitest run）
```

**验证命令**（改动完必跑，见第 6 节）：

```bash
cargo check                                         # 在 src-tauri/ 下跑
unset NODE_OPTIONS && npx tsc --noEmit              # bash；PowerShell 用 Remove-Item Env:NODE_OPTIONS
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build          # vite 会清空 dist，沙箱拦截删除时需前置该变量
```

⚠️ 跑 `tsc` 前**必须清掉 `NODE_OPTIONS`**；⚠️ `tsconfig` 开了 `noUnusedLocals` / `noUnusedParameters` —— 删代码后残留的未使用 import / 变量会报 **TS6133**，本地看着无害，**CI 的 Release 会因此变红**（v0.4.1 实证）。

⚠️ 本仓库**没有 Prettier / rustfmt 配置**，代码风格是手工维护的（`.deepsource.toml` 里刻意关掉了 formatter）。**不要顺手格式化**，那会产生海量纯重排 diff、淹没真实改动。

### 2.1 lint / 钩子 / CI 的既定策略（别回退）

- **CI**：`.github/workflows/ci.yml` 在 PR 与 push master 时跑 `typecheck + lint + test`，**不过不能合**。它的意义是把 TS6133 这类问题挡在合并前——Release 只在 `v*` tag 触发，此前要到发版才发现。（Rust 侧不在该工作流内，仍由 `release.yml` 构建把关。）
- **ESLint 规则集**：`eslint.config.js` 保留 typescript-eslint recommended + react-hooks 的 `rules-of-hooks`（error）与 `exhaustive-deps`（warn），**刻意关闭 15 条 React Compiler 规则**。关闭理由是实测过的，不是图省事：
  - 误报：`PageHeader` 因 props 对象里含一个 ref，连 `search.value` 这种普通读取都被判「render 中访问 ref」（该文件 4 条全是这个原因）；`TabBar` 的 `tabIcon(type)` 只是从协议注册表取既有组件，被判「render 中创建组件」。
  - 其余属「为启用 React Compiler 而改造」的范式要求（`set-state-in-effect` 曾命中 24 处），不是缺陷。
  - **要上 React Compiler 时整体开启做专项迁移，不要零散往回加**。
- `exhaustive-deps` 是 warning，**不阻断 CI**（目前存量 19 条待清理）。不要给 lint 脚本加 `--max-warnings=0`，否则 CI 立刻变红。
- **预提交钩子直接调 `eslint`，不走 lint-staged**（`.husky/pre-commit`）：lint-staged 收尾时会 `git add` 它从**整份工作区 diff**（不只它检查的暂存文件）里挑出的文件，于是 ① 试图 add 被 `.gitignore` 覆盖的 `docs/*.md`（`.gitignore` 有 `docs` 规则，而 `docs/` 下文件是「已跟踪但被 ignore 覆盖」的历史状态，见 §5）→ git 报 `The following paths are ignored…: docs` → `Failed to stage changes from tasks!`，**只要工作区有 `docs/*.md` 的未暂存改动，任何提交都过不去**；② 会把无关的未暂存文件一并暂存进来。该行为与是否加 `--fix`、`core.autocrlf` **都无关**（2026-10-06 用 `lint-staged --debug` 定位，此前误判为 `--fix` 引起）。`lint-staged.config.mjs` 已不被钩子调用、暂留作参考。
  钩子只检查、不改文件；要自动修复手动跑 `pnpm lint:fix`。若要用回 lint-staged：先处理 `.gitignore` 的 `docs` 规则与 `.gitattributes` 行尾策略，再用 `--debug` 验证。


---

## 3. 目录结构

```
src/                     前端
├── components/          布局、TabBar/Topbar、终端与文件视图、terminalPool / sftpPool（模块级会话池）
├── pages/               管理页（主机/账号/密钥/证书/SFTP/…）、Monitor 监控仪表盘
├── services/            invoke 封装 + sshAuthResolver（认证解析）
├── store/               Zustand：tabStore / transferStore / config / broadcast / splitLayout…
├── hooks/               useTerminalFit / useTerminalBackground / useSessionConnection / themeUtils
├── extensions/          protocols.ts（协议注册表单点）、pages.ts、quickConnect.ts
└── i18n/locales/        zh-CN.ts / en-US.ts（新增文案必须两处都写）

src-tauri/src/           后端
├── lib.rs               命令注册入口（generate_handler）
├── ssh/ sftp/ telnet/ local/ mosh/ vnc/ rdp/ serial/    各协议连接与会话
├── monitor/             服务器监控采集（/proc 组合命令 ==NAME== 分段解析）
├── commands/ services/ models/ utils/ platforms/        IPC 命令、数据 CRUD、配置模型、工具
└── vendor/russh/        被 git 跟踪的第三方 russh 源码（含 pkcs5 兼容补丁，勿随手改）

server/swallow-server/   云同步服务端（Rust actix-web + diesel，目前仅骨架）
docs/                    设计文档（BACKEND_DESIGN.md §14.1 汇总各协议实现陷阱）
```

---

## 4. 铁律

### 4.1 ⚠️ 前端改动「没生效 / 像是被回滚」→ 先怀疑跑的不是源码

前端资源在**编译时被 brotli 压缩嵌进 exe**，所以改 `src/`、改 `dist/` 对已安装的 `%LOCALAPPDATA%\swallow\swallow.exe` **零影响**；而且 exe 内**没有明文**，`grep` 任何字符串永远 0 命中 —— **不能据此判断版本新旧**（极易误判）。

诊断：用 `Get-CimInstance Win32_Process` 取运行进程的 `ExecutablePath` / `CreationDate`，与源码 mtime 比对。
生效只有两条路：`pnpm tauri dev`，或重打包重装。

⚠️ 跑 `pnpm tauri dev` 前必须**先关掉安装版**：`tauri-plugin-single-instance` 会让 dev 实例聚焦既有窗口后自杀（连带关掉 Vite）。**别擅自 kill 安装版**，它可能正跑着用户的 SSH 会话。

### 4.2 ⚠️ 验证前端样式 / 字体，别用浏览器直开 dev server

Swallow 在纯浏览器里跑不起来（缺 `__TAURI_INTERNALS__`；实测样式表为 0、root 空、`document.fonts` 空），看起来像「没生效」，会把人带进沟里。正确姿势：`pnpm build` → 往 **`dist/`（已 gitignore）**写一个临时探针页 `<link>` 引生产 CSS、用 canvas `measureText` 取数值 → 起本地静态服务 → 无头浏览器读数值 → **用完删掉探针页**。

### 4.3 后端并发

`AppState` **不外包 Mutex**：各 Manager 自带锁（RwLock / DashMap / Arc），tunnel / monitor / sftp 互不阻塞。会话池存 `Arc`，一律「**短锁取 Arc → 立即释放 → 再执行**」；长操作与网络 I/O 绝不持全局锁；阻塞 I/O 一律 `spawn_blocking`。例外是 `russh_shells` / `transfer_cancels`（裸 HashMap + Mutex，只在短锁内 get/clone/remove，**不跨 await**）。事件 payload 必须 `#[serde(rename_all = "camelCase")]`（命令参数自动转，`emit` 不转）。

### 4.4 ssh2 的 `flush` 是陷阱

Channel / Stream 的 `flush` 语义是「**丢弃接收缓冲**」而非刷出 —— 终端写路径一律不调用。

### 4.5 认证只走一条链

连接前必须经前端 `resolveHostSshAuth(host, accounts, keys, certs)`（返回错误非空则不可连），拿到 `keyId` / `certId` 传给后端，后端按 id 从 DB 取密钥 / 证书内容。后端的唯一入口是 `ssh/auth.rs` 的 `resolve_host_ssh_config` / `prepare_ssh_auth_material`。⚠️ Windows 上临时文件必须 `tempfile::tempdir() + fs::write()`，**禁用 `NamedTempFile`**（独占句柄 → Permission denied）。

### 4.6 敏感材料不落盘

密钥 / 证书内容存 SQLite **不写磁盘文件**（仅认证期临时文件、用后即焚）；密码与私钥口令存系统钥匙串（keyring）。主机密钥确认走 `PENDING_HOST_KEYS`，**密钥不过 IPC**。导出默认脱敏，含凭据必须显式 `include_secrets`。

### 4.7 错误契约按 `code` 分支

`ssh/errors.rs` 的 `IpcError { code, message }` + `SshError::classify` 负责 IPC 边界映射。**前端按 `code` 分支做 i18n 与重试**，不要再逐字匹配中文错误串。

### 4.8 文案双语

新增任何用户可见文案，`src/i18n/locales/zh-CN.ts` 与 `en-US.ts` **两处都要写**。

### 4.9 新增一类 CRUD 的完整配套

后端 `models` → `sqlite` 建表 / `ensure_column` → `services/<n>.rs` → `mod.rs` → `lib.rs` 注册；
前端 `dataService` → 页面 → `SideMenu` → Home 路由 → zh/en 文案。**漏一环就是「功能存在但入口找不到」。**

分类导入导出（已取代旧的全量备份 JSON）在 `services/transfer.rs`，8 个类目各三条命令，新增类目还要挂 `EXPORT_COMMANDS` 与页面组件。
⚠️ 在 `#[tauri::command]` 函数前插入代码时，**属性行必须留在原函数上**，否则属性会挂到新插入的 const 上 → `cannot find value`（`hosts.rs` 实证）。

### 4.10 协议注册表单点

`src/extensions/protocols.ts` 是「type → icon / terminalLike / sidePanel」的**唯一来源**（TabBar、命令面板、AI 工具、Home 侧栏都用它），加协议只改这一处。⚠️ 删掉旧的散落映射表后，**记得清理变成未使用的图标 import**（否则 TS6133 → Release CI 红）。

---

## 5. 提交与协作纪律

- **仅当用户明确说「提交 / 确认提交」才 commit。** commit message **一律英文**。
- **预提交钩子已装**（husky，`core.hooksPath=.husky/_`）：每次 commit 对**暂存范围内**的 ts/tsx 跑 `eslint`（直连，不经 lint-staged —— 原因见 §2.1），有 error 直接拦住。钩子只检查不改文件，改完请手动 `pnpm lint:fix`。CI 里已用 `HUSKY=0` 关掉钩子。
- ⚠️ **本仓库会被多个会话并发编辑**（曾发生：提交期间 `sqlite.rs` / `Cargo.toml` / `lib.rs` 被另一会话改；`cloud-server/` 被整目录删除；`docs/` 多个 md 被重排）→
  - **只 `git add` 明确路径，禁 `git add -A` / `git add .`**；
  - 提交前用 `git diff --cached --name-only` 核对文件数量；
  - **看不懂的改动不要提交，先问用户**。
- ⚠️ **`git push` 一律交用户在已认证终端执行**（沙箱内 push 会因 `credential.helper` 需要交互而挂死；`ls-remote` 能通不代表能 push）。
- ⚠️ merge / pull 之后**必扫冲突标记**：`git grep -n -E '^(<<<<<<<|>>>>>>>) '` —— `Merge made by the 'ort' strategy` **不代表没留标记**（实证：残留标记被原样提交，TOML 非法后 DeepSource 静默忽略整份配置）。
- ⚠️ **配置文件（toml / yaml）提交前跑一次解析**（`tomllib` / `js-yaml`）—— git 不校验内容，坏文件会让工具**静默**读不到配置。
- 前端长时间未提交时**不要整体 `git checkout` / `git stash`**，会丢别人的活。
- 新建 `docs/*.md` 首次入简要 `git add -f`（`.gitignore` 里有 `docs` 条目，但 `docs/` 下已有 11 个文件是跟踪状态）。

---

## 6. 完成标准

一个改动算完成，需要同时满足：

1. **类型检查过了**：前端 `pnpm typecheck`（或 `npx tsc --noEmit`，先清 `NODE_OPTIONS`）；后端 `cargo check`。
2. **ESLint 过了**：`pnpm lint` 无 error（warning 不阻塞，但别新增）。
3. **对应测试过了**：改到已有测试覆盖的模块，跑 `pnpm test`。⚠️ 本仓库测试网很薄（`src/**/*.test.ts` 目前只有个位数），**别假设有完整测试兜底**，可靠性主要靠第 4 条。
4. **功能真的跑过一遍**：前端改动走 `pnpm tauri dev` 或重打包，把主路径和边界都点一遍。**纯浏览器打开不算验证**（见 4.2）。跑不了 dev / 打包就**明说没验证**，不要声称完成。
5. **双语与配套齐了**：新文案两处语言文件、新 CRUD 的 4.9 清单。
6. **没有夹带**：`git diff` 里不应出现格式化重排、别的会话的改动、临时探针文件。

---

## 7. 深挖索引（按需先读）

`.workbuddy/memory/` 是**本地目录，不进版本库**（gitignore），只在本机存在。`docs/` 已纳入版本库。

| 要动什么 | 先读 |
|---|---|
| 全局最高频坑位（前端不生效、并发编辑、发版） | `.workbuddy/memory/MEMORY.md` |
| 终端字体 / 符号溢出 / xterm 渲染 / 字体工具 | `.workbuddy/memory/TOPIC-terminal-fonts.md` |
| 云同步 / server_key / 身份与共享 | `.workbuddy/memory/TOPIC-cloud-sync.md` |
| 后端状态与锁 / 协议模块陷阱 / 认证 / 导入导出 | `.workbuddy/memory/TOPIC-backend.md` |
| 前端 UI 约定 / 构建与验证手法 / 提交纪律 | `.workbuddy/memory/TOPIC-frontend.md` |
| 各协议实现细节（monitor 分段、VNC 校验、RDP、MOSH、串口…） | `docs/BACKEND_DESIGN.md` §14.1 |
| 云同步服务端形态 | `docs/CLOUD_SERVER_IMPLEMENTATION.md`、`docs/CLOUD_SYNC_DESIGN.md` |
| 会话协议 / 移动端移植 | `docs/SESSION_PROTOCOL_GUIDE.md`、`docs/mobile-porting.md` |
| shadcn/ui 组件用法 | `.agents/skills/shadcn/SKILL.md`（本地目录） |
| 改 ESLint 规则 / 预提交钩子 / CI | `eslint.config.js`、`.husky/pre-commit`、`.github/workflows/ci.yml`（**为什么这么配见 2.1，别直接开规则、别把钩子换回 lint-staged**） |

⚠️ 云同步服务端正处于迁移中：旧 Node 版 `cloud-server/`（`server.cjs`）已从工作区移除，新 Rust 版 `server/swallow-server/` 目前只有骨架。**动云同步前先跟用户确认服务端形态与去留。**

---

## 8. 发布

`.github/workflows/release.yml` 由 tag `v*` 触发，在 Windows 上打包 exe / NSIS / MSI 并自动上传 GitHub Release，版本号取自 `package.json`。

发版前必跑：`CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build` + `cargo check`（CI 还会跑 `tsc --noEmit`）。
发版提交（`release: vX.Y.Z`）是**独立提交、只动 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` 这 4 个文件**，不要混入功能改动。

---

## 9. 禁止事项

- 不要跑格式化工具，不要做与任务无关的重构。
- 不要 `git add -A` / `git add .`，不要 push，不要在没有明确要求时 commit。
- 不要删除或改写 `.workbuddy/`、`docs/`、`src-tauri/vendor/` 里看起来「多余」的内容 —— 它们可能是别人的在制品或必需的补丁。
- 不要为了「让报错消失」而绕过检查（`--no-verify`、注释掉断言、放宽 tsconfig、给错误串加 try/catch）。
- 不要凭记忆写 Tauri / xterm / ssh2 的 API：本仓库大量坑位是「看起来能用、实际静默失效」，先查 `.workbuddy/memory/` 与 `docs/`。
- 不要在真实 push 前声称「已提交 / 已发布」。
