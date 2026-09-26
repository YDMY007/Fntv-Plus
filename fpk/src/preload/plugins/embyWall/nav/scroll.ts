import { S } from '../state';

// embyWall/nav/scroll.ts — 滚动与视口适配：matchMedia 拦截（窄屏模式）、横向滚轮滚动
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

/* ========== 拦截matchMedia ========== */
(function narrowMode(): void {
  try {
    const orig = window.matchMedia;
    const origFn = orig.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const mql = origFn(query);
      if (query.includes('1024')) {
        Object.defineProperty(mql, 'matches', { get: () => false, configurable: true });
      }
      return mql;
    };
  } catch (e) { /* ignore */ }
})();

/* ========== 横滑滚轮 ========== */
// 记录每个元素已绑定的 wheel 处理器，便于关闭开关时精确移除（removeEventListener 需同一引用）
const _wtsBound = new WeakMap<HTMLElement, (ev: WheelEvent) => void>();

export function wheelToScroll(): void {
  // 关闭开关 → 解绑所有劫持监听，并清除我们附加在飞牛原生横滑箭头上的样式，
  // 把 display/opacity/pointer-events 全部交还 fnOS 原生逻辑（箭头照常显示）。
  if (!S.wheelHScrollEnabled) {
    document.querySelectorAll('[data-ws="1"]').forEach((e) => {
      const he = e as HTMLElement;
      const h = _wtsBound.get(he);
      if (h) { he.removeEventListener('wheel', h as EventListener); _wtsBound.delete(he); }
      delete he.dataset.ws;
    });
    // 同时清掉旧版(wheelHScroll=display:none)可能残留的内联样式，确保原生箭头恢复
    document.querySelectorAll('[class*="semi-color-bg-arrow-mask"]').forEach((e) => {
      const el = e as HTMLElement;
      el.style.display = '';
      el.style.opacity = '';
      el.style.pointerEvents = '';
    });
    return;
  }
  // 开启开关 → 竖向滚轮在横向溢出容器内转为左右滑动。
  // 关键：飞牛(Semi ScrollList)横向箭头的可见性由其原生激活逻辑控制，
  // 一旦用 display:none 隐藏就会破坏该逻辑、且关闭后无法自行恢复。
  // 因此只以 opacity:0 + pointer-events:none 做「视觉隐藏」，**绝不碰 display**，
  // 这样关闭时清除上述样式即可让 fnOS 原生箭头完整恢复。
  document.querySelectorAll('[class*="semi-color-bg-arrow-mask"]').forEach((e) => {
    const el = e as HTMLElement;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  });
  document.querySelectorAll('div,section,main').forEach((e) => {
    const he = e as HTMLElement;
    if (he.dataset.ws === '1') return;
    const cs = getComputedStyle(he);
    if ((cs.overflowX === 'scroll' || cs.overflowX === 'auto') && he.scrollWidth > he.clientWidth + 2) {
      he.dataset.ws = '1';
      const handler = (ev: WheelEvent): void => {
        const r = he.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX) * 2) return;
        ev.preventDefault();
        he.scrollLeft += ev.deltaY * 1.5;
      };
      _wtsBound.set(he, handler);
      he.addEventListener('wheel', handler as EventListener, { passive: false });
    }
  });
}
