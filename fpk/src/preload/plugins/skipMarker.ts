// preload/plugins/skipMarker.ts
//
// [skip-manual] 飞牛原生网页播放器「片头/片尾手动标记」插件（网页端副本）。
// 移植自桌面版 src/preload/plugins/skipMarker.ts，逐字同步（lc-1292 起无 fullscreenHost
// 依赖，与桌面版零差异）；数据通道由 shim/electron.js 的 skip-manual:* 通道承担：手动标记
// 存 localStorage（桌面是 userData/skip-manual.json），服务端读写直连 fnOS /v/api/v1/skipinfo
// （签名 + cookie，同 skip:fetch-and-fill 已验证路径）。
//
// 三个自有 UI（fntv- 前缀 id + data-fnos-ui 容器标记，不碰飞牛原生样式）：
//   ① 「标记」入口（注入 xgplayer 控制栏右格、「弹幕」右侧空位，DOM 层级照抄 danmakuWeb 的「弹幕」按钮）→ 悬停展开标记面板
//   ② 修正模式（自动数据已填充且未手动修正过时，面板自动进 fix 态：预填当前生效值 + 徽标提示）
//   ③ 兜底跳过按钮（手动标记存在 && 原生跳过面板未渲染 && 进入触发窗口时右下角显示；面板打开期间让位隐藏）
// 面板整体复刻「弹幕」弹窗的同款交互与视觉（danmakuWeb 的 .fntv-dm-list 规格）：物理挂进
// 「标记」按钮外壳内、CSS 锚定 right:-6px / bottom:calc(100%+10px)（::after 桥接 10px 间隙），
// 鼠标移上即弹出、移出 260ms 延时关闭（lc-1292 用户明确要求与弹幕一致，弃用旧的 body 级
// fixed + 点击开合 + 全屏迁移那套）。底色/圆角/阴影等视觉关键属性内联——页面侧规则曾把
// 类样式底色覆盖成全透明，内联优先级最高；底色与弹幕弹窗完全同值 rgba(46,47,48,.97)。
//
// 数据链路：打点/直填 → skip-manual:set（本地 JSON + 保存即写回服务端，写回开关在设置面板）；
//   取数优先级在主进程 smartSkip Step 0 短路：手动(本集) > 手动(季) > 飞牛服务端 > AniSkip > theintrodb。
//   「恢复自动」= skip-manual:clear（清本地 + 服务端清零）→ 以 force 重跑 skip:fetch-and-fill 自动链。
//
// 设计约束（用户明确禁止）：
// - 不碰播放器样式/窗口配置/GPU/DevTools；只做自有元素 + 纯数据管道
// - 手柄：面板挂 data-fnos-ui（与 embyWall 自建面板同一容器约定，gamepadFocus 自动识别）
// - 铁律：registerHook 最先执行；模块级 IIFE + try-catch；本插件纯 invoke 无 ipcRenderer.on

import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import { t } from '../core/i18n';
import logger from '../core/logger';

const log = logger;

// ─── 常量 ───

const PANEL_ID = 'fntv-marker-panel';
const MARKER_STYLE_ID = 'fntv-marker-panel-style';
const SKIP_BTN_ID = 'fntv-marker-skip-btn';
const RECAP_BTN_ID = 'fntv-recap-btn';      // skipInject 的「跳过前情」按钮（占位避让）
const UI_MARK = 'data-fnos-ui';
const Z_TOP = '2147483000';
const CONFIG_TTL = 60 * 1000;
const INTRO_TAIL_S = 15;                    // 片头终点后按钮滞留窗口（秒）
// 控制栏挂载轮询（danmakuWeb 同款）：控制栏可能晚于本插件出现，DOM 变动钩子不保证再触发
const MOUNT_POLL_MS = 400;
const MOUNT_POLL_MAX = 60;                  // 400ms × 60 = 24s 硬上限
const MOUNT_POLL_PAGE_GRACE = 15;           // 前 6s 允许 isPlayerPage() 为假（等 <video> 元素出现）

// guid 提取（与 skipInject 的 GUID_RE 同一 URL 模式；只匹配 pathname 防 query 误命中）
const GUID_RE = /\/v\/(?:movie|tv|video|other)(?:\/(?:season|episode))?\/([a-f0-9]{32})/i;

// ─── 类型 ───

interface ManualEntry {
    guid: string;
    scope: 'episode' | 'season';
    introStart: number;
    introEnd: number;
    outroStart: number;
    outroEnd: number;
    fnSkipStart: number;
    fnSkipEnd: number;
    totalDuration: number;
    updatedAt: number;
}

interface SkipManualCfg {
    enabled: boolean;
    writeBack: boolean;
    defaultScope: 'episode' | 'season';
    leadSeconds: number;
    introSoftLimit: number;
}

interface EffectiveSkip {
    manual: ManualEntry | null;
    server: { skipStart: number; skipEnd: number } | null;
}

// ─── 状态 ───

let config: SkipManualCfg | null = null;
let configAt = 0;
let currentGuid = '';
let effective: EffectiveSkip | null = null;
let effectiveGuid = '';
let btnWrap: HTMLDivElement | null = null;   // 控制栏入口外壳（plugin-placeholder，danmakuWeb 同构）
let panelEl: HTMLElement | null = null;
let skipBtnEl: HTMLButtonElement | null = null;
let boundVideo: HTMLVideoElement | null = null;
let mountPollTimer: ReturnType<typeof setInterval> | null = null;
let mountPollTries = 0;
// 兜底按钮「点击后隐藏」标记：离开窗口自动复位（每集可多次触发，不走去重）
let dismissedIntro = false;
let dismissedOutro = false;

