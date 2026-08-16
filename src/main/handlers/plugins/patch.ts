import { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import { applyLatestPatchAndReload, ApplyResult } from '../../../modules/patcher/patchApplier';
import * as log from '../../../modules/logger';

/**
 * [lc-474] 一键应用热补丁。
 * 渲染端「一键应用补丁」按钮 → 此处下载并填补补丁，再重载/重启使生效。
 * 重载/重启逻辑已收敛到 patchApplier.applyLatestPatchAndReload（更新弹窗 hotfix 也复用）。
 */
async function handleApplyPatch(_event: IpcMainInvokeEvent): Promise<ApplyResult> {
    log.info('[patch] 收到一键应用补丁请求');
    return await applyLatestPatchAndReload();
}

function init(): void {
    registerHandler('settings:apply-patch', handleApplyPatch, { useHandle: true });
}

export { init };
