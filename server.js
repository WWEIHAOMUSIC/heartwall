/**
 * server.js —— 年会爱心墙服务端
 * -----------------------------------------------------------------------------
 * Node 原生 http，零第三方依赖。
 *
 * 职责：
 *   · 静态资源（player / admin / photos / music），含 Range、ETag、MIME、路径穿越防护
 *   · 9 个 REST 接口（照片 CRUD + 排序 + 配置读写 + 音乐探测）
 *   · 首启自动生成 config.json / photos/manifest.json / 所需目录
 *   · 所有写盘走 `.tmp` + `renameSync` 原子替换（现场断电不损坏文件）
 *   · 端口占用自动顺延 8787 → 8797
 *
 *   · 插件（addons/）：扫描 manifest.json，把 addons/<id>/public 挂到 /addons/<id>/
 *
 * 启动：node server.js        （或双击 start.command / start.bat / start.sh）
 * 环境变量：
 *   PORT            起始端口（默认 8787，被占用则顺延到 8797）
 *   NO_OPEN=1       启动后不自动打开浏览器
 *   HEARTWALL_ROOT  把整个项目根目录指到别处（仅自动化测试用，平时不要设）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

/* ==========================================================================
   常量
   ========================================================================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HEARTWALL_ROOT 只给自动化测试用：让测试可以在临时目录里跑一套干净的服务，
// 不碰真实的 photos/。平时这个环境变量不存在，ROOT 就是 server.js 所在目录。
const ROOT = process.env.HEARTWALL_ROOT
  ? path.resolve(process.env.HEARTWALL_ROOT)
  : __dirname;

const PUBLIC_DIR = path.join(ROOT, 'public');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const MUSIC_DIR = path.join(ROOT, 'music');
const ADDONS_DIR = path.join(ROOT, 'addons');
const LOGS_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MANIFEST_FILE = path.join(PHOTOS_DIR, 'manifest.json');
const MANIFEST_BACKUP = path.join(PHOTOS_DIR, 'manifest.backup.json');

const PORT_START = Number(process.env.PORT) || 8787;
const PORT_TRIES = 11;                        // 8787 → 8797
const HOST = '127.0.0.1';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;     // 单张 8MB
const MAX_JSON_BYTES = 1 * 1024 * 1024;       // JSON body 1MB
const MAX_PHOTOS = 200;

const AUDIO_EXT = ['.mp3', '.m4a', '.mp4', '.wav', '.ogg', '.oga', '.aac', '.flac'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/* ==========================================================================
   默认配置（字段顺序即 config.json 的书写顺序）
   ========================================================================== */

const DEFAULT_CONFIG = {
  version: 1,

  text: {
    main: '感谢有你 一路同行',
    company: '北京XX科技有限公司'
  },

  playback: {
    floatDuration: 6000,
    closeupDuration: 3000,
    closeupWidthRatio: 0.50,
    convergeDuration: 7000,
    closeupLimit: 0,
    loop: true,
    loopDelay: 15000,
    // 展示样式（管理台可调）：
    // ensembleCount —— 特写段每拍同框张数。0 = 自动随机（每拍 2~5 张变着来），
    //                  2~5 = 固定张数（含主卡）。
    // cameraLevel   —— 运镜强度。off=完全静止 / light=轻 / mid=中 / strong=明显。
    ensembleCount: 0,
    cameraLevel: 'mid'
  },

  music: {
    enabled: true,
    volume: 0.62,
    track: null
  },

  heart: {
    useNativeAspect: true,
    aspectRange: [0.66, 1.46],
    heightRatio: 0.856,
    centerY: 0.564,
    maxWidthRatio: 0.80,
    widen: 1.040,
    gapRatio: 0.015,
    rowGapRatio: 0.008,
    minRows: 7,
    maxRows: 13,
    // 默认锁定 8 行（与已验收原型一致）。null = 按照片长宽比自动决定行数。
    forceRows: 8
  }
};

/* ==========================================================================
   基础工具
   ========================================================================== */

/**
 * 原子写文件：先写临时文件，再 rename 覆盖。
 * 断电时要么是旧内容、要么是新内容，绝不会出现半截 JSON。
 * @param {string} file 目标路径
 * @param {string} content 文本内容
 */
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 安全写 JSON（带缩进，方便用户手改 config.json）。
 * @param {string} file
 * @param {any} obj
 */
function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * 写 manifest 之前先备份上一版。
 * manifest 记着照片顺序，现场排了半小时的顺序要是被一次写坏就没了，
 * 留一份 manifest.backup.json 可以随时手工拷回来。
 * 备份失败绝不阻断主流程。
 */
function backupManifest() {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) return;
    fs.copyFileSync(MANIFEST_FILE, MANIFEST_BACKUP);
  } catch {
    /* 备份失败也继续写，不能因为备份问题丢功能 */
  }
}

/**
 * 深合并（用于 PUT /api/config 的局部更新）。
 * 只合并普通对象，数组与标量直接覆盖。
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;

  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = base ? base[key] : undefined;

    if (pv && typeof pv === 'object' && !Array.isArray(pv)
        && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

/**
 * 清理照片文件名，生成合法的 id（见 docs/architecture.md §7.3）。
 * @param {string} rawName 原始文件名
 * @returns {string} 清洗后的 id（可能为空串，由调用方兜底）
 */
