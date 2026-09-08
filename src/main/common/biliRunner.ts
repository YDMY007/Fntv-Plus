import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
import * as danmuApi from './danmuApi';
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
}

let cachedModule: any = null;
let logSinkBound = false;

// ---- 候选 uosc_danmaku 脚本目录（与 biliCookie.ts / biliDanmaku.ts 保持一致）----
function resolveDanmakuScriptDir(): string | null {
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

/**
 * 在主进程内运行 bili_danmaku.js，获取 B站弹幕并写出 XML 到 out。
 * @param title   干净番名
 * @param ep      集数（0=仅标题搜索）
 * @param out     输出 XML 路径（run 内部会确保父目录存在）
 * @param threshold 聚合阈值（可选，默认 1500）
 * @param season  季数（可选，0/undefined=不启用季过滤；>0 时优先精确匹配该季，根治跨季错配）
 * @param timeoutMs 超时保护（默认 60000ms），超时返回 {ok:false}
 * @returns 结果对象（ok=true 表示成功并写出 XML）
 */
export async function runBiliDanmaku(
    title: string,
    ep: number | string,
    out: string,
    threshold?: number | string,
    season?: number | string,
    timeoutMs = 60000,
    allowBiliFallback = true,
): Promise<BiliDanmakuResult> {
    // [lc-1101] 自建弹幕接口（danmu_api）优选：命中即返回，未命中(null)原样降级到下面的内置 B站 链路。
    //   放在 loadModule() 之前，命中时连 bili_danmaku.js 都不必加载。
    const pre = await danmuApi.autoFetch(String(title || ''), Number(ep) || 0, out, Number(season) || 0);
    if (pre) return pre;
    // [lc-1117] 网页弹幕设置可单独关掉「B站弹幕搜索」兜底（只影响网页链路；MPV 侧由 Lua 的
    //   bili_search_enabled 门控且不传此参）。手动候选搜索 runBiliDanmakuCandidates 不受限。
    if (!allowBiliFallback) {
        log.info('[biliRunner] B站弹幕搜索未启用（网页弹幕设置），跳过内置 B站降级');
        return { ok: false, error: 'B站弹幕搜索未启用' };
    }
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        const runP = Promise.resolve(mod.run(title, ep, out, threshold, season));
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

/** 仅供测试/诊断：强制下次重新加载模块（例如脚本目录变化后）。 */
export function resetBiliModule(): void {
    cachedModule = null;
    logSinkBound = false;
}

/**
 * 仅搜索 B站 候选视频列表（标题/bvid/来源/是否合集），不拉取/聚合弹幕。
 * 供 MPV 侧「手动搜索」展示候选列表，由用户选定具体视频。
 */
export async function runBiliDanmakuCandidates(
    title: string,
    ep: number | string,
    season?: number | string,
    timeoutMs = 60000,
): Promise<BiliCandidatesResult> {
    // [lc-1101] 自建弹幕接口优选：命中则候选列表全部来自自建源（bvid 位为 `dmapi:<episodeId>`），
    //   未命中(null)降级到下面的 B站 候选搜索。
    const pre = await danmuApi.candidates(String(title || ''), Number(ep) || 0, Number(season) || 0);
    if (pre) return { ok: true, candidates: pre };
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
}

/**
 * 由用户选定的 bvid 直接拉取该视频弹幕（手动搜索：用户已明确选定视频）。
 */
export async function runBiliDanmakuByBvid(
    title: string,
    bvid: string,
    out: string,
    threshold?: number | string,
    timeoutMs = 60000,
): Promise<BiliDanmakuResult> {
    // [lc-1101] 用户从候选列表选定的是自建源条目（伪 bvid = `dmapi:<episodeId>`）→ 按 id 直取。
    //   这条分支【不降级】：该 id 不是 B站 bvid，拿给内置链路必然失败，直接回错误更有诊断价值。
    const dmapiId = danmuApi.parsePrefixedId(bvid);
    if (dmapiId) return danmuApi.fetchById(dmapiId, String(title || ''), out);
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        const runP = Promise.resolve(mod.run_candidates(title, bvid, out, threshold));
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
