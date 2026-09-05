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

/** 观影记录「完结状态」相关缓存版本：结构变动(如 lc-762 新增 status 字段 / lc-765 改为按年份接近度选最佳匹配)时 +1，
 *  使旧缓存失效、强制重拉，避免「部分剧集显示已完结/部分不显示」或「同名不同剧误匹配」的脏缓存现象。 */
const TMDB_GENRES_CACHE_VER = 3;

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

/** [lc-1033] 供其他模块复用的 TMDB GET：继承 v3/v4 鉴权、代理/免梯子直连与网络重试。
 *  返回响应 data（JSON）。params 由调用方给（language 等自带上）。 */
export async function tmdbApiGet(path: string, params: Record<string, any> = {}): Promise<any> {
    const key = fnConfig.getTmdbApiKey();
    const a = key ? authFor(key) : { headers: {} as Record<string, string>, queryKey: '' };
    const q: any = { language: 'zh-CN', ...(a.queryKey ? { api_key: a.queryKey } : {}), ...params };
    const r = await getWithRetry(http(), path, { params: q });
    return r.data;
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
            // [lc-947] 无 tmdb id：用标题搜索（多策略，兼容长 Descriptive 中文标题 / 全角标点）
            const found = await tmdbSearchBest(client, baseParams, mediaType, arg.title);
            if (!found) return { ok: false, error: 'TMDB 搜索无结果: ' + arg.title };
            id = found.id;
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
): Promise<{ genres: string[]; category: string; rating: number; votes: number; status?: string } | null> {
    const key = fnConfig.getTmdbApiKey();
    if (!key || !title) return null;
    const mt: 'movie' | 'tv' = opts.mediaType === 'movie' ? 'movie' : 'tv';
    // 缓存键带版本号：lc-762 给本函数增加 status(完结状态) 字段；旧缓存(无 status)会使徽标不显示。
    // 升级版本使所有旧缓存失效、强制重拉，根治「部分剧集显示/部分不显示」的脏缓存。
    const cacheKey = 'genres_v' + TMDB_GENRES_CACHE_VER + '_' + mt + '_' + title;
    try {
        const r = await getDailyCached(cacheKey, async () => {
            const client = http();
            const a = key ? authFor(key) : { headers: {} as Record<string, string> };
            const baseParams: any = { language: 'zh-CN', ...(a.queryKey ? { api_key: a.queryKey } : {}) };
            // 候选年份接近度：首播/上映年 与 fnOS 年之差的绝对值；无年份参考不惩罚，缺年份候选给中等惩罚(4)
            // [lc-947] 多策略标题搜索(全角标点转半角 + 递进缩短)，年份接近度优选在 tmdbSearchBest 内完成
            const top = await tmdbSearchBest(client, baseParams, mt, title, opts.year);
            if (!top) return { genres: [] as string[], rating: 0, votes: 0 };
            const id = top.raw.id;
            const dResp = await getWithRetry(client, `/${mt}/${id}`, { params: baseParams });
            const genres = ((dResp?.data?.genres) || []).map((g: any) => g.name).filter((x: any) => !!x);
            // 评分顺带取自搜索结果首条（与类型标签同一次 TMDB 调用，零额外配额）：
            //   vote_average = TMDB 评分(0~10)；vote_count = 参评人数。
            const rating = typeof top.raw.vote_average === 'number' ? top.raw.vote_average : 0;
            const votes = typeof top.raw.vote_count === 'number' ? top.raw.vote_count : 0;
            // 剧集完结状态：TMDB /tv/{id} 详情的 status 字段（Ended/Returning Series/Canceled…），
            // 与类型标签同一次详情调用取得，零额外配额；电影无此字段→undefined。
            const status = (mt === 'tv' && dResp?.data?.status) ? String(dResp.data.status) : undefined;
            return { genres: genres as string[], rating, votes, status };
        }, DEFAULT_TTL_MS, false);
        const genres = (r.data && r.data.genres) || [];
        let category: string;
        if (mt === 'movie') category = '电影';
        else {
            const isAnime = genres.some((g: string) => /动画|动漫|Animation|Anime/i.test(g));
            category = isAnime ? '动漫' : '剧集';
        }
        return { genres, category, rating: (r.data && r.data.rating) || 0, votes: (r.data && r.data.votes) || 0, status: r.data?.status };
    } catch (e: any) {
        log.warn('[TMDB诊断] genres 获取失败（' + title + '）：' + (e?.message || e));
        return null;
    }
}

