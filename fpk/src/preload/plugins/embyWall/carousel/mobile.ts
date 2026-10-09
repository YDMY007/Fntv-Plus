// embyWall/carousel/mobile.ts — 样式 5：手机/平板触屏特供轮播（lc-1291）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：样式 1~4 全部是桌面鼠标语境的设计（3D 透视/竖向海报条/悬停联动），往手机上
// 打 CSS 补丁（v1.4.8、lc-1288、lc-1290）每一步都在证明此路不通——用户最终报障截图：
// 3D 邻卡的 blur 残影糊在左缘、下一张卡的红边露出右缘、3D 卡旋转露出黑色缺角、
// logo 图与渐变标题文字叠加、简介被裁半句。结论：桌面样式收编不成，触屏要独立设计。
//
// 设计原则（对齐 Netflix / Disney+ 移动端 hero 位）：
//   1. 全宽单卡：一屏永远一张，无邻卡透视 → 黑框/残影/缺角三类问题物理性消失。
//   2. 滑动交给浏览器：scroll-snap-type:x mandatory + touch-action:pan-x，
//      惯性/跟手/回弹全是原生行为，不写 JS 手势判定（JS 手势与页面滚动打架是 lc-1288 的教训）。
//   3. 横竖屏都成立：高 = min(56vw, 340px)，横屏平板也不会顶满全屏。
//   4. 信息层克制：logo/标题一行 + 简介两行 + 两个胶囊按钮，避让底部指示点。
//   5. 指示点在卡外下方（不叠在图上），当前项拉长为胶囊。
//
// 门控与选路：storage['fnos-carousel-style']='5' 时由 render.ts 分发进来；
// 只有触屏窄屏(fnos-touch-narrow)才允许选 5——桌面选了也会在 getCs() 处回落到 4。
// 复用件：applyCarouselBackdrop（横版校验+base64 化）、resolveShowLogo、fetchImageAuth、
// resolveSeasonHref、S.carouselCleanup/S.carouselResume 契约与样式 2/3/4 完全一致。

import { S } from '../state';
import { getEffectiveDark } from '../theme';
import { log } from '../log';
import { resolveSeasonHref } from './href';
import { resolveShowLogo } from './logo';
import { applyCarouselBackdrop } from './images';

/** 触屏设备硬事实判定（与 mobileStyle/beautifyStyle 同一口径，刻意不用 pointer 媒体查询） */
function isTouchCapable(): boolean {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  } catch { return false; }
}

/** 渲染层入口是否允许样式 5：必须真触屏。桌面窄窗口一律回落 4（桌面样式靠鼠标才有意义）。
 *  export 供 render.ts 的 getCs 与设置面板共同使用，保证三处口径一致。
 *  [lc-1291] 自动特供：触屏设备且用户从未手动选过样式（无存储值）→ 直接落样式 5，
 *  即「检测到手机/平板就给触屏版轮播」，用户无需进设置面板找开关；桌面与存量用户
 *  （已有存储值）完全不受影响。读 Storage 异常按未选过处理。 */
export function resolveCarouselStyle(): number {
  let stored: string | null = null;
  try { stored = localStorage.getItem('fnos-carousel-style'); } catch { /* 视为未选过 */ }
  const touch = isTouchCapable();
  if (touch && (stored === null || stored === '')) {
    return 5; // 触屏 + 从未选过 → 触屏特供
  }
  const v = parseInt(stored || '4', 10);
  if (v === 5 && !touch) return 4; // 非触屏设备选了 5 → 回落立体堆叠
  return (v >= 1 && v <= 5) ? v : 4;
}

