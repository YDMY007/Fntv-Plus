// preload/plugins/playButton.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';
import type { PlayMovieData } from '../core/types';

// 获取配置的辅助函数（带 10s 缓存，避免轮询兜底期间频繁 IPC 往返）
let _configCache: { hideOriginalPlayButton: boolean } | null = null;
let _configCacheTime = 0;
async function getPlayButtonConfig(): Promise<{ hideOriginalPlayButton: boolean }> {
    if (_configCache && Date.now() - _configCacheTime < 10000) {
        return _configCache;
    }
    return new Promise((resolve) => {
        // 发送请求获取配置
        ipcRenderer.send('get-play-button-config');

        // 监听回复
        const handler = (event: any, data: any) => {
            ipcRenderer.off('play-button-config-info', handler);
            const cfg = (data || { hideOriginalPlayButton: true }) as { hideOriginalPlayButton: boolean };
            _configCache = cfg; // 默认隐藏
            _configCacheTime = Date.now();
            resolve(cfg);
        };

        ipcRenderer.once('play-button-config-info', handler);

        // 2秒后超时，使用默认值
        setTimeout(() => {
            ipcRenderer.off('play-button-config-info', handler);
            const cfg = _configCache || { hideOriginalPlayButton: true };
            _configCache = cfg;
            _configCacheTime = Date.now();
            resolve(cfg);
        }, 2000);
    });
}

// 发送播放信息到主进程
function sendPlayEventToMain(button: HTMLElement | null = null): string | null {
    const url = window.location.href;
    const id = url.split('/').pop();

    if (!id) {
        logger.error('Failed to extract ID from DOM or URL');
        return null;
    }

    const token = getCookie('Trim-MC-token');

    // 获取当前UI上选中的是第几个播放源
    const sourceIndex = getCurrentSelectedVersionIndex();

    if (id && token) {
        // 将动态获取的 sourceIndex 传给主进程
        const playData: PlayMovieData = { id, token, sourceIndex };
        ipcRenderer.send('play-movie', playData);
        return id;
    } else {
        logger.error('Failed to extract ID or token. ID:', id, 'Token:', token);
        return null;
    }
}

/**
 * 获取当前高亮的版本按钮 Index
 * 原理：在点击播放的瞬间，扫描版本列表，找到那个样式为 primary 的按钮
 */
function getCurrentSelectedVersionIndex(): number {
    try {
        const buttons = Array.from(document.querySelectorAll('button.semi-button.\\!h-9.\\!px-6'));
        
        if (buttons.length === 0) {
            logger.warn('No version buttons found via selector.');
            return 0;
        }

        const selectedIndex = buttons.findIndex(btn => 
            btn.classList.contains('semi-button-primary')
        );

        const result = selectedIndex === -1 ? 0 : selectedIndex;
        logger.info(`Found ${buttons.length} buttons, selected index: ${result}`);
        
        return result;

    } catch (e) {
        logger.error('Error calculating version index:', e);
        // 出错时降级处理，默认播放第0个
        return 0;
    }
}

// 判断文本/标签是否具有“播放”语义（排除预览/试看/预告/设置，避免误拦）
function isPlaySemanticText(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    if (/(预览|试看|预告|trailer|preview|设置|配置|管理)/i.test(t)) return false;
    return /^(播放|立即播放|播放全片|继续播放|从头播放|播放影片|play)$/i.test(t)
        || /^播放/.test(t)
        || /^play\b/i.test(t);
}

// 基于语义 + 多特征搜索播放按钮（增强：覆盖更多入口/版本/异步渲染场景）
function findReferenceButton(context: Document | Element = document): HTMLButtonElement | null {
    // 关键: 排除我们自己注入/已处理的按钮, 避免把克隆体误当原始按钮 → 重复注入累积
    const buttons = (Array.from(context.querySelectorAll('button')) as HTMLButtonElement[])
        .filter(b => !b.hasAttribute('data-mpv-btn') && !b.hasAttribute('data-custom-play'));
    if (buttons.length === 0) return null;

    // 1) 主播放按钮：primary 样式 + 播放语义文本（电影/详情页主按钮最常见形态）
    let btn = buttons.find(b =>
        b.classList.contains('semi-button-primary') && isPlaySemanticText(b.innerText)
    );
    if (btn) return btn;

    // 2) 任何可见按钮，含播放语义文本（覆盖主页卡片/推荐/搜索结果等入口）
    btn = buttons.find(b =>
        isPlaySemanticText(b.innerText) && b.offsetParent !== null
    );
    if (btn) return btn;

    // 3) aria-label 含播放语义
    btn = buttons.find(b => isPlaySemanticText(b.getAttribute('aria-label') || ''));
    if (btn) return btn;

    // 4) 宽松播放图标 + 播放语义（保留原图标思路，但放宽前缀限制，兼容不同版本图标）
    for (const b of buttons) {
        const icon = b.querySelector('svg > path[d]') as SVGPathElement | null;
        const d = icon ? (icon.getAttribute('d') || '') : '';
        const semantic = isPlaySemanticText(b.getAttribute('aria-label') || b.innerText || '');
        if (semantic && (d.startsWith('M5.984') || d.includes('18.819'))) {
            return b;
        }
    }

    // 5) 后备：原精确类名组合（兼容旧版本 UI）
    btn = buttons.find(b => {
        const classes = b.getAttribute('class') || '';
        return classes.includes('semi-button') &&
            classes.includes('semi-button-primary') &&
            classes.includes('!min-w-[150px]');
    });
    if (btn) return btn;

    return null;
}

