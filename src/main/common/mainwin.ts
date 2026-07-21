import { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import * as path from 'path';

const mainwinConfig: BrowserWindowConstructorOptions = {
    width: 1920,
    height: 1080,
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

/**
 * 获取主窗口实例
 * @returns {BrowserWindow}
 */
export function getMainWindow(): BrowserWindow {
    if (!mainwin) {
        mainwin = new BrowserWindow(mainwinConfig);
        // 页面加载前注入基础样式 (Win11 Mica Acrylic — 透桌面真亚克力 v365)
        // v365 修复: ① 全局 fixed 层圆角裁剪(解决透明窗口四角直角) ② 导航栏拖动区域
        mainwin.webContents.insertCSS(`
            /* ════════════════════════════════════════════════════
               WIN11 MICA ACRYLIC v365 — 全客户端透桌面亚克力
               ══════════════════════════════════════════════════ */

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
            [class*="bg-neutral-50"],
            [class*="bg-neutral-100"]{
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

            /* ── ⑦ 导航栏: 近乎透明的融合条 + 原生拖动 ──
               背景几乎全透(6%), 只留极淡模糊. 拖动改用 [v374] 原生 -webkit-app-region:drag
               (transparent 窗口下 JS setPosition 会触发 DWM 异常放大, 已弃用) */
            div.relative.z-20.flex.items-center.justify-between.px-11.py-5{
                height:80px!important;
                background:rgba(250,244,250,.06)!important;
                backdrop-filter:blur(28px) saturate(130%) brightness(1.02)!important;
                -webkit-backdrop-filter:blur(28px) saturate(130%) brightness(1.02)!important;
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
        `);
    }
    return mainwin;
}
