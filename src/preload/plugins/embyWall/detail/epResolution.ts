// embyWall/detail/epResolution.ts — 清晰度标识改写（lc-984 建，lc-986 按真实 DOM 返工）
// ─────────────────────────────────────────────────────────────────────────────
// 诉求：fnOS 原生把清晰度标识做成贴在缩略图右下的 absolute 角标，竖排后观感不对；
//       改成「每个集标题后面的小标识」。
//
// 为什么必须动 JS（承接 lc-980「CSS-first + 只做加法」约束）：
//   把 A 节点的内容搬到 B 节点末尾属于跨父级重排，CSS 做不到。这里的做法仍是加法：
//   ① 给原生角标**加一个 class**，由 CSS 隐藏它——不改它的位置/属性/src，React 视角毫无变化；
//   ② 在标题 <p> 内 appendChild 一个**全新 span**——纯新增节点，不搬运任何 React 节点。
//   teardown 摘 class + 移除 span → 原生角标原样复原，完全可逆。
//
// 定位依据（实证，非猜测）：
//   ⚠ lc-984 的教训：那版按「文本叶子 + 清晰度词表」识别角标，自测 6 个用例全 PASS，
//     但**用例是我照自己想象搭的假 DOM**。用户贴出真实 DOM 后才知道角标根本不是文本，
//     而是一张 base64 位图 → 词表永远失配 → 那版功能一次都没生效。
//   真实结构（用户 2026-09-03 提供）：
//     [data-id="details"] > div.rounded-lg.relative.mb-3.flex.h-[146px].w-full.shrink-0.overflow-hidden
//       > div.absolute.bottom-0.right-0.h-[76px](底部渐变层)
//         > div.absolute.bottom-2.5.right-2.5.flex.w-full.items-end.justify-end.gap-1.5
//           > div.flex.h-[22px].items-center > img[src^="data:image/png;base64"][alt=""]
//   → 改按 src 形态识别 + **克隆位图**（图里画的是 1080/4K/HDR 无从读取，克隆是唯一保真做法）。
//   标题路径 = 卡片内「含 <p> 的 <a>」的首个 <p>（lc-957 时代实机结论，旧 season.ts:842）。
//     真实 DOM 已顺带验证其安全性：缩略图里 hover overlay 的 <a href="/v/tv/episode/…"> 内不含 <p>，
//     会被第一轮循环跳过，不会把标识塞进播放按钮。
//
// 作用域：只在**活跃详情视图**内查 [data-id="details"]。首页「继续观看」卡 .continue-card-root
//   也带 data-id="details"（见 memory/fnos-detail-dom.md），不限域会误伤。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findActiveDetailView } from './glass';

/** 注入的标识容器 class（teardown 按它清理）。 */
const PILL = 'fnos-ep-res';
/** 容器内克隆出来的位图 class（beautifyStyle.ts J 段按它定尺寸）。 */
const PILL_IMG = 'fnos-ep-res-img';
/** 打在原生角标上的隐藏标记 class（teardown 按它摘除）。 */
const HIDE = 'fnos-res-native-hidden';

/** 选集卡可能晚于 hero 到达（hero 就绪 ≠ 选集数据就绪）→ 有上限的重试链。
 *  刻意不用 setInterval / 常驻 observer：每次都是幂等轻扫，跑完即止（旧版病根是永久轮询）。 */
const RETRY_DELAYS = [0, 350, 900, 1800, 3000];

let _scheduledFor: string | null = null;
let _timers: number[] = [];

function _clearTimers(): void {
  for (let i = 0; i < _timers.length; i++) clearTimeout(_timers[i]);
  _timers = [];
}

/** 卡内的原生清晰度标识位图（可能多张）。
 *  按 src 形态识别：缩略图容器内的 data: 位图只有这一类——
 *    · 主缩略图是 /v/api/v1/sys/img/…webp（网络路径，不是 data:）；
 *    · 播放按钮是 CSS mask 的 div[data-id="play"]，三个图标按钮是 <svg>，都不是 <img>。
 *  外层用 gap-1.5 排布，说明该行可能同时挂多张（如 清晰度 + 音画格式）→ 全部返回，逐张克隆。 */
