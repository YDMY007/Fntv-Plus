// preload/plugins/hotUpdates.ts
// 「热门剧更新」浮层（宫灯版）：拉取正在播/热门的影视，支持 Bangumi 每日放送 与 TMDB 电影/剧集 两个数据源。
// 复用既有机制：preload 自动加载 → registerHook(OnReady) 注入 DOM → ipcRenderer 调主进程。
// 数据源：
//   · Bangumi —— 主进程 bangumi:calendar（/calendar 公开接口，无需 token），按星期/热度排序
//   · TMDB    —— 主进程 tmdb:discover（需用户在设置面板填写 TMDB Key），按热门/高分/最新排序
// 功能：① 数据源切换 ② 排序切换 ③ 卡片「不感兴趣」剔除 ④ localStorage 持久化屏蔽（按数据源隔离）
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';

const PANEL_ID = 'fntv-hot-updates';
const STYLE_ID = 'fntv-hot-updates-style';
const BLOCK_KEY = 'fntv-hot-blocked';          // localStorage 屏蔽列表键（值形如 "bg|123" / "tm|456"）
const WD_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 仅在飞牛主界面注入；跳过登录页(file://) 与外部页 */
function shouldInject(): boolean {
  const h = location.href.toLowerCase();
  return !h.startsWith('file:') && !h.includes('/login') && /^https?:\/\//.test(h);
}

/** 读取已屏蔽的条目 key 集合（持久化，key 含数据源前缀以隔离命名空间） */
function getBlockedSet(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(BLOCK_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function addBlocked(key: string): void {
  const s = getBlockedSet();
  s.add(key);
  try { localStorage.setItem(BLOCK_KEY, JSON.stringify([...s])); } catch { /* 忽略写入失败 */ }
}
function resetBlocked(): void {
  try { localStorage.removeItem(BLOCK_KEY); } catch { /* 忽略 */ }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
/* ===== 宫灯按钮 —— 悬浮发光、脉冲呼吸、一眼可见 ===== */
#fntv-hot-tab {
  position: fixed; right: 20px; bottom: 24px; z-index: 99998;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 18px; border-radius: 16px; cursor: pointer; user-select: none;
  font-size: 14px; font-weight: 700; color: #fff; letter-spacing: .5px;
  background: linear-gradient(135deg, #ff6b35, #f7418f, #c94bcb);
  background-size: 200% 200%;
  animation: fntv-gongdeng-grad 4s ease infinite, fntv-gongdeng-pulse 2.5s ease-in-out infinite;
  border: 1.5px solid rgba(255,255,255,.55);
  box-shadow:
    0 0 20px rgba(255,107,53,.45),
    0 0 50px rgba(247,65,143,.28),
    0 8px 32px rgba(0,0,0,.35),
    inset 0 1px 0 rgba(255,255,255,.45);
  transition: transform .2s ease, box-shadow .2s ease;
}
@keyframes fntv-gongdeng-grad {
  0%,100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}
@keyframes fntv-gongdeng-pulse {
  0%,100% { box-shadow:
    0 0 20px rgba(255,107,53,.45), 0 0 50px rgba(247,65,143,.28),
    0 8px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.45); }
  50% { box-shadow:
    0 0 30px rgba(255,107,53,.60), 0 0 70px rgba(247,65,143,.40),
    0 8px 36px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.55); }
}
#fntv-hot-tab:hover {
  transform: translateY(-3px) scale(1.04);
  box-shadow:
    0 0 28px rgba(255,107,53,.58), 0 0 68px rgba(247,65,143,.42),
    0 12px 40px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.55);
  animation: none;
  background: linear-gradient(135deg, #ff8c5a, #f76aa3, #d96bd6);
}
#fntv-hot-tab svg { width: 16px; height: 16px; display: block; filter: drop-shadow(0 0 4px rgba(255,255,255,.6)); }

@keyframes fntv-gongdeng-enter {
  0%   { opacity: 0; transform: translateY(20px) scale(.7); }
  60%  { opacity: 1; transform: translateY(-4px) scale(1.03); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
#fntv-hot-tab.entering { animation: fntv-gongdeng-enter .5s ease forwards; }

/* ===== 液态玻璃面板 ===== */
#fntv-hot-panel {
  position: fixed; right: 20px; bottom: 78px; z-index: 99999;
  width: 340px; max-height: 74vh; display: flex; flex-direction: column;
  border-radius: 20px; overflow: hidden; pointer-events: none;
  opacity: 0; transform: translateY(14px) scale(.97);
  transition: opacity .25s ease, transform .25s ease;
  background: linear-gradient(160deg, rgba(32,34,44,.55), rgba(18,20,28,.38));
  backdrop-filter: blur(32px) saturate(170%);
  -webkit-backdrop-filter: blur(32px) saturate(170%);
  border: 1px solid rgba(255,255,255,.28);
  box-shadow:
    0 20px 70px rgba(0,0,0,.50),
    0 0 80px rgba(255,107,53,.12),
    inset 0 1px 0 rgba(255,255,255,.35),
    inset 0 -1px 0 rgba(255,255,255,.08);
  color: #f2f3f7;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#fntv-hot-panel.open { opacity: 1; transform: none; pointer-events: auto; }

#fntv-hot-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px 11px;
  background: linear-gradient(135deg, rgba(255,107,53,.15), rgba(247,65,143,.10));
  border-bottom: 1px solid rgba(255,255,255,.12);
}
#fntv-hot-head .t { font-size: 15px; font-weight: 800;
  background: linear-gradient(135deg,#ff8c5a,#f76aae,#c94bcb);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
#fntv-hot-head .s { font-size: 11px; opacity:.58; margin-top: 2px; }
#fntv-hot-close { width: 26px; height: 26px; border: none; border-radius: 50%;
  background: rgba(255,255,255,.12); color: #fff; cursor: pointer; font-size: 15px;
  line-height: 1; display: flex; align-items: center; justify-content: center;
  transition: background .15s; }
#fntv-hot-close:hover { background: rgba(255,255,255,.24); }

/* 数据源分段控件（Bangumi / TMDB） */
#fntv-hot-src { display: flex; gap: 6px; padding: 9px 14px 4px; }
/* 排序分段控件 */
#fntv-hot-seg { display: flex; gap: 6px; padding: 4px 14px 6px; }
.fntv-seg-btn { flex: 1; padding: 6px 0; border: 1px solid rgba(255,255,255,.16);
  border-radius: 10px; background: rgba(255,255,255,.05); color: #f2f3f7;
  font-size: 12.5px; font-weight: 600; cursor: pointer; text-align: center;
  transition: all .15s ease; }
.fntv-seg-btn:hover { background: rgba(255,255,255,.12); }
.fntv-seg-btn.active {
  background: linear-gradient(135deg, #ff6b35, #f7418f);
  border-color: rgba(255,255,255,.4);
  box-shadow: 0 2px 12px rgba(255,107,53,.35), inset 0 1px 0 rgba(255,255,255,.4);
}

#fntv-hot-body { overflow-y: auto; padding: 6px 10px 10px; }
#fntv-hot-body::-webkit-scrollbar { width: 5px; }
#fntv-hot-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 3px; }

.fntv-hot-group { font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: rgba(255,255,255,.55); padding: 10px 4px 5px; display:flex; align-items:center; gap:6px; }

.fntv-hot-card { position: relative; display: flex; gap: 11px; padding: 10px;
  border-radius: 13px; cursor: pointer; transition: background .15s ease, transform .15s ease;
  border: 1px solid transparent; }
.fntv-hot-card:hover {
  background: rgba(255,255,255,.09);
  transform: translateX(-3px);
  border-color: rgba(255,107,53,.22);
  box-shadow: 0 4px 16px rgba(0,0,0,.20);
}
.fntv-hot-poster { width: 54px; height: 77px; border-radius: 9px; object-fit: cover;
  flex: 0 0 auto; background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.15);
  transition: transform .2s ease; }
.fntv-hot-card:hover .fntv-hot-poster { transform: scale(1.06); }
.fntv-hot-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fntv-hot-title { font-size: 13.5px; font-weight: 650; line-height: 1.32;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fntv-hot-sub { font-size: 11px; opacity:.65; margin-top: 4px; line-height: 1.4; }
.fntv-hot-badge { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px;
  font-size: 10.5px; flex-wrap: wrap; }
.fntv-hot-wd { background: rgba(120,180,255,.26); padding: 1.5px 7.5px; border-radius: 999px; color: #a8cfff; }
.fntv-hot-rt { background: rgba(255,200,90,.20); padding: 1.5px 7.5px; border-radius: 999px; color: #ffd666; }
.fntv-hot-tp { background: rgba(140,220,160,.22); padding: 1.5px 7.5px; border-radius: 999px; color: #9be3b0; }
.fntv-hot-yr { background: rgba(255,255,255,.14); padding: 1.5px 7.5px; border-radius: 999px; color: #e8e8ee; }

/* 不感兴趣按钮：默认隐藏，hover 卡片时浮现于右上角 */
.fntv-hot-block { position: absolute; top: 6px; right: 6px;
  width: 22px; height: 22px; border: none; border-radius: 50%;
  background: rgba(0,0,0,.45); color: #fff; font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  opacity: 0; transform: scale(.7); transition: opacity .15s, transform .15s, background .15s; }
.fntv-hot-card:hover .fntv-hot-block { opacity: 1; transform: scale(1); }
.fntv-hot-block:hover { background: rgba(255,80,80,.85); }

/* 屏蔽恢复条 */
#fntv-hot-reset { display: none; padding: 8px 14px; text-align: center;
  font-size: 11.5px; color: rgba(255,255,255,.6); cursor: pointer;
  border-top: 1px solid rgba(255,255,255,.1); }
#fntv-hot-reset:hover { color: #ffd666; }

.fntv-hot-loading, .fntv-hot-empty, .fntv-hot-err {
  padding: 30px 16px; text-align: center; font-size: 12.5px; opacity:.78; line-height: 1.6;
}
`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

function bestImage(images: any): string {
  if (!images || typeof images !== 'object') return '';
  const raw = images.common || images.grid || images.medium || images.large || images.small || '';
  return raw.replace(/^http:\/\//i, 'https://'); // 强制 https，防混合内容拦截
}

function weekdayCnOf(it: any): string {
  const w = it.air_weekday;
  if (typeof w === 'number' && w >= 1 && w <= 7) return WD_CN[w - 1];
  return it.weekdayCn || '';
}

/** Bangumi 卡片 */
function renderBgCard(it: any): string {
  const img = bestImage(it.images);
  const title = it.name_cn || it.name || '未知';
  const sub = [weekdayCnOf(it) ? `每周${weekdayCnOf(it)}更新` : '', it.eps ? `${it.eps} 话` : '']
    .filter(Boolean).join(' · ') || '正在放送';
  const wd = weekdayCnOf(it) ? `<span class="fntv-hot-wd">${weekdayCnOf(it)}</span>` : '';
  const rt = typeof it.rating === 'number' && it.rating ? `<span class="fntv-hot-rt">★ ${it.rating.toFixed(1)}</span>` : '';
  return `
  <div class="fntv-hot-card" data-id="bg|${it.id}" data-url="${it.url}">
    ${img ? `<img class="fntv-hot-poster" src="${img}" referrerpolicy="no-referrer" loading="lazy" alt="">`
           : `<div class="fntv-hot-poster"></div>`}
    <div class="fntv-hot-meta">
      <div class="fntv-hot-title">${escapeHtml(title)}</div>
      <div class="fntv-hot-sub">${escapeHtml(sub)}</div>
      <div class="fntv-hot-badge">${wd}${rt}</div>
    </div>
    <button class="fntv-hot-block" title="不感兴趣" data-id="bg|${it.id}">✕</button>
  </div>`;
}

/** TMDB 卡片（电影 / 剧集通用） */
function renderTmdbCard(it: any): string {
  const img = bestImage(it.images);
  const title = it.name_cn || it.name || '未知';
  const tp = it.mediaType === 'movie' ? '电影' : '剧集';
  const yr = it.year ? `<span class="fntv-hot-yr">${escapeHtml(it.year)}</span>` : '';
  const rt = typeof it.rating === 'number' && it.rating ? `<span class="fntv-hot-rt">★ ${it.rating.toFixed(1)}</span>` : '';
  return `
  <div class="fntv-hot-card" data-id="tm|${it.id}" data-url="${it.url}">
    ${img ? `<img class="fntv-hot-poster" src="${img}" referrerpolicy="no-referrer" loading="lazy" alt="">`
           : `<div class="fntv-hot-poster"></div>`}
    <div class="fntv-hot-meta">
      <div class="fntv-hot-title">${escapeHtml(title)}</div>
      <div class="fntv-hot-sub">${escapeHtml(tp)}</div>
      <div class="fntv-hot-badge"><span class="fntv-hot-tp">${tp}</span>${yr}${rt}</div>
    </div>
    <button class="fntv-hot-block" title="不感兴趣" data-id="tm|${it.id}">✕</button>
  </div>`;
}

/** Bangumi 排序渲染（weekday=分组按星期；hot=按热度纯列表） */
function renderBgBody(items: any[], mode: string): string {
  if (!items.length) return `<div class="fntv-hot-empty">暂无正在放送的条目</div>`;
  if (mode === 'weekday') {
    const groups: Record<number, any[]> = {};
    for (const it of items) {
      const w = (typeof it.air_weekday === 'number' && it.air_weekday >= 1 && it.air_weekday <= 7) ? it.air_weekday : 99;
      (groups[w] = groups[w] || []).push(it);
    }
    const order = Object.keys(groups).map(Number).sort((a, b) => a - b);
    let html = '';
    for (const w of order) {
      const label = w >= 1 && w <= 7 ? WD_CN[w - 1] : '其他';
      groups[w].sort((a, b) => (b.collectionTotal || 0) - (a.collectionTotal || 0));
      html += `<div class="fntv-hot-group">${label}</div>` + groups[w].map(renderBgCard).join('');
    }
    return html;
  }
  const sorted = items.slice().sort((a, b) => (b.collectionTotal || 0) - (a.collectionTotal || 0));
  return sorted.map(renderBgCard).join('');
}

/** TMDB 渲染（new=最新全部；tv=仅剧集；movie=仅电影） */
function renderTmdbBody(items: any[], mode: string): string {
  if (!items.length) return `<div class="fntv-hot-empty">暂无数据，请确认 TMDB Key 已填写</div>`;
  let list = items;
  if (mode === 'tv') list = items.filter((it) => it.mediaType === 'tv');
  else if (mode === 'movie') list = items.filter((it) => it.mediaType === 'movie');
  const sorted = list.slice().sort((a, b) => {
    if (mode === 'new') return (b.year || 0) - (a.year || 0);  // 最新：按年份
    return (b.popularity || 0) - (a.popularity || 0);           // 剧集/电影：按热度
  });
  return sorted.map(renderTmdbCard).join('');
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function buildPanel(): void {
  if (document.getElementById(PANEL_ID)) return;

  /* ---- 宫灯按钮（渐变发光 + 火焰图标）---- */
  const tab = document.createElement('div');
  tab.id = 'fntv-hot-tab';
  tab.innerHTML = `<span style="font-size:16px;line-height:1;">🔥</span><span>每日放送</span>`;

  /* ---- 液态玻璃面板 ---- */
  const panel = document.createElement('div');
  panel.id = 'fntv-hot-panel';
  panel.innerHTML = `
    <div id="fntv-hot-head">
      <div><div class="t">🔥 热门剧更新</div><div class="s" id="fntv-hot-sub">Bangumi 每日放送</div></div>
      <button id="fntv-hot-close" title="收起">×</button>
    </div>
    <div id="fntv-hot-src">
      <div class="fntv-seg-btn active" data-src="bangumi">Bangumi</div>
      <div class="fntv-seg-btn" data-src="tmdb">TMDB</div>
    </div>
    <div id="fntv-hot-seg">
      <div class="fntv-seg-btn active" data-mode="weekday">按星期</div>
      <div class="fntv-seg-btn" data-mode="hot">按热度</div>
    </div>
    <div id="fntv-hot-body"><div class="fntv-hot-loading">⏳ 正在加载…</div></div>
    <div id="fntv-hot-reset"></div>`;

  document.body.appendChild(tab);
  document.body.appendChild(panel);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tab.classList.add('entering');
      setTimeout(() => tab.classList.remove('entering'), 520);
    });
  });

  let loadedBg = false, loadedTm = false;
  let source = 'bangumi';     // 当前数据源
  let sortMode = 'weekday';   // 当前排序（按数据源各自解释）
  const allBg: any[] = [];
  const allTm: any[] = [];
  const body = panel.querySelector('#fntv-hot-body') as HTMLElement;
  const seg = panel.querySelector('#fntv-hot-seg') as HTMLElement;
  const srcSeg = panel.querySelector('#fntv-hot-src') as HTMLElement;
  const subEl = panel.querySelector('#fntv-hot-sub') as HTMLElement;
  const resetEl = panel.querySelector('#fntv-hot-reset') as HTMLElement;

  const refreshReset = (): void => {
    const n = getBlockedSet().size;
    if (n > 0) {
      resetEl.style.display = 'block';
      resetEl.textContent = `已屏蔽 ${n} 项 · 点击恢复`;
    } else {
      resetEl.style.display = 'none';
    }
  };

  // 根据数据源刷新排序分段的可选项 + 文案
  const applySourceUi = (): void => {
    if (source === 'bangumi') {
      seg.innerHTML = `
        <div class="fntv-seg-btn${sortMode === 'weekday' ? ' active' : ''}" data-mode="weekday">按星期</div>
        <div class="fntv-seg-btn${sortMode === 'hot' ? ' active' : ''}" data-mode="hot">按热度</div>`;
      subEl.textContent = 'Bangumi 每日放送';
    } else {
      seg.innerHTML = `
        <div class="fntv-seg-btn${sortMode === 'new' ? ' active' : ''}" data-mode="new">最新</div>
        <div class="fntv-seg-btn${sortMode === 'tv' ? ' active' : ''}" data-mode="tv">剧集</div>
        <div class="fntv-seg-btn${sortMode === 'movie' ? ' active' : ''}" data-mode="movie">电影</div>`;
      subEl.textContent = 'TMDB 最新 · 剧集 · 电影';
    }
    bindSeg();
  };

  const render = (): void => {
    const blocked = getBlockedSet();
    if (source === 'bangumi') {
      const visible = allBg.filter((it) => !blocked.has(`bg|${it.id}`));
      body.innerHTML = renderBgBody(visible, sortMode);
    } else {
      const visible = allTm.filter((it) => !blocked.has(`tm|${it.id}`));
      body.innerHTML = renderTmdbBody(visible, sortMode);
    }
  };

  // 排序分段点击（动态重建后需重新绑定）
  const bindSeg = (): void => {
    seg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.getAttribute('data-mode');
        if (!m || m === sortMode) return;
        sortMode = m;
        seg.querySelectorAll('[data-mode]').forEach((b) =>
          b.classList.toggle('active', b.getAttribute('data-mode') === m));
        render();
      });
    });
  };

  // 数据源切换
  srcSeg.querySelectorAll('[data-src]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-src');
      if (!s || s === source) return;
      source = s;
      // 切换数据源时重置排序为该源的默认项
      sortMode = s === 'bangumi' ? 'weekday' : 'new';
      srcSeg.querySelectorAll('[data-src]').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-src') === s));
      applySourceUi();
      render();
      // 首次切到某源时才拉数据
      if (source === 'bangumi' && !loadedBg) { loadedBg = true; loadBg(); }
      if (source === 'tmdb' && !loadedTm) { loadedTm = true; loadTm(); }
    });
  });

  // 卡片点击：不感兴趣 / 打开详情
  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const blockBtn = target.closest('.fntv-hot-block') as HTMLElement | null;
    if (blockBtn) {
      const key = blockBtn.getAttribute('data-id') || '';
      const card = blockBtn.closest('.fntv-hot-card') as HTMLElement | null;
      if (card) card.remove();
      if (key) addBlocked(key);
      refreshReset();
      return;
    }
    const card = target.closest('.fntv-hot-card') as HTMLElement | null;
    if (!card) return;
    const url = card.getAttribute('data-url');
    if (url) ipcRenderer.invoke('app:open-external', url).catch(() => {});
  });

  // 恢复屏蔽项
  resetEl.addEventListener('click', () => {
    resetBlocked();
    refreshReset();
    render();
  });

  const toggle = (): void => {
    const open = panel.classList.toggle('open');
    if (open && !loadedBg) {
      loadedBg = true;
      loadBg();
    }
  };
  tab.addEventListener('click', toggle);
  (panel.querySelector('#fntv-hot-close') as HTMLElement).addEventListener('click', () => {
    panel.classList.remove('open');
  });

  refreshReset();
  applySourceUi();

  async function loadBg(): Promise<void> {
    try {
      const res = await ipcRenderer.invoke('bangumi:calendar');
      if (!res || !res.ok) {
        body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
        return;
      }
      allBg.length = 0;
      for (const it of (res.items || [])) allBg.push(it);
      render();
    } catch (e: any) {
      body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml(String((e && e.message) || e))}</div>`;
    }
  }

  async function loadTm(): Promise<void> {
    try {
      const res = await ipcRenderer.invoke('tmdb:discover');
      if (!res || !res.ok) {
        body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
        return;
      }
      allTm.length = 0;
      for (const it of (res.items || [])) allTm.push(it);
      render();
    } catch (e: any) {
      body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml(String((e && e.message) || e))}</div>`;
    }
  }
}

function initHotUpdates(): void {
  if (!shouldInject()) return;
  injectStyle();
  buildPanel();
  logger.info('[hotUpdates] 热门剧更新浮层（宫灯版，Bangumi/TMDB 双源）已挂载');
}

registerHook(HookType.OnReady, initHotUpdates);
