import { IpcMainInvokeEvent } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { writeSmartSkipEnabled } from './mpvConfig';
import { registerHandler } from '../core/ipcHandler';

/**
 * 智能跳过片头片尾插件（smart_skip）
 * - 把「跳过片头/片尾」的控制面从 MPV uosc 菜单抽出来，改为应用「插件」设置面板统一管理。
 * - 真正的跳过逻辑仍在打包的 MPV Lua 套件 smart_skip/ 里；本插件只负责：
 *   1) 持久化总开关到 config.json（get/set-smart-skip-enabled）；
 *   2) 把开关双写到 smart_skip.conf 的 enabled（便携 + 标准两种 mpv 模式都生效）。
 */

// 读取总开关（默认关闭：仅显示「跳过」按钮，不自动跳）
function handleGetSmartSkipEnabled(): boolean {
    return fnConfig.getSmartSkipEnabled();
}

// 写入总开关：同时落 config.json 与 smart_skip.conf
function handleSetSmartSkipEnabled(_event: IpcMainInvokeEvent, enabled: boolean): void {
    const val = !!enabled;
    fnConfig.setSmartSkipEnabled(val);
    writeSmartSkipEnabled(val);
}

// 注册插件处理器
function init(): void {
    registerHandler('settings:get-smart-skip-enabled', handleGetSmartSkipEnabled, { useHandle: true });
    registerHandler('settings:set-smart-skip-enabled', handleSetSmartSkipEnabled, { useHandle: true });
}

export {
    init,
    handleGetSmartSkipEnabled,
    handleSetSmartSkipEnabled
};
