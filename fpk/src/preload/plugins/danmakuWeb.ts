// preload/plugins/danmakuWeb.ts
//
// [原生网页播放器弹幕] 飞牛「原声播放器」(fnOS 网页自身 <video>) 的 B站弹幕支持。
//
// 设计要点（用户明确要求）：
//   1) 控制栏只有一个「弹幕」按钮，交互与飞牛原生按钮一致：**鼠标移上去就弹出弹窗**
//      （[lc-1110] 之前是点击弹紧凑列表、列表里两项再唤起右侧抽屉；用户明确不要侧边栏形态）。
//      弹窗里直接装：开关（默认开，localStorage 记忆，颜色区分开/关）、弹幕样式旋钮
//      （粗体/字号/描边/阴影/滚动时长/透明度/显示范围，对齐 MPV，localStorage 独立持久化）、
//      以及就地切换的「来源详情」视图（从哪个区/哪个标题匹配、相似度、bvid/cid、条数）
//      —— 与 MPV 的弹幕来源提示一致，而非罗列全部弹幕。
//   2) 弹幕渲染采用 B站网页播放器同款方案：<canvas> 逐帧重绘引擎（非 DOM 元素），
//      挂在 body 上 position:fixed，每帧按 video.getBoundingClientRect() 对齐播放画面，
//      彻底规避「overlay 没盖对位置 / video 元素选错」导致的时灵时不灵。
//   3) 默认开；开关状态用 localStorage 记忆。
//   4) 电影(ep=0)：主进程 search_cid 自动退化为「仅按番名搜、取弹幕最多的集」，与 MPV 一致。
//
// 数据通道：ipcRenderer.invoke('danmaku:prepare', {guid}) → 主进程解析标题/集数并抓 B站弹幕，
// 返回结构化弹幕条目 + 来源 meta（避免 https 页 fetch http 本地服务的 mixed-content/CORS 问题）。

import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import logger from '../core/logger';
import { t } from '../core/i18n';
import { installMobileFlag } from './embyWall/detail/beautifyStyle';

const log = logger;

/** 已拉取过的 guid（切集去重，避免重复请求 B站） */
const loadedGuids = new Set<string>();

/** 播放页 URL 正则（电影 / 剧集 / 视频）。
 * [lc-662→回退] 不含 other：个人视频(/v/other/)不是 B站内容，不应触发弹幕匹配。
 *   之前误加 other 会让个人视频详情页发起无谓的 B站弹幕搜索。 */
const GUID_RE = /\/v\/(?:movie|tv|video)(?:\/(?:season|episode))?\/([a-f0-9]{32})/i;

const LS_KEY = 'fntv_danmaku_enabled';
const LS_STYLE_KEY = 'fntv_danmaku_style';
const LS_BILI_KEY = 'fntv_danmaku_bili_search';

// ═══ [lc-544] 播放页顶部标题栏美化 ═══
// 飞牛原生播放页顶部的页面级 header（返回箭头+标题+窗口控件）在视频上方很突兀。
// 注入半透明毛玻璃 + 鼠标不动自动隐藏，跟现代播放器控制栏风格一致。
const PLAYER_HEADER_STYLE_ID = 'fntv-player-header-style';
let _headerStyleInjected = false;
let _headerHideTimer: ReturnType<typeof setTimeout> | null = null;
const HEADER_HIDE_DELAY = 2500; // 鼠标不动 2.5s 后自动隐藏

// ─── [lc-1290→lc-1311] 窄屏底栏结构裁剪 ───
// 手机竖屏下 xg-right-grid 里有 8 个原生控件（播放/时间在左栏，倍速/原画/选集/音量/设置/
// 全屏在右栏）外加本插件注入的「弹幕」与 skipMarker 的「标记」，共 10 个。CSS 侧再怎么压缩，
// 文字按钮本身（倍速/原画/选集各 2~3 字 + 40px 触控热区）在 390px 里也放不下 —— 必须**减少
// 控件数量**。业界做法（Netflix / Disney+ 移动端同款）是把次要项折进「更多」弹层。
// 这里的取舍：保留 播放/时间/选集/全屏 + 弹幕（自建入口，弹幕是本插件卖点），
// 隐藏 倍速/原画/音量/设置/标记（倍速与原画在宽屏恢复可见；音量/设置在窄屏由顶部栏的
// 设置入口覆盖；标记入口与弹幕面板功能重叠，弹幕面板内有标记入口）。
// [lc-1311] 隐藏机制改为 data-fntv-trimmed 属性 + 配套 !important 规则（见样式表）：
//   上一版写行内 display:none，被本表 `.plugin-placeholder{display:flex!important}`
//   覆盖（样式表 !important > 行内非 important）→ 裁剪形同虚设，右栏 11 项 274px
//   撑爆 226px 容器换行（用户报障「挤在一起还显示不完全」的根因）。真机实测属性方案
//   单行 9 项 217px=217px 闭合。
// 判定一律按**文本内容**而非位置/序号 —— 控件数量随剧集详情（有无原画/倍速）而变，
// nth-child 会在不同剧集上错位裁掉要留的按钮。
const NARROW_TRIM_HIDE = ['倍速', '原画', '音量', '设置', '标记'];
let _narrowTrimBound = false;

/** 窄屏时把次要文字按钮折掉；宽屏或离开播放页立即恢复（幂等，可反复调用）。 */
function ensureNarrowControlTrim(): void {
    const apply = (): void => {
        const narrow = document.documentElement.classList.contains('fnos-touch-narrow');
        const bar = findControlsBar();
        if (!bar) return;
        const items = Array.from(
            bar.querySelectorAll<HTMLElement>('.plugin-placeholder, .control-item, xg-icon')
        );
        for (const it of items) {
            // xg-icon（音量/设置/全屏）无文字，靠位置判断：只裁右栏里的图标，全屏键必须留
            const txt = (it.textContent || '').trim();
            let hide = false;
            if (txt) {
                hide = NARROW_TRIM_HIDE.some((k) => txt === k);
            } else {
                hide = it.tagName.toLowerCase() === 'xg-icon' && !it.classList.contains('xgplayer-fullscreen');
            }
            const want = narrow && hide ? '1' : null;
            const has = it.hasAttribute('data-fntv-trimmed');
            if (want && !has) it.setAttribute('data-fntv-trimmed', '1');
            else if (!want && has) it.removeAttribute('data-fntv-trimmed');
        }
    };
    if (_narrowTrimBound) { apply(); return; }
    _narrowTrimBound = true;
    // 视口跨越 640px 断点 → html.fnos-touch-narrow 由 mobileStyle 翻转，这里跟着重算
    const mq = (() => { try { return window.matchMedia('(min-width: 641px)'); } catch { return null; } })();
    const onMq = (): void => apply();
    if (mq) {
        if (mq.addEventListener) mq.addEventListener('change', onMq);
        else (mq as any).addListener(onMq);
    }
    // 控制栏是懒渲染的，进播放页/切集后结构会重建，用 MutationObserver 持续校正
    const mo = new MutationObserver(() => { if (isPlayerPage()) apply(); });
    const start = (): void => {
        const root = document.querySelector('.xgplayer') || document.body;
        if (root) mo.observe(root, { childList: true, subtree: true });
    };
    start();
    setTimeout(start, 1000);
    setTimeout(start, 3000);
    log.info('[danmakuWeb] 窄屏底栏控件裁剪已启用');
}

/** 注入播放页顶部标题栏美化 CSS（仅执行一次） */
function injectPlayerHeaderStyle(): void {
    if (_headerStyleInjected) return;
    const css = `
/* ── 播放页顶部标题栏：毛玻璃 + 自动隐藏 ──
   目标：fnOS 页面级 header（含返回箭头+标题文字），非 xgplayer 自身控件 */
html:has(video) header,
html:has(video) nav,
html:has(video) [role="banner"],
html:has(video) [class*="header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="Header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="navbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="topbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html:has(video) [class*="top-bar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]) {
    background: rgba(0, 0, 0, .45) !important;
    backdrop-filter: blur(24px) saturate(150%) !important;
    -webkit-backdrop-filter: blur(24px) saturate(150%) !important;
    border-bottom: 1px solid rgba(255, 255, 255, .08) !important;
    transition: opacity .35s ease, transform .35s ease !important;
}
/* 自动隐藏状态：鼠标不动一段时间后淡出上滑 */
html.fntv-ph-hidden header,
html.fntv-ph-hidden nav,
html.fntv-ph-hidden [role="banner"],
html.fntv-ph-hidden [class*="header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="Header"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="navbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="topbar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]),
html.fntv-ph-hidden [class*="top-bar"]:not([class*="xgplayer"]):not([class*="control"]):not([class*="play"]) {
    opacity: 0 !important;
    pointer-events: none !important;
    transform: translateY(-8px) !important;
}
/* ── 隐藏播放器起播/缓冲时的加载圈（用户要求删掉的白圈）──
   ① xgplayer 自带缓冲转圈；容器状态类 xgplayer-isloading 不动（它还联动 start 按钮显隐），
      原生 .xgplayer-isloading .xgplayer-loading{display:block} 特异度更高，必须 !important 压过；
   ② 飞牛播放器流加载时的 Semi「加载中…」蒙层（spinner+文字），限定在播放器根内，
      不影响其它页面正常使用的 Semi Spin；蒙层容器整体藏，圈和文字一起消失。 */
.xgplayer-loading {
    display: none !important;
}
/* ③ xgplayer 起播遮罩 spinner（白色辐条圈 #ffffffb3，实测就是用户指的白圈本体），遮罩只有它，整个藏 */
.xgplayer-enter {
    display: none !important;
}
.trim-mc__video-player--root .semi-spin {
    display: none !important;
}
.trim-mc__video-player--root div:has(> .semi-spin) {
    display: none !important;
}

/* ── [v1.4.1] 手机网页：底部控制栏触屏适配 ──
   真实底栏 8 控件（播放/时间/倍速/原画/选集/弹幕/音量/设置/全屏）在 390px 竖屏
   实测仅余 4px 横向余量，且文字按钮点击热区只有 22px 高（Apple HIG 最低 44px）。
   门控 html.fnos-touch-narrow（beautifyStyle 注入侧安装的触屏窄屏标记，设备硬事实
   判定，无 pointer 媒体查询的中途翻转问题；播放页可能未注入美化样式——v1.4.1 起把
   installMobileFlag 挂到本样式注入链，两处幂等共用）。
   措施：触控热区 padding 撑到 ≥40px 高 / ≥32px 宽（视觉文字不动）；字号 14→13px、
   控件间距 14→10px、时间行 12px 弱化，给热区扩张腾出横向空间；进度条触控带加高
   （点拖进度是手机最高频操作，原生 14px 命中带太窄）。 */
html.fnos-touch-narrow xg-controls .control-item,
html.fnos-touch-narrow xg-controls span.cursor-pointer {
    font-size: 13px !important;
    padding: 9px 2px !important;   /* 纵向 9+9 撑热区；横向 2px——右栏 6 控件 390px 里横向预算极紧 */
    white-space: nowrap !important;   /* 热区 padding 挤占内容宽时「弹幕」两字会竖排折行 */
}
html.fnos-touch-narrow xg-controls .plugin-placeholder:not([data-fntv-trimmed]) {
    display: flex !important;
    align-items: center !important;
    min-height: 40px !important;
}
/* [lc-1311] 被裁剪项隐藏：必须走属性选择器 + !important。上一版 JS 写行内
   display:none，被本表同文件的 flex!important 覆盖（样式表 !important > 行内非
   important）→ 裁剪形同虚设：右栏 11 项共 274px 撑爆 226px 容器，flex-wrap 把
   倍速/弹幕/标记 换行掉到第二行叠在其它控件上（用户报「底部的控制按键全挤
   在一起还显示不完全」）。真机实测：属性方案后右栏单行 9 项 217px=217px 闭合。 */
html.fnos-touch-narrow xg-controls [data-fntv-trimmed] {
    display: none !important;
}
html.fnos-touch-narrow xg-right-grid { gap: 2px !important; }
html.fnos-touch-narrow xg-left-grid { gap: 4px !important; }
/* 时间行弱化：数字串是底栏最宽的静态元素，缩一号并降透明度（信息保留） */
html.fnos-touch-narrow xg-left-grid .control-item:not(:first-child) {
    font-size: 11px !important;
    opacity: .75;
    padding: 9px 2px !important;
}
/* 进度条触控带加高（原生命中带 ~14px，拇指操作难点中） */
html.fnos-touch-narrow .xg-progress {
    height: 26px !important;
    bottom: 48px !important;
    display: flex !important;
    align-items: flex-end !important;
}

/* ── [lc-1312] 两栏底栏：进度条带（上层）+ 按钮带（下层加高）──
   用户报「还是好挤，能不能两栏显示」。真机实测（440×956，61 号包）发现 xgplayer
   原生就有两带雏形：进度条在 xg-center-grid（y=872 h=30）、按钮行在 xg-inner-controls
   （y=892 h=64），但按钮带 64px 装不下 40px 触控热区 + 时间/进度挤在一起。
   两栏定稿（真机注入验证：进度条视觉底 881 / 按钮带顶 884，间隙 +3px；右栏 7 项单行；
   左右栏 224+184=408 < 420 容器）：
   - inner-controls 加高到 76px、按钮行沉底（flex-end + padding-bottom 6px）
   - 左右栏各 60px 高、垂直居中、禁止换行、图标 20px、横向 padding 归零
   - 进度条触控带 26px 高，拇指点拖的命中区不受两栏影响 */
html.fnos-touch-narrow xg-inner-controls{
    height: 76px !important;
    align-items: flex-end !important;
    padding-bottom: 6px !important;
    box-sizing: border-box !important;
}
html.fnos-touch-narrow xg-left-grid,
html.fnos-touch-narrow xg-right-grid{
    height: 60px !important;
    align-items: center !important;
    flex-wrap: nowrap !important;
    gap: 0 !important;
    min-width: 0 !important;
}
html.fnos-touch-narrow xg-right-grid .plugin-placeholder{ min-width:0 !important; padding-left:0 !important; padding-right:0 !important; }
html.fnos-touch-narrow xg-right-grid .plugin-placeholder xg-icon{ width:20px !important; }
html.fnos-touch-narrow xg-controls .xgplayer-time{ font-size:11px !important; }

/* ── [lc-1290] 手机竖屏底栏「挤在一起 + 显示不全」──
   用户报障原文：「底部的控制按键全挤在一起还显示不完全」。
   上一段（v1.4.1）只做了「热区 padding 撑高 + 字号缩小」——那是**纵向**的（把热区垫高到
   40px 高），对**横向**的挤压毫无作用，10 个控件（8 原生 + 弹幕/标记两个自建）在 390px
   里必然超出，而 xgplayer 的 xg-inner-controls 是 flex 且不换行，超出部分直接被
   .xgplayer 的 overflow:hidden 吃掉 —— 表现就是「挤在一起 + 最右侧按钮看不全」。
   xgplayer 真实 DOM（实测自飞牛 /v/assets/74c95604043427f0bee1d0e16bfa53af-DZn1lJtt.js）：
     <xg-controls class="xgplayer-controls">
       <xg-inner-controls class="xg-inner-controls xg-pos">
         <xg-left-grid/> <xg-center-grid/> <xg-right-grid/>
   三个 grid 是并列 flex 子项，默认 min-width:auto（=内容宽，不会被压缩）。
   四步收口：
     ① 给三个 grid 加 min-width:0 —— 允许它们被压缩，这是「不溢出」的前提；
     ② 图标类控件（音量/设置/全屏，无文字）此前**一条规则都没有**，文字按钮缩了它没缩，
        右侧被它们顶出屏。压到 26px 见方 + 收紧图标内边距；
     ③ 文字按钮（倍速/原画/选集/弹幕/标记）在 ≤430px 屏上按序隐藏到「更多」之外的两项：
        保留 选集 + 弹幕/标记（我们自己的入口）与播放/时间/全屏，隐藏 倍速/原画
        —— 用 :nth-child 不可靠（控件数随剧集变），改用「右栏内除前两项外隐藏」的
        结构化裁剪：先隐藏右栏所有 .plugin-placeholder，再把 xg-icon（图标按钮）与
        最后一个 plugin-placeholder 放回来。
     —— 实现见下方 §C1ff 的 JS 段，CSS 只负责尺寸，不做结构裁剪。 */

/* ① grid 允许收缩：min-width:auto 会让 flex 子项拒绝压缩，是溢出的直接原因 */
html.fnos-touch-narrow xg-inner-controls,
html.fnos-touch-narrow xg-left-grid,
html.fnos-touch-narrow xg-center-grid,
html.fnos-touch-narrow xg-right-grid{ min-width:0 !important; }

/* ② 图标类控件此前完全没参与 v1.4.1 的收缩（文字缩了、图标没缩）→ 右侧被顶出屏 */
html.fnos-touch-narrow xg-right-grid .control-item,
html.fnos-touch-narrow xg-right-grid xg-icon,
html.fnos-touch-narrow xg-left-grid .control-item{
    padding:8px 1px !important;
    min-width:26px !important;
}
html.fnos-touch-narrow xg-right-grid .xgplayer-icon{ width:20px !important; height:20px !important; }

/* ③ 右栏整体不换行 + 允许内部收缩；超窄屏（≤360px）进一步压间距 */
html.fnos-touch-narrow xg-inner-controls{ flex-wrap:nowrap !important; }
/* [lc-1311] 右栏自身也禁止换行（真机实测 xg-right-grid 默认 flex-wrap:wrap，
   11 项 274px > 226px 时倍速/弹幕/标记被换到第二行叠在别的控件上），并把图标
   类控件压到 20px——文字按钮 26px 与图标 20px 后真机 217px=217px 单行闭合。 */
html.fnos-touch-narrow xg-right-grid{ flex-wrap:nowrap !important; gap:0 !important; min-width:0 !important; }
html.fnos-touch-narrow xg-right-grid .plugin-placeholder{ min-width:0 !important; padding-left:0 !important; padding-right:0 !important; }
html.fnos-touch-narrow xg-right-grid .plugin-placeholder xg-icon{ width:20px !important; }
html.fnos-touch-narrow xg-controls .xgplayer-time{ font-size:11px !important; }
@media (max-width:360px){
    html.fnos-touch-narrow xg-controls .control-item{ font-size:12px !important; }
}
`;
    const el = document.createElement('style');
    el.id = PLAYER_HEADER_STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    _headerStyleInjected = true;
    installMobileFlag();   // [v1.4.1] 播放页可能先于详情页注入：底栏触屏段依赖触屏窄屏标记
    ensureNarrowControlTrim(); // [lc-1290] 窄屏底栏结构裁剪（把次要文字按钮折掉）
    log.info('[danmakuWeb] 播放页顶部标题栏美化 CSS 已注入');
}

