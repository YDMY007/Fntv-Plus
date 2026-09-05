// embyWall/detail/epBackfill.ts — [lc-1045] 季页「选集」TMDB 分集信息回填（刷新按钮）
// ─────────────────────────────────────────────────────────────────────────────
// 诉求（用户）：飞牛自带刮削经常刮不上每集的「集标题/简介」（TMDB 明明有），在二级详情页
//   「选集」两个字后面加一个刷新按钮，自己去 TMDB 拉数据回填到飞牛。
// 回填优先级（用户指定）：中文 > 英文 > 无数据 ——
//   · 缺数据 → 填最优值（TMDB 中文优先，英文兜底）；
//   · 已有英文且 TMDB 有中文 → 中文覆盖英文；
//   · 已有中文/日文（CJK）→ 不动（绝不拿英文倒打）。
// 写回方式：完全照搬 lc-425 详情页 Logo 回填飞牛的活体验证管线（carousel/logo.ts）——
//   getEditDetail 读全量 → 仅改变化字段 → saveEditDetail 原样回写（POST 带 nonce + Authx 签名），
//   外加 title_locked/overview_locked:true（仿 logos_locked 约定，防飞牛下次刮削覆盖；
//   字段名服务端不识别时会被忽略，无副作用）。写后复读一次复核，服务端没落盘就如实计失败。
// 枚举方式：/v/api/v1/item/list(parent_guid=季guid) 拿本季全部集 guid（三级层级 TV→Season→Episode，
//   见 libraryIndex lc-772 实测），失败回落 DOM 卡片 a[href] 收集。
// 匹配方式：getEditDetail(集guid).index_number = 集号（季 item 的 index_number=季号，同一约定，
//   tmdbCard.loadShowMeta 在用）→ 对 TMDB episode_number，不依赖 DOM 顺序。
// DOM 即时补丁：写回成功后直接改卡片文本（文本节点 data 写入，与 _fillSeriesIntro 同手法，
//   React 卸载安全）；简介节点找不到（非 <p> 结构）就跳过——数据已落盘，刷新页面自然一致。
// 按钮生命周期：scheduleEpBackfill 挂在导航钩子（与 applyDetailBeautify 同一批调用点），
//   有界重试链等「选集」标题渲染；React 重渲染冲掉按钮时由 embyWall 的 _detailObs 去抖回调
//   ensureEpFixButton 补挂（复用既有常驻观察器，零新增轮询）。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { fnosGetEditDetail } from '../carousel/logo';
import { extractTmdbId } from '../carousel/api';
import { DETAIL_HERO_SEL, findActiveDetailView } from './glass';

const BTN_ID = 'fnos-epfix-btn';
const ANCHOR_MARK = 'data-fnos-epfix-anchor';
/** 与 epResolution/tmdbCard 同款有界重试链：等「选集」标题与选集卡异步渲染，绝不变永久轮询。 */
const RETRY_DELAYS = [0, 400, 1000, 2000, 3400, 5000];
/** 逐集读改写的并发上限：24 集 ×(读+写+复核) 太多串行请求，4 路并行对 NAS 温和且总时长秒级。 */
const CONCURRENCY = 4;

// ── 路由/文本纯函数 ──