function sanitizePhotoName(rawName) {
  let name = String(rawName || '').trim();

  // 只取 basename（防止 ../ 之类）
  name = path.basename(name.replace(/\\/g, '/'));

  if (!name) return '';

  // 拆主名与扩展名
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;

  // 移除非法字符，保留 中文 / 字母 / 数字 / 空格 / - _ . ( )
  stem = stem.replace(/[/\\:*?"<>|\0]/g, '');
  // 连续空白压成单个下划线
  stem = stem.replace(/\s+/g, '_');
  // 头尾的点与下划线去掉（避免隐藏文件 / 难看）
  stem = stem.replace(/^[.\-_]+|[.\-_]+$/g, '');

  // 截断到 80 字符（预留扩展名）
  if (stem.length > 76) stem = stem.slice(0, 76);

  return stem ? stem + '.jpg' : '';
}

/**
 * 在 photos/ 中找一个不冲突的文件名。
 * @param {string} id 期望的 id
 * @returns {string} 可用的 id（重名则加 -2 / -3 …）
 */
function uniquePhotoId(id) {
  const dot = id.lastIndexOf('.');
  const stem = dot > 0 ? id.slice(0, dot) : id;
  const ext = dot > 0 ? id.slice(dot) : '.jpg';

  let candidate = id;
  let n = 1;
  while (fs.existsSync(path.join(PHOTOS_DIR, candidate))) {
    n++;
    candidate = `${stem}-${n}${ext}`;
    if (n > 999) {
      // 极端兜底：用时间戳
      candidate = `${stem}-${Date.now()}${ext}`;
      break;
    }
  }
  return candidate;
}

/* ==========================================================================
   图片尺寸探测（只读文件头，不依赖任何库）
   ========================================================================== */

/**
 * 探测图片的像素尺寸。
 * 支持 JPEG（扫描 SOF 段）、PNG、GIF、WebP。探测失败返回 null。
 * @param {Buffer} buf 文件头若干字节（建议 ≥ 64KB，JPEG 的 SOF 可能在较后位置）
 * @returns {{w:number,h:number}|null}
 */
function probeImageSize(buf) {
  if (!buf || buf.length < 16) return null;

  // ---- PNG：IHDR 在固定偏移 ----
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // ---- GIF ----
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    if (buf.length < 10) return null;
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // ---- WebP ----
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ' && buf.length >= 30) {
      // 有损：跳过 3 字节 frame tag + 3 字节 start code
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fmt === 'VP8L' && buf.length >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { w, h };
    }
    if (fmt === 'VP8X' && buf.length >= 30) {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { w, h };
    }
    return null;
  }

  // ---- JPEG：扫描 SOF 段 ----
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }

      const marker = buf[off + 1];

      // 填充字节
      if (marker === 0xff) { off++; continue; }
      // 无长度字段的独立标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xd9) break;                     // EOI

      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) break;

      // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

      if (isSOF && off + 9 <= buf.length) {
        const h = buf.readUInt16BE(off + 5);
        const w = buf.readUInt16BE(off + 7);
        if (w > 0 && h > 0) return { w, h };
        return null;
      }
      off += 2 + segLen;
    }
    return null;
  }

  return null;
}

/**
 * 校验文件头的图片魔数。
 * @param {Buffer} head 文件开头若干字节
 * @returns {boolean}
 */
function isImageMagic(head) {
  if (!head || head.length < 4) return false;

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;   // JPEG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return true;   // GIF
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return true; // RIFF/WebP
  return false;
}

/* ==========================================================================
   配置读写与校验
   ========================================================================== */

/** 内存中的配置（启动时加载） */
let config = null;

/**
 * 加载 config.json；不存在则按默认值生成；解析失败则备份并重建。
 * @returns {object} 配置
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    writeJsonAtomic(CONFIG_FILE, config);
    log(`已生成默认配置：${path.basename(CONFIG_FILE)}`);
    return config;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // 补齐缺失字段（例如用户手改时删掉了几项）
    config = deepMerge(DEFAULT_CONFIG, parsed);
    return config;
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(ROOT, `config.broken-${stamp}.json`);
    try { fs.copyFileSync(CONFIG_FILE, backup); } catch { /* 备份失败也不阻塞 */ }

    warn(`config.json 解析失败，已备份为 ${path.basename(backup)}，并使用默认配置重建`);
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    writeJsonAtomic(CONFIG_FILE, config);
    return config;
  }
}

/**
 * 校验并清洗配置（只保留已知字段，未知字段丢弃）。
 * @param {object} cfg 待校验的完整配置
 * @returns {{ok:true, value:object}|{ok:false, message:string}}
 */
