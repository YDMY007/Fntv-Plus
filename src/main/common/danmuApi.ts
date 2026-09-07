import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../../modules/logger';
import * as fnConfig from '../../modules/fn_config/config';
import type { BiliDanmakuResult, BiliCandidate } from './biliRunner';

const log = logger.component('danmuApi');

/**
 * [lc-1101] 自建弹幕接口（danmu_api）客户端 —— 弹幕【优选源】。
 *
 * 用户在 NAS/Docker 自部署 https://github.com/huangxd-/danmu_api （LogVar 弹幕API），
 * 它把哔哩/爱奇艺/优酷/腾讯/咪咕/360/人人等多个平台的弹幕聚合到同一集，密度显著高于
 * 本应用内置的「直连 B站 单源 + 阈值聚合」链路（实测《摇曳露营△ 第三季》第1话 3547 条）。
 *
 * 接入方式：不改 mpv Lua 的 HTTP/解析代码，只在 biliRunner 的三个入口前面挂一层优选——
 * 命中就把 danmu_api 的 XML 写到调用方给的同一个 out 路径、回同一份 JSON 契约
 * （`{ok,danmaku_count,source,title,...}`，即 Lua 侧的 BILI_INFO）；未命中返回 null，
 * 由调用方原样降级到内置 B站 链路。danmu_api 的 XML 就是 B站 兼容格式
 * `<i><d p="time,mode,size,color,ts,pool,uid,dbid">text</d></i>`，
 * 实测 3547/3547 条同时命中 Lua(parse.lua:212) 与 TS(biliDanmaku.ts:248) 两个解析器，
 * 因此解析/渲染/ASS 转换全链路零改动。
 *
 * 三条链路：搜索条目 → 取分集定位 episodeId → 拉弹幕 XML。
 * 不用官方更省事的一发命中接口 `/api/v2/fongmi/danmaku?name=&episode=`：实测它做宽松模糊匹配，
 * 搜「流浪地球2」会返回「悠久之翼2」这类完全不相干的条目（挂错弹幕比没弹幕更糟），
 * 且 episode=0 恒返回空数组。所以这里自己搜 + 自己做标题相关性打分，低分一律判未命中。
 */

/** 回给 Lua/渲染层的来源标识（menu.lua 直接把它当 src_label 显示） */
const SOURCE_LABEL = '自建源(danmu_api)';

/**
 * 某个 `meta.source` 是否出自本模块。
 * 供 biliDanmaku 校验磁盘缓存的来源，避免把 SOURCE_LABEL 字面量复制到第二个文件里
 * （复制必然导致日后改标签时两处不同步）。老缓存的 source 可能是 undefined/空串，一律判非自建源。
 */
export function isSelfHostedSource(source: unknown): boolean {
    return source === SOURCE_LABEL;
}

/** 候选列表里回填给 Lua 的伪 bvid 前缀：用户选定后据此把请求路由回本模块 */
export const ID_PREFIX = 'dmapi:';
/** 标题相关性下限：低于此分判未命中（防挂错弹幕） */
const MIN_SCORE = 0.34;
/** 最多尝试几个搜索条目（每个条目要再打一次分集接口，服务端默认限流 3 次/分钟） */
const MAX_TRIES = 3;
/** 搜索/分集结果缓存 TTL：连播同番时不必每集重搜 */
const SEARCH_TTL = 10 * 60 * 1000;
const MAX_BODY = 32 * 1024 * 1024;

interface AnimeHit {
    animeId: number;
    animeTitle: string;
    episodeCount: number;
    source: string;
    score: number;
}

interface EpisodeHit {
    episodeId: number;
    episodeTitle: string;
}

interface CacheEntry<T> {
    at: number;
    val: T;
}

const searchCache = new Map<string, CacheEntry<any[]>>();
const bangumiCache = new Map<string, CacheEntry<any[]>>();

/** 开关 + 地址都合法才算「已配置」；否则一切调用直接短路，行为与接入前完全一致。 */
export function isActive(): boolean {
    try {
        return fnConfig.getDanmuApiEnabled() && isValidBase(fnConfig.getDanmuApiBase());
    } catch (_) {
        return false;
    }
}

/** 地址白名单式校验：只收 http(s)://主机[:端口][/前缀]，挡掉换行等非法字符（防拼出畸形请求）。 */
export function isValidBase(base: string): boolean {
    return /^https?:\/\/[a-z0-9._\-]+(:\d{1,5})?(\/[a-z0-9._\-/]*)?$/i.test(String(base || '').trim());
}

