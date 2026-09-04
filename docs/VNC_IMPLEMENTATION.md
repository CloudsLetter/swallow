# Swallow VNC 实现技术文档

> 本文档用于交给编码 AI 执行实现。目标是在当前 Tauri 2 + React + Rust 项目中增加基础 VNC 远程桌面能力。
>
> 文档版本：v1.0  
> 适用项目：`swallow`  
> 当前技术栈：React 19、TypeScript、Vite、Tauri 2、Rust、Tokio、`ssh2`

> **实现状态更新（2026-09-05）**：本文档规划的全部能力（直连 + SSH 隧道、token 鉴权桥、前端 noVNC 标签、CSP、资源释放）均已按设计实现并提交，相关提交见 git log（`feat(vnc): …` 系列）。落地时的补充与差异：
> - 会话恢复采用 `sessions.json`（App.tsx 持久化剥除 VNC 密码与嵌套 SSH 密码/口令）；「收藏/入库」属文档规划的第二期，暂未做。
> - 追加「连接代际（generation）」机制：修复 dev StrictMode 双挂载 / 快速重连下旧 RFB 断开事件误报「已断开」——后端同 sessionId 只允许新代覆盖旧代、`vnc_disconnect` 可按代停；前端 VncView 事件与流程一律校验代际。
> - 追加 Serial（串口）终端协议（serialport 4，独立于本文档）；Hosts 页提供「VNC 连接」弹窗（主机 more 菜单）与「串口终端」跳转（页头工具栏 → QuickConnect 定位高亮）。

## 1. 实现目标

增加一个 VNC 会话标签页，使用户可以：

1. 输入 VNC 主机地址和端口，例如 `192.168.1.20:5900`。
2. 输入 VNC 密码。
3. 在应用内看到远程桌面。
4. 使用鼠标、键盘和剪贴板与远程桌面交互。
5. 支持缩放、适应窗口、只读模式和发送 Ctrl-Alt-Del 等常用操作。
6. 关闭标签页时，可靠释放 WebSocket、TCP 和 SSH 资源。
7. 后续可以通过 SSH 跳板机访问 VNC 服务。

## 2. 明确的架构决策

### 2.1 前端使用 noVNC

使用官方包：

```bash
pnpm add @novnc/novnc
pnpm add -D @types/novnc__novnc
```

当前推荐版本为 `@novnc/novnc@1.7.x`。noVNC 的核心 API 是 `RFB` 类，负责：

- RFB 协议握手
- VNC 认证交互
- Raw、Tight、ZRLE 等常见编码解码
- Canvas/framebuffer 渲染
- 鼠标、键盘和触摸事件
- 剪贴板
- 视口缩放和裁剪
- Ctrl-Alt-Del

前端示例：

```ts
const rfb = new RFB(containerElement, wsUrl, {
  credentials: password ? { password } : undefined,
  shared: true,
});

rfb.scaleViewport = true;
rfb.clipViewport = true;
rfb.viewOnly = false;
```

官方 API：

- https://github.com/novnc/noVNC/blob/master/docs/API.md
- https://github.com/novnc/noVNC#server-requirements

### 2.2 Rust 不实现 RFB 解码

普通 VNC 服务是原始 TCP 服务，而浏览器只能连接 WebSocket。因此 Rust 侧实现一个本地：

```text
WebSocket <-> TCP bridge
```

数据流如下：

```text
React/noVNC
    │ ws://127.0.0.1:<random-port>/vnc/<token>
    ▼
Rust WebSocket listener
    │ 原始 TCP 字节流
    ▼
VNC Server:5900
```

Rust 不解析 RFB，也不处理 framebuffer。Rust 只做以下转换：

- WebSocket Binary message payload -> TCP bytes
- TCP bytes -> WebSocket Binary message
- WebSocket Close/Ping/Pong -> TCP/连接生命周期处理

RFB 数据可以被视为不透明二进制流。认证、画面解码、鼠标和键盘都由 noVNC 完成。

