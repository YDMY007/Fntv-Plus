#!/usr/bin/env node
// 直连 B站 弹幕下载器（JS 版，逻辑与 bili_danmaku.py 完全一致，绕开失效的弹弹play extcomment 代理）
// 用法: node bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值]
// 依赖: 仅 Node 内置模块 (https / crypto / zlib / fs / path / url / process)
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
// WBI 混淆表（与 bili_danmaku.py 的 ENC 完全一致）
const ENC = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

// 登录态 Cookie：同目录 bili_cookie.txt（一行）。可绕过匿名 seg.so 概率性空响应风控；缺失则走匿名。
const SCRIPT_DIR = __dirname;
function _load_cookie() {
    const p = path.join(SCRIPT_DIR, 'bili_cookie.txt');
    try {
        const c = fs.readFileSync(p, 'utf8').trim();
        return c || null;
    } catch (e) {
        return null;
    }
}
// 登录态 Cookie：同目录 bili_cookie.txt（一行）。可绕过匿名 seg.so 概率性空响应风控；缺失则走匿名。
// 改为每次 run() 时按需加载（支持主进程内热更新），此处仅声明，初始匿名。
let COOKIE = null;
function _refresh_cookie() { COOKIE = _load_cookie(); }

// 明显非正片的标题关键词（reaction/二创/OP/ED/预告等）
const BAD_TITLE = ['reaction', '反应', '杂谈', '吐槽', '解说', '盘点', '二创', 'mad', 'amv',
    '算是', '你们', '为什么', '评', '空降', '切片', '速看', '高能', 'op', 'ed',
    'ost', 'pv', '预告', '花絮', 'cos', '直播', '歌词', '致敬', '混剪', '剪辑',
    '有声轻小说', '广播剧', '有声书', '有声小说'];

// 标题/分P名里常见的非识别性填充词，做相似度比较时剔除
const _FILLER = ['高清', '1080p', '720p', '480p', '4k', '合集', '全集', '更新', '熟肉', '生肉',
    '字幕组', '官方', '独家', '番剧', '动画', '动漫', '国语', '日语', '中字', '双语',
    '无修', '无删减', '精校', '完结', '第', '话', '集', '全'];

// 剧名匹配阈值：优先完整剧名(SIM_HIGH)；失败则降低阈值到 SIM_LOW(名字相同即可)。
const SIM_HIGH = 0.90;
const SIM_LOW = 0.30;

// 视频区兜底接受阈值：低于 SIM_LOW 直接跳过。用户要求统一为 0.3。
const VIDEO_SIM_FLOOR = 0.30;

