import { S } from '../state';
import { dlog, log } from '../log';
import { fnosGetEditDetail } from '../carousel/logo';
import { ipcRenderer } from 'electron';
import { safeSelect } from './glass';
import { extractTmdbId } from '../carousel/api';

// embyWall/detail/season.ts — 季详情页：两栏布局、演职员墙、TMDB 信息卡、集数时长统计、简介补全、相关 CSS
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

const IMMERSIVE_SEASON_CSS = `/* 整体两栏：选集(左60%) + 侧栏(右40%) [lc-908] 从 64:36 调整为用户要求的 60:40 */
.fnos-immersive-season .fnos-season-2col{
  display:grid !important;
  width:100% !important;
  box-sizing:border-box !important;
  grid-template-columns:minmax(0,60fr) minmax(0,40fr) !important;
  grid-template-rows:minmax(0,1fr) !important; /* [lc-921] 单行占满高度, 两栏各自内部滚动 */
  gap:24px !important;
  align-items:stretch !important; /* [lc-921] 两栏撑满行高(替代 start, 否则列高不随网格受限 → 整页被撑开无法滚动) */
  /* 右侧留白：避免侧栏卡片贴上容器右缘（祖先 overflow:hidden）被误判为裁切 */
  padding-right:24px !important;
  /* [lc-921] 网格限高占满视口(具体高度由 layoutSeasonTwoPane 内联 calc(100vh - top) 兜底,
   *   不依赖祖先链 h-full 是否确定解析): 祖先 overflow-hidden 只裁切溢出, 网格自身被限高 →
   *   左右两栏 overflow-y:auto 在栏内独立滚动, 彻底解决"打开二级详情页无法下滑"。 */
  height:100% !important;
  min-height:0 !important;
  max-height:100% !important;
  overflow:hidden !important;
}
.fnos-immersive-season .fnos-season-main{
  width:auto !important; min-width:0 !important;
  height:100% !important; max-height:100% !important; min-height:0 !important;
  overflow-y:auto !important; overflow-x:hidden !important;
}
.fnos-immersive-season .fnos-season-aside{
  min-width:0 !important; max-width:none !important;
  height:100% !important; max-height:100% !important; min-height:0 !important;
  overflow-y:auto !important; overflow-x:hidden !important;
  /* [lc-928] 右栏底部留白, 避免最后一张卡片(如演员墙末行)贴底被截断/遮挡滚动条 */
  padding-bottom:32px !important;
}
.fnos-immersive-season .fnos-season-aside > *{ overflow:visible !important; max-width:none !important; }
/* [lc-928] 右栏内各 info-card 不被 flex 压缩(防御: 若将来右栏用 flex 布局, 卡片被压会丢演员/简介尾部) */
.fnos-immersive-season .fnos-season-aside > .fnos-info-card{ flex-shrink:0 !important; min-height:0 !important; }
/* 解除左栏内部 fnOS 固定高度/裁剪锁(仅针对已知布局包裹层, 不动选集卡片自身), 让选集内容在左栏内自然撑开并滚动 */
.fnos-immersive-season .fnos-season-main [class*="cache-outlet"],
.fnos-immersive-season .fnos-season-main .ms-container,
.fnos-immersive-season .fnos-season-main [class*="overflow-hidden"],
.fnos-immersive-season .fnos-season-main [class*="h-0"]{
  height:auto !important; min-height:0 !important; max-height:none !important;
  overflow:visible !important; flex:0 0 auto !important;
}

/* 选集容器：横向滚动 -> 纵向列表 */
.fnos-immersive-season .ms-container[class*="overflow-x-scroll"]:has([data-id="details"]){
  overflow:visible !important;
  white-space:normal !important;
}
.fnos-immersive-season .ms-container[class*="overflow-x-scroll"]:has([data-id="details"]) > div.flex.h-full.w-max{
  flex-direction:column !important;
  flex-wrap:nowrap !important;
  align-items:stretch !important;
  width:100% !important;
  height:auto !important;
  column-gap:0 !important;
}
/* 单集卡片：缩略图(左) + 信息(中) + 时长/状态(右) —— 浅色模式用 fnOS 原生浅色变量；深色模式见末尾 html.dark 覆盖块 */
.fnos-immersive-season [data-id="details"]{
  display:flex !important;
  flex-direction:row !important;
  align-items:center !important;
  width:100% !important;
  max-width:none !important;
  max-height:none !important;
  gap:16px !important;
  padding:10px 16px !important;
  margin-bottom:12px !important;
  background:var(--semi-color-bg-2,#fff) !important;
  border:1px solid var(--semi-color-border, rgba(0,0,0,.06)) !important;
  border-radius:14px !important;
  box-shadow:0 2px 10px rgba(0,0,0,.06) !important;
  overflow:visible !important;
  cursor:pointer !important;
  transition:transform .28s cubic-bezier(.25,.1,.25,1), box-shadow .28s ease !important;
}
.fnos-immersive-season [data-id="details"]:hover{
  transform:translateX(6px) !important;
  box-shadow:0 8px 25px rgba(0,0,0,.12) !important;
}
.fnos-immersive-season [data-id="details"] > div:first-child{
  width:160px !important;
  height:90px !important;
  flex:0 0 160px !important;
  border-radius:10px !important;
  overflow:hidden !important;
}
.fnos-immersive-season [data-id="details"] > div:first-child img{
  width:100% !important; height:100% !important; object-fit:cover !important; display:block !important;
}
.fnos-immersive-season [data-id="details"] > a{
  display:flex !important;
  flex-direction:column !important;
  justify-content:center !important;
  flex:1 1 auto !important;
  min-width:0 !important;
}
.fnos-immersive-season [data-id="details"] .fnos-ep-meta{
  display:flex !important; flex-direction:column !important; align-items:flex-end !important;
  gap:6px !important; flex:0 0 auto !important; margin-left:auto !important;
}
.fnos-immersive-season [data-id="details"] .fnos-ep-duration{ font-size:13px !important; color:var(--semi-color-text-2,#86868b) !important; white-space:nowrap !important; }
.fnos-immersive-season [data-id="details"] .fnos-ep-badge{
  font-size:11px !important; font-weight:600 !important; padding:.2rem .7rem; border-radius:20px; white-space:nowrap !important;
  background:var(--semi-color-fill-2,#f5f5f7) !important; color:var(--semi-color-text-0,#1d1d1f) !important;
}

/* [lc-907] 二级 TV/Movie 页主内容是「季」卡片(.card-root)网格, 而非 [data-id="details"] 选集卡片。
   这里不给它套上面那套"横排缩略图+信息+时长"布局(结构不同, 套了会乱), 只统一**卡片材质观感**:
   同样的背景/边框/圆角/阴影/hover 位移, 使二级页与季页视觉语言一致。背景走 fnOS 主题变量, 深浅模式自适应。 */
.fnos-immersive-season .fnos-season-main .card-root{
  background:var(--semi-color-bg-2,#fff) !important;
  border:1px solid var(--semi-color-border, rgba(0,0,0,.06)) !important;
  border-radius:14px !important;
  box-shadow:0 2px 10px rgba(0,0,0,.06) !important;
  overflow:hidden !important;
  transition:transform .28s cubic-bezier(.25,.1,.25,1), box-shadow .28s ease !important;
}
.fnos-immersive-season .fnos-season-main .card-root:hover{
  transform:translateY(-4px) !important;
  box-shadow:0 8px 25px rgba(0,0,0,.12) !important;
}

/* 右侧信息卡 —— [lc-930] 文字对比度自适应
 *   卡片背景 var(--semi-color-bg-2) 是随封面主题动态染色的(红橙动漫主题下被染红), 用户要求**保留该动态渐变不动**。
 *   可读性改由 JS applySeasonAsideContrast() 采样卡片实际背景亮度, 在 .fnos-season-aside 上挂
 *   data-fntv-text="light"(暗背景→浅字) / "dark"(亮背景→深字), 下方用 --fntv-info-*/--fntv-cast-* 变量驱动文字色。
 *   默认(无 data 属性, 浅色主题)走深字基准色。 */
.fnos-season-aside{ /* [lc-954] 去掉 .fnos-immersive-season 作用域: 对比度变量直接挂在 .fnos-season-aside 自身, 不再依赖 body 的 fnos-immersive-season 类(该类会被 applyDetailLiquidGlass 的 !isDetailPage 分支摘除), 确保 JS 设的 data-fntv-text 必生效、文字对比度不再随 body 类消失而回退深色兜底 */
  --fntv-info-h4:#6e6e73; --fntv-info-p:#1d1d1f; --fntv-info-a:#0066cc;
  --fntv-cast-h4:#6e6e73; --fntv-cast-p1:#1d1d1f; --fntv-cast-p2:#6e6e73;
  --fntv-text-shadow:none;
}
.fnos-season-aside[data-fntv-text="light"]{
  --fntv-info-h4:#aeaeb2; --fntv-info-p:#f5f5f7; --fntv-info-a:#4da3ff;
  --fntv-cast-h4:#aeaeb2; --fntv-cast-p1:#f5f5f7; --fntv-cast-p2:#9a9aa0;
  --fntv-text-shadow:0 1px 3px rgba(0,0,0,.5);
}
.fnos-immersive-season .fnos-info-card{
  background:var(--semi-color-bg-2,#fff) !important; /* [lc-930] 保留动态渐变, 绝不动 */
  border-radius:14px !important;
  padding:1.2rem !important;
  box-shadow:0 2px 10px rgba(0,0,0,.05) !important;
  margin-bottom:.9rem !important;
  border:1px solid var(--semi-color-border, rgba(0,0,0,.04)) !important;
}
.fnos-season-aside .fnos-info-card h4{ font-size:.82rem !important; font-weight:600 !important; letter-spacing:1px; text-transform:uppercase; margin-bottom:.8rem !important; color:var(--fntv-info-h4,#6e6e73) !important; }
.fnos-season-aside .fnos-info-card p{ font-size:.82rem !important; color:var(--fntv-info-p,#1d1d1f) !important; line-height:1.6 !important; margin-bottom:.25rem !important; text-shadow:var(--fntv-text-shadow,none) !important; }
.fnos-season-aside .fnos-info-card a{ color:var(--fntv-info-a,#0066cc) !important; text-decoration:none !important; }
.fnos-immersive-season .fnos-tag-list{ display:flex !important; flex-wrap:wrap !important; gap:.4rem !important; }
.fnos-immersive-season .fnos-tag{ font-size:.72rem !important; padding:.25rem .7rem; border-radius:20px; background:var(--semi-color-fill-2,#f5f5f7) !important; color:var(--semi-color-text-0,#1d1d1f) !important; }

/* [lc-926] 季页「剧集信息」卡内 TMDB 详情区样式（与 .fnos-info-card 同款材质，深浅模式自适应） */
.fnos-immersive-season .fnos-info-tmdb{ display:block !important; margin-top:.5rem !important; }
.fnos-immersive-season .fnos-tmdb-title{ font-size:1rem !important; font-weight:700 !important; color:var(--semi-color-text-0,#1d1d1f) !important; line-height:1.35 !important; margin-bottom:.3rem !important; word-break:break-word; }
.fnos-immersive-season .fnos-tmdb-orig{ font-size:.8rem !important; font-weight:400 !important; color:var(--semi-color-text-3,#b0b0b5) !important; margin-left:.4rem !important; }
.fnos-immersive-season .fnos-tmdb-tagline{ font-size:.8rem !important; font-style:italic !important; color:var(--semi-color-text-3,#b0b0b5) !important; line-height:1.45 !important; margin-bottom:.5rem !important; }
.fnos-immersive-season .fnos-tmdb-rating{ font-size:.95rem !important; color:var(--semi-color-text-1,#424245) !important; margin-bottom:.5rem !important; }
.fnos-immersive-season .fnos-tmdb-rating b{ color:#E50914 !important; font-size:1.15rem !important; }
.fnos-immersive-season .fnos-tmdb-rating-max{ font-size:.75rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; }
.fnos-immersive-season .fnos-tmdb-votes{ font-size:.72rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; margin-left:.4rem !important; }
.fnos-immersive-season .fnos-tmdb-row{ display:flex !important; gap:.5rem !important; font-size:.8rem !important; line-height:1.5 !important; margin-bottom:.3rem !important; }
.fnos-immersive-season .fnos-tmdb-k{ flex:0 0 3.4rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; }
.fnos-immersive-season .fnos-tmdb-v{ flex:1 1 auto !important; min-width:0 !important; color:var(--semi-color-text-1,#424245) !important; }
.fnos-immersive-season .fnos-tmdb-v .fnos-tag-list{ margin:0 !important; }
.fnos-immersive-season .fnos-tmdb-cast{ display:inline-flex !important; align-items:baseline !important; gap:.3rem !important; }
.fnos-immersive-season .fnos-tmdb-char{ font-size:.66rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; font-weight:400 !important; }
.fnos-immersive-season .fnos-tmdb-overview{ font-size:.78rem !important; color:var(--semi-color-text-2,#86868b) !important; line-height:1.55 !important; margin:.5rem 0 !important; cursor:pointer !important; }
.fnos-immersive-season .fnos-tmdb-clamp{ max-height:4.6em !important; overflow:hidden !important; position:relative !important; }
.fnos-immersive-season .fnos-tmdb-clamp::after{ content:''; position:absolute; right:0; bottom:0; width:45%; height:1.5em; background:linear-gradient(90deg,transparent,var(--semi-color-bg-2,#fff)); }
.fnos-immersive-season .fnos-tmdb-links{ display:flex !important; flex-wrap:wrap !important; gap:.5rem !important; font-size:.78rem !important; margin-top:.4rem !important; }
.fnos-immersive-season .fnos-tmdb-links a{ color:var(--semi-color-primary,#007aff) !important; text-decoration:none !important; }
.fnos-immersive-season .fnos-tmdb-sep{ color:var(--semi-color-border, rgba(0,0,0,.2)) !important; }
.fnos-immersive-season .fnos-tmdb-loading{ font-size:.8rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; padding:.4rem 0 !important; }
.fnos-immersive-season .fnos-tmdb-error{ font-size:.8rem !important; color:#c0392b !important; padding:.4rem 0 !important; }
.fnos-immersive-season .fnos-tmdb-error-inline{ margin-top:.3rem !important; }
.fnos-immersive-season .fnos-tmdb-foot{ display:flex !important; align-items:center !important; justify-content:space-between !important; gap:.5rem !important; margin-top:.6rem !important; padding-top:.5rem !important; border-top:1px solid var(--semi-color-border, rgba(0,0,0,.06)) !important; }
.fnos-immersive-season .fnos-tmdb-src{ font-size:.7rem !important; color:var(--semi-color-text-3,#b0b0b5) !important; }
.fnos-immersive-season .fnos-tmdb-refresh{ font-size:.72rem !important; font-weight:600 !important; padding:.3rem .7rem; border-radius:8px; border:1px solid var(--semi-color-border, rgba(0,0,0,.1)); background:var(--semi-color-fill-2,#f5f5f7); color:var(--semi-color-text-0,#1d1d1f); cursor:pointer !important; transition:background .15s ease, transform .15s ease; }
.fnos-immersive-season .fnos-tmdb-refresh:hover{ background:var(--semi-color-fill-1,#ececef) !important; }
.fnos-immersive-season .fnos-tmdb-refresh:active{ transform:scale(.96) !important; }

/* 演职人员（侧栏内）：隐藏原生标题 & 横向滚动，圆形头像 + 姓名/角色 —— 浅色模式用 fnOS 原生浅色变量；深色模式见末尾 html.dark 覆盖块 */
.fnos-immersive-season .fnos-season-aside p:has(strong){ display:none !important; }
.fnos-immersive-season .fnos-season-aside .ms-container[class*="overflow-x-scroll"]{
  overflow:visible !important; white-space:normal !important; padding-left:0 !important;
}
/* [lc-923] 原生横向滚动条改成「自动换行」的行容器。
   旧实现强制 flex-direction:column → 每个演员独占一整行(竖向排到底), 右栏被拉得极长。
   现改回 row + wrap, 一行放多个, 宽度不够自动换行(具体格宽由下方 .fnos-cast-row/.fnos-cast-cell 接管)。 */
.fnos-immersive-season .fnos-season-aside .ms-container[class*="overflow-x-scroll"] > div.flex.h-full.w-max{
  flex-direction:row !important; flex-wrap:wrap !important; align-items:flex-start !important;
  width:100% !important; max-width:100% !important; height:auto !important;
  column-gap:8px !important; row-gap:10px !important;
}
/* 演职人员整块卡片容器（与「剧集信息」同款卡片） */
/* [lc-901b] cast 容器(fnOS 原生 ms-container)本身必须清零, 否则原生 padding/margin 导致巨大间隔 */
.fnos-immersive-season .fnos-cast-card > *{ padding:0 !important; margin:0 !important; }
.fnos-season-aside .fnos-cast-card h4{ font-size:.82rem !important; font-weight:600 !important; letter-spacing:1px; text-transform:uppercase; margin-bottom:.4rem !important; color:var(--fntv-cast-h4,#6e6e73) !important; }
/* 单个演员：头像(左) + 姓名/角色(右) */
/* [lc-901] 演员列表收紧: 每项上下内边距 8px→4px, 头像-文字间距 12px→10px, 文字左对齐贴齐头像(原 center 显空) */
.fnos-immersive-season .fnos-season-aside .fnos-cast-item{
  display:flex !important; flex-direction:row !important; align-items:center !important;
  gap:10px !important; width:100% !important; padding:4px 0 !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-item > div:first-child{
  width:44px !important; height:44px !important; flex:0 0 44px !important; margin:0 !important; border-radius:50% !important; overflow:hidden !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-item > div:first-child img{ width:100% !important; height:100% !important; object-fit:cover !important; display:block !important; }
.fnos-immersive-season .fnos-season-aside .fnos-cast-info{ display:flex !important; flex-direction:column !important; flex:1 1 auto !important; min-width:auto !important; justify-content:center !important; gap:2px !important; overflow:visible !important; align-items:flex-start !important; }
/* [lc-896→897] 演员姓名/角色单行, 不换行也不截断(完整显示) */
.fnos-season-aside .fnos-cast-info p,
.fnos-season-aside .fnos-cast-info p.truncate{
  width:auto !important; max-width:none !important; min-width:0 !important;
  text-align:left !important; white-space:nowrap !important;
  overflow:visible !important; text-overflow:clip !important;
  line-height:1.35 !important; margin:0 !important; padding:0 !important;
  display:block !important;
}
.fnos-season-aside .fnos-cast-info p:first-child{ font-size:15px !important; font-weight:600 !important; color:var(--fntv-cast-p1,#1d1d1f) !important; text-shadow:var(--fntv-text-shadow,none) !important; }
.fnos-season-aside .fnos-cast-info p:last-child{ font-size:13px !important; color:var(--fntv-cast-p2,#6e6e73) !important; text-shadow:var(--fntv-text-shadow,none) !important; }

/* ===== [lc-923] 演员墙：一行多个 + 自动换行；每格内「头像在上、姓名/角色在下(居中)」 =====
   旧版是「每人独占一整行」的竖向列表(头像左 + 文字右, width:100%), 右栏被 10 来个演员拉得极长。
   现改为定宽格(104px)自动换行: 750px 右栏 ≈ 6 列, 10 个演员只要 2 行。
   行容器/格子由 JS(restyleCastItems → applyCastWallLayout)纯结构打标, 不依赖任何类名猜测。 */
.fnos-immersive-season .fnos-season-aside .fnos-cast-row{
  display:flex !important; flex-direction:row !important; flex-wrap:wrap !important;
  align-items:flex-start !important; justify-content:flex-start !important;
  width:100% !important; max-width:100% !important; height:auto !important; min-height:0 !important;
  column-gap:8px !important; row-gap:10px !important; margin:0 !important; padding:0 !important;
}
/* 行内的非演员子节点(如分区标题/“查看全部”)独占一整行, 不挤占演员格 */
.fnos-immersive-season .fnos-season-aside .fnos-cast-row > .fnos-cast-row-full{
  flex:0 0 100% !important; width:100% !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell{
  flex:0 0 104px !important; width:104px !important; min-width:0 !important; max-width:104px !important;
  display:flex !important; flex-direction:column !important; align-items:center !important;
  margin:0 !important; padding:0 !important; height:auto !important; min-height:0 !important; max-height:none !important;
}
/* 演员项本身就是行容器直接子节点时(无外层包裹), 类同时落在 <a> 上 */
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell.fnos-cast-item{
  display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:flex-start !important;
  gap:6px !important; width:104px !important; max-width:104px !important;
  margin:0 !important; padding:0 !important; text-align:center !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell > .fnos-cast-item{
  display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:flex-start !important;
  gap:6px !important; width:100% !important; max-width:100% !important;
  margin:0 !important; padding:0 !important; text-align:center !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell > .fnos-cast-item > div:first-child,
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell.fnos-cast-item > div:first-child{
  width:64px !important; height:64px !important; flex:0 0 64px !important; margin:0 !important;
  border-radius:50% !important; overflow:hidden !important;
}
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell .fnos-cast-info{
  align-items:center !important; justify-content:flex-start !important; text-align:center !important;
  width:100% !important; min-width:0 !important; gap:1px !important;
}
/* 格内姓名/角色允许换行(不再 nowrap), 居中显示 */
.fnos-season-aside .fnos-cast-cell .fnos-cast-info p,
.fnos-season-aside .fnos-cast-cell .fnos-cast-info p.truncate{
  white-space:normal !important; text-align:center !important; max-width:104px !important;
}
.fnos-season-aside .fnos-cast-cell .fnos-cast-info p:first-child{ font-size:13px !important; font-weight:600 !important; line-height:1.25 !important; color:var(--fntv-cast-p1,#1d1d1f) !important; text-shadow:var(--fntv-text-shadow,none) !important; }
.fnos-season-aside .fnos-cast-cell .fnos-cast-info p:last-child{ font-size:12px !important; line-height:1.25 !important; color:var(--fntv-cast-p2,#6e6e73) !important; text-shadow:var(--fntv-text-shadow,none) !important; }

/* Hero h2 样式已由下方沉浸式头部块统一接管（彩色渐变标题） */

/* ===== 深色模式覆盖：奈飞暗色电影感（仅 html.dark 生效；浅色模式回退上方 fnOS 原生浅色） ===== */
html.dark .fnos-immersive-season [data-id="details"]{
  background:rgba(22,22,26,.72) !important;
  border:1px solid rgba(255,255,255,.07) !important;
  border-radius:12px !important;
  box-shadow:none !important;
  transition:background .25s ease, transform .28s cubic-bezier(.16,1,.3,1), border-color .25s ease !important;
}
html.dark .fnos-immersive-season [data-id="details"]:hover{
  background:rgba(38,38,44,.92) !important;
  border-color:rgba(255,255,255,.16) !important;
  transform:translateX(6px) !important;
}
html.dark .fnos-immersive-season [data-id="details"] > div:first-child{ border-radius:8px !important; background:#000 !important; }
html.dark .fnos-immersive-season [data-id="details"] > div:first-child img{ transition:transform .4s ease !important; }
html.dark .fnos-immersive-season [data-id="details"]:hover > div:first-child img{ transform:scale(1.06) !important; }
/* [lc-952] 选集卡文字：暗色模式下统一用浅字。标题(链接内首子树)纯白加粗，其余描述/链接子节点浅灰，
 *   不再依赖 '> a > *' 这种只命中直接子的结构(fnOS 实际会把标题包在 div/span 里)。 */
html.dark .fnos-immersive-season [data-id="details"] > a,
html.dark .fnos-immersive-season [data-id="details"] > a > *:first-child,
html.dark .fnos-immersive-season [data-id="details"] > a > *:first-child *{ color:#f5f5f7 !important; font-weight:600 !important; font-size:15px !important; }
html.dark .fnos-immersive-season [data-id="details"] > a *:not(:first-child),
html.dark .fnos-immersive-season [data-id="details"] > a > *:not(:first-child) *{ color:#9a9aa0 !important; font-weight:400 !important; font-size:13px !important; }
html.dark .fnos-immersive-season [data-id="details"] .fnos-ep-duration{ color:#9a9aa0 !important; }
html.dark .fnos-immersive-season [data-id="details"] .fnos-ep-badge{
  background:#E50914 !important; color:#fff !important; border-radius:4px !important; font-weight:700 !important; letter-spacing:.5px !important;
}
html.dark .fnos-immersive-season .fnos-season-aside{
  /* [lc-930] 去掉不透明实色底(原 rgba(28,28,30,.94) 会盖掉动态渐变/海报染色), 改为透明, 卡片自身带 --semi-color-bg-2 */
  background:transparent !important;
  border-radius:14px !important;
  padding:14px !important;
}
/* [lc-930] 深色模式信息卡不再写死 #1c1c1e 实色: 改回与浅色同款的 var(--semi-color-bg-2)(深色主题下即深色,
 *   但保留 fnOS 随封面染色的渐变), 文字色由 .fnos-season-aside 的 data-fntv-text 对比度变量统一驱动。 */
html.dark .fnos-immersive-season .fnos-tag{ background:rgba(255,255,255,.08) !important; color:#e5e5e7 !important; border:1px solid rgba(255,255,255,.1) !important; }
/* [lc-930] 深色模式信息卡边框(仅边框, 不动背景, 背景仍走 var(--semi-color-bg-2) 保留渐变) */
html.dark .fnos-immersive-season .fnos-info-card{ border:1px solid rgba(255,255,255,.08) !important; }
/* [lc-952] 暗色模式兜底: 右栏文字变量强制切浅字。html.dark 下 aside 背景透明，坐在深色页面上，
 *   若 applySeasonAsideContrast 采样失败/未跑，默认的深字变量会完全消失 → 信息卡文字全黑。 */
html.dark .fnos-season-aside{ /* [lc-954] 去掉 .fnos-immersive-season 作用域: 暗色主题直接浅字兜底(不依赖 data-fntv-text/body 类), 即便 applySeasonAsideContrast 未跑或 body 类被摘也防黑字消失 */
  --fntv-info-h4:#aeaeb2; --fntv-info-p:#f5f5f7; --fntv-info-a:#4da3ff;
  --fntv-cast-h4:#aeaeb2; --fntv-cast-p1:#f5f5f7; --fntv-cast-p2:#9a9aa0;
  --fntv-text-shadow:0 1px 3px rgba(0,0,0,.5);
}
/* [lc-926] 季页 TMDB 详情区(深色)：与上方 .fnos-info-card 深色块同款奈飞暗色电影感 */
html.dark .fnos-immersive-season .fnos-info-tmdb{ margin-top:.5rem !important; }
html.dark .fnos-immersive-season .fnos-tmdb-title{ color:#f5f5f7 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-orig{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-tagline{ color:#8a8a92 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-rating{ color:#c9c9cf !important; }
html.dark .fnos-immersive-season .fnos-tmdb-rating b{ color:#E50914 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-rating-max, html.dark .fnos-immersive-season .fnos-tmdb-votes{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-k{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-v{ color:#c9c9cf !important; }
html.dark .fnos-immersive-season .fnos-tmdb-char{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-overview{ color:#9a9aa0 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-clamp::after{ background:linear-gradient(90deg,transparent,rgba(22,22,26,.78)) !important; }
html.dark .fnos-immersive-season .fnos-tmdb-links a{ color:#E50914 !important; font-weight:600 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-sep{ color:rgba(255,255,255,.2) !important; }
html.dark .fnos-immersive-season .fnos-tmdb-loading{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-error{ color:#ff6b6b !important; }
html.dark .fnos-immersive-season .fnos-tmdb-src{ color:#7a7a82 !important; }
html.dark .fnos-immersive-season .fnos-tmdb-refresh{ background:rgba(255,255,255,.08) !important; color:#e5e5e7 !important; border:1px solid rgba(255,255,255,.14) !important; }
html.dark .fnos-immersive-season .fnos-tmdb-refresh:hover{ background:rgba(255,255,255,.16) !important; }
html.dark .fnos-immersive-season .fnos-cast-card h4{ font-size:.78rem !important; font-weight:700 !important; letter-spacing:1.5px; text-transform:uppercase; }
html.dark .fnos-immersive-season .fnos-season-aside .fnos-cast-item{ padding:4px 6px !important; border-radius:8px !important; transition:background .2s ease !important; }
html.dark .fnos-immersive-season .fnos-season-aside .fnos-cast-item:hover{ background:rgba(255,255,255,.06) !important; }
html.dark .fnos-immersive-season .fnos-season-aside .fnos-cast-item > div:first-child{ border:1px solid rgba(255,255,255,.12) !important; }
/* [lc-930] 演员文字色改由 .fnos-season-aside 的 data-fntv-text 对比度变量统一驱动(上方 .fnos-cast-info p 已用 var), 此处不再写死 */
/* [lc-923] 演员墙格子的 hover 高亮(浅色模式同款, 走 --semi-color-fill-* 变量) */
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell > .fnos-cast-item{ border-radius:10px !important; padding:4px 0 !important; transition:background .2s ease !important; }
.fnos-immersive-season .fnos-season-aside .fnos-cast-cell > .fnos-cast-item:hover{ background:var(--semi-color-fill-0,rgba(120,120,128,.08)) !important; }
/* [lc-930] 演员文字色改由 .fnos-season-aside 的 data-fntv-text 对比度变量统一驱动(上方 .fnos-cast-info p 已用 var), 此处不再写死 */

/* ===== [lc-894] 季详情头部：保留原始 fnOS 布局（左竖屏海报 + 右信息栏） ===== */
/* 头部容器：保持 fnOS 原始 flex 布局（不再强制全宽底图） */
.fnos-immersive-season .semi-always-dark{
  position:relative !important; /* [lc-897] 去掉 overflow:hidden: 原始布局下裁掉简介 */
  /* 保持 fnOS 原始 justify-content/align-items，不覆盖为 flex-end/flex-start */
  padding:0 48px 36px !important; min-height:340px !important;
}
/* [lc-894] 恢复竖屏海报卡片可见（之前 display:none 把它隐藏了） */
.fnos-immersive-season .semi-always-dark .rounded-xl.overflow-hidden,
.fnos-immersive-season .semi-always-dark .overflow-hidden.rounded-xl{ display:block !important; }
/* 横版底图保持 fnOS 原生模糊，不去除 filter */
.fnos-immersive-season .semi-always-dark img{
  /* 不再强制 filter:none，保留 fnOS 原生 blur-[10px] */
  object-fit:cover !important;
}
.fnos-immersive-season .semi-always-dark .absolute img,
.fnos-immersive-season .semi-always-dark > div > img{
  width:100% !important; height:100% !important;
}
/* 渐变遮罩保留（保证文字在海报上可读） */
/* .fnos-immersive-season .semi-always-dark .gradient-for-full{ display:none !important; } */
/* [lc-894] 海报栏下方的彩色渐变: 显式写死, 不依赖 applySeasonGlassToHeader(该函数从未被调用, 属死代码)
   用 --fnos-detail-season-grad(深浅主题各自定义), 顶部透出原图、底部做彩色过渡, 既是遮罩也是装饰 */
.fnos-immersive-season .semi-always-dark .gradient-for-full{
  display:block !important;
  background:var(--fnos-detail-season-grad) !important;
  pointer-events:none !important;
  /* [lc-897] 确保渐变层在文字下方, 不遮挡简介 */
  position:absolute !important; z-index:0 !important;
}

/* ── 文字内容列：叠在原始布局上微调 ── */
.fnos-immersive-season .semi-always-dark > div:not([class]):not([style]){
  position:relative !important; z-index:2 !important;
  max-width:680px !important; width:auto !important;
  background:transparent !important;
  padding:22px 28px 18px !important; margin:0 !important;
}

/* 标题：彩色渐变（与轮播一致） */
.fnos-immersive-season .semi-always-dark h2{
  font-size:clamp(24px,2.6vw,38px) !important; font-weight:900 !important;
  line-height:1.18 !important; margin:0 0 6px !important;
  letter-spacing:1px !important; word-break:break-word !important;
  background:var(--fnos-hero-title-grad, linear-gradient(120deg,#00d4ff 0%,#4da3ff 22%,#ff5cd0 55%,#ffb347 82%,#ffd166 100%)) !important;
  -webkit-background-clip:text !important; background-clip:text !important;
  color:transparent !important; -webkit-text-fill-color:transparent !important;
  filter:drop-shadow(0 1px 0 rgba(255,255,255,.5)) !important;
  text-shadow:none !important;
}

/* 副标题（季号等）：弱化小字 */
.fnos-immersive-season .semi-always-dark p:first-of-type,
.fnos-immersive-season .semi-always-dark h2 + p,
.fnos-immersive-season .semi-always-dark h2 + *{ color:#c8c8d0 !important; font-size:13px !important; margin:0 0 12px !important; }

/* 按钮组：紧凑横排 + 统一样式 */
.fnos-immersive-season .semi-always-dark button,
.fnos-immersive-season .semi-always-dark [role="button"],
.fnos-immersive-season .semi-always-dark a[class*="button"],
.fnos-immersive-season .semi-always-dark .semi-button{
  display:inline-flex !important; align-items:center !important;
  padding:7px 18px !important; border-radius:999px !important;
  font-size:13px !important; font-weight:600 !important;
  margin:0 8px 0 0 !important; transition:all .2s ease !important;
  border:none !important; cursor:pointer !important;
  text-shadow:none !important;
}
/* 主操作按钮（看N集）：实心 */
.fnos-immersive-season .semi-always-dark button:first-of-type,
.fnos-immersive-season .semi-always-dark [role="button"]:first-of-type{
  background:#E50914 !important; color:#fff !important;
  box-shadow:0 2px 10px rgba(229,9,20,.35) !important;
}
.fnos-immersive-season .semi-always-dark button:first-of-type:hover,
.fnos-immersive-season .semi-always-dark [role="button"]:first-of-type:hover{
  background:#f40616 !important; transform:scale(1.04) !important;
}
/* 次要按钮（MPV播放等）：描边 */
.fnos-immersive-season .semi-always-dark button:nth-of-type(2),
.fnos-immersive-season .semi-always-dark [role="button"]:nth-of-type(2){
  background:rgba(255,255,255,.12) !important; color:#fff !important;
  border:1px solid rgba(255,255,255,.25) !important;
  box-shadow:none !important;
}
.fnos-immersive-season .semi-always-dark button:nth-of-type(2):hover,
.fnos-immersive-season .semi-always-dark [role="button"]:nth-of-type(2):hover{
  background:rgba(255,255,255,.22) !important; border-color:rgba(255,255,255,.4) !important;
}

/* [lc-897] 简介/描述文字：确保可见, 不隐藏 */
.fnos-immersive-season .semi-always-dark p:not(:first-of-type):not(h2 + p){
  display:block !important; visibility:visible !important;
  color:#a0a0ab !important; font-size:13px !important; line-height:1.55 !important;
  margin:10px 0 0 !important; max-width:600px !important;
  -webkit-line-clamp:unset !important;
  text-shadow:none !important;
}
`;
let _immersiveSeasonStyleInjected = false;
let _season2colObserver: MutationObserver | null = null;
let _castRestyleTimer: ReturnType<typeof setInterval> | null = null; // [lc-903] 详情页存续期间周期性重跑 restyle 的兜底定时器
let _obsTimer: ReturnType<typeof setTimeout> | null = null; // [lc-905] observer 防抖定时器
let _obsMaxTimer: ReturnType<typeof setTimeout> | null = null; // [lc-905] observer maxWait 兜底定时器
let _obsWorking = false; // [lc-906] observer 重活执行中: 期间产生的 mutation 全是自身写入, 一律忽略(断自喂)
let _obsFingerprint = ''; // [lc-906] 布局指纹(集数/已处理演员数/两栏状态), 用于稳态退避判定
let _obsStableTicks = 0; // [lc-906] 指纹连续未变化的轮数
let _obsRelayoutTicks = 0; // [lc-906] 两栏被 fnOS 拆散而重建的次数, 频繁则退避
let _infoCard: HTMLElement | null = null;

