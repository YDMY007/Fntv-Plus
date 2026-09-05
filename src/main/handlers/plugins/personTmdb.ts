// personTmdb.ts — 演员页「TMDB 完整作品」数据管道（lc-1033）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：飞牛演员详情页只展示库内作品；第三方油猴插件 fnos-actor-tmdb v4.5 验证了
// 「TMDB 全量出演作品 + 库内缺失标记」的可行管线（dest/_verify/lc1033-explore/ 留档）。
// 本模块把该能力原生化（主进程直连，无需油猴/无需用户自备 TMDB Key）：
//   ① 飞牛 person 详情（/v/api/v1/person/<guid>）→ imdbId
//   ② 飞牛 person/item/list（job=Actor/Director/... 分页 200）→ 库内作品 → owned 匹配键
//      （规范化中/英标题 + tmdb_id；imdb→tmdb 兜底换算，与插件同策略）
//   ③ TMDB /find/{imdb} → person id → /person/{id}/combined_credits → 全量 cast
//   ④ 输出 items[]（id/title/en/date/character/score/poster/overview/media/owned/guid），
//      owned 作品回填飞牛 guid（前端可点击进库内详情页）
// TMDB 请求复用 tmdbSync 的客户端（v3/v4 鉴权 + 代理/免梯子直连 + 重试），零额外配置。
// ─────────────────────────────────────────────────────────────────────────────
import { registerHandler } from '../core/ipcHandler';
import * as fnConfig from '../../../modules/fn_config/config';
import { request as fnRequest, HttpMethod } from '../../../modules/fn_api/request';
import * as logger from '../../../modules/logger';
import { tmdbApiGet } from './tmdbSync';
const log = logger.component('person-tmdb');

