/**
 * heart.test.mjs —— 心形算法的零框架验收脚本
 * -----------------------------------------------------------------------------
 * 运行：node tests/heart.test.mjs
 * 全绿则退出码 0，任一失败退出码 1。
 *
 * 这是 T01 的硬验收门。心形算法是全项目唯一"算错了肉眼不易发现"的部分
 * （行数、尖底收口、铺满率），所以单独抽出来做断言。
 */

import assert from 'node:assert/strict';
import {
  layoutHeart,
  spansAtDepth,
  cubicBezier,
  aspectFor,
  clamp,
  lerp,
  hash01,
  hashTri,
  HEART_ASPECT,
  ASPECT_CLAMP,
  HEART_DEFAULTS
} from '../public/heart.js';

/* ==========================================================================
   极简测试框架（不引任何依赖）
   ========================================================================== */

let passed = 0;
const failures = [];

/**
 * 跑一个用例。
 * @param {string} name 用例名
 * @param {() => void} fn 断言体
 */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      \x1b[31m' + String(err.message).split('\n').join('\n      ') + '\x1b[0m');
  }
}

/** 分组标题 */
function group(title) {
  console.log('\n\x1b[1m' + title + '\x1b[0m');
}

/** 保留 n 位小数的近似比较，失败时给出直观差值 */
function near(actual, expected, tol, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || ''} 期望 ${expected} ±${tol}，实际 ${actual}（差 ${(actual - expected).toFixed(5)}）`
  );
}

/* ==========================================================================
   测试夹具
   ========================================================================== */

/**
 * 合成 41 张照片的宽高比序列。
 * 用与生产同源的 aspectFor（useNativeAspect=false），保证 fixture 可复现。
 * 三角分布均值 ≈ 1.06，与架构文档基准表的前提一致。
 */
function synthAspects(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(aspectFor(i, null, { useNativeAspect: false, aspectRange: [0.66, 1.46] }));
  }
  return out;
}

/** 混合长宽比序列（模拟真实年会照片：竖 3:4 / 横 4:3 / 方 1:1 / 宽 16:9 混排） */
function mixedAspects(n) {
  const pool = [0.75, 0.75, 0.6667, 1.3333, 1.3333, 1.0, 1.7778, 0.8, 1.5];
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
  return out;
}

/** 把 cells 按行聚合，返回每行张数数组 */
function countsByRow(result) {
  const by = {};
  for (const c of result.cells) by[c.row] = (by[c.row] || 0) + 1;
  return Object.keys(by).sort((a, b) => a - b).map((k) => by[k]);
}

/** 取某一行最左到最右的横向跨度 */
function rowSpan(row) {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const c of row) {
    if (c.x < x0) x0 = c.x;
    if (c.x + c.w > x1) x1 = c.x + c.w;
  }
  return { x0, x1, w: x1 - x0 };
}

/* ==========================================================================
   §1 工具函数
   ========================================================================== */

group('工具函数');

test('clamp 边界正确', () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(50, 0, 10), 10);
});

test('lerp 端点与中点正确', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
});

test('hash01 确定性且落在 [0,1)', () => {
  for (let i = 0; i < 500; i++) {
    const v = hash01(i, 13);
    assert.ok(v >= 0 && v < 1, `hash01(${i}) = ${v} 越界`);
    assert.equal(v, hash01(i, 13), 'hash01 不确定');
  }
});

test('hash01 不同 salt 产生不同序列', () => {
  let diff = 0;
  for (let i = 0; i < 50; i++) if (hash01(i, 1) !== hash01(i, 2)) diff++;
  assert.ok(diff > 40, `不同 salt 应有明显差异，实际只差 ${diff}/50`);
});

test('hashTri 落在 [0,1) 且均值接近 0.5', () => {
  let sum = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const v = hashTri(i, 17);
    assert.ok(v >= 0 && v < 1, `hashTri(${i}) = ${v} 越界`);
    sum += v;
  }
  near(sum / N, 0.5, 0.03, 'hashTri 均值');
});

/* ==========================================================================
   §2 缓动（验收标准 8）
   ========================================================================== */

group('cubicBezier 缓动');

const ease = cubicBezier(0.45, 0.05, 0.25, 1);

test('验收 8a：ease(0) === 0', () => {
  assert.equal(ease(0), 0);
});

test('验收 8b：ease(1) === 1', () => {
  assert.equal(ease(1), 1);
});

test('验收 8c：ease 在 [0,1] 单调递增', () => {
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const y = ease(x);
    assert.ok(y > prev, `ease 在 x=${x} 处不递增（${prev} → ${y}）`);
    assert.ok(y >= 0 && y <= 1, `ease(${x}) = ${y} 越界 [0,1]`);
    prev = y;
  }
});

test('ease 越界输入被夹紧（不抛错）', () => {
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
});

/* ==========================================================================
   §3 曲线几何（验收标准 9）
   ========================================================================== */

group('心形曲线几何');

test('验收 9a：spansAtDepth(0.02) 返回 2 段（顶部凹口左右两簇）', () => {
  const sp = spansAtDepth(0.02);
  assert.equal(sp.length, 2, `实际返回 ${sp.length} 段：${JSON.stringify(sp)}`);
  // 两段应关于 x=0 大致对称
  near(sp[0][0], -sp[1][1], 1e-6, '凹口左右对称');
});

test('验收 9b：spansAtDepth(0.9) 返回 1 段（底部收成单段）', () => {
  const sp = spansAtDepth(0.9);
  assert.equal(sp.length, 1, `实际返回 ${sp.length} 段：${JSON.stringify(sp)}`);
});

test('spansAtDepth 区间有效（左 < 右，且落在曲线包围盒内）', () => {
  for (let i = 1; i < 200; i++) {
    const d = i / 200;
    const sp = spansAtDepth(d);
    for (const [x0, x1] of sp) {
      assert.ok(x1 > x0, `d=${d} 区间非法 [${x0}, ${x1}]`);
      assert.ok(x0 >= -16.001 && x1 <= 16.001, `d=${d} 区间越出包围盒 [${x0}, ${x1}]`);
    }
  }
});

test('spansAtDepth 结果稳定（同参数二次调用一致）', () => {
  assert.deepEqual(spansAtDepth(0.123), spansAtDepth(0.123));
});

test('HEART_ASPECT 与曲线包围盒一致', () => {
  near(HEART_ASPECT, 28.9233 / 32, 1e-9, 'HEART_ASPECT');
});

/* ==========================================================================
   §4 宽高比（验收标准 10）
   ========================================================================== */

group('aspectFor 宽高比');

test('验收 10a：useNativeAspect:true 且 photo={w:1200,h:1600} → 0.75', () => {
  const a = aspectFor(0, { w: 1200, h: 1600 }, { useNativeAspect: true });
  assert.equal(a, 0.75);
});

test('验收 10b：缺 photo 时返回 [0.45, 2.2] 区间内的值', () => {
  for (let i = 0; i < 300; i++) {
    const a = aspectFor(i, null, { useNativeAspect: true, aspectRange: [0.66, 1.46] });
    assert.ok(
      a >= ASPECT_CLAMP[0] && a <= ASPECT_CLAMP[1],
      `aspectFor(${i}, null) = ${a} 超出 [${ASPECT_CLAMP}]`
    );
  }
});

test('aspectFor 支持 naturalWidth/naturalHeight 命名', () => {
  const a = aspectFor(0, { naturalWidth: 900, naturalHeight: 1200 }, { useNativeAspect: true });
  assert.equal(a, 0.75);
});

test('aspectFor 极端长宽比被夹到 ASPECT_CLAMP', () => {
  assert.equal(aspectFor(0, { w: 5000, h: 100 }, { useNativeAspect: true }), ASPECT_CLAMP[1]);
  assert.equal(aspectFor(0, { w: 100, h: 5000 }, { useNativeAspect: true }), ASPECT_CLAMP[0]);
});

test('aspectFor 合成模式确定性（同 index 同结果）', () => {
  const a = aspectFor(7, null, { useNativeAspect: false, aspectRange: [0.66, 1.46] });
  const b = aspectFor(7, null, { useNativeAspect: false, aspectRange: [0.66, 1.46] });
  assert.equal(a, b);
});

/* ==========================================================================
   §5 布局：16:9 主场景（验收标准 1–4）
   ========================================================================== */

group('layoutHeart · 41 张 @ 1920×1080');

const synth41 = synthAspects(41);
const L41 = layoutHeart(41, 1920, 1080, synth41);

test('验收 1：rows === 8', () => {
  assert.equal(L41.rows, 8, `实际 ${L41.rows}（rowHint=${L41.rowHint.toFixed(3)}）`);
});

test('验收 2：heartW / 1920 ≈ 0.554（心形占画面宽 55.4%）', () => {
  near(L41.heartW / 1920, 0.554, 0.01, 'heartW/W');
});

test('heartH / 1080 ≈ 0.856（心形占画面高 85.6%）', () => {
  near(L41.heartH / 1080, 0.856, 0.01, 'heartH/H');
});

test('验收 3a：cells.length === 41', () => {
  assert.equal(L41.cells.length, 41);
});

test('验收 3b：cells 按行号单调不减', () => {
  for (let i = 1; i < L41.cells.length; i++) {
    assert.ok(
      L41.cells[i].row >= L41.cells[i - 1].row,
      `第 ${i} 格行号回退：${L41.cells[i - 1].row} → ${L41.cells[i].row}`
    );
  }
});

test('验收 4a：cells[0].row === 0', () => {
  assert.equal(L41.cells[0].row, 0);
});

test('验收 4b：末位格 row === rows - 1', () => {
  assert.equal(L41.cells[L41.cells.length - 1].row, L41.rows - 1);
});

test('验收 4c：末行格数 === 1（尖底）', () => {
  const counts = countsByRow(L41);
  assert.equal(counts[counts.length - 1], 1, `末行 ${counts[counts.length - 1]} 张`);
});

test('基准表：每行张数 = 6,7,8,7,6,4,2,1', () => {
  assert.deepEqual(countsByRow(L41), [6, 7, 8, 7, 6, 4, 2, 1]);
});

test('契约：每格 aspect 严格等于其照片的宽高比（经发牌映射 photo）', () => {
  for (let i = 0; i < L41.cells.length; i++) {
    const c = L41.cells[i];
    assert.equal(c.aspect, synth41[c.photo], `第 ${i} 格（照片 ${c.photo}）宽高比错位`);
  }
  // 发牌映射本身必须完备：41 个格子恰好对应 41 张照片，无一重复
  const seen = new Set(L41.cells.map((c) => c.photo));
  assert.equal(seen.size, 41);
});

test('契约：每格 w/h 精确等于该照片的宽高比（不拉伸变形）', () => {
  for (let i = 0; i < L41.cells.length; i++) {
    const c = L41.cells[i];
    near(c.w / c.h, c.aspect, 1e-6, `第 ${i} 格 w/h`);
  }
});

test('心形铺满高度：末行底边 ≈ 心形底边', () => {
  const bottom = Math.max(...L41.cells.map((c) => c.y + c.h));
  near(bottom / (L41.top + L41.heartH), 1.0, 0.02, '竖向铺满率');
});

test('所有格子落在心形包围盒内（不溢出）', () => {
  for (const c of L41.cells) {
    assert.ok(c.x >= L41.left - 1, `格子 x=${c.x} 越出左边界 ${L41.left}`);
    assert.ok(c.x + c.w <= L41.left + L41.heartW + 1, `格子右缘越界`);
    assert.ok(c.y >= L41.top - 1, `格子 y=${c.y} 越出上边界`);
    assert.ok(c.y + c.h <= L41.top + L41.heartH + 1.5, `格子底边越界`);
  }
});

/* ==========================================================================
   §6 布局：其他分辨率与宽高比
   ========================================================================== */

group('layoutHeart · 分辨率与宽高比');

test('验收 1（复验）：3840×2160 也是 8 行、55.4% 宽（面积守恒与尺度无关）', () => {
  const L = layoutHeart(41, 3840, 2160, synth41);
  assert.equal(L.rows, 8);
  near(L.heartW / 3840, 0.554, 0.01, '4K heartW/W');
  assert.deepEqual(countsByRow(L), [6, 7, 8, 7, 6, 4, 2, 1]);
});

test('验收 5：1440×1080（4:3）→ heartW/1440 ≈ 0.7387，且仍由高度先决', () => {
  const L = layoutHeart(41, 1440, 1080, synth41);
  near(L.heartW / 1440, 0.7387, 0.01, '4:3 heartW/W');
  near(L.heartH / 1080, 0.856, 0.01, '4:3 heartH/H（未触发宽度上限）');
  assert.equal(L.rows, 8);
});

test('验收 6：1200×1080（宽高比 1.111 < 1.2311）→ 宽度接管，heartW/1200 = 0.80', () => {
  const L = layoutHeart(41, 1200, 1080, synth41);
  near(L.heartW / 1200, 0.80, 0.01, '窄屏 heartW/W');
  assert.ok(L.heartH / 1080 < 0.856, '宽度接管后心形应变矮（高度不再是 85.6%）');
});

test('验收 7：n ∈ {41,60,80,100} → cells.length === n 且 rows ∈ [7,13]', () => {
  for (const n of [41, 60, 80, 100]) {
    const L = layoutHeart(n, 1920, 1080, synthAspects(n));
    assert.equal(L.cells.length, n, `n=${n} 时 cell 数 ${L.cells.length}`);
    assert.ok(L.rows >= 7 && L.rows <= 13, `n=${n} 时行数 ${L.rows} 越界 [7,13]`);
  }
});

test('行数随张数单调不减（41→100）', () => {
  let prev = 0;
  for (const n of [41, 60, 80, 100]) {
    const L = layoutHeart(n, 1920, 1080, synthAspects(n));
    assert.ok(L.rows >= prev, `n=${n} 行数 ${L.rows} 少于更少张数时的 ${prev}`);
    prev = L.rows;
  }
});

test('张数极少（3 张）不崩，且仍满足 cells.length === n', () => {
  const L = layoutHeart(3, 1920, 1080, synthAspects(3));
  assert.equal(L.cells.length, 3);
  assert.ok(L.rows >= 1);
});

test('100 张（auto 模式）：末行仍为 1 张，且尾部无连续两个 1', () => {
  // 显式走 auto 分支：默认 forceRows=8 时 100 张会挤在 8 行里，末行不是 1 张
  const L = layoutHeart(100, 1920, 1080, synthAspects(100),
    Object.assign({}, HEART_DEFAULTS, { forceRows: null }));
  const counts = countsByRow(L);
  assert.equal(counts[counts.length - 1], 1);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(!(counts[i] === 1 && counts[i - 1] === 1), `第 ${i - 1}/${i} 行连续为 1 张`);
  }
});

/* ==========================================================================
   §7 底部收口与凹口
   ========================================================================== */

group('形状特征');

test('底部收口（auto 模式）：最后三行不低于 3 / 2 / 1', () => {
  for (const n of [41, 55, 60, 80, 100]) {
    const L = layoutHeart(n, 1920, 1080, synthAspects(n),
      Object.assign({}, HEART_DEFAULTS, { forceRows: null }));
    const c = countsByRow(L);
    if (c.length < 3) continue;
    const tail = c.slice(-3);
    assert.ok(tail[0] >= 3, `n=${n} 倒数第三行仅 ${tail[0]} 张`);
    assert.ok(tail[1] >= 2, `n=${n} 倒数第二行仅 ${tail[1]} 张`);
    assert.equal(tail[2], 1, `n=${n} 末行 ${tail[2]} 张`);
  }
});

test('底部收口（默认 8 行）：41 张尾部仍是 4,2,1', () => {
  const L = layoutHeart(41, 1920, 1080, synth41);
  const c = countsByRow(L);
  assert.deepEqual(c.slice(-3), [4, 2, 1], `实际尾部 ${c.slice(-3).join(',')}`);
});

test('顶部凹口：首行分成 2 段，且缺口宽度 ≥ 心形宽 10%', () => {
  const L = layoutHeart(41, 1920, 1080, synth41);
  const row0 = L.cells.filter((c) => c.row === 0).sort((a, b) => a.x - b.x);
  assert.equal(row0[0].notch, true, '首行未标记为凹口行');

  let maxGap = 0;
  for (let i = 1; i < row0.length; i++) {
    const g = row0[i].x - (row0[i - 1].x + row0[i - 1].w);
    if (g > maxGap) maxGap = g;
  }
  assert.ok(
    maxGap >= L.heartW * 0.10,
    `顶部缺口仅 ${maxGap.toFixed(1)}px = ${(maxGap / L.heartW * 100).toFixed(1)}% 心形宽，太小会读成平顶`
  );
});

test('顶部凹口：深度约 1 个行高（12% 左右，不是 25%）', () => {
  const L = layoutHeart(41, 1920, 1080, synth41);

  /* 注意：不能简单数 `notch === true` 的行。
     第 1 行的两个分段缺口只有约 2.6% 心形宽 —— 数学上确实是两段，
     但视觉上完全闭合，不算凹口。必须按「缺口宽度 ≥ 10% 心形宽」判定。 */
  const byRow = {};
  for (const c of L.cells) (byRow[c.row] = byRow[c.row] || []).push(c);

  const rowIndices = Object.keys(byRow).sort((a, b) => a - b);
  let deepestNotchRow = -1;

  for (const r of rowIndices) {
    const row = byRow[r].sort((a, b) => a.x - b.x);
    let maxGap = 0;
    for (let i = 1; i < row.length; i++) {
      const g = row[i].x - (row[i - 1].x + row[i - 1].w);
      if (g > maxGap) maxGap = g;
    }
    if (maxGap >= L.heartW * 0.10) deepestNotchRow = Number(r);
  }

  assert.ok(deepestNotchRow >= 0, '未检测到任何宽度 ≥10% 心形宽的中央缺口');
  const depth = (deepestNotchRow + 1) / L.rows;    // 缺口延伸到该行底部
  assert.ok(
    depth >= 0.10 && depth <= 0.17,
    `凹口深度 ${(depth * 100).toFixed(1)}% 心形高（到第 ${deepestNotchRow} 行），应在 10~17%`
  );
});

test('同一行的两个分段等高（凹口左右两叶不歪）', () => {
  const L = layoutHeart(41, 1920, 1080, synth41);
  const byRow = {};
  for (const c of L.cells) (byRow[c.row] = byRow[c.row] || []).push(c);
  for (const r of Object.keys(byRow)) {
    const hs = new Set(byRow[r].map((c) => c.h.toFixed(4)));
    assert.equal(hs.size, 1, `第 ${r} 行存在不同行高：${[...hs].join(', ')}`);
  }
});

test('行与行之间无重叠（上一行底 ≤ 下一行顶）', () => {
  const L = layoutHeart(41, 1920, 1080, synth41);
  const byRow = {};
  for (const c of L.cells) (byRow[c.row] = byRow[c.row] || []).push(c);
  const keys = Object.keys(byRow).sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) {
    const prevBottom = Math.max(...byRow[keys[i - 1]].map((c) => c.y + c.h));
    const curTop = Math.min(...byRow[keys[i]].map((c) => c.y));
    assert.ok(prevBottom <= curTop + 0.5, `第 ${keys[i - 1]} 行与第 ${keys[i]} 行重叠 ${(prevBottom - curTop).toFixed(1)}px`);
  }
});

/* ==========================================================================
   §8 forceRows 后门与配置覆盖
   ========================================================================== */

group('配置覆盖与 forceRows');

test('forceRows 可钉死行数', () => {
  for (const r of [8, 9, 10, 12]) {
    const L = layoutHeart(41, 1920, 1080, synth41, Object.assign({}, HEART_DEFAULTS, { forceRows: r }));
    assert.equal(L.rows, r, `forceRows=${r} 却得到 ${L.rows} 行`);
    assert.equal(L.cells.length, 41, `forceRows=${r} 时丢照片`);
  }
});

test('heartCfg 不污染模块默认值（无全局状态）', () => {
  layoutHeart(41, 1920, 1080, synth41, Object.assign({}, HEART_DEFAULTS, { heightRatio: 0.5, forceRows: 12 }));
  const again = layoutHeart(41, 1920, 1080, synth41);
  assert.equal(again.rows, 8, '第二次调用被上一次的 cfg 污染了');
  near(again.heartH / 1080, 0.856, 0.01, '默认 heightRatio 未被污染');
});

test('缺省 heartCfg 等价于传 HEART_DEFAULTS', () => {
  const a = layoutHeart(41, 1920, 1080, synth41);
  const b = layoutHeart(41, 1920, 1080, synth41, HEART_DEFAULTS);
  assert.equal(a.rows, b.rows);
  near(a.heartW, b.heartW, 1e-9, 'heartW');
});

test('heightRatio 可调（0.70 → 心形变矮）', () => {
  const L = layoutHeart(41, 1920, 1080, synth41, Object.assign({}, HEART_DEFAULTS, { heightRatio: 0.70 }));
  near(L.heartH / 1080, 0.70, 0.005, 'heightRatio=0.70 生效');
});

test('centerY 可调（0.40 → 整体上移）', () => {
  const a = layoutHeart(41, 1920, 1080, synth41);
  const b = layoutHeart(41, 1920, 1080, synth41, Object.assign({}, HEART_DEFAULTS, { centerY: 0.40 }));
  assert.ok(b.top < a.top, 'centerY 调小后心形未上移');
});

/* ==========================================================================
   §9 混合长宽比（真实年会照片场景）
   ========================================================================== */

group('混合长宽比（useNativeAspect:true 的正式场景）');

test('混合比 41 张：仍是 8 行，且每张都保住自身比例', () => {
  const asp = mixedAspects(41);
  const L = layoutHeart(41, 1920, 1080, asp);
  assert.equal(L.rows, 8);
  assert.equal(L.cells.length, 41);
  for (let i = 0; i < 41; i++) {
    const c = L.cells[i];
    near(c.w / c.h, asp[c.photo], 1e-6, `混合比第 ${i} 格（照片 ${c.photo}）`);
  }
});

test('混合比下格宽参差（这正是改用真实比例的收益）', () => {
  const L = layoutHeart(41, 1920, 1080, mixedAspects(41));
  const widths = L.cells.filter((c) => c.row === 2).map((c) => c.w);
  const spread = Math.max(...widths) - Math.min(...widths);
  assert.ok(spread > 10, `第 2 行格宽极差仅 ${spread.toFixed(1)}px，照片墙不够参差`);
});

test('全部 1:1 方图时退化为规整网格（已知行为，不是 bug）', () => {
  const square = new Array(41).fill(1.0);
  const L = layoutHeart(41, 1920, 1080, square);
  const widths = L.cells.filter((c) => c.row === 2).map((c) => c.w);
  const spread = Math.max(...widths) - Math.min(...widths);
  assert.ok(spread < 1, `方图不应出现格宽差异，实际极差 ${spread}`);
});

/* ==========================================================================
   §10 行数钳制（forceRows 与极小 n 的几何可实现性）
   --------------------------------------------------------------------------
   背景：行数一旦超过「照片数能填满的段数」，就会有段落分不到照片，
   求和时读到 aspects[] 的 undefined → 行高 NaN → 卡片坐标 NaN →
   浏览器直接不渲染那张卡（照片凭空消失，且控制台一行错都不报）。

   两条分支都会中招：
     · forceRows: 8 且照片不足 10 张
     · forceRows: null 时 minRows=7 是硬下限，1 张照片也被顶到 7 行
   ========================================================================== */

group('行数钳制 · 回归锚点');

/** 判断结果里有没有非有限坐标（NaN / Infinity 都会让卡片消失） */
function countBadCells(L) {
  let bad = 0;
  for (const c of L.cells) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)
        || !Number.isFinite(c.w) || !Number.isFinite(c.h)) bad++;
  }
  return bad;
}

/** 用指定行数跑一次 41 张（合成比 fixture），返回结果 */
function run(forceRows, n) {
  return layoutHeart(n, 1920, 1080, synthAspects(n),
    Object.assign({}, HEART_DEFAULTS, { forceRows: forceRows }));
}

test('锚点：n=41, forceRows=8 → rows=8（目标场景，行为不变）', () => {
  const L = run(8, 41);
  assert.equal(L.rows, 8);
  assert.equal(L.cells.length, 41);
  assert.equal(countBadCells(L), 0);
});

test('锚点：n=41, forceRows=null → rows=8（auto 模式目标场景）', () => {
  const L = run(null, 41);
  assert.equal(L.rows, 8);
  assert.equal(countBadCells(L), 0);
});

test('锚点：n=100, forceRows=8 → rows=8', () => {
  assert.equal(run(8, 100).rows, 8);
});

test('锚点：n=10, forceRows=8 → rows=8', () => {
  assert.equal(run(8, 10).rows, 8);
});

/* 下面四条是钉住 0.8 这个系数的唯一有效位置。
   n ≥ 16 时 floor(0.8n) ≥ 12 > 8，cap 根本不参与，所以 n=41/100 测不出系数被改。 */
test('锚点：n=9, forceRows=8 → rows=7（cap 生效第一点，钉住 0.8 系数）', () => {
  assert.equal(run(8, 9).rows, 7);
});

test('锚点：n=6, forceRows=8 → rows=4（钉住 0.8 系数）', () => {
  assert.equal(run(8, 6).rows, 4);
});

test('锚点：n=3, forceRows=8 → rows=2（钉住 0.8 系数）', () => {
  assert.equal(run(8, 3).rows, 2);
});

test('锚点：n=1, forceRows=8 → rows=1，唯一一张不消失', () => {
  const L = run(8, 1);
  assert.equal(L.rows, 1);
  assert.equal(L.cells.length, 1);
  assert.equal(countBadCells(L), 0);
});

test('锚点：n=41, forceRows=40 → 被 maxRows 收到 13', () => {
  assert.equal(run(40, 41).rows, 13);
});

test('锚点：n=41, forceRows=14 → 被 maxRows 收到 13', () => {
  assert.equal(run(14, 41).rows, 13);
});

test('锚点：n=8, forceRows=null → 零坏格（原先崩 6 格）', () => {
  const L = run(null, 8);
  assert.equal(countBadCells(L), 0, `n=8 仍有 ${countBadCells(L)} 个坏格`);
  assert.equal(L.cells.length, 8);
});

test('锚点：n=6, forceRows=null → 零坏格（原先崩 4 格）', () => {
  const L = run(null, 6);
  assert.equal(countBadCells(L), 0);
  assert.equal(L.cells.length, 6);
});

group('行数钳制 · 全参数空间扫描（不抽样）');

test('n ∈ [1,120] × forceRows ∈ {null,1..40} 共 4920 组合：零坏格、张数守恒、不抛异常', () => {
  const failures = [];

  for (let n = 1; n <= 120; n++) {
    // 每个 n 只算一次 aspects，避免重复构造
    const aspects = synthAspects(n);

    for (let fr = 0; fr <= 40; fr++) {
      const forceRows = (fr === 0) ? null : fr;
      let L;

      try {
        L = layoutHeart(n, 1920, 1080, aspects,
          Object.assign({}, HEART_DEFAULTS, { forceRows: forceRows }));
      } catch (err) {
        failures.push(`n=${n} forceRows=${forceRows} 抛出异常：${err.message}`);
        continue;
      }

      if (L.cells.length !== n) {
        failures.push(`n=${n} forceRows=${forceRows} 张数 ${L.cells.length} ≠ ${n}`);
      }
      const bad = countBadCells(L);
      if (bad > 0) {
        failures.push(`n=${n} forceRows=${forceRows} 有 ${bad} 个坏格`);
      }
      if (failures.length > 8) break;
    }
    if (failures.length > 8) break;
  }

  assert.deepEqual(failures, [], '钳制失效：\n' + failures.join('\n'));
});

test('钳制后行数永不超过 maxRows，且永不超过照片数', () => {
  for (let n = 1; n <= 120; n += 7) {
    for (const fr of [null, 4, 8, 14, 40]) {
      const L = layoutHeart(n, 1920, 1080, synthAspects(n),
        Object.assign({}, HEART_DEFAULTS, { forceRows: fr }));
      assert.ok(L.rows >= 1 && L.rows <= HEART_DEFAULTS.maxRows,
        `n=${n} forceRows=${fr} 行数 ${L.rows} 越界 [1,${HEART_DEFAULTS.maxRows}]`);
      assert.ok(L.rows <= n, `n=${n} forceRows=${fr} 行数 ${L.rows} 超过照片数`);
    }
  }
});

test('默认值就是 8（HEART_DEFAULTS.forceRows）', () => {
  assert.equal(HEART_DEFAULTS.forceRows, 8);
});

test('不传 heartCfg 时走默认 8 行（不是 null 自动）', () => {
  assert.equal(layoutHeart(41, 1920, 1080, synth41).rows, 8);
});

/* ==========================================================================
   §11 性能护栏
   ========================================================================== */

group('性能');

test('100 张布局耗时 < 100ms（现场首屏不能卡）', () => {
  const asp = synthAspects(100);
  // 预热：首次调用要建 spansAtDepth 缓存
  layoutHeart(100, 1920, 1080, asp);

  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 10; k++) layoutHeart(100, 1920, 1080, asp);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  assert.ok(ms < 100, `100 张布局平均 ${ms.toFixed(2)}ms，超过 100ms 预算`);
  console.log(`      （实测 ${ms.toFixed(2)}ms / 次）`);
});

/* ==========================================================================
   汇总
   ========================================================================== */

console.log('\n' + '─'.repeat(60));
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过：${passed} 个用例\x1b[0m`);
  console.log('');
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m失败 ${failures.length} 个 / 共 ${passed + failures.length} 个用例\x1b[0m`);
  for (const f of failures) {
    console.log(`\n\x1b[31m✗ ${f.name}\x1b[0m`);
    console.log('  ' + (f.err.stack || f.err.message));
  }
  console.log('');
  process.exit(1);
}
