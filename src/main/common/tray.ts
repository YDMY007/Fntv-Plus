import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import * as path from 'path';
import { getTrayNotificationShown, setTrayNotificationShown } from './preferences';
import * as log from '../../modules/logger';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null; // 主窗口引用

/**
 * 更新托盘菜单 —— 现在仅保留"退出"一项，其余设置已迁入侧栏"设置"按钮
 */
async function updateTrayMenu(): Promise<void> {
    if (!tray) return;

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        {
            label: process.platform === 'darwin' ? '退出飞牛影视' : '退出',
            click: () => {
                // 托盘菜单中的退出按钮直接退出应用
                (app as any).isQuiting = true;
                app.quit();
            }
        }
    ];

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    tray.setContextMenu(contextMenu);
}

/**
 * 创建系统托盘
 * @param {BrowserWindow} mainWindowInstance - 主窗口实例
 */
export async function createTray(mainWindowInstance: BrowserWindow): Promise<void> {
    // 保存窗口引用
    mainWindow = mainWindowInstance;

    // 根据平台选择合适的图标
    let iconPath: string;
    let icon: Electron.NativeImage;

    if (process.platform === 'darwin') {
        // macOS 推荐用 template 图标
        iconPath = path.join(__dirname, '../../../build/iconTemplate2.png');
        icon = nativeImage.createFromPath(iconPath);

        if (icon.isEmpty()) {
            // fallback: 用通用图标
            iconPath = path.join(__dirname, '../../../build/icon.png');
            icon = nativeImage.createFromPath(iconPath);

            if (!icon.isEmpty()) {
                // 尺寸适配状态栏（通常 16x16 即可，Retina 自动缩放）
                icon = icon.resize({ width: 16, height: 16 });
            }
        }

        if (!icon.isEmpty()) {
            icon.setTemplateImage(true); // 关键：启用 macOS 自动浅色/深色模式适配
        }
    } else if (process.platform === 'win32') {
        // Windows 使用 ICO 格式
        iconPath = path.join(__dirname, '../../../build/icon.ico');
        icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
            icon = icon.resize({ width: 16, height: 16 });
        }
    } else {
        // Linux 使用 PNG 格式
        iconPath = path.join(__dirname, '../../../build/icon.png');
        icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
            icon = icon.resize({ width: 16, height: 16 });
        }
    }

    // 如果图标仍然为空，记录错误但继续创建托盘
    if (icon.isEmpty()) {
        log.warn('托盘图标加载失败，使用默认图标');
        // 创建一个简单的默认图标
        icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);

    // 设置托盘提示文字
    tray.setToolTip('飞牛影视');

    // 初始创建菜单
    await updateTrayMenu();

    // 根据平台设置不同的点击行为
    if (process.platform === 'darwin') {
        // macOS 上单击托盘图标恢复窗口
        tray.on('click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                if (!mainWindow.isVisible()) mainWindow.show();
                mainWindow.focus();
                app.dock?.show();
            }
        });
    } else if (process.platform === 'win32') {
        // Windows上双击托盘图标恢复窗口
        tray.on('double-click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                if (!mainWindow.isVisible()) mainWindow.show();
                mainWindow.focus();
            }
        });
    }

    log.info('系统托盘创建成功');
}

/**
 * 显示托盘通知（仅在Windows上首次显示）
 */
export function showTrayNotification(): void {
    if (process.platform === 'win32' && !getTrayNotificationShown() && tray) {
        tray.displayBalloon({
            iconType: 'info',
            title: '飞牛影视',
            content: '应用已最小化到托盘，双击托盘图标或右键菜单可以恢复窗口'
        });
        setTrayNotificationShown(true); // 标记已显示过提示
    }
}

/**
 * 销毁托盘
 */
export function destroyTray(): void {
    if (tray) {
        tray.destroy();
        tray = null;
        log.info('系统托盘已销毁');
    }
}

/**
 * 获取托盘实例
 * @returns {Tray|null} 托盘实例
 */
export function getTray(): Tray | null {
    return tray;
}