function _norm(t) {
    t = (t || '').toLowerCase();
    t = t.replace(/[\s\[\]【】()（）<>《》\-_~～.。,，!！?？:：/\\|'"'""'""…]/g, '');
    t = t.replace(/第\s*\d+\s*[话集話回季]/g, '');
    t = t.replace(/^\d+\s*季/g, '');
    for (const w of _FILLER) {
        t = t.split(w).join('');
    }
    return t;
}

// LCS 比值 = 2*LCS/(len a + len b)，与 difflib.SequenceMatcher.ratio() 等价（忽略 junk 启发）。
function _lcsRatio(a, b) {
    const memo = new Map();
    function lcs(i, j) {
        if (i === 0 || j === 0) return 0;
        const key = i + ',' + j;
        if (memo.has(key)) return memo.get(key);
        let v;
        if (a[i - 1] === b[j - 1]) v = 1 + lcs(i - 1, j - 1);
        else v = Math.max(lcs(i - 1, j), lcs(i, j - 1));
        memo.set(key, v);
        return v;
    }
    if (a.length === 0 && b.length === 0) return 0;
    return (2 * lcs(a.length, b.length)) / (a.length + b.length);
}

function title_sim(a, b) {
    a = _norm(a); b = _norm(b);
    if (!a || !b) return 0.0;
    if (a === b) return 1.0;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.92;
    return _lcsRatio(a, b);
}

// 日志接收器：默认输出到 stderr；主进程可通过 setLogSink() 注入（如转发到 app.log）
let _logSink = null;
function setLogSink(fn) {
    _logSink = (typeof fn === 'function') ? fn : null;
}
function log(s) {
    const line = '[bili_danmaku] ' + String(s);
    if (_logSink) {
        try { _logSink(line); } catch (e) { /* 忽略 sink 异常，避免影响主流程 */ }
    } else {
        process.stderr.write(line + '\n');
    }
}

function parse_count(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return Math.trunc(v);
    let s = String(v).trim().replace(/,/g, '');
    if (s === '' || s === '--' || s === '无' || s === '—') return 0;
    try {
        let m = s.match(/([\d.]+)\s*亿/);
        if (m) return parseInt(parseFloat(m[1]) * 1e8, 10);
        m = s.match(/([\d.]+)\s*万/);
        if (m) return parseInt(parseFloat(m[1]) * 10000, 10);
        return parseInt(parseFloat(s), 10);
    } catch (e) {
        return 0;
    }
}

// ---- HTTP 请求（仅 Node 内置） ----
function request(urlStr, opts) {
    opts = opts || {};
    const binary = !!opts.binary;
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(e); }
        const lib = u.protocol === 'http:' ? http : https;
        const headers = Object.assign({}, UA, { 'Cache-Control': 'no-cache' });
        if (COOKIE) headers['Cookie'] = COOKIE;
        const req = lib.get(u, { headers }, (res) => {
            const code = res.statusCode || 0;
            // 跟随 GET 重定向（最多 5 跳）
            if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && opts.redirects !== 0) {
                const loc = res.headers.location;
                res.resume();
                if (!loc) return reject(new Error('redirect without location'));
                const next = urlStr.startsWith('http') ? new URL(loc, u).toString() : loc;
                return resolve(request(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
            }
            if (code === 304) { res.resume(); return resolve(binary ? Buffer.alloc(0) : ''); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let buf = Buffer.concat(chunks);
                if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
                    try { buf = zlib.gunzipSync(buf); } catch (e) { /* 保留原样 */ }
                }
                resolve(binary ? buf : buf.toString('utf8'));
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });
}

function fetch(url, binary) {
    return request(url, { binary: !!binary });
}

function fetch_seg(cid, seg) {
    const url = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${seg}`;
    let last = Buffer.alloc(0);
    const doTry = (attempt) => {
        return fetch(url, true).then((raw) => {
            if (raw.length >= 20) return raw;
            last = raw;
            if (attempt < 2) {
                log(`段${seg}空响应(重试${attempt + 1}/3)`);
                return new Promise((r) => setTimeout(r, 2000)).then(() => doTry(attempt + 1));
            }
            return raw;
        }).catch((e) => {
            log(`段${seg}下载失败(重试${attempt + 1}/3): ${e.message || e}`);
            if (attempt < 2) {
                return new Promise((r) => setTimeout(r, 2000)).then(() => doTry(attempt + 1));
            }
            return last;
        });
    };
    return doTry(0);
}

function jget(url) {
    return fetch(url, false).then((s) => JSON.parse(s));
}

// WBI 签名（与 Python 版逐行一致；mixin 计算后与 Python 一样未参与最终 w_rid，保留以对齐逻辑）
function wbi_sign(params) {
    return jget('https://api.bilibili.com/x/web-interface/nav').then((nav) => {
        const img = nav.data.wbi_img.img_url;
        const sub = nav.data.wbi_img.sub_url;
        const ik = img.split('/').pop().split('.')[0];
        const sk = sub.split('/').pop().split('.')[0];
        const mixed = crypto.createHash('md5').update(ik + sk).digest('hex');
        const mixin = mixed.split('').map((c, i) => mixed[ENC[i] % 32]).join('').slice(0, 32);
        const p = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
        const wts = Math.floor(Date.now() / 1000);
        const w_rid = crypto.createHash('md5').update(p + wts).digest('hex');
        return `w_rid=${w_rid}&wts=${wts}`;
    });
}

function _bangumi_cid(ep_id) {
    return jget(`https://api.bilibili.com/pgc/view/web/season?ep_id=${ep_id}`).then((sd) => {
        if (sd && sd.code === 0) {
            const eps = (sd.result && sd.result.episodes) || [];
            for (const e of eps) {
                if (e.ep_id === ep_id && e.cid) return e.cid;
            }
        }
        return null;
    }).catch((e) => {
        log('pgc请求失败: ' + (e.message || e));
        return null;
    });
}