/** 季页「剧集信息」详情缓存版本：字段结构变动时 +1，使旧缓存失效、强制重拉。
 *  v2(lc-988)：normalizeShow 新增 type / nextEpisode / lastEpisode / certifications / originalLanguage /
 *  facebook / recommendations / designers，countries 由 ISO 码统一为带名字的形态；
 *  并修了四处「字段一直存在但值恒为空」的真缺陷（均经直接打 TMDB API 实证）：
 *    ① 缺 include_image_language → append 回来的 images 被 language=zh-CN 过滤成 0 张，剧照永远没有；
 *    ② crewByJob 只匹配好莱坞职位名 → 动画/日剧的 Series Director / Original Story 全落空，主创永远空白；
 *    ③ aggregate_credits.crew 的职位在 jobs[] 数组而非 job 字段 → 回退路径一个人都取不到；
 *    ④ watch/providers 里字段叫 provider_name 而不是 name → namesOf 默认取 name 恒得空数组，
 *      「在线看」一行从来没显示过（实测 KR.flatrate[0] = {provider_id:8, provider_name:"Netflix"}）。
 *  TTL 是 10 年，不 bump 老缓存永不刷新（磁盘上现存 16 个 show_v1_* 文件全部会作废重拉）。 */
const TMDB_SHOW_CACHE_VER = 2;
/** 剧集信息缓存有效期 ≈ 永久（10 年）。用户要求「第一次打开对应剧集才获取一次」，
 *  之后只读本地磁盘缓存；只有点卡片上的「刷新」按钮（force=true）才重新拉取。 */
const TMDB_SHOW_TTL_MS = 3650 * 24 * 60 * 60 * 1000;

/** 取数组里每个对象的 name 字段，去重去空 */
function namesOf(list: any, field = 'name'): string[] {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of list) {
        const v = it && it[field];
        if (typeof v === 'string' && v.trim() && !seen.has(v)) { seen.add(v); out.push(v.trim()); }
    }
    return out;
}

/** 从 crew 里按职位取人名（去重）。
 *  ⚠ 实证修正(lc-988, 直接打 TMDB API 量到)：
 *   ① 职位名必须传**别名组**而不是单个精确值。旧写法 crewByJob(crew,'Director') 对动画/日剧恒为空——
 *     tv/297826(盗墓王) 的 credits.crew 实际职位是 Series Director / Original Story / Character Designer /
 *     Animation Director / Art Direction / Color Designer，tv/274671 还有 Series Composition / Music Producer，
 *     一个都不等于 'Director'/'Writer'/'Original Music Composer'/'Producer' → 主创区永远空白。
 *   ② 必须同时读 c.job 与 c.jobs[].job。credits.crew 成员带 job(字符串)；
 *     aggregate_credits.crew 成员**没有 job**，职位在 jobs:[{job,episode_count}] 数组里
 *     (实测 tv/297826 的 aggregate crew 首条 = {jobs:[{job:"Art Direction"}], department:"Art"})。
 *     旧写法只读 c.job → 一旦回退到 aggregate_credits 就一个人都取不到。 */
