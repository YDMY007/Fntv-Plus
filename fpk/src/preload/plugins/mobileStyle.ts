// preload/plugins/mobileStyle.ts — 手机浏览器/窄视口适配层（fpk 网页端专属）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：飞牛影视网页端 #root 被站点自身钉了 min-width:820px（实测来自站点自有样式表
// 资产 /v/assets/*.css 的 #root{width:100%;min-width:820px}，是条完全正常、可被
// getComputedStyle 解析的规则），手机竖屏(≤640px)下整页按桌面宽渲染再被裁切 ——
// 用户报「浏览器访问整个界面乱套」。本模块是**纯增量适配层**：不改任何插件的既有
// 行为，只在窄视口下追加覆盖样式。
//
// 三断点（与 beautifyStyle 的 fnos-touch-narrow(641px) 对齐，不与其冲突）：
//   html.fnos-compact  ≤820px —— 结构性兜底：解除 #root 820px 裁切、设置/弹层宽度钳制。
//       覆盖平板竖屏(768px)等「装不下桌面布局」的区间。
//   html.fnos-narrow   ≤640px —— 手机整版：季页/电影页 hero 单列化、系列页玻璃聚簇
//       改窄屏排布（简介满宽 + TMDB 卡回流）、轮播文字缩小、观影记录/设置面板移动化。
//   html.fnos-touch    真触摸设备（不分宽窄）—— 只装「触摸语义」规则：安全区内边距、
//       触控目标尺寸、:hover 降级为 :active。桌面窄窗口不装（桌面用鼠标，hover 本就可用）。
//
// 优先级策略：本样式表在 boot 时注入（早于各插件懒注入的样式表），同特异性会输给
// 后注入者 → 所有与插件规则对抗的声明一律 !important + 带 html.fnos-* 前缀抬特异性
// （比 beautifyStyle 最长链多出 html.fnos-narrow 两级，恒定胜出）。
// 视口跨断点时派发一次 window resize：tmdbCard 的 --fnos-cluster-h 悬浮簇测高、
// 列表截断库等按 resize 重算的 JS 布局随之刷新。
//
// ⚠ 已知冲突（勿用「加特异性」硬压，见 §D）：carousel/styles.ts 的轮播手机段用
// beautifyStyle 装的 fnos-touch-narrow 门控，本文件 B5b 用 fnos-narrow，两者同为
// ≤640 但前者多一层触摸判定 → 真手机上 B5b 全段失效。已在 §D 统一由本文件接管。
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

/** [lc-1319] UI 模式（手动）：'mobile' = 手机/平板布局，'desktop' = 电脑布局（默认）。
 *  取代原先「触屏能力 × 视口宽」的自动判定 —— 该判定在带触摸的桌面环境反复误伤
 *  （lc-1308~1318 一串"内置/外置不一致""PC 被卷进来"问题的共同源头）。改为首页浮层
 *  「UI 模式」按钮手动切换（uiModeToggle.ts），选择持久化在 localStorage 跨会话记忆。
 *  fnos-narrow / fnos-compact / fnos-touch-narrow 三个布局标记统一由它决定；
 *  fnos-touch（设备触摸能力）仍由 isTouchDevice() 判定（纯交互层语义，与布局无关）。 */
export type UiMode = 'mobile' | 'desktop';
export const UI_MODE_KEY = 'fntv_ui_mode';
export const UI_MODE_EVENT = 'fntv:ui-mode';
export function getUiMode(): UiMode {
  try { return localStorage.getItem(UI_MODE_KEY) === 'mobile' ? 'mobile' : 'desktop'; } catch { return 'desktop'; }
}
export function setUiMode(mode: UiMode): void {
  try { localStorage.setItem(UI_MODE_KEY, mode); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(UI_MODE_EVENT, { detail: mode })); } catch { /* ignore */ }
}

let _uiModeBound = false;   // [lc-1319] UI_MODE_EVENT 只绑一次

