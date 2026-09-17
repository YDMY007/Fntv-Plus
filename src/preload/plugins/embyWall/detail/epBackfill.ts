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
import { S } from '../state';
import { fnosGetEditDetail } from '../carousel/logo';
import { extractTmdbId, extractBangumiId } from '../carousel/api';
import { DETAIL_HERO_SEL, findActiveDetailView } from './glass';

const BTN_ID = 'fnos-epfix-btn';
const ANCHOR_MARK = 'data-fnos-epfix-anchor';
/** 与 epResolution/tmdbCard 同款有界重试链：等「选集」标题与选集卡异步渲染，绝不变永久轮询。 */
const RETRY_DELAYS = [0, 400, 1000, 2000, 3400, 5000];
/** 逐集读改写的并发上限：24 集 ×(读+写+复核) 太多串行请求，4 路并行对 NAS 温和且总时长秒级。 */
const CONCURRENCY = 4;

// ── 路由/文本纯函数 ──

export function seasonGuid(): string | null {
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
 *  · 当前为空 & best 非空 → 回填；
 *  · 当前是占位标题(「第 N 集」等, placeholder 判定) & best 非空 → 回填（英文也算升级）；
 *  · 当前无 CJK & best 有 CJK → 中文覆盖；
 *  · 其余不动。 */
export function decideField(
    cur: string, zh: string, en: string,
    placeholder?: (s: string) => boolean,
): string | null {
    const zhOk = !!(zh && zh.trim() && !(placeholder && placeholder(zh)));
    const enOk = !!(en && en.trim() && !(placeholder && placeholder(en)));
    const best = (zhOk && hasCJK(zh)) ? zh : (enOk ? en : (zhOk ? zh : ''));
    const curT = (cur || '').trim();
    if (!best.trim()) return null;
    // [多源刮削] 占位标题是垃圾数据，任何真实数据(含英文)都是升级 —— 用户要求英文标题也兜底补齐
    if (placeholder && placeholder(curT)) return best;
    if (!curT) return best;
    if (!hasCJK(curT) && hasCJK(best)) return best;
    return null;
}

export function numOrNull(v: any): number | null {
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return null;
}

/** [多源刮削] 从集标题提取集号: fnOS 0.9.8 的 getEditDetail/item/list 实测都不带 index_number,
 *  未刮削分集的标题形如「第 11 集」「第 3 话」「Episode 4」「12」—— 可直接解析出集号。 */
export function epNumFromTitle(t: string): number | null {
    const s = (t || '').trim();
    const m = s.match(/^第\s*(\d{1,4})\s*[集话話]/) || s.match(/^(?:Episode|EP\.?)\s*(\d{1,4})\b/i)
        || s.match(/^(?:第\s*)?(\d{1,4})$/);
    return m ? parseInt(m[1], 10) : null;
}

/** [lc-1178] 选集卡文本 → 集号（纯函数，验证脚本直测）。
 *  fnOS 对元数据全空的集仍会在选集卡标题行渲染集号（真机截图实锤「8 夏日的回忆碎片」，
 *  首文本节点就是「8」），所以卡内 <p> 的整串文本可解析出集号。 */
export function parseCardNum(text: string): number | null {
    const s = (text || '').trim();
    const m = s.match(/^第\s*(\d{1,4})\s*[集话話]/) || s.match(/^(?:Episode|EP\.?)\s*(\d{1,4})\b/i)
        || s.match(/^(\d{1,4})(?:\s|$)/);
    return m ? parseInt(m[1], 10) : null;
}

/** [lc-1178] DOM 选集卡兜底集号：仅当 getEditDetail 无 index/title 且 item/list 无序号时调用
 *  （每集一次 querySelector，不在渲染循环内）。找不到卡片（虚拟窗口未渲染）返回 null。 */
export function epNumFromCard(epGuid: string): number | null {
    const view = findActiveDetailView();
    if (!view) return null;
    const link = view.querySelector<HTMLAnchorElement>('a[href="/v/tv/episode/' + epGuid + '"]');
    if (!link) return null;
    const card = link.closest('[data-id="details"]') as HTMLElement | null;
    const p = (link.querySelector('p') as HTMLElement | null)
        || (card ? (card.querySelector('p') as HTMLElement | null) : null);
    return parseCardNum((p && p.textContent) || '');
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
export async function fnosEpisodeList(origin: string, seasonGuid: string): Promise<{ guid: string; index: number | null }[]> {
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
export function episodeGuidsFromDom(): { guid: string; index: number | null }[] {
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
export async function fnosSaveEditDetail(origin: string, body: any): Promise<boolean> {
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/saveEditDetail', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/item/saveEditDetail', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
        body: JSON.stringify(body),
    });
    if (!resp.ok) { dlog('[epBackfill] saveEditDetail HTTP ' + resp.status); return false; }
    const j = await resp.json().catch(() => null);
    // [多源刮削] 成功判定必须按 code===0 —— 实测成功响应是 {code:0, data:null},
    //  旧写法「data !== null」把所有成功写回误判成失败(failed 虚高、复核从未执行)。
    return !!j && j.code === 0;
}

// ── 按钮挂载/状态 ──

export function setBtn(btn: HTMLElement, text: string, title?: string): void {
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
    + 'background:var(--fnos-ui-btn-bg,rgba(90,120,200,.12));color:var(--fnos-ui-accent,#6d7ff2);'
    + 'border:none;transition:background .15s,color .15s;flex-shrink:0;';
  btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--fnos-ui-btn-hover,rgba(109,127,242,.32))'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--fnos-ui-btn-bg,rgba(90,120,200,.12))'; });
  btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); void runBackfill(btn); });
  return btn;
}

