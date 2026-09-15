import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import * as https from 'https';
import axios, { AxiosInstance } from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import * as proxyModule from '../../../modules/proxyAgent';
import * as logger from '../../../modules/logger';
import * as types from '../../../modules/fn_api/types';
import { registerHandler } from '../core/ipcHandler';
import { getDailyCached, DEFAULT_TTL_MS } from '../../common/dailyCache';

const log = logger.component('bangumi');

/**
 * Bangumi 集数级同步插件（观看进度 → Bangumi「该集看过」）
 *
 * 与豆瓣同步的区别：豆瓣只能标整部「看过/在看」，Bangumi 可精确到单集。
 *
 * 数据流：
 *   播放进度达阈值(默认80%) → 按 tv_title 搜 Bangumi 拿 subject_id（缓存）
 *   → 取剧集列表找 ep==episode_number 的 episode_id（缓存）
 *   → 先 POST 条目收藏{type:3}在看（标集前必须先收藏，否则 400）
 *   → PUT 单集{type:2}看过
 *   → 若为最后一集或飞牛 is_watched===1 → POST 条目{type:2}看过
 *
 * - 认证：Authorization: Bearer {bangumiToken}（设置面板配置，需 write:collection scope）
 * - UA：开源+分发项目，按官方要求带「开发者ID/应用名 + 版本号 + 项目主页」
 * - 飞牛元数据无 bangumi_id（同 douban_id 恒 0），故按标题搜索映射
 * - 全程非阻塞、节流去重，绝不影响播放
 */

const BANGUMI_API = 'https://api.bgm.tv';

// ===== 「免梯子直连」对 Bangumi 域名的支持（仅此国外源 + TMDB 受该开关影响；豆瓣国内直连不管） =====
// 国内系统 DNS 对 api.bgm.tv 一般可直连，但部分网络环境会被污染/劫持；
// 开启「免梯子直连」时改用国内可信公共 DNS 解析 Bangumi 域名，绕过系统 DNS 干扰。
// 与 TMDB 不同：Bangumi 未被解析到假 IP，故无需精确 IP 快照，公共 DNS 即可拿到真实边缘 IP。
const PUBLIC_DNS_SERVERS = ['223.5.5.5', '119.29.29.29']; // 阿里 / 腾讯 公共 DNS（国内快且稳）
const BGM_DNS_TTL = 10 * 60 * 1000; // 解析结果缓存 10 分钟，避免每次请求都查公共 DNS
const _bgmDnsCache = new Map<string, { ip: string; ts: number }>();

function isBangumiHost(hostname: string): boolean {
    return /(^|\.)bgm\.tv$/.test(hostname);
}

async function resolveBangumiPublic(hostname: string): Promise<string | null> {
    const cached = _bgmDnsCache.get(hostname);
    if (cached && Date.now() - cached.ts < BGM_DNS_TTL) return cached.ip;
    for (const s of PUBLIC_DNS_SERVERS) {
        try {
            const resolver = new dns.promises.Resolver();
            resolver.setServers([s]); // 用指定公共 DNS 解析（绕过系统 DNS 污染）
            const addrs = await Promise.race([
                resolver.resolve4(hostname),
                new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
            ]);
            if (addrs && addrs.length) {
                _bgmDnsCache.set(hostname, { ip: addrs[0], ts: Date.now() });
                return addrs[0];
            }
        } catch { /* 试下一个公共 DNS */ }
    }
    return null;
}

/**
 * 自定义 DNS lookup（回调式，与 TMDB 直连保持一致）：
 * Node/Electron 的 http(s).Agent 的 lookup 选项必须走回调 (hostname, options, callback)，
 * 不能返回 Promise——否则地址不会被交付给 socket，请求会静默失败（这正是之前每日放送
 * 一直走旧缓存、却谎称「未发网络请求」的根因）。
 * 命中 Bangumi 域名 → 公共 DNS 解析；其余 / 公共 DNS 失败 → 系统 DNS 兜底。
 */
function bangumiDirectLookup(): (hostname: string, opts: any, cb: any) => void {
    return (hostname: string, opts: any, cb: any) => {
        // Electron/Node 可能以 2 参 (hostname, callback) 或 3 参 (hostname, options, callback) 调用；
        // options 可能是对象 / 数字(family) / 省略，统一归一化，避免 cb 落到 undefined 上。
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        if (isBangumiHost(hostname)) {
            resolveBangumiPublic(hostname)
                .then((ip: string | null) => {
                    if (ip) {
                        log.info('[Bangumi直连] 公共DNS解析 ' + hostname + ' => ' + ip);
                        if (opts.all) return cb(null, [{ address: ip, family: 4 }]);
                        return cb(null, ip, 4);
                    }
                    // 公共 DNS 失败 → 系统 DNS 兜底
                    dns.lookup(hostname, opts, cb);
                })
                .catch(() => dns.lookup(hostname, opts, cb));
            return;
        }
        // 非 Bangumi 域名 → 系统 DNS
        dns.lookup(hostname, opts, cb);
    };
}