/** 注入样式 5 的全部 CSS（幂等）。类名前缀 .fntv-s5-，与 s2/s3/s4 完全隔离，互不干扰。 */
export function ensureStyle5Css(): void {
  if (document.getElementById('fnos-carousel-style5-style')) return;
  const st = document.createElement('style');
  st.id = 'fnos-carousel-style5-style';
  st.textContent = `
/* ═══ 样式 5：触屏特供（全宽单卡 + 原生横滑）═══
   容器不再用 aspect-ratio（桌面 16/9 在竖屏塌成一条），高度直接按视口宽推算，
   横竖屏都成立：竖屏 390px → 218px；横屏 844px → 340px 封顶。 */
[data-fntv-carousel-style="5"]{
  position:relative;width:100%;height:min(56vw,340px);
  border-radius:18px;overflow:hidden;background:transparent;
}
[data-fntv-carousel-style="5"] .fntv-s5-scroll{
  display:flex;width:100%;height:100%;
  overflow-x:auto;overflow-y:hidden;
  scroll-snap-type:x mandatory;
  -webkit-overflow-scrolling:touch;
  touch-action:pan-x;              /* 只吃横向手势，纵向滚动还给学生页面 */
  scrollbar-width:none;
  overscroll-behavior-x:contain;   /* 滑到头不把橡皮筋传给整页 */
}
[data-fntv-carousel-style="5"] .fntv-s5-scroll::-webkit-scrollbar{ display:none }
[data-fntv-carousel-style="5"] .fntv-s5-slide{
  position:relative;flex:0 0 100%;width:100%;height:100%;
  scroll-snap-align:center;scroll-snap-stop:always;  /* 一屏一停，禁止连滑掠过 */
  overflow:hidden;border-radius:18px;background:#10141c;
}
/* 遮罩：底部单层渐变（信息可读），顶部不压——海报上部是视觉主体，保留原画亮度 */
[data-fntv-carousel-style="5"] .fntv-s5-shade{
  position:absolute;inset:0;z-index:1;pointer-events:none;
  background:linear-gradient(to top,rgba(0,0,0,.88) 0%,rgba(0,0,0,.55) 22%,rgba(0,0,0,.16) 46%,transparent 66%);
}
[data-fntv-carousel-style="5"] .fntv-s5-info{
  position:absolute;left:0;right:0;bottom:0;z-index:2;
  padding:14px 16px 14px;box-sizing:border-box;color:#fff;
}
/* 标题/logo：logo 优先（有图时文字隐藏），高度钳 44px——手机上 84px 的桌面 logo 占半屏 */
[data-fntv-carousel-style="5"] .fntv-s5-title{
  margin:0 0 8px;font-size:1.35rem;font-weight:800;line-height:1.2;letter-spacing:.5px;
  text-shadow:0 2px 10px rgba(0,0,0,.65);
}
[data-fntv-carousel-style="5"] .fntv-s5-title.is-logo{ font-size:0;margin:0 0 6px }
[data-fntv-carousel-style="5"] .fntv-s5-logo{
  max-height:44px;max-width:62%;width:auto;height:auto;display:block;
  object-fit:contain;filter:drop-shadow(0 3px 12px rgba(0,0,0,.6));
}
/* 简介：两行截断（桌面 3 行在触屏上把按钮挤出卡外） */
[data-fntv-carousel-style="5"] .fntv-s5-desc{
  font-size:.8rem;line-height:1.5;color:rgba(240,236,255,.82);
  text-shadow:0 1px 6px rgba(0,0,0,.6);
  margin:0 0 12px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
[data-fntv-carousel-style="5"] .fntv-s5-actions{ display:flex;gap:10px;align-items:center }
/* 胶囊按钮：高 44px（WCAG 触控下限），按压态代替 hover（触屏没有 hover） */
[data-fntv-carousel-style="5"] .fntv-s5-play,
[data-fntv-carousel-style="5"] .fntv-s5-detail{
  min-height:44px;padding:0 22px;border-radius:999px;border:none;cursor:pointer;
  font-size:.88rem;font-weight:700;letter-spacing:1px;white-space:nowrap;
  display:inline-flex;align-items:center;gap:6px;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;
  transition:transform .15s ease,opacity .15s ease;
}
[data-fntv-carousel-style="5"] .fntv-s5-play{
  background:linear-gradient(135deg,#f0b85c,#d49a3a);color:#1a120a;
}
[data-fntv-carousel-style="5"] .fntv-s5-detail{
  background:rgba(255,255,255,.16);color:#fff;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
}
[data-fntv-carousel-style="5"] .fntv-s5-play:active,
[data-fntv-carousel-style="5"] .fntv-s5-detail:active{ transform:scale(.96);opacity:.85 }
[data-fntv-carousel-style="5"] .fntv-s5-play.is-loading,
[data-fntv-carousel-style="5"] .fntv-s5-detail.is-loading{ opacity:.6;pointer-events:none }
/* 指示点：卡外下方独立一行（与按钮分离），active 拉长成胶囊；横向过多时自动收窄 */
[data-fntv-carousel-style="5"] .fntv-s5-dots{
  display:flex;justify-content:center;align-items:center;gap:7px;
  margin:10px 0 2px;height:14px;
}
[data-fntv-carousel-style="5"] .fntv-s5-dot{
  flex:0 0 auto;width:7px;height:7px;border-radius:99px;border:none;padding:0;cursor:pointer;
  background:var(--fntv-s5-dot,rgba(150,140,125,.45));
  transition:width .4s cubic-bezier(.22,1,.36,1),background-color .3s ease;
  -webkit-tap-highlight-color:transparent;
}
[data-fntv-carousel-style="5"] .fntv-s5-dot.active{
  width:24px;background:var(--fntv-s5-dot-active,#f0b85c);
}
/* 浅色主题：指示点换深色（container 上由 JS 按主题设 --fntv-s5-dot-* 变量，此处只留口径） */
/* 加载完成前淡入（与样式 2/4 的揭示节奏一致，避免闪现） */
[data-fntv-carousel-style="5"] .fntv-s5-scroll{ opacity:0;transition:opacity .45s ease }
[data-fntv-carousel-style="5"].fntv-s5-ready .fntv-s5-scroll{ opacity:1 }
`;
  (document.head || document.documentElement).appendChild(st);
}

