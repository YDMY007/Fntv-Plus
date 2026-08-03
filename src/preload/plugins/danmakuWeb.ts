// preload/plugins/danmakuWeb.ts
//
// [原生网页播放器弹幕] 飞牛「原声播放器」(fnOS 网页自身 <video>) 的 B站弹幕支持。
//
// 设计要点（用户明确要求）：
//   1) 弹幕开关按钮直接做进「飞牛原声播放器的底部控制栏」里——不悬浮在屏幕上（悬浮丑）。
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

// ─── 运行态 ───
let video: HTMLVideoElement | null = null;
let overlay: HTMLDivElement | null = null;
let toggleWrap: HTMLDivElement | null = null;   // 仿原生 plugin-placeholder 容器
let toggleSpan: HTMLSpanElement | null = null;   // 实际文字按钮
let controlsPlaced = false;                       // 是否已成功注入控制栏
let mountedForGuid: string | null = null;         // 已初始化过的 guid（幂等，避免每 2.4s 重跑）
let loading = false;
let enabled = true;
let items: DanmakuItem[] = [];
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

// ─── 挂载 overlay + 开关按钮 ───

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

    // 开关按钮：注入原生控制栏右区（xg-right-grid）；找不到则停靠播放器底部
    const bar = findControlsBar();
    if (bar) {
        if (!toggleWrap) createToggle();
        if (toggleWrap && toggleWrap.parentElement !== bar) {
            bar.appendChild(toggleWrap);
        }
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
        if (!toggleWrap) createToggle();
        if (toggleWrap && toggleWrap.parentElement !== dock) {
            dock.appendChild(toggleWrap);
        }
    }
}

function createToggle(): void {
    if (toggleWrap) return;
    // 仿照飞牛原生控制栏按钮结构：plugin-placeholder > h-full > flex > span
    const wrap = document.createElement('div');
    wrap.className = 'plugin-placeholder';
    wrap.id = 'fntv-danmaku-toggle-wrap';
    const hfull = document.createElement('div');
    hfull.className = 'h-full';
    const flex = document.createElement('div');
    flex.className = 'flex h-full items-center justify-center';
    flex.setAttribute('tabindex', '0');
    const span = document.createElement('span');
    span.id = 'fntv-danmaku-toggle';
    // 与原生 原画/选集/倍速 一致的文字样式
    span.className = 'cursor-pointer text-lg leading-lg text-[var(--semi-color-text-1)] hover:text-[var(--semi-color-text-0)]';
    span.textContent = '弹幕';
    span.style.userSelect = 'none';
    flex.appendChild(span);
    hfull.appendChild(flex);
    wrap.appendChild(hfull);
    flex.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleDanmaku();
    });
    toggleWrap = wrap;
    toggleSpan = span;
    syncToggleUI();
}

/** 弹幕开关状态可视化：开启时给文字加品牌色高亮，关闭时降透明度 */
function syncToggleUI(): void {
    if (!toggleSpan) return;
    if (loading) {
        toggleSpan.textContent = '弹幕…';
    } else {
        toggleSpan.textContent = '弹幕';
    }
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
        spawned.clear();
        stopRender();
        if (overlay) overlay.innerHTML = '';
        visibleCount = 0;
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
            loadedGuids.add(guid);
            log.info(`[danmakuWeb] 获取弹幕 ${res.count} 条 title="${res.title}" ep=${res.ep} movie=${res.isMovie}`);
            if (enabled) startRender();
        } else {
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
        .fntv-dm-scroll { animation: fntv-dm-scroll 9s linear forwards; }
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