/** [lc-905] 清理 observer 防抖/maxWait 定时器, 离开季页或已处理完一轮时调用, 防止残留定时器在页面销毁后误重建两栏 */
function clearSeasonObsTimers(): void {
  if (_obsTimer) { clearTimeout(_obsTimer); _obsTimer = null; }
  if (_obsMaxTimer) { clearTimeout(_obsMaxTimer); _obsMaxTimer = null; }
}

/** [lc-906] 重置 observer 稳态退避状态(进入新季页时调用, 避免沿用上一页的"已稳定"判定) */
export function resetSeasonObsState(): void {
  clearSeasonObsTimers();
  _obsWorking = false;
  _obsFingerprint = '';
  _obsStableTicks = 0;
  _obsRelayoutTicks = 0;
  _seasonYearText = ''; // 换页后首播年份需重新解析
  _castParentCache = null; // 换页后演职人员容器需重新定位
  _showColCache = null; // 换页后二级页内容列需重新定位
  resetTmdbShowInfo(); // [lc-926] 换页后剧集元信息/TMDB 数据需重新取（主进程有磁盘缓存，重取不发网络请求）
}

/** 找两栏布局的「主内容」容器（左栏）。
 *  ⚠️ [lc-920] 仅对季页(/v/tv/season/:id)生效; 一级详情页(show 页 /v/tv/<32hex>, 不含 /season/)一律返回 null 保持原生。
 *  ① 季详情页(/v/tv/season/:id): 以「选集」小标题为锚, 取最内层同时含标题与集卡片的祖先 = 选集 section 根;
 *     集卡片尚未渲染时返回 null(交 observer 重试), 绝不用 .card-root LCA 猜。
 *  ② 其余回退(兼容历史): a) 含 [data-id="details"] 的 relative+w-full 祖先;
 *     b) 含 ≥2 个 .card-root 的最近区块级祖先; c) "选集"标题(strong)的下一个兄弟元素容器。
 */

/** [lc-911] 二级 show 页(/v/tv|movie/<32hex>, 不含 /season/)内容列缓存: 内容列在 SPA 换页时被替换,
 *  用 document.body.contains 判断失效即重扫。 */
let _showColCache: HTMLElement | null = null;

/** [lc-911] 二级 show 页内容列定位:
 *  飞牛原生二级详情页的内容列是带水平内边距(px-[44px])的 flex-col 列(div.relative.box-border.flex.w-full.flex-col.px-[44px]),
 *  内含 [data-id="details"] 选集卡片或 .card-root 季卡片。该列在 Fntv-Plus 中因侧边栏被隐藏而接近满宽(≈1922px),
 *  故不能要求"≥2 个 details",也不能用宽度护栏排除——直接返回它作为左栏主内容。
 *  用类名「包含匹配」(而非 CSS 选择器)规避 Tailwind 任意值类 px-[44px] 的选择器转义问题;
 *  querySelectorAll 按文档顺序返回, 含卡片的最外层该列最先命中, 正是我们要包裹的左栏。 */
function findShowContentColumn(): HTMLElement | null {
  if (_showColCache && document.body.contains(_showColCache)) return _showColCache;
  const all = Array.from(document.querySelectorAll('div')) as HTMLElement[];
  for (const el of all) {
    const cls = el.className.toString();
    if (cls.includes('px-[44px]') && cls.includes('flex-col') && cls.includes('w-full')) {
      if (el.querySelector('[data-id="details"]') || el.querySelector('.card-root')) {
        // [lc-919] 二级页(px-[44px] 内容列)包含 Hero(海报+标题+播放按钮)作为第一个子节点,
        //   若把整列塞进左栏 → Hero 被切割侵入。故向下找「含 .card-root 的最内层子容器」,
        //   仅包裹选集/季卡片区域, 让 Hero 保持原样不受两栏影响。
        const narrow = findNarrowCardContainer(el);
        if (narrow && narrow !== el) {
          dlog('findShowContentColumn: 精细化锚点(跳过Hero) cls=' + (narrow.className||'').toString().substring(0,60));
          _showColCache = narrow;
          return narrow;
        }
        _showColCache = el;
        return el;
      }
    }
  }
  _showColCache = null;
  return null;
}

/** [lc-919] 在容器内向下找「含卡片(.card-root/[data-id=details])的最内层子容器」,
 *  用于二级页跳过 Hero 区域, 仅对选集/季卡片区域建两栏。 */
function findNarrowCardContainer(root: HTMLElement): HTMLElement | null {
  // BFS 向下找: 取直接子节点中含卡片的那个, 递归直到无法更窄
  let best: HTMLElement | null = root;
  let depth = 0;
  const MAX_DEPTH = 6; // 防止无限递归
  while (best && depth < MAX_DEPTH) {
    let foundChild: HTMLElement | null = null;
    for (let i = 0; i < best.children.length; i++) {
      const c = best.children[i] as HTMLElement;
      if (c.querySelector('.card-root') || c.querySelector('[data-id="details"]')) {
        foundChild = c;
        break; // 取第一个含卡片的子节点
      }
    }
    if (!foundChild || foundChild === best) break;
    // 若找到的子节点就是 root 本身或无进展, 停止
    best = foundChild;
    depth++;
  }
  return best !== root ? best : null;
}

/** [lc-912] 找「选集 / 剧集 / 分集 / Episodes」小标题节点(叶子节点, 短文本)。
 *  返回该标题节点 + 它所在 section 里实际使用的集卡片选择器, 供调用方按标题锚定 section 根。
 *  ⚠️ 只接受「祖先链 8 层内能找到集卡片」的标题, 排除推荐位等同名短文本。 */
function findEpisodeSectionHeading(): { head: HTMLElement; sel: string } | null {
  const _dbgAllTexts: string[] = [];
  // [lc-917] 收集全部候选(可能同时存在于可见 --exclude 与隐藏 --cache 两套路由副本),
  //  末尾优先返回「可见」section 对应的标题, 避免把两栏建进隐藏缓存副本(display:none → 整块不可见)。
  const candidates: { head: HTMLElement; sel: string; section: HTMLElement }[] = [];
  for (const sel of ['[data-id="details"]', '.card-root']) {
    const cands = Array.from(document.querySelectorAll('strong,h2,h3,h4,span,p,div')) as HTMLElement[];
    for (const el of cands) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!/^(选集|剧集|分集|episodes?)$/i.test(t)) { if (/选|剧|分|ep/i.test(t)) _dbgAllTexts.push(t); continue; }
      let p: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 8 && p && p !== document.body; i++) {
        if (p.querySelector(sel)) {
          candidates.push({ head: el, sel, section: p });
          break;
        }
        p = p.parentElement;
      }
    }
  }
  if (candidates.length === 0) {
    dlog('findEpisodeSectionHeading: 未命中。候选文本(含选/剧/分/ep): ' + (_dbgAllTexts.length ? _dbgAllTexts.join(',') : '(无)'));
    return null;
  }
  const visible = candidates.find((c) => !isHiddenByAncestor(c.section));
  if (visible) {
    dlog('findEpisodeSectionHeading: 命中可见标题="' + (visible.head.textContent || '').trim() + '" sel=' + visible.sel
      + ' 标签=' + visible.head.tagName + ' 父cls=' + ((visible.head.parentElement?.className || '').toString().substring(0, 60)));
    return visible;
  }
  dlog('findEpisodeSectionHeading: 仅命中隐藏(缓存)section, 返回 null 等可见副本渲染。候选数=' + candidates.length);
  return null;
}

/** [lc-917] 判断元素是否处于「不可见」子树: 任一祖先 display:none, 或带 Tailwind hidden / fnOS 路由缓存 --cache 类。
 *  根因: fnOS 路由缓存会把旧页塞进 trim-ui__cache-outlet--cache ... hidden(display:none) 副本,
 *  两栏若建在那里会整块不可见(computed style 仍报 grid, 但 getBoundingClientRect 全 0, 表现为"选集占满整宽")。
 *  [lc-922] 修复: 原 /\bhidden\b/ 正则会误匹配 overflow-hidden / overflow-y-hidden / overflow-x-hidden
 *   等 Tailwind 工具类(它们的 className 里包含 'hidden' 子串, 但不是 display:none), 导致详情页几乎所有
 *   容器都被误判为「隐藏」→ findSeasonEpParent 走标题路径时永远命中"隐藏副本"返回 null, 两栏永不建立。
 *   改为按空白拆分类名后精确匹配独立的 'hidden' 类名(仅 Tailwind 的 .hidden { display:none } 才算)。 */
function isHiddenByAncestor(el: HTMLElement | null): boolean {
  if (!el) return true;
  let p: HTMLElement | null = el;
  while (p && p !== document.body) {
    const cs = getComputedStyle(p);
    if (cs.display === 'none') return true;
    const cls = (p.className || '').toString();
    const classes = cls.split(/\s+/);
    // [lc-922] 精确匹配独立的 'hidden' Tailwind 类(display:none), 排除 overflow-hidden 等误匹配
    if (classes.indexOf('hidden') >= 0) return true;
    // fnOS 路由缓存的隐藏 outlet: trim-ui__cache-outlet--cache (含 --cache 类, 排除 --exclude)
    for (let i = 0; i < classes.length; i++) {
      if (classes[i].indexOf('--cache') >= 0 && classes[i].indexOf('--exclude') < 0) return true;
    }
    p = p.parentElement;
  }
  return false;
}

