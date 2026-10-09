import { ABOUT_LINK_URL, openFeedbackChoiceModal } from './embyWall/modals/feedback';
import { UiThemeMode, applyUiTheme, getEffectiveDark, getUiTheme, injectUiThemeStyle, removeThemeModeSetting, setUiTheme } from './embyWall/theme';
import { applyCarouselLogoNow, backfillDetailLogo } from './embyWall/carousel/logo';
import { buildCard as buildCustomLogoCard, refreshCard as refreshCustomLogoCard } from './customLogo';
import { applyLoginBgVar } from './embyWall/login';
import { destroyCarousel, findMediaLibrarySection, injectCarousel, isModalOpen, resumeCarousel } from './embyWall/carousel/render';
import { fntvOpenPatchApplyPopup } from './embyWall/modals/patch';
import { buildStatsCard, buildFeedbackBody } from './embyWall/modals/telemetry'; // [v1.12.0] 匿名使用统计卡（关于页）
import { injectVideoPreviewExternalPlay } from './embyWall/nav/inject';
import { isDetailPage } from './embyWall/detail/glass';
import { applyDetailBeautify, teardownDetailBeautify } from './embyWall/detail/immersive';
import { scheduleEpBackfill, ensureEpFixButton } from './embyWall/detail/epBackfill';
import { ensureVirtualBandFix } from './embyWall/detail/virtualBand';
import { scheduleCustomScraperButton } from './embyWall/detail/customScraper';
import { scheduleJavButton } from './embyWall/detail/jav';
import { scheduleFolderScraperButton } from './embyWall/detail/folderScraper';
import { applyPageBg } from './embyWall/pageBg';
import { runPageTransition } from './embyWall/detail/veil';
import { epResolutionDiag } from './embyWall/detail/epResolution';
import { wheelToScroll } from './embyWall/nav/scroll';
import { fetchShowsViaIPC, setOnShowsReady } from './embyWall/carousel/api';
import { armBootCover } from './embyWall/carousel/bootCover'; // [lc-066] 极简进度条遮罩（防原生页裸奔，无骨架布局）

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
import { isFntvTvPage, pagePath, pagePathOf, navToTvPage } from '../core/pageMode';
import { getLang, setLang, t } from '../core/i18n'; // [lc-1065] 设置面板语言切换
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
      /* [lc-1099] 选择器必须带伪元素: * 不匹配 ::before/::after, 面板/弹窗光泽扫过与骨架 shimmer 全在伪元素上 */
      'html.fnos-perf *,html.fnos-perf *::before,html.fnos-perf *::after{',
      '  animation-duration:.01ms!important;',
      '  animation-iteration-count:1!important;',
      '  animation-delay:0ms!important;',
      '  transition-duration:.01ms!important;',
      '  transition-delay:0ms!important;',
      '  scroll-behavior:auto!important;',
      '}',
      /* body 亚克力(mainwin .fnos-tv-page body, 特异性 0,1,1)必须被稳定压过, 故单列高特异性规则 */
      'html.fnos-perf *,html.fnos-perf *::before,html.fnos-perf *::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'html.fnos-perf .fnos-tv-page body{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      /* 详情页全屏底图: 保留低透画面但去掉 52px 大模糊(常驻合成器大头) */
      'html.fnos-perf .fnos-detail-backdrop__img{filter:none!important}',
      /* [lc-1017] 性能模式同时掐掉底图交叉淡换/整层淡出过渡, 保持零合成开销 */
      'html.fnos-perf .fnos-detail-backdrop__img,html.fnos-perf .fnos-detail-backdrop{transition:none!important}',
      /* [lc-1099] 首页轮播保留基本切换动画: 四种样式的切换层开 .4s 过渡例外(特异度 0,2,1 压过总闸 0,1,1);
         Ken Burns 底图缩放/信息区 stagger/进度回缩弹跳仍被总闸压掉(animationend 照触发, 状态机不卡死) */
      'html.fnos-perf .fntv-s1-track,html.fnos-perf .fnos-slide-item,html.fnos-perf .fntv-s3-card,html.fnos-perf .fntv-s4-card{',
      '  transition-duration:.4s!important;',
      '  transition-delay:0ms!important;',
      '}',
      /* [lc-1079] 性能模式关掉磨砂(backdrop-filter)后, 页面赖以可读的磨砂没了, 若底色本身透明就整页全透:
         玻璃「背景层:无」(data-fntv-glass-bg=none)时 body 被 glassUI 清成 transparent(透桌面语义),
         非玻璃低透明度(--fnos-alpha 拖到 0)时 body 也近乎透明 —— 二者在磨砂被关后都=全透。
         性能模式补不透明底色: 玻璃模式画在 html 上(特异度高于 glassUI 的 html 0.003 底), 透明 body 之下即有底,
         且 bg=fluid 时 body 的流体渐变仍叠在该底之上不受影响; 非玻璃直接给 body 实底(明暗双套)。 */
      'html.fnos-perf[data-fntv-glass].fnos-tv-page{',
      '  background:var(--fntv-amb-base,#eef0f7)!important;',
      '  background-color:var(--fntv-amb-base,#eef0f7)!important;',
      '}',
      'html.fnos-perf:not([data-fntv-glass]).fnos-tv-page body{',
      '  background:#f6f8fd!important;',
      '  background-color:#f6f8fd!important;',
      '}',
      'html.fnos-perf:not([data-fntv-glass]).dark.fnos-tv-page body{',
      '  background:#140f21!important;',
      '  background-color:#140f21!important;',
      '}',
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
  let _lastPath = pagePath();
  const _tvClassTimer = window.setInterval(() => {
    if (pagePath() !== _lastPath) {
      _lastPath = pagePath();
      syncTvPageClass();
      log('[TV类同步]', location.pathname, 'isTv=', isFntvTvPage());
    }
  }, 400);
  window.addEventListener('beforeunload', () => window.clearInterval(_tvClassTimer));

  // [飞牛影视特化 v0.13.0] 非影视页（原生系统页）零注入：旧的「切换系统页面 → 返回影视」整套机制
  //   已随「切换系统页面」按钮删除而废弃——原生页不再注入任何 Fntv-Plus 元素（返回影视/外部播放
  //   浮动按钮删除，其 IPC 在网页端本就是 no-op），覆盖更新后打开影视不再闪现原生页残留。
  if (!isFntvTvPage()) return;

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
      // [lc-1078] 自建 UI(data-fnos-ui, 与 _whitewashCheck 豁免同源)跳过清底:
      //   播放选择弹窗的全屏遮罩自带不透明深靛渐变, 被清成 transparent 后整页不再压暗,
      //   且插入瞬间被 ACRYLIC_CSS 刷的白底会直接透给用户(整屏白闪). 圆角/clip 仍保留.
      if (el.dataset.fnosUi !== '1') {
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
      // [lc-1099] blur 值走变量: inline !important 压过一切样式表, 性能模式只能靠 --fnos-sb-bf:none 在计算期关掉
      panel.style.setProperty('backdrop-filter', 'var(--fnos-sb-bf)', 'important');
      panel.style.setProperty('-webkit-backdrop-filter', 'var(--fnos-sb-bf)', 'important');
      panel.style.setProperty('border-right', 'var(--fnos-sidebar-border)', 'important');
      panel.style.setProperty('box-shadow', 'var(--fnos-sidebar-shadow)', 'important');
      // [v0.98.0] 常驻过渡（含 backdrop-filter）：开启渐显模糊 / 关闭随滑出渐隐（不再瞬消）
      panel.style.setProperty('transition', 'transform .34s cubic-bezier(.22,1,.36,1), opacity .3s ease, backdrop-filter .3s ease', 'important');
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
    drawer.style.setProperty('backdrop-filter', 'var(--fnos-drawer-bf)', 'important');
      drawer.style.setProperty('-webkit-backdrop-filter', 'var(--fnos-drawer-bf)', 'important');
  }

  /** [lc-360] 构造"亚克力透明度/模糊"调节滑块组(纯 DOM, 可复用于设置面板"外观"标签页)
   *  - 透明度滑块(0~100): 值越大越透(桌面透出越多). 反向映射到 body 背景 alpha(0.95→0.05)
   *  - 模糊滑块(0~100px): 调节 backdrop-filter 模糊强度
   *  - 写入 localStorage, 重启后仍生效 */
  // [lc-980] 「剧集详情页美化」外观开关引用: 在 buildAppearanceControls 内创建,
  //   设置回填(seg('switches'))在持久化设置异步 resolve 后据此同步勾选态并重绘。
  let _beautifyToggle: HTMLInputElement | null = null;
  let _beautifyPaint: (() => void) | null = null;

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
    // [飞牛影视特化 v0.8.0] 侧边栏左下角「切换系统页面」（切换NAS界面）按钮已按需移除；
    //  523/529 行的历史 id 守卫无副作用保留。侧栏容器现在只有：设置 → 软件反馈建议。

    if (ctrl.querySelector('#fnos-settings-btn')) return; // 幂等

    const btn = document.createElement('button');
    btn.id = 'fnos-settings-btn';
    btn.type = 'button';
    btn.textContent = '⚙';
    // [v1.2.4] 文字包 span：收起态由 CSS 只藏文字留图标（图标仍可点，不再只剩一条孤标志）
    {
      const _sbTxt = document.createElement('span');
      _sbTxt.className = 'fnos-sb-btn-text';
      _sbTxt.textContent = ' 设置';
      btn.appendChild(_sbTxt);
    }
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
      fbChoiceBtn.textContent = '💬';
      // [v1.2.4] 文字包 span：收起态只留图标（与设置按钮同款）
      {
        const _fbTxt = document.createElement('span');
        _fbTxt.className = 'fnos-sb-btn-text';
        _fbTxt.textContent = '软件反馈建议';
        fbChoiceBtn.appendChild(_fbTxt);
      }
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

    // [v1.2.1] 折叠开关（容器最顶部）：我们的按钮组有时会遮挡侧边栏分类列表。
    //   prepend 放在所有按钮/版本号就位之后 → 保证折叠条始终位于容器最顶部。
    //   [v1.2.4] 收起态不再全藏——按钮缩成图标行（文字由 CSS 藏），版本号隐藏。
    //   [v1.2.5] 收起态一行四等分（⚙/🕐/💬/▾），默认收起（未存过偏好时收起，显式点过才记忆）。
    //   [v1.2.9] 收起态三功能按钮一行；折叠钮不占格——独立小箭头钮浮在容器内顶部居中。
    //   [v1.3.4] 用户反馈三连改：①箭头方向按「指向点击后的动作」——收起态显示 ▴（点击=向上展开）、
    //   展开态显示 收起 ▾（点击=向下收起），v1.2.9 正好写反；②折叠箭头**不要框**（去底色/边框/阴影）；
    //   ③三个功能按钮改 1:1 正方形（40px，不追求撑满行宽，一行居中）。
    if (!document.getElementById('fntv-sb-fold-style')) {
      const foldStyle = document.createElement('style');
      foldStyle.id = 'fntv-sb-fold-style';
      foldStyle.textContent = [
        '#fnos-sb-toggle { display:flex;align-items:center;justify-content:center;gap:6px;padding:6px;'
          + 'cursor:pointer;border-radius:12px;color:rgba(255,255,255,.75);font-size:11px;font-weight:600;'
          + 'letter-spacing:.5px;transition:background .15s,color .15s,filter .15s; }',
        '#fnos-sb-toggle:hover { background: rgba(255,255,255,.10); color: #fff; }',
        /* [v1.2.9→v1.3.4] 收起态：三功能按钮(⚙/🕐/💬)改 40px 正方形(1:1)一行居中，不再三等分撑满；
         * 折叠钮不占格、无框（去底色/边框/阴影），独立浮在按钮上方居中 */
        '#fnos-sidebar-actions.fnos-sb-collapsed { flex-direction:row !important; align-items:center !important;'
          + 'justify-content:center !important; gap:10px !important; padding:32px 10px 10px !important; }',
        '#fnos-sidebar-actions.fnos-sb-collapsed > button { flex:0 0 auto !important; width:40px !important; height:40px !important;'
          + 'min-width:0 !important; padding:0 !important; box-sizing:border-box !important; display:flex !important;'
          + 'align-items:center !important; justify-content:center !important; font-size:16px !important; }',
        '#fnos-sidebar-actions.fnos-sb-collapsed .fnos-sb-btn-text { display:none !important; }',
        '#fnos-sidebar-actions.fnos-sb-collapsed > #fnos-sidebar-version { display:none !important; }',
        /* 折叠钮：容器内顶部居中的小箭头（top:7px + 高 20px < padding-top 32px，与三按钮不重叠；
         * absolute 相对 sticky 容器定位，不出容器 → 不会被面板 overflow 裁掉）。
         * [v1.3.4] 用户明确不要框：去 btn-bg 底色/边框/阴影，只留箭头字符本体。 */
        '#fnos-sidebar-actions.fnos-sb-collapsed > #fnos-sb-toggle { position:absolute !important; top:7px !important;'
          + 'left:50% !important; transform:translateX(-50%) !important; width:auto !important; min-width:28px !important;'
          + 'height:20px !important; padding:0 6px !important; display:flex !important; align-items:center !important;'
          + 'justify-content:center !important; font-size:13px !important; font-weight:700 !important; line-height:1 !important;'
          + 'background:transparent !important; border:none !important; box-shadow:none !important;'
          + 'color:rgba(255,255,255,.85)!important; border-radius:8px !important; }',
        '#fnos-sidebar-actions.fnos-sb-collapsed > #fnos-sb-toggle:hover { color:#fff !important; background:transparent !important; filter:none !important; }',
      ].join(String.fromCharCode(10));
      (document.head || document.documentElement).appendChild(foldStyle);
    }
    const sbFoldRow = document.createElement('div');
    sbFoldRow.id = 'fnos-sb-toggle';
    const paintSbFold = (): void => {
      const collapsed = localStorage.getItem('fnos-sidebar-collapsed') !== '0'; // [v1.2.5] 默认收起
      ctrl.classList.toggle('fnos-sb-collapsed', collapsed);
      // [v1.3.4] 箭头指向点击后的动作：收起态→▴（点击向上展开）；展开态→收起 ▾（点击向下收起）。
      // v1.2.9 写反了（收起态显示 ▾），用户截图纠正。
      sbFoldRow.textContent = collapsed ? '▴' : '收起 ▾';
      sbFoldRow.title = collapsed ? '展开' : '收起';
    };
    sbFoldRow.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      // [v1.2.9] 按当前态取反并持久化（与 paintSbFold 判据同源）：用户显式点过即记住，刷新/重开保持
      const cur = localStorage.getItem('fnos-sidebar-collapsed') !== '0';
      try { localStorage.setItem('fnos-sidebar-collapsed', cur ? '0' : '1'); } catch (_) {}
      paintSbFold();
    });
    ctrl.prepend(sbFoldRow);
    paintSbFold();

    // [网页端] 面板构建失败不能静默：否则侧栏「设置」按钮可见但点击无任何反应，
    //   排查成本极高。这里显式捕获并 console.error（diag 会回传 client.log，实时日志可见）。
    try {
      buildSettingsPanel();
    } catch (e) {
      console.error('[fntv-web] buildSettingsPanel failed', e);
    }
  }


  /** [新] 创建设置面板(挂到 body, 打开时定位到侧栏区域)
   *  设计原则: 固定宽度不撑栏(340px)、高对比度文字、紧凑分组、可扩展 */
  function buildSettingsPanel(): void {
    if (document.getElementById('fnos-settings-panel')) return;

    // 通用小按钮(用于操作行/MPV路径等)
    const mkBtn = (text: string, small = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(text);
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
        const ttl = document.createElement('div');
        ttl.textContent = t(titleText);
        ttl.style.cssText = 'font-size:11.5px;font-weight:600;letter-spacing:.4px;'
          + 'color:var(--fnos-ui-sec);padding:12px 14px 0;flex:none;';
        d.appendChild(ttl);
      }

      // 内容容器
      const body = document.createElement('div');
      body.style.cssText = 'padding:8px 12px 12px;flex:1 1 auto;display:flex;flex-direction:column;';
      d.appendChild(body);
      // [lc-1065] 搜索索引标记: 行走查按此识别内容容器(分组标题不参与匹配)
      body.dataset.secBody = '1';
      return { el: d, body };
    };

    // [lc-1102] 卡内折叠区（外观沿用调试卡「组件日志」折叠范式：▸ caret + display:none + hover 底色）。
    //   data-fold / data-fold-body 是给设置搜索走查用的标记：折叠态下的行也要能搜到、
    //   点搜索结果直达时靠 wrapper 上的 setOpen 先展开再滚动（见 runSearch）。
    const mkFold = (labelText: string): { fold: HTMLDivElement; body: HTMLDivElement; setOpen: (v: boolean) => void } => {
      const fold = document.createElement('div');
      fold.style.cssText = 'display:flex;flex-direction:column;';
      fold.dataset.fold = '1';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--fnos-ui-muted);'
        + 'font-size:11.5px;padding:5px 6px;border-radius:6px;user-select:none;transition:background .12s;';
      header.onmouseenter = () => { header.style.background = 'var(--fnos-ui-row-hover)'; };
      header.onmouseleave = () => { header.style.background = 'transparent'; };
      const caret = document.createElement('span');
      caret.textContent = '▸';
      caret.style.cssText = 'display:inline-block;transition:transform .12s;font-size:10px;flex:none;';
      const hlabel = document.createElement('span');
      hlabel.textContent = t(labelText);
      header.appendChild(caret); header.appendChild(hlabel);

      const body = document.createElement('div');
      body.style.cssText = 'display:none;padding:0 0 2px 13px;';
      body.dataset.foldBody = '1';

      const setOpen = (v: boolean): void => {
        body.style.display = v ? 'block' : 'none';
        caret.style.transform = v ? 'rotate(90deg)' : 'rotate(0deg)';
      };
      header.addEventListener('click', () => setOpen(body.style.display === 'none'));
      fold.appendChild(header); fold.appendChild(body);
      (fold as any).__setOpen = setOpen;
      return { fold, body, setOpen };
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
        //   修=仅在 #fnos-settings-panel 作用域重定义文字色变量, CSS 变量按计算值实时解析,
        //   已打开的面板与后注入的卡片(手柄/插件卡)同样生效; 面板外全部自建 UI 零影响。
        // [lc-1098] 拆两档(底见 --fnos-ui-panel-surface): 性能模式不透明底沿用 lc-1044 原值;
        //   默认半透底的最坏情况是背后糊壁纸偏暗(浅)/偏亮(深), 次级文字再各压/提一档:
        //   浅 sec #2f4aa8 4.7:1、muted 系 #454e69 4.6:1; 深 sec #b0c0fa 4.8:1、muted 系 #b6bfd9 4.7:1。
        + 'html.fnos-perf:not(.dark) #fnos-settings-panel{'
        + '--fnos-ui-sec:#3f5ec8;'      // 豆瓣/TMDB 数据源选中底(白字)同步 5.7:1
        + '--fnos-ui-accent:#4c63e0;'   // 导航选中底+白字/开关选中轨/重启按钮: 白字 5.0:1
        + '--fnos-ui-muted2:#5f6a8c;}'  // 插帧开关未选中态 5.3:1
        + 'html:not(.fnos-perf):not(.dark) #fnos-settings-panel{'
        + '--fnos-ui-sec:#2f4aa8;--fnos-ui-accent:#4c63e0;'
        + '--fnos-ui-muted:#454e69;--fnos-ui-muted2:#454e69;--fnos-ui-btn-text2:#454e69;}'
        + 'html:not(.fnos-perf).dark #fnos-settings-panel{'
        + '--fnos-ui-sec:#b0c0fa;--fnos-ui-accent:#4c63e0;'
        + '--fnos-ui-muted:#b6bfd9;--fnos-ui-muted2:#b6bfd9;--fnos-ui-btn-text2:#b6bfd9;}';
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
      // [lc-1097] 光泽渐变与 tint 底必须同处一条 background-image(逗号分层: 光泽在上、tint 在下)。
      //   原写法 background:var(--fnos-ui-panel-bg) 会被紧随的 background-image 整条覆盖,
      //   面板实际表面≈全透(峰值 .06), 文字直接压在模糊壁纸上 —— 「设置面板字看不清」的真因。
      // [lc-1098] 底改用 --fnos-ui-panel-surface: 默认半透(.78, 保留磨砂观感但钉住亮度),
      //   性能模式(html.fnos-perf, 磨砂被关)自动切不透明(.96) —— 变量作用域见 theme.ts。
      + 'background-image:linear-gradient(165deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.015) 45%,rgba(255,255,255,.005) 100%),var(--fnos-ui-panel-surface)!important;'
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
    title.textContent = t('⚙ 设置');
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
    const secUX = section('界面交互');
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
      span.textContent = t(label);
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      (targetBody || _toggleHold).appendChild(row);
      return sw;
    };
    const swProxy = addToggle('下载代理', secBodyNet);
    // [飞牛影视特化 v0.6.0] 「隐藏原始播放按钮」按需移除：变量保留（回填/日志引用）但游离不显示
    const swHide = addToggle('隐藏原始播放按钮');
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
    themeLabel.textContent = t('主题模式');
    themeLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;white-space:nowrap;';
    const seg = document.createElement('div');
    seg.style.cssText = 'display:inline-flex;background:var(--fnos-ui-input-bg);border-radius:9px;padding:3px;gap:2px;flex-shrink:0;';
    const themeModes: [UiThemeMode, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
    const themeBtns: HTMLButtonElement[] = [];
    themeModes.forEach(([mode, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(text);
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



    // ===== 分组: B站弹幕（内置降级源）=====
    const secBili = section('B站弹幕');
    const secBodyBili = secBili.body;

    const biliStatus = document.createElement('div');
    biliStatus.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-warn);margin-bottom:8px;';
    secBodyBili.appendChild(biliStatus);

    // [lc-1102] 首屏只留「登录状态 + 弹幕搜索开关」，登录按钮 / 手动 Cookie / 聚合阈值收进卡内折叠区
    //   折叠区先建后挂：其中的行要按创建顺序 append 进 fold.body，而卡片里它排在开关行之后。
    const biliFold = mkFold('登录与 Cookie、聚合阈值');
    const biliFoldBody = biliFold.body;

    // 按钮行：扫码登录 / 退出登录 / 保存 Cookie（与豆瓣左半部分按钮行同款样式）
    const biliBtns = document.createElement('div');
    biliBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const scanBtn = mkBtn('扫码登录', true);
    const logoutBiliBtn = mkBtn('退出登录', true);
    const saveBiliCookieBtn = mkBtn('保存 Cookie', true);
    biliBtns.appendChild(scanBtn); biliBtns.appendChild(logoutBiliBtn); biliBtns.appendChild(saveBiliCookieBtn);
    biliFoldBody.appendChild(biliBtns);

    // 手动粘贴 Cookie（兜底：B站风控/扫码失效时用），与豆瓣左半部分 manualWrap 同款
    const biliManualWrap = document.createElement('div');
    biliManualWrap.style.cssText = 'margin-top:8px;';
    const biliManualLabel = document.createElement('div');
    biliManualLabel.textContent = t('手动粘贴 Cookie（B站风控/扫码失效时用）');
    biliManualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    biliManualWrap.appendChild(biliManualLabel);
    const biliManualTa = document.createElement('input');
    biliManualTa.type = 'text';
    biliManualTa.placeholder = t('粘贴浏览器里 B站的 Cookie 字符串（含 SESSDATA 等）');
    biliManualTa.style.cssText = 'width:100%;height:32px;font-size:10.5px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    biliManualWrap.appendChild(biliManualTa);
    biliFoldBody.appendChild(biliManualWrap);

    // [v0.86.0] 「启用 MPV B站弹幕搜索」开关已删（外部播放器残留；B站搜索开关在播放页弹幕设置里）
    secBodyBili.appendChild(biliFold.fold);

    // B站弹幕聚合阈值（单个视频弹幕 < 此值时，自动合并多个同类候选的弹幕）
    const aggRow = document.createElement('div');
    aggRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;gap:10px;';
    const aggLabel = document.createElement('span');
    aggLabel.textContent = t('弹幕聚合阈值（单视频弹幕少于此数则合并多个源）');
    aggLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:12.5px;flex:1;line-height:1.4;';
    const aggInput = document.createElement('input');
    aggInput.type = 'number';
    aggInput.min = '0';
    aggInput.step = '100';
    aggInput.placeholder = '1500';
    aggInput.style.cssText = 'width:90px;padding:5px 8px;border-radius:7px;border:1px solid var(--fnos-ui-border);'
      + 'background:var(--fnos-input-bg);color:var(--fnos-ui-text);font-size:13px;text-align:center;';
    aggRow.appendChild(aggLabel); aggRow.appendChild(aggInput);
    biliFoldBody.appendChild(aggRow);
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
    bangumiHintTop.textContent = t('填入你的 Bangumi Access Token 以启用 Bangumi 关联功能。');
    secBodyBangumi.appendChild(bangumiHintTop);

    // 单行 token 输入框
    const bangumiInput = document.createElement('input');
    bangumiInput.type = 'text';
    bangumiInput.placeholder = t('粘贴 Bangumi Access Token');
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

    // ── 最近同步状态 + 连接诊断（2026-10-03 排查「标记总是失败」：bgm.tv 被墙，面板直接展示原因）──
    const bangumiSyncLine = document.createElement('div');
    bangumiSyncLine.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;line-height:1.5;';
    bangumiSyncLine.textContent = t('最近同步：加载中…');
    secBodyBangumi.appendChild(bangumiSyncLine);

    const bangumiProbeRow = document.createElement('div');
    bangumiProbeRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;';
    const bangumiProbeBtn = mkBtn(t('测试连接'), true);
    bangumiProbeRow.appendChild(bangumiProbeBtn);
    const bangumiProbeNote = document.createElement('span');
    bangumiProbeNote.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);flex:1;line-height:1.4;';
    bangumiProbeNote.textContent = t('测网络链路(按当前代理/直连设置) + Token 是否有效');
    bangumiProbeRow.appendChild(bangumiProbeNote);
    secBodyBangumi.appendChild(bangumiProbeRow);

    const bangumiProbeOut = document.createElement('div');
    bangumiProbeOut.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:4px;line-height:1.5;display:none;';
    secBodyBangumi.appendChild(bangumiProbeOut);

    const refreshBangumiSyncLine = (): void => {
      ipcRenderer.invoke('bangumi:sync-status').then((s: any) => {
        if (!s || !s.ts) {
          bangumiSyncLine.textContent = t('最近同步：暂无记录（看过一集后这里会显示结果）');
          bangumiSyncLine.style.color = 'var(--fnos-ui-muted)';
          return;
        }
        bangumiSyncLine.textContent = t('最近同步：') + (s.ok
          ? `✓ ${s.detail || ''} · ${new Date(s.ts).toLocaleString('zh-CN')}`
          : `✗ [${s.label || '失败'}] ${s.detail || ''} · ${new Date(s.ts).toLocaleString('zh-CN')}`);
        bangumiSyncLine.style.color = s.ok ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-warn)';
      }).catch(() => { bangumiSyncLine.textContent = t('最近同步：暂无记录'); });
    };
    refreshBangumiSyncLine();

    bangumiProbeBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      bangumiProbeBtn.disabled = true;
      bangumiProbeOut.style.display = 'block';
      bangumiProbeOut.style.color = 'var(--fnos-ui-sub)';
      bangumiProbeOut.textContent = t('测试中…');
      try {
        const r: any = await ipcRenderer.invoke('bangumi:probe');
        const parts: string[] = [];
        let allOk = true;
        if (r && r.network && r.network.ok) {
          parts.push(`网络:正常(${r.network.latencyMs}ms,经${r.transport || r.network.via})`);
        } else {
          allOk = false;
          parts.push(`网络:不通(${(r && r.network && r.network.detail) || '未知'})${(r && r.network && r.network.hint) ? '——' + r.network.hint : ''}`);
        }
        if (r && r.token) {
          if (r.token.checked) {
            if (r.token.ok) parts.push('Token:有效');
            else { allOk = false; parts.push(`Token:无效(${r.token.detail})`); }
          } else {
            parts.push(`Token:${r.token.detail}`);
          }
        }
        bangumiProbeOut.textContent = parts.join('；');
        bangumiProbeOut.style.color = allOk ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-warn)';
      } catch (err: any) {
        bangumiProbeOut.textContent = t('测试失败：') + String((err && err.message) || err);
        bangumiProbeOut.style.color = 'var(--fnos-ui-warn)';
      } finally {
        bangumiProbeBtn.disabled = false;
      }
    });

    // Bangumi 集数级同步开关
    const bangumiSyncRow = document.createElement('div');
    bangumiSyncRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    bangumiSyncRow.onmouseenter = () => { bangumiSyncRow.style.background = 'var(--fnos-ui-row-hover)'; };
    bangumiSyncRow.onmouseleave = () => { bangumiSyncRow.style.background = 'transparent'; };
    const bangumiSyncLabel = document.createElement('span');
    bangumiSyncLabel.textContent = t('启用 Bangumi 集数同步');
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
    bangumiThrLabel.textContent = t('同步阈值（播放进度 %）');
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
            bangumiStatus.textContent = t('已保存 Token');
            bangumiStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            bangumiInput.value = '';
            bangumiInput.readOnly = false;
            bangumiStatus.textContent = t('已清除 Token');
            bangumiStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          bangumiStatus.textContent = t('保存失败');
          bangumiStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        bangumiStatus.textContent = t('保存失败');
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
        bangumiStatus.textContent = t('已清除 Token');
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        bangumiStatus.textContent = t('清除失败');
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
    tmdbHintTop.textContent = t('填入你的 TMDB API Key（或 v4 Read Access Token）以启用「热门剧更新」中的 TMDB 电影/剧集数据源。');
    secBodyTmdb.appendChild(tmdbHintTop);

    // 单行 key 输入框
    const tmdbInput = document.createElement('input');
    tmdbInput.type = 'text';
    tmdbInput.placeholder = t('粘贴 TMDB API Key / Read Access Token');
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
            tmdbStatus.textContent = t('已保存 TMDB Key');
            tmdbStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            tmdbInput.value = '';
            tmdbInput.readOnly = false;
            tmdbStatus.textContent = t('已清除 TMDB Key');
            tmdbStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          tmdbStatus.textContent = t('保存失败');
          tmdbStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        tmdbStatus.textContent = t('保存失败');
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
        tmdbStatus.textContent = t('已清除 TMDB Key');
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        tmdbStatus.textContent = t('清除失败');
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // ===== TMDB 免梯子直连（实验）：用固定 IP 覆盖 DNS 解析，绕过污染直连，无需梯子 =====
    // （此区块整体迁入设置面板「插件」标签页，见下方 secTmdbDirect，故此处不再挂到 TMDB Key 区）
    const dcWrap = document.createElement('div');
    dcWrap.style.cssText = 'margin-top:4px;';

    const dcDesc = document.createElement('div');
    dcDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    dcDesc.textContent = t('开启后用固定 IP 覆盖 DNS 解析，绕过污染直连 TMDB（无需梯子）。IP 来自 CheckTMDB 项目，CDN 边缘节点可能变动，可点「更新 IP」拉取最新，或手动填写。');
    dcWrap.appendChild(dcDesc);

    const dcRow = document.createElement('label');
    dcRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fnos-ui-text);cursor:pointer;margin-bottom:8px;';
    const dcToggle = document.createElement('input');
    dcToggle.type = 'checkbox';
    // [lc-1043] 原内联 width:16px;height:16px 已删：inline 压掉面板全局 iOS 开关样式
    // （38×22 轨道 + ::after 滑块），18px 滑块从 16px 轨道溢出压住「启」字（用户截图报障）。
    // 交由 #fnos-settings-panel input[type=checkbox] 统一渲染，与其余 9 处开关同款。
    const dcToggleLabel = document.createElement('span');
    dcToggleLabel.textContent = t('启用免梯子直连');
    dcRow.appendChild(dcToggle);
    dcRow.appendChild(dcToggleLabel);
    dcWrap.appendChild(dcRow);

    const dcIpGrid = document.createElement('div');
    dcIpGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    const dcApiInput = document.createElement('input');
    dcApiInput.type = 'text';
    dcApiInput.placeholder = t('api IP（如 65.8.20.79）');
    dcApiInput.style.cssText = 'width:100%;height:30px;font-size:11px;color:var(--fnos-ui-text);';
    const dcImgInput = document.createElement('input');
    dcImgInput.type = 'text';
    dcImgInput.placeholder = t('img IP（如 65.8.20.8）');
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
          dcStatus.textContent = t('保存失败');
          dcStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        dcStatus.textContent = t('保存失败');
        dcStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    dcUpdateBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      dcStatus.textContent = t('正在从 CheckTMDB 拉取最新 IP…');
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
        dcStatus.textContent = t('更新失败');
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
    dsHint.textContent = t('选择「热门剧更新」浮层的数据源。豆瓣国内直连、免 Key、零配置；TMDB 数据更全但需 Key 且可能被墙（需免梯子直连/代理）。');

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
    doubanHint.textContent = t('✓ 已选豆瓣：国内直连、免 Key、零配置，无需任何额外设置。「热门剧更新」浮层将展示豆瓣热门影视。');

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
      span.textContent = t(label);
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
    // [v0.51.0] 网页端无内嵌浏览器，扫码登录不可用 → 隐藏（shim 设置 __FNTV_WEB__ 标志）
    if ((window as any).__FNTV_WEB__) scanDoubanBtn.style.display = 'none';

    scanDoubanBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      doubanStatus.textContent = t('请在弹出的窗口中用豆瓣 App 扫码…');
      doubanStatus.style.color = 'var(--fnos-ui-sec)';
      try {
        const r: any = await ipcRenderer.invoke('douban:open-login');
        if (!r || !r.ok) doubanStatus.textContent = '打开登录窗口失败：' + ((r && r.msg) || '未知');
      } catch {
        doubanStatus.textContent = t('打开登录窗口失败');
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
    manualLabel.textContent = t('手动粘贴 Cookie（豆瓣风控/扫码失效时用）');
    manualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    manualWrap.appendChild(manualLabel);
    // [v0.51.0] 获取方法提示（网页端主打此方式）
    const manualHelp = document.createElement('div');
    manualHelp.style.cssText = 'font-size:10px;color:var(--fnos-ui-sub);line-height:1.55;margin-bottom:5px;'
      + 'background:var(--fnos-ui-input-bg);border:1px dashed var(--fnos-ui-border3);border-radius:7px;padding:6px 8px;';
    manualHelp.innerHTML = t('获取方法：电脑浏览器登录豆瓣 → 按 F12 打开开发者工具 → 网络(Network)里任选一个 movie.douban.com 请求 → 请求头里复制完整的 Cookie 值粘贴到下面（须含 dbcl2 与 ck）。手机端可先在浏览器登录豆瓣后切换「电脑版网页」再取。');
    manualWrap.appendChild(manualHelp);
    const manualTa = document.createElement('input');
    manualTa.type = 'text';
    manualTa.placeholder = t('粘贴浏览器里豆瓣的 Cookie 字符串（含 dbcl2 等）');
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
    watchedTitle.textContent = t('已观看列表 → 豆瓣「看过」');
    watchedTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--fnos-ui-text);margin-bottom:6px;';
    watchedWrap.appendChild(watchedTitle);

    const watchedStatus = document.createElement('div');
    watchedStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-bottom:6px;min-height:14px;line-height:1.5;';
    watchedStatus.textContent = t('读取飞牛「已观看」列表，批量标记到豆瓣（已标记的会跳过，不重复打）。');
    watchedWrap.appendChild(watchedStatus);

    const syncBtn = mkBtn('立即同步已观看列表', true);
    syncBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        syncBtn.setAttribute('disabled', 'true');
        watchedStatus.textContent = t('正在扫描飞牛「已观看」列表…（需加载列表页，约 10 秒）');
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
    autoLabel.textContent = t('自动同步间隔(分钟, 0=关闭):');
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
    traHint.textContent = t('把观影记录（看完的电影 / 已看的剧集集数）同步到 trakt.tv 历史。需要在 Trakt 应用管理页(trakt.tv/oauth/applications)注册应用，把 Client ID 与 Secret 填到这里，再点「连接 Trakt」完成设备授权。');
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
        traStatus.textContent = t('凭证已保存，尚未连接。');
        traStatus.style.color = 'var(--fnos-ui-sub)';
      } else {
        traStatus.textContent = t('未配置。');
        traStatus.style.color = 'var(--fnos-ui-sub)';
      }
    };

    traSaveBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const id = traIdInput.value.trim();
      const sec = traSecretInput.value.trim();
      if (!id || !sec) {
        traStatus.textContent = t('Client ID 与 Secret 均必填（清除请用「清除凭证」）。');
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
    traScrobLabel.textContent = t('实时同步播放（scrobble）');
    const traScrobSub = document.createElement('div');
    traScrobSub.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2,#5a6480);line-height:1.5;margin-top:2px;';
    traScrobSub.textContent = t('播放时实时打点到 Trakt（开始/暂停/看完≥80% 自动记录），需先连接 Trakt。');
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
      traStatus.textContent = t('正在获取设备码…');
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
        l1.textContent = t('1. 打开授权页：');
        const link = document.createElement('a');
        link.href = url; link.textContent = url; link.style.color = 'var(--fnos-ui-accent)';
        link.addEventListener('click', (ev: Event) => { ev.preventDefault(); try { require('electron').shell.openExternal(url); } catch { /* ignore */ } });
        l1.appendChild(link);
        const l2 = document.createElement('div');
        l2.textContent = t('2. 输入授权码：');
        const codeEl = document.createElement('span');
        codeEl.textContent = code;
        codeEl.style.cssText = 'font-size:15px;font-weight:700;letter-spacing:2px;color:var(--fnos-ui-text);user-select:all;cursor:pointer;margin-left:4px;';
        codeEl.title = '点击复制';
        codeEl.addEventListener('click', () => {
          try { navigator.clipboard.writeText(code); codeEl.title = '已复制'; } catch { /* ignore */ }
        });
        l2.appendChild(codeEl);
        const l3 = document.createElement('div');
        l3.textContent = t('3. 授权后本窗口自动完成连接（等待中…）');
        traCodeBox.appendChild(l1); traCodeBox.appendChild(l2); traCodeBox.appendChild(l3);
        traStatus.textContent = t('等待授权中…');
      }).catch((err) => { traStatus.textContent = '失败: ' + (err && err.message ? err.message : err); traStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    ipcRenderer.on('trakt:connected', () => {
      traCodeBox.style.display = 'none';
      traStatus.textContent = t('已连接 Trakt ✓');
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
      traSyncResult.textContent = t('同步中…（扫描媒体库并写入 Trakt，可能需要一点时间）');
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

    // ===== 弹幕屏蔽（写入 danmaku_block_types.json + 屏蔽词文件 + 弹幕文件夹管理）=====
    // [lc-215] 移除「弹幕样式」控制项（透明度/字号/描边/阴影/显示区域/同屏上限/粗体）——
    // 这些已由 MPV 底部控制栏的弹幕样式按钮管理；此处仅保留/新增「弹幕屏蔽」相关。
    // [lc-301] 标题由「B站弹幕屏蔽」改为「弹幕设置」，并新增「打开弹幕文件夹」入口。
    // [lc-1102] 弹弹play 凭证、自建弹幕接口各自独立成卡后，本卡收窄为「屏蔽与样式」，
    //   首屏只留一行提示，6 个屏蔽类型 + 屏蔽词 + 文件夹入口收进折叠区。
    const secDanmaku = section('弹幕屏蔽与样式');
    secDanmaku.el.id = 'sec-danmaku'; // [lc-199] 供控制栏按钮唤起时滚动定位
    const danBody = secDanmaku.body;
    let _danTimer: any = null;

    const danHint = document.createElement('div');
    danHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:2px 6px 4px;line-height:1.5;';
    danHint.textContent = t('「弹幕样式」（透明度/字号/描边等）请在播放页弹幕设置里调整；本卡管理 B站 弹幕的屏蔽。');
    danBody.appendChild(danHint);

    const danFold = mkFold('屏蔽类型、屏蔽词、弹幕文件夹');
    danBody.appendChild(danFold.fold);
    const danFoldBody = danFold.body;
    // [lc-199] 控制栏「弹幕样式」按钮进来的语义就是「去改屏蔽/样式」→ 该入口展开本卡折叠区
    (overlay as any)._expandDanmakuFold = (): void => danFold.setOpen(true);

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
      danFoldBody.appendChild(t.parentElement as HTMLElement);
      blockToggles.push({ key: bt.key, input: t });
    }

    danBlacklist = addTextarea('屏蔽词（每行一条，支持正则）', '', '例如：\n广告\n关注.*', pushDan);
    danFoldBody.appendChild(danBlacklist.row);

    const danFoldNote = document.createElement('div');
    danFoldNote.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:4px 6px 0;line-height:1.5;';
    danFoldNote.textContent = t('屏蔽类型与屏蔽词于下一次 B站 弹幕加载时生效。');
    danFoldBody.appendChild(danFoldNote);

    // ===== [lc-1018→v1.11.0] 弹弹play 弹幕源（内置凭证开箱即用 + 可选自定义凭证）=====
    // 历史：脚本内置共享凭证曾被弹弹play官方接口整体 403（2026-09-05 实测），当时只能靠用户自填凭证救活。
    // [v1.11.0] 已申请到正式开放平台应用，凭证加密内置进二进制（见 internal/secret）→ 默认即可用，
    // 本条链路直接在后端出弹幕（不再依赖 MPV 的 dandanplay.lua）。自定义凭证仍保留：面板填入后优先于内置，
    // 两项都填才生效；清除后回落内置。密文落盘（config.json 里看不到明文）。
    // [lc-1102] 从「弹幕屏蔽与样式」卡独立成卡：首屏只留状态行，输入与按钮收进折叠区。
    const secDandan = section('弹弹play');
    const ddBody = secDandan.body;

    // 首屏：启用开关（默认开）+ 状态行
    const ddRow = document.createElement('div');
    ddRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    ddRow.onmouseenter = () => { ddRow.style.background = 'var(--fnos-ui-row-hover)'; };
    ddRow.onmouseleave = () => { ddRow.style.background = 'transparent'; };
    const ddRowLabel = document.createElement('span');
    ddRowLabel.textContent = t('启用弹弹play 弹幕源（兜底）');
    ddRowLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swDandan = document.createElement('input');
    swDandan.type = 'checkbox';
    swDandan.checked = true;
    swDandan.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    ddRow.appendChild(ddRowLabel); ddRow.appendChild(swDandan);
    ddBody.appendChild(ddRow);
    ddRow.addEventListener('click', (e: Event) => { if (e.target !== swDandan) swDandan.click(); });

    const ddStateLine = document.createElement('div');
    ddStateLine.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);line-height:1.5;padding:0 6px 4px;';
    ddBody.appendChild(ddStateLine);

    const ddFold = mkFold('开放 API 凭证（AppId / Secret）');
    ddBody.appendChild(ddFold.fold);
    const ddFoldBody = ddFold.body;

    const ddHint = document.createElement('div');
    ddHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:0 6px 6px;line-height:1.5;';
    ddHint.textContent = t('弹弹play 为兜底源：仅当自建源与 B站 都没拿到足量弹幕时才请求，以节省开放 API 额度。本应用已内置一套正式凭证，默认即可使用（无需填写）；若你有自己的弹弹play 应用，可填入专属 AppId 与 Secret 覆盖内置凭证，两项都填才生效，清除后回落内置。凭证加密保存在 NAS 配置目录，不会明文暴露。保存后立即生效。');
    ddFoldBody.appendChild(ddHint);

    // 掩码输入（交互同 Bangumi token：已保存显示星号，聚焦自动清空进入编辑）
    const maskDd = (t: string): string => '*'.repeat(Math.max(0, t.length));
    let ddRealId = '';
    let ddHasCustomSecret = false;
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
    ddFoldBody.appendChild(ddIdInput);
    ddFoldBody.appendChild(ddSecretInput);

    const ddBtns = document.createElement('div');
    ddBtns.style.cssText = 'display:flex;gap:6px;';
    const ddSaveBtn = mkBtn('保存凭证', true);
    const ddClearBtn = mkBtn('清除凭证', true);
    const ddTestBtn = mkBtn('测试连接', true);
    ddBtns.appendChild(ddSaveBtn); ddBtns.appendChild(ddClearBtn); ddBtns.appendChild(ddTestBtn);
    ddFoldBody.appendChild(ddBtns);

    const ddStatus = document.createElement('div');
    ddStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    ddFoldBody.appendChild(ddStatus);

    // 首屏状态行 = 本卡唯一的常显信息：保存/清除/开关/回填时都要同步，否则会停在旧状态误导用户。
    // [v1.11.1] 弹弹play 已降为兜底源（开放 API 有配额），状态行需讲清「什么时候才会用到它」。
    const ddSetState = (credential: string): void => {
      if (!swDandan.checked) {
        ddStateLine.textContent = t('已关闭，弹弹play 不参与兜底（B站/自建源照常）。');
        ddStateLine.style.color = 'var(--fnos-ui-warn)';
        return;
      }
      const how = t('仅当自建源与 B站 都没拿到足量弹幕时才使用，节省额度');
      if (credential === 'custom') {
        ddStateLine.textContent = t('已启用（兜底）· 使用你填写的自定义凭证 · ') + how;
        ddStateLine.style.color = 'var(--fnos-ui-sub)';
      } else if (credential === 'builtin') {
        ddStateLine.textContent = t('已启用（兜底）· 使用应用内置凭证 · ') + how;
        ddStateLine.style.color = 'var(--fnos-ui-ok)';
      } else {
        ddStateLine.textContent = t('未启用 —— 无可用凭证，请填写自定义凭证后保存。');
        ddStateLine.style.color = 'var(--fnos-ui-warn)';
      }
    };

    // 后端为准的状态回查：凭证来源与是否配置都以 bridge 结论为准，不靠前端猜测
    const ddRefreshStatus = (): void => {
      ipcRenderer.invoke('dandanplay:status').then((r: any) => {
        if (!r) return;
        swDandan.checked = r.enabled !== false;
        // AppId 后端会下发（非密钥材料）；Secret 只回布尔，绝不回明文
        ddRealId = r.appId || '';
        ddHasCustomSecret = r.credential === 'custom' && !!r.configured;
        if (ddRealId) { ddIdInput.value = maskDd(ddRealId); ddIdInput.readOnly = true; }
        if (ddHasCustomSecret) {
          ddSecretInput.value = maskDd('00000000'); // 仅示意「已保存」，不回显真实长度
          ddSecretInput.readOnly = true;
        }
        ddSetState(String(r.credential || 'none'));
      }).catch(() => { /* 状态查询失败不阻断面板 */ });
    };
    ddRefreshStatus();

    swDandan.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-dandanplay-enabled', swDandan.checked)
        .then(() => ddRefreshStatus())
        .catch((err) => {
          ddStatus.textContent = t('保存失败') + ': ' + (err && err.message ? err.message : err);
          ddStatus.style.color = 'var(--fnos-ui-warn)';
        });
    });

    ddSaveBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const id = ddIdInput.value.trim();
      const secret = ddSecretInput.value.trim();
      if (!id || !secret) {
        ddStatus.textContent = t('AppId 与 Secret 两项都必填（清除请用「清除凭证」）。');
        ddStatus.style.color = 'var(--fnos-ui-warn)';
        return;
      }
      ipcRenderer.invoke('settings:set-dandanplay-credentials', { appId: id, appSecret: secret })
        .then(() => {
          ddRealId = id;
          ddIdInput.value = maskDd(id); ddIdInput.readOnly = true;
          ddSecretInput.value = maskDd(secret); ddSecretInput.readOnly = true;
          ddStatus.textContent = t('已保存（密文落盘），立即生效。');
          ddStatus.style.color = 'var(--fnos-ui-sub)';
          ddRefreshStatus();
        })
        .catch((err) => { ddStatus.textContent = '保存失败: ' + (err && err.message ? err.message : err); ddStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    ddClearBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:set-dandanplay-credentials', { appId: '', appSecret: '' })
        .then(() => {
          ddRealId = ''; ddHasCustomSecret = false;
          ddIdInput.value = ''; ddIdInput.readOnly = false;
          ddSecretInput.value = ''; ddSecretInput.readOnly = false;
          ddStatus.textContent = t('已清除，回落应用内置凭证。');
          ddRefreshStatus();
        })
        .catch((err) => { ddStatus.textContent = '清除失败: ' + (err && err.message ? err.message : err); ddStatus.style.color = 'var(--fnos-ui-warn)'; });
    });
    ddTestBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ddStatus.textContent = t('正在测试…');
      ddStatus.style.color = 'var(--fnos-ui-sub)';
      ipcRenderer.invoke('dandanplay:test', { keyword: '' })
        .then((r: any) => {
          if (r && r.ok) {
            const sample = Array.isArray(r.sample) && r.sample.length ? '（如 ' + r.sample.slice(0, 2).join('、') + '）' : '';
            ddStatus.textContent = t('连接正常 · {src} · {ms}ms · 命中 {n} 条 {sample}')
              .replace('{src}', String(r.credential || '')).replace('{ms}', String(r.costMs || 0))
              .replace('{n}', String(r.hits || 0)).replace('{sample}', sample);
            ddStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            ddStatus.textContent = t('连接失败：') + String((r && r.error) || t('未知错误'));
            ddStatus.style.color = 'var(--fnos-ui-warn)';
          }
        })
        .catch((err) => { ddStatus.textContent = t('测试失败') + ': ' + (err && err.message ? err.message : err); ddStatus.style.color = 'var(--fnos-ui-warn)'; });
    });

    // ===== [lc-1101] 自建弹幕接口（danmu_api，多平台聚合，弹幕优选源）=====
    // 用户在 NAS/Docker 自建 danmu_api（聚合哔哩/爱奇艺/优酷/腾讯/咪咕等），同集弹幕密度高于本应用
    // 「直连 B站 单源 + 阈值聚合」。开启后主进程 biliRunner 优先向它取弹幕，未命中/未启用自动降级回
    // 内置 B站 链路。地址存 config.json（真实请求在主进程发起），同时写 uosc_danmaku.conf 的
    // danmu_api_enabled —— 那只是 Lua 侧闸门：否则用户关掉「B站弹幕搜索」时 Lua 根本不会请求本地 shim。
    // [lc-1102] 独立成卡：首屏只留启用开关，地址与连通测试收进折叠区（开关变更时自动展开以显示回显）。
    const secDmApi = section('自建弹幕接口（danmu_api）');
    const dmApiBody = secDmApi.body;

    const dmApiRow = document.createElement('div');
    dmApiRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    dmApiRow.onmouseenter = () => { dmApiRow.style.background = 'var(--fnos-ui-row-hover)'; };
    dmApiRow.onmouseleave = () => { dmApiRow.style.background = 'transparent'; };
    const dmApiTextLabel = document.createElement('span');
    dmApiTextLabel.textContent = t('启用自建弹幕接口（优先于 B站弹幕）');
    dmApiTextLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swDanmuApi = document.createElement('input');
    swDanmuApi.type = 'checkbox';
    swDanmuApi.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    dmApiRow.appendChild(dmApiTextLabel); dmApiRow.appendChild(swDanmuApi);
    dmApiBody.appendChild(dmApiRow);
    dmApiRow.addEventListener('click', (e: Event) => { if (e.target !== swDanmuApi) swDanmuApi.click(); });

    // 状态行常显：开关就在卡片首屏，回显（含「已开启但未填地址」）不能再藏进折叠区
    const dmApiStatus = document.createElement('div');
    dmApiStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);padding:0 6px 4px;line-height:1.5;min-height:14px;white-space:pre-line;';
    dmApiBody.appendChild(dmApiStatus);

    // [v1.11.1] 弹幕下限（原「自建源弹幕下限」）：源链改为 自建源→B站→弹弹play 后，
    // 这个阈值统一决定「多少条算够用、不必再往下探更全的源」，不再只作用于自建源。
    const dmMinRow = document.createElement('div');
    dmMinRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;gap:10px;';
    const dmMinLabel = document.createElement('span');
    dmMinLabel.textContent = t('弹幕少于该条数时继续找下一个源（0=不启用）');
    dmMinLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:12.5px;flex:1;line-height:1.4;';
    const dmMinInput = document.createElement('input');
    dmMinInput.type = 'number';
    dmMinInput.min = '0';
    dmMinInput.max = '9999';
    dmMinInput.step = '1';
    dmMinInput.placeholder = '100';
    dmMinInput.style.cssText = 'width:90px;padding:5px 8px;border-radius:7px;border:1px solid var(--fnos-ui-border);'
      + 'background:var(--fnos-input-bg);color:var(--fnos-ui-text);font-size:13px;text-align:center;flex:none;';
    dmMinRow.appendChild(dmMinLabel); dmMinRow.appendChild(dmMinInput);
    dmApiBody.appendChild(dmMinRow);
    dmMinInput.addEventListener('change', () => {
      const v = parseInt(dmMinInput.value, 10);
      const n = isNaN(v) ? 0 : Math.max(0, Math.min(9999, v));
      ipcRenderer.invoke('settings:set-danmu-min-count', n).catch((err) => log('set-danmu-min-count failed', err));
    });

    const dmApiFold = mkFold('服务地址与连通测试');
    dmApiBody.appendChild(dmApiFold.fold);
    const dmApiFoldBody = dmApiFold.body;

    const dmApiHint = document.createElement('div');
    dmApiHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:0 6px 6px;line-height:1.5;';
    dmApiHint.textContent = t('填入 NAS 上部署的 danmu_api 服务地址（聚合哔哩/爱奇艺/优酷/腾讯等多平台弹幕，密度通常高于单源 B站）。可每行一条填多个地址（如家里局域网一条 + 学校 Tailscale 一条），按顺序自动选用：当前地址连不上（如节点没运行）会自动切下一个。开启后作为弹幕优选源，未命中或未启用时自动降级到内置 B站 弹幕获取。下次播放时生效。');
    dmApiFoldBody.appendChild(dmApiHint);

    // [lc-1266] 单行 input → 多行 textarea：每行一条地址，按序自动切换（不同网络环境各一条）
    const dmApiInput = document.createElement('textarea');
    dmApiInput.rows = 2;
    dmApiInput.placeholder = 'http://192.168.31.170:9321/你的TOKEN\nhttp://100.66.1.2:9321/你的TOKEN';
    dmApiInput.style.cssText = 'width:100%;height:52px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;margin:2px 0 6px;resize:vertical;line-height:1.5;';
    dmApiFoldBody.appendChild(dmApiInput);

    const dmApiBtns = document.createElement('div');
    dmApiBtns.style.cssText = 'display:flex;gap:6px;';
    const dmApiSaveBtn = mkBtn('保存', true);
    const dmApiTestBtn = mkBtn('测试连接', true);
    dmApiBtns.appendChild(dmApiSaveBtn); dmApiBtns.appendChild(dmApiTestBtn);
    dmApiFoldBody.appendChild(dmApiBtns);

    const dmApiSave = (): void => {
      // [lc-1266] 每行一条地址；主进程去重/限 4 条，danmuApiBase 存第一条
      const bases = dmApiInput.value.split(/[\n;；]/).map((s: string) => s.trim()).filter(Boolean);
      ipcRenderer.invoke('settings:set-danmu-api', { enabled: swDanmuApi.checked, base: bases[0] || '', bases })
        .then((r: any) => {
          if (r && r.ok === false) {
            dmApiStatus.textContent = String(r.error || t('保存失败'));
            dmApiStatus.style.color = 'var(--fnos-ui-warn)';
            return;
          }
          dmApiStatus.textContent = swDanmuApi.checked
            ? t('已保存并启用，下次播放时生效。')
            : t('已保存并关闭，回落内置 B站 弹幕获取。');
          dmApiStatus.style.color = 'var(--fnos-ui-sub)';
        })
        .catch((err) => { dmApiStatus.textContent = t('保存失败') + ': ' + (err && err.message ? err.message : err); dmApiStatus.style.color = 'var(--fnos-ui-warn)'; });
    };
    // 开关与「保存」走同一条路径：只拨开关不点保存会造成「看着开了其实没生效」的静默陷阱
    swDanmuApi.addEventListener('change', () => {
      // 开了但地址还空着 → 直接把要填的地方摊开，省一次「找输入框在哪」
      if (swDanmuApi.checked && !dmApiInput.value.trim()) dmApiFold.setOpen(true);
      dmApiSave();
    });
    dmApiSaveBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); dmApiSave(); });
    // [v0.80.0] 分层诊断：把「连不上」逐层归因（地址形态/DNS/TCP/TLS/服务应答），结果就地展示
    const dmApiDiagBtn = mkBtn('运行分层诊断', true);
    dmApiBtns.appendChild(dmApiDiagBtn);
    let dmApiDiagPre: HTMLElement | null = null;
    dmApiDiagBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      dmApiDiagBtn.disabled = true;
      dmApiDiagBtn.textContent = '诊断中…';
      dmApiStatus.textContent = t('正在逐层诊断（DNS/TCP/TLS/服务应答）…');
      dmApiStatus.style.color = 'var(--fnos-ui-sub)';
      try {
        const r: any = await ipcRenderer.invoke('settings:diag-danmu-api', {
          base: dmApiInput.value.trim(), timeoutMs: 8000, repeats: 3, keyword: '测试',
        });
        if (!dmApiDiagPre) {
          dmApiDiagPre = document.createElement('pre');
          dmApiDiagPre.setAttribute('data-fnos-ui', '1');
          dmApiDiagPre.style.cssText = 'font-size:10.5px;line-height:1.55;text-align:left;background:var(--fnos-ui-input-bg);'
            + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:8px 10px;max-height:220px;overflow:auto;'
            + 'white-space:pre-wrap;word-break:break-all;margin:6px 0 0;';
          dmApiFoldBody.appendChild(dmApiDiagPre);
        }
        const lines: string[] = [String(r.summary || '')];
        for (const st of (r.steps || [])) {
          const mark = st.state === 'ok' ? '✓' : st.state === 'warn' ? '⚠' : st.state === 'fail' ? '✗' : '－';
          lines.push(mark + ' ' + st.label + '（' + st.ms + 'ms）: ' + st.detail);
          if (st.hint) lines.push('   ↳ ' + st.hint);
        }
        dmApiDiagPre.textContent = lines.join('; ');
        dmApiStatus.textContent = r.summary || '诊断完成';
      } catch (err) {
        dmApiStatus.textContent = '诊断失败: ' + ((err && err.message) || err);
        dmApiStatus.style.color = 'var(--fnos-ui-warn)';
      } finally {
        dmApiDiagBtn.disabled = false;
        dmApiDiagBtn.textContent = '运行分层诊断';
      }
    });

    dmApiTestBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      dmApiStatus.textContent = t('正在测试连接…');
      dmApiStatus.style.color = 'var(--fnos-ui-sub)';
      // [lc-1266] 原样把多行文本传给主进程：逐地址测试，每条独立给 ✅/❌ 结论
      ipcRenderer.invoke('settings:test-danmu-api', dmApiInput.value)
        .then((r: any) => {
          dmApiStatus.textContent = String((r && r.message) || (r && r.ok ? t('连接正常') : t('连接失败')));
          dmApiStatus.style.color = (r && r.ok) ? 'var(--fnos-ui-sub)' : 'var(--fnos-ui-warn)';
        })
        .catch((err) => { dmApiStatus.textContent = t('连接失败') + ': ' + (err && err.message ? err.message : err); dmApiStatus.style.color = 'var(--fnos-ui-warn)'; });
    });

    // [v0.78.0] 「打开弹幕文件夹」按钮已删：那是外部播放器（MPV）的弹幕落盘目录，网页端不存在。


    // ═══ [v1.8.0] 自定义刮削服务（[lc-1250-web] 「未正式生效」占位文案与角标已按要求移除）═══
    const secScraperSvc = section('自定义刮削服务');
    const ssvBody = secScraperSvc.body;
    ssvBody.style.cssText = 'padding:14px 16px;display:flex;flex-direction:column;gap:8px;';
    const ssvDesc = document.createElement('div');
    ssvDesc.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);line-height:1.6;';
    ssvDesc.textContent = t('接入自定义刮削服务，用你自己的数据源刷新剧集标题、简介与海报等元数据。');
    ssvBody.appendChild(ssvDesc);

    // ===== 诊断信息（汇总运行态，减少"查日志"往返）=====
    const secDiag = section('诊断信息');
    const diagBody = secDiag.body;
    // [lc-1197→web] Bug 反馈 + 日志上传卡（与桌面端诊断与日志分类同款；日志由后端自动打包脱敏）
    const secFeedback = section('Bug 反馈与日志上传');
    secFeedback.body.appendChild(buildFeedbackBody());
    const diagPre = document.createElement('pre');
    diagPre.style.cssText = 'margin:0;padding:10px;background:rgba(0,0,0,.18);border-radius:8px;font-size:10.5px;'
      + 'line-height:1.55;color:var(--fnos-ui-text);white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;';
    diagPre.textContent = t('点击「刷新」加载诊断信息…');
    const diagBtns = document.createElement('div');
    diagBtns.style.cssText = 'display:flex;gap:6px;padding:8px 0 0;';
    const diagRefresh = mkBtn('刷新', true);
    const diagCopy = mkBtn('复制', true);
    diagBtns.appendChild(diagRefresh); diagBtns.appendChild(diagCopy);
    const loadDiag = async (): Promise<void> => {
      try {
        // [v1.0.0] 诊断全面对齐 web 端：数据源 = /api/status（反代/注入/版本）+ settings:get（开关全量）+ 浏览器环境。
        // 桌面字段（App 路径/mpv conf/uosc conf/登录背景路径）已随外部播放器链一并移除。
        const maskBase = (u: string): string => {
          try { const x = new URL(u); const pre = x.pathname.replace(/\/+$/, ''); return x.origin + (pre ? '/<路径前缀·已隐藏>' : ''); } catch { return '(未配置)'; }
        };
        const st: any = await fetch('/app/fntvplus/api/status', { credentials: 'include' }).then((x) => x.json()).catch(() => null);
        const s: any = await ipcRenderer.invoke('settings:get');
        const lines: string[] = [];
        lines.push('== 运行环境 ==');
        lines.push('插件版本: v' + (st && st.version ? st.version : '?') + '   Payload: ' + ((st && st.payload_hash) || '?').substring(0, 12));
        lines.push('访问入口: ' + location.origin);
        lines.push('浏览器: ' + navigator.userAgent.substring(0, 90));
        if (st && st.now) lines.push('服务器时间: ' + st.now);
        lines.push('');
        lines.push('== 反代与上游 ==');
        lines.push('上游地址: ' + ((st && st.upstream) || '(未配置)') + '   连通性: ' + (st && st.upstream_ok ? '正常' : '不可达'));
        lines.push('增强注入: ' + (st && st.enhancement_enabled ? '开' : '关'));
        lines.push('');
        lines.push('== 登录与同步 ==');
        lines.push('fnOS 会话: 已登录（网页会话）');
        lines.push('豆瓣同步: ' + (s.doubanEnabled ? '开' : '关') + (s.doubanLoggedIn ? '（已登录）' : '') + '   Bangumi: ' + (s.bangumiEnabled ? '开' : '关') + (s.bangumiHasToken ? '（有Token）' : ''));
        lines.push('');
        lines.push('== 弹幕 ==');
        lines.push('B站登录态: ' + (s.bili_cookie ? '已配置' : '未配置（番剧/动漫搜索需要）'));
        lines.push('自建弹幕源: ' + (s.danmuApiEnabled ? '启用 · ' + maskBase(String(s.danmuApiBase || '')) : '未启用'));
        const bt: string[] = Array.isArray(s.biliDanmakuBlockTypes) ? s.biliDanmakuBlockTypes : [];
        lines.push('屏蔽类型: ' + (bt.length ? bt.join(', ') : '(无)') + '   屏蔽词: ' + (s.biliDanmakuBlacklist ? '已配置' : '(无)'));
        lines.push('');
        lines.push('== 界面 ==');
        lines.push('轮播样式: ' + (localStorage.getItem('fnos-carousel-style') || '4') + '   轮播Logo: ' + (S.carouselLogoEnabled ? '开' : '关'));
        lines.push('滚轮横滚: ' + (s.wheelHScroll ? '开' : '关'));
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
    dbgLabel.textContent = t('调试日志');
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
    // [lc-1102] 改用统一的 mkFold：折叠区带 data-fold / data-fold-body 标记 → 设置搜索能穿进来，
    //   点搜索结果直达时自动展开（此前手搓的折叠区没有标记，这一整块永远搜不到）。
    const dbgFold = mkFold('组件日志（按组件单独控制）');
    secDebugBody.appendChild(dbgFold.fold);
    const dbgFoldBody = dbgFold.body;

    const debugHint = document.createElement('div');
    debugHint.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin:6px 0 8px;line-height:1.5;';
    debugHint.textContent = t('关闭时控制台仅显示 警告/错误；开启后可单独控制各组件是否输出详细日志(INFO/DEBUG)。');
    dbgFoldBody.appendChild(debugHint);

    // 组件开关进折叠区
    debugTarget = dbgFoldBody;
    const debugComps: [string, string][] = [
      ['douban', '豆瓣同步'],
      ['danmaku', 'B站弹幕'],
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

    // [飞牛影视特化 v0.10.0] 原 logStatus 状态行随四按钮一并移除（实时日志视图自带状态展示）

    // ===== [飞牛影视特化 v0.10.0] 实时日志查看器：原「日志文件/报错日志/导出日志/MPV日志」四按钮
    //   按需移除（桌面版走主进程开文件，网页端无意义）；改为内嵌轮询视图，数据源为注入后端的
    //   /app/fntvplus/api/logs（合并后端+前端两路）。左下角悬浮「日志」按钮同步移除，入口收敛到这里。
    const logFooter = document.createElement('div');
    logFooter.style.cssText = 'padding:10px 12px;flex-shrink:0;';
    const logDivider = document.createElement('div');
    logDivider.style.cssText = 'height:1px;background:var(--fnos-ui-border);margin:0 0 8px;';
    logFooter.appendChild(logDivider);
    const logRow = document.createElement('div');
    logRow.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
    // [v0.20.0] 自动刷新开关按需移除——始终自动刷新（5 秒），保留手动「刷新」按钮
    const liveBtn = mkBtn('刷新', true);
    logRow.appendChild(liveBtn);
    logFooter.appendChild(logRow);
    const livePre = document.createElement('pre');
    livePre.style.cssText = 'margin:8px 0 0;padding:10px;border-radius:8px;background:var(--fnos-ui-input-bg);'
      + 'color:var(--fnos-ui-text);font-size:11px;line-height:1.5;max-height:300px;overflow:auto;'
      + 'white-space:pre-wrap;word-break:break-all;';
    livePre.textContent = '加载中…';
    logFooter.appendChild(livePre);
    secDebug.el.appendChild(logFooter);

    const fetchLiveLog = (): void => {
      fetch('/app/fntvplus/api/logs?lines=300', { credentials: 'include' })
        .then((r) => r.text())
        .then((txt) => {
          const stick = livePre.scrollTop + livePre.clientHeight >= livePre.scrollHeight - 30;
          livePre.textContent = txt || '(空)';
          if (stick) livePre.scrollTop = livePre.scrollHeight;
        })
        .catch((e) => { livePre.textContent = '日志读取失败: ' + e; });
    };
    liveBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); fetchLiveLog(); });
    fetchLiveLog();
    // 面板可能随 SPA 重建，先清旧定时器再挂新的，避免轮询泄漏
    try {
      if ((window as any).__fntvLiveLogTimer) clearInterval((window as any).__fntvLiveLogTimer);
      (window as any).__fntvLiveLogTimer = window.setInterval(() => { fetchLiveLog(); }, 5000);
    } catch (_) {}

    // ===== 插件面板：跳过片头片尾（smart_skip 插件，控制面从 MPV 菜单抽到此处）=====
    const secSkip = section('跳过片头片尾');
    secSkip.el.id = 'sec-skip';
    const skipBody = secSkip.body;
    const skipDesc = document.createElement('div');
    skipDesc.textContent = t('自动加载飞牛/影片库跳过数据；可在播放时显示「跳过片头/片尾」按钮，或开启后自动跳过。');
    skipDesc.style.cssText = 'color:#9aa0a6;font-size:12px;line-height:1.5;margin-bottom:6px;';
    skipBody.appendChild(skipDesc);
    const skipRow = document.createElement('div');
    skipRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    skipRow.onmouseenter = () => { skipRow.style.background = 'var(--fnos-ui-row-hover)'; };
    skipRow.onmouseleave = () => { skipRow.style.background = 'transparent'; };
    const skipLabel = document.createElement('span');
    skipLabel.textContent = t('自动跳过片头片尾');
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

    // ===== 分组: 关于（独立标签页；原侧栏"关于"按钮迁入设置面板）=====
    const secAbout = section();
    const secBodyAbout = secAbout.body;
    secBodyAbout.style.cssText = 'padding:18px 16px;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;';

    const aboutTitle = document.createElement('div');
    aboutTitle.style.cssText = 'font-size:22px;font-weight:800;color:var(--fnos-ui-pill-text);';
    aboutTitle.textContent = t('🎬 Fntv-Plus · Web 版');
    secBodyAbout.appendChild(aboutTitle);

    const aboutAuthor = document.createElement('div');
    aboutAuthor.style.cssText = 'font-size:13px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:4px;';
    aboutAuthor.textContent = 'YDMY007';
    secBodyAbout.appendChild(aboutAuthor);

    const aboutDesc = document.createElement('div');
    aboutDesc.style.cssText = 'font-size:13px;line-height:1.9;color:var(--fnos-ui-text);opacity:.82;max-width:440px;';
    aboutDesc.textContent = t('NAS 装一次，电视、平板、手机、电脑浏览器打开飞牛影视即是增强版：沉浸式美化（海报墙、四型轮播、详情页柔光玻璃、Logo 自定义）、弹幕（B站 / 自建源 / 弹弹play 兜底）、豆瓣 / Bangumi / Trakt 同步、跳过片头与跨设备播放记忆、TMDB 信息卡与每日放送、观影记录与年度报告、自定义刮削源回填。经飞牛统一网关注入，不改动系统与影视应用任何文件，卸载即还原。');
    secBodyAbout.appendChild(aboutDesc);

    const aboutVer = document.createElement('div');
    aboutVer.id = 'fnos-about-version';
    aboutVer.style.cssText = 'font-size:12.5px;color:var(--fnos-ui-muted);margin-top:2px;';
    aboutVer.textContent = t('版本：获取中…');
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
    aboutLink.textContent = t('🔗 GitHub 项目地址');
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

    // [v1.12.0] 匿名使用统计卡（开关 / 立即上报 / 重置匿名 ID）——与桌面版「关于」页同款。
    secBodyAbout.appendChild(buildStatsCard());

    // ===== 分组: 外观（独立标签页；原侧栏"亚克力透明度/背景模糊"滑块迁入设置面板）=====
    // [飞牛影视特化 v0.12.0] 卡内只留主题模式三选一（亚克力透明度/背景模糊两滑块已按需移除，CSS 变量走启动默认值）
    const secAppearance = section('外观');
    const secBodyAppearance = secAppearance.body;
    secBodyAppearance.style.cssText = 'padding:8px 12px 12px;flex:1 1 auto;display:flex;flex-direction:column;';
    themeRow.style.cssText += 'margin-bottom:6px;';
    secBodyAppearance.appendChild(themeRow);

    // ===== [lc-780→lc-856] 首页轮播图样式切换（外观卡）=====
    // [网页端补回] v0.12.0 精简外观卡时把整个 buildAppearanceControls() 连函数一起删了，
    //   这个开关就在里面 —— 结果渲染层照旧读 localStorage['fnos-carousel-style']（默认 4=立体堆叠），
    //   但用户再也找不到切换入口（用户报障「外观里轮播图样式没了」）。按桌面版原样补回：
    //   1=竖向轮播 2=横向轮播 3=堆叠切换 4=立体堆叠，点击后整页回首页重载生效。
    const getCs = (): number => {
      // [lc-1291→lc-1309] 与 mobile.resolveCarouselStyle 同口径（touchCapable 已含
      // 触屏+短边≤820 双条件）：手机/平板上存量 '4' 是 lc-780 时代默认值、不是知情选择
      // → 高亮「触屏特供」；显式选过 1/2/3 才高亮对应项。PC（含触屏一体机）：
      // '4'/'5'/空 全部按 4 高亮，原样式不动。
      const stored = localStorage.getItem('fnos-carousel-style');
      const v = parseInt(stored || '4', 10);
      if (touchCapable) {
        return (v === 1 || v === 2 || v === 3) ? v : 5;
      }
      return (v === 5) ? 4 : ((v >= 1 && v <= 5) ? v : 4);
    };
    const csWrap = document.createElement('div');
    csWrap.style.cssText = 'margin-top:14px;';
    const csTitle = document.createElement('div');
    csTitle.style.cssText = 'font-weight:600;letter-spacing:.5px;margin-bottom:8px;';
    csTitle.textContent = t('首页轮播图样式');
    csWrap.appendChild(csTitle);
    const csSeg = document.createElement('div');
    csSeg.id = 'fnos-carousel-style-seg';
    csSeg.style.cssText = 'display:flex;gap:6px;';
    // [lc-1291] 样式 5 仅触屏设备可选；桌面面板里不显示这一项（resolveCarouselStyle 同口径：
    //   桌面即便写入 5 也会回落 4，这里不展示是避免给桌面用户一个「选了没效果」的死开关）。
    // [lc-1309] 用户明确要求新布局**只对手机端和平板的尺寸规格生效**、PC 原样式不动：
    // 面板第 5 项与高亮口径 = 触屏 + 短边≤820 双条件（与 mobile.resolveCarouselStyle 一致）。
    // 触屏一体机/触屏笔记本（PC，短边>820）不显示该档，避免「选了没效果」的死开关。
    const mobileSpec = (() => { try { return Math.min(window.innerWidth, window.innerHeight) <= 820; } catch { return false; } })();
    const touchCapable = mobileSpec && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
    const csLabels = ['竖向轮播', '横向轮播', '堆叠切换', '立体堆叠'];
    if (touchCapable) csLabels.push('触屏特供');
    csLabels.forEach((lab, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.style = String(idx + 1);
      b.textContent = t(lab);
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
        const el = btn as HTMLElement;
        const on = parseInt(el.dataset.style || '1', 10) === cur;
        el.style.borderColor = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-border)';
        el.style.background = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-input-bg)';
        el.style.color = on ? '#fff' : 'var(--fnos-ui-text)';
      });
    };
    csSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = parseInt((btn as HTMLElement).dataset.style || '1', 10);
        localStorage.setItem('fnos-carousel-style', String(s));
        paintCs();
        // [网页端] 入口就是裸 /v 路由（后端反代剥离 /app/fntvplus 前缀），跳同源 /v 即回首页重载；
        //   新样式在重载后由 render.ts 从 localStorage 读取，干净生效（避免 live-rebuild 跨样式残留）。
        try { navToTvPage('/v'); }
        catch (_) { try { window.location.reload(); } catch (__) { /* ignore */ } }
      });
    });
    secBodyAppearance.appendChild(csWrap);

    // ===== [v0.91.0] 「轮播图标题替换为 Logo」开关（原 lc-041 精简误删，用户要求挂回通用卡）=====
    //   功能本体（logo.ts 渲染链 + applyCarouselLogoNow）一直都在，只差这个入口。
    const logoRow = document.createElement('div');
    logoRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;';
    const logoTextWrap = document.createElement('div');
    logoTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
    const logoTitle = document.createElement('span');
    logoTitle.style.cssText = 'font-weight:600;letter-spacing:.5px;';
    logoTitle.textContent = '轮播图标题替换为 Logo';
    const logoHint = document.createElement('span');
    logoHint.style.cssText = 'font-size:11px;opacity:.7;line-height:1.4;';
    logoHint.textContent = '用 TMDB 透明标识替换轮播图上的文字标题；关闭即恢复文字标题。';
    logoTextWrap.appendChild(logoTitle);
    logoTextWrap.appendChild(logoHint);
    logoRow.appendChild(logoTextWrap);
    const swLogo = document.createElement('input');
    swLogo.type = 'checkbox';
    swLogo.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);flex:none;';
    logoRow.appendChild(swLogo);
    swLogo.checked = S.carouselLogoEnabled;
    swLogo.addEventListener('change', () => {
      S.carouselLogoEnabled = swLogo.checked;
      ipcRenderer.invoke('settings:set-carousel-logo', swLogo.checked).catch((err) => log('set-carousel-logo failed', err));
      // 立即对当前已渲染轮播生效（开→拉取 logo 替换；关→还原文字标题）
      try { applyCarouselLogoNow(); } catch (e) { log('applyCarouselLogoNow failed', e); }
    });
    (overlay as any)._swLogo = swLogo; // 回填引用（SETTINGS refresh 刷新用）
    secBodyAppearance.appendChild(logoRow);
    // [v0.95.0] 「自定义 Logo」卡片（桌面完整版：当前缩略图/预设弹窗/上传/恢复默认）
    secBodyAppearance.appendChild(buildCustomLogoCard());
    (overlay as any)._refreshCustomLogoCard = refreshCustomLogoCard;

    // ===== [lc-980] 「剧集详情页美化」开关（外观卡，与轮播样式同批被 v0.12.0 精简误删）=====
    //   开=套用美化（沉浸底图 / 两栏布局 / 磨砂卡），关=恢复飞牛原生详情页。
    //   语义：detailBoxless=true 表示「关闭美化走原生」，故 checked = !detailBoxless。
    //   回填链路完好（_beautifyToggle / _beautifyPaint 见 seg('switches')），这里只需创建并暴露引用。
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
    secBodyAppearance.appendChild(beautifyRow);

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
      // 立即应用：关→teardown 恢复原生；开→若正在详情页立即套用
      try { if (S.detailBoxless) teardownDetailBeautify(); else applyDetailBeautify(); } catch (_) { /* ignore */ }
    });
    // 暴露给设置回填（持久化设置异步 resolve 后同步勾选态并重绘）
    _beautifyToggle = beautifyInput;
    _beautifyPaint = paintBeautify;

    // ===== [v0.60.0] 「每日放送」独立卡：显示开关（胶囊自绘）+ 数据刷新间隔 + 立即刷新 =====
    const secDaily = section('每日放送');
    const secBodyDaily = secDaily.body;
    secBodyDaily.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;gap:12px;';

    // 行1：显示开关（胶囊 track+knob 自绘，与「剧集详情页美化」同款；原生 checkbox 深色主题显示异常）
    const hotShowRow = document.createElement('div');
    hotShowRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;';
    const hotShowTextWrap = document.createElement('div');
    hotShowTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
    const hotShowTitle = document.createElement('span');
    hotShowTitle.style.cssText = 'font-weight:600;letter-spacing:.5px;';
    hotShowTitle.textContent = t('在首页显示每日放送入口');
    const hotShowHint = document.createElement('span');
    hotShowHint.style.cssText = 'font-size:11px;opacity:.7;line-height:1.4;';
    hotShowHint.textContent = t('关闭即隐藏右下角的「每日放送」浮窗按钮。');
    hotShowTextWrap.appendChild(hotShowTitle);
    hotShowTextWrap.appendChild(hotShowHint);
    const hotShowLabel = document.createElement('label');
    hotShowLabel.style.cssText = 'position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;flex-shrink:0;';
    const hotShowInput = document.createElement('input');
    hotShowInput.type = 'checkbox';
    hotShowInput.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
    const hotShowTrack = document.createElement('span');
    hotShowTrack.style.cssText = 'position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;';
    const hotShowKnob = document.createElement('span');
    hotShowKnob.style.cssText = 'position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);';
    hotShowLabel.appendChild(hotShowInput);
    hotShowLabel.appendChild(hotShowTrack);
    hotShowLabel.appendChild(hotShowKnob);
    const paintHotShow = (): void => {
      hotShowTrack.style.background = hotShowInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      hotShowKnob.style.left = hotShowInput.checked ? '21.5px' : '2.5px';
    };
    try { hotShowInput.checked = localStorage.getItem('fnos-show-daily') !== '0'; } catch (_) { hotShowInput.checked = true; }
    paintHotShow();
    hotShowInput.addEventListener('change', () => {
      try { localStorage.setItem('fnos-show-daily', hotShowInput.checked ? '1' : '0'); } catch (_) { /* ignore */ }
      paintHotShow();
      try { window.dispatchEvent(new CustomEvent('fntv:daily-toggle')); } catch (_) { /* ignore */ }
    });
    hotShowRow.appendChild(hotShowTextWrap);
    hotShowRow.appendChild(hotShowLabel);
    secBodyDaily.appendChild(hotShowRow);

    // 行2：数据刷新间隔（1-7 天；数据本地持久化，未到期展开浮层直接用缓存）
    const hotIntervalRow = document.createElement('div');
    hotIntervalRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;';
    const hotIntervalLabel = document.createElement('span');
    hotIntervalLabel.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);';
    hotIntervalLabel.textContent = t('数据刷新间隔');
    const hotIntervalSel = document.createElement('select');
    hotIntervalSel.style.cssText = 'height:28px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;padding:2px 6px;';
    for (let d = 1; d <= 7; d++) {
      const o = document.createElement('option');
      o.value = String(d); o.textContent = t('每 ') + d + t(' 天');
      hotIntervalSel.appendChild(o);
    }
    try { hotIntervalSel.value = localStorage.getItem('fnos-hot-refresh-days') || '1'; } catch (_) { hotIntervalSel.value = '1'; }
    if (!hotIntervalSel.value) hotIntervalSel.value = '1';
    hotIntervalSel.addEventListener('change', () => {
      try { localStorage.setItem('fnos-hot-refresh-days', hotIntervalSel.value); } catch (_) { /* ignore */ }
    });
    hotIntervalRow.appendChild(hotIntervalLabel);
    hotIntervalRow.appendChild(hotIntervalSel);
    secBodyDaily.appendChild(hotIntervalRow);

    // 行3：立即刷新（清空本地缓存并强制重拉当前源）
    const hotRefreshBtn = mkBtn('立即刷新数据', true);
    hotRefreshBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      try { window.dispatchEvent(new CustomEvent('fntv:hot-refresh')); } catch (_) { /* ignore */ }
      hotRefreshBtn.textContent = '已触发 ✓';
      setTimeout(() => { hotRefreshBtn.textContent = '立即刷新数据'; }, 1500);
    });
    secBodyDaily.appendChild(hotRefreshBtn);

    const hotHint = document.createElement('div');
    hotHint.style.cssText = 'font-size:10px;color:var(--fnos-ui-sub);line-height:1.5;';
    hotHint.textContent = t('数据保存在本机，超过刷新间隔后展开浮层才会重新拉取。');
    secBodyDaily.appendChild(hotHint);


    // ===== 分组: 自定义代理（让 Bangumi 每日放送、TMDB 等走用户自建代理入口）=====
    // ═══ [v1.5.0] 自定义刮削源（纯前端回填，零系统改动）═══
    const secScraper = section('自定义刮削源');
    const secBodyScraper = secScraper.body;
    secBodyScraper.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const csDesc = document.createElement('div');
    csDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    csDesc.innerHTML = t('<b>✅ 已上线</b> —— 把刮削锚点发给<b>你自建的刮削服务</b>（能收发 JSON 的 HTTP 接口），返回数据经飞牛官方编辑接口回填（不修改任何系统文件；只填空/覆盖占位/中文覆盖英文，绝不倒打已有中文，写回带字段锁）。'
      + '步骤：① 搭服务（任何语言，协议见下）② 打开下方开关 ③ 填服务地址 → 保存。'
      + '协议：季页 POST {title, season, tmdbId, episodes}，响应 {episodes:[{index,title,overview}]}；'
      + '文件夹 POST {mode:"folder", title, folderGuid, items/episodes:[{index,guid,name}]}（name=文件名，服务按 name/index 匹配），响应 {items|episodes:[{index|name,title,overview}]}。'
      + '按钮位置：季页「选集」旁「⟳ 自定义刮削」（分集回填）；个人视频文件夹页「⟳ 文件夹刮削」（按文件名批量，子文件夹自动递归）。');
    secBodyScraper.appendChild(csDesc);

    const csToggleRow = document.createElement('label');
    csToggleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;margin-bottom:8px;';
    const csToggleSpan = document.createElement('span');
    csToggleSpan.textContent = t('启用自定义刮削源');
    csToggleSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const csToggle = document.createElement('input');
    csToggle.type = 'checkbox';
    csToggle.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    csToggleRow.appendChild(csToggleSpan); csToggleRow.appendChild(csToggle);
    secBodyScraper.appendChild(csToggleRow);

    const csUrlInput = document.createElement('input');
    csUrlInput.type = 'text';
    csUrlInput.placeholder = t('http://192.168.1.9:9000/scraper');
    csUrlInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;margin-bottom:8px;';
    secBodyScraper.appendChild(csUrlInput);

    const csStatus = document.createElement('div');
    csStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-bottom:8px;min-height:14px;';
    secBodyScraper.appendChild(csStatus);

    const csSave = document.createElement('button');
    csSave.type = 'button';
    csSave.textContent = t('保存');
    csSave.style.cssText = 'align-self:flex-start;padding:6px 18px;border-radius:8px;border:none;cursor:pointer;'
      + 'font-size:11.5px;font-weight:600;background:var(--fnos-ui-accent);color:#fff;';
    csSave.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const urlStr = csUrlInput.value.trim();
      if (csToggle.checked && urlStr && !/^https?:\/\//i.test(urlStr)) {
        csStatus.textContent = t('地址需以 http:// 或 https:// 开头');
        csStatus.style.color = 'var(--fnos-ui-warn,#b06a3a)';
        return;
      }
      try {
        await ipcRenderer.invoke('settings:set-custom-scraper-enabled', csToggle.checked);
        await ipcRenderer.invoke('settings:set-custom-scraper-url', urlStr);
        S.customScraperEnabled = csToggle.checked;
        S.customScraperUrl = urlStr;
        csStatus.textContent = t('已保存') + (csToggle.checked ? '，季页按钮即刻生效' : '');
        csStatus.style.color = 'var(--fnos-ui-ok,#3f9d63)';
      } catch (err: any) {
        csStatus.textContent = t('保存失败') + ': ' + String(err && err.message || err).substring(0, 60);
        csStatus.style.color = 'var(--fnos-ui-warn,#b06a3a)';
      }
      window.setTimeout(() => { csStatus.textContent = ''; }, 4000);
    });
    secBodyScraper.appendChild(csSave);

    // 回填（面板打开时由 seg('custom-scraper') 调 _refreshCustomScraperCard）
    (overlay as any)._refreshCustomScraperCard = (): void => {
      csToggle.checked = S.customScraperEnabled;
      csUrlInput.value = S.customScraperUrl || '';
    };

    // ===== [v1.10.0] 扩展数据源（官方开放 API）——每渠道一张独立卡（与 Bangumi/TMDB/Trakt 卡同规格）=====
    // 四个渠道均为官方开放 API（查验报告见 docs/刮削渠道查验报告.md），全部经 Go bridge 后端调用：
    //   fanart:logos（fanart.go，电影按 TMDB id、剧经 external_ids 换算 TVDB id）
    //   tvmaze:show（tvmaze.go，免 Key）/ omdb:rating（omdb.go）+ skip 映射链 MAL 官方优先。
    const secFanart = section('Fanart.tv 高清 Logo');
    const secTvmaze = section('TVMaze 分集兜底');
    const secOmdb = section('OMDb IMDb 评分');
    const secMal = section('MyAnimeList 官方');

    const maskExt = (v: string): string => '*'.repeat(Math.max(0, v.length));
    const extInputCss = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;';
    const mkExtDesc = (body: HTMLElement, text: string): void => {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.55;margin-bottom:8px;white-space:pre-line;';
      d.innerHTML = t(text); // 文本均为代码内静态常量（lc-1250 详细使用指南，支持换行/加粗）
      body.appendChild(d);
    };
    const mkExtToggle = (body: HTMLElement, label: string): HTMLInputElement => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 4px;cursor:pointer;border-radius:6px;margin-bottom:6px;';
      const sp = document.createElement('span');
      sp.textContent = t(label);
      sp.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(sp); row.appendChild(sw);
      body.appendChild(row);
      return sw;
    };
    // 掩码 key 输入（TMDB/Bangumi 卡同款语义）：已存值掩码只读，聚焦清空进入编辑，
    // 失焦空值恢复掩码 —— 防误清空真实 key。
    const mkMaskedKey = (body: HTMLElement, placeholder: string, holder: { v: string }): HTMLInputElement => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = t(placeholder);
      inp.style.cssText = extInputCss + 'margin-bottom:6px;';
      body.appendChild(inp);
      inp.addEventListener('focus', () => {
        if (inp.readOnly) { inp.readOnly = false; inp.value = ''; }
      });
      inp.addEventListener('blur', () => {
        if (inp.value.trim() === '' && holder.v) {
          inp.value = maskExt(holder.v);
          inp.readOnly = true;
        }
      });
      return inp;
    };
    const mkExtLink = (body: HTMLElement, label: string, url: string): void => {
      const a = document.createElement('a');
      a.textContent = t(label);
      a.href = url;
      a.style.cssText = 'color:var(--fnos-ui-sec);text-decoration:underline;cursor:pointer;font-size:10.5px;';
      a.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); ipcRenderer.invoke('settings:open-external', url).catch(() => {}); });
      body.appendChild(a);
    };
    const mkExtBtnRow = (body: HTMLElement): { save: HTMLButtonElement; clear: HTMLButtonElement; status: HTMLDivElement } => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
      const save = mkBtn('保存', true);
      const clear = mkBtn('清除', true);
      row.appendChild(save); row.appendChild(clear);
      body.appendChild(row);
      const status = document.createElement('div');
      status.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
      body.appendChild(status);
      return { save, clear, status };
    };
    // key 卡保存/清除（支持 1~2 字段，掩码语义：掩码态保存已存真实值；编辑态空值=保留已存，防误清空）
    const wireExtKeyCard = (
      fields: { input: HTMLInputElement; holder: { v: string }; settingsKey: string }[],
      btns: { save: HTMLButtonElement; clear: HTMLButtonElement; status: HTMLDivElement },
      savedText: string,
    ): void => {
      btns.save.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        try {
          const resolved: string[] = [];
          for (const f of fields) {
            const key = f.input.readOnly ? f.holder.v : (f.input.value.trim() || f.holder.v);
            resolved.push(key);
            await ipcRenderer.invoke('settings:set-' + f.settingsKey, key);
          }
          fields.forEach((f, i) => {
            f.holder.v = resolved[i];
            if (resolved[i]) { f.input.value = maskExt(resolved[i]); f.input.readOnly = true; }
            else { f.input.value = ''; f.input.readOnly = false; }
          });
          btns.status.textContent = t(savedText);
          btns.status.style.color = 'var(--fnos-ui-ok)';
        } catch {
          btns.status.textContent = t('保存失败');
          btns.status.style.color = 'var(--fnos-ui-warn)';
        }
        window.setTimeout(() => { btns.status.textContent = ''; }, 4000);
      });
      btns.clear.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        try {
          for (const f of fields) {
            f.input.value = '';
            f.input.readOnly = false;
            f.holder.v = '';
            await ipcRenderer.invoke('settings:set-' + f.settingsKey, '');
          }
          btns.status.textContent = t('已清除');
          btns.status.style.color = 'var(--fnos-ui-warn)';
        } catch {
          btns.status.textContent = t('清除失败');
          btns.status.style.color = 'var(--fnos-ui-warn)';
        }
        window.setTimeout(() => { btns.status.textContent = ''; }, 4000);
      });
    };

    // ① Fanart.tv —— 高清透明 Logo 兜底（电影按 TMDB id；剧自动换算 TVDB id；个人 client_key 可选）
    const faBody = secFanart.body;
    mkExtDesc(faBody, '<b>用途</b>：TMDB 拿不到透明 Logo 时，自动兜底 Fanart.tv 官方高清图（用于轮播标题替换与详情页 Logo 回填；电影按 TMDB id、剧集自动换算 TVDB id）。\n'
      + '<b>怎么配</b>：① 点下方链接到 fanart.tv 免费注册，在 Personal API Keys 页领取 api_key；② 把 api_key 填入下方「必填」框 → 保存；client_key（个人 key）可选，新图延迟更短；③ 打开开关。\n'
      + '未填 Key 或开关关闭时自动跳过，不影响其它功能。');
    const faToggle = mkExtToggle(faBody, '启用 Fanart.tv 高清 Logo 兜底');
    faToggle.addEventListener('change', () => {
      S.fanartEnabled = faToggle.checked;
      ipcRenderer.invoke('settings:set-fanart-enabled', faToggle.checked).catch(() => {});
    });
    const faReal = { v: '' };
    const faClientReal = { v: '' };
    const faKey = mkMaskedKey(faBody, 'Fanart.tv api_key（项目 key，必填）', faReal);
    const faClientKey = mkMaskedKey(faBody, 'Fanart.tv client_key（个人 key，可选，新图延迟更短）', faClientReal);
    const faBtns = mkExtBtnRow(faBody);
    wireExtKeyCard([
      { input: faKey, holder: faReal, settingsKey: 'fanart-api-key' },
      { input: faClientKey, holder: faClientReal, settingsKey: 'fanart-client-key' },
    ], faBtns, '已保存 Fanart.tv Key');
    mkExtLink(faBody, 'fanart.tv 免费领取 api_key →', 'https://fanart.tv/get-an-api-key/');

    // ② TVMaze —— 分集英文兜底（免 Key；「补全集信息」用）
    const tvBody = secTvmaze.body;
    mkExtDesc(tvBody, '<b>用途</b>：「⟳ 补全集信息」在 TMDB 缺英文标题/简介（或整集缺失）时，用 TVMaze 官方 API 补英文兜底。\n'
      + '<b>怎么配</b>：零配置——完全免费、无需任何 Key、国内可直连，打开开关即用；查询失败自动回退纯 TMDB，不会因此报错。');
    const tvToggle = mkExtToggle(tvBody, '启用 TVMaze 英文分集兜底');
    tvToggle.addEventListener('change', () => {
      S.tvmazeEnabled = tvToggle.checked;
      ipcRenderer.invoke('settings:set-tvmaze-enabled', tvToggle.checked).catch(() => {});
    });

    // ③ OMDb —— IMDb 评分（详情卡 + 观影记录第三格）
    const omBody = secOmdb.body;
    mkExtDesc(omBody, '<b>用途</b>：剧集详情卡与观影记录补「IMDb」评分（IMDb 无官方公开 API，OMDb 为其授权渠道；免费档 1000 次/天、非商业）。后端缓存 7 天省额度。\n'
      + '<b>怎么配</b>：① 点下方链接用邮箱免费申请 Key；② 到邮箱点激活链接（不激活无效）；③ 把收到的 Key 填入下方 → 保存 → 打开开关。');
    const omToggle = mkExtToggle(omBody, '启用 OMDb IMDb 评分');
    omToggle.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-omdb-enabled', omToggle.checked).catch(() => {});
    });
    const omReal = { v: '' };
    const omKey = mkMaskedKey(omBody, 'OMDb API Key（邮箱免费领取，1000 次/天）', omReal);
    const omBtns = mkExtBtnRow(omBody);
    wireExtKeyCard([{ input: omKey, holder: omReal, settingsKey: 'omdb-api-key' }], omBtns, '已保存 OMDb API Key');
    mkExtLink(omBody, 'omdbapi.com 免费领取 API Key →', 'https://www.omdbapi.com/apikey.aspx');

    // ④ MyAnimeList 官方 —— 动漫跳片头映射链首选（无需登录，注册应用得 Client ID）
    const malBody = secMal.body;
    mkExtDesc(malBody, '<b>用途</b>：动漫「跳过片头片尾」的标题映射链首选 MAL 官方 v2 API（未配置自动回退非官方 Jikan/AniList）；仅需 Client ID，无需登录授权。\n'
      + '<b>怎么配</b>：① 点下方链接登录 myanimelist.net → API 页 → Create；② App Name 随意（如 Fntv-Plus）、类型选 web、Commercial 选 non-commercial、Purpose 选 hobbyist、Redirect/Homepage 填任意可达网址（如你的 GitHub 仓库）；③ 提交后复制 Client ID 填入下方 → 保存 → 打开开关。');
    const malReal = { v: '' };
    const malKey = mkMaskedKey(malBody, 'MAL Client ID（可选，注册即用）', malReal);
    const malBtns = mkExtBtnRow(malBody);
    wireExtKeyCard([{ input: malKey, holder: malReal, settingsKey: 'mal-client-id' }], malBtns, '已保存 MAL Client ID');
    mkExtLink(malBody, 'myanimelist.net 注册 Client ID →', 'https://myanimelist.net/apiconfig');

    // ⑤ Jav 刮削 —— 番号匹配个人库整理（非官方抓取 javbus，默认关；可换镜像域名）
    const secJav = section('Jav 刮削');
    const javBody = secJav.body;
    mkExtDesc(javBody, '<b>用途</b>：个人视频库按番号整理（默认关，<b>无需自建服务</b>，数据源 javbus）。\n'
      + '<b>按钮</b>：电影/未识别视频详情页「⟳ jav 刮削」单条精修；文件夹页「⟳ jav 刮削」整夹批量（夹名有番号→整套落库，无番号→递归子夹按文件名逐个刮）；库列表页「⟳ 全库刮削」全库批量（已识别 Movie/TV 自动跳过）。\n'
      + '<b>回填</b>：标题/简介/发行日期/演员（带字段锁）+ 封面（真实落库）。未识别番号自动跳过不中断。\n'
      + '<b>网络</b>：非官方抓取，国内直连不通——需配合「自定义代理」或在下方填写可达的镜像域名。仅建议用于整理自有媒体库。');
    const javToggle = mkExtToggle(javBody, '启用 Jav 刮削');
    javToggle.addEventListener('change', () => {
      S.javEnabled = javToggle.checked;
      ipcRenderer.invoke('settings:set-jav-enabled', javToggle.checked).catch(() => {});
    });
    const javDomainInput = document.createElement('input');
    javDomainInput.type = 'text';
    javDomainInput.placeholder = t('javbus 域名（默认 www.javbus.com，可填镜像）');
    javDomainInput.style.cssText = extInputCss;
    javBody.appendChild(javDomainInput);
    const javBtns = mkExtBtnRow(javBody);
    javBtns.save.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        await ipcRenderer.invoke('settings:set-jav-bus-domain', javDomainInput.value.trim());
        javBtns.status.textContent = t('已保存域名');
        javBtns.status.style.color = 'var(--fnos-ui-ok)';
      } catch {
        javBtns.status.textContent = t('保存失败');
        javBtns.status.style.color = 'var(--fnos-ui-warn)';
      }
      window.setTimeout(() => { javBtns.status.textContent = ''; }, 4000);
    });
    javBtns.clear.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      javDomainInput.value = '';
      try {
        await ipcRenderer.invoke('settings:set-jav-bus-domain', '');
        javBtns.status.textContent = t('已恢复默认域名');
        javBtns.status.style.color = 'var(--fnos-ui-warn)';
      } catch {
        javBtns.status.textContent = t('清除失败');
        javBtns.status.style.color = 'var(--fnos-ui-warn)';
      }
      window.setTimeout(() => { javBtns.status.textContent = ''; }, 4000);
    });
    // ===== [v1.10.0] 扩展数据源四卡结束 =====


    const secCustomProxy = section('自定义代理');
    const secBodyCustomProxy = secCustomProxy.body;
    secBodyCustomProxy.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const cpDesc = document.createElement('div');
    cpDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    cpDesc.textContent = t('为 Bangumi 每日放送、TMDB（影视发现/海报）等数据源指定代理入口。支持 HTTP / HTTPS，可填账号密码鉴权。优先级低于环境变量 HTTPS_PROXY（已设环境变量则它先生效）。开启开关并填写地址后才生效。');
    secBodyCustomProxy.appendChild(cpDesc);

    // 开关行（整行可点）
    const cpToggleRow = document.createElement('label');
    cpToggleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;margin-bottom:8px;';
    const cpToggleSpan = document.createElement('span');
    cpToggleSpan.textContent = t('启用自定义代理');
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
    const cpTypeOpts: [string, string][] = [['https', 'HTTPS'], ['http', 'HTTP']];
    cpTypeOpts.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      cpType.appendChild(o);
    });
    const cpAddr = document.createElement('input');
    cpAddr.type = 'text';
    cpAddr.placeholder = t('主机:端口，如 127.0.0.1:7890');
    cpAddr.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    cpRow1.appendChild(cpType);
    cpRow1.appendChild(cpAddr);
    secBodyCustomProxy.appendChild(cpRow1);

    // 账号 / 密码 行（可选鉴权）
    const cpRow2 = document.createElement('div');
    cpRow2.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const cpUser = document.createElement('input');
    cpUser.type = 'text';
    cpUser.placeholder = t('账号（可选）');
    cpUser.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    const cpPass = document.createElement('input');
    cpPass.type = 'password';
    cpPass.placeholder = t('密码（可选）');
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

    // 本地预校验主机:端口（端口 1-65535），保存/测试前即时反馈，不必等后端往返
    function validateCpAddr(): string | null {
      const a = cpAddr.value.trim();
      if (!a) return '请填写主机:端口';
      const i = a.lastIndexOf(':');
      if (i < 0) return '缺少端口（格式：主机:端口）';
      const host = a.slice(0, i).trim();
      const portStr = a.slice(i + 1).trim();
      if (!host) return '主机不能为空';
      if (!/^\d+$/.test(portStr)) return '端口须为数字';
      const port = Number(portStr);
      if (port < 1 || port > 65535) return '端口须为 1-65535';
      return null;
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
        const addrErr = validateCpAddr();
        if (addrErr) { cpSetStatus(addrErr, false); return; }
        if (cpToggle.checked && !url) {
          cpSetStatus('已启用但未填写主机:端口（不生效）', false);
          return;
        }
        await ipcRenderer.invoke('settings:set-custom-proxy', cpToggle.checked, url).then((resp: any) => {
          // apiPost 对 HTTP 错误码不 reject（返回 {error:...}），必须显式校验响应，防止「假成功」
          if (resp && resp.error) { cpSetStatus('保存失败：' + resp.error, false); return; }
          if (!resp || typeof resp.customProxy !== 'string') { cpSetStatus('保存失败：后端未确认持久化', false); return; }
          cpSetStatus(cpToggle.checked && url ? ('已保存并启用：' + url) : '已关闭自定义代理', true);
        });
      } catch {
        cpSetStatus('保存失败', false);
      }
    });

    cpTestBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const addrErr = validateCpAddr();
      if (addrErr) { cpSetStatus(addrErr, false); return; }
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
        await ipcRenderer.invoke('settings:set-custom-proxy', false, '').then((resp: any) => {
          if (resp && resp.error) { cpSetStatus('重置失败：' + resp.error, false); return; }
          cpSetStatus('已关闭自定义代理', true);
        });
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
              cpType.value = scheme === 'http' ? 'http' : 'https';
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
          } else if (g.dirty) {
            // 旧版（≤v0.41）shim 误把 enabled 布尔存进 customProxy 键，URL 已丢——明确提示重填
            cpSetStatus('检测到旧版残留数据（地址已丢失），请重新填写并保存', false);
          }
        }
      } catch { /* ignore */ }
    })();

    // ===== [v1.11.0] 页面背景卡（不再锁死深浅模式的实心白/黑）=====
    // 三种自定义模式（纯色/渐变/图片）在深浅两种主题下同样生效；实现见 embyWall/pageBg.ts。
    const secPageBg = section('页面背景');
    const secBodyPageBg = secPageBg.body;
    secBodyPageBg.style.cssText = 'padding:8px 12px 12px;flex:1 1 auto;display:flex;flex-direction:column;';

    const pbDesc = document.createElement('div');
    pbDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    pbDesc.textContent = t('替换页面底色：深浅模式都不再是锁死的实心白/黑。原生=恢复默认；纯色/渐变=自选颜色；图片=自定义背景图（支持上传或 URL，可调暗化与模糊）。自定义背景对深色/浅色主题同时生效。');
    secBodyPageBg.appendChild(pbDesc);

    // 模式分段（原生/纯色/渐变/图片）
    const pbSeg = document.createElement('div');
    pbSeg.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    const PB_MODES: [string, string][] = [['native', '原生'], ['solid', '纯色'], ['gradient', '渐变'], ['image', '图片']];
    const pbSegBtns: Record<string, HTMLButtonElement> = {};
    PB_MODES.forEach(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(label);
      b.style.cssText = 'flex:1;height:30px;font-size:12px;border-radius:7px;cursor:pointer;border:1px solid var(--fnos-ui-border);background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);transition:.15s;';
      b.addEventListener('click', (e: Event) => { e.stopPropagation(); setPageBgMode(val as any); });
      pbSegBtns[val] = b;
      pbSeg.appendChild(b);
    });
    secBodyPageBg.appendChild(pbSeg);

    const pbRow = (marginTop = '6px'): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:' + marginTop + ';';
      secBodyPageBg.appendChild(d);
      return d;
    };
    const pbColor = (label: string): [HTMLDivElement, HTMLInputElement] => {
      const row = pbRow();
      const sp = document.createElement('span');
      sp.textContent = t(label);
      sp.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);flex:none;';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.style.cssText = 'width:44px;height:28px;padding:0;border:1px solid var(--fnos-ui-border);border-radius:6px;background:var(--fnos-ui-input-bg);cursor:pointer;flex:none;';
      const hex = document.createElement('span');
      hex.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);';
      row.appendChild(sp); row.appendChild(inp); row.appendChild(hex);
      return [row, inp, hex] as any;
    };
    const paintSeg = (): void => {
      PB_MODES.forEach(([val]) => {
        const active = S.pageBgMode === val;
        pbSegBtns[val].style.background = active ? 'var(--fnos-ui-sec)' : 'var(--fnos-ui-input-bg)';
        pbSegBtns[val].style.color = active ? '#fff' : 'var(--fnos-ui-text)';
        pbSegBtns[val].style.borderColor = active ? 'var(--fnos-ui-sec)' : 'var(--fnos-ui-border)';
      });
      pbSolidRow.style.display = S.pageBgMode === 'solid' ? '' : 'none';
      pbGradRow.style.display = S.pageBgMode === 'gradient' ? '' : 'none';
      pbGradRow2.style.display = S.pageBgMode === 'gradient' ? '' : 'none';
      pbImageRows.style.display = S.pageBgMode === 'image' ? '' : 'none';
    };
    const persistPageBg = (key: string, value: any): void => {
      ipcRenderer.invoke('settings:set-' + key, value).catch((e) => log('set page-bg failed', key, e));
    };
    const setPageBgMode = (val: 'native' | 'solid' | 'gradient' | 'image'): void => {
      S.pageBgMode = val;
      persistPageBg('page-bg-mode', val);
      paintSeg();
      applyPageBg();
    };

    // 纯色行
    const pbSolidRow = pbRow('2px');
    const pbSolidInp = document.createElement('input');
    pbSolidInp.type = 'color';
    pbSolidInp.style.cssText = 'width:52px;height:30px;padding:0;border:1px solid var(--fnos-ui-border);border-radius:6px;background:var(--fnos-ui-input-bg);cursor:pointer;';
    const pbSolidHex = document.createElement('span');
    pbSolidHex.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);';
    const pbSolidLabel = document.createElement('span');
    pbSolidLabel.textContent = t('背景颜色');
    pbSolidLabel.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);';
    pbSolidRow.appendChild(pbSolidLabel); pbSolidRow.appendChild(pbSolidInp); pbSolidRow.appendChild(pbSolidHex);
    const syncSolidHex = (): void => { pbSolidHex.textContent = S.pageBgColor.toUpperCase(); };
    pbSolidInp.addEventListener('input', () => {
      S.pageBgColor = pbSolidInp.value;
      persistPageBg('page-bg-color', S.pageBgColor);
      syncSolidHex();
      applyPageBg();
    });

    // 渐变行 ×2 + 角度
    const pbGradRow = pbRow('2px');
    const pbGradLabel = document.createElement('span');
    pbGradLabel.textContent = t('渐变起止');
    pbGradLabel.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);flex:none;';
    pbGradRow.appendChild(pbGradLabel);
    const pbGradInp1 = document.createElement('input');
    pbGradInp1.type = 'color';
    pbGradInp1.style.cssText = 'width:44px;height:28px;padding:0;border:1px solid var(--fnos-ui-border);border-radius:6px;background:var(--fnos-ui-input-bg);cursor:pointer;';
    const pbGradInp2 = pbGradInp1.cloneNode(true) as HTMLInputElement;
    const pbGradHex = document.createElement('span');
    pbGradHex.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);';
    pbGradRow.appendChild(pbGradInp1); pbGradRow.appendChild(pbGradInp2); pbGradRow.appendChild(pbGradHex);
    const pbGradRow2 = pbRow('2px');
    const pbGradAngleLabel = document.createElement('span');
    pbGradAngleLabel.textContent = t('角度');
    pbGradAngleLabel.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);flex:none;';
    const pbGradAngle = document.createElement('input');
    pbGradAngle.type = 'number';
    pbGradAngle.min = '0'; pbGradAngle.max = '360';
    pbGradAngle.style.cssText = 'width:70px;height:28px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;padding:4px 6px;box-sizing:border-box;';
    const pbGradAngleDeg = document.createElement('span');
    pbGradAngleDeg.textContent = '°（0=↑→ 下行 160 默认）';
    pbGradAngleDeg.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);';
    pbGradRow2.appendChild(pbGradAngleLabel); pbGradRow2.appendChild(pbGradAngle); pbGradRow2.appendChild(pbGradAngleDeg);
    const syncGrad = (): void => {
      pbGradInp1.value = S.pageBgColor; pbGradInp2.value = S.pageBgColor2;
      pbGradHex.textContent = S.pageBgColor.toUpperCase() + ' → ' + S.pageBgColor2.toUpperCase();
      pbGradAngle.value = String(S.pageBgAngle);
    };
    pbGradInp1.addEventListener('input', () => { S.pageBgColor = pbGradInp1.value; persistPageBg('page-bg-color', S.pageBgColor); syncGrad(); applyPageBg(); });
    pbGradInp2.addEventListener('input', () => { S.pageBgColor2 = pbGradInp2.value; persistPageBg('page-bg-color2', S.pageBgColor2); syncGrad(); applyPageBg(); });
    pbGradAngle.addEventListener('change', () => { S.pageBgAngle = Math.min(360, Math.max(0, parseInt(pbGradAngle.value, 10) || 160)); persistPageBg('page-bg-angle', S.pageBgAngle); syncGrad(); applyPageBg(); });

    // 图片行：URL/上传 + 暗化/模糊
    const pbImageRows = document.createElement('div');
    pbImageRows.style.cssText = 'display:flex;flex-direction:column;';
    secBodyPageBg.appendChild(pbImageRows);
    const pbImgRow1 = document.createElement('div');
    pbImgRow1.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
    const pbImgUrl = document.createElement('input');
    pbImgUrl.type = 'text';
    pbImgUrl.placeholder = t('图片 URL 或上传（http(s):// 或 data:）');
    pbImgUrl.style.cssText = 'flex:1 1 auto;min-width:0;height:30px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    const pbImgUpload = document.createElement('button');
    pbImgUpload.type = 'button';
    pbImgUpload.textContent = t('上传');
    pbImgUpload.style.cssText = 'flex:none;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text);border:none;';
    const pbImgFile = document.createElement('input');
    pbImgFile.type = 'file';
    pbImgFile.accept = 'image/*';
    pbImgFile.style.display = 'none';
    pbImgRow1.appendChild(pbImgUrl); pbImgRow1.appendChild(pbImgUpload); pbImgRow1.appendChild(pbImgFile);
    pbImageRows.appendChild(pbImgRow1);
    const pbImgApply = (): void => {
      S.pageBgImage = pbImgUrl.value.trim();
      persistPageBg('page-bg-image', S.pageBgImage);
      applyPageBg();
    };
    pbImgUrl.addEventListener('change', pbImgApply);
    pbImgUpload.addEventListener('click', (e: Event) => { e.stopPropagation(); pbImgFile.click(); });
    pbImgFile.addEventListener('change', () => {
      const f = pbImgFile.files && pbImgFile.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) {
        pbImgUrl.value = '';
        pbImgUrl.placeholder = t('图片过大（>3MB），请压缩后再试');
        return;
      }
      const rd = new FileReader();
      rd.onload = () => {
        pbImgUrl.value = String(rd.result || '');
        pbImgApply();
        pbPageBgStatus.textContent = t('已应用上传图片') + '（跨浏览器使用请改填 URL，dataURL 体积较大）';
        pbPageBgStatus.style.color = 'var(--fnos-ui-ok)';
        window.setTimeout(() => { pbPageBgStatus.textContent = ''; }, 5000);
      };
      rd.readAsDataURL(f);
    });
    const pbSlider = (label: string, min: number, max: number, get: () => number, set: (v: number) => void): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;';
      const sp = document.createElement('span');
      sp.textContent = t(label);
      sp.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);flex:none;';
      const val = document.createElement('span');
      val.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);width:38px;text-align:right;flex:none;';
      const rng = document.createElement('input');
      rng.type = 'range';
      rng.min = String(min); rng.max = String(max); rng.step = '1';
      rng.style.cssText = 'flex:1 1 auto;min-width:0;accent-color:var(--fnos-ui-accent);';
      const sync = (): void => { rng.value = String(get()); val.textContent = String(get()); };
      rng.addEventListener('input', () => { set(parseInt(rng.value, 10) || 0); persistPageBg('page-bg-dim', S.pageBgDim); persistPageBg('page-bg-blur', S.pageBgBlur); val.textContent = String(get()); applyPageBg(); });
      row.appendChild(sp); row.appendChild(rng); row.appendChild(val);
      pbImageRows.appendChild(row);
      (row as any).__sync = sync;
    };
    pbSlider('暗化', 0, 85, () => S.pageBgDim, (v) => { S.pageBgDim = v; });
    pbSlider('模糊', 0, 40, () => S.pageBgBlur, (v) => { S.pageBgBlur = v; });

    const pbPageBgStatus = document.createElement('div');
    pbPageBgStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyPageBg.appendChild(pbPageBgStatus);

    // 回填（面板打开时由 seg('page-bg') 调 _refreshPageBgCard）
    (overlay as any)._refreshPageBgCard = (): void => {
      paintSeg();
      syncSolidHex();
      syncGrad();
      pbImgUrl.value = S.pageBgImage;
      const rows = Array.from(pbImageRows.children) as any[];
      rows.forEach((r) => { if (r.__sync) r.__sync(); });
    };
    paintSeg();
    syncSolidHex();
    syncGrad();
    // ===== [v1.11.0] 页面背景卡结束 =====

    type Cat = { id: string; label: string; els: HTMLElement[] };
    // [飞牛影视特化 v0.15.0] 全部项重新分类排版（精简后余项按功能域收敛；v1.10.2 起 6 类）：
    //   通用=主题模式+每日放送+界面交互+跳过片头片尾（原「外观」「播放」合并更名）
    //   弹幕=4卡 · 账号与网络=四家同步+自定义代理+TMDB直连(第三方服务/代理同域)
    //   自定义刮削=自定义刮削服务(开放中置顶)/源+Fanart.tv/TVMaze/OMDb/MAL/Jav（原挂「账号与网络」，v1.10.2 独立成类）
    //   诊断与日志=调试开关+组件日志+实时日志 · 关于
    const cats: Cat[] = [
      // [v0.61.0] 「播放」分类删除：跳过片头片尾并入「通用」（原「外观」更名）；分类由 6 → 5
      { id: 'appearance', label: '通用', els: [secAppearance.el, secPageBg.el, secDaily.el, secUX.el, secSkip.el] },
      // [lc-1102] 三张「弹幕源」卡并列（内置降级源 → 弹弹play → 自建优选源），最后才是屏蔽/样式
      { id: 'danmaku', label: '弹幕', els: [secBili.el, secDandan.el, secDmApi.el, secDanmaku.el] },
      { id: 'account', label: '账号与网络', els: [secBangumi.el, secTmdb.el, secDouban.el, secTrakt.el, secCustomProxy.el, secTmdbDirect.el] },
      // [v1.10.2] 自定义刮削源→Jav 刮削七卡从「账号与网络」拆出独立成类；开发中的「自定义刮削服务」置顶占位
      { id: 'scraper', label: '自定义刮削', els: [secScraperSvc.el, secScraper.el, secFanart.el, secTvmaze.el, secOmdb.el, secMal.el, secJav.el] },
      { id: 'diag', label: '诊断与日志', els: [secDiag.el, secFeedback.el, secDebug.el] },
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
      btn.textContent = t(cat.label);
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
    searchInput.placeholder = t('搜索设置…（Ctrl+F）');
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

    // [lc-1102] 折叠区走查：卡体直接子级里若有折叠区(data-fold)，下钻一层收集其中的行，
    //   折叠标题行自身也参与匹配（命中后点直达会展开对应区域）。display 不被继承，
    //   所以折叠态（body display:none）不影响其中的行被收集。
    const rowsOf = (bodyEl: HTMLElement): HTMLElement[] => {
      const out: HTMLElement[] = [];
      for (const child of Array.from(bodyEl.children) as HTMLElement[]) {
        if (child.dataset.fold === '1') {
          for (const fc of Array.from(child.children) as HTMLElement[]) {
            if (fc.dataset.foldBody === '1') out.push(...(Array.from(fc.children) as HTMLElement[]));
            else out.push(fc);
          }
          continue;
        }
        out.push(child);
      }
      return out;
    };

    const runSearch = (): void => {
      const raw = searchInput.value;
      const q = norm(raw);
      searchClear.style.display = q ? 'block' : 'none';
      if (!q) { setSearchMode(false); return; }
      // 实时走查: 分类→卡片(data-sec-body)→行(含折叠区); 自身 display:none 的行(条件隐藏)不入结果
      const hits: { cat: Cat; row: HTMLElement; label: string }[] = [];
      for (const cat of cats) {
        for (const card of cat.els) {
          const bodyEl = Array.from(card.children)
            .find((ch) => (ch as HTMLElement).dataset && (ch as HTMLElement).dataset.secBody === '1') as HTMLElement | undefined;
          if (!bodyEl) continue;
          for (const row of rowsOf(bodyEl)) {
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
        badge.textContent = t(cat.label);
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
          // 直达: 清搜索→退搜索态→切分类→展开折叠区→滚动居中→高亮脉冲
          searchInput.value = '';
          searchClear.style.display = 'none';
          setSearchMode(false);
          selectCat(cat.id);
          // [lc-1102] 命中行在折叠区内(或命中的就是折叠标题) → 先展开，否则滚到一个隐藏元素，表现为「点了没反应」
          const foldHost = row.closest('[data-fold]') as HTMLElement | null;
          if (foldHost && typeof (foldHost as any).__setOpen === 'function') (foldHost as any).__setOpen(true);
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
          doubanStatus.textContent = t('已登录豆瓣 ✓');
          doubanStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          // [v0.51.0] 优先用后端 note（网页端="未配置豆瓣 Cookie（在设置面板「手动粘贴 Cookie」）"）
          doubanStatus.textContent = (st && st.note) ? st.note : t('未登录豆瓣（点"扫码登录"）');
          doubanStatus.style.color = 'var(--fnos-ui-warn)';
        }
        swDouban.checked = !!(st && st.enabled);
      } catch {
        doubanStatus.textContent = t('状态获取失败');
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
          biliStatus.textContent = t('已登录 ✓');
          biliStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          biliStatus.textContent = t('未登录');
          biliStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        biliStatus.textContent = t('状态获取失败');
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
        closeB.textContent = t('取消');
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
      if (!okLib) { if (qrWrap) qrWrap.textContent = t('二维码库加载失败'); return; }
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
      if (tip) tip.textContent = t('请用 B站 APP 扫码');
      _biliQrTimer = window.setInterval(async () => {
        const r: any = await ipcRenderer.invoke('bili:qr-poll', gen.key);
        if (r.code === 0) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = t('登录成功！');
          refreshBili();
          window.setTimeout(() => { m.style.display = 'none'; }, 900);
        } else if (r.expired) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = t('二维码已过期，请重新点击扫码登录');
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
      } catch { biliStatus.textContent = t('清除失败'); }
    });
    saveBiliCookieBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const r: any = await ipcRenderer.invoke('bili:manual-cookie', biliManualTa.value);
      if (r && r.ok) { biliManualTa.value = ''; refreshBili(); }
      else biliStatus.textContent = '保存失败：' + ((r && (r.msg || r.error)) || '未知');
    });
    // [退出行为卡已移除] 原 refreshExit()/exitEls hover 绑定随卡片一起删除 —— 保留引用会在
    //   面板构建期抛 ReferenceError，中断整个 buildSettingsPanel（症状：侧栏「设置」点了没反应）。

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
        // [lc-041] swLogo（轮播 Logo 卡）已随精简移除，不再回填
        // [lc-418] 诊断日志：面板每次打开记录开关回填值, 便于核对"配置文件 vs 面板显示"是否一致
        log('[开关回填] swProxy=' + swProxy.checked + ' swHide=' + swHide.checked + ' swNas=' + swNas.checked
          + ' 美化=' + (!!_beautifyToggle && _beautifyToggle.checked) + ' swWheel=' + swWheel.checked);
        // [v0.91.0] 轮播 Logo 开关回填（lc-041 精简时连回填一并移除了，现随开关补回）
        S.carouselLogoEnabled = s.carouselLogoEnabled !== false;
        const _swLogoRef = (overlay as any)._swLogo as HTMLInputElement | undefined;
        if (_swLogoRef) _swLogoRef.checked = S.carouselLogoEnabled;
        try { (overlay as any)._refreshCustomLogoCard?.(); } catch { /* ignore */ }
      });
      // [v0.82.0] seg('players') 已删（MPV/Pot 路径卡随外部播放器链一并移除，lc-078）
      seg('accounts', () => {
        refreshBili();
        refreshDouban();
      });
      // [v1.5.0] 自定义刮削源: 状态同步 + 卡片 UI 回填
      seg('custom-scraper', () => {
        S.customScraperEnabled = s.customScraperEnabled === true;
        S.customScraperUrl = String(s.customScraperUrl || '');
        try { (overlay as any)._refreshCustomScraperCard?.(); } catch { /* ignore */ }
      });
      // [v1.10.0] 扩展数据源四卡（Fanart.tv / TVMaze / OMDb / MAL 官方）：布尔开关 + 掩码 key 回填。
      // 直接用已取回的 s（settings:get 磁盘真值）回填，不再单独请求。
      seg('ext-sources', () => {
        S.fanartEnabled = s.fanartEnabled === true;
        S.tvmazeEnabled = s.tvmazeEnabled === true;
        faToggle.checked = S.fanartEnabled;
        tvToggle.checked = S.tvmazeEnabled;
        omToggle.checked = s.omdbEnabled === true;
        const fillKey = (inp: HTMLInputElement, holder: { v: string }, raw: any): void => {
          const v = String(raw || '');
          holder.v = v;
          if (v) { inp.value = maskExt(v); inp.readOnly = true; }
          else { inp.value = ''; inp.readOnly = false; }
        };
        fillKey(faKey, faReal, s.fanartApiKey);
        fillKey(faClientKey, faClientReal, s.fanartClientKey);
        fillKey(omKey, omReal, s.omdbApiKey);
        fillKey(malKey, malReal, s.malClientId);
        // ⑤ Jav 刮削卡（开关 + 域名，均非机密明文）
        S.javEnabled = s.javEnabled === true;
        javToggle.checked = S.javEnabled;
        javDomainInput.value = String(s.javBusDomain || '');
      });
      // [v1.11.0] 页面背景（模式/颜色/图片/暗化/模糊）: 状态同步 + 卡片回填 + 即时应用
      seg('page-bg', () => {
        if (s && typeof s.pageBgMode === 'string' && ['native', 'solid', 'gradient', 'image'].includes(s.pageBgMode)) {
          S.pageBgMode = s.pageBgMode;
        }
        if (typeof (s && s.pageBgColor) === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.pageBgColor)) S.pageBgColor = s.pageBgColor;
        if (typeof (s && s.pageBgColor2) === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.pageBgColor2)) S.pageBgColor2 = s.pageBgColor2;
        if (typeof (s && s.pageBgAngle) === 'number') S.pageBgAngle = Math.min(360, Math.max(0, s.pageBgAngle));
        if (typeof (s && s.pageBgImage) === 'string') S.pageBgImage = s.pageBgImage;
        if (typeof (s && s.pageBgDim) === 'number') S.pageBgDim = Math.min(85, Math.max(0, s.pageBgDim));
        if (typeof (s && s.pageBgBlur) === 'number') S.pageBgBlur = Math.min(40, Math.max(0, s.pageBgBlur));
        try { (overlay as any)._refreshPageBgCard?.(); } catch { /* ignore */ }
        applyPageBg();
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
          bangumiStatus.textContent = t('已保存 Token');
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
          tmdbStatus.textContent = t('已保存 TMDB Key');
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
        // B站弹幕聚合阈值回填（默认 1500；<0 视为禁用=0）
        aggInput.value = String(s.mpvBiliAggregateThreshold == null ? 1500 : (s.mpvBiliAggregateThreshold < 0 ? 0 : s.mpvBiliAggregateThreshold));
      });
      seg('danmaku', () => {
        // [lc-215] 弹幕分区已改为「B站弹幕屏蔽」：回填屏蔽类型勾选 + 屏蔽词，不再回填被移除的样式项
        const bt: string[] = Array.isArray(s.biliDanmakuBlockTypes) ? s.biliDanmakuBlockTypes : [];
        for (const b of blockToggles) b.input.checked = bt.includes(b.key);
        if (danBlacklist && danBlacklist.ta) danBlacklist.ta.value = s.biliDanmakuBlacklist || '';
        // [lc-1302] 屏蔽类型真源回填：桌面端读 danmaku_block_types.json（MPV 快捷键菜单 Ctrl+k
        // 直接改写该文件）；网页端 shim 回落 settings 数组。读取失败保持上方 settings 回填值。
        ipcRenderer.invoke('settings:get-bili-danmaku-blocktypes-file').then((r: any) => {
          if (r && Array.isArray(r.blockTypes)) {
            for (const b of blockToggles) b.input.checked = r.blockTypes.includes(b.key);
          }
        }).catch(() => {});
        // [v1.11.0] 弹弹play 卡片状态改由后端 bridge 回查（凭证来源/是否配置/开关）：
        // Secret 永不下发前端，故不能再靠 settings 里的明文回填掩码。
        ddRefreshStatus();
        // [lc-1101] 自建弹幕接口回填（地址非敏感，明文显示；程序化赋值不触发 change，不会误保存）
        swDanmuApi.checked = s.danmuApiEnabled === true;
        // [lc-1266] 多地址逐行回填；旧配置只有单地址字段时原样显示一行
        dmApiInput.value = (Array.isArray(s.danmuApiBases) && s.danmuApiBases.length)
          ? s.danmuApiBases.join('\n')
          : (s.danmuApiBase || '');
        // [v1.11.1] 弹幕下限回填（后端默认 100；0=不启用）
        dmMinInput.value = String(s.danmuMinCount == null ? 100 : Math.max(0, Math.min(9999, Math.round(Number(s.danmuMinCount) || 0))));
        if (swDanmuApi.checked) {
          dmApiStatus.textContent = dmApiInput.value
            ? t('已启用自建弹幕接口作为优选源，未命中时自动降级到 B站。')
            : t('已开启但未填服务地址 —— 展开「服务地址与连通测试」填写后点保存。');
          dmApiStatus.style.color = dmApiInput.value ? 'var(--fnos-ui-sub)' : 'var(--fnos-ui-warn)';
        }
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
    let overlay = document.getElementById('fnos-settings-panel') as HTMLElement | null;
    // [网页端自愈] 面板不存在（典型：构建期抛错被中断）时重建一次，而不是静默 return。
    //   已修复的 exitEls ReferenceError 正是这个症状——按钮在、面板不在、点击毫无反应。
    if (!overlay) {
      try { buildSettingsPanel(); } catch (e) { console.error('[fntv-web] rebuild settings panel failed', e); }
      overlay = document.getElementById('fnos-settings-panel') as HTMLElement | null;
      if (!overlay) { console.error('[fntv-web] settings panel unavailable'); return; }
    }
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
        // [lc-1102] 「弹幕样式」入口的语义是去改屏蔽/屏蔽词，而屏蔽卡默认折叠 → 该入口额外展开
        if (sectionId === 'danmaku') {
          const ex = (overlay as any)._expandDanmakuFold;
          if (typeof ex === 'function') ex();
        }
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
    // [v0.98.0] 面板毛玻璃随滑出渐隐：backdrop-filter 是 inline !important（applySidebarGlass 注入），
    //   不参与类过渡 → 此前模糊原样挂到滑出最后一帧才瞬消，观感突兀。
    //   先把面板 transition 常驻补上 backdrop-filter 过渡，再把值过渡到 blur(0)（与滑出同步渐隐）。
    const panel = Array.from(d.children).find((c) => !(c as HTMLElement).classList.contains('absolute')) as HTMLElement | undefined;
    if (panel) {
      const tr = panel.style.getPropertyValue('transition');
      if (tr && !/backdrop-filter/.test(tr)) {
        panel.style.setProperty('transition', tr + ', backdrop-filter .3s ease', 'important');
      }
      panel.style.setProperty('backdrop-filter', 'blur(0px)', 'important');
    }
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
      // [v1.11.0] 只清顶栏容器，绝不清 body/html：demo/浅层 DOM 下祖先链 4 级内可直达 body，
      //   把 body 内联涂成 transparent !important 会压过一切样式表背景（页面背景自定义失效），
      //   且"透桌面"是玻璃模式的显式职责，本函数不应越权。
      if (el === document.body || el === document.documentElement) break;
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
    // [v0.97.0] 抽屉开合动画样式：v329 的 .drawer-open 类驱动机制一直缺这条 CSS 规则（类加了样式没变=瞬切无动画）。
    //   展开：背板淡入 + 面板从左侧 28px 滑入淡入（340ms easeOut）；收起反向（与既有 340ms display 移除定时匹配）。
    if (!document.getElementById('fntv-drawer-anim-style')) {
      const animStyle = document.createElement('style');
      animStyle.id = 'fntv-drawer-anim-style';
      animStyle.textContent = [
        '.fixed.inset-0[class*="lg:!hidden"] > *:not(.absolute) { transition: transform .34s cubic-bezier(.22,1,.36,1), opacity .3s ease; }',
        '.fixed.inset-0[class*="lg:!hidden"]:not(.drawer-open) > *:not(.absolute) { transform: translateX(-28px); opacity: 0; }',
        '.fixed.inset-0[class*="lg:!hidden"].drawer-open > *:not(.absolute) { transform: translateX(0); opacity: 1; }',
        '.fixed.inset-0[class*="lg:!hidden"] > .absolute.inset-0 { transition: opacity .3s ease; }',
        '.fixed.inset-0[class*="lg:!hidden"]:not(.drawer-open) > .absolute.inset-0 { opacity: 0; }',
        '.fixed.inset-0[class*="lg:!hidden"].drawer-open > .absolute.inset-0 { opacity: 1; }',
      ].join('\n');
      (document.head || document.documentElement).appendChild(animStyle);
    }
    // [lc-1250] 汉堡键点击: 文档级 capture 委托 —— React 重渲染会整节点替换顶栏汉堡
    //   （文件夹页实测进页后 header 重挂 → 元素级钩子随旧节点失效 → 点击无反应），
    //   委托到 document 后无论节点怎么换都命中当前节点，capture+stopImmediate 仍抢在 React 之前。
    if (!(window as any).__fnosBurgerDelegated) {
      (window as any).__fnosBurgerDelegated = '1';
      document.addEventListener('click', (e: Event) => {
        const t = e.target as HTMLElement;
        if (!t || !t.closest) return;
        if (t.closest('a')) return; // 🏠 首页链接放行(不拦截, 交给飞牛导航)
        const burgerHit = t.closest('[class*="lg:!hidden"]:not([class*="inset-0"])');
        if (!burgerHit) return;
        e.preventDefault();
        e.stopImmediatePropagation(); // 拦截飞牛原生 onClick, 避免双重控制
        const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
        if (!drawer) return;
        if (drawer.classList.contains('drawer-open')) { animateCloseDrawer(drawer); log('BURGER -> CLOSE (anim)'); }
        else { openDrawer(drawer); log('BURGER -> OPEN (anim)'); }
      }, true); // capture 阶段, 抢在 React 之前拦截
      log('BURGER click-hook installed (document delegation)');
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

  /** [lc-1250] CSS 颜色字面量 → rgba（支持 rgb/rgba() 与 #hex3/4/6/8）。 */
  function _cssColorToRgba(s: string): { r: number; g: number; b: number; a: number } | null {
    const m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const p = m[1].split(',').map(x => parseFloat(x.trim()));
      if (p.length >= 3 && !isNaN(p[0]) && !isNaN(p[1]) && !isNaN(p[2])) {
        return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
      }
      return null;
    }
    const h = s.match(/^#([0-9a-f]{3,8})$/i);
    if (h) {
      const v = h[1];
      if (v.length === 3 || v.length === 4) {
        return { r: parseInt(v[0] + v[0], 16), g: parseInt(v[1] + v[1], 16), b: parseInt(v[2] + v[2], 16),
          a: v.length === 4 ? parseInt(v[3] + v[3], 16) / 255 : 1 };
      }
      if (v.length === 6 || v.length === 8) {
        return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16),
          a: v.length === 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1 };
      }
    }
    return null;
  }

  /** [lc-1250] 估算纯色 linear-gradient 遮罩（无 url）在图标中心处的局部 rgba。
   *  修复：lc-925 采样器原先把 hero 的黑色渐变遮罩整层跳过（backgroundImage 无 url()
   *  即 continue），刮削后的亮封面左上角被采成"亮底" → 图标反色错误。仅支持水平/垂直
   *  方向（fnOS 实际 scrim 即 to bottom 黑渐变 + 90deg .gradient-for-full），其余返回 null。 */
  function gradientOverlayAt(el: HTMLElement, bgImage: string, px: number, py: number): { l: number; a: number } | null {
    if (!bgImage || bgImage.indexOf('linear-gradient') < 0 || bgImage.indexOf('url(') >= 0) return null;
    const open = bgImage.indexOf('(', bgImage.indexOf('linear-gradient'));
    let depth = 0, close = -1;
    for (let i = open; i >= 0 && i < bgImage.length; i++) {
      if (bgImage[i] === '(') depth++;
      else if (bgImage[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (open < 0 || close < 0) return null;
    const inner = bgImage.slice(open + 1, close);
    const parts: string[] = [];
    let buf = '', d2 = 0;
    for (const ch of inner) {
      if (ch === '(') d2++; else if (ch === ')') d2--;
      if (ch === ',' && d2 === 0) { parts.push(buf.trim()); buf = ''; } else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    if (parts.length < 2) return null;
    let horiz = false, reverse = false, startIdx = 0;
    const first = parts[0].toLowerCase();
    if (!/^(rgba?\(|hsla?\(|#)/.test(first)) {
      startIdx = 1;
      if (first.indexOf('to right') >= 0 || first.indexOf('90deg') >= 0) horiz = true;
      else if (first.indexOf('to left') >= 0 || first.indexOf('270deg') >= 0) { horiz = true; reverse = true; }
      else if (first.indexOf('to bottom') >= 0 || first.indexOf('180deg') >= 0) horiz = false;
      else if (first.indexOf('to top') >= 0 || first.indexOf('0deg') >= 0) { horiz = false; reverse = true; }
      else return null;
    }
    const segs = parts.slice(startIdx);
    const stops: { pos: number; r: number; g: number; b: number; a: number }[] = [];
    for (let i = 0; i < segs.length; i++) {
      const cm = segs[i].match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
      if (!cm) continue;
      const col = _cssColorToRgba(cm[1]);
      if (!col) continue;
      const pm = segs[i].match(/([\d.]+)\s*%/);
      const pos = pm ? Math.max(0, Math.min(1, parseFloat(pm[1]) / 100))
        : (segs.length > 1 ? i / (segs.length - 1) : 0);
      stops.push({ pos, r: col.r, g: col.g, b: col.b, a: col.a });
    }
    if (stops.length < 2) return null;
    stops.sort((a, b) => a.pos - b.pos);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    let t = horiz ? (px - r.left) / r.width : (py - r.top) / r.height;
    if (reverse) t = 1 - t;
    t = Math.max(0, Math.min(1, t));
    let c = stops[stops.length - 1];
    if (t <= stops[0].pos) c = stops[0];
    else {
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (t >= a.pos && t <= b.pos) {
          const f = b.pos > a.pos ? (t - a.pos) / (b.pos - a.pos) : 0;
          c = { pos: t, r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f, a: a.a + (b.a - a.a) * f };
          break;
        }
      }
    }
    if (c.a < 0.05) return null;
    return { l: _lumOf(c.r, c.g, c.b), a: c.a };
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
      // ② 背景图/渐变: 纯渐变遮罩（无 url）按图标位置估算局部 rgba 计入合成
      //   [lc-1250] 以前整层跳过 → hero 黑渐变不计入, 亮封面左上被采成"亮底"误判反色
      const bi = cs.backgroundImage || '';
      if (bi && bi !== 'none') {
        const g = gradientOverlayAt(el, bi, x, y);
        if (g) {
          if (g.a >= 0.5) return blend(g.l);
          overlays.push(g);
        }
        const u = bi.match(/url\(["']?([^"')]+)["']?\)/);
        if (u && u[1]) {
          const l = await imageTopLeftLuminance(u[1]);
          if (l != null) return blend(l);
        }
      }
      // ③ <img> 元素
      if (el.tagName === 'IMG') {
        // [lc-1250] 详情页 hero 背景图跳过: fnOS 恒在 hero 图上叠暗色渐变（lc-989 实测
        // 顶栏三层恒暗、图片贡献 ≤4%），原图左上角亮度不代表视觉背景。
        if (isDetailPage() && el.closest('.semi-always-dark')) continue;
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
    // [飞牛影视特化 v0.10.1] 反色成功日志已删（每次调度都打，刷屏）；失败路径的异常日志保留
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
        // [v1.4.6] 主导航(home 键)回首页时媒体库 section 常在 React 异步渲染, 1.5s 窗口可能整体错过
        //   (旧版到此彻底放弃 → 轮播丢失, 用户被迫强刷)。延迟兜底再试两轮: 3s/6s, 命中即止。
        for (const delay of [3000, 6000]) {
          setTimeout(() => {
            if (!(S.carouselContainer && document.body.contains(S.carouselContainer)) && !S.carouselInited) {
              log('[v1.4.6] ensureHomepageEnhanced 延迟兜底重注入(' + delay + 'ms)');
              injectCarousel();
            }
          }, delay);
        }
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
      try { p = pagePathOf(new URL(h, location.origin).pathname); } catch (_) { p = pagePath(); }
      if (p === '/v' || p === '/v/') return;
      try { destroyCarousel(); } catch (_) { /* ignore */ }
    };
    (history as any).pushState = function (...a: any[]) {
      const prevPath = pagePath();
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
      scheduleEpBackfill(); scheduleCustomScraperButton(); scheduleJavButton(); // [v1.5.0] 自定义刮削按钮：非季页自撤
      scheduleFolderScraperButton(); // [自定义刮削] 个人视频文件夹页「⟳ 文件夹刮削」浮动按钮：非文件夹页自撤
    };
    (history as any).replaceState = function (...a: any[]) {
      const prevPath = pagePath();
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
      scheduleEpBackfill(); scheduleCustomScraperButton(); scheduleJavButton(); // [v1.5.0] 同 pushState
      scheduleFolderScraperButton(); // [自定义刮削] 同 pushState
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
      scheduleEpBackfill(); scheduleCustomScraperButton(); scheduleJavButton(); // [v1.5.0] 同 popstate
      scheduleFolderScraperButton(); // [自定义刮削] 同 popstate
    });
    window.addEventListener('hashchange', () => logNav('hashchange'));
    setTimeout(hideStaleViews, 1500); // 初始/深链到详情页时也清理一次
  // [自定义刮削] 文件夹页不满足 isDetailPage()（上方初始块不会跑），初始/深链直达文件夹页
  // 也要无条件调度一次——函数内部自判路由与开关，非文件夹页自摘。
  scheduleFolderScraperButton();
  [600, 1500, 3000].forEach(ms => setTimeout(() => scheduleFolderScraperButton(), ms));
  } catch (e) { log('NAV hook err', String(e).substring(0, 60)); }


  // [lc-980] 详情页美化重写：初始/深链直达详情页时也套一次(内部三闸判定, hero 未就绪则 arm 一次性 observer)。
  //   backfillDetailLogo 属轮播 logo 功能, 与美化正交, 保留。
  if (isDetailPage()) {
    backfillDetailLogo();
    applyDetailBeautify();
    scheduleEpBackfill(); scheduleCustomScraperButton(); scheduleJavButton(); // [v1.5.0] 初始/深链同挂自定义刮削按钮
    scheduleFolderScraperButton(); // [自定义刮削] 文件夹页非 isDetailPage 亦无条件调度（内部自判路由）
    // 延迟重试: SPA渲染可能分批加载DOM
    [600, 1500, 3000].forEach(ms => setTimeout(() => { backfillDetailLogo(); scheduleEpBackfill(); scheduleCustomScraperButton(); scheduleJavButton(); ensureVirtualBandFix(); }, ms));
  }
  // MutationObserver 覆盖详情页DOM变化 → 回填 Logo + [lc-1045] React 重渲染冲掉按钮时补挂
  let _detailGlassTimer = 0;
  const _detailObs = new MutationObserver(() => {
    clearTimeout(_detailGlassTimer);
    _detailGlassTimer = window.setTimeout(() => {
      if (isDetailPage()) { backfillDetailLogo(); ensureEpFixButton(); ensureVirtualBandFix(); } // [v1.10.2] 虚拟窗口补丁随详情页重建补挂
    }, 200);
  });
  _detailObs.observe(document.body, { childList: true, subtree: true });

  // [lc-066] 启动进度条遮罩（极简版）：藏 #root + 顶部 3px 流动进度条（无骨架布局），
  //   轮播注入/STRM 提示/离开首页/2.5s 兜底任一命中即揭开——消除「原生页裸奔 1-1.5s 再切海报墙」。
  armBootCover();

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
  const _isHomePath = (): boolean => { const p = pagePath(); return p === '/v' || p === '/v/'; };

  let _wtsTimer = 0;
  // [网页端] 触发风暴熔断：1 秒内回调超过 40 次即视为自激（回调自身在改 DOM → 再触发自己），
  //   本秒内直接跳过轮播重建。真实飞牛页面 DOM 变动远比预期频繁，一旦有路径形成
  //   「改 DOM → observer → 改 DOM」闭环，微任务会饿死主线程（整页无响应、点击全部失灵）。
  let _moHits = 0;
  let _moHitsTs = 0;
  new MutationObserver(() => {
    clearTimeout(_wtsTimer);
    _wtsTimer = window.setTimeout(wheelToScroll, 350);
    const _moNow = Date.now();
    if (_moNow - _moHitsTs > 1000) { _moHitsTs = _moNow; _moHits = 0; }
    if (++_moHits > 40) {
      if (_moHits === 41) log('[web] MutationObserver 触发风暴(>40/s)，本秒跳过轮播重建，防自激卡死');
      return;
    }
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
