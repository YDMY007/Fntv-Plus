// preload/plugins/danmakuWeb.ts
//
// [原生网页播放器弹幕] 飞牛「原声播放器」(fnOS 网页自身 <video>) 的 B站弹幕支持。
//
// 设计要点（用户明确要求）：
//   1) 控制栏里有三个按钮：
//        - 「弹幕」：弹幕开关（默认开，localStorage 记忆，颜色区分开/关）。
//        - 「详情」：弹出窗口，展示弹幕【来源信息】（从哪个区/哪个 B站标题匹配、相似度、
//                    bvid/cid、条数）—— 与 MPV 的弹幕来源提示一致，而非罗列全部弹幕。
//        - 「样式」：弹出面板，调节弹幕样式（粗体/字号/描边/阴影/滚动时长/透明度/显示范围），
//                    对齐 MPV 弹幕样式旋钮，配置 localStorage 独立持久化。
//   2) 弹幕渲染采用 B站网页播放器同款方案：<canvas> 逐帧重绘引擎（非 DOM 元素），
//      挂在 body 上 position:fixed，每帧按 video.getBoundingClientRect() 对齐播放画面，
//      彻底规避「overlay 没盖对位置 / video 元素选错」导致的时灵时不灵。
//   3) 默认开；开关状态用 localStorage 记忆。
//   4) 电影(ep=0)：主进程 search_cid 自动退化为「仅按番名搜、取弹幕最多的集」，与 MPV 一致。
//
// 数据通道：ipcRenderer.invoke('danmaku:prepare', {guid}) → 主进程解析标题/集数并抓 B站弹幕，
// 返回结构化弹幕条目 + 来源 meta（避免 https 页 fetch http 本地服务的 mixed-content/CORS 问题）。

import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import logger from '../core/logger';

const log = logger;

/** 已拉取过的 guid（切集去重，避免重复请求 B站） */
const loadedGuids = new Set<string>();

/** 播放页 URL 正则（电影 / 剧集 / 视频）。
 * [lc-662→回退] 不含 other：个人视频(/v/other/)不是 B站内容，不应触发弹幕匹配。
 *   之前误加 other 会让个人视频详情页发起无谓的 B站弹幕搜索。 */
const GUID_RE = /\/v\/(?:movie|tv|video)(?:\/(?:season|episode))?\/([a-f0-9]{32})/i;

const LS_KEY = 'fntv_danmaku_enabled';
const LS_STYLE_KEY = 'fntv_danmaku_style';

// ═══ [lc-544] 播放页顶部标题栏美化 ═══
// 飞牛原生播放页顶部的页面级 header（返回箭头+标题+窗口控件）在视频上方很突兀。
// 注入半透明毛玻璃 + 鼠标不动自动隐藏，跟现代播放器控制栏风格一致。
const PLAYER_HEADER_STYLE_ID = 'fntv-player-header-style';
let _headerStyleInjected = false;
let _headerHideTimer: ReturnType<typeof setTimeout> | null = null;
const HEADER_HIDE_DELAY = 2500; // 鼠标不动 2.5s 后自动隐藏

/** 注入播放页顶部标题栏美化 CSS（仅执行一次） */
function injectPlayerHeaderStyle(): void {
    if (_headerStyleInjected) return;
    const css = `
/* ── 播放页顶部标题栏：毛玻璃 + 自动隐藏 ──
   目标：fnOS 页面级 header（含返回箭头+标题文字），非 xgplayer 自身控件 */
html:has(video) header,
html:has(video) nav,
html:has(video) [role="banner"],
html:has(video) [class*="header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="Header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="navbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="topbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="top-bar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]) {
    background: rgba(0, 0, 0, .45) !important;
    backdrop-filter: blur(24px) saturate(150%) !important;
    -webkit-backdrop-filter: blur(24px) saturate(150%) !important;
    border-bottom: 1px solid rgba(255, 255, 255, .08) !important;
    transition: opacity .35s ease, transform .35s ease !important;
}
/* 自动隐藏状态：鼠标不动一段时间后淡出上滑 */
html.fntv-ph-hidden header,
html.fntv-ph-hidden nav,
html.fntv-ph-hidden [role="banner"],
html.fntv-ph-hidden [class*="header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="Header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="navbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="topbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="top-bar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]) {
    opacity: 0 !important;
    pointer-events: none !important;
    transform: translateY(-8px) !important;
}
`;
    const el = document.createElement('style');
    el.id = PLAYER_HEADER_STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    _headerStyleInjected = true;
    log.info('[danmakuWeb] 播放页顶部标题栏美化 CSS 已注入');
}

/** 重置隐藏计时器：鼠标活动时显示标题栏，静止后自动隐藏 */
function resetHeaderHideTimer(): void {
    if (!isPlayerPage()) return;
    document.documentElement.classList.remove('fntv-ph-hidden');
    if (_headerHideTimer) clearTimeout(_headerHideTimer);
    _headerHideTimer = setTimeout(() => {
        if (isPlayerPage()) document.documentElement.classList.add('fntv-ph-hidden');
    }, HEADER_HIDE_DELAY);
}

/** 绑定播放页标题栏自动隐藏的鼠标事件（仅绑定一次） */
let _headerAutoHideBound = false;
function bindHeaderAutoHide(): void {
    if (_headerAutoHideBound || !isPlayerPage()) return;
    _headerAutoHideBound = true;
    document.addEventListener('mousemove', resetHeaderHideTimer, { passive: true });
    document.addEventListener('touchstart', resetHeaderHideTimer, { passive: true });
    // 初始显示，延迟开始倒计时
    setTimeout(resetHeaderHideTimer, 600);
    log.info('[danmakuWeb] 播放页标题栏自动隐藏已启用 (' + HEADER_HIDE_DELAY + 'ms)');
}

/** 播放器全屏时给 html 打 fntv-video-fullscreen 标记, 由 mainwin.ts 的 ACRYLIC_CSS
    在命中该 class(或原生 :fullscreen)时去掉窗口圆角/clip-path, 使视频4角变直角。
    [lc-552] 重构检测策略: 不再依赖 ResizeObserver+尺寸阈值(时序不稳定→圆角时灵时不灵),
    改为直接监听 xgplayer 自身的 xgplayer-fullscreen class(MutationObserver),
    这是最可靠的全屏信号——xgplayer 进入/退出伪全屏时立即添加/移除该 class。 */
