#!/usr/bin/env bash
# =============================================================================
#  年会爱心墙 · 启动脚本（Linux）
#  双击或 `./start.sh` 即可。窗口不要关，关掉服务就停了。
# =============================================================================

cd "$(dirname "$0")" || exit 1

# 从 U 盘 / 网盘拷过来时常丢执行权限，自己补上
chmod +x "$0" 2>/dev/null

# ---------- 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "  没有找到 Node.js，无法启动。"
    echo ""
    echo "  请先安装 Node.js（免费，装一次即可）："
    echo ""
    echo "    Ubuntu / Debian： sudo apt install -y nodejs npm"
    echo "    Fedora：          sudo dnf install -y nodejs"
    echo "    Arch：            sudo pacman -S nodejs npm"
    echo ""
    echo "  或者打开 https://nodejs.org 下载 LTS 版。"
    echo ""
    exit 1
fi

# ---------- 启动 ----------
exec node start.js
