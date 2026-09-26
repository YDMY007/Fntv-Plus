import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import { extractCurrentGuid } from './skipInject';
import { t } from '../core/i18n';
import logger from '../core/logger';

// autoplayNext.ts — [lc-1063] 自动连播 + 下一集倒计时（对标 Netflix/Disney+）
// ─────────────────────────────────────────────────────────────────────────────
// 网页播放器播放剩余时间 ≤60s 时右下角浮现「下一集」卡片：海报+标题+倒计时，
//   剩余 ≤5s 自动切下一集（history.pushState 到下一集路由，与飞牛选集点击同构，SPA 内换节目）。
// 数据：IPC skip:next-episode（主进程 getPlayInfo → 剧季 guid → item/list 找下一集，列表带缓存）。
// 交互：取消=本集不再弹；「关闭自动连播」=全局关（localStorage fntv-autonext='0'，卡片内可再开）；
//   回退保护：剩余时间突然变长(用户回跳) → 收卡重新等待窗口。
// MPV 外部播放不需要：播放列表本身会自动顺序播放。

const LS_KEY = 'fntv-autonext';
const APPEAR_AT = 60;      // 剩余 60s 出卡
const AUTO_AT = 5;         // 剩余 5s 自动切
const CARD_ID = 'fntv-autonext-card';

interface NextInfo { found: boolean; guid?: string; title?: string; poster?: string; duration?: number; message?: string; }

let armedGuid: string | null = null;
let nextInfo: NextInfo | null = null;
let dismissedFor: string | null = null;
let pollTimer = 0;
let firedFor: string | null = null;

function enabled(): boolean {
    try { return localStorage.getItem(LS_KEY) !== '0'; } catch { return true; }
}
function setEnabled(v: boolean): void {
    try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

function removeCard(): void {
    const c = document.getElementById(CARD_ID);
    if (c && c.parentNode) c.parentNode.removeChild(c);
}

function fmtTime(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : String(s) + 's';
}

function buildCard(title: string, poster: string): HTMLElement {
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.setAttribute('data-fnos-ui', '1');
    card.style.cssText = [
        'position:fixed', 'right:28px', 'bottom:150px', 'z-index:2147482990',
        'display:flex', 'gap:12px', 'padding:12px', 'width:340px',
        'border-radius:16px', 'cursor:default',
        'background:linear-gradient(165deg,rgba(250,251,254,.98),rgba(240,243,250,.99))',
        'box-shadow:0 18px 50px rgba(40,52,110,.32), inset 0 0 0 1px rgba(255,255,255,.6), inset 0 1px 0 rgba(255,255,255,.85)',
        'backdrop-filter:blur(14px)', '-webkit-backdrop-filter:blur(14px)',
        'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif',
        'transform:translateY(10px)', 'opacity:0',
        'transition:transform .2s ease, opacity .2s ease',
        '-webkit-app-region:no-drag',
    ].join(';') + ';';

    const posterEl = poster
        ? `<img src="${poster}" style="width:56px;height:78px;object-fit:cover;border-radius:8px;flex-shrink:0;background:rgba(90,120,200,.12);" onerror="this.style.visibility='hidden'">`
        : `<div style="width:56px;height:78px;border-radius:8px;flex-shrink:0;background:linear-gradient(165deg,rgba(109,127,242,.35),rgba(138,99,232,.2));"></div>`;

    card.innerHTML = `
        ${posterEl}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">
            <div style="font-size:10.5px;font-weight:800;letter-spacing:2px;color:#4a5fd0;">UP NEXT</div>
            <div style="font-size:13.5px;font-weight:700;color:#262c44;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${title.replace(/"/g, '&quot;')}">${title}</div>
            <div style="font-size:11.5px;color:#5a6480;" id="fntv-an-count">${t('即将自动播放')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;justify-content:center;flex-shrink:0;">
            <button id="fntv-an-play" style="border:none;cursor:pointer;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6d7ff2,#8a63e8);font-family:inherit;">${t('立即播放')}</button>
            <button id="fntv-an-cancel" style="border:none;cursor:pointer;border-radius:9px;padding:6px 12px;font-size:11.5px;font-weight:600;color:#3d4a6e;background:rgba(90,120,200,.12);font-family:inherit;">${t('取消')}</button>
        </div>`;
    return card;
}

function showCard(title: string, poster: string): void {
    let card = document.getElementById(CARD_ID);
    if (card) return;
    card = buildCard(title, poster);
    document.body.appendChild(card);
    requestAnimationFrame(() => {
        card.style.transform = '';
        card.style.opacity = '1';
    });
    (document.getElementById('fntv-an-play') as HTMLElement)?.addEventListener('click', (e) => {
        e.stopPropagation();
        goNext();
    });
    (document.getElementById('fntv-an-cancel') as HTMLElement)?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (armedGuid) dismissedFor = armedGuid;
        removeCard();
    });
    const off = document.createElement('div');
    off.textContent = t('关闭自动连播');
    off.style.cssText = 'position:absolute;top:8px;right:10px;font-size:10px;color:#8a93ad;cursor:pointer;user-select:none;';
    off.title = '关闭后可随时在卡片外重新开启（浏览器控制台 localStorage.setItem 切回 1）';
    off.addEventListener('click', (e) => {
        e.stopPropagation();
        setEnabled(false);
        if (armedGuid) dismissedFor = armedGuid;
        removeCard();
    });
    card.appendChild(off);
}



