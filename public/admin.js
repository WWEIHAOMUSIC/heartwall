/**
 * admin.js —— 管理控制台
 * -----------------------------------------------------------------------------
 * 左侧：上传 / 拖放 / 缩略图网格 / 拖拽排序 / 删除 / 清空 / 保存排序
 * 右侧：结语文案 / 特写时长 / 循环 / 音乐 / 心形布局 Canvas 预览
 *
 * 上传走「原始二进制直传」（不是 multipart），上传前用浏览器 Canvas 压到
 * 1600px 长边 / JPEG q=0.86，并发 3，逐张进度。
 */

import {
  layoutHeart,
  aspectFor,
  clamp,
  hashTri,
  ASPECT_CLAMP,
  HEART_DEFAULTS
} from './heart.js';

/* ==========================================================================
   状态
   ========================================================================== */

const MAX_EDGE = 1600;          // 压缩后长边上限
const JPEG_Q_SCALED = 0.86;     // 需要缩放的图
const JPEG_Q_ORIGINAL = 0.92;   // 本来就小于 1600 的图（仍重新编码，统一格式）
const CONCURRENCY = 3;          // 上传并发

const state = {
  photos: [],
  cfg: null,
  tracks: [],
  uploading: false,
  orderDirty: false
};

const $ = (sel) => document.querySelector(sel);

/* ==========================================================================
   Toast
   ========================================================================== */

/**
 * 弹一条中文提示。
 * @param {string} message
 * @param {'ok'|'err'|'warn'|'info'} [kind]
 * @param {number} [ms]
 */
function toast(message, kind, ms) {
  const wrap = $('#toastWrap');
  if (!wrap) return;

  const el = document.createElement('div');
  el.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  el.textContent = message;
  wrap.appendChild(el);

  const life = ms || (kind === 'err' ? 4200 : 2600);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  }, life);
}

/* ==========================================================================
   API 封装
   ========================================================================== */

/**
 * 发请求并统一处理信封。
 * 失败时抛出带中文 message 的 Error，调用方用 toast 展示。
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<any>} data 部分
 */
async function api(url, opts) {
  const o = opts || {};
  let res;

  try {
    res = await fetch(url, o);
  } catch {
    throw new Error('网络请求失败，请检查服务是否还在运行');
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error('服务器返回了非 JSON 内容（HTTP ' + res.status + '）');
  }

  if (!json || json.code !== 0) {
    const msg = (json && json.message) || ('请求失败（HTTP ' + res.status + '）');
    const err = new Error(msg);
    err.code = json && json.error;
    err.status = res.status;
    throw err;
  }

  return json.data;
}

/* ==========================================================================
   数据加载
   ========================================================================== */

async function loadAll() {
  const results = await Promise.allSettled([
    api('/api/photos'),
    api('/api/config'),
    api('/api/music')
  ]);

  if (results[0].status === 'fulfilled') {
    state.photos = results[0].value.photos || [];
  } else {
    state.photos = [];
    toast('读取照片列表失败：' + results[0].reason.message, 'err');
  }

  if (results[1].status === 'fulfilled') {
    state.cfg = results[1].value;
  } else {
    state.cfg = null;
    toast('读取设置失败：' + results[1].reason.message, 'err');
  }

  if (results[2].status === 'fulfilled') {
    state.tracks = results[2].value.tracks || [];
  } else {
    state.tracks = [];
  }

  renderGrid();
  fillSettings();
  renderHeartPreview();
  loadAddons();
}

/* ==========================================================================
   照片列表渲染
   ========================================================================== */

