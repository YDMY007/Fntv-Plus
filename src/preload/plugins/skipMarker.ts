// preload/plugins/skipMarker.ts
//
// [skip-manual] 飞牛原生网页播放器「片头/片尾手动标记」插件。
//
// 三个自有 UI（fixed 元素 + fntv- 前缀 id + data-fnos-ui 容器标记，不碰飞牛原生样式——recap 按钮同款先例）：
//   ① 「标记」常驻入口（播放页左下角）→ 打开标记面板
//   ② 「标记不准」修正入口（自动数据已填充且未手动修正过时显示）→ 面板预填当前生效值
//   ③ 兜底跳过按钮（手动标记存在 && 原生跳过面板未渲染 && 进入触发窗口时右下角显示）
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

const CLUSTER_ID = 'fntv-marker-cluster';
const MARK_BTN_ID = 'fntv-marker-btn';
const FIX_BTN_ID = 'fntv-marker-fix-btn';
const PANEL_ID = 'fntv-marker-panel';
const SKIP_BTN_ID = 'fntv-marker-skip-btn';
const RECAP_BTN_ID = 'fntv-recap-btn';      // skipInject 的「跳过前情」按钮（占位避让）
const UI_MARK = 'data-fnos-ui';
const Z_TOP = '2147483000';
const CONFIG_TTL = 60 * 1000;
const INTRO_TAIL_S = 15;                    // 片头终点后按钮滞留窗口（秒）

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
let clusterEl: HTMLElement | null = null;
let fixBtnEl: HTMLButtonElement | null = null;
let panelEl: HTMLElement | null = null;
let skipBtnEl: HTMLButtonElement | null = null;
let boundVideo: HTMLVideoElement | null = null;
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

function mkBtn(label: string, accent: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(label);
    b.style.cssText = 'border:none;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;letter-spacing:.3px;'
        + 'padding:7px 14px;color:#fff;'
        + (accent
            ? 'background:linear-gradient(135deg,rgba(109,127,242,.95),rgba(138,99,232,.95));'
            : 'background:linear-gradient(135deg,rgba(255,146,84,.95),rgba(240,98,146,.95));')
        + 'box-shadow:0 6px 18px rgba(40,52,110,.35);';
    return b;
}

// ─── 入口集群（左下角）───

function ensureCluster(): void {
    if (clusterEl && document.getElementById(CLUSTER_ID)) return;
    removeCluster();
    clusterEl = document.createElement('div');
    clusterEl.id = CLUSTER_ID;
    clusterEl.setAttribute(UI_MARK, '1');
    clusterEl.style.cssText = 'position:fixed;left:24px;bottom:88px;z-index:' + Z_TOP + ';display:flex;gap:8px;align-items:center;';
    const markBtn = mkBtn('标记', true);
    markBtn.id = MARK_BTN_ID;
    markBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); void openPanel('mark'); });
    clusterEl.appendChild(markBtn);
    fixBtnEl = mkBtn('标记不准', false);
    fixBtnEl.id = FIX_BTN_ID;
    fixBtnEl.style.display = 'none';
    fixBtnEl.addEventListener('click', (e: Event) => { e.stopPropagation(); void openPanel('fix'); });
    clusterEl.appendChild(fixBtnEl);
    document.body.appendChild(clusterEl);
}

