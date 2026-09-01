import { S } from '../state';
import { fetchImageAuth } from './images';
import { ipcRenderer } from 'electron';
import { isDetailPage } from '../detail/glass';
import { log } from '../log';
import { extractTmdbId } from './api';

// embyWall/carousel/logo.ts — 轮播/详情页 LOGO：TMDB 透明 logo 拉取、标题替换为 logo、回写飞牛媒体库
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export async function resolveShowLogo(show: any, base: string): Promise<string | null> {
  try {
    if (show.logo) {
      const full = show.logo.startsWith('http') ? show.logo : `${base}/v/api/v1/${show.logo}`;
      const b = await fetchImageAuth(full);
      if (b) return b;
    }
    if (show.tmdbId || show.title) {
      const { ipcRenderer } = require('electron');
      const logoArg: any = { mediaType: show.mediaType || 'tv' };
      if (show.tmdbId) logoArg.id = show.tmdbId; else logoArg.title = show.title;
      const r = await ipcRenderer.invoke('tmdb:logo', logoArg);
      if (!r || !r.ok) return null;
      const paths = (r.logoPaths && r.logoPaths.length) ? r.logoPaths : (r.logoPath ? [r.logoPath] : []);
      let whiteFallback: string | null = null;
      for (const p of paths) {
        try {
          const url = 'https://image.tmdb.org/t/p/w500' + p;
          const img = await ipcRenderer.invoke('tmdb:image', url);
          if (!img || !img.ok || !img.dataUrl) continue;
          if (await isPureWhitePng(img.dataUrl)) {
            if (!whiteFallback) whiteFallback = img.dataUrl;
            continue;
          }
          return img.dataUrl;
        } catch (e) { /* 试下一个候选 */ }
      }
      if (whiteFallback) return whiteFallback;
    }
    return null;
  } catch (e) { log('resolveShowLogo err:', (show && show.title) || '', e); return null; }
}

export function applyTitleLogo(base: string, shows: any[], infos: HTMLElement[]): void {
  // [lc-409] 开关关闭时完全跳过（既不拉取也不替换），保留文字标题
  if (!S.carouselLogoEnabled) return;
  shows.forEach((show, i) => {
    const info = infos[i];
    if (!info) return;
    // [lc-570] 优先用飞牛自带 logo(item API 的 data.logos, 与详情页 hero 一致, 不会匹配错)；
    // 没有飞牛 logo 才走 TMDB 标题/ID 匹配(可能不准确)。
    if (show.logo) {
      setTimeout(async () => {
        try {
          const full = show.logo.startsWith('http') ? show.logo : `${base}/v/api/v1/${show.logo}`;
          const b = await fetchImageAuth(full);
          if (b) { swapTitleToLogo(info, b); log('fnOS logo applied:', show.title); }
          else log('fnOS logo fetch fail:', show.title);
        } catch (e) { log('local logo err:', show.title, e); }
      }, i * 600);
    } else if (show.tmdbId || show.title) {
      // API 真实条目 → TMDB 透明 logo（主进程已按「横屏」筛选并返回候选列表；此处再排除纯白 PNG）
      setTimeout(async () => {
        try {
          const { ipcRenderer } = require('electron');
          const logoArg: any = { mediaType: show.mediaType || 'tv' };
          if (show.tmdbId) logoArg.id = show.tmdbId; else logoArg.title = show.title;
          const r = await ipcRenderer.invoke('tmdb:logo', logoArg);
          if (!r || !r.ok) {
            log('tmdb logo none:', show.title, (r && r.error) || '无 logo');
            return;
          }
          // [lc-437] 优先用横屏候选列表逐个尝试；不再以「纯白」硬性排除（logo 已移至左侧深色海报，纯白可见）
          const paths = (r.logoPaths && r.logoPaths.length) ? r.logoPaths : (r.logoPath ? [r.logoPath] : []);
          let whiteFallback: string | null = null; // [lc-437] 纯白 logo 留作最后兜底
          for (const p of paths) {
            try {
              const url = 'https://image.tmdb.org/t/p/w500' + p;
              const img = await ipcRenderer.invoke('tmdb:image', url);
              if (!img || !img.ok || !img.dataUrl) continue;
              // [lc-437] 纯白检测不再立即跳过：先收藏为兜底，优先用非纯白
              if (await isPureWhitePng(img.dataUrl)) {
                if (!whiteFallback) whiteFallback = img.dataUrl;
                log('tmdb logo 纯白候选(留作兜底):', show.title, p);
                continue;
              }
              show.tmdbLogo = img.dataUrl;
              swapTitleToLogo(info, img.dataUrl);
              log('tmdb logo applied:', show.title);
              return;
            } catch (e) { log('tmdb logo candidate err:', show.title, e); }
          }
          // [lc-437] 兜底：无任何非纯白可用时，才选用纯白 logo
          if (whiteFallback) {
            show.tmdbLogo = whiteFallback;
            swapTitleToLogo(info, whiteFallback);
            log('tmdb logo applied(纯白兜底):', show.title);
            return;
          }
          log('tmdb logo 全部候选不可用:', show.title);
        } catch (e) { log('tmdb logo err:', show.title, e); }
      }, i * 600);
    } else if (show.logo) {
      // 硬编码兜底条目 → 本地 sys/img logo 替换标题
      setTimeout(async () => {
        try {
          const full = show.logo.startsWith('http') ? show.logo : `${base}/v/api/v1/${show.logo}`;
          const b = await fetchImageAuth(full);
          if (b) swapTitleToLogo(info, b);
        } catch (e) { log('local logo err:', show.title, e); }
      }, i * 600);
    }
  });
}