function seasonGuid(): string | null {
  const m = location.pathname.match(/\/v\/tv\/season\/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

/** CJK（含假名）：当前值带 CJK 视为"非英文"，不被中文覆盖（用户只要求英文被中文覆盖）。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
export function hasCJK(s: string): boolean {
  return CJK_RE.test(s || '');
}

/** TMDB 集名占位（盗墓王实测：zh name 就是「第 10 集」本身）——当"无数据"处理，不回填、不覆盖。 */
export function isPlaceholderTitle(s: string): boolean {
  return /^(第\s*\d+\s*[集话話期]|episode\s*\d+|#\d+)$/i.test((s || '').trim());
}

/** 单字段回填裁决（纯函数，验证脚本直测）。返回 null=不动；否则=应写入的新值。
 *  best 取值：zh 有 CJK → zh；否则 en；否则 zh 原文（zh 回落英文原文时与 en 等价，仍可用）。
 *  · 当前为空 & best 非空 → 回填；· 当前无 CJK & best 有 CJK → 中文覆盖；· 其余不动。 */
export function decideField(
  cur: string, zh: string, en: string,
  placeholder?: (s: string) => boolean,
): string | null {
  const zhOk = !!(zh && zh.trim() && !(placeholder && placeholder(zh)));
  const enOk = !!(en && en.trim() && !(placeholder && placeholder(en)));
  const best = (zhOk && hasCJK(zh)) ? zh : (enOk ? en : (zhOk ? zh : ''));
  const curT = (cur || '').trim();
  if (!best.trim()) return null;
  if (!curT) return best;
  if (!hasCJK(curT) && hasCJK(best)) return best;
  return null;
}

function numOrNull(v: any): number | null {
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** DOM 兜底解析季号（getEditDetail 没有 index_number 时用；只认数字/中文数字两种形态）。 */
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

function findSeasonNumberDom(): number | null {
  const view = findActiveDetailView();
  if (!view) return null;
  const hero = view.querySelector(DETAIL_HERO_SEL);
  if (!hero) return null;
  const leaves = hero.querySelectorAll('*');
  const limit = Math.min(leaves.length, 1500);
  for (let i = 0; i < limit; i++) {
    const e = leaves[i];
    if (e.children.length !== 0) continue;
    const t = (e.textContent || '').trim();
    const m = t.match(/^第\s*([0-9一二三四五六七八九十]+)\s*季$/) || t.match(/^Season\s*(\d{1,3})$/i);
    if (m) {
      const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : cnNumToInt(m[1]);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

// ── 飞牛 API（nonce + Authx 约定同 logo.ts lc-425）──

function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** 带签名 POST（渲染进程 fetch，credentials 会话鉴权），返回业务 data 或 null。 */
async function fnosPost(origin: string, path: string, body: any): Promise<any | null> {
  const authx = await ipcRenderer.invoke('fnos-gen-authx', path, body).catch(() => '');
  const resp = await fetch(origin + path, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { dlog('[epBackfill] POST ' + path + ' HTTP ' + resp.status); return null; }
  const j = await resp.json().catch(() => null);
  if (!j || j.code !== 0) { dlog('[epBackfill] POST ' + path + ' 业务失败 ' + JSON.stringify(j).substring(0, 160)); return null; }
  return j.data || null;
}

/** 枚举本季全部集（guid + type）。item/list 失败时由调用方回落 DOM href 收集。 */
async function fnosEpisodeList(origin: string, seasonGuid: string): Promise<{ guid: string; index: number | null }[]> {
  const data = await fnosPost(origin, '/v/api/v1/item/list', {
    parent_guid: seasonGuid, exclude_folder: 1,
    sort_column: 'sort_title', sort_type: 'ASC', nonce: fnNonce(),
  });
  const list = data && Array.isArray((data as any).list) ? (data as any).list : [];
  const out: { guid: string; index: number | null }[] = [];
  for (const it of list) {
    if (!it || !it.guid) continue;
    if (String(it.type || '').toLowerCase() !== 'episode') continue;
    out.push({ guid: String(it.guid), index: numOrNull(it.index_number ?? it.index) });
  }
  return out;
}

/** DOM 回落：活跃视图选集卡的 a[href="/v/tv/episode/<guid>"]。 */
function episodeGuidsFromDom(): { guid: string; index: number | null }[] {
  const view = findActiveDetailView();
  if (!view) return [];
  const out: { guid: string; index: number | null }[] = [];
  const seen = new Set<string>();
  const links = view.querySelectorAll<HTMLAnchorElement>('a[href*="/v/tv/episode/"]');
  for (let i = 0; i < links.length; i++) {
    const m = (links[i].getAttribute('href') || '').match(/\/v\/tv\/episode\/([a-f0-9]{32})/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ guid: m[1], index: null });
  }
  return out;
}

/** 全量回写（仅调用方改好的字段 + nonce；字段锁定由调用方放进了 body）。 */
async function fnosSaveEditDetail(origin: string, body: any): Promise<boolean> {
  const data = await fnosPost(origin, '/v/api/v1/item/saveEditDetail', body);
  return data !== null;
}

// ── 按钮挂载/状态 ──

function setBtn(btn: HTMLElement, text: string, title?: string): void {
  btn.textContent = text;
  if (title !== undefined) btn.setAttribute('title', title);
}

function makeBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = BTN_ID;
  btn.textContent = '⟳ 补全集信息';
  btn.setAttribute('title', '从 TMDB 拉取本季每集的标题/简介，回填到飞牛（中文 > 英文 > 无数据）');
  btn.style.cssText = 'display:inline-flex;align-items:center;margin-left:9px;padding:3px 10px;border-radius:999px;'
    + 'font-size:11.5px;font-weight:600;cursor:pointer;vertical-align:middle;letter-spacing:.3px;'
    + 'background:var(--fnos-ui-btn-bg,rgba(150,120,200,.12));color:var(--fnos-ui-accent,#8b6fd0);'
    + 'border:none;transition:background .15s,color .15s;flex-shrink:0;';
  btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--fnos-ui-btn-hover,rgba(183,155,232,.32))'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--fnos-ui-btn-bg,rgba(150,120,200,.12))'; });
  btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); void runBackfill(btn); });
  return btn;
}

