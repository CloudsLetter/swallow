# -*- coding: utf-8 -*-
"""FTP LIST 全流程探针：连上后执行到 LIST，打印每一步原始响应与数据连接内容。
用法: python _ftp_probe.py <host> <user> <pass> [port]
"""
import socket
import sys

host = sys.argv[1]
user = sys.argv[2]
pwd = sys.argv[3]
port = int(sys.argv[4]) if len(sys.argv) > 4 else 21

s = socket.create_connection((host, port), timeout=10)
f = s.makefile("rb")


def read_line():
    raw = f.readline()
    if not raw:
        print("  << EOF")
        return ""
    line = raw.decode("latin-1", "replace").rstrip("\r\n")
    print("  <<", repr(raw))
    return line


def cmd(c):
    print(">>", c)
    s.sendall((c + "\r\n").encode("latin-1"))
    r = read_line()
    while r[3:4] == "-":
        r = read_line()
    return r


print("== banner ==")
banner = read_line()
while banner[3:4] == "-":
    banner = read_line()

cmd(f"USER {user}")
cmd(f"PASS {pwd}")
cmd("PWD")
cmd("TYPE I")

# PASV 并解析端口
print(">> PASV")
s.sendall(b"PASV\r\n")
resp = read_line()
import re
m = re.search(r"\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)", resp)
d = socket.create_connection((host, int(m.group(5)) * 256 + int(m.group(6))), timeout=10)

# LIST
print(">> LIST")
s.sendall(b"LIST\r\n")
ctrl = read_line()  # 150? 125? 其他
if ctrl[:3] in ("150", "125"):
    pass

# 读数据
chunks = []
d.settimeout(10)
try:
    while True:
        b = d.recv(65536)
        if not b:
            break
        chunks.append(b)
except socket.timeout:
    pass
d.close()
data = b"".join(chunks)
print("  data bytes:", len(data))
for ln in data.decode("utf-8", "replace").splitlines()[:12]:
    print("  DATA |", ln)

# 结束响应
print("  control after data:")
read_line()
read_line()
s.close()
print("== done ==")
