// embyWall/detail/heroTint.ts — 封面取色：详情页上部遮罩的同色系底色（lc-990）
// ─────────────────────────────────────────────────────────────────────────────
// 诉求（用户原话）：「二级详情页里上部的遮罩太丑一不好看改成封面取色的玻璃样式」
//
// 「丑」是量得出来的（活体 NAS /v/tv/season/<id>，浅色主题，白字对比度）：
//   飞牛详情页上部有**两层**遮罩，色值全是硬编码中性色，而且左右明暗严重不均——
//     ① 顶栏 80px 条 div.z-[2].h-[80px].!absolute.top-0.w-full（是 hero 的**兄弟**，不在 hero 内）
//        linear-gradient(rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 100%)
//     ② hero 内 .gradient-for-full（一个元素两层渐变，覆盖整块 820x470）
//        linear-gradient(90deg, rgba(25,25,26,.96) 0%, .74 28%, .38 58%, .08 100%)
//        linear-gradient(0deg,  rgb(25,25,26) 0%,  .94 22%, .76 54%, .18 100%)
//   同一行 y=41 上：左侧图标区 12.23（封面色被吃到死黑），右侧按钮组只剩 4.50（几乎没压暗）。
//   本文件从 hero 剧照取主色、暗化后写成 CSS 变量 --fnos-hero-tint，
//   交给 beautifyStyle.ts 的 L 段消费（顶栏磨砂玻璃条 + hero 遮罩同色系换色）。
//   换色后同一批采样点收敛到 9.72~11.00，标题「第 1 季」8.92。
//
// 硬约束（每条都有实测依据，改这个文件前先读）：
//   · 零新网络请求、零 IPC：剧照是同源 /v/api/v1/sys/img/<2hex>/<2hex>/...，
//     canvas getImageData 不 taint（活体实测 img.crossOrigin === null 时取色 ok）。
//     ∴ **绝不设 crossOrigin** —— 同源图设了反而可能因服务器不回 CORS 头而加载失败。
//     （embyWall.ts 的 imageTopLeftLuminance 设了 crossOrigin='anonymous'，那是隐患，别照抄。）
//   · 零常驻任务：img.complete 时同步取色（32x32 = 1024 像素，微秒级，不拖首屏）；
//     未 complete 只挂**一次性** load 监听。无 setInterval、无 MutationObserver。
//   · 零 inline 污染原生节点：变量写在 document.body.style 上（body 不是 React 重渲染目标），
//     不给任何飞牛节点加 style 或 class。
//   · 失败即静默降级：取不到图 / SecurityError / 空桶 → 干脆不写变量，
//     L 段的 var(--fnos-hero-tint, 25,25,26) 会精确回落到飞牛原生色（两态均已实测正确）。
//   · ⚠ fnOS 视图栈是 cache-outlet：切页后旧视图**不从 DOM 移除**、只是隐藏。
//     所以 load 回调判断「还在不在当前页」不能靠 body.contains(hero)，
//     必须重新解析活跃 hero 再比对（见 applyHeroTint 内的守卫）。
// ─────────────────────────────────────────────────────────────────────────────
import { dlog } from '../log';
import { findHeroBackdropImg, findActiveDetailView, findDetailHero } from './glass';

/** 写出的 CSS 变量名。L 段的两处渐变都以 var(--fnos-hero-tint, 25,25,26) 消费。 */
const TINT_VAR = '--fnos-hero-tint';
/** canvas 采样边长。1024 像素足够把主色桶定住，drawImage + getImageData 是微秒级。 */
const SAMPLE = 32;
/** 亮度上限（0..1）。
 *  为什么必须暗化：封面普遍偏亮——14 张实测亮度落在 0.39~0.85，其中 10 张 >0.5；
 *  当前这部剧的主色桶 rgb(252,250,247) 独占 43%。直接拿主色当玻璃底色，
 *  白标题与白图标会整个消失。∴ 保留色相与饱和度，只把亮度压到深色档（用户选定的方案）。
 *  0.20 是标定值：真实合成下三个图标 10.83~11.00、右侧按钮组 9.72、标题 8.92；
 *  理论最坏情况（纯黄封面 tint rgb(102,102,0) + 玻璃背后透出纯白）仍有 4.94 > WCAG AA 4.5。
 *  **只压不提**：L 已低于上限时原样返回，绝不把暗封面洗亮（也不做人工提饱和，避免染色感）。 */
const L_CAP = 0.20;

type Bucket = { n: number; r: number; g: number; b: number };

