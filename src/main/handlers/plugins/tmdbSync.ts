import { app, BrowserWindow } from 'electron';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fnConfig from '../../../modules/fn_config/config';
import * as proxyModule from '../../../modules/proxyAgent';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';
import { getDailyCached, DEFAULT_TTL_MS } from '../../common/dailyCache';

const log = logger.component('tmdb');

/**
 * TMDB 数据源插件（「热门剧更新」浮层的 TMDB 电影/剧集源）
 *
 * - 端点：api.themoviedb.org/3（discover/movie、discover/tv）
 * - 鉴权：自适应两种格式
 *     · v4 Read Access Token（JWT，形如 eyJ...）→ Authorization: Bearer
 *     · v3 API Key（32 位十六进制）→ ?api_key= 查询参数
 * - 语言：language=zh-CN；中文缺失时字段为空，由前端 fallback 原文
 * - 图片：https://image.tmdb.org/t/p/w500{poster_path}（固定 base，https）
 * - Key 来源：设置面板 → config.tmdbApiKey（明文存本地，每个用户各自填写；默认空）
 * - 速率限制 ~40 req/s，低频场景无压力；超限返回 429，由调用方提示
 */

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

/**
 * TMDB 请求基址。默认官方；可设环境变量 TMDB_BASE_URL 指向自建反代
 * （如 Cloudflare Worker / 海外节点转发），从而本机无需梯子即可访问被墙的 TMDB。
 * 反代只需原样转发请求（含鉴权），不改变响应结构。
 */
const TMDB_BASE_URL = (process.env.TMDB_BASE_URL || TMDB_API).replace(/\/+$/, '');

/**
 * TMDB 图片基址。默认官方 image.tmdb.org；同样在大陆可能被墙，
 * 可设 TMDB_IMG_BASE_URL 指向自建反代（与 TMDB_BASE_URL 同一 Worker 的不同路径前缀即可）。
 */
const TMDB_IMG_BASE_URL = (process.env.TMDB_IMG_BASE_URL || TMDB_IMG).replace(/\/+$/, '');

/**
 * 内置 TMDB 直连 IP 快照（取自 CheckTMDB 项目，2026-08-04 数据）。
 * TMDB 用 Cloudflare/AWS 边缘节点，国内 DNS 被污染解析到假 IP 导致直连失败；
 * 这些是被筛出的「国内可直连」真实边缘 IP。CDN 调度会变，用户可在设置面板覆盖或点「更新 IP」。
 */
const TMDB_IP_SNAPSHOT = { api: '65.8.20.79', img: '65.8.20.8' };
// CheckTMDB 每日更新的 hosts 片段（含 api/image 域名最新可用 IP）
const TMDB_IP_UPDATE_URL = 'https://raw.githubusercontent.com/cnwikee/CheckTMDB/refs/heads/main/Tmdb_host_ipv4';
// 自动跟随 CheckTMDB 每日刷新 IP 的间隔（24h）。CheckTMDB 仓库每天 GitHub Action 重算可用 IP，
// 故此处定时拉取即可让本机直连 IP 自动跟上，无需梯子、无需手动点按钮。
const TMDB_IP_REFRESH_INTERVAL = 24 * 3600 * 1000;

// 弱网 / 跨网络环境（换电脑、公司网、需代理）下给足余量
const TMDB_TIMEOUT = 25000;   // 单请求超时（原 12s，换网络环境极易触发）
const TMDB_RETRIES = 2;       // 网络类错误自动重试次数（指数退避 1s / 2s）

/** 当前生效的直连 IP：用户自定义优先，否则内置快照 */
function directIp(): { api: string; img: string } {
    const cfg = fnConfig.getTmdbDirectIp();
    return {
        api: (cfg && cfg.api) || TMDB_IP_SNAPSHOT.api,
        img: (cfg && cfg.img) || TMDB_IP_SNAPSHOT.img,
    };
}

/**
 * 自定义 DNS lookup：命中 TMDB 域名则返回指定 IPv4（绕过污染），否则走系统 DNS。
 * TLS 仍用原域名（SNI/证书不受影响）。与 HTTPS_PROXY 互斥（有代理时上层不会调用本函数）。
 */
