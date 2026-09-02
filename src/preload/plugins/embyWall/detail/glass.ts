import { S } from '../state';
import { log } from '../log';

// embyWall/detail/glass.ts — 详情页苹果液态玻璃：全屏底图、蒙版、透明化、安全选择器
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

/* ========== 详情页苹果液态玻璃 (TV详情 / Season详情) ========== */

// [lc-879] 二级(TV/Movie)详情页全屏底图: 横屏海报铺满视口作为背景
let _tvBackdropImg: HTMLDivElement | null = null;
let _tvHeaderEl: HTMLElement | null = null;     // 命中海报来源元素(诊断用)
let _tvBackdropScrim: HTMLDivElement | null = null;   // 全屏渐变蒙版(保证文字可读)
let _tvBlurImg: HTMLImageElement | null = null;       // 预留(当前不隐藏原图)
let _tvBgEl: HTMLElement | null = null;               // 预留(当前不隐藏原图)
let _tvBackdropStyle: HTMLStyleElement | null = null; // [lc-890] 透明化页面背景的 <style>
let _tvBackdropDiagDone = false;                      // [lc-891] 残留不透明元素诊断(每详情页只跑一次)

/** 检测当前URL是否为需要液态玻璃的详情页 */
export function isDetailPage(): boolean {
  return /\/v\/(tv|movie)\/[a-f0-9]{32}($|\/)/.test(location.href)
    || /\/v\/(tv|movie)\/season\/[a-f0-9]{32}/.test(location.href);
}

