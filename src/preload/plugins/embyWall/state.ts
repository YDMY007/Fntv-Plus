// embyWall/state.ts
// ─────────────────────────────────────────────────────────────────────────────
// 职责：跨模块共享的**可变**运行时状态。这是整个 embyWall 中唯一允许「被多个业务
//       模块读写」的地方。
//
// 为什么用「可变容器对象 S」而不是 export let：
//   TypeScript 禁止对命名空间导入的绑定赋值（TS2540: Cannot assign to 'foo'
//   because it is a read-only property，见 scripts 下拆分前的实测）。因此这里导出
//   一个可变对象，读写统一走 `S.xxx`，既能赋值又是活绑定（live binding），
//   且把「这是共享状态」显式写在调用点，读代码时一眼能看出耦合点。
//
// 铁律：
//   1. 只被单个模块使用的状态 → **不许**放这里，留在该模块内部（私有）。
//      本文件只放拆分前经耦合分析确认「被 ≥2 个功能区引用」的状态。
//   2. 这里只放「数据」，不放「逻辑」。任何操作这些状态的函数都应归属其业务模块。
//   3. 新增字段必须写注释说明「谁写、谁读」，否则三个月后没人敢动。
// ─────────────────────────────────────────────────────────────────────────────

/** 轮播数据源的取值来源 */
export type HotSource = 'tmdb' | 'douban';

