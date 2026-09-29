// embyWall/carousel/bootCover.ts — [lc-066] 启动进度条遮罩（极简版，取代 lc-1084 骨架屏）。
// ─────────────────────────────────────────────────────────────────────────────
// 问题：删骨架屏后，刷新时 fnOS 原生页先渲染（~1-1.5s），轮播等「媒体库 section」
//   出现后才注入 → 原生页裸奔闪现，然后才切到海报墙。
// 做法（极简，无骨架布局）：
//   · #root 加 visibility:hidden（保留布局盒，不影响 a[href] 抓取回退）
//   · 顶部固定一条 3px 流动进度条（观感 = 原生「进度条加载」）
// 揭示（lift，任一命中）：
//   S.carouselInited（轮播已注入）/ S.carouselLoadedButNone（STRM 提示已渲染）/
//   离开首页路径 / 2.5s 硬兜底（绝不长遮）。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from '../state';
import { pagePath } from '../../../core/pageMode';

const STYLE_ID = 'fntv-boot-style';
const BAR_ID = 'fntv-boot-bar';
const POLL_MS = 120;
const HARD_LIFT_MS = 2500;

let _armed = false;
let _poll = 0;

// [lc-1279] 用 pagePath()（剥网关前缀）判定首页：fpk 网关模式下地址栏是 /app/fntvplus/v，
//   直读 location.pathname 永不命中 → armBootCover 直接 return，启动进度条根本不挂；
//   且注入 shim 会在带/不带前缀间切换地址，直读判定随时机抖动。
const isHome = (): boolean => { const p = pagePath(); return p === '/v' || p === '/v/'; };

function ensure(): void {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
#${BAR_ID}{position:fixed;top:0;left:0;right:0;height:3px;z-index:99999;pointer-events:none;background:rgba(148,156,178,.15)}
#${BAR_ID}::after{content:'';position:absolute;left:0;top:0;height:100%;width:38%;border-radius:3px;background:var(--fnos-ui-accent,#4a8df0);animation:fntv-boot-slide 1s ease-in-out infinite}
@keyframes fntv-boot-slide{0%{left:-38%}100%{left:100%}}
html.fntv-boot-hide #root{visibility:hidden}
`;
  document.documentElement.appendChild(st);
}

function lift(): void {
  try {
    document.documentElement.classList.remove('fntv-boot-hide');
    document.getElementById(BAR_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  } catch { /* ignore */ }
  if (_poll) { clearInterval(_poll); _poll = 0; }
  _armed = false;
}

export function armBootCover(): void {
  if (_armed || !isHome()) return;
  _armed = true;
  ensure();
  document.documentElement.classList.add('fntv-boot-hide');
  if (!document.getElementById(BAR_ID)) {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    (document.body || document.documentElement).appendChild(bar);
  }
  _poll = window.setInterval(() => {
    if (!isHome()) return lift();
    if (S.carouselInited) return lift();
    if (S.carouselLoadedButNone) return lift();
  }, POLL_MS);
  setTimeout(lift, HARD_LIFT_MS); // 硬兜底：绝不长遮（lift 幂等，重复调用无害）
}