/** 是否真触摸设备（设备硬事实，不随窗口/鼠标移动而变）。
 *  刻意不用 @media (pointer:coarse) / (hover:hover)：截图与自动化工具会重置指针模拟，
 *  导致桌面预览时安全区/触控规则整段失灵（与 danmakuWeb / beautifyStyle 同一约定）。
 *  maxTouchPoints 出厂即定；ontouchstart 在无触屏桌面 Chrome 里同样为真，故需并取。
 *  判定口径与 beautifyStyle.isTouchCapable 一致；此处另存一份是因为本模块必须
 *  零插件依赖（它是最底层适配层，不能反过来 import 美化样式表）。 */
function isTouchDevice(): boolean {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  } catch { return false; }
}

/** 按手动 UI 模式挂/摘布局标记类（幂等）。[lc-1319] 布局标记与视口宽解耦：
 *  mobile = 手机/平板布局（fnos-narrow + fnos-compact + fnos-touch-narrow 全开）、
 *  desktop = 电脑布局（全关）。视口宽/触屏能力不再参与布局决策 —— 带触摸屏的
 *  桌面环境（Windows 触屏本、内置浏览器）此前会被自动判定卷进手机布局，
 *  lc-1308~1318 一串不一致问题皆源于此。 */
function applyViewportFlags(): void {
  const html = document.documentElement;
  const mobile = getUiMode() === 'mobile';
  const wasMobile = html.classList.contains('fnos-touch-narrow');
  html.classList.toggle('fnos-narrow', mobile);
  html.classList.toggle('fnos-compact', mobile);
  // fnos-touch 保留设备触摸能力判定（纯交互层语义：安全区/热区/hover 降级），与布局无关
  html.classList.toggle('fnos-touch', isTouchDevice());
  // fnos-touch-narrow 是全站手机/平板布局唯一门控（底栏两行、自建面板、轮播样式 5、
  // 卡片尺寸、播放页字号……）。lc-1290 起本模块即为安装点（首页也装），
  // beautifyStyle / danmakuWeb 两处幂等共用同一判定来源。
  html.classList.toggle('fnos-touch-narrow', mobile);
  // 行内兜底：#root 的 820px 钉宽来自站点自有样式表，样式表层已有 !important 覆盖，
  // 这里再钉一份行内 !important 兜住「站点样式后加载/被重建」的时序。电脑布局必须摘除。
  const root = document.getElementById('root');
  if (root) {
    if (mobile) root.style.setProperty('min-width', '0', 'important');
    else if (root.style.minWidth === '0px' || root.style.getPropertyValue('min-width') === '0') root.style.removeProperty('min-width');
  }
  if (mobile !== wasMobile) {
    // 模式切换：让按 resize 重算的 JS 布局（悬浮簇测高/文本截断）刷新一次
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
  // [lc-1319] 不再监听视口宽（布局标记与视口宽已解耦）；改为监听手动 UI 模式切换事件。
  if (!_uiModeBound) {
    _uiModeBound = true;
    try { window.addEventListener(UI_MODE_EVENT, () => applyViewportFlags()); } catch { /* ignore */ }
    // [lc-1320] 首访初始化：本地无选择时按当前窗口尺寸给一次初值并**固化**（窄窗=手机版、
    //   宽窗=电脑版）——只发生一次，之后永远以手动选择为准（不随窗口变化再翻转，
    //   与已废除的"持续自动判定"是两个东西）。
    try {
      if (localStorage.getItem(UI_MODE_KEY) === null) {
        const narrow = Math.min(window.innerWidth, window.innerHeight) <= 820;
        setUiMode(narrow ? 'mobile' : 'desktop');
      }
    } catch { /* ignore */ }
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
/* [lc-1324] 手机模式顶栏优化（用户报「顶部切换手机模式要优化」）。真机实测：
   顶栏行两侧内边距 44px + 右侧 268px 图标群 shrink-0 → 标题块（"首页"）只剩
   34px 宽（scrollWidth 74）被截成一个字；居中 logo 又夹在刷新按钮与原生图标
   之间相贴。三项收口（改后实测：标题块 142px 完整放下、图标群右移不再相贴）：
   ① 内边距 44→16、② 顶栏高 80→64（移动端紧凑标准）、
   ③ 居中 logo 的 top 40→32（logo 是 fixed，原 40 对齐的是 80px 旧顶栏中线）。 */
html.fnos-narrow [class*="justify-between"][class*="px-11"]{
    padding:11px 16px !important;   /* 横向 44→16；纵向 py-5(20)+内容42=82 撑破 64 外层 → 11+42+11=64 与外层等高 */
}
html.fnos-narrow [class*="h-[80px]"][class*="bg-[var(--semi-color-bg-1)]"]{
    height:64px !important;
}
html.fnos-narrow #tb-logo{ top:32px !important; }
/* [lc-1325] 页面级左留白收窄（用户报「下面的卡片全部左移，左边空距太大了」）：
   首页标题用 px-11(44px)、卡片横滑行用任意值类 pl-[44px] —— 44px 左空距与卡片
   间隙（8/16px）形成刺眼的不对称（实测首卡 x=44、卡间隙 8）。移动端标准留白
   16px，两种写法一并收口（改后实测：三条横滑行 padL=16、首卡 x=16）。 */
html.fnos-narrow [class*="px-11"]{
    padding-left:16px !important; padding-right:16px !important;
}
html.fnos-narrow [class*="pl-[44px]"]{
    padding-left:16px !important;
}

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

/* B5c. [lc-1290] 轮播左右黑框（用户报「轮播图左右黑框」）。
   逐层算 390px 视口下的宽度预算：
     视口 390 − wrapper 内联 padding 0 44px = 302
     再 − 媒体库 section 自身 px-[44px]/px-[46px] ≈ 256
     容器 aspect-ratio 16/9 → 390 宽下仅 144~170px 高，两侧各空 44~67px。
   即：轮播并没有铺满，是被两层各 44px 的内边距夹成了窄条，两侧露出的就是 section 底色
   （暗色主题下呈黑）。三步收口：
     ① wrapper 内联 padding 由 44px 收到 8px（carousel/styles.ts 的 16px 规则现已在
        首页生效——它此前挂在从未安装的 fnos-touch-narrow 上，是死代码；这里用更小的值
        并在自己的层重新声明，避免依赖那个门控）；
     ② section 的 px-[44px]/px-[46px] 一并收窄（wrapper 的父级，宽是叠乘的，只收一层不够）；
     ③ 容器给一个下限高度，免得 16:9 在窄屏下塌成一条。
   边距不能收成 0：轮播右侧有 prev/next 导航钮（left/right:3%）与圆点，完全贴边会被切。 */
html.fnos-narrow [data-fntv-carousel-wrapper]{ padding-left:8px !important; padding-right:8px !important; }
/* 媒体库 section 是 wrapper 的**父级**（render.ts 里是 target.appendChild(wrapper)），
   只能向上选：用 :has(> [data-fntv-carousel-wrapper]) 绑定父级，不能写成子代选择器。
   :has() 自 Chrome 105 / Safari 15.4 / FF 121 起可用，不支持时只是这条不生效，
   下面的 wrapper 收边距仍会把黑框从 67px/侧 降到 44px/侧。 */
html.fnos-narrow div[class*="flex-col"]:has(> [data-fntv-carousel-wrapper]){ padding-left:8px !important; padding-right:8px !important; }
html.fnos-narrow [data-fntv-carousel-style="4"]{ height:min(46vw, 260px) !important; aspect-ratio:auto !important; max-height:none !important; }

/* B5d. [lc-1290] 样式 4 的 3D 邻卡在窄屏露太多（±72% 位移把邻卡大半推出/拉进画面，
   390px 下视觉上就是两侧各糊一块）。收到 ±58% 且缩小，只露边缘暗示可滑。
   同 B5c：carousel/styles.ts 里已有同样数值，但那段在首页是死代码，这里独立生效。 */
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-card{ left:2% !important; top:2% !important; width:96% !important; height:96% !important; border-radius:14px !important; }
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-card.prev{ transform:scale(.88) translateX(-46%) rotateY(18deg) !important; }
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-card.next{ transform:scale(.88) translateX(46%) rotateY(-18deg) !important; }
/* 左右切换钮（宽 32px + 3% 边距 ≈ 44px 触控区）：压到卡片下层，点空白不再被抢 */
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-nav{ width:28px !important; opacity:.4 !important; }
html.fnos-narrow [data-fntv-carousel-style="4"] .fntv-s4-nav:active{ opacity:1 !important; }

/* B5e. 右侧竖向海报条（仅样式 1 有，render.ts:404 行内 width:150px）：
   手机上与容器 80/20 分栏争宽，容器只剩 302*0.8=242px 还要被它挤。窄屏直接隐藏海报条，
   改为上下滑手势换片（render.ts 已有 touchstart/touchend 手势，见 lc-1288）。 */
html.fnos-narrow .fnos-poster-strip{ display:none !important; }

/* B9. [lc-1290→lc-1310 对齐原生 App 尺度] 首页卡片行（继续观看 / 剧集列表）。
   lc-1306 修好了横版裁剪；lc-1310 按飞牛原生手机 App（FN_Media 1.12.0 apk 截图逐像素
   实测，480dp 屏宽基准）统一两行的密度：
   ── 原生实测规格 ──
   屏边距 20dp；竖版海报卡宽 140dp（29.2% 屏宽）、间距 10dp（2.1%），一屏整 3 张
   （3×140+2×10+2×20=480 闭合）；继续观看横版卡与海报行**同宽 140dp**、图区比例
   1.89:1（140:74），一屏露出 1.9 张（第二张露 60% 暗示可滑）。
   ── 对照现状的改动 ──
   竖版卡 27vw→29vw（105px→113px，多显 2 字）；间距 8px→2.1vw（390px 下 8.2px 等值，
   平板按比例放大）；继续观看卡 46vw→44vw（180px→172px，右侧露出邻卡边缘暗示可滑）。 */
html.fnos-narrow .ms-container [class*="card-root"],
html.fnos-narrow .ms-container [class*="poster-box"]{
  min-width:0 !important;
  width:clamp(96px, 29vw, 132px) !important;
  flex:0 0 clamp(96px, 29vw, 132px) !important;
}
/* B9.1 继续观看卡横版化：16:9 大卡（Netflix 移动端 Continue Watching 同款形态）。
   lc-1310: 46vw→44vw —— 原生实测继续观看与海报行同宽 29.2%、间距 10dp，一屏露出
   1.9 张；44vw 在 390px 是 171.6px，右侧露出约 40% 邻卡，滚动暗示与原生一致。 */
html.fnos-narrow .ms-container .continue-card-root{
  width:min(44vw, 172px) !important;
  flex:0 0 min(44vw, 172px) !important;
}
/* 海报区（> div:first-child 是桌面定高 172px 的那层）与卡内死宽层一并收口：
   实测链路 continue-card-root > rounded-lg(定高172) > continue-poster-box > div > div(width:104px)，
   每层都要 width:100%，漏一层图就只铺 104px。 */
html.fnos-narrow .ms-container .continue-card-root > div:first-child{
  height:auto !important; aspect-ratio:16/9 !important;
}
html.fnos-narrow .ms-container .continue-card-root .continue-poster-box,
html.fnos-narrow .ms-container .continue-card-root .continue-poster-box > div,
html.fnos-narrow .ms-container .continue-card-root .continue-poster-box > div > div{
  width:100% !important; height:100% !important;
}
/* B9.2 卡宽自适应后的排版收紧（真机实测：15px 标题在 105px 下只显 6 字） */
html.fnos-narrow .ms-container [class*="card-root"] [class*="text-[15px]"]{
  font-size:13px !important; line-height:1.35 !important;
}
html.fnos-narrow .ms-container [class*="card-root"] [class*="text-xs"]{
  font-size:11px !important;
}
/* 卡片间距对齐原生 10dp（2.1vw；390px 下 ≈8.2px 与上一版等值，平板按视口放大） */
html.fnos-narrow .ms-container [class*="card-root"]{ margin-right:2.1vw !important; }
html.fnos-narrow .ms-container .continue-card-root{ margin-right:2.1vw !important; }
/* 卡片内的进度条/操作层随卡宽自适应（站点按固定宽算的内联值会溢出） */
html.fnos-narrow .ms-container [class*="card-root"] img,
html.fnos-narrow .ms-container [class*="poster-box"] img{ max-width:100% !important; }
/* 行间距收窄：站点 gap 20px（gap-x-5）在 132px 卡宽下占比过高 */
html.fnos-narrow .ms-container > *{ gap:10px !important; }

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

/* ═══════════ C. fnos-touch（真触摸设备，不分宽窄）触摸语义层 ═══════════
   这一段只装「鼠标时代不存在、触摸必须补」的东西：安全区、触控目标、按压反馈。
   桌面窄窗口不装 —— 桌面用鼠标，hover/精确点击本就正常，套上去反而碍事。 */

/* C1. 安全区内边距。viewport-fit=cover 由 Go 注入层补齐（inject.go patchViewport），
   没有它 env() 恒为 0，本段整体失效 —— 两处必须成对存在。
   写法取 Jellyfin 的 conditional-max 渐进增强：先给默认值，再用 @supports(max())
   探测覆盖为 max(安全区, 默认值)。max() 自 Chrome 79 / Safari 11.1 / FF 75 起可用，
   老浏览器拿到默认值不会因整条声明失效而丢掉内边距。 */
html.fnos-touch #fnos-settings-panel{
  padding-bottom:env(safe-area-inset-bottom,0px);
}
@supports (padding:max(0px,env(safe-area-inset-bottom))){
  html.fnos-touch #fnos-settings-panel{
    padding-bottom:max(env(safe-area-inset-bottom),16px);
  }
}

/* C2. 顶栏悬浮按钮/搜索等贴顶元素下压，避开刘海屏与状态栏。
   抽屉遮罩与全屏浮层同理（原本从 0 开始，正好压在刘海上）。 */
html.fnos-touch #fntv-wh-topbtns{
  top:calc(10px + env(safe-area-inset-top,0px)) !important;
}
html.fnos-touch .fnos-instant-layer__lines{
  padding-top:calc(84px + env(safe-area-inset-top,0px)) !important;
}

