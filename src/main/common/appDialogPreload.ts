import { contextBridge, ipcRenderer } from 'electron';

// appDialogPreload.ts — [lc-1161] 主进程弹窗的 preload
// ─────────────────────────────────────────────────────────────────────────────
// 为什么必须走 preload: 弹窗 HTML 是运行时生成写到临时文件的, 早先靠
//   `webPreferences: { nodeIntegration: true, contextIsolation: false }` 让页内内联脚本
//   `require('electron')` 直接取 ipcRenderer 回传结果。但在 Electron 38 上这条路实测拿到的
//   ipcRenderer 是**空壳**(typeof 是 object, 但 send 不可用/或与主进程通道对不上) ——
//   表现为: 真实鼠标点击能正常打到按钮上(事件都收到了)却毫无反应, 且 Esc / ✕ 也一并失效。
//   sandbox:false 能让 require 返回对象, 但对象里没有可用的 ipcRenderer, 所以那条路修不动。
// 正解 = 官方推荐姿势: sandbox 保持默认(true) + contextIsolation:true + 本 preload 用
//   contextBridge 把两个通道白名单式暴露给页面。preload 在沙箱内仍可正常用 ipcRenderer。
// ─────────────────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('fntvDialog', {
    /** 回传用户所选按钮下标(窗口据此 resolve) */
    result: (id: string, index: number): void => {
        try { ipcRenderer.send('fntv-app-dialog:result', id, index); } catch { /* ignore */ }
    },
    /** 回传渲染层量得的卡片真实高度(主进程据此重设窗口高度, 内容自适应) */
    fit: (id: string, height: number): void => {
        try { ipcRenderer.send('fntv-app-dialog:fit', id, height); } catch { /* ignore */ }
    },
});
