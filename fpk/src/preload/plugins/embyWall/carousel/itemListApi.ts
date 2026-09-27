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
import { clog } from '../log';

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
      clog('[lc-1083] item/list 无有效响应 code=', json && json.code, (json && (json.message || json.msg)) || '');
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
 * [网关路径兼容] 读取注入 shim 捕获的「页面自身 item/list 成功响应」。
 * 背景：网页端没有 Authx 签名材料，回放捕获的签名因 body 哈希不一致必然 invalid sign；
 * 而注入 shim 位于 <head> 最前，能在 SPA 启动期捕获到页面自己发出的 item/list 请求
 * （带合法签名、code===0 的成功响应）。
 *
 * ⚠ 语义校验：SPA 启动期会发多条 item/list，多数是「某个媒体库内部」的行数据
 * （body 带 ancestor_guid / 类型混入 Directory/Video），直接当轮播源会整墙错片
 * （v231 实测翻车）。只有 body 满足「全库范围 + Movie/TV + create_time 倒序」
 * （即「最近添加」语义，与轮播 lc-1083 查询同构）才采纳；取不到就返回 null，
 * 走老包验证过的 iframe 抓取链路。
 */
export function capturedItemListJson(): any | null {
  try {
    const cap = (window as any).__fntvApiCap;
    const arr: any[] = (cap && cap.itemLists) || [];
    for (const e of arr) {
      if (!e || !e.resp || !e.body) continue;
      let body: any = null;
      try { body = JSON.parse(e.body); } catch (err) { continue; }
      if (!body || typeof body !== 'object') continue;
      if (body.ancestor_guid || body.parent_guid || body.library_guid) continue; // 库内行数据, 非全库
      const types: string[] = (body.tags && body.tags.type) || [];
      if (!(types.includes('Movie') && types.includes('TV'))) continue;          // 类型白名单不同构
      if (String(body.sort_column || '') !== 'create_time') continue;            // 不是「最近更新」序
      if (body.exclude_grouped_video !== 1) continue;
      const j = JSON.parse(e.resp);
      if (j && j.code === 0 && j.data && Array.isArray(j.data.list)) return j;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** item/list JSON → 轮播候选列表（poster 优先排序 + 截断到 cap）。 */
function showsFromItemListJson(json: any, cap: number): any[] {
  const raw: any[] = json.data.list;
  const ordered = raw.filter((it) => it && it.poster).concat(raw.filter((it) => it && !it.poster));
  const shows = ordered.slice(0, cap).map((it: any) => {
    const rawRating = parseFloat(String(it.vote_average || '').trim());
    return {
      id: String(it.guid || ''),
      title: String(it.title || '').trim(),
      poster: posterUrl('', it.poster),
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
  clog('[lc-1083] item/list 已识别作品', shows.length, '/', raw.length, '(total=', json.data.total, ') 顺序:', shows.map((s: any) => s.title.substring(0, 8)).join(' → '));
  return shows;
}

/**
 * [lc-1083] 轮播主源：一次请求拿「最近更新在前」的已识别作品。
 * page_size 取 cap 的两倍留余量——无海报/海报加载失败的候选要跳过(lc-768)，需凑够 CAROUSEL_TARGET；
 * 有 poster 的稳定分区排前面（不打乱「最近更新」相对顺序），再截到 cap。
 * 取代「隐藏 iframe 滚 DOM 抓链接」：未识别视频排在列表前面时旧路径会抓空 → 骨架永久卡 99%。
 */
export async function fetchRecognizedShows(base: string, cap = CAROUSEL_SCRAPE_CAP, timeoutMs = 6000): Promise<any[]> {
  try {
    // [网关路径兼容] 优先用注入 shim 捕获的页面自身 item/list 响应（零签名依赖，启动期即就绪）
    const captured = capturedItemListJson();
    if (captured) {
      clog('[lc-1083] 使用页面捕获的 item/list 响应（网页端无签名材料，绕开 invalid sign）');
      return showsFromItemListJson(captured, cap);
    }
    const json = await postItemList(base, itemListBody(1, cap * 2), timeoutMs);
    if (!json) { clog('[lc-1083] item/list 无有效响应 → 降级 DOM 抓取'); return []; }
    return showsFromItemListJson(json, cap);
  } catch (e: any) {
    clog('[lc-1083] item/list 异常 → 降级 DOM 抓取:', String((e && e.message) || e).substring(0, 120));
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
    // [网关路径兼容] 捕获响应优先（网页端 item/list 签名不可用）；只覆盖到 SPA 首页那次请求的量,
    // 后续页仍尝试 postItemList(失败即止)——比直接 0 项强, 已入库标记/宫灯联动有数据可用。
    const captured = capturedItemListJson();
    if (captured) {
      pages = 1;
      for (const it of captured.data.list) {
        const guid = String((it && it.guid) || '');
        const title = String((it && it.title) || '').trim();
        if (!guid || !title || seen.has(guid)) continue;
        seen.add(guid);
        const mediaType = mediaTypeOf(it);
        out.push({ title, href: base + '/v/' + mediaType + '/' + guid, mediaType, poster: posterUrl(base, it.poster) });
      }
      clog('[lc-1087] 使用页面捕获的 item/list 响应: 库索引', out.length, '项');
      return out;
    }
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
    clog('[lc-1087] item/list 库索引', out.length, '项 (pages=' + pages + ')');
    return out;
  } catch (e: any) {
    clog('[lc-1087] item/list 库索引异常(已收 ' + out.length + ' 项):', String((e && e.message) || e).substring(0, 120));
    return out;
  }
}
