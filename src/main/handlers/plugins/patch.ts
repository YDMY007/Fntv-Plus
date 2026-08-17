import { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import {
    applyLatestPatchAndReload,
    applyTestPatchAndReload,
    checkLatestPatchInfo,
    listTestPatches,
    PatchCheckInfo,
    ApplyResult,
} from '../../../modules/patcher/patchApplier';
import * as log from '../../../modules/logger';

/**
 * [lc-481] 开发者测试版解锁代码：仅用于「设置-通用-更新选项-获取测试更新」按钮。
 * 验证通过才会从 Gitee 拉取 -test 测试补丁并应用；普通用户无此代码，永远拿不到 test 版。
 * 个人开发用，可自行修改；亦可用环境变量 FNTV_DEV_CODE 覆盖（不重新编译即可换码）。
 */
const DEV_UNLOCK_CODE: string = process.env.FNTV_DEV_CODE || 'ydmy007';

/**
 * [lc-483] 仅检查是否有可用热补丁（不下载）。渲染端「应用补丁」向导弹窗先调用它，
 * 实时判断并显示版本号，再等用户点「立即应用」才开始下载，避免无感/误下载。
 */
async function handleCheckPatch(_event: IpcMainInvokeEvent): Promise<PatchCheckInfo> {
    log.info('[patch] 收到检查热补丁请求');
    return await checkLatestPatchInfo();
}

/**
 * [lc-474] 一键应用热补丁（普通用户用）。
 * 渲染端「应用补丁」按钮/向导 → 此处下载并填补补丁，并通过 settings:patch-progress
 * 实时回传下载/应用进度，最后重载/重启使生效。
 */
async function handleApplyPatch(event: IpcMainInvokeEvent): Promise<ApplyResult> {
    log.info('[patch] 收到一键应用补丁请求(带进度)');
    return await applyLatestPatchAndReload({
        onProgress: (p) => {
            try { event.sender.send('settings:patch-progress', p); } catch { /* 渲染端可能已关闭 */ }
        },
    });
}

/**
 * [lc-492] 列出 Gitee 上所有 -test 测试补丁版本（开发者测试通道「选择 + 应用」流程第一步）。
 * 码错误直接拒绝；码正确才走 listTestPatches 返回可选版本列表。
 */
async function handleListTestPatches(_event: IpcMainInvokeEvent, code?: string): Promise<any> {
    log.info('[patch] 收到列出测试补丁请求');
    if (!code || code !== DEV_UNLOCK_CODE) {
        return { ok: false, message: '解锁代码错误，无法获取测试补丁列表' };
    }
    return await listTestPatches();
}

/**
 * [lc-481] 开发者拉取 test 测试补丁（需解锁码）。
 * 码错误直接拒绝，绝不触碰 Gitee；码正确才走 applyTestPatchAndReload（含重载/重启 + 进度）。
 * [lc-492] 支持指定 version（用户从列表选择的具体测试版本）；不传则应用最新 test 版本。
 */
async function handleApplyTestPatch(event: IpcMainInvokeEvent, code?: string, version?: string): Promise<ApplyResult> {
    log.info('[patch] 收到开发者测试补丁请求');
    if (!code || code !== DEV_UNLOCK_CODE) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: '解锁代码错误，无法获取测试补丁' };
    }
    return await applyTestPatchAndReload({
        onProgress: (p) => {
            try { event.sender.send('settings:patch-progress', p); } catch { /* 渲染端可能已关闭 */ }
        },
    }, version);
}

function init(): void {
    registerHandler('settings:check-patch', handleCheckPatch, { useHandle: true });
    registerHandler('settings:apply-patch', handleApplyPatch, { useHandle: true });
    registerHandler('settings:list-test-patches', handleListTestPatches, { useHandle: true });
    registerHandler('settings:apply-test-patch', handleApplyTestPatch, { useHandle: true });
}

export { init };
