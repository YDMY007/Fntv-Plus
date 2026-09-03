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
  grid-template-rows:auto auto auto !important;
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
/* 右列清框：原生容器若带 border/底色/阴影，会与卡内分隔线拼出「半闭合框」→ 一律抹掉，
   右栏只保留排版（标题/评分/label+value/链接），不出现任何盒子。 */
body.fnos-beautify ${COL} > :nth-child(3),
body.fnos-beautify ${COL} > :nth-child(3) > *{
  background:transparent !important;
  border:none !important; box-shadow:none !important;
}
/* 链接(IMDB)：全宽 footer row3 */
body.fnos-beautify ${COL} > :nth-child(4){ grid-area:3 / 1 / 4 / 3 !important; min-width:0 !important; }

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
/* 缩略图 = 卡片首子节点（原生 flex-col 海报式：图在顶）→ 固定左列并跨行居中；
   其余文本子节点由 Grid 自动流入右列逐行堆叠，无需知道其类名/顺序。
   ⚠ 必须清掉原生给它的高度约束(定高/aspect 类)：否则容器比 16:9 图高出一截，
     内部 absolute 的清晰度角标(1080)/播放按钮会掉到图片下方空白处 → 角标错位。 */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] > :first-child{
  grid-column:1 !important; grid-row:1 / span 3 !important;
  align-self:center !important; justify-self:start !important;
  width:180px !important; max-width:180px !important;
  height:auto !important; min-height:0 !important; max-height:none !important;
  position:relative !important;
}
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] > :first-child img{
  display:block !important; width:100% !important; height:auto !important;
  aspect-ratio:16 / 9 !important; object-fit:cover !important;
  border-radius:10px !important;
  box-shadow:0 2px 12px rgba(0,0,0,.16) !important;
  transition:transform .34s cubic-bezier(.25,.1,.25,1) !important;
}
/* 行间发丝分隔（相邻卡）+ 悬停微底色 & 缩略图微放大（克制，无 lift/无大阴影） */
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"] + [data-id="details"]{
  border-top:1px solid var(--fnos-hairline-soft) !important;
}
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"]:hover{ background:var(--fnos-row-hover) !important; }
body.fnos-beautify ${COL} > :nth-child(2) [data-id="details"]:hover > :first-child img{ transform:scale(1.035) !important; }

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

/* ===== I. 延后注入的 TMDB 剧集信息卡（tmdbCard.ts，追加进右列）：Apple 排版主导，透明无框 ===== */
.fnos-beautify-card{
  background:transparent !important;
  border:none !important; box-shadow:none !important; border-radius:0 !important;
  padding:2px 0 0 !important; margin:0 0 6px !important;
  color:var(--semi-color-text-0,#1d1d1f) !important;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif !important;
  font-size:13px !important; line-height:1.6 !important;
  -webkit-font-smoothing:antialiased !important;
}
.fnos-beautify-card__title{
  font-size:21px !important; font-weight:600 !important; letter-spacing:-.022em !important;
  line-height:1.22 !important; margin:0 0 3px !important; color:var(--semi-color-text-0,#1d1d1f) !important;
}
.fnos-beautify-card__orig{
  display:block !important; font-size:12.5px !important; font-weight:400 !important;
  letter-spacing:0 !important; color:var(--fnos-muted) !important; margin-top:3px !important;
}
.fnos-beautify-card__rating{ display:flex !important; align-items:baseline !important; gap:7px !important; margin:12px 0 4px !important; }
.fnos-beautify-card__star{ color:#ff9f0a !important; font-size:13px !important; line-height:1 !important; }
.fnos-beautify-card__score{ font-size:17px !important; font-weight:600 !important; letter-spacing:-.01em !important; color:var(--semi-color-text-0,#1d1d1f) !important; }
.fnos-beautify-card__votes{ font-size:12px !important; color:var(--fnos-muted) !important; }
/* 信息行：label + value，纯留白分隔（无横线——用户明确要求「内部文字不要加线框」） */
.fnos-beautify-card__row{ display:flex !important; gap:14px !important; align-items:baseline !important; padding:5px 0 !important; }
.fnos-beautify-card__k{ flex:0 0 62px !important; font-size:12.5px !important; color:var(--fnos-muted) !important; }
.fnos-beautify-card__v{ flex:1 1 auto !important; min-width:0 !important; font-size:13px !important; color:var(--semi-color-text-0,#1d1d1f) !important; word-break:break-word !important; }
.fnos-beautify-card__desc{ margin-top:14px !important; font-size:13px !important; line-height:1.72 !important; color:var(--semi-color-text-1,#3c3c43) !important; cursor:pointer !important; }
.fnos-beautify-card__clamp{ display:-webkit-box !important; -webkit-line-clamp:4 !important; -webkit-box-orient:vertical !important; overflow:hidden !important; }
.fnos-beautify-card__links{ margin-top:16px !important; display:flex !important; flex-wrap:wrap !important; gap:4px 12px !important; align-items:center !important; font-size:12.5px !important; }
.fnos-beautify-card__links a{ color:var(--fnos-accent) !important; text-decoration:none !important; font-weight:500 !important; }
.fnos-beautify-card__links a:hover{ text-decoration:underline !important; }
.fnos-beautify-card__links span{ color:var(--semi-color-text-3,#c7c7cc) !important; }
.fnos-beautify-card__loading,.fnos-beautify-card__error{ color:var(--fnos-muted) !important; font-size:12.5px !important; padding:8px 0 !important; }
.fnos-beautify-card__foot{
  margin-top:18px !important;
  display:flex !important; justify-content:space-between !important; align-items:center !important;
  font-size:11px !important; color:var(--fnos-muted) !important;
}
.fnos-beautify-card__refresh{
  background:transparent !important; border:none !important; padding:2px 0 !important; cursor:pointer !important;
  color:var(--fnos-accent) !important; font-size:11.5px !important; font-weight:500 !important; font-family:inherit !important;
  transition:opacity .18s ease !important;
}
.fnos-beautify-card__refresh:hover{ opacity:.6 !important; }
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
