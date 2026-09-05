import axios from 'axios';
import log from '../../modules/logger';
import { getDailyCached } from './dailyCache';

// skipMalMap.ts — [lc-1059] 片名 → MyAnimeList id 映射链（AniSkip 前置）
// 供 smartSkip(网页播放器回填) 与 players/impl/mpv(MPV Lua AniSkip 兜底) 共用。
// 链路：Bangumi 中文搜索(中文索引最强)取日文原名 → Jikan / AniList 双路互备搜日文名拿 idMal。
// 结果按 TMDB id getDailyCached 缓存 30 天(SWR)；链上任一环成功即止，全失败 throw 不落盘坏值。

const BGM_UA = 'fntv-plus/lc-1059 (https://github.com/YDMY007/Fntv-Plus)';
const MAP_TIMEOUT = 12000; // 每剧仅映射一次(30 天缓存)，慢一点无感

async function bangumiNativeTitle(title: string): Promise<string | null> {
    try {
        const r = await axios.post('https://api.bgm.tv/v0/search/subjects?limit=3',
            { keyword: title, filter: { type: [2] } },
            { timeout: MAP_TIMEOUT, headers: { 'User-Agent': BGM_UA, 'Content-Type': 'application/json' } });
        const top = r.data?.data?.[0];
        return top?.name ? String(top.name) : null;
    } catch (e) {
        log.warn('[skip:malmap] Bangumi 搜索失败:', (e as Error).message);
        return null;
    }
}

async function jikanMalId(name: string): Promise<number | null> {
    try {
        const r = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(name)}&limit=1`,
            { timeout: MAP_TIMEOUT, headers: { 'User-Agent': BGM_UA } });
        const mal = r.data?.data?.[0]?.mal_id;
        return typeof mal === 'number' ? mal : null;
    } catch (e) {
        log.warn('[skip:malmap] Jikan 搜索失败:', (e as Error).message);
        return null;
    }
}

async function anilistMalId(name: string): Promise<number | null> {
    try {
        const q = 'query($s:String){Media(search:$s,type:ANIME){id idMal}}';
        const r = await axios.post('https://graphql.anilist.co',
            { query: q, variables: { s: name } },
            { timeout: MAP_TIMEOUT, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
        const mal = r.data?.data?.Media?.idMal;
        return typeof mal === 'number' ? mal : null;
    } catch (e) {
        log.warn('[skip:malmap] AniList 搜索失败:', (e as Error).message);
        return null;
    }
}

/** 标题 → MAL id：Bangumi(中文→日文名) → Jikan/AniList 双路互备；失败 throw（不落盘坏值） */
export async function resolveMalId(tmdbKey: string, title: string): Promise<number | null> {
    const key = `skip_malmap_v1_${/^\d+$/.test(tmdbKey) ? tmdbKey : 't_' + tmdbKey}`;
    const r = await getDailyCached(key, async () => {
        const nativeName = await bangumiNativeTitle(title);
        const candidates: string[] = [];
        if (nativeName) candidates.push(nativeName);
        candidates.push(title); // 原标题兜底（可能本身是日文）
        for (const name of candidates) {
            const viaJikan = await jikanMalId(name);
            if (viaJikan) return { malId: viaJikan, via: 'jikan:' + name };
            const viaAnilist = await anilistMalId(name);
            if (viaAnilist) return { malId: viaAnilist, via: 'anilist:' + name };
        }
        throw new Error('no mal mapping');
    }, 30 * 24 * 60 * 60 * 1000);
    const data = r?.data as { malId: number; via: string } | null | undefined;
    if (data && data.malId) {
        log.info(`[skip:malmap] ${tmdbKey} → MAL ${data.malId} (${data.via})`);
        return data.malId;
    }
    return null;
}
