// preload/plugins/gamepad.ts
// [lc-655][lc-656] 手柄控制（电脑/电视大屏场景，手柄当遥控器）。
//
// 两层控制：
//  1. 播放中：手柄按键 → IPC media:control → 主进程 controlCurrentPlayer()
//  2. 界面导航（无播放器在播）：手柄按键 → dispatch 键盘事件到 document
//     （方向键/Enter/Escape，fnOS 原生页面自动响应列表滚动与按钮聚焦）
//
// 判定逻辑：按键时先 invoke media:control，返回 handled=true 说明有播放器在处理
// → 走播放控制；handled=false 则回退为界面导航键。
//
// [lc-656] 配置驱动：用户可在设置面板「手柄设置」页自定义按键映射，
// 配置存 localStorage['fntvGamepad.config']（JSON），并监听 fntv-gamepad-config-changed
// 事件热刷新。未配置时使用内置默认映射。

import { ipcRenderer } from 'electron';
import logger from '../core/logger';
import { HookType, registerHook } from '../core/hooks';
import { focusNav } from './gamepadFocus';

const log = logger;

// ===== 按键名常量（Xbox 布局标准映射，与按钮索引一致）=====
export const PAD_BTN = {
    A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
} as const;
export type PadBtnName = keyof typeof PAD_BTN;

// ===== 可配置功能项定义 =====
// playAction: 播放中触发的主进程控制动作（无则 null）
// navKey/navCode: 界面导航触发的键盘事件（无则 null）
// label: 设置面板显示名
export interface GamepadFuncDef {
    id: string;
    label: string;
    defaultBtn: PadBtnName;
    playAction: string | null;
    navKey: string | null;
    navCode: string | null;
}

export const GAMEPAD_FUNCS: GamepadFuncDef[] = [
    { id: 'playPause',  label: '播放 / 暂停', defaultBtn: 'A',     playAction: 'playpause', navKey: 'Enter', navCode: 'Enter' },
    { id: 'seekBack',   label: '快退 (5s)',    defaultBtn: 'LB',    playAction: 'seek-back', navKey: 'PageUp', navCode: 'PageUp' },
    { id: 'seekFwd',    label: '快进 (5s)',    defaultBtn: 'RB',    playAction: 'seek-fwd',  navKey: 'PageDown', navCode: 'PageDown' },
    { id: 'speedDown',  label: '倍速 -',       defaultBtn: 'LT',    playAction: 'speed-down', navKey: null, navCode: null },
    { id: 'speedUp',    label: '倍速 +',       defaultBtn: 'RT',    playAction: 'speed-up',  navKey: null, navCode: null },
    { id: 'next',       label: '下一集',       defaultBtn: 'Y',     playAction: 'next',     navKey: null, navCode: null },
    { id: 'navBack',    label: '返回 / 关闭',  defaultBtn: 'B',     playAction: null,       navKey: 'Escape', navCode: 'Escape' },
    { id: 'navSelect',  label: '勾选 / 开关',  defaultBtn: 'X',     playAction: null,       navKey: ' ', navCode: 'Space' },
];

// ===== 配置读写 =====
export interface GamepadConfig {
    enabled: boolean;
    // 功能 id -> 按键名；未配置的功能用默认
    bindings: Partial<Record<string, PadBtnName>>;
}

const CONFIG_KEY = 'fntvGamepad.config';
const CONFIG_EVT = 'fntv-gamepad-config-changed';

function defaultConfig(): GamepadConfig {
    const bindings: GamepadConfig['bindings'] = {};
    for (const f of GAMEPAD_FUNCS) bindings[f.id] = f.defaultBtn;
    return { enabled: true, bindings };
}

function loadConfig(): GamepadConfig {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return defaultConfig();
        const parsed = JSON.parse(raw) as GamepadConfig;
        const cfg = defaultConfig();
        if (typeof parsed.enabled === 'boolean') cfg.enabled = parsed.enabled;
        if (parsed.bindings && typeof parsed.bindings === 'object') {
            for (const id of GAMEPAD_FUNCS.map(f => f.id)) {
                const b = parsed.bindings[id] as PadBtnName | undefined;
                if (b && typeof PAD_BTN[b] === 'number') cfg.bindings[id] = b;
            }
        }
        return cfg;
    } catch { return defaultConfig(); }
}

// 缓存配置，事件触发时刷新
let config: GamepadConfig = loadConfig();

// 功能 id → 默认/用户绑定的按键名（查询表，供设置面板预览与运行时查表）
export function getConfig(): GamepadConfig { return config; }

/**
 * [lc-656] 供设置面板调用的配置 API（通过 window.fntvGamepad 全局暴露）。
 * saveConfig: 保存并广播刷新；resetConfig: 恢复默认。
 */
