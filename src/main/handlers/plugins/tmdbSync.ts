import { app } from 'electron';
import axios, { AxiosInstance } from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';

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

/** 带鉴权 + 超时 + UA 的 http 客户端 */
function http(): AxiosInstance {
    const key = fnConfig.getTmdbApiKey();
    const a = key ? authFor(key) : { headers: {} as Record<string, string> };
    return axios.create({
        baseURL: TMDB_API,
        timeout: 12000,
        headers: {
            'User-Agent': tmdbUA(),
            'Content-Type': 'application/json',
            ...a.headers,
        },
    });
}

function posterUrl(posterPath: any): string {
    if (typeof posterPath === 'string' && posterPath) return TMDB_IMG + posterPath;
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
async function fetchDiscover(): Promise<{ ok: boolean; items?: any[]; error?: string }> {
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
        const [movieRes, tvRes] = await Promise.all([
            client.get('/discover/movie', { params: baseParams }),
            client.get('/discover/tv', { params: baseParams }),
        ]);
        const movies: any[] = (movieRes.data && movieRes.data.results) || [];
        const tvs: any[] = (tvRes.data && tvRes.data.results) || [];
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
        // 混合列表按热度降序（前端再按「热门/高分/最新」二次排序）
        items.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
        return { ok: true, items };
    } catch (e: any) {
        const status = e && e.response && e.response.status;
        let msg = String((e && e.message) || e);
        if (status === 401) msg = 'TMDB Key 无效或无访问权限，请检查设置。';
        else if (status === 429) msg = 'TMDB 请求过于频繁（限速），请稍后再试。';
        return { ok: false, error: msg };
    }
}

function init(): void {
    registerHandler('tmdb:discover', async () => {
        return fetchDiscover();
    }, { useHandle: true });
    log.info('TMDB 数据源插件已加载');
}

export {
    init
};
