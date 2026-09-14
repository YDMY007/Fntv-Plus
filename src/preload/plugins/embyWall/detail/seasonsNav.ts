// embyWall/detail/seasonsNav.ts — [多源刮削/UX] 剧集一级页季选择行的左右翻页箭头(v3 终版)
// ─────────────────────────────────────────────────────────────────────────────
// 背景(用户反馈「超过四季后面的就不显示」): N7 段(beautifyStyle)把季行做成 Apple TV 式
//   横滑行(overflow-x:auto + 滚动条隐藏)——多季剧第 5 季起无任何可见滑动入口。
// v3(用户定稿): 行最外两缘放**无背景**的 SVG 线性雪佛龙箭头, 点击整屏平滑翻页;
//   ≤4 季不出现; 箭头挂在季行的父容器(面板)上 —— 不在滚动容器内, 永不随内容滚出视野。
//   竖向定位 = **第一张「可见」季卡的海报图垂直中点**(= 播放按钮圆心高度);
//   ⚠ 必须每次 ensure 现量现算 + 按「可见尺寸 ≥80px」过滤 —— DOM 前部存在隐藏克隆卡,
//   直接取第一张会量到 0 高/错位; 页面布局会随 hero 收起/图片加载漂移 → 每次 ensure 重测。
// 韧性: React 重渲染重建季行 → 绑定行失效时自动重绑; 卸载器两遍编译不涉及本模块。
// ─────────────────────────────────────────────────────────────────────────────

import { dlog } from '../log';

const LEFT_ID = 'fnos-season-nav-l';
const RIGHT_ID = 'fnos-season-nav-r';
const ROW_SEL = 'div[class="relative box-border flex w-full flex-col px-[44px]"] > div[class*="flex-wrap"]';
const TV_PAGE_RE = /\/v\/tv\/[a-f0-9]{32}/;
/** 一屏恰好 4 张季卡(卡宽 25%-11px), 超过才需要箭头(用户定稿) */
const THRESHOLD = 4;
const RETRY_DELAYS = [0, 400, 1000, 2000, 3400, 5000];

let boundRow: HTMLElement | null = null;
let _resizeArmed = false;
let _retryTimers: number[] = [];

function seasonRow(): HTMLElement | null {
  if (!TV_PAGE_RE.test(location.pathname)) return null;
  return document.querySelector(ROW_SEL);
}

function cardCount(row: HTMLElement): number {
  return row.querySelectorAll('[data-id="details"]').length;
}

/** SVG 线性雪佛龙(Apple 风): 无背景, 白描边 + 投影保证任何海报色上可读; 很浅, 悬停加深 */
function makeChevron(id: string, side: 'l' | 'r'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.setAttribute('data-fnos-ui', '1');
  b.setAttribute('aria-label', side === 'l' ? '上一页季' : '下一页季');
  b.style.cssText = [
    'position:absolute', 'width:38px', 'height:38px',
    'display:flex', 'align-items:center', 'justify-content:center',
    'border:none', 'background:none', 'padding:0', 'margin:0', 'cursor:pointer',
    'color:rgba(255,255,255,.92)',
    'filter:drop-shadow(0 1px 3px rgba(0,0,0,.65)) drop-shadow(0 0 8px rgba(0,0,0,.30))',
    'opacity:.55', 'transition:opacity .18s ease,transform .15s ease',
    'z-index:7', '-webkit-app-region:no-drag', 'user-select:none', 'visibility:hidden',
  ].join(';') + ';';
  const d = side === 'l' ? 'M15 5 L8 12 L15 19' : 'M9 5 L16 12 L9 19';
  const svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">'
    + '<path d="' + d + '" stroke="currentColor" stroke-width="2.6" '
    + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.appendChild(document.createRange().createContextualFragment(svg));
  b.addEventListener('mouseenter', () => { b.style.opacity = '.95'; b.style.transform = 'scale(1.14)'; });
  b.addEventListener('mouseleave', () => { b.style.opacity = '.55'; b.style.transform = ''; });
  return b;
}

function updateStates(row: HTMLElement, left: HTMLElement, right: HTMLElement): void {
  const max = row.scrollWidth - row.clientWidth;
  const x = row.scrollLeft;
  const atStart = x <= 4;
  const atEnd = x >= max - 4;
  left.style.opacity = atStart ? '.14' : '.55';
  right.style.opacity = atEnd ? '.14' : '.55';
  left.style.pointerEvents = atStart ? 'none' : 'auto';
  right.style.pointerEvents = atEnd ? 'none' : 'auto';
}

