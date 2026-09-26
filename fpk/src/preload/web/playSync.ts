// src/preload/web/playSync.ts — 网页端豆瓣/Bangumi 同步触发器（[v0.50.0] Bangumi / [v0.52.0] 豆瓣）。
// ─────────────────────────────────────────────────────────────────────────────
// 桌面版的双同步挂在主进程 media.ts 的 MPV 进度事件上；网页端「原生网页播放」没有 MPV，
// fnOS 原生前端自己向上报进度——包装页面 fetch/XHR 拦截这些请求（浏览器自动携带全部
// 会话 cookie 含 httpOnly，鉴权天然可靠）：
//   · POST /v/api/v1/play/record  → item_guid/ts/duration → 直连 play/info 拿条目元数据
//       → Bangumi：invoke('bangumi:sync-progress', guid, percentage, item)（后端 token 调 bgm.tv）
//       → 豆瓣：  invoke('douban:sync-progress',  guid, percentage, item, duration)（后端带
//                 手动粘贴的 doubanCookie 标「在看/看过」，首有效进度即标在看，无阈值门槛）
//   · POST /v/api/v1/item/watched → 飞牛「标记为已观看」按钮 → invoke('douban:sync-watched')标「看过」
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import logger from '../core/logger';

// [v0.53.0 修复] 网页版 logger 无 component 方法（桌面版专属）——此前顶层调用直接抛
// TypeError，整个 IIFE 中断 → 页面变原生。改用 info/error + 消息前缀。
const log = {
  info: (...a: any[]): void => logger.info('[play-sync]', ...a),
  error: (...a: any[]): void => logger.error('[play-sync]', ...a),
};

// Bangumi 会话级去重（与桌面版 markedSet/missSet 同语义）
const marked = new Set<string>();
const missed = new Set<string>();
// 桌面版白名单（fn_api/types.ts SYNCABLE_ITEM_TYPES）
const SYNCABLE = ['Movie', 'Episode', 'TvSeries', 'TV'];

let _lastFire = 0;          // Bangumi 全局节流
let _lastDoubanFire = 0;    // 豆瓣独立节流
const inflightInfo = new Map<string, Promise<any | null>>(); // play/info 并发去重

