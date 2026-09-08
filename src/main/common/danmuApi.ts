import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as dns from 'dns';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../../modules/logger';
import * as fnConfig from '../../modules/fn_config/config';
import { resolveProxyAgent } from '../../modules/proxyAgent';
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
 *  把完整 url 打进 app.log 等于将凭据摊在用户会转贴的日志里。只留 host + /api/… 尾段 + query。
 *  [lc-1115] 补漏：路径里没有 /api/ 时（诊断的「根路径应答」就是这种）原先会整段回显 = 直接印出 TOKEN，
 *  现在一律隐藏；工装 G 组专门盯这条。 */
function safeUrl(u: string): string {
    try {
        const p = new URL(u);
        const i = p.pathname.indexOf('/api/');
        return p.host + (i >= 0 ? p.pathname.slice(i) : '/<路径前缀·已隐藏>') + p.search;
    } catch (_) {
        return '(非法地址)';
    }
}

/** GET 文本（内置超时 + 体积上限）；任何失败返回 null，绝不抛给调用方。 */
function httpGet(u: string, timeoutMs: number): Promise<string | null> {
    return httpGetEx(u, timeoutMs).then((p) => p.body);
}

interface HttpProbe {
    body: string | null;
    /** 0 = 没拿到响应（连接/解析阶段就挂了） */
    status: number;
    ms: number;
    bytes: number;
    /** Node 错误码或 'ETIMEDOUT'(自建超时)，'' = 无错误 */
    err: string;
    /** 只留诊断要用的几个头（server/content-type 能分清「直连容器」还是「走了反代」） */
    server: string;
    ctype: string;
    /** 非 2xx 时从 JSON 里抽出的 errorMessage（不含原始 body） */
    errMsg: string;
    /**
     * [lc-1116] 一行请求明细（URL 已脱敏）：分段耗时 + 实际连到的地址 + 连接是否复用 + 关键响应头 + 错误原文。
     * 精简的 detail 给人看，这条给排查用 —— 「公网连不上」和「时好时坏」的区别全藏在这些细节里
     * （连到的是不是 DNS 给的那个 IP、走没走隧道网口、连接是新建还是复用、有没有反代 via）。
     */
    dbg: string;
}

/**
 * [lc-1115] 带归因的 GET：诊断套件要把「连不上」拆成 DNS / TCP / TLS / HTTP / 业务 五层，
 * 而旧 httpGet 把所有失败压成一个 null，用户侧只剩一句「连不上（地址/端口/防火墙/Docker 未运行？）」。
 * 失败不抛、不吞，一律结构化返回。
 */
