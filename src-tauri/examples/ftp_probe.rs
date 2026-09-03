//! FTP 连接探针：复现 Swallow 的连接/登录/列目录路径，打印每步结果。
//! 用法: cargo run --example ftp_probe -- <host> <user> <pass> [port]
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let host = &args[1];
    let user = &args[2];
    let pass = &args[3];
    let port: u16 = args.get(4).and_then(|p| p.parse().ok()).unwrap_or(21);

    let sock_addr = format!("{host}:{port}")
        .to_socket_addrs()
        .unwrap()
        .next()
        .unwrap();
    let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(8)).unwrap();
    tcp.set_nodelay(true).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    tcp.set_write_timeout(Some(Duration::from_secs(8))).unwrap();

    println!("--- connect ---");
    let mut ftp = suppaftp::FtpStream::connect_with_stream(tcp).expect("connect_with_stream");
    println!("OK, banner done");

    println!("--- login ---");
    ftp.login(user, pass).expect("login");
    println!("OK");

    println!("--- pwd ---");
    println!("cwd = {}", ftp.pwd().expect("pwd"));

    println!("--- OPTS UTF8 ON ---");
    match ftp.opts("UTF8", Some("ON")) {
        Ok(()) => println!("OK: server accepts UTF8 mode"),
        Err(e) => println!("ERR (UTF8 模式不支持): {e}"),
    }

    println!("--- pwd after utf8 ---");
    println!("cwd = {}", ftp.pwd().expect("pwd"));

    println!("--- list(None) [LIST] ---");
    match ftp.list(None) {
        Ok(lines) => println!("OK, {} lines, first: {:?}", lines.len(), lines.first()),
        Err(e) => println!("ERR: {e}"),
    }

    println!("--- nlst(None) [NLST] ---");
    match ftp.nlst(None) {
        Ok(lines) => println!("OK, {} lines, first: {:?}", lines.len(), lines.first()),
        Err(e) => println!("ERR: {e}"),
    }

    println!("--- mlsd [MLSD] ---");
    match ftp.mlsd(None) {
        Ok(lines) => println!("OK, {} lines, first: {:?}", lines.len(), lines.first()),
        Err(e) => println!("ERR: {e}"),
    }
}