function renderGrid() {
  const grid = $('#photoGrid');
  const empty = $('#emptyGrid');
  grid.innerHTML = '';

  const n = state.photos.length;
  $('#countPill').textContent = '照片 ' + n + ' 张';

  if (n === 0) {
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
  }

  // 无照片时禁用删除/清空/排序
  $('#btnClear').disabled = (n === 0);
  $('#btnSaveOrder').disabled = (n === 0) || !state.orderDirty;

  state.photos.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.draggable = true;
    el.dataset.id = p.id;

    const img = document.createElement('img');
    img.src = p.url;
    img.alt = p.id;
    img.loading = 'lazy';
    el.appendChild(img);

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = String(i + 1);
    el.appendChild(idx);

    if (p.w && p.h) {
      const badge = document.createElement('span');
      badge.className = 'thumb-badge';
      badge.textContent = p.w + '×' + p.h;
      el.appendChild(badge);
    }

    const del = document.createElement('button');
    del.className = 'thumb-del';
    del.type = 'button';
    del.title = '删除这张';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePhoto(p.id);
    });
    el.appendChild(del);

    grid.appendChild(el);
  });
}

/* ==========================================================================
   上传
   ========================================================================== */

/**
 * 用浏览器 Canvas 把图压到长边 1600 / JPEG。
 * 失败返回 null，由调用方改为上传原文件。
 *
 * 解码走 <img> + blob URL，而不是 createImageBitmap()：
 * 前者兼容性更好（老 Safari 没有 createImageBitmap），
 * 且能拿到 naturalWidth/naturalHeight，HEIC 之类解不了的图会走 onerror 兜底。
 *
 * @param {File} file
 * @returns {Promise<{blob:Blob,w:number,h:number}|null>}
 */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  let img = null;

  try {
    img = new Image();

    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error('decode failed'));
    });

    img.src = url;

    try {
      await loaded;
    } catch {
      return null;                                 // 浏览器解不了的格式
    }

    // 等真正解码完再画，避免把空白位图画进 canvas。
    // 加超时兜底：个别环境（无 GPU 的无头浏览器）decode() 可能长期不 resolve，
    // 绝不能因此卡住整批上传 —— drawImage 本身会强制解码。
    if (typeof img.decode === 'function') {
      try {
        await Promise.race([
          img.decode(),
          new Promise((resolve) => setTimeout(resolve, 800))
        ]);
      } catch { /* 解码失败也继续，交给 drawImage 兜底 */ }
    }

    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (!sw || !sh) return null;

    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const tw = Math.max(1, Math.round(sw * scale));
    const th = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);

    const quality = scale < 1 ? JPEG_Q_SCALED : JPEG_Q_ORIGINAL;

    const blob = await new Promise((resolve) => {
      try {
        canvas.toBlob(resolve, 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });

    if (!blob) return null;
    return { blob, w: tw, h: th };

  } catch {
    return null;
  } finally {
    img = null;
    URL.revokeObjectURL(url);
  }
}

/**
 * 上传单张。
 * @param {File} file
 * @returns {Promise<object>} 服务端返回的照片对象
 */
async function uploadOne(file) {
  let body = file;
  let w = 0;
  let h = 0;

  const packed = await compressImage(file);
  if (packed) {
    body = packed.blob;
    w = packed.w;
    h = packed.h;
  }
  // 压缩失败则原样上传（宁可有张图显示不出来，也不要整批中断）

  const qs = '?name=' + encodeURIComponent(file.name) + '&w=' + w + '&h=' + h;

  return api('/api/photos' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: body
  });
}

/**
 * 批量上传（并发 3，逐张进度）。
 * @param {FileList|File[]} fileList
 */
