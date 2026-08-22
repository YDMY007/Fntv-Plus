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
    // [lc-670] 用户自加/强制显示的入口：
    //  - a.fnos-play = embyWall 注入的 hero「开始观看」主按钮(SPA 导航到详情)
    //  - [lc-674] 汉堡键容器不再整体选(之前 🏠 与 ≡ 合并成一个候选框)，
    //    改为容器内可点击元素各自独立聚焦：
    //      · 🏠 首页链接 = 通用 a[href] 选择器已命中(容器内 isVisible 放行小尺寸)
    //      · ≡ 菜单 = svg.cursor-pointer(纯SVG非a/button, 需显式选择器)
    //    select() 点击时: 🏠 冒泡到容器, embyWall hook 判定 closest('a') 放行→回首页导航;
    //    ≡ svg 冒泡到容器, embyWall capture hook 拦截→开合抽屉。
    'a.fnos-play',
    '[class*="lg:!hidden"]:not([class*="inset-0"]) svg.cursor-pointer',
];

let frameEl: HTMLDivElement | null = null;
let focusedEl: HTMLElement | null = null;
let active = false;
let hintEl: HTMLDivElement | null = null;
let lastMoveTime = 0;

function ensureFrame(): HTMLDivElement {
    if (frameEl && frameEl.isConnected) return frameEl;
    // [lc-668] 注入呼吸光晕关键帧
    if (!document.getElementById('fntv-focus-style')) {
        const style = document.createElement('style');
        style.id = 'fntv-focus-style';
        style.textContent = '@keyframes fntv-focus-pulse{0%,100%{box-shadow:0 0 0 1.5px rgba(0,0,0,.55),0 0 12px rgba(255,255,255,.55),inset 0 0 8px rgba(255,255,255,.16)}50%{box-shadow:0 0 0 1.5px rgba(0,0,0,.55),0 0 26px rgba(255,255,255,.95),inset 0 0 14px rgba(255,255,255,.32)}}';
        (document.head || document.documentElement).appendChild(style);
    }
    frameEl = document.createElement('div');
    frameEl.id = 'fntv-focus-frame';
    frameEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'pointer-events:none',
        'z-index:2147483000',
        'border:3px solid #fff',
        'border-radius:12px',
        // [lc-668] 更优雅：220ms easeOutCubic 缓动 + 呼吸光晕
        'transition:left .22s cubic-bezier(.22,.61,.36,1), top .22s cubic-bezier(.22,.61,.36,1), width .22s cubic-bezier(.22,.61,.36,1), height .22s cubic-bezier(.22,.61,.36,1)',
        'animation:fntv-focus-pulse 1.8s ease-in-out infinite',
        'will-change:left,top,width,height',
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

/**
 * [lc-670] 是否属于"辅助/装饰"元素——不应作为游戏手柄主焦点候选：
 *  - 顶栏 z-20 容器内的按钮（搜索/用户/设置等辅助工具栏）
 *  - hero 右侧 90x90 cursor-pointer 小缩略图(分集预览切换装饰)
 *  - play-mask__btn--play 播放蒙层按钮
 * 这些元素存在但属于 UI 装饰/工具栏，把它们混进网格导航会让白框落在无意义位置。
 */
function isAuxElement(el: HTMLElement): boolean {
    // [lc-673] embyWall 注入的「刷新页面」按钮(首页导航栏, location.reload)：
    //   用户明确要求它作为焦点候选，且为【首页默认落点】(按 B 返回根目录后白框落刷新按钮)。
    //   撤销 lc-672 的排除；且必须放在顶栏排除之前放行(它插在汉堡键旁、也在 z-20 顶栏内,
    //   否则会被下方 inTopBar 分支误杀)。
    if (el.closest('#fnos-refresh-btn')) return false;
    // [lc-674] 撤销 lc-670 的「顶栏 z-20 整栏排除」：搜索/用户/设置等顶栏按钮
    //   恢复为焦点候选(用户要求手柄能选到它们)。激活默认落点已有「刷新按钮/
    //   开始观看」优先，不会被顶栏按钮抢走；方向键可正常导航到顶栏。
    //   仍排除的纯装饰：播放蒙层按钮、hero 右侧 90x90 分集缩略图。
    if (el.closest('.play-mask__btn--play')) return true;
    const r = el.getBoundingClientRect();
    if (r.width === 90 && r.height === 90 && el.classList.contains('cursor-pointer')) return true;
    return false;
}

function hasOpenModal(): boolean {
    return !!document.querySelector('.semi-modal-content, .semi-modal, [role="dialog"]');
}

function isVisible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    // [lc-671] 汉堡键容器整体(22px 图标条)放行小尺寸；其余元素保持最小 24px
    //   （避免把过小装饰混入候选，但汉堡键是用户明确要聚焦的入口）
    const isBurger = !!el.closest('[class*="lg:!hidden"]') && !el.closest('[class*="inset-0"]');
    const minSize = isBurger ? 10 : 24;
    if (r.width < minSize || r.height < minSize) return false;
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
            // [lc-670] 排除辅助/装饰元素(顶栏图标按钮、hero 右侧 90x90 小缩略图)
            if (isAuxElement(el)) return;
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
        // [lc-673] 首页(根路径 /v)激活时默认落点 = embyWall 注入的「刷新页面」按钮。
        //   用户要求: 连续按 B 返回根目录后，白框默认落在首页刷新按钮上(方便一键刷新首页内容)。
        //   仅首页生效；其他页面仍走「开始观看」/视口中心逻辑。
        const isRoot = location.pathname === '/' || /^\/v\/?$/i.test(location.pathname);
        if (isRoot) {
            const refreshBtn = cands.find((el) => el.id === 'fnos-refresh-btn' || !!el.closest('#fnos-refresh-btn'));
            if (refreshBtn) { focusEl(refreshBtn); showHint(); return; }
        }
        // [lc-670] 优先 hero「开始观看」主按钮（embyWall 注入的 a.fnos-play），
        //   它是用户最想用 A 键直达的入口；无则回退视口中心最近。
        const startWatch = cands.find((el) => el.classList.contains('fnos-play'));
        if (startWatch) { focusEl(startWatch); showHint(); return; }
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
            : { left: window.innerWidth / 2 - 5, top: window.innerHeight / 2 - 5, width: 10, height: 10, bottom: window.innerHeight / 2 + 5, right: window.innerWidth / 2 + 5 };
        const curTop = cr.top;
        const curBottom = cr.bottom;
        const curLeft = cr.left;
        const curRight = cr.right;
        const curCx = cr.left + cr.width / 2;
        const curCy = cr.top + cr.height / 2;

        let best: HTMLElement | null = null;
        let bestScore = Infinity;

        // [lc-668] 同排/同列绝对优先：水平移动优先「y 投影重叠」的同排候选（按边缘间距最近），
        //   无同排才跨行（重罚 dy）；垂直移动对称。修复旧算法 score=dx+|dy|*0.6 下，
        //   更宽的下一行卡片中心偏右 23px 就击败同行相邻卡片 → 隔一个/跳行的问题。
        for (const el of cands) {
            if (cur && el === cur) continue;
            const r = el.getBoundingClientRect();
            if (dir === 'left' || dir === 'right') {
                const inDir = dir === 'right' ? r.left > curRight + 2 : r.right < curLeft - 2;
                if (!inDir) continue;
                const sameRow = r.top < curBottom && curTop < r.bottom;
                const gap = dir === 'right' ? r.left - curRight : curLeft - r.right;
                const dyCenter = Math.abs((r.top + r.bottom) / 2 - curCy);
                // 同排恒优先（gap 按间距比较）；跨行重罚 dyCenter×20 使其只在无同排时胜出
                const score = sameRow ? gap : (dyCenter * 20 + gap);
                if (score < bestScore) { bestScore = score; best = el; }
            } else {
                const inDir = dir === 'down' ? r.top > curBottom + 2 : r.bottom < curTop - 2;
                if (!inDir) continue;
                const sameCol = r.left < curRight && curLeft < r.right;
                const gap = dir === 'down' ? r.top - curBottom : curTop - r.bottom;
                const dxCenter = Math.abs((r.left + r.right) / 2 - curCx);
                const score = sameCol ? gap : (dxCenter * 20 + gap);
                if (score < bestScore) { bestScore = score; best = el; }
            }
        }
        if (best) focusEl(best);
        lastMoveTime = Date.now();
    },

    select(): boolean {
        if (!active || !focusedEl) return false;
        const el = focusedEl;
        // [lc-674] 汉堡键已拆为独立候选, 走通用逻辑即可正确区分：
        //   · 🏠 首页链接(焦点即 a[href], 自身无子链接) → target=自身, 点击冒泡到容器,
        //     embyWall hook 判定 e.target.closest('a') 放行 → 回首页导航
        //   · ≡ 菜单(焦点即 svg, 无子链接) → target=svg, 点击冒泡到容器,
        //     embyWall capture hook 拦截(stopImmediatePropagation) → 开合抽屉
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
