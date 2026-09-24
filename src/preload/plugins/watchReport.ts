import { registerHook, HookType } from '../core/hooks';
import { getWatchReportData, getSessionTs, getWatchDayLedger, getWatchEvents, MIN_VALID_TS } from './watchHistory';

// watchReport.ts — [lc-1062] 年度观影报告（Spotify Wrapped 式翻页报告 + 导出长图）
// ─────────────────────────────────────────────────────────────────────────────
// [lc-1230] 数据源修正：飞牛的 watched_ts 是**播放进度(秒)**不是观看时间戳（见 main/common/watchTime.ts），
//   修掉之后条目级 lastPlayedAt 基本为空，「条目会话」不再可信。报告改为三级取数，每级都是真实量：
//     ① 观看事件台账（本地每次起播落一条墙钟时间 + 播放结束回填真实时长）→ 时间轴/时长/时刻全真实；
//     ② 条目级真实时长（prog × 作品总时长，飞牛确有该字段）→ 能算时长但不确知日期，按最近播放归年；
//     ③ 每日观看台账 × 真实平均单次时长（取①的历史均值，从未看过才退回 30 分钟）→ 明示为估算。
//   旧实现在 ① 缺失时一律「每条记录 30 分钟」，且会话无结束时间时同样按 30 分钟补齐，
//   时长数字是编出来的；现在只有第 ③ 级才会出现估算值，且用真实均值而非硬编码。
// 页面：①封面(年份/总时长/部数) ②月度节奏(12 月条形) ③观影时刻(24 小时分布+夜猫指数)
//       ④年度 TOP5(按观看时长) ⑤总结(连续天数/看完率/评分/结语)。←/→ 键与按钮翻页。
// 导出：canvas 程序化绘制长图（纯文字/图形，无外链图片 → canvas 不被污染，toDataURL 可用）。
// 入口：观影记录面板顶栏「年度报告」按钮（MutationObserver + keepalive 注入，仿 customLogo）。

const PANEL_ID = 'fntv-wh';
const BTN_ID = 'fntv-wrapped-btn';
const OV_ID = 'fntv-wrapped';

interface ReportItem { name: string; ms: number; prog: number; rating: number; type: string; }
interface YearReport {
    year: number;
    totalMs: number;
    titles: number;
    finished: number;
    rated: number;
    monthMs: number[];      // 12
    hourMs: number[];       // 24
    activeDays: number;
    maxStreak: number;
    nightRatio: number;     // 0-1，00:00-05:00 开始的会话占比
    top: ReportItem[];
    items: ReportItem[];
    ignored: number;        // [lc-1075] 被修正机制剔除的脏时间戳会话数（< 2000-01-01，如 1970）
    synthetic?: boolean;    // [lc-1077] 条目级数据为零时由观影台账估算（每日记录 × 平均单次时长）
    source?: 'events' | 'items' | 'ledger'; // [lc-1230] 本次报告实际用了哪一级数据源
    /** [lc-1230b] 片单口径：'year'=本年（有真实日期，可信）；'all'=全库累计（飞牛无观看日期，
     *  作品级事实只能给全量，页面须明示，否则「年度 TOP5」会名不副实）。 */
    itemsScope?: 'year' | 'all';
}

/** 真实观看事件（watchHistory 台账导出的形状） */
interface WatchEventLite { ts: number; key: string; name: string; type?: string; player?: string; ms?: number }

/** 事件日期 → 本地日历日 key（用于连续天数/活跃天数，避免 UTC 偏移串日） */
function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/** 一组日历日 key 的最长连续天数 */
function maxStreakOf(dayKeys: string[]): number {
    const days = Array.from(new Set(dayKeys)).sort();
    let maxStreak = 0, run = 0, prev = '';
    for (const dk of days) {
        if (prev) {
            const [py, pm, pd] = prev.split('-').map(Number);
            const [cy, cm, cd] = dk.split('-').map(Number);
            const gap = Math.round((new Date(cy, cm, cd).getTime() - new Date(py, pm, pd).getTime()) / 86400000);
            run = gap === 1 ? run + 1 : 1;
        } else run = 1;
        if (run > maxStreak) maxStreak = run;
        prev = dk;
    }
    return maxStreak;
}
/** 无时长记录的会话兜底：优先用历史真实均值，完全没有历史才退回 30 分钟 */
const FALLBACK_SESSION_MS = 30 * 60000;
function avgSessionMs(events: WatchEventLite[]): number {
    let sum = 0, n = 0;
    for (const e of events) if (e.ms && e.ms > 0) { sum += e.ms; n++; }
    return n > 0 ? sum / n : FALLBACK_SESSION_MS;
}

export type { YearReport, WatchEventLite, ReportItem };

/**
 * ① 事件级聚合（首选，全部为真实墙钟时间）：
 *   每次起播一条事件，时长取播放结束回填的真实值；未回填的少数（如播放器崩溃）用历史均值补齐，
 *   并把补齐的条数记为 estimated 供封面如实标注。
 */