function crewByJob(crew: any[], job: string | readonly string[]): string[] {
    if (!Array.isArray(crew)) return [];
    const want = new Set<string>(
        (Array.isArray(job) ? [...job] : [job]).map((j) => String(j || '').trim()).filter(Boolean));
    if (!want.size) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of crew) {
        if (!c) continue;
        const jobs: string[] = typeof c.job === 'string' ? [c.job] : [];
        if (Array.isArray(c.jobs)) for (const j of c.jobs) if (j && typeof j.job === 'string') jobs.push(j.job);
        if (!jobs.some((j) => want.has(j.trim()))) continue;
        const n = typeof c.name === 'string' ? c.name.trim() : '';
        if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

/** 主创各行的 TMDB 职位别名组。
 *  清单不是凭空列的 —— 取自 lc-988 实测的两部真实动画：
 *    tv/297826(盗墓王) credits.crew 职位 = Original Story / Series Director / Character Designer /
 *      Animation Director×2 / Art Direction / Color Designer，created_by 为空；
 *    tv/274671 credits.crew(24 条) 另含 Series Composition / Original Music Composer / Music Producer /
 *      Production Supervisor / Executive Producer×12 / Producer×3。
 *  只写 'Director'/'Writer' 这类好莱坞职位名会全数落空，故每个语义行都收全别名。
 *  「设计」行专收动画/美术部门职位(角色设计・作画监督・色彩设计・美术指导)，
 *    这些在 TMDB 里分属 Visual Effects / Art 两个 department，中文语境下统称设计类主创。 */
const CREW_JOBS = {
    director: ['Director', 'Series Director', 'Co-Director', 'Assistant Director', 'Episode Director'],
    writer: ['Writer', 'Screenplay', 'Story', 'Original Story', 'Series Composition', 'Scenario Writer',
        'Script Editor', 'Novel', 'Comic Book', 'Head Writer', 'Storyboard'],
    composer: ['Original Music Composer', 'Music Director', 'Music Producer', 'Music', 'Theme Song Performance',
        'Sound Director'],
    producer: ['Producer', 'Executive Producer', 'Co-Producer', 'Co-Executive Producer', 'Line Producer',
        'Supervising Producer', 'Animation Producer', 'Production Supervisor', 'Associate Producer'],
    designer: ['Character Designer', 'Chief Animation Director', 'Animation Director', 'Color Designer',
        'Art Direction', 'Production Design', 'Art Department Coordinator', 'Background Designer',
        'Set Decoration', 'Costume Design', 'VFX Supervisor', '3D Director', 'CGI Director'],
} as const;

function titleSlug(title: string): string {
    return crypto.createHash('md5').update(String(title || '')).digest('hex').slice(0, 12);
}

function yearOfAny(date: any): string {
    return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : '';
}

/** [lc-947] 长 Descriptive 中文标题(如「转学后班上的清纯可爱美少女，竟是小时候玩在一起的哥们儿」)
 *  TMDB /search 对过长的整句标题匹配很差。生成递进缩短的候选查询：
 *   1) 按中/英文标点切分取首段(去掉描述性后缀，如「，竟是…」) —— 首段即核心剧名；
 *   2) 长度递进截断(16/12/8 字)兜底，匹配核心词。 */
function buildRelaxedTitles(title: string): string[] {
    const out: string[] = [];
    const segs = title.split(/[，,、；;：:！!？?。.\s…—\-]/).map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) {
        out.push(segs[0]);
        if (segs.length >= 2 && segs[0].length + segs[1].length <= 20) out.push(segs[0] + segs[1]);
    }
    for (const n of [16, 12, 8]) {
        if (title.length > n) {
            const t = title.slice(0, n).trim();
            if (t && !out.includes(t)) out.push(t);
        }
    }
    return out;
}

/** [lc-947] 按标题在 TMDB 搜索并挑最佳匹配。多策略查询避免长 Descriptive 中文标题匹配失败：
 *  ① 全角标点转半角(修「X，Y」vs TMDB「X,Y」因标点形态不同整句匹配失败)；
 *  ② 全文；③ 递进缩短(去描述性后缀/截断)兜底。
 *  year 用于年份接近度优选；无 year 时取搜索引擎返回的首条(已按相关度排序)。返回 {id, raw} 或 null。 */
