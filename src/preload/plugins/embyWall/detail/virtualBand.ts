// embyWall/detail/virtualBand.ts — [v1.10.2] 选集/演员横滑带「虚拟窗口」全量渲染配套修复
// ─────────────────────────────────────────────────────────────────────────────
// 病灶（用户报障：季页选集竖排只显示首屏 ~11 张卡，其余集永远不出现）：
//   fnOS 原生横滑带组件 RH 自带虚拟列表——选集 band 传
//   virtualList:{itemWidth:260, itemGap:20, overscan:3}（演员 band 120/20/4），
//   只渲染 ceil(clientWidth/条距)+2×overscan 张卡，其余集靠**横向滚动 scrollLeft 变化**
//   滑窗补渲染。美化 D 段改竖排后 overflow:visible → scrollLeft 恒 0 → 窗口冻结。
//   且 React 点按钮/切分区/标记看过会整带重建（新容器+新数组），patch 必须随之补挂
//   （用户报障二：首次进页全量正常，一点按钮就打回 11 张）。
// 修法（保竖排样式不动；纯 CSS 无解——窗口由 React state 掐着）：
//   从滚动容器顺 __reactFiber$ 爬到持有 virtualList 的 fiber，对 props 做双保险：
//   ① items.slice 覆盖为「永远返回全量」；② itemWidth 改 1（条距=21px → 窗口数学
//   自然覆盖整个 range，原生 slice 不覆盖也全渲染）。二者都在下一次窗口重算时生效，
//   故配「预热」：右垫改变 clientWidth → 合成 resize → RH 100ms 去抖重测 → endIndex
//   位移 → 渲染 memo 重算 → 全量上屏。预热带**自验证**：每轮结束比对 DOM 卡数 vs
//   items.length，未达标换垫值再来（≤3 轮，杜绝单轮 debounce 合并/批渲染竞态）。
// 生命周期：_apply 调 schedule（有界重试链）；embyWall 的 _detailObs 常驻观察器在详情页
//   每次 DOM 突变后调 ensure（整带重建的补挂主力）；_softReset/teardown 调 remove
//   （还原 slice/itemWidth 语义、断 watcher）。fnOS 数据刷新换数组实例由 watcher 兜底。
// ⚠ 只认 body.fnos-beautify 作用域：原生横滑页绝不碰，不改变 fnOS 原生虚拟化行为。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findActiveDetailView } from './glass';

/** items 已覆盖标记 / live 类（预热垫）/ 垫值 CSS 变量。 */
const MARK = '__fntvFullSlice';
const LIVE_CLS = 'fnos-vband-live';
const PAD_VAR = '--fntv-vband-pad';
/** 重试链（选集卡可能晚于 hero 到达；跑完即止绝不轮询）。 */
const RETRY_DELAYS = [0, 400, 1000, 2000, 3500];
/** watcher 防抖 / 预热时序。 */
const RECHECK_DELAY = 350;
const WARM_PADS = [300, 150, 450];
const WARM_MEASURE_MS = 320; // live 类垫上→等 RH 去抖(100ms)+重渲染
const WARM_VERIFY_MS = 380;  // live 类撤下→再重测收敛→验证 DOM 卡数

let _timers: number[] = [];
let _obs: MutationObserver | null = null;
let _obsTargets = new WeakSet<Element>();
let _rafId = 0;
let _scheduledFor: string | null = null;
/** 已覆盖的数组与 props（teardown 还原语义）。 */
const _patchedArrays: any[][] = [];
const _patchedProps: any[] = [];

function _clearTimers(): void {
  for (let i = 0; i < _timers.length; i++) clearTimeout(_timers[i]);
  _timers = [];
}

interface VlRef { vl: any; items: any[]; }

/** 从 DOM 节点顺 fiber.return 链上爬，找持有 virtualList 的 props（对象 + items 数组）。 */
function _findVirtualList(el: Element): VlRef | null {
  const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  if (!fk) return null;
  let fiber: any = (el as any)[fk];
  for (let depth = 0; fiber && depth < 60; depth++) {
    const vl = fiber.memoizedProps && fiber.memoizedProps.virtualList;
    if (vl && Array.isArray(vl.items) && vl.items.length) return { vl, items: vl.items as any[] };
    fiber = fiber.return;
  }
  return null;
}

/** 双保险覆盖：slice 全量 + itemWidth=1（条距≈21px → 窗口数学覆盖整个 range）。幂等。 */
function _patchVl(ref: VlRef): boolean {
  const { vl, items } = ref;
  const anyArr = items as any;
  let changed = false;
  if (!anyArr[MARK]) {
    try {
      Object.defineProperty(anyArr, 'slice', {
        value: function (): any[] {
          return Array.prototype.slice.call(this, 0, this.length);
        },
        writable: true,
        configurable: true,
      });
      anyArr[MARK] = true;
      _patchedArrays.push(items);
      changed = true;
    } catch (e) {
      dlog('vband: slice 覆盖失败(frozen?) ' + String(e).substring(0, 60));
    }
  }
  if (vl.itemWidth !== 1) {
    try { vl.itemWidth = 1; _patchedProps.push(vl); changed = true; } catch { /* ignore */ }
  }
  return changed;
}

/** 该带 DOM 里已渲染的卡数（分层：选集卡 → 演员卡 → 序号数字钮；避免卡内 button 污染计数）。 */
function _domCount(band: HTMLElement): number {
  const cards = band.querySelectorAll('[data-id="details"]');
  if (cards.length) return cards.length;
  const persons = band.querySelectorAll('a[href*="/v/person/"]');
  if (persons.length) return persons.length;
  return band.querySelectorAll('button').length;
}

