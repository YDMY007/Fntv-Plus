import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';
import * as fnConfig from '../../../modules/fn_config/config';
import * as fn from '../../../modules/fn_api/api';

const log = logger.component('libindex');

/** [lc-586] 飞牛影视库索引持久化(userData/cache/library-index.json):
 *  渲染进程每次打开浮层不再重新滚动抓全量——页面加载先读盘(「已入库」立即可标),
 *  后台重建保证最新后写回, 跨软件重启复用, 避免每次启动都等 iframe 滚动抓取 */

function indexFile(): string {
    const dir = path.join(app.getPath('userData'), 'cache');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return path.join(dir, 'library-index.json');
}

function init(): void {
    // 读磁盘索引缓存(可能为 null: 首次/文件缺失/损坏)
    registerHandler('library-index:read', async () => {
        try {
            const f = indexFile();
            if (!fs.existsSync(f)) return { ok: true, items: null };
            const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
            if (!raw || !Array.isArray(raw.items) || !raw.items.length) return { ok: true, items: null };
            return { ok: true, items: raw.items, fetchedAt: raw.fetchedAt || 0 };
        } catch (e: any) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }, { useHandle: true });

    // 写索引到磁盘(重建完成后调用)
    registerHandler('library-index:write', async (_e: any, items: any[]) => {
        try {
            if (!Array.isArray(items) || !items.length) return { ok: false, error: 'empty items' };
            fs.writeFileSync(indexFile(), JSON.stringify({ fetchedAt: Date.now(), items }), 'utf-8');
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }, { useHandle: true });

    /** [lc-772] 取某作品第一个「季(Season)」的 guid，供首页轮播 More 按钮跳三级季页
     *  (/v/(tv|movie)/season/<季guid>)。
     *
     *  ⚠️ fnOS 层级实测为三级：TV → Season → Episode，【季有独立 guid】，与剧集 guid 不同，
     *  所以不能拿剧集 guid 直接拼 season 路由（会跳到不存在的资源）。
     *  取法：item/list(parent_guid=本剧) 取子级，其中 type 非 episode/movie 的子级即「季」。
     *
     *  走主进程 fnapi（带 token + 600s 缓存），与豆瓣同步同一调用方式（已在真实 fnOS API 验证）。 */
    registerHandler('media:season-guid', async (_e: any, parentGuid: string) => {
        try {
            if (!parentGuid) return { ok: false, error: 'empty parentGuid' };
            const cfg = fnConfig.readConfig();
            if (!cfg || !cfg.domain || !cfg.token) return { ok: false, error: 'missing fnOS config(domain/token)' };
            const fnapi = new fn.ApiService(cfg.domain, cfg.token);
            const resp: any = await fnapi.getItemListCached({
                parent_guid: parentGuid,
                exclude_folder: 1,
                sort_column: 'sort_title',
                sort_type: 'ASC',
            });
            const list: any[] = (resp && resp.data && Array.isArray(resp.data.list)) ? resp.data.list : [];
            // 优先显式 type==='season'；否则取「非 episode/movie」的带 guid 子级（兼容 type 缺失/命名差异）
            const season = list.find((c: any) => String((c && c.type) || '').toLowerCase() === 'season' && !!c.guid)
                || list.find((c: any) => {
                    const t = String((c && c.type) || '').toLowerCase();
                    return !!t && t !== 'episode' && t !== 'movie' && !!c.guid;
                });
            log.info(`[lc-772] season-guid parent=${parentGuid} children=${list.length} -> ${(season && season.guid) || '(none)'}`);
            return { ok: true, guid: (season && season.guid) || '' };
        } catch (e: any) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }, { useHandle: true });

    log.info('飞牛影视库索引持久化插件已加载');
}

export { init };