function httpGetEx(u: string, timeoutMs: number, agent?: any): Promise<HttpProbe> {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        // [lc-1116] 分段耗时：把「慢」拆成 dns / tcp / tls / 等首字节 四段，才知道慢在哪一段
        const mark = { lookup: 0, connect: 0, secure: 0, head: 0 };
        let sockDesc = '';
        let httpVer = '';
        let via = '';
        let dateH = '';
        let loc = '';
        let errRaw = '';
        const segOf = (): string => {
            const n = (v: number): string => (v ? `${v}ms` : '-');
            return `dns=${n(mark.lookup)}`
                + ` tcp=${n(mark.connect ? mark.connect - (mark.lookup || 0) : 0)}`
                + ` tls=${n(mark.secure ? mark.secure - mark.connect : 0)}`
                + ` 首字节=${n(mark.head)} 总=${n(Date.now() - t0)}`;
        };
        const describeSocket = (s: any): string => {
            if (!s) return 'socket=未建连';
            const parts = [`远端 ${s.remoteAddress || '?'}:${s.remotePort || '?'}`, `本地网口 ${s.localAddress || '?'}:${s.localPort || '?'}`];
            if (s.reused) parts.push('连接复用');
            if (s.authorizationError) parts.push(`证书错误=${s.authorizationError}`);
            try {
                const proto = typeof s.getProtocol === 'function' ? s.getProtocol() : '';
                if (proto) parts.push(proto);
                const c = typeof s.getCipher === 'function' ? s.getCipher() : null;
                if (c?.name) parts.push(`cipher=${c.name}`);
            } catch (_) { /* 非 TLS socket */ }
            return parts.join(' ');
        };
        const finish = (p: Partial<HttpProbe>) => {
            if (done) return;
            done = true;
            const dbg = `GET ${safeUrl(u)} → ${p.status || '--'} ${p.bytes || 0}B`
                + ` ｜ ${segOf()} ｜ ${sockDesc || 'socket=未建连'}`
                + (httpVer ? ` ｜ HTTP/${httpVer}` : '')
                + (p.server ? ` server=${p.server}` : '')
                + (via ? ` via=${via}` : '')
                + (dateH ? ` date=${dateH}` : '')
                + (loc ? ` location=${safeUrl(loc)}` : '')
                + (agent ? ` ｜ agent=${agent.constructor?.name || 'custom'}` : '')
                + (p.err ? ` ｜ err=${p.err}${errRaw ? ' (' + errRaw + ')' : ''}` : '');
            resolve({ body: null, status: 0, ms: Date.now() - t0, bytes: 0, err: '', server: '', ctype: '', errMsg: '', dbg, ...p } as HttpProbe);
        };
        let req: http.ClientRequest;
        const opt: http.RequestOptions = {};
        if (agent) opt.agent = agent;
        try {
            const mod = u.startsWith('https:') ? https : http;
            req = mod.get(u, opt, (res) => {
                mark.head = Date.now() - t0;
                const status = res.statusCode || 0;
                const head = (k: string) => {
                    const v = res.headers[k];
                    return Array.isArray(v) ? v.join(',') : String(v || '');
                };
                const server = head('server'); const ctype = head('content-type');
                httpVer = String(res.httpVersion || '');
                via = head('via'); dateH = head('date'); loc = head('location');
                sockDesc = describeSocket((req as any).socket);
                if (status < 200 || status >= 300) {
                    // [lc-1115] 非 2xx 也要带回服务自报的原因：danmu_api 令牌错就是 401 + {"errorMessage":"Unauthorized"}，
                    // 光一个状态码分不出「令牌写错」和「端口上是别的服务」。只抽 errorMessage，不回显原始 body。
                    let raw = '';
                    res.on('data', (c: Buffer) => { if (raw.length < 4096) raw += c.toString('utf8'); });
                    res.on('end', () => {
                        let msg = '';
                        try {
                            const j = JSON.parse(raw);
                            msg = String(j.errorMessage || j.error || j.message || '').slice(0, 60);
                        } catch (_) { /* 非 JSON（HTML 错误页等）不抽 */ }
                        log.warn(`[danmuApi] HTTP ${status}${msg ? ' ' + msg : ''} | ${safeUrl(u)}`);
                        finish({ status, err: '', server, ctype, errMsg: msg });
                    });
                    res.on('error', () => finish({ status, err: '', server, ctype }));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_BODY) {
                        log.warn(`[danmuApi] 响应超过 ${MAX_BODY} 字节上限，中断 | ${safeUrl(u)}`);
                        try { res.destroy(); } catch (_) { /* ignore */ }
                        finish({ status, err: 'ETOOLARGE', server, ctype });
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    finish({ body, status, bytes: size, server, ctype });
                });
                res.on('error', (e: any) => {
                    errRaw = String(e?.message || e).slice(0, 120);
                    log.warn(`[danmuApi] 响应错误: ${e?.message || e}`);
                    finish({ status, err: String(e?.code || e?.message || 'STREAM_ERROR'), server, ctype });
                });
            });
        } catch (e: any) {
            errRaw = String(e?.message || e).slice(0, 120);
            log.warn(`[danmuApi] 请求构造失败: ${e?.message || e}`);
            finish({ err: String(e?.code || 'CONSTRUCT_FAILED') });
            return;
        }
        req.on('lookup', (e: any, address: string) => {
            mark.lookup = Date.now() - t0;
            if (e) errRaw = String(e.message || e).slice(0, 120);
            else sockDesc = `DNS 给出 ${address} ` + sockDesc;
        });
        req.on('connect', () => { mark.connect = Date.now() - t0; sockDesc = describeSocket((req as any).socket); });
        req.on('secureConnect', () => { mark.secure = Date.now() - t0; sockDesc = describeSocket((req as any).socket); });
        req.setTimeout(timeoutMs, () => {
            errRaw = `socket 空闲超 ${timeoutMs}ms 被销毁`;
            log.warn(`[danmuApi] 请求超时(${timeoutMs}ms) | ${safeUrl(u)}`);
            try { req.destroy(); } catch (_) { /* ignore */ }
            finish({ err: 'ETIMEDOUT' });
        });
        req.on('error', (e: any) => {
            errRaw = String(e?.message || e).slice(0, 120);
            log.warn(`[danmuApi] 请求失败: ${e?.message || e} | ${safeUrl(u)}`);
            finish({ err: String(e?.code || e?.message || 'REQ_ERROR') });
        });
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

// ===================== [lc-1115] 分层连通诊断 =====================
//
// 用户反馈两种症状：① 公网环境连不上；② 内网有时连得上、有时连不上。旧「测试连接」只有一发
// search 请求，任何失败都被压成同一句「连不上（地址/端口/防火墙/Docker 未运行？）」。要分清真凶，
// 只能把链路拆开逐层量：地址形态 → 本机有没有能直达它的路由 → DNS → TCP → TLS → 服务应答 →
// 三跳业务链路 → 重复探测的耗时分布 → 代理旁路。
//
// 实测背景（内网活服务）：search 冷关键词回源多平台要 1~3s，命中服务端缓存只 15ms —— 相差约 200 倍，
// 所以「固定探测一个已被缓存的关键词」会让连通性结论随缓存冷热摆动，抖动必须靠耗时分布来判。

export type DiagState = 'ok' | 'warn' | 'fail' | 'skip';

export interface DiagStep {
    id: string;
    label: string;
    state: DiagState;
    ms: number;
    /** 已脱敏：绝不含 base 的路径段（TOKEN 就在那） */
    detail: string;
    /** 面向用户的下一步动作；只有 warn/fail 才给 */
    hint?: string;
    /** [lc-1116] 该层的一行明细（分段耗时/实际连到的地址/连接复用/关键响应头/错误原文，已脱敏）。
     *  app.log 始终落这条；面板按「明细日志」勾选决定是否显示。 */
    dbg?: string;
}

export interface DiagConfig {
    timeoutMs?: number;
    repeats?: number;
    keyword?: string;
    deep?: boolean;
    tryProxy?: boolean;
}

