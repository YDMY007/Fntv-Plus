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

/** 已触发的 guid 去重集合 */
const triggeredGuids = new Set<string>();

/**
 * 从当前页面 URL 提取 itemGuid。
 * 支持的 URL 模式：
 *   /v/movie/{guid}          — 电影
 *   /v/tv/{guid}             — 剧集主页
 *   /v/tv/season/{guid}      — 季
 *   /v/tv/episode/{guid}     — 单集（最常见于播放场景）
 */
function extractGuidFromUrl(): string | null {
    const url = window.location.href;
    // 按优先级匹配（越具体越靠前）
    const patterns = [
        /\/v\/tv\/episode\/([a-f0-9\-]{36,})/i,
        /\/v\/tv\/season\/([a-f0-9\-]{36,})/i,
        /\/v\/movie\/([a-f0-9\-]{36,})/i,
        /\/v\/tv\/([a-f0-9\-]{36,})(?:\/|$)/i,
    ];
    for (const pat of patterns) {
        const m = url.match(pat);
        if (m?.[1]) return m[1];
    }
    return null;
}

/**
 * 从 DOM 中尝试提取 guid（URL 匹配失败的兜底）。
 * 复用 playMaskButton 已验证的模式：data 属性、链接 href 等。
 */
function extractGuidFromDom(): string | null {
    // 1) video 元素自身或容器可能带 data 属性
    const video = document.querySelector('video');
    if (video) {
        const el = video.closest('[data-guid], [data-item-id], [data-itemguid]') as HTMLElement | null;
        if (el) {
            const g = el.getAttribute('data-guid') || el.getAttribute('data-item-id') || el.getAttribute('data-itemguid');
            if (g) return g;
        }
    }

    // 2) 播放页容器 class
    const container = document.querySelector('.videoPlayer, .playerPage, #videoPlayer') as HTMLElement | null;
    if (container) {
        const g = container.getAttribute('data-guid') || container.getAttribute('data-item-id');
        if (g) return g;
    }

    return null;
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