/** 开启「免梯子直连」时返回带自定义 DNS lookup 的 https agent；否则 undefined（走系统 DNS） */
function bangumiDirectAgent(): https.Agent | undefined {
    return fnConfig.getTmdbDirectConnect()
        ? new https.Agent({ lookup: bangumiDirectLookup(), keepAlive: false })
        : undefined;
}

/**
 * 统一注入传输方式（优先级：代理 > 免梯子直连DNS > 系统DNS）：
 *  1. 代理（环境变量 HTTPS_PROXY 或设置面板「自定义代理」）→ 走用户代理入口；
 *  2. 开启「免梯子直连」→ 公共 DNS 覆盖解析；
 *  3. 否则 → 系统 DNS 直连。
 * 代理与直连互斥：设了代理则 proxy:false 关闭 axios 自带代理逻辑，交给自定义 agent。
 */
function withTransport(cfg: any): any {
    const proxy = proxyModule.resolveProxyAgent();
    if (proxy) {
        cfg.httpsAgent = proxy;
        cfg.proxy = false;
        return cfg;
    }
    const direct = bangumiDirectAgent();
    if (direct) { cfg.httpsAgent = direct; cfg.proxy = false; }
    return cfg;
}

// 条目收藏类型：1=想看 2=看过 3=在看 4=搁置 5=抛弃
const SUBJECT_DOING = 3; // 在看
const SUBJECT_COLLECT = 2; // 看过
// 章节收藏类型：0=未 1=想看 2=看过
const EPISODE_WATCHED = 2;

/** Bangumi 官方要求：非浏览器请求须带开发者ID/应用名；开源项目附项目主页；分发应用附版本号 */
function bangumiUA(): string {
    let ver = 'unknown';
    try { ver = app.getVersion(); } catch (e) { /* 测试环境无 app */ }
    return `YDMY007/Fntv-Plus/${ver} (https://github.com/YDMY007/Fntv-Plus)`;
}

/** 带认证的 http 客户端（每次按当前 token 重建 header，token 变更即时生效） */
function http(): AxiosInstance {
    const token = fnConfig.getBangumiToken();
    const cfg: any = {
        baseURL: BANGUMI_API,
        timeout: 12000,
        headers: {
            'User-Agent': bangumiUA(),
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    };
    withTransport(cfg); // 注入传输方式（代理 > 免梯子直连DNS > 系统DNS；覆盖同步/取集简介等全部请求）
    return axios.create(cfg);
}

// ---- 缓存与节流 ----
// tv_title → subject_id（同剧跨集/跨会话只搜一次）
const subjectCache = new Map<string, number>();
// subject_id|ep_num → episode_id
const episodeCache = new Map<string, number>();
// 已标记看过的 itemGuid（避免每 tick 重复 PUT，幂等但费请求）
const markedSet = new Set<string>();
// 解析失败的 itemGuid（避免重复刷 WARN）
const missSet = new Set<string>();
// [lc-1169] 首播已成功标过条目「在看」的 itemGuid（内存节流，重启清零；失败不加入、下次进度事件重试）
const subjectDoingMarked = new Set<string>();

let _cacheFile = '';
try { _cacheFile = path.join(app.getPath('userData'), 'bangumi_subject_cache.json'); } catch (e) { _cacheFile = ''; }
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadCache(): void {
    if (!_cacheFile) return;
    try {
        if (fs.existsSync(_cacheFile)) {
            const obj = JSON.parse(fs.readFileSync(_cacheFile, 'utf8'));
            if (obj && typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    if (typeof v === 'number') subjectCache.set(k, v);
                }
            }
            log.info('已加载 subject 缓存', subjectCache.size, '条');
        }
    } catch (e: any) {
        log.warn('加载 subject 缓存失败', e && e.message);
    }
}

function scheduleSave(): void {
    if (_saveTimer || !_cacheFile) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            const obj: Record<string, number> = {};
            let n = 0;
            for (const [k, v] of subjectCache) { obj[k] = v; if (++n > 500) break; }
            fs.writeFileSync(_cacheFile, JSON.stringify(obj));
        } catch (e: any) {
            log.warn('保存 subject 缓存失败', e && e.message);
        }
    }, 3000);
}

// ---- Bangumi API 封装 ----

interface BgSubject { id: number; name: string; name_cn: string; type: number; eps: number; }
interface BgEpisode { id: number; ep: number; sort: number; name: string; name_cn: string; type: number; }

/** [lc-1173] 搜索原始请求。authFail=true 表示 HTTP 401/403（Token 失效/未授权），与「确认无结果」区分：
 *  axios 对 4xx 会 throw，旧代码把它和空结果一起静默吞掉，Token 失效时日志只说「无结果」误导排查。 */