function findSeasonEpParent(): HTMLElement | null {
  const _dbgCardRoot = document.querySelectorAll('.card-root').length;
  const _dbgDetails = document.querySelectorAll('[data-id="details"]').length;
  const _dbgHas2col = !!document.querySelector('.fnos-season-2col');
  // [lc-914] 入口日志同样节流: 两栏已建立时静默, 避免 observer 稳态巡检(1.2s/次)持续刷屏
  if (!_dbgHas2col) {
    dlog('findSeasonEpParent: === 入口 === pathname=' + location.pathname
      + ' card-root=' + _dbgCardRoot + ' details=' + _dbgDetails
      + ' body.cls=' + (document.body.className||'').toString().substring(0,80));
  }
  // [lc-920] 一级详情页(show 页 /v/tv/<32hex>, 不含 /season/)不建两栏: 保持 fnOS 原生外观,
  //   与用户标准一致(一级不动 / 二级分栏)。两栏仅对季页(/v/tv/season/<guid>)生效,
  //   由 layoutSeasonTwoPane 顶部的路由护栏统一拦截(非 /season/ 直接 return 并清理残留僵尸两栏)。
  if (!/\/season\//.test(location.pathname)) {
    dlog('findSeasonEpParent: [一级详情页] 非季页, 不建两栏, 返回 null');
    return null;
  }
  // [lc-912] 季页(/v/tv/season/<guid>)专属策略:
  //   旧实现先逐层向上找 .relative.w-full(会越过 section 边界命中更高层容器), 找不到再用 .card-root 的
  //   最近公共祖先"猜"。后者在【集卡片尚未渲染】时必然命中整页内容列(div.flex.w-full.flex-col) →
  //   两栏被建在错误的锚点上: 左栏塞进整页内容, 而真正的「选集」section 反而被留在两栏之外,
  //   表现为"布局错乱 / 看着不像左6集数据右4信息"。
  //   现改为: 以「选集」小标题为锚, 取【最内层同时含标题与集卡片】的祖先 = 选集 section 根;
  //   集卡片还没渲染出来时返回 null(交给重试/observer), 绝不用 .card-root LCA 猜。
  if (/\/season\//.test(location.pathname)) {
    const h = findEpisodeSectionHeading();
    if (h) {
      let el: HTMLElement | null = h.head.parentElement;
      let _step = 0;
      while (el && el !== document.body) {
        _step++;
        const hasSel = el.querySelector(h.sel) ? 'Y' : 'N';
        // [lc-914] 逐步细节仅在「两栏尚未建立」时输出, 避免 observer 稳态巡检(1.2s/次)持续刷屏
        if (!_dbgHas2col) {
          dlog('findSeasonEpParent: [季页] 向上第' + _step + '步 cls='
            + (el.className||'').toString().substring(0,70) + ' 含' + h.sel + '=' + hasSel
            + ' kids=' + el.childElementCount);
        }
        if (hasSel === 'Y') {
          const r = el.getBoundingClientRect();
          dlog('findSeasonEpParent: [季页] ✅ 命中选集 section sel=' + h.sel
            + ' step=' + _step + ' cls=' + (el.className||'').toString().substring(0,70)
            + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
            + ' tag=' + el.tagName);
          // [lc-917] 命中但处于隐藏(缓存)副本 → 不建两栏, 返回 null 等可见副本渲染
          if (isHiddenByAncestor(el)) {
            dlog('findSeasonEpParent: [季页] ⚠️ 选集 section 在隐藏(缓存)副本, 返回 null 等可见副本');
            return null;
          }
          return el;
        }
        el = el.parentElement;
      }
      dlog('findSeasonEpParent: [季页] ⚠️ 标题找到但向上遍历到 body 仍未命中 sel=' + h.sel);
    } else {
      dlog('findSeasonEpParent: [季页] findEpisodeSectionHeading 返回 null(无选集标题)');
    }
    if (_dbgDetails === 0 && _dbgCardRoot === 0) {
      dlog('findSeasonEpParent: [季页] 集卡片尚未渲染(details=0 cardRoot=0), 返回 null 等重试');
      return null;
    }
    // 有集卡片但页面没有「选集」标题 → 退化为旧路径 a(向上找 relative.w-full)
    dlog('findSeasonEpParent: [季页] 无选集标题, 退化旧路径a');
  }
  // 路径 a: 季页选集卡片 —— [lc-917] 遍历全部 details, 优先返回「可见」副本的 relative.w-full 祖先
  //   (原 document.querySelector 取首个匹配, 可能命中 fnOS 路由缓存的隐藏 --cache 副本 → 两栏建进去不可见)
  const allDetails = Array.from(document.querySelectorAll('[data-id="details"]')) as HTMLElement[];
  for (const d of allDetails) {
    let n: HTMLElement | null = d;
    while (n && n !== document.body) {
      if (n.classList && n.classList.contains('relative') && n.classList.contains('w-full')) {
        if (!isHiddenByAncestor(n)) return n; // 可见 → 用这个
        break; // 隐藏副本 → 停止本支, 试下一个 details
      }
      n = n.parentElement;
    }
  }
  // 路径 b: 二级页季/集卡片(.card-root) —— 取共同祖先(含最多卡片的那个)
  const cards = document.querySelectorAll('.card-root');
  if (cards.length >= 2) {
    // 用所有 card-root 的最近公共祖先(LCA)近似: 从第一个卡片向上, 找第一个包含全部/大部分卡片的区块容器
    let best: HTMLElement | null = null;
    let bestCount = 0;
    for (const card of Array.from(cards)) {
      let el: HTMLElement | null = card.parentElement as HTMLElement | null;
      while (el && el !== document.body) {
        const count = el.querySelectorAll('.card-root').length;
        if (count > bestCount && count >= cards.length * 0.5) {
          // 确保是块级容器(有宽度)
          const r = el.getBoundingClientRect();
          if (r.width > 200) { bestCount = count; best = el; }
        }
        el = el.parentElement;
      }
    }
    if (best) {
      if (isHiddenByAncestor(best)) {
        dlog('findSeasonEpParent: 路径b命中但在隐藏副本, 跳过');
      } else {
        dlog('findSeasonEpParent: 路径b命中, cards=', cards.length); return best;
      }
    }
  }
  // 路径 c: "选集"标题的下一个兄弟容器 —— [lc-917] 仅当容器可见时才命中(排除隐藏缓存副本)
  const headings = Array.from(document.querySelectorAll('strong,h2,h3,h4,.semi-typography-heading'));
  for (const h of headings) {
    const t = (h.textContent || '').trim();
    if (!/^选集$|^剧集$|^分集$|^Episodes$/i.test(t)) continue;
    let sibling = h.nextElementSibling as HTMLElement | null;
    // 跳过纯文本/空白节点, 找到第一个元素容器
    while (sibling && sibling.nodeType === Node.TEXT_NODE) sibling = sibling.nextElementSibling as HTMLElement | null;
    if (sibling && sibling.getBoundingClientRect().width > 200 && !isHiddenByAncestor(sibling)) {
      dlog('findSeasonEpParent: 路径c命中 选集标题兄弟(可见)');
      return sibling;
    }
    // 如果没有 nextSibling 或太小, 就用父容器
    const parent = h.parentElement;
    if (parent && parent.getBoundingClientRect().width > 300 && !isHiddenByAncestor(parent)) {
      dlog('findSeasonEpParent: 路径c命中 选集标题父容器(可见)');
      return parent;
    }
  }
  // 最终回退: 直接用第一个 .card-root 的父容器
  if (cards.length > 0) {
    const p = cards[0].parentElement as HTMLElement | null;
    if (p) { dlog('findSeasonEpParent: 最终回退 card-root parent'); return p; }
  }
  dlog('findSeasonEpParent: ⚠️ 所有路径均未找到主内容容器');
  return null;
}

/** [lc-906] 演职人员容器缓存: 原实现每次调用都全文档 querySelectorAll('strong') 再逐个读 textContent,
 *  而它被 600ms 巡检定时器与 observer 高频调用 → 累积成显著开销。找到后缓存, 仅当节点脱离 DOM 或
 *  内部已无演员链接时才重新定位(换页由 resetSeasonObsState 清空)。 */
let _castParentCache: HTMLElement | null = null;
/** [lc-921] findSeasonCastParent 上次命中的路线(仅用于诊断, 确认是"精准结构抓取"而非标题文字匹配) */
let _castLastRoute = '';
/** 找「演职人员」容器。
 *  [lc-920] 重写: 旧实现仅匹配 a[href^="/v/person/"], 而 fnOS SPA 用 hash 路由(#/v/person/xxx)导致
 *   整批漏掉 → personLinkCount 恒为 0、右栏演员整块消失。现改 includes('/v/person/') 兼容两种路由;
 *  [lc-921] 进一步去除「标题文字匹配」(原路径1/路径4 用 /演职|演员|配音|声优|cast|staff|…/ 扫描分区标题),
 *   改为完全由「真实数据」定位: 演员数据是「人物页链接(/v/person/)」或「头像人物卡(含 <img> + 短名字)」,
 *   直接以这些数据本体反推其所在容器, 不再读任何分区标题文本 → 精准、无歧义、不会误命中其它区块。 */
function findSeasonCastParent(): HTMLElement | null {
  const PERSON_SEL = 'a[href*="/v/person/"]';
  // 缓存命中: 容器仍在 DOM 且仍含演员链接(路线A 数据仍在)
  if (_castParentCache && document.body.contains(_castParentCache)
      && _castParentCache.querySelectorAll(PERSON_SEL).length >= 1) {
    return _castParentCache;
  }
  // [lc-921] 精准结构抓取(彻底去除标题文字匹配):
  //   演员数据是「人物页链接 /v/person/ 」或「头像人物卡(含 img + 短名字)」, 直接以数据本体定位容器,
  //   不再扫描"演职/演员/配音/声优…"等分区标题(那类做法是模糊文本匹配, 易误命中/漏抓)。
  //
  // 路线A(主, 数据驱动): fnOS 渲染了人物页链接 → 取「包含全部 person 链接的最小共同祖先」即演职人员整块容器。
  const persons = Array.from(document.querySelectorAll(PERSON_SEL)) as HTMLElement[];
  if (persons.length >= 3) {
    let best: HTMLElement | null = null;
    let el: HTMLElement | null = persons[0];
    while (el && el !== document.body) {
      if (el.querySelectorAll(PERSON_SEL).length >= persons.length) { best = el; break; }
      el = el.parentElement;
    }
    if (!best) { // 退化: 含 ≥3 个 person 链接的最小祖先(容忍个别链接不在同一子树)
      el = persons[0].parentElement;
      while (el && el !== document.body) {
        if (el.querySelectorAll(PERSON_SEL).length >= 3) { best = el; break; }
        el = el.parentElement;
      }
    }
    if (best) {
      _castLastRoute = 'A-personLinks';
      dlog('findSeasonCastParent: ✅ 路线A(person链接共同祖先)命中 cls=' + (best.className || '').toString().substring(0, 60) + ' persons=' + persons.length);
      _castParentCache = best; return best;
    }
  }
  // 路线B(兜底·纯结构): fnOS 未渲染 /v/person/ 链接(仅头像人物卡)时,
  //   找「含 ≥3 个头像人物卡」的最内层容器。人物卡 = 含 <img> + 短文字名, 且排除选集卡(data-id)/推荐卡(.card-root), 不读任何标题文本。
  const personCards = Array.from(document.querySelectorAll('a,div')).filter((c: Element) => {
    if (c.hasAttribute('data-id')) return false;                       // 排除选集卡片
    if ((c as HTMLElement).classList && (c as HTMLElement).classList.contains('card-root')) return false; // 排除推荐卡
    if (!c.querySelector('img')) return false;                         // 必须有头像
    const t = (c.textContent || '').trim();
    return t.length > 0 && t.length < 20;                             // 头像 + 短名字(人物名)
  }) as HTMLElement[];
  if (personCards.length >= 3) {
    let best: HTMLElement | null = null;
    let el: HTMLElement | null = personCards[0].parentElement;
    while (el && el !== document.body) {
      const cnt = personCards.filter((c) => el!.contains(c) && el !== c).length;
      if (cnt >= 3) best = el;   // 自底向上, 末次命中即最内层满足的祖先
      el = el.parentElement;
    }
    if (best) {
      _castLastRoute = 'B-avatarCards';
      dlog('findSeasonCastParent: ✅ 路线B(≥3头像人物卡)命中 cls=' + (best.className || '').toString().substring(0, 60) + ' imgCards=' + personCards.length);
      _castParentCache = best; return best;
    }
  }
  _castLastRoute = 'none';
  _castParentCache = null;
  return null;
}

/** 从单集卡片里提取「分秒」时长（fnOS 把时长放在标题链接内的段落里；注意卡片内第一个 a 是播放遮罩，需挑带 <p> 的标题链接） */
function findCardTitleLink(card: Element | null): HTMLElement | null {
  if (!card) return null;
  const a = Array.from(card.querySelectorAll('a')).find((el) => el.querySelector('p')) as HTMLElement | undefined;
  return a || null;
}

/** 从单集卡片里提取「分秒」时长（fnOS 把时长放在卡片内的 .semi-typography-small 段落） */
function extractDuration(card: Element | null): string {
  const a = findCardTitleLink(card);
  if (!a) return '';
  const durP = Array.from(a.querySelectorAll('p')).find((p) =>
    /(\d+)\s*分钟\s*(\d+)\s*秒/.test(p.textContent || '')
  );
  return durP ? (durP.textContent || '').trim() : '';
}

/** 只筛选「真正的选集卡片」（含"第X集"标题或时长文本），排除推荐/精选等杂卡 */
function getRealEpisodeCards(): Element[] {
  return Array.from(document.querySelectorAll('[data-id="details"]')).filter((card) => {
    const a = findCardTitleLink(card);
    if (!a) return false;
    const text = a.textContent || '';
    // 匹配 "第 1 集"、"第2集" 等中文集数格式，或有分秒时长
    return /第\s*\d+\s*集/.test(text) || /(\d+)\s*分钟\s*(\d+)\s*秒/.test(text);
  });
}

/** 统计所有真正分集的「分秒」时长，返回总秒数（复用已取到的卡片数组，避免重复全文档查询） */
function sumEpisodeSeconds(cards?: Element[]): number {
  let total = 0;
  (cards || getRealEpisodeCards()).forEach((card) => {
    const a = findCardTitleLink(card);
    if (!a) return;
    const p = Array.from(a.querySelectorAll('p')).find((el) =>
      /(\d+)\s*分钟\s*(\d+)\s*秒/.test(el.textContent || '')
    );
    if (!p) return;
    const m = (p.textContent || '').match(/(\d+)\s*分钟\s*(\d+)\s*秒/);
    if (m) total += parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  });
  return total;
}

/** 把总秒数格式化为「X 小时 Y 分钟」 */
function formatSeconds(total: number): string {
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let str = '';
  if (h > 0) str += `${h} 小时 `;
  str += `${m} 分钟`;
  if (s > 0 && h === 0) str += ` ${s} 秒`;
  return str.trim();
}

/** [lc-906] 首播年份缓存: 年份不会随懒加载变化, 找到一次即可永久复用(每页只算一次) */
let _seasonYearText = '';
let _seasonDiagCount = 0; // [lc-909] 详情页布局诊断日志计数(最多打 3 次)
/** [lc-906] 找首播年份文本。
 *  ⚠️ 原实现用 document.querySelectorAll('*') 全文档扫描(详情页常上万节点)逐个读 textContent+正则,
 *  而它被 observer 高频调用 → 单次就足以拖垮主线程。
 *  现改为: 先查缓存; 未命中则只在详情页头部区块(.semi-always-dark / 详情头部容器)内搜索,
 *  且叶子节点扫描设 2000 个上限; 仍找不到就返回空(宁缺毋滥, 绝不做无上限全文档扫描)。 */
function findSeasonYearText(): string {
  if (_seasonYearText) return _seasonYearText;
  const scope = (document.querySelector('.semi-always-dark')
    || document.querySelector('.trim-mc__details--key-version')
    || document.querySelector('header')) as HTMLElement | null;
  if (!scope) return '';
  const leaves = scope.querySelectorAll('*');
  const limit = Math.min(leaves.length, 2000);
  for (let i = 0; i < limit; i++) {
    const e = leaves[i];
    if (e.children.length !== 0) continue;
    const t = (e.textContent || '').trim();
    if (/^((19|20)\d{2})\s*年?$/.test(t)) { _seasonYearText = t; return t; }
  }
  return '';
}

/* ═══════════════════════════════════════════════════════════════════════════
   [lc-926] 季页「剧集信息」接入 TMDB
   ───────────────────────────────────────────────────────────────────────────
   需求：尽可能多地从 TMDB 取剧集信息；本地持久化；同一部剧只在第一次打开时拉一次；
        提供手动刷新按钮；显示「更新于 …」。
   数据流：
     ① fnOS getEditDetail(guid) → title / year / tmdbId（最准；拿不到则退回页面 DOM 解析）
     ② 主进程 tmdb:show（详情 + append_to_response 一次取回演职员/外链/关键词/分级/别名/
        图/预告/播放平台，再补 /tv/{id}/season/{n} 本季信息；磁盘缓存 10 年，force 才重拉）
     ③ renderTmdbShowInfo() 写进右栏「剧集信息」卡的 .fnos-info-tmdb 子容器
   ⚠️ 自喂防护：本地统计(.fnos-info-local) 与 TMDB 数据(.fnos-info-tmdb) 分两个子容器，
      各自做 innerHTML 内容 diff，绝不整卡覆盖（observer 观察范围包含信息卡）。
   ═══════════════════════════════════════════════════════════════════════════ */
let _infoLocalEl: HTMLElement | null = null;  // 本地统计容器（集数/总时长/首播）
let _infoTmdbEl: HTMLElement | null = null;   // TMDB 数据容器
let _tmdbInfoGuid = '';                       // 当前已加载的季 guid（同页不重复请求）
let _tmdbInfoData: any = null;                // 已获取的 TMDB 数据（fnOS 重建 aside 时直接复用渲染）
let _tmdbInfoFetchedAt = 0;                   // 数据抓取时间戳（显示「更新于」）
let _tmdbInfoLoading = false;                 // 请求进行中（防并发重复拉）
let _tmdbInfoError = '';                      // 最近一次失败原因
let _tmdbMetaCache: { guid: string; title: string; year: string; tmdbId: string; mediaType: 'tv' | 'movie'; seasonNumber: number | null } | null = null;
let _seasonShowTitle = '';                    // 页面解析出的剧名（换页重置）
let _seasonNumberCache: number | null = null; // 页面解析出的季号（换页重置）
/** [lc-927] fnOS 原生详情页暴露的 IMDb 链接（页面上指向 imdb.com/title/ 的 <a>）。
 *  并入「剧集信息」卡显示：TMDB 返回了 externalIds.imdb 时以 TMDB 为准，否则用它兜底，避免同一页出现两个 IMDb。 */
let _nativeImdb: { href: string; text: string } | null = null;
let _nativeCastHidden = 0;                    // [lc-927] 已隐藏的原生演职人员残留区块数（诊断用）

/** 换页/离开季页时清空 TMDB 状态。磁盘缓存仍在主进程，重新打开同一季仍是「零 TMDB 请求」。 */
function resetTmdbShowInfo(): void {
  _tmdbInfoGuid = '';
  _tmdbInfoData = null;
  _tmdbInfoFetchedAt = 0;
  _tmdbInfoLoading = false;
  _tmdbInfoError = '';
  _tmdbMetaCache = null;
  _seasonShowTitle = '';
  _seasonNumberCache = null;
  _nativeImdb = null;      // [lc-927] 原生 IMDb 随换页重置，避免沿用上一页的链接
  _nativeCastHidden = 0;
}

/** 从 URL 取当前季/影视 guid 与媒体类型（/v/tv/season/<guid> → tv） */
function getSeasonPageGuid(): { guid: string; mediaType: 'tv' | 'movie' } | null {
  const m = location.pathname.match(/\/v\/(tv|movie)\/(?:season\/)?([a-f0-9]{32})/);
  if (!m) return null;
  return { guid: m[2], mediaType: m[1] === 'movie' ? 'movie' : 'tv' };
}

/** 详情页头部作用域（与 findSeasonYearText 同款，避免全文档扫描） */
function detailHeaderScope(): HTMLElement | null {
  return (document.querySelector('.semi-always-dark')
    || document.querySelector('.trim-mc__details--key-version')
    || document.querySelector('header')) as HTMLElement | null;
}

/** [lc-945] 系统/品牌名黑名单：详情页头部或顶栏可能含「飞牛影视」等站点名(APP_NAME)，
 *  绝不能当作剧名提取——否则 TMDB 搜「飞牛影视」必然零结果(报"未找到匹配条目")。 */
const _SYS_TITLE_DENY = ['飞牛影视', 'fnos'];
function _isSysTitle(t: string): boolean {
  const s = (t || '').trim().toLowerCase();
  if (!s) return true;
  for (const d of _SYS_TITLE_DENY) {
    if (s === d.toLowerCase() || s.includes(d.toLowerCase())) return true;
  }
  return false;
}

/** 季页剧名：取头部作用域内「字号最大」的非品牌可见文本节点；再退到 document.title(兼容两种顺序)。 */
function findSeasonShowTitle(): string {
  if (_seasonShowTitle) return _seasonShowTitle;
  const scope = detailHeaderScope();
  let best = '';
  let bestSize = 0;
  if (scope) {
    const leaves = scope.querySelectorAll('*');
    const limit = Math.min(leaves.length, 1500);
    for (let i = 0; i < limit; i++) {
      const e = leaves[i] as HTMLElement;
      if (e.children.length !== 0) continue;
      const t = (e.textContent || '').trim();
      if (!t || t.length > 60) continue;
      if (_isSysTitle(t)) continue;              // [lc-945] 跳过品牌/系统名(如「飞牛影视」)
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue; // 隐藏(路由缓存副本)元素跳过
      const size = parseFloat(getComputedStyle(e).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = t; }
    }
  }
  if (!best && document.title) {
    // [lc-945] fnOS 标题可能是「剧名 - 飞牛影视」也可能是「飞牛影视 - 剧名」(站点名在前更常见)，
    //   需剔除品牌段、取剩余最长段作剧名，再剥掉尾部「第N季」。
    const parts = document.title.split(/\s*[-–—|]\s*/).map((p) => p.trim()).filter((p) => p && !_isSysTitle(p));
    if (parts.length) {
      best = parts.sort((a, b) => b.length - a.length)[0];
    } else {
      // 整段都是品牌(极端情况)：退一步去掉品牌词后取剩余
      best = document.title.replace(/飞牛影视/g, '').replace(/\s*[-–—|]\s*/g, ' ').trim();
    }
    best = best.replace(/第\s*[0-9一二三四五六七八九十百]+\s*季\s*$/, '').trim();
  }
  if (best) _seasonShowTitle = best;
  return best;
}

/** 中文数字（一~九十九）转 int，用于「第 三 季」这类写法 */
function cnNumToInt(s: string): number {
  const map: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  const m1 = s.match(/^十([一二三四五六七八九])$/);
  if (m1) return 10 + map[m1[1]];
  const m2 = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/);
  if (m2) return map[m2[1]] * 10 + (m2[2] ? map[m2[2]] : 0);
  return NaN;
}

/** 季号：头部作用域内匹配「第 N 季 / Season N / S01」；取不到返回 null（则只拉 TV 级信息，不查本季） */
function findSeasonNumber(): number | null {
  if (_seasonNumberCache !== null) return _seasonNumberCache;
  const scope = detailHeaderScope();
  if (scope) {
    const leaves = scope.querySelectorAll('*');
    const limit = Math.min(leaves.length, 1500);
    for (let i = 0; i < limit; i++) {
      const e = leaves[i];
      if (e.children.length !== 0) continue;
      const t = (e.textContent || '').trim();
      const m = t.match(/^第\s*([0-9一二三四五六七八九十]+)\s*季$/) || t.match(/^Season\s*(\d{1,3})$/i) || t.match(/^S(\d{1,3})$/);
      if (m) {
        const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : cnNumToInt(m[1]);
        if (!isNaN(n)) { _seasonNumberCache = n; return n; }
      }
    }
  }
  return null;
}

/** [lc-926] 取当前页剧集的 TMDB 查询入参：优先 fnOS 元数据（title/year/tmdbId 最准），
 *  拿不到再退到页面 DOM 解析（标题字号最大值 + 首播年 + 「第 N 季」）。同一 guid 结果缓存。 */
async function loadShowMeta(): Promise<{
  guid: string; title: string; year: string; tmdbId: string; mediaType: 'tv' | 'movie'; seasonNumber: number | null;
} | null> {
  const page = getSeasonPageGuid();
  if (!page) return null;
  if (_tmdbMetaCache && _tmdbMetaCache.guid === page.guid) return _tmdbMetaCache;
  let title = '';
  let year = '';
  let tmdbId = '';
  try {
    const data = await fnosGetEditDetail(location.origin, page.guid);
    if (data) {
      title = String(data.title || data.name || '').trim();
      // [lc-945] getEditDetail 偶尔返回站点/品牌名(如「飞牛影视」)而非真实剧名 → 丢弃改由页面解析
      if (_isSysTitle(title)) {
        dlog('[lc-926] getEditDetail 返回疑似品牌名 title=' + JSON.stringify(title) + ', 丢弃改由页面解析');
        title = '';
      }
      const yRaw = data.year || data.production_year || data.first_aired || data.premiere_date || data.date_created || '';
      const ym = String(yRaw).match(/(\d{4})/);
      if (ym) year = ym[1];
      tmdbId = extractTmdbId(data) || '';
      // 季号优先取 fnOS 元数据（二级季页的 item 通常带 index/index_number）
      if (_seasonNumberCache === null) {
        const sn = data.index_number ?? data.IndexNumber ?? data.index ?? data.season_number;
        if (typeof sn === 'number' && !isNaN(sn)) _seasonNumberCache = sn;
      }
    }
  } catch (e) {
    dlog('[lc-926] getEditDetail 失败, 退回页面解析: ' + String(e).substring(0, 60));
  }
  if (!title) title = findSeasonShowTitle();
  if (!year) year = findSeasonYearText().replace(/\D/g, '').slice(0, 4);
  const meta = {
    guid: page.guid,
    title,
    year,
    tmdbId,
    mediaType: page.mediaType,
    seasonNumber: findSeasonNumber(),
  };
  _tmdbMetaCache = meta;
  dlog('[lc-926] loadShowMeta: ' + JSON.stringify(meta));
  return meta;
}

/** [lc-926] 确保「剧集信息」卡里的 TMDB 数据已加载。
 *  同一 guid 只真正请求一次（后续 fnOS 重建 aside 时直接复用 _tmdbInfoData 重渲染，零请求）；
 *  点「刷新」按钮 → force=true 强制重拉。 */
function ensureTmdbShowInfo(force = false): void {
  if (!_infoTmdbEl) return;
  const page = getSeasonPageGuid();
  if (!page) return;
  if (!force && _tmdbInfoGuid === page.guid && _tmdbInfoData) { renderTmdbShowInfo(); return; }
  if (_tmdbInfoLoading) return;
  _tmdbInfoLoading = true;
  _tmdbInfoGuid = page.guid;
  if (force) _tmdbInfoError = '';
  renderTmdbShowInfo(); // 先渲染「正在获取…」
  void (async () => {
    try {
      const meta = await loadShowMeta();
      if (!meta) {
        _tmdbInfoLoading = false;
        _tmdbInfoError = '当前页面不是季/详情路由';
        renderTmdbShowInfo();
        return;
      }
      const r = await ipcRenderer.invoke('tmdb:show', {
        tmdbId: meta.tmdbId || undefined,
        title: meta.title || undefined,
        year: meta.year || undefined,
        mediaType: meta.mediaType,
        seasonNumber: meta.seasonNumber === null ? undefined : meta.seasonNumber,
        force: !!force,
      });
      if (r && r.ok && r.data) {
        _tmdbInfoData = r.data;
        _tmdbInfoFetchedAt = r.fetchedAt || Date.now();
        _tmdbInfoError = '';
        log('[lc-926] TMDB 剧集信息就绪: ' + (r.data.title || '') + ' 更新于 ' + new Date(_tmdbInfoFetchedAt).toLocaleString('zh-CN'));
      } else {
        _tmdbInfoError = (r && r.error) || 'TMDB 获取失败';
        log('[lc-926] TMDB 剧集信息失败: ' + _tmdbInfoError);
      }
    } catch (e) {
      _tmdbInfoError = String(e).substring(0, 120);
    } finally {
      _tmdbInfoLoading = false;
      renderTmdbShowInfo();
    }
  })();
}

