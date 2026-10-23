/**
 * player.js —— 播放页引擎
 * -----------------------------------------------------------------------------
 * 三幕动线从已验收原型 prototype/index.html 逐条移植。
 * 所有动画常量（§10 原型参数继承清单）保持不变，改任何一个都会让动效偏离
 * 用户已确认的效果。
 *
 * 与原型的三处差异（都是架构要求的）：
 *   1. 照片列表来自 GET /api/photos，而不是文件名探测
 *   2. 时长 / 循环 / 文案来自 GET /api/config
 *   3. 新增首屏遮罩、循环重播、空态
 */

import {
  layoutHeart,
  aspectFor,
  clamp,
  lerp,
  hash01,
  cubicBezier,
  ASPECT_CLAMP,
  HEART_DEFAULTS
} from './heart.js';

/* ==========================================================================
   视觉常量（docs/architecture.md §10 —— 逐项不得改动）
   ========================================================================== */

const VIS = {
  /* 第一幕 · 3D 漂浮 */
  float: {
    fieldX: [-0.09, 1.09],
    fieldY: [-0.09, 1.09],
    sizeMin: 0.095,
    sizeMax: 0.170,
    anchorSize: 0.255,
    anchorCount: 2,
    zMin: 2.0,
    zMax: 10.0,
    blurMax: 6,
    blurSlope: 0.6,
    driftAmp: 0.011,
    driftSpeed: [0.10, 0.26],
    rotateMax: 3.2,
    smooth: 3.6
  },

  /* 第二幕 · 逐张特写 */
  closeup: {
    maxHeightRatio: 0.74,      // 主卡最高占画面高 —— 留出上下余量，主卡才不会被裁
    centerY: 0.50,
    breatheAmp: 0.012,
    breathePeriod: 4000,

    /* 背景层：只留上一拍那几个人当背景。
       教训：把全部照片一起铺开（旧版 bgScale 0.42 铺 41 张）会糊成一地碎渣，
       远看像脏点。背景要「看得清是什么照片、数量可控」才有纵深。 */
    bgCount: 5,
    bgSize: [0.11, 0.19],      // 背景卡宽度区间（画面宽比例）
    bgBlur: [2.2, 4.8],        // [近, 远]
    bgOpacity: 0.85,
    bgRadius: [0.34, 0.56],    // 围绕主卡的外圈半径
    bgYSquash: 0.62,

    /* 主卡四周的安全边距。镜头要游走，主卡留的余量必须盖住相机的最大位移，
       否则镜头一推就把主卡推出画面 —— 主卡被裁就是烂片。 */
    mainPad: 0.10,

    /* 每拍的运镜：在一拍之内镜头朝某个方向缓慢推拉 / 横移。
       目标值每拍重新抽，靠指数平滑过渡（不是跳变），所以看起来是"镜头在走"。 */
    dolly: {
      panX: 0.045,             // 每拍横向漂移目标（画面宽比例）
      panY: 0.022,             // 纵向漂移目标（画面高比例）
      zoom: [0.02, 0.085],     // 每拍推拉目标区间：有的拍轻轻推，有的拍推到近
      smooth: 0.55             // 逼近速度（1/s）—— 越慢越像电影镜头的缓慢推轨
    },

    /* 群像组：一拍同时推一组照片，分大小、随机摆位。
       样片 shot2 / shot4 / shot5 都是「几张照片同时撑在画面里、大小不一」，
       不是一张独大、也不是一次只露一张。
       每换一拍就换一组人、换一套摆位 —— 这是"随机感"的来源。 */
    ensemble: {
      groupSize: 5,                  // 一拍轮转窗口大小（含主卡）

      /* 拍型：每拍上前景的人数也随机。按拍轮换人数正是群像感的关键 ——
         「有的是这种 5 张，有的可能是一张主图加一张或两张」。
         权重按参考视频统计：2 张和 3 张最常见，5 张偶尔来一下。 */
      patterns: [
        { extra: 1, w: 0.24, mainScale: 1.26 },   // 主卡 + 1 张：主卡推得近、画面干净
        { extra: 2, w: 0.30, mainScale: 1.10 },
        { extra: 3, w: 0.26, mainScale: 0.98 },
        { extra: 4, w: 0.20, mainScale: 0.90 }    // 扎堆：主卡让位，群像感最强
      ],

      mainSize: [0.86, 1.14],        // 主卡每拍在基准宽度上再浮动，制造推拉感
      mainWanderX: 0.09,             // 主卡相对中线的最大偏移（画面宽比例）
      mainYRange: [0.47, 0.53],      // 主卡纵向落点范围（主卡大，纵向只能微游）
      solo: { size: [0.26, 0.36], blur: [0.0, 0.8] },   // 只有一张陪衬时，它得够大，画面才不空
      big: { count: 2, size: [0.24, 0.34], blur: [0.0, 0.6] },
      mid: { count: 2, size: [0.14, 0.21], blur: [0.0, 1.2] },
      ringRadius: [0.33, 0.53],      // 其余成员围绕主卡的半径（画面宽比例）
      ringYSquash: 0.55,             // 纵向压扁，贴合 16:9
      driftAmp: 0.004                // 自身微漂（画面宽比例）
    }
  },

  /* 虚拟相机 —— 整个舞台缓慢游走
     照片永远端正、不旋转，靠「平移 + 推拉」制造镜头运动感。
     两组不同周期 + 错开相位的正弦叠加，刻意避开整数倍关系，
     让运动看不出循环规律（这是"随机感"的来源，不是真随机）。 */
  camera: {
    panX: 0.030,               // 左右位移，画面宽比例（±3.0% ≈ ±58px @1920）
    panY: 0.018,               // 上下位移，画面高比例
    zoom: 0.024,               // 呼吸式推拉，±2.4%
    waves: [
      { a: 1.00, px: 1 / 22, py: 1 / 31, pz: 1 / 18, ph: 0.0 },
      { a: 0.42, px: 1 / 9, py: 1 / 13, pz: 1 / 26, ph: 2.1 }
    ]
  },

  /* 第三幕 · 汇聚成型 */
  converge: {
    /* 错峰时间。旧值 500ms 是「远处照片愣 0.5 秒才启动」—— 旧值在 12~13 秒
       处看到的停顿感，一半来自这里：画面里有一部分照片完全不动，另一部分在飞。
       压到 120ms，错落感还在，但不会再出现"谁在发呆"。 */
    stagger: 120,

    /* 缓动曲线的关键指标是「初速度 / 平均速度」：
       - 旧值 [0.45,0.05,0.25,1] = 0.11 → 起步几乎不动，发呆近 1 秒
       - 试过 [0.26,0.38,0.34,1] = 1.46 → 0.25 秒窜到峰值，变成"窜出去"
       - 现用 [0.30,0.20,0.30,1] = 0.67 → 立刻看得见移动，又不突兀；
         前 10% 时间走掉 10%（旧值 3%），峰值只有平均的 2.11 倍（旧值 2.58），
         峰值落在 25% 时刻（自然），末 10% 残留 0.6%（收得住）。 */
    ease: [0.30, 0.20, 0.30, 1],
    cameraSettleAt: 0.75        // 相机在 75% 处就归位完毕，别和卡片一起在末尾"双重静止"
  },

  /* 结语 */
  ending: {
    showAfterConverge: 1000,
    fadeDuration: 2000
  },

  /* 照片卡 */
  card: {
    frameRatio: 0.025,
    shadow: '0 2px 8px rgba(0,0,0,0.12)',
    objectPosition: '50% 42%'
  },

  /* 音频 */
  audio: {
    fadeIn: 1500
  }
};