function validateConfig(cfg) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  /* ---- text ---- */
  if (cfg.text) {
    if (typeof cfg.text.main === 'string') {
      const v = cfg.text.main.trim();
      if (v.length < 1 || v.length > 40) return { ok: false, message: '主文案长度需在 1–40 个字符之间' };
      out.text.main = v;
    }
    if (typeof cfg.text.company === 'string') {
      const v = cfg.text.company.trim();
      if (v.length > 40) return { ok: false, message: '公司署名长度需在 0–40 个字符之间' };
      out.text.company = v;
    }
  }

  /* ---- playback ---- */
  const pb = cfg.playback || {};

  if (pb.floatDuration !== undefined) {
    if (!Number.isInteger(pb.floatDuration) || pb.floatDuration < 3000 || pb.floatDuration > 30000) {
      return { ok: false, message: '漂浮时长需为 3000–30000 毫秒的整数' };
    }
    out.playback.floatDuration = pb.floatDuration;
  }
  if (pb.closeupDuration !== undefined) {
    // 下限放到 700ms：年会要「每张都露脸、整段约 1 分钟」时，
    // 43 张 × 1 秒 = 43 秒，低于 1500 会被旧下限挡掉。
    if (!Number.isInteger(pb.closeupDuration) || pb.closeupDuration < 700 || pb.closeupDuration > 8000) {
      return { ok: false, message: '特写停留时长需为 700–8000 毫秒的整数' };
    }
    out.playback.closeupDuration = pb.closeupDuration;
  }
  if (pb.closeupWidthRatio !== undefined) {
    if (typeof pb.closeupWidthRatio !== 'number' || pb.closeupWidthRatio < 0.35 || pb.closeupWidthRatio > 0.65) {
      return { ok: false, message: '特写宽度占比需在 0.35–0.65 之间' };
    }
    out.playback.closeupWidthRatio = pb.closeupWidthRatio;
  }
  if (pb.convergeDuration !== undefined) {
    if (!Number.isInteger(pb.convergeDuration) || pb.convergeDuration < 3000 || pb.convergeDuration > 20000) {
      return { ok: false, message: '汇聚时长需为 3000–20000 毫秒的整数' };
    }
    out.playback.convergeDuration = pb.convergeDuration;
  }
  if (pb.closeupLimit !== undefined) {
    if (!Number.isInteger(pb.closeupLimit) || pb.closeupLimit < 0 || pb.closeupLimit > 200) {
      return { ok: false, message: '特写张数需为 0–200 的整数（0 表示全部）' };
    }
    out.playback.closeupLimit = pb.closeupLimit;
  }
  if (pb.loop !== undefined) {
    if (typeof pb.loop !== 'boolean') return { ok: false, message: '循环开关需为布尔值' };
    out.playback.loop = pb.loop;
  }
  if (pb.loopDelay !== undefined) {
    if (!Number.isInteger(pb.loopDelay) || pb.loopDelay < 0 || pb.loopDelay > 600000) {
      return { ok: false, message: '循环间隔需为 0–600000 毫秒的整数' };
    }
    out.playback.loopDelay = pb.loopDelay;
  }
  if (pb.ensembleCount !== undefined) {
    if (!Number.isInteger(pb.ensembleCount) || [0, 2, 3, 4, 5].indexOf(pb.ensembleCount) < 0) {
      return { ok: false, message: '同框张数需为 0（自动随机）或 2–5 的整数' };
    }
    out.playback.ensembleCount = pb.ensembleCount;
  }
  if (pb.cameraLevel !== undefined) {
    if (['off', 'light', 'mid', 'strong'].indexOf(pb.cameraLevel) < 0) {
      return { ok: false, message: '运镜强度需为 off / light / mid / strong 之一' };
    }
    out.playback.cameraLevel = pb.cameraLevel;
  }

  /* ---- music ---- */
  const mu = cfg.music || {};
  if (mu.enabled !== undefined) {
    if (typeof mu.enabled !== 'boolean') return { ok: false, message: '音乐开关需为布尔值' };
    out.music.enabled = mu.enabled;
  }
  if (mu.volume !== undefined) {
    if (typeof mu.volume !== 'number' || mu.volume < 0 || mu.volume > 1) {
      return { ok: false, message: '音量需在 0–1 之间' };
    }
    out.music.volume = mu.volume;
  }
  if (mu.track !== undefined) {
    if (mu.track !== null && typeof mu.track !== 'string') {
      return { ok: false, message: '曲目需为文件名或 null' };
    }
    out.music.track = mu.track;
  }

  /* ---- heart（管理台不暴露，只做类型与范围检查）---- */
  const ht = cfg.heart || {};
  const numRange = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;

  if (ht.useNativeAspect !== undefined) {
    if (typeof ht.useNativeAspect !== 'boolean') return { ok: false, message: 'heart.useNativeAspect 需为布尔值' };
    out.heart.useNativeAspect = ht.useNativeAspect;
  }
  if (ht.aspectRange !== undefined) {
    if (!Array.isArray(ht.aspectRange) || ht.aspectRange.length !== 2
        || !numRange(ht.aspectRange[0], 0.2, 3) || !numRange(ht.aspectRange[1], 0.2, 3)) {
      return { ok: false, message: 'heart.aspectRange 需为 [min, max] 两个数字' };
    }
    out.heart.aspectRange = [ht.aspectRange[0], ht.aspectRange[1]];
  }
  if (ht.heightRatio !== undefined) {
    if (!numRange(ht.heightRatio, 0.3, 0.99)) return { ok: false, message: 'heart.heightRatio 需在 0.3–0.99' };
    out.heart.heightRatio = ht.heightRatio;
  }
  if (ht.centerY !== undefined) {
    if (!numRange(ht.centerY, 0.1, 0.9)) return { ok: false, message: 'heart.centerY 需在 0.1–0.9' };
    out.heart.centerY = ht.centerY;
  }
  if (ht.maxWidthRatio !== undefined) {
    if (!numRange(ht.maxWidthRatio, 0.3, 1)) return { ok: false, message: 'heart.maxWidthRatio 需在 0.3–1' };
    out.heart.maxWidthRatio = ht.maxWidthRatio;
  }
  if (ht.widen !== undefined) {
    if (!numRange(ht.widen, 0.7, 1.5)) return { ok: false, message: 'heart.widen 需在 0.7–1.5' };
    out.heart.widen = ht.widen;
  }
  if (ht.gapRatio !== undefined) {
    if (!numRange(ht.gapRatio, 0, 0.3)) return { ok: false, message: 'heart.gapRatio 需在 0–0.3' };
    out.heart.gapRatio = ht.gapRatio;
  }
  if (ht.rowGapRatio !== undefined) {
    if (!numRange(ht.rowGapRatio, 0, 0.3)) return { ok: false, message: 'heart.rowGapRatio 需在 0–0.3' };
    out.heart.rowGapRatio = ht.rowGapRatio;
  }
  if (ht.minRows !== undefined) {
    if (!Number.isInteger(ht.minRows) || ht.minRows < 1 || ht.minRows > 40) {
      return { ok: false, message: 'heart.minRows 需为 1–40 的整数' };
    }
    out.heart.minRows = ht.minRows;
  }
  if (ht.maxRows !== undefined) {
    if (!Number.isInteger(ht.maxRows) || ht.maxRows < 1 || ht.maxRows > 40) {
      return { ok: false, message: 'heart.maxRows 需为 1–40 的整数' };
    }
    out.heart.maxRows = ht.maxRows;
  }
  if (ht.forceRows !== undefined) {
    // 语义只有两种：null（=0，自动）或 4–14 的整数。
    // 行数为 1–3 时心形只有两三道横杠，毫无意义；大于 14 则照片数填不满，
    // 格子坐标会算出 NaN，照片直接不渲染（这个坑踩过一次，别再放开）。
    const v = ht.forceRows;
    if (v === null || v === 0) {
      // 统一归一成 null：0 与 null 是同一个意思，存两份只会让后面分叉
      out.heart.forceRows = null;
    } else if (!Number.isInteger(v) || v < 4 || v > 14) {
      return { ok: false, message: 'heart.forceRows 需为 4–14 的整数，或 0 / null（自动）' };
    } else {
      out.heart.forceRows = v;
    }
  }

  return { ok: true, value: out };
}

/**
 * 保存配置（原子写）。
 * @param {object} cfg 已经通过校验的完整配置
 */
function saveConfigFile(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
  config = cfg;
}

/* ==========================================================================
   manifest 读写与照片列表
   ========================================================================== */

const EMPTY_MANIFEST = { version: 1, order: [], items: {} };

/**
 * 读取 manifest.json；损坏则重建。
 * @returns {{version:number, order:string[], items:object}}
 */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    const m = JSON.parse(JSON.stringify(EMPTY_MANIFEST));
    writeJsonAtomic(MANIFEST_FILE, m);
    return m;
  }

  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    return {
      version: m.version || 1,
      order: Array.isArray(m.order) ? m.order : [],
      items: (m.items && typeof m.items === 'object') ? m.items : {}
    };
  } catch {
    warn('manifest.json 解析失败，已备份为 manifest.backup.json 并重建（照片文件不受影响）');
    backupManifest();
    const m = JSON.parse(JSON.stringify(EMPTY_MANIFEST));
    writeJsonAtomic(MANIFEST_FILE, m);
    return m;
  }
}

/**
 * 保存 manifest（先备份旧版，再原子写）。
 * @param {object} m
 */
function saveManifest(m) {
  backupManifest();
  writeJsonAtomic(MANIFEST_FILE, m);
}

/**
 * 列出 photos/ 下的图片文件名（不含 manifest.json 与隐藏文件）。
 * @returns {string[]}
 */
function listPhotoFiles() {
  let names = [];
  try {
    names = fs.readdirSync(PHOTOS_DIR);
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (n.startsWith('.')) return false;
    const ext = path.extname(n).toLowerCase();
    return IMAGE_EXT.includes(ext);
  });
}

/**
 * 读取文件头以探测尺寸。
 *
 * ⚠️ 为什么不能再只读 64KB：
 *   部分照片在 SOF 段之前塞了一串巨大的 APP 段。本机实测 照片_34/36/39/41
 *   是 APP1(29KB) + APP7/8/9/10(53~63KB)，SOF 落在 260~264KB 处。
 *   只读 64KB 会扑空 → 返回 null → 播放器拿不到真实比例，退化为随机宽高比
 *   → 该照片在心形里按错误比例排版，把整行撑歪（"心形不规整"的元凶之一）。
 *
 *   故改为渐进式：先按 64KB 快速探测（绝大多数照片一次命中，开销不变），
 *   扑空且文件更大时才按 64KB 步进追加，上限 1MB。
 *
 * 结果按「文件名 + 大小 + 修改时间」缓存在内存里：
 * manifest.items 里没有的文件（用户手工丢进 photos/ 的）每次 GET 都会走这里，
 * 43 张就是 43 次探测，缓存后只有第一次真正读盘。
 * 只缓存不改写 manifest，符合 §4.2「自愈只读不回写」的约定。
 */