async function tmdbSearchBest(
    client: AxiosInstance, baseParams: any, mt: 'tv' | 'movie',
    title: string, year?: string
): Promise<{ id: number; raw: any } | null> {
    const normPunct = (s: string): string => s
        .replace(/[，、；：！？—…・･]/g, (c) => (
            { '，': ',', '、': ',', '；': ';', '：': ':', '！': '!', '？': '?', '—': '-', '…': '...', '・': '·', '･': '·' } as Record<string, string>
        )[c] || c)
        .replace(/　/g, ' ');
    const doSearch = async (q: string, y?: string): Promise<any[]> => {
        const p: any = { ...baseParams, query: q, page: 1 };
        if (y) { if (mt === 'movie') p.year = y; else p.first_air_date_year = y; }
        const r = await getWithRetry(client, `/search/${mt}`, { params: p });
        return (r?.data?.results || []) as any[];
    };
    const tryQuery = async (q: string): Promise<any[]> => {
        const a = await doSearch(q, year);
        if (a.length) return a;
        return await doSearch(q, undefined);
    };
    const queries: string[] = [];
    const norm = normPunct(title);
    if (norm !== title) queries.push(norm);
    queries.push(title);
    for (const q of buildRelaxedTitles(title)) {
        if (q !== title && q !== norm && !queries.includes(q)) queries.push(q);
    }
    let all: any[] = [];
    for (const q of queries) {
        const r = await tryQuery(q);
        if (r.length) { all = r; log.info('[TMDB][lc-947] 搜索命中 q=' + JSON.stringify(q) + ' results=' + r.length); break; }
    }
    if (!all.length) { log.warn('[TMDB][lc-947] 搜索无果 title=' + JSON.stringify(title)); return null; }
    const y = parseInt(String(year || '').slice(0, 4), 10);
    const yearGap = (r: any): number => {
        if (isNaN(y)) return 0;
        const rd = (mt === 'movie' ? r.release_date : r.first_air_date) || '';
        const ry = parseInt(String(rd).slice(0, 4), 10);
        return isNaN(ry) ? 4 : Math.abs(ry - y);
    };
    let best = all[0]; let bestGap = yearGap(best);
    for (const r of all) { const g = yearGap(r); if (g < bestGap) { bestGap = g; best = r; } }
    return best && best.id != null ? { id: Number(best.id), raw: best } : null;
}

/**
 * 解析 TMDB 条目 id：优先用 fnOS 元数据里带的 tmdbId；没有则按标题(+年份)搜索，
 * 复用 tmdbSearchBest（[lc-947] 多策略查询 + 年份接近度挑选），避免同名不同剧误匹配。
 */
async function resolveShowId(
    client: AxiosInstance, baseParams: any, mt: 'tv' | 'movie',
    arg: { tmdbId?: string | number; title?: string; year?: string }
): Promise<number | null> {
    if (arg.tmdbId != null && /^\d+$/.test(String(arg.tmdbId).trim())) {
        return parseInt(String(arg.tmdbId).trim(), 10);
    }
    let title = (arg.title || '').trim();
    // [lc-945] 去掉标题尾部「第N季 / Season N / S01」等季号，避免污染 TMDB 搜索(季号由 seasonNumber 单独传)
    title = title.replace(/\s*(第\s*[0-9一二三四五六七八九十百]+\s*季|season\s*\d{1,3}|s\s*\d{1,3})\s*$/i, '').trim();
    if (!title) return null;
    const best = await tmdbSearchBest(client, baseParams, mt, title, arg.year);
    return best ? best.id : null;
}

