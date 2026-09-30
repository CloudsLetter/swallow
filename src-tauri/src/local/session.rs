use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::session_events::{emit_session_event, SessionEvent};

/// 本地终端配置（本地 shell / WSL，无网络连接）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    /// shell 类型："cmd" | "powershell" | "pwsh" | "wsl" | "bash" | "msys2"
    pub shell: String,
    /// WSL 发行版名（shell = "wsl" 时可选；空 = 默认发行版）
    pub wsl_distro: Option<String>,
    /// 真实可执行文件绝对路径（探测下发，优先于按名解析；
    /// 解决 System32\bash.exe 这类 WSL 存根盖住真身的问题）
    pub exe_path: Option<String>,
}

/// 本机可用 shell 画像：供前端 QuickConnect 动态渲染入口（不可用的不显示）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellProfile {
    /// 与 LocalShellConfig.shell 对齐："cmd" | "powershell" | "pwsh" | "wsl" | "bash" | "msys2"
    pub shell: String,
    /// 展示名（如 "PowerShell" / "Ubuntu (WSL)"）
    pub label: String,
    /// WSL 发行版名（shell = "wsl" 时有效；None = 默认发行版）
    pub wsl_distro: Option<String>,
    /// 真实可执行文件绝对路径（启动时优先使用，见 LocalShellConfig.exe_path）
    pub exe_path: Option<String>,
    /// 是否可用（存在性检查通过）
    pub available: bool,
}

/// 探测本机可用 shell：Windows 查 System32/PATH + `wsl -l -q` 发行版；
/// Unix 读 $SHELL + /etc/shells。只做存在性检查，不启动进程。
pub fn list_shell_profiles() -> Vec<LocalShellProfile> {
    #[cfg(target_os = "windows")]
    {
        list_shell_profiles_cached()
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_shell_profiles_unix()
    }
}

/// 探测结果缓存：wsl.exe 在服务异常时即使有超时也要等 8 秒，
/// 页面每次挂载都调一次会反复白等。进程级缓存 5 分钟。
#[cfg(target_os = "windows")]
fn list_shell_profiles_cached() -> Vec<LocalShellProfile> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<(Vec<LocalShellProfile>, Instant)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((Vec::new(), Instant::now() - Duration::from_secs(3600))));
    if let Ok(guard) = cache.lock() {
        if guard.0.iter().any(|p| p.available) && guard.1.elapsed() < Duration::from_secs(300) {
            return guard.0.clone();
        }
    }
    let fresh = list_shell_profiles_windows();
    if let Ok(mut guard) = cache.lock() {
        *guard = (fresh.clone(), Instant::now());
    }
    fresh
}

#[cfg(target_os = "windows")]
fn list_shell_profiles_windows() -> Vec<LocalShellProfile> {
    use std::path::PathBuf;

    fn exists_in_path(exe: &str) -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).find_map(|dir| {
                let p = dir.join(exe);
                if p.is_file() {
                    Some(p)
                } else {
                    None
                }
            })
        })
    }

    fn system32(exe: &str) -> Option<PathBuf> {
        std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32").join(exe))
            .filter(|p| p.is_file())
    }

    let mut out = Vec::new();
    // cmd：System32 必有
    out.push(LocalShellProfile {
        shell: "cmd".into(),
        label: "cmd".into(),
        wsl_distro: None,
        exe_path: system32("cmd.exe").map(|p| p.to_string_lossy().into_owned()),
        available: system32("cmd.exe").is_some(),
    });
    // powershell：System32 必有（5.1）
    out.push(LocalShellProfile {
        shell: "powershell".into(),
        label: "PowerShell".into(),
        wsl_distro: None,
        exe_path: system32("WindowsPowerShell\\v1.0\\powershell.exe")
            .map(|p| p.to_string_lossy().into_owned()),
        available: system32("WindowsPowerShell\\v1.0\\powershell.exe").is_some(),
    });
    // pwsh 7：只看 PATH
    out.push(LocalShellProfile {
        shell: "pwsh".into(),
        label: "PowerShell 7".into(),
        wsl_distro: None,
        exe_path: exists_in_path("pwsh.exe").map(|p| p.to_string_lossy().into_owned()),
        available: exists_in_path("pwsh.exe").is_some(),
    });
    // bash 系：逐个真实来源收录（互不覆盖，各自独立入口）——
    // System32\bash.exe 只是 WSL 存根（实测本机 where bash.exe 首命中即它），
    // 必须显式排除，否则 Git Bash / MSYS2 永不可见。
    for found in find_bash_installs(&exists_in_path) {
        out.push(LocalShellProfile {
            shell: found.kind.into(),
            label: found.label.into(),
            wsl_distro: None,
            exe_path: Some(found.path.to_string_lossy().into_owned()),
            available: true,
        });
    }
    // WSL：wsl.exe 存在才枚举发行版，每个发行版一个独立入口
    if exists_in_path("wsl.exe").is_some() || system32("wsl.exe").is_some() {
        let distros = wsl_distros();
        if distros.is_empty() {
            // wsl 可用但无发行版：保留默认入口（启动时报错提示安装）
            out.push(LocalShellProfile {
                shell: "wsl".into(),
                label: "WSL".into(),
                wsl_distro: None,
                exe_path: None,
                available: true,
            });
        } else {
            for d in distros {
                out.push(LocalShellProfile {
                    shell: "wsl".into(),
                    label: format!("{} (WSL)", d),
                    wsl_distro: Some(d),
                    exe_path: None,
                    available: true,
                });
            }
        }
    }
    out.into_iter().filter(|p| p.available).collect()
}