function clonePlayBtnAndInject(callback: (button: HTMLElement) => void, btnText: string): void {
    // 若页面上已存在我们注入的 MPV 按钮, 直接跳过 → 防止 MutationObserver/轮询触发时累积重复
    if (document.querySelector('[data-custom-play]')) return;
    const referenceButton = findReferenceButton();
    if (!referenceButton || referenceButton.hasAttribute('data-mpv-btn')) return;

    // 仅在详情页「带文字的主播放按钮」旁注入 MPV 按钮;
    // 跳过播放控制栏里的纯图标按钮(播放/暂停, 只有 svg 无文字), 否则原生播放页控制栏会出现多余的 MPV 按钮
    const hasText = (referenceButton.innerText || '').trim().length > 0;
    if (!hasText) return;

    logger.info('Detected inject page, injecting play button...');

    // 标记原始按钮
    referenceButton.setAttribute('data-mpv-btn', 'processed');

    // 克隆并修改按钮
    const newButton = referenceButton.cloneNode(true) as HTMLButtonElement;
    newButton.removeAttribute('data-mpv-btn');

    // 更新按钮文本（保留图标）
    const textSpans = newButton.querySelector('span > span > span') as HTMLSpanElement;
    if (textSpans) textSpans.textContent = btnText;

    // 添加唯一标识
    newButton.setAttribute('data-custom-play', 'true');
    // 同步更新 aria-label, 防止无障碍/选择器把克隆体误判为原始"播放"按钮
    newButton.setAttribute('aria-label', 'MPV播放');

    // 添加点击事件，传入原始按钮作为参数
    newButton.addEventListener('click', () => callback(referenceButton));

    // 插入到参考按钮旁边
    const parentNode = referenceButton.parentNode;
    if (parentNode) {
        parentNode.insertBefore(newButton, referenceButton.nextSibling);
    }
}

// 拦截原有播放按钮，直接用MPV播放
function interceptOriginalButton(): void {
    const referenceButton = findReferenceButton();
    if (!referenceButton || referenceButton.hasAttribute('data-mpv-intercepted')) return;
    // 已被遮罩插件拦截的按钮不再重复拦截，避免重复触发播放
    if (referenceButton.hasAttribute('data-mask-intercepted')) return;

    logger.info('Detected page, intercepting original play button...');

    // 标记已拦截
    referenceButton.setAttribute('data-mpv-intercepted', 'true');

    // 添加点击事件拦截器
    const clickHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        logger.info('Original play button intercepted, playing with MPV');
        sendPlayEventToMain(referenceButton);

        return false;
    };

    // 在捕获阶段添加事件监听器，确保优先拦截
    referenceButton.addEventListener('click', clickHandler, true);
}

async function injectCustomPlayBtn(): Promise<void> {
    // 获取配置
    const config = await getPlayButtonConfig();

    if (config.hideOriginalPlayButton) {
        // 如果隐藏原有播放按钮，直接拦截原按钮
        interceptOriginalButton();
    } else {
        // 否则添加额外的MPV播放按钮
        clonePlayBtnAndInject((button) => sendPlayEventToMain(button), 'MPV播放');
    }
}

// 包装函数来处理异步调用
function handlePlayButtonInjection(): void {
    injectCustomPlayBtn().catch(error => {
        logger.error('Error in injectCustomPlayBtn:', error);
    });
}

// 轮询兜底：部分入口的播放按钮是异步渲染、或仅通过属性变化出现，
// 而 MutationObserver 仅监听 childList，可能错过；用低频轮询确保最终都能被拦截，
// 解决“有时不调用 mpv、直接走网页播放器”的问题。
let pollTimer: any = null;
function startInjectionPoll(): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
        try {
            if (!findReferenceButton()) return;
            injectCustomPlayBtn().catch(error => {
                logger.error('Error in poll injectCustomPlayBtn:', error);
            });
        } catch (e) {
            // 忽略单次轮询异常，下一轮继续
        }
    }, 1200);
}

// 注册hook
registerHook(HookType.OnReady, handlePlayButtonInjection);
registerHook(HookType.OnDomChange, handlePlayButtonInjection);
registerHook(HookType.OnReady, startInjectionPoll);

export { };