export function computeReportFromEvents(
    events: WatchEventLite[],
    year: number,
    items: { name: string; prog: number; myRating: number; type?: string }[] = [],
): YearReport {
    const monthMs = new Array(12).fill(0);
    const hourMs = new Array(24).fill(0);
    const dayKeys: string[] = [];
    let totalMs = 0, nightMs = 0, estimated = 0, ignored = 0;
    const byKey = new Map<string, { name: string; ms: number }>();
    const fallback = avgSessionMs(events);

    for (const e of events) {
        if (!e.ts || e.ts < MIN_VALID_TS) { ignored++; continue; }
        const d = new Date(e.ts);
        if (d.getFullYear() !== year) continue;
        let ms = (typeof e.ms === 'number' && e.ms > 0) ? e.ms : 0;
        if (!ms) { ms = fallback; estimated++; }
        totalMs += ms;
        monthMs[d.getMonth()] += ms;
        hourMs[d.getHours()] += ms;
        if (d.getHours() < 5) nightMs += ms;
        dayKeys.push(dayKey(e.ts));
        const gk = e.key || e.name || 'unknown';
        const cur = byKey.get(gk);
        if (cur) cur.ms += ms;
        else byKey.set(gk, { name: e.name || '未知作品', ms });
    }

    // 用条目元数据补齐片单的进度/评分/类型（事件本身只带标题）
    const meta = new Map(items.map((it) => [it.name, it]));
    const top: ReportItem[] = [];
    byKey.forEach((v) => {
        const m = meta.get(v.name);
        top.push({ name: v.name, ms: v.ms, prog: m ? m.prog : 0, rating: m ? m.myRating : 0, type: (m && m.type) || '' });
    });
    top.sort((a, b) => b.ms - a.ms);
    return {
        year,
        totalMs,
        titles: top.length,
        finished: top.filter((t) => t.prog >= 1).length,
        rated: top.filter((t) => t.rating > 0).length,
        monthMs,
        hourMs,
        activeDays: new Set(dayKeys).size,
        maxStreak: maxStreakOf(dayKeys),
        nightRatio: totalMs > 0 ? nightMs / totalMs : 0,
        top: top.slice(0, 5),
        items: top,
        ignored,
        source: 'events',
        itemsScope: 'year', // 事件带真实墙钟时间 → 片单确实是本年的
        synthetic: estimated > 0 ? true : undefined,
    };
}

/**
 * ② 条目级聚合（次选）：飞牛不提供观看日期时，用**真实**的观看进度折算时长
 *   （prog × 作品总时长；看完的按全片算），日期只能取「最近一次播放」归年 —— 时长真实、日期粗。
 *   [lc-1230] 顺带修掉旧实现两个缺陷：
 *     · totalRuntimeMs 在无会话时被整段当成本年观看（一部去年看完的剧全算进今年）；
 *     · 会话串大多没有结束时间（本模块自己产出的就是空 end），旧实现一律按 30 分钟补齐 ——
 *       而「进度 × 时长」是真实量、严格更优，故现在**优先**用它；30 分钟只在拿不到任何
 *       真实时长（runtime=0）时才作为最后手段，并标记 synthetic 供封面明示。
 */
export function computeReport(
    items: { sessions?: [string, string][]; lastPlayedAt?: number; totalRuntimeMs?: number; name: string; prog: number; myRating: number; type?: string }[],
    year: number,
    tsOf: (s: string) => number,
): YearReport {
    const monthMs = new Array(12).fill(0);
    const hourMs = new Array(24).fill(0);
    const dayKeys: string[] = [];
    let totalMs = 0, nightMs = 0, ignored = 0, estimated = 0;
    const top: ReportItem[] = [];

    for (const it of items) {
        let itemMs = 0;
        let at = 0; // 该条目的归年/归月时间点（ms）
        const runtime = it.totalRuntimeMs || 0;
        let sawSessionNoEnd = false;
        if (Array.isArray(it.sessions) && it.sessions.length) {
            for (const ses of it.sessions) {
                const s = tsOf(ses[0]);
                // [lc-1075] 修正机制：早于 2000 年的时间戳是 NAS 端脏数据（epoch 占位 → "1970 年
                //   观看"），不参与聚合也不进年份清单，计数后在报告封面明示。
                if (!s || s < MIN_VALID_TS) { ignored++; continue; }
                const d = new Date(s);
                if (d.getFullYear() !== year) continue;
                const e = tsOf(ses[1]);
                // 无结束时间 → 时长未知（起播日期仍然有效，先记下时间点），交给下面按进度折算
                if (!(e > s)) { sawSessionNoEnd = true; if (s > at) at = s; continue; }
                const clamp = Math.min(e - s, 12 * 3600000);       // 单会话钳 12h（挂机保护）
                itemMs += clamp;
                if (s > at) at = s;
            }
        }
        // 真实时长优先：观看进度 × 作品总时长（仅痕迹 prog=0 时按 5% 记），日期取最近播放
        if (itemMs <= 0 && runtime > 0) {
            const lp = it.lastPlayedAt || 0;
            if (lp >= MIN_VALID_TS && new Date(lp).getFullYear() === year) {
                const watched = Math.min(1, Math.max(0, it.prog || 0));
                const fb = Math.round(runtime * (watched > 0 ? watched : 0.05));
                if (fb > 0) { itemMs += Math.min(fb, 12 * 3600000); at = lp; }
            }
        }
        // 兜底：既无结束时间也无作品时长（极罕见）→ 沿用旧口径的 30 分钟占位，并标记为估算
        if (itemMs <= 0 && sawSessionNoEnd && at > 0) {
            itemMs += FALLBACK_SESSION_MS;
            estimated++;
        }
        if (itemMs > 0 && at) {
            const d = new Date(at);
            monthMs[d.getMonth()] += itemMs;
            hourMs[d.getHours()] += itemMs;
            if (d.getHours() < 5) nightMs += itemMs;
            dayKeys.push(dayKey(at));
        }
        if (itemMs > 0) top.push({ name: it.name, ms: itemMs, prog: it.prog, rating: it.myRating, type: it.type || '' });
        totalMs += itemMs;
    }

    top.sort((a, b) => b.ms - a.ms);
    return {
        year,
        totalMs,
        titles: top.length,
        finished: top.filter((t) => t.prog >= 1).length,
        rated: items.filter((it) => it.myRating > 0 && top.some((t) => t.name === it.name)).length,
        monthMs,
        hourMs,
        activeDays: new Set(dayKeys).size,
        maxStreak: maxStreakOf(dayKeys),
        nightRatio: totalMs > 0 ? nightMs / totalMs : 0,
        top: top.slice(0, 5),
        items: top,
        ignored,
        source: 'items',
        itemsScope: 'year', // 有「最近播放」日期才计入 → 片单是本年的
        synthetic: estimated > 0 ? true : undefined,
    };
}