/** 重测海报中心并重新定位(面板坐标系; 现量现算 —— 布局随 hero 收起/图片加载漂移) */
function repositionArrows(row: HTMLElement, left: HTMLElement, right: HTMLElement): void {
  const panel = row.parentElement;
  if (!panel) return;
  const pr = panel.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const rowX = rr.left - pr.left;
  // 竖向目标 = 播放按钮圆心 ≈ 第一张「可见」季卡的海报图垂直中点
  let cy = -1;
  const cards = row.querySelectorAll('[data-id="details"]');
  for (let ci = 0; ci < cards.length; ci++) {
    const card = cards[ci] as HTMLElement;
    const cr = card.getBoundingClientRect();
    if (cr.width < 80 || cr.height < 80) continue;        // 跳过隐藏/未布局克隆
    const img = card.querySelector('.poster-box img, .poster-box, img');
    const ir = img ? img.getBoundingClientRect() : null;
    if (ir && ir.height > 60) {
      cy = ir.top - pr.top + ir.height / 2;
    } else {
      cy = cr.top - pr.top + cr.height * 0.4;
    }
    break;
  }
  if (cy < 0) cy = (rr.top - pr.top) + Math.min(rr.height * 0.4, 112);
  left.style.left = (rowX - 28) + 'px';              // 外边距槽: 紧贴卡片左缘(不压卡)
  right.style.left = (rowX + rr.width + 2) + 'px';   // 外边距槽: 紧贴卡片右缘(不压卡)
  left.style.top = (cy - 19) + 'px';
  right.style.top = (cy - 19) + 'px';
}

/** 位置稳定检测: 布局漂移期箭头保持隐藏, 连续两次定位一致才揭示 —— 消除「先错位后闪正」 */
function revealWhenStable(row: HTMLElement, left: HTMLElement, right: HTMLElement): void {
    let lastSig = '';
    let stable = 0;
    let ticks = 0;
    const tick = (): void => {
        if (!left.isConnected) return;                          // 箭头已被移除(翻页/离开页面)
        repositionArrows(row, left, right);
        const sig = left.style.left + '|' + left.style.top;
        stable = sig === lastSig ? stable + 1 : 0;
        lastSig = sig;
        if (stable >= 2 || ticks >= 25) {
            left.style.visibility = 'visible';
            right.style.visibility = 'visible';
            updateStates(row, left, right);
            return;
        }
        ticks++;
        window.setTimeout(tick, 120);
    };
    tick();
}

function removeArrows(): void {
  for (const id of [LEFT_ID, RIGHT_ID]) {
    const b = document.getElementById(id);
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  boundRow = null;
}

function ensureArrows(): void {
  const row = seasonRow();
  if (!row) { removeArrows(); return; }
  if (cardCount(row) <= THRESHOLD) { removeArrows(); return; }

  const panel = row.parentElement; // SERIES_PANEL(position:relative, 不滚动) —— 箭头挂载点
  if (!panel) { removeArrows(); return; }

  // 已挂且仍挂在同一面板 → 重绑失效的行引用 + 重定位(布局漂移后每次 ensure 都重新对位)
  const l = document.getElementById(LEFT_ID);
  const r = document.getElementById(RIGHT_ID);
  if (l && r && l.isConnected && r.isConnected && l.parentElement === panel && r.parentElement === panel) {
    if (boundRow !== row) {
      boundRow = row;
      row.addEventListener('scroll', () => updateStates(row, l, r), { passive: true });
    }
    repositionArrows(row, l, r);
    updateStates(row, l, r);
    revealWhenStable(row, l, r);
    return;
  }
  removeArrows();

  const left = makeChevron(LEFT_ID, 'l');
  const right = makeChevron(RIGHT_ID, 'r');
  const page = (dir: number): void => {
    if (boundRow !== row) return;
    row.scrollBy({ left: dir * Math.max(row.clientWidth, 200), behavior: 'smooth' });
  };
  left.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); page(-1); });
  right.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); page(1); });

  panel.appendChild(left);
  panel.appendChild(right);
  boundRow = row;
  row.addEventListener('scroll', () => updateStates(row, left, right), { passive: true });
  repositionArrows(row, left, right);
  updateStates(row, left, right);
  revealWhenStable(row, left, right);
  dlog('[seasonsNav] 箭头已挂载: ' + cardCount(row) + ' 季 @ ' + location.pathname);
}

export function ensureSeasonsNav(): void {
  try { ensureArrows(); } catch (e) { dlog('[seasonsNav] ensure 异常 ' + String(e).substring(0, 80)); }
}

export function removeSeasonsNav(): void {
  removeArrows();
}

/** 导航钩子调用: 剧集一级页 → 有界重试链挂箭头; 离开 → 撤箭头(与 scheduleEpBackfill 同节奏) */
export function scheduleSeasonsNav(): void {
  for (let i = 0; i < _retryTimers.length; i++) clearTimeout(_retryTimers[i]);
  _retryTimers = [];
  if (!TV_PAGE_RE.test(location.pathname)) { removeSeasonsNav(); return; }
  armResizeReposition();
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _retryTimers.push(window.setTimeout(() => {
      if (!TV_PAGE_RE.test(location.pathname)) return;
      ensureSeasonsNav();
    }, RETRY_DELAYS[i]));
  }
}

/** 窗口尺寸变化 → 箭头重定位 */
function armResizeReposition(): void {
  if (_resizeArmed) return;
  _resizeArmed = true;
  window.addEventListener('resize', () => {
    if (!boundRow) return;
    const l = document.getElementById(LEFT_ID);
    const r = document.getElementById(RIGHT_ID);
    if (l && r) { try { repositionArrows(boundRow, l, r); } catch (e) { /* ignore */ } }
  });
}