/// bash 系真实来源（kind 决定启动参数与展示名）：
/// - git：Git for Windows 的 usr/bin/bash.exe（--login -i）
/// - msys2：MSYS2 的 usr/bin/bash.exe（--login -i，需配合 MSYSTEM 环境）
/// System32\bash.exe 与 WindowsApps\bash.exe 是 WSL 存根，一律排除。
/// 带超时的子进程执行：wsl.exe 在 WSL 服务异常时会无限挂起，
/// QuickConnect 每次挂载都触发探测——不设超时就是打开页面即卡死整机 IPC。
#[cfg(target_os = "windows")]
fn run_with_timeout(mut cmd: std::process::Command, timeout: std::time::Duration) -> Option<std::process::Output> {
    use std::io::Read;
    let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    };
    // 进程已退出：管道里的数据都在内核缓冲里，直接读完即可
    // （wsl -l -q / reg query 输出都是 KB 级，不会撑满管道导致上面的等待死锁）
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut out);
    }
    Some(std::process::Output { status, stdout: out, stderr: Vec::new() })
}

#[cfg(target_os = "windows")]
struct BashInstall {
    kind: &'static str,
    label: &'static str,
    path: std::path::PathBuf,
}

#[cfg(target_os = "windows")]
fn find_bash_installs(
    exists_in_path: &dyn Fn(&str) -> Option<std::path::PathBuf>,
) -> Vec<BashInstall> {
    use std::path::PathBuf;

    fn is_wsl_stub(p: &PathBuf) -> bool {
        let lower = p.to_string_lossy().to_ascii_lowercase();
        lower.contains("system32") || lower.contains("windowsapps")
    }

    let mut out: Vec<BashInstall> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut push = |kind: &'static str, label: &'static str, path: PathBuf| {
        if path.is_file() && !is_wsl_stub(&path) {
            let key = path.to_string_lossy().to_ascii_lowercase();
            if !seen.contains(&key) {
                seen.push(key);
                out.push(BashInstall { kind, label, path });
            }
        }
    };

    // 1. PATH 里的 bash.exe（排除 WSL 存根后第一个真身）
    if let Some(p) = exists_in_path("bash.exe") {
        // Git Bash 进 PATH 时通常就是它；MSYS2 进 PATH 时也是它——统 freight 按路径归属判定
        let lower = p.to_string_lossy().to_ascii_lowercase();
        if lower.contains("msys64") || lower.contains("msys2") {
            push("msys2", "MSYS2", p);
        } else {
            push("bash", "Git Bash", p);
        }
    }
    // 2. Git for Windows 常见安装路径
    for dir in [
        "C:\\Program Files\\Git",
        "C:\\Program Files (x86)\\Git",
    ] {
        push("bash", "Git Bash", PathBuf::from(dir).join("bin\\bash.exe"));
    }
    // Git 注册表安装路径（InstallPath\bin\bash.exe）
    {
        let mut cmd = std::process::Command::new("reg");
        cmd.args([
            "query",
            "HKLM\\SOFTWARE\\GitForWindows",
            "/v",
            "InstallPath",
        ]);
        if let Some(output) = run_with_timeout(cmd, std::time::Duration::from_secs(5)) {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(pos) = line.find("REG_SZ") {
                    let dir = line[pos + "REG_SZ".len()..].trim();
                    if !dir.is_empty() {
                        push("bash", "Git Bash", PathBuf::from(dir).join("bin\\bash.exe"));
                    }
                }
            }
        }
    }
    // 3. MSYS2 常见安装路径（msys2_shell.cmd 同级判定为 MSYS2 环境）
    for dir in ["C:\\msys64", "C:\\msys32", "D:\\msys64"] {
        let root = PathBuf::from(dir);
        if root.join("msys2_shell.cmd").is_file() || root.join("usr\\bin\\bash.exe").is_file() {
            push("msys2", "MSYS2", root.join("usr\\bin\\bash.exe"));
        }
    }
    // MSYS2 环境变量（MSYS2_PATH_TYPE 等场景下用户自定路径）
    if let Some(root) = std::env::var_os("MSYS2_ROOT").map(PathBuf::from) {
        push("msys2", "MSYS2", root.join("usr\\bin\\bash.exe"));
    }
    out
}

