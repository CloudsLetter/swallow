# Swallow 移动端移植技术方案（Tauri 2 → iOS / Android）

> 基于 2026-09 代码现状（v0.1.5）。核心结论：**不换框架**，使用 Tauri 2 官方移动端支持，
> Rust 协议层（ssh2 / mosh-rs / ironrdp / supaftp / tokio-tungstenite）原样保留，
> 按 platform feature 裁剪桌面专属能力，前端做响应式 + 触屏改造。

---

## 0. 可行性总览

| 能力 | Rust 依赖 | Android | iOS | 策略 |
|---|---|---|---|---|
| SSH / SFTP / 隧道 | `ssh2`(vendored openssl) | ✅ | ✅ | 保留 |
| MOSH | `mosh-rs` + UDP | ✅ | ✅ | 保留，**移动端主打** |
| RDP | `ironrdp-client` | ✅ | ✅ | 保留（纯 Rust，帧发前端 canvas） |
| VNC | `tokio-tungstenite` | ✅ | ✅ | 保留 |
| Telnet | tokio TCP | ✅ | ✅ | 保留 |
| 端口转发 / 监控 | tokio + ssh2 | ✅ | ✅ | 保留 |
| 本地 Shell | `portable-pty` | ⚠️ 受限 | ❌ 平台禁止 | feature 裁剪 |
| 串口 | `serialport` | ❌（API 不同） | ❌ | feature 裁剪 |
| 系统凭据 | `keyring` | ❌ 无 backend | ❌ 无 backend | 换 Keychain/Keystore 实现 |
| 更新器 / 单实例 | tauri-plugin-updater / single-instance | 桌面专属 | 桌面专属 | feature 裁剪 |
| WebView2 拖拽 | `webview2-com` | 桌面专属 | 桌面专属 | 已是 cfg(windows)，无需动 |

交叉编译层面没有必须替换的核心库：`ssh2` 的 vendored openssl 支持 NDK 与 iOS 工具链，
`rusqlite` bundled、`aes-gcm`、`ring`（rustls）均为移动端可编译。

---

## 1. 工程结构变更

```
src-tauri/
├── Cargo.toml            # 增加 desktop/mobile feature 分组
├── src/
│   ├── lib.rs            # run() 按平台分支注册插件与命令
│   ├── platforms/        # 新增：平台差异层
│   │   ├── mod.rs        # pub mod desktop; pub mod mobile;（按 cfg 导出）
│   │   ├── desktop.rs    # keyring 封装、window_effect、single-instance 等
│   │   └── mobile.rs     # secure_storage 封装（Keychain/Keystore）
│   └── ...               # ssh/ mosh/ rdp/ vnc/ sftp/ services/ 等不动
├── gen/                  # tauri ios init / android init 生成（提交到 git）
│   ├── android/
│   └── apple/
└── tauri.conf.json       # 拆分出 tauri.conf.json + tauri.android.conf.json + tauri.ios.conf.json
```

初始化：

```bash
pnpm tauri ios init
pnpm tauri android init --target aarch64,armv7,x86_64   # x86_64 用于模拟器调试
```

平台差异配置放覆盖文件（Tauri 会合并）：

- `tauri.android.conf.json`：`bundle.android`（minSdkVersion 26、permissions：INTERNET、
  ACCESS_NETWORK_STATE、FOREGROUND_SERVICE）；窗口配置删除（移动端无多窗口）。
- `tauri.ios.conf.json`：`bundle.iOS`（deploymentTarget 15.0+）、
  `app.security.csp` 追加 WKWebView 需要的 connect-src。

---

## 2. Rust 侧改造

### 2.1 Cargo feature 分组

```toml
[features]
default = []
desktop = [
  "dep:portable-pty", "dep:serialport", "dep:keyring",
  "dep:tauri-plugin-single-instance", "dep:tauri-plugin-updater",
  "dep:tauri-plugin-process", "dep:webview2-com", "dep:windows-core",
]
mobile = []
```

把桌面专属依赖加上可选标记 `optional = true`。`tauri` 本身、协议层依赖保持无条件编译。
现有 `[target.'cfg(target_os = ...)'.dependencies]` 中的 keyring/webview2-com
移入 `desktop` feature 下的 target 段。

### 2.2 模块级 gate

`lib.rs` / `mod.rs`：

```rust
#[cfg(desktop)] pub mod local;      // portable-pty 本地 shell
#[cfg(desktop)] pub mod serial;
```

