import { S } from './state';

// embyWall/theme.ts — UI 主题：light/dark/system 三态切换、深色模式落地到 fnOS、主题样式注入
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export type UiThemeMode = 'light' | 'dark' | 'system';
const UI_THEME_KEY = 'fnos-ui-theme';

export function getUiTheme(): UiThemeMode {
  try {
    const v = localStorage.getItem(UI_THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v as UiThemeMode;
  } catch (e) { /* ignore */ }
  return 'light'; // 默认浅色
}

/** 系统是否偏好深色(跟随系统时用) */
function systemPrefersDark(): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { return false; }
}

/** 解析为实际明暗(跟随系统 → 读系统偏好) */
export function getEffectiveDark(): boolean {
  const m = getUiTheme();
  if (m === 'system') return systemPrefersDark();
  return m === 'dark';
}

/** 把目标主题应用到页面, 并同步飞牛原生网页主题(html class / body theme-mode / 飞牛偏好键) */
function applyThemeToFnos(isDark: boolean): void {
  const html = document.documentElement;
  html.classList.toggle('dark', isDark);
  html.classList.toggle('light', !isDark);
  html.style.colorScheme = isDark ? 'dark' : 'light';
  const body = document.body;
  if (body) body.setAttribute('theme-mode', isDark ? 'dark' : 'light');
  // 同步飞牛原生偏好键: 飞牛(React)读取后会渲染对应主题; 不读我们的键, 互不干扰
  try {
    localStorage.setItem('fnos-theme-mode', isDark ? 'dark' : 'light');
    localStorage.setItem('os-theme-mode', isDark ? 'dark' : 'light');
    localStorage.setItem('mc-theme', isDark ? 'dark' : 'light');
  } catch (e) { /* ignore */ }
}

/** 应用当前 UI 主题偏好(含已打开面板分段控件刷新) */
export function applyUiTheme(): void {
  applyThemeToFnos(getEffectiveDark());
  if (S.refreshThemeSeg) { try { S.refreshThemeSeg(); } catch (e) {} }
}

/** 设置并持久化 UI 主题(供开关/分段控件调用) */
export function setUiTheme(mode: UiThemeMode): void {
  try { localStorage.setItem(UI_THEME_KEY, mode); } catch (e) {}
  applyThemeToFnos(getEffectiveDark());
}

/** [v400] 注入自建设备 UI 的主题变量(浅色为 :root 默认, 深色由 html.dark 覆盖).
 *  所有面板/弹窗/hover 均引用这些变量 → 切换 html.dark 即整体换肤, 已打开的面板也实时生效. */
