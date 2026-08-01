import { globalShortcut, app } from 'electron';
import { controlCurrentPlayer } from './media';
import * as logger from '../../../modules/logger';
const log = logger.component('globalShortcut');

/**
 * 全局快捷键插件
 * 即使 Electron 主窗口/播放器窗口失焦，也能用系统级热键控制正在播放的 MPV/PotPlayer。
 *
 * 注意：本模块历史上曾依赖 config.getGlobalShortcutsEnabled() 的「设置面板 > 全局快捷键」
 * 开关，但该配置项与其 UI 现均已不存在（config.ts 不再导出该函数，settings.ts 也无对应开关），
 * 继续引用会在运行时抛 TypeError 导致整个模块初始化失败、所有媒体键失效。
 * 鉴于该开关无 UI 可控，这里改为【始终启用】全局快捷键（与原始默认值「开启」一致），
 * 恢复 MediaPlayPause / MediaNextTrack / MediaPreviousTrack 等媒体键能力。
 */
// 加速键 → 控制动作。媒体键(PlayPause/Next/Prev)无冲突；seek/倍速用 Ctrl/Cmd + Shift + 方向键，降低误触。
const SHORTCUT_MAP = [
    { accel: 'MediaPlayPause', action: 'playpause', desc: '播放/暂停' },
    { accel: 'MediaNextTrack', action: 'next', desc: '下一集' },
    { accel: 'MediaPreviousTrack', action: 'prev', desc: '上一集' },
    { accel: 'CommandOrControl+Shift+ArrowLeft', action: 'seek-back', desc: '快退 5 秒' },
    { accel: 'CommandOrControl+Shift+ArrowRight', action: 'seek-fwd', desc: '快进 5 秒' },
    { accel: 'CommandOrControl+Shift+ArrowUp', action: 'speed-up', desc: '倍速 +' },
    { accel: 'CommandOrControl+Shift+ArrowDown', action: 'speed-down', desc: '倍速 -' }
];

let registered: string[] = [];

// 注册全部启用的快捷键；返回成功数量
function doRegister(): number {
    // 先清空
    if (registered.length) {
        registered.forEach((a) => {
            try { globalShortcut.unregister(a); } catch (_) { /* ignore */ }
        });
        registered = [];
    }
    let ok = 0;
    for (const item of SHORTCUT_MAP) {
        try {
            const success = globalShortcut.register(item.accel, () => {
                log.info(`[全局快捷键] ${item.desc} (${item.accel})`);
                controlCurrentPlayer(item.action as any);
            });
            if (success) {
                registered.push(item.accel);
                ok++;
            } else {
                log.warn(`[全局快捷键] 注册失败(可能被系统占用): ${item.accel} -> ${item.desc}`);
            }
        } catch (e: any) {
            log.warn(`[全局快捷键] 注册异常 ${item.accel}:`, e?.message || e);
        }
    }
    return ok;
}

// 刷新全局快捷键（当前为始终启用；保留函数名以便将来接回设置开关）
function refreshGlobalShortcuts(): void {
    const n = doRegister();
    log.info(`[全局快捷键] 已启用，注册 ${n}/${SHORTCUT_MAP.length} 个`);
}

function init(): void {
    // 应用退出前注销，避免热键残留占用
    app.on('before-quit', () => {
        try {
            globalShortcut.unregisterAll();
        } catch (_) { /* ignore */ }
        registered = [];
    });
    refreshGlobalShortcuts();
}

export {
    refreshGlobalShortcuts,
    init
};
