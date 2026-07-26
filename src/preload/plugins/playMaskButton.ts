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
const GUID_RE = /\/v\/(?:movie|tv)\/(?:season\/|episode\/)?([a-f0-9]{32})/i;
function getItemGuidFromDOM(button: HTMLElement): string | null {
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

        // 2) 首页/列表卡片: 取按钮所属卡片(.card-root / 含 card 类 / 最近 <a>), 从卡片内链接提取 guid。
        //    这是修复「首页封面直接点播放图标走官方网页播放」的关键: 旧逻辑只认 data-id="details",
        //    首页卡片没有该包裹, 导致取不到 guid → 回退到原始点击 → 官方播放器(未劫持)。
        const card = (button.closest('.card-root') ||
            button.closest('[class*="card"]') ||
            button.closest('a')) as HTMLElement | null;
        const scope: Element = card || button;
        const cardLinks = scope.querySelectorAll('a[href]');
        for (const a of Array.from(cardLinks) as HTMLAnchorElement[]) {
            const m = a.href.match(GUID_RE);
            if (m && m[1]) { logger.info('Found guid in card link:', m[1]); return m[1]; }
        }
        if (scope.tagName === 'A') {
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

                // 未隐藏原生按钮：弹出「原生 + 外部播放器」选择弹窗（二选一）
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                logger.info('Original play button NOT hidden, showing player choice modal');
                await createPlayModal(btn, { ...config, hideOriginalPlayButton: false }, (p) => playWithPlayer(btn, p));
                return false;
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

// 首页卡片播放图标劫持(补充 .play-mask__btn--play 之外的情况)
// 现象: 「继续观看」卡片的播放图标是 .play-mask__btn--play(已被 interceptMaskButton 劫持),
//       但首页其他卡片的封面播放图标可能是另一元素(无 data-id="details" 包裹),
//       旧逻辑取不到 guid → 回退到原始点击 → 官方网页播放(未劫持)。
// 这里扫描首页卡片内带「播放」语义的按钮/链接, 统一劫持到外部播放器。
function isPlayLabel(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    return /^(播放|立即播放|播放全片|继续播放|从头播放|play)$/i.test(t)
        || /播放/.test(t) || /^play\b/i.test(t);
}
function interceptHomeCardPlay(): void {
    // 仅在首页(/v)生效, 详情页交给 playButton.ts, 避免误伤
    const path = (location.pathname || '').replace(/\/+$/, '');
    if (path !== '/v' && path !== '') return;

    const cards = document.querySelectorAll('.card-root, [class*="card"]:not([class*="drawer"])');
    cards.forEach((card) => {
        const nodes = card.querySelectorAll('button, a, [role="button"]');
        nodes.forEach((node) => {
            const el = node as HTMLElement;
            if (el.hasAttribute('data-mask-intercepted') || el.hasAttribute('data-mpv-intercepted') || el.hasAttribute('data-home-intercepted')) return;
            if (el.classList.contains('play-mask__btn--play')) return; // 已由 interceptMaskButton 处理
            const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
            let ok = isPlayLabel(label);
            if (!ok) {
                // 无文字标签时, 退化为检测「播放三角」svg 路径
                const pathEl = el.querySelector('svg path[d]') as SVGPathElement | null;
                const d = pathEl ? (pathEl.getAttribute('d') || '') : '';
                ok = d.startsWith('M5.984') || d.includes('18.819') || /M8 5v14|M6 4l14 8-14 8/.test(d);
            }
            if (!ok) return;
            const inCard = el.closest('.card-root') || el.closest('[class*="card"]') || el.closest('a');
            if (!inCard) return;

            el.setAttribute('data-home-intercepted', 'true');
            el.addEventListener('click', async (e: Event) => {
                if (el.getAttribute('data-allow-original-play') === 'true') return;
                const config = await getPlayButtonConfig();
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                logger.info('Home card play icon intercepted, playing with', config.defaultPlayer);
                await playWithPlayer(el, config.defaultPlayer);
                return false;
            }, true);
        });
    });
}
registerHook(HookType.OnReady, interceptHomeCardPlay);

// 首页异步渲染/滚动加载的卡片兜底(低频, 避免每个 DOM 变更都全量扫描)
let _homePollTimer: any = null;
function startHomePoll(): void {
    if (_homePollTimer !== null) return;
    _homePollTimer = setInterval(() => {
        try {
            const path = (location.pathname || '').replace(/\/+$/, '');
            if (path !== '/v' && path !== '') return;
            interceptHomeCardPlay();
        } catch (e) { /* ignore */ }
    }, 1500);
}
registerHook(HookType.OnReady, startHomePoll);

export {};
