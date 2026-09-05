# Swallow RDP 实现技术文档

> 实现状态（2026-09-05）：MVP 已实现并提交——QuickConnect 连接入口、`rdp` 标签、
> IronRDP 协议端（Rust）、本地 WebSocket 帧/控制桥、canvas 渲染器。
> 剪贴板 / 音频 / 驱动器重定向 / RD Gateway 属后续阶段（见「未实现」一节）。

## 1. 架构

与 VNC（透明字节桥，协议在前端 noVNC）相反，RDP 的协议端完整在 Rust 侧：

```text
React <RdpView>                        Rust <rdp/session.rs>
  canvas 2D 渲染    ◄── 瓦片帧(Binary) ── IronRDP RdpClient（NLA/CredSSP + 位图解码）
  鼠标/键盘/IME     ── 输入 JSON(Text) ──►  ironrdp_input::Database → 协议栈
        ▲                                   │
        └── ws://127.0.0.1:<port>/rdp/<sid>?token=<random>（本地回环，随机 token 鉴权）
```

- 依赖：`ironrdp-client 0.1.0 (rustls)` + `ironrdp-input 0.7` + `ironrdp-pdu 0.9`。
  版本锁精确 minor（0.x 家族成批 breaking）。
- **rustls CryptoProvider**：依赖图同时启用 ring（reqwest 链）与 aws-lc-rs（ironrdp-tls
  链），rustls 0.23 无法自动二选一，首次 TLS 使用即 panic（实机连接时暴露）。已在
  `lib.rs run()` setup 中进程级显式安装 `ring` provider（`Cargo.toml` 显式声明 rustls
  依赖以启用 `rustls::crypto::ring`），对全应用 rustls 使用方生效。
- IronRDP 官方引擎 `RdpClient::run()` 的 future 因内部 connector 状态机 higher-ranked
  lifetime 无法通过 `tokio::spawn` 的 Send 检查（与官方 viewer 一致），改在**专用线程**
  上跑 current-thread runtime；与泵之间用 tokio mpsc 通信（runtime 无关）。
- 帧优化：`RdpOutputEvent::Image` 是全屏 RGBA（1080p ≈ 8MB/帧），直接转发 IPC/WebSocket
  不可行。`FrameEncoder` 对相邻帧做 **32px 瓦片差分**，只发变化瓦片；前端 rAF 合帧
  （一次消息流只 `putImageData` 一次，取脏矩形并集）。

## 2. WebSocket 协议（自定义，仅本地回环）

下行（Rust → 前端）：
- Binary 帧：`[52 44 46][ver=1][kind=1] width:u16le height:u16le tile:u8 count:u32le`
  + 每瓦片 `tx:u16 ty:u16 tw:u16 th:u16` + RGBA 数据。全零 prev 比较保证首帧全发。
- Text(JSON 控制事件)：`{type:"pointer", shape:"default"|"hidden"|"bitmap", ...}`
  （bitmap 携带 base64 RGBA + hotspot，前端转 CSS cursor）、
  `{type:"error", message}`（连接失败）、`{type:"closed", message?}`（会话结束，
  message 非 None = 异常终止）。

上行（前端 → Rust，Text(JSON)）：
- `{type:"input", op:{kind:"mouseMove"|"mouseButton"|"wheel"|"key"|"text", ...}}`
- `{type:"resize", width, height}` → `RdpInputEvent::Resize`（服务器不支持时 IronRDP
  自动走断开重连，同代内完成）。

## 3. 键盘与 IME

- `KeyboardEvent.code`（物理位置）→ RDP set-1 scancode 映射表（`scancode_for`，含
  0xE0 扩展键）。物理位置语义与本地/远端键盘布局无关，非 US 布局天然正确。
- 无映射的单字符（符号等）→ Unicode 键事件兜底；二者互斥防重复输入。
- IME 组合：keydown 期间 `compositionstart` 置位抑制所有按键转发（防 key="Process"
  误发 scancode）；`compositionend` 将组合文本按字符发 `text` op → Unicode 按下/抬起对。
- 浏览器快捷键放行清单：F5/F11/F12；其余按键一律 preventDefault 后转发远程。

## 4. 生命周期与安全红线

- `rdp_connect` 校验参数 → `ConfigBuilder` 构建（纯内存）→ 绑定 `127.0.0.1:0` →
  `RdpManager.start`（代际守门同 VNC：旧代乱序拒绝、stop_generation 按代停）。
- 会话任务：等 WS 客户端（120s 窗口自清）→ 泵 → 结束后发 `Close` 优雅断开
  （等 Terminated 至多 3s，超时放弃等待），随后注册表自查自删（token 比对防误删）。
- 密码仅内存持有：不进 URL（URL 只含随机 token）、不落日志、`sessions.json` 落盘前
  剥除（App.tsx）；恢复的会话缺密码 → `skipAutoConnect` → RdpView 弹密码框补交。
- 桥只监听 loopback；连接失败/关标签/应用退出（ExitRequested `stop_all`）均释放资源。

## 5. 性能与输入行为备注（2026-09-06 实测反馈后优化）

- **帧管线**：IronRDP 每次图形更新产出全屏 8MB 快照；泵线程对 output 通道做
  「批量排空、只编码最新帧」（中间帧必被覆盖），FrameEncoder 直接在 u32 上
  diff（等价 4 字节 memcmp），只为脏瓦片行做 RGBA 转换——打字/滚屏突发从
  N 次全屏搬运降为 1 次。
- **修饰键防卡死**：隐形输入框失焦/窗口失焦时自动释放 Ctrl/Shift/Alt/Meta
  （keyup 因焦点迁移丢失会导致远端修饰键永远按住，点击全部变 Ctrl+点）。
- **按键全量转发**：F5/F11/F12 不再本地放行（F5 会刷新整个应用断开连接）；
  标签快捷键经 vncKeyboard 独占标记让路（与 VNC 同机制）。
- **指针捕获**：pointerdown 时 setPointerCapture，拖拽出画布不丢 pointerup；
  滚轮用原生非 passive 监听（React onWheel 是 passive，preventDefault 无效）。
- 背景层复用 TerminalBackdrop（主题底色/背景图），连接中不再透白。

## 6. 已知限制 / 未实现（按优先级）

1. **证书校验**：MVP 沿用 IronRDP 默认 TLS 行为（RDP 服务器普遍自签名证书）。
   后续应做指纹确认入库（复用 known_hosts 表模式）。
2. 剪贴板同步（`ironrdp-cliprdr`）、音频（`rdpsnd`）、驱动器重定向（`rdpdr`）未启用
   （未开启对应 cargo feature）。
3. 指针位图超大时不设自定义光标（>128×128 保护上限，回落 default）。
4. RD Gateway（`ironrdp-mstsgu`，尚在 0.0.x）未接入；VNC 的 SSH 隧道模式对 RDP
   同样适用（RDP 目标端口 3389 走 local forward 即可，UI 入口未做）。
5. 真机验证清单（需一台可用的 RDP 主机）：连接/认证失败提示、键鼠、IME 中文输入、
   Ctrl-Alt-Del、滚轮、fit/original 切换、分辨率随窗口变化、远端主动断开、关标签
   资源释放、应用重启恢复（缺密码跳过自动连接）。