export interface DiagReport {
    steps: DiagStep[];
    summary: string;
    /** 可以安全外发/贴进反馈的地址写法 */
    maskedBase: string;
}

const DIAG_DEF = { timeoutMs: 8000, repeats: 3, keyword: '测试', deep: true, tryProxy: true };

/** 网络层错误码 → 人话。这张表就是「连不上」的归因字典。 */
const NET_ERR_HINT: Record<string, string> = {
    ECONNREFUSED: '对端明确拒绝：该端口上没有在监听的服务（容器没起 / 端口没映射 / 防火墙 REJECT）。',
    ECONNRESET: '连上就被掐断：端口上跑的可能是别的服务，或反代不认这个 Host/IP。',
    ETIMEDOUT: '包被静默丢弃（没人应答）：公网端口未开放 / 云安全组 / 防火墙 DROP / 路由不可达。',
    EHOSTUNREACH: '本机没有到该地址的路由：多半是不在同一网段且没有可达网关。',
    ENETUNREACH: '本机对应网络接口未启用：断网 / VPN 或 Tailscale 未连接。',
    ENOENT: '本机网络栈拒绝该地址（常见于目标为保留地址）。',
    EACCES: '地址被系统拒绝：试图连接本机保留端口。',
    ENOTFOUND: '域名解析不到：域名写错 / 未托管 / DDNS 记录没更新。',
    EAI_AGAIN: 'DNS 临时失败：本机 DNS 服务器无响应或抖动 —— 这类失败天然是间歇性的。',
    EAI_FAIL: 'DNS 查询被服务器拒绝。',
    ERR_TLS_INVALID_CONTEXT: 'TLS 上下文非法：IP 字面量做 SNI 不被允许。',
};

/** TLS 层错误码 → 人话（自签/域名不符是公网 https 的头号死因，必须单独归因）。 */
const TLS_ERR_HINT: Record<string, string> = {
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签证书（证书不是任何 CA 签发的）。',
    SELF_SIGNED_CERT_IN_CHAIN: '证书链里含自签证书（常见于 NAS/反代用 openssl 自签）。',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整，无法验证到根 CA。',
    UNKNOWN_CA: '签发 CA 不被本机信任。',
    UNABLE_TO_GET_ISSUER_CERT: '拿不到签发者证书：服务端没把中间证书一起发出来。',
    CERT_HAS_EXPIRED: '证书已过期。',
    HOSTNAME_VERIFY_ERROR: '证书里的名字与所连地址不符。',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书的 SAN 不覆盖所连的域名/IP。',
    CIRCLE_DEBUG: '证书链成环（服务端配置错误）。',
};

const errHintOf = (code: string): string => {
    return NET_ERR_HINT[code] || TLS_ERR_HINT[code] || '';
};

/**
 * [lc-1104 同源约束] 诊断结果会被用户整段截图转贴，所以这里把 base 压成「协议 + host:port + 有没有路径前缀」。
 * danmu_api 的 TOKEN 就是 base 的路径段，任何原样回显等于把凭据公开。
 */
function maskBase(base: string): string {
    try {
        const p = new URL(base);
        const prefix = String(p.pathname || '').replace(/\/+$/, '');
        return `${p.protocol}//${p.host}${prefix ? '/<路径前缀·已隐藏>' : ''}`;
    } catch (_) {
        return '(无法解析的地址)';
    }
}

function ipFamilyOf(h: string): 0 | 4 | 6 {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 4;
    if (h.includes(':')) return 6;
    return 0;
}

function ipv4ToLong(s: string): number {
    const p = s.split('.').map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return -1;
    return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

/** 地址属于哪一类 —— 直接决定「公网连不上」是不是「填了个只在局域网有效的地址」。 */
function classifyHost(h: string): { kind: string; ip: string; v6: boolean } {
    const fam = ipFamilyOf(h);
    let host = h;
    if (fam === 6) {
        const br = host.indexOf(']');
        if (br > 0) host = host.slice(1, br);
        const lo = host === '::1' || /^f[cd]/i.test(host);
        return { kind: lo ? '回环(IPv6)' : 'IPv6 地址', ip: host, v6: true };
    }
    if (fam !== 4) return { kind: '域名', ip: '', v6: false };
    const a = parseInt(host.split('.')[0], 10);
    const b = parseInt(host.split('.')[1], 10);
    if (a === 127) return { kind: '回环(仅本机)', ip: host, v6: false };
    if (a === 169 && b === 254) return { kind: '链路本地(169.254/16)', ip: host, v6: false };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return { kind: '私网(局域网)', ip: host, v6: false };
    }
    if (a === 100 && b >= 64 && b <= 127) return { kind: 'CGNAT/隧道段(100.64/10)', ip: host, v6: false };
    if (a === 0) return { kind: '保留地址', ip: host, v6: false };
    return { kind: '公网 IP', ip: host, v6: false };
}

