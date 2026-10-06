import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
import * as danmuApi from './danmuApi';
import * as dandanplay from './dandanplay';
const log = logger.component('biliRunner');

/**
 * 主进程内的 B站弹幕运行器。
 *
 * 取代旧方案「spawn 外部 Python 跑 bili_danmaku.py」：bili_danmaku.js 是纯 Node 内置模块，
 * 而 Node 运行时本就包含在 electron.exe 内，因此可直接在【主进程内 require 并运行】，
 * 无需捆绑 ~20MB 的 Python 安装包，也不依赖用户本机装有 node/python。
 *
 * 消费者都走这里（也因此这里是弹幕源优选的唯一挂载点，见下）：
 *   - MPV / Lua（extra.lua / menu.lua / main.lua）：经本地 shim(127.0.0.1:22347) 的三个 danmaku 端点触发；
 *   - 原生网页播放器的弹幕 overlay（danmakuWeb.ts → biliDanmaku.ts:436 getDanmakuItems）：直接调 runBiliDanmaku()；
 *   - PotPlayer 链路（biliDanmaku.ts:54 fetchBiliDanmakuXml → ASS）：同入口，当前已无调用方（弹幕触发在 potplayer.ts 移除）。
 *
 * [lc-1101] 三个入口在跑内置 bili_danmaku.js 之前先问一次自建弹幕接口（danmuApi）：
 * 用户配置了 danmu_api 就作为优选源，命中即用；未启用/未命中一律降级回下面的内置 B站 链路。
 */

/**
 * [lc-1226] 单个弹幕源在本集的实际结果，供「弹幕详情」把三个来源各自的情况都写清楚。
 * 三来源的优先级链：弹弹play（MPV：匹配剧集并取弹幕）→ 自建 danmu_api（优选）→ 内置 B站（兜底）。
 * 网页播放器链路没有弹弹play（弹弹play 是 MPV 的 Lua 脚本在用），那条链路只有后两个来源，
 * 详情面板据此把弹弹play 标为「不适用」而不是伪造一条「未命中」。
 */
export interface DanmakuSourceTrace {
    /** 'dandanplay' | 'danmu_api' | 'bilibili' */
    id: 'dandanplay' | 'danmu_api' | 'bilibili';
    /** 该源是否参与了本次取弹幕 */
    attempted: boolean;
    /** 未参与的原因（如未启用/未配置），attempted=false 时有意义 */
    skippedReason?: string;
    /** 是否由该源提供了最终弹幕 */
    used: boolean;
    /** 命中/失败的一句话结论，直接给用户看 */
    detail?: string;
    /** 该源取到的弹幕条数（used=true 时为实际使用条数） */
    count?: number;
    /** 失败根因（attempted 且 !used 时展示） */
    error?: string;
}

export interface BiliDanmakuResult {
    ok: boolean;
    bvid?: string | null;
    title?: string;
    matched_title?: string;
    sim?: number | null;
    danmaku_count?: number;
    source?: string;
    cid?: any;
    aggregated_from?: any;
    cookie_status?: string;   // 'valid' | 'expired' | 'missing'，由 bili_danmaku.js run() 透传
    error?: string;
    // [lc-607] 番剧区(正版)无 bvid, 透传 season_id/epid 供 MPV 配置面板显示 ep_id
    season_id?: string | number | null;
    epid?: string | number | null;
    /** [lc-1265] 错季标记：true = 请求第N季但 B站首选候选与该季不符（Lua 据此强制回退弹弹play /comment） */
    season_mismatch?: boolean;
    /** [lc-1226] 三来源各自的尝试结果（详情面板用） */
    sources?: DanmakuSourceTrace[];
    /** [lc-1288] 自建源命中但低于聚合阈值时叠加内置B站：两源各自的条数（详情面板用） */
    self_count?: number;
    bilibili_count?: number;
}

export interface BiliCandidate {
    index: number;
    cid: any;
    bvid: string | null;
    title: string;
    source: string;
    season: number;
    is_compilation: boolean;
    sim: number | null;
}

