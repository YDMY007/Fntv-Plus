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
import { DETAIL_HERO_SEL, findActiveDetailView } from './glass';

const CARD_ID = 'fnos-beautify-tmdb-card';

// ── [lc-1010] Series 一级页专属 ──
// ⚠ SERIES_PANEL_SEL 必须与 beautifyStyle.ts 的 SERIES_PANEL 逐字一致（两处各存一份是刻意的，
//   同 HERO/DETAIL_HERO_SEL 约定：共享常量会把纯 CSS 文件拽进运行时依赖）。
//   整串精确类名匹配，季页(px-[46px])/电影页结构性不误伤（2026-09-05 活体交叉验证）。
const SERIES_PANEL_SEL = 'div[class="relative box-border flex w-full flex-col px-[44px]"]';
const SERIES_BODY_CLS = 'fnos-series-panel';
// [lc-1028] Movie 一级页(/v/movie/<id>, 组件 Zse isVideo 分支)。面板=简介区, 与文件信息区
//   (px-[46px] + gap-4)只差一个类 → 仍用整串精确匹配区分（活体 2026-09-05 实采）。
const MOVIE_PANEL_SEL = 'div[class="relative flex w-full flex-col box-border px-[46px]"]';
const MOVIE_BODY_CLS = 'fnos-movie-panel';
/** 面板 settle 后可能晚于 hero 渲染 → 有上限的重试链（同 epResolution 模式，绝不变轮询）。 */
const SERIES_RETRY_DELAYS = [0, 350, 900, 1800, 3000];
let _seriesTimers: number[] = [];
let _seriesResizeBound = false;
let _seriesResizeTimer = 0;

function _isSeriesRoute(): boolean {
  // 仅 tv 一级页：电影一级页(组件 Q/Zse isVideo 分支)结构未采样验证，本轮不放开。
  return /\/v\/tv\/[a-f0-9]{32}\/?$/.test(location.pathname);
}

/** [lc-1028] Movie 一级页。活体结构（2026-09-05 /v/movie/36b7d8e5… 实采）：与 Series 同族——
 *  同 col(mb-[46px] flex flex-col gap-3)、同 wrapper(relative.w-full)、同 hero 类名
 *  (trim-mc__details--key-version + .gradient h-45% + logo 锚点)、同 mt-4 按钮行；
 *  差异仅在 col.children[1..3] = 简介(px-[46px])/演职人员(mb-10)/文件信息+IMDB(px-[46px] gap-4)。 */
function _isMovieRoute(): boolean {
  return /\/v\/movie\/[a-f0-9]{32}\/?$/.test(location.pathname);
}

/** 一级页（Series/Movie 共用行为：聚簇武装、卡片失败即撤、全量卡片内容）。 */
function _isOneLevel(): boolean {
  return _isSeriesRoute() || _isMovieRoute();
}

/** 当前活跃视图内的内容面板（Series=简介/季选/外链容器；Movie=简介容器）。 */
function _pagePanel(): HTMLElement | null {
  const view = findActiveDetailView();
  if (!view) return null;
  return view.querySelector<HTMLElement>(_isSeriesRoute() ? SERIES_PANEL_SEL : MOVIE_PANEL_SEL);
}

/** [lc-1010] 简介全文回填。原生把简介截成 1 行（文本节点只剩前缀 + 「更多」按钮），
 *  活体实测「更多」点击（Playwright click / CUA 坐标 / el.click()）均不展开 → 文本根本不在 DOM。
 *  全文在 React fiber 的 props 里（截断组件 ile 的 props，实测 hop=1；Series=props.intro，
 *  [lc-1028] Movie=props.overview）→ 从 fiber 取回后写回**文本节点 data**（与截断库同一手法，
 *  不 replace/不删节点，React 卸载安全）。幂等：已是全文（t.length === full.length）不重复写。
 *  返回是否发生了回填。 */
function _fillSeriesIntro(): boolean {
  const panel = _pagePanel();
  if (!panel) return false;
  const ov = panel.querySelector<HTMLElement>(':scope > div[class*="text-justify"]');
  if (!ov) return false;
  const fiberKey = Object.keys(ov as any).find((k) => k.indexOf('__reactFiber') === 0);
  if (!fiberKey) return false;
  let f: any = (ov as any)[fiberKey];
  let full = '';
  for (let i = 0; i < 40 && f && !full; i++) {
    const p = f && f.memoizedProps;
    if (p && typeof p === 'object') {
      for (const k of ['intro', 'overview']) {
        const v = (p as any)[k];
        if (typeof v === 'string' && v.length > 40) { full = v; break; }
      }
    }
    f = f && f.return;
  }
  if (!full) return false;
  let done = false;
  const walker = document.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
  let tn: Node | null;
  while ((tn = walker.nextNode()) && !done) {
    const t = (tn.nodeValue || '').trim();
    if (t.length > 20 && full.startsWith(t) && t.length < full.length) {
      tn.nodeValue = full;
      done = true;
    }
  }
  if (done) ov.classList.add('fnos-intro-full'); // N6/O6 段据此隐藏失效的「更多」按钮
  return done;
}

