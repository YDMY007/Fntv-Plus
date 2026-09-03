import { ipcRenderer } from 'electron';
import { log } from '../log';

// embyWall/carousel/images.ts — 图片获取：带鉴权头拉图转 blob URL、backdrop 解析、item 详情抓取、STRM 探测
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

/* ========== 鉴权拉取图片→blob URL(绕开<img>无法带Authx头的问题) ========== */
// [DIAG] 增强：label=来源说明, isStrm=是否网盘STRM；记录耗时、识别跨域(网盘/远程直链)、失败给出明确日志
export async function fetchImageAuth(fullUrl: string, opts?: { label?: string; isStrm?: boolean; timeoutMs?: number }): Promise<string | null> {
  const label = opts?.label || 'img';
  const isStrm = !!opts?.isStrm;
  // [lc-768] 超时兜底: 网盘/远程直链极易长时间挂起(导致轮播卡 99%)；STRM 用更短超时，同源稍宽。
  const timeoutMs = opts?.timeoutMs ?? (isStrm ? 8000 : 15000);
  if (!fullUrl) { if (isStrm) log('[DIAG] fetchImg 跳过(空URL) label=', label, 'isStrm=true'); return null; }
  // [lc-992] strm/远程源易瞬断(网盘限流、Authx 偶发失效、偶发 429)：失败/超时重试 1 次(更短超时)，
  //   提高出图率、降低「卡加载」；同源图片不重试(本就快，重试只加倍耗时且无收益)。
  const first = await fetchImageOnce(fullUrl, timeoutMs, label, isStrm);
  if (first || !isStrm) return first;
  log('[DIAG] fetchImg STRm 首次失败, 重试 1 次 label=', label);
  return await fetchImageOnce(fullUrl, Math.min(timeoutMs, 6000), label, isStrm);
}

