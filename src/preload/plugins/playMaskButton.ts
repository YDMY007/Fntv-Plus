// preload/plugins/playMaskButton.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import logger from '../core/logger';
import { getCookie } from '../core/utils';
import type { PlayMovieData } from '../core/types';
import { HookType } from '../core/hooks';
import { getPlayButtonConfig, createPlayModal } from './playChoice';
// [lc-603] 复用 skipInject 的 fetch/XHR 拦截 guid（个人视频等无 URL guid 场景的唯一可靠来源）
// [lc-614] setExternalPlayActive: 外部播放流程标记, 拦 play/info 防原生双播
import { getInterceptedGuid, setExternalPlayActive } from './skipInject';

// 调用播放器的公共方法（player 指定 mpv / potplayer）
async function playWithPlayer(button: HTMLElement, player: 'mpv' | 'potplayer'): Promise<void> {
    // 先尝试简化的 DOM 方法
    const domResult = sendPlayEventToMain(button, player);

    if (!domResult) {
        // [lc-613] 顺序修正: 必须先 tryGetItemGuidFromOriginalLogic(拦截【本次点击】触发的
        // play/info 请求 → 一定是当前视频), 再 getInterceptedGuid() 兜底。
        // 根因(lc-603 回归): getInterceptedGuid() 是 skipInject 缓存的【上一次播放】的
        // item_guid——第一次点新视频时读到的还是旧视频(或 null) → 发 play-movie 失败
        // → 飞牛原生兜底 → 原生发 play/info(新) 更新缓存 → 第二次点击才成功。
        // 而 tryGetItemGuidFromOriginalLogic 拦截的是【本次点击】派发的请求, 每次都是当前视频。
        logger.info('DOM method failed, trying original logic interception...');
        const itemGuid = await tryGetItemGuidFromOriginalLogic(button);

        if (itemGuid) {
            logger.info('Successfully obtained item_guid from original logic:', itemGuid);
            const token = getCookie('Trim-MC-token');
            if (token) {
                const playData: PlayMovieData = { id: itemGuid, token: token, sourceIndex: 0, player };
                ipcRenderer.send('play-movie', playData);
                return;
            }
            logger.error('No token found');
            return;
        }

        // [lc-630] 删除 getInterceptedGuid() 旧缓存兜底!
        // 它是 skipInject 缓存的【上一次播放】的 guid——直播/个人视频 DOM 提取失败 +
        // tryGetItemGuid 超时(null)后, 用它发 play-movie 会【打开上次播放的视频】,
        // 用户反馈"点直播显示播放失败后又打开上次的MPV视频"正是此 bug。
        // 宁可不播也不播错: 提取不到当前 guid 就直接失败提示。
        logger.error('All methods failed to get item_guid');
    } else {
        logger.info('Successfully used DOM method to get item_guid');
    }
}

// 尝试通过触发原逻辑获取 item_guid
// [lc-614] 重写: 旧实现自己包装 window.fetch/XHR 想拦 play/info 的 body —— 但飞牛代码
// 缓存了 fetch 引用(不走 window.fetch 动态查找), 旧拦截器永远拦不到 → 恒超时失败。
// 正确做法: 设置 skipInject 的外部播放标记(它会拦 play/info 并返回假响应防原生双播),
// 然后 dispatchEvent 触发原按钮点击 → 飞牛发 play/info → skipInject 拦到并更新
// interceptedGuid → 轮询 getInterceptedGuid() 变化(记录点击前值, 等它变成新值)。
// [lc-614] export: playButton.ts 的克隆播放按钮失败兜底也复用此函数。
// [lc-629] 弹窗抑制: dispatchEvent 会让飞牛跳转播放页→play/info 被拦→弹「播放失败/
// 未知错误」Semi 弹窗(用户反馈调用成功仍弹)。本函数触发后启动 MutationObserver,
// 检测到标题为「播放失败」/「未知错误」的 Semi 弹窗自动点「确定」关闭(兜底)。
let _playErrorModalObs: MutationObserver | null = null;
function suppressFnosPlayErrorModal(): void {
  if (_playErrorModalObs) return;
  const tryClose = (): void => {
    try {
      const modal = Array.from(document.querySelectorAll('.semi-modal, [role="dialog"]'))
        .find((el) => {
          const t = (el.textContent || '').trim();
          return (t.includes('播放失败') || t.includes('未知错误')) && el.querySelector('.semi-button-primary');
        }) as HTMLElement | null;
      if (modal) {
        const okBtn = modal.querySelector('.semi-button-primary') as HTMLElement | null;
        if (okBtn) { (okBtn as HTMLElement).click(); }
        logger.info('[lc-629] 已自动关闭飞牛「播放失败」弹窗');
      }
    } catch { /* ignore */ }
  };
  _playErrorModalObs = new MutationObserver(() => { tryClose(); });
  _playErrorModalObs.observe(document.body, { childList: true, subtree: true });
  tryClose();
  // 5s 后停止监听(避免长期驻留)
  setTimeout(() => {
    try { if (_playErrorModalObs) { _playErrorModalObs.disconnect(); _playErrorModalObs = null; } } catch { /* ignore */ }
  }, 5000);
}