/** 上一次算过的图与结果。按 currentSrc 幂等 → SPA 内来回切同一页不重复采样。 */
let _cacheSrc: string | null = null;
let _cacheTint: string | null = null;
/** 已挂了 load 监听的图，防止 immersive 的重试链在同一张图上重复挂。 */
let _pendingImg: HTMLImageElement | null = null;

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  // d===0 时 l 只能是 0 或 1，正是下面 s 的除零点，故必须先返回
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (mx === R) h = ((G - B) / d) % 6;
  else if (mx === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) { rp = c; gp = x; }
  else if (h < 120) { rp = x; gp = c; }
  else if (h < 180) { gp = c; bp = x; }
  else if (h < 240) { gp = x; bp = c; }
  else if (h < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return [Math.round((rp + m) * 255), Math.round((gp + m) * 255), Math.round((bp + m) * 255)];
}

/** 从剧照取主色并暗化，返回 "R,G,B"；任何一步拿不到就返回 null（交 CSS fallback 降级）。 */
function tintFromImage(img: HTMLImageElement): string | null {
  const cv = document.createElement('canvas');
  cv.width = SAMPLE; cv.height = SAMPLE;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  if (!cx) return null;
  try { cx.drawImage(img, 0, 0, SAMPLE, SAMPLE); } catch (_) { return null; }
  let data: Uint8ClampedArray;
  try { data = cx.getImageData(0, 0, SAMPLE, SAMPLE).data; }
  catch (_) { return null; }   // SecurityError = 图被 taint（理论上同源不会）→ 降级

  // 4bit/通道量化后投票。用桶而不是逐像素平均：封面常有大面积高光与大面积暗部，
  // 直接平均会得到一个谁也不是的中间灰，丢掉「这张封面是什么色调」的信息。
  const buckets = new Map<number, Bucket>();
  let used = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;            // 跳过近透明像素
    used++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let e = buckets.get(k);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  }
  if (!used) return null;
  let best: Bucket | undefined;
  for (const e of Array.from(buckets.values())) if (!best || e.n > best.n) best = e;
  if (!best) return null;

  const [h, s, l] = rgb2hsl(best.r / best.n, best.g / best.n, best.b / best.n);
  const tint = l <= L_CAP ? hsl2rgb(h, s, l) : hsl2rgb(h, s, L_CAP);
  return tint[0] + ',' + tint[1] + ',' + tint[2];
}

/** 给当前 hero 算出封面 tint 并写进 body 的 CSS 变量。幂等；失败静默。
 *  由 immersive.ts 在 _apply() 与 700ms 延迟重试里各调一次（剧照可能晚于 settle 才解码）。 */
export function applyHeroTint(hero: HTMLElement): void {
  const img = findHeroBackdropImg(hero);
  if (!img) return;
  const src = img.currentSrc || img.src || '';
  if (!src) return;

  if (_cacheSrc === src && _cacheTint) {
    document.body.style.setProperty(TINT_VAR, _cacheTint);
    return;
  }

  if (!img.complete || !img.naturalWidth) {
    if (_pendingImg === img) return;           // 已挂过监听，等它自己触发
    _pendingImg = img;
    img.addEventListener('load', () => {
      _pendingImg = null;
      // cache-outlet 语义下旧视图只是隐藏、仍在 DOM 里 → 必须重新解析活跃 hero 比对，
      // 否则切页后这张迟到的图会把旧剧的色调刷到新页上。
      const v = findActiveDetailView();
      if (!v || findDetailHero(v) !== hero) return;
      if (!document.body.classList.contains('fnos-beautify')) return;   // 已 teardown
      applyHeroTint(hero);
    }, { once: true });
    return;
  }

  const tint = tintFromImage(img);
  if (!tint) return;
  _cacheSrc = src;
  _cacheTint = tint;
  document.body.style.setProperty(TINT_VAR, tint);
  dlog('beautify: hero tint=' + tint + ' src=' + src.slice(-28));
}

/** 摘掉 tint 变量（离开详情页 / 关闭美化 / 换页软复位）。O(1)。
 *  刻意保留 _cacheSrc/_cacheTint：按 src 幂等，回到同一页时可秒出，不必重新采样。 */
export function clearHeroTint(): void {
  document.body.style.removeProperty(TINT_VAR);
  _pendingImg = null;
}

/** 诊断：返回当前 tint 变量值与缓存状态（Console 里 fntvHeroTintDiag() 用）。 */
export function heroTintDiag(): { tintVar: string; cacheSrc: string | null; cacheTint: string | null; pending: boolean } {
  return {
    tintVar: document.body.style.getPropertyValue(TINT_VAR) || '(未设置 → CSS 回落 25,25,26)',
    cacheSrc: _cacheSrc ? _cacheSrc.slice(-40) : null,
    cacheTint: _cacheTint,
    pending: !!_pendingImg,
  };
}
