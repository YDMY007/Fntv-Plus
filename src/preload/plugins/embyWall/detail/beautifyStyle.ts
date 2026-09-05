// embyWall/detail/beautifyStyle.ts — 详情页美化样式表（lc-982 Apple/HIG 重写）
// ─────────────────────────────────────────────────────────────────────────────
// 设计原则（根治 lc-980「太多小框」的盒子堆砌，转向 Apple 排版主导）：
//   1. CSS 优先、零节点搬运：两栏 Grid + 选集竖排全部作用在原生节点上
//      （`:has(> hero)` 唯一命中 hero 父列，`> :nth-child(n)` 分区），
//      绝不移动/重排任何 React 原生节点 → React 重渲染时选择器自动重新匹配。
//   2. 去盒化：靠「留白 + 发丝线 + 排版层级」承载结构，不用边框/阴影/圆角 pill 包一切。
//      信息面板透明无框；类型/主演为「 · 」分隔纯文本（不再是 chip）。
//   3. 语义 token 明暗两套（--fnos-*）：accent / hairline / row-hover / scrim 一处切换，
//      文本色沿用 Semi 主题变量 → 浅色=通透白磨砂(Apple Light)，深色=沉浸暗背景(Apple TV)。
//   4. 确定性对比度：backdrop scrim 随主题自适应，保证文本永远落在可读背景上。
//      lc-990 起 hero 上部遮罩改为「封面取色」（heroTint.ts 一次性 canvas 取主色，非常驻采样），
//      lc-992 起窗口标题栏(32px 安全区)也跟随同一支 tint（M 段）。对比度仍不靠运行时判定，
//      而由两个标定常量锁死：暗化亮度上限 L<=0.20 + 顶栏/标题栏图标区 tint alpha 顶值 1。
//      活体实测（/v/tv/season/<id>）：三个图标 10.83~11.00、右侧按钮组 9.72、标题 8.92；
//      标题栏白图标 11.06~11.32（12 种环境一致），且 y=31/y=32 两行逐像素恒等 → 接缝 1.0000。
//      lc-993 起遮罩换色覆盖**两种形态**：Season/Movie 页的 .gradient-for-full（一个元素两层渐变、
//      铺满整块 hero）与 Series 一级页的 .gradient（一层 0deg、贴底 45% 高），色标与 alpha 均照抄原生。
//   5. 悬停用 CSS :hover（微底色 / 缩略图微放大），不用 JS 逐卡绑定，也不用 lift+大阴影。
//   6. 两栏门控三个条件同时成立才启用：hero 是**直接**子节点 + 内含选集卡 [data-id="details"]
//      + 至少有第 3 个直接子节点。∴ 只有 Season 二级页走两栏（实机 4 个子节点）；
//      Series 一级页（hero 外多一层 wrapper、内容列只有 2 个子节点）与 Movie 页自动降级单列。
//      lc-993 扩容 HERO 后，Series 一级页开始吃到 B/C/E/F/K/L/M 段（背景透明化、导航栏沉浸、
//      顶栏玻璃条取色、标题栏取色），A/D/I/J 段（两栏、选集竖排、TMDB 卡、清晰度标识）仍 no-op。
//      [lc-1010] Series 一级页另获专属 N 段：满屏海报 + 左下角柔光玻璃聚簇（用户指定方向），
//      由 body.fnos-series-panel 门控（tmdbCard.ts 系列路由分支加/摘），Movie 一级页与季页不加。
//   7. 低 GPU：backdrop-filter 全表共 3 处规则 —— L 段顶栏 ::before（lc-990）、N 段信息面板与
//      圆形按钮组（lc-1010，用户指定「高级材质柔光玻璃」，面板玻璃取代原实心 scrim 设计）。
//      M 段的标题栏底色仍**刻意不加**磨砂：alpha 1 纯 tint，模糊贡献恒为零。
//      三处均为静态表面，不随滚动重算；其余磨砂观感仍靠半透明 scrim + 一次性模糊底图。
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_ID = 'fnos-beautify-css';

/** hero 精准选择器。**必须与 glass.ts 的 DETAIL_HERO_SEL 逐字一致**（两处各存一份是刻意的：
 *  这边要参与 CSS 字符串拼接、那边要参与 querySelector，共享常量会把纯 CSS 文件拽进运行时依赖）。
 *  三种详情页 hero 的类名互不相同（lc-993 从 NAS 的 JS 产物逐个挖出原文，非推测）：
 *  · Season 二级页（组件 de）与竖版海报的 Movie 一级页（组件 Q）：带 h-[470px]
 *  · 横版海报的 Movie 一级页（同一个 Q）：高度是条件式 isLandscapePoster ? min-h-[390px] : h-[470px]
 *    → 横版海报时**没有** h-[470px]
 *  · Series 一级页 /v/tv|movie/<id>（组件 Zse）：trim-mc__details--key-version，
 *    **一个 Tailwind 高度类都没有**，高度来自同名 CSS 类（560px；按视口分档 576/470/48vh/700）。
 *    旧写法只认 h-[470px] → 该页从 lc-980 起结构性永不匹配，美化一次都没真正套用过。
 *  两个书写约束：① 用属性子串 class*= 避开 Tailwind 任意值的 CSS 方括号转义；
 *  ② 必须用 :is() 包裹，不能用裸逗号列表 —— 下面会把它拼进「body.fnos-beautify HERO img[...]」
 *     这类规则，裸列表的逗号会把规则后半截劈成一条独立选择器（F 段就会中招）。
 *     :is() 的特异性取参数中最高者 = (0,2,0)，与旧的单分支写法完全相同
 *     → 与 A / F / I / L 段既有规则之间的层叠关系一字未变。 */
const HERO = ':is('
  + '.semi-always-dark[class*="h-[470px]"],'
  + '.semi-always-dark[class*="min-h-[390px]"],'
  + '.trim-mc__details--key-version'
  + ')';
/** 内容列（hero 的直接父列 .mb-[46px].flex.flex-col.gap-3），且含选集卡才启用两栏。
 *  lc-993 追加第三个条件「至少要有第 3 个直接子节点」：HERO 扩容后，Series 一级页的
 *  div.relative.w-full（Zse wrapper）也把 hero 当**直接子节点**，第一个条件对它成立了。
 *  它只有 2 个子节点（hero + 进度条/按钮组），而 Season 页的内容列实机有 4 个
 *  （hero + 选集 + 演职人员 + IMDB 外链块，A 段的 nth-child(4) 规则就是按后者写的）。
 *  用子节点数量一刀切掉 wrapper，比去论证 wrapper 内会不会出现 [data-id="details"] 更硬。
 *  代价：「只有 2 个子节点的 Season 页」会降级成单列 —— 那种页面右栏本来就是空的，
 *  两栏只会白留 40% 宽的空白列，单列反而更好，是可接受的降级而非回归。 */
const COL = `:has(> ${HERO}):has([data-id="details"]):has(> :nth-child(3))`;

/** [lc-1010] Series 一级页内容面板。**必须与 tmdbCard.ts 的 SERIES_PANEL_SEL 逐字一致**
 *  （两处各存一份是刻意的，同 HERO/DETAIL_HERO_SEL 的约定：这边参与 CSS 字符串拼接、
 *  那边参与 querySelector，共享常量会把纯 CSS 文件拽进运行时依赖）。
 *  结构实证（2026-09-05 活体 /v/tv/0ae81abe…，另采样 3 部剧 + 季页/电影页交叉验证）：
 *  内容列 col(mb-[46px].flex.flex-col.gap-3) 有且仅有 2 个子节点 ——
 *    ① wrapper(relative.w-full) = hero(trim-mc__details--key-version) + 按钮行(mt-4.px-[46px])；
 *    ② 本面板(relative.box-border.flex.w-full.flex-col.px-[44px]) = 简介 + 季选择 + 外链行。
 *  用**整串精确类名**匹配而非子串：px-[44px] 与季页的 px-[46px] IMDB 块只差一个字符，
 *  子串匹配会误伤；季页/电影页实测均无此整串 → 结构性不误伤。 */
const SERIES_PANEL = 'div[class="relative box-border flex w-full flex-col px-[44px]"]';
/** 按钮行（wrapper 的第 2 子节点，class 以 "mt-4 " 开头）。 */
const SERIES_BTNROW = 'div[class="relative w-full"] > div[class^="mt-4 "]';

