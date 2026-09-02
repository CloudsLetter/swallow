# Swallow

跨平台终端客户端：**SSH / SFTP / Telnet / 本地 shell** 四协议，内置服务器监控、密钥 / 证书管理、ProxyJump 与端口转发。

![Version](https://img.shields.io/badge/Version-0.1.0-58A6FF?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)
![Platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)
![Framework](https://img.shields.io/badge/Tauri%202%20%2B%20React%2019-2f81f7?style=flat-square)

[简体中文](README.md) · [English](README.en.md)

---

## 一图速览

![Swallow 主界面](docs/screenshots/preview.png)

## 核心能力

- **四协议统一入口**：SSH / SFTP / Telnet / 本地终端
- **安全模型**：密码与私钥口令存系统钥匙串（Keychain / Windows Credential Manager / Secret Service）；密钥、证书仅写入临时文件、认证后即焚——磁盘不落任何明文材料
- **跳板与端口转发**：SSH ProxyJump 链式穿透；本地 / 远程 / SOCKS5 转发
- **终端渲染可调**：DOM / Canvas / WebGL 三引擎 + GPU 开关，WebGL 不可用时自动回退 Canvas
- **监控免 Agent**：纯 SSH 只读采集，无额外依赖

## 功能特性

### 连接与会话
- 多标签拖拽排序、分屏、会话持久化与自动恢复；断线可配置自动重连
- 主机 / 账号 / 密钥 / 证书 / 已知主机集中管理，卡片与列表双视图
- 首次连接核对主机密钥指纹，防中间人

### 文件传输（SFTP / FTP）
- 双栏文件管理、递归上传下载、断点续传、按文件名搜索
- 拖拽上传、传输队列、chmod 权限修改

### 终端能力
- 256 色 / 真彩色、可配置光标样式、大滚动缓冲
- 快捷指令、SSH 多会话命令广播、代码片段速插
- 可选复制即选、中键粘贴

### 服务器监控
- 多机仪表盘：CPU 环形表 + 实时折线 + 用量进度条
- 详情页：CPU 细分（含 iowait / steal）、内存细分、Top 进程、磁盘与 I/O、每网卡速率、TCP 状态
- 高负载变色告警、按负载排序；监控清单持久化，启动自动恢复

### 观感
- 深色 / 浅色 / 跟随系统；主题整套色板可自定义
- 终端 9 套内置配色，字体、行距、光标可调
- Acrylic / Mica / Blur 毛玻璃、透明背景、终端背景图（可延伸至顶栏）
- 中英文案、首次使用 3 步引导

## 安装

- **Windows**：下载 Release 中 `swallow_<ver>_x64-setup.exe`。目标机无 WebView2 运行时（Win10/11 通常自带）时，改用 `*-full-setup.exe`——内嵌 WebView2 离线安装器。
- **macOS / Linux**：多平台构建已在 GitHub Actions 中推进，完成后 Release 同步提供 `*.dmg` 与 `*.deb` / AppImage。

> 从源码构建：`pnpm install && pnpm tauri build`（详见「开发」）。

## 数据与隐私

- 数据仅存本机：设置 `%APPDATA%\Swallow`，known_hosts 复用 `~/.ssh/known_hosts`，**无遥测**。
- 密码 / 私钥口令 → 系统钥匙串；密钥 / 证书材料 → SQLite，全程不落明文文件。
- 云同步为可选自建服务，处于实验阶段，一般用户无需启用。

## 开发

```bash
pnpm install        # 前端依赖（Node ≥ 20）
pnpm tauri dev      # 开发模式（热重载）
pnpm tauri build    # 发布构建（exe / NSIS / MSI）
```

验证：`cargo check`（在 src-tauri/）+ `npx tsc --noEmit`。


## 路线图（近期）

- [ ] macOS / Linux 正式构建发布（CI 已配置，见 `.github/workflows/release.yml`）
- [ ] 多窗口 / 会话分组
- [ ] 终端自定义右键菜单与宏

## License

[MIT](LICENSE)


## 社区 / Community

欢迎在 [Linux DO 社区](https://linux.do/) 交流 ArHub 的使用体验、问题反馈和扩展想法。

Join the ArHub discussion on [Linux DO](https://linux.do/) to share feedback,
report issues, and exchange extension ideas.
