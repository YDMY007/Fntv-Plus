// preload/plugins/mobileStyle.ts — 手机浏览器/窄视口适配层（fpk 网页端专属）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：飞牛影视网页端 #root 被站点自身钉了 min-width:820px（来源是站点运行时注入的
// 样式表，document.styleSheets 枚举不到，只能靠 !important 压制 + 行内样式兜底），
// 手机竖屏(≤640px)下整页按桌面宽渲染再被裁切 —— 用户报「浏览器访问整个界面乱套」。
// 本模块是**纯增量适配层**：不改任何插件的既有行为，只在窄视口下追加覆盖样式。
//
// 双断点（与 beautifyStyle 的 fnos-touch-narrow(641px) 对齐，不与其冲突）：
//   html.fnos-compact  ≤820px —— 结构性兜底：解除 #root 820px 裁切、设置/弹层宽度钳制。
//       覆盖平板竖屏(768px)等「装不下桌面布局」的区间。
//   html.fnos-narrow   ≤640px —— 手机整版：季页/电影页 hero 单列化、系列页玻璃聚簇
//       改窄屏排布（简介满宽 + TMDB 卡回流）、轮播文字缩小、观影记录/设置面板移动化。
//
// 优先级策略：本样式表在 boot 时注入（早于各插件懒注入的样式表），同特异性会输给
// 后注入者 → 所有与插件规则对抗的声明一律 !important + 带 html.fnos-* 前缀抬特异性
// （比 beautifyStyle 最长链多出 html.fnos-narrow 两级，恒定胜出）。
// 视口跨断点时派发一次 window resize：tmdbCard 的 --fnos-cluster-h 悬浮簇测高、
// 列表截断库等按 resize 重算的 JS 布局随之刷新。
// ─────────────────────────────────────────────────────────────────────────────

import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';

const STYLE_ID = 'fnos-mobile-css';
/** ≥640.5px = 手机以上；不匹配即窄屏（与 beautifyStyle MOBILE_FLAG_MQ 的 641 分档一致） */
const MQ_NARROW = '(min-width: 640.5px)';
/** ≥820.5px = 站点 #root min-width 全宽；不匹配即需要解除裁切 */
const MQ_COMPACT = '(min-width: 820.5px)';

/** 当前是否手机整版窄视口（≤640px）。其他插件可按需引用。 */
export function isNarrowViewport(): boolean {
  try { return !window.matchMedia(MQ_NARROW).matches; } catch { return false; }
}

let _mqNarrow: MediaQueryList | null = null;
let _mqCompact: MediaQueryList | null = null;

/** 按当前视口宽挂/摘 html.fnos-narrow / html.fnos-compact 标记类（幂等）。 */
function applyViewportFlags(): void {
  const html = document.documentElement;
  const narrow = !_mqNarrow || !_mqNarrow.matches;     // (min-width:640.5px) 不匹配 = ≤640
  const compact = !_mqCompact || !_mqCompact.matches;  // (min-width:820.5px) 不匹配 = ≤820
  const narrowBefore = html.classList.contains('fnos-narrow');
  const compactBefore = html.classList.contains('fnos-compact');
  html.classList.toggle('fnos-narrow', narrow);
  html.classList.toggle('fnos-compact', compact);
  // 行内兜底：站点对 #root 的 820px 钉宽来源枚举不到（疑似 adoptedStyleSheet），
  // 行内 !important 是唯一保证压得死的写法；宽视口时必须摘除还权于站点自身规则。
  const root = document.getElementById('root');
  if (root) {
    if (compact) root.style.setProperty('min-width', '0', 'important');
    else if (root.style.minWidth === '0px' || root.style.getPropertyValue('min-width') === '0') root.style.removeProperty('min-width');
  }
  if (narrow !== narrowBefore || compact !== compactBefore) {
    // 断点跨越：让按 resize 重算的 JS 布局（悬浮簇测高/文本截断）刷新一次
    try { window.dispatchEvent(new Event('resize')); } catch { /* 忽略 */ }
  }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = MOBILE_CSS;
  (document.head || document.documentElement).appendChild(st);
}