function currentBase(): string {
    return String(fnConfig.getDanmuApiBase() || '').trim().replace(/\/+$/, '');
}

// ===================== HTTP =====================

/** [lc-1104] 日志脱敏：自建 danmu_api 的 TOKEN 是 base 的**路径**段（http://host:port/<TOKEN>），
 *  把完整 url 打进 app.log 等于将凭据摊在用户会转贴的日志里。只留 host + /api/… 尾段 + query。 */
function safeUrl(u: string): string {
    try {
        const p = new URL(u);
        const i = p.pathname.indexOf('/api/');
        return p.host + (i >= 0 ? p.pathname.slice(i) : p.pathname) + p.search;
    } catch (_) {
        return '(非法地址)';
    }
}

/** GET 文本（内置超时 + 体积上限）；任何失败返回 null，绝不抛给调用方。 */
function httpGet(u: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
        let req: http.ClientRequest;
        try {
            const mod = u.startsWith('https:') ? https : http;
            req = mod.get(u, (res) => {
                const status = res.statusCode || 0;
                if (status < 200 || status >= 300) {
                    res.resume();
                    log.warn(`[danmuApi] HTTP ${status} | ${safeUrl(u)}`);
                    finish(null);
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_BODY) {
                        log.warn(`[danmuApi] 响应超过 ${MAX_BODY} 字节上限，中断 | ${safeUrl(u)}`);
                        try { res.destroy(); } catch (_) { /* ignore */ }
                        finish(null);
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
                res.on('error', (e) => { log.warn(`[danmuApi] 响应错误: ${e?.message || e}`); finish(null); });
            });
        } catch (e: any) {
            log.warn(`[danmuApi] 请求构造失败: ${e?.message || e}`);
            finish(null);
            return;
        }
        req.setTimeout(timeoutMs, () => {
            log.warn(`[danmuApi] 请求超时(${timeoutMs}ms) | ${safeUrl(u)}`);
            try { req.destroy(); } catch (_) { /* ignore */ }
            finish(null);
        });
        req.on('error', (e: any) => { log.warn(`[danmuApi] 请求失败: ${e?.message || e} | ${safeUrl(u)}`); finish(null); });
    });
}

async function getJson(u: string, timeoutMs: number): Promise<any | null> {
    const body = await httpGet(u, timeoutMs);
    if (!body) return null;
    try {
        return JSON.parse(body);
    } catch (e: any) {
        log.warn(`[danmuApi] JSON 解析失败: ${e?.message || e} | ${safeUrl(u)}`);
        return null;
    }
}

// ===================== 标题相关性 =====================

/** 归一化番名：去年份/类型标签/来源后缀/包裹符号/装饰符，与 biliDanmaku.ts:32 的清洗口径一致并更激进。 */
export function normalizeTitle(s: string): string {
    return String(s || '')
        .replace(/【[^】]*】/g, '')
        .replace(/[\[(（](?:19|20)\d{2}[\])）]/g, '')
        // 末尾「from <平台>」后缀必须锚定行尾、且不能用 \bfrom：标题以 ASCII 数字结尾时
        // （《流浪地球2》去年份后成「流浪地球2from 360」）数字与 f 之间无词边界，\b 会整段漏剥
        // （实测产出「流浪地球2from360」，精确匹配退化为前缀匹配）。锚定行尾也避免误伤片名含 From 的作品。
        .replace(/\s*from\s+[a-z0-9]+\s*$/i, '')
        .replace(/[『』「」〔〕《》〈〉""''（）()·:：!！?？,，.。、\-_—~～△▲★☆♥・\s]/g, '')
        .toLowerCase();
}

function bigrams(s: string): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
}

/**
 * 相关性：完全相同=1；候选以查询开头（分季/副标题，如「老友记」→「老友记 第一季」）=0.95；
 * 查询以候选开头=0.9；其它「包含」（中缀/后缀）按长度比重罚分；否则字符二元组 Jaccard。
 *
 * ⚠️ 中缀必须重罚（lc-1101 实测）：danmu_api 的搜索结果里混着「名字恰好带查询串的另一部作品」，
 * 查询《老友记》会返回《古宅老友记 第一季》《曼谷老友记》《速通老友记》。旧口径一律给 0.95，
 * 会把它们抬到真正的《老友记》前面 —— 挂错弹幕比没弹幕更糟。前缀匹配则安全：
 * 《流浪地球2》→《流浪地球2：再次冒险》(纪录片) 拿 0.95，而《流浪地球2(2023)》精确匹配拿 1.0，排序自然选对。
 */
