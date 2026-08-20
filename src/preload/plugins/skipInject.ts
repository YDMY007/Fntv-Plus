// preload/plugins/skipInject.ts
//
// [lc-316] 飞牛原生网页播放器「跳过片头/片尾」自动填充插件。
//
// 原理：飞牛原生播放器已有 skip intro/outro 面板（滑块+重置），但默认数据为空(00:00)。
// 本插件在检测到播放页激活时，提取当前播放项 guid → 通过 IPC 让主进程查询跳过数据
// （fnOS 服务端优先，为空则 theintrodb 兜底）→ 写回飞牛服务端 → 面板自动有值。
//
// 设计约束：
// - 不碰播放器样式/窗口配置/GPU/DevTools（用户明确禁止）
// - 只做"检测播放页 + 提取 guid + 触发填充"，纯数据管道
// - 同一 guid 进程内只触发一次（去重）

import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';

const log = logger;

/**
 * [lc-421] 飞牛元数据保存接口捕获（页面侧，绕过主进程 partition 限制）。
 * 捕获 upload / saveEditDetail / getEditDetail 三条请求及其响应，打印 method/url/body/resp，
 * 用于逆向「详情页 Logo 回填」所需的真实保存端点与请求体。
 * 注：主进程 webRequest 拦截挂在特定 partition 的 session 上，覆盖不到飞牛页面，故改在页面侧抓。
 */
const CAPTURE_API_RE = /(^|\/)(upload|saveEditDetail|getEditDetail|editDetail)(\?|$)/i;
function captureFnosApi(url: string, method: string, body: any, headers?: any): void {
    try {
        if (!CAPTURE_API_RE.test(url)) return;
        let bodyStr = '';
        if (body) {
            if (typeof body === 'string') {
                bodyStr = body;
            } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
                try {
                    const parts: string[] = [];
                    (body as any).forEach((val: any, key: string) => {
                        if (val && typeof val === 'object' && val.name) parts.push(`${key}=[file:${val.name},${val.type || ''},${val.size ?? '?'}B]`);
                        else parts.push(`${key}=${String(val).slice(0, 200)}`);
                    });
                    bodyStr = '{' + parts.join(', ') + '}';
                } catch { bodyStr = '[FormData]'; }
            } else {
                try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
            }
        }
        // 记录 Authx 请求头（尤其飞牛原生手动上传时的真实签名，用于校准自动回填的上传签名）
        let authxStr = '';
        if (headers) {
            const a = (typeof headers.get === 'function') ? headers.get('Authx') : (headers['Authx'] || headers['authx']);
            if (a) authxStr = ' | Authx=' + String(a).slice(0, 120);
        }
        log.info(`[API捕获-页面] ${method} ${url} | body=${bodyStr.slice(0, 6000)}${authxStr}`);
    } catch (e) {
        log.error('[API捕获-页面] 处理异常', String(e));
    }
}

/** 已触发的 guid 去重集合 */
const triggeredGuids = new Set<string>();

/**
 * fnOS 标准 GUID 正则（32 位十六进制，无连字符）。
 * 与 playMaskButton.ts 的 GUID_RE 保持一致。
 */
const GUID_RE = /\/v\/(?:movie|tv|video)(?:\/(?:season|episode))?\/([a-f0-9]{32})/i;

/** 通过 fetch/XHR 拦截捕获的 guid（最可靠，优先使用） */
let interceptedGuid: string | null = null;

/** [lc-603] 导出最近一次拦截到的 item_guid——供 playMaskButton 外部播放兜底复用：
 *  skipInject 的 fetch/XHR 拦截在用户点播放按钮时会可靠抓到 play/info 请求体里的
 *  item_guid（个人视频/未刮削视频详情页 URL 无 guid 时，这是唯一可靠来源）。 */
export function getInterceptedGuid(): string | null {
  return interceptedGuid;
}

