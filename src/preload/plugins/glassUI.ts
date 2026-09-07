// preload/plugins/glassUI.ts
//
// [lc-525] 云母增强 / Glass UI 插件 —— 对齐 DSH-Transparent-UI-Plugin 的 CSS 玻璃拟态方案
// =============================================================================
// 设计目标（用户决策）：
//   - 路线 B：纯 CSS 玻璃拟态（backdrop-filter + 半透明卡片 + 底层 ambient 容器），
//     非 Windows 原生 Mica；全平台（fnOS/Linux、Windows、macOS）一致生效。
//   - 完整对齐 DSH：组件磨砂 + 背景层（流体动态）+ 设置面板独立控件。
//   - 默认关闭；非侵入接入（不动 embyWall.ts 现有机制，仅往"外观"分区锚点后挂控件）。
//
// 接入方式：
//   - preload/index.ts 自动 require 本目录所有 .js → 编译后即自动挂入。
//   - 模块顶层 registerHook(OnReady) 注册（遵循 preload 模块级铁律：注册须在可能抛错代码之前）。
//   - 门控：给 <html> 加 data-fntv-glass 属性才生效；关闭即移除属性 + 销毁背景层 → 原生 UI 一字不动还原。
//
// 作用域纪律（沿用 mainwin.ts 亚克力约定）：
//   - 所有玻璃规则限定在 .fnos-tv-page 下，系统页（文件管理/设置等）不玻璃化，避免缩略图/容器变黑框。
//   - 模态框（semi-modal / dialog）保持不透明、可读，不被玻璃化。

import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { ipcRenderer } from 'electron';

const LOG = '[GlassUI]';

// ── 持久化键（localStorage，沿用 fnos-glass-* 命名风格，与现有亚克力滑块一致）──
const K = {
  enabled: 'fntvGlass.enabled',
  mode: 'fntvGlass.mode',          // 'mica' | 'compat' | 'custom'
  tint: 'fntvGlass.tint',          // 自定义色调 hex（mode=custom 时生效）
  blur: 'fntvGlass.blur',          // px
  frost: 'fntvGlass.frost',        // 0..1 玻璃不透明度
  sat: 'fntvGlass.sat',            // 饱和度 %
  bright: 'fntvGlass.bright',      // 背景亮度 %
  bg: 'fntvGlass.bg',              // 'none' | 'fluid'
  fluidSpeed: 'fntvGlass.fluidSpeed', // 流体动画速度倍率(>1 更快, <1 更慢)
  particles: 'fntvGlass.particles',// '0' | '1'
  border: 'fntvGlass.border',      // '0' | '1' 玻璃边框
  borderAlpha: 'fntvGlass.borderAlpha', // 0..1 边框浓度
  shadow: 'fntvGlass.shadow',      // 0..1 阴影浓度
  noise: 'fntvGlass.noise',        // '0' | '1' 磨砂噪点
  vignette: 'fntvGlass.vignette',  // '0' | '1' 背景暗角
};

// ── 默认值 ──
// [lc-1012] 材质重做后默认值同步调整：blur 14→18、frost .5→.42(光泽渐变替代平涂白)、
// sat 140→150、shadow .14→.22(更大更软)、noise 默认开(真 Acrylic 的表面颗粒签名)。
const DEF = {
  enabled: true, // [lc-1019] 默认开启云母增强（出厂即开；用户可在设置面板关闭）
  mode: 'mica',
  tint: '#faf8fc',
  blur: 18,
  frost: 0.42,
  sat: 150,
  bright: 100,
  bg: 'fluid',
  // [lc-1026] fluidSpeed 已随漂移动画移除（K.fluidSpeed 仅供 migrateSchema 清旧值）
  particles: false,
  border: true,
  borderAlpha: 0.2,
  shadow: 0.22,
  noise: true,
  vignette: false,
};

// [lc-1012] 视觉参数 schema：v2 材质重做后, 旧版保存的视觉参数(平涂白/彩虹流体/无噪点)
// 会让新材质失效 → 首次升到 v2 时清空视觉键重derive新默认, 仅保留「启用」开关状态。
// [lc-1081] schema 升到 v3：3.6.0 出厂默认云母增强为开。存量用户即便之前关过
// （localStorage 残留 fntvGlass.enabled="0"），更新后也强制回落到 DEF.enabled=true，
// 规避「代码默认开却被旧 localStorage 值覆盖」的坑。一次性迁移，用户之后手动关会正常持久化。
const SCHEMA = 3;
const K_SCHEMA = 'fntvGlass.schema';
function migrateSchema(): void {
  try {
    const cur = parseInt(localStorage.getItem(K_SCHEMA) || '1', 10) || 1;
    if (cur >= SCHEMA) return;
    const visualKeys = [K.mode, K.tint, K.blur, K.frost, K.sat, K.bright, K.bg,
      K.fluidSpeed, K.border, K.borderAlpha, K.shadow, K.noise, K.vignette];
    for (const k of visualKeys) localStorage.removeItem(k);
    localStorage.setItem(K_SCHEMA, String(SCHEMA));
  } catch { /* ignore */ }
}

