# Swallow - Tauri Desktop Application

SSH/SFTP/Telnet/本地终端 桌面客户端（对标 Xshell/Termius）。详细权威约定见 `.workbuddy/memory/MEMORY.md`（源码级坑位档案），改动核心模块前务必先读。

## 技术栈

- **前端**: React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + Zustand + react-i18next + xterm.js 5（DOM/Canvas/WebGL 渲染可选）+ react-dnd + shadcn/ui + lucide-react
- **后端**: Rust + Tauri 2；ssh2(SFTP 复用) / suppaftp / portable-pty / rusqlite / keyring
- **IPC**: 前端 `invoke` 命令；终端输出走事件 `session-{id}`（Output/Disconnected/Error/Progress）

## 目录结构

```
src/              前端
├── components/   布局、TabBar/Topbar、终端/文件视图、terminalPool/sftpPool（模块级会话池）
├── pages/        管理页(主机/账号/密钥/证书/SFTP/…)、Monitor(监控仪表盘)
├── services/     invoke 封装 + sshAuthResolver(认证解析)
├── store/        Zustand：tabStore/transferStore/config/broadcast…
├── hooks/        useTerminalFit/useTerminalBackground/useSessionConnection/themeUtils
└── i18n/         中英文案（新增文案必须 zh+en 两处）

src-tauri/src/    后端
├── lib.rs        命令注册入口
├── ssh/ sftp/ telnet/ local/  四协议连接+会话（会话池 Arc<Session>）
├── monitor/      服务器监控采集（/proc 组合命令 ==NAME== 分段解析）
├── services/     数据模块 CRUD + cloud_sync + monitor_state
├── models/       config.rs（配置模型）
└── utils/        sqlite/path/file/secrets/crypto/init
```

## 关键约定（防回归，详见 MEMORY.md）

1. **并发铁律**：短锁取 `Arc` 立即释放；阻塞 I/O 一律 `spawn_blocking`；会话池长操作绝不持全局锁。
2. **ssh2 flush 是陷阱**：Channel/Stream 的 flush 会丢弃接收缓冲——终端写路径一律不调用。
3. **认证链路**：连接前必须走前端 `resolveHostSshAuth(host, accounts, keys, certs)`（错误非空不可连），返回 keyId/certId 传给后端，后端按 id 从 DB 取密钥/证书内容（临时文件认证、用后即焚）。
4. **密钥/证书内容存 DB 不落盘**；密码存系统 keyring。
5. **数据持久化**：config.toml / data.sqlite3 / sessions.json 都在 `%APPDATA%\Swallow`；`sessions.json` 序列化前剔除密码。
6. **终端渲染引擎可选**（DOM/Canvas/WebGL+GPU 开关）：引擎只对**新建终端**生效；addon 加载失败自动降级 canvas/dom（`terminalPool::applyRenderAddon`）。
7. **fit 用原生 FitAddon.fit()**（勿自定义列宽算法，历次尝试均已还原；末列偶发微裁为已知遗留）。
8. **新增 CRUD**：models → sqlite 建表 → services → lib.rs 注册 → 前端 dataService → 页面 → SideMenu/路由 → i18n。
9. **前端依赖用 pnpm**；验证命令 `cargo check` / `unset NODE_OPTIONS && npx tsc --noEmit`。
10. 顶栏背景延伸：激活标签注入 `--topbar-ext-{fg,fg-dim,hover-bg}`（勿 removeProperty，多实例竞态）。

## 发布

`.github/workflows/release.yml`：推 `v*` tag 触发 Windows 打包（exe/NSIS/MSI）并自动上传 GitHub Release。
