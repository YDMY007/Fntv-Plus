// embyWall/detail/glass.ts — 详情页公共工具（精准触发判定）
// 详情页美化于 lc-980 重写：CSS 优先、零节点搬运、精准三闸触发。
// 本文件只提供「判定 / 定位」的纯查询工具，供 immersive.ts 编排层与轮播 logo、亮度采样复用。

/** hero 精准选择器：`.semi-always-dark` 全文档有 5 个(4 个是 36×36 小图标)，
 *  只有 hero 带 `h-[470px]`。用属性子串匹配避开 Tailwind 任意值的 CSS 转义。 */
export const DETAIL_HERO_SEL = '.semi-always-dark[class*="h-[470px]"]';
/** fnOS 视图栈「当前活跃可见视图」标记(exclude=活跃, --cache=隐藏)。 */
export const ACTIVE_VIEW_SEL = '.trim-ui__cache-outlet--exclude';

/** 检测当前 URL 是否为详情页(tv/movie/season)。
 *  [lc-963] 先剥离 ?query/#fragment 再匹配, 兼容带参数的深链/分享链接(如 /v/tv/<id>?autoplay=1)。
 *  注意：`/v/tv/episode/<id>` 是集播放页, 不在此列(属播放器, 不做美化)。 */
export function isDetailPage(): boolean {
  const _href = location.href.split(/[?#]/)[0];
  return /\/v\/(tv|movie)\/[a-f0-9]{32}($|\/)/.test(_href)
    || /\/v\/(tv|movie)\/season\/[a-f0-9]{32}/.test(_href);
}

/** [lc-980] 精准三闸之②③：定位「当前活跃详情视图」——
 *  DOM 末尾、真实可见(offsetParent!==null)、且内部渲染出 hero(h-[470px])的那个 `.trim-ui__cache-outlet--exclude`。
 *  首页活跃视图内没有 470px hero → 返回 null → 永不误判(根治旧版 [data-id="details"] 首页误命中)。 */
export function findActiveDetailView(): HTMLElement | null {
  const views = document.querySelectorAll<HTMLElement>(ACTIVE_VIEW_SEL);
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i];
    if (v.offsetParent !== null && v.querySelector(DETAIL_HERO_SEL)) return v;
  }
  return null;
}

/** [lc-980] 在活跃视图内取 hero 元素(470px 顶部区, 含背景剧照 + 海报 + 信息)。 */
export function findDetailHero(view: HTMLElement): HTMLElement | null {
  return view.querySelector<HTMLElement>(DETAIL_HERO_SEL);
}

/** [lc-980] hero 内的全屏背景剧照 img(`img.size-full.object-cover`, fnOS 已加载, 复用无新网络请求)。 */
export function findHeroBackdropImg(hero: HTMLElement): HTMLImageElement | null {
  const img = hero.querySelector<HTMLImageElement>('img.size-full');
  if (img && (img.currentSrc || img.src)) return img;
  // 兜底：hero 内最大的那张图即背景剧照(470px 高 > 海报 320px)
  const imgs = Array.from(hero.querySelectorAll('img'))
    .filter((im) => im.currentSrc || im.src)
    .sort((a, b) => (b.offsetHeight || 0) - (a.offsetHeight || 0));
  return imgs[0] || null;
}