/**
 * 从当前页面 URL 提取 itemGuid。
 * 使用 fnOS 标准 GUID 正则（32 位十六进制），与 playMaskButton.ts 的 GUID_RE 一致。
 * 支持的 URL 模式：
 *   /v/movie/{guid}          — 电影
 *   /v/tv/{guid}             — 剧集主页
 *   /v/tv/season/{guid}      — 季
 *   /v/tv/episode/{guid}     — 单集
 *   /v/video/{guid}          — 视频播放页（部分版本）
 */
function extractGuidFromUrl(): string | null {
    const url = window.location.href;
    const m = url.match(GUID_RE);
    return m?.[1] || null;
}

/**
 * 从 DOM 中尝试提取 guid（URL 匹配失败的兜底）。
 * 复用 playMaskButton 已验证的模式：data 属性、链接 href 等。
 */
function extractGuidFromDom(): string | null {
    // 0) 优先使用拦截到的 guid
    if (interceptedGuid) return interceptedGuid;

    // 1) video 元素自身或容器可能带 data 属性
    const video = document.querySelector('video');
    if (video) {
        const el = video.closest('[data-guid], [data-item-id], [data-itemguid], [data-id]') as HTMLElement | null;
        if (el) {
            const g = el.getAttribute('data-guid') || el.getAttribute('data-item-id') ||
                      el.getAttribute('data-itemguid') || el.getAttribute('data-id');
            if (g) {
                const m = g.match(/[a-f0-9]{32}/i);
                if (m?.[0]) return m[0];
            }
        }
    }

    // 2) 播放页容器 class 或页面内任意含 guid 的链接
    const container = document.querySelector('.videoPlayer, .playerPage, #videoPlayer, [class*="player"]') as HTMLElement | null;
    const scope = container || document.body;
    const links = scope.querySelectorAll('a[href]');
    for (const a of Array.from(links) as HTMLAnchorElement[]) {
        const m = a.href.match(GUID_RE);
        if (m?.[1]) return m[1];
    }

    // 3) 当前 URL 再试一次（可能 DOM 变化后 URL 也变了）
    return extractGuidFromUrl();
}

/**
 * 核心逻辑：检测到播放页后触发一次 fetch-and-fill。
 */
async function tryFillSkipData(): Promise<void> {
    // 先从 URL 取（最可靠）
    let guid = extractGuidFromUrl();
    if (!guid) {
        guid = extractGuidFromDom();
    }
    if (!guid) {
        log.debug('无法提取 itemGuid，跳过填充');
        return;
    }

    // 去重
    if (triggeredGuids.has(guid)) {
        return;
    }
    triggeredGuids.add(guid);

    log.info(`[skipInject] 检测到播放页，触发填充 guid=${guid}`);

    try {
        const result = await ipcRenderer.invoke('skip:fetch-and-fill', { guid }) as {
            filled: boolean;
            skipStart: number;
            skipEnd: number;
            source: string;
            message?: string;
        };

        if (result.filled) {
            log.info(`[skipInject] ✅ 填充成功 source=${result.source} start=${result.skipStart}s end=${result.skipEnd}s`);
        } else {
            log.info(`[skipInject] ⏭ 无需填充或无数据 source=${result.source} msg=${result.message || ''}`);
        }
    } catch (e) {
        log.error('[skipInject] fetch-and-fill IPC 调用失败:', e);
    }
}

/**
 * 判断当前页面是否为视频播放页。
 * 条件：存在 <video> 元素 或 播放器容器 class。
 */
function isVideoPlayerPage(): boolean {
    return !!(
        document.querySelector('video') ||
        document.querySelector('.videoPlayer, .playerPage, #videoPlayer')
    );
}

// ─── fetch/XHR 拦截：捕获播放请求中的 item_guid（最可靠方式）───

/**
 * 从请求体 JSON 中提取 item_guid。
 * fnOS 播放接口（getPlayInfo / playvideo）的 POST/GET 请求体里带 item_guid 字段。
 */
