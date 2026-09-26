// embyWall/carousel/api.ts — 轮播数据源（片库抓取 / IPC 拉取 / 首页到达监听）
// 由 scripts/embywall-split.js + 手动重建 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。
//
// ★ 解耦要点：数据就绪后需要触发渲染，但本模块**不 import 渲染模块**（render.ts），
//   而是通过 onShowsReady 钩子回调（依赖倒置）。否则 api.ts ↔ render.ts 会成环。
//   接线由入口（组合根）完成：setOnShowsReady(injectCarousel)。

import { S, CAROUSEL_SCRAPE_CAP, CAROUSEL_TARGET } from '../state';
import { log, clog } from '../log';
import { ensureLibraryIndex } from '../../hotUpdates';
import { updateCarouselProgress, completeCarouselProgress } from './progress';
import { scrapeLandscapeBackdrops, fetchItemDetail, resolveShowBackdrop } from './images';
// [lc-1087] item/list 客户端已抽成叶子模块: 库索引(hotUpdates)也要用同一份数据, 而本文件 import hotUpdates,
//   反向 import 会成环 → 依赖图保持单向: api.ts → hotUpdates → itemListApi → log/state。
import { fetchRecognizedShows } from './itemListApi';

// ── 数据就绪 → 渲染 钩子（依赖倒置，避免 api ↔ render 循环依赖）──────────────
let onShowsReady: (() => void) | null = null;
/** 由入口注册：fetchShowsViaIPC 内部详情补完、需要揭示轮播时回调（= injectCarousel）。 */
export function setOnShowsReady(fn: () => void): void { onShowsReady = fn; }

// [lc-950] 轮播数据缓存: 把 S.apiShows(含 base64 data URL 横版海报 + 简介等)序列化到 sessionStorage,
//   跨整页重载/模块重启持久化。返回首页重建时若 S.apiShows 已空(整页刷新), 可零网络即时恢复海报/简介,
//   根治「返回首页重载 + 海报图/剧集简介丢失」。仅在数据完整(已带 _backdropBlob)时落盘。
const SHOWS_CACHE_KEY = 'fntv-carousel-shows-v1';
const persistShows = (): void => {
  try {
    if (!S.apiShows.length) return;
    const snap = S.apiShows.map((s: any) => ({
      id: s.id, title: s.title, desc: s.desc, backdrop: s.backdrop,
      _backdropBlob: s._backdropBlob, poster: s.poster, logo: s.logo,
      genres: s.genres, rating: s.rating, year: s.year,
      totalEps: s.totalEps, localEps: s.localEps, totalSeasons: s.totalSeasons,
      localSeasons: s.localSeasons, statusText: s.statusText, mediaType: s.mediaType,
      strmTag: s.strmTag, _backdropIsPortrait: s._backdropIsPortrait,
    }));
    sessionStorage.setItem(SHOWS_CACHE_KEY, JSON.stringify(snap));
  } catch (_) { /* 配额/序列化异常: 忽略, 不影响主流程 */ }
};
const restoreShows = (): void => {
  if (S.apiShows.length > 0) return; // 已有数据不覆盖
  try {
    const raw = sessionStorage.getItem(SHOWS_CACHE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      S.apiShows.length = 0;
      Array.prototype.push.apply(S.apiShows, arr);
      S.carouselLoadedButNone = arr.length === 0;
      log('[lc-950] 从 sessionStorage 恢复轮播缓存', arr.length, '项(含横版海报 data URL + 简介)');
    }
  } catch (_) { /* 解析异常: 忽略 */ }
};
// 模块加载即恢复(整页重载场景下 S.apiShows 为空, 先于任何 injectCarousel 兜底数据)
restoreShows();

// ⚠️ 以下状态已下沉到 S：apiShows/apiLoaded/apiLoading/diagLastShows（数据层），
//   carouselInited/carouselRevealed/carouselLoadedButNone/carouselContainer（渲染层）。
//   _carouselWatchArmed 仅本模块 watchHomeThenFetch 使用，保留为模块私有。
/**
 * [lc-408] 从 fnOS item 数据中多字段兜底提取 TMDB id（用于拉取 TMDB 透明 logo）。
 * 优先级：显式 tmdb 字段 → trimId 剥前缀（tm/tt + 数字）。
 * 注意：trimId 形如 tt325158 / tm63578，fnOS 不透明令牌；剥前缀取数字作 tmdb id 候选。
 */