function directLookup(): (hostname: string, opts: any, cb: any) => void {
    const ip = directIp();
    const map: Record<string, string> = {};
    if (ip.api) {
        map['api.themoviedb.org'] = ip.api;
        map['www.themoviedb.org'] = ip.api;
        map['themoviedb.org'] = ip.api;
        map['auth.themoviedb.org'] = ip.api;
    }
    if (ip.img) {
        map['image.tmdb.org'] = ip.img;
        map['images.tmdb.org'] = ip.img;
    }
    return (hostname: string, opts: any, cb: any) => {
        // Electron/Node 可能以 2 参 (hostname, callback) 或 3 参 (hostname, options, callback) 调用；
        // options 可能是对象 / 数字(family) / 省略，统一归一化，避免 cb 落到 undefined 上。
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        const hit = map[hostname];
        if (hit) {
            // 命中：强制返回 IPv4。若上层要求 all（数组形式）则按数组返回，否则单值。
            // 关键：hit 必为有效 IP 字符串（map 仅在 ip.api/img 真时赋值），绝不传 undefined，
            // 否则 Node 抛 ERR_INVALID_IP_ADDRESS（Invalid IP address: undefined）。
            if (opts.all) return cb(null, [{ address: hit, family: 4 }]);
            return cb(null, hit, 4);
        }
        return dns.lookup(hostname, opts, cb);
    };
}

/** 从 CheckTMDB 的 hosts 片段文本里抠出指定域名的 IPv4 */
function pickIpFromHosts(text: string, host: string): string | null {
    const re = new RegExp('\\b(\\d{1,3}(?:\\.\\d{1,3}){3})\\s+' + host.replace(/\./g, '\\.') + '\\b');
    const m = text.match(re);
    return m ? m[1] : null;
}

/**
 * 从 CheckTMDB 远程拉取最新可用 IP 并写入配置。
 * force=false（自动每日刷新）：尊重用户手动填过的 IP——手动设过的字段保留，仅补齐未设字段；
 *                              避免自动刷新把你手动调通的 IP 覆盖成 CheckTMDB 的通用值。
 * force=true （手动点「更新 IP」按钮）：强制用 CheckTMDB 最新值覆盖全部字段。
 * 注意：raw.githubusercontent.com 在国内也可能被墙，拉取失败会返回明确错误，由前端提示手动填。
 */
async function updateDirectIpFromRemote(force = false): Promise<{ ok: boolean; api?: string; img?: string; error?: string }> {
    try {
        const agent = proxyAgent();
        const client = axios.create({
            timeout: 20000,
            ...(agent ? { httpsAgent: agent, proxy: false } : {}),
        });
        const resp = await client.get(TMDB_IP_UPDATE_URL);
        const text = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        const remoteApi = pickIpFromHosts(text, 'api.themoviedb.org');
        const remoteImg = pickIpFromHosts(text, 'image.tmdb.org');
        if (!remoteApi && !remoteImg) {
            return { ok: false, error: '未能从 CheckTMDB 解析出 IP（可能返回格式变化）' };
        }
        // 非强制时尊重用户手动值：cur.api 存在则保留，否则用远端最新值
        const cur = fnConfig.getTmdbDirectIp() || {};
        const nextApi = force ? remoteApi : (cur.api || remoteApi);
        const nextImg = force ? remoteImg : (cur.img || remoteImg);
        fnConfig.setTmdbDirectIp({ api: nextApi || undefined, img: nextImg || undefined });
        return { ok: true, api: nextApi || undefined, img: nextImg || undefined };
    } catch (e: any) {
        return {
            ok: false,
            error: '拉取 CheckTMDB 失败（raw.githubusercontent.com 在国内可能被墙，请手动填 IP 或先开梯子）：' +
                String((e && e.message) || e),
        };
    }
}

/**
 * 自动跟随 CheckTMDB 每日更新：仅在用户开启「免梯子直连」时，后台定时拉取最新 IP。
 * - 启动后延迟 30s 做一次（不阻塞启动）；之后每 24h 一次。
 * - 一天内已更新过（手动或上次自动）则跳过，避免无谓请求。
 * - 拉取失败（如 raw 被墙）静默回退到内置快照 / 上次成功值，不影响使用。
 */
function scheduleAutoIpRefresh(): void {
    const tryRefresh = async (): Promise<void> => {
        if (!fnConfig.getTmdbDirectConnect()) return;   // 未开启直连则不拉
        const last = fnConfig.getTmdbDirectIpUpdatedAt();
        if (Date.now() - last < TMDB_IP_REFRESH_INTERVAL) return;  // 一天内已更新过则跳过
        try {
            const r = await updateDirectIpFromRemote(false);
            if (r.ok) {
                log.info('TMDB 直连 IP 已自动跟随 CheckTMDB 更新（api=' + (r.api || '-') + ' img=' + (r.img || '-') + '）');
            } else {
                log.warn('TMDB 直连 IP 自动更新跳过：' + (r.error || '未知'));
            }
        } catch (e: any) {
            log.warn('TMDB 直连 IP 自动更新失败，继续使用现有 IP：' + String((e && e.message) || e));
        }
    };
    setTimeout(tryRefresh, 30 * 1000);
    setInterval(tryRefresh, TMDB_IP_REFRESH_INTERVAL);
}

