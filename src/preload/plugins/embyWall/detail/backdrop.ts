// embyWall/detail/backdrop.ts — 全屏底图 + 瞬间加载层（lc-980 重写）
// ─────────────────────────────────────────────────────────────────────────────
// 两者都是「一个注入 overlay div」关注点，全程构建一次，无 per-tick 工作：
//   • 底图：复用 fnOS 已加载的 hero 背景剧照(无新网络请求)，fixed z-index:-1 铺在页面最底层，
//     配合 beautifyStyle 的「页面背景透明化」透出 → 沉浸感。
//   • 瞬间加载层：进详情瞬间铺「缓存海报 + 骨架 shimmer」盖住 fnOS 原生白屏，hero 就绪即淡出，
//     2s 兜底自动淡出，绝不长期遮挡。缓存海报来自上次访问该 href 时存下的 hero 图(localStorage)。
// ─────────────────────────────────────────────────────────────────────────────
import { findHeroBackdropImg } from './glass';

const BACKDROP_ID = 'fnos-detail-backdrop';
const INSTANT_ID = 'fnos-instant-layer';
const CACHE_PREFIX = 'fntvDetailPoster:';
const CACHE_MAX = 24;         // localStorage 缓存条目上限(防无限增长)
const INSTANT_AUTO_HIDE = 2000; // 兜底：内容始终未渲染也自动淡出，绝不长期遮挡

let _instantAutoTimer = 0;
let _instantRemoveTimer = 0;

// ── 全屏底图 ────────────────────────────────────────────────────────────────

/** 注入/更新全屏底图（幂等：src 未变则不动）。hero 背景剧照由 fnOS 已加载，直接复用其 URL。 */
export function injectBackdrop(hero: HTMLElement): void {
  const img = findHeroBackdropImg(hero);
  const src = img ? (img.currentSrc || img.src || '') : '';
  let layer = document.getElementById(BACKDROP_ID) as HTMLDivElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.id = BACKDROP_ID;
    layer.className = 'fnos-detail-backdrop';
    const bg = document.createElement('div');
    bg.className = 'fnos-detail-backdrop__img';
    const scrim = document.createElement('div');
    scrim.className = 'fnos-detail-backdrop__scrim';
    layer.appendChild(bg);
    layer.appendChild(scrim);
    document.body.appendChild(layer);
  }
  const bg = layer.querySelector<HTMLDivElement>('.fnos-detail-backdrop__img');
  if (bg) {
    // 无图(首帧/半死)时留空 → 只有暗 scrim，绝不刷白(根治旧版白屏)
    const next = src ? `url("${src}")` : 'none';
    if (bg.style.backgroundImage !== next) bg.style.backgroundImage = next;
  }
}

/** 移除全屏底图（离开详情页/关闭开关；O(1)）。 */
export function removeBackdrop(): void {
  const layer = document.getElementById(BACKDROP_ID);
  if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
}

// ── 海报缓存（供瞬间加载层秒出）──────────────────────────────────────────────

function _cacheKey(href: string): string { return CACHE_PREFIX + href.split(/[?#]/)[0]; }

/** hero 就绪后把海报 + 背景剧照存进 localStorage，供下次进同一详情页时瞬间加载层秒出。 */
export function cacheHeroImages(href: string, hero: HTMLElement): void {
  try {
    const bg = findHeroBackdropImg(hero);
    const poster = Array.from(hero.querySelectorAll('img'))
      .filter((im) => (im.currentSrc || im.src) && im.offsetHeight >= 200 && im.offsetHeight <= 400 && im.offsetWidth < 300)[0];
    const data = {
      bg: bg ? (bg.currentSrc || bg.src || '') : '',
      poster: poster ? (poster.currentSrc || poster.src || '') : '',
      ts: Date.now(),
    };
    if (!data.bg && !data.poster) return;
    localStorage.setItem(_cacheKey(href), JSON.stringify(data));
    _pruneCache();
  } catch (_) { /* localStorage 不可用时忽略 */ }
}

function _pruneCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
    }
    if (keys.length <= CACHE_MAX) return;
    const items = keys.map((k) => {
      let ts = 0;
      try { ts = JSON.parse(localStorage.getItem(k) || '{}').ts || 0; } catch (_) { /* ignore */ }
      return { k, ts };
    }).sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < items.length - CACHE_MAX; i++) localStorage.removeItem(items[i].k);
  } catch (_) { /* ignore */ }
}

function _readCache(href: string): { bg: string; poster: string } | null {
  try {
    const raw = localStorage.getItem(_cacheKey(href));
    if (!raw) return null;
    const d = JSON.parse(raw);
    return { bg: d.bg || '', poster: d.poster || '' };
  } catch (_) { return null; }
}

// ── 瞬间加载层 ──────────────────────────────────────────────────────────────

