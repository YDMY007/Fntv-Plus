// preload/plugins/playMaskButton.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';
import type { PlayMovieData } from '../core/types';
import { HookType } from '../core/hooks';
import { getPlayButtonConfig, createPlayModal } from './playChoice';

// 调用播放器的公共方法（player 指定 mpv / potplayer）
async function playWithPlayer(button: HTMLElement, player: 'mpv' | 'potplayer'): Promise<void> {
    // 先尝试简化的 DOM 方法
    const domResult = sendPlayEventToMain(button, player);

    if (!domResult) {
        // DOM 方法失败，使用拦截方法作为 fallback
        logger.info('DOM method failed, trying original logic interception...');
        const itemGuid = await tryGetItemGuidFromOriginalLogic(button);

        if (itemGuid) {
            logger.info('Successfully obtained item_guid from original logic:', itemGuid);
            const token = getCookie('Trim-MC-token');
            if (token) {
                const playData: PlayMovieData = { id: itemGuid, token: token, sourceIndex: 0, player };
                ipcRenderer.send('play-movie', playData);
            } else {
                logger.error('No token found');
            }
        } else {
            logger.error('All methods failed to get item_guid');
        }
    } else {
        logger.info('Successfully used DOM method to get item_guid');
    }
}

// 尝试通过执行原有逻辑获取 item_guid
function tryGetItemGuidFromOriginalLogic(button: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            // 创建一个临时的网络请求拦截器
            const originalFetch = window.fetch;
            const originalXHROpen = XMLHttpRequest.prototype.open;
            const originalXHRSend = XMLHttpRequest.prototype.send;

            let interceptedGuid: string | null = null;
            const timeout = setTimeout(() => {
                // 恢复原有方法
                window.fetch = originalFetch;
                XMLHttpRequest.prototype.open = originalXHROpen;
                XMLHttpRequest.prototype.send = originalXHRSend;
                resolve(null);
            }, 2000);

            // 拦截 fetch 请求
            window.fetch = function (url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
                logger.info('Intercepted fetch request:', url, options);
                if (typeof url === 'string' && url.includes('/api/v1/play/info') && options && options.body) {
                    try {
                        const body = JSON.parse(options.body as string);
                        if (body.item_guid) {
                            interceptedGuid = body.item_guid;
                            logger.info('Found item_guid in fetch request:', interceptedGuid);
                        }
                    } catch (e) {
                        logger.error('Error parsing fetch body:', e);
                    }
                }
                // 不执行实际的播放请求，直接返回一个假的 Promise
                if (typeof url === 'string' && url.includes('/api/v1/play/info')) {
                    return Promise.resolve({
                        ok: false,
                        status: 200,
                        json: () => Promise.resolve({ success: false, message: 'Intercepted for guid extraction' })
                    } as Response);
                }
                return originalFetch.apply(this, arguments as any);
            };

            // 拦截 XMLHttpRequest
            XMLHttpRequest.prototype.open = function (method: string, url: string | URL): void {
                (this as any)._url = url;
                return originalXHROpen.apply(this, arguments as any);
            };

            XMLHttpRequest.prototype.send = function (data?: Document | XMLHttpRequestBodyInit | null): void {
                const thisXHR = this as any;
                if (thisXHR._url && typeof thisXHR._url === 'string' && thisXHR._url.includes('/api/v1/play/info') && data) {
                    try {
                        const parsedData = JSON.parse(data as string);
                        if (parsedData.item_guid) {
                            interceptedGuid = parsedData.item_guid;
                            logger.info('Found item_guid in XHR request:', interceptedGuid);
                        }
                    } catch (e) {
                        logger.error('Error parsing XHR data:', e);
                    }
                    // 不发送实际请求，模拟一个错误响应
                    setTimeout(() => {
                        if (this.onreadystatechange) {
                            (this as any).readyState = 4;
                            (this as any).status = 404;
                            (this as any).responseText = JSON.stringify({ success: false, message: 'Intercepted for guid extraction' });
                            this.onreadystatechange(new Event('readystatechange'));
                        }
                    }, 100);
                    return;
                }
                return originalXHRSend.apply(this, arguments as any);
            };

            // 触发原有点击事件
            button.setAttribute('data-allow-original-play', 'true');
            setTimeout(() => {
                const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                });
                button.dispatchEvent(clickEvent);

                // 检查是否获取到了 guid
                setTimeout(() => {
                    clearTimeout(timeout);
                    // 恢复原有方法
                    window.fetch = originalFetch;
                    XMLHttpRequest.prototype.open = originalXHROpen;
                    XMLHttpRequest.prototype.send = originalXHRSend;
                    button.removeAttribute('data-allow-original-play');
                    resolve(interceptedGuid);
                }, 1000);
            }, 50);

        } catch (error) {
            logger.error('Error in tryGetItemGuidFromOriginalLogic:', error);
            resolve(null);
        }
    });
}