async function searchSubjectRaw(keyword: string): Promise<{ items: BgSubject[]; authFail: boolean }> {
    try {
        const resp = await http().post('/v0/search/subjects?limit=10', {
            keyword,
            sort: 'match',
            filter: { type: [2, 6] }, // 2=动画 6=三次元(电视剧/真人)
        });
        return { items: (resp.data && resp.data.data) || [], authFail: false };
    } catch (e: any) {
        const status = e && e.response && e.response.status;
        if (status === 401 || status === 403) {
            log.warn(`搜索「${keyword}」被拒绝(HTTP ${status})：Bangumi Token 失效/未授权，请在设置面板重新生成并填入`);
            return { items: [], authFail: true };
        }
        log.warn(`搜索条目失败「${keyword}」:`, e && e.message);
        return { items: [], authFail: false };
    }
}

/** 标题归一化：去空白与常见中英标点、转小写 —— 供每日放送兜底的包含匹配 */
function normTitle(s: string): string {
    return String(s || '').toLowerCase().replace(/[\s·・:：,，。.．\-—_~～「」『』()（）\[\]【】']/g, '');
}

/**
 * [lc-1173] 每日放送兜底：Bangumi 搜索 API 对条目名不做模糊容错 —— 刮削标题与 Bangumi
 * 条目名稍有出入（实测「在超市后门吸烟的二人」vs 条目「…吸烟草的二人」）搜索即返回空。
 * 每日放送缓存覆盖当季全部新番/新档剧集（含正确的 name_cn，24h 磁盘缓存），归一化后
 * 双向包含即命中 —— 当季在追的番几乎必然在列，零额外网络请求。
 */
async function fallbackSubjectFromCalendar(keyword: string): Promise<number | null> {
    try {
        const r: any = await getDailyCached('bangumi_calendar', async () => {
            const res = await fetchCalendar();
            if (!res.ok) throw new Error(res.error || 'bangumi fetch failed');
            return res;
        }, DEFAULT_TTL_MS);
        const items: any[] = (r && r.data && r.data.items) || [];
        const nk = normTitle(keyword);
        if (!items.length || nk.length < 4) return null; // 过短的词误配风险高
        let best: any = null;
        let bestScore = -1;
        for (const it of items) {
            for (const nn of [normTitle(it.name_cn), normTitle(it.name)]) {
                if (!nn) continue;
                if (nn.includes(nk) || nk.includes(nn)) {
                    // 命中：长度差越小越可信（多命中时取最接近者）
                    const score = 1000 - Math.abs(nn.length - nk.length);
                    if (score > bestScore) { bestScore = score; best = it; }
                }
            }
        }
        if (best) {
            log.info(`[Bangumi] 搜索无结果，每日放送兜底命中 subject ${best.id}（${best.name_cn || best.name}）`);
            return best.id;
        }
        return null;
    } catch (e: any) {
        log.warn('[Bangumi] 每日放送兜底失败:', e && e.message);
        return null;
    }
}

/** 按标题搜索条目，返回最佳匹配的 subject_id（优先动画 type=2；eps 接近预期者） */
async function searchSubject(tvTitle: string, expectedEps: number): Promise<number | null> {
    const cached = subjectCache.get(tvTitle);
    if (cached) return cached;
    const { items } = await searchSubjectRaw(tvTitle);
    if (items.length === 0) {
        // [lc-1173] 搜索确认无结果 → 每日放送兜底（Bangumi 条目名与刮削标题常有出入）
        const fb = await fallbackSubjectFromCalendar(tvTitle);
        if (fb) {
            subjectCache.set(tvTitle, fb);
            scheduleSave();
            return fb;
        }
        log.warn(`搜索「${tvTitle}」无结果`);
        return null;
    }
    // 排序：优先 type=2(动画)；再按 eps 与预期差距小者；都没有 eps 信息则取首个
    const scored = items.map(s => ({
        s,
        score: (s.type === 2 ? 0 : 1) + (expectedEps > 0 && s.eps > 0 ? Math.abs(s.eps - expectedEps) * 0.01 : 1),
    }));
    scored.sort((a, b) => a.score - b.score);
    const best = scored[0].s;
    subjectCache.set(tvTitle, best.id);
    scheduleSave();
    log.info(`搜索「${tvTitle}」命中 subject ${best.id}（${best.name_cn || best.name}，type=${best.type}，eps=${best.eps}）`);
    return best.id;
}

/** 取条目的正篇剧集列表，找 ep==epNum 的 episode_id */
async function getEpisodeId(subjectId: number, epNum: number): Promise<number | null> {
    const key = `${subjectId}|${epNum}`;
    const cached = episodeCache.get(key);
    if (cached) return cached;
    try {
        const resp = await http().get('/v0/episodes', {
            params: { subject_id: subjectId, type: 0, limit: 200 }, // type=0 正篇
        });
        const eps: BgEpisode[] = (resp.data && resp.data.data) || [];
        // 优先 ep 字段精确匹配，其次 sort 字段
        let hit = eps.find(e => Number(e.ep) === epNum);
        if (!hit) hit = eps.find(e => Number(e.sort) === epNum);
        if (!hit) {
            log.warn(`subject ${subjectId} 未找到第 ${epNum} 集（共 ${eps.length} 集）`);
            return null;
        }
        episodeCache.set(key, hit.id);
        log.info(`subject ${subjectId} 第 ${epNum} 集 → episode_id ${hit.id}`);
        return hit.id;
    } catch (e: any) {
        log.warn(`取剧集列表失败 subject ${subjectId}:`, e && e.message);
        return null;
    }
}

/** 标记条目收藏状态（3=在看 / 2=看过），标集前必须先收藏 */
async function markSubject(subjectId: number, type: number): Promise<boolean> {
    try {
        const resp = await http().post(`/v0/users/-/collections/${subjectId}`, { type });
        log.info(`标记条目 ${subjectId} → type=${type}（${type === SUBJECT_DOING ? '在看' : '看过'}）status=${resp.status}`);
        return resp.status < 300;
    } catch (e: any) {
        log.warn(`标记条目失败 ${subjectId}:`, e && e.response && e.response.status, e && e.message);
        return false;
    }
}

/** 标记单集为看过（type=2）。须先收藏条目，否则 400 subject not collected */
async function markEpisodeWatched(episodeId: number): Promise<boolean> {
    try {
        const resp = await http().put(`/v0/users/-/collections/-/episodes/${episodeId}`, { type: EPISODE_WATCHED });
        log.info(`标记单集 ${episodeId} 看过 status=${resp.status}`);
        return resp.status < 300;
    } catch (e: any) {
        log.warn(`标记单集失败 ${episodeId}:`, e && e.response && e.response.status, e && e.message);
        return false;
    }
}

/**
 * 播放进度同步入口（由 media.ts PROGRESS 事件调用，非阻塞）。
 * 进度达阈值(默认80%) → 标该集看过 + 条目在看；末集/已看完 → 条目看过。
 */
export async function syncOnProgress(
    itemGuid: string,
    info: types.PlayInfo,
    percentage: number,
    _fnapi: any,
    _ts: number,
    duration: number,
): Promise<void> {
    try {
        // 开关与 token 检查
        if (!fnConfig.getBangumiSyncEnabled()) return;
        if (!fnConfig.getBangumiToken()) return;

        const item = info && info.item;
        // [lc-1169] 此前「缺 item / 缺标题集号」都静默 return，用户报「99% 看完没同步」却查无原因
        // —— 全部改为带日志退出，链路可观测。
        if (!item) {
            log.warn(`[Bangumi] 播放信息缺 item 字段，跳过本次同步 guid=${itemGuid.slice(0, 8)}`);
            return;
        }
        if (!types.isSyncableItemType(item.type)) {
            log.info(`[Bangumi] 媒体类型 "${item.type || 'null'}" 不在可同步范围(仅电影/电视节目/混合影片)，跳过 Bangumi 同步`);
            return;
        }

        // 电视剧有 tv_title+集号；电影(剧场版)只有标题 —— 用标题搜条目，条目级标记
        const tvTitle = item.tv_title || '';
        const epNum = item.episode_number || 0;
        const isEpisodic = !!(tvTitle && epNum >= 1);
        const searchTitle = tvTitle || item.title || '';
        const totalEps = item.number_of_episodes || 0;
        const isWatched = item.is_watched === 1;
        if (!searchTitle) {
            log.warn(`[Bangumi] item 无 tv_title 也无 title，无法搜索条目 guid=${itemGuid.slice(0, 8)}`);
            return;
        }

        // [lc-1173] 去重检查提前到首播之前：修复 lc-1169 的自相矛盾 —— 首播失败把 guid 加入
        // missSet，但 missSet 检查在其后，导致搜索每 15s 重跑一次 + WARN 刷屏（文案说不再重试）。
        if (markedSet.has(itemGuid)) return;
        if (missSet.has(itemGuid)) return;

        // [lc-1169] 首播即标条目「在看」（对齐豆瓣 syncOnProgress 的行为）：此前要等到 80% 阈值
        // 才连条目一起标，用户看一半退出后 Bangumi 上毫无痕迹。节流 = 每 guid 成功标一次；
        // mediaValid(duration>0) 排除开播前 0/0 空进度事件。
        // [lc-1173] 搜索失败（搜索+每日放送兜底均无结果）→ missSet，本会话该 guid 不再重试
        // （missSet 检查已提前，不会刷屏）；网络类失败与「在看」标记失败不加 missSet，下次进度重试。
        const mediaValid = duration > 0;
        if (mediaValid && !subjectDoingMarked.has(itemGuid)) {
            const subjectId = await searchSubject(searchTitle, totalEps);
            if (!subjectId) {
                missSet.add(itemGuid);
                log.warn(`[Bangumi] 无法定位「${searchTitle}」的条目（搜索+每日放送兜底均未命中），本会话跳过该集 guid=${itemGuid.slice(0, 8)}`);
                return;
            }
            const ok = await markSubject(subjectId, SUBJECT_DOING);
            if (ok) {
                subjectDoingMarked.add(itemGuid);
            } else {
                log.warn(`[Bangumi] 标「在看」失败（subject ${subjectId}），下次进度事件重试`);
                return;
            }
        }

        // 阈值检查：集级「看过」(电视剧) / 条目「看过」(电影) 仍按阈值(默认80%)
        const threshold = fnConfig.getBangumiSyncThreshold();
        if (percentage < threshold) return;

        // 去重：同一 itemGuid 已标记过则跳过
        if (markedSet.has(itemGuid)) return;
        if (missSet.has(itemGuid)) return;

        // 1. 搜条目拿 subject_id
        const subjectId = await searchSubject(searchTitle, totalEps);
        if (!subjectId) {
            missSet.add(itemGuid);
            return;
        }

        // 电影(剧场版/无集信息)：无 episode 可标，直接把条目标为「看过」。
        // 此前这条路径会静默穿过到 !epNum 检查被无声吞掉 —— 99% 看完也没同步的根因。
        if (!isEpisodic) {
            const ok = await markSubject(subjectId, SUBJECT_COLLECT);
            if (ok) {
                markedSet.add(itemGuid);
                log.info(`已同步：「${searchTitle}」（电影，进度 ${percentage}%）→ Bangumi 条目看过`);
            } else {
                missSet.add(itemGuid);
            }
            return;
        }

        // 2. 取 episode_id
        const episodeId = await getEpisodeId(subjectId, epNum);
        if (!episodeId) {
            missSet.add(itemGuid);
            return;
        }

        // 3. 条目「在看」已在首播阶段标过；这里再兜底一次（首播失败恢复的会话）
        await markSubject(subjectId, SUBJECT_DOING);

        // 4. 标该集看过
        const ok = await markEpisodeWatched(episodeId);
        if (!ok) {
            log.warn(`标记 ${tvTitle} 第 ${epNum} 集失败，本会话不再重试`);
            missSet.add(itemGuid);
            return;
        }
        markedSet.add(itemGuid);
        log.info(`已同步：${tvTitle} 第 ${epNum} 集 → Bangumi 看过`);

        // 5. 末集或飞牛已看完 → 条目标看过
        if ((totalEps > 0 && epNum >= totalEps) || isWatched) {
            await markSubject(subjectId, SUBJECT_COLLECT);
            log.info(`${tvTitle} 已完结，条目标记为看过`);
        }
    } catch (e: any) {
        log.error('Bangumi 同步异常:', e && e.message);
    }
}

// ---- 每集简介缓存（Bangumi → 选集卡片注入） ----
let _descCacheFile = '';
let _descCache: Record<string, Record<number, string>> = {}; // subject_id → { ep_num: desc }
let _descSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadDescCache(): void {
    try { _descCacheFile = path.join(app.getPath('userData'), 'bangumi_ep_descs.json'); } catch (e) { return; }
    try {
        if (fs.existsSync(_descCacheFile)) _descCache = JSON.parse(fs.readFileSync(_descCacheFile, 'utf-8')) || {};
    } catch (e) { /* 首次运行或文件损坏 */ }
}

function scheduleDescSave(): void {
    if (_descSaveTimer || !_descCacheFile) return;
    _descSaveTimer = setTimeout(() => {
        _descSaveTimer = null;
        try { fs.writeFileSync(_descCacheFile, JSON.stringify(_descCache)); } catch (e) {}
    }, 2000);
}

interface BgEpDesc { ep: number; name_cn: string; desc: string; }

/**
 * 从 Bangumi 获取某番剧的每集简介（desc 字段），带本地持久化缓存。
 * 返回 { subjectId, eps: [{ep, name_cn, desc}] } 或 null。
 * 缓存命中时不再请求网络；首次获取后自动持久化到 userData/bangumi_ep_descs.json。
 */
export async function fetchEpisodeDescs(tvTitle: string, totalEps: number): Promise<{ subjectId: number; eps: BgEpDesc[] } | null> {
    // 1. 搜条目（复用已有 searchSubject + subjectCache）
    const subjectId = await searchSubject(tvTitle, totalEps);
    if (!subjectId) return null;

    // 2. 检查内存缓存
    if (_descCache[subjectId] && Object.keys(_descCache[subjectId]).length > 0) {
        const cached = _descCache[subjectId];
        const eps: BgEpDesc[] = Object.entries(cached)
            .map(([ep, desc]) => ({ ep: Number(ep), name_cn: '', desc }))
            .sort((a, b) => a.ep - b.ep);
        return { subjectId, eps };
    }

    // 3. 网络取 episodes（含 desc）
    try {
        const resp = await http().get('/v0/episodes', {
            params: { subject_id: subjectId, type: 0, limit: 500 },
        });
        const rawEps: any[] = (resp.data && resp.data.data) || [];
        // 只取 type=0(正篇)，提取 ep + name_cn + desc
        const eps: BgEpDesc[] = rawEps
            .filter((e: any) => Number(e.type) === 0 && (e.desc || '').length > 0)
            .map((e: any) => ({
                ep: Number(e.ep) || Number(e.sort) || 0,
                name_cn: e.name_cn || e.name || '',
                desc: e.desc || '',
            }))
            .sort((a, b) => a.ep - b.ep);

        if (eps.length === 0) {
            log.info(`Bangumi subject ${subjectId} 无正篇简介数据(${rawEps.length} 条原始)`);
            return null;
        }

        // 4. 写入缓存（持久化）
        const entry: Record<number, string> = {};
        for (const e of eps) entry[e.ep] = e.desc;
        _descCache[subjectId] = entry;
        scheduleDescSave();
        log.info(`已获取 Bangumi ${subjectId} 每集简介 ${eps.length} 集，已缓存`);
        return { subjectId, eps };
    } catch (e: any) {
        log.warn(`取 Bangumi 每集简介失败 subject ${subjectId}:`, e && e.message);
        return null;
    }
}

// ---- 条目级元数据（[多源刮削] 季页「自定义刮削」按钮的数据源，三段式拉取） ----
// 拆成 搜索/条目信息/分集 三步的原因：渲染端按钮要「实时显示刮削状态」——单条 IPC 一把梭时,
// Bangumi 慢响应会让按钮干等十几秒(用户日志实证 12s 超时, 且期间毫无反馈被误以为刮削串台)。
// 每步独立 IPC + 独立内存缓存；单次请求 15s 超时、自动重试 1 次；两步齐了合并持久化到盘上。
export interface BgEpFull { ep: number; nameCn: string; name: string; desc: string; airdate: string; }
export interface BgSubjectDetail {
    subjectId: number;
    nameCn: string;
    name: string;
    summary: string;
    rating: number;
}
let _metaCacheFile = '';
const _metaCache: Record<string, any> = {}; // 合并持久化快照(subjectId → 全量)，供「先本地后网络」
const _metaDetailCache = new Map<number, BgSubjectDetail>();
const _metaEpsCache = new Map<number, BgEpFull[]>();
let _metaSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadMetaCache(): void {
    try { _metaCacheFile = path.join(app.getPath('userData'), 'bangumi_subject_meta.json'); } catch (e) { return; }
    try {
        if (fs.existsSync(_metaCacheFile)) {
            const obj = JSON.parse(fs.readFileSync(_metaCacheFile, 'utf-8')) || {};
            Object.assign(_metaCache, obj);
            for (const [k, v] of Object.entries(obj)) {
                const sid = Number(k);
                const m = v as any;
                if (!sid || !m || !Array.isArray(m.eps)) continue;
                _metaDetailCache.set(sid, {
                    subjectId: sid, nameCn: m.nameCn || '', name: m.name || '',
                    summary: m.summary || '', rating: m.rating || 0,
                });
                _metaEpsCache.set(sid, m.eps);
            }
        }
    } catch (e) { /* 首次运行或文件损坏 */ }
}

function scheduleMetaSave(): void {
    if (_metaSaveTimer || !_metaCacheFile) return;
    _metaSaveTimer = setTimeout(() => {
        _metaSaveTimer = null;
        try {
            const obj: Record<string, any> = {};
            for (const [sid, d] of _metaDetailCache) {
                const eps = _metaEpsCache.get(sid);
                if (eps) obj[String(sid)] = { ...d, eps };
            }
            fs.writeFileSync(_metaCacheFile, JSON.stringify(obj));
        } catch (e) {}
    }, 2000);
}

/** 错误归类（给渲染端转成中性按钮文案用；原始细节进日志） */
function metaErr(e: any): string {
    return String((e && e.message) || e);
}
function metaErrKind(e: any): string {
    return /timeout/i.test(String((e && e.message) || e)) ? 'timeout' : 'error';
}

/** GET with 自动重试（单次 15s 超时，失败隔 800ms 重试 1 次——Bangumi 偶发慢响应实测常见） */
async function bgmGetRetry(path: string, params?: any): Promise<any> {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await http().get(path, { params, timeout: 15000 });
        } catch (e: any) {
            lastErr = e;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
        }
    }
    throw lastErr;
}