### 2.3 Rust 依赖

在 `src-tauri/Cargo.toml` 增加：

```toml
tokio-tungstenite = "0.30"
```

项目已有：

- `tokio`
- `ssh2`
- `rand`
- `anyhow`
- `thiserror`

第一版不要引入 `vnc-rs` 或 `libvnc`。只有在以后需要 Rust 侧截图、录制、解析 RFB 或隐藏前端凭据时，才考虑 RFB 客户端库。

## 3. 当前仓库需要重点复用的代码

实现前先阅读以下文件，不要重复实现已有能力：

```text
src-tauri/Cargo.toml
src-tauri/src/lib.rs
src-tauri/src/session_events.rs
src-tauri/src/ssh/session.rs
src-tauri/src/ssh/tunnel.rs
src/types/session.ts
src/services/sessionService.ts
src/store/tabStore.ts
src/pages/Home.tsx
src/components/TabBar.tsx
src/components/Topbar.tsx
src/pages/QuickConnect.tsx
src/pages/Hosts.tsx
src/App.tsx
src-tauri/tauri.conf.json
```

当前代码特点：

- Tauri command 统一注册在 `src-tauri/src/lib.rs`。
- 前端通过 `@tauri-apps/api/core` 的 `invoke()` 调用 Rust。
- 终端会话使用 `session-${sessionId}` 事件通道。
- SSH 使用 `ssh2`，且已经实现主机密钥确认和 ProxyJump。
- `src-tauri/src/ssh/session.rs` 使用本地 loopback socket 桥接 SSH `direct-tcpip`，因为 `ssh2::Session` 不能直接绑定 SSH channel 到异步 TCP 流。
- `src-tauri/src/ssh/tunnel.rs` 已经有 TCP 双向转发实现，但它面向持久化端口转发规则，不要直接把 VNC 强耦合到用户配置的端口转发规则上。
- `session_events.rs` 当前的 `Output` 是字符串事件，不要通过它传输视频或 framebuffer 数据。

## 4. Rust 后端设计

### 4.1 新增模块

建议新增：

```text
src-tauri/src/vnc/mod.rs
src-tauri/src/vnc/bridge.rs
src-tauri/src/vnc/manager.rs
```

也可以合并成一个文件，但必须保持连接管理和 WebSocket 转发逻辑分离。

在 `src-tauri/src/lib.rs` 顶部增加：

```rust
mod vnc;
```

### 4.2 Rust 数据结构

建议定义如下请求结构。字段名称要使用 `camelCase` 与前端对齐：

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub shared: Option<bool>,
    pub ssh: Option<SshTransportConfig>,
}
```

第一版可以暂时不使用 `password` 和 `shared` 字段，因为透明 bridge 不需要知道 VNC 密码；但为了后续兼容，接口可以保留。密码不允许写入 URL、日志或持久化会话文件。

SSH 传输配置建议单独建模，不要把 VNC 配置伪装成 SSH 终端配置：

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTransportConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_username: String,
    pub ssh_auth_type: String,
    pub ssh_password: Option<String>,
    pub ssh_key_id: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_passphrase: Option<String>,
    pub target_host: String,
    pub target_port: u16,
}
```

