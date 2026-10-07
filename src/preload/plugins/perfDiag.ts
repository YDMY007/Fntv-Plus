// preload/plugins/perfDiag.ts
// [lc-1284] 性能诊断：FPS 悬浮表 + 玻璃滤镜开关 —— 定位「桌面版卡、fpk 不卡」的壳开销。
//   Ctrl+Alt+F  开/关 FPS 悬浮表（每 500ms 刷新：FPS · 最差帧ms · 玻璃态）
//   Ctrl+Alt+B  开/关 玻璃滤镜（全页 backdrop-filter 强制 none）
// 两个开关均写入 localStorage 跨重启生效；窗口透明与否由启动环境变量 FNTV_NO_TRANSPARENT
// 控制（见 mainwin.ts，配套 fps对比-*.cmd 启动器），无法运行时切换。
// 默认零开销：未开 FPS 时不跑 rAF，热键仅一个捕获监听器。
import { registerHook, HookType } from '../core/hooks';
import logger from '../core/logger';

const FPS_KEY = 'fntv:diag-fps';
const NOGLASS_KEY = 'fntv:diag-noglass';
const STYLE_ID = 'fntv-diag-noglass-style';
const BADGE_ID = 'fntv-diag-fps-badge';
const HINT_ID = 'fntv-diag-hint';

function lsOn(key: string): boolean {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function lsSet(key: string, on: boolean): void {
    try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* ignore */ }
}

// 玻璃关闭态必须赶在首帧前生效 → 模块级立即注入（铁律例外；try/catch 保证不致插件加载失败，
// head 未就绪时由 OnReady 兜底再注入一次）
function applyNoGlass(): void {
    try {
        if (typeof document === 'undefined') return;
        const on = lsOn(NOGLASS_KEY);
        let s = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = STYLE_ID;
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
        } else if (s) {
            s.remove();
        }
    } catch (e) {
        logger.warn('[perfDiag] applyNoGlass 失败:', e);
    }
}

// ── FPS 悬浮表 ──
let badge: HTMLDivElement | null = null;
let rafId = 0;
let lastTs = 0;
let windowStart = 0;
let frames = 0;
let worstMs = 0;

function ensureBadge(): HTMLDivElement {
    if (badge && badge.isConnected) return badge;
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.setAttribute('data-fnos-ui', '1'); // 白底清除器/a11y/pageAnim 豁免标记
    badge.style.cssText = 'position:fixed;top:40px;right:12px;z-index:2147483647;pointer-events:none;'
        + 'background:rgba(10,12,18,.74);color:#7CFC9A;font:600 12px/1.55 Consolas,monospace;'
        + 'padding:5px 10px;border-radius:8px;text-align:right;white-space:pre;';
    document.body.appendChild(badge);
    return badge;
}

function fmtBadge(fps: number): string {
    return `${fps} FPS · 最差 ${Math.round(worstMs)}ms\n玻璃: ${lsOn(NOGLASS_KEY) ? '关(测试)' : '开'}`;
}

function tick(ts: number): void {
    if (!lastTs) {
        lastTs = ts; windowStart = ts; frames = 0; worstMs = 0;
    } else {
        const dt = ts - lastTs;
        lastTs = ts;
        if (dt > worstMs) worstMs = dt;
        frames++;
        const elapsed = ts - windowStart;
        if (elapsed >= 500) {
            ensureBadge().textContent = fmtBadge(Math.round(frames * 1000 / elapsed));
            frames = 0; windowStart = ts; worstMs = 0;
        }
    }
    rafId = requestAnimationFrame(tick);
}

function startFps(): void {
    cancelAnimationFrame(rafId);
    lastTs = 0;
    ensureBadge();
    rafId = requestAnimationFrame(tick);
}

function stopFps(): void {
    cancelAnimationFrame(rafId);
    if (badge) { badge.remove(); badge = null; }
}

// ── 轻提示 ──
function flashHint(text: string): void {
    try {
        const old = document.getElementById(HINT_ID);
        if (old) old.remove();
        const el = document.createElement('div');
        el.id = HINT_ID;
        el.setAttribute('data-fnos-ui', '1');
        el.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;'
            + 'pointer-events:none;background:rgba(10,12,18,.85);color:#EAEFF7;font:500 13px/1.4 system-ui,sans-serif;'
            + 'padding:8px 14px;border-radius:10px;';
        el.textContent = text;
        document.body.appendChild(el);
        window.setTimeout(() => el.remove(), 2200);
    } catch { /* ignore */ }
}

// ── 注册 ──
registerHook(HookType.OnReady, () => {
    applyNoGlass(); // 模块级注入时 head 可能未就绪，此处兜底

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!e.ctrlKey || !e.altKey || e.repeat) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 避开 AltGr 输入
        const k = (e.key || '').toLowerCase();
        if (k === 'f') {
            e.preventDefault();
            e.stopPropagation();
            const on = !lsOn(FPS_KEY);
            lsSet(FPS_KEY, on);
            if (on) startFps(); else stopFps();
            flashHint(on ? 'FPS 显示已开启 — Ctrl+Alt+F 关闭' : 'FPS 显示已关闭');
        } else if (k === 'b') {
            e.preventDefault();
            e.stopPropagation();
            const on = !lsOn(NOGLASS_KEY);
            lsSet(NOGLASS_KEY, on);
            applyNoGlass();
            flashHint(on ? '玻璃滤镜已关闭(重启仍生效) — Ctrl+Alt+B 恢复' : '玻璃滤镜已恢复');
        }
    }, true);

    if (lsOn(FPS_KEY)) startFps();
    logger.info('[perfDiag] 已加载 — Ctrl+Alt+F=FPS表 Ctrl+Alt+B=玻璃开关');
});

// 模块级：玻璃关闭态注入（放在 registerHook 之后，遵循模块级铁律的注册优先原则）
applyNoGlass();

export { };