export function extractTmdbId(data: any): string | undefined {
  if (!data) return undefined;
  const direct = [
    data.tmdbId, data.tmdb_id,
    data.ProviderIds && (data.ProviderIds.Tmdb || data.ProviderIds.tmdb),
    data.externalIds && (data.externalIds.tmdb_id || data.externalIds.tmdb),
  ];
  for (const c of direct) {
    if (c != null && /^\d+$/.test(String(c).trim())) return String(c).trim();
  }
  const trimId = data.trimId || data.trim_id;
  if (typeof trimId === 'string') {
    const m = trimId.match(/^(?:tt|tm)(\d+)$/i);
    if (m) return m[1];
  }
  return undefined;
}

/** [lc-554] 直接读当前页面可见的媒体库卡片（同步、零网络、零 iframe，绝不卡白屏）。
    飞牛首页"最近更新"等板块的卡片自带真实封面与 /v/tv|movie/{guid} 链接，直接抓即可。
    这是彻底绕开会卡死的 ensureLibraryIndex 后台 iframe+滚动轮询机制的最终方案。 */
export function scrapeVisibleCards(root?: Document | Element): any[] {
  const cleanTitleOf = (raw: string): string =>
    raw.replace(/^[0-9.]+\s*/, '').replace(/共\s*\d+\s*季[^\n]*/g, '').replace(/\s*[·—]\s*\d{4}[-–]\d{4}\s*$/, '').trim();
  const map = new Map<string, any>();
  const scope: any = root || document;
  const links = scope.querySelectorAll('a[href*="/v/tv/"], a[href*="/v/movie/"]');
  for (let i = 0; i < links.length && map.size < 10; i++) {
    const a = links[i] as any;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
    if (!m || map.has(m[2])) continue;
    // 封面（卡片内 img 的 sys/img 绝对路径）
    let poster = '';
    const img = a.querySelector('img');
    if (img) {
      const s = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (s && (s.includes('/v/api/v1/sys/img/') || /^https?:/i.test(s))) poster = s.startsWith('/') ? location.origin + s : s;
    }
    if (!poster) continue;
    // 标题：向上遍历几层取文本
    let title = '';
    let el: any = a;
    for (let d = 0; d < 6 && !title; d++) {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t.length > 4) title = t;
      el = el.parentElement;
    }
    if (!title) title = (a.getAttribute('title') || '').trim();
    if (!title) continue;
    map.set(m[2], {
      id: m[2], title: cleanTitleOf(title), poster, backdrop: poster,
      desc: '', mediaType: m[1],
      tmdbId: 0, totalEps: 0, localEps: 0, totalSeasons: 0, localSeasons: 0,
      year: 0, rating: 0, statusText: '', genres: [] as string[],
    });
  }
  return Array.from(map.values());
}

/** [lc-564] 等待库索引就绪(带重试): ensureLibraryIndex 内部若正在构建会走"轮询 _libIndex"分支,
 *  但该分支超时仅 4 秒, 而 hotUpdates 完整构建需 ~4.5-5s(8轮×500ms) → embyWall 总是 4s 超时拿到空数组 → 兜底也 0 → "加载失败"。
 *  这里循环重试: 构建完成后 hotUpdates 会缓存 _libIndex, 下一次 ensureLibraryIndex() 调用即同步返回真实数据。
 *  @param maxWaitMs 最长等待(默认 20s, 超过则返回当前状态, 由上层兜底) */
export async function waitLibIndex(maxWaitMs = 20000): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // ensureLibraryIndex: 已构建→同步缓存返回; 构建中→内部轮询(4s超时可能空); 未开始→触发构建并等待完成
    const idx = await ensureLibraryIndex();
    if (idx && idx.length > 0) return idx; // 拿到真实数据 → 立即返回
    // 空数组: 可能是"构建中 4s 超时"或"构建失败" → 等 1s 后重试(构建完成后 _libIndex 已缓存, 下次调用立即返回)
    await new Promise((r) => setTimeout(r, 1000));
  }
  return ensureLibraryIndex(); // 超时兜底: 返回当前状态(可能仍为空, 由上层 scrapeVisibleCards 兜底)
}

