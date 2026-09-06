import { ABOUT_LINK_URL, openFeedbackChoiceModal } from './embyWall/modals/feedback';
import { UiThemeMode, applyUiTheme, getEffectiveDark, getUiTheme, injectUiThemeStyle, removeThemeModeSetting, setUiTheme } from './embyWall/theme';
import { applyCarouselLogoNow, backfillDetailLogo } from './embyWall/carousel/logo';
import { applyLoginBgVar } from './embyWall/login';
import { destroyCarousel, findMediaLibrarySection, injectCarousel, isModalOpen, resumeCarousel } from './embyWall/carousel/render';
import { fntvOpenPatchApplyPopup } from './embyWall/modals/patch';
import { injectExternalPlayButton, injectNativeReturnButton, injectVideoPreviewExternalPlay } from './embyWall/nav/inject';
import { isDetailPage } from './embyWall/detail/glass';
import { applyDetailBeautify, teardownDetailBeautify } from './embyWall/detail/immersive';
import { scheduleEpBackfill, ensureEpFixButton } from './embyWall/detail/epBackfill';
import { runPageTransition } from './embyWall/detail/veil';
import { epResolutionDiag } from './embyWall/detail/epResolution';
import { wheelToScroll } from './embyWall/nav/scroll';
import { fetchShowsViaIPC, setOnShowsReady } from './embyWall/carousel/api';

// preload/plugins/embyWall.ts
//
// ─── 这个文件是「入口编排层」，不是功能实现层 ───
// 原 12496 行巨石文件已按职责拆分到 ./embyWall/ 目录下（见 ./embyWall/README.md 拆分说明书）。
// 本文件保留三样东西：
//   ① 全局一次性初始化（登录页背景、自动跳影视、matchMedia 拦截、调试过滤）
//   ② 各功能模块的 import 装配
//   ③ handle() 主流程编排：把导航/轮播/详情/设置面板/顶栏等模块按事件串起来
//
// 改功能的正确姿势：先进 ./embyWall/ 找对应模块，不要在入口文件里加实现。
// 唯一例外：跨模块的「编排逻辑」（比如"进详情页要先停轮播再上玻璃背景"）属于本文件。
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import { getLang, setLang } from '../core/i18n'; // [lc-1065] 设置面板语言切换
// [lc-563] 轮播数据源 = 复用 hotUpdates.ts 已验证可行的 ensureLibraryIndex（稳定构建 97 项），取 Map 前 10 项 = 首屏 DOM 顺序 = 最近更新在前。
// 兜底 = 当前首页已渲染 DOM 真实卡片。绝不用硬编码数据。绝不在隐藏 iframe 内强制要求 poster（fnOS 懒加载图永远没真实 URL → 跳过 → 0 个）。
import { ensureLibraryIndex } from './hotUpdates';

// ── 拆分后的子模块 ──
import { S, CAROUSEL_TARGET, CAROUSEL_SCRAPE_CAP } from './embyWall/state';
import { log, dlog, isSeasonLayoutDebugOn } from './embyWall/log';

// [lc-563] 数据层 → 渲染层 接线（依赖倒置, 避免 api.ts ↔ render.ts 循环依赖）：
//   fetchShowsViaIPC 内部详情补完需揭示轮播时, 通过 onShowsReady 钩子回调 injectCarousel, 而非直接 import render.ts。
setOnShowsReady(injectCarousel);

const LOG = '[EmbyWall]';

// [lc-516] 「应用补丁」向导弹窗监听：模块顶层注册，直接唤起自包含的补丁应用弹窗。
// ===== 已迁移到 ./embyWall/modals/patch.ts（[lc-516] 模块级、自包含的补丁应用弹窗） =====
// ===== 已迁移到 ./embyWall/login.ts =====
/* ========== logo(base64内嵌) ========== */
// ===== 已迁移到 ./embyWall/carousel/logoAsset.ts =====
// ===== 已迁移到 ./embyWall/carousel/api.ts （通过IPC主进程签名→自主调用API获取剧集(全自动)） =====
// ===== 已迁移到 ./embyWall/nav/scroll.ts（拦截matchMedia） =====
/* ========== 轮播图(纯真实数据源, 不用硬编码) ========== */

// ===== 已迁移到 ./embyWall/carousel/images.ts（鉴权拉取图片→blob URL(绕开<img>无法带Authx头的问题)） =====
// ===== 已迁移到 ./embyWall/carousel/render.ts（[lc-781] 轮播样式 2：滑动切换式 + 底部进度条/指示点） =====
// ===== 已迁移到 ./embyWall/carousel/styles.ts（预加载优雅占位(替代硬编码 demo 无职转生)） =====
// ===== 已迁移到 ./embyWall/carousel/progress.ts =====
// ===== 已迁移到 ./embyWall/carousel/logo.ts =====
// ===== 已迁移到 ./embyWall/detail/glass.ts（仅保留 isDetailPage 工具；详情页美化于 lc-979 移除, 待重写） =====
// ===== 已迁移到 ./embyWall/theme.ts =====
// ===== 已迁移到 ./embyWall/nav/inject.ts（入口） =====
function handle(): void {
  const base = location.origin;
  log('handle start');

  // [lc-1014] 性能模式（设置面板-外观可切换）：localStorage 同步预读先挂总闸类
  // （早于 patch.ts 的 settings:get 异步真值回填，二者写同一类无竞态），再注入压动画样式表。
  try {
    if (localStorage.getItem('fntv-perf-mode') === '1') {
      document.documentElement.classList.add('fnos-perf');
    }
  } catch (_) { /* ignore */ }
  if (!document.getElementById('fntv-perf-style')) {
    const perfSt = document.createElement('style');
    perfSt.id = 'fntv-perf-style';
    perfSt.textContent = [
      '/* [lc-1014] 性能模式总闸：低配机关掉一切合成器负担——动画/过渡压到近零, 磨砂全关 */',
      'html.fnos-perf *{',
      '  animation-duration:.01ms!important;',
      '  animation-iteration-count:1!important;',
      '  animation-delay:0ms!important;',
      '  transition-duration:.01ms!important;',
      '  transition-delay:0ms!important;',
      '  scroll-behavior:auto!important;',
      '}',
      /* body 亚克力(mainwin .fnos-tv-page body, 特异性 0,1,1)必须被稳定压过, 故单列高特异性规则 */
      'html.fnos-perf *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'html.fnos-perf .fnos-tv-page body{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      /* 详情页全屏底图: 保留低透画面但去掉 52px 大模糊(常驻合成器大头) */
      'html.fnos-perf .fnos-detail-backdrop__img{filter:none!important}',
      /* [lc-1017] 性能模式同时掐掉底图交叉淡换/整层淡出过渡, 保持零合成开销 */
      'html.fnos-perf .fnos-detail-backdrop__img,html.fnos-perf .fnos-detail-backdrop{transition:none!important}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(perfSt);
  }

  // [lc-371] 原生系统页守卫: 仅在飞牛影视 TV 页(/v)执行 TV 专属改造(白底清除器/主题/侧栏等);
  //   切到飞牛原生 NAS 系统页(根路径 `/`)时, 这些改造会破坏原生 UI, 故跳过, 仅注入"返回影视"浮动按钮。
  // [lc-389] 视频预览外放按钮须无条件注册: 它只 watch .trim-ui__app-layout--window 内的 <video>,
  //   影视 TV 页(/v)无此窗口故无害; 而若放在 !isFntvTvPage() 分支内, 当 preload 初次即在影视页(/v)
  //   加载时该分支不执行, 飞牛切系统页为 SPA 不重载 webContents → handle() 不再重跑 →
  //   按钮 observer 永不注册 → 文件管理器双击视频"无事发生". 故改无条件调用.
  injectVideoPreviewExternalPlay();

  // [lc-455] SPA 路由同步 <html>.fnos-tv-page 类:
  //   飞牛系统页(/)与影视页(/v)是同一 webContents 内 SPA 切换, 不重载 webContents → handle() 不再重跑。
  //   若初次在影视页加了 .fnos-tv-page, 切到系统页时类残留 → ① body 亚克力(已限定 .fnos-tv-page)仍误伤系统页。
  //   故周期性比对 pathname, 动态 add/remove 类, 确保系统页始终不被亚克力化(避免缩略图变黑框)。
  const syncTvPageClass = () => {
    document.documentElement.classList.toggle('fnos-tv-page', isFntvTvPage());
  };
  syncTvPageClass();
  let _lastPath = location.pathname;
  const _tvClassTimer = window.setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      syncTvPageClass();
      log('[TV类同步]', location.pathname, 'isTv=', isFntvTvPage());
    }
  }, 400);
  window.addEventListener('beforeunload', () => window.clearInterval(_tvClassTimer));

  if (!isFntvTvPage()) {
    injectNativeReturnButton();
    injectExternalPlayButton();
    return;
  }

  // [lc-453] 标记 <html> 为影视TV页: 供 mainwin.ts ACRYLIC_CSS 的白底清除规则(③)限定作用域,
  //   避免文件管理/设置等系统页的缩略图容器背景被误杀变黑框.
  document.documentElement.classList.add('fnos-tv-page');

  // [lc-845] 旧「实时重建」机制已废弃: 样式切换改为设置面板点击后整页重载回首页(见 buildSettingsPanel 的 csSeg 点击处理), 故此处不再监听 fntv:carousel-style 事件。

  // 导航诊断: 记录每次URL变化, 排查"返回落到全部剧集而非首页"
  const logNav = (label: string) => log('NAV', label, location.href);
  logNav('init');

  // [v400] 注入主题变量 + 应用 UI 主题偏好 + 隐藏飞牛自带主题开关
  injectUiThemeStyle();
  applyUiTheme();
  removeThemeModeSetting();
  // MutationObserver 守护: 飞牛路由切换/React重渲染可能改回深色或重建设置页DOM → 持续纠正
  //   observe documentElement: attributes 监听 html 的 class/style 变化(锁浅色), subtree 监听内部所有 DOM 变化(删主题模式区块)
  let _themeTimer = 0;
  const _themeObserver = new MutationObserver(() => {
    clearTimeout(_themeTimer);
    _themeTimer = window.setTimeout(() => { applyUiTheme(); removeThemeModeSetting(); }, 150);
  });
  _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _themeObserver.disconnect());
  // [v400] 跟随系统: 系统明暗偏好变化时, 若当前为 system 则实时换肤
  try {
    const _mq = window.matchMedia('(prefers-color-scheme: dark)');
    const _onSys = () => { if (getUiTheme() === 'system') applyUiTheme(); };
    if (typeof _mq.addEventListener === 'function') _mq.addEventListener('change', _onSys);
    else if (typeof (_mq as any).addListener === 'function') (_mq as any).addListener(_onSys);
  } catch (e) { /* ignore */ }

  // ── [v364] 初始化亚克力参数(透明度/模糊): 来自 localStorage, 供侧栏滑块实时调整 ──
  (() => {
    const a = localStorage.getItem('fnos-glass-alpha');
    const b = localStorage.getItem('fnos-glass-blur');
    if (a) document.documentElement.style.setProperty('--fnos-alpha', a);
    if (b) document.documentElement.style.setProperty('--fnos-blur', b + 'px');
  })();

  // ── [v363] 全局白底清除器: JS 核弹级扫描 ──
  // CSS 选择器覆盖不了的内联 style / 动态样式 / CSS 变量 → 全靠这里
  // 原理: 遍历所有元素的计算背景色, 白/近白系(r,g,b≥235 且不透明)→强制透明
  // [v367] 重要修正: 必须排除飞牛原生的交互性浮层(dropdown/menu/popover/modal/tooltip),
  //   否则展开菜单会被误杀成全透, 文字重叠无法阅读.
  const _isOpaqueLight = (bg: string): boolean => {
    if (!bg) return false;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if (a < 0.05) return false; // 已透明
    return r >= 220 && g >= 220 && b >= 220; // 白/浅灰系(阈值从235降到220)
  };

  /** 判断一个元素是否是「应该保留背景的交互性浮层」→ 跳过不清除。
   *  [lc-1011] cs 由调用方传入(全量扫描/增量扫描各自已算过一次), 不再内部重复 getComputedStyle ——
   *  旧版每元素至少算两遍计算样式, 乘以扫描频率就是持续掉帧(用户反馈卡顿的热点之一)。 */
  const _isProtectedOverlay = (el: HTMLElement, cs: CSSStyleDeclaration): boolean => {
    // ⓪ 自建设置面板及其所有后代 → 永远保护(浅色卡片不被白底清除器误杀)
    if (el.id === 'fnos-settings-panel') return true;
    if (typeof el.closest === 'function' && el.closest('#fnos-settings-panel')) return true;

    // ① ARIA 语义化 UI 组件
    const role = el.getAttribute('role');
    if (role && ['menu', 'menuitem', 'listbox', 'option', 'dialog', 'tooltip', 'combobox', 'select'].includes(role)) return true;

    // ② class 关键字匹配(常见 UI 框架命名)
    const cls = el.className || '';
    if (typeof cls === 'string') {
      // [lc-657] 增加 datepicker/date-picker: 编辑元数据日期选择器弹层内部元素(日期格/导航)
      //   为白色, 若被白底清除器清成 transparent 会"全白"; 改为保护 + 专属深色适配(_forceDatePickerDark).
      const overlayKw = ['dropdown', 'popover', 'menu-', '-menu', 'modal', 'tooltip', 'sheet-', 'select-', 'popup', 'flyout', 'context-menu', 'command-palette', 'datepicker', 'date-picker', 'datepicker-month'];
      const lower = cls.toLowerCase();
      for (const kw of overlayKw) { if (lower.includes(kw)) return true; }
    }

    // ③ 绝对/固定定位的小型浮层(通常是 dropdown/tooltip, 不是页面容器)
    const pos = cs.position;
    if (pos === 'absolute' || pos === 'fixed') {
      const rect = el.getBoundingClientRect();
      // 面积 < 150×100 或 宽度 < 200px → 视为小型交互控件, 不清
      if (rect.width * rect.height < 150000 || rect.width < 200) return true;
      // z-index 极高的固定层(> 5000) → 可能是全局浮层
      if (pos === 'fixed') {
        const zi = parseInt(cs.zIndex || '0', 10);
        if (!isNaN(zi) && zi > 5000) return true;
      }
    }

    // ④ 有明显阴影/边框的独立卡片(通常是有意设计的面板)
    const boxShadow = cs.boxShadow || '';
    if (boxShadow !== 'none' && boxShadow.includes('0px') && (boxShadow.includes('rgba(0') || boxShadow.includes('rgb(0'))) {
      // 有非零阴影 → 可能是卡片式浮层, 检查是否是小面积
      const rect = el.getBoundingClientRect();
      if (rect.width < 600 && rect.height < 400) return true;
    }

    return false;
  };

  const _WW_SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'SVG', 'PATH', 'CANVAS', 'IMG', 'VIDEO', 'IFRAME', 'BODY']);
  /** 单元素白底判定+清除。返回 'fixed'(清了) | 'skip'(保护/跳过) | 'keep'(不是白底)。
   *  [lc-1011] 从 _globalWhitewashRemover 内联逻辑抽出: 计算样式只取一次, 供全量与增量两条路径共用。 */
  const _whitewashCheck = (el: HTMLElement): 'fixed' | 'skip' | 'keep' => {
    if (_WW_SKIP_TAGS.has(el.tagName)) return 'skip';
    if (el.dataset.fnosClear === '1') return 'keep';
    // [v397] 跳过所有自建设置弹窗(检查更新/关于/反馈/B站登录): 它们标了 data-fnos-ui='1',
    //   且子树内卡片背景为浅粉不透 → 若被白底清除器误清成 transparent!important, 整窗会"全透明"看不见.
    //   用 closest 保护整棵子树(卡片是 position:relative, 自身不会被 fixed 浮层保护规则覆盖).
    if (el.dataset.fnosUi === '1' || (typeof el.closest === 'function' && el.closest('[data-fnos-ui="1"]'))) return 'skip';
    try {
      const cs = getComputedStyle(el);
      // [v367] 先检查是否受保护的交互浮层
      if (_isProtectedOverlay(el, cs)) return 'skip';
      if (_isOpaqueLight(cs.backgroundColor)) {
        el.style.setProperty('background', 'transparent', 'important');
        el.style.setProperty('background-color', 'transparent', 'important');
        el.dataset.fnosClear = '1';
        return 'fixed';
      }
    } catch (_) { /* 跨域等安全异常跳过 */ }
    return 'keep';
  };

  /** [lc-1011] 增量白底清除: 只扫「本次插入的元素子树」(root 自身 + 后代)。 */
  const _whitewashSubtree = (root: HTMLElement): number => {
    let fixed = 0;
    if (_whitewashCheck(root) === 'fixed') fixed++;
    const sub = root.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < sub.length; i++) {
      if (_whitewashCheck(sub[i]) === 'fixed') fixed++;
    }
    return fixed;
  };

  let _whitewashPasses = 0;

  /**
   * [lc-657] 日期选择器弹层深色适配（深色模式下）。
   * fnOS 编辑元数据用 Semi Design DatePicker：弹层(.semi-datepicker)及日期格默认白色，
   * 且导航按钮被 fnOS 内联白色 style（rgba(255,255,255,.55) + 深字）——深色模式下整体"全白"。
   * 此处仅在深色模式强制：深色背景 + 浅色文字 + 覆盖内联白色按钮样式。
   * 浅色模式不干预（保持原生）。
   */
  const _forceDatePickerDark = (): void => {
    if (!getEffectiveDark()) return;
    const picks = Array.from(document.querySelectorAll('.semi-datepicker, .semi-datepicker-container, [class*="datepicker"][class*="month"]'));
    if (!picks.length) return;
    for (const pickRaw of picks) {
      const pick = pickRaw as HTMLElement;
      // 深色背景（弹层容器/月网格）
      pick.style.setProperty('background', 'rgba(28, 26, 38, 0.97)', 'important');
      pick.style.setProperty('background-color', 'rgba(28, 26, 38, 0.97)', 'important');
      pick.style.setProperty('color', '#e8e6f0', 'important');
      // 覆盖整棵子树的白底
      const sub = Array.from(pick.querySelectorAll('*'));
      for (let i = 0; i < sub.length; i++) {
        const e = sub[i] as HTMLElement;
        const cs = getComputedStyle(e);
        const bg = cs.backgroundColor;
        if (_isOpaqueLight(bg)) {
          e.style.setProperty('background', 'transparent', 'important');
          e.style.setProperty('background-color', 'transparent', 'important');
          e.dataset.fnosClear = '1';
        }
      }
    }
    // 导航/日期格文字与内联白色按钮修正
    const navBtns = Array.from(document.querySelectorAll('.semi-datepicker-navigation button, .semi-datepicker-month button'));
    for (let i = 0; i < navBtns.length; i++) {
      const b = navBtns[i] as HTMLElement;
      b.style.setProperty('background', 'rgba(255,255,255,0.08)', 'important');
      b.style.setProperty('background-color', 'rgba(255,255,255,0.08)', 'important');
      b.style.setProperty('border', '1px solid rgba(255,255,255,0.14)', 'important');
      b.style.setProperty('color', '#e8e6f0', 'important');
      b.style.setProperty('box-shadow', 'none', 'important');
    }
    const cells = Array.from(document.querySelectorAll('.semi-datepicker-day, .semi-datepicker-weekday-item, .semi-datepicker-month-grid'));
    for (let i = 0; i < cells.length; i++) {
      (cells[i] as HTMLElement).style.setProperty('color', '#cfcbe0', 'important');
    }
  };

  const _globalWhitewashRemover = () => {
    _whitewashPasses++;
    let fixedCount = 0;
    let skippedCount = 0;
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      const r = _whitewashCheck(all[i]);
      if (r === 'fixed') fixedCount++;
      else if (r === 'skip') skippedCount++;
    }
    if (_whitewashPasses % 20 === 1 || fixedCount > 0) {
      log('whitewash pass', _whitewashPasses, 'fixed', fixedCount, 'skipped-overlay', skippedCount);
    }
  };

  // [v382] 全局圆角强制: 飞牛影视 React SPA 路由切换时可能添加 position:fixed 全屏层,
  //        其 Tailwind 类名(如 fixed.top-0.left-0.w-full.h-full)不被 ACRYLIC_CSS
  //        fixed.inset-0 选择器覆盖 → 四个角变方. JS 扫描所有 fixed 元素, 近全屏则强制圆角.
  let _rcPasses = 0;
  /** 单元素圆角强制判定+处理。[lc-1011] 从全扫循环抽出, 供全量与增量共用。 */
  const _roundedCheck = (el: HTMLElement): boolean => {
    // body/html 由 mainwin.ts 的 injectAcrylicCSS 统一处理(登录页灰底/主界面亚克力),
    // 此处跳过以免把登录页的 #f5f5f5 灰底误清成 transparent(用户要求登录页不透明).
    if (el === document.body || el === document.documentElement) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return false;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = el.getBoundingClientRect();
      // 覆盖 ≥80% 视口的元素才加圆角(避免误伤小弹窗/按钮)
      if (rect.width < vw * 0.8 || rect.height < vh * 0.8) return false;
      // 跳过已标记的
      if (el.dataset.fnosRounded === '1') return false;
      el.style.setProperty('border-radius', '16px', 'important');
      el.style.setProperty('overflow', 'hidden', 'important');
      el.style.setProperty('clip-path', 'inset(0 round 16px)', 'important');
      el.style.setProperty('-webkit-clip-path', 'inset(0 round 16px)', 'important');
      // 同步清除白底: 全屏固定层的白底挡住 body 亚克力玻璃+桌面透出圆角
      // [v384] 同时清除 background-image(渐变/图片): getComputedStyle 的 backgroundColor
      //        对渐变返回 transparent, 导致白底漏网.
      const bgImg = cs.backgroundImage;
      if (bgImg && bgImg !== 'none') {
        el.style.setProperty('background-image', 'none', 'important');
      }
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') {
        const bm = bg.match(/rgba?\(([^)]+)\)/);
        if (bm) {
          const parts = bm[1].split(',').map(s => parseFloat(s.trim()));
          if (parts[0] > 200 && parts[1] > 200 && parts[2] > 200 && (parts[3] ?? 1) > 0.1) {
            el.style.setProperty('background', 'transparent', 'important');
            el.style.setProperty('background-color', 'transparent', 'important');
          }
        }
      }
      el.dataset.fnosRounded = '1';
      return true;
    } catch (_) { /* skip */ }
    return false;
  };
  const _globalRoundedCornerEnforcer = () => {
    _rcPasses++;
    let fixedCount = 0;
    // 只扫描 fixed 元素(数量远少于全 DOM)
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      if (_roundedCheck(all[i])) fixedCount++;
    }
    if (_rcPasses % 20 === 1 || fixedCount > 0) {
      log('rounded-corner pass', _rcPasses, 'fixed-fullscreen', fixedCount);
    }
  };
  // [lc-1011] 增量扫描架构(用户反馈卡顿的性能修复):
  //   旧版 = 「任何 childList 变更 → 200ms 后全 DOM getComputedStyle 扫描」× 2 个清除器
  //          + 每 6s 无条件全扫 —— 轮播/React 重渲染期间持续触发, 弱机上就是持续掉帧。
  //   新版 = MO 回调里只把「本次插入的元素节点」入队, 去抖后只扫这些子树;
  //          语义不变: 旧观察者本就只监听 childList(subtree), 纯样式/文本变更从不触发扫描,
  //          故「插入子树」正是旧全扫在每次触发时实际可能改动的全部范围。
  //   全扫保留为兜底: 启动 3 次 + 心跳降频 6s → 20s(防 CSSOM 动态样式等不入 DOM 的漏网)。
  setTimeout(_globalRoundedCornerEnforcer, 800);
  setTimeout(_globalRoundedCornerEnforcer, 2500);
  setTimeout(_globalRoundedCornerEnforcer, 4500);
  const _pendingClear: HTMLElement[] = [];
  const _pendingRound: HTMLElement[] = [];
  const _collectAdded = (muts: MutationRecord[], sink: HTMLElement[]): void => {
    for (let i = 0; i < muts.length; i++) {
      const an = muts[i].addedNodes;
      for (let j = 0; j < an.length; j++) {
        if (an[j].nodeType === 1) sink.push(an[j] as HTMLElement);
      }
    }
  };
  let _rcTimer = 0;
  const _rcObs = new MutationObserver((muts) => {
    _collectAdded(muts, _pendingRound);
    clearTimeout(_rcTimer);
    _rcTimer = window.setTimeout(() => {
      const batch = _pendingRound.splice(0, _pendingRound.length);
      let fixed = 0;
      for (const root of batch) {
        if (_roundedCheck(root)) fixed++;
        const sub = root.querySelectorAll<HTMLElement>('*');
        for (let i = 0; i < sub.length; i++) { if (_roundedCheck(sub[i])) fixed++; }
      }
      if (fixed > 0) log('rounded-corner incremental fixed', fixed);
    }, 200);
  });
  _rcObs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => { _rcObs.disconnect(); clearInterval(_rcInterval); });
  const _rcInterval = setInterval(_globalRoundedCornerEnforcer, 20000);

  // 三重触发: 立即一次 + MutationObserver(DOM变化时) + 定时巡检(兜底漏网)
  setTimeout(() => { _globalWhitewashRemover(); _forceDatePickerDark(); }, 500);
  setTimeout(() => { _globalWhitewashRemover(); _forceDatePickerDark(); }, 2000);
  setTimeout(() => { _globalWhitewashRemover(); _forceDatePickerDark(); }, 4000);
  let _wwTimer = 0;
  const _wwObs = new MutationObserver((muts) => {
    // [lc-1011] 增量: 只收集本次插入的元素子树, 去抖后只扫这些子树(语义同旧全扫, 见上方圆角处注释)
    _collectAdded(muts, _pendingClear);
    clearTimeout(_wwTimer);
    _wwTimer = window.setTimeout(() => {
      const batch = _pendingClear.splice(0, _pendingClear.length);
      let fixed = 0;
      for (const root of batch) fixed += _whitewashSubtree(root);
      if (fixed > 0) log('whitewash incremental fixed', fixed);
      _forceDatePickerDark(); // [lc-657] 日期选择器弹层深色适配随白底清除器一同触发
    }, 200);
  });
  _wwObs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _wwObs.disconnect());
  setInterval(() => {
    _globalWhitewashRemover(); // 心跳兜底全扫(lc-1011: 6s → 20s, 常驻全扫是卡顿热点)
    _forceDatePickerDark(); // [lc-657] 同步巡检日期选择器弹层
  }, 20000);

  // [v374] 窗口拖动已改为原生 -webkit-app-region:drag (见 titlebar.ts / mainwin.ts CSS),
  //   不再用 JS setPosition —— transparent 窗口下 setPosition 会触发 DWM 异常放大.
  //   改变窗口大小仅通过拖拽窗口边缘(resizable:true 原生行为).

  // 汉堡键(所有页面含首页/详情页)的"宽屏常显+抽屉开合"均由 mainwin.ts insertCSS 纯CSS规则控制:
  //   规则1: [class*="lg:!hidden"]:not([class*="inset-0"]){display:flex!important}  → 命中所有页面的汉堡键容器
  //   规则2: [class*="lg:!hidden"][class*="inset-0"]:not([class~="!hidden"]){display:flex!important} → 抽屉跟随飞牛!hidden状态
  // (Playwright 550px窄屏DOM确认: 详情页头部也有完全相同的 lg:!hidden 汉堡键结构, 含🏠首页+≡菜单)
  //
  // [JS兜底] v321~v326: 强制可见 + inline-style 完全接管抽屉开合(不动 !hidden 类!)
  //   mainwin.ts的CSS注入理论上覆盖所有页面, 但SPA路由切换后可能存在时序/优先级边缘情况
  //   导致汉堡键仍被Tailwind @media钉死display:none → ①强制可见兜底.
  //   [v326 关键修正] v325 只管 inline 但不拦截飞牛 → 飞牛原生 onClick 有时仍会触发(宽屏下并非稳定 no-op),
  //     与我们的 inline 切换形成"双重控制", 且遮罩关闭判定(e.target===drawer)过严(背板是子元素),
  //     导致首页抽屉"能开不能收/卡死".
  //   v326 改为: capture 阶段 stopImmediatePropagation 拦截飞牛原生 click handler,
  //     由我们**唯一**用 inline style 控制开合; 因绝不修改 !hidden 类, 飞牛 React state 永远与 DOM 一致,
  //     不会触发 v322 那种 state 同步死锁; 并补③背板点击关闭 + 导航时关闭抽屉, 彻底消除卡死.
  // 抽屉开合动画辅助: 用 display(flex/none) 控制挂载, .drawer-open 类驱动 CSS 过渡;
  // 绝不动 !hidden 类(飞牛 React state 永远与 DOM 一致, 不触发 v322 那种死锁)
  const openDrawer = (d: HTMLElement): void => {
    d.style.setProperty('display', 'flex', 'important');
    // [v351] 直接用 JS 注入面板毛玻璃样式(inline style > 一切 CSS 规则)
    applySidebarGlass(d);
    // 双 rAF: 确保 display:flex 先绘制(opacity:0/translateX(-100%)初始态), 再切 .drawer-open 触发过渡
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('drawer-open')));
  };

  /** 给抽屉内部面板强制注入 Mica 亚克力毛玻璃(通过 inline style 绕过所有 CSS 优先级) */
  function applySidebarGlass(drawer: HTMLElement): void {
    // 抽屉容器内第一个非 absolute 的子元素就是侧栏面板
    const kids = Array.from(drawer.children);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as HTMLElement;
      if (child.classList?.contains('absolute')) continue;
      const panel = child;
      // Mica Acrylic: 粉紫暖调半透 + 高模糊 (透桌面真亚克力)
      panel.style.setProperty('background', 'var(--fnos-sidebar-bg)', 'important');
      panel.style.setProperty('backdrop-filter',
        'blur(56px) saturate(135%) brightness(1.02)', 'important');
      panel.style.setProperty('-webkit-backdrop-filter',
        'blur(56px) saturate(135%) brightness(1.02)', 'important');
      panel.style.setProperty('border-right', 'var(--fnos-sidebar-border)', 'important');
      panel.style.setProperty('box-shadow', 'var(--fnos-sidebar-shadow)', 'important');
      // [v352] 关键: 面板内层嵌套容器常带白底(bg-white/bg-gray), 会盖住浅蓝 → 把它们全部透明化
      // [lc-371-fix] 跳过 #fnos-switch-system-btn 等注入按钮(否则二次调用 applySidebarGlass 时
      //   已存在的按钮背景被透明化 → 在半透明面板上不可见)
      const descendants = panel.querySelectorAll('*');
      for (let j = 0; j < descendants.length; j++) {
        const el = descendants[j] as HTMLElement;
        // 跳过我们注入的侧栏按钮（保持自身背景色）
        if (el.id === 'fnos-switch-system-btn' || el.id === 'fnos-settings-btn'
          || el.id === 'fnos-feedback-choice-btn' || el.closest('#fnos-sidebar-actions')) continue;
        const bg = getComputedStyle(el).backgroundColor;
        // 命中不透明/半透明的白系或浅灰底 → 透明, 让浅蓝透上来
        if (isOpaqueLightBg(bg)) {
          el.style.setProperty('background', 'transparent', 'important');
          el.style.setProperty('background-color', 'transparent', 'important');
        }
      }
      injectSettingsUI(panel); // [lc-360] 侧栏底部只保留"设置/反馈/QQ"按钮(滑块已迁入设置面板"外观"标签页)
      break; // 只处理第一个非 absolute 子元素
    }
    // 遮罩层: 极淡暖灰雾感, 与 Mica 亚克力风格统一
    drawer.style.setProperty('background', 'rgba(200,195,210,.12)', 'important');
    drawer.style.setProperty('backdrop-filter', 'blur(8px) saturate(120%)', 'important');
      drawer.style.setProperty('-webkit-backdrop-filter', 'blur(8px) saturate(120%)', 'important');
  }

  /** [lc-360] 构造"亚克力透明度/模糊"调节滑块组(纯 DOM, 可复用于设置面板"外观"标签页)
   *  - 透明度滑块(0~100): 值越大越透(桌面透出越多). 反向映射到 body 背景 alpha(0.95→0.05)
   *  - 模糊滑块(0~100px): 调节 backdrop-filter 模糊强度
   *  - 写入 localStorage, 重启后仍生效 */
  // [lc-980] 「剧集详情页美化」外观开关引用: 在 buildAppearanceControls 内创建,
  //   设置回填(seg('switches'))在持久化设置异步 resolve 后据此同步勾选态并重绘。
  let _beautifyToggle: HTMLInputElement | null = null;
  let _beautifyPaint: (() => void) | null = null;

  function buildAppearanceControls(): HTMLElement {
    // [lc-119] 首次登录(无 localStorage)默认: 透明度滑块=30%(对应 alpha 0.68), 背景模糊滑块=30px
    const storedAlpha = parseFloat(localStorage.getItem('fnos-glass-alpha') || '0.68');
    const storedBlur = parseInt(localStorage.getItem('fnos-glass-blur') || '30', 10);
    // 滑块 value=透明度%(0→浓度最高不透明0.95, 100→最透0.05); 与 alpha 反相关
    const alphaPct = Math.max(0, Math.min(100, Math.round((0.95 - storedAlpha) / 0.9 * 100)));
    const wrap = document.createElement('div');
    wrap.id = 'fnos-appearance-ctrl';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    wrap.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">亚克力透明度</span>'
      +   '<span id="fnos-alpha-val" style="opacity:.85;">' + alphaPct + '%</span></div>'
      + '<input id="fnos-alpha" type="range" min="0" max="100" value="' + alphaPct + '" '
      +   'style="width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">背景模糊</span>'
      +   '<span id="fnos-blur-val" style="opacity:.85;">' + storedBlur + 'px</span></div>'
      + '<input id="fnos-blur" type="range" min="0" max="100" value="' + storedBlur + '" '
      +   'style="width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">首页「每日放送」按钮</span>'
      +   '<label style="position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;">'
      +     '<input id="fnos-show-daily" type="checkbox" style="position:absolute;opacity:0;width:0;height:0;">'
      +     '<span id="fnos-show-daily-track" style="position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;"></span>'
      +     '<span id="fnos-show-daily-knob" style="position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></span>'
      +   '</label>'
      + '</div>'
      /* [lc-1014] 性能模式（低配机）：html.fnos-perf 总闸——全局压动画/关磨砂，即时生效 */
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">性能模式（低配机）</span>'
      +   '<label style="position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;">'
      +     '<input id="fnos-perf-mode" type="checkbox" style="position:absolute;opacity:0;width:0;height:0;">'
      +     '<span id="fnos-perf-track" style="position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;"></span>'
      +     '<span id="fnos-perf-knob" style="position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></span>'
      +   '</label>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--fnos-ui-sub,#888);line-height:1.5;margin-top:4px;">大幅减少动画、关闭磨砂模糊与全屏底图，优先保证流畅。即时生效。</div>'
      /* [lc-1014] 硬件加速：Electron 启动级开关，改动写 config 重启后生效 */
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">硬件加速（优美动画）</span>'
      +   '<label style="position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;">'
      +     '<input id="fnos-hw-accel" type="checkbox" style="position:absolute;opacity:0;width:0;height:0;">'
      +     '<span id="fnos-hw-track" style="position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;"></span>'
      +     '<span id="fnos-hw-knob" style="position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></span>'
      +   '</label>'
      + '</div>'
      + '<div id="fnos-hw-restart" style="display:none;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--fnos-ui-accent) 12%,transparent);">'
      +   '<span style="font-size:11px;line-height:1.4;">硬件加速设置已保存，重启应用后生效。</span>'
      +   '<button id="fnos-hw-restart-btn" style="flex:none;border:none;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;background:var(--fnos-ui-accent);color:#fff;font-family:inherit;">立即重启</button>'
      + '</div>';

    const alphaInput = wrap.querySelector('#fnos-alpha') as HTMLInputElement;
    const alphaVal = wrap.querySelector('#fnos-alpha-val') as HTMLElement;
    const blurInput = wrap.querySelector('#fnos-blur') as HTMLInputElement;
    const blurVal = wrap.querySelector('#fnos-blur-val') as HTMLElement;

    alphaInput.addEventListener('input', () => {
      const pct = parseInt(alphaInput.value, 10);
      const a = (0.05 + (100 - pct) / 100 * 0.9).toFixed(3); // 0→0.95, 100→0.05
      document.documentElement.style.setProperty('--fnos-alpha', a);
      if (alphaVal) alphaVal.textContent = pct + '%';
      localStorage.setItem('fnos-glass-alpha', a);
    });
    blurInput.addEventListener('input', () => {
      const px = parseInt(blurInput.value, 10);
      document.documentElement.style.setProperty('--fnos-blur', px + 'px');
      if (blurVal) blurVal.textContent = px + 'px';
      localStorage.setItem('fnos-glass-blur', String(px));
    });

    // [lc-363] 首页「每日放送」按钮开关（设置面板"外观"）：写 localStorage + 广播自定义事件给 hotUpdates 实时刷新
    const showDaily = localStorage.getItem('fnos-show-daily') !== '0';
    const dailyInput = wrap.querySelector('#fnos-show-daily') as HTMLInputElement;
    const dailyTrack = wrap.querySelector('#fnos-show-daily-track') as HTMLElement;
    const dailyKnob = wrap.querySelector('#fnos-show-daily-knob') as HTMLElement;
    const paintDaily = (): void => {
      dailyTrack.style.background = dailyInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      dailyKnob.style.left = dailyInput.checked ? '21.5px' : '2.5px';
    };
    dailyInput.checked = showDaily;
    paintDaily();
    dailyInput.addEventListener('change', () => {
      localStorage.setItem('fnos-show-daily', dailyInput.checked ? '1' : '0');
      paintDaily();
      try { window.dispatchEvent(new CustomEvent('fntv:daily-toggle', { detail: { on: dailyInput.checked } })); } catch (_) {}
    });

    /* ── [lc-1014] 性能模式开关：切 html.fnos-perf 总闸类（即时生效）+ localStorage 镜像
       （embyWall handle() 与 patch.ts 启动种子据此预读/回填）+ 写 config 持久化 ── */
    const perfInput = wrap.querySelector('#fnos-perf-mode') as HTMLInputElement;
    const perfTrack = wrap.querySelector('#fnos-perf-track') as HTMLElement;
    const perfKnob = wrap.querySelector('#fnos-perf-knob') as HTMLElement;
    const paintPerf = (): void => {
      perfTrack.style.background = perfInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      perfKnob.style.left = perfInput.checked ? '21.5px' : '2.5px';
    };
    perfInput.checked = document.documentElement.classList.contains('fnos-perf');
    paintPerf();
    perfInput.addEventListener('change', () => {
      document.documentElement.classList.toggle('fnos-perf', perfInput.checked);
      paintPerf();
      try { localStorage.setItem('fntv-perf-mode', perfInput.checked ? '1' : '0'); } catch (_) {}
      S.perfModeEnabled = perfInput.checked;
      ipcRenderer.invoke('settings:set-perf-mode', perfInput.checked).catch(() => {});
    });

    /* ── [lc-1014] 硬件加速开关：写 config，重启后生效（主进程启动期才挂 GPU 开关）。
       初值异步回填（config 缺失视为开启）；用户改动后出现「立即重启」提示条 ── */
    const hwInput = wrap.querySelector('#fnos-hw-accel') as HTMLInputElement;
    const hwTrack = wrap.querySelector('#fnos-hw-track') as HTMLElement;
    const hwKnob = wrap.querySelector('#fnos-hw-knob') as HTMLElement;
    const hwRestart = wrap.querySelector('#fnos-hw-restart') as HTMLElement;
    const paintHw = (): void => {
      hwTrack.style.background = hwInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      hwKnob.style.left = hwInput.checked ? '21.5px' : '2.5px';
    };
    hwInput.checked = true;
    paintHw();
    ipcRenderer.invoke('settings:get').then((s: any) => {
      hwInput.checked = s ? s.hwAccelEnabled !== false : true;
      paintHw();
    }).catch(() => {});
    hwInput.addEventListener('change', () => {
      paintHw();
      ipcRenderer.invoke('settings:set-hw-accel', hwInput.checked).catch(() => {});
      if (hwRestart) hwRestart.style.display = 'flex';
    });
    const hwRestartBtn = wrap.querySelector('#fnos-hw-restart-btn') as HTMLElement;
    if (hwRestartBtn) {
      hwRestartBtn.addEventListener('click', () => {
        ipcRenderer.invoke('settings:restart-app').catch(() => {});
      });
    }

    // [lc-780/lc-781→lc-845→lc-846] 首页轮播图样式切换（设置面板"外观"）：样式 1 = 竖向轮播，样式 2 = 横向轮播，样式 3 = 堆叠切换，样式 4 = 立体堆叠；点击后整页重载回首页并刷新(见下方 click 处理)
    const getCs = (): number => {
      const v = parseInt(localStorage.getItem('fnos-carousel-style') || '4', 10);
      return (v >= 1 && v <= 4) ? v : 4;
    };
    const csWrap = document.createElement('div');
    csWrap.style.cssText = 'margin-top:20px;';
    const csTitle = document.createElement('div');
    csTitle.style.cssText = 'font-weight:600;letter-spacing:.5px;margin-bottom:8px;';
    csTitle.textContent = '首页轮播图样式';
    csWrap.appendChild(csTitle);
    const csSeg = document.createElement('div');
    csSeg.id = 'fnos-carousel-style-seg';
    csSeg.style.cssText = 'display:flex;gap:6px;';
    const csLabels = ['竖向轮播', '横向轮播', '堆叠切换', '立体堆叠'];
    csLabels.forEach((lab, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.style = String(idx + 1);
      b.textContent = lab;
      const active = (idx + 1) === getCs();
      b.style.cssText = 'flex:1 1 0;padding:8px 6px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;'
        + 'box-sizing:border-box;border:1px solid ' + (active ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-border)') + ';'
        + 'background:' + (active ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-input-bg)') + ';'
        + 'color:' + (active ? '#fff' : 'var(--fnos-ui-text)') + ';transition:.15s;';
      csSeg.appendChild(b);
    });
    csWrap.appendChild(csSeg);
    const csHint = document.createElement('div');
    csHint.style.cssText = 'font-size:11px;opacity:.7;margin-top:6px;line-height:1.4;';
    csHint.textContent = '切换样式后将自动回到首页并刷新，立即应用新样式。';
    csWrap.appendChild(csHint);
    const paintCs = (): void => {
      const cur = getCs();
      csSeg.querySelectorAll('button').forEach((btn) => {
        const on = parseInt((btn as HTMLElement).dataset.style || '1', 10) === cur;
        btn.style.borderColor = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-border)';
        btn.style.background = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-input-bg)';
        btn.style.color = on ? '#fff' : 'var(--fnos-ui-text)';
      });
    };
    csSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = parseInt((btn as HTMLElement).dataset.style || '1', 10);
        localStorage.setItem('fnos-carousel-style', String(s));
        paintCs();
        // [lc-845] 切换样式后强制回到首页并刷新整个首页: 整页重载到 /v(新样式已从 localStorage 读取, 干净生效, 避免 live-rebuild 跨样式残留/不彻底)
        try { window.location.href = (window.location.origin || '') + '/v'; } catch (_) { try { window.location.reload(); } catch (__){} }
      });
    });
    wrap.appendChild(csWrap);

    // [lc-980] 「剧集详情页美化」开关(外观页, 复刻 lc-973 位置): 开=套用美化(沉浸底图/两栏/磨砂卡), 关=恢复 fnOS 原生详情页。
    //   语义: detailBoxless=true 表示关闭美化/走原生, 故 checked = !detailBoxless。
    const beautifyRow = document.createElement('div');
    beautifyRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;';
    const beautifyTextWrap = document.createElement('div');
    beautifyTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
    const beautifyTitle = document.createElement('span');
    beautifyTitle.style.cssText = 'font-weight:600;letter-spacing:.5px;';
    beautifyTitle.textContent = '剧集详情页美化';
    const beautifyHint = document.createElement('span');
    beautifyHint.style.cssText = 'font-size:11px;opacity:.7;line-height:1.4;';
    beautifyHint.textContent = '沉浸底图 / 两栏布局 / 磨砂卡片；关闭即恢复飞牛原生详情页。';
    beautifyTextWrap.appendChild(beautifyTitle);
    beautifyTextWrap.appendChild(beautifyHint);
    const beautifyLabel = document.createElement('label');
    beautifyLabel.style.cssText = 'position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;flex-shrink:0;';
    const beautifyInput = document.createElement('input');
    beautifyInput.id = 'fnos-sw-beautify';
    beautifyInput.type = 'checkbox';
    beautifyInput.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
    const beautifyTrack = document.createElement('span');
    beautifyTrack.style.cssText = 'position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;';
    const beautifyKnob = document.createElement('span');
    beautifyKnob.style.cssText = 'position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);';
    beautifyLabel.appendChild(beautifyInput);
    beautifyLabel.appendChild(beautifyTrack);
    beautifyLabel.appendChild(beautifyKnob);
    beautifyRow.appendChild(beautifyTextWrap);
    beautifyRow.appendChild(beautifyLabel);
    wrap.appendChild(beautifyRow);

    const paintBeautify = (): void => {
      beautifyTrack.style.background = beautifyInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      beautifyKnob.style.left = beautifyInput.checked ? '21.5px' : '2.5px';
    };
    beautifyInput.checked = !S.detailBoxless;
    paintBeautify();
    beautifyInput.addEventListener('change', () => {
      S.detailBoxless = !beautifyInput.checked;
      log('[开关保存] 剧集详情页美化=' + beautifyInput.checked + ' (detailBoxless=' + S.detailBoxless + ')');
      ipcRenderer.invoke('settings:set-detail-boxless', S.detailBoxless).catch((e) => log('set-detail-boxless failed', e));
      paintBeautify();
      // 立即应用: 关→teardown 恢复原生; 开→若正在详情页立即套用
      if (S.detailBoxless) teardownDetailBeautify(); else applyDetailBeautify();
    });
    // 暴露给设置回填(持久化设置异步 resolve 后同步勾选态并重绘)
    _beautifyToggle = beautifyInput;
    _beautifyPaint = paintBeautify;

    return wrap;
  }

  /** [新] 侧栏底部追加"设置"按钮; 点击打开设置面板
   *  注意: 按钮必须 append 到 sticky 底部容器内部(而非 panel 直子),
   *  否则飞牛侧栏面板的 overflow/height 会把按钮裁到可视区域外.
   *  [lc-360] 容器优先复用旧 #fnos-glass-ctrl(兼容), 缺失时自建 #fnos-sidebar-actions
   *  (亚克力滑块已迁入设置面板"外观"标签页, 侧栏容器不再含滑块). */
  function injectSettingsUI(panel: HTMLElement): void {
    // 容器: 兼容旧 #fnos-glass-ctrl, 否则复用/新建 #fnos-sidebar-actions
    let ctrl = panel.querySelector('#fnos-glass-ctrl') as HTMLElement | null;
    if (!ctrl) ctrl = panel.querySelector('#fnos-sidebar-actions') as HTMLElement | null;
    if (!ctrl) {
      ctrl = document.createElement('div');
      ctrl.id = 'fnos-sidebar-actions';
      ctrl.style.cssText = 'position:sticky;bottom:10px;flex-shrink:0;box-sizing:border-box;margin:14px 12px 0;width:calc(100% - 24px);'
        + 'padding:14px 14px 16px;border-radius:14px;display:flex;flex-direction:column;gap:6px;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 4px 16px rgba(0,0,0,.18);'
        + 'color:#fff;font-size:12px;user-select:none;';
      panel.appendChild(ctrl);
    }
    // [lc-371] "切换系统页面"按钮: 置于 #fnos-sidebar-actions 容器内部(设置按钮旁),
    //   点击后整窗导航到飞牛原生 NAS 系统页(根路径 `/`); 原生页由 injectNativeReturnButton 提供返回。
    // [lc-373-fix] 必须放进 ctrl 容器内部, 不能 insertBefore 到容器外——
    //   容器外的位置可能被面板布局推出可视区/被遮挡导致不可见。
    // [lc-633] 顺序调整: 用户要求"设置"第一、"切换系统页面"第二——这里先 append 占位,
    //   下方设置按钮块用 prepend 插到最前 → 最终顺序: 设置 → 切换系统页面 → 软件反馈建议。
    if (!ctrl.querySelector('#fnos-switch-system-btn')) {
      const swBtn = document.createElement('button');
      swBtn.id = 'fnos-switch-system-btn';
      swBtn.type = 'button';
      swBtn.textContent = '切换系统页面';
      swBtn.style.cssText = 'box-sizing:border-box;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
        + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 4px 16px rgba(0,0,0,.18);text-align:center;'
        + 'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);';
      swBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // [lc-473] 标记用户主动切系统页 → 抑制 autoJumpToTv 的桌面纠正(reload /v)
        try { sessionStorage.setItem('fntv-system-intent', '1'); } catch (_) { /* ignore */ }
        // [lc-375] 改由主进程执行跳转: 先置 _systemPageMode 再 loadURL('/'), 避免
        //   主进程导航守卫(lc-203)的 did-navigate 在标记生效前就把 / 纠正回 /v
        ipcRenderer.send('fntv:enter-system-page');
        // [lc-705] 复刻飞牛原生类目按钮：点击后自动收起侧边栏抽屉
        (window as any).fntvCloseSidebar?.();
      });
      ctrl.appendChild(swBtn);  // [lc-633] 占位(设置按钮块稍后 prepend 到最前)
    }

    if (ctrl.querySelector('#fnos-settings-btn')) return; // 幂等

    const btn = document.createElement('button');
    btn.id = 'fnos-settings-btn';
    btn.type = 'button';
    btn.textContent = '⚙ 设置';
