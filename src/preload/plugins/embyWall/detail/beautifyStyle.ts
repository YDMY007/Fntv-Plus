// embyWall/detail/beautifyStyle.ts — 详情页美化样式表（lc-980 重写）
// ─────────────────────────────────────────────────────────────────────────────
// 设计原则（根治旧版卡顿/错乱）：
//   1. CSS 优先、零节点搬运：两栏布局用 CSS Grid 直接作用在原生内容列上
//      （`:has(> hero)` 唯一命中 hero 的父列，再用 `> :nth-child(n)` 分区），
//      绝不移动/重排任何 React 原生节点 → React 重渲染时选择器自动重新匹配，不再打架。
//   2. 只增不改：全表只依赖 body.fnos-beautify 作用域；backdrop / 加载层 / TMDB 卡是注入节点。
//   3. 确定性对比度：靠注入底图的固定暗渐变 scrim 保证文字可读，无运行时亮度采样。
//   4. 悬停用 CSS :hover，不用 JS 逐卡绑定监听器。
//   5. 两栏门控 `:has([data-id="details"])`：仅 season 页(有选集)走两栏；
//      movie/tv 无集卡 → 自动降级为原生单列 + 底图 + 磨砂，纯 CSS 无需 JS 判定。
// 视觉：简化轻量版——实心磨砂卡片(少 backdrop-filter)、克制圆角/阴影/过渡。
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_ID = 'fnos-beautify-css';

/** hero 精准选择器（与 glass.ts DETAIL_HERO_SEL 一致）：`.semi-always-dark` 全文档 5 个，
 *  只有 hero 带 h-[470px]；用属性子串避开 Tailwind 任意值转义。 */
const HERO = '.semi-always-dark[class*="h-[470px]"]';
/** 内容列（hero 的直接父列 .mb-[46px].flex.flex-col.gap-3），且含选集卡才启用两栏。 */
const COL = `:has(> ${HERO}):has([data-id="details"])`;