/* —— TMDB 信息渲染 —— */
function tmdbEsc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function tmdbFmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function tmdbRuntime(min: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (h + ' 小时 ' + m + ' 分') : (m + ' 分钟');
}
const TMDB_STATUS_CN: Record<string, string> = {
  'Returning Series': '连载中',
  'Ended': '已完结',
  'Canceled': '已取消',
  'In Production': '制作中',
  'Planned': '计划中',
  'Pilot': '试播集',
  'Released': '已上映',
  'Post Production': '后期制作',
  'Rumored': '传闻中',
};

/** 生成「剧集信息」卡中 TMDB 部分的 HTML（不含底部「更新于 + 刷新」） */
function buildTmdbInfoHtml(d: any): string {
  const out: string[] = [];
  const row = (k: string, v: string): void => {
    if (v) out.push(`<div class="fnos-tmdb-row"><span class="fnos-tmdb-k">${tmdbEsc(k)}</span><span class="fnos-tmdb-v">${v}</span></div>`);
  };
  const tags = (list: any[], max = 24): string => (Array.isArray(list) && list.length)
    ? `<span class="fnos-tag-list">${list.slice(0, max).map((t) => `<span class="fnos-tag">${tmdbEsc(t)}</span>`).join('')}</span>`
    : '';
  const link = (href: string, text: string): string =>
    (href && text) ? `<a href="${tmdbEsc(href)}" target="_blank" rel="noopener">${tmdbEsc(text)}</a>` : '';

  // 标题 + 原名 + 标语
  const nameLine = [tmdbEsc(d.title || '')];
  if (d.originalTitle && d.originalTitle !== d.title) {
    nameLine.push(`<span class="fnos-tmdb-orig">${tmdbEsc(d.originalTitle)}</span>`);
  }
  out.push(`<div class="fnos-tmdb-title">${nameLine.join(' ')}</div>`);
  if (d.tagline) out.push(`<div class="fnos-tmdb-tagline">${tmdbEsc(d.tagline)}</div>`);

  // 评分
  if (d.rating) {
    const votes = d.votes ? `<span class="fnos-tmdb-votes">${Number(d.votes).toLocaleString('zh-CN')} 人评分</span>` : '';
    out.push(`<div class="fnos-tmdb-rating"><b>${Number(d.rating).toFixed(1)}</b><span class="fnos-tmdb-rating-max"> / 10</span>${votes}</div>`);
  }

  // 状态 / 播出日期
  const st = TMDB_STATUS_CN[d.status] || d.status || '';
  const dateParts: string[] = [];
  if (d.airDate) dateParts.push('首播 ' + d.airDate);
  if (d.lastAirDate && d.lastAirDate !== d.airDate) dateParts.push('完结 ' + d.lastAirDate);
  if (st || dateParts.length) {
    row('状态', [tmdbEsc(st), tmdbEsc(dateParts.join(' · '))].filter(Boolean).join(' · '));
  }

  // 季 / 集 / 本季
  const cntParts: string[] = [];
  if (d.seasons) cntParts.push(d.seasons + ' 季');
  if (d.episodes) cntParts.push(d.episodes + ' 集');
  if (cntParts.length) row('规模', tmdbEsc(cntParts.join(' · ')));
  if (d.season) {
    const sp: string[] = [];
    if (d.season.episodeCount) sp.push(d.season.episodeCount + ' 集');
    if (d.season.airDate) sp.push('首播 ' + d.season.airDate);
    row('第 ' + d.season.seasonNumber + ' 季', [tmdbEsc(d.season.name), tmdbEsc(sp.join(' · '))].filter(Boolean).join(' · '));
  }

  // 单集时长
  if (d.runtimeAvg) {
    const rt = d.runtimeMin && d.runtimeMax && d.runtimeMin !== d.runtimeMax
      ? `${tmdbRuntime(d.runtimeMin)} ~ ${tmdbRuntime(d.runtimeMax)}`
      : tmdbRuntime(d.runtimeAvg);
    row('单集', tmdbEsc(rt));
  }

  row('类型', tags(d.genres));
  row('地区', tmdbEsc(Array.isArray(d.countries) ? d.countries.join(' / ') : ''));
  row('语言', tmdbEsc(Array.isArray(d.languages) ? d.languages.join(' / ') : ''));
  if (Array.isArray(d.networks) && d.networks.length) row('首播平台', tmdbEsc(d.networks.join(' / ')));
  if (Array.isArray(d.providers) && d.providers.length) row('在线播放', tags(d.providers, 8));
  if (Array.isArray(d.companies) && d.companies.length) row('出品', tags(d.companies, 8));
  if (Array.isArray(d.createdBy) && d.createdBy.length) row('主创', tmdbEsc(d.createdBy.join(' / ')));
  if (Array.isArray(d.directors) && d.directors.length) row('导演', tmdbEsc(d.directors.join(' / ')));
  if (Array.isArray(d.writers) && d.writers.length) row('编剧', tmdbEsc(d.writers.join(' / ')));
  if (Array.isArray(d.composers) && d.composers.length) row('配乐', tmdbEsc(d.composers.join(' / ')));
  if (d.certification) row('分级', tmdbEsc(d.certification));
  if (Array.isArray(d.aliases) && d.aliases.length) row('别名', tmdbEsc(d.aliases.join(' / ')));

  // 主演
  if (Array.isArray(d.cast) && d.cast.length) {
    const chips = d.cast.slice(0, 12).map((c: any) => {
      const nm = tmdbEsc(c.name || '');
      const ch = c.character ? `<span class="fnos-tmdb-char">${tmdbEsc(c.character)}</span>` : '';
      return `<span class="fnos-tag fnos-tmdb-cast">${nm}${ch}</span>`;
    }).join('');
    out.push(`<div class="fnos-tmdb-row"><span class="fnos-tmdb-k">主演</span><span class="fnos-tmdb-v"><span class="fnos-tag-list">${chips}</span></span></div>`);
  }

  if (Array.isArray(d.keywords) && d.keywords.length) row('关键词', tags(d.keywords, 16));

  // 简介（长文本折叠，点「展开」切换）
  if (d.overview) {
    out.push(`<div class="fnos-tmdb-overview fnos-tmdb-clamp">${tmdbEsc(d.overview)}</div>`);
  }

  // 外部链接
  const links: string[] = [];
  if (d.url) links.push(link(d.url, 'TMDB'));
  if (d.externalIds && d.externalIds.imdb) links.push(link('https://www.imdb.com/title/' + d.externalIds.imdb, 'IMDb'));
  if (d.externalIds && d.externalIds.tvdb) links.push(link('https://thetvdb.com/?id=' + d.externalIds.tvdb, 'TVDb'));
  if (d.externalIds && d.externalIds.wikidata) links.push(link('https://www.wikidata.org/wiki/' + d.externalIds.wikidata, 'Wikidata'));
  if (d.trailerKey) links.push(link('https://www.youtube.com/watch?v=' + d.trailerKey, '预告片' + (d.trailerName ? '（' + d.trailerName + '）' : '')));
  if (d.homepage) links.push(link(d.homepage, '官网'));
  if (links.length) out.push(`<div class="fnos-tmdb-links">${links.join('<span class="fnos-tmdb-sep">·</span>')}</div>`);

  return out.join('');
}

/** [lc-927] 采集 fnOS 原生详情页暴露的 IMDb 链接（页面上指向 imdb.com/title/ 的 <a>）。
 *  原「外部链接」独立卡片已取消，IMDb 统一并入「剧集信息」卡显示：
 *  TMDB 数据里有 externalIds.imdb 时以 TMDB 为准，没有时才用这条原生链接兜底。 */
function collectNativeImdb(): { href: string; text: string } | null {
  try {
    const a = Array.from(document.querySelectorAll('a')).find((el) => {
      const h = el.getAttribute('href') || '';
      return /imdb\.com\/title\//i.test(h);
    }) as HTMLElement | null | undefined;
    if (!a) { _nativeImdb = null; return null; }
    const href = (a.getAttribute('href') || '').trim();
    const text = ((a.textContent || '').trim() || 'IMDb').substring(0, 40);
    _nativeImdb = { href, text };
    dlog('collectNativeImdb: ✅ 命中 fnOS 原生 IMDb href=' + href);
    return _nativeImdb;
  } catch (_e) {
    _nativeImdb = null;
    return null;
  }
}

/** 把 TMDB 数据 / 加载中 / 错误 状态渲染进 .fnos-info-tmdb（带内容 diff 防 observer 自喂） */
function renderTmdbShowInfo(): void {
  const box = _infoTmdbEl;
  if (!box) return;
  let body = '';
  if (_tmdbInfoData) {
    body = buildTmdbInfoHtml(_tmdbInfoData);
  } else if (_tmdbInfoLoading) {
    body = '<div class="fnos-tmdb-loading">正在从 TMDB 获取剧集信息…</div>';
  } else if (_tmdbInfoError) {
    body = `<div class="fnos-tmdb-error">${tmdbEsc(_tmdbInfoError)}</div>`;
  }
  // [lc-927] 原生 IMDb 兜底：仅当 TMDB 数据里没有 IMDb 时才补，避免同一页面出现两个 IMDb 链接
  const tmdbHasImdb = !!(_tmdbInfoData && _tmdbInfoData.externalIds && _tmdbInfoData.externalIds.imdb);
  if (_nativeImdb && !tmdbHasImdb) {
    body += `<div class="fnos-tmdb-links"><a href="${tmdbEsc(_nativeImdb.href)}" target="_blank" rel="noopener">${tmdbEsc(_nativeImdb.text)} ↗</a></div>`;
  }
  const errNote = (_tmdbInfoData && _tmdbInfoError)
    ? `<div class="fnos-tmdb-error fnos-tmdb-error-inline">${tmdbEsc(_tmdbInfoError)}</div>` : '';
  const when = _tmdbInfoFetchedAt ? (' 更新于 ' + tmdbFmtTime(_tmdbInfoFetchedAt)) : '';
  const foot = `<div class="fnos-tmdb-foot">`
    + `<span class="fnos-tmdb-src">TMDB${tmdbEsc(when)}</span>`
    + `<button type="button" class="fnos-tmdb-refresh" title="从 TMDB 重新获取本剧信息">${_tmdbInfoLoading ? '获取中…' : '⟳ 刷新'}</button>`
    + `</div>`;
  const next = body + errNote + foot;
  if (box.innerHTML === next) return; // 内容未变 → 不触碰 DOM, 切断自喂
  box.innerHTML = next;

  const ov = box.querySelector('.fnos-tmdb-overview') as HTMLElement | null;
  if (ov) {
    ov.addEventListener('click', () => { ov.classList.toggle('fnos-tmdb-clamp'); });
  }
  const btn = box.querySelector('.fnos-tmdb-refresh') as HTMLElement | null;
  if (btn) {
    btn.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (_tmdbInfoLoading) return;
      ensureTmdbShowInfo(true);
    });
  }
}

/** 刷新「剧集信息」卡中的集数 / 总时长 / 首播（随选集懒加载补全而更新）
 *  [lc-906] 加了内容 diff: html 未变化则不写 innerHTML。
 *  ⚠️ 无脑写 innerHTML 会替换整卡子节点 → childList mutation → 触发 observeSeasonTwoPane 的
 *  MutationObserver(其观察范围包含信息卡) → 再次跑到本函数 → 无限自喂, 是整软件卡死的核心环路之一。 */
function updateSeasonInfoStats(): void {
  // [lc-926] 写进专属子容器 .fnos-info-local（与 TMDB 数据的 .fnos-info-tmdb 互不覆盖）
  const target = _infoLocalEl || _infoCard;
  if (!target) return;
  const episodes = getRealEpisodeCards();
  const count = episodes.length;
  const total = formatSeconds(sumEpisodeSeconds(episodes)); // [lc-906] 复用 cards, 省一次全文档扫描
  const year = findSeasonYearText();
  // [lc-907] 二级 TV 页没有「选集」卡片, 主内容是「季」卡片列表 → 信息卡改显示季数, 保持与季页同样的信息密度
  let countHtml = '';
  if (count) {
    countHtml = `<p>集数：<b>${count}</b> 集</p>`;
  } else if (/\/v\/tv\/[a-f0-9]{32}($|\?|#)/.test(location.href)) {
    const seasons = document.querySelectorAll('.card-root').length;
    if (seasons) countHtml = `<p>季数：<b>${seasons}</b> 季</p>`;
  }
  let html = '';
  if (countHtml) html += countHtml;
  if (total) html += `<p>总时长：${total}</p>`;
  if (year) html += `<p>首播：${year}</p>`;
  if (target.innerHTML === html) return; // [lc-906] 内容未变 → 不触碰 DOM, 切断自喂
  target.innerHTML = html;
}

/** [lc-906] 仅当演职人员里存在「尚未处理」的锚点时才跑完整 restyle。
 *  restyleCastItems 会递归遍历整棵 cast 子树并对每个节点调用 getComputedStyle(强制样式重算),
 *  无条件调用 = 每次 observer 触发都全量重排, 开销极高。稳态下(全部已处理)直接跳过 → 零开销。 */
function restyleCastIfNeeded(container: HTMLElement): void {
  const anchors = Array.from(container.querySelectorAll('a')).filter((a) => {
    const href = a.getAttribute('href') || '';
    return href.includes('/v/person/') || a.querySelector('img') !== null;
  });
  if (anchors.length === 0) return;
  for (let i = 0; i < anchors.length; i++) {
    if (!(anchors[i] as HTMLElement).classList.contains('fnos-cast-item')) {
      restyleCastItems(container);
      return;
    }
  }
}

/** 把「选 集(左) + 侧栏(右)」布局成两栏（幂等，免疫 SPA 重建） */
let _seasonLaying = false; // [lc-905] 重入保护: observer 风暴期 layoutSeasonTwoPane 可能被连续触发, 防止嵌套重排卡死

/** [lc-920] 把 fnOS 原生演职人员整块移入右侧栏(仅一次)。建栏时与 observer 持续巡检时都调用:
 *  - 右栏已有 .fnos-cast-card → 仅确保 restyle(覆盖 fnOS 异步补填的演员节点), 不重复塞入;
 *  - 找到 cast 但右栏还没有 → 创建卡片并移入, 同时启动 600ms 兜底 restyle 定时器;
 *  - 未找到 cast → 直接返回(等 fnOS 异步填充后下次巡检再试)。 */
function ensureCastInAside(aside: HTMLElement): void {
  let cast: HTMLElement | null = null;
  try {
    cast = findSeasonCastParent();
  if (!cast) {
    const existing0 = aside.querySelector('.fnos-cast-card') as HTMLElement | null;
    if (!existing0) dlog('ensureCastInAside: 暂未找到 cast(演员可能尚未异步填充)');
    return;
  }
  const existing = aside.querySelector('.fnos-cast-card') as HTMLElement | null;
  // [lc-931] ⚠️ 关键修正: 不能仅凭 ".fnos-cast-card 存在" 就跳过。
  //   fnOS/React 异步重渲染时可能把已被我们移入右栏的 cast 节点重新挂回原位置(原位置复活一份),
  //   此时 aside 里的 .fnos-cast-card 仍在(可能已空)但 live cast 并不在里面 →
  //   旧逻辑 if(existing) return 误判"已就位"什么都不做 → 演员被留在原位置("跑回原处")。
  //   正确判定: 仅当 live cast 真正位于 aside 的 cast 卡内才跳过; 否则一律重新移入。
  if (existing && existing.contains(cast)) {
    restyleCastIfNeeded(cast); // 已就位: 仅对新增/替换的演员节点收紧, 零重复 DOM 写入
    return;
  }
  // [lc-942] 🛡️ 防御 HierarchyRequestError(白屏):
  //   cast 与 aside 若互为祖先(如 SPA 过渡期 fnOS DOM 错乱 / findSeasonCastParent 临时返回了过高层容器,
  //   而 wrap/aside 又被插在 ep 的父链上 → cast 成了 aside 的祖先), 把 cast 移入右栏必然形成循环 DOM,
  //   随后 appendChild 抛 "new child element contains the parent" → 整页白屏(lc-941 改 SPA 导航后新暴露)。
  //   此刻直接放弃本次搬移, 等 DOM 稳定后下次巡检再试 —— 绝不抛未捕获异常。
  if (cast === aside || cast.contains(aside) || aside.contains(cast)) {
    dlog('ensureCastInAside: ⚠️ cast 与 aside 存在包含关系(cast.contains(aside)=' + cast.contains(aside)
      + ', aside.contains(cast)=' + aside.contains(cast) + '), 跳过搬移避免 HierarchyRequestError 白屏');
    return;
  }
  dlog('ensureCastInAside: 找到 cast, 移入右侧栏 cls=' + (cast.className||'').toString().substring(0,60)
    + (existing ? ' (复用已有 cast 卡: live cast 不在其中)' : ' (新建 cast 卡)'));
  const castOriginParent = cast.parentElement; // [lc-927] 记录原父容器, 搬走后用于清理「只剩标题的空壳」
  scheduleCastRestyle(); // [lc-903] 立即 + 重试 restyle, 覆盖 fnOS 异步填充的演职人员节点
  if (_castRestyleTimer) clearInterval(_castRestyleTimer);
  _castRestyleTimer = setInterval(restyleCastOnce, 600); // [lc-903] 每 600ms 兜底巡检
  // [lc-931] 复用已有 .fnos-cast-card(没有才新建), 避免右栏出现两个 cast 卡导致 hideNativeCastSections 误判
  let castCard = existing;
  if (!castCard) {
    castCard = document.createElement('div');
    castCard.className = 'fnos-info-card fnos-cast-card';
    const castTitle = document.createElement('h4');
    castTitle.textContent = '主要配音演员';
    castCard.appendChild(castTitle);
  } else {
    // 已有卡但 live cast 不在里面: 清掉卡内残留的陈旧 cast 节点(只保留 h4 标题), 再把 live cast 移入
    Array.from(castCard.children).forEach((ch) => {
      if (ch.tagName === 'H4' || ch === cast) return;
      (ch as HTMLElement).remove();
    });
  }
  // [lc-927] 若这份 cast 落在我们此前隐藏过的原生残留容器里(SPA 重建后复用了同一节点),
  //   必须先解除隐藏, 否则移进右栏也照样看不见(右栏演员"消失"就是这么来的)。
  const hiddenAnc = cast.closest('[data-fntv-native-cast-hidden]') as HTMLElement | null;
  if (hiddenAnc) {
    hiddenAnc.removeAttribute('data-fntv-native-cast-hidden');
    hiddenAnc.style.removeProperty('display');
    dlog('ensureCastInAside: ♻️ 解除此前隐藏的原生演职人员祖先, 避免移入右栏后不可见');
  }
  // [lc-942] 双保险: 仅当不产生循环且不重复时才 append(上面已拦截互为祖先, 这里防任何残余边界)
  if (!castCard.contains(cast) && !cast.contains(castCard)) castCard.appendChild(cast);
  // [lc-901b] 强制清零 fnOS 原生容器的 padding/margin(原生 ms-container 带大间距, CSS !important 兜底可能被更深层选择器覆盖)
  cast.style.padding = '0';
  cast.style.margin = '0';
  cast.style.gap = '2px';
  // [lc-923] 上面这行 gap 会覆盖"cast 容器本身即演员行容器"时的行列间距, 建完卡片后补一次演员墙布局
  applyCastWallLayout(cast);
  // [lc-942] 双保险: 仅当 aside 内尚无该卡、且不会形成循环时才 append
  if (!existing && !aside.contains(castCard) && !castCard.contains(aside)) aside.appendChild(castCard);
  // [lc-927] 演员已脱离原位置 → 清掉原位置可能剩下的「演职人员」标题空壳
  pruneCastOriginShell(castOriginParent);
  } catch (e) {
    // [lc-943] 🛡️ 终极兜底: 搬移过程任何意外(含残余的循环 DOM)都只记日志、绝不抛未捕获异常 → 永不白屏。
    //   退化表现: 右栏演员可能缺失(下次稳态巡检会重试), 但页面其它功能完全不受影响。
    dlog('ensureCastInAside: ⚠️ 搬移异常(已捕获, 不白屏) ' + ((e && (e as Error).message) || e)
      + ' | cast?' + (cast ? 'cast.contains(aside)=' + cast.contains(aside) + ', aside.contains(cast)=' + aside.contains(cast) : 'null'));
  }
}

/** [lc-927] 演员整块被搬进右栏后，原位置的父容器常常只剩一个「演职人员」标题（或彻底空掉），
 *  留在页面上就是一条孤零零的空壳区块。这里把它一并隐藏。
 *  ⚠️ 条件极其保守 —— 只有「除了被搬走的 cast 之外几乎没有其它实质内容」时才动手：
 *     ① 不含选集卡 [data-id="details"]；② 不含推荐卡 .card-root；③ 不含任何 <img>；
 *     ④ 剩余可见文本 < 60 字；⑤ 不是两栏容器本身。
 *  任何一条不满足就原样保留 —— 宁可留个空壳，也绝不能把整页内容列隐藏掉。 */
function pruneCastOriginShell(originParent: HTMLElement | null): void {
  // [lc-929] 向上冒泡清理: 演员整块搬走后, 原位置往往只剩「演职人员」标题 + 一个已被清掉的空滚动行,
  //   而这个"只剩标题"的 section 是 originParent 的**父级/祖父级** —— 老版只清直接父容器,
  //   导致用户仍能看到一条孤零零的「演职人员」区块(反馈「页脚未消失」的一部分)。
  //   这里逐级向上(最多 4 层), 只要某层同样已变成空壳就一并隐藏, 遇到有实质内容的一层立即停。
  let node: HTMLElement | null = originParent || null;
  let levels = 0;
  while (node && levels++ < 4) {
    if (!isCastShell(node)) break;
    node.setAttribute('data-fntv-native-cast-hidden', '1');
    node.style.setProperty('display', 'none', 'important');
    dlog('pruneCastOriginShell: 🚫 隐藏演职人员原位置空壳(第' + levels + '层) tag=' + node.tagName
      + ' cls=' + (node.className || '').toString().substring(0, 50));
    node = node.parentElement;
  }
}

/** [lc-929] 判定某容器是否已沦为「演职人员空壳」(演员搬走后只剩标题/空白)。
 *  ⚠️ 条件极保守, 任一不满足即返回 false(宁可留空壳, 也绝不隐藏有实质内容的容器):
 *     ① 不是 body/html, 仍在文档里; ② 不是我们自己的两栏容器;
 *     ③ 不含我们的两栏 wrap; ④ 不含选集卡 [data-id="details"]; ⑤ 不含推荐卡 .card-root;
 *     ⑥ 未被隐藏的子树里不含任何 <img>; ⑦ 未被隐藏的子树剩余文本 < 60 字。 */
function isCastShell(el: HTMLElement | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (!document.body.contains(el)) return false;
  const cls = el.classList;
  if (cls.contains('fnos-season-2col') || cls.contains('fnos-season-main')
    || cls.contains('fnos-season-aside') || cls.contains('fnos-cast-card')) return false;
  if (el.getAttribute('data-fntv-native-cast-hidden')) return false; // 幂等
  if (el.querySelector('.fnos-season-2col')) return false;           // 内含我们的两栏 → 绝不动
  if (el.querySelector('[data-id="details"]')) return false;         // 选集主内容
  if (el.querySelector('.card-root')) return false;                  // 推荐区
  let restText = '';
  const kids = Array.from(el.children) as HTMLElement[];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].getAttribute('data-fntv-native-cast-hidden')) continue; // 已隐藏的子不计入
    if (kids[i].querySelector('img')) return false;                     // 子树里还有图 → 不是空壳
    restText += kids[i].textContent || '';
  }
  if (restText.trim().length > 60) return false;                        // 还有别的文字 → 保留
  return true;
}