btn.style.cssText = 'box-sizing:border-box;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
        + 'border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.18);';
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const ov = document.getElementById('fnos-settings-panel');
      if (ov && ov.style.display === 'flex') ov.style.display = 'none'; // 再次点击=收起
      else openSettingsPanel(panel);
      // [lc-705] 复刻飞牛原生类目按钮：点击后自动收起侧边栏抽屉（设置面板挂在 body，不受影响）
      (window as any).fntvCloseSidebar?.();
    });
    ctrl.prepend(btn); // [lc-633] 设置按钮置顶 → 最终顺序: 设置 → 切换系统页面 → 软件反馈建议

    // [lc-361] 合并"问卷反馈"与"Q群反馈"为单个"软件反馈建议"按钮(点击弹出选择弹窗)
    if (!ctrl.querySelector('#fnos-feedback-choice-btn')) {
      const fbChoiceBtn = document.createElement('button');
      fbChoiceBtn.id = 'fnos-feedback-choice-btn';
      fbChoiceBtn.type = 'button';
      fbChoiceBtn.textContent = '软件反馈建议';
      fbChoiceBtn.style.cssText = 'box-sizing:border-box;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
        + 'border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.18);text-align:center;';
      fbChoiceBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        openFeedbackChoiceModal();
        // [lc-705] 复刻飞牛原生类目按钮：点击后自动收起侧边栏抽屉（反馈弹窗挂在 body，不受影响）
        (window as any).fntvCloseSidebar?.();
      });
      ctrl.appendChild(fbChoiceBtn);
    }

    // [lc-365] 侧栏设置框底部常规显示版本号（像大厂软件：小灰字 + 上分隔线，居中）
    if (!ctrl.querySelector('#fnos-sidebar-version')) {
      const verLine = document.createElement('div');
      verLine.id = 'fnos-sidebar-version';
      verLine.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.15);'
        + 'text-align:center;font-size:11.5px;letter-spacing:.3px;color:rgba(255,255,255,.5);user-select:none;';
      verLine.textContent = 'v…';
      ctrl.appendChild(verLine);
      // 动态版本号：复用主进程 get-version / version-info（与"关于"标签页同源）
      try {
        ipcRenderer.send('get-version');
        ipcRenderer.once('version-info', (_e: any, info: any) => {
          if (info && info.version) verLine.textContent = 'v' + info.version;
        });
      } catch (_) {}
    }

    buildSettingsPanel();
  }

  /** 打开「历史版本」弹窗：列出 resource/wiki 下的 MD 文件，点击可查看内容 */
  // 轻量 Markdown 渲染（仅依赖 DOM，无第三方库）；内容经 HTML 转义后渲染，避免 XSS
  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineMd(s: string): string {
    // 入参已是转义后的纯文本
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
      const safe = /^https?:\/\//i.test(u) ? u : '#';
      return `<a href="${safe}" target="_blank" rel="noopener">${t}</a>`;
    });
    return s;
  }
  function renderMarkdown(md: string): string {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let listType: '' | 'ul' | 'ol' = '';
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = ''; } };
    const isBlockStart = (l: string) => /^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|```)/.test(l)
      || /^(\-{3,}|\*{3,}|_{3,})$/.test(l.trim());
    let i = 0;
    while (i < lines.length) {
      let line = lines[i];
      // 代码块
      if (/^```/.test(line)) {
        closeList();
        i++;
        const buf: string[] = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
        continue;
      }
      // 分隔线
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeList(); html += '<hr>'; i++; continue; }
      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inlineMd(escapeHtml(h[2].trim()))}</h${lvl}>`; i++; continue; }
      // 引用
      if (/^>\s?/.test(line)) {
        closeList();
        const buf: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        html += `<blockquote>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
        continue;
      }
      // 表格（| 分隔，且下一行是分隔行）
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        closeList();
        const splitRow = (r: string) => r.replace(/^\s*\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const headers = splitRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
        let t = '<table><thead><tr>';
        headers.forEach(hd => { t += `<th>${inlineMd(escapeHtml(hd))}</th>`; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => { t += '<tr>'; headers.forEach((_hd, idx) => { t += `<td>${inlineMd(escapeHtml(r[idx] || ''))}</td>`; }); t += '</tr>'; });
        t += '</tbody></table>';
        html += t;
        continue;
      }
      // 列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol';
        if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
        const content = ul ? ul[1] : ol![1];
        html += `<li>${inlineMd(escapeHtml(content))}</li>`;
        i++; continue;
      }
      // 空行
      if (line.trim() === '') { closeList(); i++; continue; }
      // 段落
      closeList();
      const buf: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      html += `<p>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return `<div class="md-body">${html}</div>`;
  }
  // 注入一次 Markdown 容器样式（全局只注入一次）
  function ensureMdStyle(): void {
    if (document.getElementById('fnos-md-style')) return;
    const st = document.createElement('style');
    st.id = 'fnos-md-style';
    st.textContent = `