/** 汇聚缓动（全局只建一次） */
const CONVERGE_EASE = cubicBezier(
  VIS.converge.ease[0], VIS.converge.ease[1],
  VIS.converge.ease[2], VIS.converge.ease[3]
);

/* ==========================================================================
   运行时状态
   ========================================================================== */

/** 服务端配置（GET /api/config），失败时用内置兜底 */
let CFG = null;

/* 管理台「镜头运镜」旋钮 → 基础相机与每拍运镜的统一缩放系数 */
const CAMERA_LEVELS = { off: 0, light: 0.5, mid: 1.0, strong: 1.8 };
function cameraLevelFactor() {
  const lv = CFG && CFG.playback ? CFG.playback.cameraLevel : null;
  return (lv && CAMERA_LEVELS[lv] !== undefined) ? CAMERA_LEVELS[lv] : 1.0;
}

/** 兜底配置：接口挂了也要能播 */
const FALLBACK_CFG = {
  text: { main: '感谢有你 一路同行', company: '' },
  playback: {
    floatDuration: 6000,
    closeupDuration: 3000,
    closeupWidthRatio: 0.50,
    convergeDuration: 7000,
    closeupLimit: 0,
    loop: true,
    loopDelay: 15000
  },
  music: { enabled: true, volume: 0.62, track: null },
  heart: Object.assign({}, HEART_DEFAULTS, { useNativeAspect: true, aspectRange: [0.66, 1.46] })
};

/* ==========================================================================
   小工具
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

/**
 * 取 DOM 元素的文本内容并安全设置（避免 XSS）。
 * @param {HTMLElement} el
 * @param {string} text
 */
function setText(el, text) {
  if (el) el.textContent = text == null ? '' : String(text);
}

/**
 * 把画面尺寸写入 CSS 变量（所有 calc(var(--w)*…) 依赖它）。
 * @param {number} W
 * @param {number} H
 */
function applyStageVars(W, H) {
  const root = document.documentElement;
  root.style.setProperty('--w', W + 'px');
  root.style.setProperty('--h', H + 'px');
}

/* ==========================================================================
   音频
   ========================================================================== */

const AudioManager = {
  el: null,
  ready: false,
  started: false,
  volume: 0.62,

  /**
   * 加载曲目。
   * @param {Array<{name:string,url:string}>} tracks
   * @param {{enabled:boolean, volume:number, track:string|null}} musicCfg
   */
  load(tracks, musicCfg) {
    this.volume = typeof musicCfg.volume === 'number' ? musicCfg.volume : 0.62;

    if (!musicCfg.enabled) return;
    if (!tracks || tracks.length === 0) return;

    const wanted = musicCfg.track;
    const pick = tracks.find((t) => t.name === wanted) || tracks[0];
    if (!pick) return;

    try {
      const a = new Audio();
      a.src = pick.url;
      a.loop = true;
      a.preload = 'auto';
      a.volume = 0;
      a.addEventListener('error', () => {
        // 音频坏了不影响画面，静默降级
        this.ready = false;
      }, { once: true });
      this.el = a;
      this.ready = true;
    } catch {
      this.ready = false;
    }
  },

  /** 首次用户手势后调用；被浏览器拦截时静默失败 */
  start() {
    if (!this.ready || !this.el || this.started) return;
    this.started = true;

    let p;
    try { p = this.el.play(); } catch { return; }
    if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦截：静音运行 */ });

    const t0 = performance.now();
    const target = this.volume;
    const self = this;

    (function fade() {
      const k = clamp((performance.now() - t0) / VIS.audio.fadeIn, 0, 1);
      try { self.el.volume = target * k; } catch { /* ignore */ }
      if (k < 1) requestAnimationFrame(fade);
    })();
  },

  pause() {
    if (this.el && this.started) { try { this.el.pause(); } catch { /* ignore */ } }
  },

  resume() {
    if (!this.el || !this.started) return;
    let p;
    try { p = this.el.play(); } catch { return; }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
};

/* ==========================================================================
   场景（三幕状态机）
   ========================================================================== */