function getStr(k: string, d: string): string {
  try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; }
}
function getNum(k: string, d: number): number {
  try { const v = localStorage.getItem(k); if (v === null) return d; const n = parseFloat(v); return isNaN(n) ? d : n; } catch { return d; }
}
function getBool(k: string, d: boolean): boolean {
  try { const v = localStorage.getItem(k); if (v === null) return d; return v === '1' || v === 'true'; } catch { return d; }
}
function setStr(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// [lc-1099] 性能模式总闸: perf 开启期间云母增强强制关闭(不写 K.enabled, 关 perf 即按原值恢复)。
//   localStorage 镜像兜底启动竞态: embyWall handle() 同步预读挂类在前, 但本模块 OnReady 顺序不保证。
function perfOn(): boolean {
  if (document.documentElement.classList.contains('fnos-perf')) return true;
  try { return localStorage.getItem('fntv-perf-mode') === '1'; } catch { return false; }
}

// ── 读取全部设置 ──
interface GlassSettings {
  enabled: boolean; mode: string; tint: string; blur: number; frost: number; sat: number;
  bright: number; bg: string; particles: boolean;
  border: boolean; borderAlpha: number; shadow: number; noise: boolean; vignette: boolean;
}
function readSettings(): GlassSettings {
  return {
    enabled: getBool(K.enabled, DEF.enabled),
    mode: getStr(K.mode, DEF.mode),
    tint: getStr(K.tint, DEF.tint),
    blur: getNum(K.blur, DEF.blur),
    frost: getNum(K.frost, DEF.frost),
    sat: getNum(K.sat, DEF.sat),
    bright: getNum(K.bright, DEF.bright),
    bg: getStr(K.bg, DEF.bg),
    particles: getBool(K.particles, DEF.particles),
    border: getBool(K.border, DEF.border),
    borderAlpha: getNum(K.borderAlpha, DEF.borderAlpha),
    shadow: getNum(K.shadow, DEF.shadow),
    noise: getBool(K.noise, DEF.noise),
    vignette: getBool(K.vignette, DEF.vignette),
  };
}

// ── 门控样式（一次注入，仅在 html[data-fntv-glass] 时生效）──
// 使用 rgba(var(--fntv-glass-tint-r/g/b), alpha) 而非 color-mix，兼容更广的 Electron/Chromium。
//
// [lc-1012] 材质重做（用户反馈「太假了而且不美观」）。参照市面最佳实践重写：
//   · Windows 11 真 Mica/Acrylic（Fluent 2）：低饱和环境色调 + 表面噪点(≈3%) + 亮度分层，
//     绝无彩虹渐变/描边线圈/漂浮粒子这类「假玻璃」元素；
//   · Linear / Arc / Raycast 的面板材质：无均匀边框，用「顶缘 1px 高光 + inset 玻璃厚度环
//     + 大软阴影」表达悬浮厚度；玻璃本体 = tint + 165deg 亮度光泽渐变。
//   · 流体背景 → 环境光(Ambient)背景：三团低饱和 radial 色域 + 极慢漂移缩放，明暗两套色板。
const GATE_CSS = `
  /* 玻璃底色 + 环境光色板：跟随 fnOS 主题(html.dark)双套 ——
     Windows Mica 本就分深浅两套材质, 深色主题铺白磨砂是发灰的根源。 */
  html[data-fntv-glass] {
    --fntv-glass-tint-r: 249;
    --fntv-glass-tint-g: 250;
    --fntv-glass-tint-b: 253;
    --fntv-glass-sheen-1: .10;
    --fntv-glass-sheen-2: .028;
    --fntv-amb-base: #eef0f7;
    /* [lc-1026] 拆 rgb/alpha 分量：底座挪到 body 背景后不能再挂 filter（见 ①c），
       「背景亮度」滑杆改为直接缩放色域 alpha（对深底=等效压暗/提亮）。 */
    --fntv-amb-1-rgb: 178 158 232; --fntv-amb-1-a: .40;
    --fntv-amb-2-rgb: 148 196 236; --fntv-amb-2-a: .36;
    --fntv-amb-3-rgb: 186 222 206; --fntv-amb-3-a: .32;
  }
  html.dark[data-fntv-glass] {
    --fntv-glass-tint-r: 28;
    --fntv-glass-tint-g: 30;
    --fntv-glass-tint-b: 42;
    --fntv-glass-sheen-1: .05;
    --fntv-glass-sheen-2: .012;
    --fntv-amb-base: #0d0d15;
    --fntv-amb-1-rgb: 118 84 218; --fntv-amb-1-a: .50;
    --fntv-amb-2-rgb: 26 106 188; --fntv-amb-2-a: .46;
    --fntv-amb-3-rgb: 18 126 112; --fntv-amb-3-a: .36;
  }
  /* Compat 模式：明暗主题都强制深灰玻璃 */
  html[data-fntv-glass][data-fntv-glass-mode="compat"] {
    --fntv-glass-tint-r: 28;
    --fntv-glass-tint-g: 30;
    --fntv-glass-tint-b: 42;
    --fntv-glass-sheen-1: .05;
    --fntv-glass-sheen-2: .012;
  }

  /* ① 接管页面根容器：关闭整窗亚克力（改由组件级磨砂），透明让背景层/桌面透出。
     ⚠ [lc-1012] 作用域事实：.fnos-tv-page 由 embyWall.ts:98 打在 <html> 上,
        故旧写法 html[data-fntv-glass] .fnos-tv-page(后代关系)结构性永不匹配 ——
        这正是云母增强此前"什么都没生效"的根因之一。一律用复合选择器。
     body 一并清掉：mainwin 的 body 亚克力(半透+backdrop-filter)在玻璃模式下
        被环境光层盖住不可见, 但 GPU 仍在持续为它做全窗模糊(纯浪费)。 */
  /* ① 接管页面根容器：关闭整窗亚克力（改由组件级磨砂）。
     [lc-1026] html 拆成独立一条且**不再纯透明**：CSS 规定 html 背景为纯透明时
     body 背景会**传播到画布**（画布恒方形、不受圆角/clip-path 裁剪 → lc-1025
     四角白边正是这么来的）；rgba(...,0.003) 非纯透明即阻断传播，视觉不可感知。 */
  html[data-fntv-glass].fnos-tv-page {
    background: rgba(255, 255, 255, 0.003) !important;
    background-color: rgba(255, 255, 255, 0.003) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  html[data-fntv-glass].fnos-tv-page body {
    background: transparent !important;
    background-color: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  /* ①a 页面级不透明容器透明化：fnOS 主内容容器的 bg-[var(--semi-color-bg-1)](rgb 25,25,26)
     会整块盖死背景层 → 组件磨砂采到的永远是这层死黑。玻璃模式下清掉页面级底色 token,
     让环境光/桌面真正透出（卡片/海报内部的 bg-hover/bg-placeholder 半透覆盖层不受影响）。
     ⚠ 匹配串必须是 "bg-[var(--semi-color-bg-1)" —— 类名是 bg-[var(--semi-color-bg-1)]，
       此前写成 ...bg-1] 少了右括号导致 0 命中(lc-1012 预览实测)。 */
  html[data-fntv-glass].fnos-tv-page [class*="bg-[var(--semi-color-bg-1)"],
  html[data-fntv-glass].fnos-tv-page [class*="bg-[var(--semi-color-bg-0)"] {
    background-color: transparent !important;
  }

  /* ①b 玻璃模式下顶区全透：标题栏安全区(32px)内所有元素/根容器/#root/#app 全部透明，
     否则 fnOS 自身顶栏底色会露出来导致"最上面一条颜色不匹配" [lc-541] */
  html[data-fntv-glass].fnos-tv-page #root,
  html[data-fntv-glass].fnos-tv-page #app,
  html[data-fntv-glass].fnos-tv-page body > div,
  html[data-fntv-glass].fnos-tv-page body > nav,
  html[data-fntv-glass].fnos-tv-page body > header,
  html[data-fntv-glass].fnos-tv-page body > section {
    background: transparent !important;
    background-color: transparent !important;
  }

  /* ①c [lc-1026] 环境光底座 v3 —— 画在 **body 背景**上，彻底弃用独立合成层。
     用户三轮报障「经常全透、强制刷新才恢复」（lc-1023/1025 两次修复后真机依旧）：
     z-index:-1 的 #fntv-glass-bg 是独立合成层，透明窗口 + GPU 合成下偶发整层不画，
     强刷重建层树后才恢复（普通浏览器从未复现 → 之前两次修复都只压对了 GC 一半）。
     body 背景走主流水线 phase-3 作画：不占合成层调度、不随导航增删层而被丢弃、
     body 本身永不卸载 → 结构上不可能全透。代价：氛围色域改静态——漂移动画需
     transform 合成层 = 回到失效面，弃用（漂移速度滑杆一并移除）。
     四角：body 自带 border-radius:16px(mainwin ②) + html clip-path 裁剪，且 html
     0.003 底(见 ①)阻断 body→画布传播，无 lc-1025 白边回归。
     「背景层: 无」(bg=none) 时不匹配本条，body 保持透明 = 透桌面语义。 */
  html[data-fntv-glass][data-fntv-glass-bg="fluid"].fnos-tv-page body {
    background:
      radial-gradient(42vmax 42vmax at 16% 10%, rgb(var(--fntv-amb-1-rgb) / calc(var(--fntv-amb-1-a) * var(--fntv-glass-bright, 1))) 0%, transparent 62%),
      radial-gradient(38vmax 38vmax at 84% 18%, rgb(var(--fntv-amb-2-rgb) / calc(var(--fntv-amb-2-a) * var(--fntv-glass-bright, 1))) 0%, transparent 60%),
      radial-gradient(48vmax 48vmax at 52% 92%, rgb(var(--fntv-amb-3-rgb) / calc(var(--fntv-amb-3-a) * var(--fntv-glass-bright, 1))) 0%, transparent 65%),
      var(--fntv-amb-base, #eef0f7) !important;
  }

  /* ② 组件级玻璃：卡片/面板/控制栏 浮在背景层上做磨砂
     关键：每个选择器带 :not() 排除顶栏(data-fnos-clear 锚点)，从源头避免误伤。
     lc-526~530 教训：事后排除规则 !important 对抗不稳定，改用 :not() 让选择器根本不匹配顶栏区域 */
  html[data-fntv-glass].fnos-tv-page [class*="card"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="Card"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="panel"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="Panel"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="playbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="control-bar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="ControlBar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="navbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="topbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="appbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="search"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page [class*="Search"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page header:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]),
  html[data-fntv-glass].fnos-tv-page nav:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]):not([data-fntv-glass-exclude]) {
    /* [lc-1012] 材质 = tint 底 + 165deg 亮度光泽渐变(顶缘受光)。
       厚度感不画均匀描边，用三层 box-shadow：inset 玻璃厚度环(随边框开关/浓度) +
       顶缘 1px 高光 + 大软阴影(负扩散半径, Linear/Arc 式悬浮)。 */
    background-color: rgba(var(--fntv-glass-tint-r), var(--fntv-glass-tint-g), var(--fntv-glass-tint-b), var(--fntv-glass-frost, 0.42)) !important;
    background-image: linear-gradient(165deg,
      rgba(255, 255, 255, var(--fntv-glass-sheen-1, .05)) 0%,
      rgba(255, 255, 255, calc(var(--fntv-glass-sheen-1, .05) * .3)) 42%,
      rgba(255, 255, 255, var(--fntv-glass-sheen-2, .012)) 100%) !important;
    backdrop-filter: blur(var(--fntv-glass-blur, 18px)) saturate(var(--fntv-glass-sat, 150%)) !important;
    -webkit-backdrop-filter: blur(var(--fntv-glass-blur, 18px)) saturate(var(--fntv-glass-sat, 150%)) !important;
    border: none !important;
    box-shadow:
      inset 0 0 0 calc(var(--fntv-glass-border, 1) * 1px) rgba(255, 255, 255, calc(var(--fntv-glass-border, 1) * var(--fntv-glass-border-alpha, 0.2) * .9)),
      inset 0 1px 0 rgba(255, 255, 255, calc(var(--fntv-glass-frost, 0.42) * .3)),
      0 16px 40px -8px rgba(0, 0, 0, var(--fntv-glass-shadow, 0.22)) !important;
  }

  /* ②b [lc-1042] 首页海报行底部留空位（用户报障：云母下剧集卡片底部阴影「粘连」）。
     实测：海报行 .ms-container 为 overflow-y:hidden 且容器高=卡片高(294=294)、卡片外边距 0，
     本 ② 规则给每张卡的 0 16px 40px 软阴影在行底被硬裁成一条黑带，与下一行标题粘连；
     「继续观看」行(continue-card-root)天然有 12px 底部余量所以观感正常 —— 用户要求照它留空。
     修=玻璃模式下给含卡片库/海报卡的行补 padding-bottom（overflow 裁剪边界=padding 盒，
     阴影完整着落 + 行间自然空位）；继续观看行与详情页演员区(无 card-root)不受影响。
     :not(:has(.continue-card-root)) 把 substring 命中 continue-card-root 的那行排除。 */
  html[data-fntv-glass].fnos-tv-page div.ms-container:has([class*="card-root"]):not(:has(.continue-card-root)){
    padding-bottom: 24px !important;
  }

  /* ②c [lc-1052] 每日放送浮层（hotUpdates 宫灯 #fntv-hot-tab + 面板 #fntv-hot-panel）玻璃适配。
     用户报障：云母增强下点开每日放送，多处全透文字难辨。两处根因：
     ① 宫灯/面板都挂在 body 顶层 → ①b 的 body>div 把它们的样式表背景清成透明（面板原生
        rgba(24,26,34,.92)/浅色 rgba(255,255,255,.94)、宫灯渐变全部失效）；
     ② 面板内列表项类名 .fntv-hot-card 含 "card" → ② 逐卡磨砂（frost .42 过透 + 每卡一个
        backdrop-filter 合成层，GPU 白耗）。
     浮层是文字密集弹窗，按本插件「模态浮层保持不透明可读」纪律：玻璃模式下恢复其原生
     高不透明背景（亮暗双套跟 .fntv-hot-light），卡片恢复原生透明底 + hover 反馈。
     注：①b 的 background 简写把 background-position 也钉成 !important，动画打不过
     important 声明 → 宫灯渐变流光在玻璃下静止（视觉仍在，仅不再流动），可接受。 */
  html[data-fntv-glass].fnos-tv-page #fntv-hot-tab {
    background-image: linear-gradient(135deg, #ff6b35, #f7418f, #c94bcb) !important;
    background-color: #f7418f !important;
    background-size: 200% 200% !important;
    background-position: 0% 50% !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-tab:hover {
    background-image: linear-gradient(135deg, #ff8c5a, #f76aa3, #d96bd6) !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-panel {
    background-color: rgba(24, 26, 34, .96) !important;
    background-image: none !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-panel.fntv-hot-light {
    background-color: rgba(255, 255, 255, .96) !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-panel .fntv-hot-card {
    background-color: transparent !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    box-shadow: none !important;
    border: 1px solid transparent !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-panel .fntv-hot-card:hover {
    background-color: rgba(255, 255, 255, .09) !important;
    border-color: rgba(255, 107, 53, .22) !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .20) !important;
  }
  html[data-fntv-glass].fnos-tv-page #fntv-hot-panel.fntv-hot-light .fntv-hot-card:hover {
    background-color: rgba(0, 0, 0, .05) !important;
    border-color: rgba(255, 107, 53, .30) !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .12) !important;
  }

  /* [lc-1012] 旧「浅色模式白磨砂特例」已删：tint/环境光/sheen 全部跟随 html.dark 双套自适应,
     一套规则覆盖明暗两主题（浅色 = 白玻璃, 深色 = 深玻璃）。 */

  /* ③ 背景层 / 粒子层：固定铺满、置于内容之下（z-index:-1）
     [lc-1025] 四角必须跟随窗口 16px 圆角：这些层几何上都是全窗方形，若不圆角，
     弧外四角会露出层本色（玻璃暗角/噪点颗粒/粒子点）。html 的 clip-path 会裁
     普通流与 fixed 后代，但底色画在层上就该自己圆角，不依赖那份兜底。 */
  /* ③ [lc-1026] 粒子层：从 z:-1 提到 z:2 —— body 已承载不透明环境底（主流水线作画，
     见 ①c），z:-1 独立合成层整条路径弃用；粒子浮在内容之上、pointer-events:none
     不拦交互，z:2 低于 fnOS 顶栏/弹窗的 z-10/z-20。 */
  #fntv-glass-particles {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 2 !important;
    pointer-events: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 16px !important;
  }

  /* ④ [lc-1012] 噪点 → 表面颗粒：旧版铺在 z:-1（在卡片后方，被卡片自己的
     backdrop-filter 模糊掉，等于没生效）。真 Acrylic 的噪点是「材质表面」的，
     故铺在内容之上的全屏颗粒层(pointer-events:none, 2.6%, overlay 混合)：
     平面处给材质颗粒感, 文字/海报上 2.6% 不可感知。 */
  #fntv-glass-noise {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 2147482900 !important;
    pointer-events: none !important;
    border-radius: 16px !important; /* [lc-1025] 四角随窗口圆角，颗粒不铺到弧外 */
    opacity: 0.026 !important;
    mix-blend-mode: overlay !important;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") !important;
    background-size: 160px 160px !important;
    display: none !important;
  }
  html[data-fntv-glass][data-fntv-glass-noise="1"] #fntv-glass-noise {
    display: block !important;
  }

  /* ⑤ 背景层暗角：增强层次（仅玻璃开启 + 显式开启时）。
     [lc-1026] 从 #fntv-glass-bg::after 挪到 body::before（bg 层已删，见 ①c）。
     fixed+无 z-index=定位元素 phase-6 作画：在 body 底之上、非定位内容之上、
     fnOS 的 z-10/z-20 顶栏与弹窗之下；暗角压的是画面边缘，盖内容边缘符合预期。 */
  html[data-fntv-glass][data-fntv-glass-vignette="1"].fnos-tv-page body::before {
    content: "" !important;
    position: fixed !important;
    inset: 0 !important;
    z-index: 5 !important;
    pointer-events: none !important;
    border-radius: 16px !important;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.38) 100%) !important;
  }

  /* ═══ 排除规则：顶部导航/标题栏区域完全透明化 ═══ */
  /* 顶栏容器本身：fnOS 透明模式下标记 data-fnos-clear="1"（class 形如 relative z-[2] h-[80px] bg-[var(--semi-color-bg-1)]） */
  html[data-fntv-glass].fnos-tv-page [data-fnos-clear="1"],
  /* 顶栏所有祖先容器（含真正承载玻璃效果的 card/panel 包裹层）：用 :has 不限层级命中 */
  html[data-fntv-glass].fnos-tv-page :has([data-fnos-clear="1"]),
  /* 兜底：含顶栏 z-20/z-10 的容器与祖先（z-20 在更深层的内层 div，不限层级命中） */
  html[data-fntv-glass].fnos-tv-page [class*="z-20"],
  html[data-fntv-glass].fnos-tv-page [class*="z-10"],
  html[data-fntv-glass].fnos-tv-page :has([class*="z-20"]),
  html[data-fntv-glass].fnos-tv-page :has([class*="z-10"]),
  /* 语义标签排除 */
  html[data-fntv-glass].fnos-tv-page header,
  html[data-fntv-glass].fnos-tv-page nav,
  html[data-fntv-glass].fnos-tv-page [class*="navbar"],
  html[data-fntv-glass].fnos-tv-page [class*="topbar"],
  html[data-fntv-glass].fnos-tv-page [class*="appbar"],
  html[data-fntv-glass].fnos-tv-page [class*="header-bar"],
  html[data-fntv-glass].fnos-tv-page [class*="nav-bar"],
  html[data-fntv-glass].fnos-tv-page [class*="page-header"],
  html[data-fntv-glass].fnos-tv-page [class*="toolbar"],
  html[data-fntv-glass].fnos-tv-page [class*="list-head"],
  /* 上述所有目标统一归零 */
  {
    background: transparent !important;
    background-color: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border: none !important;
    border-top: none !important;
    border-bottom: none !important;
    box-shadow: none !important;
    outline: none !important;
  }
`;

// ── 运行时引用 ──
let styleEl: HTMLStyleElement | null = null;
let noiseEl: HTMLElement | null = null;
let particleCanvas: HTMLCanvasElement | null = null;
let particleRAF = 0;

// ── hex 色调 → rgb ──
function tintToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || DEF.tint).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (isNaN(n)) return { r: 250, g: 248, b: 252 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ── 检测页面是否为浅色主题（驱动 data-fntv-glass-is-light）──
// [lc-1012] 改判 html.dark（fnOS 主题总开关）：旧法读 .fnos-tv-page 背景色，
//   但玻璃模式开启后该容器已被 ① 规则清成透明 → 恒判深色, 检测失效。
function detectLightMode(): boolean {
  try {
    return !document.documentElement.classList.contains('dark');
  } catch (_) { return false; }
}

// ── [lc-1026] 背景底座已改为纯 CSS（body 背景，见 GATE_CSS ①c）——
// 不再有任何 JS 创建/销毁的背景节点：旧 #fntv-glass-bg 独立合成层在真机透明窗口上
// 偶发整层不画（用户三轮报障「经常全透、强刷才恢复」），整条作画路径弃用。

// ── 噪点层（创建一次，display 由 data 属性控制）──
function ensureNoiseLayer(): void {
  if (noiseEl) return;
  const el = document.createElement('div');
  el.id = 'fntv-glass-noise';
  (document.body || document.documentElement).appendChild(el);
  noiseEl = el;
}

// ── 粒子层（轻量 rAF，文档隐藏时暂停）──
interface P { x: number; y: number; r: number; vx: number; vy: number; a: number; }
let particles: P[] = [];
function startParticles(): void {
  if (particleCanvas) return;
  const cv = document.createElement('canvas');
  cv.id = 'fntv-glass-particles';
  (document.body || document.documentElement).appendChild(cv);
  particleCanvas = cv;
  resizeParticleCanvas();
  window.addEventListener('resize', resizeParticleCanvas);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const count = Math.min(70, Math.floor((cv.width * cv.height) / 26000));
  particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      r: 1 + Math.random() * 2.4,
      vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
      a: 0.15 + Math.random() * 0.35,
    });
  }
  const tick = (): void => {
    if (!particleCanvas || !ctx) return;
    if (document.hidden) { particleRAF = requestAnimationFrame(tick); return; }
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > cv.width) p.vx *= -1;
      if (p.y < 0 || p.y > cv.height) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${p.a})`;
      ctx.fill();
    }
    particleRAF = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(particleRAF);
  particleRAF = requestAnimationFrame(tick);
}
function resizeParticleCanvas(): void {
  if (!particleCanvas) return;
  particleCanvas.width = window.innerWidth;
  particleCanvas.height = window.innerHeight;
}
function stopParticles(): void {
  cancelAnimationFrame(particleRAF);
  window.removeEventListener('resize', resizeParticleCanvas);
  if (particleCanvas && particleCanvas.parentElement) particleCanvas.parentElement.removeChild(particleCanvas);
  particleCanvas = null;
  particles = [];
}

// ── JS 兜底：直接置空顶栏祖先行内样式（优先级高于所有 CSS !important）──
//    同时给 data-fnos-clear 容器的所有后代打 data-fntv-glass-exclude 标记，
//    防止规则 ② 命中内部子元素（如导航栏行"飞牛影视"区域），避免该行单独浮出。
function neutralizeTopBar(): void {
  try {
    const bar = document.querySelector('[data-fnos-clear="1"]') as HTMLElement | null;
    if (!bar) return;
    // 顶栏本身
    bar.style.setProperty('background', 'transparent', 'important');
    bar.style.setProperty('background-color', 'transparent', 'important');
    bar.style.setProperty('backdrop-filter', 'none', 'important');
    bar.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    bar.style.setProperty('border', 'none', 'important');
    bar.style.setProperty('box-shadow', 'none', 'important');
    // 向上追溯所有祖先，强制归零（覆盖 mainwin.ts insertCSS + 玻璃规则）
    // [lc-1094] 走到 body/html 前即停：①c 起 **body 背景本身就是环境光底座**、html 是
    //   rgba(255,255,255,.003) 传播阻断层，二者的底色都由本样式表用 !important 画。
    //   行内 !important 优先级高于任何作者样式表 → 一旦把 body 行内涂成 transparent，
    //   底座整块消失，transparent 窗口下就是"桌面直接透出"(用户报障: 开机全透、强刷才好)。
    //   真机链路实测: 顶栏容器在 #root 内第 4 级 → body=第5、html=第6，旧 depth<10 预算必然走到。
    let el: Element | null = bar.parentElement;
    let depth = 0;
    while (el && depth < 10 && el !== document.body && el !== document.documentElement) {
      const h = el as HTMLElement;
      h.style.setProperty('background', 'transparent', 'important');
      h.style.setProperty('background-color', 'transparent', 'important');
      h.style.setProperty('backdrop-filter', 'none', 'important');
      h.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
      h.style.setProperty('border', 'none', 'important');
      h.style.setProperty('box-shadow', 'none', 'important');
      el = el.parentElement;
      depth++;
    }
    // 给顶栏容器所有后代打排除标记 → 规则 ② :not([data-fntv-glass-exclude]) 跳过
    const descendants = bar.querySelectorAll('*') as NodeListOf<HTMLElement>;
    descendants.forEach((d) => { d.setAttribute('data-fntv-glass-exclude', ''); });
    bar.setAttribute('data-fntv-glass-exclude', ''); // 自身也标记
  } catch (_) { /* silent */ }
}

// ── 调试：定位顶栏玻璃容器 ──
function debugTopAncestry(): void {
  try {
    const page = document.querySelector('.fnos-tv-page');
    if (!page) { console.log('[GLASS-DEBUG] .fnos-tv-page not found'); return; }
    const nav = page.querySelector('[data-fnos-clear="1"]') as HTMLElement | null;
    console.log('[GLASS-DEBUG] top bar (data-fnos-clear):', nav ? nav.className : 'NOT FOUND');
    if (nav) {
      let el: Element | null = nav;
      let depth = 0;
      while (el && el !== page && depth < 12) {
        const cs = getComputedStyle(el);
        const glassy = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
          || cs.borderTopWidth !== '0px' || cs.borderBottomWidth !== '0px'
          || (cs.boxShadow && cs.boxShadow !== 'none')
          || cs.backdropFilter !== 'none';
        console.log(`[GLASS-DEBUG] L${depth}`, (el.tagName || '').toLowerCase(), '| class=', (el.className || '').slice(0, 90),
          '| bg=', cs.backgroundColor, '| borderT/B=', cs.borderTopWidth + '/' + cs.borderBottomWidth,
          '| shadow=', (cs.boxShadow || '').slice(0, 30), '| bf=', cs.backdropFilter, glassy ? ' <-- 可能带玻璃' : '');
        el = el.parentElement;
        depth++;
      }
    }
  } catch (err) {
    console.error('[GLASS-DEBUG] error', err);
  }
}

// ── 应用：把设置落到 DOM（门控属性 + CSS 变量 + 背景层/粒子）──
function applyGlass(): void {
  try {
    const s = readSettings();
    // [lc-1099] perf 开启期间强制关闭(摘属性即 GATE_CSS 全失配, 不与其高特异性 !important 对抗)
    const effEnabled = s.enabled && !perfOn();
    const root = document.documentElement;

    // 写 CSS 变量
    root.style.setProperty('--fntv-glass-blur', s.blur + 'px');
    root.style.setProperty('--fntv-glass-frost', String(s.frost));
    root.style.setProperty('--fntv-glass-sat', s.sat + '%');

    // 玻璃色调：mica=浅冷白 / compat=深灰 / custom=自定义颜色
    let tr = 250, tg = 248, tb = 252;
    if (s.mode === 'compat') { tr = 34; tg = 38; tb = 47; }
    else if (s.mode === 'custom') { const t = tintToRgb(s.tint); tr = t.r; tg = t.g; tb = t.b; }
    root.style.setProperty('--fntv-glass-tint-r', String(tr));
    root.style.setProperty('--fntv-glass-tint-g', String(tg));
    root.style.setProperty('--fntv-glass-tint-b', String(tb));

    // 边框 / 阴影浓度
    root.style.setProperty('--fntv-glass-border', s.border ? '1' : '0');
    root.style.setProperty('--fntv-glass-border-alpha', String(s.borderAlpha));
    root.style.setProperty('--fntv-glass-shadow', String(s.shadow));

    // [lc-1025→1026] 背景亮度：驱动 body 环境底的色域 alpha（见 GATE_CSS ①c）。
    // （漂移动画已随独立合成层一并移除，--fntv-glass-fluid-speed 不再使用）
    root.style.setProperty('--fntv-glass-bright', String(s.bright / 100));

    // 浅色模式检测：取 .fnos-tv-page 或 body 的背景亮度，亮底时自动弱化边框+阴影（避免"画线"感）
    const isLight = detectLightMode();
    root.setAttribute('data-fntv-glass-is-light', isLight ? '1' : '0');

    if (effEnabled) {
      root.setAttribute('data-fntv-glass', '');
      root.setAttribute('data-fntv-glass-mode', s.mode);
      // [lc-1023] 底座开关随背景源：fluid=html 铺不透明环境底(①c)，none=保留透桌面
      root.setAttribute('data-fntv-glass-bg', s.bg === 'none' ? 'none' : 'fluid');
      root.setAttribute('data-fntv-glass-noise', s.noise ? '1' : '0');
      root.setAttribute('data-fntv-glass-vignette', s.vignette ? '1' : '0');
      ensureNoiseLayer();
      if (s.particles) startParticles(); else stopParticles();
      // [lc-1026] 诊断锚点：真机再出「全透」时，控制台按此行确认 applyGlass 是否跑过、
      // 以及 html[data-fntv-glass-bg] 属性在不在——区分「状态没应用」与「合成层没画」。
      console.info(LOG, 'applied: mode=' + s.mode + ' bg=' + s.bg + ' root[' + effEnabled + ']');
      // JS 兜底：强制清空顶栏祖先样式（行内 > CSS !important，覆盖 mainwin.ts insertCSS）
      neutralizeTopBar();
      setTimeout(neutralizeTopBar, 800);
      setTimeout(neutralizeTopBar, 2000);
      debugTopAncestry();
      setTimeout(debugTopAncestry, 1800);
    } else {
      root.removeAttribute('data-fntv-glass');
      root.removeAttribute('data-fntv-glass-mode');
      root.removeAttribute('data-fntv-glass-bg');
      root.removeAttribute('data-fntv-glass-is-light');
      root.removeAttribute('data-fntv-glass-noise');
      root.removeAttribute('data-fntv-glass-vignette');
      stopParticles();
    }
  } catch (err) {
    console.error(LOG, 'applyGlass failed', err);
  }
}

// ════════════════════════════════════════════════════════════════
//  设置面板控件注入（非侵入：挂在 #fnos-appearance-ctrl 之后）
// ════════════════════════════════════════════════════════════════
let settingsInjected = false;

// [lc-1099] 云母块提示文案: perf 开启期间云母被总闸强制关闭, 文案需解释开关为何「看似开着却没效果」
let glassHintEl: HTMLElement | null = null;
const GLASS_HINT_NORMAL = '提示：切换开启后，请回到首页点击左上角的「刷新」按钮刷新一遍，效果才能正确应用。';
const GLASS_HINT_PERF = '性能模式已开启：云母增强暂时强制关闭（你的开关设置已保留），关闭性能模式后自动恢复。';
function updatePerfHint(): void {
  if (glassHintEl) glassHintEl.textContent = perfOn() ? GLASS_HINT_PERF : GLASS_HINT_NORMAL;
}

function mkToggle(): { wrap: HTMLElement; input: HTMLInputElement; track: HTMLElement; knob: HTMLElement } {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;flex-shrink:0;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
  const track = document.createElement('span');
  track.style.cssText = 'position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;';
  const knob = document.createElement('span');
  knob.style.cssText = 'position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);';
  wrap.appendChild(input); wrap.appendChild(track); wrap.appendChild(knob);
  return { wrap, input, track, knob };
}
function paintToggle(t: { input: HTMLInputElement; track: HTMLElement; knob: HTMLElement }, on: boolean): void {
  t.track.style.background = on ? 'var(--fnos-ui-accent, #4a90d9)' : 'rgba(140,140,160,.45)';
  t.knob.style.left = on ? '21.5px' : '2.5px';
}

function row(labelText: string, control: HTMLElement, gap = '12px 0 8px'): HTMLElement {
  const r = document.createElement('div');
  r.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin:${gap};`;
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = labelText;
  r.appendChild(label);
  r.appendChild(control);
  return r;
}
function rangeRow(labelText: string, min: number, max: number, step: number, val: number, unit: string,
                   onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px 0 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = labelText;
  const valEl = document.createElement('span');
  valEl.style.cssText = 'opacity:.85;';
  valEl.textContent = val + unit;
  head.appendChild(label); head.appendChild(valEl);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(val);
  input.style.cssText = 'width:100%;accent-color:var(--fnos-ui-accent,#4a90d9);cursor:pointer;margin-top:6px;';
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valEl.textContent = v + unit;
    onChange(v);
  });
  wrap.appendChild(head); wrap.appendChild(input);
  return wrap;
}
function selectRow(labelText: string, options: { value: string; label: string }[], current: string,
                   onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px 0 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = labelText;
  head.appendChild(label);
  const sel = document.createElement('select');
  sel.style.cssText = 'font-size:11px;color:var(--fnos-ui-text,#222);background:var(--fnos-ui-input-bg,rgba(255,255,255,.12));'
    + 'border:1px solid var(--fnos-ui-border,rgba(255,255,255,.2));border-radius:7px;padding:5px 8px;cursor:pointer;';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  head.appendChild(sel);
  wrap.appendChild(head);
  return wrap;
}
function textRow(labelText: string, placeholder: string, value: string, onCommit: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px 0 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = labelText;
  head.appendChild(label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text,#222);'
    + 'background:var(--fnos-ui-input-bg,rgba(255,255,255,.12));border:1px solid var(--fnos-ui-border,rgba(255,255,255,.2));'
    + 'border-radius:7px;padding:6px 8px;box-sizing:border-box;';
  input.addEventListener('change', () => onCommit(input.value.trim()));
  wrap.appendChild(head); wrap.appendChild(input);
  return wrap;
}

function colorRow(labelText: string, value: string, onCommit: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px 0 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = labelText;
  head.appendChild(label);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.style.cssText = 'width:44px;height:28px;border:1px solid var(--fnos-ui-border,rgba(255,255,255,.2));border-radius:7px;background:none;cursor:pointer;padding:2px;';
  input.addEventListener('input', () => onCommit(input.value));
  wrap.appendChild(head); wrap.appendChild(input);
  return wrap;
}

// ── 设置面板控件 ──
function buildGlassControls(): HTMLElement {
  const block = document.createElement('div');
  block.id = 'fntv-glass-ctrl';
  block.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--fnos-ui-border,rgba(255,255,255,.18));display:flex;flex-direction:column;';

  const s = readSettings();

  // 标题
  const title = document.createElement('div');
  title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:.5px;margin-bottom:4px;color:var(--fnos-ui-text,#222);';
  title.textContent = '云母增强（Glass UI）';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub,#888);line-height:1.5;margin-bottom:8px;';
  sub.textContent = '组件磨砂玻璃 + 环境光背景（低饱和氛围色域，Win11 Mica / Linear 式材质）。默认开启。';
  block.appendChild(title); block.appendChild(sub);

  // 总开关
  const tog = mkToggle();
  paintToggle(tog, s.enabled);
  tog.input.checked = s.enabled;
  tog.input.addEventListener('change', () => {
    setStr(K.enabled, tog.input.checked ? '1' : '0');
    paintToggle(tog, tog.input.checked);
    applyGlass();
  });
  block.appendChild(row('启用云母增强', tog.wrap));

  // 启用提示标记（[用户要求] 开启后需回首页点左上角刷新按钮刷新一次才能正确应用；[lc-1099] perf 期间换强制关闭文案）
  glassHintEl = document.createElement('div');
  glassHintEl.style.cssText = 'margin:2px 0 6px;padding:7px 10px;border-radius:8px;font-size:11px;line-height:1.55;'
    + 'color:var(--fnos-ui-warning,#b07a00);background:color-mix(in srgb, var(--fnos-ui-warning,#b07a00) 12%, transparent);'
    + 'border:1px solid color-mix(in srgb, var(--fnos-ui-warning,#b07a00) 30%, transparent);';
  updatePerfHint();
  block.appendChild(glassHintEl);

  // [lc-818] 云母增强的具体组件设置默认折叠：点击折叠头展开/收起，默认收起
  const foldHead = document.createElement('div');
  foldHead.style.cssText = 'display:flex;align-items:center;gap:6px;margin:8px 0 2px;cursor:pointer;user-select:none;'
    + 'font-size:12px;font-weight:600;color:var(--fnos-ui-text,#222);';
  const foldCaret = document.createElement('span');
  foldCaret.textContent = '▶';
  foldCaret.style.cssText = 'display:inline-block;transition:transform .15s;font-size:10px;';
  const foldLabel = document.createElement('span');
  foldLabel.textContent = '组件细节设置';
  foldHead.appendChild(foldCaret);
  foldHead.appendChild(foldLabel);
  const foldBody = document.createElement('div');
  foldBody.style.cssText = 'display:none;flex-direction:column;';
  foldHead.addEventListener('click', () => {
    const collapsed = foldBody.style.display === 'none';
    foldBody.style.display = collapsed ? 'flex' : 'none';
    foldCaret.style.transform = collapsed ? 'rotate(90deg)' : 'rotate(0deg)';
  });
  block.appendChild(foldHead);
  block.appendChild(foldBody);

  // [lc-818] 以下具体组件设置全部收入折叠区 foldBody（默认收起）
  // 模式
  foldBody.appendChild(selectRow('玻璃模式', [
    { value: 'mica', label: 'Mica（浅冷白）' },
    { value: 'compat', label: 'Compat（深灰低透）' },
    { value: 'custom', label: '自定义颜色' },
  ], s.mode, (v) => { setStr(K.mode, v); applyGlass(); refreshModeDepFields(); }));

  // 玻璃色调（仅自定义模式显示）
  const tintRow = colorRow('玻璃色调', s.tint, (v) => { setStr(K.tint, v); applyGlass(); });
  foldBody.appendChild(tintRow);

  // 背景源（仅保留 无 / 环境光）
  foldBody.appendChild(selectRow('背景层', [
    { value: 'none', label: '无（透桌面）' },
    { value: 'fluid', label: '环境光' },
  ], s.bg, (v) => { setStr(K.bg, v); applyGlass(); }));

  // 模糊 / 磨砂 / 饱和度 / 亮度 / 边框 / 阴影
  foldBody.appendChild(rangeRow('组件模糊', 0, 40, 1, s.blur, 'px', (v) => { setStr(K.blur, String(v)); applyGlass(); }));
  foldBody.appendChild(rangeRow('玻璃浓度', 0, 100, 1, Math.round(s.frost * 100), '%', (v) => { setStr(K.frost, String(v / 100)); applyGlass(); }));
  foldBody.appendChild(rangeRow('饱和度', 100, 200, 1, s.sat, '%', (v) => { setStr(K.sat, String(v)); applyGlass(); }));
  // [lc-1026] 「漂移速度」滑杆已随漂移动画移除；「背景亮度」现驱动环境底色域 alpha
  foldBody.appendChild(rangeRow('背景亮度', 40, 160, 1, s.bright, '%', (v) => { setStr(K.bright, String(v)); applyGlass(); }));

  // 边框 / 阴影（控制"廉价感"的关键）
  const borderTog = mkToggle();
  paintToggle(borderTog, s.border);
  borderTog.input.checked = s.border;
  borderTog.input.addEventListener('change', () => {
    setStr(K.border, borderTog.input.checked ? '1' : '0');
    paintToggle(borderTog, borderTog.input.checked);
    applyGlass();
  });
  foldBody.appendChild(row('玻璃边框', borderTog.wrap));
  foldBody.appendChild(rangeRow('边框浓度', 0, 100, 1, Math.round(s.borderAlpha * 100), '%', (v) => { setStr(K.borderAlpha, String(v / 100)); applyGlass(); }));
  foldBody.appendChild(rangeRow('阴影浓度', 0, 100, 1, Math.round(s.shadow * 100), '%', (v) => { setStr(K.shadow, String(v / 100)); applyGlass(); }));

  // 磨砂噪点 / 暗角（提升质感）
  const noiseTog = mkToggle();
  paintToggle(noiseTog, s.noise);
  noiseTog.input.checked = s.noise;
  noiseTog.input.addEventListener('change', () => {
    setStr(K.noise, noiseTog.input.checked ? '1' : '0');
    paintToggle(noiseTog, noiseTog.input.checked);
    applyGlass();
  });
  foldBody.appendChild(row('磨砂噪点', noiseTog.wrap));
  const vigTog = mkToggle();
  paintToggle(vigTog, s.vignette);
  vigTog.input.checked = s.vignette;
  vigTog.input.addEventListener('change', () => {
    setStr(K.vignette, vigTog.input.checked ? '1' : '0');
    paintToggle(vigTog, vigTog.input.checked);
    applyGlass();
  });
  foldBody.appendChild(row('背景暗角', vigTog.wrap));

  // 粒子效果
  const particleTog = mkToggle();
  paintToggle(particleTog, s.particles);
  particleTog.input.checked = s.particles;
  particleTog.input.addEventListener('change', () => {
    setStr(K.particles, particleTog.input.checked ? '1' : '0');
    paintToggle(particleTog, particleTog.input.checked);
    applyGlass();
  });
  foldBody.appendChild(row('粒子效果', particleTog.wrap));

  // 显隐依赖字段（函数声明，提升，供上方 change 回调安全引用）
  function refreshModeDepFields(): void {
    const cur = readSettings().mode;
    tintRow.style.display = cur === 'custom' ? '' : 'none';
  }
  refreshModeDepFields();

  return block;
}

function tryInjectSettings(): boolean {
  const anchor = document.getElementById('fnos-appearance-ctrl');
  if (!anchor) return false;
  const parent = anchor.parentElement;
  if (!parent) return false;
  // 锚点存在但控件缺失（设置面板被 SPA 重建）→ 重新注入，保证控件持久
  if (parent.querySelector('#fntv-glass-ctrl')) { settingsInjected = true; return true; }
  const block = buildGlassControls();
  parent.appendChild(block);
  settingsInjected = true;
  return true;
}

// 周期性兜底：即使 MutationObserver 已断开，也能在面板重建后补回控件（极廉价：两次 DOM 查询）
function startKeepAlive(): void {
  setInterval(() => { try { tryInjectSettings(); } catch { /* ignore */ } }, 4000);
}

// ════════════════════════════════════════════════════════════════
//  OnReady 入口（模块顶层注册，遵循 preload 模块级铁律）
// ════════════════════════════════════════════════════════════════
function handle(): void {
  try {
    migrateSchema();
    // 1) 注入门控样式（始终存在，仅 data-fntv-glass 时生效）
    styleEl = document.createElement('style');
    styleEl.id = 'fntv-glass-style';
    styleEl.textContent = GATE_CSS;
    (document.head || document.documentElement).appendChild(styleEl);

    // 2) 应用已保存设置（默认关闭 → 不表现）
    applyGlass();

    // 3) 注入设置面板控件（#fnos-appearance-ctrl 可能尚未构建，用 MutationObserver 兜底）
    if (!tryInjectSettings()) {
      const target = document.body || document.documentElement;
      const obs = new MutationObserver(() => {
        if (tryInjectSettings()) { obs.disconnect(); startKeepAlive(); }
      });
      obs.observe(target, { childList: true, subtree: true });
    } else {
      startKeepAlive();
    }

    // [lc-1099] 运行期切换性能模式: 同步摘/挂云母属性+停/复粒子, 并刷新设置块提示文案
    window.addEventListener('fntv:perf-change', () => { applyGlass(); updatePerfHint(); });
  } catch (err) {
    console.error(LOG, 'handle failed', err);
  }
}

// 注册必须在任何可能抛错的模块级代码之前（本文件无模块级 IIFE，此处即顶层注册）
registerHook(HookType.OnReady, handle);

export {};
