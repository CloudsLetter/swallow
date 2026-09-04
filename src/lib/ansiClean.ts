/**
 * 终端输出清洗：把 xterm 收到的原始 VT 数据转成可读纯文本。
 *
 * 用途：会话日志记录（把 SSH/Telnet/本地终端会话落盘成 .log）。
 * xterm.write 收到的是含 ANSI 转义（颜色/光标/OSC 标题等）的原始流，
 * 直接落盘会满屏 \x1b[31m 之类的垃圾。此模块剥掉控制序列、保留可读文本。
 *
 * 设计取舍：
 * - 光标移动序列（CSI A/B/C/D、光标定位）剥掉但不做「回退删除」——
 *   因为流式记录无法可靠重放终端状态（谁覆盖了谁），
 *   简单按「所见字符依次追加」处理，贴近 Xshell 等客户端的纯文本日志。
 * - \r 保留原样（进度条刷新场景 \r 后跟 \r 覆盖，文件里是连续行），
 *   \n 保留原样；\r\n 会被文本查看器正常识别。
 * - 退格 \b 不做字符级回退（同样因流式不可靠），仅剥除。
 */

/** 判断字符码是否是 CSI/OSC 的中间字节（0x20–0x2F）或参数字节（0x30–0x3F）。 */
function isControlParamOrIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

/** 判断字符码是否是 CSI/OSC 的终结字节（0x40–0x7E）。 */
function isControlFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * 清洗一段终端原始输出为可读文本。
 * 状态机处理：CSI（ESC [ ... 终结）、OSC（ESC ] ... BEL/ST）、
 * 单字符 ESC 序列（ESC 后跟终结字节）与 C0 控制字符。
 * @param data 原始 VT 数据（UTF-8 解码后的字符串）
 */
export function cleanTerminalText(data: string): string {
  if (!data) return '';
  let out = '';
  let i = 0;
  const n = data.length;
  while (i < n) {
    const code = data.charCodeAt(i);
    if (code === 0x1b) {
      // ESC 序列开始
      const next = data.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: ESC [ ... 终结字节（0x40–0x7E）
        i += 2;
        while (i < n && !isControlFinal(data.charCodeAt(i))) i++;
        i++; // 跳过终结字节
      } else if (next === 0x5d) {
        // OSC: ESC ] ... 由 BEL (0x07) 或 ST (ESC \) 终止
        i += 2;
        while (i < n) {
          const c = data.charCodeAt(i);
          if (c === 0x07) {
            i++;
            break;
          }
          if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i++;
        }
      } else if (next !== undefined && isControlParamOrIntermediate(next)) {
        // 两字符转义序列（ESC + 中间字节，如 ESC ( B 字符集选择）：跳到终结字节
        i += 2;
        while (i < n && isControlParamOrIntermediate(data.charCodeAt(i))) i++;
        if (i < n && isControlFinal(data.charCodeAt(i))) i++;
      } else if (next !== undefined && isControlFinal(next)) {
        // 两字符 ESC 序列（如 ESC 7/ESC 8/ESC M/ESC D）
        i += 2;
      } else {
        // 孤立的 ESC：剥掉
        i++;
      }
    } else if (code === 0x0a || code === 0x0d || code === 0x09) {
      // 保留换行/回车/制表
      out += data[i];
      i++;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // 其它 C0 / DEL / C1 控制字符：剥掉
      i++;
    } else {
      // 可打印字符（含多字节 UTF-8，charCodeAt 按码元取但这里仅作分类，
      // 追加时按原始字符串切片保证不拆坏代理对）
      let start = i;
      i++;
      while (i < n) {
        const c = data.charCodeAt(i);
        if (c === 0x1b || c === 0x0a || c === 0x0d || c === 0x09 || c < 0x20 || (c >= 0x7f && c <= 0x9f)) break;
        i++;
      }
      out += data.slice(start, i);
    }
  }
  return out;
}

/**
 * 会话日志的行内时间戳（本地时区 HH:MM:SS）。
 * 输入记录用：日志文件里标识「用户在此刻敲了什么」。
 */
export function logTimestamp(d: Date = new Date()): string {
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