/** 重置隐藏计时器：鼠标活动时显示标题栏，静止后自动隐藏 */
function resetHeaderHideTimer(): void {
    if (!isPlayerPage()) return;
    document.documentElement.classList.remove('fntv-ph-hidden');
    if (_headerHideTimer) clearTimeout(_headerHideTimer);
    _headerHideTimer = setTimeout(() => {
        if (isPlayerPage()) document.documentElement.classList.add('fntv-ph-hidden');
    }, HEADER_HIDE_DELAY);
}

/** 绑定播放页标题栏自动隐藏的鼠标事件（仅绑定一次） */
let _headerAutoHideBound = false;
function bindHeaderAutoHide(): void {
    if (_headerAutoHideBound || !isPlayerPage()) return;
    _headerAutoHideBound = true;
    document.addEventListener('mousemove', resetHeaderHideTimer, { passive: true });
    document.addEventListener('touchstart', resetHeaderHideTimer, { passive: true });
    // 初始显示，延迟开始倒计时
    setTimeout(resetHeaderHideTimer, 600);
    log.info('[danmakuWeb] 播放页标题栏自动隐藏已启用 (' + HEADER_HIDE_DELAY + 'ms)');
}

/** 播放器全屏时给 html 打 fntv-video-fullscreen 标记, 供去掉窗口圆角/clip-path, 使视频4角变直角。
 *  [lc-552] 重构检测策略: 不再依赖 ResizeObserver+尺寸阈值(时序不稳定→圆角时灵时不灵)。
 *  [lc-1290] **原实现的判据是错的，恒为 false（死代码）**：它查 `.xgplayer.xgplayer-fullscreen`，
 *  但 xgplayer 从不在播放器根节点上挂 `xgplayer-fullscreen` —— 实测飞牛 /v/assets/
 *  74c95604043427f0bee1d0e16bfa53af-DZn1lJtt.js 里 `xgplayer-fullscreen` 只出现 4 处，
 *  全部是**全屏按钮自身**的类（`<xg-icon class="xgplayer-fullscreen">` 及其选择器
 *  `.xgplayer-fullscreen` 的点击绑定），不是状态类。播放器根节点上的状态类是
 *  `xgplayer-is-fullscreen`(原生全屏) / `xgplayer-is-cssfullscreen`(CSS 伪全屏)。
 *  改为同时认这三个，这是弹幕 canvas 全屏搬家(fullscreenHost)依赖的同一个信号。 */
let _fsFixBound = false;
function applyVideoFullscreenClass(): void {
    // ① 浏览器原生全屏（最高优先级）
    const nativeFs = !!document.fullscreenElement;
    // ② xgplayer 播放器根节点上的全屏状态类（原生/CSS 伪全屏，xgplayer 自身管理）
    const pseudoFs = !!document.querySelector(
        '.xgplayer.xgplayer-is-fullscreen, .xgplayer.xgplayer-is-cssfullscreen, .xgplayer.xgplayer-fullscreen-inner'
    );
    document.documentElement.classList.toggle('fntv-video-fullscreen', nativeFs || pseudoFs);
}

/** [lc-1290] 手机竖屏点全屏 → 自动转横屏（用户报障：「全屏按钮没有改为切为横屏的全屏播放」）。
 *
 *  取证：xgplayer 的 fullscreen 插件**自带**这套能力，飞牛只是没开。实测其 defaultConfig：
 *    {useCssFullscreen:!1, rotateFullscreen:!1, useScreenOrientation:!1,
 *     lockOrientationType:`landscape`, ...}
 *  且 toggleFullScreen 里写着：进入全屏后 `n.useScreenOrientation && t.aspectRatio>1 &&
 *  this.lockScreen(n.lockOrientationType)`，退出时 `this.unlockScreen()`。
 *  也就是说只要把 useScreenOrientation 打开，横屏锁是它自己的原生行为，我们不必自己转屏。
 *
 *  为什么不能自己 screen.orientation.lock()：规范要求在**用户手势调用栈内**、且已全屏。
 *  MutationObserver 回调不在手势栈内 → 必然抛 NotSupportedError（xcplayer 的实现正是
 *  为了绕开这点才把它做成配置项，由按钮自己的 click 处理器调用）。
 *
 *  做法（不改飞牛的业务代码，只改它交给 xgplayer 的配置）：
 *  经 React fiber 拿到 player 实例 → 改 player.config.fullscreen.useScreenOrientation = true。
 *  fiber 取法与 gamepad.ts:240 getXgPlayer() 完全一致（已在 lc-679 实测可用）。
 *  iOS 不支持 orientation.lock（xcplayer 的 lockScreen 内部 try/catch 吞掉异常），
 *  即 iPhone 上退化为「保持竖屏进全屏」，不会报错 —— 这是 iOS 的平台限制，非本次可解。 */
let _landscapeBound = false;
function enableLandscapeFullscreen(): void {
    if (_landscapeBound || !isPlayerPage()) return;
    _landscapeBound = true;
    const patch = (): boolean => {
        const root = document.querySelector('[class*=xgplayer]') as any;
        if (!root) return false;
        try {
            const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
            if (!key) return false;
            let node = root[key];
            let depth = 0;
            while (node && depth < 15) {
                const p = node.memoizedProps && node.memoizedProps.player;
                if (p) {
                    // xgplayer 把 fullscreen 插件的 config 挂在 player.config.fullscreen
                    p.config = p.config || {};
                    p.config.fullscreen = p.config.fullscreen || {};
                    if (p.config.fullscreen.useScreenOrientation) return true;
                    p.config.fullscreen.useScreenOrientation = true;
                    p.config.fullscreen.lockOrientationType = 'landscape';
                    log.info('[danmakuWeb] 已开启 xgplayer 横屏全屏 (useScreenOrientation)');
                    return true;
                }
                node = node.return;
                depth++;
            }
        } catch (e: any) {
            log.warn('[danmakuWeb] 横屏全屏开启失败:', e?.message || e);
        }
        return false;
    };
    if (patch()) return;
    // 播放器懒渲染：立即 + 延迟重试（与 bindVideoFullscreenFix 的节奏一致）
    setTimeout(() => { if (!patch()) setTimeout(patch, 2000); }, 800);
    setTimeout(patch, 3000);
}

function bindVideoFullscreenFix(): void {
    if (!isPlayerPage()) return;
    enableLandscapeFullscreen();
    // 非播放页(如路由切走)也要清理残留标记, 避免影响首页圆角
    if (_fsFixBound) { applyVideoFullscreenClass(); return; }
    _fsFixBound = true;
    const update = () => applyVideoFullscreenClass();
    // 浏览器原生全屏事件
    document.addEventListener('fullscreenchange', update, { passive: true });
    // [lc-552] 核心：MutationObserver 监听 .xgplayer 容器的 class 变化
    // xgplayer 进入伪全屏时立即加 xgplayer-fullscreen、退出时移除，比尺寸检测可靠得多
    const tryObservePlayerClass = () => {
        const player = document.querySelector('.xgplayer') as HTMLElement | null;
        if (player && !player.dataset.fntvFsObserved) {
            player.dataset.fntvFsObserved = '1';
            new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        update();
                        break; // 一个 mutation 就够了
                    }
                }
            }).observe(player, { attributes: true, attributeFilter: ['class'] });
        }
    };
    // 立即尝试 + 延迟重试（播放器可能稍后渲染）
    tryObservePlayerClass();
    setTimeout(tryObservePlayerClass, 1000);
    setTimeout(tryObservePlayerClass, 3000);
    // resize 兜底（处理窗口大小变化等边缘情况）
    window.addEventListener('resize', update, { passive: true });
    applyVideoFullscreenClass();
    log.info('[danmakuWeb] 播放器全屏去圆角检测已启用 (MutationObserver+xgplayer-fullscreen)');
}

interface DanmakuItem {
    time: number;   // 秒
    type: number;   // 1/2/3=滚动 4=底部 5=顶部
    color: number;  // 十进制 RGB
    text: string;
}

/** [v1.11.0] 单个弹幕源本次尝试的溯源明细（后端 meta.sources，按 自建源→弹弹play→B站 排序）。 */
interface DanmakuSourceDetail {
    key: string;             // danmu_api | dandanplay | bilibili
    label: string;           // 展示名
    enabled: boolean;        // 本次是否参与（开关关掉/未配置为 false）
    used: boolean;           // 最终采用的是不是这个源
    rawCount: number;        // 拉取原始条数
    count: number;           // 屏蔽过滤后条数
    blocked: number;         // 被屏蔽规则挡掉的条数
    note?: string;           // 未采用/失败原因（人话）
    matchedTitle?: string;   // 命中的条目名
    episodeTitle?: string;   // 命中的分集名
    episodeId?: number;      // 优选源集 id
    bvid?: string;           // B站 视频 id
    cid?: number;            // B站 弹幕库 id
    sim?: number;            // 匹配相似度
    credential?: string;     // 凭证/登录态
    base?: string;           // 自建源服务地址（脱敏）
}

interface DanmakuMeta {
    searchTitle: string;
    matchedTitle: string;
    source: string;          // 'bangumi' | 'video' | '弹弹play' | '自建源(danmu_api)'
    bvid?: string | null;
    cid?: any;
    sim?: number | null;
    ep: number;
    season: number;          // 目标季数（0=未指定）；>0 时优先精确匹配该季
    isMovie: boolean;
    count: number;
    aggregatedFrom?: any;
    cookieStatus?: string;
    error?: string;
    sources?: DanmakuSourceDetail[];
}

interface DanmakuStyle {
    bold: boolean;          // 粗体（MPV bold）
    fontScale: number;      // 字号 / 画布高（MPV fontsize 概念）
    outline: number;        // 描边强度 0~3（MPV outline，默认 1.0）
    shadow: number;         // 阴影强度 0~3（MPV shadow，默认 0）
    scrollDuration: number; // 滚动横跨秒数（MPV scrolltime，默认 8）
    opacity: number;        // 全局不透明度 0.3~1（MPV opacity，本端默认 0.9）
    displayArea: number;    // 弹幕显示范围（占画布高比例，MPV displayarea 默认 0.85）
    autoScale: boolean;     // [lc-1313] 自动缩放：弹幕密集时按轨道占用率缩小字号，稀疏时回到设定值
}

interface ActiveState {
    appear: number;             // 出现时的 video.currentTime
    lane: number;
    w: number;                  // 文本布局宽（不含内边距）—— 轨道碰撞判定与居中都用它
    fix: boolean;               // 是否固定弹幕（顶/底）
    cvs: HTMLCanvasElement;     // 离屏预渲染位图，生命周期与本条弹幕绑定（出 active 即随之回收）
    bw: number;                 // 位图 CSS 宽（含 pad）
    bh: number;                 // 位图 CSS 高（含 pad）
    pad: number;                // 位图四周为描边/阴影预留的内边距，回贴时要减掉
}

// ─── 运行态 ───
let videoEl: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
// [lc-1110] 控制栏只留一个「弹幕」入口(仿原生单按钮), 鼠标移上去弹出原生 .xg-options-list
// 形态的弹窗; 开关/样式旋钮/来源详情全在这一个弹窗里(不再有右侧抽屉)。
let dmBtnWrap: HTMLDivElement | null = null;   // plugin-placeholder 外壳(挂进 xg-right-grid)
let dmBtnSpan: HTMLSpanElement | null = null;  // 按钮文字「弹幕」
let dmList: HTMLDivElement | null = null;      // hover 弹窗(锚在按钮正上方)
// [lc-1113] 弹窗 = 飞牛 Semi 弹层容器(14px 圆角 + 双层阴影 + 进出场动画)，内容是
// 「弹幕开关(Switch 控件) + 两段互斥折叠菜单」。展开/收起只切 class：
// 重绘整块会销毁用户正在拖的滑块（见 syncToggleUI 的注释）。
let dmSecStyle = false;                        // 「弹幕样式」段是否展开(跨 hover 保持)
let dmSecDetail = false;                       // 「来源详情」段是否展开
let dmSecSearch = false;                       // 「手动搜索」段是否展开
let dmHeadStyle: HTMLLIElement | null = null;
let dmHeadDetail: HTMLLIElement | null = null;
let dmHeadSearch: HTMLLIElement | null = null;
let dmFoldStyle: HTMLDivElement | null = null;    // 折叠体引用: 互斥展开时就地切另一段的 class
let dmFoldDetail: HTMLDivElement | null = null;
let dmFoldSearch: HTMLDivElement | null = null;
let dmDetailBody: HTMLDivElement | null = null;   // 详情段的内层容器(meta 到位后就地重填)
let dmDetailShown: typeof meta | undefined;       // 上次渲染详情时的 meta 引用, 变了才重填
// [lc-1118] 手动搜索段: 搜索框 + 最多 5 条候选, 点选定条目直接拉弹幕(主进程落缓存记住选择)
let dmSearchBody: HTMLDivElement | null = null;
let dmSearchResults: any[] | null = null;         // null=本集还没搜过(展开时自动搜一次)
let dmSearchErr = '';
let dmSearchBusy = false;                         // 搜索/选定拉取进行中(按钮与列表进入忙态)
let dmSearchKw = '';                              // 搜索框当前关键词(重绘后恢复输入)
let dmPickedBvid = '';                            // 已选定的候选(bvid/dmapi:<id>), 换集清空
// [lc-1307] 清除弹幕（桌面版 lc-1300 同语义）：忙标记 + 清除代际。
// 代际在途作废：清除时 ++，prepare 响应回来发现代际变了直接丢弃 —— 否则「清除」与
// 「拉取中」赛跑，慢一步的错误匹配原样写回，用户点清除等于白点。
let dmClearBusy = false;
let dmClearEpoch = 0;
let dmSwitch: HTMLInputElement | null = null;     // 开关行引用: 状态变了就地改 checked, 不重绘整块面板
let dmCloseTimer: number | null = null;        // 移出后延时关闭: 留时间让鼠标从按钮移进弹窗
let dmDragging = false;                        // 正拖着滑块/焦点在弹窗内时不自动关闭
let controlsPlaced = false;
let mountedForGuid: string | null = null;
let loading = false;
let inflight = false;       // 同一 guid 只允许一个在途请求（单飞，避免并发重复拉取触发 B站限流）
let enabled = true;
// [lc-1117] 网页独立的「B站弹幕搜索」兜底开关（只管网页链路，MPV 侧 conf 开关不受影响）。
// false 时 prepare 请求带 biliSearch:false，主进程跳过内置 B站降级（自建 danmu_api 优选照常）。
let biliSearch = true;
let items: DanmakuItem[] = [];
let meta: DanmakuMeta | null = null;
let currentGuid: string | null = null;
// [lc-1015] currentGuid 是否来自 play/info 预取（此刻 URL 可能还停留在详情页/上一集）。
// URL 触发的 prepareAndLoad 看到不一致的 guid 时以预取为准，避免旧 URL 把 currentGuid 拉回去。
let currentGuidFromPrefetch = false;
// [lc-1015] guid → 弹幕结果 的内存 LRU：详情页预取后进播放页、播放页切集再切回、
// 同一次会话重进同一集都直接命中，不再走 IPC（IPC 虽有磁盘缓存也有 ~百毫秒开销）。
// 上限 3：自建源(danmu_api) 单集可达十几万条（实测 ~59B/条 → 一份 11MB JSON），
// 结构化克隆后每个条目都常驻渲染进程，6 份能把内存顶到几百 MB。
const guidCache = new Map<string, { items: DanmakuItem[]; meta: DanmakuMeta | null; maxScreen: number }>();
const GUID_CACHE_MAX = 3;