const _sizeCache = new Map();

/** 首扫窗口：够覆盖绝大多数 JPEG 的 SOF */
const HEAD_SCAN = 64 * 1024;

/** 追加扫描上限：APP 段异常巨大的照片也能覆盖（实测最深处 264KB） */
const HEAD_SCAN_MAX = 1024 * 1024;

function probeFileSize(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }

  const key = path.basename(file) + '|' + st.size + '|' + Math.floor(st.mtimeMs);
  if (_sizeCache.has(key)) return _sizeCache.get(key);

  let dim = null;
  let fd = null;

  try {
    fd = fs.openSync(file, 'r');
    let buf = Buffer.alloc(HEAD_SCAN);
    let n = fs.readSync(fd, buf, 0, HEAD_SCAN, 0);
    dim = probeImageSize(buf.subarray(0, n));

    // 首扫扑空 → 按 64KB 步进向后追加，直到拿到尺寸、读尽文件或触及上限
    while (!dim && n < HEAD_SCAN_MAX) {
      const want = Math.min(HEAD_SCAN, HEAD_SCAN_MAX - n);
      const more = Buffer.alloc(want);
      const got = fs.readSync(fd, more, 0, want, n);
      if (got <= 0) break;
      buf = Buffer.concat([buf.subarray(0, n), more.subarray(0, got)]);
      n += got;
      dim = probeImageSize(buf.subarray(0, n));
    }
  } catch {
    dim = null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  // 缓存条目过多时整体清空（照片被替换/删除后自然失效）
  if (_sizeCache.size > 600) _sizeCache.clear();
  _sizeCache.set(key, dim);

  return dim;
}

/**
 * 取完整照片列表（按 manifest.order 排序，自愈缺失项）。
 * 自愈只在内存里做，不回写 manifest（见 docs §4.2）。
 * @returns {Array<object>}
 */
function getPhotos() {
  const manifest = loadManifest();

  // 0 字节的图片（传输中断留下的碎片）解码一定失败，别让它混进列表把页面搞白。
  // 文件本身还留在 photos/ 里，用户可以在管理台删掉或重新传。
  const allFiles = listPhotoFiles();
  const onDisk = allFiles.filter((n) => {
    try { return fs.statSync(path.join(PHOTOS_DIR, n)).size > 0; } catch { return false; }
  });

  if (allFiles.length !== onDisk.length) {
    warn(`photos/ 里有 ${allFiles.length - onDisk.length} 个 0 字节文件，已跳过`);
  }
  if (onDisk.length > MAX_PHOTOS) {
    warn(`照片有 ${onDisk.length} 张，超过建议上限 ${MAX_PHOTOS} 张，页面可能会卡`);
  }

  const onDiskSet = new Set(onDisk);

  const items = Object.assign({}, manifest.items);

  // 1) 目录里有但 items 里没有 → 现场补一条
  for (const name of onDisk) {
    if (items[name]) continue;
    const full = path.join(PHOTOS_DIR, name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    const dim = probeFileSize(full);
    items[name] = {
      w: dim ? dim.w : null,
      h: dim ? dim.h : null,
      aspect: dim ? Number((dim.w / dim.h).toFixed(4)) : null,
      size: st.size,
      addedAt: st.mtime.toISOString()
    };
  }

  // 2) items 里有但磁盘上没有 → 跳过
  // 3) order 去重，且只保留磁盘上存在的
  const seen = new Set();
  const ordered = [];
  for (const id of manifest.order) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (onDiskSet.has(id)) ordered.push(id);
  }

  // 4) order 未覆盖到的按 addedAt 升序追加
  const rest = onDisk.filter((n) => !seen.has(n));
  rest.sort((a, b) => {
    const ta = items[a] ? Date.parse(items[a].addedAt) || 0 : 0;
    const tb = items[b] ? Date.parse(items[b].addedAt) || 0 : 0;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
  ordered.push(...rest);

  return ordered.map((id) => {
    const it = items[id] || {};
    const w = it.w || null;
    const h = it.h || null;
    return {
      id,
      url: '/photos/' + encodeURIComponent(id),
      w,
      h,
      aspect: (w && h) ? Number((w / h).toFixed(4)) : null,
      size: it.size || 0,
      addedAt: it.addedAt || new Date(0).toISOString()
    };
  });
}

/* ==========================================================================
   HTTP 响应工具
   ========================================================================== */

/**
 * 发送统一信封 JSON。
 * @param {http.ServerResponse} res
 * @param {number} code 业务码（同时作为 HTTP 状态码：0 → 200）
 * @param {any} data
 * @param {string} message
 * @param {string} [error] 机器可读错误码
 */
function sendJson(res, code, data, message, error) {
  const body = { code, data: data === undefined ? null : data, message: message || (code === 0 ? 'ok' : '') };
  if (error) body.error = error;

  const text = JSON.stringify(body);
  res.writeHead(code === 0 ? 200 : code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/** 成功快捷方式 */
function ok(res, data, message) {
  sendJson(res, 0, data, message || 'ok');
}

/** 失败快捷方式 */
function fail(res, code, error, message, data) {
  sendJson(res, code, data === undefined ? null : data, message, error);
}

/* ==========================================================================
   MIME
   ========================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * 按扩展名取 MIME，未知类型退化为 octet-stream。
 * @param {string} file
 * @returns {string}
 */
function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/* ==========================================================================
   插件（addons）
   ----------------------------------------------------------------------------
   约定：addons/<id>/manifest.json 描述插件，addons/<id>/public/ 下的文件
   自动挂到 /addons/<id>/。没有插件目录或目录为空时，一切行为与以前完全一致。

   manifest.json 示例见 addons/README.md。
   ========================================================================== */

/** @type {Array<object>} 已加载的插件列表 */
let addons = [];

/**
 * 扫描 addons/ 目录，读取每个子目录里的 manifest.json。
 * 单个插件出错只跳过它，不影响服务启动。
 * @returns {number} 成功加载的插件数
 */
function loadAddons() {
  addons = [];

  if (!fs.existsSync(ADDONS_DIR)) return 0;

  let entries = [];
  try {
    entries = fs.readdirSync(ADDONS_DIR, { withFileTypes: true });
  } catch (e) {
    warn(`读取 addons/ 失败：${e.message}`);
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dir = path.join(ADDONS_DIR, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      warn(`插件 ${entry.name} 缺少 manifest.json，已跳过`);
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const id = String(raw.id || '').trim();
      if (!id) {
        warn(`插件 ${entry.name} 的 manifest.json 缺少 id，已跳过`);
        continue;
      }
      if (addons.some((a) => a.id === id)) {
        warn(`插件 ${entry.name} 的 id ${id} 与已加载插件重复，后者已忽略`);
        continue;
      }
      if (id !== entry.name) {
        warn(`插件目录名 ${entry.name} 与 id ${id} 不一致，已按 id 挂载`);
      }

      addons.push({
        id,
        name: String(raw.name || id),
        version: String(raw.version || '0.0.0'),
        description: String(raw.description || ''),
        author: String(raw.author || ''),
        // 入口脚本（相对插件 public 目录），前端按需 import
        entry: raw.entry ? String(raw.entry) : '',
        dir,
        publicDir: path.join(dir, 'public')
      });
      log(`已加载插件：${id} v${raw.version || '0.0.0'}`);
    } catch (e) {
      warn(`插件 ${entry.name} 的 manifest.json 解析失败：${e.message}`);
    }
  }

  return addons.length;
}

/**
 * 按 id 找插件。
 * @param {string} id
 * @returns {object|undefined}
 */
function findAddon(id) {
  return addons.find((a) => a.id === id);
}

/**
 * GET /api/addons
 */
function handleGetAddons(res) {
  ok(res, {
    total: addons.length,
    addons: addons.map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      author: a.author,
      entry: a.entry ? `/addons/${a.id}/${a.entry}` : ''
    }))
  });
}

/* ==========================================================================
   静态资源
   ========================================================================== */

/**
 * 把 URL 路径解析到磁盘路径，并做路径穿越防护。
 * @param {string} urlPath 已去掉 query 的路径
 * @returns {{file:string, root:string}|null} null 表示非法
 */
function resolveStatic(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;                                  // 非法百分号编码
  }

  if (p.includes('\0')) return null;

  let root = PUBLIC_DIR;
  let rel = p.replace(/^\/+/, '');

  if (p === '/' || rel === '') {
    rel = 'player.html';
  } else if (p === '/admin' || p === '/admin/') {
    rel = 'admin.html';
  } else if (p.startsWith('/photos/')) {
    root = PHOTOS_DIR;
    rel = p.slice('/photos/'.length);
  } else if (p.startsWith('/music/')) {
    root = MUSIC_DIR;
    rel = p.slice('/music/'.length);
  } else if (p.startsWith('/public/')) {
    root = PUBLIC_DIR;
    rel = p.slice('/public/'.length);
  } else if (p.startsWith('/addons/')) {
    // 插件静态资源：/addons/<id>/xxx → addons/<id>/public/xxx
    // 只认已加载插件的 id，未知 id 一律拒绝，防止把 addons/ 下的任意文件暴露出去
    const tail = p.slice('/addons/'.length);
    const seg = tail.split('/')[0];
    const hit = findAddon(seg);

    if (!hit) return null;
    root = hit.publicDir;
    rel = tail.slice(seg.length).replace(/^\/+/, '');
  }

  // 拒绝目录穿越
  if (rel.includes('..')) return null;

  const full = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;

  // 符号链接逃逸防护（插件目录专用）：上面的检查只能拦住「..」这种词法穿越，
  // 拦不住 symlink —— addons/x/public/link → /etc 时词法路径完全合法。
  // 这里把路径 realpath 到真实位置再校验一遍。root 也要 realpath：
  // macOS 的 /var 本身就是 /private/var 的软链，不解析 root 会把合法文件误杀。
  // 文件不存在（ENOENT）不算逃逸，交给后面的 404 处理。
  if (p.startsWith('/addons/')) {
    let rootReal = rootResolved;
    try { rootReal = fs.realpathSync(rootResolved); } catch { /* 目录不在就维持原值 */ }

    let real = null;
    try {
      real = fs.realpathSync(full);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
    }
    if (real !== null
        && real !== rootReal
        && !real.startsWith(rootReal + path.sep)) {
      return null;
    }
  }

  return { file: full, root: rootResolved };
}

