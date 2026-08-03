// preload/plugins/danmakuWeb.ts
//
// [原生网页播放器弹幕] 飞牛「原声播放器」(fnOS 网页自身 <video>) 的 B站弹幕支持。
//
// 设计要点（用户明确要求）：
//   1) 控制栏里有两个按钮：
//        - 「弹幕」：弹幕开关（默认开，localStorage 记忆，颜色区分开/关）。
//        - 「详情」：弹出窗口，列出已匹配弹幕的详细信息（标题/集数/来源/条数 + 时间轴列表）。
//   2) 弹幕 overlay 直接渲染在播放器容器内（覆盖 video，pointer-events:none，绝不影响控制栏点击）。
//   3) 默认开；开关状态用 localStorage 记忆。
//   4) 电影(ep=0)：主进程 search_cid 自动退化为「仅按番名搜、取弹幕最多的集」，与 MPV 一致。
//
// 数据通道：ipcRenderer.invoke('danmaku:prepare', {guid}) → 主进程解析标题/集数并抓 B站弹幕，
// 返回结构化弹幕条目（避免 https 页 fetch http 本地服务的 mixed-content/CORS 问题）。

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
    title: string;
    ep: number;
    isMovie: boolean;
    source?: string;
    count: number;
    error?: string;
}

// ─── 运行态 ───
let video: HTMLVideoElement | null = null;
let overlay: HTMLDivElement | null = null;
let toggleWrap: HTMLDivElement | null = null;   // 弹幕开关（仿原生 plugin-placeholder）
let toggleSpan: HTMLSpanElement | null = null;   // 开关文字
let detailsWrap: HTMLDivElement | null = null;   // 详情按钮（仿原生 plugin-placeholder）
let modal: HTMLDivElement | null = null;         // 弹幕详情弹窗
let controlsPlaced = false;                       // 是否已成功注入控制栏
let mountedForGuid: string | null = null;         // 已初始化过的 guid（幂等，避免每 2.4s 重跑）
let loading = false;
let enabled = true;
let items: DanmakuItem[] = [];
let meta: DanmakuMeta | null = null;
let currentGuid: string | null = null;
let rafId = 0;
let lastTime = -1;
const spawned = new Set<number>();

/** 同屏最大弹幕数上限（防 rAF 风暴卡死渲染进程） */
const MAX_VISIBLE = 50;
let visibleCount = 0;

// ─── 页面检测 ───

function isPlayerPage(): boolean {
    return !!(document.querySelector('video') && GUID_RE.test(window.location.href));
}

function getGuid(): string | null {
    const m = window.location.href.match(GUID_RE);
    return m?.[1] || null;
}

// ─── DOM 定位 ───

/** 找到 video 的挂载容器（只读查找，不修改任何样式，避免触发 embyWall 白底清除→全透明） */
function findMountRoot(): HTMLElement | null {
    const v = document.querySelector('video');
    if (!v) return null;
    // 直接用 video 的父级作为挂载根；不向上遍历、不修改 position
    return v.parentElement as HTMLElement | null;
}

/**
 * 找原生控制栏（从 document 精确锚定，不使用会误中提示气泡的模糊选择器）。
 * 飞牛播放器实测 DOM：<xg-controls class="xgplayer-controls"> 内含 <xg-right-grid>，
 * 原画/选集/倍速等文字按钮都是 <div class="plugin-placeholder"> 子节点。
 * 我们把弹幕按钮注入 <xg-right-grid>（最右端，紧跟倍速之后）。
 */