async function uploadAll(fileList) {
  if (state.uploading) {
    toast('上一批还在上传中，请稍等', 'warn');
    return;
  }

  const files = Array.from(fileList).filter((f) => {
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.name)) {
      toast('跳过不是图片的文件：' + f.name, 'warn');
      return false;
    }
    if (f.size > 8 * 1024 * 1024) {
      toast('跳过超过 8MB 的文件：' + f.name, 'err');
      return false;
    }
    return true;
  });

  if (!files.length) return;

  state.uploading = true;
  const prog = $('#progress');
  const fill = $('#progressFill');
  const text = $('#progressText');
  prog.hidden = false;
  fill.style.width = '0%';
  text.textContent = '0 / ' + files.length;

  const queue = files.slice();
  const total = files.length;
  let done = 0;
  let failed = 0;

  const workers = new Array(Math.min(CONCURRENCY, total)).fill(null).map(async () => {
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;

      try {
        const photo = await uploadOne(file);
        state.photos.push(photo);
        renderGrid();
        renderHeartPreview();
      } catch (err) {
        failed++;
        toast('『' + file.name + '』上传失败：' + err.message, 'err');
      }

      done++;
      const pct = Math.round((done / total) * 100);
      fill.style.width = pct + '%';
      text.textContent = done + ' / ' + total + (failed ? '（失败 ' + failed + ' 张）' : '');
    }
  });

  await Promise.all(workers);

  state.uploading = false;
  prog.hidden = true;

  if (failed === 0) {
    toast('已上传 ' + (total) + ' 张照片', 'ok');
  } else if (failed < total) {
    toast('上传完成，' + (total - failed) + ' 张成功，' + failed + ' 张失败', 'warn', 4200);
  } else {
    toast('全部上传失败，请检查照片格式与体积', 'err', 5000);
  }

  renderGrid();
  renderHeartPreview();
}

/* ==========================================================================
   删除 / 清空 / 排序
   ========================================================================== */

async function deletePhoto(id) {
  try {
    await api('/api/photos/' + encodeURIComponent(id), { method: 'DELETE' });
    state.photos = state.photos.filter((p) => p.id !== id);
    state.orderDirty = false;
    renderGrid();
    renderHeartPreview();
    toast('已删除 1 张', 'ok', 1800);
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
}

async function clearAll() {
  const n = state.photos.length;
  if (n === 0) return;

  const okToGo = window.confirm('确定要清空全部 ' + n + ' 张照片吗？\n\n此操作不可撤销。');
  if (!okToGo) return;

  try {
    const data = await api('/api/photos/clear?confirm=1', { method: 'POST' });
    state.photos = [];
    state.orderDirty = false;
    renderGrid();
    renderHeartPreview();
    toast('已清空 ' + data.deleted + ' 张照片', 'ok');
  } catch (err) {
    toast('清空失败：' + err.message, 'err');
  }
}

async function saveOrder() {
  const ids = Array.from(document.querySelectorAll('#photoGrid .thumb')).map((el) => el.dataset.id);

  try {
    const data = await api('/api/photos/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });

    // 以服务端返回的顺序为准
    const byId = new Map(state.photos.map((p) => [p.id, p]));
    const next = [];
    for (const id of data.order) {
      const p = byId.get(id);
      if (p) next.push(p);
    }
    state.photos = next;

    state.orderDirty = false;
    renderGrid();
    renderHeartPreview();
    toast('已保存 ' + data.count + ' 张的播放顺序', 'ok');
  } catch (err) {
    toast('保存排序失败：' + err.message, 'err');
  }
}

/* ==========================================================================
   拖拽排序
   ========================================================================== */

let dragEl = null;

function bindGridDnD() {
  const grid = $('#photoGrid');

  grid.addEventListener('dragstart', (e) => {
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    dragEl = thumb;
    thumb.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', thumb.dataset.id || '');
    } catch { /* 某些浏览器受限，忽略 */ }
  });

  grid.addEventListener('dragend', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    document.querySelectorAll('.thumb.drop-target').forEach((el) => el.classList.remove('drop-target'));
    dragEl = null;
  });

  grid.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const over = e.target.closest('.thumb');
    document.querySelectorAll('.thumb.drop-target').forEach((el) => {
      if (el !== over) el.classList.remove('drop-target');
    });

    if (!over || over === dragEl) return;

    over.classList.add('drop-target');

    // 按鼠标在目标卡片的左右/上下半区决定插到前面还是后面
    const rect = over.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;

    if (after) {
      over.parentNode.insertBefore(dragEl, over.nextSibling);
    } else {
      over.parentNode.insertBefore(dragEl, over);
    }

    state.orderDirty = true;
    $('#btnSaveOrder').disabled = false;
    refreshIndexLabels();
  });

  grid.addEventListener('drop', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    document.querySelectorAll('.thumb.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });

  // 从桌面拖文件到列表里也可以上传
  grid.addEventListener('dragover', (e) => {
    if (dragEl) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });

  grid.addEventListener('drop', (e) => {
    if (dragEl) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      uploadAll(e.dataTransfer.files);
    }
  });
}

