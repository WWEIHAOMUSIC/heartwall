#!/usr/bin/env node
/**
 * start.js —— 年会爱心墙 · 跨平台启动器
 * -----------------------------------------------------------------------------
 * start.command（Mac）/ start.bat（Windows）/ start.sh（Linux）三者的唯一逻辑入口，
 * 三个脚本本身只负责「切到本目录 → 检查有没有 Node → 执行 node start.js」。
 *
 * 本文件只做三件事：
 *   1. 探测系统、检查 Node 版本（< 16 直接给出可操作的中文提示）
 *   2. 先探一个空闲端口，再拉起 server.js（现场不必看到一串「端口被占用」）
 *      即便探测结果与真实监听错位，也以 server.js 自己打印的地址为准
 *   3. 服务就绪后自动开浏览器：Mac 用 open、Windows 用 Chrome/Edge 或 start、
 *      Linux 依次尝试 xdg-open / sensible-browser / x-www-browser …
 *
 * 命令行参数（一般不用）：
 *   --no-open       不自动开浏览器
 *   --port 9000     指定起始端口（默认 8787，被占用则顺延）
 *   --help          看帮助
 *
 * 环境变量：
 *   PORT / NO_OPEN=1 / NO_START_PAUSE=1（出错时不等待按键）
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ==========================================================================
   常量
   ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.js');

const DEFAULT_PORT = 8787;
const PORT_TRIES = 11;                 // 8787 → 8797
const HOST = '127.0.0.1';
const MIN_NODE_MAJOR = 16;             // 低于此版本不支持本项目的 ESM 写法

/** 打开浏览器前的等待，给服务一点时间把 HTTP 栈跑起来 */
const OPEN_DELAY_MS = 400;

/** 兜底：服务一直没打印地址，也要在 20 秒后开一次浏览器 */
const OPEN_TIMEOUT_MS = 20000;

/* ==========================================================================
   命令行参数
   ========================================================================== */

const ARGV = process.argv.slice(2);

function hasFlag(name) {
  return ARGV.includes('--' + name);
}

function flagValue(name, def) {
  const i = ARGV.indexOf('--' + name);
  if (i === -1) return def;
  const v = ARGV[i + 1];
  return (v && !v.startsWith('--')) ? v : def;
}

if (hasFlag('help') || hasFlag('h')) {
  console.log('年会爱心墙 · 启动器\n');
  console.log('  node start.js                 启动服务并自动打开浏览器');
  console.log('  node start.js --port 9000     从 9000 开始找空闲端口');
  console.log('  node start.js --no-open       只启动服务，不开浏览器\n');
  console.log('  平时直接双击 start.command / start.bat / start.sh 就行。\n');
  process.exit(0);
}

const PREF_PORT = Number(flagValue('port', process.env.PORT || '')) || DEFAULT_PORT;
const NO_OPEN = hasFlag('no-open') || process.env.NO_OPEN === '1';

/* ==========================================================================
   终端输出
   ========================================================================== */

/**
 * Windows 的传统控制台（conhost）默认不认 ANSI 转义序列，会把颜色代码原样打印
 * 成一堆乱码。只有在 Windows Terminal / 现代终端里才开颜色。
 * @returns {boolean}
 */
function shouldColor() {
  if (process.env.NO_COLOR === '1') return false;
  if (!process.stdout || !process.stdout.isTTY) return false;
  if (os.platform() === 'win32') {
    return Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
  }
  return true;
}

const COLOR = shouldColor();
const C = COLOR
  ? {
      reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
    }
  : { reset: '', dim: '', bold: '', red: '', green: '', yellow: '', cyan: '' };

const out = {
  /** @param {string} m */
  ok: (m) => console.log(`${C.green}✓${C.reset} ${m}`),
  /** @param {string} m */
  warn: (m) => console.log(`${C.yellow}!${C.reset} ${m}`),
  /** @param {string} m */
  err: (m) => console.log(`${C.red}✗${C.reset} ${m}`),
  /** @param {string} m */
  info: (m) => console.log(`${C.cyan}·${C.reset} ${m}`),
  /** @param {string} m */
  plain: (m) => console.log('  ' + m)
};

