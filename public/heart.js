/**
 * heart.js —— 心形排布计算内核（纯计算，零 DOM 依赖）
 * -----------------------------------------------------------------------------
 * 从已验收原型 prototype/index.html 的 §1/§2/§3 原样移植，改为 ESM。
 *
 * 三件事：
 *   1. 心形参数方程的曲线几何（spansAtDepth）
 *   2. 面积守恒闭式解定行高 / 行数
 *   3. 逐行 justify 排版（保持每张照片原始长宽比，绝不拉伸变形）
 *
 * 本模块不引用 document / window，可被浏览器与 `node tests/heart.test.mjs` 同时导入。
 *
 * 最重要的隐含契约：
 *   `layoutHeart()` 返回的 `cells[i]` 与传入的 `aspects[i]`（以及调用方的 `photos[i]`）
 *   严格一一对应。调用方**不得**在调用前重排 aspects，否则整张心形会错位。
 */

/* ==========================================================================
   常量
   ========================================================================== */

/** 心形曲线包围盒宽（x ∈ [-16, 16]） */
export const HEART_CURVE_W = 32;

/** 心形曲线包围盒高（y ∈ [-17, 11.9233]） */
export const HEART_CURVE_H = 28.9233;

/** 心形曲线包围盒的高宽比（≈0.90385） */
export const HEART_ASPECT = HEART_CURVE_H / HEART_CURVE_W;

/** 曲线局部坐标的 y 上界（顶部两叶的峰） */
const HEART_Y_MAX = 11.9233;

/** 曲线局部坐标的 y 下界（底部尖点） */
const HEART_Y_MIN = -17;

/**
 * 顶部凹口闭合处的归一化深度（d=0 为心形顶端，d=1 为尖底）。
 * 由曲线本身决定，不是可调业务参数，故不放进入 heartCfg。
 */
const NOTCH_D = 0.2381;

/**
 * 只有行中心深度落在此系数 × NOTCH_D 以内的行，才按"凹口取样"处理。
 * 0.5 的效果：8 行时只有第 0 行参与 → 凹口深度 = 1 个行高 = 12.5% 心形高，
 * 与样片实测的 11~12% 吻合。若取 1.0 会出现两行缺口导致凹口过深（25%）。
 */
const NOTCH_ROWH = 0.5;

/** 显示宽高比的夹取区间（防止极端长图把一行撑爆） */
export const ASPECT_CLAMP = [0.45, 2.2];

/** 心形几何的默认参数（与 config.json 的 heart 域字段名完全一致） */
export const HEART_DEFAULTS = {
  heightRatio: 0.856,     // 心形高 / 画面高（样片实测 435/508）
  centerY: 0.564,         // 心形中心 Y（画面高占比，样片实测）
  maxWidthRatio: 0.80,    // 心形宽上限；仅当画面宽高比 < 1.2311 时生效（安全网）
  widen: 1.040,           // 横向微调，让心形比参数方程略扁
  minRows: 7,             // 行数下限
  maxRows: 13,            // 行数上限
  gapRatio: 0.015,        // 横向照片间隙 / 行高（必须很小，否则读成"排队的卡片"）
  rowGapRatio: 0.008,     // 纵向行间隙 / 行高
  forceRows: 8            // 默认锁定 8 行（与已验收原型一致）；设 null 则按照片比例自动
};

/* ==========================================================================
   通用工具
   ========================================================================== */

/**
 * 把数值夹到 [lo, hi]。
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * 线性插值。
 * @param {number} a
 * @param {number} b
 * @param {number} t 0 → a，1 → b
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 确定性伪随机：同一组 (i, salt) 永远得到同一个 [0,1) 值。
 * 用途：让照片的深度/漂移相位/宽高比在每次刷新后保持一致。
 * @param {number} i 索引
 * @param {number} salt 盐值（不同用途用不同 salt）
 * @returns {number} [0, 1)
 */