// 面板内部控件引用（ensurePanel 时创建）
let inIntroStart: HTMLInputElement | null = null;
let inIntroEnd: HTMLInputElement | null = null;
let inOutroStart: HTMLInputElement | null = null;
let inOutroEnd: HTMLInputElement | null = null;
let scopeEpisode: HTMLInputElement | null = null;
let scopeSeason: HTMLInputElement | null = null;
let restoreBtnEl: HTMLButtonElement | null = null;
let fixBadgeEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;
let backJumpBtn: HTMLButtonElement | null = null;
let preSeekTime = -1;

// ─── 工具 ───

function extractGuid(): string {
    try {
        const m = window.location.pathname.match(GUID_RE);
        if (m && m[1]) return m[1].toLowerCase();
    } catch { /* ignore */ }
    // URL 兜底：video 容器上的 guid 属性
    try {
        const v = document.querySelector('video');
        const box = v && (v.closest('[data-guid], [data-item-id], [data-itemguid]') as HTMLElement | null);
        if (box) {
            const g = box.getAttribute('data-guid') || box.getAttribute('data-item-id') || box.getAttribute('data-itemguid');
            if (g && /^[a-f0-9]{32}$/i.test(g)) return g.toLowerCase();
        }
    } catch { /* ignore */ }
    return '';
}

function isPlayerPage(): boolean {
    try {
        return !!(document.querySelector('video') || document.querySelector('.videoPlayer, .playerPage, #videoPlayer'));
    } catch { return false; }
}

function getVideo(): HTMLVideoElement | null {
    return document.querySelector('video') as HTMLVideoElement | null;
}

function videoDuration(): number {
    const v = getVideo();
    return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
}

async function getConfig(): Promise<SkipManualCfg | null> {
    if (config && Date.now() - configAt < CONFIG_TTL) return config;
    try {
        config = await ipcRenderer.invoke('skip-manual:get-config') as SkipManualCfg;
        configAt = Date.now();
        return config;
    } catch (e) {
        log.warn('[skip-marker] 读配置失败:', (e as Error).message);
        return null;
    }
}

function invalidateEffective(): void {
    effective = null;
    effectiveGuid = '';
}

async function refreshEffective(guid: string): Promise<EffectiveSkip | null> {
    if (effective && effectiveGuid === guid) return effective;
    try {
        effective = await ipcRenderer.invoke('skip-manual:effective', { guid }) as EffectiveSkip;
        effectiveGuid = guid;
        return effective;
    } catch (e) {
        log.warn('[skip-marker] 查询生效标记失败:', (e as Error).message);
        return null;
    }
}

function toast(msg: string): void {
    try {
        const el = document.createElement('div');
        el.setAttribute(UI_MARK, '1');
        el.textContent = t(msg);
        el.style.cssText = 'position:fixed;left:50%;bottom:140px;transform:translateX(-50%);z-index:' + Z_TOP + ';'
            + 'padding:9px 16px;border-radius:8px;font-size:12.5px;color:#fff;'
            + 'background:rgba(30,34,48,.92);box-shadow:0 8px 24px rgba(0,0,0,.35);'
            + 'transition:opacity .25s ease;pointer-events:none;';
        document.body.appendChild(el);
        window.setTimeout(() => { el.style.opacity = '0'; }, 2400);
        window.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2800);
    } catch { /* ignore */ }
}

/** 主/次动作按钮：primary = 弹幕面板搜索按钮同款品牌蓝；ghost = 描边灰底(次级动作)。
 * 样式走 injectMarkerPanelStyle 的 .fntv-mk-btn 类（弹幕面板同规格）。 */
function mkBtn(label: string, ghost: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fntv-mk-btn' + (ghost ? ' fntv-mk-ghost' : '');
    b.textContent = t(label);
    return b;
}

// ─── 控制栏入口（「标记」按钮，danmakuWeb「弹幕」按钮同构）───

/**
 * 找原生控制栏（danmakuWeb 同款精确锚定）：飞牛播放器实测 DOM 是
 * <xg-controls class="xgplayer-controls"> 内含 <xg-right-grid>，
 * 原画/选集/倍速/弹幕等文字按钮都是 <div class="plugin-placeholder"> 子节点。
 */
function findControlsBar(): HTMLElement | null {
    const right = document.querySelector('xg-right-grid') as HTMLElement | null;
    if (right && right.offsetHeight > 0) return right;
    const controls = (document.querySelector('xg-controls.xgplayer-controls') ||
        document.querySelector('.xgplayer-controls')) as HTMLElement | null;
    if (controls && controls.offsetHeight > 0) {
        const innerRight = controls.querySelector('xg-right-grid') as HTMLElement | null;
        if (innerRight && innerRight.offsetHeight > 0) return innerRight;
        return controls;
    }
    const all = document.querySelectorAll('div, nav, [role]');
    for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement;
        const h = el.offsetHeight;
        const txt = el.textContent || '';
        if ((txt.includes('倍速') || txt.includes('选集') || txt.includes('原画')) &&
            h > 20 && h < 120 && el.children.length >= 2) {
            return el;
        }
    }
    return null;
}

/**
 * DOM 层级照抄原生文字按钮（danmakuWeb createControls 原样）：
 * `div.plugin-placeholder > div.h-full > div.flex.h-full.items-center.justify-center[tabindex=0] > span`。
 * 点击开合面板（不走 hover：标记流程要边看视频边打点，面板必须常驻到用户主动收起）。
 */