/** [lc-927] 隐藏「未被移入右栏」的 fnOS 原生演职人员区块。
 *
 *  背景：ensureCastInAside 是把原生演职人员整块 appendChild 进右栏（DOM 移动，非复制）。
 *  但 fnOS 是 SPA，路由/数据更新后可能在原位置再生成一份（或留下带标题的空壳容器），
 *  于是页面上出现两份演职人员——用户要的就是"原生这里的不要"。
 *
 *  ⚠️ 遵守 lc-921 铁律：全程纯结构定位（人物链接 /v/person/），绝不扫描「演职/演员/配音…」标题文字。
 *  ⚠️ 安全护栏（缺一不可，否则会把整页内容列误判成演职人员并隐藏）：
 *     ① 只在右栏已存在 .fnos-cast-card 时才动手（否则原生那份还没搬走，隐藏就等于永久弄丢演员）；
 *     ② 候选祖先内出现选集卡 [data-id="details"] / 推荐卡 .card-root / 两栏容器 一律跳过；
 *     ③ 位于隐藏祖先内（路由缓存副本）的链接跳过——本来就不可见，别污染以后可能变可见的副本；
 *     ④ 只取「最内层」满足条件的祖先，避免一路向上选到整页。
 *  ⚠️ 幂等：已隐藏的元素打 data-fntv-native-cast-hidden 标记并跳过，observer 反复触发也不会自喂。
 */
function hideNativeCastSections(): number {
  const PERSON_SEL = 'a[href*="/v/person/"]';
  const moved = document.querySelector('.fnos-cast-card');
  if (!moved) return _nativeCastHidden; // ① 右栏还没演员卡 → 绝不隐藏原生那份
  const persons = Array.from(document.querySelectorAll(PERSON_SEL)) as HTMLElement[];
  if (!persons.length) return _nativeCastHidden;
  // ② 稳态快退：所有人物链接都已在右栏 → 无残留，零开销返回
  const stray: HTMLElement[] = [];
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    if (moved.contains(p)) continue;
    if (isHiddenByAncestor(p)) continue;                            // ③ 路由缓存副本里的，不管
    if (p.closest('[data-fntv-native-cast-hidden]')) continue;      // ④ 已处理过
    stray.push(p);
  }
  if (stray.length < 3) return _nativeCastHidden; // 零散人物链接(<3)不构成演职人员区块, 不处理
  const straySet = new Set<Element>(stray);
  for (let i = 0; i < stray.length; i++) {
    const p = stray[i];
    if (!document.body.contains(p)) continue;
    if (p.closest('[data-fntv-native-cast-hidden]')) continue;      // 可能被同批前面的动作覆盖
    // 自底向上找「最内层」满足条件：含 ≥3 个 stray 人物链接，且不含选集卡/推荐卡，且不是两栏容器
    let target: HTMLElement | null = null;
    let el: HTMLElement | null = p;
    while (el && el !== document.body) {
      const cnt = Array.from(el.querySelectorAll(PERSON_SEL)).filter((x) => straySet.has(x)).length;
      const cls = el.classList;
      const isLayout = cls.contains('fnos-season-2col') || cls.contains('fnos-season-main')
        || cls.contains('fnos-season-aside') || cls.contains('fnos-cast-card')
        || cls.contains('fnos-info-card');
      if (cnt >= 3
        && el.querySelector('[data-id="details"]') === null
        && el.querySelector('.card-root') === null
        && !isLayout) { target = el; break; }
      el = el.parentElement;
    }
    if (!target) continue;
    // 若父容器除本区块外只剩「标题级」短文本兄弟(如「演职人员」标题)，连父容器一起隐藏，避免留下孤零零一行标题
    let hideEl: HTMLElement = target;
    const par = target.parentElement;
    if (par && par !== document.body && !par.classList.contains('fnos-season-2col')
      && !par.classList.contains('fnos-season-main')) {
      const sibs = Array.from(par.children).filter((c) => c !== target) as HTMLElement[];
      const allTitleLike = sibs.length > 0 && sibs.every((s) => {
        const t = (s.textContent || '').trim();
        return t.length > 0 && t.length < 60
          && s.querySelector('img') === null
          && s.querySelector('[data-id="details"]') === null
          && s.querySelector('.card-root') === null;
      });
      if (allTitleLike) hideEl = par;
    }
    hideEl.setAttribute('data-fntv-native-cast-hidden', '1');
    hideEl.style.setProperty('display', 'none', 'important');
    _nativeCastHidden++;
    dlog('hideNativeCastSections: 🚫 隐藏原生演职人员残留 #' + _nativeCastHidden
      + ' tag=' + hideEl.tagName + ' cls=' + (hideEl.className || '').toString().substring(0, 50)
      + ' persons=' + stray.length);
  }
  return _nativeCastHidden;
}

/** [lc-928] 隐藏 fnOS 详情页**原生页脚**(含「演职人员」+ 演员横滚行 + 「链接：IMDb链接」等冗余块)。
 *
 *  背景: lc-927 隐藏的是页面**内容区**里的演员残留, 但用户反馈「原生这里的就不要」+「IMDb
 *  链接移动到剧集信息卡」指的其实是 fnOS 详情页**底部原生页脚**(始终在 body 直接子,
 *  跟我们的 .fnos-season-2col wrap 平级或更外层, lc-927 完全碰不到):
 *    · 页脚里有「演职人员」section + 演员头像横滚行(带左右箭头)→ 跟右栏演员卡重复;
 *    · 页脚里有「链接：IMDb链接 豆瓣链接 …」一行 → 跟 lc-927 已并入的 IMDb 重复。
 *
 *  ⚠️ 纯粹结构判定, 不读"演职/演员/链接"等任何标题文字(遵守 lc-921 铁律延伸)。
 *
 *  [lc-929] 重写 —— 老版只取 `body.lastElementChild`(一个), 实测它命中的是**纯链接块**
 *    (img=0 hasLinks=true), 而用户看到的「演职人员 + 演员横滚行」是与之**平级的另一个元素**,
 *    老版根本没遍历到 → 反馈「页脚未消失」。现改为**多候选逐个判定, 命中几个隐藏几个**:
 *     ① <footer> / [role="contentinfo"](语义页脚);
 *     ② 两栏 wrap 在其父容器内的**所有兄弟节点**(fnOS 常把演职人员/链接块挂在内容列里, 与两栏平级);
 *     ③ body 直接子元素中, 文档序排在两栏**之后**的块;
 *     ④ 页面上任何**不在我们两栏内**的 /v/person/ 人物链接 → 自底向上爬到「与两栏平级」的最外层块;
 *     ⑤ 页面上任何**不在我们两栏内**的 IMDb/豆瓣/Bangumi/TMDb/TVDB 链接 → 同上。
 *   判定为「原生页脚/演职残留」的纯结构条件(满足任一):
 *     · 含 ≥3 个 <img>(演员头像); · 含 ≥3 个 /v/person/ 人物链接; · 含外部媒体链接(IMDb 等)。
 *   ⚠️ 安全护栏(命中任一立即跳过, 绝不隐藏):
 *     · 我们自己注入的节点(id/class 含 fnos-/fntv-);
 *     · 含我们两栏 wrap 的 / 在两栏内部的;
 *     · 含 <video>(播放器) / 含选集卡 [data-id="details"](主内容);
 *     · 含推荐卡 .card-root 且人物链接 <3(推荐区不是页脚);
 *     · 文档序排在两栏**之前**的(顶部头图/标题区不是页脚);
 *     · 已被隐藏 / 已被祖先隐藏的。
 *   幂等: data-fntv-season-footer-hidden 标记, observer 反复巡检不自喂。 */
function hideNativeSeasonFooter(): number {
  const wrap = document.querySelector('.fnos-season-2col') as HTMLElement | null;
  if (!wrap || !document.body.contains(wrap)) return 0;
  const MEDIA_LINK_SEL = 'a[href*="imdb.com"],a[href*="douban.com"],a[href*="bangumi.tv"],'
    + 'a[href*="themoviedb.org"],a[href*="thetvdb.com"]';
  const PERSON_SEL = 'a[href*="/v/person/"]';

  /** 自 node 向上爬, 返回「与两栏 wrap 平级」的最外层残留块:
   *  一直爬到「父节点里包含 wrap」或「父节点就是 body」为止 —— 此刻的 node 即与两栏同层的 section 块。 */
  const topBlockOutsideWrap = (node: Element | null): HTMLElement | null => {
    let cur: HTMLElement | null = (node as HTMLElement | null) || null;
    let guard = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && guard++ < 40) {
      const p: HTMLElement | null = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement) return cur;
      if (p === wrap || p.contains(wrap)) return cur;
      cur = p;
    }
    return null;
  };
  /** 我们自己注入的节点, 绝不当页脚隐藏 */
  const isOurNode = (el: HTMLElement): boolean => {
    const id = el.id || '';
    if (id.indexOf('fnos-') === 0 || id.indexOf('fntv') === 0) return true;
    const cls = (el.className || '').toString();
    if (cls.indexOf('fnos-') >= 0 || cls.indexOf('fntv-') >= 0) return true;
    return false;
  };

  const candidates: HTMLElement[] = [];
  const push = (el: Element | null | undefined): void => {
    if (!el || !(el instanceof HTMLElement)) return;
    if (candidates.indexOf(el) < 0) candidates.push(el);
  };
  // ① 语义页脚
  document.querySelectorAll('footer, [role="contentinfo"]').forEach(push);
  // ② 两栏 wrap 在父容器内的所有兄弟
  const par = wrap.parentElement;
  if (par) Array.prototype.forEach.call(par.children, (c: Element) => { if (c !== wrap) push(c); });
  // ③ body 直接子元素中排在两栏之后的块
  Array.prototype.forEach.call(document.body.children, (c: Element) => {
    if (c === wrap || c.contains(wrap)) return;
    if (wrap.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) push(c);
  });
  // ④⑤ 两栏之外的 人物链接 / 外部媒体链接 → 外层残留块
  document.querySelectorAll(PERSON_SEL + ',' + MEDIA_LINK_SEL).forEach((a) => {
    if (wrap.contains(a)) return;
    push(topBlockOutsideWrap(a));
  });

  let hidden = 0;
  for (const el of candidates) {
    if (!el || !document.body.contains(el)) continue;
    if (el === document.body || el === document.documentElement) continue;
    if (el === wrap || wrap.contains(el) || el.contains(wrap)) continue;
    if (isOurNode(el)) continue;
    if (el.getAttribute('data-fntv-season-footer-hidden')) continue;
    // 已不可见(零尺寸)的块无需再隐藏
    if (el.getBoundingClientRect().height <= 0) continue;
    if (isHiddenByAncestor(el)) continue;
    // 内容护栏: 播放器 / 选集主内容 一律不碰
    if (el.querySelector('video')) continue;
    if (el.querySelector('[data-id="details"]')) continue;
    const personCount = el.querySelectorAll(PERSON_SEL).length;
    const hasLinks = !!el.querySelector(MEDIA_LINK_SEL);
    // 推荐区(.card-root)不是页脚; 但若人物链接 ≥3 说明它其实是演职人员块, 仍按页脚处理
    if (el.querySelector('.card-root') && personCount < 3) continue;
    const imgCount = el.querySelectorAll('img').length;
    if (imgCount < 3 && personCount < 3 && !hasLinks) continue;
    // [lc-929] 防误伤"推荐"区: 仅靠 ≥3 张图命中的块, 若图是大尺寸海报(>160px)则判为推荐/媒体墙, 不隐藏
    //   (演员头像通常 64px 左右; 海报 200px+)。有人物链接或外部媒体链接时不走这条, 零额外开销。
    if (personCount < 3 && !hasLinks) {
      let posterLike = 0;
      const imgs = el.querySelectorAll('img');
      for (let i = 0; i < imgs.length && i < 8; i++) {
        if ((imgs[i] as HTMLImageElement).getBoundingClientRect().width > 160) posterLike++;
      }
      if (posterLike > 0) continue;
    }
    // 顶部头图/标题区在两栏之前, 不是页脚
    const following = !!(wrap.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const isSemantic = el.tagName === 'FOOTER' || el.getAttribute('role') === 'contentinfo';
    if (!following && !isSemantic) continue;
    el.setAttribute('data-fntv-season-footer-hidden', '1');
    el.style.setProperty('display', 'none', 'important');
    hidden++;
    dlog('hideNativeSeasonFooter: 🚫 隐藏原生页脚/演职残留 tag=' + el.tagName
      + ' cls=' + (el.className || '').toString().substring(0, 60)
      + ' img=' + imgCount + ' person=' + personCount + ' links=' + hasLinks
      + ' rect.top=' + Math.round(el.getBoundingClientRect().top));
  }
  return hidden;
}

/** [lc-929] 诊断: 列出页面上所有「疑似原生页脚/演职残留」的候选块及其判定结果,
 *  用于确认到底还有哪个块没被隐藏(用户反馈「页脚未消失」时把输出发回来)。
 *  DevTools Console 执行: `fntvSeasonFooterDiag()` */
function fntvSeasonFooterDiag(): void {
  try {
    const wrap = document.querySelector('.fnos-season-2col') as HTMLElement | null;
    const MEDIA_LINK_SEL = 'a[href*="imdb.com"],a[href*="douban.com"],a[href*="bangumi.tv"],'
      + 'a[href*="themoviedb.org"],a[href*="thetvdb.com"]';
    const PERSON_SEL = 'a[href*="/v/person/"]';
    dlog('=== fntvSeasonFooterDiag === wrap=' + (wrap ? 'YES' : 'NO') + ' pathname=' + location.pathname);
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    dlog('wrap.rect top=' + Math.round(wr.top) + ' bottom=' + Math.round(wr.bottom)
      + ' reserve=' + (wrap.getAttribute('data-fntv-bottom-reserve') || '?') + ' vh=' + window.innerHeight);
    const dump = (label: string, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 40);
      dlog('  [' + label + '] ' + el.tagName + '.' + (el.className || '').toString().substring(0, 40)
        + ' | rect t=' + Math.round(r.top) + ' b=' + Math.round(r.bottom) + ' h=' + Math.round(r.height)
        + ' | display=' + cs.display
        + ' | hidden=' + (el.getAttribute('data-fntv-season-footer-hidden') || '-')
        + ' | img=' + el.querySelectorAll('img').length
        + ' person=' + el.querySelectorAll(PERSON_SEL).length
        + ' links=' + el.querySelectorAll(MEDIA_LINK_SEL).length
        + ' | txt="' + txt + '"');
    };
    const par = wrap.parentElement;
    dlog('-- 两栏父容器: ' + (par ? par.tagName + '.' + (par.className || '').toString().substring(0, 50) : 'NULL')
      + ' kids=' + (par ? par.childElementCount : 0));
    if (par) Array.prototype.forEach.call(par.children, (c: HTMLElement, i: number) => {
      if (c === wrap) { dlog('  [sibling#' + i + '] <我们的两栏 wrap>'); return; }
      dump('sibling#' + i, c);
    });
    dlog('-- body 直接子元素(kids=' + document.body.childElementCount + '):');
    Array.prototype.forEach.call(document.body.children, (c: HTMLElement, i: number) => {
      if (c.contains(wrap)) { dlog('  [body#' + i + '] <含两栏的祖先容器 ' + c.tagName + '.' + (c.className || '').toString().substring(0, 30) + '>'); return; }
      dump('body#' + i, c);
    });
    dlog('-- 两栏之外的 人物/媒体链接 外层块:');
    const seen: HTMLElement[] = [];
    document.querySelectorAll(PERSON_SEL + ',' + MEDIA_LINK_SEL).forEach((a) => {
      if (wrap.contains(a)) return;
      let cur: HTMLElement | null = a as HTMLElement;
      let g = 0;
      while (cur && cur !== document.body && g++ < 40) {
        const p: HTMLElement | null = cur.parentElement;
        if (!p || p === document.body) break;
        if (p === wrap || p.contains(wrap)) break;
        cur = p;
      }
      if (cur && seen.indexOf(cur) < 0) { seen.push(cur); dump('stray-link-block', cur); }
    });
    dlog('=== fntvSeasonFooterDiag END ===');
  } catch (e) { dlog('fntvSeasonFooterDiag error: ' + (e as Error).message); }
}
// [lc-929] 暴露给 DevTools Console 诊断
(window as any).fntvSeasonFooterDiag = fntvSeasonFooterDiag;

/** [lc-928] 诊断: 打印两栏 wrap / 左栏(选集) / 右栏(剧集信息+演员) 的真实高度、overflow
 *  与 fnOS 原生页脚是否已隐藏, 帮助定位「右栏滚动底部被截断」的根因。
 *  用户在 DevTools Console 执行 `fntvSeasonScrollDiag()` 即可查看, 把输出发回来。 */
function fntvSeasonScrollDiag(): void {
  try {
    const wrap = document.querySelector('.fnos-season-2col') as HTMLElement | null;
    const ep = document.querySelector('.fnos-season-main') as HTMLElement | null;
    const aside = document.querySelector('.fnos-season-aside') as HTMLElement | null;
    const footer = (document.querySelector('footer') || document.querySelector('[role="contentinfo"]')
      || document.body.lastElementChild) as HTMLElement | null;
    const dump = (label: string, el: HTMLElement | null) => {
      if (!el) { dlog('Diag[' + label + ']: NULL'); return; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      dlog('Diag[' + label + ']: display=' + cs.display + ' h=' + cs.height + ' maxH=' + cs.maxHeight
        + ' minH=' + cs.minHeight + ' overflowY=' + cs.overflowY + ' overflow=' + cs.overflow
        + ' | rect w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
        + ' top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom)
        + ' scrollH=' + el.scrollHeight + ' clientH=' + el.clientHeight);
    };
    dlog('=== fntvSeasonScrollDiag === vh=' + window.innerHeight + ' pathname=' + location.pathname);
    dump('wrap', wrap); dump('ep', ep); dump('aside', aside);
    // [lc-929] 底部预留量 + 会裁剪的祖先链: 判断两栏是否被祖先(带 mb-[46px] 的容器)裁掉底部
    if (wrap) {
      dlog('Diag[bottom-reserve]: reserve=' + (wrap.getAttribute('data-fntv-bottom-reserve') || '?')
        + ' (两栏高度=calc(vh - top - reserve))');
      let anc: HTMLElement | null = wrap.parentElement;
      let g = 0;
      while (anc && anc !== document.body && g++ < 10) {
        const cs = getComputedStyle(anc);
        if ((cs.overflowY || 'visible') !== 'visible' || (cs.overflowX || 'visible') !== 'visible') {
          const r = anc.getBoundingClientRect();
          dlog('Diag[clip-anc]: ' + anc.tagName + '.' + (anc.className || '').toString().substring(0, 40)
            + ' bottom=' + Math.round(r.bottom) + ' overflowY=' + cs.overflowY + ' overflowX=' + cs.overflowX
            + ' mb=' + cs.marginBottom);
        }
        anc = anc.parentElement;
      }
    }
    if (aside) {
      const r = aside.getBoundingClientRect();
      dlog('Diag[aside-scrollMath]: 内容总高=' + aside.scrollHeight + ' 可视=' + aside.clientHeight
        + ' 溢出=' + Math.max(0, aside.scrollHeight - aside.clientHeight)
        + ' 当前 scrollTop=' + aside.scrollTop
        + ' (rect.bottom 距 vh=' + (window.innerHeight - r.bottom) + ')');
    }
    if (footer) {
      dlog('Diag[footer]: tag=' + footer.tagName + ' cls=' + (footer.className||'').toString().substring(0, 60)
        + ' hidden=' + !!footer.getAttribute('data-fntv-season-footer-hidden')
        + ' display=' + getComputedStyle(footer).display
        + ' rect.top=' + Math.round(footer.getBoundingClientRect().top));
    }
    // 列出右栏内各卡片高度, 看谁撑高了右栏
    const cards = document.querySelectorAll('.fnos-season-aside > *') as NodeListOf<HTMLElement>;
    cards.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      dlog('Diag[aside-card#' + i + ']: tag=' + c.tagName + ' cls=' + (c.className||'').toString().substring(0, 50)
        + ' rect h=' + Math.round(r.height) + ' scrollH=' + c.scrollHeight);
    });
    dlog('=== fntvSeasonScrollDiag END ===');
  } catch (e) { dlog('fntvSeasonScrollDiag error: ' + (e as Error).message); }
}
// [lc-928] 暴露给 DevTools Console 诊断
(window as any).fntvSeasonScrollDiag = fntvSeasonScrollDiag;

