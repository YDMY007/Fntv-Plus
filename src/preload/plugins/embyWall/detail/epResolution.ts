// embyWall/detail/epResolution.ts — 清晰度标识改写（lc-984）
// ─────────────────────────────────────────────────────────────────────────────
// 诉求：fnOS 原生把清晰度(「1080」)做成贴在缩略图上的 absolute 角标，竖排后位置不对；
//       改成「每个集标题后面的小胶囊」。
//
// 为什么必须动 JS（承接 lc-980「CSS-first + 只做加法」约束）：
//   把 A 节点的文字搬到 B 节点末尾属于跨父级重排，CSS 做不到。这里的做法仍是加法：
//   ① 给原生角标**加一个 class**，由 CSS 隐藏它——不改它的位置/属性/文本，React 视角毫无变化；
//   ② 在标题 <p> 内 appendChild 一个**全新 span**——纯新增节点，不搬运任何 React 节点。
//   teardown 摘 class + 移除 span → 原生角标原样复原，完全可逆。
//
// 定位依据（实证，非猜测）：
//   标题路径 = 卡片内「含 <p> 的 <a>」的首个 <p>。沿用 lc-957 时代 findCardTitleLink 的实机结论
//   （旧 season.ts:842 `Array.from(card.querySelectorAll('a')).find(el => el.querySelector('p'))`）。
//   原生角标**无稳定 class**（lc-982 时代的 .fnos-ep-badge 是旧实现自己注入的、文本硬编码「高清」，
//   不是 fnOS 原生节点）→ 只能按文本形态识别：叶子元素 + 整串匹配清晰度词表。
//
// 作用域：只在**活跃详情视图**内查 [data-id="details"]。首页「继续观看」卡 .continue-card-root
//   也带 data-id="details"（见 memory/fnos-detail-dom.md），不限域会误伤。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findActiveDetailView } from './glass';

/** 注入的胶囊 class（teardown 按它清理）。 */
const PILL = 'fnos-ep-res';
/** 打在原生角标上的隐藏标记 class（teardown 按它摘除）。 */
const HIDE = 'fnos-res-native-hidden';

/** 清晰度词表：整串相等才算（`^...$`），避免命中剧情简介里的「1080」等文字。 */
const RES_RE = /^(4K|UHD|HD|SD|2160p?|1440p?|1080p?|720p?|576p?|480p?|360p?|高清|超清|标清|蓝光|流畅)$/i;

/** 选集卡可能晚于 hero 到达（hero 就绪 ≠ 选集数据就绪）→ 有上限的重试链。
 *  刻意不用 setInterval / 常驻 observer：每次都是幂等轻扫，跑完即止（旧版病根是永久轮询）。 */
const RETRY_DELAYS = [0, 350, 900, 1800, 3000];

let _scheduledFor: string | null = null;
let _timers: number[] = [];

function _clearTimers(): void {
  for (let i = 0; i < _timers.length; i++) clearTimeout(_timers[i]);
  _timers = [];
}

/** 卡片内的原生清晰度角标：先按文本形态找到叶子，再向上爬到「角标盒子」本身。
 *  为什么要爬：若角标是「带底色/圆角的外层 div + 内层 span 文本」，只藏 span 会在缩略图上留一个空色块。
 *  爬升三条件(缺一不可)：① 父不是卡片本身 ② 父整串文本仍等于该清晰度文本 ③ 父只有一个元素子节点。
 *  ③ 是关键护栏：播放按钮 overlay 的文本也可能只有「1080」(按钮是 svg/img 无文本)，
 *     若不限制子节点数就会爬进 overlay 把播放按钮一起藏掉。 */
function _findNativeBadge(card: Element): HTMLElement | null {
  const all = card.querySelectorAll('*');
  let leaf: HTMLElement | null = null;
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (el.classList.contains(PILL)) continue;
    if (el.children.length) continue; // 只要叶子：否则会命中包住整卡文本的容器
    const t = (el.textContent || '').trim();
    if (t && RES_RE.test(t)) { leaf = el; break; }
  }
  if (!leaf) return null;
  const text = (leaf.textContent || '').trim();
  let box = leaf;
  for (;;) {
    const p = box.parentElement;
    if (!p || p === card) break;
    if ((p.textContent || '').trim() !== text) break;
    if (p.children.length !== 1) break;
    box = p;
  }
  return box;
}

