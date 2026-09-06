// embyWall/carousel/itemListApi.ts — 飞牛 item/list JSON API 客户端（最底层叶子模块）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：POST /v/api/v1/item/list（Authx 签名 + cookie），tags.type 白名单 ['Movie','TV'] →
//       服务端直接排除电视直播/个人视频/未识别项，只返回「已识别作品」。
//
// 为什么单独成文件：
//   lc-1083 把这个请求写在 carousel/api.ts 里，但库索引（hotUpdates：已入库标记 / 宫灯卡片联动）
//   是同一份数据的第二个消费者，而 api.ts 已经 import hotUpdates（ensureLibraryIndex 当兜底1）——
//   hotUpdates 反向 import api.ts 就成环。抽成叶子后依赖图单向：
//     api.ts → hotUpdates → itemListApi → log/state
//
// 依赖方向：只准依赖 electron + ../log + ../state；禁止 import api.ts / hotUpdates.ts。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { CAROUSEL_SCRAPE_CAP } from '../state';
import { log } from '../log';

const ITEM_LIST_PATH = '/v/api/v1/item/list';

/** 库索引分页：单页 1000（实测 page_size 给到 2000 也一次返全量），硬上限 10 页 = 1 万部已识别作品。 */
const LIB_PAGE_SIZE = 1000;
const LIB_MAX_PAGES = 10;

/** 白名单请求体（轮播与库索引共用同一套语义：最近更新在前、排除未识别/直播/个人视频）。 */
function itemListBody(page: number, pageSize: number): Record<string, any> {
  return {
    tags: { type: ['Movie', 'TV'] },                 // 白名单: 只要已识别的电影/剧集
    sort_type: 'DESC', sort_column: 'create_time',   // 与 /v/list/all 默认「最近更新」同序(实测首项一致)
    exclude_grouped_video: 1, page,
    page_size: pageSize,
  };
}

/**
 * 发一次 item/list 请求。返回校验通过的 json（code===0 且 data.list 是数组），否则 null。
 * 网络异常/超时/中止会向上抛，由调用方决定降级策略。
 * poster 是相对路径，真图 URL = base + '/v/api/v1/sys/img' + poster（缺 sys/img 段实测返回 501）。
 */
async function postItemList(base: string, body: Record<string, any>, timeoutMs: number): Promise<any | null> {
  const authx = await ipcRenderer.invoke('fnos-gen-authx', ITEM_LIST_PATH, body).catch(() => '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authx) headers.Authx = String(authx);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + ITEM_LIST_PATH, {
      method: 'POST', credentials: 'include', signal: ctrl.signal,
      headers,
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => null);
    if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.list)) {
      log('[lc-1083] item/list 无有效响应 code=', json && json.code, (json && (json.message || json.msg)) || '');
      return null;
    }
    return json;
  } finally { clearTimeout(timer); }
}

/** 竖版海报绝对 URL（item/list 与 item/{guid} 两个接口的 poster 字段同族）。 */
function posterUrl(base: string, rawPoster: any): string {
  const p = String(rawPoster || '');
  return p ? base + '/v/api/v1/sys/img' + (p.startsWith('/') ? p : '/' + p) : '';
}

function mediaTypeOf(it: any): string {
  return String((it && it.type) || '').toLowerCase() === 'movie' ? 'movie' : 'tv';
}

/**
 * [lc-1083] 轮播主源：一次请求拿「最近更新在前」的已识别作品。
 * page_size 取 cap 的两倍留余量——无海报/海报加载失败的候选要跳过(lc-768)，需凑够 CAROUSEL_TARGET；
 * 有 poster 的稳定分区排前面（不打乱「最近更新」相对顺序），再截到 cap。
 * 取代「隐藏 iframe 滚 DOM 抓链接」：未识别视频排在列表前面时旧路径会抓空 → 骨架永久卡 99%。
 */
