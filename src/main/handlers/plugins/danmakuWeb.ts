import { IpcMainInvokeEvent } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import log from '../../../modules/logger';
import * as fn from '../../../modules/fn_api/api';
import { getDanmakuItems, DanmakuItem, DanmakuMeta } from '../../../modules/danmaku/biliDanmaku';

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
    let isMovie = false;
    try {
        const fnapi = new fn.ApiService(config.domain, config.token);
        const resp = await fnapi.getPlayInfo(guid);
        if (!resp.success || !resp.data) {
            return { ok: false, error: '获取播放信息失败: ' + (resp?.message || '未知错误') };
        }
        const item = resp.data.item;
        title = (item?.tv_title || item?.title || '').trim();
        const type = (resp.data.type || item?.type || '').toLowerCase();
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
    try {
        const res = await getDanmakuItems(title, ep, isMovie, season);
        if (!res || !res.items || res.items.length === 0) {
            return { ok: false, title, ep, isMovie, count: 0, error: '未找到匹配的B站弹幕' };
        }
        const { items, meta } = res;
        log.info(`[danmakuWeb] ✅ 弹幕就绪: title="${title}" ep=${ep} movie=${isMovie} count=${items.length} source=${meta.source} matched="${meta.matchedTitle}"`);
        return { ok: true, title, ep, isMovie, count: items.length, items, source: 'bilibili', meta };
    } catch (e: any) {
        return { ok: false, title, ep, isMovie, error: '弹幕获取异常: ' + (e?.message || e) };
    }
}

function init(): void {
    registerHandler('danmaku:prepare', handlePrepare, { useHandle: true });
    log.info('[danmakuWeb] 已注册 IPC: danmaku:prepare');
}

export { init };
