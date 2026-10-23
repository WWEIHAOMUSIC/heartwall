/**
 * tests/export.test.mjs —— 导出工具的参数解析与时间轴推导
 * -----------------------------------------------------------------------------
 * 只验「算得对不对」，**不启动 Chrome、不跑 ffmpeg**，所以秒级就能跑完。
 * 真录制由 tools/export-video.mjs 负责，它的核心逻辑这里不碰。
 *
 * 跑法：node --test tests/export.test.mjs     或     node --test tests/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { arg, computeTimeline, TIMELINE_DEFAULTS } from '../tools/export-video.mjs';

/* ==========================================================================
   参数解析
   -----------------------------------------------------------------------------
   arg() 读的是 process.argv，测试时临时替换再还原。
   ========================================================================== */

/**
 * 在替换过的 argv 下执行一段断言。
 * @param {string[]} argv
 * @param {() => void} fn
 */
function withArgv(argv, fn) {
  const saved = process.argv;
  try {
    process.argv = ['node', 'export-video.mjs'].concat(argv);
    fn();
  } finally {
    process.argv = saved;
  }
}

describe('arg() 参数解析', () => {
  test('能识别 --key value', () => {
    withArgv(['--w', '3840', '--h', '2160'], () => {
      assert.equal(arg('w', '1920'), '3840');
      assert.equal(arg('h', '1080'), '2160');
    });
  });

  test('没传的键回落到默认值', () => {
    withArgv(['--fps', '25'], () => {
      assert.equal(arg('fps', '30'), '25');
      assert.equal(arg('w', '1920'), '1920');
      assert.equal(arg('out', 'output/a.mp4'), 'output/a.mp4');
    });
  });

  test('值本身以 -- 开头时视为没给值（防止把下一个开关吃掉）', () => {
    withArgv(['--out', '--fps', '60'], () => {
      assert.equal(arg('out', 'default.mp4'), 'default.mp4');
      assert.equal(arg('fps', '30'), '60');
    });
  });

  test('只有开关没有值的布尔参数', () => {
    withArgv(['--keep'], () => {
      assert.equal(arg('keep', ''), '');
      assert.equal(arg('music', ''), '');
    });
  });

  test('中文文件名也能原样取到', () => {
    withArgv(['--out', 'output/年会爱心墙.mp4'], () => {
      assert.equal(arg('out', 'x.mp4'), 'output/年会爱心墙.mp4');
    });
  });
});

/* ==========================================================================
   时间轴
   ========================================================================== */

/** 汇聚错峰、结语延迟、淡入时长，与 export-video.mjs 里的常量一致 */
const STAGGER_MS = 500;
const SHOW_AFTER_MS = 1000;
const FADE_MS = 2000;

/**
 * 造一份配置。
 * @param {object} playback
 * @returns {object}
 */
function cfgOf(playback) {
  return { playback };
}

describe('computeTimeline() 时间轴', () => {
  test('默认参数：6 + 41×3 + (7+0.5) 秒，再加结语与定格', () => {
    const t = computeTimeline(cfgOf({
      floatDuration: 6000,
      closeupDuration: 3000,
      closeupLimit: 0,
      convergeDuration: 7000,
      loopDelay: 15000
    }), 41, 6);

    assert.equal(t.photoCount, 41);
    assert.equal(t.cuCount, 41, 'closeupLimit=0 表示全部特写');
    assert.equal(t.floatMs, 6000);
    assert.equal(t.cuMs, 3000);
    assert.equal(t.convMs, 7000, 'convMs 是不含错峰的原始汇聚时长');

    const expectDone = 6000 + 41 * 3000 + (7000 + STAGGER_MS);
    assert.equal(t.doneMs, expectDone);
    assert.equal(t.endingMs, expectDone + SHOW_AFTER_MS);
    assert.equal(t.totalMs, expectDone + SHOW_AFTER_MS + FADE_MS + 6000);
    assert.equal(t.loopRestartMs, expectDone + SHOW_AFTER_MS + 15000);
  });

  test('时间轴严格单调递增', () => {
    const t = computeTimeline(cfgOf({
      floatDuration: 6000, closeupDuration: 3000, closeupLimit: 0,
      convergeDuration: 7000, loopDelay: 15000
    }), 41, 6);

    assert.ok(t.doneMs > t.floatMs);
    assert.ok(t.endingMs > t.doneMs);
    assert.ok(t.totalMs > t.endingMs);
    assert.ok(t.loopRestartMs > t.endingMs);
  });

  test('closeupLimit 大于张数时按张数算', () => {
    const t = computeTimeline(cfgOf({
      floatDuration: 6000, closeupDuration: 3000, closeupLimit: 200,
      convergeDuration: 7000, loopDelay: 0
    }), 5, 6);

    assert.equal(t.cuCount, 5);
    assert.equal(t.doneMs, 6000 + 5 * 3000 + 7500);
  });

  test('closeupLimit=8 时只特写 8 张，其余照片仍在漂浮段和心形里', () => {
    const t = computeTimeline(cfgOf({
      floatDuration: 4000, closeupDuration: 2500, closeupLimit: 8,
      convergeDuration: 6000, loopDelay: 15000
    }), 41, 6);

    assert.equal(t.photoCount, 41);
    assert.equal(t.cuCount, 8);
    assert.equal(t.doneMs, 4000 + 8 * 2500 + 6500);
  });

  test('配置缺字段时用默认值', () => {
    const t = computeTimeline({}, 10, 6);
    assert.equal(t.floatMs, TIMELINE_DEFAULTS.floatMs);
    assert.equal(t.cuMs, TIMELINE_DEFAULTS.cuMs);
    assert.equal(t.convMs, TIMELINE_DEFAULTS.convergeMs);
    assert.equal(t.loopRestartMs, t.endingMs + TIMELINE_DEFAULTS.loopDelayMs);
  });

  test('hold=0 时片长只到淡入结束', () => {
    const t = computeTimeline(cfgOf({
      floatDuration: 6000, closeupDuration: 3000, closeupLimit: 0,
      convergeDuration: 7000, loopDelay: 0
    }), 1, 0);

    const expectEnding = 6000 + 3000 + 7500 + SHOW_AFTER_MS;
    assert.equal(t.totalMs, expectEnding + FADE_MS);
  });

  test('照片越多片越长（导出前能估出耗时）', () => {
    const one = computeTimeline(cfgOf({ floatDuration: 6000, closeupDuration: 3000, closeupLimit: 0, convergeDuration: 7000 }), 1, 6);
    const ten = computeTimeline(cfgOf({ floatDuration: 6000, closeupDuration: 3000, closeupLimit: 0, convergeDuration: 7000 }), 10, 6);
    const all = computeTimeline(cfgOf({ floatDuration: 6000, closeupDuration: 3000, closeupLimit: 0, convergeDuration: 7000 }), 41, 6);

    assert.ok(ten.totalMs > one.totalMs);
    assert.ok(all.totalMs > ten.totalMs);
  });
});