/** ① 按标题匹配条目（复用 searchSubject 的盘上缓存；命中返回 subjectId） */
export async function searchSubjectId(tvTitle: string, totalEps: number): Promise<{ subjectId: number } | null> {
    const subjectId = await searchSubject(tvTitle, totalEps);
    return subjectId ? { subjectId } : null;
}

/** ② 条目信息（中文名/原名/简介/评分），内存缓存 */
export async function fetchSubjectDetail(subjectId: number): Promise<BgSubjectDetail> {
    const hit = _metaDetailCache.get(subjectId);
    if (hit) return hit;
    const resp = await bgmGetRetry('/v0/subjects/' + subjectId);
    const s = resp.data || {};
    const d: BgSubjectDetail = {
        subjectId,
        nameCn: s.name_cn || '',
        name: s.name || '',
        summary: s.summary || '',
        rating: (s.rating && s.rating.score) || 0,
    };
    _metaDetailCache.set(subjectId, d);
    persistMetaIfComplete(subjectId);
    return d;
}

/** ③ 分集数据（集号/中文标题/原文标题/简介/播出日期），内存缓存 */
export async function fetchSubjectEpisodes(subjectId: number): Promise<BgEpFull[]> {
    const hit = _metaEpsCache.get(subjectId);
    if (hit) return hit;
    const resp = await bgmGetRetry('/v0/episodes', { subject_id: subjectId, type: 0, limit: 500 });
    const rawEps: any[] = (resp.data && resp.data.data) || [];
    const eps: BgEpFull[] = rawEps
        .filter((e: any) => Number(e.type) === 0)
        .map((e: any) => ({
            ep: Number(e.ep) || Number(e.sort) || 0,
            nameCn: e.name_cn || '',
            name: e.name || '',
            desc: e.desc || '',
            airdate: e.airdate || '',
        }))
        .filter((e: BgEpFull) => e.nameCn || e.name || e.desc)
        .sort((a, b) => a.ep - b.ep);
    _metaEpsCache.set(subjectId, eps);
    persistMetaIfComplete(subjectId);
    return eps;
}