export function saveConfig(next: GamepadConfig): void {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(CONFIG_EVT));
    config = loadConfig();
    funcIndex = buildIndex(config);
}
export function resetConfig(): void {
    try { localStorage.removeItem(CONFIG_KEY); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(CONFIG_EVT));
    config = loadConfig();
    funcIndex = buildIndex(config);
}

// 暴露到 window，供设置面板（embyWall）读取/保存；避免插件间直接 import
try {
    (window as any).fntvGamepad = {
        funcs: GAMEPAD_FUNCS,
        getConfig: () => getConfig(),
        saveConfig,
        resetConfig,
    };
} catch { /* ignore */ }

// ===== 运行时：按键 → 功能 反向索引 =====
// key: 键名（'A','LB'...）→ funcs[]
interface FuncHit { playAction: string | null; navKey: string | null; navCode: string | null; }
function buildIndex(cfg: GamepadConfig): Map<string, FuncHit[]> {
    const idx = new Map<string, FuncHit[]>();
    for (const f of GAMEPAD_FUNCS) {
        const btn = cfg.bindings[f.id] || f.defaultBtn;
        const hit: FuncHit = { playAction: f.playAction, navKey: f.navKey, navCode: f.navCode };
        const arr = idx.get(btn) || [];
        arr.push(hit);
        idx.set(btn, arr);
    }
    return idx;
}
let funcIndex = buildIndex(config);

// 边沿检测：上次按键状态
let prevButtons: boolean[] = [];
let prevAxes: number[] = [];
let polling = false;
// [lc-667] 方向长按重复（焦点导航连移）+ 手柄检测诊断
let heldDir: 'up' | 'down' | 'left' | 'right' | null = null;
let dirFirstAt = 0;
let dirLastRepeat = 0;
let lastNoPadLog = 0;
let padLogged = false;

// 检测手柄是否连接（Gamepad API：浏览器要求页面有交互后才暴露，但 preload 注入环境通常可用）
function getGamepads(): (Gamepad | null)[] {
    try {
        const nav = navigator as any;
        if (typeof nav.getGamepads === 'function') return nav.getGamepads();
    } catch { /* ignore */ }
    return [];
}

/**
 * 向 document dispatch 键盘事件（界面导航）。
 * 防止事件被设置面板/输入框误吞：输入框聚焦时方向键应留给输入本身。
 */
