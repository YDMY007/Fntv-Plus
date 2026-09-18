/**
 * Fntv-Plus 匿名统计 / 反馈 —— 腾讯云开发 CloudBase 云函数（单文件）
 *
 * 与 Cloudflare 版（../worker.js）对外接口完全一致，客户端只换 endpoint 即可：
 *   POST /ping      匿名心跳（每天一次）
 *   POST /feedback  Bug 反馈 / 日志上传
 *   GET  /stats     作者看数据（token 鉴权）
 *   GET  /stats/log 取回某条反馈的日志
 *
 * ── 省钱核心：资源点里「数据库调用」最贵（200 点/万次 vs 云函数调用 13 点/万次）──
 * 所以这里把 ping 在**函数实例内存里聚合**，攒够 50 条或距上次落库 30 秒才批量写一次，
 * 数据库调用量降到 1/50。代价是实例被回收时最多丢几十条心跳 —— 统计场景完全可接受。
 *
 * 隐私底线（与 CF 版一致）：不读不存 IP、不读 UA，只保留 aid/版本/系统/架构/日期。
 */

const cloudbase = require('@cloudbase/node-sdk');
const { randomUUID } = require('crypto');

const RE_AID = /^[0-9a-fA-F-]{8,64}$/;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

const FLUSH_SIZE = 50;      // 攒够这么多条立即落库
const FLUSH_MS = 30000;     // 或距上次落库超过 30 秒
const SEEN_MAX = 50000;     // 内存去重集合上限，防爆内存
const MAX_LOG = 3 * 1024 * 1024;

let app = null;
let db = null;
function getDb() {
  if (!db) {
    // SYMBOL_CURRENT_ENV = 云函数所在环境；本地/特殊场景可用 ENV_ID 覆盖
    app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV || process.env.ENV_ID });
    db = app.database();
  }
  return db;
}

// 实例级内存缓冲（云函数实例复用期间有效）
const buf = [];
const seen = new Set();
let lastFlush = Date.now();

async function flush() {
  if (buf.length === 0) { lastFlush = Date.now(); return; }
  const list = buf.splice(0, buf.length);
  lastFlush = Date.now();
  const database = getDb();
  try {
    // 批量写入算 1 次数据库调用（关键省钱点）
    await database.collection('ping').add(list);
  } catch (e) {
    // 批量里若撞上已存在的 _id（重复上报）整批会失败 → 退化为逐条写，冲突的忽略
    for (const one of list) {
      try { await database.collection('ping').add(one); } catch (_) { /* 重复，忽略 */ }
    }
  }
}

function needFlush() {
  return buf.length >= FLUSH_SIZE || (buf.length > 0 && Date.now() - lastFlush > FLUSH_MS);
}

function dayPlausible(day) {
  if (!RE_DAY.test(day)) return false;
  return Math.abs(Date.now() - Date.parse(day + 'T00:00:00Z')) / 86400000 <= 2;
}

function clamp(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { raw = ''; }
  }
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST,GET,OPTIONS',
  'content-type': 'application/json; charset=utf-8',
};

const ok = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
const err = (status, msg) => ({ statusCode: status, headers: CORS, body: JSON.stringify({ error: msg }) });

exports.main = async (event) => {
  const path = String(event.path || '').replace(/\/+$/, '') || '/';
  const method = (event.httpMethod || 'POST').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (path.endsWith('/ping')) return method === 'POST' ? handlePing(parseBody(event)) : err(405, 'POST only');
  if (path.endsWith('/feedback')) return method === 'POST' ? handleFeedback(parseBody(event)) : err(405, 'POST only');
  if (path.endsWith('/stats/log')) return handleStatsLog(event);
  if (path.endsWith('/stats')) return handleStats(event);
  return err(404, 'not found');
};

/** 匿名心跳：内存去重 + 批量落库 */
async function handlePing(body) {
  const aid = clamp(body.aid, 64);
  const day = clamp(body.d, 10);
  if (!RE_AID.test(aid) || !dayPlausible(day)) return err(400, 'bad payload');

  const key = aid + '_' + day;
  if (seen.has(key)) return ok({ ok: true, dedup: 'memory' }); // 同实例内重复：0 成本直接返回
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.add(key);

  if (buf.length === 0) lastFlush = Date.now(); // 计时从「本批第一条」起算，避免上批残留时间触发立即落库
  buf.push({
    _id: key,                       // _id = aid_day → 数据库层天然去重，重复写入会失败并被忽略
    aid,
    day,
    ver: clamp(body.v, 32),
    os: clamp(body.os, 16),
    arch: clamp(body.arch, 16),
  });

  if (needFlush()) await flush();
  return ok({ ok: true });
}