const Scene = {
  W: 0,
  H: 0,
  photos: [],
  cards: [],
  layout: null,

  mode: 'float',        // float | closeup | converge | done
  modeT: 0,
  playing: true,
  started: false,       // 用户是否已点过「开始播放」
  activeIdx: 0,
  closeupQueue: [],

  floatClock: 0,
  _lastTs: 0,
  _raf: 0,
  _endingTimer: 0,
  _loopTimer: 0,

  /** 卡片容器（相机变换作用在它上面，不碰单张卡） */
  rootEl: null,
  /** 相机在 t=0 的原始值，用来把开场归零到正中 */
  _camBase: null,

  /* ---------------- 初始化 ---------------- */

  /**
   * @param {Array<object>} photos 来自 GET /api/photos
   */
  init(photos) {
    this.photos = photos;
    this.W = window.innerWidth;
    this.H = window.innerHeight;

    applyStageVars(this.W, this.H);
    this.applyEndingStyle();

    this.rootEl = $('#cards');
    this.build(photos.length);
    this.initCameraBase();

    this.mode = 'float';
    this.modeT = 0;
    this.activeIdx = 0;
    this.floatClock = 0;
    this._lastTs = 0;

    const self = this;
    if (!this._raf) {
      this._raf = requestAnimationFrame((ts) => self.tick(ts));
    }
    this.setStatus('第一幕 · 3D 漂浮  ·  ' + this.cards.length + ' 张');
  },

  /** 结语的尺寸与位置全部由 CSS 变量驱动，这里只补文案 */
  applyEndingStyle() {
    setText($('.e-main'), CFG.text.main);
    setText($('.e-sub'), CFG.text.company || '');
    // 副文案为空时 CSS 会整行隐藏
  },

  /* ---------------- 构建卡片 ---------------- */

  build(count) {
    const root = $('#cards');
    root.innerHTML = '';
    this.cards = [];

    const n = Math.min(count, this.photos.length);
    if (n === 0) { this.layout = null; return; }

    // 每张照片的显示宽高比（顺序即播放顺序，绝不重排）
    const aspects = [];
    for (let i = 0; i < n; i++) {
      aspects.push(this.displayAspect(this.photos[i], i));
    }

    const heartCfg = Object.assign({}, CFG.heart);
    const L = layoutHeart(n, this.W, this.H, aspects, heartCfg);
    this.layout = L;

    // 智能发牌后格子与照片的对应关系由 L.order 给出
    const cellFor = new Array(n);
    for (let k = 0; k < L.cells.length; k++) {
      cellFor[L.cells[k].photo] = L.cells[k];
    }

    for (let c = 0; c < n; c++) {
      const cell = cellFor[c];
      const photo = this.photos[c];

      const el = document.createElement('div');
      el.className = 'card';

      const img = document.createElement('img');
      img.src = photo.url;
      img.alt = '';
      img.draggable = false;
      // 同步解码：图片在 preloadImages 里已解码过，这里命中缓存，
      // 用 sync 可避免小尺寸卡片出现"先白一帧"
      img.decoding = 'sync';
      el.appendChild(img);

      /* 基础尺寸取「最大形态」（特写尺寸），其余各幕一律缩小。
         若反过来用小尺寸再放大，浏览器会按小尺寸栅格化后拉伸，画面会糊。 */
      const cu = VIS.closeup;
      let baseW = this.W * CFG.playback.closeupWidthRatio;
      let baseH = baseW / aspects[c];
      const maxH = this.H * cu.maxHeightRatio;
      if (baseH > maxH) { baseH = maxH; baseW = baseH * aspects[c]; }

      el.style.width = baseW + 'px';
      el.style.height = baseH + 'px';
      el.style.borderWidth = (baseH * VIS.card.frameRatio) + 'px';
      el.style.boxShadow = VIS.card.shadow;
      img.style.objectPosition = VIS.card.objectPosition;

      root.appendChild(el);

      this.cards.push({
        el: el,
        img: img,
        i: c,
        w0: baseW,
        h0: baseH,
        aspect: aspects[c],
        cell: cell,
        heartScale: cell.w / baseW,
        heart: { cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2 },
        cur: { x: 0, y: 0, s: cell.w / baseW, r: 0, blur: 0, op: 1, z: 0 },
        from: null,
        delay: 0,
        zTarget: 400,
        fx: 0, fy: 0, fz: 5, fphase: 0, fspeed: 0.15, famp: 10,
        floatRot: 0,
        isAnchor: false
      });
    }

    this.initFloat();
    this.buildCloseupQueue();
    this._ens = new Map();
    this._bg = new Map();
    this._mainIdx = -1;

    // 每拍运镜：目标是“下一拍要去哪”，当前值是“镜头现在在哪”
    this._camPanTgtX = 0; this._camPanCurX = 0;
    this._camPanTgtY = 0; this._camPanCurY = 0;
    this._camZoomTgt = 0; this._camZoomCur = 0;
  },

  /**
   * 计算显示宽高比。
   * @param {object} photo
   * @param {number} index
   * @returns {number}
   */
  displayAspect(photo, index) {
    const useNative = CFG.heart.useNativeAspect !== false;

    if (useNative && photo && typeof photo.aspect === 'number' && photo.aspect > 0) {
      return clamp(photo.aspect, ASPECT_CLAMP[0], ASPECT_CLAMP[1]);
    }
    return aspectFor(index, photo, {
      useNativeAspect: useNative,
      aspectRange: CFG.heart.aspectRange
    });
  },

  /* ---------------- 第一幕：漂浮位 ---------------- */

  initFloat() {
    const f = VIS.float;
    const n = this.cards.length;
    if (!n) return;

    // 抖动网格铺满画面（并略微溢出），复现样片的密布感
    const cols = Math.max(1, Math.round(Math.sqrt(n * (this.W / this.H))));
    const rows = Math.ceil(n / cols);

    const x0 = this.W * f.fieldX[0], x1 = this.W * f.fieldX[1];
    const y0 = this.H * f.fieldY[0], y1 = this.H * f.fieldY[1];
    const stepX = (x1 - x0) / cols;
    const stepY = (y1 - y0) / rows;

    for (let i = 0; i < n; i++) {
      const c = this.cards[i];
      const cx = Math.floor(i % cols);
      const cy = Math.floor(i / cols);

      const jx = (hash01(i, 3) - 0.5) * stepX * 0.72;
      const jy = (hash01(i, 5) - 0.5) * stepY * 0.72;

      c.fx = x0 + (cx + 0.5) * stepX + jx;
      c.fy = y0 + (cy + 0.5) * stepY + jy;

      // 深度：偏向远处（小而糊）居多的层次感
      c.fz = f.zMin + Math.pow(hash01(i, 9), 1.25) * (f.zMax - f.zMin);

      c.fphase = hash01(i, 11) * Math.PI * 2;
      c.fspeed = lerp(f.driftSpeed[0], f.driftSpeed[1], hash01(i, 13));
      c.famp = this.W * f.driftAmp * (0.55 + 0.9 * hash01(i, 15));
      c.floatRot = (hash01(i, 19) - 0.5) * 2 * f.rotateMax;

      c.isAnchor = false;
    }

    // 视觉锚点：挑离画面中心最近的 1–2 张，放大 / 拉近 / 不模糊
    const self = this;
    const byCenter = this.cards.slice().sort((a, b) => {
      const da = Math.pow(a.fx - self.W / 2, 2) + Math.pow(a.fy - self.H * 0.46, 2);
      const db = Math.pow(b.fx - self.W / 2, 2) + Math.pow(b.fy - self.H * 0.46, 2);
      return da - db;
    });

    const anchors = Math.min(f.anchorCount, byCenter.length);
    for (let a = 0; a < anchors; a++) {
      const ac = byCenter[a];
      ac.fz = f.zMax;
      ac.isAnchor = true;
      const t = a === 0 ? 0.62 : 0.52;
      ac.fx = lerp(ac.fx, this.W * (a === 0 ? 0.44 : 0.58), t);
      ac.fy = lerp(ac.fy, this.H * (a === 0 ? 0.42 : 0.53), t);
      ac.famp *= 0.7;
    }

    // 初始化当前状态为漂浮位（避免开场从 0,0 飞入）
    for (let k = 0; k < n; k++) {
      const cc = this.cards[k];
      const st = this.floatTarget(cc, 0);
      cc.cur.x = st.x;
      cc.cur.y = st.y;
      cc.cur.s = st.s;
      cc.cur.r = st.r;
      cc.cur.blur = st.blur;
      cc.cur.op = 1;
      cc.cur.z = st.z;
    }
  },

  /**
   * 漂浮幕的目标状态（随时间漂移）。
   * @param {object} c
   * @param {number} timeSec
   * @returns {{x:number,y:number,s:number,r:number,blur:number,op:number,z:number}}
   */
  floatTarget(c, timeSec) {
    const f = VIS.float;
    const ph = timeSec * c.fspeed + c.fphase;

    const x = c.fx + Math.sin(ph) * c.famp;
    const y = c.fy + Math.cos(ph * 0.78 + 1.1) * c.famp * 0.82;

    const zt = (c.fz - f.zMin) / (f.zMax - f.zMin);   // 0 远 → 1 近

    const targetW = c.isAnchor
      ? this.W * f.anchorSize
      : this.W * lerp(f.sizeMin, f.sizeMax, zt);

    const s = targetW / c.w0;
    const blur = clamp((f.zMax - c.fz) * f.blurSlope, 0, f.blurMax);
    const r = (c.floatRot || 0) * (c.isAnchor ? 0.35 : 1);

    // §7.5：漂浮卡 100–420，锚点再 +120
    const z = 100 + Math.round(zt * 200) + (c.isAnchor ? 120 : 0);

    return { x: x, y: y, s: s, r: r, blur: blur, op: 1, z: z };
  },

  /* ---------------- 第二幕：特写队列 ---------------- */

  /**
   * 排队「节拍」。
   *
   * ⚠️ 拍数为什么改成「等于张数」：
   *   旧逻辑是 ceil(张数 / 每组张数) —— 43 张 / 每组 5 张 = 9 拍。
   *   可每拍只让 3 张上台（1 主 + 2 陪），9 拍 × 3 人 = 27 个展示位，
   *   43 张里有 16 张在整段特写里一次都没露脸。
   *   特写段要的是「每张都展示一秒、都能得到展现」，
   *   所以改成一人一拍当主角：拍数 = 张数，张张轮得到，谁都不会漏。
   *   每拍仍是 1 主 + N 陪的群像构图，随机感不受影响。
   * closeupLimit > 0 时按用户指定的拍数走。
   */
  buildCloseupQueue() {
    const n = this.cards.length;
    const lim = CFG.playback.closeupLimit;
    const beats = (lim && lim > 0) ? Math.min(lim, n) : Math.max(1, n);

    const q = [];
    for (let b = 0; b < beats; b++) q.push(b);
    this.closeupQueue = q;
    this.activeIdx = 0;
  },

  /**
   * 为一个节拍重新编排「群像组」。
   *
   * 参考视频实测（.ref/ref_clean.mp4）：一拍里同时有 2~4 张照片撑住画面，
   * 大小分档，照片永远端正、永远清晰，大约每 1.5~2 秒换一组人。
   *
   * 组员用「轮转窗口」挑 —— 保证每张照片都轮得到，不会有人一辈子露不了脸；
   * 档位和位置全由 hash01 决定 —— 所以每一拍的构图都不一样。
   *
   * @param {number} beat 第几拍
   */
  assignEnsemble(beat) {
    const en = VIS.closeup.ensemble;
    const cu = VIS.closeup;
    const n = this.cards.length;
    this._ens = new Map();
    this._bg = new Map();
    this._mainIdx = -1;
    if (!n) return;

    const seed = beat * 977 + n * 131;

    /* 主卡轮转制：第 beat 拍的主角就是第 beat 张照片。
       旧逻辑是「每拍从 5 张候选里按 hash 排序，头名当主卡」——
       43 张只排 9 拍、每拍仅 3 人上台，16 张全程没露脸。
       现在一人一拍，张张都当一次主角，展示全覆盖。 */
    const mainCi = ((beat % n) + n) % n;

    /* 陪衬候选：主卡以外的所有人，按 hash 洗牌后按序取用。
       洗牌种子随 beat 变化，所以每拍的构图依旧各不相同，
       但主角轮换是确定的 —— 随机感保留了，"漏脸"却不会了。 */
    const others = [];
    for (let i = 0; i < n; i++) {
      if (i !== mainCi) others.push({ ci: i, r: hash01(seed + i * 37, 61) });
    }
    others.sort((a, b) => a.r - b.r);

    /* 抽拍型：这一拍前景站几个人。
       管理台「同框张数」固定为 2~5 时直接用固定值；
       否则按权重轮盘随机，每拍独立 —— 这就是"随机感"的来源。 */
    const fixedN = (CFG.playback && typeof CFG.playback.ensembleCount === 'number')
      ? CFG.playback.ensembleCount : 0;
    let pat;
    if (fixedN >= 2) {
      const want = Math.min(fixedN - 1, others.length);
      pat = en.patterns.find(function (p) { return p.extra === want; })
        || { extra: want, mainScale: 1.0 };
    } else {
      const pats = en.patterns;
      let wsum = 0;
      for (let i = 0; i < pats.length; i++) wsum += pats[i].w;
      let rw = hash01(seed + 991, 107) * wsum;
      pat = pats[pats.length - 1];
      for (let i = 0; i < pats.length; i++) {
        rw -= pats[i].w;
        if (rw <= 0) { pat = pats[i]; break; }
      }
    }
    const extra = Math.min(pat.extra, others.length);

    // 主卡落点：中线附近游走，不钉死在正中（参考视频里主卡一直在挪）
    const m1 = hash01(seed, 67);
    const m2 = hash01(seed + 11, 71);
    const m3 = hash01(seed + 3, 73);
    let mainX = this.W * (0.5 + (m1 - 0.5) * 2 * en.mainWanderX);
    let mainY = this.H * lerp(en.mainYRange[0], en.mainYRange[1], m2);

    // 主卡尺寸：基准 × 拍型系数 × 每拍浮动；竖向不超出画面
    const mc = this.cards[mainCi];
    let mainW = this.W * CFG.playback.closeupWidthRatio
      * pat.mainScale * lerp(en.mainSize[0], en.mainSize[1], m3);
    const maxH = this.H * VIS.closeup.maxHeightRatio;
    if (mainW * (mc.h0 / mc.w0) > maxH) mainW = maxH * (mc.w0 / mc.h0);

    /* 夹回画面内 —— 主卡必须完整可见，被裁一半就成烂片了。
       边距要把「相机最大位移」算进去：镜头一推，主卡才不会被顶出画。 */
    const halfW = mainW / 2;
    const halfH = mainW * (mc.h0 / mc.w0) / 2;
    const padX = this.W * (VIS.closeup.mainPad + 0.02);
    const padY = this.H * 0.05;
    mainX = clamp(mainX, halfW + padX, this.W - halfW - padX);
    mainY = clamp(mainY, halfH + padY, this.H - halfH - padY);

    this._mainIdx = mainCi;
    this._ens.set(mainCi, {
      isMain: true, x: mainX, y: mainY, tw: mainW, blur: 0, z: 900
    });

    for (let j = 1; j <= extra; j++) {
      const ci = others[j - 1].ci;
      const tier = (extra <= 1) ? en.solo : (j <= en.big.count ? en.big : en.mid);
      const s1 = hash01(seed + j * 3 + 1, 41);
      const s2 = hash01(seed + j * 5 + 2, 43);
      const s3 = hash01(seed + j * 7 + 3, 47);
      const s4 = hash01(seed + j * 11 + 5, 53);

      /* 围绕主卡环形落位。允许被画面边缘裁掉一角（参考视频里大量卡片就被裁），
         但中心点必须留在画面内 —— 整个跑出画就等于白站一个位置。 */
      const ang = s1 * Math.PI * 2;
      const rad = lerp(en.ringRadius[0], en.ringRadius[1], s2) * this.W;
      const px = clamp(mainX + Math.cos(ang) * rad, this.W * 0.12, this.W * 0.88);
      const py = clamp(mainY + Math.sin(ang) * rad * en.ringYSquash, this.H * 0.14, this.H * 0.86);

      this._ens.set(ci, {
        isMain: false,
        x: px,
        y: py,
        tw: this.W * lerp(tier.size[0], tier.size[1], s4),
        blur: lerp(tier.blur[0], tier.blur[1], s3),
        z: 400 - j * 30
      });
    }

    /* 这一拍轮到但没上前景的人，退到背景层当虚化陪衬 —— 仍然露脸，只是小一号。
       再加上上一拍那一组人：既保证画面里始终有新面孔轮转，
       又不会把四十多张全部摊开糊成碎渣。 */
    const bgQueue = [];
    const bgSeen = new Set();
    for (let j = extra; j < others.length; j++) {
      bgQueue.push(others[j].ci);
      bgSeen.add(others[j].ci);
    }
    // 上一拍那一组人也留住：画面里始终有新有旧，不会全是生面孔
    const prev = this._prevMembers || [];
    for (let j = 0; j < prev.length; j++) {
      const ci = prev[j];
      if (ci !== mainCi && !bgSeen.has(ci)) { bgQueue.push(ci); bgSeen.add(ci); }
    }

    // 记下本拍成员，供下一拍留旧面孔
    this._prevMembers = [mainCi];
    for (let j = 0; j < extra; j++) this._prevMembers.push(others[j].ci);

    let bgN = 0;
    for (let j = 0; j < bgQueue.length && bgN < cu.bgCount; j++) {
      const ci = bgQueue[j];
      if (this._ens.has(ci)) continue;

      const h1 = hash01(seed + j * 13 + 7, 83);
      const h2 = hash01(seed + j * 17 + 9, 89);
      const h3 = hash01(seed + j * 19 + 11, 97);
      const ang = h1 * Math.PI * 2;
      const rad = lerp(cu.bgRadius[0], cu.bgRadius[1], h2) * this.W;

      this._bg.set(ci, {
        x: clamp(mainX + Math.cos(ang) * rad, this.W * 0.06, this.W * 0.94),
        y: clamp(mainY + Math.sin(ang) * rad * cu.bgYSquash, this.H * 0.10, this.H * 0.90),
        tw: this.W * lerp(cu.bgSize[0], cu.bgSize[1], h3),
        blur: lerp(cu.bgBlur[0], cu.bgBlur[1], h2),
        z: 10 + Math.round(h3 * 30)
      });
      bgN++;
    }

    /* 这一拍的运镜目标：往哪边挪多少、推近多少。
       实际镜头靠指数平滑慢慢追过去，所以是"推轨"而不是"跳切"。
       乘上管理台的运镜系数，off 时全为 0。 */
    const lv = cameraLevelFactor();
    const dl = cu.dolly;
    this._camPanTgtX = (hash01(seed + 211, 109) - 0.5) * 2 * dl.panX * this.W * lv;
    this._camPanTgtY = (hash01(seed + 223, 113) - 0.5) * 2 * dl.panY * this.H * lv;
    this._camZoomTgt = lerp(dl.zoom[0], dl.zoom[1], hash01(seed + 235, 127)) * lv;
  },

  /**
   * 特写幕的目标状态。
   * @param {object} c
   * @param {object|null} activeCard 兼容旧签名，现由 _ens 决定主卡
   * @param {number} tMs
   */
  closeupTarget(c, activeCard, tMs) {
    const cu = VIS.closeup;

    /* 群像组：主卡 + 大卡 + 中卡，一拍之内同时存在 */
    const en = this._ens && this._ens.get(c.i);
    if (en) {
      const amp = cu.ensemble.driftAmp * this.W;
      const ph = this.floatClock * 0.16 + c.i;
      const breathe = en.isMain
        ? 1 + cu.breatheAmp * Math.sin((tMs / cu.breathePeriod) * Math.PI * 2)
        : 1;

      return {
        x: en.x + Math.sin(ph) * amp,
        y: en.y + Math.cos(ph * 0.8) * amp * 0.7,
        s: (en.tw / c.w0) * breathe,
        r: 0,                                     // 参考视频：照片永远端正
        blur: en.blur,
        op: 1,
        z: en.z
      };
    }

    /* 背景层：上一拍的人留在外圈虚化当纵深，尺寸可辨、数量可控 */
    const bg = this._bg && this._bg.get(c.i);
    if (bg) {
      const amp2 = cu.ensemble.driftAmp * this.W * 1.6;
      const ph2 = this.floatClock * 0.11 + c.i * 0.7;
      return {
        x: bg.x + Math.sin(ph2) * amp2,
        y: bg.y + Math.cos(ph2 * 0.9) * amp2 * 0.7,
        s: bg.tw / c.w0,
        r: 0,
        blur: bg.blur,
        op: cu.bgOpacity,
        z: bg.z
      };
    }

    /* 其余照片本拍不上场：原地淡出，等轮到它再淡回来 */
    return {
      x: c.cur.x,
      y: c.cur.y,
      s: c.cur.s,
      r: 0,
      blur: 0,
      op: 0,
      z: 0
    };
  },

  /* ---------------- 第三幕：汇聚 ---------------- */

  enterConverge() {
    if (this.mode === 'converge' || this.mode === 'done') return;

    this.mode = 'converge';
    this.modeT = 0;
    clearTimeout(this._endingTimer);
    clearTimeout(this._loopTimer);
    this.hideEnding();

    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];

      // 快照起点
      c.from = {
        x: c.cur.x, y: c.cur.y, s: c.cur.s,
        r: c.cur.r, blur: c.cur.blur, op: c.cur.op
      };

      // 按距离中心远近错峰，营造自然汇聚
      const dx = c.from.x - this.W / 2;
      const dy = c.from.y - this.H / 2;
      c.delay = clamp(Math.sqrt(dx * dx + dy * dy) / (this.W * 0.62), 0, 1) * VIS.converge.stagger;

      // §7.5：汇聚卡 400–480，下方行压上方行
      c.zTarget = 400 + c.cell.row * 6 + Math.round((hash01(i, 71) - 0.5) * 4);
    }

    this.resetCameraDolly();
    this.setStatus('第三幕 · 汇聚成型');
  },

  finishConverge() {
    this.mode = 'done';
    this.modeT = 0;
    this.setStatus('定格 · 感谢有你');

    const self = this;
    clearTimeout(this._endingTimer);
    this._endingTimer = setTimeout(() => {
      self.showEnding();

      // 循环：定格停留 loopDelay 后重播
      if (CFG.playback.loop) {
        clearTimeout(self._loopTimer);
        self._loopTimer = setTimeout(() => self.loopRestart(), CFG.playback.loopDelay);
      }
    }, VIS.ending.showAfterConverge);
  },

  /** 循环重播：回到第一幕，音乐不中断 */
  loopRestart() {
    clearTimeout(this._endingTimer);
    clearTimeout(this._loopTimer);
    this.hideEnding();
    this.initFloat();
    this.buildCloseupQueue();
    this.mode = 'float';
    this.modeT = 0;
    this.activeIdx = 0;
    this.floatClock = 0;
    this.resetCameraDolly();
    this.playing = true;
    this.setButtonLabel(true);
    this.setStatus('第一幕 · 3D 漂浮  ·  ' + this.cards.length + ' 张');
  },

  /* ---------------- 结语 ---------------- */

  showEnding() { $('#ending').classList.add('show'); },

  /** 无过渡地直接显示（深链 / 静态截图用，避免依赖 CSS 过渡时长） */
  showEndingInstant() {
    const el = $('#ending');
    if (!el) return;
    el.style.transition = 'none';
    el.classList.add('show');
  },

  hideEnding() {
    const el = $('#ending');
    if (!el) return;
    el.classList.remove('show');
    el.style.transition = '';
  },

  /* ---------------- 主循环 ---------------- */

  tick(ts) {
    const self = this;

    if (!this._lastTs) this._lastTs = ts;
    // dt 夹在 [0, 60ms]，防切后台回来跳阶段
    const dtMs = clamp(ts - this._lastTs, 0, 60);
    this._lastTs = ts;
    const dt = dtMs / 1000;

    // 漂移时钟始终推进（首屏未点击时画面也是活的）
    if (this.playing) this.floatClock += dt;

    // 阶段时钟只在用户点过「开始播放」且未暂停时推进
    if (this.playing && this.started) {
      this.modeT += dtMs;
    }

    if (this.started) this.step();

    // 每拍运镜：镜头朝目标缓慢推轨，速度刻意压低，才像电影镜头而不是抽搐
    const kc = 1 - Math.exp(-VIS.closeup.dolly.smooth * dt);
    this._camPanCurX = lerp(this._camPanCurX, this._camPanTgtX, kc);
    this._camPanCurY = lerp(this._camPanCurY, this._camPanTgtY, kc);
    this._camZoomCur = lerp(this._camZoomCur, this._camZoomTgt, kc);

    this.render(dt);
    this.applyDom();
    this.applyCamera();

    this._raf = requestAnimationFrame((t) => self.tick(t));
  },

  step() {
    const pb = CFG.playback;

    if (this.mode === 'float') {
      if (this.modeT >= pb.floatDuration) this.enterCloseup(0);

    } else if (this.mode === 'closeup') {
      if (this.modeT >= pb.closeupDuration) {
        this.activeIdx++;
        if (this.activeIdx >= this.closeupQueue.length) {
          this.enterConverge();
        } else {
          this.modeT = 0;
          this.assignEnsemble(this.activeIdx);
          this.setStatus('第二幕 · 群像推进  ' + (this.activeIdx + 1) + ' / ' + this.closeupQueue.length);
        }
      }

    } else if (this.mode === 'converge') {
      if (this.modeT >= pb.convergeDuration + VIS.converge.stagger) {
        this.finishConverge();
      }
    }
  },

  /** 运镜归位：离开特写幕时把镜头目标拉回原点，否则会一直漂到汇聚里 */
  resetCameraDolly() {
    this._camPanTgtX = 0;
    this._camPanTgtY = 0;
    this._camZoomTgt = 0;
  },

  enterCloseup(idx) {
    if (!this.closeupQueue.length) { this.enterConverge(); return; }

    if (idx < 0) idx = 0;
    if (idx >= this.closeupQueue.length) idx = this.closeupQueue.length - 1;

    this.mode = 'closeup';
    this.modeT = 0;
    this.activeIdx = idx;
    this.assignEnsemble(idx);
    this.setStatus('第二幕 · 群像推进  ' + (idx + 1) + ' / ' + this.closeupQueue.length);
  },

  /* ---------------- 虚拟相机 ---------------- */

  /**
   * 相机在某一时刻的原始位移（未做开场归零）。
   * @param {number} tSec
   * @returns {{x:number,y:number,z:number}} x/y 为像素，z 为缩放增量
   */
  camRaw(tSec) {
    const c = VIS.camera;
    let x = 0, y = 0, z = 0, wsum = 0;

    for (let i = 0; i < c.waves.length; i++) {
      const w = c.waves[i];
      // 三个轴的相位错开，避免整体同步"呼吸"
      x += Math.sin(tSec * Math.PI * 2 * w.px + w.ph) * w.a;
      y += Math.sin(tSec * Math.PI * 2 * w.py + w.ph * 1.7 + 0.8) * w.a;
      z += Math.sin(tSec * Math.PI * 2 * w.pz + w.ph * 2.3 + 1.5) * w.a;
      wsum += w.a;
    }

    const k = wsum > 0 ? 1 / wsum : 1;
    // 管理台「镜头运镜」旋钮：off / light / mid / strong → 全局缩放系数
    const lv = cameraLevelFactor();
    return {
      x: x * k * c.panX * this.W * lv,
      y: y * k * c.panY * this.H * lv,
      z: z * k * c.zoom * lv
    };
  },

  /** 记录 t=0 的相机值，使开场构图严格落在设计位置 */
  initCameraBase() {
    this._camBase = this.camRaw(0);
  },

  /** 相机在某一时刻的位移（已归零，t=0 时全为 0） */
  cameraAt(tSec) {
    const r = this.camRaw(tSec);
    const b = this._camBase || { x: 0, y: 0, z: 0 };
    return { x: r.x - b.x, y: r.y - b.y, z: r.z - b.z };
  },

  /**
   * 相机强度：汇聚阶段必须平滑归零。
   * 否则心形会被相机带着偏移，定格位置和结语对齐都会错。
   * @returns {number} 1 = 全幅游走，0 = 完全静止
   */
  cameraSettle() {
    if (this.mode === 'done') return 0;
    if (this.mode === 'converge') {
      const p = clamp(this.modeT / Math.max(1, CFG.playback.convergeDuration), 0, 1);
      // 相机比卡片更早归零：若两者同时在末尾趋于静止，末尾会像"卡住"一样
      const q = clamp(p / VIS.converge.cameraSettleAt, 0, 1);
      return 1 - q * q * (3 - 2 * q);          // smoothstep
    }
    return 1;
  },

  /** 把相机变换写到卡片容器上（单张卡的 transform 不受影响） */
  applyCamera() {
    if (!this.rootEl) return;

    const st = this.cameraSettle();
    const cam = this.cameraAt(this.floatClock);

    // 每拍运镜只在特写幕有效；其余幕目标值为 0，下面会自然衰减掉
    const dw = (this.mode === 'closeup') ? st : 0;
    const tx = (cam.x + this._camPanCurX) * st;
    const ty = (cam.y + this._camPanCurY) * st;
    const sc = 1 + (cam.z + this._camZoomCur * dw) * st;

    this.rootEl.style.transform =
      'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) ' +
      'scale(' + sc.toFixed(5) + ')';
  },

  /* ---------------- 渲染 ---------------- */

  render(dt) {
    if (!this.cards.length) return;

    const pb = CFG.playback;

    if (this.mode === 'converge' || this.mode === 'done') {
      // 定格后必须锁定 p = 1，否则 modeT 归零会把卡片弹回起点
      const done = (this.mode === 'done');

      for (let i = 0; i < this.cards.length; i++) {
        const c = this.cards[i];
        const local = done ? 1 : clamp((this.modeT - c.delay) / pb.convergeDuration, 0, 1);
        const p = done ? 1 : CONVERGE_EASE(local);

        c.cur.x = lerp(c.from.x, c.heart.cx, p);
        c.cur.y = lerp(c.from.y, c.heart.cy, p);
        c.cur.s = lerp(c.from.s, c.heartScale, p);
        c.cur.r = lerp(c.from.r, 0, p);
        c.cur.blur = lerp(c.from.blur, 0, p);
        c.cur.op = lerp(c.from.op, 1, p);
        c.cur.z = c.zTarget;
      }
      return;
    }

    // 漂浮 / 特写：向目标值指数平滑逼近（与帧率无关）
    const k = 1 - Math.exp(-VIS.float.smooth * Math.max(dt, 0.0001));

    for (let j = 0; j < this.cards.length; j++) {
      const cd = this.cards[j];
      const tgt = (this.mode === 'closeup')
        ? this.closeupTarget(cd, null, this.modeT)
        : this.floatTarget(cd, this.floatClock);

      cd.cur.x = lerp(cd.cur.x, tgt.x, k);
      cd.cur.y = lerp(cd.cur.y, tgt.y, k);
      cd.cur.s = lerp(cd.cur.s, tgt.s, k);
      cd.cur.r = lerp(cd.cur.r, tgt.r, k);
      cd.cur.blur = lerp(cd.cur.blur, tgt.blur, k);
      cd.cur.op = lerp(cd.cur.op, tgt.op, k);
      cd.cur.z = tgt.z;
    }
  },

  applyDom() {
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      const st = c.cur;

      // scale 最小 1e-4，避免 0 触发浏览器矩阵退化
      const s = Math.max(st.s, 0.0001);

      // 以卡片中心定位
      const tx = st.x - c.w0 / 2;
      const ty = st.y - c.h0 / 2;

      c.el.style.transform =
        'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) ' +
        'rotate(' + st.r.toFixed(2) + 'deg) ' +
        'scale(' + s.toFixed(5) + ')';

      // filter 在元素本地坐标系生效，必须除以 scale 才是稳定的屏幕像素模糊
      if (st.blur > 0.02) {
        c.el.style.filter = 'blur(' + (st.blur / s).toFixed(2) + 'px)';
      } else {
        c.el.style.filter = 'none';
      }

      c.el.style.opacity = st.op.toFixed(3);
      if (st.z) c.el.style.zIndex = String(st.z);
    }
  },

  /* ---------------- 状态条 / 控制 ---------------- */

  setStatus(txt) {
    const el = $('#status');
    el.textContent = txt;
    el.classList.add('show');
  },

  setButtonLabel(isPlaying) {
    const btn = $('#btnPlay');
    if (btn) btn.textContent = isPlaying ? '⏸ 暂停' : '▶ 播放';
  },

  /** 用户点击「开始播放」或按空格 */
  start() {
    if (this.started) return;
    this.started = true;
    this.playing = true;
    this.modeT = 0;
    this.setButtonLabel(true);
    AudioManager.start();
    $('#gate').classList.add('hide');
  },

  togglePlay() {
    if (!this.started) { this.start(); return; }
    this.playing = !this.playing;
    this.setButtonLabel(this.playing);
    if (this.playing) AudioManager.resume(); else AudioManager.pause();
  },

  prevCloseup() {
    if (!this.started) { this.start(); return; }
    if (this.mode === 'done') { this.replay(); return; }
    if (this.mode !== 'closeup') { this.enterCloseup(0); return; }
    this.enterCloseup(this.activeIdx - 1);
  },

  nextCloseup() {
    if (!this.started) { this.start(); return; }
    if (this.mode === 'done') { this.replay(); return; }
    if (this.mode !== 'closeup') { this.enterCloseup(0); return; }
    if (this.activeIdx + 1 >= this.closeupQueue.length) this.enterConverge();
    else this.enterCloseup(this.activeIdx + 1);
  },

  jumpConverge() {
    if (!this.started) { this.start(); return; }
    this.enterConverge();
  },

  replay() {
    clearTimeout(this._endingTimer);
    clearTimeout(this._loopTimer);
    this.hideEnding();
    this.initFloat();
    this.buildCloseupQueue();
    this.mode = 'float';
    this.modeT = 0;
    this.activeIdx = 0;
    this.floatClock = 0;
    this.resetCameraDolly();
    this.playing = true;
    this.started = true;
    this.setButtonLabel(true);
    this.setStatus('第一幕 · 3D 漂浮  ·  ' + this.cards.length + ' 张');
    AudioManager.resume();
  },

  /* ---------------- 尺寸变化 ---------------- */

  resize() {
    const prevW = this.W;
    const prevH = this.H;

    this.W = window.innerWidth;
    this.H = window.innerHeight;

    if (this.W === prevW && this.H === prevH) return;

    applyStageVars(this.W, this.H);

    const mode = this.mode;
    const activeLocal = this.activeIdx;
    const count = this.cards.length;
    if (!count) return;

    this.build(count);
    // 尺寸变了，相机幅度按新画幅重算，开场基准也要跟着更新
    this.initCameraBase();

    if (mode === 'closeup') {
      this.enterCloseup(activeLocal);
    } else if (mode === 'converge' || mode === 'done') {
      // 直接落到终点，避免 resize 时重播一次飞入
      for (let i = 0; i < this.cards.length; i++) {
        const c = this.cards[i];
        c.cur.x = c.heart.cx;
        c.cur.y = c.heart.cy;
        c.cur.s = c.heartScale;
        c.cur.r = 0;
        c.cur.blur = 0;
        c.cur.op = 1;
        c.cur.z = c.zTarget;
      }
      this.mode = (mode === 'done') ? 'done' : 'converge';
      this.modeT = CFG.playback.convergeDuration + VIS.converge.stagger;
      if (mode === 'done') this.showEnding();
    } else {
      this.mode = 'float';
    }
  }
};