/** 归一化 TMDB 详情 + append_to_response 的多个子响应为「剧集信息」渲染所需的扁平结构 */
function normalizeShow(d: any, mt: 'tv' | 'movie', id: number, season: any): any {
    const title = (mt === 'movie' ? (d.title || d.original_title) : (d.name || d.original_name)) || '';
    const original = (mt === 'movie' ? d.original_title : d.original_name) || '';
    const airDate = mt === 'movie' ? d.release_date : d.first_air_date;
    const agg = d.aggregate_credits || {};
    const crew: any[] = Array.isArray(d.credits?.crew) ? d.credits.crew : (Array.isArray(agg.crew) ? agg.crew : []);
    const castRaw: any[] = Array.isArray(agg.cast) && agg.cast.length
        ? agg.cast
        : (Array.isArray(d.credits?.cast) ? d.credits.cast : []);
    const cast = castRaw.slice(0, 20).map((c: any) => ({
        name: c.name || '',
        character: c.character || (Array.isArray(c.roles) && c.roles[0] ? c.roles[0].character : '') || '',
        profile: c.profile_path || '',
        order: typeof c.order === 'number' ? c.order : 999,
    })).sort((a: any, b: any) => a.order - b.order);
    // 集数 / 时长：tv 用 episode_run_time(数组) + number_of_episodes；movie 用 runtime
    const runtimes: number[] = Array.isArray(d.episode_run_time) ? d.episode_run_time.filter((n: any) => typeof n === 'number' && n > 0) : [];
    if (!runtimes.length && mt === 'movie' && typeof d.runtime === 'number' && d.runtime > 0) runtimes.push(d.runtime);
    const runtimeAvg = runtimes.length ? Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length) : 0;
    // 分级：tv → content_ratings；movie → release_dates。主值仍取 US（与既有渲染兼容），
    //   另收全地区列表：同一部剧各地区分级不同（US=TV-MA / JP=13 / KR=15…），信息卡可一并展示。
    let certification = '';
    const certifications: { region: string; rating: string }[] = [];
    if (mt === 'tv') {
        const cr = Array.isArray(d.content_ratings?.results) ? d.content_ratings.results : [];
        const us = cr.find((r: any) => r.iso_3166_1 === 'US') || cr[0];
        certification = us?.rating || '';
        for (const r of cr) {
            if (r && typeof r.iso_3166_1 === 'string' && r.rating) certifications.push({ region: r.iso_3166_1, rating: String(r.rating) });
        }
    } else {
        const rd = Array.isArray(d.release_dates?.results) ? d.release_dates.results : [];
        const us = rd.find((r: any) => r.iso_3166_1 === 'US');
        certification = us?.release_dates?.[0]?.certification || '';
        for (const r of rd) {
            const c = r?.release_dates?.[0]?.certification;
            if (r && typeof r.iso_3166_1 === 'string' && c) certifications.push({ region: r.iso_3166_1, rating: String(c) });
        }
    }
    // 上一集 / 下一集：tv 详情自带 last_episode_to_air / next_episode_to_air（连载中时「下一集」价值最高）
    const epBrief = (e: any): any => {
        if (!e || e.id == null) return null;
        return {
            seasonNumber: typeof e.season_number === 'number' ? e.season_number : 0,
            episodeNumber: typeof e.episode_number === 'number' ? e.episode_number : 0,
            name: e.name || '',
            airDate: e.air_date || '',
            overview: e.overview || '',
            runtime: typeof e.runtime === 'number' ? e.runtime : 0,
            voteAverage: typeof e.vote_average === 'number' ? e.vote_average : 0,
            stillPath: typeof e.still_path === 'string' ? e.still_path : '',
        };
    };
    // 相似剧集：走同一次 append_to_response，零额外网络请求
    const recRaw = Array.isArray(d.recommendations?.results) ? d.recommendations.results : [];
    const recommendations = recRaw
        .map((r: any) => ({
            tmdbId: r?.id,
            title: String((mt === 'movie' ? (r?.title || r?.original_title) : (r?.name || r?.original_name)) || ''),
            year: yearOfAny(mt === 'movie' ? r?.release_date : r?.first_air_date),
            url: r?.id != null ? `https://www.themoviedb.org/${mt}/${r.id}` : '',
        }))
        .filter((r: any) => r.tmdbId != null && r.title)
        .slice(0, 8);
    // 预告片：优先 YouTube 官方 Trailer
    const vids = Array.isArray(d.videos?.results) ? d.videos.results : [];
    const trailer = vids.find((v: any) => v.site === 'YouTube' && v.type === 'Trailer')
        || vids.find((v: any) => v.site === 'YouTube') || null;
    // 别名：tv 用 results、movie 用 titles
    const altRaw = mt === 'tv' ? d.alternative_titles?.results : d.alternative_titles?.titles;
    const aliases = namesOf(altRaw, 'title').filter((t) => t && t !== title && t !== original).slice(0, 8);
    // 播放平台：watch/providers 的 flatrate（订阅流媒体）。
    //   旧写法 `wp.CN || wp.HK || wp.TW || wp.US` 只取第一个存在的地区 → 漏掉其它地区的平台；改为六区合并去重。
    const wp = d['watch/providers']?.results || {};
    const provSeen = new Set<string>();
    const cnProviders: string[] = [];
    for (const region of ['CN', 'HK', 'TW', 'JP', 'KR', 'US']) {
        // ⚠ 字段名是 provider_name 而不是 name（lc-988 实测：KR.flatrate[0] =
        //   {logo_path, provider_id:8, provider_name:"Netflix", display_priority:0}）。
        //   namesOf 默认取 name → 旧写法在这里恒返回空数组，「在线看」一行从来没显示过。
        for (const n of namesOf((wp[region] || {}).flatrate, 'provider_name')) {
            // 广告档是同一服务的重复条目（实测盗墓王 KR 给了 Netflix + Netflix Standard with Ads，
            // JP 给了 Amazon Prime Video + Amazon Prime Video with Ads）→ 只保留正档。
            if (/ with Ads$/i.test(n)) continue;
            if (!provSeen.has(n)) { provSeen.add(n); cnProviders.push(n); }
        }
    }
    // 关键词
    const kwRaw = mt === 'tv' ? d.keywords?.results : d.keywords?.keywords;
    const keywords = namesOf(kwRaw).slice(0, 16);
    // 图：海报 / 背景（只存路径，真实图片由 tmdb:image 代理转 dataURL）
    const posterPath = typeof d.poster_path === 'string' ? d.poster_path : '';
    const backdropPath = typeof d.backdrop_path === 'string' ? d.backdrop_path : '';
    // 剧照排序：TMDB 返回的 backdrops 是乱序的，按 vote_average 降序取社区评价最高的几张；
    //   排除 backdropPath（页面已把它当全屏底图用，实测盗墓王投票最高的两张里就有它 → 会重复出现）；
    //   滤掉宽度 < 400 的小图（16:9 缩到右栏三分之一仍需清晰度）。
    const backdrops = (Array.isArray(d.images?.backdrops) ? d.images.backdrops : [])
        .filter((b: any) => b && typeof b.file_path === 'string' && b.file_path && b.file_path !== backdropPath
            && (typeof b.width !== 'number' || b.width >= 400))
        .sort((x: any, y: any) => (Number(y?.vote_average) || 0) - (Number(x?.vote_average) || 0))
        .map((b: any) => b.file_path as string)
        .slice(0, 6);

    return {
        tmdbId: id,
        mediaType: mt,
        url: `https://www.themoviedb.org/${mt}/${id}`,
        title,
        originalTitle: original,
        tagline: d.tagline || '',
        overview: d.overview || '',
        year: yearOfAny(airDate),
        airDate: airDate || '',
        lastAirDate: d.last_air_date || '',
        status: d.status || '',
        inProduction: !!d.in_production,
        seasons: typeof d.number_of_seasons === 'number' ? d.number_of_seasons : 0,
        episodes: typeof d.number_of_episodes === 'number' ? d.number_of_episodes : 0,
        runtimeAvg,
        runtimeMin: runtimes.length ? Math.min(...runtimes) : 0,
        runtimeMax: runtimes.length ? Math.max(...runtimes) : 0,
        genres: namesOf(d.genres),
        // 剧集形式（tv 专有：Scripted / Reality / Talk / Documentary…）与原始语言
        showType: typeof d.type === 'string' ? d.type : '',
        originalLanguage: typeof d.original_language === 'string' ? d.original_language : '',
        // 地区：tv 与 movie 的 production_countries 都是 [{iso_3166_1,name}]，统一取名字。
        //   lc-985 弃用地区正是因为旧写法 tv 取 origin_country 得到 ISO 码「JP」、movie 取英文名「Japan」，
        //   两种形态在中文界面里不一致；另存 countryCodes 供前端映射成中文国名（TMDB 的 name 不随 language 翻译）。
        countries: namesOf(d.production_countries).slice(0, 6),
        countryCodes: (Array.isArray(d.origin_country)
            ? d.origin_country.filter((x: any) => typeof x === 'string' && x)
            : []) as string[],
        languages: (Array.isArray(d.spoken_languages) ? d.spoken_languages : [])
            .map((l: any) => l?.english_name || l?.name || '').filter(Boolean).slice(0, 8),
        networks: namesOf(d.networks),
        companies: namesOf(d.production_companies).slice(0, 8),
        createdBy: namesOf(d.created_by).slice(0, 6),
        // 职位一律走 CREW_JOBS 别名组：实测 tv/297826 只有 Series Director / Original Story 等别名，
        // 旧的 crewByJob(crew,'Director') 四行全空，主创区从来不显示任何人。
        directors: crewByJob(crew, CREW_JOBS.director).slice(0, 6),
        writers: crewByJob(crew, CREW_JOBS.writer).slice(0, 8),
        composers: crewByJob(crew, CREW_JOBS.composer).slice(0, 4),
        producers: crewByJob(crew, CREW_JOBS.producer).slice(0, 6),
        designers: crewByJob(crew, CREW_JOBS.designer).slice(0, 6),
        cast,
        rating: typeof d.vote_average === 'number' ? d.vote_average : 0,
        votes: typeof d.vote_count === 'number' ? d.vote_count : 0,
        popularity: typeof d.popularity === 'number' ? d.popularity : 0,
        certification,
        certifications,
        // 语言 ISO 码：TMDB 的 english_name 在中文界面里显示成「Korean」，前端用码表映射成「韩语」
        languageCodes: (Array.isArray(d.spoken_languages) ? d.spoken_languages : [])
            .map((l: any) => (typeof l?.iso_639_1 === 'string' ? l.iso_639_1 : '')).filter(Boolean).slice(0, 8),
        homepage: d.homepage || '',
        externalIds: {
            // tv 详情的 external_ids 偶有缺失，顶层 imdb_id 是同一份数据的另一个出口 → 回退
            imdb: d.external_ids?.imdb_id || d.imdb_id || '',
            tvdb: d.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : '',
            wikidata: d.external_ids?.wikidata_id || '',
            instagram: d.external_ids?.instagram_id || '',
            twitter: d.external_ids?.twitter_id || '',
            facebook: d.external_ids?.facebook_id || '',
        },
        trailerKey: trailer?.key || '',
        trailerName: trailer?.name || '',
        posterPath,
        backdropPath,
        backdrops,
        keywords,
        aliases,
        providers: cnProviders.slice(0, 8),
        recommendations,
        lastEpisode: epBrief(d.last_episode_to_air),
        nextEpisode: epBrief(d.next_episode_to_air),
        season: season || null,
    };
}

