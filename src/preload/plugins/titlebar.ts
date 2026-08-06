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
//   (v327 的 LOGO_DATA_URI 是一段 blob JSON 描述字符串，不是有效图片 → img.src 加载失败)
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

  /* ═══ Mica 标题栏条 ═══ */
  const bar = document.createElement('div');
  bar.id = 'custom-titlebar';
  // [v374] 原生拖动: -webkit-app-region:drag (Chromium 原生, 仅移动窗口, 绝不放大)
  //   ⚠️ 关键: 元素自身不能带 backdrop-filter, 否则 app-region 命中测试失效 → 去掉 blur, 只用纯半透背景
  //   ⚠️ 关键: 必须 pointer-events:auto 才能接收 mousedown (之前 none 导致无法拖动)
  bar.style.cssText = `height:32px;width:100%;position:fixed;top:0;left:0;z-index:99999;pointer-events:auto;
    -webkit-app-region:drag;app-region:drag;
    border-top-left-radius:16px;border-top-right-radius:16px;
    background:var(--fnos-titlebar-bg,linear-gradient(180deg,rgba(249,249,249,.50) 0%,rgba(243,243,245,.34) 100%));
    border:none;transition:background .25s ease,border-radius .25s ease;`;

  /* 窗口控制右对齐 (no-drag 保证可点击) */
  const ctrls = document.createElement('div');
  ctrls.style.cssText = 'position:absolute;top:0;right:0;height:32px;display:flex;align-items:center;pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;padding-right:4px;gap:2px';
  ctrls.innerHTML = [
    '<button id="min-btn" style="background:transparent;border:none;width:46px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;transition:background .12s;">',
    '<svg width="10" height="1.5" viewBox="0 0 10 1.5" fill="none"><rect width="10" height="1.5" rx="0.75" fill="var(--fnos-titlebar-icon,#444)"/></svg></button>',
    '<button id="max-btn" style="background:transparent;border:none;width:46px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;transition:background .12s;">',
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="var(--fnos-titlebar-icon,#444)" stroke-width="1"/></svg></button>',
    '<button id="close-btn" style="background:transparent;border:none;width:46px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;transition:background .12s;">',
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="var(--fnos-titlebar-icon,#444)" stroke-width="1.2" stroke-linecap="round"/></svg></button>'
  ].join('');
  bar.appendChild(ctrls);

  document.body.appendChild(bar);

  /* ═══ 沉浸模式状态管理 ═══ */
  let _immersive = false;

  /** 切换标题栏沉浸模式(详情页全透明+白图标 vs 普通页半透Mica+深色图标) */
  const setImmersive = (on: boolean): void => {
    if (_immersive === on) return;
    _immersive = on;
    // 背景 & 圆角
    bar.style.background = on ? 'transparent' : 'var(--fnos-titlebar-bg,linear-gradient(180deg,rgba(249,249,249,.50) 0%,rgba(243,243,245,.34) 100%))';
    bar.style.borderTopLeftRadius = on ? '0' : '16px';
    bar.style.borderTopRightRadius = on ? '0' : '16px';
    // 图标颜色
    const iconColor = on ? '#ffffff' : 'var(--fnos-titlebar-icon,#444)';
    ctrls.querySelectorAll('svg').forEach((svg) => {
      svg.querySelectorAll('rect, path').forEach((el) => {
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
  const setupButtonHover = (): void => {
    const minBtn = document.getElementById('min-btn');
    const maxBtn = document.getElementById('max-btn');
    const closeBtn = document.getElementById('close-btn');
    if (!minBtn || !maxBtn || !closeBtn) return;

    const onEnter = (btn: HTMLElement) => {
      if (_immersive) {
        btn.style.background = btn.id === 'close-btn' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.15)';
      } else {
        btn.style.background = btn.id === 'close-btn'
          ? 'var(--fnos-titlebar-hover-close-bg,rgba(232,17,35,.10))'
          : 'var(--fnos-titlebar-hover-minmax,rgba(0,0,0,.05))';
      }
      // close hover 时图标变红(普通模式) / 保持白(沉浸模式)
      if (btn.id === 'close-btn' && !_immersive) {
        btn.querySelectorAll('svg path, svg rect').forEach(e =>
          (e as SVGElement).setAttribute('fill', 'var(--fnos-titlebar-hover-close-icon,#e81123)'));
      }
    };
    const onLeave = (btn: HTMLElement) => {
      btn.style.background = 'transparent';
      // 恢复基础图标颜色
      const iconColor = _immersive ? '#ffffff' : 'var(--fnos-titlebar-icon,#444)';
      btn.querySelectorAll('svg rect, svg path').forEach(el => {
        if (el instanceof SVGElement) {
          if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none')
            el.setAttribute('fill', iconColor);
          if (el.hasAttribute('stroke'))
            el.setAttribute('stroke', iconColor);
        }
      });
    };
    [minBtn, maxBtn, closeBtn].forEach(btn => {
      btn.addEventListener('mouseenter', () => onEnter(btn));
      btn.addEventListener('mouseleave', () => onLeave(btn));
    });
  };

  // 初始应用沉浸状态
  setImmersive(isDetailPage());
  setupButtonHover();

  // 路由切换时同步
  const syncTitleBarStyle = (): void => { setImmersive(isDetailPage()); };
  try {
    const _ps = history.pushState, _rs = history.replaceState;
    (history as any).pushState = function (...a: any[]) { _ps.apply(this, a as any); syncTitleBarStyle(); };
    (history as any).replaceState = function (...a: any[]) { _rs.apply(this, a as any); syncTitleBarStyle(); };
    window.addEventListener('popstate', syncTitleBarStyle);
    window.addEventListener('hashchange', syncTitleBarStyle);
  } catch (e) { logger.error('titlebar nav hook err', String(e).substring(0, 60)); }

  // 窗口控制点击事件
  document.getElementById('min-btn')?.addEventListener('click', () => ipcRenderer.send('window-minimize'));
  document.getElementById('max-btn')?.addEventListener('click', () => ipcRenderer.send('window-maximize'));
  document.getElementById('close-btn')?.addEventListener('click', () => ipcRenderer.send('window-close'));

  /* ═══ 飞牛影视 logo 注入(写死: 固定悬浮, 不依赖飞牛 DOM) ═══ */
  // [v367 修复] 旧逻辑把 logo 作为「导航栏子节点」插入, 飞牛 SPA 切换页面时重建导航栏 DOM,
  //   logo 一并被销毁 → 切到某些页面 logo 丢失.
  //   现改为: logo 永远挂在 document.body 顶层(飞牛只替换内容区, 动不了 body 直接子节点),
  //   用 position:fixed 固定在导航栏垂直中心(约 y=72px: body padding-top 32 + navbar 半高 40),
  //   不依赖飞牛任何原生 logo 元素, 切换任何页面都稳定显示.
  if (isFntvTvPage() && LOGO_DATA_URI && !document.getElementById('tb-logo')) {
    const logoImg = document.createElement('img');
    logoImg.id = 'tb-logo';
    logoImg.alt = '飞牛影视';
    logoImg.src = LOGO_DATA_URI;
    logoImg.draggable = false;
    const pinLogo = () => {
      logoImg.style.cssText =
        'height:30px;width:auto;object-fit:contain;display:block;position:fixed;top:72px;left:50%;transform:translate(-50%,-50%);z-index:99998;opacity:.96;pointer-events:none';
    };
    pinLogo();
    document.body.appendChild(logoImg);
    logger.info('Logo injected (pinned to body, fixed centered)');

    // [v375] 仅首页显示 logo: 非首页(详情/播放/列表/搜索/个人中心等)隐藏, 避免遮挡观看
    const isHomePage = (): boolean => {
      const href = location.href.toLowerCase();
      const path = (location.pathname || '/').toLowerCase();
      // 明确非首页的子路由/页面
      if (/\/v\/(tv|movie|anime|cartoon|documentary|variety|show)/.test(href)) return false; // 详情/播放
      if (/\/play($|\/|#)/.test(href) || /\/watch($|\/|#)/.test(href)) return false;          // 播放页
      if (/\/search/.test(href)) return false;                                                  // 搜索
      if (/\/(library|category|genre|channel|list|rank|ranking)/.test(href)) return false;     // 列表/分类
      if (/\/(mine|my|user|account|setting|settings|favorite|favourite|history|collection|subscribe)/.test(href)) return false; // 个人中心
      // 首页 = 路径层级浅(根或单段, 如 `/` `/home` `/recommend`); 多段子路由(如 `/v/tv/xxx`)视为非首页
      const segs = path.split('/').filter(Boolean);
      const home = segs.length <= 1;
      logger.info('[logo] isHomePage=', home, 'path=', path);
      return home;
    };
    const updateLogoVisibility = (): void => {
      logoImg.style.visibility = isHomePage() ? 'visible' : 'hidden';
    };
    updateLogoVisibility();

    // 轻量守护: 万一 logo 被飞牛极端行为意外移除, 每 4s 检查并重建到 body; 同时兜底同步可见性
    setInterval(() => {
      if (!document.getElementById('tb-logo') && document.body) {
        pinLogo();
        document.body.appendChild(logoImg);
      }
      updateLogoVisibility();
    }, 4000);

    // 路由切换时实时同步 logo 可见性(链式包装已有 pushState hook, 不破坏 embyWall 导航逻辑)
    try {
      const _ps = history.pushState, _rs = history.replaceState;
      (history as any).pushState = function (...a: any[]) { _ps.apply(this, a as any); updateLogoVisibility(); };
      (history as any).replaceState = function (...a: any[]) { _rs.apply(this, a as any); updateLogoVisibility(); };
      window.addEventListener('popstate', updateLogoVisibility);
      window.addEventListener('hashchange', updateLogoVisibility);
    } catch (e) { logger.error('logo nav hook err', String(e).substring(0, 60)); }
  }
}

registerHook(HookType.OnReady, injectTitleBar);
export {};