/**
 * 图片代理：渲染进程（Chromium）不走主进程 lookup/代理，直接用系统 DNS 会命中污染，
 * 故海报等图片统一经主进程拉取（复用直连/代理逻辑）后返回 base64 data URL。
 * 这样「免梯子直连」开启时海报也能正常加载，且与 HTTPS_PROXY 方案互不冲突。
 */
// 图片 data URL 内存缓存：渲染进程每次 render 重建 DOM 会重新请求同一批海报，
// 若无缓存则会反复重新下载（既烧 TMDB 流量/触发限流，又造成"明明加载过却重拉"的观感）。
// 这里按 URL 缓存已下载的 data URL，相同图第二次起直接返回，跳过网络下载。FIFO 上限防无限增长。
const _imgDataUrlCache = new Map<string, string>();
const IMG_CACHE_MAX = 400;

// [lc-416] 图片磁盘缓存：把已下载的 data URL 落到 userData/cache/img/，跨软件重启持久化。
// 轮播图 Logo / 浮层海报等 TMDB 图片从此不再每次向 image.tmdb.org 读取。
function imgDiskDir(): string {
    const dir = path.join(app.getPath('userData'), 'cache', 'img');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略，下载分支仍可用 */ }
    return dir;
}
function imgDiskFile(url: string): string {
    const h = crypto.createHash('sha1').update(url).digest('hex');
    return path.join(imgDiskDir(), h + '.txt');
}
function imgDiskRead(url: string): string | null {
    try {
        const f = imgDiskFile(url);
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8');
    } catch { /* 忽略损坏缓存，走下载 */ }
    return null;
}
function imgDiskWrite(url: string, dataUrl: string): void {
    try { fs.writeFileSync(imgDiskFile(url), dataUrl, 'utf-8'); } catch { /* 忽略写盘失败，不影响本次返回 */ }
}

async function fetchImageAsDataUrl(url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
    try {
        if (!/^https?:\/\//.test(url)) return { ok: false, error: '非法图片地址' };
        // [lc-370] 内存缓存：直接返回已下载的 data URL，跳过网络下载
        const mem = _imgDataUrlCache.get(url);
        if (mem) {
            log.info('[TMDB图片缓存] 命中内存缓存，跳过下载：' + url.slice(0, 80));
            return { ok: true, dataUrl: mem };
        }
        // [lc-416] 磁盘缓存（跨重启持久化）：命中则直接返回，不再向 TMDB 图片服务器读取
        const disk = imgDiskRead(url);
        if (disk) {
            _imgDataUrlCache.set(url, disk); // 回填内存，加速下次
            log.info('[TMDB图片缓存] 命中磁盘缓存(' + disk.length + ' 字符)，跳过下载：' + url.slice(0, 80));
            return { ok: true, dataUrl: disk };
        }
        const agent = proxyAgent();
        const direct = fnConfig.getTmdbDirectConnect() && !agent;
        const a = agent || (direct ? new https.Agent({ lookup: directLookup(), keepAlive: false }) : undefined);
        const ip = directIp();
        const mode = agent ? '代理(环境变量/自定义)' : (direct ? ('免梯子直连(img=' + ip.img + ')') : '系统 DNS 直连');
        log.info('[TMDB图片缓存] 未命中缓存，开始下载(' + mode + ')：' + url.slice(0, 80));
        const client = axios.create({
            timeout: 20000,
            responseType: 'arraybuffer',
            ...(a ? { httpsAgent: a, proxy: false } : {}),
        });
        const resp = await client.get(url);
        const ct = (resp.headers && resp.headers['content-type']) || 'image/jpeg';
        const b64 = Buffer.from(resp.data as Buffer).toString('base64');
        const dataUrl = `data:${ct};base64,${b64}`;
        // 写入内存缓存（超过上限时淘汰最早一项）
        if (_imgDataUrlCache.size >= IMG_CACHE_MAX) {
            const oldest = _imgDataUrlCache.keys().next().value;
            if (oldest) _imgDataUrlCache.delete(oldest);
        }
        _imgDataUrlCache.set(url, dataUrl);
        // 写入磁盘缓存（持久化，关掉软件再开不重复下载）
        imgDiskWrite(url, dataUrl);
        log.info('[TMDB图片缓存] 下载成功(' + (resp.data as Buffer).length + ' 字节)，已写入磁盘缓存：' + url.slice(0, 80));
        return { ok: true, dataUrl };
    } catch (e: any) {
        log.error('[TMDB图片缓存] 图片下载失败：' + dumpErr(e));
        return { ok: false, error: String((e && e.message) || e) };
    }
}

function tmdbUA(): string {
    let ver = 'unknown';
    try { ver = app.getVersion(); } catch (e) { /* 测试环境无 app */ }
    return `YDMY007/Fntv-Plus/${ver} (https://github.com/YDMY007/Fntv-Plus)`;
}

/** 按 Key 形态构造鉴权方式：返回 { headers, queryKey } */
function authFor(key: string): { headers: Record<string, string>; queryKey?: string } {
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(key.trim())) {
        // v4 Read Access Token（JWT）
        return { headers: { 'Authorization': `Bearer ${key.trim()}` } };
    }
    // v3 API Key
    return { headers: {}, queryKey: key.trim() };
}