/** 拖拽后刷新左上角的序号 */
function refreshIndexLabels() {
  const thumbs = document.querySelectorAll('#photoGrid .thumb');
  thumbs.forEach((el, i) => {
    const badge = el.querySelector('.thumb-index');
    if (badge) badge.textContent = String(i + 1);
  });
}

/* ==========================================================================
   设置读写
   ========================================================================== */

function fillSettings() {
  const c = state.cfg;
  if (!c) return;

  $('#inpMain').value = c.text.main || '';
  $('#inpCompany').value = c.text.company || '';

  const cd = c.playback.closeupDuration || 3000;
  $('#rngCloseup').value = String(cd);
  updateCloseupLabel(cd);

  $('#chkLoop').checked = !!c.playback.loop;

  const ldSec = Math.round((c.playback.loopDelay || 0) / 1000);
  $('#rngLoopDelay').value = String(clamp(ldSec, 0, 120));
  updateLoopDelayLabel(clamp(ldSec, 0, 120));

  const ec = (typeof c.playback.ensembleCount === 'number' && c.playback.ensembleCount >= 2)
    ? c.playback.ensembleCount : 0;
  $('#selEnsemble').value = String(ec);

  const camLv = ['off', 'light', 'mid', 'strong'].indexOf(c.playback.cameraLevel) >= 0
    ? c.playback.cameraLevel : 'mid';
  $('#selCamera').value = camLv;

  $('#chkMusic').checked = !!c.music.enabled;

  const vol = Math.round((typeof c.music.volume === 'number' ? c.music.volume : 0.62) * 100);
  $('#rngVolume').value = String(vol);
  updateVolumeLabel(vol);

  fillTrackSelect();
}

function fillTrackSelect() {
  const sel = $('#selTrack');
  sel.innerHTML = '';

  if (!state.tracks.length) {
    const opt = document.createElement('option');
    opt.value = '';

    opt.textContent = '（music/ 里还没有音乐文件）';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = '（自动：第一首）';
  sel.appendChild(autoOpt);

  state.tracks.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });

  const wanted = state.cfg && state.cfg.music ? state.cfg.music.track : null;
  sel.value = (wanted && state.tracks.some((t) => t.name === wanted)) ? wanted : '';
}

function updateCloseupLabel(ms) {
  $('#lblCloseup').textContent = (ms / 1000).toFixed(1) + ' 秒（可调 0.7–8 秒）';
}

function updateLoopDelayLabel(sec) {
  $('#lblLoopDelay').textContent = sec > 0 ? (sec + ' 秒后重播') : '不等待，立刻重播';
}

function updateVolumeLabel(pct) {
  $('#lblVolume').textContent = pct + '%';
}

/**
 * 收集并校验界面上的设置。
 * @returns {{ok:true, patch:object}|{ok:false, message:string, focus:string}}
 */
function collectSettings() {
  const main = $('#inpMain').value.trim();
  const company = $('#inpCompany').value.trim();
  const closeupDuration = parseInt($('#rngCloseup').value, 10);
  const loop = $('#chkLoop').checked;
  const loopDelay = parseInt($('#rngLoopDelay').value, 10) * 1000;
  const musicEnabled = $('#chkMusic').checked;
  const volume = parseInt($('#rngVolume').value, 10) / 100;
  const trackName = $('#selTrack').value;
  const ensembleCount = parseInt($('#selEnsemble').value, 10);
  const cameraLevel = $('#selCamera').value;

  if (main.length < 1 || main.length > 40) {
    return { ok: false, message: '主文案需要 1–40 个字符', focus: '#inpMain' };
  }
  if (company.length > 40) {
    return { ok: false, message: '公司署名不能超过 40 个字符', focus: '#inpCompany' };
  }
  if (!Number.isInteger(closeupDuration) || closeupDuration < 700 || closeupDuration > 8000) {
    return { ok: false, message: '特写停留时长需在 0.7–8 秒之间', focus: '#rngCloseup' };
  }

  return {
    ok: true,
    patch: {
      text: { main: main, company: company },
      playback: {
        closeupDuration: closeupDuration,
        loop: loop,
        loopDelay: loopDelay,
        ensembleCount: ensembleCount,
        cameraLevel: cameraLevel
      },
      music: {
        enabled: musicEnabled,
        volume: volume,
        track: trackName ? trackName : null
      }
    }
  };
}

