import axios, { AxiosInstance } from 'axios';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';
import { getDailyCached, DEFAULT_TTL_MS } from '../../common/dailyCache';

const log = logger.component('douban');

/**
 * 豆瓣数据源插件（「热门剧更新」浮层的豆瓣电影/剧集源）
 *
 * - 端点：m.douban.com/rexxar/api/v2/subject_collection/{collection}/items
 *     · 热门电影：movie_hot_gaia
 *     · 热门剧集：tv_hot
 * - 鉴权：无（Rexxar 半公开接口，仅需带移动端 UA + Referer 即可访问）
 * - 核心价值：豆瓣为国内站点，国内网络【直连可达、无 DNS 污染、无需梯子 / 无需 Key】
 *     （实测 movie.douban.com 0.39s / m.douban.com rexxar 0.32s 直连 200），
 *     正好规避 TMDB（api.themoviedb.org）被 DNS 污染需免梯子直连/代理的痛点。
 * - 评分：rating.value 为 10 分制，与 TMDB 一致，前端无需改动。
 * - 热度：Rexxar 无 popularity 字段，用 rating.count（评价人数）近似热度排序。
 * - 图片：imgX.doubanio.com 有防盗链（缺 Referer 返回 418），douban:image 强制带 UA+Referer 解码。
 * - 稳定性：Rexxar 非官方公开 API，历史上加过签名又被绕过；故豆瓣作【国内兜底备选】，
 *     而非完全替代 TMDB。用户可在设置面板「数据源」切换 TMDB / 豆瓣（默认豆瓣）。
 *
 * 返回结构与 TMDB 的 fetchDiscover 完全对齐（images.common / name_cn / mediaType /
 * year / rating / popularity / url），以便 hotUpdates 卡片渲染零改动复用。
 */

const DOUBAN_REXXAR = 'https://m.douban.com/rexxar/api/v2/subject_collection';
const DOUBAN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const DOUBAN_REFERER = 'https://m.douban.com/movie/';
const DOUBAN_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DOUBAN_WEB_REFERER = 'https://movie.douban.com/';

/** 豆瓣客户端（带移动端 UA + Referer，规避 Rexxar 反爬） */
function client(): AxiosInstance {
    return axios.create({
        timeout: 20000,
        headers: {
            'User-Agent': DOUBAN_MOBILE_UA,
            'Referer': DOUBAN_REFERER,
            'Accept': 'application/json',
        },
    });
}

/** 把错误翻译成对用户友好的中文提示 */
function describeDoubanError(e: any): string {
    const status = e && e.response && e.response.status;
    const code = e && e.code;
    const msg = String((e && e.message) || e);
    if (status === 403 || status === 418) return '豆瓣接口拒绝访问（反爬限流），请稍后重试。';
    if (status === 429) return '豆瓣请求过于频繁，请稍后再试。';
    if (status === 404) return '豆瓣接口路径变更，请联系开发者更新。';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析豆瓣域名（DNS 失败），请检查本机网络连接。';
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout'))
        return '豆瓣请求超时：本机网络无法直连 m.douban.com（一般不会，豆瓣国内直连）。';
    return msg;
}

/** 归一化为与 TMDB 卡片共享的渲染字段（结构与 TMDB normalize 完全一致） */
function normalize(raw: any, mediaType: 'movie' | 'tv'): any {
    const title = raw.title || raw.original_title || raw.name || '';
    // 封面字段名不一致：电影用 cover.url；剧集用 pic.large / pic.normal（Rexxar 不同 collection 字段不同）
    const cover =
        (raw.cover && raw.cover.url) ||
        (raw.pic && (raw.pic.large || raw.pic.normal)) ||
        (typeof raw.pic === 'string' ? raw.pic : '') ||
        '';
    const rating = (raw.rating && typeof raw.rating.value === 'number') ? raw.rating.value : 0;
    const count = (raw.rating && typeof raw.rating.count === 'number') ? raw.rating.count : 0;
    return {
        id: raw.id,
        mediaType,
        name: title,
        name_cn: title,
        images: { common: cover },
        rating,
        year: raw.year ? String(raw.year) : '',
        // Rexxar 无 popularity，用评价人数近似热度（用于「剧集/电影」按热度排序）
        popularity: count,
        overview: '',
        url: `https://movie.douban.com/subject/${raw.id}`,
    };
}

/**
 * 拉取豆瓣热门电影 + 剧集（movie_hot_gaia / tv_hot），合并去重。
 * 无需 Key；国内直连，无需代理 / 免梯子 hack。
 */
