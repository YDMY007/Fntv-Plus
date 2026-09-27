// src/shim/electron.js — 浏览器端 electron 垫片（仅 web 注入/演示用）。
// 真实环境由 Fntv-Plus 主进程提供 ipcRenderer；这里用浏览器能力做最小可用实现，
// 让「复用原 preload 代码」无需改写即可在浏览器里跑起来。
//
// 策略：设置类调用（settings:get/set-*）走 localStorage 镜像；其余调用安全 no-op。
// 目的不是 100% 还原客户端行为，而是让被复用的代码能 import、能 boot、能在真实影视页面上渲染。
//
// Authx 签名：桌面端由主进程 fnos-gen-authx 计算；网页端没有主进程，改为回放
// diag.ts 从页面自身请求里捕获的合法签名（item/list 等接口），未捕获到返回空串
// （images.ts/itemListApi 对空值会跳过或由 diag 剥离坏头，靠 cookie 直取同源图片）。

import { getCapturedAuthx } from '../preload/web/diag';
import { ensureSignMaterials } from '../preload/web/signMaterials';
import { md5 } from './md5';

// fnOS 影视 API 鉴权签名（算法与桌面版主进程 fnosAuth.js 完全一致）：
// sign = md5([API_KEY, url, nonce, timestamp, md5(JSON.stringify(data)||''), API_SECRET].join('_'))
// 签名材料不硬编码进本仓库/产物（官方密钥随包分发属审核红线）：网页端注入脚本运行在
// 已登录影视页面内，签名一律回放 diag.ts 捕获到的页面自身合法签名（genAuthx 空材料时
// 直接返回捕获值，未捕获到返回空串 → 上层跳过该头，靠 cookie 直取同源接口）。
function signWith(key, secret, url, data) {
  const nonce = String(Math.floor(Math.random() * (1000000 - 100000) + 100000));
  const timestamp = Date.now().toString();
  const dataJson = data ? JSON.stringify(data) : '';
  const signStr = [key, String(url), nonce, timestamp, md5(dataJson), secret].join('_');
  return 'nonce=' + nonce + '&timestamp=' + timestamp + '&sign=' + md5(signStr);
}

async function genAuthxAsync(url, data) {
  // [lc-1250-web] 运行时提取材料优先：影视 SPA 的 chunk 内嵌 KEY + 自解码 SECRET IIFE，
  // 从用户自己 NAS 的前端资源提取（只驻页面内存，不随包分发、不落盘），本地真签名。
  try {
    const m = await ensureSignMaterials();
    if (m && m.key && m.secret) return signWith(m.key, m.secret, url, data);
  } catch (e) { /* 提取失败走回放 */ }
  // 回放：diag.ts 捕获的页面自身合法签名（body 哈希不一致时服务端会拒绝，仅作兜底）
  return getCapturedAuthx(String(url)) || '';
}

const LS_KEY = 'fntv:electron-settings';

/* ── 观影记录：前端直连 fnOS API 的全库钻取（与桌面版 getWatchedItems 同逻辑）──
 * 此前走后端 /bridge/douban/watched 转发，但后端请求只能携带前端 document.cookie——
 * fnOS 会话凭证（Trim-MC-token）为 httpOnly 时拿不到 → 后端请求未登录 → 空列表。
 * 改为前端直连：credentials:'include' 自动带全部会话 cookie（含 httpOnly）+ 本地 genAuthx
 * 签名，与海报 fetchItemPoster 同款已验证鉴权路径。 */