export function hash01(i, salt) {
  let x = Math.imul(i + 1, 0x9E3779B1) ^ Math.imul((salt | 0) + 1, 0x85EBCA77);
  x ^= x >>> 15; x = Math.imul(x, 0x2545F491);
  x ^= x >>> 13; x = Math.imul(x, 0x27D4EB2F);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * 近似三角分布的伪随机：三次均匀平均，峰值在中位。
 * 比均匀分布更贴近真实照片尺寸/长宽比的分布。
 * @param {number} i
 * @param {number} salt
 * @returns {number} [0, 1)
 */
export function hashTri(i, salt) {
  return (hash01(i, salt) + hash01(i, salt + 61) + hash01(i, salt + 127)) / 3;
}

/**
 * 解 cubic-bezier(x1,y1,x2,y2)，返回缓动函数 y = f(x)。
 * 用牛顿迭代反解 t，收敛失败时退化为二分，保证单调稳定。
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {(x:number)=>number}
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    let t = x;
    for (let i = 0; i < 8; i++) {
      const xv = sampleX(t) - x;
      if (Math.abs(xv) < 1e-6) break;
      const d = dX(t);
      if (Math.abs(d) < 1e-7) break;
      t -= xv / d;
    }
    t = clamp(t, 0, 1);

    // 牛顿收敛失败 → 二分兜底
    if (Math.abs(sampleX(t) - x) > 1e-4) {
      let lo = 0, hi = 1;
      for (let j = 0; j < 26; j++) {
        t = (lo + hi) / 2;
        if (sampleX(t) < x) lo = t; else hi = t;
      }
    }
    return sampleY(t);
  };
}

/* ==========================================================================
   心形曲线几何
   --------------------------------------------------------------------------
   参数方程：
       x = 16·sin³t
       y = 13cos t − 5cos2t − 2cos3t − cos4t     (t ∈ [0, 2π])
   ========================================================================== */

/**
 * 曲线参数方程的 x。
 * @param {number} t 弧度
 * @returns {number}
 */
function curveX(t) {
  return 16 * Math.pow(Math.sin(t), 3);
}

/**
 * 曲线参数方程的 y。
 * @param {number} t 弧度
 * @returns {number}
 */
function curveY(t) {
  return 13 * Math.cos(t)
       - 5 * Math.cos(2 * t)
       - 2 * Math.cos(3 * t)
       - Math.cos(4 * t);
}

/** spansAtDepth 的缓存（同一次布局会被反复查询同一深度） */
const _spanCache = new Map();

/**
 * 求心形在归一化深度 d 处的水平可用区间。
 *
 * @param {number} d 0 = 心形最顶端（两叶峰顶），1 = 底部尖点
 * @returns {number[][]} 曲线局部坐标的区间数组，如 [[-15.1, -0.8], [0.8, 15.1]]
 *                       顶部凹口区返回 2 段（左右两簇），其余返回 1 段
 */
export function spansAtDepth(d) {
  const key = Math.round(d * 50000);
  const cached = _spanCache.get(key);
  if (cached) return cached;

  const y = HEART_Y_MAX - d * (HEART_Y_MAX - HEART_Y_MIN);
  const xs = [];
  const STEPS = 3600;

  let prevT = 0;
  let prev = curveY(0) - y;

  for (let i = 1; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2;
    const cur = curveY(t) - y;

    if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) {
      // 二分细化交点
      let a = prevT;
      let b = t;
      for (let k = 0; k < 46; k++) {
        const m = (a + b) / 2;
        if ((curveY(a) - y) * (curveY(m) - y) <= 0) b = m; else a = m;
      }
      xs.push(curveX((a + b) / 2));
    }
    prev = cur;
    prevT = t;
  }

  xs.sort((p, q) => p - q);

  const out = [];
  for (let j = 0; j + 1 < xs.length; j += 2) out.push([xs[j], xs[j + 1]]);

  _spanCache.set(key, out);
  return out;
}

/* ==========================================================================
   宽高比
   ========================================================================== */

/**
 * 计算一张照片的「显示宽高比」。
 *
 * @param {number} index 在播放顺序中的下标（用于合成模式下的确定性随机）
 * @param {{w?:number,h?:number,naturalWidth?:number,naturalHeight?:number}|null} photo
 * @param {{useNativeAspect?:boolean, aspectRange?:number[]}} [opts]
 * @returns {number} 已夹到 ASPECT_CLAMP 区间的宽高比
 */
