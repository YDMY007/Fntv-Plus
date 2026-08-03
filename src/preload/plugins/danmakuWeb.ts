// preload/plugins/danmakuWeb.ts
//
// [原生网页播放器弹幕] 飞牛「原声播放器」(fnOS 网页自身 <video>) 的 B站弹幕支持。
//
// 设计要点（用户明确要求）：
//   1) 控制栏里有两个按钮：
//        - 「弹幕」：弹幕开关（默认开，localStorage 记忆，颜色区分开/关）。
//        - 「详情」：弹出窗口，展示弹幕【来源信息】（从哪个区/哪个 B站标题匹配、相似度、
//                    bvid/cid、条数）—— 与 MPV 的弹幕来源提示一致，而非罗列全部弹幕。
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

/** 播放页 URL 正则（电影 / 剧集 / 视频） */
const GUID_RE = /\/v\/(?:movie|tv|video)(?:\/(?:season|episode))?\/([a-f0-9]{32})/i;

const LS_KEY = 'fntv_danmaku_enabled';

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
    error?: string;
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
let controlsPlaced = false;
let mountedForGuid: string | null = null;
let loading = false;
let inflight = false;       // 同一 guid 只允许一个在途请求（单飞，避免并发重复拉取触发 B站限流）
let enabled = true;
let items: DanmakuItem[] = [];
let meta: DanmakuMeta | null = null;
let currentGuid: string | null = null;
let rafId = 0;
let lastTime = -1;

// canvas 渲染引擎状态
const active = new Map<number, ActiveState>();
const finished = new Set<number>();
let laneBusyScroll: number[] = [];   // 各轨道"滚动弹幕"占用到（video 时间）
let laneBusyFix: number[] = [];       // 各轨道"固定弹幕"占用到
let laneCount = 0;

