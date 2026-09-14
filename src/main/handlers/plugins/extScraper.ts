// main/handlers/plugins/extScraper.ts — [自定义刮削] 扩展刮削服务（fpk 交接报告 §3/§5/§6.1 方案 A）
// ─────────────────────────────────────────────────────────────────────────────
// 两个职责（与 Web 版语义逐项对照，jav.go 为蓝本的 Node 转译）：
// ① `jav:lookup` / `jav:image`：Jav 番号刮削后端（jav.go 方案 A 转译）。
//    数据源 javbus 网页端（无官方 API）：详情页直取 /{番号} → 404/非详情时搜索页
//    /search/{番号}&type=1 兜底取首个 movie-box。宽容正则解析 标题/封面/发行日期/类别/演员，
//    字段间独立容错；番号字母段过技术词黑名单（HDR10/CD1/PART2 等不算番号）。
//    进程内缓存 24h；封面代理下载有域名门禁（仅设置的 javBusDomain 含子域，16MB 上限）。
//    网络语义 = extHTTP：自定义代理 > 系统直连（javbus 国内直连不通）——复用共享
//    proxyModule.resolveProxyAgent()（与 bangumiSync/tmdbSync 同一传输层）。
//    安全开关：javEnabled 默认关（双层门禁的前层；后层是渲染端按钮不挂载）。
// ② `custom-scraper:fetch`：自定义刮削服务请求由主进程代理转发（fpk §6.2 方案 2——
//    桌面版不必要求用户服务配 CORS）。协议不变：POST JSON 透传，响应 JSON 原样回传。
// ③ 扩展数据源三桥（fpk fanart.go/tvmaze.go/omdb.go 的 Node 转译，v1.10.0 七卡齐）：
//    `fanart:logos`（Fanart.tv v3 官方 API：电影按 TMDB/IMDb id、剧经 TMDB external_ids
//    换算 TVDB id；HD 键排前 likes 降序；进程内 6h 缓存）；
//    `tvmaze:show`（官方免 Key API：imdb/tvdb lookup → 标题搜索兜底（剥季号后缀）→
//    整季分集，summary 剥 HTML；24h 缓存）——「补全集信息」英文兜底；
//    `omdb:rating`（IMDb 授权渠道评分/票数，7 天缓存省免费额度）。
// 注册通道（与 Web 版渲染端调用名逐字一致）：
//   jav:lookup / jav:image / custom-scraper:fetch / fanart:logos / tvmaze:show / omdb:rating
// 测试用例对照 fpk jav_test.go 五个 Test 移植（番号提取/HTML 解析/相对路径补全/门禁流程）。
// ─────────────────────────────────────────────────────────────────────────────
import { app } from 'electron';
import * as https from 'https';
import axios from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import * as proxyModule from '../../../modules/proxyAgent';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';

const log = logger;
/** 与 Web 版 skipUA 逐字一致：javbus 对非浏览器 UA 宽容，保持两端行为一致。 */
const JAV_UA = 'fntv-plus/web (https://github.com/YDMY007/Fntv-Plus)';
const JAV_TIMEOUT_MS = 12000;           // Go skipHTTPTimeout 同款
const JAV_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const JAV_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const JAV_DEFAULT_DOMAIN = 'https://www.javbus.com';

/** 传输层（extHTTP 语义）：自定义代理 > 系统直连。代理含环境变量（resolveProxyAgent 内处理）。 */
function javTransport(cfg: Record<string, unknown>): Record<string, unknown> {
    const proxy = proxyModule.resolveProxyAgent();
    if (proxy) {
        cfg.httpsAgent = proxy;
        cfg.proxy = false;
    }
    return cfg;
}

/** 设置里的 javbus 域名归一：剥 scheme/尾斜杠 → 纯 host（图片门禁用）。 */
function javDomain(): string {
    let d = String(fnConfig.getJavBusDomain() || '').trim().toLowerCase();
    if (!d) d = JAV_DEFAULT_DOMAIN;
    if (/^https?:\/\//.test(d)) {
        try { return new URL(d).hostname.toLowerCase(); } catch (e) { /* fallthrough */ }
    }
    return d.replace(/\/+$/, '');
}