// ── 样式（lc-1056 渐变玻璃语言）──
const ACCENT_GRAD = 'linear-gradient(135deg,#6d7ff2,#8a63e8)';
const CARD_BG = 'linear-gradient(165deg,rgba(250,251,254,.97),rgba(240,243,250,.99))';
const INK = '#262c44';
const SUB = '#5a6480';

function fmtHours(ms: number): string {
    const h = Math.round(ms / 3600000);
    return h >= 10000 ? (ms / 3600000 / 10000).toFixed(1) + ' 万' : String(h);
}

// ── 报告数据缓存（翻页/导出共用）──
let _cur: YearReport | null = null;

// ── 入口按钮注入 ──
// [lc-1073] 入口迁到右上角按钮列 #fntv-wh-topbtns 最左侧（用户要求：旧位置在面板标题旁
//   尺寸突兀且遮挡内容）。几何对齐列内 pill（22px 圆角 / 9×16 padding），去掉大发光阴影。
//   data-self-handled 让 watchHistory.handleTopBtnAction 放行事件，由本按钮自带 click 监听处理。
function ensureButton(): void {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (document.getElementById(BTN_ID)) return;
    const bar = document.getElementById('fntv-wh-topbtns');
    if (!bar) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '✨ 年度报告';
    btn.title = '生成本年度观影报告';
    btn.setAttribute('data-self-handled', '1');
    btn.style.cssText = 'padding:9px 16px;border:none;border-radius:22px;cursor:pointer;'
        + 'font-size:14px;font-weight:600;color:#fff;letter-spacing:.5px;'
        + 'background:' + ACCENT_GRAD + ';'
        + 'transition:transform .15s ease, filter .15s ease;';
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-2px)'; btn.style.filter = 'brightness(1.08)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.filter = ''; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); openReport(); });
    bar.prepend(btn);
}

// ── 报告计算入口 ──
function buildForYear(year: number): YearReport {
    const all = getWatchReportData();
    const items = all.map((it) => ({
        name: it.name,
        sessions: it.sessions,
        lastPlayedAt: it.lastPlayedAt,
        totalRuntimeMs: it.totalRuntimeMs,
        prog: it.prog,
        myRating: it.myRating,
        type: it.type,
    }));
    // [lc-1230] ① 首选真实观看事件台账（每次起播的墙钟时间 + 播放结束回填的真实时长）
    const ev = computeReportFromEvents(getWatchEvents(), year, items);
    if (ev.totalMs > 0) return ev;
    // ② 次选条目级：真实进度 × 作品总时长（时长真实，日期只能按最近播放归年）
    const r = computeReport(items, year, getSessionTs);
    if (r.totalMs > 0) return r;
    // ③ 兜底：每日台账 × 真实平均单次时长（封面明示为估算）。
    //    [lc-1230b] 同时用不依赖日期的作品级事实回填片单/看完率——飞牛没有观看日期，
    //    不代表「没看过哪几部」；否则 TOP5 与看完率会整片空白（用户报障）。
    return synthesizeFromLedger(getWatchDayLedger(), getWatchEvents(), year, r, computeItemFacts(items));
}

/**
 * [lc-1230b] 作品级事实（不依赖日期）：飞牛的「看过哪些、看完没、看了多少」是真实可得的
 *   （item/list 钻取出的 progress + total_runtime_ms），与「什么时候看的」无关。
 *   旧实现在拿不到日期、退到每日台账时把 top/items 整个清空，于是片单、看完率、打分数
 *   一起变 0（用户报障：观影天数/连续天数正常，但 TOP5 与看完率空）。
 *   这里按「观看进度 × 作品总时长」折算每部的观看量并排序，供无日期年份回填作品级事实。
 */
export function computeItemFacts(
    items: { name: string; prog: number; myRating: number; totalRuntimeMs?: number; type?: string }[],
): { top: ReportItem[]; items: ReportItem[]; titles: number; finished: number; rated: number } {
    const list: ReportItem[] = [];
    for (const it of items) {
        const runtime = it.totalRuntimeMs || 0;
        const watched = Math.min(1, Math.max(0, it.prog || 0));
        // 未看完按真实进度折算；看完按全片；仅痕迹(prog=0)按 5% 估
        const ms = runtime > 0 ? Math.round(runtime * (watched > 0 ? watched : 0.05)) : 0;
        list.push({ name: it.name, ms, prog: it.prog, rating: it.myRating, type: it.type || '' });
    }
    // 有真实时长的排前面；缺时长的靠 prog/评分兜底，保证「看过的」不因缺时长被整体丢弃
    list.sort((a, b) => (b.ms - a.ms) || (b.prog - a.prog) || (b.rating - a.rating));
    return {
        top: list.slice(0, 5),
        items: list,
        titles: list.length,
        finished: list.filter((t) => t.prog >= 1).length,
        rated: list.filter((t) => t.rating > 0).length,
    };
}

