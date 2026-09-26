import { registerHook, HookType } from '../core/hooks';

// playMemory.ts — [lc-1065] 播放参数记忆（对标 Infuse/Netflix：倍速/音量/静音跨集记忆）
// ─────────────────────────────────────────────────────────────────────────────
// 网页播放器换集后 倍速/音量 会被重置为默认(1x/100%)。本插件：
//   · 监听 video 的 ratechange/volumechange → 持久化到 localStorage（全局记忆）；
//   · 新视频加载(loadedmetadata/play)时自动恢复上次参数；
//   · 恢复窗口期(播放起 3s 内)对抗播放器初始化覆盖：检测到被重置立即打回（不落盘），
//     窗口期后视为用户真实操作照常持久化。
// 作用域：video 元素级直接读写 playbackRate/volume/muted，不依赖播放器内部 API，
//   网页播放器/任意 <video> 均生效。MPV 端由 watch-later/自身配置管理，不在此列。
// 字幕轨/音轨记忆涉及播放器内部轨道状态，后续版本单独接入。

const LS_RATE = 'fntv-play-rate';
const LS_VOL = 'fntv-play-volume';
const LS_MUTE = 'fntv-play-mute';
const GUARD_MS = 3000; // 恢复窗口期：播放起 3s 内视为"播放器初始化覆盖"对抗期

const num = (key: string, fallback: number): number => {
    try {
        const v = parseFloat(localStorage.getItem(key) || '');
        return Number.isFinite(v) ? v : fallback;
    } catch { return fallback; }
};

function attach(v: HTMLVideoElement): void {
    if (v.dataset.fntvPlayMem === '1') return;
    v.dataset.fntvPlayMem = '1';

    let suppressUntil = 0; // 恢复对抗期截止

    // ── 持久化 ──
    v.addEventListener('ratechange', () => {
        const saved = num(LS_RATE, 1);
        if (Date.now() < suppressUntil && saved > 0 && Math.abs(v.playbackRate - saved) > 0.01) {
            v.playbackRate = saved; // 播放器初始化重置 → 打回
            return;
        }
        try { localStorage.setItem(LS_RATE, String(v.playbackRate)); } catch { /* ignore */ }
    });
    v.addEventListener('volumechange', () => {
        const savedVol = num(LS_VOL, -1);
        const savedMute = (() => { try { return localStorage.getItem(LS_MUTE) === '1'; } catch { return false; } })();
        if (Date.now() < suppressUntil) {
            const volOff = savedVol >= 0 && Math.abs(v.volume - savedVol) > 0.01;
            const muteOff = v.muted !== savedMute;
            if (volOff || muteOff) {
                if (savedVol >= 0) v.volume = savedVol;
                v.muted = savedMute;
                return;
            }
        }
        try {
            localStorage.setItem(LS_VOL, String(v.volume));
            localStorage.setItem(LS_MUTE, v.muted ? '1' : '0');
        } catch { /* ignore */ }
    });

    // ── 恢复 ──
    const restore = (): void => {
        const savedRate = num(LS_RATE, 0);
        const savedVol = num(LS_VOL, -1);
        const savedMute = (() => { try { return localStorage.getItem(LS_MUTE) === '1'; } catch { return false; } })();
        if (savedRate > 0 && Math.abs(v.playbackRate - savedRate) > 0.01) v.playbackRate = savedRate;
        if (savedVol >= 0) v.volume = savedVol;
        v.muted = savedMute;
        suppressUntil = Date.now() + GUARD_MS;
        // 短周期重申：播放器初始化晚于我们覆盖时打回
        let n = 0;
        const reassert = window.setInterval(() => {
            n++;
            if (n >= 6 || !v.isConnected) { clearInterval(reassert); return; }
            const r = num(LS_RATE, 0);
            if (r > 0 && Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r;
        }, 500);
    };

    v.addEventListener('loadedmetadata', restore);
    v.addEventListener('play', restore);
    if (v.readyState >= 1) restore();
    // 事件早于本插件挂载的兜底：延迟补恢复一次（真实场景: 换集时 loadedmetadata 常先于轮询挂载）
    window.setTimeout(restore, 600);
}

// ── 轮询挂载：SPA 换集可能替换 video 元素 ──
registerHook(HookType.OnReady, () => {
    window.setInterval(() => {
        try {
            const v = document.querySelector('video') as HTMLVideoElement | null;
            if (v) attach(v);
        } catch { /* ignore */ }
    }, 1500);
});