export function aspectFor(index, photo, opts) {
  const o = opts || {};
  const useNative = o.useNativeAspect !== false;   // 默认 true
  const range = o.aspectRange || [0.66, 1.46];

  if (useNative && photo) {
    const w = photo.w || photo.naturalWidth || 0;
    const h = photo.h || photo.naturalHeight || 0;
    if (w > 0 && h > 0) {
      return clamp(w / h, ASPECT_CLAMP[0], ASPECT_CLAMP[1]);
    }
  }

  // 合成模式：确定性伪随机 + 三角分布，复现样片那种参差的照片墙质感
  const t = hashTri(index, 17);
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  return clamp(lo + t * (hi - lo), ASPECT_CLAMP[0], ASPECT_CLAMP[1]);
}

/* ==========================================================================
   核心：心形 justify 排布
   ========================================================================== */

/**
 * 把 n 张照片排进一个心形。
 *
 * 算法（对应 docs/architecture.md §3 与 visual-spec.md §3）：
 *   1. 心形包围盒：高度先决，宽度兜底（窄屏时才由 maxWidthRatio 接管）
 *   2. 面积守恒闭式解：N·ā·h² = W̄·H ⇒ h = √(W̄·H / (N·ā))，R = heartH / h
 *   3. 按段宽比例分配张数，收敛到恰好 n 张
 *   4. 底部收口约束：最后三行 ≥3 / ≥2 / =1，避免细长尾巴
 *   5. 二分校正基准行高，使 Σ行高 + 行缝 = heartH
 *   6. 逐段 justify：格宽 = aspect × 行高，余量匀到间隙（不拉伸变形）
 *
 * @param {number} n 照片数（1–200）
 * @param {number} W 画面宽 px
 * @param {number} H 画面高 px
 * @param {number[]} aspects 每张照片的显示宽高比，顺序即播放顺序
 * @param {object} [heartCfg] 心形参数，缺省用 HEART_DEFAULTS
 * @returns {{
 *   cells: Array<{x:number,y:number,w:number,h:number,aspect:number,row:number,notch:boolean}>,
 *   heartW:number, heartH:number, left:number, top:number,
 *   rowH:number, rows:number, rowHint:number, counts:number[],
 *   maxShrink:number, vGap:number, meanAspect:number
 * }}
 */
