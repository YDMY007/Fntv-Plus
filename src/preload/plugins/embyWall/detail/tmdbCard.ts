// embyWall/detail/tmdbCard.ts — 延后异步注入的 TMDB 信息卡（lc-980 重写）
// ─────────────────────────────────────────────────────────────────────────────
// 定位：这是「全套美化」里唯一的异步 + 追加节点特性。绝不阻塞首屏——
//   布局/底图/玻璃在 immersive.ts settle 时(≤1.5s)已由纯 CSS 完成并美观；
//   本卡在 settle 后才 fire 网络请求，resolve 后往右栏「演职人员」容器追加 1 个卡片节点(additive，非 relocate)。
//   网络慢/失败 → 静默，页面依旧美观。
// 纯函数(元数据解析/HTML 构建)从旧 season.ts salvage；DOM 作用域一律用精准 hero 选择器(避开 .semi-always-dark 36px 图标误命中)。
// 依赖(均现存)：fnosGetEditDetail(carousel/logo)、extractTmdbId(carousel/api)、主进程 tmdb:show IPC。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { fnosGetEditDetail } from '../carousel/logo';
import { extractTmdbId } from '../carousel/api';
import { DETAIL_HERO_SEL } from './glass';

const CARD_ID = 'fnos-beautify-tmdb-card';

// ── 运行时状态（换页重置）──
let _scheduledFor: string | null = null;   // 已为哪个 href 排过注入(去重)
let _tmdbInfoGuid = '';                    // 已加载的 guid(同页不重复请求)
let _tmdbInfoData: any = null;
let _tmdbInfoFetchedAt = 0;
let _tmdbInfoLoading = false;
let _tmdbInfoError = '';
let _tmdbMetaCache: { guid: string; title: string; year: string; tmdbId: string; mediaType: 'tv' | 'movie'; seasonNumber: number | null } | null = null;
let _seasonShowTitle = '';
let _seasonYearText = '';
let _seasonNumberCache: number | null = null;
let _nativeImdb: { href: string; text: string } | null = null;

function _resetState(): void {
  _tmdbInfoGuid = '';
  _tmdbInfoData = null;
  _tmdbInfoFetchedAt = 0;
  _tmdbInfoLoading = false;
  _tmdbInfoError = '';
  _tmdbMetaCache = null;
  _seasonShowTitle = '';
  _seasonYearText = '';
  _seasonNumberCache = null;
  _nativeImdb = null;
}

// ── 纯解析函数（salvage；作用域收敛到精准 hero）──

function detailHeaderScope(): HTMLElement | null {
  return document.querySelector<HTMLElement>(DETAIL_HERO_SEL) || document.querySelector<HTMLElement>('header');
}

function getSeasonPageGuid(): { guid: string; mediaType: 'tv' | 'movie' } | null {
  const m = location.pathname.match(/\/v\/(tv|movie)\/(?:season\/)?([a-f0-9]{32})/);
  if (!m) return null;
  return { guid: m[2], mediaType: m[1] === 'movie' ? 'movie' : 'tv' };
}

const _SYS_TITLE_DENY = ['飞牛影视', 'fnos'];
function _isSysTitle(t: string): boolean {
  const s = (t || '').trim().toLowerCase();
  if (!s) return true;
  for (const d of _SYS_TITLE_DENY) if (s === d.toLowerCase() || s.includes(d.toLowerCase())) return true;
  return false;
}