返回结构：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_url: String,
}
```

如果 SSH 主机密钥需要确认，返回结构应复用当前 `ConnectResult` 的思路：

```text
status = "needsHostKeyApproval"
fingerprint
host
port
hostKeyToken
```

不要把私钥、证书内容或完整 SSH 配置通过错误消息返回给前端。

### 4.3 VNC 会话管理器

`VncManager` 至少需要保存：

```rust
pub struct VncSession {
    pub session_id: String,
    pub ws_url: String,
    pub token: String,
    pub stop: Arc<AtomicBool>,
    pub listener_task: JoinHandle<()>,
    // 可选：SSH 隧道守护对象，必须与 VNC 会话同生命周期
}
```

管理器需要提供：

```text
start(session_id, config) -> VncConnectResult
stop(session_id) -> Result<()>
stop_all()
contains(session_id)
```

`AppState` 增加：

```rust
vnc: Mutex<VncManager>,
```

不要用全局裸 `HashMap` 保存连接。所有会话必须挂在 `AppState` 下，并在应用退出时统一停止。

### 4.4 本地 WebSocket listener

连接启动时：

1. 校验 `session_id` 非空。
2. 校验目标 host 非空。
3. 校验端口范围。
4. 只绑定 `127.0.0.1:0`，禁止绑定 `0.0.0.0`。
5. 获取系统分配的随机端口。
6. 生成不可预测的一次性 token。
7. 返回类似下面的 URL：

```text
ws://127.0.0.1:49152/vnc/session-abc?token=<random-token>
```

8. 在后台任务中接受 WebSocket 连接。

WebSocket 握手必须校验：

- HTTP path 中的 session id
- query/header 中的 token
- session id 与 token 的对应关系

不要允许前端通过 URL 任意指定 TCP 目标。TCP 目标只能来自 Rust 创建会话时保存的配置。

推荐使用：

```rust
tokio_tungstenite::accept_hdr_async
```

通过自定义 handshake callback 校验 path 和 token。只允许一个活跃 WebSocket；新连接到来时可以关闭旧连接，或者拒绝新连接。重连场景应允许旧连接结束后重新连接同一个 session。

### 4.5 WebSocket <-> TCP 双向转发

桥接逻辑需要使用 `futures_util::{SinkExt, StreamExt}` 或 Tokio 等价 API。

伪代码：

```rust
let ws_stream = accept_websocket(...).await?;
let tcp_stream = TcpStream::connect(target).await?;

let (mut ws_tx, mut ws_rx) = ws_stream.split();
let (mut tcp_rx, mut tcp_tx) = tcp_stream.into_split();

let ws_to_tcp = async {
    while let Some(message) = ws_rx.next().await {
        match message? {
            Message::Binary(bytes) => tcp_tx.write_all(&bytes).await?,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(_) => return Err("VNC bridge only accepts binary data"),
            _ => {}
        }
    }
    Ok::<(), Error>(())
};

let tcp_to_ws = async {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = tcp_rx.read(&mut buffer).await?;
        if n == 0 { break; }
        ws_tx.send(Message::Binary(buffer[..n].to_vec().into())).await?;
    }
    Ok::<(), Error>(())
};

tokio::select! {
    result = ws_to_tcp => result?,
    result = tcp_to_ws => result?,
}
```

实际代码需要注意：

- 处理 `Message::Close`。
- TCP EOF 后向 WebSocket 发送 close 或让连接自然关闭。
- WebSocket 错误、TCP 错误都要结束另一侧。
- 不要建立无界 channel，避免远程桌面高负载时内存增长。
- 设置合理连接超时和空闲超时。
- 设置 `TCP_NODELAY`，降低鼠标键盘小包延迟。
- 不要把每个数据包写入普通日志。
- 转发过程中不要调用任何 RFB 解码器。

### 4.6 直连 VNC

直连路径：

```text
TcpStream::connect((host, port))
```

建议：

- 连接建立超时使用 10~30 秒，并复用项目的 SSH 连接超时配置或设置独立 VNC 默认值。
- DNS 解析和连接失败返回可读错误。
- 连接成功后只把 TCP 流交给 bridge。

### 4.7 SSH 隧道路径

SSH 隧道不是第一版的 RFB 实现，而是 VNC TCP 的传输方式。

目标结构：

```text
noVNC WebSocket
    ↓
Rust WebSocket bridge
    ↓
本地 loopback TCP
    ↓
ssh2 direct-tcpip channel
    ↓