/** 进详情瞬间铺加载层：缓存海报(有则秒出) + 骨架 shimmer，盖住 fnOS 原生白屏。构建一次。
 *
 *  [lc-993] 没有缓存**海报**就整体不铺层 —— 这是「一级详情页灰色骨架屏遮罩」的第二重成因。
 *  两重成因（第一重在 embyWall.ts 的 hideStaleViews，已修）：
 *   · 第一重：hideStaleViews 把本层的无 id 子节点(__bg / __scrim)当成残留视图 display:none，
 *     海报背景被打掉，只剩灰 scrim + shimmer 骨架。真机日志 89 次隐藏里 82 次打的是自己人。
 *   · 第二重(本处)：海报缓存只由 _apply() → cacheHeroImages() 写入，而一级详情页在 lc-993 之前
 *     从来没有 _apply() 成功过(hero 选择器失配) → 缓存恒为 null → __bg 没有 backgroundImage
 *     (blur(40px) 作用在空背景上等于全透明) → 层本体的 --semi-color-bg-0(浅色主题近白)
 *     叠 rgba(0,0,0,.2→.6) 的 __scrim，合成出一张纯灰全屏罩 + 214x320 灰海报块 + 5 条 shimmer 线，
 *     z-index 2147483000 盖满 2 秒。∴ 一级页**每次**都是灰的(Season 页第二次起有缓存才不灰)，
 *     与用户只在一级页抱怨完全对上。
 *
 *  判据取 poster 而不是 bg，因为 Series 一级页(/v/tv|movie/<id> 且非 isVideo)的 hero
 *  **结构上就没有海报**：组件 Zse 只渲染背景剧照 + .gradient 遮罩 + 底部 logo/标题，
 *  海报组件 Xse(214x320)只在 Season 页与 Movie 页(组件 Q)出现。这种页 cacheHeroImages()
 *  写进缓存的 poster 恒为空串 → 本层的版式(左 214x320 海报 + 右文本行，__lines 还带 padding-top:116px
 *  去对齐海报顶)对它完全是错的形状，铺出来就是「一张海报形状的灰块压在根本没有海报的页面上」
 *  = 用户报的那个东西，只是背后多了张模糊剧照。∴ 宁可让飞牛自己的原生骨架顶上
 *  (该页是 trim-skeleton-main !h-screen，飞牛按这一页的版式设计的)。
 *
 *  对 Season 页与 Movie 一级页**零回归**：两者 hero 内都有 Xse 海报(实测 214x320，
 *  正好落在下面的 offsetHeight 200~400 / offsetWidth<300 过滤区间) → 第二次访问起缓存里有 poster
 *  → 照常秒出，版式也对得上。首次访问(无缓存)本来就没有艺术可秒出，不铺层只是把加载态
 *  交还给原生骨架，不会出现「先灰罩再内容」的双段闪烁。 */
export function showInstantLayer(href: string): void {
  if (document.getElementById(INSTANT_ID)) return; // 已在，不重复构建
  const cache = _readCache(href);
  if (!cache || !cache.poster) return;             // [lc-993] 无海报可秒出 → 不铺灰罩

  const layer = document.createElement('div');
  layer.id = INSTANT_ID;
  layer.className = 'fnos-instant-layer';

  const bg = document.createElement('div');
  bg.className = 'fnos-instant-layer__bg';
  if (cache.bg) bg.style.backgroundImage = `url("${cache.bg}")`;
  layer.appendChild(bg);

  const scrim = document.createElement('div');
  scrim.className = 'fnos-instant-layer__scrim';
  layer.appendChild(scrim);

  const body = document.createElement('div');
  body.className = 'fnos-instant-layer__body';

  // 走到这里 cache.poster 必非空(见上面的早退) → 恒有真海报，不再需要骨架占位块那条分支
  const poster = document.createElement('img');
  poster.className = 'fnos-instant-layer__poster';
  poster.src = cache.poster;
  poster.alt = '';
  body.appendChild(poster);

  const lines = document.createElement('div');
  lines.className = 'fnos-instant-layer__lines';
  [[60, 30], [40, 18], [100, 16], [92, 16], [84, 16]].forEach(([w, h]) => {
    const s = document.createElement('div');
    s.className = 'fnos-instant-skel';
    s.style.width = w + '%';
    s.style.height = h + 'px';
    lines.appendChild(s);
  });
  body.appendChild(lines);
  layer.appendChild(body);

  document.body.appendChild(layer);

  // 兜底：即使 hero 始终未就绪，也在 2s 后自动淡出，绝不长期遮挡
  clearTimeout(_instantAutoTimer);
  _instantAutoTimer = window.setTimeout(() => hideInstantLayer(), INSTANT_AUTO_HIDE);
}

/** 淡出并移除瞬间加载层（hero 就绪时调用；幂等，无操作则 no-op）。 */
export function hideInstantLayer(): void {
  clearTimeout(_instantAutoTimer);
  const layer = document.getElementById(INSTANT_ID) as HTMLDivElement | null;
  if (!layer) return;
  if (layer.classList.contains('is-hiding')) return; // 已在淡出
  layer.classList.add('is-hiding');
  clearTimeout(_instantRemoveTimer);
  _instantRemoveTimer = window.setTimeout(() => {
    const el = document.getElementById(INSTANT_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }, 340);
}

/** 彻底清理加载层相关定时器 + 节点（离开详情页 teardown）。 */
export function clearInstantLayer(): void {
  clearTimeout(_instantAutoTimer);
  clearTimeout(_instantRemoveTimer);
  const el = document.getElementById(INSTANT_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}
