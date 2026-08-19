import { BrowserWindow, BrowserWindowConstructorOptions, screen, shell, app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from '../../modules/logger';
import * as fnConfig from '../../modules/fn_config/config';

// [lc-142] 预计算登录页背景图的绝对 file:// URL（避免 insertCSS 相对路径在不同 loadFile 入口解析不一致导致白屏）
//   注意: 打包后 resource 在 app.asar 内, 取 app.getAppPath()(开发态=项目根/打包态=asar 虚拟路径)即可正确定位,
//         不能取 path.dirname(app.getPath('exe'))(那是安装根目录, 没有 resource 子目录 → 默认图路径不存在 → 白屏).
const _loginBgDir = app.getAppPath();
const _loginBgDefaultFile = path.join(_loginBgDir, 'resource', 'login', 'image', 'bg-login.jpg');
const _loginBgDefaultUrl = fs.existsSync(_loginBgDefaultFile)
    ? 'file:///' + _loginBgDefaultFile.replace(/\\/g, '/')
    : ''; // 兜底: 空字符串让登录页 HTML 自身背景生效

/**
 * 计算适配屏幕的窗口尺寸 (任何分辨率通用).
 * 规则: 先按工作区比例(fill)缩放 → 约束 16:9 → 封顶 1920x1080 → 下限兜底.
 *  - 高分屏(4K/2K/超宽): 封顶到 1920x1080, 保持用户满意的"刚刚好"大小, 不撑满
 *  - 标准屏(1080P): 缩放留约 8% 边距, 不顶满四边
 *  - 笔记本/小屏(1440x900/1366x768 等): 同比例缩放, 不低于下限
 */
function computeWindowSize(): { width: number; height: number } {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const baseW = 1920;
    const baseH = 1080;
    const fill = 0.92; // 占工作区比例(四周留边距)
    const ratio = 16 / 9;
    // 1) 按工作区比例缩放
    let w = Math.round(sw * fill);
    let h = Math.round(sh * fill);
    // 2) 约束 16:9, 避免非 16:9 屏幕(超宽/竖屏)被拉变形
    if (w / h > ratio) w = Math.round(h * ratio);
    else h = Math.round(w / ratio);
    // 3) 封顶: 高分屏不放大超过 1920x1080
    w = Math.min(w, baseW);
    h = Math.min(h, baseH);
    // 4) 兜底下限: 极小屏不低于此值
    w = Math.max(w, 1280);
    h = Math.max(h, 720);
    return { width: w, height: h };
}

const mainwinConfig: BrowserWindowConstructorOptions = {
    minWidth: 1280,
    minHeight: 720,
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '../../../build/icon.ico'),
    frame: false,
    // 透明窗口: 实现真正的 Mica/Acrylic 半透亚克力(桌面朦胧透出)
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
        webgl: true,
        partition: 'persist:fntv',
        preload: path.join(__dirname, '../../preload/index.js'),
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: false,
    }
};

let mainwin: BrowserWindow | null = null;

/* ══════════════════════════════════════════════════════════
   WIN11 MICA ACRYLIC v376 — 全客户端透桌面亚克力 (CSS 常量)
   提取为常量以便在 dom-ready 时重复注入 (修复 MPV 关闭后
   reloadIgnoringCache 导致的 UI 全丢: 圆角/导航栏/白底清除等)
   ══════════════════════════════════════════════════════════ */
