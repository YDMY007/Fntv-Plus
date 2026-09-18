/**
 * Fntv-Plus 匿名统计 / 反馈 —— 腾讯云函数 SCF（事件函数 + 函数 URL）
 *
 * 为什么是这套：CloudBase 免费体验版不支持 HTTP 访问服务（购买页明示），
 * 而 SCF 的「函数 URL」白送 HTTPS 端点、国内直连、按量计费无固定月费。
 *
 * 对外接口与 Cloudflare / CloudBase 版完全一致，客户端只换 endpoint：
 *   POST /ping      匿名心跳（每天一次）
 *   POST /feedback  Bug 反馈 / 日志上传
 *   GET  /stats     作者看数据（token 鉴权）
 *   GET  /stats/log 取回某条反馈的日志
 *
 * ── 存储：对象存储 COS（不走数据库，最省）──
 *   ping/<YYYY-MM-DD>.json     当天去重后的 aid 列表 + 版本/系统计数
 *   feedback/<ts>-<id>.json    反馈全文（含日志，封顶 3MB）
 *
 * ── 省钱：与 CloudBase 版同思路 —— 心跳在函数实例内存里攒够 50 条或 30 秒才落一次盘，
 *    COS 的 PUT/GET 都是 0.01 元/万次，这个量级基本等于免费。
 *
 * ── 权限：用云函数**运行角色**自动注入的临时密钥（TENCENTCLOUD_SECRETID/KEY/SESSIONTOKEN）
 *    访问 COS，代码里不出现任何长期密钥。
 *
 * ── 隐私：不读不存 IP、不读 UA；只存 aid/版本/系统/架构/日期。
 */

const COS = require('cos-nodejs-sdk-v5');

const BUCKET = process.env.COS_BUCKET || '';
const REGION = process.env.COS_REGION || 'ap-shanghai';

const FLUSH_SIZE = 50;
const FLUSH_MS = 30000;
const SEEN_MAX = 50000;
const MAX_LOG = 3 * 1024 * 1024;

const RE_AID = /^[0-9a-fA-F-]{8,64}$/;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

let cosClient = null;
function getCos() {
  if (!cosClient) {
    cosClient = new COS({
      SecretId: process.env.TENCENTCLOUD_SECRETID,
      SecretKey: process.env.TENCENTCLOUD_SECRETKEY,
      SecurityToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
    });
  }
  return cosClient;
}

const buf = [];
const seen = new Set();
let lastFlush = Date.now();

function clamp(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function today() {
  const d = new Date(Date.now() + 8 * 3600000); // 固定按北京时间算「一天」
  return d.toISOString().slice(0, 10);
}

function dayPlausible(day) {
  if (!RE_DAY.test(day)) return false;
  return Math.abs(Date.now() - Date.parse(day + 'T00:00:00Z')) / 86400000 <= 3;
}

/* ---------- COS 原语 ---------- */

function putJson(key, obj) {
  return new Promise((resolve, reject) => {
    getCos().putObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
      Body: Buffer.from(JSON.stringify(obj), 'utf8'),
      ContentType: 'application/json',
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function getJson(key) {
  return new Promise((resolve) => {
    getCos().getObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
    }, (err, data) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse((data.Body || '').toString('utf8'))); } catch (_) { resolve(null); }
    });
  });
}

function listKeys(prefix, max = 1000) {
  return new Promise((resolve) => {
    getCos().getBucket({
      Bucket: BUCKET,
      Region: REGION,
      Prefix: prefix,
      MaxKeys: max,
    }, (err, data) => {
      if (err) return resolve([]);
      resolve(((data && data.Contents) || []).map((x) => x.Key));
    });
  });
}

/* ---------- 心跳落盘 ---------- */

async function flush() {
  if (buf.length === 0) { lastFlush = Date.now(); return; }
  const batch = buf.splice(0, buf.length);
  lastFlush = Date.now();
  if (!BUCKET) return;

  const day = batch[0].day;
  const key = `ping/${day}.json`;
  // 读-改-写：写入间隔至少 30 秒，撞车概率极低；失败重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = (await getJson(key)) || { aids: [], versions: {}, systems: {} };
    const set = new Set(cur.aids || []);
    const versions = cur.versions || {};
    const systems = cur.systems || {};
    for (const b of batch) {
      set.add(b.aid);
      if (b.ver) versions[b.ver] = (versions[b.ver] || 0) + 1;
      const osKey = b.os || 'unknown';
      systems[osKey] = (systems[osKey] || 0) + 1;
    }
    const next = { aids: Array.from(set), versions, systems, updatedAt: new Date().toISOString() };
    try {
      await putJson(key, next);
      return;
    } catch (_) { /* 重试一次 */ }
  }
}

function needFlush() {
  return buf.length >= FLUSH_SIZE || (buf.length > 0 && Date.now() - lastFlush > FLUSH_MS);
}

/* ---------- 业务 ---------- */

async function handlePing(body) {
  const aid = clamp(body.aid, 64);
  const day = clamp(body.d, 10);
  if (!RE_AID.test(aid) || !dayPlausible(day)) return err(400, 'bad payload');

  const key = aid + '_' + day;
  if (seen.has(key)) return ok({ ok: true, dedup: 'memory' });
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.add(key);

  if (buf.length === 0) lastFlush = Date.now();
  buf.push({ aid, day, ver: clamp(body.v, 32), os: clamp(body.os, 16), arch: clamp(body.arch, 16) });
  if (needFlush()) await flush();
  return ok({ ok: true });
}

