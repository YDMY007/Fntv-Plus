// preload/plugins/cardTapZone.ts
//
// [lc-1331] 首页卡片「误触浮层圆钮」修复。
// 用户报障：「继续观看卡片的播放要优化，老是点击到下面的三个其他控件按钮」。
//
// 现场（真机截图 phone-18.png，720×1570 物理 / density 320 → 360×785dp）：
//   卡片 hover/选中时浮出一层操作区 —— 中间是播放圆钮（≈47dp），**卡片下缘**左右是
//   已看（眼睛）/更多（•••）一类小圆钮；它们的**可见图形只有 ~16-18dp**，但外壳
//   按触控目标补了 padding（≈40dp+）→ 卡片下半部分几乎整片被这几个钮吃掉，
//   用户想点播放却总落在它们身上。
//
// 做法（不改飞牛业务代码，只动**命中区**）：
//   把这类「小圆钮外壳」设 pointer-events:none，只给可见图形（最内层 svg/单子节点）
//   保留 pointer-events:auto ——
//     · 点在图形上：事件照旧冒泡到外壳上的原生处理器，按钮功能一字不变；
//     · 点在图形之外（外壳的 padding 区）：穿透到下面的播放遮罩 → 播放。
//   三处刻意不动：
//     · 居中的播放圆钮（±18% 卡片中心内）—— 它就是用户要点的目标；
//     · 覆盖整卡的遮罩 / 整卡链接（尺寸 > 卡片 50%）；
//     · 卡片上半部分的东西（浮层圆钮只在卡片下缘）。
//   只处理触摸设备（html.fnos-touch）：桌面用鼠标点得准，且浮层只有 hover 才出现。
//
// 若某张卡片的浮层是「按需渲染」（hover 才插入 DOM），靠 OnDomChange（body 子树
// MutationObserver）在插入后再收窄一次；已处理元素打 data-fntv-tapfix 防重复。

import { registerHook, HookType } from '../core/hooks';
import logger from '../core/logger';

const log = logger;

/** 首页卡片（继续观看 / 海报行 / 剧集行都在这类容器里） */
const CARD_SEL = '.ms-container [class*="card-root"]';
const MARK_ATTR = 'data-fntv-tapfix';
/** 外壳允许的最大边长：超过就不是「圆钮」，而是工具条/遮罩，不能动 */
const MAX_WRAP_PX = 64;

function within(inner: DOMRect, outer: DOMRect, pad = 4): boolean {
    return inner.left >= outer.left - pad && inner.right <= outer.right + pad
        && inner.top >= outer.top - pad && inner.bottom <= outer.bottom + pad;
}

/** 从「可见图形（svg）」向上找它的**外壳**：最外层仍然够小、且在卡片内的祖先。
 *
 *  ⚠ 不能用「类名/标签枚举候选」——真机上这类圆钮的外壳就是普通 div（没有
 *  cursor-pointer 类、也不是 button），枚举法会整片漏掉（verify-card-tap-zone.mjs
 *  的第一版就是这么漏的）。以**图形为锚**向上收，才不依赖站点命名。 */
function pickShrinkable(card: HTMLElement, cr: DOMRect): Array<{ wrap: Element; core: Element }> {
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const out: Array<{ wrap: Element; core: Element }> = [];
    const seen = new Set<Element>();

    for (const core of Array.from(card.querySelectorAll('svg'))) {
        const r = core.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;                     // 装饰性小点/退化图形
        const ex = (r.left + r.right) / 2;
        const ey = (r.top + r.bottom) / 2;
        // 居中的图形是「播放」三角：那是用户要点的目标，保留原命中区
        if (Math.abs(ex - cx) < cr.width * 0.18 && Math.abs(ey - cy) < cr.height * 0.25) continue;
        // 浮层圆钮贴在卡片下缘；上半部分的图形（封面角标等）不碰
        if (ey < cr.top + cr.height * 0.5) continue;

        // 向上收外壳：只要还「小」且在卡内，就继续往上换更大的外壳
        let wrap: Element = core;
        let p: Element | null = core.parentElement;
        while (p && p !== card) {
            const pr = p.getBoundingClientRect();
            if (pr.width > MAX_WRAP_PX || pr.height > MAX_WRAP_PX) break;
            if (pr.width > cr.width * 0.5 || pr.height > cr.height * 0.6) break;
            if (!within(pr, cr)) break;
            wrap = p;
            p = p.parentElement;
        }
        if (wrap === core) continue;                                   // 没有独立外壳 → 命中区本来就等于图形
        if (seen.has(wrap)) continue;
        seen.add(wrap);
        out.push({ wrap, core });
    }
    return out;
}

function processCard(card: Element): void {
    const c = card as HTMLElement;
    if (!c || c.getAttribute(MARK_ATTR)) return;
    c.setAttribute(MARK_ATTR, '1');
    const cr = c.getBoundingClientRect();
    if (cr.width < 40 || cr.height < 24) return;
    let n = 0;
    for (const { wrap, core } of pickShrinkable(c, cr)) {
        (wrap as HTMLElement).style.setProperty('pointer-events', 'none', 'important');
        (core as HTMLElement).style.setProperty('pointer-events', 'auto', 'important');
        n++;
    }
    if (n) log.info('[cardTapZone] 收窄浮层圆钮命中区: ' + n + ' 个');
}

function apply(): void {
    try {
        if (!document.documentElement.classList.contains('fnos-touch')) return;   // 只处理触摸设备
        document.querySelectorAll(CARD_SEL).forEach(processCard);
    } catch (e: any) {
        log.warn('[cardTapZone] 处理失败:', e?.message || e);
    }
}

let _timer: number | null = null;
function applyDebounced(): void {
    if (_timer !== null) return;
    _timer = window.setTimeout(() => { _timer = null; apply(); }, 300) as unknown as number;
}

registerHook(HookType.OnReady, apply);
registerHook(HookType.OnDomChange, applyDebounced);
export {};