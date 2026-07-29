/**
 * 列表页布局修复插件 (lc-109)
 *
 * 问题: fnOS 媒体库/番剧列表页右侧大片留白（侧边栏强制显示后更明显）
 * 目标: 让卡片区域左右留白对称（"左右白边一样宽"）。
 *
 * 方案: 测量收敛 + 锁定（最终方案）。
 *   ① 初算: 确定性公式给一个初始 padding（可能不准，仅作起点）。
 *   ② 微调: 等 reflow 后实测左右 gap 差 → 补偿一半 → 逼近真正居中。
 *   ③ 锁定: 连续两次测量确认值稳定后【锁定】——之后无论虚拟滚动怎么
 *      触发 DOM 变化都不再动 padding。只有「路由变化」或「容器宽度
 *      变化(resize)」才解锁重算。
 *   ④ 绝不清除已应用的 padding（之前在 MutationObserver 里清 padding
 *      是"页面反复横跳回原生左对齐"的直接原因）。
 *
 * 历史教训（重要，勿重蹈覆辙）：
 *   ① CSS注入 → 被fnOS后续样式覆盖
 *   ② flex+justify-content:center → 停止换行溢出偏右
 *   ③ margin:auto/fit-content → flex容器上无效/异常
 *   ④ CSS Grid → 改display有风险
 *   ⑤ transform:translateX → 居中生效但滚轮变横向滚动
 *   ⑥ padding+纯实测内容宽 → 虚拟滚动测量值乱跳+死循环+882px挤爆
 *   ⑦ 纯确定性padding → 参数误差(列数算错)导致宽屏下偏左
 *   ⑧ 两阶段但Observer里清padding重算 → 虚拟滚动触发清除→左右反复横跳
 *   ⑨ [当前] 测量收敛 + 双确认锁定 + 绝不清除 → 稳定、精确、不闪
 */

import { registerHook, HookType } from '../core/hooks';

const MIN_PAD = 20; // 每侧最小留白

/**
 * 判断当前是否为详情页（不应在此类页面执行列表居中逻辑）
 * 详情页路径: /v/tv/{guid}、/v/movie/{guid} 及其子路由（season 等）
 * 列表页路径: /v/、/v/library/*、/v/search 等
 */
function isDetailPage(): boolean {
    return /^(\/v\/(tv|movie)\/[a-f0-9]{32})/.test(location.pathname);
}

/** 找到真正的卡片网格：flex-wrap + gap-x、子元素>=2 且首个子元素是海报卡（够高） */
function findCardGrid(): HTMLElement | null {
    const candidates = Array.from(
        document.querySelectorAll('[class*="flex-wrap"][class*="gap-x"]')
    ) as HTMLElement[];
    let best: HTMLElement | null = null;
    for (const el of candidates) {
        if (el.children.length < 2) continue;
        const first = el.children[0] as HTMLElement;
        const r = first.getBoundingClientRect();
        // 海报卡约 162x294；筛选条/标签等小元素高度远小于 150 → 排除
        if (r.width < 80 || r.width > 400 || r.height < 150) continue;
        if (!best || el.children.length > best.children.length) best = el;
    }
    return best;
}

// ===== 锁定状态 =====
let lockedKey = '';      // 锁定时的 "路由|容器宽"，二者任一变化即失锁
let lastPad = -1;        // 上一次测量得到的 pad
let confirmCount = 0;    // 连续确认次数（≥2 才锁定）

function makeKey(parent: HTMLElement): string {
    return location.pathname + '|' + parent.clientWidth;
}

/**
 * 应用修复。返回 true = 已锁定完成（轮询可停）。
 * 流程: 无 inline padding 时先写确定性初算值 → rAF 后实测微调 →
 *       连续两次测量一致(≤2px)则锁定。
 */
