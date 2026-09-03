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

// ── HTML 构建（简化轻量版：只留关键字段，用 .fnos-beautify-card__* 类）──

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function runtime(min: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (h + ' 小时 ' + m + ' 分') : (m + ' 分钟');
}
const STATUS_CN: Record<string, string> = {
  'Returning Series': '连载中', 'Ended': '已完结', 'Canceled': '已取消', 'In Production': '制作中',
  'Planned': '计划中', 'Pilot': '试播集', 'Released': '已上映', 'Post Production': '后期制作', 'Rumored': '传闻中',
};

function buildCardHtml(d: any): string {
  const out: string[] = [];
  const row = (k: string, v: string): void => {
    if (v) out.push(`<div class="fnos-beautify-card__row"><span class="fnos-beautify-card__k">${esc(k)}</span><span class="fnos-beautify-card__v">${v}</span></div>`);
  };
  const tags = (list: any[], max = 8): string => (Array.isArray(list) && list.length)
    ? `<span class="fnos-beautify-card__tags">${list.slice(0, max).map((t) => `<span class="fnos-beautify-card__tag">${esc(t)}</span>`).join('')}</span>` : '';

  const nameLine = [esc(d.title || '')];
  if (d.originalTitle && d.originalTitle !== d.title) nameLine.push(`<span class="fnos-beautify-card__orig">${esc(d.originalTitle)}</span>`);
  out.push(`<div class="fnos-beautify-card__title">${nameLine.join(' ')}</div>`);

  if (d.rating) {
    const votes = d.votes ? `<span class="fnos-beautify-card__votes">${Number(d.votes).toLocaleString('zh-CN')} 人评分</span>` : '';
    out.push(`<div class="fnos-beautify-card__rating"><b class="fnos-beautify-card__score">${Number(d.rating).toFixed(1)}</b><span> / 10</span> ${votes}</div>`);
  }

  const st = STATUS_CN[d.status] || d.status || '';
  const dateParts: string[] = [];
  if (d.airDate) dateParts.push('首播 ' + d.airDate);
  if (d.lastAirDate && d.lastAirDate !== d.airDate) dateParts.push('完结 ' + d.lastAirDate);
  if (st || dateParts.length) row('状态', [esc(st), esc(dateParts.join(' · '))].filter(Boolean).join(' · '));

  const cntParts: string[] = [];
  if (d.seasons) cntParts.push(d.seasons + ' 季');
  if (d.episodes) cntParts.push(d.episodes + ' 集');
  if (cntParts.length) row('规模', esc(cntParts.join(' · ')));
  if (d.season) {
    const sp: string[] = [];
    if (d.season.episodeCount) sp.push(d.season.episodeCount + ' 集');
    if (d.season.airDate) sp.push('首播 ' + d.season.airDate);
    row('第 ' + d.season.seasonNumber + ' 季', [esc(d.season.name), esc(sp.join(' · '))].filter(Boolean).join(' · '));
  }
  if (d.runtimeAvg) {
    const rt = d.runtimeMin && d.runtimeMax && d.runtimeMin !== d.runtimeMax ? `${runtime(d.runtimeMin)} ~ ${runtime(d.runtimeMax)}` : runtime(d.runtimeAvg);
    row('单集', esc(rt));
  }
  row('类型', tags(d.genres));
  if (Array.isArray(d.networks) && d.networks.length) row('首播平台', esc(d.networks.join(' / ')));
  if (Array.isArray(d.createdBy) && d.createdBy.length) row('主创', esc(d.createdBy.join(' / ')));
  if (Array.isArray(d.cast) && d.cast.length) {
    const chips = d.cast.slice(0, 10).map((c: any) => `<span class="fnos-beautify-card__tag">${esc(c.name || '')}${c.character ? `<i class="fnos-beautify-card__char">${esc(c.character)}</i>` : ''}</span>`).join('');
    row('主演', `<span class="fnos-beautify-card__tags">${chips}</span>`);
  }
  if (d.overview) out.push(`<div class="fnos-beautify-card__desc fnos-beautify-card__clamp">${esc(d.overview)}</div>`);

  const links: string[] = [];
  const link = (href: string, text: string): void => { if (href && text) links.push(`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`); };
  if (d.url) link(d.url, 'TMDB');
  const imdb = (d.externalIds && d.externalIds.imdb) ? 'https://www.imdb.com/title/' + d.externalIds.imdb : (_nativeImdb ? _nativeImdb.href : '');
  if (imdb) link(imdb, 'IMDb');
  if (d.trailerKey) link('https://www.youtube.com/watch?v=' + d.trailerKey, '预告片');
  if (d.homepage) link(d.homepage, '官网');
  if (links.length) out.push(`<div class="fnos-beautify-card__links">${links.join('<span>·</span>')}</div>`);

  return out.join('');
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
  else if (_tmdbInfoLoading) body = '<div class="fnos-beautify-card__loading">正在从 TMDB 获取剧集信息…</div>';
  else if (_tmdbInfoError) body = `<div class="fnos-beautify-card__error">${esc(_tmdbInfoError)}</div>`;
  const when = _tmdbInfoFetchedAt ? (' 更新于 ' + fmtTime(_tmdbInfoFetchedAt)) : '';
  const foot = `<div class="fnos-beautify-card__foot"><span>TMDB${esc(when)}</span>`
    + `<button type="button" class="fnos-beautify-card__refresh" title="从 TMDB 重新获取本剧信息">${_tmdbInfoLoading ? '获取中…' : '⟳ 刷新'}</button></div>`;
  const next = body + foot;
  if (card.innerHTML === next) return; // 内容未变 → 不触碰 DOM
  card.innerHTML = next;

  const desc = card.querySelector('.fnos-beautify-card__desc') as HTMLElement | null;
  if (desc) desc.addEventListener('click', () => desc.classList.toggle('fnos-beautify-card__clamp'));
  const btn = card.querySelector('.fnos-beautify-card__refresh') as HTMLElement | null;
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