// [lc-930] 右栏文字对比度自适应: 采样卡片实际背景亮度, 在 .fnos-season-aside 上挂
//   data-fntv-text="light|dark"(light=浅色文字用于暗背景, dark=深色文字用于亮背景),
//   由 CSS 用 --fntv-info-*/--fntv-cast-* 变量驱动文字色。卡片的 --semi-color-bg-2 动态渐变(随封面主题染色)保持不动。
// [lc-951] 背景亮度采样同时解析 background-image 渐变停靠点(封面主题染色写在渐变上, 实色读不到 → 此前永远按主题猜,
//   浅色主题染深渐变会误选深字导致字体消失); 并挂 MutationObserver 兜住异步染色/主题切换。
function _relLum(r: number, g: number, b: number): number {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function _parseRgb(bc: string): [number, number, number, number] | null {
  const m = bc.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  // [lc-952] 兼容现代 CSS 颜色语法: rgb(255 0 0 / 50%) → 用 / 和空格都能解析
  const normalized = m[1].replace(/\//g, ',').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
  const p = normalized.split(',').map((s) => parseFloat(s));
  if (p.length < 3) return null;
  return [p[0], p[1], p[2], p.length >= 4 ? p[3] : 1];
}
function _parseHex(hex: string): [number, number, number, number] | null {
  const h = hex.replace('#', '');
  const read = (s: string) => parseInt(s, 16);
  if (h.length === 3 || h.length === 4) {
    const r = read(h[0] + h[0]), g = read(h[1] + h[1]), b = read(h[2] + h[2]);
    const a = h.length === 4 ? read(h[3] + h[3]) / 255 : 1;
    return [r, g, b, a];
  }
  if (h.length === 6 || h.length === 8) {
    const r = read(h.slice(0, 2)), g = read(h.slice(2, 4)), b = read(h.slice(4, 6));
    const a = h.length === 8 ? read(h.slice(6, 8)) / 255 : 1;
    return [r, g, b, a];
  }
  return null;
}
function _parseAnyColor(c: string): [number, number, number, number] | null {
  if (c.startsWith('#')) return _parseHex(c);
  return _parseRgb(c);
}
/** [lc-951] 解析渐变(background-image)的颜色停靠点, 求均值相对亮度。
 *   封面主题染色写在渐变上, getComputedStyle 读不到实色 → 必须解析颜色停靠点才能知道背景到底多暗。
 *   透明停靠点(alpha<0.1)露出底层不计入; 取实色停靠点均值亮度。 */
function _gradientLum(bgImage: string): number | null {
  if (!bgImage || bgImage === 'none') return null;
  const re = /(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/g;
  const cols: [number, number, number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bgImage))) {
    const p = _parseAnyColor(m[1]);
    if (p) cols.push(p);
  }
  if (cols.length === 0) return null;
  const solid = cols.filter((c) => c[3] >= 0.1);
  const use = solid.length ? solid : cols;
  let sum = 0;
  for (const c of use) sum += _relLum(c[0], c[1], c[2]);
  return sum / use.length;
}
let _contrastObs: MutationObserver | null = null;
/** [lc-953] 定位左上角返回按钮(fnOS 原生反色逻辑真值源): fnOS 已算好它在当前背景下该用浅/深字。
 *   优先 button[aria-label="返回"](carousel/styles.ts 等多处用它检测 fnOS 接管详情页); 否则 [aria-label*="返回"];
 *   兜底探查视口左上角(顶≤90px / 左≤150px)最近可见 button/[role=button]。 */
function findTopLeftButton(): HTMLElement | null {
  const byAria = document.querySelector('button[aria-label="返回"]') as HTMLElement | null;
  if (byAria) return byAria;
  const byAriaLike = document.querySelector('button[aria-label*="返回"]') as HTMLElement | null;
  if (byAriaLike) return byAriaLike;
  let best: HTMLElement | null = null, bestD = Infinity;
  const cands = Array.from(document.querySelectorAll('button,[role="button"]')) as HTMLElement[];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.top > 90 || r.left > 150) continue;
    const d = r.top + r.left;
    if (d < bestD) { bestD = d; best = el; }
  }
  return best;
}
/** [lc-953] 监听右栏 + 左上角按钮(fnOS 反色信号)变化, 延迟重算。按钮 color 由 fnOS 反色驱动, 监听它即同步。 */
function observeSeasonAsideContrast(aside: HTMLElement, btn: HTMLElement | null): void {
  if (_contrastObs) _contrastObs.disconnect();
  let t: number | null = null;
  const schedule = (): void => { if (t != null) clearTimeout(t); t = window.setTimeout(applySeasonAsideContrast, 140); };
  _contrastObs = new MutationObserver(schedule);
  _contrastObs.observe(aside, { attributes: true, attributeFilter: ['style', 'class'], subtree: true });
  _contrastObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  if (btn) {
    // [lc-954] 同时监听返回按钮自身 + 其最多 5 层祖先的 class/style 变化。
    //   fnOS 常把沉浸式反色加在按钮的祖先节点(而非按钮自身), 按钮靠 CSS 继承变色 → 只观察 btn 自身会漏触发, 导致自动对比度停在首帧(按钮还是深字)算出的 dark。
    _contrastObs.observe(btn, { attributes: true, attributeFilter: ['style', 'class'] });
    let p = btn.parentElement as HTMLElement | null;
    for (let i = 0; i < 5 && p; i++) {
      _contrastObs.observe(p, { attributes: true, attributeFilter: ['style', 'class'] });
      p = p.parentElement;
    }
  }
  // [lc-954] 布局后短延迟补算: 覆盖 fnOS 在 DOM 渲染后才给返回按钮套反色的情况(首帧按钮还是深字 → 误算 dark)。
  //   applySeasonAsideContrast 仅 data-fntv-text 变化时落日志(lc-951), 故稳态不会刷屏。
  [300, 700, 1200].forEach((ms) => window.setTimeout(applySeasonAsideContrast, ms));
}
function applySeasonAsideContrast(): void {
  const aside = document.querySelector('.fnos-season-aside') as HTMLElement | null;
  if (!aside) return;
  let text: 'light' | 'dark' = 'dark';
  let useBtn = false;
  let lum = -1; // 仅诊断日志用
  // [lc-953] 主路径: 同步左上角返回按钮的 fnOS 原生反色(它的 color 就是 fnOS 认为当前该用浅/深字的真值)。
  //   读其 computed color, 亮(白)字 → 浅字态, 暗(黑)字 → 深字态。比自己采样背景亮度可靠得多。
  const btn = findTopLeftButton();
  if (btn) {
    const bc = getComputedStyle(btn).color;
    const pc = _parseRgb(bc) || _parseHex(bc);
    if (pc) {
      const lb = _relLum(pc[0], pc[1], pc[2]);
      text = lb > 0.4 ? 'light' : 'dark';
      lum = lb;
      useBtn = true;
    }
  }
  // [lc-952] 回退: 无返回按钮或 color 解析失败, 退化到背景采样(lc-951 渐变 + url 染色 sawBgImage 兜底)。
  if (!useBtn) {
    const samples: HTMLElement[] = [];
    const infoCard = aside.querySelector('.fnos-info-card') as HTMLElement | null;
    const castCard = aside.querySelector('.fnos-cast-card') as HTMLElement | null;
    if (infoCard) samples.push(infoCard);
    if (castCard) samples.push(castCard);
    samples.push(aside);
    let sawBgImage = false;
    for (const el of samples) {
      let cur: HTMLElement | null = el;
      while (cur && cur !== document.body) {
        const cs = getComputedStyle(cur);
        const bc = cs.backgroundColor;
        if (bc && bc !== 'transparent' && bc !== 'rgba(0, 0, 0, 0)') {
          const c = _parseRgb(bc);
          if (c && c[3] > 0.06) { lum = _relLum(c[0], c[1], c[2]); break; }
        }
        const bi = cs.backgroundImage;
        if (bi && bi !== 'none') sawBgImage = true;
        if (lum < 0 && bi && bi !== 'none') {
          const gl = _gradientLum(bi);
          if (gl != null) { lum = gl; break; }
        }
        cur = cur.parentElement;
      }
      if (lum >= 0) break;
    }
    if (lum < 0) {
      const darkContext = document.documentElement.classList.contains('dark')
        || !!document.querySelector('.semi-always-dark');
      lum = (darkContext || sawBgImage) ? 0.12 : 0.92;
    }
    const Ld = 0.03, Ll = 0.95;
    const crDark = (Math.max(lum, Ld) + 0.05) / (Math.min(lum, Ld) + 0.05);
    const crLight = (Math.max(lum, Ll) + 0.05) / (Math.min(lum, Ll) + 0.05);
    text = crLight > crDark ? 'light' : 'dark';
  }
  // [lc-951] 仅在对比度结果(data-fntv-text)实际变化时落日志: MutationObserver 延迟重调本函数, 无条件 dlog 会刷屏。
  const prevText = aside.getAttribute('data-fntv-text');
  if (prevText !== text) {
    aside.setAttribute('data-fntv-text', text);
    dlog('applySeasonAsideContrast: src=' + (useBtn ? 'btn' : 'sample') + ' lum=' + (lum >= 0 ? lum.toFixed(3) : 'n/a')
      + ' -> data-fntv-text=' + text);
  }
  observeSeasonAsideContrast(aside, btn); // [lc-953] 监听动态染色 / 左上角按钮反色, 兜底重算
}
// [lc-930] 暴露给 DevTools Console 手动触发
(window as any).fntvSeasonContrast = applySeasonAsideContrast;
// [lc-952] 手动诊断: DevTools Console 跑 fntvSeasonDiag() 打印右栏对比度采样上下文(背景色/背景图/暗色信号/当前 data), 便于精修字体对比度。不自动触发, 不刷屏。
(window as any).fntvSeasonDiag = function (): void {
  const aside = document.querySelector('.fnos-season-aside') as HTMLElement | null;
  if (!aside) { dlog('fntvSeasonDiag: 未找到 .fnos-season-aside'); return; }
  const infoCard = aside.querySelector('.fnos-info-card') as HTMLElement | null;
  const castCard = aside.querySelector('.fnos-cast-card') as HTMLElement | null;
  const dump = (label: string, el: HTMLElement | null): void => {
    if (!el) { dlog('fntvSeasonDiag: ' + label + ' = NULL'); return; }
    const cs = getComputedStyle(el);
    dlog('fntvSeasonDiag: ' + label + ' bgColor=' + cs.backgroundColor + ' bgImage=' + cs.backgroundImage.slice(0, 120));
  };
  dump('aside', aside);
  dump('infoCard', infoCard);
  dump('castCard', castCard);
  let cur: HTMLElement | null = infoCard || aside;
  for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
    const cs = getComputedStyle(cur);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      dlog('fntvSeasonDiag: ancestor[' + i + '] ' + cur.tagName + '.' + (cur.className || '').toString().substring(0, 40) + ' bgImage=' + cs.backgroundImage.slice(0, 140));
    }
    cur = cur.parentElement;
  }
  dlog('fntvSeasonDiag: html.dark=' + document.documentElement.classList.contains('dark')
    + ' semi-always-dark=' + !!document.querySelector('.semi-always-dark')
    + ' body.fnos-immersive-season=' + document.body.classList.contains('fnos-immersive-season')
    + ' data-fntv-text=' + aside.getAttribute('data-fntv-text'));
  // [lc-953] 打印左上角返回按钮(反色真值源)的 color 与推导结果, 便于核对同步是否生效
  const btn = findTopLeftButton();
  if (btn) {
    const bcs = getComputedStyle(btn).color;
    const bpc = _parseRgb(bcs) || _parseHex(bcs);
    const bl = bpc ? _relLum(bpc[0], bpc[1], bpc[2]) : -1;
    dlog('fntvSeasonDiag: topLeftBtn=' + (btn.getAttribute('aria-label') || (btn.tagName + '.' + (btn.className || '').toString().substring(0, 30)))
      + ' color=' + bcs + ' lum=' + (bl >= 0 ? bl.toFixed(3) : 'n/a') + ' => text=' + (bl > 0.4 ? 'light' : 'dark'));
  } else {
    dlog('fntvSeasonDiag: topLeftBtn=NULL(无返回按钮, 回退背景采样)');
  }
  applySeasonAsideContrast();
};

function layoutSeasonTwoPane(): void {
  if (_seasonLaying) { dlog('layoutSeasonTwoPane: 🔒 重入保护, 跳过(_seasonLaying=true)'); return; }
  // [lc-920] 一级详情页(show 页 /v/tv/<32hex>, 不含 /season/)不建两栏, 保持 fnOS 原生外观。
  //   若从历史季页返回一级页, 旧两栏 DOM 一般已被 fnOS 路由替换; 此处仍兜底清理可能的残留僵尸两栏。
  if (!/\/season\//.test(location.pathname)) {
    const _stale = document.querySelector('.fnos-season-2col') as HTMLElement | null;
    if (_stale) { dlog('layoutSeasonTwoPane: [一级页] 清理残留两栏'); _stale.remove(); }
    return;
  }
  // [lc-917] 若已存在两栏 wrap: 仅当它在「可见」位置时才跳过; 若它被建进了 fnOS 路由缓存的隐藏 --cache 副本
  //   (display:none → 整块不可见), 必须先移除这个僵尸 wrap, 才能在可见副本里正确重建, 否则会永远"跳过"导致选集占满整宽。
  const _existing = document.querySelector('.fnos-season-2col') as HTMLElement | null;
  if (_existing) {
    if (isHiddenByAncestor(_existing)) {
      dlog('layoutSeasonTwoPane: ⚠️ 发现隐藏(缓存)副本里的僵尸两栏, 先移除再重建到可见副本');
      _existing.remove();
    } else {
      dlog('layoutSeasonTwoPane: 已有两栏(可见), 跳过'); return;
    }
  }
  _seasonLaying = true;
  try {
  dlog('layoutSeasonTwoPane: === 开始建两栏 === pathname=' + location.pathname);
  const ep = findSeasonEpParent();
  const cast = findSeasonCastParent();
  const root = ep ? ep.parentElement : null;
  dlog('layoutSeasonTwoPane: ep=' + (ep ? ep.tagName+'.'+(ep.className||'').toString().substring(0,50) : 'NULL')
    + ' root=' + (root ? root.tagName+'.'+(root.className||'').toString().substring(0,50) : 'NULL')
    + ' cast=' + (cast ? cast.tagName+'.'+(cast.className||'').toString().substring(0,50) : 'NULL'));
  if (!ep || !root) { dlog('layoutSeasonTwoPane: ❌ ep或root为空, 返回'); return; }
  // [lc-909] 安全护栏: 容器若定位到 body/html/过宽的顶层节点, 会把整页塞进左栏导致布局彻底错乱
  if (ep === document.body || ep === document.documentElement || !document.body.contains(ep)) {
    dlog('layoutSeasonTwoPane: ⚠️ 主内容容器非法(body/html/已脱离DOM), 跳过两栏');
    return;
  }
  const epParent = ep.parentElement;
  if (epParent === document.body || epParent === document.documentElement) {
    dlog('layoutSeasonTwoPane: ⚠️ 主内容容器直接挂在页面根, 疑似顶层节点, 跳过两栏');
    return;
  }
  dlog('layoutSeasonTwoPane: ✅ 护栏通过. epParent=' + (epParent?.tagName||'?') + '.' + ((epParent?.className||'').toString().substring(0,60))
    + ' epParent.kids=' + (epParent?.childElementCount||0)
    + ' ep在parent中的idx=' + (epParent ? Array.prototype.indexOf.call(epParent.children, ep) : -1));

  const wrap = document.createElement('div');
  wrap.className = 'fnos-season-2col';

  // 左侧：选集
  ep.classList.add('fnos-season-main');

  // 右侧：信息侧栏
  const aside = document.createElement('aside');
  aside.className = 'fnos-season-aside';

  // 剧集信息 = 本地统计(fnOS 真实暴露的集数/总时长/首播) + [lc-926] TMDB 详情
  const info = document.createElement('div');
  info.className = 'fnos-info-card';
  info.setAttribute('data-fntv-season-info', '');
  const infoTitle = document.createElement('h4');
  infoTitle.textContent = '剧集信息';
  const infoLocal = document.createElement('div');
  infoLocal.className = 'fnos-info-local';
  const infoTmdb = document.createElement('div');
  infoTmdb.className = 'fnos-info-tmdb';
  info.appendChild(infoTitle);
  info.appendChild(infoLocal);
  info.appendChild(infoTmdb);
  aside.appendChild(info);
  _infoCard = info;
  _infoLocalEl = infoLocal;
  _infoTmdbEl = infoTmdb;
  collectNativeImdb();   // [lc-927] 先采集 fnOS 原生 IMDb，供「剧集信息」卡在 TMDB 无 IMDb 时兜底
  updateSeasonInfoStats();
  ensureTmdbShowInfo(); // [lc-926] 首次打开该季 → 拉一次 TMDB（本地有磁盘缓存则秒回，零网络请求）

  // [lc-920] 主要配音演员(借用 fnOS 原生演职人员): 抽成 ensureCastInAside, 建栏时与 observer 持续巡检时复用,
  //   解决"演员数据异步填充后才出现、但两栏只在首次建立时塞过一次 → 右栏永远缺演员"的问题。
  ensureCastInAside(aside);
  // [lc-927] 原「外部链接」独立卡片已取消: IMDb 链接并入「剧集信息」卡显示
  //   (TMDB 的 externalIds.imdb 优先, 无 TMDB 数据时用 fnOS 原生链接兜底, 见 renderTmdbShowInfo)。

  // 组装两栏
  root.insertBefore(wrap, ep);
  wrap.appendChild(ep);
  wrap.appendChild(aside);

  // [lc-929] ⚠️ 顺序铁律: 下面两个隐藏函数都以「页面上存在 .fnos-season-2col」为前提
  //   (护栏: 没建两栏就不动手, 且要用 wrap 的文档位置去排除我们自己注入的节点)。
  //   老代码在 insertBefore 之前调用 → document.querySelector('.fnos-season-2col') 恒为 null
  //   → 首次建栏时这两个函数**一次都没真正执行**(只有 observer 后续巡检才生效) →
  //   用户看到「页脚未消失」。必须放到 wrap 入 DOM 之后。
  // [lc-927] 演员已搬进右栏 → 隐藏 fnOS 原生位置残留的那份(SPA 重建/空壳标题), 页面上只保留右栏一份。
  hideNativeCastSections();
  // [lc-928/929] 同时隐藏 fnOS 详情页底部原生页脚(重复的「演职人员」+ 演员横滚行 + 「链接：IMDb链接」)。
  hideNativeSeasonFooter();

  dlog('layoutSeasonTwoPane: ✅ 两栏DOM已建. wrap.parent=' + (wrap.parentElement?.tagName||'?')
    + '.' + ((wrap.parentElement?.className||'').toString().substring(0,60))
    + ' wrap.idx=' + (wrap.parentElement ? Array.prototype.indexOf.call(wrap.parentElement.children, wrap) : -1)
    + ' ep在wrap内idx=' + Array.prototype.indexOf.call(wrap.children, ep)
    + ' aside在wrap内idx=' + Array.prototype.indexOf.call(wrap.children, aside));

  // [lc-912] 关键: 立即检查 CSS computed style, 确认 grid 是否真的生效
  try {
    const csWrap = getComputedStyle(wrap);
    const csEp = getComputedStyle(ep);
    const csAside = getComputedStyle(aside);
    const csRoot = getComputedStyle(root);
    dlog('layoutSeasonTwoPane: [CSS] wrap.display=' + csWrap.display
      + ' gridTemplateColumns=' + csWrap.gridTemplateColumns
      + ' wrap.w=' + csWrap.width + ' wrap.overflow=' + csWrap.overflow
      + ' | ep.display=' + csEp.display + ' ep.w=' + csEp.width
      + ' | aside.display=' + csAside.display + ' aside.w=' + csAside.width
      + ' | root.display=' + csRoot.display + ' root.w=' + csRoot.width
      + ' root.overflow=' + csRoot.overflow
      + ' root.overflowX=' + csRoot.overflowX
      + ' | body.fnos-immersive-season=' + document.body.classList.contains('fnos-immersive-season'));
    // [lc-952] 删除祖先链逐层 dlog(原每次建栏打 6 行, SPA 频繁重建时刷屏); 布局已稳定, 不再需要逐层诊断。
  } catch (_csErr) {
    dlog('layoutSeasonTwoPane: [CSS] computed style 检查异常: ' + (_csErr as Error).message);
  }

  // [lc-915] 自修复兜底: 若 computed display 不是 grid(类样式因任何原因未生效——
  //   样式表未注入 / 被更高优先级覆盖 / 祖先 display 约束 / body 类缺失), 直接给 wrap 打内联 grid,
  //   保证两栏视觉必定成立, 不再依赖 .fnos-immersive-season 作用域 CSS。内联 !important 优先级最高, 兜底万无一失。
  try {
    const _cs = getComputedStyle(wrap);
    if (_cs.display !== 'grid') {
      dlog('layoutSeasonTwoPane: ⚠️ grid 未生效(display=' + _cs.display + ', styleInjected='
        + !!document.getElementById('fnos-immersive-season-style') + '), 强制内联 grid 兜底');
      wrap.style.setProperty('display', 'grid', 'important');
      wrap.style.setProperty('grid-template-columns', 'minmax(0,60fr) minmax(0,40fr)', 'important');
      wrap.style.setProperty('width', '100%', 'important');
      wrap.style.setProperty('box-sizing', 'border-box', 'important');
      wrap.style.setProperty('gap', '24px', 'important');
      wrap.style.setProperty('align-items', 'stretch', 'important');
    } else {
      dlog('layoutSeasonTwoPane: ✅ grid 已生效(display=grid, gridCols=' + _cs.gridTemplateColumns + ')');
    }
    // [lc-921] 滚动兜底(内联 !important, 不依赖作用域 CSS): 网格占满视口(减去真实顶部偏移),
    //   左右两栏 height:100% + overflow-y:auto 各自内部滚动, 彻底修复"二级详情页无法下滑"。
    const _top = Math.max(0, Math.round(wrap.getBoundingClientRect().top));
    // [lc-929] 底部可用空间: 逐级向上找「会裁剪」的祖先(overflow/overflow-x/overflow-y 非 visible),
    //   取其 padding box 下边缘, 与视口底取最小值 → 得到两栏真正能占到的底边。
    //   原因: fnOS 详情页内容列带 mb-[46px](底部常驻条占位), 其父容器的可视底边比视口底高 46px;
    //   老代码无脑 calc(100vh - top) → 两栏底部 46px 落在裁剪区外面/被祖先 overflow 裁掉 →
    //   用户看到「集数据和演员信息在容器里滚动底部被截断」(左右两栏同时被截)。
    let _bottomLimit = window.innerHeight;
    const _clipChain: string[] = [];
    try {
      let _anc: HTMLElement | null = wrap.parentElement;
      let _g = 0;
      while (_anc && _anc !== document.body && _anc !== document.documentElement && _g++ < 12) {
        const _cs = getComputedStyle(_anc);
        const _oy = _cs.overflowY || 'visible';
        const _ox = _cs.overflowX || 'visible';
        if (_oy !== 'visible' || _ox !== 'visible') {
          const _r = _anc.getBoundingClientRect();
          const _pb = parseFloat(_cs.paddingBottom) || 0;
          const _bb = parseFloat(_cs.borderBottomWidth) || 0;
          const _lim = _r.bottom - _pb - _bb;
          _clipChain.push(_anc.tagName + '.' + (_anc.className || '').toString().substring(0, 24)
            + '[bottom=' + Math.round(_lim) + ']');
          // 只接受「明显位于两栏顶部之下」的限制, 防止把两栏压成 0 高
          if (_lim > _top + 120 && _lim < _bottomLimit) _bottomLimit = _lim;
        }
        _anc = _anc.parentElement;
      }
    } catch (_clErr) { /* ignore */ }
    const _reserve = Math.max(0, Math.round(window.innerHeight - _bottomLimit));
    wrap.setAttribute('data-fntv-bottom-reserve', String(_reserve));
    const _colH = `calc(${window.innerHeight}px - ${_top}px - ${_reserve}px)`;
    dlog('layoutSeasonTwoPane: [lc-929 高度] top=' + _top + ' bottomLimit=' + Math.round(_bottomLimit)
      + ' reserve=' + _reserve + ' colH=' + _colH + ' | 裁剪祖先链=' + (_clipChain.join(' < ') || '无'));
    wrap.style.setProperty('height', _colH, 'important');
    wrap.style.setProperty('max-height', _colH, 'important');
    wrap.style.setProperty('min-height', '0', 'important');
    wrap.style.setProperty('overflow', 'hidden', 'important');
    wrap.style.setProperty('grid-template-rows', 'minmax(0, 1fr)', 'important');
    wrap.style.setProperty('align-items', 'stretch', 'important');
    ep.style.setProperty('height', '100%', 'important');
    ep.style.setProperty('max-height', '100%', 'important');
    ep.style.setProperty('min-height', '0', 'important');
    ep.style.setProperty('overflow-y', 'auto', 'important');
    ep.style.setProperty('overflow-x', 'hidden', 'important');
    aside.style.setProperty('height', '100%', 'important');
    aside.style.setProperty('max-height', '100%', 'important');
    aside.style.setProperty('min-height', '0', 'important');
    aside.style.setProperty('overflow-y', 'auto', 'important');
    aside.style.setProperty('overflow-x', 'hidden', 'important');
  } catch (_shErr) { /* ignore */ }

  // [lc-916] 几何诊断: 输出 wrap/main/aside 的 getBoundingClientRect, 精确到像素。
  //   若 aside.w=0 或 aside 在视口外 → 视觉上「右栏消失」; 若 wrap.w=0 → 整个两栏容器未参与布局。
  try {
    const wr = wrap.getBoundingClientRect();
    const mr = ep.getBoundingClientRect();
    const ar = aside.getBoundingClientRect();
    dlog('layoutSeasonTwoPane: [GEO] wrap={t:' + Math.round(wr.top) + ',l:' + Math.round(wr.left)
      + ',w:' + Math.round(wr.width) + ',h:' + Math.round(wr.height) + '}'
      + ' main={t:' + Math.round(mr.top) + ',l:' + Math.round(mr.left)
      + ',w:' + Math.round(mr.width) + ',h:' + Math.round(mr.height) + '}'
      + ' aside={t:' + Math.round(ar.top) + ',l:' + Math.round(ar.left)
      + ',w:' + Math.round(ar.width) + ',h:' + Math.round(ar.height) + '}'
      + ' aside.kids=' + aside.childElementCount + ' aside.oh=' + aside.offsetHeight
      + ' viewport=' + window.innerWidth + 'x' + window.innerHeight);
  } catch (_geoErr) {
    dlog('layoutSeasonTwoPane: [GEO] error: ' + (_geoErr as Error).message);
  }

  // 给每集卡片补齐「时长 / 状态」meta（仅限两栏容器内, 防泄漏到首页）
  injectEpisodeMeta(wrap);

  // [lc-893] 右侧信息卡顶边对齐首集卡片(选集可能懒加载, 多延迟重试)
  alignInfoCardWithFirstEpisode();
  setTimeout(alignInfoCardWithFirstEpisode, 300);
  setTimeout(alignInfoCardWithFirstEpisode, 1000);
  // [lc-930] 右栏文字对比度自适应: 建栏后立即跑一次, 并延迟复跑(封面主题染色 / 海报主色可能异步注入,
  //   首次 computed style 还没拿到最终背景色 → 复跑才能采到真实亮度)。
  applySeasonAsideContrast();
  setTimeout(applySeasonAsideContrast, 400);
  setTimeout(applySeasonAsideContrast, 1200);
  // [lc-951] 再补两档: 部分封面主题染色经 <style> 规则异步注入(不触发元素 style 变更),
  //   仅靠 MutationObserver 抓不到, 用更晚的复跑兜底采到最终渐变亮度。
  setTimeout(applySeasonAsideContrast, 2000);
  setTimeout(applySeasonAsideContrast, 3500);
  } finally {
    _seasonLaying = false;
  }
}

/** [lc-903] 演员数据常异步填充 / fnOS 重渲染替换节点, 单次 restyle 可能扑空(节点尚未生成或被换新);
 *  故立即 + 多次延迟重试, 每次都重新定位当前 cast 容器, 确保异步补全后的新节点也被收紧。 */
function scheduleCastRestyle(): void {
  const doRestyle = (): void => { const c = findSeasonCastParent(); if (c) restyleCastItems(c); };
  doRestyle();
  [200, 600, 1200, 2500].forEach((ms) => setTimeout(doRestyle, ms));
}