async function saveSettings() {
  const collected = collectSettings();
  if (!collected.ok) {
    toast(collected.message, 'err');
    const el = $(collected.focus);
    if (el) {
      el.classList.add('invalid');
      el.focus();
      setTimeout(() => el.classList.remove('invalid'), 2200);
    }
    return;
  }

  try {
    const cfg = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collected.patch)
    });
    state.cfg = cfg;
    fillSettings();
    toast('设置已保存，播放页刷新后生效', 'ok');
  } catch (err) {
    toast('保存设置失败：' + err.message, 'err', 5000);
  }
}

/* ==========================================================================
   扩展插件
   ----------------------------------------------------------------------------
   插件放在 addons/<id>/，由服务端扫描 manifest.json 后通过 /api/addons 返回。
   没有插件时这里显示「未安装」，不影响任何现有功能。
   ========================================================================== */

/**
 * 已知的扩展插件目录。
 * 这里只做「展示」，真正的安装就是把文件夹拷进 addons/；
 * 线上没有插件市场，所以未安装的条目只给出了解链接。
 */
const ADDON_CATALOG = [
  {
    id: 'shape-pack',
    name: '形状包',
    desc: '除心形外，还能聚成星形、圆形、文字轮廓'
  }
];

/**
 * 拉取并渲染插件列表。
 * 接口挂了也不弹窗吓人，只在控制台记一行。
 */
async function loadAddons() {
  const list = $('#addonList');
  if (!list) return;

  let installed = [];
  try {
    const data = await api('/api/addons');
    installed = (data && data.addons) ? data.addons : [];
  } catch (err) {
    console.warn('[heart-wall admin] 读取插件列表失败：', err.message);
    list.innerHTML = '<div class="addon-row addon-error">暂时读不到插件列表（不影响使用）</div>';
    return;
  }

  const rows = [];

  // 已安装的排前面
  for (const a of installed) {
    rows.push(
      '<div class="addon-row addon-on">' +
        '<div class="addon-main">' +
          '<span class="addon-name">' + escapeHtml(a.name) + '</span>' +
          '<span class="addon-ver">v' + escapeHtml(a.version) + '</span>' +
        '</div>' +
        '<div class="addon-desc">' + escapeHtml(a.description || '已启用') + '</div>' +
        '<div class="addon-meta">已启用 · ' + escapeHtml(a.id) + '</div>' +
      '</div>'
    );
  }

  // 目录里没装的，置灰给出了解入口
  const installedIds = new Set(installed.map((a) => a.id));
  for (const c of ADDON_CATALOG) {
    if (installedIds.has(c.id)) continue;
    rows.push(
      '<div class="addon-row addon-off">' +
        '<div class="addon-main">' +
          '<span class="addon-name">' + escapeHtml(c.name) + '</span>' +
          '<a class="addon-link" href="#" target="_blank" rel="noreferrer">了解商业版 →</a>' +
        '</div>' +
        '<div class="addon-desc">' + escapeHtml(c.desc) + '</div>' +
        '<div class="addon-meta">未安装</div>' +
      '</div>'
    );
  }

  if (rows.length === 0) {
    rows.push('<div class="addon-row addon-off">暂无可用插件</div>');
  }

  list.innerHTML = rows.join('');
}

/**
 * 转义 HTML，避免插件描述里带尖括号把页面搞坏。
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   心形布局预览
   ========================================================================== */

