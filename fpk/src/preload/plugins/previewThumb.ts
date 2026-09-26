import { registerHook, HookType } from '../core/hooks';

// previewThumb.ts — [lc-1068] 网页播放器进度条悬停缩略图（对标 YouTube/B站）
// ─────────────────────────────────────────────────────────────────────────────
// 原理：隐藏 <video> 挂与主播放器相同的流（fnOS 流支持 Range，seek 可用），
//   鼠标悬停进度条 → 节流 seek 隐藏视频到目标时间 → seeked 后 drawImage 到浮层 canvas。
//   局域网 NAS seek 延迟约 0.3~1s，节流 + 只在目标时间变化 >0.5s 时才真正 seek。
// 进度条定位：启发式扫描播放器底部「宽而矮」的条状元素（含进度填充子元素优先），
//   找不到 → 功能静默不启用。Console 可执行 fntvDumpProgressBar() 输出候选诊断（仿 lc-908）。
// MPV 端：uosc 自带 thumbfast 集成，thumbfast.lua 已随包内置（见 lc-1068 提交的脚本文件）。

const OV_ID = 'fntv-thumb-ov';
const DUMP_KEY = 'fntvDumpProgressBar';

let wired = false;
let bar: HTMLElement | null = null;
let hidden: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let lastSeekTarget = -1;
let seekPending = false;

function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** 启发式定位飞牛播放器进度条：播放器底部、宽≥60%播放器宽、高 6~44px 的条状元素 */
function findProgressBar(video: HTMLVideoElement): HTMLElement | null {
    const vr = video.getBoundingClientRect();
    if (!vr.width || !vr.height) return null;
    let root: HTMLElement = video.parentElement as HTMLElement;
    for (let i = 0; i < 4 && root && root !== document.body; i++) root = root.parentElement as HTMLElement;
    const scope = root || document.body;
    const cands: { el: HTMLElement; score: number }[] = [];
    scope.querySelectorAll('div,section').forEach((el) => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width < vr.width * 0.5 || r.width > vr.width * 1.2) return;
        if (r.height < 6 || r.height > 44) return;
        if (r.bottom < vr.bottom - vr.height * 0.3 || r.bottom > vr.bottom + 12) return;
        let score = 1;
        const cls = (e.className || '').toString();
        if (/progress|seek|slider|timeline|scrub/i.test(cls)) score += 5;
        const fill = Array.from(e.children).some((c) => {
            const cc = (c as HTMLElement).style;
            if (!cc) return false;
            return /width\s*:/.test(cc.cssText || '') || cc.transform.includes('scaleX');
        });
        if (fill) score += 3;
        if (e.querySelector('[class*="progress"], [class*="handle"], [class*="knob"]')) score += 2;
        if (score >= 2) cands.push({ el: e, score });
    });
    cands.sort((a, b) => b.score - a.score);
    return cands.length ? cands[0].el : null;
}

/** 确保隐藏预览视频存在（与主播放器同流） */
function ensureHidden(main: HTMLVideoElement): HTMLVideoElement {
    if (hidden) return hidden;
    const h = document.createElement('video');
    h.muted = true;
    h.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:160px;height:90px;';
    const src = main.currentSrc || main.src;
    if (src) h.src = src;
    (h as any).preload = 'auto';
    document.body.appendChild(h);
    hidden = h;
    return h;
}

/** 悬停时间 → seek 隐藏视频（节流）→ seeked 后绘制 */
function requestFrame(h: HTMLVideoElement, cv: HTMLCanvasElement, time: number): void {
    if (Math.abs(time - lastSeekTarget) < 0.5 && seekPending) return;
    lastSeekTarget = time;
    seekPending = true;
    const onSeeked = (): void => {
        h.removeEventListener('seeked', onSeeked);
        try {
            const ctx = cv.getContext('2d');
            if (ctx) {
                ctx.drawImage(h, 0, 0, cv.width, cv.height);
                cv.style.opacity = '1';
            }
        } catch { /* 绘制失败静默(可能跨域) */ }
        seekPending = false;
    };
    h.addEventListener('seeked', onSeeked, { once: true });
    try { h.currentTime = time; } catch { seekPending = false; }
}

