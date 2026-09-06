// preload/plugins/pageAnim.ts
// [lc-463] 全局动画层：把 anime.js 接入 fnOS TV 的「页面切换 / 列表入场 / 弹窗打开」，
// 让整体过渡更顺滑。复用 animeLib 注入的 window.anime（无则优雅降级，不阻断 UI）。
//
// 设计原则（来自历史教训，务必遵守）：
//   ① 仅在飞牛影视 TV 页(.fnos-tv-page / isFntvTvPage)生效；系统页(/)与登录页绝不介入，避免破坏原生 UI。
//   ② 动画只用 opacity + translateY（垂直位移）。绝不使用 scale / translateX：
//      listLayout 靠 getBoundingClientRect 做卡片水平居中，vertical translate 不影响左右间隙计算，
//      scale 会改变宽高→破坏测量与居中。弹窗可用 scale（不参与布局测量）。
//   ③ 绝不介入视频预览模态(.trim-ui__app-layout--window)：动画可能干扰 xgplayer 播放。
//   ④ 卡片「首帧前即用 CSS 预隐藏(opacity:0，作用域 .fnos-tv-page)，anime 随后淡入」——这是根治 FOUC 闪一下的关键：
//      MutationObserver 在节点插入后才置 0 会漏掉首帧(先全不透明度画一帧再淡入=闪)。CSS 在 paint 之前生效，从根上消除闪烁。
//      入场用文档级 collect()(任意 childList 变更下一帧去抖触发)，对 fnOS「先插网格后插卡片(分批 mutation)」同样可靠捕获；
//      1500ms 看门狗(不依赖 fntvIn 闸门)强制显示任何仍卡在 opacity:0 的卡片，杜绝空白。
//      注意：fnOS 部分网格用 position:absolute + transform:translate() 做卡片绝对定位，入场动画对这类「定位包装层」只用 opacity
//      (不用 translateY)，否则会覆写 fnOS 的 transform→卡片错位/丢失(空白)。普通 flex 流式网格保留 translateY 微滑。
//   ⑤ 每个元素只动画一次（dataset 标记），避免虚拟滚动/重渲染反复触发。
//
// 模块级代码铁律：除 import 与 registerHook 外不含任何模块级副作用；registerHook 最先执行，
// 确保 handle() 一定注册（避免 preload 抛错导致注入失败）。
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import logger from '../core/logger';

// fnOS 海报卡片网格：listLayout.ts 已验证 [class*="flex-wrap"][class*="gap-x"] 稳定命中卡片容器。
const GRID_SEL = '[class*="flex-wrap"][class*="gap-x"]';
// 弹窗内容：Semi 的 .semi-modal-wrapper（内容层，不含遮罩）；通用 [role="dialog"]。
// 刻意排除 .semi-modal-mask / .semi-modal（遮罩层）——缩放遮罩观感差，让它随内容自然显现即可。
const MODAL_SEL = '[role="dialog"], .semi-modal-wrapper';

function getAnime(): any {
  return (window as any).anime || null;
}

/** [lc-1014] 性能模式（设置面板-外观可切换，html.fnos-perf 总闸）：
 *  低配机兜底——所有入场/弹窗动画直接跳过（元素立即可见），观感=无动画但功能完整。
 *  读 DOM 类而非持久层：运行中切换即时生效，无需各插件订阅事件。 */
