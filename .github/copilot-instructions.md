# Swallow — Copilot 指令

**规范正文在仓库根目录 [`AGENTS.md`](../AGENTS.md)。开工前请完整阅读它。**

本文件保留为入口占位：GitHub Copilot 只读 `.github/copilot-instructions.md`，其它工具（Claude Code / Codex / Cursor / MiMoCode…）读根目录 `AGENTS.md`。为避免两处规范漂移打架，**内容一律只在 `AGENTS.md` 维护，不要写在这里**。

`AGENTS.md` 包含：项目与技术栈速览、构建与验证命令、目录结构、10 条防回归铁律（并发与锁、ssh2 `flush` 陷阱、认证链路、错误契约、i18n 双语、CRUD 配套清单…）、提交与协作纪律、完成标准、深挖文档索引、发布流程与禁止事项。

两条最容易踩的，先记在这里：

1. **改前端"没生效"≠ 被回滚** —— 用户很可能跑的是已安装 exe，前端资源编译时嵌进了 exe，源码改动对它零影响；且 exe 内无明文，`grep` 永远 0 命中，不能据此判版本。
2. **本仓库会被多会话并发编辑** —— 只 `git add` 明确路径（禁 `-A` / `.`），且仅当用户明确说"提交"才 commit。

Swallow：Tauri 2 桌面终端客户端（SSH / SFTP / Telnet / 本地 / VNC / RDP / MOSH / 串口 + 监控 + 云同步）。