/**
 * 解析代理 agent：环境变量优先，其次设置面板「自定义代理」。
 * 统一走共享模块 proxyModule.resolveProxyAgent()，避免重复实现 SOCKS 校验等逻辑。
 * 返回 axios 可用的 httpsAgent（已禁用 axios 自带代理逻辑由调用方设置 proxy:false），无代理则 undefined。
 */
function proxyAgent(): any {
    return proxyModule.resolveProxyAgent();
}

/** 带鉴权 + 超时 + UA + 可选代理/直连 的 http 客户端 */
function http(): AxiosInstance {
    const key = fnConfig.getTmdbApiKey();
    const a = key ? authFor(key) : { headers: {} as Record<string, string> };
    const proxy = proxyAgent();
    // 与代理互斥：设了代理（环境变量或设置面板自定义）走代理；否则若开启免梯子直连，用自定义 DNS lookup 覆盖解析
    const direct = fnConfig.getTmdbDirectConnect() && !proxy;
    const agent = proxy || (direct ? new https.Agent({ lookup: directLookup(), keepAlive: false }) : undefined);
    const ip = directIp();
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const proxyLabel = envProxy ? ('环境变量代理(' + envProxy + ')') : '自定义代理(设置面板)';
    const mode = proxy
        ? proxyLabel
        : direct
            ? ('免梯子直连(强制解析 api=' + ip.api + ' img=' + ip.img + ')')
            : '系统 DNS 直连(无代理/未开直连)';
    log.info('[TMDB诊断] 请求模式=' + mode +
        ' | baseURL=' + TMDB_BASE_URL + (TMDB_BASE_URL !== TMDB_API ? '(环境变量覆盖)' : '') +
        ' | Key格式=' + (key ? (a.queryKey ? 'v3短Key(api_key)' : 'v4长Token(JWT Bearer)') : '未配置') +
        ' | 超时=' + TMDB_TIMEOUT + 'ms');
    return axios.create({
        baseURL: TMDB_BASE_URL,
        timeout: TMDB_TIMEOUT,
        headers: {
            'User-Agent': tmdbUA(),
            'Content-Type': 'application/json',
            ...a.headers,
        },
        // 有代理/直连时交给自定义 httpsAgent，并关闭 axios 自带代理逻辑（避免与 lookup/隧道冲突）
        ...(agent ? { httpsAgent: agent, proxy: false } : {}),
    });
}

/** 是否为可重试的网络类错误（超时 / 抖动 / DNS 暂态） */
function isRetryableNetworkError(e: any): boolean {
    const code = e && e.code;
    const msg = String((e && e.message) || '');
    return code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
        code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
        code === 'ECONNRESET' || code === 'EPIPE' ||
        msg.includes('timeout') || msg.includes('Network Error');
}