远程 VNC host:port
```

当前 `ssh/session.rs` 已有类似的 loopback 对桥接实现。建议将通用的“SSH direct-tcpip channel <-> local TCP socket”抽取成 `pub(crate)` 辅助函数，而不是复制一份线程桥接代码。

SSH 连接必须复用现有能力：

- 主机密钥校验
- 主机密钥首次确认 token
- password/key/certificate 认证
- ProxyJump/链式跳板
- 连接超时
- 断开时释放跳板机会话

注意：`ssh2` 大量 API 是阻塞式 API，不能直接在 Tokio 异步任务中长时间调用。SSH 认证和 channel 建立应放进 `spawn_blocking`，现有 SSH 会话逻辑保持原有线程模型。

VNC session 必须持有 SSH 隧道的 guard/transport 对象，否则 Rust 变量析构后，跳板机连接会提前断开。

## 5. Tauri command 接口

在 `src-tauri/src/lib.rs` 增加：

```rust
#[tauri::command]
async fn vnc_connect(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: VncConnectRequest,
) -> Result<VncConnectResult, String>;

#[tauri::command]
async fn vnc_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String>;

#[tauri::command]
async fn vnc_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String>;
```

然后在 `tauri::generate_handler![]` 中注册：

```rust
vnc_connect,
vnc_disconnect,
vnc_list_sessions,
```

Command 约定：

- `vnc_connect` 重复使用同一个 session id 时，先停止旧会话，避免端口和任务泄漏。
- `vnc_disconnect` 幂等；会话不存在时可以返回成功。
- 所有内部错误转换为不包含密码、私钥和完整配置的用户可读错误。
- 连接失败必须关闭 listener、TCP 和 SSH 资源。

## 6. 前端类型和服务层

### 6.1 `src/services/sessionService.ts`

增加：

```ts
export interface VncSessionConfig {
  host: string;
  port: number;
  password?: string;
  shared?: boolean;
  ssh?: VncSshTransportConfig;
}

export interface VncConnectResult {
  sessionId: string;
  wsUrl: string;
}

export function vncConnect(
  sessionId: string,
  config: VncSessionConfig,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>('vnc_connect', {
    request: { sessionId, ...config },
  });
}

export function vncDisconnect(sessionId: string): Promise<void> {
  return invoke<void>('vnc_disconnect', { sessionId });
}
```

参数命名要与 Rust 的 `serde(rename_all = "camelCase")` 保持一致。

### 6.2 `src/types/session.ts`

如果该文件用于共享事件类型，可以增加 VNC 状态类型，但不要把图像数据放进去：

```ts
export type VncStatus =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';
```

## 7. React VNC 组件

新增：

```text
src/components/VncView.tsx
src/components/vncPool.ts（可选）
```

### 7.1 `VncView` 生命周期

组件需要做到：

1. `containerRef` 指向一个空的 `<div>`。
2. 组件挂载后调用 `vncConnect`。
3. 收到 `wsUrl` 后创建 `new RFB(container, wsUrl, options)`。
4. 监听 `connect`、`disconnect`、`credentialsrequired`、`securityfailure`、`desktopname`、`clipboard`。
5. 组件卸载时先调用 `rfb.disconnect()`，再调用 `vncDisconnect(sessionId)`。
6. 使用 `cancelled` 标志避免异步连接完成后向已卸载组件写入状态。
7. `RFB` 实例只能保存在 `useRef`，不要放入 React state。

核心伪代码：

```tsx
const containerRef = useRef<HTMLDivElement>(null);
const rfbRef = useRef<RFB | null>(null);

