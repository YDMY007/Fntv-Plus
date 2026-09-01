# EmbyWall 模块化拆分说明书

> 原 `embyWall.ts` 是 **12496 行**的单体巨石文件。现按「高内聚、低耦合」拆为 `embyWall/` 模块包，
> 入口 `embyWall.ts` 降为 **~4850 行**的「编排层」（只做初始化、装配、事件串联）。
>
> 本文件是给**新维护者**的快速地图：在哪改、依赖怎么走、共享状态放哪、热补丁回溯注意什么。

---

## 1. 设计原则（先读这三条）

1. **入口只编排，不实现。** 任何功能逻辑都进 `embyWall/` 对应模块，入口文件里不要加实现。
2. **共享状态只放 `state.ts`。** 多模块都要读写的运行时状态，统一进 `S`（可变容器对象），禁止在某模块里 `export let` 跨模块赋值（TS2540 会报错）。
3. **依赖倒置，打断循环。** 数据层不反向 import 渲染层；用钩子回调代替直接调用（见 §4）。

---

## 2. 模块地图（目录结构）

```
embyWall/
├── embyWall.ts              ← 入口编排层（handle() 主流程 + 全局初始化 + 模块装配）
├── state.ts                 ← 共享可变状态 S + 只读常量 CAROUSEL_* + 日志开关读写器
├── log.ts                   ← 渲染日志（dlog / log / isSeasonLayoutDebugOn）
├── theme.ts                 ← 主题（UiThemeMode / 应用主题 / 注入样式 / 移除设置项）
├── login.ts                 ← 登录页增强（自动跳影视 / 背景变量）
├── carousel/                ← 轮播（数据 + 渲染 + 样式 + 进度 + 图片 + logo）
│   ├── api.ts               ← 数据源：片库抓取 / IPC 拉取 / 首页到达监听（数据层，不碰 DOM 渲染）
│   ├── render.ts            ← 轮播渲染：injectCarousel 主体、媒体库定位、销毁/恢复
│   ├── href.ts              ← 季详情路由解析 resolveSeasonHref（从 render 拆出，打断循环依赖）
│   ├── styles.ts            ← 三种轮播样式 buildCarouselStyle2/3/4
│   ├── progress.ts          ← 骨架屏 + 加载进度（completeCarouselProgress / updateCarouselProgress）
│   ├── images.ts            ← 鉴权拉图转 blob、backdrop 解析、item 详情、STRM 探测
│   ├── logo.ts              ← TMDB 透明 logo 拉取、标题换 logo、回写媒体库
│   └── logoAsset.ts         ← 内嵌 base64 logo 常量（无依赖叶子）
├── detail/                  ← 详情页（glass 玻璃 / immersive 编排 / season 季详情）
│   ├── glass.ts             ← 苹果液态玻璃：全屏底图、蒙版、透明化、安全选择器
│   ├── immersive.ts         ← 详情页沉浸式总入口（组合 glass + season）
│   └── season.ts            ← 季详情两栏布局、信息卡、集数统计、简介补全
├── nav/                     ← SPA 导航注入
│   ├── inject.ts            ← 外置播放按钮 / 原生返回按钮 / 视频预览外置播放
│   └── scroll.ts            ← 横滑滚轮 wheelToScroll
└── modals/                  ← 弹窗
    ├── feedback.ts          ← 反馈弹窗（ABOUT_LINK_URL / openFeedbackChoiceModal）
    └── patch.ts             ← 应用补丁弹窗 fntvOpenPatchApplyPopup
```

---

## 3. 模块导出面（改功能先找导出符号）

