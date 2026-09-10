// embyWall/carousel/bootCover.ts — [lc-1084] 首页强刷启动防白闪
// ─────────────────────────────────────────────────────────────────────────────
// 问题：强制刷新后飞牛原生 #root 约 2.5s 渲染完成(媒体库卡片+番剧/百度云行整页可见)，
//   而我们的轮播要等详情补完 revealOnce(~4s)才注入 → 中间 1.5s+ 原生页裸奔闪现。
// [lc-1131] 骨架遮罩已按用户要求删除；防白闪本体 = 隐藏 #root + **在 #root 外挂同款加载浮层**。
//   关键事实：injectCarousel 的「装饰海报+百分比」占位建在原生 #root 里，藏 #root 会把它一起藏掉
//   (lc-1130 因此露馅成整屏空白)。故 boot 期间自行在 body 下铺一个居中浮层(同款紫色海报占位
//   + 中央大百分比/进度条)，本地伪进度推进(前快后慢)，与 #root 内的真占位互不干扰(不写 S 轮播字段)。
// 揭示(lift)信号, 任一命中即撤隐藏+浮层：
//   S.carouselInited(真实轮播已注入) / S.carouselLoadedButNone(STRM 提示已渲染) /
//   离开首页路径(SPA 导航) / 12s 硬兜底(绝不长遮)。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from '../state';
import { clog } from '../log';

const HIDE_ID = 'fntv-boot-hide';
const LOADUI_ID = 'fntv-boot-loadui';
const POLL_MS = 150;
const HARD_LIFT_MS = 12000;

let _armed = false;
let _poll = 0;
let _progTimer = 0;

const isHome = (): boolean => { const p = location.pathname; return p === '/v' || p === '/v/'; };

/** [lc-1131] #root 外的启动加载浮层: 与 progress.ts 原始占位同款视觉(紫渐变容器+装饰海报+中央百分比进度) */
function buildLoadOverlay(): void {
  if (document.getElementById(LOADUI_ID)) return;
  const root = document.createElement('div');
  root.id = LOADUI_ID;
  // fixed 全屏居中; 低于自绘标题栏(99999)与每日放送(99998), 不挡窗口控件
  root.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;pointer-events:none;padding:0 44px;box-sizing:border-box';
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-width:1400px;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;'
    + 'background:linear-gradient(155deg,rgba(145,115,215,.22),rgba(70,50,120,.34));'
    + 'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);box-shadow:none';
  const deco = (l: string, t: string, r: string): HTMLElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${l};top:${t};width:104px;height:152px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);transform:rotate(${r})`;
    return d;
  };
  container.appendChild(deco('6%', '14%', '-7deg'));
  container.appendChild(deco('14%', '26%', '4deg'));
  container.appendChild(deco('22%', '15%', '-2deg'));
  const center = document.createElement('div');
  center.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:2';
  const pctEl = document.createElement('div');
  pctEl.style.cssText = 'font-size:30px;font-weight:700;color:rgba(240,236,255,.98);font-variant-numeric:tabular-nums;letter-spacing:.5px;line-height:1';
  pctEl.textContent = '0%';
  const track = document.createElement('div');
  track.style.cssText = 'width:280px;height:8px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden;position:relative';
  const fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,#8f6fe8,#c9a7f0);transition:width .25s ease';
  track.appendChild(fill);
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12.5px;color:rgba(225,218,245,.85);padding:4px 14px;border-radius:30px;background:rgba(255,255,255,.09);font-weight:600;letter-spacing:.5px';
  status.textContent = '加载中';
  const text = document.createElement('div');
  text.style.cssText = 'font-size:15px;color:rgba(240,236,255,.9);letter-spacing:1.2px;font-weight:600';
  text.textContent = '正在加载精彩内容';
  center.appendChild(pctEl);
  center.appendChild(track);
  center.appendChild(status);
  center.appendChild(text);
  container.appendChild(center);
  root.appendChild(container);
  document.body.appendChild(root);
  // 本地伪进度(前快后慢, 与 progress.ts 模拟器同策略); 不写 S 轮播字段, lift 时随浮层一起清
  let pct = 0;
  _progTimer = window.setInterval(() => {
    const inc = pct < 30 ? 1.4 + Math.random() * 1.2 : pct < 70 ? 0.9 + Math.random() * 0.9 : 0.4 + Math.random() * 0.5;
    pct = Math.min(99, pct + inc);
    fill.style.width = pct + '%';
    pctEl.textContent = Math.round(pct) + '%';
  }, 120);
}

function lift(reason: string): void {
  if (!_armed) return;
  _armed = false;
  clearInterval(_poll);
  if (_progTimer) { clearInterval(_progTimer); _progTimer = 0; }
  const hide = document.getElementById(HIDE_ID);
  if (hide && hide.parentNode) hide.parentNode.removeChild(hide);
  const ui = document.getElementById(LOADUI_ID);
  if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
  clog('[lc-1084] boot hide lifted:', reason);
}

/** 入口 init 调用(仅首页路径生效)：隐藏原生 #root 防白闪 + 铺海报百分比加载浮层，直到轮播就绪/离开首页/硬兜底。 */
export function armBootCover(): void {
  if (_armed || !isHome()) return;
  _armed = true;
  const hide = document.createElement('style');
  hide.id = HIDE_ID;
  hide.textContent = 'body>#root{visibility:hidden}';
  (document.head || document.documentElement).appendChild(hide);
  buildLoadOverlay();
  const t0 = Date.now();
  _poll = window.setInterval(() => {
    if (!isHome()) { lift('left-home'); return; }
    if (S.carouselInited) { lift('carousel-inited'); return; }
    if (S.carouselLoadedButNone) { lift('loaded-but-none'); return; }
    if (Date.now() - t0 > HARD_LIFT_MS) { lift('hard-timeout'); return; }
  }, POLL_MS);
  clog('[lc-1084] boot hide armed (#root hidden + poster/percent load overlay)');
}
