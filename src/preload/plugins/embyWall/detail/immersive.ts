// embyWall/detail/immersive.ts — 详情页美化编排层（lc-980 重写）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：精准三闸触发 + 一次性限域 observer，把「套美化」收敛成 O(1) per 导航的一次成型动作。
//
// 与旧版(lc-979 前)的本质区别——旧版为何卡顿/错乱/两次点击：
//   ✗ 旧：_detailObs 每 200ms 全文档 querySelectorAll + getComputedStyle 扫描 + dumpSeasonDOMToFile 写文件
//        + setInterval(600ms) 演员重排 + layoutSeasonTwoPane 搬运 React 节点 + 运行时亮度采样 → 与 SPA 重渲染对打 → 无限重排环路。
//   ✓ 新：三闸(URL && 活跃视图 && 视图内 hero)一次判定；命中即 injectBeautifyStyle + body.class + injectBackdrop
//        → 布局/玻璃/悬停全交给 CSS(零节点搬运)；observer rAF 去抖、命中即 disconnect、硬上限 4s 自断；
//        无写文件、无 setInterval、无 getComputedStyle 风暴、无 DOM 搬运。
//
// 判定锚点(实测见 memory/fnos-detail-dom.md)：
//   活跃视图 .trim-ui__cache-outlet--exclude(末尾可见)；hero .semi-always-dark[class*="h-[470px]"](详情独有, 首页无)。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from '../state';
import { dlog } from '../log';
import { isDetailPage, findActiveDetailView, findDetailHero } from './glass';
import { injectBeautifyStyle } from './beautifyStyle';
import { injectBackdrop, removeBackdrop, hideInstantLayer, clearInstantLayer, showInstantLayer, cacheHeroImages } from './backdrop';
import { scheduleTmdbCard, removeTmdbCard } from './tmdbCard';
import { scheduleEpResolution, removeEpResolution } from './epResolution';

/** observer 硬上限生命周期(ms)：超时强制断开，绝不变永久轮询(旧版病根)。 */
const OBS_MAX_LIFE = 4000;
/** hero 图可能懒加载：settle 后一次性(非轮询)延迟刷新底图，捕获迟到的剧照。 */
const BACKDROP_REFRESH_DELAY = 700;

let _obs: MutationObserver | null = null;
let _rafId = 0;
let _obsBornAt = 0;
let _settledHref: string | null = null;
let _backdropRefreshTimer = 0;

function _disconnectObs(): void {
  if (_obs) { _obs.disconnect(); _obs = null; }
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
}

/** 套用美化（三闸已过、hero 已就绪）：一次成型，之后全靠 CSS，无任何 per-tick 工作。 */
function _apply(view: HTMLElement, hero: HTMLElement): void {
  injectBeautifyStyle();                 // 幂等，全程只一份 <style>
  document.body.classList.add('fnos-beautify');
  injectBackdrop(hero);                  // 复用 hero 已加载剧照，无新网络请求
  hideInstantLayer();                    // 内容就绪 → 淡出瞬间加载层
  cacheHeroImages(location.href, hero);  // 存海报/剧照供下次进同页秒出
  scheduleTmdbCard(view);                // 延后异步注入信息卡（非阻塞，失败静默）
  scheduleEpResolution();                // 清晰度角标 → 标题后胶囊（内部有上限重试链，等选集卡到达）
  _settledHref = location.href;
  S.detailGlassInited = true;
  _disconnectObs();                      // 一次性：命中即断开

  // hero 剧照可能晚于 settle 才解码/懒加载 → 一次性延迟刷新底图(非轮询)
  clearTimeout(_backdropRefreshTimer);
  _backdropRefreshTimer = window.setTimeout(() => {
    if (_settledHref !== location.href) return;
    const v = findActiveDetailView();
    const h = v && findDetailHero(v);
    if (h) injectBackdrop(h);
  }, BACKDROP_REFRESH_DELAY);

  dlog('beautify: 套用完成 href=' + location.pathname);
}

/** 三闸判定：①URL 详情 ②活跃视图存在 ③视图内 hero 就绪。全过→套用并返回 true。 */
function _trySettle(): boolean {
  if (!isDetailPage()) return false;
  const view = findActiveDetailView();
  if (!view) return false;
  const hero = findDetailHero(view);
  if (!hero) return false;
  _apply(view, hero);
  return true;
}

/** 换 href 时的轻量复位：保留 body.class + <style>(避免原生闪回)，只清底图/卡/observer，等新页重套。 */
function _softReset(): void {
  _disconnectObs();
  clearTimeout(_backdropRefreshTimer);
  _settledHref = null;
  removeBackdrop();
  removeTmdbCard();
  removeEpResolution();
}

/** arm 一次性限域 observer：只等 hero 出现，命中即套用+disconnect；硬上限 OBS_MAX_LIFE 后自断。 */
function _armObserver(): void {
  if (_obs) return; // 已 arm，不重复
  _obsBornAt = Date.now();
  const check = (): void => {
    _rafId = 0;
    if (_trySettle()) return;                       // 命中 → _apply 内已 disconnect
    if (Date.now() - _obsBornAt > OBS_MAX_LIFE) {   // 硬上限：停止，绝不变永久轮询
      dlog('beautify: observer 超 ' + OBS_MAX_LIFE + 'ms 未见 hero, 自断(下次导航重试)');
      _disconnectObs();
    }
  };
  _obs = new MutationObserver(() => {
    if (_rafId) return;                             // rAF 去抖：一帧内多次突变只查一次
    _rafId = requestAnimationFrame(check);
  });
  // 此刻活跃详情视图可能尚未渲染, 无法定位子树 → 观察 body, 但命中即断、有硬上限, 与旧版永久全文档轮询本质不同
  _obs.observe(document.body, { childList: true, subtree: true });
}

/** 统一入口（导航 hook / 设置开关 ON 调用）：
 *  非详情页或关闭开关 → teardown；已在当前 href 套好 → 幂等早退；
 *  hero 已渲染 → 秒套(不铺加载层, 无闪)；hero 未就绪 → 铺瞬间加载层盖白屏 + arm 一次性 observer 等它。 */
export function applyDetailBeautify(): void {
  if (S.detailBoxless || !isDetailPage()) { teardownDetailBeautify(); return; }
  if (_settledHref === location.href && document.body.classList.contains('fnos-beautify')) return; // 幂等
  if (_settledHref !== location.href) _softReset();
  if (_trySettle()) return;               // hero 已在 → 立即套用，无需加载层
  showInstantLayer(location.href);        // hero 未就绪 → 铺加载层盖住 fnOS 原生白屏
  _armObserver();                         // 等 hero，命中即套用 + 淡出加载层
}

/** 彻底清理（离开详情页 / 关闭开关 / 切到非详情）：O(1)，恢复 fnOS 原生外观。 */
export function teardownDetailBeautify(): void {
  _disconnectObs();
  clearTimeout(_backdropRefreshTimer);
  _settledHref = null;
  document.body.classList.remove('fnos-beautify');
  removeBackdrop();
  removeTmdbCard();
  removeEpResolution();
  clearInstantLayer();
  S.detailGlassInited = false;
}