/** Bug 反馈（量小，直接写库；日志正文存在同一文档里，不额外开存储） */
async function handleFeedback(body) {
  const message = clamp(body.message, 4000).trim();
  if (!message) return err(400, 'empty message');
  const uuid = randomUUID();
  try {
    await getDb().collection('feedback').add({
      _id: uuid,
      ts: new Date().toISOString(),
      aid: RE_AID.test(clamp(body.aid, 64)) ? clamp(body.aid, 64) : '',
      ver: clamp(body.v, 32),
      os: clamp(body.os, 16),
      arch: clamp(body.arch, 16),
      contact: clamp(body.contact, 200),
      hasLog: typeof body.log === 'string' && body.log ? 1 : 0,
      log: typeof body.log === 'string' ? body.log.slice(0, MAX_LOG) : '',
      message,
    });
  } catch (e) {
    return err(500, 'db error');
  }
  return ok({ ok: true, id: uuid });
}

/** 作者看数据：/stats?token=xxx */
async function handleStats(event) {
  const qs = event.queryStringParameters || {};
  if (!process.env.STATS_TOKEN || qs.token !== process.env.STATS_TOKEN) return err(403, 'forbidden');

  const database = getDb();
  const $ = database.command.aggregate;
  const _ = database.command; // 查询操作符 gte
  const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  // 去重计数：先按 aid 分组，再数分组数
  const distinctCount = async (match) => {
    try {
      let agg = database.collection('ping').aggregate();
      if (match) agg = agg.match(match);
      const r = await agg.group({ _id: '$aid' }).group({ _id: null, c: $.sum(1) }).end();
      return (r.data && r.data[0] && r.data[0].c) || 0;
    } catch (_) { return -1; }
  };

  const [total, today, d7, d30, versions, systems, fbCount, recent] = await Promise.all([
    distinctCount(null),
    distinctCount({ day: _.gte(dayAgo(0)) }),
    distinctCount({ day: _.gte(dayAgo(6)) }),
    distinctCount({ day: _.gte(dayAgo(29)) }),
    (async () => {
      try {
        const r = await database.collection('ping').aggregate()
          .group({ _id: '$ver', c: $.sum(1) }).sort({ c: -1 }).limit(10).end();
        return r.data || [];
      } catch (_) { return []; }
    })(),
    (async () => {
      try {
        const r = await database.collection('ping').aggregate()
          .group({ _id: '$os', c: $.sum(1) }).sort({ c: -1 }).end();
        return r.data || [];
      } catch (_) { return []; }
    })(),
    (async () => { try { return (await database.collection('feedback').count()).total; } catch (_) { return -1; } })(),
    (async () => {
      try {
        const r = await database.collection('feedback').orderBy('ts', 'desc').limit(20)
          .field({ _id: true, ts: true, ver: true, os: true, hasLog: true, message: true }).get();
        return (r.data || []).map((x) => ({ id: x._id, ts: x.ts, ver: x.ver, os: x.os, hasLog: x.hasLog, msg: String(x.message || '').slice(0, 160) }));
      } catch (_) { return []; }
    })(),
  ]);

  return ok({
    ok: true,
    users: { total, today, last7: d7, last30: d30 },
    versions, systems,
    feedbackCount: fbCount,
    recentFeedback: recent,
  });
}

/** 取回某条反馈的日志：/stats/log?id=xxx&token=yyy */
async function handleStatsLog(event) {
  const qs = event.queryStringParameters || {};
  if (!process.env.STATS_TOKEN || qs.token !== process.env.STATS_TOKEN) return err(403, 'forbidden');
  const id = String(qs.id || '');
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return err(400, 'bad id');
  try {
    const r = await getDb().collection('feedback').doc(id).get();
    const doc = r.data && r.data[0];
    if (!doc) return err(404, 'not found');
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      body: doc.log || '',
    };
  } catch (_) {
    return err(404, 'not found');
  }
}
