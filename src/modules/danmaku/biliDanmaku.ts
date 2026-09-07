import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as fnConfig from '../fn_config/config';
import logger from '../logger';
import { runBiliDanmaku } from '../../main/common/biliRunner';
import * as danmuApi from '../../main/common/danmuApi';
const log = logger.component('danmaku');

/**
 * PotPlayer 弹幕支持。
 *
 * 背景：本项目的「B站弹幕」由 MPV 专属的 uosc_danmaku Lua 脚本实现——
 * 它调用同目录的 `bili_danmaku.js`（用标题+集数去 B站搜对应集、抓弹幕 XML），
 * 再把 XML 转成 ASS 字幕轨道渲染。PotPlayer 跑不了 MPV 的 Lua 脚本，
 * 因此这里在主进程复刻同一条链路：直接通过 biliRunner 在主进程内运行同一个
 * `bili_danmaku.js`（纯 Node 内置模块，Node 已在 electron.exe 内）出 XML，
 * 再用移植自 Lua 的碰撞避让算法把 XML 转成 ASS，最后由 potplayer.ts 通过 /sub 喂给 PotPlayer。
 *
 * 这样 PotPlayer 的弹幕能力就与 MPV 对齐（同数据源、同排版算法、同 Cookie），
 * 且不再依赖内置 ~20MB 的 Python 安装包。
 */

/**
 * 规范化弹幕搜索用的番名：去掉 CJK 书名号/直角引号等包裹符号。
 *
 * 背景：飞牛的 tvTitle 常带『』「」《》等（如『你们先走我断后』，于是…），
 * 而 B站番名没有这些符号。bili_danmaku.js 用 `_norm()` 做前缀清洗，
 * 带『时前缀变成『你们，B站结果里没有，导致整批候选被过滤→匹配不上。
 * 这里在进搜索前统一剥掉，和 bili_danmaku.js 内的清洗保持一致。
 */
export function normalizeDanmakuTitle(title: string): string {
    if (!title) return title;
    return title
        .replace(/[『』「」【】〔〕《》〈〉""''（）()]/g, '')
        .trim();
}

/**
 * 在主进程内调用 bili_danmaku.js 抓取 B站弹幕 XML（替代旧方案 spawn 外部 Python）。
 * @param title 干净番名（如「葬送的芙莉莲」），不要用含 S1E2 的完整媒体标题
 * @param ep    集数；0 表示仅标题搜索（取最优/首集兜底）
 * @param outXml 输出 XML 路径
 * @returns 是否成功生成 XML
 */
export async function fetchBiliDanmakuXml(title: string, ep: number, outXml: string): Promise<boolean> {
    const cleanTitle = normalizeDanmakuTitle(title);
    log.info(`[danmaku] === fetchBiliDanmakuXml 开始(主进程 JS) ===`);
    log.info(`[danmaku] 参数: title="${title}" -> cleanTitle="${cleanTitle}", ep=${ep}, outXml="${outXml}"`);

    const aggThreshold = fnConfig.getMpvBiliAggregateThreshold();
    log.info(`[danmaku] 聚合阈值: ${aggThreshold}`);

    const r = await runBiliDanmaku(cleanTitle, ep, outXml, aggThreshold);
    if (r.ok && fs.existsSync(outXml) && fs.statSync(outXml).size > 0) {
        const xmlSize = fs.statSync(outXml).size;
        log.info(`[danmaku] ✅ XML生成成功: ${outXml} (${xmlSize} bytes) count=${r.danmaku_count}`);
        return true;
    }
    log.warn(`[danmaku] ❌ 弹幕获取失败: ${r.error || '未知错误'} (XML exists=${fs.existsSync(outXml)})`);
    return false;
}

// ===================== XML -> ASS 转换（移植自 uosc_danmaku/modules/parse.lua）=====================

export interface DanmakuItem {
    time: number;     // 秒
    type: number;     // 1/2/3=滚动 4=底部 5=顶部
    color: number;    // 十进制 RGB
    text: string;
}

/**
 * 弹幕来源信息（"弹幕是从哪来的"），供原生网页播放器的「详情」弹窗展示（与 MPV 一致）。
 */