export function similarity(query: string, cand: string): number {
    const a = normalizeTitle(query);
    const b = normalizeTitle(cand);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (b.startsWith(a)) return 0.95;
    if (a.startsWith(b)) return 0.9;
    if (a.includes(b) || b.includes(a)) {
        return 0.5 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
    }
    const A = bigrams(a);
    const B = bigrams(b);
    let inter = 0;
    A.forEach((g) => { if (B.has(g)) inter++; });
    const union = A.size + B.size - inter;
    return union > 0 ? inter / union : 0;
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 条目标题里是否标明第 N 季/期（阿拉伯或中文数字），用于多季时优先选中正确的那一季。 */
function hasSeason(title: string, season: number): boolean {
    if (!(season > 0)) return false;
    const cn = CN_NUM[season] || String(season);
    const re = new RegExp(`(第\\s*(0*${season}|${cn})\\s*[季期部]|season\\s*0*${season}|\\bs0*${season}\\b)`, 'i');
    return re.test(String(title || ''));
}

// 别名封顶分：高于 MIN_SCORE（能救回「只有别名对得上」的作品），但低于任何真实标题匹配（0.9+）
const ALIAS_CAP = 0.6;

/**
 * 条目相关性 = 标题分优先，别名只在标题没匹配上时兜底且封顶。
 * ⚠️ 别名不可与标题同权（lc-1101 实测）：《古宅老友记 第一季》的 aliases 含「老友记」，
 * 若让别名精确匹配拿 1.0，查询《老友记》就会挂上《古宅老友记》的弹幕。
 */
function bestScore(query: string, a: any): number {
    const titleScore = similarity(query, String((a && a.animeTitle) || ''));
    if (titleScore >= MIN_SCORE) return titleScore;
    let best = titleScore;
    const aliases = Array.isArray(a && a.aliases) ? a.aliases : [];
    for (const n of aliases) {
        if (!n) continue;
        const s = Math.min(similarity(query, String(n)), ALIAS_CAP);
        if (s > best) best = s;
    }
    return best;
}

// ===================== 搜索 / 分集 =====================

/**
 * 搜索关键词候选：原始 title 优先，失败时回退到砍掉集标题后缀的首段。
 * ⚠️ 必须回退（lc-1101 实机实测）：播放侧传来的 title 是「番名 + 集标题」粘成的整串
 * （如「悬案 - : 矢量」），danmu_api 服务端的模糊搜索对这种整串**直接返回 0 条**，
 * 而砍成番名「悬案」能返回 38 条且首条即目标 —— 不回退就等于优选源恒未命中、白白降级。
 * 只作回退不作首选：番名本身含「 - 」的作品（如「XX - 副标题」）砍首段仍能靠
 * 相关性打分 + 季数优先排序选对条目，但整串能命中时精度更高。
 */
function keywordCandidates(title: string): string[] {
    const raw = String(title || '').trim();
    if (!raw) return [];
    const segs = raw.split(/\s*[-–—]\s*|\s*[:：]\s*/).map((s) => s.trim()).filter(Boolean);
    const head = segs[0] || '';
    return head && head !== raw ? [raw, head] : [raw];
}

/** 搜索条目并按相关性排序（同分时优先 bilibili 源、优先季数匹配的条目）。 */
async function searchAnimes(title: string, season: number): Promise<AnimeHit[]> {
    const cands = keywordCandidates(title);
    for (let i = 0; i < cands.length; i++) {
        const hits = await searchWithKeyword(cands[i], title, season);
        if (hits.length) {
            if (i > 0) {
                log.info(`[danmuApi] 整串关键词无相关条目，回退番名首段命中 | ${JSON.stringify(title)} → ${JSON.stringify(cands[i])} | ${hits.length} 条`);
            }
            return hits;
        }
    }
    return [];
}

async function searchWithKeyword(keyword: string, title: string, season: number): Promise<AnimeHit[]> {
    const base = currentBase();
    const key = normalizeTitle(keyword);
    let animes: any[] | null = null;
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_TTL) {
        animes = cached.val;
    } else {
        const j = await getJson(`${base}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`, 12000);
        if (!j || j.success === false || !Array.isArray(j.animes)) {
            log.warn(`[danmuApi] 搜索无结果或服务异常 | keyword=${keyword} err=${(j && j.errorMessage) || '无响应'}`);
            return [];
        }
        const list: any[] = j.animes;
        animes = list;
        searchCache.set(key, { at: Date.now(), val: list });
    }
    const hits: AnimeHit[] = [];
    for (const a of animes || []) {
        const id = Number(a && a.animeId);
        if (!id) continue;
        const score = bestScore(title, a);
        if (score < MIN_SCORE) continue;
        hits.push({
            animeId: id,
            animeTitle: String((a && a.animeTitle) || ''),
            episodeCount: Number((a && a.episodeCount) || 0),
            source: String((a && a.source) || ''),
            score,
        });
    }
    hits.sort((x, y) => {
        const sx = hasSeason(x.animeTitle, season) ? 1 : 0;
        const sy = hasSeason(y.animeTitle, season) ? 1 : 0;
        if (sx !== sy) return sy - sx;
        if (y.score !== x.score) return y.score - x.score;
        const bx = x.source === 'bilibili' ? 1 : 0;
        const by = y.source === 'bilibili' ? 1 : 0;
        return by - bx;
    });
    return hits;
}