// 渲染参数（参照 B站网页弹幕引擎）
const SCROLL_DURATION = 8;   // 滚动弹幕横跨屏幕秒数
const FIX_DURATION = 5;      // 顶/底弹幕停留秒数
const LANE_RATIO = 0.034;    // 轨道高 / 画布高
const FONT_RATIO = 0.036;    // 字号 / 画布高
const MAX_ACTIVE = 80;       // 同屏活跃弹幕硬顶（防极端高峰）

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
        if (!controlsPlaced) {
            log.info('[danmakuWeb] 弹幕开关已注入控制栏(' + String(bar.className).slice(0, 40) + ')');
            controlsPlaced = true;
        }
    } else {
        // 控制栏尚未就绪：把按钮挂到 body 末尾也能点（极少见，飞牛几乎必有 xg-right-grid）
        if (!toggleWrap) createControls();
        if (toggleWrap && !toggleWrap.parentElement) document.body.appendChild(toggleWrap);
        if (detailsWrap && !detailsWrap.parentElement) document.body.appendChild(detailsWrap);
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

async function prepareAndLoad(): Promise<void> {
    const guid = getGuid();
    if (!guid) return;

    if (guid !== currentGuid) {
        currentGuid = guid;
        items = [];
        meta = null;
        resetRenderState();
        closeDetails();
        inflight = false;
    } else if (items.length && enabled) {
        startRender();
        return;
    }
    if (loadedGuids.has(guid) && items.length === 0 && meta) {
        return;
    }
    // 单飞：同一 guid 只允许一个在途请求。OnReady/OnDomChange 在控制栏就绪前可能各触发一次，
    // 没有此保护会导致同一集并发跑多个 run() → B站限流(分片重试 2s) → 整体被拖到 1 分钟。
    if (inflight) {
        log.info('[danmakuWeb] 已有弹幕请求在途，跳过重复拉取');
        return;
    }
    inflight = true;

    loading = true;
    syncToggleUI();
    try {
        const res = await ipcRenderer.invoke('danmaku:prepare', { guid }) as any;
        if (res && res.ok && Array.isArray(res.items) && res.items.length) {
            items = res.items as DanmakuItem[];
            meta = res.meta as DanmakuMeta || {
                searchTitle: res.title || '', matchedTitle: res.title || '',
                source: res.source || '', ep: res.ep || 0, season: res.season || 0, isMovie: !!res.isMovie,
                count: res.count || items.length,
            };
            loadedGuids.add(guid);
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
    laneBusyFix = new Array(n).fill(-Infinity);
}

function resetRenderState(): void {
    active.clear();
    finished.clear();
    laneBusyScroll = new Array(laneCount).fill(-Infinity);
    laneBusyFix = new Array(laneCount).fill(-Infinity);
    lastTime = -1;
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

    // 倒退（seek 回拖）→ 清空已生成集合，允许重播
    if (lastTime >= 0 && t < lastTime - 0.5) {
        active.clear();
        finished.clear();
        laneBusyScroll = new Array(laneCount).fill(-Infinity);
        laneBusyFix = new Array(laneCount).fill(-Infinity);
    }
    lastTime = t;

    const laneH = Math.max(20, ch * LANE_RATIO);
    const n = Math.max(6, Math.floor(ch / laneH));
    ensureLanes(n);
    const fontSize = Math.max(16, Math.min(40, ch * FONT_RATIO));
    ctx.clearRect(0, 0, cw, ch);
    ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = Math.max(1, fontSize * 0.12);

    // ① 激活到点的弹幕（只进不出，直到播完才移到 finished）
    if (active.size < MAX_ACTIVE) {
        for (let i = 0; i < items.length; i++) {
            if (active.has(i) || finished.has(i)) continue;
            if (items[i].time <= t) {
                const isFix = items[i].type === 4 || items[i].type === 5;
                const dur = isFix ? FIX_DURATION : SCROLL_DURATION;
                const lane = allocLane(isFix ? laneBusyFix : laneBusyScroll, t, dur);
                if (lane < 0) continue; // 轨道占满，本帧跳过，下帧再试
                const w = ctx.measureText(items[i].text).width;
                active.set(i, { appear: t, lane, w, fix: isFix });
                if (active.size >= MAX_ACTIVE) break;
            }
        }
    }

    // ② 绘制活跃弹幕
    const fixedY = (lane: number) => 6 + lane * laneH;
    for (const [i, st] of active) {
        const d = items[i];
        const isFix = st.fix;
        const dur = isFix ? FIX_DURATION : SCROLL_DURATION;
        const elapsed = t - st.appear;
        if (t > d.time + dur || elapsed < 0) {
            // 播完 → finished 并释放轨道
            active.delete(i);
            finished.add(i);
            continue;
        }
        const color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
        let x: number;
        let y = fixedY(st.lane) + fontSize;
        let alpha = 1;
        if (isFix) {
            x = (cw - st.w) / 2;
            if (elapsed < 0.2) alpha = elapsed / 0.2;
            else if (elapsed > dur - 0.3) alpha = Math.max(0, (dur - elapsed) / 0.3);
        } else {
            const p = elapsed / dur; // 0→1
            x = cw - p * (cw + st.w);
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = color;
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
        position: 'absolute', inset: '0', background: 'rgba(0,0,0,0.55)',
    } as CSSStyleDeclaration);
    backdrop.addEventListener('click', () => closeDetails());

    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'relative',
        width: 'min(560px, 92vw)',
        maxHeight: '82vh',
        background: '#1e1e20',
        color: '#eaeaea',
        borderRadius: '12px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
        fontSize: '14px',
    } as CSSStyleDeclaration);

    const head = document.createElement('div');
    Object.assign(head.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px', borderBottom: '1px solid #333', fontWeight: '600', fontSize: '15px',
    } as CSSStyleDeclaration);
    const titleEl = document.createElement('span');
    titleEl.textContent = '弹幕来源信息';
    const closeEl = document.createElement('span');
    closeEl.textContent = '✕';
    closeEl.style.cursor = 'pointer';
    closeEl.style.padding = '0 4px';
    closeEl.addEventListener('click', () => closeDetails());
    head.appendChild(titleEl);
    head.appendChild(closeEl);

    const body = document.createElement('div');
    body.id = 'fntv-dm-modal-body';
    Object.assign(body.style, {
        overflow: 'auto', padding: '14px 16px', flex: '1',
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
    ];
    if (meta.error) rows.push(['备注', meta.error]);

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
        kEl.style.color = '#9aa0a6';
        kEl.style.flexShrink = '0';
        const vEl = document.createElement('div');
        vEl.textContent = v;
        vEl.style.wordBreak = 'break-all';
        vEl.style.color = '#eaeaea';
        grid.appendChild(kEl);
        grid.appendChild(vEl);
    }
    body.appendChild(grid);

    const tip = document.createElement('div');
    tip.textContent = '数据来源：B站（与 MPV 弹幕同源）';
    Object.assign(tip.style, {
        marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #2a2a2a',
        color: '#6b7075', fontSize: '12px',
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

// ─── 初始化 ───

function maybeSetup(): void {
    if (!isPlayerPage()) return;
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
