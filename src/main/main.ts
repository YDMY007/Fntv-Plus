import { app, BrowserWindow, Notification, dialog } from 'electron';
import { spawn, execSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { registerAllPlugins } from './handlers';
import { getInstance as getUpdateChecker } from '../modules/updater/updateChecker';
import * as winctrl from './common/winctrl';
import { createTray, showTrayNotification, destroyTray } from './common/tray';
import { getMacCloseAction, setMacCloseAction, getTrayNotificationShown, setTrayNotificationShown } from './common/preferences';
import * as fnConfig from '../modules/fn_config/config';
import * as log from '../modules/logger';
import { getMainWindow } from './common/mainwin';
import { isTrusted } from '../modules/cert_trust';
import { startProxyProcess, shutdownProxyProcess } from './common/proxy';
import { fnosDialog, initFnosDialogIpc } from './common/fnosDialog';

// 禁用输入法自动切换
app.commandLine.appendSwitch('--lang', 'en-US');
app.commandLine.appendSwitch('--disable-features', 'VizDisplayCompositor');

// 抑制SSL相关的底层错误日志
app.commandLine.appendSwitch('--log-level', '3'); // 只显示致命错误
app.commandLine.appendSwitch('--disable-logging');
app.commandLine.appendSwitch('--silent');
app.commandLine.appendSwitch('--no-sandbox'); // 有助于减少某些安全相关日志
app.commandLine.appendSwitch('--disable-web-security'); // 禁用web安全检查（减少相关日志）
app.commandLine.appendSwitch('--ignore-ssl-errors-spki-list'); // 忽略SSL SPKI列表错误
app.commandLine.appendSwitch('--ignore-ssl-errors'); // 忽略SSL错误（减少相关日志）

let mainWindow: BrowserWindow | null = null;
let proxyProcess: ChildProcess | null = null;

/**
 * 启动期中文路径检测（lc-090 升级版, A 项）:
 * 若安装目录(exe)或用户数据目录(userData)含中文/非 ASCII 字符, 阻断启动并引导重装到英文路径。
 * 背景: 原生子进程(proxy.exe / mpv / potctl 等)按 ANSI/GBK 解析中文路径会失败,
 * 表现为「打不开 / 闪退 / 无弹幕」。返回 true 表示已阻断(调用方应 app.quit()); false 表示路径安全可继续。
 */
async function checkNonAsciiPathBlocking(): Promise<boolean> {
    try {
        const exe = app.getPath('exe');
        const userData = app.getPath('userData');
        const bad = [exe, userData].filter(p => /[^\x00-\x7F]/.test(p));
        if (bad.length === 0) return false;
        log.warn('[启动检查] 检测到安装/用户目录含非 ASCII 字符: ' + bad.join(' ; '));
        const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: '安装路径不兼容',
            message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\n' + bad.join('\n') +
                '\n\n这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。\n' +
                '您的登录配置存放在系统用户目录(AppData/Roaming/fntv)，与安装位置无关——重装到英文路径不会丢失登录状态。\n\n' +
                '建议：卸载后重新安装到纯英文路径（例如 D:\\Fntv-Plus 或 C:\\Program Files\\Fntv-Plus），即可彻底解决。',
            buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        });
        // 选「退出并重装」(response===0) 才阻断; 选「继续」则放行(风险自担)
        return response === 0;
    } catch (_) { return false; }
}