function createControlBtn(): void {
    if (btnWrap) return;

    const wrap = document.createElement('div');
    wrap.className = 'plugin-placeholder';
    wrap.dataset.fnosUi = '1';      // 约定标记：豁免各注入层的刷白/焦点/动画接管
    // [lc-1292] 面板 position:absolute 的定位锚（bottom:calc(100%+10px) / right:-6px 相对本按钮），
    // danmakuWeb 外壳同款——漏掉这行面板会锚到更外层的宽容器，横向漂到播放器右缘（用户实测）。
    wrap.style.position = 'relative';

    const hfull = document.createElement('div');
    hfull.className = 'h-full';
    const flex = document.createElement('div');
    flex.className = 'flex h-full items-center justify-center';
    flex.setAttribute('tabindex', '0');

    // xgplayer 控制栏恒为暗底(渐变遮罩)，固定白色系文字，与原生控件(倍速/选集/弹幕)一致
    const span = document.createElement('span');
    span.className = 'cursor-pointer text-lg leading-lg';
    span.style.userSelect = 'none';
    // [lc-1292] 文字色与「弹幕」按钮启用态完全同款(danmakuWeb 同款品牌蓝 var(--semi-color-primary))
    span.style.color = 'var(--semi-color-primary, #3374DB)';
    span.textContent = t('标记');
    flex.appendChild(span);
    hfull.appendChild(flex);
    wrap.appendChild(hfull);

    // [lc-1292] 与「弹幕」按钮同交互：鼠标移上即弹出、移出 260ms 延时关闭。面板物理挂进
    // wrap（按钮↔面板之间移动不触发 mouseleave，10px 间隙另有 ::after 桥接）；点击保留
    // （触控板/键盘用户），已展开就保持展开，不做 toggle 关掉（danmakuWeb 逐字同构）。
    wrap.addEventListener('mouseenter', () => { cancelCloseMkPanel(); void openPanel(); });
    wrap.addEventListener('mouseleave', () => { scheduleCloseMkPanel(); });
    flex.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        cancelCloseMkPanel();
        void openPanel();
    });

    btnWrap = wrap;
}

function ensureControlBtn(): void {
    // SPA 换集/返回再进：旧播放器 DOM 连同按钮一起被销毁，引用必须作废重挂
    if (btnWrap && !btnWrap.isConnected) btnWrap = null;
    const bar = findControlsBar();
    if (!bar) return;
    if (!btnWrap) createControlBtn();
    if (btnWrap && btnWrap.parentElement !== bar) {
        bar.appendChild(btnWrap);
        log.info('[skip-marker] 标记入口已注入控制栏(' + String(bar.className).slice(0, 40) + ')');
    }
}

function removeControlBtn(): void {
    try { if (btnWrap && btnWrap.parentNode) btnWrap.parentNode.removeChild(btnWrap); } catch { /* ignore */ }
    btnWrap = null;
}

function stopMountPoll(): void {
    if (mountPollTimer) { clearInterval(mountPollTimer); mountPollTimer = null; }
    mountPollTries = 0;
}

function startMountPoll(): void {
    if (mountPollTimer || (btnWrap && btnWrap.isConnected)) return;
    mountPollTries = 0;
    mountPollTimer = setInterval(() => {
        mountPollTries++;
        if ((btnWrap && btnWrap.isConnected) || mountPollTries > MOUNT_POLL_MAX ||
            (mountPollTries > MOUNT_POLL_PAGE_GRACE && !isPlayerPage())) {
            stopMountPoll();
            return;
        }
        ensureControlBtn();
    }, MOUNT_POLL_MS);
}

// ─── 兜底跳过按钮（右下角，原生面板缺位时才顶上）───

function ensureSkipBtn(): void {
    if (skipBtnEl && document.getElementById(SKIP_BTN_ID)) return;
    removeSkipBtn();
    skipBtnEl = document.createElement('button');
    skipBtnEl.id = SKIP_BTN_ID;
    skipBtnEl.setAttribute(UI_MARK, '1');
    skipBtnEl.type = 'button';
    skipBtnEl.style.cssText = 'position:fixed;right:28px;bottom:96px;z-index:' + Z_TOP + ';display:none;'
        + 'border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:13px;font-weight:700;color:#fff;letter-spacing:.4px;'
        + 'background:linear-gradient(135deg,rgba(109,127,242,.95),rgba(138,99,232,.95));box-shadow:0 8px 24px rgba(40,52,110,.4);';
    skipBtnEl.addEventListener('click', (e: Event) => { e.stopPropagation(); onSkipClick(); });
    document.body.appendChild(skipBtnEl);
}

