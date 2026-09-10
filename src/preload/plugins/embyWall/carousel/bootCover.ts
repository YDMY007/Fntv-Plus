// embyWall/carousel/bootCover.ts — [lc-1084] 首页强刷启动防白闪
// ─────────────────────────────────────────────────────────────────────────────
// 问题：强制刷新后飞牛原生 #root 约 2.5s 渲染完成(媒体库卡片+番剧/百度云行整页可见)，
//   而我们的轮播要等详情补完 revealOnce(~4s)才注入 → 中间 1.5s+ 原生页裸奔闪现。
//   旧版 DOM 抓取慢、骨架占位先于原生渲染注入所以看不出；lc-1083 换 JSON API 后时序反转暴露。
// [lc-1130] 按用户要求移除启动骨架遮罩(导航行+hero+卡片行 shimmer)，只保留防白闪本体：
//   启动期(仅首页路径)给 body>#root 挂 visibility:hidden(保留布局盒, 不影响 a[href] 抓取回退)，
//   加载期间用户看到的是轮播占位的「装饰海报 + 百分比进度」(progress.ts buildLoadingPlaceholder 原始样式)。
//   我们的标题栏/粒子/每日放送等都是 #root 的兄弟节点, 不受隐藏影响 → 窗口控件始终可用。
// 揭示(lift)信号, 任一命中即撤隐藏：
//   S.carouselInited(真实轮播已注入) / S.carouselLoadedButNone(STRM 提示已渲染) /
//   离开首页路径(SPA 导航) / 12s 硬兜底(绝不长遮)。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from '../state';
import { clog } from '../log';

const HIDE_ID = 'fntv-boot-hide';
const POLL_MS = 150;
const HARD_LIFT_MS = 12000;

let _armed = false;
let _poll = 0;

const isHome = (): boolean => { const p = location.pathname; return p === '/v' || p === '/v/'; };

function lift(reason: string): void {
  if (!_armed) return;
  _armed = false;
  clearInterval(_poll);
  const hide = document.getElementById(HIDE_ID);
  if (hide && hide.parentNode) hide.parentNode.removeChild(hide);
  clog('[lc-1084] boot hide lifted:', reason);
}

/** 入口 init 调用(仅首页路径生效)：隐藏原生 #root 防白闪，直到轮播就绪/离开首页/硬兜底。 */
export function armBootCover(): void {
  if (_armed || !isHome()) return;
  _armed = true;
  const hide = document.createElement('style');
  hide.id = HIDE_ID;
  hide.textContent = 'body>#root{visibility:hidden}';
  (document.head || document.documentElement).appendChild(hide);
  const t0 = Date.now();
  _poll = window.setInterval(() => {
    if (!isHome()) { lift('left-home'); return; }
    if (S.carouselInited) { lift('carousel-inited'); return; }
    if (S.carouselLoadedButNone) { lift('loaded-but-none'); return; }
    if (Date.now() - t0 > HARD_LIFT_MS) { lift('hard-timeout'); return; }
  }, POLL_MS);
  clog('[lc-1084] boot hide armed (#root hidden until carousel ready)');
}
