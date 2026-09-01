import { resolveSeasonHref } from './href';

import { S } from '../state';
import { applyTitleLogo, swapTitleToLogo } from './logo';
import { autoFetchDescs, buildLoadingPlaceholder, buildStrmUnsupportedTip } from './progress';
import { buildCarouselStyle2, buildCarouselStyle3, buildCarouselStyle4 } from './styles';
import { fetchImageAuth } from './images';
import { ipcRenderer } from 'electron';
import { log } from '../log';

// embyWall/carousel/render.ts — 轮播渲染：injectCarousel 主体、媒体库定位、销毁/恢复、季链接解析
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export function destroyCarousel(): void {
  if (S.carouselCleanup) {
    try { S.carouselCleanup(); } catch { /* ignore */ }
    S.carouselCleanup = null;
  }
  // [lc-946] 注意: 此处不置空 S.carouselResume。离开首页(_stopCarouselOffHome→destroyCarousel)后,
  //   返回首页需靠它重启自动轮播; 该闭包自带 document.body.contains(container) 守卫, 指向已游离轮播时自动 no-op, 保留安全。
}

/** [lc-946] 轮播仍健康(挂载+已初始化)时返回首页: 不销毁重建 DOM, 仅重启被 _stopCarouselOffHome 停掉的自动轮播,
 *  避免"返回首页轮播重载 + 海报闪烁/丢失"。钩子由各 buildCarouselStyleX 在创建 timer 时注册到 S.carouselResume。 */
export function resumeCarousel(): void {
  if (!(S.carouselContainer && document.body.contains(S.carouselContainer))) return;
  if (S.carouselResume) { try { S.carouselResume(); } catch (e) { log('[lc-946] resumeCarousel error: ' + String(e).substring(0, 80)); } }
}


// [B 项] 健壮查找"媒体库"section: 原逻辑写死 Tailwind 类名(.relative.flex.flex-col.gap-6 > div)
// 且要求 strong 含"媒体库", 一旦目标 fnOS 布局的 class/文案不同就 sections found:0 → no target(轮播缺失)。
// 这里做多级兜底, 尽量在各类布局/语言下都能定位到正确的媒体库区块。
export function findMediaLibrarySection(): HTMLElement | null {
  // [lc-183] 兜底: 弹窗打开时绝不把弹窗内的"媒体库"当目标(弹窗守卫已在 injectCarousel 拦截, 此处双保险)
  if (isModalOpen()) return null;
  const labelRe = /媒体库|片库|影视库|library|my\s*media/i;
  // 1) 原已知布局: .relative.flex.flex-col.gap-6 的直接子 div 且含媒体库标题
  const known = document.querySelectorAll('.relative.flex.flex-col.gap-6 > div');
  for (const s of Array.from(known) as HTMLElement[]) {
    const strong = s.querySelector('strong');
    if (strong && labelRe.test(strong.textContent || '')) return s;
  }
  // 2) 宽匹配: 含 flex-col 的容器, 且内部标题含媒体库字样(确保定位到区块级)
  const flexCols = document.querySelectorAll('div[class*="flex-col"]');
  for (const s of Array.from(flexCols) as HTMLElement[]) {
    const head = s.querySelector('strong,h2,h3');
    if (head && labelRe.test(head.textContent || '')) return s;
  }
  // 3) 终极兜底: 找媒体库标题, 向上取到含子节点且具布局类的祖先作为 section
  const heads = document.querySelectorAll('strong,h2,h3');
  for (const h of Array.from(heads) as HTMLElement[]) {
    if (!labelRe.test(h.textContent || '')) continue;
    let el: HTMLElement | null = h.parentElement;
    while (el && el !== document.body && el.parentElement) {
      const cls = (el.className || '') as string;
      if (el.children.length >= 1 && /flex|grid|relative|section/i.test(cls)) return el;
      el = el.parentElement;
    }
  }
  return null;
}

// [lc-808] 「继续观看」模块不再做特殊下移处理，保持与样式 1 一致的普通位置展示。
//   （原 findResumeSection/pushResumeDown/restoreResume 逻辑已移除。）

// [lc-183] 判断当前是否有 fnOS 弹窗/对话框打开。
// 这些弹窗是 SPA 模态框(打开时 URL 仍是 /v, lc-182 路径守卫拦不住),
// 且弹窗内(如"创建媒体库"标题)也含"媒体库"文字 → findMediaLibrarySection 会误匹配到弹窗内部
// → target.innerHTML='' 把弹窗内容(含确认/确定/选择按钮)整个清空 → 按钮"消失"。
// 因此: 只要页面上有任意弹窗, 一律不注入轮播(弹窗关闭后 Observer 会自然重新触发注入)。
export function isModalOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"], .semi-modal-mask, .semi-modal-wrapper, .semi-modal, [aria-modal="true"]'
  );
}