/** 抓取基地址：带 scheme 用原值，纯域名补 https://。 */
function javBase(): string {
    let raw = String(fnConfig.getJavBusDomain() || '').trim();
    if (!raw) raw = JAV_DEFAULT_DOMAIN;
    raw = raw.replace(/\/+$/, '');
    return (/^https?:\/\//.test(raw)) ? raw : 'https://' + raw;
}

/* ── 番号提取（jav.go javExtractCode 逐项转译） ── */

/** 字母段黑名单：视频技术词/分段词（HDR10、H265、CD1、PART2 这类不算番号）。 */
const JAV_TECH_WORDS = new Set([
    'HDR', 'DV', 'DD', 'DDP', 'DTS', 'HD', 'UHD',
    'CD', 'BD', 'DVD', 'TV', 'VC', 'VP', 'AV',
    'SD', 'SE', 'EP', 'VOL', 'PART', 'PT',
    'NTSC', 'PAL', 'REMUX', 'WEB', 'MKV', 'MP4',
    'AVC', 'ATMOS', 'HLG', 'SDR', 'VVC', 'ISO',
    'DC', 'IMAX', 'DOLBY', 'VISION', 'COMPLETE',
    'EXTENDED', 'REMASTER', 'REMASTERED', 'UNRATED', 'PROPER',
]);

const RE_JAV_FC2 = /\b(FC2(?:-PPV)?)-?\s?(\d{6,10})\b/i;
const RE_JAV_STD = /\b([A-Za-z]{2,6})-?\s?(\d{2,5})\b/g;

/** 从标题/文件名提取番号，归一为「ABCD-123」/「FC2-PPV-1234567」；识别不到返回 ''。 */
export function javExtractCode(title: string): string {
    const s = String(title || '').trim();
    const fc2 = s.match(RE_JAV_FC2);
    if (fc2) {
        const prefix = fc2[1].toUpperCase().includes('PPV') ? 'FC2-PPV' : 'FC2';
        return prefix + '-' + fc2[2];
    }
    RE_JAV_STD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_JAV_STD.exec(s)) !== null) {
        const letters = m[1].toUpperCase();
        if (JAV_TECH_WORDS.has(letters)) continue;
        return letters + '-' + m[2];
    }
    return '';
}

/* ── 抓取与解析（jav.go 正则逐条转译；Go (?s) → JS [\s\S]） ── */

const RE_JAV_TITLE = /<h3[^>]*>([\s\S]*?)<\/h3>/;
const RE_JAV_BIG_IMG = /class="[^"]*bigImage[^"]*"[^>]*href="([^"]+)"/;
const RE_JAV_COVER = /<img[^>]*class="[^"]*\bcover\b[^"]*"[^>]*src="([^"]+)"/;
const RE_JAV_DATE = /(?:发行时间|發行日期|発売日)\s*[:：]?<\/span>\s*(?:<span[^>]*>)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/;
const RE_JAV_DATE_ANY = /([0-9]{4}-[0-9]{2}-[0-9]{2})/;
const RE_JAV_GENRE = /<a[^>]*href="[^"]*\/genre\/[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/g;
const RE_JAV_STAR_IMG = /<img[^>]*src="([^"]+)"/;
const RE_JAV_STAR_NM = /<span[^>]*>([^<]+)<\/span>/;
const RE_JAV_TAG = /<[^>]+>/g;
const RE_JAV_BOX = /class="movie-box"[^>]*href="([^"]+)"/;