/** 前端直连 play/info（同源 fetch 全 cookie + 本地 genAuthx 签名，lc-057 已验证路径） */
function fetchPlayInfo(guid: string): Promise<any | null> {
  const cached = inflightInfo.get(guid);
  if (cached) return cached;
  const p = (async () => {
    try {
      const path = '/v/api/v1/play/info';
      const payload = { item_guid: guid };
      const authx = await ipcRenderer.invoke('fnos-gen-authx', path, payload);
      const resp = await fetch(location.origin + path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Authx': authx, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return null;
      const j: any = await resp.json();
      return (j && j.data && j.data.item) ? j.data.item : null;
    } catch {
      return null;
    } finally {
      setTimeout(() => inflightInfo.delete(guid), 2000);
    }
  })();
  inflightInfo.set(guid, p);
  return p;
}

/** 处理一次 play/record 上报体：豆瓣（无阈值）+ Bangumi（阈值/去重） */
function handleRecord(body: any): void {
  try {
    if (!body || typeof body !== 'object') return;
    const guid = String(body.item_guid || body.itemGuid || '');
    const ts = Number(body.ts || 0);
    const duration = Number(body.duration || 0);
    if (!guid || !(ts > 0) || !(duration > 0)) return;
    const percentage = Math.min(100, (ts / duration) * 100);

    // ── 豆瓣：首次有效进度（duration>0）即标「在看」，无百分比门槛（桌面 syncOnProgress 同语义）；
    //    后端按 stateMap 去重，重复上报后端直接跳过。独立 3s 节流。
    const now = Date.now();
    if (now - _lastDoubanFire > 3000) {
      _lastDoubanFire = now;
      void (async () => {
        const item = await fetchPlayInfo(guid);
        if (!item || !SYNCABLE.includes(String(item.type || ''))) return;
        try {
          const r: any = await ipcRenderer.invoke('douban:sync-progress', guid, percentage, item, duration);
          if (r && r.ok && String(r.message || '').indexOf('已标记') !== -1) {
            log.info('[play-sync][豆瓣]', String(r.message));
          }
        } catch { /* ignore，下次上报再试 */ }
      })();
    }

    // ── Bangumi：阈值 + marked/missed 去重（后端读开关/阈值判定）。
    if (percentage < 5) return; // 开播前百分比恒 0，跳过
    if (marked.has(guid) || missed.has(guid)) return;
    if (now - _lastFire < 3000) return;
    _lastFire = now;

    void (async () => {
      const item = await fetchPlayInfo(guid);
      if (!item) { missed.add(guid); return; }
      const type = String(item.type || '');
      if (!SYNCABLE.includes(type)) { missed.add(guid); return; }
      try {
        const r: any = await ipcRenderer.invoke('bangumi:sync-progress', guid, percentage, item);
        if (r && r.ok && String(r.message || '').includes('已标记')) {
          marked.add(guid);
          log.info('[play-sync]', String(r.message), `（${Math.floor(percentage)}%）`);
        } else if (r && !r.ok) {
          // 未达阈值/未开启/未配 Token：不记 miss（后续上报还会到达阈值；用户可能随时开启）
          const msg = String((r && r.message) || '');
          if (msg.indexOf('未达阈值') === -1 && msg.indexOf('未开启') === -1 && msg.indexOf('Token') === -1) {
            missed.add(guid);
          }
        }
      } catch {
        /* invoke 异常忽略，下次上报再试 */
      }
    })();
  } catch {
    /* ignore */
  }
}

/** 飞牛「标记为已观看」按钮 → 豆瓣标「看过」 */
function handleItemWatched(body: any): void {
  try {
    if (!body || typeof body !== 'object') return;
    const guid = String((body as any).item_guid || (body as any).guid || (body as any).itemGuid || '');
    if (!guid) return;
    void (async () => {
      const item = await fetchPlayInfo(guid);
      if (!item || !SYNCABLE.includes(String(item.type || ''))) return;
      try {
        const r: any = await ipcRenderer.invoke('douban:sync-watched', guid, item);
        if (r && r.ok && String(r.message || '').indexOf('已标记') !== -1) {
          log.info('[play-sync][豆瓣]', String(r.message));
        }
      } catch { /* ignore */ }
    })();
  } catch { /* ignore */ }
}

function inspectRequest(url: string, method: string, bodyText: any): void {
  try {
    if (!bodyText || String(method || '').toUpperCase() !== 'POST') return;
    let parsed: any;
    try { parsed = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText; } catch { return; }
    if (String(url).indexOf('/v/api/v1/play/record') !== -1) handleRecord(parsed);
    else if (String(url).indexOf('/v/api/v1/item/watched') !== -1) handleItemWatched(parsed);
  } catch { /* ignore */ }
}

/** 包装页面 fetch/XHR，监听 fnOS 原生前端的播放进度/已观看上报（diag 之后再挂一层，纯透传） */
export function installPlayRecordHook(): void {
  try {
    const origFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
      try {
        const url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (init && init.body) inspectRequest(url, init.method, init.body);
      } catch { /* ignore */ }
      return origFetch.call(this, input, init);
    };
    // XHR 兜底（fnOS 原生前端若用 XHR 上报）
    const XOpen = XMLHttpRequest.prototype.open as any;
    const XSend = XMLHttpRequest.prototype.send as any;
    (XMLHttpRequest.prototype as any).open = function (this: any, method: string, url: string, ...rest: any[]) {
      try {
        (this as any).__fntvMethod = String(method || '');
        (this as any).__fntvUrl = String(url || '');
      } catch { /* ignore */ }
      return XOpen.apply(this, [method, url, ...rest] as any);
    };
    (XMLHttpRequest.prototype as any).send = function (this: any, body?: any) {
      try {
        if (body && typeof body === 'string') inspectRequest((this as any).__fntvUrl || '', (this as any).__fntvMethod, body);
      } catch { /* ignore */ }
      return XSend.apply(this, [body] as any);
    };
    log.info('[play-sync] play/record + item/watched 拦截已挂载（网页端豆瓣/Bangumi 同步触发器）');
  } catch (e) {
    logger.error('[play-sync] 挂载失败', String(e));
  }
}

installPlayRecordHook(); // 模块加载即自动安装（与 diag 同款，先于所有插件）