/**
 * 把平台号翻译成人话。
 * @returns {string}
 */
function platformLabel() {
  const p = os.platform();
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

/* ==========================================================================
   1. 检查 Node 版本
   ========================================================================== */

/**
 * Node 版本是否够新。
 * @returns {boolean}
 */
function checkNode() {
  const raw = process.versions.node || '0.0.0';
  const major = parseInt(String(raw).split('.')[0], 10);

  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    out.err(`Node.js 版本太旧（v${raw}），本程序需要 ${MIN_NODE_MAJOR} 或更高。`);
    out.plain('');
    out.plain('请到 https://nodejs.org 下载绿色的 LTS 按钮，');
    out.plain('双击安装包一路「继续」覆盖安装，然后重新双击启动。');
    return false;
  }
  return true;
}

/* ==========================================================================
   2. 探测空闲端口
   ========================================================================== */

/**
 * 试着独占监听一个端口，成功立刻关闭（只为探测，不占用）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;

    const done = (v) => {
      if (settled) return;
      settled = true;
      try { probe.close(); } catch { /* ignore */ }
      resolve(v);
    };

    probe.once('error', () => done(false));
    probe.once('listening', () => done(true));
    probe.listen(port, HOST);
  });
}

/**
 * 从 PREF_PORT 开始找第一个空闲端口。
 * @returns {Promise<{port:number|null, shifted:boolean}>}
 */
async function findFreePort() {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = PREF_PORT + i;
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return { port, shifted: i > 0 };
  }
  return { port: null, shifted: false };
}

/* ==========================================================================
   3. 打开浏览器
   ========================================================================== */

/** Windows 上常见浏览器的安装位置（按优先级） */
const WIN_BROWSER_CANDIDATES = [
  ['Google Chrome', [
    '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]],
  ['Microsoft Edge', [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe'
  ]]
];

/**
 * 展开 %LOCALAPPDATA% 之类的环境变量。
 * @param {string} p
 * @returns {string}
 */
function expandEnv(p) {
  return p.replace(/%([A-Za-z0-9_]+)%/g, (m, key) => process.env[key] || m);
}

/**
 * 在 Windows 上找第一个真实存在的浏览器可执行文件。
 * @returns {{label:string, exe:string}|null}
 */
function findWindowsBrowser() {
  for (const item of WIN_BROWSER_CANDIDATES) {
    const label = item[0];
    for (const raw of item[1]) {
      const exe = expandEnv(raw);
      if (fs.existsSync(exe)) return { label, exe };
    }
  }
  return null;
}

/**
 * 异步拉起一个外部程序，返回是否成功 spawn。
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<boolean>}
 */
function spawnDetached(file, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      done(false);
      return;
    }

    child.on('error', () => done(false));
    child.on('spawn', () => done(true));
    setTimeout(() => done(true), 1500);      // 兜底：spawn 事件没来也算成功
    child.unref();
  });
}

/**
 * 打开浏览器。Windows 优先用找到的 Chrome / Edge，否则交给系统默认程序。
 * @param {string} url
 * @returns {Promise<void>}
 */
async function openBrowser(url) {
  if (NO_OPEN) {
    out.info(`已按 --no-open 跳过打开浏览器，手动访问：${url}`);
    return;
  }

  const platform = os.platform();

  if (platform === 'win32') {
    const hit = findWindowsBrowser();
    if (hit) {
      const okSpawn = await spawnDetached(hit.exe, ['--new-window', url]);
      if (okSpawn) {
        out.ok(`已用 ${hit.label} 打开浏览器`);
        return;
      }
    }
    // 兜底：交给 Windows 的默认关联程序
    const okShell = await spawnDetached('cmd.exe', ['/c', 'start', '', url]);
    if (okShell) {
      out.ok('已用系统默认浏览器打开');
      return;
    }
    out.warn('没能自动打开浏览器，请手动访问：' + url);
    return;
  }

  const candidates = platform === 'darwin'
    ? [['open', [url]]]
    : [
        ['xdg-open', [url]],
        ['sensible-browser', [url]],
        ['x-www-browser', [url]],
        ['gio', ['open', url]],
        ['gnome-open', [url]]
      ];

  for (const item of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await spawnDetached(item[0], item[1])) {
      out.ok('已自动打开浏览器');
      return;
    }
  }

  out.warn('没能自动打开浏览器（可能没装桌面环境），请手动访问：' + url);
}

