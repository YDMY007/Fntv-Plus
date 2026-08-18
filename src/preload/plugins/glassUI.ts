// preload/plugins/glassUI.ts
//
// [lc-525] 云母增强 / Glass UI 插件 —— 对齐 DSH-Transparent-UI-Plugin 的 CSS 玻璃拟态方案
// =============================================================================
// 设计目标（用户决策）：
//   - 路线 B：纯 CSS 玻璃拟态（backdrop-filter + 半透明卡片 + 底层 ambient 容器），
//     非 Windows 原生 Mica；全平台（fnOS/Linux、Windows、macOS）一致生效。
//   - 完整对齐 DSH：组件磨砂 + 背景层（流体/壁纸/视频）+ 设置面板独立控件。
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
  bg: 'fntvGlass.bg',              // 'none' | 'fluid' | 'wallpaper' | 'video'
  wallpaper: 'fntvGlass.wallpaper',// 图片 URL
  video: 'fntvGlass.video',        // 视频 URL
  particles: 'fntvGlass.particles',// '0' | '1'
  border: 'fntvGlass.border',      // '0' | '1' 玻璃边框
  borderAlpha: 'fntvGlass.borderAlpha', // 0..1 边框浓度
  shadow: 'fntvGlass.shadow',      // 0..1 阴影浓度
  noise: 'fntvGlass.noise',        // '0' | '1' 磨砂噪点
  vignette: 'fntvGlass.vignette',  // '0' | '1' 背景暗角
};

// ── 默认值 ──
const DEF = {
  enabled: false,
  mode: 'mica',
  tint: '#faf8fc',
  blur: 14,
  frost: 0.5,
  sat: 140,
  bright: 100,
  bg: 'fluid',
  wallpaper: '',
  video: '',
  particles: false,
  border: true,
  borderAlpha: 0.2,
  shadow: 0.14,
  noise: false,
  vignette: false,
};

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

