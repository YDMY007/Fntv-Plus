// embyWall/carousel/bootCover.ts — [lc-1084] 首页强刷启动骨架遮罩
// ─────────────────────────────────────────────────────────────────────────────
// 问题：强制刷新后飞牛原生 #root 约 2.5s 渲染完成(媒体库卡片+番剧/百度云行整页可见)，
//   而我们的轮播要等详情补完 revealOnce(~4s)才注入 → 中间 1.5s+ 原生页裸奔闪现。
//   旧版 DOM 抓取慢、骨架占位先于原生渲染注入所以看不出；lc-1083 换 JSON API 后时序反转暴露。
// 做法：启动期(仅首页路径)给 body>#root 挂 visibility:hidden(保留布局盒, 不影响 a[href] 抓取回退)，
//   同时铺一层 fixed 全屏骨架(导航行+16:9 hero+卡片行, shimmer 微光, 主题变量自适应)。
//   我们的标题栏/粒子/每日放送等都是 #root 的兄弟节点, 不受隐藏影响 → 窗口控件始终可用。
// 揭示(lift)信号, 任一命中即撤隐藏+骨架淡出：
//   S.carouselInited(真实轮播已注入) / S.carouselLoadedButNone(STRM 提示已渲染) /
//   离开首页路径(SPA 导航) / 12s 硬兜底(绝不长遮)。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from '../state';
import { log } from '../log';

const STYLE_ID = 'fntv-boot-style';
const HIDE_ID = 'fntv-boot-hide';
const COVER_ID = 'fntv-boot-cover';
const POLL_MS = 150;
const HARD_LIFT_MS = 12000;
const FADE_MS = 260;

let _armed = false;
let _poll = 0;

const isHome = (): boolean => { const p = location.pathname; return p === '/v' || p === '/v/'; };

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
@keyframes fntv-boot-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
#${COVER_ID}{position:fixed;inset:0;z-index:9000;pointer-events:none;opacity:1;transition:opacity ${FADE_MS}ms ease}
#${COVER_ID} .bc-skel{position:relative;overflow:hidden;background:rgba(148,156,178,.14);border-radius:10px}
#${COVER_ID} .bc-skel::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);transform:translateX(-120%);animation:fntv-boot-shimmer 1.5s infinite}
html.dark #${COVER_ID} .bc-skel{background:rgba(255,255,255,.10)}
html.dark #${COVER_ID} .bc-skel::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent)}
#${COVER_ID} .bc-wrap{position:absolute;inset:0;padding:76px 44px 40px;display:flex;flex-direction:column;gap:22px;box-sizing:border-box}
#${COVER_ID} .bc-nav{flex:0 0 auto;display:flex;align-items:center;gap:14px;height:40px}
#${COVER_ID} .bc-nav .bc-burger{width:26px;height:26px;border-radius:8px}
#${COVER_ID} .bc-nav .bc-title{width:64px;height:18px;border-radius:9px}
#${COVER_ID} .bc-nav .bc-spacer{flex:1}
#${COVER_ID} .bc-nav .bc-ico{width:36px;height:36px;border-radius:50%}
#${COVER_ID} .bc-hero{flex:0 0 auto;width:100%;aspect-ratio:16/9;max-height:calc(100vh - 380px);border-radius:24px}
#${COVER_ID} .bc-row{flex:0 0 auto;display:flex;gap:16px}
#${COVER_ID} .bc-row .bc-card{flex:1;height:132px;border-radius:14px}
`;
  (document.head || document.documentElement).appendChild(st);
}

function buildCover(): HTMLElement {
  const cover = document.createElement('div');
  cover.id = COVER_ID;
  const wrap = document.createElement('div');
  wrap.className = 'bc-wrap';
  const nav = document.createElement('div');
  nav.className = 'bc-nav';
  ['bc-burger', 'bc-title'].forEach(c => { const d = document.createElement('div'); d.className = 'bc-skel ' + c; nav.appendChild(d); });
  const spacer = document.createElement('div'); spacer.className = 'bc-spacer'; nav.appendChild(spacer);
  for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.className = 'bc-skel bc-ico'; nav.appendChild(d); }
  wrap.appendChild(nav);
  const hero = document.createElement('div'); hero.className = 'bc-skel bc-hero'; wrap.appendChild(hero);
  const row = document.createElement('div'); row.className = 'bc-row';
  for (let i = 0; i < 6; i++) { const d = document.createElement('div'); d.className = 'bc-skel bc-card'; row.appendChild(d); }
  wrap.appendChild(row);
  cover.appendChild(wrap);
  return cover;
}

function lift(reason: string): void {
  if (!_armed) return;
  _armed = false;
  clearInterval(_poll);
  const hide = document.getElementById(HIDE_ID);
  if (hide && hide.parentNode) hide.parentNode.removeChild(hide); // 先揭示真实内容, 骨架在其上淡出=交叉过渡
  const c = document.getElementById(COVER_ID);
  if (c) {
    c.style.opacity = '0';
    window.setTimeout(() => { if (c.parentNode) c.parentNode.removeChild(c); }, FADE_MS + 80);
  }
  log('[lc-1084] boot cover lifted:', reason);
}

/** 入口 init 调用(仅首页路径生效)：铺骨架+隐藏原生 #root，直到轮播就绪/离开首页/硬兜底。 */
export function armBootCover(): void {
  if (_armed || !isHome()) return;
  _armed = true;
  ensureStyle();
  const hide = document.createElement('style');
  hide.id = HIDE_ID;
  hide.textContent = 'body>#root{visibility:hidden}';
  (document.head || document.documentElement).appendChild(hide);
  (document.body || document.documentElement).appendChild(buildCover());
  const t0 = Date.now();
  _poll = window.setInterval(() => {
    if (!isHome()) { lift('left-home'); return; }
    if (S.carouselInited) { lift('carousel-inited'); return; }
    if (S.carouselLoadedButNone) { lift('loaded-but-none'); return; }
    if (Date.now() - t0 > HARD_LIFT_MS) { lift('hard-timeout'); return; }
  }, POLL_MS);
  log('[lc-1084] boot cover armed (hide #root + skeleton overlay)');
}