/**
 * 构建样式 5 触屏特供轮播。
 * 入参与 buildCarouselStyle2/3/4 完全一致（container/wrapper/shows/base/rebuild），
 * 由 render.ts 的 _cs===5 分发调用；container/wrapper 已由调用方建好。
 */
export function buildCarouselStyle5(
  container: HTMLElement,
  wrapper: HTMLElement,
  shows: any[],
  base: string,
  rebuild: boolean
): void {
  const log5 = (...a: any[]) => log('[s5]', ...a);

  ensureStyle5Css();
  wrapper.dataset.fntvCarouselWrapper = '1';
  wrapper.style.cssText = 'display:block;padding:0;margin:0';
  container.style.width = '100%';
  // 桌面遗留的内联几何全清掉（render.ts 侧建的 container 带 aspect-ratio/maxHeight），
  // 高度交给样式表里的 min(56vw,340px)，避免内联样式压过 CSS。
  container.style.height = '';
  container.style.minHeight = '0';
  container.style.maxHeight = 'none';
  container.style.aspectRatio = 'auto';
  container.style.margin = '0';
  container.style.overflow = 'hidden';
  container.style.background = 'transparent';
  container.style.boxShadow = 'none';
  container.style.borderRadius = '18px';

  // 浅色主题下指示点换深色（深浅两套变量，切主题不重注入也能跟随——变量挂在 container 上）
  const paintDots = (): void => {
    const dark = getEffectiveDark();
    container.style.setProperty('--fntv-s5-dot', dark ? 'rgba(150,140,125,.45)' : 'rgba(96,86,72,.35)');
    container.style.setProperty('--fntv-s5-dot-active', dark ? '#f0b85c' : '#c8923a');
  };
  paintDots();

  // 横滑轨道：每张 show 一个 slide，图片直接 <img>（比 background-image 多了原生解码调度与 alt）
  const scroller = document.createElement('div');
  scroller.className = 'fntv-s5-scroll';
  const slides: HTMLElement[] = [];
  const logoDone = new Set<number>(); // 幂等：logo 异步返回时 slide 可能已重建

  shows.forEach((show, i) => {
    const slide = document.createElement('div');
    slide.className = 'fntv-s5-slide';
    slide.dataset.index = String(i);

    // 海报图：先渐变兜底，backdrop 拉到后铺上（复用横版校验 + base64 自包含链路）。
    // ⚠ 必须用 div —— applyCarouselBackdrop 写的是 style.backgroundImage，
    //   目标若是 <img> 则完全不可见（images.ts 的既有契约，s2/s3/s4 均传 div）。
    const bg = document.createElement('div');
    bg.className = 'fntv-s5-img';
    bg.style.cssText = 'position:absolute;inset:0;background-size:cover;background-position:center 25%;background-color:#10141c';
    slide.appendChild(bg);
    applyCarouselBackdrop(show, bg, base);

    const shade = document.createElement('div');
    shade.className = 'fntv-s5-shade';
    slide.appendChild(shade);

    const info = document.createElement('div');
    info.className = 'fntv-s5-info';
    const title = document.createElement('h3');
    title.className = 'fntv-s5-title';
    title.textContent = (show as any).title || '';
    const desc = document.createElement('p');
    desc.className = 'fntv-s5-desc';
    desc.textContent = (show as any).desc || '';
    const actions = document.createElement('div');
    actions.className = 'fntv-s5-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'fntv-s5-play';
    play.textContent = '开始播放';
    const detail = document.createElement('button');
    detail.type = 'button';
    detail.className = 'fntv-s5-detail';
    detail.textContent = '更多详情';
    actions.appendChild(play);
    actions.appendChild(detail);
    info.appendChild(title);
    info.appendChild(desc);
    info.appendChild(actions);
    slide.appendChild(info);

    // 标题 logo 化（与 s2/s4 同款：有 logo 则文字隐藏、塞图）
    resolveShowLogo(show, base).then((src) => {
      if (!src || logoDone.has(i) || !document.body.contains(slide)) return;
      logoDone.add(i);
      title.textContent = '';
      title.classList.add('is-logo');
      const logo = document.createElement('img');
      logo.className = 'fntv-s5-logo';
      logo.alt = (show as any).title || '';
      logo.src = src;
      title.appendChild(logo);
    }).catch(() => { /* logo 失败保留文字标题 */ });

    // SPA 导航（照抄 s4 的 spaNav：fnOS 接管判定 + 兜底整页跳转，lc-941/944 的结论原样复用）
    const spaNav = (href: string): void => {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      setTimeout(() => {
        const backBtn = !!document.querySelector('button[aria-label="返回"]');
        const seasonRendered = !!document.querySelector('[data-id="details"]')
          || !!document.querySelector('.fnos-season-2col')
          || !!document.querySelector('a[href*="/v/person/"]');
        if (!backBtn && !seasonRendered) location.href = href;
      }, 600);
    };
    play.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      play.classList.add('is-loading');
      resolveSeasonHref(show).then((href) => { play.classList.remove('is-loading'); spaNav(href); });
    });
    detail.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      detail.classList.add('is-loading');
      resolveSeasonHref(show).then((href) => { detail.classList.remove('is-loading'); spaNav(href); });
    });

    // 点卡片空白处也进详情（触屏上“滑”与“点”由浏览器区分，不会误触）
    slide.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.fntv-s5-actions')) return;
      spaNavByShow(show);
    });
    function spaNavByShow(s: any): void {
      resolveSeasonHref(s).then((href) => spaNav(href));
    }

    scroller.appendChild(slide);
    slides.push(slide);
  });

  container.appendChild(scroller);

  // 指示点（卡外）：点击跳转对应用 scrollIntoView，滑动手势反过来同步指示点
  const dotsRow = document.createElement('div');
  dotsRow.className = 'fntv-s5-dots';
  const dots: HTMLElement[] = [];
  shows.forEach((_, i) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'fntv-s5-dot' + (i === 0 ? ' active' : '');
    d.setAttribute('aria-label', '第' + (i + 1) + '个');
    d.addEventListener('click', () => {
      slides[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
    dotsRow.appendChild(d);
    dots.push(d);
  });
  container.appendChild(dotsRow);

  // 滑动 ↔ 指示点双向同步：scroll 事件按最近中心判 active（rAF 节流，s5 滑动高频触发）
  let rafPending = false;
  const syncActive = (): void => {
    rafPending = false;
    const center = scroller.scrollLeft + scroller.clientWidth / 2;
    let best = 0, bestDist = Infinity;
    slides.forEach((s, i) => {
      const c = s.offsetLeft + s.offsetWidth / 2;
      const dist = Math.abs(c - center);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    dots.forEach((d, i) => d.classList.toggle('active', i === best));
  };
  scroller.addEventListener('scroll', () => {
    if (!rafPending) { rafPending = true; requestAnimationFrame(syncActive); }
  }, { passive: true });

  // 自动轮播：5s；用户正在触摸时永远不停表（scroll-snap 下定时翻页会与手指抢滚动位置），
  // 只在「完全空闲」时走 scrollIntoView。页面隐藏/销毁自停（s4 同款守卫）。
  let autoTimer: number | null = null;
  let touching = false;
  let current = 0;
  scroller.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  scroller.addEventListener('touchend', () => { touching = false; }, { passive: true });
  scroller.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
  const goTo = (i: number): void => {
    const n = slides.length;
    if (!n) return;
    current = ((i % n) + n) % n;
    slides[current]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  };
  const startAuto = (): void => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = window.setInterval(() => {
      if (!document.body.contains(container)) { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } return; }
      if (document.hidden || touching) return; // 触摸中/页面隐藏不翻页
      goTo(current + 1);
    }, 5000);
  };
  const stopAuto = (): void => { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } };

  // 清理/恢复契约（与 s2/s3/s4 一致，destroyCarousel/resumeCarousel 依赖）
  S.carouselCleanup = (): void => {
    stopAuto();
    log5('cleanup: auto timer destroyed');
  };
  S.carouselResume = (): void => {
    if (!document.body.contains(container)) return;
    startAuto();
  };

  // 首图就绪或超时后整体淡入（与骨架交叉淡出的节奏一致）。
  // 背景走 backgroundImage（无 load 事件），用一张探针 img 解码同一 URL 判就绪；
  // 若数据里连 backdrop 都没有（渐变兜底态），直接揭示不等。
  container.classList.remove('fntv-s5-ready');
  const reveal = (): void => container.classList.add('fntv-s5-ready');
  const firstUrl = (shows[0] && (shows[0] as any)._backdropBlob) || '';
  if (firstUrl) {
    let revealed = false;
    const once = (): void => { if (!revealed) { revealed = true; reveal(); } };
    const probe = new Image();
    probe.onload = once;
    probe.onerror = once;
    probe.src = firstUrl;
    setTimeout(once, 1200); // 兜底：慢网下不让骨架淡出后空白卡住
  } else {
    reveal();
  }

  if (!rebuild) wrapper.style.opacity = '';
  startAuto();
  log5('触屏特供轮播注入完成, slides=', slides.length);
}