命令注册拆分（`generate_handler!` 宏不支持条件项，需拆成两个宏调用拼接）：

```rust
let handler = tauri::generate_handler![
    ssh_connect, ssh_write, ssh_resize, ssh_disconnect, ssh_list_sessions,
    telnet_*, mosh_*, vnc_*, rdp_*, monitor_*, sftp_*, start_port_forward,
    // ... 全平台命令
];

#[cfg(desktop)]
let handler = handler.merge(tauri::generate_handler![
    local_shell_*, serial_*, apply_window_effect, /* ... */
]);

// 注：handler 是 Wry/Webview 相关类型，实际写法为在 builder 处按 cfg 选择完整列表，
// 或把命令列表抽成函数返回 Vec<&'static str> 不可行 —— 推荐做法：
// 将 desktop 专属命令放一个 cfg(desktop) 的宏内，与全平台宏按平台分别调用一次
// generate_handler!（Builder 只能 invoke_handler 一次，故用 cfg 构造两个完整表达式分支）。
```

最简可靠写法（推荐）：把 `run()` 的 builder 部分按 `#[cfg]` 写两个分支，
公共插件/命令提取为辅助函数减少重复：

```rust
#[cfg(desktop)]
fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { /* 现有逻辑 */ }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![local_shell_connect, /* ... */])
}
```

（`generate_handler` 只能设一次，因此桌面分支 = 公共命令 + 桌面命令的完整列表；
移动分支 = 公共命令列表。用 include 式宏 `crate::commands!(public [..] desktop [..])`
可消重，非必需。）

### 2.3 凭据存储替换（keyring → Keychain / Keystore）

现状：`keyring` 按 OS 走 Windows Credential Manager / macOS Keychain / libsecret，
上层已有 `aes-gcm` + `pbkdf2`/`hkdf` 的字段级加密。移动端方案：

1. **iOS**：Security.framework 的 Keychain（kSecClassGenericPassword）。
2. **Android**：Jetpack Security（EncryptedSharedPreferences / AndroidKeyStore）。
3. 推荐直接用社区插件 `tauri-plugin-secure-storage`（iOS Keychain + Android Keystore，
   Tauri v2 兼容）并封装到 `platforms/mobile.rs`，暴露与现有 keyring 调用点相同的
   trait 接口：

```rust
pub trait CredentialStore: Send + Sync {
    fn get(&self, service: &str, account: &str) -> anyhow::Result<Option<String>>;
    fn set(&self, service: &str, account: &str, secret: &str) -> anyhow::Result<()>;
    fn delete(&self, service: &str, account: &str) -> anyhow::Result<()>;
}
```

`services/keys.rs`、`accounts.rs` 里对 keyring 的调用全部改走此 trait，
运行期由平台分支注入实现。`aes-gcm` 字段加密层不变——迁移老数据无需处理
（桌面与移动端数据本就不互通，云同步里如携带密文需确认加密 key 的派生
不依赖桌面机器指纹）。

### 2.4 配置与数据库路径

`utils/file.rs` / `dirs`：移动端没有 `$HOME/.config`。Tauri 2 移动端提供
`app.path().app_config_dir()` / `app_data_dir()`（iOS → NSDocumentDirectory，
Android → filesDir）。改造点：所有 `dirs::config_dir()` / `home_dir()` 调用改为
通过 `AppHandle` 获取的路径，或注入一个 `Paths` 状态：

```rust
pub struct Paths { pub config: PathBuf, pub data: PathBuf, pub cache: PathBuf }
// desktop: dirs 系 crate；mobile: app.path() API
```

`rusqlite` 的 db 文件路径同样切到 `app_data_dir`。

### 2.5 窗口相关

- `apply_window_effect`、splashscreen 窗口、`decorations/transparent`、
  `os_drop_paths.rs`（WebView2 拖拽）、WindowControls 相关命令：全部 `#[cfg(desktop)]`。
- 移动端入口为单 webview，`tauri.conf.json` 的 `app.windows` 数组在平台覆盖文件中
  置空，由 Tauri 移动端默认创建。
- `lib.rs` 顶部的 rustls CryptoProvider `install_default` 逻辑（ring）保留，
  移动端同样需要。

---

## 3. 前端改造

### 3.1 平台检测与代码分割