let _fsFixBound = false;
function applyVideoFullscreenClass(): void {
    // ① 浏览器原生全屏（最高优先级）
    const nativeFs = !!document.fullscreenElement;
    // ② 飞牛 xgplayer 伪全屏：直接检查 xgplayer-fullscreen class（xgplayer 自身管理）
    const pseudoFs = !!document.querySelector('.xgplayer.xgplayer-fullscreen');
    document.documentElement.classList.toggle('fntv-video-fullscreen', nativeFs || pseudoFs);
}
function bindVideoFullscreenFix(): void {
    if (!isPlayerPage()) return;
    // 非播放页(如路由切走)也要清理残留标记, 避免影响首页圆角
    if (_fsFixBound) { applyVideoFullscreenClass(); return; }
    _fsFixBound = true;
    const update = () => applyVideoFullscreenClass();
    // 浏览器原生全屏事件
    document.addEventListener('fullscreenchange', update, { passive: true });
    // [lc-552] 核心：MutationObserver 监听 .xgplayer 容器的 class 变化
    // xgplayer 进入伪全屏时立即加 xgplayer-fullscreen、退出时移除，比尺寸检测可靠得多
    const tryObservePlayerClass = () => {
        const player = document.querySelector('.xgplayer') as HTMLElement | null;
        if (player && !player.dataset.fntvFsObserved) {
            player.dataset.fntvFsObserved = '1';
            new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        update();
                        break; // 一个 mutation 就够了
                    }
                }
            }).observe(player, { attributes: true, attributeFilter: ['class'] });
        }
    };
    // 立即尝试 + 延迟重试（播放器可能稍后渲染）
    tryObservePlayerClass();
    setTimeout(tryObservePlayerClass, 1000);
    setTimeout(tryObservePlayerClass, 3000);
    // resize 兜底（处理窗口大小变化等边缘情况）
    window.addEventListener('resize', update, { passive: true });
    applyVideoFullscreenClass();
    log.info('[danmakuWeb] 播放器全屏去圆角检测已启用 (MutationObserver+xgplayer-fullscreen)');
}

interface DanmakuItem {
    time: number;   // 秒
    type: number;   // 1/2/3=滚动 4=底部 5=顶部
    color: number;  // 十进制 RGB
    text: string;
}

interface DanmakuMeta {
    searchTitle: string;
    matchedTitle: string;
    source: string;          // 'bangumi' | 'video'
    bvid?: string | null;
    cid?: any;
    sim?: number | null;
    ep: number;
    season: number;          // 目标季数（0=未指定）；>0 时优先精确匹配该季
    isMovie: boolean;
    count: number;
    aggregatedFrom?: any;
    cookieStatus?: string;
    error?: string;
}

interface DanmakuStyle {
    bold: boolean;          // 粗体（MPV bold）
    fontScale: number;      // 字号 / 画布高（MPV fontsize 概念）
    outline: number;        // 描边强度 0~3（MPV outline，默认 1.0）
    shadow: number;         // 阴影强度 0~3（MPV shadow，默认 0）
    scrollDuration: number; // 滚动横跨秒数（MPV scrolltime，默认 8）
    opacity: number;        // 全局不透明度 0.3~1（MPV opacity，默认 0.7）
    displayArea: number;    // 弹幕显示范围（占画布高比例，MPV displayarea 默认 0.85）
}

interface ActiveState {
    appear: number;          // 出现时的 video.currentTime
    lane: number;
    w: number;               // 文本像素宽（激活时测量一次）
    fix: boolean;            // 是否固定弹幕（顶/底）
}

// ─── 运行态 ───
let videoEl: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let toggleWrap: HTMLDivElement | null = null;
let toggleSpan: HTMLSpanElement | null = null;
let detailsWrap: HTMLDivElement | null = null;
let modal: HTMLDivElement | null = null;
let styleWrap: HTMLDivElement | null = null;
let stylePanel: HTMLDivElement | null = null;
let controlsPlaced = false;
let mountedForGuid: string | null = null;
let loading = false;
let inflight = false;       // 同一 guid 只允许一个在途请求（单飞，避免并发重复拉取触发 B站限流）
let enabled = true;
let items: DanmakuItem[] = [];
let meta: DanmakuMeta | null = null;
let currentGuid: string | null = null;
// [lc-1015] currentGuid 是否来自 play/info 预取（此刻 URL 可能还停留在详情页/上一集）。
// URL 触发的 prepareAndLoad 看到不一致的 guid 时以预取为准，避免旧 URL 把 currentGuid 拉回去。
let currentGuidFromPrefetch = false;
// [lc-1015] guid → 弹幕结果 的内存 LRU（上限 6 个）：详情页预取后进播放页、播放页切集再切回、
// 同一次会话重进同一集都直接命中，不再走 IPC（IPC 虽有磁盘缓存也有 ~百毫秒开销）。
const guidCache = new Map<string, { items: DanmakuItem[]; meta: DanmakuMeta | null }>();
const GUID_CACHE_MAX = 6;

function guidCachePut(guid: string, payload: { items: DanmakuItem[]; meta: DanmakuMeta | null }): void {
    guidCache.delete(guid);
    guidCache.set(guid, payload);
    while (guidCache.size > GUID_CACHE_MAX) {
        const oldest = guidCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        guidCache.delete(oldest);
    }
}
let rafId = 0;
let lastTime = -1;

