import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import * as logger from '../../../modules/logger';
import { registerHandler } from '../core/ipcHandler';

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

    log.info('飞牛影视库索引持久化插件已加载');
}

export { init };
