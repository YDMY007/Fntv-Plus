// preload/plugins/titlebar.ts
// Win11 Mica 标题栏 + 窗口控制 + 飞牛影视本地 logo 注入
import { ipcRenderer } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import logger from '../core/logger';
// [lc-1046] 顶部 logo 自定义：预设(流媒体平台)/上传/恢复默认。本模块只单向依赖它的解析器，
//   把默认 logo dataURI 登记过去；设置卡片在 customLogo.ts 内自行注入(#fnos-appearance-ctrl 锚点)。
import { registerDefaultLogo, resolveLogoSrc } from './customLogo';

// [v332 fix] 用 fs.readFileSync 读取本地 logo PNG，生成真正的 base64 data URI
//   (v327 的 LOGO_DATA_URI 是一段 blob JSON 描述字符串，不是有效图片 -> img.src 加载失败)
let LOGO_DATA_URI = '';
try {
  const logoBuf = fs.readFileSync(path.resolve(__dirname, '../../../build/iconfntv.png'));
  LOGO_DATA_URI = `data:image/png;base64,${logoBuf.toString('base64')}`;
  registerDefaultLogo(LOGO_DATA_URI); // [lc-1046] 「恢复默认」据此还原
  logger.info(`Logo loaded: ${Math.round(logoBuf.length / 1024)}KB`);
} catch (e) {
  logger.error('Failed to load local logo file', String(e));
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

    /* ── [lc-556] 原生页顶部拖拽区域：允许通过窗口顶部拖动窗口 ──
       TV 页有 32px 高的 drag bar(第91行)，但原生页(登录页等)之前只注入了按钮、没有 drag 区域
       → 点击窗口控制栏附近无法拖动窗口。新增一个全宽 36px 的透明 drag 层，
       z-index 低于 floatBar 确保按钮可点击。 */
    const dragRegion = document.createElement('div');
    dragRegion.id = 'fntv-native-drag';
    dragRegion.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:36px;z-index:999998;' +
      '-webkit-app-region:drag;app-region:drag;' +
      'pointer-events:auto;';
    document.body.appendChild(dragRegion);

    /* ── [lc-556] 原生页去掉窗口圆角：ACRYLIC_CSS 给 html 加了全局 border-radius:16px+clip-path,
       在登录页等原生页会裁出难看的圆角(内容被裁掉)。用更高优先级覆盖回直角。 ── */
    const noCornerStyle = document.createElement('style');
    noCornerStyle.id = 'fntv-native-nocorner';
    noCornerStyle.textContent = `
      html{border-radius:0!important;clip-path:none!important;-webkit-clip-path:none!important;}
      body{border-radius:0!important;}
    `;
    document.head.appendChild(noCornerStyle);

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

  /* ═══ TV 页：Mica 标题栏条 ═══
     [lc-992] data-fntv-tb 是「这是 TV 页那条 32px 拖拽条」的唯一判别标记：
     原生页分支复用同一个 id #custom-titlebar，形态却是右上角浮动圆形按钮组(自带深色磨砂底)，
     CSS 只认 id 会在「开机停在登录页 → 登录后进 TV 页」这条路径上把浮动按钮组当条来刷。
     用 data-* 而不是新增 class 名：glassUI 的组件级玻璃规则全靠 [class*="card"] 之类子串匹配，
     data 属性它一个都不匹配 → 不需要过那份 token 清单。
     条本身刻意不设 background：详情页的底色由 beautifyStyle.ts 的 M 段画在 ::before 上
     (glassUI 的 html[data-fntv-glass] .fnos-tv-page body > div{background:transparent!important}
      会直接命中本条，画在伪元素上就根本不被那条规则匹配)。圆角恒 16px：fixed 层不受 html
     的 overflow/clip-path 裁剪(见 mainwin.ts ACRYLIC_CSS 注释)，条一旦有不透明底色就必须自己圆角。 */
  const bar = document.createElement('div');
  bar.id = 'custom-titlebar';
  bar.dataset.fntvTb = 'bar';
  bar.style.cssText = `height:32px;width:100%;position:fixed;top:0;left:0;z-index:99999;pointer-events:auto;
    -webkit-app-region:drag;app-region:drag;
    border-top-left-radius:16px;border-top-right-radius:16px;`;

  /* 窗口控制右对齐 (no-drag 保证可点击) */
  const ctrls = document.createElement('div');
  ctrls.style.cssText = 'position:absolute;top:0;right:0;height:32px;display:flex;align-items:center;pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;padding-right:4px;gap:2px';
  const tvBtnIds = ['min-btn', 'max-btn', 'close-btn'];
  const tvBtnSvgs = [minSvg, maxSvg, closeSvg];
  tvBtnIds.forEach(function (id, i) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.innerHTML = tvBtnSvgs[i];
    ctrls.appendChild(btn);
  });
  bar.appendChild(ctrls);
  document.body.appendChild(bar);

  /* ═══ [lc-992] 标题栏配色样式表：CSS 独占配色权，JS 只负责建节点 ═══
     旧版为何必须删：setImmersive 用 setAttribute 改 SVG 的 fill|stroke、setupButtonHover 用
     style.background 改 hover 底色 —— presentation attribute 和 inline style 的优先级都高于样式表，
     CSS 想让控件跟随封面取色就得和 JS 对打(embyWall.ts 的 [lc-925] 已经栽过一次：
     它写的 inline !important 直接压过 lc-989 的 stylesheet !important)。
     顺带修掉一个从来没生效过的真 bug：close hover 想变红，却去给 closeSvg 的
     「M2 2L8 8M8 2L2 8」开放描边路径设 fill —— 开放路径填色不可见，正确做法是改 color
     让 stroke="currentColor" 跟着变。
     基础色/hover 全走 theme.ts 的 --fnos-titlebar-* 变量：详情页只需在 body.fnos-beautify 上
     重定义同一批变量(beautifyStyle.ts 的 M 段)即可整体跟随封面取色，零 !important 对抗、
     零时序问题，关掉「详情页美化」开关或离开详情页时随 class 移除自动回落。 */
  const tbStyle = document.createElement('style');
  tbStyle.id = 'fntv-titlebar-css';
  tbStyle.textContent = `
#custom-titlebar[data-fntv-tb] button{
  background:transparent;border:none;width:46px;height:32px;padding:0;
  display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;
  transition:background-color .12s ease,color .12s ease;
  color:var(--fnos-titlebar-icon,#444);
}
#custom-titlebar[data-fntv-tb] button:hover{
  background:var(--fnos-titlebar-hover-minmax,rgba(0,0,0,.05));
}
#custom-titlebar[data-fntv-tb] #close-btn:hover{
  background:var(--fnos-titlebar-hover-close-bg,rgba(232,17,35,.10));
  color:var(--fnos-titlebar-hover-close-icon,#e81123);
}
`;
  (document.head || document.documentElement).appendChild(tbStyle);

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
    // [lc-1046] src 用自定义解析结果（默认/预设/上传；解析不出回落本文件默认图）
    logoImg.src = resolveLogoSrc() || LOGO_DATA_URI;
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
