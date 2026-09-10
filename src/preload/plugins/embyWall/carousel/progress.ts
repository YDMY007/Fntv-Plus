import { S } from '../state';
import { ipcRenderer } from 'electron';
import { log, clog } from '../log';

// embyWall/carousel/progress.ts — 轮播骨架屏与加载进度：占位构建、进度条推进、完成收尾、STRM 不支持提示
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export function buildLoadingPlaceholder(target: HTMLElement): void {
  // shimmer / spinner 动画样式只注入一次
  if (!document.getElementById('fnos-ph-style')) {
    const st = document.createElement('style');
    st.id = 'fnos-ph-style';
    st.textContent = `
@keyframes fnos-ph-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
.fnos-ph-skel{position:relative;overflow:hidden;background:var(--fnos-skel-bg)}
/* [lc-1128] shimmer 限 20 轮(30s): 任何 infinite 动画都让合成器 60fps 永动——首页常驻的
   骨架占位(详情未到就卡住的 prev/next 侧卡)把 gpu-process 钉在 ~1 核持续光栅, 整机发卡。
   30s 后骨架静止(占位底色仍在, 进度文字不受影响), 合成器随页面静止熄火。 */
.fnos-ph-skel::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--fnos-skel-shine),transparent);transform:translateX(-120%);animation:fnos-ph-shimmer 1.5s 20}
/* [lc-621] 实时进度模拟器样式(用户参考) — 渐变进度条 + 大百分比 + 状态文字, 无 emoji */
.fnos-ph-track{width:280px;height:8px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden;position:relative}
.fnos-ph-fill{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,#8f6fe8,#c9a7f0);transition:width .25s ease}
.fnos-ph-percent{font-size:30px;font-weight:700;color:rgba(240,236,255,.98);font-variant-numeric:tabular-nums;letter-spacing:.5px;line-height:1}
.fnos-ph-status{font-size:12.5px;color:rgba(225,218,245,.85);padding:4px 14px;border-radius:30px;background:rgba(255,255,255,.09);font-weight:600;letter-spacing:.5px;transition:background .15s}
/* [lc-1130] 样式2/3/4 骨架空壳与浅色骨架变体的 CSS 已随分支一并移除(用户要求弃用骨架屏, 回归原始海报+百分比进度占位) */
`;
    (document.head || document.documentElement).appendChild(st);
  }

  target.innerHTML = '';
  // [lc-444] 同上: 清掉section自身顶部边框/阴影/上边距, 避免细黑线
  target.style.borderTop = 'none';
  target.style.boxShadow = 'none';
  target.style.marginTop = '0';
  target.style.background = 'transparent';
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:0';
  S.carouselWrapper = wrapper;

  const _cs = ((): number => { const v = parseInt(localStorage.getItem('fnos-carousel-style') || '4', 10); return (v >= 1 && v <= 4) ? v : 4; })();

  const container = document.createElement('div');
  container.setAttribute('data-fntv-carousel-style', String(_cs));
  // [lc-1130] 按用户要求: 骨架空壳(样式2/3/4 分支与浅色变体)全部弃用, 一律回到原始加载占位——
  //   紫色渐变容器 + 装饰海报占位 + 中央「大百分比 + 进度条 + 状态文字」
  const _blur = 'backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%)';
  container.style.cssText = `position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(155deg,rgba(145,115,215,.22),rgba(70,50,120,.34));${_blur};margin:0 auto;box-shadow:none`;
  S.carouselContainer = container;

  let fillEl: HTMLElement, percentEl: HTMLElement, statusEl: HTMLElement;

  // [lc-582] 样式1 骨架: 紫色渐变 + 装饰海报占位 + 中央进度(原逻辑, 保持不变)
  const deco = (l: string, t: string, r: string): HTMLElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${l};top:${t};width:104px;height:152px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);transform:rotate(${r})`;
    return d;
  };
  container.appendChild(deco('6%', '14%', '-7deg'));
  container.appendChild(deco('14%', '26%', '4deg'));
  container.appendChild(deco('22%', '15%', '-2deg'));
  const shimmer = document.createElement('div');
  shimmer.className = 'fnos-ph-skel';
  shimmer.style.cssText = 'position:absolute;inset:0;opacity:.5;z-index:1';
  container.appendChild(shimmer);
  const center = document.createElement('div');
  center.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:2';
  percentEl = document.createElement('div');
  percentEl.className = 'fnos-ph-percent';
  percentEl.textContent = '0%';
  const trackEl = document.createElement('div');
  trackEl.className = 'fnos-ph-track';
  fillEl = document.createElement('div');
  fillEl.className = 'fnos-ph-fill';
  trackEl.appendChild(fillEl);
  statusEl = document.createElement('div');
  statusEl.className = 'fnos-ph-status';
  statusEl.textContent = '加载中';
  const textEl = document.createElement('div');
  textEl.className = 'fnos-ph-text';
  textEl.style.cssText = 'font-size:15px;color:rgba(240,236,255,.9);letter-spacing:1.2px;font-weight:600';
  textEl.textContent = '正在加载精彩内容';
  center.appendChild(percentEl);
  center.appendChild(trackEl);
  center.appendChild(statusEl);
  center.appendChild(textEl);
  container.appendChild(center);


  // [lc-621] 伪进度: 前快后慢(参考模拟器增量策略), 每 120ms tick; 数据就绪后 completeCarouselProgress 补 100
  S.carouselBarFill = fillEl;
  S.carouselPctEl = percentEl;
  S.carouselStatusEl = statusEl;
  S.carouselProgressPct = 0;
  S.diagStuckTicks = 0; S.diagStuckSince = 0; S.diagStuckLogged = false; // [DIAG] 看门狗复位
  if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
  S.carouselProgressTimer = window.setInterval(() => {
    const p = S.carouselProgressPct;
    let inc: number;
    if (p < 30) inc = 1.4 + Math.random() * 1.2;       // 前段快
    else if (p < 70) inc = 0.9 + Math.random() * 0.9;  // 中段中速
    else inc = 0.4 + Math.random() * 0.5;              // 后段慢(等待详情补完)
    S.carouselProgressPct = Math.min(99, p + inc);
    fillEl.style.width = S.carouselProgressPct + '%';
    percentEl.textContent = Math.round(S.carouselProgressPct) + '%';
    // [DIAG] 99% 卡死看门狗：进度条封顶 99% 后若 ~15s(≈125 tick @120ms)仍未调用 completeCarouselProgress(跳 100)，记录诊断
    if (S.carouselProgressPct >= 99) {
      if (S.diagStuckTicks === 0) S.diagStuckSince = Date.now();
      S.diagStuckTicks++;
      if (S.diagStuckTicks > 125 && !S.diagStuckLogged) {
        S.diagStuckLogged = true;
        const landCnt = (S.apiShows || []).filter((s: any) => s && s.backdrop && !/poster-|poster\/|\/poster/i.test(s.backdrop)).length;
        const strmCnt = (S.apiShows || []).filter((s: any) => s && s.strmTag).length;
        clog('[DIAG][WATCHDOG] 轮播进度卡在 99% 已超 15s，completeCarouselProgress 未触发 → 轮播不会显示。' +
            ` apiShows=${S.apiShows.length} 有横版backdrop=${landCnt} 疑似STRM项数=${strmCnt}` +
            ` diagLastShows=${S.diagLastShows.length}`);
      }
    } else {
      S.diagStuckTicks = 0;
    }
  }, 120);

  wrapper.appendChild(container);
  target.appendChild(wrapper);

  // [lc-561] 记录数字元素, 供 fetchShowsViaIPC 抓取过程中实时更新"已加载 N 个"
  S.carouselProgressEl = null; // [lc-583] 已改用长条进度, 数字元素废弃
  S.carouselProgressCount = 0;

  // 若真实片库始终未加载(如 NAS 未连接/接口超时), 一段时间后温和提示, 避免"正在加载"永久卡住
  const phTimer = window.setTimeout(() => {
    if (S.apiShows.length === 0 && S.carouselContainer === container && document.body.contains(container)) {
      const txt = container.querySelector('.fnos-ph-text') as HTMLElement | null;
      if (txt) txt.textContent = '加载较慢，请确认 NAS 已连接';
    }
  }, 16000);
  // 占位被重建替换后, 该定时器留在原地无害(条件判断已失效)
  void phTimer;
}

/** [lc-768] 候选海报全部无法加载(疑似 STR/网盘)时, 主页轮播区显示温和提示而非无限骨架。 */
export function buildStrmUnsupportedTip(target: HTMLElement): void {
  target.innerHTML = '';
  target.style.borderTop = 'none';
  target.style.boxShadow = 'none';
  target.style.marginTop = '0';
  target.style.background = 'transparent';
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:0';
  S.carouselWrapper = wrapper;
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:linear-gradient(155deg,rgba(145,115,215,.18),rgba(70,50,120,.30));backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);margin:0 auto;box-shadow:none;display:flex;align-items:center;justify-content:center';
  const tip = document.createElement('div');
  tip.style.cssText = 'font-size:18px;color:rgba(240,236,255,.92);letter-spacing:1.5px;font-weight:600;text-align:center;padding:0 24px';
  tip.textContent = '暂未支持 STRm 海报';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:13px;color:rgba(225,218,245,.7);margin-top:10px;letter-spacing:.5px';
  sub.textContent = '当前片库以网盘 STRm 为主，海报暂无法加载';
  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px';
  col.appendChild(tip);
  col.appendChild(sub);
  container.appendChild(col);
  wrapper.appendChild(container);
  target.appendChild(wrapper);
  clog('[lc-768] 已渲染「暂未支持 STRm 海报」主页提示');
}

/** [lc-627] 数据加载完成: 进度条从当前值快速补到 100%(ease-out 缓动, 约 600ms),
 *  完成后先【强制填满】(取消 transition 直接 100%, 避免 .25s 过渡动画未走完就被
 *  替换 DOM → 用户看到条停在 ~70%), 再延迟一帧让满条渲染, 状态文字「加载完成」,
 *  然后回调 onDone(注入轮播, 骨架淡出→轮播淡入) */
export function completeCarouselProgress(onDone?: () => void, reason?: string): void {
  // [DIAG] 记录触发来源，便于排查「卡在 99%」到底哪条路径没到（revealTimer-8s-timeout / details-ready / details-error）
  clog('[DIAG] completeCarouselProgress 触发, reason=', reason || 'unknown', 'startPct=', Math.round(S.carouselProgressPct), 'apiShows=', S.apiShows.length);
  S.diagStuckTicks = 0; S.diagStuckLogged = false; // [DIAG] 看门狗复位：进度已推进到完成阶段
  if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
  const start = S.carouselProgressPct;
  const totalMs = 600;
  const stepMs = 30;
  const steps = Math.max(1, Math.ceil(totalMs / stepMs));
  let i = 0;
  S.carouselProgressTimer = window.setInterval(() => {
    i++;
    const t = i / steps;                       // 0→1
    const eased = 1 - Math.pow(1 - t, 3);      // ease-out: 前快后慢
    const pct = Math.min(100, start + (100 - start) * eased);
    S.carouselProgressPct = pct;
    if (S.carouselBarFill) S.carouselBarFill.style.width = pct + '%';
    if (S.carouselPctEl) S.carouselPctEl.textContent = Math.round(pct) + '%';
    if (i >= steps) {
      if (S.carouselProgressTimer) { clearInterval(S.carouselProgressTimer); S.carouselProgressTimer = null; }
      // [lc-627] 强制填满: 取消 transition 直接 100%, 确保条真正满格再切画面
      if (S.carouselBarFill) {
        S.carouselBarFill.style.transition = 'none';
        S.carouselBarFill.style.width = '100%';
      }
      if (S.carouselPctEl) S.carouselPctEl.textContent = '100%';
      if (S.carouselStatusEl) S.carouselStatusEl.textContent = '加载完成';
      // 延迟 60ms 让满条渲染一帧(骨架替换时用户看到的是满格条), 再回调
      window.setTimeout(() => {
        if (onDone) { try { onDone(); } catch (e) { /* ignore */ } }
      }, 60);
    }
  }, stepMs);
}

/** [lc-616] 更新骨架上的"已加载 N 个"数字（[lc-616] 已改 page-loading, 数字废弃, 空操作兼容调用方） */
export function updateCarouselProgress(count: number): void {
  S.carouselProgressCount = count;
}

/* 自动从API获取缺失的简介(IPC主进程签名→渲染进程fetch→带cookie鉴权) */
export function autoFetchDescs(base: string, shows: any[], infos: HTMLElement[]): void {
  shows.forEach((show, i) => {
    if (show.desc) return;
    setTimeout(async () => {
      try {
        const { ipcRenderer } = require('electron');
        const path = `/v/api/v1/item/${show.id}`;
        // 主进程生成Authx签名(需要crypto)，渲染进程fetch(带cookie)
        const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
        const resp = await fetch(`${base}${path}`, {
          credentials: 'include',
          headers: { 'Authx': authx }
        });
        const json = await resp.json();
        const desc = (json?.data?.overview || json?.data?.tv_overview || json?.data?.parent_overview || '').trim();
        log('desc API:', show.title, desc ? 'OK(' + desc.length + ')' : 'FAIL', 'code=' + json?.code);
        if (!desc) return;
        show.desc = desc;
        const info = infos[i];
        if (!info) return;
        const btn = info.querySelector('a');
        const descEl = info.querySelector('.fnos-desc') as HTMLElement | null;
        if (descEl) {
          descEl.textContent = desc;
        } else if (btn) {
          const d = document.createElement('div');
          d.className = 'fnos-desc';
          d.style.cssText = 'flex:1 1 auto;min-height:0;-webkit-line-clamp:4;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.72;color:var(--fnos-hero-desc);letter-spacing:.35px;font-weight:500;text-indent:2em;mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%)';
          d.textContent = desc;
          info.insertBefore(d, btn);
        }
      } catch (e) { log('desc error:', show.title, e); }
    }, i * 800);
  });
}

/* [lc-408] 把轮播右侧文字标题替换为透明 logo：
 * - API 真实条目：优先用 show.tmdbId 查 logo；无 tmdbId 时退用 show.title 标题匹配查 TMDB → tmdb:image 代理转 base64
 * - 硬编码兜底条目（show.logo 本地 sys/img）：经 fetchImageAuth 取本地 logo
 * 获取成功才在左侧海报左下角显示 logo；右侧文字标题始终保留不隐藏；任一环节失败则保留文字标题（静默降级）。 */
/* [lc-785] 复用于样式 2 左上角 logo 取图：与原版(样式1) applyTitleLogo 同一套逻辑
 *   - 优先飞牛自带 logo(show.logo)，无则 TMDB 透明 logo(含纯白兜底)
 *   返回可直接作 <img src> 的 blob/dataURL，取不到返回 null。 */