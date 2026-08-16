import { app, IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import { applyLatestPatch, ApplyResult } from '../../../modules/patcher/patchApplier';
import { getMainWindow } from '../../common/mainwin';
import * as log from '../../../modules/logger';

/**
 * [lc-474] 一键应用热补丁。
 * 渲染端「一键应用补丁」按钮 → 此处下载并填补补丁，再重载/重启使生效。
 */
async function handleApplyPatch(_event: IpcMainInvokeEvent): Promise<ApplyResult> {
    log.info('[patch] 收到一键应用补丁请求');
    let result: ApplyResult;
    try {
        result = await applyLatestPatch();
    } catch (e: any) {
        log.error('[patch] 应用失败:', e && e.message);
        result = { ok: false, filesApplied: 0, needsRestart: false, message: `应用失败: ${(e && e.message) || '未知错误'}` };
    }

    // 先返回结果给渲染端（用于弹窗提示），再延迟执行重载/重启，确保响应送达
    // 仅当实际填补了文件才重载/重启；"已是最新补丁"无需刷新
    if (result.ok && result.filesApplied > 0) {
        setTimeout(() => {
            try {
                if (result.needsRestart) {
                    log.info('[patch] 热补丁含主进程文件，重启应用生效');
                    app.relaunch({ args: process.argv.slice(1) });
                    app.exit(0);
                } else {
                    const win = getMainWindow();
                    if (win && win.webContents) {
                        log.info('[patch] 重载渲染端使热补丁生效');
                        win.webContents.reload();
                    }
                }
            } catch (e) {
                log.error('[patch] 重载/重启失败:', (e as Error).message);
            }
        }, 1200);
    }
    return result;
}

function init(): void {
    registerHandler('settings:apply-patch', handleApplyPatch, { useHandle: true });
}

export { init };