/** 对 TV/Movie 详情页 (/v/tv/:id, /v/movie/:id) 应用液态玻璃 — 通透轻量版 */
function applyTvDetailGlass(): void {
  const header = document.querySelector('.trim-mc__details--key-version') as HTMLElement | null;
  if (!header) return;
  log('applyTvDetailGlass: header found');

  // ₀ 原生导航栏沉浸: 全透明+无模糊, 不遮挡背景剧照
  //   选择器对应 mainwin.ts ⑦ 的 fnOS 原生导航栏(div.relative.z-20.flex...px-11.py-5)
  const nativeNav = document.querySelector('div.relative.z-20.flex.items-center.justify-between.px-11.py-5') as HTMLElement | null;
  if (nativeNav) {
    nativeNav.style.setProperty('background', 'transparent', 'important');
    nativeNav.style.setProperty('backdrop-filter', 'none', 'important');
    nativeNav.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    nativeNav.style.setProperty('box-shadow', 'none', 'important');
    nativeNav.style.setProperty('border', 'none', 'important');
    log('detail -> native nav immersive (transparent)');
  }

  // ① 头部渐变遮罩: 极轻量 — 保持背景图清晰可见,仅底部做淡淡过渡
  const gradient = header.querySelector('.gradient') as HTMLElement | null;
  if (gradient) {
    // 关键改动: 从"厚重白雾"改为"几乎透明的微妙融合"
    // 上方完全透出原图,底部仅极淡淡的暗→亮过渡(用于文字可读性)
    gradient.style.setProperty('background',
      'var(--fnos-detail-grad)', 'important');
    gradient.style.setProperty('height', '100%', 'important');       // 恢复全高
    gradient.style.setProperty('backdrop-filter', 'blur(1px) saturate(105%)', 'important');
    gradient.style.setProperty('-webkit-backdrop-filter', 'blur(1px) saturate(105%)', 'important');
  }

  // ② 标题: 文字清晰可读 — 柔和投影确保在任何背景色上都能看清
  const h2 = header.querySelector('h2') as HTMLElement | null;
  if (h2) {
    h2.style.setProperty('text-shadow',
      '0 1px 3px rgba(0,0,0,.35),0 0 1px rgba(0,0,0,.2)', 'important');
    h2.style.setProperty('color', '#fff', 'important');
    h2.style.setProperty('font-weight', '700', 'important');
  }

  // ③ 简介/描述: 轻玻璃卡片 — 低不透明度+模糊=真·通透
  const descArea = findDescArea(header);
  if (descArea) {
    descArea.style.setProperty('background',
      'var(--fnos-detail-desc)', 'important');
    descArea.style.setProperty('backdrop-filter', 'blur(20px) saturate(140%) brightness(1.02)', 'important');
    descArea.style.setProperty('-webkit-backdrop-filter', 'blur(20px) saturate(140%) brightness(1.02)', 'important');
    descArea.style.setProperty('border-radius', '14px', 'important');
    descArea.style.setProperty('border', '1px solid var(--fnos-detail-desc-border)', 'important');
    descArea.style.setProperty('box-shadow',
      '0 4px 24px rgba(31,41,90,.04),inset 0 .5px 0 rgba(255,255,255,.4)',
      'important');
    descArea.style.setProperty('padding', '18px 24px', 'important');
    descArea.style.setProperty('margin-top', '8px', 'important');
  }

  // ④ 季/集卡片: 轻量液态玻璃（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const cards = header.parentElement?.querySelectorAll('.card-root');
  cards?.forEach((card) => {
    const el = card as HTMLElement;
    if (S.detailBoxless) {
      // 关闭背景框：移除全部注入的玻璃样式，回退到 fnOS 原生外观
      el.style.removeProperty('background');
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('border');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('transition');
      el.style.removeProperty('transform');
      return;
    }
    el.style.setProperty('background',
      'var(--fnos-detail-card)', 'important');
    el.style.setProperty('backdrop-filter', 'blur(16px) saturate(135%)', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'blur(16px) saturate(135%)', 'important');
    el.style.setProperty('border-radius', '14px', 'important');
    el.style.setProperty('border', '1px solid var(--fnos-detail-card-border)', 'important');
    el.style.setProperty('box-shadow',
      'var(--fnos-detail-shadow-1)',
      'important');
    el.style.setProperty('transition', 'transform .25s ease, box-shadow .25s ease', 'important');

    el.addEventListener('mouseenter', () => {
      if (S.detailBoxless) return; // 关闭背景框时悬停不再加玻璃阴影
      el.style.setProperty('transform', 'translateY(-3px) scale(1.015)', 'important');
      el.style.setProperty('box-shadow',
        '0 10px 32px rgba(91,140,255,.12),0 1px 0 rgba(255,255,255,.6)',
        'important');
    });
    el.addEventListener('mouseleave', () => {
      if (S.detailBoxless) return;
      el.style.removeProperty('transform');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-1)',
        'important');
    });
  });

  // ⑤ 操作按钮行: 极简玻璃条
  const actionBar = header.parentElement?.querySelector('.flex.min-h-\\[54px\\]') as HTMLElement | null;
  if (actionBar && actionBar.parentElement) {
    const barWrap = actionBar.parentElement as HTMLElement;
    barWrap.style.setProperty('background',
      'var(--fnos-detail-bar)', 'important');
    barWrap.style.setProperty('backdrop-filter', 'blur(18px) saturate(135%)', 'important');
    barWrap.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(135%)', 'important');
    barWrap.style.setProperty('border-radius', '14px', 'important');
    barWrap.style.setProperty('border', '1px solid var(--fnos-detail-bar-border)', 'important');
    barWrap.style.setProperty('box-shadow',
      '0 3px 18px rgba(31,41,90,.04),inset 0 .5px 0 rgba(255,255,255,.4)',
      'important');
    barWrap.style.setProperty('padding', '12px 18px', 'important');
  }

  // ⑥ 原生播放按钮: 半透明白底(适配浅色/透明详情页背景, 保证可辨识度)
  const nativePlayBtns = header.parentElement?.querySelectorAll('button[class*="primary"], .semi-button--primary, [class*="btn-primary"], a[class*="play"]') ?? [];
  for (const btn of Array.from(nativePlayBtns)) {
    const el = btn as HTMLElement;
    if (el.classList.contains('fnos-play')) continue; // 跳过我们自己的按钮
    el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
    el.style.setProperty('border', '1px solid rgba(255,255,255,.35)', 'important');
    el.style.setProperty('border-radius', '10px', 'important');
    el.style.setProperty('color', '#333', 'important');
    el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    el.style.setProperty('font-weight', '500', 'important');
    el.addEventListener('mouseenter', () => {
      if (!el.dataset.glassHover) { el.dataset.glassHover = '1';
        el.style.setProperty('background', 'rgba(255,255,255,.75)', 'important');
        el.style.setProperty('border-color', 'rgba(255,255,255,.5)', 'important');
        el.style.setProperty('box-shadow', '0 2px 10px rgba(0,0,0,.12)', 'important');
      }
    }, { once: false });
    el.addEventListener('mouseleave', () => {
      delete el.dataset.glassHover;
      el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
      el.style.setProperty('border-color', 'rgba(255,255,255,.35)', 'important');
      el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    }, { once: false });
  }
}