function applyFix(): boolean {
    // ⛔ 详情页不执行列表居中逻辑（lc-190修复：详情页被误加巨大padding导致内容变窄）
    if (isDetailPage()) return false;

    const card = findCardGrid();
    if (!card) return false;

    const parent = card.closest('.ms-container') as HTMLElement | null;
    if (!parent) return false;

    const key = makeKey(parent);
    if (lockedKey === key) return true; // 已锁定：什么都不做（虚拟滚动随便变）
    if (lockedKey && lockedKey !== key) {
        // 路由/宽度变了 → 失锁重来（不清除旧 padding，直接在其基础上微调）
        lockedKey = '';
        lastPad = -1;
        confirmCount = 0;
    }

    const parentW = parent.clientWidth;
    const cardW = (card.children[0] as HTMLElement).getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(card).columnGap) || 20;
    if (cardW < 80 || parentW < 400) return false;

    // ① 首次（无 inline padding）先给一个确定性初算起点
    if (!parent.style.paddingLeft) {
        const avail = parentW - MIN_PAD * 2;
        let cols = Math.floor((avail + gap) / (cardW + gap));
        if (cols < 1) cols = 1;
        if (cols > card.children.length) cols = card.children.length;
        const rowW = cols * cardW + (cols - 1) * gap;
        const initialPad = Math.max(MIN_PAD, Math.round((parentW - rowW) / 2));
        parent.style.setProperty('padding-left', initialPad + 'px', 'important');
        parent.style.setProperty('padding-right', initialPad + 'px', 'important');
        console.log(`[listLayout] 初算 padding ${initialPad}px（容器${parentW}px，等待测量微调…）`);
    }

    // ② 等 reflow 后实测微调 + 双确认锁定
    requestAnimationFrame(() => {
        try {
            // 元素可能已被路由切换销毁
            if (!document.contains(parent) || !document.contains(card)) return;

            const pRect = parent.getBoundingClientRect();
            let minLeft = Infinity;
            let maxRight = 0;
            for (let i = 0; i < card.children.length; i++) {
                const r = card.children[i].getBoundingClientRect();
                if (r.left < minLeft) minLeft = r.left;
                if (r.right > maxRight) maxRight = r.right;
            }
            if (!isFinite(minLeft) || maxRight <= minLeft) return;

            const leftGap = minLeft - pRect.left;
            const rightGap = pRect.right - maxRight;
            const diff = rightGap - leftGap; // 正=右边多(偏左)
            const current = parseFloat(parent.style.paddingLeft) || MIN_PAD;
            const target = Math.max(MIN_PAD, Math.round(current + diff / 2));

            if (Math.abs(target - current) <= 2) {
                // 测量确认当前值已居中
                if (lastPad === current) {
                    confirmCount++;
                } else {
                    lastPad = current;
                    confirmCount = 1;
                }
                if (confirmCount >= 2 && !lockedKey) {
                    lockedKey = makeKey(parent);
                    console.log(`[listLayout] 已锁定：padding ${current}px 居中对称（${lockedKey}）`);
                }
            } else {
                // 仍有偏差 → 补偿一半，下一轮继续逼近
                parent.style.setProperty('padding-left', target + 'px', 'important');
                parent.style.setProperty('padding-right', target + 'px', 'important');
                lastPad = target;
                confirmCount = 1;
                console.log(`[listLayout] 微调 padding ${current}→${target}px（左${Math.round(leftGap)} / 右${Math.round(rightGap)}）`);
            }
        } catch (_) { /* ignore */ }
    });

    return false; // 未锁定前继续轮询（轮询里会走确认流程）
}

let polling = false;
/** 启动轮询：直到锁定或超时。applyFix 已锁定时开销≈0 */
function startPolling(): void {
    if (polling) return;
    polling = true;
    let tries = 0;
    const id = window.setInterval(() => {
        tries++;
        const done = applyFix();
        if (done || tries > 40) {
            window.clearInterval(id);
            polling = false;
        }
    }, 400);
}

/**
 * 监控 SPA 路由切换 + resize。
 * 注意：绝不清除已应用的 padding（历史教训⑧：清除会导致页面闪回原生左对齐）。
 * 锁定 key 含「路由 + 容器宽」，任一变化 applyFix 自会失锁重算。
 */
let navObserver: MutationObserver | null = null;
let lastPath = location.pathname;
function watchChanges(): void {
    if (navObserver || !document.body) return;
    navObserver = new MutationObserver(() => {
        // 仅在路由真的变化时重启轮询；虚拟滚动的 DOM 变化直接忽略
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            startPolling();
        } else if (!lockedKey) {
            // 未锁定期间（首屏渐进渲染）也允许推进
            startPolling();
        }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('resize', () => {
        requestAnimationFrame(() => startPolling());
    });
}

console.log('[listLayout] 插件已加载');
registerHook(HookType.OnReady, () => {
    startPolling();
    watchChanges();
});
registerHook(HookType.OnDomChange, startPolling);