/** [lc-1077] 台账估算：把某年的每日观看台账折算为报告（纯函数，数据由调用方注入便于验证）。
 *  [lc-1230] 单次时长改用**真实历史均值**（取自观看事件台账），不再硬编码 30 分钟；
 *  只有从未有过带时长的事件时才退回 30 分钟，且结果始终带 synthetic/source 标记供封面明示。
 *  [lc-1230b] 作品级事实（片单/看完率/打分数）不再被清空——飞牛给不出观看日期不代表「没看过哪几部」，
 *  按 facts（progress × 时长）回填，并用 itemsScope='all' 明示口径为「全库累计」而非本年。 */
export function synthesizeFromLedger(
    ledger: Array<{ y: number; m0: number; d: number; count: number }>,
    events: WatchEventLite[],
    year: number,
    base: YearReport,
    facts?: { top: ReportItem[]; items: ReportItem[]; titles: number; finished: number; rated: number },
): YearReport {
    const perSession = avgSessionMs(events);
    const monthMs = new Array(12).fill(0);
    const days = new Set<string>();
    let totalMs = 0;
    for (const b of ledger) {
        if (b.y !== year) continue;
        const ms = Math.round(b.count * perSession);
        totalMs += ms;
        monthMs[b.m0] += ms;
        days.add(`${b.y}-${b.m0}-${b.d}`);
    }
    if (totalMs <= 0) return base;
    return {
        ...base,
        totalMs,
        monthMs,
        activeDays: days.size,
        maxStreak: maxStreakOf(Array.from(days)),
        // 作品级事实：进度与时长都是真实值，只是无法归到具体年份 → 标注口径为全库累计
        top: facts ? facts.top : [],
        items: facts ? facts.items : [],
        titles: facts ? facts.titles : 0,
        finished: facts ? facts.finished : 0,
        rated: facts ? facts.rated : 0,
        itemsScope: facts && facts.items.length ? 'all' : undefined,
        source: 'ledger',
        synthetic: true,
    };
}

function openReport(): void {
    if (document.getElementById(OV_ID)) return;
    const all = getWatchReportData();
    // 可选年份 = 数据里出现过的年份(降序)，默认当前年
    //   [lc-1075] 过修正基准的年份才入选，脏数据(1970 等)不再出现在年份下拉里
    //   [lc-1077] 并入观影台账的年份（与热力图同源，台账-only 的年份也能选）
    const years = new Set<number>([new Date().getFullYear()]);
    for (const it of all) {
        const t = lastPlayedOf(it);
        if (t && t >= MIN_VALID_TS) years.add(new Date(t).getFullYear());
        for (const ses of it.sessions || []) {
            const ts = getSessionTs(ses[0]);
            if (ts && ts >= MIN_VALID_TS) years.add(new Date(ts).getFullYear());
        }
    }
    for (const b of getWatchDayLedger()) {
        if (b.y >= 2000 && b.y <= new Date().getFullYear()) years.add(b.y);
    }
    // [lc-1230] 真实观看事件台账的年份（报告最可信的数据源，年份下拉必须覆盖到）
    for (const e of getWatchEvents()) {
        if (e.ts >= MIN_VALID_TS) years.add(new Date(e.ts).getFullYear());
    }
    const yearList = Array.from(years).sort((a, b) => b - a);
    // 默认选「有数据的最近一年」——当前年没看东西时不该展示全 0 封面
    let year = yearList.find((y) => buildForYear(y).totalMs > 0) ?? yearList[0];
    _cur = buildForYear(year);

    const ov = document.createElement('div');
    ov.id = OV_ID;
    ov.setAttribute('data-fnos-ui', '1');
    // [lc-1073] z-index 提到 #fntv-wh-topbtns(2147483641) 之上：报告打开时右上角按钮列
    //   不应浮在报告控制行上方。仍低于 dialogUI(2147483647)。
    //   刻意不挂 backdrop-filter：透明窗口 + --disable-features=VizDisplayCompositor（可选
    //   软件渲染）下，全屏 blur 层是合成器卡死的高发源（用户报障「点击后页面卡死」）；
    //   底色 .86 不透明，blur 贡献本就不可感知。
    //   [lc-1075] background 必须 !important —— 云母增强(glassUI ①b)的
    //   body>div {background:transparent!important} 会把行内遮罩压成全透明：底部控制行
    //   直接浮在页面上，半透明白底按钮的文字没法分辨（用户报障）。控制行按钮同样加固。
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483642;background:rgba(12,14,22,.86)!important;'
        + 'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;'
        + 'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;';

    const stage = document.createElement('div');
    stage.id = 'fntv-wrapped-stage';
    stage.style.cssText = 'width:min(760px,92vw);height:min(520px,80vh);border-radius:20px;position:relative;overflow:hidden;'
        + 'background:' + CARD_BG + ';color:' + INK + ';box-shadow:0 24px 80px rgba(20,26,60,.5), inset 0 0 0 1px rgba(255,255,255,.6);';
    ov.appendChild(stage);

    // 翻页控制行（[lc-1075] 各按钮底色 !important 加固：不依赖遮罩层存活性，任何样式表规则都剥不掉）
    const ctrl = document.createElement('div');
    ctrl.style.cssText = 'display:flex;align-items:center;gap:14px;';
    const mkNav = (label: string, dir: number) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.3);cursor:pointer;'
            + 'background:rgba(48,52,74,.92)!important;color:#fff;font-size:16px;font-weight:700;';
        b.addEventListener('click', () => turn(dir));
        return b;
    };
    const dots = document.createElement('div');
    dots.id = 'fntv-wrapped-dots';
    dots.style.cssText = 'display:flex;gap:8px;align-items:center;';
    // 年份切换
    const yearSel = document.createElement('select');
    yearSel.style.cssText = 'margin-right:6px;padding:6px 10px;border-radius:9px;border:none;'
        + 'background:rgba(48,52,74,.92)!important;color:#fff;font-size:13px;font-weight:700;outline:none;cursor:pointer;';
    for (const y of yearList) {
        const op = document.createElement('option');
        op.value = String(y);
        op.textContent = y + ' 年';
        op.style.color = INK;
        if (y === year) op.selected = true;
        yearSel.appendChild(op);
    }
    yearSel.addEventListener('change', () => {
        _cur = buildForYear(parseInt(yearSel.value, 10));
        renderPage(0);
        renderDots();
    });
    ctrl.appendChild(yearSel);
    ctrl.appendChild(mkNav('‹', -1));
    ctrl.appendChild(dots);
    ctrl.appendChild(mkNav('›', 1));
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ 关闭';
    closeBtn.style.cssText = 'padding:8px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.3);cursor:pointer;'
        + 'background:rgba(48,52,74,.92)!important;color:#fff;font-size:13px;font-weight:600;';
    closeBtn.addEventListener('click', () => { ov.remove(); document.removeEventListener('keydown', onKey, true); });
    ctrl.appendChild(closeBtn);
    ov.appendChild(ctrl);

    // 导出长图
    const exportBtn = document.createElement('button');
    exportBtn.textContent = '⬇ 导出长图';
    exportBtn.style.cssText = 'margin-top:2px;padding:8px 18px;border:none;border-radius:10px;cursor:pointer;'
        + 'font-size:12.5px;font-weight:700;color:#fff;background:' + ACCENT_GRAD + ';';
    exportBtn.addEventListener('click', () => exportLongImage());
    ov.appendChild(exportBtn);

    // 页面状态
    let page = 0;
    const PAGES = 5;
    const renderDots = (): void => {
        dots.innerHTML = '';
        for (let i = 0; i < PAGES; i++) {
            const d = document.createElement('i');
            d.style.cssText = 'width:' + (i === page ? '22px' : '8px') + ';height:8px;border-radius:99px;display:block;'
                + 'background:' + (i === page ? '#fff' : 'rgba(255,255,255,.35)') + ';transition:all .2s;';
            dots.appendChild(d);
        }
    };
    const renderPage = (idx: number): void => {
        page = Math.max(0, Math.min(PAGES - 1, idx));
        if (!_cur) return;
        stage.innerHTML = pageHtml(_cur, page);
        renderDots();
    };
    const turn = (dir: number): void => renderPage(page + dir);
    const onKey = (e: KeyboardEvent): void => {
        if (!document.getElementById(OV_ID)) return;
        if (e.key === 'ArrowRight') turn(1);
        else if (e.key === 'ArrowLeft') turn(-1);
        else if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey, true); }
    };
    document.addEventListener('keydown', onKey, true);
    (ov as any).__renderPage = renderPage;

    document.body.appendChild(ov);
    renderPage(0);
}