export function layoutHeart(n, W, H, aspects, heartCfg) {
  const cfg = Object.assign({}, HEART_DEFAULTS, heartCfg || {});

  /* ---- 1. 心形包围盒：高度先决，宽度兜底 ---- */
  let heartH = H * cfg.heightRatio;
  let heartW = heartH * cfg.widen / HEART_ASPECT;

  const maxW = W * cfg.maxWidthRatio;
  if (heartW > maxW) {
    heartW = maxW;
    heartH = heartW * HEART_ASPECT / cfg.widen;
  }

  const left = W / 2 - heartW / 2;
  const top = H * cfg.centerY - heartH / 2;

  /* ---- 2. 平均宽高比 ---- */
  let meanA = 0;
  for (let i = 0; i < n; i++) meanA += aspects[i];
  meanA /= Math.max(n, 1);

  /* ---- 3. 按行数 R 构造行分段（含顶部凹口取样覆盖）---- */
  function buildSegs(R) {
    const rowH = heartH / R;
    const segs = [];

    // 统计有多少行落在凹口区内
    let notchRows = 0;
    for (let q = 0; q < R; q++) {
      if ((q + 0.5) / R <= NOTCH_D * NOTCH_ROWH) notchRows++;
    }

    for (let r = 0; r < R; r++) {
      const dCenter = (r + 0.5) / R;
      let d = dCenter;

      // 凹口行：在凹口区上部取样，把缺口还原成明确的 V 形
      // （若直接用 dCenter，顶行缺口只有 2~5%，顶部会渲成一条平线）
      if (notchRows > 0 && dCenter <= NOTCH_D * NOTCH_ROWH) {
        const frac = (r + 0.5) / notchRows;
        d = NOTCH_D * frac * NOTCH_ROWH;
      }

      const sps = spansAtDepth(d);
      for (let s = 0; s < sps.length; s++) {
        const x0 = left + ((sps[s][0] + 16) / HEART_CURVE_W) * heartW;
        const x1 = left + ((sps[s][1] + 16) / HEART_CURVE_W) * heartW;
        segs.push({
          row: r,
          yc: top + (r + 0.5) * rowH,
          x0: x0,
          w: x1 - x0,
          notch: sps.length > 1
        });
      }
    }
    return { segs: segs, rowH: rowH };
  }

  /* ---- 4. 面积守恒闭式解求行高 → 行数 ---- */
  const PROBE_R = 12;
  const probe = buildSegs(PROBE_R);
  let sumW = 0;
  for (let p = 0; p < probe.segs.length; p++) sumW += probe.segs[p].w;
  const meanSegW = sumW / PROBE_R;                      // 平均每行分段总宽

  const rowH0 = Math.sqrt(meanSegW * heartH / (Math.max(n, 1) * meanA));
  const R0 = heartH / rowH0;

  /* 行数求解分两步，顺序不能反：
       ① 先按各自原来的语义求「候选行数」
       ② 再统一钳到「几何可实现」的范围 —— 两条分支都必须过这一道

     为什么两条分支都要钳：行数一旦超过照片数能填满的段数，就会有段落分不到照片，
     求和时读到 aspects[] 的 undefined 值 → 行高 NaN → 卡片坐标为 NaN →
     浏览器直接不渲染那张卡（照片凭空消失，且控制台一行错都不报）。

     ⚠️ forceRows: null 这条分支尤其容易漏：它走的是 clamp(rowHint, minRows=7, maxRows)，
     minRows 是硬下限，1 张照片也会被顶到 7 行。minRows 是业务偏好，
     不能突破 n 和 cap 这两道物理约束 —— 后者优先。

     钳制不会影响正常场景：n=41/forceRows=8 → cap=min(13,32)=32 → R=8，行为不变。 */
  /* 行数自适应：forceRows 传 0 或不传时，按张数推算。
     别再靠 meanA 推了 —— 那套算法遇到横图会算出 1 行，21 张照片全挤成一排溢出画面。
     经验公式 rows ≈ round(sqrt(n × 1.6))：21 张→6 行、41 张→8 行，两个已验证值都命中。
     不走 minRows 硬下限：张数少时就是要少几行才排得密实。 */
  const autoRows = Math.round(Math.sqrt(Math.max(1, n) * 1.6));
  const useForce = (typeof cfg.forceRows === 'number' && cfg.forceRows > 0);
  const candidate = useForce
    ? cfg.forceRows
    : Math.min(Math.max(autoRows, 3), cfg.maxRows);

  const cap = Math.max(1, Math.min(cfg.maxRows, Math.floor(n * 0.8)));
  const R = Math.max(1, Math.min(candidate, n, cap));

  const built = buildSegs(R);
  const segs = built.segs;
  let rowH = built.rowH;

  /* ---- 5. 分配每段照片数（按段宽比例，再收敛到恰好 n 张）---- */
  let gap = rowH * cfg.gapRatio;
  const unit = meanA * rowH + gap;

  const cnt = [];
  for (let c = 0; c < segs.length; c++) {
    cnt.push(Math.max(1, Math.round((segs[c].w + gap) / unit)));
  }

  let total = 0;
  for (let t2 = 0; t2 < cnt.length; t2++) total += cnt[t2];

  /** 该段在给定张数下的填充质量（越接近 0 越好；溢出重罚） */
  function fillQuality(segW, k) {
    let natural = 0;
    for (let q = 0; q < k; q++) natural += aspects[q] * rowH;
    const used = natural + gap * (k - 1);
    const slack = segW - used;
    if (slack < 0) return 1e6 - slack;
    return Math.abs(Math.log(Math.max(slack, 1e-3) / (meanA * rowH)));
  }

  let guard = 0;
  while (total !== n && guard++ < 9000) {
    let bi = -1;
    let bv = Infinity;
    for (let s2 = 0; s2 < segs.length; s2++) {
      if (total < n) {
        const e1 = fillQuality(segs[s2].w, cnt[s2] + 1);
        if (e1 < bv) { bv = e1; bi = s2; }
      } else if (cnt[s2] > 1) {
        const e2 = fillQuality(segs[s2].w, cnt[s2] - 1) + 0.5;
        if (e2 < bv) { bv = e2; bi = s2; }
      }
    }
    if (bi < 0) break;
    if (total < n) { cnt[bi]++; total++; } else { cnt[bi]--; total--; }
  }

  /* ---- 6. 底部收口约束 ----
     纯按面积分配时，心形尖底那两行常常各只剩 1 张，渲出来是一条细长的
     垂直尾巴（"冰淇淋滴下来的尖"），完全不像心。样片底部是
     「宽 → 稍窄 → 更窄 → 尖」的渐进收口（约 5,3,2,1）。
     故对最后三行设下限：倒数第三 ≥3、倒数第二 ≥2、最后 =1，
     不足的部分从中间最宽的行借一张（借出方保证仍 ≥3 张），总数守恒。 */
  (function enforceTaper() {
    const rows = [];
    for (let i = 0; i < segs.length; i++) {
      if (!rows.length || rows[rows.length - 1].row !== segs[i].row) {
        rows.push({ row: segs[i].row, segs: [i] });
      } else {
        rows[rows.length - 1].segs.push(i);
      }
    }
    if (rows.length < 4) return;

    const minTail = [3, 2, 1];
    for (let t = 0; t < minTail.length; t++) {
      const ri = rows.length - minTail.length + t;
      if (ri < 0) break;

      const need = minTail[t];
      let have = 0;
      for (let a = 0; a < rows[ri].segs.length; a++) have += cnt[rows[ri].segs[a]];
      if (have >= need) continue;

      let spin = 0;
      while (have < need && spin++ < 200) {
        let bi2 = -1;
        let bv2 = 2;                                  // 借出行至少要有 3 张
        for (let j = 0; j < rows.length; j++) {
          if (j === ri) continue;
          let jk = 0;
          for (let b = 0; b < rows[j].segs.length; b++) jk += cnt[rows[j].segs[b]];
          if (jk > bv2) { bv2 = jk; bi2 = j; }
        }
        if (bi2 < 0) break;

        const donorSeg = rows[bi2].segs[rows[bi2].segs.length - 1];
        if (cnt[donorSeg] <= 1) break;

        cnt[donorSeg]--;
        cnt[rows[ri].segs[rows[ri].segs.length - 1]]++;
        have++;
      }
    }
  })();

  /* ---- 7. 校正行高 ----
     面积守恒给出的是"平均行高"。心形尖底那几行受可用宽度限制，实际行高会
     低于平均值，导致各行高之和 < 心形总高，底部留空洞。
     由于"各行高之和"随基准行高单调不减，用二分法即可求到填满心形的基准行高。 */
  function rowHeightsFor(baseRowH) {
    // 横向间隙按心形高度给一个稳定的绝对值，避免随 baseRowH 一起膨胀。
    // 注意：这里故意不用 cfg.gapRatio * baseRowH —— 否则二分过程中间隙会跟着放大，
    // 收敛目标随之漂移。这是刻意解耦，不是笔误。
    const g = heartH * 0.0045;
    const segRows = [];
    let startA = 0;

    for (let si = 0; si < segs.length; si++) {
      const k = cnt[si];
      let sa = 0;
      for (let q2 = 0; q2 < k; q2++) {
        // 越界跳过：钳制后不应发生，但绝不让 undefined 参与求和（会产生 NaN 并让卡片消失）
        const av = aspects[startA + q2];
        if (typeof av === 'number' && isFinite(av)) sa += av;
      }
      startA += k;
      if (sa <= 0) { segRows.push(baseRowH); continue; }

      const hFit = (segs[si].w - g * (k - 1)) / sa;
      // 上限 = 基准行高（不允许比平均还高）；下限防止退化成一条线
      segRows.push(clamp(hFit, baseRowH * 0.10, baseRowH));
    }

    // 同一横带（顶部凹口拆成两段）必须等高，否则左右两叶高低不齐
    const rowMin = {};
    for (let si2 = 0; si2 < segs.length; si2++) {
      const lbl = segs[si2].row;
      rowMin[lbl] = (rowMin[lbl] === undefined) ? segRows[si2] : Math.min(rowMin[lbl], segRows[si2]);
    }
    for (let si3 = 0; si3 < segs.length; si3++) segRows[si3] = rowMin[segs[si3].row];

    let totalH = 0;
    let nRows = 0;
    for (const key in rowMin) {
      if (Object.prototype.hasOwnProperty.call(rowMin, key)) { totalH += rowMin[key]; nRows++; }
    }
    return { segRows: segRows, totalH: totalH, nRows: nRows };
  }

  const solved = rowHeightsFor(rowH);
  let bestRowH = rowH;
  let bestSolved = solved;
  let bestErr = Math.abs(solved.totalH - heartH);

  if (solved.totalH < heartH) {
    let lo = rowH;
    let hi = rowH * 6;
    for (let it = 0; it < 48; it++) {
      const mid = (lo + hi) / 2;
      const s = rowHeightsFor(mid);
      const err = Math.abs(s.totalH - heartH);
      if (err < bestErr) { bestErr = err; bestRowH = mid; bestSolved = s; }
      if (err < heartH * 0.0012) break;
      if (s.totalH < heartH) lo = mid; else hi = mid;
    }
  }

  const segHeights = bestSolved.segRows;
  const nDistinct = bestSolved.nRows;

  /* ---- 8. 归一化：让「各行高之和 + 行间缝」精确等于心形高度 ----
     行缝 = 平均行高 × rowGapRatio = (totalH / n) × ratio，
     故占用高度 = totalH × (1 + ratio·(n-1)/n)，与 totalH 成正比 → 可解析求解。 */
  const rowGapRatio = cfg.rowGapRatio;
  const gapFactor = 1 + (nDistinct > 1 ? rowGapRatio * (nDistinct - 1) / nDistinct : 0);
  const targetTotalH = heartH / gapFactor;

  if (bestSolved.totalH > 0) {
    const fitScale = targetTotalH / bestSolved.totalH;
    // 只在偏差不大时校正，避免极端情况下破坏排布
    if (Math.abs(fitScale - 1) < 0.30) {
      for (let sc2 = 0; sc2 < segHeights.length; sc2++) segHeights[sc2] *= fitScale;
      bestSolved.totalH = targetTotalH;
    }
  }

  const meanActualH = bestSolved.totalH / Math.max(nDistinct, 1);
  const vGap = meanActualH * rowGapRatio;
  rowH = meanActualH;

  /* ---- 9. 逐段 justify（行高统一，绝不拉伸变形）---- */
  const cells = [];

  /* ---- 9.5 智能发牌：让每一段都拿到「横竖混合」的照片组 ----
     段宽是按平均宽高比 meanA 估算的 —— 所以每个段需要的不是"更宽的照片"，
     而是"平均比例 ≈ meanA 的一手牌"。横竖混发时按顺序发会导致
     有的段拿一手横图（溢出）、有的段拿一手竖图（稀疏），心形轮廓参差
     （实测：不规整）。
     现把照片按 aspect 排序后「蛇形洗牌」（最宽、最窄、次宽、次窄…交替），
     再按段宽降序发牌 —— 每一段拿到的组合平均都 ≈ meanA，行行刚好填满；
     段内仍保持用户列表顺序。 */
  const deal = [];
  for (let s = 0; s < segs.length; s++) deal.push([]);
  {
    const segOrder = [];
    for (let s = 0; s < segs.length; s++) segOrder.push(s);
    segOrder.sort((a, b) => segs[b].w - segs[a].w);
    const deck = [];
    for (let i = 0; i < n; i++) deck.push(i);
    deck.sort((a, b) => (aspects[a] || 0) - (aspects[b] || 0));
    const alt = [];
    let lo = 0, hi = deck.length - 1, takeLo = true;
    while (lo <= hi) { alt.push(takeLo ? deck[lo++] : deck[hi--]); takeLo = !takeLo; }
    let dp = 0;
    for (const si of segOrder) {
      for (let k = 0; k < cnt[si] && dp < n; k++) deal[si].push(alt[dp++]);
      deal[si].sort((a, b) => a - b);   // 段内保持用户列表顺序
    }
  }

  let cursorY = top;
  let prevLabel = null;
  let maxShrink = 0;

  for (let s4 = 0; s4 < segs.length; s4++) {
    const seg = segs[s4];
    const k4 = deal[s4].length;
    if (k4 <= 0) continue;

    if (prevLabel !== null && seg.row !== prevLabel) cursorY += vGap;
    prevLabel = seg.row;

    const hRow = segHeights[s4];
    if (hRow < rowH * 0.995) maxShrink = Math.max(maxShrink, 1 - hRow / rowH);

    let sa2 = 0;
    for (let q4 = 0; q4 < k4; q4++) {
      const av = aspects[deal[s4][q4]];
      if (typeof av === 'number' && isFinite(av)) sa2 += av;
    }

    const sumWid = hRow * sa2;
    let actualGap = (k4 > 1) ? (seg.w - sumWid) / (k4 - 1) : 0;
    let overflow = 0;
    if (actualGap < 0) { overflow = -actualGap * (k4 - 1); actualGap = 0; }

    /* 溢出兜底：智能发牌后极少发生，但万一该行总宽仍超出段宽，
       整行以段中轴对称摆放（两端各凸出一半），比单侧凸出自然得多 */
    let x = seg.x0;
    if (overflow > 0) x = seg.x0 - overflow / 2;
    for (let g4 = 0; g4 < k4; g4++) {
      const av = aspects[deal[s4][g4]];
      const safeAspect = (typeof av === 'number' && isFinite(av) && av > 0) ? av : meanA;
      const cw = safeAspect * hRow;
      cells.push({
        x: x,
        y: cursorY,
        w: cw,
        h: hRow,
        aspect: safeAspect,
        row: seg.row,
        notch: seg.notch,
        photo: deal[s4][g4]
      });
      x += cw + actualGap;
    }

    // 凹口行两段共用同一条横带，只有最后一段推进 y
    const nextSame = (s4 + 1 < segs.length) && (segs[s4 + 1].row === seg.row);
    if (!nextSame) cursorY += hRow;
  }

  /* ---- 10. 兜底：非有限坐标绝不允许流出本函数 ----
     钳制下理论上不会发生，但这一道很便宜：一旦漏出去，
     浏览器对该卡静默不渲染，照片凭空消失且没有任何报错，现场极难定位。
     宁可行数不符合预期，也不能丢照片。 */
  let allFinite = true;
  for (let f = 0; f < cells.length; f++) {
    const c = cells[f];
    if (!isFinite(c.x) || !isFinite(c.y) || !isFinite(c.w) || !isFinite(c.h)) {
      allFinite = false;
      break;
    }
  }

  if (!allFinite && !cfg._retried) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[heart] 布局产出非有限坐标，回退到安全行数重算');
    }
    // 安全行数：保证段数不超过照片数
    const safeR = Math.max(1, Math.min(n, Math.floor(n / 2)));
    return layoutHeart(n, W, H, aspects, Object.assign({}, cfg, {
      forceRows: safeR,
      _retried: true
    }));
  }

  /* 智能发牌后格子与照片不再一一对应：order[photoIndex] = cellIndex，
     播放端用它把每张照片关联到自己的格子 */
  const order = new Array(cells.length);
  for (let k = 0; k < cells.length; k++) order[cells[k].photo] = k;

  return {
    cells: cells,
    order: order,
    heartW: heartW,
    heartH: heartH,
    left: left,
    top: top,
    rowH: rowH,
    rows: R,
    rowHint: R0,
    counts: cnt,
    maxShrink: maxShrink,
    vGap: vGap,
    meanAspect: meanA
  };
}
