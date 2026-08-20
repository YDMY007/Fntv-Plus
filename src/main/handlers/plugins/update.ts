import { app, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { getInstance as getUpdateChecker } from '../../../modules/updater/updateChecker';
import { registerHandler } from '../core/ipcHandler';
import { getAppliedPatchVersion, getCustomVersion, setCustomVersion } from '../../../modules/fn_config/config';
import * as log from '../../../modules/logger';

/**
 * 更新管理插件
 * 处理应用更新检查功能
 */

// 获取更新检查器单例实例
const updateChecker = getUpdateChecker();

// [lc-634] 版号切换解锁码（与 patch.ts 的开发者解锁码一致；可用环境变量 FNTV_DEV_CODE 覆盖）
const DEV_UNLOCK_CODE: string = process.env.FNTV_DEV_CODE || 'ydmy007';

// 处理手动检查更新
async function handleCheckUpdate(event: IpcMainEvent): Promise<void> {
    log.info('收到手动检查更新请求');
    await updateChecker.manualCheckForUpdates();
}

// 处理自动检查更新
async function handleAutoCheckUpdate(event: IpcMainEvent): Promise<void> {
    log.info('收到自动检查更新请求');
    await updateChecker.autoCheckForUpdates();
}

// 获取当前版本信息
// [lc-495] 已应用热补丁后，显示的「当前版本」应同步为补丁版本（如 3.3.7-test1），
//   而非安装包版本；取 applied 版本为优先，未打补丁时回退安装版本。
// [lc-634] 版号切换：开发者自定义版本号(customVersion)优先于安装包版本。
//   优先级: appliedPatch > customVersion > app.getVersion()
function handleGetVersion(event: IpcMainEvent): void {
    const displayVersion = getAppliedPatchVersion() || getCustomVersion() || app.getVersion();
    event.reply('version-info', {
        version: displayVersion,
        name: app.getName()
    });
}

/**
 * [lc-634] 版号切换：开发者输入解锁码后自定义整个软件版本号。
 *  - code: 解锁码（ydmy007）
 *  - version: 新版本号（空/纯空白 = 清除恢复安装包真实版本）
 * 立即生效：写入 config + 更新 updateChecker 的 currentVersion（更新检测 baseline 同步切换）。
 */
async function handleSetCustomVersion(_event: IpcMainInvokeEvent, code?: string, version?: string): Promise<any> {
    log.info('[update] 收到版号切换请求');
    if (!code || code !== DEV_UNLOCK_CODE) {
        return { ok: false, message: '解锁代码错误，无法切换版本号' };
    }
    const v = (version || '').trim();
    setCustomVersion(v);
    updateChecker.setCurrentVersion(v || '');
    const current = getAppliedPatchVersion() || getCustomVersion() || app.getVersion();
    log.info(`[update] 版号已切换: customVersion=${getCustomVersion() || '(默认)'} 生效显示=${current}`);
    return { ok: true, version: v, displayVersion: current };
}

/**
 * [lc-638] 解锁码验证（渲染端进入「版号切换」输入页前调用）。
 * 空码/错码立即拒绝——防止用户"不输入代码也直接进入自定义版本号页面"。
 */
async function handleVerifyUnlockCode(_event: IpcMainInvokeEvent, code?: string): Promise<any> {
    return { ok: !!code && code === DEV_UNLOCK_CODE };
}

// 注册更新相关处理器
function init(): void {
    // [lc-634] 启动时若有自定义版本号(版号切换残留)，同步到 updateChecker baseline
    const custom = getCustomVersion();
    if (custom) {
        updateChecker.setCurrentVersion(custom);
        log.info(`[update] 启动加载自定义版本号: ${custom}`);
    }
    registerHandler('check-update', handleCheckUpdate);
    registerHandler('auto-check-update', handleAutoCheckUpdate);
    registerHandler('get-version', handleGetVersion);
    registerHandler('settings:set-custom-version', handleSetCustomVersion, { useHandle: true });
    registerHandler('settings:verify-unlock-code', handleVerifyUnlockCode, { useHandle: true });
}

export {
    init
};