function removeSkipBtn(): void {
    try { const el = document.getElementById(SKIP_BTN_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch { /* ignore */ }
    skipBtnEl = null;
}

// 飞牛原生跳过面板是否已渲染（自建元素排除；best-effort 探测，P3 实测校准选择器）
function nativeSkipPanelVisible(): boolean {
    try {
        const els = document.querySelectorAll('[class*="skip" i], [id*="skip" i]');
        for (let i = 0; i < els.length; i++) {
            const el = els[i] as HTMLElement;
            if (!el || (el.id && el.id.startsWith('fntv-'))) continue;
            if (el.closest('[data-fnos-ui]')) continue;   // 自建 UI 排除
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 40 && r.height > 20) return true;
        }
    } catch { /* ignore */ }
    return false;
}

function onSkipClick(): void {
    if (!skipBtnEl || !boundVideo) return;
    const kind = skipBtnEl.getAttribute('data-kind');
    const target = Number(skipBtnEl.getAttribute('data-target'));
    if (!kind || !isFinite(target)) return;
    try { boundVideo.currentTime = target; } catch { /* ignore */ }
    if (kind === 'intro') dismissedIntro = true;
    else dismissedOutro = true;
    skipBtnEl.style.display = 'none';
    log.info(`[skip-marker] 兜底跳过(${kind}) → ${Math.round(target)}s`);
}

function onTimeUpdate(): void {
    if (!skipBtnEl || !boundVideo) return;
    // 面板打开期间兜底按钮整体让位（面板锚在栏上沿，右下角同位会叠压）；关闭后下一个 timeupdate 恢复
    if (panelOpen()) { skipBtnEl.style.display = 'none'; return; }
    const eff = effective;
    const manual = eff && eff.manual ? eff.manual : null;
    if (!manual) { skipBtnEl.style.display = 'none'; return; }
    // 原生面板已渲染 → 兜底按钮退位（防双按钮）
    if (nativeSkipPanelVisible()) { skipBtnEl.style.display = 'none'; return; }
    const cfg = config;
    const lead = cfg ? cfg.leadSeconds : 5;
    const cur = boundVideo.currentTime;
    let kind = '';
    let target = 0;
    let label = '';
    // 片头窗口：[introStart - lead, introEnd + 15s]
    if (manual.introEnd > manual.introStart && cur >= manual.introStart - lead && cur <= manual.introEnd + INTRO_TAIL_S) {
        if (!dismissedIntro) { kind = 'intro'; target = manual.introEnd; label = t('跳过片头'); }
    } else {
        dismissedIntro = false;
    }
    // 片尾窗口：[outroStart - lead, outroEnd]
    if (!kind && manual.outroEnd > manual.outroStart && cur >= manual.outroStart - lead && cur <= manual.outroEnd) {
        if (!dismissedOutro) { kind = 'outro'; target = manual.outroEnd; label = t('跳过片尾'); }
    } else if (!kind) {
        dismissedOutro = false;
    }
    if (kind) {
        // recap 按钮占位避让（skipInject 同位注入时上移）
        const recap = document.getElementById(RECAP_BTN_ID);
        skipBtnEl.style.bottom = recap ? '140px' : '96px';
        skipBtnEl.setAttribute('data-kind', kind);
        skipBtnEl.setAttribute('data-target', String(target));
        if (skipBtnEl.textContent !== label) skipBtnEl.textContent = label;
        skipBtnEl.style.display = '';
    } else {
        skipBtnEl.style.display = 'none';
    }
}

function bindVideo(): void {
    const v = getVideo();
    if (!v || v === boundVideo) return;
    boundVideo = v;
    v.addEventListener('timeupdate', onTimeUpdate);
}

// ─── 标记面板 ───
//
// 样式规格逐字复刻 danmakuWeb 的「弹幕」弹窗(.fntv-dm-list)：同一暗底弹层容器(rgba(46,47,48,.97)
// + 14px 圆角 + Semi 双层阴影)、同一控件规格(28px 高输入框/按钮、主色 var(--semi-color-primary))、
// 同一进出场过渡(opacity/transform/visibility)。独立 fntv-mk-* 前缀：两面板并存时互不干扰。
// ⚠ 动画时长必须自己写：fnOS 把 --semi-transition_duration-* 全覆成 0ms(danmakuWeb 同款结论)。

let _markerStyleInjected = false;

function injectMarkerPanelStyle(): void {
    if (_markerStyleInjected) return;
    const css = `
.fntv-mk-list{
  box-sizing:border-box; margin:0; padding:4px 0; width:320px;
  background:rgba(46,47,48,.97);                 /* 暗色 --semi-color-bg-dropdown(同 .fntv-dm-list) */
  border:1px solid rgba(255,255,255,.07);        /* 纯黑画面上把容器边界分出来 */
  border-radius:14px;                            /* .semi-dropdown-wrapper */
  box-shadow:0 10px 20px #00000014, 0 10px 40px #0000001f;
  cursor:default; overflow:auto; color:#fff; font-size:14px; line-height:20px;
  max-height:min(86vh,920px);
  color-scheme:dark;                             /* 否则 number 旋钮按浅色表单控件渲染 */
  -webkit-app-region:no-drag;                    /* fnOS 顶栏是拖拽区，显式排除(danmakuWeb 同款) */
  transform-origin:100% 100%;
  opacity:0; visibility:hidden; pointer-events:none; transform:translateY(8px) scale(.96);
  transition:opacity .18s cubic-bezier(.22,1,.36,1), transform .18s cubic-bezier(.22,1,.36,1), visibility 0s linear .18s;
}
.fntv-mk-list.active{opacity:1; visibility:visible; pointer-events:auto; transform:none; transition-delay:0s}
/* [lc-1315] 窄屏面板定位同弹幕面板：lc-1314 两行布局把「标记」按钮从右栏最右挪到
   第二行中部，原内联 right:-6px（假设按钮贴视口右缘）会把面板推出视口。
   fixed + 居中 + 底栏上方与按钮水平位置解耦；!important 压内联定位；激活态
   transform 必须带 translateX(-50%)（transform 单一属性，写 none 会踢掉居中）。 */
html.fnos-touch-narrow .fntv-mk-list{
  position:fixed !important;
  left:50% !important; right:auto !important;
  bottom:calc(136px + max(8px, env(safe-area-inset-bottom)) + 10px) !important;
  width:min(92vw, 360px) !important;
  max-height:min(62vh, 560px) !important;
  transform-origin:50% 100% !important;
  transform:translateX(-50%) translateY(8px) scale(.96) !important;
}
html.fnos-touch-narrow .fntv-mk-list.active{
  transform:translateX(-50%) !important;
}
/* 透明桥接：面板与按钮之间 10px 视觉间隙，鼠标穿过时不算移出（弹幕弹窗同款，::after 属于面板本身） */
.fntv-mk-list::after{content:'';position:absolute;left:0;right:0;top:100%;height:12px}
.fntv-mk-title{padding:10px 16px 2px;font-size:14px;font-weight:600;color:#fff}
.fntv-mk-badge{display:none;padding:4px 16px 0;font-size:11px;line-height:1.5;color:#ffb46b}
.fntv-mk-hint{padding:2px 16px 6px;font-size:11px;line-height:1.55;color:rgba(255,255,255,.45)}
/* 分区线 = .semi-dropdown-divider(同 .fntv-dm-sep) */
.fntv-mk-sep{height:1px;margin:4px 0;background:rgba(255,255,255,.15);pointer-events:none}
/* 行：左右留白 16px 统一由行承担(容器只留上下 4px，同 .fntv-dm-list li 的节奏) */
.fntv-mk-row{display:flex;align-items:center;gap:8px;margin:0;padding:5px 16px}
.fntv-mk-row-last{padding:8px 16px 10px}
.fntv-mk-lab{flex:none;width:64px;font-size:12px;color:rgba(255,255,255,.85)}
.fntv-mk-in{
  width:76px;height:28px;padding:0 8px;box-sizing:border-box;
  border:1px solid rgba(255,255,255,.14);border-radius:6px;
  background:rgba(255,255,255,.07);color:#fff;font-size:12px;
  outline:none;box-shadow:none;appearance:none;
}
.fntv-mk-in::placeholder{color:rgba(255,255,255,.35)}
.fntv-mk-in:focus{border-color:var(--semi-color-primary,#3374DB);background:rgba(255,255,255,.09)}
.fntv-mk-unit{flex:none;font-size:11px;color:rgba(255,255,255,.45)}
.fntv-mk-scope{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:rgba(255,255,255,.85)}
.fntv-mk-row input[type=radio]{accent-color:var(--semi-color-primary,#3374DB);margin:0;cursor:pointer}
/* 按钮 = .fntv-dm-search-btn 规格；ghost = 输入框同款描边底(次级动作)。
   选择器带 button 元素前缀抬特异度，显式压掉飞牛页面全局给 button 的浅色 inset 描边与
   灰白底(box-shadow/background)，否则控件在暗底弹窗里发灰(dm 搜索按钮同款处理)。 */
button.fntv-mk-btn{
  flex:none;height:28px;padding:0 12px;box-sizing:border-box;
  border:none;border-radius:6px;
  background-color:var(--semi-color-primary,#3374DB);
  color:#fff;font-size:12px;font-weight:500;cursor:pointer;
  outline:none;box-shadow:none;appearance:none;
}
button.fntv-mk-btn:hover{background-color:var(--semi-color-primary-hover,#2e63c9)}
button.fntv-mk-btn.fntv-mk-ghost{background-color:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14)}
button.fntv-mk-btn.fntv-mk-ghost:hover{background-color:rgba(255,255,255,.13)}
`;
    try {
        const el = document.createElement('style');
        el.id = MARKER_STYLE_ID;
        el.textContent = css;
        (document.head || document.documentElement).appendChild(el);
        _markerStyleInjected = true;
    } catch { /* ignore */ }
}

function mkNumInput(): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = '0';
    i.step = '0.1';
    i.className = 'fntv-mk-in';
    return i;
}

