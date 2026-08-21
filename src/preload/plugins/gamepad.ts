// preload/plugins/gamepad.ts
// [lc-655] 手柄控制（电脑/电视大屏场景，手柄当遥控器）。
//
// 两层控制：
//  1. 播放中：手柄按键 → IPC media:control → 主进程 controlCurrentPlayer()
//     （播放/暂停、快进快退、倍速、下一集/上一集等）
//  2. 界面导航（无播放器在播）：手柄按键 → dispatch 键盘事件到 document
//     （方向键/Enter/Escape，fnOS 原生页面自动响应列表滚动与按钮聚焦）
//
// 判定逻辑：按 A 等播放键时先 invoke media:control，返回 handled=true 说明有播放器
// 在处理 → 不再触发界面导航；handled=false 则回退为界面按键。
//
// 按键映射（Xbox 布局标准映射）：
//  十字键上/下        → 界面: ArrowUp/ArrowDown；播放中: 音量±（未接，见下）
//  十字键左/右        → 界面: ArrowLeft/ArrowRight；播放中: seek-back/seek-fwd
//  A(0)              → 界面: Enter；播放中: playpause
//  B(1)              → 界面: Escape；播放中: 停止? 不，B=返回(界面) / 播放中忽略
//  X(2)              → 界面: Space（勾选/开关）
//  Y(3)              → 界面: 无；播放中: next（下一集）
//  LB(4)/RB(5)       → 播放中: seek-back/seek-fwd；界面: PageUp/PageDown（列表快速滚动）
//  LT(6)/RT(7)       → 播放中: speed-down/speed-up；界面: 无
//  左摇杆             → 方向键（模拟十字键）
//  Start(9)          → 界面: Enter；播放中: playpause
//  Back/Select(8)    → 界面: Escape
//  右摇杆左右         → 播放中: seek-back/seek-fwd（精细）
//  右摇杆上下         → 播放中: 音量±（暂不支持，走系统音量）

import { ipcRenderer } from 'electron';
import logger from '../core/logger';
import { HookType, registerHook } from '../core/hooks';

const log = logger;

// 边沿检测：上次按键状态（真按下/松开沿）
let prevButtons: boolean[] = [];
let prevAxes: number[] = [];
let polling = false;
let lastGamepadId: string | null = null;

// 检测手柄是否连接（Gamepad API：浏览器要求页面有交互后才暴露，但 preload 注入环境通常可用）
function getGamepads(): (Gamepad | null)[] {
    try {
        const nav = navigator as any;
        if (typeof nav.getGamepads === 'function') return nav.getGamepads();
    } catch { /* ignore */ }
    return [];
}

function padConnected(): boolean {
    return getGamepads().some((p) => p && p.connected);
}

/**
 * 向 document dispatch 键盘事件（界面导航）。
 * 防止事件被设置面板/输入框误吞：输入框聚焦时方向键应留给输入本身。
 */
