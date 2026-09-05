import { IpcMainInvokeEvent } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { writeSmartSkipEnabled } from './mpvConfig';
import { registerHandler } from '../core/ipcHandler';
import axios from 'axios';
import log from '../../../modules/logger';
import { getSessionCookieHeader } from '../../../modules/fn_api/request';
import * as fn from '../../../modules/fn_api/api';
import { resolveMalId } from '../../common/skipMalMap';

/**
 * 智能跳过片头片尾插件（smart_skip）— [lc-1058] 多源聚合重写
 * - 旧逻辑：fnOS skipinfo → theintrodb 兜底。theintrodb 靠人工审核，新番覆盖极稀疏，体验差。
 * - 新逻辑：四段源链，逐段兜底、全程磁盘缓存：
 *     ① fnOS skipinfo（服务端真值，用户手动标记优先）
 *     ② AniSkip（社区kip 时长库，动漫数据最全、区间为绝对秒且经社区投票校准；
 *        需 MAL id → 标题映射链：Bangumi 中文搜索(最强中文索引)取日文名
 *          → Jikan / AniList 双路搜日文名拿 idMal，映射结果按 TMDB id 缓存 30 天）
 *     ③ theintrodb（通用兜底，覆盖非动画剧集）
 *     → 拿到数据写回飞牛服务端（网页播放器面板直接有值）
 * - MPV 本地播放的静音检测 Lua（smart_skip/）保持不变，本插件只管数据管道。
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
    trimId?: string;       // TMDB id（用于 AniSkip 映射与 theintrodb）
    season?: number;
    episode?: number;
}

interface FetchAndFillResult {
    filled: boolean;
    skipStart: number;
    skipEnd: number;
    source: 'fnos' | 'aniskip' | 'theintrodb' | 'none';
    message?: string;
    /** [lc-1060] AniSkip recap（前情回顾）绝对区间（秒）；0 = 无。不写回飞牛，供网页播放器「跳过前情」按钮 */
    recapStart: number;
    recapEnd: number;
}

/** 已填充过的 guid 去重集合（进程生命周期内） */
const filledGuids = new Set<string>();

const HTTP_TIMEOUT = 8000;
const BGM_UA = 'fntv-plus/lc-1058 (https://github.com/YDMY007/Fntv-Plus)';

/** 把飞牛 trim_id 转换成 theintrodb 查询参数候选（tmdb_id 优先，剥离误加的 tt 前缀，真 IMDb 兜底） */
function buildIntroDbQueries(raw?: string): string[] {
    if (!raw) return [];
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return [`tmdb_id=${s}`];
    const m = s.match(/^tt(\d+)$/i);
    if (m) return [`tmdb_id=${m[1]}`, `imdb_id=${s}`];
    return [];
}

/** AniSkip 查询：episodeLength 敏感（差 1 秒都可能 500/不命中），按 ±1/±2 阶梯重试。
 *  [lc-1060] types 加 recap（前情回顾）——recap 不写回飞牛（fnOS 无此语义），透传给网页端「跳过前情」按钮。 */
