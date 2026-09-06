import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';

// danmakuHeat.ts — [lc-1070] 弹幕高能进度条（对标 B站）
// 在 xgplayer 进度条上方叠加弹幕密度热力条：
//   · 数据：拦截 ipcRenderer.invoke('danmaku:prepare') 响应拿 items[].time（danmakuWeb 拉取后经此透传）
//   · 聚合：按视频时长等分桶统计密度
//   · 渲染：canvas 热力条（透明→靛蓝渐变），pointer-events:none
//   · 可见性：单函 updateHeat() 统一管定位+可见性+绘制（弹幕开关关/无数据→隐藏）
// 独立于 danmakuWeb.ts（不 import 它），只读它的 localStorage 开关与 IPC 通道。

const HEAT_ID = 'fntv-danmaku-heat';
const LS_KEY = 'fntv-danmaku';

let heatCanvas: HTMLCanvasElement | null = null;
let heatCtx: CanvasRenderingContext2D | null = null;
let density: number[] = [];

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

// ── 弹幕数据拦截（invoke 透传后抓 items[].time 聚合）──
let hookInstalled = false;
function hookInvoke(): void {
    if (hookInstalled) return;
    hookInstalled = true;
    const real = ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke = async function (cmd: string, ...args: any[]) {
        const result = await real(cmd, ...args);
        if (cmd === 'danmaku:prepare' && result && Array.isArray(result.items) && result.items.length) {
            try {
                const v = document.querySelector('video') as HTMLVideoElement | null;
                const realDur = (v && v.duration && isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
                if (realDur > 0) {
                    density = aggregate(result.items.map((it: any) => it.time || 0), realDur);
                }
            } catch { /* ignore */ }
        }
        return result;
    };
}

// ── 热力条 DOM ──
function ensureHeatCanvas(): void {
    if (heatCanvas) return;
    const c = document.createElement('canvas');
    c.id = HEAT_ID;
    c.style.cssText = 'position:fixed;z-index:6;pointer-events:none;display:none;';
    document.body.appendChild(c);
    heatCanvas = c;
    heatCtx = c.getContext('2d');
}

// ── 定位：贴在 xgplayer 进度条上方 ──
function positionHeatBar(): void {
    if (!heatCanvas) return;
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

// ── 单一 update：定位+可见性+绘制 ──
function updateHeat(): void {
    if (!heatCanvas) return;
    let danmakuOn = true;
    try { danmakuOn = localStorage.getItem(LS_KEY) !== '0'; } catch { /* ignore */ }
    if (!danmakuOn || !density.length) {
        heatCanvas.style.display = 'none';
        return;
    }
    positionHeatBar();
    drawHeat();
}

// ── 注册 ──
registerHook(HookType.OnReady, () => {
    hookInvoke();
    ensureHeatCanvas();

    window.setInterval(() => {
        try {
            ensureHeatCanvas();
            updateHeat();
        } catch { /* ignore */ }
    }, 2000);

    registerHook(HookType.OnDomChange, () => {
        try { updateHeat(); } catch { /* ignore */ }
    });
});