async function fnosApi(method, path, body) {
  const headers = { 'Authx': await genAuthxAsync(path, body) };
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(location.origin + path, {
    method,
    credentials: 'include',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

async function fnosAnalyzeItem(it) {
  const empty = { totalRuntimeMs: 0, progress: 0, anyWatch: false, started: false, lastPlayed: 0 };
  const lp = it.watched_ts > 0 ? it.watched_ts * 1000 : 0;
  const type = String(it.type || '').toLowerCase();
  if (type === 'movie') {
    const totalSec = it.duration > 0 ? it.duration : (it.runtime > 0 ? it.runtime * 60 : 0);
    if (it.watched === 1) return { totalRuntimeMs: totalSec * 1000, progress: 1, anyWatch: true, started: false, lastPlayed: lp };
    if (it.watched_ts > 0) return { totalRuntimeMs: totalSec * 1000, progress: 0, anyWatch: true, started: true, lastPlayed: lp };
    return empty;
  }
  let totalSec = 0, totalEp = 0, watchedEp = 0;
  const addLeaf = (leaf) => {
    if (leaf.duration > 0) totalSec += leaf.duration;
    else if (leaf.runtime > 0) totalSec += leaf.runtime * 60;
    totalEp++;
    if (leaf.watched === 1) watchedEp++;
  };
  try {
    const ch = await fnosApi('POST', '/v/api/v1/item/list', { parent_guid: it.guid, exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC' });
    const cl = (ch && ch.data && Array.isArray(ch.data.list)) ? ch.data.list : [];
    for (const c of cl) {
      const ct = String(c.type || '').toLowerCase();
      if (ct === 'episode' || ct === 'movie') addLeaf(c);
      else {
        try {
          const eps = await fnosApi('GET', '/v/api/v1/episode/list/' + c.guid);
          ((eps && Array.isArray(eps.data)) ? eps.data : []).forEach(addLeaf);
        } catch (e) { /* 单季失败忽略 */ }
      }
    }
  } catch (e) { /* ignore */ }
  if (totalEp === 0) { // 兜底：单层剧集结构
    try {
      const eps = await fnosApi('GET', '/v/api/v1/episode/list/' + it.guid);
      ((eps && Array.isArray(eps.data)) ? eps.data : []).forEach(addLeaf);
    } catch (e) { /* ignore */ }
  }
  const rtMs = totalSec > 0 ? totalSec * 1000 : (it.runtime > 0 ? it.runtime * 60000 : 0);
  if (it.watched === 1 || (totalEp > 0 && watchedEp === totalEp)) {
    return { totalRuntimeMs: rtMs, progress: 1, anyWatch: true, started: false, lastPlayed: lp };
  }
  if (watchedEp > 0) {
    return { totalRuntimeMs: rtMs, progress: totalEp > 0 ? watchedEp / totalEp : 0, anyWatch: true, started: true, lastPlayed: lp };
  }
  return empty;
}

async function collectWatchedItemsFrontend() {
  try {
    const resp = await fnosApi('POST', '/v/api/v1/item/list', { parent_guid: '', exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC' });
    const list = (resp && resp.data && Array.isArray(resp.data.list)) ? resp.data.list : [];
    if (!list.length) return { items: [], libraryTotal: 0, note: '库列表为空或未登录' };
    const total = resp.data.total;
    const libraryTotal = (typeof total === 'number' && total > list.length) ? total : list.length;
    // 6 并发钻取（与桌面版 mapLimit(list, 6) 一致）
    const results = new Array(list.length);
    let cursor = 0;
    const workers = new Array(6).fill(0).map(async () => {
      while (cursor < list.length) {
        const idx = cursor++;
        const a = await fnosAnalyzeItem(list[idx]);
        results[idx] = { it: list[idx], a };
      }
    });
    await Promise.all(workers);
    const items = results
      .filter((p) => p && p.a.anyWatch)
      .map((p) => {
        const it = p.it, a = p.a;
        return {
          guid: it.guid || '', parent_guid: it.parent_guid || '',
          douban_id: it.douban_id || '', title: it.title || '',
          tv_title: it.tv_title || '', parent_title: it.parent_title || '',
          type: it.type || '', category: '', genres: [],
          air_date: it.air_date || '', release_date: it.release_date || '',
          watched: it.watched || 0, started: a.started ? 1 : 0,
          last_played: a.lastPlayed, progress: a.progress,
          total_runtime_ms: a.totalRuntimeMs,
          fnos_rating: it.vote_average || 0,
          tmdb_rating: 0, tmdb_votes: 0, douban_rating: 0, douban_votes: 0,
        };
      });
    return { items, libraryTotal };
  } catch (e) {
    return { items: [], libraryTotal: 0, note: String((e && e.message) || e) };
  }
}

// [v0.34.0] 浏览器全局兜底：部分桌面插件在模块顶层用 __dirname / require('electron')，
// esbuild 无法静态转换全局引用 → 运行时 ReferenceError 导致整个 IIFE 中断（页面静默变原生）。
// require('electron') 返回本垫片命名空间；__dirname 给出无害占位。
const shimExports = { ipcRenderer: null, shell: null };
try {
  if (typeof window !== 'undefined') {
    if (typeof window.require === 'undefined') {
      window.require = function (id) {
        if (id === 'electron' || id === 'electron/main') return shimExports;
        throw new Error('网页端不支持 Node 模块: ' + id);
      };
    }
    if (typeof window.__dirname === 'undefined') window.__dirname = '/fntv-web';
  }
} catch { /* ignore */ }

// settings:set-<后缀> → 服务端 config 键名映射（与桌面版 config.json 字段名对齐）
const SETTINGS_KEY_MAP = {
  'bangumi-token': 'bangumiToken',
  'bangumi-sync-enabled': 'bangumiSyncEnabled',
  'bangumi-sync-threshold': 'bangumiSyncThreshold',
  'tmdb-key': 'tmdbApiKey',
  'tmdb-direct': 'tmdbDirect',
  'custom-proxy': 'customProxy',
  'wheel-hscroll': 'wheelHScroll',
  'hide-play': 'hideOriginalPlayButton',
  'carousel-logo': 'carouselLogoEnabled',
  'detail-boxless': 'detailBoxless',
  'nas-proxy': 'nasProxyEnabled',
  'download-proxy': 'downloadProxyEnabled',
  'system-page-url': 'systemPageUrl',
  'smart-skip-enabled': 'smartSkipEnabled',
  'dandanplay-credentials': 'dandanplayCredentials',
  'dandanplay-enabled': 'dandanplayEnabled',
  'exit-mode': 'exitMode',
  'custom-version': 'customVersion',
  'debug-enabled': 'debugEnabled',
  'debug-components': 'debugComponents',
  'danmu-api': 'danmuApi',
  'hot-source': 'hotSource',
};

function settingKey(suffix) {
  return SETTINGS_KEY_MAP[suffix] || String(suffix).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function apiGet(path) {
  return fetch(path, { credentials: 'include' }).then((r) => r.json());
}
function apiPost(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    credentials: 'include',
  }).then((r) => r.json());
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}

const ipcRenderer = {
  invoke(channel, ...args) {
    /* ── 设置：服务端持久化（NAS 端 config.json，跨浏览器共享）；失败回退 localStorage 镜像 ── */
    if (channel === 'settings:get') {
      return apiGet('/app/fntvplus/api/settings').catch(() => loadSettings());
    }
    if (typeof channel === 'string' && channel.startsWith('settings:set-')) {
      const key = settingKey(channel.replace('settings:set-', ''));
      // 特例：桌面版 handler 会拆字段的复合设置（键名与桌面 config.json 对齐）
      if (channel === 'settings:set-tmdb-direct') {
        const a = args[0] || {};
        return apiPost('/app/fntvplus/api/settings', {
          tmdbDirectConnect: !!a.enabled,
          tmdbDirectIp: a.ip || null,
        });
      }
      if (channel === 'settings:set-custom-proxy') {
        // 复合设置：(enabled, proxyUrl) → 桌面 config.json 两字段 customProxyEnabled + customProxy。
        // 此前无特例时通用逻辑把 args[0]（enabled 布尔）误存进 customProxy，URL 被丢弃 → 后端永远拿不到代理。
        return apiPost('/app/fntvplus/api/settings', {
          customProxyEnabled: !!args[0],
          customProxy: (typeof args[1] === 'string' ? args[1].trim() : ''),
        });
      }
    if (channel === 'settings:set-danmu-api') {
      // [v0.78.0] 复合设置：{enabled, base} → 两键 danmuApiEnabled + danmuApiBase（桌面 config 同名）。
      // 此前无特例：通用逻辑把 args[0]（整个 payload 对象）存进 danmuApi 单键，地址键从未写入 → 无法保存。
      const a = args[0] || {};
      const base = String(a.base || '').trim().replace(/\/+$/, '');
      return apiPost('/app/fntvplus/api/settings', {
        danmuApiEnabled: !!a.enabled,
        danmuApiBase: base,
      }).then(() => {
        // 桌面同语义：地址非法照样保存，但回校验结论给面板显示
        if (a.enabled && base && !/^https?:\/\/.+/i.test(base)) {
          return { ok: false, error: '地址格式应为 http://IP:端口（如 http://192.168.1.10:9321）' };
        }
        return { ok: true };
      });
    }
      if (channel === 'settings:set-dandanplay-credentials') {
        // 面板传来的是对象 { appId, appSecret }（桌面版 handler 同形）；此前按 args[0]/args[1]
        // 两个字符串读取 → 存进配置的是 "[object Object]"、Secret 为空 → 自定义凭证静默失效。
        const a = args[0] || {};
        return apiPost('/app/fntvplus/api/settings', {
          dandanplayAppId: String(a.appId || '').trim(),
          dandanplayAppSecret: String(a.appSecret || '').trim(),
        });
      }
      const p = apiPost('/app/fntvplus/api/settings', { [key]: args[0] });
      p.then(() => {
        const s = loadSettings();
        s[key] = args[0];
        saveSettings(s);
      }).catch(() => {});
      return p;
    }
    if (typeof channel === 'string' && channel.startsWith('settings:get-')) {
      // 特例：自定义代理回填需要 {enabled, proxyUrl} 复合形状（与桌面版 getCustomProxyConfig 对齐）
      if (channel === 'settings:get-custom-proxy') {
        return apiGet('/app/fntvplus/api/settings').then((s) => {
          const raw = s ? s.customProxy : undefined;
          const u = (typeof raw === 'string') ? raw.trim() : '';
          // dirty：旧版（≤v0.41）把 enabled 布尔误存进 customProxy 键（非字符串），URL 已丢需重填
          return { enabled: !!(s && s.customProxyEnabled) && !!u, proxyUrl: u, dirty: raw != null && typeof raw !== 'string' };
        });
      }
      const key = settingKey(channel.replace('settings:get-', ''));
      return apiGet('/app/fntvplus/api/settings').then((s) => (s && s[key] !== undefined ? s[key] : loadSettings()[key]));
    }

    /* ── Trakt（后端 bridge：设备授权/凭证/scrobble/同步）── */
    if (channel === 'trakt:get-status') return apiGet('/app/fntvplus/api/bridge/trakt/status');
    if (channel === 'trakt:get-credentials') return apiGet('/app/fntvplus/api/bridge/trakt/credentials');
    if (channel === 'trakt:save-credentials') {
      return apiPost('/app/fntvplus/api/bridge/trakt/credentials', { client_id: args[0], client_secret: args[1] });
    }
    if (channel === 'trakt:device-start') {
      // [v1.2.0] 设备授权收尾：桌面版由主进程后台轮询并发 trakt:connected 事件；
      // 网页端无主进程 → shim 在此启动轮询循环（device/token → token 保存 → fire 事件）。
      return apiPost('/app/fntvplus/api/bridge/trakt/device/start', {}).then((r) => {
        if (r && r.device_code && !globalThis.__fntvTraktPoll) {
          const dc = r.device_code;
          const iv = Number(r.interval) > 0 ? Number(r.interval) * 1000 : 5000;
          const fire = (ch, msg) => {
            const map = globalThis.__fntvTraktEvents || {};
            (map[ch] || []).forEach((cb) => { try { cb({}, msg); } catch { /* ignore */ } });
          };
          globalThis.__fntvTraktPoll = setInterval(() => {
            apiPost('/app/fntvplus/api/bridge/trakt/device/token', { device_code: dc }).then((p) => {
              if (p && p.access_token) {
                clearInterval(globalThis.__fntvTraktPoll);
                globalThis.__fntvTraktPoll = null;
                apiPost('/app/fntvplus/api/bridge/trakt/token', {
                  access_token: p.access_token, refresh_token: p.refresh_token, expires_in: p.expires_in,
                }).then(() => fire('trakt:connected', null)).catch(() => fire('trakt:connected', null));
              } else if (p && p.error === 'expired_token') {
                clearInterval(globalThis.__fntvTraktPoll);
                globalThis.__fntvTraktPoll = null;
                fire('trakt:device-error', '设备码已过期，请重新连接');
              } else if (p && p.error === 'access_denied') {
                clearInterval(globalThis.__fntvTraktPoll);
                globalThis.__fntvTraktPoll = null;
                fire('trakt:device-error', '授权被拒绝');
              }
              // p.error === 'authorization_pending' / 'slow_down' → 继续轮询
            }).catch(() => { /* 网络抖动继续 */ });
          }, iv);
        }
        return r;
      });
    }
    if (channel === 'trakt:clear-credentials') return apiPost('/app/fntvplus/api/bridge/trakt/credentials/clear', {});
    if (channel === 'trakt:device-cancel') return apiPost('/app/fntvplus/api/bridge/trakt/device/cancel', {});
    if (channel === 'trakt:disconnect') return apiPost('/app/fntvplus/api/bridge/trakt/disconnect', {});
    if (channel === 'trakt:scrobble') {
      // [v1.2.0] ①前端传对象 {action, guid, progress}（此前按位置参数取值=全 undefined）；②开关拦截
      const sc = (args[0] && typeof args[0] === 'object') ? args[0] : { action: args[0], guid: args[1], progress: args[2] };
      if (loadSettings().traktScrobbleEnabled === false) {
        return Promise.resolve({ ok: false, message: 'scrobble 已关闭' });
      }
      return apiPost('/app/fntvplus/api/bridge/trakt/scrobble', {
        action: sc.action, guid: sc.guid, progress: sc.progress, cookie: document.cookie,
      });
    }
    if (channel === 'trakt:sync-watched') {
      return apiPost('/app/fntvplus/api/bridge/trakt/sync-watched', { cookie: document.cookie });
    }
    if (channel === 'trakt:set-scrobble-enabled') {
      const key = 'traktScrobbleEnabled';
      const p = apiPost('/app/fntvplus/api/settings', { [key]: args[0] });
      p.then(() => {
        const s = loadSettings();
        s[key] = args[0];
        saveSettings(s);
      }).catch(() => {});
      return p;
    }
    if (channel === 'trakt:get-scrobble-enabled') {
      return apiGet('/app/fntvplus/api/settings').then((s) => !!s.traktScrobbleEnabled);
    }

    /* ── TMDB（图片/logo/详情经后端代理，规避 CORS 与网络问题）── */
    if (channel === 'tmdb:image' || channel === 'tmdb:img') {
      return fetch('/app/fntvplus/api/bridge/tmdb/img?url=' + encodeURIComponent(String(args[0] || '')))
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
    }
    if (channel === 'tmdb:logo') return apiPost('/app/fntvplus/api/bridge/tmdb/logo', args[0] || {});
    if (channel === 'tmdb:show') return apiPost('/app/fntvplus/api/bridge/tmdb/show', args[0] || {});
    if (channel === 'tmdb:season-episodes') {
      return apiPost('/app/fntvplus/api/bridge/tmdb/season-episodes', args[0] || {});
    }
    // [v1.10.0] 扩展数据源（官方开放 API）：Fanart.tv 高清 Logo / TVMaze 分集兜底 / OMDb IMDb 评分
    if (channel === 'fanart:logos') return apiPost('/app/fntvplus/api/bridge/fanart/logos', args[0] || {});
    if (channel === 'tvmaze:show') return apiPost('/app/fntvplus/api/bridge/tvmaze/show', args[0] || {});
    if (channel === 'omdb:rating') return apiPost('/app/fntvplus/api/bridge/omdb/rating', args[0] || {});
    // [v1.10.x] Jav 番号刮削（javbus 抓取，默认关）：lookup 元数据 / image 封面代理
    if (channel === 'jav:lookup') return apiPost('/app/fntvplus/api/bridge/jav/lookup', args[0] || {});
    if (channel === 'jav:image') {
      return fetch('/app/fntvplus/api/bridge/jav/image?url=' + encodeURIComponent(String((args[0] && args[0].url) || '')))
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
    }
    if (channel === 'tmdb:discover') {
      // 每日放送 TMDB 源：后端 /discover/movie + /discover/tv 合并（复用 Key 鉴权 + 免梯子直连）
      return apiPost('/app/fntvplus/api/bridge/tmdb/discover', { force: !!args[0] });
    }
    if (channel === 'tmdb:update-ip') {
      // 免梯子直连「更新 IP」：后端拉 CheckTMDB hosts 片段刷新直连 IP（force 覆盖手动值）
      return apiPost('/app/fntvplus/api/bridge/tmdb/update-ip', { force: true });
    }
    if (channel === 'tmdb:update-ip') return Promise.resolve(undefined);

    /* ── Bangumi / 豆瓣 ── */
    if (channel === 'bangumi:calendar') {
      // 每日放送 Bangumi 源：后端已包装成桌面版同形状 {ok, items}；失败也回 JSON（不吞错）
      return fetch('/app/fntvplus/api/bridge/bangumi/calendar')
        .then((r) => r.json())
        .catch(() => ({ ok: false, error: '网络错误：无法连接后端' }));
    }
    if (channel === 'douban:discover') {
      // 每日放送豆瓣源：后端 Rexxar movie_hot_gaia + tv_hot 合并（免 Key，国内直连）
      return apiPost('/app/fntvplus/api/bridge/douban/discover', { force: !!args[0] });
    }
    if (channel === 'douban:image') {
      // 豆瓣海报防盗链代理（后端带 UA+Referer 解 418，转 dataUrl）
      return fetch('/app/fntvplus/api/bridge/douban/image?url=' + encodeURIComponent(String(args[0] || '')))
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
    }
    if (channel === 'douban:login-status') {
      return apiPost('/app/fntvplus/api/bridge/douban/status', {}).then((s) => ({ loggedIn: !!s.loggedIn, note: s.note }));
    }
    if (channel === 'douban:get-watched-items') {
      // 观影记录主数据：前端直连 fnOS API 全库钻取（鉴权同源可靠，见上方 collectWatchedItemsFrontend 注释）
      return collectWatchedItemsFrontend();
    }
    if (channel === 'douban:enrich-one') {
      // 单条补全：TMDB 分类/类型/评分 + 豆瓣评分（item 无 guid 时静默 null）
      if (!args[0] || !args[0].guid) return Promise.resolve(null);
      return apiPost('/app/fntvplus/api/bridge/douban/enrich', { item: args[0], cookie: document.cookie })
        .then((r) => (r && r.category !== undefined ? { guid: args[0].guid, ...r } : null))
        .catch(() => null);
    }
    if (channel === 'bangumi:sync-progress') {
      // [v0.50.0] 形状变更：{guid, percentage, item}——item 由前端直连 play/info 解析好传入，
      // 后端不再自查 fnOS（document.cookie 拿不到 httpOnly 会话 token，恒未登录）。
      return apiPost('/app/fntvplus/api/bridge/bangumi/sync-progress', {
        guid: args[0], percentage: args[1], item: args[2] || null,
      });
    }
    if (channel === 'douban:enrich-one') return Promise.resolve(null);
    if (channel === 'douban:sync-progress') {
      // [v0.52.0] 播放进度 → 豆瓣标「在看/看过」（后端带手动粘贴的 doubanCookie，标 interest）
      return apiPost('/app/fntvplus/api/bridge/douban/sync-progress', {
        guid: args[0], percentage: args[1], item: args[2] || null, duration: args[3] || 0,
      });
    }
    if (channel === 'douban:sync-watched') {
      // 飞牛「标记为已观看」→ 豆瓣标「看过」
      return apiPost('/app/fntvplus/api/bridge/douban/sync-watched', {
        guid: args[0], item: args[1] || null,
      });
    }
    if (channel === 'douban:manual-cookie') {
      // [v0.51.0] 手动粘贴豆瓣 Cookie：存 NAS config（settings 通用通道），供后端
      // doubanStatus 判定登录态 / fetchDoubanRating 带鉴权抓评分；后续标记同步同源使用。
      const ck = String(args[0] || '').trim();
      if (!ck) return Promise.resolve({ ok: false, msg: 'cookie 为空' });
      return apiPost('/app/fntvplus/api/settings', { doubanCookie: ck }).then(() => ({ ok: true }));
    }
    if (channel === 'douban:logout') {
      // 网页端无内嵌浏览器会话，"退出"= 清除已粘贴的 Cookie
      return apiPost('/app/fntvplus/api/settings', { doubanCookie: '' }).then(() => ({ ok: true }));
    }
    if (channel === 'douban:open-login') {
      // 网页端没有内嵌浏览器，扫码登录不可用——引导用手动粘贴
      return Promise.resolve({ ok: false, msg: '网页端不支持扫码登录，请使用下方「手动粘贴 Cookie」' });
    }
    if (channel === 'douban:scan-watched-manual') return Promise.resolve({ ok: false, message: '网页端豆瓣扫描未适配' });
    if (typeof channel === 'string' && channel.startsWith('douban:')) return Promise.resolve(undefined);

    /* ── 会话/窗口/杂项 ── */
    if (channel === 'settings:list-changelogs') return Promise.resolve([]);
    if (channel === 'settings:read-changelog') return Promise.resolve({ content: '' });
    if (channel === 'settings:check-update') return Promise.resolve({ ok: false, message: '网页端更新走飞牛应用中心' });
    if (channel === 'get-version') return Promise.resolve({ version: '0.30.0-web' });

    /* ── 通用配置/缓存 ── */
    if (channel === 'get-config' || channel === 'get-play-button-config') {
      return apiGet('/app/fntvplus/api/settings').catch(() => ({}));
    }
    if (channel === 'library-index:read') {
      try {
        const v = localStorage.getItem('fntv:library-index');
        return Promise.resolve(v ? { ok: true, items: JSON.parse(v) } : { ok: false });
      } catch { return Promise.resolve({ ok: false }); }
    }
    if (channel === 'library-index:write') {
      try {
        localStorage.setItem('fntv:library-index', JSON.stringify(args[0] || []));
        return Promise.resolve({ ok: true });
      } catch { return Promise.resolve({ ok: false }); }
    }
    if (channel === 'log-message') return Promise.resolve(undefined); // emitLog 已并行 console.log，diag 会捕获

    /* ── [v1.12.0] 匿名使用统计（网页端上报由 NAS 后端 Go 发出，这里只转发面板动作）──
     * 桌面版由主进程直接发心跳；网页端没有主进程，改由后端 internal/stats 以
     * 「反代注入成功」为触发每天报一次 —— 浏览器拿不到也无需拿到匿名 ID。 */
    if (channel === 'stats:get-info') return apiGet('/app/fntvplus/api/stats');
    if (channel === 'stats:set-enabled') {
      return apiPost('/app/fntvplus/api/stats/enabled', { enabled: !!args[0] });
    }
    if (channel === 'stats:ping-now') return apiPost('/app/fntvplus/api/stats/ping', {});
    if (channel === 'stats:reset-id') return apiPost('/app/fntvplus/api/stats/reset', {});
    if (channel === 'feedback:submit') return apiPost('/app/fntvplus/api/feedback', args[0] || {});

    /* ── 补丁/解锁（桌面版更新机制；网页端更新走应用中心）── */
    if (channel === 'settings:verify-unlock-code') return Promise.resolve({ ok: false, message: '网页端未适配解锁码' });
    if (channel === 'settings:check-patch' || channel === 'settings:apply-patch' || channel === 'settings:apply-test-patch' || channel === 'settings:rollback-patch') {
      return Promise.resolve({ ok: false, message: '网页端不支持补丁机制' });
    }
    if (channel === 'settings:list-test-patches') return Promise.resolve([]);

    /* ── 文件选择/诊断（桌面主进程 dialog；网页端不可用）── */
    if (channel === 'settings:pick-login-bg' || channel === 'settings:pick-mpv-path' || channel === 'settings:pick-pot-path') {
      return Promise.resolve({ ok: false, canceled: true });
    }
    if (channel === 'settings:clear-login-bg') return apiPost('/app/fntvplus/api/settings', { loginBg: null });
    if (channel === 'settings:clear-mpv-path') return apiPost('/app/fntvplus/api/settings', { mpvPath: '' });
    if (channel === 'settings:clear-pot-path') return apiPost('/app/fntvplus/api/settings', { potPath: '' });
    if (channel === 'settings:diagnostics') {
      return apiGet('/app/fntvplus/api/settings').then((s) => ({ ok: true, settings: s, ua: navigator.userAgent }));
    }
    if (channel === 'settings:test-custom-proxy') {
      return apiPost('/app/fntvplus/api/bridge/proxy/test', { proxyUrl: args[1] });
    }
    if (channel === 'settings:diag-danmu-api') {
      // [v0.80.0] 分层诊断：{base, timeoutMs, repeats, keyword} → 逐层归因报告（后端从 NAS 发出，与实际弹幕拉取同网络位置）
      return apiPost('/app/fntvplus/api/bridge/danmu/diag', args[0] || {});
    }
    if (channel === 'settings:test-danmu-api') return apiPost('/app/fntvplus/api/bridge/danmu/test', { base: args[0] });

    /* ── 播放/媒体（网页端由原生 UI 承担；外部播放器不可用）── */
    if (channel === 'play-movie' || channel === 'external-play' || channel === 'pause' || channel === 'media:control') {
      return Promise.resolve(undefined);
    }
    if (channel === 'skip:fetch-and-fill') {
      // [v0.70.0] 跳过片头/片尾数据链（网页端）：直连 play/info 拿元数据 → 直连 fnOS skipinfo
      // （已有数据直接用）→ 后端外网三级链（AniSkip+MAL 映射 / theintrodb）→ 直连写回 fnOS。
      // fnOS skipinfo 路径双前缀尝试（/v/api/v1 与 /api/v1，桌面经代理语义不清）。
      const guid = String((args[0] && args[0].guid) || '');
      const empty = { filled: false, skipStart: 0, skipEnd: 0, source: 'none', recapStart: 0, recapEnd: 0, message: '' };
      if (!guid) return Promise.resolve(Object.assign({}, empty, { message: '缺少 guid' }));
      const signedFetch = async (method, path, payload) => {
        const headers = { 'Content-Type': 'application/json' };
        headers.Authx = await genAuthxAsync(path, payload || undefined);
        const resp = await fetch(location.origin + path, {
          method, credentials: 'include', headers,
          body: payload ? JSON.stringify(payload) : undefined,
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      };
      return (async () => {
        // ① play/info 元数据
        const info = await signedFetch('POST', '/v/api/v1/play/info', { item_guid: guid }).catch(() => null);
        const item = info && info.data && info.data.item;
        if (!item) return Object.assign({}, empty, { message: '获取播放信息失败' });
        const trimId = String(item.trim_id || '');
        const season = Number(item.season_number) || 0;
        const episode = Number(item.episode_number) || 0;
        const duration = Number(item.duration) || 0;
        let title = String(item.parent_title || item.title || '').trim();
        title = title.replace(/^第\s*\d+\s*[集话話期]\s*/, '').trim();
        // ② fnOS 已有跳过数据（服务端真值优先；双前缀尝试）
        const trySkipInfoGet = async () => {
          for (const p of ['/v/api/v1/skipinfo/' + guid, '/api/v1/skipinfo/' + guid]) {
            try {
              const j = await signedFetch('GET', p);
              if (j && j.code === 0 && j.data) return j.data;
            } catch (e) { /* 试下一个前缀 */ }
          }
          return null;
        };
        const existing = await trySkipInfoGet();
        if (existing && (Number(existing.skipStart) > 0 || Number(existing.skipEnd) > 0)) {
          return {
            filled: true, skipStart: Number(existing.skipStart) || 0, skipEnd: Number(existing.skipEnd) || 0,
            source: 'fnos', recapStart: 0, recapEnd: 0,
          };
        }
        // ③ 后端外网三级链（AniSkip / theintrodb）
        const ext = await apiPost('/app/fntvplus/api/bridge/skip/external', {
          trimId, season, episode, duration, title,
        }).catch(() => null);
        if (!ext || !ext.ok || !(Number(ext.skipStart) > 0 || Number(ext.skipEnd) > 0)) {
          return Object.assign({}, empty, { message: (ext && ext.message) || '无可用跳过数据' });
        }
        // ④ 写回 fnOS（双前缀尝试）
        for (const p of ['/v/api/v1/skipinfo', '/api/v1/skipinfo']) {
          try {
            const j = await signedFetch('POST', p, { guid, skipStart: Number(ext.skipStart), skipEnd: Number(ext.skipEnd) });
            if (j && j.code === 0) break;
          } catch (e) { /* 试下一个前缀 */ }
        }
        return {
          filled: true, skipStart: Number(ext.skipStart) || 0, skipEnd: Number(ext.skipEnd) || 0,
          source: ext.source, recapStart: Number(ext.recapStart) || 0, recapEnd: Number(ext.recapEnd) || 0,
        };
      })();
    }
    if (channel === 'media:season-guid') {
      // [v0.90.0] 直连 fnOS item/list 查「季」guid（桌面 libraryIndex 同参数）：
      // 轮播「开始播放/详情」用它把一级详情页升级为季详情页——此前此通道是 no-op，永远回退一级。
      const parentGuid = String(args[0] || '');
      if (!parentGuid) return Promise.resolve({ ok: false, error: 'empty parentGuid' });
      return (async () => {
        try {
          const path = '/v/api/v1/item/list';
          const payload = { parent_guid: parentGuid, exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC', page: 1, page_size: 200 };
          const headers = { 'Content-Type': 'application/json', Authx: await genAuthxAsync(path, payload) };
          const resp = await fetch(location.origin + path, {
            method: 'POST', credentials: 'include', headers, body: JSON.stringify(payload),
          });
          if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
          const j = await resp.json();
          const list = (j && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
          // 优先 type==='season'；否则取「非 episode/movie」的带 guid 子级（桌面同兼容逻辑）
          const season = list.find((c) => String((c && c.type) || '').toLowerCase() === 'season' && !!c.guid)
            || list.find((c) => {
              const t = String((c && c.type) || '').toLowerCase();
              return !!t && t !== 'episode' && t !== 'movie' && !!c.guid;
            });
          return { ok: true, guid: (season && season.guid) || '' };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      })();
    }
    if (channel === 'skip:next-episode') {
      return Promise.resolve(undefined); // 自动连播数据源待接
    }
    if (channel === 'mpv:get-render-preset') return apiGet('/app/fntvplus/api/settings').then((s) => s.mpvRenderPreset);
    if (channel === 'mpv:set-render-preset') return apiPost('/app/fntvplus/api/settings', { mpvRenderPreset: args[0] });

    /* ── B 站扫码登录（后端桥：passport API + cookie 持久化到 NAS）── */
    if (channel === 'bili:qr-generate') return apiPost('/app/fntvplus/api/bridge/bili/qr-generate', {});
    if (channel === 'bili:qr-poll') return apiPost('/app/fntvplus/api/bridge/bili/qr-poll', { key: args[0] });
    if (channel === 'bili:cookie-status') return apiGet('/app/fntvplus/api/bridge/bili/status');
    if (channel === 'bili:qr-lib') {
      // 返回 qrcode.min.js 源码字符串（面板注入后客户端渲染二维码）
      return fetch('/app/fntvplus/api/bridge/bili/qr-lib').then((r) => r.text());
    }
    if (channel === 'bili:manual-cookie') return apiPost('/app/fntvplus/api/bridge/bili/manual', { raw: args[0] });
    if (channel === 'bili:clear') return apiPost('/app/fntvplus/api/bridge/bili/clear', {});
    if (channel === 'bili:open-danmaku-folder') return Promise.resolve(undefined);
    if (channel === 'danmaku:prepare') {
      // [v0.64.1] 网页端弹幕数据链：前端直连 play/info 解析条目元数据（title/ep/season/type，
      // 同 playSync 的已验证直连路径），B站搜索+弹幕拉取由后端完成（带可选 bili_cookie）。
      const guid = String((args[0] && args[0].guid) || '');
      if (!guid) return Promise.resolve({ ok: false, error: '缺少 guid' });
      return (async () => {
        try {
          const infoPath = '/v/api/v1/play/info';
          const payload = { item_guid: guid };
          const authx = await genAuthxAsync(infoPath, payload);
          const resp = await fetch(location.origin + infoPath, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Authx': authx, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!resp.ok) return { ok: false, error: '获取播放信息失败: HTTP ' + resp.status };
          const j = await resp.json();
          const item = j && j.data && j.data.item;
          if (!item) return { ok: false, error: '获取播放信息失败' };
          const type = String((j.data.type || item.type || '')).toLowerCase();
          const isMovie = type === 'movie';
          const title = String(item.tv_title || item.title || '').trim();
          const ep = isMovie ? 0 : (Number(item.episode_number) || 0);
          const season = isMovie ? 0 : (Number(item.season_number) || 0);
          if (!title) return { ok: false, error: '无法解析标题（tv_title 为空）' };
          const r = await apiPost('/app/fntvplus/api/bridge/danmaku/prepare', {
            title, ep, season, isMovie, biliSearch: true,
          });
          // danmakuWeb 期望顶层形状（含 maxScreen）
          return Object.assign({ maxScreen: 0 }, r);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      })();
    }
    if (channel === 'danmaku:candidates') {
      return apiPost('/app/fntvplus/api/bridge/danmaku/candidates', args[0] || {});
    }
    if (channel === 'danmaku:pick') {
      return apiPost('/app/fntvplus/api/bridge/danmaku/pick', args[0] || {});
    }
    /* ── [v1.11.0] 弹弹play 开放 API（内置凭证 + 可选自定义凭证）── */
    if (channel === 'dandanplay:status') {
      return apiGet('/app/fntvplus/api/bridge/dandanplay/status');
    }
    if (channel === 'dandanplay:test') {
      // 连通自检：真发一次搜索请求，把凭证/网络两类失败分别归因
      const a = args[0] || {};
      return apiPost('/app/fntvplus/api/bridge/dandanplay/test', { keyword: a.keyword || '' });
    }

    /* ── 人物页 TMDB 增强（fnOS person API → TMDB 链路待接）── */
    if (channel === 'person:tmdb-brief' || channel === 'person:tmdb-credits') {
      // 演员页 TMDB 增强（桌面版 personTmdb 同款管线）：后端 fnOS person API → imdb → TMDB find/credits
      const ep = channel === 'person:tmdb-brief' ? 'brief' : 'credits';
      return apiPost('/app/fntvplus/api/bridge/person/' + ep, { guid: args[0], cookie: document.cookie });
    }

    if (channel === 'settings:open-external') {
      try { window.open(String(args[0] || ''), '_blank', 'noopener'); } catch { /* ignore */ }
      return Promise.resolve();
    }
    if (channel === 'trakt:clear-credentials') {
      return apiPost('/app/fntvplus/api/bridge/trakt/disconnect', {});
    }

    if (channel === 'fnos-gen-authx') {
      // [lc-1250-web] 运行时提取材料 → 本地真签名（与桌面版主进程同算法）；提取失败回退捕获回放
      return genAuthxAsync(String(args[0] || ''), args[1]);
    }
    if (channel === 'app:open-external') {
      // 网页端：新标签页打开外链（桌面端由主进程 shell.openExternal）
      try { window.open(String(args[0] || ''), '_blank', 'noopener'); } catch { /* ignore */ }
      return Promise.resolve();
    }
    if (channel === 'app:qr-image') {
      // 网页端：二维码由后端内嵌直出（桌面端由主进程读 build/qrcode.png 返回 base64），
      // 这里 fetch 同源 PNG 转 dataUri，形状对齐桌面版 { ok, dataUri }
      return fetch('/app/fntvplus/qrcode.png')
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))))
        .then((blob) => new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve({ ok: true, dataUri: fr.result });
          fr.onerror = () => resolve({ ok: false });
          fr.readAsDataURL(blob);
        }))
        .catch(() => Promise.resolve({ ok: false }));
    }
    // 其它一律安全 no-op
    return Promise.resolve(undefined);
  },
  send(/* channel, ...args */) { /* no-op：浏览器无主进程通道 */ },
  on(channel, cb) {
    // 网页端没有主进程下发调试过滤 → 默认打开 embyWall 日志总开关，
    // 让 [DIAG] fetchImg 等诊断流进 console → diag 回传后端，用户在实时日志可见。
    if (channel === 'debug-filter' && typeof cb === 'function') {
      setTimeout(() => {
        try { cb({}, { enabled: true, components: {} }); } catch { /* ignore */ }
      }, 0);
    }
    // [v1.2.0] Trakt 设备授权结果事件：device-start 的轮询循环（见 invoke 特例）fire 到这里
    if (channel === 'trakt:connected' || channel === 'trakt:device-error') {
      if (!globalThis.__fntvTraktEvents) globalThis.__fntvTraktEvents = {};
      const list = globalThis.__fntvTraktEvents[channel] = globalThis.__fntvTraktEvents[channel] || [];
      if (typeof cb === 'function') list.push(cb);
      return () => {
        const i = list.indexOf(cb);
        if (i > -1) list.splice(i, 1);
      };
    }
    return () => {};
  },
  once(channel, cb) {
    // 兼容 embyWall 的 get-version → version-info 握手：网页端从后端 /api/status 拿真实版本
    // （= manifest version，打包器自动维护）。旧版写死 '0.0.0-web' 侧栏永远显示 0.0.0（用户报障）。
    // [lc-167] 展示值统一追加 '-web' 后缀标识「网页版」（与桌面版区分，用户要求显示 1.0.1-web）；
    //   仅对纯数字版号（x.y / x.y.z / x.y.z.w）追加——dev、取不到版号等非版号值原样透传，
    //   避免出现 "dev-web" 这类误导值。
    if (channel === 'version-info') {
      apiGet('/app/fntvplus/api/status').then((st) => {
        const v = (st && st.version) || '';
        if (!v) return; // 拿不到就保持侧栏 'v…' 占位, 不显示误导值
        const disp = /^\d+\.\d+(\.\d+)*$/.test(v) ? v + '-web' : v;
        try { cb({}, { version: disp }); } catch { /* ignore */ }
      }).catch(() => { /* 同上, 保持占位 */ });
    }
    return () => {};
  },
  removeListener() {},
  off(channel, cb) { return this.removeListener(channel, cb); },
  removeAllListeners() {},
};

const shell = {
  openExternal() {},
  openPath() {},
  showItemInFolder() {},
};

shimExports.ipcRenderer = ipcRenderer;
shimExports.shell = shell;
try { if (typeof window !== 'undefined') window.__fntvShim = shimExports; } catch { /* ignore */ }
// [v0.51.0] 网页端环境标志：插件据此隐藏桌面专属 UI（如豆瓣「扫码登录」——网页端无内嵌浏览器）
try { if (typeof window !== 'undefined') window.__FNTV_WEB__ = true; } catch { /* ignore */ }
export { ipcRenderer, shell };