function removeCluster(): void {
    try { const el = document.getElementById(CLUSTER_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch { /* ignore */ }
    clusterEl = null;
    fixBtnEl = null;
}

function updateFixBtn(eff: EffectiveSkip | null): void {
    if (!fixBtnEl) return;
    // 「标记不准」显示判据：无手动标记（本集/季）且服务端已有跳过数据
    const show = !!(eff && !eff.manual && eff.server && ((eff.server.skipStart > 0 || eff.server.skipEnd > 0)));
    fixBtnEl.style.display = show ? '' : 'none';
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

function mkNumInput(): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = '0';
    i.step = '0.1';
    i.style.cssText = 'width:88px;background:var(--fnos-ui-input-bg,#222639);color:var(--fnos-ui-text,#e8eaf2);'
        + 'border:1px solid var(--fnos-ui-border3,#3a4056);border-radius:6px;padding:4px 6px;font-size:12px;';
    return i;
}

function mkPanelRow(label: string, input: HTMLInputElement, isIntro: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';
    const lab = document.createElement('span');
    lab.textContent = t(label);
    lab.style.cssText = 'font-size:12px;color:var(--fnos-ui-text,#e8eaf2);width:96px;flex-shrink:0;';
    row.appendChild(lab);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.textContent = t('打点');
    dot.style.cssText = 'border:none;border-radius:6px;cursor:pointer;padding:4px 10px;font-size:11.5px;font-weight:600;color:#fff;'
        + 'background:linear-gradient(135deg,rgba(109,127,242,.95),rgba(138,99,232,.95));';
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
    unit.textContent = t('秒');
    unit.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub,#9aa0a6);';
    row.appendChild(unit);
    if (!isIntro) row.setAttribute('data-fntv-outro-row', '1');
    return row;
}

function ensurePanel(): void {
    if (panelEl && document.getElementById(PANEL_ID)) return;
    removePanel();
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.setAttribute(UI_MARK, '1');
    panelEl.setAttribute('role', 'dialog');   // gamepadFocus overlay 容器约定
    panelEl.setAttribute('data-fntv-marker', '1');
    panelEl.style.cssText = 'position:fixed;left:24px;bottom:132px;z-index:' + Z_TOP + ';width:340px;display:none;'
        + 'padding:12px 14px;border-radius:12px;background:rgba(24,27,40,.96);'
        + 'border:1px solid rgba(255,255,255,.08);box-shadow:0 16px 48px rgba(0,0,0,.45);'
        + 'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:700;color:var(--fnos-ui-text,#e8eaf2);margin-bottom:4px;';
    title.textContent = t('片头/片尾手动标记');
    panelEl.appendChild(title);

    fixBadgeEl = document.createElement('div');
    fixBadgeEl.style.cssText = 'display:none;font-size:11px;color:#ffb46b;margin-bottom:4px;';
    fixBadgeEl.textContent = t('修正模式：已预填当前生效值，调整后保存将覆盖自动数据');
    panelEl.appendChild(fixBadgeEl);

    hintEl = document.createElement('div');
    hintEl.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub,#9aa0a6);line-height:1.5;margin-bottom:8px;';
    panelEl.appendChild(hintEl);

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
    seekRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0 8px;';
    const seekIntro = mkBtn('试跳片头尾', true);
    seekIntro.style.padding = '4px 10px';
    seekIntro.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        const end = Number(inIntroEnd && inIntroEnd.value);
        if (!v || !end) { toast('请先标记片头终点'); return; }
        preSeekTime = v.currentTime;
        v.currentTime = end;
        if (backJumpBtn) backJumpBtn.style.display = '';
    });
    const seekOutro = mkBtn('试跳片尾', true);
    seekOutro.style.padding = '4px 10px';
    seekOutro.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const v = getVideo();
        const start = Number(inOutroStart && inOutroStart.value);
        if (!v || !start) { toast('请先标记片尾起点'); return; }
        preSeekTime = v.currentTime;
        v.currentTime = start;
        if (backJumpBtn) backJumpBtn.style.display = '';
    });
    backJumpBtn = mkBtn('回到原位', false);
    backJumpBtn.style.padding = '4px 10px';
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

    // 作用范围
    const scopeRow = document.createElement('div');
    scopeRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:12px;color:var(--fnos-ui-text,#e8eaf2);';
    scopeEpisode = document.createElement('input');
    scopeEpisode.type = 'radio';
    scopeEpisode.name = 'fntv-marker-scope';
    scopeEpisode.value = 'episode';
    scopeSeason = document.createElement('input');
    scopeSeason.type = 'radio';
    scopeSeason.name = 'fntv-marker-scope';
    scopeSeason.value = 'season';
    const labEp = document.createElement('label');
    labEp.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
    labEp.appendChild(scopeEpisode);
    labEp.appendChild(document.createTextNode(t('仅本集')));
    const labSeason = document.createElement('label');
    labSeason.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
    labSeason.appendChild(scopeSeason);
    labSeason.appendChild(document.createTextNode(t('应用到整季')));
    scopeRow.appendChild(document.createTextNode(t('作用范围：')));
    scopeRow.appendChild(labEp);
    scopeRow.appendChild(labSeason);
    panelEl.appendChild(scopeRow);

    // 动作行
    const actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const saveBtn = mkBtn('保存', true);
    saveBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); void savePanel(); });
    restoreBtnEl = mkBtn('恢复自动', false);
    restoreBtnEl.style.display = 'none';
    restoreBtnEl.addEventListener('click', (e: Event) => { e.stopPropagation(); void restoreAuto(); });
    const closeBtn = mkBtn('关闭', false);
    closeBtn.style.padding = '7px 10px';
    closeBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); closePanel(); });
    actRow.appendChild(saveBtn);
    actRow.appendChild(restoreBtnEl);
    actRow.appendChild(closeBtn);
    panelEl.appendChild(actRow);

    document.body.appendChild(panelEl);
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

async function openPanel(mode: 'mark' | 'fix'): Promise<void> {
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

    // 修正模式徽标 + 恢复自动按钮可见性
    const hasManual = !!(eff && eff.manual);
    if (fixBadgeEl) fixBadgeEl.style.display = mode === 'fix' ? '' : 'none';
    if (restoreBtnEl) restoreBtnEl.style.display = hasManual ? '' : 'none';
    if (hintEl) {
        hintEl.textContent = mode === 'fix'
            ? t('自动数据不准？调整数值或重新打点，保存后将覆盖自动数据并写回服务端。')
            : t('播放到片头/片尾时点「打点」记录当前时刻，或直接填秒数；「试跳」可校准。保存后写回飞牛服务端（可在设置关闭）。');
    }

    // 作用范围默认值
    if (scopeEpisode && scopeSeason) {
        scopeEpisode.checked = cfg.defaultScope !== 'season';
        scopeSeason.checked = cfg.defaultScope === 'season';
    }

    panelEl.style.display = '';
}

function closePanel(): void {
    if (panelEl) panelEl.style.display = 'none';
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
    removeCluster();
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
        }
        ensureCluster();
        ensureSkipBtn();
        bindVideo();
        const eff = await refreshEffective(guid);
        if (guid !== currentGuid) return;   // 异步竞态守卫：期间已切集
        updateFixBtn(eff);
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