async function fetchDiscover(): Promise<{ ok: boolean; items?: any[]; error?: string; warning?: string }> {
    try {
        const c = client();
        const [movieR, tvR] = await Promise.allSettled([
            c.get(`${DOUBAN_REXXAR}/movie_hot_gaia/items`, { params: { start: 0, count: 20 } }),
            c.get(`${DOUBAN_REXXAR}/tv_hot/items`, { params: { start: 0, count: 20 } }),
        ]);
        if (movieR.status === 'fulfilled') {
            const n = movieR.value?.data?.subject_collection_items?.length || 0;
            log.info('[豆瓣诊断] movie_hot_gaia 成功，返回 ' + n + ' 条');
        } else {
            log.error('[豆瓣诊断] movie_hot_gaia 失败：' + describeDoubanError((movieR as PromiseRejectedResult).reason));
        }
        if (tvR.status === 'fulfilled') {
            const n = tvR.value?.data?.subject_collection_items?.length || 0;
            log.info('[豆瓣诊断] tv_hot 成功，返回 ' + n + ' 条');
        } else {
            log.error('[豆瓣诊断] tv_hot 失败：' + describeDoubanError((tvR as PromiseRejectedResult).reason));
        }
        const movies: any[] = movieR.status === 'fulfilled' ? (movieR.value?.data?.subject_collection_items || []) : [];
        const tvs: any[] = tvR.status === 'fulfilled' ? (tvR.value?.data?.subject_collection_items || []) : [];
        const seen = new Set<string>();
        const items: any[] = [];
        for (const m of movies) {
            if (!m || !m.id || seen.has(String(m.id))) continue;
            seen.add(String(m.id));
            items.push(normalize(m, 'movie'));
        }
        for (const t of tvs) {
            if (!t || !t.id || seen.has(String(t.id))) continue;
            seen.add(String(t.id));
            items.push(normalize(t, 'tv'));
        }
        if (!items.length) {
            const reasons = [movieR, tvR]
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => describeDoubanError(r.reason));
            return { ok: false, error: reasons[0] || '豆瓣数据获取失败。' };
        }
        let warning: string | undefined;
        if (movieR.status === 'rejected' || tvR.status === 'rejected') {
            warning = '部分数据源（电影 / 剧集）获取失败，已显示可用部分。';
        }
        items.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
        log.info('[豆瓣诊断] 拉取完成，共合并 ' + items.length + ' 条（电影 ' + movies.length + ' + 剧集 ' + tvs.length + '）' + (warning ? '；' + warning : ''));
        return { ok: true, items, warning };
    } catch (e: any) {
        return { ok: false, error: describeDoubanError(e) };
    }
}

/**
 * 拉取豆瓣海报为 data URL（带桌面 UA + Referer 解防盗链 418）。
 * 豆瓣图片国内直连，无需 TMDB 的 lookup 代理 / HTTPS_PROXY。
 */
async function fetchImageAsDataUrl(url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
    try {
        if (!/^https?:\/\//.test(url)) return { ok: false, error: '非法图片地址' };
        let host = '';
        try { host = new URL(url).hostname; } catch { return { ok: false, error: '图片地址格式错误' }; }
        if (!/doubanio\.com$/i.test(host)) return { ok: false, error: '仅支持豆瓣图片域名' };
        const c = axios.create({
            timeout: 20000,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': DOUBAN_DESKTOP_UA,
                'Referer': DOUBAN_WEB_REFERER,
            },
        });
        log.info('[豆瓣诊断] 拉取图片（国内直连）：' + url.slice(0, 90));
        const resp = await c.get(url);
        const ct = (resp.headers && resp.headers['content-type']) || 'image/jpeg';
        const b64 = Buffer.from(resp.data as Buffer).toString('base64');
        log.info('[豆瓣诊断] 图片拉取成功，' + (resp.data as Buffer).length + ' 字节');
        return { ok: true, dataUrl: `data:${ct};base64,${b64}` };
    } catch (e: any) {
        log.error('[豆瓣诊断] 图片拉取失败：' + describeDoubanError(e));
        return { ok: false, error: String((e && e.message) || e) };
    }
}

function init(): void {
    registerHandler('douban:discover', async (_e: any, force?: boolean) => {
        try {
            // 每日缓存：24h 内只真正抓一次，其余返回本地磁盘缓存，避免被豆瓣限流/封禁
            // force=true（浮窗「↻ 刷新」按钮）时忽略缓存、强制重新抓取并覆写磁盘缓存
            const r = await getDailyCached('douban_hot', async () => {
                const res = await fetchDiscover();
                if (!res.ok) throw new Error(res.error || 'douban fetch failed');
                return res;
            }, DEFAULT_TTL_MS, !!force);
            log.info('[豆瓣诊断] 数据' + (r.fromCache ? '来自本地缓存（未发网络请求）' : '已从线上刷新')
                + (force ? '（强制刷新）' : '') + '，更新于 ' + new Date(r.fetchedAt).toLocaleString('zh-CN'));
            return { ...r.data, cachedAt: r.fetchedAt, fromCache: r.fromCache };
        } catch (e: any) {
            return { ok: false, error: (e && e.message) || '豆瓣数据获取失败' };
        }
    }, { useHandle: true });
    registerHandler('douban:image', async (_e: any, url: string) => {
        return fetchImageAsDataUrl(url);
    }, { useHandle: true });
}

export { init };