export async function fetchRecognizedShows(base: string, cap = CAROUSEL_SCRAPE_CAP, timeoutMs = 6000): Promise<any[]> {
  try {
    const json = await postItemList(base, itemListBody(1, cap * 2), timeoutMs);
    if (!json) { log('[lc-1083] item/list 无有效响应 → 降级 DOM 抓取'); return []; }
    const raw: any[] = json.data.list;
    const ordered = raw.filter((it) => it && it.poster).concat(raw.filter((it) => it && !it.poster));
    const shows = ordered.slice(0, cap).map((it: any) => {
      const rawRating = parseFloat(String(it.vote_average || '').trim());
      return {
        id: String(it.guid || ''),
        title: String(it.title || '').trim(),
        poster: posterUrl(base, it.poster),
        backdrop: '',                                  // 横版大图仍由 fetchItemDetail(data.backdrops) 补
        desc: String(it.overview || '').trim(),
        mediaType: mediaTypeOf(it),
        tmdbId: 0,
        totalEps: Number(it.number_of_episodes) || 0,
        localEps: Number(it.local_number_of_episodes) || 0,
        totalSeasons: Number(it.number_of_seasons) || 0,
        localSeasons: Number(it.local_number_of_seasons) || 0,
        year: Number(String(it.release_date || it.air_date || '').slice(0, 4)) || 0,
        rating: isNaN(rawRating) ? 0 : rawRating,
        statusText: '',                                // 由 fetchItemDetail 归一化(连载中/已完结)
        genres: [] as string[],
      };
    }).filter((s: any) => s.id && s.title);
    log('[lc-1083] item/list 已识别作品', shows.length, '/', raw.length, '(total=', json.data.total, ') 顺序:', shows.map((s: any) => s.title.substring(0, 8)).join(' → '));
    return shows;
  } catch (e: any) {
    log('[lc-1083] item/list 异常 → 降级 DOM 抓取:', String((e && e.message) || e).substring(0, 120));
    return [];
  }
}

/**
 * [lc-1087] 库索引主源：分页取全量已识别作品，返回 hotUpdates.LibItem 同构对象。
 * 取代 hotUpdates 的「隐藏 iframe 滚 /v/list/all 抓 a[href*=/v/tv|movie/]」——库里大量未识别视频时，
 * 前排卡片渲染成 /v/folder|/v/library|/v/live 链接不匹配选择器，旧路径的 links<5 分支前 30 轮不滚动、
 * 之后连续 6 轮无新增即收尾，恒定输出「0 项 (rounds=35)」→ 宫灯浮层「已入库」永不亮、点卡片恒跳外链、
 * 磁盘缓存永远写不进去（用户 v3.6.0 实测日志 10 次复现）。
 * 分页语义（活体实测，dev NAS 全库 170 部已识别）：白名单在服务端**分页之前**生效 ——
 * page_size=5 时第 1/2 页各返 5 项且 guid 零重叠；page_size=1000 时 list.length === data.total === 170，
 * 第 2 页返 0 项。故尾页判据用 list.length < page_size（空页也 break），不依赖 total 的具体语义。
 */
export async function fetchLibraryItems(base: string, timeoutMs = 8000): Promise<{ title: string; href: string; mediaType: string; poster: string }[]> {
  const out: { title: string; href: string; mediaType: string; poster: string }[] = [];
  const seen = new Set<string>();
  let pages = 0;
  try {
    for (let page = 1; page <= LIB_MAX_PAGES; page++) {
      const json = await postItemList(base, itemListBody(page, LIB_PAGE_SIZE), timeoutMs);
      if (!json) break;
      pages = page;
      const list: any[] = json.data.list;
      if (!list.length) break;
      for (const it of list) {
        const guid = String((it && it.guid) || '');
        const title = String((it && it.title) || '').trim();
        if (!guid || !title || seen.has(guid)) continue;
        seen.add(guid);
        const mediaType = mediaTypeOf(it);
        out.push({ title, href: base + '/v/' + mediaType + '/' + guid, mediaType, poster: posterUrl(base, it.poster) });
      }
      if (list.length < LIB_PAGE_SIZE) break;   // 末页
    }
    log('[lc-1087] item/list 库索引', out.length, '项 (pages=' + pages + ')');
    return out;
  } catch (e: any) {
    log('[lc-1087] item/list 库索引异常(已收 ' + out.length + ' 项):', String((e && e.message) || e).substring(0, 120));
    return out;
  }
}
