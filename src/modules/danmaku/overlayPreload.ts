import { ipcRenderer, contextBridge } from 'electron';

/**
 * 弹幕 overlay 的 preload。
 * 主进程通过 webContents.send 下发 'danmaku-init' / 'danmaku-sync' / 'danmaku-hide'，
 * 这里用 contextBridge 把它们桥接成 window.danmaku，供 overlay HTML 里的 JS 引擎使用。
 * 因为 overlay 窗口 contextIsolation=true、nodeIntegration=false，只有 preload 能碰 ipcRenderer。
 */
contextBridge.exposeInMainWorld('danmaku', {
    onInit: (cb: (data: any) => void) => {
        ipcRenderer.on('danmaku-init', (_e, d) => cb(d));
    },
    onSync: (cb: (data: any) => void) => {
        ipcRenderer.on('danmaku-sync', (_e, d) => cb(d));
    },
    onHide: (cb: () => void) => {
        ipcRenderer.on('danmaku-hide', () => cb());
    },
});