export function tryGetItemGuidFromOriginalLogic(button: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const before = getInterceptedGuid();
            // [lc-614] 开启 skipInject 外部播放标记: 拦 play/info 返回假响应(阻止原生播放器启动)
            setExternalPlayActive(true);
            let done = false;
            const cleanup = (): void => {
                if (done) return;
                done = true;
                setExternalPlayActive(false);
                button.removeAttribute('data-allow-original-play');
            };
            const timeout = setTimeout(() => { cleanup(); resolve(null); }, 2500);

            // 触发原有点击事件(带 data-allow-original-play 放行, 让飞牛 handler 执行并发 play/info)
            button.setAttribute('data-allow-original-play', 'true');
            // [lc-629] 提前启用弹窗抑制: dispatchEvent 可能让飞牛弹「播放失败」, 自动关闭
            suppressFnosPlayErrorModal();
            setTimeout(() => {
                try {
                    const clickEvent = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });
                    button.dispatchEvent(clickEvent);
                } catch { /* ignore */ }
                // 轮询 skipInject 拦截结果: 直到 guid 变化(变成当前视频)或超时
                const pollStart = Date.now();
                const poll = (): void => {
                    if (done) return;
                    const cur = getInterceptedGuid();
                    if (cur && cur !== before) {
                        cleanup();
                        logger.info('[lc-614] 从 skipInject 拦截到当前 item_guid:', cur);
                        resolve(cur);
                        return;
                    }
                    if (Date.now() - pollStart > 2500) {
                        cleanup();
                        resolve(null);
                        return;
                    }
                    setTimeout(poll, 150);
                };
                setTimeout(poll, 200);
            }, 50);
        } catch (error) {
            setExternalPlayActive(false);
            logger.error('Error in tryGetItemGuidFromOriginalLogic:', error);
            resolve(null);
        }
    });
}

// [lc-602] 支持 /v/video/（未刮削视频详情页）：之前只认 movie|tv → 视频播放按钮拿不到 guid
// [lc-630] 支持 /v/live/（电视直播）：直播频道 ID 是 64 位 hex（如 /v/live/e7c0e9b1...15c），
//   而普通 item guid 是 32 位。直播 DOM 提取失败 → dispatchEvent → 飞牛弹「播放失败」+
//   旧缓存兜底播上次视频。故 GUID_RE 加 live 路径 + 量词 {32,64} 兼容两种长度。
// [lc-661] 支持 /v/other/（个人视频详情页，归在「其他」分类下）：之前漏掉 → 个人视频播放按钮
//   克隆出来后点击取不到 guid 无法播放。实测个人视频详情页路由为 /v/other/<guid>。
export const GUID_RE = /\/v\/(?:movie|tv|video|live|other)\/(?:season\/|episode\/)?([a-f0-9]{32,64})/i;