export const BEAUTIFY_CSS = `
/* ===== 0. 语义设计 token（明/暗两套；文本色沿用 Semi 主题变量，无需在此重复）===== */
body.fnos-beautify{
  --fnos-accent:#0071e3;
  --fnos-hairline:rgba(0,0,0,.10);
  --fnos-hairline-soft:rgba(0,0,0,.055);
  --fnos-row-hover:rgba(0,0,0,.035);
  --fnos-panel-fill:rgba(0,0,0,.038);
  --fnos-muted:#86868b;
  --fnos-topbar-fg:rgba(255,255,255,.8);   /* 详情页顶栏背景恒暗(见 K 段), 前景色故不分主题 */
  --fnos-backdrop-img-opacity:.30;
  --fnos-scrim-top:rgba(250,250,252,.62);
  --fnos-scrim-mid:rgba(250,250,252,.82);
  --fnos-scrim-bot:rgba(250,250,252,.92);
}
html.dark body.fnos-beautify{
  --fnos-accent:#0a84ff;
  --fnos-hairline:rgba(255,255,255,.14);
  --fnos-hairline-soft:rgba(255,255,255,.075);
  --fnos-row-hover:rgba(255,255,255,.06);
  --fnos-panel-fill:rgba(255,255,255,.07);
  --fnos-muted:#98989d;
  --fnos-topbar-fg:rgba(255,255,255,.8);   /* 与浅色同值: 顶栏恒暗背景由飞牛铺, 与主题无关 */
  --fnos-backdrop-img-opacity:.42;
  --fnos-scrim-top:rgba(10,10,12,.32);
  --fnos-scrim-mid:rgba(10,10,12,.55);
  --fnos-scrim-bot:rgba(10,10,12,.78);
}

/* ===== A. 两栏 Grid（仅 season 页；零节点搬运，React-proof）===== */
body.fnos-beautify ${COL}{
  display:grid !important;
  grid-template-columns:minmax(0,60fr) minmax(0,40fr) !important;
  grid-template-rows:auto auto !important;
  column-gap:32px !important;
  row-gap:20px !important;
  align-items:start !important;
  align-content:start !important;
  width:100% !important;
  box-sizing:border-box !important;
}
/* hero 跨全宽(row1) */
body.fnos-beautify ${COL} > ${HERO}{ grid-area:1 / 1 / 2 / 3 !important; }
/* 选集：左列 row2（竖向列表，占 6 成） */
body.fnos-beautify ${COL} > :nth-child(2){ grid-area:2 / 1 / 3 / 2 !important; min-width:0 !important; }
/* 演职人员 + 注入的剧集信息卡：右列 row2（占 4 成，顶部对齐） */
body.fnos-beautify ${COL} > :nth-child(3){ grid-area:2 / 2 / 3 / 3 !important; min-width:0 !important; }
/* 右列清框：原生容器若带 border/底色/阴影，会与卡内分隔线拼出「半闭合框」→ 一律抹掉。
   唯一豁免 .fnos-beautify-card（我们注入的 TMDB 信息卡）：用户要求右栏「只要一个大的容器包起来」，
   那个容器就是它。若不豁免，这条规则的特异性(COL 的 :has 链 + body.fnos-beautify = 0,5,1)会压过
   I 段卡本身的 (0,1,0)，玻璃模式关闭时卡会被打成全透明 → 一个容器都不剩。
   同理，豁免走 :not() 让选择器根本不匹配，而不是再写一条更高特异性的规则去对抗。 */
body.fnos-beautify ${COL} > :nth-child(3),
body.fnos-beautify ${COL} > :nth-child(3) > *:not(.fnos-beautify-card){
  background:transparent !important;
  border:none !important; box-shadow:none !important;
}
/* 原生「链接：IMDB链接」区块：隐藏（用户明确要求去掉）。
   实机 DOM(盗墓王季页)：它是内容列第 4 个子节点 DIV.box-border.w-full.px-[46px]，
   内部只有一个 a[href*=imdb.com/title/]，没有 person 链接。
   ⚠ 双保险缺一不可：只按 nth-child(4) 会在某些季页少一个节点时误伤别的东西；
     只按「含 imdb 链接」则可能命中演职人员区里的外链。两条都要满足「有外链 且 无人物链接」。
   ⚠ 用 display:none 而不是删节点：节点归 React 所有，删了会在下次重渲染时炸；
     且 collectNativeImdb() 靠 querySelectorAll('a') 取 IMDb 做回退，display:none 不影响它。
   ⚠ grid-template-rows 必须同步收成两行(auto auto)：留第三行的话，隐藏后会多出一条 20px row-gap。 */
body.fnos-beautify ${COL} > :nth-child(4):has(a[href*="imdb.com"], a[href*="themoviedb.org"]):not(:has(a[href*="/v/person/"])),
body.fnos-beautify ${COL} > div[class*="px-[46px]"]:has(a[href*="imdb.com"], a[href*="themoviedb.org"]):not(:has(a[href*="/v/person/"])){
  display:none !important;
}

/* ===== A2. 两栏内容入场过渡（lc-1011，轻微）=====
   美化套用瞬间(settle 时 body.fnos-beautify 挂上, 两栏 Grid 同时生效)给选集列/右栏一个
   轻微淡入上移, 与 N 段系列页面板(fnos-series-panel-in)同一手感; TMDB 卡是 settle 后异步
   插入的新节点, 挂载时各自播放。仅 opacity+translateY(合成器属性, 不触发布局);
   teardown 摘 body class → 再进详情页重放, 每次导航恰好一次, 零常驻开销。
   ⚠ 不动 hero(row1): veil 已有页面级过渡, 再叠会显拖沓。 */
@media (prefers-reduced-motion: no-preference){
  body.fnos-beautify ${COL} > :nth-child(2),
  body.fnos-beautify ${COL} > :nth-child(3){
    animation:fnos-series-panel-in .42s cubic-bezier(.22,.61,.36,1) both;
  }
  body.fnos-beautify ${COL} > :nth-child(3){ animation-delay:.06s; }
  body.fnos-beautify ${COL} .fnos-beautify-card{
    animation:fnos-series-panel-in .45s cubic-bezier(.22,.61,.36,1) both;
  }
}

/* ===== B. 页面背景透明化：让注入的全屏底图透出（仅详情页 body.fnos-beautify 生效）===== */
body.fnos-beautify [class*="bg-[var(--semi-color-bg-1)]"]{ background-color:transparent !important; }

/* ===== C. 导航栏沉浸透明 ===== */
body.fnos-beautify div.relative.z-20.flex.items-center.justify-between.px-11.py-5{
  background:transparent !important;
  backdrop-filter:none !important;
  -webkit-backdrop-filter:none !important;
  box-shadow:none !important;
  border:none !important;
}

/* ===== D. 选集：横向滚动 → Apple TV+ 式竖向行（CSS-only，零节点搬运）=====
   原生结构: .ms-container[!overflow-x-scroll whitespace-nowrap] > .flex.w-max > [data-id=details]
             每张卡 = .relative.flex.flex-col.w-[260px].max-h-[260px]（3 子；海报式，缩略图在顶）
   目标: 列表竖排；每行 = 180px 16:9 缩略图(左，首子节点) + 文本(右，其余子节点自动堆叠)。
   ⚠ 坑1(lc-982 实测): 本段每条规则都必须用「> :nth-child(2)」收窄到选集区。
     右栏「演职人员」的横滑容器带完全相同的 .ms-container[overflow-x-scroll] > .w-max 结构，
     写成 COL 后代选择器会把演员一起改成竖排(单个竖向排列)。
   ⚠ 坑2: img 规则必须限定在「> :first-child img」(缩略图内)。写成「[data-id=details] img」
     会把清晰度角标/播放按钮等小图也强制拉成 16:9 满宽。
   ⚠ 坑3: 本文件 CSS 整体是反引号模板字符串，注释里绝不能出现反引号，否则模板提前闭合(tsc TS1109)。 */
/* 选集区(nth-child 2)及其直接 .relative 包裹层：原生为定高横滑带，可能带 overflow/max-h
   会裁掉竖排后变高的列表 → 强制 auto 高度 + visible，让列表自然展开、页面正常滚动。 */
body.fnos-beautify ${COL} > :nth-child(2),
body.fnos-beautify ${COL} > :nth-child(2) > .relative{
  height:auto !important; max-height:none !important; overflow:visible !important;
}
body.fnos-beautify ${COL} > :nth-child(2) .ms-container[class*="overflow-x-scroll"]{
  overflow:visible !important;
  white-space:normal !important;
  max-height:none !important; height:auto !important;
  padding:0 44px !important;   /* 与「选集」标题 px-11(44px) 左右对齐 */
}
body.fnos-beautify ${COL} > :nth-child(2) .ms-container[class*="overflow-x-scroll"] > [class*="w-max"]{
  display:flex !important; flex-direction:column !important;
  width:100% !important; height:auto !important; gap:0 !important;
}
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"]{
  display:grid !important;
  grid-template-columns:180px minmax(0,1fr) !important;
  grid-auto-rows:min-content !important;
  align-items:center !important;
  gap:3px 18px !important;
  width:100% !important; max-width:none !important;
  height:auto !important; min-height:0 !important; max-height:none !important;
  padding:14px 0 !important;
  white-space:normal !important;
  background:transparent !important;
  border:none !important; box-shadow:none !important;
  border-radius:12px !important;
  transition:background .2s ease !important;
}
/* 缩略图 = 卡片首子节点（原生 div.rounded-lg.relative.mb-3.flex.h-[146px].w-full.shrink-0.overflow-hidden）
   → 固定左列并跨行居中；其余文本子节点由 Grid 自动流入右列逐行堆叠。
   ⚠ 塌陷坑(lc-986, 用户实机 DOM 实证): 这个容器**内部没有任何在文档流里撑高的东西**——
     · 图片链 div.box-border > div.relative.size-full > div.size-full > picture > img 中，
       picture/img 带内联 position:absolute + width/height:100%（absolute 不参与父高计算），
       中间层是 size-full = height:100%，父高为 auto 时百分比解析不出来 → 0；
     · 另外三个直接子节点(观看进度条 / 底部渐变层 / hover overlay)全是 absolute。
     所以一旦用 height:auto 清掉原生 h-[146px]，容器就塌成 border 的约 2px =「细成一条线」。
     给内部 img 补 aspect-ratio 也救不了：它的内联 position:absolute 没被覆盖，absolute 撑不开父级。
   正解：不给 height，给容器 aspect-ratio。width 已定 180px → 自动算出 101.25px，
     内部 absolute 链的 height:100% 随之有了确定参照 → 图片正常填满。
   (原生 h-[146px] 本就是 260px 宽的 16:9: 260×9/16=146.25 → 16/9 是还原原生比例，不是新发明。) */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] > :first-child{
  grid-column:1 !important; grid-row:1 / span 3 !important;
  align-self:center !important; justify-self:start !important;
  width:180px !important; max-width:180px !important;
  height:auto !important; min-height:0 !important; max-height:none !important;
  aspect-ratio:16 / 9 !important;
  margin:0 !important;              /* 原生 mb-3 会在 Grid 单元里额外顶出 12px */
  position:relative !important;
  border-radius:10px !important;
  /* 阴影打在容器上：容器自带 overflow-hidden，打在内部 img 上会被自己裁掉 */
  box-shadow:0 2px 12px rgba(0,0,0,.16) !important;
}
/* 缩略图本体 img：原生已带内联 position:absolute + width/height:100% 与 object-cover，
   **尺寸什么都不用改**，只加 hover 过渡。
   ⚠ 别写 width/height/aspect-ratio：height:auto 会废掉 absolute 的 100% 填满，图片会按固有比例乱窜。
   ⚠ 必须用 picture 收窄：容器内还有清晰度标识位图(data:image/png;base64)等小图，
     写成「> :first-child img」会把它们一起拉成 16:9 满宽并套上圆角阴影(lc-983 实际发生过)。 */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] > :first-child picture img{
  transition:transform .34s cubic-bezier(.25,.1,.25,1) !important;
}
/* 底部渐变层原生 h-[76px] 配 146px 容器 ≈ 52%；容器缩到 101px 后不动它就会盖住 3/4 缩略图
   (底部一片死黑)。等比缩到 52px 保持原生观感。清晰度标识在 bottom-2.5，不受影响。 */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] > :first-child [class*="bg-gradient-to-t"]{
  height:52px !important;
}
/* 行间发丝分隔（相邻卡）+ 悬停微底色 & 缩略图微放大（克制，无 lift/无大阴影） */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] + [data-id="details"]{
  border-top:1px solid var(--fnos-hairline-soft) !important;
}
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"]:hover{ background:var(--fnos-row-hover) !important; }
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"]:hover > :first-child picture img{ transform:scale(1.035) !important; }

/* ===== E. 演职人员 / 人物项：去 lift，仅透明度反馈（右列原生横滑，保持不动）===== */
body.fnos-beautify a[href*="/v/person/"]{
  border-radius:14px !important;
  transition:opacity .2s ease !important;
}
body.fnos-beautify a[href*="/v/person/"]:hover{ opacity:.8 !important; }
body.fnos-beautify a[href*="/v/person/"] img{ border-radius:12px !important; }

/* ===== E2. 演职人员精修（lc-1020，按实机 DOM 对齐）：与右栏信息卡同一套排版语言 =====
   原生形态：16px 大字标题 + 常驻横向滚动条 + 16px 人名，与上方磨砂信息卡的 11px 小标签
   层级语言不一致（用户要求演员信息展示贴合整体样式）。收敛为：小号弱化分区标签 /
   头像柔投影替代描边（对比度靠投影不靠 tint）/ 悬浮轻抬升 / 隐藏滚动条。
   实机结构：宿主 COL>nth-child(3) 内 p.semi-typography(标题) + .ms-container(横滑) >
   a[href*=/v/person/] > div.size-[90px].rounded-full(头像wrapper,原生transition-all) + p 名字(text-base) + p 角色(text-xs)。
   注：TMDB 卡也插在本宿主顶部，但其 HTML 全部用 .fnos-showinfo__* 类、无 p.semi-typography，互不误伤。 */
/* ① 分区标题「演职人员」：16px 大字 → 12px 弱化字距标签（与信息卡 block label 同层级） */
body.fnos-beautify ${COL} > :nth-child(3) p.semi-typography{
  font-size:12px !important; letter-spacing:.14em !important;
  color:var(--fnos-ui-sub) !important; font-weight:500 !important;
}
body.fnos-beautify ${COL} > :nth-child(3) p.semi-typography strong,
body.fnos-beautify ${COL} > :nth-child(3) p.semi-typography span{
  font-size:inherit !important; color:inherit !important;
  font-weight:inherit !important; letter-spacing:inherit !important;
}
/* ② 隐藏横滑滚动条（无边框无线条；滚轮/触控板横滑仍可用） */
body.fnos-beautify ${COL} > :nth-child(3) .ms-container{ scrollbar-width:none !important; }
body.fnos-beautify ${COL} > :nth-child(3) .ms-container::-webkit-scrollbar{
  width:0 !important; height:0 !important; display:none !important;
}
/* ③ 头像：柔投影替代描边；悬浮轻抬升（原生 wrapper 已带 transition-all，无需补过渡） */
body.fnos-beautify ${COL} > :nth-child(3) a[href*="/v/person/"] > div:first-of-type{
  box-shadow:0 10px 26px rgba(0,0,0,.28) !important;
}
body.fnos-beautify ${COL} > :nth-child(3) a[href*="/v/person/"]:hover > div:first-of-type{
  transform:translateY(-3px) !important;
}
/* ④ 人名 16px→13px（与信息卡正文同级）；角色行维持原生 12px 弱化 */
body.fnos-beautify ${COL} > :nth-child(3) a[href*="/v/person/"] p[class*="text-base"]{ font-size:13px !important; }

/* ===== F. hero 海报微投影（hero 整体保持原生，只让海报更立体）===== */
body.fnos-beautify ${HERO} img[class*="rounded"], body.fnos-beautify ${HERO} .shrink-0 img{
  box-shadow:0 16px 44px rgba(0,0,0,.34) !important;
}

/* ===== G. 注入的全屏底图层（backdrop.ts 创建）：明暗自适应 scrim =====
   [lc-1017] __img 为 A/B 双层交叉淡换结构，opacity 由 backdrop.ts 逐层 inline 驱动
   (活跃层=var(--fnos-backdrop-img-opacity,.30)，非活跃层=0)，样式表只给过渡。 */
.fnos-detail-backdrop{
  position:fixed !important; inset:0 !important; z-index:-1 !important;
  pointer-events:none !important; overflow:hidden !important;
  border-radius:16px !important; /* [lc-1025] 四角随窗口圆角：light 主题 __scrim 顶部近白，方形角会露白边 */
  transition:opacity .34s ease !important;
}
.fnos-detail-backdrop.is-leaving{ opacity:0 !important; }
.fnos-detail-backdrop__img{
  position:absolute !important; inset:-8% !important;
  background-size:cover !important; background-position:center 18% !important;
  filter:blur(52px) saturate(1.22) !important;
  transform:scale(1.12) !important;
  transition:opacity .5s ease !important;
}
.fnos-detail-backdrop__scrim{
  position:absolute !important; inset:0 !important;
  background:linear-gradient(to bottom,
    var(--fnos-scrim-top) 0%,
    var(--fnos-scrim-mid) 42%,
    var(--fnos-scrim-bot) 100%) !important;
}

/* ===== H. 瞬间加载层（backdrop.ts 创建）：缓存海报 + 骨架 shimmer，盖住 fnOS 原生白屏 ===== */
.fnos-instant-layer{
  position:fixed !important; inset:0 !important; z-index:2147483000 !important;
  display:flex !important; align-items:center !important; justify-content:center !important;
  background:var(--semi-color-bg-0,#0b0b0f) !important;
  border-radius:16px !important; /* [lc-1025] 进详情瞬间的全窗实心层，四角随窗口圆角 */
  transition:opacity .32s ease !important; overflow:hidden !important;
}
.fnos-instant-layer.is-hiding{ opacity:0 !important; pointer-events:none !important; }
.fnos-instant-layer__bg{
  position:absolute !important; inset:-6% !important;
  background-size:cover !important; background-position:center 22% !important;
  filter:blur(40px) saturate(1.2) !important; transform:scale(1.1) !important; opacity:.5 !important;
}
.fnos-instant-layer__scrim{ position:absolute !important; inset:0 !important; background:linear-gradient(to bottom,rgba(0,0,0,.2),rgba(0,0,0,.6)) !important; }
.fnos-instant-layer__body{ position:relative !important; z-index:2 !important; display:flex !important; gap:22px !important; align-items:flex-start !important; padding:0 46px !important; width:100% !important; max-width:1180px !important; box-sizing:border-box !important; }
.fnos-instant-layer__poster{ width:214px !important; height:320px !important; flex:0 0 214px !important; border-radius:14px !important; object-fit:cover !important; box-shadow:0 14px 40px rgba(0,0,0,.5) !important; background:rgba(255,255,255,.06) !important; }
.fnos-instant-layer__lines{ flex:1 1 auto !important; min-width:0 !important; display:flex !important; flex-direction:column !important; gap:14px !important; padding-top:116px !important; }
.fnos-instant-skel{ border-radius:8px !important; background:linear-gradient(90deg,rgba(255,255,255,.07) 25%,rgba(255,255,255,.16) 37%,rgba(255,255,255,.07) 63%) !important; background-size:400% 100% !important; animation:fnos-instant-shimmer 1.3s ease infinite !important; }
@keyframes fnos-instant-shimmer{ 0%{background-position:100% 50%} 100%{background-position:0 50%} }

/* ===== I. 延后注入的 TMDB 剧集信息卡（tmdbCard.ts，追加进右列）=====
   排版范式(lc-985 立、lc-988 扩)：对标 Netflix / Apple TV+ / TMDB 侧栏，弃用后台表单式 label-value 双列。
   分段(lc-988 立、lc-1006 去简介)：评分块(视觉锚) → 标语 → meta 串(无 label) → 事实区(窄 label)
     → 主创 → 本季 → 剧照 → 相似剧集 → 更多(别名/关键词/在线看/热度/编号) → 外链 → 来源行。
   为什么这么长：飞牛原生季页**完全没有**这些数据，全是本插件从 TMDB 补的；
     用户明确要求「尽可能多获取和显示」。∴ 内容以「原生没有的」为界，不做删减。
     ⚠ 剧集简介(lc-1006 按用户要求移除)：卡内**不再渲染** show overview(原④)与 season overview
       (原⑦内)。用户实测当前剧 hero 顶部已有原生简介，卡内两段属重复。**代价(已知取舍)**：
       原生 hero 简介为空的剧将卡内也无简介 —— lc-988 实测盗墓王 hero innerText 仅
       「盗墓王 第 1 季 第 1 集 2026」、测试/Betas 季 getEditDetail overview="" 即属此类。
       用户已确认接受此取舍，勿再"把简介补回卡内"。
   去重(仍然成立)：标题不渲染(hero 已有)；主演 cast 不渲染(原生「演职人员」区实机确认有头像+姓名横滑)，
     但主创分工(创作者/导演/编剧/作曲/制片/制作)原生区没有 → 补；
     原名降到事实区末行(日文/韩文原名常占两三行，放顶部会冲散评分块与 meta 串的节奏)。
   分组只靠留白 + 发丝线(__sec 的 border-top) + 11px 小标题，**节内零容器**(用户明确要求
     「只要一个大的容器包起来，内部的各小标题文字都不要有容器包裹」)。

   ⚠ 命名硬约束(lc-987, 用户明确要求「只要一个大的容器包起来，内部的各小标题文字都不要有容器包裹」)：
     glassUI.ts 的组件级玻璃规则写作 [class*="card"] —— 那是**子串**匹配。内部块原先叫
     fnos-beautify-card__*，全都含 card 子串 → 评分块/meta/事实区/外链/来源行乃至每一个 __row
     都被各自套上 background + backdrop-filter:blur(14px) + border + box-shadow，一层层小玻璃框
     叠在大框里(还顺带违背本文件当时「全表零 backdrop-filter」的低 GPU 约束；
     该约束已于 lc-990 为顶栏玻璃条破例**一处**，见 L 段与文件头第 7 条)。
     修法选「改名让选择器根本不匹配」而不是写更高特异性 !important 去对抗 ——
     依据是 glassUI.ts 自己的教训注释「事后排除规则 !important 对抗不稳定」。
     ∴ 内部一律用 fnos-showinfo__ 前缀(不含 glassUI 任何子串 token)；
       外层**刻意保留** fnos-beautify-card 这个名字，让它成为全站玻璃规则唯一命中的元素 = 那个大容器。
     往内部块加新 class 时，必须先确认名字里不含 card/Card/panel/Panel/search/Search/navbar/topbar/
     appbar/toolbar/playbar/control-bar/z-10/z-20/header-bar/nav-bar/page-header/list-head 任一子串。 */
/* 大容器本体。玻璃模式开：glassUI 的规则特异性更高，会把下面的 background/border/box-shadow
   换成磨砂面板(它从不设 border-radius/padding，故圆角与内边距始终由本规则决定)。
   玻璃模式关：glassUI 整组规则要求 html[data-fntv-glass]，不匹配 → 只有本规则生效，
   靠半透明填充 + 发丝边框给出同等的「浮起面板」观感，两种模式下都恰好一个大容器。
   前提：A 段的右列清框规则已用 :not(.fnos-beautify-card) 豁免本卡，否则它 (0,5,1) 会压掉这里 (0,1,0)。 */
.fnos-beautify-card{
  background:var(--fnos-panel-fill) !important;
  border:1px solid var(--fnos-hairline-soft) !important;
  box-shadow:none !important;
  border-radius:14px !important;
  padding:16px 18px !important; margin:0 0 10px !important;
  box-sizing:border-box !important;
  color:var(--semi-color-text-0,#1d1d1f) !important;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif !important;
  font-size:13px !important; line-height:1.6 !important;
  -webkit-font-smoothing:antialiased !important;
}
/* 组间距由「相邻块」一条规则统一承担：任何一段因数据缺失而不渲染时，间距都不会塌陷。 */
.fnos-showinfo__block + .fnos-showinfo__block{ margin-top:18px !important; }
/* ① 评分块：34px 大数字是右栏唯一的视觉锚（旧版 17px 与 13px 正文行几乎无层级差 → 评分被埋没）。 */
.fnos-showinfo__rating{ display:flex !important; align-items:baseline !important; }
.fnos-showinfo__num{
  font-size:34px !important; font-weight:700 !important; line-height:1 !important;
  letter-spacing:-.03em !important; font-variant-numeric:tabular-nums !important;
  color:var(--semi-color-text-0,#1d1d1f) !important;
}
.fnos-showinfo__outof{ margin-left:4px !important; font-size:12px !important; font-weight:500 !important; color:var(--fnos-muted) !important; }
.fnos-showinfo__rsub{ display:flex !important; align-items:center !important; gap:9px !important; margin-top:7px !important; }
/* 半星：底层灰星 + 顶层金星按 inline width 裁切。纯 CSS，无 SVG、无环形进度(那会引入新的「框」)。 */
.fnos-showinfo__stars{ position:relative !important; display:inline-block !important; font-size:12px !important; line-height:1 !important; letter-spacing:1.5px !important; }
.fnos-showinfo__stars-bg{ color:var(--fnos-hairline) !important; }
.fnos-showinfo__stars-fg{ position:absolute !important; left:0 !important; top:0 !important; overflow:hidden !important; white-space:nowrap !important; color:#ff9f0a !important; }
.fnos-showinfo__votes{ font-size:11.5px !important; color:var(--fnos-muted) !important; }
/* ② meta 串：无 label 的两行灰字，取代旧版「状态/规模/类型/单集」四行 label-value。 */
.fnos-showinfo__meta{ font-size:12.5px !important; line-height:1.7 !important; color:var(--semi-color-text-1,#3c3c43) !important; }
.fnos-showinfo__meta-sub{ font-size:12px !important; color:var(--fnos-muted) !important; }
/* ③ 事实区：label 列 3.4em(旧版 62px 太宽，把 value 推得过远，四个中文字宽刚好)保证 value 左缘对齐；
     组内靠 4px padding 分行，无横线。 */
.fnos-showinfo__row{ display:flex !important; gap:12px !important; align-items:baseline !important; padding:4px 0 !important; }
.fnos-showinfo__k{ flex:0 0 3.4em !important; font-size:12px !important; color:var(--fnos-muted) !important; }
.fnos-showinfo__v{
  flex:1 1 auto !important; min-width:0 !important; font-size:12.5px !important; line-height:1.6 !important;
  color:var(--semi-color-text-0,#1d1d1f) !important; word-break:break-word !important;
}
/* ③b 分节(lc-988 扩字段后新增)：一条发丝线 + 11px 小标题，节内**零容器**(用户明确要求
     「只要一个大的容器包起来，内部的各小标题文字都不要有容器包裹」)。
     节间距沿用既有 __block 相邻规则(18px)，__sec 自身只补 padding-top 让线不贴字。
     ⚠ 类名严禁含 glassUI 子串 token(card/panel/search/navbar/z-10/z-20/list-head…)：
       sec / sec-t / tag / ov / stills / still / recs 均已逐个核对过清单，安全。 */
.fnos-showinfo__sec{ padding-top:14px !important; border-top:1px solid var(--fnos-hairline-soft) !important; }
.fnos-showinfo__sec-t{
  font-size:11px !important; letter-spacing:.06em !important; line-height:1 !important;
  color:var(--fnos-muted) !important; margin-bottom:8px !important;
}
/* 标语：比正文更早给出调性，弱化到灰字一级。 */
.fnos-showinfo__tag{ font-size:12.5px !important; line-height:1.6 !important; color:var(--fnos-muted) !important; }
/* 剧照：3 张等宽 16:9。img 初始 opacity 0 + 无 src(渲染阶段零请求)，
   取到 dataUrl 后由 _fillStills 加 is-ready 淡入；取不到的单张会被摘掉，不留空位。
   aspect-ratio 而非 height：宽度是 calc 出来的百分比，写死 height 在窄栏会变形。 */
.fnos-showinfo__stills{ display:flex !important; gap:8px !important; }
.fnos-showinfo__still{
  width:calc((100% - 16px) / 3) !important; aspect-ratio:16 / 9 !important; object-fit:cover !important;
  border-radius:8px !important; background:var(--fnos-hairline-soft) !important;
  opacity:0 !important; transition:opacity .3s ease !important;
}
.fnos-showinfo__still.is-ready{ opacity:1 !important; }
/* 相似剧集：纯文本链接流(· 分隔)，不是海报墙 —— 海报墙会引入一排新框。 */
.fnos-showinfo__recs{ font-size:12.5px !important; line-height:1.8 !important; }
.fnos-showinfo__recs a{ color:var(--semi-color-text-0,#1d1d1f) !important; text-decoration:none !important; }
.fnos-showinfo__recs a:hover{ color:var(--fnos-accent) !important; text-decoration:underline !important; }
.fnos-showinfo__recs i{ font-style:normal !important; color:var(--semi-color-text-3,#c7c7cc) !important; margin:0 6px !important; }
/* ④ 外链：组间距统一由 __block 相邻规则给，这里不再自带 margin-top。 */
.fnos-showinfo__links{ display:flex !important; flex-wrap:wrap !important; gap:4px 12px !important; align-items:center !important; font-size:12.5px !important; }
.fnos-showinfo__links a{ color:var(--fnos-accent) !important; text-decoration:none !important; font-weight:500 !important; }
.fnos-showinfo__links a:hover{ text-decoration:underline !important; }
.fnos-showinfo__links span{ color:var(--semi-color-text-3,#c7c7cc) !important; }
.fnos-showinfo__loading,.fnos-showinfo__error{ color:var(--fnos-muted) !important; font-size:12.5px !important; padding:8px 0 !important; }
/* ⑤ 来源行：全卡最弱一级(10.5px)。刷新默认灰、hover 才染 accent ——
     它是开发者视角的操作，不该和 TMDB/IMDb 外链抢同一级视觉权重。 */
.fnos-showinfo__foot{
  margin-top:16px !important;
  display:flex !important; justify-content:space-between !important; align-items:center !important; gap:10px !important;
  font-size:10.5px !important; color:var(--fnos-muted) !important;
}
.fnos-showinfo__refresh{
  background:transparent !important; border:none !important; padding:0 2px !important; cursor:pointer !important;
  color:var(--fnos-muted) !important; font-size:12px !important; line-height:1 !important; font-family:inherit !important;
  transition:color .18s ease !important;
}
.fnos-showinfo__refresh:hover{ color:var(--fnos-accent) !important; }

/* ===== J. 清晰度标识：原生角标(贴缩略图右下) → 集标题后的小图（epResolution.ts 注入）=====
   ⚠ 实证纠正(lc-986, 用户提供的真实 DOM): 原生清晰度标识**不是文本**，是一张 base64 位图——
     缩略图容器 > div.absolute.bottom-0(底部渐变层) > div.absolute.bottom-2.5.right-2.5.flex.gap-1.5
       > div.flex.h-[22px].items-center > img[src^="data:image/png;base64"][alt=""]
     所以 lc-984 的「文本叶子 + 清晰度词表」永远失配，那版胶囊一次都没注入成功。
   现在改为克隆这张位图：图里画的是什么(1080/4K/HDR…)读不成文字，克隆是唯一保真做法。
   隐藏走 class 而非删节点: 原生角标只被加标记, DOM 位置/属性/src 全不动, teardown 摘掉即复原。 */
body.fnos-beautify .fnos-res-native-hidden{ display:none !important; }
/* 标题后的标识：裸图，不套框不加底色。位图本身已是不透明色块(palette PNG 无 alpha)，
   再包一层 pill 就成了「框里套框」。 */
body.fnos-beautify .fnos-ep-res{
  display:inline-block !important; margin-left:7px !important;
  vertical-align:middle !important; line-height:0 !important; white-space:nowrap !important;
}
body.fnos-beautify .fnos-ep-res-img{
  display:block !important; height:15px !important; width:auto !important;  /* 保持位图固有比例 */
  border-radius:3px !important;
}
/* 胶囊 append 在标题 p 末尾: 若该 p 带 truncate(nowrap+ellipsis) 或 line-clamp, 长集标题会把胶囊裁没。
   用 :has 精准只解禁「真收到了胶囊的那个 p」, 不影响其它段落。 */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] p:has(> .fnos-ep-res){
  display:block !important; white-space:normal !important;
  overflow:visible !important; text-overflow:clip !important;
  -webkit-line-clamp:unset !important;
}

/* ===== K. 顶栏左上角图标按钮配色补齐（home / hamburger；lc-989）=====
   ⚠ 这是**飞牛原生自己的 bug**，我们只是补齐它已经用在「返回」按钮上的同等语义。
   实测（活体 NAS /v/tv/season/<id>，浅色主题 = 用户默认，elementsFromPoint 于按钮中心 (74,41)）:
     详情页顶栏背景由三层叠成、且**恒暗**（与主题无关）:
       ① div.z-[2].h-[80px].top-0.w-full  → linear-gradient(rgba(0,0,0,.5) → rgba(0,0,0,0))
       ② div.gradient-for-full            → linear-gradient(90deg, rgba(25,25,26,.96) 0%, .74 28%, …)
       ③ div.semi-always-dark.h-[470px]   → background-color: rgb(25,25,26)
     飞牛只给「返回」按钮单独包了 .semi-always-dark → 恒白 rgb(255,255,255)，对比度 19.2:1，正确。
     却**漏了它左边的 home 与 hamburger**: 两者走 text-[var(--semi-color-text-1)]，浅色主题下
     computed color = rgba(0,0,0,.8)（home 的 svg fill 实测 rgb(0,0,0)）→ 深图标压在恒暗背景上。
   量化: 背景合成 rgb(18.9)（① 在 y=41 处 alpha 0.244）→ 修正前对比度 **1.10:1**
     （WCAG 非文本最低门槛 3:1，等于看不见）；修正后 **12.03:1**。
     /v/tv/<id>（非 season）详情页背景为纯 rgb(25,25,26) → before 1.16:1 / after 11.53:1，同一结论。
     旁证: 右上角搜索/用户/设置三个 .semi-button-content 在浅色主题下实测也已是 rgba(255,255,255,.8)
     ——飞牛同样按恒暗处理，只有 home/hamburger 是漏网的两个。
   取值: --fnos-topbar-fg = rgba(255,255,255,.8)，正是暗色主题下 --semi-color-text-1 的原生值。
     不发明新的颜色关系，只是让浅色主题与暗色主题观感一致（最小干预）。
   ⚠ 必须带 svg 后代选择器: home 的 svg 自身 class 也含 text-[var(--semi-color-text-1)]
     （h-[22px] cursor-pointer align-top leading-sm text-[var(--semi-color-text-1)]），
     只改外层 div / a 会被它自己那一层压回去；实测三层齐上 + !important 才真的生效。
   ⚠ 只改 color 不写 fill: 三个图标的 svg 根都是 fill="currentColor"，子元素(path/g/rect/defs/clipPath)
     无 fill 属性 → 改 color 即全链继承（实测内部 path/g/rect 全部跟随变白）。
   ⚠ 不动「返回」按钮: 它已被飞牛的 .semi-always-dark 保证恒白，本段选择器也命不中它。
   ⚠ 必须用 body.fnos-beautify 门控（= 仅详情页）: 首页顶栏实测**没有**那层黑渐变
     （背景是 bg-[var(--semi-color-bg-1)]，浅色主题下为白），深图标配白底是正确的，全局改会改坏首页。
   ⚠ 与 glassUI 无冲突: 玻璃模式对顶栏是排除/透明化规则（[data-fnos-clear=1] / [class*=z-20] / z-10），
     不会给顶栏加浅色磨砂 → 恒暗背景在玻璃开关两种状态下都成立。
   选择器用属性子串（class*="h-[80px]"）而非 .h-\[80px\]: 避开 Tailwind 任意值的方括号转义。 */
body.fnos-beautify div[class*="h-[80px]"][class*="top-0"] div[class*="gap-4"][class*="lg:!hidden"],
body.fnos-beautify div[class*="h-[80px]"][class*="top-0"] div[class*="gap-4"][class*="lg:!hidden"] a,
body.fnos-beautify div[class*="h-[80px]"][class*="top-0"] div[class*="gap-4"][class*="lg:!hidden"] svg{
  color:var(--fnos-topbar-fg) !important;
}

/* ===== L. 详情页上部遮罩 → 封面取色的玻璃（lc-990）=====
   诉求(用户原话)：「二级详情页里上部的遮罩太丑一不好看改成封面取色的玻璃样式」。
   「丑」是量得出来的 —— 原生两层遮罩色值全是硬编码中性色，且左右明暗严重不均
   (活体 /v/tv/season/<id>，浅色主题，同一行 y=41 上的白字对比度)：
     顶栏 80px 黑渐变 + hero 的 .gradient-for-full(两层 25,25,26)
     → 左侧图标区 12.23(封面色被吃到死黑)，右侧按钮组只剩 4.50(几乎没压暗)。
   换成封面同色系后同一批采样点收敛到 9.72~11.00，标题「第 1 季」8.92。
   tint 来源：heroTint.ts 从 hero 剧照取主色桶，把 HSL 亮度压到 L<=0.20(只压不提、H/S 原值保留)，
     写成 body 上的 --fnos-hero-tint。取色失败时该变量不存在 → 下面每个 var() 的第二参数
     精确回落到飞牛原生的 25,25,26，即优雅降级(变量在/缺失两态均已实测)。

   ⚠ 三个设计要点，每条都有实测依据，改动前务必读：
   ① tint 底色 / 磨砂 / 渐隐 mask **三者全放 ::before**，不放 bar 本体。
      mask 会裁掉元素自己的整个渲染子树 —— bar 内可见内容最低到 y=62(78%)、渐隐从 58% 起，
      若把 mask 加在 bar 本体上，图标下沿会被一起淡出。伪元素的 mask 只裁它自己。
      另 ::before 是 z-auto，而 bar 的内容容器带 z-20 → 磨砂在内容之下，图标不会被模糊。
   ② 用 mask 渐隐，而不是让 background 的 alpha 渐隐到 0：
      图标区(y=23..59)的 tint alpha 因此恒定在顶值，对比度从早前标定的 4.23 提升到两位数。
      若沿用 alpha .72→0 那种形状，图标中心只剩 .351，亮剧照透上来 → 对比度暴跌到 1.80~1.92。
      顶值取 **1** 而不是 .92，是 lc-992 的接缝要求(见 M 段)：y=0..31 的标题栏铺同色系底色后，
      只有条首行(y=32)也是纯 tint，两行才能对任意 x 恒等 → 接缝 1.0000(现状白条是 9.8232)。
      任何 <1 的顶值都会让接缝随封面明暗漂移(实测 .98→1.0306、.96→1.0623)。
      代价是净收益：图标行 y=41 白字对比度从 9.35~10.62(1.14x 落差)收敛到 **11.06~11.32(1.02x)**，
      12 种环境(明暗 × 玻璃开关 × 桌面黑/中灰/白)完全一致；玻璃条外观最大改变仅 15/255。
      渐隐段(y=78..110)逐行亮度剖面的最大逆向步长 0.0449，而底层封面自身在同一段就有 0.0574
      → 逆向起伏是封面内容继承来的，tint 覆盖反而把它压平了；顶值 .92→1 对它的影响只有 0.0001。
   ③ bar 本体只清 background-image，**不动 background-color**(它本来就是 rgba(0,0,0,0))：
      embyWall.ts 的 [lc-925] 图标反色靠 elementsFromPoint 逐层读 backgroundColor / backgroundImage
      采样背景亮度，而伪元素不参与 elementsFromPoint → 采样路径与本段改动之前完全一致，
      仍恒命中 hero 的实心 rgb(25,25,26) 而判「暗底 → 图标刷白」，与这里的暗 tint 自洽。

   ⚠ 选择器安全性：首页实测**不存在** div[class*="h-[80px]"][class*="top-0"]
     (首页顶栏是另一个元素 relative.z-[2].h-[80px].bg-[var(--semi-color-bg-1)]，实心白底、不带 top-0)，
     两个遮罩类 .gradient-for-full / .gradient 在首页数均为 0、三种 hero 也都不存在
     → 再叠加 body.fnos-beautify 门控(首页无 hero，该 class 永不会加) = 双重安全。
   ⚠ 不新增任何 class 名(全走 ::before + 既有属性选择器) → 无需过 glassUI 的子串 token 清单。
   ⚠ 刻意不碰 hero 本体底色 bg-[var(--semi-color-bg-1)] = rgb(25,25,26)：它被整块不透明剧照
     100% 覆盖，改了看不出区别；而 .semi-always-dark 全文档有 5 个(另 4 个是 36x36 小图标)，
     多一条 !important 去覆盖 Semi 全局 token 有误伤风险。tint 缺失时 fallback 恰好也是 25,25,26。
   ⚠ 这是本文件**唯一**一处 backdrop-filter(破例说明见文件头第 7 条)：面积仅 820x80、只在详情页、
     不随滚动重算。bar 的祖先链 7 层实测零 filter/transform/opacity/mask/will-change/contain/
     isolation/perspective → 不破坏 backdrop root，磨砂能真的采到 hero 剧照。 */
body.fnos-beautify div[class*="h-[80px]"][class*="top-0"]{
  background-image:none !important;
}
body.fnos-beautify div[class*="h-[80px]"][class*="top-0"]::before{
  content:''; position:absolute; inset:0; pointer-events:none;
  background-image:linear-gradient(to bottom,
    rgba(var(--fnos-hero-tint, 25,25,26), 1) 0%,
    rgba(var(--fnos-hero-tint, 25,25,26), .86) 100%);
  backdrop-filter:blur(18px) saturate(1.5);
  -webkit-backdrop-filter:blur(18px) saturate(1.5);
  -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 58%, transparent 97%);
  mask-image:linear-gradient(to bottom, #000 0%, #000 58%, transparent 97%);
}
/* hero 遮罩：两层渐变的 alpha 与色标位置**一字不改**，只把 25,25,26 换成 tint。
   那套 alpha 形状是有功能目的的(保住 x=292 起的白色标题/季/集/年份)，动它就动可读性。
   这里不加磨砂：用户要的是封面剧照保持清晰，磨砂只在顶栏那一条(Apple / Netflix 的顶栏做法)。 */
body.fnos-beautify ${HERO} .gradient-for-full{
  background-image:
    linear-gradient(90deg,
      rgba(var(--fnos-hero-tint, 25,25,26), .96) 0%,
      rgba(var(--fnos-hero-tint, 25,25,26), .74) 28%,
      rgba(var(--fnos-hero-tint, 25,25,26), .38) 58%,
      rgba(var(--fnos-hero-tint, 25,25,26), .08) 100%),
    linear-gradient(0deg,
      rgba(var(--fnos-hero-tint, 25,25,26), 1) 0%,
      rgba(var(--fnos-hero-tint, 25,25,26), .94) 22%,
      rgba(var(--fnos-hero-tint, 25,25,26), .76) 54%,
      rgba(var(--fnos-hero-tint, 25,25,26), .18) 100%) !important;
}
/* Series 一级页的遮罩是**另一个类名**：.gradient（组件 Zse 渲染的
   div.gradient.absolute.bottom-0.left-0.h-[45%].w-full）。三点都与上面那条不同 ——
   类名不同、只有一层渐变（不是两层）、几何是贴底 45% 高（不是 size-full 整块 hero）
   → 必须单独一条规则，上面那条对它零命中。
   色标位置与 alpha 形状照抄飞牛原生 CSS 原文一字不改：
     .gradient{background:linear-gradient(0deg, rgba(var(--semi-grey-1),1) 0%, 1 18%, .92 42%, .64 72%, 0 100%)}
   只把 var(--semi-grey-1) 换成 tint。--semi-grey-1 在 hero 子树里恒解析为 25,25,26
   （.semi-always-dark 强制暗色 token，浅色主题下也是，lc-990 活体实测已证）→ fallback 值一致。
   标题落点已核算：标题块在 bottom-[30px]（logo h-84 + gap-30 + h2 text-60），
   换算到这条 252px 高的渐变里，h2 处于 alpha .92~1 的区段；tint 的 HSL 亮度锁在 L<=0.20
   → 白标题对比度 >=8.9，与 lc-990 对 Season 页标定的 8.92 同档。
   ⚠ 类名选择器 .gradient 必须留在 ${HERO} 后代位置：它太通用，脱离 hero 作用域会误伤别处。
   ⚠ 用 background-image 覆盖原生的 background 简写（!important 只压简写里的 image 分量），
     与上面那条 .gradient-for-full 的写法一致，那条已活体实测生效。 */
body.fnos-beautify ${HERO} .gradient{
  background-image:linear-gradient(0deg,
    rgba(var(--fnos-hero-tint, 25,25,26), 1) 0%,
    rgba(var(--fnos-hero-tint, 25,25,26), 1) 18%,
    rgba(var(--fnos-hero-tint, 25,25,26), .92) 42%,
    rgba(var(--fnos-hero-tint, 25,25,26), .64) 72%,
    rgba(var(--fnos-hero-tint, 25,25,26), 0) 100%) !important;
}

/* ===== M. 窗口标题栏(32px 安全区)跟随封面取色（lc-992）=====
   诉求(用户原话)：「整个软件顶部的控件样式跟随取色，不要一直为白色」，并附截图指明对象是
   Electron 右上角 min/max/close 控制栏(titlebar.ts 注入的 #custom-titlebar，y=0..31)。

   「一直为白色」是量得出来的，而且比用户描述的更严重：
   · titlebar.ts 旧版把条的 background **无条件**写死 transparent(沉浸/非沉浸两态都一样)，
     于是这 32px 透出来的是主进程 ACRYLIC_CSS 硬编码的近白亚克力 rgba(250,244,250,.68)
     + blur(30px)(mainwin.ts:134，**不分主题**)，再叠 G 段 __scrim 的 --fnos-scrim-top
     (浅色 rgba(250,250,252,.62)) —— 两层都是白的。B 段只清飞牛自己的 bg-1，从来没碰过这层。
   · 而旧版 setImmersive 又把图标写死 #ffffff → 白图标压在近白亚克力上实测对比度 **1.02**，
     即三个窗口控件在详情页实际上是看不见的。
   · 另有一处真 bug：titlebar.ts 私有的 isDetailPage() 显式排除 /season/，而 detail/glass.ts
     的同名函数包含它 → season 页(本段主战场)美化已套用、L 段 tint 玻璃条从 y=32 铺起，
     标题栏却走非沉浸分支，白条正好压在深色玻璃正上方，实测接缝 **9.8232**。

   修法(方案 C；12 种环境 × 6 个候选扫参后选定)：标题栏铺**纯 tint**(alpha 1)，
   L 段条首行 alpha 同步抬到 1 → y=31 与 y=32 对任意 x 恒等，接缝 **1.0000**。
   这是唯一精确解：要让两行恒等，就必须让两侧都不依赖背后的像素；任何一侧 <1 都会随封面
   明暗漂移(实测 .98 → 1.0306、.96 → 1.0623，均超 1.03 的大平坦色块 Weber 阈)。
   白图标对比度 **11.06~11.32**(1.02x 落差，全部高于 AAA 7)。

   ⚠ 三个实现要点，改动前务必读：
   ① 底色画在 ::before，不画在条本体：glassUI.ts 的
      html[data-fntv-glass] .fnos-tv-page body > div{background:transparent!important}
      直接命中 #custom-titlebar(它就是 body 的直接子 div)，玻璃模式下会把本体刷成透明。
      伪元素不被那条规则匹配 —— 与 glassUI.ts:142 自己记的 lc-526~530 教训一致：
      让选择器根本不匹配，而不是写更高特异性的 !important 去对抗。
   ② 选择器锚 data-fntv-tb(titlebar.ts 打的标记)而不是锚 id：原生页分支复用同一个
      #custom-titlebar，形态却是右上角浮动圆形按钮组(自带深色磨砂底)。injectTitleBar 只在
      OnReady 跑一次且被 getElementById 挡住，所以「开机停在登录页 → 登录后进 TV 页」这条路径上
      条根本不会再建，只认 id 就会把浮动按钮组当条来刷。
   ③ **刻意不加 backdrop-filter**：底色已是 alpha 1 的纯 tint，模糊贡献恒为零，加了只是白烧 GPU。
      全文档 backdrop-filter 仍恰好 1 层(L 段那条)，守住文件头第 7 条的低 GPU 约束。

   图标色与 hover 不在这里写死颜色，而是重定义 theme.ts 那批 --fnos-titlebar-* 变量：
   变量声明在 body 上、按继承就近生效，压过 theme.ts 声明在 :root / html.dark 上的同名变量，
   titlebar.ts 注入的样式表消费同名变量即自动跟随 → 零特异性对抗、明暗双主题同一条规则。
   tint 恒为暗色(heroTint.ts 把 HSL 亮度上限锁在 L<=0.20)，故图标恒白、hover 恒白系，不分主题。
   取色失败时 --fnos-hero-tint 不存在 → 精确回落 25,25,26，与 L 段的降级路径完全一致。 */
body.fnos-beautify{
  --fnos-titlebar-icon:#fff;
  --fnos-titlebar-hover-minmax:rgba(255,255,255,.14);
  --fnos-titlebar-hover-close-bg:rgba(232,17,35,.55);
  --fnos-titlebar-hover-close-icon:#fff;
}
body.fnos-beautify #custom-titlebar[data-fntv-tb]::before{
  /* [lc-1027] **直角** + 外扩 2px：白弧根因 = 本条自带的 16px 圆角与窗口圆角裁剪同心
     重叠。活体实证（红条染色实验）：mainwin ① 的 html overflow:hidden+border-radius:
     16px 连 **fixed 后代**一起按 r16 圆角裁（给本条 radius 18 也被裁回 16 弧线），
     于是弧线处有两条 AA 渐变带叠加——本条渐弱处透出其下粉白亚克力/L 段采样的
     浅色 → 用户报障的「右上角圆角白线」。
     本条改直角后覆盖在窗口内处处=1，弧线上只剩 html 裁剪这一次反走样（深 tint 对
     透明桌面）→ 无缝。外扩 2px 防右/上边缘亚像素缝隙；底边多出的 2px 落在 L 条
     同色 tint 区（M/L 接缝本就要求恒等），不可见。
     ⚠ 前置修复（mainwin ②）：body 原挂的 backdrop-filter ≠ none 会把 body 变成
       fixed 后代的包含块，body 的圆角 overflow 同样裁本条——已移除（该 blur 在
       透明窗口里本就是空转：body 背后没有任何已画内容）。 */
  content:''; position:absolute; inset:-2px; pointer-events:none;
  background:rgba(var(--fnos-hero-tint, 25,25,26), 1);
}

/* ===== N. Series 一级页：满屏海报 + 左下角柔光玻璃聚簇（lc-1010，用户指定方向）=====
   诉求(用户原话)：「整个横屏海报占满全屏，剧集信息选择季数等东西都放到左下角你排列一下，
   整体添加上高级材质，柔光玻璃样式。风格尽量趋向于苹果设计理念」，后追加：
   「玻璃质感但是不要有线条感，左下角各容器不要有实心颜色，要半透的玻璃效果」，再追加：
   「左下角内容区底色还是实心的，要半透效果可以看到最底下的横屏海报图；顶部有侧边栏按钮的
   一横内容栏有框线框的感觉，做成全透的」。

   布局原理（为什么必须 JS 配合一个变量）：
   用户要的是「海报满屏 + 信息悬浮其上」，即聚簇必须**脱离文档流**悬浮在 hero 上，
   而聚簇自下而上是 面板(高度随内容) → 按钮行 → logo —— 后两者要贴着面板顶沿排，
   纯 CSS 无法让「上方元素」贴住「下方未知高度元素」的顶。故 tmdbCard.ts 在系列页 settle 时
   实测面板高度写 body 级 --fnos-cluster-h（面板高 + bottom 偏移，getComputedStyle 读，
   不重复常量），按钮行/logo 的 bottom 都用 var() 挂在它上面；简介回填、TMDB 卡挂载、
   窗口 resize 时重测。变量缺省回落 360px（面板常见高度），JS 未跑时布局仍成立。

   悬浮实现：col 加 position:relative + min-height:100vh-32px；按钮行 absolute（锚 wrapper，
   wrapper 因按钮行脱流而恰等于 hero 高度 = 满屏）；面板 absolute（锚 col，bottom:18px）。
   三者全部脱流/悬浮 → 页面内容只剩满屏 hero → 恰好一屏、无滚动条。
   ⚠ 刻意用 absolute 而非 fixed：pageAnim 的页面过渡会对视图祖先加 transform，
   fixed 祖先带 transform 时会退化为相对该祖先定位（且视口语义失效），absolute 锚定 col 不受影响。

   柔光玻璃（用户点名：无线条感、无实心、半透）：
   · 材质 = 白色高光渐变(13%→1.5% 对角) + tint 半透底(.32) + blur(40px) saturate(160%)，
     tint 用 --fnos-hero-tint（封面取色，heroTint.ts）→ 玻璃永远和海报同色系（Apple vibrancy 思路）。
   · 无边框：panel/circle/季卡全部 border:none；卡内 I 段分节发丝线在本页去除（N8）；
     inset 高光也省略（1px 内描边就是「线条感」）。
   · 面板作用域内把 Semi 文本变量重定义为浅色（材质恒暗，heroTint 锁 L<=0.20）→
     I 段卡片样式零改动自动获得可读的浅色文字，明暗主题同一条规则。

   一屏语义：原生页此时也确实只有 hero+面板两层内容（外链行隐藏，见 N7），满屏后无内容被裁。 */
/* N1. col 满屏容器 */
body.fnos-series-panel div[class*="mb-[46px]"][class*="flex flex-col gap-3"]:has(> div > .trim-mc__details--key-version){
  position:relative !important;
  min-height:calc(100vh - 32px) !important;
  margin-bottom:0 !important;
}
/* N2. hero 满屏（覆盖 .trim-mc__details--key-version 类自带的 560/576/470/48vh/700 分档） */
body.fnos-series-panel .trim-mc__details--key-version{
  height:calc(100vh - 32px) !important;
  min-height:0 !important; max-height:none !important;
}
/* 底部渐变遮罩重做（用户第二轮反馈：「半透效果可以看到最底下的横屏海报图」+「顶栏全透」）：
   原生 .gradient 是整幅贴底横带（alpha 1→0，L 段照抄），玻璃后面全是被压黑的图 → 玻璃发闷像实心。
   改为 25deg 对角渐隐：只护左下角聚簇文字区，右下/中部的海报完全透出。
   ⚠ 类名写两遍：L 段同选择器(0,4,0)在本文件更早处，这里必须打平后靠源序取胜。 */
body.fnos-series-panel .trim-mc__details--key-version.trim-mc__details--key-version .gradient{
  height:58% !important;
  background-image:linear-gradient(25deg,
    rgba(var(--fnos-hero-tint, 25,25,26), .62) 0%,
    rgba(var(--fnos-hero-tint, 25,25,26), .34) 30%,
    rgba(var(--fnos-hero-tint, 25,25,26), .10) 55%,
    rgba(var(--fnos-hero-tint, 25,25,26), 0) 75%) !important;
}
/* 遮罩变轻后，悬浮文字靠投影保可读（不引入新的底色/框）。
   双层投影：小半径压亮边、大半径兜亮区（genre 行在亮部海报上单层不够）。 */
body.fnos-series-panel ${SERIES_BTNROW} span{
  text-shadow:0 1px 2px rgba(0,0,0,.6), 0 2px 18px rgba(0,0,0,.5) !important;
}
body.fnos-series-panel .trim-mc__details--key-version > [class*="inset-x-[46px]"] img{
  filter:drop-shadow(0 2px 14px rgba(0,0,0,.45));
}
/* N2b. 顶栏全透（用户第二轮反馈：「顶部有侧边栏按钮的一横内容栏有框线框的感觉」）。
   L 段给顶栏 ::before 铺了取色玻璃条+渐隐 mask，在满屏海报上读作一条带下边缘的暗带；
   本页玻璃面板已承载对比度，顶栏改为完全透明，图标保持 K 段白色 + drop-shadow 保可读。 */
body.fnos-series-panel div[class*="h-[80px]"][class*="top-0"]::before{
  content:none !important;
}
body.fnos-series-panel div[class*="h-[80px]"][class*="top-0"] svg{
  filter:drop-shadow(0 1px 6px rgba(0,0,0,.4));
}
/* N2c [lc-1024] 标题栏(最顶 32px 窗口控制条)随顶栏一并全透 + 海报顶满窗口。
   用户报障：「打开一级详情页时，最顶上的控制栏一横条颜色不对很突兀」。
   根因：M 段给详情页标题栏铺的实色 tint 条是为二级页设计的 —— 彼处 L 段顶栏玻璃条
   首行 alpha 恰为 1，y=31/32 两行对任意 x 恒等(接缝 1.0000)；本页顶栏已被 N2b 全透，
   M 条孤悬在满屏海报上方，条色(封面取色的暗色调)与海报顶部像素无关 → 读作一条异物。
   若只摘条不补图，y=0..31 露的是 body 近白亚克力(非玻璃态)/桌面·环境光底(玻璃态)，
   依旧是一条横带。∴ 摘条 + 海报上提 32px 吃满安全区(height 100vh + margin-top:-32px)，
   条区背后就是海报延续，整窗一张图真正满屏；窗口控制键沿用 M 段白色图标 +
   N2b 同款 drop-shadow 保可读(与顶栏图标同待遇)。
   几何零位移核算：btn row/panel 全部 bottom 锚定 wrapper/col 底(y=100vh)，hero 负 margin
   只让其可见顶边上移(wrapper 高 = hero margin box 100vh-32 不变，hero 视觉溢出 wrapper 顶
   32px，col/wrapper 均 overflow 可见)，悬浮聚簇位置一个像素都不动。 */
body.fnos-series-panel #custom-titlebar[data-fntv-tb]::before{
  content:none !important;
}
body.fnos-series-panel .trim-mc__details--key-version{
  height:100vh !important;
  margin-top:-32px !important;
}
body.fnos-series-panel #custom-titlebar[data-fntv-tb] button svg{
  filter:drop-shadow(0 1px 6px rgba(0,0,0,.4));
}
/* N3. logo 上移到按钮行上方（18 面板底距 + 12 间隙 + 54 按钮行 + 16 间隙 = 挂在 var 上方 100px） */
body.fnos-series-panel .trim-mc__details--key-version > [class*="inset-x-[46px]"][class*="bottom-[30px]"]{
  bottom:calc(var(--fnos-cluster-h, 360px) + 100px) !important;
}
/* N4. 按钮行悬浮（wrapper 脱流后高度=hero，bottom:0 即视口底） */
body.fnos-series-panel ${SERIES_BTNROW}{
  position:absolute !important;
  bottom:calc(var(--fnos-cluster-h, 360px) + 30px) !important;
  left:26px !important;
  width:min(1020px, calc(100vw - 52px)) !important;
  padding:0 20px !important; margin:0 !important;
  box-sizing:border-box !important; z-index:3 !important;
}
/* 按钮行恒暗背景（海报底部渐变）→ 文字/图标统一浅色（svg fill=currentColor 全链继承） */
body.fnos-series-panel ${SERIES_BTNROW} span{ color:rgba(255,255,255,.78) !important; }
body.fnos-series-panel ${SERIES_BTNROW} svg{ color:rgba(255,255,255,.92) !important; }
/* 圆形按钮（收藏/已看/更多）：半透玻璃、无边框（原生 border+fill-0 实心底一并去掉） */
body.fnos-series-panel ${SERIES_BTNROW} div[class*="size-[54px]"]{
  background:rgba(255,255,255,.10) !important;
  backdrop-filter:blur(20px) saturate(150%) !important;
  -webkit-backdrop-filter:blur(20px) saturate(150%) !important;
  border:none !important;
}
body.fnos-series-panel ${SERIES_BTNROW} div[class*="size-[54px]"]:hover{
  background:rgba(255,255,255,.18) !important;
}
/* N5. 信息面板：半透柔光玻璃，无边框。
   [lc-1010] 二轮降底色：tint .32→.16、blur 40→30。
   [lc-1021] 用户第三轮反馈「整个左下面板透明再透一点」：tint .16→.09、白色高光梯度再降、
   blur 30→26、brightness .78→.86（压暗减轻=更透，可读性仍由 blur+saturate+浅色文字投影承担）。
   无卡时 600px（正好包住左列），有卡时 1020px（:has 门控，卡挂载/撤除自动切换）。 */
body.fnos-series-panel ${SERIES_PANEL}{
  position:absolute !important;
  bottom:18px !important; left:26px !important;
  width:min(600px, calc(100vw - 52px)) !important;
  max-height:calc(100vh - 32px - 210px) !important;
  padding:18px 20px !important;
  display:block !important;
  background:linear-gradient(160deg,
    rgba(255,255,255,.05) 0%,
    rgba(255,255,255,.014) 45%,
    rgba(255,255,255,.005) 100%),
    rgba(var(--fnos-hero-tint, 25,25,26), .09) !important;
  /* brightness 压暗玻璃后的画面而不是叠不透明色（Apple dark vibrancy 手法）——
     海报结构透玻璃可见，白字在亮部海报上仍有对比（用户要求半透见底，禁再加 tint） */
  backdrop-filter:blur(26px) saturate(155%) brightness(.86) !important;
  -webkit-backdrop-filter:blur(26px) saturate(155%) brightness(.86) !important;
  border:none !important;
  box-shadow:0 18px 54px rgba(0,0,0,.32) !important;
  border-radius:22px !important;
  box-sizing:border-box !important;
  overflow:hidden !important;
  z-index:2 !important;
  animation:fnos-series-panel-in .5s cubic-bezier(.22,.61,.36,1) both;
}
body.fnos-series-panel ${SERIES_PANEL}:has(> .fnos-beautify-card){
  width:min(1020px, calc(100vw - 52px)) !important;
}
@keyframes fnos-series-panel-in{
  from{ opacity:0; transform:translateY(14px); }
  to{ opacity:1; transform:none; }
}
/* 面板内恒暗材质 → Semi 文本变量重定义为浅色（I 段卡样式零改动自动跟随） */
body.fnos-series-panel ${SERIES_PANEL}{
  --semi-color-text-0:rgba(255,255,255,.94);
  --semi-color-text-1:rgba(255,255,255,.72);
  --semi-color-text-2:rgba(255,255,255,.58);
  --semi-color-text-3:rgba(255,255,255,.42);
}
/* N6. 简介：全文展示（tmdbCard.ts 从 React fiber props.intro 回填，原生被截成 1 行且「更多」点击无效）。
   回填成功后打 .fnos-intro-full 标记隐藏「更多」（全文已示，按钮无功能且 native 点击不展开）。
   ⚠ 不能 innerHTML 整体替换：那是 React 管理的子树，替换后 React 卸载时 removeChild 会炸；
   只改文本节点 data（截断库同款手法），库在 resize 时会按它闭包里的全文重新截断 →
   tmdbCard.ts 的 resize 监听里重跑回填（220ms 去抖，晚于库的同步 handler，最终态必是我们）。 */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="text-justify"]{
  margin:0 !important; width:100% !important;
  font-size:14px !important; line-height:1.7 !important;
  color:rgba(255,255,255,.88) !important;
  text-shadow:0 1px 8px rgba(0,0,0,.38) !important;
}
body.fnos-series-panel ${SERIES_PANEL}:has(> .fnos-beautify-card) > div[class*="text-justify"]{
  width:calc(57% - 15px) !important;
}
body.fnos-series-panel .fnos-intro-full [class*="ml-1"][class*="cursor-pointer"]{
  display:none !important;
}
/* N7. 季选择：Apple TV 式横滑行。[lc-1021] 用户定稿：海报保持**原生竖版 2:3**（撤销 lc-1010 的
   16:9 横版强转——实机发现强转后季行右侧出现黑块，且横版丢掉了海报原画的竖版构图）；
   多季布局 = 卡宽 25%-11px（600/1020 两种面板宽下都恰好 4 张整卡一屏，不出现裁边碎片），
   超出横向滑动（滚动条隐藏）。
   季卡 = .card-root：mainwin.ts ⑩ 会给它玻璃卡实心底+边框 → 在面板内全部去框去实心（用户点名）。
   ⚠ 黑边真凶（lc-1021 活体 CDP 实证，NAS CSS 原文）：
     .card-root{width:var(--card-width)}
     .card-root .poster-box{--poster-box-width:var(--card-width);
       aspect-ratio:var(--poster-aspect-ratio,2/3); width:var(--poster-box-width);
       border:1px solid var(--semi-color-card-border); border-radius:8px; overflow:hidden}
   海报宽度是**变量钉死**的（不跟随卡片实际宽度）：lc-1010 把卡强撑 238px 时海报停在 ~162px
   → 右侧 76px 空带露出深色渐变/底图 = 用户截图的黑边；反过来卡收窄后海报会溢出压到邻卡。
   ∴ 必须把 poster-box 宽度改回 100% 跟随卡片，原生 1px 描边与「无线条」玻璃一并去框。 */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"]{
  margin:14px 0 0 !important; width:100% !important;
  display:flex !important; flex-wrap:nowrap !important;
  overflow-x:auto !important; overflow-y:hidden !important;
  gap:14px !important; padding:2px !important;
  scrollbar-width:none !important;
}
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"]::-webkit-scrollbar{ display:none !important; }
body.fnos-series-panel ${SERIES_PANEL}:has(> .fnos-beautify-card) > div[class*="flex-wrap"]{
  width:calc(57% - 15px) !important;
}
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] > [data-id="details"]{
  width:calc(25% - 11px) !important; flex:0 0 auto !important;
  background:transparent !important; border:none !important; box-shadow:none !important;
  backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
}
/* 海报竖版 2:3（原生比例）+ 宽度跟随卡片（掐掉黑边根源，见 N7 头注）+ 去原生 1px 描边：
   容器给比例与宽度、内部 absolute 填满链不动（同 lc-986 结论） */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] .poster-box{
  width:100% !important;
  aspect-ratio:2 / 3 !important;
  border:none !important;
}
/* [lc-1021] 季卡内层防黑块保险：原生海报容器/占位层的深色底（--semi-color-bg-placeholder）
   在玻璃上一律透明化/弱化 —— 图片加载期间玻璃上不再闪深色块 */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] .poster-box,
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] > div:first-child{
  background:transparent !important;
}
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] [class*="bg-[var(--semi-color-bg-placeholder)]"]{
  background:rgba(255,255,255,.06) !important;
}
/* 底部渐变层：竖版 198px 高给 64px（原 76px 为 2:3 设计，仅微调） */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] > div:first-child [class*="bg-gradient-to-t"]{
  height:64px !important;
}
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] p{
  text-align:left !important; margin:6px 0 0 1px !important;
  font-size:12px !important;
  color:rgba(255,255,255,.9) !important;
}
/* 标题/副题文本块是 a.flex.flex-col.items-center → flex 居中压过 text-align，改容器对齐 */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] > a[class*="items-center"]{
  align-items:flex-start !important;
}
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex-wrap"] [data-id="details"] p + p{
  margin:2px 0 0 1px !important;
  font-size:11px !important;
  color:rgba(255,255,255,.55) !important;
}
/* J 段会给季卡标题追加清晰度胶囊（季卡同样带 data-id=details + 角标位图，复用集卡逻辑）：
   原生标题 p 若带 truncate 会把胶囊裁没 → 同 J 段的解禁规则，此处按面板作用域重写 */
body.fnos-series-panel ${SERIES_PANEL} [data-id="details"] p:has(> .fnos-ep-res){
  white-space:normal !important; overflow:visible !important; text-overflow:clip !important;
}
/* N8. 原生外链行（链接：IMDB链接）隐藏 —— 与季页 A 段同一决策（lc-988 用户明确要求去掉），
   卡内 N8b 外链区已覆盖；双条件同 A 段（有外链 且 无人物链接）。 */
body.fnos-series-panel ${SERIES_PANEL} > div[class*="flex flex-col gap-4"]:has(a[href*="imdb.com"], a[href*="themoviedb.org"]):not(:has(a[href*="/v/person/"])){
  display:none !important;
}
/* N8b. TMDB 卡：绝对定位到右列（面板高度只由左列简介+季选驱动，卡超高时内部滚动，
   不会像 grid 流内子项那样把整面板撑到 max-height）。卡自身无框无底 —— 玻璃就是容器（用户点名）。
   分节发丝线在本页去除：玻璃上不再叠线条。 */
body.fnos-series-panel ${SERIES_PANEL} > .fnos-beautify-card{
  position:absolute !important;
  top:16px !important; bottom:16px !important;
  left:calc(57% + 6px) !important; right:16px !important;
  width:auto !important;
  margin:0 !important; padding:2px 10px 2px 4px !important;
  background:transparent !important; border:none !important; box-shadow:none !important;
  overflow-y:auto !important; overflow-x:hidden !important;
  scrollbar-width:thin !important;
  scrollbar-color:rgba(255,255,255,.16) transparent !important;
}
body.fnos-series-panel ${SERIES_PANEL} > .fnos-beautify-card::-webkit-scrollbar{ width:4px !important; }
body.fnos-series-panel ${SERIES_PANEL} > .fnos-beautify-card::-webkit-scrollbar-thumb{
  background:rgba(255,255,255,.16) !important; border-radius:2px !important;
}
body.fnos-series-panel ${SERIES_PANEL} .fnos-showinfo__sec{
  border-top:none !important; padding-top:12px !important;
}
`;

/** 注入美化样式表（幂等：已存在则跳过）。全程只注入这一份 <style>，一次成型。 */
export function injectBeautifyStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = BEAUTIFY_CSS;
  (document.head || document.documentElement).appendChild(st);
}

/** 移除美化样式表（离开详情页/关闭开关时；O(1) 廉价）。 */
export function removeBeautifyStyle(): void {
  const st = document.getElementById(STYLE_ID);
  if (st && st.parentNode) st.parentNode.removeChild(st);
}