function goNext(): void {
    if (!nextInfo || !nextInfo.guid || !armedGuid) return;
    if (firedFor === armedGuid) return;
    firedFor = armedGuid;
    const target = location.pathname.replace(armedGuid, nextInfo.guid);
    removeCard();
    logger.info('自动连播 → ' + target);
    history.pushState({}, '', target);
}

function fireNext(): void { goNext(); }


// ── 主轮询 ──
function pollTick(): void {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    const card = document.getElementById(CARD_ID);
    if (!v || !v.duration || !isFinite(v.duration)) { if (card) removeCard(); return; }
    const guid = extractCurrentGuid();
    if (!guid) { if (card) removeCard(); return; }
    if (armedGuid !== guid) { armedGuid = guid; nextInfo = null; dismissedFor = null; void arm(guid); }
    if (!enabled()) { if (card) removeCard(); return; }
    if (firedFor === guid) return; // 已导航

    const remaining = v.duration - v.currentTime;
    if (dismissedFor === guid) { if (card) removeCard(); return; }
    if (remaining > APPEAR_AT + 30) { // 回跳保护：剩余突然变长 → 收卡重等
        if (card) removeCard();
        return;
    }
    if (remaining <= AUTO_AT) { goNext(); return; }
    if (remaining <= APPEAR_AT && nextInfo && nextInfo.found) {
        const title = nextInfo.title || t('下一集');
        showCard(title, nextInfo.poster || '');
        const cnt = document.getElementById('fntv-an-count');
        if (cnt) {
            cnt.textContent = remaining > AUTO_AT + 10
                ? t('本集剩余 {n}s · 即将自动播放下一集', { n: Math.ceil(remaining) })
                : t('{n} 秒后自动播放下一集', { n: Math.ceil(remaining - AUTO_AT) });
        }
    }
}

async function arm(guid: string): Promise<void> {
    try {
        const r = await ipcRenderer.invoke('skip:next-episode', { guid }) as NextInfo;
        if (armedGuid === guid) nextInfo = r && r.found ? r : null;
        if (nextInfo) logger.info('已取得下一集: ' + (nextInfo.title || nextInfo.guid));
    } catch (e) {
        logger.info('下一集查询失败: ' + String(e).substring(0, 80));
    }
}



// ── 注册 ──
registerHook(HookType.OnReady, () => {
    window.setInterval(() => {
        try {
            const v = document.querySelector('video') as HTMLVideoElement | null;
            if (!v) { if (document.getElementById(CARD_ID)) removeCard(); return; }
            pollTick();
        } catch { /* ignore */ }
    }, 1000);
});