// [lc-604] 从「继续观看」卡片提取 item guid：卡片是 div(无 button/a 链接),
// 但海报 URL 含 guid —— /v/api/v1/sys/img/xx/yy/poster-{32hex}.webp
function getGuidFromContinueCard(card: Element): string | null {
    try {
        // 1) 海报 img src / currentSrc 里的 poster-{32hex}
        const imgs = card.querySelectorAll('img');
        for (const im of Array.from(imgs) as HTMLImageElement[]) {
            const m = (im.currentSrc || im.src || im.getAttribute('src') || '').match(/poster-([a-f0-9]{32})/i);
            if (m && m[1]) return m[1];
        }
        // 2) 任意 style background-image 含 {32hex}
        const all = card.querySelectorAll('[style*="background"]');
        for (const el of Array.from(all)) {
            const m = (el.getAttribute('style') || '').match(/([a-f0-9]{32})/i);
            if (m && m[1]) return m[1];
        }
        // 3) 卡片自身 data 属性(排除 fv_ 文件夹 id)
        const g = card.getAttribute('data-guid') || card.getAttribute('data-item-id') || card.getAttribute('data-id') || '';
        const gm = g.match(/[a-f0-9]{32}/i);
        if (gm && gm[0] && !/^fv_/.test(gm[0])) return gm[0];
    } catch { /* ignore */ }
    return null;
}