/* [lc-425] 详情页 Logo 回填飞牛元数据（真实写回）：取到 TMDB 透明 logo(zh→ja→en) 后，
 * 经飞牛「临时图床上传 + 保存详情」两个接口写回 item 的 logos 字段，实现本地持久化。
 * 安全策略：仅当该 item 当前「无 logo」时才回填，绝不覆盖飞牛自带/用户已设的 logo；
 * 写回采用「读 getEditDetail 全量 → 仅改 logos+logos_locked → 原样回写 saveEditDetail」，
 * 避免字段缺失被飞牛清空其他元数据。
 * 签名：fnOS 的 POST 必须按 {request.go/request.ts} 约定——把 nonce 写进 JSON body，且 Authx
 *   用「含 nonce 的 body」签名后再发同一个含 nonce 的 body（服务端按原始 body 字节验签，否则
 *   invalid sign）。端点形状 + 字段取自用户在运行 app 中实测抓包（2026-08-11）。 */
const _backfilledGuids = new Set<string>();

/** 生成 fnOS 防重放随机数（与 GenerateRandomDigits(100000,1000000) 同区间） */
function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** base64 dataURL → Blob（用于把 TMDB logo 作为二进制图上传到飞牛临时图床） */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /:(.*?);/.exec(meta)?.[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** 读取 item 当前完整可编辑元数据（POST 带 nonce，按 fnOS 约定签名） */
export async function fnosGetEditDetail(origin: string, guid: string): Promise<any | null> {
  try {
    const { ipcRenderer } = require('electron');
    const body = { item_guid: guid, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/getEditDetail', body).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/item/getEditDetail`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { log('[回填] getEditDetail HTTP', resp.status, guid); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { log('[回填] getEditDetail 业务失败', JSON.stringify(j).substring(0, 200)); return null; }
    return j.data || null;
  } catch (e) { log('[回填] getEditDetail 异常', String(e).substring(0, 120)); return null; }
}

/** 上传 logo 到飞牛临时图床，返回 hash_path（如 /f5/04/upload_logo_xxx.webp）或 null。
 *  签名 data 取非文件表单字段 {image_type, nonce}（与 fnOS 前端 multipart 约定一致）。 */
async function uploadLogoToFnos(origin: string, dataUrl: string): Promise<string | null> {
  try {
    const { ipcRenderer } = require('electron');
    const blob = dataUrlToBlob(dataUrl);
    const fd = new FormData();
    fd.append('file', blob, 'logo.png');
    fd.append('image_type', 'logo');
    const signData = { image_type: 'logo', nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/image/temp/upload', signData).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/image/temp/upload`, {
      method: 'POST', credentials: 'include',
      headers: { ...(authx ? { Authx: authx } : {}) }, body: fd,
    });
    if (!resp.ok) { log('[回填] upload HTTP', resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0 || !j.data?.hash_path) {
      log('[回填] upload 业务失败', JSON.stringify(j).substring(0, 200)); return null;
    }
    return j.data.hash_path as string;
  } catch (e) { log('[回填] upload 异常', String(e).substring(0, 120)); return null; }
}

/** 把完整详情对象回写飞牛（仅改 logos + logos_locked，带 nonce 签名），成功返回 true */
async function saveEditDetail(origin: string, data: any, logoHashPath: string): Promise<boolean> {
  try {
    const { ipcRenderer } = require('electron');
    const body = { ...data, logos: logoHashPath, logos_locked: true, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/saveEditDetail', body).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/item/saveEditDetail`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { log('[回填] saveEditDetail HTTP', resp.status); return false; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { log('[回填] saveEditDetail 业务失败', JSON.stringify(j).substring(0, 200)); return false; }
    return true;
  } catch (e) { log('[回填] saveEditDetail 异常', String(e).substring(0, 120)); return false; }
}

export function backfillDetailLogo(): void {
  if (!S.carouselLogoEnabled) return;            // 复用「轮播 Logo」开关
  if (!isDetailPage()) return;
  const m = location.href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
  if (!m) return;
  const guid = m[2];
  const mediaType = m[1] === 'tv' ? 'tv' : 'movie';
  if (_backfilledGuids.has(guid)) return;
  _backfilledGuids.add(guid);
  const origin = location.origin;
  setTimeout(async () => {
    try {
      const { ipcRenderer } = require('electron');
      // 1) 读取 item 当前完整可编辑元数据（与保存接口同构，避免字段缺失被清空）
      const data = await fnosGetEditDetail(origin, guid);
      if (!data) return;
      // 2) 已有 logo → 绝不覆盖（飞牛自带/用户已设）
      if (data.logos && String(data.logos).trim()) {
        log('[回填] 已有 logo, 跳过', guid, String(data.logos).substring(0, 80)); return;
      }
      // 3) 取 TMDB id（优先 trim_id；Bangumi 源 bg 前缀无 TMDB id，则用标题搜索兜底）
      const tmdbId = extractTmdbId(data);
      const title = (data.title || '').trim();
      if (!tmdbId && !title) { log('[回填] 无 tmdbId 且无标题, 跳过', guid); return; }
      const logoArg: any = { mediaType };
      if (tmdbId) logoArg.id = tmdbId; else logoArg.title = title;
      const r = await ipcRenderer.invoke('tmdb:logo', logoArg);
      if (!r || !r.ok) { log('[回填] TMDB 无 logo', tmdbId || title); return; }
      // 4) 逐个候选：下载 → 排除纯白 → 上传 → 保存，首个成功即止
      const paths = (r.logoPaths && r.logoPaths.length) ? r.logoPaths : (r.logoPath ? [r.logoPath] : []);
      for (const p of paths) {
        try {
          const url = 'https://image.tmdb.org/t/p/w500' + p;
          const img = await ipcRenderer.invoke('tmdb:image', url);
          if (!img || !img.ok || !img.dataUrl) continue;
          if (await isPureWhitePng(img.dataUrl)) { log('[回填] 纯白跳过', p); continue; }
          const hashPath = await uploadLogoToFnos(origin, img.dataUrl);
          if (!hashPath) { log('[回填] 上传失败', p); continue; }
          const saved = await saveEditDetail(origin, data, hashPath);
          if (saved) {
            log('[回填] ✅ 已写回 logo → guid=' + guid + ' path=' + hashPath);
            return;
          }
          log('[回填] 保存失败', p);
        } catch (e) { log('[回填] 候选失败', p, String(e).substring(0, 80)); }
      }
      log('[回填] 无可用 logo', guid);
    } catch (e) { log('[回填] err', String(e).substring(0, 120)); }
  }, 800);
}

/** [lc-436] 在左侧海报左下角显示 logo 图片；右侧文字标题保留不隐藏 */
export function swapTitleToLogo(info: HTMLElement, src: string): void {
  const slide = info.closest('.fnos-slide') as HTMLElement | null;
  const logoEl = slide?.querySelector('.fnos-logo') as HTMLImageElement | null;
  if (!logoEl) return;
  logoEl.src = src;
  logoEl.style.display = 'block';
}

/** [lc-413] 判断 base64/blob PNG 是否为「纯白 logo」：可见(非透明)像素几乎全部接近纯白 → 视为纯白，
 *  在浅色面板上不可见，应跳过；完全透明(无可见内容)同样视为不可用。渲染端 canvas 像素分析。 */
function isPureWhitePng(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { resolve(true); return; } // 无尺寸 → 不可用（跳过）
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) { resolve(false); return; } // 取不到上下文不误杀
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        let visible = 0, white = 0;
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3];
          if (a < 16) continue; // 透明像素跳过
          visible++;
          if (px[i] >= 245 && px[i + 1] >= 245 && px[i + 2] >= 245) white++;
        }
        if (visible < 25) { resolve(true); return; } // 实质无可见内容 → 跳过
        resolve(white / visible >= 0.9); // 可见像素 90% 以上为白 → 判为纯白
      } catch (e) { resolve(false); } // 解析异常不误杀（保留原图）
    };
    img.onerror = () => resolve(false); // 加载失败不误杀
    img.src = dataUrl;
  });
}

/** 设置开关变更后即时作用于当前已渲染的轮播：开→拉取 logo 替换；关→还原文字标题 */
export function applyCarouselLogoNow(): void {
  if (!S.carouselInfos.length) return;
  if (S.carouselLogoEnabled) {
    applyTitleLogo(S.carouselBase, S.carouselShows, S.carouselInfos);
  } else {
    S.carouselInfos.forEach((info) => {
      const slide = info.closest('.fnos-slide') as HTMLElement | null;
      const l = slide?.querySelector('.fnos-logo') as HTMLImageElement | null;
      if (l) { l.style.display = 'none'; l.src = ''; }
    });
  }
}