function renderHeartPreview() {
  const canvas = $('#previewCanvas');
  if (!canvas) return;

  const wrap = canvas.parentElement;
  const cssW = Math.max(200, Math.round(wrap.clientWidth || 360));
  const cssH = Math.round(cssW * 9 / 16);

  // 适配 Retina
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const n = state.photos.length;
  const meta = $('#previewMeta');

  if (n === 0) {
    if (meta) meta.textContent = '（还没有照片）';
    return;
  }

  // 与播放页同一套宽高比逻辑
  const heartCfg = Object.assign({}, HEART_DEFAULTS, (state.cfg && state.cfg.heart) || {});
  const useNative = heartCfg.useNativeAspect !== false;
  const aspects = [];

  for (let i = 0; i < n; i++) {
    const p = state.photos[i];
    if (useNative && p && typeof p.aspect === 'number' && p.aspect > 0) {
      aspects.push(clamp(p.aspect, ASPECT_CLAMP[0], ASPECT_CLAMP[1]));
    } else {
      aspects.push(aspectFor(i, p, {
        useNativeAspect: useNative,
        aspectRange: heartCfg.aspectRange || [0.66, 1.46]
      }));
    }
  }

  let L;
  try {
    L = layoutHeart(n, cssW, cssH, aspects, heartCfg);
  } catch {
    return;
  }

  // 画照片格：浅灰填充 + 白色描边，模拟白框照片
  const border = Math.max(0.6, L.rowH * 0.05);

  for (const cell of L.cells) {
    ctx.fillStyle = '#9AA3A8';
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

    ctx.strokeStyle = '#F4F4F2';
    ctx.lineWidth = border;
    ctx.strokeRect(
      cell.x + border / 2,
      cell.y + border / 2,
      Math.max(cell.w - border, 0),
      Math.max(cell.h - border, 0)
    );
  }

  if (meta) {
    meta.textContent = n + ' 张 · ' + L.rows + ' 行 · 心形占宽 '
      + Math.round(L.heartW / cssW * 100) + '%';
  }
}

/* ==========================================================================
   交互绑定
   ========================================================================== */

function bindUI() {
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) {
      uploadAll(fileInput.files);
      fileInput.value = '';                 // 允许再次选同一批文件
    }
  });

  /* 拖放上传 */
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      uploadAll(e.dataTransfer.files);
    }
  });

  /* 整页防止误拖入导致浏览器打开图片 */
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* 按钮 */
  $('#btnSaveOrder').addEventListener('click', saveOrder);
  $('#btnClear').addEventListener('click', clearAll);
  $('#btnSaveConfig').addEventListener('click', saveSettings);
  $('#btnOpenPlayer').addEventListener('click', () => window.open('/', '_blank'));

  /* 滑杆实时回显 */
  $('#rngCloseup').addEventListener('input', (e) => {
    updateCloseupLabel(parseInt(e.target.value, 10));
  });
  $('#rngLoopDelay').addEventListener('input', (e) => {
    updateLoopDelayLabel(parseInt(e.target.value, 10));
  });
  $('#rngVolume').addEventListener('input', (e) => {
    updateVolumeLabel(parseInt(e.target.value, 10));
  });

  /* 循环关掉时，定格停留滑杆置灰（逻辑上无意义） */
  $('#chkLoop').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('#rngLoopDelay').disabled = !on;
    $('#lblLoopDelay').style.opacity = on ? '1' : '0.45';
  });

  /* 尺寸变化：重绘预览 */
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(renderHeartPreview, 180);
  });

  bindGridDnD();

  /* 离开页面前提醒未保存的排序 */
  window.addEventListener('beforeunload', (e) => {
    if (state.orderDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* 现场不需要错误弹窗，只记录 */
  window.addEventListener('error', (ev) => {
    console.warn('[heart-wall admin] 运行告警：', ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.warn('[heart-wall admin] 未处理的 Promise：', ev.reason);
  });
}

/* ==========================================================================
   启动
   ========================================================================== */

bindUI();
loadAll().catch((err) => {
  console.warn('[heart-wall admin] 初始化失败：', err);
  toast('初始化失败：' + err.message, 'err', 6000);
});
