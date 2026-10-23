#!/bin/bash
# =============================================================================
#  年会爱心墙 · 导出 MP4
#  双击本文件即可。会自动检查环境、启动一次性服务、逐帧导出、打开成片文件夹。
#  需要：Node.js 16+ 与 ffmpeg
# =============================================================================

cd "$(dirname "$0")" || exit 1
chmod +x "$0" 2>/dev/null

clear
echo ""
echo "  年会爱心墙 · 导出 MP4"
echo "  ──────────────────────────────────────"
echo ""

pause_exit() {
    echo ""
    read -r -p "  按回车键关闭 …" _
    exit "$1"
}

# ---------- 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
    echo "  ✗ 没有找到 Node.js。"
    echo "    请先双击「start.command」按提示安装，或到 https://nodejs.org 下载 LTS 版。"
    pause_exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 16 ] 2>/dev/null; then
    echo "  ✗ Node.js 版本太旧（$NODE_VERSION），需要 16 或更高。"
    pause_exit 1
fi
echo "  Node.js：$NODE_VERSION"

# ---------- 检查 ffmpeg ----------
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo ""
    echo "  ✗ 没有找到 ffmpeg —— 导出 MP4 必须用到它。"
    echo ""
    echo "    安装方法：打开「终端」，粘下面两行各按一次回车"
    echo ""
    echo '      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo "      brew install ffmpeg"
    echo ""
    echo "    装完重新双击本文件即可。"
    pause_exit 1
fi
echo "  ffmpeg：$(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"

# ---------- 检查 Chrome ----------
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
    echo ""
    echo "  ✗ 没有找到 Google Chrome（导出靠它逐帧渲染）。"
    echo "    请先安装 Chrome：https://www.google.com/chrome/"
    pause_exit 1
fi
echo "  浏览器：Google Chrome"
echo ""

# ---------- 需要时临时拉起服务 ----------
PORT=8787
BASE="http://127.0.0.1:$PORT"
SRV_PID=""

if curl -s -o /dev/null --max-time 2 "$BASE/api/config"; then
    echo "  服务已在运行，直接导出。"
else
    echo "  启动一次性服务 …"
    node server.js > .export-server.log 2>&1 &
    SRV_PID=$!
    READY=0
    for _ in $(seq 1 60); do
        sleep 0.5
        if curl -s -o /dev/null --max-time 2 "$BASE/api/config"; then READY=1; break; fi
    done
    if [ "$READY" != "1" ]; then
        echo "  ✗ 服务启动失败，看看 .export-server.log"
        [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
        pause_exit 1
    fi
    echo "  服务就绪。"
fi
echo ""

# ---------- 导出 ----------
node tools/export-video.mjs "$@"
RC=$?

if [ -n "$SRV_PID" ]; then
    kill "$SRV_PID" 2>/dev/null
    rm -f .export-server.log
fi

echo ""
if [ "$RC" -eq 0 ]; then
    echo "  ✓ 导出完成，成片在 output 文件夹里。"
    open output 2>/dev/null
else
    echo "  ✗ 导出失败，请看上面的提示。"
fi
pause_exit "$RC"
