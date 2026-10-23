#!/usr/bin/env node
/**
 * 年会爱心墙 · MP4 导出工具 v2
 * -----------------------------------------------------------------------------
 * v1 的问题：用 Page.startScreencast 录屏，再拿「总帧数 / 耗时」反推 fps 喂给
 * ffmpeg。screencast 是「画面有变化才出帧」，画面静止的段落会被压掉，整条
 * 时间轴因此被扭曲 —— 成片里根本对不上结语出现的那一刻。
 *
 * v2 改成「确定性时钟 + 逐帧截图」：
 *   1. 页面加载前劫持 requestAnimationFrame，动画不会自己跑，只能由我们推进
 *   2. 每一帧手动把时钟往前推固定毫秒，然后截图
 *   3. 帧率是我们自己定的常量，时间轴严格线性，第 N 帧就是第 N/FPS 秒
 *   4. 结语的 CSS 过渡（opacity + translateY，2s）同样改由合成时钟驱动，
 *      否则它会按真实墙钟时间跑完，在成片里快慢不一
 *
 * 全程零 npm 依赖，只需要系统里装了 Chrome 和 ffmpeg。
 *
 * 用法：
 *   node tools/export-video.mjs                        # 1920×1080 / 30fps / 完整片
 *   node tools/export-video.mjs --w 3840 --h 2160      # 4K
 *   node tools/export-video.mjs --fps 25               # 25fps
 *   node tools/export-video.mjs --out 年会爱心墙.mp4
 *   node tools/export-video.mjs --music music/bgm.mp3  # 加背景音乐（自动循环至片长）
 *   node tools/export-video.mjs --from 130 --to 146    # 只导出尾段，用于快速验收
 *   node tools/export-video.mjs --hold 10              # 结语定格时长（秒）
 *
 * 前置：先启动服务 `node server.js`（默认 http://127.0.0.1:8787）
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ==========================================================================
   参数
   ========================================================================== */

export function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}

const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const FPS = Math.max(10, Math.min(60, parseInt(arg('fps', '30'), 10)));
const OUT = path.resolve(ROOT, arg('out', 'output/年会爱心墙_' + W + 'x' + H + '.mp4'));
const MUSIC = arg('music', '');
const BASE = arg('base', 'http://127.0.0.1:8787');
const HOLD = parseFloat(arg('hold', '6'));          // 结语完全显示后再定格几秒
const FROM_SEC = Math.max(0, parseFloat(arg('from', '0')) || 0);
const TO_SEC = arg('to', '') === '' ? null : parseFloat(arg('to', ''));
const KEEP = process.argv.includes('--keep');
const PORT = 9333;
const MJPEG = path.join(ROOT, '.export', 'frames.mjpeg');

const log = (...a) => console.log('[导出]', ...a);

/* ==========================================================================
   时间轴（从服务端配置推导，不写死）
   ========================================================================== */

const STAGGER_MS = 500;        // = player.js VIS.converge.stagger
const SHOW_AFTER_MS = 1000;    // = player.js VIS.ending.showAfterConverge
const FADE_MS = 2000;          // = player.css #ending transition 时长

async function fetchJson(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error('接口失败 ' + p + ' → HTTP ' + r.status);
  const body = await r.json();
  if (body && body.code !== undefined && body.data !== undefined) {
    if (body.code !== 0) throw new Error(p + ' 返回错误：' + (body.message || body.code));
    return body.data;
  }
  return body;
}

/** 时间轴默认值（服务端没给就用这些） */
export const TIMELINE_DEFAULTS = {
  floatMs: 6000,
  cuMs: 3000,
  convergeMs: 7000,
  loopDelayMs: 15000,
};

/**
 * 由配置与照片数推导成片时间轴（纯函数，不碰网络，方便测试）。
 *
 *   |--- 漂浮 ---|--- 特写 ×N ---|--- 汇聚(+错峰) ---|-- 1s --|-- 淡入 2s --|-- 定格 --|
 *
 * @param {object} cfg 服务端 /api/config 返回的完整配置
 * @param {number} n 照片张数
 * @param {number} hold 结语完全显示后再定格几秒
 * @returns {{photoCount:number, cuCount:number, floatMs:number, cuMs:number,
 *            convMs:number, doneMs:number, endingMs:number, totalMs:number,
 *            loopRestartMs:number}}
 */