/** [lc-879] 二级(TV/Movie)详情页: 把 header 内的横屏海报(背景剧照)铺满视口作为全屏底图,
 *  降低一点点透明度(opacity:.9), 并叠一层轻渐变蒙版保证标题/简介/选集文字可读。
 *  仅创建一次 DOM, 之后仅在图片变化时更新 background-image; 离开详情页由 removeFullscreenBackdrop 清理。 */
/** [lc-883] 全屏底图: 自包含(不依赖子函数 header 检测), 全局搜索横屏海报。
 *  从 applyDetailLiquidGlass 统一调用, tv/season 两条路径都走这里。 */

/** [lc-892] 安全选择器: 任何无效选择器(如含未转义括号的 Tailwind class)都不抛出,
 *  仅记日志返回空结果, 避免单个坏选择器 abort 整个全屏底图逻辑(此前此类 SyntaxError 直接中断函数)。 */
function safeSelectAll<T extends Element = Element>(sel: string): NodeListOf<T> {
  try { return document.querySelectorAll(sel) as NodeListOf<T>; }
  catch (e) { log('safeSelectAll: 跳过无效选择器 ' + sel.substring(0, 50)); return document.createElement('div').querySelectorAll('*') as NodeListOf<T>; }
}
export function safeSelect<T extends Element = Element>(sel: string): T | null {
  try { return document.querySelector(sel) as T | null; }
  catch (e) { log('safeSelect: 跳过无效选择器 ' + sel.substring(0, 50)); return null; }
}