function _select_ep(eps, ep_num) {
    if (ep_num && 1 <= ep_num && ep_num <= eps.length) {
        return eps[ep_num - 1];
    }
    let best = null, best_dm = -1;
    for (const ep of eps) {
        const dm = parse_count(ep.danmaku);
        if (dm > best_dm) { best_dm = dm; best = ep; }
    }
    return best;
}

// 番剧区搜索（B站正版番剧）。与 bili_danmaku.py search_bangumi 逻辑一致：
// 优先完整剧名(sim>=SIM_HIGH)；失败则降阈值到 SIM_LOW(0.3)；不做谐音/近似名兜底。
async function search_bangumi(title, ep_num) {
    const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(title)}&search_type=media_bangumi`;
    const d = await jget(url);
    if (!d || d.code !== 0) {
        log('番剧区搜索失败 code=' + (d && d.code));
        return [];
    }
    const cands = [];
    for (const it of (d.data.result || [])) {
        if (it && typeof it === 'object' && it.result_type === 'media_bangumi') {
            for (const anime of (it.data || [])) {
                const t = String(anime.title || '').replace(/<[^>]+>/g, '');
                if (t.indexOf('中配') >= 0) continue;
                cands.push([title_sim(title, t), t, anime]);
            }
        }
    }
    cands.sort((x, y) => (y[0] - x[0]) || (parse_count(y[2].video_review || 0) - parse_count(x[2].video_review || 0)));
    log(`[番剧区] 命中候选 ${cands.length} 个, ep_num=${ep_num}`);
    for (let i = 0; i < Math.min(cands.length, 5); i++) {
        const [sim, t, anime] = cands[i];
        const eps = anime.eps || [];
        log(`[番剧区]   候选[${i}] sim=${sim.toFixed(2)} 总集数=${eps.length} ${JSON.stringify(t)}`);
    }
    const results = [];
    for (const thr of [SIM_HIGH, SIM_LOW]) {
        for (const [sim, t, anime] of cands) {
            if (sim < thr) continue;
            const eps = anime.eps || [];
            if (!eps.length) continue;
            const ep = _select_ep(eps, ep_num);
            if (!ep) continue;
            const ep_id = ep.ep_id || ep.id;
            if (!ep_id) continue;
            const cid = await _bangumi_cid(ep_id);
            if (cid) {
                const info = { source: 'bangumi', season_id: anime.season_id, epid: ep_id, bvid: null, sim: sim };
                log(`[番剧区] sim=${sim.toFixed(2)}(阈值${thr}) 候选: ${JSON.stringify(t)} ep序号=${ep.index} cid=${cid}`);
                results.push([cid, t, info]);
            }
        }
    }
    if (!results.length) {
        log(`[番剧区] 无达到相似度阈值(${SIM_LOW})的候选，放弃匹配（已移除谐音兜底）`);
    }
    return results;
}

function _ep_in_title(t, ep_num) {
    if (!ep_num) return false;
    const s = String(t);
    if (new RegExp(`第\\s*0*${ep_num}\\s*[话集回話]`).test(s)) return true;
    if (new RegExp('\\d\\s*[~\\-–至]\\s*\\d').test(s)) return false;
    if (new RegExp(`(?:^|[^A-Za-z\\d])(?:e\\.?p\\.?\\s*|episode\\s*|#\\s*)\\s*0*${ep_num}(?!\\d)`, 'i').test(s)) return true;
    if (new RegExp(`(?<![\\d])0*${ep_num}(?![\\d])`).test(s)) return true;
    return false;
}

function _is_compilation_title(t) {
    const s = String(t);
    if (new RegExp('全\\s*\\d+\\s*[集话]').test(s)) return true;
    if (s.indexOf('合集') >= 0 || s.indexOf('总集') >= 0) return true;
    if (new RegExp('第\\s*\\d+\\s*[~\\-–至]\\s*\\d+\\s*[话集]').test(s)) return true;
    if (new RegExp('\\d+\\s*[~\\-–至]\\s*\\d+\\s*话').test(s)) return true;
    return false;
}

