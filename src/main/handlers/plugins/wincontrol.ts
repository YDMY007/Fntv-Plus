import { getMainWindow } from '../../common/mainwin';
import { setHalfScreen, setFullScreen } from '../../common/winctrl';
import { registerHandler } from '../core/ipcHandler';

/**
 * 窗口控制插件
 * 处理窗口的最小化、最大化和关闭操作
 */

// 窗口最小化处理
function handleMinimize(): void {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.minimize();
}

// 窗口最大化/还原处理
// [v370] 修复: transparent 窗口被 OS Aero Snap 或 maximize() 后, isMaximized() 可能返回
//   不可靠(false), 导致"放大后再次点击无法还原"(又走 maximize 分支=无变化).
//   改用自维护状态 _isMax 做 toggle, 不依赖 isMaximized().
let _isMax = false;
function handleMaximize(): void {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (_isMax) {
        mainWindow.unmaximize();
        mainWindow.setSize(1200, 800);
        mainWindow.center();
        _isMax = false;
    } else {
        mainWindow.maximize();
        _isMax = true;
    }
}

// 窗口关闭处理
function handleClose(): void {
    const mainWindow = getMainWindow();
    if (mainWindow) mainWindow.close();
}

// 注册窗口控制处理器
function init(): void {
    registerHandler('window-minimize', handleMinimize);
    registerHandler('window-maximize', handleMaximize);
    registerHandler('window-close', handleClose);
}

export {
    init
};
