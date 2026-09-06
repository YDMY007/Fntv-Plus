import { app, BrowserWindow, Notification } from 'electron';
import * as fnConfig from '../../modules/fn_config/config';
import { fnosDialog } from './fnosDialog';
import { showTrayNotification } from './tray';
import { getMacCloseAction, setMacCloseAction, getTrayNotificationShown, setTrayNotificationShown } from './preferences';

// [lc-1071] 统一「退出意图」处理 —— 标题栏 X 按钮(window-close IPC)与窗口 close 事件
// (Alt+F4 / 系统关机等触发的真实关闭请求)共用同一分流。
//
// 背景: 此前 X 按钮也走 win.close() → 'close' 事件 preventDefault 取消。transparent
// 无边框窗口在 Windows 上取消系统关闭会整窗闪一帧(关闭流程已被 DWM 触发又拦回)，
// 用户报障「点关闭按钮画面闪一下」。现改为 X 按钮不进 close 流程，直接按 exitMode
// 分流(询问/隐藏托盘/直接退出)；close 事件仅兜底系统发起的关闭(仍需 preventDefault)。

// macOS 通知：隐藏到状态栏后提示恢复方式
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

/** 处理一次用户退出意图：按平台与 exitMode 决定 弹窗询问 / 隐藏到托盘 / 直接退出 */
export async function handleExitIntent(mainWindow: BrowserWindow | null): Promise<void> {
    if ((app as any).isQuiting) return;

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
                mainWindow?.hide();
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
            mainWindow?.hide();
            app.dock?.hide();
            showMacNotification();
        } else if (action === 'quit') {
            // 直接退出
            (app as any).isQuiting = true;
            app.quit();
        }
        return;
    }

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
            mainWindow?.hide();
            showTrayNotification();
        }
    } else if (exitMode === 'minimize') {
        // 隐藏到托盘
        mainWindow?.hide();
        showTrayNotification();
    } else {
        // 直接退出
        (app as any).isQuiting = true;
        app.quit();
    }
}