function normalizeSeason(s: any, seasonNumber: number): any {
    if (!s || !s.id) return null;
    return {
        seasonNumber,
        name: s.name || '',
        overview: s.overview || '',
        airDate: s.air_date || '',
        episodeCount: (Array.isArray(s.episodes) ? s.episodes.length : (typeof s.episodes === 'number' ? s.episodes : 0)),
        posterPath: typeof s.poster_path === 'string' ? s.poster_path : '',
        voteAverage: typeof s.vote_average === 'number' ? s.vote_average : 0,
        voteCount: typeof s.vote_count === 'number' ? s.vote_count : 0,
    };
}

/**
 * 拉取单部影视的【完整详情】（季页「剧集信息」卡使用）。
 * 一次主请求 + append_to_response 合并取回演职员 / 外链 / 关键词 / 分级 / 别名 / 图片 / 预告 / 播放平台，
 * 季页再补一次 /tv/{id}/season/{n} 取本季集数与首播日。
 */
async function fetchShowDetails(arg: {
    tmdbId?: string | number; title?: string; year?: string;
    mediaType?: 'tv' | 'movie'; seasonNumber?: number | null;
}): Promise<{ ok: boolean; data?: any; error?: string }> {
    const key = fnConfig.getTmdbApiKey();
    if (!key) return { ok: false, error: '未配置 TMDB API Key，请在设置面板填写。' };
    const mt: 'tv' | 'movie' = arg.mediaType === 'movie' ? 'movie' : 'tv';
    try {
        const client = http();
        const a = authFor(key);
        const baseParams: any = { language: 'zh-CN', ...(a.queryKey ? { api_key: a.queryKey } : {}) };
        const id = await resolveShowId(client, baseParams, mt, arg);
        if (!id) return { ok: false, error: 'TMDB 未找到匹配条目：' + (arg.title || arg.tmdbId || '(无标题)') };
        const append = mt === 'tv'
            ? 'aggregate_credits,credits,external_ids,keywords,content_ratings,alternative_titles,images,videos,watch/providers,recommendations'
            : 'credits,external_ids,keywords,alternative_titles,images,videos,release_dates,watch/providers,recommendations';
        // ⚠ include_image_language 不可省（lc-988 实测）：baseParams 带 language=zh-CN 时，TMDB 会把
        //   append 回来的 images 子响应**按语言过滤**，而 backdrop 的 iso_639_1 多为 null/en →
        //   tv/297826 直接量到 backdrops=0 posters=0 logos=0（剧照节因此永远不渲染）。
        //   加上 include_image_language=zh-CN,en,null 后同一请求 backdrops=6 posters=7 logos=3。
        //   它只作用于 images 子响应，标题/简介等的中文翻译仍由 language 决定，两者不冲突。
        const detailParams: any = { ...baseParams, append_to_response: append, include_image_language: 'zh-CN,en,null' };
        const dResp = await getWithRetry(client, `/${mt}/${id}`, { params: detailParams });
        let season: any = null;
        if (mt === 'tv' && typeof arg.seasonNumber === 'number' && arg.seasonNumber >= 0) {
            try {
                const sResp = await getWithRetry(client, `/tv/${id}/season/${arg.seasonNumber}`, { params: baseParams });
                season = normalizeSeason(sResp?.data || null, arg.seasonNumber);
            } catch (e: any) {
                log.warn('[TMDB] 季详情获取失败（season=' + arg.seasonNumber + '）：' + String(e?.message || e));
            }
        }
        log.info('[TMDB] 详情获取成功：' + mt + '/' + id + ' ' + (arg.title || '') + (season ? (' 含第' + arg.seasonNumber + '季') : ''));
        return { ok: true, data: normalizeShow(dResp?.data || {}, mt, id, season) };
    } catch (e: any) {
        log.warn('[TMDB] 详情获取失败（' + (arg.title || arg.tmdbId || '') + '）：' + dumpErr(e));
        return { ok: false, error: describeTmdbError(e) };
    }
}

