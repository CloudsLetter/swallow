//! OpenSSH 集成测试骨架（默认跳过，不起服务端时零成本）。
//!
//! 对真实 sshd 验证单元测试够不到的链路：算法协商、主机密钥校验、认证、
//! 通道打开与数据往返。本地或 CI 起一个 openssh-server（docker 一行即可）：
//!
//! ```bash
//! docker run -d --name sshd -p 2222:22 \
//!   -e PASSWORD_ACCESS=true -e USER_PASSWORD=test123 \
//!   linuxserver/openssh-server
//! ```
//!
//! 环境变量（全部设置才启用，缺任一则整组测试打印 SKIP 并返回）：
//! - `SWALLOW_SSH_TEST_HOST`（如 127.0.0.1）
//! - `SWALLOW_SSH_TEST_PORT`（默认 22）
//! - `SWALLOW_SSH_TEST_USER`（默认 root）
//! - `SWALLOW_SSH_TEST_PASSWORD` 或 `SWALLOW_SSH_TEST_KEY_PATH`（二选一）
//!
//! 运行：`cargo test --lib ssh::integration_tests -- --nocapture --test-threads=1`
//!
//! TODO(骨架扩展)：SFTP list/upload 往返、ProxyJump 链式、keepalive 探测、
//! 主机密钥变更（KeyChanged）路径——接入方式与本文件第一个测试相同。

use super::session::{SshConfig, SshSession};
use std::io::Read;

/// 环境变量齐全时返回测试配置；否则 None（测试调用方据此跳过）。
fn test_config() -> Option<SshConfig> {
    let host = std::env::var("SWALLOW_SSH_TEST_HOST").ok()?;
    let has_password = std::env::var("SWALLOW_SSH_TEST_PASSWORD").is_ok();
    let has_key = std::env::var("SWALLOW_SSH_TEST_KEY_PATH").is_ok();
    if !has_password && !has_key {
        return None;
    }
    Some(SshConfig {
        host,
        port: std::env::var("SWALLOW_SSH_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22),
        username: std::env::var("SWALLOW_SSH_TEST_USER").unwrap_or_else(|_| "root".into()),
        auth_type: if has_key { "key".into() } else { "password".into() },
        password: std::env::var("SWALLOW_SSH_TEST_PASSWORD").ok(),
        key_path: std::env::var("SWALLOW_SSH_TEST_KEY_PATH").ok(),
        cert_path: None,
        passphrase: None,
        key_id: None,
        private_key: None,
        public_key: None,
        cert_id: None,
        cert_content: None,
        cert_private_key: None,
        proxy: None,
        backend: String::new(),
        algo_profile: String::new(),
    })
}

fn skip_reason() -> &'static str {
    "SKIP: 未设置 SWALLOW_SSH_TEST_* 环境变量（本地/CI 起 openssh-server 后启用）"
}

/// 主链路：TCP → 算法协商 → 主机密钥校验 → 认证 → exec 回显 → 断开。
#[test]
fn connect_auth_exec_roundtrip() {
    let Some(config) = test_config() else {
        println!("{}", skip_reason());
        return;
    };

    let established = SshSession::establish_authenticated_session(
        &config,
        15, // 连接超时（秒）
        0,  // 测试不需要 keepalive
        false,
        &|_, _| {},
    )
    .expect("认证建连应成功");

    let session = established.session;
    session.set_timeout(10_000);

    let mut channel = session.channel_session().expect("打开 exec 通道应成功");
    channel.exec("echo swallow-integration-ok").expect("exec 应成功");

    let mut out = String::new();
    channel
        .read_to_string(&mut out)
        .expect("读取 exec 输出应成功");
    channel.wait_close().ok();

    assert!(
        out.contains("swallow-integration-ok"),
        "回显应包含标记串，实际输出: {out:?}"
    );
}

/// TODO(骨架)：keepalive 探测往返——establish 后 keepalive_config + keepalive_send，
/// 断言不返回 socket 错误（对端存活）。
#[test]
#[ignore = "骨架占位：按 connect_auth_exec_roundtrip 的模式补全"]
fn keepalive_probe_roundtrip() {
    unimplemented!()
}

/// TODO(骨架)：SFTP 打开/列目录/上传小文件/删除 往返（需要服务端开启 subsystem sftp）。
#[test]
#[ignore = "骨架占位：走 crate::sftp::SftpSession::connect + list_dir 往返"]
fn sftp_roundtrip() {
    unimplemented!()
}
