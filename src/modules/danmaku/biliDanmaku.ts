import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import logger from '../logger';
const log = logger.component('danmaku');

/**
 * PotPlayer 弹幕支持。
 *
 * 背景：本项目的「B站弹幕」由 MPV 专属的 uosc_danmaku Lua 脚本实现——
 * 它调用同目录的 `bili_danmaku.py`（用标题+集数去 B站搜对应集、抓弹幕 XML），
 * 再把 XML 转成 ASS 字幕轨道渲染。PotPlayer 跑不了 MPV 的 Lua 脚本，
 * 因此这里在主进程复刻同一条链路：直接调用同一个 `bili_danmaku.py` 出 XML，
 * 再用移植自 Lua 的碰撞避让算法把 XML 转成 ASS，最后由 potplayer.ts 通过 /sub 喂给 PotPlayer。
 *
 * 这样 PotPlayer 的弹幕能力就与 MPV 对齐（同数据源、同排版算法、同 Cookie）。
 */

// ---- 候选 uosc_danmaku 脚本目录（与 biliCookie.ts 保持一致，内联避免跨层依赖）----
function getDanmakuScriptCandidates(): string[] {
    const arr: string[] = [];
    if (process.resourcesPath) {
        arr.push(path.join(process.resourcesPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    }
    try {
        arr.push(path.join(app.getAppPath(), 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    } catch (_) { /* ignore */ }
    // [新] 打包态 MPV 实际脚本目录：exe 同目录 portable_config（extraFiles 解压，可写）
    try {
        arr.push(path.join(path.dirname(app.getPath('exe')), 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
    } catch (_) { /* ignore */ }
    if (process.platform === 'win32') {
        arr.push(path.join(os.homedir(), 'AppData', 'Roaming', 'mpv', 'scripts', 'uosc_danmaku'));
    } else {
        arr.push(path.join(os.homedir(), '.config', 'mpv', 'scripts', 'uosc_danmaku'));
    }
    return arr;
}

function resolveScriptDir(): string | null {
    for (const c of getDanmakuScriptCandidates()) if (fs.existsSync(c)) return c;
    return null;
}

// ---- Python 解释器候选（与 Lua 端一致：优先 WorkBuddy 自带，其次系统 python/py）----
function findPythonCandidates(): string[] {
    const cands: string[] = [];
    const home = os.homedir();
    // 1) 通用：扫描 WorkBuddy 托管的各版本 python
    const verRoot = path.join(home, '.workbuddy', 'binaries', 'python', 'versions');
    try {
        if (fs.existsSync(verRoot)) {
            for (const v of fs.readdirSync(verRoot)) {
                const p = path.join(verRoot, v, 'python.exe');
                if (fs.existsSync(p)) cands.push(p);
            }
        }
    } catch (_) { /* ignore */ }
    // 2) 系统 PATH
    cands.push('python', 'python3', 'py');
    return cands;
}

/**
 * 规范化弹幕搜索用的番名：去掉 CJK 书名号/直角引号等包裹符号。
 *
 * 背景：飞牛的 tvTitle 常带『』「」《》等（如『你们先走我断后』，于是…），
 * 而 B站番名没有这些符号。bili_danmaku.py 用 `title[:2/3]` 做前缀过滤，
 * 带『时前缀变成『你们，B站结果里没有，导致整批候选被过滤→匹配不上。
 * 这里在进搜索前统一剥掉，和 bili_danmaku.py 内的清洗保持一致。
 */
export function normalizeDanmakuTitle(title: string): string {
    if (!title) return title;
    return title
        .replace(/[『』「」【】〔〕《》〈〉""''（）()]/g, '')
        .trim();
}

/**
 * 调用 bili_danmaku.py 抓取 B站弹幕 XML。
 * @param title 干净番名（如「葬送的芙莉莲」），不要用含 S1E2 的完整媒体标题
 * @param ep    集数；0 表示仅标题搜索（取最优/首集兜底）
 * @param outXml 输出 XML 路径
 * @returns 是否成功生成 XML
 */
export async function fetchBiliDanmakuXml(title: string, ep: number, outXml: string): Promise<boolean> {
    const cleanTitle = normalizeDanmakuTitle(title);
    log.info(`[danmaku] === fetchBiliDanmakuXml 开始 ===`);
    log.info(`[danmaku] 参数: title="${title}" -> cleanTitle="${cleanTitle}", ep=${ep}, outXml="${outXml}"`);

    const scriptDir = resolveScriptDir();
    if (!scriptDir) {
        log.warn(`[danmaku] ❌ 未找到 uosc_danmaku 脚本目录！候选路径:`);
        for (const c of getDanmakuScriptCandidates()) {
            log.warn(`[danmaku]   候选: ${c} (存在:${fs.existsSync(c)})`);
        }
        return false;
    }
    log.info(`[danmaku] ✅ 脚本目录: ${scriptDir}`);

    const pyScript = path.join(scriptDir, 'bili_danmaku.py');
    if (!fs.existsSync(pyScript)) {
        log.warn(`[danmaku] ❌ bili_danmaku.py 不存在: ${pyScript}`);
        return false;
    }
    log.info(`[danmaku] ✅ Python脚本: ${pyScript}`);

    const cands = findPythonCandidates();
    log.info(`[danmaku] Python候选(${cands.length}个): ${cands.join(' | ')}`);

    for (const py of cands) {
        try {
            log.info(`[danmaku] 尝试 python: "${py}" args=[${pyScript}, ${cleanTitle}, ${ep}, ${outXml}]`);
            const ok = await runPython(py, [pyScript, cleanTitle, String(ep), outXml], 60000);
            log.info(`[danmaku] runPython 返回: ${ok}`);
            if (ok && fs.existsSync(outXml) && fs.statSync(outXml).size > 0) {
                const xmlSize = fs.statSync(outXml).size;
                log.info(`[danmaku] ✅ XML生成成功: ${outXml} (${xmlSize} bytes)`);
                return true;
            } else {
                log.warn(`[danmaku] XML未生成或为空: exists=${fs.existsSync(outXml)}, size=${fs.existsSync(outXml) ? fs.statSync(outXml).size : 'N/A'}`);
            }
        } catch (e: any) {
            log.warn('[danmaku] python 调用异常 (' + py + '): ' + (e?.message || e));
        }
    }
    log.warn(`[danmaku] ❌ 所有 Python 候选均失败，无法获取弹幕 XML`);
    return false;
}

function runPython(py: string, args: string[], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        let out = '';
        let err = '';
        let child: any = null;
        const finish = (r: boolean) => {
            if (done) return;
            done = true;
            resolve(r);
        };
        try {
            log.info(`[danmaku] spawn: "${py}" ${args.map(a => `"${a}"`).join(' ')}`);
            child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
            log.warn(`[danmaku] spawn 失败: ${e}`);
            finish(false);
            return;
        }
        const timer = setTimeout(() => {
            try { child.kill(); } catch (_) { /* ignore */ }
            log.warn('[danmaku] python 超时(' + timeoutMs + 'ms)，已终止');
            log.info(`[danmaku] 超时时 stdout(${out.length}字符): ${out.slice(0, 2000)}`);
            log.info(`[danmaku] 超时时 stderr(${err.length}字符): ${err.slice(0, 2000)}`);
            finish(false);
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
        child.on('close', (code: number) => {
            clearTimeout(timer);
            log.info(`[danmaku] python 进程退出 code=${code}, stdout(${out.length}字符): ${out.slice(0, 2000)}`);
            if (err.length > 0) {
                log.info(`[danmaku] python stderr(${err.length}字符): ${err.slice(0, 2000)}`);
            }
            if (code !== 0) {
                log.warn('[danmaku] bili_danmaku.py 非零退出码 ' + code);
            }
            finish(code === 0);
        });
        child.on('error', (e: any) => {
            log.warn(`[danmaku] spawn error事件: ${e?.message || e}`);
            finish(false);
        });
    });
}

// ===================== XML -> ASS 转换（移植自 uosc_danmaku/modules/parse.lua）=====================

export interface DanmakuItem {
    time: number;     // 秒
    type: number;     // 1/2/3=滚动 4=底部 5=顶部
    color: number;    // 十进制 RGB
    text: string;
}

// 弹幕排版参数（与 uosc_danmaku.conf 保持一致）
const FONT_NAME = 'Microsoft YaHei'; // PotPlayer 用显式 CJK 字体更稳（MPV 用 sans-serif 经 libass 回退）
const FONT_SIZE = 25;
const OPACITY = 0.6;
const SCROLL_TIME = 15;  // 滚动弹幕停留秒数
const FIX_TIME = 5;      // 固定弹幕停留秒数
const OUTLINE = 1.0;
const SHADOW = 0.0;
const RES_X = 1920;
const RES_Y = 1080;

function unescapeXml(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function assEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function strWidth(text: string, font_size: number): number {
    // 移植自 utils.lua get_str_width：CJK=2 单位，ASCII=1 单位，乘以 font_size/2
    let unicodeWidth = 0;
    let i = 0;
    while (i < text.length) {
        const code = text.codePointAt(i) || 0;
        if (code < 0x80) unicodeWidth += 1;
        else if (code < 0x800) unicodeWidth += 2;
        else if (code < 0x10000) unicodeWidth += 2;
        else { unicodeWidth += 2; i += 1; } // 补充代理对
        i += 1;
    }
    return unicodeWidth * (font_size / 2);
}

function secToAss(t: number): string {
    const safe = Math.max(0, t);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    const ss = s.toFixed(2).padStart(5, '0');
    return `${h}:${String(m).padStart(2, '0')}:${ss}`;
}

function colorToAss(color: number): string {
    const c = Math.max(0, Math.min(color || 0xffffff, 0xffffff));
    const hex = ('000000' + c.toString(16)).slice(-6);
    const r = hex.slice(0, 2);
    const g = hex.slice(2, 4);
    const b = hex.slice(4, 6);
    return `{\\c&H${b}${g}${r}&}`;
}

// 碰撞避让：滚动弹幕 Y 坐标（移植自 parse.lua get_position_y）
class DanmakuArray {
    font_size: number;
    rows: number;
    time_length: { time: number; length: number }[];
    constructor(res_x: number, res_y: number, font_size: number) {
        this.font_size = font_size;
        this.rows = Math.floor(res_y / font_size);
        this.time_length = [];
        for (let i = 0; i < this.rows; i++) this.time_length.push({ time: -1, length: 0 });
    }
    set(i: number, time: number, length: number) { if (i >= 0 && i < this.rows) this.time_length[i] = { time, length }; }
    getTime(i: number) { return i >= 0 && i < this.rows ? this.time_length[i].time : -1; }
    getLen(i: number) { return i >= 0 && i < this.rows ? this.time_length[i].length : 0; }
}

function getPositionY(font_size: number, appear: number, textLen: number, resX: number, roll: number, arr: DanmakuArray): number | null {
    const velocity = (textLen + resX) / roll;
    let bestRow = -1;
    let bestBias = -Infinity;
    for (let i = 0; i < arr.rows; i++) {
        const prevTime = arr.getTime(i);
        if (prevTime < 0) {
            arr.set(i, appear, textLen);
            return 1 + i * font_size;
        }
        const prevLen = arr.getLen(i);
        const prevVel = (prevLen + resX) / roll;
        const deltaVel = velocity - prevVel;
        const deltaX = (appear - prevTime) * prevVel - (prevLen + textLen) / 2;
        if (deltaX >= 0) {
            if (deltaVel <= 0) {
                arr.set(i, appear, textLen);
                return 1 + i * font_size;
            }
            const deltaTime = deltaX / deltaVel;
            const tCatch = prevTime + deltaTime;
            const distPrev = prevVel * (tCatch - prevTime);
            if (distPrev > resX) {
                arr.set(i, appear, textLen);
                return 1 + i * font_size;
            }
            const bias = appear - prevTime - deltaTime;
            if (bias > 0) {
                arr.set(i, appear, textLen);
                return 1 + i * font_size;
            } else if (bias > bestBias) {
                bestBias = bias;
                bestRow = i;
            }
        }
    }
    return null; // 所有行占用，放弃该条
}

function getFixedY(font_size: number, appear: number, fixTime: number, arr: DanmakuArray, fromTop: boolean): number | null {
    let bestRow = -1;
    let bestBias = -1;
    const start = fromTop ? 0 : arr.rows - 1;
    const end = fromTop ? arr.rows : -1;
    const step = fromTop ? 1 : -1;
    for (let i = start; i !== end; i += step) {
        const prevTime = arr.getTime(i);
        if (prevTime < 0) {
            arr.set(i, appear, 0);
            return i * font_size + 1;
        }
        const deltaTime = appear - prevTime;
        if (deltaTime > fixTime) {
            arr.set(i, appear, 0);
            return i * font_size + 1;
        } else if (deltaTime > bestBias) {
            bestBias = deltaTime;
            bestRow = i;
        }
    }
    return null;
}

/**
 * 解析 B站弹幕 XML，提取原始弹幕条目（不含 ASS 排版）。
 * 供 overlay 弹幕层直接使用（HTML 引擎自己做碰撞避让与动画）。
 * @returns 弹幕条目数组；解析失败返回 null
 */
export function parseDanmakuXml(xmlPath: string): DanmakuItem[] | null {
    let content: string;
    try {
        content = fs.readFileSync(xmlPath, 'utf-8');
    } catch (e) {
        log.warn('[danmaku] 读取 XML 失败: ' + (e as Error).message);
        return null;
    }

    const items: DanmakuItem[] = [];
    const re = /<d\s+p="([^"]*)">([\s\S]*?)<\/d>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const parts = m[1].split(',');
        if (parts.length < 4) continue;
        const time = parseFloat(parts[0]);
        const type = parseInt(parts[1], 10);
        const color = parseInt(parts[3], 10);
        if (!isFinite(time)) continue;
        const text = unescapeXml(m[2]);
        items.push({ time, type, color, text });
    }
    if (items.length === 0) {
        log.info('[danmaku] XML 中无弹幕条目');
        return null;
    }
    return items;
}

/**
 * 把 B站弹幕 XML 转成 ASS（含碰撞避让排版）。
 * @returns 是否成功写出 ASS
 */
export function xmlToAss(xmlPath: string, assPath: string): boolean {
    const items = parseDanmakuXml(xmlPath);
    if (!items || items.length === 0) {
        return false;
    }
    log.info(`[danmaku] 解析到 ${items.length} 条弹幕`);

    const alpha = ('0' + Math.round((1 - OPACITY) * 255).toString(16)).slice(-2);
    const bold = '0';
    const rollArr = new DanmakuArray(RES_X, RES_Y, FONT_SIZE);
    const fixedArr = new DanmakuArray(RES_X, RES_Y, FONT_SIZE);

    const header = `[Script Info]
Title: DanmakuConvert for PotPlayer
ScriptType: v4.00+
Collisions: Normal
PlayResX: ${RES_X}
PlayResY: ${RES_Y}
Timer: 100.0000
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: R2L,${FONT_NAME},${FONT_SIZE},&H${alpha}FFFFFF,&H00FFFFFF,&H00000000,&H${alpha}000000,${bold},0,0,0,100,100,0,0,1,${OUTLINE.toFixed(1)},${SHADOW.toFixed(1)},7,0,0,0,1
Style: TOP,${FONT_NAME},${FONT_SIZE},&H${alpha}FFFFFF,&H00FFFFFF,&H00000000,&H${alpha}000000,${bold},0,0,0,100,100,0,0,1,${OUTLINE.toFixed(1)},${SHADOW.toFixed(1)},8,0,0,0,1
Style: BTM,${FONT_NAME},${FONT_SIZE},&H${alpha}FFFFFF,&H00FFFFFF,&H00000000,&H${alpha}000000,${bold},0,0,0,100,100,0,0,1,${OUTLINE.toFixed(1)},${SHADOW.toFixed(1)},2,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const lines: string[] = [];
    for (const d of items) {
        const appear = d.type === 1 ? Math.floor(d.time + 0.5) : d.time;
        let end: number | null = null;
        let style: string | null = null;
        let effect = '';

        if (d.type >= 1 && d.type <= 3) {
            end = appear + SCROLL_TIME;
            style = 'R2L';
            const len = strWidth(d.text, FONT_SIZE);
            const y = getPositionY(FONT_SIZE, appear, len, RES_X, SCROLL_TIME, rollArr);
            if (y !== null) {
                const x1 = RES_X + len / 2;
                const x2 = -len / 2;
                effect = `\\move(${Math.round(x1)}, ${y}, ${Math.round(x2)}, ${y})`;
            }
        } else if (d.type === 5) {
            end = appear + FIX_TIME;
            style = 'TOP';
            const y = getFixedY(FONT_SIZE, appear, FIX_TIME, fixedArr, true);
            if (y !== null) effect = `\\pos(${RES_X / 2}, ${y})`;
        } else if (d.type === 4) {
            end = appear + FIX_TIME;
            style = 'BTM';
            const y = getFixedY(FONT_SIZE, appear, FIX_TIME, fixedArr, false);
            if (y !== null) effect = `\\pos(${RES_X / 2}, ${y})`;
        }

        if (style === null || end === null || !effect) continue; // 跳过无法排版的（含行占满的）

        let text = assEscape(d.text).replace(/x(\d+)$/, '{\\b1\\i1}x$1');
        const colorTag = colorToAss(d.color);
        lines.push(`Dialogue: 0,${secToAss(appear)},${secToAss(end)},${style},,0,0,0,,${effect}${colorTag}${text}`);
    }

    if (lines.length === 0) {
        log.warn('[danmaku] 排版后无可用弹幕（可能行占满）');
        return false;
    }

    try {
        fs.writeFileSync(assPath, header + lines.join('\n') + '\n', 'utf-8');
        log.info(`[danmaku] 已写出 ASS 弹幕: ${assPath} (${lines.length} 条)`);
        return true;
    } catch (e) {
        log.warn('[danmaku] 写 ASS 失败: ' + (e as Error).message);
        return false;
    }
}

// ===================== 对外主入口 =====================

const CACHE_DIR = path.join(os.tmpdir(), 'fnos-danmaku');

function safeName(s: string): string {
    return (s || 'x').replace(/[\\/:*?"<>|]/g, '');
}

/**
 * 缓存文件名基名：用标题+集数算一个【纯 ASCII】的短 hash。
 *
 * 关键修复：之前文件名含中文（如 bili_乡下大叔成为剑圣_1.ass），
 * Node 在 Windows 上 spawn 把含 CJK 的路径作为参数传给 PotPlayer 时，
 * 中文常被按 ANSI 解析/截断，PotPlayer 实际拿到的字幕路径是坏的，
 * 导致「加载了字幕参数却打不开文件」→ 无弹幕。改用 ASCII hash 文件名彻底规避。
 */
function cacheBaseName(title: string, ep: number): string {
    const h = createHash('md5').update(`${title}::${ep}`, 'utf-8').digest('hex').slice(0, 16);
    return `bili_${h}_${ep}`;
}

/**
 * 获取某集的 B站弹幕【原始条目数组】（供 overlay 弹幕层使用）。
 * 与 getDanmakuAss 同源：标题+集数搜 B站、抓弹幕 XML。区别是这里直接返回
 * 结构化的 {time,type,color,text}[]，由 overlay 的 HTML 引擎自己做碰撞避让与动画，
 * 不再走 PotPlayer 的字幕轨道（避免弹幕与真实字幕互相争抢显示位）。
 *
 * 带磁盘缓存（.json），避免重复请求 B站。
 * @param title 干净番名
 * @param ep    集数（0=仅标题）
 * @returns 弹幕条目数组；失败返回 null
 */
export async function getDanmakuItems(title: string, ep: number): Promise<DanmakuItem[] | null> {
    title = normalizeDanmakuTitle(title);
    log.info(`[danmaku] ========== getDanmakuItems 入口 ==========`);
    log.info(`[danmaku] title="${title}", ep=${ep}`);
    if (!title) {
        log.warn('[danmaku] ❌ title 为空，直接返回 null');
        return null;
    }
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (_) { /* ignore */ }

    const cacheFile = path.join(CACHE_DIR, `${cacheBaseName(title, ep)}.json`);
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
        try {
            const items = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as DanmakuItem[];
            if (Array.isArray(items) && items.length > 0) {
                log.info(`[danmaku] ✅ 命中缓存(条目): ${cacheFile} (${items.length} 条)`);
                return items;
            }
        } catch (_) { /* ignore */ }
    }

    const xmlFile = path.join(CACHE_DIR, `${cacheBaseName(title, ep)}.xml`);
    const got = await fetchBiliDanmakuXml(title, ep, xmlFile);
    if (!got) {
        log.warn('[danmaku] ❌ XML 抓取失败，返回 null');
        return null;
    }
    const items = parseDanmakuXml(xmlFile);
    try { if (fs.existsSync(xmlFile)) fs.unlinkSync(xmlFile); } catch (_) { /* ignore */ }
    if (!items || items.length === 0) {
        log.warn('[danmaku] ❌ 解析弹幕条目为空');
        return null;
    }
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(items), 'utf-8');
        log.info(`[danmaku] ✅ 弹幕条目就绪: ${cacheFile} (${items.length} 条)`);
    } catch (_) { /* ignore */ }
    return items;
}

/**
 * 获取某集的 B站弹幕 ASS 文件（带磁盘缓存，避免重复请求 B站）。
 * @param title 干净番名
 * @param ep    集数（0=仅标题）
 * @returns ASS 路径；失败返回 null
 */
export async function getDanmakuAss(title: string, ep: number): Promise<string | null> {
    title = normalizeDanmakuTitle(title);
    log.info(`[danmaku] ========== getDanmakuAss 入口 ==========`);
    log.info(`[danmaku] title="${title}", ep=${ep}`);
    if (!title) {
        log.warn('[danmaku] ❌ title 为空，直接返回 null');
        return null;
    }
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (_) { /* ignore */ }
    log.info(`[danmaku] 缓存目录: ${CACHE_DIR} (存在:${fs.existsSync(CACHE_DIR)})`);

    const cacheFile = path.join(CACHE_DIR, `${cacheBaseName(title, ep)}.ass`);
    // 迁移兼容：旧版中文名缓存若存在则改名为新的 ASCII 名（避免重新请求 B站）
    if (!fs.existsSync(cacheFile) || fs.statSync(cacheFile).size === 0) {
        const oldCache = path.join(CACHE_DIR, `bili_${safeName(title)}_${ep}.ass`);
        if (fs.existsSync(oldCache) && fs.statSync(oldCache).size > 0) {
            try { fs.copyFileSync(oldCache, cacheFile); log.info(`[danmaku] 已迁移旧缓存→ ${cacheFile}`); }
            catch (_) { /* ignore */ }
        }
    }
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
        const cacheSize = fs.statSync(cacheFile).size;
        log.info(`[danmaku] ✅ 命中缓存: ${cacheFile} (${cacheSize} bytes)`);
        return cacheFile;
    }
    log.info(`[danmaku] 未命中缓存，开始抓取弹幕...`);

    const xmlFile = path.join(CACHE_DIR, `${cacheBaseName(title, ep)}.xml`);
    const got = await fetchBiliDanmakuXml(title, ep, xmlFile);
    log.info(`[danmaku] fetchBiliDanmakuXml 返回: ${got}`);
    if (!got) {
        log.warn('[danmaku] ❌ XML 抓取失败，返回 null');
        return null;
    }
    log.info(`[danmaku] 开始 XML→ASS 转换...`);
    const ok = xmlToAss(xmlFile, cacheFile);
    log.info(`[danmaku] xmlToAss 返回: ${ok}`);
    // 清理过程 XML，保留 ASS 缓存
    try { if (fs.existsSync(xmlFile)) fs.unlinkSync(xmlFile); } catch (_) { /* ignore */ }
    if (ok) {
        log.info(`[danmaku] ✅ 弹幕 ASS 就绪: ${cacheFile}`);
    } else {
        log.warn('[danmaku] ❌ XML→ASS 转换失败');
    }
    return ok ? cacheFile : null;
}
