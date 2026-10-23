/**
 * tests/api.test.mjs —— 服务端接口自动化测试
 * -----------------------------------------------------------------------------
 * 关键点：整套服务跑在一个临时目录里（靠 HEARTWALL_ROOT 环境变量），
 * 因此**不会碰真实的 photos/ 照片、config.json 和 addons/**。
 *
 * 跑法：node --test tests/api.test.mjs     或     node --test tests/
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

/* ==========================================================================
   测试环境
   ========================================================================== */

/** @type {string} 临时项目根目录 */
let TMP = '';
/** @type {number} */
let PORT = 0;
/** @type {import('node:child_process').ChildProcess|null} */
let child = null;

/**
 * 找一个空闲端口。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.listen(0, '127.0.0.1');
  });
}

/**
 * 发起一次 HTTP 请求。
 * @param {string} method
 * @param {string} urlPath
 * @param {{json?:any, raw?:Buffer, headers?:object}} [options]
 * @returns {Promise<{status:number, headers:object, text:string, json:any}>}
 */
function request(method, urlPath, options) {
  const opt = options || {};
  let data = null;
  if (opt.raw) data = opt.raw;
  else if (opt.json !== undefined) data = Buffer.from(JSON.stringify(opt.json), 'utf8');

  const headers = Object.assign({}, opt.headers || {});
  if (opt.json !== undefined) headers['Content-Type'] = 'application/json';
  if (data) headers['Content-Length'] = String(data.length);

  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/**
 * 轮询等待服务就绪。
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/config');
      if (r.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('服务在 ' + timeoutMs + 'ms 内没有就绪');
}

/**
 * 造一个最小的 JPEG：SOI + APP0 + SOF0(64×32) + EOI。
 * server.js 的图片探测只扫 SOF 段，这个就够它读出真实宽高。
 * @returns {Buffer}
 */
function makeJpeg() {
  return Buffer.from([
    0xff, 0xd8,                                     // SOI
    0xff, 0xe0, 0x00, 0x10,                         // APP0, len=16
    0x4a, 0x46, 0x49, 0x46, 0x00,                   // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,                   // SOF0, len=17, precision=8
    0x00, 0x20, 0x00, 0x40,                         // height=32, width=64
    0x03,                                           // 3 components
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9                                      // EOI
  ]);
}

/* ==========================================================================
   启动 / 清理
   ========================================================================== */

PORT = await freePort();
TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heartwall-api-'));

// 静态资源与插件样例都只从真实项目里「读」，复制到临时目录
fs.cpSync(path.join(PROJECT_ROOT, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'photos'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'music'), { recursive: true });

// 一个最小的插件：验证「有插件时能挂上」，跑完随临时目录一起删掉
fs.mkdirSync(path.join(TMP, 'addons', 'demo', 'public'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'addons', 'demo', 'manifest.json'),
  JSON.stringify({ id: 'demo', name: '示例插件', version: '0.1.0', entry: 'index.js' }, null, 2)
);
fs.writeFileSync(path.join(TMP, 'addons', 'demo', 'public', 'index.js'), 'export const hi = 1;\n');

child = spawn(process.execPath, [SERVER], {
  cwd: TMP,
  env: Object.assign({}, process.env, {
    HEARTWALL_ROOT: TMP,
    PORT: String(PORT),
    NO_OPEN: '1'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

const childOutput = [];
child.stdout.on('data', (c) => childOutput.push(c.toString('utf8')));
child.stderr.on('data', (c) => childOutput.push(c.toString('utf8')));

await waitReady(15000);

after(() => {
  if (child) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  if (TMP) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ==========================================================================
   配置接口
   ========================================================================== */

describe('GET /api/config', () => {
  test('首次启动返回完整的默认配置', async () => {
    const r = await request('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.json.code, 0);

    const cfg = r.json.data;
    assert.equal(typeof cfg.text.main, 'string');
    assert.equal(typeof cfg.playback.loop, 'boolean');
    assert.equal(typeof cfg.music.volume, 'number');
    assert.equal(cfg.heart.forceRows, 8, '默认应锁定 8 行');
  });
});

describe('PUT /api/config', () => {
  test('局部更新只影响传入的字段', async () => {
    const r = await request('PUT', '/api/config', {
      json: { text: { main: '新年快乐' } }
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.text.main, '新年快乐');
    assert.equal(r.json.data.heart.forceRows, 8, '没传的字段要保持原样');
  });

  test('主文案为空或超长都会被拒', async () => {
    const empty = await request('PUT', '/api/config', { json: { text: { main: '   ' } } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'INVALID_CONFIG');

    const tooLong = await request('PUT', '/api/config', { json: { text: { main: '字'.repeat(41) } } });
    assert.equal(tooLong.status, 400);
  });

  test('heart.forceRows：0 与 null 都归一成 null（自动）', async () => {
    const zero = await request('PUT', '/api/config', { json: { heart: { forceRows: 0 } } });
    assert.equal(zero.status, 200);
    assert.equal(zero.json.data.heart.forceRows, null);

    const nul = await request('PUT', '/api/config', { json: { heart: { forceRows: null } } });
    assert.equal(nul.status, 200);
    assert.equal(nul.json.data.heart.forceRows, null);
  });

  test('heart.forceRows：3 和 15 被拒，4 和 14 通过', async () => {
    for (const bad of [3, 15, 1, -1, 2.5]) {
      const r = await request('PUT', '/api/config', { json: { heart: { forceRows: bad } } });
      assert.equal(r.status, 400, `forceRows=${bad} 应该被拒`);
    }
    for (const good of [4, 8, 14]) {
      const r = await request('PUT', '/api/config', { json: { heart: { forceRows: good } } });
      assert.equal(r.status, 200, `forceRows=${good} 应该通过`);
      assert.equal(r.json.data.heart.forceRows, good);
    }
  });

  test('循环间隔、特写时长同样有边界', async () => {
    const bad1 = await request('PUT', '/api/config', { json: { playback: { closeupDuration: 100 } } });
    assert.equal(bad1.status, 400);

    const bad2 = await request('PUT', '/api/config', { json: { playback: { loopDelay: -1 } } });
    assert.equal(bad2.status, 400);

    const good = await request('PUT', '/api/config', { json: { playback: { closeupDuration: 1500 } } });
    assert.equal(good.status, 200);
    assert.equal(good.json.data.playback.closeupDuration, 1500);
  });
});

/* ==========================================================================
   照片接口
   ========================================================================== */

describe('照片上传', () => {
  test('缺少 name 参数 → 400', async () => {
    const r = await request('POST', '/api/photos', { raw: makeJpeg() });
    assert.equal(r.status, 400);
  });

  test('内容不是图片 → 400 BAD_IMAGE', async () => {
    const r = await request('POST', '/api/photos?name=a.jpg', {
      raw: Buffer.from('这不是图片，只是一段文字')
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'BAD_IMAGE');
  });

  test('正常上传并出现在列表里', async () => {
    const r = await request('POST', '/api/photos?name=' + encodeURIComponent('甲.jpg'), { raw: makeJpeg() });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.id, '甲.jpg');
    assert.equal(r.json.data.w, 64, 'SOF0 里写的是 64×32');
    assert.equal(r.json.data.h, 32);
    assert.equal(Number(r.json.data.aspect.toFixed(4)), 2);

    const list = await request('GET', '/api/photos');
    assert.equal(list.json.data.total, 1);
    assert.equal(list.json.data.photos[0].id, '甲.jpg');
  });

  test('上传第二张，顺序按上传先后', async () => {
    await request('POST', '/api/photos?name=' + encodeURIComponent('乙.jpg'), { raw: makeJpeg() });
    const list = await request('GET', '/api/photos');
    assert.equal(list.json.data.total, 2);
    assert.deepEqual(
      list.json.data.photos.map((p) => p.id),
      ['甲.jpg', '乙.jpg']
    );
  });
});

describe('排序与删除', () => {
  test('PUT /api/photos/order 生效，未知 id 被忽略', async () => {
    const r = await request('PUT', '/api/photos/order', {
      json: { ids: ['乙.jpg', '不存在的.jpg', 123, '甲.jpg'] }
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.order, ['乙.jpg', '甲.jpg']);
    assert.equal(r.json.data.count, 2);

    const ignored = r.json.data.ignored;
    assert.ok(ignored.includes('不存在的.jpg'), '磁盘上没有的 id 应被忽略');
  });

  test('顺序真的被记住了', async () => {
    const list = await request('GET', '/api/photos');
    assert.deepEqual(list.json.data.photos.map((p) => p.id), ['乙.jpg', '甲.jpg']);
  });

  test('DELETE 删除单张', async () => {
    const r = await request('DELETE', '/api/photos/' + encodeURIComponent('乙.jpg'));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.deleted, true);

    const list = await request('GET', '/api/photos');
    assert.equal(list.json.data.total, 1);
  });

  test('DELETE 路径穿越被拦（绝不能删到 photos/ 之外的文件）', async () => {
    const before = fs.readFileSync(path.join(TMP, 'config.json'), 'utf8');

    const r = await request('DELETE', '/api/photos/' + encodeURIComponent('../config.json'));
    assert.ok(r.status === 400 || r.status === 404, '穿越请求必须被拒');

    const after = fs.readFileSync(path.join(TMP, 'config.json'), 'utf8');
    assert.equal(after, before, 'config.json 必须原封不动');
    assert.ok(fs.existsSync(path.join(TMP, 'config.json')));
  });

  test('删除不存在的照片 → 404', async () => {
    const r = await request('DELETE', '/api/photos/nope.jpg');
    assert.equal(r.status, 404);
  });
});

describe('清空', () => {
  test('不带 confirm → 400', async () => {
    const r = await request('POST', '/api/photos/clear');
    assert.equal(r.status, 400);
  });

  test('带 confirm=1 → 清空', async () => {
    const r = await request('POST', '/api/photos/clear?confirm=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.total, 0);
  });
});

describe('manifest 备份', () => {
  test('写 manifest 前会留一份 manifest.backup.json', async () => {
    await request('POST', '/api/photos?name=' + encodeURIComponent('丙.jpg'), { raw: makeJpeg() });
    assert.ok(
      fs.existsSync(path.join(TMP, 'photos', 'manifest.backup.json')),
      '应在 photos/ 下生成 manifest.backup.json'
    );
  });

  test('manifest.json 不对外暴露', async () => {
    const r1 = await request('GET', '/photos/manifest.json');
    assert.equal(r1.status, 404);

    const r2 = await request('GET', '/photos/manifest.backup.json');
    assert.equal(r2.status, 404);
  });
});

/* ==========================================================================
   音乐
   ========================================================================== */

describe('GET /api/music', () => {
  test('0 字节的音频文件被跳过', async () => {
    fs.writeFileSync(path.join(TMP, 'music', 'empty.mp3'), '');
    const r = await request('GET', '/api/music');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.tracks.length, 0);
    assert.equal(r.json.data.active, null);
  });

  test('有内容的音频会被列出', async () => {
    fs.writeFileSync(path.join(TMP, 'music', 'bgm.mp3'), Buffer.alloc(1024, 1));
    const r = await request('GET', '/api/music');
    assert.equal(r.json.data.tracks.length, 1);
    assert.equal(r.json.data.tracks[0].name, 'bgm.mp3');
    assert.equal(r.json.data.active, 'bgm.mp3');
  });
});

/* ==========================================================================
   插件
   ========================================================================== */

describe('插件（addons）', () => {
  test('GET /api/addons 列出已加载的插件', async () => {
    const r = await request('GET', '/api/addons');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.total, 1);

    const a = r.json.data.addons[0];
    assert.equal(a.id, 'demo');
    assert.equal(a.name, '示例插件');
    assert.equal(a.version, '0.1.0');
    assert.equal(a.entry, '/addons/demo/index.js');
  });

  test('插件静态资源挂在 /addons/<id>/ 下', async () => {
    const r = await request('GET', '/addons/demo/index.js');
    assert.equal(r.status, 200);
    assert.match(r.text, /export const hi/);
  });

  test('未知插件 id 一律拒绝', async () => {
    const r = await request('GET', '/addons/unknown/index.js');
    assert.equal(r.status, 403);
  });

  test('插件目录里的路径穿越被拦', async () => {
    const r = await request('GET', '/addons/demo/' + encodeURIComponent('..') + '/config.json');
    assert.ok(r.status === 403 || r.status === 404, '不能读到插件目录之外的文件');
  });

  test('符号链接逃逸被拦：public 里的 symlink 指到目录外必须拒绝', async () => {
    // 在插件 public 目录里建一个指向外部的符号链接
    const secret = path.join(TMP, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    const link = path.join(TMP, 'addons', 'demo', 'public', 'leak.txt');
    try { fs.symlinkSync(secret, link); } catch { /* 环境不支持 symlink 则跳过 */ return; }

    const r = await request('GET', '/addons/demo/leak.txt');
    assert.ok(r.status === 403 || r.status === 404,
      'symlink 逃逸必须被拒，status=' + r.status);
    assert.ok(!r.text.includes('TOP-SECRET'), '绝不能把 symlink 目标的内容读出来');

    fs.unlinkSync(link);
  });

  test('重复插件 id：后者被忽略，不静默覆盖', async () => {
    const dup = path.join(TMP, 'addons', 'demo-copy');
    fs.mkdirSync(path.join(dup, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dup, 'manifest.json'),
      JSON.stringify({ id: 'demo', name: '重复者', version: '9.9.9' }));
    fs.writeFileSync(path.join(dup, 'public', 'index.js'), 'export const dup = 1;\n');

    const r = await request('GET', '/api/addons');
    assert.equal(r.json.data.total, 1, '重复 id 不能算两个插件');
    assert.equal(r.json.data.addons[0].name, '示例插件', '应保留先加载的那个');

    // 被忽略的那个不应被挂载
    const asset = await request('GET', '/addons/demo-copy/index.js');
    assert.ok(asset.status === 403 || asset.status === 404,
      '被忽略的重复插件不应可访问，status=' + asset.status);
  });
});

/* ==========================================================================
   兜底行为
   ========================================================================== */

describe('兜底', () => {
  test('未知接口返回 404', async () => {
    const r = await request('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'NOT_FOUND');
  });

  test('方法不对返回 405', async () => {
    const r = await request('DELETE', '/api/config');
    assert.equal(r.status, 405);
  });

  test('静态资源路径穿越被拦', async () => {
    const r = await request('GET', '/photos/' + encodeURIComponent('..') + '/config.json');
    assert.ok(r.status === 403 || r.status === 404);
  });

  test('根目录返回播放页', async () => {
    const r = await request('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /年会爱心墙/);
  });
});
