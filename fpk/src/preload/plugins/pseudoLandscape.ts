// preload/plugins/pseudoLandscape.ts
//
// [lc-1334] 自建「伪横屏全屏」——不再依赖 xgplayer 的 fullscreen 插件 / React fiber。
//
// 为什么要自己来（真机 MuMu + flutter_inappwebview + Android WebView 110 实测）：
//   点底栏全屏按钮 → **进了原生全屏（画面铺满视口、BACK 可退出）但没转横屏**。
//   原生全屏是插件自己调的 document.requestFullscreen ⇒ 说明「按 fiber 改插件 config」
//   那条链在该环境里没生效（fiber 取不到 player 时我们静默 no-op，表现就是「全屏了但不横」）。
//   用户明确要求：「伪全屏模式，能不能我们自己改 ui，改成横屏」→ 改为页面内自己转：
//     · 捕获阶段拦 .xgplayer-fullscreen 的 click/touchend（preventDefault + stopPropagation）
//       —— 必须 stopPropagation 才能挡住绑在按钮上的处理器，原生全屏不再进入；
//     · 给播放器根节点加 **xgplayer 自己的类名** xgplayer-rotate-fullscreen：
//       我们既有的 rotate CSS（fixed 居中 + rotate(90deg) + height:100vw）原样生效；
//       另按 xgplayer getRotateFullscreen 的口径写行内 width = innerHeight；
//     · 弹幕画布 #fntv-danmaku-canvas 一起转（transform:rotate(90deg)；syncCanvasRect
//       只写 left/top/width/height、不碰 transform，不会被覆盖）→ 弹幕与画面同向；
//     · 再点同一个按钮即退出（还原行内尺寸 / 类名 / 画布旋转）。
//
// 只处理「触摸 + 竖屏 + 横向内容」：横屏设备、桌面、竖向内容都不转（与 xgplayer 原生
// lockScreen 的 aspectRatio>1 同口径）。桌面/鼠标环境仍走原来的原生分派（见 danmakuWeb）。

import logger from '../core/logger';

const log = logger;

/** 复用 xgplayer 自己的旋转类名：我们的 rotate CSS 与它的语义都认这个名字 */
const ROT_CLASS = 'xgplayer-rotate-fullscreen';
/** 根节点上的状态标记（判断是否处于我们自建的伪横屏） */
const STATE_ATTR = 'data-fntv-pseudo-rot';
/** html 上的门控（本轮只用于锁滚动；rotate 样式仍由 :has(类名) 触发） */
const HTML_CLASS = 'fntv-pseudo-rot';
/** 画布旋转类 */
const CANVAS_CLASS = 'fntv-dm-rotate';
const CANVAS_ID = 'fntv-danmaku-canvas';

/** 由 danmakuWeb 注入（避免两个模块循环 import）：拿当前播放器实例，仅用于尽力同步内部状态 */
let _resolve: (() => { player: any; fs: any } | null) | null = null;
export function setPlayerResolver(fn: (() => { player: any; fs: any } | null) | null): void {
    _resolve = fn;
}

function playerRoot(): HTMLElement | null {
    try {
        const v = document.querySelector('video');
        const byVideo = v && (v.closest('.xgplayer') || v.closest('[class*=xgplayer]'));
        if (byVideo) return byVideo as HTMLElement;
        return (document.querySelector('.xgplayer') as HTMLElement)
            || (document.querySelector('[class*=xgplayer]') as HTMLElement);
    } catch { return null; }
}

function canvasEl(): HTMLElement | null {
    try { return document.getElementById(CANVAS_ID); } catch { return null; }
}

/** 是否处于我们自建的伪横屏 */
export function isPseudoLandscape(): boolean {
    return !!document.querySelector('[' + STATE_ATTR + '="1"]');
}

/** 进入伪横屏。返回 false = 环境不满足（找不到播放器根节点），调用方回退到原生分派 */
export function enterPseudoLandscape(): boolean {
    const root = playerRoot();
    if (!root) return false;
    if (root.getAttribute(STATE_ATTR) === '1') return true;
    root.setAttribute(STATE_ATTR, '1');
    // 行内尺寸备份（退出时还原；xgplayer 自己也只写 width，这里两个都存以防站点改过）
    root.setAttribute('data-fntv-rot-w', root.style.width || '');
    root.setAttribute('data-fntv-rot-h', root.style.height || '');
    root.classList.add(ROT_CLASS);
    // 与 xgplayer getRotateFullscreen 同口径：竖屏时行内 width = innerHeight（height 由 CSS 给 100vw）
    root.style.width = window.innerHeight + 'px';
    const c = canvasEl();
    if (c) c.classList.add(CANVAS_CLASS);
    try { document.documentElement.classList.add(HTML_CLASS); } catch { /* ignore */ }
    // 尽力同步播放器内部状态：rotateDeg 让进度条拖拽的坐标映射也按旋转后的轴向走；
    // fullscreen 让按钮图标/文案切成「退出全屏」。取不到实例不影响显示。
    try {
        const cur = _resolve ? _resolve() : null;
        if (cur && cur.player) {
            cur.player.rotateDeg = 90;
            cur.player.fullscreen = true;
        }
    } catch { /* ignore */ }
    log.info('[pseudoLandscape] 进入伪横屏（自建，不依赖插件 config）');
    return true;
}

/** 退出伪横屏并还原现场（幂等） */
export function exitPseudoLandscape(): void {
    let root: HTMLElement | null = null;
    try { root = document.querySelector('[' + STATE_ATTR + '="1"]') as HTMLElement | null; } catch { /* ignore */ }
    if (root) {
        root.classList.remove(ROT_CLASS);
        root.style.width = root.getAttribute('data-fntv-rot-w') || '';
        root.style.height = root.getAttribute('data-fntv-rot-h') || '';
        root.removeAttribute(STATE_ATTR);
        root.removeAttribute('data-fntv-rot-w');
        root.removeAttribute('data-fntv-rot-h');
    }
    const c = canvasEl();
    if (c) c.classList.remove(CANVAS_CLASS);
    try { document.documentElement.classList.remove(HTML_CLASS); } catch { /* ignore */ }
    try {
        const cur = _resolve ? _resolve() : null;
        if (cur && cur.player) { cur.player.rotateDeg = 0; cur.player.fullscreen = false; }
    } catch { /* ignore */ }
    log.info('[pseudoLandscape] 退出伪横屏');
}

/** 切换（点同一个按钮即开/关）。返回 false = 进不去（环境不满足） */
export function togglePseudoLandscape(): boolean {
    if (isPseudoLandscape()) { exitPseudoLandscape(); return true; }
    return enterPseudoLandscape();
}

/** 离开播放页时清场（SPA 切走 / 播放器被销毁） */
export function cleanupPseudoLandscape(): void {
    if (isPseudoLandscape()) exitPseudoLandscape();
    try { document.documentElement.classList.remove(HTML_CLASS); } catch { /* ignore */ }
}

export {};