function guidCachePut(guid: string, payload: { items: DanmakuItem[]; meta: DanmakuMeta | null; maxScreen: number }): void {
    guidCache.delete(guid);
    guidCache.set(guid, payload);
    while (guidCache.size > GUID_CACHE_MAX) {
        const oldest = guidCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        guidCache.delete(oldest);
    }
}
let rafId = 0;
let lastTime = -1;

// canvas 渲染引擎状态
const active = new Map<number, ActiveState>();
// [lc-1015] 激活游标：items 按时间升序，已激活过的下标不再重扫（旧版每帧从 0 扫到尾，
// 万条弹幕时每帧上万次 Set 查询，低配机可感）。seek 回拖时归零。
let cursor = 0;
// [lc-1015] 到点后找不到空轨道的宽限：超过即丢弃（对齐 B站 高密度行为），避免迟到弹幕成堆涌入。
const LANE_GRACE_SEC = 2.0;
// [lc-1015] 同文本去重窗口：±1s 内重复文本直接丢弃（多源聚合已在主进程 ±2s 去重，
// 单源内部的「前方高能」刷屏仍会成堆出现）。
const DUP_TEXT_SEC = 1.0;
const recentTexts = new Map<string, number>();
// 去重表整集只增不减（十几万条弹幕 = 十几万个常驻 Map 条目）。超阈值整体清空：
// 只丢 1 秒去重窗口，观感几乎不可察，比维护时间分桶简单得多。
const RECENT_TEXTS_MAX = 2048;
// [lc-1015] 暂停时画面静止：仅在脏（进度/尺寸/样式变化）时重绘，省掉暂停期间的无谓逐帧 clear+draw。
let renderDirty = true;
let lastPausedDraw = false;

// 每条轨道存「占用它的那条弹幕」的时间与宽度，而不是单个 busyUntil 数字 ——
// 碰撞判定（见 slotCollides）两者都要。
interface LaneSlot { time: number; width: number }
let laneScroll: Array<LaneSlot | null> = [];
let laneTop: Array<LaneSlot | null> = [];      // [lc-1015] 顶部固定弹幕独立轨道（旧版顶/底共用一池会隐形互撞）
let laneBottom: Array<LaneSlot | null> = [];   // [lc-1015] 底部固定弹幕独立轨道
let laneCount = 0;

// 渲染参数（参照 B站网页弹幕引擎）
const LANE_RATIO = 0.034;    // 单轨道高 / 画布高（轨道高度基准，不暴露给用户）
// 同屏上限：来自主进程的 biliDanmakuMaxScreen（与 MPV 的 max_screen_danmaku 同一份设置），0=不限。
let maxScreen = 0;
// 0=不限时仍必须有防崩硬顶：自建源单集可达十几万条（≈80 条/秒），不限就会同帧激活上千条位图。
const MAX_ACTIVE_HARD_CAP = 200;

// 样式热切换：签名变了就把在屏弹幕整体重建（见 relocateCursor）。
// 不含 opacity —— 它只在绘制时读，重建反而会让拖滑块时每帧清屏。
let appliedSignature: string | null = null;
let styleSettling = false;
let styleSettleTimer: ReturnType<typeof setTimeout> | null = null;

// [lc-1313] 自动缩放的当前系数（-1 = 未激活/已复位；激活时 0.6~1 平滑跟随目标）。
// 渲染帧内读写，模块级持有以在开关开→关→开之间保持连续。
let autoScaleK = -1;

// 画布矩形改为事件驱动 + 低频兜底（旧版每帧 getBoundingClientRect = 每帧强制 layout）
let needRectSync = true;
let rectTicks = 0;
const RECT_SYNC_EVERY = 30;
let rectRO: ResizeObserver | null = null;
let rectROTarget: HTMLVideoElement | null = null;

// 弹幕样式（默认对齐 MPV 观感；用户可在播放器内「样式」面板调节，各端独立持久化）
const DEFAULT_STYLE: DanmakuStyle = {
    bold: false,
    fontScale: 0.036,
    outline: 1.0,
    shadow: 0,
    scrollDuration: 8,
    opacity: 0.9,
    displayArea: 0.85,
    autoScale: false,   // [lc-1313] 默认关：字号严格跟滑块，开了才按密度自适应
};

function clampNum(v: any, min: number, max: number, dflt: number): number {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

function loadStyle(): DanmakuStyle {
    try {
        const raw = localStorage.getItem(LS_STYLE_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                bold: !!p.bold,
                fontScale: clampNum(p.fontScale, 0.018, 0.072, DEFAULT_STYLE.fontScale),
                outline: clampNum(p.outline, 0, 3, DEFAULT_STYLE.outline),
                shadow: clampNum(p.shadow, 0, 3, DEFAULT_STYLE.shadow),
                scrollDuration: clampNum(p.scrollDuration, 4, 16, DEFAULT_STYLE.scrollDuration),
                opacity: clampNum(p.opacity, 0.3, 1, DEFAULT_STYLE.opacity),
                displayArea: clampNum(p.displayArea, 0.3, 1, DEFAULT_STYLE.displayArea),
                autoScale: !!p.autoScale,
            };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_STYLE };
}

// 样式签名：任一项变化都让在屏弹幕的位图/行高/轨道数/滚动时长作废。
// 刻意不含 opacity —— 它只在绘制时读，纳入签名会让拖透明度滑块时每帧清屏。
// [lc-1313] autoScale 也不纳入：它只影响本帧 fontSize 的计算值（连续量），纳入会让
// 密度波动时反复触发整体重建；缩放系数变化只需重设 currentFont + renderDirty。
function styleSignature(): string {
    return `${style.bold}|${style.fontScale}|${style.outline}|${style.shadow}|${style.scrollDuration}|${style.displayArea}|${maxScreen}`;
}

function saveStyle(): void {
    renderDirty = true; // [lc-1015] 样式变化后即使暂停也立即重绘生效
    // 拖滑块 = input 事件每帧一发。写盘与重建都 debounce 到停手之后，
    // 否则一次拖动就是几百次 localStorage 写 + 几百次整屏清空（观感=弹幕疯狂闪烁）。
    styleSettling = true;
    if (styleSettleTimer) clearTimeout(styleSettleTimer);
    styleSettleTimer = setTimeout(() => {
        styleSettleTimer = null;
        styleSettling = false;
        try { localStorage.setItem(LS_STYLE_KEY, JSON.stringify(style)); } catch { /* ignore */ }
        renderDirty = true;
    }, 180);
}

let style: DanmakuStyle = loadStyle();

// ─── 页面检测 ───

function isPlayerPage(): boolean {
    return !!(document.querySelector('video') && GUID_RE.test(window.location.href));
}

/** [v1.4.0] 触屏环境判定（手机/平板网页）。主判据用设备硬事实（ontouchstart /
 *  maxTouchPoints —— 出厂即定，不随运行时状态漂移）；pointer/hover 媒体查询只作加分项。
 *  ⚠ 不能反过来依赖 matchMedia：Playwright full_page screenshot 等工具会重置指针模拟
 *  （coarse/hover 翻转为 false），部分安卓 WebView 外接鼠标时也会翻 —— 那会让 toggle
 *  分支中途失效（面板点开就关不掉）。 */
function isTouchEnv(): boolean {
    try {
        const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
        if (!touch) return false;
        // 有触摸能力的设备上，窄屏才走触屏交互（触屏笔记本的大窗口保持鼠标语义）
        const narrow = Math.min(window.innerWidth, window.innerHeight) <= 640;
        return narrow;
    } catch { return false; }
}

function getGuid(): string | null {
    const m = window.location.href.match(GUID_RE);
    return m?.[1] || null;
}

// ─── 选视频（取可见面积最大的那个，规避"选错 video 元素"导致的时灵时不灵）───

function pickVideo(): HTMLVideoElement | null {
    const vs = document.querySelectorAll('video');
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (let i = 0; i < vs.length; i++) {
        const v = vs[i] as HTMLVideoElement;
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
}

// ─── DOM 定位：控制栏 ───

/**
 * 找原生控制栏（从 document 精确锚定，不使用会误中提示气泡的模糊选择器）。
 * 飞牛播放器实测 DOM：<xg-controls class="xgplayer-controls"> 内含 <xg-right-grid>，
 * 原画/选集/倍速等文字按钮都是 <div class="plugin-placeholder"> 子节点。
 */
function findControlsBar(): HTMLElement | null {
    const right = document.querySelector('xg-right-grid') as HTMLElement | null;
    if (right && right.offsetHeight > 0) return right;
    const controls = (document.querySelector('xg-controls.xgplayer-controls') ||
        document.querySelector('.xgplayer-controls')) as HTMLElement | null;
    if (controls && controls.offsetHeight > 0) {
        const innerRight = controls.querySelector('xg-right-grid') as HTMLElement | null;
        if (innerRight && innerRight.offsetHeight > 0) return innerRight;
        return controls;
    }
    const all = document.querySelectorAll('div, nav, [role]');
    for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement;
        const h = el.offsetHeight;
        const txt = el.textContent || '';
        if ((txt.includes('倍速') || txt.includes('选集') || txt.includes('原画')) &&
            h > 20 && h < 120 && el.children.length >= 2) {
            return el;
        }
    }
    return null;
}

// ═══ [lc-1110→lc-1113] 弹幕 hover 弹窗样式 ═══
// 取证来源从 xgplayer 自带的 .xg-options-list 换到飞牛 Semi 组件库 —— 用户要「跟飞牛一样」，
// 而飞牛自己的弹层就是 Semi 渲染的。下列值逐字取自 fnOS /assets/index.css：
//   .semi-dropdown-wrapper{border-radius:14px;background:var(--semi-color-bg-dropdown);
//     box-shadow:0 10px 20px #00000014,0 10px 40px #0000001f;z-index:1050}
//   .semi-dropdown-menu{padding:4px 0;margin:0;list-style:none}
//   .semi-dropdown-item{padding:8px 16px;color:var(--semi-color-text-0)}
//     hover→--semi-color-fill-1 / active→--semi-color-fill-2（换底色，不是换字色）
//   .semi-switch{width:40px;height:24px;border-radius:12px;background:var(--semi-color-fill-2)}
//     -checked{background:var(--semi-color-primary)}；-knob{18×18;top:2px;radius 9px;#fff;
//     box-shadow:0 4px 6px #0000001a,0 0 1px #0000004d}；-checked .-knob{transform:translate(18px)}
//   暗色 tokens: bg-dropdown=rgba(46,47,48,1) fill-1=rgba(255,255,255,.06) fill-2=…,.12
// ⚠ 不复用 Semi 类名、只复刻规格到自有类：面板挂在 xgplayer 控制栏里，与库样式的特异度对撞要可控。
// ⚠ 动画时长必须自己写：fnOS 把 --semi-transition_duration-* 全覆成 0ms，原生弹层其实没有过渡。
const DM_PANEL_STYLE_ID = 'fntv-dm-panel-style';
// 原生 .xgplayer{--xgplayer-color:var(--semi-color-primary)} → 弹窗里的滑块/复选框同色系，
// 不用旧模态那套 iOS 蓝 #2997ff（在飞牛播放器里是异色）。
const BRAND_ACCENT = 'var(--semi-color-primary, #3374DB)';
let _dmPanelStyleInjected = false;

function injectDmPanelStyle(): void {
    if (_dmPanelStyleInjected) return;
    const css = `
/* ── hover 弹窗: 逐字照抄飞牛 Semi 弹层 .semi-dropdown-wrapper / -menu / -item ── */
/* z-index 30: 原生 .xg-options-list 写的是 5, 但我们的弹幕 canvas 挂在 body 上 z-index=5、
   高能条 z-index=6 → 同一层叠上下文里后插入者胜, 面板会被 canvas 盖住。 */
/* 右对齐按钮而非原生的居中(right:50%+translate(50%)): 弹窗 320px 宽, 弹幕按钮在控制栏
   最右侧一组里, 居中会溢出播放器右边界。 */
.fntv-dm-list{
  position:absolute; right:-6px; bottom:calc(100% + 10px);
  z-index:30; width:320px; box-sizing:border-box; margin:0; padding:4px 0;
  background:rgba(46,47,48,.97);                 /* 暗色 --semi-color-bg-dropdown = grey-2(46,47,48) */
  border:1px solid rgba(255,255,255,.07);        /* 纯黑画面上把容器边界分出来 */
  border-radius:14px;                            /* .semi-dropdown-wrapper */
  box-shadow:0 10px 20px #00000014, 0 10px 40px #0000001f;
  cursor:default; overflow:auto; color:#fff; font-size:14px; line-height:20px;
  /* 高度随内容长(折叠段自己过渡); 只在极端小窗兜底 —— 正常形态下一览无余、不出滚动条 */
  max-height:min(86vh, 920px);
  /* 否则复选框/滑块按浅色表单控件渲染, 暗面板上是一条近白粗轨 */
  color-scheme:dark;
  /* fnOS 顶栏是窗口拖拽区, 注入面板必须显式排除, 否则滑块拖不动 */
  -webkit-app-region:no-drag;
  /* 进出场动画: 不能再靠 display:none 硬切(那会跳过整段过渡)。visibility 延到淡出走完
     才翻隐藏 → 关闭态既不占视觉也不拦点击。 */
  transform-origin:100% 100%;
  opacity:0; visibility:hidden; pointer-events:none; transform:translateY(8px) scale(.96);
  transition:opacity .18s cubic-bezier(.22,1,.36,1), transform .18s cubic-bezier(.22,1,.36,1), visibility 0s linear .18s;
}
.fntv-dm-list.active{opacity:1; visibility:visible; pointer-events:auto; transform:none; transition-delay:0s}
/* [v1.4.1] 手机网页：visibility:hidden 的面板仍占布局，absolute+right 负偏移会把 body 撑出
   横向滚动（实测页面能左右晃 210px）。隐藏态 display:none 兜住布局（display 不参与过渡，
   淡入路径：display 先翻块再走 opacity——浏览器对 display:none→block + transition 组合
   在同帧渲染时过渡会丢，但打开是「瞬间可见可接受」，关闭淡出照常走完才回 none）。 */
html.fnos-touch-narrow .fntv-dm-list:not(.active){ display:none !important; }
/* [v1.4.0] 手机网页：320px 定宽 + right:-6px 会溢出竖屏视口。触屏窄屏(html.fnos-touch-narrow,
   由 beautifyStyle 注入侧安装;弹幕按钮挂载晚于详情页样式注入,播放页无该标记时此处回退
   max-width 媒体查询)下改为视口宽减边距、贴视口右缘。 */
@media (max-width: 640px){
  html.fnos-touch-narrow .fntv-dm-list{
    width:min(92vw, 360px);
    right:calc(-1 * (100vw - 100%) / 2 + 4vw);   /* wrap 右缘≈视口右缘 → 面板右缘内缩 4vw */
    max-height:72vh;
  }
}
/* 透明桥接: 弹窗与按钮之间留 10px 视觉间隙, 但鼠标穿过时不能算「移出」——
   hover 触发的弹窗若在半路关掉, 就永远移不进去拖滑块。伪元素属于弹窗本身。 */
.fntv-dm-list::after{content:'';position:absolute;left:0;right:0;top:100%;height:12px}
/* 行 = .semi-dropdown-item: 左对齐 + 8px 16px + hover 换底色(原生就是换底色, 不是换字色) */
.fntv-dm-list li{
  display:flex; align-items:center; gap:8px; margin:0; padding:8px 16px;
  list-style:none; cursor:pointer; color:#fff; transition:background-color .16s ease;
}
.fntv-dm-list li:hover{background:rgba(255,255,255,.06)}    /* --semi-color-fill-1 */
.fntv-dm-list li:active{background:rgba(255,255,255,.12)}   /* --semi-color-fill-2 */
/* 开关行: 标签在左、Switch 推到右缘 */
.fntv-dm-sw-row{justify-content:space-between}
/* Semi Switch 逐字规格: 40×24 轨道 / 18×18 白色旋钮 / 选中位移 18px */
.fntv-dm-sw{
  position:relative; flex:none; box-sizing:border-box; width:40px; height:24px;
  border-radius:12px; border:1px solid transparent; background:rgba(255,255,255,.12);
  transition:background-color .2s cubic-bezier(0,0,.2,1);
}
.fntv-dm-sw:hover{background:rgba(255,255,255,.06)}
.fntv-dm-sw-knob{
  position:absolute; left:0; top:2px; width:18px; height:18px; border-radius:9px;
  background:#fff; box-shadow:0 4px 6px #0000001a, 0 0 1px #0000004d;
  transition:transform .2s ease-in-out;
}
.fntv-dm-sw:has(input:checked){background:var(--semi-color-primary, #3374DB)}
.fntv-dm-sw:has(input:checked):hover{background:var(--semi-color-primary-hover, #2e63c9)}
.fntv-dm-sw:has(input:checked) .fntv-dm-sw-knob{transform:translate(18px)}
/* 原生 checkbox 管状态与键盘, 视觉全交给上面的轨道 */
.fntv-dm-sw input{position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer}
/* 折叠头: 标题在左、caret 在右(纯 CSS 画 V 形, 不依赖字形); 展开态标题转品牌色 */
.fntv-dm-h{justify-content:space-between}
.fntv-dm-h.open{color:var(--semi-color-primary, #3374DB)}
.fntv-dm-caret{
  flex:none; width:6px; height:6px;
  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;
  transform:rotate(45deg); opacity:.45; transition:transform .22s ease, opacity .22s ease;
}
.fntv-dm-h.open .fntv-dm-caret{transform:rotate(-135deg); opacity:.85}
/* 折叠: grid-template-rows 0fr↔1fr 过渡; visibility 的过渡是阶跃的(展开立即变可见、收起等动画走完)正好合用。 */
.fntv-dm-fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s ease}
.fntv-dm-fold.open{grid-template-rows:1fr}
/* 左右留白由内层统一承担(容器只留上下 4px)。纵向 padding 会漏出 0fr 轨道(实测泄 2px) → 一律不给,
   呼吸放裁剪框内部的 ::after。 */
.fntv-dm-fold>div{overflow:hidden;min-height:0;box-sizing:border-box;padding:0 16px;visibility:hidden;transition:visibility .22s ease}
.fntv-dm-fold>div::after{content:'';display:block;height:12px}
.fntv-dm-fold.open>div{visibility:visible}
/* 分区线 = .semi-dropdown-divider: 通铺 1px, 上下 4px */
.fntv-dm-sep{height:1px;margin:4px 0;background:rgba(255,255,255,.15);pointer-events:none}
/* [lc-1118] 手动搜索段: 搜索行 + 候选列表(极简排版, 无框体堆砌)。
   选择器带 .fntv-dm-list 前缀抬特异度，并显式压掉飞牛页面全局给 input/button 的
   浅色 inset 描边与灰白底(box-shadow/background)，否则控件在暗底弹窗里发灰 */
.fntv-dm-list .fntv-dm-search-row{display:flex;gap:6px;align-items:center;padding:8px 16px 4px}
.fntv-dm-list .fntv-dm-search-in{
  flex:1;min-width:0;height:28px;padding:0 9px;box-sizing:border-box;
  border:1px solid rgba(255,255,255,.14);border-radius:6px;
  background:rgba(255,255,255,.07);color:#fff;font-size:12px;
  outline:none;box-shadow:none;appearance:none;
}
.fntv-dm-list .fntv-dm-search-in::placeholder{color:rgba(255,255,255,.35)}
.fntv-dm-list .fntv-dm-search-in:focus{border-color:var(--semi-color-primary,#3374DB);background:rgba(255,255,255,.09)}
.fntv-dm-list .fntv-dm-search-btn{
  flex:none;height:28px;padding:0 12px;box-sizing:border-box;
  border:none;border-radius:6px;
  background-color:var(--semi-color-primary,#3374DB);
  color:#fff;font-size:12px;font-weight:500;cursor:pointer;
  outline:none;box-shadow:none;appearance:none;
}
.fntv-dm-list .fntv-dm-search-btn:hover{background-color:var(--semi-color-primary-hover,#2e63c9)}
.fntv-dm-list .fntv-dm-search-btn:disabled{opacity:.45;cursor:default}
.fntv-dm-cand{padding:7px 16px;cursor:pointer}
.fntv-dm-cand:hover{background:rgba(255,255,255,.06)}
.fntv-dm-cand.on{background:rgba(51,116,219,.18)}
.fntv-dm-cand.on:hover{background:rgba(51,116,219,.26)}
.fntv-dm-cand-t{font-size:12px;color:#fff;line-height:1.45;word-break:break-all}
.fntv-dm-cand.on .fntv-dm-cand-t{color:var(--semi-color-primary,#3374DB)}
.fntv-dm-cand-s{font-size:11px;color:rgba(255,255,255,.45);margin-top:2px}
.fntv-dm-search-msg{font-size:12px;color:rgba(255,255,255,.5);padding:8px 16px;line-height:1.55}
.fntv-dm-search-err{color:#ff8a8a}
/* 旋钮区: 每行「标签 + 当前值」在上、滑块在下, 与 MPV 弹幕样式面板同构 */
.fntv-dm-knobs{display:flex;flex-direction:column;gap:14px}
/* 「恢复默认」通铺成一行菜单项: 负 margin 抵消内层留白, 发丝线才跟分区线一样齐边 */
.fntv-dm-reset{
  margin:14px -16px -12px; padding:12px 16px 10px; border-top:1px solid rgba(255,255,255,.08);
  color:#fff; cursor:pointer; font-size:14px; text-align:center; transition:background-color .16s ease;
}
.fntv-dm-reset:hover{background:rgba(255,255,255,.06)}
/* [lc-1307] 清除弹幕行：轻度警示色与普通菜单行区分；点完短暂变绿确认（桌面 lc-1300 同款） */
.fntv-dm-list li.fntv-dm-clear{justify-content:center;font-size:13px;color:#ff9c9c}
.fntv-dm-list li.fntv-dm-clear:hover{background:rgba(255,107,107,.10)}
.fntv-dm-list li.fntv-dm-clear.fntv-dm-clear-done{color:#5ad17a}
/* 详情: 单行「标签左 / 值右」(iOS 设置单元格式)。原先标签/值各一行太占高 ——
   11 行把框顶到 86vh 上限仍需滚 93px，而用户明确要「展开详情就一览无余、不要滚动」。
   值可能是很长的服务端标题 → 允许折行右对齐，overflow-wrap:anywhere 兜住连号 BVID。 */
.fntv-dm-rows{margin:0;padding:0}
.fntv-dm-row{
  display:flex; align-items:baseline; justify-content:space-between; gap:14px;
  padding:7px 0; border-bottom:1px solid rgba(255,255,255,.05);
}
.fntv-dm-row:last-child{border-bottom:none}
.fntv-dm-row dt{flex:none;font-size:12px;color:rgba(255,255,255,.45)}
.fntv-dm-row dd{
  margin:0; flex:1; min-width:0; text-align:right; font-size:13px; line-height:1.4;
  color:rgba(255,255,255,.92); overflow-wrap:anywhere;
}
.fntv-dm-wait{padding:2px 0 0;font-size:13px;color:rgba(255,255,255,.45)}
/* 复选框自绘: 原生 checkbox 在暗面板上是一坨实心灰块, 与飞牛 Semi 的描边方框观感不符。
   ⚠ 必须排除开关里那个透明的原生 checkbox, 否则它会被画成方框。 */
.fntv-dm-list input[type=checkbox]:not(.fntv-dm-sw-in){
  -webkit-appearance:none; appearance:none; box-sizing:border-box; width:16px; height:16px; margin:0;
  background-color:#ffffff14; border:1px solid #ffffff33; border-radius:3px; cursor:pointer;
  background-repeat:no-repeat; background-position:center; background-size:11px 11px;
  transition:border-color .15s ease, background-color .15s ease;
}
.fntv-dm-list input[type=checkbox]:not(.fntv-dm-sw-in):hover{border-color:#ffffff5c}
.fntv-dm-list input[type=checkbox]:not(.fntv-dm-sw-in):checked{
  background-color:var(--semi-color-primary, #3374DB); border-color:transparent;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 4.9 8.6 9.4 3.7' fill='none' stroke='%23fff' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
/* 滑块自绘: accent-color 的未填充轨道在暗面板上是一条近白粗轨(color-scheme:dark 也压不住),
   已填充比例由 makeSlider 的 paint() 用 linear-gradient 画在 background 上 */
.fntv-dm-list input[type=range]{
  -webkit-appearance:none; appearance:none; width:100%; height:4px; margin:6px 0 0;
  border-radius:2px; background:rgba(255,255,255,.18); cursor:pointer; outline:none;
}
.fntv-dm-list input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none; appearance:none; width:12px; height:12px; border-radius:50%;
  background:var(--semi-color-primary, #3374DB); border:none;
}
/* 极端小窗兜底: 弹窗自身就是滚动容器, ::-webkit-scrollbar 必须同时写自身与后代 */
.fntv-dm-list::-webkit-scrollbar,.fntv-dm-list *::-webkit-scrollbar{width:6px}
.fntv-dm-list::-webkit-scrollbar-thumb,.fntv-dm-list *::-webkit-scrollbar-thumb{background:#ffffff2e;border-radius:3px}`;
    const el = document.createElement('style');
    el.id = DM_PANEL_STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    _dmPanelStyleInjected = true;
}

// ─── 挂载 canvas + 控制栏按钮 ───

function ensureCanvas(): void {
    if (canvas) {
        // 复播时必须复位：leavePlayer 收起的是 display，这里不早退恢复就永远看不见弹幕
        canvas.style.display = enabled ? 'block' : 'none';
        return;
    }
    const c = document.createElement('canvas');
    c.id = 'fntv-danmaku-canvas';
    Object.assign(c.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        zIndex: '5',          // 高于 video(0)，低于 xgplayer 控制栏/UI
        pointerEvents: 'none',
        display: enabled ? 'block' : 'none',
    } as CSSStyleDeclaration);
    document.body.appendChild(c);
    canvas = c;
    ctx = c.getContext('2d');
}

