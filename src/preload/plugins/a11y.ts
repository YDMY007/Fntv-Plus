// preload/plugins/a11y.ts
// [lc-1064] 无障碍增强：键盘焦点环 / 弹层焦点陷阱 / aria 补齐 / reduced-motion 兜底。
// ─────────────────────────────────────────────────────────────────────────────
// ① 焦点环：全页 :focus-visible 注入 2px accent 描边（沿用轮播按钮 lc-707 已验证配方，
//    键盘 Tab 才出现、鼠标点击不出现，不破坏「无边框」审美）。原生 fnOS 控件与自建 UI 一并覆盖。
// ② 弹层焦点陷阱：登记自建模态弹层 ID，可见时 role=dialog + aria-modal + 焦点移入 +
//    Tab/Shift+Tab 圈在弹层内 + 关闭后焦点还原（读屏器与纯键盘用户不会「Tab 进了弹层背后的页面」）。
//    巡检 400ms 轮询 + OnDomChange 双驱动，弹层各自用 display:none/remove 开关，逻辑零侵入。
// ③ aria 补齐：titlebar 窗控三键（纯 svg 图标按钮，读屏器原本只能读出 "button"）、
//    观影记录面板关闭钮。设置面板关闭钮的 aria 在 embyWall 本体补（创建处一行）。
// ④ reduced-motion 兜底：prefers-reduced-motion: reduce 时停掉纯装饰动画
//    （设置面板流光 sheen / 手柄焦点框呼吸），功能动画（pageAnim）本就自带尊重逻辑。
// 仅 /v 路径生效（isFntvTvPage，与 pageAnim 同一红线：绝不介入系统页/登录页）。

import { registerHook, HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import { t } from '../core/i18n';
import logger from '../core/logger';

const log = logger;

/** 自建模态弹层登记表：id → 说明（仅 role/aria 与焦点陷阱对象；Esc 关闭各弹层已自理） */
const MODAL_IDS: Array<[string, string]> = [
    ['fnos-settings-panel', '设置面板'],
    ['play-choice-modal', '播放方式弹窗'],
    ['fnos-dialog-overlay', '自定义对话框'],
    ['fntv-wrapped', '年度报告'],
];

const STYLE_ID = 'fntv-a11y-style';
const A11Y_CSS = [
    // ① 键盘焦点环：:focus-visible 仅键盘导航触发；:is 保持低优先级 + !important 压过
    //    各处 inline outline:none（如 dialogUI 旧按钮），鼠标用户视觉零变化。
    ':is(a,button,input,select,textarea,[tabindex],[role=button]):focus-visible{'
    + 'outline:2px solid var(--fnos-ui-accent,#6d7ff2)!important;outline-offset:2px!important;}',
    // ④ 装饰动画停帧（手柄白框保留本体、仅停呼吸脉冲）
    '@media (prefers-reduced-motion: reduce){'
    + '#fnos-settings-panel::before{animation:none!important}'
    + '#fntv-focus-frame{animation:none!important}}',
].join('\n');

// 弹层陷阱状态：id → 打开前焦点
const trapPrevFocus = new Map<HTMLElement, HTMLElement | null>();

function injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = A11Y_CSS;
    (document.head || document.documentElement).appendChild(st);
}

/** 弹层当前是否可见（fixed 元素 offsetParent 恒 null，只看 display）。 */
function overlayVisible(el: HTMLElement): boolean {
    if (!el.isConnected) return false;
    try { return getComputedStyle(el).display !== 'none'; } catch { return false; }
}

/** 弹层内可聚焦元素（可见、未禁用、非 tabindex=-1）。 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,'
        + '[tabindex]:not([tabindex="-1"]),[role=button]';
    return Array.from(root.querySelectorAll<HTMLElement>(sel))
        .filter((el) => {
            if (el.getAttribute('tabindex') === '-1') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
}

function focusInto(el: HTMLElement): void {
    const first = focusablesIn(el)[0];
    if (first) {
        first.focus();
    } else {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus();
    }
}

/** 巡检：新可见弹层 → 挂陷阱；已隐藏弹层 → 摘陷阱并还原焦点。 */
function checkOverlays(): void {
    for (const [id] of MODAL_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        const tracked = trapPrevFocus.has(el);
        if (overlayVisible(el) && !tracked) {
            // 焦点已在弹层内（如 dialogUI 打开时自带聚焦默认按钮）→ 不抢焦点，
            // prev 记 null（弹层自身即将移除，无需还原）
            const inside = document.activeElement instanceof HTMLElement && el.contains(document.activeElement);
            trapPrevFocus.set(el, inside ? null
                : (document.activeElement instanceof HTMLElement ? document.activeElement : null));
            if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
            el.setAttribute('aria-modal', 'true');
            if (!inside) focusInto(el);
            log.info(`[a11y] 弹层陷阱挂载: ${id}`);
        } else if (!overlayVisible(el) && tracked) {
            const prev = trapPrevFocus.get(el) || null;
            trapPrevFocus.delete(el);
            if (prev && prev.isConnected) prev.focus();
        }
    }
}

/** Tab 循环：焦点在弹层内时圈住（capture 拦截原生走出弹层的 Tab）。 */
function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    // 最后挂载且仍可见的弹层为当前模态（后开的对话框盖在前面）
    let top: HTMLElement | null = null;
    for (const [el] of trapPrevFocus) {
        if (overlayVisible(el)) top = el;
    }
    if (!top) return;
    const items = focusablesIn(top);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) {
        // 焦点意外漂出弹层（如点掉了子元素）→ 拉回第一个
        e.preventDefault();
        items[0].focus();
        return;
    }
    const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1)
                            : (idx >= items.length - 1 ? 0 : idx + 1);
    if (next !== idx) {
        e.preventDefault();
        items[next].focus();
    }
}

/** aria 补齐：titlebar 窗控（纯图标）+ 观影记录关闭钮。幂等，可随 DOM 变化重复跑。 */
function fixAria(): void {
    const put = (id: string, label: string): void => {
        const el = document.getElementById(id);
        if (el && el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
    };
    put('min-btn', t('最小化'));
    put('max-btn', t('最大化'));
    put('close-btn', t('关闭'));
    // 观影记录面板 ✕（watchHistory 注入的 div，非 button → 补 role）
    const wh = document.getElementById('wh-close');
    if (wh) {
        wh.setAttribute('role', 'button');
        wh.setAttribute('aria-label', t('关闭'));
    }
}

registerHook(HookType.OnReady, () => {
    if (!isFntvTvPage()) return;
    injectStyle();
    document.addEventListener('keydown', onKeydown, true);
    checkOverlays();
    fixAria();
    // 400ms 轻巡检：display:none↔flex 这类纯样式开关 MutationObserver 不一定可靠（style 属性
    // 变更需 attributeFilter 匹配，弹层分散在各插件），低频轮询最稳且开销可忽略（4 个 getElementById）。
    window.setInterval(() => { checkOverlays(); fixAria(); }, 400);
});

registerHook(HookType.OnDomChange, () => {
    if (!isFntvTvPage()) return;
    checkOverlays();
    fixAria();
});
