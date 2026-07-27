import * as path from 'path';
import * as net from 'net';
import * as log from '../../modules/logger';
import { readConfig } from '../../modules/fn_config/config';
import { restoreCookies } from '../../modules/fn_config/cookie';
import { BrowserWindow } from 'electron';

/**
 * 快速可达性预检: TCP 连接 domain 的 host:port, 超时即判定不可达.
 * 用途: 启动恢复会话前, 先确认持久化的 domain(可能是内网 IP)在当前网络下可达,
 *       否则(如内网 IP 切到外网)直接回登录页, 避免 loadURL 失败导致永久白屏.
 */
function isDomainReachable(domain: string, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        let url: URL;
        try {
            url = new URL(domain);
        } catch {
            resolve(false);
            return;
        }
        const host = url.hostname;
        const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
        const socket = new net.Socket();
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        try {
            socket.connect(port, host);
        } catch {
            done(false);
        }
    });
}

/**
 * 安全加载主页面: 若加载失败(域名不可达/证书等), 自动回退到登录页, 杜绝白屏.
 */
function loadMainOrFallback(mainWindow: BrowserWindow, url: string, label: string): void {
    mainWindow.webContents.once('did-fail-load', (_e: any, _code: number, _desc: string, validatedURL: string) => {
        if (validatedURL.startsWith(url.split('?')[0])) {
            log.error(`[启动恢复] ${label} 主页面加载失败, 回退登录页: ${validatedURL}`);
            mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
        }
    });
    mainWindow.loadURL(url);
}

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
        // ★ 外网/不可达预检: restoreCookies(isLogin=true) 仅写本地 cookie 不联网校验,
        //   若持久化的是内网 IP 且当前切到外网, 这里直接回登录页, 避免 loadURL 失败白屏.
        const reachable = await isDomainReachable(savedConfig.domain);
        if (!reachable) {
            log.warn(`[FN ID] 持久化域名不可达(可能已切换网络环境), 跳转登录页: ${savedConfig.domain}`);
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
        loadMainOrFallback(mainWindow, `${savedConfig.domain}/v`, '[FN ID]');
        return;
    }

    // 恢复 cookie 并跳转到对应的 URL
    log.info('恢复登录状态，即将跳转到主页面, domain:', savedConfig.domain, ' token:', savedConfig.token);

    // ★ 外网/不可达预检: 持久化域名在当前网络下不可达时, 直接回登录页避免白屏
    const reachable = await isDomainReachable(savedConfig.domain);
    if (!reachable) {
        log.warn(`持久化域名不可达(可能已切换网络环境), 跳转登录页: ${savedConfig.domain}`);
        mainWindow.loadFile(path.join(__dirname, '../../../resource/login/index.html'));
        return;
    }

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
            loadMainOrFallback(mainWindow, `${savedConfig.domain}/v`, '');
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