useEffect(() => {
  let cancelled = false;

  async function connect() {
    if (!containerRef.current) return;
    const result = await vncConnect(sessionId, config);
    if (cancelled) return;

    const rfb = new RFB(containerRef.current, result.wsUrl, {
      credentials: config.password
        ? { password: config.password }
        : undefined,
      shared: config.shared ?? true,
    });

    rfb.scaleViewport = true;
    rfb.clipViewport = true;
    rfb.viewOnly = false;
    rfbRef.current = rfb;
  }

  void connect().catch(setError);

  return () => {
    cancelled = true;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    void vncDisconnect(sessionId).catch(() => {});
  };
}, [sessionId]);
```

实际实现不能把 `config` 中频繁变化的对象直接作为 effect 依赖，否则会重复建立连接。连接配置应在连接开始时固定，配置变化通过显式“重连”处理。

### 7.2 认证处理

如果没有预先提供密码，noVNC 可能触发：

```text
credentialsrequired
```

此时弹出密码输入框，调用：

```ts
rfb.sendCredentials({ password });
```

密码要求：

- 不放进 WebSocket URL。
- 不打印日志。
- 不写入 `sessions.json`。
- 关闭标签页后从内存引用中释放。
- 恢复会话时，如果需要密码但没有密码，应跳过自动连接，行为与现有 SSH/SFTP 会话一致。

### 7.3 工具栏

VNC 视图至少提供：

- 适应窗口：`scaleViewport = true`
- 原始尺寸/滚动：`scaleViewport = false`、`clipViewport = false`
- 只读模式：`viewOnly`
- 发送 Ctrl-Alt-Del：`sendCtrlAltDel()`
- 复制远程剪贴板到本地
- 将本地文本粘贴到远程：`clipboardPasteFrom(text)`
- 断开/重连

第一版不要开启 `resizeSession`，除非明确希望改变远端桌面分辨率。默认只在本地进行缩放，避免改变远端桌面布局。

## 8. Tab 集成

### 8.1 `src/store/tabStore.ts`

扩展：

```ts
export type TabType =
  | 'home'
  | 'terminal'
  | 'telnet'
  | 'local'
  | 'sftp'
  | 'vnc'
  | 'replay'
  | 'quick-connect'
  | 'split';

export interface VncTabConfig {
  host: string;
  port: number;
  password?: string;
  shared?: boolean;
  ssh?: VncSshTransportConfig;
}
```

在 `Tab` 增加：

```ts
vncConfig?: VncTabConfig;
```

`createTab()` 的入参也增加 `vncConfig`。

### 8.2 关闭和恢复

在 `disposeSession()` 中增加 `vnc` 分支：

```ts
void vncDisconnect(sessionId).catch(() => {});
```

VNC 不使用 `terminalPool`，不要调用 `disposeTerminal()`。

当前分屏模型的 `SplitPane.type` 只支持 `terminal | sftp`。第一版不要强行把 VNC 放进分屏；VNC 先作为独立标签。若以后需要分屏，再单独扩展 `SplitPane` 和 `SplitView`。

### 8.3 `src/pages/Home.tsx`

新增分支：

```tsx
{tab.type === 'vnc' ? (
  <VncView
    sessionId={tab.sessionId || undefined}
    vncConfig={tab.vncConfig}
    isActive={isActive}
  />
) : ...}
```

保持当前 keep-alive 行为：切换标签时隐藏 VNC DOM，但不要卸载组件，否则会导致 WebSocket 断开。

### 8.4 `TabBar`、`Topbar` 和类型分支

搜索所有 `TabType`、`tab.type` 和终端类型判断，至少检查：

```text
src/components/TabBar.tsx
src/components/Topbar.tsx
src/pages/Home.tsx
src/App.tsx
src/pages/QuickConnect.tsx
src/pages/Hosts.tsx
```

新增 VNC 图标、标题和连接状态。不要把 VNC 误判为 terminal，否则会触发 xterm、终端背景或终端快捷键逻辑。

## 9. 快速连接入口

第一版建议在 `src/pages/QuickConnect.tsx` 增加单独的 VNC 区块：

字段：

- 主机
- 端口，默认 `5900`
- VNC 密码，可选
- 只读模式，可选
- SSH 隧道开关，可选

点击连接时：

```ts
createTab({
  type: 'vnc',
  name: `vnc:${host}:${port}`,
  vncConfig: { host, port, password, shared: true },
});
```

第一版不要求修改现有 SSH Host 数据库结构。VNC 主机持久化和 Hosts 页面集成作为第二阶段，避免把 SSH 专用的 `Host` 数据模型强行复用为 VNC 模型。

## 10. Tauri CSP 配置

当前生产 CSP 的 `connect-src` 只允许 IPC 和 `http://ipc.localhost`，需要在 `src-tauri/tauri.conf.json` 中增加 loopback WebSocket：

