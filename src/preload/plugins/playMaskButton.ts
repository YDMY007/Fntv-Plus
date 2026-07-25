// preload/plugins/playMaskButton.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';
import type { PlayMovieData } from '../core/types';
import { HookType } from '../core/hooks';
import { getPlayButtonConfig } from './playChoice';

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

// 从DOM获取id
function getItemGuidFromDOM(button: HTMLElement): string | null {
    try {
        // 从播放按钮向上查找包含 data-id="details" 的容器
        let container: Element | null = button;
        while (container && container !== document.body) {
            if (container.getAttribute('data-id') === 'details') {
                // 在details容器中查找包含 /v/tv/season/ 或 /v/tv/episode/ 的A标签
                const aLinks = container.querySelectorAll('a[href*="/v/tv/season/"]');
                const eLinks = container.querySelectorAll('a[href*="/v/tv/episode/"]');
                const allLinks = aLinks.length > 0 ? aLinks : eLinks;
                if (allLinks.length > 0) {
                    const link = allLinks[0] as HTMLAnchorElement;
                    const guidMatch = link.href.match(/\/v\/tv\/(?:season|episode)\/([a-f0-9]{32})/i);
                    if (guidMatch && guidMatch[1]) {
                        logger.info('Found guid:', guidMatch[1]);
                        return guidMatch[1];
                    }
                }
                break;
            }
            container = container.parentElement;
        }

        // 如果找不到，从当前URL获取
        const url = window.location.href;
        const urlMatch = url.match(/\/v\/tv\/episode\/([a-f0-9]{32})/i);
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


// 拦截遮罩按钮点击
function interceptMaskButton(): void {
    const playButtons = document.querySelectorAll('.play-mask__btn--play:not([data-mask-intercepted]):not([data-mpv-intercepted])');

    for (let i = 0; i < playButtons.length; i++) {
        const btn = playButtons[i] as HTMLElement;
        // 标记已处理
        btn.setAttribute('data-mask-intercepted', 'true');

        // 添加点击事件拦截器
            const clickHandler = async (e: Event) => {
                // 检查是否允许原有播放（由选择弹窗的「原生播放」触发）
                if (btn.getAttribute('data-allow-original-play') === 'true') {
                    logger.info('Allowing original play logic to execute');
                    return; // 不拦截，让原有逻辑执行
                }

                // 获取配置
                const config = await getPlayButtonConfig();

                if (config.hideOriginalPlayButton) {
                    // 隐藏了原生播放按钮：拦截点击，直接走默认外部播放器
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    logger.info(`Mask button click intercepted, directly playing with ${config.defaultPlayer}`);
                    await playWithPlayer(btn, config.defaultPlayer);
                    return false;
                }

                // 未隐藏原生按钮：放行，让 fnOS 原生遮罩按钮自行处理；
                // 外部播放器按钮由 playButton.ts 的 clonePlayBtnAndInject 在详情区额外注入
                logger.info('Original play button NOT hidden, letting native mask button handle click');
                return;
            };

        // 在捕获阶段添加事件监听器，确保优先拦截
        // 只监听 click 事件，避免重复触发
        btn.addEventListener('click', clickHandler, true);
    }
}

// 注册hook
registerHook(HookType.OnReady, interceptMaskButton);
registerHook(HookType.OnDomChange, interceptMaskButton);

// 轮询兜底: 继续观看等异步渲染/滚动加载的卡片
let _maskPollTimer: any = null;
function startMaskPoll(): void {
    if (_maskPollTimer !== null) return;
    _maskPollTimer = setInterval(() => {
        try {
            const btns = document.querySelectorAll('.play-mask__btn--play:not([data-mask-intercepted])');
            if (btns.length === 0) return;
            interceptMaskButton();
        } catch (e) { /* ignore */ }
    }, 1200);
}
registerHook(HookType.OnReady, startMaskPoll);

export {};