/** [lc-1010] 实测面板高度 → body 级 --fnos-cluster-h（beautifyStyle.ts N3/N4/O3/O4 的按钮行/logo 都挂在它上）。
 *  面板高度由左列（简介+季选/简介）驱动；TMDB 卡是绝对定位右列，不参与撑高。
 *  [lc-1029] 底距固定为设计常量 18px，**不再读 computed bottom**——Movie 页 col 被折叠线下的
 *  演职人员/文件信息撑高，computed bottom = col底-面板顶（数百 px）且随面板上移自我放大
 *  （644→993→…反馈回路），cluster-h 爆炸后整个聚簇飞出视口（用户截图：纯海报无内容区）。
 *  Series 页 computed bottom 恒为 18，常量与旧读法等价，零回归。 */
function _measureSeriesPanel(): void {
  const panel = _pagePanel();
  if (!panel) return;
  const h = panel.getBoundingClientRect().height;
  document.body.style.setProperty('--fnos-cluster-h', Math.ceil(h + 18) + 'px');
}

/** resize：截断库会按它闭包里的全文**重新截断**简介（活体实证）→ 回填必须重跑；
 *  220ms 去抖晚于库的同步 handler，最终态必是全文。顺带重测聚簇高度。 */
function _onSeriesResize(): void {
  clearTimeout(_seriesResizeTimer);
  _seriesResizeTimer = window.setTimeout(() => {
    if (!_isOneLevel()) return;
    _fillSeriesIntro();
    _measureSeriesPanel();
  }, 220);
}

function _clearSeriesTimers(): void {
  for (let i = 0; i < _seriesTimers.length; i++) clearTimeout(_seriesTimers[i]);
  _seriesTimers = [];
}

/** 一级页聚簇开关：body class(N/O 段 CSS 总闸) + 简介/高度的重试链 + resize 监听。幂等。 */
function _armSeriesPanel(): void {
  document.body.classList.add(_isSeriesRoute() ? SERIES_BODY_CLS : MOVIE_BODY_CLS);
  if (!_seriesResizeBound) {
    window.addEventListener('resize', _onSeriesResize, { passive: true });
    _seriesResizeBound = true;
  }
  _clearSeriesTimers();
  for (let i = 0; i < SERIES_RETRY_DELAYS.length; i++) {
    _seriesTimers.push(window.setTimeout(() => {
      if (!_isOneLevel()) return;
      _fillSeriesIntro();
      _measureSeriesPanel();
    }, SERIES_RETRY_DELAYS[i]));
  }
}

function _disarmSeriesPanel(): void {
  _clearSeriesTimers();
  clearTimeout(_seriesResizeTimer);
  if (_seriesResizeBound) {
    window.removeEventListener('resize', _onSeriesResize);
    _seriesResizeBound = false;
  }
  document.body.classList.remove(SERIES_BODY_CLS);
  document.body.classList.remove(MOVIE_BODY_CLS);
  document.body.style.removeProperty('--fnos-cluster-h');
}

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
  _disarmMountRetry();
}

// ── [lc-1020] 挂载竞态自愈：有界重试链 ──
// 用户报障：二级详情页首次进入只显示演员信息、剧集信息卡要退出重进才出现。
// 根因：季页卡片宿主 = 内容列 children[2]（演职人员区），由 fnOS **异步**渲染；而
// _renderCard 只有两次时机（scheduleTmdbCard 时 + TMDB fetch resolve 时），TMDB 缓存命中时
// fetch 毫秒级返回、必然早于演员区 → 两次 _ensureCardEl() 都拿不到宿主 → 永久放弃
// （_scheduledFor 又挡住同 href 重新调度）。重进时 SPA cache-outlet 里演员区已存在 → 一次就挂上。
// 补一条有界重试链（仿 SERIES_RETRY_DELAYS），演员区渲染出来即挂载；teardown/换页即撤。
const MOUNT_RETRY_DELAYS = [300, 800, 1600, 2800, 4200];
let _mountRetryTimer = 0;
let _mountRetryIdx = 0;

function _armMountRetry(): void {
  if (_mountRetryTimer) return;
  if (_mountRetryIdx >= MOUNT_RETRY_DELAYS.length) return; // 预算耗尽（演员区确实一直没渲染）
  _mountRetryTimer = window.setTimeout(() => {
    _mountRetryTimer = 0;
    _mountRetryIdx++;
    _renderCard();
  }, MOUNT_RETRY_DELAYS[_mountRetryIdx]);
}

