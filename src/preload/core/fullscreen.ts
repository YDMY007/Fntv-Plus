// preload/core/fullscreen.ts
//
// [lc-1165] 全屏层识别 —— 供「在页面之上自绘图层」的插件共用（danmakuWeb 的弹幕画布、
// danmakuHeat 的高能进度条）。**实现抄自 Fntv-Plus-fpk web 端**（danmakuWeb v1.9.0 的
// fullscreenHost，fpk/src/preload/plugins/danmakuWeb.ts），行为保持逐字一致 —— fpk web
// 端已实测解决「全屏后弹幕不显示」，不要自作聪明加判据。
//
// 背景：自绘层挂在 body 下 position:fixed，全屏时播放器被抬成独立渲染子树——
//   · xgplayer 伪全屏：.xgplayer 被提到 fixed + 极高 z-index，body 下画布被整块盖住；
//   · 原生全屏：浏览器只渲染全屏元素子树，body 的子节点不在渲染树里。
// 修法在各自插件里：把画布物理搬进全屏容器内、定位改 absolute（见 danmakuWeb.ensureCanvasHost）。
//
// ⚠ 性能红线：这里**只做** O(1) 属性读取 + 一次 querySelector，每帧级调用都扛得住。
//   不要加「沿 video 祖先链跑 getComputedStyle 找 fixed 铺满视口的容器」之类的启发式 ——
//   lc-1164 试过：渲染循环里每 30 帧强制 style+layout，且 97% 覆盖率在临界值上抖动导致
//   画布反复搬移重绘，实测直接把全屏播放卡爆（用户报「非常卡顿」）。

/** 全屏容器：原生 fullscreenElement 优先，其次 xgplayer 伪全屏根。不在全屏返回 null。 */
export function fullscreenHost(): HTMLElement | null {
    const native = document.fullscreenElement as HTMLElement | null;
    if (native) return native;
    const pseudo = document.querySelector<HTMLElement>('.xgplayer.xgplayer-fullscreen');
    return pseudo;
}

export default fullscreenHost;