function findControlsBar(): HTMLElement | null {
    // ① 精确命中飞牛 xgplayer 控制栏右区（用户实测 DOM，首选）
    const right = document.querySelector('xg-right-grid') as HTMLElement | null;
    if (right && right.offsetHeight > 0) {
        return right;
    }
    // ② 退一步：整个控制栏 <xg-controls class="xgplayer-controls">
    const controls = (document.querySelector('xg-controls.xgplayer-controls') ||
        document.querySelector('.xgplayer-controls')) as HTMLElement | null;
    if (controls && controls.offsetHeight > 0) {
        // 若 controls 内部有 right-grid，优先返回它
        const innerRight = controls.querySelector('xg-right-grid') as HTMLElement | null;
        if (innerRight && innerRight.offsetHeight > 0) return innerRight;
        return controls;
    }
    // ③ 通用兜底：找含"倍速/选集/原画"等中文文字、高度像控制栏的容器
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

// ─── 挂载 overlay + 控制栏按钮 ───

function ensureMounted(): void {
    if (!isPlayerPage()) return;
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (!v) return;
    video = v;

    const root = findMountRoot();
    if (!root) return;

    // overlay（透明、覆盖 video、不拦截点击；z-index 低于控制栏）
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'fntv-danmaku-overlay';
        Object.assign(overlay.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: '10',
        } as CSSStyleDeclaration);
        root.appendChild(overlay);
    }
    overlay.style.display = enabled ? 'block' : 'none';

    // 控制栏按钮：弹幕开关 + 详情
    const bar = findControlsBar();
    if (bar) {
        if (!toggleWrap) createControls();
        if (toggleWrap && toggleWrap.parentElement !== bar) bar.appendChild(toggleWrap);
        if (detailsWrap && detailsWrap.parentElement !== bar) bar.appendChild(detailsWrap);
        // 控制栏就绪 → 移除可能存在的兜底停靠条，避免重复
        const dock = root.querySelector('#fntv-danmaku-dock');
        if (dock) dock.remove();
        if (!controlsPlaced) {
            log.info('[danmakuWeb] 弹幕开关已注入控制栏(' + String(bar.className).slice(0, 40) + ')');
            controlsPlaced = true;
        }
    } else {
        // 兜底：创建一个固定在播放器底部的停靠条（仅当控制栏尚未就绪）
        let dock = root.querySelector('#fntv-danmaku-dock') as HTMLElement | null;
        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'fntv-danmaku-dock';
            Object.assign(dock.style, {
                position: 'absolute',
                left: '0',
                right: '0',
                bottom: '0',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                padding: '0 14px',
                zIndex: '9999',
                pointerEvents: 'auto',
                background: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
            } as CSSStyleDeclaration);
            root.appendChild(dock);
        }
        if (!toggleWrap) createControls();
        if (toggleWrap && toggleWrap.parentElement !== dock) dock.appendChild(toggleWrap);
        if (detailsWrap && detailsWrap.parentElement !== dock) dock.appendChild(detailsWrap);
    }
}

/** 生成仿原生控制栏按钮：plugin-placeholder > h-full > flex > span */
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
    // 弹幕开关
    const t = makeControlButton('弹幕', () => toggleDanmaku());
    toggleWrap = t.wrap;
    toggleSpan = t.span;
    // 详情按钮
    const d = makeControlButton('详情', () => openDetails());
    detailsWrap = d.wrap;
    syncToggleUI();
}

/** 弹幕开关状态可视化：开启时给文字加品牌色高亮，关闭时降透明度 */
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
    if (overlay) overlay.style.display = enabled ? 'block' : 'none';
    syncToggleUI();
    if (enabled) startRender();
    else stopRender();
}

// ─── 数据拉取 ───

async function prepareAndLoad(): Promise<void> {
    const guid = getGuid();
    if (!guid) return;

    // 切集：guid 变化 → 重置
    if (guid !== currentGuid) {
        currentGuid = guid;
        items = [];
        meta = null;
        spawned.clear();
        stopRender();
        if (overlay) overlay.innerHTML = '';
        visibleCount = 0;
        closeDetails();
    } else if (items.length && enabled) {
        startRender();
        return;
    }
    if (loadedGuids.has(guid) && items.length === 0) {
        return;
    }

    loading = true;
    syncToggleUI();
    try {
        const res = await ipcRenderer.invoke('danmaku:prepare', { guid }) as any;
        if (res && res.ok && Array.isArray(res.items) && res.items.length) {
            items = res.items as DanmakuItem[];
            meta = { title: res.title, ep: res.ep, isMovie: res.isMovie, source: res.source, count: res.count };
            loadedGuids.add(guid);
            log.info(`[danmakuWeb] 获取弹幕 ${res.count} 条 title="${res.title}" ep=${res.ep} movie=${res.isMovie}`);
            if (enabled) startRender();
        } else {
            meta = { title: res?.title || '', ep: res?.ep ?? 0, isMovie: !!res?.isMovie, count: 0, error: res?.error || '空' };
            log.info('[danmakuWeb] 无弹幕: ' + (res?.error || '空'));
            loadedGuids.add(guid);
        }
    } catch (e) {
        log.error('[danmakuWeb] 获取弹幕失败:', e);
    } finally {
        loading = false;
        syncToggleUI();
    }
}

// ─── 渲染（rAF + video.currentTime 同步）───
// ⚠️ 防卡死设计：
//   - 单一全局 rAF 循环（tick），不在每条弹幕内创建独立 rAF
//   - 滚动弹幕用 CSS @keyframes + animation 驱动移动（GPU 加速，不占 JS 主线程）
//   - 同屏硬顶 MAX_VISIBLE(50) 条，超出的直接丢弃不渲染