// 从DOM获取id（兼容详情页与首页卡片）
export const GUID_RE = /\/v\/(?:movie|tv)\/(?:season\/|episode\/)?([a-f0-9]{32})/i;
export function getItemGuidFromDOM(button: HTMLElement): string | null {
    try {
        // 1) 详情页: data-id="details" 容器内的 季/集/电影 链接
        let container: Element | null = button;
        while (container && container !== document.body) {
            if (container.getAttribute && container.getAttribute('data-id') === 'details') {
                const links = container.querySelectorAll('a[href]');
                for (const a of Array.from(links) as HTMLAnchorElement[]) {
                    const m = a.href.match(GUID_RE);
                    if (m && m[1]) { logger.info('Found guid in details:', m[1]); return m[1]; }
                }
                break;
            }
            container = container.parentElement;
        }

        // 0) 按钮自身携带的 guid（部分浮层菜单项直接带 data-item-guid / data-guid / data-id）
        const selfGuid = button.getAttribute('data-item-guid') || button.getAttribute('data-guid') || button.getAttribute('data-id') || '';
        if (selfGuid) {
            const m = selfGuid.match(GUID_RE);
            if (m && m[1]) { logger.info('Found guid in button data attr:', m[1]); return m[1]; }
        }
        // 1) 按钮自身即 <a href> 含 guid（常见于「继续观看」浮层菜单项）
        if (button.tagName === 'A') {
            const m = (button as HTMLAnchorElement).href.match(GUID_RE);
            if (m && m[1]) { logger.info('Found guid in button anchor:', m[1]); return m[1]; }
        }
        // 2) 首页/列表卡片 或 浮层菜单(dropdown/popover/menu/portal): 从容器内链接提取 guid。
        //    修复「继续观看」的「从头播放 / 继续播放」菜单项: 它们常渲染在脱离卡片的浮层里,
        //    故把浮层容器也纳入查找范围; 浮层内任意指向 /v/{movie|tv}/{guid} 的链接都能提供 guid。
        const card = (button.closest('.card-root') ||
            button.closest('[class*="card"]') ||
            button.closest('a') ||
            button.closest('[class*="dropdown"]') ||
            button.closest('[class*="popover"]') ||
            button.closest('[class*="menu"]') ||
            button.closest('[role="menu"]') ||
            button.closest('[role="listbox"]') ||
            button.closest('.semi-portal')) as HTMLElement | null;
        const scope: Element = card || button;
        const cardLinks = scope.querySelectorAll('a[href]');
        for (const a of Array.from(cardLinks) as HTMLAnchorElement[]) {
            const m = a.href.match(GUID_RE);
            if (m && m[1]) { logger.info('Found guid in card/floating link:', m[1]); return m[1]; }
        }
        if (scope !== button && scope.tagName === 'A') {
            const m = (scope as HTMLAnchorElement).href.match(GUID_RE);
            if (m && m[1]) { logger.info('Found guid in card anchor:', m[1]); return m[1]; }
        }

        // 3) URL 兜底(详情页等)
        const url = window.location.href;
        const urlMatch = url.match(GUID_RE);
        if (urlMatch && urlMatch[1]) {
            logger.info('Found guid from URL:', urlMatch[1]);
            return urlMatch[1];
        }

        return null;
    } catch (error) {
        logger.error('Error extracting guid from DOM:', error);
        return null;
    }
}

// 发送播放信息到主进程
function sendPlayEventToMain(button: HTMLElement | null = null, player: 'mpv' | 'potplayer' = 'mpv'): string | null {
    let id = '';

    // 尝试从DOM中获取guid
    if (button) {
        id = getItemGuidFromDOM(button) || '';
    }

    if (!id) {
        return null; // 返回 null 表示需要使用拦截方法
    }

    const token = getCookie('Trim-MC-token');

    if (id && token) {
        const playData: PlayMovieData = { id, token, sourceIndex: 0, player };
        ipcRenderer.send('play-movie', playData);
        return id;
    } else {
        logger.error('Failed to extract ID or token. ID:', id, 'Token:', token);
        return null;
    }
}


// ===== 统一播放按钮拦截(修复首页点击「MPV + 网页原生双播」) =====
// 根因: 之前把 click 捕获监听挂在各个按钮上, 而 fnOS 的点击委托处理器通常挂在
// document / 根容器(也是捕获阶段), 层级比按钮更高 → 它的捕获监听先执行,
// 会先把页面跳转到 /v/video/{guid} 视频页; 我们按钮上的
// preventDefault/stopImmediatePropagation 无法回头阻止这次跳转。
// 视频页加载后网页原生 <video> 自动播放, 同时我们的劫持又起了 MPV → 双播放。
// 修复: 改为在 window(比 document 更高) 捕获阶段拦截, 确保先于 fnOS 执行,
//       真正 preventDefault + stopImmediatePropagation 阻止跳转与原生播放。