function parse_ep_from_title(title) {
    if (!title) return 0;
    let m = title.match(/第\s*(\d+)\s*[话集回話]/);
    if (m) return parseInt(m[1], 10);
    m = title.match(/(?<![A-Za-z])[Ee][Pp]?\s*(\d+)/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    m = title.match(/(?<![\d])(\d{1,4})(?![\d])\s*[话集回話]/);
    if (m) return parseInt(m[1], 10);
    m = title.match(/[\(（]\s*(\d{1,4})\s*[\)）]/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    m = title.match(/[\-_.\s]\s*(\d{1,4})\s*(?=[\-\]\)）\s]|$)/);
    if (m) { const n = parseInt(m[1], 10); if (n <= 2010) return n; }
    return 0;
}

function cid_from_bvid(bvid, ep_num, title_hint) {
    return jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`).then((d) => {
        if (!d || d.code !== 0 || !d.data) {
            log(`view请求失败 bvid=${bvid} code=${d && d.code}`);
            return null;
        }
        const data = d.data;
        const pages = data.pages || [];
        log(`[cid_from_bvid] bvid=${bvid} pages=${pages.length} ep_num=${ep_num} title_hint=${JSON.stringify(title_hint)}`);
        if (!pages.length) {
            const cid = data.cid;
            if (ep_num && _is_compilation_title(title_hint || '')) {
                log(`[cid_from_bvid] 单cid合集视频(标题含全集标记), 无法隔离第${ep_num}话, 跳过`);
                return null;
            }
            const ok = (ep_num === null || ep_num === undefined || _ep_in_title(title_hint || '', ep_num));
            log(`[cid_from_bvid] 单P: cid=${cid} 集数匹配=${ok}`);
            return ok ? cid : null;
        }
        if (pages.length === 1) {
            const cid = pages[0].cid;
            if (ep_num && _is_compilation_title(title_hint || '')) {
                log(`[cid_from_bvid] 单P合集视频(标题含全集标记), 无法隔离第${ep_num}话, 跳过`);
                return null;
            }
            const ok = (ep_num === null || ep_num === undefined || _ep_in_title(title_hint || '', ep_num));
            log(`[cid_from_bvid] 单P列表: cid=${cid} 集数匹配=${ok}`);
            return ok ? cid : null;
        }
        if (ep_num) {
            let best = null;
            for (let i = 0; i < pages.length; i++) {
                const part = pages[i].part || '';
                if (_ep_in_title(part, ep_num)) {
                    if (part.indexOf('先行') >= 0 || part.indexOf('预览') >= 0) {
                        if (best === null) best = pages[i].cid;
                        log(`[cid_from_bvid] 分P[${i}]=${JSON.stringify(part)} 命中但为先行/预览, 暂存兜底`);
                        continue;
                    }
                    log(`[cid_from_bvid] 分P[${i}]=${JSON.stringify(part)} 集数匹配 -> cid=${pages[i].cid}`);
                    return pages[i].cid;
                }
            }
            log(`[cid_from_bvid] 多P未精确匹配第${ep_num}话, 兜底 cid=${best}`);
            return best;
        }
        log(`[cid_from_bvid] 未指定集数, 取首P cid=${pages[0].cid}`);
        return pages[0].cid;
    }).catch((e) => {
        log('view请求失败: ' + (e.message || e));
        return null;
    });
}

async function search_video(title, ep_num) {
    const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(title)}&search_type=video`;
    const d = await jget(url);
    if (!d || d.code !== 0) return [];
    const pool = [];
    for (const it of (d.data.result || [])) {
        if (it && typeof it === 'object' && it.result_type === 'video') {
            for (const v of (it.data || [])) {
                const t = String(v.title || '').replace(/<[^>]+>/g, '');
                const bvid = v.bvid;
                if (bvid) pool.push([t, bvid, parse_count(v.video_review)]);
            }
        }
    }
    if (!pool.length) return [];
    const filtered = pool.filter(([t]) => {
        const low = t.toLowerCase();
        return !BAD_TITLE.some((k) => low.indexOf(k) >= 0);
    });
    function kind_of(t) {
        if (ep_num && _ep_in_title(t, ep_num) && !_is_compilation_title(t)) return 0;
        if (_is_compilation_title(t)) return 2;
        return 1;
    }
    const scored = filtered.map(([t, bvid, vr]) => [title_sim(title, t), kind_of(t), t, bvid, vr]);
    scored.sort((x, y) => (x[1] - y[1]) || (y[4] - x[4]) || (y[0] - x[0]));
    log(`[视频区] 候选 ${scored.length} 个, ep_num=${ep_num}`);
    const tagmap = { 0: '[单集]', 1: '[不明]', 2: '[合集]' };
    for (let i = 0; i < Math.min(scored.length, 8); i++) {
        const [sim, kind, t, bvid, vr] = scored[i];
        log(`[视频区]   候选[${i}]${tagmap[kind] || '?'} sim=${sim.toFixed(2)} 弹幕=${vr} ${JSON.stringify(t)}`);
    }
    const results = [];
    const seen = new Set();
    for (const [sim, kind, t, bvid, vr] of scored) {
        if (sim < VIDEO_SIM_FLOOR) continue;
        const cid = await cid_from_bvid(bvid, ep_num, t);
        if (cid && !seen.has(cid)) {
            seen.add(cid);
            const info = { source: 'video', bvid: bvid, sim: sim };
            const tag = tagmap[kind] || '?';
            const mark = sim >= SIM_LOW ? '' : ' [兜底]';
            log(`[视频区] sim=${sim.toFixed(2)}${tag}${mark} 候选: ${JSON.stringify(t)} cid=${cid}`);
            results.push([cid, t, info]);
        }
    }
    if (!results.length) {
        log(`[视频区] 无达到相似度阈值(${VIDEO_SIM_FLOOR})的候选，放弃匹配（已移除谐音兜底）`);
    }
    return results;
}