/** 取分集列表（带缓存），失败返回空数组。 */
async function episodesOf(animeId: number): Promise<any[]> {
    const base = currentBase();
    const key = String(animeId);
    const cached = bangumiCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.val;
    const j = await getJson(`${base}/api/v2/bangumi/${animeId}`, 12000);
    const eps = j && j.bangumi && Array.isArray(j.bangumi.episodes) ? j.bangumi.episodes : [];
    bangumiCache.set(key, { at: Date.now(), val: eps });
    return eps;
}

/** 分集标题里兜底提集数（形如「【bilibili1】 第1话 下次去哪里呢」），episodeNumber 缺失时用。 */
function epFromTitle(t: string): number {
    const m = String(t || '').match(/第\s*(\d{1,4})\s*[话集期]/);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * 在条目里定位目标集。ep<=0（电影/仅标题兜底）时只认「单集条目」，
 * 多集条目宁可判未命中也不瞎选第1集——挂错集的弹幕比没有弹幕更糟。
 */
async function pickEpisode(hit: AnimeHit, ep: number): Promise<EpisodeHit | null> {
    const eps = await episodesOf(hit.animeId);
    if (!eps.length) return null;
    if (!(ep > 0)) {
        if (eps.length === 1 || hit.episodeCount === 1) {
            const e = eps[0];
            const id = Number(e && e.episodeId);
            return id ? { episodeId: id, episodeTitle: String((e && e.episodeTitle) || '') } : null;
        }
        return null;
    }
    for (const e of eps) {
        const id = Number(e && e.episodeId);
        if (!id) continue;
        const num = parseFloat(String((e && e.episodeNumber) ?? ''));
        if (num === ep || (isNaN(num) && epFromTitle(String((e && e.episodeTitle) || '')) === ep)) {
            return { episodeId: id, episodeTitle: String((e && e.episodeTitle) || '') };
        }
    }
    return null;
}

// ===================== 弹幕 XML =====================

/** 拉弹幕 XML 并落盘（out 由调用方给定，路径安全校验在调用方）；0 条判未命中。 */
async function fetchXml(episodeId: number, out: string): Promise<number> {
    const base = currentBase();
    const body = await httpGet(`${base}/api/v2/comment/${episodeId}?format=xml`, 30000);
    if (!body) return 0;
    const count = (body.match(/<d\s/g) || []).length;
    if (count === 0) {
        log.warn(`[danmuApi] 弹幕 0 条 | episodeId=${episodeId}`);
        return 0;
    }
    try {
        const dir = path.dirname(out);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(out, body, 'utf8');
    } catch (e: any) {
        log.warn(`[danmuApi] 写 XML 失败: ${e?.message || e} | out=${out}`);
        return 0;
    }
    return count;
}

function okResult(count: number, title: string, matchedTitle: string): BiliDanmakuResult {
    return {
        ok: true,
        danmaku_count: count,
        source: SOURCE_LABEL,
        title: matchedTitle || title,
        matched_title: matchedTitle || undefined,
        bvid: null,
        cid: null,
        season_id: null,
        epid: null,
    };
}

/**
 * 自动路径：番名 + 集数 → 搜索 → 定位集 → 拉 XML 落盘。
 * 命中返回与内置 B站 链路同契约的结果；未命中/异常返回 null（调用方降级）。
 */
export async function autoFetch(title: string, ep: number, out: string, season = 0): Promise<BiliDanmakuResult | null> {
    if (!isActive()) return null;
    try {
        const hits = await searchAnimes(title, season);
        if (!hits.length) {
            log.info(`[danmuApi] 未命中（搜索无相关条目）→ 降级内置B站 | title=${title} ep=${ep}`);
            return null;
        }
        for (const hit of hits.slice(0, MAX_TRIES)) {
            const e = await pickEpisode(hit, ep);
            if (!e) {
                log.info(`[danmuApi] 条目无第 ${ep} 集，换下一个 | ${hit.animeTitle}`);
                continue;
            }
            const count = await fetchXml(e.episodeId, out);
            if (count > 0) {
                log.info(`[danmuApi] ✅ 命中 | ${hit.animeTitle} · ${e.episodeTitle || ('第' + ep + '集')} | ${count} 条 (score=${hit.score.toFixed(2)} src=${hit.source})`);
                return okResult(count, title, hit.animeTitle);
            }
        }
        log.info(`[danmuApi] 未命中（${Math.min(hits.length, MAX_TRIES)} 个条目均无有效弹幕）→ 降级内置B站 | title=${title} ep=${ep}`);
        return null;
    } catch (e: any) {
        log.warn(`[danmuApi] autoFetch 异常 → 降级内置B站: ${e?.message || e}`);
        return null;
    }
}

/**
 * 手动搜索路径：返回 Lua 期望形状的候选列表（bvid 位填 `dmapi:<episodeId>`）。
 * 无候选返回 null（调用方降级到 B站 候选）。
 */
export async function candidates(title: string, ep: number, season = 0): Promise<BiliCandidate[] | null> {
    if (!isActive()) return null;
    try {
        const hits = await searchAnimes(title, season);
        const out: BiliCandidate[] = [];
        for (const hit of hits.slice(0, MAX_TRIES + 2)) {
            const e = await pickEpisode(hit, ep);
            if (!e) continue;
            out.push({
                index: out.length,
                cid: null,
                bvid: ID_PREFIX + e.episodeId,
                title: e.episodeTitle ? `${hit.animeTitle} · ${e.episodeTitle}` : hit.animeTitle,
                source: '自建源',
                season: season || 0,
                is_compilation: false,
                sim: hit.score,
            });
        }
        if (!out.length) {
            log.info(`[danmuApi] 候选未命中 → 降级内置B站候选 | title=${title} ep=${ep}`);
            return null;
        }
        log.info(`[danmuApi] ✅ 自建源候选 ${out.length} 个 | title=${title} ep=${ep}`);
        return out;
    } catch (e: any) {
        log.warn(`[danmuApi] candidates 异常 → 降级内置B站: ${e?.message || e}`);
        return null;
    }
}

/** 用户在候选列表里选了自建源条目（伪 bvid = `dmapi:<episodeId>`）后按 id 拉弹幕。 */
export async function fetchById(prefixedId: string, title: string, out: string): Promise<BiliDanmakuResult> {
    const id = parseInt(String(prefixedId || '').replace(/^dmapi:/, ''), 10);
    if (!id) return { ok: false, error: '自建源候选 id 无效' };
    if (!isActive()) return { ok: false, error: '自建弹幕接口未启用' };
    const count = await fetchXml(id, out);
    if (count <= 0) return { ok: false, error: '自建弹幕接口未返回弹幕' };
    log.info(`[danmuApi] ✅ 按选定 id 拉取成功 | episodeId=${id} | ${count} 条`);
    return okResult(count, title, title);
}

/** 设置面板「测试连接」：探一次搜索接口，回可读结论。 */
export async function testConnection(baseOverride?: string): Promise<{ ok: boolean; message: string }> {
    const raw = String(baseOverride || '').trim() || fnConfig.getDanmuApiBase();
    const base = String(raw || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, message: '请先填写服务地址' };
    if (!isValidBase(base)) return { ok: false, message: '地址格式应为 http://IP:端口（如 http://192.168.1.10:9321）' };
    const j = await getJson(`${base}/api/v2/search/anime?keyword=${encodeURIComponent('测试')}`, 8000);
    if (!j) return { ok: false, message: '连不上（地址/端口/防火墙/Docker 未运行？）' };
    if (j.success === false) return { ok: false, message: '服务有响应但报错：' + String(j.errorMessage || '未知') };
    const n = Array.isArray(j.animes) ? j.animes.length : 0;
    return { ok: true, message: `连通正常（试搜「测试」返回 ${n} 条结果）` };
}

/** 从 Lua 回流的可疑伪 bvid 里取出自建源 episodeId；不是自建源 id 返回 null。 */
export function parsePrefixedId(bvid: string): string | null {
    const s = String(bvid || '');
    return s.startsWith(ID_PREFIX) ? s.slice(ID_PREFIX.length) : null;
}
