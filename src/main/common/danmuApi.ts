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
 * 且 episode=0 恒返回空数组。所以这里自己搜，并且**只认精确匹配**（主名归一化后完全相等、
 * 季号一致），不匹配一律判未命中 —— 模糊匹配留给内置 B站 链路，那条链路只查 B站、条目少（lc-1109）。
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
    /** 季号匹配档位（SEASON_TIER_*，越小越优先）：主名已精确相等，这里只决定同作品多条目谁先试 */
    seasonTier: number;
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

/** 中文季号 → 数字（服务端实测只出现 一~十，多留两位防「十一」这类写法）。 */
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function seasonToInt(s: string): number {
    const t = String(s || '').trim();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (t.length === 1) return CN_NUM[t] || 0;
    if (t[0] === '十') return 10 + (CN_NUM[t[1]] || 0);
    if (t.endsWith('十')) return (CN_NUM[t[0]] || 0) * 10;
    return 0;
}

/**
 * 季号标记。实测服务端写法有「第一季」「第1季」「第3季」，另兼容 Season N / S0N。
 * 「最终季」这类非数字写法**不当季号**：留在主名里让精确匹配自然落空，比猜一个季号安全
 * （猜错就是挂错季的弹幕）。
 */
const SEASON_MARK_RE = /第\s*(0*\d{1,2}|[一二三四五六七八九十]{1,3})\s*[季部]|season\s*0*(\d{1,2})|\bs\s*0*(\d{1,2})\b/gi;

/** 拆「作品主名 + 季号」：季号写法多样，先剥季号再归一化，两边才在同一口径下可比。 */
function splitSeason(raw: string): { name: string; season: number } {
    let season = 0;
    const body = String(raw || '').replace(SEASON_MARK_RE, (_m, cn, en, sn) => {
        if (!season) season = seasonToInt(cn || en || sn);
        return ' ';
    });
    return { name: normalizeTitle(body), season };
}

/**
 * 季号匹配档位（主名精确相等之后才轮到它，越小越优先）：
 * 0=候选季号与播放侧一致；1=播放侧没给季号而候选标了第一季；2=候选未标季号（服务端把整部合成一条）。
 * 播放侧明确指向第 N 季(N>1) 而候选未标季号 → 判不匹配：这类合集条目的 episodeNumber 常是全剧
 * 连续编号，按 ep 定位会挂到别的季上（挂错比没弹幕更糟）。
 */
const SEASON_TIER_EXACT = 0;
const SEASON_TIER_IMPLIED_FIRST = 1;
const SEASON_TIER_UNMARKED = 2;

/**
 * 自建源准入 = 精确匹配：主名归一化后**完全相等**，且季号一致。命中返回档位，不匹配返回 null。
 *
 * ⚠️ 自建源不做模糊匹配（lc-1109 实机挂错）：它聚合多平台、条目极密，同名/近名作品扎堆 ——
 * 查《悬案》返回 37 条，混着《探案新窍门 第一季》(aliases 含「悬案神探」)、《李小龙悬案》
 * 《酱园弄·悬案》《悬案委托行》《悬案密码N》。旧的相关性打分（前缀 0.95 / 包含按长度罚分 /
 * 别名封顶 0.6 / 二元组 Jaccard，下限 0.34）只要有任一条错挂条目被 MAX_TRIES 首试且有弹幕，
 * 就把别片的弹幕当本片交出去；季数优先排序键还曾把 0.6 的别名命中抬到 1.0 的精确命中之前。
 * 精确口径下这 37 条只剩《悬案(2026)》youku/360 两条真命中。
 * 模糊匹配保留给内置 B站 链路（bili_danmaku.js）：那边只查 B站、条目少，且是原有行为，不动。
 * 附带好处：`解说版`/`手语版`/`字幕助听版`/`独家专访` 等衍生条目主名不等，自动落空。
 */
function exactMatchTier(query: string, querySeason: number, candTitle: string): number | null {
    const q = splitSeason(query);
    const c = splitSeason(candTitle);
    if (!q.name || q.name !== c.name) return null;
    const want = querySeason > 0 ? querySeason : q.season;
    if (c.season > 0) {
        if (c.season === want) return SEASON_TIER_EXACT;
        if (want === 0 && c.season === 1) return SEASON_TIER_IMPLIED_FIRST;
        return null;
    }
    return want <= 1 ? SEASON_TIER_UNMARKED : null;
}