/* ==========================================================================
   数据加载
   ========================================================================== */

/**
 * 统一的 API 请求（带超时与错误兜底）。
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<any>} 失败返回 null
 */
async function apiGet(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 8000);

  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.code !== 0) return null;
    return json.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 预加载所有图片并**等解码完成**；失败项从列表剔除。
 *
 * 为什么要显式 decode()：仅等 onload 只代表字节到齐，位图还未解码。
 * 若此时就把 <img> 换到卡片里，缩放很小的卡片会先白一帧（大屏上肉眼可见）。
 * 先 decode 一遍，卡片复用同一 URL 时直接命中已解码缓存。
 *
 * @param {Array<object>} photos
 * @returns {Promise<Array<object>>}
 */
function preloadImages(photos) {
  if (!photos.length) return Promise.resolve([]);

  const results = new Array(photos.length).fill(null);

  return Promise.all(photos.map((p, i) => new Promise((resolve) => {
    const img = new Image();

    let settled = false;
    const finish = (okFlag) => {
      if (settled) return;
      settled = true;
      results[i] = okFlag ? p : null;
      resolve();
    };

    img.onload = () => {
      // decode() 在已解码时立即 resolve；不支持的浏览器直接放行
      if (typeof img.decode === 'function') {
        img.decode().then(() => finish(true)).catch(() => finish(true));
      } else {
        finish(true);
      }
    };
    img.onerror = () => finish(false);
    img.src = p.url;

    // 单张超时不要卡死整批；但已经加载完的图不能因为超时被误判为失败
    setTimeout(() => {
      if (settled) return;
      finish(img.complete && img.naturalWidth > 0);
    }, 20000);
  }))).then(() => results.filter(Boolean));
}

