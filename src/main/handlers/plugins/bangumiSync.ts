import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosInstance } from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import * as logger from '../../../modules/logger';
import * as types from '../../../modules/fn_api/types';

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
    return axios.create({
        baseURL: BANGUMI_API,
        timeout: 12000,
        headers: {
            'User-Agent': bangumiUA(),
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
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

/** 按标题搜索条目，返回最佳匹配的 subject_id（优先动画 type=2；eps 接近预期者） */
async function searchSubject(tvTitle: string, expectedEps: number): Promise<number | null> {
    const cached = subjectCache.get(tvTitle);
    if (cached) return cached;
    try {
        const resp = await http().post('/v0/search/subjects?limit=10', {
            keyword: tvTitle,
            sort: 'match',
            filter: { type: [2, 6] }, // 2=动画 6=三次元(电视剧/真人)
        });
        const items: BgSubject[] = (resp.data && resp.data.data) || [];
        if (items.length === 0) {
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
    } catch (e: any) {
        log.warn(`搜索条目失败「${tvTitle}」:`, e && e.message);
        return null;
    }
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
    _duration: number,
): Promise<void> {
    try {
        // 开关与 token 检查
        if (!fnConfig.getBangumiSyncEnabled()) return;
        if (!fnConfig.getBangumiToken()) return;

        // 阈值检查
        const threshold = fnConfig.getBangumiSyncThreshold();
        if (percentage < threshold) return;

        // 去重：同一 itemGuid 已标记过则跳过
        if (markedSet.has(itemGuid)) return;
        if (missSet.has(itemGuid)) return;

        const item = info && info.item;
        if (!item) return;
        const tvTitle = item.tv_title;
        const epNum = item.episode_number;
        if (!tvTitle || !epNum || epNum < 1) return;

        const totalEps = item.number_of_episodes || 0;
        const isWatched = item.is_watched === 1;

        // 1. 搜条目拿 subject_id
        const subjectId = await searchSubject(tvTitle, totalEps);
        if (!subjectId) {
            missSet.add(itemGuid);
            return;
        }

        // 2. 取 episode_id
        const episodeId = await getEpisodeId(subjectId, epNum);
        if (!episodeId) {
            missSet.add(itemGuid);
            return;
        }

        // 3. 先标条目在看（标集前必须先收藏，否则 400 subject not collected）
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

/** 插件初始化（handlers/index.ts 自动加载同目录 *.ts 并调用 init） */
export function init(): void {
    loadCache();
    log.info('Bangumi 集数级同步插件已加载');
}