export function computeTimeline(cfg, n, hold) {
  const pb = (cfg && cfg.playback) || {};
  const floatMs = Number(pb.floatDuration) || TIMELINE_DEFAULTS.floatMs;
  const cuMs = Number(pb.closeupDuration) || TIMELINE_DEFAULTS.cuMs;
  const limit = Number(pb.closeupLimit) || 0;
  const cuCount = limit > 0 ? Math.min(n, limit) : n;
  const convMs = (Number(pb.convergeDuration) || TIMELINE_DEFAULTS.convergeMs) + STAGGER_MS;

  const doneMs = floatMs + cuCount * cuMs + convMs;
  const endingMs = doneMs + SHOW_AFTER_MS;
  const totalMs = endingMs + FADE_MS + (Number(hold) || 0) * 1000;

  return {
    photoCount: n,
    cuCount,
    floatMs,
    cuMs,
    convMs: convMs - STAGGER_MS,
    doneMs,
    endingMs,
    totalMs,
    loopRestartMs: endingMs + (Number(pb.loopDelay) || TIMELINE_DEFAULTS.loopDelayMs),
  };
}

async function readTimeline() {
  const [cfg, ph] = await Promise.all([fetchJson('/api/config'), fetchJson('/api/photos')]);
  const n = (ph.photos || []).length;
  if (!n) throw new Error('photos/ 里没有照片，先放照片再导出');

  return computeTimeline(cfg, n, HOLD);
}

/* ==========================================================================
   注入脚本：接管时钟 + 接管结语过渡
   ========================================================================== */

const SHIM = `
(() => {
  let pending = null;

  // 动画只能由 __hw.step() 推进；真实 rAF 一律不生效
  window.requestAnimationFrame = function (cb) { pending = cb; return 1; };
  window.cancelAnimationFrame = function () { pending = null; };

  /* ---- 虚拟定时器 ----
     播放器用 setTimeout 排「结语淡入」和「循环重播」，走的是墙上时间。
     录制时影片时钟比墙上时间慢好几倍，15 秒的循环间隔在片子里只剩 5 秒，
     结果刚定格就重播了。这里把定时器也挂到合成时钟上。 */
  const timers = new Map();
  let seq = 1;

  window.setTimeout = function (fn, delay) {
    if (typeof fn !== 'function') return 0;
    const id = seq++;
    const args = Array.prototype.slice.call(arguments, 2);
    timers.set(id, { due: hw.ts + (Number(delay) || 0), fn: fn, args: args, every: 0 });
    return id;
  };
  window.setInterval = function (fn, delay) {
    if (typeof fn !== 'function') return 0;
    const id = seq++;
    const every = Math.max(1, Number(delay) || 1);
    const args = Array.prototype.slice.call(arguments, 2);
    timers.set(id, { due: hw.ts + every, fn: fn, args: args, every: every });
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.clearInterval = function (id) { timers.delete(id); };

  function fireDue() {
    for (let guard = 0; guard < 500; guard++) {
      let pickId = 0;
      let pick = null;
      for (const entry of timers) {
        const t = entry[1];
        if (t.due <= hw.ts && (pick === null || t.due < pick.due)) { pickId = entry[0]; pick = t; }
      }
      if (pick === null) return;
      if (pick.every) pick.due = hw.ts + pick.every;
      else timers.delete(pickId);
      try { pick.fn.apply(null, pick.args); } catch (e) { /* 单个定时器出错不中断录制 */ }
    }
  }

  // 结语的 CSS 过渡是 cubic-bezier(0.22,0.61,0.36,1)，这里用同样的曲线
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = t => ((ax * t + bx) * t + cx) * t;
    const sy = t => ((ay * t + by) * t + cy) * t;
    const dx = t => (3 * ax * t + 2 * bx) * t + cx;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(t) - x;
        if (Math.abs(e) < 1e-5) break;
        const d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      t = Math.max(0, Math.min(1, t));
      return sy(t);
    };
  }
  const ease = bezier(0.22, 0.61, 0.36, 1);

  const hw = {
    ts: 0,
    el: null,
    slide: 0,
    ready: false,

    initEnding() {
      const el = document.getElementById('ending');
      if (!el) return false;
      this.el = el;
      this.slide = window.innerWidth * 0.016;

      const st = document.createElement('style');
      st.id = '__hw_ending_clock';
      st.textContent = '#ending{transition:none!important}';
      document.head.appendChild(st);

      el.style.opacity = '0';
      el.style.transform = 'translateY(' + this.slide + 'px)';

      const mo = new MutationObserver(() => {
        if (el.classList.contains('show') && el.__t0 == null) el.__t0 = hw.ts;
      });
      mo.observe(el, { attributes: true, attributeFilter: ['class'] });
      if (el.classList.contains('show') && el.__t0 == null) el.__t0 = hw.ts;

      this.ready = true;
      return true;
    },

    syncEnding() {
      const el = this.el;
      if (!el) return null;
      if (el.__t0 == null) {
        el.style.opacity = '0';
        return { t0: null, p: 0, op: 0 };
      }
      const p = Math.min(1, Math.max(0, (this.ts - el.__t0) / ${FADE_MS}));
      const e = ease(p);
      el.style.opacity = e.toFixed(4);
      el.style.transform = 'translateY(' + ((1 - e) * this.slide).toFixed(2) + 'px)';
      return { t0: el.__t0, p: +p.toFixed(4), op: +e.toFixed(4) };
    },

    step(dt, count) {
      for (let i = 0; i < count; i++) {
        this.ts += dt;
        const cb = pending;
        pending = null;
        if (cb) cb(this.ts);
        fireDue();
      }
      const end = this.syncEnding();
      return { ts: this.ts, end: end };
    }
  };

  window.__hw = hw;
})();
`;