// canvas 渲染引擎状态
const active = new Map<number, ActiveState>();
// [lc-1015] 激活游标：items 按时间升序，已激活过的下标不再重扫（旧版每帧从 0 扫到尾，
// 万条弹幕时每帧上万次 Set 查询，低配机可感）。seek 回拖时归零。
let cursor = 0;
// [lc-1015] 到点后找不到空轨道的宽限：超过即丢弃（对齐 B站 高密度行为），避免迟到弹幕成堆涌入。
const LANE_GRACE_SEC = 2.0;
// [lc-1015] 同文本去重窗口：±1s 内重复文本直接丢弃（多源聚合已在主进程 ±2s 去重，
// 单源内部的「前方高能」刷屏仍会成堆出现）。
const DUP_TEXT_SEC = 1.0;
const recentTexts = new Map<string, number>();
// [lc-1015] 暂停时画面静止：仅在脏（进度/尺寸/样式变化）时重绘，省掉暂停期间的无谓逐帧 clear+draw。
let renderDirty = true;
let lastPausedDraw = false;
let laneBusyScroll: number[] = [];   // 各轨道"滚动弹幕"占用到（video 时间）
let laneBusyTop: number[] = [];      // [lc-1015] 顶部固定弹幕独立轨道（旧版顶/底共用一池会隐形互撞）
let laneBusyBottom: number[] = [];   // [lc-1015] 底部固定弹幕独立轨道
let laneCount = 0;

// 渲染参数（参照 B站网页弹幕引擎）
const LANE_RATIO = 0.034;    // 单轨道高 / 画布高（轨道高度基准，不暴露给用户）
const MAX_ACTIVE = 80;       // 同屏活跃弹幕硬顶（防极端高峰）

// 弹幕样式（默认对齐 MPV 观感；用户可在播放器内「样式」面板调节，各端独立持久化）
const DEFAULT_STYLE: DanmakuStyle = {
    bold: false,
    fontScale: 0.036,
    outline: 1.0,
    shadow: 0,
    scrollDuration: 8,
    opacity: 0.9,
    displayArea: 0.85,
};

function clampNum(v: any, min: number, max: number, dflt: number): number {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

function loadStyle(): DanmakuStyle {
    try {
        const raw = localStorage.getItem(LS_STYLE_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                bold: !!p.bold,
                fontScale: clampNum(p.fontScale, 0.018, 0.072, DEFAULT_STYLE.fontScale),
                outline: clampNum(p.outline, 0, 3, DEFAULT_STYLE.outline),
                shadow: clampNum(p.shadow, 0, 3, DEFAULT_STYLE.shadow),
                scrollDuration: clampNum(p.scrollDuration, 4, 16, DEFAULT_STYLE.scrollDuration),
                opacity: clampNum(p.opacity, 0.3, 1, DEFAULT_STYLE.opacity),
                displayArea: clampNum(p.displayArea, 0.3, 1, DEFAULT_STYLE.displayArea),
            };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_STYLE };
}

function saveStyle(): void {
    try { localStorage.setItem(LS_STYLE_KEY, JSON.stringify(style)); } catch { /* ignore */ }
    renderDirty = true; // [lc-1015] 样式变化后即使暂停也立即重绘生效
}

let style: DanmakuStyle = loadStyle();

// ─── 页面检测 ───

function isPlayerPage(): boolean {
    return !!(document.querySelector('video') && GUID_RE.test(window.location.href));
}

function getGuid(): string | null {
    const m = window.location.href.match(GUID_RE);
    return m?.[1] || null;
}

// ─── 选视频（取可见面积最大的那个，规避"选错 video 元素"导致的时灵时不灵）───

function pickVideo(): HTMLVideoElement | null {
    const vs = document.querySelectorAll('video');
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (let i = 0; i < vs.length; i++) {
        const v = vs[i] as HTMLVideoElement;
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
}

// ─── DOM 定位：控制栏 ───

/**
 * 找原生控制栏（从 document 精确锚定，不使用会误中提示气泡的模糊选择器）。
 * 飞牛播放器实测 DOM：<xg-controls class="xgplayer-controls"> 内含 <xg-right-grid>，
 * 原画/选集/倍速等文字按钮都是 <div class="plugin-placeholder"> 子节点。
 */
function findControlsBar(): HTMLElement | null {
    const right = document.querySelector('xg-right-grid') as HTMLElement | null;
    if (right && right.offsetHeight > 0) return right;
    const controls = (document.querySelector('xg-controls.xgplayer-controls') ||
        document.querySelector('.xgplayer-controls')) as HTMLElement | null;
    if (controls && controls.offsetHeight > 0) {
        const innerRight = controls.querySelector('xg-right-grid') as HTMLElement | null;
        if (innerRight && innerRight.offsetHeight > 0) return innerRight;
        return controls;
    }
    const all = document.querySelectorAll('div, nav, [role]');
    for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement;
        const h = el.offsetHeight;
        const txt = el.textContent || '';
        if ((txt.includes('倍速') || txt.includes('选集') || txt.includes('原画')) &&
            h > 20 && h < 120 && el.children.length >= 2) {
            return el;
        }
    }
    return null;
}

// ─── 挂载 canvas + 控制栏按钮 ───

function ensureCanvas(): void {
    if (canvas) return;
    const c = document.createElement('canvas');
    c.id = 'fntv-danmaku-canvas';
    Object.assign(c.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        zIndex: '5',          // 高于 video(0)，低于 xgplayer 控制栏/UI
        pointerEvents: 'none',
        display: enabled ? 'block' : 'none',
    } as CSSStyleDeclaration);
    document.body.appendChild(c);
    canvas = c;
    ctx = c.getContext('2d');
}

function ensureMounted(): void {
    if (!isPlayerPage()) return;
    ensureCanvas();

    // 控制栏按钮：弹幕开关 + 详情
    const bar = findControlsBar();
    if (bar) {
        if (!toggleWrap) createControls();
        if (toggleWrap && toggleWrap.parentElement !== bar) bar.appendChild(toggleWrap);
        if (detailsWrap && detailsWrap.parentElement !== bar) bar.appendChild(detailsWrap);
        if (styleWrap && styleWrap.parentElement !== bar) bar.appendChild(styleWrap);
        if (!controlsPlaced) {
            log.info('[danmakuWeb] 弹幕开关已注入控制栏(' + String(bar.className).slice(0, 40) + ')');
            controlsPlaced = true;
        }
    } else {
        // 控制栏尚未就绪：把按钮挂到 body 末尾也能点（极少见，飞牛几乎必有 xg-right-grid）
        if (!toggleWrap) createControls();
        if (toggleWrap && !toggleWrap.parentElement) document.body.appendChild(toggleWrap);
        if (detailsWrap && !detailsWrap.parentElement) document.body.appendChild(detailsWrap);
        if (styleWrap && !styleWrap.parentElement) document.body.appendChild(styleWrap);
    }
}

