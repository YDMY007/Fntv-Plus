// preload/plugins/gamepadFocus.ts
// [lc-667] 手柄焦点导航（白框代替鼠标）。
// 主界面（首页/列表/详情）摇杆或十字键移动时显示白色焦点框，A 确认 = 模拟鼠标点击。
//
// 设计要点：
//  - 候选元素：a[href]/button/[role=button] + fnOS 各卡片类（library-card-root、
//    continue-card-root、card-root、poster、swiper-slide），可见且非自建 UI(data-fnos-ui)。
//  - 去重：内层候选被外层候选完全覆盖时保留外层（如 continue-card-root 内含 <a>），
//    select 时若焦点元素内含 a[href] 则点内层 a（真正的导航目标）。
//  - 白框：fixed 定位 div（3px 白边 + 光晕），pointer-events:none，平滑过渡到焦点元素。
//  - 导航：按方向取「主轴优先、次轴次之」的最近候选；目标在视口外自动 scrollIntoView。
//  - 鼠标活动(mousemove/mousedown)自动隐藏白框，交还鼠标；弹窗打开时不激活。
//  - 原生网页播放器(video)播放中不激活，避免抢播放控制。

import logger from '../core/logger';
const log = logger;

const CANDIDATE_SELECTORS = [
    'a[href]',
    'button',
    '[role=button]',
    '.library-card-root',
    '.continue-card-root',
    '.card-root',
    '[class*="poster"]',
    '[class*="swiper-slide"]',
    '[class*="card-root"]',
];

let frameEl: HTMLDivElement | null = null;
let focusedEl: HTMLElement | null = null;
let active = false;
let hintEl: HTMLDivElement | null = null;
let lastMoveTime = 0;

function ensureFrame(): HTMLDivElement {
    if (frameEl && frameEl.isConnected) return frameEl;
    frameEl = document.createElement('div');
    frameEl.id = 'fntv-focus-frame';
    frameEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'pointer-events:none',
        'z-index:2147483000',
        'border:3px solid #fff',
        'border-radius:12px',
        'box-shadow:0 0 0 1.5px rgba(0,0,0,.55), 0 0 18px rgba(255,255,255,.85), inset 0 0 8px rgba(255,255,255,.25)',
        'transition:left .12s ease-out, top .12s ease-out, width .12s ease-out, height .12s ease-out',
        'display:none',
    ].join(';');
    document.body.appendChild(frameEl);
    return frameEl;
}

function showHint(): void {
    if (hintEl && hintEl.isConnected) { hintEl.remove(); hintEl = null; }
    hintEl = document.createElement('div');
    hintEl.textContent = '手柄导航：摇杆/方向键移动 · A 确认 · B 返回';
    hintEl.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:36px', 'transform:translateX(-50%)',
        'z-index:2147483001', 'background:rgba(0,0,0,.78)', 'color:#fff',
        'padding:8px 18px', 'border-radius:10px', 'font-size:14px',
        'letter-spacing:.5px', 'border:1px solid rgba(255,255,255,.35)',
        'pointer-events:none', 'transition:opacity .6s ease',
    ].join(';');
    document.body.appendChild(hintEl);
    setTimeout(() => { if (hintEl) hintEl.style.opacity = '0'; }, 2600);
    setTimeout(() => { if (hintEl) { hintEl.remove(); hintEl = null; } }, 3300);
}

function isInOurUI(el: HTMLElement): boolean {
    return !!el.closest('[data-fnos-ui]');
}

function hasOpenModal(): boolean {
    return !!document.querySelector('.semi-modal-content, .semi-modal, [role="dialog"]');
}

function isVisible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (st.opacity === '0') return false;
    return true;
}

function collectCandidates(): HTMLElement[] {
    const map = new Map<HTMLElement, boolean>();
    for (const sel of CANDIDATE_SELECTORS) {
        let nodes: NodeListOf<Element> | null = null;
        try { nodes = document.querySelectorAll(sel); } catch { continue; }
        nodes.forEach((n) => {
            const el = n as HTMLElement;
            if (!el || isInOurUI(el) || !isVisible(el)) return;
            map.set(el, true);
        });
    }
    // 去重：候选 C 被另一候选 A 完全包含（A.contains(C) 且 rect 覆盖）→ 去掉内层 C，
    // 保留外层作为焦点框目标（select 时若内含 a[href] 则点内层 a）。
    const list = Array.from(map.keys());
    const dropped = new Set<HTMLElement>();
    for (const c of list) {
        if (dropped.has(c)) continue;
        for (const a of list) {
            if (a === c) continue;
            if (a.contains(c) && !c.contains(a)) {
                const ra = a.getBoundingClientRect();
                const rc = c.getBoundingClientRect();
                const cover = ra.left - 2 <= rc.left && ra.top - 2 <= rc.top &&
                    ra.right + 2 >= rc.right && ra.bottom + 2 >= rc.bottom;
                if (cover) { dropped.add(c); break; }
            }
        }
    }
    return list.filter((el) => !dropped.has(el));
}