/* ==========================================================================
   Chrome / CDP
   ========================================================================== */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-export-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  return { proc, profile };
}

async function waitForEndpoint(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function getPageWs() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('找不到可调试的页面');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id != null && c.pend.has(m.id)) {
        const { res, rej } = c.pend.get(m.id);
        c.pend.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pend.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result && r.result.value;
  }
}

/* ==========================================================================
   主流程
   ========================================================================== */

async function main() {
  fs.mkdirSync(path.dirname(MJPEG), { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (fs.existsSync(MJPEG)) fs.unlinkSync(MJPEG);

  const tl = await readTimeline();
  const endMs = TO_SEC == null ? tl.totalMs : Math.min(TO_SEC * 1000, tl.loopRestartMs - 500);
  const fromMs = FROM_SEC * 1000;

  log(`照片 ${tl.photoCount} 张，特写 ${tl.cuCount} 张 × ${tl.cuMs / 1000}s`);
  log(`时间轴：漂浮 ${tl.floatMs / 1000}s → 特写 ${(tl.cuCount * tl.cuMs) / 1000}s → 汇聚 ${tl.convMs / 1000}s`);
  log(`        ${tl.doneMs / 1000}s 定格成型，${tl.endingMs / 1000}s 结语开始淡入`);
  log(`片长 ${(endMs / 1000).toFixed(1)}s（${fromMs ? '从 ' + (fromMs / 1000).toFixed(1) + 's 起，' : ''}${W}×${H} @ ${FPS}fps）`);

  const { proc: chrome } = launchChrome();
  let ok = false;
  try {
    await waitForEndpoint();
    const cdp = await Cdp.connect(await getPageWs());
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });

    // 必须在导航前注入，才能抢在 player.js 之前换掉 rAF
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });

    log('加载播放页…');
    await cdp.send('Page.navigate', { url: `${BASE}/#start` });

    // 等照片全部解码（最多 90s）
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 600));
      let v = null;
      try {
        v = await cdp.eval(`(() => {
          const imgs = [...document.querySelectorAll('#cards img')];
          if (!imgs.length) return { n: 0, ok: 0 };
          return { n: imgs.length, ok: imgs.filter(i => i.complete && i.naturalWidth > 0).length };
        })()`);
      } catch { /* 页面还在导航 */ }
      if (v && v.n > 0 && v.ok === v.n) {
        log(`照片就绪：${v.n}/${v.n}`);
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error('照片未能全部加载，导出中止');

    // 成片里绝不能出现调试元素
    await cdp.eval(`(() => {
      const s = document.createElement('style');
      s.id = '__hw_hide_debug';
      s.textContent = '#status,#hud,#gate,#empty{display:none!important}';
      document.head.appendChild(s);
      return true;
    })()`);

    const inited = await cdp.eval('window.__hw && window.__hw.initEnding()');
    if (!inited) throw new Error('结语容器未就绪，导出中止');

    // 每帧把时钟推 1000/FPS 毫秒；拆成若干小步，让动画积分更贴近 60fps 的观感
    const substeps = Math.max(1, Math.round(60 / FPS));
    const dtStep = (1000 / FPS) / substeps;

    // 跳到起点
    if (fromMs > 0) {
      const skipFrames = Math.round(fromMs / (1000 / FPS));
      log(`快进到 ${(fromMs / 1000).toFixed(1)}s（${skipFrames} 帧，不落盘）…`);
      await cdp.eval(`window.__hw.step(${dtStep}, ${substeps * skipFrames})`);
    }

    log('逐帧截图…');
    const fh = fs.openSync(MJPEG, 'w');
    let bytes = 0;
    let frames = 0;
    let stopFrame = null;
    const hardMax = Math.round(((endMs - fromMs) / 1000) * FPS) + FPS * 3;
    const tRec = Date.now();

    while (true) {
      const st = await cdp.eval(`window.__hw.step(${dtStep}, ${substeps})`);

      // 结语一出现，再拍满「淡入 + 定格」就收工，不靠估算时长
      if (stopFrame == null && st && st.end && st.end.t0 != null) {
        const tail = Math.round(((FADE_MS + HOLD * 1000) / 1000) * FPS);
        stopFrame = frames + tail;
        process.stdout.write('\n');
        log(`结语已出现（第 ${frames} 帧），拍满 ${(FADE_MS / 1000 + HOLD).toFixed(1)}s 后收尾`);
      }
      if (frames > hardMax) break;
      if (stopFrame != null && frames >= stopFrame) break;

      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 90, fromSurface: true, captureBeyondViewport: false,
      });
      const buf = Buffer.from(shot.data, 'base64');
      fs.writeSync(fh, buf);
      bytes += buf.length;
      frames++;

      if (frames % FPS === 0) {
        const el = (frames / FPS).toFixed(0);
        process.stdout.write(`\r[导出] 已拍 ${frames} 帧 / ${el}s / ${(bytes / 1048576).toFixed(0)} MB   `);
      }
    }
    fs.closeSync(fh);
    process.stdout.write('\n');

    const cost = (Date.now() - tRec) / 1000;
    const dur = frames / FPS;
    log(`共 ${frames} 帧，片长 ${dur.toFixed(2)}s，${(bytes / 1048576).toFixed(0)} MB，耗时 ${cost.toFixed(0)}s`);
    if (frames < FPS) throw new Error('帧数太少，异常');

    /* ---------- ffmpeg ---------- */
    log('ffmpeg 合成中…');
    const args = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', MJPEG];

    let musicFile = '';
    if (MUSIC && fs.existsSync(MUSIC)) musicFile = MUSIC;
    else if (fs.existsSync(path.join(ROOT, 'music'))) {
      const first = fs.readdirSync(path.join(ROOT, 'music'))
        .filter(f => !f.startsWith('.') && /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(f))[0];
      if (first) musicFile = path.join(ROOT, 'music', first);
    }
    if (musicFile) {
      log(`配乐：${path.relative(ROOT, musicFile)}（循环铺满片长）`);
      args.push('-stream_loop', '-1', '-i', musicFile);
    }

    args.push(
      '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-movflags', '+faststart',
    );
    if (musicFile) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'afade=t=out:st=' + (dur - 1.2).toFixed(2) + ':d=1.2', '-shortest');
    } else {
      args.push('-an');
    }
    args.push(OUT);

    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    if (!KEEP && fs.existsSync(MJPEG)) fs.unlinkSync(MJPEG);

    const st = fs.statSync(OUT);
    log(`完成：${path.relative(ROOT, OUT)}`);
    log(`体积 ${(st.size / 1024 / 1024).toFixed(1)} MB / ${dur.toFixed(1)}s / ${W}×${H} / ${FPS}fps`);
    ok = true;
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    if (!ok) log('（失败，帧文件保留在 .export/frames.mjpeg 便于排查）');
  }
}

/* 只有被当作脚本直接执行时才真的跑录制。
   这样 tests/export.test.mjs 可以 `import { arg, computeTimeline }` 进来
   单独验参数解析与时间轴，而不会去拉 Chrome。 */
const invokedDirectly = (() => {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const main = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return Boolean(main) && main === self;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(e => {
    console.error('[导出] 失败：', e.message);
    process.exit(1);
  });
}