/** [lc-563] 复用 hotUpdates.ts 已验证可行的 ensureLibraryIndex 拿「全部剧集列表」(/v/list/all) 首屏数据。
 *  关键事实（用户确认 + fnOS 默认排序）：/v/list/all 默认「最近更新在上」，首屏 DOM 文档顺序 = 视觉顺序 = 正确顺序。
 *  ensureLibraryIndex 已证明稳定构建（截图日志「97 项」），其内部全屏 iframe + scrollAll 滚动到底收集全量，
 *  但 **Map 前 10 项 = 首屏 DOM 顺序插入 = 最近更新在前**（后续滚动加载的追加项插入到 Map 后面）。
 *  关键修复（vs lc-561/562 失败版）：不强制要求 poster —— 隐藏 iframe 内 fnOS 懒加载图永远没真实 URL，
 *  若 `if(!poster)continue` 会全部跳过（这就是之前 0 个的根因）。ensureLibraryIndex 也允许 poster 为空。
 *  标题重新清洗（ensureLibraryIndex 提取的 title 含评分/年份，需 cleanTitleOf 清理）。
 *  绝对不使用硬编码数据。 */
export async function scrapeAllPageFirstScreen(timeoutMs = 18000, onProgress?: (count: number) => void): Promise<any[]> {
  const cleanTitleOf = (raw: string): string => {
    let t = (raw || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/共\s*\d+\s*季[^\n,]*/g, '');
    t = t.replace(/第?\s*\d+\s*季/g, '');
    t = t.replace(/[·—\-~]\s*\d{4}[-–]\d{4}/g, '');
    t = t.replace(/\b(19|20)\d{2}\b/g, '');
    t = t.replace(/\b\d+(\.\d+)?\s*分?\b/g, '');
    t = t.replace(/^\d+(\.\d+)?\s*/, '');
    return t.replace(/\s+/g, ' ').trim();
  };
  try {
    log('[lc-564] waiting for library index (retry loop, max', timeoutMs, 'ms)...');
    // [lc-564] 用带重试的 waitLibIndex 替代直接 await: 解决 ensureLibraryIndex 内部 4s 轮询超时竞态
    const libIndex = await waitLibIndex(timeoutMs);
    log('[lc-564] library index ready:', libIndex.length, 'items');

    // [lc-565] 混合抓图: ensureLibraryIndex 提供 id+title 顺序(最近更新在前), 但隐藏 iframe 内 fnOS 懒加载图永远加载不出,
    // 它的 poster 字段几乎全空; scrapeVisibleCards 抓当前页已渲染 DOM, 那些卡片是用户可见的, img 已真实加载,
    // 因此按 id 取其 poster 补图(同时保留 libIndex 自带 poster 作为兜底)。
    const liveCards = scrapeVisibleCards();
    const posterById = new Map<string, string>();
    for (const c of liveCards) { if (c && c.id && c.poster) posterById.set(c.id, c.poster); }
    log('[lc-565] live-page posters by id:', posterById.size, 'available (for poster merge)');

    const cards: any[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < libIndex.length && cards.length < CAROUSEL_SCRAPE_CAP; i++) {
      const item = libIndex[i];
      const idMatch = (item.href || '').match(/([a-f0-9]{32})/);
      const id = idMatch ? idMatch[1] : '';
      if (!id || seen.has(id)) continue;
      const title = cleanTitleOf(item.title || '');
      if (!title) continue;
      // [lc-565] 优先用当前页真实已加载的封面, 没有则用 libIndex 自带(可能空), 都没有留空字符串由 UI 兜底
      const poster = posterById.get(id) || item.poster || '';
      seen.add(id);
      cards.push({
        id, title, poster, backdrop: poster,
        desc: '', mediaType: item.mediaType || 'tv',
        tmdbId: 0, totalEps: 0, localEps: 0, totalSeasons: 0, localSeasons: 0,
        year: 0, rating: 0, statusText: '', genres: [] as string[],
      });
      // [lc-582] 逐项异步渲染进度: 每收集一张让浏览器渲染一帧(80ms),
      // 骨架"已加载 N 个"数字 0→10 逐帧可见, 而不是同步瞬间跳变(之前 UI 只看到最终帧)
      await new Promise((r) => setTimeout(r, 80));
      try { if (onProgress) onProgress(cards.length); } catch (e: any) { /* ignore */ }
    }
    log('[lc-565] all-page first-screen scrape done:', cards.length, 'cards; order:', cards.map((c) => c.title.substring(0, 8)).join(' → '));
    return cards;
  } catch (e: any) {
    log('[lc-564] ensureLibraryIndex error:', e);
    return [];
  }
}

