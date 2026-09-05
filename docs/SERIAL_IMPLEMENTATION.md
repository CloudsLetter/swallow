# Swallow 串口终端实现技术文档

> 实现状态（2026-09-06）：串口终端 + 本轮收尾能力（字符集、XON/XOFF 流控、
> mark/space 软件模拟）均已实现。
> 参考接入路径：docs/SESSION_PROTOCOL_GUIDE.md（serial 为「阻塞读 + 参数校验」示例）。

## 1. 能力与参数

- 端口：`serial_list_ports` 枚举（Windows `COM*` / POSIX `/dev/tty*`），
  `serial_connect` 打开（占用/不存在即报错，无重试）。
- 基础参数：波特率（9600–921600）、数据位 5/6/7/8、停止位 1/2、
  校验 none/odd/even/**mark/space**、流控 none/hardware/**software (XON/XOFF)**。
- **字符集**（`charset`，默认 utf-8）：设备端编码。读方向流式解码为 UTF-8 发前端
  （多字节跨读边界由 `encoding_rs::Decoder` 内部缓冲）；写方向把前端 UTF-8 输入
  编码回设备端编码。可选清单按语区分组（16 个）：
  通用 UTF-8；中文 GB18030（兼容 GBK/GB2312）/ Big5；
  日韩 Shift-JIS / EUC-JP / EUC-KR；西里尔 Windows-1251 / KOI8-R；
  欧洲 Windows-1252（兼容 Latin-1）/ 1250 / 1253 / 1254 / 1257；
  中东 Windows-1255 / 1256；泰文 TIS-620。
  注意：encoding_rs 的 `latin1`/`us-ascii`/`iso-8859-1` 标签实测映射到
  windows-1252，**没有独立的 7 位 ASCII 解码器**（有测试钉死该映射）。

## 2. Mark/Space 校验的软件模拟（`MsbMode`）

serialport crate 的 `Parity` 只有 None/Odd/Even（POSIX termios 亦无原生
mark/space）。利用「7 数据位 + 恒定校验位」帧 ≡「8 数据位、最高位恒定」的
位流等效性做软件模拟：

- 底层照常开 **8N1**；
- 发方向：每字节 MSB 置 1（mark）/清 0（space）；
- 收方向：剥掉 MSB 再按字符集解码；
- 限制：仅支持 7 数据位帧（8 数据位 + mark/space = 9-bit 帧，标准 UART无法表达），
  数据位 ≠7 时连接报可读错误；UI 选 mark/space 时数据位自动切 7。

## 3. 集成点

- 后端：`serial/{mod,session,manager}.rs`；命令 `serial_connect/write/resize/
  disconnect/list_ports/list_sessions`；`normalized_params`（参数校验，单测覆盖）、
  `resolve_charset`（标签解析，单测固化 latin1/us-ascii 映射）、`MsbMode::apply_msb`
  /`strip_msb`（纯函数，单测覆盖）。
- 前端：`sessionService.serial*`；TerminalView `serialConfig`（走 terminalPool，
  `setSessionType('serial')`）；`SerialTabConfig`（无凭据，sessions.json 可直接
  持久化恢复，重启自动重连）；入口 QuickConnect 串口卡（Hosts 页工具栏快捷跳转）。