/**
 * 生成 ETag（大小 + 修改时间，足够本项目用）。
 * @param {fs.Stats} st
 * @returns {string}
 */
function etagOf(st) {
  return 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
}

/**
 * 发送文件，支持 Range（音频 seek / 循环必需）与 ETag。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} file 绝对路径
 * @param {number} statusHint 200 或 206
 */
function sendFile(req, res, file, statusHint) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fail(res, 404, 'NOT_FOUND', '文件不存在');
    return;
  }

  if (!st.isFile()) {
    fail(res, 404, 'NOT_FOUND', '文件不存在');
    return;
  }

  // 空文件（0 字节）直接回 200，别走 Range 分支 —— 那边会因为 start >= total 判成 416，
  // 浏览器收到 416 就不肯播了，明明只是没内容而已。
  if (st.size === 0) {
    res.writeHead(200, {
      'Content-Type': mimeOf(file),
      'Content-Length': 0,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes'
    });
    res.end();
    return;
  }

  const etag = etagOf(st);
  const mime = mimeOf(file);
  const isAudio = mime.startsWith('audio/');
  const isPhoto = file.startsWith(PHOTOS_DIR);

  const cacheControl = (isAudio || isPhoto)
    ? 'public, max-age=3600'
    : 'no-cache';

  // 条件请求：未修改则 304
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': cacheControl,
      'Accept-Ranges': 'bytes'
    });
    res.end();
    return;
  }

  const total = st.size;
  const rangeHeader = req.headers['range'];
  const baseHeaders = {
    'Content-Type': mime,
    'ETag': etag,
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString()
  };

  /* ---- 无 Range：完整响应 ---- */
  if (!rangeHeader) {
    res.writeHead(statusHint || 200, Object.assign({}, baseHeaders, {
      'Content-Length': total
    }));
    if (req.method === 'HEAD') { res.end(); return; }

    const rs = fs.createReadStream(file);
    rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    rs.pipe(res);
    return;
  }

  /* ---- 有 Range：解析 bytes=a-b ---- */
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) {
    res.writeHead(416, Object.assign({}, baseHeaders, {
      'Content-Range': 'bytes */' + total
    }));
    res.end();
    return;
  }

  let start;
  let end;

  if (m[1] === '' && m[2] === '') {
    res.writeHead(416, Object.assign({}, baseHeaders, {
      'Content-Range': 'bytes */' + total
    }));
    res.end();
    return;
  } else if (m[1] === '') {
    // bytes=-N → 最后 N 字节
    const suffix = parseInt(m[2], 10);
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
  }

  if (isNaN(start) || isNaN(end) || start > end || start >= total) {
    res.writeHead(416, Object.assign({}, baseHeaders, {
      'Content-Range': 'bytes */' + total
    }));
    res.end();
    return;
  }

  if (end >= total) end = total - 1;

  res.writeHead(206, Object.assign({}, baseHeaders, {
    'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    'Content-Length': end - start + 1
  }));

  if (req.method === 'HEAD') { res.end(); return; }

  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  rs.pipe(res);
}