function ensureMounted(): void {
    if (!isPlayerPage()) return;
    ensureCanvas();

    // SPA 换集/返回再进：旧播放器 DOM 连同按钮一起被销毁，入位标记必须作废
    if (dmBtnWrap && !dmBtnWrap.isConnected) controlsPlaced = false;

    const bar = findControlsBar();
    // [lc-1107] 控制栏还没渲染出来时**不再**把按钮丢到 body 上兜底：旧代码那样做会让按钮
    // 落在页面左上角被 xgplayer 层盖住（用户看到的就是"要播十来秒才出现"），改成留在游离态，
    // 由 startMountPoll() 每 400ms 重试，控制栏一出现立刻入位。
    if (!bar) return;

    if (!dmBtnWrap) createControls();
    if (dmBtnWrap && dmBtnWrap.parentElement !== bar) bar.appendChild(dmBtnWrap);
    if (!controlsPlaced) {
        log.info('[danmakuWeb] 弹幕入口已注入控制栏(' + String(bar.className).slice(0, 40) + ')');
        controlsPlaced = true;
        stopMountPoll();
    }
}

/**
 * [lc-1107] 控制栏只放一个「弹幕」入口，DOM 层级照抄原生文字按钮（原画/选集/倍速）：
 * `div.plugin-placeholder > div.h-full > div.flex.h-full.items-center.justify-center[tabindex=0] > span`。
 * 紧凑弹窗作为 wrap 的子节点，靠 `bottom:100%; right:50%; translate(50%)` 锚在按钮正上方，
 * 所以 wrap 必须是定位上下文。
 */
function createControls(): void {
    if (dmBtnWrap) return;
    injectDmPanelStyle();

    const wrap = document.createElement('div');
    wrap.className = 'plugin-placeholder';
    wrap.dataset.fnosUi = '1';      // 约定标记：豁免各注入层的刷白/焦点/动画接管
    wrap.style.position = 'relative';

    const hfull = document.createElement('div');
    hfull.className = 'h-full';
    const flex = document.createElement('div');
    flex.className = 'flex h-full items-center justify-center';
    flex.setAttribute('tabindex', '0');

    // [lc-1106] xgplayer 控制栏恒为暗底(渐变遮罩), 不跟随页面明暗主题 →
    // 不能用 --semi-color-text-1(浅色主题下解析为深色 → 暗底上不可见/反色),
    // 固定用白色系, 与 xgplayer 原生控件(倍速/选集/全屏)一致。
    const span = document.createElement('span');
    span.className = 'cursor-pointer text-lg leading-lg';
    span.style.userSelect = 'none';
    span.textContent = t('弹幕');
    flex.appendChild(span);
    hfull.appendChild(flex);
    wrap.appendChild(hfull);

    const list = document.createElement('div');
    list.className = 'fntv-dm-list';
    list.dataset.fnosUi = '1';
    wrap.appendChild(list);

    // [lc-1110] 与飞牛原生按钮同交互：鼠标移上去就弹出、移出延时关闭。
    // 延时不可省 —— 弹窗锚在按钮上方(中间 6px 间隙靠 ::after 桥接)，用户还要把鼠标
    // 移进弹窗拖滑块；立即关闭等于弹窗永远碰不到。
    // [v1.4.0] 触屏(手机网页)改 toggle 语义：①Chromium 触屏 tap 会**合成 mouseenter**
    // （实测 tap 一次连发 4 次），hover 路径先开面板、click 再 toggle 关掉 = 永远开不了，
    // 故触屏直接忽略 enter/leave；②没有 hover 就没有"移出关闭"，开→关只能再点按钮或点外。
    // 鼠标设备行为一字不变。
    wrap.addEventListener('mouseenter', () => {
        if (isTouchEnv()) return;
        cancelClosePanel(); openPanel();
    });
    wrap.addEventListener('mouseleave', () => { if (!isTouchEnv()) scheduleClosePanel(); });
    // 点击也保留(触控板/键盘用户)：触屏=toggle 开关，鼠标=保持展开不关
    flex.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        cancelClosePanel();
        if (isTouchEnv() && dmList?.classList.contains('active')) {
            closePanel();               // 触屏：开→点按钮→关（toggle）
        } else {
            openPanel();
        }
    });
    list.addEventListener('click', (e) => e.stopPropagation());
    // 拖滑块时鼠标可能滑出弹窗边界 → 拖动期间不自动关闭（once 注册, 避免重建按钮时累积监听）
    list.addEventListener('pointerdown', () => {
        dmDragging = true;
        window.addEventListener('pointerup', () => { dmDragging = false; }, { once: true });
    });

    dmBtnWrap = wrap;
    dmBtnSpan = span;
    dmList = list;
    syncToggleUI();
}

/** 弹窗内容：「弹幕」开关行(Semi Switch) + 「弹幕样式」「来源详情」两段互斥折叠菜单。 */
function renderPanel(): void {
    const p = dmList;
    if (!p) return;
    const keepScroll = p.scrollTop;   // 重绘(点开关/恢复默认)后别把用户弹回顶部
    p.innerHTML = '';
    dmSwitch = null;
    dmHeadStyle = null;
    dmHeadDetail = null;
    dmHeadSearch = null;
    dmFoldStyle = null;
    dmFoldDetail = null;
    dmFoldSearch = null;
    dmDetailBody = null;
    dmSearchBody = null;
    dmDetailShown = undefined;

    // 开关做成 Switch 而不是两行「开/关」纯文字: 状态一眼可见, 也跟飞牛其余设置项同构。
    const swRow = document.createElement('li');
    swRow.className = 'fntv-dm-sw-row';
    const swLab = document.createElement('span');
    swLab.textContent = t('弹幕');
    const sw = document.createElement('label');
    sw.className = 'fntv-dm-sw';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'fntv-dm-sw-in';
    input.checked = enabled;
    input.setAttribute('aria-label', t('弹幕'));
    input.addEventListener('change', () => setDanmakuEnabled(input.checked));
    const knob = document.createElement('span');
    knob.className = 'fntv-dm-sw-knob';
    sw.appendChild(input);
    sw.appendChild(knob);
    swRow.appendChild(swLab);
    swRow.appendChild(sw);
    // 点行任意位置都能拨开关(命中控件本身时交给原生 change, 别重复翻一次)
    swRow.addEventListener('click', (e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('.fntv-dm-sw')) return;
        input.checked = !input.checked;
        setDanmakuEnabled(input.checked);
    });
    dmSwitch = input;
    p.appendChild(swRow);

    // [lc-1117] 第二行：「B站弹幕搜索」兜底开关（网页独立，只管本页面的降级链路）
    const biliRow = document.createElement('li');
    biliRow.className = 'fntv-dm-sw-row';
    const biliLab = document.createElement('span');
    biliLab.textContent = t('B站弹幕搜索');
    const biliSw = document.createElement('label');
    biliSw.className = 'fntv-dm-sw';
    const biliInput = document.createElement('input');
    biliInput.type = 'checkbox';
    biliInput.className = 'fntv-dm-sw-in';
    biliInput.checked = biliSearch;
    biliInput.setAttribute('aria-label', t('B站弹幕搜索'));
    biliInput.addEventListener('change', () => setBiliSearch(biliInput.checked));
    const biliKnob = document.createElement('span');
    biliKnob.className = 'fntv-dm-sw-knob';
    biliSw.appendChild(biliInput);
    biliSw.appendChild(biliKnob);
    biliRow.appendChild(biliLab);
    biliRow.appendChild(biliSw);
    biliRow.addEventListener('click', (e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('.fntv-dm-sw')) return;
        biliInput.checked = !biliInput.checked;
        setBiliSearch(biliInput.checked);
    });
    p.appendChild(biliRow);

    const sep1 = document.createElement('div');
    sep1.className = 'fntv-dm-sep';
    p.appendChild(sep1);

    const knobs = document.createElement('div');
    knobs.className = 'fntv-dm-knobs';
    knobs.appendChild(buildStyleControls());
    dmHeadStyle = mkFold(p, t('弹幕样式'), knobs, 'style');

    dmDetailBody = document.createElement('div');
    dmHeadDetail = mkFold(p, t('来源详情'), dmDetailBody, 'detail');
    renderDetailRows();

    // [lc-1118] 第三段「手动搜索」：展开时自动按当前番名搜一次，也可改关键词重搜，点候选直接换弹幕
    dmSearchBody = document.createElement('div');
    dmHeadSearch = mkFold(p, t('手动搜索'), dmSearchBody, 'search', (open) => {
        if (open && dmSearchResults === null && !dmSearchBusy) {
            void runSearch(dmSearchKw || (meta ? meta.searchTitle : ''));
        }
    });
    renderSearchBody();

    // [lc-1307] 第四行「清除弹幕」：自动匹配错了（如 TMDB 分部命名与 B站「第N期」口径
    // 不一致锁到错条目）时一键按剧重置 —— 与桌面版 lc-1300 同语义同位置（面板末行）。
    const clearRow = document.createElement('li');
    clearRow.className = 'fntv-dm-clear';
    clearRow.textContent = t('清除弹幕');
    clearRow.addEventListener('click', (e) => {
        e.stopPropagation();
        void clearDanmakuMatch(clearRow);
    });
    p.appendChild(clearRow);
    p.scrollTop = keepScroll;
}