/** 单次带鉴权拉图→blob URL(绕开<img>无法带Authx头的问题)。[lc-992] 从 fetchImageAuth 抽出，便于 strm 重试。 */
async function fetchImageOnce(fullUrl: string, timeoutMs: number, label: string, isStrm: boolean): Promise<string | null> {
  const t0 = Date.now();
  const controller = new AbortController();
  const to = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { ipcRenderer } = require('electron');
    // 提取path(含query)用于签名, 必须与fetch的URL完全一致
    let path = fullUrl;
    const m = fullUrl.match(/^https?:\/\/[^/]+(\/.*)$/);
    if (m) path = m[1];
    // 跨域(非 fnOS 同源)图片：通常是网盘/远程直链，加载慢或失败的高风险源
    const crossOrigin = m ? (new URL(fullUrl).origin !== location.origin) : false;
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
    const resp = await fetch(fullUrl, { credentials: 'include', headers: { 'Authx': authx }, signal: controller.signal });
    const ct = resp.headers.get('content-type') || '';
    const ms = Date.now() - t0;
    log('[DIAG] fetchImg', label, 'status', resp.status, 'ct', ct.substring(0, 24), 'crossOrigin', crossOrigin, 'isStrm', isStrm, 'ms', ms, 'path', path.substring(0, 50));
    if (!resp.ok || !ct.startsWith('image/')) {
      try { const t = await resp.text(); log('[DIAG] fetchImg 非图片/失败 body:', t.substring(0, 120)); } catch (e) {}
      return null;
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch (e: any) {
    const ms = Date.now() - t0;
    if (e && e.name === 'AbortError') log('[DIAG] fetchImg 超时(被 abort) label=', label, 'isStrm', isStrm, 'timeoutMs', timeoutMs, 'ms', ms);
    else log('[DIAG]  fetchImg err', label, 'isStrm', isStrm, 'ms', ms, String(e).substring(0, 120));
    return null;
  } finally {
    clearTimeout(to);
  }
}

// [lc-768] 预加载并校验某剧集横版 backdrop：成功返回 base64 data URL(写入 s._backdropBlob 复用，[lc-935] 起改为 data URL 以根治 SPA 返回后旧 blob 失效问题)，失败(含 STR/网盘挂起、非横版)返回 null。
// 用于「凑齐 10 个」选片：加载不到的海报直接跳过，往后取下一个候选。
export async function resolveShowBackdrop(show: any, base: string): Promise<string | null> {
  let pic = '';
  if (show && show.backdrop) {
    if ((show.backdrop as string).startsWith('http') || (show.backdrop as string).startsWith('/v/api/')) pic = show.backdrop;
    else pic = `${base}/v/api/v1/${show.backdrop}`;
  }
  if (!pic) return null;
  const b = await fetchImageAuth(pic, { label: 'pick:' + ((show.title || '').substring(0, 10)), isStrm: !!show.strmTag, timeoutMs: 8000 });
  if (!b) return null;
  // 仅横版(nw>=nh)才用于轮播主图；竖版/解码失败一律视为不可用 → 跳过该候选
  const ok = await new Promise<boolean>((resolve) => {
    const im = new Image();
    const imTo = window.setTimeout(() => resolve(false), 6000);
    im.onload = () => { clearTimeout(imTo); const w = im.naturalWidth || 0, h = im.naturalHeight || 0; resolve(w > 0 && h > 0 && w >= h); };
    im.onerror = () => { clearTimeout(imTo); resolve(false); };
    im.src = b;
  });
  if (!ok) { try { URL.revokeObjectURL(b); } catch { /* ignore */ } return null; }
  // [lc-935] 转 base64 data URL: 自包含字符串, 不依赖 blob 注册表/文档生命周期,
  //   SPA 返回首页(旧文档 blob 失效)等场景下依然 100% 有效, 根治"返回后轮播海报不显示"。
  //   转换完成后 revoke 中间 blob 释放内存。
  const dataUrl = await blobToDataURL(b);
  try { URL.revokeObjectURL(b); } catch { /* ignore */ }
  return dataUrl;
}

// [lc-935] blob URL → base64 data URL: data URL 是自包含字符串, 不依赖 blob 注册表/文档生命周期,
//   在 SPA 返回首页(旧文档 blob 失效)等场景下依然 100% 有效。fetch 是本地同源读取, 无网络开销。
async function blobToDataURL(blobUrl: string): Promise<string> {
  try {
    const resp = await fetch(blobUrl);
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return blobUrl; // 转换失败则退回原 blob URL(不阻断显示)
  }
}

// [lc-935] 统一「横版主图」渲染(供样式 2/3/4 共用):
//   ① 优先复用首拉时已校验横版的 _backdropBlob —— 该值现已是 base64 data URL(见 resolveShowBackdrop),
//      零网络且任何导航/重建下都有效(根治「SPA 返回后旧 blob 失效 → 图片不显示」);
//   ② 完全无 _backdropBlob 时, 回退 fetchImageAuth(s.backdrop)+横版校验(同 lc-933 意图)。
//      这解决了「返回首页重建轮播时旧 DOM 已销毁 → blob 底层数据可能被回收 → 有URL字符串但图片不显示」的问题。
//   ③ 完全无 blob 时(首屏数据未就绪等): 直接走 fetch fallback。
export function applyCarouselBackdrop(show: any, target: HTMLElement, base: string): void {
  // [lc-935] _backdropBlob 已是 base64 data URL(自包含字符串, 任何导航/重建下均有效),
  //   彻底规避"旧 blob URL 在 SPA 返回后失效 → 图片不显示"的问题。直接设置即可, 无需 probe。
  const dataUrl = show && (show as any)._backdropBlob as string | undefined;
  const title = (show && (show as any).title || '').substring(0, 10);
  if (dataUrl) {
    target.style.backgroundImage = `url("${dataUrl}")`;
    return;
  }
  if (show && (show as any)._backdropIsPortrait) return; // 已知竖版 → 不拉(保留渐变兜底)
  startFetchFallback(show, target, base, title);
}

/** [lc-935] applyCarouselBackdrop 的 fetch fallback: 拉 s.backdrop + 横版校验, 成功则写目标背景(同样转 data URL 防失效) */
function startFetchFallback(show: any, target: HTMLElement, base: string, title: string): void {
  const p = (show && (show as any).backdrop) || '';
  if (!p) return;
  const pic = p.startsWith('http') || p.startsWith('/v/api/') ? p : `${base}/v/api/v1/${p}`;
  fetchImageAuth(pic, { label: 'cb:' + title, isStrm: !!(show && (show as any).strmTag) }).then(async (b) => {
    if (!b) return;
    // [lc-935] 转 base64 data URL, 避免 fallback 拉回的 blob 也有生命周期问题(SPA 返回后同样会失效)
    const dataUrl = await blobToDataURL(b);
    try { URL.revokeObjectURL(b); } catch { /* ignore */ }
    // 横版校验: 竖版不显示(避免「竖屏海报」), 横版才上背景
    const im = new Image();
    const to = window.setTimeout(() => { target.style.backgroundImage = `url("${dataUrl}")`; }, 4000); // 超时按横版放行
    im.onload = () => { clearTimeout(to); const w = im.naturalWidth || 0, h = im.naturalHeight || 0; if (w > 0 && h > 0 && w < h) return; target.style.backgroundImage = `url("${dataUrl}")`; };
    im.onerror = () => { clearTimeout(to); };
    im.src = dataUrl;
  });
}

// [DIAG] 识别 item 是否为「网盘 STRM / 远程 / 云存储」来源——用于在轮播海报加载失败时定位是否 STR 媒体导致。
// 仅做启发式扫描，不改动任何数据；命中返回形如 "STRM"、"STRM+CLOUD"、"WEBDAV"、"REMOTE" 的标签，否则空串。
function detectStrmOrCloud(d: any): string {
  if (!d || typeof d !== 'object') return '';
  const hay: string[] = [];
  for (const k of ['path', 'file_path', 'filepath', 'Path', 'FilePath', 'media_path', 'source', 'type', 'media_type', 'library_type', 'strm', 'is_strm', 'protocol']) {
    const v = d[k];
    if (typeof v === 'string') hay.push(v);
  }
  const arr = d.media_sources || d.mediaSources || d.media_stream || d.MediaSources || d.streams || d.play_info || d.sources || [];
  if (Array.isArray(arr)) {
    for (const it of arr) {
      if (!it) continue;
      if (typeof it === 'string') hay.push(it);
      else if (typeof it === 'object') {
        for (const kk of ['path', 'file_path', 'url', 'src', 'download_url', 'DownloadURL', 'Path', 'Url', 'protocol']) {
          const v = it[kk];
          if (typeof v === 'string') hay.push(v);
        }
      }
    }
  }
  const joined = hay.join(' ');
  const tags: string[] = [];
  if (/\.strm(\?|$|#)/i.test(joined)) tags.push('STRM');
  if (/webdav|web-dav/i.test(joined)) tags.push('WEBDAV');
  if (/cloudstor|cloud_storage|cloudstorage|115|aliyun|quark|uc\.|pan\./i.test(joined)) tags.push('CLOUD');
  if (/^https?:\/\//i.test(joined) && !/(sys\/img|fnos|fntv|\/v\/api)/i.test(joined)) tags.push('REMOTE');
  return tags.join('+');
}

/** [lc-569] 从飞牛 item API 一次性补齐轮播展示字段:
 *  横版大海报(backdrop) + 集数/季数(local/total) + 年份 + 评分 + 状态 + 类型 + 简介。
 *  字段名以 lc-552 fetchOne 历史实现为准(已验证可用)。
 *  带 Authx 签名 + AbortController 4s 超时; 失败返回 null(由调用方保留 DOM 兜底)。 */
export async function fetchItemDetail(base: string, id: string): Promise<any | null> {
  try {
    const { ipcRenderer } = require('electron');
    const path = `/v/api/v1/item/${id}`;
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // 单条 4s 硬超时, 避免 API 挂起卡轮播
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, { credentials: 'include', headers: { 'Authx': authx }, signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const d = (json && json.data) || {};
    // [DIAG] STRM/网盘来源识别 + 关键字段记录（不改行为）：定位海报加载失败是否由网盘 STR 媒体引起
    const strmTag = detectStrmOrCloud(d);
    if (strmTag) log('[DIAG] item', id, '疑似来源:', strmTag, '| 候选路径=', String(d.path || d.file_path || '').substring(0, 90));
    // [lc-568] 飞牛 item API: 横版大海报 = data.backdrops(数组), 竖版 = data.posters(数组)
    // [lc-599] 选最大尺寸的 backdrop: 数组第一项经常是竖版小缩略图, 大横版(1920x1080)通常在后面
    const pickImg = (v: any, preferLargest = false): string => {
      let s = '';
      const extract = (it: any): string => {
        if (typeof it === 'string') return it;
        if (!it || typeof it !== 'object') return '';
        return it.file_path || it.url || it.path || it.image || it.src || '';
      };
      if (typeof v === 'string') s = v;
      else if (Array.isArray(v) && v.length) {
        let best = v[0];
        if (preferLargest) {
          let bestSize = 0;
          for (const it of v) {
            const w = (it && (it.width || it.w)) || 0;
            const h = (it && (it.height || it.h)) || 0;
            const sz = w * h;
            if (sz > bestSize) { bestSize = sz; best = it; }
          }
        }
        s = extract(best);
      }
      if (!s) return '';
      if (s.startsWith('http') || s.includes('sys/img')) return s;
      return 'sys/img' + (s.startsWith('/') ? s : '/' + s); // "/a9/06/x.webp" → "sys/img/a9/06/x.webp"
    };
    const rel = pickImg(d.backdrops, true); // [lc-599] 优先选 width*height 最大的横版
    const backdrop = rel ? (rel.startsWith('http') ? rel : base + '/v/api/v1/' + rel) : '';
    // [lc-606] 竖版海报: 右侧海报条(posterStrip)用的 show.poster 一直没被 API 补过。
    //   scrapeAllPageFirstScreen 只从 libIndex(iframe 懒加载图常空) + 当前页 DOM 抓,
    //   磁盘缓存(lc-586)化后 item.poster 也常空 → 右侧海报全变占位「暂无海报」。
    //   data.posters 是 item API 权威竖版源(lc-568 已验证), 补全后右侧海报稳定显示。
    const relPoster = pickImg(d.posters, true);
    const poster = relPoster ? (relPoster.startsWith('http') ? relPoster : base + '/v/api/v1/' + relPoster) : '';
    // [lc-570] 飞牛自带 logo(详情页 hero 用的同一个): item API 的 data.logos 数组, 与 backdrops/posters 同构
    const relLogo = pickImg(d.logos);
    const logo = relLogo ? (relLogo.startsWith('http') ? relLogo : base + '/v/api/v1/' + relLogo) : '';
    // [lc-569] 集数/季数(local=本地已更新, total=总规模), 年份, 评分, 状态, 类型, 简介
    const totalEps = Number(d.number_of_episodes) || 0;
    const localEps = Number(d.local_number_of_episodes) || 0;
    const totalSeasons = Number(d.number_of_seasons) || 0;
    const localSeasons = Number(d.local_number_of_seasons) || 0;
    const rawYear = Number(d.production_year) || Number(String((d.premiere_date || d.air_date || '')).slice(0, 4)) || 0;
    const rawRating = parseFloat(String(d.vote_average || '').trim());
    const rating = isNaN(rawRating) ? 0 : rawRating;
    const statusRaw = (d.status || '').trim();
    let statusText = '';
    if (statusRaw) {
      const s = statusRaw.toLowerCase();
      if (s.includes('continu') || s.includes('更新') || s.includes('连载')) statusText = '连载中';
      else if (s.includes('end') || s.includes('完结')) statusText = '已完结';
      else if (s.includes('releas') || s.includes('上映') || s.includes('发行')) statusText = '已上映';
      else statusText = statusRaw;
    }
    // [lc-572] 类型标签: 多字段兜底(genres/genre/types/categories/tags) + 多形态兼容
    // (数组[{name}]/[string]/逗号分隔字符串), 并打印诊断确认字段可用
    let genres: string[] = [];
    const g: any = d.genres || d.genre || d.types || d.categories || d.tags;
    if (Array.isArray(g)) genres = g.map((x: any) => (typeof x === 'string' ? x : (x?.name || x?.Name || x?.title || ''))).filter(Boolean);
    else if (typeof g === 'string' && g.trim()) genres = g.split(/[,，/、|]/).map((s: string) => s.trim()).filter(Boolean);
    log('[lc-572] item genres:', JSON.stringify(genres), '(raw=', JSON.stringify(g).substring(0, 100), ')');
    return {
      backdrop, poster, logo, // [lc-606] poster = 竖版(item API data.posters, 右侧海报条用)
      totalEps, localEps, totalSeasons, localSeasons,
      year: rawYear, rating, statusText, genres,
      desc: (d.overview || '').trim(),
      title: (d.title || d.name || '').trim(),
      strmTag, // [DIAG] 携带来源标签，供轮播渲染/看门狗诊断
    };
  } catch (e) { return null; }
}

/** [lc-567] 从当前页已渲染 DOM 抓**已加载的横版图**(naturalWidth>naturalHeight, 如"继续观看"等横版卡片)按 id 建表。
 *  用户确认飞牛页面里自带横屏图——横版卡片 img 已真实加载(用户可见), 无需 API。
 *  仅收集已加载(宽高已知)且横版(nw > nh*1.3)的图, 排除竖版。 */
export function scrapeLandscapeBackdrops(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const base = location.origin;
    const links = document.querySelectorAll('a[href*="/v/tv/"],a[href*="/v/movie/"]');
    for (const a of Array.from(links)) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
      if (!m || map.has(m[2])) continue;
      const img = a.querySelector('img') as HTMLImageElement | null;
      if (!img) continue;
      const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
      if (!(nw > 0 && nh > 0 && nw > nh * 1.3)) continue; // 只收已加载且明显横版
      const s = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (s && (s.includes('/sys/img/') || s.startsWith('http'))) {
        map.set(m[2], s.startsWith('/') ? base + s : s);
      }
    }
  } catch (e) { /* ignore */ }
  return map;
}


/** [lc-876] 销毁当前轮播的所有 timer + event listener（重建/导航离开前调用）。
 *  各 buildCarouselStyleX 在创建timer/listener时将清理逻辑注册到 S.carouselCleanup。 */