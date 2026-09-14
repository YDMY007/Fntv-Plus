import { registerHook, HookType } from '../core/hooks';
import { fullscreenHost } from '../core/fullscreen';

// danmakuHeat.ts — [lc-1070] 弹幕高能进度条（对标 B站）
// 在 xgplayer 进度条上方叠加弹幕密度热力条：
//   · 数据：danmakuWeb 拉到弹幕后派发 'fntv:danmaku-items'（detail.times），本插件监听取用。
//     旧版是包一层 ipcRenderer.invoke 抓 'danmaku:prepare' 的响应，有两个死穴：
//       ① lc-1015 之后 prepare 由 play/info **预取**触发，那一刻 video 还没有 metadata，
//          duration 恒为 0 → density 永远算不出来；
//       ② 会话 LRU 命中时根本不走 IPC → 首集/切回来的那一集恒不显示。
//     改成事件后：times 先存下，duration 就绪了再算（2s 轮询里补算），两条加载路径都覆盖。
//   · 聚合：按视频时长等分桶统计密度
//   · 渲染：canvas 热力条（透明→靛蓝渐变），pointer-events:none
//   · 可见性：单函 updateHeat() 统一管定位+可见性+绘制（弹幕开关关/无数据→隐藏）
// 独立于 danmakuWeb.ts（不 import 它），只读它的 localStorage 开关与自定义事件。

const HEAT_ID = 'fntv-danmaku-heat';
// ⚠️ 必须与 danmakuWeb.ts 的 LS_KEY 逐字一致。旧版写成 'fntv-danmaku'，与真实键
// 'fntv_danmaku_enabled' 不符 → 读到的永远是 null，热力条完全无视弹幕开关。
const LS_KEY = 'fntv_danmaku_enabled';
const ITEMS_EVENT = 'fntv:danmaku-items';

let heatCanvas: HTMLCanvasElement | null = null;
let heatCtx: CanvasRenderingContext2D | null = null;
let density: number[] = [];
// 拿到 times 但 video 还没有 duration 时先存着，等轮询补算
let pendingTimes: number[] | null = null;

// ── 密度聚合 ──
function aggregate(times: number[], duration: number): number[] {
    const bins = Math.max(30, Math.min(240, Math.round(duration / 2)));
    const arr = new Array(bins).fill(0);
    for (const t of times) {
        const idx = Math.min(bins - 1, Math.max(0, Math.floor((t / duration) * bins)));
        arr[idx]++;
    }
    return arr;
}

function videoDuration(): number {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    const d = v ? v.duration : 0;
    return (d && isFinite(d) && d > 0) ? d : 0;
}

// ── 热力条绘制 ──
function drawHeat(): void {
    if (!heatCtx || !heatCanvas) return;
    const w = heatCanvas.width;
    const h = heatCanvas.height;
    heatCtx.clearRect(0, 0, w, h);
    if (!density.length) return;
    const max = Math.max(...density, 1);
    const binW = w / density.length;
    for (let i = 0; i < density.length; i++) {
        if (density[i] === 0) continue;
        const ratio = density[i] / max;
        const alpha = 0.12 + ratio * 0.72;
        heatCtx.fillStyle = `rgba(109, 127, 242, ${alpha.toFixed(2)})`;
        heatCtx.fillRect(i * binW, h * (1 - ratio * 0.85), Math.max(1, binW - 0.5), h * ratio * 0.85);
    }
}

// ── 热力条 DOM ──
function ensureHeatCanvas(): void {
    if (heatCanvas || !document.body) return;
    const c = document.createElement('canvas');
    c.id = HEAT_ID;
    c.style.cssText = 'position:fixed;z-index:6;pointer-events:none;display:none;';
    document.body.appendChild(c);
    heatCanvas = c;
    heatCtx = c.getContext('2d');
}

