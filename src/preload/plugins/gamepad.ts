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
            if (!handled && hit.navKey) dispatchKey(hit.navCode || hit.navKey, hit.navKey);
        } else if (hit.navKey) {
            dispatchKey(hit.navCode || hit.navKey, hit.navKey);
        }
    } finally {
        handling = false;
    }
}

/**
 * 轮询手柄状态（每 50ms）。做边沿检测：仅按钮【从松开→按下】时触发一次。
 */
function poll(): void {
    if (!config.enabled) return;
    const pads = getGamepads();
    const pad = pads.find((p) => p && p.connected) as any;
    if (!pad) return;

    const btnStates: boolean[] = (pad.buttons || []).map((b: any) => (typeof b === 'boolean' ? b : !!(b && b.pressed)));
    const axes: number[] = (pad.axes || []).map((a: any) => {
        const v = typeof a === 'number' ? a : ((a && a.value) || 0);
        return Math.abs(v) < 0.35 ? 0 : v;
    });

    const joyDead = 0.5;
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

    // 十字键：方向（上/下固定走界面导航，左/右播放中 seek）
    const isDpadDown = (i: number): boolean => !!(pad.buttons[i] && pad.buttons[i].pressed);
    if (isDpadDown(12) && !prevButtons[12]) dispatchKey('ArrowUp', 'ArrowUp');
    if (isDpadDown(13) && !prevButtons[13]) dispatchKey('ArrowDown', 'ArrowDown');
    if (isDpadDown(14) && !prevButtons[14]) handlePadSeekOrNav('seek-back', 'ArrowLeft', 'ArrowLeft');
    if (isDpadDown(15) && !prevButtons[15]) handlePadSeekOrNav('seek-fwd', 'ArrowRight', 'ArrowRight');

    // 左摇杆方向（边沿：仅从 0 → 非 0 触发一次）
    if (joyUp && prevAxes[1] === 0) dispatchKey('ArrowUp', 'ArrowUp');
    if (joyDown && prevAxes[1] === 0) dispatchKey('ArrowDown', 'ArrowDown');
    if (joyLeft && prevAxes[0] === 0) handlePadSeekOrNav('seek-back', 'ArrowLeft', 'ArrowLeft');
    if (joyRight && prevAxes[0] === 0) handlePadSeekOrNav('seek-fwd', 'ArrowRight', 'ArrowRight');

    prevButtons = btnStates;
    prevAxes = axes;
}

// 十字键左/右 与 左摇杆左右：播放中 seek；未播放走界面方向键
async function handlePadSeekOrNav(playAction: string, navKey: string, navCode: string): Promise<void> {
    if (handling) return;
    handling = true;
    try {
        const handled = await playerControl(playAction);
        if (!handled) dispatchKey(navCode, navKey);
    } finally {
        handling = false;
    }
}

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