/** 注入一次性 CSS 动画 keyframes（滚动弹幕从右到左） */
function injectCSSAnimation(): void {
    if (document.getElementById('fntv-dm-css')) return;
    const style = document.createElement('style');
    style.id = 'fntv-dm-css';
    style.textContent = `
        @keyframes fntv-dm-scroll {
            from { transform: translateX(100vw); }
            to   { transform: translateX(-100%); }
        }
        .fntv-dm-item {
            position: absolute;
            white-space: nowrap;
            font-size: 24px;
            font-weight: bold;
            text-shadow: 0 1px 2px rgba(0,0,0,0.85);
            pointer-events: none;
            will-change: transform;
            opacity: 0;
            animation-fill-mode: forwards;
        }
        /* ⚠️ 关键修复：滚动弹幕必须显式 opacity:1，否则继承 .fntv-dm-item 的 opacity:0 而完全不可见 */
        .fntv-dm-scroll { animation: fntv-dm-scroll 9s linear forwards; opacity: 1; }
        .fntv-dm-top, .fntv-dm-btm {
            animation: fntv-dm-fadein 0.15s ease-out forwards,
                       fntv-dm-fadeout 4.35s ease-in 4.5s forwards;
        }
        @keyframes fntv-dm-fadein { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fntv-dm-fadeout { to { opacity: 0; } }
    `;
    document.head.appendChild(style);
}

function startRender(): void {
    if (rafId || !enabled) return;
    injectCSSAnimation();
    lastTime = -1;
    const loop = () => {
        rafId = requestAnimationFrame(loop);
        tick();
    };
    rafId = requestAnimationFrame(loop);
}

function stopRender(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (overlay) {
        // 清除所有弹幕 DOM
        overlay.querySelectorAll('.fntv-dm-item').forEach(el => el.remove());
    }
    visibleCount = 0;
}

function tick(): void {
    if (!video || !overlay || !enabled) return;
    const t = video.currentTime;
    // 倒退（seek 回拖）→ 清空已生成集合，允许重播
    if (lastTime >= 0 && t < lastTime - 0.5) {
        spawned.clear();
        overlay.querySelectorAll('.fntv-dm-item').forEach(el => el.remove());
        visibleCount = 0;
    }
    lastTime = t;

    for (let i = 0; i < items.length; i++) {
        if (spawned.has(i)) continue;
        if (items[i].time <= t + 0.15) {
            spawned.add(i);
            // ⚠️ 硬顶：超限就不渲染了，防止 rAF/DOM 风暴卡死
            if (visibleCount >= MAX_VISIBLE) continue;
            spawnDanmaku(items[i]);
        }
    }
}

/** 当前可用轨道数 */
function laneCount(): number {
    if (!overlay) return 10;
    const h = overlay.clientHeight || 540;
    return Math.max(6, Math.floor(h / 32));
}

/** 简单轮询分配轨道 */
let laneCursor = 0;
function pickLane(): number {
    const n = laneCount();
    const lane = laneCursor % n;
    laneCursor++;
    return lane;
}

function spawnDanmaku(d: DanmakuItem): void {
    if (!overlay || visibleCount >= MAX_VISIBLE) return;
    const el = document.createElement('div');
    el.className = 'fntv-dm-item';
    el.textContent = d.text;
    const color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
    el.style.color = color;

    const isTop = d.type === 5;
    const isBottom = d.type === 4;
    const lane = pickLane();

    if (isTop || isBottom) {
        // 固定弹幕：居中显示，CSS 动画控制淡入淡出
        el.classList.add(isTop ? 'fntv-dm-top' : 'fntv-dm-btm');
        el.style.top = (8 + lane * 32) + 'px';
        el.style.left = '50%';
        el.style.transform = 'translateX(-50%)';
        overlay.appendChild(el);
        visibleCount++;
        // 4.5s 后自动移除（CSS animation 会 fadeOut，animationend 后清 DOM）
        el.addEventListener('animationend', () => {
            el.remove();
            visibleCount--;
        }, { once: true });
        // 安全兜底：即使 animationend 没触发也清理
        setTimeout(() => {
            if (el.parentNode) { el.remove(); visibleCount--; }
        }, 5000);
    } else {
        // 滚动弹幕：纯 CSS @keyframes 驱动，零 JS 开销
        el.classList.add('fntv-dm-scroll');
        el.style.top = (8 + lane * 32) + 'px';
        el.style.right = '-200px'; /* 从右侧外开始 */
        overlay.appendChild(el);
        visibleCount++;
        // 9s 后（动画结束）自动移除
        el.addEventListener('animationend', () => {
            el.remove();
            visibleCount--;
        }, { once: true });
        setTimeout(() => {
            if (el.parentNode) { el.remove(); visibleCount--; }
        }, 9500);
    }
}

// ─── 弹幕详情弹窗 ───

function fmtTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 懒创建弹窗 DOM（挂到 body，不被 overlay 的 overflow:hidden 裁剪） */
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
        position: 'absolute',
        inset: '0',
        background: 'rgba(0,0,0,0.55)',
    } as CSSStyleDeclaration);
    backdrop.addEventListener('click', () => closeDetails());

    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'relative',
        width: 'min(680px, 92vw)',
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
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid #333',
        fontWeight: '600',
        fontSize: '15px',
    } as CSSStyleDeclaration);
    const titleEl = document.createElement('span');
    titleEl.textContent = '弹幕详情';
    const closeEl = document.createElement('span');
    closeEl.textContent = '✕';
    closeEl.style.cursor = 'pointer';
    closeEl.style.padding = '0 4px';
    closeEl.addEventListener('click', () => closeDetails());
    head.appendChild(titleEl);
    head.appendChild(closeEl);

    const info = document.createElement('div');
    info.id = 'fntv-dm-modal-info';
    Object.assign(info.style, {
        padding: '8px 16px',
        color: '#9aa0a6',
        fontSize: '13px',
        borderBottom: '1px solid #2a2a2a',
    } as CSSStyleDeclaration);

    const list = document.createElement('div');
    list.id = 'fntv-dm-modal-list';
    Object.assign(list.style, {
        overflow: 'auto',
        padding: '6px 16px 16px',
        flex: '1',
    } as CSSStyleDeclaration);

    panel.appendChild(head);
    panel.appendChild(info);
    panel.appendChild(list);
    m.appendChild(backdrop);
    m.appendChild(panel);
    document.body.appendChild(m);
    modal = m;
    return m;
}

function renderModalBody(): void {
    const m = ensureModal();
    const info = m.querySelector('#fntv-dm-modal-info') as HTMLElement | null;
    const list = m.querySelector('#fntv-dm-modal-list') as HTMLElement | null;
    if (!info || !list) return;

    if (!meta) {
        info.textContent = '弹幕加载中…';
        list.innerHTML = '';
        return;
    }
    if (!items.length) {
        info.textContent = `「${meta.title || '未知'}」${meta.isMovie ? '(电影)' : '第 ' + meta.ep + ' 集'} — 无弹幕（${meta.error || '未匹配到'}）`;
        list.innerHTML = '';
        return;
    }
    info.textContent = `「${meta.title}」${meta.isMovie ? '(电影)' : '第 ' + meta.ep + ' 集'} · 来源 ${meta.source || 'bilibili'} · 共 ${meta.count} 条`;

    list.innerHTML = '';
    // 最多渲染 500 条，避免 DOM 过多卡顿
    const show = items.slice(0, 500);
    const frag = document.createDocumentFragment();
    for (const d of show) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            gap: '8px',
            padding: '3px 0',
            borderBottom: '1px solid #2a2a2a',
            alignItems: 'baseline',
        } as CSSStyleDeclaration);
        const time = document.createElement('span');
        time.textContent = fmtTime(d.time);
        Object.assign(time.style, {
            color: '#8b9096',
            flex: '0 0 48px',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'monospace',
        } as CSSStyleDeclaration);
        const txt = document.createElement('span');
        txt.textContent = d.text;
        txt.style.color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
        txt.style.wordBreak = 'break-all';
        row.appendChild(time);
        row.appendChild(txt);
        frag.appendChild(row);
    }
    list.appendChild(frag);
    if (items.length > show.length) {
        const more = document.createElement('div');
        more.textContent = `…仅显示前 ${show.length} 条（共 ${items.length} 条）`;
        more.style.color = '#6b7075';
        more.style.padding = '8px 0';
        list.appendChild(more);
    }
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
    // 读取记忆的开关状态（默认开）
    try {
        const saved = localStorage.getItem(LS_KEY);
        enabled = saved !== '0';
    } catch { /* ignore */ }

    const guid = getGuid();
    if (!guid) return;

    // 幂等：同一 guid 且控制栏已注入 → 只同步状态，不再重复初始化/打日志
    if (guid === mountedForGuid && controlsPlaced) {
        if (overlay) overlay.style.display = enabled ? 'block' : 'none';
        syncToggleUI();
        return;
    }

    // 首次 / 切集 / 控制栏尚未就绪 → 完整初始化（ensureMounted 内部对按钮/overlay 做了存在性判断）
    ensureMounted();
    mountedForGuid = guid;
    syncToggleUI();
    prepareAndLoad();
}

// OnReady: 页面加载完成后检查
registerHook(HookType.OnReady, () => {
    setTimeout(maybeSetup, 1500);
});

// OnDomChange: SPA 路由切换 / 异步渲染控制栏
registerHook(HookType.OnDomChange, () => {
    // 防抖：控制栏可能延迟渲染，多试几次
    if ((maybeSetup as any)._t) clearTimeout((maybeSetup as any)._t);
    (maybeSetup as any)._t = setTimeout(maybeSetup, 800);
});

export {};