function _disarmMountRetry(): void {
  if (_mountRetryTimer) { clearTimeout(_mountRetryTimer); _mountRetryTimer = 0; }
  _mountRetryIdx = 0;
}

// ── 纯解析函数（salvage；作用域收敛到精准 hero）──

/** [lc-993] 取「当前活跃视图内」的 hero，而不是全文档第一个匹配的 hero。
 *  fnOS 的视图栈(cache-outlet)切页后**不移除**旧视图，只在 --exclude(活跃)/--cache(隐藏)之间切换；
 *  DETAIL_HERO_SEL 扩容到三种 hero 后，裸 document.querySelector 会按文档顺序先命中上一页残留的
 *  hero(Series→Season 导航时旧 Series 视图就在前面) → 读到上一页的标题/年份/季号去查 TMDB → 卡内容张冠李戴。
 *  findActiveDetailView() 是 immersive.ts 三闸里同一个判定(从后往前 + offsetParent!==null + 内含 hero)，
 *  epResolution.ts 早已这么用。 */
function _activeHero(): HTMLElement | null {
  const view = findActiveDetailView();
  return view ? view.querySelector<HTMLElement>(DETAIL_HERO_SEL) : null;
}

function detailHeaderScope(): HTMLElement | null {
  return _activeHero() || document.querySelector<HTMLElement>('header');
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

/** 剧集形式（TMDB tv.type）。 */
const TYPE_CN: Record<string, string> = {
  Scripted: '剧本剧', Reality: '真人秀', Talk: '访谈', Documentary: '纪录片',
  Miniseries: '限定剧', News: '新闻', Kids: '少儿',
};

/** 地区 ISO 3166-1 → 中文。TMDB 的 production_countries.name 不随 language=zh-CN 翻译（恒为英文），
 *  origin_country 又只有码 → 用码表映射，未命中回退原值（宁显示英文也不留空）。 */
const COUNTRY_CN: Record<string, string> = {
  JP: '日本', KR: '韩国', US: '美国', GB: '英国', CN: '中国', HK: '中国香港', TW: '中国台湾',
  FR: '法国', DE: '德国', ES: '西班牙', IT: '意大利', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰',
  RU: '俄罗斯', IN: '印度', TH: '泰国', VN: '越南', ID: '印度尼西亚', MY: '马来西亚', SG: '新加坡', PH: '菲律宾',
  BR: '巴西', MX: '墨西哥', AR: '阿根廷', CL: '智利', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰',
  NL: '荷兰', BE: '比利时', CH: '瑞士', AT: '奥地利', PL: '波兰', CZ: '捷克', HU: '匈牙利', GR: '希腊',
  PT: '葡萄牙', IE: '爱尔兰', TR: '土耳其', UA: '乌克兰', IL: '以色列', SA: '沙特阿拉伯', AE: '阿联酋',
  EG: '埃及', ZA: '南非', IS: '冰岛', RO: '罗马尼亚', BG: '保加利亚', HR: '克罗地亚', RS: '塞尔维亚', SK: '斯洛伐克',
};

/** 语言 ISO 639-1 → 中文（TMDB 的 english_name 在中文界面里显示成「Korean」）。
 *  注意 TMDB 用非标准码 cn 表示粤语、zh 表示普通话。 */
const LANG_CN: Record<string, string> = {
  ja: '日语', ko: '韩语', zh: '普通话', cn: '粤语', en: '英语', fr: '法语', de: '德语', es: '西班牙语',
  it: '意大利语', pt: '葡萄牙语', ru: '俄语', th: '泰语', vi: '越南语', id: '印尼语', ms: '马来语',
  hi: '印地语', ar: '阿拉伯语', tr: '土耳其语', pl: '波兰语', nl: '荷兰语', sv: '瑞典语', no: '挪威语',
  da: '丹麦语', fi: '芬兰语', cs: '捷克语', hu: '匈牙利语', el: '希腊语', he: '希伯来语', uk: '乌克兰语',
  ro: '罗马尼亚语', bg: '保加利亚语', sr: '塞尔维亚语', hr: '克罗地亚语', sk: '斯洛伐克语',
  sl: '斯洛文尼亚语', et: '爱沙尼亚语', lv: '拉脱维亚语', lt: '立陶宛语', is: '冰岛语', ca: '加泰罗尼亚语',
  eu: '巴斯克语', gl: '加利西亚语', la: '拉丁语', bn: '孟加拉语', ta: '泰米尔语', te: '泰卢固语',
  ur: '乌尔都语', fa: '波斯语', sw: '斯瓦希里语', fil: '菲律宾语', my: '缅甸语', km: '高棉语', lo: '老挝语',
  mn: '蒙古语', ne: '尼泊尔语', si: '僧伽罗语', ka: '格鲁吉亚语', hy: '亚美尼亚语', az: '阿塞拜疆语',
  kk: '哈萨克语', uz: '乌兹别克语', ku: '库尔德语', mt: '马耳他语', mk: '马其顿语', sq: '阿尔巴尼亚语',
  bs: '波斯尼亚语', af: '南非荷兰语',
};

/** 码表映射：优先用码（形态稳定），码缺失时退回英文名数组；未命中回退原值，去重限量。 */
function mapList(codes: any[], table: Record<string, string>, fallback: any[], max = 6): string[] {
  const src = (Array.isArray(codes) && codes.length) ? codes : (Array.isArray(fallback) ? fallback : []);
  const out: string[] = [];
  for (let i = 0; i < src.length && out.length < max; i++) {
    const raw = String(src[i] == null ? '' : src[i]).trim();
    if (!raw) continue;
    const v = table[raw] || table[raw.toLowerCase()] || table[raw.toUpperCase()] || raw;
    if (out.indexOf(v) === -1) out.push(v);
  }
  return out;
}

/** 社交账号名白名单：这些 id 来自 TMDB 网络响应，会被拼进 URL 路径，只放行安全字符集。 */
function handle(v: any): string {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_.\-]{1,60}$/.test(s) ? s : '';
}