// 升级/覆盖安装场景: 清掉可能残留的旧版进程(上游 FNMedia.exe / 飞牛影视.exe, 与本品同用 name=fntv 抢单实例锁)。
// 否则旧进程常驻(关窗不退进程)会抢锁, 导致新版 requestSingleInstanceLock 失败 → 启动即 app.quit() 秒退(闪退)。
if (process.platform === 'win32') {
    for (const legacy of ['FNMedia.exe', '飞牛影视.exe']) {
        try {
            execSync(`taskkill /F /IM ${legacy}`, { windowsHide: true });
            log.info(`[启动] 已清理残留旧版进程: ${legacy}`);
        } catch (_) { /* 无该进程则忽略 */ }
    }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // 仍未能获取锁: 可能是同名新版本进程残留(关窗不退进程)。给出明确提示而非静默秒退。
    log.warn('[启动] 未能获取单实例锁, 另一个实例可能仍在运行');
    app.whenReady().then(() => {
        dialog.showMessageBox({
            type: 'info',
            title: '程序已在运行',
            message: '检测到本程序另一个实例正在运行（或旧版本进程未完全退出）。\n\n请先通过托盘图标退出，或在任务管理器结束 Fntv-Plus / FNMedia 进程后重新启动。',
            buttons: ['知道了'],
            noLink: true,
        }).then(() => app.quit());
    });
} else {
    // 当尝试启动第二个实例时，聚焦到现有窗口
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        try {
            // 初始化日志系统
            log.info('=== 飞牛影视启动 ===');
            initFnosDialogIpc();
            log.info('应用版本:', app.getVersion());
            log.info('Electron版本:', process.versions.electron);
            log.info('Node.js版本:', process.versions.node);
            log.info('日志文件位置:', log.getLogFile());

            // [A 项] 启动期中文路径检测: 非 ASCII 路径阻断启动并引导重装到英文路径
            if (await checkNonAsciiPathBlocking()) {
                app.quit();
                return;
            }

            // 动态处理证书验证错误
            app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
                // 检查URL是否在信任列表中
                if (isTrusted(url)) {
                    // log.debug(`URL ${url} 在信任列表中，忽略证书验证错误: ${error}`);
                    event.preventDefault();
                    callback(true); // 信任证书
                } else {
                    log.warn(`证书验证错误: ${url}, 错误: ${error}`);
                    // 不在信任列表中，使用默认处理（不信任）
                    callback(false);
                }
            });

            // 启动代理服务器
            proxyProcess = await startProxyProcess();

            // 创建主窗口
            mainWindow = getMainWindow();

            // [诊断] 捕获渲染进程控制台错误/加载失败/崩溃, 便于定位"白屏卡死"类问题
            // (fnOS 页面自身的 JS 报错默认不会写入 app.log, 这里统一收集)
            try {
                const wc = mainWindow.webContents;
                wc.on('console-message', (_e: any, level: number, message: string, line?: number, sourceId?: string) => {
                    const tag = level >= 3 ? 'ERROR' : level === 2 ? 'WARN' : level === 1 ? 'INFO' : 'DEBUG';
                    log.info(`[Renderer:${tag}] ${message}${line ? ' (line ' + line + ')' : ''}${sourceId ? ' @ ' + sourceId : ''}`);
                });
                wc.on('did-fail-load', (_e: any, errorCode: number, errorDescription: string, validatedURL: string) => {
                    log.error(`[Renderer] 页面加载失败: ${validatedURL} (${errorCode}: ${errorDescription})`);
                });
                wc.on('render-process-gone', (_e: any, details: any) => {
                    log.error(`[Renderer] 渲染进程崩溃/消失: ${JSON.stringify(details)}`);
                });
            } catch (_) { /* ignore */ }

            // [v374] 窗口拖动改为原生 -webkit-app-region:drag (见 titlebar.ts / mainwin.ts CSS),
            //   不再用 JS setPosition —— transparent 窗口下 setPosition 会触发 DWM 异常放大.
            //   改变窗口大小仅通过拖拽窗口边缘(resizable:true 原生行为).

            // 注册所有插件
            registerAllPlugins();

            // 创建系统托盘
            await createTray(mainWindow);

            // 设置窗口关闭事件
            setupWindowEvents(mainWindow);

            // 设置全屏切换
            winctrl.setupFullScreenToggle(mainWindow);

            // 禁用输入法自动切换
            winctrl.setupInputMethodDisable(mainWindow);

            // 设置窗口显示事件
            winctrl.setupWindowShowEvents(mainWindow);

            // 恢复 Cookie
            await winctrl.setupCookieRestore(mainWindow);

            // 启动后延迟3秒自动检查更新一次（避免影响启动速度）
            setTimeout(() => {
                getUpdateChecker().autoCheckForUpdates().catch((error: Error) => {
                    log.error('启动时自动检查更新失败:', error);
                });
            }, 3000);

            // 默认每日自动检查一次更新: 即使窗口关闭、仅托盘挂后台也持续(24h 周期)
            // 仅当发现新版本时才弹窗提示, 无更新/网络失败均静默
            setInterval(() => {
                getUpdateChecker().autoCheckForUpdates().catch((error: Error) => {
                    log.error('每日自动检查更新失败:', error);
                });
            }, 24 * 60 * 60 * 1000);
        } catch (error) {
            log.error('应用启动失败:', error);
            app.quit();
        }
    });
}