function makeControlButton(label: string, onClick: () => void): { wrap: HTMLDivElement; span: HTMLSpanElement } {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-placeholder';
    const hfull = document.createElement('div');
    hfull.className = 'h-full';
    const flex = document.createElement('div');
    flex.className = 'flex h-full items-center justify-center';
    flex.setAttribute('tabindex', '0');
    const span = document.createElement('span');
    span.className = 'cursor-pointer text-lg leading-lg text-[var(--semi-color-text-1)] hover:text-[var(--semi-color-text-0)]';
    span.textContent = label;
    span.style.userSelect = 'none';
    flex.appendChild(span);
    hfull.appendChild(flex);
    wrap.appendChild(hfull);
    flex.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
    });
    return { wrap, span };
}

function createControls(): void {
    if (toggleWrap) return;
    const t = makeControlButton('弹幕', () => toggleDanmaku());
    toggleWrap = t.wrap;
    toggleSpan = t.span;
    const d = makeControlButton('详情', () => openDetails());
    detailsWrap = d.wrap;
    const s = makeControlButton('样式', () => openStylePanel());
    styleWrap = s.wrap;
    syncToggleUI();
}

function syncToggleUI(): void {
    if (!toggleSpan) return;
    toggleSpan.textContent = loading ? '弹幕…' : '弹幕';
    toggleSpan.style.color = enabled
        ? 'var(--fn-bg-brand, #3374DB)'
        : 'var(--semi-color-text-1)';
    toggleSpan.style.opacity = enabled ? '1' : '0.55';
}

function toggleDanmaku(): void {
    enabled = !enabled;
    try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
    if (canvas) canvas.style.display = enabled ? 'block' : 'none';
    syncToggleUI();
    if (enabled) startRender();
    else stopRender();
}

// ─── 数据拉取 ───

/**
 * [lc-1015] 拉取指定 guid 的弹幕并进入渲染。
 * @param targetGuid 显式 guid（来自 play/info 请求体预取）；省略时从当前 URL 解析。
 *
 * 时序说明：用户点播放 → fnOS POST /v/api/v1/play/info（body 含 item_guid）→
 * installPlayInfoObserver 立刻带着 guid 调进来，此时播放器 DOM 可能还没挂载——
 * 这正是目的：弹幕下载与视频加载并行，播放器就绪时弹幕往往已经就位。
 */
async function prepareAndLoad(targetGuid?: string | null): Promise<void> {
    const urlGuid = getGuid();
    const guid = targetGuid || urlGuid;
    if (!guid) return;

    if (guid !== currentGuid) {
        // URL 触发但 currentGuid 是更"新"的预取 guid（选集切换瞬间 URL 常仍是旧集/详情页）→ 以预取为准
        if (!targetGuid && currentGuid && currentGuidFromPrefetch && urlGuid !== currentGuid) {
            if (items.length && enabled) startRender();
            return;
        }
        currentGuid = guid;
        currentGuidFromPrefetch = !!targetGuid && guid !== urlGuid;
        items = [];
        meta = null;
        resetRenderState();
        closeDetails();
        inflight = false;
    } else if (items.length && enabled) {
        startRender();
        return;
    }
    // 单飞：同一 guid 只允许一个在途请求。OnReady/OnDomChange/预取可能几乎同时触发，
    // 没有此保护会导致同一集并发跑多个 run() → B站限流(分片重试 2s) → 整体被拖到 1 分钟。
    if (inflight) {
        log.info('[danmakuWeb] 已有弹幕请求在途，跳过重复拉取');
        return;
    }

    // [lc-1015] 会话内 LRU 命中：详情页预取过 / 切集切回来 → 直接用，不进 IPC
    const cached = guidCache.get(guid);
    if (cached && cached.items.length) {
        items = cached.items;
        meta = cached.meta;
        loadedGuids.add(guid);
        renderDirty = true;
        log.info('[danmakuWeb] 会话缓存命中 ' + items.length + ' 条 guid=' + guid);
        if (enabled) startRender();
        return;
    }
    // 之前确认过「无弹幕」的集不再重复请求
    if (loadedGuids.has(guid) && items.length === 0 && meta) {
        return;
    }

    inflight = true;
    loading = true;
    syncToggleUI();
    try {
        const res = await ipcRenderer.invoke('danmaku:prepare', { guid }) as any;
        // [lc-1015] 请求期间用户可能已切到别的集（currentGuid 变了）：旧响应直接丢弃，
        // 旧版会把上一集的弹幕回写进当前集。
        if (guid !== currentGuid) {
            log.info('[danmakuWeb] 丢弃过期弹幕响应(已切集) guid=' + guid);
            return;
        }
        if (res && res.ok && Array.isArray(res.items) && res.items.length) {
            items = res.items as DanmakuItem[];
            meta = res.meta as DanmakuMeta || {
                searchTitle: res.title || '', matchedTitle: res.title || '',
                source: res.source || '', ep: res.ep || 0, season: res.season || 0, isMovie: !!res.isMovie,
                count: res.count || items.length,
            };
            loadedGuids.add(guid);
            guidCachePut(guid, { items, meta });
            renderDirty = true;
            log.info(`[danmakuWeb] 获取弹幕 ${items.length} 条 title="${res.title}" ep=${res.ep} movie=${res.isMovie}`);
            if (enabled) startRender();
        } else {
            meta = {
                searchTitle: res?.title || '', matchedTitle: res?.title || '',
                source: res?.source || '', ep: res?.ep ?? 0, season: res?.season || 0, isMovie: !!res?.isMovie,
                count: 0, error: res?.error || '空',
            };
            log.info('[danmakuWeb] 无弹幕: ' + (res?.error || '空'));
            loadedGuids.add(guid);
        }
    } catch (e) {
        log.error('[danmakuWeb] 获取弹幕失败:', e);
    } finally {
        inflight = false;
        loading = false;
        syncToggleUI();
    }
}