function lastPlayedOf(it: { lastPlayedAt?: number; sessions?: [string, string][] }): number {
    if (it.lastPlayedAt) return it.lastPlayedAt;
    let best = 0;
    for (const s of it.sessions || []) {
        const t = getSessionTs(s[0]);
        if (t > best) best = t;
    }
    return best;
}

// ── 页面 HTML ──
/** 单页 HTML（导出便于验证「用户实际看到什么」，如无数据时不得编造结论）。 */
export function pageHtml(r: YearReport, page: number): string {
    const hours = r.totalMs / 3600000;
    const esc = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    // [lc-1230b] 作品级数据口径：飞牛给不出观看日期时只能给全库累计，
    //   凡是用到「片单/看完率/打分数」的地方都要标出来，避免把全库当成「本年」误读。
    const allScope = r.itemsScope === 'all';
    const scopeTag = allScope ? '<span style="font-size:10px;color:#8a93ad;font-weight:600;">（全库累计）</span>' : '';
    const head = (kicker: string) => `<div style="position:absolute;top:26px;left:0;right:0;text-align:center;
        font-size:11px;font-weight:800;letter-spacing:4px;color:#8a93ad;">${kicker}</div>`;
    if (page === 0) {
        return `<div style="position:absolute;inset:0;background:linear-gradient(165deg,rgba(109,127,242,.10),rgba(138,99,232,.06));
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;">
            ${head('FNTV-PLUS · ' + r.year + ' 年度观影报告')}
            <div style="font-size:15px;font-weight:700;color:${SUB};">这一年，你在 Fntv-Plus 看了</div>
            <div style="display:flex;align-items:baseline;gap:8px;">
                <span style="font-size:74px;font-weight:900;background:${ACCENT_GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;">${fmtHours(r.totalMs)}</span>
                <span style="font-size:20px;font-weight:800;color:${INK};">小时</span>
            </div>
            <div style="display:flex;gap:26px;margin-top:6px;">
                <div style="text-align:center;"><div style="font-size:24px;font-weight:900;color:${INK};">${r.titles}</div><div style="font-size:11px;color:${SUB};">部作品${scopeTag}</div></div>
                <div style="text-align:center;"><div style="font-size:24px;font-weight:900;color:${INK};">${r.activeDays}</div><div style="font-size:11px;color:${SUB};">天有观影</div></div>
                <div style="text-align:center;"><div style="font-size:24px;font-weight:900;color:${INK};">${r.finished}</div><div style="font-size:11px;color:${SUB};">部看完${scopeTag}</div></div>
            </div>
            ${r.ignored > 0 ? `<div style="font-size:11px;color:#b06a3a;background:rgba(176,106,58,.10);border:1px solid rgba(176,106,58,.28);border-radius:8px;padding:5px 12px;margin-top:10px;">🛠 已自动修正 ${r.ignored} 条异常时间记录（播放时间早于 2000 年的脏数据，不计入统计）</div>` : ''}
            ${r.source === 'ledger' ? `<div style="font-size:11px;color:#4a5fd0;background:rgba(109,127,242,.10);border:1px solid rgba(109,127,242,.28);border-radius:8px;padding:5px 12px;margin-top:10px;max-width:600px;line-height:1.6;">📊 播放时段按观影台账估算（每日记录 × 你的平均单次时长）；飞牛未提供观看日期，「部作品 / 部看完 / 片单」为全库累计值。播一段后重开即逐步精确。</div>` : ''}
            ${r.source === 'items' ? `<div style="font-size:11px;color:#4a5fd0;background:rgba(109,127,242,.10);border:1px solid rgba(109,127,242,.28);border-radius:8px;padding:5px 12px;margin-top:10px;">📊 时长按飞牛观看进度折算（真实），日期按最近播放归入本年</div>` : ''}
            <div style="position:absolute;bottom:20px;font-size:10.5px;color:#8a93ad;">← → 翻页 · Esc 关闭 · 可导出长图</div>
        </div>`;
    }
    if (page === 1) {
        const max = Math.max(...r.monthMs, 1);
        const bars = r.monthMs.map((ms, i) => {
            const h = Math.max(3, Math.round((ms / max) * 150));
            const hot = ms === max && ms > 0;
            return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;">
                <div style="font-size:9px;color:${hot ? '#4a5fd0' : 'transparent'};font-weight:700;">峰值</div>
                <div style="width:60%;height:${h}px;border-radius:7px;background:${hot ? ACCENT_GRAD : 'linear-gradient(180deg,rgba(109,127,242,.55),rgba(109,127,242,.25))'};"></div>
                <div style="font-size:10px;color:${SUB};">${i + 1}月</div>
            </div>`;
        }).join('');
        // [lc-1230b] 月份全零时不得声称「最猛的是 1 月」——那是数组下标 0 的假结论
        const peakIdx = r.monthMs.indexOf(Math.max(...r.monthMs));
        const head2 = r.totalMs > 0
            ? `你观影最猛的一个月是 <span style="background:${ACCENT_GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;">${peakIdx + 1} 月</span>`
            : '月度节奏';
        return `<div style="position:absolute;inset:0;padding:56px 46px 30px;">
            ${head('PAGE 2 · 月度节奏')}
            <div style="font-size:24px;font-weight:900;color:${INK};margin:14px 0 6px;">${head2}</div>
            <div style="display:flex;align-items:flex-end;gap:8px;height:220px;margin-top:26px;">${bars}</div>
        </div>`;
    }
    if (page === 2) {
        const max = Math.max(...r.hourMs, 1);
        const bars = r.hourMs.map((ms, h) => {
            const hh = h > 9 ? String(h) : '0' + h;
            return `<div title="${hh}:00" style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;">
                <div style="width:70%;height:${Math.max(3, Math.round((ms / max) * 110))}px;border-radius:4px 4px 0 0;background:${h >= 0 && h < 5 ? ACCENT_GRAD : 'rgba(109,127,242,.35)'};"></div>
                ${h % 3 === 0 ? `<div style="font-size:8.5px;color:${SUB};">${hh}</div>` : '<div style="font-size:8.5px;">&nbsp;</div>'}
            </div>`;
        }).join('');
        // [lc-1230b] 时刻数据缺失时必须说清，不能默认成「养生作息」——每日台账只记「当天看了几部」，
        //   没有小时维度，硬算只会给出「深夜占比 0.0% + 养生作息」这种看着像结论的编造值。
        const hourTotal = r.hourMs.reduce((a, b) => a + b, 0);
        if (hourTotal <= 0) {
            return `<div style="position:absolute;inset:0;padding:56px 46px 30px;">
                ${head('PAGE 3 · 观影时刻')}
                <div style="font-size:24px;font-weight:900;color:${INK};margin:14px 0 6px;">观影时刻</div>
                <div style="color:#5a6480;line-height:1.9;margin-top:10px;">暂无可用的观看时刻数据。<br>
                飞牛未提供观看时间，每日台账也只记录「当天看了几部」而没有具体小时。<br>
                <span style="color:#4a5fd0;">用本应用播放一段后重开本报告，即可看到真实的 24 小时分布与夜猫指数。</span></div>
            </div>`;
        }
        const owl = r.nightRatio > 0.25 ? '重度夜猫 🦉' : (r.nightRatio > 0.1 ? '轻度夜猫 🌙' : '养生作息 ☀️');
        return `<div style="position:absolute;inset:0;padding:56px 46px 30px;">
            ${head('PAGE 3 · 观影时刻')}
            <div style="font-size:24px;font-weight:900;color:${INK};margin:14px 0 4px;">你是 <span style="background:${ACCENT_GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;">${owl}</span></div>
            <div style="font-size:12px;color:${SUB};margin-bottom:18px;">深夜时段(00-05点)观看占比 ${(r.nightRatio * 100).toFixed(1)}%</div>
            <div style="display:flex;align-items:flex-end;height:140px;">${bars}</div>
        </div>`;
    }
    if (page === 3) {
        const max = r.top.length ? r.top[0].ms : 1;
        const rows = r.top.map((t, i) => {
            const medal = ['🥇', '🥈', '🥉', '④', '⑤'][i] || '';
            return `<div style="display:flex;align-items:center;gap:12px;margin:12px 0;">
                <div style="font-size:17px;width:26px;">${medal}</div>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
                        <span style="font-size:14px;font-weight:700;color:${INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.name)}</span>
                        <span style="font-size:11px;color:${SUB};flex-shrink:0;">${fmtHours(t.ms)} 小时${t.prog >= 1 ? ' · 已看完' : ''}</span>
                    </div>
                    <div style="margin-top:5px;height:7px;border-radius:99px;background:rgba(109,127,242,.14);">
                        <div style="height:100%;width:${Math.max(4, Math.round((t.ms / max) * 100))}%;border-radius:99px;background:${ACCENT_GRAD};"></div>
                    </div>
                </div>
            </div>`;
        }).join('');
        return `<div style="position:absolute;inset:0;padding:56px 46px 30px;">
            ${head('PAGE 4 · 年度片单')}
            <div style="font-size:24px;font-weight:900;color:${INK};margin:14px 0 18px;">你的年度 TOP5${scopeTag}</div>
            ${rows || (r.source === 'ledger' ? '<div style="color:#5a6480;line-height:1.8;">暂无可排序的作品数据，<br>多播放几部后即可生成年度片单。</div>' : '<div style="color:#5a6480;">今年暂无观看时长数据</div>')}
        </div>`;
    }
    const doneRate = r.titles ? Math.round((r.finished / r.titles) * 100) : 0;
    return `<div style="position:absolute;inset:0;background:linear-gradient(165deg,rgba(109,127,242,.12),rgba(138,99,232,.06));
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;">
        ${head('PAGE 5 · 总结')}
        <div style="font-size:26px;font-weight:900;color:${INK};">${r.year} 年，最大连续观影 <span style="background:${ACCENT_GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;">${r.maxStreak} 天</span></div>
        <div style="display:flex;gap:34px;">
            <div style="text-align:center;"><div style="font-size:30px;font-weight:900;color:${INK};">${doneRate}%</div><div style="font-size:11px;color:${SUB};">看完率${scopeTag}</div></div>
            <div style="text-align:center;"><div style="font-size:30px;font-weight:900;color:${INK};">${r.rated}</div><div style="font-size:11px;color:${SUB};">打过分${scopeTag}</div></div>
            <div style="text-align:center;"><div style="font-size:30px;font-weight:900;color:${INK};">${r.activeDays}</div><div style="font-size:11px;color:${SUB};">观影天数</div></div>
        </div>
        <div style="font-size:12.5px;color:${SUB};margin-top:8px;">期待 ${r.year + 1} 年继续与你相伴 🎬</div>
        <div style="font-size:10.5px;color:#8a93ad;">点击底部「导出长图」保存分享</div>
    </div>`;
}

// ── 导出长图（canvas 程序化绘制，纯图形/文字不污染画布）──
function exportLongImage(): void {
    const r = _cur;
    if (!r) return;
    const W = 720;
    const SEC = 300;
    const H = 180 + SEC * 5 + 40;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // 底
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fafbfe'); bg.addColorStop(1, '#eef1fa');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // 光斑
    const blob = (x: number, y: number, r0: number, color: string): void => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r0);
        g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(x - r0, y - r0, r0 * 2, r0 * 2);
    };
    blob(120, 120, 260, 'rgba(150,120,200,.25)');
    blob(600, 260, 240, 'rgba(148,196,236,.22)');
    blob(360, 1300, 280, 'rgba(186,222,206,.18)');
    const ink = '#2f3550', sub = '#5a6480';
    const accent = (x: number, y: number, w0: number, h0: number): void => {
        const g = ctx.createLinearGradient(x, y, x + w0, y + h0);
        g.addColorStop(0, '#6d7ff2'); g.addColorStop(1, '#8a63e8');
        ctx.fillStyle = g; ctx.fillRect(x, y, w0, h0);
    };
    const text = (t: string, x: number, y: number, size: number, weight: string, color: string, align: CanvasTextAlign = 'left'): void => {
        ctx.fillStyle = color; ctx.font = `${weight} ${size}px "Microsoft YaHei",sans-serif`; ctx.textAlign = align; ctx.fillText(t, x, y);
    };
    const hours = r.totalMs / 3600000;
    const maxMonth = Math.max(...r.monthMs, 1);
    const maxHour = Math.max(...r.hourMs, 1);
    const maxTop = r.top.length ? r.top[0].ms : 1;
    // [lc-1230b] 导出图与页面同口径：作品级数据是全库累计时必须标出
    const SCOPE_SUFFIX = r.itemsScope === 'all' ? '（全库累计）' : '';

    // 封面段
    text('FNTV-PLUS · ' + r.year + ' 年度观影报告', W / 2, 70, 13, '800', '#8a93ad', 'center');
    text('这一年，你在 Fntv-Plus 看了', W / 2, 118, 15, '700', sub, 'center');
    accent(W / 2 - 92, 138, 184, 62);
    text(String(fmtHours(r.totalMs)), W / 2, 182, 52, '900', '#ffffff', 'center');
    text('小时', W / 2 + 104, 182, 18, '800', ink, 'center');
    const c3 = [['部作品' + SCOPE_SUFFIX, String(r.titles)], ['天有观影', String(r.activeDays)], ['部看完' + SCOPE_SUFFIX, String(r.finished)]];
    c3.forEach(([l, v], i) => {
        const x = W / 2 + (i - 1) * 150;
        text(v, x, 246, 26, '900', ink, 'center');
        text(l, x, 268, 11, '600', sub, 'center');
    });

    // 月度
    let y0 = 360;
    text('月度节奏', 46, y0, 20, '900', ink);
    const peak = r.monthMs.indexOf(Math.max(...r.monthMs));
    if (r.totalMs > 0) text('最猛的一个月：' + (peak + 1) + ' 月', W - 46, y0, 13, '700', '#4a5fd0', 'right');
    const bw = 34, gap = (W - 92 - bw * 12) / 11;
    for (let i = 0; i < 12; i++) {
        const h = Math.max(4, Math.round((r.monthMs[i] / maxMonth) * 130));
        const x = 46 + i * (bw + gap);
        if (i === peak) accent(x, y0 + 30 + 130 - h, bw, h);
        else { ctx.fillStyle = 'rgba(109,127,242,.30)'; ctx.fillRect(x, y0 + 30 + 130 - h, bw, h); }
        text((i + 1) + '月', x + bw / 2, y0 + 30 + 148, 10, '600', sub, 'center');
    }

    // 时刻
    y0 += 240;
    // [lc-1230b] 与页面同口径：无小时数据时如实写「暂无」，不编造「养生作息」结论
    const hourTotalExport = r.hourMs.reduce((a, b) => a + b, 0);
    const owl = r.nightRatio > 0.25 ? '重度夜猫 🦉' : (r.nightRatio > 0.1 ? '轻度夜猫 🌙' : '养生作息 ☀️');
    if (hourTotalExport > 0) {
        text('观影时刻 · ' + owl + '（深夜占比 ' + (r.nightRatio * 100).toFixed(1) + '%）', 46, y0, 20, '900', ink);
    } else {
        text('观影时刻 · 暂无可用的观看时刻数据', 46, y0, 20, '900', ink);
        text('飞牛未提供观看时间，用本应用播放一段后重开即有 24 小时分布', 46, y0 + 22, 11, '600', sub);
    }
    const hw = (W - 92) / 24 - 4;
    for (let h = 0; h < 24; h++) {
        const hh = Math.max(3, Math.round((r.hourMs[h] / maxHour) * 90));
        const x = 46 + h * (hw + 4);
        ctx.fillStyle = h < 5 ? '#6d7ff2' : 'rgba(109,127,242,.35)';
        ctx.fillRect(x, y0 + 24 + 90 - hh, hw, hh);
        if (h % 6 === 0) text(String(h).padStart(2, '0'), x + hw / 2, y0 + 24 + 108, 9, '600', sub, 'center');
    }

    // TOP5
    y0 += 200;
    text('年度 TOP5' + SCOPE_SUFFIX, 46, y0, 20, '900', ink);
    const medals = ['🥇', '🥈', '🥉', '④', '⑤'];
    r.top.forEach((t, i) => {
        const yy = y0 + 34 + i * 52;
        text(medals[i], 46, yy + 16, 17, '700', ink);
        text(t.name.slice(0, 22), 78, yy + 14, 14, '700', ink);
        text(fmtHours(t.ms) + ' 小时' + (t.prog >= 1 ? ' · 已看完' : ''), W - 46, yy + 14, 11, '600', sub, 'right');
        ctx.fillStyle = 'rgba(109,127,242,.14)';
        ctx.fillRect(78, yy + 22, W - 78 - 46, 7);
        accent(78, yy + 22, Math.max(6, Math.round(((t.ms / maxTop) * (W - 78 - 46)))), 7);
    });

    // 总结
    y0 += 330;
    const doneRate = r.titles ? Math.round((r.finished / r.titles) * 100) : 0;
    accent(W / 2 - 150, y0, 300, 2);
    text(r.year + ' 年，最大连续观影 ' + r.maxStreak + ' 天', W / 2, y0 + 52, 24, '900', ink, 'center');
    const c5 = [['看完率' + SCOPE_SUFFIX, doneRate + '%'], ['打过分' + SCOPE_SUFFIX, String(r.rated)], ['观影天数', String(r.activeDays)]];
    c5.forEach(([l, v], i) => {
        const x = W / 2 + (i - 1) * 150;
        text(v, x, y0 + 108, 26, '900', ink, 'center');
        text(l, x, y0 + 130, 11, '600', sub, 'center');
    });
    text('期待 ' + (r.year + 1) + ' 年继续与你相伴 🎬  ·  Fntv-Plus 生成', W / 2, H - 40, 10.5, '600', '#8a93ad', 'center');
    // [lc-1230/1230b] 导出图同样注明数据口径（估算/折算/全库累计时不能让人当成精确值）
    const note = r.source === 'ledger'
        ? (r.itemsScope === 'all'
            ? '数据口径：时段按观影台账估算；飞牛未提供观看日期，「部作品/部看完/看完率/片单」为全库累计'
            : '数据口径：按观影台账估算（每日记录 × 平均单次时长）')
        : (r.source === 'items' ? '数据口径：时长按飞牛观看进度折算，日期按最近播放归年' : '');
    if (note) text(note, W / 2, H - 22, 10, '600', '#8a93ad', 'center');

    // 下载
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = `Fntv-Plus_年度观影报告_${r.year}.png`;
    a.click();
}

// ── 注册 ──
registerHook(HookType.OnReady, () => {
    ensureButton();
    const obs = new MutationObserver(() => ensureButton());
    const target = document.body || document.documentElement;
    obs.observe(target, { childList: true, subtree: true });
    window.setInterval(() => { try { ensureButton(); } catch { /* ignore */ } }, 4000);
});
