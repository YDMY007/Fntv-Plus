import { BrowserWindow, dialog } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import { getMainWindow } from '../../common/mainwin';
import { getInstance as getUpdateChecker } from '../../../modules/updater/updateChecker';
import { setMpvPlayerPath } from './media';
import * as log from '../../../modules/logger';

/**
 * 设置面板 IPC 插件
 * 把原托盘右键菜单里的设置项迁移到侧栏"设置"按钮弹出的面板中。
 * 全部使用 ipcMain.handle（前端用 ipcRenderer.invoke 调用，可 await 返回值）。
 */

// 读取所有设置项，供前端初始化面板
async function handleGetSettings(): Promise<any> {
    return {
        downloadProxy: fnConfig.getDownloadProxyConfig(),
        hideOriginalPlayButton: fnConfig.getHideOriginalPlayButton(),
        nasProxyEnabled: fnConfig.getNasProxyEnabled(),
        mpvPath: fnConfig.getMpvPlayerPath() || '',
        exitMode: fnConfig.getExitMode()
    };
}

async function handleSetDownloadProxy(_event: any, enabled: boolean): Promise<void> {
    const cur = fnConfig.getDownloadProxyConfig();
    fnConfig.setDownloadProxyConfig({ enabled: !!enabled, proxyUrl: cur.proxyUrl });
}

async function handleSetHidePlay(_event: any, hide: boolean): Promise<void> {
    fnConfig.setHideOriginalPlayButton(!!hide);
}

async function handleSetNasProxy(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setNasProxyEnabled(!!enabled);
}

// 弹出系统文件选择框，选中后写回配置并刷新 media 模块缓存
async function handlePickMpvPath(): Promise<string | null> {
    const win = getMainWindow();
    try {
        const result = await dialog.showOpenDialog(win ?? undefined, {
            title: '选择 MPV 播放器',
            properties: ['openFile'],
            filters: [
                { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : [] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            fnConfig.setMpvPlayerPath(selectedPath);
            setMpvPlayerPath(selectedPath);
            log.info(`MPV 播放器路径已设置为: ${selectedPath}`);
            return selectedPath;
        }
    } catch (error) {
        log.error('选择 MPV 路径失败:', error);
    }
    return null;
}

async function handleClearMpvPath(): Promise<void> {
    fnConfig.setMpvPlayerPath('');
    setMpvPlayerPath(null);
    log.info('MPV 播放器路径已清空，将使用自动检测');
}

async function handleSetExitMode(_event: any, mode: string): Promise<void> {
    fnConfig.setExitMode(mode as 'direct' | 'minimize' | 'ask');
}

async function handleCheckUpdate(): Promise<void> {
    try {
        await getUpdateChecker().manualCheckForUpdates();
    } catch (error) {
        log.error('手动检查更新失败:', error);
    }
}

async function handleShowMain(): Promise<void> {
    const win = getMainWindow();
    if (win) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
    }
}

function init(): void {
    registerHandler('settings:get', handleGetSettings, { useHandle: true });
    registerHandler('settings:set-download-proxy', handleSetDownloadProxy, { useHandle: true });
    registerHandler('settings:set-hide-play', handleSetHidePlay, { useHandle: true });
    registerHandler('settings:set-nas-proxy', handleSetNasProxy, { useHandle: true });
    registerHandler('settings:pick-mpv-path', handlePickMpvPath, { useHandle: true });
    registerHandler('settings:clear-mpv-path', handleClearMpvPath, { useHandle: true });
    registerHandler('settings:set-exit-mode', handleSetExitMode, { useHandle: true });
    registerHandler('settings:check-update', handleCheckUpdate, { useHandle: true });
    registerHandler('settings:show-main', handleShowMain, { useHandle: true });
}

export {
    init
};
