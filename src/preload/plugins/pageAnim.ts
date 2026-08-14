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
//      首屏已存在卡片由 requestAnimationFrame(scanGrids) 立即补入场(不等 600ms)，并配 1500ms 看门狗防永久隐藏。
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

/** 列表/卡片错落入场（核心：opacity + translateY，绝不用 scale） */
function enterCards(els: any): void {
  const a = getAnime();
  if (!els || (els as any).length === 0) return;
  if (reducedMotion()) { Array.from(els as any).forEach((e: any) => (e.style.opacity = '1')); return; }
  if (!a) { Array.from(els as any).forEach((e: any) => (e.style.opacity = '1')); return; }
  try {
    a.animate(els, {
      opacity: [0, 1],
      translateY: [14, 0],
      delay: a.stagger(22),
      duration: 430,
      ease: 'outExpo',
    });
  } catch { /* ignore */ }
}

/** 整块内容轻入场：opacity + 轻微 translateY（不用 scale，平移对水平测量无影响） */
function revealContent(el: any): void {
  const a = getAnime();
  if (!el) return;
  if (reducedMotion()) { el.style.opacity = '1'; return; }
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
  if (reducedMotion()) { el.style.opacity = '1'; return; }
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

/** 安装「插入即动画」观察者：卡片网格新增卡片错落入场；弹窗打开接上入场动画。 */
function setupObservers(): void {
  const a = getAnime();
  if (!a) {
    logger.warn('[pageAnim] window.anime 未就绪，跳过全局动画（降级为原生）');
    return;
  }
  if (typeof MutationObserver === 'undefined') return;

  let pendingCards: HTMLElement[] = [];
  let pendingModals: HTMLElement[] = [];
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const cards = pendingCards;
    const modals = pendingModals;
    pendingCards = [];
    pendingModals = [];
    if (reducedMotion()) {
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

  const observe = (): void => {
    const obs = new MutationObserver((muts) => {
      if (!isFntvTvPage()) return;          // 系统页/登录页不介入
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        m.addedNodes.forEach((n) => {
          const el = n as HTMLElement;
          if (el.nodeType !== 1) return;
          // —— 弹窗 ——
          if (el.matches && el.matches(MODAL_SEL)) {
            if (el.dataset.fntvAnim !== '1') { el.dataset.fntvAnim = '1'; el.style.opacity = '0'; pendingModals.push(el); }
          } else if (el.querySelectorAll) {
            el.querySelectorAll(MODAL_SEL).forEach((x: any) => {
              if (x.dataset.fntvAnim !== '1') { x.dataset.fntvAnim = '1'; x.style.opacity = '0'; pendingModals.push(x); }
            });
          }
          // —— 卡片网格新增子项 ——（插入即置 0，下一帧统一淡入，杜绝闪烁）
          if (el.querySelectorAll) {
            el.querySelectorAll(GRID_SEL + ' > *').forEach((c: any) => {
              if (c.dataset.fntvIn === '1') return;
              if (typeof c.className === 'string' && (c.className.includes('fnos-') || c.className.includes('fntv-'))) return;
              if (c.closest && c.closest('.trim-ui__app-layout--window')) return; // 视频预览不介入
              c.dataset.fntvIn = '1';
              c.style.opacity = '0';
              pendingCards.push(c);
            });
          }
        });
      }
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  };

  try {
    observe();
    // 首屏已存在的卡片：CSS 已预隐藏，首帧不会闪；这里立即错落入场（不必等 600ms），避免首屏空白。
    const scanGrids = (): void => {
      if (!isFntvTvPage()) return;
      const grids = document.querySelectorAll(GRID_SEL) as any;
      const found: HTMLElement[] = [];
      grids.forEach((g: any) => {
        Array.from(g.children).forEach((c: any) => {
          if (c.dataset.fntvIn === '1') return;
          if (typeof c.className === 'string' && (c.className.includes('fnos-') || c.className.includes('fntv-'))) return;
          if (c.closest && c.closest('.trim-ui__app-layout--window')) return; // 视频预览不介入
          c.dataset.fntvIn = '1';
          c.style.opacity = '0';
          found.push(c);
        });
      });
      if (found.length) {
        pendingCards = pendingCards.concat(found);
        if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
      }
    };
    requestAnimationFrame(scanGrids);   // 首帧后立即补入场
    setTimeout(scanGrids, 600);         // SPA 分批渲染兜底
    // 看门狗：极端情况下(anime 未就绪 / observer 漏抓)若仍有卡片卡在 opacity:0，强制显示，避免永久隐藏。
    setTimeout(() => {
      const hidden = document.querySelectorAll('.fnos-tv-page ' + GRID_SEL + ' > *') as any;
      Array.from(hidden).forEach((c: any) => {
        if (getComputedStyle(c).opacity === '0' && c.dataset.fntvIn !== '1') { c.dataset.fntvIn = '1'; c.style.opacity = '1'; }
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
    else if (tries > 20) { window.clearInterval(t); logger.warn('[pageAnim] 等待 anime.js 超时，降级为原生（无动画）'); }
  }, 50);
}

registerHook(HookType.OnReady, initPageAnim);