export function injectUiThemeStyle(): void {
  if (document.getElementById('fnos-ui-theme-style')) return;
  const s = document.createElement('style');
  s.id = 'fnos-ui-theme-style';
  s.textContent = `
:root{
  --fnos-ui-panel-bg:linear-gradient(165deg,rgba(252,247,253,.94),rgba(244,238,251,.96));
  --fnos-ui-text:#4a3d63;
  --fnos-ui-sec:#9575cd;
  --fnos-ui-muted:#6a5a88;
  --fnos-ui-muted2:#8778a5;
  --fnos-ui-btn-text:#5c4d7d;
  --fnos-ui-btn-text2:#7a6a9a;
  --fnos-ui-border:rgba(150,120,200,.14);
  --fnos-ui-border2:rgba(150,120,200,.12);
  --fnos-ui-border3:rgba(150,120,200,.16);
  --fnos-ui-border-strong:rgba(150,120,200,.22);
  --fnos-ui-border-outer:rgba(180,155,220,.35);
  --fnos-ui-btn-bg:rgba(150,120,200,.12);
  --fnos-ui-btn-bg2:rgba(150,120,200,.10);
  --fnos-ui-btn-hover:rgba(183,155,232,.32);
  --fnos-ui-btn-hover2:rgba(183,155,232,.28);
  --fnos-ui-row-hover:rgba(150,120,200,.08);
  --fnos-ui-input-bg:rgba(255,255,255,.5);
  --fnos-ui-accent:#b79be8;
  --fnos-ui-warn:#b06a3a;
  --fnos-ui-ok:#3a8c5a;
  --fnos-ui-pill-bg:rgba(125,95,201,.12);
  --fnos-ui-pill-border:rgba(125,95,201,.3);
  --fnos-ui-pill-hover:rgba(125,95,201,.9);
  --fnos-ui-pill-text:#7d5fc9;
  --fnos-ui-exit-on:rgba(147,117,205,.92);
  --fnos-ui-exit-off:rgba(255,255,255,.55);
  --fnos-hero-container:rgba(245,238,250,.5);
  --fnos-hero-panel:linear-gradient(160deg,rgba(248,240,250,.80),rgba(238,228,246,.86));
  --fnos-hero-dots:rgba(250,244,252,.65);
  --fnos-hero-edge:linear-gradient(90deg,transparent 66%,rgba(243,235,250,.85) 100%);
  --fnos-hero-dot:rgba(0,0,0,.16);
  --fnos-hero-title:#0f1c3f;
  --fnos-hero-title-grad:linear-gradient(120deg,#00d4ff 0%,#4da3ff 22%,#ff5cd0 55%,#ffb347 82%,#ffd166 100%); /* [lc-591] 炫彩霓虹渐变 */
  --fnos-hero-title-glow:drop-shadow(0 1px 0 rgba(255,255,255,.5)); /* [lc-593] 去掉彩色霓虹光晕(用户要求不做阴影), 仅极弱白色描边保证可读 */
  --fnos-hero-desc:rgba(20,35,70,.82);
  --fnos-hero-shadow:0 1px 10px rgba(255,255,255,.5);
  --fnos-hero-divider:linear-gradient(90deg,transparent,rgba(91,140,255,.55),transparent);
  /* 轮播「开始观看」按钮(主题自适应, 高对比) */
  --fnos-hero-play-bg:rgba(108,76,178,.94);
  --fnos-hero-play-text:#ffffff;
  --fnos-hero-play-border:rgba(108,76,178,.9);
  --fnos-hero-play-hover:rgba(124,90,205,1);
  --fnos-ui-veil:linear-gradient(180deg,rgba(245,240,248,.6) 0%,rgba(238,233,246,.55) 100%);
  --fnos-detail-grad:linear-gradient(180deg,transparent 45%,rgba(12,18,35,.08) 72%,rgba(230,240,255,.22) 100%);
  --fnos-detail-desc:linear-gradient(135deg,rgba(255,255,255,.20),rgba(240,248,255,.25));
  --fnos-detail-desc-border:rgba(255,255,255,.30);
  --fnos-detail-card:linear-gradient(145deg,rgba(255,255,255,.18),rgba(232,244,255,.25));
  --fnos-detail-card-border:rgba(255,255,255,.28);
  --fnos-detail-bar:linear-gradient(180deg,rgba(255,255,255,.15),rgba(240,248,255,.20));
  --fnos-detail-bar-border:rgba(255,255,255,.25);
  --fnos-detail-season-grad:linear-gradient(180deg,transparent 30%,rgba(15,22,40,.18) 58%,rgba(235,243,255,.78) 100%);
  --fnos-detail-season-sec:linear-gradient(135deg,rgba(255,255,255,.55),rgba(240,246,255,.6));
  --fnos-detail-season-sec-border:rgba(255,255,255,.5);
  --fnos-detail-ep:linear-gradient(148deg,rgba(255,255,255,.48),rgba(232,242,255,.58));
  --fnos-detail-ep-border:rgba(255,255,255,.48);
  --fnos-detail-scroll:linear-gradient(180deg,rgba(238,244,255,.3),rgba(248,250,255.35));
  --fnos-sidebar-bg:linear-gradient(160deg,rgba(250,244,250,.60),rgba(243,238,247,.64));
  --fnos-sidebar-border:1px solid rgba(255,255,255,.5);
  --fnos-sidebar-shadow:inset 1px 0 0 rgba(255,255,255,.5),-8px 0 32px rgba(140,130,160,.08);
  --fnos-hero-panel-border:1px solid rgba(255,255,255,.5);
  --fnos-detail-shadow-1:0 3px 16px rgba(31,41,90,.04),0 1px 0 rgba(255,255,255,.5);
  --fnos-detail-shadow-2:0 4px 20px rgba(31,41,90,.06),0 1px 0 rgba(255,255,255,.7),inset 0 1px 0 rgba(255,255,255,.5);
  --fnos-detail-shadow-3:0 14px 40px rgba(91,140,255,.14),0 1px 0 rgba(255,255,255,.7),inset 0 1px 0 rgba(255,255,255,.5);
  --fnos-exit-border-on:1px solid rgba(147,117,205,.6);
  --fnos-exit-border-off:1px solid rgba(150,120,200,.18);
  --fnos-skel-bg:rgba(255,255,255,.45);
  --fnos-skel-shine:rgba(255,255,255,.8);
  --fnos-sidebar-btn-bg:rgba(70,52,100,.24);
  --fnos-qr-bg:#fff;
  --fnos-modal-overlay:rgba(40,30,60,.42);
  --fnos-modal-inner-shadow:inset 0 1px 0 rgba(255,255,255,.6);
  --fnos-titlebar-bg:transparent;
  --fnos-titlebar-icon:#444;
  --fnos-titlebar-hover-minmax:rgba(0,0,0,.05);
  --fnos-titlebar-hover-close-bg:rgba(232,17,35,.10);
  --fnos-titlebar-hover-close-icon:#e81123;
}
html.dark{
  --fnos-ui-panel-bg:linear-gradient(165deg,rgba(36,30,52,.94),rgba(28,22,42,.96));
  --fnos-ui-text:#e7def8;
  --fnos-ui-sec:#b9a4ec;
  --fnos-ui-muted:#b3a6d0;
  --fnos-ui-muted2:#9d90bf;
  --fnos-ui-btn-text:#d2c5ee;
  --fnos-ui-btn-text2:#c4b6e3;
  --fnos-ui-border:rgba(170,150,210,.18);
  --fnos-ui-border2:rgba(170,150,210,.14);
  --fnos-ui-border3:rgba(170,150,210,.20);
  --fnos-ui-border-strong:rgba(170,150,210,.28);
  --fnos-ui-border-outer:rgba(170,150,210,.42);
  --fnos-ui-btn-bg:rgba(150,120,200,.18);
  --fnos-ui-btn-bg2:rgba(150,120,200,.15);
  --fnos-ui-btn-hover:rgba(183,155,232,.42);
  --fnos-ui-btn-hover2:rgba(183,155,232,.36);
  --fnos-ui-row-hover:rgba(150,120,200,.14);
  --fnos-ui-input-bg:rgba(64,52,90,.30);
  --fnos-ui-accent:#c9b2f0;
  --fnos-ui-warn:#e3a06a;
  --fnos-ui-ok:#6fcf8e;
  --fnos-ui-pill-bg:rgba(150,120,200,.22);
  --fnos-ui-pill-border:rgba(170,150,210,.34);
  --fnos-ui-pill-hover:rgba(160,130,220,.95);
  --fnos-ui-pill-text:#cbb8ef;
  --fnos-ui-exit-on:rgba(160,130,220,.95);
  --fnos-ui-exit-off:rgba(70,58,98,.30);
  --fnos-hero-container:rgba(40,32,58,.55);
  --fnos-hero-panel:linear-gradient(160deg,rgba(40,32,58,.82),rgba(30,24,46,.88));
  --fnos-hero-dots:rgba(60,50,84,.72);
  --fnos-hero-edge:linear-gradient(90deg,transparent 66%,rgba(60,50,84,.92) 100%);
  --fnos-hero-dot:rgba(200,195,215,.35);
  --fnos-hero-title:#f0ecff;
  --fnos-hero-title-grad:linear-gradient(120deg,#00e5ff 0%,#4da3ff 22%,#ff5cd0 55%,#ffb347 82%,#ffd166 100%); /* [lc-591] 炫彩霓虹渐变 */
  --fnos-hero-title-glow:drop-shadow(0 1px 2px rgba(0,0,0,.35)); /* [lc-593] 去掉彩色霓虹光晕(用户要求不做阴影), 仅极弱深色近影保证可读 */
  --fnos-hero-desc:rgba(225,218,245,.88);
  --fnos-hero-shadow:0 1px 10px rgba(0,0,0,.5);
  --fnos-hero-divider:linear-gradient(90deg,transparent,rgba(140,160,255,.6),transparent);
  /* 轮播「开始观看」按钮(主题自适应, 高对比) */
  --fnos-hero-play-bg:rgba(124,93,255,.95);
  --fnos-hero-play-text:#ffffff;
  --fnos-hero-play-border:rgba(150,120,255,.7);
  --fnos-hero-play-hover:rgba(140,110,255,1);
  --fnos-ui-veil:linear-gradient(180deg,rgba(30,24,46,.6) 0%,rgba(24,18,38,.55) 100%);
  --fnos-detail-grad:linear-gradient(180deg,transparent 45%,rgba(0,0,0,.30) 72%,rgba(18,14,30,.58) 100%);
  --fnos-detail-desc:linear-gradient(135deg,rgba(50,40,72,.45),rgba(34,27,52,.55));
  --fnos-detail-desc-border:rgba(255,255,255,.12);
  --fnos-detail-card:linear-gradient(145deg,rgba(54,44,76,.42),rgba(38,30,56,.52));
  --fnos-detail-card-border:rgba(255,255,255,.10);
  --fnos-detail-bar:linear-gradient(180deg,rgba(48,38,68,.20),rgba(33,26,50,.26));
  --fnos-detail-bar-border:rgba(255,255,255,.10);
  --fnos-detail-season-grad:linear-gradient(180deg,transparent 30%,rgba(0,0,0,.40) 58%,rgba(18,14,30,.72) 100%);
  --fnos-detail-season-sec:linear-gradient(135deg,rgba(60,50,84,.18),rgba(45,36,64,.22));
  --fnos-detail-season-sec-border:rgba(255,255,255,.12);
  --fnos-detail-ep:linear-gradient(148deg,rgba(58,48,82,.40),rgba(40,32,58,.50));
  --fnos-detail-ep-border:rgba(255,255,255,.12);
  --fnos-detail-scroll:linear-gradient(180deg,rgba(20,16,34,.45),rgba(24,18,38,.50));
  --fnos-sidebar-bg:linear-gradient(160deg,rgba(40,32,58,.82),rgba(30,24,46,.88));
  --fnos-sidebar-border:1px solid rgba(255,255,255,.08);
  --fnos-sidebar-shadow:inset 1px 0 0 rgba(255,255,255,.06),-8px 0 32px rgba(0,0,0,.30);
  --fnos-hero-panel-border:1px solid rgba(255,255,255,.10);
  --fnos-detail-shadow-1:0 3px 16px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.06);
  --fnos-detail-shadow-2:0 4px 20px rgba(0,0,0,.30),0 1px 0 rgba(255,255,255,.10),inset 0 1px 0 rgba(255,255,255,.06);
  --fnos-detail-shadow-3:0 14px 40px rgba(91,140,255,.18),0 1px 0 rgba(255,255,255,.10),inset 0 1px 0 rgba(255,255,255,.06);
  --fnos-exit-border-on:1px solid rgba(170,150,210,.6);
  --fnos-exit-border-off:1px solid rgba(170,150,210,.18);
  --fnos-skel-bg:rgba(150,140,170,.18);
  --fnos-skel-shine:rgba(200,190,220,.18);
  --fnos-sidebar-btn-bg:rgba(40,30,60,.38);
  --fnos-qr-bg:rgba(220,215,230,.95);
  --fnos-modal-overlay:rgba(0,0,0,.60);
  --fnos-modal-inner-shadow:inset 0 1px 0 rgba(255,255,255,.10);
  --fnos-titlebar-bg:transparent;
  --fnos-titlebar-icon:#c4b6e3;
  --fnos-titlebar-hover-minmax:rgba(255,255,255,.08);
  --fnos-titlebar-hover-close-bg:rgba(232,17,35,.18);
  --fnos-titlebar-hover-close-icon:#ff4d5a;
}`;
  (document.head || document.documentElement).appendChild(s);
}

/** [v358] 删除设置页"主题模式"区块(含 跟随系统/浅色/深色 三个 radio 卡片), 防止切回深色 */
export function removeThemeModeSetting(): void {
  // 仅在外观点设置页生效(其它页面无此 DOM, 安全跳过); 用文字精确匹配避免误删"卡片样式"等区块
  const candidates = document.querySelectorAll('strong, p');
  const title = Array.from(candidates).find(el => (el.textContent || '').trim() === '主题模式');
  if (!title) return;
  // 向上找区块容器: div.flex.w-full.flex-col.gap-4 (同时包含标题 <p><strong> 与 <ul> 卡片列表)
  let block: HTMLElement | null = title as HTMLElement;
  while (block && block.parentElement) {
    if (block.classList?.contains('flex') && block.classList.contains('flex-col') && block.classList.contains('gap-4')) {
      block.style.setProperty('display', 'none', 'important');
      return;
    }
    block = block.parentElement as HTMLElement;
  }
}