/** 标题归一化：去大小写/空格/中英标点（与油猴插件 norm() 同规则，两侧标题能对上） */
function norm(s: any): string {
    return String(s || '').toLowerCase()
        .replace(/[\s　·:：,，.。、!！?？'’"“”\-—_()（）[\]【】~～|/\\]/g, '');
}

interface CreditItem {
    id: number;
    title: string;
    en: string;
    date: string;
    character: string;
    score: number;
    poster: string;
    overview: string;
    media: 'movie' | 'tv';
    owned?: boolean;
    guid?: string;
}

/** 采集单个演员的 TMDB 全量作品 + 库内标记。供 IPC 与测试复用。 */
export async function collectCredits(personGuid: string): Promise<any> {
    const cfg = fnConfig.readConfig();
    const domain = cfg && cfg.domain;
    const token = cfg && cfg.token;
    if (!domain || !token) return { error: '缺少 fnOS 配置（domain/token）' };
    const fnreq = (method: HttpMethod, p: string, data?: any): Promise<any> =>
        fnRequest(domain, p, method, token, data);

    try {
        // ① person 详情 → imdbId / name
        const pd: any = await fnreq(HttpMethod.GET, '/v/api/v1/person/' + personGuid);
        const person = pd && pd.data ? pd.data : null;
        if (!person) return { error: '未找到该演员（' + personGuid + '）' };
        const name = String(person.name || person.title || '');
        const imdbId = String(person.imdbId || person.imdb_id || '');

        // ② 库内作品（job 过滤；与插件一致）
        const libItems: any[] = [];
        for (const job of ['Actor', 'Director', 'Writer', 'Screenplay', 'Producer']) {
            try {
                const j: any = await fnreq(HttpMethod.POST, '/v/api/v1/person/item/list', {
                    person_guid: personGuid, page: 1, page_size: 200, job,
                    sort_column: 'update_time', sort_type: 'desc',
                });
                const list = j && j.data && Array.isArray(j.data.list) ? j.data.list : [];
                libItems.push(...list);
            } catch { /* 单 job 失败忽略 */ }
        }
        const ownedTmdb = new Set<string>();
        const ownedTitles = new Set<string>();
        const guidByTitle = new Map<string, { guid: string; type: string }>();
        for (const it of libItems) {
            const title = String(it.title || it.name || it.original_title || it.original_name || '');
            const ty = String(it.type || it.media_type || '').toLowerCase();
            const type = /tv|series|show|剧|集/.test(ty) ? 'tv' : (/movie|film|电影/.test(ty) ? 'movie' : '');
            const tid = Number(it.tmdb_id || it.tmdbId || 0);
            if (title) {
                ownedTitles.add(norm(title));
                if (it.guid) guidByTitle.set(norm(title), { guid: String(it.guid), type });
            }
            if (tid) {
                ownedTmdb.add(type + tid);
                if (!type) { ownedTmdb.add('tv' + tid); ownedTmdb.add('movie' + tid); }
            }
        }
        // imdb→tmdb 兜底（库内记录带 imdb_id 而标题没对上时的保险）
        for (const it of libItems) {
            const imdb = it.imdb_id || it.imdbId;
            if (!imdb) continue;
            try {
                const f: any = await tmdbApiGet('/find/' + imdb, { external_source: 'imdb_id' });
                if (f && Array.isArray(f.movie_results)) for (const mv of f.movie_results) ownedTmdb.add('movie' + mv.id);
                if (f && Array.isArray(f.tv_results)) for (const tv of f.tv_results) ownedTmdb.add('tv' + tv.id);
            } catch { /* 兜底失败不影响主匹配 */ }
        }

        // ③ TMDB 全量 cast
        if (!imdbId) {
            log.info(name + ' 无 imdbId，跳过 TMDB 全量作品');
            return { ok: true, name, noImdb: true, items: [] as CreditItem[], ownedCount: 0 };
        }
        const find: any = await tmdbApiGet('/find/' + imdbId, { external_source: 'imdb_id' });
        const pid = find && Array.isArray(find.person_results) && find.person_results[0] ? find.person_results[0].id : null;
        if (!pid) {
            log.info(name + ' 在 TMDB 未找到人物（IMDb ' + imdbId + '）');
            return { ok: true, name, noImdb: true, items: [] as CreditItem[], ownedCount: 0 };
        }
        const cr: any = await tmdbApiGet('/person/' + pid + '/combined_credits');
        const seen = new Set<string>();
        const items: CreditItem[] = ((cr && Array.isArray(cr.cast)) ? cr.cast : [])
            .filter((m: any) => { const k = (m.media_type || 'movie') + m.id; if (seen.has(k)) return false; seen.add(k); return true; })
            .map((m: any) => ({
                id: Number(m.id),
                title: String(m.title || m.name || '未知'),
                en: String(m.original_title || m.original_name || ''),
                date: String(m.release_date || m.first_air_date || ''),
                character: String(m.character || ''),
                score: Number(m.vote_average) || 0,
                poster: String(m.poster_path || ''),
                overview: String(m.overview || ''),
                media: (m.media_type === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv',
            }))
            .sort((a: CreditItem, b: CreditItem) => (b.date || '').localeCompare(a.date || ''));

        // ④ owned 标记 + 库内 guid 回填
        for (const m of items) {
            const tKey = m.media + m.id;
            const nZh = norm(m.title);
            if (ownedTmdb.has(tKey) || ownedTitles.has(nZh) || (m.en && ownedTitles.has(norm(m.en)))) {
                m.owned = true;
                const g = guidByTitle.get(nZh) || (m.en ? guidByTitle.get(norm(m.en)) : undefined);
                if (g && g.guid) m.guid = g.guid;
            }
        }
        const ownedCount = items.filter((m) => m.owned).length;
        log.info(name + ': TMDB 全量 ' + items.length + ' 部，库内 ' + ownedCount + ' 部');
        return { ok: true, name, items, ownedCount, total: items.length };
    } catch (e: any) {
        log.warn('collectCredits 失败:', e && e.message);
        return { error: String(e.message || e) };
    }
}

/** [lc-1036] 演员简报（详情页演职人员行补充信息）：职业分类/生日/代表作前二。
 *  TMDB /person/{id} + combined_credits(vote_count 排序)；会话内缓存。 */
const _briefCache = new Map<string, any>();
const DEPT_CN: Record<string, string> = {
    Acting: '演员', Directing: '导演', Writing: '编剧', Production: '制片',
    Camera: '摄影', Sound: '音效', Art: '美术', Editing: '剪辑', 'Visual Effects': '视效',
};
export async function collectBrief(personGuid: string): Promise<any> {
    if (_briefCache.has(personGuid)) return _briefCache.get(personGuid);
    const cfg = fnConfig.readConfig();
    const domain = cfg && cfg.domain;
    const token = cfg && cfg.token;
    if (!domain || !token) return { error: '缺少 fnOS 配置（domain/token）' };
    try {
        const pd: any = await fnRequest(domain, '/v/api/v1/person/' + personGuid, HttpMethod.GET, token);
        const person = pd && pd.data ? pd.data : null;
        const imdbId = person ? String(person.imdbId || person.imdb_id || '') : '';
        const brief: any = { name: person ? String(person.name || '') : '' };
        if (imdbId) {
            const find: any = await tmdbApiGet('/find/' + imdbId, { external_source: 'imdb_id' });
            const pid = find && Array.isArray(find.person_results) && find.person_results[0] ? find.person_results[0].id : null;
            if (pid) {
                const per: any = await tmdbApiGet('/person/' + pid, {});
                brief.dept = DEPT_CN[String(per.known_for_department || '')] || String(per.known_for_department || '') || undefined;
                brief.birthday = String(per.birthday || '') || undefined;
                brief.place = String(per.place_of_birth || '') || undefined;
                try {
                    const cr: any = await tmdbApiGet('/person/' + pid + '/combined_credits', {});
                    const cast = (cr && Array.isArray(cr.cast)) ? cr.cast : [];
                    brief.top = cast.slice()
                        .sort((a: any, b: any) => (b.vote_count || 0) - (a.vote_count || 0))
                        .slice(0, 2)
                        .map((m: any) => String(m.title || m.name || ''))
                        .filter((t: string, i: number, arr: string[]) => arr.indexOf(t) === i);
                } catch { /* 代表作可选 */ }
            }
        }
        _briefCache.set(personGuid, brief);
        return { ok: true, ...brief };
    } catch (e: any) {
        return { error: String(e.message || e) };
    }
}

export function init(): void {
    // ⚠ preload 走 ipcRenderer.invoke，主进程必须 ipcMain.handle（useHandle:true）——
    // 默认的 ipcMain.on 对 invoke 恒抛 No handler registered，preload 会误报「主进程未加载」，
    // 且重启客户端也无济于事（lc-1033 漏配，lc-1038 修）。
    registerHandler('person:tmdb-brief', async (_e: any, personGuid: string) => {
        if (!personGuid || !/^[0-9a-f]{32}$/i.test(String(personGuid))) return { error: 'personGuid 无效' };
        return await collectBrief(String(personGuid).toLowerCase());
    }, { useHandle: true });
    registerHandler('person:tmdb-credits', async (_e: any, personGuid: string) => {
        if (!personGuid || !/^[0-9a-f]{32}$/i.test(String(personGuid))) return { error: 'personGuid 无效' };
        return await collectCredits(String(personGuid).toLowerCase());
    }, { useHandle: true });
    log.info('演员 TMDB 作品插件就绪');
}