function findSeasonShowTitle(): string {
  if (_seasonShowTitle) return _seasonShowTitle;
  const scope = detailHeaderScope();
  let best = '';
  let bestSize = 0;
  if (scope) {
    const leaves = scope.querySelectorAll('*');
    const limit = Math.min(leaves.length, 1500);
    for (let i = 0; i < limit; i++) {
      const e = leaves[i] as HTMLElement;
      if (e.children.length !== 0) continue;
      const t = (e.textContent || '').trim();
      if (!t || t.length > 60 || _isSysTitle(t)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const size = parseFloat(getComputedStyle(e).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = t; }
    }
  }
  if (!best && document.title) {
    const parts = document.title.split(/\s*[-–—|]\s*/).map((p) => p.trim()).filter((p) => p && !_isSysTitle(p));
    best = parts.length ? parts.sort((a, b) => b.length - a.length)[0]
      : document.title.replace(/飞牛影视/g, '').replace(/\s*[-–—|]\s*/g, ' ').trim();
    best = best.replace(/第\s*[0-9一二三四五六七八九十百]+\s*季\s*$/, '').trim();
  }
  if (best) _seasonShowTitle = best;
  return best;
}

function findSeasonYearText(): string {
  if (_seasonYearText) return _seasonYearText;
  const scope = detailHeaderScope();
  if (!scope) return '';
  const leaves = scope.querySelectorAll('*');
  const limit = Math.min(leaves.length, 2000);
  for (let i = 0; i < limit; i++) {
    const e = leaves[i];
    if (e.children.length !== 0) continue;
    const t = (e.textContent || '').trim();
    if (/^((19|20)\d{2})\s*年?$/.test(t)) { _seasonYearText = t; return t; }
  }
  return '';
}

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

function findSeasonNumber(): number | null {
  if (_seasonNumberCache !== null) return _seasonNumberCache;
  const scope = detailHeaderScope();
  if (scope) {
    const leaves = scope.querySelectorAll('*');
    const limit = Math.min(leaves.length, 1500);
    for (let i = 0; i < limit; i++) {
      const e = leaves[i];
      if (e.children.length !== 0) continue;
      const t = (e.textContent || '').trim();
      const m = t.match(/^第\s*([0-9一二三四五六七八九十]+)\s*季$/) || t.match(/^Season\s*(\d{1,3})$/i) || t.match(/^S(\d{1,3})$/);
      if (m) {
        const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : cnNumToInt(m[1]);
        if (!isNaN(n)) { _seasonNumberCache = n; return n; }
      }
    }
  }
  return null;
}

async function loadShowMeta(): Promise<{ guid: string; title: string; year: string; tmdbId: string; mediaType: 'tv' | 'movie'; seasonNumber: number | null } | null> {
  const page = getSeasonPageGuid();
  if (!page) return null;
  if (_tmdbMetaCache && _tmdbMetaCache.guid === page.guid) return _tmdbMetaCache;
  let title = '', year = '', tmdbId = '';
  try {
    const data = await fnosGetEditDetail(location.origin, page.guid);
    if (data) {
      title = String(data.title || data.name || '').trim();
      if (_isSysTitle(title)) title = '';
      const yRaw = data.year || data.production_year || data.first_aired || data.premiere_date || data.date_created || '';
      const ym = String(yRaw).match(/(\d{4})/);
      if (ym) year = ym[1];
      tmdbId = extractTmdbId(data) || '';
      if (_seasonNumberCache === null) {
        const sn = data.index_number ?? data.IndexNumber ?? data.index ?? data.season_number;
        if (typeof sn === 'number' && !isNaN(sn)) _seasonNumberCache = sn;
      }
    }
  } catch (e) {
    dlog('[lc-980] getEditDetail 失败, 退回页面解析: ' + String(e).substring(0, 60));
  }
  if (!title) title = findSeasonShowTitle();
  if (!year) year = findSeasonYearText().replace(/\D/g, '').slice(0, 4);
  const meta = { guid: page.guid, title, year, tmdbId, mediaType: page.mediaType, seasonNumber: findSeasonNumber() };
  _tmdbMetaCache = meta;
  dlog('[lc-980] loadShowMeta: ' + JSON.stringify(meta));
  return meta;
}

function collectNativeImdb(): { href: string; text: string } | null {
  try {
    const a = Array.from(document.querySelectorAll('a')).find((el) => /imdb\.com\/title\//i.test(el.getAttribute('href') || '')) as HTMLElement | null | undefined;
    if (!a) { _nativeImdb = null; return null; }
    _nativeImdb = { href: (a.getAttribute('href') || '').trim(), text: ((a.textContent || '').trim() || 'IMDb').substring(0, 40) };
    return _nativeImdb;
  } catch (_) { _nativeImdb = null; return null; }
}

// ── HTML 构建（简化轻量版：只留关键字段，用 .fnos-showinfo__* 类）──

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** 来源行时间：省略年份（这一级信息最弱，「09-03 11:05」已足够）。 */
function shortTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => (n < 10 ? '0' + n : String(n));
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/** 短时长：进 meta 串用，「23 分」比「23 分钟」省一个字宽。 */
function runtime(min: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (h + ' 小时' + (m ? ' ' + m + ' 分' : '')) : (m + ' 分');
}

/** 5 星图形：底层灰星 + 顶层金星按 inline width 裁切。纯 CSS，无 SVG、无环形进度（那会引入新的「框」）。
 *  TMDB 是 0~10 分制 → 金星宽度 = rating/10。 */
function starsHtml(rating: number): string {
  const pct = Math.max(0, Math.min(100, (rating / 10) * 100));
  return '<span class="fnos-showinfo__stars">'
    + '<span class="fnos-showinfo__stars-bg">★★★★★</span>'
    + `<span class="fnos-showinfo__stars-fg" style="width:${pct.toFixed(1)}%">★★★★★</span>`
    + '</span>';
}

/** URL 协议白名单：卡片走 innerHTML 渲染，`esc()` 只转义引号尖括号，挡不住 `javascript:` 这类
 *  点击即执行的协议。homepage 来自 TMDB 网络响应、IMDB href 来自页面 DOM，都是不可信外部数据。 */
function safeUrl(u: any): string {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

const STATUS_CN: Record<string, string> = {
  'Returning Series': '连载中', 'Ended': '已完结', 'Canceled': '已取消', 'In Production': '制作中',
  'Planned': '计划中', 'Pilot': '试播集', 'Released': '已上映', 'Post Production': '后期制作', 'Rumored': '传闻中',
};

function buildCardHtml(d: any): string {
  const blocks: string[] = [];
  const inline = (list: any[], max = 8): string =>
    (Array.isArray(list) && list.length) ? esc(list.slice(0, max).filter(Boolean).join(' · ')) : '';

  // ① 评分块：右栏唯一的视觉锚。旧版 17px 与 13px 正文行几乎无层级差 → 评分被埋没。
  if (d.rating) {
    const r = Number(d.rating);
    const votes = d.votes
      ? `<span class="fnos-showinfo__votes">${esc(Number(d.votes).toLocaleString('zh-CN'))} 人评分</span>` : '';
    blocks.push(
      '<div class="fnos-showinfo__block fnos-showinfo__score">'
      + `<div class="fnos-showinfo__rating"><span class="fnos-showinfo__num">${r.toFixed(1)}</span><span class="fnos-showinfo__outof">⁄10</span></div>`
      + `<div class="fnos-showinfo__rsub">${starsHtml(r)}${votes}</div>`
      + '</div>'
    );
  }

  // ② meta 串：无 label 的两行灰字，取代旧版「状态/规模/类型/单集」四行 label-value。
  //    label 本身不携带信息，只把真正的值推到右边一列让眼睛来回横跳 —— 这是表单味的根源。
  //    地区刻意不进串：tmdbSync 对 tv 取 origin_country(ISO 码「JP」)、对 movie 取英文名(「Japan」)，
  //    两种形态不一致，中文界面里会显示成突兀缩写；且它是本串价值最低的字段。
  const metaMain: string[] = [];
  if (d.year) metaMain.push(String(d.year));
  if (Array.isArray(d.genres) && d.genres.length) metaMain.push(...d.genres.slice(0, 3).map(String).filter(Boolean));
  const metaSub: string[] = [];
  if (d.seasons) metaSub.push(d.seasons + ' 季');
  if (d.episodes) metaSub.push(d.episodes + ' 集');
  const st = STATUS_CN[d.status] || d.status || '';
  if (st) metaSub.push(String(st));
  if (d.runtimeAvg) metaSub.push('单集 ' + runtime(d.runtimeAvg));
  if (metaMain.length || metaSub.length) {
    blocks.push(
      '<div class="fnos-showinfo__block fnos-showinfo__meta">'
      + (metaMain.length ? `<div>${esc(metaMain.join(' · '))}</div>` : '')
      + (metaSub.length ? `<div class="fnos-showinfo__meta-sub">${esc(metaSub.join(' · '))}</div>` : '')
      + '</div>'
    );
  }

  // ③ 事实区：只留 hero 与 meta 串都没承载的字段。完整日期/平台/主创/语言/分级/原名。
  const rows: string[] = [];
  const row = (k: string, v: string): void => {
    if (v) rows.push(`<div class="fnos-showinfo__row"><span class="fnos-showinfo__k">${esc(k)}</span><span class="fnos-showinfo__v">${v}</span></div>`);
  };
  const dates: string[] = [];
  if (d.airDate) dates.push(String(d.airDate));
  if (d.lastAirDate && d.lastAirDate !== d.airDate) dates.push(String(d.lastAirDate));
  row('首播', esc(dates.join(' — ')));
  row('平台', inline(d.networks, 3));
  row('主创', inline(d.createdBy, 4));
  row('语言', inline(d.languages, 3));
  if (d.certification) row('分级', esc(d.certification));
  // 原名降到事实区末行：它很长（日文原名常占两三行），放顶部会把评分块和 meta 串的节奏冲散。
  if (d.originalTitle && d.originalTitle !== d.title) row('原名', esc(d.originalTitle));
  if (rows.length) blocks.push(`<div class="fnos-showinfo__block fnos-showinfo__facts">${rows.join('')}</div>`);

  // ④ 外链
  const links: string[] = [];
  const link = (href: string, text: string): void => {
    const u = safeUrl(href);
    if (u && text) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(text)}</a>`);
  };
  if (d.url) link(d.url, 'TMDB');
  const imdb = (d.externalIds && d.externalIds.imdb) ? 'https://www.imdb.com/title/' + d.externalIds.imdb : (_nativeImdb ? _nativeImdb.href : '');
  if (imdb) link(imdb, 'IMDb');
  if (d.trailerKey) link('https://www.youtube.com/watch?v=' + d.trailerKey, '预告片');
  if (d.homepage) link(d.homepage, '官网');
  if (links.length) blocks.push(`<div class="fnos-showinfo__block fnos-showinfo__links">${links.join('<span>·</span>')}</div>`);

  return blocks.join('');
}

// ── 卡片节点定位/渲染/调度 ──

/** 右栏容器：内容列(hero.parentElement)的第 3 个子节点(演职人员)；取不到则退回内容列本身。 */
function _rightColumn(): HTMLElement | null {
  const hero = document.querySelector<HTMLElement>(DETAIL_HERO_SEL);
  if (!hero || !hero.parentElement) return null;
  const col = hero.parentElement;
  return (col.children[2] as HTMLElement) || col;
}

function _ensureCardEl(): HTMLElement | null {
  let card = document.getElementById(CARD_ID) as HTMLElement | null;
  if (card) return card;
  const host = _rightColumn();
  if (!host) return null;
  card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'fnos-beautify-card';
  // 追加进右栏顶部(additive，不移动任何原生节点)
  host.insertBefore(card, host.firstChild || null);
  return card;
}

function _renderCard(): void {
  const card = _ensureCardEl();
  if (!card) return;
  let body = '';
  if (_tmdbInfoData) body = buildCardHtml(_tmdbInfoData);
  else if (_tmdbInfoLoading) body = '<div class="fnos-showinfo__loading">正在从 TMDB 获取剧集信息…</div>';
  else if (_tmdbInfoError) body = `<div class="fnos-showinfo__error">${esc(_tmdbInfoError)}</div>`;
  const when = _tmdbInfoFetchedAt ? shortTime(_tmdbInfoFetchedAt) : '';
  const foot = `<div class="fnos-showinfo__foot"><span>数据来源 TMDB${when ? ' · ' + esc(when) : ''}</span>`
    + `<button type="button" class="fnos-showinfo__refresh" title="从 TMDB 重新获取本剧信息">${_tmdbInfoLoading ? '获取中…' : '⟳'}</button></div>`;
  const next = body + foot;
  if (card.innerHTML === next) return; // 内容未变 → 不触碰 DOM
  card.innerHTML = next;

  const btn = card.querySelector('.fnos-showinfo__refresh') as HTMLElement | null;
  if (btn) btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); if (!_tmdbInfoLoading) _fetch(true); });
}

function _fetch(force = false): void {
  const page = getSeasonPageGuid();
  if (!page) return;
  if (!force && _tmdbInfoGuid === page.guid && _tmdbInfoData) { _renderCard(); return; }
  if (_tmdbInfoLoading) return;
  _tmdbInfoLoading = true;
  _tmdbInfoGuid = page.guid;
  if (force) _tmdbInfoError = '';
  collectNativeImdb();
  _renderCard(); // 先渲染「正在获取…」
  void (async () => {
    try {
      const meta = await loadShowMeta();
      if (!meta) { _tmdbInfoLoading = false; _tmdbInfoError = '当前页面不是季/详情路由'; _renderCard(); return; }
      const r = await ipcRenderer.invoke('tmdb:show', {
        tmdbId: meta.tmdbId || undefined,
        title: meta.title || undefined,
        year: meta.year || undefined,
        mediaType: meta.mediaType,
        seasonNumber: meta.seasonNumber === null ? undefined : meta.seasonNumber,
        force: !!force,
      });
      if (r && r.ok && r.data) {
        _tmdbInfoData = r.data;
        _tmdbInfoFetchedAt = r.fetchedAt || Date.now();
        _tmdbInfoError = '';
        log('[lc-980] TMDB 卡就绪: ' + (r.data.title || ''));
      } else {
        _tmdbInfoError = (r && r.error) || 'TMDB 获取失败';
      }
    } catch (e) {
      _tmdbInfoError = String(e).substring(0, 120);
    } finally {
      _tmdbInfoLoading = false;
      // 异步 resolve 时可能已离开该页 → 仅当仍在详情页才渲染
      if (getSeasonPageGuid()) _renderCard();
    }
  })();
}

/** settle 后调度：同一 href 只排一次；追加卡片占位并异步拉取。非阻塞。 */
export function scheduleTmdbCard(_view: HTMLElement): void {
  const href = location.href;
  if (_scheduledFor === href) return;
  _scheduledFor = href;
  _fetch(false);
}

/** 移除卡片 + 重置状态（离开详情页 / 换页 soft-reset）。 */
export function removeTmdbCard(): void {
  const card = document.getElementById(CARD_ID);
  if (card && card.parentNode) card.parentNode.removeChild(card);
  _scheduledFor = null;
  _resetState();
}