function init(): void {
    // [lc-765] 清理旧版本剧集类型缓存文件（非当前版本键），避免与新版本键共存造成混淆/脏数据
    try {
        const dir = path.join(app.getPath('userData'), 'cache');
        if (fs.existsSync(dir)) {
            const keep = new RegExp('^genres_v' + TMDB_GENRES_CACHE_VER + '_');
            for (const f of fs.readdirSync(dir)) {
                if (/^genres_/.test(f) && !keep.test(f)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略单个删除失败 */ }
                }
            }
        }
    } catch { /* 忽略目录读取失败 */ }
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
    // [lc-926] 季页「剧集信息」：一次取回完整详情（详情 + 演职员 + 外链 + 关键词 + 分级 + 别名 + 图 + 预告 + 平台 + 本季信息）。
    //   缓存 ≈ 永久（10 年）：同一部剧只在第一次打开时真正请求 TMDB，之后一律读本地磁盘缓存；
    //   只有用户在卡片上点「刷新」（force=true）才重拉。返回 fetchedAt 供前端显示「更新于 …」。
    registerHandler('tmdb:show', async (_e: any, arg: {
        tmdbId?: string | number; title?: string; year?: string;
        mediaType?: 'tv' | 'movie'; seasonNumber?: number | null; force?: boolean;
    }) => {
        const mt = arg?.mediaType === 'movie' ? 'movie' : 'tv';
        const idPart = (arg?.tmdbId != null && /^\d+$/.test(String(arg.tmdbId).trim()))
            ? ('id' + String(arg.tmdbId).trim())
            : ('t' + titleSlug(arg?.title || ''));
        const key = 'show_v' + TMDB_SHOW_CACHE_VER + '_' + mt + '_' + idPart + '_s' + (arg?.seasonNumber ?? 'x');
        try {
            const r = await getDailyCached(key, async () => {
                const res = await fetchShowDetails({
                    tmdbId: arg?.tmdbId, title: arg?.title, year: arg?.year,
                    mediaType: mt, seasonNumber: arg?.seasonNumber ?? null,
                });
                if (!res.ok) throw new Error(res.error || '详情获取失败');
                return res.data;
            }, TMDB_SHOW_TTL_MS, !!arg?.force);
            log.info('[TMDB] 剧集信息' + (r.fromCache ? '来自磁盘缓存(未请求TMDB)' : '已向TMDB刷新') + ' key=' + key);
            return { ok: true, data: r.data, fetchedAt: r.fetchedAt, fromCache: r.fromCache };
        } catch (e: any) {
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