export function ensureFullscreenBackdrop(): void {
  // ① 定位横屏海报(背景剧照)的来源与 URL。fnOS 不同版本/页面渲染方式不一, 多路回退:
  //    a) 全局 img[style*="blur"] (TV/Movie 与 Season 详情页同一套结构, 最常见)
  //    b) 常见 header/hero 候选选择器自身的 background-image
  //    c) header 候选内子元素带「接近全宽」的 background-image(横幅底图 div)
  //    d) 全局大尺寸 <img>(宽>视口40% 且高>150px, 排除缩略图)
  //    e) document.body 背景图(兜底, fnOS 可能把底图放 body 上)
  let imgUrl: string | null = null;
  let fromImg: HTMLImageElement | null = null;
  let bgEl: HTMLElement | null = null;

  const bgUrlOf = (cs: CSSStyleDeclaration): string | null => {
    const m = (cs.backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
    return (m && m[1] && m[1] !== 'none') ? m[1] : null;
  };

  // 路径 a: 全局模糊背景图 img
  const blurImgs = safeSelectAll<HTMLImageElement>('img[style*="blur"]');
  for (const bi of Array.from(blurImgs)) {
    const u = bi.getAttribute('src') || (bi as any).currentSrc || '';
    if (u && bi.getBoundingClientRect().width > 200) {
      imgUrl = u; fromImg = bi; _tvHeaderEl = bi;
      log('ensureFullscreenBackdrop: 路径a命中 img[style*="blur"]');
      break;
    }
  }

  // 路径 b: 常见 header/hero 候选选择器自身 background-image
  if (!imgUrl) {
    const hdrCands = safeSelectAll<HTMLElement>('.trim-mc__details--key-version,.semi-always-dark,header,[class*="hero"],[class*="details--key"],[class*="backdrop"]');
    for (const c of Array.from(hdrCands)) {
      const m = bgUrlOf(getComputedStyle(c));
      if (m) { imgUrl = m; bgEl = c; _tvHeaderEl = c; log('ensureFullscreenBackdrop: 路径b命中 header bg(c=' + (c.className || '').substring(0, 60) + ')'); break; }
    }
  }

  // 路径 c: header 候选内子元素大尺寸 background-image(横幅底图 div)
  if (!imgUrl) {
    const hdrCands2 = safeSelectAll<HTMLElement>('.trim-mc__details--key-version,.semi-always-dark,header,[class*="hero"],[class*="details--key"],[class*="backdrop"]');
    for (const c of Array.from(hdrCands2)) {
      const subs = c.querySelectorAll('div,section,span,a,p') as NodeListOf<HTMLElement>;
      for (const sub of Array.from(subs)) {
        const cs = getComputedStyle(sub);
        const mm = bgUrlOf(cs);
        if (mm && cs.backgroundSize !== 'contain' && cs.backgroundSize !== 'auto') {
          const r = sub.getBoundingClientRect();
          if (r.width > Math.max((c.offsetWidth || 400) * 0.6, 300)) {
            imgUrl = mm; bgEl = sub; _tvHeaderEl = c;
            log('ensureFullscreenBackdrop: 路径c命中子元素bg(w=' + Math.round(r.width) + ')');
            break;
          }
        }
      }
      if (imgUrl) break;
    }
  }

  // 路径 d: 全局大尺寸 <img>
  if (!imgUrl) {
    const allImgs = safeSelectAll<HTMLImageElement>('img');
    for (const im of Array.from(allImgs)) {
      const r = im.getBoundingClientRect();
      const u = im.getAttribute('src') || im.currentSrc || '';
      if (u && r.width > Math.max(400, window.innerWidth * 0.4) && r.height > 150) {
        imgUrl = u; fromImg = im; _tvHeaderEl = im;
        log('ensureFullscreenBackdrop: 路径d命中大img(w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ')');
        break;
      }
    }
  }

  // 路径 f: 任意带 background-image 的大尺寸元素(兜底, fnOS 可能把横屏海报放在某个 div 的 background 上)
  if (!imgUrl) {
    let best: { url: string; area: number } | null = null;
    const allEls = safeSelectAll<HTMLElement>('div,section,header,main,article,aside');
    for (const el of Array.from(allEls)) {
      const m = bgUrlOf(getComputedStyle(el));
      if (!m) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width > Math.max(300, window.innerWidth * 0.3) && (!best || area > best.area)) {
        best = { url: m, area }; bgEl = el; _tvHeaderEl = el;
      }
    }
    if (best) { imgUrl = best.url; log('ensureFullscreenBackdrop: 路径f命中 background-image 大元素(w=' + Math.round((bgEl as HTMLElement).getBoundingClientRect().width) + ')'); }
  }

  // 路径 e: document.body 背景图(兜底)
  if (!imgUrl) {
    const bodyUrl = bgUrlOf(getComputedStyle(document.body));
    if (bodyUrl) { imgUrl = bodyUrl; bgEl = document.body; _tvHeaderEl = document.body; log('ensureFullscreenBackdrop: 路径e命中 body bg'); }
  }

  if (!imgUrl) {
    log('ensureFullscreenBackdrop: ⚠️ 全部 5 路回退均未找到横屏海报! childImgCount=', document.querySelectorAll('img').length);
    return;
  }
  log('ensureFullscreenBackdrop: 找到海报URL, 长度=', imgUrl.length, ', 来源=', fromImg ? 'img' : bgEl ? 'bgEl' : '?');

  // ② 全屏底图层(只创建一次, 之后仅更新图片)
  if (!_tvBackdropImg) {
    _tvBackdropImg = document.createElement('div');
    _tvBackdropImg.className = 'fnos-tv-backdrop-img';
    _tvBackdropImg.style.cssText =
      'position:fixed;inset:0;z-index:-1;pointer-events:none;' +
      'background-repeat:no-repeat;background-size:cover;background-position:center;' +
      'opacity:.92;filter:blur(48px) saturate(120%) brightness(.92);' +
      'transition:opacity .3s ease;';
    document.body.appendChild(_tvBackdropImg);

    _tvBackdropScrim = document.createElement('div');
    _tvBackdropScrim.className = 'fnos-tv-backdrop-scrim';
    const _isDark = document.documentElement.classList.contains('dark');
    const _scrim = _isDark
      ? 'linear-gradient(to bottom,rgba(8,10,18,.46) 0%,rgba(8,10,18,.30) 32%,rgba(8,10,18,.62) 100%)'
      : 'linear-gradient(to bottom,rgba(255,255,255,.46) 0%,rgba(255,255,255,.30) 32%,rgba(255,255,255,.62) 100%)';
    _tvBackdropScrim.style.cssText =
      'position:fixed;inset:0;z-index:-1;pointer-events:none;' +
      'background:' + _scrim + ';';
    document.body.appendChild(_tvBackdropScrim);
    log('ensureFullscreenBackdrop: ✅ 创建全屏底图层 (theme=' + (_isDark ? 'dark' : 'light') + ')');
  }
  _tvBackdropImg.style.setProperty('background-image', `url("${imgUrl}")`, 'important');

  // [lc-890] 关键修复: 仅加 z-index:-1 固定层会被 fnOS 不透明页面背景(html/body/内容容器)
  //   完全遮挡 → 用户看到"海报没全屏"。这里把详情页所有页面级不透明背景透明化,
  //   让全屏底图真正透出; 本插件用 inline!important 设置的玻璃元素(导航/卡片/简介/按钮等)
  //   优先级更高会保留, 仅 fnOS 原生纯色背景被清掉。离开详情页移除 body 类即自动还原。
  ensureDetailBackdropTransparency();

  // [lc-891] 诊断: 每详情页只跑一次, 列出仍不透明的全宽元素 + body/root 背景, 便于真机反馈定位
  if (!_tvBackdropDiagDone) {
    _tvBackdropDiagDone = true;
    const root2 = document.getElementById('root');
    log('ensureFullscreenBackdrop: diag bodyBg=' + getComputedStyle(document.body).backgroundColor
      + ' rootBg=' + (root2 ? getComputedStyle(root2).backgroundColor : 'n/a'));
    const stuck: string[] = [];
    document.querySelectorAll('body *').forEach((e) => {
      const el = e as HTMLElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const opaqueColor = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const opaqueImg = !!cs.backgroundImage && cs.backgroundImage !== 'none';
      if (r.width > window.innerWidth * 0.5 && (opaqueColor || opaqueImg)) {
        stuck.push((el.className || '').toString().substring(0, 40) + '|bc=' + cs.backgroundColor + '|bi=' + (cs.backgroundImage || '').substring(0, 24));
      }
    });
    if (stuck.length) log('ensureFullscreenBackdrop: ⚠️ 仍不透明全宽元素(前6)= ' + stuck.slice(0, 6).join(' || '));
    else log('ensureFullscreenBackdrop: ✅ 未检测到残留不透明全宽元素');
  }
}