/** 折叠段 = 一行菜单项标题(左) + caret(右) + 一个 0fr↔1fr 的 grid 体。
 * 点击只切 class：内容节点全程不换，展开着的滑块不会被销毁。
 * 三段互斥 —— 同时展开会把面板顶到比播放器还高，就得滚了。
 * onToggle: 段切换后回调(open=true 展开)，手动搜索段用它触发首次自动搜索。 */
function mkFold(parent: HTMLElement, label: string, body: HTMLElement,
                which: 'style' | 'detail' | 'search', onToggle?: (open: boolean) => void): HTMLLIElement {
    const on = () => (which === 'style' ? dmSecStyle : which === 'detail' ? dmSecDetail : dmSecSearch);

    const head = document.createElement('li');
    head.className = 'fntv-dm-h';
    head.textContent = label;
    const caret = document.createElement('span');
    caret.className = 'fntv-dm-caret';
    head.appendChild(caret);

    const fold = document.createElement('div');
    fold.className = 'fntv-dm-fold';
    fold.appendChild(body);
    if (which === 'style') dmFoldStyle = fold; else if (which === 'detail') dmFoldDetail = fold; else dmFoldSearch = fold;

    const apply = (): void => {
        head.classList.toggle('open', on());
        fold.classList.toggle('open', on());
    };
    apply();

    head.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !on();
        dmSecStyle = which === 'style' ? next : false;
        dmSecDetail = which === 'detail' ? next : false;
        dmSecSearch = which === 'search' ? next : false;
        if (dmFoldStyle) { dmFoldStyle.classList.toggle('open', dmSecStyle); dmHeadStyle?.classList.toggle('open', dmSecStyle); }
        if (dmFoldDetail) { dmFoldDetail.classList.toggle('open', dmSecDetail); dmHeadDetail?.classList.toggle('open', dmSecDetail); }
        if (dmFoldSearch) { dmFoldSearch.classList.toggle('open', dmSecSearch); dmHeadSearch?.classList.toggle('open', dmSecSearch); }
        onToggle?.(next);
    });
    parent.appendChild(head);
    parent.appendChild(fold);
    return head;
}

function openPanel(): void {
    if (!dmList) return;
    // 已展开就不重绘：mouseenter 会在鼠标于按钮与弹窗之间往返时反复触发，
    // 每次重绘都把光标下的元素换成新节点 → 浏览器重发边界事件 → leave/enter 自激循环。
    if (!dmList.classList.contains('active')) renderPanel();
    dmList.classList.add('active');
    refreshDismissBinding();
}

function closePanel(): void {
    cancelClosePanel();
    // 折叠段的展开状态跨 hover 保持：刚展开调完字号，下次 hover 不该又缩回去
    dmList?.classList.remove('active');
    if (dmList) dmList.scrollTop = 0;
    refreshDismissBinding();
}

/** 移出后延时关闭；期间回到按钮/弹窗、或正拖着滑块 → 不关。
 * ⚠ 不看 document.activeElement：拖滑块/点复选框都会让控件拿到焦点，鼠标在弹窗**外**松手后
 * 焦点仍在弹窗里，加上这条规则弹窗就永久卡开（再移进移出也关不掉，只能 ESC/点外面）。
 * 原生 .xg-options-list 就是移出即收；键盘用户 Tab 进来不会触发 mouseleave，不受影响。 */
function scheduleClosePanel(): void {
    cancelClosePanel();
    dmCloseTimer = window.setTimeout(() => {
        dmCloseTimer = null;
        if (dmDragging) { scheduleClosePanel(); return; }
        closePanel();
    }, 260);
}

function cancelClosePanel(): void {
    if (dmCloseTimer !== null) { window.clearTimeout(dmCloseTimer); dmCloseTimer = null; }
}

function syncToggleUI(): void {
    if (!dmBtnSpan) return;
    dmBtnSpan.textContent = loading ? t('弹幕…') : t('弹幕');
    // [lc-1106] 控制栏恒暗底: 开启=品牌蓝, 关闭=半透白(不用 --semi-color-text-1, 浅色主题下会反色)
    // [lc-1107] --fn-bg-brand 是幻影 token(fnOS index.css 里没有, 项目内也仅此一处引用) →
    // 旧写法实际恒为硬编码 #3374DB, 与弹窗选中行的 --semi-color-primary(暗色主题实测
    // rgb(0,102,255)) 不是一个蓝。统一走同一条 token 链。
    dmBtnSpan.style.color = enabled
        ? 'var(--semi-color-primary, #3374DB)'
        : 'rgba(255,255,255,.45)';
    // ⚠ 不能在这里重绘整块弹窗：xgplayer 播放期持续改 DOM(进度条/时间文本) →
    // OnDomChange(800ms 尾随防抖) → maybeSetup → 这里，重绘会把用户**正在拖的滑块**与
    // 滚动位置一起销毁(取证表现为「点返回行反复 element was detached」)。只就地改选中态。
    if (dmSwitch && dmSwitch.checked !== enabled) dmSwitch.checked = enabled;
    // 详情段展开着时，弹幕异步拉完(meta 到位)要自己刷新，不必用户关了再开。
    // 拿引用做门槛：否则每次 DOM 变动都会重排一遍详情行。
    if (dmSecDetail && dmDetailBody && dmDetailShown !== meta) renderDetailRows();
}

function setDanmakuEnabled(v: boolean): void {
    if (enabled === v) return;
    enabled = v;
    try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
    if (canvas) canvas.style.display = enabled ? 'block' : 'none';
    syncToggleUI();
    if (enabled) startRender();
    else stopRender();
}

/** [lc-1117] 拨「B站弹幕搜索」开关：持久化 + 当前集当场重试（失败标记会拦住重拉，先清掉）。
 * 只对 items 为空的集重试 —— 自建命中的集拨开关不该把已有弹幕拆掉。 */
function setBiliSearch(v: boolean): void {
    if (biliSearch === v) return;
    biliSearch = v;
    try { localStorage.setItem(LS_BILI_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    log.info('[danmakuWeb] B站弹幕搜索开关 → ' + v);
    if (currentGuid && !inflight && items.length === 0) {
        loadedGuids.delete(currentGuid);
        void prepareAndLoad(currentGuid);
    }
}

// ─── 数据拉取 ───

/** 高能进度条（danmakuHeat.ts）刻意不 import 本模块，靠这个事件拿弹幕时间轴。
 * 会话 LRU 命中时不走 IPC，所以两条加载路径都要发 —— 否则首集/切回来的那一集
 * 热力条恒不显示（旧版靠包 ipcRenderer.invoke 抓响应，正是漏在这两点上）。 */
const DANMAKU_ITEMS_EVENT = 'fntv:danmaku-items';
function announceItems(): void {
    if (!items.length) return;
    try {
        window.dispatchEvent(new CustomEvent(DANMAKU_ITEMS_EVENT, {
            detail: { times: items.map((d) => d.time) },
        }));
    } catch { /* ignore */ }
}

/**
 * [lc-1015] 拉取指定 guid 的弹幕并进入渲染。
 * @param targetGuid 显式 guid（来自 play/info 请求体预取）；省略时从当前 URL 解析。
 *
 * 时序说明：用户点播放 → fnOS POST /v/api/v1/play/info（body 含 item_guid）→
 * installPlayInfoObserver 立刻带着 guid 调进来，此时播放器 DOM 可能还没挂载——
 * 这正是目的：弹幕下载与视频加载并行，播放器就绪时弹幕往往已经就位。
 */
async function prepareAndLoad(targetGuid?: string | null): Promise<void> {
    const urlGuid = getGuid();
    const guid = targetGuid || urlGuid;
    if (!guid) return;

    if (guid !== currentGuid) {
        // URL 触发但 currentGuid 是更"新"的预取 guid（选集切换瞬间 URL 常仍是旧集/详情页）→ 以预取为准
        if (!targetGuid && currentGuid && currentGuidFromPrefetch && urlGuid !== currentGuid) {
            if (items.length && enabled) startRender();
            return;
        }
        currentGuid = guid;
        currentGuidFromPrefetch = !!targetGuid && guid !== urlGuid;
        items = [];
        meta = null;
        // [lc-1118] 换集后手动搜索状态跟着清：候选/错误/已选标记都不属于新的一集
        dmSearchResults = null;
        dmSearchErr = '';
        dmPickedBvid = '';
        resetRenderState();
        closePanel();
        inflight = false;
    } else if (items.length && enabled) {
        startRender();
        return;
    }
    // 单飞：同一 guid 只允许一个在途请求。OnReady/OnDomChange/预取可能几乎同时触发，
    // 没有此保护会导致同一集并发跑多个 run() → B站限流(分片重试 2s) → 整体被拖到 1 分钟。
    if (inflight) {
        log.info('[danmakuWeb] 已有弹幕请求在途，跳过重复拉取');
        return;
    }

    // [lc-1015] 会话内 LRU 命中：详情页预取过 / 切集切回来 → 直接用，不进 IPC
    const cached = guidCache.get(guid);
    if (cached && cached.items.length) {
        items = cached.items;
        meta = cached.meta;
        maxScreen = cached.maxScreen;
        loadedGuids.add(guid);
        renderDirty = true;
        announceItems();
        log.info('[danmakuWeb] 会话缓存命中 ' + items.length + ' 条 guid=' + guid);
        if (enabled) startRender();
        return;
    }
    // 之前确认过「无弹幕」的集不再重复请求
    if (loadedGuids.has(guid) && items.length === 0 && meta) {
        return;
    }

    inflight = true;
    loading = true;
    syncToggleUI();
    const myEpoch = dmClearEpoch;   // [lc-1307] 清除代际：响应回来时代际变了 = 中途点过清除 → 丢弃
    try {
        const res = await ipcRenderer.invoke('danmaku:prepare', { guid, biliSearch }) as any;
        // [lc-1015] 请求期间用户可能已切到别的集（currentGuid 变了）：旧响应直接丢弃，
        // 旧版会把上一集的弹幕回写进当前集。
        if (guid !== currentGuid || myEpoch !== dmClearEpoch) {
            log.info('[danmakuWeb] 丢弃过期弹幕响应(已切集或已清除) guid=' + guid);
            return;
        }
        if (res && res.ok && Array.isArray(res.items) && res.items.length) {
            items = ensureAscending(res.items as DanmakuItem[]);
            meta = res.meta as DanmakuMeta || {
                searchTitle: res.title || '', matchedTitle: res.title || '',
                source: res.source || '', ep: res.ep || 0, season: res.season || 0, isMovie: !!res.isMovie,
                count: res.count || items.length,
            };
            maxScreen = Number(res.maxScreen) > 0 ? Math.round(Number(res.maxScreen)) : 0;
            loadedGuids.add(guid);
            guidCachePut(guid, { items, meta, maxScreen });
            renderDirty = true;
            announceItems();
            log.info(`[danmakuWeb] 获取弹幕 ${items.length} 条 title="${res.title}" ep=${res.ep} movie=${res.isMovie}`);
            if (enabled) startRender();
        } else {
            meta = {
                searchTitle: res?.title || '', matchedTitle: res?.title || '',
                source: res?.source || '', ep: res?.ep ?? 0, season: res?.season || 0, isMovie: !!res?.isMovie,
                count: 0, error: res?.error || '空',
            };
            log.info('[danmakuWeb] 无弹幕: ' + (res?.error || '空'));
            loadedGuids.add(guid);
        }
    } catch (e) {
        log.error('[danmakuWeb] 获取弹幕失败:', e);
    } finally {
        inflight = false;
        loading = false;
        syncToggleUI();
    }
}

// ─── [lc-1015] 播放启动即预取：只读观察 play/info 请求 ───
// 旧时序要等 OnReady+1.5s / OnDomChange 防抖 0.8s、再等 video 元素和控制栏就绪才开拉
// （实测点播 → 开拉 ~4s，是网页端弹幕"慢"的主要来源之一）。用户点播放的瞬间 fnOS 必发
// POST /v/api/v1/play/info（body 含 item_guid），这里观察该请求立刻按 guid 预取，
// 弹幕下载与播放器加载并行。fetch/XHR 各包一层，只读透传、不改任何请求行为。
let _dmObserverInstalled = false;
function installPlayInfoObserver(): void {
    if (_dmObserverInstalled) return;
    _dmObserverInstalled = true;
    const PLAY_INFO_RE = /\/v\/api\/v1\/play\/info/i;
    const extractGuid = (raw: unknown): string | null => {
        try {
            const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const g = (body as any)?.item_guid ?? (body as any)?.data?.item_guid ?? (body as any)?.params?.item_guid;
            const m = typeof g === 'string' ? g.match(/[a-f0-9]{32}/i) : null;
            return m ? m[0] : null;
        } catch { return null; }
    };
    const onPlayInfo = (guid: string | null): void => {
        if (!guid) return;
        // 弹幕开关：预取发生播放器挂载前（模块级 enabled 还没同步过 localStorage），直接读存储
        try { if (localStorage.getItem(LS_KEY) === '0') return; } catch { /* ignore */ }
        if (guid === currentGuid && (inflight || items.length)) return; // 已在拉/已就位
        log.info('[danmakuWeb] play/info 预取弹幕 guid=' + guid);
        void prepareAndLoad(guid);
    };

    const origFetch = window.fetch;
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url || '';
        const isPlayInfo = PLAY_INFO_RE.test(url) && (init?.method || 'GET').toUpperCase() !== 'GET' && !!init?.body;
        if (!isPlayInfo) return origFetch.call(this, input, init);
        const guid = extractGuid(init!.body);
        const resp = await origFetch.call(this, input, init);
        // skipInject 在「外部播放器(MPV)」流程会把 play/info 伪造成 {success:true,data:null}
        // 阻止原生播放器启动——识别出这种响应就不预取（MPV 自己会拉弹幕）。
        // 真实 play/info 的 data 恒为对象；命中伪造特征时跳过预取。
        // ⚠️ 不能 await 这个克隆解析：那会把 play/info 响应扣在解析完成之后才还给 fnOS，
        // 等于把我们的嗅探塞进起播关键路径。预取本身是锦上添花，晚一点无所谓。
        try {
            const ct = resp.headers?.get?.('content-type') || '';
            if (ct.includes('json')) {
                resp.clone().json()
                    .then((j) => { if (!(j && j.success === true && j.data == null)) onPlayInfo(guid); })
                    .catch(() => onPlayInfo(guid));
            } else {
                onPlayInfo(guid);
            }
        } catch {
            onPlayInfo(guid);
        }
        return resp;
    } as typeof window.fetch;

    // XHR 侧兜底（fnOS 个别接口走 XHR）
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
        this._fntvDmUrl = String(url);
        this._fntvDmMethod = String(method || 'GET').toUpperCase();
        return origOpen.apply(this, [method, url, ...rest] as any);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: any, body?: any) {
        const url = this._fntvDmUrl || '';
        const method = this._fntvDmMethod || 'GET';
        if (PLAY_INFO_RE.test(url) && method !== 'GET' && body) {
            onPlayInfo(extractGuid(typeof body === 'string' ? body : null));
        }
        return origSend.call(this, body);
    } as typeof XMLHttpRequest.prototype.send;
}

// ─── Canvas 渲染引擎 ───
// 渲染核心照抄 npm `Danmaku` v2（dd-danmaku 内含的那份）验证过的四个机制：
//   · internal/allocate.js 的 willCollide —— 轨道按「会不会撞」释放，而非「整条播完才释放」
//   · internal/seek.js —— clear + 重置轨道 + 二分定位，seek 与样式热切换共用同一条路
//   · engine/canvas.js —— 每条弹幕离屏预渲染一次，逐帧只 drawImage
//   · utils.js:binsearch —— O(log n) 定位游标
// 运动模型不抄：它的 duration=stageW/speed 配合位移 (stageW+cmtW)*elapsed/duration，与本端
// 固定 scrollDuration 的 x = cw - p*(cw+w) 本质同构，改了没收益还会破坏「滚动时长」滑块语义。

/** items 必须按 time 升序：激活游标只前进、seek 用二分，两者都以升序为前提。
 * 主进程已排好（biliDanmaku.ts），这里只做 O(n) 校验，真乱序才排 —— preload 是按 basename
 * 热更新的，与主进程产物版本错开时这是最后一道保险。 */
