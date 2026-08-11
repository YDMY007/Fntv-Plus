// preload/plugins/hotUpdates.ts
// 「热门剧更新」浮层（宫灯版）：拉取正在播/热门的影视，支持 Bangumi 每日放送 与 TMDB 电影/剧集 两个数据源。
// 复用既有机制：preload 自动加载 → registerHook(OnReady) 注入 DOM → ipcRenderer 调主进程。
// 数据源：
//   · Bangumi —— 主进程 bangumi:calendar（/calendar 公开接口，无需 token），按星期/热度排序
//   · TMDB    —— 主进程 tmdb:discover（需 Key，海外站，可能被墙）；豆瓣 —— 主进程 douban:discover（免 Key，国内直连）
//   · 数据源由设置面板「TMDB / 豆瓣」切换，默认豆瓣（国内直连、零配置）
// 功能：① 数据源切换 ② 排序切换 ③ 卡片「不感兴趣」剔除 ④ localStorage 持久化屏蔽（按数据源隔离）
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import logger from '../core/logger';

const PANEL_ID = 'fntv-hot-updates';
const STYLE_ID = 'fntv-hot-updates-style';
const BLOCK_KEY = 'fntv-hot-blocked';          // localStorage 屏蔽列表键（值形如 "bg|123" / "tm|456"）
const DAILY_VISIBLE_KEY = 'fnos-show-daily';    // [lc-363] 设置面板"外观"开关：首页「每日放送」按钮是否显示（默认显示）
const WD_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 仅在飞牛主界面注入；跳过登录页(file://) 与外部页 */
function shouldInject(): boolean {
  const h = location.href.toLowerCase();
  return !h.startsWith('file:') && !h.includes('/login') && /^https?:\/\//.test(h);
}

// ═══ 首页判定（与 titlebar.ts 的 logo 首页规则保持一致：仅 /v 等浅层路径视为首页，
//    详情/播放/搜索/列表/个人中心等子路由一律视为非首页） ═══
let _lastHotHome: boolean | null = null;
function isHomePage(): boolean {
  const href = location.href.toLowerCase();
  const path = (location.pathname || '/').toLowerCase();
  if (/\/v\/(tv|movie|anime|cartoon|documentary|variety|show)/.test(href)) return false; // 详情/播放
  if (/\/play($|\/|#)/.test(href) || /\/watch($|\/|#)/.test(href)) return false;          // 播放页
  if (/\/search/.test(href)) return false;                                                  // 搜索
  if (/\/(library|category|genre|channel|list|rank|ranking)/.test(href)) return false;     // 列表/分类
  if (/\/(mine|my|user|account|setting|settings|favorite|favourite|history|collection|subscribe)/.test(href)) return false; // 个人中心
  const segs = path.split('/').filter(Boolean);
  return segs.length <= 1;
}

/** 首页才显示「每日放送」浮窗，切到其他页面隐藏，避免遮挡内容 */
function syncHomeVisibility(): void {
  const home = isHomePage();
  if (home === _lastHotHome) return;           // 状态未变不重复操作（避免日志刷屏/无谓 DOM 写）
  _lastHotHome = home;
  const tab = document.getElementById('fntv-hot-tab');
  const panel = document.getElementById('fntv-hot-panel');
  if (!tab || !panel) return;
  if (home) {
    tab.style.display = '';
    panel.style.display = '';
    logger.info('[hotUpdates] 首页：显示每日放送浮窗');
  } else {
    tab.style.display = 'none';
    panel.style.display = 'none';
    panel.classList.remove('open');            // 切走时收起，回来不会自动弹开
    logger.info('[hotUpdates] 非首页：隐藏每日放送浮窗（避免遮挡）');
  }
}

/** [lc-363] 由设置面板「外观」开关控制首页「每日放送」按钮是否注入；默认显示（localStorage 不为 '0' 即显示） */
function applyDailyVisibility(): void {
  const on = localStorage.getItem(DAILY_VISIBLE_KEY) !== '0';
  const tab = document.getElementById('fntv-hot-tab');
  const panel = document.getElementById('fntv-hot-panel');
  if (on) {
    if (!tab && !panel) { buildPanel(); syncHomeVisibility(); } // 首次/重新开启：注入并按当前页面同步显隐
  } else {
    if (tab) tab.remove();
    if (panel) panel.remove();
    _lastHotHome = null; // 重置首页状态机，便于重新开启时正确同步
  }
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
  opacity: 0; visibility: hidden; transform: translateY(14px) scale(.97);
  transition: opacity .25s ease, transform .25s ease, visibility .25s ease;
  /* [lc-369] 彻底移除 backdrop-filter：透明窗口下 blur/saturate 是 GPU 崩溃元凶，
     fnOS/Electron 组合即使 blur(18px) 放一会也会未响应。改用高不透明度纯色背景，
     牺牲毛玻璃效果换取稳定性——功能可用 > 好看但卡死。 */
  background: rgba(24,26,34,.92);
  border: 1px solid rgba(255,255,255,.18);
  box-shadow:
    0 20px 70px rgba(0,0,0,.50),
    0 0 40px rgba(255,107,53,.08),
    inset 0 1px 0 rgba(255,255,255,.30),
    inset 0 -1px 0 rgba(255,255,255,.06);
  color: #f2f3f7;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#fntv-hot-panel.open { opacity: 1; visibility: visible; transform: none; pointer-events: auto; }

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
.fntv-hot-group.today { color: #ffd666; }
.fntv-hot-group.today::after { content: ''; flex: 1; height: 1px;
  background: linear-gradient(90deg, rgba(255,214,102,.5), rgba(255,214,102,0)); }

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

#fntv-hot-foot { display: flex; align-items: center; justify-content: space-between;
  padding: 7px 14px 9px; font-size: 11px; line-height: 1.4;
  color: rgba(255,255,255,.42); border-top: 1px solid rgba(255,255,255,.08); }
#fntv-hot-foot-time { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fntv-hot-refresh { flex: 0 0 auto; margin-left: 10px; padding: 3px 9px; cursor: pointer;
  font-size: 11px; color: rgba(255,255,255,.72); background: rgba(255,255,255,.1);
  border: 1px solid rgba(255,255,255,.16); border-radius: 10px; transition: background .15s, color .15s; }
#fntv-hot-refresh:hover { background: rgba(255,214,102,.22); color: #ffd666; }
#fntv-hot-refresh:disabled { opacity: .5; cursor: default; }
#fntv-hot-refresh.loading::after { content: "…"; }

.fntv-hot-loading, .fntv-hot-empty, .fntv-hot-err {
  padding: 30px 16px; text-align: center; font-size: 12.5px; opacity:.78; line-height: 1.6;
}
.fntv-hot-warn {
  margin: 8px 10px; padding: 7px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.5;
  color: #ffd666; background: rgba(255,180,60,.12); border: 1px solid rgba(255,180,60,.28);
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

/** Bangumi 卡片
 *  [lc-369] 海报改为 data-poster 模式（与 TMDB 一致），由 hydratePosters 统一经主进程代理加载。
 *  原因：渲染进程直接 <img src="bgm.tv/..."> 在透明窗口+多图并发下极易触发 GPU 未响应；
 *  走主进程代理可复用并发限制(5)+超时(8s)兜底，且绕过渲染进程 DNS 污染。 */
function renderBgCard(it: any): string {
  const img = bestImage(it.images);
  const titleCn = it.name_cn || '';
  const titleOrig = it.name || '';
  const title = titleCn || titleOrig || '未知';
  const sub = [weekdayCnOf(it) ? `每周${weekdayCnOf(it)}更新` : '', it.eps ? `${it.eps} 话` : '']
    .filter(Boolean).join(' · ') || '正在放送';
  const wd = weekdayCnOf(it) ? `<span class="fntv-hot-wd">${weekdayCnOf(it)}</span>` : '';
  const rt = typeof it.rating === 'number' && it.rating ? `<span class="fntv-hot-rt">★ ${it.rating.toFixed(1)}</span>` : '';
  return `
  <div class="fntv-hot-card" data-id="bg|${it.id}" data-url="${it.url}" data-title-cn="${escapeHtml(titleCn)}" data-title="${escapeHtml(titleOrig)}">
    ${img ? `<img class="fntv-hot-poster" data-poster="${img}" referrerpolicy="no-referrer" loading="lazy" alt="">`
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
  const titleCn = it.name_cn || '';
  const titleOrig = it.name || '';
  const title = titleCn || titleOrig || '未知';
  const tp = it.mediaType === 'movie' ? '电影' : '剧集';
  const yr = it.year ? `<span class="fntv-hot-yr">${escapeHtml(it.year)}</span>` : '';
  const rt = typeof it.rating === 'number' && it.rating ? `<span class="fntv-hot-rt">★ ${it.rating.toFixed(1)}</span>` : '';
  // 海报走主进程图片代理（tmdb:image），规避渲染进程 DNS 污染；data-poster 由 hydratePosters 填充
  return `
  <div class="fntv-hot-card" data-id="tm|${it.id}" data-url="${it.url}" data-title-cn="${escapeHtml(titleCn)}" data-title="${escapeHtml(titleOrig)}">
    ${img ? `<img class="fntv-hot-poster" data-poster="${img}" referrerpolicy="no-referrer" loading="lazy" alt="">`
           : `<div class="fntv-hot-poster"></div>`}
    <div class="fntv-hot-meta">
      <div class="fntv-hot-title">${escapeHtml(title)}</div>
      <div class="fntv-hot-sub">${escapeHtml(tp)}</div>
      <div class="fntv-hot-badge"><span class="fntv-hot-tp">${tp}</span>${yr}${rt}</div>
    </div>
    <button class="fntv-hot-block" title="不感兴趣" data-id="tm|${it.id}">✕</button>
  </div>`;
}

// [lc-370] 已加载海报的 URL→dataURL 映射：render 重建 DOM 后同一批图不再重复发 IPC，直接填充。
// 与主进程 _imgDataUrlCache 双保险——主进程防网络重下，此处防 IPC 重发。
const _posterCache = new Map<string, string>();

/** 把含 data-poster 的 <img> 经主进程图片代理拉取为 data URL
 *  路由：豆瓣 → douban:image（带 Referer 解防盗链 418）
 *       Bangumi / TMDB / 其他 → tmdb:image（通用图片代理，支持免梯子直连绕 DNS 污染）
 *  [lc-369] Bangumi 海报也走此通道，不再渲染进程直连 bgm.tv */
function hydratePosters(root: HTMLElement): void {
  const imgs = Array.from(root.querySelectorAll('img.fntv-hot-poster[data-poster]')) as any[];
  if (!imgs.length) return;
  // 并发限制 + 超时兜底: 多图 ipcRenderer.invoke 会堆积、拖慢主进程,
  // 间接加剧 transparent 窗口卡顿/崩溃。限制同时最多 5 个, 单个最长 8s 超时, 失败静默(留空)。
  const CONCURRENCY = 5;
  let cursor = 0;
  const worker = (): void => {
    while (cursor < imgs.length) {
      const el = imgs[cursor++];
      const url = el.getAttribute('data-poster');
      if (!url) continue;
      el.removeAttribute('data-poster');
      // 命中前端缓存：已加载过的图直接填，不发 IPC
      const cached = _posterCache.get(url);
      if (cached) { el.src = cached; continue; }
      // 按域名路由到对应主进程代理
      const isDouban = /doubanio\.com/i.test(url);
      // Bangumi 图片走 tmdb:image（通用代理，支持直连）；豆瓣走 douban:image（带 Referer）
      const req = ipcRenderer.invoke(isDouban ? 'douban:image' : 'tmdb:image', url);
      const timeout = new Promise<any>((resolve) => setTimeout(() => resolve(null), 8000));
      Promise.race([req, timeout]).then((r: any) => {
        if (r && r.ok && r.dataUrl) { _posterCache.set(url, r.dataUrl); el.src = r.dataUrl; }
      }).catch(() => { /* 加载失败则留空 */ }).finally(worker);
      return; // 本次 worker 仅发起一个请求, 由 finally 链式推进(并发上限=CONCURRENCY)
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, imgs.length); i++) worker();
}

/** 把 JS getDay()（0=周日…6=周六）转为 Bangumi air_weekday（1=周一…7=周日） */
function todayBangumiWeekday(): number {
  return ((new Date().getDay() + 6) % 7) + 1;
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
    // 按「今天优先」循环排序：今天 → 明天 → … → 周日 → 周一…，末尾放「其他」(99)。
    // 不再固定周一到周日，解决「周三打开却先看到周一」的问题。
    const today = todayBangumiWeekday();
    const order = Object.keys(groups).map(Number).sort((a, b) => {
      const rank = (w: number) => (w === 99 ? 999 : ((w - today + 7) % 7));
      return rank(a) - rank(b);
    });
    let html = '';
    for (const w of order) {
      const isToday = w === today;
      const label = w >= 1 && w <= 7 ? WD_CN[w - 1] : '其他';
      groups[w].sort((a, b) => (b.collectionTotal || 0) - (a.collectionTotal || 0));
      html += `<div class="fntv-hot-group${isToday ? ' today' : ''}">${label}${isToday ? ' · 今天' : ''}</div>` + groups[w].map(renderBgCard).join('');
    }
    return html;
  }
  const sorted = items.slice().sort((a, b) => (b.collectionTotal || 0) - (a.collectionTotal || 0));
  return sorted.map(renderBgCard).join('');
}

/** TMDB 渲染（new=最新全部；tv=仅剧集；movie=仅电影） */
function renderTmdbBody(items: any[], mode: string): string {
  if (!items.length) return `<div class="fntv-hot-empty">暂无数据（数据源未返回内容，详见日志 [豆瓣诊断]/[TMDB诊断]）</div>`;
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

// ═══════════════════════════════════════════════════════════════════════════
// [lc-457] 每日放送 → 飞牛影视库联动
//   点击卡片：库内已有该剧 → 直接站内跳详情页(/v/tv|movie/{hash})；
//            库内没有   → 退回打开 Bangumi / TMDB 外部链接。
//   实现：后台隐藏 iframe 抓 /v/list/all 全量条目(标题+详情页 hash)，去重缓存；
//        点击时用番剧名(中/原)与库索引做匹配。库索引只在首次懒加载一次。
// ═══════════════════════════════════════════════════════════════════════════
interface LibItem { title: string; href: string; mediaType: string; }
let _libIndex: LibItem[] | null = null;
let _libLoading = false;
let _libWaiters: ((v: LibItem[]) => void)[] = [];

/** 懒加载飞牛影视库索引（/v/list/all 全量去重条目）；并发调用只真正抓一次 */
function ensureLibraryIndex(): Promise<LibItem[]> {
  if (_libIndex) return Promise.resolve(_libIndex);
  if (_libLoading) {
    return new Promise((resolve) => {
      const t = setInterval(() => { if (_libIndex) { clearInterval(t); resolve(_libIndex); } }, 200);
      setTimeout(() => { clearInterval(t); resolve(_libIndex || []); }, 4000);
    });
  }
  _libLoading = true;
  return new Promise((resolve) => {
    const base = location.origin; // 当前即飞牛影视页，iframe 同源可读
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;z-index:-1;opacity:0;border:none;pointer-events:none';
    iframe.src = base + '/v/list/all';
    const map = new Map<string, LibItem>();
    let attempts = 0;
    const finish = (): void => {
      try { iframe.remove(); } catch { /* ignore */ }
      const idx: LibItem[] = Array.from(map.values());
      _libIndex = idx;
      _libLoading = false;
      _libWaiters.forEach((r) => r(idx)); _libWaiters = [];
      logger.info('[hotUpdates] 飞牛影视库索引构建完成', idx.length, '项');
      resolve(idx);
    };
    const poll = (): void => {
      attempts++;
      try {
        const doc: any = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) { if (attempts < 30) setTimeout(poll, 400); else finish(); return; }
        const links = doc.querySelectorAll('a[href*="/v/tv/"],a[href*="/v/movie/"]');
        if (links.length < 5 && attempts < 30) { setTimeout(poll, 400); return; }
        // 多次轮询收集（飞牛可能分批渲染/虚拟滚动），最多再收集若干轮
        links.forEach((a: any) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
          if (!m || map.has(m[2])) return;
          let el: any = a, title = '';
          for (let d = 0; d < 5 && !title; d++) {
            const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
            if (t.length > 4) title = t;
            el = el.parentElement;
          }
          if (!title) title = (a.getAttribute('title') || '').trim();
          if (!title) return;
          map.set(m[2], { title, href: base + '/v/' + m[1] + '/' + m[2], mediaType: m[1] });
        });
        if (attempts < 14) setTimeout(poll, 500); else finish();
      } catch (e) { if (attempts < 30) setTimeout(poll, 400); else finish(); }
    };
    iframe.onload = () => setTimeout(poll, 500);
    iframe.onerror = () => {
      try { iframe.remove(); } catch { /* ignore */ }
      _libIndex = []; _libLoading = false; _libWaiters.forEach((r) => r([])); _libWaiters = [];
      resolve([]);
    };
    document.body.appendChild(iframe);
  });
}

/** 标题归一化：去空白、去常见分隔符，便于中文/原名模糊匹配 */
function normalizeTitle(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, '').replace(/[：:·・\-—~～]/g, '');
}

/** 用番剧名(中/原)在库索引中匹配；精确优先，其次双向包含；无则返回 null */
function matchLibrary(titleCn: string, titleOrig: string): string | null {
  if (!_libIndex || !_libIndex.length) return null;
  const cands = [titleCn, titleOrig].map(normalizeTitle).filter((x) => x && x.length >= 2);
  if (!cands.length) return null;
  for (const c of cands) for (const it of _libIndex) if (normalizeTitle(it.title) === c) return it.href;
  for (const c of cands) for (const it of _libIndex) {
    const t = normalizeTitle(it.title);
    if (t.includes(c) || c.includes(t)) return it.href;
  }
  return null;
}

/** 站内跳飞牛影视详情页：复用 embyWall「开始观看」的 SPA 跳法(pushState+popstate, 兜底整页导航) */
function navigateToDetail(href: string): void {
  try {
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
    // [兜底] 若飞牛未响应 popstate(详情页未渲染)，600ms 后退化整页导航
    setTimeout(() => {
      const ready = !!document.querySelector('button[aria-label="返回"]');
      if (!ready) location.href = href;
    }, 600);
  } catch (e) { try { location.href = href; } catch { /* ignore */ } }
}

/** 把时间戳格式化为底部小字：当天显示 HH:MM，跨天显示 M/D HH:MM（缓存可能是昨天的快照） */
function fmtFootTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `${hh}:${mm}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function buildPanel(): void {
  let hotLabel = 'TMDB';   // 浮层「热门影视」标签文字：按设置数据源动态显示（默认豆瓣）
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
    <div id="fntv-hot-reset"></div>
    <div id="fntv-hot-foot">
      <span id="fntv-hot-foot-time"></span>
      <button id="fntv-hot-refresh" type="button" title="忽略本地缓存，重新拉取最新数据">↻ 刷新</button>
    </div>`;

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
  const footTimeEl = panel.querySelector('#fntv-hot-foot-time') as HTMLElement;
  const refreshBtn = panel.querySelector('#fntv-hot-refresh') as HTMLButtonElement;

  // 把接口的更新时间戳写成底部小字「数据更新于 HH:MM（本地缓存）」
  const updateFoot = (res: any): void => {
    const ts = res && typeof res.cachedAt === 'number' ? res.cachedAt : 0;
    if (!ts) { footTimeEl.textContent = ''; return; }
    footTimeEl.textContent = '数据更新于 ' + fmtFootTime(ts) + (res.fromCache ? ' · 本地缓存' : '');
  };

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
      subEl.textContent = hotLabel + ' 最新 · 剧集 · 电影';
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
    // [lc-369] 统一走主进程海报代理：Bangumi 不再直连 bgm.tv（避免渲染进程多图并发+透明窗口 GPU 爆炸）
    hydratePosters(body);
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
    const titleCn = card.getAttribute('data-title-cn') || '';
    const titleOrig = card.getAttribute('data-title') || '';
    // [lc-457] 联动：库内有该剧 → 站内跳详情页；否则 → 打开外部链接(Bangumi/TMDB)
    const hit = matchLibrary(titleCn, titleOrig);
    if (hit) {
      logger.info('[hotUpdates] 库内命中，跳详情页', hit);
      navigateToDetail(hit);
    } else if (url) {
      ipcRenderer.invoke('app:open-external', url).catch(() => {});
    }
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
    // [lc-457] 展开浮层时后台预建飞牛影视库索引，供卡片点击联动（懒加载，仅一次）
    if (open) ensureLibraryIndex().catch(() => {});
  };
  tab.addEventListener('click', toggle);
  (panel.querySelector('#fntv-hot-close') as HTMLElement).addEventListener('click', () => {
    panel.classList.remove('open');
  });

  // 强制刷新按钮：忽略 24h 磁盘缓存，重新拉取【当前数据源】最新数据并覆写缓存。
  // 仅用户主动点击才触发，日常自动刷新仍走缓存，避免被第三方接口限流/封禁。
  refreshBtn.addEventListener('click', () => {
    if (refreshBtn.disabled) return;
    if (source === 'bangumi') loadBg(true);
    else loadTm(true);
  });

  refreshReset();
  applySourceUi();

  // 浮层「热门影视」标签文字按设置的数据源动态显示（默认豆瓣）：豆瓣→「豆瓣」，TMDB→「TMDB」
  ipcRenderer.invoke('settings:get-hot-source').then((s: string) => {
    hotLabel = (s === 'douban') ? '豆瓣' : 'TMDB';
    const tmdbBtn = srcSeg.querySelector('[data-src="tmdb"]') as HTMLElement | null;
    if (tmdbBtn) tmdbBtn.textContent = hotLabel;
    if (source !== 'bangumi') applySourceUi(); // 刷新副标题文案
  }).catch(() => {});

  async function loadBg(force?: boolean): Promise<void> {
    body.innerHTML = `<div class="fntv-hot-loading">⏳ 正在加载…</div>`;
    refreshBtn.disabled = true; refreshBtn.classList.add('loading');
    try {
      const res = await ipcRenderer.invoke('bangumi:calendar', !!force);
      if (!res || !res.ok) {
        body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
        return;
      }
      allBg.length = 0;
      for (const it of (res.items || [])) allBg.push(it);
      updateFoot(res);
      render();
    } catch (e: any) {
      body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml(String((e && e.message) || e))}</div>`;
    } finally {
      refreshBtn.disabled = false; refreshBtn.classList.remove('loading');
    }
  }

  async function loadTm(force?: boolean): Promise<void> {
    body.innerHTML = `<div class="fntv-hot-loading">⏳ 正在加载…</div>`;
    refreshBtn.disabled = true; refreshBtn.classList.add('loading');
    try {
      const source: string = await ipcRenderer.invoke('settings:get-hot-source').catch(() => 'douban');
      const channel = source === 'tmdb' ? 'tmdb:discover' : 'douban:discover';
      const res = await ipcRenderer.invoke(channel, !!force);
      if (!res || !res.ok) {
        const base = source === 'douban' ? '豆瓣数据获取失败' : 'TMDB 数据获取失败';
        body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml((res && res.error) || base)}</div>`;
        return;
      }
      allTm.length = 0;
      for (const it of (res.items || [])) allTm.push(it);
      updateFoot(res);
      if (!allTm.length) {
        const tip = res.warning || (source === 'douban'
          ? '豆瓣未返回数据（可能网络波动，请稍后重试）。'
          : 'TMDB 未返回数据（可能 Key 无效，或本机网络无法连接 api.themoviedb.org；请在设置开启「免梯子直连」或设置 HTTPS_PROXY 后重试，详见日志 [TMDB诊断]）');
        body.innerHTML = `<div class="fntv-hot-err">${escapeHtml(tip)}</div>`;
        return;
      }
      render();
      if (res.warning) {
        body.insertAdjacentHTML('afterbegin', `<div class="fntv-hot-warn">⚠ ${escapeHtml(res.warning)}</div>`);
      }
    } catch (e: any) {
      body.innerHTML = `<div class="fntv-hot-err">获取失败：${escapeHtml(String((e && e.message) || e))}</div>`;
    } finally {
      refreshBtn.disabled = false; refreshBtn.classList.remove('loading');
    }
  }
}

function initHotUpdates(): void {
  if (!shouldInject()) return;
  // [lc-371] 仅在 TV 页注入每日放送浮层; 飞牛原生系统页不显示, 避免遮挡原生 UI
  if (!isFntvTvPage()) return;
  injectStyle();
  applyDailyVisibility(); // [lc-363] 按"外观"开关决定是否注入每日放送按钮
  // 实时响应设置面板开关变化（同源同窗口内 localStorage 写入不触发 storage 事件，故用自定义事件）
  window.addEventListener('fntv:daily-toggle', applyDailyVisibility as EventListener);

  // 首页才显示浮窗：路由切换时实时同步可见性（复用 titlebar 的 pushState 链式包装机制，
  // 不破坏 embyWall 导航逻辑；另加 popstate/hashchange 覆盖浏览器前进后退与 hash 路由）
  try {
    const _ps = history.pushState, _rs = history.replaceState;
    (history as any).pushState = function (...a: any[]) { _ps.apply(this, a as any); syncHomeVisibility(); };
    (history as any).replaceState = function (...a: any[]) { _rs.apply(this, a as any); syncHomeVisibility(); };
    window.addEventListener('popstate', syncHomeVisibility);
    window.addEventListener('hashchange', syncHomeVisibility);
  } catch (e) { logger.error('[hotUpdates] nav hook err', String(e).substring(0, 60)); }

  // 兜底：某些导航可能绕过 history API（如整页加载/特殊路由），定时核对一次首页状态
  setInterval(syncHomeVisibility, 3000);

  logger.info('[hotUpdates] 热门剧更新浮层（宫灯版，Bangumi/TMDB 双源）已挂载');
}

registerHook(HookType.OnReady, initHotUpdates);