export interface DanmakuMeta {
    searchTitle: string;     // 我们拿去 B站 搜的番名（fnOS 提供的标题）
    matchedTitle: string;    // B站 实际匹配到的标题（常与 searchTitle 不同，如 UP 主搬运合集名）
    source: string;          // 'bangumi' = 番剧区；'video' = 视频区(UP主搬运)
    bvid?: string | null;
    cid?: any;
    sim?: number | null;     // 匹配相似度（0~1）
    ep: number;
    isMovie: boolean;
    season: number;         // 目标季数（0=未指定；>0 时优先精确匹配该季）
    count: number;
    aggregatedFrom?: any;
    cookieStatus?: string;   // 'valid' | 'expired' | 'missing'
    error?: string;
}

export interface GetDanmakuResult {
    items: DanmakuItem[];
    meta: DanmakuMeta;
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
    // B站 protobuf 分片的 elements 不是时间序（实测相邻逆序率 44~49%），而网页渲染器的激活游标
    // 只能单调前进、超 2s 宽限即丢弃 —— 乱序会让游标死等在一条「时间戳在未来」的条目上，
    // 后面早已到点的弹幕永远轮不到检查（实测 16979 条只显示出 112 条）。MPV 端有 parse.lua 的
    // table.sort 兜住，TS 这条链一直没有排序。二分 seek 也依赖升序。
    items.sort((a, b) => a.time - b.time);
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

/**
 * 弹幕/ASS 缓存根目录。
 * 必须落在【不含中文】的目录：PotPlayer 是按 ANSI(GBK) 解析 -sub 字幕参数的，
 * 若目录含中文用户名(os.tmpdir() 默认指向 C:\Users\<中文>\AppData\Local\Temp)，
 * PotPlayer 实际拿到的是坏路径 → 字幕/弹幕打不开。
 * 优先 C:\Users\Public 与 C:\ProgramData（Windows 固定英文路径），
 * 回退 os.tmpdir()（旧行为，中文用户名下会触发该问题）。
 */
function getDanmakuCacheBase(): string {
    return process.env.PUBLIC || process.env.ProgramData || os.tmpdir();
}
const CACHE_DIR = path.join(getDanmakuCacheBase(), 'fnos-danmaku');

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
function cacheBaseName(title: string, ep: number, season = 0): string {
    // 季数纳入缓存键：同一番名+集数不同季的弹幕不同（如《无职转生》二/三季），
    // 必须分目录缓存，否则旧缓存会让"错误季"的弹幕长期命中。
    const h = createHash('md5').update(`${title}::${season}::${ep}`, 'utf-8').digest('hex').slice(0, 16);
    return season > 0 ? `bili_${h}_s${season}_${ep}` : `bili_${h}_${ep}`;
}

/** 白色（B站 默认色）。非此值的彩色弹幕归入 color 屏蔽类型，与 bili_danmaku.js:_filter_danmaku 一致。 */
const DANMAKU_WHITE = 16777215;

/**
 * 屏蔽类型 → mode 映射，严格照抄 bili_danmaku.js:861-876 的 `_filter_danmaku`
 * （mode 2/3 这类老式滚动不打标签，因此不会被任何类型命中，保持原样放行）。
 */
function blockTagOfMode(mode: number): string | null {
    switch (mode) {
        case 1: return 'scroll';
        case 4: return 'bottom';
        case 5: return 'top';
        case 6: return 'reverse';
        case 7: case 8: return 'advanced';
        default: return null;
    }
}

/**
 * 屏蔽词编译缓存：key = 原始多行文本。
 * 一次编译跨集复用 —— 绝不能每条弹幕重编译（几千条 × N 行）。
 */
const blacklistCache = new Map<string, Array<{ re: RegExp | null; raw: string }>>();

function compileBlacklist(text: string): Array<{ re: RegExp | null; raw: string }> {
    const hit = blacklistCache.get(text);
    if (hit) return hit;
    const out: Array<{ re: RegExp | null; raw: string }> = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        // parse.lua:54-70 用 `str:match(pattern)`，即 Lua pattern，JS 没有等价物。
        // 用户实际写的是「广告」「关注.*」「^xx$」「[0-9]+」这类，JS 正则都吃得下；
        // 吃了不下（Lua 专属的 %a+ 之类）就退化成子串匹配，对齐 Lua 那边 pcall 的容错意图。
        let re: RegExp | null = null;
        try { re = new RegExp(raw); } catch (_) { re = null; }
        out.push({ re, raw });
    }
    blacklistCache.set(text, out);
    return out;
}

function isBlacklisted(text: string, patterns: Array<{ re: RegExp | null; raw: string }>): boolean {
    for (const p of patterns) {
        if (p.re) {
            try { if (p.re.test(text)) return true; } catch (_) { /* 规则本身有问题 → 跳过，同 Lua pcall */ }
        } else if (text.includes(p.raw)) {
            return true;
        }
    }
    return false;
}

