import { BrowserWindow, screen } from 'electron';
import * as logger from '../../../modules/logger';
const log = logger.component('potbar');

/**
 * PotPlayer 悬浮控制条
 * PotPlayer 是外部原生进程，无法在它自己的窗口里塞按钮；而它的 CLI 又只支持
 * /Current /play|/pause，不支持对运行实例切集。为提供「在软件里手动切集」的能力，
 * 这里在屏幕底部中央浮一个【始终置顶、无边框、半透明】的小控制条，
 * 含「上一集 / 下一集」按钮：点一下经 IPC 转发到 media.controlCurrentPlayer，
 * 最终落到 PotPlayer.switchTo() 在现有窗口内切集（与自动连播同一机制，秒切不重载）。
 * 仅当 PotPlayer 正在播多集时显示；MPV 自带 OSC 按钮，不显示本控制条。
 */

let barWin: BrowserWindow | null = null;

// 控制条内联 HTML（data: URL 加载，内部受信内容，故开 nodeIntegration 以直连 ipcRenderer）
const BAR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; background: transparent;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; overflow: hidden; }
  #bar { display: flex; gap: 8px; align-items: center; justify-content: center; height: 100%; }
  button { display: flex; align-items: center; gap: 6px; color: #fff;
    background: rgba(18, 18, 22, 0.78); border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 11px; padding: 8px 15px; font-size: 13px; cursor: pointer;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    transition: background .15s, transform .1s; user-select: none; }
  button:hover { background: rgba(54, 122, 255, 0.9); }
  button:active { transform: scale(0.96); }
  button:disabled { opacity: 0.32; cursor: default; background: rgba(18, 18, 22, 0.78); }
  .arw { font-size: 14px; line-height: 1; }
</style>
</head>
<body>
  <div id="bar">
    <button id="prev"><span class="arw">&#9664;</span> 上一集</button>
    <button id="next">下一集 <span class="arw">&#9654;</span></button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');
    prev.onclick = () => ipcRenderer.send('pot-control', 'prev');
    next.onclick = () => ipcRenderer.send('pot-control', 'next');
    // 主进程回传当前集序号，刷新按钮禁用态
    ipcRenderer.on('pot-episode', (_e, d) => {
      if (!d) return;
      prev.disabled = d.index <= 0;
      next.disabled = d.index >= d.total - 1;
    });
  </script>
</body>
</html>`;

const BAR_W = 248;
const BAR_H = 48;

/**
 * 显示（或刷新）悬浮控制条。
 * @param total 总集数
 * @param index 当前集索引（0 基）
 */
export function showPotPlayerControlBar(total: number, index: number): void {
    if (barWin) {
        updatePotPlayerControlBar(index, total);
        if (!barWin.isVisible()) barWin.showInactive();
        return;
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
        width: BAR_W,
        height: BAR_H,
        x: Math.floor((width - BAR_W) / 2),
        y: height - BAR_H - 28,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        // 不抢焦点：点击按钮时 PotPlayer 仍保持前台播放；但按钮点击事件照常派发
        focusable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BAR_HTML));
    // 'screen-saver' 层级：即便 PotPlayer 全屏也能浮在其上
    win.setAlwaysOnTop(true, 'screen-saver');
    win.on('closed', () => { barWin = null; });

    barWin = win;
    log.info(`[potbar] 已显示悬浮控制条（${total} 集，当前第 ${index + 1} 集）`);

    // 窗口就绪后再下发初始禁用态
    win.webContents.on('did-finish-load', () => updatePotPlayerControlBar(index, total));
}

/**
 * 刷新控制条按钮禁用态（边界）。窗口不存在时静默忽略。
 */
export function updatePotPlayerControlBar(index: number, total: number): void {
    if (!barWin) return;
    barWin.webContents.send('pot-episode', { index, total });
}

/**
 * 隐藏并销毁悬浮控制条（播放结束 / 切到非 PotPlayer / 退出时调用）。
 */
export function hidePotPlayerControlBar(): void {
    if (barWin) {
        barWin.close();
        barWin = null;
        log.info('[potbar] 已隐藏悬浮控制条');
    }
}