/** 剧照：主进程已返回 backdrops 路径（此前从未使用）。图片本体走 tmdb:image 代理异步取，
 *  渲染阶段只放占位 img（不给 src → 不会产生任何请求，也不会出现破图标）。 */
const STILL_MAX = 3;
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';

/** fromStillsOnly：二级(季)页裁剪 [lc-1022]。一级详情页(lc-1010 放开)右栏已展示同一张 TMDB 卡的
 *  完整内容，季页再渲染评分/标语/meta/事实/主创/本季就是整卡原样重复 → 用户指定只保留
 *  「剧照」及以后的分节。一级页不传本开关，维持全量。 */
export function buildCardHtml(d: any, opts?: { fromStillsOnly?: boolean }): string {
  const full = !opts?.fromStillsOnly;
  const blocks: string[] = [];
  const inline = (list: any[], max = 8): string =>
    (Array.isArray(list) && list.length) ? esc(list.slice(0, max).filter(Boolean).join(' · ')) : '';
  /** 一行「窄 label + 值」。v 必须是已 esc 的 HTML。 */
  const rowHtml = (k: string, v: string): string =>
    `<div class="fnos-showinfo__row"><span class="fnos-showinfo__k">${esc(k)}</span><span class="fnos-showinfo__v">${v}</span></div>`;
  /** 带发丝线与小标题的分节（节内只有纯文本行，不套任何内部框）。 */
  const sec = (title: string, body: string): string =>
    `<div class="fnos-showinfo__block fnos-showinfo__sec"><div class="fnos-showinfo__sec-t">${esc(title)}</div>${body}</div>`;

  // ① 评分块：右栏唯一的视觉锚。
  if (full && d.rating) {
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

  // ② 标语：TMDB tagline，一句话，比简介更早给出这部剧的调性。
  if (full && d.tagline && String(d.tagline).trim() && d.tagline !== d.overview) {
    blocks.push(`<div class="fnos-showinfo__block fnos-showinfo__tag">${esc(d.tagline)}</div>`);
  }

  // ③ meta 串：无 label 的两行灰字（年份/类型 + 规模/状态/单集时长）。
  const metaMain: string[] = [];
  if (d.year) metaMain.push(String(d.year));
  if (Array.isArray(d.genres) && d.genres.length) metaMain.push(...d.genres.slice(0, 4).map(String).filter(Boolean));
  const metaSub: string[] = [];
  if (d.seasons) metaSub.push(d.seasons + ' 季');
  if (d.episodes) metaSub.push(d.episodes + ' 集');
  const st = STATUS_CN[d.status] || d.status || '';
  if (st) metaSub.push(String(st));
  if (d.runtimeAvg) {
    const lo = Number(d.runtimeMin) || Number(d.runtimeAvg);
    const hi = Number(d.runtimeMax) || Number(d.runtimeAvg);
    metaSub.push(lo !== hi && hi <= 90 ? ('单集 ' + lo + '–' + hi + ' 分') : ('单集 ' + runtime(Number(d.runtimeAvg))));
  }
  if (full && (metaMain.length || metaSub.length)) {
    blocks.push(
      '<div class="fnos-showinfo__block fnos-showinfo__meta">'
      + (metaMain.length ? `<div>${esc(metaMain.join(' · '))}</div>` : '')
      + (metaSub.length ? `<div class="fnos-showinfo__meta-sub">${esc(metaSub.join(' · '))}</div>` : '')
      + '</div>'
    );
  }

  // ⑤ 事实区（播出与规格）：窄 label 列，组内靠 4px padding 分行，无横线。
  const rows: string[] = [];
  const row = (k: string, v: string): void => { if (v) rows.push(rowHtml(k, v)); };
  const dates: string[] = [];
  if (d.airDate) dates.push(String(d.airDate));
  if (d.lastAirDate && d.lastAirDate !== d.airDate) dates.push(String(d.lastAirDate));
  row('首播', esc(dates.join(' — ')));
  if (d.nextEpisode) {
    const ne = d.nextEpisode;
    const bits: string[] = [];
    if (ne.episodeNumber) bits.push('第 ' + ne.episodeNumber + ' 集');
    if (ne.airDate) bits.push(String(ne.airDate));
    // 集名与集号等价时不要再包《》：TMDB 上大量条目(盗墓王实测 name="第 10 集")的集名就是
    //   「第 N 集」本身，无条件加会渲染成「第 10 集 · 2026-09-09 · 《第 10 集》」——同一件事说两遍。
    const nm = String(ne.name || '').trim();
    if (nm && !/^(第\s*\d+\s*[集话話期]|episode\s*\d+|#\d+|\d+)$/i.test(nm)) bits.push('《' + nm + '》');
    row('下一集', esc(bits.join(' · ')));
  }
  row('平台', inline(d.networks, 4));
  if (d.showType) row('形式', esc(TYPE_CN[d.showType] || d.showType));
  const ctry = mapList(d.countryCodes, COUNTRY_CN, d.countries, 5);
  if (ctry.length) row('地区', esc(ctry.join(' · ')));
  const langs = mapList(d.languageCodes, LANG_CN, d.languages, 5);
  if (langs.length) row('语言', esc(langs.join(' · ')));
  const certs = (Array.isArray(d.certifications) ? d.certifications : []).filter((c: any) => c && c.rating);
  if (certs.length) {
    row('分级', esc(certs.slice(0, 4).map((c: any) => (c.region ? c.region + ' ' : '') + c.rating).join(' · ')));
  } else if (d.certification) {
    row('分级', esc(d.certification));
  }
  // 原名降到事实区末行：日文/韩文原名常占两三行，放顶部会冲散评分块与 meta 串的节奏。
  if (d.originalTitle && d.originalTitle !== d.title) row('原名', esc(d.originalTitle));
  if (full && rows.length) blocks.push(`<div class="fnos-showinfo__block fnos-showinfo__facts">${rows.join('')}</div>`);

  // ⑥ 主创：原生「演职人员」区实机确认只有配音演员（无导演/编剧分工），这里补齐不重复。
  //    cast 名单刻意不渲染 —— 那才真的和原生区撞车。
  const crew: string[] = [];
  const crow = (k: string, list: any[], max: number): void => {
    const v = inline(list, max);
    if (v) crew.push(rowHtml(k, v));
  };
  crow('创作者', d.createdBy, 4);
  crow('导演', d.directors, 4);
  crow('编剧', d.writers, 6);
  crow('作曲', d.composers, 3);
  crow('制片', d.producers, 4);
  crow('设计', d.designers, 4);
  crow('制作', d.companies, 4);
  if (full && crew.length) blocks.push(sec('主创', `<div class="fnos-showinfo__facts">${crew.join('')}</div>`));

  // ⑦ 本季：季详情单独一次请求取回（集数/首播/评分）。本季简介不再渲染——与顶部 hero 简介重复(lc-1006)。
  const sn = d.season;
  if (full && sn && (sn.episodeCount || sn.airDate || sn.voteAverage)) {
    const bits: string[] = [];
    if (sn.episodeCount) bits.push(sn.episodeCount + ' 集');
    if (sn.airDate) bits.push('首播 ' + sn.airDate);
    if (sn.voteAverage) bits.push('评分 ' + Number(sn.voteAverage).toFixed(1));
    const t = (typeof sn.seasonNumber === 'number') ? ('第 ' + sn.seasonNumber + ' 季') : (sn.name || '本季');
    blocks.push(sec(t, `<div class="fnos-showinfo__meta-sub">${esc(bits.join(' · '))}</div>`));
  }

  // ⑧ 剧照：占位 img，src 由 _fillStills 异步填（全部失败则整节移除）。
  const stills = (Array.isArray(d.backdrops) ? d.backdrops : []).filter(Boolean).slice(0, STILL_MAX);
  if (stills.length) {
    blocks.push('<div class="fnos-showinfo__block fnos-showinfo__sec fnos-showinfo__stills-sec">'
      + '<div class="fnos-showinfo__sec-t">剧照</div><div class="fnos-showinfo__stills">'
      + stills.map(() => '<img class="fnos-showinfo__still" alt="" decoding="async">').join('')
      + '</div></div>');
  }

  // ⑨ 相似剧集：与主请求同一次 append_to_response 取回，零额外网络往返。
  const recs = (Array.isArray(d.recommendations) ? d.recommendations : []).filter((r: any) => r && r.title);
  if (recs.length) {
    const items = recs.slice(0, 8).map((r: any) => {
      const u = safeUrl(r.url);
      const label = esc(r.title + (r.year ? ' (' + r.year + ')' : ''));
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : label;
    });
    blocks.push(sec('相似剧集', `<div class="fnos-showinfo__recs">${items.join('<i>·</i>')}</div>`));
  }

  // ⑩ 更多：关键词/别名/在线观看/热度/外部编号 —— 价值低于上面各节，收在末尾一节里。
  const more: string[] = [];
  const mrow = (k: string, v: string): void => { if (v) more.push(rowHtml(k, v)); };
  mrow('别名', inline(d.aliases, 6));
  mrow('关键词', inline(d.keywords, 12));
  mrow('在线看', inline(d.providers, 6));
  if (d.popularity) mrow('热度', esc(Math.round(Number(d.popularity)).toLocaleString('zh-CN')));
  const ex0 = d.externalIds || {};
  const ids: string[] = [];
  if (d.tmdbId) ids.push('TMDB ' + d.tmdbId);
  if (ex0.tvdb) ids.push('TVDB ' + ex0.tvdb);
  if (ex0.wikidata) ids.push(String(ex0.wikidata));
  if (ids.length) mrow('编号', esc(ids.join(' · ')));
  if (more.length) blocks.push(sec('更多', `<div class="fnos-showinfo__facts">${more.join('')}</div>`));

  // ⑪ 外链
  const links: string[] = [];
  const link = (href: string, text: string): void => {
    const u = safeUrl(href);
    if (u && text) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(text)}</a>`);
  };
  if (d.url) link(d.url, 'TMDB');
  const ex = d.externalIds || {};
  const imdb = ex.imdb ? 'https://www.imdb.com/title/' + ex.imdb : (_nativeImdb ? _nativeImdb.href : '');
  if (imdb) link(imdb, 'IMDb');
  if (d.trailerKey) link('https://www.youtube.com/watch?v=' + d.trailerKey, '预告片');
  if (d.homepage) link(d.homepage, '官网');
  const ig = handle(ex.instagram); if (ig) link('https://www.instagram.com/' + ig, 'Instagram');
  const tw = handle(ex.twitter); if (tw) link('https://x.com/' + tw, 'X');
  const fb = handle(ex.facebook); if (fb) link('https://www.facebook.com/' + fb, 'Facebook');
  const wd = /^Q\d{1,12}$/.test(String(ex.wikidata || '')) ? String(ex.wikidata) : '';
  if (wd) link('https://www.wikidata.org/wiki/' + wd, 'Wikidata');
  const tvdb = /^\d{1,12}$/.test(String(ex.tvdb || '')) ? String(ex.tvdb) : '';
  if (tvdb) link('https://thetvdb.com/dereferrer/series/' + tvdb, 'TVDB');
  if (links.length) blocks.push(`<div class="fnos-showinfo__block fnos-showinfo__links">${links.join('<span>·</span>')}</div>`);

  return blocks.join('');
}

/** 剧照异步填充：走主进程 tmdb:image 代理（内存+磁盘缓存，规避渲染进程 DNS 污染）。
 *  并发取、单张失败只删自己；全部失败则把整节移除，不留一排空位。
 *  每次写回前检查节点是否还在文档里 —— teardown/换页后卡已被摘掉，不能再写。 */
async function _fillStills(card: HTMLElement, paths: string[]): Promise<void> {
  const imgs = Array.from(card.querySelectorAll<HTMLImageElement>('.fnos-showinfo__still'));
  if (!imgs.length) return;
  const ok = await Promise.all(imgs.map(async (img, i) => {
    const p = paths[i];
    if (!p) return false;
    try {
      const r: any = await ipcRenderer.invoke('tmdb:image', IMG_BASE + p);
      if (r && r.ok && r.dataUrl && document.body.contains(img)) {
        img.src = r.dataUrl;
        img.classList.add('is-ready');
        return true;
      }
    } catch (_) { /* 单张失败静默 */ }
    if (document.body.contains(img) && img.parentNode) img.parentNode.removeChild(img);
    return false;
  }));
  if (ok.some(Boolean)) return;
  const s = card.querySelector('.fnos-showinfo__stills-sec');
  if (s && s.parentNode) s.parentNode.removeChild(s);
}

// ── 卡片节点定位/渲染/调度 ──

/** 卡片宿主。
 *  · Season 二级页：内容列(hero.parentElement)的第 3 个子节点(演职人员)。
 *    [lc-993] 取不到就返回 null，**不再回落到内容列本身** —— 那个回落是错位的根源：
 *    一级详情页的内容列只有 2 个子节点(hero + 流选择/简介/演职人员)，回落后 _ensureCardEl()
 *    的 insertBefore(card, host.firstChild) 会把卡插到 hero **上方**，一张为 40fr 窄栏设计的卡
 *    铺满全宽压在封面顶上。返回 null 让卡整体不挂载，比挂错位置好。
 *    对 Season 页也是自愈的：settle 时演职人员可能还没渲染(children[2] 暂缺) → 本轮不挂；
 *    fetch resolve 后 _renderCard() 会再走一次 _ensureCardEl()，那时右栏已在 → 正常挂载。
 *    旧代码在这条竞态下会把卡永久插到 hero 上方(卡一旦挂上，后续都走 getElementById 命中、不再重定位)。
 *  · [lc-1010] Series 一级页：内容面板(SERIES_PANEL_SEL，col.children[1])本身 —— 卡由 N8b 段
 *    绝对定位到面板右列，宿主只提供挂载点。settle 那一刻面板可能未渲染 → 返回 null，
 *    由 _renderCard() 在 fetch resolve 后重试(与季页竞态同一自愈路径)。 */
function _cardHost(): HTMLElement | null {
  const hero = _activeHero();
  if (!hero || !hero.parentElement) return null;
  if (_isOneLevel()) return _pagePanel(); // [lc-1028] Series/Movie：卡挂进各自面板，O8b/N8b 绝对定位右列
  const col = hero.parentElement;
  return (col.children[2] as HTMLElement) || null;
}

function _ensureCardEl(): HTMLElement | null {
  let card = document.getElementById(CARD_ID) as HTMLElement | null;
  if (card) return card;
  const host = _cardHost();
  if (!host) return null;
  card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'fnos-beautify-card';
  if (_isOneLevel()) {
    // [lc-1037] 云母磨砂豁免：一级页卡自身无框无底（N8b/O8b background:transparent），
    // 容器就是聚簇面板。但 glassUI ② 的 [class*="card"] 磨砂底特异性(0,6,1)压过 N8b 的
    // (0,3,2)——云母一开透明就被打回磨砂白（用户报障「白点显示不稳定」）。用 glassUI
    // 自带的 :not([data-fntv-glass-exclude]) 钩子让该规则根本不匹配（lc-526~530 教训：
    // 从源头排除，不打 !important 特异性战）。季页不打：那里卡=右栏唯一大容器，磨砂保留。
    card.setAttribute('data-fntv-glass-exclude', '1');
    host.appendChild(card); // 一级页(Series/Movie)：追加到面板末尾，N8b/O8b 段 CSS 绝对定位到右列（不占左列流）
  } else {
    card.removeAttribute('data-fntv-glass-exclude'); // 元素被复用跨路由时按新落位还原
    // 季页：追加进右栏顶部(additive，不移动任何原生节点)
    host.insertBefore(card, host.firstChild || null);
  }
  return card;
}

function _renderCard(): void {
  // [lc-1010] 系列页：TMDB 失败 → 卡已被 _fetch 撤除，这里不再重建错误框
  // （面板 :has(> .fnos-beautify-card) 失配自动收窄回 600px 单列）；季页维持错误框不变。
  if (_isOneLevel() && !_tmdbInfoData && !_tmdbInfoLoading && _tmdbInfoError) return;
  const card = _ensureCardEl();
  if (!card) {
    // [lc-1020] 宿主（季页演职人员区 / 系列页面板）还没渲染 → 有界重试，不再永久放弃
    _armMountRetry();
    return;
  }
  _disarmMountRetry(); // 已挂上，重试链收队
  let body = '';
  // [lc-1022] 二级(季)页只渲染「剧照」以后的分节 —— 评分/标语/meta/事实/主创/本季与一级页右栏的
  // 同一张卡逐字重复；一级页维持全量。
  if (_tmdbInfoData) body = buildCardHtml(_tmdbInfoData, { fromStillsOnly: _isSeasonRoute() });
  else if (_tmdbInfoLoading) body = '<div class="fnos-showinfo__loading">正在从 TMDB 获取剧集信息…</div>';
  else if (_tmdbInfoError) body = `<div class="fnos-showinfo__error">${esc(_tmdbInfoError)}</div>`;
  const when = _tmdbInfoFetchedAt ? shortTime(_tmdbInfoFetchedAt) : '';
  const foot = `<div class="fnos-showinfo__foot"><span>数据来源 TMDB${when ? ' · ' + esc(when) : ''}</span>`
    + `<button type="button" class="fnos-showinfo__refresh" title="从 TMDB 重新获取本剧信息">${_tmdbInfoLoading ? '获取中…' : '⟳'}</button></div>`;
  const next = body + foot;
  if (card.innerHTML === next) return; // 内容未变 → 不触碰 DOM
  card.innerHTML = next;

  // 剧照走异步代理取图：占位 img 已在 HTML 里，这里只负责填 src（全失败则由 _fillStills 摘掉整节）。
  if (_tmdbInfoData && Array.isArray(_tmdbInfoData.backdrops) && _tmdbInfoData.backdrops.length) {
    void _fillStills(card, _tmdbInfoData.backdrops);
  }

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
        // [lc-1010/1028] 一级页：失败即撤卡（面板 :has 自动收窄，不留错误框），状态仍记录供诊断
        if (_isOneLevel()) {
          const c = document.getElementById(CARD_ID);
          if (c && c.parentNode) c.parentNode.removeChild(c);
        }
      }
    } catch (e) {
      _tmdbInfoError = String(e).substring(0, 120);
      if (_isOneLevel()) {
        const c = document.getElementById(CARD_ID);
        if (c && c.parentNode) c.parentNode.removeChild(c);
      }
    } finally {
      _tmdbInfoLoading = false;
      // 异步 resolve 时可能已离开该页 → 仅当仍在详情页才渲染
      if (getSeasonPageGuid()) _renderCard();
    }
  })();
}

/** [lc-993] 本卡只服务 Season 二级页；一级详情页(/v/tv|movie/<32hex>，路径里没有 season 段)整体跳过。
 *  三条理由，每条都有一手依据：
 *  ① 结构上没有右栏可挂 —— 一级页组件 fe 的内容列只有 2 个子节点(hero + 流选择/简介/演职人员)，
 *     而 Season 页实机有 4 个；_rightColumn() 拿不到 children[2]。
 *  ② 内容上冗余 —— fe 的 props 原生就带 overview 与 persons(JS 产物原文可查)，
 *     而这张卡的存在理由是「Season 页飞牛原生一个字段都没有」(见 beautifyStyle.ts I 段的实机取证)。
 *  ③ 版式不匹配 —— 卡的 34px 评分块 + 3.4em 窄 label 列是为 40fr 右栏设计的，铺满全宽会散架。
 *  ⚠ 必须按**路由**判定，不能按 DOM(即不能直接调 _rightColumn())：settle 那一刻 Season 页的
 *     演职人员也可能还没渲染出来，DOM 判定会把 Season 页一起误伤成永久不出卡。
 *  [lc-1010] 上述三条在当前 DOM 下已复核失效，tv 一级页(/v/tv/<id>，组件 Zse)放开出卡：
 *  ① 挂载点改为内容面板(col.children[1])本身，卡由 N8b 段绝对定位到面板右列 —— 不再依赖
 *     「现成右栏」，①的先决条件不复存在（本页实测面板内也确无演职人员区）。
 *  ② 冗余不复存在：卡自 lc-1006 起不渲染 show overview/season overview/cast，而本页原生
 *     没有评分/事实/主创/剧照/相似剧集任何一项 —— 卡全是净新增信息。
 *  ③ 版式：N8b 把卡放进 43% 右列并内部滚动，正是当年设计的 40fr 窄栏场景。
 *     电影一级页(组件 Q / Zse isVideo 分支)结构不同且未采样验证，本轮**不放开**（按路由排除）。 */
function _isSeasonRoute(): boolean {
  return /\/v\/(?:tv|movie)\/season\/[a-f0-9]{32}/.test(location.pathname);
}

/** settle 后调度：同一 href 只排一次；追加卡片占位并异步拉取。非阻塞。
 *  [lc-1010] tv 一级页额外武装聚簇面板（body class + 简介回填 + 高度测量重试链）。 */
export function scheduleTmdbCard(_view: HTMLElement): void {
  const href = location.href;
  if (_scheduledFor === href) return;
  const oneLevel = _isOneLevel();
  if (!oneLevel && !_isSeasonRoute()) return;
  _scheduledFor = href;
  if (oneLevel) _armSeriesPanel();
  _fetch(false);
}

/** 移除卡片 + 重置状态（离开详情页 / 换页 soft-reset）。 */
export function removeTmdbCard(): void {
  const card = document.getElementById(CARD_ID);
  if (card && card.parentNode) card.parentNode.removeChild(card);
  _scheduledFor = null;
  _disarmSeriesPanel();
  _resetState();
}