function tryExtractGuidFromRequestBody(body: any): string | null {
    if (!body) return null;
    // 直接字段
    if (body.item_guid && typeof body.item_guid === 'string' && /^[a-f0-9]{32}$/.test(body.item_guid)) {
        return body.item_guid;
    }
    // 嵌套在 data / params 里
    for (const key of ['data', 'params', 'query']) {
        if (body[key]?.item_guid && typeof body[key].item_guid === 'string') {
            const g = body[key].item_guid.match(/[a-f0-9]{32}/i);
            if (g?.[0]) return g[0];
        }
    }
    return null;
}

/** 初始化拦截器（只执行一次） */
let interceptorSetup = false;
function setupInterceptors(): void {
    if (interceptorSetup) return;
    interceptorSetup = true;

    // 拦截 fetch
    const origFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url || '';
        const method = (init?.method || 'GET').toUpperCase();
        // 只关注 fnOS 播放相关 API
        if (url.includes('play') || url.includes('Play') || url.includes('media')) {
            try {
                if (init?.body) {
                    const parsed = JSON.parse(typeof init.body === 'string' ? init.body : '');
                    const guid = tryExtractGuidFromRequestBody(parsed);
                    if (guid) {
                        log.info(`[skipInject] fetch 拦截到 guid=${guid} url=${url.slice(0, 80)}`);
                        interceptedGuid = guid;
                    }
                }
            } catch { /* 非 JSON body，忽略 */ }
        }
        // [lc-421] 捕获飞牛元数据保存接口（含响应体）
        if (CAPTURE_API_RE.test(url)) {
            captureFnosApi(url, method, init?.body, init?.headers);
            const resp = await origFetch.call(this, input, init);
            try {
                const ct = resp.headers?.get?.('content-type') || '';
                if (ct.includes('json')) {
                    const txt = await resp.clone().text();
                    log.info(`[API捕获-页面][响应] ${method} ${url} | resp=${txt.slice(0, 6000)}`);
                }
            } catch { /* 读取响应失败，忽略 */ }
            return resp;
        }
        return origFetch.call(this, input, init);
    };

    // 拦截 XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
        (this as any)._skipUrl = String(url);
        (this as any)._skipMethod = String(method || 'GET').toUpperCase();
        return (origOpen as any).call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body?: any) {
        const url = (this as any)._skipUrl || '';
        const method = (this as any)._skipMethod || 'GET';
        if ((url.includes('play') || url.includes('Play') || url.includes('media')) && body) {
            try {
                const parsed = JSON.parse(typeof body === 'string' ? body : '');
                const guid = tryExtractGuidFromRequestBody(parsed);
                if (guid) {
                    log.info(`[skipInject] XHR 拦截到 guid=${guid} url=${url.slice(0, 80)}`);
                    interceptedGuid = guid;
                }
            } catch { /* 非 JSON body，忽略 */ }
        }
        // [lc-421] 捕获飞牛元数据保存接口（XHR 侧，仅请求）
        captureFnosApi(url, method, body);
        return origSend.call(this, body);
    };
}

// 页面加载时立即安装拦截器（不等 hooks）
setupInterceptors();

// ─── 注册钩子 ───

// OnReady: 页面加载完成后立即检查
registerHook(HookType.OnReady, () => {
    // 延迟一点等 fnOS 播放器 DOM 完全渲染
    setTimeout(() => {
        if (isVideoPlayerPage()) {
            tryFillSkipData();
        }
    }, 1500);
});

// OnDomChange: SPA 路由切换时也可能出现播放页（fnOS 是单页应用）
registerHook(HookType.OnDomChange, () => {
    if (isVideoPlayerPage()) {
        // 短暂防抖：DOM 变化频繁，避免重复触发
        setTimeout(() => {
            if (isVideoPlayerPage()) {
                tryFillSkipData();
            }
        }, 800);
    }
});