| 模块 | 导出的主要符号 |
|------|---------------|
| `state.ts` | `S`（共享状态容器）、`CAROUSEL_TARGET`、`CAROUSEL_SCRAPE_CAP`、`getLogEnabled/setLogEnabled`、`HotSource`(type) |
| `log.ts` | `log`、`dlog`、`isSeasonLayoutDebugOn` |
| `theme.ts` | `UiThemeMode`(type)、`applyUiTheme`、`getUiTheme`、`getEffectiveDark`、`setUiTheme`、`injectUiThemeStyle`、`removeThemeModeSetting` |
| `login.ts` | `applyLoginBgVar` |
| `carousel/api.ts` | `fetchShowsViaIPC`、`extractTmdbId`、`scrapeVisibleCards`、`waitLibIndex`、`scrapeAllPageFirstScreen`、`setOnShowsReady` |
| `carousel/render.ts` | `injectCarousel`、`destroyCarousel`、`resumeCarousel`、`findMediaLibrarySection`、`isModalOpen` |
| `carousel/href.ts` | `resolveSeasonHref` |
| `carousel/styles.ts` | `buildCarouselStyle2/3/4`、`ensureStyle4Css` |
| `carousel/progress.ts` | `buildLoadingPlaceholder`、`buildStrmUnsupportedTip`、`autoFetchDescs`、`completeCarouselProgress`、`updateCarouselProgress` |
| `carousel/images.ts` | `fetchImageAuth`、`applyCarouselBackdrop`、`fetchItemDetail`、`resolveShowBackdrop`、`scrapeLandscapeBackdrops` |
| `carousel/logo.ts` | `resolveShowLogo`、`applyTitleLogo`、`applyCarouselLogoNow`、`backfillDetailLogo`、`swapTitleToLogo`、`fnosGetEditDetail` |
| `detail/glass.ts` | `isDetailPage`、`safeSelect`、`ensureFullscreenBackdrop`、`removeFullscreenBackdrop` |
| `detail/immersive.ts` | `applyDetailLiquidGlass` |
| `detail/season.ts` | `applySeasonImmersiveDetail`、`resetSeasonObsState`、`unlayoutSeasonTwoPane` |
| `nav/inject.ts` | `injectExternalPlayButton`、`injectNativeReturnButton`、`injectVideoPreviewExternalPlay` |
| `nav/scroll.ts` | `wheelToScroll` |
| `modals/feedback.ts` | `ABOUT_LINK_URL`、`openFeedbackChoiceModal` |
| `modals/patch.ts` | `fntvOpenPatchApplyPopup` |

---

## 4. 依赖规则（铁律）

### 4.1 允许的方向（自上而下，无环）

```
embyWall.ts(入口)
   ├─> carousel/api.ts ──> carousel/progress.ts, carousel/images.ts, state.ts, log.ts, ../../hotUpdates
   ├─> carousel/render.ts ──> carousel/{href,logo,progress,styles,images}.ts, state.ts, log.ts
   ├─> detail/immersive.ts ──> detail/{glass,season}.ts, state.ts, log.ts
   ├─> detail/season.ts ──> carousel/{logo,api}.ts, detail/glass.ts, state.ts, log.ts
   ├─> theme.ts, login.ts, nav/*, modals/* ──> state.ts, log.ts, electron, core/*
   └─> state.ts / log.ts / logoAsset.ts / href.ts  ← 叶子，不依赖任何业务模块
```

### 4.2 三条红线

1. **`state.ts` 是唯一共享状态层。** 新增「被 ≥2 个模块读写」的状态，必须加字段到 `S` 并在注释写明「谁写、谁读」（见 §5）。模块内部的私有状态留在模块里 `let`，不要外泄。
2. **数据层 `api.ts` 禁止 import 渲染层 `render.ts`。** 需要触发轮播渲染时，通过 `setOnShowsReady` 钩子回调（见下），否则 `api ↔ render` 成环。
3. **`render.ts ↔ styles.ts` 不互 import 函数实现。** `render` 要用季路由解析时走 `href.ts` 的 `resolveSeasonHref`（已从 render 拆出，专门打断这条环）。

### 4.3 关键解耦：onShowsReady 钩子（数据层 → 渲染层）

`fetchShowsViaIPC` 内部补完 item 详情、需要揭示轮播时，**不直接调用** `injectCarousel()`，而是：

```ts
// carousel/api.ts
let onShowsReady: (() => void) | null = null;
export function setOnShowsReady(fn: () => void): void { onShowsReady = fn; }
// 详情补完 → revealOnce 内： if (onShowsReady) onShowsReady();
```

接线在**入口（组合根）**一次性完成：

```ts
// embyWall.ts（顶部装配）
setOnShowsReady(injectCarousel);
```

这样 `api.ts` 完全不认识 `render.ts`，依赖方向单向：`api →（钩子）→ render` 由入口缝合。
**改动渲染触发逻辑时，只动 `api.ts` 的回调点 + 入口接线，不要在 api 里 import render。**

---

## 5. 共享状态清单（state.ts 的 `S`）

只读 `S.xxx` 读写；新增字段必须补「谁写/谁读」注释。重点字段：