function _findBadgeImgs(card: Element): HTMLImageElement[] {
  const thumb = card.firstElementChild;
  if (!thumb) return [];
  const imgs = thumb.querySelectorAll('img[src^="data:image/"]');
  const out: HTMLImageElement[] = [];
  for (let i = 0; i < imgs.length; i++) out.push(imgs[i] as HTMLImageElement);
  return out;
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

/** 处理一张卡（幂等：已有标识直接跳过）。返回是否改动了 DOM。 */
function _decorate(card: Element): boolean {
  if (card.querySelector('.' + PILL)) return false;
  const badges = _findBadgeImgs(card);
  if (!badges.length) return false;
  const titleP = _findTitleP(card);
  if (!titleP) return false; // 找不到标题就宁可不隐藏角标，绝不做「藏了旧的又没新的」
  const pill = document.createElement('span');
  pill.className = PILL;
  const holders: HTMLElement[] = [];
  for (let i = 0; i < badges.length; i++) {
    const src = badges[i].getAttribute('src') || '';
    if (!src) continue;
    const img = document.createElement('img');
    img.className = PILL_IMG;
    img.src = src;  // base64 已在内存，克隆不产生新请求
    img.alt = badges[i].getAttribute('alt') || '';
    pill.appendChild(img);
    const holder = badges[i].parentElement; // div.flex.h-[22px].items-center
    if (holder && holder !== card) holders.push(holder);
  }
  if (!pill.children.length) return false; // 一张都没克隆成 → 原生角标原样不动
  titleP.appendChild(pill); // inline span → 天然紧跟标题文字，无需 flex/grid
  for (let i = 0; i < holders.length; i++) holders[i].classList.add(HIDE);
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
      if (n) dlog('beautify: 清晰度标识注入 ' + n + ' 张选集卡');
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

/** 诊断（Console 手跑）：一次同时回答两件事——
 *  ① 缩略图塌陷修好没有（thumbBox.h 应约 101；若仍是个位数说明 aspect-ratio 没生效）；
 *  ② 清晰度标识命中没有（badgeCount / hasPill / hiddenCount）。
 *  我这边跑不了真实 Electron（浏览器 MCP 是无 preload 的独立 Chrome，SPA 恒卡加载中），
 *  所以把判据做成一眼可读的数值，避免再来回猜。 */
export function epResolutionDiag(): any {
  const view = findActiveDetailView();
  if (!view) return { error: '活跃详情视图未找到(.trim-ui__cache-outlet--exclude)' };
  const cards = view.querySelectorAll('[data-id="details"]');
  const box = (el: Element | null): { w: number; h: number } | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    href: location.pathname,
    beautify: document.body.classList.contains('fnos-beautify'),
    cardCount: cards.length,
    pillCount: document.querySelectorAll('.' + PILL).length,
    hiddenCount: document.querySelectorAll('.' + HIDE).length,
    cards: Array.from(cards).slice(0, 3).map((card) => {
      const thumb = card.firstElementChild;
      const badges = _findBadgeImgs(card);
      const titleP = _findTitleP(card);
      return {
        cardBox: box(card),
        thumbNode: thumb ? thumb.tagName + '.' + String(thumb.className).slice(0, 80) : null,
        thumbBox: box(thumb),
        thumbAspect: thumb ? getComputedStyle(thumb).aspectRatio : null,
        thumbImgs: thumb ? Array.from(thumb.querySelectorAll('img')).map((im) => ({
          src: String(im.getAttribute('src') || '').slice(0, 30),
          cls: String(im.className).slice(0, 45),
          box: box(im),
        })) : null,
        badgeCount: badges.length,
        badgeHolders: badges.map((b) => (b.parentElement ? b.parentElement.tagName + '.' + String(b.parentElement.className).slice(0, 60) : null)),
        titleText: titleP ? (titleP.textContent || '').trim().slice(0, 30) : null,
        titleClasses: titleP ? String(titleP.className).slice(0, 70) : null,
        hasPill: !!card.querySelector('.' + PILL),
      };
    }),
  };
}
