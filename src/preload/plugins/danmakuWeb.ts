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
let toggleBtn: HTMLButtonElement | null = null;
let loading = false;
let enabled = true;
let items: DanmakuItem[] = [];
let currentGuid: string | null = null;
let rafId = 0;
let lastTime = -1;
const spawned = new Set<number>();
const laneFreeAt: number[] = []; // 每条滚动轨道的「释放时间」(performance.now ms)
const activeAnims = new Set<() => void>(); // 进行中的动画回调，便于停止

// ─── 页面检测 ───

function isPlayerPage(): boolean {
    return !!(document.querySelector('video') && GUID_RE.test(window.location.href));
}

function getGuid(): string | null {
    const m = window.location.href.match(GUID_RE);
    return m?.[1] || null;
}

// ─── DOM 定位 ───

/** 找到 video 的挂载容器（设为 relative 以便 overlay 绝对定位覆盖） */
function findMountRoot(): HTMLElement | null {
    const v = document.querySelector('video');
    if (!v) return null;
    let el = v.parentElement;
    // 向上找一个"看起来像播放器容器"的祖先（定位过的 / 类名含 player）
    while (el && el !== document.body) {
        const pos = getComputedStyle(el).position;
        const cls = (el.className || '').toString();
        if (pos !== 'static' || /player|videoPlayer/i.test(cls)) {
            return el;
        }
        el = el.parentElement;
    }
    // 没找到则直接用 video 的直接父级，并确保其相对定位
    const parent = v.parentElement as HTMLElement | null;
    if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }
    return parent;
}

/** 在容器内找原生控制栏（优先级选择器；命中不到返回 null，由调用方停靠兜底） */
function findControlsBar(root: HTMLElement): HTMLElement | null {
    const selectors = [
        '[class*="control-bar"]', '[class*="controlBar"]', '[class*="controls"]',
        '[class*="player-bar"]', '[class*="bottom-bar"]', '[class*="bottomBar"]',
        '[class*="tool-bar"]', '[class*="toolbar"]', '[role="toolbar"]',
        '[class*="action-bar"]', '[class*="controller"]', '[class*="control"]',
    ];
    for (const s of selectors) {
        const el = root.querySelector(s) as HTMLElement | null;
        if (el) {
            log.info('[danmakuWeb] 控制栏命中选择器: ' + s);
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

    // 开关按钮：优先注入原生控制栏；找不到则停靠播放器底部
    const bar = findControlsBar(root);
    if (bar) {
        if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
        const z = parseInt(bar.style.zIndex || '0', 10);
        if (z < 20) bar.style.zIndex = '20'; // 确保控制栏在弹幕之上
        if (!toggleBtn) {
            toggleBtn = createToggle();
            bar.appendChild(toggleBtn);
        }
    } else {
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
                zIndex: '20',
                pointerEvents: 'auto',
                background: 'linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0))',
            } as CSSStyleDeclaration);
            root.appendChild(dock);
        }
        if (!toggleBtn) {
            toggleBtn = createToggle();
            dock.appendChild(toggleBtn);
        }
    }
}

function createToggle(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = 'fntv-danmaku-toggle';
    btn.type = 'button';
    btn.textContent = '弹幕';
    Object.assign(btn.style, {
        marginLeft: '10px',
        padding: '2px 12px',
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,0.35)',
        background: enabled ? 'rgba(80,160,255,0.9)' : 'rgba(255,255,255,0.18)',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.7',
        cursor: 'pointer',
        pointerEvents: 'auto',
        userSelect: 'none',
        outline: 'none',
    } as CSSStyleDeclaration);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleDanmaku();
    });
    return btn;
}

function syncToggleUI(): void {
    if (!toggleBtn) return;
    toggleBtn.style.background = enabled
        ? 'rgba(80,160,255,0.9)'
        : 'rgba(255,255,255,0.18)';
    if (loading) toggleBtn.textContent = '弹幕…';
    else toggleBtn.textContent = '弹幕';
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
    } else if (items.length && enabled) {
        startRender();
        return;
    }
    if (loadedGuids.has(guid) && items.length === 0) {
        // 已查过但无弹幕，避免重复
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
            loadedGuids.add(guid); // 无弹幕也记一下，避免每次重查
        }
    } catch (e) {
        log.error('[danmakuWeb] 获取弹幕失败:', e);
    } finally {
        loading = false;
        syncToggleUI();
    }
}

// ─── 渲染（rAF + video.currentTime 同步）───

function startRender(): void {
    if (rafId || !enabled) return;
    lastTime = -1;
    const loop = () => {
        rafId = requestAnimationFrame(loop);
        tick();
    };
    rafId = requestAnimationFrame(loop);
}

