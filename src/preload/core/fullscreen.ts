// preload/core/fullscreen.ts
//
// [lc-1164] 全屏层识别 —— 供「在页面之上自绘图层」的插件共用（danmakuWeb 的弹幕画布、
// danmakuHeat 的高能进度条）。两插件刻意不互相 import，故这类判定抽到 core 作共享工具。
//
// 起因（用户报障：飞牛原生网页播放点右下角全屏后弹幕整层不显示）：
// 自绘层都是挂在 body 下的 position:fixed 元素，而全屏时整个播放器被抬成独立的层叠/渲染子树：
//   · xgplayer 伪全屏（飞牛多数情况）→ .xgplayer 被设成 fixed + 高 z-index，
//     body 下 z-index 只有个位数(弹幕 5 / 高能条 6)的自绘层被整块盖住：内容照常绘制，就是看不见；
//   · 浏览器原生全屏 → 浏览器只渲染「全屏元素」子树，与它平级的 body 子节点根本不在渲染树里。
// 两种成因指向同一个修法：**把自绘层搬进全屏层内部**。
// 搬家后相对层级关系不变（全屏层内部同样没人跟它抢），坐标也不必重算 ——
// 全屏层铺满视口且不含 transform/filter/contain 时，fixed 的包含块仍然是视口。

/**
 * 返回当前的全屏层元素；不在全屏状态返回 null（调用方回落到 document.body）。
 *
 * 判据三层，从可靠到兜底：
 *   ① `document.fullscreenElement`（原生全屏，最权威）。为 documentElement(html) / body 时不算 ——
 *      那时 body 原本就在它的子树里，自绘层挂 body 照样在渲染树内，不需要搬。
 *   ② xgplayer 的 `xgplayer-fullscreen` / `xgplayer-cssfullscreen` class（lc-552 的实测结论：
 *      xgplayer 进出伪全屏时会自己增删该 class，比任何尺寸推测都可靠）。
 *   ③ 兜底启发式：从 video 往上找 `position:fixed` 且几乎铺满视口的祖先。
 *      阈值取 97% 而不是 90% 是有意的 —— 飞牛页面容器常写成 `fixed;top:32px;bottom:0`（顶部导航
 *      安全区），高度≈vh-32px，1080p 屏上就有 97%+，按 90% 判会把「非全屏的普通播放页」误判成全屏。
 *      而**误判本身无害**：能被选中就说明 video 在它内部，自绘层搬进去不会更糟，也不会错位
 *      （见文件头：fixed 坐标不受搬家影响）。真全屏若用的是别家 class 名，也就靠这一层兜住。
 *
 * @param video 当前播放的 video 元素（可选；用于第 ③ 层从 DOM 上溯）。缺省时函数只看 ①② 两层。
 */
export function fullscreenHost(video?: HTMLVideoElement | null): HTMLElement | null {
    const fs = document.fullscreenElement as HTMLElement | null;
    if (fs && fs !== document.documentElement && fs !== document.body) return fs;

    const byClass = document.querySelector(
        '.xgplayer.xgplayer-fullscreen, .xgplayer.xgplayer-cssfullscreen'
    ) as HTMLElement | null;
    if (byClass) return byClass;

    if (!video || !video.isConnected) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let host: HTMLElement | null = null;
    for (let el = video.parentElement; el && el !== document.body; el = el.parentElement) {
        // 用 getComputedStyle 而非 offsetParent：fixed 元素的 offsetParent 恒为 null，判不出结果
        if (getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.97 && r.height >= vh * 0.97) host = el;  // 继续往上：取最外层那个
    }
    return host;
}

export default fullscreenHost;