export async function fetchShowsViaIPC(base: string): Promise<any[]> {
  // [lc-211] 本地登录页(file://)不需要也不应跑轮播取海报
  if (location.protocol === 'file:') return S.apiShows;
  if (S.apiLoaded) return S.apiShows;
  if (S.apiLoading) return S.apiShows;
  // [lc-558] 不在首页(如 /v/login)时不预热: 未登录时 /v/list/all 抓空且会被 ensureLibraryIndex 缓存,
  // 导致后续永不重拉(白屏死锁)。改为注册 watcher, 等路由到达首页(/v)再真正拉取。
  const p = location.pathname;
  if (p !== '/v' && p !== '/v/' && p !== '/') {
    watchHomeThenFetch(base);
    return S.apiShows;
  }
  S.apiLoading = true;

  // [lc-1083] 空结果收尾: 假进度封顶 99%, 只有 completeCarouselProgress 能推到 100% → 任何"拿不到片源"的
  //   路径都必须调用它, 否则骨架永久停在 99%(旧实现的 else/catch 分支就漏了这一步)。
  const finishEmpty = (msg: string, reason: string): void => {
    const setText = (): void => {
      const txt = S.carouselContainer ? S.carouselContainer.querySelector('.fnos-ph-text') as HTMLElement | null : null;
      if (txt) txt.textContent = msg;
    };
    setText();
    completeCarouselProgress(() => {
      // 样式3 骨架里 statusEl 与 .fnos-ph-text 是同一元素 → 先改状态再写原因, 让原因文案胜出
      if (S.carouselStatusEl) S.carouselStatusEl.textContent = '未加载到内容';
      setText();
    }, reason);
  };

  try {
    // [lc-1083] 主源 = item/list API(tags.type 白名单 Movie/TV): 服务端已排除电视直播/个人视频/未识别视频,
    //   且排序就是「最近更新在前」, 一次请求到手 → 不再依赖隐藏 iframe 滚 DOM(未识别项占前排时旧路径必抓空)。
    // 兜底1 = 旧的 /v/list/all 首屏 DOM 抓取(老版 fnOS 无此接口/签名失败时)。
    // 兜底2 = 当前首页已渲染 DOM 真实卡片（非硬编码）。绝对不用硬编码数据。
    clog('[lc-1083] fetching recognized shows via item/list API (primary source)...');
    let newShows: any[] = await fetchRecognizedShows(base, CAROUSEL_SCRAPE_CAP);
    S.diagLastShows = newShows; // [DIAG] 供看门狗/异常日志定位
    if (newShows.length > 0) updateCarouselProgress(newShows.length);

    if (newShows.length === 0) {
      clog('[lc-1083] item/list 返回 0, 兜底1: scraping /v/list/all first screen...');
      newShows = await scrapeAllPageFirstScreen(18000, (n) => updateCarouselProgress(n));
      S.diagLastShows = newShows;
      log('[lc-561] all-page scrape returned', newShows.length, 'cards');
    }

    // 兜底2: 仍为 0 时, 从当前首页已渲染的 DOM 直接抓真实卡片(非硬编码; 顺序=首页 DOM 顺序, 比空白强)
    if (newShows.length === 0) {
      log('[lc-561] all-page scrape 0 cards, fallback: scrape current page live DOM');
      newShows = scrapeVisibleCards().slice(0, 10);
      log('[lc-561] live-DOM fallback got', newShows.length, 'cards');
      if (newShows.length > 0) updateCarouselProgress(newShows.length);
    }

    clog('[lc-561] selected', newShows.length, 'carousel items, order:', newShows.map((s: any) => s.title?.substring(0, 8)).join(' → '));

    if (newShows.length > 0) {
      S.apiShows.length = 0;
      Array.prototype.push.apply(S.apiShows, newShows);
      S.apiLoaded = true;
      S.carouselInited = false;
      S.carouselLoadedButNone = false; // [lc-768] 新一轮拉取，重置「全 STR 失败」标记
      // [lc-620] 不再先渲染再补详情(会闪两次): 先并行补 item API 详情, 全部就绪后
      // 一次性 completeCarouselProgress → injectCarousel(只渲染一次, 不闪)。
      // 详情补完总超时 2.2s(单条 4s AbortController 太慢, 会拖长骨架), 到时无论
      // 详情是否补完都渲染——骨架停留时间足够横条动画完整展示。

      // [lc-569] 并行补 item API 详情(横版大海报 backdrop + 集数/季数/年份/评分/状态/类型/简介):
      // 优先级: 横版图 ①当前页已加载横版图(scrapeLandscapeBackdrops) ②item API(fetchItemDetail)
      // 其余字段(local/total 集数季数等)全部从 item API 拿 → 渲染后胶囊能显示真实数据。
      // 并行 10 条 + 单条 4s 超时(AbortController), 不阻塞首屏; 补成功后重建轮播。
      log('[lc-569] fetching item details for', newShows.length, 'items (live-DOM landscape + API)...');
      const domLand = scrapeLandscapeBackdrops(); // 当前页已加载横版图(如"继续观看"横版卡片)
      log('[lc-569] live landscape backdrops by id:', domLand.size, 'available');
      const detailsPromise = Promise.all(newShows.map(async (s: any) => {
        const fromDom = domLand.get(s.id);
        if (fromDom) s.backdrop = fromDom; // ① DOM 横版图(最快最稳)
        const detail = await fetchItemDetail(base, s.id); // ② item API 全字段
        if (!detail) return !!(fromDom);
        // 仅填充 API 有值的字段(0/空保留 DOM 兜底值)
        if (detail.backdrop && !fromDom) s.backdrop = detail.backdrop;
        // [lc-606] 竖版海报补全: DOM 抓图(scrapeAllPageFirstScreen)可能为空(磁盘缓存化后
        //   item.poster 常空), item API 的 data.posters 是权威竖版源 → 右侧海报条稳定显示
        if (detail.poster && !s.poster) s.poster = detail.poster;
        if (detail.logo) s.logo = detail.logo; // [lc-570] 飞牛自带 logo(与详情页一致)
        if (detail.strmTag) s.strmTag = detail.strmTag; // [DIAG] 携带来源标签
        if (detail.totalEps) s.totalEps = detail.totalEps;
        if (detail.localEps) s.localEps = detail.localEps;
        if (detail.totalSeasons) s.totalSeasons = detail.totalSeasons;
        if (detail.localSeasons) s.localSeasons = detail.localSeasons;
        if (detail.year) s.year = detail.year;
        if (detail.rating) s.rating = detail.rating;
        if (detail.statusText) s.statusText = detail.statusText;
        if (detail.genres && detail.genres.length) s.genres = detail.genres;
        if (detail.desc) s.desc = detail.desc;
        if (detail.title) s.title = detail.title;
        return true;
      }));
      // [lc-624] 渲染时机: 只有横版 backdrop 就绪才 reveal——用户明确不要"竖屏先渲染"
      // 再变横屏。revealOnce 前检查: 若 backdrop 仍是竖版(poster)或空, 说明详情未补全,
      // 继续保留骨架(进度条), 等详情补完(或总超时 8s 兜底)再 reveal。
      // 注: 无法预知图片宽高比(URL 无信息), 用"是否有 poster 前缀之外的 backdrop"粗判:
      //   竖版 poster URL 形如 poster-{32hex}.webp; 横版 backdrop URL 通常无 poster- 前缀。
      const isLandscapeBackdrop = (s: any): boolean => {
        const b = (s && s.backdrop) || '';
        return !!b && !/poster-|poster\/|\/poster/i.test(b);
      };
      let revealAttempts = 0;
      const revealOnce = (): void => {
        if (S.carouselRevealed) { log('[lc-622] carousel already revealed, skip re-render'); return; }
        // [lc-624] 横版就绪检查: 竖版兜底不再渲染(用户要求); 未就绪则延迟重试(最多 ~8s)
        const landscapeCount = newShows.filter(isLandscapeBackdrop).length;
        if (landscapeCount === 0 && revealAttempts < 3) {
          revealAttempts++;
          clog('[lc-624] 无横版 backdrop 就绪(', landscapeCount, '/', newShows.length, '), 延迟 reveal (attempt', revealAttempts, ')');
          window.setTimeout(revealOnce, 1500);
          return;
        }
        if (landscapeCount === 0) {
          clog('[lc-624] 始终无横版 backdrop, 强制 reveal(将显示占位背景而非竖版海报)');
          // [DIAG] 列出缺横版 backdrop 的项（重点看是否都是 STRM/网盘导致海报出不来）
          const miss = newShows.filter((s: any) => !isLandscapeBackdrop(s)).map((s: any) => `${(s.title || '').substring(0, 12)}${s.strmTag ? '(STRM:' + s.strmTag + ')' : ''}`);
          clog('[DIAG] 无横版backdrop的项:', miss.length ? miss.join(', ') : '(无)');
        }
        S.carouselRevealed = true;
        S.carouselInited = false;
        if (onShowsReady) onShowsReady();
      };
      const revealTimer = setTimeout(() => {
        clog('[lc-624] detail fetch timeout(8s), revealing carousel with fallback');
        completeCarouselProgress(revealOnce, 'revealTimer-8s-timeout');
      }, 8000);
      detailsPromise.then(async () => {
        clearTimeout(revealTimer);
        const withData = newShows.filter((s: any) => s.totalEps || s.localEps || s.backdrop || s.poster || s.logo).length;
        clog('[lc-569] item details enriched:', withData, '/', newShows.length);
        // [lc-768] 兜底：STR/网盘海报加载不到 → 跳过并尝试后续候选，凑齐 CAROUSEL_TARGET 个横版；全失败则主页提示
        const pool = newShows.slice();
        const settled = await Promise.all(pool.map(async (s: any) => ({ s, blob: await resolveShowBackdrop(s, base) })));
        const picked: any[] = [];
        for (const x of settled) {
          if (picked.length >= CAROUSEL_TARGET) break;
          if (x.blob) { x.s._backdropBlob = x.blob; picked.push(x.s); }
          else log('[lc-768] 跳过无法加载海报的项(疑似 STR/网盘):', (x.s.title || '').substring(0, 16), x.s.strmTag || '');
        }
        if (picked.length === 0) {
          clog('[lc-768] 全部候选项海报均无法加载(疑似均为 STR/网盘)，主页显示「暂未支持STRM海报」');
        } else {
          clog('[lc-768] 轮播候选取齐', picked.length, '/', CAROUSEL_TARGET, '个可加载海报');
        }
        S.carouselLoadedButNone = picked.length === 0;
        // [lc-768] 用.splice 原地替换(不重新赋值 const 数组)：清除旧候选，写入「可加载海报」的子集
        S.apiShows.length = 0;
        Array.prototype.push.apply(S.apiShows, picked);
        persistShows(); // [lc-950] 落盘完整快照(含 _backdropBlob + desc), 供整页重载后零网络恢复
        // [lc-620] 详情补完后只渲染一次(不闪): 首次渲染已含全部详情, 不再二次重建
        completeCarouselProgress(revealOnce, 'details-ready');
      }).catch((e: any) => {
        clearTimeout(revealTimer);
        log('[lc-569] item detail fetch error:', e);
        completeCarouselProgress(revealOnce, 'details-error');
      });
    } else {
      // [lc-1083] 三源皆空: 必须收尾进度条(假进度封顶 99%, 不调用 complete 就永久卡 99%), 并写明原因
      clog('[lc-561] all sources returned 0 — leaving native media library visible');
      finishEmpty('媒体库暂无已识别的影视，或加载失败，请刷新重试', 'no-shows');
    }
  } catch (e: any) { clog('[lc-561] fetch error:', e); finishEmpty('加载失败，请刷新重试', 'fetch-error'); }
  S.apiLoading = false;
  return S.apiShows;
}

/** [lc-558] 登录页/非首页时 fetchShowsViaIPC 提前返回, 此处注册一次性的"到达首页再拉"监听, 打破 pathname 死锁。 */
let _carouselWatchArmed = false;
function watchHomeThenFetch(base: string): void {
  if (_carouselWatchArmed) return;
  _carouselWatchArmed = true;
  const trigger = (): void => {
    const hp = location.pathname;
    if ((hp === '/v' || hp === '/v/' || hp === '/') && !S.apiLoaded && !S.apiLoading) {
      fetchShowsViaIPC(base);
    }
  };
  window.addEventListener('popstate', trigger);
  // 轮询兜底: 飞牛登录跳转常不触发 history hook, 用轻量轮询探测到达首页
  const iv = setInterval(() => {
    const hp = location.pathname;
    if (hp === '/v' || hp === '/v/' || hp === '/') { clearInterval(iv); trigger(); }
  }, 1500);
}