async function handleFeedback(body) {
  const message = clamp(body.message, 4000).trim();
  if (!message) return err(400, 'empty message');
  if (!BUCKET) return err(500, 'COS_BUCKET not configured');
  const id = require('crypto').randomUUID();
  const ts = new Date().toISOString();
  const doc = {
    id, ts,
    aid: RE_AID.test(clamp(body.aid, 64)) ? clamp(body.aid, 64) : '',
    ver: clamp(body.v, 32), os: clamp(body.os, 16), arch: clamp(body.arch, 16),
    contact: clamp(body.contact, 200),
    hasLog: typeof body.log === 'string' && body.log ? 1 : 0,
    log: typeof body.log === 'string' ? body.log.slice(0, MAX_LOG) : '',
    message,
  };
  try {
    await putJson(`feedback/${Date.parse(ts)}-${id}.json`, doc);
  } catch (_) {
    return err(500, 'storage error');
  }
  return ok({ ok: true, id });
}

/** 列举近 N 天心跳并合并去重 */
async function collectDays(days) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    keys.push(`ping/${new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10)}.json`);
  }
  const aids = new Set();
  const versions = {};
  const systems = {};
  const perDay = {};
  // 分批并发，避免一次打太多请求
  for (let i = 0; i < keys.length; i += 10) {
    const chunk = keys.slice(i, i + 10);
    const docs = await Promise.all(chunk.map((k) => getJson(k)));
    docs.forEach((doc, idx) => {
      if (!doc) return;
      const day = chunk[idx].slice(5, 15);
      perDay[day] = (doc.aids || []).length;
      (doc.aids || []).forEach((a) => aids.add(a));
      for (const [k, v] of Object.entries(doc.versions || {})) versions[k] = (versions[k] || 0) + v;
      for (const [k, v] of Object.entries(doc.systems || {})) systems[k] = (systems[k] || 0) + v;
    });
  }
  return { aids, versions, systems, perDay };
}

async function handleStats(event) {
  const qs = query(event);
  if (!process.env.STATS_TOKEN || qs.token !== process.env.STATS_TOKEN) return err(403, 'forbidden');
  const days = Math.min(365, Math.max(1, parseInt(qs.days || '30', 10) || 30));

  const { aids, versions, systems, perDay } = await collectDays(days);
  const dayKey = (offset) => new Date(Date.now() + 8 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
  const inRange = (fromOffset, toOffset) => {
    let c = 0;
    for (const [d, n] of Object.entries(perDay)) {
      const idx = Math.round((Date.parse(dayKey(0) + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
      if (idx >= fromOffset && idx <= toOffset) c += n;
    }
    return c;
  };

  const fbKeys = (await listKeys('feedback/', 1000)).sort().reverse();
  const recentDocs = await Promise.all(fbKeys.slice(0, 20).map((k) => getJson(k)));

  return ok({
    ok: true,
    range: { days, from: dayKey(days - 1), to: dayKey(0) },
    users: {
      distinct: aids.size,          // 该时间范围内去重人数
      today: perDay[dayKey(0)] || 0,
      last7Sum: inRange(0, 6),
      last30Sum: inRange(0, 29),
    },
    versions: Object.entries(versions).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ver, c]) => ({ ver, c })),
    systems: Object.entries(systems).sort((a, b) => b[1] - a[1]).map(([os, c]) => ({ os, c })),
    feedbackCount: fbKeys.length,
    recentFeedback: recentDocs.filter(Boolean).map((x) => ({
      id: x.id, ts: x.ts, ver: x.ver, os: x.os, hasLog: x.hasLog, msg: String(x.message || '').slice(0, 160),
    })),
    _note: 'distinct=该范围内去重人数; today/last7Sum/last30Sum 为人次(按天相加)',
  });
}

async function handleStatsLog(event) {
  const qs = query(event);
  if (!process.env.STATS_TOKEN || qs.token !== process.env.STATS_TOKEN) return err(403, 'forbidden');
  const id = String(qs.id || '');
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return err(400, 'bad id');
  const keys = await listKeys('feedback/', 1000);
  const hit = keys.find((k) => k.endsWith(`-${id}.json`));
  if (!hit) return err(404, 'not found');
  const doc = await getJson(hit);
  return {
    statusCode: 200,
    headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
    body: (doc && doc.log) || '',
  };
}

/* ---------- 入口 ---------- */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST,GET,OPTIONS',
  'content-type': 'application/json; charset=utf-8',
};
const ok = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
const err = (status, msg) => ({ statusCode: status, headers: CORS, body: JSON.stringify({ error: msg }) });

/** 函数 URL / 事件函数：SCF 把 HTTP 请求塞进 event（queryString）；兼容 queryStringParameters */
function query(event) {
  const q = event.queryString || event.queryStringParameters || {};
  const out = {};
  for (const [k, v] of Object.entries(q)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { raw = ''; }
  }
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

exports.main_handler = async (event) => {
  // 函数 URL 触发时 event 含 path/httpMethod；事件函数直接调用时无 path → 视为健康检查
  const path = String((event && (event.path || event.rawPath)) || '/').replace(/\/+$/, '') || '/';
  const method = String((event && event.httpMethod) || 'POST').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (path.endsWith('/ping')) return handlePing(parseBody(event));
  if (path.endsWith('/feedback')) return handleFeedback(parseBody(event));
  if (path.endsWith('/stats/log')) return handleStatsLog(event);
  if (path.endsWith('/stats')) return handleStats(event);
  if (path === '/') return ok({ ok: true, service: 'fntv-stats', time: new Date().toISOString() });
  return err(404, 'not found');
};
