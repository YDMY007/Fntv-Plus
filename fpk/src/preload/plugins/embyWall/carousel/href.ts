// embyWall/carousel/href.ts — 季详情页路由解析（三级 TV→Season→Episode），带 guid 缓存
// 由 scripts/embywall-split.js 从 embyWall/carousel/render.ts 抽出，用于打断循环依赖。

import { log } from '../log';

/** [lc-772] 剧集/电影的「季」详情页路由（三级）：/v/(tv|movie)/season/<季guid>
 *
 *  fnOS 层级实测为三级：TV → Season → Episode，【季有独立 guid】，与剧集 guid 不同，
 *  故不能拿 show.id 直接拼 season 路由（那样会跳到不存在的资源）。
 *  取法：item/list(parent_guid=本剧) 拿子级，其中 type 不是 episode/movie 的子级即「季」，
 *  取其 c.guid 拼出三级路由；取不到（电影无季 / 接口异常）则回退二级详情页。
 *
 *  结果按 show.id 缓存，避免每次点击都发请求。
 */
const _seasonHrefCache = new Map<string, string>();
export async function resolveSeasonHref(show: any): Promise<string> {
  const kind = show && show.mediaType === 'movie' ? 'movie' : 'tv';
  const fallback = '/v/' + kind + '/' + show.id;
  const id = String(show.id || '');
  if (!id) return fallback;
  const cached = _seasonHrefCache.get(id);
  if (cached) return cached;
  try {
    const { ipcRenderer } = require('electron');
    // 走主进程 fnapi（带 token，与豆瓣同步同一调用方式，已在真实 fnOS API 验证）；
    // 不用渲染进程 Authx fetch——POST body 参与签名，未经实测，风险高。
    const r: any = await ipcRenderer.invoke('media:season-guid', id);
    if (r && r.ok && r.guid) {
      const href = '/v/' + kind + '/season/' + r.guid;
      log('[lc-772] More -> 三级季页', href);
      _seasonHrefCache.set(id, href);
      return href;
    }
    log('[lc-772] More -> 无季子级, 回退二级', fallback, r && r.error ? r.error : '');
  } catch (e) {
    log('[lc-772] More -> 取季失败, 回退二级', String(e).substring(0, 90));
  }
  _seasonHrefCache.set(id, fallback);
  return fallback;
}