```ts
import { platform } from '@tauri-apps/plugin-os';   // 需新增 tauri-plugin-os
export const isMobile = platform() === 'ios' || platform() === 'android';
export const isDesktop = !isMobile;
```

新增 npm 依赖：`@tauri-apps/plugin-os`（Rust 侧对应 `tauri-plugin-os`，全平台可用）。
用 `isMobile` 在路由/布局层选择 `DesktopShell` / `MobileShell`，**不逐组件散改**。

### 3.2 移动端布局（新增 MobileShell）

- 去掉 `Topbar` / `WindowControls` / `SideMenu`（桌面形态），改为：
  - 顶部轻量 header：会话标题 + 连接状态（复用 `ConnectionProgress`）+ 菜单按钮。
  - 底部 Tab：会话 / 主机 / SFTP / 片段 / 设置，对应现有 pages 直接复用
    （`Hosts`、`Snippets`、`Settings`、`QuickConnect` 是表单页，基本可直接用，
    需检查长表单滚动）。
- `SplitView`（分屏）移动端降级：多会话以「会话抽屉 + 单活动终端」呈现。
- 触控目标 ≥ 44pt；radix-ui 的 hover/dropdown 交互改为 tap/sheet
  （`sheet.tsx` 已有，用它做移动端菜单）。

### 3.3 终端（重点）

- **渲染降级**：`@xterm/addon-webgl` 在移动 WebView 上稳定性差（iOS WKWebView
  WebGL 上下文丢失、Android 低端机性能差），移动端不加载 webgl addon，
  退回 canvas 渲染。
- **虚拟按键条**：终端视图上方加一行可滚动按键（Esc Tab Ctrl Alt ↑↓←→ | - ~ /），
  Ctrl 为粘滞键（点击一次修饰下一输入）。数据来源可直接复用 `Snippets` 思路，
  新组件 `MobileTermKeys`。
- **软键盘 viewport 问题**（移动 xterm 最大的坑）：
  - iOS 键盘弹出会触发 `visualViewport` resize 而 WKWebView 高度不变；
    监听 `window.visualViewport` 的 `resize/scroll`，把 xterm 容器做
    `transform: translateY` 补偿，并调用 `fitAddon.fit()`。
  - Android 上 `resize=adjustResize`（在 AndroidManifest 的 activity
    `android:windowSoftInputMode="adjustResize"`），普通 resize 即可。
  - 聚焦终端时禁用页面级滚动，避免 WKWebView 弹性滚动劫持。
  - xterm `allowProposedApi: true` + `scrollback` 适度下调（移动端内存）。

### 3.4 拖拽与交互替换

- `react-dnd` html5-backend 不响应触摸：移动端把 SFTP 上传/排序等拖拽交互
  改为长按菜单 / 点选（TouchBackend 可作为折中，但建议直接改成菜单交互，
  维护成本低）。
- 文件选择：`sftp_upload_local` 目前接收桌面路径；移动端改用
  `tauri-plugin-dialog` 的移动端实现（系统文件选择器返回内容 URI），
  Rust 侧上传函数需增加「从 ContentResolver 读流」路径（Android）——
  在 `sftp` 模块为移动端新增 `sftp_upload_uri` 命令，通过 Android 意图回调读取。
  iOS 的 dialog 插件返回真实文件路径，可直接复用现有上传逻辑。
- 剪贴板：`tauri-plugin-clipboard-manager` 移动端可用，无需改。

### 3.5 VNC / RDP 前端

- RDP：前端本就是 canvas 绘帧 + 指针/键盘事件回传，移动端直接可用；
  需增加触控 → 鼠标事件映射（tap=左键、长按=右键、双指=滚轮，
  可参考现有 `rdp` 前端输入事件封装加一层 adapter）。
- VNC：`@novnc/novnc` 基于 WebSocket，移动 WebView 支持；键盘输入
  在触屏上同样需要虚拟按键条。

---

## 4. 网络与生命周期（移动端核心难点）

### 4.1 连接保活与重连

iOS 切后台后 app 数秒内被挂起，socket 全断。设计：

1. **会话状态机**（前端 zustand store 扩展）：`connected → suspended → reconnecting → connected | dead`。
   监听 Tauri `tauri://blur` / `tauri://focus` 事件 + 后端 socket 错误。
2. **SSH/SFTP/Telnet**：后台回来检测断线 → 自动重连（复用 host 配置 +
   `ssh_connect`，密钥/密码已缓存于内存态），失败则提示。重连上限 + 指数退避。