/** 「选集」标题元素：活跃视图内文本恰为「选集」的可见叶子（防选集计数等变体：再试 ≤8 字前缀）。 */
function findSelectHeading(): HTMLElement | null {
  const view = findActiveDetailView();
  if (!view) return null;
  const nodes = view.querySelectorAll('strong,b,h1,h2,h3,h4,p,span,div,em');
  let prefixHit: HTMLElement | null = null;
  const limit = Math.min(nodes.length, 2500);
  for (let i = 0; i < limit; i++) {
    const el = nodes[i] as HTMLElement;
    if (el.children.length !== 0) continue;               // 叶子（已挂按钮的锚点会被 data 标记跳过，见下）
    if (el.querySelector('#' + BTN_ID)) continue;          // 已是我们按钮的宿主
    const t = (el.textContent || '').trim();
    if (t === '选集') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    } else if (!prefixHit && /^选集/.test(t) && t.length <= 8) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) prefixHit = el;
    }
  }
  return prefixHit;
}

/** 幂等挂载：已挂且仍在文档 → 跳过；找不到锚点 → 静默（观察器/重试链会再来）。 */
export function ensureEpFixButton(): void {
  if (!seasonGuid()) { removeEpFixButton(); return; }
  const existing = document.getElementById(BTN_ID);
  if (existing && existing.isConnected) return;
  const anchor = findSelectHeading();
  if (!anchor) return;
  anchor.appendChild(makeBtn());
  anchor.setAttribute(ANCHOR_MARK, '1');
  dlog('[epBackfill] 按钮已挂载 ' + location.pathname);
}

export function removeEpFixButton(): void {
  const b = document.getElementById(BTN_ID);
  if (b && b.parentNode) b.parentNode.removeChild(b);
}

// ── DOM 即时补丁 ──

/** 标题 p：卡内「含 <p> 的 <a>」首个 <p>（epResolution 实机验证的定位）；简介 p：其余 p 的最后一个。 */
function patchEpisodeCard(epGuid: string, title: string | null, overview: string | null): void {
  const view = findActiveDetailView();
  if (!view) return;
  const link = view.querySelector<HTMLAnchorElement>('a[href="/v/tv/episode/' + epGuid + '"]');
  if (!link) return;
  const card = link.closest('[data-id="details"]') as HTMLElement | null;
  if (!card) return;
  const titleP = (link.querySelector('p') as HTMLElement | null) || (card.querySelector('p') as HTMLElement | null);
  if (titleP && title !== null) {
    // 只写首个文本节点 —— 保留节点内可能存在的清晰度胶囊 span（epResolution）
    const tn = titleP.firstChild;
    if (tn && tn.nodeType === Node.TEXT_NODE) {
      if (tn.nodeValue !== title) tn.nodeValue = title;
    } else {
      titleP.insertBefore(document.createTextNode(title), titleP.firstChild);
    }
  }
  if (overview !== null) {
    const ps = Array.from(card.querySelectorAll('p')).filter((p) => p !== titleP);
    const ovP = ps.length ? ps[ps.length - 1] : null;
    // 简介节点只处理「纯文本 p」：结构不符（div/带子元素）就跳过，宁可不即时刷新也不冒改写风险
    if (ovP && ovP.children.length === 0) {
      const tn = ovP.firstChild;
      if (tn && tn.nodeType === Node.TEXT_NODE) {
        if (tn.nodeValue !== overview) tn.nodeValue = overview;
      } else if (!ovP.firstChild) {
        ovP.textContent = overview;
      }
    }
  }
}