/** [lc-890/891] 让全屏底图(z-index:-1 固定层)真正透出: 清除 fnOS 详情页的页面级不透明背景。
 *  机制: 给 html/body 加 .fnos-detail-backdrop 类, 注入一条
 *    html.fnos-detail-backdrop, body.fnos-detail-backdrop, body.fnos-detail-backdrop * (含 ::before/::after)
 *    { background-color: transparent !important; background-image: none !important; }
 *  规则。fnOS 详情页的不透明遮罩多为「渐变 background-image」(非纯色)或伪元素, 仅清 background-color(lc-890)无效,
 *  故 lc-891 改为连 background-image 与伪元素一并清空 → 底图透出。
 *  本插件用 inline!important 设置的玻璃元素(导航/卡片/简介/按钮/底图层自身)优先级更高保留;
 *  hero 头部的原生海报是 <img>(非 CSS 背景)不受影响。离开详情页移除类即全部还原。 */
function ensureDetailBackdropTransparency(): void {
  if (!_tvBackdropStyle) {
    _tvBackdropStyle = document.createElement('style');
    _tvBackdropStyle.className = 'fnos-detail-backdrop-style';
    // [lc-959] 收窄透明规则: 仅清「页面级不透明背景」(html/body + 浅层结构容器)让全屏底图透出,
    //   不再把 background-image:none 作用到所有后代 —— 旧规则会误删 fnOS 用 CSS background-image 承载的
    //   缩略图/海报(部分 fnOS 版本), 表现为详情页图全空。内容卡片只清 background-color(坐玻璃透出底图,
    //   卡片自身更高 specificity 的 bg 规则会覆盖, 不受影响); 排除本项目注入的底层图层(fnos-tv-backdrop-*)与所有 fnos-* 元素。
    _tvBackdropStyle.textContent =
      'html.fnos-detail-backdrop,' +
      'body.fnos-detail-backdrop,' +
      'body.fnos-detail-backdrop > *:not(.fnos-tv-backdrop-img):not(.fnos-tv-backdrop-scrim),' +
      'body.fnos-detail-backdrop > * > *:not([class*="fnos-"])' +
      '{ background-color: transparent !important; background-image: none !important; }' +
      'body.fnos-detail-backdrop *' +
      '{ background-color: transparent !important; }';
    (document.head || document.documentElement).appendChild(_tvBackdropStyle);
    log('ensureDetailBackdropTransparency: 已注入透明背景样式');
  }
  document.documentElement.classList.add('fnos-detail-backdrop');
  document.body.classList.add('fnos-detail-backdrop');
}