// ── 读取全部设置 ──
interface GlassSettings {
  enabled: boolean; mode: string; tint: string; blur: number; frost: number; sat: number;
  bright: number; bg: string; wallpaper: string; video: string; particles: boolean;
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
    wallpaper: getStr(K.wallpaper, DEF.wallpaper),
    video: getStr(K.video, DEF.video),
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
const GATE_CSS = `
  /* 玻璃底色：mica=浅冷白，compat=中性深灰 */
  html[data-fntv-glass] {
    --fntv-glass-tint-r: 250;
    --fntv-glass-tint-g: 248;
    --fntv-glass-tint-b: 252;
  }
  html[data-fntv-glass][data-fntv-glass-mode="compat"] {
    --fntv-glass-tint-r: 34;
    --fntv-glass-tint-g: 38;
    --fntv-glass-tint-b: 47;
  }

  /* ① 接管 body：关闭整窗亚克力（改由组件级磨砂），body 透明让背景层/桌面透出 */
  html[data-fntv-glass] .fnos-tv-page body {
    background: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  /* ② 组件级玻璃：卡片/面板/控制栏 浮在背景层上做磨砂
     关键：每个选择器带 :not() 排除顶栏(data-fnos-clear 锚点)，从源头避免误伤。
     lc-526~530 教训：事后排除规则 !important 对抗不稳定，改用 :not() 让选择器根本不匹配顶栏区域 */
  html[data-fntv-glass] .fnos-tv-page [class*="card"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="Card"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="panel"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="Panel"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="playbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="control-bar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="ControlBar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="navbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="topbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="appbar"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="search"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page [class*="Search"]:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page header:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]),
  html[data-fntv-glass] .fnos-tv-page nav:not(:has([data-fnos-clear="1"])):not([data-fnos-clear="1"]) {
    background: rgba(var(--fntv-glass-tint-r), var(--fntv-glass-tint-g), var(--fntv-glass-tint-b), var(--fntv-glass-frost, 0.5)) !important;
    backdrop-filter: blur(var(--fntv-glass-blur, 14px)) saturate(var(--fntv-glass-sat, 140%)) !important;
    -webkit-backdrop-filter: blur(var(--fntv-glass-blur, 14px)) saturate(var(--fntv-glass-sat, 140%)) !important;
    border: calc(var(--fntv-glass-border, 1) * 1px) solid rgba(var(--fntv-glass-tint-r), var(--fntv-glass-tint-g), var(--fntv-glass-tint-b), calc(var(--fntv-glass-frost, 0.5) * var(--fntv-glass-border-alpha, 0.2))) !important;
    box-shadow: 0 8px 28px rgba(0,0,0, var(--fntv-glass-shadow, 0.14)) !important;
  }

  /* ③ 背景层 / 粒子层：固定铺满、置于内容之下（z-index:-1） */
  #fntv-glass-bg, #fntv-glass-particles {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: -1 !important;
    pointer-events: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
  }
  #fntv-glass-bg { overflow: hidden !important; }
  #fntv-glass-bg > * {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
  }
  /* 流体动画渐变 */
  #fntv-glass-fluid {
    background: linear-gradient(125deg, #6a5acd, #8e44ad, #3498db, #1abc9c, #6a5acd);
    background-size: 400% 400% !important;
    filter: saturate(1.1);
    animation: fntvFluid 22s ease infinite;
  }
  #fntv-glass-fluid::before, #fntv-glass-fluid::after {
    content: "" !important;
    position: absolute !important;
    border-radius: 50% !important;
    filter: blur(60px) !important;
    opacity: 0.55 !important;
  }
  #fntv-glass-fluid::before {
    width: 46vmax !important; height: 46vmax !important;
    left: -8vmax !important; top: -10vmax !important;
    background: radial-gradient(circle, #ff9ad5, transparent 70%);
    animation: fntvBlob1 18s ease-in-out infinite;
  }
  #fntv-glass-fluid::after {
    width: 40vmax !important; height: 40vmax !important;
    right: -6vmax !important; bottom: -8vmax !important;
    background: radial-gradient(circle, #7ee8fa, transparent 70%);
    animation: fntvBlob2 21s ease-in-out infinite;
  }
  @keyframes fntvFluid {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes fntvBlob1 {
    0%,100% { transform: translate(0,0) scale(1); }
    50% { transform: translate(8vmax, 6vmax) scale(1.15); }
  }
  @keyframes fntvBlob2 {
    0%,100% { transform: translate(0,0) scale(1); }
    50% { transform: translate(-7vmax, -5vmax) scale(1.1); }
  }

  /* ④ 磨砂噪点层：固定铺满、置于背景与内容之间（z-index:-1），微妙颗粒增强玻璃质感 */
  #fntv-glass-noise {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: -1 !important;
    pointer-events: none !important;
    opacity: 0.06 !important;
    mix-blend-mode: overlay !important;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") !important;
    background-size: 160px 160px !important;
    display: none !important;
  }
  html[data-fntv-glass][data-fntv-glass-noise="1"] #fntv-glass-noise {
    display: block !important;
  }

  /* ⑤ 背景层暗角：增强层次（仅玻璃开启 + 有背景层时） */
  html[data-fntv-glass][data-fntv-glass-vignette="1"] #fntv-glass-bg::after {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    pointer-events: none !important;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.38) 100%) !important;
  }

  /* ═══ 排除规则：顶部导航/标题栏区域完全透明化 ═══ */
  /* 顶栏容器本身：fnOS 透明模式下标记 data-fnos-clear="1"（class 形如 relative z-[2] h-[80px] bg-[var(--semi-color-bg-1)]） */
  html[data-fntv-glass] .fnos-tv-page [data-fnos-clear="1"],
  /* 顶栏所有祖先容器（含真正承载玻璃效果的 card/panel 包裹层）：用 :has 不限层级命中 */
  html[data-fntv-glass] .fnos-tv-page :has([data-fnos-clear="1"]),
  /* 兜底：含顶栏 z-20/z-10 的容器与祖先（z-20 在更深层的内层 div，不限层级命中） */
  html[data-fntv-glass] .fnos-tv-page [class*="z-20"],
  html[data-fntv-glass] .fnos-tv-page [class*="z-10"],
  html[data-fntv-glass] .fnos-tv-page :has([class*="z-20"]),
  html[data-fntv-glass] .fnos-tv-page :has([class*="z-10"]),
  /* 语义标签排除 */
  html[data-fntv-glass] .fnos-tv-page header,
  html[data-fntv-glass] .fnos-tv-page nav,
  html[data-fntv-glass] .fnos-tv-page [class*="navbar"],
  html[data-fntv-glass] .fnos-tv-page [class*="topbar"],
  html[data-fntv-glass] .fnos-tv-page [class*="appbar"],
  html[data-fntv-glass] .fnos-tv-page [class*="header-bar"],
  html[data-fntv-glass] .fnos-tv-page [class*="nav-bar"],
  html[data-fntv-glass] .fnos-tv-page [class*="page-header"],
  html[data-fntv-glass] .fnos-tv-page [class*="toolbar"],
  html[data-fntv-glass] .fnos-tv-page [class*="list-head"],
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
let bgLayer: HTMLElement | null = null;
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

// ── 本地路径 → file:// URL（与 mainwin.ts 登录壁纸一致；远程 fnOS 页面须 file:// 才能跨域加载）──
function toFileUrl(p: string): string {
  if (!p) return p;
  if (/^(file:|https?:|data:)/i.test(p)) return p; // 已为合法资源 URL
  const norm = p.replace(/\\/g, '/');               // Windows 反斜杠 → 正斜杠
  return 'file:///' + (norm.startsWith('/') ? norm.slice(1) : norm);
}

// ── 构建背景层（按 bg 源）──
function buildBgLayer(s: GlassSettings): void {
  destroyBgLayer();
  if (!s.enabled || s.bg === 'none') return; // none：保留桌面透出，不加背景层
  const layer = document.createElement('div');
  layer.id = 'fntv-glass-bg';
  layer.style.filter = `brightness(${(s.bright / 100).toFixed(3)})`;

  if (s.bg === 'fluid') {
    const fluid = document.createElement('div');
    fluid.id = 'fntv-glass-fluid';
    layer.appendChild(fluid);
  } else if (s.bg === 'wallpaper') {
    if (s.wallpaper) {
      const img = document.createElement('img');
      img.src = toFileUrl(s.wallpaper);
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => {
        console.warn(LOG, '壁纸加载失败，回退流体背景:', s.wallpaper);
        const fluid = document.createElement('div');
        fluid.id = 'fntv-glass-fluid';
        layer.appendChild(fluid);
      });
      layer.appendChild(img);
    } else {
      // 未填 URL 时回退流体，避免空白
      const fluid = document.createElement('div');
      fluid.id = 'fntv-glass-fluid';
      layer.appendChild(fluid);
    }
  } else if (s.bg === 'video') {
    if (s.video) {
      const vid = document.createElement('video');
      vid.src = toFileUrl(s.video);
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      (vid as any).webkitPlaysInline = true;
      vid.addEventListener('error', () => {
        // 视频加载失败回退流体
        const fluid = document.createElement('div');
        fluid.id = 'fntv-glass-fluid';
        layer.appendChild(fluid);
      });
      layer.appendChild(vid);
    } else {
      const fluid = document.createElement('div');
      fluid.id = 'fntv-glass-fluid';
      layer.appendChild(fluid);
    }
  }

  (document.body || document.documentElement).appendChild(layer);
  bgLayer = layer;
}

function destroyBgLayer(): void {
  if (bgLayer && bgLayer.parentElement) bgLayer.parentElement.removeChild(bgLayer);
  bgLayer = null;
}

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
    let el: Element | null = bar.parentElement;
    let depth = 0;
    while (el && depth < 10) {
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

    if (s.enabled) {
      root.setAttribute('data-fntv-glass', '');
      root.setAttribute('data-fntv-glass-mode', s.mode);
      root.setAttribute('data-fntv-glass-noise', s.noise ? '1' : '0');
      root.setAttribute('data-fntv-glass-vignette', s.vignette ? '1' : '0');
      ensureNoiseLayer();
      buildBgLayer(s);
      if (s.particles) startParticles(); else stopParticles();
      // JS 兜底：强制清空顶栏祖先样式（行内 > CSS !important，覆盖 mainwin.ts insertCSS）
      neutralizeTopBar();
      setTimeout(neutralizeTopBar, 800);
      setTimeout(neutralizeTopBar, 2000);
      debugTopAncestry();
      setTimeout(debugTopAncestry, 1800);
    } else {
      root.removeAttribute('data-fntv-glass');
      root.removeAttribute('data-fntv-glass-mode');
      root.removeAttribute('data-fntv-glass-noise');
      root.removeAttribute('data-fntv-glass-vignette');
      destroyBgLayer();
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

// ── 壁纸文件选择器行（按钮 + 预览路径 + 清空）──
function buildWallpaperPickerRow(currentPath: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:12px 0 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  label.textContent = '壁纸图片';
  head.appendChild(label);
  wrap.appendChild(head);

  // 按钮行
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const pickBtn = document.createElement('button');
  pickBtn.textContent = currentPath ? '重新选择' : '选择图片';
  pickBtn.style.cssText = 'padding:5px 14px;font-size:11px;border:none;border-radius:7px;cursor:pointer;'
    + 'background:var(--fnos-ui-accent,#4a90d9);color:#fff;transition:.15s;';
  pickBtn.addEventListener('mouseenter', () => { pickBtn.style.opacity = '0.85'; });
  pickBtn.addEventListener('mouseleave', () => { pickBtn.style.opacity = '1'; });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = '清空';
  clearBtn.style.cssText = 'padding:5px 12px;font-size:11px;border:none;border-radius:7px;cursor:pointer;'
    + 'background:rgba(255,70,70,.7);color:#fff;transition:.15s;' + (!currentPath ? 'display:none;' : '');
  clearBtn.addEventListener('mouseenter', () => { clearBtn.style.opacity = '0.85'; });
  clearBtn.addEventListener('mouseleave', () => { clearBtn.style.opacity = '1'; });

  // 路径预览
  const pathPreview = document.createElement('div');
  pathPreview.style.cssText = 'font-size:10px;color:var(--fnos-ui-sub,#888);word-break:break-all;margin-top:4px;max-height:36px;overflow:auto;'
    + (!currentPath ? 'display:none;' : '');
  pathPreview.textContent = currentPath ? (currentPath.replace(/\\/g, '/').split('/').pop() || '') : '';

  btns.appendChild(pickBtn);
  btns.appendChild(clearBtn);
  wrap.appendChild(btns);
  wrap.appendChild(pathPreview);

  // 选择图片
  pickBtn.addEventListener('click', async () => {
    try {
      const p = await ipcRenderer.invoke('settings:pick-glass-wallpaper');
      if (p) {
        setStr(K.wallpaper, p);
        pathPreview.textContent = p.replace(/\\/g, '/').split('/').pop() || '';
        pathPreview.style.display = '';
        clearBtn.style.display = '';
        pickBtn.textContent = '重新选择';
        if (readSettings().bg === 'wallpaper') applyGlass();
      }
    } catch (e) {
      console.error(LOG, 'pick wallpaper failed', e);
    }
  });

  // 清空
  clearBtn.addEventListener('click', async () => {
    try {
      await ipcRenderer.invoke('settings:clear-glass-wallpaper');
      setStr(K.wallpaper, '');
      pathPreview.style.display = 'none';
      clearBtn.style.display = 'none';
      pickBtn.textContent = '选择图片';
      if (readSettings().bg === 'wallpaper') applyGlass();
    } catch (e) {
      console.error(LOG, 'clear wallpaper failed', e);
    }
  });

  return wrap;
}

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
  sub.textContent = '组件磨砂玻璃 + 背景层（流体/壁纸/视频）。默认关闭，开启后影视页组件浮于背景之上。';
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

  // 模式
  block.appendChild(selectRow('玻璃模式', [
    { value: 'mica', label: 'Mica（浅冷白）' },
    { value: 'compat', label: 'Compat（深灰低透）' },
    { value: 'custom', label: '自定义颜色' },
  ], s.mode, (v) => { setStr(K.mode, v); applyGlass(); refreshModeDepFields(); }));

  // 玻璃色调（仅自定义模式显示）
  const tintRow = colorRow('玻璃色调', s.tint, (v) => { setStr(K.tint, v); applyGlass(); });
  block.appendChild(tintRow);

  // 背景源
  block.appendChild(selectRow('背景层', [
    { value: 'none', label: '无（透桌面）' },
    { value: 'fluid', label: '流体动态' },
    { value: 'wallpaper', label: '壁纸图片' },
    { value: 'video', label: '视频' },
  ], s.bg, (v) => { setStr(K.bg, v); applyGlass(); refreshBgDepFields(); }));

  // 模糊 / 磨砂 / 饱和度 / 亮度
  block.appendChild(rangeRow('组件模糊', 0, 40, 1, s.blur, 'px', (v) => { setStr(K.blur, String(v)); applyGlass(); }));
  block.appendChild(rangeRow('玻璃浓度', 0, 100, 1, Math.round(s.frost * 100), '%', (v) => { setStr(K.frost, String(v / 100)); applyGlass(); }));
  block.appendChild(rangeRow('饱和度', 100, 200, 1, s.sat, '%', (v) => { setStr(K.sat, String(v)); applyGlass(); }));
  block.appendChild(rangeRow('背景亮度', 40, 160, 1, s.bright, '%', (v) => { setStr(K.bright, String(v)); applyGlass(); }));

  // 边框 / 阴影（控制"廉价感"的关键）
  const borderTog = mkToggle();
  paintToggle(borderTog, s.border);
  borderTog.input.checked = s.border;
  borderTog.input.addEventListener('change', () => {
    setStr(K.border, borderTog.input.checked ? '1' : '0');
    paintToggle(borderTog, borderTog.input.checked);
    applyGlass();
  });
  block.appendChild(row('玻璃边框', borderTog.wrap));
  block.appendChild(rangeRow('边框浓度', 0, 100, 1, Math.round(s.borderAlpha * 100), '%', (v) => { setStr(K.borderAlpha, String(v / 100)); applyGlass(); }));
  block.appendChild(rangeRow('阴影浓度', 0, 100, 1, Math.round(s.shadow * 100), '%', (v) => { setStr(K.shadow, String(v / 100)); applyGlass(); }));

  // 磨砂噪点 / 暗角（提升质感）
  const noiseTog = mkToggle();
  paintToggle(noiseTog, s.noise);
  noiseTog.input.checked = s.noise;
  noiseTog.input.addEventListener('change', () => {
    setStr(K.noise, noiseTog.input.checked ? '1' : '0');
    paintToggle(noiseTog, noiseTog.input.checked);
    applyGlass();
  });
  block.appendChild(row('磨砂噪点', noiseTog.wrap));
  const vigTog = mkToggle();
  paintToggle(vigTog, s.vignette);
  vigTog.input.checked = s.vignette;
  vigTog.input.addEventListener('change', () => {
    setStr(K.vignette, vigTog.input.checked ? '1' : '0');
    paintToggle(vigTog, vigTog.input.checked);
    applyGlass();
  });
  block.appendChild(row('背景暗角', vigTog.wrap));

  // 壁纸文件选择（按钮行，弹系统文件选择框）/ 视频仍用 URL / 粒子
  const wallRow = buildWallpaperPickerRow(s.wallpaper);
  const vidRow = textRow('背景视频 URL', 'https://.../bg.mp4', s.video, (v) => { setStr(K.video, v); if (readSettings().bg === 'video') applyGlass(); });
  const particleTog = mkToggle();
  paintToggle(particleTog, s.particles);
  particleTog.input.checked = s.particles;
  particleTog.input.addEventListener('change', () => {
    setStr(K.particles, particleTog.input.checked ? '1' : '0');
    paintToggle(particleTog, particleTog.input.checked);
    applyGlass();
  });
  block.appendChild(wallRow);
  block.appendChild(vidRow);
  block.appendChild(row('粒子效果', particleTog.wrap));

  // 显隐依赖字段（函数声明，提升，供上方 change 回调安全引用）
  function refreshBgDepFields(): void {
    const cur = readSettings().bg;
    wallRow.style.display = cur === 'wallpaper' ? '' : 'none';
    vidRow.style.display = cur === 'video' ? '' : 'none';
  }
  function refreshModeDepFields(): void {
    const cur = readSettings().mode;
    tintRow.style.display = cur === 'custom' ? '' : 'none';
  }
  refreshBgDepFields();
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
  } catch (err) {
    console.error(LOG, 'handle failed', err);
  }
}

// 注册必须在任何可能抛错的模块级代码之前（本文件无模块级 IIFE，此处即顶层注册）
registerHook(HookType.OnReady, handle);

export {};