/** 本机是否有网口与目标在同一子段（Tailscale/CGNAT 段同理）—— 没有就说明此刻这个地址根本不可达。 */
function localRouteCovers(ip: string): { covered: boolean; same: string; nets: string[] } {
    const target = ipv4ToLong(ip);
    const nets: string[] = [];
    if (target < 0) return { covered: false, same: '', nets };
    let covered = false; let same = '';
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            if (a.family !== 'IPv4') continue;
            const net4 = a.netmask ? ipv4ToLong(a.netmask) : -1;
            if (net4 <= 0) continue;
            const self = ipv4ToLong(a.address);
            const network = self & net4;
            const bits = (() => { let n = 0; let m = net4 >>> 0; while (m) { m = (m << 1) >>> 0; n++; } return n; })();
            nets.push(`${name} ${a.address}/${bits}`);
            if (((target & net4) >>> 0) === (network >>> 0)) { covered = true; same = `${name} ${a.address}/${bits}`; }
        }
    }
    return { covered, same, nets };
}

function tcpProbe(host: string, port: number, timeoutMs: number, family?: 4 | 6):
    Promise<{ ok: boolean; ms: number; err: string; remote: string; via: string }> {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        let sock: net.Socket;
        const finish = (ok: boolean, err?: string, remote?: string, via?: string) => {
            if (done) return;
            done = true;
            try { sock?.destroy(); } catch (_) { /* ignore */ }
            resolve({ ok, ms: Date.now() - t0, err: err || '', remote: remote || '', via: via || '' });
        };
        const opt: net.TcpSocketConnectOpts = { host, port };
        if (family) opt.family = family;
        try {
            sock = net.connect(opt);
        } catch (e: any) {
            finish(false, String(e?.code || e?.message || 'CONNECT_THROW'));
            return;
        }
        sock.setTimeout(timeoutMs);
        sock.on('connect', () => finish(true, '', `${sock.remoteAddress}:${sock.remotePort}`, String(sock.localAddress)));
        sock.on('timeout', () => finish(false, 'ETIMEDOUT'));
        sock.on('error', (e: any) => finish(false, String(e?.code || e?.message || 'SOCK_ERROR')));
    });
}

function tlsProbe(host: string, port: number, timeoutMs: number, reject: boolean):
    Promise<{ ok: boolean; ms: number; err: string; proto: string; to: string; cn: string }> {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        let sock: tls.TLSSocket;
        const finish = (ok: boolean, extra?: { proto?: string; to?: string; cn?: string }, err?: string) => {
            if (done) return;
            done = true;
            try { sock?.destroy(); } catch (_) { /* ignore */ }
            resolve({
                ok, ms: Date.now() - t0, err: err || '',
                proto: (extra && extra.proto) || '', to: (extra && extra.to) || '', cn: (extra && extra.cn) || '',
            });
        };
        const isIp = ipFamilyOf(host) !== 0;
        const opt: tls.ConnectionOptions = {
            host, port, rejectUnauthorized: reject, timeout: timeoutMs,
            // IP 字面量不能做 SNI（Node 会直接拒），域名才带 servername
            ...(isIp ? {} : { servername: host }),
        };
        try {
            sock = tls.connect(opt);
        } catch (e: any) {
            finish(false, undefined, String(e?.code || e?.message || 'TLS_THROW'));
            return;
        }
        sock.setTimeout(timeoutMs);
        sock.on('secureConnect', () => {
            let to = ''; let cn = '';
            try {
                const c = sock.getPeerCertificate();
                to = String((c && (c as any).valid_to) || '');
                cn = String((c && c.subject && (c.subject as any).CN) || '');
            } catch (_) { /* ignore */ }
            finish(true, { proto: `${sock.getProtocol() || ''}`, to, cn });
        });
        sock.on('timeout', () => finish(false, undefined, 'ETIMEDOUT'));
        sock.on('error', (e: any) => finish(false, undefined, String(e?.code || e?.message || 'TLS_ERROR')));
    });
}

async function dnsProbe(host: string, timeoutMs: number):
    Promise<{ err: string; v4: string[]; v6: string[]; servers: string; ms: number }> {
    const t0 = Date.now();
    const servers = (() => { try { return dns.getServers().join(' '); } catch (_) { return '(未知)'; } })();
    try {
        const rows = await Promise.race([
            dns.promises.lookup(host, { all: true, verbatim: true }),
            new Promise<never>((_res, rej) => setTimeout(() => rej(Object.assign(new Error('DNS_TIMEOUT'), { code: 'ETIMEDOUT' })), timeoutMs)),
        ]);
        const list = Array.isArray(rows) ? rows : [rows as any];
        return {
            err: '',
            v4: list.filter((r: any) => r.family === 4).map((r: any) => r.address),
            v6: list.filter((r: any) => r.family === 6).map((r: any) => r.address),
            servers, ms: Date.now() - t0,
        };
    } catch (e: any) {
        return { err: String(e?.code || e?.message || 'DNS_ERROR'), v4: [], v6: [], servers, ms: Date.now() - t0 };
    }
}

const countXml = (s: string): number => (String(s || '').match(/<d\s+p=/g) || []).length;

/**
 * 跑一套分层诊断。onStep 每完成一项回调一次（公网下一套可能要几十秒，必须让用户看着它长出来）。
 * 本函数不抛异常：任何一项出错都落成一条 fail/warn 记录。
 */