const ACRYLIC_CSS = `
    /* ── ① 窗口级圆角 (transparent窗口OS忽略roundedCorners) ──
       核心原理: 透明窗口下 html 的 border-radius+overflow 只能裁剪 html 内的普通流元素.
       position:fixed 元素相对于视口定位, 不受 html overflow 裁剪!
       因此必须: html+body 圆角 + 所有全屏 fixed 层单独圆角 + clip-path 兜底 */
    html{
        background:transparent!important;
        border-radius:16px!important;
        overflow:hidden!important;
        /* clip-path 兜底: 即使有遗漏的 fixed 层也能裁掉直角 */
        clip-path:inset(0 round 16px)!important;
        -webkit-clip-path:inset(0 round 16px)!important;
    }

    /* ── ①b 播放器全屏时去掉窗口圆角（视频4角变直角）──
       两种全屏都要处理:
         · 浏览器原生全屏 → 命中 html:fullscreen 伪类;
         · 飞牛 xgplayer 伪全屏(多数情况) → 命中 html.fntv-video-fullscreen,
           该 class 由 preload(danmakuWeb) 检测播放器根容器(.xgplayer)铺满视口时打标。
       全屏时窗口应是不透明的直角全屏, 不再需要圆角/clip-path,
       否则视频四角被裁成圆角、露出透明桌面。 */
    html:fullscreen,
    html.fntv-video-fullscreen{
        border-radius:0!important;
        clip-path:none!important;
        -webkit-clip-path:none!important;
    }
    html:fullscreen body,
    html.fntv-video-fullscreen body{
        border-radius:0!important;
        padding-top:0!important;   /* 全屏时去掉顶部 32px 安全区, 视频铺满顶边 */
    }
    html:fullscreen .fnos-tv-page body,
    html.fntv-video-fullscreen .fnos-tv-page body{
        border-radius:0!important;
    }
    html:fullscreen [style*="position:fixed"][style*="inset:0"],
    html.fntv-video-fullscreen [style*="position:fixed"][style*="inset:0"],
    html:fullscreen .fixed.inset-0,
    html.fntv-video-fullscreen .fixed.inset-0,
    html:fullscreen [class*="fixed"][class*="inset-0"],
    html.fntv-video-fullscreen [class*="fixed"][class*="inset-0"],
    html:fullscreen [id="fnos-page-veil"],
    html.fntv-video-fullscreen [id="fnos-page-veil"]{
        border-radius:0!important;
        clip-path:none!important;
        -webkit-clip-path:none!important;
    }

    /* ── ② Body: 亚克力底板 (粉紫半透+模糊桌面) ──
       透明度 --fnos-alpha / 模糊 --fnos-blur 由侧栏滑块实时控制 */
    /* body 基础(全局): 仅保留无边框透明窗口必需的顶部安全区 + 防溢出。
       亚克力底板/模糊/字体等仅在影视TV页(.fnos-tv-page)生效,
       否则系统页(文件管理等 / 根路径)会被透明化→缩略图 img 透出桌面变黑框. [lc-455] */
    body{
        margin:0!important;
        padding-top:32px!important;
        overflow:hidden!important;
    }
    /* 影视TV页: 亚克力底板 + 模糊透桌面 + 字体平滑 */
    .fnos-tv-page body{
        min-height:100vh!important;
        border-radius:16px!important;
        background:rgba(250,244,250, var(--fnos-alpha,0.68))!important;
        backdrop-filter:blur(var(--fnos-blur,30px)) saturate(132%) brightness(1.03)!important;
        -webkit-backdrop-filter:blur(var(--fnos-blur,30px)) saturate(132%) brightness(1.03)!important;
        font-family:'Segoe UI Variable','Segoe UI',system-ui,-apple-system,sans-serif!important;
        -webkit-font-smoothing:antialiased!important;
    }

    /* ── ②b 全局 fixed 层强制圆角 (透明窗口圆角的真正保障) ──
       任何 position:fixed 且铺满屏幕的元素都必须圆角, 否则四个角露直角 */
    [style*="position:fixed"][style*="inset:0"],
    .fixed.inset-0,
    [class*="fixed"][class*="inset-0"]{
        border-radius:16px!important;
        overflow:hidden!important;
        clip-path:inset(0 round 16px)!important;
        -webkit-clip-path:inset(0 round 16px)!important;
    }
    /* 特殊: 仅 top:32px 的固定层(如页面过渡 veil), 上方留出导航栏空间 */
    [id="fnos-page-veil"]{
        border-radius:0 0 16px 16px!important;
        overflow:hidden!important;
        clip-path:inset(0 round 0 0 16px 16px)!important;
        -webkit-clip-path:inset(0 round 0 0 16px 16px)!important;
    }

    /* ── ②c 飞牛顶部固定导航栏底部分隔线(黑线)移除 ──
       fnOS 全局固定顶栏(含影视logo)自带 border-bottom / box-shadow 分隔线,
       透明窗口下显示为一条黑线, 这里移除之(不动布局/高度) */
    header,
    nav,
    [role="banner"],
    [class*="header"],
    [class*="Header"],
    [class*="navbar"],
    [class*="nav-bar"],
    [class*="topbar"],
    [class*="top-bar"],
    [class*="appbar"],
    [class*="app-bar"],
    [class*="menubar"],
    [class*="menu-bar"]{
        border-bottom:none!important;
        box-shadow:none!important;
        filter:none!important;
    }
    /* 顶栏可能用 ::after / ::before 伪元素画分隔线或投影, 一并清掉 */
    header::after,
    header::before,
    [class*="header"]::after,
    [class*="header"]::before,
    [class*="navbar"]::after,
    [class*="navbar"]::before,
    [class*="nav-bar"]::after,
    [class*="nav-bar"]::before,
    [class*="topbar"]::after,
    [class*="topbar"]::before,
    [class*="top-bar"]::after,
    [class*="top-bar"]::before{
        display:none!important;
    }
    /* 顶栏内部子元素若单独带阴影/投影(如内容层), 也一并清除 */
    header *,
    nav *,
    [class*="header"] *,
    [class*="navbar"] *,
    [class*="nav-bar"] *,
    [class*="topbar"] *,
    [class*="top-bar"] *,
    [class*="appbar"] *,
    [class*="app-bar"] *{
        box-shadow:none!important;
        filter:none!important;
    }

    /* ── ③ 白底清除(仅限影视TV页 /v): 覆盖白色背景来源实现亚克力透出 ──
       [lc-453] 重要: 这些规则必须限定在 .fnos-tv-page 下, 否则文件管理/设置等系统页的缩略图/容器背景会被误杀变黑框.
       .fnos-tv-page 类由 preload(embyWall.ts handle())在检测到 /v 路径时添加到 <html> 上. */
    /* 3a. 常见 class 模式 */
    .fnos-tv-page #root,.fnos-tv-page #app,
    .fnos-tv-page [class*="bg-white"],
    .fnos-tv-page [class*="bg-gray-50"],
    .fnos-tv-page [class*="bg-gray-100"],
    .fnos-tv-page [class*="bg-gray-200"],
    .fnos-tv-page [class*="bg-slate-50"],
    .fnos-tv-page [class*="bg-slate-100"],
    .fnos-tv-page [class*="neutral-50"],
    .fnos-tv-page [class*="neutral-100"]{
        background:transparent!important;
    }

    /* 3b. Tailwind 任意值白底 */
    .fnos-tv-page [class*="bg-[#ff"][class*="f]"],
    .fnos-tv-page [class*="bg-[#FFF]"],
    .fnos-tv-page [class*="bg-[rgb(255"],
    .fnos-tv-page [class*="bg-[rgba(255"],
    .fnos-tv-page [class*="bg-white/"]{
        background:transparent!important;
    }

    /* 3c. 飞牛主题变量白底 */
    .fnos-tv-page [style*="background:#fff"],
    .fnos-tv-page [style*="background:#FFF"],
    .fnos-tv-page [style*="background:white"],
    .fnos-tv-page [style*="background-color:#fff"],
    .fnos-tv-page [style*="background-color:#FFF"],
    .fnos-tv-page [style*="background-color:white"],
    .fnos-tv-page [style*="background:var(--mc-bg"],
    .fnos-tv-page [style*="background-color:var(--mc-bg"]{
        background:transparent!important;
        background-color:transparent!important;
    }

    /* 3d. 全屏容器强制透 */
    .fnos-tv-page .min-h-screen,.fnos-tv-page [class*="min-h-screen"],
    .fnos-tv-page .h-screen,.fnos-tv-page [class*="h-screen"],
    .fnos-tv-page [class*="w-full"][class*="min-h"]{
        background:transparent!important;
    }

    /* 3e. 兜底: section/main/article/nav 默认透 */
    .fnos-tv-page section,.fnos-tv-page main,.fnos-tv-page article,.fnos-tv-page nav,.fnos-tv-page aside{
        background:transparent!important;
    }

    /* 3f. Modal/Dialog 遮罩层例外: 弹窗背景必须不透明, 否则底层内容(如首页轮播图)会透过透明遮罩露出来 */
    html:not(.fnos-video-active) .semi-modal-mask,
    html:not(.fnos-video-active) .semi-modal-wrapper,
    html:not(.fnos-video-active) [class*="modal-mask"],
    html:not(.fnos-video-active) [class*="modal-overlay"],
    html:not(.fnos-video-active) [class*="dialog-mask"],
    html:not(.fnos-video-active) [class*="dialog-overlay"],
    html:not(.fnos-video-active) [role="dialog"]::backdrop,
    html:not(.fnos-video-active) [aria-modal="true"] + *{
        background:rgba(0,0,0,.45)!important;
        background-color:rgba(0,0,0,.45)!important;
    }
    /* 弹窗主体自身恢复不透明背景( Semi Design modal content ) */
    html:not(.fnos-video-active) .semi-modal-content,
    html:not(.fnos-video-active) [class*="modal-content"],
    html:not(.fnos-video-active) [class*="dialog-content"],
    html:not(.fnos-video-active) [role="dialog"]:not([style*="background:transparent"]){
        background:#fff!important;
        background-color:#fff!important;
    }

    /* 3g. 弹窗内按钮可见性恢复(lc-184):
       核弹级白底清除(③a~③e)会把 semi-button-solid 的实心背景清成 transparent。
       semi-button-primary 原本是"彩色底+白字", 背景透明后→白字在白色弹窗上=不可见。
       "取消"等次要按钮是边框+透明底+深色字→透明后仍可见(所以只有确认/选择/创建等primary按钮消失)。
       此处对弹窗内的实心按钮显式恢复可见背景+对比色文字。 */
    html:not(.fnos-video-active) .semi-modal-content .semi-button-solid,
    html:not(.fnos-video-active) [class*="modal-content"] .semi-button-solid,
    html:not(.fnos-video-active) [class*="dialog-content"] .semi-button-solid,
    html:not(.fnos-video-active) [role="dialog"] .semi-button-solid{
        background:var(--semi-color-primary, #4a90d9)!important;
        color:#fff!important;
    }
    /* 深色模式下弹窗按钮同步 */
    html.dark:not(.fnos-video-active) .semi-modal-content .semi-button-solid,
    html.dark:not(.fnos-video-active) [class*="modal-content"] .semi-button-solid,
    html.dark:not(.fnos-video-active) [class*="dialog-content"] .semi-button-solid,
    html.dark:not(.fnos-video-active) [role="dialog"] .semi-button-solid{
        background:var(--semi-color-primary, #6c8ccf)!important;
        color:#fff!important;
    }

    /* ── ④ 滚动条隐藏 ── */
    ::-webkit-scrollbar{width:0!important;height:0!important}
    ::-webkit-scrollbar-track{display:none!important}
    ::-webkit-scrollbar-thumb{display:none!important}

    /* ── ⑤ 隐藏飞牛无关组件 ── */
    /* 注: semi-color-bg-arrow-mask(飞牛原生横滑箭头)不再在此全局隐藏,
       其显隐由 embyWall.ts wheelToScroll() 开关(『鼠标滚轮横向滚动』)控制:
       开关开→opacity/pointer-events视觉隐藏; 关→恢复原生显示. */
    .ms-thumb,.ms-track,.ms-track-box{display:none!important}

    /* ── ⑥ 页面容器边距归零（列表页由 ⑪ 统一接管）── */
    div.relative.flex.flex-col.gap-6.pb-6.pr-4{padding-right:0!important}
    div.relative.flex.flex-col.gap-6.pb-6{padding-left:0!important}
    /* 注意: .ms-container.pl-[44px] 的 padding 已移至 ⑪ 统一管理，避免 !important 冲突 */

    /* ── ⑦ 导航栏: 极淡融合条 + 原生拖动 ──
       v377: 几乎完全透明, 只保留微量模糊防文字抖动. 与下方 body 亚克力无缝衔接 */
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5{
        height:80px!important;
        background:rgba(250,244,250,.015)!important;
        backdrop-filter:blur(12px) saturate(105%)!important;
        -webkit-backdrop-filter:blur(12px) saturate(105%)!important;
        border:none!important;
        box-shadow:none!important;
        -webkit-app-region:drag!important;
        app-region:drag!important;
    }
    /* 导航栏内交互元素: 取消拖动, 否则无法点击 */
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 a,
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 button,
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 [role="button"],
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 input,
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 svg,
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 [class*="cursor-pointer"],
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 [onclick],
    div.relative.z-20.flex.items-center.justify-between.px-11.py-5 img{
        -webkit-app-region:no-drag!important;
        app-region:no-drag!important;
    }

    /* logo容器确保relative定位 */
    div.flex-1.items-center{position:relative!important}

    /* ── ⑧ 抽屉: Mica Acrylic 侧栏玻璃 ── */
    .fixed.inset-0[class*="lg:!hidden"]{
        background:rgba(200,195,210,.10)!important;
        backdrop-filter:blur(8px) saturate(120%)!important;
        -webkit-backdrop-filter:blur(8px) saturate(120%)!important;
        opacity:0!important;
        pointer-events:none!important;
        transition:opacity .28s ease!important;
        border-radius:16px!important;
        overflow:hidden!important;
        clip-path:inset(0 round 16px)!important;
        -webkit-clip-path:inset(0 round 16px)!important;
    }
    .fixed.inset-0[class*="lg:!hidden"].drawer-open{
        opacity:1!important;
        pointer-events:auto!important;
    }
    .fixed.inset-0[class*="lg:!hidden"] > *:not(.absolute){
        background:linear-gradient(160deg,
            rgba(250,244,250,.56) 0%,
            rgba(243,238,247,.60) 100%)!important;
        backdrop-filter:blur(56px) saturate(135%) brightness(1.02)!important;
        -webkit-backdrop-filter:blur(56px) saturate(135%) brightness(1.02)!important;
        border-right:1px solid rgba(255,255,255,.5)!important;
        box-shadow:
            inset 1px 0 0 rgba(255,255,255,.5),
            -8px 0 32px rgba(140,130,160,.08)!important;
        transform:translateX(-100%)!important;
        transition:transform .30s cubic-bezier(.22,.61,.36,1)!important;
    }
    .fixed.inset-0[class*="lg:!hidden"].drawer-open > *:not(.absolute){
        transform:translateX(0)!important;
    }
    .fixed.inset-0[class*="lg:!hidden"] [class*="rounded"]:hover{
        background:rgba(180,150,200,.14)!important;
        box-shadow:inset 0 0 0 1px rgba(210,190,220,.3)!important;
    }

    /* ── ⑨ 宽屏汉堡键常显 ── */
    [class*="lg:!hidden"]:not([class*="inset-0"]){display:flex!important}
    [class*="lg:!hidden"][class*="inset-0"]:not([class~="!hidden"]){display:flex!important}

    /* ── ⑩ 内容卡片: Mica 浮起玻璃卡 ── */
    .card-root,
    [class*="card"]:not([class*="drawer"]),
    li[class*="cursor-pointer"],
    [class*="rounded-lg"][class*="bg-white"],
    [class*="rounded-xl"][class*="bg-white"],
    [class*="bg-white\\/"],
    [class*="bg-gray-50"]:not([class*="drawer"]){
        background:rgba(250,244,252,.35)!important;
        backdrop-filter:blur(20px) saturate(125%)!important;
        -webkit-backdrop-filter:blur(20px) saturate(125%)!important;
        border-radius:12px!important;
        border:1px solid rgba(255,255,255,.45)!important;
        box-shadow:0 1px 4px rgba(120,110,140,.05),0 .5px 0 rgba(255,255,255,.55)!important;
    }

    /* 轮播图区域圆角 */
    [class*="rounded"][class*="overflow-hidden"],
    img[style*="border-radius"],img.rounded-lg,img.rounded-xl{
        border-radius:10px!important;
        transition:transform .25s ease,box-shadow .25s ease!important;
    }

    /* ── ⑪ 列表页全宽自适应（修复右侧留白）── */
    /* 浏览器实测(fnOS原生 /v/tv 番剧页, 1600×900):
       布局链: #root>div(1600) > sidebar(260) + content(1340)
         > outer ms-container(1340,无padding) > inner ms-container.px-11(1340, padding:44px×2!)
           > div.flex-wrap.gap-x-5(1252px=1340-88, 有inline height:11484px)
       根因: inner ms-container 的 px-11=44px 内边距吃掉 88px 可用宽度 → 右侧留白。
       修复: 收紧 px-11 从 44px→20px，可用宽从 1252→1300px(+48px)。
       注意: 不做 flex→grid 转换——fnOS 用 JS 算好 inline height，转 grid 易坍塌。 */

    /* 11a. 列表页滚动容器: 收紧内边距 44px → 20px */
    .ms-container.trim-ui__scrollbar--list-specific.px-11,
    [class*="ms-container"][class*="trim-ui__scrollbar"][class*="px-11"]{
        padding-left:20px!important;
        padding-right:20px!important;
    }

    /* 11b. 全局 px-11/px-10 收紧（排除顶部导航栏 z-20）*/
    [class*="px-11"]:not([class*="z-20"]){
        padding-left:20px!important;
        padding-right:20px!important;
    }
    [class*="px-10"]:not([class*="z-20"]){
        padding-left:16px!important;
        padding-right:16px!important;
    }

    /* 11c. 兜底: 砍掉 max-width 约束 (仅限影视TV页 /v;
       全局生效会误伤系统页如文件管理的缩略图容器, 去掉 max-width 让其撑大溢出) [lc-456] */
    .fnos-tv-page [class*="max-w"]{
        max-width:none!important;
    }

    /* ── ⑫ 深色模式 (html.dark): 窗口 chrome 同步变深 ── */
    html.dark body{
        background:rgba(20,15,33, var(--fnos-alpha,0.42))!important;
    }
    html.dark div.relative.z-20.flex.items-center.justify-between.px-11.py-5{
        background:rgba(20,15,33,.10)!important;
    }
    html.dark .fixed.inset-0[class*="lg:!hidden"]{
        background:rgba(0,0,0,.30)!important;
    }
    html.dark .fixed.inset-0[class*="lg:!hidden"] > *:not(.absolute){
        background:linear-gradient(160deg,
            rgba(34,28,52,.66) 0%,
            rgba(26,20,42,.72) 100%)!important;
        border-right:1px solid rgba(255,255,255,.08)!important;
        box-shadow:
            inset 1px 0 0 rgba(255,255,255,.06),
            -8px 0 32px rgba(0,0,0,.30)!important;
    }
    html.dark .fixed.inset-0[class*="lg:!hidden"] [class*="rounded"]:hover{
        background:rgba(150,120,200,.20)!important;
        box-shadow:inset 0 0 0 1px rgba(180,160,220,.35)!important;
    }
    html.dark .card-root,
    html.dark [class*="card"]:not([class*="drawer"]),
    html.dark li[class*="cursor-pointer"],
    html.dark [class*="rounded-lg"][class*="bg-white"],
    html.dark [class*="rounded-xl"][class*="bg-white"],
    html.dark [class*="bg-white\\/"],
    html.dark [class*="bg-gray-50"]:not([class*="drawer"]){
        background:rgba(42,34,62,.55)!important;
        border:1px solid rgba(255,255,255,.08)!important;
        box-shadow:0 1px 4px rgba(0,0,0,.25),0 .5px 0 rgba(255,255,255,.06)!important;
    }

    /* ── ⑫b 深色模式 Modal/Dialog 例外 ── */
    html.dark:not(.fnos-video-active) .semi-modal-mask,
    html.dark:not(.fnos-video-active) .semi-modal-wrapper,
    html.dark:not(.fnos-video-active) [class*="modal-mask"],
    html.dark:not(.fnos-video-active) [class*="modal-overlay"]{
        background:rgba(0,0,0,.60)!important;
        background-color:rgba(0,0,0,.60)!important;
    }
    html.dark:not(.fnos-video-active) .semi-modal-content,
    html.dark:not(.fnos-video-active) [class*="modal-content"],
    html.dark:not(.fnos-video-active) [class*="dialog-content"]{
        background:#2b2a33!important;
        background-color:#2b2a33!important;
    }

    /* ── ⑬ 详情页布局保护（lc-190: 修复 TV 剧集页带季选择器时内容变窄）
         症状: 海报/播放按钮/简介等全部挤成中间一条窄带, 左右大片空白.
         根因推测: ACRYLIC_CSS 全局规则(③白底清除/11b改padding/11c砍max-width)
         与 fnOS TV 详情页(有季数选择器)的 DOM 布局产生交互异常,
         导致某层容器失去正确宽度约束 → 子元素收缩至内容自然宽度(竖向海报宽≈260px).
         修复: 强制详情页主内容容器链保持全宽展开. ── */

    /* 13a. 滚动容器全宽 */
    .ms-container{
        width:100%!important;
        max-width:none!important;
    }

    /* 13b. 详情页头部容器(TV详情用 .trim-mc__details--key-version,
         Season详情用 .semi-always-dark.h-[470px])强制撑满父级 */
    .trim-mc__details--key-version,
    .semi-always-dark.box-border.flex.h-\\[470px\\]{
        width:100%!important;
        max-width:none!important;
    }

    /* 13c. 兜底: 详情页内任何 max-w 约束容器恢复合理宽度
         (覆盖 11c 对详情页子容器的过度砍杀) */
    .trim-mc__details--key-version [class*="max-w"],
    .semi-always-dark [class*="max-w"]{
        max-width:1280px!important;
        width:auto!important;
    }

    /* 13d. 防止详情页主内容区收缩: 确保关键布局层撑开 */
    .trim-mc__details--key-version > div,
    .trim-mc__details--key-version > section,
    .semi-always-dark.box-border.flex > div{
        width:100%!important;
        max-width:none!important;
    }

    /* ── ⑭ 手动匹配弹窗溢出修复（lc-302） ──
         症状: "手动匹配"弹窗中文件位置的长路径右侧被截断不可见.
         根因: 弹窗内存在多层 .ms-container 被 fnOS 滚动库强制设 min-width:1057.1px !important,
               且外层 .max-h-[calc(100vh-160px)] / .box-border.overflow-hidden 等
               多处 overflow:hidden → 内容右半边被裁剪.
         DOM 链路(从截图HTML):
           .semi-modal-content → .semi-modal-confirm-content → .w-full.max-h-[...]
             → .ms-container(min-width:1057.1px) [第1层]
               → .rounded-lg → .ms-container(min-width:1057.1px) [第2层]
                 → .box-border.overflow-hidden [直接裁剪层] → p[title][文件路径]
         修复策略:
           a) 弹窗范围内**所有** .ms-container 解除 min-width 强制, 改自适应;
           b) 弹窗内容区(max-h 容器 + flex col 容器) 允许水平滚动;
           c) 文件路径外层 overflow-hidden 改 auto(可滚动而非简单可见);
           d) 文件路径文本确保 break-all 换行.
         仅限 .semi-modal-content 后代, 不影响详情页等其他场景. ── */
    .semi-modal-content .ms-container{
        min-width:0!important;
        width:100%!important;
        max-width:100%!important;
    }
    /* 弹窗主内容区: 允许水平滚动以容纳长路径 */
    .semi-modal-content .max-h-\\[calc\\(100vh-160px\\)\\],
    .semi-modal-content .semi-modal-confirm-content{
        overflow-x:auto!important;
        overflow-y:auto!important;
    }
    /* 文件路径卡片内的裁剪层: 改为可滚动 */
    .semi-modal-content .rounded-lg .box-border.overflow-hidden{
        overflow:auto!important;
    }
    /* 文件路径文本: 强制换行 */
    .semi-modal-content p[title]{
        word-break:break-all!important;
        overflow-wrap:break-word!important;
        max-width:100%!important;
    }
`;