3. **MOSH**：mosh-rs 走 UDP + SSP 状态同步，理论上回前台直接续传；
   需验证 iOS 挂起后 UDP 套接字存活情况，做与 SSH 相同的兜底重连。
4. **Android**：配置 `FOREGROUND_SERVICE` + 常驻通知（`dataSync` 类型），
   可在前台服务期间保持会话；需在 `gen/android` 的 manifest 与 Rust 侧
   （或用 tauri-plugin-foreground-service 社区插件）各加一段。

### 4.2 后台任务边界

- 不做「后台维持 SSH 会话数小时」的承诺（iOS 不现实），产品语义定位为
  「回前台快速恢复」。
- SFTP 大传输切后台即中断：移动端传输列表（`TransferCenter`）增加
  「后台暂停」状态，回前台可断点续传（现有 `sftp_upload_chunk` 分块协议
  已支持续传语义，需在 Rust 侧记录 offset）。

---

## 5. 构建与 CI

### 5.1 本地工具链

- Android：Android Studio / NDK r27+，`cargo-ndk`，JDK 17。
  Rust targets：`aarch64-linux-android`、`armv7-linux-androideabi`、`x86_64-linux-android`。
- iOS：Xcode 16+，`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`。

`ssh2` vendored openssl 在 Android 上需 `OPENSSL_DIR` 或让 openssl-sys 走
`cargo-ndk` 的自动探测；首次编译失败大概率是 NDK linker 问题，
统一用 `cargo ndk -t aarch64-linux-android build` 触发。

### 5.2 GitHub Actions（新增 .github/workflows/mobile.yml）

矩阵：`(android: ubuntu + java17 + android-sdk + rust android targets)` ×
`(ios: macos-14 + rust ios targets)`。关键步骤：

```yaml
# android
- run: cargo install cargo-ndk
- run: pnpm tauri android build --target aarch64 --apk
# 上传 apk 产物；签名走 secrets(keystore base64)
# ios
- run: pnpm tauri ios build --export-method ad-hoc
# 需 Apple 证书 + provisioning profile secrets
```

桌面现有 release.yml 不动，mobile.yml 独立演进。

---

## 6. 实施阶段

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| M1 工程化 | feature gate 全部桌面依赖、platforms 层、路径抽象；`cargo check` 双平台通过 | Android/iOS 空壳 app 跑起现有前端 |
| M2 Android 主链路 | SSH 连接 + xterm（canvas）+ 虚拟按键 + 软键盘处理 | Android 真机可用 SSH 终端 |
| M3 数据层 | secure-storage、SQLite 路径、hosts/keys/snippets 全可用 | 完整配置管理闭环 |
| M4 协议扩展 | MOSH（重点验证）、SFTP（含 URI 上传）、隧道、监控 | 功能对齐桌面（除 local/serial） |
| M5 图形协议 | RDP 触控映射、VNC | 远程桌面可用 |
| M6 iOS | 后台恢复、Keychain、签名上架 | TestFlight 可用 |
| M7 打磨 | 断线重连状态机、前台服务、发版 CI | 商店可发布 |

先 Android 后 iOS 的理由：WebView/文件/后台策略宽松、无签名墙，
能最快验证端到端协议链路。

---

## 7. 风险清单

1. **xterm.js + WKWebView 软键盘**：业界公认难题，M2 预留专项调试时间；
   兜底方案是自绘简易输入行（前置输入框 + 回显），体验降级但可控。
2. **ironrdp 在移动端编译**：crate 为 no_std 友好设计，大概率顺利，
   但 `ironrdp-client` 特性组合未在 iOS 上有官方验证，M1 期先 `cargo check` 确认。
3. **keyring 数据语义**：云同步若同步了桌面端 aes-gcm 密文，需确认派生 key
   不含机器绑定因子，否则移动端解不开。
4. **shadcn/radix 组件触屏可用性**：dropdown/hover 类组件需逐个过，
   统一在 MobileShell 用 sheet/底部菜单替代。
5. **包体积**：vendored openssl + ring + ironrdp，Android apk 预计 30-60MB，
   可接受；如超标再考虑 openssl 动态库或 rustls 统一 TLS 后端。
6. **Tauri 移动端插件覆盖度**：updater/process 等桌面插件在移动端为 no-op，
   需在代码中按 feature 而非运行时判断裁剪，避免静默失效。
