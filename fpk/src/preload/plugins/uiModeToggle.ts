// preload/plugins/uiModeToggle.ts — 「UI 模式」手动切换按钮（右下角浮层，贴「每日放送」上方）
// ─────────────────────────────────────────────────────────────────────────────
// [lc-1319] 取代「触屏能力 × 视口宽」的自动布局判定：该判定在带触摸屏的桌面环境反复
// 误伤（lc-1308~1318 一串"内置/外置不一致""PC 被卷进手机布局"问题的共同源头）。
// 用户要求改为手动切换，入口放在首页「每日放送」按钮旁 —— 本按钮默认就贴在它上方，
// 且**全站常驻**（播放页字号/底栏不对时随时可切，不必先回首页）。
//   手机版 = fnos-narrow / fnos-compact / fnos-touch-narrow 全开
//            （底栏两行、自建面板、轮播样式 5、字号自适应、卡片尺寸……）
//   电脑版 = 三标记全关（与官方网页一致的桌面布局）
// 选择持久化（mobileStyle.UI_MODE_KEY）跨会话记忆；切换由事件驱动即时重应用标记，无需刷新。
import { getUiMode, setUiMode, UI_MODE_EVENT, type UiMode } from './mobileStyle';
import logger from '../core/logger';

const log = logger;
const BTN_ID = 'fntv-uimode-tab';
const STYLE_ID = 'fntv-uimode-style';
let _bound = false;

function injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
/* [lc-1319] UI 模式切换按钮：与「每日放送」同区（其正上方），苹果风素净玻璃
   （无渐变无发光，与宫灯按钮区分主次） */
#fntv-uimode-tab{
  position:fixed; right:20px; bottom:76px; z-index:99998;
  display:flex; align-items:center; gap:6px;
  padding:8px 14px; border-radius:14px; cursor:pointer; user-select:none;
  font-size:13px; font-weight:600; letter-spacing:.3px; color:#fff;
  background:rgba(24,26,34,.78);
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 6px 22px rgba(0,0,0,.35);
  transition:transform .18s ease, background .18s ease, bottom .3s ease;
}
#fntv-uimode-tab:hover{ transform:translateY(-2px); background:rgba(38,42,56,.88); }
#fntv-uimode-tab:active{ transform:scale(.97); }
/* 手机版：品牌蓝点缀，一眼看出当前处于哪种布局 */
#fntv-uimode-tab.on{
  border-color:rgba(51,116,219,.55);
  background:rgba(28,42,68,.85);
}
`;
    (document.head || document.documentElement).appendChild(st);
}

function render(): void {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const m = getUiMode();
    btn.textContent = m === 'mobile' ? '📱 手机版' : '🖥 电脑版';
    btn.title = m === 'mobile'
        ? '当前：手机/平板布局（底栏两行、轮播样式 5、字号自适应）。点击切回电脑布局'
        : '当前：电脑布局。点击切到手机/平板布局';
    btn.classList.toggle('on', m === 'mobile');
}

/** 贴「每日放送」按钮上方；它隐藏/不存在时落回右下角原位（bottom:24 与宫灯一致） */
function reposition(): void {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const hot = document.getElementById('fntv-hot-tab');
    const hotVisible = !!hot && hot.offsetParent !== null && hot.getBoundingClientRect().height > 0;
    btn.style.bottom = hotVisible
        ? Math.round(24 + hot.getBoundingClientRect().height + 10) + 'px'
        : '24px';
}

function mount(): void {
    if (!document.body) return;
    if (document.getElementById(BTN_ID)) { render(); reposition(); return; }
    injectStyle();
    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.setAttribute('data-fnos-ui', '1');   // 与各注入层约定：豁免刷白/焦点/动画接管
    btn.addEventListener('click', () => {
        const next: UiMode = getUiMode() === 'mobile' ? 'desktop' : 'mobile';
        setUiMode(next);   // 事件 → mobileStyle/beautifyStyle 立即重应用标记（无需刷新）
        render();
        log.info('[uiModeToggle] UI 模式切换为 ' + next);
    });
    document.body.appendChild(btn);
    render();
    reposition();
    // 跟随「每日放送」按钮的显隐变化（hotUpdates 按路由改它的 style.display）→ 重定位
    const hot = document.getElementById('fntv-hot-tab');
    if (hot) {
        try {
            new MutationObserver(() => reposition()).observe(hot, { attributes: true, attributeFilter: ['style', 'class'] });
        } catch { /* ignore */ }
    }
}

function boot(): void {
    if (_bound) return;
    _bound = true;
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
    // SPA 内 body 直接子节点被清（极端情况）时自愈重挂
    try {
        new MutationObserver(() => { if (!document.getElementById(BTN_ID)) mount(); })
            .observe(document.body || document.documentElement, { childList: true });
    } catch { /* ignore */ }
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener(UI_MODE_EVENT, render);   // 别处改模式（未来）时同步按钮文案
}

boot();
