// embyWall/detail/seasonNav.ts — Series 一级页季选行「左右切换圆钮」（>4 季溢出不可见的配套修复）
// ─────────────────────────────────────────────────────────────────────────────
// 病灶（用户报障：左下角季数超过 4 个就不显示）：N7 段把季行定成 4 张整卡一屏
//   （卡宽 25%-11px）+ overflow-x:auto + 滚动条隐藏——第 5 季起卡还在 DOM 里，但永远停在
//   视口右侧外，滚动条又不可见，用户无从得知还能滑 → 观感就是「不显示」。
// 修法：行溢出时在两翼加一对柔光玻璃圆钮（样式同 N4 收藏/已看圆钮：半透、无线条），
//   点击按一张卡宽步进横滑；到端自动淡化禁用。位置由 JS 实测第一张卡海报竖版中线钉
//   inline top/left/width（面板是 absolute 定位容器，offsetParent 即面板，几何稳定）。
// 自愈（React 会重建季行/改面板宽 600↔1020）：面板 MutationObserver（去抖）+ resize 重测，
//   每轮 _ensure 幂等：行没了/不溢出→摘钮；行被换→重挂滚动监听+重新测位。
// 生命周期：_apply 调 schedule（有界重试链，面板可能晚于 hero 渲染，同 tmdbCard 模式）；
//   _softReset/teardown 调 remove。只认 body.fnos-series-panel 作用域（美化 + Series 一级页），
//   Movie 一级页无季行、二级页结构不同，均不介入。
// ⚠ 外部节点插进 React 管理的面板是本仓库既有先例（TMDB 卡 appendChild 进同一面板），
//   React 按 ref 管理自家节点、不按序号删人，插队节点安全。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findActiveDetailView } from './glass';

// ⚠ 与 tmdbCard.ts SERIES_PANEL_SEL 逐字一致（同约定：两处各存一份，不共享常量，
//   避免把纯 CSS 文件拽进运行时依赖）。
const PANEL_SEL = 'div[class="relative box-border flex w-full flex-col px-[44px]"]';
const NAV_ID = 'fnos-season-nav';
/** 重试链（面板可能晚于 hero 渲染；跑完即止绝不轮询，同 SERIES_RETRY_DELAYS 节奏）。 */
const RETRY_DELAYS = [0, 350, 900, 1800, 3000, 4200];
/** 面板突变去抖 / resize 去抖。 */
const RESYNC_DEBOUNCE = 200;
/** 端点判定容差(px)。 */
const EDGE_EPS = 2;

let _timers: number[] = [];
let _scheduledFor: string | null = null;
let _panelObs: MutationObserver | null = null;
let _obsPanel: HTMLElement | null = null;
let _obsTimer = 0;
let _resizeTimer = 0;
let _resizeBound = false;
/** 滚动监听当前绑在哪个季行上（行被 React 换掉后要在旧行上解绑）。 */
let _boundRow: HTMLElement | null = null;
/** 当前钮对是为哪个季行构建的（React 重建行后节点引用变了，钮的 scrollBy 闭包会过期 → 重建钮对）。 */
let _navRow: WeakRef<HTMLElement> | null = null;

function _clearTimers(): void {
  for (let i = 0; i < _timers.length; i++) clearTimeout(_timers[i]);
  _timers = [];
}

function _unbindScroll(): void {
  if (_boundRow) {
    _boundRow.removeEventListener('scroll', _onRowScroll);
    _boundRow = null;
  }
}

function _onRowScroll(): void {
  const nav = document.getElementById(NAV_ID);
  if (nav && _boundRow) _setEndState(nav, _boundRow);
}

function _onResize(): void {
  clearTimeout(_resizeTimer);
  _resizeTimer = window.setTimeout(() => { _resizeTimer = 0; _ensure(); }, RESYNC_DEBOUNCE);
}

/** 到端状态：data-end=1 → N7b CSS 淡化 + 不可点。scrollWidth 含隐藏滚动条，端点容差 2px。 */
function _setEndState(nav: HTMLElement, row: HTMLElement): void {
  const btns = nav.querySelectorAll<HTMLButtonElement>('button');
  const max = row.scrollWidth - row.clientWidth;
  if (btns[0]) btns[0].setAttribute('data-end', row.scrollLeft <= EDGE_EPS ? '1' : '0');
  if (btns[1]) btns[1].setAttribute('data-end', row.scrollLeft >= max - EDGE_EPS ? '1' : '0');
}

/** 步进距离 = 一张卡 + 间隙（贴齐每季一格；卡不足 2 张时退半屏）。 */
function _step(row: HTMLElement): number {
  const cards = row.querySelectorAll<HTMLElement>(':scope > [data-id="details"]');
  if (cards.length >= 2) {
    const d = cards[1].offsetLeft - cards[0].offsetLeft;
    if (d > 0) return d;
  }
  return Math.max(80, Math.round(row.clientWidth / 2));
}