export const S: {
  // ── 调试日志 ───────────────────────────────────────────────────────────────
  /** EmbyWall 渲染日志独立开关。写：log.ts（主进程 debug-filter 下发）；读：log.ts */
  logEnabled: boolean;

  // ── 功能开关（用户可在设置面板切换，运行时缓存）────────────────────────────
  /** 详情页「关闭背景框」：true=恢复 fnOS 原生外观；false=保留玻璃背景框(默认)。
   *  写：settings/*；读：detail/* */
  detailBoxless: boolean;
  /** 鼠标滚轮横向滚动：true=开启(默认)；false=恢复飞牛原生上下滚。
   *  写：settings/*；读：carousel/index.ts(wheelToScroll) */
  wheelHScrollEnabled: boolean;
  /** 「热门剧更新」数据源，默认豆瓣。写：settings/*；读：carousel/api.ts */
  hotSource: HotSource;
  /** 轮播标题替换成 TMDB 透明 Logo：true=替换(默认)；false=保留文字标题。
   *  写：settings/*；读：carousel/logo.ts */
  carouselLogoEnabled: boolean;

  // ── 片库数据（轮播数据源）───────────────────────────────────────────────────
  /** 经 IPC 拉取到的条目池。写：carousel/api.ts；读：carousel/index.ts、carousel/styles.ts */
  apiShows: any[];
  apiLoaded: boolean;
  apiLoading: boolean;

  // ── 轮播运行时（DOM 引用 / 生命周期）────────────────────────────────────────
  /** 已渲染轮播的 DOM 引用，供设置切换即时应用/还原，无需等下次导航。
   *  写：carousel/index.ts；读：carousel/*、入口 ensureHomepageEnhanced */
  carouselInfos: HTMLElement[];
  carouselShows: any[];
  carouselBase: string;

  carouselInited: boolean;
  /** [lc-615] 轮播是否已揭示(进度条走完)。详情补完的二次重建只有在已揭示后才执行,
   *  否则会绕过进度条提前出图(用户看到"进度条 20% 就闪出轮播")。 */
  carouselRevealed: boolean;
  /** [lc-937] 是否「离开过首页」。离开首页时置 true，返回首页后强制干净重建轮播，重建完成后复位。
   *  用于避免 in-home 的 replaceState 反复重建，同时保证「轮播按钮打开的详情返回首页」必定重建。 */
  leftHome: boolean;
  carouselContainer: HTMLElement | null;
  carouselUpdatedAt: number;   // 数据就绪时间戳，用于标题旁显示「更新于」
  carouselWrapper: HTMLElement | null;
  carouselPosterStrip: HTMLElement | null; // [lc-439] 右侧竖向海报条
  /** 占位只需构建一次。否则 MutationObserver 会在每次占位 DOM 变更后再次调用 injectCarousel
   *  → 反复清空重建占位 → 渲染线程死循环 → 白屏卡死(见 lc-100)。 */
  placeholderInited: boolean;

  // ── 骨架加载进度 ───────────────────────────────────────────────────────────
  /** [lc-561] 抓取过程中实时显示「已加载 N 个」，避免用户干等 */
  carouselProgressEl: HTMLElement | null;
  carouselProgressCount: number;
  /** [lc-583] 0~100 长条加载动画：伪进度递增(0→90%)，数据完成后 completeCarouselProgress 跳 100 */
  carouselProgressTimer: number | null;
  carouselBarFill: HTMLElement | null;
  carouselPctEl: HTMLElement | null;
  carouselStatusEl: HTMLElement | null; // [lc-621] 状态文字(加载中/加载完成)
  carouselProgressPct: number;

  /** [lc-768] 详情拉取完成但「可用横版海报」为 0(疑似全部 STRM/网盘无法加载)
   *  → 主页显示「暂未支持 STRM 海报」。 */
  carouselLoadedButNone: boolean;

  /** [lc-876] 样式 2/3/4 轮播清理句柄。SPA 导航离开/重建前必须清理旧 timer/event listener,
   *  否则 progressInterval 继续操作已移除 DOM、keydown 监听器堆积 → 返回后乱套。
   *  写：carousel/styles.ts(各 buildCarouselStyleX)；读：carousel/index.ts(destroyCarousel) */
  carouselCleanup: (() => void) | null;
  /** [lc-946] 复用轮播时重启自动轮播的钩子(各 buildCarouselStyleX 注册)。
   *  注意：destroyCarousel 不置空它 —— 返回首页需靠它重启自动轮播，
   *  闭包自带 document.body.contains(container) 守卫，指向已游离轮播时自动 no-op。 */
  carouselResume: (() => void) | null;

  // ── 看门狗诊断（仅日志，不改变行为）─────────────────────────────────────────
  diagStuckTicks: number;      // 进度条停在 99% 的 tick 计数
  diagStuckSince: number;      // 首次到达 99% 的时间戳
  diagStuckLogged: boolean;    // 看门狗日志是否已输出（只输出一次）
  diagLastShows: any[];        // 最近一次轮播数据源（供看门狗/异常日志定位）

  // ── 主题 ───────────────────────────────────────────────────────────────────
  /** 设置面板内「主题」分段控件的刷新回调。
   *  写：settings/panel.ts(构建控件时注册)；读：theme.ts(切换主题后回刷 UI) */
  refreshThemeSeg: (() => void) | null;

  // ── 详情页导航（lc-979: 美化模块 immersive.ts/season.ts 已移除, 以下字段休眠保留供重写复用）──
  /** 上一次处理的详情页 href，用于识别「换了一部片子」从而重置季布局观察器 */
  lastDetailHref: string;
  /** 液态玻璃是否已初始化（详情页 → 首页时置 false，见 immersive.ts） */
  detailGlassInited: boolean;
} = {
  logEnabled: false,

  detailBoxless: false,
  wheelHScrollEnabled: false,
  hotSource: 'douban',
  carouselLogoEnabled: true,

  apiShows: [],
  apiLoaded: false,
  apiLoading: false,

  carouselInfos: [],
  carouselShows: [],
  carouselBase: '',

  carouselInited: false,
  carouselRevealed: false,
  leftHome: false,
  carouselContainer: null,
  carouselUpdatedAt: 0,
  carouselWrapper: null,
  carouselPosterStrip: null,
  placeholderInited: false,

  carouselProgressEl: null,
  carouselProgressCount: 0,
  carouselProgressTimer: null,
  carouselBarFill: null,
  carouselPctEl: null,
  carouselStatusEl: null,
  carouselProgressPct: 0,

  carouselLoadedButNone: false,

  carouselCleanup: null,
  carouselResume: null,

  diagStuckTicks: 0,
  diagStuckSince: 0,
  diagStuckLogged: false,
  diagLastShows: [],

  refreshThemeSeg: null,

  lastDetailHref: '',
  detailGlassInited: false,
};

// ── 常量（只读，放这里便于集中调节）────────────────────────────────────────────

/** [lc-768] 轮播目标展示数 */
export const CAROUSEL_TARGET = 10;
/** [lc-768] 候选池上限（多于目标，便于 STRM/网盘海报失败时「往后延」凑齐） */
export const CAROUSEL_SCRAPE_CAP = 18;

// ── 细粒度读写器 ─────────────────────────────────────────────────────────────
// 只有「需要隐藏实现细节」的状态才配读写器；其余直接用 S.xxx 即可。
// 日志开关单独给读写器，是因为 log.ts 需要它，但不该让 log.ts 依赖整个 S 的形状。

export function getLogEnabled(): boolean { return S.logEnabled; }
export function setLogEnabled(v: boolean): void { S.logEnabled = v; }
