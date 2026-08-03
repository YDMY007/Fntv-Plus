import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
const log = logger.component('biliRunner');

/**
 * 主进程内的 B站弹幕运行器。
 *
 * 取代旧方案「spawn 外部 Python 跑 bili_danmaku.py」：bili_danmaku.js 是纯 Node 内置模块，
 * 而 Node 运行时本就包含在 electron.exe 内，因此可直接在【主进程内 require 并运行】，
 * 无需捆绑 ~20MB 的 Python 安装包，也不依赖用户本机装有 node/python。
 *
 * 两个消费者都会走这里：
 *   - MPV / Lua（extra.lua）：经本地 shim(127.0.0.1:22347) 的 /danmaku 端点触发；
 *   - PotPlayer（biliDanmaku.ts）：直接在本模块内调用 runBiliDanmaku()。
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
    error?: string;
}

let cachedModule: any = null;
let logSinkBound = false;

// ---- 候选 uosc_danmaku 脚本目录（与 biliCookie.ts / biliDanmaku.ts 保持一致）----
function resolveDanmakuScriptDir(): string | null {
    const candidates: string[] = [];
    if (process.resourcesPath) {
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
 * @param timeoutMs 超时保护（默认 60000ms），超时返回 {ok:false}
 * @returns 结果对象（ok=true 表示成功并写出 XML）
 */
export async function runBiliDanmaku(
    title: string,
    ep: number | string,
    out: string,
    threshold?: number | string,
    timeoutMs = 60000,
): Promise<BiliDanmakuResult> {
    let mod: any;
    try {
        mod = loadModule();
    } catch (e: any) {
        log.warn('[biliRunner] 加载 bili_danmaku.js 失败: ' + (e?.message || e));
        return { ok: false, error: '弹幕脚本加载失败: ' + (e?.message || e) };
    }
    try {
        const runP = Promise.resolve(mod.run(title, ep, out, threshold));
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