export const BEAUTIFY_CSS = `
/* ===== A. 两栏 Grid（仅 season 页；零节点搬运，React-proof）===== */
body.fnos-beautify ${COL}{
  display:grid !important;
  grid-template-columns:minmax(0,60fr) minmax(0,40fr) !important;
  grid-template-rows:auto auto auto !important;
  column-gap:24px !important;
  row-gap:16px !important;
  align-items:start !important;
  align-content:start !important;
  width:100% !important;
  box-sizing:border-box !important;
}
/* hero 跨全宽(row1) */
body.fnos-beautify ${COL} > ${HERO}{ grid-area:1 / 1 / 2 / 3 !important; }
/* 选集：左列 row2 */
body.fnos-beautify ${COL} > :nth-child(2){ grid-area:2 / 1 / 3 / 2 !important; min-width:0 !important; }
/* 演职人员：右列 row2（与选集并排，顶部对齐） */
body.fnos-beautify ${COL} > :nth-child(3){ grid-area:2 / 2 / 3 / 3 !important; min-width:0 !important; }
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

/* ===== D. 选集卡：实心磨砂 + 克制悬停（简化轻量版，不用 backdrop-filter）===== */
body.fnos-beautify [data-id="details"]{
  background:var(--semi-color-bg-2,#fff) !important;
  border:1px solid var(--semi-color-border,rgba(0,0,0,.07)) !important;
  border-radius:14px !important;
  box-shadow:0 2px 10px rgba(0,0,0,.05) !important;
  transition:transform .22s cubic-bezier(.25,.1,.25,1), box-shadow .22s ease, border-color .22s ease !important;
}
body.fnos-beautify [data-id="details"]:hover{
  transform:translateY(-2px) !important;
  box-shadow:0 10px 26px rgba(0,0,0,.11) !important;
  border-color:var(--semi-color-border,rgba(0,0,0,.12)) !important;
}
body.fnos-beautify [data-id="details"] img{ border-radius:10px !important; }

/* ===== E. 演职人员/人物项：轻量磨砂 ===== */
body.fnos-beautify a[href*="/v/person/"]{
  border-radius:14px !important;
  transition:transform .22s cubic-bezier(.25,.1,.25,1) !important;
}
body.fnos-beautify a[href*="/v/person/"]:hover{ transform:translateY(-2px) !important; }
body.fnos-beautify a[href*="/v/person/"] img{ border-radius:12px !important; }

/* ===== F. hero 海报微投影（hero 整体保持原生，只让海报更立体）===== */
body.fnos-beautify ${HERO} img[class*="rounded"], body.fnos-beautify ${HERO} .shrink-0 img{
  box-shadow:0 12px 34px rgba(0,0,0,.32) !important;
}

/* ===== G. 注入的全屏底图层（backdrop.ts 创建）===== */
.fnos-detail-backdrop{
  position:fixed !important; inset:0 !important; z-index:-1 !important;
  pointer-events:none !important; overflow:hidden !important;
}
.fnos-detail-backdrop__img{
  position:absolute !important; inset:-8% !important;
  background-size:cover !important; background-position:center 20% !important;
  filter:blur(46px) saturate(1.25) !important;
  transform:scale(1.12) !important; opacity:.55 !important;
}
.fnos-detail-backdrop__scrim{
  position:absolute !important; inset:0 !important;
  background:linear-gradient(to bottom,rgba(0,0,0,.18) 0%,rgba(0,0,0,.34) 42%,rgba(0,0,0,.62) 100%) !important;
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

/* ===== I. 延后注入的 TMDB 信息卡（tmdbCard.ts 创建，追加进右栏）===== */
.fnos-beautify-card{
  background:var(--semi-color-bg-2,#fff) !important;
  border:1px solid var(--semi-color-border,rgba(0,0,0,.07)) !important;
  border-radius:16px !important;
  box-shadow:0 3px 16px rgba(0,0,0,.06) !important;
  padding:18px 20px !important; margin-bottom:16px !important;
  color:var(--semi-color-text-0,#1d1d1f) !important;
  font-size:13px !important; line-height:1.7 !important;
}
.fnos-beautify-card__title{ font-size:16px !important; font-weight:700 !important; margin-bottom:8px !important; line-height:1.35 !important; }
.fnos-beautify-card__orig{ font-size:12px !important; font-weight:400 !important; color:var(--semi-color-text-2,#86868b) !important; margin-left:6px !important; }
.fnos-beautify-card__rating{ margin-bottom:10px !important; font-size:13px !important; color:var(--semi-color-text-2,#86868b) !important; }
.fnos-beautify-card__score{ color:#f5a623 !important; font-weight:800 !important; font-size:20px !important; }
.fnos-beautify-card__votes{ margin-left:6px !important; font-size:12px !important; }
.fnos-beautify-card__row{ display:flex !important; gap:8px !important; margin-bottom:5px !important; align-items:baseline !important; }
.fnos-beautify-card__k{ color:var(--semi-color-text-2,#86868b) !important; flex:0 0 56px !important; }
.fnos-beautify-card__v{ color:var(--semi-color-text-0,#1d1d1f) !important; min-width:0 !important; flex:1 1 auto !important; }
.fnos-beautify-card__tags{ display:inline-flex !important; flex-wrap:wrap !important; gap:5px !important; }
.fnos-beautify-card__tag{
  display:inline-flex !important; align-items:center !important; gap:4px !important;
  padding:1px 9px !important; border-radius:20px !important; font-size:11px !important;
  background:var(--semi-color-fill-1,#f5f5f7) !important; color:var(--semi-color-text-1,#3c3c43) !important;
  border:1px solid var(--semi-color-border,rgba(0,0,0,.05)) !important;
}
.fnos-beautify-card__char{ font-style:normal !important; color:var(--semi-color-text-2,#86868b) !important; }
.fnos-beautify-card__char::before{ content:'· ' !important; }
.fnos-beautify-card__desc{ margin-top:10px !important; color:var(--semi-color-text-1,#3c3c43) !important; cursor:pointer !important; }
.fnos-beautify-card__clamp{ display:-webkit-box !important; -webkit-line-clamp:3 !important; -webkit-box-orient:vertical !important; overflow:hidden !important; }
.fnos-beautify-card__links{ margin-top:12px !important; display:flex !important; flex-wrap:wrap !important; gap:6px !important; align-items:center !important; font-size:12px !important; }
.fnos-beautify-card__links a{ color:#4a7fe0 !important; text-decoration:none !important; }
.fnos-beautify-card__links a:hover{ text-decoration:underline !important; }
.fnos-beautify-card__links span{ color:var(--semi-color-text-2,#86868b) !important; }
.fnos-beautify-card__loading,.fnos-beautify-card__error{ color:var(--semi-color-text-2,#86868b) !important; font-size:12px !important; padding:4px 0 !important; }
.fnos-beautify-card__foot{
  margin-top:12px !important; padding-top:10px !important; border-top:1px solid var(--semi-color-border,rgba(0,0,0,.06)) !important;
  display:flex !important; justify-content:space-between !important; align-items:center !important;
  font-size:11px !important; color:var(--semi-color-text-2,#86868b) !important;
}
.fnos-beautify-card__refresh{
  background:var(--semi-color-fill-1,#f5f5f7) !important; border:1px solid var(--semi-color-border,rgba(0,0,0,.08)) !important;
  border-radius:8px !important; padding:2px 10px !important; cursor:pointer !important;
  color:var(--semi-color-text-1,#3c3c43) !important; font-size:11px !important; transition:background .18s ease !important;
}
.fnos-beautify-card__refresh:hover{ background:var(--semi-color-fill-2,#e9e9ec) !important; }

/* ===== J. 暗色模式覆盖 ===== */
html.dark body.fnos-beautify [data-id="details"],
html.dark body.fnos-beautify .fnos-beautify-card{
  background:var(--semi-color-bg-2,#1c1c1e) !important;
  border-color:rgba(255,255,255,.08) !important;
  box-shadow:0 2px 12px rgba(0,0,0,.4) !important;
}
html.dark body.fnos-beautify [data-id="details"]:hover{ box-shadow:0 10px 28px rgba(0,0,0,.55) !important; }
html.dark body.fnos-beautify .fnos-detail-backdrop__img{ opacity:.42 !important; }
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
