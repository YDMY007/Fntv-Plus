import { BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import { getMainWindow } from '../../common/mainwin';
import { getInstance as getUpdateChecker } from '../../../modules/updater/updateChecker';
import { setMpvPlayerPath, setPotPlayerPath } from './media';
import { writeMpvUserConfig, writeBiliSearchEnabled } from './mpvConfig';
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
        potPath: fnConfig.getPotPlayerPath() || '',
        defaultPlayer: fnConfig.getDefaultPlayer(),
        exitMode: fnConfig.getExitMode(),
        mpvDefaultShader: fnConfig.getMpvDefaultShader(),
        mpvIccEnabled: fnConfig.getMpvIccEnabled(),
        doubanSyncEnabled: fnConfig.getDoubanSyncEnabled(),
        doubanLoggedIn: !!fnConfig.getDoubanCookie(),
        debugEnabled: fnConfig.getDebugEnabled(),
        debugComponents: fnConfig.getDebugComponents(),
        bangumiToken: fnConfig.getBangumiToken(),
        bangumiSyncEnabled: fnConfig.getBangumiSyncEnabled(),
        bangumiSyncThreshold: fnConfig.getBangumiSyncThreshold(),
        mpvBiliSearchEnabled: fnConfig.getMpvBiliSearchEnabled()
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

// 弹出系统文件选择框，选中后写回配置并刷新 media 模块缓存
async function handlePickPotPath(): Promise<string | null> {
    const win = getMainWindow();
    try {
        const result = await dialog.showOpenDialog(win ?? undefined, {
            title: '选择 PotPlayer 播放器',
            properties: ['openFile'],
            filters: [
                { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : [] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            fnConfig.setPotPlayerPath(selectedPath);
            setPotPlayerPath(selectedPath);
            log.info(`PotPlayer 播放器路径已设置为: ${selectedPath}`);
            return selectedPath;
        }
    } catch (error) {
        log.error('选择 PotPlayer 路径失败:', error);
    }
    return null;
}

async function handleClearPotPath(): Promise<void> {
    fnConfig.setPotPlayerPath('');
    setPotPlayerPath(null);
    log.info('PotPlayer 播放器路径已清空');
}

// 设置默认播放器（直接播放时使用）
async function handleSetDefaultPlayer(_event: any, player: 'mpv' | 'potplayer'): Promise<void> {
    fnConfig.setDefaultPlayer(player === 'potplayer' ? 'potplayer' : 'mpv');
    log.info(`默认播放器已设置为: ${player}`);
}

async function handleSetExitMode(_event: any, mode: string): Promise<void> {
    fnConfig.setExitMode(mode as 'direct' | 'minimize' | 'ask');
}

// 设置豆瓣同步总开关
async function handleSetDoubanEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setDoubanSyncEnabled(!!enabled);
    log.info(`豆瓣同步开关已设置为: ${enabled}`);
}

// 设置 Bangumi Access Token（保存/清除）
async function handleSetBangumiToken(_event: any, token: string): Promise<{ ok: boolean }> {
    fnConfig.setBangumiToken(token ? String(token) : null);
    log.info('Bangumi Access Token 已更新');
    return { ok: true };
}

// 设置 Bangumi 集数级同步开关
async function handleSetBangumiSyncEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setBangumiSyncEnabled(!!enabled);
    log.info('Bangumi 同步开关 →', !!enabled);
}

// 设置 Bangumi 同步阈值百分比（0-100，默认80）
async function handleSetBangumiSyncThreshold(_event: any, threshold: number): Promise<void> {
    fnConfig.setBangumiSyncThreshold(Number(threshold) || 80);
    log.info('Bangumi 同步阈值 →', fnConfig.getBangumiSyncThreshold());
}

// 设置 MPV B站弹幕搜索开关（写 config + 同步到 MPV 的 script-opts/uosc_danmaku.conf）
async function handleSetMpvBiliSearchEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setMpvBiliSearchEnabled(!!enabled);
    writeBiliSearchEnabled(!!enabled);
    log.info('MPV B站弹幕搜索开关 →', !!enabled);
}

// 用系统默认浏览器打开外部链接（设置面板内的可点击链接用）
async function handleOpenExternal(_event: any, url: string): Promise<void> {
    if (url && /^https?:\/\//i.test(url)) {
        try { await shell.openExternal(url); }
        catch (e) { log.error('打开外部链接失败:', e); }
    }
}

// 应用调试日志过滤（读取配置并同步给 logger 单例）
function applyDebugFilter(): void {
    const enabled = fnConfig.getDebugEnabled();
    const components = fnConfig.getDebugComponents();
    log.getLogger().setDebugFilter(enabled, components);
    // 下发到渲染进程(供 EmbyWall 等渲染侧日志按组件独立开关控制)
    const win = getMainWindow();
    if (win && win.webContents) {
        win.webContents.send('debug-filter', { enabled, components });
    }
    log.info(`调试日志过滤已应用: enabled=${enabled}, components=${JSON.stringify(components)}`);
}

// 设置调试日志总开关
async function handleSetDebugEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setDebugEnabled(!!enabled);
    applyDebugFilter();
}

// 设置各组件日志开关
async function handleSetDebugComponents(_event: any, components: Record<string, boolean>): Promise<void> {
    fnConfig.setDebugComponents(components || {});
    applyDebugFilter();
}

// 设置默认 MPV 着色器预设 + ICC 校色，并写入 portable_config/mpv-user.conf
async function handleSetMpvShaderConfig(_event: any, payload: { shader?: string; icc?: boolean }): Promise<void> {
    const shader = (payload && payload.shader) || 'off';
    const icc = payload && payload.icc !== false;
    fnConfig.setMpvDefaultShader(shader);
    fnConfig.setMpvIccEnabled(icc);
    writeMpvUserConfig(shader, icc);
    log.info(`默认 MPV 着色器已设置为: ${shader}（ICC=${icc}）`);
}