async function search_cid(title, ep_num) {
    let t = title.replace(/\s*[\(（]\d{4}[\)）]\s*$/, '').trim();
    if (!t) return [];
    if (!ep_num || ep_num === 0) {
        const derived = parse_ep_from_title(t);
        if (derived) {
            log(`[search_cid] ep_num=0, 从标题解析到集数=${derived}: ${JSON.stringify(t)}`);
            ep_num = derived;
        } else {
            log(`[search_cid] ep_num=0 且标题无集数: ${JSON.stringify(t)}`);
        }
    }
    log(`[search_cid] 开始匹配: title=${JSON.stringify(t)} ep_num=${ep_num}`);
    const bangumi = await search_bangumi(t, ep_num);
    if (bangumi.length) {
        log(`[search_cid] 番剧区返回 ${bangumi.length} 个候选`);
        return bangumi;
    }
    log('番剧区无结果，回退到视频区(UP主搬运)');
    const video = await search_video(t, ep_num);
    if (video.length) {
        log(`[search_cid] 视频区返回 ${video.length} 个候选`);
        return video;
    }
    log('[search_cid] 番剧区/视频区均未匹配（已移除谐音/近似名兜底，不再猜测）');
    return [];
}

function try_fetch_danmaku(cid) {
    const all_d = [];
    const loop = (seg) => {
        if (seg > 50) return Promise.resolve([all_d.length > 0, all_d]);
        return fetch_seg(cid, seg).then((raw) => {
            if (raw.length < 20) {
                log(`  cid=${cid} 段${seg}空，结束`);
                return [all_d.length > 0, all_d];
            }
            const dm = extract(raw);
            if (!dm.length) {
                log(`  cid=${cid} 段${seg}无弹幕，结束`);
                return [all_d.length > 0, all_d];
            }
            for (const d of dm) all_d.push(d);
            return loop(seg + 1);
        });
    };
    return loop(1);
}

function read_varint(buf, i) {
    let shift = 0, val = 0;
    while (true) {
        const x = buf[i]; i++;
        val |= (x & 0x7f) << shift;
        if (!(x & 0x80)) break;
        shift += 7;
    }
    return [val, i];
}