```text
connect-src ipc: http://ipc.localhost ws://127.0.0.1:*
```

开发 CSP 也应允许：

```text
ws://127.0.0.1:* ws://localhost:*
```

只允许 loopback，不要为了方便加入 `ws://*` 或 `wss://*`。

如果目标平台的 WebView 对 CSP wildcard 行为不同，优先统一 Rust 返回的 URL 为 `ws://127.0.0.1:<port>`，并使用明确的端口通配规则，不要改成暴露局域网地址。

## 11. 安全要求

必须满足：

1. Rust bridge 只监听 `127.0.0.1`。
2. 每个会话使用随机 token。
3. token 只允许对应的 session 使用。
4. URL 不携带 VNC 密码。
5. URL 不携带任意远端 TCP 目标。
6. WebSocket 只接受 Binary message，拒绝 Text message。
7. 不把密码、私钥、passphrase、token 写入日志。
8. 关闭标签页、连接失败、应用退出时都要释放资源。
9. 对 session id、host、port 做输入校验。
10. 不允许 bridge 演变成任意 TCP 代理。
11. 不监听 `0.0.0.0`、局域网 IP 或公网 IP。
12. Rust 错误返回时清理连接，不允许后台任务泄漏。

VNC 原生密码认证在很多实现中属于传统弱认证，传输安全应优先依赖 SSH 隧道、VPN 或 VNC 自身的 TLS/VeNCrypt。透明 bridge 会把认证能力交给 noVNC；noVNC 不支持的安全类型，bridge 无法补充。

## 12. 连接状态和错误处理

状态至少分为：

```text
idle
starting
waitingForHostKey
connecting
connected
disconnected
error
```

状态来源：

- Rust command 返回错误：启动阶段失败。
- noVNC `connect`：RFB 握手和认证完成。
- noVNC `disconnect`：连接断开，读取 `detail.clean`。
- noVNC `credentialsrequired`：需要密码。
- noVNC `securityfailure`：认证/安全协商失败。
- noVNC `desktopname`：更新标签或状态信息。

不要把高频 TCP 数据转成 Tauri event。状态事件可以走 Tauri event，但 framebuffer 数据必须留在 WebSocket 内部。

## 13. 测试计划

### 13.1 Rust 单元测试

至少覆盖：

- 空 host 拒绝。
- 非法端口拒绝。
- bridge 只绑定 loopback。
- 错误 token 无法完成 WebSocket 握手。
- 错误 session id 无法完成 WebSocket 握手。
- Text WebSocket message 被拒绝。
- Binary 数据可以双向转发。
- TCP EOF 会关闭 WebSocket。
- WebSocket 关闭会结束 TCP。
- stop 后 listener 和后台任务退出。
- 重复 session id 不会产生两个长期后台任务。

可以用 Tokio 的 `TcpListener` 和内存/本地测试 WebSocket server 构建 echo fixture，不需要真实 VNC 服务即可测试 bridge。

### 13.2 React 测试

至少覆盖：

- `VncView` 挂载后调用 `vncConnect`。
- 收到 URL 后创建 `RFB`。
- 卸载时调用 `disconnect` 和 `vncDisconnect`。
- 异步连接完成前卸载不会更新已卸载组件。
- 缺少密码时可以处理 `credentialsrequired`。
- 连接失败显示错误而不是白屏。
- 标签切换不会销毁 VNC 组件。
- 关闭 VNC 标签不会调用 terminalPool。

### 13.3 手工验收

准备至少一种真实 VNC 服务，例如 QEMU、TigerVNC、x11vnc、RealVNC 或 TightVNC，验证：

