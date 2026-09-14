// embyWall/detail/epListMerge.ts — [lc-1147] 季页选集「分区全量显示 + 分区切换」
// ─────────────────────────────────────────────────────────────────────────────
// 现象（用户）：二级季详情页左边集信息最多显示 11 集左右的卡片，剩下的不显示。
//
// 真因（2026-09-13 活体实证，48 集的剧 /v/tv/season/<id>）：
//   原生选集横滑带有**两层裁剪**，美化竖排（D 段）只撞死了第二层的驱动：
//   ① 数据层分页：工具行「1 - 30 / 31 - 48」页码锚点按页拉数据（30/页），组件**整页交换**——
//      任何时刻数据里只有当前页（实测第 1 页挂 30 张/第 2 页挂 18 张，两页从未同时存在）；
//   ② 渲染层虚拟窗口：组件只把横向窗口（clientWidth × 槽宽）内的卡片挂进 DOM
//      （1680 视口首屏 10 张/1280 视口 9 张），靠横向滚动事件滑窗补卸。
//   D 段把横滑带 overflow 强制 visible 改竖排后横向滚动死亡 → 虚拟窗口冻在首屏 →
//   竖排列表永远只有首屏那几张；页码锚点同样依赖那个滚不动的容器 → 点了没反应。
//
// 方案（2026-09-14 用户定稿，推翻 09-13 的「克隆合并全部」版）：
//   「飞牛自己把 1-30 划为一个分区，你也第一个分区只显示 30 个，后面的通过切换下一个
//    分区按钮来显示」——即**跟随原生分页模型**：
//   ① 撑大视口：ms 宽 30000px + `window.dispatchEvent(resize)` → 虚拟窗口覆盖整页数据 →
//      当前分区全量挂载（实测 30/30、18/18 稳定）。⚠ overflow-x 必须 hidden 且 wmax 宽度
//      恰等于视口（padding 补偿）：①不能留横向可滚余量，wheelHScroll 会把列表转成左右滑；
//      ②hidden 的 clientWidth 仍全宽，窗口计算不受影响。
//   ② 分区切换：原生锚点在竖排下失效是「滚动容器死了」→ 点击时**临时放行**
//      （overflow-x:auto + wmax 加宽制造真实滚动行程），让原生 scrollTo 完成切页；
 //      ~1.2s 后收窄回 hidden + resize → 新分区全量挂载。锚点高亮/页码文案全部原生自理。
//
// 相比克隆合并版删掉的东西：克隆容器/点击委托/懒加载缩略图回填/8s 冷却——当前分区
// 就是原生 DOM，观看状态/进度/回填全部实时，零陈旧问题。
// ⚠ 生命周期：React 切分区/重渲染会重建 ms 容器，内联样式全丢 → 样式每次 ensure 现量
//   现打；锚点监听按 data-fnos-partition 标记幂等重挂（React 重建锚点后自动重绑）。
//   本模块零自建常驻观察器：自愈复用 embyWall.ts 的 _detailObs → ensureEpListMerge(false)。
// ⚠ 导出名保持 schedule/ensure/removeEpListMerge 不变（embyWall.ts 三处钩子已按此接线）。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findActiveDetailView } from './glass';

/** 虚拟窗口撑大后的 ms 宽度：只需 ≥ 本分区数据总槽宽（实测 ~117px/槽 ×30 ≈ 3.5k），
 *  取 30000 一步到位，wrapper overflow:hidden 裁掉透明盒。 */
const WIDE_MS_PX = 30000;
/** 点击分区锚点后，放行原生滚动动画的时长；到点收窄回 hidden 并重撑窗口。 */
/** 放行窗口时长：超过后 ensure 恢复正常收窄（native 平滑切页动画期间不可打断）。 */
const REWIDEN_GRACE_MS = 1500;
const RETRY_DELAYS = [0, 400, 1000, 2000, 3400, 5000];

let _retryTimers: number[] = [];

