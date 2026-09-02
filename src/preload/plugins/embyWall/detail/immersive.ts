import { S } from '../state';
import { applySeasonImmersiveDetail, resetSeasonObsState, unlayoutSeasonTwoPane } from './season';
import { dlog, log } from '../log';
import { ensureFullscreenBackdrop, hideInstantLoadingLayer, isDetailPage, removeFullscreenBackdrop, showInstantLoadingLayer, _detailViewExclusive } from './glass';

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

/** [lc-958] 详情页内容是否已渲染: 用于防御「空白页被刷成白屏」。
 *  集卡片([data-id="details"])/季卡片(.card-root)/演员链接(person)任一存在即视为内容已就绪;
 *  .fnos-season-2col 存在说明两栏已建(内容必然曾就绪)。
 *  仅当内容就绪才套沉浸式(全屏底图 + 整页背景透明化); 否则 fnOS SPA 首帧空白会被
 *  ensureFullscreenBackdrop 的浅色 scrim + ensureDetailBackdropTransparency 刷成纯白。 */
function detailContentRendered(): boolean {
  return !!document.querySelector('[data-id="details"]')
    || !!document.querySelector('.card-root')
    || !!document.querySelector('a[href*="/v/person/"]')
    || !!document.querySelector('.fnos-season-2col');
}

/** [lc-960] 详情页空白自愈: 若详情页 DOM 长时间(3.5s)仍未渲染任何内容, 多半是 fnOS SPA 进入「半死状态」
 *   (与 lc-944 轮播 spaNav 兜底同款), 整页重载一次救活。每 href 最多自愈一次(sessionStorage 跨重载计数, 防循环);
 *   若重载后仍空白(如续看项 id 非有效季 id), 放弃, 交由 fnOS 原生空态, 本项目不再刷白(lc-958)。
 *   正常导航内容均在 <3.5s 内渲染, 不会误触发。 */
let _recoverScheduledFor: string | null = null;
let _recoverTimer = 0;
function scheduleDetailRenderRecovery(): void {
  const href = location.href;
  if (_recoverScheduledFor === href) return; // 已为该 href 排过定时器, 不重复排(防 MutationObserver 每次重置)
  _recoverScheduledFor = href;
  clearTimeout(_recoverTimer);
  _recoverTimer = window.setTimeout(() => {
    if (!detailContentRendered() && isDetailPage() && !document.querySelector('video')) {
      const key = 'fntvRecover:' + href;
      let n = 0;
      try { n = parseInt(sessionStorage.getItem(key) || '0', 10); } catch (_) { /* ignore */ }
      if (n >= 1) { clearTimeout(_recoverTimer); _recoverScheduledFor = null; dlog('applyDetailLiquidGlass: [lc-960] 该 href 已自愈过仍空白, 放弃: ' + href); return; }
      try { sessionStorage.setItem(key, '1'); } catch (_) { /* ignore */ }
      dlog('applyDetailLiquidGlass: [lc-960] 详情页 3.5s 仍空白, 整页重载自愈: ' + href);
      location.href = href;
    }
  }, 3500);
}

/** 统一入口: 检测URL→分发到对应页面的液态玻璃函数 */
/** [lc-914] applyDetailLiquidGlass 入口日志节流时间戳(本函数被 _detailObs 以 200ms 防抖持续调用) */
let _lastEntryLogTs = 0;
/** [lc-972] 当前 href 是否已稳定套用沉浸式(内容已渲染)。一旦置位, 后续 tick 早退, 停止每 200ms 重型重套,
 *  根治 lc-969 引入的"详情页疯狂闪烁/卡顿"(applySeasonImmersiveDetail 内含 dumpSeasonDOMToFile 整页 DOM 序列化写文件,
 *  每 tick 重跑把主线程打满)。切换 href 时由下方重置。 */