/**
 * 在 TS 侧应用「弹幕屏蔽类型 + 屏蔽词」。
 *
 * 为什么要在这里再做一遍：这两项配置原本只有 MPV 吃得到 ——
 *   · 屏蔽类型写进 `danmaku_block_types.json`，唯一读者是 `bili_danmaku.js:_load_block_types()`；
 *     而自建 danmu_api 命中时 `biliRunner.ts` 会在调用 `run()` 之前就早退，Lua 侧又完全不读这个 json
 *     → 该源命中时屏蔽类型对 MPV 和网页端双双失效。
 *   · 屏蔽词写进 `danmaku_blacklist.txt`，唯一读者是 `parse.lua:is_blacklisted()`
 *     → 网页播放器根本不过 Lua，从来没遵守过屏蔽词。
 *
 * 调用时机必须在**磁盘缓存读取之后**：缓存里存的是未过滤条目，
 * 这样用户改屏蔽设置下一集立即生效，既不必重抓、也不必让缓存失效。
 */
export function filterDanmakuItems(
    items: DanmakuItem[],
    blockTypes: string[],
    blacklistText: string,
): DanmakuItem[] {
    const types = new Set((Array.isArray(blockTypes) ? blockTypes : []).map((x) => String(x)));
    const patterns = compileBlacklist(blacklistText);
    if (!types.size && !patterns.length) return items;

    const out: DanmakuItem[] = [];
    let byType = 0;
    let byWord = 0;
    for (const d of items) {
        if (types.size) {
            const tag = blockTagOfMode(d.type);
            if ((tag && types.has(tag)) || (d.color !== DANMAKU_WHITE && types.has('color'))) { byType++; continue; }
        }
        if (patterns.length && isBlacklisted(d.text, patterns)) { byWord++; continue; }
        out.push(d);
    }
    if (byType || byWord) {
        log.info(`[danmaku] 屏蔽生效: 类型移除 ${byType} 条${types.size ? '(' + [...types].sort().join(',') + ')' : ''}`
            + `, 屏蔽词移除 ${byWord} 条(${patterns.length} 条规则), 剩余 ${out.length}/${items.length} 条`);
    }
    return out;
}

/**
 * 获取某集的 B站弹幕【原始条目数组 + 来源信息】（供原生网页弹幕 overlay 使用）。
 * 与 getDanmakuAss 同源：标题+集数搜 B站、抓弹幕 XML。区别是这里直接返回
 * 结构化的 {time,type,color,text}[]，由 overlay 的 canvas 引擎自己做碰撞避让与动画，
 * 不再走 PotPlayer 的字幕轨道（避免弹幕与真实字幕互相争抢显示位）。
 *
 * 额外返回 meta（来源信息：实际匹配到的 B站标题、来源区域、相似度、bvid/cid 等），
 * 用于「详情」弹窗展示"弹幕是从哪来的"。
 *
 * 带磁盘缓存（.json 内含 {items, meta}），避免重复请求 B站。
 *
 * 契约（调用方可以依赖的三件事）：
 *   1. 返回的 items **保证按 time 升序** —— 渲染器的单调激活游标与二分 seek 都依赖这一点；
 *   2. 返回前已应用「屏蔽类型 + 屏蔽词」（见 filterDanmakuItems），但**缓存里存的是未过滤的原始条目**，
 *      所以改屏蔽设置下一集立即生效，不必重抓；
 *   3. 缓存命中时会校验 `meta.source` 与当前弹幕源设置是否一致，不一致（例如刚开/刚关自建 danmu_api）
 *      则忽略缓存重抓，避免旧源的缓存永久压制新源。
 * @param title   干净番名
 * @param ep      集数（0=仅标题）
 * @param isMovie 是否电影（仅影响 meta 标注）
 * @returns {items, meta}；失败返回 null
 */