/* ==========================================================================
   请求体读取
   ========================================================================== */

/**
 * 读取 JSON body（带 1MB 上限）。
 * @param {http.IncomingMessage} req
 * @returns {Promise<{ok:true,value:any}|{ok:false,code:number,error:string,message:string}>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;

    function finish(v) { if (!done) { done = true; resolve(v); } }

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        finish({ ok: false, code: 413, error: 'PAYLOAD_TOO_LARGE', message: '请求体超过 1MB' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (size === 0) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, code: 400, error: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
      }
    });

    req.on('error', () => {
      finish({ ok: false, code: 400, error: 'BAD_REQUEST', message: '读取请求体失败' });
    });

    req.on('aborted', () => {
      finish({ ok: false, code: 400, error: 'BAD_REQUEST', message: '请求被中断' });
    });
  });
}

/* ==========================================================================
   音乐
   ========================================================================== */

/**
 * 列出 music/ 下的音频文件。
 * @returns {Array<{name:string,url:string,size:number}>}
 */
function listMusic() {
  let names = [];
  try {
    names = fs.readdirSync(MUSIC_DIR);
  } catch {
    return [];
  }

  const tracks = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) continue;

    let size = 0;
    try { size = fs.statSync(path.join(MUSIC_DIR, name)).size; } catch { continue; }
    // 0 字节的 mp3（下载中断、空文件）直接跳过，否则播放器会卡在加载中
    if (size <= 0) {
      warn(`音乐文件 ${name} 是空的，已跳过`);
      continue;
    }

    tracks.push({
      name,
      url: '/music/' + encodeURIComponent(name),
      size
    });
  }

  tracks.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return tracks;
}

/* ==========================================================================
   终端日志
   ========================================================================== */

/**
 * 是否启用 ANSI 颜色。
 * Windows 10 早期版本的 conhost 不渲染转义序列，会把 \x1b[31m 之类的颜色码
 * 原样打印成乱码；Windows Terminal / VS Code 终端则正常。
 * 规则：win32 默认关（除非新终端或显式 --color / FORCE_COLOR=1），其它平台
 * 按 TTY 判断；NO_COLOR=1 一律关。只影响终端观感，不影响任何功能与日志落盘。
 * @returns {boolean}
 */
function shouldUseColor() {
  if (process.env.NO_COLOR === '1') return false;
  if (process.argv.includes('--color') || process.env.FORCE_COLOR === '1') return true;
  if (!process.stdout || !process.stdout.isTTY) return false;
  if (process.platform === 'win32') {
    return Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
  }
  return true;
}

const C = shouldUseColor()
  ? {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m'
    }
  : { reset: '', dim: '', bold: '', red: '', green: '', yellow: '', cyan: '' };

function log(msg) {
  console.log(`${C.cyan}·${C.reset} ${msg}`);
}
function warn(msg) {
  console.log(`${C.yellow}!${C.reset} ${msg}`);
}
function errLog(msg) {
  console.log(`${C.red}✗${C.reset} ${msg}`);
}

/* --------------------------------------------------------------------------
   日志落盘
   --------------------------------------------------------------------------
   现场出问题时人往往不在电脑前，回头只看到终端被关掉了、什么都没留下。
   这里把终端输出原样（去掉颜色）再写一份到 logs/server-YYYY-MM-DD.log，
   一天一个文件，出问题把文件发过来就能定位。写盘失败绝不阻断服务。
   -------------------------------------------------------------------------- */

/** @type {fs.WriteStream|null} */
let logStream = null;

/** 去掉 ANSI 转义序列 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * 打开当天的日志文件。
 * @returns {void}
 */