function parse(buf) {
    const out = []; let i = 0; const n = buf.length;
    while (i < n) {
        const [tag, ni] = read_varint(buf, i); i = ni;
        const f = tag >> 3, wt = tag & 7;
        if (wt === 2) {
            const [ln, li] = read_varint(buf, i); i = li;
            const dt = buf.slice(i, i + ln); i += ln;
            out.push([f, 2, dt]);
        } else if (wt === 0) {
            const [v, vi] = read_varint(buf, i); i = vi;
            out.push([f, 0, v]);
        } else if (wt === 5) {
            const dt = buf.slice(i, i + 4); i += 4;
            out.push([f, 5, dt]);
        } else if (wt === 1) {
            const dt = buf.slice(i, i + 8); i += 8;
            out.push([f, 1, dt]);
        } else {
            break;
        }
    }
    return out;
}

function extract(raw) {
    const top = parse(raw);
    const elems = top.filter((e) => e[0] === 1 && e[1] === 2).map((e) => e[2]);
    const res = [];
    for (const e of elems) {
        let pr = 0, con = null, mode = 1, col = 16777215;
        for (const [f, wt, v] of parse(e)) {
            if (f === 2 && wt === 0) pr = v;
            else if (f === 7 && wt === 2) { try { con = v.toString('utf8'); } catch (err) { con = null; } }
            else if (f === 3 && wt === 0) mode = v;
            else if (f === 5 && wt === 5) col = v.readUInt32LE(0);
        }
        if (con) res.push([pr, mode, col, con]);
    }
    return res;
}

function htmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _write_xml(out, dm) {
    const dir = path.dirname(out) || '.';
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<danmaku>'];
    for (const [pr, mode, col, con] of dm) {
        const t = (pr / 1000.0).toFixed(2);
        const p = `${t},${mode},25,${col},0,0,0`;
        lines.push(`<d p="${p}">${htmlEscape(con)}</d>`);
    }
    lines.push('</danmaku>');
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
}

function _load_block_types() {
    const p = path.join(SCRIPT_DIR, 'danmaku_block_types.json');
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data)) return new Set(data.map((x) => String(x)));
    } catch (e) { /* ignore */ }
    return new Set();
}

function _filter_danmaku(dm, block_types) {
    if (!block_types || !block_types.size) return dm;
    const out = [];
    for (const [pr, mode, col, con] of dm) {
        const tags = new Set();
        if (mode === 1) tags.add('scroll');
        else if (mode === 4) tags.add('bottom');
        else if (mode === 5) tags.add('top');
        else if (mode === 6) tags.add('reverse');
        else if (mode === 7 || mode === 8) tags.add('advanced');
        if (col !== 16777215) tags.add('color');
        if ([...tags].some((x) => block_types.has(x))) continue;
        out.push([pr, mode, col, con]);
    }
    return out;
}

function _select_danmaku(fetched, agg_threshold, agg_time_limit, min_danmaku) {
    const valid = fetched.filter((f) => f[4] <= agg_time_limit);
    if (valid.length) {
        let best = valid[0];
        for (const f of valid) if (f[3].length > best[3].length) best = f;
        return [best[3], best[0], best[1], best[2], best[2] && best[2].source, null, ''];
    }
    let best = fetched[0];
    for (const f of fetched) if (f[3].length > best[3].length) best = f;
    return [best[3], best[0], best[1], best[2], best[2] && best[2].source, null, ''];
}