/* C3. 关闭 iOS 长按弹出的「拷贝/查找/分享」系统菜单 —— 播放器控件、进度条、
   弹幕列表上长按会直接破坏交互（Jellyfin videoOsd 同款做法）。 */
html.fnos-touch .fnos-instant-layer,
html.fnos-touch .fnos-instant-layer *{
  -webkit-touch-callout:none;
}

/* C4. 触控目标下限 44px（WCAG 2.1 AAA / 满足 2.2 AA 的 24px 硬下限）。
   只垫高「本来就小、且触控时必须点中」的图标/胶囊按钮，不动卡片/导航项等大块区域。
   观影记录悬浮条里的按钮是 .wh-pill（胶囊），靠 padding 撑到 ~34px 高，触摸下偏小。 */
html.fnos-touch #fntv-wh-topbtns .wh-pill{ min-height:44px !important; }
html.fnos-touch .fntv-hot-block{ min-width:44px !important; min-height:44px !important; }
html.fnos-touch .fntv-dm-list li{ min-height:40px !important; }

/* C5. 按压反馈：触摸端没有 hover，但有 :active。给纯图标按钮补一个按压态，
   避免「按下去没有任何反馈」的手感断裂（Prime Video 的 scale(.9) 同思路）。 */
html.fnos-touch #fntv-wh-topbtns .wh-pill:active,
html.fnos-touch .fntv-hot-block:active{
  opacity:.7 !important;
  transform:scale(.92);
}
/* C6. 去掉 Android 点击蓝块（Jellyfin card.scss 同款），改由 :active 统一表达。 */
html.fnos-touch button,
html.fnos-touch [role="button"]{
  -webkit-tap-highlight-color:transparent;
}

