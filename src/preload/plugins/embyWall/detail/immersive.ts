import { S } from '../state';
import { applySeasonImmersiveDetail, resetSeasonObsState, unlayoutSeasonTwoPane } from './season';
import { dlog, log } from '../log';
import { ensureFullscreenBackdrop, isDetailPage, removeFullscreenBackdrop } from './glass';

// embyWall/detail/immersive.ts — 详情页沉浸式编排：导航沉浸式 + 液态玻璃总入口（组合 glass 与 season 两侧能力）
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

function applyDetailNavImmersive(): void {
  const nativeNav = document.querySelector('div.relative.z-20.flex.items-center.justify-between.px-11.py-5') as HTMLElement | null;
  if (!nativeNav) return;
  nativeNav.style.setProperty('background', 'transparent', 'important');
  nativeNav.style.setProperty('backdrop-filter', 'none', 'important');
  nativeNav.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
  nativeNav.style.setProperty('box-shadow', 'none', 'important');
  nativeNav.style.setProperty('border', 'none', 'important');
}

/** 统一入口: 检测URL→分发到对应页面的液态玻璃函数 */
/** [lc-914] applyDetailLiquidGlass 入口日志节流时间戳(本函数被 _detailObs 以 200ms 防抖持续调用) */
let _lastEntryLogTs = 0;
export function applyDetailLiquidGlass(): void {
  // [lc-914] 上游入口诊断: 确认本函数是否被调用、isDetailPage() 判定结果(排查"两栏为何没建"必须先查上游)
  //   ⚠️ 本函数被 200ms 防抖观察器持续调用 → 入口日志必须节流(2s 一次或换页时), 否则 CMD 被刷爆
  const _now = Date.now();
  const _has2col = !!document.querySelector('.fnos-season-2col');
  if (_now - _lastEntryLogTs > 2000 || !_has2col) {
    _lastEntryLogTs = _now;
    dlog('applyDetailLiquidGlass: === 入口 === pathname=' + location.pathname
      + ' isDetailPage=' + isDetailPage() + ' S.detailGlassInited=' + S.detailGlassInited
      + ' S.detailBoxless=' + S.detailBoxless + ' 已有2col=' + _has2col);
  }
  // [lc-906] 换页(含 season→season 直接切换)时重置季页 observer 稳态/年份缓存, 保证新页面重新灵敏处理
  if (location.href !== S.lastDetailHref) { S.lastDetailHref = location.href; resetSeasonObsState(); }
  // [lc-878] 非详情页(首页/系统页): 必须无条件移除 fnos-immersive-season。
  //   原逻辑中 S.detailGlassInited=true 时在首页找不到 .trim-mc__details--key-version 直接 return,
  //   导致 class 残留污染"继续观看"/"剧集列表"等区块 —— 故非详情页优先移除。
  if (!isDetailPage()) {
    dlog('applyDetailLiquidGlass: 非详情页 → 移除 fnos-immersive-season 并 return');
    document.body.classList.remove('fnos-immersive-season');
    unlayoutSeasonTwoPane(); // [lc-884] 清理注入的 .fnos-ep-meta(含"高清"badge), 防泄漏到首页
    S.detailGlassInited = false; // 重置, 下次进详情页重新初始化
    removeFullscreenBackdrop(); // [lc-879] 离开详情页清理全屏底图
    return;
  }

  // [lc-909] 已移除旧的「TV详情页只做一次」早退守卫(S.detailGlassInited && !/season/)。
  //   该守卫是给已被停用的 applyTvDetailGlass 设计的, lc-907 统一视觉后成为致命 bug:
  //   二级页 URL 不含 '/season/' → 一旦 DOM 尚未渲染出 .trim-mc__details--key-version(SPA 异步渲染,
  //   或刚从季页导航过来 S.detailGlassInited 已为 true)就整轮 return → applySeasonImmersiveDetail
  //   永不执行 → 两栏永不建立, 表现为"选集占满整宽、右侧信息栏缺失"。
  //   而 _detailObs 以 200ms 防抖反复调用本函数, 只要该守卫存在, 每次都会被同样的条件挡回。

  // [lc-907] 所有二级详情页统一为「第一种」视觉(即首页轮播「查看详情」进入的那套):
  //   此前 season 三级页走 applySeasonImmersiveDetail(沉浸式两栏), tv/movie 二级页走 applyTvDetailGlass
  //   (全屏底图 + 头部/卡片/按钮玻璃化), 两套并存 → 从不同入口进入同一部剧样式不一致。
  //   现统一走 applySeasonImmersiveDetail(原生顶部「左竖屏海报+右信息栏」+ 主内容/侧栏两栏),
  //   并统一启用 ensureFullscreenBackdrop —— 保留原本只属于 tv/movie 页的全屏模糊海报底图与大渐变遮罩。
  applySeasonImmersiveDetail();
  // [lc-907] 「关闭背景框」开关: 开启(恢复 fnOS 原生外观)时不铺全屏底图、不动导航栏, 与季页原逻辑一致
  if (S.detailBoxless) {
    removeFullscreenBackdrop();
  } else {
    applyDetailNavImmersive();  // 导航栏统一沉浸(全透明), 让全屏底图在顶部完整透出
    ensureFullscreenBackdrop(); // 恢复季页全屏底图(lc-894 曾禁用), 使两种页面背景观感一致
  }
  S.detailGlassInited = true;
  log('detail liquid glass applied for', location.href.substring(location.href.lastIndexOf('/v/')));
}

/** [v400] UI 主题: 浅色 / 深色 / 跟随系统 三态, 持久化到 localStorage, 并同步飞牛原生主题.
 *  用 CSS 变量(--fnos-ui-*) 驱动所有自建设备 UI, html.dark 类切换即整体换肤(含已打开面板实时生效). */