/* ==========================================================================
   启动
   ========================================================================== */

/**
 * 解析 URL hash 直达某一幕（供彩排与自动截图使用，不影响正常播放）。
 *   #float        停在第一幕
 *   #closeup=3    跳到第 4 张特写
 *   #converge     跳到汇聚中段
 *   #done         直接定格并显示结语
 * @returns {string} 空串表示无 hash
 */
function applyDeepLink() {
  const h = String(window.location.hash || '').replace(/^#/, '');
  if (!h) return '';

  const stage = h.split('&')[0].split('=')[0];
  const arg = h.split('&')[0].split('=')[1];

  // 深链等同于用户已点过开始
  Scene.started = true;
  Scene.playing = true;
  const gate = $('#gate');
  if (gate) {
    // 深链是彩排/截图用途，遮罩直接移除，不等 0.6s 淡出
    gate.style.transition = 'none';
    gate.classList.add('hide');
    gate.style.display = 'none';
  }

  if (stage === 'done') {
    Scene.jumpConverge();
    Scene.modeT = CFG.playback.convergeDuration + VIS.converge.stagger;
    Scene.render(0.016);
    Scene.applyDom();
    Scene.finishConverge();
    // 深链是截图用途：结语即时显示，且不让循环/淡入计时器把画面改回去
    Scene.showEndingInstant();
    clearTimeout(Scene._endingTimer);
    clearTimeout(Scene._loopTimer);
  } else if (stage === 'converge') {
    Scene.jumpConverge();
    Scene.modeT = CFG.playback.convergeDuration * 0.62;
  } else if (stage === 'closeup') {
    const idx = parseInt(arg, 10);
    Scene.enterCloseup(isFinite(idx) ? idx : 0);
    Scene.modeT = CFG.playback.closeupDuration * 0.5;
  } else if (stage === 'start') {
    // 等价于用户点了「开始播放」，用于验证真实时间轴
    Scene.mode = 'float';
    Scene.modeT = 0;
    Scene.started = true;
    Scene.playing = true;
  } else {
    Scene.mode = 'float';
    Scene.modeT = 0;
  }

  /* ff=<秒>：按 60fps 步进 N 秒，用于无人值守的自动化验收。
     只是把时钟往前推，不改变任何动画常量。 */
  const ffMatch = /(?:^|&)ff=(\d+(?:\.\d+)?)/.exec(h);
  if (ffMatch) {
    const seconds = Math.min(parseFloat(ffMatch[1]) || 0, 600);
    const dt = 1 / 60;
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      Scene.floatClock += dt;
      Scene.modeT += dt * 1000;
      Scene.step();
      Scene.render(dt);
    }
    Scene.applyDom();
  }

  return stage;
}