/* ═══════════ D. hover 依赖降级（fnos-touch）═══════════
   触摸设备上 :hover 可能永不匹配、也可能 tap 后粘住不消失（MDN :hover 明确列出
   这三种行为）。对「hover 才出现」的交互补一个常驻可见的等价物，而不是简单禁用。
   涉及的具体组件见 §D1~§D3 注释。 */

/* D1. 每日放送「不感兴趣」按钮：桌面默认 opacity:0 靠 :hover 浮现，手机上永久隐藏。
   触摸端直接常驻可见（改为半透明常态 + 按压态全亮，不用纯 opacity 硬常亮以免抢戏）。 */
html.fnos-touch .fntv-hot-card .fntv-hot-block{
  opacity:.55 !important;
  transform:none !important;
}
html.fnos-touch .fntv-hot-card .fntv-hot-block:active{
  opacity:1 !important;
}

/* D2. 轮播样式 4 手机版：**收回** carousel/styles.ts 里「文字层整层 display:none」那套。
   那段挂在 fnos-touch-narrow 下，与本文件的 fnos-narrow 同为 ≤640、但多一层触摸判定，
   特异性更高 → B5b 精心写的收紧版式（logo/标题/简介/按钮）整段失效，手机上只剩一张
   光秃秃的海报。改由 §B5b 一处统一接管：给 info 层显式 display 复位 + 手机排版。
   两种标记类同时存在时本段胜出（后注入且 !important），行为回到「收紧而非隐藏」。 */