/** 标题 <p>：卡片内「含 <p> 的 <a>」的首个 <p>；无 <a> 时退回卡片首个 <p>。 */
function _findTitleP(card: Element): HTMLElement | null {
  const links = card.querySelectorAll('a');
  for (let i = 0; i < links.length; i++) {
    const p = links[i].querySelector('p');
    if (p) return p as HTMLElement;
  }
  return card.querySelector('p') as HTMLElement | null;
}

/** 处理一张卡（幂等：已有胶囊直接跳过）。返回是否改动了 DOM。 */
function _decorate(card: Element): boolean {
  if (card.querySelector('.' + PILL)) return false;
  const badge = _findNativeBadge(card);
  if (!badge) return false;
  const titleP = _findTitleP(card);
  if (!titleP) return false; // 找不到标题就宁可不隐藏角标，绝不做「藏了旧的又没新的」
  const res = (badge.textContent || '').trim();
  const pill = document.createElement('span');
  pill.className = PILL;
  pill.textContent = res;
  titleP.appendChild(pill); // inline span → 天然紧跟标题文字，无需 flex/grid
  badge.classList.add(HIDE);
  return true;
}

/** 扫一遍当前活跃视图里的选集卡。每次重试都重新取视图，兜住 React 重挂载导致的节点失效。 */
function _run(): number {
  const view = findActiveDetailView();
  if (!view) return 0;
  const cards = view.querySelectorAll('[data-id="details"]');
  let n = 0;
  for (let i = 0; i < cards.length; i++) if (_decorate(cards[i])) n++;
  return n;
}

/** settle 后调度：同一 href 只排一次重试链，非阻塞。 */
export function scheduleEpResolution(): void {
  const href = location.href;
  if (_scheduledFor === href) return;
  _scheduledFor = href;
  _clearTimers();
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    _timers.push(window.setTimeout(() => {
      if (_scheduledFor !== location.href) return; // 已离开该页 → 放弃这次
      const n = _run();
      if (n) dlog('beautify: 清晰度胶囊注入 ' + n + ' 张选集卡');
    }, RETRY_DELAYS[i]));
  }
}

/** 还原（离开详情页 / 关美化开关 / 换页 soft-reset）：移除胶囊 + 摘掉隐藏标记。 */
export function removeEpResolution(): void {
  _clearTimers();
  _scheduledFor = null;
  const pills = document.querySelectorAll('.' + PILL);
  for (let i = 0; i < pills.length; i++) {
    const p = pills[i];
    if (p.parentNode) p.parentNode.removeChild(p);
  }
  const hidden = document.querySelectorAll('.' + HIDE);
  for (let i = 0; i < hidden.length; i++) hidden[i].classList.remove(HIDE);
}

/** 诊断（Console 手跑）：胶囊没出现时看这一份即可定位。
 *  原生角标无稳定 class、只能按文本形态启发式识别 → 实机没命中时无法远程推断原因，
 *  故把「命中了什么/标题 p 是谁/卡片由哪些子节点构成」全量吐出来。 */
export function epResolutionDiag(): any {
  const view = findActiveDetailView();
  if (!view) return { error: '活跃详情视图未找到(.trim-ui__cache-outlet--exclude)' };
  const cards = view.querySelectorAll('[data-id="details"]');
  return {
    href: location.pathname,
    beautify: document.body.classList.contains('fnos-beautify'),
    cardCount: cards.length,
    pillCount: document.querySelectorAll('.' + PILL).length,
    hiddenCount: document.querySelectorAll('.' + HIDE).length,
    cards: Array.from(cards).slice(0, 3).map((card) => {
      const badge = _findNativeBadge(card);
      const titleP = _findTitleP(card);
      const bp = badge && badge.parentElement;
      return {
        childClasses: Array.from(card.children).map((c) => String(c.className).slice(0, 70)),
        badgeText: badge ? (badge.textContent || '').trim() : null,
        badgeNode: badge ? badge.tagName + '.' + String(badge.className).slice(0, 60) : null,
        badgeParent: bp ? bp.tagName + '.' + String(bp.className).slice(0, 60) : null,
        titleText: titleP ? (titleP.textContent || '').trim().slice(0, 30) : null,
        titleClasses: titleP ? String(titleP.className).slice(0, 70) : null,
        hasPill: !!card.querySelector('.' + PILL),
      };
    }),
  };
}