function seasonGuid(): string | null {
  const m = location.pathname.match(/\/v\/tv\/season\/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

interface EpStrip { ms: HTMLElement; wmax: HTMLElement; wrapper: HTMLElement; cardW: number; }

/** 定位选集横滑带（排除演职人员同构容器：只认内含集卡链接的那个）。 */
function findEpStrip(): EpStrip | null {
  const view = findActiveDetailView();
  if (!view) return null;
  const mss = view.querySelectorAll<HTMLElement>('.ms-container[class*="overflow-x-scroll"]');
  for (let i = 0; i < mss.length; i++) {
    const ms = mss[i];
    if (!ms.querySelector('a[href*="/v/tv/episode/"]')) continue;
    const wmax = (Array.from(ms.children).find((c) => String(c.className).includes('w-max'))
      || ms.firstElementChild) as HTMLElement | null;
    if (!wmax) continue;
    const wrapper = ms.parentElement as HTMLElement;
    // ⚠ cardW（正确列宽）必须从 wrapper 列宽 − ms 水平 padding 推导，**绝不能量卡片自身**：
    //    切分区后 React 可能按放行期的宽度渲染出 43912px 的巨卡，量卡片会把错误值当基准，
    //    converge 的「已正确」判定恒真 → 永不修复（09-14 深夜实测踩坑）。
    const padH = padHOf(ms);
    let cardW = wrapper ? Math.max(0, wrapper.clientWidth - padH) : 0;
    if (cardW < 100) {
      // wrapper 尺寸异常时才退回量卡（至少别钉成 0）
      const card0 = ms.querySelector<HTMLElement>('[data-id="details"]');
      cardW = card0 ? card0.getBoundingClientRect().width : 0;
    }
    return { ms, wmax, wrapper, cardW };
  }
  return null;
}

interface PageAnchor { text: string; el: HTMLElement; total: number; active: boolean; }

/** 读工具行页码锚点（「1 - 30」「31 - 48」…）。active = 品牌高亮类（当前分区）。 */
function readPages(strip: EpStrip): PageAnchor[] {
  const toolbar = strip.wrapper.parentElement;
  if (!toolbar) return [];
  const spans = toolbar.querySelectorAll<HTMLElement>('span');
  const out: PageAnchor[] = [];
  for (let i = 0; i < spans.length; i++) {
    const t = (spans[i].textContent || '').trim();
    const m = t.match(/^(\d+) - (\d+)$/);
    if (!m) continue;
    let e: HTMLElement | null = spans[i];
    let hasClick = false;
    for (let k = 0; k < 5 && e; k++) {
      const props = Object.keys(e).find((k2) => k2.startsWith('__reactProps'));
      if (props && typeof (e as any)[props]?.onClick === 'function') { hasClick = true; break; }
      e = e.parentElement;
    }
    if (!hasClick || !e) continue;
    const cls = String(e.className);
    out.push({ text: t, el: e, total: parseInt(m[2], 10), active: cls.includes('!font-[600]') || cls.includes('!text-[var(--semi-color-primary)]') });
  }
  return out;
}

/** 撑大虚拟窗口（幂等，可对 React 重建后的新 ms 反复重打）。只动宽度/滚动/卡宽，
 *  ⚠ 不动可见性——当前分区全量挂载后就是它直接显示。
 *  ⚠ overflow-x 必须 **hidden** 且 wmax 宽度恰等于 ms 视口宽（padding 补偿）：绝不能留
 *  横向可滚余量——wheelHScroll 会把列表转成左右滑（09-14 用户报障）。hidden 的
 *  clientWidth 仍是全宽 → 虚拟窗口照常覆盖整页，但 scrollLeft 恒 0。 */
function widen(strip: EpStrip): void {
  const { ms, wmax, wrapper, cardW } = strip;
  ms.style.setProperty('width', WIDE_MS_PX + 'px', 'important');
  ms.style.setProperty('overflow-x', 'hidden', 'important');
  ms.style.setProperty('overflow-y', 'hidden', 'important');
  // ⚠ wmax 宽度把 ms 自身 padding 也补齐：clientWidth 含 padding 而 scrollWidth = padding +
  // 内容宽——差 1px 都留下可程序化滚动余量（D 段 padding 0 44px 正好漏 88px 游动量）。
  wmax.style.setProperty('width', Math.max(0, WIDE_MS_PX - padHOf(ms)) + 'px', 'important');
  // 卡片钉回视觉列宽：wmax 撑大后 100% 宽会跟涨，竖排行会变成 3 万像素宽的巨行
  if (cardW > 0) {
    ms.querySelectorAll<HTMLElement>('[data-id="details"]').forEach((c) => {
      c.style.setProperty('width', cardW + 'px', 'important');
      c.style.setProperty('max-width', cardW + 'px', 'important');
    });
  }
  // wrapper 裁剪透明大盒，防它盖住右栏吃点击
  if (wrapper) {
    wrapper.style.setProperty('position', 'relative', 'important');
    wrapper.style.setProperty('overflow', 'hidden', 'important');
  }
  window.dispatchEvent(new Event('resize'));
}

function mountedCount(strip: EpStrip): number {
  return strip.ms.querySelectorAll('[data-id="details"]').length;
}

// ── 分区切换（放行原生滚动 → 切页 → 临时观察器收敛） ──

let _grantObs: MutationObserver | null = null;
let _grantDisarmTimer = 0;
let _grantDebounce = 0;
/** 放行窗口期内 ensure 不得插手收窄（会把原生的平滑切页滚动拦腰打断），到点后才恢复。 */
let _grantUntil = 0;

function padHOf(ms: HTMLElement): number {
  const cs = getComputedStyle(ms);
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
}

/** 收敛检查：已是我们要求的形态就 0 写入（防观察器自激），漂移才重新 widen 钉回。 */
function converge(): void {
  const strip = findEpStrip();
  if (!strip) return;
  const { ms, wmax, cardW } = strip;
  const hiddenOk = ms.style.overflowX === 'hidden';
  const wmaxOk = Math.abs(wmax.getBoundingClientRect().width - (WIDE_MS_PX - padHOf(ms))) < 2;
  const card = ms.querySelector<HTMLElement>('[data-id="details"]');
  // ⚠ cardW 是 findEpStrip 现量的「当前正确列宽」——切换分区/改窗口后它就是新基准
  const cardOk = !card || cardW < 2 || Math.abs(card.getBoundingClientRect().width - cardW) < 2;
  if (hiddenOk && wmaxOk && cardOk) return;
  widen(strip);
}

function onPartitionAnchorClick(): void {
  const strip = findEpStrip();
  if (!strip) return;
  // 临时放行：原生锚点内部靠 scrollTo(ms) 完成切页，hidden 下 scrollTo 无效
  const total = Math.max(30, mountedCount(strip));
  msGrantScroll(strip, total);
  _grantUntil = Date.now() + REWIDEN_GRACE_MS;
  // ⚠ 收窄不能只靠定时补打：React 拿到新分区数据后的重渲染是**异步且多波**的（实测
  //   >2s 还在重建），新卡片会按放行期的宽度渲染（实测 43912px 巨卡）。武装一个
  //   **自拆**观察器：任何重建只要漂移就立刻钉回，连续正确即自然静止（非常驻）。
  disarmGrantWatch();
  _grantObs = new MutationObserver(() => {
    clearTimeout(_grantDebounce);
    _grantDebounce = window.setTimeout(converge, 250);
  });
  _grantObs.observe(strip.ms, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  _grantDisarmTimer = window.setTimeout(disarmGrantWatch, 20000);
}

function disarmGrantWatch(): void {
  if (_grantObs) { _grantObs.disconnect(); _grantObs = null; }
  clearTimeout(_grantDisarmTimer);
  clearTimeout(_grantDebounce);
}

/** 临时放行横向滚动（overflow-x:auto + wmax 加宽造出真实滚动行程）。 */
function msGrantScroll(strip: EpStrip, total: number): void {
  strip.ms.style.setProperty('overflow-x', 'auto', 'important');
  strip.wmax.style.setProperty('width', (WIDE_MS_PX - padHOf(strip.ms) + total * 300 + 5000) + 'px', 'important');
}

/** 给分区锚点绑「放行→切页→收窄」前置处理（幂等：React 重建锚点后标记丢失自动重绑）。 */
function bindPartitionNav(pages: PageAnchor[]): void {
  for (const p of pages) {
    if (p.el.getAttribute('data-fnos-partition') === '1') continue;
    p.el.setAttribute('data-fnos-partition', '1');
    p.el.addEventListener('click', onPartitionAnchorClick, true);   // capture: 先于 React 放行
  }
}

// ── 入口 ──

/** 幂等入口：导航钩子(hard) 与 _detailObs(soft) 双路调用；hard 仅表示「进页面主动来一次」，
 *  全量挂载与锚点绑定本身幂等，无需区分处理。 */
export function ensureEpListMerge(_hard: boolean): void {
  if (!seasonGuid()) { removeEpListMerge(); return; }
  // 美化关闭时不接管（原生横滑 + 页码锚点是那时的正确 UI）
  if (!document.body.classList.contains('fnos-beautify')) { removeEpListMerge(); return; }
  const strip = findEpStrip();
  if (!strip) return;                                    // 选集未渲染，重试链/观察器会再来
  const pages = readPages(strip);
  if (pages.length > 1) bindPartitionNav(pages);
  // 放行窗口期内绝不动样式：native 正在平滑滚动切页，中途收窄会把动画拦腰打断
  if (Date.now() >= _grantUntil) widen(strip);
}

/** 导航离开季页/关美化/切序号视图：原生 ms 完全还原（含宽度/overflow，
 *  否则 30000px 裁剪盒会留在缓存视图里等着复发）。 */
export function removeEpListMerge(): void {
  disarmGrantWatch();
  const strip = findEpStrip();
  if (strip) {
    strip.ms.style.removeProperty('width');
    strip.ms.style.removeProperty('overflow-x');
    strip.ms.style.removeProperty('overflow-y');
    strip.wmax.style.removeProperty('width');
  }
}

/** 导航钩子调用：季页 → 有界重试链挂全量显示；离开 → 还原生。 */
export function scheduleEpListMerge(): void {
  for (let i = 0; i < _retryTimers.length; i++) clearTimeout(_retryTimers[i]);
  _retryTimers = [];
  if (!seasonGuid()) { removeEpListMerge(); return; }
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _retryTimers.push(window.setTimeout(() => {
      if (!seasonGuid()) return;
      ensureEpListMerge(true);
    }, RETRY_DELAYS[i]));
  }
}