export interface BiliCandidatesResult {
    ok: boolean;
    candidates?: BiliCandidate[];
    error?: string;
    /** [lc-1261] 自建源候选的参与情况：供 MPV 候选菜单说明「自建源为何没出现」 */
    selfHosted?: {
        active: boolean;    // 自建源是否已启用（未启用时 UI 提示去设置里开）
        matched: boolean;   // 本次搜索自建源是否命中
        count: number;      // 自建源候选个数
    };
}

let cachedModule: any = null;
let logSinkBound = false;

// ---- 候选 uosc_danmaku 脚本目录（与 biliCookie.ts / biliDanmaku.ts 保持一致）----
// [lc-1288] 导出：每日 Cookie 体检的状态文件也要写进这个目录（供 MPV Lua 菜单同步读取）
export function resolveDanmakuScriptDir(): string | null {
    const candidates: string[] = [];
    // 仅在打包态使用 resourcesPath：dev 下它指向 node_modules/electron/dist/resources，
    // 并非应用资源目录；往里写会污染 node_modules 并制造「存在但缺 bili_danmaku.js」的阴影目录。
    if (app.isPackaged && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    }
    try {
        candidates.push(path.join(app.getAppPath(), 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    } catch (_) { /* ignore */ }
    // 打包态 MPV 实际脚本目录：exe 同目录 portable_config（extraFiles 解压，可写）
    try {
        candidates.push(path.join(path.dirname(app.getPath('exe')), 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    } catch (_) { /* ignore */ }
    if (process.platform === 'win32') {
        candidates.push(path.join(process.env.LOCALAPPDATA || '', '..', 'Roaming', 'mpv', 'scripts', 'uosc_danmaku'));
    } else {
        candidates.push(path.join(process.env.HOME || '', '.config', 'mpv', 'scripts', 'uosc_danmaku'));
    }
    // 关键修复：目录存在 ≠ 脚本齐备。必须确认 bili_danmaku.js 真实存在，
    // 否则会命中「存在但缺文件」的候选（如 dev 下 resourcesPath 目录被 cookie 落盘创建、
    // 却不含 bili_danmaku.js），导致加载失败。优先选含脚本的目录。
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.existsSync(path.join(c, 'bili_danmaku.js'))) return c;
    }
    // 兜底：保守返回首个存在的目录（保持旧行为，便于报错信息指向真实路径）
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function loadModule(): any {
    if (cachedModule) return cachedModule;
    const dir = resolveDanmakuScriptDir();
    if (!dir) {
        throw new Error('未找到 uosc_danmaku 脚本目录，无法加载 bili_danmaku.js');
    }
    const jsPath = path.join(dir, 'bili_danmaku.js');
    if (!fs.existsSync(jsPath)) {
        throw new Error('bili_danmaku.js 不存在: ' + jsPath);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(jsPath);
    if (!logSinkBound && typeof mod.setLogSink === 'function') {
        // 把弹幕脚本内部日志转发到主进程 logger（进 app.log），便于排查
        mod.setLogSink((line: string) => log.info('[bili_danmaku] ' + line));
        logSinkBound = true;
    }
    cachedModule = mod;
    return mod;
}

// ===================== [lc-1288] 弹幕 XML 合并工具 =====================
// 背景：自建源命中但条数低于聚合阈值时，需要叠加内置 B站 的弹幕。两条链路各自把
// bilibili 格式的 XML 写到磁盘（danmuApi 写原始 <i> 根，bili_danmaku.js 写 <danmaku> 根），
// 消费方（Lua / 网页解析）只认 <d p="...">text</d> 条目，因此按条目级抽行合并即可，
// 统一重写为 <danmaku> 根（与 _write_xml 输出一致）。
const DM_LINE_RE = /<d\s[^>]*p="[^"]*"[^>]*>[\s\S]*?<\/d>/g;

/** 读取弹幕 XML 里的全部 <d ...>...</d> 条目行（文件不存在/解析为空返回 []）。 */
function readDanmakuLines(file: string): string[] {
    try {
        if (!fs.existsSync(file)) return [];
        const body = fs.readFileSync(file, 'utf8');
        const lines = body.match(DM_LINE_RE) || [];
        return lines.map((l) => l.trim()).filter(Boolean);
    } catch (e: any) {
        log.warn('[biliRunner] 读取弹幕 XML 失败: ' + (e?.message || e) + ' | ' + file);
        return [];
    }
}

/** 以 <danmaku> 根重写弹幕 XML（条目行去重：同 p 同文本视为同一条）。 */
function writeMergedDanmakuXml(out: string, lines: string[]): number {
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const l of lines) {
        if (seen.has(l)) continue;
        seen.add(l);
        uniq.push(l);
    }
    const dir = path.dirname(out);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body = ['<?xml version="1.0" encoding="UTF-8"?>', '<danmaku>', ...uniq, '</danmaku>'].join('\n');
    fs.writeFileSync(out, body + '\n', 'utf8');
    return uniq.length;
}

/**
 * 在主进程内运行 bili_danmaku.js，获取 B站弹幕并写出 XML 到 out。
 * @param title   干净番名
 * @param ep      集数（0=仅标题搜索）
 * @param out     输出 XML 路径（run 内部会确保父目录存在）
 * @param threshold 聚合阈值（可选，默认 1500）
 * @param season  季数（可选，0/undefined=不启用季过滤；>0 时优先精确匹配该季，根治跨季错配）
 * @param timeoutMs 超时保护（默认 60000ms），超时返回 {ok:false}
 * @param epTitle [lc-1220] 播放侧本集标题（供自建源核验未标季条目的分集归属；空串=无核验材料）
 * @returns 结果对象（ok=true 表示成功并写出 XML）
 */
/**
 * 内置 B站 链路：带超时保护地运行 bili_danmaku.js run()。
 * [lc-1288] 从 runBiliDanmaku 主体抽出，供「首次获取」与「自建源低于阈值叠加合并」共用。
 */
async function runBiliChain(
    title: string,
    ep: number | string,
    out: string,
    threshold?: number | string,
    season?: number | string,
    timeoutMs = 60000,
    altTitle = '',
): Promise<BiliDanmakuResult> {
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        // [lc-1265] altTitle 一路透传进 bili_danmaku.js run()：脏番名官方区 0 命中时，
        // 脚本内用「整串→番名首段→alt」换词重试（石纪元S2 实机：fnOS 原标题此前在这被丢弃）。
        const runP = Promise.resolve(mod.run(title, ep, out, threshold, season, altTitle || ''));
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutP = new Promise<BiliDanmakuResult>((resolve) => {
            timeoutHandle = setTimeout(() => resolve({ ok: false, error: `弹幕获取超时(${timeoutMs}ms)` }), timeoutMs);
        });
        const r = await Promise.race([runP, timeoutP]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return (r && typeof r === 'object') ? r : { ok: false, error: '未知错误（run 无返回）' };
    } catch (e: any) {
        log.warn('[biliRunner] run 异常: ' + (e?.message || e));
        return { ok: false, error: String(e?.message || e) };
    }
}

export async function runBiliDanmaku(
    title: string,
    ep: number | string,
    out: string,
    threshold?: number | string,
    season?: number | string,
    timeoutMs = 60000,
    allowBiliFallback = true,
    epTitle = '',
    seriesKey = '',
    altTitle = '',   // [lc-1262] fnOS 原标题（备用搜索词：弹弹play 给日文名、自建源只有中文名时用）
): Promise<BiliDanmakuResult> {
    // [lc-1226] 逐源记录本次尝试结果，随结果回传给两处「弹幕详情」面板，
    // 让用户看到三个来源各自是被跳过、试过没中、还是提供了最终弹幕。
    const traces: DanmakuSourceTrace[] = [];

    // [lc-1101] 自建弹幕接口（danmu_api）优选：命中即返回，未命中(null)原样降级到下面的内置 B站 链路。
    //   放在 loadModule() 之前，命中时连 bili_danmaku.js 都不必加载。
    const danmuApiId = danmuApi.selfHostedSourceLabel();
    const apiActive = danmuApi.isActive();
    if (!apiActive) {
        traces.push({
            id: 'danmu_api', attempted: false, used: false,
            skippedReason: danmuApi.isEnabledButInvalid()
                ? '已开启但服务地址为空/非法（到「弹幕设置 → 自建弹幕接口」填写地址）'
                : '未启用（到「弹幕设置 → 自建弹幕接口」开启，或从内置 B站 获取）',
        });
    }
    const pre = await danmuApi.autoFetch(String(title || ''), Number(ep) || 0, out, Number(season) || 0, epTitle, seriesKey, altTitle);
    if (pre) {
        // [lc-1288] 自建源命中但条数低于聚合阈值 → 不再短路，继续跑内置 B站 并按条目合并。
        // 旧逻辑「命中即用」让 renren 这类只有个位数弹幕的条目直接终结整条链路，
        // B站 上两万条弹幕的官方正片永远轮不到（用户实测：自建源仅 1 条也直接用）。
        const th = Number(threshold) || 0;
        const selfCount = Number(pre.danmaku_count) || 0;
        if (th > 0 && selfCount < th && pre.ok) {
            const selfLines = readDanmakuLines(out);
            if (selfLines.length > 0) {
                // B站 写临时文件：失败时自建源 XML（out）原样保留，成功时合并回写 out
                const tmpOut = out + '.bili.tmp.xml';
                const biliRes = await runBiliChain(title, ep, tmpOut, threshold, season, timeoutMs, altTitle);
                if (biliRes && biliRes.ok) {
                    const biliLines = readDanmakuLines(tmpOut);
                    const mergedCount = writeMergedDanmakuXml(out, [...biliLines, ...selfLines]);
                    try { fs.unlinkSync(tmpOut); } catch (_) { /* 清理失败无害，下次覆盖 */ }
                    log.info(`[biliRunner] 自建源 ${selfLines.length} 条低于阈值(${th}) → 已叠加内置B站 ${biliLines.length} 条，合并去重后 ${mergedCount} 条`);
                    traces.push({
                        id: 'danmu_api', attempted: true, used: true,
                        detail: pre.matched_title
                            ? `命中《${pre.matched_title}》（精确匹配，${selfLines.length} 条低于阈值，已叠加内置B站）`
                            : `精确匹配命中（${selfLines.length} 条低于阈值，已叠加内置B站）`,
                        count: selfLines.length,
                    });
                    traces.push({
                        id: 'bilibili', attempted: true, used: true,
                        detail: biliRes.matched_title ? `命中《${biliRes.matched_title}》` : '匹配成功',
                        count: biliLines.length,
                    });
                    traces.push({
                        id: 'dandanplay', attempted: false, used: false,
                        skippedReason: '前两源已合并命中，未启用（兜底源按需使用）',
                    });
                    return {
                        ...biliRes,
                        danmaku_count: mergedCount,
                        source: 'danmu_api+bilibili',
                        self_count: selfLines.length,
                        bilibili_count: biliLines.length,
                        sources: traces,
                    };
                }
                // B站 链路失败：保留自建源弹幕（out 未被触碰），如实标注失败根因
                log.warn('[biliRunner] 自建源低于阈值但内置B站叠加失败，仅用自建源: ' + ((biliRes && biliRes.error) || '未知'));
                traces.push({
                    id: 'danmu_api', attempted: true, used: true,
                    detail: pre.matched_title ? `命中《${pre.matched_title}》（精确匹配）` : '精确匹配命中',
                    count: pre.danmaku_count,
                });
                traces.push({
                    id: 'bilibili', attempted: true, used: false,
                    error: ((biliRes && biliRes.error) || '未知错误') + '（叠加失败，仅用自建源弹幕）',
                });
                return { ...pre, sources: traces };
            }
        }
        traces.push({
            id: 'danmu_api', attempted: true, used: true,
            detail: pre.matched_title ? `命中《${pre.matched_title}》（精确匹配）` : '精确匹配命中',
            count: pre.danmaku_count,
        });
        // 自建源命中 → 内置 B站 本轮未参与，如实标注（不是失败，是没轮到）
        traces.push({
            id: 'bilibili', attempted: false, used: false,
            skippedReason: '自建源已命中，无需兜底',
        });
        traces.push({
            id: 'dandanplay', attempted: false, used: false,
            skippedReason: '自建源已命中，未启用（兜底源按需使用）',
        });
        return { ...pre, sources: traces };
    }
    // [lc-1266] 失败根因用 danmuApi 的「人话版」：地址不可达（含各地址明细，如节点没运行）、
    // 服务正常但无精确匹配、条目弹幕为空…… 直接显示在 MPV「B站弹幕配置」菜单的
    // 「① 自建弹幕接口」一行——对标「B站 Cookie 状态」的一眼可判，不再只有笼统的「未命中」。
    traces.push({
        id: 'danmu_api', attempted: true, used: false,
        error: danmuApi.consumeLastFailReason() || '未命中（只认精确匹配；未命中即自动降级内置 B站 模糊匹配）',
    });

    // [lc-1117] 网页弹幕设置可单独关掉「B站弹幕搜索」兜底（只影响网页链路；MPV 侧由 Lua 的
    //   bili_search_enabled 门控且不传此参）。手动候选搜索 runBiliDanmakuCandidates 不受限。
    if (!allowBiliFallback) {
        log.info('[biliRunner] B站弹幕搜索未启用（网页弹幕设置），跳过内置 B站降级');
        traces.push({
            id: 'bilibili', attempted: false, used: false,
            skippedReason: '「B站弹幕搜索」已关闭（网页弹幕设置里可重新开启）',
        });
        // [lc-1302] 用户显式关掉 B站 兜底 = 只用自建源：弹弹play 一并跳过（尊重配置，不偷偷扩源）
        traces.push({
            id: 'dandanplay', attempted: false, used: false,
            skippedReason: '「B站弹幕搜索」已关闭，未启用（兜底源按需使用）',
        });
        return { ok: false, error: 'B站弹幕搜索未启用', sources: traces };
    }
    try {
        const r = await runBiliChain(title, ep, out, threshold, season, timeoutMs, altTitle);
        traces.push(r.ok
            ? {
                id: 'bilibili', attempted: true, used: true,
                detail: r.matched_title ? `命中《${r.matched_title}》` : '匹配成功',
                count: r.danmaku_count,
            }
            : { id: 'bilibili', attempted: true, used: false, error: r.error || '未知错误' });
        // [lc-1302] B站 也未命中 → 弹弹play 兜底（官方约定弹幕库按需使用，故置于两源之后；
        //   命中即写 XML 到同一 out，返回同契约结果。失败/未命中保留 B站 的失败根因原样返回。）
        if (!r.ok) {
            const ddp = await dandanplay.autoFetchBili(String(title || ''), Number(ep) || 0, Number(season) || 0, out);
            if (ddp.ok) {
                traces.push({
                    id: 'dandanplay', attempted: true, used: true,
                    detail: ddp.matched_title ? `命中《${ddp.matched_title}》` : '匹配成功',
                    count: ddp.danmaku_count,
                });
                return { ...ddp, sources: traces };
            }
            traces.push({ id: 'dandanplay', attempted: true, used: false, error: ddp.error || '弹弹play 未命中' });
        }
        return { ...r, sources: traces };
    } catch (e: any) {
        log.warn('[biliRunner] run 异常: ' + (e?.message || e));
        traces.push({ id: 'bilibili', attempted: true, used: false, error: String(e?.message || e) });
        return { ok: false, error: String(e?.message || e), sources: traces };
    }
}

/** 仅供测试/诊断：强制下次重新加载模块（例如脚本目录变化后）。 */
export function resetBiliModule(): void {
    cachedModule = null;
    logSinkBound = false;
}

/**
 * [lc-1300] 清除某剧的弹幕源锁定（bili_danmaku.js 的 danmaku_source_cache.json 键）。
 * 网页端「清除弹幕」链路：自动匹配错了 → 清掉记忆，下次自动匹配重新全量搜索/手动重选。
 * @returns 是否确实清掉了已存在的锁定（本来就没锁返回 false，不算失败）
 */
export function clearBiliSourceLock(title: string): boolean {
    try {
        const mod = loadModule();
        if (typeof mod.clear_source_cache !== 'function') return false;
        return !!mod.clear_source_cache(title);
    } catch (e: any) {
        log.warn('[biliRunner] 清除弹幕源锁定失败: ' + (e?.message || e));
        return false;
    }
}

export interface BiliCookieStatus {
    ok: boolean;
    /** 'valid' | 'expired' | 'missing' | 'error' */
    cookie_status: string;
    uname?: string | null;
    reason?: string | null;
    err?: string | null;
}

/**
 * [lc-1288] B站 Cookie 体检：调 bili_danmaku.js 的 nav 校验（与每次 run 内部同一套逻辑）。
 * 供 playbackShim 的每日定时任务调用，结果写状态文件 + 推送前端详情面板。
 */
export async function checkBiliCookie(): Promise<BiliCookieStatus> {
    try {
        const mod = loadModule();
        if (typeof mod.cookie_check !== 'function') {
            return { ok: false, cookie_status: 'error', reason: '脚本无 cookie_check（版本过旧）' };
        }
        const r = await Promise.resolve(mod.cookie_check());
        return (r && typeof r === 'object')
            ? r
            : { ok: false, cookie_status: 'error', reason: 'cookie_check 无返回' };
    } catch (e: any) {
        return { ok: false, cookie_status: 'error', reason: String(e?.message || e) };
    }
}

/**
 * 仅搜索 B站 候选视频列表（标题/bvid/来源/是否合集），不拉取/聚合弹幕。
 * 供 MPV 侧「手动搜索」展示候选列表，由用户选定具体视频。
 * [lc-1261] 双源合并：自建源与 B站 候选同时展示（自建源优先排前）。旧版是二选一
 *   （自建源命中则只出它、未命中才出 B站）——用户手动搜索时看不到全貌：命中时不知道
 *   B站 还有哪些可选，未命中时误以为自建源不支持手动搜索。另附 selfHosted 状态供 UI 说明。
 */
export async function runBiliDanmakuCandidates(
    title: string,
    ep: number | string,
    season?: number | string,
    timeoutMs = 60000,
): Promise<BiliCandidatesResult> {
    const selfP: Promise<BiliCandidate[] | null> = danmuApi
        .candidates(String(title || ''), Number(ep) || 0, Number(season) || 0)
        .catch(() => null);

    // [lc-1302] 弹弹play 候选（ddp:<episodeId> 伪 id）与自建源并列参与手动搜索
    const ddpP: Promise<BiliCandidate[]> = dandanplay
        .candidates(String(title || ''), Number(ep) || 0, Number(season) || 0)
        .catch(() => [] as BiliCandidate[]);

    const biliP = (async (): Promise<BiliCandidatesResult> => {
        let mod: any;
        try {
            mod = loadModule();
        } catch (e: any) {
            log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
            return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
        }
        try {
            const runP = Promise.resolve(mod.search_candidates(title, ep, season));
            let timeoutHandle: NodeJS.Timeout | null = null;
            const timeoutP = new Promise<BiliCandidatesResult>((resolve) => {
                timeoutHandle = setTimeout(() => resolve({ ok: false, error: `候选搜索超时(${timeoutMs}ms)` }), timeoutMs);
            });
            const r = await Promise.race([runP, timeoutP]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            return (r && typeof r === 'object') ? r : { ok: false, error: '未知错误（search_candidates 无返回）' };
        } catch (e: any) {
            log.warn('[biliRunner] search_candidates 异常: ' + (e?.message || e));
            return { ok: false, error: String(e?.message || e) };
        }
    })();

    const [selfCands, ddpCands, biliRes] = await Promise.all([selfP, ddpP, biliP]);
    const selfList: BiliCandidate[] = Array.isArray(selfCands) ? selfCands : [];
    const ddpList: BiliCandidate[] = Array.isArray(ddpCands) ? ddpCands : [];
    const biliList: BiliCandidate[] = (biliRes && biliRes.ok && Array.isArray(biliRes.candidates))
        ? biliRes.candidates : [];

    const merged: BiliCandidate[] = [];
    selfList.forEach((c, i) => { c.index = i; merged.push(c); });
    ddpList.forEach((c, i) => { c.index = selfList.length + i; merged.push(c); });
    biliList.forEach((c, i) => { c.index = selfList.length + ddpList.length + i; merged.push(c); });

    const selfStatus = {
        active: danmuApi.isActive(),
        matched: selfList.length > 0,
        count: selfList.length,
    };
    log.info(`[biliRunner] 候选合并：自建源 ${selfList.length} 个（${selfStatus.active ? '已启用' : '未启用'}） + 弹弹play ${ddpList.length} 个 + B站 ${biliList.length} 个`);

    if (!merged.length) {
        return { ok: false, error: (biliRes && biliRes.error) || '未找到候选', selfHosted: selfStatus };
    }
    return { ok: true, candidates: merged, selfHosted: selfStatus };
}

/**
 * 由用户选定的 bvid 直接拉取该视频弹幕（手动搜索：用户已明确选定视频）。
 */
export async function runBiliDanmakuByBvid(
    title: string,
    bvid: string,
    out: string,
    threshold?: number | string,
    epNum = 0,
    timeoutMs = 60000,
    forceCid?: number | string,   // [lc-1195] 用户从分P 列表手动选定的 cid（直接用，跳过 ep_num 匹配）
    seriesKey = '',               // [lc-1259] 系列记忆键（季 guid）：手动选定自建源条目时播种记忆
): Promise<BiliDanmakuResult> {
    // [lc-1101] 用户从候选列表选定的是自建源条目（伪 bvid = `dmapi:<episodeId>`）→ 按 id 直取。
    //   这条分支【不降级】：该 id 不是 B站 bvid，拿给内置链路必然失败，直接回错误更有诊断价值。
    const dmapiId = danmuApi.parsePrefixedId(bvid);
    if (dmapiId) return danmuApi.fetchById(dmapiId, String(title || ''), out, seriesKey);
    // [lc-1302] 弹弹play 伪 id（`ddp:<episodeId>`）按 episodeId 直取，同样不降级；
    //   单集 id 不能代表整季，不做源锁定（后续集由自动路径重新匹配）。
    if (String(bvid).startsWith(dandanplay.ID_PREFIX)) {
        const ddpId = Number(String(bvid).slice(dandanplay.ID_PREFIX.length));
        if (!ddpId || ddpId <= 0) return { ok: false, error: '弹弹play 候选 id 无效' };
        return dandanplay.fetchById(ddpId, String(title || ''), out);
    }
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        // [lc-1172] epNum 透传：合集/多P 候选按分P 标题匹配取对应集的 cid
        // [lc-1195] forceCid 透传：用户在分P 明细菜单里手动选定的 cid，直接使用
        const runP = Promise.resolve(mod.run_candidates(title, bvid, out, threshold, epNum, forceCid ? Number(forceCid) : 0));
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutP = new Promise<BiliDanmakuResult>((resolve) => {
            timeoutHandle = setTimeout(() => resolve({ ok: false, error: `弹幕获取超时(${timeoutMs}ms)` }), timeoutMs);
        });
        const r = await Promise.race([runP, timeoutP]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return (r && typeof r === 'object') ? r : { ok: false, error: '未知错误（run_candidates 无返回）' };
    } catch (e: any) {
        log.warn('[biliRunner] run_candidates 异常: ' + (e?.message || e));
        return { ok: false, error: String(e?.message || e) };
    }
}

/**
 * [lc-1195] 列出某合集(bvid)的全部分P（page/cid/part），供 MPV 手动搜索 UI 在点击合集候选后
 * 展开分P 明细菜单，由用户手动选定具体分P（对应脚本内 list_pages，view API 一次请求）。
 */
export async function listBiliDanmakuPages(
    bvid: string,
    timeoutMs = 30000,
): Promise<{ ok: boolean; bvid?: string; title?: string; pages?: { page: number; cid: number; part: string }[]; error?: string }> {
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        const runP = Promise.resolve(mod.list_pages(bvid));
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutP = new Promise<{ ok: boolean; error?: string }>((resolve) => {
            timeoutHandle = setTimeout(() => resolve({ ok: false, error: `分P 列表超时(${timeoutMs}ms)` }), timeoutMs);
        });
        const r = await Promise.race([runP, timeoutP]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return (r && typeof r === 'object') ? r : { ok: false, error: '未知错误（list_pages 无返回）' };
    } catch (e: any) {
        log.warn('[biliRunner] list_pages 异常: ' + (e?.message || e));
        return { ok: false, error: String(e?.message || e) };
    }
}