// ===================== 搜索 / 分集 =====================

/**
 * 搜索关键词候选：原始 title 优先，失败时回退到砍掉集标题后缀的首段。
 * ⚠️ 必须回退（lc-1101 实机实测）：播放侧传来的 title 是「番名 + 集标题」粘成的整串
 * （如「悬案 - : 矢量」），danmu_api 服务端的模糊搜索对这种整串**直接返回 0 条**，
 * 而砍成番名「悬案」能返回 37 条并含目标 —— 不回退就等于优选源恒未命中、白白降级。
 * 精确匹配下两轮都省不掉：整串那轮负责「番名自带副标题」的作品（「命运石之门 - 负荷领域的既视感」
 * 归一化剥掉「 - 」后正好等于服务端条目标题，砍成首段反而不匹配）；首段那轮负责集标题粘连的情况。
 */
function keywordCandidates(title: string): string[] {
    const raw = String(title || '').trim();
    if (!raw) return [];
    const segs = raw.split(/\s*[-–—]\s*|\s*[:：]\s*/).map((s) => s.trim()).filter(Boolean);
    const head = segs[0] || '';
    return head && head !== raw ? [raw, head] : [raw];
}

/** 搜索条目并只留精确匹配的（同作品多平台条目按季号档位排序，同档位优先 bilibili 源）。 */
async function searchAnimes(title: string, season: number): Promise<AnimeHit[]> {
    const cands = keywordCandidates(title);
    for (let i = 0; i < cands.length; i++) {
        const hits = await searchWithKeyword(cands[i], season);
        if (hits.length) {
            if (i > 0) {
                log.info(`[danmuApi] 整串关键词无精确匹配，回退番名首段命中 | ${JSON.stringify(title)} → ${JSON.stringify(cands[i])} | ${hits.length} 条`);
            }
            return hits;
        }
    }
    return [];
}

async function searchWithKeyword(keyword: string, season: number): Promise<AnimeHit[]> {
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
        const animeTitle = String((a && a.animeTitle) || '');
        // 比对对象是**搜索关键词**而不是整串 title：整串常粘着集标题（「悬案 - : 矢量」），
        // 归一化后主名不可能相等，拿它比会把所有条目判空。
        const tier = exactMatchTier(keyword, season, animeTitle);
        if (tier === null) continue;
        hits.push({
            animeId: id,
            animeTitle,
            episodeCount: Number((a && a.episodeCount) || 0),
            source: String((a && a.source) || ''),
            seasonTier: tier,
        });
    }
    hits.sort((x, y) => {
        if (x.seasonTier !== y.seasonTier) return x.seasonTier - y.seasonTier;
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

/** sim 恒为 1：自建源只收精确匹配，网页「来源详情」显示的匹配相似度因此总是 100%；
 *  用户手选条目那条路径没有相似度概念，传 null（面板显示「—」）。 */
function okResult(count: number, title: string, matchedTitle: string, sim: number | null): BiliDanmakuResult {
    return {
        ok: true,
        danmaku_count: count,
        source: SOURCE_LABEL,
        title: matchedTitle || title,
        matched_title: matchedTitle || undefined,
        sim,
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
            log.info(`[danmuApi] 未命中（无精确匹配条目）→ 降级内置B站(模糊匹配) | title=${title} ep=${ep} season=${season}`);
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
                log.info(`[danmuApi] ✅ 精确命中 | ${hit.animeTitle} · ${e.episodeTitle || ('第' + ep + '集')} | ${count} 条 (seasonTier=${hit.seasonTier} src=${hit.source})`);
                return okResult(count, title, hit.animeTitle, 1);
            }
        }
        log.info(`[danmuApi] 未命中（${Math.min(hits.length, MAX_TRIES)} 个精确匹配条目均无有效弹幕）→ 降级内置B站(模糊匹配) | title=${title} ep=${ep}`);
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
                sim: 1,
            });
        }
        if (!out.length) {
            log.info(`[danmuApi] 候选未命中（无精确匹配条目）→ 降级内置B站候选 | title=${title} ep=${ep}`);
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
    return okResult(count, title, title, null);
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
