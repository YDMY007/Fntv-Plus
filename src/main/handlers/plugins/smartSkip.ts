import { IpcMainInvokeEvent } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { writeSmartSkipEnabled } from './mpvConfig';
import { registerHandler } from '../core/ipcHandler';
import axios from 'axios';
import log from '../../../modules/logger';
import { getSessionCookieHeader } from '../../../modules/fn_api/request';
import * as fn from '../../../modules/fn_api/api';

/**
 * 智能跳过片头片尾插件（smart_skip）
 * - 把「跳过片头/片尾」的控制面从 MPV uosc 菜单抽出来，改为应用「插件」设置面板统一管理。
 * - 真正的跳过逻辑仍在打包的 MPV Lua 套件 smart_skip/ 里；本插件只负责：
 *   1) 持久化总开关到 config.json（get/set-smart-skip-enabled）；
 *   2) 把开关双写到 smart_skip.conf 的 enabled（便携 + 标准两种 mpv 模式都生效）；
 *   3) [lc-316] 为飞牛原生网页播放器自动填充跳过数据（fetch-and-fill）：
 *      先查 fnOS 服务端 skipinfo → 为空则 theintrodb 兜底 → 写回飞牛服务端。
 */

// ─── 读取总开关（MPV 路径，原有） ───

function handleGetSmartSkipEnabled(): boolean {
    return fnConfig.getSmartSkipEnabled();
}

function handleSetSmartSkipEnabled(_event: IpcMainInvokeEvent, enabled: boolean): void {
    const val = !!enabled;
    fnConfig.setSmartSkipEnabled(val);
    writeSmartSkipEnabled(val);
}

// ─── fetch-and-fill：为飞牛原生网页播放器填充跳过数据 ───

interface FetchAndFillParams {
    guid: string;
    trimId?: string;       // TMDB id（用于 theintrodb 兜底）
    season?: number;
    episode?: number;
}

interface FetchAndFillResult {
    filled: boolean;
    skipStart: number;
    skipEnd: number;
    source: 'fnos' | 'theintrodb' | 'none';
    message?: string;
}

/** 已填充过的 guid 去重集合（进程生命周期内） */
const filledGuids = new Set<string>();

/**
 * 把飞牛 trim_id 转换成 theintrodb 查询参数候选列表。
 * 飞牛的 trim_id 形态不定：
 *   - 纯数字 → TMDB id（如 94997）
 *   - "tt" + 数字 → 多为飞牛把 TMDB 数字 id 错加 tt 前缀（如 tt94997 → 实为 TMDB 94997）
 *   - 真实 IMDb id → tt + 7 位以上数字
 * 策略：优先用 tmdb_id（剥离 tt 前缀），失败再试 imdb_id。
 */
function buildIntroDbQueries(raw?: string): string[] {
    if (!raw) return [];
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) {
        return [`tmdb_id=${s}`];
    }
    const m = s.match(/^tt(\d+)$/i);
    if (m) {
        return [`tmdb_id=${m[1]}`, `imdb_id=${s}`];
    }
    return [];
}

/**
 * 核心流程：
 * 1. GET /api/v1/skipinfo/:guid → 查飞牛是否已有数据
 * 2. 若 SkipStart/SkipEnd 均为 0 → 调 theintrodb 兜底
 * 3. 有有效数据 → POST /api/v1/skipinfo 写回飞牛服务端
 */