// ─── [lc-1015] 播放启动即预取：只读观察 play/info 请求 ───
// 旧时序要等 OnReady+1.5s / OnDomChange 防抖 0.8s、再等 video 元素和控制栏就绪才开拉
// （实测点播 → 开拉 ~4s，是网页端弹幕"慢"的主要来源之一）。用户点播放的瞬间 fnOS 必发
// POST /v/api/v1/play/info（body 含 item_guid），这里观察该请求立刻按 guid 预取，
// 弹幕下载与播放器加载并行。fetch/XHR 各包一层，只读透传、不改任何请求行为。
let _dmObserverInstalled = false;
function installPlayInfoObserver(): void {
    if (_dmObserverInstalled) return;
    _dmObserverInstalled = true;
    const PLAY_INFO_RE = /\/v\/api\/v1\/play\/info/i;
    const extractGuid = (raw: unknown): string | null => {
        try {
            const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const g = (body as any)?.item_guid ?? (body as any)?.data?.item_guid ?? (body as any)?.params?.item_guid;
            const m = typeof g === 'string' ? g.match(/[a-f0-9]{32}/i) : null;
            return m ? m[0] : null;
        } catch { return null; }
    };
    const onPlayInfo = (guid: string | null): void => {
        if (!guid) return;
        // 弹幕开关：预取发生播放器挂载前（模块级 enabled 还没同步过 localStorage），直接读存储
        try { if (localStorage.getItem(LS_KEY) === '0') return; } catch { /* ignore */ }
        if (guid === currentGuid && (inflight || items.length)) return; // 已在拉/已就位
        log.info('[danmakuWeb] play/info 预取弹幕 guid=' + guid);
        void prepareAndLoad(guid);
    };

    const origFetch = window.fetch;
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url || '';
        const isPlayInfo = PLAY_INFO_RE.test(url) && (init?.method || 'GET').toUpperCase() !== 'GET' && !!init?.body;
        if (!isPlayInfo) return origFetch.call(this, input, init);
        const guid = extractGuid(init!.body);
        const resp = await origFetch.call(this, input, init);
        // skipInject 在「外部播放器(MPV)」流程会把 play/info 伪造成 {success:true,data:null}
        // 阻止原生播放器启动——识别出这种响应就不预取（MPV 自己会拉弹幕）。
        // 真实 play/info 的 data 恒为对象；命中伪造特征时跳过预取。
        try {
            const ct = resp.headers?.get?.('content-type') || '';
            if (ct.includes('json')) {
                const j = await resp.clone().json();
                if (!(j && j.success === true && j.data == null)) onPlayInfo(guid);
            } else {
                onPlayInfo(guid);
            }
        } catch {
            onPlayInfo(guid);
        }
        return resp;
    } as typeof window.fetch;

    // XHR 侧兜底（fnOS 个别接口走 XHR）
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
        this._fntvDmUrl = String(url);
        this._fntvDmMethod = String(method || 'GET').toUpperCase();
        return origOpen.apply(this, [method, url, ...rest] as any);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: any, body?: any) {
        const url = this._fntvDmUrl || '';
        const method = this._fntvDmMethod || 'GET';
        if (PLAY_INFO_RE.test(url) && method !== 'GET' && body) {
            onPlayInfo(extractGuid(typeof body === 'string' ? body : null));
        }
        return origSend.call(this, body);
    } as typeof XMLHttpRequest.prototype.send;
}

// ─── Canvas 渲染引擎（B站网页弹幕同款：逐帧重绘）───

function syncCanvasRect(): void {
    if (!canvas || !videoEl) return;
    const r = videoEl.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        renderDirty = true; // [lc-1015] 画布重置后内容被清空，需立即重绘（暂停时也要）
    }
    canvas.style.left = r.left + 'px';
    canvas.style.top = r.top + 'px';
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 之后一律用 CSS 像素绘制
}

function allocLane(busy: number[], t: number, dur: number): number {
    for (let i = 0; i < busy.length; i++) {
        if (t >= busy[i]) { busy[i] = t + dur; return i; }
    }
    return -1;
}

function ensureLanes(n: number): void {
    if (laneCount === n) return;
    laneCount = n;
    laneBusyScroll = new Array(n).fill(-Infinity);
    laneBusyTop = new Array(n).fill(-Infinity);
    laneBusyBottom = new Array(n).fill(-Infinity);
}