// [lc-1164] 全屏时高能条必须跟着搬家：它和弹幕画布一样是挂在 body 下的固定定位画布(z-index:6)，
// 不搬就会被 xgplayer 的全屏层整块盖住 —— 正是「点右下角全屏后弹幕/高能条全不见」的同一个坑。
// 全屏层判定与坐标系说明见 core/fullscreen.ts（两插件共用，互不 import）。
// ⚠ 带 250ms 节流：updateHeat 挂在 OnDomChange 上(起播期 DOM 变动风暴会高频进来)，而全屏层
//   判定要沿 video 祖先链跑 getComputedStyle —— 不节流就是每次 DOM 变动都白算一遍。
//   force=true 绕过节流，专供全屏事件(进/出全屏必须立即生效)。
let _lastHostCheck = 0;
function syncHeatHost(force = false): void {
    if (!heatCanvas || !document.body) return;
    const now = performance.now();
    if (!force && now - _lastHostCheck < 250) return;
    _lastHostCheck = now;
    // 画布若挂在已销毁的旧全屏容器里，parentElement 还指向游离节点 → 判定必然不等 → 重挂自愈
    const host = fullscreenHost() || document.body;
    if (heatCanvas.parentElement !== host) host.appendChild(heatCanvas);
}

// ── 定位：贴在 xgplayer 进度条上方 ──
function positionHeatBar(): void {
    if (!heatCanvas) return;
    syncHeatHost();
    const bar = document.querySelector('[class*="xgplayer-progress"], [class*="xg-progress"]') as HTMLElement | null;
    if (!bar || !bar.offsetHeight || !bar.offsetWidth) { heatCanvas.style.display = 'none'; return; }
    const r = bar.getBoundingClientRect();
    heatCanvas.style.display = 'block';
    heatCanvas.style.left = r.left + 'px';
    heatCanvas.style.top = (r.top - 12) + 'px';
    heatCanvas.style.width = r.width + 'px';
    heatCanvas.style.height = '8px';
    heatCanvas.width = Math.round(r.width);
    heatCanvas.height = 8;
}

// ── 单一 update：补算 + 定位 + 可见性 + 绘制 ──
function updateHeat(): void {
    ensureHeatCanvas();
    if (!heatCanvas) return;
    let danmakuOn = true;
    try { danmakuOn = localStorage.getItem(LS_KEY) !== '0'; } catch { /* ignore */ }
    if (!danmakuOn) {
        heatCanvas.style.display = 'none';
        return;
    }
    // duration 迟到：预取时 video 还没 metadata，这里补算
    if (pendingTimes) {
        const dur = videoDuration();
        if (dur > 0) { density = aggregate(pendingTimes, dur); pendingTimes = null; }
    }
    if (!density.length) {
        heatCanvas.style.display = 'none';
        return;
    }
    positionHeatBar();
    drawHeat();
}

function ingest(times: unknown): void {
    if (!Array.isArray(times) || !times.length) return;
    const dur = videoDuration();
    if (dur > 0) {
        density = aggregate(times as number[], dur);
        pendingTimes = null;
    } else {
        pendingTimes = times as number[];
    }
    try { updateHeat(); } catch { /* ignore */ }
}

// 监听器必须在本模块**加载时**就装好：danmakuHeat 按字母序先于 danmakuWeb 加载，而
// danmakuWeb 的 play/info 预取在其模块加载阶段就可能触发 —— 放到 OnReady 里会漏掉首集。
window.addEventListener(ITEMS_EVENT, (e) => {
    try { ingest((e as CustomEvent).detail?.times); } catch { /* ignore */ }
});

// [lc-1164] 全屏进出即时搬家：danmakuWeb 检测到全屏状态变化(原生 fullscreenchange /
// xgplayer class 翻转)会广播该事件；不走它的话只能等 2s 轮询或节流窗口过期，观感是
// 「进全屏后高能条空白一小段才出现」。force=true 绕过 syncHeatHost 的节流。同样必须
// 挂模块加载期 —— OnReady 里注册会错过 danmakuWeb 首次广播。
window.addEventListener('fntv:fullscreen-change', () => {
    try { syncHeatHost(true); updateHeat(); } catch { /* ignore */ }
});

// ── 注册 ──
registerHook(HookType.OnReady, () => {
    ensureHeatCanvas();

    window.setInterval(() => {
        try { updateHeat(); } catch { /* ignore */ }
    }, 2000);

    registerHook(HookType.OnDomChange, () => {
        try { updateHeat(); } catch { /* ignore */ }
    });
});