// 设置窗口事件
function setupWindowEvents(mainWindow: BrowserWindow): void {
    if (mainWindow) {
        // 监听窗口关闭事件
        mainWindow.on('close', async (event) => {
            if (!(app as any).isQuiting) {
                event.preventDefault();

                if (process.platform === 'darwin') {
                    // macOS 上的特殊处理
                    const action = getMacCloseAction();

                    if (action === 'ask') {
                        // 询问用户偏好
                        const result = await fnosDialog(mainWindow, {
                            type: 'question',
                            title: '关闭窗口',
                            message: '您希望如何处理窗口关闭？',
                            detail: '在 macOS 上，您可以选择隐藏到状态栏或完全退出应用。',
                            buttons: ['隐藏到状态栏', '退出应用', '取消'],
                            defaultId: 0,
                            cancelId: 2,
                            checkboxLabel: '记住我的选择',
                            checkboxChecked: false,
                        });

                        if (result.response === 0) {
                            // 隐藏到状态栏
                            if (result.checkboxChecked) {
                                setMacCloseAction('minimize');
                            }
                            mainWindow.hide();
                            app.dock?.hide();
                            showMacNotification();
                        } else if (result.response === 1) {
                            // 退出应用
                            if (result.checkboxChecked) {
                                setMacCloseAction('quit');
                            }
                            (app as any).isQuiting = true;
                            app.quit();
                        }
                        // 取消则什么都不做
                    } else if (action === 'minimize') {
                        // 直接隐藏到托盘
                        mainWindow.hide();
                        app.dock?.hide();
                        showMacNotification();
                    } else if (action === 'quit') {
                        // 直接退出
                        (app as any).isQuiting = true;
                        app.quit();
                    }
                } else {
                    // Windows 和 Linux 上根据退出模式处理
                    const exitMode = fnConfig.getExitMode();

                    if (exitMode === 'ask') {
                        // 询问用户
                        const result = await fnosDialog(mainWindow, {
                            type: 'question',
                            title: '退出确认',
                            message: '确定要退出飞牛影视吗？',
                            detail: '您可以选择完全退出应用或最小化到托盘。',
                            buttons: ['退出应用', '最小化到托盘', '取消'],
                            defaultId: 1,
                            cancelId: 2,
                            checkboxLabel: '记住我的选择',
                            checkboxChecked: false,
                        });

                        if (result.response === 0) {
                            // 退出应用
                            if (result.checkboxChecked) {
                                fnConfig.setExitMode('direct');
                            }
                            (app as any).isQuiting = true;
                            app.quit();
                        } else if (result.response === 1) {
                            // 最小化到托盘
                            if (result.checkboxChecked) {
                                fnConfig.setExitMode('minimize');
                            }
                            mainWindow.hide();
                            showTrayNotification();
                        }
                    } else if (exitMode === 'minimize') {
                        // 隐藏到托盘
                        mainWindow.hide();
                        showTrayNotification();
                    } else {
                        // 直接退出
                        (app as any).isQuiting = true;
                        app.quit();
                    }
                }
            }
        });
    }
}

// macOS 通知显示函数
function showMacNotification(): void {
    if (!getTrayNotificationShown()) {
        if (Notification.isSupported()) {
            const notification = new Notification({
                title: '飞牛影视',
                body: '应用已隐藏到状态栏，点击状态栏图标可以恢复窗口',
                silent: false
            });
            notification.show();
        }
        setTrayNotificationShown(true);
    }
}

// 应用退出事件处理
app.on('before-quit', async () => {
    (app as any).isQuiting = true;

    // 使用守护程序优雅关闭proxy进程
    log.info('应用退出前关闭proxy进程');
    try {
        await shutdownProxyProcess();
    } catch (error) {
        log.error('关闭proxy进程出错:', error);
    }

    // 销毁托盘图标
    destroyTray();
});

app.on('window-all-closed', () => {
    // 在 macOS 上，除非明确退出，否则应用程序及其菜单栏通常会保持活动状态
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // 在 macOS 上，当点击 dock 图标且没有其他窗口打开时，
    // 通常会重新创建一个窗口
    if (process.platform === 'darwin') {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = getMainWindow();
            setupWindowEvents(mainWindow);
        } else if (mainWindow) {
            // 如果窗口存在但被隐藏，则显示它
            if (!mainWindow.isVisible()) {
                mainWindow.show();
            }
            mainWindow.focus();
        }

        // 确保 dock 图标显示
        app.dock?.show();
    }
});