/** 「选集」标题元素：活跃视图内文本恰为「选集」的可见叶子（防选集计数等变体：再试 ≤8 字前缀）。 */
export function findSelectHeading(): HTMLElement | null {
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
// [多源刮削] 导出供 bangumiBackfill 复用（同一选集卡结构，写回成功后的即时补丁手法一致）
export function patchEpisodeCard(epGuid: string, title: string | null, overview: string | null): void {
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

// ── 季信息解析：多源刮削 + 多层级兜底 ─────────────────────────────────────────
// [lc-1176] 根因（2026-09-17 实机日志取证）：飞牛用 **Bangumi 源** 刮削的条目，trim_id 形如
//   `bg456080`，「季」级 item 的 getEditDetail 返回 `title:""` 且**不带任何 TMDB id** ——
//   剧名与 TMDB id 只存在于父级「剧集」条目上，而季页 DOM 上明明完整显示着剧名。
//   旧实现只认季自身两个字段，一遇 Bangumi 源就 100% 抛「无 TMDB id 且无标题，无法匹配」，
//   用户侧表现为「TMDB 上明明有这部番，点了补全却说匹配不上」。
// 现改为四级兜底：① 季自身（剥「第N季」后缀）→ ② 父级剧集 getEditDetail（真名 + TMDB id）
//   → ③ 详情页 DOM 主标题（最大字号叶子）→ ④ document.title。
//   另：bg 前缀识别出 Bangumi subject id，用于失败提示与日志定位（Bangumi 通道由 bgBackfill 负责）。

/** 季信息解析结果。 */
export interface SeasonMeta {
  tmdbId: string;      // 可能为空（Bangumi 源条目）
  bangumiId: string;   // Bangumi subject id（bg 前缀 trim_id），可能为空
  title: string;       // 剧名（已剥季缀），可能为空（四级兜底全失败）
  year: string;        // 首播年份，供 TMDB 搜索消歧，可能为空
  seasonNumber: number | null;
}

/** 剥掉尾部季缀：「XXX 第2季」「XXX Season 2」「XXX S2」→「XXX」（TMDB 搜索不接受季号）。 */
export function stripSeasonSuffix(t: string): string {
  return String(t || '').trim()
    .replace(/\s*(第\s*[0-9一二三四五六七八九十百]+\s*季|season\s*\d{1,3}|s\s*\d{1,3})\s*$/i, '')
    .trim();
}

/** GET 飞牛 item 详情（父子链路探测用；非编辑态字段比 getEditDetail 更全）。 */
async function fnosGet(origin: string, path: string): Promise<any | null> {
  try {
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path).catch(() => '');
    const resp = await fetch(origin + path, {
      method: 'GET', credentials: 'include',
      headers: authx ? { Authx: authx } : {},
    });
    if (!resp.ok) { dlog('[epBackfill] GET ' + path + ' HTTP ' + resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) return null;
    return j.data || null;
  } catch (e: any) {
    dlog('[epBackfill] GET ' + path + ' 异常 ' + String(e).substring(0, 80));
    return null;
  }
}

const GUID32 = /^[a-f0-9]{32}$/;

/** 季 guid → 父级「剧集」guid：季详情 parent 系字段 → GET /v/api/v1/item/{guid} 再探。
 *  [lc-1182] 导出供 tmdbCard.loadShowMeta 复用 —— 季层 title/tmdbId 双空时向上找剧集层
 *  （与一级详情页同一条数据源，剧名一致 → 可命中主进程的「剧名→id」复用缓存）。 */
export async function resolveSeriesGuid(origin: string, sg: string, seasonData: any): Promise<string | null> {
  const pick = (d: any): string | null => {
    if (!d) return null;
    const c = d.parent_guid || d.parent_id || d.parent_item_guid || d.series_guid || d.show_guid
      || (d.parent && d.parent.guid) || null;
    const s = c == null ? '' : String(c);
    return GUID32.test(s) ? s : null;
  };
  const direct = pick(seasonData);
  if (direct) return direct;
  const info = await fnosGet(origin, '/v/api/v1/item/' + sg);
  const via = pick(info);
  if (via) { dlog('[epBackfill] 父级剧集 guid 解析成功: ' + via); return via; }
  if (info) dlog('[epBackfill] 季详情无 parent 系字段, keys=' + Object.keys(info || seasonData || {}).join(','));
  return null;
}

/** DOM 兜底剧名：详情页 hero 内「字号最大的可见叶子文本」（主标题通常是最大号字），
 *  再兜 document.title（形如「剧名 第1季 - 飞牛影视」）。
 *  ⚠ 只在用户点按钮时调用一次，**绝不可进渲染循环**（内含 getComputedStyle）。 */
export function showTitleFromDom(): string {
  const isNoise = (t: string): boolean =>
    !t || t.length < 2 || t.length > 60 || /飞牛影视|fnos/i.test(t)
    || /^第\s*[0-9一二三四五六七八九十]+\s*季$/.test(t) || /^Season\s*\d+$/i.test(t)
    || /^(选集|播放|收藏|已看|简介|详情)$/.test(t);
  let best = '', bestSize = 0;
  const view = findActiveDetailView();
  if (view) {
    const hero = view.querySelector(DETAIL_HERO_SEL);
    const scope: Element = hero || view;
    const leaves = scope.querySelectorAll('*');
    const limit = Math.min(leaves.length, 1500);
    for (let i = 0; i < limit; i++) {
      const e = leaves[i] as HTMLElement;
      if (e.children.length !== 0) continue;
      const t = (e.textContent || '').trim();
      if (isNoise(t)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const size = parseFloat(getComputedStyle(e).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = t; }
    }
  }
  if (!best) {
    const dt = String(document.title || '').replace(/[-–—|]\s*飞牛影视.*$/, '').trim();
    const parts = dt.split(/\s*[-–—|]\s*/).map((p) => p.trim()).filter((p) => !isNoise(p));
    best = parts.length ? parts.sort((a, b) => b.length - a.length)[0] : dt;
  }
  // CSS text-overflow 截断会带出尾部省略号 → 去掉，免得 TMDB 整句匹配失败
  return stripSeasonSuffix(best.replace(/[…]+$|\.{2,}$/, '').trim());
}

/** 年份：仅取 item 自带字段（不扫 DOM，避免误抓页面其它四位数字）。 */
function pickYear(d: any): string {
  const raw = d && (d.year || d.production_year || d.first_air_date || d.premiere_date || d.air_date);
  const m = String(raw || '').match(/(19\d{2}|20\d{2})/);
  return m ? m[1] : '';
}

/** 季页完整 meta 解析（四级兜底）。抛错仅在 getEditDetail 彻底失败时。 */
export async function resolveSeasonMeta(origin: string, sg: string): Promise<SeasonMeta> {
  const data = await fnosGetEditDetail(origin, sg);
  if (!data) throw new Error('读取季信息失败（getEditDetail）');
  let tmdbId = extractTmdbId(data) || '';
  let title = stripSeasonSuffix(String(data.title || data.name || '').trim());
  let year = pickYear(data);
  const bangumiId = extractBangumiId(data) || '';
  const seasonNumber = numOrNull(data.index_number ?? data.index ?? data.season_number) ?? findSeasonNumberDom();

  // ② 父级剧集：Bangumi 源把剧名/TMDB id 只放在剧集层
  if (!title || !tmdbId || !year) {
    const seriesGuid = await resolveSeriesGuid(origin, sg, data).catch(() => null);
    if (seriesGuid) {
      const sd = await fnosGetEditDetail(origin, seriesGuid).catch(() => null);
      if (sd) {
        if (!tmdbId) tmdbId = extractTmdbId(sd) || '';
        if (!title) title = stripSeasonSuffix(String(sd.title || sd.name || '').trim());
        if (!year) year = pickYear(sd);
      }
    }
  }
  // ③ DOM 主标题 ④ document.title（showTitleFromDom 内部已含）
  if (!title) title = showTitleFromDom();

  dlog('[epBackfill] 季 meta: title=' + JSON.stringify(title) + ' tmdb=' + (tmdbId || '-')
    + ' bgm=' + (bangumiId || '-') + ' year=' + (year || '-') + ' S' + String(seasonNumber));
  return { tmdbId, bangumiId, title, year, seasonNumber };
}

// ── 主流程 ──

let _running = false;
let _retryTimers: number[] = [];

interface Stats { filled: number; upgraded: number; unchanged: number; failed: number; unmatched: number; unverified: number; total: number; }

async function runBackfill(btn: HTMLButtonElement): Promise<void> {
  const guid = seasonGuid();
  if (!guid || _running) return;
  _running = true;
  const origin = location.origin;
  const stats: Stats = { filled: 0, upgraded: 0, unchanged: 0, failed: 0, unmatched: 0, unverified: 0, total: 0 };
  const tick = (): void => {
    const done = stats.filled + stats.upgraded + stats.unchanged + stats.failed + stats.unmatched + stats.unverified;
    if (btn.isConnected) setBtn(btn, '⏳ 补全中 ' + done + '/' + stats.total);
  };
  try {
    // 1) 季 meta：tmdbId / 标题 / 季号（[lc-1176] 四级兜底：季自身 → 父级剧集 → DOM → document.title）
    const meta = await resolveSeasonMeta(origin, guid);
    const tmdbId = meta.tmdbId;
    const title = meta.title;
    const seasonNumber = meta.seasonNumber;
    if (seasonNumber === null) throw new Error('无法确定季号（页面与元数据都没有）');
    if (!tmdbId && !title) {
      throw new Error(meta.bangumiId
        ? '本季由 Bangumi 刮削(subject ' + meta.bangumiId + ')，仍取不到剧名，无法匹配'
        : '无 TMDB id 且无标题，无法匹配');
    }

    // 2) TMDB 双语分集（7 天磁盘缓存 + SWR；失败 throw 不落盘）
    setBtn(btn, '⏳ 获取 TMDB…');
    const r: any = await ipcRenderer.invoke('tmdb:season-episodes', {
      tmdbId: tmdbId || undefined, title: title || undefined, seasonNumber,
      year: meta.year || undefined,   // [lc-1176] 年份消歧：同名条目取首播年最接近者
    });
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.episodes)) {
      throw new Error(((r && r.error) || 'TMDB 获取失败')
        + (meta.bangumiId ? ('（本季 Bangumi subject ' + meta.bangumiId + '，可试「Bangumi 补全」）') : ''));
    }
    const tmdbByNum = new Map<number, any>();
    // [多源刮削] 播出日期索引: 集号解析全失败时的兜底匹配(仅当该日期在 TMDB 唯一才采用)
    const tmdbByDate = new Map<string, any[]>();
    for (const e of r.data.episodes) {
        tmdbByNum.set(e.episodeNumber, e);
        const ad = String(e.airDate || '');
        if (ad) { const arr = tmdbByDate.get(ad) || []; arr.push(e); tmdbByDate.set(ad, arr); }
    }

    // 2.5) [自定义刮削·v1.10.0] TVMaze 英文兜底（扩展数据源 ②，设置卡开关）：TMDB 缺英文（或整集
    //    缺失）时，用 TVMaze 官方 API（免 Key，CC BY-SA）的英文标题/简介顶上。一次整季拉取 + 后端
    //    24h 缓存；查无此剧/未开启/网络失败都静默降级为纯 TMDB，绝不拖住主流程。
    const tvmazeByNum = new Map<number, { name: string; summary: string }>();
    if (S.tvmazeEnabled) {
      setBtn(btn, '⏳ 获取 TVMaze…');
      try {
        const tr: any = await ipcRenderer.invoke('tvmaze:show', {
          title: title || undefined, tmdbId: tmdbId || undefined, seasonNumber,
        });
        if (tr && tr.ok && Array.isArray(tr.episodes)) {
          for (const e of tr.episodes) {
            const n = numOrNull(e.number);
            // TVMaze 未播出集常用占位名「TBD」，与「第 N 集」同性质按无数据处理
            const nm = (e.name && !/^tbd$/i.test(String(e.name).trim())) ? String(e.name) : '';
            if (n !== null && numOrNull(e.season) === seasonNumber && (nm || e.summary)) {
              tvmazeByNum.set(n, { name: nm, summary: String(e.summary || '') });
            }
          }
        }
        log('[epBackfill] TVMaze 兜底就绪: ' + tvmazeByNum.size + ' 集');
      } catch (e: any) {
        dlog('[epBackfill] TVMaze 兜底失败(忽略): ' + String(e && e.message || e).substring(0, 80));
      }
    }

    // 3) 飞牛枚举本季集（item/list 为主，DOM 回落）
    let episodes = await fnosEpisodeList(origin, guid).catch(() => [] as { guid: string; index: number | null }[]);
    if (!episodes.length) episodes = episodeGuidsFromDom();
    // [lc-1178] item/list 可能漏集（实测「本季大结局」未播集不返回：接口 11 集、页面 12 张卡）
    //  → DOM 卡片比接口多时，把多出的 guid 并进来回填；集号由解析链的 epNumFromCard 兜底。
    const domEps = episodeGuidsFromDom();
    if (domEps.length > episodes.length) {
        const have = new Set(episodes.map((e) => e.guid));
        let merged = 0;
        for (const d of domEps) if (!have.has(d.guid)) { episodes.push(d); merged++; }
        if (merged) log('[epBackfill] item/list 比页面卡片少 ' + merged + ' 集, 已从 DOM 并入');
    }
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
                    // [多源刮削] 集号解析链: fnOS 0.9.8 实测 getEditDetail/item/list 都不带 index_number
                    //  (旧实现此处全 unmatched) → 补「标题『第 N 集』解析」「播出日期唯一匹配」与
                    //  [lc-1178]「选集卡文本集号」三级兜底 —— Bangumi 源常出现 title/air_date 全空的空壳集
                    //  (2026-09-17 实测 11 集中 6 集全空 → unmatched=6)，但 UI 卡片上始终渲染着集号。
                    const num = numOrNull(ed.index_number ?? ed.index ?? ed.episode_number)
                        ?? epNumFromTitle(String(ed.title ?? ed.name ?? ''))
                        ?? ep.index
                        ?? epNumFromCard(ep.guid);
                    let t = (num !== null) ? tmdbByNum.get(num) : undefined;
                    if (!t && ed.air_date) {
                        const byDate = tmdbByDate.get(String(ed.air_date));
                        if (byDate && byDate.length === 1) t = byDate[0]; // 该日期唯一才采用, 防错配
                    }
                    // [自定义刮削] TVMaze 兜底：TMDB 整集缺失 → 用 TVMaze 该集英文（走"仅英文兜底"路径）；
                    // TMDB 有集但缺英文 → 英文字段用 TVMaze 补齐后再裁决。
                    const tvEp = (num !== null) ? tvmazeByNum.get(num) : undefined;
                    if (!t && !tvEp) {
                        dlog('[epBackfill] 集号无法确定: guid=' + ep.guid + ' title=' + String(ed.title ?? ed.name ?? '')
                            + ' air_date=' + String(ed.air_date || ''));
                        stats.unmatched++; tick(); continue;
                    }
          const titleKey = ('title' in ed) ? 'title' : ('name' in ed ? 'name' : 'title');
          const ovKey = ('overview' in ed) ? 'overview' : ('description' in ed ? 'description' : 'overview');
          const curTitle = String(ed[titleKey] ?? '');
          const curOv = String(ed[ovKey] ?? '');
          const nameZh = t ? t.nameZh : '';
          const ovZh = t ? t.overviewZh : '';
          const nameEn = (t && t.nameEn) || (tvEp ? tvEp.name : '');
          const ovEn = (t && t.overviewEn) || (tvEp ? tvEp.summary : '');
          const newTitle = decideField(curTitle, nameZh, nameEn, isPlaceholderTitle);
          const newOv = decideField(curOv, ovZh, ovEn);
          if (newTitle === null && newOv === null) { stats.unchanged++; tick(); continue; }
          const body: any = { ...ed, nonce: fnNonce() };
          // 防御：getEditDetail 返回体可能不带 guid 字段（logo 回填实测全量回写即可定位条目，
          // 服务端从 data 内取 guid）——缺了就显式补，保证 saveEditDetail 永远可定位本集
          if (!body.guid && !body.item_guid) body.guid = ep.guid;
                    let titleChanged = false, ovChanged = false;
                    // [多源刮削] 仅中文结果加 *_locked（防 fnOS 自动刮削覆盖）；英文兜底不锁 ——
                    //  让后续官方中文翻译/自动刮削可以自然覆盖英文占位（用户主诉求是中文数据）。
                    if (newTitle !== null) { body[titleKey] = newTitle; if (hasCJK(newTitle)) body.title_locked = true; titleChanged = true; }
                    if (newOv !== null) { body[ovKey] = newOv; if (hasCJK(newOv)) body.overview_locked = true; ovChanged = true; }
                    const saved = await fnosSaveEditDetail(origin, body);
                    if (!saved) { stats.failed++; tick(); continue; }
                    // 复核：写后立即读回可能撞上服务端旧值（实测 code:0 但回读仍是旧内容）→
                    //  隔 700ms 重读一次；仍不一致计「未确认」（提交成败需刷新页面核实），不算硬失败
                    let verified = false;
                    for (let v = 0; v < 2 && !verified; v++) {
                        if (v > 0) await new Promise((r) => setTimeout(r, 700));
                        const vf = await fnosGetEditDetail(origin, ep.guid);
                        const vTitle = String(vf ? (vf[titleKey] ?? '') : '');
                        const vOv = String(vf ? (vf[ovKey] ?? '') : '');
                        verified = (!titleChanged || vTitle.trim() === (newTitle as string).trim())
                            && (!ovChanged || vOv.trim() === (newOv as string).trim());
                    }
                    if (!verified) {
                        stats.unverified++;
                        dlog('[epBackfill] 已提交但复核未确认(疑似服务端写后读延迟): guid=' + ep.guid);
                        tick();
                        continue;
                    }
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
    const uv = stats.unverified;
    if (stats.failed) {
      setBtn(btn, '⚠ 补全 ' + done + ' · 失败 ' + stats.failed, '部分集写入失败，详见日志；可再点一次重试。');
    } else if (done) {
      setBtn(btn, '✓ 中文回填 ' + stats.filled + ' · 英文兜底 ' + stats.upgraded + (uv ? ' · 未确认 ' + uv : ''),
        uv ? '已提交但部分复核未确认，刷新页面核实；详见日志。'
           : (stats.upgraded ? '部分集数据源暂无中文，已用英文补齐（未加锁，后续中文可覆盖）。' : '标题/简介已写回飞牛元数据。'));
    } else if (uv) {
      setBtn(btn, '⚠ 已提交 ' + uv + ' · 未确认', '写回已提交但复核未确认，请刷新页面核实；详见日志。');
    } else if (stats.unmatched) {
      setBtn(btn, '⚠ ' + stats.unmatched + ' 集未匹配', 'TMDB 上也缺这些集的数据或集号对不上。');
    } else {
      setBtn(btn, '✓ 数据已最新', '每集标题/简介都与 TMDB 一致，无需补全。');
    }
    log('[epBackfill] 完成 S' + seasonNumber + ' total=' + stats.total + ' filled=' + stats.filled
      + ' fallback=' + stats.upgraded + ' unchanged=' + stats.unchanged
      + ' unmatched=' + stats.unmatched + ' failed=' + stats.failed
      + ' unverified=' + stats.unverified);
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
