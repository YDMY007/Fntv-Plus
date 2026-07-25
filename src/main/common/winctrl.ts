import * as path from 'path';
import * as log from '../../modules/logger';
import { readConfig } from '../../modules/fn_config/config';
import { restoreCookies } from '../../modules/fn_config/cookie';
import { BrowserWindow } from 'electron';

/**
 * 设置窗口为半屏
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export function setHalfScreen(mainWindow: BrowserWindow): void {
    if (!mainWindow) return;

    mainWindow.setSize(1200, 800);
    mainWindow.center();
    mainWindow.unmaximize();
}

/**
 * 设置窗口为全屏
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export function setFullScreen(mainWindow: BrowserWindow): void {
    if (mainWindow) mainWindow.maximize();
}

/**
 * 设置全屏切换
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export function setupFullScreenToggle(mainWindow: BrowserWindow): void {
    let isFullScreen = false;
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
            if (isFullScreen) {
                setHalfScreen(mainWindow);
            } else {
                setFullScreen(mainWindow);
            }
            isFullScreen = !isFullScreen;
            event.preventDefault();
        }
    });
}

/**
 * 设置输入法相关功能
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export function setupInputMethodDisable(mainWindow: BrowserWindow): void {
    // 禁用输入法相关功能
    mainWindow.webContents.on('dom-ready', () => {
        // 注入CSS来禁用输入法自动切换
        mainWindow.webContents.insertCSS(`
            * {
                ime-mode: disabled !important;
                -webkit-ime-mode: disabled !important;
            }
            input, textarea {
                ime-mode: inactive !important;
                -webkit-ime-mode: inactive !important;
            }
        `);
    });
}

/**
 * 设置窗口显示事件
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export function setupWindowShowEvents(mainWindow: BrowserWindow): void {
    mainWindow.once('ready-to-show', () => mainWindow.show());
}

/**
 * 设置 cookie 恢复
 * @param {Electron.BrowserWindow} mainWindow - 主窗口实例
 */
export async function setupCookieRestore(mainWindow: BrowserWindow): Promise<void> {
    // 从配置中恢复 cookie
    const savedConfig = readConfig();
    if (!savedConfig || !savedConfig.token || !savedConfig.domain) {
        log.warn('没有找到已保存的配置，无法恢复 cookie');
        mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
        return;
    }

    // ── FN ID 登录: 用持久化的 OAuth token 重建会话 cookie ──
    // FN ID 的 OAuth token 不适用于 getUserInfo 验证(会失败→被踢回登录页),
    // 但其真实会话 cookie 可由 restoreCookies(token) 用 token 重建到 persist:fntv 分区.
    // 重启恢复时必须重新调用 restoreCookies(跳过验证) 写入 Trim-MC-token + mode=relay,
    // 否则仅靠上次运行时遗留的 session cookie(无过期, 重启丢失)会导致进不去主界面.
    if (savedConfig.loginType === 'fnid') {
        log.info('[FN ID] 恢复登录状态(使用持久化 token 重建会话), domain:', savedConfig.domain);
        const ok = await restoreCookies(savedConfig.domain, savedConfig.token, true);
        if (!ok) {
            log.warn('[FN ID] 重启恢复失败(token 可能已失效), 跳转登录页');
            mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
            return;
        }
        // 仅登录页路径(/login,/signin,/v/login)强制白底, 主界面 /v 保持玻璃效果.
        // SPA 感知: /v 先加载后客户端跳 /v/login, 故需同时监听 dom-ready / did-finish-load / did-navigate-in-page.
        const fnidSyncBg = () => {
            try {
                const u = new URL(mainWindow!.webContents.getURL());
                const p = u.pathname.toLowerCase();
                if (p.includes('/login') || p.includes('/signin')) {
                    mainWindow?.webContents.insertCSS('html,body{background:#ffffff!important;background-color:#ffffff!important;}').catch(() => {});
                }
            } catch { /* ignore */ }
        };
        mainWindow.webContents.once('dom-ready', fnidSyncBg);
        mainWindow.webContents.on('did-finish-load', fnidSyncBg);
        mainWindow.webContents.on('did-navigate-in-page', fnidSyncBg);
        mainWindow.loadURL(`${savedConfig.domain}/v`);
        return;
    }

    // 恢复 cookie 并跳转到对应的 URL
    log.info('恢复登录状态，即将跳转到主页面, domain:', savedConfig.domain, ' token:', savedConfig.token);

    // 恢复 cookie
    await restoreCookies(savedConfig.domain, savedConfig.token).then((result) => {
        if (result === true) {
            // cookie 恢复成功，跳转到主页面
            // 仅登录页路径强制白底(insertCSS 覆盖 ACRYLIC 玻璃壳), SPA 感知
            const normalSyncBg = () => {
                try {
                    const u = new URL(mainWindow!.webContents.getURL());
                    const p = u.pathname.toLowerCase();
                    if (p.includes('/login') || p.includes('/signin')) {
                        mainWindow?.webContents.insertCSS('html,body{background:#ffffff!important;background-color:#ffffff!important;}').catch(() => {});
                    }
                } catch { /* ignore */ }
            };
            mainWindow.webContents.once('dom-ready', normalSyncBg);
            mainWindow.webContents.on('did-finish-load', normalSyncBg);
            mainWindow.webContents.on('did-navigate-in-page', normalSyncBg);
            mainWindow.loadURL(`${savedConfig.domain}/v`);
            return;
        }

        // cookie 恢复失败，跳转到登录页面
        log.warn('Cookie 恢复失败，跳转到登录页面');
        mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
    }).catch((error) => {
        // 出现异常，也跳转到登录页面
        log.error('Cookie 恢复过程中出现异常:', error);
        mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
    });
}