/// `wsl.exe -l -q`：一行一个发行版名。实测输出为 UTF-16LE（BOM + \0 分隔），
/// 但新版也可能直接 UTF-8：按 UTF-16LE 解，解出来含 \0 则说明判错，杀掉 \0 再解。
/// 关键：`clean_wsl_names` 的 `trim_matches(char::from(0))` 只去首尾 \0，
/// 行中间的 `d\0o\0c\0…` 必须在转码层解决，不能漏到下游（下游拿它当 `-d` 参数
/// 传给 wsl.exe 会报 invalid encoding）。
#[cfg(target_os = "windows")]
fn wsl_distros() -> Vec<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);
    let Some(output) = run_with_timeout(cmd, std::time::Duration::from_secs(8)) else {
        return Vec::new();
    };
    let raw = &output.stdout;
    let text = if looks_like_utf16le(raw) {
        decode_utf16le_strict(raw).unwrap_or_else(|| String::from_utf8_lossy(raw).into_owned())
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    // 兜底：仍含 \0 说明转码判错，删 \0 后按行重切（ASCII 名不受影响，
    // 非 ASCII 名此时已无法挽回，直接丢弃该行，见 clean_wsl_names）。
    let text = if text.contains('\0') {
        text.replace('\0', "")
    } else {
        text
    };
    clean_wsl_names(&text)
}

/// 严格 UTF-16LE 解码：含孤立代理区 / 奇数字节 / 解出来仍含 \0 即失败，
/// 调用方回退 UTF-8。`from_utf16_lossy` 永不失败，会把错判的输入也“解”成
/// 带 \0 的乱码（本次 bug 的根因），故不能用它做判定。
#[cfg(target_os = "windows")]
fn decode_utf16le_strict(raw: &[u8]) -> Option<String> {
    if raw.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16(&units).ok()?;
    if s.contains('\0') {
        return None;
    }
    Some(s)
}

#[cfg(target_os = "windows")]
fn looks_like_utf16le(raw: &[u8]) -> bool {
    if raw.len() < 4 {
        return false;
    }
    // BOM 或大量 \0 字节（ASCII 的 UTF-16LE 高位）即判定为 UTF-16LE
    if raw.starts_with(&[0xFF, 0xFE]) {
        return true;
    }
    let zeros = raw.iter().filter(|b| **b == 0).count();
    zeros * 2 > raw.len()
}