// 是否「播放」语义(对齐 playButton.ts 的排除规则, 避免误拦 预览/试看/预告)
function isPlayLabel(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    if (/(预览|试看|预告|trailer|preview|设置|配置|管理)/i.test(t)) return false;
    return /^(播放|立即播放|播放全片|继续播放|从头播放|play)$/i.test(t)
        || /播放/.test(t) || /^play\b/i.test(t);
}

// 首页卡片内查找「带播放语义的封面播放图标」(排除 .play-mask__btn--play, 那种走上面分支)
function findHomeCardPlay(target: HTMLElement): HTMLElement | null {
    const path = (location.pathname || '').replace(/\/+$/, '');
    if (path !== '/v' && path !== '') return null;

    const el = target.closest('button, a, [role="button"]') as HTMLElement | null;
    if (!el) return null;
    if (el.classList.contains('play-mask__btn--play')) return null;
    if (el.hasAttribute('data-mpv-intercepted')) return null; // 详情页已处理的按钮跳过

    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    let ok = isPlayLabel(label);
    if (!ok) {
        // 无文字标签时, 退化为检测「播放三角」svg 路径
        const pathEl = el.querySelector('svg path[d]') as SVGPathElement | null;
        const d = pathEl ? (pathEl.getAttribute('d') || '') : '';
        ok = d.startsWith('M5.984') || d.includes('18.819') || /M8 5v14|M6 4l14 8-14 8/.test(d);
    }
    if (!ok) return null;

    // 放宽容器限制: 除了常规卡片(.card-root/[class*=card]/a), 也接受浮层菜单
    // (dropdown/popover/menu/listbox/semi-portal) —— 这是修复「继续观看」的「从头播放 /
    // 继续播放」菜单项的关键: 这些项渲染在脱离卡片的浮层里, 旧逻辑因找不到卡片容器而
    // 直接 return null, 导致点击落到 fnOS 网页原生播放。
    const inCard = el.closest('.card-root') ||
        el.closest('[class*="card"]') ||
        el.closest('a') ||
        el.closest('[class*="dropdown"]') ||
        el.closest('[class*="popover"]') ||
        el.closest('[class*="menu"]') ||
        el.closest('[role="menu"]') ||
        el.closest('[role="listbox"]') ||
        el.closest('.semi-portal');
    if (!inCard) return null;
    return el;
}

function handleMaskPlay(mask: HTMLElement): void {
    (async () => {
        try {
            const config = await getPlayButtonConfig();
            if (config.hideOriginalPlayButton) {
                logger.info(`Mask button click intercepted, directly playing with ${config.defaultPlayer}`);
                await playWithPlayer(mask, config.defaultPlayer);
            } else {
                logger.info('Original play button NOT hidden, showing player choice modal');
                await createPlayModal(mask, { ...config, hideOriginalPlayButton: false }, (p) => playWithPlayer(mask, p));
            }
        } catch (err) {
            logger.error('Error in handleMaskPlay:', err);
        }
    })();
}

let _playClickInstalled = false;
function installPlayClickInterceptor(): void {
    if (_playClickInstalled) return;
    _playClickInstalled = true;

    window.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (!target || typeof (target as any).closest !== 'function') return;

        // 放行由「原生播放」按钮 / guid 兜底回退 触发的合成点击(带 data-allow-original-play)
        if (target.closest('[data-allow-original-play="true"]')) return;

        // 1) 遮罩播放按钮 .play-mask__btn--play
        const mask = target.closest('.play-mask__btn--play') as HTMLElement | null;
        if (mask) {
            mask.setAttribute('data-mask-intercepted', 'true'); // 兼容 playButton.ts 互检
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            handleMaskPlay(mask);
            return;
        }

        // 2) 首页卡片封面播放图标(非 .play-mask__btn--play 的其它播放入口)
        const cardPlay = findHomeCardPlay(target);
        if (cardPlay) {
            cardPlay.setAttribute('data-home-intercepted', 'true');
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            (async () => {
                const config = await getPlayButtonConfig();
                logger.info('Home card play icon intercepted, playing with', config.defaultPlayer);
                await playWithPlayer(cardPlay, config.defaultPlayer);
            })();
            return;
        }
    }, true);
}

registerHook(HookType.OnReady, installPlayClickInterceptor);
// 注: 不再逐个按钮挂捕获监听(会晚于 fnOS 的 document 级捕获, 拦不住跳转),
//     改为 window 级单次捕获, 覆盖全页含异步/滚动加载的卡片。
//     playButton.ts 仍独立处理详情页 .semi-button-primary 主播放按钮, 互不冲突。

export {};