export async function diagnose(
    baseOverride?: string,
    cfg: DiagConfig = {},
    onStep?: (s: DiagStep) => void,
): Promise<DiagReport> {
    const conf = { ...DIAG_DEF, ...cfg };
    const timeoutMs = Math.min(60000, Math.max(1000, Number(conf.timeoutMs) || DIAG_DEF.timeoutMs));
    const repeats = Math.min(20, Math.max(1, Math.round(Number(conf.repeats) || DIAG_DEF.repeats)));
    const keyword = (String(conf.keyword || '').trim() || DIAG_DEF.keyword).slice(0, 40);
    const steps: DiagStep[] = [];
    const push = (s: DiagStep): DiagStep => {
        steps.push(s);
        try { if (onStep) onStep(s); } catch (_) { /* ignore */ }
        log.info(`[danmuApi诊断] ${s.state.toUpperCase().padEnd(4)} ${s.label} (${s.ms}ms) | ${s.detail}${s.hint ? ' | 建议: ' + s.hint : ''}`);
        // 明细走 info 而非 debug：生产默认级别是 INFO，log.debug 根本不会落进 app.log，而这条正是排查要看的。
        if (s.dbg) log.info(`[danmuApi诊断·明细] ${s.label} | ${s.dbg}`);
        return s;
    };
    const raw = String(baseOverride || fnConfig.getDanmuApiBase() || '').trim().replace(/\/+$/, '');

    // ── ① 地址形态 ──
    if (!raw) {
        push({ id: 'base', label: '地址形态', state: 'fail', ms: 0, detail: '地址为空（面板没填，也没保存过）', hint: '填入 http://IP:端口 后再诊断' });
        return { steps, summary: '地址为空，无法诊断', maskedBase: '(空)' };
    }
    let url: URL | null = null;
    try { url = new URL(raw); } catch (_) { /* 下面按非法处理 */ }
    if (!url || !/^https?:$/.test(url.protocol) || !url.hostname) {
        push({ id: 'base', label: '地址形态', state: 'fail', ms: 0, detail: `无法解析：${raw.slice(0, 40)}`, hint: '要带协议头，如 http://192.168.1.10:9321' });
        return { steps, summary: '地址格式非法', maskedBase: '(无法解析)' };
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const hc = classifyHost(url.hostname);
    const prefixLen = String(url.pathname || '').replace(/\/+$/, '').length;
    const baseOk = isValidBase(raw);
    push({
        id: 'base', label: '地址形态', state: baseOk ? 'ok' : 'fail', ms: 0,
        detail: `${maskBase(raw)} ｜ ${url.protocol.replace(':', '').toUpperCase()} 端口 ${port} ｜ 主机类型: ${hc.kind}`
          + `${prefixLen ? ' ｜ 带路径前缀(长度 ' + prefixLen + '，内容已隐藏)' : ' ｜ 无路径前缀'}`,
        hint: baseOk ? undefined
          : '当前只接受 http(s)://主机[:端口][/前缀]（主机名不含下划线、不支持 IPv6 字面量方括号写法）',
    });
    if (!baseOk) return { steps, summary: '地址格式非法，后续项未测', maskedBase: maskBase(raw) };

    // ── ② 本机路由：这个地址在我此刻的网络里到底存不存在 ──
    let routeNote = '';
    if (hc.v6) {
        push({ id: 'route', label: '本机路由', state: 'skip', ms: 0, detail: '目标是 IPv6 地址，跳过子网比对' });
    } else if (hc.kind === '域名') {
        push({ id: 'route', label: '本机路由', state: 'skip', ms: 0, detail: '目标是域名，先看下面「域名解析」拿到的 IP' });
    } else {
        const r = localRouteCovers(hc.ip);
        const lanish = hc.kind === '私网(局域网)' || hc.kind === 'CGNAT/隧道段(100.64/10)' || hc.kind === '链路本地(169.254/16)';
        if (r.covered) {
            push({ id: 'route', label: '本机路由', state: 'ok', ms: 0, detail: `目标与本机网口同网段：${r.same}` });
        } else {
            // 覆盖不到**不判失败**：实测 Tailscale/VPN 这类 /32 策略路由与目标不同网段也照样能通
            // （本机无 100.64/10 网口，100.66.1.2 却 6ms 建连成功）。可达性只由下面的 TCP 实测下结论。
            routeNote = lanish ? '；且本机没有能直达它的网口 —— 你多半已不在这个网络里（公网/换网/VPN 未连）' : '';
            push({
                id: 'route', label: '本机路由', state: 'skip', ms: 0,
                detail: `本机网口里没有与 ${hc.ip} 同网段的（现有：${r.nets.join('、') || '(无 IPv4 网口)'}）；/32 策略路由与隧道也能通，以 TCP 实测为准`,
            });
        }
    }

    // ── ③ DNS（域名才测） ──
    let addrs: string[] = [];
    if (hc.kind === '域名') {
        const d = await dnsProbe(url.hostname, Math.min(timeoutMs, 8000));
        addrs = [...d.v4, ...d.v6];
        const only6 = d.v4.length === 0 && d.v6.length > 0;
        push({
            id: 'dns', label: '域名解析', state: d.err ? 'fail' : only6 ? 'warn' : 'ok', ms: d.ms,
            detail: d.err ? `解析失败 ${d.err}（本机 DNS: ${d.servers}）`
                : `IPv4: ${d.v4.join(', ') || '无'} ｜ IPv6: ${d.v6.join(', ') || '无'} ｜ 本机 DNS: ${d.servers}`,
            dbg: `dns.promises.lookup(${url.hostname}, verbatim) → `
                + (d.err ? `err=${d.err}` : `v4=[${d.v4.join(',') || '-'}] v6=[${d.v6.join(',') || '-'}]`)
                + ` ｜ ${d.ms}ms ｜ 系统 DNS: ${d.servers}`,
            hint: d.err ? errHintOf(d.err)
                : only6 ? '只解析到 IPv6：若本机或出口链路 IPv6 不通，连接就会间歇性失败 —— 建议给域名补 A 记录，或强制走 IPv4' : undefined,
        });
        if (d.err) return { steps, summary: `DNS 未通过：${d.err}`, maskedBase: maskBase(raw) };
    } else {
        push({ id: 'dns', label: '域名解析', state: 'skip', ms: 0, detail: `目标是 ${hc.kind}，无需解析` });
        addrs = [hc.ip];
    }

    // ── ④ TCP 建连 ──
    const tcp = await tcpProbe(url.hostname, port, Math.min(timeoutMs, 6000), hc.v6 ? 6 : undefined);
    let perIp = '';
    if (!tcp.ok && addrs.length > 1) {
        // 域名解析到多个地址（DDNS 改过但旧 A 记录没删就会这样）：逐个探，才能看出是哪个地址是死的
        const parts: string[] = [];
        for (const a of addrs) {
            const one = await tcpProbe(a, port, 3000, ipFamilyOf(a) === 6 ? 6 : 4);
            parts.push(`${a} ${one.ok ? '通' : '不通(' + one.err + ')'}`);
        }
        perIp = ` ｜ 逐地址: ${parts.join('、')}`;
    }
    push({
        id: 'tcp', label: 'TCP 建连', state: tcp.ok ? 'ok' : 'fail', ms: tcp.ms,
        detail: (tcp.ok ? `可建连 → ${tcp.remote}（本机出口 ${tcp.via}）` : `失败 ${tcp.err}`) + perIp,
        hint: tcp.ok ? undefined : (errHintOf(tcp.err) || '') + (routeNote ? routeNote : ''),
        dbg: `net.connect(${url.hostname}:${port}${hc.v6 ? ' IPv6' : ''}) → ${tcp.ok ? 'connected' : 'FAILED'}`
          + ` ｜ 远端 ${tcp.remote || '-'} ｜ 本机出口 ${tcp.via || '-'} ｜ ${tcp.ms}ms`
          + `${tcp.err ? ' ｜ err=' + tcp.err : ''}${perIp}`,
    });
    if (!tcp.ok) return { steps, summary: `TCP 不通：${tcp.err}`, maskedBase: maskBase(raw) };

    // ── ⑤ TLS 握手（仅 https） ──
    if (url.protocol === 'https:') {
        const strict = await tlsProbe(url.hostname, port, Math.min(timeoutMs, 8000), true);
        if (strict.ok) {
            push({
                id: 'tls', label: 'TLS 证书', state: 'ok', ms: strict.ms,
                detail: `握手成功 ${strict.proto}｜证书 CN=${strict.cn || '(无)'} 到期 ${strict.to || '(未知)'}`,
                dbg: `严格校验 通过 ｜ ${strict.proto} ｜ CN=${strict.cn || '(无)'} ｜ 到期=${strict.to || '(未知)'} ｜ ${strict.ms}ms`,
            });
        } else {
            const loose = await tlsProbe(url.hostname, port, Math.min(timeoutMs, 8000), false);
            push({
                id: 'tls', label: 'TLS 证书', state: 'fail', ms: strict.ms,
                detail: `证书校验被拒 ${strict.err}` + (loose.ok ? `；关掉校验后握手能成功（${loose.proto || 'TLS'}，到期 ${loose.to || '未知'}）` : ''),
                hint: loose.ok
                    ? `${errHintOf(strict.err)} 服务端证书不受本机信任：本应用按标准校验证书，所以会一直连不上（浏览器可能因为你手动信任过而能打开）。要么换成 http，要么给服务配一份受信任证书。`
                    : `${errHintOf(strict.err)} 且关闭校验也握不上，多半是端口上不是 TLS 服务。`,
                dbg: `严格校验 失败 err=${strict.err}（${strict.ms}ms）`
                  + ` ｜ 免校验=${loose.ok ? '通' : '失败 err=' + (loose.err || '未知')}（${loose.ms}ms）`
                  + `${loose.ok ? ` ｜ ${loose.proto} CN=${loose.cn || '(无)'} 到期=${loose.to || '(未知)'}` : ''}`,
            });
            return { steps, summary: `TLS 未通过：${strict.err}`, maskedBase: maskBase(raw) };
        }
    } else {
        push({ id: 'tls', label: 'TLS 证书', state: 'skip', ms: 0, detail: '地址是 http，无 TLS 环节（公网传输请自行评估泄露风险）' });
    }

    // ── ⑥ 服务应答：GET 配置的根 ──
    const root = await httpGetEx(`${url.protocol}//${url.host}${String(url.pathname || '/').replace(/\/+$/, '')}/`, Math.min(timeoutMs, 8000));
    push({
        id: 'root', label: '服务应答', state: root.err && !root.status ? 'fail' : root.status ? 'ok' : 'warn', ms: root.ms,
        detail: root.err && !root.status ? `请求失败 ${root.err}`
            : `HTTP ${root.status || '(无响应)'} ${(root.bytes / 1024).toFixed(1)}KB${root.server ? ' ｜ Server: ' + root.server : ''}${root.ctype ? ' ｜ ' + root.ctype : ''}`,
        hint: root.err ? errHintOf(root.err)
            : root.status >= 400 ? `根路径返回 ${root.status}：如果配了反向代理，可能是代理没转发到容器；直连端口则多半正常（本服务根路径不一定提供页面）` : undefined,
        dbg: root.dbg,
    });

    // ── ⑦ 三跳业务链路 ──
    const searchUrl = `${raw}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`;
    const s1 = await httpGetEx(searchUrl, timeoutMs);
    let sj: any = null;
    let searchState: DiagState = 'fail';
    let sDetail = '';
    let sHint: string | undefined;
    let animeId = 0;
    if (s1.err && !s1.status) {
        sDetail = `请求失败 ${s1.err}（超时上限 ${timeoutMs}ms）`;
        sHint = errHintOf(s1.err) || (s1.err === 'ETIMEDOUT' ? `本跳耗时已超 ${timeoutMs}ms：把上面的「超时」调大再试（服务端首次搜某个词要回源多平台，实测可到 3s 以上）` : undefined);
    } else if (s1.status < 200 || s1.status >= 300) {
        sDetail = `HTTP ${s1.status}${s1.errMsg ? `（服务自报：${s1.errMsg}）` : ''}${s1.server ? '，Server: ' + s1.server : ''}`;
        sHint = s1.status === 404 ? '接口路径 404：地址里的路径前缀或反代改写规则不对（danmu_api 的接口固定在 /api/v2/…）'
            : s1.status === 401 || s1.status === 403
                ? `HTTP ${s1.status}：地址末段的访问令牌前缀被服务端拒绝。实测同一服务「去掉末段令牌、直接用 http://IP:端口」就能正常查询 —— 请先删掉末段再测；确实开了令牌校验的话则改成正确的令牌`
                : '端口上可能是别的服务（不是 danmu_api），或被反代/防火墙拦在应用之外';
    } else {
        try { sj = JSON.parse(s1.body || ''); } catch (_) { /* 非 JSON */ }
        if (!sj) {
            sDetail = `响应不是 JSON（${(s1.bytes / 1024).toFixed(1)}KB，${s1.ctype || '无 content-type'}）`;
            sHint = '多半是反代/登录页/验证码HTML，不是 danmu_api 的接口';
        } else if (sj.success === false) {
            sDetail = `服务自报失败：${String(sj.errorMessage || '未知').slice(0, 80)}`;
            sHint = '服务活着但这次查询失败，多为上游平台或数据库侧问题';
        } else {
            const n = Array.isArray(sj.animes) ? sj.animes.length : 0;
            searchState = n ? 'ok' : 'warn';
            const first = n ? sj.animes.find((a: any) => Number(a && a.animeId) > 0) : null;
            animeId = first ? Number(first.animeId) : 0;
            sDetail = `试搜「${keyword}」返回 ${n} 条` + (first ? `（首条 animeId=${animeId}，标题已省略）` : '');
            sHint = n ? undefined : '连通但 0 条：服务端没有这部片子，或它查上游时超时了。这类情况弹幕会自动降级到内置 B站 链路（不是连不上）';
        }
    }
    push({ id: 'search', label: '搜索接口 /api/v2/search/anime', state: searchState, ms: s1.ms, detail: sDetail, hint: sHint, dbg: s1.dbg });

    let episodeId = 0;
    if (conf.deep) {
        if (!animeId) {
            push({ id: 'bangumi', label: '分集接口 /api/v2/bangumi', state: 'skip', ms: 0, detail: '上一跳没拿到 animeId' });
            push({ id: 'comment', label: '弹幕接口 /api/v2/comment', state: 'skip', ms: 0, detail: '上一跳没拿到 episodeId' });
        } else {
            const b = await httpGetEx(`${raw}/api/v2/bangumi/${animeId}`, Math.min(Math.max(timeoutMs, 12000), 30000));
            const bj = b.body ? (() => { try { return JSON.parse(b.body); } catch (_) { return null; } })() : null;
            const eps = bj && bj.bangumi && Array.isArray(bj.bangumi.episodes) ? bj.bangumi.episodes : [];
            episodeId = eps.length ? Number(eps[0].episodeId) || 0 : 0;
            push({
                id: 'bangumi', label: '分集接口 /api/v2/bangumi',
                state: eps.length ? 'ok' : 'fail', ms: b.ms,
                detail: b.err && !b.status ? `请求失败 ${b.err}`
                    : eps.length ? `条目存在，分集 ${eps.length} 个（首集 episodeId=${episodeId}）`
                        : `条目里 0 个分集（HTTP ${b.status || '-'}）`,
                hint: eps.length ? undefined : '搜索有结果但条目拿不到分集：服务端该条数据不完整，实际播放时会降级内置 B站',
                dbg: b.dbg,
            });
            if (!episodeId) {
                push({ id: 'comment', label: '弹幕接口 /api/v2/comment', state: 'skip', ms: 0, detail: '上一跳没拿到 episodeId' });
            } else {
                const c = await httpGetEx(`${raw}/api/v2/comment/${episodeId}?format=xml`, Math.min(Math.max(timeoutMs, 30000), 45000));
                const n = countXml(c.body || '');
                push({
                    id: 'comment', label: '弹幕接口 /api/v2/comment', state: n ? 'ok' : 'warn', ms: c.ms,
                    detail: c.err && !c.status ? `请求失败 ${c.err}` : `XML ${(c.bytes / 1024).toFixed(1)}KB，解析出 ${n} 条弹幕`,
                    hint: n ? undefined : '接口通但这一集没有弹幕（或返回 0 条）：属服务端数据问题，播放时会降级内置 B站',
                    dbg: c.dbg + ` ｜ 响应预览: ${JSON.stringify(String(c.body || '').slice(0, 60))}`,
                });
            }
        }
    } else {
        push({ id: 'bangumi', label: '分集接口 /api/v2/bangumi', state: 'skip', ms: 0, detail: '未勾选端到端三跳' });
        push({ id: 'comment', label: '弹幕接口 /api/v2/comment', state: 'skip', ms: 0, detail: '未勾选端到端三跳' });
    }

    // ── ⑧ 重复探测：把「有时连得上有时连不上」量出来 ──
    const runs: { ok: boolean; ms: number }[] = [];
    for (let i = 0; i < repeats; i++) {
        const p = await httpGetEx(searchUrl, timeoutMs);
        const ok = !!p.status && p.status >= 200 && p.status < 300 && !p.err;
        runs.push({ ok, ms: p.ms });
        push({
            id: `repeat${i + 1}`, label: `重复探测 ${i + 1}/${repeats}`, state: ok ? 'ok' : 'fail', ms: p.ms,
            detail: ok ? `HTTP ${p.status} ${(p.bytes / 1024).toFixed(1)}KB` : (p.err || `HTTP ${p.status}`),
            dbg: p.dbg,
        });
    }
    const okRuns = runs.filter((r) => r.ok);
    const sorted = okRuns.map((r) => r.ms).sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const slowest = sorted.length ? sorted[sorted.length - 1] : 0;
    const flaky = runs.length - okRuns.length;
    push({
        id: 'jitter', label: '耗时与稳定性', state: flaky ? 'fail' : slowest > timeoutMs * 0.6 ? 'warn' : 'ok', ms: med,
        detail: `${okRuns.length}/${runs.length} 次成功 ｜ 最快 ${sorted[0] || 0}ms ｜ 中位 ${med}ms ｜ 最慢 ${slowest}ms ｜ 当前超时 ${timeoutMs}ms`,
        dbg: `逐次 ${runs.map((r) => `${r.ms}ms${r.ok ? '' : '(失败)'}`).join(' ')} ｜ 成功 ${okRuns.length}/${runs.length} ｜ 极差 ${slowest - (sorted[0] || 0)}ms`,
        hint: flaky
            ? `同一地址同一接口 ${flaky} 次失败 —— 「时好时坏」被复现。服务端首次搜某个词要回源多个平台（实测可达 3s 以上），之后命中缓存只要十几毫秒；如果失败的全是超时，把超时调大即可`
            : slowest > timeoutMs * 0.6 ? `最慢一次已到 ${slowest}ms，超过当前超时上限的六成 —— 公网/高延迟网络下建议把超时调到 ${Math.max(timeoutMs, Math.round(slowest * 2.5 / 500) * 500)}ms 以上，否则会随机判为连不上` : undefined,
    });

    // ── ⑨ 代理旁路：本应用的弹幕请求只走直连，这条用来验「换代理是不是就通」 ──
    if (conf.tryProxy) {
        let agent: any = null;
        try { agent = resolveProxyAgent(); } catch (_) { agent = null; }
        if (!agent) {
            push({ id: 'proxy', label: '代理旁路', state: 'skip', ms: 0, detail: '未启用代理（环境变量 HTTPS_PROXY 与设置面板「自定义代理」都为空）' });
        } else {
            const p = await httpGetEx(searchUrl, timeoutMs, agent);
            const ok = !!p.status && p.status >= 200 && p.status < 300 && !p.err;
            push({
                id: 'proxy', label: '代理旁路', state: ok ? 'ok' : 'fail', ms: p.ms,
                detail: ok ? `走代理 HTTP ${p.status} ${(p.bytes / 1024).toFixed(1)}KB` : `走代理仍失败：${p.err || 'HTTP ' + p.status}`,
                dbg: p.dbg,
                hint: '注意：弹幕请求本身不经过这个代理（本模块只直连）。这里只是验证「挂上代理能不能通」——如果走代理通、直连不通，说明问题在你到 NAS 的那条网络路径上。',
            });
        }
    } else {
        push({ id: 'proxy', label: '代理旁路', state: 'skip', ms: 0, detail: '未勾选代理旁路' });
    }

    // ── 结论 ──
    const firstFail = steps.find((s) => s.state === 'fail');
    const warns = steps.filter((s) => s.state === 'warn');
    const summary = firstFail
        ? `卡在「${firstFail.label}」：${firstFail.detail}`
        : warns.length ? `链路可用，${warns.length} 项需注意：${warns.map((w) => w.label).join('、')}` : '全链路正常';
    return { steps, summary, maskedBase: maskBase(raw) };
}

/** 从 Lua 回流的可疑伪 bvid 里取出自建源 episodeId；不是自建源 id 返回 null。 */
export function parsePrefixedId(bvid: string): string | null {
    const s = String(bvid || '');
    return s.startsWith(ID_PREFIX) ? s.slice(ID_PREFIX.length) : null;
}
