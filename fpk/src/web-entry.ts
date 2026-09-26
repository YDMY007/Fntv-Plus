// src/web-entry.ts — 网页端/注入引导入口（FPK 注入的 user.js 即从这里打包）。
//
// [v0.34.0] 加载策略：静态 import 全部插件（与桌面版对齐）。diag 模块体在所有插件
// 初始化前自动安装全局错误钩子——任何插件顶层抛错都会被捕获并回传 client.log，
// 实时日志里能看到具体是哪个插件、什么错误（而不是整页静默变原生）。
// 例外不挂载：titlebar（桌面窗口控制浮条）、dialogUI（主进程对话框系统）。

import { installDiag } from './preload/web/diag';
import './preload/web/playSync'; // 模块体自装（拦截 play/record → Bangumi 同步触发器）

import './preload/plugins/a11y';
import './preload/plugins/animeLib';
import './preload/plugins/autoplayNext';
import './preload/plugins/customLogo';
import './preload/plugins/danmakuHeat';
import './preload/plugins/danmakuWeb';
import './preload/plugins/embyWall';
// gamepad / gamepadFocus 不挂载（[v0.43.0]）：播放控制依赖 IPC media:control（主进程控 mpv），
// 网页端 shim 是 no-op，功能半残 → 整体移除，设置面板「手柄设置」卡同步删除。
import './preload/plugins/glassUI';
import './preload/plugins/hotUpdates';
import './preload/plugins/listLayout';
import './preload/plugins/pageAnim';
import './preload/plugins/personWorks';
import './preload/plugins/playMemory';
// playButton / playChoice / playMaskButton 不挂载（[v0.70.0]）：外部播放器（MPV/PotPlayer）
// 播放链在网页端不可用——点击拦截后发 play-movie 是 no-op，曾导致所有播放按钮点死（lc-077）。
import './preload/plugins/previewThumb';
import './preload/plugins/skipInject';
import './preload/plugins/watchHistory';
import './preload/plugins/watchReport';
import './preload/plugins/watchedSync';
import { runHooks, HookType } from './preload/core/hooks';

declare const window: any;
declare const document: any;

function boot(): void {
  try {
    runHooks(HookType.OnReady);
    // [v0.71.0] 补派 OnDomChange（桌面版 preload/index.ts 同款）：danmakuWeb（进播放页挂弹幕）、
    // skipInject（跳过片头填充）等插件靠它在 SPA 切换到播放页时触发——网页端入口此前从不
    // 派发该钩子，导致弹幕/跳过片头在网页端进播放页后永不生效。插件各自带防抖。
    const observer = new MutationObserver(() => runHooks(HookType.OnDomChange));
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[fntv-web] embyWall hooks fired (OnReady)');
  } catch (e) {
    console.error('[fntv-web] boot failed', e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 暴露到 window，方便调试 / 真实页面 SPA 路由切换时手动再触发
if (typeof window !== 'undefined') {
  window.__FNTV_BOOT__ = boot;
}
