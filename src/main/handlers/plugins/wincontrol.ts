import { getMainWindow } from '../../common/mainwin';
import { setHalfScreen, setFullScreen } from '../../common/winctrl';
import { handleExitIntent } from '../../common/exitFlow';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';

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
// [lc-1071] X 按钮不再走 win.close() → 'close' 事件 preventDefault 取消的路径：
// transparent 无边框窗口在 Windows 上取消系统关闭会整窗闪一帧(用户报障「画面闪一下」)。
// 直接按 exitMode 分流(询问弹窗 / 隐藏托盘 / 退出)，只有真正退出时才 quit。
function handleClose(): void {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    handleExitIntent(mainWindow).catch((error: Error) => {
        log.error('窗口关闭意图处理失败:', error);
    });
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