/**
 * 判断当前 URL 是否为登录页路径.
 * 登录页需要不透明白底(否则 transparent 窗口下全透明→桌面透出→看不清).
 */
function isLoginPath(url: string): boolean {
    try {
        const p = new URL(url).pathname.toLowerCase();
        return p.includes('/login') || p.includes('/signin') || p.includes('/auth');
    } catch { return false; }
}

/**
 * 注入亚克力 CSS 到主窗口
 * 可在 dom-ready 时反复调用 (幂等: CSS 规则重复不副作用)
 *
 * v380: 登录页(/login,/signin) 自动切换为不透明白底模式,
 *       避免 transparent 窗口 + html{background:transparent} 导致桌面透出全白.
 */
function injectAcrylicCSS(wc: Electron.WebContents): void {
    // 主窗口的原生底板必须始终透明。登录页的不透明背景由下方 body
    // 提供；若把 BrowserWindow 底板设为白色，clip-path 裁掉的四角仍会
    // 露出白色窗口底板，视觉上就会重新变成方形。
    const owner = BrowserWindow.fromWebContents(wc);
    owner?.setBackgroundColor('#00000000');

    const url = wc.getURL();
    if (isLoginPath(url)) {
        // [lc-144] 直接读 config.json 取 loginBgPath(不依赖 config 模块导出, 避免 asar/打包环境下
        //   "getLoginBgPath is not a function" 崩溃——该崩溃已在多份打包构建中复现).
        //   同步读取, 零耦合, 任何环境下不会因模块解析差异而失败.
        let customBg = '';
        try {
            const cfgPath = path.join(app.getPath('userData'), 'config.json');
            if (fs.existsSync(cfgPath)) {
                const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                customBg = (raw && raw.loginBgPath) || '';
            }
        } catch (_) { /* 读不到就留空, 用默认图 */ }
        const effectiveBgUrl = (customBg && fs.existsSync(customBg))
            ? 'file:///' + customBg.replace(/\\/g, '/')
            : _loginBgDefaultUrl;
        wc.insertCSS(`
            html{
                height:100%!important;
                background:transparent!important;
                background-color:transparent!important;
                overflow:hidden!important;
                border-radius:16px!important;
                clip-path:inset(0 round 16px)!important;
                -webkit-clip-path:inset(0 round 16px)!important;
            }
            body{
                background:transparent!important;
                background-color:transparent!important;
                margin:0!important;
            }
            body::before{
                content:''!important;
                position:fixed!important;
                inset:0!important;
                top:0!important;
                left:0!important;
                right:0!important;
                bottom:0!important;
                z-index:-1!important;
                background-image:url("${effectiveBgUrl}")!important;
                background-repeat:no-repeat!important;
                background-position:center center!important;
                background-size:cover!important;
                background-attachment:scroll!important;
                background-color:#1a1a2e!important;
                border-radius:16px!important;
                overflow:hidden!important;
                clip-path:inset(0 round 16px)!important;
                -webkit-clip-path:inset(0 round 16px)!important;
            }
            ::-webkit-scrollbar{width:0!important;height:0!important}
        `);
    } else {
        // 主界面: 窗口亚克力玻璃壳(磨砂透桌面, 不含液态玻璃高光)
        wc.insertCSS(ACRYLIC_CSS);
    }
}

