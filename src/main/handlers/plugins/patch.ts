import { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import {
    applyLatestPatchAndReload,
    applyTestPatchAndReload,
    ApplyResult,
} from '../../../modules/patcher/patchApplier';
import * as log from '../../../modules/logger';

/**
 * [lc-481] 开发者测试版解锁代码：仅用于「设置-通用-更新选项-获取测试更新」按钮。
 * 验证通过才会从 Gitee 拉取 -test 测试补丁并应用；普通用户无此代码，永远拿不到 test 版。
 * 个人开发用，可自行修改；亦可用环境变量 FNTV_DEV_CODE 覆盖（不重新编译即可换码）。
 */
const DEV_UNLOCK_CODE: string = process.env.FNTV_DEV_CODE || 'fntv-dev';

/**
 * [lc-474] 一键应用热补丁（普通用户用）。
 * 渲染端「一键应用补丁」按钮 → 此处下载并填补补丁，再重载/重启使生效。
 * 重载/重启逻辑已收敛到 patchApplier.applyLatestPatchAndReload（更新弹窗 hotfix 也复用）。
 */
async function handleApplyPatch(_event: IpcMainInvokeEvent): Promise<ApplyResult> {
    log.info('[patch] 收到一键应用补丁请求');
    return await applyLatestPatchAndReload();
}

/**
 * [lc-481] 开发者拉取 test 测试补丁（需解锁码）。
 * 码错误直接拒绝，绝不触碰 Gitee；码正确才走 applyTestPatchAndReload（含重载/重启）。
 */
async function handleApplyTestPatch(_event: IpcMainInvokeEvent, code?: string): Promise<ApplyResult> {
    log.info('[patch] 收到开发者测试补丁请求');
    if (!code || code !== DEV_UNLOCK_CODE) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: '解锁代码错误，无法获取测试补丁' };
    }
    return await applyTestPatchAndReload();
}

function init(): void {
    registerHandler('settings:apply-patch', handleApplyPatch, { useHandle: true });
    registerHandler('settings:apply-test-patch', handleApplyTestPatch, { useHandle: true });
}

export { init };
