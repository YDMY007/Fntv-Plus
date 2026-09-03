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
//   4. 确定性对比度：backdrop scrim 随主题自适应，保证文本永远落在可读背景上，无运行时亮度采样。
//   5. 悬停用 CSS :hover（微底色 / 缩略图微放大），不用 JS 逐卡绑定，也不用 lift+大阴影。
//   6. 两栏门控 `:has([data-id="details"])`：仅 season 页(有选集)走两栏；movie/tv 自动降级单列。
//   7. 低 GPU：全表零 backdrop-filter（磨砂观感靠半透明 scrim + 模糊底图，不实时滤镜）。
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_ID = 'fnos-beautify-css';

/** hero 精准选择器（与 glass.ts DETAIL_HERO_SEL 一致）：`.semi-always-dark` 全文档 5 个，
 *  只有 hero 带 h-[470px]；用属性子串避开 Tailwind 任意值转义。 */
const HERO = '.semi-always-dark[class*="h-[470px]"]';
/** 内容列（hero 的直接父列 .mb-[46px].flex.flex-col.gap-3），且含选集卡才启用两栏。 */
const COL = `:has(> ${HERO}):has([data-id="details"])`;

export const BEAUTIFY_CSS = `
/* ===== 0. 语义设计 token（明/暗两套；文本色沿用 Semi 主题变量，无需在此重复）===== */
body.fnos-beautify{
  --fnos-accent:#0071e3;
  --fnos-hairline:rgba(0,0,0,.10);
  --fnos-hairline-soft:rgba(0,0,0,.055);
  --fnos-row-hover:rgba(0,0,0,.035);
  --fnos-panel-fill:rgba(0,0,0,.038);
  --fnos-muted:#86868b;
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

/* ===== F. hero 海报微投影（hero 整体保持原生，只让海报更立体）===== */
body.fnos-beautify ${HERO} img[class*="rounded"], body.fnos-beautify ${HERO} .shrink-0 img{
  box-shadow:0 16px 44px rgba(0,0,0,.34) !important;
}

/* ===== G. 注入的全屏底图层（backdrop.ts 创建）：明暗自适应 scrim ===== */
.fnos-detail-backdrop{
  position:fixed !important; inset:0 !important; z-index:-1 !important;
  pointer-events:none !important; overflow:hidden !important;
}
.fnos-detail-backdrop__img{
  position:absolute !important; inset:-8% !important;
  background-size:cover !important; background-position:center 18% !important;
  filter:blur(52px) saturate(1.22) !important;
  transform:scale(1.12) !important;
  opacity:var(--fnos-backdrop-img-opacity,.30) !important;
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
   分段(lc-988，11 段)：评分块(视觉锚) → 标语 → meta 串(无 label) → 简介 → 事实区(窄 label)
     → 主创 → 本季 → 剧照 → 相似剧集 → 更多(别名/关键词/在线看/热度/编号) → 外链 → 来源行。
   为什么这么长：飞牛原生季页**完全没有**这些数据，全是本插件从 TMDB 补的；
     用户明确要求「尽可能多获取和显示」。∴ 内容以「原生没有的」为界，不做删减。
     ⚠ 实机量过的硬证据(lc-988, /v/tv/season/盗墓王)：hero 的 innerText 只有 20 个字符
       「盗墓王 第 1 季 第 1 集 2026」；整个内容列除去「选集」区(每集标题+集简介+时长)后
       再无任何剧集简介/评分/主创/平台/分级/外链。**特别是剧集简介：原生一个字都没有**，
       卡内的简介段是唯一来源 —— 别照「hero 已有带更多的简介」这种印象把它当重复删掉。
   去重(仍然成立)：标题不渲染(hero 已有)；主演 cast 不渲染(原生「演职人员」区实机确认有头像+姓名横滑)，
     但主创分工(创作者/导演/编剧/作曲/制片/制作)原生区没有 → 补；
     原名降到事实区末行(日文/韩文原名常占两三行，放顶部会冲散评分块与 meta 串的节奏)。
   分组只靠留白 + 发丝线(__sec 的 border-top) + 11px 小标题，**节内零容器**(用户明确要求
     「只要一个大的容器包起来，内部的各小标题文字都不要有容器包裹」)。

   ⚠ 命名硬约束(lc-987, 用户明确要求「只要一个大的容器包起来，内部的各小标题文字都不要有容器包裹」)：
     glassUI.ts 的组件级玻璃规则写作 [class*="card"] —— 那是**子串**匹配。内部块原先叫
     fnos-beautify-card__*，全都含 card 子串 → 评分块/meta/事实区/外链/来源行乃至每一个 __row
     都被各自套上 background + backdrop-filter:blur(14px) + border + box-shadow，一层层小玻璃框
     叠在大框里(还顺带违背本文件「全表零 backdrop-filter」的低 GPU 约束)。
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
/* 标语：比简介更早给出调性，弱化到灰字一级。 */
.fnos-showinfo__tag{ font-size:12.5px !important; line-height:1.6 !important; color:var(--fnos-muted) !important; }
/* 简介：TMDB overview，正文级行高(1.75)让它成为卡里最易读的一段。 */
.fnos-showinfo__ov{ font-size:12.5px !important; line-height:1.75 !important; color:var(--semi-color-text-1,#3c3c43) !important; word-break:break-word !important; }
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