1. 连接无密码 VNC。
2. 连接 VNC 密码认证。
3. 鼠标点击、拖动和滚轮。
4. 普通键盘输入和 Ctrl/Alt/Shift 组合键。
5. Ctrl-Alt-Del。
6. 剪贴板双向同步。
7. 缩放和窗口调整。
8. 远端主动断开。
9. 前端关闭标签页。
10. 应用退出。
11. 通过 SSH 跳板机连接。
12. VNC 服务连接失败时不会残留端口和任务。

## 14. 实现顺序

编码 AI 必须按以下顺序执行，每一步都进行编译或测试：

### 阶段 A：纯直连 bridge

1. 增加 `@novnc/novnc` 和 Rust `tokio-tungstenite`。
2. 新增 `vnc` Rust 模块和 `VncManager`。
3. 实现 loopback WebSocket listener。
4. 实现 TCP/WebSocket 双向转发。
5. 增加 `vnc_connect`、`vnc_disconnect`、`vnc_list_sessions`。
6. 增加 TypeScript service。
7. 用测试 WebSocket/TCP echo fixture 验证 bridge。

### 阶段 B：React VNC 标签

1. 增加 `VncTabConfig` 和 `TabType = 'vnc'`。
2. 新增 `VncView`。
3. 在 `Home` 中渲染 VNC 标签。
4. 在 tab close/dispose/restore/persist 路径中补充 VNC 分支。
5. 增加连接状态、错误、重连和工具栏。
6. 修改 CSP。

### 阶段 C：快速连接和体验

1. 增加 Quick Connect VNC 表单。
2. 增加 i18n 文案。
3. 增加 TabBar 图标和标题。
4. 增加只读、缩放、Ctrl-Alt-Del、剪贴板功能。

### 阶段 D：SSH 隧道

1. 抽取现有 SSH direct-tcpip 到 loopback 的通用桥接函数。
2. 增加 VNC SSH transport 配置。
3. 复用主机密钥确认流程。
4. 验证 ProxyJump 和链式跳板。
5. 确保 VNC 关闭时 SSH channel、跳板会话和 bridge 一起退出。

## 15. 明确禁止的实现方式

不要：

- 在 React 中直接连接 `tcp://host:5900`，浏览器不支持原始 TCP。
- 在 Rust 中通过 Tauri event 高频发送 framebuffer。
- 为了显示画面自己重新实现 RFB 解码。
- 把 VNC TCP 端口直接暴露给 WebView 以外的网络。
- 把 token 或密码放在普通日志里。
- 直接复用持久化端口转发规则来承载所有 VNC 会话。
- 使用 `react-vnc` 替代 noVNC 核心 API，导致无法访问认证、剪贴板、缩放和错误事件。
- 把 VNC 当作 terminal，复用 xterm、terminalPool 或终端 PTY。
- 为了实现 VNC 引入 GPL 的 LibVNCClient，除非明确完成许可证和安全审查。

## 16. 完成标准

实现完成必须同时满足：

- `pnpm build` 通过。
- Rust `cargo check` 通过。
- Rust bridge 单元测试通过。
- React 组件生命周期测试通过。
- 至少连接一个真实 VNC 服务成功。
- 普通鼠标和键盘操作正常。
- 关闭标签页后无后台 listener、TCP 和 SSH 资源泄漏。
- 生产 CSP 和开发 CSP 都允许 loopback WebSocket。
- 没有新增敏感信息日志。
- 没有修改无关的 SSH、SFTP、Telnet 行为。

最终实现的最小功能边界是：

```text
React: @novnc/novnc
Rust: tokio-tungstenite + TCP/WebSocket bridge
可选: 现有 ssh2 + direct-tcpip loopback bridge
```

不要在第一版引入 Rust RFB 解码器。noVNC 已经是 RFB 客户端，Rust 的职责是安全地提供一个受会话管理保护的本地 WebSocket 到 VNC TCP 通道。