function perfMode(): boolean {
  try { return document.documentElement.classList.contains('fnos-perf'); } catch { return false; }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * [lc-465] 预隐藏网格卡片：用 CSS 在「首帧绘制前」就把卡片设为 opacity:0。
 * 这是根治「点开详情页闪一下」的关键——之前靠 MutationObserver 在节点插入后才置 0，
 * 浏览器可能已先以全不透明度画了一帧，anime 再把起点设为 0 淡入，中间那一帧就是闪(FOUC)。
 * CSS 规则在 paint 之前生效，从根上杜绝该闪烁；实际淡入仍由 enterCards(anime.js) 驱动。
 * 作用域严格限定 .fnos-tv-page（<html> 由 embyWall 在 /v 路径同步 add/remove），绝不误伤系统页；
 * reduced-motion 下不预隐藏，直接展示。
 */
function injectHideCSS(): void {
  if (document.getElementById('fntv-page-anim-hide')) return;
  const s = document.createElement('style');
  s.id = 'fntv-page-anim-hide';
  s.textContent = `
@media (prefers-reduced-motion: no-preference) {
  .fnos-tv-page [class*="flex-wrap"][class*="gap-x"] > * { opacity: 0; }
}`;
  (document.head || document.documentElement).appendChild(s);
}

/** 暴露全局工具，供其它插件复用（hotUpdates 等已直连 window.anime，此处统一出口）。 */
function toolkit() {
  const a = getAnime();
  if (!a) return null;
  return {
    anime: a,
    /** 列表/卡片错落入场：opacity + translateY（无 scale，安全于 listLayout 测量） */
    enterCards: (els: any) => enterCards(els),
    /** 容器/整页轻入场（用于全屏对话框或大块内容） */
    revealContent: (el: any) => revealContent(el),
    /** 弹窗打开：scale + translateY + opacity（弹窗不参与布局测量，可用 scale） */
    modalIn: (el: any) => modalIn(el),
  };
}

/** 列表/卡片错落入场（核心：opacity + translateY，绝不用 scale）
 *  [lc-466] 稳健性修正：fnOS 部分网格(flex-wrap+gap-x)用 position:absolute + transform:translate()
 *  做卡片绝对定位。若给这类「定位包装层」动画 translateY，会覆写 fnOS 的 transform→卡片错位/丢失(空白)。
 *  故检测：只要存在绝对定位的包装层，就改为纯 opacity 淡入(不动 transform)，安全且观感一致；
 *  普通 flex 流式网格仍保留 translateY 微滑。动画异常也兜底显示，绝不留 opacity:0。 */
function enterCards(els: any): void {
  const a = getAnime();
  if (!els || (els as any).length === 0) return;
  if (reducedMotion() || perfMode() || !a) { Array.from(els as any).forEach((e: any) => (e.style.opacity = '1')); return; }
  try {
    const list = Array.from(els as any) as HTMLElement[];
    const safeSlide = list.every((e) => {
      try { return getComputedStyle(e).position !== 'absolute'; } catch { return true; }
    });
    a.animate(els, {
      opacity: [0, 1],
      ...(safeSlide ? { translateY: [14, 0] } : {}),
      delay: a.stagger(22),
      duration: 430,
      ease: 'outExpo',
    });
  } catch {
    // 兜底：动画异常也要把卡片显示出来，绝不留 opacity:0 导致空白
    Array.from(els as any).forEach((e: any) => (e.style.opacity = '1'));
  }
}

/** 整块内容轻入场：opacity + 轻微 translateY（不用 scale，平移对水平测量无影响） */
function revealContent(el: any): void {
  const a = getAnime();
  if (!el) return;
  if (reducedMotion() || perfMode()) { el.style.opacity = '1'; return; }
  if (!a) { el.style.opacity = '1'; return; }
  try {
    a.animate(el, {
      opacity: [0, 1],
      translateY: [12, 0],
      duration: 360,
      ease: 'outExpo',
    });
  } catch { /* ignore */ }
}

/** 弹窗打开：scale + translateY + opacity（弹窗不参与 listLayout 测量，可用 scale 增强质感） */
function modalIn(el: any): void {
  const a = getAnime();
  if (!el) return;
  if (reducedMotion() || perfMode()) { el.style.opacity = '1'; return; }
  if (!a) { el.style.opacity = '1'; return; }
  try {
    a.animate(el, {
      opacity: [0, 1],
      translateY: [14, 0],
      scale: [0.96, 1],
      duration: 320,
      ease: 'outBack',
    });
  } catch { /* ignore */ }
}

/** 安装「插入即动画」观察者：卡片网格新增卡片错落入场；弹窗打开接上入场动画。
 *  [lc-466] 稳健性重写：原版按「被插入节点」递归查找网格子项，在 fnOS「先插网格后插卡片(分批 mutation)」
 *  的场景下会漏抓→卡片永久卡在 CSS 预隐藏的 opacity:0(空白)。改为：任意 childList 变更都触发一次
 *  文档级 collect()(下一帧去抖)，无论网格与卡片同帧还是分批插入都能可靠捕获；看门狗去掉 fntvIn 闸门，
 *  只要 computed opacity 仍为 0 就强制显示，彻底杜绝空白。 */
function setupObservers(): void {
  const a = getAnime();
  if (!a) {
    logger.warn('[pageAnim] window.anime 未就绪，跳过全局动画（降级为原生）');
    return;
  }
  if (typeof MutationObserver === 'undefined') return;

  let pendingCards: HTMLElement[] = [];
  let pendingModals: HTMLElement[] = [];
  let flushScheduled = false;
  let collectScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    const cards = pendingCards;
    const modals = pendingModals;
    pendingCards = [];
    pendingModals = [];
    if (reducedMotion() || perfMode()) {
      cards.forEach((e) => (e.style.opacity = '1'));
      modals.forEach((e) => (e.style.opacity = '1'));
      return;
    }
    if (cards.length) enterCards(cards);
    // 弹窗：全屏(接近视口)的用 revealContent 轻入场，普通尺寸的用 modalIn(带缩放)
    for (const m of modals) {
      const r = m.getBoundingClientRect();
      const full = r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8;
      if (full) revealContent(m); else modalIn(m);
    }
  };

  // collect：文档级扫描所有未动画的网格子项与弹窗，置 0 并入队(下一帧统一淡入)。
  // 用文档级查询而非「被插入节点递归」，对 fnOS 分批插入同样可靠。
  const collect = (): void => {
    collectScheduled = false;
    if (!isFntvTvPage()) return;
    const grids = document.querySelectorAll(GRID_SEL) as any;
    grids.forEach((g: any) => {
      Array.from(g.children).forEach((c: any) => {
        if (c.dataset.fntvIn === '1') return;
        if (typeof c.className === 'string' && (c.className.includes('fnos-') || c.className.includes('fntv-'))) return;
        if (c.closest && c.closest('.trim-ui__app-layout--window')) return; // 视频预览不介入
        c.dataset.fntvIn = '1';
        c.style.opacity = '0';
        pendingCards.push(c);
      });
    });
    document.querySelectorAll(MODAL_SEL).forEach((m: any) => {
      // [lc-1072] 跳过自建弹层(data-fnos-ui 约定标记: 设置面板/dialogUI/播放方式/年度报告)。
      //   它们各有自己的入场样式; 且 a11y 焦点陷阱会给可见的自建弹层动态挂 role=dialog,
      //   令其命中 MODAL_SEL —— modalIn 的 anime 会写 transform, 覆写设置面板赖以居中的
      //   内联 translate(-50%,-50%), 面板被钉在 top:50%/left:50% 上整体坠到屏幕右下(用户报障
      //   「面板有时候莫名其妙跑到下面去」)。
      if (m.dataset.fnosUi === '1') return;
      if (m.dataset.fntvAnim === '1') return;
      m.dataset.fntvAnim = '1';
      m.style.opacity = '0';
      pendingModals.push(m);
    });
    if ((pendingCards.length || pendingModals.length) && !flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flush);
    }
  };

  // 任意 childList 变更触发一次收集(下一帧去抖)，捕获无论同帧/分批插入的卡片。
  const scheduleCollect = (): void => {
    if (collectScheduled) return;
    collectScheduled = true;
    requestAnimationFrame(collect);
  };

  try {
    const obs = new MutationObserver((muts) => {
      if (!isFntvTvPage()) return;          // 系统页/登录页不介入
      // [lc-1011] 仅「有元素插入」才收集: 纯文本/注释变更(计时器、进度文字等高频更新)从不产生新卡片,
      //   旧写法让这类变更也触发 rAF 后的文档级 querySelectorAll —— 高频页面上的无谓开销。
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        const an = m.addedNodes;
        for (let i = 0; i < an.length; i++) {
          if (an[i].nodeType === 1) { scheduleCollect(); return; }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // 首屏已存在的卡片：CSS 已预隐藏，首帧不会闪；首帧后立即收集(不必等 600ms)，避免首屏空白。
    requestAnimationFrame(collect);   // 首帧后立即补入场
    setTimeout(collect, 600);         // SPA 分批渲染兜底
    // 看门狗：极端情况下若仍有网格子项/弹窗卡在 opacity:0(computed)，强制显示，杜绝永久空白。
    // 不依赖 fntvIn 闸门——JS 已置 0 但未淡入成功的卡片也能被救回。
    setTimeout(() => {
      document.querySelectorAll('.fnos-tv-page ' + GRID_SEL + ' > *').forEach((c: any) => {
        if (getComputedStyle(c).opacity === '0') { c.dataset.fntvIn = '1'; c.style.opacity = '1'; }
      });
      document.querySelectorAll(MODAL_SEL).forEach((m: any) => {
        if (m.dataset.fnosUi === '1') return; // [lc-1072] 自建弹层不介入(见 collect 同款注释)
        if (getComputedStyle(m).opacity === '0') { m.dataset.fntvAnim = '1'; m.style.opacity = '1'; }
      });
    }, 1500);
    logger.info('[pageAnim] 全局动画观察者已安装（CSS 预隐藏 + 卡片错落 + 弹窗入场）');
  } catch (e: any) {
    logger.warn('[pageAnim] 观察者安装失败: ' + (e && e.message));
  }
}

function initPageAnim(): void {
  // 仅在飞牛影视 TV 页注入全局动画；系统页/登录页跳过
  if (!isFntvTvPage()) return;
  // [lc-1014] 性能模式：不注入预隐藏 CSS（卡片首帧即见, 无 FOUC 风险）也不装观察者。
  // 若用户随后关闭性能模式, 刷新页面后动画恢复（提示文案已注明）。
  if (perfMode()) { logger.info('[pageAnim] 性能模式开启, 跳过动画安装'); return; }
  // 注入 CSS 预隐藏规则：首帧前把网格卡片置 0，根治「点开详情页闪一下」(FOUC)。作用域限定 .fnos-tv-page。
  injectHideCSS();
  // 暴露工具出口（即便 anime 暂未就绪也先挂上，animeLib 同步注入后调用方即可用）
  (window as any).fntvAnim = toolkit();
  // animeLib 通常在前序插件中同步注入 window.anime；但为防加载顺序极端情况，短暂轮询等待就绪再装观察者。
  if (getAnime()) { setupObservers(); return; }
  let tries = 0;
  const t = window.setInterval(() => {
    tries++;
    if (getAnime()) { window.clearInterval(t); setupObservers(); }
    else if (tries > 20) {
      window.clearInterval(t);
      logger.warn('[pageAnim] 等待 anime.js 超时，降级为原生（无动画）');
      // 移除预隐藏 CSS，否则卡片会永久卡在 opacity:0(空白)。降级也要保证可见。
      const s = document.getElementById('fntv-page-anim-hide');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }
  }, 50);
}

registerHook(HookType.OnReady, initPageAnim);