function mkPanelRow(label: string, input: HTMLInputElement, isIntro: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'fntv-mk-row';
    const lab = document.createElement('span');
    lab.className = 'fntv-mk-lab';
    lab.textContent = t(label);
    row.appendChild(lab);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'fntv-mk-btn';
    dot.style.padding = '0 10px';
    dot.textContent = t('打点');
    dot.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        if (!v) { toast('未找到视频元素'); return; }
        if (v.seeking) { toast('拖动进度条中，稍后再打点'); return; }
        input.value = v.currentTime.toFixed(1);
    });
    row.appendChild(dot);
    row.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'fntv-mk-unit';
    unit.textContent = t('秒');
    row.appendChild(unit);
    if (!isIntro) row.setAttribute('data-fntv-outro-row', '1');
    return row;
}

function ensurePanel(): void {
    if (panelEl && document.getElementById(PANEL_ID)) return;
    removePanel();
    // [lc-1292] 面板物理挂进「标记」按钮外壳（弹幕弹窗同构）——外壳缺位时不创建，
    // openPanel 对 panelEl 为 null 已有守卫（按钮外壳由 ensureControlBtn 先行建好）。
    if (!btnWrap) return;
    injectMarkerPanelStyle();
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.className = 'fntv-mk-list';
    panelEl.setAttribute(UI_MARK, '1');
    panelEl.setAttribute('data-fntv-marker', '1');
    // [lc-1292] 视觉关键属性全部内联(类 .fntv-mk-list 只承担 .active 进出场动画)：
    //   页面侧规则曾把类样式底色覆盖成全透明(子元素样式完好、唯独容器规则失效)，
    //   内联样式优先级最高，任何注入层/页面全局规则都无法再把底色打掉。
    //   锚定与「弹幕」弹窗同款：挂进按钮外壳内 absolute right:-6px / bottom:calc(100%+10px)，
    //   z-index 同弹幕弹窗(30，同一控制栏层叠上下文)；底色同值 rgba(46,47,48,.97)。
    panelEl.style.cssText = 'position:absolute;right:-6px;bottom:calc(100% + 10px);z-index:30;'
        + 'box-sizing:border-box;margin:0;padding:4px 0;width:320px;'
        + 'background:rgba(46,47,48,.97);border:1px solid rgba(255,255,255,.07);'
        + 'border-radius:14px;'
        + 'box-shadow:0 10px 20px #00000014,0 10px 40px #0000001f;'
        + 'cursor:default;overflow:auto;color:#fff;font-size:14px;line-height:20px;'
        + 'max-height:min(86vh,920px);color-scheme:dark;-webkit-app-region:no-drag;'
        + 'transform-origin:100% 100%;';

    const title = document.createElement('div');
    title.className = 'fntv-mk-title';
    title.textContent = t('片头/片尾手动标记');
    panelEl.appendChild(title);

    fixBadgeEl = document.createElement('div');
    fixBadgeEl.className = 'fntv-mk-badge';
    fixBadgeEl.textContent = t('修正模式：已预填当前生效值，调整后保存将覆盖自动数据');
    panelEl.appendChild(fixBadgeEl);

    hintEl = document.createElement('div');
    hintEl.className = 'fntv-mk-hint';
    panelEl.appendChild(hintEl);

    panelEl.appendChild(mkSep());

    inIntroStart = mkNumInput();
    inIntroEnd = mkNumInput();
    inOutroStart = mkNumInput();
    inOutroEnd = mkNumInput();
    panelEl.appendChild(mkPanelRow('片头起点', inIntroStart, true));
    panelEl.appendChild(mkPanelRow('片头终点', inIntroEnd, true));
    panelEl.appendChild(mkPanelRow('片尾起点', inOutroStart, false));
    panelEl.appendChild(mkPanelRow('片尾终点', inOutroEnd, false));

    // 试跳行：校准用
    const seekRow = document.createElement('div');
    seekRow.className = 'fntv-mk-row';
    const seekIntro = mkBtn('试跳片头尾', false);
    seekIntro.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        const end = Number(inIntroEnd && inIntroEnd.value);
        if (!v || !end) { toast('请先标记片头终点'); return; }
        preSeekTime = v.currentTime;
        v.currentTime = end;
        if (backJumpBtn) backJumpBtn.style.display = '';
    });
    const seekOutro = mkBtn('试跳片尾', false);
    seekOutro.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        const start = Number(inOutroStart && inOutroStart.value);
        if (!v || !start) { toast('请先标记片尾起点'); return; }
        preSeekTime = v.currentTime;
        v.currentTime = start;
        if (backJumpBtn) backJumpBtn.style.display = '';
    });
    backJumpBtn = mkBtn('回到原位', true);
    backJumpBtn.style.display = 'none';
    backJumpBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        if (v && preSeekTime >= 0) v.currentTime = preSeekTime;
        preSeekTime = -1;
        if (backJumpBtn) backJumpBtn.style.display = 'none';
    });
    seekRow.appendChild(seekIntro);
    seekRow.appendChild(seekOutro);
    seekRow.appendChild(backJumpBtn);
    panelEl.appendChild(seekRow);

    panelEl.appendChild(mkSep());

    // 作用范围
    const scopeRow = document.createElement('div');
    scopeRow.className = 'fntv-mk-row';
    scopeEpisode = document.createElement('input');
    scopeEpisode.type = 'radio';
    scopeEpisode.name = 'fntv-marker-scope';
    scopeEpisode.value = 'episode';
    scopeSeason = document.createElement('input');
    scopeSeason.type = 'radio';
    scopeSeason.name = 'fntv-marker-scope';
    scopeSeason.value = 'season';
    const labEp = document.createElement('label');
    labEp.className = 'fntv-mk-scope';
    labEp.appendChild(scopeEpisode);
    labEp.appendChild(document.createTextNode(t('仅本集')));
    const labSeason = document.createElement('label');
    labSeason.className = 'fntv-mk-scope';
    labSeason.appendChild(scopeSeason);
    labSeason.appendChild(document.createTextNode(t('应用到整季')));
    const scopeLab = document.createElement('span');
    scopeLab.className = 'fntv-mk-lab';
    scopeLab.textContent = t('作用范围');
    scopeRow.appendChild(scopeLab);
    scopeRow.appendChild(labEp);
    scopeRow.appendChild(labSeason);
    panelEl.appendChild(scopeRow);

    // 动作行
    const actRow = document.createElement('div');
    actRow.className = 'fntv-mk-row fntv-mk-row-last';
    const saveBtn = mkBtn('保存', false);
    saveBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); void savePanel(); });
    restoreBtnEl = mkBtn('恢复自动', true);
    restoreBtnEl.style.display = 'none';
    restoreBtnEl.addEventListener('click', (e: Event) => { e.stopPropagation(); void restoreAuto(); });
    const closeBtn = mkBtn('关闭', true);
    closeBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); closePanel(); });
    actRow.appendChild(saveBtn);
    actRow.appendChild(restoreBtnEl);
    actRow.appendChild(closeBtn);
    panelEl.appendChild(actRow);

    // [lc-1292] 物理挂进「标记」按钮外壳（弹幕弹窗同构）：CSS 锚定 right:-6px /
    // bottom:calc(100%+10px)，悬停跨按钮↔面板不丢；控制栏在的场合面板就在，全屏自动可用。
    btnWrap.appendChild(panelEl);
}

