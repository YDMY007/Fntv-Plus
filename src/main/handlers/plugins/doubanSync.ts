import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { registerHandler } from '../core/ipcHandler';
import { getInstance as getInterceptor } from '../core/interceptor';
import { getMainWindow } from '../../common/mainwin';
import * as fnConfig from '../../../modules/fn_config/config';
import * as fn from '../../../modules/fn_api/api';
import * as logger from '../../../modules/logger';
import * as types from '../../../modules/fn_api/types';
import { tmdbGenresFor } from './tmdbSync';
import { getDailyCached, DEFAULT_TTL_MS } from '../../common/dailyCache';
const log = logger.component('douban');

/**
 * 豆瓣同步插件（影视进度 → 豆瓣"在看/看过"）
 *
 * 方案：
 * - 认证：设置面板"扫码登录"→ 主进程开 BrowserWindow 内嵌豆瓣登录页，
 *        用户用豆瓣 App 扫码；检测到 dbcl2 cookie 出现即提取全部 cookie 加密存盘。
 *        另提供"手动粘贴 Cookie"作为兜底（豆瓣对 Electron 登录页偶尔有风控）。
 * - 同步（直接读取飞牛影视记录，按剧集匹配豆瓣）：
 *    1) 只要收到有效的进度事件（媒体有真实时长，即用户已开始播放）→ 标记"在看"(interest=do)。
 *       注：percentage=floor(ts/duration*100) 开播前几秒恒为 0，故以"媒体有效"判定，确保刚开播就能标上。
 *    2) 飞牛本身的"标记为已观看"按钮 → 命中 /v/api/v1/item/watched 请求，
 *       被本插件的 session 拦截器捕获 → 标记"看过"(interest=collect)。
 * - 限流优化：douban_id 解析结果按"剧名|类型|年代"缓存（seriesCache），同一部剧跨集、跨会话
 *   只搜索一次豆瓣；缓存持久化到 userData/douban_id_cache.json，重启不丢失。
 * - 防降级：若飞牛侧该条目已 is_watched=1（历史看过/重看），进度同步直接标"看过"，
 *   不回退成"在看"，避免把豆瓣的"看过"覆盖成"在看"。
 * - 写入接口：POST movie.douban.com/j/subject/{id}/interest （非公开 API，失败静默）。
 *   该接口需要 ck(CSRF) 令牌：登录态 cookie 含 ck 时直接用；扫码登录走 passport 流程时
 *   cookie 往往不含 ck，故登录后先访问 movie.douban.com 让服务端下发，运行时再兜底从
 *   条目页 Set-Cookie/HTML 解析，三者缺一都会导致 POST 被拒（HTTP 200 但 status≠success）。
 *
 * 该文件会被 handlers/index.ts 自动加载（同目录 *.js 即视为插件，需导出 init）。
 */

type Interest = 'do' | 'collect' | 'wish';

// 每个 item 的本地同步状态（'doing'=在看, 'collect'=看过），用于节流去重
const stateMap = new Map<string, 'doing' | 'collect'>();
// douban_id 缓存，避免每次进度回调都去查飞牛元数据
const idCache = new Map<string, string>();
// 解析失败的 itemGuid，避免每 tick 重复刷 WARN（同一次会话内）
const missCache = new Set<string>();
// 系列级 douban_id 缓存（"剧名|类型|年代" → id）：同一部剧跨集、跨会话只搜索一次豆瓣，
// 避免「每集一次 subject_suggest 搜索」在短时间大量触发风控限流。
const seriesCache = new Map<string, string>();
// 持久化文件路径（userData 下），随应用重启保留缓存
let _cacheFile = '';
try { _cacheFile = path.join(app.getPath('userData'), 'douban_id_cache.json'); } catch (e) { _cacheFile = ''; }
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 启动时从磁盘加载系列缓存 */
function loadIdCache(): void {
    if (!_cacheFile) return;
    try {
        if (fs.existsSync(_cacheFile)) {
            const obj = JSON.parse(fs.readFileSync(_cacheFile, 'utf8'));
            if (obj && typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    if (typeof v === 'string' && /^\d+$/.test(v)) seriesCache.set(k, v);
                }
            }
            log.info('[豆瓣] 已加载系列缓存', seriesCache.size, '条');
        }
    } catch (e: any) {
        log.warn('[豆瓣] 加载系列缓存失败', e && e.message);
    }
}

/** 延迟落盘（合并多次写入），仅保留最近 500 条防止无限增长 */
function scheduleSaveIdCache(): void {
    if (_saveTimer || !_cacheFile) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            const obj: Record<string, string> = {};
            for (const [k, v] of Array.from(seriesCache.entries()).slice(-500)) obj[k] = v;
            fs.writeFileSync(_cacheFile, JSON.stringify(obj), 'utf8');
        } catch (e: any) {
            log.warn('[豆瓣] 写入系列缓存失败', e && e.message);
        }
    }, 1500);
}

/**
 * 已标记"看过"(collect) 的豆瓣条目缓存（douban_id → 时间戳）。
 * 持久化到 userData/douban_collect_cache.json，跨会话保留：
 * 同一部剧/电影一旦标记过"看过"，后续任何扫描/进度同步都不再重复写入豆瓣，
 * 既避免把"看过"降级，也从根上消除"每部剧重复打豆瓣"的限流风险。
 */
const collectCache = new Map<string, number>();
let _collectFile = '';
try { _collectFile = path.join(app.getPath('userData'), 'douban_collect_cache.json'); } catch (e) { _collectFile = ''; }
let _collectSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 启动时从磁盘加载"已看过"缓存 */
function loadCollectCache(): void {
    if (!_collectFile) return;
    try {
        if (fs.existsSync(_collectFile)) {
            const obj = JSON.parse(fs.readFileSync(_collectFile, 'utf8'));
            if (obj && typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    if (typeof k === 'string' && /^\d+$/.test(k)) collectCache.set(k, Number(v) || Date.now());
                }
            }
            log.info('[豆瓣] 已加载"看过"缓存', collectCache.size, '条');
        }
    } catch (e: any) {
        log.warn('[豆瓣] 加载"看过"缓存失败', e && e.message);
    }
}

/** 延迟落盘（合并多次写入），仅保留最近 1000 条 */
function scheduleSaveCollectCache(): void {
    if (_collectSaveTimer || !_collectFile) return;
    _collectSaveTimer = setTimeout(() => {
        _collectSaveTimer = null;
        try {
            const obj: Record<string, number> = {};
            for (const [k, v] of Array.from(collectCache.entries()).slice(-1000)) obj[k] = v;
            fs.writeFileSync(_collectFile, JSON.stringify(obj), 'utf8');
        } catch (e: any) {
            log.warn('[豆瓣] 写入"看过"缓存失败', e && e.message);
        }
    }, 1500);
}

let loginWin: BrowserWindow | null = null;
let loginTimer: ReturnType<typeof setInterval> | null = null;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 扫码窗口 5 分钟超时

// ============ 登录态 / 通知 ============

function notifyLoginChanged(): void {
    const mw = getMainWindow();
    if (mw) {
        mw.webContents.send('douban:login-changed', { loggedIn: !!fnConfig.getDoubanCookie() });
    }
}

export function getLoginStatus(): any {
    return {
        loggedIn: !!fnConfig.getDoubanCookie(),
        enabled: fnConfig.getDoubanSyncEnabled(),
    };
}

