// embyWall/detail/glass.ts — 详情页公共工具（精准触发判定）
// 详情页美化于 lc-980 重写：CSS 优先、零节点搬运、精准三闸触发。
// 本文件只提供「判定 / 定位」的纯查询工具，供 immersive.ts 编排层与轮播 logo、亮度采样复用。

/** hero 精准选择器。**三种详情页 hero 的类名互不相同**（lc-993 从 NAS 的 JS 产物逐个挖出，非推测）：
 *  · Season 二级页 `/v/tv|movie/season/<id>`（组件 `de`）：
 *      `semi-always-dark relative box-border flex h-[470px] w-full justify-between gap-10 bg-[var(--semi-color-bg-1)] px-[46px]`
 *  · Movie 一级页（组件 `Q`，isVideo 分支）：同上但**高度是条件式**——
 *      `isLandscapePoster ? 'min-h-[390px]' : 'h-[470px]'`（横版海报时没有 h-[470px]）
 *  · Series 一级页 `/v/tv|movie/<id>`（组件 `Zse`，非 isVideo 分支）：
 *      `trim-mc__details--key-version semi-always-dark relative left-0 top-0 box-border w-full bg-[var(--semi-color-bg-1)] px-[46px]`
 *      **一个 Tailwind 高度类都没有** —— 高度来自 CSS 类 `.trim-mc__details--key-version`
 *      （560px；≤1024→576px、1025-1280→470px、1281-1920→48vh、≥1920→700px）。
 *  ∴ 旧写法 `.semi-always-dark[class*="h-[470px]"]` 对 Series 一级页**结构性永不匹配**，
 *    该页美化从 lc-980 起就一次都没真正套用过（真机日志：4/4 从首页进入全部失败并打出
 *    「observer 超 4000ms 未见 hero, 自断」；3/3 从 season 页进入却在 17-21ms「套用完成」——
 *    那 3 次命中的是视图栈里残留的 season hero，React 不可能在 20ms 内渲染出新页）。
 *  `trim-mc__details--key-version` 作为 Series 锚点是干净的：全部 65 个 JS chunk 里只出现 **1 次**。
 *  ⚠ 用 `:is()` 包裹而不是裸逗号列表：beautifyStyle.ts 会把它拼进
 *    `body.fnos-beautify ${HERO} img[...]` 这类规则，裸列表的逗号会把规则后半截劈成独立选择器。
 *    `:is()` 的特异性取参数里最高者 = (0,2,0)，与旧的 `.semi-always-dark[class*=...]` 完全相同。
 *  ⚠ `.semi-always-dark` 全文档另有 4 个 36×36 小图标实例（登录页还有 1 个 h-screen 容器），
 *    故必须叠特征类，绝不能只用 `.semi-always-dark`。 */
export const DETAIL_HERO_SEL = ':is('
  + '.semi-always-dark[class*="h-[470px]"],'          // Season 二级页 / 竖版海报 Movie 一级页
  + '.semi-always-dark[class*="min-h-[390px]"],'      // 横版海报 Movie 一级页
  + '.trim-mc__details--key-version'                  // Series 一级页（无 Tailwind 高度类）
  + ')';
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
 *  DOM 末尾、真实可见(offsetParent!==null)、且内部渲染出 hero 的那个 `.trim-ui__cache-outlet--exclude`。
 *  首页活跃视图内没有详情 hero → 返回 null → 永不误判(根治旧版 [data-id="details"] 首页误命中)。
 *  ⚠ 从末尾往前遍历 + 要求 offsetParent!==null 是**唯一**能排除视图栈残留页的手段：
 *    fnOS 的 cache-outlet 切页后旧视图不从 DOM 移除，只切 --exclude/--cache 类。 */
export function findActiveDetailView(): HTMLElement | null {
  const views = document.querySelectorAll<HTMLElement>(ACTIVE_VIEW_SEL);
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i];
    if (v.offsetParent !== null && v.querySelector(DETAIL_HERO_SEL)) return v;
  }
  return null;
}

/** [lc-980] 在活跃视图内取 hero 元素(顶部区, 含背景剧照 + 海报/标题)。
 *  高度按页型不同：Season/竖版 Movie 固定 470px；横版 Movie min-height 390px；
 *  Series 一级页由 CSS 类给 560px(≤1024→576、1025-1280→470、1281-1920→48vh、≥1920→700)。 */
export function findDetailHero(view: HTMLElement): HTMLElement | null {
  return view.querySelector<HTMLElement>(DETAIL_HERO_SEL);
}

/** [lc-980] hero 内的全屏背景剧照 img(fnOS 已加载, 复用无新网络请求)。
 *  三种 hero 都命中 `img.size-full`：Season/Movie 是 `pointer-events-none size-full object-cover`，
 *  Series 一级页是组件 `TD` 渲染的 `pointer-events-none size-full object-cover object-center`。
 *  ⚠ Series 一级页的 hero 内**没有海报 img**（海报组件 `Xse` 只在 Season/Movie 分支渲染），
 *    所以兜底的「取最大图」在那页只会拿到背景剧照本身，行为正确。 */
export function findHeroBackdropImg(hero: HTMLElement): HTMLImageElement | null {
  const img = hero.querySelector<HTMLImageElement>('img.size-full');
  if (img && (img.currentSrc || img.src)) return img;
  // 兜底：hero 内最大的那张图即背景剧照(占满 hero 高 > 海报 320px)
  const imgs = Array.from(hero.querySelectorAll('img'))
    .filter((im) => im.currentSrc || im.src)
    .sort((a, b) => (b.offsetHeight || 0) - (a.offsetHeight || 0));
  return imgs[0] || null;
}
