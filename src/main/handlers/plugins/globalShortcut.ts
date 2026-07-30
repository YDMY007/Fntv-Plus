import { globalShortcut, app } from 'electron';
import * as fnConfig from '../../../modules/fn_config/config';
import { controlCurrentPlayer } from './media';
import type { PlayerControlAction } from '../../../modules/players/types';
import * as log from '../../../modules/logger';

/**
 * 全局快捷键插件
 * 即使 Electron 主窗口/播放器窗口失焦，也能用系统级热键控制正在播放的 MPV/PotPlayer。
 * 注册表在「设置面板 > 全局快捷键」开关控制；默认开启。
 */

// 加速键 → 控制动作。媒体键(PlayPause/Next/Prev)无冲突；seek/倍速用 Ctrl/ Cmd + Shift + 方向键，降低误触。
const SHORTCUT_MAP: { accel: string; action: PlayerControlAction; desc: string }[] = [
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
        registered.forEach(a => { try { globalShortcut.unregister(a); } catch (_) { /* ignore */ } });
        registered = [];
    }
    let ok = 0;
    for (const item of SHORTCUT_MAP) {
        try {
            const success = globalShortcut.register(item.accel, () => {
                log.info(`[全局快捷键] ${item.desc} (${item.accel})`);
                controlCurrentPlayer(item.action);
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

// 供设置面板「开关」即时刷新
export function refreshGlobalShortcuts(): void {
    if (fnConfig.getGlobalShortcutsEnabled()) {
        const n = doRegister();
        log.info(`[全局快捷键] 已启用，注册 ${n}/${SHORTCUT_MAP.length} 个`);
    } else {
        if (registered.length) {
            registered.forEach(a => { try { globalShortcut.unregister(a); } catch (_) { /* ignore */ } });
            registered = [];
        }
        log.info('[全局快捷键] 已关闭');
    }
}

function init(): void {
    // 应用退出前注销，避免热键残留占用
    app.on('before-quit', () => {
        try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
        registered = [];
    });
    refreshGlobalShortcuts();
}

export {
    init,
    SHORTCUT_MAP
};