export function openDoubanLoginWindow(): void {
    if (loginWin) {
        loginWin.focus();
        return;
    }
    const mw = getMainWindow();
    loginWin = new BrowserWindow({
        width: 640,
        height: 780,
        parent: mw || undefined,
        modal: false,
        show: true,
        webPreferences: {
            // 独立 partition，避免污染主窗口(fntv)的登录态
            partition: 'persist:douban-oauth',
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    loginWin.loadURL('https://accounts.douban.com/passport/login');
    log.info('[豆瓣] 已打开扫码登录窗口');

    // 轮询：出现 dbcl2（登录态标志）即视为登录成功
    loginTimer = setInterval(async () => {
        if (!loginWin) return;
        try {
            const cookies = await loginWin.webContents.session.cookies.get({ domain: '.douban.com' });
            const dbcl2 = cookies.find((c) => c.name === 'dbcl2');
            if (dbcl2) {
                if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
                // 拉起 movie.douban.com 让服务端下发 ck(CSRF) cookie，否则后续 POST /j/interest 会被拒
                try {
                    await loginWin.loadURL('https://movie.douban.com/');
                    await new Promise((r) => setTimeout(r, 2000));
                } catch (e) { /* 导航失败则沿用已有 cookie，运行时再兜底取 ck */ }
                const cookies2 = await loginWin.webContents.session.cookies.get({ domain: '.douban.com' });
                const ck = cookies2.map((c) => `${c.name}=${c.value}`).join('; ');
                fnConfig.setDoubanCookie(ck);
                loginWin.close();
                notifyLoginChanged();
                log.info('[豆瓣] 扫码登录成功，已保存 cookie（含 ck）');
            }
        } catch {
            // 窗口已关闭等情况，忽略
        }
    }, 1500);

    // 超时自动关闭
    setTimeout(() => {
        if (loginWin) {
            log.info('[豆瓣] 扫码窗口超时，自动关闭');
            loginWin.close();
        }
    }, LOGIN_TIMEOUT_MS);

    loginWin.on('closed', () => {
        loginWin = null;
        if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
    });
}

export function logoutDouban(): void {
    fnConfig.setDoubanCookie(null);
    notifyLoginChanged();
    log.info('[豆瓣] 已退出登录');
}

// ============ 取 douban_id ============

/**
 * 从飞牛播放信息里取豆瓣条目 ID。
 *
 * 说明：PlayInfo / PlayInfo.item 的 TS 类型上没有 douban_id，但
 * getEpisodeList(guid) 返回的 PlayListItem[] 每项都带 douban_id(纯数字)。
 * 因此多源尝试：
 *  - 直接字段（运行期 API 可能比 TS 类型多返回 douban_id）
 *  - 用各层级 guid 调 getEpisodeList，扫描所有条目里的 douban_id
 *    （剧集取父级 guid 拿整部剧的 douban_id；电影用自身 guid 拿单条的）
 */
/**
 * 构造用于豆瓣搜索的查询词：优先用剧名(tv_title/parent_title)，其次用单集标题。
 * 去掉结尾的 (年份) 避免干扰匹配。
 */
function buildSearchQuery(item: any): string {
    let q = (item.tv_title || item.parent_title || item.title || '').toString().trim();
    q = q.replace(/\s*[（(]\s*\d{4}\s*[）)]?\s*$/, '').trim();
    return q;
}

/** 按"标题包含 + 年份相符 + 类型相符"打分，取最佳匹配 */
function pickBestSubject(arr: any[], query: string, wantType: string, year: string): string {    if (!Array.isArray(arr) || !arr.length) return '';
    const q = query.toLowerCase();
    let best: any = null;
    let bestScore = -1;
    for (const it of arr) {
        let s = 0;
        const t = String(it.title || '').toLowerCase();
        if (t === q) s += 5;
        else if (t.includes(q) || q.includes(t)) s += 2;
        if (it.year && year && String(it.year) === String(year)) s += 3;
        if (it.type && it.type === wantType) s += 2;
        if (s > bestScore) { bestScore = s; best = it; }
    }
    if (best && best.id && bestScore >= 2) {
        log.info('[豆瓣] 标题搜索命中:', query, '→', best.title, '(', best.id, ')');
        return String(best.id);
    }
    return '';
}

/**
 * 用标题去豆瓣搜索，返回 subject_id（纯数字）。
 * 先试 JSON 自动补全接口（带登录 cookie），失败/空再试搜索页 HTML 正则兜底。
 */
async function searchDoubanByTitle(query: string, wantType: 'movie' | 'tv', year: string, cookie: string): Promise<string> {
    const headers: any = {
        'Referer': 'https://movie.douban.com/',
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
    };
    // 1) 自动补全接口（JSON）
    try {
        const r1 = await doubanGate(() => axios.get(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, { headers, timeout: 12000 }));
        const picked = pickBestSubject(Array.isArray(r1.data) ? r1.data : [], query, wantType, year);
        if (picked) return picked;
    } catch (e: any) {
        log.warn('[豆瓣] subject_suggest 失败', query, String(e && e.message || e));
    }
    // 2) 兜底：搜索页 HTML，正则提取 subject 链接里的数字 id
    try {
        const r2 = await doubanGate(() => axios.get(`https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(query)}`, {
            headers: { ...headers, 'X-Requested-With': undefined },
            timeout: 12000,
        }));
        const html = typeof r2.data === 'string' ? r2.data : '';
        const m = html.match(/movie\.douban\.com\/subject\/(\d+)/);
        if (m && m[1]) {
            log.info('[豆瓣] 搜索页命中:', query, '→', m[1]);
            return m[1];
        }
    } catch (e: any) {
        log.warn('[豆瓣] subject_search 失败', query, String(e && e.message || e));
    }
    return '';
}

/** 系列级缓存 key：剧名(去年代) + 类型 + 年代，确保同一部剧跨集/跨会话只搜一次 */
function buildSeriesKey(item: any): string {
    const q = buildSearchQuery(item);
    if (!q) return '';
    const wantType = (item.type === 'Movie') ? 'movie' : 'tv';
    const year = (item.release_date || item.air_date || '').slice(0, 4);
    return `${q}|${wantType}|${year}`;
}

async function getDoubanId(itemGuid: string, info: any, fnapi: any): Promise<string> {
    const item = (info && info.item) || info || {};

    // 系列级缓存：同一部剧/电影只在首次解析时真正搜索豆瓣，后续集/会话直接复用，
    // 彻底避免「每集一次 subject_suggest 搜索」触发豆瓣风控限流。
    const seriesKey = buildSeriesKey(item);
    if (seriesKey && seriesCache.has(seriesKey)) {
        const cached = seriesCache.get(seriesKey)!;
        log.info('[豆瓣] 系列缓存命中:', seriesKey, '→', cached);
        return cached;
    }

    // 优先用带缓存的接口，避免每次进度都打飞牛
    const getList = (fnapi && typeof fnapi.getEpisodeListCached === 'function')
        ? fnapi.getEpisodeListCached.bind(fnapi)
        : (fnapi && typeof fnapi.getEpisodeList === 'function' ? fnapi.getEpisodeList.bind(fnapi) : null);

    const candidates: string[] = [];
    const pushId = (raw: any): void => {
        if (raw === undefined || raw === null || raw === '' || raw === 0) return;
        const s = String(raw).trim();
        if (s && /^\d+$/.test(s)) candidates.push(s); // 豆瓣 ID 是纯数字
    };

    // 1. 直接字段（运行期可能有）
    pushId(item.douban_id);
    pushId(item.doubanId);
    pushId(info && info.douban_id);
    pushId(info && info.doubanId);

    // 2. 各层级 guid 调 getEpisodeList，全量扫描条目
    const guids: string[] = [
        item.parent_guid,
        info && info.parent_guid,
        info && info.grand_guid,
        item.guid,
        info && info.guid,
    ].filter((g): g is string => typeof g === 'string' && !!g);

    const tried: string[] = [];
    for (const g of guids) {
        if (!getList || candidates.length) break;
        if (tried.includes(g)) continue;
        tried.push(g);
        try {
            const list: any = await getList(g);
            if (list && list.success && Array.isArray(list.data)) {
                for (const it of list.data) {
                    if (it) pushId(it.douban_id);
                }
            }
        } catch (e: any) {
            log.warn('[豆瓣] getEpisodeList 失败', g, String(e && e.message || e));
        }
    }

    // 3. 兜底：飞牛没刮削到豆瓣号 → 用标题去豆瓣搜索匹配
    if (!candidates.length) {
        const cookie = fnConfig.getDoubanCookie();
        if (cookie) {
            const query = buildSearchQuery(item);
            if (query) {
                const wantType = (item.type === 'Movie') ? 'movie' : 'tv';
                const year = (item.release_date || item.air_date || '').slice(0, 4);
                try {
                    const sid = await searchDoubanByTitle(query, wantType, year, cookie);
                    if (sid) candidates.push(sid);
                    else log.warn('[豆瓣] 标题搜索豆瓣无匹配; query =', query, '; type =', wantType, '; year =', year);
                } catch (e: any) {
                    log.warn('[豆瓣] 标题搜索豆瓣异常', query, String(e && e.message || e));
                }
            }
        }
    }

    const id = candidates[0] || '';
    if (id) {
        log.info('[豆瓣] 解析到 douban_id =', id, '标题 =', item.title || item.tv_title || '');
        if (seriesKey) { seriesCache.set(seriesKey, id); scheduleSaveIdCache(); }
    } else {
        if (!missCache.has(itemGuid)) {
            missCache.add(itemGuid);
            log.warn('[豆瓣] 无法解析 douban_id; item字段 =',
                Object.keys(item).join(','),
                '; 尝试过的guid =', tried.join(','));
        }
    }
    return id;
}

// ============ 写入豆瓣 ============

function extractCk(cookie: string): string {
    const m = cookie.match(/(?:^|;\s*)ck=([^;]+)/i);
    return m ? m[1] : '';
}

// 会话内缓存的 ck（豆瓣 CSRF 令牌）：登录态稳定期内复用，避免每次标记都去拉页面
let _cachedCk = '';

/**
 * 取用于豆瓣写入接口的 ck（CSRF 令牌）。
 * 优先级：① 已保存 cookie 里的 ck；② 会话内缓存；③ 临时拉取条目页，
 *         从 Set-Cookie 头或 HTML 中解析（针对"扫码登录后 cookie 未含 ck"的情况）。
 * ck 缺失会导致 POST /j/subject/{id}/interest 被豆瓣拒绝（HTTP 200 但 status≠success）。
 */
async function fetchCkForMarking(subjectId: string, cookie: string): Promise<string> {
    try {
        const r = await doubanGate(() => axios.get(`https://movie.douban.com/subject/${subjectId}/`, {
            headers: {
                Cookie: cookie,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
                'Referer': 'https://movie.douban.com/',
            },
            timeout: 12000,
            maxRedirects: 5,
        }));
        // 1) 响应头 Set-Cookie 里的 ck（已登录用户访问 movie 页服务端会下发）
        const sc = r.headers && r.headers['set-cookie'];
        if (Array.isArray(sc)) {
            for (const c of sc) {
                const m = c.match(/ck=([^;]+)/i);
                if (m && m[1]) return decodeURIComponent(m[1]);
            }
        }
        // 2) 页面 HTML 里嵌入的 ck（多种写法兜底）
        const html = typeof r.data === 'string' ? r.data : '';
        const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/name=["']ck["'][^>]*value=["']([^"']+)["']/i)
            || html.match(/["']ck["']\s*[:=]\s*["']([a-zA-Z0-9_\-]+)["']/);
        if (m && m[1]) return m[1];
    } catch (e: any) {
        log.warn('[豆瓣] 拉取 ck 失败', e && e.message);
    }
    return '';
}

async function getCk(subjectId: string, cookie: string): Promise<string> {
    if (_cachedCk) return _cachedCk;
    const fromCookie = extractCk(cookie);
    if (fromCookie) { _cachedCk = fromCookie; return fromCookie; }
    const fetched = await fetchCkForMarking(subjectId, cookie);
    if (fetched) _cachedCk = fetched;
    return fetched;
}

async function markInterest(
    subjectId: string,
    interest: Interest,
    cookie: string
): Promise<{ ok: boolean; msg?: string; expired?: boolean }> {
    const ck = await getCk(subjectId, cookie);
    const url = `https://movie.douban.com/j/subject/${subjectId}/interest`;
    const body = `ck=${encodeURIComponent(ck)}&interest=${interest}`
        + `&rating=&foldcollect=F&tags=&comment=`;
    try {
        const resp = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Referer': `https://movie.douban.com/subject/${subjectId}/`,
                'Cookie': cookie,
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            timeout: 15000,
        });
        const data: any = resp.data;
        // 豆瓣异常时可能返回登录页/错误页 HTML（HTTP 200），按失败处理并打日志
        if (typeof data === 'string') {
            if (/<html|<body/i.test(data)) {
                return { ok: false, msg: '豆瓣返回 HTML（疑似 cookie 失效或风控）' };
            }
            try { return { ok: false, msg: data.slice(0, 200) }; } catch { /* ignore */ }
        }
        // 成功判定：status==='success' 或 r===0（兼容不同返回形态）
        if (data && (data.status === 'success' || data.r === 0)) return { ok: true };
        if (resp.status === 401 || (data && data.status === 'please login') || /please login/i.test(JSON.stringify(data))) {
            _cachedCk = ''; // cookie 失效，清空 ck 缓存以便下次重新获取
            return { ok: false, msg: 'cookie 失效，请重新登录', expired: true };
        }
        const raw = JSON.stringify(data);
        if (/频繁|频率|rate.?limit|too many/i.test(raw)) {
            return { ok: false, msg: '触发豆瓣限流，稍后重试' };
        }
        const msg = (data && (data.message || data.msg)) || ('HTTP ' + resp.status);
        log.warn('[豆瓣] markInterest 响应:', raw.slice(0, 300));
        return { ok: false, msg };
    } catch (e: any) {
        if (e && e.response && e.response.status === 401) {
            _cachedCk = '';
            return { ok: false, msg: 'cookie 失效，请重新登录', expired: true };
        }
        return { ok: false, msg: String((e && e.message) || e) };
    }
}

async function markWithRetry(subjectId: string, interest: Interest, cookie: string): Promise<void> {
    for (let i = 0; i <= 1; i++) {
        const r = await markInterest(subjectId, interest, cookie);
        if (r.ok) return;
        log.warn('[豆瓣] markInterest 失败', interest, r.msg);
        if (r.expired) break; // cookie 失效不再重试
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
}

// ============ 进度同步（被 media.ts 调用）============

/** 取一个临时 ApiService 实例（用于"标记为已观看"拦截路径，该路径拿不到 media.ts 里的长生命周期实例） */
function getFnapiFresh(): any {
    const cfg = fnConfig.readConfig();
    if (!cfg || !cfg.domain || !cfg.token) {
        log.warn('[豆瓣] 缺少 fnOS 配置（domain/token），无法解析 douban_id');
        return null;
    }
    return new fn.ApiService(cfg.domain, cfg.token);
}

/**
 * 直接从飞牛 API 拉「已观看」列表（主进程，带 token），不再依赖渲染进程点击 DOM。
 * 调用 item/list(parent_guid='' 表示根媒体库, exclude_folder=1 排除文件夹)，
 * 过滤 watched===1 的条目。实证：根库共 133 项，其中已观看 3 项。
 */
/**
 * 计算单个已看条目（电视剧/电影）的总时长（毫秒）。
 *
 * fnOS 影视层级实测为三级：电视剧(TV) → 季(Season) → 单集(Episode)。
 *   - 电视剧 / 季 两级条目【没有】 runtime / duration 字段（实测 Object.keys 无此键），
 *     直接读 it.runtime / it.duration 恒为 0；
 *   - 只有"单集(Episode)"才带 duration(秒) 与 runtime(分钟)。
 *   - 电影(Movie)自身带 runtime(分钟)、duration=0。
 *
 * 因此时长必须向下钻取：电视剧/剧集类先用 item/list(parent_guid=本剧) 取子级（季/单集），
 * 遇 Season 再钻到 episode/list/{季guid} 取单集，逐集累加 duration(秒)，缺失时以
 * runtime(分钟)×60 兜底；电影直接取自身字段。最终仍无果才回退到本条目 runtime。
 *
 * 注：lc-696 曾把"电视剧 guid"直接喂给 episode/list（返回 0 集），又 fallback 到不存在的
 * it.runtime，导致全部总时长=0。本实现已在真实 fnOS API 上验证（3 部已看剧均得非零时长）。
 */
/**
 * 分析单部作品：总时长 + 观看进度 + 是否纳入「影视清单」。
 *
 * fnOS 观看模型（已在真实 API 上逐条验证，库内 162 项）：
 *   - 整部看完 → 条目 watched===1（电影），或 全部单集 watched===1（电视剧）。
 *   - 部分看   → 电视剧仅"部分单集 watched===1"，条目本身 watched 仍为 0；
 *               电影无精确百分比，仅有 watched_ts>0 的播放痕迹。
 *   - 完全没看 → watched===0 且无任何单集/痕迹。
 *
 * 因此"影视清单"必须向下钻取 季→单集 统计已看集数，才能把"看了一些没看完"的剧纳入
 * 并给出真实进度——否则只会显示整部看完的 9 部，漏掉 11 部部分看 + 1 部部分看电影。
 *
 * @param force true=绕过 10 分钟缓存（立即同步用）；false=用缓存（开面板自动加载用）。
 */
interface AnalyzeResult {
    total_runtime_ms: number;
    progress: number;        // 0..1：电视剧=已看集数/总集数；电影=1(看完)或0(仅痕迹)
    anyWatch: boolean;       // 是否纳入清单（看完 / 部分看 / 已开始）
    started: boolean;        // 有观看痕迹但未看完（前端显示"在观看"）
    last_played: number;     // ms（取自 watched_ts，无则 0）
}
async function analyzeItem(fnapi: any, it: any, force = false): Promise<AnalyzeResult> {
    const empty: AnalyzeResult = { total_runtime_ms: 0, progress: 0, anyWatch: false, started: false, last_played: 0 };
    const type = (it && it.type || '').toLowerCase();
    const itemListFn = force ? fnapi.getItemList.bind(fnapi) : fnapi.getItemListCached.bind(fnapi);
    const epListFn = force ? fnapi.getEpisodeList.bind(fnapi) : fnapi.getEpisodeListCached.bind(fnapi);
    const lpMs = it.watched_ts ? Number(it.watched_ts) * 1000 : 0;

    // 电影：单文件，自身字段即总时长
    if (type === 'movie') {
        const dur = Number(it.duration) || 0;
        const rt = Number(it.runtime) || 0;
        const totalSec = dur > 0 ? dur : (rt > 0 ? rt * 60 : 0);
        if (it.watched === 1) {
            return { total_runtime_ms: Math.round(totalSec * 1000), progress: 1, anyWatch: true, started: false, last_played: lpMs };
        }
        if (it.watched_ts > 0) {
            // 有播放痕迹但没标看完 → 记为"在观看"（飞牛电影部分看无精确百分比）
            return { total_runtime_ms: Math.round(totalSec * 1000), progress: 0, anyWatch: true, started: true, last_played: lpMs };
        }
        return empty; // 完全没看
    }

    // 电视剧 / 其他：向下钻取 季→单集，累加时长 + 统计已看集数
    let totalSec = 0;
    let totalEp = 0;
    let watchedEp = 0;
    let found = false;
    const addLeaf = (leaf: any): void => {
        if (!leaf) return;
        const dur = Number(leaf.duration) || 0;
        const rt = Number(leaf.runtime) || 0;
        if (dur > 0) totalSec += dur;
        else if (rt > 0) totalSec += rt * 60;
        totalEp++;
        if (leaf.watched === 1) watchedEp++;
    };
    try {
        const childResp: any = await itemListFn({
            parent_guid: it.guid,
            exclude_folder: 1,
            sort_column: 'sort_title',
            sort_type: 'ASC',
        });
        const children: any[] = (childResp && childResp.data && Array.isArray(childResp.data.list))
            ? childResp.data.list
            : [];
        for (const c of children) {
            const ct = (c.type || '').toLowerCase();
            if (ct === 'episode' || ct === 'movie') {
                addLeaf(c);
                found = true;
            } else {
                try {
                    const ep: any = await epListFn(c.guid);
                    const eps: any[] = (ep && ep.success && Array.isArray(ep.data)) ? ep.data : [];
                    if (eps.length) {
                        for (const e of eps) addLeaf(e);
                        found = true;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
    // 兜底：子级钻取无果时，仍尝试 episode/list/{本条目guid}（兼容单层剧集/异常结构）
    if (!found) {
        try {
            const ep: any = await epListFn(it.guid);
            const eps: any[] = (ep && ep.success && Array.isArray(ep.data)) ? ep.data : [];
            for (const e of eps) addLeaf(e);
        } catch { /* ignore */ }
    }

    const total_runtime_ms = totalSec > 0 ? Math.round(totalSec * 1000)
        : (Number(it && it.runtime) || 0) * 60; // 最终兜底：本条目自身 runtime(分钟)

    // 是否纳入「影视清单」
    if (it.watched === 1 || (totalEp > 0 && watchedEp === totalEp)) {
        return { total_runtime_ms, progress: 1, anyWatch: true, started: false, last_played: lpMs };
    }
    if (watchedEp > 0) {
        const progress = totalEp > 0 ? watchedEp / totalEp : 0;
        return { total_runtime_ms, progress, anyWatch: true, started: true, last_played: lpMs };
    }
    return empty; // 完全没看
}

/**
 * 并发受限的 map（避免一次性对 TMDB 发起过多请求触发 429）。
 */
async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(arr.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < arr.length) {
            const idx = cursor++;
            results[idx] = await fn(arr[idx], idx);
        }
    }
    const n = Math.max(1, Math.min(limit, arr.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

/**
 * 为「观影记录」补充分类标签(category)与 TMDB 中文类型(genres)：
 *   - base：Movie→电影；TV→剧集（fnOS 的 TV 在 mapType 下原会落到"其他"，这里直接给到剧集/电影）
 *   - TMDB（有 key 且命中）可把 TV 升级为"动漫"（检测到动画类型），并带回中文 genres
 *   - 无 key / 未命中 / 网络失败 → 维持 base 分类、genres 留空（前端回退"未分类"）
 */
async function enrichWithTmdb(it: any): Promise<{ category: string; genres: string[]; tmdbRating: number; tmdbVotes: number }> {
    const rawType = (it && it.type || '').toLowerCase();
    const mediaType: 'movie' | 'tv' = rawType === 'movie' ? 'movie' : 'tv';
    const baseCat = mediaType === 'movie' ? '电影' : '剧集';
    const year = String(it && (it.release_date || it.air_date) || '').slice(0, 4);
    let category = baseCat;
    let genres: string[] = [];
    let tmdbRating = 0;
    let tmdbVotes = 0;
    try {
        const r = await tmdbGenresFor(it && it.title || '', {
            mediaType,
            year: year || undefined,
        });
        if (r) {
            if (r.category) category = r.category;
            if (Array.isArray(r.genres)) genres = r.genres;
            // tmdbGenresFor 已在同一次 TMDB 搜索里带回评分(0~10)与参评人数
            tmdbRating = typeof r.rating === 'number' ? r.rating : 0;
            tmdbVotes = typeof r.votes === 'number' ? r.votes : 0;
        }
    } catch { /* ignore：TMDB 异常不影响主流程 */ }
    return { category, genres, tmdbRating, tmdbVotes };
}

/**
 * 豆瓣全局限速闸门：所有对 movie.douban.com / search.douban.com 的出站请求都经此串行化，
 * 最小间隔 + 429 指数退避重试，从根上避免「首次同步集中打几十个 subject 页」触发风控(429)。
 *   - 用一条 Promise 链把所有请求串行排队（天然错峰，不会并发叠加打豆瓣）；
 *   - 两次请求强制间隔 DOUBAN_MIN_GAP_MS，远低于豆瓣网页接口的限流阈值；
 *   - 遇 HTTP 429 按 1s→2s→4s（封顶 8s）指数退避重试，耗尽后才上抛交由调用方降级。
 * 这样「立即同步」首次虽稍慢（每个 douban_id 当天只真抓一次，之后命中 dailyCache 秒回），
 * 但绝不会再因并发 429 导致整批评分拿不到。
 */
let _doubanGateChain: Promise<void> = Promise.resolve();
let _doubanLastReqTs = 0;
const DOUBAN_MIN_GAP_MS = 800;   // 两次豆瓣请求最小间隔
const DOUBAN_MAX_RETRY = 3;      // 429 最大重试次数

async function doubanGate<T>(fn: () => Promise<T>): Promise<T> {
    const run = _doubanGateChain.then(async () => {
        const wait = DOUBAN_MIN_GAP_MS - (Date.now() - _doubanLastReqTs);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        let lastErr: any = null;
        for (let attempt = 0; attempt <= DOUBAN_MAX_RETRY; attempt++) {
            try {
                _doubanLastReqTs = Date.now();
                return await fn();
            } catch (e: any) {
                lastErr = e;
                const status = e && e.response && e.response.status;
                if (status === 429) {
                    const backoff = Math.min(8000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
                    log.warn('[豆瓣] 触发限流 429，退避 ' + backoff + 'ms 后重试 (' + (attempt + 1) + '/' + (DOUBAN_MAX_RETRY + 1) + ')');
                    await new Promise((r) => setTimeout(r, backoff));
                    _doubanLastReqTs = Date.now(); // 退避结束后重置间隔基线
                    continue;
                }
                throw e; // 非 429（网络/解析等）直接上抛，交由调用方降级
            }
        }
        throw lastErr;
    });
    // 不把错误传播到链上，避免一个失败阻塞后续排队请求
    _doubanGateChain = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * 取豆瓣评分（0~10）+ 参评人数。飞牛影视本身不提供豆瓣评分，故此函数现取：
 *  1) 解析豆瓣条目 id：优先用飞牛已刮削的 it.douban_id；否则复用 getDoubanId（标题搜豆瓣，公开搜索页无需登录）；
 *  2) 拉条目页 HTML（公开，无需 cookie）抠 rating_num（评分）与 property="v:votes"（参评人数）；
 *  3) 按 douban_id 每日磁盘缓存（getDailyCached），避免每次开面板都打豆瓣、也防限流；失败/无值返回 0/0。
 */
async function fetchDoubanRating(it: any, fnapi: any): Promise<{ rating: number; votes: number }> {
    let doubanId = '';
    const raw = it && it.douban_id;
    if (raw && /^\d+$/.test(String(raw))) doubanId = String(raw);
    if (!doubanId) {
        try {
            doubanId = await getDoubanId(it && it.guid ? String(it.guid) : '', { item: it }, fnapi);
        } catch (e: any) {
            log.warn('[豆瓣] 评分：解析 douban_id 失败', String(e && e.message || e));
        }
    }
    if (!doubanId) return { rating: 0, votes: 0 };
    const cacheKey = 'douban_rating_' + doubanId;
    try {
        const r = await getDailyCached(cacheKey, async () => {
            const url = `https://movie.douban.com/subject/${doubanId}/`;
            const resp = await doubanGate(() => axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
                    'Referer': 'https://movie.douban.com/',
                },
                timeout: 12000,
            }));
            const html = typeof resp.data === 'string' ? resp.data : '';
            let rating = 0, votes = 0;
            // 1) 优先解析条目页内嵌的 JSON-LD（aggregateRating，结构最稳）
            const ld = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
            if (ld) {
                try {
                    const obj = JSON.parse(ld[1]);
                    const ar = obj && obj.aggregateRating;
                    if (ar) {
                        if (ar.ratingValue != null) rating = parseFloat(String(ar.ratingValue));
                        if (ar.ratingCount != null) votes = parseInt(String(ar.ratingCount).replace(/,/g, ''), 10);
                    }
                } catch (e: any) { /* JSON-LD 解析失败则走正则兜底 */ }
            }
            // 2) 兜底：rating_num 类 + v:votes 属性
            if (!rating) {
                const m = html.match(/<strong[^>]*class="[^"]*rating_num[^"]*"[^>]*>([\d.]+)<\/strong>/);
                if (m) rating = parseFloat(m[1]);
            }
            if (!votes) {
                const v = html.match(/<span[^>]*property="v:votes"[^>]*>([\d,]+)<\/span>/);
                if (v) votes = parseInt(String(v[1]).replace(/,/g, ''), 10);
            }
            return { rating, votes };
        }, DEFAULT_TTL_MS, false);
        return { rating: (r.data && r.data.rating) || 0, votes: (r.data && r.data.votes) || 0 };
    } catch (e: any) {
        log.warn('[豆瓣] 评分拉取失败', doubanId, String(e && e.message || e));
        return { rating: 0, votes: 0 };
    }
}

// ── 观影记录完整结果磁盘缓存（跨重启持久化，根治每次重启全量钻取刷日志）──
const WATCH_CACHE_FILE = (() => {
    try { return path.join(app.getPath('userData'), 'watch_history_cache.json'); } catch { return ''; }
})();
const WATCH_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

/** 读取磁盘缓存（未过期）：返回 { items, libraryTotal } 或 null。 */
function readWatchCache(staleOk = false): { items: any[]; libraryTotal: number } | null {
    if (!WATCH_CACHE_FILE) return null;
    try {
        if (!fs.existsSync(WATCH_CACHE_FILE)) return null;
        const obj = JSON.parse(fs.readFileSync(WATCH_CACHE_FILE, 'utf8'));
        if (!obj || !Array.isArray(obj.items)) return null;
        if (!staleOk && typeof obj.savedAt === 'number' && Date.now() - obj.savedAt > WATCH_CACHE_TTL_MS) return null;
        return { items: obj.items, libraryTotal: typeof obj.libraryTotal === 'number' ? obj.libraryTotal : 0 };
    } catch { return null; }
}

/** 写入磁盘缓存（覆盖式）。失败仅告警，不影响主流程。 */
function writeWatchCache(result: { items: any[]; libraryTotal: number }): void {
    if (!WATCH_CACHE_FILE) return;
    try {
        fs.writeFileSync(WATCH_CACHE_FILE, JSON.stringify({ savedAt: Date.now(), ...result }), 'utf8');
    } catch (e: any) {
        log.warn('[豆瓣] 写入观影记录缓存失败:', e && e.message);
    }
}

async function getWatchedItems(force = false): Promise<{ items: any[]; libraryTotal: number }> {
    // 命中磁盘缓存（30 分钟内）→ 直接返回，跳过 162 部钻取 + TMDB + 豆瓣，
    // 开面板秒开、重启进程不刷日志；点「立即同步」(force=true) 才绕过缓存重拉。
    if (!force) {
        const cached = readWatchCache();
        if (cached) {
            log.info(`[豆瓣] 观影记录命中磁盘缓存（${cached.items.length} 部），跳过全量钻取`);
            return cached;
        }
    }
    const fnapi = getFnapiFresh();
    if (!fnapi) {
        log.warn('[豆瓣] 缺少 fnOS 配置（domain/token），无法拉取已观看列表');
        return { items: [], libraryTotal: 0 };
    }
    try {
        const resp: any = await fnapi.getItemList({
            parent_guid: '',
            exclude_folder: 1,
            sort_column: 'sort_title',
            sort_type: 'ASC',
        });
        if (!resp.success || !resp.data || !Array.isArray(resp.data.list)) {
            log.warn('[豆瓣] 拉取列表失败:', resp && resp.message);
            return { items: [], libraryTotal: 0 };
        }
        const total = resp.data.total;
        const list: any[] = resp.data.list;
        // libraryTotal = 库内作品总数（已看+未看），用于前端"X 部作品"展示（用户要求显示库内真实作品数）
        const libraryTotal = typeof total === 'number' ? total : list.length;
        if (typeof total === 'number' && list.length < total) {
            log.warn(`[豆瓣] 列表可能被服务端截断: 返回 ${list.length} / 总计 ${total}`);
        }
        // 第一步：并发向下钻取分析每部作品（总时长 + 已看进度），仅保留有观看记录者。
        // 这一步必须扫全部 162 项——因为"部分看"的剧在条目级 watched 仍为 0，只有钻到单集才能发现，
        // 否则"影视清单"只会剩整部看完的 9 部，漏掉 11 部部分看 + 1 部部分看电影。
        const analyzed = await mapLimit(list, 6, async (it: any) => {
            const a = await analyzeItem(fnapi, it, force);
            return a.anyWatch ? { it, a } : null;
        });
        const kept = analyzed.filter((x: any) => x !== null);
        // 第二步：仅对保留的（含部分看）条目补 TMDB 分类/类型标签，避免对 122 部未看剧浪费 TMDB 配额。
        const items = await mapLimit(kept, 3, async (pair: any) => {
            const { it, a } = pair;
            const enr = await enrichWithTmdb(it);
            // 豆瓣评分：飞牛不提供，主进程现取（按 douban_id 每日缓存，防限流）
            const db = await fetchDoubanRating(it, fnapi);
            // fnOS 列表项自带 vote_average（字符串，飞牛从 TMDB 刮削并缓存的评分）——即"飞牛自动获取的 TMDB 评分"
            const va = parseFloat(String(it.vote_average || '0'));
            return {
                guid: it.guid,
                parent_guid: it.parent_guid,
                douban_id: it.douban_id || 0,
                title: it.title,
                tv_title: it.tv_title,
                parent_title: it.parent_title,
                type: it.type,
                category: enr.category, // 电影 / 剧集 / 动漫（前端用其替换"其他"）
                genres: enr.genres,   // TMDB 中文类型标签（无则空数组，前端回退"未分类"）
                air_date: it.air_date,
                release_date: it.release_date,
                watched: it.watched === 1 ? 1 : 0,
                started: a.started ? 1 : 0,
                last_played: a.last_played, // ms
                progress: a.progress,       // 0..1：电视剧=已看集数/总集数
                total_runtime_ms: a.total_runtime_ms,
                // 多平台评分：fnos_rating=飞牛影视缓存的 TMDB 评分(直接可用) / douban_rating+douban_votes=主进程现取豆瓣评分
                fnos_rating: isNaN(va) ? 0 : va,
                tmdb_rating: enr.tmdbRating,
                tmdb_votes: enr.tmdbVotes,
                douban_rating: db.rating,
                douban_votes: db.votes,
            };
        });
        const done = items.filter((x: any) => x.progress >= 1).length;
        const partial = items.length - done;
        log.info(`[豆瓣] 库内共 ${libraryTotal} 项 → 有观看记录 ${items.length} 部（看完 ${done} / 部分看 ${partial}）`);
        writeWatchCache({ items, libraryTotal });
        return { items, libraryTotal };
    } catch (e: any) {
        log.warn('[豆瓣] getWatchedItems 异常:', e && e.message);
        // 异常时降级返回过期缓存（若有），避免面板空白；否则返回空
        const stale = readWatchCache(true);
        if (stale) { log.info(`[豆瓣] 降级使用过期磁盘缓存（${stale.items.length} 部）`); return stale; }
        return { items: [], libraryTotal: 0 };
    }
}

/**
 * 播放进度回调 → 同步到豆瓣。被 media.ts 的 PROGRESS 事件每秒调用。
 * 内部用 stateMap 做状态机节流，只在状态切换时打豆瓣（天然限频、抗风控）。
 *
 * 规则：
 * - 飞牛该条目已 is_watched=1（历史看过 / 重看）→ 直接标"看过"，避免被"在看"覆盖。
 * - 否则只要有播放进度（percentage>0）且尚未同步过 → 标"在看"。
 *
 * @param itemGuid 飞牛播放项 GUID（作为去重 key）
 * @param info     getPlayInfo 返回的 PlayInfo（含 item / parent 信息）
 * @param percentage 播放器给的进度百分比（0-100）
 * @param fnapi    当前 ApiService 实例（用于查 douban_id 兜底）
 */
/**
 * 播放进度回调 → 同步到豆瓣。被 media.ts 的 PROGRESS 事件每秒调用。
 * 内部用 stateMap 做状态机节流，只在状态切换时打豆瓣（天然限频、抗风控）。
 *
 * 规则：
 * - 飞牛该条目已 is_watched=1（历史看过 / 重看）→ 直接标"看过"，避免被"在看"覆盖。
 * - 否则只要收到有效的进度事件（媒体有真实时长）且尚未同步过 → 标"在看"。
 *   注意：percentage = floor(ts/duration*100)，开播前几秒恒为 0，故不再以 pct>0 判定，
 *   改用"媒体有效(duration>0)"，确保刚开播就能标上"在看"。
 *
 * @param itemGuid 飞牛播放项 GUID（作为去重 key）
 * @param info     getPlayInfo 返回的 PlayInfo（含 item / parent 信息）
 * @param percentage 播放器给的进度百分比（0-100，floor 后开播前可能为 0）
 * @param fnapi    当前 ApiService 实例（用于查 douban_id 兜底）
 * @param ts       播放器当前位置（秒）
 * @param duration 媒体总时长（秒），>0 视为有效媒体
 */
export async function syncOnProgress(
    itemGuid: string,
    info: any,
    percentage: number,
    fnapi: any,
    ts: number = 0,
    duration: number = 0
): Promise<void> {
    try {
        if (!fnConfig.getDoubanSyncEnabled()) return;
        const _syncItem = (info && info.item) || {};
        if (!types.isSyncableItemType(_syncItem.type)) {
            log.info(`[豆瓣] 媒体类型 "${_syncItem.type || 'null'}" 不在可同步范围(仅电影/电视节目/混合影片)，跳过豆瓣同步`);
            return;
        }
        const cookie = fnConfig.getDoubanCookie();
        if (!cookie) {
            log.info('[豆瓣] 未登录，跳过同步');
            return;
        }
        const pct = typeof percentage === 'number' ? percentage : 0;

        let doubanId = idCache.get(itemGuid) || '';
        if (!doubanId) {
            if (missCache.has(itemGuid)) return; // 本次会话已确认拿不到，跳过
            doubanId = await getDoubanId(itemGuid, info, fnapi);
            if (doubanId) idCache.set(itemGuid, doubanId);
        }
        if (!doubanId) {
            log.warn('[豆瓣] 无法获取 douban_id，跳过', itemGuid);
            return;
        }

        // 已通过"已观看列表"同步标过"看过"的条目：保持看过，绝不被进度同步降级为"在看"
        if (collectCache.has(doubanId)) {
            stateMap.set(itemGuid, 'collect');
            return;
        }

        const item = (info && info.item) || {};
        const alreadyWatched = info && (info.watched === 1 || item.is_watched === 1);
        const state = stateMap.get(itemGuid);
        // 媒体有效（有真实时长）才视为"在看"，避免开播前的 0/0 空事件误标
        const mediaValid = duration > 0;

        if (alreadyWatched) {
            // 飞牛侧已观看：直接标"看过"，不回退成"在看"
            if (state !== 'collect' && mediaValid) {
                await markWithRetry(doubanId, 'collect', cookie);
                stateMap.set(itemGuid, 'collect');
                log.info('[豆瓣] 已标记看过（飞牛侧已观看）', doubanId);
            }
            return;
        }

        // 首次有效进度事件即标"在看"（不再要求 percentage>0，开播前几秒恒为 0）
        if (!state && mediaValid) {
            await markWithRetry(doubanId, 'do', cookie);
            stateMap.set(itemGuid, 'doing');
            log.info('[豆瓣] 已标记在看（有播放进度）', doubanId);
        }
    } catch (e: any) {
        log.warn('[豆瓣] syncOnProgress 异常', e && e.message);
    }
}

/**
 * 飞牛"标记为已观看"按钮被点击时触发（由 init 注册的 session 拦截器捕获
 * /v/api/v1/item/watched 请求后调用）。同步到豆瓣为"看过"(interest=collect)。
 *
 * @param itemGuid 被标记为已观看的飞牛播放项 GUID
 */
export async function syncOnWatched(itemGuid: string): Promise<void> {
    try {
        if (!fnConfig.getDoubanSyncEnabled()) return;
        const cookie = fnConfig.getDoubanCookie();
        if (!cookie) {
            log.info('[豆瓣] 未登录，跳过"看过"同步');
            return;
        }
        if (stateMap.get(itemGuid) === 'collect') return; // 已同步过，幂等

        const fnapi = getFnapiFresh();
        if (!fnapi) return;

        let doubanId = idCache.get(itemGuid) || '';
        if (!doubanId) {
            if (missCache.has(itemGuid)) return;
            const resp = await fnapi.getPlayInfoCached(itemGuid).catch(() => null);
            const resolvedInfo = resp && resp.success && resp.data ? resp.data : null;
            doubanId = await getDoubanId(itemGuid, resolvedInfo, fnapi);
            if (doubanId) idCache.set(itemGuid, doubanId);
        }
        if (!doubanId) {
            log.warn('[豆瓣] 「标记为已观看」但无法解析 douban_id，跳过', itemGuid);
            return;
        }

        // 已通过"已观看列表"同步标过"看过"的条目：幂等，跳过
        if (collectCache.has(doubanId)) {
            stateMap.set(itemGuid, 'collect');
            return;
        }

        await markWithRetry(doubanId, 'collect', cookie);
        stateMap.set(itemGuid, 'collect');
        log.info('[豆瓣] 已标记看过（来自飞牛"标记为已观看"）', doubanId);
    } catch (e: any) {
        log.warn('[豆瓣] syncOnWatched 异常', e && e.message);
    }
}

// ============ 已观看列表 → 豆瓣"看过" 同步 ============

/**
 * 处理渲染进程回传的"已观看"条目列表：解析 douban_id（seriesCache 命中则不重复搜索豆瓣），
 * 标记"看过"(interest=collect)。已写入 collectCache 的条目直接跳过（幂等、防限流、防降级）。
 * 写入串行化、两次之间间隔 600ms，配合 markWithRetry 的一次重试，天然抗豆瓣风控。
 */
export async function processWatchedList(items: any[]): Promise<any> {
    try {
        if (!Array.isArray(items) || !items.length) {
            return { total: 0, marked: 0, skipped: 0, failed: 0 };
        }
        if (!fnConfig.getDoubanSyncEnabled()) {
            return { total: items.length, marked: 0, skipped: 0, failed: 0, note: '豆瓣同步未开启' };
        }
        const cookie = fnConfig.getDoubanCookie();
        if (!cookie) {
            return { total: items.length, marked: 0, skipped: 0, failed: 0, note: '豆瓣未登录' };
        }
        const fnapi = getFnapiFresh();
        let marked = 0, skipped = 0, failed = 0;
        for (const it of items) {
            try {
                const rawId = it && it.douban_id ? String(it.douban_id) : '';
                let doubanId = (/^\d+$/.test(rawId)) ? rawId : '';
                if (!doubanId) {
                    const info = { item: it, watched: 1, guid: it.guid, parent_guid: it.parent_guid };
                    doubanId = await getDoubanId(it.guid, info, fnapi);
                }
                if (!doubanId) { skipped++; continue; }
                if (collectCache.has(doubanId)) { skipped++; continue; }
                await markWithRetry(doubanId, 'collect', cookie);
                collectCache.set(doubanId, Date.now());
                scheduleSaveCollectCache();
                if (it && it.guid) stateMap.set(it.guid, 'collect');
                marked++;
                await new Promise((r) => setTimeout(r, 600)); // 节流：两次豆瓣写入间隔
            } catch (e: any) {
                failed++;
                log.warn('[豆瓣] 已观看列表条目处理失败', (it && it.guid) || '', e && e.message);
            }
        }
        log.info(`[豆瓣] 已观看列表同步完成: total=${items.length} marked=${marked} skipped=${skipped} failed=${failed}`);
        return { total: items.length, marked, skipped, failed };
    } catch (e: any) {
        log.warn('[豆瓣] processWatchedList 异常', e && e.message);
        return { total: Array.isArray(items) ? items.length : 0, marked: 0, skipped: 0, failed: 0 };
    }
}

// 手动/自动扫描的待返回 promise（主进程等候渲染进程回传结果）
let _pendingScanResolve: ((s: any) => void) | null = null;
let _autoScanTimer: ReturnType<typeof setInterval> | null = null;
let _lastScanTs = 0;
const MIN_SCAN_GAP_MS = 10 * 60 * 1000; // 硬下限：两次扫描至少间隔 10 分钟（防手动+自动叠加过密）

/** 触发渲染进程扫描已观看列表（主进程→渲染进程 send） */
function triggerWatchedScan(): void {
    const mw = getMainWindow();
    if (!mw) return;
    if (!fnConfig.getDoubanSyncEnabled() || !fnConfig.getDoubanCookie()) return;
    const now = Date.now();
    if (now - _lastScanTs < MIN_SCAN_GAP_MS) return; // 防抖
    _lastScanTs = now;
    mw.webContents.send('douban:scan-watched-request');
}

/** 启停自动扫描定时器（intervalMin<=0 关闭；下限 10 分钟） */
function startAutoWatchedScan(intervalMin: number): void {
    if (_autoScanTimer) { clearInterval(_autoScanTimer); _autoScanTimer = null; }
    if (!intervalMin || intervalMin <= 0) {
        log.info('[豆瓣] 已观看列表自动同步：关闭');
        return;
    }
    const ms = Math.max(intervalMin, 10) * 60 * 1000;
    _autoScanTimer = setInterval(triggerWatchedScan, ms);
    log.info(`[豆瓣] 已观看列表自动同步：每 ${Math.max(intervalMin, 10)} 分钟一次`);
}

// ============ IPC 注册 ============

export function init(): void {
    loadIdCache();
    loadCollectCache();
    registerHandler('douban:login-status', () => getLoginStatus(), { useHandle: true });
    registerHandler('douban:open-login', () => {
        try {
            openDoubanLoginWindow();
            return { ok: true };
        } catch (e: any) {
            return { ok: false, msg: String((e && e.message) || e) };
        }
    }, { useHandle: true });
    registerHandler('douban:logout', () => {
        logoutDouban();
        return { ok: true };
    }, { useHandle: true });
    registerHandler('douban:manual-cookie', (_e: any, cookie: string) => {
        if (!cookie || !cookie.trim()) {
            return { ok: false, msg: 'cookie 为空' };
        }
        fnConfig.setDoubanCookie(cookie.trim());
        notifyLoginChanged();
        return { ok: true };
    }, { useHandle: true });

    // 渲染进程回传"已观看"条目后，主进程标记豆瓣"看过"（串行+节流）
    registerHandler('douban:process-watched', async (_e: any, items: any[]) => {
        return await processWatchedList(items);
    }, { useHandle: true });

    // 主进程直接从 fnOS API 拉「已观看」列表（替代渲染进程点击 DOM，稳定可靠）
    // 第二个参数 force=true 时绕过 10 分钟缓存，用于「立即同步」即时拉取最新观看数据。
    registerHandler('douban:get-watched-items', async (_e: any, force?: boolean) => {
        return await getWatchedItems(force === true);
    }, { useHandle: true });

    // 手动触发扫描：主进程请求渲染进程扫描，等待回传结果（超时 25s）
    registerHandler('douban:scan-watched-manual', () => {
        const mw = getMainWindow();
        if (!mw) return { error: 'no-window', total: 0, marked: 0, skipped: 0, failed: 0 };
        if (_pendingScanResolve) return { error: 'busy', total: 0, marked: 0, skipped: 0, failed: 0 };
        return new Promise((resolve) => {
            _pendingScanResolve = resolve;
            const timer = setTimeout(() => {
                if (_pendingScanResolve === resolve) {
                    _pendingScanResolve = null;
                    resolve({ error: 'timeout', total: 0, marked: 0, skipped: 0, failed: 0 });
                }
            }, 25000);
            const orig = resolve;
            _pendingScanResolve = (s: any) => { clearTimeout(timer); orig(s); };
            _lastScanTs = Date.now(); // 计入防抖窗口
            mw.webContents.send('douban:scan-watched-request');
        });
    }, { useHandle: true });

    // 渲染进程扫描完成后回传结果（手动/自动共用）
    registerHandler('douban:scan-watched-done', (_e: any, summary: any) => {
        log.info('[豆瓣] 已观看列表扫描回传:', JSON.stringify(summary || {}));
        if (_pendingScanResolve) {
            const r = _pendingScanResolve;
            _pendingScanResolve = null;
            r(summary || { total: 0, marked: 0, skipped: 0, failed: 0 });
        }
    }, { useHandle: true });

    // 设置自动同步间隔（分钟，0=关闭）
    registerHandler('douban:set-watched-scan-interval', (_e: any, min: number) => {
        fnConfig.setWatchedScanIntervalMin(min);
        startAutoWatchedScan(fnConfig.getWatchedScanIntervalMin());
        return { ok: true, interval: fnConfig.getWatchedScanIntervalMin() };
    }, { useHandle: true });

    // 读取当前自动同步间隔
    registerHandler('douban:get-watched-scan-interval', () => {
        return { interval: fnConfig.getWatchedScanIntervalMin() };
    }, { useHandle: true });

    // 启动自动扫描（按已存配置）
    startAutoWatchedScan(fnConfig.getWatchedScanIntervalMin());

    // 拦截飞牛"标记为已观看"请求：用户点击飞牛 UI 的"标记为已观看"按钮时，
    // fnOS 会向 /v/api/v1/item/watched 发 POST。捕获其 body 里的 item_guid，
    // 异步同步到豆瓣"看过"。拦截器在 handlers/index.ts 里于插件 init 之后统一 run()，
    // 因此此处注册会在会话级 webRequest 上生效。
    try {
        const interceptor = getInterceptor();
        interceptor.registerBeforeRequest(
            { urls: ['*://*/v/api/v1/item/watched'] },
            (details: any, callback: any) => {
                // 放行请求，不修改原行为
                if (typeof callback === 'function') callback({});
                try {
                    const ud = details && details.uploadData;
                    if (ud && Array.isArray(ud) && ud[0] && ud[0].bytes) {
                        const body = ud[0].bytes.toString('utf8');
                        const m = body.match(/"item_guid"\s*:\s*"([^"]+)"/);
                        if (m && m[1]) {
                            void syncOnWatched(m[1]);
                        }
                    }
                } catch (e: any) {
                    log.warn('[豆瓣] 解析 watched 请求失败', e && e.message);
                }
            },
            'douban-watched'
        );
        log.info('[豆瓣] 已注册"标记为已观看"拦截器');
    } catch (e: any) {
        log.warn('[豆瓣] 注册 watched 拦截器失败', e && e.message);
    }
}
