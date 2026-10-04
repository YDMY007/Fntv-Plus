import { IpcMainInvokeEvent } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import log from '../../../modules/logger';
import * as fn from '../../../modules/fn_api/api';
import { getDanmakuItems, getDanmakuItemsByBvid, clearDanmakuCacheByTitle, DanmakuItem, DanmakuMeta } from '../../../modules/danmaku/biliDanmaku';
import { runBiliDanmakuCandidates } from '../../../main/common/biliRunner';

/**
 * 原生网页播放器弹幕插件（danmakuWeb）
 *
 * 背景：MPV 的弹幕由 uosc_danmaku Lua 脚本实现；PotPlayer 暂不搞弹幕。
 * 飞牛「原声播放器」是 fnOS 网页自身的 <video> 播放器，preload 插件
 * （src/preload/plugins/danmakuWeb.ts）直接在该网页里渲染弹幕 overlay。
 * 本插件只负责数据侧：给定正在播放项的 guid，解析出「番名 + 集数」，
 * 复用既有的 B站弹幕抓取（getDanmakuItems）返回结构化弹幕条目给 preload。
 *
 * 集数规则（与 MPV 行为一致）：
 *   - 电影(type=Movie) → ep=0，search_cid 内部退化为「仅按番名搜、取弹幕最多的集」；
 *   - 剧集(type=Episode) → ep = item.episode_number，按番名+集数精确匹配。
 */

interface PrepareParams {
    guid: string;
    /** [lc-1117] 网页弹幕设置「B站弹幕搜索」开关；缺省=true（不传该参的旧调用方行为不变） */
    biliSearch?: boolean;
}

interface PrepareResult {
    ok: boolean;
    title?: string;
    ep?: number;
    isMovie?: boolean;
    count?: number;
    items?: DanmakuItem[];
    source?: string;
    error?: string;
    meta?: DanmakuMeta;
    /** 同屏弹幕上限（0=不限），与 MPV 的 max_screen_danmaku 同一份设置 */
    maxScreen?: number;
}

async function handlePrepare(
    _event: IpcMainInvokeEvent,
    params: PrepareParams,
): Promise<PrepareResult> {
    const guid = params?.guid;
    if (!guid) {
        return { ok: false, error: '缺少 guid' };
    }

    const config = fnConfig.readConfig();
    if (!config || !config.domain || !config.token) {
        return { ok: false, error: '未配置服务器地址或未登录' };
    }

    // ── 用 guid 解析番名 + 集数 + 季数（电影/剧集）──
    let title = '';
    let ep = 0;
    let season = 0;
    let epTitle = '';
    let isMovie = false;
    let seriesKey = '';
    try {
        const fnapi = new fn.ApiService(config.domain, config.token);
        const resp = await fnapi.getPlayInfo(guid);
        if (!resp.success || !resp.data) {
            return { ok: false, error: '获取播放信息失败: ' + (resp?.message || '未知错误') };
        }
        const item = resp.data.item;
        // [lc-1254] 系列键：剧集取季 guid（跨集稳定），电影/无父级退化为条目自身 guid——
        // 供自建源「系列级匹配记忆」跨集复用命中条目（各集标题元数据不一致时不再逐集重搜）。
        seriesKey = String((resp.data as any).parent_guid || item?.parent_guid || guid);
        title = (item?.tv_title || item?.title || '').trim();
        const type = (resp.data.type || item?.type || '').toLowerCase();
        // [lc-1220] 本集标题：剧集时 tv_title=番名、title=本集标题，供自建源核验未标季条目。
        //   title===tv_title（电影或番名回退）时没有独立的集标题，置空；
        //   「The Demon Hunter.S02E27」这类纯集号刮削名剥掉 .SxxExx 尾缀（danmuApi 侧
        //   extractEpisodeTitle 也会再兜一道，这里先剥省得垃圾串往下游传）。
        const t = (item?.title || '').trim();
        epTitle = (type !== 'movie' && t && t !== title)
            ? t.replace(/[.\s]*[Ss]\d{1,2}[Ee]\d{1,4}[.\s]*$/g, '').trim()
            : '';
        if (type === 'movie') {
            isMovie = true;
            ep = 0; // 电影：仅按番名搜，取最优/首集
            season = 0;
        } else {
            isMovie = false;
            ep = item?.episode_number ? Number(item.episode_number) : 0;
            // 季数：优先 item.season_number（fnOS 剧集元数据可靠提供），用于精确匹配 B站 季，根治跨季错配。
            season = item?.season_number ? Number(item.season_number) : 0;
        }
        log.info(`[danmakuWeb] guid=${guid} type=${type} title="${title}" ep=${ep} season=${season}`);
    } catch (e: any) {
        return { ok: false, error: '查询播放信息异常: ' + (e?.message || e) };
    }

    if (!title) {
        return { ok: false, error: '无法解析标题（tv_title 为空）' };
    }

    // ── 抓取 B站弹幕（带磁盘缓存；ep=0 自动退化；season>0 时优先精确匹配该季）──
    // [lc-1117] biliSearch=false：网页弹幕设置关掉了「B站弹幕搜索」兜底（自建 danmu_api 优选不受影响）
    try {
        const res = await getDanmakuItems(title, ep, isMovie, season, params?.biliSearch !== false, epTitle, seriesKey);
        if (!res || !res.items || res.items.length === 0) {
            return { ok: false, title, ep, isMovie, count: 0, error: (res && res.meta && res.meta.error) || '未找到匹配的B站弹幕' };
        }
        const { items, meta } = res;
        log.info(`[danmakuWeb] ✅ 弹幕就绪: title="${title}" ep=${ep} movie=${isMovie} count=${items.length} source=${meta.source} matched="${meta.matchedTitle}"`);
        return { ok: true, title, ep, isMovie, count: items.length, items, source: 'bilibili', meta, maxScreen: fnConfig.getBiliDanmakuMaxScreen() };
    } catch (e: any) {
        return { ok: false, title, ep, isMovie, error: '弹幕获取异常: ' + (e?.message || e) };
    }
}