/** [lc-903] 廉价巡检: 仅当 cast 内仍有未加 fnos-cast-item 类的演员锚点时, 才跑完整 restyle(含递归清零);
 *  全部已处理则直接跳过, 使详情页持续运行的 interval 在稳态下零开销。不依赖任何时机假设, fnOS 何时填充/替换节点都能兜住。 */
function restyleCastOnce(): void {
  const c = findSeasonCastParent();
  if (!c) return;
  restyleCastIfNeeded(c); // [lc-906] 与 observer 共用同一套"有未处理锚点才跑重活"的守卫
  // [lc-923] 行容器可能被 fnOS 重渲染/替换掉(类与内联样式随之丢失), 每次巡检重新打标(幂等, 开销极小)
  applyCastWallLayout(c);
}

/** [lc-923] 演员墙布局：一行多个 + 自动换行。
 *  背景：旧实现把 fnOS 原生的演员横向滚动条强制成 flex-direction:column，结果每个演员独占一整行、
 *        右栏被 10 来个演员拉得极长（用户反馈"每个人都独占一横，竖向排列"）。
 *  定位：纯结构，不读任何标题文本、不猜类名 —— 对每个演员锚点自底向上找「直接子节点中 ≥2 个子节点
 *        各自是/含演员项」的最深容器，即为真正的演员行容器；再把这些子节点打成定宽格 .fnos-cast-cell。
 *  幂等：类标记 + 内联样式，重复调用零副作用（可被 600ms 巡检 / observer 反复调用）。 */
function applyCastWallLayout(container: HTMLElement): void {
  const anchors = Array.from(container.querySelectorAll('a.fnos-cast-item')) as HTMLElement[];
  if (anchors.length < 2) return; // 只有 1 个演员时保持原样(无需成墙)
  const hasCast = (el: Element): boolean =>
    (el as HTMLElement).classList.contains('fnos-cast-item') || el.querySelector('a.fnos-cast-item') !== null;

  const rows: HTMLElement[] = [];
  for (let i = 0; i < anchors.length; i++) {
    let el: HTMLElement | null = anchors[i].parentElement;
    while (el && container.contains(el)) {
      const kids = Array.from(el.children) as HTMLElement[];
      let hit = 0;
      for (let k = 0; k < kids.length; k++) if (hasCast(kids[k])) hit++;
      if (hit >= 2) { if (rows.indexOf(el) < 0) rows.push(el); break; }
      el = el.parentElement;
    }
  }
  if (!rows.length) return;
  rows.forEach((row) => {
    if (!row.classList.contains('fnos-cast-row')) row.classList.add('fnos-cast-row');
    // 行容器：横向 + 自动换行（CSS 已有 !important 兜底，这里再补内联，双保险防 fnOS 深层选择器覆盖）
    row.style.display = 'flex';
    row.style.flexDirection = 'row';
    row.style.flexWrap = 'wrap';
    row.style.alignItems = 'flex-start';
    row.style.width = '100%';
    row.style.maxWidth = '100%';
    row.style.height = 'auto';
    row.style.columnGap = '8px';
    row.style.rowGap = '10px';
    const kids = Array.from(row.children) as HTMLElement[];
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k];
      if (hasCast(kid)) {
        if (!kid.classList.contains('fnos-cast-cell')) kid.classList.add('fnos-cast-cell');
      } else {
        // 非演员节点(分区标题/"查看全部"等): 独占一整行, 不挤占演员格; 完全空的占位(无高度无文本)直接忽略
        const cs = getComputedStyle(kid);
        if (cs.display === 'none') continue;
        if (kid.offsetHeight > 0 || (kid.textContent || '').trim().length > 0) {
          if (!kid.classList.contains('fnos-cast-row-full')) kid.classList.add('fnos-cast-row-full');
        }
      }
    }
  });
}

/** 将 fnOS 原生演职人员项改成「头像 + 姓名/角色」横排
 *  [lc-903+] 演员锚点匹配放宽: 原仅 a[href^="/v/person/"], 若飞牛改了 href 格式会整批漏掉而"完全不生效";
 *  现同时接纳"含头像 <img> 的 <a>"(演员行必有头像), 提高命中率。 */
function restyleCastItems(container: HTMLElement): void {
  const items = Array.from(container.querySelectorAll('a')).filter((a) => {
    const href = a.getAttribute('href') || '';
    return href.includes('/v/person/') || a.querySelector('img') !== null;
  }) as HTMLElement[];
  items.forEach((a) => {
    if (a.classList.contains('fnos-cast-item')) return;
    const ps = Array.from(a.querySelectorAll('p')) as HTMLElement[];
    ps.forEach((p) => { p.classList.remove('w-[120px]', 'truncate'); });
    // [lc-898] 外层 w-[120px] overflow-hidden 才是真正裁切演员文字的元凶: 去掉固定宽度+overflow, 让姓名/角色完整显示
    const wrap = a.parentElement as HTMLElement | null;
    if (wrap) {
      wrap.classList.remove('w-[120px]', 'overflow-hidden');
      wrap.style.width = 'auto';
      wrap.style.minWidth = '120px';
      wrap.style.maxWidth = 'none';
      wrap.style.overflow = 'visible';
      // [lc-901b] 清除 fnOS 原生外边距(每项之间大间隔的来源之一)
      wrap.style.margin = '0';
      wrap.style.padding = '0';
    }
    if (ps.length) {
      const info = document.createElement('div');
      info.className = 'fnos-cast-info';
      ps.forEach((p) => info.appendChild(p));
      a.appendChild(info);
    }
    // [lc-901b] 清除 fnOS 原生链接的块级 margin/padding
    a.style.margin = '0';
    a.style.padding = '0';
    a.classList.add('fnos-cast-item');
  });
  // [lc-902b] 递归强制清零 fnOS 原生各层间距: 中间包装层/ms-container 可能带大 margin/padding/min-height,
  //   普通 CSS !important 可能被 fnOS 更深层(含内联)选择器覆盖, 故遍历所有后代用 inline 兜底。
  //   对纵向 flex 容器(演员项之间的包裹层)设紧凑 gap=2px; 行向 flex(头像-文字横排)不动, 保留 CSS 的 10px。
  const zeroSpacing = (el: HTMLElement): void => {
    el.style.margin = '0';
    el.style.padding = '0';
    el.style.minHeight = '0';
    // [lc-903+] 飞牛可能用固定 height 撑开每项(而非 margin), 需清 height/maxHeight 才能真正收紧;
    //   但跳过"直接含 <img> 的元素"(头像容器需保留 44px 圆形头像, 不能 auto 高度)
    const directImg = Array.from(el.children).some((c) => (c as HTMLElement).tagName === 'IMG');
    if (!directImg) {
      el.style.height = 'auto';
      el.style.maxHeight = 'none';
    }
    const fd = getComputedStyle(el).flexDirection;
    if (fd === 'column' || fd === 'column-reverse') el.style.gap = '2px';
    Array.from(el.children).forEach((c) => zeroSpacing(c as HTMLElement));
  };
  zeroSpacing(container);
  // [lc-923] 最后再排一次版: 把演员行容器改成横向自动换行的"演员墙"(zeroSpacing 里的 gap 内联在此被覆盖)
  applyCastWallLayout(container);
}

/** 给每集卡片补齐「时长 / 状态」meta（幂等，并隐藏 fnOS 原生的时长行避免重复）
 *  [lc-886] root 限定作用域: 仅在传入容器内查询 [data-id="details"],
 *  防止 fnOS SPA 全局 DOM 共存时误匹配首页/其他页面的卡片(导致"高清"泄漏)。 */
function injectEpisodeMeta(root?: HTMLElement): void {
  (root || document).querySelectorAll('[data-id="details"]').forEach((card) => {
    if (card.querySelector('.fnos-ep-meta')) return;
    const a = findCardTitleLink(card);
    let dur = '—';
    if (a) {
      const durP = Array.from(a.querySelectorAll('p')).find((p) =>
        /(\d+)\s*分钟\s*(\d+)\s*秒/.test(p.textContent || '')
      );
      if (durP) { dur = (durP.textContent || '').trim(); durP.style.display = 'none'; }
    }
    const meta = document.createElement('div');
    meta.className = 'fnos-ep-meta';
    meta.innerHTML = `<span class="fnos-ep-duration">${dur}</span><span class="fnos-ep-badge">高清</span>`;
    card.appendChild(meta);
  });
}

/** [lc-893] 把右侧信息卡(.fnos-season-aside)的顶边, 对齐到左侧第一张内容卡片
 *  (.fnos-season-main 内的首个 [data-id="details"] 或 .card-root)的顶边。
 *  fnOS 左侧「选集」等标题会占去一定高度, 导致右侧信息卡比首集卡片高 → 视觉起点不齐。
 *  运行时测量首集卡片相对两栏容器的偏移, 把 aside 的 marginTop 设为该偏移, 抵消标题高度。
 *  [lc-908] 兼容二级页: 首卡回退到 .card-root(季页是 [data-id="details"])。 */
function alignInfoCardWithFirstEpisode(): void {
  const col = document.querySelector('.fnos-season-2col') as HTMLElement | null;
  const aside = document.querySelector('.fnos-season-aside') as HTMLElement | null;
  const main = document.querySelector('.fnos-season-main') as HTMLElement | null;
  if (!col || !aside || !main) return;
  // 优先季页选集卡片, 回退二级页 .card-root
  let firstCard = main.querySelector('[data-id="details"]') as HTMLElement | null;
  if (!firstCard) firstCard = main.querySelector('.card-root') as HTMLElement | null;
  if (!firstCard) return;
  const colTop = col.getBoundingClientRect().top;
  const cardTop = firstCard.getBoundingClientRect().top;
  const offset = Math.max(0, Math.round(cardTop - colTop));
  // [lc-929] ⚠️ 必须同步扣掉高度: aside 的 height 是 100%(网格行高), 只加 marginTop 会让
  //   「margin box」= offset + 100% > 行高 → 右栏底部被 wrap 的 overflow:hidden 裁掉 offset 像素
  //   (用户实测: aside rect.top=561 bottom=1129, vh=1082, 底部超出 47px → 演员墙末行被截断)。
  //   这里把 height/max-height 一并改成 calc(100% - offset), 保证 顶边=offset 且 底边=行高。
  const h = 'calc(100% - ' + offset + 'px)';
  aside.style.setProperty('margin-top', offset + 'px', 'important');
  aside.style.setProperty('height', h, 'important');
  aside.style.setProperty('max-height', h, 'important');
  aside.style.setProperty('min-height', '0', 'important');
  // 左栏同样处理(保持两栏底边齐平; 左栏无对齐偏移, 但仍显式锁 100% 防 fnOS 覆写)
  main.style.setProperty('margin-top', '0px', 'important');
  main.style.setProperty('height', '100%', 'important');
  main.style.setProperty('max-height', '100%', 'important');
  dlog('alignInfoCardWithFirstEpisode: aside marginTop=' + offset + 'px height=' + h + ' (对齐首集卡片顶边并扣高)');
}

/** fnOS SPA 重渲染选集/演职人员时，若两栏被拆散则自动补做 */
function observeSeasonTwoPane(): void {
  if (_season2colObserver) { dlog('observeSeasonTwoPane: 已有observer, 跳过'); return; }
  // [lc-920] 仅季页(/season/)需要两栏 observer; 一级详情页(show 页)不建两栏, 跳过观察器避免无谓开销与误建。
  if (!/\/season\//.test(location.pathname)) {
    dlog('observeSeasonTwoPane: 非季页(一级详情页), 跳过');
    return;
  }
  const ep = findSeasonEpParent();
  // [lc-917] 监听目标改为 document.body: fnOS 路由缓存会把可见页在 --exclude / --cache 两套 outlet 间切换,
  //   原 target=ep.parentElement 可能落在隐藏(缓存)副本, 切换后观察不到可见副本的变更 → 两栏停在隐藏副本不可见。
  //   改监听 body 子树(配合 runObserverWork 的 _obsWorking 自喂抑制 + 指纹稳态退避, 不会卡死), 捕捉 outlet 切换。
  const target: HTMLElement = document.body;
  dlog('observeSeasonTwoPane: ep=' + (ep ? 'found('+ep.tagName+'.'+(ep.className||'').toString().substring(0,40)+')' : 'NULL')
    + ' target=document.body(捕捉 outlet 切换)');
  // [lc-905] 防抖 + [lc-906] 自喂抑制 / 稳态退避:
  //   ⚠️ 真正的卡死根因(lc-905 仅降频未根治): 本 observer 的观察范围(target 子树)就包含我们自建的两栏容器
  //   (.fnos-season-2col 挂在 target 下), 而 runObserverWork 内部又往该容器写 DOM(信息卡 innerHTML)、
  //   递归改写 cast 子树样式 → 每次执行都会产生新的 childList mutation → 立刻再次唤醒自己, 形成
  //   「永不停止的自喂循环」; 叠加单次重活(全文档 querySelectorAll('*') + 整棵子树 getComputedStyle)
  //   → 主线程被持续打满 → 整个软件卡死。
  //   三重修复:
  //   ① 自喂抑制: 执行期间置 _obsWorking, 回调直接忽略; 执行结束 takeRecords() 丢弃自身写入产生的记录。
  //   ② 内容 diff: 信息卡 html 未变不写 DOM; cast 无未处理锚点则跳过整棵子树 restyle(见 lc-906 对应函数)。
  //   ③ 稳态退避: 连续多轮指纹(集数/已处理演员数/两栏存在性)不变 → 判定布局已稳定,
  //      把防抖从 150ms 放宽到 1200ms 并停掉 maxWait 兜底, 稳态下几乎零开销; 指纹一变立即恢复灵敏。
  const OBS_DEBOUNCE = 150;
  const OBS_DEBOUNCE_IDLE = 1200;
  const OBS_DEBOUNCE_THRASH = 2000; // 两栏反复被拆散时的大退避间隔
  const OBS_MAXWAIT = 500;
  const OBS_STABLE_THRESHOLD = 3;
  const OBS_RELAYOUT_THRESHOLD = 4;
  const runObserverWork = (): void => {
    clearSeasonObsTimers();
    _obsWorking = true; // ① 抑制本轮自身 DOM 写入引发的回调
    try {
      const wrap = document.querySelector('.fnos-season-2col');
      const epNow = findSeasonEpParent();
      const castNow = findSeasonCastParent();
      // [lc-907] 演职人员区块在部分二级页可能缺失, 不能再因 castNow 为空就整轮放弃(否则两栏无法维持)
      if (!epNow) return;
      const epInWrap = wrap ? (wrap.querySelector('.fnos-season-main') as HTMLElement | null) : null;
      if (wrap && epInWrap && epInWrap === epNow) {
        _obsRelayoutTicks = 0; // 结构完好 → 解除重建限流
        updateSeasonInfoStats(); // 集数/总时长可能随懒加载补全，刷新即可
        alignInfoCardWithFirstEpisode(); // [lc-893] 首集卡片懒加载后位置可能变动, 重对齐
        if (castNow) restyleCastIfNeeded(castNow); // [lc-906] 仅在存在未处理演员节点时才跑重活
        // [lc-920] 演员数据可能晚于两栏建立才异步填充: 每次稳态巡检都尝试把 cast 移入右栏(已存在则仅 restyle)
        const asideNow = wrap.querySelector('.fnos-season-aside') as HTMLElement | null;
        if (asideNow) ensureCastInAside(asideNow);
        // [lc-927] fnOS SPA 重建可能在原生位置再长出一份演职人员 → 每次稳态巡检顺手清掉(幂等, 无残留时零开销)
        hideNativeCastSections();
        // [lc-928] 同样的兜底: SPA 重建可能让原生页脚也复活, 顺手再清一次
        hideNativeSeasonFooter();
      } else {
        _obsRelayoutTicks++; // [lc-906] 两栏被 fnOS 拆散: 计入重建次数, 频繁则退避, 避免与 fnOS 抢 DOM
        if (wrap) wrap.remove();
        layoutSeasonTwoPane();
      }
      // ③ 指纹: 集数 / 已处理演员数 / 两栏是否已建好 —— 任一项变化说明有真实新内容
      const fp = document.querySelectorAll('[data-id="details"]').length + ':'
        + document.querySelectorAll('.fnos-cast-item').length + ':'
        + (document.querySelector('.fnos-season-2col') ? '1' : '0');
      if (fp === _obsFingerprint) _obsStableTicks++; else { _obsStableTicks = 0; _obsFingerprint = fp; }
    } finally {
      _obsWorking = false;
      // ① 丢弃本轮自身写入产生的积压记录, 彻底切断自喂(外部 fnOS 的新变更仍会在后续触发)
      try { if (_season2colObserver) _season2colObserver.takeRecords(); } catch (_) { /* ignore */ }
    }
  };
  const scheduleObserverWork = (): void => {
    if (_obsWorking) return; // ① 本轮执行中: 一律忽略(均为自身写入所致)
    if (_obsTimer) clearTimeout(_obsTimer);
    const idle = _obsStableTicks >= OBS_STABLE_THRESHOLD;          // 布局已稳定 → 低频巡检
    const thrash = _obsRelayoutTicks >= OBS_RELAYOUT_THRESHOLD;    // 两栏被反复拆散 → 大幅退避
    if (!idle && !thrash && _obsMaxTimer === null) _obsMaxTimer = setTimeout(runObserverWork, OBS_MAXWAIT); // 风暴期兜底
    const delay = thrash ? OBS_DEBOUNCE_THRASH : (idle ? OBS_DEBOUNCE_IDLE : OBS_DEBOUNCE);
    _obsTimer = setTimeout(runObserverWork, delay);
  };
  _season2colObserver = new MutationObserver(() => { scheduleObserverWork(); });
  _season2colObserver.observe(target, { childList: true, subtree: true }); // [lc-903] subtree 捕获深层异步填充的演职人员节点
}

/** 关闭背景框 / 离开季页时还原两栏结构 */
export function unlayoutSeasonTwoPane(): void {
  resetSeasonObsState(); // [lc-906] 离开季页: 清定时器 + 重置稳态判定/年份缓存, 防止页面销毁后误重建两栏
  // [lc-929] 还原被我们隐藏的原生块(页脚/演职残留): fnOS 路由缓存会复用同一批 DOM 节点,
  //   不还原的话一级详情页/首页会缺一大块内容。
  try {
    document.querySelectorAll('[data-fntv-season-footer-hidden],[data-fntv-native-cast-hidden]').forEach((n) => {
      const el = n as HTMLElement;
      el.removeAttribute('data-fntv-season-footer-hidden');
      el.removeAttribute('data-fntv-native-cast-hidden');
      el.style.removeProperty('display');
    });
  } catch (_) { /* ignore */ }
  if (_season2colObserver) { _season2colObserver.disconnect(); _season2colObserver = null; }
  if (_castRestyleTimer) { clearInterval(_castRestyleTimer); _castRestyleTimer = null; } // [lc-903] 停止持续兜底定时器
  _infoCard = null;
  _infoLocalEl = null;
  _infoTmdbEl = null;
  const wrap = document.querySelector('.fnos-season-2col') as HTMLElement | null;
  if (!wrap) return;
  const ep = wrap.querySelector('.fnos-season-main') as HTMLElement | null;
  const aside = wrap.querySelector('.fnos-season-aside') as HTMLElement | null;
  const parent = wrap.parentElement;
  if (ep && parent) { ep.classList.remove('fnos-season-main'); parent.insertBefore(ep, wrap); }
  if (aside && parent) { parent.appendChild(aside); }
  wrap.remove();
  // 清理散落在卡片上的 meta（避免无样式残留）
  document.querySelectorAll('.fnos-ep-meta').forEach((n) => n.remove());
}
function injectImmersiveSeasonStyle(): void {
  if (_immersiveSeasonStyleInjected) return;
  if (  document.getElementById('fnos-immersive-season-style')) { _immersiveSeasonStyleInjected = true; return; }
  const style = document.createElement('style');
  style.id = 'fnos-immersive-season-style';
  let css = IMMERSIVE_SEASON_CSS;
  // [lc-916] 调试描边: 当 localStorage.fntvSeasonLayoutDebug !== '0' 时(默认开),
  //   给两栏关键元素加高对比度 outline, 直接在页面上看到 grid 容器/左栏/右栏的实际位置和尺寸,
  //   无需依赖 DevTools 或 dump 文件即可判断「grid 是否真的分栏渲染」。
  try {
    // [lc-916] 调试描边: 仅当 localStorage.fntvSeasonLayoutDebug === '1' 时才注入(默认关闭, 需手动开启)
    if (localStorage.getItem('fntvSeasonLayoutDebug') === '1') {
      css += `
/* [lc-916 debug outlines] */
.fnos-immersive-season .fnos-season-2col{ outline:3px dashed #ff0000 !important; }
.fnos-immersive-season .fnos-season-main{ outline:3px solid #00ff00 !important; }
.fnos-immersive-season .fnos-season-aside{ outline:3px solid #0088ff !important; background:rgba(0,100,255,.08) !important; }
`;
    }
  } catch (_) { /* ignore */ }
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  _immersiveSeasonStyleInjected = true;
}

/** 对 Season 详情页 (/v/tv/season/:id) 应用沉浸式样式（参照 season-immersive-preview 模板） */
// [lc-910] 诊断: 把详情页真实 DOM 结构 dump 到文件(预加载进程有 Node fs 权限),
// 免去依赖 DevTools Console 手动执行(用户侧 contextIsolation=false 但手动执行易遗漏/不可用)。
// 文件名按 pathname 区分, 轮播页(正常)与二级页(异常)两份都保留, 由 AI 直接读取以精准修复 findSeasonEpParent。
let _lastDiagSig = '';
/** [lc-912] 升级为完整结构树: 除各锚点的祖先链外, 额外输出每层的「兄弟序号 idx / 子节点数 kids」,
 *  可据此精确重建页面分区树(判断选集 section 与其它分区是否同级), 不再靠猜。 */
