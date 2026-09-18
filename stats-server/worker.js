/**
 * Fntv-Plus —— 匿名统计 / 反馈接收端（Cloudflare Worker，单文件）
 *
 * 隐私底线（改代码时请一并遵守）：
 *  1. 不读、不存、不打日志任何 IP（request.headers 里的 cf-connecting-ip / x-forwarded-for 一律不碰）。
 *  2. 不读 User-Agent。
 *  3. /ping 只接收 4 个字段：匿名 ID、版本号、系统、架构 + 日期；多余字段一律丢弃。
 *  4. 按 (匿名ID, 日期) 主键去重 —— 只能聚合出「人数」，无法还原个体行为轨迹。
 *  5. /stats 需要 token，不对外公开。
 *
 * 绑定：DB（D1）、LOGS（R2，存反馈附带日志）、STATS_TOKEN（secret）
 */

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST,GET,OPTIONS',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

const RE_AID = /^[0-9a-fA-F-]{8,64}$/;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

function clamp(str, max) {
  return typeof str === 'string' ? str.slice(0, max) : '';
}

/** 只接受今天 ±2 天的日期，避免有人灌历史数据 / 未来数据 */
function dayPlausible(day) {
  if (!RE_DAY.test(day)) return false;
  const diff = Math.abs(Date.now() - Date.parse(day + 'T00:00:00Z')) / 86400000;
  return diff <= 2;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);

    if (url.pathname === '/ping' && request.method === 'POST') return handlePing(request, env);
    if (url.pathname === '/feedback' && request.method === 'POST') return handleFeedback(request, env);
    if (url.pathname === '/stats' && request.method === 'GET') return handleStats(url, env);
    if (url.pathname === '/stats/log' && request.method === 'GET') return handleStatsLog(url, env);

    return json({ error: 'not found' }, 404);
  },
};

/** 客户端每天一次的匿名心跳 */
async function handlePing(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const aid = clamp(body.aid, 64);
  const day = clamp(body.d, 10);
  if (!RE_AID.test(aid) || !dayPlausible(day)) return json({ error: 'bad payload' }, 400);

  const ver = clamp(body.v, 32);
  const os = clamp(body.os, 16);
  const arch = clamp(body.arch, 16);

  try {
    // 同一天重复上报直接忽略 —— 这是「人数」而非「次数」的关键
    await env.DB.prepare(
      'INSERT OR IGNORE INTO ping (aid, day, ver, os, arch) VALUES (?, ?, ?, ?, ?)'
    ).bind(aid, day, ver, os, arch).run();
  } catch (e) {
    return json({ error: 'db error' }, 500);
  }
  return json({ ok: true });
}

/** Bug 反馈（含可选日志正文） */
async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const message = clamp(body.message, 4000).trim();
  if (!message) return json({ error: 'empty message' }, 400);
  const contact = clamp(body.contact, 200);
  const logText = typeof body.log === 'string' ? body.log.slice(0, 3 * 1024 * 1024) : '';
  const aid = RE_AID.test(clamp(body.aid, 64)) ? clamp(body.aid, 64) : '';

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const hasLog = logText ? 1 : 0;

  try {
    if (hasLog && env.LOGS) {
      await env.LOGS.put(`logs/${id}.log`, logText, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
    }
    await env.DB.prepare(
      'INSERT INTO feedback (id, ts, aid, ver, os, arch, contact, has_log, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, ts, aid, clamp(body.v, 32), clamp(body.os, 16), clamp(body.arch, 16), contact, hasLog, message).run();
  } catch (e) {
    return json({ error: 'db error' }, 500);
  }
  return json({ ok: true, id });
}

/** 作者查看统计：/stats?token=xxx */
async function handleStats(url, env) {
  if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) {
    return json({ error: 'forbidden' }, 403);
  }
  const day = (offsetDays) => {
    const d = new Date(Date.now() - offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const [total, d1, d7, d30, daily, versions, systems, fb, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT aid) AS c FROM ping').first(),
    env.DB.prepare('SELECT COUNT(DISTINCT aid) AS c FROM ping WHERE day >= ?').bind(day(0)).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT aid) AS c FROM ping WHERE day >= ?').bind(day(6)).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT aid) AS c FROM ping WHERE day >= ?').bind(day(29)).first(),
    env.DB.prepare('SELECT day, COUNT(DISTINCT aid) AS c FROM ping WHERE day >= ? GROUP BY day ORDER BY day')
      .bind(day(29)).all(),
    env.DB.prepare('SELECT ver, COUNT(DISTINCT aid) AS c FROM ping GROUP BY ver ORDER BY c DESC LIMIT 10').all(),
    env.DB.prepare('SELECT os, COUNT(DISTINCT aid) AS c FROM ping GROUP BY os ORDER BY c DESC').all(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM feedback').first(),
    env.DB.prepare(
      'SELECT id, ts, ver, os, has_log, substr(message, 1, 160) AS msg FROM feedback ORDER BY ts DESC LIMIT 20'
    ).all(),
  ]);

  return json({
    ok: true,
    users: { total: total.c, today: d1.c, last7: d7.c, last30: d30.c },
    daily: daily.results,
    versions: versions.results,
    systems: systems.results,
    feedbackCount: fb.c,
    recentFeedback: recent.results,
  });
}

/** 作者下载某条反馈附带的日志：/stats/log?id=xxx&token=yyy */
async function handleStatsLog(url, env) {
  if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) {
    return json({ error: 'forbidden' }, 403);
  }
  const id = url.searchParams.get('id') || '';
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id) || !env.LOGS) return json({ error: 'bad id' }, 400);
  const obj = await env.LOGS.get(`logs/${id}.log`);
  if (!obj) return json({ error: 'not found' }, 404);
  return new Response(await obj.text(), {
    headers: { ...corsHeaders, 'content-type': 'text/plain; charset=utf-8' },
  });
}