export function removeFullscreenBackdrop(): void {
  if (_tvBackdropImg) { _tvBackdropImg.remove(); _tvBackdropImg = null; }
  if (_tvBackdropScrim) { _tvBackdropScrim.remove(); _tvBackdropScrim = null; }
  if (_tvBlurImg) {
    _tvBlurImg.style.removeProperty('opacity');
    _tvBlurImg.style.removeProperty('visibility');
    _tvBlurImg = null;
  }
  if (_tvBgEl) {
    _tvBgEl.style.removeProperty('background-image');
    _tvBgEl = null;
  }
  // [lc-890] 还原: 移除透明化类(页面级背景自动还原), 并移除注入的 <style>
  document.documentElement.classList.remove('fnos-detail-backdrop');
  document.body.classList.remove('fnos-detail-backdrop');
  if (_tvBackdropStyle) { _tvBackdropStyle.remove(); _tvBackdropStyle = null; }
  _tvBackdropDiagDone = false; // [lc-891] 允许下次进详情页重新诊断
}

/** 查找简介区域的辅助函数 */
function findDescArea(header: HTMLElement): HTMLElement | null {
  let desc = document.querySelector('.text-justify.text-\\[15px\\]') as HTMLElement | null;
  if (desc) return desc;
  desc = header.parentElement?.querySelector('.px-\\[44px\\]') as HTMLElement | null;
  if (desc) return desc;
  const allDivs = header.parentElement?.querySelectorAll('div');
  if (allDivs) {
    for (const d of Array.from(allDivs)) {
      if ((d.textContent || '').length > 80 && d.children.length < 4 && !d.querySelector('img')) {
        return d as HTMLElement;
      }
    }
  }
  return null;
}

/** 沉浸式季详情样式表（参照 season-immersive-preview.html 模板）：
 *  Hero 圆角沉浸卡；选集由横向滚动改为「缩略图左 + 信息右」的纵向卡片列表；标题强调。
 *  仅作用于 .fnos-immersive-season（由 applySeasonImmersiveDetail 在季详情页挂到 body）。
 *  与「关闭背景框」(S.detailBoxless) 互斥：开启时仅移除 body 类，还原 fnOS 原生外观。 */