/** @param stage 传入分阶段标签(如 't0'/'t400')时: 强制写盘且文件名带阶段后缀, 便于对比两栏建立前后 */
function dumpSeasonDOMToFile(stage?: string): void {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const key = (location.pathname || 'x').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').substring(0, 42);
    const outPath = path.join(os.tmpdir(), 'embyWall-diag-' + key + (stage ? '-' + stage : '') + '.json');
    const force = !!stage;
    const q = (s: string): HTMLElement | null => document.querySelector(s) as HTMLElement | null;
    // 祖先链: 每级记 tag / 完整类名 / 子节点数 / 在父节点中的兄弟序号
    const chainOf = (el: HTMLElement | null, depth = 14): any[] => {
      const out: any[] = [];
      let p: HTMLElement | null = el;
      for (let i = 0; i < depth && p && p.tagName !== 'BODY'; i++) {
        const par: HTMLElement | null = p.parentElement;
        out.push({
          tag: p.tagName.toLowerCase(),
          cls: (p.className || p.tagName).toString().substring(0, 160),
          kids: p.childElementCount,
          idx: par ? Array.prototype.indexOf.call(par.children, p) : -1,
        });
        p = par;
      }
      return out;
    };
    // 页面上所有「分区短标题」(叶子节点 / 文本≤12字 / 命中分区关键词)及其祖先链
    const headings: any[] = [];
    for (const el of Array.from(document.querySelectorAll('strong,h2,h3,h4,span,p,div'))) {
      if (headings.length >= 30) break;
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 12) continue;
      if (!/选集|剧集|分集|演职|演员|声优|职员|推荐|相关|相似|喜欢|评论|花絮|详情|简介|Episodes|Cast/i.test(t)) continue;
      headings.push({ text: t, chain: chainOf(el as HTMLElement, 6) });
    }
    const info: any = {
      ts: Date.now(),
      url: location.href,
      pathname: location.pathname,
      bodyClass: document.body.className,
      htmlClass: document.documentElement.className,
      has2col: !!q('.fnos-season-2col'),
      detailsCount: document.querySelectorAll('[data-id="details"]').length,
      cardRootCount: document.querySelectorAll('.card-root').length,
      personLinkCount: document.querySelectorAll('a[href^="/v/person/"]').length,
      epChain: chainOf(findSeasonEpParent()),
      castChain: chainOf(findSeasonCastParent()),
      // [lc-921] 精准结构诊断(无文字匹配): 记录 findSeasonCastParent 命中的路线与 person 链接数,
      //   用于确认"二级页原生演员区"是经「数据驱动的结构抓取」定位, 而非标题文本匹配。
      castDiag: {
        route: _castLastRoute,
        personLinks: document.querySelectorAll('a[href*="/v/person/"]').length,
      },
      // [lc-923] 演员墙诊断: 行容器/格子数量 + 真实 computed + 几何,
      //   用 distinctTops(不同 top 值个数) 与 perRow(每行平均个数) 直接判定是"一行多个"还是"每人独占一整行"。
      wallDiag: (() => {
        const _rows = Array.from(document.querySelectorAll('.fnos-cast-row')) as HTMLElement[];
        const _cells = Array.from(document.querySelectorAll('.fnos-cast-cell')) as HTMLElement[];
        const _items = document.querySelectorAll('.fnos-cast-item').length;
        if (!_rows.length) return { rows: 0, cells: _cells.length, items: _items, note: 'NO_CAST_ROW' };
        const _r = _rows[0];
        const _cs = getComputedStyle(_r);
        const _rr = _r.getBoundingClientRect();
        const tops: number[] = [];
        _cells.forEach((c) => { tops.push(Math.round(c.getBoundingClientRect().top)); });
        const uniqTops = tops.filter((t, i) => tops.indexOf(t) === i);
        const _c0 = _cells.length ? _cells[0].getBoundingClientRect() : null;
        return {
          rows: _rows.length,
          cells: _cells.length,
          items: _items,
          rowCls: (_r.className || '').toString().substring(0, 60),
          rowDisplay: _cs.display,
          rowFlexDir: _cs.flexDirection,
          rowWrap: _cs.flexWrap,
          rowGap: _cs.rowGap + '/' + _cs.columnGap,
          rowRect: { top: Math.round(_rr.top), w: Math.round(_rr.width), h: Math.round(_rr.height) },
          cellW: _c0 ? Math.round(_c0.width) : 0,
          cellH: _c0 ? Math.round(_c0.height) : 0,
          distinctTops: uniqTops.length,
          perRow: uniqTops.length ? Math.round(_cells.length / uniqTops.length) : 0,
        };
      })(),
      twoColChain: chainOf(q('.fnos-season-2col')),
      mainChain: chainOf(q('.fnos-season-main')),
      asideChain: chainOf(q('.fnos-season-aside')),
      details0Chain: chainOf(q('[data-id="details"]')),
      card0Chain: chainOf(q('.card-root')),
      headings,
      // [lc-915] 记录两栏容器真实 computed style + 几何位置, 确认 grid 是否真生效(无需 CMD 日志即可定位根因)
      layoutCSS: (() => {
        const _w = q('.fnos-season-2col') as HTMLElement | null;
        const _styleInjected = !!document.getElementById('fnos-immersive-season-style');
        if (!_w) return { styleInjected: _styleInjected, wrapDisplay: 'NO_2COL' };
        const _cs = getComputedStyle(_w);
        const _m = q('.fnos-season-main') as HTMLElement | null;
        const _a = q('.fnos-season-aside') as HTMLElement | null;
        // [lc-916] 几何: getBoundingClientRect 精确到像素, 判断元素是否在视口内/是否被裁切/是否有实际尺寸
        const _wr = _w.getBoundingClientRect();
        const _mr = _m ? _m.getBoundingClientRect() : null;
        const _ar = _a ? _a.getBoundingClientRect() : null;
        // aside 内容详情: 子节点数 / offsetHeight(0=高度坍塌) / innerHTML 长度 / 首个子节点标签
        const _asideDetail = _a ? {
          childCount: _a.childElementCount,
          offsetHeight: _a.offsetHeight,
          scrollHeight: _a.scrollHeight,
          innerHTMLLen: _a.innerHTML.length,
          firstChildTag: _a.firstElementChild ? _a.firstElementChild.tagName : null,
          firstChildCls: _a.firstElementChild ? (_a.firstElementChild.className || '').toString().substring(0, 60) : null,
          bgCs: getComputedStyle(_a).backgroundColor,
          colorCs: getComputedStyle(_a).color,
        } : null;
        return {
          styleInjected: _styleInjected,
          wrapDisplay: _cs.display,
          wrapGridCols: _cs.gridTemplateColumns,
          wrapWidth: _cs.width,
          mainDisplay: _m ? getComputedStyle(_m).display : null,
          asideDisplay: _a ? getComputedStyle(_a).display : null,
          inlineDisplay: _w.style.display || '(空)',
          // [lc-916] 几何数据
          wrapRect: { top: Math.round(_wr.top), left: Math.round(_wr.left), w: Math.round(_wr.width), h: Math.round(_wr.height) },
          mainRect: _mr ? { top: Math.round(_mr.top), left: Math.round(_mr.left), w: Math.round(_mr.width), h: Math.round(_mr.height) } : null,
          asideRect: _ar ? { top: Math.round(_ar.top), left: Math.round(_ar.left), w: Math.round(_ar.width), h: Math.round(_ar.height) } : null,
          asideDetail: _asideDetail,
        };
      })(),
    };
    const sig = [info.url, info.detailsCount, info.cardRootCount, info.has2col, info.personLinkCount].join('|');
    if (force || sig !== _lastDiagSig) {
      _lastDiagSig = sig;
      fs.writeFileSync(outPath, JSON.stringify(info, null, 2), 'utf8');
      log('[DIAG-FILE] wrote ' + outPath + ' path=' + location.pathname + ' details=' + info.detailsCount
        + ' cards=' + info.cardRootCount + ' persons=' + info.personLinkCount + ' 2col=' + info.has2col);
    }
  } catch (e) {
    log('[DIAG-FILE] error ' + (e as Error).message);
  }
}

export function applySeasonImmersiveDetail(): void {
  // [lc-929] document.body 可能为 null(document-start / 导航切换瞬间) →
  //   下面第一行就读 document.body.className, 曾抛 "Cannot read properties of null (reading 'className')"
  //   (embyWall.js:6708) 导致整条沉浸式链路中断、两栏不再建立。必须先挡住。
  if (!document.body) { dlog('applySeasonImmersiveDetail: ⚠️ document.body 尚不存在, 跳过'); return; }
  dlog('applySeasonImmersiveDetail: === 入口 === pathname=' + location.pathname
    + ' S.detailBoxless=' + S.detailBoxless
    + ' body.cls=' + (document.body.className||'').toString().substring(0,80));
  injectImmersiveSeasonStyle();
  if (S.detailBoxless) {
    document.body.classList.remove('fnos-immersive-season');
    unlayoutSeasonTwoPane(); // 还原两栏结构
    return;
  }
  document.body.classList.add('fnos-immersive-season');
  dlog('applySeasonImmersiveDetail: body已加 fnos-immersive-season, 当前body.cls='
    + (document.body.className||'').toString().substring(0,100));
  // [lc-909] 诊断(仅前 3 次): 详细 dump「选集」标题及其祖先链/兄弟结构, 真机实测反馈时定位"两栏为何没建立"
  if (_seasonDiagCount < 3) {
    _seasonDiagCount++;
    try {
      const details = document.querySelectorAll('[data-id="details"]').length;
      const cards = document.querySelectorAll('.card-root').length;
      // 找"选集/剧集"标题
      let selHeading: HTMLElement | null = null;
      for (const h of Array.from(document.querySelectorAll('strong,h2,h3,h4,p,span,div'))) {
        const t = (h.textContent || '').trim();
        if (/^选集$|^剧集$|^分集$|episodes?$/i.test(t)) { selHeading = h as HTMLElement; break; }
      }
      let info = 'url=' + location.pathname + ' | details=' + details + ' cardRoot=' + cards;
      if (selHeading) {
        const txt = (selHeading.textContent || '').trim();
        let chain: string[] = [];
        let p = selHeading;
        for (let i = 0; i < 7 && p; i++) { chain.push((p.className || '').toString().substring(0, 36) || p.tagName.toLowerCase()); p = p.parentElement as HTMLElement; }
        info += ' | sel="' + txt + '" chain=' + chain.join(' < ');
        let sib = selHeading.nextElementSibling as HTMLElement | null;
        if (sib) {
          info += ' | sibClass=' + ((sib.className || '').toString().substring(0, 50)) + ' sibKids=' + sib.children.length;
          const gc = sib.children[0] as HTMLElement;
          if (gc) info += ' | sibKid0=' + ((gc.className || '').toString().substring(0, 50)) + ' kid0Href=' + (gc.getAttribute('href') || '');
        } else { info += ' | NO_NEXT_SIBLING'; }
      } else { info += ' | NO_SEL_HEADING'; }
      const ep = findSeasonEpParent();
      info += ' | epResult=' + (ep ? (ep.className || '').toString().substring(0, 40) : 'NULL');
      log('[DIAG-SEASON] ' + info);
    } catch (_) { /* ignore */ }
  }
  // [lc-921] 仅季页(/season/)建两栏; 一级详情页(show 页 /v/tv/<32hex>, 不含 /season/)保持 fnOS 原生外观(不建两栏、不变分栏)。
  //   此前仅 layoutSeasonTwoPane 内部有护栏, 但 SPA 切换残留 / observer 误触发仍可能把两栏建进一级页,
  //   故在此统一拦截: 一级页清理任何可能残留/误建的两栏并断开 observer, 仅季页才进入建栏流程。
  if (!/\/season\//.test(location.pathname)) {
    dlog('applySeasonImmersiveDetail: [一级详情页] 不建两栏, 清理残留并 return');
    unlayoutSeasonTwoPane(); // 还原任何残留两栏 + 断开 observer, 保证一级页回归原生单栏
    // 仍保留沉浸式背景框(用户未反对背景框, 仅反对分栏); 不调用 observeSeasonTwoPane 避免误建两栏。
    return;
  }
  // [lc-908] 立即尝试建立两栏; 二级页 DOM 可能异步渲染, 首次 findSeasonEpParent 可能返回 null → 延迟重试
  layoutSeasonTwoPane();
  if (!document.querySelector('.fnos-season-2col')) {
    // 两栏未建立 → 二级页 DOM 可能还没渲染完, 延迟重试(覆盖 fnOS 懒加载/异步填充)
    [400, 1000, 2000, 3500].forEach((ms) => setTimeout(() => {
      if (!document.querySelector('.fnos-season-2col') && document.body.classList.contains('fnos-immersive-season')) {
        layoutSeasonTwoPane();
      }
    }, ms));
  }
  observeSeasonTwoPane();         // fnOS SPA 重建时自动补做两栏
  // [lc-910] 自动 dump 真实 DOM 到临时文件(按 pathname 分文件), 供 AI 直接读取定位 findSeasonEpParent 问题
  // [lc-912] 分阶段强制 dump: t0(首次) / t400 / t1000 / t2000 / t3500 / t6000(稳态), 便于对比两栏建立前后
  const stages: Array<[number, string]> = [[0, 't0'], [550, 't400'], [1150, 't1000'], [2150, 't2000'], [3650, 't3500'], [6000, 't6000']];
  stages.forEach(([ms, tag]) => {
    if (ms === 0) dumpSeasonDOMToFile(tag);
    else setTimeout(() => dumpSeasonDOMToFile(tag), ms);
  });
}function applySeasonDetailGlass(): void {
  // ₀ 原生导航栏沉浸: 全透明+无模糊, 不遮挡背景剧照
  const seasonNav = document.querySelector('div.relative.z-20.flex.items-center.justify-between.px-11.py-5') as HTMLElement | null;
  if (seasonNav) {
    seasonNav.style.setProperty('background', 'transparent', 'important');
    seasonNav.style.setProperty('backdrop-filter', 'none', 'important');
    seasonNav.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    seasonNav.style.setProperty('box-shadow', 'none', 'important');
    seasonNav.style.setProperty('border', 'none', 'important');
  }

  // ① 头部信息区 (470px高, 含模糊背景+海报+标题)
  const header = safeSelect<HTMLElement>('.semi-always-dark');
  if (!header) {
    // fallback: 用高度和模糊背景图来定位
    const headers = document.querySelectorAll('.semi-always-dark');
    for (const h of Array.from(headers)) {
      const el = h as HTMLElement;
      if (el.offsetHeight > 350 && el.querySelector('img[alt][style*="blur"]')) {
        return applySeasonGlassToHeader(el);
      }
    }
    return;
  }
  applySeasonGlassToHeader(header);
}

function applySeasonGlassToHeader(header: HTMLElement): void {
  log('applySeasonDetailGlass: header found, height=', header.offsetHeight);

  // 背景模糊图增强: 更柔和的液态感
  const blurImg = header.querySelector('img[style*="blur"]') as HTMLImageElement | null;
  if (blurImg) {
    blurImg.style.setProperty('filter', 'blur(18px) saturate(120%) brightness(.85)', 'important');
    blurImg.style.setProperty('transform', 'scale(1.08)', 'important');
  }

  // 海报卡片: 液态玻璃立体效果
  const poster = header.querySelector('.rounded-xl.overflow-hidden, .overflow-hidden.rounded-xl') as HTMLElement | null;
  if (poster) {
    poster.style.setProperty('border-radius', '18px', 'important');
    poster.style.setProperty('box-shadow',
      '0 10px 40px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.1)',
      'important');
    poster.style.setProperty('transition', 'transform .35s cubic-bezier(.16,1,.3,1), box-shadow .35s ease', 'important');
    poster.addEventListener('mouseenter', () => {
      poster.style.setProperty('transform', 'translateY(-6px) scale(1.03)', 'important');
      poster.style.setProperty('box-shadow',
        '0 20px 56px rgba(0,0,0,.32),0 0 0 1px rgba(255,255,255,.3),inset 0 0 0 1px rgba(255,255,255,.15)',
        'important');
    });
    poster.addEventListener('mouseleave', () => {
      poster.style.removeProperty('transform');
      poster.style.setProperty('box-shadow',
        '0 10px 40px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.1)',
        'important');
    });
  }

  // 底部渐变: 液态玻璃融合
  const gradientFull = header.querySelector('.gradient-for-full') as HTMLElement | null;
  if (gradientFull) {
    gradientFull.style.setProperty('background',
      'var(--fnos-detail-season-grad)', 'important');
    gradientFull.style.setProperty('backdrop-filter', 'blur(36px) saturate(170%) brightness(1.04)', 'important');
    gradientFull.style.setProperty('-webkit-backdrop-filter', 'blur(36px) saturate(170%) brightness(1.04)', 'important');
  }

  // 标题文字发光
  const h2 = header.querySelector('h2') as HTMLElement | null;
  if (h2) {
    h2.style.setProperty('text-shadow',
      '0 2px 24px rgba(255,255,255,.35),0 0 48px rgba(91,140,255,.18)', 'important');
  }

  // ② 选集区标题栏: 玻璃标签（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const sections = document.querySelectorAll('strong');
  sections.forEach(s => {
    if (s.textContent === '选集' || s.textContent === '演职人员') {
      const wrap = s.parentElement;
      if (wrap) {
        const w = wrap as HTMLElement;
        if (S.detailBoxless) {
          // 关闭背景框：移除注入的玻璃标签样式，回退到 fnOS 原生标题栏
          w.style.removeProperty('background');
          w.style.removeProperty('backdrop-filter');
          w.style.removeProperty('-webkit-backdrop-filter');
          w.style.removeProperty('border-radius');
          w.style.removeProperty('border');
          w.style.removeProperty('box-shadow');
          w.style.removeProperty('padding');
        } else {
          w.style.setProperty('background',
            'var(--fnos-detail-season-sec)', 'important');
          w.style.setProperty('backdrop-filter', 'blur(8px) saturate(120%)', 'important');
          w.style.setProperty('-webkit-backdrop-filter', 'blur(8px) saturate(120%)', 'important');
          w.style.setProperty('border-radius', '10px', 'important');
          w.style.setProperty('border', '1px solid var(--fnos-detail-season-sec-border)', 'important');
          w.style.setProperty('box-shadow',
            'none',
            'important');
          w.style.setProperty('padding', '6px 16px', 'important');
        }
      }
    }
  });

  // ③ 集数卡片网格: 液态玻璃卡片（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const episodeCards = document.querySelectorAll('[data-id="details"]');
  episodeCards.forEach((card) => {
    const el = card as HTMLElement;
    if (S.detailBoxless) {
      // 关闭背景框：移除注入的玻璃卡片样式，回退到 fnOS 原生卡片
      el.style.removeProperty('background');
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('border');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('transition');
      el.style.removeProperty('transform');
      return;
    }
    el.style.setProperty('background',
      'var(--fnos-detail-ep)', 'important');
    el.style.setProperty('backdrop-filter', 'blur(22px) saturate(145%)', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'blur(22px) saturate(145%)', 'important');
    el.style.setProperty('border-radius', '16px', 'important');
    el.style.setProperty('border', '1px solid var(--fnos-detail-ep-border)', 'important');
    el.style.setProperty('box-shadow',
      'var(--fnos-detail-shadow-2)',
      'important');
    el.style.setProperty('transition', 'transform .28s ease, box-shadow .28s ease', 'important');

    el.addEventListener('mouseenter', () => {
      if (S.detailBoxless) return; // 关闭背景框时悬停不再加玻璃阴影
      el.style.setProperty('transform', 'translateY(-5px) scale(1.025)', 'important');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-3)',
        'important');
    });
    el.addEventListener('mouseleave', () => {
      if (S.detailBoxless) return;
      el.style.removeProperty('transform');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-2)',
        'important');
    });
  });

  // ④ 整体内容滚动区背景: 极淡雾面
  const scrollArea = document.querySelector('.trim-ui__scrollbar--list-specific') as HTMLElement | null;
  if (scrollArea) {
    scrollArea.style.setProperty('background',
      'var(--fnos-detail-scroll)', 'important');
  }

  // ⑤ 原生播放按钮: 半透明白底(适配浅色/透明详情页背景, 保证可辨识度)
  const seasonPlayBtns = document.querySelectorAll('button[class*="primary"], .semi-button--primary, [class*="btn-primary"], a[class*="play"]');
  for (const btn of Array.from(seasonPlayBtns)) {
    const el = btn as HTMLElement;
    if (el.classList.contains('fnos-play')) continue;
    el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
    el.style.setProperty('border', '1px solid rgba(255,255,255,.35)', 'important');
    el.style.setProperty('border-radius', '10px', 'important');
    el.style.setProperty('color', '#333', 'important');
    el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    el.style.setProperty('font-weight', '500', 'important');
    el.addEventListener('mouseenter', () => {
      if (!el.dataset.glassHover) { el.dataset.glassHover = '1';
        el.style.setProperty('background', 'rgba(255,255,255,.75)', 'important');
        el.style.setProperty('border-color', 'rgba(255,255,255,.5)', 'important');
        el.style.setProperty('box-shadow', '0 2px 10px rgba(0,0,0,.12)', 'important');
      }
    }, { once: false });
    el.addEventListener('mouseleave', () => {
      delete el.dataset.glassHover;
      el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
      el.style.setProperty('border-color', 'rgba(255,255,255,.35)', 'important');
      el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    }, { once: false });
  }

  // ⑥ 补齐缺失的集简介（真实数据来源：Bangumi 每集 desc）
  //    飞牛 /episode/list 仅第1集返回 overview（复制自父级简介），第2集起 overview 为空 → 卡片只剩时长。
  //    飞牛单集详情接口 item/{guid} 也无简介数据（已验证）。
  //    改用 Bangumi /v0/episodes 的 desc 字段（每集剧情简介，日文原文，丰富且准确），
  //    通过主进程 bangumiSync.fetchEpisodeDescs 获取，本地 JSON 缓存持久化（重启不丢、不重复请求）。
  fillEpisodeDescsFromBangumi();
}

/** 同 season 只触发一次取数，避免重复网络请求 */
const _epDescDone = new Set<string>();

/**
 * ⑥ 选集卡片缺失简介补齐（Bangumi 真实每集 desc，不伪造）。
 * 数据流：页面番名 → IPC 'bangumi:episode-descs' → 主进程搜 Bangumi subject → 取 episodes desc → 本地缓存 → 回填卡片。
 * 首次网络取后缓存到 userData/bangumi_ep_descs.json（持久化），后续同番直接读缓存。
 */
function fillEpisodeDescsFromBangumi(): void {
  const m = location.href.match(/\/season\/([a-f0-9]{32})/) || location.href.match(/\/tv\/([a-f0-9]{32})/);
  const parentGuid = m && m[1];
  if (!parentGuid) return;
  if (_epDescDone.has(parentGuid)) return;

  const cards = Array.from(document.querySelectorAll('[data-id="details"]')) as HTMLElement[];
  if (cards.length <= 1) return; // 单集/骨架态无需补齐
  _epDescDone.add(parentGuid);

  // 从页面头部提取番剧标题（用于 Bangumi 搜索匹配）
  const pageTitle = (() => {
    // 尝试从 h1 / 标题区提取
    const h1 = document.querySelector('h1, [class*="title"], [class*="header"]');
    if (h1) {
      const t = h1.textContent?.trim() || '';
      // 去掉可能的季数后缀用于搜索（如 "第三季" → 更好匹配 Bangumi 条目）
      return t.replace(/\s*(第?[一二三四五六七八九十\d]+季|Season\s*\d+|S\d+)\s*$/i, '').trim();
    }
    // fallback: 从 <title> 提取
    return (document.title || '').split('-')[0]?.trim() || '';
  })();

  if (!pageTitle) return;

  // 解析卡片标题里的集数（第N集 / ENN / SxxENN / 第N话 / EP.N）
  const parseEp = (text: string): number | null => {
    if (!text) return null;
    let mm = text.match(/第\s*(\d+)\s*[集话話]/);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/S\d+E(\d+)/i);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/\bE(\d{1,3})\b/i);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/EP?\.?\s*(\d{1,3})/i);
    if (mm) return parseInt(mm[1], 10);
    return null;
  };

  // 取卡片内最长的简介文本（排除"第N集"标题与"XX分钟XX秒"时长）
  const walkText = (el: HTMLElement): string => {
    let longest = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent?.trim() || '';
        if (t.length > longest.length && t.length > 20 && !/^\d+分钟\d+秒$/.test(t) && !/^第\d+集$/.test(t)) {
          longest = t;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const sub = walkText(child as HTMLElement);
        if (sub.length > longest.length) longest = sub;
      }
    }
    return longest;
  };

  (async () => {
    try {
      const { ipcRenderer } = require('electron');
      // 调主进程 Bangumi 每集简介接口（带缓存，首次网络取后持久化）
      const result: any = await ipcRenderer.invoke('bangumi:episode-descs', pageTitle, cards.length);
      if (!result || !result.eps || result.eps.length === 0) return;

      const descByEp = new Map<number, string>();
      for (const e of result.eps) {
        if (e.desc) descByEp.set(e.ep, e.desc);
      }
      if (descByEp.size === 0) return; // Bangumi 无该番简介数据

      // 按集数回填到对应缺简介的卡片
      const descStyle = 'font-size:13px;line-height:1.7;color:var(--fnos-text-secondary,#9aa0a6);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:4px;letter-spacing:.25px';
      let filled = 0;
      for (const card of cards) {
        const ep = parseEp(card.textContent || '');
        if (ep == null) continue;
        const desc = descByEp.get(ep);
        if (!desc) continue;
        if (walkText(card).length > 20) continue; // 已有简介
        if (card.querySelector('.fnos-ep-desc-filled')) continue; // 已填过
        const descEl = document.createElement('div');
        descEl.className = 'fnos-ep-desc-filled fnos-ep-info';
        descEl.textContent = desc;
        const right = card.querySelector(':scope > .fnos-ep-right') as HTMLElement | null;
        if (right) {
          right.appendChild(descEl);
          right.style.display = 'flex'; // 之前可能为空被收起，补信息后展开
        } else {
          descEl.style.cssText = descStyle; // 非沉浸式（无右栏）走原样式
          card.appendChild(descEl);
        }
        filled++;
      }
      if (filled) log('fillEpisodeDescsFromBangumi: 回填 Bangumi 简介', filled, '张卡片 (subject', result.subjectId, ')');
    } catch (e) {
      log('fillEpisodeDescsFromBangumi error', e);
    }
  })();
}

/** [lc-906] 最近一次处理的详情页 URL: 用于识别"换了另一个详情页", 从而重置 observer 稳态判定。
 *  ⚠️ 不能在每次 applyDetailLiquidGlass 调用时重置 —— 它被 _detailObs 以 200ms 防抖持续调用,
 *  无条件重置会让稳态退避永远无法生效。 */

/** [lc-907] 详情页导航栏沉浸: 全透明 + 去模糊/阴影/边框, 让全屏底图在页面顶部完整透出。
 *  原先只有 tv/movie 二级页做(applyTvDetailGlass ₀), 季页没有 → 两套页面顶部观感不一致;
 *  现在统一处理, 与「全部统一为第一种 + 保留全屏底图」配套。 */