let _glassSettledForHref: string | null = null;
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
  if (location.href !== S.lastDetailHref) { S.lastDetailHref = location.href; resetSeasonObsState(); _glassSettledForHref = null; }
  // [lc-878] 非详情页(首页/系统页): 必须无条件移除 fnos-immersive-season。
  //   原逻辑中 S.detailGlassInited=true 时在首页找不到 .trim-mc__details--key-version 直接 return,
  //   导致 class 残留污染"继续观看"/"剧集列表"等区块 —— 故非详情页优先移除。
  if (!isDetailPage()) {
    dlog('applyDetailLiquidGlass: 非详情页 → 移除 fnos-immersive-season 并 return');
    document.body.classList.remove('fnos-immersive-season');
    unlayoutSeasonTwoPane(); // [lc-884] 清理注入的 .fnos-ep-meta(含"高清"badge), 防泄漏到首页
    S.detailGlassInited = false; // 重置, 下次进详情页重新初始化
    removeFullscreenBackdrop(); // [lc-879] 离开详情页清理全屏底图
    clearTimeout(_recoverTimer); _recoverScheduledFor = null; // [lc-964] 离开时清理挂起的空白自愈定时器(防残留定时器 + 该 href 自愈被禁用)
    return;
  }

  // [lc-972] 已为该 href 稳定套用(内容已渲染)→ 跳过沉重的每 tick 重套, 回到 lc-969 前"内容就绪即停"的轻量行为。
  //   根因: lc-969 让本函数每 200ms observer tick 都跑 applySeasonImmersiveDetail + ensureFullscreenBackdrop,
  //   而 applySeasonImmersiveDetail 内部又会排 6 个 dumpSeasonDOMToFile(整页 DOM 序列化写文件)定时器 →
  //   主线程被持续打满 → 进详情页后疯狂卡顿/闪烁。这里内容一渲染就停重套(两栏由 observeSeasonTwoPane 自己维护),
  //   仅在内容未渲染期(进页+首页隐藏+两栏建立)持续重套, 切换 href 自动重置。boxless 走原生外观、每 tick 便宜, 不早退。
  if (!S.detailBoxless && _glassSettledForHref === location.href) {
    clearTimeout(_recoverTimer); _recoverScheduledFor = null; // [lc-964] 离开空白页后清理挂起自愈定时器
    hideInstantLoadingLayer(); // [lc-971] 内容已就绪, 确保加载层已淡出(幂等, 无操作则 no-op)
    S.detailGlassInited = true;
    return;
  }

  // [lc-971] 进详情页瞬间铺「缓存海报 + 骨架屏」加载层, 盖住 fnOS 原生 2-3s 白屏, 实现秒出。
  //   仅非 boxless(用户未关闭沉浸式)时铺; boxless 走原生外观, 不叠加本项目加载层。
  if (!S.detailBoxless) showInstantLoadingLayer();

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
  // [lc-958] 白屏修复: 详情页 DOM 尚未渲染出任何内容时, 绝不套沉浸式。
  //   原因: ensureFullscreenBackdrop 在浅色主题下铺白色渐变 scrim(z-index:-1), 且 ensureDetailBackdropTransparency
  //   把 body.fnos-detail-backdrop * 背景全部清透明 → 空白页会透出白色 scrim = 纯白屏
  //   (「继续观看」等 fnOS 原生卡片走 SPA, 首帧常为空白, 表现为「点卡→白屏进不去对应详情页」)。
  //   等 fnOS 把内容渲染出来后, 下方重试链(初始化 [600,1500,3000] / _scheduleDetailGlass / MutationObserver 200ms 防抖)会再触发本函数并正常套用。
  // [lc-969] 提前套用沉浸式, 消除「先原生页、过会闪烁成自定义页」:
  //   进入详情页立即挂 fnos-immersive-season + 透明导航 + 全屏底图。底图在「无海报(首帧/半死)」时
  //   由 ensureFullscreenBackdrop 铺中性占位(非白)遮住 fnOS 原生背景, 故 fnOS 原生页基本不会被看到 → 无闪烁;
  //   白屏根因(lc-958)已隔离在 ensureFullscreenBackdrop 内: 无海报只建中性占位、不建白 scrim。
  //   两栏布局(layoutSeasonTwoPane)内部仍按 [data-id=details] 内容判定补建, 内容未就绪时会自行重试。
  if (S.detailBoxless) {
    applySeasonImmersiveDetail(); // 内部移除 fnos-immersive-season + 还原两栏(恢复 fnOS 原生外观)
    removeFullscreenBackdrop();
  } else {
    // [lc-976] 详情视图尚未独占(来源页/首页仍与详情视图并存于 fnOS 视图栈, SPA 过渡期)时, 绝不套沉浸式:
    //   applySeasonImmersiveDetail 会给 body 挂 fnos-immersive-season 并 layoutSeasonTwoPane 搬运/重排 DOM,
    //   套到"仍挂载的旧页面"上 → 用户看到的「点卡片后当前页排版错乱成详情页样式」; 且这套重活(多次全文档
    //   querySelectorAll + getComputedStyle + DOM 搬移)被 _detailObs 每个 200ms tick + 60/400/1000/2000ms 重试链
    //   反复触发, 在 fnOS 拉数据的 2-3s 内持续打满主线程 → 「要点两次才进、进详情页非常卡顿」。
    //   此刻 lc-971 的瞬间加载层已盖住屏幕(秒出观感保留), 直接早退不碰 DOM;
    //   hideStaleViews(400ms)把旧视图 display:none 后会立即重跑本函数(embyWall.ts), 届时详情独占 → 一次性套用。
    if (!_detailViewExclusive()) {
      dlog('applyDetailLiquidGlass: [lc-976] 详情视图未独占(旧页仍挂载), 跳过沉浸式套用, 等 hideStaleViews 后重跑');
      S.detailGlassInited = true;
      return;
    }
    applySeasonImmersiveDetail();
    applyDetailNavImmersive();   // 导航栏统一沉浸(全透明), 让全屏底图在顶部完整透出
    ensureFullscreenBackdrop();  // 无海报→中性占位; 有海报→真实模糊底图 + 主题 scrim
  }
  // 空白(内容未渲染)才排自愈; 正常页内容已渲染则取消挂起的自愈定时器(lc-961, 防离开空白页后误整页重载)
  if (detailContentRendered()) {
    clearTimeout(_recoverTimer);
    _recoverScheduledFor = null;
    hideInstantLoadingLayer(); // [lc-971] 内容就绪 → 淡出瞬间加载层, 露出真实沉浸式页
    _glassSettledForHref = location.href; // [lc-972] 标记本 href 已稳定套用, 后续 tick 早退, 避免每 tick 重套闪烁
  } else {
    scheduleDetailRenderRecovery(); // [lc-960] 空白超时自愈(仅空白触发, 防循环)
  }
  S.detailGlassInited = true;
  log('detail liquid glass applied for', location.href.substring(location.href.lastIndexOf('/v/')));
}

/** [v400] UI 主题: 浅色 / 深色 / 跟随系统 三态, 持久化到 localStorage, 并同步飞牛原生主题.
 *  用 CSS 变量(--fnos-ui-*) 驱动所有自建设备 UI, html.dark 类切换即整体换肤(含已打开面板实时生效). */