export function getItemGuidFromDOM(button: HTMLElement): string | null {
    try {
        // [lc-604] 「继续观看」卡片(div): 海报 URL poster-{32hex} 提取
        const continueCard = button.classList && button.classList.contains('continue-card-root')
            ? button
            : button.closest('.continue-card-root');
        if (continueCard) {
            const g = getGuidFromContinueCard(continueCard);
            if (g) { logger.info('Found guid in continue-card poster:', g); return g; }
        }
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

        // [lc-628] 通用海报 URL 提取: 任意卡片内 img src 含 poster-{32hex} 即为 item guid。
        // 覆盖「分类-其他」文件夹列表页的个人视频卡片(链接指向 /v/folder/ 无 guid,
        // 但海报 URL 是 poster-{guid}.webp, 与 continue-card 同构)——避免走
        // tryGetItemGuidFromOriginalLogic 的 dispatchEvent(触发飞牛前端弹"播放失败")。
        // [lc-630] 直播频道海报是 resource_{64hex}(如 resource_c89b5f23...), 一并支持。
        // ⚠️ 注意: 不匹配 upload_poster_{32hex}(那是图片资源 ID, 不等于 item guid, 误提取会播错)。
        try {
            const imgs = scope.querySelectorAll('img');
            for (const im of Array.from(imgs) as HTMLImageElement[]) {
                const src = im.currentSrc || im.src || im.getAttribute('src') || '';
                const m = src.match(/(?:poster|resource)[-_]([a-f0-9]{32,64})/i);
                if (m && m[1]) { logger.info('Found guid in card poster:', m[1].substring(0, 20)); return m[1]; }
            }
        } catch { /* ignore */ }

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


// 按 guid 直接路由到外部播放器(主进程按"已在播→复用窗口 switchTo / 未播→新开"处理)
async function playEpisodeByGuid(guid: string): Promise<void> {
    const token = getCookie('Trim-MC-token');
    if (!guid || !token) {
        logger.error('playEpisodeByGuid: 缺少 guid 或 token');
        return;
    }
    const config = await getPlayButtonConfig();
    const playData: PlayMovieData = { id: guid, token, sourceIndex: 0, player: config.defaultPlayer };
    logger.info('[选集/下一集] 路由到外部播放器:', guid, config.defaultPlayer);
    ipcRenderer.send('play-movie', playData);
}

// 从当前详情页的集数链接里找"下一集"的 guid(按文档顺序排列, 取当前集之后第一个)
function findNextEpisodeGuid(): string | null {
    try {
        const cur = (location.pathname || '').match(GUID_RE);
        const curGuid = cur && cur[1];
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        const eps: string[] = [];
        for (const a of anchors) {
            if (/season\//i.test(a.href)) continue;
            const m = a.href.match(GUID_RE);
            if (m && m[1] && !eps.includes(m[1])) eps.push(m[1]);
        }
        if (eps.length === 0) return null;
        if (!curGuid) return eps[0];
        const idx = eps.indexOf(curGuid);
        if (idx >= 0 && idx + 1 < eps.length) return eps[idx + 1];
        return null;
    } catch {
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

    // [lc-604] 「继续观看」卡片: 整卡是 <div class="continue-card-root">(非 button/a),
    // 点击卡片任意处 → 直接拦截走外部播放器。海报 URL 含 item guid(poster-{32hex}.webp)。
    const continueCard = target.closest('.continue-card-root') as HTMLElement | null;
    if (continueCard) {
        // [lc-618] 排除卡片内的小操作按钮(标记看过/收藏/省略号更多):
        // 飞牛用 div 模拟按钮(非 button/role=button)——实测 DOM:
        //   <div title="标记为已观看"> / <div title="收藏"> / <div aria-haspopup tabindex data-popupid>
        // 故按 title/aria-haspopup/tabindex/data-popupid 等交互特征识别并放行原生处理。
        // 注意: 海报播放链接 <a href="/v/folder/"> 无这些特征, 不会误排除, 点它仍走播放。
        const opBtn = target.closest('[title], [aria-haspopup], [aria-expanded], [data-popupid], [tabindex], [aria-label]') as HTMLElement | null;
        if (opBtn && opBtn !== continueCard) {
            logger.info('[lc-618] 继续观看卡片内操作按钮点击, 放行原生:', (opBtn.getAttribute('title') || opBtn.getAttribute('aria-label') || opBtn.tagName).substring(0, 30));
            return null;
        }
        const hasGuid = !!getGuidFromContinueCard(continueCard);
        if (hasGuid) {
            logger.info('[lc-604] 继续观看卡片点击拦截(海报 guid 提取成功)');
            return continueCard;
        }
        // 卡片内链接指向 /v/folder/...(文件夹), 无 item guid → 放行原生跳转
        logger.info('[lc-604] 继续观看卡片无 guid, 放行原生');
        return null;
    }

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

// [lc-1076] 统一识别「播放」入口(供 press 拦截与 click 行动共用):
//   在 pointerdown/mousedown/pointerup/mouseup/click 的捕获阶段用同一判定, 确保无论 fnOS 在哪一类
//   事件上发起路由转场(点击播放→飞牛跳视频页→该页未套用深色主题前先以白底挂载 = 整页白闪),
//   都能被我们挡在前面。preload 早于 fnOS 脚本注册 → 我们的 window 捕获监听先执行。
type PlayHit =
    | { kind: 'mask'; el: HTMLElement }
    | { kind: 'card'; el: HTMLElement }
    | { kind: 'ep'; el: HTMLElement; guid: string }
    | { kind: 'next'; el: HTMLElement; guid: string }
    | null;

function detectPlayTarget(target: HTMLElement): PlayHit {
    if (!target || typeof target.closest !== 'function') return null;
    // 放行: 原生播放回退的合成点击 / 自家 UI(含弹窗内部按钮)
    if (target.closest('[data-allow-original-play="true"]')) return null;
    if (target.closest('[data-fnos-ui]')) return null;

    // 1) 遮罩播放按钮 .play-mask__btn--play
    const mask = target.closest('.play-mask__btn--play') as HTMLElement | null;
    if (mask) return { kind: 'mask', el: mask };

    // 2) 首页卡片封面播放图标(非 .play-mask__btn--play 的其它播放入口)
    const cardPlay = findHomeCardPlay(target);
    if (cardPlay) return { kind: 'card', el: cardPlay };

    // 3)/4) 详情页选集链接 / 下一集按钮
    const detailPath = (location.pathname || '').replace(/\/+$/, '');
    if (/^\/v\/(tv|movie)\//.test(detailPath) && !/\/season\//.test(detailPath)) {
        const epAnchor = target.closest('a[href]') as HTMLAnchorElement | null;
        if (epAnchor && epAnchor.href && !/season\//i.test(epAnchor.href)) {
            const em = epAnchor.href.match(GUID_RE);
            if (em && em[1]) {
                // 已交给 playButton.ts 处理的播放按钮不重复拦截
                if (target.closest('[data-mpv-btn],[data-custom-play],[data-mask-intercepted],[data-mpv-intercepted]')) return null;
                const curGuid = (detailPath.match(GUID_RE) || [])[1];
                if (em[1] !== curGuid) return { kind: 'ep', el: epAnchor as HTMLElement, guid: em[1] };
            }
        }
        const clickable = target.closest('button, [role="button"], a') as HTMLElement | null;
        if (clickable) {
            const label = (clickable.getAttribute('aria-label') || clickable.textContent || '').trim();
            if (/下一集|下一話|next\s*episode/i.test(label)) {
                const nextGuid = findNextEpisodeGuid();
                if (nextGuid) return { kind: 'next', el: clickable, guid: nextGuid };
            }
        }
    }
    return null;
}

function installPlayClickInterceptor(): void {
    if (_playClickInstalled) return;
    _playClickInstalled = true;

    // [lc-1076] press 阶段拦截: fnOS 常在 pointerdown/mousedown/pointerup 就发起路由转场(跳视频页),
    //   该页未套用深色主题前会先以白底挂载 → 用户看到「点播放→整页白闪」, 而我们的 click 拦截
    //   此时已来不及(preventDefault 拦不住已经开始的跳转)。preload 早于 fnOS 脚本注册 → 我们的
    //   捕获监听在同层级(window)中先执行, stopImmediatePropagation 即可阻断 fnOS 的 press 处理。
    //   ⚠ 只用 stopImmediatePropagation(不 preventDefault): pointerdown/mousedown 上 preventDefault 会
    //     抑制后续 click 合成 → 选择弹窗不出现; 我们只需挡掉 fnOS 的 press 转场, click 仍照常派发给下方 onClick。
    const blockPress = (e: Event): void => {
        const target = e.target as HTMLElement | null;
        if (!target || typeof target.closest !== 'function') return;
        if (detectPlayTarget(target)) {
            e.stopImmediatePropagation();
        }
    };
    window.addEventListener('pointerdown', blockPress, true);
    window.addEventListener('mousedown', blockPress, true);
    window.addEventListener('pointerup', blockPress, true);
    window.addEventListener('mouseup', blockPress, true);

    // click 阶段: 真正拦截 + 执行(弹窗/外部播放)。preload 注册优先 → 先于 fnOS 的 click 委托。
    window.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (!target || typeof (target as any).closest !== 'function') return;

        // 放行由「原生播放」按钮 / guid 兜底回退 触发的合成点击(带 data-allow-original-play)
        if (target.closest('[data-allow-original-play="true"]')) return;

        const hit = detectPlayTarget(target);
        if (!hit) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (hit.kind === 'mask') {
            hit.el.setAttribute('data-mask-intercepted', 'true'); // 兼容 playButton.ts 互检
            handleMaskPlay(hit.el);
        } else if (hit.kind === 'card') {
            hit.el.setAttribute('data-home-intercepted', 'true');
            (async () => {
                const config = await getPlayButtonConfig();
                logger.info('Home card play icon intercepted, playing with', config.defaultPlayer);
                await playWithPlayer(hit.el, config.defaultPlayer);
            })();
        } else if (hit.kind === 'ep' || hit.kind === 'next') {
            (async () => { await playEpisodeByGuid(hit.guid); })();
        }
    }, true);
}

registerHook(HookType.OnReady, installPlayClickInterceptor);
// 注: 不再逐个按钮挂捕获监听(会晚于 fnOS 的 document 级捕获, 拦不住跳转),
//     改为 window 级单次捕获, 覆盖全页含异步/滚动加载的卡片。
//     playButton.ts 仍独立处理详情页 .semi-button-primary 主播放按钮, 互不冲突。

export {};
