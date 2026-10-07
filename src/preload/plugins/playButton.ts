// preload/plugins/playButton.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';
import type { PlayMovieData } from '../core/types';
import { getPlayButtonConfig, createPlayModal, PlayButtonConfig } from './playChoice';
import { getItemGuidFromDOM, tryGetItemGuidFromOriginalLogic } from './playMaskButton';

// 发送播放信息到主进程
function sendPlayEventToMain(button: HTMLElement | null = null, player: 'mpv' | 'potplayer' = 'mpv'): string | null {
    // [lc-224] 从按钮(及其祖先链接)提取真实 item guid, 不再用 window.location.href 末段:
    // 首页 path=/v 时末段是 "v", 会令 getPlayInfo("v") 404 → 播放器打不开。
    // 复用 playMaskButton 的 getItemGuidFromDOM(兼容详情页/首页卡片/浮层菜单)。
    // [lc-614] 不再用 getInterceptedGuid() 兜底: 它是【上一次播放】的 guid, 可能滞后导致
    // 播错视频且"误报成功"(返回旧 id 让调用方跳过拦截兜底)。DOM 提取失败一律返回 null,
    // 由调用方走 tryGetItemGuidFromOriginalLogic 实时拦截【本次点击】的 guid。
    const id = button ? getItemGuidFromDOM(button) : '';

    if (!id) {
        logger.error('Failed to extract item guid from button/DOM');
        return null;
    }

    const token = getCookie('Trim-MC-token');

    // 获取当前UI上选中的是第几个播放源
    const sourceIndex = getCurrentSelectedVersionIndex();

    if (id && token) {
        // 将动态获取的 sourceIndex 传给主进程
        const playData: PlayMovieData = { id, token, sourceIndex, player };
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
    if (/(预览|试看|预告|trailer|preview|设置|配置|管理|播放器)/i.test(t)) return false;
    return /^(播放|立即播放|播放全片|继续播放|从头播放|播放影片|play)$/i.test(t)
        || /^播放/.test(t)
        || /^play\b/i.test(t);
}

// 基于语义 + 多特征搜索播放按钮（增强：覆盖更多入口/版本/异步渲染场景）
function findReferenceButton(context: Document | Element = document): HTMLButtonElement | null {
    // 关键: 排除我们自己注入/已处理的按钮, 避免把克隆体误当原始按钮 → 重复注入累积
    const buttons = (Array.from(context.querySelectorAll('button')) as HTMLButtonElement[])
        .filter(b => !b.hasAttribute('data-mpv-btn') && !b.hasAttribute('data-custom-play')
            // [lc-231] 排除我们自建 UI(设置面板等, 带 data-fnos-ui 标记)内的按钮:
            // 否则「播放器」导航按钮会被误判为播放键并挂捕获拦截, 吃掉点击导致分类打不开
            && !(b.closest && b.closest('[data-fnos-ui]'))
            // [lc-661] 排除隐藏/离屏按钮: 个人视频详情页(/v/other/)初始渲染存在瞬态隐藏的
            //   「播放」副本(display:none, offsetParent=null), 命中它会把克隆体插进隐藏子树
            //   → 注入的 MPV 按钮永远不可见。剧集页(/v/tv|movie/)无此副本故一直正常。
            && b.offsetParent !== null);
    if (buttons.length === 0) return null;

    // [lc-1282] 文本统一用 textContent：innerText 读取强制样式+布局计算，本函数
    // 在每次 DOM 变动/轮询中被全文档逐按钮调用，是布局抖动热点。能走到这里的按钮
    // 已被上方 offsetParent 过滤为可见，textContent 与 innerText 取值等价。
    // 1) 主播放按钮：primary 样式 + 播放语义文本（电影/详情页主按钮最常见形态）
    let btn = buttons.find(b =>
        b.classList.contains('semi-button-primary') && isPlaySemanticText(b.textContent || '')
    );
    if (btn) return btn;

    // 2) 任何可见按钮，含播放语义文本（覆盖主页卡片/推荐/搜索结果等入口）
    btn = buttons.find(b =>
        isPlaySemanticText(b.textContent || '') && b.offsetParent !== null
    );
    if (btn) return btn;

    // 3) aria-label 含播放语义
    btn = buttons.find(b => isPlaySemanticText(b.getAttribute('aria-label') || ''));
    if (btn) return btn;

    // 4) 宽松播放图标 + 播放语义（保留原图标思路，但放宽前缀限制，兼容不同版本图标）
    for (const b of buttons) {
        const icon = b.querySelector('svg > path[d]') as SVGPathElement | null;
        const d = icon ? (icon.getAttribute('d') || '') : '';
        const semantic = isPlaySemanticText(b.getAttribute('aria-label') || b.textContent || '');
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

// [lc-1282] 返回是否真的注入了克隆按钮（供轮询退避判定「本轮有实效」）
function clonePlayBtnAndInject(callback: (button: HTMLElement) => void, btnText: string): boolean {
    // 已注入按钮：标签与当前默认播放器一致则跳过；
    // 不一致（切换了 MPV/PotPlayer）则移除旧按钮、清除占用标记后重建，避免需多次刷新才更新
    const existing = document.querySelector('[data-custom-play]') as HTMLElement | null;
    if (existing) {
        const curText = (existing.getAttribute('aria-label') || existing.textContent || '').trim();
        if (curText === btnText) return false;
        existing.remove();
        const ref = findReferenceButton();
        if (ref) ref.removeAttribute('data-mpv-btn'); // 清除占用标记，允许重新注入新播放器按钮
    } else {
        // [lc-661] 克隆被 React 重渲染移除(无 [data-custom-play] 残留)时: 清除可见参考按钮上的
        //   占用标记, 否则下一轮 findReferenceButton 会跳过它(且已无隐藏副本可 fallback)→ 按钮永久消失。
        const marked = document.querySelector('button[data-mpv-btn]') as HTMLButtonElement | null;
        if (marked && marked.offsetParent !== null) marked.removeAttribute('data-mpv-btn');
    }
    const referenceButton = findReferenceButton();
    if (!referenceButton || referenceButton.hasAttribute('data-mpv-btn')) return false;

    // 仅在详情页「主播放按钮」旁注入 MPV 按钮;
    // 跳过播放控制栏里的纯图标按钮(播放/暂停, 只有 svg 无文字), 否则原生播放页控制栏会出现多余的 MPV 按钮。
    // [lc-660] 个人视频详情页(/v/video/)主播放按钮形态与剧集页一致(semi-button-primary + !min-w-[150px]),
    //   但其可视文字可能因 DOM 结构(图标按钮 + aria-label)导致 innerText 取空而被 hasText 误杀 → 漏注入外部播放按钮。
    //   改为按「主按钮形态」放行(primary 或 !min-w-[150px]); 仅对真正的纯图标小按钮(控制栏播放/暂停)才要求文字。
    const isMainButtonShape = referenceButton.classList.contains('semi-button-primary')
        || (referenceButton.getAttribute('class') || '').includes('!min-w-[150px]');
    const hasText = (referenceButton.textContent || '').trim().length > 0;
    if (!isMainButtonShape && !hasText) return false;

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
    newButton.setAttribute('aria-label', btnText);

    // 添加点击事件，传入原始按钮作为参数
    newButton.addEventListener('click', () => callback(referenceButton));

    // 插入到参考按钮旁边
    const parentNode = referenceButton.parentNode;
    if (parentNode) {
        parentNode.insertBefore(newButton, referenceButton.nextSibling);
    }
    return true;
}

// 拦截原有播放按钮，按默认播放器直接播放
// [lc-1282] 返回是否真的拦截了原按钮（供轮询退避判定「本轮有实效」）
function interceptOriginalButton(defaultPlayer: 'mpv' | 'potplayer'): boolean {
    const referenceButton = findReferenceButton();
    if (!referenceButton || referenceButton.hasAttribute('data-mpv-intercepted')) return false;
    // 已被遮罩插件拦截的按钮不再重复拦截，避免重复触发播放
    if (referenceButton.hasAttribute('data-mask-intercepted')) return false;

    logger.info('Detected page, intercepting original play button...');

    // 标记已拦截
    referenceButton.setAttribute('data-mpv-intercepted', 'true');

    // 添加点击事件拦截器
    const clickHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        logger.info(`Original play button intercepted, playing with ${defaultPlayer}`);
        sendPlayEventToMain(referenceButton, defaultPlayer);

        return false;
    };

    // 在捕获阶段添加事件监听器，确保优先拦截
    referenceButton.addEventListener('click', clickHandler, true);
    return true;
}

// 拦截季/选集（全部剧集）页面的主播放按钮：弹出「原生 / 外部播放器」选择，而不是立即播放
function interceptOriginalButtonWithChoice(config: PlayButtonConfig): void {
    const referenceButton = findReferenceButton();
    if (!referenceButton || referenceButton.hasAttribute('data-mpv-btn')) return;
    // 已被遮罩插件拦截的按钮不再重复拦截，避免重复触发播放
    if (referenceButton.hasAttribute('data-mask-intercepted')) return;
    if (referenceButton.hasAttribute('data-mpv-intercepted')) return;

    logger.info('Detected season page, intercepting main play button to show choice modal...');

    // 标记已拦截
    referenceButton.setAttribute('data-mpv-intercepted', 'true');

    // 添加点击事件拦截器
    const clickHandler = (e: Event) => {
        // 放行原生播放（由选择弹窗的「原生播放」触发）
        if (referenceButton.getAttribute('data-allow-original-play') === 'true') {
            logger.info('Allowing original native play logic to execute');
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        logger.info('Season page main play button: showing player choice modal');
        createPlayModal(referenceButton, config, (player) => sendPlayEventToMain(referenceButton, player));

        return false;
    };

    // 在捕获阶段添加事件监听器，确保优先拦截
    referenceButton.addEventListener('click', clickHandler, true);
}

// [lc-1282] 返回是否实际做了注入/拦截（true=本轮有实效；页面无候选或早已完成时 false）
async function injectCustomPlayBtn(): Promise<boolean> {
    // 获取配置
    const config = await getPlayButtonConfig();

    if (config.hideOriginalPlayButton) {
        // 隐藏了原生播放按钮：直接拦截原按钮（按默认外部播放器，无弹窗）
        return interceptOriginalButton(config.defaultPlayer);
    } else {
        // 未隐藏原生按钮：在详情页主播放按钮旁克隆一个外部播放器按钮（两个并排，各播各的）
        const label = config.defaultPlayer === 'potplayer' ? 'PotPlayer' : 'MPV播放';
        // [lc-614] 回调改 async: DOM 提取失败(个人视频/特殊页面)时走 tryGetItemGuidFromOriginalLogic
        // (dispatchEvent 触发飞牛发 play/info → skipInject 拦截当前 guid), 不再静默失败
        return clonePlayBtnAndInject(async (button) => {
            const id = sendPlayEventToMain(button, config.defaultPlayer);
            if (id) return;
            const itemGuid = await tryGetItemGuidFromOriginalLogic(button);
            if (!itemGuid) { logger.error('[lc-614] 克隆按钮 DOM+拦截均未取得 guid'); return; }
            const token = getCookie('Trim-MC-token');
            if (!token) { logger.error('[lc-614] 无 token'); return; }
            const playData: PlayMovieData = { id: itemGuid, token, sourceIndex: 0, player: config.defaultPlayer };
            ipcRenderer.send('play-movie', playData);
        }, label);
    }
}

// 包装函数来处理异步调用
function handlePlayButtonInjection(): void {
    injectCustomPlayBtn().catch(error => {
        logger.error('Error in injectCustomPlayBtn:', error);
    });
}

// [lc-1282] OnDomChange 走 200ms 尾随防抖：SPA 渲染突增期每秒多批 DOM 变动，
// 每批全文档扫按钮是布局抖动热点。防抖被连续变动饿死时由轮询兜底补上。
let domInjectTimer: any = null;
function handlePlayButtonInjectionDebounced(): void {
    acceleratePoll(); // 页面仍在活跃变动 → 轮询拉回高频档并重排等待，保证漏注入最迟 ~1.2s 被兜住
    if (domInjectTimer !== null) clearTimeout(domInjectTimer);
    domInjectTimer = setTimeout(() => {
        domInjectTimer = null;
        handlePlayButtonInjection();
    }, 200);
}

// 轮询兜底：部分入口的播放按钮是异步渲染、或仅通过属性变化出现，
// 而 MutationObserver 仅监听 childList，可能错过；用低频轮询确保最终都能被拦截，
// 解决“有时不调用 mpv、直接走网页播放器”的问题。
// [lc-1282] 空转指数退避(1.2s→封顶10s)：注入完成后常态每轮都是全文档空扫，固定
// 1.2s 永久轮询是常驻开销；仅当某轮【实际注入/拦截成功】(OnDomChange 漏掉的场景)
// 或页面重新活跃(acceleratePoll)才回 1.2s 高频档。
let pollTimer: any = null;
let pollDelay = 1200;
let pollGen = 0; // 代际守卫：acceleratePoll 作废在途回调，防止双循环
const POLL_DELAY_MAX = 10000;
function pollTick(): void {
    const gen = pollGen;
    injectCustomPlayBtn()
        .then((didWork) => {
            if (gen !== pollGen) return;
            pollDelay = didWork ? 1200 : Math.min(pollDelay * 2, POLL_DELAY_MAX);
        })
        .catch((error) => {
            logger.error('Error in poll injectCustomPlayBtn:', error);
            if (gen !== pollGen) return;
            pollDelay = Math.min(pollDelay * 2, POLL_DELAY_MAX);
        })
        .then(() => {
            if (gen !== pollGen) return;
            pollTimer = setTimeout(pollTick, pollDelay);
        });
}
function startInjectionPoll(): void {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(pollTick, pollDelay);
}
// [lc-1282] 页面活跃：把轮询拉回 1.2s 高频档。已排程的长等待(最长10s)直接作废重排，
// 否则重置只影响下一档、漏注入可能仍要等满整个退避周期才被兜住。
function acceleratePoll(): void {
    pollDelay = 1200;
    if (pollTimer === null) return; // 轮询尚未启动(OnReady 前)：仅重置 delay，startInjectionPoll 自然从 1.2s 起步
    pollGen++;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, 1200);
}

// 注册hook
registerHook(HookType.OnReady, handlePlayButtonInjection);
registerHook(HookType.OnDomChange, handlePlayButtonInjectionDebounced);
registerHook(HookType.OnReady, startInjectionPoll);

export { };