function openLog() {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    logStream = fs.createWriteStream(path.join(LOGS_DIR, `server-${day}.log`), { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch {
    logStream = null;
  }
}

/**
 * 原样转发一份到日志文件。
 * @param {...any} parts
 */
function toLogFile(parts) {
  if (!logStream) return;
  try {
    const line = parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ');
    logStream.write(line.replace(ANSI_RE, '') + '\n');
  } catch {
    /* 忽略 */
  }
}

for (const name of ['log', 'warn', 'error']) {
  const original = console[name].bind(console);
  console[name] = (...parts) => {
    toLogFile(parts);
    original(...parts);
  };
}

/**
 * 兜底：任何漏网的异常都不许把服务打挂 —— 大屏正播着呢。
 */
function installGlobalGuards() {
  process.on('uncaughtException', (e) => {
    errLog('未捕获异常（服务继续运行）：' + (e && e.stack ? e.stack : e));
  });

  process.on('unhandledRejection', (reason) => {
    errLog('未处理的 Promise 拒绝（服务继续运行）：'
      + (reason && reason.stack ? reason.stack : reason));
  });
}

/* ==========================================================================
   接口路由
   ========================================================================== */

/**
 * GET /api/photos
 */
function handleGetPhotos(req, res) {
  const photos = getPhotos();
  ok(res, { total: photos.length, photos });
}

/**
 * POST /api/photos?name=&w=&h=
 * 请求体为原始二进制图片流。
 */
function handleUpload(req, res, query) {
  // 1) 照片总数上限
  const existing = listPhotoFiles();
  if (existing.length >= MAX_PHOTOS) {
    fail(res, 400, 'TOO_MANY_PHOTOS', `照片数量已达上限 ${MAX_PHOTOS}`);
    return;
  }

  // 2) 文件名清洗
  const rawName = query.get('name');
  if (!rawName) {
    fail(res, 400, 'BAD_REQUEST', '缺少 name 参数');
    return;
  }

  let id = sanitizePhotoName(rawName);
  if (!id) {
    // 清洗后为空 → 用时间戳兜底
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    id = `photo-${stamp}.jpg`;
  }
  id = uniquePhotoId(id);

  // 3) Content-Length 上限
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    fail(res, 413, 'PAYLOAD_TOO_LARGE',
      `单张照片不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
    req.destroy();
    return;
  }

  const tmpPath = path.join(PHOTOS_DIR, `.upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  const finalPath = path.join(PHOTOS_DIR, id);

  let ws;
  try {
    ws = fs.createWriteStream(tmpPath);
  } catch (e) {
    fail(res, 500, 'WRITE_FAILED', '无法创建临时文件');
    return;
  }

  let received = 0;
  let head = null;
  let aborted = false;
  let finished = false;

  /** 清理临时文件（幂等） */
  function cleanupTmp() {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  function bail(code, error, message) {
    if (finished) return;
    finished = true;
    aborted = true;
    try { req.unpipe(ws); } catch { /* ignore */ }
    try { ws.destroy(); } catch { /* ignore */ }
    cleanupTmp();
    if (!res.headersSent) fail(res, code, error, message);
  }

  req.on('data', (chunk) => {
    received += chunk.length;

    // 体积兜底（客户端没给 Content-Length 的分块上传）
    if (received > MAX_UPLOAD_BYTES) {
      bail(413, 'PAYLOAD_TOO_LARGE',
        `单张照片不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
      return;
    }

    // 首个数据块校验魔数
    if (!head) {
      head = chunk.subarray(0, 16);
      if (!isImageMagic(head)) {
        bail(400, 'BAD_IMAGE', '上传的内容不是有效的图片文件');
      }
    }
  });

  req.on('aborted', () => {
    if (finished) return;
    finished = true;
    aborted = true;
    try { ws.destroy(); } catch { /* ignore */ }
    cleanupTmp();
  });

  req.on('error', () => {
    if (finished) return;
    finished = true;
    aborted = true;
    try { ws.destroy(); } catch { /* ignore */ }
    cleanupTmp();
  });

  ws.on('error', () => {
    if (finished) return;
    finished = true;
    cleanupTmp();
    if (!res.headersSent) fail(res, 500, 'WRITE_FAILED', '写入照片失败，请重试');
  });

  ws.on('finish', () => {
    if (finished || aborted) return;

    if (received === 0) {
      finished = true;
      cleanupTmp();
      fail(res, 400, 'EMPTY_BODY', '上传内容为空');
      return;
    }

    try {
      fs.renameSync(tmpPath, finalPath);
    } catch {
      finished = true;
      cleanupTmp();
      fail(res, 500, 'WRITE_FAILED', '保存照片失败，请重试');
      return;
    }

    finished = true;

    // 尺寸：优先用客户端传的，否则从文件头探测
    let w = parseInt(query.get('w'), 10);
    let h = parseInt(query.get('h'), 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      const dim = probeFileSize(finalPath);
      w = dim ? dim.w : null;
      h = dim ? dim.h : null;
    } else {
      w = w || null;
      h = h || null;
    }

    let size = 0;
    try { size = fs.statSync(finalPath).size; } catch { /* ignore */ }

    const item = {
      w,
      h,
      aspect: (w && h) ? Number((w / h).toFixed(4)) : null,
      size,
      addedAt: new Date().toISOString()
    };

    try {
      const m = loadManifest();
      m.items[id] = item;
      if (!m.order.includes(id)) m.order.push(id);
      saveManifest(m);
    } catch (e) {
      errLog('更新 manifest 失败：' + e.message);
      // 文件已经落盘，列表会在下次 GET 时自愈，不算彻底失败
    }

    ok(res, {
      id,
      url: '/photos/' + encodeURIComponent(id),
      w: item.w,
      h: item.h,
      aspect: item.aspect,
      size: item.size,
      addedAt: item.addedAt
    });
  });

  // 真正开始接收
  req.pipe(ws);
}

/**
 * DELETE /api/photos/:id
 */
function handleDelete(res, idRaw) {
  const id = sanitizePhotoName(idRaw) || String(idRaw || '');

  // 路径穿越防护：清洗后必须仍是 basename
  if (!id || path.basename(id) !== id || id.includes('..') || /[/\\\0]/.test(id)) {
    fail(res, 400, 'BAD_REQUEST', '非法的照片 id');
    return;
  }

  const full = path.join(PHOTOS_DIR, id);
  if (!full.startsWith(PHOTOS_DIR + path.sep)) {
    fail(res, 400, 'BAD_REQUEST', '非法的照片 id');
    return;
  }

  if (!fs.existsSync(full)) {
    fail(res, 404, 'NOT_FOUND', '照片不存在');
    return;
  }

  try {
    fs.unlinkSync(full);
  } catch (e) {
    fail(res, 500, 'WRITE_FAILED', '删除照片失败：' + e.message);
    return;
  }

  let total = 0;
  try {
    const m = loadManifest();
    delete m.items[id];
    m.order = m.order.filter((x) => x !== id);
    saveManifest(m);
    total = listPhotoFiles().length;
  } catch (e) {
    errLog('更新 manifest 失败：' + e.message);
    total = listPhotoFiles().length;
  }

  ok(res, { id, deleted: true, total });
}

/**
 * PUT /api/photos/order
 */
async function handleOrder(req, res) {
  const body = await readJsonBody(req);
  if (!body.ok) { fail(res, body.code, body.error, body.message); return; }

  const ids = body.value && body.value.ids;
  if (!Array.isArray(ids)) {
    fail(res, 400, 'BAD_REQUEST', 'ids 必须是数组');
    return;
  }

  const m = loadManifest();
  const known = new Set(listPhotoFiles());
  const knownInItems = new Set(Object.keys(m.items));

  const ignored = [];
  const next = [];
  const seen = new Set();

  for (const raw of ids) {
    if (typeof raw !== 'string') { ignored.push(String(raw)); continue; }
    if (seen.has(raw)) continue;
    seen.add(raw);

    if (!known.has(raw) && !knownInItems.has(raw)) { ignored.push(raw); continue; }
    if (!known.has(raw)) { ignored.push(raw); continue; }   // 磁盘上没有的忽略

    next.push(raw);
  }

  // ids 未覆盖到的照片按原顺序追加，保证不丢
  for (const id of m.order) {
    if (!seen.has(id) && known.has(id)) { next.push(id); seen.add(id); }
  }
  for (const id of known) {
    if (!seen.has(id)) { next.push(id); seen.add(id); }
  }

  m.order = next;
  saveManifest(m);

  ok(res, { order: next, count: next.length, ignored });
}

/**
 * POST /api/photos/clear?confirm=1
 */
function handleClear(res, query) {
  if (query.get('confirm') !== '1') {
    fail(res, 400, 'BAD_REQUEST', '清空操作需要 confirm=1 确认');
    return;
  }

  let deleted = 0;
  for (const name of listPhotoFiles()) {
    try {
      fs.unlinkSync(path.join(PHOTOS_DIR, name));
      deleted++;
    } catch (e) {
      errLog(`删除 ${name} 失败：${e.message}`);
    }
  }

  const m = loadManifest();
  m.order = [];
  m.items = {};
  saveManifest(m);

  ok(res, { deleted, total: listPhotoFiles().length });
}

/**
 * PUT /api/config
 */
async function handlePutConfig(req, res) {
  const body = await readJsonBody(req);
  if (!body.ok) { fail(res, body.code, body.error, body.message); return; }

  const patch = body.value;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail(res, 400, 'BAD_REQUEST', '配置必须是一个 JSON 对象');
    return;
  }

  const merged = deepMerge(config, patch);
  const checked = validateConfig(merged);

  if (!checked.ok) {
    fail(res, 400, 'INVALID_CONFIG', checked.message);
    return;
  }

  try {
    saveConfigFile(checked.value);
  } catch (e) {
    fail(res, 500, 'WRITE_FAILED', '保存配置失败：' + e.message);
    return;
  }

  ok(res, checked.value);
}

/**
 * GET /api/music
 */
function handleGetMusic(res) {
  const tracks = listMusic();
  const wanted = config.music && config.music.track;

  let active = null;
  if (wanted && tracks.some((t) => t.name === wanted)) {
    active = wanted;
  } else if (tracks.length > 0) {
    active = tracks[0].name;
  }

  ok(res, { tracks, active });
}

/* ==========================================================================
   请求分发
   ========================================================================== */

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // 统一的宽松 CORS（本机使用，不开放外网）
  res.setHeader('X-Content-Type-Options', 'nosniff');

  /* ---------------- /api/* ---------------- */
  if (pathname.startsWith('/api/')) {
    const route = pathname.replace(/\/+$/, '');

    // GET /api/photos
    if (route === '/api/photos') {
      if (method === 'GET' || method === 'HEAD') return handleGetPhotos(req, res);
      if (method === 'POST') return handleUpload(req, res, url.searchParams);
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '该接口只支持 GET / POST');
    }

    // DELETE /api/photos/:id
    if (route.startsWith('/api/photos/')) {
      const tail = route.slice('/api/photos/'.length);

      if (tail === 'order') {
        if (method === 'PUT') return handleOrder(req, res);
        return fail(res, 405, 'METHOD_NOT_ALLOWED', '排序接口只支持 PUT');
      }

      if (tail === 'clear') {
        if (method === 'POST') return handleClear(res, url.searchParams);
        return fail(res, 405, 'METHOD_NOT_ALLOWED', '清空接口只支持 POST');
      }

      if (method === 'DELETE') {
        let id;
        try { id = decodeURIComponent(tail); } catch { id = tail; }
        return handleDelete(res, id);
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '该接口只支持 DELETE');
    }

    // /api/config
    if (route === '/api/config') {
      if (method === 'GET' || method === 'HEAD') return ok(res, config);
      if (method === 'PUT') return handlePutConfig(req, res);
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '配置接口只支持 GET / PUT');
    }

    // /api/music
    if (route === '/api/music') {
      if (method === 'GET' || method === 'HEAD') return handleGetMusic(res);
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '音乐接口只支持 GET');
    }

    // /api/addons
    if (route === '/api/addons') {
      if (method === 'GET' || method === 'HEAD') return handleGetAddons(res);
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '插件接口只支持 GET');
    }

    return fail(res, 404, 'NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ---------------- 静态资源 ---------------- */
  if (method !== 'GET' && method !== 'HEAD') {
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET');
  }

  // photos/ 下的 .json 都是程序内部数据（manifest.json 及其备份），一律不对外暴露
  if (pathname.startsWith('/photos/') && path.extname(pathname).toLowerCase() === '.json') {
    return fail(res, 404, 'NOT_FOUND', '文件不存在');
  }

  const resolved = resolveStatic(pathname);
  if (!resolved) {
    return fail(res, 403, 'FORBIDDEN', '非法的资源路径');
  }

  if (!fs.existsSync(resolved.file)) {
    // 目录不存在或文件缺失都按 404
    return fail(res, 404, 'NOT_FOUND', '资源不存在：' + pathname);
  }

  return sendFile(req, res, resolved.file, 200);
}

/* ==========================================================================
   目录准备与启动
   ========================================================================== */

/**
 * 确保运行所需的目录都存在。
 */
function ensureDirs() {
  const dirs = [
    PUBLIC_DIR,
    PHOTOS_DIR,
    MUSIC_DIR,
    ADDONS_DIR,      // 插件目录：没有插件也建出来，方便用户直接往里放
    LOGS_DIR,        // 运行日志
    path.join(ROOT, 'tests')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * 在一个端口上尝试监听。
 * @param {number} port
 * @returns {Promise<http.Server>}
 */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve()
        .then(() => handleRequest(req, res))
        .catch((err) => {
          errLog('未捕获异常：' + (err && err.stack ? err.stack : err));
          if (!res.headersSent) {
            try { fail(res, 500, 'INTERNAL', '服务器内部错误'); } catch { /* ignore */ }
          } else {
            try { res.end(); } catch { /* ignore */ }
          }
        });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(err);
      else reject(err);
    });

    server.listen(port, HOST, () => resolve(server));
  });
}

/**
 * 依次尝试 8787 → 8797，返回成功监听的 server 与端口。
 * @returns {Promise<{server:http.Server, port:number}>}
 */
async function listenWithFallback() {
  let lastErr = null;

  for (let i = 0; i < PORT_TRIES; i++) {
    const port = PORT_START + i;
    try {
      const server = await listenOn(port);
      return { server, port };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EADDRINUSE') {
        warn(`端口 ${port} 已被占用，尝试 ${port + 1} …`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('没有可用端口');
}

/**
 * 打开默认浏览器。
 * @param {string} url
 */
function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;

  const platform = os.platform();
  let cmd;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "" "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) warn('自动打开浏览器失败，请手动访问：' + url);
  });
}

/**
 * 启动入口。
 */
async function main() {
  console.log('');
  console.log(`${C.bold}  年会爱心墙${C.reset}  ${C.dim}Heart Wall${C.reset}`);
  console.log(`${C.dim}  ──────────────────────────────────────${C.reset}`);

  ensureDirs();
  openLog();
  installGlobalGuards();

  loadConfig();
  loadManifest();                 // 不存在则生成
  loadAddons();                   // addons/ 不存在或为空则什么都不做

  const { server, port } = await listenWithFallback();
  const base = `http://${HOST}:${port}`;

  const photoCount = listPhotoFiles().length;
  const target = photoCount > 0 ? base + '/' : base + '/admin';

  console.log('');
  log(`服务已启动      ${C.bold}${base}${C.reset}`);
  log(`播放页          ${base}/`);
  log(`管理台          ${base}/admin`);
  log(`照片数量        ${photoCount} 张`);
  log(`音乐文件        ${listMusic().length} 首${listMusic().length === 0 ? '（静音运行）' : ''}`);
  if (addons.length > 0) {
    log(`已启用插件      ${addons.map((a) => `${a.name} v${a.version}`).join('、')}`);
  }

  if (photoCount === 0) {
    warn('photos/ 目录还是空的，已为你打开管理台上传照片');
  }

  console.log('');
  console.log(`${C.dim}  按 Ctrl+C 停止服务${C.reset}`);
  console.log('');

  openBrowser(target);

  // 优雅退出
  const shutdown = () => {
    console.log('\n正在停止服务 …');
    server.close(() => process.exit(0));
    // 兜底：2s 内没关完就强退
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  errLog('启动失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