// ── 主流程 ──

let _running = false;
let _retryTimers: number[] = [];

interface Stats { filled: number; upgraded: number; unchanged: number; failed: number; unmatched: number; total: number; }

async function runBackfill(btn: HTMLButtonElement): Promise<void> {
  const guid = seasonGuid();
  if (!guid || _running) return;
  _running = true;
  const origin = location.origin;
  const stats: Stats = { filled: 0, upgraded: 0, unchanged: 0, failed: 0, unmatched: 0, total: 0 };
  const tick = (): void => {
    const done = stats.filled + stats.upgraded + stats.unchanged + stats.failed + stats.unmatched;
    if (btn.isConnected) setBtn(btn, '⏳ 补全中 ' + done + '/' + stats.total);
  };
  try {
    // 1) 季 meta：tmdbId / 标题 / 季号（getEditDetail 真值优先，DOM 兜底）
    const data = await fnosGetEditDetail(origin, guid);
    if (!data) throw new Error('读取季信息失败（getEditDetail）');
    const tmdbId = extractTmdbId(data) || '';
    const title = String(data.title || data.name || '').trim();
    const seasonNumber = numOrNull(data.index_number ?? data.index ?? data.season_number) ?? findSeasonNumberDom();
    if (seasonNumber === null) throw new Error('无法确定季号（页面与元数据都没有）');
    if (!tmdbId && !title) throw new Error('无 TMDB id 且无标题，无法匹配');

    // 2) TMDB 双语分集（7 天磁盘缓存 + SWR；失败 throw 不落盘）
    setBtn(btn, '⏳ 获取 TMDB…');
    const r: any = await ipcRenderer.invoke('tmdb:season-episodes', {
      tmdbId: tmdbId || undefined, title: title || undefined, seasonNumber,
    });
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.episodes)) {
      throw new Error((r && r.error) || 'TMDB 获取失败');
    }
    const tmdbByNum = new Map<number, any>();
    for (const e of r.data.episodes) tmdbByNum.set(e.episodeNumber, e);

    // 3) 飞牛枚举本季集（item/list 为主，DOM 回落）
    let episodes = await fnosEpisodeList(origin, guid).catch(() => [] as { guid: string; index: number | null }[]);
    if (!episodes.length) episodes = episodeGuidsFromDom();
    if (!episodes.length) throw new Error('未枚举到本季任何集（item/list 与 DOM 都为空）');
    stats.total = episodes.length;

    // 4) 逐集：读全量 → 裁决 → 写回 → 复核 → DOM 补丁
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < episodes.length) {
        const ep = episodes[idx++];
        try {
          const ed = await fnosGetEditDetail(origin, ep.guid);
          if (!ed) { stats.failed++; tick(); continue; }
          const num = numOrNull(ed.index_number ?? ed.index) ?? ep.index;
          const t = (num !== null) ? tmdbByNum.get(num) : undefined;
          if (!t) { stats.unmatched++; tick(); continue; }
          const titleKey = ('title' in ed) ? 'title' : ('name' in ed ? 'name' : 'title');
          const ovKey = ('overview' in ed) ? 'overview' : ('description' in ed ? 'description' : 'overview');
          const curTitle = String(ed[titleKey] ?? '');
          const curOv = String(ed[ovKey] ?? '');
          const newTitle = decideField(curTitle, t.nameZh, t.nameEn, isPlaceholderTitle);
          const newOv = decideField(curOv, t.overviewZh, t.overviewEn);
          if (newTitle === null && newOv === null) { stats.unchanged++; tick(); continue; }
          const body: any = { ...ed, nonce: fnNonce() };
          // 防御：getEditDetail 返回体可能不带 guid 字段（logo 回填实测全量回写即可定位条目，
          // 服务端从 data 内取 guid）——缺了就显式补，保证 saveEditDetail 永远可定位本集
          if (!body.guid && !body.item_guid) body.guid = ep.guid;
          let titleChanged = false, ovChanged = false;
          if (newTitle !== null) { body[titleKey] = newTitle; body.title_locked = true; titleChanged = true; }
          if (newOv !== null) { body[ovKey] = newOv; body.overview_locked = true; ovChanged = true; }
          const saved = await fnosSaveEditDetail(origin, body);
          if (!saved) { stats.failed++; tick(); continue; }
          // 复核：服务端字段名/落盘不确定（*_locked 为仿 logos_locked 的尽力约定），读不回就如实计失败
          const vf = await fnosGetEditDetail(origin, ep.guid);
          const vTitle = String(vf ? (vf[titleKey] ?? '') : '');
          const vOv = String(vf ? (vf[ovKey] ?? '') : '');
          const titleOk = !titleChanged || vTitle.trim() === (newTitle as string).trim();
          const ovOk = !ovChanged || vOv.trim() === (newOv as string).trim();
          if (!titleOk || !ovOk) { stats.failed++; tick(); continue; }
          if (titleChanged && hasCJK(newTitle as string)) stats.filled++;       // 中文（回填或覆盖都算"补全"）
          else if (titleChanged) stats.upgraded++;                              // 仅英文兜底
          if (ovChanged && hasCJK(newOv as string)) stats.filled++;
          else if (ovChanged) stats.upgraded++;
          // DOM 即时补丁（按钮/卡片被 React 冲掉就跳过，数据已在服务端）
          patchEpisodeCard(ep.guid, titleChanged ? (newTitle as string) : null, ovChanged ? (newOv as string) : null);
          tick();
        } catch (e: any) {
          stats.failed++;
          dlog('[epBackfill] 单集失败 ' + ep.guid + ' ' + String(e).substring(0, 100));
          tick();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, episodes.length) }, worker));

    // 5) 结果反馈
    const done = stats.filled + stats.upgraded;
    if (stats.failed) {
      setBtn(btn, '⚠ 补全 ' + done + ' · 失败 ' + stats.failed, '部分集写入失败，详见日志；可再点一次重试。');
    } else if (done) {
      setBtn(btn, '✓ 已补全 ' + stats.filled + ' · 兜底 ' + stats.upgraded, '标题/简介已写回飞牛元数据。');
    } else if (stats.unmatched) {
      setBtn(btn, '⚠ ' + stats.unmatched + ' 集未匹配', 'TMDB 上也缺这些集的数据或集号对不上。');
    } else {
      setBtn(btn, '✓ 数据已最新', '每集标题/简介都与 TMDB 一致，无需补全。');
    }
    log('[epBackfill] 完成 S' + seasonNumber + ' total=' + stats.total + ' filled=' + stats.filled
      + ' fallback=' + stats.upgraded + ' unchanged=' + stats.unchanged
      + ' unmatched=' + stats.unmatched + ' failed=' + stats.failed);
  } catch (e: any) {
    const msg = String(e && e.message || e).substring(0, 80);
    log('[epBackfill] 失败: ' + msg);
    if (btn.isConnected) {
      setBtn(btn, '⚠ ' + msg, msg);
      btn.style.color = 'var(--fnos-ui-warn,#b06a3a)';
      window.setTimeout(() => { if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ 补全集信息'); } }, 5000);
    }
    _running = false;
    return;
  }
  window.setTimeout(() => {
    _running = false;
    if (btn.isConnected) setBtn(btn, '⟳ 补全集信息');
  }, 4000);
}

/** 导航钩子调用：季页 → 有界重试链挂按钮；离开 → 撤按钮。 */
export function scheduleEpBackfill(): void {
  for (let i = 0; i < _retryTimers.length; i++) clearTimeout(_retryTimers[i]);
  _retryTimers = [];
  if (!seasonGuid()) { removeEpFixButton(); return; }
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _retryTimers.push(window.setTimeout(() => {
      if (!seasonGuid()) return;               // 已离开该页
      ensureEpFixButton();
    }, RETRY_DELAYS[i]));
  }
}