async function handleCheckUpdate(): Promise<void> {
    try {
        await getUpdateChecker().manualCheckForUpdates();
    } catch (error) {
        log.error('手动检查更新失败:', error);
    }
}

async function handleCheckUpdateMirror(): Promise<void> {
    try {
        await getUpdateChecker().manualCheckForUpdatesViaMirror();
    } catch (error) {
        log.error('镜像检查更新失败:', error);
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

/**
 * 用系统默认方式打开日志文件（Windows 下优先直接用资源管理器/记事本打开）。
 * 比 spawn cmd 稳定，不依赖引号、start、控制台窗口等玄学。
 */
async function handleOpenLog(): Promise<{ ok: boolean; error?: string }> {
    try {
        const logFile = log.getLogFile();
        if (!logFile) return { ok: false, error: '无法定位日志文件路径' };
        if (!fs.existsSync(logFile)) return { ok: false, error: '日志文件尚未生成' };
        // Electron 原生：用系统默认程序打开文件；失败则回退 notepad
        const errMsg = await shell.openPath(logFile);
        if (errMsg) {
            log.warn('shell.openPath 打开日志失败，回退 notepad:', errMsg);
            spawn('notepad.exe', [logFile], { windowsHide: false });
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 导出日志文件：弹出"另存为"对话框，把当前日志复制到用户指定位置。
 */
async function handleExportLog(): Promise<{ ok: boolean; error?: string; savedPath?: string }> {
    try {
        const logFile = log.getLogFile();
        if (!logFile) return { ok: false, error: '无法定位日志文件路径' };
        if (!fs.existsSync(logFile)) return { ok: false, error: '日志文件尚未生成' };
        const win = getMainWindow();
        const ext = path.extname(logFile) || '.log';
        const base = path.basename(logFile, ext);
        const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const defaultName = `${base}-${stamp}${ext}`;
        const result = await dialog.showSaveDialog(win || (undefined as any), {
            title: '导出日志文件',
            defaultPath: defaultName,
            filters: [{ name: '日志文件', extensions: ['log', 'txt'] }]
        });
        if (result.canceled || !result.filePath) {
            return { ok: false, error: '已取消' };
        }
        fs.copyFileSync(logFile, result.filePath);
        return { ok: true, savedPath: result.filePath };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

function init(): void {
    // 启动时应用已保存的调试日志过滤，确保控制台日志开关在用户打开设置前即生效
    applyDebugFilter();
    // 启动时把 MPV B站弹幕搜索开关同步到 script-opts/uosc_danmaku.conf（保证 MPV 读取到最新状态）
    try { writeBiliSearchEnabled(fnConfig.getMpvBiliSearchEnabled()); } catch (e) { log.warn('启动同步 bili_search_enabled 失败', e); }
    registerHandler('settings:get', handleGetSettings, { useHandle: true });
    registerHandler('settings:set-download-proxy', handleSetDownloadProxy, { useHandle: true });
    registerHandler('settings:set-hide-play', handleSetHidePlay, { useHandle: true });
    registerHandler('settings:set-nas-proxy', handleSetNasProxy, { useHandle: true });
    registerHandler('settings:pick-mpv-path', handlePickMpvPath, { useHandle: true });
    registerHandler('settings:clear-mpv-path', handleClearMpvPath, { useHandle: true });
    registerHandler('settings:pick-pot-path', handlePickPotPath, { useHandle: true });
    registerHandler('settings:clear-pot-path', handleClearPotPath, { useHandle: true });
    registerHandler('settings:set-default-player', handleSetDefaultPlayer, { useHandle: true });
    registerHandler('settings:set-exit-mode', handleSetExitMode, { useHandle: true });
    registerHandler('settings:set-douban-enabled', handleSetDoubanEnabled, { useHandle: true });
    registerHandler('settings:set-debug-enabled', handleSetDebugEnabled, { useHandle: true });
    registerHandler('settings:set-debug-components', handleSetDebugComponents, { useHandle: true });
    registerHandler('settings:set-bangumi-token', handleSetBangumiToken, { useHandle: true });
    registerHandler('settings:set-bangumi-sync-enabled', handleSetBangumiSyncEnabled, { useHandle: true });
    registerHandler('settings:set-bangumi-sync-threshold', handleSetBangumiSyncThreshold, { useHandle: true });
    registerHandler('settings:set-mpv-bili-search-enabled', handleSetMpvBiliSearchEnabled, { useHandle: true });
    registerHandler('settings:open-external', handleOpenExternal, { useHandle: true });
    // 渲染进程(EmbyWall 墙)主动索取当前调试过滤 → 回传，使其渲染侧日志开关即时生效
    registerHandler('debug-filter-request', (event: any) => {
        event.sender.send('debug-filter', {
            enabled: fnConfig.getDebugEnabled(),
            components: fnConfig.getDebugComponents()
        });
    }, { useHandle: false });
    registerHandler('settings:set-mpv-shader-config', handleSetMpvShaderConfig, { useHandle: true });
    registerHandler('settings:check-update', handleCheckUpdate, { useHandle: true });
    registerHandler('settings:check-update-mirror', handleCheckUpdateMirror, { useHandle: true });
    registerHandler('settings:show-main', handleShowMain, { useHandle: true });
    registerHandler('settings:open-log', handleOpenLog, { useHandle: true });
    registerHandler('settings:export-log', handleExportLog, { useHandle: true });
}

export {
    init
};
