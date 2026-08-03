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
 * 在容器内找原生控制栏。
 * 策略：广匹配选择器 + 兜底停靠条。
 * fnOS 播放器控制栏通常含 倍速/选集/原画/CC/设置/音量/全屏 等文字或图标按钮。
 */
function findControlsBar(root: HTMLElement): HTMLElement | null {
    // 更精确的选择器列表（覆盖常见视频播放器框架）
    const selectors = [
        // 通用
        '[class*="control-bar"]', '[class*="controlBar"]', '[class*="controls"]',
        '[class*="player-bar"]', '[class*="bottom-bar"]', '[class*="bottomBar"]',
        '[class*="tool-bar"]', '[class*="toolbar"]', '[role="toolbar"]',
        '[class*="action-bar"]', '[class*="controller"]',
        // xgplayer (西瓜/西瓜系)
        '[class*="xgplayer-controls"]', '[class*="xg-bottom"]',
        '[data-name="controls"]',
        // video.js
        '[class*="vjs-control-bar"]',
        // 通用含文字的选择器（fnOS 控制栏有"倍速""选集"等中文）
        '.xgplayer-controls', '.video-controls',
    ];
    for (const s of selectors) {
        const el = root.querySelector(s) as HTMLElement | null;
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
            log.info('[danmakuWeb] 控制栏命中选择器: ' + s + ' (' + el.className + ')');
            return el;
        }
    }
    // 二级查找：在整个 document 内找包含"倍速"/"选集"/"全屏"等中文的控制区域
    const allDivs = root.querySelectorAll('div, nav, [role]');
    for (let i = 0; i < allDivs.length; i++) {
        const el = allDivs[i] as HTMLElement;
        const text = el.textContent || '';
        if ((text.includes('倍速') || text.includes('选集') || text.includes('原画') ||
             text.includes('音量') || text.includes('全屏')) &&
            el.offsetHeight > 20 && el.offsetHeight < 120 &&
            el.children.length >= 2) {
            log.info('[danmakuWeb] 控制栏命中文本特征: tag=' + el.tagName + ' class=' + String(el.className).slice(0, 60));
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
        if (!toggleBtn) {
            toggleBtn = createToggle();
            bar.appendChild(toggleBtn);
        }
        // 确保 toggleBtn 在 bar 内可见
        if (toggleBtn.parentElement !== bar) {
            bar.appendChild(toggleBtn);
        }
    } else {
        // 兜底：创建一个固定在播放器底部的停靠条
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
                zIndex: '9999',  /* 高于原生控制栏，确保可见 */
                pointerEvents: 'auto',
                background: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
            } as CSSStyleDeclaration);
            root.appendChild(dock);
        }
        if (!toggleBtn) {
            toggleBtn = createToggle();
            dock.appendChild(toggleBtn);
        }
        if (toggleBtn.parentElement !== dock) {
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
        if (saved === '0') enabled = false;
        else enabled = true;
    } catch { /* ignore */ }

    ensureMounted();
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