/**
 * 入口。
 */
async function main() {
  const stage = $('#stage');
  applyStageVars(window.innerWidth, window.innerHeight);

  // 并行拉三份数据
  const [cfgData, photoData, musicData] = await Promise.all([
    apiGet('/api/config'),
    apiGet('/api/photos'),
    apiGet('/api/music')
  ]);

  // 配置兜底
  CFG = cfgData || JSON.parse(JSON.stringify(FALLBACK_CFG));
  // 逐域兜底，防止接口只返回了部分字段
  CFG.text = Object.assign({}, FALLBACK_CFG.text, CFG.text || {});
  CFG.playback = Object.assign({}, FALLBACK_CFG.playback, CFG.playback || {});
  CFG.music = Object.assign({}, FALLBACK_CFG.music, CFG.music || {});
  CFG.heart = Object.assign({}, FALLBACK_CFG.heart, CFG.heart || {});

  // 文案
  setText($('.e-main'), CFG.text.main);
  setText($('.e-sub'), CFG.text.company || '');

  // 音乐
  const tracks = (musicData && musicData.tracks) ? musicData.tracks : [];
  AudioManager.load(tracks, CFG.music);

  // 照片
  const rawPhotos = (photoData && photoData.photos) ? photoData.photos : [];
  if (!rawPhotos.length) {
    showEmpty();
    return;
  }

  const photos = await preloadImages(rawPhotos);

  // 失败过多 → 直接空态，避免排出残缺的心形
  if (!photos.length || photos.length < rawPhotos.length * 0.7) {
    showEmpty();
    return;
  }

  Scene.init(photos);

  /* 深链直达某幕（彩排 / 自动截图用；无 hash 时完全不影响正常流程） */
  applyDeepLink();

  /* ---------------- 交互绑定 ---------------- */

  // 首屏遮罩：点任意位置开始
  const gate = $('#gate');
  gate.addEventListener('click', () => Scene.start());
  stage.addEventListener('pointerdown', (e) => {
    // 点在控制栏上不要触发开始
    if (e.target.closest('#hud')) return;
    if (!Scene.started) Scene.start();
  }, { once: false });

  $('#btnPlay').addEventListener('click', () => Scene.togglePlay());
  $('#btnPrev').addEventListener('click', () => Scene.prevCloseup());
  $('#btnNext').addEventListener('click', () => Scene.nextCloseup());
  $('#btnConverge').addEventListener('click', () => Scene.jumpConverge());
  $('#btnReplay').addEventListener('click', () => Scene.replay());
  $('#btnAdmin').addEventListener('click', () => { window.location.href = '/admin'; });

  /* 键盘快捷键（彩排用） */
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); Scene.togglePlay(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); Scene.prevCloseup(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); Scene.nextCloseup(); }
    else if (e.key === 'c' || e.key === 'C') { Scene.jumpConverge(); }
    else if (e.key === 'r' || e.key === 'R') { Scene.replay(); }
    else if (e.key === 'h' || e.key === 'H') {
      $('#hud').classList.toggle('show');
    }
  });

  /* 鼠标移到左下角时自动显出控制栏（现场不用记快捷键） */
  const hud = $('#hud');
  document.addEventListener('mousemove', (e) => {
    const nearBottomLeft = e.clientX < window.innerWidth * 0.22
      && e.clientY > window.innerHeight * 0.82;
    if (nearBottomLeft) hud.classList.add('show');
  });

  /* 尺寸变化：防抖重算（不重播） */
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => Scene.resize(), 160);
  });

  /* 切后台回来时重置时间基准，避免跳阶段 */
  document.addEventListener('visibilitychange', () => {
    Scene._lastTs = 0;
  });

  /* 现场不能弹错误框，只记录 */
  window.addEventListener('error', (ev) => {
    console.warn('[heart-wall] 运行告警：', ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.warn('[heart-wall] 未处理的 Promise：', ev.reason);
  });
}

/** 显示空态（不白屏、不报错） */
function showEmpty() {
  $('#gate').classList.add('hide');
  $('#empty').classList.add('show');
}

main().catch((err) => {
  console.warn('[heart-wall] 初始化失败：', err);
  showEmpty();
});