interface JavActress { name: string; photo: string; }
interface JavMeta {
    code: string; title: string; cover: string; date: string;
    genres: string[]; actresses: JavActress[]; url: string;
}

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** 去内联标签 + 反转义（标题 h3 内可能有 <span> 等包裹）。 */
function javStripTags(s: string): string {
    return s.replace(RE_JAV_TAG, ' ').replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (all, body: string) => {
        const named = ENTITIES[String(body).toLowerCase()];
        if (named !== undefined) return named;
        if (/^#x[0-9a-f]+$/i.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
        if (/^#\d+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 10));
        return all;
    }).trim();
}

/** 详情页 HTML → javMeta（各字段独立容错，失败留空）。 */
export function javParseDetail(pageURL: string, htmlText: string, fallbackCode: string): JavMeta {
    const meta: JavMeta = { code: fallbackCode, title: '', cover: '', date: '', genres: [], actresses: [], url: pageURL };
    const t = htmlText.match(RE_JAV_TITLE);
    if (t) meta.title = javStripTags(t[1]);
    const big = htmlText.match(RE_JAV_BIG_IMG);
    if (big) meta.cover = big[1].trim();
    else {
        const cov = htmlText.match(RE_JAV_COVER);
        if (cov) meta.cover = cov[1].trim();
    }
    const date = htmlText.match(RE_JAV_DATE) || htmlText.match(RE_JAV_DATE_ANY);
    if (date) meta.date = date[1];
    const seen = new Set<string>();
    RE_JAV_GENRE.lastIndex = 0;
    let gm: RegExpExecArray | null;
    while ((gm = RE_JAV_GENRE.exec(htmlText)) !== null) {
        const name = javStripTags(gm[1]);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        meta.genres.push(name);
    }
    // 演员：avatar-box 块内 <img src> + <span>名字</span>
    for (const chunk of htmlText.split('avatar-box').slice(1)) {
        const nm = chunk.match(RE_JAV_STAR_NM);
        const name = nm ? javStripTags(nm[1]) : '';
        if (!name) continue;
        const am = chunk.match(RE_JAV_STAR_IMG);
        meta.actresses.push({ name, photo: am ? am[1].trim() : '' });
    }
    return meta;
}

/** 相对路径 → 绝对地址（scheme/host 取自所在页面 URL）。 */
export function javAbsURL(raw: string, pageURL: string): string {
    let s = String(raw || '').trim();
    if (!s || /^https?:\/\//.test(s)) return s;
    if (!s.startsWith('/')) s = '/' + s;
    try {
        const u = new URL(pageURL);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host) return u.protocol + '//' + u.host + s;
    } catch (e) { /* fallthrough */ }
    return 'https://' + s;
}

/** 抓单页并解析（标题为空视为非详情页，返回 404 语义错误）。 */
async function javGet(pageURL: string, domain: string, code: string): Promise<JavMeta> {
    const resp = await axios.get(pageURL, javTransport({
        timeout: JAV_TIMEOUT_MS,
        maxContentLength: JAV_PAGE_MAX_BYTES,
        responseType: 'text',
        headers: {
            'User-Agent': JAV_UA,
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Referer: 'https://' + domain + '/',
        },
    }));
    if (resp.status !== 200) throw new Error('javbus HTTP ' + resp.status);
    const meta = javParseDetail(pageURL, String(resp.data), code);
    meta.code = code;
    meta.cover = javAbsURL(meta.cover, pageURL);
    if (!meta.title) throw new Error('javbus HTTP 404');
    return meta;
}

async function javGetPage(pageURL: string, domain: string): Promise<string> {
    const resp = await axios.get(pageURL, javTransport({
        timeout: JAV_TIMEOUT_MS,
        maxContentLength: JAV_PAGE_MAX_BYTES,
        responseType: 'text',
        headers: {
            'User-Agent': JAV_UA,
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Referer: 'https://' + domain + '/',
        },
    }));
    if (resp.status !== 200) throw new Error('javbus HTTP ' + resp.status);
    return String(resp.data);
}

/** 番号 → javMeta：详情页直取 → 404/非详情 → 搜索页兜底（首个 movie-box 结果）。 */
async function javFetchDetail(code: string): Promise<JavMeta> {
    const domain = javDomain();
    const base = javBase();
    let detail: JavMeta | null = null;
    try {
        detail = await javGet(base + '/' + encodeURIComponent(code), domain, code);
    } catch (e) { /* 404/网络异常 → 搜索兜底 */ }
    if (detail && detail.title) return detail;
    const searchHtml = await javGetPage(base + '/search/' + encodeURIComponent(code) + '&type=1', domain);
    const m = searchHtml.match(RE_JAV_BOX);
    if (!m) throw new Error('javbus HTTP 404');
    return javGet(m[1], domain, code);
}

/* ── 缓存（进程内 24h，Go javCache 同款） ── */

const javCache = new Map<string, { meta: JavMeta; exp: number }>();

/* ── Handlers ── */

function appVersion(): string {
    try { return app.getVersion(); } catch (e) { return 'unknown'; }
}

/* ── 扩展数据源三桥（fanart/tvmaze/omdb，fpk 同名 .go 的 Node 转译） ── */

const EXT_TIMEOUT_MS = 15000;
const EXT_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const UA_EXT = JAV_UA;

/** TVMaze 标题季号后缀（剥掉再搜索/做缓存键，Go reTVSeasonSuffix 同款）。 */
const RE_TV_SEASON_SUFFIX = /\s*(第\s*[0-9一二三四五六七八九十百]+\s*季|season\s*\d{1,3}|s\s*\d{1,3})\s*$/i;

// Fanart.tv：key → {logos, exp}（内容更新慢，6h 足够新鲜且省额度）
const fanartCache = new Map<string, { logos: { url: string; lang: string; likes: number; hd: boolean }[]; exp: number }>();
// TVMaze：key → {showId, showName, episodes, exp}（24h）
const tvmazeCache = new Map<string, { showId: number; showName: string; episodes: any[]; exp: number }>();
// OMDb：imdbId → {rating, votes, exp}（评分变化慢，7 天）
const omdbCache = new Map<string, { rating: number; votes: number; exp: number }>();

function stripHtmlTag(s: string): string {
    if (!s) return '';
    return s.replace(/<[^>]+>/g, ' ')
        .replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (all, body: string) => {
            const named = ENTITIES[String(body).toLowerCase()];
            if (named !== undefined) return named;
            if (/^#x[0-9a-f]+$/i.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
            if (/^#\d+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 10));
            return all;
        })
        .split(/\s+/).filter(Boolean).join(' ');
}

/** TMDB external_ids 换算 tvdb_id（剧经 TMDB；需用户已配 TMDB Key）。失败返回 ''。 */
async function fanartResolveTvdb(tmdbId: number): Promise<string> {
    const apiKey = fnConfig.getTmdbApiKey();
    if (tmdbId <= 0 || !apiKey) return '';
    try {
        const resp = await axios.get('https://api.themoviedb.org/3/tv/' + tmdbId + '/external_ids', {
            timeout: EXT_TIMEOUT_MS,
            params: { api_key: apiKey },
            headers: { Accept: 'application/json', 'User-Agent': UA_EXT },
        });
        const tvdb = resp.data && resp.data.tvdb_id;
        if (typeof tvdb === 'number' && tvdb > 0) return String(tvdb);
        if (typeof tvdb === 'string' && tvdb.trim()) return tvdb.trim();
    } catch (e) { /* 换算失败返回空，调用方报缺主键 */ }
    return '';
}

/** HD 键排前、likes 降序（Go fanartParseLogos 同款稳定序）。 */
function fanartParseLogos(resp: any, keys: string[]): { url: string; lang: string; likes: number; hd: boolean }[] {
    const out: { url: string; lang: string; likes: number; hd: boolean }[] = [];
    for (const k of keys) {
        const arr = resp && Array.isArray(resp[k]) ? resp[k] : [];
        for (const raw of arr) {
            if (!raw || typeof raw !== 'object') continue;
            const u = String(raw.url || '').trim();
            if (!u) continue;
            out.push({ url: u, lang: String(raw.lang || ''), likes: Number(raw.likes) || 0, hd: k.startsWith('hd') });
        }
    }
    out.sort((a, b) => (a.hd === b.hd) ? (b.likes - a.likes) : (a.hd ? -1 : 1));
    return out;
}

async function extGetJson(url: string, maxBytes = EXT_PAGE_MAX_BYTES): Promise<any> {
    const resp = await axios.get(url, javTransport({
        timeout: EXT_TIMEOUT_MS,
        maxContentLength: maxBytes,
        headers: { Accept: 'application/json', 'User-Agent': UA_EXT },
    }));
    if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
    return resp.data;
}

/** 插件入口（handlers/index.ts 约定：自动 require 各插件并调用 init()）。 */
export function init(): void {
    // jav:lookup {code?, title?, guid?} → {ok, meta, fromCache?} | {ok:false, error}
    registerHandler('jav:lookup', async (_e: any, req: { code?: string; title?: string; guid?: string }) => {
        if (!fnConfig.getJavEnabled()) {
            // [fpk §6.3 #4] 文案路径按桌面版面板归属：设置→自定义刮削→Jav 刮削
            return { ok: false, error: 'Jav 刮削未开启（设置→自定义刮削→Jav 刮削）' };
        }
        let code = javExtractCode(String((req && req.code) || ''));
        if (!code) code = javExtractCode(String((req && req.title) || ''));
        if (!code) return { ok: false, error: '未识别到番号（标题需含如 ABC-123 / FC2-PPV-1234567）' };
        const hit = javCache.get(code);
        if (hit && hit.exp > Date.now()) return { ok: true, meta: hit.meta, fromCache: true };
        try {
            const meta = await javFetchDetail(code);
            if (!meta.title) throw new Error('javbus HTTP 404');
            javCache.set(code, { meta, exp: Date.now() + 24 * 3600 * 1000 });
            log.info('[jav] 命中 ' + code + ' v' + appVersion());
            return { ok: true, meta };
        } catch (e: any) {
            const msg = String((e && e.message) || e);
            return { ok: false, error: 'javbus 查询失败：' + msg + '（检查网络/代理，或设置里更换 javbus 域名）' };
        }
    }, { useHandle: true });

    // jav:image {url} → {ok, dataUrl} | {ok:false, error}（域名白名单 = 设置的 javBusDomain 含子域）
    registerHandler('jav:image', async (_e: any, req: { url?: string }) => {
        const raw = String((req && req.url) || '');
        let host = '';
        try { host = new URL(raw).hostname.toLowerCase(); } catch (err) { host = ''; }
        if (!host) return { ok: false, error: '缺少图片地址' };
        const domain = javDomain();
        if (host !== domain && !host.endsWith('.' + domain)) {
            return { ok: false, error: '仅支持 javbus 域名图片: ' + domain };
        }
        try {
            const resp = await axios.get(raw, javTransport({
                timeout: JAV_TIMEOUT_MS,
                maxContentLength: JAV_IMAGE_MAX_BYTES,
                responseType: 'arraybuffer',
                headers: { 'User-Agent': JAV_UA, Referer: 'https://' + domain + '/' },
            }));
            if (resp.status !== 200) return { ok: false, error: String(resp.status) };
            const ct = String(resp.headers['content-type'] || 'image/jpeg');
            const dataUrl = 'data:' + ct + ';base64,' + Buffer.from(resp.data).toString('base64');
            return { ok: true, dataUrl };
        } catch (e: any) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }, { useHandle: true });

    // custom-scraper:fetch {url, payload} → {ok, data} | {ok:false, error}
    // [fpk §6.2 方案 2] 自定义刮削服务请求由主进程代理转发，用户服务无需配 CORS。
    registerHandler('custom-scraper:fetch', async (_e: any, req: { url?: string; payload?: any }) => {
        const url = String((req && req.url) || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: '地址必须以 http(s):// 开头' };
        try {
            const resp = await axios.post(url, (req && req.payload) || {}, javTransport({
                timeout: JAV_TIMEOUT_MS,
                maxContentLength: 32 * 1024 * 1024,
                headers: { 'Content-Type': 'application/json' },
            }));
            return { ok: true, data: resp.data };
        } catch (e: any) {
            const msg = axios.isAxiosError(e) && e.response
                ? ('HTTP ' + e.response.status)
                : String((e && e.message) || e);
            return { ok: false, error: '自定义刮削服务请求失败: ' + msg.substring(0, 100) };
        }
    }, { useHandle: true });

    // fanart:logos {mediaType, tmdbId, imdbId, tvdbId} → {ok, logos:[{url,lang,likes,hd}], resolvedTvdb}
    // 未开启/未配 key 返回 ok:false + 原因（前端静默跳过，不弹错）。
    registerHandler('fanart:logos', async (_e: any, req: { mediaType?: string; tmdbId?: number | string; imdbId?: string; tvdbId?: string }) => {
        if (!fnConfig.getFanartEnabled()) return { ok: false, error: 'Fanart.tv 未开启' };
        const apiKey = String(fnConfig.getFanartApiKey() || '').trim();
        if (!apiKey) return { ok: false, error: '未配置 Fanart.tv api_key（fanart.tv 注册免费领取）' };
        let mt = String((req && req.mediaType) || '').toLowerCase();
        if (mt !== 'movie' && mt !== 'tv') mt = 'tv';
        // 定位 fanart 主键：电影 tmdb/imdb 直查；剧必须 tvdb（缺则经 TMDB 换算）
        let fanartID = '';
        let section = '';
        if (mt === 'movie') {
            const tmdbNum = Number(req && req.tmdbId);
            if (Number.isFinite(tmdbNum) && tmdbNum > 0) fanartID = String(Math.floor(tmdbNum));
            else if (String((req && req.imdbId) || '').trim()) fanartID = String(req!.imdbId).trim();
            section = 'movies';
        } else {
            if (String((req && req.tvdbId) || '').trim()) fanartID = String(req!.tvdbId).trim();
            else {
                const tmdbNum = Number(req && req.tmdbId);
                if (Number.isFinite(tmdbNum) && tmdbNum > 0) fanartID = await fanartResolveTvdb(Math.floor(tmdbNum));
            }
            section = 'tv';
        }
        if (!fanartID) return { ok: false, error: '缺少可用的 Fanart.tv 主键（剧集需 TVDB id，或已配置 TMDB Key 供换算）' };
        const cacheKey = section + '|' + fanartID;
        const hit = fanartCache.get(cacheKey);
        if (hit && hit.exp > Date.now()) {
            return { ok: hit.logos.length > 0, logos: hit.logos, resolvedTvdb: fanartID, fromCache: true };
        }
        const q = new URLSearchParams({ api_key: apiKey });
        const clientKey = String(fnConfig.getFanartClientKey() || '').trim();
        if (clientKey) q.set('client_key', clientKey);
        try {
            const out = await extGetJson('https://webservice.fanart.tv/v3/' + section + '/' + encodeURIComponent(fanartID) + '?' + q.toString());
            // 官方错误形态：{"status":"error","error message":"..."} / 401 {"error":"..."}
            if (out && out.status === 'error') {
                const msg = String(out['error message'] || out.error || '未知错误');
                return { ok: false, error: 'Fanart.tv: ' + msg };
            }
            const keys = (mt === 'movie') ? ['hdmovielogo', 'movielogo'] : ['hdtvlogo', 'clearlogo'];
            const logos = fanartParseLogos(out, keys);
            fanartCache.set(cacheKey, { logos, exp: Date.now() + 6 * 3600 * 1000 });
            return { ok: logos.length > 0, logos, resolvedTvdb: fanartID };
        } catch (e: any) {
            const msg = axios.isAxiosError(e) && e.response ? 'HTTP ' + e.response.status : String((e && e.message) || e);
            return { ok: false, error: 'Fanart.tv: ' + msg };
        }
    }, { useHandle: true });

    // tvmaze:show {imdbId, tvdbId, title, season} → {ok, show:{id,name}, episodes:[{season,number,name,airdate,runtime,summary}]}
    // imdb/tvdb lookup → 标题搜索兜底（剥季号后缀）；整季分集，summary 已剥 HTML；24h 缓存。
    registerHandler('tvmaze:show', async (_e: any, req: { imdbId?: string; tvdbId?: string; title?: string; season?: number }) => {
        if (!fnConfig.getTvmazeEnabled()) return { ok: false, error: 'TVMaze 未开启' };
        const imdbId = String((req && req.imdbId) || '').trim();
        const tvdbId = String((req && req.tvdbId) || '').trim();
        const titleRaw = String((req && req.title) || '').trim();
        const titleKey = titleRaw.replace(RE_TV_SEASON_SUFFIX, '').trim();
        const cacheKey = titleKey.toLowerCase() + '|' + imdbId + '|' + tvdbId;
        const hit = tvmazeCache.get(cacheKey);
        if (hit && hit.exp > Date.now()) {
            return { ok: true, fetchedAt: Date.now(), show: { id: hit.showId, name: hit.showName }, episodes: hit.episodes };
        }
        try {
            // 三路定位 show
            let show: any = null;
            const lookup = async (qs: string): Promise<any> => {
                try {
                    const sh = await extGetJson('https://api.tvmaze.com/lookup/shows?' + qs);
                    return (sh && sh.id > 0) ? sh : null;
                } catch (e) { return null; }
            };
            if (imdbId) show = await lookup('imdb=' + encodeURIComponent(imdbId));
            if (!show && tvdbId) show = await lookup('thetvdb=' + encodeURIComponent(tvdbId));
            if (!show) {
                if (!titleKey) return { ok: false, error: '缺少 imdb/tvdb/标题' };
                const hits = await extGetJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(titleKey));
                const first = Array.isArray(hits) && hits.length && hits[0] && hits[0].show && hits[0].show.id > 0 ? hits[0].show : null;
                if (!first) return { ok: false, error: 'TVMaze 搜索无结果: ' + titleKey };
                show = first;
            }
            const rawEps = await extGetJson('https://api.tvmaze.com/shows/' + show.id + '/episodes?specials=1');
            const episodes = (Array.isArray(rawEps) ? rawEps : []).map((e: any) => ({
                season: Number(e.season) || 0,
                number: Number(e.number) || 0,
                name: String(e.name || ''),
                airdate: String(e.airdate || ''),
                runtime: Number(e.runtime) || 0,
                summary: stripHtmlTag(String(e.summary || '')),
            }));
            tvmazeCache.set(cacheKey, { showId: show.id, showName: String(show.name || ''), episodes, exp: Date.now() + 24 * 3600 * 1000 });
            return { ok: true, fetchedAt: Date.now(), show: { id: show.id, name: show.name }, episodes };
        } catch (e: any) {
            const msg = axios.isAxiosError(e) && e.response ? 'TVMaze HTTP ' + e.response.status : String((e && e.message) || e);
            return { ok: false, error: msg };
        }
    }, { useHandle: true });

    // omdb:rating {imdbId} → {ok, imdbRating, imdbVotes}（评分/票数 7 天缓存省免费额度）
    registerHandler('omdb:rating', async (_e: any, req: { imdbId?: string }) => {
        if (!fnConfig.getOmdbEnabled()) return { ok: false, error: 'OMDb 未开启' };
        const key = String(fnConfig.getOmdbApiKey() || '').trim();
        if (!key) return { ok: false, error: '未配置 OMDb API Key（omdbapi.com/apikey.aspx 免费领取）' };
        const imdbId = String((req && req.imdbId) || '').trim();
        const idKey = imdbId.toLowerCase();
        const hit = omdbCache.get(idKey);
        if (hit && hit.exp > Date.now()) return { ok: true, imdbRating: hit.rating, imdbVotes: hit.votes };
        try {
            const out = await extGetJson('https://www.omdbapi.com/?' + new URLSearchParams({ apikey: key, i: imdbId }).toString(), 1024 * 1024);
            if (!out || out.Response !== 'True') return { ok: false, error: '查询失败或无评分（检查 key/额度/IMDb id）' };
            const rating = parseFloat(String(out.imdbRating || '').trim());
            const votes = parseInt(String(out.imdbVotes || '').replace(/,/g, '').trim(), 10) || 0;
            if (!(rating > 0)) return { ok: false, error: '查询失败或无评分（检查 key/额度/IMDb id）' };
            omdbCache.set(idKey, { rating, votes, exp: Date.now() + 7 * 24 * 3600 * 1000 });
            return { ok: true, imdbRating: rating, imdbVotes: votes };
        } catch (e: any) {
            const msg = axios.isAxiosError(e) && e.response ? 'HTTP ' + e.response.status : String((e && e.message) || e);
            return { ok: false, error: msg };
        }
    }, { useHandle: true });
}