#[cfg(target_os = "windows")]
fn clean_wsl_names(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| {
            line.trim()
                .trim_matches('\u{feff}')
                .trim_matches(char::from(0))
                .trim()
                .to_string()
        })
        // 行内仍含 \0 / 控制字符：转码失败的残留，整行丢弃（不能把半截乱码当发行版名）
        .filter(|name| !name.is_empty() && !name.contains('\0') && !name.chars().any(|c| c.is_control()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{clean_wsl_names, decode_utf16le_strict};

    #[test]
    fn wsl_names_utf16le_decoded() {
        // 实测 `wsl -l -q` 输出：UTF-16LE，每行尾 \r\0\n\0
        let raw = "U\0b\0u\0n\0t\0u\0\r\0\n\0\0\0d\0o\0c\0k\0e\0r\0-\0d\0e\0s\0k\0t\0o\0p\0\r\0\n\0";
        let text = String::from_utf16_lossy(
            &raw
                .as_bytes()
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<u16>>(),
        );
        assert_eq!(clean_wsl_names(&text), vec!["Ubuntu", "docker-desktop"]);
    }

    #[test]
    fn wsl_names_utf8_passthrough() {
        assert_eq!(
            clean_wsl_names("Ubuntu\nDebian\n"),
            vec!["Ubuntu", "Debian"]
        );
        assert!(clean_wsl_names("\n  \n").is_empty());
    }

    #[test]
    fn strict_decode_rejects_embedded_nul() {
        // 误判场景：UTF-8 文本被当成 UTF-16LE 解，lossy 版会产出 d\0o\0c\0… 乱码；
        // 严格版必须失败，让调用方回退 UTF-8。
        let utf8 = "docker-desktop\r\n".as_bytes();
        // 偶数字节才进得去解码，补一个 \n 凑偶
        let mut raw = utf8.to_vec();
        raw.push(b'\n');
        assert!(decode_utf16le_strict(&raw).is_none());
    }

    #[test]
    fn dirty_lines_dropped() {
        // 行内残留 \0 / 控制字符整行丢弃，不会变成 `-d` 参数
        assert!(clean_wsl_names("d\0o\0c\0k\0e\0r\0").is_empty());
        assert_eq!(clean_wsl_names("Ubuntu\nd\0o\0c\0k\0\n"), vec!["Ubuntu"]);
    }
}

#[cfg(not(target_os = "windows"))]
fn list_shell_profiles_unix() -> Vec<LocalShellProfile> {
    use std::os::unix::fs::PermissionsExt;

    fn is_executable(path: &str) -> bool {
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // $SHELL 优先（用户登录 shell 置顶）
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.is_empty() && is_executable(&sh) && seen.insert(sh.clone()) {
            let label = sh.rsplit('/').next().unwrap_or(&sh).to_string();
            out.push(LocalShellProfile {
                shell: sh.clone(),
                label,
                wsl_distro: None,
                exe_path: Some(sh.clone()),
                available: true,
            });
        }
    }
    // /etc/shells 逐行收录可执行项
    if let Ok(content) = std::fs::read_to_string("/etc/shells") {
        for line in content.lines() {
            let path = line.trim();
            if path.is_empty() || path.starts_with('#') || !seen.insert(path.to_string()) {
                continue;
            }
            if is_executable(path) {
                let label = path.rsplit('/').next().unwrap_or(path).to_string();
                out.push(LocalShellProfile {
                    shell: path.to_string(),
                    label,
                    wsl_distro: None,
                    exe_path: Some(path.to_string()),
                    available: true,
                });
            }
        }
    }
    // 兜底：一个都没有时给 /bin/sh（存在性检查通过才给）
    if out.is_empty() && is_executable("/bin/sh") {
        out.push(LocalShellProfile {
            shell: "/bin/sh".into(),
            label: "sh".into(),
            wsl_distro: None,
            exe_path: Some("/bin/sh".into()),
            available: true,
        });
    }
    out
}

/// 根据 shell 类型构造启动命令。cmd/powershell 注入 `chcp 65001` 把输出统一为 UTF-8
/// （中文系统默认 GBK 代码页，否则终端显示乱码）；wsl/bash 默认 UTF-8 无需处理。
/// Unix 下 shell 字段为绝对路径（来自 list_shell_profiles_unix）：不再按名字匹配，
/// 含 '/' 的直接当可执行文件启动（portable-pty CommandBuilder 支持绝对路径）。
fn shell_command(config: &LocalShellConfig) -> CommandBuilder {
    // 探测下发的绝对路径优先（Git Bash / MSYS2 真身，不走按名解析）
    if let Some(exe) = config.exe_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let exe = exe.trim();
        if config.shell == "msys2" {
            // MSYS2：用 bash --login -i，并透传 MSYSTEM（默认 MINGW64，与 msys2_shell.cmd 一致）
            let mut cmd = CommandBuilder::new(exe);
            cmd.env(
                "MSYSTEM",
                std::env::var("MSYSTEM").unwrap_or_else(|_| "MINGW64".into()),
            );
            cmd.args(["--login", "-i"]);
            return cmd;
        }
        if config.shell == "bash" || exe.to_ascii_lowercase().ends_with("bash.exe") {
            let mut cmd = CommandBuilder::new(exe);
            cmd.args(["--login", "-i"]);
            return cmd;
        }
        return CommandBuilder::new(exe);
    }
    if config.shell.contains('/') || config.shell.contains('\\') {
        return CommandBuilder::new(config.shell.trim());
    }
    match config.shell.as_str() {
        "powershell" => {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.args(["-NoExit", "-Command", "chcp 65001 > $null"]);
            cmd
        }
        "pwsh" => {
            let mut cmd = CommandBuilder::new("pwsh.exe");
            cmd.args(["-NoExit", "-Command", "chcp 65001 > $null"]);
            cmd
        }
        "wsl" => {
            let mut cmd = CommandBuilder::new("wsl.exe");
            if let Some(distro) = config.wsl_distro.as_deref() {
                if !distro.trim().is_empty() {
                    cmd.args(["-d", distro.trim()]);
                }
            }
            cmd
        }
        "bash" => CommandBuilder::new("bash.exe"),
        "msys2" => {
            // 无探测路径时的回退（正常走不到：profile 必带 exe_path）
            let mut cmd = CommandBuilder::new("bash.exe");
            cmd.args(["--login", "-i"]);
            cmd
        }
        _ => {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/k", "chcp 65001>nul"]);
            cmd
        }
    }
}