async function aniskipFetch(malId: number, episode: number, durationSec: number):
    Promise<{ opStart: number; opEnd: number; edStart: number; edEnd: number; recapStart: number; recapEnd: number } | null> {
    const ladder = durationSec > 0
        ? [durationSec, durationSec + 1, durationSec - 1, durationSec + 2]
        : [0];
    for (const len of ladder) {
        try {
            const u = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}`
                + `?types%5B%5D=op&types%5B%5D=ed&types%5B%5D=recap&episodeLength=${Math.round(len)}`;
            const r = await axios.get(u, { timeout: HTTP_TIMEOUT, headers: { appId: 'fntv-plus' } });
            const j = r.data;
            if (!j || j.found !== true || !Array.isArray(j.results)) continue;
            const op = j.results.find((x: any) => x.skipType === 'op');
            const ed = j.results.find((x: any) => x.skipType === 'ed');
            const recap = j.results.find((x: any) => x.skipType === 'recap');
            if (!op && !ed && !recap) return null;
            return {
                opStart: op ? op.interval.startTime : 0,
                opEnd: op ? op.interval.endTime : 0,
                edStart: ed ? ed.interval.startTime : 0,
                edEnd: ed ? ed.interval.endTime : 0,
                recapStart: recap ? recap.interval.startTime : 0,
                recapEnd: recap ? recap.interval.endTime : 0,
            };
        } catch (e) {
            log.warn(`[skip:aniskip] 请求失败(len=${Math.round(len)}):`, (e as Error).message);
        }
    }
    return null;
}

/**
 * 核心流程（[lc-1058] 多源重写）：
 * 1. GET /api/v1/skipinfo/:guid → 查飞牛已有数据（服务端真值优先）
 * 2. 无数据 → AniSkip（动漫区间精确；需 MAL id → 标题映射链，映射缓存 30 天）
 * 3. 仍无 → theintrodb 兜底（非动画剧集）
 * 4. 拿到数据 → POST /api/v1/skipinfo 写回飞牛服务端
 */
async function handleFetchAndFill(
    _event: IpcMainInvokeEvent,
    params: FetchAndFillParams
): Promise<FetchAndFillResult> {
    const { guid, trimId, season, episode } = params;

    if (!guid) {
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: '缺少 guid', recapStart: 0, recapEnd: 0 };
    }

    // 去重：同一 guid 进程内只填一次
    if (filledGuids.has(guid)) {
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', message: '已填充过', recapStart: 0, recapEnd: 0 };
    }

    const config = fnConfig.readConfig() || {};
    const domain = config.domain || '';
    const token = config.token || '';
    const proxyBase = 'http://127.0.0.1:22346';

    // ── 从 fnOS PlayInfo 补查 trimId / season / episode / 总时长 / 剧名 ──
    let effectiveTrimId = trimId;
    let effectiveSeason = season;
    let effectiveEpisode = episode;
    let effectiveTotalDur = 0;
    let showTitle = '';

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
                // 剧名：parent_title = 所属剧集名（映射用它，不用集标题）
                showTitle = String((item && (item.parent_title || item.title)) || '').trim();
                // 集标题剥掉「第 N 集/话」前缀，尽量还原剧名供映射使用
                showTitle = showTitle.replace(/^第\s*\d+\s*[集话話期]\s*/, '').trim();
                log.info(`[skip:fetch-and-fill] PlayInfo 元数据 guid=${guid} tmdb=${effectiveTrimId} s=${effectiveSeason} e=${effectiveEpisode} dur=${effectiveTotalDur}s title=${showTitle}`);
            }
        } catch (e) {
            log.warn(`[skip:fetch-and-fill] 查询 PlayInfo 失败:`, (e as Error).message);
        }
    }

    try {
        // ── Step 1: 查询飞牛已有跳过数据 ──
        let skipStart = 0;
        let skipEnd = 0;
        let recapStart = 0; // [lc-1060] 前情回顾绝对区间（秒），不写回飞牛
        let recapEnd = 0;
        let source: 'fnos' | 'aniskip' | 'theintrodb' | 'none' = 'none';

        try {
            let cookie = '';
            try { cookie = await getSessionCookieHeader(domain); } catch (_) { /* 无 cookie 不阻断 */ }
            const getUrl = `${proxyBase}/api/v1/skipinfo/${guid}?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
            const getResp = await axios.get(getUrl, { timeout: HTTP_TIMEOUT });
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

        // ── Step 2: AniSkip（动漫社区库：区间绝对秒、社区投票校准，新番覆盖远好于人工审核库）──
        // fnOS 语义换算：skipStart = 片头从 0 跳过的秒数 → 取 OP 区间终点；
        //               skipEnd = 片尾结尾跳过的秒数 → 总时长 − ED 区间起点。
        // [lc-1060] 飞牛已有数据(source=fnos)时仍查询 AniSkip —— 为拿 recap（前情回顾），
        //           但 op/ed 换算仅在飞牛无真值时进行（不覆盖服务端真值）。
        if ((source === 'none' || source === 'fnos') && effectiveEpisode && effectiveEpisode > 0) {
            try {
                let malId: number | null = null;
                if (effectiveTrimId && /^\d+$/.test(String(effectiveTrimId).trim()) && showTitle) {
                    malId = await resolveMalId(String(effectiveTrimId).trim(), showTitle);
                }
                if (malId) {
                    const seg = await aniskipFetch(malId, effectiveEpisode, effectiveTotalDur);
                    if (seg) {
                        // recap 独立于 op/ed 采集（有总时长时做越界守卫）
                        if (seg.recapStart > 0 && seg.recapEnd > seg.recapStart
                            && (!effectiveTotalDur || seg.recapEnd < effectiveTotalDur)) {
                            recapStart = Math.round(seg.recapStart);
                            recapEnd = Math.round(seg.recapEnd);
                        }
                        if (source === 'none') {
                            if (seg.opEnd > 0 && seg.opEnd < effectiveTotalDur) skipStart = Math.round(seg.opEnd);
                            if (seg.edStart > 0 && effectiveTotalDur > 0) {
                                const outro = Math.round(effectiveTotalDur - seg.edStart);
                                if (outro > 0 && outro < effectiveTotalDur / 2) skipEnd = outro;
                                else log.warn(`[skip:fetch-and-fill] AniSkip 片尾时长异常(outro=${outro}s)，仅填片头`);
                            }
                            if (skipStart > 0 || skipEnd > 0) {
                                source = 'aniskip';
                                log.info(`[skip:fetch-and-fill] ✅ AniSkip 命中 guid=${guid} start=${skipStart} end=${skipEnd} (op ${seg.opStart}→${seg.opEnd} / ed ${seg.edStart}→${seg.edEnd})`);
                            }
                        }
                    }
                }
            } catch (e) {
                log.warn('[skip:fetch-and-fill] AniSkip 分支异常:', (e as Error).message);
            }
        }

        // ── Step 3: theintrodb 兜底（通用库，非动画剧集仍有价值）──
        // fnOS skipStart/skipEnd 语义 = 时长（秒）：片头从 0 跳过的秒数 / 片尾结尾跳过的秒数。
        // theintrodb intro.end_ms = 片头结束绝对位置；credits.start_ms = 片尾开始绝对位置。
        if (source === 'none') {
            const queries = buildIntroDbQueries(effectiveTrimId);
            for (const q of queries) {
                try {
                    // [lc-338] theintrodb v3 /media，附带 duration_ms 匹配正确发行版本
                    let tidUrl = `https://api.theintrodb.org/v3/media?${q}`;
                    if (effectiveSeason && effectiveSeason > 0) {
                        tidUrl += `&season=${effectiveSeason}`;
                        if (effectiveEpisode && effectiveEpisode > 0) tidUrl += `&episode=${effectiveEpisode}`;
                    }
                    if (effectiveTotalDur > 0) {
                        tidUrl += `&duration_ms=${Math.round(effectiveTotalDur * 1000)}`;
                    }
                    const tidResp = await axios.get(tidUrl, { timeout: HTTP_TIMEOUT });
                    const data = tidResp.data;
                    if (!data || data.error) {
                        log.warn(`[skip:fetch-and-fill] theintrodb (${q}) 无数据: ${data?.error || '空响应'}`);
                        continue;
                    }
                    if (data?.intro?.[0]?.end_ms) {
                        const introEnd = Math.round(data.intro[0].end_ms / 1000);
                        if (introEnd > 0) skipStart = introEnd;
                    }
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

        // ── Step 4: 外部源拿到数据 → 写回飞牛服务端 ──
        if (source !== 'none' && source !== 'fnos' && (skipStart > 0 || skipEnd > 0)) {
            try {
                let cookie = '';
                try { cookie = await getSessionCookieHeader(domain); } catch (_) { /* ignore */ }
                const postUrl = `${proxyBase}/api/v1/skipinfo?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
                await axios.post(postUrl, {
                    guid,
                    skipStart,
                    skipEnd,
                }, { timeout: HTTP_TIMEOUT });

                filledGuids.add(guid);
                log.info(`[skip:fetch-and-fill] ✅ 已写入飞牛服务端 guid=${guid} source=${source} start=${skipStart} end=${skipEnd}`);
                return { filled: true, skipStart, skipEnd, source, recapStart, recapEnd };
            } catch (e) {
                log.error(`[skip:fetch-and-fill] 写回飞牛失败:`, (e as Error).message);
                return { filled: false, skipStart, skipEnd, source, message: '写回飞牛服务端失败', recapStart, recapEnd };
            }
        }

        // 飞牛已有数据：直接返回（无需写回）
        if (source === 'fnos') {
            filledGuids.add(guid);
            return { filled: true, skipStart, skipEnd, source, recapStart, recapEnd };
        }

        // 无可用数据
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', recapStart, recapEnd, message: '无可用跳过数据' };

    } catch (e) {
        log.error(`[skip:fetch-and-fill] 异常:`, e);
        return { filled: false, skipStart: 0, skipEnd: 0, source: 'none', recapStart: 0, recapEnd: 0, message: (e as Error).message };
    }
}

// ─── [lc-1063] 自动连播：查询下一集（网页播放器倒计时卡片数据源） ───

interface NextEpisodeResult {
    found: boolean;
    guid?: string;
    title?: string;
    poster?: string;
    duration?: number;
    episode?: number;
    message?: string;
}

async function handleNextEpisode(_event: IpcMainInvokeEvent, guid: string): Promise<NextEpisodeResult> {
    if (!guid) return { found: false, message: '缺少 guid' };
    try {
        const config = fnConfig.readConfig() || {};
        const domain = config.domain || '';
        const token = config.token || '';
        if (!domain || !token) return { found: false, message: '未登录' };
        const fnapi = new fn.ApiService(domain, token);
        const playResp = await fnapi.getPlayInfo(guid);
        if (!playResp.success || !playResp.data) return { found: false, message: '读取播放信息失败' };
        const info = playResp.data;
        const item = info.item;
        if (String(item.type || info.type || '') !== 'Episode') {
            return { found: false, message: '非剧集内容无下一集' };
        }
        const seasonGuid = info.parent_guid || item.parent_guid || '';
        if (!seasonGuid) return { found: false, message: '缺少剧季 guid' };

        // 列表接口带 600s 缓存：同一季连播时后续查询零开销
        const resp = await fnapi.getItemListCached({
            parent_guid: seasonGuid,
            exclude_folder: 1,
            sort_column: 'index_number',
            sort_type: 'ASC',
        });
        const list: any[] = resp?.data?.list || [];
        const episodes = list
            .filter((it: any) => String(it.type || '').toLowerCase() === 'episode' && it.guid)
            .sort((a: any, b: any) => (a.index_number || 0) - (b.index_number || 0));
        let idx = episodes.findIndex((it: any) => it.guid === guid);
        if (idx < 0) idx = episodes.findIndex((it: any) => (it.episode_number || 0) === (item.episode_number || -1));
        const next = idx >= 0 ? episodes[idx + 1] : null;
        if (!next) return { found: false, message: '已是本季最后一集' };
        return {
            found: true,
            guid: String(next.guid),
            title: String(next.title || ''),
            poster: String(next.poster || ''),
            duration: Number(next.duration || 0),
            episode: Number(next.episode_number || 0),
        };
    } catch (e) {
        log.warn('[skip:next-episode] 查询失败:', (e as Error).message);
        return { found: false, message: (e as Error).message };
    }
}

// 注册插件处理器
function init(): void {
    registerHandler('settings:get-smart-skip-enabled', handleGetSmartSkipEnabled, { useHandle: true });
    registerHandler('settings:set-smart-skip-enabled', handleSetSmartSkipEnabled, { useHandle: true });
    // [lc-316] 飞牛原生网页播放器自动填充跳过数据
    registerHandler('skip:fetch-and-fill', handleFetchAndFill, { useHandle: true });
    // [lc-1063] 自动连播：查询下一集
    registerHandler('skip:next-episode', handleNextEpisode, { useHandle: true });
}

export {
    init,
    handleGetSmartSkipEnabled,
    handleSetSmartSkipEnabled,
    resolveMalId,
    aniskipFetch,
    handleFetchAndFill,
    handleNextEpisode,
    resolveMalId as resolveMalIdForTests
};