export async function getDanmakuItems(title: string, ep: number, isMovie = false, season = 0): Promise<GetDanmakuResult | null> {
    const cleanTitle = normalizeDanmakuTitle(title);
    log.info(`[danmaku] ========== getDanmakuItems 入口 ==========`);
    log.info(`[danmaku] title="${cleanTitle}", ep=${ep}`);
    if (!cleanTitle) {
        log.warn('[danmaku] ❌ title 为空，直接返回 null');
        return null;
    }
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (_) { /* ignore */ }

    const cacheFile = path.join(CACHE_DIR, `${cacheBaseName(cleanTitle, ep, season)}.json`);
    // 屏蔽类型/屏蔽词一律在缓存读取之后才应用：缓存里存的是未过滤的原始条目，
    // 这样用户改屏蔽设置下一集立即生效，既不必重抓、也不必让缓存失效。
    const applyFilter = (arr: DanmakuItem[]): DanmakuItem[] =>
        filterDanmakuItems(arr, fnConfig.getBiliDanmakuBlockTypes(), fnConfig.getBiliDanmakuBlacklist() || '');

    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
        try {
            const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as any;
            const items = (parsed && Array.isArray(parsed.items)) ? parsed.items : (Array.isArray(parsed) ? parsed : null);
            const meta = (parsed && parsed.meta) ? parsed.meta : null;
            if (items && items.length > 0) {
                // 缓存键 cacheBaseName 只有 title/season/ep、没有源维度，而命中即 return 会让
                // runBiliDanmaku（内含 danmu_api 优选，见 biliRunner.ts:135）永不执行 ——
                // lc-1101 之前存下的 B站 单源缓存（几百条）会永久压制自建源（几千条），关掉开关后反之亦然。
                // 抓取前无法预知 danmu_api 会不会命中，所以不能把源写进 key；改成读缓存时双向校验。
                // 无 meta 的老缓存 source 为 ''/undefined，isSelfHostedSource 判 false，自然归入内置 B站 侧。
                const cachedCustom = danmuApi.isSelfHostedSource(meta && meta.source);
                const wantCustom = danmuApi.isActive();
                if (cachedCustom === wantCustom) {
                    // 这条路径不经过 parseDanmakuXml，缓存里可能是排序修复之前落盘的乱序条目
                    // （实测 29/29 个真实缓存全部乱序），必须再排一次，否则渲染器的单调游标照样卡死。
                    items.sort((a: DanmakuItem, b: DanmakuItem) => a.time - b.time);
                    const m: DanmakuMeta = (meta && typeof meta === 'object') ? meta : {
                        searchTitle: cleanTitle, matchedTitle: cleanTitle, source: '',
                        ep, isMovie, season, count: items.length,
                    };
                    const kept = applyFilter(items);
                    m.count = kept.length;
                    log.info(`[danmaku] ✅ 命中缓存(条目): ${cacheFile} (${items.length} 条 → 过滤后 ${kept.length} 条)`);
                    return { items: kept, meta: m };
                }
                log.info(`[danmaku] ⚠️ 缓存来源(${cachedCustom ? '自建源' : '内置B站'})与当前设置(${wantCustom ? '自建源' : '内置B站'})不符 → 忽略缓存重抓: ${cacheFile}`);
            }
        } catch (_) { /* ignore */ }
    }

    const xmlFile = path.join(CACHE_DIR, `${cacheBaseName(cleanTitle, ep, season)}.xml`);
    const aggThreshold = fnConfig.getMpvBiliAggregateThreshold();
    const r = await runBiliDanmaku(cleanTitle, ep, xmlFile, aggThreshold, season);
    if (!r.ok) {
        log.warn('[danmaku] ❌ 弹幕获取失败: ' + (r.error || '未知'));
        return null;
    }
    const items = parseDanmakuXml(xmlFile);
    try { if (fs.existsSync(xmlFile)) fs.unlinkSync(xmlFile); } catch (_) { /* ignore */ }
    if (!items || items.length === 0) {
        log.warn('[danmaku] ❌ 解析弹幕条目为空');
        return null;
    }
    const meta: DanmakuMeta = {
        searchTitle: cleanTitle,
        matchedTitle: r.matched_title || cleanTitle,
        source: r.source || '',
        bvid: r.bvid || null,
        cid: r.cid,
        sim: (typeof r.sim === 'number') ? r.sim : null,
        ep, isMovie, season,
        count: items.length,
        aggregatedFrom: r.aggregated_from,
        cookieStatus: r.cookie_status || undefined,
    };
    try {
        // 缓存存**未过滤**的原始条目（与上面命中路径一致）：过滤结果一旦落盘，
        // 用户改屏蔽设置后不重抓就永远生效不了，正是这里要避免的病。
        fs.writeFileSync(cacheFile, JSON.stringify({ items, meta }), 'utf-8');
    } catch (_) { /* ignore */ }
    const kept = applyFilter(items);
    meta.count = kept.length;
    log.info(`[danmaku] ✅ 弹幕条目就绪: ${cacheFile} (${items.length} 条 → 过滤后 ${kept.length} 条)`);
    return { items: kept, meta };
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