// 核心入口：可被主进程 require 后调用，返回结果对象，不调用 process.exit（避免杀掉宿主进程）。
// 副作用：会把弹幕 XML 写到 out 路径（供 MPV / PotPlayer 读取）。
async function run(title, ep_num, out, agg_threshold) {
    _refresh_cookie();
    if (typeof ep_num === 'string') ep_num = parseInt(ep_num, 10);
    if (isNaN(ep_num)) ep_num = 0;
    if (typeof agg_threshold === 'string') agg_threshold = parseInt(agg_threshold, 10);
    if (isNaN(agg_threshold) || !agg_threshold) agg_threshold = 1500;
    log(`番名=${title} 集数=${ep_num} 聚合阈值=${agg_threshold}` + (COOKIE ? ' [登录态]' : ' [匿名]'));

    const candidates = await search_cid(title, ep_num);
    if (!candidates.length) {
        log('未找到B站对应集（可能番名不匹配或网络受限）');
        return { ok: false, error: '未找到匹配的B站视频' };
    }

    const AGG_TIME_LIMIT = 2200;
    const MIN_DANMAKU = 10;
    const CAP = 10;

    const fetched = [];
    for (let idx = 0; idx < Math.min(candidates.length, CAP); idx++) {
        const [cid, atitle, info] = candidates[idx];
        const label = (info && info.bvid) || atitle || `候选#${idx + 1}`;
        log(`[${idx + 1}/${candidates.length}] 尝试 cid=${cid} (${label})`);
        const [ok, all_d] = await try_fetch_danmaku(cid);
        if (ok && all_d.length) {
            let max_t = 0;
            for (const [pr] of all_d) if (pr > max_t) max_t = pr;
            max_t = max_t / 1000.0;
            fetched.push([cid, atitle, info, all_d, max_t]);
            log(`  -> ${all_d.length} 条弹幕, 时间轴 0~${max_t.toFixed(0)}s`);
        } else {
            log(`  ⚠️ 候选[${idx + 1}] ${label} 无弹幕数据，跳过`);
        }
    }

    if (!fetched.length) {
        const tried = candidates.map(([, atitle, info], i) => (info && info.bvid) || atitle || `#${i + 1}`).join(', ');
        log(`全部 ${candidates.length} 个候选均无弹幕数据: ${tried}`);
        return { ok: false, error: `已试${candidates.length}个候选均无弹幕数据(${tried})` };
    }

    const [final_dm, best_cid, best_atitle, best_info, source, agg_count, srcs] = _select_danmaku(fetched, agg_threshold, AGG_TIME_LIMIT, MIN_DANMAKU);
    const block_types = _load_block_types();
    let final = final_dm;
    if (block_types.size) {
        const before = final.length;
        final = _filter_danmaku(final, block_types);
        log(`弹幕屏蔽类型生效: 移除 ${before - final.length} 条 (类型=${[...block_types].sort().join(',')}), 剩余 ${final.length} 条`);
    }
    _write_xml(out, final);
    const result = {
        ok: true,
        bvid: best_info && best_info.bvid ? best_info.bvid : null,
        title: title,
        matched_title: best_atitle || title,
        sim: (best_info && typeof best_info.sim === 'number') ? best_info.sim : null,
        danmaku_count: final.length,
        source: source,
        cid: best_cid,
    };
    if (agg_count) result.aggregated_from = agg_count;
    if (agg_count) {
        log(`✅ 最终输出(聚合 ${agg_count} 源): ${best_atitle} -> ${final.length} 条弹幕 (源: ${srcs}) -> ${out}`);
    } else {
        log(`✅ 最终输出: ${best_atitle} -> ${final.length} 条弹幕 (source=${source}) -> ${out}`);
    }
    return result;
}

// CLI 入口：解析 argv -> run -> 输出 BILI_RESULT 到 stdout -> 退出码。
// （历史用法：node bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值]）
async function main() {
    if (process.argv.length < 4) {
        log('用法: bili_danmaku.js <番名> <集数> <输出xml> [聚合阈值]');
        process.exit(2);
    }
    const title = process.argv[2];
    const ep_num = process.argv[3];
    const out = process.argv[4];
    const agg_threshold = process.argv[5];
    try {
        const result = await run(title, ep_num, out, agg_threshold);
        process.stdout.write('BILI_RESULT:' + JSON.stringify(result) + '\n');
        process.exit(result.ok ? 0 : 1);
    } catch (e) {
        log('致命错误: ' + (e && e.stack ? e.stack : e));
        process.stdout.write('BILI_RESULT:' + JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }) + '\n');
        process.exit(1);
    }
}

module.exports = { run: run, setLogSink: setLogSink, _load_cookie: _load_cookie };

if (require.main === module) {
    main();
}