function stopRender(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    activeAnims.forEach((fn) => fn());
    activeAnims.clear();
}

function tick(): void {
    if (!video || !overlay || !enabled) return;
    const t = video.currentTime;
    // 倒退（seek 回拖）→ 清空已生成集合，允许重播
    if (lastTime >= 0 && t < lastTime - 0.5) {
        spawned.clear();
    }
    lastTime = t;

    for (let i = 0; i < items.length; i++) {
        if (spawned.has(i)) continue;
        if (items[i].time <= t + 0.15) {
            spawned.add(i);
            spawnDanmaku(items[i]);
        }
    }
}

function laneCount(): number {
    if (!overlay) return 10;
    const h = overlay.clientHeight || 540;
    return Math.max(6, Math.floor(h / 32));
}

function pickLane(now: number): number {
    const n = laneCount();
    if (laneFreeAt.length !== n) {
        laneFreeAt.length = 0;
        for (let i = 0; i < n; i++) laneFreeAt.push(0);
    }
    let best = 0;
    let bestFree = Infinity;
    for (let i = 0; i < n; i++) {
        if (laneFreeAt[i] <= now) return i;
        if (laneFreeAt[i] < bestFree) { bestFree = laneFreeAt[i]; best = i; }
    }
    return best;
}

function spawnDanmaku(d: DanmakuItem): void {
    if (!overlay) return;
    const el = document.createElement('div');
    el.textContent = d.text;
    const color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
    const isTop = d.type === 5;
    const isBottom = d.type === 4;

    Object.assign(el.style, {
        position: 'absolute',
        whiteSpace: 'nowrap',
        color,
        fontSize: '24px',
        fontWeight: 'bold',
        textShadow: '0 1px 2px rgba(0,0,0,0.85)',
        pointerEvents: 'none',
        willChange: 'transform',
    } as CSSStyleDeclaration);

    const stopRef = { stopped: false };

    if (isTop || isBottom) {
        // 固定弹幕：居中显示 ~4.5s
        const n = laneCount();
        const lane = pickLane(performance.now());
        const topPx = isTop ? (8 + lane * 32) : 'auto';
        const bottomPx = isBottom ? (8 + lane * 32) : 'auto';
        el.style.top = typeof topPx === 'number' ? topPx + 'px' : 'auto';
        el.style.bottom = typeof bottomPx === 'number' ? bottomPx + 'px' : 'auto';
        el.style.left = '50%';
        el.style.transform = 'translateX(-50%)';
        overlay.appendChild(el);
        const stop = () => { stopRef.stopped = true; clearTimeout(timer); el.remove(); };
        const timer = setTimeout(() => {
            stopRef.stopped = true;
            el.remove();
            activeAnims.delete(stop);
        }, 4500);
        activeAnims.add(stop);
    } else {
        // 滚动弹幕：从右到左
        const w = overlay.clientWidth || 960;
        const lane = pickLane(performance.now());
        el.style.top = (8 + lane * 32) + 'px';
        el.style.left = '0';
        overlay.appendChild(el);
        const tw = el.offsetWidth || 200;
        const dur = 9000; // ms：整条滚动弹幕从右到左完全离屏耗时
        laneFreeAt[lane] = performance.now() + dur; // 该轨道约 dur 后释放，供下一条复用
        const start = performance.now();
        const anim = () => {
            if (stopRef.stopped) return;
            const p = (performance.now() - start) / dur;
            if (p >= 1) {
                el.remove();
                activeAnims.delete(stop);
                return;
            }
            const x = w - p * (w + tw);
            el.style.transform = `translateX(${x}px)`;
            requestAnimationFrame(anim);
        };
        const stop = () => { stopRef.stopped = true; el.remove(); };
        activeAnims.add(stop);
        requestAnimationFrame(anim);
    }
}

// ─── 初始化 ───

function maybeSetup(): void {
    if (!isPlayerPage()) return;
    // 读取记忆的开关状态（默认开）
    try {
        const saved = localStorage.getItem(LS_KEY);
        if (saved === '0') enabled = false;
        else enabled = true;
    } catch { /* ignore */ }

    ensureMounted();
    syncToggleUI();
    prepareAndLoad();
}

// OnReady: 页面加载完成后检查
registerHook(HookType.OnReady, () => {
    setTimeout(maybeSetup, 1200);
});

// OnDomChange: SPA 路由切换 / 异步渲染控制栏
registerHook(HookType.OnDomChange, () => {
    // 防抖
    if ((maybeSetup as any)._t) clearTimeout((maybeSetup as any)._t);
    (maybeSetup as any)._t = setTimeout(maybeSetup, 600);
});

export {};
