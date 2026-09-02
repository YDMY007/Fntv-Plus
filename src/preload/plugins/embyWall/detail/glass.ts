// embyWall/detail/glass.ts — 详情页公共工具
// 详情页美化(液态玻璃/全屏底图/两栏布局/瞬间加载层)已于 lc-979 整体移除, 待重写。
// 本文件仅保留被其它模块(轮播 logo、亮度采样、设置面板)复用的纯 URL 判定工具。

/** 检测当前 URL 是否为详情页(tv/movie/season)。
 *  [lc-963] 先剥离 ?query/#fragment 再匹配, 兼容带参数的深链/分享链接(如 /v/tv/<id>?autoplay=1)。 */
export function isDetailPage(): boolean {
  const _href = location.href.split(/[?#]/)[0];
  return /\/v\/(tv|movie)\/[a-f0-9]{32}($|\/)/.test(_href)
    || /\/v\/(tv|movie)\/season\/[a-f0-9]{32}/.test(_href);
}
