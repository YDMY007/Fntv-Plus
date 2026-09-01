import { S } from '../state';
import { ensureStyle4Css } from './styles';
import { getEffectiveDark } from '../theme';
import { ipcRenderer } from 'electron';
import { log } from '../log';

// embyWall/carousel/progress.ts — 轮播骨架屏与加载进度：占位构建、进度条推进、完成收尾、STRM 不支持提示
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export function buildLoadingPlaceholder(target: HTMLElement): void {
  // shimmer / spinner 动画样式只注入一次
  if (!document.getElementById('fnos-ph-style')) {
    const st = document.createElement('style');
    st.id = 'fnos-ph-style';
    st.textContent = `
@keyframes fnos-ph-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
.fnos-ph-skel{position:relative;overflow:hidden;background:var(--fnos-skel-bg)}
.fnos-ph-skel::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--fnos-skel-shine),transparent);transform:translateX(-120%);animation:fnos-ph-shimmer 1.5s infinite}
/* [lc-621] 实时进度模拟器样式(用户参考) — 渐变进度条 + 大百分比 + 状态文字, 无 emoji */
.fnos-ph-track{width:280px;height:8px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden;position:relative}
.fnos-ph-fill{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,#8f6fe8,#c9a7f0);transition:width .25s ease}
.fnos-ph-percent{font-size:30px;font-weight:700;color:rgba(240,236,255,.98);font-variant-numeric:tabular-nums;letter-spacing:.5px;line-height:1}
.fnos-ph-status{font-size:12.5px;color:rgba(225,218,245,.85);padding:4px 14px;border-radius:30px;background:rgba(255,255,255,.09);font-weight:600;letter-spacing:.5px;transition:background .15s}
/* [lc-805] 样式2 骨架: 与样式2 轮播视觉一致(满铺暗底 + 底部内容占位 + 底部进度条/指示点) */
.fntv-ph-s2-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.92) 0%,rgba(0,0,0,.62) 26%,rgba(0,0,0,.28) 56%,rgba(0,0,0,.08) 76%,rgba(0,0,0,.02) 100%);z-index:1;pointer-events:none}
.fntv-ph-s2-content{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;flex-direction:column;justify-content:flex-end;padding:2rem 2.5rem 4.6rem;gap:.7rem;box-sizing:border-box}
.fntv-ph-s2-meta{width:96px;height:12px;border-radius:6px}
.fntv-ph-s2-title{width:48%;height:48px;border-radius:12px}
.fntv-ph-s2-desc{width:62%;height:12px;border-radius:6px}
.fntv-ph-s2-desc.s2{width:42%}
.fntv-ph-s2-actions{display:flex;gap:.8rem;margin-top:.7rem}
.fntv-ph-s2-btn{width:124px;height:44px;border-radius:50px}
.fntv-ph-s2-footer{position:absolute;left:0;right:0;bottom:0;z-index:7;width:100%;box-sizing:border-box;display:flex;align-items:center;gap:1.2rem;padding:0 2.5rem 16px}
.fntv-ph-s2-status{font-size:12.5px;color:rgba(232,221,208,.82);letter-spacing:.5px;flex:0 0 auto;white-space:nowrap}
.fntv-ph-s2-pct{font-size:12.5px;color:rgba(240,184,92,.95);letter-spacing:.5px;flex:0 0 auto;font-variant-numeric:tabular-nums;font-weight:700}
.fntv-ph-s2-pbar{flex:1;height:4px;background:rgba(255,255,255,.12);border-radius:4px;overflow:hidden;position:relative}
.fntv-ph-s2-pfill{height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,#d4a04c,#f0b85c);transition:width .25s ease;box-shadow:0 0 10px rgba(240,184,92,.5)}
.fntv-ph-s2-dots{display:flex;gap:8px;align-items:center;flex:0 0 auto}
.fntv-ph-s2-dot{width:8px;height:8px;border-radius:50%;background:rgba(160,140,110,.4);border:1px solid rgba(255,255,255,.3)}
.fntv-ph-s2-dot.active{background:#f0b85c;transform:scale(1.4);box-shadow:0 0 10px rgba(240,184,92,.6);border-color:#fff}
/* [lc-815] 浅色模式骨架(适配 fnOS 浅色主题): 统一浅色设计, 复用 .fnos-ph-skel 的浅色微光(var 随主题切换) */
.fntv-ph-l-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(255,255,255,.9) 0%,rgba(255,255,255,.55) 26%,rgba(255,255,255,.18) 58%,rgba(255,255,255,.04) 78%,transparent 100%);z-index:1;pointer-events:none}
.fntv-ph-l-content{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;flex-direction:column;justify-content:flex-end;padding:2rem 2.5rem 4.6rem;gap:.7rem;box-sizing:border-box}
.fntv-ph-l-meta{width:96px;height:12px;border-radius:6px;background:#cfd6e2}
.fntv-ph-l-title{width:48%;height:48px;border-radius:12px;background:#c6cedb}
.fntv-ph-l-desc{width:62%;height:12px;border-radius:6px;background:#d2d9e4}
.fntv-ph-l-desc.s2{width:42%}
.fntv-ph-l-actions{display:flex;gap:.8rem;margin-top:.7rem}
.fntv-ph-l-btn{width:124px;height:44px;border-radius:50px;background:#cdd5e1}
.fntv-ph-l-footer{position:absolute;left:0;right:0;bottom:0;z-index:7;width:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:1.2rem;padding:0 2.5rem 16px}
.fntv-ph-l-status{font-size:12.5px;color:rgba(96,88,74,.9);letter-spacing:.5px;flex:0 0 auto;white-space:nowrap;font-weight:600}
.fntv-ph-l-pct{font-size:12.5px;color:#c8923a;letter-spacing:.5px;flex:0 0 auto;font-variant-numeric:tabular-nums;font-weight:700}
.fntv-ph-l-pbar{width:280px;max-width:60%;flex:0 0 auto;height:4px;background:rgba(20,30,60,.12);border-radius:4px;overflow:hidden;position:relative}
.fntv-ph-l-pfill{height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,#d4a04c,#f0b85c);transition:width .25s ease}
.fntv-ph-l-dots{display:flex;gap:8px;align-items:center;flex:0 0 auto}
.fntv-ph-l-dot{width:8px;height:8px;border-radius:50%;background:rgba(120,110,95,.3);border:1px solid rgba(60,50,40,.18)}
.fntv-ph-l-dot.active{background:#e0a24c;transform:scale(1.4);border-color:#fff}
.fntv-ph-l-text{color:#5a5448}
/* [lc-839+] 样式4 骨架不再自创 CSS: 直接复用真实样式4 轮播的 .fntv-s4-* 类(同款 DOM 结构 + 同款 CSS, 由 ensureStyle4Css() 注入),
   仅把真实图片/文字替换为 shimmer 占位块, 呈现"暂停态空轮播" —— 加载完视觉零跳变。故此处无 .fntv-ph-s4-* 规则。 */
/* [lc-841] 样式4 骨架深浅适配: 占位条 / 指示点 / 进度条随主题切换 —— 由 container[data-fntv-skel] 控制 */
.fntv-s4-skelbg{position:relative;width:100%;height:100%;overflow:hidden}
.fntv-s4-skel{position:relative;overflow:hidden}
.fntv-s4-skel::after{content:'';position:absolute;inset:0;transform:translateX(-120%);animation:fnos-ph-shimmer 1.5s infinite;pointer-events:none}
[data-fntv-skel="dark"] .fntv-s4-skel{background:rgba(255,255,255,.20)}
[data-fntv-skel="dark"] .fntv-s4-skel::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)}
[data-fntv-skel="light"] .fntv-s4-skel{background:rgba(60,50,40,.15)}
[data-fntv-skel="light"] .fntv-s4-skel::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),transparent)}
[data-fntv-skel="light"] .fntv-s4-dot{background:rgba(120,110,95,.35);border-color:rgba(60,50,40,.25)}
[data-fntv-skel="light"] .fntv-s4-dot.active{background:#e0a24c;border-color:#fff}
[data-fntv-skel="light"] .fnos-ph-track{background:rgba(60,50,40,.12)}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  target.innerHTML = '';
  // [lc-444] 同上: 清掉section自身顶部边框/阴影/上边距, 避免细黑线
  target.style.borderTop = 'none';
  target.style.boxShadow = 'none';
  target.style.marginTop = '0';
  target.style.background = 'transparent';
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:0';
  S.carouselWrapper = wrapper;

  // [lc-805/lc-815] 按当前轮播样式 + 系统明暗渲染骨架: 样式2 用满铺暗底+底部内容占位(与样式2 轮播视觉一致),
  //   浅色模式改用浅色骨架, 避免"先样式1 紫底骨架→加载完才切样式2"或"暗色骨架压在浅色 fnOS 上的突兀跳变。
  const _cs = ((): number => { const v = parseInt(localStorage.getItem('fnos-carousel-style') || '4', 10); return (v >= 1 && v <= 4) ? v : 4; })();
  const _isDark = getEffectiveDark(); // [lc-815] 跟随 fnOS 明暗主题

  const container = document.createElement('div');
  container.setAttribute('data-fntv-carousel-style', String(_cs));
  const _blur = 'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%)';
  if (!_isDark && _cs !== 4) {
    // [lc-815] 浅色模式: 统一浅色容器(适配 fnOS 浅色主题); 样式4 例外(透明无框, 见下方分支, 与真实样式4 一致)
    container.style.cssText = `position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(160deg,#eef1f6,#dde3ec);${_blur};margin:0 auto;box-shadow:0 18px 50px -14px rgba(40,50,80,.18)`;
  } else if (_cs === 2 || _cs === 3) {
    // 样式2/3 暗色骨架: 高度与真实轮播一致, 满铺暗底, 避免加载完高度跳变
    container.style.cssText = `position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(160deg,rgba(120,130,160,.22),#0b1219);${_blur};box-shadow:0 26px 60px -12px rgba(0,0,0,.55)`;
  } else if (_cs === 4) {
    // [lc-834] 样式4 骨架容器: 透明无框(与真实样式4 一致, 无背景无边框); 高度走 calc(100vh - 380px) 与真实样式4/样式1 一致, 避免加载完高度跳变
    container.style.cssText = `position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:transparent;margin:0 auto;box-shadow:none`;
  } else {
    container.style.cssText = `position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(155deg,rgba(145,115,215,.22),rgba(70,50,120,.34));${_blur};margin:0 auto;box-shadow:none`;
  }
  S.carouselContainer = container;

  let fillEl: HTMLElement, percentEl: HTMLElement, statusEl: HTMLElement;

  if (!_isDark && _cs !== 4) {
    // [lc-815] 浅色模式骨架: 统一浅色设计(复用 .fnos-ph-skel 的浅色微光, var 随 html.dark 自动切换), 布局与暗色样式2 一致; 样式4 例外(见下方 _cs===4 分支, 自带暗色 3D 骨架不受主题影响)
    const overlay = document.createElement('div');
    overlay.className = 'fntv-ph-l-overlay';
    container.appendChild(overlay);
    const content = document.createElement('div');
    content.className = 'fntv-ph-l-content';
    const meta = document.createElement('div'); meta.className = 'fnos-ph-skel fntv-ph-l-meta';
    const title = document.createElement('div'); title.className = 'fnos-ph-skel fntv-ph-l-title';
    const desc1 = document.createElement('div'); desc1.className = 'fnos-ph-skel fntv-ph-l-desc';
    const desc2 = document.createElement('div'); desc2.className = 'fnos-ph-skel fntv-ph-l-desc s2';
    const actions = document.createElement('div'); actions.className = 'fntv-ph-l-actions';
    const btn1 = document.createElement('div'); btn1.className = 'fnos-ph-skel fntv-ph-l-btn';
    const btn2 = document.createElement('div'); btn2.className = 'fnos-ph-skel fntv-ph-l-btn';
    actions.appendChild(btn1); actions.appendChild(btn2);
    content.appendChild(meta); content.appendChild(title); content.appendChild(desc1); content.appendChild(desc2); content.appendChild(actions);
    container.appendChild(content);
    const footer = document.createElement('div');
    footer.className = 'fntv-ph-l-footer';
    statusEl = document.createElement('div'); statusEl.className = 'fntv-ph-l-status fnos-ph-text'; statusEl.textContent = '加载中…';
    percentEl = document.createElement('div'); percentEl.className = 'fntv-ph-l-pct'; percentEl.textContent = '0%';
    const pbar = document.createElement('div'); pbar.className = 'fntv-ph-l-pbar';
    fillEl = document.createElement('div'); fillEl.className = 'fntv-ph-l-pfill';
    pbar.appendChild(fillEl);
    const dots = document.createElement('div'); dots.className = 'fntv-ph-l-dots';
    for (let i = 0; i < 5; i++) { const d = document.createElement('span'); d.className = 'fntv-ph-l-dot' + (i === 0 ? ' active' : ''); dots.appendChild(d); }
    footer.appendChild(statusEl); footer.appendChild(percentEl); footer.appendChild(pbar); footer.appendChild(dots);
    container.appendChild(footer);
  } else if (_cs === 2) {
    // [lc-805/lc-809] 样式2 骨架: 暗底 + 底部内容占位(标题/简介/按钮) + 底部进度条/指示点, 与样式2 暗色轮播视觉一致
    const overlay = document.createElement('div');
    overlay.className = 'fntv-ph-s2-overlay';
    container.appendChild(overlay);
    const content = document.createElement('div');
    content.className = 'fntv-ph-s2-content';
    const meta = document.createElement('div'); meta.className = 'fnos-ph-skel fntv-ph-s2-meta';
    const title = document.createElement('div'); title.className = 'fnos-ph-skel fntv-ph-s2-title';
    const desc1 = document.createElement('div'); desc1.className = 'fnos-ph-skel fntv-ph-s2-desc';
    const desc2 = document.createElement('div'); desc2.className = 'fnos-ph-skel fntv-ph-s2-desc s2';
    const actions = document.createElement('div'); actions.className = 'fntv-ph-s2-actions';
    const btn1 = document.createElement('div'); btn1.className = 'fnos-ph-skel fntv-ph-s2-btn';
    const btn2 = document.createElement('div'); btn2.className = 'fnos-ph-skel fntv-ph-s2-btn';
    actions.appendChild(btn1); actions.appendChild(btn2);
    content.appendChild(meta); content.appendChild(title); content.appendChild(desc1); content.appendChild(desc2); content.appendChild(actions);
    container.appendChild(content);
    // [lc-816] 底部居中进度条: 套用样式1 的 .fnos-ph-track/.fnos-ph-fill(紫色渐变药丸), 与样式1 视觉一致
    const s2BarBox = document.createElement('div');
    s2BarBox.style.cssText = 'position:absolute;left:0;right:0;bottom:18px;z-index:7;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none';
    statusEl = document.createElement('div');
    statusEl.className = 'fnos-ph-text';
    statusEl.style.cssText = 'font-size:12.5px;color:rgba(225,218,245,.85);letter-spacing:.5px;font-weight:600;text-align:center';
    statusEl.textContent = '加载中…';
    percentEl = document.createElement('div');
    percentEl.style.cssText = 'font-size:13px;font-weight:700;color:rgba(232,221,208,.92);font-variant-numeric:tabular-nums;letter-spacing:.5px';
    percentEl.textContent = '0%';
    const s2Track = document.createElement('div');
    s2Track.className = 'fnos-ph-track';
    fillEl = document.createElement('div');
    fillEl.className = 'fnos-ph-fill';
    s2Track.appendChild(fillEl);
    s2BarBox.appendChild(statusEl);
    s2BarBox.appendChild(percentEl);
    s2BarBox.appendChild(s2Track);
    container.appendChild(s2BarBox);
  } else if (_cs === 3) {
    // [lc-811+] 样式3 骨架: 暗底 + 整体 shimmer + 居中"加载中"文字, 无进度条/百分比/指示点(与样式2 区分)
    const shimmer = document.createElement('div');
    shimmer.className = 'fnos-ph-skel';
    shimmer.style.cssText = 'position:absolute;inset:0;opacity:.45;z-index:1';
    container.appendChild(shimmer);
    const tip = document.createElement('div');
    tip.className = 'fnos-ph-text';
    tip.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px;color:rgba(232,221,208,.85);letter-spacing:1.2px;font-weight:600;z-index:2';
    tip.textContent = '加载中…';
    container.appendChild(tip);
    // [lc-816] 底部居中进度条: 套用样式1 的 .fnos-ph-track/.fnos-ph-fill(紫色渐变药丸)
    const s3BarBox = document.createElement('div');
    s3BarBox.style.cssText = 'position:absolute;left:0;right:0;bottom:18px;z-index:7;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none';
    percentEl = document.createElement('div');
    percentEl.style.cssText = 'font-size:13px;font-weight:700;color:rgba(232,221,208,.92);font-variant-numeric:tabular-nums;letter-spacing:.5px';
    percentEl.textContent = '0%';
    const s3Track = document.createElement('div');
    s3Track.className = 'fnos-ph-track';
    fillEl = document.createElement('div');
    fillEl.className = 'fnos-ph-fill';
    s3Track.appendChild(fillEl);
    s3BarBox.appendChild(percentEl);
    s3BarBox.appendChild(s3Track);
    container.appendChild(s3BarBox);
    statusEl = tip; // 居中"加载中…"作为状态/诊断文本(供超时提示覆盖)
  } else if (_cs === 4) {
    // [lc-839+] 样式4 骨架 = 真实轮播的「暂停态空壳」: 直接复用 ensureStyle4Css() 注入的 .fntv-s4-* 真实类构建同款 DOM,
    // 仅把真实图片/文字替换为 shimmer 占位块。视觉与加载完成后的真实轮播零跳变。
    ensureStyle4Css();
    container.setAttribute('data-fntv-skel', _isDark ? 'dark' : 'light');
    // 深浅配色(占位条/指示点/进度条文字): 深色模式用浅色文字, 浅色模式用深棕文字
    const sk = _isDark
      ? { tip: 'rgba(225,218,245,.85)', pct: 'rgba(232,221,208,.92)' }
      : { tip: 'rgba(96,88,74,.92)', pct: 'rgba(60,50,40,.92)' };
    // 3D 舞台(track) + 三张卡(中间 active + 左右 prev/next, 与真实一致, 侧卡被 overflow:hidden 裁掉只露肩)
    const track = document.createElement('div');
    track.className = 'fntv-s4-track';
    const mkS4Card = (cls: string): HTMLElement => {
      const card = document.createElement('div');
      card.className = 'fntv-s4-card' + (cls ? ' ' + cls : '');
      // 背景占位: 暗底 + 整卡 shimmer(模拟未加载的海报图)
      const bg = document.createElement('div');
      bg.className = 'fntv-s4-skelbg'; // [lc-842] 不复用 .fntv-s4-bg(其 ::before 写死黑色渐变遮罩, 会把浅色卡片压成深色); 仅作纯色占位 + shimmer
      bg.style.backgroundImage = 'none';
      bg.style.background = _isDark ? '#1e1b17' : '#e8f0fe'; // [lc-843→844] 浅色模式用淡蓝底(非灰非纯白); 深色保留 #1e1b17
      const shine = document.createElement('div');
      shine.className = 'fntv-s4-skel';
      shine.style.cssText = 'position:absolute;inset:0;opacity:.5;z-index:0';
      bg.appendChild(shine);
      // 信息区占位: 复用 .fntv-s4-info 真实类(定位/渐变遮罩同真实), 内部放占位条
      const info = document.createElement('div');
      info.className = 'fntv-s4-info';
      info.style.padding = '2rem 2rem 4.5rem'; // [lc-841] 抬高按钮行, 给底部「进度条 + 指示点」留出空间
      const mkBar = (w: string, h: string, extra = '') => {
        const b = document.createElement('div');
        b.className = 'fntv-s4-skel';
        b.style.cssText = `width:${w};height:${h};border-radius:${h === '11px' ? '6px' : '12px'};margin-bottom:.7rem;${extra}`;
        return b;
      };
      info.appendChild(mkBar('80px', '11px'));
      info.appendChild(mkBar('54%', '38px'));
      info.appendChild(mkBar('64%', '11px'));
      info.appendChild(mkBar('44%', '11px', 'margin-bottom:1rem'));
      const acts = document.createElement('div');
      acts.className = 'fntv-s4-actions';
      const b1 = document.createElement('div'); b1.className = 'fntv-s4-skel'; b1.style.cssText = 'width:104px;height:38px;border-radius:50px';
      const b2 = document.createElement('div'); b2.className = 'fntv-s4-skel'; b2.style.cssText = 'width:104px;height:38px;border-radius:50px';
      acts.appendChild(b1); acts.appendChild(b2);
      info.appendChild(acts);
      card.appendChild(bg); card.appendChild(info);
      return card;
    };
    const prevC = mkS4Card('prev');
    const nextC = mkS4Card('next');
    const activeC = mkS4Card('active');
    track.appendChild(prevC); track.appendChild(nextC); track.appendChild(activeC);
    container.appendChild(track);
    // 指示点(真实 .fntv-s4-dots, 居中贴在海报内)
    const dots4 = document.createElement('div'); dots4.className = 'fntv-s4-dots';
    for (let i = 0; i < 5; i++) { const d = document.createElement('span'); d.className = 'fntv-s4-dot' + (i === 0 ? ' active' : ''); dots4.appendChild(d); }
    container.appendChild(dots4);
    // [lc-816/lc-841] 底部居中进度: 紧凑(文字+百分比一行 + 进度条), 置于指示点上方
    const s4BarBox = document.createElement('div');
    s4BarBox.style.cssText = 'position:absolute;left:0;right:0;bottom:76px;z-index:20;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none';
    const s4TextRow = document.createElement('div');
    s4TextRow.style.cssText = 'display:flex;align-items:baseline;gap:8px;justify-content:center';
    const tip4 = document.createElement('div');
    tip4.className = 'fnos-ph-text';
    tip4.style.cssText = 'font-size:12.5px;color:' + sk.tip + ';letter-spacing:.5px;font-weight:600';
    tip4.textContent = '加载中…';
    percentEl = document.createElement('div');
    percentEl.style.cssText = 'font-size:13px;font-weight:700;color:' + sk.pct + ';font-variant-numeric:tabular-nums;letter-spacing:.5px';
    percentEl.textContent = '0%';
    s4TextRow.appendChild(tip4);
    s4TextRow.appendChild(percentEl);
    const s4Track = document.createElement('div');
    s4Track.className = 'fnos-ph-track';
    fillEl = document.createElement('div');
    fillEl.className = 'fnos-ph-fill';
    s4Track.appendChild(fillEl);
    s4BarBox.appendChild(s4TextRow);
    s4BarBox.appendChild(s4Track);
    container.appendChild(s4BarBox);
    statusEl = tip4;
  } else {
    // [lc-582] 样式1 骨架: 紫色渐变 + 装饰海报占位 + 中央进度(原逻辑, 保持不变)
    const deco = (l: string, t: string, r: string): HTMLElement => {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${l};top:${t};width:104px;height:152px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);transform:rotate(${r})`;
      return d;
    };
    container.appendChild(deco('6%', '14%', '-7deg'));
    container.appendChild(deco('14%', '26%', '4deg'));
    container.appendChild(deco('22%', '15%', '-2deg'));
    const shimmer = document.createElement('div');
    shimmer.className = 'fnos-ph-skel';
    shimmer.style.cssText = 'position:absolute;inset:0;opacity:.5;z-index:1';
    container.appendChild(shimmer);
    const center = document.createElement('div');
    center.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:2';
    percentEl = document.createElement('div');
    percentEl.className = 'fnos-ph-percent';
    percentEl.textContent = '0%';
    const trackEl = document.createElement('div');
    trackEl.className = 'fnos-ph-track';
    fillEl = document.createElement('div');
    fillEl.className = 'fnos-ph-fill';
    trackEl.appendChild(fillEl);
    statusEl = document.createElement('div');
    statusEl.className = 'fnos-ph-status';
    statusEl.textContent = '加载中';
    const textEl = document.createElement('div');
    textEl.className = 'fnos-ph-text';
    textEl.style.cssText = 'font-size:15px;color:rgba(240,236,255,.9);letter-spacing:1.2px;font-weight:600';
    textEl.textContent = '正在加载精彩内容';
    center.appendChild(percentEl);
    center.appendChild(trackEl);
    center.appendChild(statusEl);
    center.appendChild(textEl);
    container.appendChild(center);
  }

  // [lc-621] 伪进度: 前快后慢(参考模拟器增量策略), 每 120ms tick; 数据就绪后 completeCarouselProgress 补 100
  S.carouselBarFill = fillEl;
  S.carouselPctEl = percentEl;
  S.carouselStatusEl = statusEl;
  S.carouselProgressPct = 0;
  S.diagStuckTicks = 0; S.diagStuckSince = 0; S.diagStuckLogged = false; // [DIAG] 看门狗复位
  if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
  S.carouselProgressTimer = window.setInterval(() => {
    const p = S.carouselProgressPct;
    let inc: number;
    if (p < 30) inc = 1.4 + Math.random() * 1.2;       // 前段快
    else if (p < 70) inc = 0.9 + Math.random() * 0.9;  // 中段中速
    else inc = 0.4 + Math.random() * 0.5;              // 后段慢(等待详情补完)
    S.carouselProgressPct = Math.min(99, p + inc);
    fillEl.style.width = S.carouselProgressPct + '%';
    percentEl.textContent = Math.round(S.carouselProgressPct) + '%';
    // [DIAG] 99% 卡死看门狗：进度条封顶 99% 后若 ~15s(≈125 tick @120ms)仍未调用 completeCarouselProgress(跳 100)，记录诊断
    if (S.carouselProgressPct >= 99) {
      if (S.diagStuckTicks === 0) S.diagStuckSince = Date.now();
      S.diagStuckTicks++;
      if (S.diagStuckTicks > 125 && !S.diagStuckLogged) {
        S.diagStuckLogged = true;
        const landCnt = (S.apiShows || []).filter((s: any) => s && s.backdrop && !/poster-|poster\/|\/poster/i.test(s.backdrop)).length;
        const strmCnt = (S.apiShows || []).filter((s: any) => s && s.strmTag).length;
        log('[DIAG][WATCHDOG] 轮播进度卡在 99% 已超 15s，completeCarouselProgress 未触发 → 轮播不会显示。' +
            ` apiShows=${S.apiShows.length} 有横版backdrop=${landCnt} 疑似STRM项数=${strmCnt}` +
            ` diagLastShows=${S.diagLastShows.length}`);
      }
    } else {
      S.diagStuckTicks = 0;
    }
  }, 120);

  wrapper.appendChild(container);
  target.appendChild(wrapper);

  // [lc-561] 记录数字元素, 供 fetchShowsViaIPC 抓取过程中实时更新"已加载 N 个"
  S.carouselProgressEl = null; // [lc-583] 已改用长条进度, 数字元素废弃
  S.carouselProgressCount = 0;

  // 若真实片库始终未加载(如 NAS 未连接/接口超时), 一段时间后温和提示, 避免"正在加载"永久卡住
  const phTimer = window.setTimeout(() => {
    if (S.apiShows.length === 0 && S.carouselContainer === container && document.body.contains(container)) {
      const txt = container.querySelector('.fnos-ph-text') as HTMLElement | null;
      if (txt) txt.textContent = '加载较慢，请确认 NAS 已连接';
    }
  }, 16000);
  // 占位被重建替换后, 该定时器留在原地无害(条件判断已失效)
  void phTimer;
}

/** [lc-768] 候选海报全部无法加载(疑似 STR/网盘)时, 主页轮播区显示温和提示而非无限骨架。 */
export function buildStrmUnsupportedTip(target: HTMLElement): void {
  target.innerHTML = '';
  target.style.borderTop = 'none';
  target.style.boxShadow = 'none';
  target.style.marginTop = '0';
  target.style.background = 'transparent';
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:0';
  S.carouselWrapper = wrapper;
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(155deg,rgba(145,115,215,.18),rgba(70,50,120,.30));backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);margin:0 auto;box-shadow:none;display:flex;align-items:center;justify-content:center';
  const tip = document.createElement('div');
  tip.style.cssText = 'font-size:18px;color:rgba(240,236,255,.92);letter-spacing:1.5px;font-weight:600;text-align:center;padding:0 24px';
  tip.textContent = '暂未支持 STRm 海报';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:13px;color:rgba(225,218,245,.7);margin-top:10px;letter-spacing:.5px';
  sub.textContent = '当前片库以网盘 STRm 为主，海报暂无法加载';
  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px';
  col.appendChild(tip);
  col.appendChild(sub);
  container.appendChild(col);
  wrapper.appendChild(container);
  target.appendChild(wrapper);
  log('[lc-768] 已渲染「暂未支持 STRm 海报」主页提示');
}

/** [lc-627] 数据加载完成: 进度条从当前值快速补到 100%(ease-out 缓动, 约 600ms),
 *  完成后先【强制填满】(取消 transition 直接 100%, 避免 .25s 过渡动画未走完就被
 *  替换 DOM → 用户看到条停在 ~70%), 再延迟一帧让满条渲染, 状态文字「加载完成」,
 *  然后回调 onDone(注入轮播, 骨架淡出→轮播淡入) */
export function completeCarouselProgress(onDone?: () => void, reason?: string): void {
  // [DIAG] 记录触发来源，便于排查「卡在 99%」到底哪条路径没到（revealTimer-8s-timeout / details-ready / details-error）
  log('[DIAG] completeCarouselProgress 触发, reason=', reason || 'unknown', 'startPct=', Math.round(S.carouselProgressPct), 'apiShows=', S.apiShows.length);
  S.diagStuckTicks = 0; S.diagStuckLogged = false; // [DIAG] 看门狗复位：进度已推进到完成阶段
  if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
  const start = S.carouselProgressPct;
  const totalMs = 600;
  const stepMs = 30;
  const steps = Math.max(1, Math.ceil(totalMs / stepMs));
  let i = 0;
  S.carouselProgressTimer = window.setInterval(() => {
    i++;
    const t = i / steps;                       // 0→1
    const eased = 1 - Math.pow(1 - t, 3);      // ease-out: 前快后慢
    const pct = Math.min(100, start + (100 - start) * eased);
    S.carouselProgressPct = pct;
    if (S.carouselBarFill) S.carouselBarFill.style.width = pct + '%';
    if (S.carouselPctEl) S.carouselPctEl.textContent = Math.round(pct) + '%';
    if (i >= steps) {
      if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
      // [lc-627] 强制填满: 取消 transition 直接 100%, 确保条真正满格再切画面
      if (S.carouselBarFill) {
        S.carouselBarFill.style.transition = 'none';
        S.carouselBarFill.style.width = '100%';
      }
      if (S.carouselPctEl) S.carouselPctEl.textContent = '100%';
      if (S.carouselStatusEl) S.carouselStatusEl.textContent = '加载完成';
      // 延迟 60ms 让满条渲染一帧(骨架替换时用户看到的是满格条), 再回调
      window.setTimeout(() => {
        if (onDone) { try { onDone(); } catch (e) { /* ignore */ } }
      }, 60);
    }
  }, stepMs);
}

/** [lc-616] 更新骨架上的"已加载 N 个"数字（[lc-616] 已改 page-loading, 数字废弃, 空操作兼容调用方） */
export function updateCarouselProgress(count: number): void {
  S.carouselProgressCount = count;
}

/* 自动从API获取缺失的简介(IPC主进程签名→渲染进程fetch→带cookie鉴权) */
export function autoFetchDescs(base: string, shows: any[], infos: HTMLElement[]): void {
  shows.forEach((show, i) => {
    if (show.desc) return;
    setTimeout(async () => {
      try {
        const { ipcRenderer } = require('electron');
        const path = `/v/api/v1/item/${show.id}`;
        // 主进程生成Authx签名(需要crypto)，渲染进程fetch(带cookie)
        const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
        const resp = await fetch(`${base}${path}`, {
          credentials: 'include',
          headers: { 'Authx': authx }
        });
        const json = await resp.json();
        const desc = (json?.data?.overview || json?.data?.tv_overview || json?.data?.parent_overview || '').trim();
        log('desc API:', show.title, desc ? 'OK(' + desc.length + ')' : 'FAIL', 'code=' + json?.code);
        if (!desc) return;
        show.desc = desc;
        const info = infos[i];
        if (!info) return;
        const btn = info.querySelector('a');
        const descEl = info.querySelector('.fnos-desc') as HTMLElement | null;
        if (descEl) {
          descEl.textContent = desc;
        } else if (btn) {
          const d = document.createElement('div');
          d.className = 'fnos-desc';
          d.style.cssText = 'flex:1 1 auto;min-height:0;-webkit-line-clamp:4;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.72;color:var(--fnos-hero-desc);letter-spacing:.35px;font-weight:500;text-indent:2em;mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%)';
          d.textContent = desc;
          info.insertBefore(d, btn);
        }
      } catch (e) { log('desc error:', show.title, e); }
    }, i * 800);
  });
}

/* [lc-408] 把轮播右侧文字标题替换为透明 logo：
 * - API 真实条目：优先用 show.tmdbId 查 logo；无 tmdbId 时退用 show.title 标题匹配查 TMDB → tmdb:image 代理转 base64
 * - 硬编码兜底条目（show.logo 本地 sys/img）：经 fetchImageAuth 取本地 logo
 * 获取成功才在左侧海报左下角显示 logo；右侧文字标题始终保留不隐藏；任一环节失败则保留文字标题（静默降级）。 */
/* [lc-785] 复用于样式 2 左上角 logo 取图：与原版(样式1) applyTitleLogo 同一套逻辑
 *   - 优先飞牛自带 logo(show.logo)，无则 TMDB 透明 logo(含纯白兜底)
 *   返回可直接作 <img src> 的 blob/dataURL，取不到返回 null。 */