/** 分区线（.fntv-dm-sep 同款规格）。 */
function mkSep(): HTMLDivElement {
    const s = document.createElement('div');
    s.className = 'fntv-mk-sep';
    return s;
}

/** 开合态统一走 .active 类（fntv-dm-list 同款进出场过渡），不用 display 硬切。 */
function panelOpen(): boolean {
    return !!panelEl && panelEl.classList.contains('active');
}

// [lc-1292] 移出延时关闭（danmakuWeb scheduleClosePanel 同款 260ms）：延时不可省——
// 指针在按钮↔面板间隙/输入落点间快速移动时会瞬时离场，立即关闭等于面板永远碰不到。
let mkCloseTimer: number | null = null;

function scheduleCloseMkPanel(): void {
    cancelCloseMkPanel();
    mkCloseTimer = window.setTimeout(() => { mkCloseTimer = null; closePanel(); }, 260);
}

function cancelCloseMkPanel(): void {
    if (mkCloseTimer !== null) { window.clearTimeout(mkCloseTimer); mkCloseTimer = null; }
}

// [lc-1288] 触摸端「点面板外关闭」。面板开合的主通道是 mouseenter/mouseleave，
// 触摸设备上这对事件要么不触发、要么在 tap 其它区域后粘住不消失（MDN :hover 同款陷阱），
// 于是手机上打开面板后没有任何途径收起它。这里补一个 pointerdown 捕获通道：
// 落在面板/触发按钮之外即关闭。与 danmakuWeb 的三通道关闭（click+touchstart+Esc）是同一思路，
// 但用 pointerdown 统一覆盖鼠标/触摸/笔，且在捕获阶段先于站点的点击处理执行。
let mkOutsideBound = false;
function bindOutsideClose(): void {
    if (mkOutsideBound) return;
    mkOutsideBound = true;
    document.addEventListener('pointerdown', (e: Event) => {
        const t = e.target as Node | null;
        if (!t || !panelEl || !panelEl.classList.contains('active')) return;
        // 面板本体与触发按钮内部的按下不关闭（面板内有输入框/按钮，点它们不该收起）
        if (panelEl.contains(t)) return;
        if (btnWrap && btnWrap.contains(t)) return;
        cancelCloseMkPanel();
        closePanel();
    }, true);
}