| 字段 | 写方 | 读方 |
|------|------|------|
| `apiShows` / `apiLoaded` / `apiLoading` | `carousel/api.ts` | 入口、轮播渲染、进度 |
| `diagLastShows` | `carousel/api.ts` | 看门狗/异常日志 |
| `carouselInited` / `carouselRevealed` / `carouselLoadedButNone` | `carousel/render.ts`、`carousel/api.ts`、`carousel/progress.ts` | 渲染层、入口 |
| `carouselContainer` / `carouselWrapper` / `carouselProgressEl`… | `carousel/render.ts`、`carousel/progress.ts` | 渲染层、入口 |
| `carouselCleanup` / `carouselResume` | `carousel/styles.ts`、`carousel/render.ts` | 渲染层 |
| `leftHome` | 入口（导航 hook） | 轮播渲染重建 |
| `lastDetailHref` / `detailGlassInited` | `detail/immersive.ts`、`detail/season.ts` | 详情层 |
| `hotSource` / `carouselLogoEnabled` / `wheelHScrollEnabled` / `detailBoxless` | 设置面板 | 对应功能模块 |

> ⚠️ 仅本模块自用的状态（如 `api.ts` 的 `_carouselWatchArmed`）留在模块内 `let`，**不要**搬进 `S`。

---

## 6. 热补丁路径影响（交接必读）

- 编译产物仍是单文件 `preload/plugins/embyWall.js`（入口 + `embyWall/*` 一起打包），**热补丁 target 路径不变**。
- 但源码已拆分：旧热补丁若针对「原函数名 + 偏移」，回溯时必须**先把函数映射回新模块文件**再改，否则补丁会打到错误位置或失效。
- 回溯步骤：① 从 `patchApplier` 拿到目标函数名 → ② 在本 README §3 导出面 / §7 速查表定位模块文件 → ③ 在模块里改 → ④ 重新 `tsc --noEmit` 验证 → ⑤ 重新打热补丁包。
- 共享状态改动（如改 `S` 字段语义）需同步本 README §5 的清单，避免后续维护者误用。

---

## 7. 「改哪里」速查表

| 想改的功能 | 去哪个文件 |
|-----------|-----------|
| 轮播数据从哪来 / IPC 拉取 / 首页到达监听 | `carousel/api.ts` |
| 轮播 DOM 渲染、媒体库定位、销毁/恢复 | `carousel/render.ts` |
| 轮播三种外观样式 | `carousel/styles.ts` |
| 骨架屏、加载进度条、「已加载 N 个」 | `carousel/progress.ts` |
| 带鉴权拉图转 blob、item 详情、STRM 探测 | `carousel/images.ts` |
| TMDB 透明 logo、标题换 logo、回写媒体库 | `carousel/logo.ts` |
| 内嵌 base64 logo 资源 | `carousel/logoAsset.ts` |
| 季详情路由解析（TV→Season→Episode） | `carousel/href.ts` |
| 详情页苹果液态玻璃底图/蒙版 | `detail/glass.ts` |
| 详情页沉浸式总编排 | `detail/immersive.ts` |
| 季详情两栏布局、信息卡、集数统计、简介 | `detail/season.ts` |
| 主题切换、暗色判定 | `theme.ts` |
| 登录页背景 / 自动跳影视 | `login.ts` |
| 外置播放按钮、原生返回、视频预览外置 | `nav/inject.ts` |
| 横滑滚轮 | `nav/scroll.ts` |
| 反馈弹窗、关于链接 | `modals/feedback.ts` |
| 应用补丁弹窗 | `modals/patch.ts` |
| 渲染日志开关、日志格式 | `log.ts` |
| 任意跨模块共享运行时状态 | `state.ts`（加字段，写注释） |
| 导航/SPA hook、设置面板 `handle()`、模块装配 | `embyWall.ts`（编排层） |

---

## 8. 编译验证

```bash
# 仓库是 CRLF，本地无 node_modules 时用 junction 到本体依赖后：
./node_modules/.bin/tsc --noEmit
# 期望输出：无 error（0 个 TS 错误）
```

> 拆分后务必在改完任一模块后跑一次 `tsc --noEmit`，确认没有「Cannot find name」或「循环依赖」类错误。

---

## 9. 拆分工具（scripts/，可选了解）

- `scripts/embywall-split.js`：批量抽取 / 移动 / 生成 import 头 / 自动补 import（`fiximports`）。
- `scripts/embywall-deps.js`：分析某行区间对外部的依赖（决定 import / export 面）。
- `scripts/embywall-sink.js`：把被跨模块读写的 `let` 下沉到 `S`（`_xxx` → `S.xxx`）。
- `scripts/split-map.json`：标识符 → 模块 映射表（fiximports 用）。

> 这批脚本是「一次性拆分辅助」，日常维护不需要再跑；新增模块时按需参考，不要为了用脚本而用脚本。