function ensureAscending(arr: DanmakuItem[]): DanmakuItem[] {
    for (let i = 1; i < arr.length; i++) {
        if (arr[i].time < arr[i - 1].time) {
            log.info('[danmakuWeb] items 非升序（主进程产物可能偏旧）→ 渲染侧补排');
            arr.sort((a, b) => a.time - b.time);
            break;
        }
    }
    return arr;
}

/** 抄 utils.js:binsearch（含其 off-by-one 处理）：返回首条 time > key 的下标。 */
function binsearchTimes(arr: DanmakuItem[], key: number): number {
    let left = 0;
    let right = arr.length;
    while (left < right - 1) {
        const mid = (left + right) >> 1;
        if (key >= arr[mid].time) left = mid; else right = mid;
    }
    if (arr[left] && key < arr[left].time) return left;
    return right;
}

let ctxFont = '';
function applyFont(font: string): void {
    if (!ctx || ctxFont === font) return;
    ctx.font = font;
    ctxFont = font;
}

/** @returns 视频矩形是否可用（false = video 还没尺寸或选错了元素） */
// [v1.9.0] 全屏宿主迁移状态: canvas 常驻 body(fixed)。全屏时原生 fullscreen 元素进入
// top layer、xgplayer 伪全屏容器 z-index 极高——body 下的 canvas 无论 z-index 都会被视频
// 盖住(用户报障：全屏弹幕不显示)。解法=把 canvas 物理搬进全屏容器内(absolute 定位)。
let canvasHost: HTMLElement | null = null;   // null=在 body(fixed 模式)

/** 找弹幕 canvas 应该待的全屏容器: 原生 fullscreenElement 或 xgplayer 伪全屏根。 */
function fullscreenHost(): HTMLElement | null {
    const native = document.fullscreenElement as HTMLElement | null;
    if (native) return native;
    const pseudo = document.querySelector<HTMLElement>('.xgplayer.xgplayer-fullscreen');
    return pseudo;
}

/** 每次矩形同步前调用: 依全屏状态把 canvas 迁入/迁出全屏容器(状态变化才动 DOM)。 */
function ensureCanvasHost(): void {
    if (!canvas) return;
    const fs = fullscreenHost();
    if (fs) {
        // 容器被 SPA 重建(canvas 被甩出文档)时也要重新收养
        if (canvasHost !== fs || !fs.contains(canvas)) {
            if (!fs.contains(canvas)) fs.appendChild(canvas);
            canvas.style.position = 'absolute';
            canvas.style.zIndex = '20';   // 容器内: 高于视频, 低于控制栏
            canvasHost = fs;
        }
    } else {
        if (canvas.parentElement !== document.body) document.body.appendChild(canvas);
        canvas.style.position = 'fixed';
        canvas.style.zIndex = '5';
        canvasHost = null;
    }
}

function syncCanvasRect(): boolean {
    if (!canvas || !videoEl) return false;
    ensureCanvasHost();
    const r = videoEl.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        renderDirty = true; // [lc-1015] 画布重置后内容被清空，需立即重绘（暂停时也要）
        ctxFont = '';       // 改画布尺寸会清空 ctx 状态
        // 尺寸/dpr 变了 → 字号、行高、轨道数、以及所有已预渲染的位图全部作废
        appliedSignature = null;
    }
    canvas.style.left = r.left + 'px';
    canvas.style.top = r.top + 'px';
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 之后一律用 CSS 像素绘制
    return true;
}

// 矩形同步改为事件驱动 + RECT_SYNC_EVERY 帧兜底：旧版每帧 getBoundingClientRect()
// 就是每帧一次强制 layout，通常比文字栅格化还贵；兜底是给页面滚动/布局位移这类
// 不触发 resize 的变化用的。
function ensureRectObserver(): void {
    if (!videoEl || typeof ResizeObserver === 'undefined') return;
    if (!rectRO) {
        rectRO = new ResizeObserver(() => { needRectSync = true; renderDirty = true; });
        const bump = (): void => { needRectSync = true; renderDirty = true; };
        window.addEventListener('resize', bump, { passive: true });
        document.addEventListener('fullscreenchange', bump);
    }
    if (rectROTarget !== videoEl) {
        rectRO.disconnect();
        rectRO.observe(videoEl);
        rectROTarget = videoEl;
        needRectSync = true;
    }
}

/** 抄 internal/allocate.js:willCollide。
 * 旧版 allocLane 的条件是 t >= busy[i]，而 busy[i] = t0 + 整条滚动时长 —— 等于要求前一条
 * **完全播完 8 秒**才释放轨道：1080p 下 ~21 轨 ⇒ 吞吐仅 ≈2.6 条/秒，而自建源动辄 7~80 条/秒，
 * 多出来的全被 2s 宽限丢掉（排序修好后仍会丢约六成）。改成按「会不会撞」判定后，
 * 同样的轨道数吞吐高一个量级。 */
function slotCollides(s: LaneSlot, now: number, cw: number, newW: number, dur: number, fix: boolean): boolean {
    if (fix) return now - s.time < dur;                       // 固定弹幕：占满显示时长才算占着
    const slotTotal = cw + s.width;
    if (s.width > slotTotal * (now - s.time) / dur) return true;  // ① 前一条车尾还没完全进屏
    const slotLeftTime = dur + s.time - now;                  // 前一条车尾离开左边界还需多久
    const newArrivalTime = dur * cw / (cw + newW);              // 新条从右边界走到左边界需多久
    return slotLeftTime > newArrivalTime;                       // ② 新条更快 → 追尾
}

function allocLane(pool: Array<LaneSlot | null>, now: number, cw: number, w: number,
                   dur: number, fix: boolean): number {
    for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (!s || !slotCollides(s, now, cw, w, dur, fix)) {
            pool[i] = { time: now, width: w };
            return i;
        }
    }
    return -1;
}

function resetLanes(): void {
    laneScroll = new Array(laneCount).fill(null);
    laneTop = new Array(laneCount).fill(null);
    laneBottom = new Array(laneCount).fill(null);
}

/** @returns 轨道数是否发生了变化（变了就必须连同在屏弹幕一起重建） */
function ensureLanes(n: number): boolean {
    if (laneCount === n) return false;
    laneCount = n;
    resetLanes();
    return true;
}

/** 照抄 internal/seek.js：clear() + resetSpace() + 二分定位到当前时间。
 * seek 与样式热切换共用这一条路 —— 两者都让在屏弹幕的位图/轨道/滚动时长全部作废。
 * ⚠️ 不能改用 resetRenderState()：它把 cursor 归零，下一帧会从视频头把所有历史弹幕一次性
 * 激活，瞬间涌入一大屏（这正是「样式一改就叠字/瞬移」的成因之一）。 */
function relocateCursor(t: number): void {
    active.clear();   // 位图挂在 ActiveState 上，随之一起回收（生命周期绑定，无需另设缓存）
    resetLanes();
    recentTexts.clear();
    cursor = binsearchTimes(items, t);
    // 二分只给位置；去重窗口要补回 t 前 DUP_TEXT_SEC 内的样本（升序 → 紧邻 cursor 之前的若干条）
    for (let i = cursor - 1; i >= 0 && t - items[i].time <= DUP_TEXT_SEC; i--) {
        recentTexts.set(items[i].text, items[i].time);
    }
    renderDirty = true;
}

