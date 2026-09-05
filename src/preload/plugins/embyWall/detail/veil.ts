// embyWall/detail/veil.ts — 页面切换过渡遮罩（lc-1017 自 embyWall.ts 迁出 + 持罩协调）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：导航瞬间铺一层与背景同色的轻纱挡住黑/白闪，然后揭示新页面。
//
// [lc-1017] 为什么要有「持罩」：旧版 veil 在导航后按固定 260ms 计时淡出，而详情页美化的
// 套用要等 hero 渲染（MutationObserver 命中后加 body.fnos-beautify + 注底图）——两者时序
// 对不上时，用户会先看到未美化的原生页，随后整页在一帧内换装 =「突然闪一下」。
// 现在详情页导航时 veil 改为「持罩待美化」：等 applyDetailBeautify 完成后调 releaseNavVeil()
// 再统一淡出揭示；900ms 硬上限兜底强制释放，绝不长遮（hero 一直不来就按原样揭示）。
//
// 用法：
//   runPageTransition(holdForBeautify)  — 导航 hook 内调用；holdForBeautify=目标是详情页
//   releaseNavVeil()                    — 美化套用完成/teardown/幂等早退时调用
// ─────────────────────────────────────────────────────────────────────────────

const VEIL_ID = 'fnos-page-veil';
/** 持罩硬上限(ms)：超时强制淡出，绝不因 hero 未就绪而长期遮挡。 */
const HOLD_MAX_MS = 900;
/** 常规淡出时长(ms)：与旧版 0.26s 保持一致。 */
const FADE_MS = 260;
/** 释放淡出时长(ms)：略长于常规淡出，揭示更从容。 */
const RELEASE_MS = 300;

let _veil: HTMLElement | null = null;
let _holdTimer = 0;

function getVeil(): HTMLElement {
  if (_veil && document.body.contains(_veil)) return _veil;
  const v = document.createElement('div');
  v.id = VEIL_ID;
  v.style.cssText = `position:fixed;top:32px;left:0;right:0;bottom:0;z-index:9000;pointer-events:none;opacity:0;background:var(--fnos-ui-veil);transition:opacity ${FADE_MS}ms ease;border-radius:0 0 16px 16px;overflow:hidden;`;
  document.body.appendChild(v);
  _veil = v;
  return v;
}

/** 导航过渡：瞬间覆盖 0.82 轻纱。
 *  holdForBeautify=true（目标为详情页且美化开着）→ 持罩等 releaseNavVeil()；
 *  false → 按旧版固定时长淡出。性能模式（fnos-perf）不铺遮罩，零合成开销。 */
export function runPageTransition(holdForBeautify: boolean): void {
  if (document.documentElement.classList.contains('fnos-perf')) return;
  clearTimeout(_holdTimer);
  const v = getVeil();
  v.style.transition = 'none';
  v.style.opacity = '0.82';   // 瞬间覆盖, 挡住导航瞬间的黑/白闪
  void v.offsetWidth;          // 强制回流, 让"覆盖"立即生效
  if (holdForBeautify) {
    // 持罩：等美化套用完成（releaseNavVeil）；超时兜底强制释放
    _holdTimer = window.setTimeout(releaseNavVeil, HOLD_MAX_MS);
  } else {
    v.style.transition = `opacity ${FADE_MS}ms ease`;
    requestAnimationFrame(() => { v.style.opacity = '0'; });
  }
}

/** 释放持罩（幂等）：轻纱淡出揭示当前页面。美化套用完成/teardown/兜底计时都会走到这里。 */
export function releaseNavVeil(): void {
  clearTimeout(_holdTimer);
  const v = (_veil && document.body.contains(_veil)) ? _veil : null;
  if (!v) return;
  const cur = parseFloat(v.style.opacity || '0');
  if (cur <= 0) return; // 已在揭示态
  v.style.transition = `opacity ${RELEASE_MS}ms ease`;
  requestAnimationFrame(() => { v.style.opacity = '0'; });
}