function dispatchKey(code: string, key: string, repeat = false): void {
    const target = document.activeElement as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const opts: KeyboardEventInit = {
        key, code, bubbles: true, cancelable: true, repeat,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
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
async function handleFuncHit(hit: FuncHit): Promise<void> {
    if (handling) return;
    handling = true;
    try {
        if (hit.playAction) {
            const handled = await playerControl(hit.playAction);
            if (!handled && hit.navKey) {
                if (tryFocusAction(hit.navKey)) return;
                dispatchKey(hit.navCode || hit.navKey, hit.navKey);
            }
        } else if (hit.navKey) {
            if (tryFocusAction(hit.navKey)) return;
            dispatchKey(hit.navCode || hit.navKey, hit.navKey);
        }
    } finally {
        handling = false;
    }
}

/**
 * [lc-667] A(Enter)→焦点确认(模拟点击)；B(Escape)→返回/关闭。
 * 返回 true 表示已由焦点导航消费，调用方无需再 dispatch 键盘事件。
 * [lc-674] 修复「侧边栏展开时 B 键返回失效」：旧逻辑在白框激活时 back() 只
 * hide() 并吞掉 Escape，抽屉/弹窗收不回去。现在无论白框是否激活，关闭白框后
 * 都把 Escape 派发给页面，由 fnOS 原生逻辑关闭抽屉/弹窗/返回导航
 * （用户连续按 B 返回根目录本就依赖这个 Escape 派发）。
 */
function tryFocusAction(navKey: string): boolean {
    if (navKey === 'Enter') return focusNav.select();
    if (navKey === 'Escape') {
        focusNav.back();
        dispatchKey('Escape', 'Escape');
        return true;
    }
    return false;
}

/**
 * 轮询手柄状态（每 50ms）。做边沿检测：仅按钮【从松开→按下】时触发一次。
 */
function poll(): void {
    if (!config.enabled) return;
    const pads = getGamepads();
    const pad = pads.find((p) => p && p.connected) as any;
    if (!pad) {
        // [lc-667] 诊断：手柄未检测到时每 5s 提醒一次（避免用户以为功能坏了）
        if (Date.now() - lastNoPadLog > 5000) {
            lastNoPadLog = Date.now();
            log.warn('[gamepad] 未检测到手柄（getGamepads 为空）——请确认手柄已连接，并在窗口内按任意键激活');
        }
        prevButtons = [];
        prevAxes = [];
        heldDir = null;
        return;
    }
    if (!padLogged) {
        padLogged = true;
        log.info(`[gamepad] 检测到手柄: ${pad.id} buttons=${(pad.buttons || []).length} axes=${(pad.axes || []).length}`);
    }

    const btnStates: boolean[] = (pad.buttons || []).map((b: any) => (typeof b === 'boolean' ? b : !!(b && b.pressed)));
    // [lc-669] 降低死区(0.30)/方向阈值(0.40)：轻推摇杆也能触发
    const axes: number[] = (pad.axes || []).map((a: any) => {
        const v = typeof a === 'number' ? a : ((a && a.value) || 0);
        return Math.abs(v) < 0.30 ? 0 : v;
    });

    const joyDead = 0.40;
    const joyUp = axes[1] !== undefined && axes[1] < -joyDead;
    const joyDown = axes[1] !== undefined && axes[1] > joyDead;
    const joyLeft = axes[0] !== undefined && axes[0] < -joyDead;
    const joyRight = axes[0] !== undefined && axes[0] > joyDead;

    // 按钮按下沿：查反向索引执行对应功能
    for (const [name, idx] of Object.entries(PAD_BTN)) {
        const pressed = btnStates[idx];
        const prev = prevButtons[idx];
        if (pressed && !prev) {
            const hits = funcIndex.get(name);
            if (hits) for (const h of hits) handleFuncHit(h);
        }
    }

    // [lc-669] 方向输入——关键修复：恢复「边沿检测」。
    //   lc-667 重写时把十字键/摇杆并入 activeDir 却丢了边沿，导致按住期间每 50ms 重复 move
    //   → 十字键不能精准一个一跳、摇杆要很轻地"点"一下才单跳。
    //   现在：十字键=按下沿(prevButtons false→true)，摇杆=轴从 0→非0 沿(prevAxes)，只触发一次；
    //   长按 >320ms 后每 130ms 才进入连跳（仅焦点模式）。
    const isDpadDown = (i: number): boolean => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const dpadUp = isDpadDown(12), dpadDown = isDpadDown(13), dpadLeft = isDpadDown(14), dpadRight = isDpadDown(15);

    const edgeDir: 'up' | 'down' | 'left' | 'right' | null =
        ((dpadUp && !prevButtons[12]) || (joyUp && prevAxes[1] === 0)) ? 'up' :
        ((dpadDown && !prevButtons[13]) || (joyDown && prevAxes[1] === 0)) ? 'down' :
        ((dpadLeft && !prevButtons[14]) || (joyLeft && prevAxes[0] === 0)) ? 'left' :
        ((dpadRight && !prevButtons[15]) || (joyRight && prevAxes[0] === 0)) ? 'right' : null;
    if (edgeDir) dirInput(edgeDir);

    // 当前按住的方向（用于长按连跳）
    const activeDir: 'up' | 'down' | 'left' | 'right' | null =
        (joyUp || dpadUp) ? 'up' :
        (joyDown || dpadDown) ? 'down' :
        (joyLeft || dpadLeft) ? 'left' :
        (joyRight || dpadRight) ? 'right' : null;

    if (activeDir) {
        const now = Date.now();
        if (heldDir !== activeDir) { heldDir = activeDir; dirFirstAt = now; dirLastRepeat = 0; }
        if (focusNav.isActive() && now - dirFirstAt > 320 && now - dirLastRepeat > 130) {
            dirLastRepeat = now;
            focusNav.move(activeDir);
        }
    } else {
        heldDir = null;
    }

    prevButtons = btnStates;
    prevAxes = axes;
}

/**
 * [lc-667] 一次方向输入：焦点框已激活 → 直接移动；
 * 未激活时：左/右先试播放 seek（在播则让给播放器），否则激活/移动焦点框。
 */
function dirInput(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (focusNav.isActive()) {
        focusNav.move(dir);
        return;
    }
    if (dir === 'left' || dir === 'right') {
        playerControl(dir === 'left' ? 'seek-back' : 'seek-fwd').then((handled) => {
            if (!handled) focusNav.move(dir);
        });
        return;
    }
    focusNav.move(dir); // 上/下 → 直接进入焦点导航（激活白框）
}

// 十字键左/右 与 左摇杆左右：播放中 seek；未播放走界面方向键
// [lc-667] 已由 dirInput() 替代（统一走焦点导航），此函数移除。


/**
 * 启动手柄轮询（幂等）。
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
        nav.addEventListener?.('gamepadconnected', (e: any) => {
            log.info('[gamepad] 手柄已连接:', e.gamepad?.id || '(unknown)');
        });
        nav.addEventListener?.('gamepaddisconnected', () => {
            log.info('[gamepad] 手柄已断开');
        });
        // [lc-656] 监听配置变更热刷新
        window.addEventListener(CONFIG_EVT, () => {
            config = loadConfig();
            funcIndex = buildIndex(config);
            log.info('[gamepad] 配置已刷新:', config.enabled ? '启用' : '停用');
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
    const boot = () => {
        try { startGamepad(); } catch { /* ignore */ }
    };
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
}