function dispatchKey(code: string, key: string, repeat = false): void {
    const target = document.activeElement as HTMLElement | null;
    // 输入框聚焦时不劫持（文本输入需要方向键/退格）
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const opts: KeyboardEventInit = {
        key, code, bubbles: true, cancelable: true, repeat,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    // 部分框架监听 keyup（如 flyout 菜单），补发
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', opts)), 30);
}

/**
 * 播放控制：invoke media:control，返回是否被播放器处理（handled）。
 */
async function playerControl(action: string): Promise<boolean> {
    try {
        const r = await ipcRenderer.invoke('media:control', action);
        return !!(r && r.ok && r.handled);
    } catch (e: any) {
        log.warn('[gamepad] media:control 失败:', e?.message || e);
        return false;
    }
}

// 一次按键处理：先试播放控制（若在播放），未处理则走界面导航
let handling = false;
async function handlePadPress(kind: string, action: string, key: string, code: string): Promise<void> {
    if (handling) return;
    handling = true;
    try {
        const handled = await playerControl(action);
        if (!handled && key) dispatchKey(code, key);
    } finally {
        handling = false;
    }
}

/**
 * 轮询手柄状态（每 50ms）。做边沿检测：仅按钮/摇杆【从松开→按下】时触发一次。
 */
function poll(): void {
    const pads = getGamepads();
    const pad = pads.find((p) => p && p.connected) as any;
    if (!pad) return;

    // 按钮：boolean 或 {pressed}
    const btnStates: boolean[] = (pad.buttons || []).map((b: any) => (typeof b === 'boolean' ? b : !!(b && b.pressed)));
    const axes: number[] = (pad.axes || []).map((a: any) => {
        const v = typeof a === 'number' ? a : ((a && a.value) || 0);
        // 摇杆死区
        return Math.abs(v) < 0.35 ? 0 : v;
    });

    // —— 摇杆转方向键（连续触发，模拟按住）——
    const joyDead = 0.5;
    const joyUp = axes[1] !== undefined && axes[1] < -joyDead;
    const joyDown = axes[1] !== undefined && axes[1] > joyDead;
    const joyLeft = axes[0] !== undefined && axes[0] < -joyDead;
    const joyRight = axes[0] !== undefined && axes[0] > joyDead;
    // 右摇杆：播放中 seek（精细）；界面导航不映射右摇杆
    const rJoyLeft = axes[2] !== undefined && axes[2] < -joyDead;
    const rJoyRight = axes[2] !== undefined && axes[2] > joyDead;

    const isDpadDown = (i: number): boolean => !!(pad.buttons[i] && pad.buttons[i].pressed);

    // 优先按钮事件（一次触发）
    // A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, Back = 8, Start = 9
    const BTN = {
        A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
    };

    for (const [name, idx] of Object.entries(BTN)) {
        const pressed = btnStates[idx];
        const prev = prevButtons[idx];
        if (pressed && !prev) {
            // 刚按下
            switch (name) {
                case 'A':
                case 'START': handlePadPress('btn', 'playpause', 'Enter', 'Enter'); break;
                case 'B':
                case 'BACK': handlePadPress('btn', 'ignore', 'Escape', 'Escape'); break;
                case 'X': handlePadPress('btn', 'ignore', ' ', 'Space'); break;
                case 'Y': handlePadPress('btn', 'next', '', ''); break;
                case 'LB': handlePadPress('btn', 'seek-back', 'PageUp', 'PageUp'); break;
                case 'RB': handlePadPress('btn', 'seek-fwd', 'PageDown', 'PageDown'); break;
                case 'LT': handlePadPress('btn', 'speed-down', '', ''); break;
                case 'RT': handlePadPress('btn', 'speed-up', '', ''); break;
            }
        }
    }

    // 十字键：按下沿触发一次（模拟方向键 / 播放中 seek）
    const dpad = {
        up: isDpadDown(12), down: isDpadDown(13), left: isDpadDown(14), right: isDpadDown(15),
    };
    if (dpad.left && !prevButtons[14]) handlePadPress('dpad', 'seek-back', 'ArrowLeft', 'ArrowLeft');
    if (dpad.right && !prevButtons[15]) handlePadPress('dpad', 'seek-fwd', 'ArrowRight', 'ArrowRight');
    if (dpad.up && !prevButtons[12]) handlePadPress('dpad', 'ignore', 'ArrowUp', 'ArrowUp');
    if (dpad.down && !prevButtons[13]) handlePadPress('dpad', 'ignore', 'ArrowDown', 'ArrowDown');

    // 左摇杆方向（边沿：仅从 0 → 非 0 触发一次，避免持续抖动）
    if (joyUp && prevAxes[1] === 0) handlePadPress('joy', 'ignore', 'ArrowUp', 'ArrowUp');
    if (joyDown && prevAxes[1] === 0) handlePadPress('joy', 'ignore', 'ArrowDown', 'ArrowDown');
    if (joyLeft && prevAxes[0] === 0) handlePadPress('joy', 'seek-back', 'ArrowLeft', 'ArrowLeft');
    if (joyRight && prevAxes[0] === 0) handlePadPress('joy', 'seek-fwd', 'ArrowRight', 'ArrowRight');

    // 右摇杆左右：播放中 seek（仅在播放器处理时生效）
    if (rJoyLeft && prevAxes[2] === 0) { playerControl('seek-back'); }
    if (rJoyRight && prevAxes[2] === 0) { playerControl('seek-fwd'); }

    prevButtons = btnStates;
    prevAxes = axes;
}

/**
 * 启动手柄轮询（幂等）。放在 OnReady 钩子里执行，但轮询本身独立于 DOM。
 */
function startGamepad(): void {
    if (polling) return;
    try {
        const nav = navigator as any;
        if (typeof nav.getGamepads !== 'function') {
            log.warn('[gamepad] 当前环境不支持 Gamepad API，手柄功能不可用');
            return;
        }
        polling = true;
        // 连接事件（辅助日志）
        nav.addEventListener?.('gamepadconnected', (e: any) => {
            log.info('[gamepad] 手柄已连接:', e.gamepad?.id || '(unknown)');
        });
        nav.addEventListener?.('gamepaddisconnected', () => {
            log.info('[gamepad] 手柄已断开');
        });
        setInterval(poll, 50);
        log.info('[gamepad] 手柄轮询已启动（每 50ms）');
    } catch (e: any) {
        log.warn('[gamepad] 启动手柄轮询失败:', e?.message || e);
    }
}

// [lc-404 铁律] registerHook 放模块顶层、尽量靠前；OnReady 回调内不做模块级抛错
try {
    registerHook(HookType.OnReady, () => {
        try {
            startGamepad();
        } catch (e: any) {
            log.warn('[gamepad] 初始化失败:', e?.message || e);
        }
    });
} catch (e: any) {
    // 极早期环境（hooks 未就绪）——降级：DOMContentLoaded 后启动
    const boot = () => {
        try { startGamepad(); } catch { /* ignore */ }
    };
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
}