/** 在进度条上挂 hover 逻辑 */
function wireBar(barEl: HTMLElement, main: HTMLVideoElement): void {
    if ((barEl as any).dataset.fntvThumb === '1') return;
    (barEl as any).dataset.fntvThumb = '1';
    bar = barEl;

    const ov = document.createElement('div');
    ov.id = OV_ID;
    ov.style.cssText = [
        'position:fixed', 'z-index:2147482900', 'pointer-events:none',
        'display:none', 'flex-direction:column', 'align-items:center', 'gap:4px',
    ].join(';') + ';';
    const cv = document.createElement('canvas');
    cv.width = 176; cv.height = 99;
    cv.style.cssText = 'border-radius:8px;border:1px solid rgba(255,255,255,.35);'
        + 'box-shadow:0 8px 26px rgba(0,0,0,.45);background:#000;opacity:0;transition:opacity .12s ease;';
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:#fff;'
        + 'background:rgba(16,18,26,.78);font-family:"Segoe UI",system-ui,sans-serif;';
    ov.appendChild(cv);
    ov.appendChild(tip);
    document.body.appendChild(ov);
    canvas = cv;

    barEl.addEventListener('mousemove', (e: MouseEvent) => {
        const r = barEl.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const mainV = document.querySelector('video') as HTMLVideoElement | null;
        if (!mainV || !mainV.duration || !isFinite(mainV.duration)) { ov.style.display = 'none'; return; }
        const time = ratio * mainV.duration;
        const h = ensureHidden(mainV);
        // 浮层位置：跟随鼠标 X（钳制在视口内），悬于进度条上方
        const ovW = 176;
        const left = Math.max(8, Math.min(window.innerWidth - ovW - 8, e.clientX - ovW / 2));
        const top = Math.max(8, r.top - 112);
        ov.style.display = 'flex';
        ov.style.left = left + 'px';
        ov.style.top = top + 'px';
        tip.textContent = esc(fmtTime(time));
        requestFrame(h, cv, time);
    });
    barEl.addEventListener('mouseleave', () => {
        ov.style.display = 'none';
        if (canvas) canvas.style.opacity = '0';
    });
}

function fmtTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n: number): string => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** 主循环：播放页 + 主视频就绪 → 定位进度条并接线（幂等） */
function tick(): void {
    if (wired && bar && document.contains(bar)) return; // 已接线且条仍在
    if (wired && (!bar || !document.contains(bar))) {
        wired = false; bar = null;
        const ov = document.getElementById(OV_ID);
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    }
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (!v) return;
    const b = findProgressBar(v);
    if (!b) return;
    wired = true;
    wireBar(b, v);
    log('进度条已定位并接线: ' + (b.className || b.tagName).toString().slice(0, 80));
}

function log(msg: string): void {
    try { console.info('[previewThumb]', msg); } catch { /* ignore */ }
}

/** 诊断：Console 执行 fntvDumpProgressBar() 输出进度条候选（真实 DOM 调优用，仿 lc-908） */
(window as any)[DUMP_KEY] = function (): any {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (!v) return { error: 'no video' };
    const vr = v.getBoundingClientRect();
    const cands: any[] = [];
    document.querySelectorAll('div,section').forEach((el) => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.height < 4 || r.height > 60 || r.width < vr.width * 0.3) return;
        if (r.top < vr.bottom - vr.height * 0.5) return;
        cands.push({
            cls: (e.className || '').toString().slice(0, 90),
            rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            children: e.children.length,
        });
    });
    const info = { videoRect: `${Math.round(vr.width)}x${Math.round(vr.height)}`, barFound: !!bar, candidates: cands.slice(0, 12) };
    console.log('[fntvDumpProgressBar]', JSON.stringify(info, null, 1));
    return info;
};

registerHook(HookType.OnReady, () => {
    window.setInterval(tick, 2000);
    tick();
});