pub struct LocalShellSession {
    /// PTY master：用于 resize（reader/writer 从它派生）。
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// 写入端（take_writer 只能调用一次）。
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 子进程句柄：用于 wait/kill。
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    session_id: String,
    is_connected: Arc<Mutex<bool>>,
    disconnect_handler: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}

impl LocalShellSession {
    pub fn connect(
        config: LocalShellConfig,
        session_id: String,
        cols: u32,
        rows: u32,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.clamp(1, u16::MAX as u32) as u16,
                cols: cols.clamp(1, u16::MAX as u32) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("创建本地 PTY 失败: {e}"))?;
        let (slave, master) = (pair.slave, pair.master);

        let cmd = shell_command(&config);
        let child = slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动本地 shell 失败: {e}"))?;
        // spawn 后 slave 可释放（子进程独立存活，master 负责 IO 与 resize）
        drop(slave);

        let writer = master
            .take_writer()
            .map_err(|e| format!("获取 PTY 写入端失败: {e}"))?;

        Ok(Self {
            master: Arc::new(Mutex::new(master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            session_id,
            is_connected: Arc::new(Mutex::new(true)),
            disconnect_handler: Arc::new(Mutex::new(None)),
        })
    }

    /// 注册会话退出（子进程退出/读端 EOF）时由 manager 执行的回调。
    pub fn set_disconnect_handler(&self, handler: Box<dyn FnOnce() + Send>) {
        *self.disconnect_handler.lock().unwrap() = Some(handler);
    }

    /// 启动输出读取线程：从 PTY master 读子进程输出并 emit 到 session-{id}。
    pub fn start_read_loop<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let session_id = self.session_id.clone();
        let master = self.master.clone();
        let child = self.child.clone();
        let is_connected = self.is_connected.clone();
        let disconnect_handler = self.disconnect_handler.clone();

        // 读线程建立时先取 reader（读端独立于写端，可并发）
        let reader = {
            let m = master.lock().unwrap();
            m.try_clone_reader()
        };
        let mut reader = match reader {
            Ok(r) => r,
            Err(e) => {
                emit_session_event(
                    &app_handle,
                    &session_id,
                    &SessionEvent::Error {
                        message: format!("获取 PTY 读端失败: {e}"),
                    },
                );
                emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                *is_connected.lock().unwrap() = false;
                let handler = disconnect_handler.lock().unwrap().take();
                if let Some(handler) = handler {
                    handler();
                }
                return;
            }
        };

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            // 跨 read 的 UTF-8 增量解码缓冲（多字节字符可能跨 8192 边界）
            let mut utf8_pending: Vec<u8> = Vec::with_capacity(8192 + 4);
            // 输出批量合并 + 事件通道下发：逐块 emit 的事件洪泛会打满前端主线程
            //（大流量输出卡死整机）
            let batcher = std::sync::Arc::new(std::sync::Mutex::new(
                crate::session_events::OutputBatcher::new(
                    crate::session_events::OutputBatcher::event_sink(
                        app_handle.clone(),
                        session_id.clone(),
                    ),
                ),
            ));
            // reader.read 是阻塞读，无数据时循环不迭代——16ms 合并窗口的到期 flush
            // 需要独立看门狗，否则停流后残留输出（如粘贴尾部）会滞留缓冲
            {
                let wd_batcher = std::sync::Arc::clone(&batcher);
                let wd_connected = std::sync::Arc::clone(&is_connected);
                thread::spawn(move || {
                    while *wd_connected.lock().unwrap() {
                        thread::sleep(std::time::Duration::from_millis(8));
                        wd_batcher.lock().unwrap().flush_if_due();
                    }
                });
            }
            loop {
                if !*is_connected.lock().unwrap() {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        // slave 关闭（子进程退出）：EOF
                        batcher.lock().unwrap().flush();
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                    Ok(n) => {
                        utf8_pending.extend_from_slice(&buffer[..n]);
                        // 只把「已完整」前缀转字符串发出，不完整尾部留给下次 read
                        let mut idx = 0;
                        while idx < utf8_pending.len() {
                            match std::str::from_utf8(&utf8_pending[idx..]) {
                                Ok(_) => {
                                    let s = String::from_utf8(utf8_pending.split_off(idx))
                                        .unwrap_or_default();
                                    if !s.is_empty() {
                                        batcher.lock().unwrap().push(&s);
                                    }
                                    idx = 0;
                                    break;
                                }
                                Err(e) => {
                                    let valid = e.valid_up_to();
                                    if valid > 0 {
                                        let s = String::from_utf8(
                                            utf8_pending[idx..idx + valid].to_vec(),
                                        )
                                        .unwrap_or_default();
                                        idx += valid;
                                        batcher.lock().unwrap().push(&s);
                                    } else if e.error_len().is_none() {
                                        break; // 不完整序列，等下次补齐
                                    } else {
                                        // 非法字节：替换 U+FFFD
                                        let bad = e.error_len().unwrap_or(1);
                                        idx += bad;
                                        batcher.lock().unwrap().push("\u{FFFD}");
                                    }
                                }
                            }
                        }
                        if idx > 0 {
                            utf8_pending.drain(..idx);
                        }
                        batcher.lock().unwrap().flush_if_due();
                    }
                    Err(e) => {
                        // 读错误：正常退出（子进程关闭管道）或异常，统一按断开处理
                        let _ = e;
                        batcher.lock().unwrap().flush();
                        emit_session_event(&app_handle, &session_id, &SessionEvent::Disconnected);
                        break;
                    }
                }
            }

            // 发掉缓冲残留（覆盖「会话被主动停止」的 break 路径）
            batcher.lock().unwrap().flush();
            *is_connected.lock().unwrap() = false;
            // 尽力回收子进程（可能已退出，忽略错误）
            let mut child_guard = child.lock().unwrap();
            let _ = child_guard.wait();

            let handler = disconnect_handler.lock().unwrap().take();
            if let Some(handler) = handler {
                handler();
            }
        });
    }

    pub fn write_data(&self, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        if !*self.is_connected.lock().unwrap() {
            return Err("本地终端会话已断开".to_string());
        }
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("写入本地终端失败: {e}"))?;
        writer.flush().map_err(|e| format!("刷新本地终端失败: {e}"))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows: rows.clamp(1, u16::MAX as u32) as u16,
                cols: cols.clamp(1, u16::MAX as u32) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整本地终端尺寸失败: {e}"))
    }

    pub fn disconnect(&self) -> Result<(), String> {
        *self.is_connected.lock().unwrap() = false;
        // kill 子进程：读线程的 read 会随管道关闭返回 EOF/错误而退出
        let mut child = self.child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        Ok(())
    }
}