.md-body{font-size:13px;line-height:1.7;color:#3d445e;}
.md-body h1{font-size:20px;font-weight:700;margin:14px 0 10px;color:#262c44;border-bottom:1px solid rgba(109,127,242,.22);padding-bottom:6px;}
.md-body h2{font-size:17px;font-weight:700;margin:16px 0 8px;color:#262c44;}
.md-body h3{font-size:15px;font-weight:600;margin:14px 0 6px;color:#3d445e;}
.md-body h4{font-size:13.5px;font-weight:600;margin:12px 0 6px;color:#3d445e;}
.md-body p{margin:8px 0;}
.md-body ul,.md-body ol{margin:8px 0;padding-left:22px;}
.md-body li{margin:3px 0;}
.md-body code{background:rgba(109,127,242,.12);padding:1px 5px;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:12px;color:#3d55c8;}
.md-body pre{background:rgba(40,48,84,.06);border:1px solid rgba(109,127,242,.18);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:8px 0;}
.md-body pre code{background:none;padding:0;color:#3d445e;}
.md-body blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid rgba(109,127,242,.4);background:rgba(109,127,242,.06);color:#5a6480;}
.md-body a{color:#4a6fd4;text-decoration:underline;}
.md-body hr{border:none;border-top:1px solid rgba(109,127,242,.22);margin:14px 0;}
.md-body strong{font-weight:700;}
.md-body table{border-collapse:collapse;margin:10px 0;width:100%;font-size:12.5px;}
.md-body th,.md-body td{border:1px solid rgba(109,127,242,.25);padding:6px 9px;text-align:left;}
.md-body th{background:rgba(109,127,242,.10);font-weight:700;}
`;
    document.head.appendChild(st);
  }

  function openHistoryModal(): void {
    if (document.getElementById('fnos-history-overlay')) return; // 防重复打开

    const ov = document.createElement('div');
    ov.id = 'fnos-history-overlay';
    ov.setAttribute('data-fnos-ui', '1');
    ov.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(28,20,40,.40)',
      'backdrop-filter:blur(5px)', '-webkit-backdrop-filter:blur(5px)',
      'opacity:0', 'transition:opacity .18s ease',
      'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif',
    ].join(';') + ';';

    const card = document.createElement('div');
    card.setAttribute('data-fnos-ui', '1');
    card.style.cssText = [
      'position:relative', 'display:flex', 'flex-direction:column',
      'width:92%', 'max-width:780px', 'height:82vh', 'max-height:760px',
      'background:rgba(252,247,253,.98)!important',
      'backdrop-filter:blur(30px) saturate(135%)', '-webkit-backdrop-filter:blur(30px) saturate(135%)',
      'border-radius:16px',
      'box-shadow:0 18px 50px rgba(80,60,110,.30), inset 0 1px 0 rgba(255,255,255,.7)',
      'color:#3d445e', 'overflow:hidden',
      'transform:scale(.96)', 'transition:transform .18s cubic-bezier(.22,.61,.36,1)',
    ].join(';') + ';';

    // 头部：标题 + 关闭
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(109,127,242,.18);flex-shrink:0;';
    const hTitle = document.createElement('div');
    hTitle.textContent = '历史版本';
    hTitle.style.cssText = 'font-size:16px;font-weight:700;color:#262c44;';
    // 历史版本下载链接
    const dlBtn = document.createElement('a');
    dlBtn.textContent = '历史版本下载';
    dlBtn.href = 'https://pan.baidu.com/s/5oy1iYKBLdfxP55pgXO5X1g';
    dlBtn.target = '_blank';
    dlBtn.rel = 'noopener';
    dlBtn.style.cssText = 'display:inline-flex;align-items:center;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;background:rgba(78,102,220,.90);text-decoration:none;letter-spacing:.3px;transition:background .18s ease;';
    dlBtn.onmouseenter = () => { dlBtn.style.background = 'rgba(124,93,255,.95)'; };
    dlBtn.onmouseleave = () => { dlBtn.style.background = 'rgba(78,102,220,.90)'; };
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;font-size:15px;color:#6a5e7e;background:rgba(109,127,242,.10);';
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(109,127,242,.22)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(109,127,242,.10)'; };
    closeBtn.onclick = () => closeHistory();
    header.appendChild(hTitle);
    header.appendChild(dlBtn);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // 主体两栏：左列表 + 右内容
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex:1;min-height:0;';
    const listPane = document.createElement('div');
    listPane.style.cssText = 'width:230px;flex-shrink:0;border-right:1px solid rgba(109,127,242,.18);overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px;';
    const contentPane = document.createElement('div');
    contentPane.style.cssText = 'flex:1;min-width:0;overflow-y:auto;padding:18px 22px;color:#3d445e;word-break:break-word;';
    contentPane.innerHTML = '<div class="md-body"><p style="color:#9a8eae;font-size:13px;">请选择左侧的历史版本查看更新内容。</p></div>';
    ensureMdStyle();
    body.appendChild(listPane);
    body.appendChild(contentPane);
    card.appendChild(body);
    ov.appendChild(card);
    document.body.appendChild(ov);

    requestAnimationFrame(() => { ov.style.opacity = '1'; card.style.transform = 'scale(1)'; });
    ov.addEventListener('click', (e) => { if (e.target === ov) closeHistory(); });

    function closeHistory(): void {
      ov.style.opacity = '0';
      ov.style.pointerEvents = 'none'; // 淡出期间禁用点击，避免透明层短暂拦截
      card.style.transform = 'scale(.96)';
      setTimeout(() => ov.remove(), 180);
    }

    // 载入文件列表
    ipcRenderer.invoke('settings:list-changelogs').then((list: any[]) => {
      listPane.innerHTML = '';
      if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.textContent = '未找到历史版本文件';
        empty.style.cssText = 'padding:12px;font-size:12px;color:#9a8eae;';
        listPane.appendChild(empty);
        return;
      }
      list.forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:9px 11px;border-radius:9px;cursor:pointer;font-size:13px;color:#4a3d5e;transition:background .12s;';
        row.textContent = item.title || item.name;
        row.onmouseenter = () => { if (row.dataset.active !== '1') row.style.background = 'rgba(109,127,242,.10)'; };
        row.onmouseleave = () => { if (row.dataset.active !== '1') row.style.background = 'transparent'; };
        row.onclick = () => {
          listPane.querySelectorAll('[data-active="1"]').forEach((el) => {
            (el as HTMLElement).style.background = 'transparent';
            (el as HTMLElement).dataset.active = '0';
          });
          row.dataset.active = '1';
          row.style.background = 'rgba(109,127,242,.20)';
          contentPane.innerHTML = '<div class="md-body"><p style="color:#9a8eae;">加载中…</p></div>';
          contentPane.scrollTop = 0;
          ipcRenderer.invoke('settings:read-changelog', item.name).then((res: any) => {
            if (res && res.ok) {
              contentPane.innerHTML = renderMarkdown(res.content);
              contentPane.scrollTop = 0;
            } else {
              contentPane.innerHTML = '<div class="md-body"><p style="color:#c0504d;">读取失败：' + escapeHtml(String((res && res.error) || '未知错误')) + '</p></div>';
            }
          }).catch((err: any) => {
            contentPane.innerHTML = '<div class="md-body"><p style="color:#c0504d;">读取失败：' + escapeHtml(String(err)) + '</p></div>';
          });
        };
        listPane.appendChild(row);
      });
    }).catch((err: any) => {
      listPane.innerHTML = '';
      const e = document.createElement('div');
      e.textContent = '加载失败：' + String(err);
      e.style.cssText = 'padding:12px;font-size:12px;color:#c0504d;';
      listPane.appendChild(e);
    });
  }

  /** [新] 创建设置面板(挂到 body, 打开时定位到侧栏区域)
   *  设计原则: 固定宽度不撑栏(340px)、高对比度文字、紧凑分组、可扩展 */
  function buildSettingsPanel(): void {
    if (document.getElementById('fnos-settings-panel')) return;

    // 通用小按钮(用于操作行/MPV路径等)
    const mkBtn = (text: string, small = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (small) {
        // [lc-1043] 去描边：玻璃卡面上的按钮靠填充明度分层（用户审美：无边框）
        b.style.cssText = 'padding:7px 12px;border-radius:9px;cursor:pointer;font-size:11.5px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text);border:none;'
          + 'transition:background .15s;';
        b.onmouseenter = () => { b.style.background = 'var(--fnos-ui-btn-hover)!important'; };
        b.onmouseleave = () => { b.style.background = 'var(--fnos-ui-btn-bg)!important'; };
      } else {
        b.style.cssText = 'flex:1;padding:9px 10px;border-radius:9px;cursor:pointer;font-size:12px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg2)!important;color:var(--fnos-ui-btn-text);border:none;'
          + 'transition:background .15s;';
        b.onmouseenter = () => { b.style.background = 'var(--fnos-ui-btn-hover2)!important'; };
        b.onmouseleave = () => { b.style.background = 'var(--fnos-ui-btn-bg2)!important'; };
      }
      return b;
    };

    // 分组卡片
    // [lc-1041] 卡面优化（用户审美：无边框无线条、对比度靠填充明度不靠描边）：
    //   去 1px 边框与标题下发丝线，圆角 12→14，标题改 11.5px 小写字重弱化标签；
    //   组间距交给 pane 的 gap，卡片自身不再带 margin。
    const section = (titleText?: string): { el: HTMLElement; body: HTMLElement } => {
      const d = document.createElement('div');
      // [lc-1043] 卡面叠 165deg 光泽渐变（glassUI ② 同配方，与面板流光玻璃统一语言）
      d.style.cssText = 'border-radius:14px;background:var(--fnos-ui-input-bg)!important;'
        + 'background-image:linear-gradient(165deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,.012) 60%)!important;'
        + 'overflow:hidden;display:flex;flex-direction:column;';

      // 可选分组标题
      if (titleText) {
        const t = document.createElement('div');
        t.textContent = titleText;
        t.style.cssText = 'font-size:11.5px;font-weight:600;letter-spacing:.4px;'
          + 'color:var(--fnos-ui-sec);padding:12px 14px 0;flex:none;';
        d.appendChild(t);
      }

      // 内容容器
      const body = document.createElement('div');
      body.style.cssText = 'padding:8px 12px 12px;flex:1 1 auto;display:flex;flex-direction:column;';
      d.appendChild(body);
      // [lc-1065] 搜索索引标记: 行走查按此识别内容容器(分组标题不参与匹配)
      body.dataset.secBody = '1';
      return { el: d, body };
    };

    // ===== 主面板 =====
    // [lc-1011] 面板/遮罩入场动画: display:none→flex 会让 CSS 动画在每次打开时重放,
    //   无需 JS 重触发。仅 opacity(0.2s), 不动 transform —— 面板靠内联 translate(-50%,-50%) 居中,
    //   动画若带 transform 会在播放期顶掉居中定位。
    if (!document.getElementById('fnos-panel-anim-style')) {
      const animSt = document.createElement('style');
      animSt.id = 'fnos-panel-anim-style';
      // [lc-1041] ①分类切换动画: 方向感知横滑+淡入(selectCat 按 nav 顺序选 r/l 两套 keyframes),
      //   display:none→flex 会重放 CSS 动画(lc-1011 同款机制), 无需 JS 重触发; 只动 opacity/transform。
      //   ②面板内所有 checkbox 换 iOS 式胶囊开关(appearance:none + ::after 圆钮)——一处 CSS 覆盖
      //   addToggle 与各卡片自建的开关, 不必逐个改 DOM; 语义仍是 input.checked, 存取逻辑零改动。
      animSt.textContent = '@media (prefers-reduced-motion: no-preference){'
        + '@keyframes fnos-panel-in{from{opacity:0}to{opacity:1}}'
        + '@keyframes fnos-cat-in-r{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}'
        + '@keyframes fnos-cat-in-l{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}'
        + '#fnos-settings-panel{animation:fnos-panel-in .2s ease-out both}'
        + '#fnos-settings-mask{animation:fnos-panel-in .28s ease-out both}'
        // [lc-1043] 流光玻璃：一道 55% 宽的斜向高光带每 7s 扫过面板(z-index:-1 —— 面板有
        //   transform 即层叠上下文，::before 落在面板底色之上、内容之下；overflow:hidden 裁圆角)。
        + '#fnos-settings-panel::before{content:"";position:absolute;top:-12%;bottom:-12%;left:0;width:55%;'
        + 'pointer-events:none;z-index:-1;'
        + 'background:linear-gradient(105deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.05) 35%,'
        + 'rgba(255,255,255,.13) 50%,rgba(255,255,255,.05) 65%,rgba(255,255,255,0) 100%);'
        + 'transform:translateX(-160%) skewX(-14deg);animation:fnos-sheen 7s ease-in-out infinite;}'
        + '@keyframes fnos-sheen{0%{transform:translateX(-160%) skewX(-14deg)}55%,100%{transform:translateX(310%) skewX(-14deg)}}}'
        + '#fnos-settings-panel input[type=checkbox]{'
        + '-webkit-appearance:none;appearance:none;width:38px;height:22px;border-radius:11px;flex-shrink:0;margin:0;'
        + 'background:var(--fnos-ui-border-strong,rgba(120,120,128,.32));position:relative;cursor:pointer;'
        + 'transition:background .2s ease;}'
        + '#fnos-settings-panel input[type=checkbox]::after{'
        + "content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;"
        + 'background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);'
        + 'transition:transform .2s cubic-bezier(.3,.7,.4,1);}'
        + '#fnos-settings-panel input[type=checkbox]:checked{background:var(--fnos-ui-accent)}'
        + '#fnos-settings-panel input[type=checkbox]:checked::after{transform:translateX(16px)}'
        // [lc-1044] 紫字对比度补偿（用户报障：面板加玻璃样式后紫字看不清）。
        //   根因: lc-1043 流光玻璃的白色光泽渐变(顶缘 .06 + 流光峰 .13)整体提亮面板表面,
        //   浅色主题下 --fnos-ui-sec(#4a6fd4≈3.7:1)/--fnos-ui-accent(#6d7ff2≈2.4:1) 本就贴着
        //   或跌破 AA 线(4.5:1), 玻璃上更糊 —— 分组标题/提示语/链接/状态值/手柄键位标题全命中。
        //   修=仅在 #fnos-settings-panel 作用域重定义三枚文字色变量为深紫罗兰(全部 ≥4.7:1),
        //   CSS 变量按计算值实时解析, 已打开的面板与后注入的卡片(手柄/插件卡)同样生效;
        //   深色主题(sec 7.3:1/accent 8.5:1)本就达标不动, 面板外全部自建 UI 零影响。
        + 'html:not(.dark) #fnos-settings-panel{'
        + '--fnos-ui-sec:#3f5ec8;'      // 4.7→5.7:1; 豆瓣/TMDB 数据源选中底(白字)同步 4.7→5.7:1
        + '--fnos-ui-accent:#4c63e0;'  // 3.1→5.0:1; 导航选中底+白字/开关选中轨/重启按钮同受益
        + '--fnos-ui-muted2:#5f6a8c;}'; // 插帧开关未选中态 4.0→5.3:1
      (document.head || document.documentElement).appendChild(animSt);
    }
    const overlay = document.createElement('div');
    overlay.id = 'fnos-settings-panel';
    overlay.setAttribute('data-fnos-ui', '1'); // 保护自建设备 UI 不被白底清除器误清(含内部卡片底色)
    overlay.style.cssText = 'position:fixed;z-index:2147483600;display:none;flex-direction:column;width:min(680px,calc(100vw - 80px));'
      // [lc-684] 固定面板高度: 切换分类时面板尺寸稳定不跳动(各分类内容量差异大,
      //   height:auto 会导致面板随内容伸缩)。固定高度 + bodyRow flex:1 + 右内容区
      //   overflow-y:auto 实现"面板恒定、内容内部滚动"。
      + 'height:min(820px,calc(100vh - 100px));max-height:calc(100vh - 100px);overflow:hidden;color:var(--fnos-ui-text);font-size:12.5px;line-height:1.45;'
      + 'background:var(--fnos-ui-panel-bg)!important;'
      // [lc-1043] 165deg 顶缘受光光泽渐变 —— 与 glassUI ② 卡片材质同配方，风格统一
      + 'background-image:linear-gradient(165deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.015) 45%,rgba(255,255,255,.005) 100%)!important;'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);'
      // [lc-1043] 去 1px 描边改 inset 玻璃厚度环（glassUI ② 同款三层阴影语言；用户审美：无边框）
      + 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.22),inset 0 1px 0 rgba(255,255,255,.5),0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
      + 'border-radius:18px;'
      // 飞牛导航栏带 -webkit-app-region:drag; 若面板不声明 no-drag, 覆盖在导航栏上方时点击会被系统当成拖拽窗口吞掉
      + '-webkit-app-region:no-drag;app-region:no-drag;';
    overlay.addEventListener('click', (e: Event) => e.stopPropagation());

    // 极淡模态遮罩: 点击遮罩任意处即可关闭面板(兜底 —— 即便右上角叉被某层遮挡/事件被吞也能关)
    const mask = document.createElement('div');
    mask.id = 'fnos-settings-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483599;display:none;'
      + 'background:rgba(18,14,28,.22);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);'
      + '-webkit-app-region:no-drag;app-region:no-drag;';
    let resetSettingsSearch: (() => void) | null = null; // [lc-1065] 关面板时复位搜索态(实现见下方搜索模块)
    const closeSettingsPanel = (): void => {
      overlay.style.display = 'none';
      mask.style.display = 'none';
      if (resetSettingsSearch) resetSettingsSearch();
    };
    mask.addEventListener('click', () => closeSettingsPanel());
    // ESC 键关闭(兜底)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') closeSettingsPanel();
    });

    // 头部(标题+关闭)
    // [lc-1043] 去标题下发丝线（用户审美：无线条），分区靠留白
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:15px 16px 12px;flex-shrink:0;';
    const title = document.createElement('span');
    title.textContent = '⚙ 设置';
    title.style.cssText = 'font-size:15px;font-weight:700;color:var(--fnos-ui-text);letter-spacing:.3px;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', '关闭设置'); // [lc-1064] 纯符号按钮补读屏器可读名称
    // 放大点击热区(36×36)并加大字号, 解决"关闭按钮难点击"; 抬升 z-index + 强制可点, 防被遮挡
    closeBtn.style.cssText = 'position:relative;z-index:2;width:36px;height:36px;flex-shrink:0;box-sizing:border-box;'
      + 'border-radius:10px;cursor:pointer;pointer-events:auto;font-size:16px;font-weight:700;'
      + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text2);border:1px solid var(--fnos-ui-border-strong);display:flex;'
      + 'align-items:center;justify-content:center;transition:all .15s;line-height:1;'
      // 防止父层/飞牛导航栏的 drag 区域把点击当窗口拖拽吞掉
      + '-webkit-app-region:no-drag!important;app-region:no-drag!important;';
    // 直接赋值 onclick(最稳) + addEventListener(捕获阶段) + pointerdown 兜底; 命中即关闭面板
    closeBtn.onclick = (e: Event) => { if (e) e.stopPropagation(); closeSettingsPanel(); };
    closeBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); closeSettingsPanel(); }, true);
    closeBtn.addEventListener('pointerdown', (e: Event) => { e.stopPropagation(); closeSettingsPanel(); });
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(240,90,90,.85)!important'; closeBtn.style.color = '#fff'; closeBtn.style.border = '1px solid rgba(240,90,90,.5)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'var(--fnos-ui-btn-bg2)!important'; closeBtn.style.color = 'var(--fnos-ui-btn-text2)'; closeBtn.style.border = '1px solid var(--fnos-ui-border-strong)'; };
    header.appendChild(title); header.appendChild(closeBtn);
    overlay.appendChild(header);

    // ===== 主体布局：左侧分类导航(30%) + 右侧内容区(70%) =====
    // 结构: overlay(flex column) -> header / bodyRow(flex:1) -> leftNav(30%) + rightContent(flex:1)
    const bodyRow = document.createElement('div');
    bodyRow.style.cssText = 'display:flex;flex:1 1 auto;min-height:0;';
    const leftNav = document.createElement('div');
    // [lc-1043] 去右缘发丝线，导航区靠自身浅色底区分
    leftNav.style.cssText = 'flex:0 0 30%;max-width:200px;min-width:130px;overflow-y:auto;'
      + 'padding:10px 8px;display:flex;flex-direction:column;gap:5px;'
      + 'background:var(--fnos-ui-nav-bg, rgba(125,110,160,.06));';
    const rightContent = document.createElement('div');
    rightContent.style.cssText = 'flex:1 1 auto;min-width:0;overflow-y:auto;padding:14px 16px 16px;';
    bodyRow.appendChild(leftNav);
    bodyRow.appendChild(rightContent);
    overlay.appendChild(bodyRow);

    // 调试日志(独立卡片; 从「退出行为」卡片迁出, 见下方 debug 块)
    const secDebug = section('调试日志');
    const secDebugBody = secDebug.body;

    // ===== [lc-1041] 分组重组：原「功能开关」大杂烩卡按域拆成三张卡，主题模式行并入「外观」=====
    //   网络与代理: 下载代理 + NAS 本地网盘代理（与「自定义代理」「TMDB 免梯子直连」同归网络分类）
    //   界面与浏览: 隐藏原始播放按钮 + 鼠标滚轮横向滚动（归播放分类）
    //   更新与维护: 检查更新/历史版本 + 维护开发者按钮（归通用分类，原嵌在开关卡底部）
    const secNet = section('网络与代理');
    const secBodyNet = secNet.body;
    const secUX = section('界面与浏览');
    const secBodyUX = secUX.body;
    const secUpd = section('更新与维护');
    const secBodyUpd = secUpd.body;

    // 未传 targetBody 的调用（弹幕屏蔽类型/插帧：先建行再自行 parentElement 搬走）挂到游离容器
    const _toggleHold = document.createElement('div');
    const addToggle = (label: string, targetBody?: HTMLElement): HTMLInputElement => {
      // 用 label 包裹文字+勾选框：点整行（文字或方框）都能切换，且只触发一次 change，
      // 避免"点了文字但 checkbox 没切换"导致设置看似没保存（lc-140 修复）。
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      (targetBody || _toggleHold).appendChild(row);
      return sw;
    };
    const swProxy = addToggle('下载代理', secBodyNet);
    const swHide = addToggle('隐藏原始播放按钮', secBodyUX);
    const swNas = addToggle('NAS 本地网盘代理', secBodyNet);
    const swWheel = addToggle('鼠标滚轮横向滚动', secBodyUX);
    swProxy.addEventListener('change', () => { log('[开关保存] swProxy=' + swProxy.checked); ipcRenderer.invoke('settings:set-download-proxy', swProxy.checked).catch((e) => log('set-download-proxy failed', e)); });
    swHide.addEventListener('change', () => { log('[开关保存] swHide=' + swHide.checked); ipcRenderer.invoke('settings:set-hide-play', swHide.checked).catch((e) => log('set-hide-play failed', e)); });
    swNas.addEventListener('change', () => { log('[开关保存] swNas=' + swNas.checked); ipcRenderer.invoke('settings:set-nas-proxy', swNas.checked).catch((e) => log('set-nas-proxy failed', e)); });
    // 鼠标滚轮横向滚动：开启=竖向滚轮在横向容器内转左右滑动；关闭=恢复飞牛原生（鼠标只上下滚）
    swWheel.checked = S.wheelHScrollEnabled;
    swWheel.addEventListener('change', () => {
      S.wheelHScrollEnabled = swWheel.checked;
      log('[开关保存] swWheel=' + swWheel.checked);
      ipcRenderer.invoke('settings:set-wheel-hscroll', swWheel.checked).catch((e) => log('set-wheel-hscroll failed', e));
      // 立即应用：开启→重新绑定劫持；关闭→解绑并恢复飞牛原生横滑箭头
      wheelToScroll();
    });
    // [v400] 主题模式: 浅色 / 深色 / 跟随系统 三选一(同步飞牛原生主题 + 持久化)
    const themeRow = document.createElement('div');
    themeRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 6px;gap:10px;';
    const themeLabel = document.createElement('span');
    themeLabel.textContent = '主题模式';
    themeLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;white-space:nowrap;';
    const seg = document.createElement('div');
    seg.style.cssText = 'display:inline-flex;background:var(--fnos-ui-input-bg);border-radius:9px;padding:3px;gap:2px;flex-shrink:0;';
    const themeModes: [UiThemeMode, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
    const themeBtns: HTMLButtonElement[] = [];
    themeModes.forEach(([mode, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.mode = mode;
      b.style.cssText = 'border:none;cursor:pointer;font-size:11.5px;font-weight:600;padding:5px 9px;border-radius:7px;'
        + 'background:transparent;color:var(--fnos-ui-btn-text);transition:all .15s;white-space:nowrap;';
      b.addEventListener('click', (e: Event) => { e.stopPropagation(); setUiTheme(mode); if (S.refreshThemeSeg) S.refreshThemeSeg(); });
      seg.appendChild(b);
      themeBtns.push(b);
    });
    const refreshThemeSeg = (): void => {
      const cur = getUiTheme();
      themeBtns.forEach((b) => {
        const on = b.dataset.mode === cur;
        b.style.background = on ? 'var(--fnos-ui-exit-on)' : 'transparent';
        b.style.color = on ? '#fff' : 'var(--fnos-ui-btn-text)';
      });
    };
    S.refreshThemeSeg = refreshThemeSeg;
    refreshThemeSeg();
    themeRow.appendChild(themeLabel);
    themeRow.appendChild(seg);
    // [lc-1041] 主题模式改挂「外观」分类（secAppearance 创建处插入），不再混在功能开关里

    // ===== 底部操作栏：更新相关操作（lc-635 分组排版 → [lc-1041] 独立成「更新与维护」卡归通用）=====
    // 布局: 用户常用(检查更新/历史版本)一行宽按钮 → 维护/开发者(应用补丁/回滚补丁/测试更新/版号切换) 2×2 网格
    const updFooter = document.createElement('div');
    updFooter.style.cssText = 'padding:2px 0 0;flex-shrink:0;';

    // ① 用户常用：检查更新 + 历史版本（一行等宽）
    const updGrid = document.createElement('div');
    updGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    const updBtn = mkBtn('检查更新', true);
    const updHistoryBtn = mkBtn('历史版本', true);
    updGrid.appendChild(updBtn);
    updGrid.appendChild(updHistoryBtn);
    updFooter.appendChild(updGrid);

    // ② 维护/开发者分组：应用补丁 / 回滚补丁 / 测试更新 / 版号切换（2×2，前两个维护类、后两个需解锁码）
    const devSep = document.createElement('div');
    devSep.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;color:var(--fnos-ui-muted);font-size:10.5px;opacity:.7;user-select:none;';
    devSep.innerHTML = '<span style="flex-shrink:0;">维护 / 开发者</span><span style="flex:1;height:1px;background:var(--fnos-ui-border);"></span>';
    updFooter.appendChild(devSep);

    const devGrid = document.createElement('div');
    devGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    // [lc-474] 一键应用热补丁：应用内直接拉取并填补小 bug 修复，不跳浏览器手动下载
    const patchBtn = mkBtn('应用补丁', true);
    // [lc-511] 回滚补丁：清除已应用补丁覆盖并重启回原版
    const rollbackBtn = mkBtn('回滚补丁', true);
    // [lc-481] 开发者测试更新：点击需输入解锁码，验证通过后从 Gitee 拉取 -test 补丁并应用（普通用户无码，永远拿不到）
    const testBtn = mkBtn('测试更新', true);
    // [lc-634] 版号切换：开发者输入解锁码后自定义整个软件版本号(测试更新检测/覆盖安装)
    const verSwitchBtn = mkBtn('版号切换', true);
    devGrid.appendChild(patchBtn);
    devGrid.appendChild(rollbackBtn);
    devGrid.appendChild(testBtn);
    devGrid.appendChild(verSwitchBtn);
    updFooter.appendChild(devGrid);

    const testHint = document.createElement('div');
    testHint.textContent = '🔧 测试更新 / 版号切换：开发者测试通道，需解锁码（普通用户无需操作）';
    testHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);opacity:.75;text-align:center;margin-top:9px;line-height:1.5;';
    updFooter.appendChild(testHint);

    secBodyUpd.appendChild(updFooter);   // [lc-1041] 原 sec1.el(功能开关卡) → 独立「更新与维护」卡
    updBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); ipcRenderer.invoke('settings:check-update'); });
    updHistoryBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); openHistoryModal(); });
    patchBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        fntvOpenPatchApplyPopup(false);
    });
    // [lc-516] 设置面板「应用补丁」与更新弹窗共用模块级 fntvOpenPatchApplyPopup（不依赖 injectSettingsUI 时机）。
    // [lc-644] 测试更新恢复小弹窗流程(用户要求"原来测试更新的那种小弹窗"):
    //   300px 解锁码小弹窗(promptUnlockCode) → 验证 → 360px 列表弹窗(openTestPatchWizard)
    // [lc-645] 解锁码验证移入 promptUnlockCode 内部(onVerify): 错码在 300px 小弹窗内提示,
    //   不再弹出 360px 大错误弹窗(用户反馈"错误弹窗大小和第一个弹窗不适配")
    testBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        if (testBtn.disabled) return;
        const code = await promptUnlockCode({
            title: '🔧 开发者测试更新',
            subtitle: '请输入解锁码以获取 Gitee 测试补丁',
            onVerify: (c) => ipcRenderer.invoke('settings:verify-unlock-code', c).then((r: any) => !!r.ok),
        });
        if (code === null) return; // 用户取消
        openTestPatchWizard(code);
    });
    // [lc-511] 回滚补丁：调用主进程清除补丁覆盖并重启回原版
    rollbackBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        ipcRenderer.invoke('settings:rollback-patch');
    });

    // [lc-644] 版号切换恢复小弹窗流程(与测试更新一致):
    //   300px 解锁码小弹窗(promptUnlockCode) → 主进程验证 → 320px 版本号输入弹窗(openVersionSwitchModal)
    // [lc-645] 解锁码验证移入 promptUnlockCode 内部(onVerify), 错码在 300px 小弹窗内提示
    verSwitchBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        if (verSwitchBtn.disabled) return;
        const code = await promptUnlockCode({
            title: '版号切换',
            subtitle: '请输入解锁码以自定义软件版本号',
            onVerify: (c) => ipcRenderer.invoke('settings:verify-unlock-code', c).then((r: any) => !!r.ok),
        });
        if (code === null) return; // 用户取消
        openVersionSwitchModal(code);
    });

    // [lc-474] 轻量提示条（应用补丁结果反馈，2.4s 后自动消失）
    function showPatchToast(msg: string): void {
        let t = document.getElementById('fntv-patch-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'fntv-patch-toast';
            t.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
                + 'max-width:80vw;padding:8px 14px;border-radius:8px;font-size:12px;line-height:1.5;'
                + 'background:rgba(20,22,30,.92);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.4);'
                + 'pointer-events:none;opacity:0;transition:opacity .25s;white-space:pre-wrap;text-align:center;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        requestAnimationFrame(() => { if (t) t.style.opacity = '1'; });
        setTimeout(() => { if (t) t.style.opacity = '0'; }, 2400);
    }

    // [lc-481] 解锁码输入弹窗：返回输入的解锁码；用户取消返回 null。复用现有 modal 样式；可重复调用（resolve 用模块级变量避免重复绑定）。
    // [lc-645] 支持 options 参数:
    //   - title/subtitle: 自定义弹窗标题/副标题(测试更新/版号切换各自文案)
    //   - onVerify(code): 可选——确定时先主进程验证解锁码, 通过才关闭弹窗返回 code;
    //     错码直接在 300px 小弹窗内显示「解锁代码错误」(弹窗不关闭, 无大错误弹窗,
    //     解决用户反馈"输错码弹出错误弹窗大小和第一个弹窗不适配")。
    let _unlockResolve: ((v: string | null) => void) | null = null;
    function promptUnlockCode(opts?: { title?: string; subtitle?: string; onVerify?: (code: string) => Promise<boolean> }): Promise<string | null> {
        return new Promise((resolve) => {
            let modal = document.getElementById('fntv-unlock-modal') as HTMLElement | null;
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'fntv-unlock-modal';
                modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
                modal.style.cssText = 'position:fixed;z-index:2147483710;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
                modal.addEventListener('click', (e: Event) => {
                    if (e.target === modal) { modal!.remove(); if (_unlockResolve) { _unlockResolve(null); _unlockResolve = null; } }
                });

                const card = document.createElement('div');
                card.style.cssText = 'width:300px;border-radius:16px;padding:20px;color:var(--fnos-ui-text);'
                    + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
                    + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
                    + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
                // 标题/副标题/错误提示: 用独立元素, 每次打开时按 opts 动态更新
                const titleEl = document.createElement('div');
                titleEl.id = 'fntv-unlock-title';
                titleEl.style.cssText = 'font-size:16px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:4px;';
                card.appendChild(titleEl);
                const subEl = document.createElement('div');
                subEl.id = 'fntv-unlock-subtitle';
                subEl.style.cssText = 'font-size:12px;line-height:1.6;color:var(--fnos-ui-text);opacity:.8;margin-bottom:14px;';
                card.appendChild(subEl);
                // 错误提示(默认隐藏, 错码时显示, 弹窗不关闭)
                const errEl = document.createElement('div');
                errEl.id = 'fntv-unlock-err';
                errEl.style.cssText = 'display:none;font-size:11.5px;color:#ff7a7a;font-weight:600;margin:-6px 0 8px;';
                card.appendChild(errEl);

                const input = document.createElement('input');
                input.type = 'password';
                input.placeholder = '解锁码';
                input.id = 'fntv-unlock-input';
                input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:9px;font-size:13px;'
                    + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);outline:none;';
                card.appendChild(input);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:8px;margin-top:16px;';
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.textContent = '取消';
                cancelBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;'
                    + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-btn-text);';
                const okBtn = document.createElement('button');
                okBtn.type = 'button';
                okBtn.textContent = '确定';
                // [lc-640] 主按钮实色紫底白字(与其他弹窗一致)
                okBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;'
                    + 'background:linear-gradient(135deg,#8a6dd6,#6b4ec8)!important;color:#fff!important;'
                    + 'border:1px solid rgba(255,255,255,.28)!important;box-shadow:0 4px 14px rgba(107,78,200,.38);';
                row.appendChild(cancelBtn);
                row.appendChild(okBtn);
                card.appendChild(row);
                modal.appendChild(card);
                document.body.appendChild(modal);

                const doClose = (val: string | null) => { modal!.remove(); if (_unlockResolve) { _unlockResolve(val); _unlockResolve = null; } };
                const doSubmit = (): void => {
                    const code = (input.value || '').trim();
                    if (!code) {
                        // [lc-646] 空码: 弹窗内红字提示(不用 toast, 顶部 toast 用户容易忽略以为"没反应")
                        errEl.style.display = 'block';
                        errEl.textContent = '请输入解锁码';
                        return;
                    }
                    if (opts && opts.onVerify) {
                        // [lc-645] 先验证: 通过才关闭, 错码在弹窗内提示(不关闭, 保持同尺寸)
                        opts.onVerify(code).then((ok) => {
                            if (ok) {
                                doClose(code);
                            } else {
                                errEl.style.display = 'block';
                                errEl.textContent = '解锁代码错误，请重新输入';
                            }
                        }).catch(() => {
                            errEl.style.display = 'block';
                            errEl.textContent = '解锁码验证失败，请重试';
                        });
                    } else {
                        doClose(code);
                    }
                };
                cancelBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doClose(null); });
                okBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doSubmit(); });
                input.addEventListener('keydown', (e: KeyboardEvent) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') doSubmit();
                    else if (e.key === 'Escape') doClose(null);
                });
            }
            // [lc-645] 每次打开更新标题/副标题/清错误提示
            const tEl = modal.querySelector('#fntv-unlock-title') as HTMLElement | null;
            if (tEl) tEl.textContent = (opts && opts.title) || '🔧 开发者测试更新';
            const sEl = modal.querySelector('#fntv-unlock-subtitle') as HTMLElement | null;
            if (sEl) sEl.textContent = (opts && opts.subtitle) || '请输入解锁码以获取 Gitee 测试补丁';
            const eEl = modal.querySelector('#fntv-unlock-err') as HTMLElement | null;
            if (eEl) { eEl.style.display = 'none'; eEl.textContent = ''; }
            _unlockResolve = resolve;
            modal.style.display = 'flex';
            const inp = modal.querySelector('#fntv-unlock-input') as HTMLInputElement | null;
            if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
        });
    }

    // [lc-634] 版号切换：解锁码验证通过 → 输入自定义版本号(留空=恢复默认) → 主进程保存并生效
    // [lc-644] 版号切换弹窗恢复小弹窗流程(与测试更新一致):
    //   解锁码已在外部 300px promptUnlockCode 小弹窗验证通过, 这里只做版本号输入(320px 小弹窗)。
    let _verSwitchModal: HTMLElement | null = null;
    function openVersionSwitchModal(code: string): void {
        let modal = document.getElementById('fntv-version-switch-modal') as HTMLElement | null;
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'fntv-version-switch-modal';
            modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
            modal.style.cssText = 'position:fixed;z-index:2147483711;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
            modal.addEventListener('click', (e: Event) => {
                if (e.target === modal) modal!.remove();
            });

            const card = document.createElement('div');
            card.style.cssText = 'width:300px;border-radius:16px;padding:20px;color:var(--fnos-ui-text);'
                + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
                + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
                + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
            card.innerHTML = ''
                + '<div style="font-size:16px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:4px;">版号切换</div>'
                + '<div style="font-size:12px;line-height:1.6;color:var(--fnos-ui-text);opacity:.8;margin-bottom:6px;">输入自定义版本号（如 9.9.9）模拟新旧版本，测试更新检测 / 覆盖安装</div>'
                + '<div style="font-size:11px;line-height:1.5;color:var(--fnos-ui-muted);opacity:.7;margin-bottom:12px;">留空并确定 = 恢复安装包真实版本</div>';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = '例如 9.9.9';
            input.id = 'fntv-version-switch-input';
            input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:9px;font-size:13px;'
                + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);outline:none;';
            card.appendChild(input);

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;margin-top:16px;';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;'
                + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-btn-text);';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.textContent = '确定';
            okBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;'
                + 'background:linear-gradient(135deg,#8a6dd6,#6b4ec8)!important;color:#fff!important;'
                + 'border:1px solid rgba(255,255,255,.28)!important;box-shadow:0 4px 14px rgba(107,78,200,.38);';
            row.appendChild(cancelBtn);
            row.appendChild(okBtn);
            card.appendChild(row);
            modal.appendChild(card);
            document.body.appendChild(modal);

            const doClose = () => { modal!.remove(); };
            const doSubmit = () => {
                const v = (input.value || '').trim();
                okBtn.disabled = true;
                okBtn.textContent = '提交中…';
                ipcRenderer.invoke('settings:set-custom-version', code, v).then((r: any) => {
                    doClose();
                    if (r && r.ok) {
                        showPatchToast(`版号已切换为 ${r.displayVersion || '(默认)'}${v ? '（重启后版本显示同步）' : ''}`);
                        // 刷新版本显示（设置面板「关于」等监听 version-info 的地方自动更新）
                        ipcRenderer.send('get-version');
                    } else {
                        showPatchToast('版号切换失败：' + ((r && r.message) || '未知错误'));
                    }
                }).catch(() => {
                    okBtn.disabled = false;
                    okBtn.textContent = '确定';
                    showPatchToast('版号切换失败：主进程无响应');
                });
            };
            cancelBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doClose(); });
            okBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doSubmit(); });
            input.addEventListener('keydown', (e: KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === 'Enter') doSubmit();
                else if (e.key === 'Escape') doClose();
            });
        }
        modal.style.display = 'flex';
        const inp = modal.querySelector('#fntv-version-switch-input') as HTMLInputElement | null;
        if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
    }

    // [lc-483] 热补丁「应用补丁」向导弹窗：
    // 打开即实时检查 → 有更新显示版本号+「立即应用」→ 点击后实时下载进度 → 应用完立即重启/重载。
    // 单例 modal，用户关闭即 remove() 并从 DOM 移除（下次打开重建并重新检查），进度事件通过 settings:patch-progress 实时驱动。
    // [lc-485] 分层关闭：关掉本向导只移除自身，回到设置面板这一层（遮罩仍在）；彻底退出由设置面板自身关闭(点遮罩/ESC/关闭按钮)处理。

    // [lc-516] openPatchWizard/closePatchWizard 已提升为模块级 fntvOpenPatchApplyPopup（见文件顶部），此处不再保留嵌套版本。

    // [lc-492] 开发者测试更新「选择 + 应用」向导弹窗：
    // 解锁码验证通过 → 实时列出 Gitee 上所有 -test 测试补丁 → 用户选择版本 → 点「立即应用」实时下载/应用 → 应用完重启/重载。
    // 与 openPatchWizard 同源设计，但走 settings:list-test-patches / settings:apply-test-patch(带版本)。
    // 关闭即退出设置面板（一次性任务流，避免「关了向导还有一层遮罩」）。
    // [lc-644] 恢复原小弹窗流程: 解锁码由 300px promptUnlockCode 小弹窗输入(用户要求),
    //   验证通过后进入本 360px 列表弹窗。
    let _testWizardModal: HTMLElement | null = null;
    let _testProgHandler: ((_e: any, p: any) => void) | null = null;
    let _lastTestCode = '';
    let _testSelectedVersion: string | null = null;

    function openTestPatchWizard(code: string): void {
        _lastTestCode = code;
        if (!_testWizardModal) {
            const modal = document.createElement('div');
            modal.id = 'fntv-test-wizard';
            modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
            modal.style.cssText = 'position:fixed;z-index:2147483705;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
            modal.addEventListener('click', (e: Event) => {
                // 仅非进行中状态允许点遮罩关闭；下载/应用中禁止
                if (e.target === modal && modal.getAttribute('data-closable') === '1') closeTestPatchWizard();
            });
            const card = document.createElement('div');
            card.style.cssText = 'width:300px;border-radius:16px;padding:20px;color:var(--fnos-ui-text);'
                + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
                + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
                + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
            const body = document.createElement('div');
            body.id = 'fntv-test-body';
            card.appendChild(body);
            modal.appendChild(card);
            document.body.appendChild(modal);
            _testWizardModal = modal;
        }
        _testWizardModal.style.display = 'flex';
        _testWizardModal.setAttribute('data-closable', '1');
        renderTestState('listing', null);
        ipcRenderer.invoke('settings:list-test-patches', code).then((res: any) => {
            if (res && res.ok) {
                const patches: any[] = (res.patches || []).filter((p: any) => p && p.hasAsset);
                if (patches.length > 0) renderTestState('select', { patches });
                else renderTestState('empty', { message: 'Gitee 暂无带补丁包的 -test 测试版' });
            } else {
                renderTestState('error', { message: (res && res.message) || '检测失败' });
            }
        }).catch((err: any) => {
            renderTestState('error', { message: '检测失败: ' + ((err && err.message) || err) });
        });
    }

    function closeTestPatchWizard(): void {
        if (_testWizardModal) { _testWizardModal.remove(); _testWizardModal = null; }
        if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
        // [lc-637] 修正分层: 关闭测试更新弹窗只退一层——回到设置面板大弹窗,
        //   不再连带 closeSettingsPanel()(旧 lc-492 设计"关闭即退出设置面板"被用户否掉)。
        //   设置面板由用户自行点遮罩/✕/ESC 关闭, 与 应用补丁/版号切换 弹窗行为一致。
    }

    // 测试补丁向导渲染：listing / select / empty / error / downloading / applying / done
    function renderTestState(state: string, info: any): void {
        const modal = _testWizardModal;
        if (!modal) return;
        const body = modal.querySelector('#fntv-test-body') as HTMLElement;
        if (!body) return;
        const closable = (state === 'listing' || state === 'select' || state === 'empty' || state === 'error');
        modal.setAttribute('data-closable', closable ? '1' : '0');
        body.innerHTML = '';

        if (state === 'listing') {
            body.appendChild(spinnerEl());
            body.appendChild(centerText('正在检测测试补丁列表…', '14px', 'var(--fnos-ui-text)', 'margin-top:14px;font-weight:600;'));
            return;
        }
        if (state === 'empty') {
            body.appendChild(centerText('📭', '24px', 'var(--fnos-ui-muted)', 'margin-bottom:6px;'));
            body.appendChild(centerText('暂无可用测试补丁', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:6px;'));
            body.appendChild(centerText((info && info.message) || 'Gitee 上未发布带补丁包的 -test 版本', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:16px;'));
            body.appendChild(actionRow([{ label: '关闭', primary: true, onClick: () => closeTestPatchWizard() }]));
            return;
        }
        if (state === 'error') {
            body.appendChild(centerText('⚠', '24px', '#ff7a7a', 'font-weight:800;margin-bottom:6px;'));
            body.appendChild(centerText('出错了', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:8px;'));
            body.appendChild(centerText((info && info.message) || '未知错误', '12px', 'var(--fnos-ui-muted)', 'opacity:.85;line-height:1.6;margin-bottom:16px;word-break:break-word;'));
            body.appendChild(actionRow([
                // [lc-642] 重试 = 同一 360px 弹窗内回 unlock(重新输入解锁码),
                //   不再关弹窗跳 300px 解锁码小弹窗(用户反馈弹窗大小应一致)
                { label: '重试', primary: false, onClick: () => {
                    // [lc-644] 恢复小弹窗流程: 重试 = 关本弹窗 → 重新弹 300px 解锁码小弹窗
                    (async () => {
                        closeTestPatchWizard();
                        const code = await promptUnlockCode();
                        if (code !== null) openTestPatchWizard(code);
                    })();
                } },
                { label: '关闭', primary: true, onClick: () => closeTestPatchWizard() },
            ]));
            return;
        }
        if (state === 'select') {
            const patches: any[] = (info && info.patches) || [];
            _testSelectedVersion = patches.length ? patches[0].version : null; // 默认选最新
            body.appendChild(centerText('🔧 开发者测试补丁', '16px', 'var(--fnos-ui-pill-text)', 'font-weight:800;margin-bottom:4px;'));
            body.appendChild(centerText('选择要应用的测试版本', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:12px;'));
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;margin-bottom:14px;';
            const btns: HTMLButtonElement[] = [];
            patches.forEach((p: any, idx: number) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.textContent = 'v' + p.version;
                item.style.cssText = 'width:100%;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;text-align:left;'
                    + (idx === 0
                        ? 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);'
                        : 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);');
                item.addEventListener('click', (e: Event) => {
                    e.stopPropagation();
                    _testSelectedVersion = p.version;
                    btns.forEach((b, i) => {
                        const sel = i === idx;
                        b.style.background = sel ? 'var(--fnos-ui-pill-bg)!important' : 'var(--fnos-ui-input-bg)';
                        b.style.color = sel ? 'var(--fnos-ui-pill-text)' : 'var(--fnos-ui-text)';
                        b.style.border = sel ? '1px solid var(--fnos-ui-pill-border)' : '1px solid var(--fnos-ui-border)';
                    });
                });
                btns.push(item);
                list.appendChild(item);
            });
            body.appendChild(list);
            body.appendChild(actionRow([
                { label: '取消', primary: false, onClick: () => closeTestPatchWizard() },
                { label: '立即应用', primary: true, onClick: () => startTestApply() },
            ]));
            return;
        }
        if (state === 'downloading' || state === 'applying' || state === 'done') {
            const pct = (info && typeof info.percent === 'number') ? info.percent : -1;
            const track = document.createElement('div');
            track.style.cssText = 'height:8px;border-radius:6px;background:var(--fnos-ui-input-bg);overflow:hidden;margin:6px 0 8px;';
            const fill = document.createElement('div');
            const done = state === 'done';
            const indeterminate = pct < 0 && !done;
            fill.style.cssText = 'height:100%;border-radius:6px;transition:width .25s;'
                + 'background:var(--fnos-ui-pill-bg)!important;'
                + (done ? 'width:100%;' : indeterminate ? 'width:40%;animation:fnosPatchIndet 1.1s infinite ease-in-out;' : `width:${pct}%;`);
            track.appendChild(fill);
            body.appendChild(track);
            const pctText = state === 'downloading'
                ? (pct >= 0 ? `正在下载… ${pct}%` : '正在下载…')
                : state === 'applying' ? '正在应用补丁…'
                : '✓ 测试补丁已应用';
            body.appendChild(centerText(pctText, '13px', done ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-text)', 'font-weight:600;margin-bottom:4px;'));
            if (indeterminate || pct >= 0) {
                const sub = document.createElement('div');
                sub.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);opacity:.7;';
                if (info && info.total && info.total > 0) {
                    const fmt = (n: number) => (n / 1024).toFixed(0) + ' KB';
                    sub.textContent = `${fmt(info.loaded || 0)} / ${fmt(info.total)}`;
                } else {
                    sub.textContent = done ? '即将重启应用使补丁生效' : '下载中，请稍候…';
                }
                body.appendChild(sub);
            }
            if (done) {
                body.appendChild(centerText('应用即将重启 / 重载…', '11px', 'var(--fnos-ui-muted)', 'opacity:.7;margin-top:6px;'));
            }
            return;
        }
    }

    function startTestApply(): void {
        const code = _lastTestCode;
        const version = _testSelectedVersion;
        if (!version) { renderTestState('error', { message: '未选择测试版本' }); return; }
        renderTestState('downloading', { percent: 0, message: '正在下载…' });
        _testProgHandler = (_e: any, p: any) => {
            if (!p) return;
            if (p.phase === 'downloading' || p.phase === 'applying' || p.phase === 'done') {
                renderTestState(p.phase, p);
            } else if (p.phase === 'error') {
                renderTestState('error', { message: p.message || '应用失败' });
            }
        };
        ipcRenderer.on('settings:patch-progress', _testProgHandler);
        ipcRenderer.invoke('settings:apply-test-patch', code, version).then((res: any) => {
            if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
            if (res && res.ok) {
                renderTestState('done', res); // 应用进程随后会重载/重启，无需手动关闭
            } else {
                renderTestState('error', { message: (res && res.message) || '应用失败' });
            }
        }).catch((err: any) => {
            if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
            renderTestState('error', { message: '应用失败: ' + ((err && err.message) || err) });
        });
    }

    // [lc-516] renderPatchState/startPatchApply 已提升为模块级 fntvRenderPatchApply/fntvStartPatchApply（见文件顶部）。

    // 小工具：居中文字
    function centerText(text: string, size: string, color: string, extra = ''): HTMLElement {
        const d = document.createElement('div');
        d.textContent = text;
        d.style.cssText = `font-size:${size};color:${color};${extra}`;
        return d;
    }
    // 小工具：按钮行
    function actionRow(actions: Array<{ label: string; primary: boolean; onClick: () => void }>): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;';
        for (const a of actions) {
            const b = mkBtn(a.label, !a.primary);
            // [lc-641] 两个按钮等宽：主次都 flex:1，避免次按钮窄主按钮宽视觉不平衡
            b.style.flex = '1';
            if (a.primary) {
                // [lc-640] 主按钮改实色紫底白字(高对比, 两主题统一)——
                //   旧 var(--fnos-ui-pill-bg)=rgba(150,120,200,.22) 浅紫透明 + pill-text=#cbb8ef 浅紫字
                //   对比度极差(版号切换用户反馈「按钮显示有问题」)。
                b.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;'
                    + 'background:linear-gradient(135deg,#8a6dd6,#6b4ec8)!important;'
                    + 'color:#fff!important;border:1px solid rgba(255,255,255,.28)!important;'
                    + 'box-shadow:0 4px 14px rgba(107,78,200,.38);letter-spacing:.3px;';
            } else {
                // [lc-641] 次按钮也 padding 对齐主按钮(原 mkBtn small 样式 padding:7px 12px,
                //   视觉比主按钮 9px 0 矮, 加上 flex:1 后宽度一致但高度不齐)
                b.style.padding = '9px 12px';
            }
            b.addEventListener('click', (e: Event) => { e.stopPropagation(); a.onClick(); });
            row.appendChild(b);
        }
        return row;
    }
    // 小工具：旋转 spinner
    function spinnerEl(): HTMLElement {
        const s = document.createElement('div');
        s.style.cssText = 'width:30px;height:30px;margin:2px auto 0;border-radius:50%;'
            + 'border:3px solid var(--fnos-ui-border);border-top-color:var(--fnos-ui-pill-bg);'
            + 'animation:fnosPatchSpin .8s linear infinite;';
        return s;
    }
    // 注入 keyframes（仅一次）
    if (!document.getElementById('fntv-patch-kf')) {
        const st = document.createElement('style');
        st.id = 'fntv-patch-kf';
        st.textContent = '@keyframes fnosPatchSpin{to{transform:rotate(360deg)}}'
            + '@keyframes fnosPatchIndet{0%{margin-left:0}50%{margin-left:55%}100%{margin-left:0}}';
        document.head.appendChild(st);
    }


    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组2: MPV 路径 =====
    const sec2 = section('播放器');
    const secBody2 = sec2.body;

    // 双栏布局：左=MPV，右=PotPlayer（窄屏自动折叠为单栏）
    const playerCols = document.createElement('div');
    playerCols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:16px;margin-top:4px;';
    const colMpv = document.createElement('div');
    colMpv.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;';
    const colPot = document.createElement('div');
    colPot.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;padding-left:16px;border-left:1px solid var(--fnos-ui-border2);';
    const subHead = (text: string): HTMLElement => {
        const d = document.createElement('div');
        d.textContent = text;
        d.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--fnos-ui-sec);margin-bottom:2px;';
        return d;
    };
    colMpv.appendChild(subHead('MPV'));
    colPot.appendChild(subHead('PotPlayer'));
    playerCols.appendChild(colMpv);
    playerCols.appendChild(colPot);
    secBody2.appendChild(playerCols);

    const mpvLabel = document.createElement('div');
    mpvLabel.textContent = 'MPV 路径（留空则使用应用内置）';
    mpvLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:0 0 5px;';
    colMpv.appendChild(mpvLabel);

    const mpvPath = document.createElement('div');
    mpvPath.id = 'fnos-mpv-path';
    mpvPath.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2);word-break:break-all;margin-bottom:7px;min-height:28px;'
      + 'max-height:72px;overflow-y:auto;padding:6px 9px;background:var(--fnos-ui-input-bg);border-radius:7px;'
      + 'border:1px solid var(--fnos-ui-border);line-height:1.5;';
    mpvPath.textContent = '应用内置（已随安装包分发，无需本机安装）'; // 初始占位, 不依赖 _refresh 回填
    colMpv.appendChild(mpvPath);

    const mpvBtns = document.createElement('div');
    mpvBtns.style.cssText = 'display:flex;gap:6px;';
    const pickBtn = mkBtn('选择文件', true);
    const clearBtn = mkBtn('清空', true);
    const iccToggleBtn = mkBtn('ICC 校色：开', true);
    iccToggleBtn.style.fontWeight = '600';
    iccToggleBtn.style.color = 'var(--fnos-ui-accent)';
    mpvBtns.appendChild(pickBtn); mpvBtns.appendChild(clearBtn); mpvBtns.appendChild(iccToggleBtn);
    colMpv.appendChild(mpvBtns);
    pickBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-mpv-path');
      if (p) mpvPath.textContent = p as string;
    });
    clearBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-mpv-path');
      mpvPath.textContent = '应用内置（已随安装包分发，无需本机安装）';
    });

    // ===== 默认 MPV 着色器（由应用面板管理 MPV 启动默认，MPV 内 Ctrl+1~9 仍可临时切换）=====
    const shaderLabel = document.createElement('div');
    shaderLabel.textContent = '默认 MPV 着色器';
    shaderLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:12px 0 5px;';
    colMpv.appendChild(shaderLabel);

    const shaderSel = document.createElement('select');
    shaderSel.id = 'fnos-mpv-shader';
    shaderSel.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;cursor:pointer;';
    const shaderOptions: [string, string][] = [
      ['off', '默认不生效任何着色器'],
      ['a', '模式A（大多数1080p动画）'],
      ['b', '模式B（大多数720p动画）'],
      ['aa', '模式A+A（高质量1080p）'],
      ['bb', '模式B+B（高质量720p）'],
      ['lite', '轻量模式（低配置设备）'],
      ['denoise', '仅降噪'],
      ['real', '真实系（真人/纪录片）'],
      ['cinema', '电影感'],
      ['ultra', '全增强（极致画质）']
    ];
    shaderOptions.forEach(([k, label]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = label;
      shaderSel.appendChild(o);
    });
    colMpv.appendChild(shaderSel);

    const applyShaderConfig = (): void => {
      const iccOn = iccToggleBtn.textContent?.includes('开') ?? false;
      ipcRenderer.invoke('settings:set-mpv-shader-config', { shader: shaderSel.value, icc: iccOn })
        .catch((err) => log('set-mpv-shader-config failed', err));
    };
    const renderIccBtn = (on: boolean): void => {
      iccToggleBtn.textContent = on ? 'ICC 校色：开' : 'ICC 校色：关';
      iccToggleBtn.style.color = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-muted2)';
    };
    shaderSel.addEventListener('change', applyShaderConfig);
    iccToggleBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const nowOn = !(iccToggleBtn.textContent?.includes('开') ?? false);
      renderIccBtn(nowOn);
      applyShaderConfig();
    });

    // ===== PotPlayer 路径 =====
    const potLabel = document.createElement('div');
    potLabel.textContent = 'PotPlayer 路径（留空则使用应用内置）';
    potLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:0 0 5px;';
    colPot.appendChild(potLabel);

    const potPathEl = document.createElement('div');
    potPathEl.id = 'fnos-pot-path';
    potPathEl.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2);word-break:break-all;margin-bottom:7px;min-height:28px;'
      + 'max-height:72px;overflow-y:auto;padding:6px 9px;background:var(--fnos-ui-input-bg);border-radius:7px;'
      + 'border:1px solid var(--fnos-ui-border);line-height:1.5;';
    potPathEl.textContent = '应用内置（已随安装包分发，无需本机安装）'; // 初始占位, 不依赖 _refresh 回填
    colPot.appendChild(potPathEl);

    const potBtns = document.createElement('div');
    potBtns.style.cssText = 'display:flex;gap:6px;';
    const pickPotBtn = mkBtn('选择文件', true);
    const clearPotBtn = mkBtn('清空', true);
    potBtns.appendChild(pickPotBtn); potBtns.appendChild(clearPotBtn);
    colPot.appendChild(potBtns);
    pickPotBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-pot-path');
      if (p) potPathEl.textContent = p as string;
    });
    clearPotBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-pot-path');
      potPathEl.textContent = '应用内置（已随安装包分发，无需本机安装）';
    });

    // ===== 默认播放器（直接播放时使用）=====
    const defLabel = document.createElement('div');
    defLabel.textContent = '默认播放器（直接播放时使用）';
    defLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    colPot.appendChild(defLabel);

    const defGrid = document.createElement('div');
    defGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:5px;';
    const defModes: [string, string][] = [['mpv', '内置 MPV'], ['potplayer', 'PotPlayer']];
    const defEls: HTMLButtonElement[] = [];
    defModes.forEach(([mode, text]) => {
      const b = mkBtn(text);
      b.dataset.dmode = mode;
      b.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        (overlay as any)._defaultPlayer = mode;
        refreshDefaultPlayer();
        ipcRenderer.invoke('settings:set-default-player', mode).catch((err) => log('set-default-player failed', err));
      });
      defGrid.appendChild(b); defEls.push(b);
    });
    colPot.appendChild(defGrid);

    const refreshDefaultPlayer = (): void => {
      const cur = (overlay as any)._defaultPlayer || 'mpv';
      defEls.forEach((b) => {
        const on = b.dataset.dmode === cur;
        b.style.background = on ? 'var(--fnos-ui-btn-hover2)!important' : 'var(--fnos-ui-btn-bg2)!important';
        b.style.borderColor = on ? 'var(--fnos-ui-accent)!important' : 'var(--fnos-ui-border3)';
      });
    };

    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组3: 退出行为 =====
    const sec3 = section('退出行为');
    const secBody3 = sec3.body;
    secBody3.style.cssText = 'padding:10px 12px;flex:1 1 auto;display:flex;flex-direction:column;';

    // ===== [lc-1065] 界面语言（i18n 框架的语言入口；仅影响 Fntv-Plus 注入的界面文案）=====
    //   切换即写 localStorage(fntv-lang) + 整页刷新生效 —— 与轮播样式切换同一「改完重载」机制。
    const secLang = section('语言 / Language');
    const langRow = document.createElement('div');
    langRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 6px;gap:10px;';
    const langLabel = document.createElement('span');
    langLabel.textContent = '界面语言 / Interface language';
    langLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;white-space:nowrap;';
    const langSel = document.createElement('select');
    langSel.id = 'fnos-ui-lang';
    langSel.setAttribute('aria-label', '界面语言 / Interface language');
    langSel.style.cssText = 'font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:5px 8px;cursor:pointer;flex-shrink:0;';
    [['zh', '简体中文'], ['en', 'English']].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      langSel.appendChild(o);
    });
    langSel.value = getLang();
    langSel.addEventListener('change', () => {
      if (langSel.value !== getLang()) {
        setLang(langSel.value as 'zh' | 'en');
        location.reload(); // 已渲染文案随刷新统一换语言（不做运行时 DOM 回写）
      }
    });
    const langHint = document.createElement('div');
    langHint.textContent = '切换后自动刷新页面生效（仅影响 Fntv-Plus 注入的界面文案）';
    langHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2);line-height:1.5;padding:0 6px 6px;';
    langRow.appendChild(langLabel); langRow.appendChild(langSel);
    secLang.body.appendChild(langRow);
    secLang.body.appendChild(langHint);

    const exitModes: [string, string][] = [['direct', '直接退出'], ['minimize', '最小化到托盘'], ['ask', '每次询问']];
    const exitEls: HTMLButtonElement[] = [];
    const exitGrid = document.createElement('div');
    exitGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;';
    exitModes.forEach(([mode, text]) => {
      const b = mkBtn(text);
      b.dataset.mode = mode;
      b.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // 立即本地更新高亮(乐观), IPC 后台执行不阻塞 UI → 修复"选择后没反应/卡"
        (overlay as any)._exitMode = mode;
        refreshExit();
        ipcRenderer.invoke('settings:set-exit-mode', mode).catch((err) => log('set-exit-mode failed', err));
      });
      exitGrid.appendChild(b); exitEls.push(b);
    });
    secBody3.appendChild(exitGrid);

    // ===== [lc-120] 登录页背景图自定义 =====
    const loginBgWrap = document.createElement('div');
    loginBgWrap.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid var(--fnos-ui-border2);';
    const loginBgLabel = document.createElement('div');
    loginBgLabel.textContent = '登录页背景图';
    loginBgLabel.style.cssText = 'font-size:10.5px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:8px;';
    loginBgWrap.appendChild(loginBgLabel);

    // 两个按钮：自定义登录页面背景图 / 清空（点选即生效，无需手动输路径）
    const loginBgBtns = document.createElement('div');
    loginBgBtns.style.cssText = 'display:flex;gap:6px;';
    const pickLoginBgBtn = mkBtn('自定义登录页面背景图', true);
    const clearLoginBgBtn = mkBtn('清空', true);
    loginBgBtns.appendChild(pickLoginBgBtn);
    loginBgBtns.appendChild(clearLoginBgBtn);
    loginBgWrap.appendChild(loginBgBtns);

    pickLoginBgBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-login-bg');
      if (p) applyLoginBgVar(p);
    });
    clearLoginBgBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-login-bg');
      applyLoginBgVar('');
    });

    secBody3.appendChild(loginBgWrap);
    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: B站弹幕登录 =====
    const secBili = section('B站弹幕登录');
    const secBodyBili = secBili.body;

    const biliStatus = document.createElement('div');
    biliStatus.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-warn);margin-bottom:8px;';
    secBodyBili.appendChild(biliStatus);

    // 按钮行：扫码登录 / 退出登录 / 保存 Cookie（与豆瓣左半部分按钮行同款样式）
    const biliBtns = document.createElement('div');
    biliBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const scanBtn = mkBtn('扫码登录', true);
    const logoutBiliBtn = mkBtn('退出登录', true);
    const saveBiliCookieBtn = mkBtn('保存 Cookie', true);
    biliBtns.appendChild(scanBtn); biliBtns.appendChild(logoutBiliBtn); biliBtns.appendChild(saveBiliCookieBtn);
    secBodyBili.appendChild(biliBtns);

    // 手动粘贴 Cookie（兜底：B站风控/扫码失效时用），与豆瓣左半部分 manualWrap 同款
    const biliManualWrap = document.createElement('div');
    biliManualWrap.style.cssText = 'margin-top:8px;';
    const biliManualLabel = document.createElement('div');
    biliManualLabel.textContent = '手动粘贴 Cookie（B站风控/扫码失效时用）';
    biliManualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    biliManualWrap.appendChild(biliManualLabel);
    const biliManualTa = document.createElement('input');
    biliManualTa.type = 'text';
    biliManualTa.placeholder = '粘贴浏览器里 B站的 Cookie 字符串（含 SESSDATA 等）';
    biliManualTa.style.cssText = 'width:100%;height:32px;font-size:10.5px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    biliManualWrap.appendChild(biliManualTa);
    secBodyBili.appendChild(biliManualWrap);

    // MPV B站弹幕搜索开关（联动 MPV uosc_danmaku 的 script-opts/uosc_danmaku.conf）
    const biliSearchRow = document.createElement('div');
    biliSearchRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    biliSearchRow.onmouseenter = () => { biliSearchRow.style.background = 'var(--fnos-ui-row-hover)'; };
    biliSearchRow.onmouseleave = () => { biliSearchRow.style.background = 'transparent'; };
    const biliSearchLabel = document.createElement('span');
    biliSearchLabel.textContent = '启用 MPV B站弹幕搜索';
    biliSearchLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swMpvBiliSearch = document.createElement('input');
    swMpvBiliSearch.type = 'checkbox';
    swMpvBiliSearch.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    biliSearchRow.appendChild(biliSearchLabel); biliSearchRow.appendChild(swMpvBiliSearch);
    secBodyBili.appendChild(biliSearchRow);
    swMpvBiliSearch.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-mpv-bili-search-enabled', swMpvBiliSearch.checked).catch((err) => log('set-mpv-bili-search-enabled failed', err));
    });

    // B站弹幕聚合阈值（单个视频弹幕 < 此值时，自动合并多个同类候选的弹幕）
    const aggRow = document.createElement('div');
    aggRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;gap:10px;';
    const aggLabel = document.createElement('span');
    aggLabel.textContent = '弹幕聚合阈值（单视频弹幕少于此数则合并多个源）';
    aggLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:12.5px;flex:1;line-height:1.4;';
    const aggInput = document.createElement('input');
    aggInput.type = 'number';
    aggInput.min = '0';
    aggInput.step = '100';
    aggInput.placeholder = '1500';
    aggInput.style.cssText = 'width:90px;padding:5px 8px;border-radius:7px;border:1px solid var(--fnos-ui-border);'
      + 'background:var(--fnos-input-bg);color:var(--fnos-ui-text);font-size:13px;text-align:center;';
    aggRow.appendChild(aggLabel); aggRow.appendChild(aggInput);
    secBodyBili.appendChild(aggRow);
    aggInput.addEventListener('change', () => {
      const v = parseInt(aggInput.value, 10);
      ipcRenderer.invoke('settings:set-mpv-bili-aggregate-threshold', isNaN(v) ? 0 : v).catch((err) => log('set-mpv-bili-aggregate-threshold failed', err));
    });

    // [lc-301] 「打开弹幕文件夹」按钮已移至下方「弹幕设置」区（secDanmaku），此处不再重复。

    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: Bangumi 登录（与「B站弹幕登录」并列，容器同尺寸）=====
    const secBangumi = section('Bangumi 登录');
    const secBodyBangumi = secBangumi.body;

    let bangumiReal = ''; // 真实 token（仅存于闭包，界面只显示掩码星号）
    const maskBangumi = (t: string): string => '*'.repeat(Math.max(0, t.length));

    const bangumiHintTop = document.createElement('div');
    bangumiHintTop.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);margin-bottom:8px;line-height:1.5;';
    bangumiHintTop.textContent = '填入你的 Bangumi Access Token 以启用 Bangumi 关联功能。';
    secBodyBangumi.appendChild(bangumiHintTop);

    // 单行 token 输入框
    const bangumiInput = document.createElement('input');
    bangumiInput.type = 'text';
    bangumiInput.placeholder = '粘贴 Bangumi Access Token';
    bangumiInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;';
    secBodyBangumi.appendChild(bangumiInput);

    // 已保存时显示星号掩码；点击进入编辑自动清空，便于重新粘贴
    bangumiInput.addEventListener('focus', () => {
      if (bangumiInput.readOnly) { bangumiInput.readOnly = false; bangumiInput.value = ''; }
    });
    bangumiInput.addEventListener('blur', () => {
      if (bangumiInput.value.trim() === '' && bangumiReal) {
        bangumiInput.value = maskBangumi(bangumiReal);
        bangumiInput.readOnly = true;
      }
    });

    const bangumiBtns = document.createElement('div');
    bangumiBtns.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const saveBangumiBtn = mkBtn('保存', true);
    const clearBangumiBtn = mkBtn('清除', true);
    bangumiBtns.appendChild(saveBangumiBtn);
    bangumiBtns.appendChild(clearBangumiBtn);
    secBodyBangumi.appendChild(bangumiBtns);

    const bangumiStatus = document.createElement('div');
    bangumiStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyBangumi.appendChild(bangumiStatus);

    // Bangumi 集数级同步开关
    const bangumiSyncRow = document.createElement('div');
    bangumiSyncRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    bangumiSyncRow.onmouseenter = () => { bangumiSyncRow.style.background = 'var(--fnos-ui-row-hover)'; };
    bangumiSyncRow.onmouseleave = () => { bangumiSyncRow.style.background = 'transparent'; };
    const bangumiSyncLabel = document.createElement('span');
    bangumiSyncLabel.textContent = '启用 Bangumi 集数同步';
    bangumiSyncLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swBangumiSync = document.createElement('input');
    swBangumiSync.type = 'checkbox';
    swBangumiSync.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    bangumiSyncRow.appendChild(bangumiSyncLabel); bangumiSyncRow.appendChild(swBangumiSync);
    secBodyBangumi.appendChild(bangumiSyncRow);
    swBangumiSync.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-bangumi-sync-enabled', swBangumiSync.checked).catch((err) => log('set-bangumi-sync-enabled failed', err));
    });

    // 同步阈值（百分比，默认80）
    const bangumiThrRow = document.createElement('div');
    bangumiThrRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
      + 'border-radius:6px;transition:background .12s;';
    const bangumiThrLabel = document.createElement('span');
    bangumiThrLabel.textContent = '同步阈值（播放进度 %）';
    bangumiThrLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
    const bangumiThresholdInput = document.createElement('input');
    bangumiThresholdInput.type = 'number';
    bangumiThresholdInput.min = '1'; bangumiThresholdInput.max = '100';
    bangumiThresholdInput.style.cssText = 'width:56px;height:26px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;'
      + 'padding:2px 6px;box-sizing:border-box;text-align:center;';
    bangumiThrRow.appendChild(bangumiThrLabel); bangumiThrRow.appendChild(bangumiThresholdInput);
    secBodyBangumi.appendChild(bangumiThrRow);
    bangumiThresholdInput.addEventListener('change', () => {
      const v = Number(bangumiThresholdInput.value) || 80;
      ipcRenderer.invoke('settings:set-bangumi-sync-threshold', v).catch((err) => log('set-bangumi-sync-threshold failed', err));
    });

    // 底部提示：点击链接用系统浏览器打开获取页
    const bangumiHintBottom = document.createElement('div');
    bangumiHintBottom.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-top:10px;line-height:1.5;';
    const bangumiLink = document.createElement('a');
    bangumiLink.textContent = 'https://next.bgm.tv/demo/access-token';
    bangumiLink.href = 'https://next.bgm.tv/demo/access-token';
    bangumiLink.style.cssText = 'color:var(--fnos-ui-sec);text-decoration:underline;cursor:pointer;';
    bangumiLink.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-external', 'https://next.bgm.tv/demo/access-token').catch(() => {});
    });
    bangumiHintBottom.appendChild(document.createTextNode('可在 '));
    bangumiHintBottom.appendChild(bangumiLink);
    bangumiHintBottom.appendChild(document.createTextNode(' 获取 Access Token。'));
    secBodyBangumi.appendChild(bangumiHintBottom);

    saveBangumiBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      // 防误清空：掩码态(readOnly)直接保存已存真实 token；若输入框被点击进入编辑态
      // 但并未填入新值（focus 已自动清空掩码），保存应保留已存 token，而不是写空串把
      // 磁盘上的旧 token 抹掉。真正清空请用「清除」按钮。
      let token: string;
      if (bangumiInput.readOnly) {
        token = bangumiReal;
      } else {
        const typed = bangumiInput.value.trim();
        token = (typed === '' && bangumiReal) ? bangumiReal : typed;
      }
      try {
        const r: any = await ipcRenderer.invoke('settings:set-bangumi-token', token);
        if (!r || r.ok !== false) {
          bangumiReal = token;
          if (token) {
            bangumiInput.value = maskBangumi(token);
            bangumiInput.readOnly = true;
            bangumiStatus.textContent = '已保存 Token';
            bangumiStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            bangumiInput.value = '';
            bangumiInput.readOnly = false;
            bangumiStatus.textContent = '已清除 Token';
            bangumiStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          bangumiStatus.textContent = '保存失败';
          bangumiStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        bangumiStatus.textContent = '保存失败';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    clearBangumiBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      bangumiInput.value = '';
      bangumiInput.readOnly = false;
      bangumiReal = '';
      try {
        await ipcRenderer.invoke('settings:set-bangumi-token', '');
        bangumiStatus.textContent = '已清除 Token';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        bangumiStatus.textContent = '清除失败';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: TMDB API Key（用于「热门剧更新」浮层的 TMDB 电影/剧集数据源）=====
    const secTmdb = section('TMDB API Key');
    const secBodyTmdb = secTmdb.body;

    let tmdbReal = ''; // 真实 key（仅存于闭包，界面只显示掩码星号）
    const maskTmdb = (t: string): string => '*'.repeat(Math.max(0, t.length));

    const tmdbHintTop = document.createElement('div');
    tmdbHintTop.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);margin-bottom:8px;line-height:1.5;';
    tmdbHintTop.textContent = '填入你的 TMDB API Key（或 v4 Read Access Token）以启用「热门剧更新」中的 TMDB 电影/剧集数据源。';
    secBodyTmdb.appendChild(tmdbHintTop);

    // 单行 key 输入框
    const tmdbInput = document.createElement('input');
    tmdbInput.type = 'text';
    tmdbInput.placeholder = '粘贴 TMDB API Key / Read Access Token';
    tmdbInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;';
    secBodyTmdb.appendChild(tmdbInput);

    tmdbInput.addEventListener('focus', () => {
      if (tmdbInput.readOnly) { tmdbInput.readOnly = false; tmdbInput.value = ''; }
    });
    tmdbInput.addEventListener('blur', () => {
      if (tmdbInput.value.trim() === '' && tmdbReal) {
        tmdbInput.value = maskTmdb(tmdbReal);
        tmdbInput.readOnly = true;
      }
    });

    const tmdbBtns = document.createElement('div');
    tmdbBtns.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const saveTmdbBtn = mkBtn('保存', true);
    const clearTmdbBtn = mkBtn('清除', true);
    tmdbBtns.appendChild(saveTmdbBtn);
    tmdbBtns.appendChild(clearTmdbBtn);
    secBodyTmdb.appendChild(tmdbBtns);

    const tmdbStatus = document.createElement('div');
    tmdbStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyTmdb.appendChild(tmdbStatus);

    // 底部提示：引导去 TMDB 申请
    const tmdbHintBottom = document.createElement('div');
    tmdbHintBottom.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-top:10px;line-height:1.5;';
    const tmdbLink = document.createElement('a');
    tmdbLink.textContent = 'https://www.themoviedb.org/settings/api';
    tmdbLink.href = 'https://www.themoviedb.org/settings/api';
    tmdbLink.style.cssText = 'color:var(--fnos-ui-sec);text-decoration:underline;cursor:pointer;';
    tmdbLink.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-external', 'https://www.themoviedb.org/settings/api').catch(() => {});
    });
    tmdbHintBottom.appendChild(document.createTextNode('可在 '));
    tmdbHintBottom.appendChild(tmdbLink);
    tmdbHintBottom.appendChild(document.createTextNode(' 免费申请 API Key。'));
    secBodyTmdb.appendChild(tmdbHintBottom);

    saveTmdbBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      // 防误清空：同 Bangumi——掩码态保存已存真实 key；编辑态清空未填新值时保留已存 key。
      let key: string;
      if (tmdbInput.readOnly) {
        key = tmdbReal;
      } else {
        const typed = tmdbInput.value.trim();
        key = (typed === '' && tmdbReal) ? tmdbReal : typed;
      }
      try {
        const r: any = await ipcRenderer.invoke('settings:set-tmdb-key', key);
        if (!r || r.ok !== false) {
          tmdbReal = key;
          if (key) {
            tmdbInput.value = maskTmdb(key);
            tmdbInput.readOnly = true;
            tmdbStatus.textContent = '已保存 TMDB Key';
            tmdbStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            tmdbInput.value = '';
            tmdbInput.readOnly = false;
            tmdbStatus.textContent = '已清除 TMDB Key';
            tmdbStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          tmdbStatus.textContent = '保存失败';
          tmdbStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        tmdbStatus.textContent = '保存失败';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    clearTmdbBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      tmdbInput.value = '';
      tmdbInput.readOnly = false;
      tmdbReal = '';
      try {
        await ipcRenderer.invoke('settings:set-tmdb-key', '');
        tmdbStatus.textContent = '已清除 TMDB Key';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        tmdbStatus.textContent = '清除失败';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // ===== TMDB 免梯子直连（实验）：用固定 IP 覆盖 DNS 解析，绕过污染直连，无需梯子 =====
    // （此区块整体迁入设置面板「插件」标签页，见下方 secTmdbDirect，故此处不再挂到 TMDB Key 区）
    const dcWrap = document.createElement('div');
    dcWrap.style.cssText = 'margin-top:4px;';

    const dcDesc = document.createElement('div');
    dcDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    dcDesc.textContent = '开启后用固定 IP 覆盖 DNS 解析，绕过污染直连 TMDB（无需梯子）。IP 来自 CheckTMDB 项目，CDN 边缘节点可能变动，可点「更新 IP」拉取最新，或手动填写。';
    dcWrap.appendChild(dcDesc);

    const dcRow = document.createElement('label');
    dcRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fnos-ui-text);cursor:pointer;margin-bottom:8px;';
    const dcToggle = document.createElement('input');
    dcToggle.type = 'checkbox';
    // [lc-1043] 原内联 width:16px;height:16px 已删：inline 压掉面板全局 iOS 开关样式
    // （38×22 轨道 + ::after 滑块），18px 滑块从 16px 轨道溢出压住「启」字（用户截图报障）。
    // 交由 #fnos-settings-panel input[type=checkbox] 统一渲染，与其余 9 处开关同款。
    const dcToggleLabel = document.createElement('span');
    dcToggleLabel.textContent = '启用免梯子直连';
    dcRow.appendChild(dcToggle);
    dcRow.appendChild(dcToggleLabel);
    dcWrap.appendChild(dcRow);

    const dcIpGrid = document.createElement('div');
    dcIpGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    const dcApiInput = document.createElement('input');
    dcApiInput.type = 'text';
    dcApiInput.placeholder = 'api IP（如 65.8.20.79）';
    dcApiInput.style.cssText = 'width:100%;height:30px;font-size:11px;color:var(--fnos-ui-text);';
    const dcImgInput = document.createElement('input');
    dcImgInput.type = 'text';
    dcImgInput.placeholder = 'img IP（如 65.8.20.8）';
    dcImgInput.style.cssText = 'width:100%;height:30px;font-size:11px;color:var(--fnos-ui-text);';
    dcIpGrid.appendChild(dcApiInput);
    dcIpGrid.appendChild(dcImgInput);
    dcWrap.appendChild(dcIpGrid);

    const dcBtns = document.createElement('div');
    dcBtns.style.cssText = 'display:flex;gap:6px;';
    const dcSaveBtn = mkBtn('保存', true);
    const dcUpdateBtn = mkBtn('从 CheckTMDB 更新 IP', true);
    dcBtns.appendChild(dcSaveBtn);
    dcBtns.appendChild(dcUpdateBtn);
    dcWrap.appendChild(dcBtns);

    const dcStatus = document.createElement('div');
    dcStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    dcWrap.appendChild(dcStatus);

    dcSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const api = dcApiInput.value.trim();
        const img = dcImgInput.value.trim();
        const r: any = await ipcRenderer.invoke('settings:set-tmdb-direct', {
          enabled: dcToggle.checked,
          ip: { api: api || undefined, img: img || undefined },
        });
        if (!r || r.ok !== false) {
          dcStatus.textContent = dcToggle.checked ? '已启用免梯子直连' : '已关闭免梯子直连';
          dcStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          dcStatus.textContent = '保存失败';
          dcStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        dcStatus.textContent = '保存失败';
        dcStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    dcUpdateBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      dcStatus.textContent = '正在从 CheckTMDB 拉取最新 IP…';
      dcStatus.style.color = 'var(--fnos-ui-sub)';
      try {
        const r: any = await ipcRenderer.invoke('tmdb:update-ip');
        if (r && r.ok) {
          if (r.api) dcApiInput.value = r.api;
          if (r.img) dcImgInput.value = r.img;
          dcStatus.textContent = '已更新为最新 IP' + (r.api ? `（api ${r.api}）` : '');
          dcStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          dcStatus.textContent = (r && r.error) || '更新失败';
          dcStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        dcStatus.textContent = '更新失败';
        dcStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // ===== 数据源切换：TMDB / 豆瓣（默认豆瓣，国内直连免 Key）=====
    const tmdbSettingsWrap = document.createElement('div');
    tmdbSettingsWrap.appendChild(tmdbHintTop);
    tmdbSettingsWrap.appendChild(tmdbInput);
    tmdbSettingsWrap.appendChild(tmdbBtns);
    tmdbSettingsWrap.appendChild(tmdbStatus);
    tmdbSettingsWrap.appendChild(tmdbHintBottom);

    const dsHint = document.createElement('div');
    dsHint.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    dsHint.textContent = '选择「热门剧更新」浮层的数据源。豆瓣国内直连、免 Key、零配置；TMDB 数据更全但需 Key 且可能被墙（需免梯子直连/代理）。';

    const dsSeg = document.createElement('div');
    dsSeg.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    const mkDsBtn = (label: string, val: 'tmdb' | 'douban'): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'flex:1;height:30px;font-size:12px;border-radius:7px;cursor:pointer;border:1px solid var(--fnos-ui-border);background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);';
      b.addEventListener('click', (e: Event) => { e.stopPropagation(); setDs(val); });
      return b;
    };
    const dsTmdbBtn = mkDsBtn('TMDB', 'tmdb');
    const dsDoubanBtn = mkDsBtn('豆瓣', 'douban');
    dsSeg.appendChild(dsTmdbBtn);
    dsSeg.appendChild(dsDoubanBtn);

    const doubanHint = document.createElement('div');
    doubanHint.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-ok);line-height:1.5;margin-bottom:8px;';
    doubanHint.textContent = '✓ 已选豆瓣：国内直连、免 Key、零配置，无需任何额外设置。「热门剧更新」浮层将展示豆瓣热门影视。';

    // 仅刷新 UI 显示（不写盘）：用于构建/打开时按「磁盘真值」回填，避免用默认/内存旧值覆盖已保存选择
    const reflectDs = (val: 'tmdb' | 'douban'): void => {
      const isDouban = val === 'douban';
      dsDoubanBtn.style.background = isDouban ? 'var(--fnos-ui-sec)' : 'var(--fnos-ui-input-bg)';
      dsDoubanBtn.style.color = isDouban ? '#fff' : 'var(--fnos-ui-text)';
      dsTmdbBtn.style.background = isDouban ? 'var(--fnos-ui-input-bg)' : 'var(--fnos-ui-sec)';
      dsTmdbBtn.style.color = isDouban ? 'var(--fnos-ui-text)' : '#fff';
      tmdbSettingsWrap.style.display = isDouban ? 'none' : '';
      doubanHint.style.display = isDouban ? '' : 'none';
    };

    // 用户点击选择数据源：写盘 + 同步内存 + 刷新 UI
    const setDs = (val: 'tmdb' | 'douban'): void => {
      S.hotSource = val;
      try { ipcRenderer.invoke('settings:set-hot-source', val).catch(() => {}); } catch { /* ignore */ }
      reflectDs(val);
    };

    secBodyTmdb.insertBefore(dsHint, secBodyTmdb.firstChild);
    secBodyTmdb.appendChild(dsSeg);
    secBodyTmdb.appendChild(tmdbSettingsWrap);
    secBodyTmdb.appendChild(doubanHint);

    // 初始状态：异步从「磁盘真值」回填 UI（不写盘！）
    // 关键修复：此前这里用同步 setDs(S.hotSource)，而 S.hotSource 要到 settings:get 异步回填(行55)才就绪，
    // 构建期若早于回填执行，S.hotSource 仍是默认 'douban'，会把磁盘上已存的 'tmdb' 错误写回 'douban'，
    // 表现为「选了 TMDB → 关掉设置/导航后变回豆瓣」。改为只读磁盘真值 reflect，杜绝启动期 clobber。
    try {
      ipcRenderer.invoke('settings:get-hot-source').then((s: string) => {
        S.hotSource = (s === 'tmdb') ? 'tmdb' : 'douban';
        reflectDs(S.hotSource);
      }).catch(() => { reflectDs(S.hotSource); });
    } catch { reflectDs(S.hotSource); }

    // ===== 分组: TMDB 免梯子直连（实验）（从账号同步的 TMDB API Key 区迁出，独立放入「插件」标签页）=====
    const secTmdbDirect = section('TMDB 免梯子直连（实验）');
    secTmdbDirect.el.style.gridColumn = '1 / -1'; // 内容较多，占满整行
    const secBodyTmdbDirect = secTmdbDirect.body;
    secBodyTmdbDirect.appendChild(dcWrap);

    // ===== 分组: 豆瓣同步 =====
    const secDouban = section('豆瓣同步');
    secDouban.el.style.gridColumn = '1 / -1'; // 豆瓣同步内容多，占满整行
    const secBodyDouban = secDouban.body;

    const doubanStatus = document.createElement('div');
    doubanStatus.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-warn);margin-bottom:8px;';
    secBodyDouban.appendChild(doubanStatus);

    // 双栏布局：左=登录/账号，右=已观看同步（窄屏自动折叠为单栏）
    const doubanCols = document.createElement('div');
    doubanCols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:16px;margin-top:8px;';
    const colLogin = document.createElement('div');
    colLogin.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;';
    const colWatch = document.createElement('div');
    colWatch.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;padding-left:16px;border-left:1px solid var(--fnos-ui-border2);';
    doubanCols.appendChild(colLogin);
    doubanCols.appendChild(colWatch);
    secBodyDouban.appendChild(doubanCols);

    // 总开关
    const addDoubanToggle = (label: string): HTMLInputElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      colLogin.appendChild(row);
      return sw;
    };
    const swDouban = addDoubanToggle('启用豆瓣同步');
    swDouban.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-douban-enabled', swDouban.checked).catch((err) => log('set-douban-enabled failed', err));
    });

    // 登录按钮行
    const doubanBtns = document.createElement('div');
    doubanBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const scanDoubanBtn = mkBtn('扫码登录', true);
    const logoutDoubanBtn = mkBtn('退出登录', true);
    const manualBtn = mkBtn('保存 Cookie', true);
    doubanBtns.appendChild(scanDoubanBtn); doubanBtns.appendChild(logoutDoubanBtn); doubanBtns.appendChild(manualBtn);
    colLogin.appendChild(doubanBtns);

    scanDoubanBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      doubanStatus.textContent = '请在弹出的窗口中用豆瓣 App 扫码…';
      doubanStatus.style.color = 'var(--fnos-ui-sec)';
      try {
        const r: any = await ipcRenderer.invoke('douban:open-login');
        if (!r || !r.ok) doubanStatus.textContent = '打开登录窗口失败：' + ((r && r.msg) || '未知');
      } catch {
        doubanStatus.textContent = '打开登录窗口失败';
      }
    });
    logoutDoubanBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('douban:logout');
      refreshDouban();
    });

    // 手动粘贴 Cookie（兜底）
    const manualWrap = document.createElement('div');
    manualWrap.style.cssText = 'margin-top:8px;';
    const manualLabel = document.createElement('div');
    manualLabel.textContent = '手动粘贴 Cookie（豆瓣风控/扫码失效时用）';
    manualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    manualWrap.appendChild(manualLabel);
    const manualTa = document.createElement('input');
    manualTa.type = 'text';
    manualTa.placeholder = '粘贴浏览器里豆瓣的 Cookie 字符串（含 dbcl2 等）';
    manualTa.style.cssText = 'width:100%;height:32px;font-size:10.5px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    manualWrap.appendChild(manualTa);
    manualBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const r: any = await ipcRenderer.invoke('douban:manual-cookie', manualTa.value);
      if (r && r.ok) { manualTa.value = ''; refreshDouban(); }
      else doubanStatus.textContent = '保存失败：' + ((r && r.msg) || '未知');
    });
    colLogin.appendChild(manualWrap);

    // ===== 已观看列表 → 豆瓣"看过" 同步 =====
    const watchedWrap = document.createElement('div');
    watchedWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const watchedTitle = document.createElement('div');
    watchedTitle.textContent = '已观看列表 → 豆瓣「看过」';
    watchedTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--fnos-ui-text);margin-bottom:6px;';
    watchedWrap.appendChild(watchedTitle);

    const watchedStatus = document.createElement('div');
    watchedStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-bottom:6px;min-height:14px;line-height:1.5;';
    watchedStatus.textContent = '读取飞牛「已观看」列表，批量标记到豆瓣（已标记的会跳过，不重复打）。';
    watchedWrap.appendChild(watchedStatus);

    const syncBtn = mkBtn('立即同步已观看列表', true);
    syncBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        syncBtn.setAttribute('disabled', 'true');
        watchedStatus.textContent = '正在扫描飞牛「已观看」列表…（需加载列表页，约 10 秒）';
        watchedStatus.style.color = 'var(--fnos-ui-sec)';
        const r: any = await (window as any).fnosScanWatched();
        syncBtn.removeAttribute('disabled');
        if (r && r.error) {
            watchedStatus.textContent = '同步失败：' + (r.error === 'timeout' ? '扫描超时' : r.error === 'busy' ? '上一次扫描仍在进行' : r.error);
            watchedStatus.style.color = 'var(--fnos-ui-warn)';
        } else if (r) {
            const note = r.note ? '（' + r.note + '）' : '';
            watchedStatus.textContent = `完成：共 ${r.total} 部，标记看过 ${r.marked}，跳过 ${r.skipped}，失败 ${r.failed}${note}`;
            watchedStatus.style.color = r.marked > 0 ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-sub)';
        }
    });
    watchedWrap.appendChild(syncBtn);

    // 自动同步间隔
    const autoRow = document.createElement('div');
    autoRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const autoLabel = document.createElement('span');
    autoLabel.textContent = '自动同步间隔(分钟, 0=关闭):';
    autoLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-text);';
    const autoInput = document.createElement('input');
    autoInput.type = 'number';
    autoInput.min = '0';
    autoInput.step = '5';
    autoInput.style.cssText = 'width:64px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;padding:4px 6px;';
    const autoSave = mkBtn('保存', true);
    autoSave.style.fontSize = '11px';
    autoRow.appendChild(autoLabel); autoRow.appendChild(autoInput); autoRow.appendChild(autoSave);
    watchedWrap.appendChild(autoRow);
    autoSave.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        const v = Math.max(0, Math.floor(Number(autoInput.value) || 0));
        const r: any = await ipcRenderer.invoke('douban:set-watched-scan-interval', v).catch(() => ({ ok: false }));
        if (r && r.ok) {
            watchedStatus.textContent = v > 0 ? `已设置每 ${v} 分钟自动同步一次（下限 10 分钟）` : '已关闭自动同步';
            watchedStatus.style.color = 'var(--fnos-ui-ok)';
        }
    });
    // 打开面板时回填当前间隔
    ipcRenderer.invoke('douban:get-watched-scan-interval').then((r: any) => {
        if (r && typeof r.interval === 'number') autoInput.value = String(r.interval);
    }).catch(() => {});
    colWatch.appendChild(watchedWrap);

    /* 布局统一在末尾 layout 区追加 */

    // ===== 通用小工具：滑块行（标签 + range + 实时数值）=====
    const addSlider = (
      labelText: string, min: number, max: number, step: number, value: number,
      fmt: (v: number) => string, onInput: (v: number) => void
    ): { row: HTMLElement; input: HTMLInputElement; valEl: HTMLElement } => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:7px 6px;';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
      const span = document.createElement('span');
      span.textContent = labelText;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
      const valEl = document.createElement('span');
      valEl.textContent = fmt(value);
      valEl.style.cssText = 'color:var(--fnos-ui-sec);font-size:11px;font-variant-numeric:tabular-nums;';
      head.appendChild(span); head.appendChild(valEl);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(value);
      input.style.cssText = 'width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valEl.textContent = fmt(v);
        onInput(v);
      });
      row.appendChild(head); row.appendChild(input);
      return { row, input, valEl };
    };
    // 通用：多行文本框行
    const addTextarea = (labelText: string, value: string, placeholder: string, onInput: (v: string) => void): { row: HTMLElement; ta: HTMLTextAreaElement } => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:7px 6px;';
      const span = document.createElement('span');
      span.textContent = labelText;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.placeholder = placeholder;
      ta.rows = 4;
      ta.style.cssText = 'width:100%;resize:vertical;border-radius:8px;padding:7px 9px;font-size:11.5px;'
        + 'background:var(--fnos-ui-input-bg)!important;color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border3);'
        + 'font-family:inherit;line-height:1.5;';
      ta.addEventListener('input', () => onInput(ta.value));
      row.appendChild(span); row.appendChild(ta);
      return { row, ta };
    };

    // ===== [lc-1032] Trakt 同步（观影记录 → trakt.tv history，OAuth Device Flow）=====
    const secTrakt = section('Trakt 同步');
    secTrakt.el.id = 'sec-trakt';
    const traBody = secTrakt.body;
    const traHint = document.createElement('div');
    traHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:0 6px 6px;line-height:1.5;';
    traHint.textContent = '把观影记录（看完的电影 / 已看的剧集集数）同步到 trakt.tv 历史。需要在 Trakt 应用管理页(trakt.tv/oauth/applications)注册应用，把 Client ID 与 Secret 填到这里，再点「连接 Trakt」完成设备授权。';
    traBody.appendChild(traHint);

    // 凭证（掩码输入，交互同 Bangumi token / 弹弹play 凭证）
    const maskTra = (t: string): string => '*'.repeat(Math.max(0, t.length));
    let traRealId = '';
    let traRealSecret = '';
    const mkTraInput = (placeholder: string): HTMLInputElement => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
        + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
        + 'padding:6px 8px;box-sizing:border-box;margin-bottom:6px;';
      inp.addEventListener('focus', () => { if (inp.readOnly) { inp.readOnly = false; inp.value = ''; } });
      return inp;
    };
    const traIdInput = mkTraInput('Client ID（Trakt 应用设置页获取）');
    const traSecretInput = mkTraInput('Client Secret（与 ID 同页，勿外传）');
    const traBlurMask = (inp: HTMLInputElement, real: string): void => {
      if (inp.value.trim() === '' && real) { inp.value = maskTra(real); inp.readOnly = true; }
    };
    traIdInput.addEventListener('blur', () => traBlurMask(traIdInput, traRealId));
    traSecretInput.addEventListener('blur', () => traBlurMask(traSecretInput, traRealSecret));
    traBody.appendChild(traIdInput);
    traBody.appendChild(traSecretInput);

    const traBtnRow1 = document.createElement('div');
    traBtnRow1.style.cssText = 'display:flex;gap:6px;';
    const traSaveBtn = mkBtn('保存凭证', true);
    const traClearBtn = mkBtn('清除凭证', true);
    traBtnRow1.appendChild(traSaveBtn); traBtnRow1.appendChild(traClearBtn);
    traBody.appendChild(traBtnRow1);

    const traStatus = document.createElement('div');
    traStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;line-height:1.5;';
    traBody.appendChild(traStatus);

    const traRefreshStatus = async (): Promise<void> => {
      const st: any = await ipcRenderer.invoke('trakt:get-status').catch(() => null);
      if (st && st.connected) {
        const exp = st.expiresAt ? '，有效期至 ' + new Date(st.expiresAt).toLocaleDateString() : '';
        traStatus.textContent = '已连接 Trakt' + exp;
        traStatus.style.color = 'var(--fnos-ui-ok)';
      } else if (st && st.configured) {
        traStatus.textContent = '凭证已保存，尚未连接。';
        traStatus.style.color = 'var(--fnos-ui-sub)';
      } else {
        traStatus.textContent = '未配置。';
        traStatus.style.color = 'var(--fnos-ui-sub)';
      }
    };

    traSaveBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const id = traIdInput.value.trim();
      const sec = traSecretInput.value.trim();
      if (!id || !sec) {
        traStatus.textContent = 'Client ID 与 Secret 均必填（清除请用「清除凭证」）。';
        traStatus.style.color = 'var(--fnos-ui-warn)';
        return;
      }
      ipcRenderer.invoke('trakt:save-credentials', id, sec)
        .then((r: any) => {
          if (r && r.error) throw new Error(r.error);
          traRealId = id; traRealSecret = sec;
          traIdInput.value = maskTra(id); traIdInput.readOnly = true;
          traSecretInput.value = maskTra(sec); traSecretInput.readOnly = true;
          void traRefreshStatus();
        })
        .catch((err) => { traStatus.textContent = '保存失败: ' + (err && err.message ? err.message : err); traStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    traClearBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('trakt:clear-credentials').then(() => {
        traRealId = ''; traRealSecret = '';
        traIdInput.value = ''; traIdInput.readOnly = false;
        traSecretInput.value = ''; traSecretInput.readOnly = false;
        void traRefreshStatus();
      }).catch(() => {});
    });

    // 设备流授权（连接 Trakt）
    const traBtnRow2 = document.createElement('div');
    traBtnRow2.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const traConnectBtn = mkBtn('连接 Trakt', true);
    const traSyncBtn = mkBtn('立即同步观影记录', true);
    const traDiscBtn = mkBtn('断开连接', true);
    traBtnRow2.appendChild(traConnectBtn); traBtnRow2.appendChild(traSyncBtn); traBtnRow2.appendChild(traDiscBtn);
    traBody.appendChild(traBtnRow2);

    const traCodeBox = document.createElement('div');
    traCodeBox.style.cssText = 'display:none;margin-top:8px;padding:8px 10px;border-radius:8px;'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);font-size:11px;line-height:1.7;';
    traBody.appendChild(traCodeBox);

    const traSyncResult = document.createElement('div');
    traSyncResult.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;line-height:1.5;';
    traBody.appendChild(traSyncResult);

    // [lc-1064] 实时 scrobble 开关（播放中实时同步到 Trakt）
    const traScrobRow = document.createElement('div');
    traScrobRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 2px 0;margin-top:8px;';
    const traScrobLabelWrap = document.createElement('div');
    traScrobLabelWrap.style.cssText = 'min-width:0;';
    const traScrobLabel = document.createElement('div');
    traScrobLabel.style.cssText = 'font-size:12.5px;font-weight:600;color:var(--fnos-ui-text);';
    traScrobLabel.textContent = '实时同步播放（scrobble）';
    const traScrobSub = document.createElement('div');
    traScrobSub.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2,#5a6480);line-height:1.5;margin-top:2px;';
    traScrobSub.textContent = '播放时实时打点到 Trakt（开始/暂停/看完≥80% 自动记录），需先连接 Trakt。';
    traScrobLabelWrap.appendChild(traScrobLabel); traScrobLabelWrap.appendChild(traScrobSub);
    const traScrobBtn = mkBtn('…', true);
    traScrobRow.appendChild(traScrobLabelWrap); traScrobRow.appendChild(traScrobBtn);
    traBody.appendChild(traScrobRow);
    const paintScrob = (on: boolean): void => {
      traScrobBtn.textContent = on ? '已开启 ✓' : '已关闭';
      traScrobBtn.style.background = on ? 'var(--fnos-ui-exit-on)' : 'var(--fnos-ui-btn-bg2)';
      traScrobBtn.style.color = on ? '#fff' : 'var(--fnos-ui-btn-text)';
    };
    ipcRenderer.invoke('trakt:get-scrobble-enabled').then((r: any) => { paintScrob(!!(r && r.enabled)); }).catch(() => {});
    traScrobBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const cur = traScrobBtn.textContent || '';
      const next = cur.indexOf('已开启') === -1;
      ipcRenderer.invoke('trakt:set-scrobble-enabled', next).then((r: any) => {
        paintScrob(!!(r && r.enabled));
      }).catch(() => {});
    });

    traConnectBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      traStatus.textContent = '正在获取设备码…';
      traStatus.style.color = 'var(--fnos-ui-sub)';
      ipcRenderer.invoke('trakt:device-start').then((r: any) => {
        if (r && r.error) {
          traStatus.textContent = r.error;
          traStatus.style.color = 'var(--fnos-ui-warn)';
          return;
        }
        const url = String(r.verification_url || 'https://trakt.tv/activate');
        const code = String(r.user_code || '');
        traCodeBox.style.display = 'block';
        traCodeBox.innerHTML = '';
        const l1 = document.createElement('div');
        l1.textContent = '1. 打开授权页：';
        const link = document.createElement('a');
        link.href = url; link.textContent = url; link.style.color = 'var(--fnos-ui-accent)';
        link.addEventListener('click', (ev: Event) => { ev.preventDefault(); try { require('electron').shell.openExternal(url); } catch { /* ignore */ } });
        l1.appendChild(link);
        const l2 = document.createElement('div');
        l2.textContent = '2. 输入授权码：';
        const codeEl = document.createElement('span');
        codeEl.textContent = code;
        codeEl.style.cssText = 'font-size:15px;font-weight:700;letter-spacing:2px;color:var(--fnos-ui-text);user-select:all;cursor:pointer;margin-left:4px;';
        codeEl.title = '点击复制';
        codeEl.addEventListener('click', () => {
          try { navigator.clipboard.writeText(code); codeEl.title = '已复制'; } catch { /* ignore */ }
        });
        l2.appendChild(codeEl);
        const l3 = document.createElement('div');
        l3.textContent = '3. 授权后本窗口自动完成连接（等待中…）';
        traCodeBox.appendChild(l1); traCodeBox.appendChild(l2); traCodeBox.appendChild(l3);
        traStatus.textContent = '等待授权中…';
      }).catch((err) => { traStatus.textContent = '失败: ' + (err && err.message ? err.message : err); traStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    ipcRenderer.on('trakt:connected', () => {
      traCodeBox.style.display = 'none';
      traStatus.textContent = '已连接 Trakt ✓';
      traStatus.style.color = 'var(--fnos-ui-ok)';
      void traRefreshStatus();
    });
    ipcRenderer.on('trakt:device-error', (_e: any, msg: any) => {
      traCodeBox.style.display = 'none';
      traStatus.textContent = String(msg || '授权失败');
      traStatus.style.color = 'var(--fnos-ui-warn)';
    });
    traDiscBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('trakt:device-cancel').catch(() => {});
      ipcRenderer.invoke('trakt:disconnect').then(() => void traRefreshStatus()).catch(() => {});
    });
    traSyncBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      traSyncResult.textContent = '同步中…（扫描媒体库并写入 Trakt，可能需要一点时间）';
      ipcRenderer.invoke('trakt:sync-watched').then((r: any) => {
        if (r && r.error) {
          traSyncResult.textContent = '同步失败: ' + (r.error === 'busy' ? '上一次同步仍在进行' : r.error);
          traSyncResult.style.color = 'var(--fnos-ui-warn)';
          return;
        }
        traSyncResult.textContent = '同步完成：新增电影 ' + (r.addedMovies || 0) + ' 部 / 剧集集数 ' + (r.addedEpisodes || 0)
          + ' 条，未识别 ' + (r.notFound || 0) + (r.noIdMovies || r.noIdShows ? '（标题搜索未命中 ' + (r.noIdMovies || 0) + ' 部电影 / ' + (r.noIdShows || 0) + ' 部剧）' : '');
        traSyncResult.style.color = 'var(--fnos-ui-ok)';
      }).catch((err) => { traSyncResult.textContent = '同步失败: ' + (err && err.message ? err.message : err); traSyncResult.style.color = 'var(--fnos-ui-warn)'; });
    });
    // 回填凭证掩码与状态
    ipcRenderer.invoke('trakt:get-credentials').then((r: any) => {
      if (r && r.configured) {
        traRealId = r.clientId || ''; traRealSecret = r.clientSecret || '';
        traIdInput.value = maskTra(traRealId); traIdInput.readOnly = true;
        traSecretInput.value = maskTra(traRealSecret); traSecretInput.readOnly = true;
      }
      void traRefreshStatus();
    }).catch(() => {});

    // ===== 弹幕设置（写入 danmaku_block_types.json + 屏蔽词文件 + 弹幕文件夹管理）=====
    // [lc-215] 移除「弹幕样式」控制项（透明度/字号/描边/阴影/显示区域/同屏上限/粗体）——
    // 这些已由 MPV 底部控制栏的弹幕样式按钮管理；此处仅保留/新增「弹幕屏蔽」相关。
    // [lc-301] 标题由「B站弹幕屏蔽」改为「弹幕设置」，并新增「打开弹幕文件夹」入口。
    const secDanmaku = section('弹幕设置');
    secDanmaku.el.id = 'sec-danmaku'; // [lc-199] 供控制栏按钮唤起时滚动定位
    const danBody = secDanmaku.body;
    let _danTimer: any = null;

    // 屏蔽类型定义（key 必须与 bili_danmaku.py 的 danmaku_block_types.json 一致）
    const BLOCK_TYPES: { key: string; label: string }[] = [
      { key: 'top', label: '顶部弹幕' },
      { key: 'bottom', label: '底部弹幕' },
      { key: 'scroll', label: '滚动弹幕' },
      { key: 'reverse', label: '逆向弹幕' },
      { key: 'advanced', label: '高级弹幕' },
      { key: 'color', label: '彩色弹幕' }
    ];
    const blockToggles: { key: string; input: HTMLInputElement }[] = [];

    // 推送：仅传 屏蔽类型 + 屏蔽词（样式由 MPV 控制栏管理，不再经此通道）
    let danBlacklist: { row: HTMLElement; ta: HTMLTextAreaElement };
    function pushDan(): void {
      const blockTypes = blockToggles.filter((b) => b.input.checked).map((b) => b.key);
      const blacklist = danBlacklist ? danBlacklist.ta.value : '';
      const payload = { blockTypes, blacklist };
      if (_danTimer) clearTimeout(_danTimer);
      _danTimer = setTimeout(() => {
        ipcRenderer.invoke('settings:set-bili-danmaku-style', payload).catch((err) => log('set-bili-danmaku-style failed', err));
      }, 300);
    }

    for (const bt of BLOCK_TYPES) {
      const t = addToggle(bt.label);
      t.checked = false;
      t.addEventListener('change', pushDan);
      danBody.appendChild(t.parentElement as HTMLElement);
      blockToggles.push({ key: bt.key, input: t });
    }

    danBlacklist = addTextarea('屏蔽词（每行一条，支持正则）', '', '例如：\n广告\n关注.*', pushDan);
    danBody.appendChild(danBlacklist.row);

    const danHint = document.createElement('div');
    danHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:4px 6px 0;line-height:1.5;';
    danHint.textContent = '「弹幕样式」（透明度/字号/描边等）请在播放时通过 MPV 底部控制栏调整；本处仅管理 B站 弹幕的屏蔽。屏蔽类型于下一次 B站 弹幕加载时生效。';
    danBody.appendChild(danHint);

    // ===== [lc-1018] 弹弹play 自定义凭证（开放 API AppId + Secret）=====
    // 背景：脚本内置共享凭证已被弹弹play官方接口整体 403（2026-09-05 实测，搜索/弹幕恒"无数据"）。
    // 用户在弹弹play开放平台注册应用后把专属 AppId+Secret 填到这里 → 写入 script-opts/uosc_danmaku.conf
    // → dandanplay.lua 优先用自定义凭证签名；两项留空=回落内置共享凭证。mpv 每次播放新起进程 → 下次播放生效。
    const ddCredLabel = document.createElement('div');
    ddCredLabel.textContent = '弹弹play 凭证（开放 API AppId / Secret）';
    ddCredLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:12px 0 5px;';
    danBody.appendChild(ddCredLabel);

    const ddHint = document.createElement('div');
    ddHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:0 6px 6px;line-height:1.5;';
    ddHint.textContent = '内置共享凭证已被弹弹play官方接口封禁（弹幕恒「无数据」）。在弹弹play开放平台注册应用后，填入专属 AppId 与 Secret 即可恢复；两项都填才生效，清除后回落内置凭证。下次 MPV 播放时生效。';
    danBody.appendChild(ddHint);

    // 掩码输入（交互同 Bangumi token：已保存显示星号，聚焦自动清空进入编辑）
    const maskDd = (t: string): string => '*'.repeat(Math.max(0, t.length));
    let ddRealId = '';
    let ddRealSecret = '';
    const mkDdInput = (placeholder: string): HTMLInputElement => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
        + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
        + 'padding:6px 8px;box-sizing:border-box;margin-bottom:6px;';
      inp.addEventListener('focus', () => { if (inp.readOnly) { inp.readOnly = false; inp.value = ''; } });
      return inp;
    };
    const ddIdInput = mkDdInput('弹弹play AppId（如 gz2wnihj9d 形式的专属 id）');
    const ddSecretInput = mkDdInput('弹弹play Secret（注册应用后获得，勿外传）');
    const ddBlurMask = (inp: HTMLInputElement, real: string): void => {
      if (inp.value.trim() === '' && real) { inp.value = maskDd(real); inp.readOnly = true; }
    };
    ddIdInput.addEventListener('blur', () => ddBlurMask(ddIdInput, ddRealId));
    ddSecretInput.addEventListener('blur', () => ddBlurMask(ddSecretInput, ddRealSecret));
    danBody.appendChild(ddIdInput);
    danBody.appendChild(ddSecretInput);

    const ddBtns = document.createElement('div');
    ddBtns.style.cssText = 'display:flex;gap:6px;';
    const ddSaveBtn = mkBtn('保存凭证', true);
    const ddClearBtn = mkBtn('清除凭证', true);
    ddBtns.appendChild(ddSaveBtn); ddBtns.appendChild(ddClearBtn);
    danBody.appendChild(ddBtns);

    const ddStatus = document.createElement('div');
    ddStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    danBody.appendChild(ddStatus);

    ddSaveBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const id = ddIdInput.value.trim();
      const secret = ddSecretInput.value.trim();
      if (!id || !secret) {
        ddStatus.textContent = 'AppId 与 Secret 两项都必填（清除请用「清除凭证」）。';
        ddStatus.style.color = 'var(--fnos-ui-warn)';
        return;
      }
      ipcRenderer.invoke('settings:set-dandanplay-credentials', { appId: id, appSecret: secret })
        .then(() => {
          ddRealId = id; ddRealSecret = secret;
          ddIdInput.value = maskDd(id); ddIdInput.readOnly = true;
          ddSecretInput.value = maskDd(secret); ddSecretInput.readOnly = true;
          ddStatus.textContent = '已保存，下次 MPV 播放时生效。';
          ddStatus.style.color = 'var(--fnos-ui-sub)';
        })
        .catch((err) => { ddStatus.textContent = '保存失败: ' + (err && err.message ? err.message : err); ddStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    ddClearBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:set-dandanplay-credentials', { appId: '', appSecret: '' })
        .then(() => {
          ddRealId = ''; ddRealSecret = '';
          ddIdInput.value = ''; ddIdInput.readOnly = false;
          ddSecretInput.value = ''; ddSecretInput.readOnly = false;
          ddStatus.textContent = '已清除，回落脚本内置共享凭证，下次 MPV 播放时生效。';
        })
        .catch((err) => { ddStatus.textContent = '清除失败: ' + (err && err.message ? err.message : err); ddStatus.style.color = 'var(--fnos-ui-warn)'; });
    });

    // 打开已下载弹幕文件夹（方便用户管理/删除；目录与 MPV 弹幕落盘、Node 端弹幕缓存一致：%PUBLIC%\fnos-danmaku）
    const biliFolderBtn = mkBtn('打开弹幕文件夹', true);
    biliFolderBtn.style.marginTop = '10px';
    danBody.appendChild(biliFolderBtn);
    biliFolderBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('bili:open-danmaku-folder').catch((err) => log('bili:open-danmaku-folder failed', err));
    });

    // ===== 插帧（AI 补帧）=====
    // [lc-486] MPV 播放器插帧：uosc 控制栏有「插帧」按钮实时切换；此处提供应用侧默认配置
    // （默认开启 + 引擎选择 + 引擎路径），写入 script-opts/fntv_interp.conf 供 fntv_interp.lua 读取。
    const secInterp = section('插帧（AI 补帧）');
    const interpBody = secInterp.body;

    const interpEnabledToggle = addToggle('默认开启插帧（启动即生效）');
    interpBody.appendChild(interpEnabledToggle.parentElement as HTMLElement);

    const engineLabel = document.createElement('div');
    engineLabel.textContent = '插帧引擎';
    engineLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    interpBody.appendChild(engineLabel);

    const engineSel = document.createElement('select');
    engineSel.id = 'fntv-interp-engine';
    engineSel.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;cursor:pointer;';
    ([
      ['auto', '自动（SVP → RIFE → 内置平滑运动）'],
      ['builtin', 'MPV 内置平滑运动（无需额外引擎）'],
      ['svp', 'SVP（需本机安装并运行 SmoothVideo Project）'],
      ['rife', 'RIFE AI 补帧（需 rife-ncnn-vulkan 等运行时）'],
      ['nvidia', 'N 卡 Smooth Motion（RTX50 驱动级，需在 NVIDIA App 开启）']
    ] as [string, string][]).forEach(([k, label]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = label;
      engineSel.appendChild(o);
    });
    interpBody.appendChild(engineSel);

    const pathLabel = document.createElement('div');
    pathLabel.textContent = '引擎路径（SVP 目录 / RIFE 可执行文件，留空=自动探测）';
    pathLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    interpBody.appendChild(pathLabel);

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = '例如：C:\\Program Files (x86)\\SVP 4';
    pathInput.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;';
    interpBody.appendChild(pathInput);

    const interpHint = document.createElement('div');
    interpHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:8px 0 0;line-height:1.5;';
    interpHint.textContent = '播放时可在 MPV 底部控制栏点「插帧」按钮实时开关。选 SVP/RIFE 需本机已安装对应引擎并配好，未安装时自动回退 MPV 内置平滑运动；选 N 卡需 RTX50+ 并在 NVIDIA App 开启「Smooth Motion（视频）」。';
    interpBody.appendChild(interpHint);

    // ===== [lc-1069] 渲染画质（MPV 渲染预设三档）=====
    //   写入 mpv-user.conf 托管块；vo 变更需 MPV 进程重启生效 → 面板明示。
    const secRender = section('渲染画质');
    const renderBody = secRender.body;

    const renderLabel = document.createElement('div');
    renderLabel.textContent = '渲染预设';
    renderLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:4px 0 6px;';
    renderBody.appendChild(renderLabel);

    const renderSeg = document.createElement('div');
    renderSeg.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    const renderBtns: Record<string, HTMLButtonElement> = {};
    const RENDER_PRESETS: [string, string, string][] = [
      ['perf', '性能优先', '低配机/核显 流畅优先（双线性缩放，关闭去噪带）'],
      ['balanced', '均衡', '默认推荐（spline36 缩放 + 去噪带）'],
      ['quality', '高画质', 'gpu-next + EWA Lanczos 锐利缩放 + 峰值检测 HDR 映射'],
    ];
    const paintRender = (cur: string): void => {
      for (const k of Object.keys(renderBtns)) {
        const on = k === cur;
        renderBtns[k].style.background = on ? 'var(--fnos-ui-exit-on)' : 'var(--fnos-ui-btn-bg2)';
        renderBtns[k].style.color = on ? '#fff' : 'var(--fnos-ui-btn-text)';
        renderBtns[k].style.borderColor = on ? 'transparent' : 'var(--fnos-ui-border)';
      }
    };
    for (const [k, label] of RENDER_PRESETS.map(([k, l]) => [k, l] as [string, string])) {
      const b = document.createElement('button');
      b.style.cssText = 'flex:1;padding:8px 0;border:1px solid var(--fnos-ui-border);border-radius:9px;cursor:pointer;'
        + 'font-size:12px;font-weight:600;font-family:inherit;transition:all .15s ease;';
      b.textContent = label;
      renderBtns[k] = b;
      renderSeg.appendChild(b);
    }
    renderBody.appendChild(renderSeg);

    const renderDesc = document.createElement('div');
    renderDesc.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:6px 0 0;line-height:1.5;min-height:30px;';
    renderBody.appendChild(renderDesc);

    const renderHint = document.createElement('div');
    renderHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);padding:6px 0 0;line-height:1.5;';
    renderHint.textContent = '渲染管线(vo)变更需重启应用后生效；画质档位亦可被「着色器/ICC」设置叠加。';
    renderBody.appendChild(renderHint);

    const DESCS: Record<string, string> = {};
    for (const [k, , desc] of RENDER_PRESETS) DESCS[k] = desc;

    const applyRender = (preset: string): void => {
      paintRender(preset);
      renderDesc.textContent = DESCS[preset] || '';
      ipcRenderer.invoke('mpv:set-render-preset', { preset }).then((r: any) => {
        if (r && r.ok) renderDesc.textContent = (DESCS[preset] || '') + '（已保存，重启应用后对渲染管线生效）';
      }).catch(() => {});
    };
    for (const k of Object.keys(renderBtns)) {
      renderBtns[k].addEventListener('click', (e: Event) => { e.stopPropagation(); applyRender(k); });
    }
    // 初始回填
    ipcRenderer.invoke('mpv:get-render-preset').then((r: any) => {
      const cur = (r && r.preset) || 'balanced';
      paintRender(cur);
      const p = RENDER_PRESETS.find((x) => x[0] === cur);
      renderDesc.textContent = p ? p[2] : '';
    }).catch(() => {});

    secRender.el.id = 'sec-render';
    // 移交: 插帧卡在游离容器挂的行自行搬回 —— 渲染卡直接占位, 由下方 cats 归属播放分类

    let _interpTimer: any = null;
    const pushInterp = (): void => {
      const payload = { enabled: interpEnabledToggle.checked, engine: engineSel.value, path: pathInput.value.trim() };
      if (_interpTimer) clearTimeout(_interpTimer);
      _interpTimer = setTimeout(() => {
        ipcRenderer.invoke('settings:set-interp', payload).catch((err) => log('set-interp failed', err));
      }, 300);
    };
    interpEnabledToggle.addEventListener('change', pushInterp);
    engineSel.addEventListener('change', pushInterp);
    pathInput.addEventListener('input', pushInterp);

    ipcRenderer.invoke('settings:get-interp').then((r: any) => {
      if (!r) return;
      interpEnabledToggle.checked = !!r.enabled;
      engineSel.value = r.engine || 'auto';
      pathInput.value = r.path || '';
    }).catch((err) => log('get-interp failed', err));
    /* 布局统一在末尾 layout 区追加 */

    // ===== 诊断信息（汇总运行态，减少"查日志"往返）=====
    const secDiag = section('诊断信息');
    const diagBody = secDiag.body;
    const diagPre = document.createElement('pre');
    diagPre.style.cssText = 'margin:0;padding:10px;background:rgba(0,0,0,.18);border-radius:8px;font-size:10.5px;'
      + 'line-height:1.55;color:var(--fnos-ui-text);white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;';
    diagPre.textContent = '点击「刷新」加载诊断信息…';
    const diagBtns = document.createElement('div');
    diagBtns.style.cssText = 'display:flex;gap:6px;padding:8px 0 0;';
    const diagRefresh = mkBtn('刷新', true);
    const diagCopy = mkBtn('复制', true);
    diagBtns.appendChild(diagRefresh); diagBtns.appendChild(diagCopy);
    const loadDiag = async (): Promise<void> => {
      try {
        const r: any = await ipcRenderer.invoke('settings:diagnostics');
        if (!r || !r.ok) { diagPre.textContent = '诊断失败：' + ((r && r.error) || '未知'); return; }
        const lines: string[] = [];
        lines.push('== 基本信息 ==');
        lines.push(`版本: ${r.version}${r.isPackaged ? ' (打包版)' : ' (dev)'}`);
        lines.push(`App 路径: ${r.appPath}`);
        lines.push('');
        lines.push('== 登录与 NAS ==');
        lines.push(`NAS 地址: ${r.domain}`);
        lines.push(`账号: ${r.account}  登录方式: ${r.loginType}  Token: ${r.hasToken ? '已保存' : '无'}`);
        lines.push(`豆瓣同步: ${r.doubanEnabled ? '开' : '关'}${r.doubanLoggedIn ? '(已登录)' : ''}   Bangumi: ${r.bangumiEnabled ? '开' : '关'}${r.bangumiHasToken ? '(有Token)' : ''}`);
        lines.push('');
        lines.push('== 播放器 ==');
        lines.push(`默认播放器: ${r.defaultPlayer}`);
        lines.push(`MPV 路径: ${r.mpvPath}   PotPlayer 路径: ${r.potPath}`);
        lines.push(`MPV 配置目录: ${r.mpvConfigDir}`);
        lines.push('');
        lines.push('== MPV 渲染 ==');
        lines.push(`默认着色器: ${r.mpvShader || 'off'}   ICC 校色: ${r.mpvIcc ? '开' : '关'}`);
        lines.push('');
        lines.push('--- mpv-user.conf ---');
        lines.push(r.mpvUserConf || '(空)');
        lines.push('');
        lines.push('== B站弹幕 ==');
        lines.push(`搜索: ${r.biliSearchEnabled ? '开' : '关'}  聚合阈值: ${r.biliAggregateThreshold}`);
        const bt = Array.isArray(r.danmakuBlockTypes) ? r.danmakuBlockTypes : [];
        lines.push(`屏蔽类型: ${bt.length ? bt.join(', ') : '(无)'}`);
        lines.push(`屏蔽词: ${r.danmakuBlacklist ? r.danmakuBlacklist : '(无)'}`);
        lines.push('');
        lines.push('--- uosc_danmaku.conf ---');
        lines.push(r.danmakuConf || '(空)');
        lines.push('');
        lines.push('== 界面 / 其它 ==');
        lines.push(`滚轮横滚: ${r.wheelHScroll ? '开' : '关'}   详情页无盒: ${r.detailBoxless ? '是' : '否'}`);
        lines.push(`登录背景: ${r.loginBgPath}`);
        lines.push(`更新打烊时间戳: ${r.updateDismissedAt ? String(r.updateDismissedAt) : '(无)'}`);
        diagPre.textContent = lines.join('\n');
      } catch (err) {
        diagPre.textContent = '诊断加载异常：' + String(err);
      }
    };
    diagRefresh.addEventListener('click', (e: Event) => { e.stopPropagation(); loadDiag(); });
    diagCopy.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const text = diagPre.textContent || '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    });
    diagBody.appendChild(diagPre);
    diagBody.appendChild(diagBtns);
    /* 布局统一在末尾 layout 区追加 */

    // ===== 调试日志（独立卡片, 置于「诊断信息」下方; 从「退出行为」卡片迁出）=====
    // 小标题：纯文字，无背景/边框
    const dbgLabel = document.createElement('div');
    dbgLabel.style.cssText = 'color:var(--fnos-ui-sec);font-size:10px;margin:0 0 8px;'
      + 'font-weight:700;text-transform:uppercase;letter-spacing:1.2px;';
    dbgLabel.textContent = '调试日志';
    secDebugBody.appendChild(dbgLabel);

    // 调试开关动态挂载目标：主开关直接进卡片，组件开关进折叠区
    let debugTarget: HTMLElement = secDebugBody;

    const addDebugToggle = (label: string): HTMLInputElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      debugTarget.appendChild(row);
      return sw;
    };

    // ===== 主开关（始终可见，置于顶部）=====
    debugTarget = secDebugBody;
    const swDebug = addDebugToggle('启用调试日志（详细模式）');
    swDebug.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-debug-enabled', swDebug.checked).catch((err) => log('set-debug-enabled failed', err));
    });

    // ===== 组件日志（默认折叠，置于主开关下方）=====
    const dbgFold = document.createElement('div');
    dbgFold.style.cssText = 'margin-top:4px;';
    const dbgFoldHeader = document.createElement('div');
    dbgFoldHeader.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--fnos-ui-muted);'
      + 'font-size:11.5px;padding:4px 6px;border-radius:6px;user-select:none;transition:background .12s;';
    dbgFoldHeader.onmouseenter = () => { dbgFoldHeader.style.background = 'var(--fnos-ui-row-hover)'; };
    dbgFoldHeader.onmouseleave = () => { dbgFoldHeader.style.background = 'transparent'; };
    const dbgCaret = document.createElement('span');
    dbgCaret.textContent = '▸';
    dbgCaret.style.cssText = 'display:inline-block;transition:transform .12s;font-size:10px;';
    const dbgFoldTitle = document.createElement('span');
    dbgFoldTitle.textContent = '组件日志（按组件单独控制）';
    dbgFoldHeader.appendChild(dbgCaret); dbgFoldHeader.appendChild(dbgFoldTitle);

    const dbgFoldBody = document.createElement('div');
    dbgFoldBody.style.cssText = 'display:none;'; // 默认折叠
    dbgFoldHeader.addEventListener('click', () => {
      const collapsed = dbgFoldBody.style.display === 'none';
      dbgFoldBody.style.display = collapsed ? 'block' : 'none';
      dbgCaret.style.transform = collapsed ? 'rotate(90deg)' : 'rotate(0deg)';
    });

    const debugHint = document.createElement('div');
    debugHint.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin:6px 0 8px;line-height:1.5;';
    debugHint.textContent = '关闭时控制台仅显示 警告/错误；开启后可单独控制各组件是否输出详细日志(INFO/DEBUG)。';
    dbgFoldBody.appendChild(debugHint);

    // 组件开关进折叠区
    debugTarget = dbgFoldBody;
    const debugComps: [string, string][] = [
      ['douban', '豆瓣同步'],
      ['danmaku', 'B站弹幕'],
      ['mpv', 'MPV 播放器'],
      ['potplayer', 'PotPlayer'],
      ['media', '播放器/媒体'],
      ['embywall', 'EmbyWall 墙']
    ];
    const swDebugComps: Record<string, HTMLInputElement> = {};
    debugComps.forEach(([key, label]) => {
      const sw = addDebugToggle(label);
      swDebugComps[key] = sw;
      sw.addEventListener('change', () => {
        const cur: Record<string, boolean> = {};
        debugComps.forEach(([k]) => { cur[k] = !!swDebugComps[k].checked; });
        ipcRenderer.invoke('settings:set-debug-components', cur).catch((err) => log('set-debug-components failed', err));
      });
    });
    dbgFold.appendChild(dbgFoldHeader);
    dbgFold.appendChild(dbgFoldBody);
    secDebugBody.appendChild(dbgFold);

    // 日志状态文字放在 body 内，避免占用 footer 高度导致左右 footer 不齐
    const logStatus = document.createElement('div');
    logStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secDebugBody.appendChild(logStatus);

    // ===== 底部操作栏：日志文件（独立 footer，与左侧检查更新按钮对齐）=====
    const logFooter = document.createElement('div');
    logFooter.style.cssText = 'padding:10px 12px;flex-shrink:0;';
    const logDivider = document.createElement('div');
    logDivider.style.cssText = 'height:1px;background:var(--fnos-ui-border);margin:0 0 8px;';
    logFooter.appendChild(logDivider);
    const logRow = document.createElement('div');
    logRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    const openLogBtn = mkBtn('日志文件', true);
    const openErrLogBtn = mkBtn('报错日志', true);
    const exportLogBtn = mkBtn('导出日志文件', true);
    const openMpvLogBtn = mkBtn('MPV 播放器日志', true);
    logRow.appendChild(openLogBtn);
    logRow.appendChild(openErrLogBtn);
    logRow.appendChild(exportLogBtn);
    logRow.appendChild(openMpvLogBtn);
    logFooter.appendChild(logRow);
    secDebug.el.appendChild(logFooter);

    openLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = '日志文件打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    openErrLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-error-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = '报错日志打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    exportLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:export-log').then((r: any) => {
        if (r && r.ok) {
          logStatus.textContent = '已导出日志：' + (r.savedPath || '');
        } else if (r && r.error && r.error !== '已取消') {
          logStatus.textContent = '导出失败：' + (r.error || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    openMpvLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-mpv-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = 'MPV 日志打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });

    // ===== 插件面板：跳过片头片尾（smart_skip 插件，控制面从 MPV 菜单抽到此处）=====
    const secSkip = section('跳过片头片尾');
    secSkip.el.id = 'sec-skip';
    const skipBody = secSkip.body;
    const skipDesc = document.createElement('div');
    skipDesc.textContent = '自动加载飞牛/影片库跳过数据；可在播放时显示「跳过片头/片尾」按钮，或开启后自动跳过。';
    skipDesc.style.cssText = 'color:#9aa0a6;font-size:12px;line-height:1.5;margin-bottom:6px;';
    skipBody.appendChild(skipDesc);
    const skipRow = document.createElement('div');
    skipRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    skipRow.onmouseenter = () => { skipRow.style.background = 'var(--fnos-ui-row-hover)'; };
    skipRow.onmouseleave = () => { skipRow.style.background = 'transparent'; };
    const skipLabel = document.createElement('span');
    skipLabel.textContent = '自动跳过片头片尾';
    skipLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swSkip = document.createElement('input');
    swSkip.type = 'checkbox';
    swSkip.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    skipRow.appendChild(skipLabel); skipRow.appendChild(swSkip);
    skipBody.appendChild(skipRow);
    swSkip.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-smart-skip-enabled', swSkip.checked).catch((err) => log('set-smart-skip-enabled failed', err));
    });
    // 读取初始值（默认关闭）
    ipcRenderer.invoke('settings:get-smart-skip-enabled').then((v: boolean) => { swSkip.checked = !!v; }).catch(() => { swSkip.checked = false; });

    // ===== 分组: 手柄设置（独立标签页；自定义手柄按键映射）=====
    const secGamepad = section('手柄设置');
    const secBodyGamepad = secGamepad.body;
    secBodyGamepad.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const gpDesc = document.createElement('div');
    gpDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    gpDesc.textContent = '支持使用手柄（Xbox/PS/通用）遥控：播放中控制播放器（播放暂停/快退快进/倍速/下一集），未播放时在影视界面导航（方向键/确认/返回）。可自定义各功能对应的按键。';
    secBodyGamepad.appendChild(gpDesc);

    // [lc-680] 手柄连接状态：检测按钮 + 实时状态
    const gpConnRow = document.createElement('div');
    gpConnRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:7px 8px;border-radius:8px;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);';
    const gpConnDot = document.createElement('span');
    gpConnDot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:var(--fnos-ui-warn);flex-shrink:0;';
    const gpConnText = document.createElement('span');
    gpConnText.style.cssText = 'font-size:11px;color:var(--fnos-ui-text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    gpConnText.textContent = '未检测到手柄（先按一下手柄任意键激活）';
    const gpDetectBtn = mkBtn('检测', true);
    gpDetectBtn.style.cssText = (gpDetectBtn.style.cssText || '') + ';flex-shrink:0;';
    gpConnRow.appendChild(gpConnDot); gpConnRow.appendChild(gpConnText); gpConnRow.appendChild(gpDetectBtn);
    secBodyGamepad.appendChild(gpConnRow);

    const gpUpdateConn = (): void => {
      try {
        const gpApi2 = (window as any).fntvGamepad;
        const r = gpApi2 && gpApi2.detectGamepad ? gpApi2.detectGamepad() : null;
        if (r && r.connected) {
          gpConnDot.style.background = 'var(--fnos-ui-ok)';
          gpConnText.textContent = '已连接：' + String(r.id || '手柄').slice(0, 60);
        } else {
          gpConnDot.style.background = 'var(--fnos-ui-warn)';
          gpConnText.textContent = '未检测到手柄（先按一下手柄任意键激活）';
        }
      } catch { /* ignore */ }
    };
    gpDetectBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); gpUpdateConn(); });
    gpUpdateConn();

    // 总开关
    const gpToggleRow = document.createElement('label');
    gpToggleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;margin-bottom:8px;';
    const gpToggleSpan = document.createElement('span');
    gpToggleSpan.textContent = '启用手柄控制';
    gpToggleSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const gpToggle = document.createElement('input');
    gpToggle.type = 'checkbox';
    gpToggle.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    gpToggleRow.appendChild(gpToggleSpan); gpToggleRow.appendChild(gpToggle);
    secBodyGamepad.appendChild(gpToggleRow);

    // [lc-680] 方向键固定说明（十字键/摇杆不可改映射）
    const gpDirNote = document.createElement('div');
    gpDirNote.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);line-height:1.6;margin:2px 6px 6px;padding:6px 8px;'
      + 'border-left:3px solid var(--fnos-ui-accent);background:var(--fnos-ui-input-bg)!important;border-radius:4px;';
    gpDirNote.innerHTML = '固定控制：<b style="color:var(--fnos-ui-text)">十字键 / 左摇杆</b> = 界面方向移动（播放中左右 = 快退/快进 5s），<b style="color:var(--fnos-ui-text)">A</b> = 确认/播放暂停，<b style="color:var(--fnos-ui-text)">B</b> = 返回。以下按键映射可自定义：';
    secBodyGamepad.appendChild(gpDirNote);

    // 功能 → 按键 选择行容器
    const gpRows: { id: string; select: HTMLSelectElement }[] = [];

    // 可选手柄按键列表（标准布局）
    const gpBtnOptions: { value: string; label: string }[] = [
        { value: 'A', label: 'A' },
        { value: 'B', label: 'B' },
        { value: 'X', label: 'X' },
        { value: 'Y', label: 'Y' },
        { value: 'LB', label: 'LB（左肩键）' },
        { value: 'RB', label: 'RB（右肩键）' },
        { value: 'LT', label: 'LT（左扳机）' },
        { value: 'RT', label: 'RT（右扳机）' },
        { value: 'START', label: 'Start' },
        { value: 'BACK', label: 'Back / Select' },
    ];

    // 构建一个功能映射行
    const gpBuildRow = (label: string, funcId: string, select: HTMLSelectElement, defaultBtn?: string): void => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:7px 6px;border-radius:6px;';
        const span = document.createElement('span');
        // [lc-680] 显示默认值提示
        span.textContent = defaultBtn ? label + `（默认 ${defaultBtn}）` : label;
        span.style.cssText = 'color:var(--fnos-ui-text);font-size:12.5px;';
        select.style.cssText = 'width:150px;height:28px;font-size:11.5px;color:var(--fnos-ui-text);'
            + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;padding:2px 6px;box-sizing:border-box;';
        row.appendChild(span); row.appendChild(select);
        secBodyGamepad.appendChild(row);
        gpRows.push({ id: funcId, select });
    };

    // 播放控制组
    const gpPlayTitle = document.createElement('div');
    gpPlayTitle.style.cssText = 'font-size:11px;font-weight:700;color:var(--fnos-ui-accent);margin:10px 0 4px;';
    gpPlayTitle.textContent = '播放控制（播放中生效）';
    secBodyGamepad.appendChild(gpPlayTitle);

    const gpSelect = (): HTMLSelectElement => {
        const s = document.createElement('select');
        for (const o of gpBtnOptions) {
            const op = document.createElement('option');
            op.value = o.value; op.textContent = o.label;
            s.appendChild(op);
        }
        return s;
    };

    // 播放控制：播放暂停 / 快退 / 快进 / 倍速- / 倍速+ / 下一集
    const gpPlayPauseSel = gpSelect(); gpBuildRow('播放 / 暂停', 'playPause', gpPlayPauseSel, 'A');
    const gpSeekBackSel = gpSelect(); gpBuildRow('快退 (5s)', 'seekBack', gpSeekBackSel, 'LB');
    const gpSeekFwdSel = gpSelect(); gpBuildRow('快进 (5s)', 'seekFwd', gpSeekFwdSel, 'RB');
    const gpSpeedDownSel = gpSelect(); gpBuildRow('倍速 -', 'speedDown', gpSpeedDownSel, 'LT');
    const gpSpeedUpSel = gpSelect(); gpBuildRow('倍速 +', 'speedUp', gpSpeedUpSel, 'RT');
    const gpNextSel = gpSelect(); gpBuildRow('下一集', 'next', gpNextSel, 'Y');

    // 界面导航组
    const gpNavTitle = document.createElement('div');
    gpNavTitle.style.cssText = 'font-size:11px;font-weight:700;color:var(--fnos-ui-accent);margin:10px 0 4px;';
    gpNavTitle.textContent = '界面导航（未播放时生效）';
    secBodyGamepad.appendChild(gpNavTitle);

    const gpBackSel = gpSelect(); gpBuildRow('返回 / 关闭', 'navBack', gpBackSel, 'B');
    const gpSelectSel = gpSelect(); gpBuildRow('勾选 / 开关', 'navSelect', gpSelectSel, 'X');

    // [lc-680] 高级设置（摇杆灵敏度 / 连跳节奏，可折叠）
    const gpAdvParams: { key: string; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
        { key: 'stickDeadzone', label: '摇杆死区（归零阈值）', min: 0.10, max: 0.50, step: 0.05, fmt: (v) => v.toFixed(2) },
        { key: 'directionThreshold', label: '方向触发阈值', min: 0.20, max: 0.80, step: 0.05, fmt: (v) => v.toFixed(2) },
        { key: 'repeatDelay', label: '长按连跳延迟 (ms)', min: 100, max: 800, step: 20, fmt: (v) => String(Math.round(v)) },
        { key: 'repeatInterval', label: '连跳间隔 (ms)', min: 50, max: 400, step: 10, fmt: (v) => String(Math.round(v)) },
    ];
    const gpAdvTitle = document.createElement('div');
    gpAdvTitle.style.cssText = 'font-size:11px;font-weight:700;color:var(--fnos-ui-accent);margin:10px 0 4px;cursor:pointer;user-select:none;';
    gpAdvTitle.textContent = '▶ 高级设置（灵敏度 / 连跳）';
    const gpAdvBody = document.createElement('div');
    gpAdvBody.style.cssText = 'display:none;';
    gpAdvTitle.addEventListener('click', () => {
        const show = gpAdvBody.style.display !== 'block';
        gpAdvBody.style.display = show ? 'block' : 'none';
        gpAdvTitle.textContent = (show ? '▼' : '▶') + ' 高级设置（灵敏度 / 连跳）';
    });
    secBodyGamepad.appendChild(gpAdvTitle);
    secBodyGamepad.appendChild(gpAdvBody);
    const gpAdvRanges: Record<string, HTMLInputElement> = {};
    const gpAdvVals: Record<string, HTMLSpanElement> = {};
    for (const it of gpAdvParams) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 6px;';
        const span = document.createElement('span');
        span.textContent = it.label;
        span.style.cssText = 'color:var(--fnos-ui-text);font-size:11.5px;flex:1;min-width:0;';
        const val = document.createElement('span');
        val.style.cssText = 'color:var(--fnos-ui-sec);font-size:11px;min-width:36px;text-align:right;';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(it.min); range.max = String(it.max); range.step = String(it.step);
        range.style.cssText = 'width:110px;accent-color:var(--fnos-ui-accent);';
        range.addEventListener('input', () => { val.textContent = it.fmt(parseFloat(range.value)); });
        row.appendChild(span); row.appendChild(range); row.appendChild(val);
        gpAdvBody.appendChild(row);
        gpAdvRanges[it.key] = range; gpAdvVals[it.key] = val;
    }
    const gpAdvHint = document.createElement('div');
    gpAdvHint.style.cssText = 'font-size:10px;color:var(--fnos-ui-sub);margin:2px 6px 0;line-height:1.5;';
    gpAdvHint.textContent = '死区越大摇杆需推越大力才响应；方向阈值同理。长按延迟/连跳间隔控制白框连续移动节奏（仅焦点导航时）。保存后立即生效。';
    gpAdvBody.appendChild(gpAdvHint);

    // 按钮行
    const gpBtns = document.createElement('div');
    gpBtns.style.cssText = 'display:flex;gap:6px;margin-top:12px;';
    const gpSaveBtn = mkBtn('保存', true);
    const gpResetBtn = mkBtn('恢复默认', true);
    gpBtns.appendChild(gpSaveBtn); gpBtns.appendChild(gpResetBtn);
    secBodyGamepad.appendChild(gpBtns);

    const gpStatus = document.createElement('div');
    gpStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyGamepad.appendChild(gpStatus);

    // 读取当前配置并回填下拉
    const gpApplyConfig = (cfg: any): void => {
        if (!cfg) return;
        gpToggle.checked = !!cfg.enabled;
        const bind = (cfg.bindings || {}) as Record<string, string>;
        for (const r of gpRows) {
            const val = bind[r.id] || '';
            // 默认值回退由 gamepad 侧处理；下拉只回填已保存值
            if (gpBtnOptions.some(o => o.value === val)) r.select.value = val;
            else r.select.selectedIndex = 0;
        }
        // [lc-680] 高级参数回填滑块
        for (const it of gpAdvParams) {
            const v = (cfg as any)[it.key];
            const def = gpApi && gpApi.advDefaults ? (gpApi.advDefaults as any)[it.key] : undefined;
            const val = typeof v === 'number' && Number.isFinite(v) ? v : (typeof def === 'number' ? def : (it.min + it.max) / 2);
            const clamped = Math.min(it.max, Math.max(it.min, val));
            gpAdvRanges[it.key].value = String(clamped);
            gpAdvVals[it.key].textContent = it.fmt(clamped);
        }
    };
    (window as any).fntvGamepad = (window as any).fntvGamepad || {};
    const gpApi = (window as any).fntvGamepad;
    if (gpApi && gpApi.getConfig) gpApplyConfig(gpApi.getConfig());

    gpSaveBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        try {
            const cfg = gpApi && gpApi.getConfig ? gpApi.getConfig() : { enabled: true, bindings: {} };
            const bindings: Record<string, string> = { ...(cfg.bindings || {}) };
            for (const r of gpRows) bindings[r.id] = r.select.value;
            // [lc-680] 按键冲突检测：同一按键绑定多个功能时告警并中止保存
            const byBtn: Record<string, string[]> = {};
            for (const [id, btn] of Object.entries(bindings)) {
                (byBtn[btn] = byBtn[btn] || []).push(id);
            }
            const conflicts = Object.entries(byBtn).filter(([, ids]) => ids.length > 1);
            if (conflicts.length) {
                const names = (window as any).fntvGamepad && (window as any).fntvGamepad.funcs
                    ? (window as any).fntvGamepad.funcs
                    : [];
                const desc = conflicts.map(([btn, ids]) => {
                    const labels = ids.map(id => (names.find((f: any) => f.id === id) || {}).label || id);
                    return `【${btn}】${labels.join(' / ')}`;
                }).join('；');
                gpStatus.textContent = '⚠ 按键冲突：' + desc + '。请改绑后再保存。';
                gpStatus.style.color = 'var(--fnos-ui-warn)';
                return;
            }
            // [lc-680] 收集高级参数
            const adv: Record<string, number> = {};
            for (const it of gpAdvParams) adv[it.key] = parseFloat(gpAdvRanges[it.key].value);
            const next = { enabled: gpToggle.checked, bindings, ...adv };
            if (gpApi && gpApi.saveConfig) {
                gpApi.saveConfig(next);
                gpStatus.textContent = '已保存 ✓ 立即生效';
                gpStatus.style.color = 'var(--fnos-ui-ok)';
                gpUpdateConn();
            } else {
                gpStatus.textContent = '保存失败：手柄插件未就绪';
                gpStatus.style.color = 'var(--fnos-ui-warn)';
            }
        } catch (err) {
            gpStatus.textContent = '保存失败：' + String((err as Error)?.message || err);
            gpStatus.style.color = 'var(--fnos-ui-warn)';
        }
    });

    gpResetBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        try {
            if (gpApi && gpApi.resetConfig) gpApi.resetConfig();
            if (gpApi && gpApi.getConfig) gpApplyConfig(gpApi.getConfig());
            gpStatus.textContent = '已恢复默认 ✓';
            gpStatus.style.color = 'var(--fnos-ui-ok)';
        } catch (err) {
            gpStatus.textContent = '重置失败：' + String((err as Error)?.message || err);
            gpStatus.style.color = 'var(--fnos-ui-warn)';
        }
    });

    // ===== 分组: 关于（独立标签页；原侧栏"关于"按钮迁入设置面板）=====
    const secAbout = section();
    const secBodyAbout = secAbout.body;
    secBodyAbout.style.cssText = 'padding:18px 16px;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;';

    const aboutTitle = document.createElement('div');
    aboutTitle.style.cssText = 'font-size:22px;font-weight:800;color:var(--fnos-ui-pill-text);';
    aboutTitle.textContent = '🎬 飞牛影视';
    secBodyAbout.appendChild(aboutTitle);

    const aboutAuthor = document.createElement('div');
    aboutAuthor.style.cssText = 'font-size:13px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:4px;';
    aboutAuthor.textContent = 'YDMY007';
    secBodyAbout.appendChild(aboutAuthor);

    const aboutDesc = document.createElement('div');
    aboutDesc.style.cssText = 'font-size:13px;line-height:1.9;color:var(--fnos-ui-text);opacity:.82;max-width:440px;';
    aboutDesc.textContent = '基于飞牛影视（fnOS TV）打造的增强桌面客户端，采用 Electron + 亚克力玻璃 UI。支持 MPV 播放器、B站弹幕、自定义透明度与模糊效果。';
    secBodyAbout.appendChild(aboutDesc);

    const aboutVer = document.createElement('div');
    aboutVer.id = 'fnos-about-version';
    aboutVer.style.cssText = 'font-size:12.5px;color:var(--fnos-ui-muted);margin-top:2px;';
    aboutVer.textContent = '版本：获取中…';
    secBodyAbout.appendChild(aboutVer);
    // 动态版本号：复用主进程 get-version / version-info（与旧侧栏关于按钮同源）
    try {
      ipcRenderer.send('get-version');
      ipcRenderer.once('version-info', (_e: any, info: any) => {
        if (info && info.version) aboutVer.textContent = '版本：v' + info.version;
      });
    } catch (_) {}

    const aboutLink = document.createElement('a');
    aboutLink.href = ABOUT_LINK_URL;
    aboutLink.textContent = '🔗 GitHub 项目地址';
    aboutLink.style.cssText = 'display:inline-block;font-size:13px;font-weight:700;color:var(--fnos-ui-pill-text);text-decoration:none;'
      + 'padding:8px 20px;border-radius:10px;background:var(--fnos-ui-pill-bg)!important;border:1px solid var(--fnos-ui-pill-border);'
      + 'transition:background .15s,transform .1s;margin-top:6px;cursor:pointer;';
    aboutLink.addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try { await ipcRenderer.invoke('app:open-external', ABOUT_LINK_URL); } catch (_) {}
    });
    aboutLink.onmouseenter = () => { aboutLink.style.transform = 'scale(1.03)'; aboutLink.style.background = 'var(--fnos-ui-pill-hover)!important'; aboutLink.style.color = '#fff'; };
    aboutLink.onmouseleave = () => { aboutLink.style.transform = ''; aboutLink.style.background = 'var(--fnos-ui-pill-bg)!important'; aboutLink.style.color = 'var(--fnos-ui-pill-text)'; };
    secBodyAbout.appendChild(aboutLink);

    // ===== 分组: 外观（独立标签页；原侧栏"亚克力透明度/背景模糊"滑块迁入设置面板）=====
    const secAppearance = section('主题与外观');
    const secBodyAppearance = secAppearance.body;
    secBodyAppearance.style.cssText = 'padding:8px 12px 12px;flex:1 1 auto;display:flex;flex-direction:column;';
    // [lc-1041] 主题模式行从原「功能开关」并入本卡首位
    themeRow.style.cssText += 'margin-bottom:6px;';
    secBodyAppearance.appendChild(themeRow);
    secBodyAppearance.appendChild(buildAppearanceControls());

    // ===== 分组: 系统桌面（切换系统页面目标地址，每人 NAS 端口各异）=====
    const secSystem = section('系统桌面');
    const secBodySystem = secSystem.body;
    secBodySystem.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const sysDesc = document.createElement('div');
    sysDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    sysDesc.textContent = '「切换系统页面」会跳到飞牛原生 NAS 系统桌面。每个人的系统 Web 端口可能不同（默认 5666，但都能改），不一定和影视媒体端口一致。留空=自动（用当前影视连接的同端口根路径）；若桌面在别的端口，请填完整地址，如 https://192.168.1.50:5666。';
    secBodySystem.appendChild(sysDesc);

    const sysInput = document.createElement('input');
    sysInput.type = 'text';
    sysInput.placeholder = '留空=自动；或填系统桌面完整地址，如 https://192.168.1.50:5666';
    sysInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;margin-bottom:8px;';
    secBodySystem.appendChild(sysInput);

    const sysBtns = document.createElement('div');
    sysBtns.style.cssText = 'display:flex;gap:6px;';
    const sysSaveBtn = mkBtn('保存', true);
    const sysResetBtn = mkBtn('重置为自动', true);
    sysBtns.appendChild(sysSaveBtn);
    sysBtns.appendChild(sysResetBtn);
    secBodySystem.appendChild(sysBtns);

    const sysStatus = document.createElement('div');
    sysStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodySystem.appendChild(sysStatus);

    sysSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const val = sysInput.value.trim();
        const r: any = await ipcRenderer.invoke('settings:set-system-page-url', val);
        if (!r || r.ok !== false) {
          sysStatus.textContent = val ? ('已保存：' + val) : '已设为自动（当前影视连接根路径）';
          sysStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          sysStatus.textContent = '保存失败';
          sysStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        sysStatus.textContent = '保存失败';
        sysStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    sysResetBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      sysInput.value = '';
      try {
        const r: any = await ipcRenderer.invoke('settings:set-system-page-url', '');
        if (!r || r.ok !== false) {
          sysStatus.textContent = '已重置为自动（当前影视连接根路径）';
          sysStatus.style.color = 'var(--fnos-ui-ok)';
        }
      } catch {
        sysStatus.textContent = '重置失败';
        sysStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // 初始回填：读取已保存地址（留空=自动）
    (async () => {
      try {
        const g: any = await ipcRenderer.invoke('settings:get-system-page-url');
        if (g && typeof g.url === 'string') sysInput.value = g.url;
      } catch { /* ignore */ }
    })();

    // ===== 分组: 自定义代理（让 Bangumi 每日放送、TMDB 等走用户自建代理入口）=====
    const secCustomProxy = section('自定义代理');
    const secBodyCustomProxy = secCustomProxy.body;
    secBodyCustomProxy.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const cpDesc = document.createElement('div');
    cpDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    cpDesc.textContent = '为 Bangumi 每日放送、TMDB（影视发现/海报）等数据源指定代理入口。支持 HTTP / HTTPS / SOCKS5，可填账号密码鉴权。优先级低于环境变量 HTTPS_PROXY（已设环境变量则它先生效）。开启开关并填写地址后才生效。';
    secBodyCustomProxy.appendChild(cpDesc);

    // 开关行（整行可点）
    const cpToggleRow = document.createElement('label');
    cpToggleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;margin-bottom:8px;';
    const cpToggleSpan = document.createElement('span');
    cpToggleSpan.textContent = '启用自定义代理';
    cpToggleSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const cpToggle = document.createElement('input');
    cpToggle.type = 'checkbox';
    cpToggle.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    cpToggleRow.appendChild(cpToggleSpan); cpToggleRow.appendChild(cpToggle);
    secBodyCustomProxy.appendChild(cpToggleRow);

    // 类型 + 主机:端口 行
    const cpRow1 = document.createElement('div');
    cpRow1.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const cpType = document.createElement('select');
    cpType.style.cssText = 'height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:4px 6px;box-sizing:border-box;';
    const cpTypeOpts: [string, string][] = [['https', 'HTTPS'], ['http', 'HTTP'], ['socks5', 'SOCKS5']];
    cpTypeOpts.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      cpType.appendChild(o);
    });
    const cpAddr = document.createElement('input');
    cpAddr.type = 'text';
    cpAddr.placeholder = '主机:端口，如 127.0.0.1:7890';
    cpAddr.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    cpRow1.appendChild(cpType);
    cpRow1.appendChild(cpAddr);
    secBodyCustomProxy.appendChild(cpRow1);

    // 账号 / 密码 行（可选鉴权）
    const cpRow2 = document.createElement('div');
    cpRow2.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const cpUser = document.createElement('input');
    cpUser.type = 'text';
    cpUser.placeholder = '账号（可选）';
    cpUser.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    const cpPass = document.createElement('input');
    cpPass.type = 'password';
    cpPass.placeholder = '密码（可选）';
    cpPass.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    cpRow2.appendChild(cpUser);
    cpRow2.appendChild(cpPass);
    secBodyCustomProxy.appendChild(cpRow2);

    // 根据表单组装代理 URL（类型://[user:pass@]host:port）
    function buildCpUrl(): string {
      const type = cpType.value || 'https';
      const addr = cpAddr.value.trim();
      if (!addr) return '';
      const user = cpUser.value.trim();
      const pass = cpPass.value;
      const auth = (user || pass) ? (encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@') : '';
      return type + '://' + auth + addr;
    }

    const cpBtns = document.createElement('div');
    cpBtns.style.cssText = 'display:flex;gap:6px;';
    const cpSaveBtn = mkBtn('保存', true);
    const cpTestBtn = mkBtn('测试连接', true);
    const cpResetBtn = mkBtn('关闭代理', true);
    cpBtns.appendChild(cpSaveBtn);
    cpBtns.appendChild(cpTestBtn);
    cpBtns.appendChild(cpResetBtn);
    secBodyCustomProxy.appendChild(cpBtns);

    const cpStatus = document.createElement('div');
    cpStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyCustomProxy.appendChild(cpStatus);

    function cpSetStatus(msg: string, ok: boolean | null): void {
      cpStatus.textContent = msg;
      cpStatus.style.color = ok === null ? 'var(--fnos-ui-sub)' : (ok ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-warn)');
    }

    cpSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const url = buildCpUrl();
        if (cpToggle.checked && !url) {
          cpSetStatus('已启用但未填写主机:端口（不生效）', false);
          return;
        }
        await ipcRenderer.invoke('settings:set-custom-proxy', cpToggle.checked, url);
        cpSetStatus(cpToggle.checked && url ? ('已保存并启用：' + url) : '已关闭自定义代理', true);
      } catch {
        cpSetStatus('保存失败', false);
      }
    });

    cpTestBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const url = buildCpUrl();
      if (!url) { cpSetStatus('请先填写主机:端口', false); return; }
      cpSetStatus('测试中…', null);
      cpTestBtn.disabled = true;
      try {
        const r: any = await ipcRenderer.invoke('settings:test-custom-proxy', true, url);
        if (r && r.ok) cpSetStatus('测试' + (r.info ? ('：' + r.info) : '通过'), true);
        else cpSetStatus('测试失败：' + ((r && r.error) || '未知'), false);
      } catch (err: any) {
        cpSetStatus('测试异常：' + String((err && err.message) || err), false);
      } finally {
        cpTestBtn.disabled = false;
      }
    });

    cpResetBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      cpToggle.checked = false;
      cpType.value = 'https';
      cpAddr.value = '';
      cpUser.value = '';
      cpPass.value = '';
      try {
        await ipcRenderer.invoke('settings:set-custom-proxy', false, '');
        cpSetStatus('已关闭自定义代理', true);
      } catch {
        cpSetStatus('重置失败', false);
      }
    });

    // 初始回填：读取已保存的开关与地址，解析出 类型 / 主机:端口 / 账号 / 密码
    (async () => {
      try {
        const g: any = await ipcRenderer.invoke('settings:get-custom-proxy');
        if (g) {
          cpToggle.checked = !!g.enabled;
          const u = (typeof g.proxyUrl === 'string') ? g.proxyUrl.trim() : '';
          if (u) {
            let rest = u;
            const m = rest.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
            if (m) {
              const scheme = m[1].toLowerCase();
              cpType.value = scheme.indexOf('socks') === 0 ? 'socks5' : (scheme === 'http' ? 'http' : 'https');
              rest = m[2];
            }
            const am = rest.match(/^([^@]+)@(.+)$/);
            if (am) {
              const up = am[1];
              rest = am[2];
              const c = up.indexOf(':');
              if (c >= 0) { cpUser.value = decodeURIComponent(up.slice(0, c)); cpPass.value = decodeURIComponent(up.slice(c + 1)); }
              else { cpUser.value = decodeURIComponent(up); }
            }
            cpAddr.value = rest;
          }
        }
      } catch { /* ignore */ }
    })();

    // ===== [lc-412] 轮播图 Logo 插件：首页轮播图右侧文字标题 ⇄ TMDB 透明 Logo 开关（归入「插件」分类） =====
    const secCarousel = section('轮播图 Logo');
    const secBodyCarousel = secCarousel.body;
    secBodyCarousel.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const carouselLogoDesc = document.createElement('div');
    carouselLogoDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    carouselLogoDesc.textContent = '开启后，首页轮播图右侧的文字标题会被替换为 TMDB 的透明 Logo 图（仅当该剧集在 TMDB 有透明 Logo 时）。关闭则保留原始文字标题。';
    secBodyCarousel.appendChild(carouselLogoDesc);

    // 开关行（整行可点）：开启=用 logo 图替换右侧文字标题；关闭=保留文字标题
    const swLogo = document.createElement('input');
    swLogo.type = 'checkbox';
    swLogo.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    const swLogoRow = document.createElement('label');
    swLogoRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;';
    const swLogoSpan = document.createElement('span');
    swLogoSpan.textContent = '轮播图标题替换为 Logo';
    swLogoSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    swLogoRow.appendChild(swLogoSpan); swLogoRow.appendChild(swLogo);
    secBodyCarousel.appendChild(swLogoRow);
    swLogo.checked = S.carouselLogoEnabled;
    swLogo.addEventListener('change', () => {
      S.carouselLogoEnabled = swLogo.checked;
      ipcRenderer.invoke('settings:set-carousel-logo', swLogo.checked);
      // 立即对当前已渲染轮播生效（开→拉取 logo 替换；关→还原文字标题）
      applyCarouselLogoNow();
    });

    // ===== 统一布局：左侧分类导航 + 右侧按分类切换的卡片 pane =====
    // [lc-1041] 重分组（按任务域聚类）：
    //   通用=退出行为/系统桌面/更新与维护 · 外观=主题模式+亚克力/轮播图Logo(原散在通用与插件)
    //   播放=播放器/跳过片头片尾(原在插件)/插帧/界面与浏览 · 弹幕 · 账号同步(五家不变)
    //   网络=网络与代理(原功能开关拆出)/自定义代理/TMDB免梯子直连(原在插件) · 手柄 · 诊断 · 关于
    //   [lc-1051] 用户要求：B站弹幕登录卡从「账号同步」移入「弹幕」分类页（登录与弹幕设置同域）。
    //   ⚠ 外部契约: _selectCat 只被 'danmaku' 引用(lc-518 catMap), fntv-open-settings 其余走
    //   #sec-<id> scrollIntoView —— 各卡片元素与 id 均未动, 仅换分类归属。
    type Cat = { id: string; label: string; els: HTMLElement[] };
    const cats: Cat[] = [
      { id: 'general', label: '通用', els: [sec3.el, secLang.el, secSystem.el, secUpd.el] },
      { id: 'appearance', label: '外观', els: [secAppearance.el, secCarousel.el] },
      { id: 'player', label: '播放', els: [sec2.el, secSkip.el, secInterp.el, secRender.el, secUX.el] },
      { id: 'danmaku', label: '弹幕', els: [secBili.el, secDanmaku.el] },
      { id: 'account', label: '账号同步', els: [secBangumi.el, secTmdb.el, secDouban.el, secTrakt.el] },
      { id: 'network', label: '网络', els: [secNet.el, secCustomProxy.el, secTmdbDirect.el] },
      { id: 'gamepad', label: '手柄', els: [secGamepad.el] },
      { id: 'diag', label: '诊断与日志', els: [secDiag.el, secDebug.el] },
      { id: 'about', label: '关于', els: [secAbout.el] },
    ];
    // 每个分类一个 pane(竖向卡片列); 清掉卡片在旧 grid 里设的 gridColumn(现已不在 grid 内)
    const panes: Record<string, HTMLElement> = {};
    cats.forEach((cat) => {
      const pane = document.createElement('div');
      pane.style.cssText = 'display:none;flex-direction:column;gap:14px;';
      cat.els.forEach((el) => {
        el.style.gridColumn = '';
        pane.appendChild(el);
      });
      pane.dataset.cat = cat.id;
      rightContent.appendChild(pane);
      panes[cat.id] = pane;
    });
    // 左侧导航按钮 + 切换逻辑
    const navBtns: Record<string, HTMLButtonElement> = {};
    // [lc-1041] 方向感知切换动画：去往 nav 序号更大的分类从右滑入，更小的从左滑入；
    //   display:none→flex 重放 CSS 动画(lc-1011 机制)，无需 JS 重触发；只动 opacity/transform。
    let _lastCatIdx = 0;
    let searchActive = false; // [lc-1065] 搜索态标志(selectCat 守卫用; 声明提前, 末尾首次 selectCat 调用先于搜索块初始化)
    const _reduceMotion = (): boolean => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    };
    const selectCat = (id: string): void => {
      // [lc-1065] 搜索态下外部入口(_selectCat/导航点击)切分类 → 先退搜索态, 避免结果区与分类 pane 同显
      if (searchActive) setSearchMode(false);
      const nextIdx = cats.findIndex((c) => c.id === id);
      const anim = _reduceMotion() ? ''
        : (nextIdx >= _lastCatIdx ? 'fnos-cat-in-r' : 'fnos-cat-in-l') + ' .22s cubic-bezier(.25,.7,.3,1) both';
      _lastCatIdx = nextIdx;
      for (const c of cats) {
        const on = c.id === id;
        const pane = panes[c.id];
        if (pane) {
          pane.style.display = on ? 'flex' : 'none';
          pane.style.animation = on ? anim : 'none';
          if (on) pane.scrollTop = 0; // 换分类回到顶部，避免停留在上一个分类的滚动深处
        }
        const b = navBtns[c.id];
        if (!b) continue;
        if (on) {
          b.style.background = 'var(--fnos-ui-accent)!important';
          b.style.color = '#fff';
          b.style.fontWeight = '700';
          b.style.borderColor = 'transparent';
        } else {
          b.style.background = 'transparent';
          b.style.color = 'var(--fnos-ui-text)';
          b.style.fontWeight = '500';
          b.style.borderColor = 'transparent';
        }
      }
    };
    // 暴露给 openSettingsPanel, 使 fntv-open-settings(若启用)能直接切到对应分类
    (overlay as any)._selectCat = (id: string): void => selectCat(id);
    cats.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cat.label;
      btn.style.cssText = 'text-align:left;padding:10px 12px;border-radius:9px;cursor:pointer;font-size:13px;'
        + 'border:1px solid transparent;background:transparent;color:var(--fnos-ui-text);'
        + 'transition:background .16s ease,color .16s ease;'
        + 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
        + '-webkit-app-region:no-drag;app-region:no-drag;';
      btn.onmouseenter = () => { if (btn.style.background.indexOf('accent') === -1) btn.style.background = 'var(--fnos-ui-row-hover)'; };
      btn.onmouseleave = () => { if (btn.style.background.indexOf('accent') === -1) btn.style.background = 'transparent'; };
      btn.onclick = (e: Event) => { e.stopPropagation(); selectCat(cat.id); };
      navBtns[cat.id] = btn;
      leftNav.appendChild(btn);
    });
    selectCat(cats[0].id); // 默认显示第一个分类(通用)

    // ===== [lc-1065] 设置面板搜索（VS Code 式）=====
    //  动机: 9 分类 30+ 设置项找设置靠翻。顶部搜索框, 输入关键字实时跨分类平铺出匹配行, 点击直达。
    //  索引不落文本快照: 每次执行搜索现走 DOM(卡片 body 由 section() 打 data-sec-body 标记,
    //  行=body 直接子元素, 匹配文本用 row.textContent 现读)——后注入的行/异步刷新的状态文案天然最新。
    const searchWrap = document.createElement('div');
    searchWrap.id = 'fnos-settings-search';
    searchWrap.style.cssText = 'flex-shrink:0;display:flex;align-items:center;gap:7px;margin:0 16px 10px;'
      + 'padding:7px 11px;border-radius:10px;background:var(--fnos-ui-input-bg)!important;'
      + 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);transition:box-shadow .15s;'
      + '-webkit-app-region:no-drag;app-region:no-drag;';
    const searchIcon = document.createElement('span');
    searchIcon.textContent = '🔍';
    searchIcon.style.cssText = 'font-size:12px;opacity:.7;flex-shrink:0;line-height:1;';
    const searchInput = document.createElement('input');
    searchInput.id = 'fnos-settings-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = '搜索设置…（Ctrl+F）';
    searchInput.spellcheck = false;
    searchInput.style.cssText = 'flex:1;min-width:0;border:none;outline:none;background:transparent;'
      + 'color:var(--fnos-ui-text);font-size:12.5px;';
    const searchClear = document.createElement('button');
    searchClear.type = 'button';
    searchClear.textContent = '✕';
    searchClear.style.cssText = 'display:none;width:20px;height:20px;flex-shrink:0;border:none;border-radius:50%;'
      + 'cursor:pointer;background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text2);'
      + 'font-size:10px;line-height:1;transition:background .15s;';
    searchClear.onmouseenter = () => { searchClear.style.background = 'var(--fnos-ui-btn-hover)!important'; };
    searchClear.onmouseleave = () => { searchClear.style.background = 'var(--fnos-ui-btn-bg)!important'; };
    searchWrap.appendChild(searchIcon); searchWrap.appendChild(searchInput); searchWrap.appendChild(searchClear);
    // 点击搜索框容器任意空白处都能聚焦输入(input 本身点击天然聚焦)
    searchWrap.addEventListener('click', () => searchInput.focus());
    searchInput.addEventListener('focus', () => { searchWrap.style.boxShadow = 'inset 0 0 0 1px var(--fnos-ui-accent)'; });
    searchInput.addEventListener('blur', () => { searchWrap.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,.14)'; });
    overlay.insertBefore(searchWrap, bodyRow); // 头部与主体之间通栏

    // 结果平铺区: 与 9 个分类 pane 同级挂在 rightContent 内, 仅搜索态显示
    const searchPane = document.createElement('div');
    searchPane.id = 'fnos-settings-search-pane';
    searchPane.style.cssText = 'display:none;flex-direction:column;gap:6px;';
    rightContent.appendChild(searchPane);

    // 直达高亮: inset box-shadow 泛光脉冲, 不污染行自身 background(行底色各异, 玻璃卡面上安全)
    if (!document.getElementById('fnos-search-hit-style')) {
      const hitSt = document.createElement('style');
      hitSt.id = 'fnos-search-hit-style';
      hitSt.textContent = '#fnos-settings-panel .fnos-search-hit{animation:fnos-hit-flash 1.4s ease-out both}'
        + '@keyframes fnos-hit-flash{0%{box-shadow:inset 0 0 0 999px rgba(76,99,224,.30)}100%{box-shadow:inset 0 0 0 999px rgba(76,99,224,0)}}';
      (document.head || document.documentElement).appendChild(hitSt);
    }

    const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
    const setSearchMode = (on: boolean): void => {
      if (searchActive === on) return;
      searchActive = on;
      // 搜索态: 左导航置灰禁点(点击语义由结果行直达承担), 隐全部分类 pane 显平铺结果
      leftNav.style.opacity = on ? '.35' : '1';
      leftNav.style.pointerEvents = on ? 'none' : '';
      for (const c of cats) panes[c.id].style.display = 'none';
      searchPane.style.display = on ? 'flex' : 'none';
      if (!on) selectCat(cats[Math.max(_lastCatIdx, 0)].id); // 退出搜索还原进搜索前的分类
      rightContent.scrollTop = 0;
    };

    const runSearch = (): void => {
      const raw = searchInput.value;
      const q = norm(raw);
      searchClear.style.display = q ? 'block' : 'none';
      if (!q) { setSearchMode(false); return; }
      // 实时走查: 分类→卡片(data-sec-body)→直接子级行; 自身 display:none 的行(条件隐藏)不入结果
      const hits: { cat: Cat; row: HTMLElement; label: string }[] = [];
      for (const cat of cats) {
        for (const card of cat.els) {
          const bodyEl = Array.from(card.children)
            .find((ch) => (ch as HTMLElement).dataset && (ch as HTMLElement).dataset.secBody === '1') as HTMLElement | undefined;
          if (!bodyEl) continue;
          for (const row of Array.from(bodyEl.children) as HTMLElement[]) {
            if (getComputedStyle(row).display === 'none') continue;
            const label = (row.textContent || '').replace(/\s+/g, ' ').trim();
            if (label.length < 2) continue;
            if (norm(label).indexOf(q) !== -1) hits.push({ cat, row, label });
          }
        }
      }
      searchPane.textContent = '';
      if (!hits.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center;color:var(--fnos-ui-sub);font-size:12px;padding:26px 0;';
        empty.textContent = '未找到与「' + raw.trim() + '」匹配的设置';
        searchPane.appendChild(empty);
      }
      hits.forEach(({ cat, row, label }) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;cursor:pointer;'
          + 'background:var(--fnos-ui-input-bg)!important;'
          + 'background-image:linear-gradient(165deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,.012) 60%)!important;'
          + 'transition:background .15s;';
        item.onmouseenter = () => { item.style.background = 'var(--fnos-ui-row-hover)!important'; };
        item.onmouseleave = () => { item.style.background = 'var(--fnos-ui-input-bg)!important'; };
        const badge = document.createElement('span');
        badge.textContent = cat.label;
        badge.style.cssText = 'flex-shrink:0;font-size:10px;font-weight:700;color:#fff;padding:3px 8px;'
          + 'border-radius:6px;background:var(--fnos-ui-accent)!important;letter-spacing:.3px;';
        const txt = document.createElement('span');
        txt.textContent = label.length > 52 ? label.slice(0, 52) + '…' : label;
        txt.title = label;
        txt.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fnos-ui-text);';
        const arrow = document.createElement('span');
        arrow.textContent = '▸';
        arrow.style.cssText = 'flex-shrink:0;color:var(--fnos-ui-sub);font-size:11px;';
        item.appendChild(badge); item.appendChild(txt); item.appendChild(arrow);
        item.addEventListener('click', () => {
          // 直达: 清搜索→退搜索态→切分类→滚动居中→高亮脉冲
          searchInput.value = '';
          searchClear.style.display = 'none';
          setSearchMode(false);
          selectCat(cat.id);
          requestAnimationFrame(() => {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.remove('fnos-search-hit');
            void row.offsetWidth; // 重读布局重触发 CSS 动画(连点两条结果时前一条动画已占用类名)
            row.classList.add('fnos-search-hit');
            setTimeout(() => row.classList.remove('fnos-search-hit'), 1500);
          });
        });
        searchPane.appendChild(item);
      });
      setSearchMode(true);
    };

    let searchTimer: number | undefined;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(runSearch, 90); // 轻防抖
    });
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 有输入: 只清搜索, 拦下事件不让面板跟着关; 空输入: 放行, ESC 落到面板兜底监听关闭面板
        if (searchInput.value) {
          e.stopPropagation();
          searchInput.value = '';
          searchClear.style.display = 'none';
          setSearchMode(false);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
      }
    });
    searchClear.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      searchInput.value = '';
      searchClear.style.display = 'none';
      setSearchMode(false);
      searchInput.focus();
    });
    // 面板打开期间 Ctrl/Cmd+F 聚焦搜索框(VS Code 习惯)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && overlay.style.display === 'flex') {
        e.preventDefault();
        e.stopPropagation();
        searchInput.focus();
        searchInput.select();
      }
    });
    resetSettingsSearch = (): void => {
      if (!searchActive && !searchInput.value) return;
      searchInput.value = '';
      searchClear.style.display = 'none';
      if (searchActive) setSearchMode(false); // 复位时还原分类 pane(下次打开面板不落空)
    };

    // 刷新豆瓣登录状态（打开面板时 / 登录变更时调用）
    const refreshDouban = async (): Promise<void> => {
      try {
        const st: any = await ipcRenderer.invoke('douban:login-status');
        if (st && st.loggedIn) {
          doubanStatus.textContent = '已登录豆瓣 ✓';
          doubanStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          doubanStatus.textContent = '未登录豆瓣（点"扫码登录"）';
          doubanStatus.style.color = 'var(--fnos-ui-warn)';
        }
        swDouban.checked = !!(st && st.enabled);
      } catch {
        doubanStatus.textContent = '状态获取失败';
        doubanStatus.style.color = 'var(--fnos-ui-warn)';
      }
    };
    // 主进程登录成功/退出时主动通知前端刷新
    ipcRenderer.on('douban:login-changed', () => { refreshDouban(); });

    // 刷新 B站登录状态(打开面板时调用)
    const refreshBili = async (): Promise<void> => {
      try {
        const st: any = await ipcRenderer.invoke('bili:cookie-status');
        if (st && st.exists) {
          biliStatus.textContent = '已登录 ✓';
          biliStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          biliStatus.textContent = '未登录';
          biliStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        biliStatus.textContent = '状态获取失败';
        biliStatus.style.color = 'var(--fnos-ui-warn)';
      }
    };

    // 注入 qrcode 库(仅一次)
    let _biliQrTimer = 0;
    let _biliLibReady = false;
    const ensureBiliQrLib = async (): Promise<boolean> => {
      if (_biliLibReady && (window as any).qrcode) return true;
      try {
        const src: string = await ipcRenderer.invoke('bili:qr-lib');
        if (!src) return false;
        const s = document.createElement('script');
        s.textContent = src;
        document.head.appendChild(s);
        _biliLibReady = !!(window as any).qrcode;
        return _biliLibReady;
      } catch { return false; }
    };

    // 打开扫码登录弹窗
    const openBiliLogin = async (): Promise<void> => {
      let modal = document.getElementById('fnos-bili-modal') as HTMLElement | null;
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'fnos-bili-modal';
        modal.style.cssText = 'position:fixed;z-index:2147483700;display:none;align-items:center;justify-content:center;'
          + 'left:0;top:0;width:100%;height:100%;background:var(--fnos-modal-overlay);';
        modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除
        const box = document.createElement('div');
        box.style.cssText = 'width:300px;padding:22px 20px 18px;border-radius:18px;text-align:center;color:var(--fnos-ui-text);'
          + 'background:var(--fnos-ui-panel-bg)!important;'
          + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);'
          + 'box-shadow:0 18px 50px rgba(80,60,120,.3),var(--fnos-modal-inner-shadow);'
          + 'border:1px solid var(--fnos-ui-border-outer);';
        box.innerHTML =
          '<div style="font-size:15px;font-weight:700;margin-bottom:4px;">B站弹幕登录</div>'
          + '<div style="font-size:11px;color:var(--fnos-ui-sec);margin-bottom:14px;">请用 B站 APP 扫码登录</div>'
          + '<div class="fnos-bili-qr" style="width:200px;height:200px;margin:0 auto 12px;display:flex;align-items:center;'
          + 'justify-content:center;background:var(--fnos-qr-bg);border-radius:12px;padding:10px;box-sizing:border-box;overflow:hidden;"></div>'
          + '<div class="fnos-bili-tip" style="font-size:12px;color:var(--fnos-ui-muted);min-height:18px;margin-bottom:14px;">准备中…</div>';
        const closeB = document.createElement('button');
        closeB.type = 'button';
        closeB.textContent = '取消';
        closeB.style.cssText = 'width:100%;padding:9px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text2);border:1px solid var(--fnos-ui-border-strong);';
        box.appendChild(closeB);
        modal.appendChild(box);
        modal.addEventListener('click', (e: Event) => {
          if (e.target === modal) { modal!.style.display = 'none'; clearInterval(_biliQrTimer); }
        });
        closeB.addEventListener('click', (e: Event) => { e.stopPropagation(); modal!.style.display = 'none'; clearInterval(_biliQrTimer); });
        document.body.appendChild(modal);
      }
      const m = modal;
      m.style.display = 'flex';
      const qrWrap = m.querySelector('.fnos-bili-qr') as HTMLElement | null;
      const tip = m.querySelector('.fnos-bili-tip') as HTMLElement | null;
      if (qrWrap) qrWrap.innerHTML = '生成二维码中…';
      if (tip) tip.textContent = '';
      clearInterval(_biliQrTimer);

      const okLib = await ensureBiliQrLib();
      if (!okLib) { if (qrWrap) qrWrap.textContent = '二维码库加载失败'; return; }
      const gen: any = await ipcRenderer.invoke('bili:qr-generate');
      if (!gen || !gen.ok) { if (qrWrap) qrWrap.textContent = '获取失败: ' + ((gen && gen.error) || '未知'); return; }
      try {
        const qr = (window as any).qrcode(0, 'M');
        qr.addData(gen.url);
        qr.make();
        if (qrWrap) { qrWrap.innerHTML = qr.createSvgTag(6, 10); const svg = qrWrap.querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; } }
      } catch (e: any) {
        if (qrWrap) qrWrap.textContent = '渲染失败: ' + (e?.message || e);
      }
      if (tip) tip.textContent = '请用 B站 APP 扫码';
      _biliQrTimer = window.setInterval(async () => {
        const r: any = await ipcRenderer.invoke('bili:qr-poll', gen.key);
        if (r.code === 0) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = '登录成功！';
          refreshBili();
          window.setTimeout(() => { m.style.display = 'none'; }, 900);
        } else if (r.expired) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = '二维码已过期，请重新点击扫码登录';
          if (qrWrap) qrWrap.innerHTML = '二维码已失效';
        } else {
          if (tip) tip.textContent = r.status || '等待扫码…';
        }
      }, 1500);
    };

    scanBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); openBiliLogin(); });
    logoutBiliBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const r: any = await ipcRenderer.invoke('bili:clear');
        biliStatus.textContent = (r && r.ok) ? '已清除登录信息' : '清除失败';
        biliStatus.style.color = 'var(--fnos-ui-warn)';
      } catch { biliStatus.textContent = '清除失败'; }
    });
    saveBiliCookieBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const r: any = await ipcRenderer.invoke('bili:manual-cookie', biliManualTa.value);
      if (r && r.ok) { biliManualTa.value = ''; refreshBili(); }
      else biliStatus.textContent = '保存失败：' + ((r && (r.msg || r.error)) || '未知');
    });
    const refreshExit = (): void => {
      const cur = (overlay as any)._exitMode || 'ask';
      exitEls.forEach((b) => {
        const on = b.dataset.mode === cur;
        b.style.background = (on ? 'var(--fnos-ui-exit-on)' : 'var(--fnos-ui-exit-off)') + '!important';
        b.style.color = on ? '#fff' : 'var(--fnos-ui-muted)';
        b.style.fontWeight = on ? '700' : '500';
        b.style.border = (on ? 'var(--fnos-exit-border-on)' : 'var(--fnos-exit-border-off)') + '!important';
      });
    };
    // hover 时不要覆盖选中态背景 → 重写退出按钮的 hover(仅未选中项响应)
    exitEls.forEach((b) => {
      b.onmouseenter = () => { if (b.dataset.mode !== ((overlay as any)._exitMode || 'ask')) b.style.background = 'var(--fnos-ui-btn-hover2)!important'; };
      b.onmouseleave = () => { refreshExit(); };
    });

    // 底部安全区(给滚动留空间)
    const footer = document.createElement('div');
    footer.style.cssText = 'height:6px;flex-shrink:0;';
    overlay.appendChild(footer);

    // 打开时刷新值
    (overlay as any)._refresh = async (): Promise<void> => {
      // [修复] 原实现是一整个 try 块串行回填 40+ 项，任何一项抛错都会静默跳过
      // 其后所有回填（典型症状：Bangumi 同步开关配置里明明是 true，面板却显示未勾选）。
      // 现改为分段隔离：每段独立 try/catch + 记录失败段名，单段失败不殃及其他段。
      let s: any = null;
      try {
        s = await ipcRenderer.invoke('settings:get');
      } catch (err) {
        log('SETTINGS refresh failed: settings:get invoke error', err);
        return;
      }
      if (!s || typeof s !== 'object') {
        log('SETTINGS refresh failed: settings:get returned', s);
        return;
      }
      const seg = (name: string, fn: () => void): void => {
        try { fn(); } catch (err) { log(`SETTINGS refresh segment [${name}] failed`, err); }
      };
      seg('switches', () => {
        const dl = !!(s.downloadProxy && s.downloadProxy.enabled);
        swProxy.checked = dl;
        swHide.checked = !!s.hideOriginalPlayButton;
        swNas.checked = !!s.nasProxyEnabled;
        // [lc-980] 美化开关回填(外观页 #fnos-sw-beautify): checked = !detailBoxless (detailBoxless=true=关闭美化/走原生)
        S.detailBoxless = !!s.detailBoxless;
        if (_beautifyToggle) { _beautifyToggle.checked = !S.detailBoxless; if (_beautifyPaint) _beautifyPaint(); }
        // [lc-418] 补回滚轮开关回填：此前只在构建期按 S.wheelHScrollEnabled 赋值,
        // 若面板被 SPA 重建且早于启动 seed 完成, 会显示默认态导致"关掉再开变回未勾选"。
        swWheel.checked = !!s.wheelHScroll;
        S.wheelHScrollEnabled = !!s.wheelHScroll;
        swLogo.checked = !!s.carouselLogoEnabled;
        S.carouselLogoEnabled = !!s.carouselLogoEnabled;
        // [lc-418] 诊断日志：面板每次打开记录开关回填值, 便于核对"配置文件 vs 面板显示"是否一致
        log('[开关回填] swProxy=' + swProxy.checked + ' swHide=' + swHide.checked + ' swNas=' + swNas.checked
          + ' 美化=' + (!!_beautifyToggle && _beautifyToggle.checked) + ' swWheel=' + swWheel.checked + ' swLogo=' + swLogo.checked);
      });
      seg('players', () => {
        mpvPath.textContent = s.mpvPath || '应用内置（已随安装包分发，无需本机安装）';
        potPathEl.textContent = s.potPath || '应用内置（已随安装包分发，无需本机安装）';
        shaderSel.value = s.mpvDefaultShader || 'off';
        renderIccBtn(s.mpvIccEnabled !== false);
        (overlay as any)._defaultPlayer = s.defaultPlayer || 'mpv';
        refreshDefaultPlayer();
        (overlay as any)._exitMode = s.exitMode || 'ask';
        refreshExit();
      });
      seg('accounts', () => {
        refreshBili();
        refreshDouban();
      });
      seg('debug', () => {
        swDebug.checked = !!s.debugEnabled;
        const dc: Record<string, boolean> = s.debugComponents || {};
        debugComps.forEach(([k]) => {
          if (swDebugComps[k]) swDebugComps[k].checked = dc[k] !== false; // 默认开启
        });
      });
      seg('bangumi', () => {
        // Bangumi Token 回填（已保存则显示星号掩码，不显示明文）
        const bt: string | null = s.bangumiToken || null;
        if (bt) {
          bangumiReal = bt;
          bangumiInput.value = maskBangumi(bt);
          bangumiInput.readOnly = true;
          bangumiStatus.textContent = '已保存 Token';
          bangumiStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          bangumiReal = '';
          bangumiInput.value = '';
          bangumiInput.readOnly = false;
          bangumiStatus.textContent = '';
        }
        // Bangumi 同步开关 + 阈值回填
        swBangumiSync.checked = !!s.bangumiSyncEnabled;
        bangumiThresholdInput.value = String(s.bangumiSyncThreshold || 80);
      });
      seg('tmdb', () => {
        // TMDB Key 回填（已保存则显示星号掩码，不显示明文）
        const kt: string | null = s.tmdbApiKey || null;
        if (kt) {
          tmdbReal = kt;
          tmdbInput.value = maskTmdb(kt);
          tmdbInput.readOnly = true;
          tmdbStatus.textContent = '已保存 TMDB Key';
          tmdbStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          tmdbReal = '';
          tmdbInput.value = '';
          tmdbInput.readOnly = false;
          tmdbStatus.textContent = '';
        }
        // TMDB 免梯子直连回填
        dcToggle.checked = !!s.tmdbDirectConnect;
        const dip: any = s.tmdbDirectIp || null;
        dcApiInput.value = (dip && dip.api) || '';
        dcImgInput.value = (dip && dip.img) || '';
      });
      seg('bili-search', () => {
        // MPV B站弹幕搜索开关回填（默认开启）
        swMpvBiliSearch.checked = s.mpvBiliSearchEnabled !== false;
        // B站弹幕聚合阈值回填（默认 1500；<0 视为禁用=0）
        aggInput.value = String(s.mpvBiliAggregateThreshold == null ? 1500 : (s.mpvBiliAggregateThreshold < 0 ? 0 : s.mpvBiliAggregateThreshold));
      });
      seg('danmaku', () => {
        // [lc-215] 弹幕分区已改为「B站弹幕屏蔽」：回填屏蔽类型勾选 + 屏蔽词，不再回填被移除的样式项
        const bt: string[] = Array.isArray(s.biliDanmakuBlockTypes) ? s.biliDanmakuBlockTypes : [];
        for (const b of blockToggles) b.input.checked = bt.includes(b.key);
        if (danBlacklist && danBlacklist.ta) danBlacklist.ta.value = s.biliDanmakuBlacklist || '';
        // [lc-1018] 弹弹play 凭证回填（已保存则星号掩码只读显示，不回显明文）
        ddRealId = s.dandanplayAppId || '';
        ddRealSecret = s.dandanplayAppSecret || '';
        ddIdInput.value = ddRealId ? maskDd(ddRealId) : '';
        ddIdInput.readOnly = !!ddRealId;
        ddSecretInput.value = ddRealSecret ? maskDd(ddRealSecret) : '';
        ddSecretInput.readOnly = !!ddRealSecret;
        if (ddRealId) ddStatus.textContent = '已保存自定义凭证，下次 MPV 播放时生效。';
      });
      // 诊断日志：面板每次打开都记录关键回填值，便于核对「配置文件 vs 面板显示」是否一致
      log('SETTINGS refresh done: bangumiSyncEnabled=' + String(s.bangumiSyncEnabled)
        + ' swChecked=' + String(swBangumiSync.checked)
        + ' token=' + (s.bangumiToken ? 'set' : 'none'));
    };

    // 点击面板外部时自动收起
    document.addEventListener('click', (ev: Event) => {
      if (overlay.style.display !== 'flex') return;
      const t = ev.target as Node;
      if (overlay.contains(t)) return;
      const sb = document.getElementById('fnos-settings-btn');
      if (sb && sb.contains(t)) return;
      // 落在其他自建设置弹窗(检查更新 fnosDialog / 反馈 / B站登录 / 应用补丁 / 测试更新 /
      // 版号切换 / 解锁码 / 历史版本)内时, 不连带关闭设置面板, 实现"一层一层关"的层级交互。
      // [lc-637] 补齐 应用补丁(fntv-patch-apply-popup) / 测试更新(fntv-test-wizard) /
      //   版号切换(fntv-version-switch-modal) / 解锁码(fntv-unlock-modal):
      //   否则点这些弹窗任意位置(含"确认/关闭"按钮) document 捕获会先把设置面板关掉,
      //   弹窗关掉后直接"全部没了"而非回到设置面板。
      if (t instanceof Element) {
        const withinOtherUi = t.closest('#fnos-dialog-overlay')
          || t.closest('#fnos-feedback-modal')
          || t.closest('#fnos-qq-group-modal')
          || t.closest('#fnos-bili-modal')
          || t.closest('#fnos-history-overlay')
          || t.closest('#fntv-patch-apply-popup')
          || t.closest('#fntv-test-wizard')
          || t.closest('#fntv-version-switch-modal')
          || t.closest('#fntv-unlock-modal');
        if (withinOtherUi) return;
      }
      overlay.style.display = 'none';
    }, true);

    document.body.appendChild(mask);
    document.body.appendChild(overlay);
  }

  /** [新] 打开设置面板: 固定宽度, 整窗口正中居中显示并刷新数据 */
  function openSettingsPanel(_panel?: HTMLElement, sectionId?: string): void {
    const overlay = document.getElementById('fnos-settings-panel') as HTMLElement | null;
    if (!overlay) return;
    // 整个客户端窗口正中居中(不再贴侧栏)
    overlay.style.top = '50%';
    overlay.style.left = '50%';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'translate(-50%, -50%)';
    overlay.style.width = 'min(680px, calc(100vw - 80px))';
    // [lc-684] 固定面板高度: 此处曾写 height='auto' 导致切换分类时面板随内容伸缩跳动。
    //   改为固定高度(取 820px 与视口可用高度较小值), 配合 bodyRow flex:1 + 右内容区
    //   overflow-y:auto 实现"面板恒定、内容内部滚动"。
    overlay.style.height = Math.min(820, window.innerHeight - 100) + 'px';
    overlay.style.maxHeight = (window.innerHeight - 100) + 'px';
    overlay.style.display = 'flex';
    const mask = document.getElementById('fnos-settings-mask');
    if (mask) mask.style.display = 'block';
    const refresh = (overlay as any)._refresh;
    if (typeof refresh === 'function') refresh();
    if (sectionId) {
      // [适配左导航布局] 若 sectionId 对应某个分类, 直接切换显示该分类; 否则回退到滚动定位
      const catMap: Record<string, string> = { danmaku: 'danmaku' };
      const sel = (overlay as any)._selectCat;
      if (catMap[sectionId] && typeof sel === 'function') {
        sel(catMap[sectionId]);
      } else {
        const target = document.getElementById('sec-' + sectionId);
        if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
  }

  // [lc-199] 控制栏「弹幕样式」按钮 → 主进程转发 → 打开设置面板并定位到弹幕分区
  // [lc-518] 首页更新弹窗「应用补丁」→ 主进程发 fntv-open-settings('patch')：
  //   打开设置面板并定位后，自动唤起补丁应用弹窗(autoApply 直接下载显示进度，复用已验证路径)
  ipcRenderer.on('fntv-open-settings', (_e: any, sectionId: string) => {
      if (sectionId === 'patch') {
          openSettingsPanel(undefined, 'patch');
          setTimeout(() => {
              console.log('[EmbyWall][patch] 更新弹窗跳转设置面板后自动应用补丁');
              fntvOpenPatchApplyPopup(true);
          }, 350);
          return;
      }
      openSettingsPanel(undefined, sectionId);
  });

  /** 判断某 background-color 是否为"不透明/半透明的白/浅灰底"(需透明化让浅蓝透出) */
  function isOpaqueLightBg(bg: string): boolean {
    if (!bg) return false;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if (a < 0.05) return false;               // 已透明, 跳过
    return r >= 235 && g >= 235 && b >= 235;  // 白/浅灰系(避免误伤蓝色/深色按钮)
  }
  const animateCloseDrawer = (d: HTMLElement): void => {
    d.classList.remove('drawer-open');
    // 过渡结束后(340ms)才真正移除 display, 期间 opacity→0+pointer-events:none 已不可点, 安全
    window.setTimeout(() => { if (!d.classList.contains('drawer-open')) d.style.removeProperty('display'); }, 340);
  };

  /** [lc-875] 顶栏(汉堡键所在的导航栏, 含飞牛影视 logo)强制全透明:
   *  去掉 fnOS 原生半透明/毛玻璃底, 让桌面亚克力/壁纸透出, 实现沉浸式顶栏。
   *  只遍历汉堡键的祖先链(不动兄弟/子节点) → logo、导航项、按钮、文字均不受影响;
   *  命中最近的"带底色"祖先即停, 不向上误伤 app 外壳背景。 */
  const applyTopNavTransparent = (): void => {
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])') as HTMLElement | null;
    if (!burger) return;
    let el: HTMLElement | null = burger.parentElement;
    for (let i = 0; i < 4 && el; i++) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map(s => parseFloat(s.trim()));
        const a = parts.length >= 4 ? parts[3] : 1;
        if (a > 0) { // 命中带底色的顶栏容器 → 透明化 + 去模糊, 仅处理最近的一个即停
          el.style.setProperty('background', 'transparent', 'important');
          el.style.setProperty('background-color', 'transparent', 'important');
          el.style.setProperty('backdrop-filter', 'none', 'important');
          el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
          log('[lc-875] top-nav transparentized:', (el.className || el.tagName).slice(0, 60));
          break;
        }
      }
      el = el.parentElement;
    }
  };

  const ensureBurgerVisible = () => {
    // ① 强制可见: 宽屏下汉堡键被Tailwind @media钉死display:none, 强制显示(不影响布局/抽屉)
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])') as HTMLElement | null;
    if (!burger) return;
    if (getComputedStyle(burger).display === 'none') {
      burger.style.setProperty('display', 'flex', 'important');
    }
    // [v351] 侧栏毛玻璃: 只要抽屉DOM存在就注入(无论开/关状态, openDrawer也会再调)
    const _dr = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (_dr) applySidebarGlass(_dr);
    // ② 汉堡键点击: 完全接管抽屉开合 (capture 阶段拦截飞牛原生 onClick, 避免双重控制)
    //   [v325/v326 关键修正] 之前用冒泡且不拦截飞牛 → 飞牛原生 toggle 与我们的 inline 切换
    //   双重控制, 宽屏下飞牛 onClick 有时激活、有时 no-op, 导致抽屉"能开不能收/卡死"。
    //   改为: capture 阶段 stopImmediatePropagation 拦截飞牛, 由我们唯一用 inline style 控制显隐。
    //   因从不修改 !hidden 类(飞牛 state 永远不变/与 DOM 一致), 不会触发 state 同步死锁
    //   (与 v322 的 !hidden 类编辑死锁本质不同)。
    //   [v329 动画] 开合不再瞬切 display, 改为 display:flex + 双rAF切 .drawer-open 类驱动 CSS 过渡
    //     (overlay opacity 淡入 + 面板 translateX 滑入); 关闭时移除类、过渡结束(340ms)后再移除 display。
    if (!(burger as any).dataset.burgerHooked) {
      (burger as any).dataset.burgerHooked = '1';
      burger.addEventListener('click', (e: Event) => {
        if ((e.target as HTMLElement).closest('a')) return; // 🏠 首页链接放行(不拦截, 交给飞牛导航)
        e.preventDefault();
        e.stopImmediatePropagation(); // 拦截飞牛原生 onClick, 避免双重控制
        const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
        if (!drawer) return;
        // 接管抽屉开合(动画版): 不动 !hidden 类, 用 display + .drawer-open 类驱动 CSS 过渡
        if (drawer.classList.contains('drawer-open')) { animateCloseDrawer(drawer); log('BURGER -> CLOSE (anim)'); }
        else { openDrawer(drawer); log('BURGER -> OPEN (anim)'); }
      }, true); // capture 阶段, 抢在 React 之前拦截
      log('BURGER click-hook installed (capture+stop)');
    }
    // ③ 遮罩/背板点击关闭: 点抽屉背板(非侧栏面板)即关闭
    //    [v326 修正] 之前用 `e.target === drawer` 太严格 —— 实际暗色背板是 drawer 的子元素(.absolute.inset-0),
    //    点背板时 e.target 是背板而非 drawer → 旧逻辑不关 → 宽屏下飞牛无原生 handler → 抽屉卡死不收回。
    //    改为: 点 drawer 本身或其背板子元素(非面板)即关闭; capture 拦截飞牛, 由我们唯一控制。
    const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (drawer && !(drawer as any).dataset.maskHooked) {
      (drawer as any).dataset.maskHooked = '1';
      drawer.addEventListener('click', (e: Event) => {
        const panel = drawer.querySelector('[class*="relative"]');
        const onPanel = panel ? panel.contains(e.target as Node) : false;
        if (onPanel) return; // 点在侧栏面板内(菜单项)不关闭, 交给飞牛处理点击
        const backdrop = drawer.querySelector('.absolute.inset-0') || drawer.querySelector('[class*="absolute"]');
        const onBackdrop = (backdrop && backdrop.contains(e.target as Node)) || e.target === drawer;
        if (!onBackdrop) return;
        e.stopImmediatePropagation(); // 拦截飞牛原生遮罩 handler, 避免双重控制
        if (drawer.classList.contains('drawer-open')) { animateCloseDrawer(drawer); log('MASK -> CLOSED (anim)'); }
      }, true); // capture 阶段
      log('MASK click-close-hook installed (capture+stop)');
    }
    applyTopNavTransparent(); // [lc-875] 顶栏(汉堡键+飞牛影视 logo)强制全透明
    scheduleTopLeftIconContrast(500); // [lc-925] 顶栏透明后图标直接压在页面上 → 采样背景亮度自适应反色
  };

  // ═══ [lc-925] 左上角图标自适应反色 ═══
  // 背景: [lc-875] 把顶栏强制透明后, 详情页左上角图标(原生「返回」/ 汉堡键 ☰ / 我们注入的刷新按钮)
  //   直接压在剧集 backdrop 之上。backdrop 多为暗色调 → 恒为黑色的图标几乎不可见。
  // 方案: 采样图标"背后那一层"的真实亮度 —— 沿 elementsFromPoint 栈自顶向下找第一个
  //   「不是图标自身祖先」且「有实心背景色 / 背景图 / 是 <img>」的元素, 背景图与 <img>
  //   用 canvas 取【左上角区域】的平均亮度(详情页 hero 顶左即图标所处位置)。
  //   暗底(lum < 140) → 图标转近白 + 深色投影; 亮底 → 保持近黑 + 白色投影。
  //   采样失败/跨域污染 → 按页面类型兜底(详情页按暗底, 其余按亮底)。
  const _TL_SIDEBAR_SEL = 'aside, [class*="sidebar"], [class*="drawer"], [class*="offcanvas"], [id*="sidebar"], [id*="drawer"]';
  const _TL_DARK_THRESHOLD = 140; // 背景平均亮度低于此值即判为「暗底」→ 图标反白
  let _tlTimer = 0;
  let _tlBusy = false;
  let _tlLastApply = 0;
  let _tlLum: number | null = null;
  let _tlLumTs = 0;
  const _tlImgCache = new Map<string, number | null>();

  /** 采集左上角需要反色的元素: 详情页原生「返回」+ 汉堡键 ☰ + 刷新按钮 + 同排导航文字(「首页」等) */
  function collectTopLeftIcons(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const push = (el: Element | null | undefined): void => {
      const h = el as HTMLElement | null;
      if (!h || out.indexOf(h) >= 0) return;
      const r = h.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.height > 64) return;  // 未渲染/零尺寸/过大容器
      if (r.top > 160 || r.left > 360) return;                   // 只认左上角
      if (h.closest(_TL_SIDEBAR_SEL)) return;                    // 排除侧边栏内的同名元素
      if (getComputedStyle(h).visibility === 'hidden') return;
      out.push(h);
    };
    push(document.querySelector('button[aria-label="返回"]'));                  // 详情页原生返回
    push(document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])')); // 汉堡键 ☰
    push(document.getElementById('fnos-refresh-btn'));                          // 我们注入的刷新
    // 同一条顶栏里的导航文字(「首页」链接等): 与三个按钮同排, 一并反色才协调。
    // 只取「叶子文本节点」(无子元素且有文字), 避免父子重复叠加 filter。
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])');
    const navBar = burger ? burger.parentElement : null;
    if (navBar) {
      const items = navBar.querySelectorAll('a, span, p');
      for (let i = 0; i < items.length && i < 60; i++) {
        const it = items[i] as HTMLElement;
        if (it.children.length > 0) continue;
        if (!(it.textContent || '').trim()) continue;
        push(it);
      }
    }
    return out;
  }

  function _lumOf(r: number, g: number, b: number): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** 取一张图「左上角区域」的平均亮度(0~255)。跨域图会污染 canvas → getImageData 抛错 → 返回 null 交兜底。 */
  function imageTopLeftLuminance(url: string): Promise<number | null> {
    const cached = _tlImgCache.get(url);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise<number | null>((resolve) => {
      let done = false;
      const finish = (v: number | null): void => {
        if (done) return;
        done = true;
        _tlImgCache.set(url, v);
        if (_tlImgCache.size > 64) _tlImgCache.clear(); // 防无限增长
        resolve(v);
      };
      window.setTimeout(() => finish(null), 4500);
      let im: HTMLImageElement;
      try {
        im = new Image();
        im.crossOrigin = 'anonymous'; // 同源图无副作用; 跨域图加载失败 → null
      } catch (_) { finish(null); return; }
      im.onload = () => {
        try {
          const W = 24, H = 24;
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
          if (!ctx) { finish(null); return; }
          const sw = Math.max(1, Math.floor((im.naturalWidth || 1) * 0.45));
          const sh = Math.max(1, Math.floor((im.naturalHeight || 1) * 0.45));
          ctx.drawImage(im, 0, 0, sw, sh, 0, 0, W, H);
          const d = ctx.getImageData(0, 0, W, H).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 16) continue;
            sum += _lumOf(d[i], d[i + 1], d[i + 2]);
            n++;
          }
          finish(n ? sum / n : null);
        } catch (_) { finish(null); } // 典型: SecurityError(跨域污染)
      };
      im.onerror = () => finish(null);
      im.src = url;
    });
  }

  /** 采样某个图标"背后那一层"的亮度。返回 null 表示拿不到(交上层兜底)。 */
  async function detectBehindLuminance(icon: HTMLElement): Promise<number | null> {
    const r = icon.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 2), window.innerWidth - 2);
    const y = Math.min(Math.max(r.top + r.height / 2, 2), window.innerHeight - 2);
    const anyDoc = document as any;
    if (typeof anyDoc.elementsFromPoint !== 'function') return null;
    let stack: HTMLElement[];
    try { stack = (Array.from(anyDoc.elementsFromPoint(x, y)) as HTMLElement[]).filter(Boolean); }
    catch (_) { return null; }
    // ⚠️ 不跳过"图标的祖先容器": elementsFromPoint 已是【自顶向下】的绘制顺序,
    //   后出现的元素就是更靠后的层; 只要某祖先真的画了底色/底图, 它即为图标所见背景, 必须采它。
    //   (lc-875 已把顶栏透明化 → 顶栏不会被采到, 会继续往下命中详情页 hero。)
    //   只跳过图标自身与其后代(svg/path 绘制在图标之上, 属于"前景")。
    const overlays: { l: number; a: number }[] = []; // 半透明层(0.05 ≤ a < 0.5): 记下来与底层做 alpha 混合
    const blend = (base: number): number => {
      let L = base;
      for (let i = overlays.length - 1; i >= 0; i--) L = L * (1 - overlays[i].a) + overlays[i].l * overlays[i].a;
      return L;
    };
    for (const el of stack) {
      if (el === icon || icon.contains(el)) continue;
      let cs: CSSStyleDeclaration;
      try { cs = getComputedStyle(el); } catch (_) { continue; }
      // ① 背景色: 实心直接返回; 半透明先记下继续往下找底层; 全透明跳过
      const m = (cs.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(',').map(s => parseFloat(s.trim()));
        const a = p.length >= 4 ? p[3] : 1;
        if (!isNaN(p[0]) && !isNaN(p[1]) && !isNaN(p[2])) {
          if (a >= 0.5) return blend(_lumOf(p[0], p[1], p[2]));
          if (a >= 0.05) overlays.push({ l: _lumOf(p[0], p[1], p[2]), a });
        }
      }
      // ② 背景图(纯渐变无 url() 会自动跳过, 继续往下找)
      const bi = cs.backgroundImage || '';
      if (bi && bi !== 'none') {
        const u = bi.match(/url\(["']?([^"')]+)["']?\)/);
        if (u && u[1]) {
          const l = await imageTopLeftLuminance(u[1]);
          if (l != null) return blend(l);
        }
      }
      // ③ <img> 元素
      if (el.tagName === 'IMG') {
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '';
        if (src) {
          const l = await imageTopLeftLuminance(src);
          if (l != null) return blend(l);
        }
      }
    }
    return null;
  }

  /** 按亮度把左上角图标刷成「与背景对比」的颜色 + 反向投影(中间调也保证可辨) */
  function paintTopLeftIcons(icons: HTMLElement[], lum: number): void {
    const dark = lum < _TL_DARK_THRESHOLD;
    const color = dark ? 'rgba(255,255,255,.96)' : 'rgba(22,18,32,.92)';
    const shadow = dark
      ? 'drop-shadow(0 1px 3px rgba(0,0,0,.65)) drop-shadow(0 0 2px rgba(0,0,0,.45))'
      : 'drop-shadow(0 1px 2px rgba(255,255,255,.85))';
    for (const ic of icons) {
      ic.style.setProperty('color', color, 'important');
      ic.style.setProperty('-webkit-text-fill-color', color, 'important');
      ic.style.setProperty('filter', shadow, 'important');
      ic.dataset.fntvTlIcon = dark ? 'light' : 'dark';
      // svg: 只用 currentColor 重着色, 绝不改 fill="none" 的描边型图标(会把线稿填成实心块)
      const svgs: SVGElement[] = ic.tagName.toLowerCase() === 'svg'
        ? [ic as unknown as SVGElement]
        : (Array.from(ic.querySelectorAll('svg')) as SVGElement[]);
      for (const sv of svgs) {
        sv.style.setProperty('color', color, 'important');
        const targets: Element[] = [sv as Element].concat(Array.from(sv.querySelectorAll('*')) as Element[]);
        for (const t of targets) {
          const attrs = ['fill', 'stroke'] as const;
          for (const attr of attrs) {
            const v = t.getAttribute(attr);
            // 仅改写"硬编码颜色值"的 fill/stroke; none / currentColor / url(#...) 一律不动
            if (v && v !== 'none' && !/^currentcolor$/i.test(v) && !/^url\(/i.test(v)) {
              t.setAttribute(attr, 'currentColor');
            }
          }
        }
      }
    }
    log(`[lc-925] 左上角图标反色: lum=${Math.round(lum)} → ${dark ? '浅色(暗底)' : '深色(亮底)'}, ${icons.length} 个元素`);
  }

  async function applyTopLeftIconContrast(): Promise<void> {
    if (_tlBusy) return; // 防重入(observer 高频触发时最多一次采样)
    _tlBusy = true;
    try {
      const icons = collectTopLeftIcons();
      if (!icons.length) return;
      const need = icons.some(i => !i.dataset.fntvTlIcon); // fnOS 重渲染出新 DOM → 标记丢失 → 必须重刷
      const now = Date.now();
      if (!need && now - _tlLastApply < 1500) return;      // 已处理且刚处理过 → 跳过, 保护高频 observer
      // [lc-990] 详情页美化已套用 → 顶栏是「封面取色的暗化玻璃条」(heroTint.ts 把主色的 HSL 亮度
      //   压到 L<=0.20 → 底色亮度 <=51)，恒为暗底 → 直接短路，不采样。
      //   为什么必须短路：detectBehindLuminance 只认 backgroundColor / url() 背景图 / <img>，
      //   纯 linear-gradient 被它自己跳过(其注释原文「纯渐变无 url() 会自动跳过」)，
      //   而顶栏那两层遮罩全是渐变；hero 剧照与海报又都带 pointer-events-none
      //   → elementsFromPoint 永不返回它们。详情页因此恒命中 hero 的实心 rgb(25,25,26)
      //   而判暗底(实测 lum=25.07)，本来就没错；但 hero 就绪**之前**的那几拍
      //   (导航后 700/1600/3200ms 重试链)可能命中瞬间加载层或亮背景而误判亮底
      //   → 图标被刷成 rgba(22,18,32,.92) + 白色发光，压在暗玻璃上实测对比度仅 **1.69** → 不可读。
      //   ⚠ 只能在本函数内解决：这里写的是 inline !important，优先级高于 beautifyStyle.ts K 段的
      //     stylesheet !important，K 段压不住它。body 上的 fnos-beautify 由 teardownDetailBeautify
      //     摘除 → 关掉详情页美化开关或离开详情页后，下面的原采样逻辑自动恢复。
      if (document.body.classList.contains('fnos-beautify')) {
        paintTopLeftIcons(icons, 0);
        _tlLastApply = Date.now();
        return;
      }
      let lum: number | null = (_tlLum != null && now - _tlLumTs < 8000) ? _tlLum : null;
      if (lum == null) {
        for (const ic of icons) {
          lum = await detectBehindLuminance(ic);
          if (lum != null) break;
        }
        if (lum == null) lum = isDetailPage() ? 60 : 235;  // 兜底: 详情页按暗底, 其余按亮底
        _tlLum = lum;
        _tlLumTs = now;
      }
      paintTopLeftIcons(icons, lum);
      _tlLastApply = Date.now();
    } catch (e) {
      log('[lc-925] 左上角反色异常: ' + String(e).substring(0, 80));
    } finally { _tlBusy = false; }
  }

  function scheduleTopLeftIconContrast(delay = 400): void {
    window.clearTimeout(_tlTimer);
    _tlTimer = window.setTimeout(() => { void applyTopLeftIconContrast(); }, delay);
  }

  /** 路由切换/背景图变化时清缓存 → 强制重新采样 */
  function resetTopLeftIconContrast(): void {
    _tlLum = null; _tlLumTs = 0; _tlLastApply = 0;
  }
  /** 导航后重算: 先清缓存, 再按 700/1600/3200ms 三拍重试(详情页 hero 图异步加载) */
  const _scheduleTopLeftAfterNav = (): void => {
    resetTopLeftIconContrast();
    scheduleTopLeftIconContrast(700);
    [1600, 3200].forEach(ms => window.setTimeout(() => { void applyTopLeftIconContrast(); }, ms));
  };
  // 诊断: Console 执行 fntvTopLeftIconDiag() 打印当前采样到的亮度与各图标颜色
  (window as any).fntvTopLeftIconDiag = function (): any {
    const icons = collectTopLeftIcons();
    const info: any = {
      url: location.href,
      cachedLum: _tlLum,
      count: icons.length,
      icons: icons.map(i => ({
        tag: i.tagName,
        id: i.id || '',
        cls: (i.className || '').toString().slice(0, 50),
        text: (i.textContent || '').trim().slice(0, 12),
        mode: i.dataset.fntvTlIcon || '(未处理)',
        color: i.style.color || '',
        rect: `${Math.round(i.getBoundingClientRect().left)},${Math.round(i.getBoundingClientRect().top)}`,
      })),
    };
    console.log('[fntvTopLeftIconDiag]', JSON.stringify(info, null, 2));
    log('[fntvTopLeftIconDiag] ' + JSON.stringify(info));
    return info;
  };

  // 立即执行一次 + 定时巡检
  ensureBurgerVisible();
  [800, 2000, 4000].forEach(t => setTimeout(ensureBurgerVisible, t));
  // [lc-925] 左上角反色: 首屏 + 延迟重试(hero/backdrop 图异步加载完成后需重新采样)
  scheduleTopLeftIconContrast(700);
  [1500, 3500, 7000].forEach(t => window.setTimeout(() => { void applyTopLeftIconContrast(); }, t));
  // [lc-925] 滚动/改窗口大小会让顶栏背后换成完全不同的一块画面(详情页 hero 滑走后是浅色内容区)
  //   → 停手 500ms 后清缓存重新采样, 保证图标始终与"当前实际背景"对比。
  let _tlScrollTimer = 0;
  const _tlOnScrollOrResize = (): void => {
    window.clearTimeout(_tlScrollTimer);
    _tlScrollTimer = window.setTimeout(() => { resetTopLeftIconContrast(); void applyTopLeftIconContrast(); }, 500);
  };
  window.addEventListener('scroll', _tlOnScrollOrResize, { passive: true });
  window.addEventListener('resize', _tlOnScrollOrResize, { passive: true });

  // [lc-705] 暴露"收起侧边栏"全局钩子：侧栏底部 4 个自定义按钮（设置 / 切换系统页面 /
  //   软件反馈建议 / 观影记录）点击后调用它，复刻飞牛原生类目按钮"点一下侧栏自动收起"的效果。
  //   设置/反馈/观影记录 等面板均挂载在 document.body，与抽屉无关，收起侧栏不会把它们一起藏掉。
  (window as any).fntvCloseSidebar = function (): void {
    const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (drawer && drawer.classList.contains('drawer-open')) animateCloseDrawer(drawer);
  };

  // [lc-908] 诊断: 在二级详情页 Console 执行 fntvDumpSeasonDOM() 即可把选集区域真实结构打出来,
  // 用于定位 findSeasonEpParent 在该页面为何拿不到主内容容器(二级页两栏建不起来的根因)。
  (window as any).fntvDumpSeasonDOM = function (): any {
    const info: any = {
      cardRoot: document.querySelectorAll('.card-root').length,
      details: document.querySelectorAll('[data-id="details"]').length,
      msContainer: document.querySelectorAll('.ms-container').length,
      bodyClass: document.body.className,
      has2col: !!document.querySelector('.fnos-season-2col'),
      url: location.href,
      strongs: Array.from(document.querySelectorAll('strong,h2,h3,h4'))
        .map((s) => (s.textContent || '').trim()).filter(Boolean).slice(0, 30),
    };
    const first = document.querySelector('.card-root, [data-id="details"]') as HTMLElement | null;
    if (first) {
      info.firstCardClass = first.className;
      const chain: string[] = [];
      let p: HTMLElement | null = first.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const r = p.getBoundingClientRect();
        chain.push(`${(p.className || p.tagName).toString().substring(0, 50)} | w=${Math.round(r.width)} | ${(p.classList.contains('relative') ? 'relative ' : '') + (p.classList.contains('w-full') ? 'w-full' : '')}`);
        p = p.parentElement;
      }
      info.firstCardParentChain = chain;
    }
    // 列出所有疑似"选集标题"后的兄弟容器
    const cand: string[] = [];
    for (const s of Array.from(document.querySelectorAll('strong,h2,h3,h4,.semi-typography-heading'))) {
      const t = (s.textContent || '').trim();
      if (/选集|剧集|分集|Episodes|episodes/i.test(t)) {
        const sb = s.nextElementSibling as HTMLElement | null;
        cand.push(`标题"${t}" next=${sb ? (sb.className || sb.tagName).toString().substring(0, 40) : 'null'} parent=${(s.parentElement?.className || '').toString().substring(0, 40)}`);
      }
    }
    info.seasonTitleCandidates = cand;
    console.log('[fntvDumpSeasonDOM]', JSON.stringify(info, null, 2));
    log('[fntvDumpSeasonDOM] ' + JSON.stringify(info));
    return info;
  };

  // ═══ 首页导航栏刷新按钮 ═══
  // 在飞牛原生导航栏「首页」标签右侧注入刷新按钮，点击后 reload 页面。
  // 飞牛 SPA 路由切换会重建导航 DOM → 用 MutationObserver 兜底重建按钮。
  const injectRefreshButton = (): void => {
    if (document.getElementById('fnos-refresh-btn')) return; // 幂等

    // ── 以汉堡键 ☰ 为锚点（与 ensureBurgerVisible 同一选择器，已验证可靠）──
    // 顶栏实际布局: [☰] [首页] ... [logo] [搜索] [用户] [设置]
    // 刷新按钮目标位置: 「首页」文字右侧、紧邻着
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])') as HTMLElement | null;
    if (!burger) return; // 汉堡键还没渲染

    // 排除侧边栏/抽屉内的汉堡键（只要顶栏那个）
    const SIDEBAR_SEL = 'aside, [class*="sidebar"], [class*="drawer"], [class*="offcanvas"], [class*="side-panel"], [role="dialog"][aria-label*="导航"], [id*="sidebar"], [id*="drawer"]';
    if (burger.closest(SIDEBAR_SEL)) return;

    // 在汉堡键的父容器（导航栏）内，找紧挨着汉堡键的「首页」文字元素
    const navBar = burger.parentElement;
    if (!navBar) return;

    let anchorEl: HTMLElement | null = null;
    // 从汉堡键开始向后遍历兄弟节点，找含"首页"文字的元素
    let sibling = burger.nextElementSibling as HTMLElement | null;
    while (sibling) {
      if ((sibling.textContent || '').trim() === '首页' || sibling.querySelector(':scope > *')) {
        // 如果是包含"首页"的容器或"首页"本身
        const textEls = sibling.querySelectorAll('*');
        for (const t of Array.from(textEls) as HTMLElement[]) {
          if (t.children.length === 0 && (t.textContent || '').trim() === '首页') {
            anchorEl = t.parentElement ?? sibling;
            break;
          }
        }
        if (!anchorEl && (sibling.textContent || '').trim() === '首页') {
          anchorEl = sibling;
        }
      }
      if (anchorEl) break;
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }

    // 兜底：找不到「首页」就插在汉堡键紧后面
    if (!anchorEl) anchorEl = burger;

    const btn = document.createElement('button');
    btn.id = 'fnos-refresh-btn';
    btn.title = '刷新页面';
    btn.style.cssText = 'background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;margin-left:4px;border-radius:6px;transition:background .15s;color:var(--fnos-titlebar-icon,#666);vertical-align:middle;font-size:14px;line-height:1;position:relative;top:2px;';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14 6 6 0 1 1 8 2c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor"/></svg>';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(0,0,0,.06)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // [lc-699] 手动刷新：先即时刷新首页海报(轮播), 再整页刷新, 确保新片库立刻可见
      try { refreshCarouselPosters(); } catch { /* ignore */ }
      location.reload();
    });
    // 插入到锚点元素（「首页」或汉堡键）的后面
    anchorEl.parentNode?.insertBefore(btn, anchorEl.nextSibling);
    log('Refresh button injected after anchor (burger/首页)');
  };
  // 立即尝试 + 延迟重试(导航栏可能尚未渲染)
  injectRefreshButton();
  [1000, 3000, 6000].forEach(t => setTimeout(injectRefreshButton, t));
  // MutationObserver 兜底: SPA 切换导航重建时重新注入
  const _refreshObsTimer = 0;
  const _refreshObserver = new MutationObserver(() => {
    window.setTimeout(injectRefreshButton, 200);
  });
  _refreshObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _refreshObserver.disconnect());

  // [v323] MutationObserver兜底: 飞牛SPA路由切换/重渲染头部时, 新汉堡键DOM无hook → 立即重绑
  // (解决: 轮播图整页导航→详情页头部重建→定时重试可能错过新元素 → hook丢失 → 点击失效)
  let _burgerObsTimer = 0;
  const _burgerObserver = new MutationObserver(() => {
    clearTimeout(_burgerObsTimer);
    _burgerObsTimer = window.setTimeout(ensureBurgerVisible, 120); // 幂等: 重绑汉堡键+遮罩hook(飞牛SPA重渲染新元素时兜底)
  });
  _burgerObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _burgerObserver.disconnect());

  // 页面切换过渡(防黑屏闪烁): 一层与背景同色的轻纱, 导航瞬间覆盖→淡出, 平滑揭示新页面。
  // [lc-1017] 实现已迁至 detail/veil.ts：详情页导航改为「持罩待美化」——veil 不再按固定
  // 260ms 计时淡出，而是等 applyDetailBeautify 套用完成(releaseNavVeil)再统一揭示，
  // 消除「先看到原生页、随后一帧内整页换装」的闪一下；900ms 硬上限兜底绝不长遮。

  // [lc-153] 修复: 透明窗口下, fnOS 视图栈残留的旧页面透出下层内容(而非桌面)
  // 原理: fnOS(Emby系) SPA 路由切换会把旧页面保留在 DOM 里做"下层页面"(返回手势/转场用).
  //       我们让页面透明后, 上层剧集页的透明区就透出了下层影视页的内容.
  // 修复: 导航后隐藏视图栈里非活跃的下层页面(用非important的 display:none, 允许 fnOS 返回时恢复),
  //       让活跃页的透明区直接落到 body(桌面亚克力).
  // 启发式: 仅针对 position:absolute 且占满视口的直接兄弟(视图通常在 relative 容器内 absolute 堆叠);
  //        排除 fixed 覆盖层(抽屉/遮罩)、我们的 fnos-*/fntv-* 注入(含其子节点)、导航栏等.
  // [lc-993] 上一行"排除我们的注入"从 lc-153 起就没兑现过: 原判断只查 el.id 自身, 而注入层的子节点
  //        (.fnos-instant-layer__bg / __scrim, .fnos-detail-backdrop__img / __scrim) 一律**没有 id**
  //        → 逃过豁免 → 又因为它们是同父的两个满视口 absolute, 正好凑成下面的"视图栈"判定 → 被 display:none。
  //        真机日志实证(log/v3.5.0/app.log, 89 次 hid stacked view):
  //          82 次(92%) 打的是自己人 —— fnos-instant-layer__bg 42 次 + fnos-detail-backdrop__img 40 次;
  //          只有 7 次是它本该处理的真飞牛残留视图; 保护性 SKIP 日志 0 次。
  //        两个可见后果: ① 加载层的海报背景被打掉, 只剩灰 scrim + shimmer 骨架
  //          = 用户报的"一级详情页灰色骨架屏遮罩"(一级页从首页进入时美化永不套用, 靠 2s 兜底才淡出);
  //          ② lc-980 的全屏沉浸底图每次导航 ~400ms 后被永久打掉, 直到下次导航才重建。
  //        修法用 closest('[id^=…]'): 它会检查自身, 故一条即可替换原判断, 并把整棵注入子树一次性豁免。
  const hideStaleViews = (): void => {
    const vw = window.innerWidth, vh = window.innerHeight;

    // [lc-278] 视频播放场景保护: fnOS 播放视频时, <video> 常位于某个全屏 absolute 视图内的 fixed 全屏层。
    // 若此处隐藏该 absolute 视图(残留页), 会整棵子树 display:none → 连带视频被隐藏 → 黑屏但有声音。
    // 故: 只要页面存在 <video>(或视频播放容器), 整个 hideStaleViews 跳过; 视频全屏覆盖无需防透出。
    if (document.querySelector('video')) {
      log('hideStaleViews: SKIP — <video> present, avoid hiding video page');
      return;
    }
    // <video> 标签可能尚未插入(缓冲中): 用播放页容器 class 兜底(Emby/fnOS: .videoPlayer/.playerPage 通常先于 <video> 创建)
    if (document.querySelector('.videoPlayer, .playerPage, #videoPlayer, [data-itemtype="Video"]')) {
      log('hideStaleViews: SKIP — video container present');
      return;
    }

    const candidates: HTMLElement[] = [];
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute') continue;           // 视图是 absolute 堆叠; fixed 是覆盖层, 跳过
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.8 || rect.height < vh * 0.8) continue;
      if (el.closest('[id^="fnos-"], [id^="fntv-"]')) continue;  // [lc-993] 我们的注入层**及其全部子节点**跳过
      if (el.classList.contains('absolute')) continue;     // 抽屉遮罩类跳过
      if (el.querySelector('video')) continue;             // [lc-278] 含视频的视图绝不隐藏(双保险)
      candidates.push(el);
    }
    // 按父元素分组, 同容器内多个全屏 absolute 视为视图栈
    const byParent = new Map<HTMLElement, HTMLElement[]>();
    for (const el of candidates) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(el);
    }
    for (const [parent, views] of byParent) {
      if (views.length < 2) continue;                      // 只有一个视图无需处理
      // DOM 末尾的视图=当前活跃页, 隐藏其余(非important, fnOS 返回可恢复)
      // [lc-965] 保护真实详情内容: 若某待隐藏视图包含详情主内容([data-id="details"]/.fnos-season-2col/.card-root),
      //   且同组内"末尾视图"不含详情内容(说明它是过渡层/浮层而非活跃页), 则跳过不隐藏——
      //   否则会 display:none 掉真正的详情页 → 白屏。末尾视图也含详情内容时(详情↔详情切换)仍按原逻辑隐藏旧视图。
      const _lastHasDetail = !!views[views.length - 1].querySelector('[data-id="details"], .fnos-season-2col, .card-root');
      for (let i = 0; i < views.length - 1; i++) {
        const _v = views[i];
        if (!_lastHasDetail && _v.querySelector('[data-id="details"], .fnos-season-2col, .card-root')) {
          log('hideStaleViews: SKIP — 视图含真实详情内容, 避免白屏 | class=', _v.className.slice(0, 40));
          continue;
        }
        if (getComputedStyle(_v).display !== 'none') {
          _v.style.display = 'none';
          log('hideStaleViews: hid stacked view', i + 1, '/', views.length, '| class=', _v.className.slice(0, 40));
        }
      }
    }
  };

  // 导航时关闭抽屉(菜单项跳转/路由切换后不应残留打开的抽屉)
  const closeDrawer = () => {
    const d = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (d && d.classList.contains('drawer-open')) { animateCloseDrawer(d); log('NAV -> DRAWER CLOSED (anim)'); }
  };
  // [lc-889→lc-937→lc-939] 返回首页时强制重注入轮播。
  //   轮播详情按钮经 spaNav(pushState+手动dispatch popstate) 导航后, fnOS 视图栈可能不一致:
  //   返回首页时旧轮播可能「仍挂载却处于坏状态」(或不挂载), 旧守卫
  //   `if (S.carouselContainer && document.body.contains(S.carouselContainer) && S.carouselInited) return;`
  //   会令其永不重建 → 海报不显示(这正是"轮播按钮打开的详情返回后图片不加载"的根因;
  //   而原生链接路径 A 落地 fnOS 状态一致, 重建成功, 故正常)。
  //   现改为三级策略, 确保两条路径返回首页都能正确重建并显示横版海报(base64 data URL, 与导航无关):
  //   ② 若注入的 S.carouselWrapper 仍挂载(fnOS 缓存了含轮播的 home DOM), 直接复用它重建 —— 不依赖 findMediaLibrarySection;
  //   ③ 若 wrapper 已游离(fnOS 重渲染了 home), 移除复位后重试 findMediaLibrarySection(上限 ~1.5s), 命中即建;
  //   ④ 若 S.apiShows 为空(整页重载), 重置 S.apiLoaded 重新拉取。
  //   [lc-924→lc-932] 返回首页仅用缓存重建轮播(无网络重拉), 数据新鲜度由每 10 分钟整页重载保证。
  const ensureHomepageEnhanced = (): void => {
    if (!/^\/v\/?($|\?|#)/.test(location.pathname)) return; // 仅首页(/v)
    // [lc-946] 轮播仍健康(已挂载+已初始化)→ 直接复用, 绝不销毁重建(根治"返回首页轮播重载/海报丢失")。
    //   仅重启被 _stopCarouselOffHome 停掉的自动轮播(钩子由各样式注册到 S.carouselResume), DOM/海报原样保留。
    //   此前的 S.leftHome 强制重建是 lc-941 整页刷新根因的临时补丁, lc-941 已修复根因, 不再需要, 反而会引回"重载"。
    const healthy = !!(S.carouselContainer && document.body.contains(S.carouselContainer) && S.carouselInited);
    if (healthy) { S.leftHome = false; resumeCarousel(); return; }
    S.leftHome = false; // 本次返回/重建后复位
    // ① 清理旧 timer/listener
    try { destroyCarousel(); } catch (_) { /* ignore */ }
    // [lc-950] 零重载复用: 旧 wrapper 仍在内存(即使已脱离文档)且数据缓存可用 → 直接挂回"媒体库"section,
    //   DOM/海报/简介原样保留(图片是自包含 base64 data URL, 任意导航/重建下均有效), 仅 resume 自动轮播。
    //   彻底根治「返回首页轮播重载 + 海报图/剧集简介丢失」。
    if (S.carouselWrapper && S.apiShows.length > 0) {
      // ② wrapper 仍挂载(fnOS 缓存了含轮播的 home DOM): 直接 resume, 不销毁重建
      if (document.body.contains(S.carouselWrapper)) {
        S.carouselInited = true;
        S.carouselRevealed = true;
        resumeCarousel();
        log('[lc-950] wrapper 仍挂载, 直接 resume(零重载, 海报保留)');
        return;
      }
      // ③ wrapper 已游离(fnOS 重渲染 home 致其脱离文档): 挂回新"媒体库"section, DOM 原样复用
      const target = findMediaLibrarySection();
      if (target) {
        try {
          target.innerHTML = '';
          target.appendChild(S.carouselWrapper); // 游离 wrapper 移回新 section, 海报/简介 DOM 复用, 零网络
          S.carouselInited = true;
          S.carouselRevealed = true;
          resumeCarousel();
          log('[lc-950] 复用游离 wrapper 挂回新 section(零重载, 海报/简介保留)');
          return;
        } catch (_) { /* 挂回失败落到重建 */ }
      }
    }
    // ③' 兜底: 游离挂回失败 / 全页重载(S.carouselWrapper 已不存在) → 移除旧 wrapper 并重建(数据此前已揭示过, 跳过竖版防护)
    if (S.carouselWrapper) { try { S.carouselWrapper.remove(); } catch (_) { /* ignore */ } }
    S.carouselContainer = null;
    S.carouselWrapper = null;
    S.carouselInited = false;
    S.carouselRevealed = true; // 数据此前已揭示过, 跳过竖版防护直接重建
    // ②'' 重试注入: 返回首页时 fnOS 可能仍在(重新)渲染媒体库区块, 一次 inject 可能找不到 section;
    //   多次重试, 命中即建, 上限 ~1.5s 后仍无则放弃并告警(避免无限重试)。
    let _tries = 0;
    const rebuild = (): void => {
      _tries++;
      const target = findMediaLibrarySection();
      if (!target) {
        if (_tries <= 6) { setTimeout(rebuild, 250); return; }
        // 放弃前输出可定位的诊断, 便于真机复核 fnOS 返回首页后的真实 DOM 结构
        const heads = document.querySelectorAll('strong,h2,h3').length;
        const known = document.querySelectorAll('.relative.flex.flex-col.gap-6 > div').length;
        log('[lc-939] ensureHomepageEnhanced: 重试 6 次仍未找到媒体库区块, 放弃重建; diag headings=' + heads + ' knownLayoutDivs=' + known + ' pathname=' + location.pathname);
        return;
      }
      const diagShows = (S.apiShows || []).slice(0, 12).map((s: any) => ({ t: (s.title || '').substring(0, 8), hasBlob: !!s._backdropBlob, portrait: !!s._backdropIsPortrait, back: !!(s.backdrop) }));
      log('[lc-939] ensureHomepageEnhanced 重建前 S.apiShows.len=', S.apiShows.length, 'sample=', JSON.stringify(diagShows));
      injectCarousel(); // 用当前缓存(含 base64 data URL 横版主图), 无网络重拉
      log('ensureHomepageEnhanced: 已强制重注入轮播(返回首页不再触发 backdrop 网络重拉/刷新)');
    };
    rebuild();
    // ④ 数据兜底: 若整页重载等导致 S.apiShows 为空(无缓存), 重新拉取(内部 revealOnce 会渲染)
    if (S.apiShows.length === 0) {
      S.apiLoaded = false;      // 解除"只拉一次"守卫, 允许重拉
      S.carouselRevealed = false; // 允许 fetchShowsViaIPC 内部 revealOnce 重新渲染
      fetchShowsViaIPC(location.origin).then(() => {
        // 内部 revealOnce 处理渲染, 无需此处再 inject
      }).catch((e: any) => log('[lc-939] ensureHomepageEnhanced 重新拉取异常:', e));
    }
  };

  try {
    const _ps = history.pushState, _rs = history.replaceState;
    // [lc-906] 离开首页(从轮播/列表进入详情页)时立即停掉轮播的自动播放 timer 与事件监听:
    //   此前要等 5s 看门狗才清理, 这 5s 内轮播仍在空转操作已脱离 DOM 的节点,
    //   与详情页自身的重活(两栏布局/演员 restyle)叠加, 是从"首页轮播打开二级页"卡死更明显的原因之一。
    const _stopCarouselOffHome = (newHref: string | undefined): void => {
      const h = newHref || location.href;
      let p = '';
      try { p = new URL(h, location.origin).pathname; } catch (_) { p = location.pathname; }
      if (p === '/v' || p === '/v/') return;
      try { destroyCarousel(); } catch (_) { /* ignore */ }
    };
    (history as any).pushState = function (...a: any[]) {
      const prevPath = location.pathname;
      const newHref = (a && a.length >= 3 && typeof a[2] === 'string') ? a[2] : location.href;
      _ps.apply(this, a as any);
      logNav('pushState');
      // [lc-937] 标记「离开过首页」: pushState 执行前 location 仍是旧路径; 旧路径是 /v 而新路径不是 → 离开首页。
      //   返回首页时据此强制干净重建轮播(修复「轮播按钮 spaNav 打开详情页返回后海报不显示」)。
      //   仅当 newHref 非空(空 url 表示沿用当前路径, 不算离开)才判定。
      if ((prevPath === '/v' || prevPath === '/v/') && newHref) {
        const np = newHref.indexOf('?') >= 0 ? newHref.split('?')[0] : newHref;
        if (np !== '/v' && np !== '/v/') S.leftHome = true;
      }
      runPageTransition(isDetailPage()); setTimeout(ensureBurgerVisible, 300); setTimeout(closeDrawer, 300); setTimeout(hideStaleViews, 400); setTimeout(ensureHomepageEnhanced, 350); _stopCarouselOffHome(newHref); _scheduleTopLeftAfterNav();
      applyDetailBeautify(); // [lc-980] 详情页美化：进详情铺加载层+一次性 observer 等 hero；非详情/关闭则 teardown
      scheduleEpBackfill(); // [lc-1045] 季页「选集」TMDB 回填按钮：非季页自撤
    };
    (history as any).replaceState = function (...a: any[]) {
      const prevPath = location.pathname;
      const newHref = (a && a.length >= 3 && typeof a[2] === 'string') ? a[2] : location.href;
      _rs.apply(this, a as any);
      logNav('replaceState');
      // [lc-937] 同 pushState: 离开首页时标记 S.leftHome(空 url 不算离开)
      if ((prevPath === '/v' || prevPath === '/v/') && newHref) {
        const np = newHref.indexOf('?') >= 0 ? newHref.split('?')[0] : newHref;
        if (np !== '/v' && np !== '/v/') S.leftHome = true;
      }
      runPageTransition(isDetailPage()); setTimeout(closeDrawer, 300); setTimeout(hideStaleViews, 400); setTimeout(ensureHomepageEnhanced, 350); _stopCarouselOffHome(newHref); _scheduleTopLeftAfterNav();
      applyDetailBeautify(); // [lc-980] 同 pushState
      scheduleEpBackfill(); // [lc-1045] 同 pushState
    };
    window.addEventListener('popstate', () => {
      logNav('popstate');
      runPageTransition(isDetailPage());
      setTimeout(ensureBurgerVisible, 300);
      setTimeout(closeDrawer, 300);
      setTimeout(hideStaleViews, 400);
      _scheduleTopLeftAfterNav(); // [lc-925] 背景换了 → 重采样左上角图标亮度
      setTimeout(ensureHomepageEnhanced, 350); // [lc-889] 返回首页强制重注入轮播
      applyDetailBeautify(); // [lc-980] 前进/后退到详情页也套美化；退回首页则 teardown
      scheduleEpBackfill(); // [lc-1045] 同 popstate
    });
    window.addEventListener('hashchange', () => logNav('hashchange'));
    setTimeout(hideStaleViews, 1500); // 初始/深链到详情页时也清理一次
  } catch (e) { log('NAV hook err', String(e).substring(0, 60)); }


  // [lc-980] 详情页美化重写：初始/深链直达详情页时也套一次(内部三闸判定, hero 未就绪则 arm 一次性 observer)。
  //   backfillDetailLogo 属轮播 logo 功能, 与美化正交, 保留。
  if (isDetailPage()) {
    backfillDetailLogo();
    applyDetailBeautify();
    scheduleEpBackfill(); // [lc-1045] 初始/深链直达季页也挂「选集」回填按钮
    // 延迟重试: SPA渲染可能分批加载DOM
    [600, 1500, 3000].forEach(ms => setTimeout(() => { backfillDetailLogo(); scheduleEpBackfill(); }, ms));
  }
  // MutationObserver 覆盖详情页DOM变化 → 回填 Logo + [lc-1045] React 重渲染冲掉按钮时补挂
  let _detailGlassTimer = 0;
  const _detailObs = new MutationObserver(() => {
    clearTimeout(_detailGlassTimer);
    _detailGlassTimer = window.setTimeout(() => {
      if (isDetailPage()) { backfillDetailLogo(); ensureEpFixButton(); }
    }, 200);
  });
  _detailObs.observe(document.body, { childList: true, subtree: true });

  // 1) 首屏: 立即注入(数据未到显示骨架占位)
  injectCarousel();

  // 2) 异步: 用已知剧集GUID反查库GUID→item/list→动态数据
  // [lc-625] 不再无条件重建: fetchShowsViaIPC 内部(lc-624)详情就绪→revealOnce 统一渲染。
  //   ⚠️ 此 .then 在 fetchShowsViaIPC 同步返回后立即执行(不等详情), 若用 !S.carouselInited 判断
  //   必为 true(此时 revealOnce 还没跑) → 会用未补详情的竖版数据直接渲染 → 进度条 20% 就出图!
  //   修复: 仅当 S.carouselRevealed(内部已渲染完成) 才允许兜底重建; 未完成则交给内部 revealOnce。
  fetchShowsViaIPC(base).then(() => {
    if (S.apiShows.length === 0) { log('API empty'); return; }
    log('got', S.apiShows.length, 'shows from API (carousel revealed by fetchShowsViaIPC)');
    if (!S.carouselInited && S.carouselRevealed) { S.carouselInited = false; injectCarousel(); }
  }).catch((e: any) => log('fetch error:', e));

  // 3) 定时自动刷新轮播内容(无需退出重开):
  //    库数据变化(新增/改名/排序)后, 留在首页即可看到最新轮播。
  //    仅在轮播当前可见(处于首页)时重拉, 避免后台无意义 iframe 轮询;
  //    非首页时安全跳过(注入逻辑找不到"媒体库"节点会自动 return)。
  //    [lc-699] 抽成 refreshCarouselPosters() 供"自动定时"与"手动刷新按钮"共用;
  //    间隔由 5 分钟改为 10 分钟(启动软件后每 10 分钟刷一次首页海报)。
  function refreshCarouselPosters(): void {
    if (S.apiLoading) return;
    if (document.hidden) return; // 后台标签页跳过(iframe/fetch 会被浏览器节流, 必然失败/超时)
    if (!S.carouselContainer || !document.body.contains(S.carouselContainer)) return; // 仅首页可见时刷新
    S.apiLoaded = false; // 解除"只拉一次"守卫, 允许重拉
    S.carouselRevealed = false; // [lc-625] 允许自动刷新后内部 revealOnce 重新渲染
    const base = location.origin;
    log('carousel refresh: re-fetching');
    fetchShowsViaIPC(base).then(() => {
      if (S.apiShows.length === 0) return;
      log('carousel refresh: got', S.apiShows.length, 'shows');
      // [lc-625] 兜底: 内部 revealOnce 已渲染则跳过(自动刷新时 S.carouselRevealed 已重置为 false,
      //   内部会重新渲染; 此处仅防内部异常未渲染时的兜底)
      if (!S.carouselInited && S.carouselRevealed) { S.carouselInited = false; injectCarousel(); }
    }).catch((e: any) => log('carousel refresh error:', e));
  }
  const CAROUSEL_REFRESH_MS = 10 * 60 * 1000;
  setInterval(refreshCarouselPosters, CAROUSEL_REFRESH_MS);

  // [lc-932] 启动软件后每 10 分钟整页重载一次(取代"返回首页时重拉轮播"的旧行为):
  //   后台隐藏页 / 正在播放视频时跳过, 避免无意义重载或打断播放。
  const AUTO_RELOAD_MS = 10 * 60 * 1000;
  setInterval(() => {
    if (document.hidden) return;                         // 后台标签页跳过
    const vid = document.querySelector('video');
    if (vid && !(vid as HTMLVideoElement).paused) return; // 正在播放视频时不重载
    log('[lc-932] 定时整页重载(每 10 分钟)');
    try { location.reload(); } catch (_) { /* ignore */ }
  }, AUTO_RELOAD_MS);

  wheelToScroll();
  [2000, 4000, 8000].forEach(ms => setTimeout(wheelToScroll, ms));

  // [lc-906] 轮播只属于首页: 进入详情页/其他页面后, 下方 observer 与 watchdog 曾继续为"丢失的轮播"
  //   反复调用 injectCarousel(每次都会先 destroyCarousel 再被路径守卫挡回), 与详情页自身的重活叠加,
  //   是从"首页轮播图打开二级详情页"这条路径才卡死、从剧集列表进入却正常的关键差异。
  //   非首页一律跳过轮播重建(回到首页时 pushState/popstate 钩子会重新注入)。
  const _isHomePath = (): boolean => { const p = location.pathname; return p === '/v' || p === '/v/'; };

  let _wtsTimer = 0;
  new MutationObserver(() => {
    clearTimeout(_wtsTimer);
    _wtsTimer = window.setTimeout(wheelToScroll, 350);
    if (!_isHomePath()) return; // [lc-906] 非首页: 不做任何轮播重建, 只保留横滑滚轮
    if (S.carouselContainer && !document.body.contains(S.carouselContainer)) {
      log('carousel lost, re-inject');
      destroyCarousel(); // [lc-876] 清理旧timer/listener再重建
      S.carouselContainer = null;
      S.carouselInited = false;
    }
    // [lc-623] 数据已到达但未 reveal(详情补完流程进行中)时不抢先渲染——
    // 否则 MutationObserver 会用竖版 backdrop 渲染一次, 之后 revealOnce 再渲染横版
    // → '先竖版后横版'闪屏。只有骨架阶段(S.apiShows 空)或已 reveal 后才允许注入。
    if (!S.carouselInited && !(S.apiLoaded && !S.carouselRevealed)) injectCarousel();
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    wheelToScroll();
    if (!_isHomePath()) return; // [lc-906] 同上: 非首页不折腾轮播
    if (S.carouselContainer && !document.body.contains(S.carouselContainer)) {
      log('watchdog: carousel lost');
      destroyCarousel(); // [lc-876] 清理旧timer/listener
      S.carouselContainer = null;
      S.carouselInited = false;
      injectCarousel();
    }
  }, 5000);

  // [lc-935][DIAG] 暴露内部状态到 window, 便于 DevTools 控制台直接检查(无需改源码)
  (window as any)._fntvDiag = {
    get apiShows() { return S.apiShows; },
    get apiLoaded() { return S.apiLoaded; },
    get carouselInited() { return S.carouselInited; },
    get carouselRevealed() { return S.carouselRevealed; },
    get carouselContainer() { return S.carouselContainer; },
    get leftHome() { return S.leftHome; },
    get onHome() { return /^\/v\/?($|\?|#)/.test(location.pathname); },
    get carouselWrapper() { return S.carouselWrapper; },
    get mediaLibrarySectionFound() { return !!findMediaLibrarySection(); },
    // [lc-940] 手动强制重建轮播: 若复现「路径B返回首页不显示」后调用它仍修不好 → 是重建逻辑/数据问题;
    //   若调用后修好了 → 是「返回首页未触发重建」(触发器问题), 二者对症不同。
    forceRebuild: () => { try { ensureHomepageEnhanced(); return 'ok'; } catch (e) { return String(e); } },
    // [lc-940] 一键快照: 返回首页后轮播为什么没显示, 看这一份即可定位
    rebuildSnapshot: () => ({
      pathname: location.pathname,
      onHome: /^\/v\/?($|\?|#)/.test(location.pathname),
      leftHome: S.leftHome,
      apiShowsLen: (S.apiShows || []).length,
      apiShowsWithBlob: (S.apiShows || []).filter((s: any) => !!s._backdropBlob).length,
      carouselInited: S.carouselInited,
      carouselContainerAttached: !!(S.carouselContainer && document.body.contains(S.carouselContainer)),
      carouselWrapperAttached: !!(S.carouselWrapper && document.body.contains(S.carouselWrapper)),
      mediaLibrarySectionFound: !!findMediaLibrarySection(),
      isModalOpen: isModalOpen(),
    }),
    dumpBackdropState: () => (S.apiShows || []).map((s: any) => ({
      t: (s.title || '').substring(0, 10),
      hasBlob: !!s._backdropBlob,
      blobHead: (s._backdropBlob || '').substring(0, 50),
      portrait: !!s._backdropIsPortrait,
      hasBack: !!s.backdrop,
      backHead: (s.backdrop || '').substring(0, 50),
    })),
    // [lc-984] 清晰度胶囊诊断: 标题后没出现胶囊时跑它, 看原生角标是否被文本启发式命中、标题 p 是谁
    epResolution: () => epResolutionDiag(),
  };
  log('[lc-940][DIAG] window._fntvDiag 已暴露, 使用: _fntvDiag.rebuildSnapshot() / _fntvDiag.dumpBackdropState()');

  // [lc-279] 播放页打标: 页面存在 <video> 时给 <html> 加 fnos-video-active,
  // 使 mainwin.ts 注入的 ACRYLIC_CSS 中 lc-179 的 modal 例外规则(白底 #fff/#2b2a33)在播放页整体失效,
  // 恢复 fnOS 播放器浮层原生深色玻璃(根治右下角按钮弹窗全白);
  // 非播放页(系统弹窗如创建媒体库)保留该规则, 继续修复"遮罩透出首页轮播图"。
  const _syncVideoActiveClass = (): void => {
    const hasVideo = !!document.querySelector('video');
    document.documentElement.classList.toggle('fnos-video-active', hasVideo);
  };
  _syncVideoActiveClass();
  setInterval(_syncVideoActiveClass, 1000);

  // [lc-302c] 历史: 弹窗内 .ms-container 曾被布局守护(lc-190 fixDetailLayoutWidth)误强加
  //   min-width:1057px !important(此前误判为 fnOS 滚动库运行时写入)。该布局守护已于 [lc-406] 整体删除,
  //   故此处不再需要对抗式 MutationObserver; mainwin.ts 的 ACRYLIC_CSS ⑭ 仍保留作为 class 级兜底。
}

// [lc-406] 布局守护(fixDetailLayoutWidth 函数及其 IIFE 调用点)已整体删除:
//   列表页居中布局来自用户自有设计(injectCarousel/主题注入), 与该守护无关;
//   且该守护曾因 IIFE 在 document.body 为 null 时 observe() 抛错而中断 preload 初始化(见 lc-404 根因).
//   删除后此处不再有任何模块级副作用代码, registerHook 稳定执行即可.
registerHook(HookType.OnReady, handle);

// ===== 已迁移到 ./embyWall/modals/feedback.ts（[恢复v381] 反馈弹窗） =====