/** 单次 GET，遇网络类错误自动重试（指数退避） */
async function getWithRetry(client: AxiosInstance, url: string, cfg: any): Promise<any> {
    let lastErr: any;
    for (let attempt = 0; attempt <= TMDB_RETRIES; attempt++) {
        try {
            return await client.get(url, cfg);
        } catch (e) {
            lastErr = e;
            if (!isRetryableNetworkError(e) || attempt === TMDB_RETRIES) throw e;
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
    throw lastErr;
}

/** 把错误转成详细诊断字符串（含 HTTP 状态码 / 响应体片段 / Node 错误码 / DNS 信息） */
function dumpErr(e: any): string {
    if (!e) return '未知错误';
    const parts: string[] = [];
    parts.push('msg=' + String(e.message || e));
    if (e.code) parts.push('code=' + e.code);
    if (e.errno) parts.push('errno=' + e.errno);
    if (e.syscall) parts.push('syscall=' + e.syscall);
    if (e.hostname) parts.push('hostname=' + e.hostname);
    if (e.address) parts.push('address=' + e.address);
    if (e.port) parts.push('port=' + e.port);
    const status = e.response && e.response.status;
    if (status) {
        parts.push('httpStatus=' + status);
        const data = e.response.data;
        let snippet = '';
        try {
            snippet = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
        } catch { snippet = '(响应体不可序列化)'; }
        if (snippet) parts.push('resp=' + snippet);
    } else if (e.request) {
        parts.push('(无 HTTP 响应：疑似网络连接失败 / 代理 / DNS 污染)');
    }
    return parts.join(' | ');
}

/** 把 axios / 网络错误翻译成对用户友好的中文提示（帮助判断是否本机网络问题） */
function describeTmdbError(e: any): string {
    const status = e && e.response && e.response.status;
    const code = e && e.code;
    const msg = String((e && e.message) || e);
    if (status === 401) return 'TMDB Key 无效或无访问权限，请检查设置面板填写的 Key。';
    if (status === 429) return 'TMDB 请求过于频繁（触发限速），请稍后再试。';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析 TMDB 域名（DNS 失败），请检查本机网络连接。';
    if (code === 'ECONNREFUSED') return 'TMDB 连接被拒绝，请检查本机网络 / 代理设置。';
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout'))
        return 'TMDB 请求超时：本机网络无法直连 api.themoviedb.org（DNS 被污染 / 需代理）。' +
            '可选方案：① 设置 HTTPS_PROXY=http://127.0.0.1:代理端口（Clash 7890 / v2rayN 10809）；' +
            '② 部署自建反代后设置 TMDB_BASE_URL=https://你的反代域名；③ 直接用「每日放送」的 Bangumi 源（国内直连、免 Key）。';
    return msg;
}

function posterUrl(posterPath: any): string {
    if (typeof posterPath === 'string' && posterPath) return TMDB_IMG_BASE_URL + posterPath;
    return '';
}

function yearOf(date: any): string {
    if (typeof date === 'string' && date.length >= 4) return date.slice(0, 4);
    return '';
}

/** 归一化为与 Bangumi 卡片共享的渲染字段 */
function normalize(raw: any, mediaType: 'movie' | 'tv'): any {
    const title = (mediaType === 'movie' ? (raw.title || raw.original_title) : (raw.name || raw.original_name)) || '';
    const date = mediaType === 'movie' ? raw.release_date : raw.first_air_date;
    return {
        id: raw.id,
        mediaType,
        name: title,
        name_cn: title,
        images: { common: posterUrl(raw.poster_path) },
        rating: typeof raw.vote_average === 'number' ? raw.vote_average : 0,
        year: yearOf(date),
        popularity: typeof raw.popularity === 'number' ? raw.popularity : 0,
        overview: raw.overview || '',
        url: `https://www.themoviedb.org/${mediaType}/${raw.id}`,
    };
}

/**
 * 拉取 TMDB 热门电影 + 剧集（discover，按 popularity 降序），合并去重。
 * 仅在用户已配置 TMDB Key 时可用。
 */
async function fetchDiscover(): Promise<{ ok: boolean; items?: any[]; error?: string; warning?: string }> {
    const key = fnConfig.getTmdbApiKey();
    if (!key) {
        return { ok: false, error: '未配置 TMDB API Key，请在设置面板填写。' };
    }
    try {
        const client = http();
        const a = authFor(key);
        const baseParams = {
            language: 'zh-CN',
            sort_by: 'popularity.desc',
            page: 1,
            ...(a.queryKey ? { api_key: a.queryKey } : {}),
        };
        // 两个源分别请求、分别容错：一个超时 / 失败不影响另一个
        const [movieR, tvR] = await Promise.allSettled([
            getWithRetry(client, '/discover/movie', { params: baseParams }),
            getWithRetry(client, '/discover/tv', { params: baseParams }),
        ]);
        if (movieR.status === 'fulfilled') {
            const n = movieR.value?.data?.results?.length || 0;
            log.info('[TMDB诊断] discover/movie 成功，返回 ' + n + ' 条');
        } else {
            log.error('[TMDB诊断] discover/movie 失败：' + dumpErr(movieR.reason));
        }
        if (tvR.status === 'fulfilled') {
            const n = tvR.value?.data?.results?.length || 0;
            log.info('[TMDB诊断] discover/tv 成功，返回 ' + n + ' 条');
        } else {
            log.error('[TMDB诊断] discover/tv 失败：' + dumpErr(tvR.reason));
        }
        const movies: any[] = movieR.status === 'fulfilled' && movieR.value?.data?.results ? movieR.value.data.results : [];
        const tvs: any[] = tvR.status === 'fulfilled' && tvR.value?.data?.results ? tvR.value.data.results : [];
        const seen = new Set<number>();
        const items: any[] = [];
        for (const m of movies) {
            if (!m || !m.id || seen.has(m.id)) continue;
            seen.add(m.id);
            items.push(normalize(m, 'movie'));
        }
        for (const t of tvs) {
            if (!t || !t.id || seen.has(t.id)) continue;
            seen.add(t.id);
            items.push(normalize(t, 'tv'));
        }
        // 两个源都失败 → 返回细化错误（直接提示网络 / DNS / 代理问题）
        if (!items.length) {
            const reasons = [movieR, tvR]
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => describeTmdbError(r.reason));
            return { ok: false, error: reasons[0] || 'TMDB 数据获取失败。' };
        }
        // 部分成功 → 仍返回数据，并附带提示
        let warning: string | undefined;
        if (movieR.status === 'rejected' || tvR.status === 'rejected') {
            warning = '部分数据源（电影 / 剧集）获取失败，已显示可用部分。';
        }
        // 混合列表按热度降序（前端再按「最新 / 剧集 / 电影」二次排序）
        items.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
        log.info('[TMDB诊断] 拉取完成，共合并 ' + items.length + ' 条（电影 ' + movies.length + ' + 剧集 ' + tvs.length + '）' + (warning ? '；' + warning : ''));
        return { ok: true, items, warning };
    } catch (e: any) {
        return { ok: false, error: describeTmdbError(e) };
    }
}

/**
 * 拉取指定影视的 TMDB 透明 logo（用于替换轮播图文字标题）。
 * 入参：{ id?, title?, mediaType? }
 *   - 有 id：直接查 /3/{mediaType}/{id}/images
 *   - 无 id 但有 title：先 /3/search/{mediaType}?query= 拿到 id 再查 images
 * 出参：{ ok, logoPath?, logoPaths?, error? }（logoPath 为首选 /t/p 路径；logoPaths 为按优先级排序的「横屏」候选路径列表，均不含域名；渲染端再排除纯白 PNG）
 * 仅返回路径，真实图片由渲染进程经 tmdb:image 代理转 base64（复用图片缓存 + 免梯子直连）。
 */
async function getTmdbLogo(arg: { id?: number | string; title?: string; mediaType?: 'tv' | 'movie' }): Promise<{ ok: boolean; logoPath?: string; logoPaths?: string[]; error?: string }> {
    const mediaType = arg.mediaType === 'movie' ? 'movie' : 'tv';
    const key = fnConfig.getTmdbApiKey();
    try {
        const client = http();
        const a = key ? authFor(key) : { headers: {} as Record<string, string> };
        const baseParams = { language: 'zh-CN', ...(a.queryKey ? { api_key: a.queryKey } : {}) };

        let id = arg.id;
        if (!id && arg.title) {
            // 无 tmdb id：用标题搜索（中文标题也能命中，TMDB 含别名索引）
            const sResp = await getWithRetry(client, `/search/${mediaType}`, { params: { ...baseParams, query: arg.title, page: 1 } });
            const results = (sResp?.data?.results || []) as any[];
            if (!results.length) return { ok: false, error: 'TMDB 搜索无结果: ' + arg.title };
            id = results[0].id;
            log.info('[TMDB诊断] logo 搜索 "' + arg.title + '" → tmdb id ' + id);
        }
        if (!id) return { ok: false, error: '缺少 tmdb id 且无法从标题搜索' };

        // 取 logos：显式请求 中文/日语/英语/无语言 四类；[lc-413] 先按「横屏(宽>高)」筛选，再按「中文>日语>英语>其他」优先级排序，其次按投票最高
        const iResp = await getWithRetry(client, `/${mediaType}/${id}/images`, { params: { ...baseParams, include_image_language: 'zh,ja,en,null' } });
        const logos = (iResp?.data?.logos || []) as any[];
        if (!logos.length) return { ok: false, error: 'TMDB 无 logo: ' + arg.title + ' (id=' + id + ')' };

        // [lc-413] 横屏筛选：优先 width>height；缺失宽高时退用 aspect_ratio>1；二者皆缺则保守保留（交由渲染端像素复核）
        const isLandscape = (l: any): boolean => {
            const w = typeof l.width === 'number' ? l.width : 0;
            const h = typeof l.height === 'number' ? l.height : 0;
            if (w && h) return w > h;
            const ar = typeof l.aspect_ratio === 'number' ? l.aspect_ratio : 0;
            if (ar) return ar > 1;
            return true;
        };
        const landscape = logos.filter(isLandscape);
        if (!landscape.length) return { ok: false, error: 'TMDB 无横屏 logo: ' + arg.title + ' (id=' + id + ')' };

        const scored = landscape.map((l) => ({
            path: l.file_path as string,
            lang: (l.iso_639_1 as string) || '',
            vote: typeof l.vote_average === 'number' ? l.vote_average : 0,
        }));
        // 语言优先级：中文(zh) > 日语(ja) > 英语(en) > 其他（含无语言 null）；其次按投票最高
        const rank = (lang: string): number => {
            if (lang === 'zh' || lang === 'zh-CN' || lang.startsWith('zh')) return 3;
            if (lang === 'ja') return 2;
            if (lang === 'en') return 1;
            return 0;
        };
        scored.sort((x, y) => {
            const rx = rank(x.lang), ry = rank(y.lang);
            if (rx !== ry) return ry - rx;
            return y.vote - x.vote;
        });
        // [lc-413] 返回横屏候选列表（按优先级排序），渲染端逐个尝试并排除纯白 PNG，挑首个可用；logoPath 保留首选以兼容旧调用
        const logoPaths = scored.map((s) => s.path);
        log.info('[TMDB诊断] logo 横屏候选 ' + logoPaths.length + ' 个（原始 ' + logos.length + ' 个）：'
            + logoPaths.slice(0, 3).join(', ') + (logoPaths.length > 3 ? ' …' : ''));
        return { ok: true, logoPath: logoPaths[0], logoPaths };
    } catch (e: any) {
        return { ok: false, error: describeTmdbError(e) };
    }
}

/**
 * 按标题 + 媒体类型从 TMDB 拉取「类型(genre)标签」与「媒体分类」。
 * 供「观影记录」详情展示：详情 chip 用 genres（中文，language=zh-CN），卡片/详情分类标签用 category。
 *   - movie → 电影
 *   - tv + 含"动画/动漫"类型 → 动漫；tv 其余 → 剧集
 * 按 `mt:title` 做每日磁盘缓存（getDailyCached），避免重复打 TMDB；首次也降低压力。
 * 无 Key / 搜索无果 / 网络失败 → 返回 null，由调用方自行兜底（类型映射 / "未分类"）。
 */
export async function tmdbGenresFor(
    title: string,
    opts: { mediaType?: 'movie' | 'tv'; year?: string } = {}
): Promise<{ genres: string[]; category: string; rating: number; votes: number } | null> {
    const key = fnConfig.getTmdbApiKey();
    if (!key || !title) return null;
    const mt: 'movie' | 'tv' = opts.mediaType === 'movie' ? 'movie' : 'tv';
    const cacheKey = 'genres_' + mt + '_' + title;
    try {
        const r = await getDailyCached(cacheKey, async () => {
            const client = http();
            const a = key ? authFor(key) : { headers: {} as Record<string, string> };
            const baseParams: any = { language: 'zh-CN', ...(a.queryKey ? { api_key: a.queryKey } : {}) };
            const sParams: any = { ...baseParams, query: title, page: 1 };
            if (opts.year) {
                if (mt === 'movie') sParams.year = opts.year;
                else sParams.first_air_date_year = opts.year;
            }
            const sResp = await getWithRetry(client, `/search/${mt}`, { params: sParams });
            const results = (sResp?.data?.results || []) as any[];
            if (!results.length) return { genres: [] as string[], rating: 0, votes: 0 };
            const top = results[0];
            const id = top.id;
            const dResp = await getWithRetry(client, `/${mt}/${id}`, { params: baseParams });
            const genres = ((dResp?.data?.genres) || []).map((g: any) => g.name).filter((x: any) => !!x);
            // 评分顺带取自搜索结果首条（与类型标签同一次 TMDB 调用，零额外配额）：
            //   vote_average = TMDB 评分(0~10)；vote_count = 参评人数。
            const rating = typeof top.vote_average === 'number' ? top.vote_average : 0;
            const votes = typeof top.vote_count === 'number' ? top.vote_count : 0;
            return { genres: genres as string[], rating, votes };
        }, DEFAULT_TTL_MS, false);
        const genres = (r.data && r.data.genres) || [];
        let category: string;
        if (mt === 'movie') category = '电影';
        else {
            const isAnime = genres.some((g: string) => /动画|动漫|Animation|Anime/i.test(g));
            category = isAnime ? '动漫' : '剧集';
        }
        return { genres, category, rating: (r.data && r.data.rating) || 0, votes: (r.data && r.data.votes) || 0 };
    } catch (e: any) {
        log.warn('[TMDB诊断] genres 获取失败（' + title + '）：' + (e?.message || e));
        return null;
    }
}

function init(): void {
    registerHandler('tmdb:discover', async (_e: any, force?: boolean) => {
        try {
            // [lc-581] onRefreshed: 过期缓存立即返回(秒见旧数据), 后台刷新成功后推送给渲染进程无感更新
            const r = await getDailyCached('tmdb_hot', async () => {
                const res = await fetchDiscover();
                if (!res.ok) throw new Error(res.error || 'tmdb fetch failed');
                return res;
            }, DEFAULT_TTL_MS, !!force, (data) => {
                try {
                    BrowserWindow.getAllWindows().forEach((w) => {
                        w.webContents.send('hot-data-refreshed', { source: 'tmdb', data, cachedAt: Date.now() });
                    });
                } catch { /* ignore */ }
            });
            log.info('[TMDB诊断] 数据'
                + (r.stale ? '返回过期缓存(后台正在刷新新数据)'
                    : r.fromCache ? '来自本地缓存（未发网络请求）'
                        : '已从线上刷新')
                + '，更新于 ' + new Date(r.fetchedAt).toLocaleString('zh-CN'));
            return { ...r.data, cachedAt: r.fetchedAt, fromCache: r.fromCache, stale: r.stale };
        } catch (e: any) {
            return { ok: false, error: (e && e.message) || 'TMDB 数据获取失败' };
        }
    }, { useHandle: true });
    registerHandler('tmdb:update-ip', async () => {
        return updateDirectIpFromRemote(true);   // 手动点按钮：强制用 CheckTMDB 最新值覆盖
    }, { useHandle: true });
    registerHandler('tmdb:image', async (_e: any, url: string) => {
        return fetchImageAsDataUrl(url);
    }, { useHandle: true });
    // 「观影记录」标签：渲染进程传入 {title, mediaType?, year?}，主进程查 TMDB 取中文类型标签 + 媒体分类。
    // 结果按 title+mediaType 每日磁盘缓存（getDailyCached），避免每次打开面板都打 TMDB 接口。
    registerHandler('tmdb:genres', async (_e: any, arg: { title: string; mediaType?: 'movie' | 'tv'; year?: string }) => {
        return tmdbGenresFor(arg?.title || '', { mediaType: arg?.mediaType, year: arg?.year });
    }, { useHandle: true });
    // [lc-416] 轮播图透明 logo：渲染进程传入 {id?,title?,mediaType?}，主进程查 TMDB images 取 logo 路径。
    // 结果按 id/title 持久化缓存(默认 24h)，避免每次轮播渲染都请求 TMDB 接口（既省流量也防 429）。
    registerHandler('tmdb:logo', async (_e: any, arg: { id?: number | string; title?: string; mediaType?: 'tv' | 'movie' }) => {
        const mt = arg.mediaType === 'movie' ? 'movie' : 'tv';
        const key = 'logo_' + mt + '_' + (arg.id != null ? String(arg.id) : ('t_' + (arg.title || '')));
        try {
            const r = await getDailyCached(key, async () => {
                const res = await getTmdbLogo(arg || {});
                if (!res.ok) throw new Error(res.error || 'logo 获取失败');
                return res;
            }, DEFAULT_TTL_MS, false);
            log.info('[TMDB图片缓存] logo 选择' + (r.fromCache ? '来自磁盘缓存(未请求TMDB)' : '已向TMDB刷新') + ' key=' + key);
            return r.data;
        } catch (e: any) {
            log.warn('[TMDB图片缓存] logo 获取失败：' + (e?.message || e));
            return { ok: false, error: String((e && e.message) || e) };
        }
    }, { useHandle: true });
    // 启动自动跟随 CheckTMDB 每日刷新直连 IP（用户开启免梯子直连时生效）
    scheduleAutoIpRefresh();
    log.info('TMDB 数据源插件已加载');
}

export {
    init
};