/** 轮播「最近更新」标签内的日期: M/D（不带时间） */
function fmtCarouselUpdated(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
// ===== resolveSeasonHref 已迁移到 ./href.ts（打断 render ↔ styles 循环依赖） =====

export function injectCarousel(): void {
  log('injectCarousel called, S.carouselInited=', S.carouselInited, 'S.apiShows.length=', S.apiShows.length);
  if (S.carouselInited) return;

  // [lc-876] 重建前先销毁旧轮播的 timer/event listener，防止泄漏导致返回后乱套
  destroyCarousel();

  // [lc-182] 路径守卫: 轮播仅注入首页(/v 或 /v/)。
  const p = location.pathname;
  if (p !== '/v' && p !== '/v/') {
    return; // 静默跳过, 不打日志(避免非首页页面刷屏)
  }

  // [lc-183] 弹窗守卫: 任意 fnOS 弹窗打开时绝不注入(弹窗内"媒体库"文字会误导匹配)。
  if (isModalOpen()) {
    return; // 弹窗关闭后 DOM 变化会触发 Observer 重新注入
  }

  // 找"媒体库"section: 首屏用DOM搜索, 重建复用已有wrapper的parent(避免wrapper嵌套)
  let target: HTMLElement | null = null;
  let rebuild = false;
  if (S.carouselWrapper && document.body.contains(S.carouselWrapper)) {
    target = S.carouselWrapper.parentElement; // section
    rebuild = true;
    log('rebuild: reusing section(parent of existing wrapper)');
  } else {
    target = findMediaLibrarySection();
    if (target) log('media-library section found via robust search');
  }
  if (!target) { log('no target'); return; }
  log('target found on', location.href, rebuild ? '(rebuild)' : '(first)');

  // [lc-773] 轮播行动按钮样式（Apple 风格）只注入一次。
  //   伪类(:hover/:active/:focus-visible)与 @media 无法写进内联 style，故用注入的 <style> 统一声明，
  //   HTML 只留 class，JS 不再用 mouseenter/mouseleave 模拟悬停。
  if (!document.getElementById('fnos-hero-action-style')) {
    const actSt = document.createElement('style');
    actSt.id = 'fnos-hero-action-style';
    actSt.textContent = `
/* 每行只有一个主 CTA(开始观看)；次要动作(More)以「更低的填充层级」从属，不靠 opacity 压暗文字 */
.fnos-action{display:flex;align-items:center;gap:12px;padding-top:6px;flex-shrink:0;margin-top:auto}
.fnos-play,.fnos-more{
  position:relative;overflow:hidden;isolation:isolate;   /* 流光裁切在胶囊内 + 独立层叠 */
  display:inline-flex;align-items:center;justify-content:center;
  box-sizing:border-box;min-height:48px;            /* ≥44pt 触控区 */
  border:none;                                        /* 无描边 */
  border-radius:999px;                               /* 胶囊形 */
  text-decoration:none;white-space:nowrap;cursor:pointer;
  -webkit-user-select:none;user-select:none;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;  /* 去点击闪蓝 / 300ms 延迟 */
  transition:transform .22s cubic-bezier(.2,.8,.3,1),background-color .22s ease,opacity .18s ease;
}
/* 流光：常驻于胶囊内，hover 时从左扫到右（无描边、无阴影） */
.fnos-play::before,.fnos-more::before{
  content:'';position:absolute;top:0;left:-75%;width:50%;height:100%;
  background:linear-gradient(115deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,.22) 50%,
    rgba(255,255,255,0) 100%);
  transform:skewX(-18deg);
  transition:left .75s cubic-bezier(.25,.8,.4,1);
  z-index:-1;pointer-events:none;
}
.fnos-play:hover::before,.fnos-more:hover::before{left:130%}
.fnos-play{
  gap:10px;padding:0 30px;
  background:var(--fnos-hero-play-bg);
  color:var(--fnos-hero-play-text);
  font-size:16px;font-weight:600;letter-spacing:.3px;   /* 中文不用大字距 */
  backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);
}
.fnos-play:hover{transform:translateY(-1px);background:var(--fnos-hero-play-hover)}
.fnos-more{
  gap:6px;padding:0 20px;
  background:rgba(255,255,255,.10);
  color:var(--fnos-hero-desc);
  font-size:15px;font-weight:600;letter-spacing:.3px;
  backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);
}
.fnos-more:hover{transform:translateY(-1px);background:rgba(255,255,255,.17)}
.fnos-play:active,.fnos-more:active{transform:scale(.97)}   /* 按压反馈 */
.fnos-play:focus-visible,.fnos-more:focus-visible{outline:2px solid var(--fnos-ui-accent,#8f6fe8);outline-offset:3px}
.fnos-more.is-loading{opacity:.6;pointer-events:none}        /* 解析季路由时的加载态 */
.fnos-play.is-loading{opacity:.6;pointer-events:none}         /* [lc-900] PLAY 也走二级路由, 解析时加载态 */
@media (prefers-reduced-motion: reduce){                     /* 尊重系统「减弱动态效果」 */
  .fnos-play,.fnos-more{transition:background-color .15s ease}
  .fnos-play:hover,.fnos-more:hover,.fnos-play:active,.fnos-more:active{transform:none}
  .fnos-play::before,.fnos-more::before,.fnos-play:hover::before,.fnos-more:hover::before{transition:none;left:-75%}
}
`;
    (document.head || document.documentElement).appendChild(actSt);
  }

  // 预加载占位: 真实片库「仍在加载中」时, 显示优雅占位(骨架 + 加载进度数字), 不让用户干等
  // 注意: 此处不设 S.carouselInited=true, 让数据到位后 injectCarousel() 能重新进入并重建真实轮播
  if (S.apiShows.length === 0) {
    // [lc-768] 拉取已完成但可用海报为 0(全是 STR/网盘且加载不到) → 主页提示而非骨架死等
    if (S.carouselLoadedButNone) {
      if (!S.placeholderInited) {
        log('all candidates unloadable(STR/网盘), showing 暂未支持STRM海报 tip');
        buildStrmUnsupportedTip(target);
        S.placeholderInited = true;
      }
      return;
    }
    // [lc-561] 显示骨架占位(带"已加载 N 个"数字)。S.placeholderInited 守卫: 占位只构建一次,
    // 避免 MutationObserver 反复触发 injectCarousel → 反复清空重建占位 → 死循环(见 lc-100)。
    // 数据到位后 injectCarousel 会清空 section 并重建为真实轮播(占位自然被替换)。
    if (!S.placeholderInited) {
      log('api not ready, building loading skeleton with progress count');
      buildLoadingPlaceholder(target);
      S.placeholderInited = true;
    }
    return;
  }
  // 真实数据到达: 复位占位守卫, 以便将来数据清空时可再次显示占位
  S.placeholderInited = false;
  S.carouselProgressEl = null; // 占位已替换, 数字元素失效

  S.carouselInited = true; // 仅在真实数据注入后才标记(避免 loading 占位锁死重建)
  S.carouselUpdatedAt = Date.now(); // 记录"最近更新"板块数据就绪时刻, 供标题旁更新时间显示
  log('carousel data ready at', new Date(S.carouselUpdatedAt).toLocaleString('zh-CN'));

  // 数据: 只用真实片库(前面 895 行已拦截 S.apiShows.length===0 的空数据, 走到这里必有数据)
  // 注意: 绝不回退硬编码 demo(用户明确要求不用硬编码)。
  const shows = S.apiShows;
  log('injecting', shows.length, 'shows (api:', S.apiShows.length, ')');

  const base = location.origin;
  let currentIdx = 0;
  const infos: HTMLElement[] = [];

  // 统一容器: 重建时复用已有wrapper(保留padding:0 44px), 避免嵌套叠加导致宽度变宽
  let wrapper: HTMLElement;
  if (rebuild && S.carouselWrapper) {
    wrapper = S.carouselWrapper;
    wrapper.innerHTML = ''; // 清空旧container(我们自己的节点, 不影响飞牛DOM), 内部重建
  } else {
    target.innerHTML = ''; // 首屏清空section原内容(媒体库标题+卡片)
    // [lc-444] 清掉飞牛section自身顶部边框/阴影/上边距, 避免与顶部导航栏之间出现细黑线
    target.style.borderTop = 'none';
    target.style.boxShadow = 'none';
    target.style.marginTop = '0';
    target.style.background = 'transparent';
    wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:0';
    S.carouselWrapper = wrapper;
  }
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:var(--fnos-hero-container);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);margin:0 auto;box-shadow:none';
  // [lc-780→lc-856] 轮播图样式开关：默认样式 4（立体堆叠）；1=竖向轮播 2=横向轮播 3=堆叠切换 4=立体堆叠，用户可在设置面板"外观"切换。
  //   样式通过 [data-fntv-carousel-style="1|2|3|4"] 区分（CSS 或 JS 分支）。
  const _cs = ((): number => { const v = parseInt(localStorage.getItem('fnos-carousel-style') || '4', 10); return (v >= 1 && v <= 4) ? v : 4; })();
  container.setAttribute('data-fntv-carousel-style', String(_cs));
  // [lc-582] 加载完成后淡入, 不再"直接闪出全部"(骨架→轮播平滑过渡)
  container.style.opacity = '0';
  container.style.transition = 'opacity .45s ease';
  wrapper.appendChild(container);
  S.carouselContainer = container;
  requestAnimationFrame(() => { container.style.opacity = '1'; });

  // [lc-781] 样式 2（滑动切换 + 进度条）：早期分支，复用已建好的 container/wrapper，
  //   跳过下方样式 1 的 track / posterStrip / 竖向轮播逻辑，改走 buildCarouselStyle2。
  if (_cs === 2) {
    buildCarouselStyle2(container, wrapper, shows, base, rebuild);
    if (!rebuild) target.appendChild(wrapper);
    return;
  }

  // [lc-809] 样式 3（堆叠卡片）：照抄 demo 的堆叠卡片交互方式，复用真实片库数据与导航。
  if (_cs === 3) {
    buildCarouselStyle3(container, wrapper, shows, base, rebuild);
    if (!rebuild) target.appendChild(wrapper);
    return;
  }

  // [lc-822] 样式 4（3D 旋转木马）：透视 + rotateY 侧卡，借鉴 demo 的 3D 轮播交互。
  if (_cs === 4) {
    buildCarouselStyle4(container, wrapper, shows, base, rebuild);
    if (!rebuild) target.appendChild(wrapper);
    return;
  }

  // [lc-442] wrapper 改为 flex 并排：左轮播容器 + 右侧独立海报条容器
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'row';   // [lc-784] 重置：若此前是样式 2 的 column，切回样式 1 须恢复
  wrapper.style.alignItems = 'flex-start';
  wrapper.style.gap = '12px';
  wrapper.style.height = '';             // [lc-784] 重置样式 2 的高度预算，避免约束样式 1 布局

  // Slide track (纵向: 上→下切换)
  const track = document.createElement('div');
  track.style.cssText = 'display:flex;flex-direction:column;position:absolute;top:0;left:0;width:100%;height:100%;transition:transform .8s ease-in-out';
  track.style.transform = 'translateX(0)';
  container.appendChild(track);

  // 右侧独立竖向海报条容器（与轮播容器并列）
  const posterStrip = document.createElement('div');
  posterStrip.className = 'fnos-poster-strip';
  posterStrip.style.cssText = 'width:150px;flex-shrink:0;height:100%;max-height:calc(100vh - 380px);overflow:hidden;display:block;padding:0 8px;background:rgba(255,255,255,.12);backdrop-filter:blur(14px) saturate(120%);-webkit-backdrop-filter:blur(14px) saturate(120%);border-radius:24px;border:none';
  wrapper.appendChild(posterStrip);
  S.carouselPosterStrip = posterStrip;

  // 轮播点已移除(lc-441, 用户不需要)

  // URL规范化: 硬编码用相对路径, API返回完整URL
  const imgUrl = (p: string, w?: number) => {
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/v/api/')) return p + (w ? '?w=' + w : '');
    return `${base}/v/api/v1/${p}` + (w ? '?w=' + w : '');
  };

  shows.forEach((show, i) => {
    const slide = document.createElement('div');
    slide.style.cssText = 'width:100%;height:100%;position:relative;flex-shrink:0;display:flex;background:transparent;overflow:hidden;border-radius:inherit';
    slide.className = 'fnos-slide';

    // 左: 图片面板(占 ~80%, 撑满无白边)
    const leftEl = document.createElement('div');
    leftEl.style.cssText = 'position:relative;width:80%;height:100%;overflow:hidden;flex-shrink:0;background:transparent';
    // [lc-624] 删除竖版海报兜底(lc-566 blurBg/contain 居中): 用户明确不要竖屏渲染。
    // 仅横版 backdrop 才显示图片; 竖版(数据未补全/无横版图) → 图片隐藏, 保留渐变背景。
    const imgEl = document.createElement('img');
    imgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:left center;z-index:1;display:none';
    leftEl.appendChild(imgEl);
    const pic = imgUrl(show.backdrop); // 不带?w, 避免与签名path不一致
    const blob = (show as any)._backdropBlob as string | undefined; // [lc-768] 预加载成功的 blob 复用，跳过二次网络请求
    if (shows === S.apiShows && i === 0) log('SLIDE0 src:', (blob || pic).substring(0, 80));
    const isSlideStrm = !!show.strmTag;
    const applyLandscapeCheck = () => {
      try {
        const nw = imgEl.naturalWidth || 0, nh = imgEl.naturalHeight || 0;
        if (nw > 0 && nh > 0 && nw < nh) {
          imgEl.style.display = 'none'; // 竖版 → 不显示
        } else {
          imgEl.style.display = 'block'; // 横版 → 显示
        }
      } catch (e) { /* ignore */ }
    };
    if (blob) {
      imgEl.onerror = () => { log('[DIAG] 轮播主图(blob缓存)加载失败:', (show.title || '').substring(0, 16)); };
      imgEl.src = blob;
      try { if (imgEl.complete) applyLandscapeCheck(); } catch (e) { /* ignore */ }
    } else if (!(show as any)._backdropIsPortrait) {
      // [lc-924] 返回首页校验发现 backdrop 是竖版 → 不拉图, 保留默认隐藏(img 已是 display:none)
      fetchImageAuth(pic, { label: 'slide#' + i + ':' + (show.title || '').substring(0, 10), isStrm: isSlideStrm }).then((b) => {
        if (!b) {
          if (isSlideStrm) log('[DIAG] 轮播主图 fetchImageAuth 返回空(STRM item 海报加载失败):', (show.title || '').substring(0, 16), pic.substring(0, 60));
          return;
        }
        imgEl.onerror = () => {
          log('[DIAG] 轮播主图加载失败(img.onerror):', (show.title || '').substring(0, 16), 'strmTag=', show.strmTag || '-', pic.substring(0, 60));
        };
        imgEl.onload = applyLandscapeCheck;
        imgEl.src = b;
        try { if (imgEl.complete) applyLandscapeCheck(); } catch (e) { /* ignore */ }
      });
    }
    // 右边缘渐隐, 与右侧文字面板自然融合
    const edgeFade = document.createElement('div');
    edgeFade.style.cssText = 'position:absolute;inset:0;background:var(--fnos-hero-edge)';
    leftEl.appendChild(edgeFade);
    // [lc-436] logo 移到整个海报(左侧图片)左下角, 叠在背景图上, z-index 高于渐隐
    const cornerLogo = document.createElement('img');
    cornerLogo.className = 'fnos-logo';
    cornerLogo.alt = '';
    cornerLogo.style.cssText = 'position:absolute;left:28px;bottom:24px;max-width:36%;max-height:88px;width:auto;height:auto;object-fit:contain;object-position:left bottom;filter:drop-shadow(0 3px 14px rgba(0,0,0,.55));display:none;z-index:3';
    leftEl.appendChild(cornerLogo);
    slide.appendChild(leftEl);

    // 右: 文字面板 — [lc-439] 收窄为30%, 为右侧海报条让空间
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = 'position:relative;width:20%;height:100%;flex-shrink:0;display:flex;flex-direction:column;padding:24px 22px 24px 22px;background:var(--fnos-hero-panel);backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);border-left:var(--fnos-hero-panel-border);overflow:hidden';

    // 信息卡: 占满面板高度, 自顶向下分层(徽标→标题/logo→细分隔→弹性简介→锚底按钮); 字体整体放大
    const info = document.createElement('div');
    info.style.cssText = 'position:relative;z-index:2;display:flex;flex-direction:column;gap:14px;width:100%;height:100%;overflow:hidden;opacity:0;transform:translateY(28px);transition:all .7s cubic-bezier(.16,1,.3,1) .15s';
    // [lc-573] 徽标行（用户确认优化）：独立胶囊横向排列，评分金色加粗最醒目
    //   [⭐ 8.4] [3季 26集] [动画 / 科幻]   ← 同一行 flex，各自独立胶囊
    const totalEps = (show as any).totalEps || 0;
    const localEps = (show as any).localEps || 0;
    const totalSeasons = (show as any).totalSeasons || 0;
    const localSeasons = (show as any).localSeasons || 0;
    const year = (show as any).year || 0;
    const rating = (show as any).rating || 0;
    // ① 评分胶囊（[lc-589] 浅紫白面板上用**深色实底+亮字**(此前半透明叠加隐形), 对比度拉满)
    const ratingPill = rating > 0
      ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 15px;background:linear-gradient(135deg,rgba(80,55,10,.95),rgba(50,35,5,.92));border:1px solid rgba(255,214,130,.85);border-radius:20px;color:#fff3b8;font-size:15px;font-weight:900;letter-spacing:.5px;box-shadow:0 0 16px rgba(255,180,60,.6),0 2px 4px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,240,180,.4)"><svg width="15" height="15" viewBox="0 0 24 24" style="flex-shrink:0;filter:drop-shadow(0 0 4px rgba(255,210,120,.8))"><path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z" fill="#fff3b8"/></svg>${rating.toFixed(1)}</span>`
      : '';
    // ② 类型/集数胶囊（[lc-589] 深紫实底+亮白字, 数字大单位小）
    let epsText: string;
    if (show.mediaType === 'movie') {
      epsText = (year ? year + ' · ' : '') + '电影';
    } else {
      const seasons = totalSeasons || localSeasons;
      const eps = totalEps || localEps;
      if (seasons > 0 && eps > 0) epsText = `${seasons}<span style="font-size:10.5px;opacity:.85">季</span> ${eps}<span style="font-size:10.5px;opacity:.85">集</span>`;
      else if (eps > 0) epsText = `${eps}<span style="font-size:10.5px;opacity:.85">集</span>`;
      else if (seasons > 0) epsText = `${seasons}<span style="font-size:10.5px;opacity:.85">季</span>`;
      else epsText = '✨ 最近更新';
    }
    const epsPill = `<span style="display:inline-flex;align-items:baseline;gap:3px;padding:6px 15px;background:linear-gradient(135deg,rgba(50,35,90,.95),rgba(30,20,65,.92));border:1px solid rgba(190,170,240,.75);border-radius:20px;color:#ffffff;font-size:13px;font-weight:900;letter-spacing:.5px;box-shadow:0 2px 4px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.2)">${epsText}</span>`;
    // ③ 类型标签胶囊（浅色，取前 2 个）
    const genreArr: string[] = (show as any).genres || [];
    const tagPill = genreArr.length
      ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:20px;color:var(--fnos-hero-desc);font-size:11.5px;font-weight:600;letter-spacing:1px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">${genreArr.slice(0, 2).join(' / ')}</span>`
      : '';
    const pillRow = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0">${ratingPill}${epsPill}${tagPill}</div>`;
    // [lc-549] 类型标签 chips：多标签横向排列（标题下方，显示全部最多 4 个）
    const genreHtml = genreArr.length
      ? `<div class="fnos-genres" style="display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0">${genreArr.slice(0, 4).map((g: string) => `<span style="padding:3px 10px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);border-radius:12px;font-size:11.5px;font-weight:600;color:var(--fnos-hero-desc);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">${g}</span>`).join('')}</div>`
      : '';
    // [lc-771] 详情页路由按类型分流：电影 /v/movie/<id>、剧集 /v/tv/<id>。
    //   原「开始观看」硬编码 /v/tv/，电影项会跳到错误路由；More 按钮与它共用同一路由。
    const detailHref = '/v/' + (show.mediaType === 'movie' ? 'movie' : 'tv') + '/' + show.id;
    info.innerHTML = `
      ${pillRow}
      <div class="fnos-title-wrap" style="display:flex;flex-direction:column;gap:10px;flex-shrink:0;justify-content:flex-start;margin-top:16px;padding-left:2px">
        <div class="fnos-title" style="font-size:clamp(28px,3.6vh,42px);font-weight:900;line-height:1.18;letter-spacing:1px;word-break:break-word;background:var(--fnos-hero-title-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:var(--fnos-hero-title-glow)">${show.title}</div>
        ${genreHtml}
      </div>
      <div style="width:100%;height:1px;background:var(--fnos-hero-divider);margin:16px 0 14px;flex-shrink:0;border-radius:1px;opacity:.85"></div>
      <div class="fnos-desc" style="flex:1 1 auto;min-height:0;-webkit-line-clamp:5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;font-size:14.5px;line-height:1.75;color:var(--fnos-hero-desc);letter-spacing:.4px;font-weight:500;text-indent:2em;mask-image:linear-gradient(180deg,rgba(0,0,0,1) 80%,rgba(0,0,0,0) 100%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,1) 80%,rgba(0,0,0,0) 100%)">${show.desc||''}</div>
      <div class="fnos-action">
        <a class="fnos-play" href="${detailHref}" aria-label="开始观看">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          开始观看
        </a>
        <a class="fnos-more" href="${detailHref}" title="查看分季详情" aria-label="查看分季详情">
          More
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </a>
      </div>`;
    rightPanel.appendChild(info);
    slide.appendChild(rightPanel);

    // [v323] 让"开始观看"走飞牛原生SPA路由(与列表项<a>一致), 避免整页导航导致详情页侧栏按钮失效
    // 轮播<a>不在飞牛React树内, 原生点击会触发整页导航(full page load) → 详情页头部重建 → 我们的click hook丢失
    // 改为手动pushState+popstate(飞牛history模式SPA基于此), 保留头部DOM, 与列表点击同路径
    const spaNav = (href: string, tag: string): void => {
      log(tag + ' -> SPA navigate', href);
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      // [lc-941] 仅当 fnOS 确实未接管导航时才兜底整页跳转(见下方双重判定)。
      setTimeout(() => {
        // 旧逻辑用「返回按钮是否存在」单一判定: 详情页加载慢(>600ms 才出返回键)会误判为未接管 → location.href 整页刷新,
        // 导致返回首页时模块重载、S.apiShows/_backdropBlob 被重置 → 轮播海报不显示(原生卡片进详情不经此路径故正常)。
        // 现改双重判定「首页轮播仍可见 且 详情返回键未出现」才视为未接管; fnOS 已接管后 hideStaleViews 会把首页视图
        // display:none, 轮播 getBoundingClientRect 为 0 → 绝不整页刷新。
        const backBtn = !!document.querySelector('button[aria-label="返回"]');
        // [lc-944] 兜底判据改为「季页内容是否真渲染」, 修复 lc-941 引入的白屏(同构于其余样式)
        const seasonRendered = !!document.querySelector('[data-id="details"]')
          || !!document.querySelector('.fnos-season-2col')
          || !!document.querySelector('a[href*="/v/person/"]');
        if (!backBtn && !seasonRendered) {
          log(tag + ' fallback -> full page nav (popstate not handled)', href);
          location.href = href;
        }
      }, 600);
    };
    const playBtn = info.querySelector('a.fnos-play') as HTMLElement | null;
    const moreBtn = info.querySelector('a.fnos-more') as HTMLElement | null;
    // [lc-773] 悬停 / 按压 / 焦点环全部由注入的 CSS(.fnos-play / .fnos-more 伪类)处理，
    //   此处只绑定行为，不再用 mouseenter/mouseleave 改内联样式(避免与 CSS 打架、也减少监听)。
    // [lc-900] PLAY 按钮默认进二级详情页(/v/(tv|movie)/season/<季guid>)，与 MORE 同构；
    //   季 guid 异步查，失败/无季 resolveSeasonHref 内部回退到一级详情页。
    if (playBtn) {
      playBtn.addEventListener('click', (e: Event) => {
        e.preventDefault();
        playBtn.classList.add('is-loading');
        resolveSeasonHref(show).then((href) => {
          playBtn.classList.remove('is-loading');
          spaNav(href, 'PLAY btn');
        });
      });
    }
    // [lc-772] More：右侧次要按钮 → 跳「季」详情页(三级 /v/(tv|movie)/season/<季guid>)。
    //   季 guid 需异步查 item/list 子级；失败/无季自动回退二级详情页，不会点了没反应。
    if (moreBtn) {
      moreBtn.addEventListener('click', (e: Event) => {
        e.preventDefault();
        moreBtn.classList.add('is-loading'); // 加载态(样式在 CSS，不改行内 opacity)
        resolveSeasonHref(show).then((href) => {
          moreBtn.classList.remove('is-loading');
          spaNav(href, 'MORE btn');
        });
      });
    }
    track.appendChild(slide);
    infos.push(info);

    // [lc-408] 重建轮播时若已缓存过 logo(tmdbLogo/本地 logo), 立即复用, 避免重渲后退回文字标题
    if (show.tmdbLogo) {
      swapTitleToLogo(info, show.tmdbLogo);
    }

    // dot removed (lc-441)
  });

  // [lc-439] 填充右侧竖向海报条：全部10个剧的竖向poster，自动滚动+点击跳转
  if (S.carouselPosterStrip && shows.length > 0) {
    S.carouselPosterStrip.innerHTML = '';
    const pInner = document.createElement('div');
    pInner.className = 'fnos-ps-inner';
    pInner.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;padding:20px 0;position:relative;transition:transform .4s ease';
    // 每个海报项：竖向封面 + 标题截断
    shows.forEach((show, pi) => {
      const item = document.createElement('div');
      item.style.cssText = 'cursor:pointer;transition:all .3s ease;opacity:.65;transform:scale(.92)';
      item.dataset.idx = String(pi);
      const pImg = document.createElement('img');
      pImg.alt = show.title;
      // [lc-601] 占位 SVG: show.poster 为空 / fetchImageAuth 失败时显示「无海报」图,
      //   避免 src="" 触发浏览器默认裂开图标。
      const placeholderSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="170" viewBox="0 0 120 170">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="rgba(180,160,210,.45)"/><stop offset="1" stop-color="rgba(120,100,160,.45)"/>' +
        '</linearGradient></defs>' +
        '<rect width="120" height="170" rx="10" fill="url(#g)"/>' +
        '<g transform="translate(60 75)" fill="rgba(255,255,255,.55)">' +
        '<rect x="-22" y="-30" width="44" height="60" rx="6" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2"/>' +
        '<circle cx="0" cy="-10" r="9" fill="rgba(255,255,255,.55)"/>' +
        '<path d="M-22 30 L-6 12 L8 26 L22 8 L22 30 Z" fill="rgba(255,255,255,.55)"/>' +
        '</g>' +
        '<text x="60" y="148" text-anchor="middle" font-size="11" font-family="sans-serif" fill="rgba(255,255,255,.7)" font-weight="600">暂无海报</text>' +
        '</svg>'
      );
      pImg.src = placeholderSvg; // 先占位, 成功后再切到真实 URL(防裂开)
      pImg.style.cssText = 'width:120px;height:170px;object-fit:cover;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.18);display:block;background:rgba(200,190,220,.25)';
      // [lc-601] onerror 兜底: 即便 src 切到真实 URL 后 404, 也回退到占位(永不裂开)
      pImg.onerror = () => {
        log('[DIAG] 右侧海报条加载失败(img.onerror):', (show.title || '').substring(0, 16), 'strmTag=', show.strmTag || '-', pUrl ? pUrl.substring(0, 60) : '');
        if (pImg.src !== placeholderSvg) pImg.src = placeholderSvg;
      };
      const pUrl = imgUrl(show.poster);
      if (pUrl) {
        fetchImageAuth(pUrl, { label: 'poster:' + (show.title || '').substring(0, 10), isStrm: !!show.strmTag }).then((b) => { if (b) pImg.src = b; });
      } else if (show.strmTag) {
        log('[DIAG] 右侧海报条无 poster URL(STRM item):', (show.title || '').substring(0, 16), 'strmTag=', show.strmTag);
      }
      const pTitle = document.createElement('div');
      // [lc-574] 标题浅色化: 深蓝黑→近白浅紫, 加字重/字距/阴影, 配合暗色磨砂背景更好看
      pTitle.style.cssText = 'font-size:11.5px;font-weight:600;color:rgba(240,236,255,.95);text-align:center;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;line-height:1.35;letter-spacing:.3px;text-shadow:0 1px 4px rgba(0,0,0,.35)';
      pTitle.textContent = show.title;
      item.appendChild(pImg);
      item.appendChild(pTitle);
      item.addEventListener('click', () => goTo(pi));
      // [lc-440] 悬停联动：鼠标放到右侧某海报, 主轮播切到该集
      item.addEventListener('mouseenter', () => {
        goTo(pi);
        item.style.opacity='1'; item.style.transform='scale(1)';
      });
      item.addEventListener('mouseleave', () => {
        if (pi !== currentIdx) { item.style.opacity='.65'; item.style.transform='scale(.92)'; }
      });
      pInner.appendChild(item);
    });
    S.carouselPosterStrip.appendChild(pInner);

    // [lc-448] 右侧海报不自滚动：选中项自动居中并放大, 与左侧主轮播联动
    function centerPoster(idx: number) {
      const strip = S.carouselPosterStrip;
      if (!strip) return;
      const target = pInner.children[idx] as HTMLElement | undefined;
      if (!target) return;
      const stripH = strip.clientHeight;
      const desired = target.offsetTop + target.offsetHeight / 2 - stripH / 2;
      const maxScroll = Math.max(0, pInner.scrollHeight - stripH);
      const clamped = Math.min(Math.max(desired, 0), maxScroll);
      pInner.style.transform = `translateY(-${clamped}px)`;
    }

    // 高亮当前slide对应的海报：选中项放大+不透明并居中, 其余缩小+半透明（goTo 里同步调用）
    (S.carouselPosterStrip as any)._highlight = (idx: number) => {
      const items = pInner.children;
      for (let k = 0; k < items.length; k++) {
        const el = items[k] as HTMLElement;
        if (k === idx) { el.style.opacity = '1'; el.style.transform = 'scale(1.12)'; el.style.zIndex = '2'; }
        else { el.style.opacity = '.5'; el.style.transform = 'scale(.9)'; el.style.zIndex = '1'; }
      }
      centerPoster(idx);
    };
  }

  if (infos.length > 0) {
    infos[0].style.opacity = '1';
    infos[0].style.transform = 'translateY(0)';
    if (S.carouselPosterStrip && (S.carouselPosterStrip as any)._highlight) (S.carouselPosterStrip as any)._highlight(0);
  }

  function goTo(idx: number) {
    currentIdx = idx;
    track.style.transform = `translateY(-${idx * 100}%)`;
    infos.forEach((el, j) => { el.style.opacity = j === idx ? '1' : '0'; el.style.transform = j === idx ? 'translateY(0)' : 'translateY(20px)'; });
    // [lc-439] 同步高亮右侧海报条
    if (S.carouselPosterStrip && (S.carouselPosterStrip as any)._highlight) (S.carouselPosterStrip as any)._highlight(idx);
  }

  let timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000);
  container.addEventListener('mouseenter', () => clearInterval(timer));
  container.addEventListener('mouseleave', () => { timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000); });
  // [lc-442] 海报条独立容器，悬停也暂停主轮播
  posterStrip.addEventListener('mouseenter', () => clearInterval(timer));
  posterStrip.addEventListener('mouseleave', () => { timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000); });

  let startY = 0, dragging = false;
  container.addEventListener('mousedown', (e) => { startY = e.clientY; dragging = true; });
  container.addEventListener('mouseup', (e) => {
    if (!dragging) return; dragging = false;
    const dy = e.clientY - startY;
    if (dy < -50) goTo((currentIdx + 1) % shows.length);
    else if (dy > 50) goTo((currentIdx - 1 + shows.length) % shows.length);
  });

  if (!rebuild) target.appendChild(wrapper);

  /* 异步补齐缺失的简介(从详情页提取,未来新增自动获取) */
  autoFetchDescs(base, shows, infos);

  /* [lc-408] 异步把右侧文字标题替换为 TMDB 透明 logo（获取成功才替换，否则保留文字） */
  // [lc-409] 记录当前轮播引用，供设置开关即时生效
  S.carouselInfos = infos;
  S.carouselShows = shows;
  S.carouselBase = base;
  applyTitleLogo(base, shows, infos);

  log('carousel injected');
}

/* ========== [lc-781] 轮播样式 2：滑动切换式 + 底部进度条/指示点 ==========
 * 结构/交互照抄用户给的「海外剧场」demo，数据接入真实片库(shows)。
 * 仅当容器 data-fntv-carousel-style="2" 时由 injectCarousel 早期分支调用。 */