async function handleFetchAndFill(
    _event: IpcMainInvokeEvent,
    params: FetchAndFillParams
): Promise<FetchAndFillResult> {
    const { guid, trimId, season, episode } = params;

    if (!guid) {
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: '缺少 guid' };
    }

    // 去重：同一 guid 进程内只填一次
    if (filledGuids.has(guid)) {
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: '已填充过' };
    }

    const config = fnConfig.readConfig() || {};
    const domain = config.domain || '';
    const token = config.token || '';
    const proxyBase = 'http://127.0.0.1:22346';

    // ── 从 fnOS PlayInfo 补查 trimId / season / episode / 总时长 ──
    // 始终查询：既补全元数据，又拿到视频总时长（片尾时长换算需要）
    let effectiveTrimId = trimId;
    let effectiveSeason = season;
    let effectiveEpisode = episode;
    let effectiveTotalDur = 0;

    if (domain && token) {
        try {
            const fnapi = new fn.ApiService(domain, token);
            const playResp = await fnapi.getPlayInfo(guid);
            if (playResp.success && playResp.data) {
                const item = playResp.data.item;
                if (!effectiveTrimId) effectiveTrimId = item?.trim_id || '';
                if (!effectiveSeason && item?.season_number) effectiveSeason = item.season_number;
                if (!effectiveEpisode && item?.episode_number) effectiveEpisode = item.episode_number;
                effectiveTotalDur = item?.duration || 0;
                log.info(`[skip:fetch-and-fill] 从 PlayInfo 补到元数据 guid=${guid} tmdb=${effectiveTrimId} s=${effectiveSeason} e=${effectiveEpisode} dur=${effectiveTotalDur}s`);
            }
        } catch (e) {
            log.warn(`[skip:fetch-and-fill] 查询 PlayInfo 失败:`, (e as Error).message);
        }
    }

    try {
        // ── Step 1: 查询飞牛已有跳过数据 ──
        let skipStart = 0;
        let skipEnd = 0;
        let source: 'fnos' | 'theintrodb' | 'none' = 'none';

        try {
            let cookie = '';
            try { cookie = await getSessionCookieHeader(domain); } catch (_) { /* 无 cookie 不阻断 */ }
            const getUrl = `${proxyBase}/api/v1/skipinfo/${guid}?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
            const getResp = await axios.get(getUrl, { timeout: 8000 });
            if (getResp.data?.code === 0 && getResp.data?.data) {
                skipStart = getResp.data.data.skipStart || 0;
                skipEnd = getResp.data.data.skipEnd || 0;
                if (skipStart > 0 || skipEnd > 0) {
                    source = 'fnos';
                    log.info(`[skip:fetch-and-fill] 飞牛已有跳过数据 guid=${guid} start=${skipStart} end=${skipEnd}`);
                }
            }
        } catch (e) {
            log.warn(`[skip:fetch-and-fill] 查询飞牛 skipinfo 失败:`, (e as Error).message);
        }

        // ── Step 2: 飞牛无数据 → theintrodb 兜底 ──
        // 飞牛 skipStart/skipEnd 语义 = 时长（秒）：片头从 0 跳过的秒数 / 片尾结尾跳过的秒数。
        // theintrodb intro.end_ms = 片头结束绝对位置（≈片头时长，因片头从 0 开始）；
        // credits.start_ms = 片尾开始绝对位置，片尾时长 = 总时长 − credits.start_ms。
        if (source === 'none') {
            const queries = buildIntroDbQueries(effectiveTrimId);
            for (const q of queries) {
                try {
                    let tidUrl = `https://api.theintrodb.org/v2/media?${q}`;
                    if (effectiveSeason && effectiveSeason > 0) {
                        tidUrl += `&season=${effectiveSeason}`;
                        if (effectiveEpisode && effectiveEpisode > 0) tidUrl += `&episode=${effectiveEpisode}`;
                    }
                    const tidResp = await axios.get(tidUrl, { timeout: 8000 });
                    const data = tidResp.data;
                    if (!data || data.error) {
                        log.warn(`[skip:fetch-and-fill] theintrodb (${q}) 无数据: ${data?.error || '空响应'}`);
                        continue; // 试下一个候选（tmdb → imdb）
                    }
                    // 片头：intro[0].end_ms（绝对结束位置 ≈ 片头时长）
                    if (data?.intro?.[0]?.end_ms) {
                        const introEnd = Math.round(data.intro[0].end_ms / 1000);
                        if (introEnd > 0) skipStart = introEnd;
                    }
                    // 片尾：总时长 − credits[0].start_ms（需视频总时长）
                    if (data?.credits?.[0]?.start_ms) {
                        if (effectiveTotalDur > 0) {
                            const credStart = Math.round(data.credits[0].start_ms / 1000);
                            const outroDur = effectiveTotalDur - credStart;
                            if (outroDur > 0 && outroDur < effectiveTotalDur / 2) {
                                skipEnd = outroDur;
                            } else {
                                log.warn(`[skip:fetch-and-fill] theintrodb 片尾时长异常(outro=${outroDur}s)，仅填片头`);
                            }
                        } else {
                            log.warn(`[skip:fetch-and-fill] 缺视频总时长，无法换算片尾时长，仅填片头`);
                        }
                    }
                    if (skipStart > 0 || skipEnd > 0) {
                        source = 'theintrodb';
                        log.info(`[skip:fetch-and-fill] theintrodb 兜底成功 (${q}) guid=${guid} start=${skipStart} end=${skipEnd}`);
                        break;
                    }
                } catch (e) {
                    log.warn(`[skip:fetch-and-fill] theintrodb 请求失败 (${q}):`, (e as Error).message);
                }
            }
        }

        // ── Step 3: theintrodb 兜底拿到数据 → 写回飞牛服务端 ──
        if (source === 'theintrodb' && (skipStart > 0 || skipEnd > 0)) {
            try {
                let cookie = '';
                try { cookie = await getSessionCookieHeader(domain); } catch (_) { /* ignore */ }
                const postUrl = `${proxyBase}/api/v1/skipinfo?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
                await axios.post(postUrl, {
                    guid,
                    skipStart,
                    skipEnd,
                }, { timeout: 8000 });

                filledGuids.add(guid);
                log.info(`[skip:fetch-and-fill] ✅ 已写入飞牛服务端 guid=${guid} source=${source} start=${skipStart} end=${skipEnd}`);
                return { filled: true, skipStart, skipEnd, source };
            } catch (e) {
                log.error(`[skip:fetch-and-fill] 写回飞牛失败:`, (e as Error).message);
                return { filled: false, skipStart, skipEnd, source, message: '写回飞牛服务端失败' };
            }
        }

        // 飞牛已有数据：直接返回（无需写回）
        if (source === 'fnos') {
            return { filled: true, skipStart, skipEnd, source };
        }

        // 无可用数据
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: '无可用跳过数据' };

    } catch (e) {
        log.error(`[skip:fetch-and-fill] 异常:`, e);
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: (e as Error).message };
    }
}

// 注册插件处理器
function init(): void {
    registerHandler('settings:get-smart-skip-enabled', handleGetSmartSkipEnabled, { useHandle: true });
    registerHandler('settings:set-smart-skip-enabled', handleSetSmartSkipEnabled, { useHandle: true });
    // [lc-316] 飞牛原生网页播放器自动填充跳过数据
    registerHandler('skip:fetch-and-fill', handleFetchAndFill, { useHandle: true });
}

export {
    init,
    handleGetSmartSkipEnabled,
    handleSetSmartSkipEnabled
};