/** 预热（自验证多轮）：live 类**真改宽度**（width:-δ，padding 对 width:auto 块不改变
 *  clientWidth——首版踩坑）+ 程序化横向滚动（喂 RH 自己的 scrollLeft 状态路径）+ 合成
 *  resize，三条路凑一次 clientWidth/scrollLeft 位移 → 窗口重算 → 全量；撤→收敛→验
 *  DOM 卡数，未达标换垫值再来（≤3 轮）。任一轮达标即止；全败留诊断日志（items 已覆盖，
 *  后续任何窗口重算都会全量）。 */
function _warmUp(sc: HTMLElement, items: any[]): void {
  const target = items.length;
  let round = 0;
  const fire = (): void => { try { window.dispatchEvent(new Event('resize')); } catch { /* ignore */ } };
  const step = (): void => {
    if (round >= WARM_PADS.length) {
      dlog('vband: 预热 ' + WARM_PADS.length + ' 轮后仍 dom=' + _domCount(sc) + '/' + target + '（items 已覆盖，待下次窗口重算）');
      return;
    }
    const pad = WARM_PADS[round];
    round++;
    sc.classList.add(LIVE_CLS);
    sc.style.setProperty(PAD_VAR, pad + 'px');
    fire();
    try { sc.scrollLeft = 280 * 8 * round; } catch { /* ignore */ }
    _timers.push(window.setTimeout(() => {
      try { sc.scrollLeft = 0; } catch { /* ignore */ }
      sc.classList.remove(LIVE_CLS);
      fire();
      _timers.push(window.setTimeout(() => {
        const dom = _domCount(sc);
        if (dom >= target) {
          dlog('vband: 预热第' + round + '轮全量达成 dom=' + dom + '/' + target);
          return;
        }
        dlog('vband: 预热第' + round + '轮后 dom=' + dom + '/' + target + '，换垫重试');
        step();
      }, WARM_VERIFY_MS));
    }, WARM_MEASURE_MS));
  };
  step();
}

/** 扫活跃详情视图内的横滑带/数字网格：凡挂 virtualList 的都补覆盖+预热。返回新覆盖数。 */
function _runOnce(): number {
  try {
    if (!document.body || !document.body.classList.contains('fnos-beautify')) return 0;
    const view = findActiveDetailView();
    if (!view) return 0;
    let n = 0;
    const scrollers = view.querySelectorAll(
      '.ms-container, [class*="grid-cols-[repeat(auto-fill,52px"]',
    );
    for (let i = 0; i < scrollers.length; i++) {
      try {
        const sc = scrollers[i] as HTMLElement;
        const ref = _findVirtualList(sc);
        if (!ref) continue;
        if (_patchVl(ref)) {
          n++;
          dlog('vband: 补覆盖 band#' + i + ' items=' + ref.items.length);
          _warmUp(sc, ref.items);
        } else {
          // 已覆盖但窗口可能又被新渲染收窄（如整带重建后忘了带 items）→ DOM 短缺就再预热
          const dom = _domCount(sc);
          if (dom > 0 && dom < ref.items.length) {
            dlog('vband: 窗口短缺 dom=' + dom + '/' + ref.items.length + ' → 再预热');
            _warmUp(sc, ref.items);
          }
        }
        _watch(sc);
      } catch (e) {
        dlog('vband: 单带处理异常 ' + String(e).substring(0, 60));
      }
    }
    return n;
  } catch (e) {
    dlog('vband: runOnce 异常 ' + String(e).substring(0, 80));
    return 0;
  }
}

/** 单带 childList watcher：React 重渲染/换数组实例后补覆盖（随 teardown 撤）。 */
function _watch(sc: HTMLElement): void {
  if (_obsTargets.has(sc)) return;
  _obsTargets.add(sc);
  if (!_obs) {
    _obs = new MutationObserver(() => {
      if (_rafId) return;
      _rafId = window.setTimeout(() => {
        _rafId = 0;
        _runOnce();
      }, RECHECK_DELAY);
    });
  }
  _obs.observe(sc, { childList: true, subtree: true });
}

/** 轻量入口（无重试链、无 href 守卫，幂等）：供 embyWall 的 _detailObs 常驻观察器在
 *  详情页每次 DOM 突变后调用 —— React 点按钮/切分区/标记看过会整带重建，靠这层补挂。 */
export function ensureVirtualBandFix(): void {
  _runOnce();
}

/** settle 后调度：同一 href 只排一次重试链（同 href 重复调用幂等）。 */
export function scheduleVirtualBandFix(): void {
  const href = location.href;
  if (_scheduledFor === href) return;
  _scheduledFor = href;
  _clearTimers();
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _timers.push(window.setTimeout(() => {
      if (_scheduledFor !== location.href) return;
      _runOnce();
    }, RETRY_DELAYS[i]));
  }
}

/** 换页软复位/彻底清理：还原 slice/itemWidth 语义、断 watcher、摘 live 类。 */
export function removeVirtualBandFix(): void {
  _scheduledFor = null;
  _clearTimers();
  if (_rafId) { clearTimeout(_rafId); _rafId = 0; }
  if (_obs) { _obs.disconnect(); _obs = null; }
  _obsTargets = new WeakSet<Element>();
  for (const arr of _patchedArrays) {
    try { delete (arr as any).slice; delete (arr as any)[MARK]; } catch { /* ignore */ }
  }
  _patchedArrays.length = 0;
  for (const vl of _patchedProps) {
    try { delete vl.itemWidth; } catch { /* ignore */ }
  }
  _patchedProps.length = 0;
  const lives = document.querySelectorAll('.' + LIVE_CLS);
  for (let i = 0; i < lives.length; i++) {
    lives[i].classList.remove(LIVE_CLS);
    (lives[i] as HTMLElement).style.removeProperty(PAD_VAR);
  }
}