function resetRenderState(): void {
    active.clear();
    cursor = 0;
    recentTexts.clear();
    resetLanes();
    lastTime = -1;
    renderDirty = true;
    lastPausedDraw = false;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function startRender(): void {
    if (rafId || !enabled) return;
    const loop = () => {
        rafId = requestAnimationFrame(loop);
        render();
    };
    rafId = requestAnimationFrame(loop);
}

function stopRender(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    resetRenderState();
}

function currentFont(fontSize: number): string {
    return `${style.bold ? 'bold ' : ''}${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
}

/** 抄 engine/canvas.js:createCommentCanvas —— strokeText/fillText/shadowBlur 每条只付一次，
 * 逐帧退化成一次 drawImage。旧版每条活跃弹幕每帧都 strokeText+fillText，且 shadowBlur 对文字
 * 极贵：≤80 条 × 2 次栅格化 × 60fps。
 * 库自己在 remove()/clear() 里把 cmt.canvas 置 null，注释明写「avoid caching canvas to reduce
 * memory usage」—— 本端把位图挂在 ActiveState 上，出 active 即随之回收，效果等价，还不用处理
 * 「同文本不同颜色/描边」的缓存键歧义。 */
function createCommentBitmap(text: string, color: string, fontSize: number, textW: number,
                             out: { bw: number; bh: number; pad: number }): HTMLCanvasElement {
    const sw = style.outline > 0 ? Math.max(1, fontSize * 0.04 * style.outline) : 0;
    const blur = style.shadow > 0 ? fontSize * 0.06 * style.shadow : 0;
    // 四周内边距：容下描边与阴影，再留一点字形上下溢出（textBaseline='top' 下 CJK 会略微越界）
    const pad = Math.ceil(sw + blur + fontSize * 0.28);
    const bw = textW + pad * 2;
    const bh = Math.ceil(fontSize * 1.3) + pad * 2;
    const dpr = window.devicePixelRatio || 1;
    const cvs = document.createElement('canvas');
    // 位图按设备像素建、内部再 scale(dpr) —— 与舞台 ctx 同口径，回贴时传 CSS 像素即可
    cvs.width = Math.max(1, Math.round(bw * dpr));
    cvs.height = Math.max(1, Math.round(bh * dpr));
    const c = cvs.getContext('2d');
    if (c) {
        c.scale(dpr, dpr);
        c.font = currentFont(fontSize);
        c.textBaseline = 'top';
        if (blur > 0) { c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = blur; }
        if (sw > 0) {
            c.lineJoin = 'round';
            c.lineWidth = sw;
            c.strokeStyle = 'rgba(0,0,0,0.95)';
            c.strokeText(text, pad, pad);
        }
        c.fillStyle = color;
        c.fillText(text, pad, pad);
    }
    out.bw = bw; out.bh = bh; out.pad = pad;
    return cvs;
}

function render(): void {
    if (!ctx || !canvas || !enabled) return;

    // 视频元素失效则重新选取（isConnected 不触发 layout；旧版每帧 getBoundingClientRect）
    if (!videoEl || !videoEl.isConnected) videoEl = pickVideo();
    if (!videoEl) return;
    ensureRectObserver();
    if (needRectSync || ++rectTicks >= RECT_SYNC_EVERY) {
        rectTicks = 0;
        needRectSync = false;
        // 矩形不可用（video 尚无尺寸/选错了元素）→ 重挑一次，等下一轮兜底再试
        if (!syncCanvasRect()) { videoEl = pickVideo(); return; }
    }

    const dprNow = window.devicePixelRatio || 1;
    const cw = canvas.width / dprNow;
    const ch = canvas.height / dprNow;
    const t = videoEl.currentTime;
    const fixDuration = Math.max(3, style.scrollDuration * 0.6);

    // [lc-1015] 暂停跳帧：进度/尺寸/样式都没变时画面是静止的，跳过 clear+draw。
    if (t !== lastTime) renderDirty = true;
    const paused = videoEl.paused;
    if (paused && lastPausedDraw && !renderDirty) return;
    lastPausedDraw = paused;
    renderDirty = false;

    // [lc-1015] 行高跟随实际字号（旧版固定 ch*0.034，调大字号后相邻行会互相压字）
    // [v1.4.0] 手机网页：竖屏 video 高度小，ch*0.036 只有 ~12-14px 且被 max(14,…)
    // 兜底顶到 14px，观感过小；coarse 窄屏下字号/行高下限放宽为 16px（横屏/桌面不变）。
    const smallScreen = isTouchEnv() && Math.min(window.innerWidth, window.innerHeight) <= 640;
    const fontSizeFloor = smallScreen ? 16 : 14;
    // [lc-1313] 自动缩放：按滚动轨道占用率平滑缩字号。弹幕密集时把字号压到最低 60%，
    //   让更多弹幕进屏不叠字；占用率回落到 40% 以下恢复设定值。hysteresis 防抖：
    //   压缩/恢复用不同阈值，避免在临界密度上字号来回跳。平滑跟随（每帧向目标靠拢 15%）
    //   而非阶跃 —— 阶跃会在密集段进出的瞬间肉眼可见地整体跳一下。
    let autoK = 1;
    if (style.autoScale) {
        const scrollLanes = laneScroll.length;
        const busy = scrollLanes > 0
            ? laneScroll.reduce<number>((s, l) => s + (l && l.until > t ? 1 : 0), 0)
            : 0;
        const occ = busy / Math.max(1, scrollLanes);
        // 目标系数：占用率 40% 以下 = 1（原字号），40%~100% 线性压到 0.6
        const target = occ <= 0.4 ? 1 : Math.max(0.6, 1 - (occ - 0.4) * (0.4 / 0.6));
        autoScaleK = autoScaleK < 0 ? target : autoScaleK + (target - autoScaleK) * 0.15;
        autoK = autoScaleK;
    } else if (autoScaleK >= 0) {
        autoScaleK = -1; // 复位，下次开启时直接取目标值不闪跳
    }
    const fontSize = Math.max(fontSizeFloor, Math.min(48, ch * style.fontScale * autoK));
    const laneH = Math.max(smallScreen ? 24 : 20, ch * LANE_RATIO, fontSize * 1.08);
    const usableH = ch * style.displayArea;
    const n = Math.max(6, Math.floor(usableH / laneH));

    // ── 何时整体重建（seek / 样式变化 / 轨道数变化）──
    let needRelocate = false;
    if (lastTime >= 0 && (t < lastTime - 0.5 || t > lastTime + 1.5)) {
        // 任意方向 seek。旧版前向分支是**无上限**的线性 while，一次拖到片尾要在单帧里推进
        // 十几万次游标 + Set 写入，主线程硬冻结；二分后 O(log n)。
        needRelocate = true;
    } else if (!styleSettling) {
        const sig = styleSignature();
        if (appliedSignature === null) appliedSignature = sig;
        else if (sig !== appliedSignature) { appliedSignature = sig; needRelocate = true; }
    }
    // 轨道数变了必须连同在屏弹幕一起清：旧版只把 busy 数组重置成「全空闲」，active 里仍占着
    // 轨道的弹幕一条没清 → 新弹幕被分到同一条「以为空闲」的轨道，直接叠字。
    // 拖动滑块期间冻结轨道数：否则 n 每跨一个阈值就整体重建一次，debounce 白做（观感=一路闪）；
    // 停手后由上面的签名变化触发**一次**重建。
    if (!styleSettling && ensureLanes(n)) needRelocate = true;

    if (needRelocate) relocateCursor(t);
    lastTime = t;

    ctx.clearRect(0, 0, cw, ch);

    const cap = maxScreen > 0 ? Math.min(maxScreen, MAX_ACTIVE_HARD_CAP) : MAX_ACTIVE_HARD_CAP;
    if (recentTexts.size > RECENT_TEXTS_MAX) recentTexts.clear();
    const font = currentFont(fontSize);
    applyFont(font);

    // ① 激活到点的弹幕：游标只前进（items 按时间升序），轨道满则在宽限期内等待，
    //    超宽限或同文本短窗重复即丢弃，不再像旧版每帧从头全量扫描。
    while (cursor < items.length && items[cursor].time <= t) {
        const i = cursor;
        const d = items[i];
        const lastT = recentTexts.get(d.text);
        if (lastT !== undefined && Math.abs(d.time - lastT) <= DUP_TEXT_SEC) {
            cursor++;
            continue;
        }
        if (active.size >= cap) break;
        const isBottom = d.type === 4;
        const isFix = isBottom || d.type === 5;
        const dur = isFix ? fixDuration : style.scrollDuration;
        // 先量宽再分配轨道：碰撞判定要宽度，而旧版是先分配后 measureText，量出来的宽度
        // 对本帧的分配毫无用处。位图留到确认拿到轨道之后再建，避免高峰期白做栅格化。
        const w = Math.max(1, Math.ceil(ctx.measureText(d.text).width));
        const lane = allocLane(isBottom ? laneBottom : (isFix ? laneTop : laneScroll), t, cw, w, dur, isFix);
        if (lane >= 0) {
            const dim = { bw: 0, bh: 0, pad: 0 };
            const color = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
            const cvs = createCommentBitmap(d.text, color, fontSize, w, dim);
            active.set(i, { appear: t, lane, w, fix: isFix, cvs, bw: dim.bw, bh: dim.bh, pad: dim.pad });
            recentTexts.set(d.text, d.time);
            cursor++;
        } else if (t - d.time > LANE_GRACE_SEC) {
            cursor++; // 宽限期内拿不到轨道 → 丢弃，避免迟到弹幕成堆涌入
        } else {
            break;    // 刚到点，等下一帧再试（FIFO，不越过）
        }
    }

    // ② 绘制活跃弹幕：只剩 drawImage（滚动行从顶部数起；顶部固定行从顶数、底部固定行锚底）
    for (const [i, st] of active) {
        const d = items[i];
        const dur = st.fix ? fixDuration : style.scrollDuration;
        const elapsed = t - st.appear;
        if (elapsed >= dur || elapsed < 0) {
            active.delete(i);   // 播完 → 释放（位图随 ActiveState 一起回收）
            continue;
        }
        let x: number;
        let y: number;
        let alpha = style.opacity;
        if (st.fix) {
            // [lc-1015] 底部弹幕(type=4)锚定画面底部（旧版被画在顶部）；顶部(type=5)从顶数
            y = (d.type === 5)
                ? 6 + st.lane * laneH
                : ch - 6 - (st.lane + 1) * laneH;
            x = (cw - st.w) / 2;
            if (elapsed < 0.2) alpha = (elapsed / 0.2) * style.opacity;
            else if (elapsed > dur - 0.3) alpha = Math.max(0, (dur - elapsed) / 0.3) * style.opacity;
        } else {
            x = cw - (elapsed / dur) * (cw + st.w);
            y = 6 + st.lane * laneH;
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        // 舞台 ctx 已 setTransform(dpr,...)，这里必须传 CSS 像素的宽高。库里写的是
        // drawImage(cvs, x*dpr, y*dpr) —— 它的舞台不做 dpr 变换；照抄会得到 2 倍大或糊掉的弹幕。
        ctx.drawImage(st.cvs, x - st.pad, y - st.pad, st.bw, st.bh);
    }
    ctx.globalAlpha = 1;
}

// ─── 弹幕详情弹窗（展示"弹幕是从哪来的"，与 MPV 一致）───

function sourceLabel(s: string): string {
    if (s === 'bangumi') return '番剧区（B站正版）';
    if (s === 'video') return '视频区（UP主搬运）';
    // [v1.11.0] 三源明细的 key 形态（meta.sources[].key）
    if (s === 'bilibili') return 'B站弹幕';
    if (s === 'dandanplay') return '弹弹play';
    if (s === 'danmu_api') return '自建弹幕接口（danmu_api）';
    // 兼容后端下发的展示名（meta.source / sources[].label）
    if (s === '弹弹play') return '弹弹play（多平台整合）';
    if (s === '自建源(danmu_api)') return '自建弹幕接口（danmu_api）';
    if (s === 'B站') return 'B站弹幕';
    return s || '未知';
}

// Cookie 登录态 → 详情弹窗展示文案（非有效时 warn=true，弹窗会标红横幅）
function cookieStatusInfo(s: string): { text: string; warn: boolean; detail: string } {
    if (s === 'valid') return { text: '已登录（Cookie 有效）', warn: false, detail: '' };
    if (s === 'expired') return {
        text: 'Cookie 已过期 / 无效',
        warn: true,
        detail: 'B站 登录态已失效，弹幕数量受限（候选更少、seg.so 可能被风控掐掉）。请从浏览器重新复制 SESSDATA 填回 bili_cookie.txt 后重启。',
    };
    if (s === 'missing') return {
        text: '未登录（无 Cookie 文件）',
        warn: true,
        detail: '未配置 bili_cookie.txt，弹幕数量受限。请把浏览器 B站 登录态 Cookie（SESSDATA 等）整行填入该文件后重启。',
    };
    return { text: '—', warn: false, detail: '' };
}

// ─── 关闭策略：ESC / 点击面板外 ───
// 没有遮罩层，所以靠捕获阶段的 document 监听判定「点在外面」——xgplayer 会在冒泡阶段
// stopPropagation 吞掉视频区点击，只有捕获阶段拦得到。仅在有面板打开时才挂监听。
let _dismissBound = false;

function anyPanelOpen(): boolean {
    return !!dmList?.classList.contains('active');
}

function onDismissClick(e: MouseEvent): void {
    const tgt = e.target as Node | null;
    if (tgt && dmBtnWrap?.contains(tgt)) return;   // 按钮与弹窗都在 wrap 里，各自负责开合
    closePanel();
}

/** [v1.4.0] 触屏 dismiss：手机浏览器 tap 会派发合成 click（部分引擎在 touchend 后 300ms），
 *  capture 级 click 监听在个别 WebView 上先于按钮自身的 click 触发 → 面板刚点开就被判
 *  「点了外面」关掉。补 touchstart 捕获监听兜底关闭；wrap 内的触摸在函数头部豁免。 */
function onDismissTouch(e: TouchEvent): void {
    const tgt = e.target as Node | null;
    if (tgt && dmBtnWrap?.contains(tgt)) return;
    closePanel();
}

function onDismissKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    closePanel();
}

function refreshDismissBinding(): void {
    const need = anyPanelOpen();
    if (need === _dismissBound) return;
    _dismissBound = need;
    if (need) {
        document.addEventListener('click', onDismissClick, true);
        document.addEventListener('keydown', onDismissKeydown, true);
        if (isTouchEnv()) document.addEventListener('touchstart', onDismissTouch, true);
    } else {
        document.removeEventListener('click', onDismissClick, true);
        document.removeEventListener('keydown', onDismissKeydown, true);
        document.removeEventListener('touchstart', onDismissTouch, true);
    }
}

// ─── [lc-1118] 手动搜索段 ───

/** [v1.2.8] invoke 超时包装：超时抛错（调用方复位 busy 并提示），不再让一次挂起的请求永久锁死搜索。
 *  注意超时只是前端放弃等待，后端请求仍在跑、结果仍可能落缓存——稍后重试通常直接命中。 */
function invokeWithTimeout(channel: string, args: any, ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => reject(new Error('请求超时(' + Math.round(ms / 1000) + 's)')), ms);
        ipcRenderer.invoke(channel, args).then(
            (r: any) => { clearTimeout(timer); resolve(r); },
            (e: any) => { clearTimeout(timer); reject(e); },
        );
    });
}

function renderSearchBody(): void {
    const body = dmSearchBody;
    if (!body) return;
    body.innerHTML = '';
    const msg = (text: string, err = false): void => {
        const m = document.createElement('div');
        m.className = 'fntv-dm-search-msg' + (err ? ' fntv-dm-search-err' : '');
        m.textContent = text;
        body.appendChild(m);
    };

    const row = document.createElement('div');
    row.className = 'fntv-dm-search-row';
    // class 含 "search" 会被 glassUI 组件级磨砂([class*="search"]) !important 命中，
    // 走它自带的 :not([data-fntv-glass-exclude]) 豁免通道排除，别事后 !important 对抗
    const glassExempt = (el: HTMLElement): void => { el.setAttribute('data-fntv-glass-exclude', '1'); };
    const inp = document.createElement('input');
    inp.className = 'fntv-dm-search-in';
    glassExempt(inp);
    inp.value = dmSearchKw;
    inp.placeholder = t('番名或关键词');
    inp.addEventListener('input', () => { dmSearchKw = inp.value; });
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') void runSearch(dmSearchKw);
    });
    const btn = document.createElement('button');
    btn.className = 'fntv-dm-search-btn';
    glassExempt(btn);
    btn.textContent = t('搜索');
    btn.disabled = dmSearchBusy;
    btn.addEventListener('click', (e) => { e.stopPropagation(); void runSearch(dmSearchKw); });
    glassExempt(row);
    row.appendChild(inp);
    row.appendChild(btn);
    body.appendChild(row);

    if (dmSearchBusy) { msg(t('正在搜索…')); return; }
    if (dmSearchErr) { msg(dmSearchErr, true); return; }
    if (dmSearchResults === null) { msg(t('展开后自动按当前番名搜索，也可改关键词重搜')); return; }
    if (!dmSearchResults.length) { msg(t('没有可用的搜索结果')); return; }
    for (const c of dmSearchResults) {
        const item = document.createElement('div');
        item.className = 'fntv-dm-cand' + (c.bvid === dmPickedBvid ? ' on' : '');
        const tEl = document.createElement('div');
        tEl.className = 'fntv-dm-cand-t';
        tEl.textContent = (c.bvid === dmPickedBvid ? '✓ ' : '') + c.title;
        const sEl = document.createElement('div');
        sEl.className = 'fntv-dm-cand-s';
        sEl.textContent = sourceLabel(c.source) + (c.isCompilation ? ' ⚠️合集' : '') + (c.bvid === dmPickedBvid ? t('（使用中）') : '');
        item.appendChild(tEl);
        item.appendChild(sEl);
        item.addEventListener('click', (e) => { e.stopPropagation(); void pickCandidate(c); });
        body.appendChild(item);
    }
}

/** 搜候选：danmu_api 优选 → 未命中降级内置 B站；主进程只回可直接拉取的（bvid 非空）前 5 条。 */
async function runSearch(kw: string): Promise<void> {
    kw = String(kw || '').trim();
    if (!kw) { dmSearchErr = t('请输入搜索关键词'); renderSearchBody(); return; }
    if (dmSearchBusy) return;
    dmSearchBusy = true;
    dmSearchKw = kw;
    dmSearchErr = '';
    renderSearchBody();
    try {
        // [v1.2.8] 超时保护：invoke 链路（fetch→Go→B站/自建源多跳）在网络劣化时可能挂很久，
        // 无超时则 dmSearchBusy 永久为 true → 之后所有搜索点击被 if(dmSearchBusy) 静默吞掉，
        // 表现为「搜索无反应」，刷新页面才恢复（用户实机踩过）。60s 覆盖后端最坏链路的大多数情形。
        const res = await invokeWithTimeout('danmaku:candidates', {
            title: kw, ep: meta ? meta.ep : 0, season: meta ? meta.season : 0,
        }, 60_000) as any;
        if (res && res.ok && Array.isArray(res.candidates)) {
            dmSearchResults = res.candidates;
        } else {
            dmSearchResults = [];
            dmSearchErr = (res && res.error) || t('没有可用的搜索结果');
        }
    } catch (e: any) {
        dmSearchResults = [];
        const msg = String(e?.message || e);
        dmSearchErr = msg.indexOf('超时') >= 0 ? t('搜索请求超时，请稍后重试或刷新页面') : t('搜索异常') + ': ' + msg;
    } finally {
        dmSearchBusy = false;
        renderSearchBody();
    }
}

/** 选定候选：直接拉该条目弹幕并就地换上（主进程落磁盘缓存，下次自动加载命中记住的选择）。 */
async function pickCandidate(c: any): Promise<void> {
    if (dmSearchBusy || !c?.bvid) return;
    dmSearchBusy = true;
    dmSearchErr = '';
    renderSearchBody();
    try {
        // [v1.2.8] 同 runSearch 的超时保护；拉整份弹幕（自建源单集可 >10 万条）给 120s
        const res = await invokeWithTimeout('danmaku:pick', {
            title: dmSearchKw || (meta ? meta.searchTitle : ''), ep: meta ? meta.ep : 0,
            season: meta ? meta.season : 0, isMovie: meta ? meta.isMovie : false, bvid: c.bvid,
        }, 120_000) as any;
        if (res && res.ok && Array.isArray(res.items) && res.items.length && currentGuid) {
            items = ensureAscending(res.items as DanmakuItem[]);
            meta = (res.meta as DanmakuMeta) || meta;
            if (Number(res.maxScreen) > 0) maxScreen = Math.round(Number(res.maxScreen));
            dmPickedBvid = String(c.bvid);
            loadedGuids.add(currentGuid);
            guidCachePut(currentGuid, { items, meta, maxScreen });
            renderDirty = true;
            dmDetailShown = undefined;
            renderDetailRows();   // 无条件重填：详情段收起时也要就地换成新值，展开才能看到
            announceItems();
            if (enabled) startRender();
            log.info('[danmakuWeb] 手动选定弹幕: ' + items.length + ' 条 bvid=' + c.bvid);
        } else {
            const err = (res && res.error) || t('选定失败');
            if (meta) meta.error = err;   // 让「来源详情→备注」同步显示失败原因
            dmSearchErr = err;
        }
    } catch (e: any) {
        dmSearchErr = t('选定失败') + ': ' + (e?.message || e);
    } finally {
        dmSearchBusy = false;
        renderSearchBody();
        syncToggleUI();
    }
}

/** 详情段内容：往折叠体里就地重填。meta 是异步到的，展开着拉完也要能自己更新。 */
/** [lc-1307] 「清除弹幕」：自动匹配错了时清掉当前剧的全部匹配记忆（桌面版 lc-1300 同语义）。
 *  ① 后端（Go bridge /danmaku/clear）：遍历 danmaku-cache 目录读缓存 meta 的
 *     searchTitle/matchedTitle 匹配删除 —— 错误结果已按剧缓存，只清单集没用；
 *     fpk 无独立源锁定文件（源选择存在缓存 meta 里），清缓存即等于锁也清了。
 *  ② 本地：清内存展示与会话 LRU。loadedGuids 保留（拦住 OnDomChange/maybeSetup 的自动
 *     重拉，否则几秒内错误匹配原样回来）；重新拿弹幕走「手动搜索」选定条目（pick 不受
 *     影响），或重开「B站弹幕搜索」开关触发一次全新自动匹配。
 *  ③ 代际作废：dmClearEpoch++ 让在途 prepare 响应回来即丢弃，别把刚清空的匹配又写回。 */
async function clearDanmakuMatch(row: HTMLLIElement): Promise<void> {
    if (dmClearBusy) return;
    dmClearBusy = true;
    dmClearEpoch++;
    try {
        const title = meta ? String(meta.searchTitle || '') : '';
        if (title) {
            try { await ipcRenderer.invoke('danmaku:clear', { title }); } catch { /* 后端清不掉时本地照清 */ }
        }
        setItems([]);
        if (meta) {
            meta = {
                ...meta, matchedTitle: '', source: '', bvid: null, cid: null,
                aggregatedFrom: undefined, count: 0,
                error: t('已手动清除（自动匹配记忆已重置；用「手动搜索」重新选定，或重开弹幕开关重跑自动匹配）'),
            };
        }
        if (currentGuid) {
            guidCache.delete(currentGuid);
            loadedGuids.add(currentGuid);
        }
        dmSearchResults = null;
        dmSearchErr = '';
        dmPickedBvid = '';
        renderSearchBody();   // 手动搜索段正展开着 → 旧候选列表立即刷新（清除后不复选旧条目）
        resetRenderState();
        // 高能条（danmakuHeat）同清：空时间轴事件即清屏信号（见 danmakuHeat.ingest）
        try {
            window.dispatchEvent(new CustomEvent(DANMAKU_ITEMS_EVENT, { detail: { times: [] } }));
        } catch { /* ignore */ }
        renderDetailRows();   // 详情段就地重填（收着也没关系，展开即见清除结论）
        syncToggleUI();
        row.textContent = t('已清除 ✓');
        row.classList.add('fntv-dm-clear-done');
        setTimeout(() => {
            row.textContent = t('清除弹幕');
            row.classList.remove('fntv-dm-clear-done');
        }, 2200);
        log.info('[danmakuWeb] 已清除弹幕（内存展示 + 磁盘缓存）');
    } finally {
        dmClearBusy = false;
    }
}

function renderDetailRows(): void {
    const body = dmDetailBody;
    if (!body) return;
    dmDetailShown = meta;
    body.innerHTML = '';

    if (!meta) {
        const wait = document.createElement('div');
        wait.className = 'fntv-dm-wait';
        wait.textContent = t('弹幕加载中…');
        body.appendChild(wait);
        return;
    }

    // [v1.11.0] 详情分两块：① 本次播放（搜的什么、最终用哪个源、共多少条）
    //                      ② 三个弹幕源各自的匹配详情（自建源 → 弹弹play → B站，含未参与的原因）
    // 字段按来源分流：BVID/CID/匹配相似度/登录状态都是 B站 链路专属，
    // 优选源（自建 danmu_api / 弹弹play）命中时这些字段恒为空 → 只在对应源块里展示。
    const srcName = String(meta.source || '');
    const isPreferred = /^自建源/.test(srcName) || srcName === '弹弹play';
    const cookie = cookieStatusInfo(meta.cookieStatus || '');

    // ① 本次播放概览
    const rows: [string, string][] = [
        ['搜索番名', meta.searchTitle || '—'],
        ['最终来源', sourceLabel(meta.source)],
        ['实际匹配', meta.matchedTitle || '—'],
        ['集数', meta.isMovie ? '电影（按番名搜最优集）' : `第 ${meta.ep} 集`],
        ['目标季数', meta.season > 0 ? `第 ${meta.season} 季（优先精确匹配）` : '未指定（仅按番名+集数）'],
        ['弹幕条数', String(meta.count)],
    ];
    if (meta.error) rows.push(['备注', meta.error]);

    // 非有效登录态且最终用的是 B站：醒目红色横幅提示（优选源与 Cookie 无关，不误报）
    if (!isPreferred && cookie.warn) {
        const banner = document.createElement('div');
        banner.textContent = '⚠️ ' + cookie.detail;
        Object.assign(banner.style, {
            margin: '2px 0 10px', padding: '8px 10px', borderRadius: '6px',
            background: 'rgba(255,76,76,0.12)', border: '1px solid rgba(255,76,76,0.45)',
            color: '#ff8a8a', fontSize: '12px', lineHeight: '1.5',
        } as CSSStyleDeclaration);
        body.appendChild(banner);
    }

    // 概览行渲染（sources 区块共用同一套 dl 样式）
    const appendRows = (parent: HTMLElement, list: [string, string][], keyCol: boolean): void => {
        const dl = document.createElement('dl');
        dl.className = 'fntv-dm-rows';
        for (const [k, v] of list) {
            const row = document.createElement('div');
            row.className = 'fntv-dm-row';
            const kEl = document.createElement('dt');
            kEl.textContent = k;
            const vEl = document.createElement('dd');
            vEl.textContent = v;
            if (k === '登录状态') {
                vEl.style.color = cookie.warn ? '#ff6b6b' : '#5ad17a';
                vEl.style.fontWeight = '600';
            }
            if (keyCol && k === '状态') {
                vEl.style.fontWeight = '600';
            }
            row.appendChild(kEl);
            row.appendChild(vEl);
            dl.appendChild(row);
        }
        parent.appendChild(dl);
    };

    appendRows(body, rows, false);

    // ② 三源明细：每个源一张小卡（标题行 = 序号+名字+状态徽标，下面是该源的匹配字段）
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    if (sources.length) {
        const title = document.createElement('div');
        title.textContent = '弹幕源详情';
        Object.assign(title.style, {
            marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.06)',
            fontSize: '12px', fontWeight: '600', color: 'rgba(245,245,247,.75)',
        } as CSSStyleDeclaration);
        body.appendChild(title);

        sources.forEach((s, idx) => {
            const card = document.createElement('div');
            Object.assign(card.style, {
                margin: '8px 0 0', padding: '8px 10px', borderRadius: '8px',
                background: s.used ? 'rgba(90,209,122,.10)' : 'rgba(255,255,255,.035)',
                border: '1px solid ' + (s.used ? 'rgba(90,209,122,.42)' : 'rgba(255,255,255,.08)'),
            } as CSSStyleDeclaration);

            // 标题行：① 自建源(danmu_api)   [使用中 / 未启用 / 已关闭]
            const head = document.createElement('div');
            Object.assign(head.style, {
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '12.5px', fontWeight: '600', marginBottom: '6px',
                color: s.used ? '#5ad17a' : 'rgba(245,245,247,.8)',
            } as CSSStyleDeclaration);
            const headName = document.createElement('span');
            headName.textContent = `${idx + 1}. ${sourceLabel(s.label || s.key)}`;
            head.appendChild(headName);
            const badge = document.createElement('span');
            // 徽标只给「短状态词」，具体原因交给下面的字段行/未采用原因行 ——
            // 否则「未启用」会在徽标和行里各出现一次（实测重复）。
            badge.textContent = s.used ? '使用中' : !s.enabled ? '未参与' : s.note ? '未采用' : '未参与';
            Object.assign(badge.style, {
                marginLeft: 'auto', padding: '1px 7px', borderRadius: '9px', fontSize: '10.5px', fontWeight: '500',
                background: s.used ? 'rgba(90,209,122,.18)' : 'rgba(255,255,255,.07)',
                color: s.used ? '#5ad17a' : 'rgba(245,245,247,.55)',
            } as CSSStyleDeclaration);
            head.appendChild(badge);
            card.appendChild(head);

            // 字段行：按源类型给该源专属字段（不适用的一律不列，避免一排「—」）
            const sRows: [string, string][] = [];
            if (s.matchedTitle) sRows.push(['命中条目', s.matchedTitle]);
            if (s.episodeTitle) sRows.push(['命中分集', s.episodeTitle]);
            if (s.episodeId) sRows.push(['集 ID', String(s.episodeId)]);
            if (s.bvid) sRows.push(['BVID', String(s.bvid)]);
            if (s.cid) sRows.push(['CID', String(s.cid)]);
            if (s.sim != null) sRows.push(['匹配相似度', (Number(s.sim) * 100).toFixed(0) + '%']);
            if (s.credential) sRows.push([s.key === 'bilibili' ? '登录状态' : '使用凭证', s.credential]);
            if (s.base) sRows.push(['服务地址', s.base]);
            // 条数只在源真的跑过时给（未参与的源显示「0 条」是误导）
            if (s.enabled && s.rawCount > 0) {
                sRows.push(['弹幕条数', `${s.count}${s.blocked > 0 ? `（拉取 ${s.rawCount}，屏蔽 ${s.blocked}）` : ''}`]);
            }
            // 未参与（开关关/未配置）：原因直接作为状态行；跑过但没采用：单列原因
            if (!s.enabled) {
                if (s.note) sRows.push(['状态', s.note]);
            } else if (!s.used && s.note) {
                sRows.push(['未采用原因', s.note]);
            }
            if (sRows.length) appendRows(card, sRows, false);
            body.appendChild(card);
        });
    }

    const tip = document.createElement('div');
    // 底部说明必须跟着实际来源走：优选源命中时写「数据来源：B站」是错信息（用户正是看着这句报的匹配 bug）。
    // srcName 在本函数开头已按来源解析（见字段分流处）。
    // [v1.11.1] 源链改为 自建源 → B站 → 弹弹play（兜底），说明需讲清各自的条件。
    if (/^自建源/.test(srcName)) {
        tip.textContent = '数据来源：自建弹幕接口 danmu_api（只认精确匹配；弹幕低于下限时继续找 B站/弹弹play 补源）';
    } else if (srcName === '弹弹play') {
        tip.textContent = '数据来源：弹弹play 官方开放 API（兜底源：自建源与 B站 都没拿到足量弹幕时才请求，以节省额度；含多平台整合弹幕）';
    } else {
        tip.textContent = '数据来源：B站弹幕（与自建源同为免费链路，优先于弹弹play 兜底源）';
    }
    Object.assign(tip.style, {
        paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.06)',
        color: 'rgba(245,245,247,.4)', fontSize: '12px', lineHeight: '1.5',
    } as CSSStyleDeclaration);
    body.appendChild(tip);
}

// ─── 弹幕样式旋钮（对齐 MPV 弹幕样式 7 项：粗体/字号/描边/阴影/滚动时长/透明度/显示范围）───
// [lc-1110] 渲染进控制栏「弹幕」按钮的 hover 弹窗，与开关两行同处一个面板。

function makeSlider(label: string, min: number, max: number, step: number, value: number,
                    fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexDirection: 'column' } as CSSStyleDeclaration);
    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } as CSSStyleDeclaration);
    const lab = document.createElement('span');
    lab.textContent = label;
    lab.style.color = 'rgba(245,245,247,.78)';
    const val = document.createElement('span');
    val.style.color = 'rgba(245,245,247,.5)';
    val.textContent = fmt(value);
    top.appendChild(lab);
    top.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    Object.assign(input.style, { width: '100%' } as CSSStyleDeclaration);
    // 轨道已填充比例画在 background 上（见 .fntv-dm-list input[type=range] 的注释）
    const paint = () => {
        const pct = Math.max(0, Math.min(100, ((parseFloat(input.value) - min) / (max - min)) * 100));
        input.style.background =
            `linear-gradient(to right, ${BRAND_ACCENT} 0 ${pct}%, rgba(255,255,255,.18) ${pct}% 100%)`;
    };
    paint();
    input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = fmt(v);
        paint();
        onInput(v);
    });
    row.appendChild(top);
    row.appendChild(input);
    return row;
}

function makeToggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' } as CSSStyleDeclaration);
    const lab = document.createElement('span');
    lab.textContent = label;
    lab.style.color = 'rgba(245,245,247,.78)';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(lab);
    row.appendChild(input);
    return row;
}

function buildStyleControls(): HTMLElement {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '14px' } as CSSStyleDeclaration);

    wrap.appendChild(makeToggle(t('粗体'), style.bold, (v) => { style.bold = v; saveStyle(); }));

    // [lc-1313] 自动缩放开关：弹幕密集时按滚动轨道占用率把字号平滑压到最低 60%，
    //   稀疏时回到滑块设定值。放字号滑块正上方 —— 两者共同决定最终字号，语义相邻。
    wrap.appendChild(makeToggle(t('自动缩放（密集时缩小）'), style.autoScale, (v) => { style.autoScale = v; saveStyle(); }));

    // 字号：以默认 fontScale 为 100% 的相对倍数（50%~180%）
    const baseScale = DEFAULT_STYLE.fontScale;
    wrap.appendChild(makeSlider(t('字号'), 50, 180, 1, Math.round(style.fontScale / baseScale * 100),
        (v) => v + '%', (v) => { style.fontScale = baseScale * (v / 100); saveStyle(); }));

    wrap.appendChild(makeSlider(t('描边'), 0, 3, 0.1, style.outline,
        (v) => v.toFixed(1), (v) => { style.outline = v; saveStyle(); }));

    wrap.appendChild(makeSlider(t('阴影'), 0, 3, 0.1, style.shadow,
        (v) => v.toFixed(1), (v) => { style.shadow = v; saveStyle(); }));

    // 滚动时长（秒）：值越大弹幕越慢，对应 MPV scrolltime
    wrap.appendChild(makeSlider(t('滚动时长（越大越慢）'), 4, 16, 0.5, style.scrollDuration,
        (v) => v.toFixed(1) + 's', (v) => { style.scrollDuration = v; saveStyle(); }));

    wrap.appendChild(makeSlider(t('透明度'), 0.3, 1, 0.05, style.opacity,
        (v) => Math.round(v * 100) + '%', (v) => { style.opacity = v; saveStyle(); }));

    wrap.appendChild(makeSlider(t('显示范围'), 0.3, 1, 0.05, style.displayArea,
        (v) => Math.round(v * 100) + '%', (v) => { style.displayArea = v; saveStyle(); }));

    const reset = document.createElement('div');
    reset.className = 'fntv-dm-reset';
    reset.textContent = t('恢复默认');
    reset.addEventListener('click', (e) => {
        e.stopPropagation();
        style = { ...DEFAULT_STYLE };
        saveStyle();
        renderPanel();
    });
    wrap.appendChild(reset);
    return wrap;
}

// ─── 初始化 ───

// [lc-1015] 模块加载即安装 play/info 只读观察器（必须在 fnOS 页面脚本开始发请求前就位；
// 本插件按字母序先于 skipInject 加载，包装链上它能看到原生播放流程的 play/info）。
installPlayInfoObserver();

// [lc-1107] 有界轮询兜底。旧实现只有 OnReady+1.5s（每次文档加载仅一次）+ OnDomChange 的
// 800ms **无上限尾随防抖**：xgplayer 起播阶段持续改 DOM → 计时器被不停重置 → maybeSetup
// 迟迟不跑，等它终于跑起来已是播放十来秒后，用户看到的就是"弹幕按钮要过一会儿才出现"。
const MOUNT_POLL_MS = 400;
const MOUNT_POLL_MAX = 60;          // 400ms × 60 = 24s 硬上限
const MOUNT_POLL_PAGE_GRACE = 15;   // 前 6s 允许 isPlayerPage() 为假（等 <video> 元素出现）
let mountPollTimer: ReturnType<typeof setInterval> | null = null;
let mountPollTries = 0;

function stopMountPoll(): void {
    if (mountPollTimer) { clearInterval(mountPollTimer); mountPollTimer = null; }
    mountPollTries = 0;
}

function startMountPoll(): void {
    if (mountPollTimer || controlsPlaced) return;
    mountPollTries = 0;
    mountPollTimer = setInterval(() => {
        mountPollTries++;
        if (controlsPlaced || mountPollTries > MOUNT_POLL_MAX ||
            (mountPollTries > MOUNT_POLL_PAGE_GRACE && !isPlayerPage())) {
            stopMountPoll();
            return;
        }
        // 只补「入位」这一件事，不调 maybeSetup()：后者会顺带跑 prepareAndLoad()，
        // 每 400ms 打一条"已有弹幕请求在途"日志 → CMD 刷屏（lc-1106 刚治过）。
        ensureMounted();
    }, MOUNT_POLL_MS);
}

/**
 * [lc-1111] 离开播放页时收起整个弹幕层。
 * ⚠ canvas 挂在 body 上且 position:fixed，播放器 DOM 被 SPA 销毁时**不会**带走它；
 * 渲染循环取不到 video 就提前 return，于是最后一帧弹幕永远浮在首页/详情页上（用户实机截图）。
 * items/meta/currentGuid 故意不清：回到同一集时靠它们直接续播，不必再打一次 B站。
 */
function leavePlayer(): void {
    stopRender();                       // 内部已 clearRect，画布内容一并抹掉
    if (canvas) {
        if (canvasHost !== null && canvas.parentElement !== document.body) {
            document.body.appendChild(canvas);   // 全屏容器随 SPA 销毁, 先把 canvas 抢回 body
            canvas.style.position = 'fixed';
            canvas.style.zIndex = '5';
        }
        canvasHost = null;
        canvas.style.display = 'none';
    }
    if (rectRO) { rectRO.disconnect(); rectRO = null; rectROTarget = null; }
    cancelClosePanel();
    dmBtnWrap?.remove();
    dmBtnWrap = null;
    dmBtnSpan = null;
    dmList = null;
    dmSwitch = null;
    dmHeadStyle = null;
    dmHeadDetail = null;
    dmFoldStyle = null;
    dmFoldDetail = null;
    dmDetailBody = null;
    dmDetailShown = undefined;
    controlsPlaced = false;
    mountedForGuid = null;
    refreshDismissBinding();
}

/** [lc-1114] 「该收了」抽成可同步调用的轻检查：只看 URL 是否已离开带 GUID 的路由。
 *  不必再查 `!isPlayerPage()` —— GUID 缺席时它必为假，两条判据等价，而省掉 querySelector 才敢
 *  挂在每次 DOM 变动 / 路由事件上。门槛用 mountedForGuid/dmBtnWrap 而不是 canvas：
 *  canvas 一旦建过就常驻，拿它当门槛每次路由事件都会重跑一遍清理。 */
function checkLeave(): void {
    if (mountedForGuid === null && !dmBtnWrap) return;
    if (GUID_RE.test(window.location.href)) return;
    leavePlayer();
}

function maybeSetup(): void {
    // [lc-550] 全屏去圆角: 即便当前非播放页也调用一次, 清理可能残留的 fntv-video-fullscreen 标记
    applyVideoFullscreenClass();
    if (!isPlayerPage()) {
        // 收的条件是「URL 已离开带 GUID 的播放/详情路由」，而不是「此刻查不到 <video>」：
        // xgplayer 播放期会瞬时重建 video 元素，按后者判断会把入口和画布一起拆了再重建（弹幕闪一下没了）。
        checkLeave();
        return;
    }

    // [lc-544] 播放页顶部标题栏美化（毛玻璃 + 自动隐藏）
    injectPlayerHeaderStyle();
    bindHeaderAutoHide();
    // [lc-550] 播放器全屏去圆角检测
    bindVideoFullscreenFix();

    try {
        const saved = localStorage.getItem(LS_KEY);
        enabled = saved !== '0';
    } catch { /* ignore */ }
    try {
        biliSearch = localStorage.getItem(LS_BILI_KEY) !== '0';
    } catch { /* ignore */ }

    const guid = getGuid();
    if (!guid) return;

    // isConnected 必须一起判：SPA 重建播放器会把按钮连同旧控制栏一起销毁，
    // 只看 controlsPlaced 会永远短路，按钮再也回不来。
    if (guid === mountedForGuid && controlsPlaced && !!dmBtnWrap?.isConnected) {
        if (canvas) canvas.style.display = enabled ? 'block' : 'none';
        syncToggleUI();
        return;
    }

    ensureMounted();
    mountedForGuid = guid;
    syncToggleUI();
    prepareAndLoad();
    if (!controlsPlaced) startMountPoll();
}

registerHook(HookType.OnReady, () => {
    startMountPoll();
    setTimeout(maybeSetup, 1500);
});

registerHook(HookType.OnDomChange, () => {
    // [lc-1114] 「收」不等防抖。下面这条 800ms 是给「重建/入位」设的尾随防抖，
    // 而 SPA 拆播放器 + 渲染新页会连吐 DOM 变动、把计时器一路重置（实测 3.2s 才收，
    // 用户看到的就是弹幕冻在首页两三秒）。checkLeave 只读一次 URL，够便宜挂在这里。
    checkLeave();
    if ((maybeSetup as any)._t) clearTimeout((maybeSetup as any)._t);
    (maybeSetup as any)._t = setTimeout(maybeSetup, 800);
    // 防抖被起播期的高频 DOM 变动饿死时，靠轮询保证按钮能入位
    if (!controlsPlaced) startMountPoll();
});

// [lc-1114] 路由事件即时收：DOM 变动只是「事后」信号，URL 离开播放路由才是事实本身。
// fnOS 是 history 模式 SPA（embyWall 里已在用 pushState + 手动 dispatch popstate 导航），
// 所以三条都挂：包 pushState/replaceState、听 popstate、听 hashchange。
let _routeHooked = false;
function hookRouteChanges(): void {
    if (_routeHooked) return;
    _routeHooked = true;
    window.addEventListener('popstate', checkLeave);
    window.addEventListener('hashchange', checkLeave);
    try {
        const h = window.history as any;
        for (const m of ['pushState', 'replaceState'] as const) {
            const orig = h[m];
            if (typeof orig !== 'function') continue;
            h[m] = function (this: History, ...a: any[]): void {
                orig.apply(this, a);      // 抛错（如跨域 url）就让它照常抛，不做判断
                checkLeave();             // 此刻 location 已更新
            };
        }
    } catch { /* ignore */ }
}
hookRouteChanges();

export {};