/* ==========================================================================
   收尾
   ========================================================================== */

/**
 * 出错时停一下，让双击启动的用户看得见提示。
 * @param {number} code
 */
function pauseAndExit(code) {
  if (process.env.NO_START_PAUSE === '1' || !process.stdin || !process.stdin.isTTY) {
    process.exit(code);
    return;
  }
  console.log('');
  console.log('  按回车键关闭 …');
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

/* ==========================================================================
   主流程
   ========================================================================== */

async function main() {
  console.log('');
  console.log(`${C.bold}  年会爱心墙${C.reset}  ${C.dim}· 启动器 · ${platformLabel()} / Node v${process.versions.node}${C.reset}`);
  console.log(`${C.dim}  ──────────────────────────────────────${C.reset}`);
  console.log('');

  if (!checkNode()) {
    pauseAndExit(1);
    return;
  }

  if (!fs.existsSync(SERVER)) {
    out.err('没找到 server.js，请把整个文件夹完整拷贝过来再启动。');
    pauseAndExit(1);
    return;
  }

  const { port, shifted } = await findFreePort();
  if (port === null) {
    out.warn(`端口 ${PREF_PORT}–${PREF_PORT + PORT_TRIES - 1} 都被占用，交给服务程序再试一次`);
  } else if (shifted) {
    out.warn(`默认端口 ${PREF_PORT} 已被占用，改用 ${port}（不影响使用）`);
  }

  const env = Object.assign({}, process.env, { NO_OPEN: '1' });   // 自己来开浏览器
  if (port !== null) env.PORT = String(port);

  let opened = false;
  let sawReady = false;
  let buffer = '';

  /** 从服务输出里认出「可以打开了」这一刻 */
  function tryOpen() {
    if (opened || NO_OPEN) return;

    const baseMatch = /http:\/\/(?:127\.0\.0\.1|localhost):\d+/.exec(buffer);
    if (!baseMatch) return;

    const base = baseMatch[0];
    const countMatch = /照片数量\s+(\d+)\s+张/.exec(buffer);
    const count = countMatch ? Number(countMatch[1]) : 0;

    // 与服务程序保持一致：有照片进播放页，没照片进管理台
    const target = count > 0 ? base + '/' : base + '/admin';

    opened = true;
    setTimeout(() => { openBrowser(target); }, OPEN_DELAY_MS);
  }

  const child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stdout.write(text);
    buffer += text;
    if (!sawReady && /服务已启动/.test(buffer)) {
      sawReady = true;
      tryOpen();
    }
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk.toString('utf8'));
  });

  child.on('error', (e) => {
    out.err('无法启动服务程序：' + e.message);
    pauseAndExit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`\n服务已停止（${signal}）`);
      process.exit(0);
      return;
    }
    if (code !== 0 && code !== null) {
      out.err(`服务程序退出，代码 ${code}`);
    }
    process.exit(code === null ? 0 : code);
  });

  // 兜底：服务一直没打印地址也开一次
  const fallbackTimer = setTimeout(() => {
    if (opened) return;
    const m = /http:\/\/(?:127\.0\.0\.1|localhost):\d+/.exec(buffer);
    if (!m) return;
    opened = true;
    openBrowser(m[0]);
  }, OPEN_TIMEOUT_MS);
  fallbackTimer.unref();

  // 终端里按 Ctrl+C：先停服务，再停本进程
  const forward = (sig) => {
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
}

main().catch((e) => {
  out.err('启动失败：' + (e && e.stack ? e.stack : e));
  pauseAndExit(1);
});
