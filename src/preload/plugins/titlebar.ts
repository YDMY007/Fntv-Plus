// preload/plugins/titlebar.ts
// Win11 Mica 标题栏 + 窗口控制 + 飞牛影视本地 logo 注入
import { ipcRenderer } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import logger from '../core/logger';

// [v332 fix] 用 fs.readFileSync 读取本地 logo PNG，生成真正的 base64 data URI
//   (v327 的 LOGO_DATA_URI 是一段 blob JSON 描述字符串，不是有效图片 -> img.src 加载失败)
let LOGO_DATA_URI = '';
try {
  const logoBuf = fs.readFileSync(path.resolve(__dirname, '../../../build/iconfntv.png'));
  LOGO_DATA_URI = `data:image/png;base64,${logoBuf.toString('base64')}`;
  logger.info(`Logo loaded: ${Math.round(logoBuf.length / 1024)}KB`);
} catch (e) {
  logger.error('Failed to load local logo file', String(e));
}

/** 检测当前是否在一级详情页(TV/Movie 详情, 非 Season/播放) */
function isDetailPage(): boolean {
  const href = location.href.toLowerCase();
  return /\/v\/(tv|movie)\//.test(href) && !/\/season\//.test(href);
}

function injectTitleBar(): void {
  logger.info('Injecting custom title bar...');
  if (document.getElementById('custom-titlebar')) return;

  const nativePage = !isFntvTvPage();

  /* ═══ SVG 图标（共用）═══ */
  const minSvg = '<svg width="10" height="1.5" viewBox="0 0 10 1.5" fill="none"><rect width="10" height="1.5" rx="0.75" fill="currentColor"/></svg>';
  const maxSvg = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1"/></svg>';
  const closeSvg = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  if (nativePage) {
    /* ── 原生页：悬浮圆形小按钮组（右上角，不遮挡原生 UI） ── */
    const floatBar = document.createElement('div');
    floatBar.id = 'custom-titlebar';
    floatBar.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:999999;display:flex;gap:2px;pointer-events:auto;' +
      '-webkit-app-region:no-drag;app-region:no-drag;';

    const btnCss =
      'background:rgba(30,30,34,.72);border:1px solid rgba(255,255,255,.18);' +
      'width:32px;height:32px;border-radius:50%;display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;color:#ddd;transition:background .15s,color .15s;' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);';

    const makeBtn = (id: string, svg: string, hoverBg: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.innerHTML = svg;
      b.style.cssText = btnCss;
      b.addEventListener('mouseenter', function () { b.style.background = hoverBg; b.style.color = '#fff'; });
      b.addEventListener('mouseleave', function () { b.style.background = 'rgba(30,30,34,.72)'; b.style.color = '#ddd'; });
      return b;
    };

    floatBar.appendChild(makeBtn('min-btn', minSvg, 'rgba(255,255,255,.18)'));
    floatBar.appendChild(makeBtn('max-btn', maxSvg, 'rgba(255,255,255,.18)'));
    floatBar.appendChild(makeBtn('close-btn', closeSvg, 'rgba(232,17,35,.82)'));

    document.body.appendChild(floatBar);

    // [lc-377/lc-379] 原生页消除 body 白色亚克力背景露白(顶部/底部白边同一根因):
    //   主进程 ACRYLIC_CSS 给 body 设了 background:rgba(250,244,250,.68)+backdrop-filter 做 TV 页亚克力,
    //   但原生 fnOS 桌面自带不透明背景; body 白底会在内容没撑满视口时于顶/底间隙露出白边。
    //   原生页将 body 背景/模糊全部透明化, 让 fnOS 桌面自身背景透出 → 上下白边一并消除。
    //   均用 !important 压过主进程 insertCSS 注入的 !important 规则。
    document.body.style.setProperty('padding-top', '0', 'important');
    document.body.style.setProperty('background', 'transparent', 'important');
    document.body.style.setProperty('background-color', 'transparent', 'important');
    document.body.style.setProperty('backdrop-filter', 'none', 'important');
    document.body.style.setProperty('-webkit-backdrop-filter', 'none', 'important');

    // 点击事件
    document.getElementById('min-btn')?.addEventListener('click', function () { ipcRenderer.send('window-minimize'); });
    document.getElementById('max-btn')?.addEventListener('click', function () { ipcRenderer.send('window-maximize'); });
    document.getElementById('close-btn')?.addEventListener('click', function () { ipcRenderer.send('window-close'); });

    logger.info('Native page: floating window controls injected');
    return; // 原生页不需要标题栏/logo/沉浸模式
  }

  /* ═══ TV 页：Mica 标题栏条 ═══ */
  const bar = document.createElement('div');
  bar.id = 'custom-titlebar';
  bar.style.cssText = `height:32px;width:100%;position:fixed;top:0;left:0;z-index:99999;pointer-events:auto;
    -webkit-app-region:drag;app-region:drag;
    border-top-left-radius:16px;border-top-right-radius:16px;
    background:var(--fnos-titlebar-bg,transparent);
    border:none;transition:background .25s ease,border-radius .25s ease;`;

  /* 窗口控制右对齐 (no-drag 保证可点击) */
  const ctrls = document.createElement('div');
  ctrls.style.cssText = 'position:absolute;top:0;right:0;height:32px;display:flex;align-items:center;pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;padding-right:4px;gap:2px';
  const tvBtnIds = ['min-btn', 'max-btn', 'close-btn'];
  tvBtnIds.forEach(function (id, i) {
    const svgs = [minSvg, maxSvg, closeSvg];
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.innerHTML = svgs[i];
    btn.style.cssText = 'background:transparent;border:none;width:46px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;transition:background .12s;color:var(--fnos-titlebar-icon,#444);';
    ctrls.appendChild(btn);
  });
  bar.appendChild(ctrls);
  document.body.appendChild(bar);

  /* ═══ 沉浸模式状态管理 ═══ */
  let _immersive = false;

  /** 切换标题栏沉浸模式(详情页全透明+白图标 vs 普通页半透Mica+深色图标) */
  const setImmersive = function (on: boolean): void {
    if (_immersive === on) return;
    _immersive = on;
    // 背景 & 圆角: 标题栏保持透明, 直接透出与下方窗口一致的亚克力底(消除顶部白条色差)
    bar.style.background = 'transparent';
    bar.style.borderTopLeftRadius = on ? '0' : '16px';
    bar.style.borderTopRightRadius = on ? '0' : '16px';
    // 图标颜色
    const iconColor = on ? '#ffffff' : 'var(--fnos-titlebar-icon,#444)';
    ctrls.querySelectorAll('svg').forEach(function (svg) {
      svg.querySelectorAll('rect, path').forEach(function (el) {
        if (el instanceof SVGElement) {
          if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none')
            el.setAttribute('fill', iconColor);
          if (el.hasAttribute('stroke'))
            el.setAttribute('stroke', iconColor);
        }
      });
    });
    logger.info(`titlebar immersive=${on}`);
  };

  /** 统一 hover 逻辑: 根据 _immersive 状态动态选择颜色 */
  const setupButtonHover = function (): void {
    const minBtn = document.getElementById('min-btn');
    const maxBtn = document.getElementById('max-btn');
    const closeBtn = document.getElementById('close-btn');
    if (!minBtn || !maxBtn || !closeBtn) return;

    const onEnter = function (btn: HTMLElement): void {
      if (_immersive) {
        btn.style.background = btn.id === 'close-btn' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.15)';
      } else {
        btn.style.background = btn.id === 'close-btn'
          ? 'var(--fnos-titlebar-hover-close-bg,rgba(232,17,35,.10))'
          : 'var(--fnos-titlebar-hover-minmax,rgba(0,0,0,.05))';
      }
      // close hover 时图标变红(普通模式) / 保持白(沉浸模式)
      if (btn.id === 'close-btn' && !_immersive) {
        btn.querySelectorAll('svg path, svg rect').forEach(function (e) {
          (e as SVGElement).setAttribute('fill', 'var(--fnos-titlebar-hover-close-icon,#e81123)');
        });
      }
    };
    const onLeave = function (btn: HTMLElement): void {
      btn.style.background = 'transparent';
      // 恢复基础图标颜色
      const ic = _immersive ? '#ffffff' : 'var(--fnos-titlebar-icon,#444)';
      btn.querySelectorAll('svg rect, svg path').forEach(function (el) {
        if (el instanceof SVGElement) {
          if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none')
            el.setAttribute('fill', ic);
          if (el.hasAttribute('stroke'))
            el.setAttribute('stroke', ic);
        }
      });
    };
    [minBtn, maxBtn, closeBtn].forEach(function (btn) {
      btn.addEventListener('mouseenter', function () { onEnter(btn); });
      btn.addEventListener('mouseleave', function () { onLeave(btn); });
    });
  };

  // 初始应用沉浸状态
  setImmersive(isDetailPage());
  setupButtonHover();

  // 路由切换时同步
  const syncTitleBarStyle = function (): void { setImmersive(isDetailPage()); };
  try {
    const _ps = history.pushState, _rs = history.replaceState;
    (history as any).pushState = function (...a: any[]) { _ps.apply(this, a as any); syncTitleBarStyle(); };
    (history as any).replaceState = function (...a: any[]) { _rs.apply(this, a as any); syncTitleBarStyle(); };
    window.addEventListener('popstate', syncTitleBarStyle);
    window.addEventListener('hashchange', syncTitleBarStyle);
  } catch (e) { logger.error('titlebar nav hook err', String(e).substring(0, 60)); }

  // 窗口控制点击事件
  document.getElementById('min-btn')?.addEventListener('click', function () { ipcRenderer.send('window-minimize'); });
  document.getElementById('max-btn')?.addEventListener('click', function () { ipcRenderer.send('window-maximize'); });
  document.getElementById('close-btn')?.addEventListener('click', function () { ipcRenderer.send('window-close'); });

  /* ═══ 飞牛影视 logo 注入(写死: 固定悬浮, 不依赖飞牛 DOM) ═══ */
  // [v367 修复] 旧逻辑把 logo 作为「导航栏子节点」插入, 飞牛 SPA 切换页面时重建导航栏 DOM,
  //   logo 一并被销毁 -> 切到某些页面 logo 丢失.
  //   现改为: logo 永远挂在 document.body 顶层(飞牛只替换内容区, 动不了 body 直接子节点),
  //   用 position:fixed 固定在导航栏垂直中心(约 y=72px: body padding-top 32 + navbar 半高 40),
  //   不依赖飞牛任何原生 logo 元素, 切换任何页面都稳定显示.
  if (isFntvTvPage() && LOGO_DATA_URI && !document.getElementById('tb-logo')) {
    const logoImg = document.createElement('img');
    logoImg.id = 'tb-logo';
    logoImg.alt = '飞牛影视';
    logoImg.src = LOGO_DATA_URI;
    logoImg.draggable = false;
    const pinLogo = function (): void {
      logoImg.style.cssText =
        'height:30px;width:auto;object-fit:contain;display:block;position:fixed;top:72px;left:50%;transform:translate(-50%,-50%);z-index:99998;opacity:.96;pointer-events:none';
    };
    pinLogo();
    document.body.appendChild(logoImg);
    logger.info('Logo injected (pinned to body, fixed centered)');

    // [v375] 仅首页显示 logo: 非首页(详情/播放/列表/搜索/个人中心等)隐藏, 避免遮挡观看
    const isHomePage = function (): boolean {
      const href = location.href.toLowerCase();
      const pt = (location.pathname || '/').toLowerCase();
      // 明确非首页的子路由/页面
      if (/\/v\/(tv|movie|anime|cartoon|documentary|variety|show)/.test(href)) return false;
      if (/\/play($|\/|#)/.test(href) || /\/watch($|\/|#)/.test(href)) return false;
      if (/\/search/.test(href)) return false;
      if (/\/(library|category|genre|channel|list|rank|ranking)/.test(href)) return false;
      if (/\/(mine|my|user|account|setting|settings|favorite|favourite|history|collection|subscribe)/.test(href)) return false;
      // 首页 = 路径层级浅(根或单段)
      const segs = pt.split('/').filter(Boolean);
      const home = segs.length <= 1;
      return home;
    };
    const updateLogoVisibility = function (): void {
      logoImg.style.visibility = isHomePage() ? 'visible' : 'hidden';
    };
    updateLogoVisibility();

    // 轻量守护: 每 4s 检查并重建
    setInterval(function () {
      if (!document.getElementById('tb-logo') && document.body) {
        pinLogo();
        document.body.appendChild(logoImg);
      }
      updateLogoVisibility();
    }, 4000);

    // 路由切换时同步可见性
    try {
      const _ps2 = history.pushState, _rs2 = history.replaceState;
      (history as any).pushState = function (...a: any[]) { _ps2.apply(this, a as any); updateLogoVisibility(); };
      (history as any).replaceState = function (...a: any[]) { _rs2.apply(this, a as any); updateLogoVisibility(); };
      window.addEventListener('popstate', updateLogoVisibility);
      window.addEventListener('hashchange', updateLogoVisibility);
    } catch (e) { logger.error('logo nav hook err', String(e).substring(0, 60)); }
  }
}

registerHook(HookType.OnReady, injectTitleBar);
export {};