/** 条目信息 + 分集都到手后，合并持久化（下次「先本地后网络」） */
function persistMetaIfComplete(subjectId: number): void {
    const d = _metaDetailCache.get(subjectId);
    const eps = _metaEpsCache.get(subjectId);
    if (!d || !eps || !_metaCacheFile) return;
    _metaCache[String(subjectId)] = { ...d, eps };
    scheduleMetaSave();
}

/**
 * 拉取 Bangumi 每日放送（正在播），供「热门剧更新」浮层使用。
 * - 接口为公开端点，无需鉴权（无 token 也能用）。
 * - 仅保留 动画(type=2) 与 三次元(type=6, 含真人剧/电视剧)，排除游戏/书籍/音乐。
 * - 返回完整过滤列表（不切片）；排序交给 preload 端按「星期 / 热度」切换。
 * - 字段携带 air_weekday / weekdayCn / collectionTotal / rating 供前端排序与展示。
 */
async function fetchCalendar(): Promise<{ ok: boolean; items?: any[]; error?: string }> {
    try {
        const cfg: any = {
            timeout: 12000,
            headers: { 'User-Agent': bangumiUA() },
        };
        withTransport(cfg); // 注入传输方式（代理 > 免梯子直连DNS > 系统DNS；让每日放送数据源也可走用户自定义代理）
        const resp = await axios.get(`${BANGUMI_API}/calendar`, cfg);
        const days: any[] = Array.isArray(resp.data) ? resp.data : [];
        const map = new Map<number, any>();
        for (const day of days) {
            const items: any[] = (day && day.items) || [];
            const wdId = (day && day.weekday && day.weekday.id) || null;
            const wdCn = (day && day.weekday && day.weekday.cn) || '';
            for (const it of items) {
                if (!it || !it.id) continue;
                if (it.type !== undefined && it.type !== 2 && it.type !== 6) continue; // 只要动画 / 三次元剧集
                const rating = it.rating || {};
                const collTotal = sumNumeric(it.collection);
                const item = {
                    id: it.id,
                    name: it.name || '',
                    name_cn: it.name_cn || '',
                    images: it.images || {},
                    summary: it.summary || '',
                    air_date: it.air_date || '',
                    air_weekday: it.air_weekday || wdId,
                    weekdayCn: wdCn,
                    eps: it.eps || null,
                    rating: typeof rating.score === 'number' ? rating.score : null,
                    ratingTotal: typeof rating.total === 'number' ? rating.total : 0,
                    collectionTotal: collTotal,
                    url: `https://bgm.tv/subject/${it.id}`,
                };
                // 同条目可能出现在多天（罕见），保留收藏数更高的版本
                const prev = map.get(it.id);
                if (!prev || item.collectionTotal > prev.collectionTotal) map.set(it.id, item);
            }
        }
        const items = Array.from(map.values());
        items.sort((a, b) => b.collectionTotal - a.collectionTotal || (b.rating || 0) - (a.rating || 0));
        return { ok: true, items };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 把对象里所有数值字段求和（兼容 collection 为 {wish,collect,...} 或数字等多种形态） */
function sumNumeric(obj: any): number {
    if (typeof obj === 'number') return obj;
    if (!obj || typeof obj !== 'object') return 0;
    let s = 0;
    for (const v of Object.values(obj)) if (typeof v === 'number') s += v;
    return s;
}

/** 插件初始化（handlers/index.ts 自动加载同目录 *.ts 并调用 init） */
export function init(): void {
    loadCache();
    loadDescCache();       // 加载每集简介缓存
    loadMetaCache();       // [多源刮削] 加载条目级元数据缓存
    // 注册 IPC：供 preload 选集页调用获取 Bangumi 每集简介
    registerHandler('bangumi:episode-descs', async (_e: any, tvTitle: string, totalEps: number) => {
        return fetchEpisodeDescs(tvTitle, totalEps);
    }, { useHandle: true });
    // [多源刮削] 三段式 IPC: 匹配(快) → 条目信息 → 分集数据 —— 渲染端逐步刷新按钮状态,
    //  每步独立超时重试; 错误带 kind(timeout/nomatch/error) 供按钮转成中性提示文案。
    registerHandler('bangumi:meta-search', async (_e: any, tvTitle: string, totalEps: number) => {
        try {
            const r = await searchSubjectId(tvTitle, totalEps);
            return r ? { ok: true, data: r } : { ok: false, error: '未匹配到条目', kind: 'nomatch' };
        } catch (e: any) {
            return { ok: false, error: metaErr(e), kind: metaErrKind(e) };
        }
    }, { useHandle: true });
    registerHandler('bangumi:meta-detail', async (_e: any, subjectId: number) => {
        try {
            return { ok: true, data: await fetchSubjectDetail(Number(subjectId)) };
        } catch (e: any) {
            log.warn('[多源刮削] 条目信息获取失败 subject ' + subjectId + ':', metaErr(e));
            return { ok: false, error: metaErr(e), kind: metaErrKind(e) };
        }
    }, { useHandle: true });
    registerHandler('bangumi:meta-episodes', async (_e: any, subjectId: number) => {
        try {
            const eps = await fetchSubjectEpisodes(Number(subjectId));
            if (!eps.length) return { ok: false, error: '该条目无可回填分集数据', kind: 'nomatch' };
            return { ok: true, data: { eps } };
        } catch (e: any) {
            log.warn('[多源刮削] 分集数据获取失败 subject ' + subjectId + ':', metaErr(e));
            return { ok: false, error: metaErr(e), kind: metaErrKind(e) };
        }
    }, { useHandle: true });
    // 注册 IPC：供「热门剧更新」浮层拉取 Bangumi 每日放送
    // 每日缓存：24h 内只真正抓一次，其余返回本地磁盘缓存，避免被 Bangumi 限流/封禁
    registerHandler('bangumi:calendar', async (_e: any, force?: boolean) => {
        try {
            // [lc-581] onRefreshed: 过期缓存立即返回(秒见旧数据), 后台刷新成功后推送给渲染进程无感更新
            const r = await getDailyCached('bangumi_calendar', async () => {
                const res = await fetchCalendar();
                if (!res.ok) throw new Error(res.error || 'bangumi fetch failed');
                return res;
            }, DEFAULT_TTL_MS, !!force, (data) => {
                try {
                    BrowserWindow.getAllWindows().forEach((w) => {
                        w.webContents.send('hot-data-refreshed', { source: 'bangumi', data, cachedAt: Date.now() });
                    });
                } catch { /* ignore */ }
            });
            // 区分三种情况，避免再出现「明明发了请求却谎称未发」的误导日志：
            //   1) 有效期内缓存命中（确实没发请求）；2) 真正从线上刷新；3) 线上失败、降级用过期缓存（非最新）。
            const stale = r.fromCache && (Date.now() - r.fetchedAt > DEFAULT_TTL_MS);
            log.info('[Bangumi] 每日放送数据'
                + (r.stale ? '返回过期缓存(后台正在刷新新数据)'
                    : stale ? '线上抓取失败，降级使用过期本地缓存（非最新数据）'
                        : r.fromCache ? '来自本地缓存（未发网络请求，仍在有效期内）'
                            : '已从线上刷新')
                + '，更新于 ' + new Date(r.fetchedAt).toLocaleString('zh-CN'));
            return { ...r.data, cachedAt: r.fetchedAt, fromCache: r.fromCache, stale: r.stale };
        } catch (e: any) {
            return { ok: false, error: (e && e.message) || 'Bangumi 数据获取失败' };
        }
    }, { useHandle: true });
    log.info('Bangumi 集数级同步插件已加载');
}
