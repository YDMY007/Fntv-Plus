import { BrowserWindow, BrowserWindowConstructorOptions, screen, shell } from 'electron';
import * as path from 'path';

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

    /* ── ② Body: 亚克力底板 (粉紫半透+模糊桌面) ──
       透明度 --fnos-alpha / 模糊 --fnos-blur 由侧栏滑块实时控制 */
    body{
        margin:0!important;
        padding-top:32px!important;
        min-height:100vh!important;
        border-radius:16px!important;
        overflow:hidden!important;
        background:rgba(250,244,250, var(--fnos-alpha,0.42))!important;
        backdrop-filter:blur(var(--fnos-blur,60px)) saturate(132%) brightness(1.03)!important;
        -webkit-backdrop-filter:blur(var(--fnos-blur,60px)) saturate(132%) brightness(1.03)!important;
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

    /* ── ③ 核弹级白底清除: 覆盖一切可能的白色背景来源 ── */

    /* 3a. 常见 class 模式 */
    #root,#app,
    [class*="bg-white"],
    [class*="bg-gray-50"],
    [class*="bg-gray-100"],
    [class*="bg-gray-200"],
    [class*="bg-slate-50"],
    [class*="bg-slate-100"],
    [class*="neutral-50"],
    [class*="neutral-100"]{
        background:transparent!important;
    }

    /* 3b. Tailwind 任意值白底 */
    [class*="bg-[#ff"][class*="f]"],
    [class*="bg-[#FFF]"],
    [class*="bg-[rgb(255"],
    [class*="bg-[rgba(255"],
    [class*="bg-white/"]{
        background:transparent!important;
    }

    /* 3c. 飞牛主题变量白底 */
    [style*="background:#fff"],
    [style*="background:#FFF"],
    [style*="background:white"],
    [style*="background-color:#fff"],
    [style*="background-color:#FFF"],
    [style*="background-color:white"],
    [style*="background:var(--mc-bg"],
    [style*="background-color:var(--mc-bg"]{
        background:transparent!important;
        background-color:transparent!important;
    }

    /* 3d. 全屏容器强制透 */
    .min-h-screen,[class*="min-h-screen"],
    .h-screen,[class*="h-screen"],
    [class*="w-full"][class*="min-h"]{
        background:transparent!important;
    }

    /* 3e. 兜底: section/main/article/nav 默认透 */
    section,main,article,nav,aside{
        background:transparent!important;
    }

    /* ── ④ 滚动条隐藏 ── */
    ::-webkit-scrollbar{width:0!important;height:0!important}
    ::-webkit-scrollbar-track{display:none!important}
    ::-webkit-scrollbar-thumb{display:none!important}

    /* ── ⑤ 隐藏飞牛无关组件 ── */
    [class*="semi-color-bg-arrow-mask"]{display:none!important}
    .ms-thumb,.ms-track,.ms-track-box{display:none!important}

    /* ── ⑥ 页面容器边距归零 ── */
    div.relative.flex.flex-col.gap-6.pb-6.pr-4{padding-right:0!important}
    div.relative.flex.flex-col.gap-6.pb-6{padding-left:0!important}
    .ms-container.pl-\[44px\]{padding-right:44px!important;padding-left:44px!important}

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

    /* ── ⑪ 深色模式 (html.dark): 窗口 chrome 同步变深 ── */
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
        // 登录页圆角方案 (v381 重写):
        //   主界面之所以能圆角, 是因为飞牛 React 渲染了一个真正
        //   position:fixed;inset:0 的全屏容器(.fixed.inset-0), 其自带
        //   clip-path:inset(0 round 16px) 把四角裁成圆角.
        //   透明窗口下 html/body 的 clip-path 对"背景溢出视口"并不可靠
        //   (body 背景会回退到 canvas, 不被裁剪 → 方角), 所以之前把 body
        //   设成 position:fixed 的方案实测仍方.
        //   现改: body 保持透明(不承载背景), 用全屏 fixed 伪元素
        //   body::before 承载壁纸 + clip-path 圆角, 与主界面同一套可靠机制.
        //   伪元素不在 querySelectorAll('*') 内, 不会被 embyWall 圆角扫描器误清.
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
                background-image:url("./image/bg-login.webp")!important;
                background-repeat:no-repeat!important;
                background-position:center center!important;
                background-size:cover!important;
                background-attachment:scroll!important;
                border-radius:16px!important;
                overflow:hidden!important;
                clip-path:inset(0 round 16px)!important;
                -webkit-clip-path:inset(0 round 16px)!important;
            }
            ::-webkit-scrollbar{width:0!important;height:0!important}
        `);
    } else {
        // 主界面: 完整亚克力玻璃壳
        wc.insertCSS(ACRYLIC_CSS);
    }
}

/**
 * 获取主窗口实例
 * @returns {BrowserWindow}
 */
export function getMainWindow(): BrowserWindow {
    if (!mainwin) {
        const size = computeWindowSize();
        mainwin = new BrowserWindow({ ...mainwinConfig, width: size.width, height: size.height });
        // 居中显示在所属屏幕, 避免从角落弹出
        mainwin.center();

        // v376 修复: CSS 改为 dom-ready 注��� (而非窗口创建时一次性)
        // 原因: MPV 关闭后 media.ts 会调 reloadIgnoringCache() 刷新页面,
        //       窗口创建时的 insertCSS 不会在 reload 后重新执行 →
        //       圆角/导航栏/白底清除全部丢失, 飞牛原生控制栏和窗口按钮重叠.
        //       注册 dom-ready 后, 每次页面加载(含 reload)都自动重注 CSS.
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
    }
    return mainwin;
}
