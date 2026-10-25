//! 子进程控制台窗口抑制（Windows）。
//!
//! 从 GUI 进程（Tauri 应用）里启动控制台子进程时，Windows 会**先分配一个新的
//! 控制台窗口**，哪怕 stdout/stderr 都重定向了，窗口也会闪一下。
//!
//! 探测类调用在这个仓库里有两处高频场景：
//! - QuickConnect 每次挂载都会跑 `reg query`（找 Git Bash 安装路径）与
//!   `wsl.exe -l -q`（列 WSL 发行版）—— 一闪一闪观感很差；
//! - 密钥/证书页的 `ssh-keygen` 也会闪。
//!
//! `CREATE_NO_WINDOW`（0x0800_0000）让子进程在「无控制台」的环境中运行，
//! 管道重定向照常工作，输出内容不受影响。

/// 给命令加上「不创建控制台窗口」的标志（Windows）。非 Windows 为空实现。
#[cfg(target_os = "windows")]
pub(crate) fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn hide_console(_cmd: &mut std::process::Command) {}