function init(): void {
    registerHandler('danmaku:prepare', handlePrepare, { useHandle: true });
    registerHandler('danmaku:candidates', handleCandidates, { useHandle: true });
    registerHandler('danmaku:pick', handlePick, { useHandle: true });
    registerHandler('danmaku:clear', handleClear, { useHandle: true });
    log.info('[danmakuWeb] 已注册 IPC: danmaku:prepare / danmaku:candidates / danmaku:pick / danmaku:clear');
}

// [lc-1118] 手动搜索：按关键词搜候选（danmu_api 优选 → 未命中降级 B站），只回可直接拉取的前 8 条。
// [lc-1300] 番剧/国创条目（B站正版，无 bvid）现在带 pgc:<ep_id> 伪 bvid（bili_danmaku.js
//   search_candidates 生成），选定后 run_candidates 解析 epid→cid 直接拉取 —— 不再「搜到了却选不了」。
async function handleCandidates(_event: IpcMainInvokeEvent, params: { title?: string; ep?: number; season?: number }): Promise<any> {
    const title = String(params?.title || '').trim();
    if (!title) return { ok: false, error: '缺少搜索关键词' };
    try {
        const r = await runBiliDanmakuCandidates(title, Number(params?.ep) || 0, params?.season ? Number(params.season) : 0);
        if (!r.ok || !Array.isArray(r.candidates)) {
            return { ok: false, error: r.error || '候选搜索失败' };
        }
        const usable = r.candidates.filter((c: any) => c && c.bvid);
        if (usable.length === 0) {
            return { ok: false, error: `搜到 ${r.candidates.length} 个条目但没有可直接拉取弹幕的候选` };
        }
        return {
            ok: true,
            candidates: usable.slice(0, 8).map((c: any) => ({
                bvid: String(c.bvid),
                title: String(c.title || ''),
                source: String(c.source || ''),
                isCompilation: !!c.is_compilation,
                // [lc-1301] 与 MPV 菜单同款区分：BAD_TITLE 命中才是真该避开的「⚠️解说/二创」，
                //   「全N集」式多P 正片合集是 📁（已可按集取分P，选它正合适）
                badTitle: !!c.bad_title,
                sim: (typeof c.sim === 'number') ? c.sim : null,
                // [lc-1301] B站官方弹幕数（view API stat.danmaku；pgc/dmapi 伪 id 无此字段）：
                //   视频区候选之间就靠它分辨「正片弹幕多」与「无人发弹幕」，一步选对
                danmakuCount: (typeof c.danmaku_count === 'number') ? c.danmaku_count : null,
            })),
        };
    } catch (e: any) {
        return { ok: false, error: '候选搜索异常: ' + (e?.message || e) };
    }
}

// [lc-1118] 手动选定：按 bvid（或 dmapi:<episodeId>）直接拉弹幕并落缓存，下次自动加载直接命中
async function handlePick(_event: IpcMainInvokeEvent, params: { title?: string; ep?: number; season?: number; isMovie?: boolean; bvid?: string }): Promise<any> {
    const title = String(params?.title || '').trim();
    const bvid = String(params?.bvid || '').trim();
    if (!title || !bvid) return { ok: false, error: '缺少 title/bvid' };
    try {
        const res = await getDanmakuItemsByBvid(title, Number(params?.ep) || 0, !!params?.isMovie, params?.season ? Number(params.season) : 0, bvid);
        if (!res || !res.items || res.items.length === 0) {
            return { ok: false, title, error: (res && res.meta && res.meta.error) || '该条目没有弹幕' };
        }
        log.info(`[danmakuWeb] ✅ 手动选定弹幕就绪: title="${title}" count=${res.items.length} source=${res.meta.source}`);
        return { ok: true, title, ep: res.meta.ep, isMovie: !!params?.isMovie, count: res.items.length, items: res.items, source: 'bilibili', meta: res.meta, maxScreen: fnConfig.getBiliDanmakuMaxScreen() };
    } catch (e: any) {
        return { ok: false, title, error: '弹幕获取异常: ' + (e?.message || e) };
    }
}

// [lc-1300] 清除弹幕：按剧清掉全部季/集的磁盘缓存 + 弹幕源锁定记忆。
// 配合手动搜索使用——自动匹配错了（缓存+锁定会永久复用错误结果），先清除再手动重选正确条目。
async function handleClear(_event: IpcMainInvokeEvent, params: { title?: string }): Promise<any> {
    const title = String(params?.title || '').trim();
    if (!title) return { ok: false, error: '缺少 title' };
    try {
        const r = clearDanmakuCacheByTitle(title);
        return { ok: true, files: r.files, lockCleared: r.lockCleared };
    } catch (e: any) {
        return { ok: false, error: '清除失败: ' + (e?.message || e) };
    }
}

export { init };