html.fnos-touch [data-fntv-carousel-style="4"] .fntv-s4-info{
  display:block !important;
}
/* D3. 触摸端把纯 hover 才亮起的元素补常驻底色，避免「tap 后粘住不消失」或永不出现。
   这里只处理高价值的两个（卡片抬升/播放键），不做全站 hover 翻版。 */
html.fnos-touch .wh-card:hover{
  transform:none !important;   /* tap 后粘住的抬升会让整页卡片错位，直接取消 */
}

/* ═══════════ E. 滚动锁定工具（fnos-touch）═══════════
   弹层打开时禁止背景跟着滚。优先用 CSS 的 overscroll-behavior（不锁 body，
   iOS 上不会滚动穿透/位置丢失）；不支持时才退化锁 body。
   挂到 html.fnos-scroll-lock 上，由 JS 在弹层开/关时增删。 */
html.fnos-scroll-lock{
  overflow:hidden !important;
  overscroll-behavior:contain;
  touch-action:none;
}

/* ═══════════ F. 弹层窄屏溢出收口（fnos-compact，与宽窄同判，不分触摸）═══════════
   这批组件都是**行内 cssText 钉死尺寸**（dialogUI:113 min-width:420px、
   modals/feedback.ts:96/221 width:320px、modals/patch.ts:71 width:340px、
   watchHistory.ts:492 grid 6fr/4fr）。行内样式只能靠 !important 压，压不动就只能
   溢出屏幕外 —— 360px 屏上必然出事。集中在这里收口，避免逐个插件改行内值。 */