/** 重新测位 + 端点状态。面板是 absolute（N5）→ 行的 offsetParent 就是面板，offset* 稳定。 */
function _layout(nav: HTMLElement, row: HTMLElement): void {
  const rowRect = row.getBoundingClientRect();
  let centerY = rowRect.height / 2;
  const poster = row.querySelector<HTMLElement>('[data-id="details"] .poster-box');
  if (poster) {
    const pr = poster.getBoundingClientRect();
    if (pr.height > 0) centerY = pr.top - rowRect.top + pr.height / 2; // 对准海报竖版中线
  }
  nav.style.top = Math.round(row.offsetTop + centerY) + 'px';
  nav.style.left = Math.round(row.offsetLeft) + 'px';
  nav.style.width = Math.round(row.offsetWidth) + 'px';
  _setEndState(nav, row);
}

const CHEV_L = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none">'
  + '<path d="M8.8 3.2 5 7l3.8 3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV_R = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none">'
  + '<path d="M5.2 3.2 9 7l-3.8 3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function _mkBtn(dir: 'left' | 'right', row: HTMLElement): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', dir === 'left' ? '往前翻季' : '往后翻季');
  b.title = dir === 'left' ? '往前翻季' : '往后翻季';
  b.innerHTML = dir === 'left' ? CHEV_L : CHEV_R;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.scrollBy({ left: dir === 'left' ? -_step(row) : _step(row), behavior: 'smooth' });
  });
  return b;
}

/** 幂等收敛：守卫全绿→确保圆钮在位且测位准确；任一守卫失败→摘钮。 */
function _ensure(): void {
  try {
    if (!document.body || !document.body.classList.contains('fnos-series-panel')) { _removeNav(); return; }
    const view = findActiveDetailView();
    const panel = view ? view.querySelector<HTMLElement>(PANEL_SEL) : null;
    const row = panel ? panel.querySelector<HTMLElement>(':scope > div[class*="flex-wrap"]') : null;
    if (!panel || !row) { _removeNav(); _observePanel(null); return; }

    let nav = document.getElementById(NAV_ID);
    const overflow = row.scrollWidth > row.clientWidth + EDGE_EPS;
    if (!overflow) { if (nav) nav.remove(); _unbindScroll(); _navRow = null; return; }

    const staleRow = !_navRow || _navRow.deref() !== row; // 行重建 → 钮内 scrollBy 闭包过期
    if (!nav || !nav.isConnected || nav.parentElement !== panel || staleRow) {
      if (nav) nav.remove();
      nav = document.createElement('div');
      nav.id = NAV_ID;
      nav.className = 'fnos-season-nav'; // N7b CSS 按类匹配（id 仅供 getElementById 查找）
      nav.appendChild(_mkBtn('left', row));
      nav.appendChild(_mkBtn('right', row));
      row.after(nav); // 插在季行后（见文件头：外部节点进 React 面板有 TMDB 卡先例）
      _navRow = new WeakRef(row);
      dlog('seasonNav: 季行溢出 → 挂左右切换钮');
    }
    _unbindScroll();
    _boundRow = row;
    row.addEventListener('scroll', _onRowScroll, { passive: true });
    _layout(nav, row);
    _observePanel(panel);
    _bindResize();
  } catch (e) {
    dlog('seasonNav: ensure 异常 ' + String(e).substring(0, 80));
  }
}

function _removeNav(): void {
  _unbindScroll();
  _navRow = null;
  const nav = document.getElementById(NAV_ID);
  if (nav) nav.remove();
}

/** 面板 childList watcher：React 重建季行/简介回填/TMDB 卡挂载都会动面板 → 去抖重收敛。 */
function _observePanel(panel: HTMLElement | null): void {
  if (!panel) {
    if (_panelObs) { _panelObs.disconnect(); _panelObs = null; }
    _obsPanel = null;
    return;
  }
  if (_obsPanel === panel && _panelObs) return;
  if (!_panelObs) {
    _panelObs = new MutationObserver(() => {
      if (_obsTimer) return;
      _obsTimer = window.setTimeout(() => { _obsTimer = 0; _ensure(); }, RESYNC_DEBOUNCE);
    });
  }
  _panelObs.disconnect();
  _obsPanel = panel;
  _panelObs.observe(panel, { childList: true, subtree: true });
}

function _bindResize(): void {
  if (_resizeBound) return;
  window.addEventListener('resize', _onResize, { passive: true });
  _resizeBound = true;
}

function _unbindResize(): void {
  clearTimeout(_resizeTimer);
  _resizeTimer = 0;
  if (_resizeBound) {
    window.removeEventListener('resize', _onResize);
    _resizeBound = false;
  }
}

/** settle 后调度：同一 href 只排一次重试链（同 href 重复调用幂等）。 */
export function scheduleSeasonNav(): void {
  const href = location.href;
  if (_scheduledFor === href) return;
  _scheduledFor = href;
  _clearTimers();
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _timers.push(window.setTimeout(() => {
      if (_scheduledFor !== location.href) return;
      _ensure();
    }, RETRY_DELAYS[i]));
  }
}

/** 换页软复位/彻底清理：摘钮、断观察、解监听。 */
export function removeSeasonNav(): void {
  _scheduledFor = null;
  _clearTimers();
  if (_obsTimer) { clearTimeout(_obsTimer); _obsTimer = 0; }
  _observePanel(null);
  _unbindResize();
  _removeNav();
}