function resetRenderState(): void {
    active.clear();
    cursor = 0;
    recentTexts.clear();
    laneBusyScroll = new Array(laneCount).fill(-Infinity);
    laneBusyTop = new Array(laneCount).fill(-Infinity);
    laneBusyBottom = new Array(laneCount).fill(-Infinity);
    lastTime = -1;
    renderDirty = true;
    lastPausedDraw = false;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function startRender(): void {
    if (rafId || !enabled) return;
    const loop = () => {
        rafId = requestAnimationFrame(loop);
        render();
    };
    rafId = requestAnimationFrame(loop);
}

function stopRender(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    resetRenderState();
}

function render(): void {
    if (!ctx || !canvas || !enabled) return;

    // 视频元素失效则重新选取（规避选错/丢 video 导致的时灵时不灵）
    if (!videoEl || videoEl.getBoundingClientRect().width < 2) {
        videoEl = pickVideo();
    }
    if (!videoEl) return;
    syncCanvasRect();

    const cw = canvas.width / (window.devicePixelRatio || 1);
    const ch = canvas.height / (window.devicePixelRatio || 1);
    const t = videoEl.currentTime;
    const fixDuration = Math.max(3, style.scrollDuration * 0.6);

    // [lc-1015] 暂停跳帧：进度/尺寸/样式都没变时画面是静止的，跳过 clear+draw。
    if (t !== lastTime) renderDirty = true;
    const paused = videoEl.paused;
    if (paused && lastPausedDraw && !renderDirty) return;
    lastPausedDraw = paused;
    renderDirty = false;

    // 倒退（seek 回拖）→ 清空已生成集合，允许重播
    if (lastTime >= 0 && t < lastTime - 0.5) {
        active.clear();
        cursor = 0;
        recentTexts.clear();
        laneBusyScroll = new Array(laneCount).fill(-Infinity);
        laneBusyTop = new Array(laneCount).fill(-Infinity);
        laneBusyBottom = new Array(laneCount).fill(-Infinity);
    } else if (lastTime >= 0 && t > lastTime + 1.5) {
        // [lc-1015] 前向 seek：跳过区间内的弹幕（真实播放器行为，不倒灌、不堆积）
        while (cursor < items.length && items[cursor].time <= t) {
            recentTexts.set(items[cursor].text, items[cursor].time);
            cursor++;
        }
    }
    lastTime = t;

    // [lc-1015] 行高跟随实际字号（旧版固定 ch*0.034，调大字号后相邻行会互相压字）
    const fontSize = Math.max(14, Math.min(48, ch * style.fontScale));
    const laneH = Math.max(20, ch * LANE_RATIO, fontSize * 1.08);
    const usableH = ch * style.displayArea;
    const n = Math.max(6, Math.floor(usableH / laneH));
    ensureLanes(n);
    ctx.clearRect(0, 0, cw, ch);
    ctx.font = `${style.bold ? 'bold ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.textBaseline = 'top';
    if (style.shadow > 0) {
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = fontSize * 0.06 * style.shadow;
    } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }
    if (style.outline > 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, fontSize * 0.04 * style.outline);
        ctx.strokeStyle = 'rgba(0,0,0,0.95)';
    }

    // ① 激活到点的弹幕：游标只前进（items 按时间升序），轨道满则在宽限期内等待，
    //    超宽限或同文本短窗重复即丢弃，不再像旧版每帧从头全量扫描。
    while (cursor < items.length && items[cursor].time <= t) {
        const i = cursor;
        const d = items[i];
        const lastT = recentTexts.get(d.text);
        if (lastT !== undefined && Math.abs(d.time - lastT) <= DUP_TEXT_SEC) {
            cursor++;
            continue;
        }
        if (active.size >= MAX_ACTIVE) break;
        const isBottom = d.type === 4;
        const isFix = isBottom || d.type === 5;
        const dur = isFix ? fixDuration : style.scrollDuration;
        const lane = allocLane(isBottom ? laneBusyBottom : (isFix ? laneBusyTop : laneBusyScroll), t, dur);
        if (lane >= 0) {
            const w = ctx.measureText(d.text).width;
            active.set(i, { appear: t, lane, w, fix: isFix });
            recentTexts.set(d.text, d.time);
            cursor++;
        } else if (t - d.time > LANE_GRACE_SEC) {
            cursor++; // 宽限期内拿不到轨道 → 丢弃，避免迟到弹幕成堆涌入
        } else {
            break;    // 刚到点，等下一帧再试（FIFO，不越过）
        }
    }

    // ② 绘制活跃弹幕（滚动行从顶部数起；顶部固定行从顶数、底部固定行锚底）
    for (const [i, st] of active) {
        const d = items[i];
        const isFix = st.fix;
        const dur = isFix ? fixDuration : style.scrollDuration;
        const elapsed = t - st.appear;
        if (elapsed >= dur || elapsed < 0) {
            // 播完（按激活后的实际滚动时长算满程）→ 释放
            active.delete(i);
            continue;
        }
        const color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
        let x: number;
        let y: number;
        let alpha = style.opacity;
        if (isFix) {
            // [lc-1015] 修复：底部弹幕(type=4)旧版被画在顶部 —— 现在锚定画面底部；
            // 同时去掉旧版 y 多加一整个 fontSize 的偏移 bug。
            y = (d.type === 5)
                ? 6 + st.lane * laneH
                : ch - 6 - (st.lane + 1) * laneH;
            x = (cw - st.w) / 2;
            if (elapsed < 0.2) alpha = (elapsed / 0.2) * style.opacity;
            else if (elapsed > dur - 0.3) alpha = Math.max(0, (dur - elapsed) / 0.3) * style.opacity;
        } else {
            const p = elapsed / dur; // 0→1
            x = cw - p * (cw + st.w);
            y = 6 + st.lane * laneH;
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = color;
        if (style.outline > 0) ctx.strokeText(d.text, x, y);
        ctx.fillText(d.text, x, y);
    }
    ctx.globalAlpha = 1;
}

// ─── 弹幕详情弹窗（展示"弹幕是从哪来的"，与 MPV 一致）───

function sourceLabel(s: string): string {
    if (s === 'bangumi') return '番剧区（B站正版）';
    if (s === 'video') return '视频区（UP主搬运）';
    return s || '未知';
}

// Cookie 登录态 → 详情弹窗展示文案（非有效时 warn=true，弹窗会标红横幅）
function cookieStatusInfo(s: string): { text: string; warn: boolean; detail: string } {
    if (s === 'valid') return { text: '已登录（Cookie 有效）', warn: false, detail: '' };
    if (s === 'expired') return {
        text: 'Cookie 已过期 / 无效',
        warn: true,
        detail: 'B站 登录态已失效，弹幕数量受限（候选更少、seg.so 可能被风控掐掉）。请从浏览器重新复制 SESSDATA 填回 bili_cookie.txt 后重启。',
    };
    if (s === 'missing') return {
        text: '未登录（无 Cookie 文件）',
        warn: true,
        detail: '未配置 bili_cookie.txt，弹幕数量受限。请把浏览器 B站 登录态 Cookie（SESSDATA 等）整行填入该文件后重启。',
    };
    return { text: '—', warn: false, detail: '' };
}

// [lc-1015] 弹窗玻璃材质（与 lc-1012/1013 云母/观影记录同配方）：
// tint 半透底 + 165deg 光泽渐变 + 真实 backdrop blur（透出后方视频画面），无实心、无硬边框线。
const GLASS_PANEL_STYLE: { [k: string]: string } = {
    background: 'linear-gradient(165deg, rgba(255,255,255,.05), rgba(255,255,255,.012))',
    backgroundColor: 'rgba(15,15,20,.78)',
    backdropFilter: 'blur(42px) saturate(150%) brightness(.82)',
    '-webkit-backdrop-filter': 'blur(42px) saturate(150%) brightness(.82)',
    borderRadius: '18px',
    boxShadow: '0 18px 60px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.07), inset 0 1px 0 rgba(255,255,255,.10)',
    fontFamily: '-apple-system, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif',
};

function ensureModal(): HTMLDivElement {
    if (modal) return modal;
    const m = document.createElement('div');
    m.id = 'fntv-dm-modal';
    Object.assign(m.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
    } as CSSStyleDeclaration);

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
        position: 'absolute', inset: '0', background: 'rgba(0,0,0,0.42)',
        backdropFilter: 'blur(18px) saturate(120%)',
    } as CSSStyleDeclaration);
    backdrop.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(120%)');
    backdrop.addEventListener('click', () => closeDetails());

    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'relative',
        width: 'min(560px, 92vw)',
        maxHeight: '82vh',
        color: '#f5f5f7',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: '14px',
    } as CSSStyleDeclaration, GLASS_PANEL_STYLE);

    const head = document.createElement('div');
    Object.assign(head.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 18px 12px', fontWeight: '600', fontSize: '15px',
        borderBottom: '1px solid rgba(255,255,255,.06)',
    } as CSSStyleDeclaration);
    const titleEl = document.createElement('span');
    titleEl.textContent = '弹幕来源信息';
    const closeEl = document.createElement('span');
    closeEl.textContent = '✕';
    closeEl.style.cursor = 'pointer';
    closeEl.style.padding = '0 4px';
    closeEl.style.opacity = '0.7';
    closeEl.addEventListener('click', () => closeDetails());
    head.appendChild(titleEl);
    head.appendChild(closeEl);

    const body = document.createElement('div');
    body.id = 'fntv-dm-modal-body';
    Object.assign(body.style, {
        overflow: 'auto', padding: '14px 18px', flex: '1',
    } as CSSStyleDeclaration);

    panel.appendChild(head);
    panel.appendChild(body);
    m.appendChild(backdrop);
    m.appendChild(panel);
    document.body.appendChild(m);
    modal = m;
    return m;
}

function renderModalBody(): void {
    const m = ensureModal();
    const body = m.querySelector('#fntv-dm-modal-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = '';

    if (!meta) {
        body.textContent = '弹幕加载中…';
        return;
    }

    const cookie = cookieStatusInfo(meta.cookieStatus || '');
    const rows: [string, string][] = [
        ['搜索番名', meta.searchTitle || '—'],
        ['来源区域', sourceLabel(meta.source)],
        ['实际匹配', meta.matchedTitle || '—'],
        ['集数', meta.isMovie ? '电影（按番名搜最优集）' : `第 ${meta.ep} 集`],
        ['目标季数', meta.season > 0 ? `第 ${meta.season} 季（优先精确匹配）` : '未指定（仅按番名+集数）'],
        ['匹配相似度', meta.sim != null ? (meta.sim * 100).toFixed(0) + '%' : '—'],
        ['BVID', meta.bvid || '—'],
        ['CID', meta.cid != null ? String(meta.cid) : '—'],
        ['弹幕条数', String(meta.count)],
        ['聚合', meta.aggregatedFrom ? `${meta.aggregatedFrom} 个候选聚合` : '单源'],
        ['登录状态', cookie.text],
    ];
    if (meta.error) rows.push(['备注', meta.error]);

    // 非有效登录态：醒目红色横幅提示（一眼可见，对应 lc-336 的 Cookie 过期检查）
    if (cookie.warn) {
        const banner = document.createElement('div');
        banner.textContent = '⚠️ ' + cookie.detail;
        Object.assign(banner.style, {
            marginBottom: '14px', padding: '9px 11px', borderRadius: '8px',
            background: 'rgba(255,76,76,0.12)', border: '1px solid rgba(255,76,76,0.45)',
            color: '#ff8a8a', fontSize: '13px', lineHeight: '1.5',
        } as CSSStyleDeclaration);
        body.appendChild(banner);
    }

    const grid = document.createElement('div');
    Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: '96px 1fr',
        rowGap: '10px',
        columnGap: '12px',
        alignItems: 'start',
    } as CSSStyleDeclaration);
    for (const [k, v] of rows) {
        const kEl = document.createElement('div');
        kEl.textContent = k;
        kEl.style.color = 'rgba(245,245,247,.52)';
        kEl.style.flexShrink = '0';
        const vEl = document.createElement('div');
        vEl.textContent = v;
        vEl.style.wordBreak = 'break-all';
        if (k === '登录状态') {
            vEl.style.color = cookie.warn ? '#ff6b6b' : '#5ad17a';
            vEl.style.fontWeight = '600';
        } else {
            vEl.style.color = 'rgba(245,245,247,.92)';
        }
        grid.appendChild(kEl);
        grid.appendChild(vEl);
    }
    body.appendChild(grid);

    const tip = document.createElement('div');
    tip.textContent = '数据来源：B站（与 MPV 弹幕同源）';
    Object.assign(tip.style, {
        marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.06)',
        color: 'rgba(245,245,247,.4)', fontSize: '12px',
    } as CSSStyleDeclaration);
    body.appendChild(tip);
}

function openDetails(): void {
    const m = ensureModal();
    renderModalBody();
    m.style.display = 'flex';
}

function closeDetails(): void {
    if (modal) modal.style.display = 'none';
}

// ─── 弹幕样式调节面板（对齐 MPV 弹幕样式 7 项旋钮：粗体/字号/描边/阴影/滚动时长/透明度/显示范围）───

function makeSlider(label: string, min: number, max: number, step: number, value: number,
                    fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '6px' } as CSSStyleDeclaration);
    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } as CSSStyleDeclaration);
    const lab = document.createElement('span');
    lab.textContent = label;
    lab.style.color = 'rgba(245,245,247,.78)';
    const val = document.createElement('span');
    val.style.color = 'rgba(245,245,247,.5)';
    val.textContent = fmt(value);
    top.appendChild(lab);
    top.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    Object.assign(input.style, { width: '100%' } as CSSStyleDeclaration);
    input.style.setProperty('accent-color', '#2997ff');
    input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = fmt(v);
        onInput(v);
    });
    row.appendChild(top);
    row.appendChild(input);
    return row;
}

function makeToggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' } as CSSStyleDeclaration);
    const lab = document.createElement('span');
    lab.textContent = label;
    lab.style.color = 'rgba(245,245,247,.78)';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    Object.assign(input.style, { width: '18px', height: '18px' } as CSSStyleDeclaration);
    input.style.setProperty('accent-color', '#2997ff');
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(lab);
    row.appendChild(input);
    return row;
}

function buildStyleControls(): HTMLElement {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '14px' } as CSSStyleDeclaration);

    wrap.appendChild(makeToggle('粗体', style.bold, (v) => { style.bold = v; saveStyle(); }));

    // 字号：以默认 fontScale(0.036) 为 100% 的相对倍数（50%~180%）
    wrap.appendChild(makeSlider('字号', 50, 180, 1, Math.round(style.fontScale / 0.036 * 100),
        (v) => v + '%', (v) => { style.fontScale = 0.036 * (v / 100); saveStyle(); }));

    wrap.appendChild(makeSlider('描边', 0, 3, 0.1, style.outline,
        (v) => v.toFixed(1), (v) => { style.outline = v; saveStyle(); }));

    wrap.appendChild(makeSlider('阴影', 0, 3, 0.1, style.shadow,
        (v) => v.toFixed(1), (v) => { style.shadow = v; saveStyle(); }));

    // 滚动时长（秒）：值越大弹幕越慢，对应 MPV scrolltime
    wrap.appendChild(makeSlider('滚动时长', 4, 16, 0.5, style.scrollDuration,
        (v) => v.toFixed(1) + 's（越大越慢）', (v) => { style.scrollDuration = v; saveStyle(); }));

    wrap.appendChild(makeSlider('透明度', 0.3, 1, 0.05, style.opacity,
        (v) => Math.round(v * 100) + '%', (v) => { style.opacity = v; saveStyle(); }));

    wrap.appendChild(makeSlider('显示范围', 0.3, 1, 0.05, style.displayArea,
        (v) => Math.round(v * 100) + '%', (v) => { style.displayArea = v; saveStyle(); }));

    const reset = document.createElement('button');
    reset.textContent = '恢复默认';
    Object.assign(reset.style, {
        marginTop: '4px', padding: '9px 12px', background: 'rgba(41,151,255,.22)',
        color: '#6cb8ff', border: '1px solid rgba(41,151,255,.35)', borderRadius: '10px',
        cursor: 'pointer', fontSize: '13px',
    } as CSSStyleDeclaration);
    reset.addEventListener('mouseenter', () => { reset.style.background = 'rgba(41,151,255,.32)'; });
    reset.addEventListener('mouseleave', () => { reset.style.background = 'rgba(41,151,255,.22)'; });
    reset.addEventListener('click', () => {
        style = { ...DEFAULT_STYLE };
        saveStyle();
        const body = stylePanel?.querySelector('#fntv-dm-style-body') as HTMLElement | null;
        if (body) { body.innerHTML = ''; body.appendChild(buildStyleControls()); }
    });
    wrap.appendChild(reset);
    return wrap;
}

function ensureStylePanel(): HTMLDivElement {
    if (stylePanel) return stylePanel;
    const m = document.createElement('div');
    m.id = 'fntv-dm-style';
    Object.assign(m.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', display: 'none',
        alignItems: 'center', justifyContent: 'center',
    } as CSSStyleDeclaration);

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
        position: 'absolute', inset: '0', background: 'rgba(0,0,0,0.42)',
        backdropFilter: 'blur(18px) saturate(120%)',
    } as CSSStyleDeclaration);
    backdrop.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(120%)');
    backdrop.addEventListener('click', () => closeStylePanel());

    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'relative', width: 'min(420px, 92vw)', maxHeight: '82vh',
        color: '#f5f5f7', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', fontSize: '14px',
    } as CSSStyleDeclaration, GLASS_PANEL_STYLE);

    const head = document.createElement('div');
    Object.assign(head.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 18px 12px', fontWeight: '600', fontSize: '15px',
        borderBottom: '1px solid rgba(255,255,255,.06)',
    } as CSSStyleDeclaration);
    const titleEl = document.createElement('span');
    titleEl.textContent = '弹幕样式';
    const closeEl = document.createElement('span');
    closeEl.textContent = '✕';
    closeEl.style.cursor = 'pointer';
    closeEl.style.padding = '0 4px';
    closeEl.style.opacity = '0.7';
    closeEl.addEventListener('click', () => closeStylePanel());
    head.appendChild(titleEl);
    head.appendChild(closeEl);

    const body = document.createElement('div');
    body.id = 'fntv-dm-style-body';
    Object.assign(body.style, { overflow: 'auto', padding: '14px 18px', flex: '1' } as CSSStyleDeclaration);
    body.appendChild(buildStyleControls());

    panel.appendChild(head);
    panel.appendChild(body);
    m.appendChild(backdrop);
    m.appendChild(panel);
    document.body.appendChild(m);
    stylePanel = m;
    return m;
}

function openStylePanel(): void {
    const m = ensureStylePanel();
    m.style.display = 'flex';
}

function closeStylePanel(): void {
    if (stylePanel) stylePanel.style.display = 'none';
}

// ─── 初始化 ───

// [lc-1015] 模块加载即安装 play/info 只读观察器（必须在 fnOS 页面脚本开始发请求前就位；
// 本插件按字母序先于 skipInject 加载，包装链上它能看到原生播放流程的 play/info）。
installPlayInfoObserver();

function maybeSetup(): void {
    // [lc-550] 全屏去圆角: 即便当前非播放页也调用一次, 清理可能残留的 fntv-video-fullscreen 标记
    applyVideoFullscreenClass();
    if (!isPlayerPage()) return;

    // [lc-544] 播放页顶部标题栏美化（毛玻璃 + 自动隐藏）
    injectPlayerHeaderStyle();
    bindHeaderAutoHide();
    // [lc-550] 播放器全屏去圆角检测
    bindVideoFullscreenFix();

    try {
        const saved = localStorage.getItem(LS_KEY);
        enabled = saved !== '0';
    } catch { /* ignore */ }

    const guid = getGuid();
    if (!guid) return;

    if (guid === mountedForGuid && controlsPlaced) {
        if (canvas) canvas.style.display = enabled ? 'block' : 'none';
        syncToggleUI();
        return;
    }

    ensureMounted();
    mountedForGuid = guid;
    syncToggleUI();
    prepareAndLoad();
}

registerHook(HookType.OnReady, () => {
    setTimeout(maybeSetup, 1500);
});

registerHook(HookType.OnDomChange, () => {
    if ((maybeSetup as any)._t) clearTimeout((maybeSetup as any)._t);
    (maybeSetup as any)._t = setTimeout(maybeSetup, 800);
});

export {};