/**
 * 获取主窗口实例
 * @returns {BrowserWindow}
 */
export function getMainWindow(): BrowserWindow {
    // [lc-474] 注入热补丁目录到环境变量，供 preload(渲染端)读取 asar 外补丁；主进程侧直接复用此路径
    const patchesDir = path.join(app.getPath('userData'), 'patches');
    try { if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true }); } catch (_) { /* ignore */ }
    process.env.FNTV_PATCHES_DIR = patchesDir;

    if (!mainwin) {
        const size = computeWindowSize();
        mainwin = new BrowserWindow({ ...mainwinConfig, width: size.width, height: size.height });
        // 居中显示在所属屏幕, 避免从角落弹出
        mainwin.center();

        // v376 修复: CSS 改为 dom-ready 注��� (而非窗口创建时一次性)
        // 原因: 历史上 MPV 关闭会触发 reloadIgnoringCache() 刷新页面,
        //       窗口创建时的 insertCSS 不会在 reload 后重新执行 →
        //       圆角/导航栏/白底清除全部丢失, 飞牛原生控制栏和窗口按钮重叠.
        //       注册 dom-ready 后, 每次页面加载(含 reload/启动导航)都自动重注 CSS.
        //       [lc-127] media.ts 已不再在关闭视频时整页刷新, 但启动导航/用户手动刷新
        //       仍会 reload, 故保留 dom-ready 重注以保证玻璃壳不丢失.
        mainwin.webContents.on('dom-ready', () => {
            injectAcrylicCSS(mainwin!.webContents);
        });

        // 接管 new-window / target="_blank": 同域(飞牛影视 NAS)链接在原窗口内打开,
        // 保留玻璃壳; 外部链接交给系统浏览器. 否则 Electron 会开一个无 preload 的裸窗.
        mainwin.webContents.setWindowOpenHandler((details) => {
            const url = details.url;
            try {
                const target = new URL(url);
                const current = new URL(mainwin!.webContents.getURL() || 'https://localhost');
                const isInApp = target.host === current.host; // 同 NAS 域
                if (isInApp) {
                    log.info('[主窗口] 同域链接在原窗口内打开(保留玻璃壳):', url);
                    mainwin!.loadURL(url);
                    return { action: 'deny' };
                }
            } catch { /* ignore */ }
            // 外部链接: 用系统默认浏览器打开, 同样不弹裸窗
            shell.openExternal(url).catch(() => { });
            return { action: 'deny' };
        });

        // [lc-203] 导航守卫: 防止 fnOS 访问码/隐私流程完成后跳转到原生桌面(/).
        // 飞牛影视是 SPA, 所有有效页面都在 /v/* 下. 若导航落到根路径或非 /v/* 路径,
        // 说明 fnOS 把用户踢回了原生桌面(访问码验证后/会话过期等), 需自动纠正回 /v.
        // 同时监听 did-navigate(完整页面加载) 与 did-navigate-in-page(SPA 内部路由切换),
        // 因为 fnOS 访问码验证后可能是 SPA 客户端路由(pushState/history), 只触发后者.
        // 注: 纯前端渲染的桌面(URL 仍是 /v)本守卫无法捕获, 由渲染端 embyWall.ts 的
        //      [lc-205] 桌面检测逻辑兜底纠正.
        // /app 豁免: 飞牛影视在 fnOS 桌面里的 app 入口可能位于 /app/*, 渲染端会自动点击进入,
        //   主进程不拦截以免纠正回 /v 造成死循环.
        const ALLOWED_PATHS = ['/v/login', '/v/welcome', '/v/oauth', '/v/signin', '/v/auth', '/app'];

        // [lc-375] 切换系统页面: 用户主动进入 fnOS 原生桌面时, 主进程导航守卫(lc-203)会拦截
        //   did-navigate 到 / 并强制纠正回 /v。_systemPageMode 标记期间放行, 不纠正;
        //   用户点「返回影视」(fntv:exit-system-page)或自行进入 /v 时自动清除。
        //   跳转由主进程在置标记后原子执行, 杜绝"标记未生效守卫已纠正"的竞态。
        let _systemPageMode = false;
        ipcMain.removeAllListeners('fntv:enter-system-page');
        ipcMain.on('fntv:enter-system-page', () => {
            _systemPageMode = true;
            try {
                // 系统桌面地址：用户可在设置里自定义（每人 NAS 的系统 Web 端口不同）。
                // 留空=自动，用当前 TV 连接的 origin 根路径（同端口场景）。
                const cfgUrl = fnConfig.getSystemPageUrl();
                if (cfgUrl) {
                    log.info('[切换系统页面] 进入 fnOS 原生桌面（自定义地址）: ' + cfgUrl);
                    mainwin!.loadURL(cfgUrl);
                } else {
                    const cur = new URL(mainwin!.webContents.getURL() || 'https://localhost');
                    log.info('[切换系统页面] 进入 fnOS 原生桌面（自动）: ' + cur.origin + '/');
                    mainwin!.loadURL(cur.origin + '/');
                }
            } catch { /* ignore */ }
        });
        ipcMain.removeAllListeners('fntv:exit-system-page');
        ipcMain.on('fntv:exit-system-page', () => {
            _systemPageMode = false;
            try {
                const cur = new URL(mainwin!.webContents.getURL() || 'https://localhost');
                log.info('[切换系统页面] 返回影视: ' + cur.origin + '/v');
                mainwin!.loadURL(cur.origin + '/v');
            } catch { /* ignore */ }
        });

        // [lc-473] 接收渲染端(注入 fnOS 页面的 preload)发来的精准桌面纠正诊断, 写入 app.log。
        //   仅记录原因, 不做任何纠正动作(纠正由 preload 直接 location.href 完成)。
        ipcMain.removeAllListeners('renderer-desktop-fix');
        ipcMain.on('renderer-desktop-fix', (_e: any, msg: string) => {
            log.info(`[渲染端桌面纠正] ${msg}`);
        });

        const guardRedirect = (url: string) => {
            try {
                const u = new URL(url);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return; // 忽略 file:// 等
                const p = u.pathname;
                // [lc-375] 系统页面模式: 放行原生桌面及其子路由; 一旦进入 /v 自动退出系统模式
                if (_systemPageMode) {
                    if (p === '/v' || p.startsWith('/v/')) _systemPageMode = false;
                    return;
                }
                // 影视页面(首页 /v 本身及 /v/* 子路由)和允许的登录/隐私流程路径 → 不干预
                // 注意: 首页 pathname 恰好是 "/v"(无末尾斜杠), 必须单独放行, 否则会被判为"非影视路径"
                //       进而 loadURL("/v") 重定向到同一 URL → did-navigate 反复触发 → 死循环 → 渲染进程被 kill。
                if (p === '/v' || p.startsWith('/v/') || ALLOWED_PATHS.some(a => p.startsWith(a))) return;
                // 防御: 若纠正目标与当前路径相同(极端情况), 不再二次 loadURL, 避免死循环
                const target = `${u.origin}/v`;
                if (target === `${u.origin}${p}`) return;
                log.warn(`[导航守卫] 检测到非影视路径 ${p}, 自动纠正回 /v (原URL: ${url})`);
                mainwin!.loadURL(target);
            } catch { /* ignore 解析失败 */ }
        };
        mainwin.webContents.on('did-navigate', (_event: any, url: string) => guardRedirect(url));
        mainwin.webContents.on('did-navigate-in-page', (_event: any, url: string) => guardRedirect(url));
    }
    return mainwin;
}
