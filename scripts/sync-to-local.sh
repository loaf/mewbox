#!/usr/bin/env bash
# 同步仓库源码到本地盘镜像（C:\mewbox-work）。
# 背景：仓库在 RaiDrive 网络盘上，vitest worker 启动读取 node_modules 会超时
# （START_TIMEOUT 硬编码 60s），因此 node 密集操作（vitest/tsc/pnpm）都在镜像目录执行。
# 镜像只含前端所需文件；Rust 侧已用 .cargo/config.toml 指到本地 target。
set -e
SRC="//RaiDrive-lijun/QNAP/proj/myaikl"   # X:\proj\myaikl 的 UNC 形式
SRC_WIN='X:\proj\myaikl'
DST='C:\mewbox-work'

mkdir -p /c/mewbox-work

# robocopy 退出码 0-7 都是成功；// 前缀防止 Git Bash 把 /MIR 当路径转换
robocopy "$SRC_WIN" "$DST" //MIR //NFL //NDL //NJH //NJS \
  //XD node_modules src-tauri .git prototype dev-workspace dist docs \
  //XF "*.png" "ChatGPT*" || rc=$?

rc=${rc:-0}
if [ "$rc" -gt 7 ]; then
  echo "robocopy failed with $rc" >&2
  exit "$rc"
fi
echo "synced -> $DST"
