// preload/plugins/watchedSync.ts
// 「已观看」列表的抓取已迁移到主进程：直接用 fnOS API（item/list，带 token）拉根媒体库，
// 过滤 watched===1 的条目（实证：根库 133 项 → 已观看 3 项），不再依赖隐藏 iframe +
// 点击 Semi 筛选盒子（合成事件下极不稳定，曾迭代 7 轮仍失败，已彻底废弃）。
//
// 渲染进程只负责：把主进程算好的「已观看」条目回传给主进程处理（标豆瓣「看过」）。
// 无 DOM 操作，无兜底抓全部（定位失败=空列表，天然安全）。
import { ipcRenderer } from 'electron';
import logger from '../core/logger';

let _scanning = false;

/**
 * 拉取飞牛「已观看」列表（主进程已用 item/list + watched 过滤算好，这里只取结果）。
 * 返回 {guid,type,title,douban_id,...} 列表；失败/空返回 []。
 */
export async function scanWatchedShows(): Promise<any[]> {
    if (_scanning) return [];
    _scanning = true;
    try {
        const resp = await ipcRenderer.invoke('douban:get-watched-items').catch((e: any) => {
            logger.warn('[watchedSync] 拉取已观看列表失败:', String((e && e.message) || e));
            return [];
        });
        // 兼容两种返回形态：旧版直接返回数组；新版返回 { items, libraryTotal }
        const items = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.items) ? resp.items : []);
        return items;
    } finally {
        _scanning = false;
    }
}

// 主进程定时/手动触发扫描时，渲染进程执行扫描并把结果回传
ipcRenderer.on('douban:scan-watched-request', async () => {
    try {
        const items = await scanWatchedShows();
        if (!items.length) {
            const summary = {
                total: 0,
                marked: 0,
                skipped: 0,
                failed: 0,
                note: '未抓到已观看条目（API 拉取为空/失败），已停止避免误标',
            };
            await ipcRenderer.invoke('douban:scan-watched-done', summary).catch(() => {});
            return;
        }
        const summary: any = await ipcRenderer
            .invoke('douban:process-watched', items)
            .catch((e: any) => ({
                total: items.length,
                marked: 0,
                skipped: 0,
                failed: 0,
                error: String((e && e.message) || e),
            }));
        await ipcRenderer.invoke('douban:scan-watched-done', summary).catch(() => {});
    } catch (e: any) {
        await ipcRenderer
            .invoke('douban:scan-watched-done', {
                total: 0,
                marked: 0,
                skipped: 0,
                failed: 0,
                error: String((e && e.message) || e),
            })
            .catch(() => {});
    }
});

// 暴露给设置面板按钮直接调用（手动扫描）
(window as any).fnosScanWatched = async (): Promise<any> => {
    return await ipcRenderer.invoke('douban:scan-watched-manual').catch((e: any) => ({
        total: 0,
        marked: 0,
        skipped: 0,
        failed: 0,
        error: String((e && e.message) || e),
    }));
};