function isPlayingInPage(): boolean {
    const v = document.querySelector('video');
    return !!(v && !v.paused && v.currentTime > 0);
}

function focusEl(el: HTMLElement): void {
    focusedEl = el;
    active = true;
    const f = ensureFrame();
    const r = el.getBoundingClientRect();
    f.style.left = r.left + 'px';
    f.style.top = r.top + 'px';
    f.style.width = r.width + 'px';
    f.style.height = r.height + 'px';
    f.style.display = 'block';
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
}

function hide(): void {
    active = false;
    focusedEl = null;
    if (frameEl) frameEl.style.display = 'none';
}

export const focusNav = {
    isActive(): boolean { return active; },
    getFocused(): HTMLElement | null { return focusedEl; },

    activate(): void {
        if (active) return;
        if (isPlayingInPage()) return;
        if (hasOpenModal()) return;
        const cands = collectCandidates();
        if (!cands.length) return;
        // 初始焦点：视口中心最近者
        const vcx = window.innerWidth / 2;
        const vcy = window.innerHeight / 2;
        let best: HTMLElement | null = null;
        let bestD = Infinity;
        for (const el of cands) {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const d = Math.abs(cx - vcx) + Math.abs(cy - vcy);
            if (d < bestD) { bestD = d; best = el; }
        }
        if (best) { focusEl(best); showHint(); }
    },

    move(dir: 'up' | 'down' | 'left' | 'right'): void {
        if (!active) { this.activate(); if (!active) return; }
        const cands = collectCandidates();
        if (!cands.length) return;
        const cur = focusedEl;
        const cr = cur
            ? cur.getBoundingClientRect()
            : { left: window.innerWidth / 2 - 5, top: window.innerHeight / 2 - 5, width: 10, height: 10 };
        const curCx = cr.left + cr.width / 2;
        const curCy = cr.top + cr.height / 2;
        let best: HTMLElement | null = null;
        let bestScore = Infinity;
        for (const el of cands) {
            if (cur && el === cur) continue;
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const dx = cx - curCx;
            const dy = cy - curCy;
            let inDir = false, primary = 0, secondary = 0;
            switch (dir) {
                case 'right': inDir = dx > 4; primary = dx; secondary = Math.abs(dy); break;
                case 'left': inDir = dx < -4; primary = -dx; secondary = Math.abs(dy); break;
                case 'down': inDir = dy > 4; primary = dy; secondary = Math.abs(dx); break;
                case 'up': inDir = dy < -4; primary = -dy; secondary = Math.abs(dx); break;
            }
            if (!inDir) continue;
            const score = primary + secondary * 0.6;
            if (score < bestScore) { bestScore = score; best = el; }
        }
        if (best) focusEl(best);
        lastMoveTime = Date.now();
    },

    select(): boolean {
        if (!active || !focusedEl) return false;
        const el = focusedEl;
        // 卡片内含链接则点链接（continue-card-root 的 a 才是导航目标）
        const link = el.querySelector('a[href]') as HTMLAnchorElement | null;
        const target = link || el;
        try {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            log.info('[gamepadFocus] 确认点击:', (target.getAttribute('href') || target.className || target.tagName).slice(0, 60));
        } catch (e: any) {
            log.warn('[gamepadFocus] 模拟点击失败:', e?.message || e);
        }
        lastMoveTime = Date.now();
        return true;
    },

    back(): boolean {
        if (!active) return false;
        hide();
        return true;
    },

    dismiss(): void {
        if (active) hide();
    },
};

// 供调试/手动测试（浏览器控制台可调 window.fntvFocusNav.move('right')）
try {
    (window as any).fntvFocusNav = focusNav;
} catch { /* ignore */ }

// 鼠标活动交还鼠标
try {
    window.addEventListener('mousemove', () => { if (active) hide(); }, { passive: true });
    window.addEventListener('mousedown', () => { if (active) hide(); }, { passive: true });
    // 滚动/尺寸变化时重贴白框（防抖）
    let scrollTimer = 0;
    window.addEventListener('scroll', () => {
        if (!active || !focusedEl) return;
        clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
            if (active && focusedEl && focusedEl.isConnected) {
                const r = focusedEl.getBoundingClientRect();
                const f = ensureFrame();
                f.style.left = r.left + 'px';
                f.style.top = r.top + 'px';
                f.style.width = r.width + 'px';
                f.style.height = r.height + 'px';
            }
        }, 80);
    }, { passive: true });
    window.addEventListener('resize', () => { if (active && focusedEl && focusedEl.isConnected) focusEl(focusedEl); });
} catch { /* ignore */ }