function ensure(): void {
  ensureStyle();
  applyViewportFlags();
}

export function installMobileStyle(): void {
  if (typeof window.matchMedia === 'function') {
    try {
      if (!_mqNarrow) {
        _mqNarrow = window.matchMedia(MQ_NARROW);
        const h = (): void => applyViewportFlags();
        if (_mqNarrow.addEventListener) _mqNarrow.addEventListener('change', h);
        else (_mqNarrow as any).addListener(h);
      }
      if (!_mqCompact) {
        _mqCompact = window.matchMedia(MQ_COMPACT);
        const h = (): void => applyViewportFlags();
        if (_mqCompact.addEventListener) _mqCompact.addEventListener('change', h);
        else (_mqCompact as any).addListener(h);
      }
    } catch { /* matchMedia 不可用则按 OnDomChange 周期兜底 */ }
  }
  ensure();
}

// 与 beautifyStyle.ts 逐字一致的三条站点结构选择器（那边参与 CSS 拼接、这边同样要拼，
// 共享常量会把纯 CSS 文件拽进运行时依赖，按两处各存一份的既有约定复制）。
const HERO = ':is('
  + '.semi-always-dark[class*="h-[470px]"],'
  + '.semi-always-dark[class*="min-h-[390px]"],'
  + '.trim-mc__details--key-version'
  + ')';
const SERIES_PANEL = 'div[class="relative box-border flex w-full flex-col px-[44px]"]';
const MOVIE_PANEL = 'div[class="relative flex w-full flex-col box-border px-[46px]"]';
const SERIES_BTNROW = 'div[class="relative w-full"] > div[class^="mt-4 "]';
const MOVIE_BTNROW = 'div[class="relative w-full"] > div[class^="mt-4 "]';
const MOVIE_COL = 'div[class*="mb-[46px]"][class*="flex flex-col gap-3"]:has(> div > .trim-mc__details--key-version)';