function removePanel(): void {
    try { const el = document.getElementById(PANEL_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch { /* ignore */ }
    panelEl = null;
    inIntroStart = null;
    inIntroEnd = null;
    inOutroStart = null;
    inOutroEnd = null;
    scopeEpisode = null;
    scopeSeason = null;
    restoreBtnEl = null;
    fixBadgeEl = null;
    hintEl = null;
    backJumpBtn = null;
}

function readPanelValues(): { introStart: number; introEnd: number; outroStart: number; outroEnd: number } {
    const num = (i: HTMLInputElement | null): number => {
        if (!i) return 0;
        const v = Number(i.value);
        return isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : 0;
    };
    return {
        introStart: num(inIntroStart),
        introEnd: num(inIntroEnd),
        outroStart: num(inOutroStart),
        outroEnd: num(inOutroEnd),
    };
}

function fillPanel(v: { introStart: number; introEnd: number; outroStart: number; outroEnd: number }): void {
    if (inIntroStart) inIntroStart.value = v.introStart > 0 ? String(v.introStart) : '';
    if (inIntroEnd) inIntroEnd.value = v.introEnd > 0 ? String(v.introEnd) : '';
    if (inOutroStart) inOutroStart.value = v.outroStart > 0 ? String(v.outroStart) : '';
    if (inOutroEnd) inOutroEnd.value = v.outroEnd > 0 ? String(v.outroEnd) : '';
}

async function openPanel(): Promise<void> {
    const cfg = await getConfig();
    if (!cfg) { toast('配置读取失败'); return; }
    const guid = extractGuid();
    if (!guid) { toast('无法识别当前播放项'); return; }
    currentGuid = guid;
    ensurePanel();
    if (!panelEl) return;

    const eff = await refreshEffective(guid);
    if (guid !== currentGuid) return;   // 异步竞态守卫：期间已切集

    // 预填：手动标记 > 服务端 2 值换算 4 值 > 空
    const total = videoDuration();
    const pre = { introStart: 0, introEnd: 0, outroStart: 0, outroEnd: 0 };
    if (eff && eff.manual) {
        pre.introStart = eff.manual.introStart || 0;
        pre.introEnd = eff.manual.introEnd || 0;
        pre.outroStart = eff.manual.outroStart || 0;
        pre.outroEnd = eff.manual.outroEnd || 0;
    } else if (eff && eff.server) {
        pre.introEnd = eff.server.skipStart || 0;
        if (total > 0 && eff.server.skipEnd > 0) {
            pre.outroStart = Math.max(0, Math.round((total - eff.server.skipEnd) * 10) / 10);
            pre.outroEnd = Math.round(total * 10) / 10;
        }
    }
    fillPanel(pre);

    // 修正模式自动判别（原「标记不准」独立入口的显示判据）：无手动标记且服务端已有跳过数据
    const isFix = !!(eff && !eff.manual && eff.server && (eff.server.skipStart > 0 || eff.server.skipEnd > 0));
    // 修正模式徽标 + 恢复自动按钮可见性（徽标 CSS 默认 display:none，显示需显式置 block）
    const hasManual = !!(eff && eff.manual);
    if (fixBadgeEl) fixBadgeEl.style.display = isFix ? 'block' : 'none';
    if (restoreBtnEl) restoreBtnEl.style.display = hasManual ? '' : 'none';
    if (hintEl) {
        hintEl.textContent = isFix
            ? t('自动数据不准？调整数值或重新打点，保存后将覆盖自动数据并写回服务端。')
            : t('播放到片头/片尾时点「打点」记录当前时刻，或直接填秒数；「试跳」可校准。保存后写回飞牛服务端（可在设置关闭）。');
    }

    // 作用范围默认值
    if (scopeEpisode && scopeSeason) {
        scopeEpisode.checked = cfg.defaultScope !== 'season';
        scopeSeason.checked = cfg.defaultScope === 'season';
    }

    // 异步竞态守卫：openPanel 等待配置/数据期间指针已移出（关闭已排程）→ 放弃本次展开
    if (mkCloseTimer !== null) { cancelCloseMkPanel(); closePanel(); return; }
    panelEl.classList.add('active');
    bindOutsideClose();   // [lc-1288] 首次展开时才绑定 document 监听，懒且只绑一次
}

function closePanel(): void {
    if (panelEl) panelEl.classList.remove('active');
}

async function savePanel(): Promise<void> {
    const v = readPanelValues();
    if (v.introEnd > 0 && v.introEnd <= v.introStart) { toast('片头区间非法：终点需大于起点'); return; }
    if (v.outroEnd > 0 && v.outroEnd <= v.outroStart) { toast('片尾区间非法：终点需大于起点'); return; }
    if (v.introEnd === 0 && v.outroStart === 0) { toast('至少标记片头或片尾'); return; }
    const scope = scopeSeason && scopeSeason.checked ? 'season' : 'episode';
    try {
        const r = await ipcRenderer.invoke('skip-manual:set', {
            guid: currentGuid,
            scope,
            introStart: v.introStart,
            introEnd: v.introEnd,
            outroStart: v.outroStart,
            outroEnd: v.outroEnd,
            totalDuration: videoDuration(),
        }) as { saved: boolean; writtenBack: boolean; written: number; total: number; message?: string };
        if (!r || !r.saved) { toast((r && r.message) || '保存失败'); return; }
        invalidateEffective();
        let msg = t('已保存');
        if (r.total > 1) msg += t('（整季写回 ') + r.written + '/' + r.total + '）';
        else if (r.writtenBack) msg += t('，已写回服务端');
        if (r.message) msg += '；' + t(r.message);
        toast(msg);
        closePanel();
        // 手动修正后隐藏「标记不准」入口
        void ensureAll();
    } catch (e) {
        toast('保存失败：' + (e as Error).message);
    }
}

async function restoreAuto(): Promise<void> {
    try {
        const r = await ipcRenderer.invoke('skip-manual:clear', { guid: currentGuid }) as { cleared: boolean; zeroed: boolean; message?: string };
        invalidateEffective();
        toast(r && r.zeroed ? t('已恢复自动：服务端已清零，自动数据将重新填充') : t('本地标记已清除') + (r && r.message ? '；' + t(r.message) : ''));
        closePanel();
        // 强制重跑自动链路（绕过主进程 filledGuids 去重），有自动数据则重新写回
        ipcRenderer.invoke('skip:fetch-and-fill', { guid: currentGuid, force: true }).catch(() => {});
        void ensureAll();
    } catch (e) {
        toast('恢复自动失败：' + (e as Error).message);
    }
}

// ─── 生命周期 ───

function teardown(): void {
    stopMountPoll();
    cancelCloseMkPanel();   // [lc-1292] 悬停关闭定时器随插件一起撤
    removeControlBtn();
    removePanel();
    removeSkipBtn();
    boundVideo = null;
    currentGuid = '';
    invalidateEffective();
}

async function ensureAll(): Promise<void> {
    try {
        const cfg = await getConfig();
        if (!cfg || !cfg.enabled) { teardown(); return; }
        if (!isPlayerPage()) { teardown(); return; }
        const guid = extractGuid();
        if (!guid) { teardown(); return; }
        if (guid !== currentGuid) {
            currentGuid = guid;
            dismissedIntro = false;
            dismissedOutro = false;
            invalidateEffective();
            closePanel();   // 换集后旧面板预填值已失效，直接收起
        }
        ensureControlBtn();
        if (!(btnWrap && btnWrap.isConnected)) startMountPoll();
        ensureSkipBtn();
        bindVideo();
        const eff = await refreshEffective(guid);
        if (guid !== currentGuid) return;   // 异步竞态守卫：期间已切集
        onTimeUpdate();
    } catch (e) {
        log.warn('[skip-marker] ensureAll 异常:', (e as Error).message);
    }
}

// ─── 注册钩子（铁律：registerHook 最先执行）───

registerHook(HookType.OnReady, () => {
    setTimeout(() => { void ensureAll(); }, 1500);
});

registerHook(HookType.OnDomChange, () => {
    setTimeout(() => { void ensureAll(); }, 600);
});

// 模块级初始化（铁律：IIFE + try-catch）
(async (): Promise<void> => {
    try {
        await getConfig();
    } catch (e) {
        log.warn('[skip-marker] 初始化失败:', (e as Error).message);
    }
})();