/* F1. dialogUI 卡片：min-width 在 CSS 里优先于 max-width，420px 硬顶会击穿窄屏。
   窄屏直接撤掉 min-width，改由 max-width:calc(100vw - 32px) 决定。 */
html.fnos-compact #fnos-dialog-overlay [data-fnos-dialog-card="1"]{
  min-width:0 !important;
  width:calc(100vw - 32px) !important;
  max-width:calc(100vw - 32px) !important;
  padding:18px 16px 14px !important;
}
/* F2. 反馈/QQ群弹窗 300~320px 定宽 + 22~24px padding → 360px 下溢出，统一夹到视口内。 */
html.fnos-compact #fnos-feedback-modal,
html.fnos-compact #fnos-feedback-choice-modal,
html.fnos-compact #fnos-qq-group-modal{
  width:calc(100vw - 32px) !important;
  max-width:340px !important;
  padding:18px 16px !important;
}
/* F3. 补丁弹窗 340px 定宽（无 max-width），同上收口。 */
html.fnos-compact #fntv-patch-apply-popup{
  width:calc(100vw - 32px) !important;
  max-width:340px !important;
}
/* F4. 观影记录详情浮层：双栏 grid 6fr/4fr 在窄屏会把左栏压到装不下海报，
   单列化（与 B6 的 .wh-chart-split 单列保持一致）。
   .wh-detail 嵌在 #fntv-wh 面板内，选择器必须带面板 ID 前缀才命中。 */
html.fnos-narrow #fntv-wh .wh-detail{
  grid-template-columns:1fr !important;
}
/* F5. 观影记录详情里的海报/预览在单列下按视口宽自适应，避免固定宽高溢出。 */
html.fnos-narrow #fntv-wh .wh-detail img{
  max-width:100% !important;
  height:auto !important;
}

`;

registerHook(HookType.OnReady, installMobileStyle);
registerHook(HookType.OnDomChange, ensure);
export {};