const MOBILE_CSS = `
/* ═══════════ A. fnos-compact（≤820px）结构性兜底 ═══════════ */

/* A1. 解除站点 #root 820px 最小宽（真凶来源枚举不到，样式表 + 行内双保险） */
html.fnos-compact #root{ min-width:0 !important; width:auto !important; }
html.fnos-compact body{ overflow-x:hidden !important; }

/* A2. 设置面板：内联 width min(680px,100vw-80px) 在窄屏下只剩 310px 且高度吃满，
   改为近满屏（!important 压行内样式）；dvh 在支持的浏览器上接管地址栏收缩 */
html.fnos-compact #fnos-settings-panel{
  width:calc(100vw - 16px) !important;
  height:calc(100vh - 56px) !important;
  height:calc(100dvh - 56px) !important;
  max-height:calc(100vh - 56px) !important;
  max-height:calc(100dvh - 56px) !important;
}

/* A3. 每日放送浮层宽度钳制（340px 定宽在 ≤360px 手机上溢出） */
html.fnos-compact #fntv-hot-panel{ width:min(340px,calc(100vw - 20px)) !important; }

/* ═══════════ B. fnos-narrow（≤640px）手机整版 ═══════════ */

/* B1. 首页悬浮 logo 缩小：390px 下与原生顶栏搜索/头像图标过近 */
html.fnos-narrow #tb-logo{ height:20px !important; }

/* B2. 季页/竖版电影页 hero：横向「海报+信息」行改纵向堆叠。
   根因：信息列原生 w-[calc(100%-246px)]，390px 下只剩 52px —— 标题一字一行、
   播放按钮(150px)溢出屏幕右缘。竖版电影一级页走 O 段满屏聚簇，排除。 */
html.fnos-narrow body:not(.fnos-movie-panel) .semi-always-dark[class*="h-[470px]"]{
  height:auto !important; min-height:0 !important;
  padding-left:16px !important; padding-right:16px !important;
}
html.fnos-narrow body:not(.fnos-movie-panel) .semi-always-dark[class*="h-[470px]"] > [class*="pt-[116px]"]{
  flex-direction:column !important; align-items:flex-start !important;
  gap:14px !important; padding-top:72px !important; padding-bottom:20px !important;
}
html.fnos-narrow body:not(.fnos-movie-panel) .semi-always-dark[class*="h-[470px]"] [class*="h-[320px]"][class*="w-[214px]"]{
  width:126px !important; height:189px !important;
}
html.fnos-narrow body:not(.fnos-movie-panel) .semi-always-dark[class*="h-[470px]"] [class*="w-[calc(100%-246px)]"]{
  width:100% !important;
}

/* B3. 系列/电影一级页玻璃聚簇：窄屏下简介不再让位 57% 右栏，TMDB 卡从绝对定位右列
   回流为块级（DOM 末位，自然排在简介/季选之后），聚簇整体变高、内部可滚。 */
html.fnos-narrow body.fnos-series-panel ${SERIES_PANEL},
html.fnos-narrow body.fnos-movie-panel ${MOVIE_PANEL}{
  left:12px !important; right:12px !important; width:auto !important;
  bottom:12px !important;
  padding:14px 14px 12px !important;
  max-height:min(58vh,520px) !important;
  overflow-y:auto !important; overflow-x:hidden !important;
  -webkit-overflow-scrolling:touch;
}
html.fnos-narrow body.fnos-series-panel ${SERIES_PANEL} > div[class*="text-justify"],
html.fnos-narrow body.fnos-movie-panel ${MOVIE_PANEL} > div[class*="text-justify"]{
  width:100% !important;
}
html.fnos-narrow body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"],
html.fnos-narrow body.fnos-movie-panel ${MOVIE_PANEL} > div[class*="flex-wrap"]{
  width:100% !important;
}
html.fnos-narrow body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] > [data-id="details"]{
  width:calc(33.33% - 10px) !important;
}
html.fnos-narrow body.fnos-series-panel ${SERIES_PANEL} > .fnos-beautify-card,
html.fnos-narrow body.fnos-movie-panel ${MOVIE_PANEL} > .fnos-beautify-card{
  position:static !important;
  top:auto !important; bottom:auto !important; left:auto !important; right:auto !important;
  width:auto !important; margin:12px 0 0 !important; padding:0 !important;
  max-height:none !important; overflow:visible !important;
}

/* B4. 悬浮按钮行：窄屏换行（播放键 + 收藏/已看/更多圆钮一排放不下） */
html.fnos-narrow body.fnos-series-panel ${SERIES_BTNROW},
html.fnos-narrow body.fnos-movie-panel ${MOVIE_BTNROW}{
  left:12px !important; right:12px !important; width:auto !important;
  bottom:calc(var(--fnos-cluster-h, 360px) + 20px) !important;
  flex-wrap:wrap !important; row-gap:10px !important;
}
html.fnos-narrow body.fnos-series-panel ${SERIES_BTNROW} div[class*="size-[54px]"],
html.fnos-narrow body.fnos-movie-panel ${MOVIE_BTNROW} div[class*="size-[54px]"]{
  width:44px !important; height:44px !important;
}

/* B5. 轮播：标题 3.3rem/简介 600px 均为桌面尺度，390px 下溢出裁切。
   三套皮肤共用 .fnos-slide-* 类名，一份规则全覆盖；简介钳 3 行。 */
html.fnos-narrow [data-fntv-carousel-style] .fnos-slide-content{
  padding:14px 16px 34px !important;
}
html.fnos-narrow [data-fntv-carousel-style] .fnos-slide-meta{
  font-size:.66rem !important; margin-bottom:.3rem !important;
}
html.fnos-narrow [data-fntv-carousel-style] .fnos-slide-title{
  font-size:1.6rem !important; line-height:1.2 !important;
}
html.fnos-narrow [data-fntv-carousel-style] .fnos-slide-title-logo-img{
  max-height:64px !important; max-width:74% !important;
}
html.fnos-narrow [data-fntv-carousel-style] .fnos-slide-desc{
  font-size:.8rem !important; line-height:1.55 !important; max-width:100% !important;
  margin-bottom:.7rem !important;
  display:-webkit-box !important; -webkit-line-clamp:3 !important;
  -webkit-box-orient:vertical !important; overflow:hidden !important;
}

/* B5b. 轮播样式 4（s4 3D 卡片）：容器内联 aspect-ratio 16/9 → 390px 下仅 210px 高，
   而信息层(logo 64 + 标题 + 简介 + 按钮列)按桌面尺度排 ≈ 260px+ → 文字向上溢出被裁。
   窄屏：容器加高到 240px + 信息层全面收紧（logo 40/标题 1.2rem/简介钳 2 行/按钮横排缩小），
   圆点指示器下移避开按钮行。 */
html.fnos-narrow [data-fntv-carousel-style="4"]{
  aspect-ratio:auto !important; height:240px !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-bg{ padding:12px 14px 44px !important; }
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-info{
  padding:10px 14px 38px !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-info .meta{
  font-size:.6rem !important; margin-bottom:.2rem !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-title-logo-img{
  max-height:40px !important; max-width:70% !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-info h3{
  font-size:1.2rem !important; margin-bottom:.2rem !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-info .desc{
  font-size:.72rem !important; line-height:1.5 !important; max-width:100% !important; margin-bottom:.5rem !important;
  display:-webkit-box !important; -webkit-line-clamp:2 !important;
  -webkit-box-orient:vertical !important; overflow:hidden !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-actions{
  flex-direction:row !important; align-items:center !important; gap:.5rem !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-play,
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-detail{
  padding:.5rem 1.1rem !important; font-size:.72rem !important;
}
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-dots{ bottom:12px !important; }
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-nav{
  width:32px !important; height:56px !important; font-size:1.7rem !important;
}

/* B6. 观影记录面板（全屏浮层）：桌面侧 padding 40px/双列图表在手机上挤爆 */
html.fnos-narrow #fntv-wh .wh-topbar{ padding:16px 16px 10px !important; gap:14px !important; }
html.fnos-narrow #fntv-wh .wh-title{ font-size:26px !important; }
html.fnos-narrow #fntv-wh .wh-section{ padding:0 16px !important; }
html.fnos-narrow #fntv-wh .wh-chart-split{ grid-template-columns:1fr !important; }
html.fnos-narrow #fntv-wh .wh-stat-row{ grid-template-columns:repeat(2,1fr) !important; }
html.fnos-narrow #fntv-wh-topbtns{
  top:10px !important; right:10px !important; max-width:calc(100vw - 20px) !important;
  height:auto !important; min-height:44px !important; flex-wrap:wrap !important;
}

/* B7. 设置面板：左分类导航改顶部横滑行（竖排 130px 导航 + 180px 内容在手机上没法看）。
   overlay 子节点 = [0]头部 [1]搜索框(lc-1065) [2]bodyRow(导航+内容) [3]底部弹簧 */
html.fnos-narrow #fnos-settings-panel > div:nth-child(3){ flex-direction:column !important; }
html.fnos-narrow #fnos-settings-panel > div:nth-child(3) > div:first-child{
  flex:0 0 auto !important; max-width:none !important; min-width:0 !important;
  flex-direction:row !important; align-items:center !important;
  overflow-x:auto !important; overflow-y:hidden !important;
  padding:6px 8px !important; gap:6px !important;
  scrollbar-width:none !important;
}
html.fnos-narrow #fnos-settings-panel > div:nth-child(3) > div:first-child::-webkit-scrollbar{ display:none !important; }
html.fnos-narrow #fnos-settings-panel > div:nth-child(3) > div:first-child > button{
  flex:0 0 auto !important; width:auto !important; text-align:center !important;
}

/* B8. 沉浸层顶部留白随顶栏收紧（演职人员作品面板 .fpw-card 162px 定宽可自适应换行，无需处理） */
html.fnos-narrow .fnos-instant-layer__lines{ padding-top:84px !important; }
`;

registerHook(HookType.OnReady, installMobileStyle);
registerHook(HookType.OnDomChange, ensure);
export {};
