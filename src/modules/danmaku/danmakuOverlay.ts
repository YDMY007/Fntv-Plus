import { BrowserWindow, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import log from '../logger';
import { getOverlayHtml } from './overlayTemplate';
import { DanmakuItem } from './biliDanmaku';

interface PlayerRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface ShowOpts {
    items: DanmakuItem[];
    seek: number;       // 续播起点(秒)
    duration: number;   // 总时长(秒)
    potctlPath: string | null; // 用于查询 PotPlayer 矩形与播放进度
}

/**
 * 弹幕 overlay 管理器（单例）。
 *
 * 思路：不再把 B站弹幕塞进 PotPlayer 的【字幕轨道】（会和真实字幕互相争抢显示位，
 * 且 PotPlayer 默认只显示一个 /sub 轨道），而是新建一个【透明、无边框、置顶、
 * 鼠标穿透】的 BrowserWindow，浮在 PotPlayer 窗口之上，用 HTML/CSS 渲染弹幕。
 *
 *  - 位置：每秒通过 potctl info 拿到 PotPlayer 主窗口矩形，setBounds 对齐；PotPlayer
 *    移动/缩放时 overlay 自动跟随。potctl 不可用时回退到主屏全屏。
 *  - 时钟：主进程把 PotPlayer 播放进度(position/state)周期性下发给渲染端，渲染端
 *    用自身 rAF 时钟驱动弹幕，和 PotPlayer 进度对齐，与字幕轨道彻底解耦。
 */
class DanmakuOverlay {
    private win: BrowserWindow | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private potctlPath: string | null = null;
    private htmlPath: string = '';
    private ready: boolean = false;
    private lastPayload: any = null;

    show(opts: ShowOpts): void {
        this.potctlPath = opts.potctlPath;
        this.ensureHtml();

        this.lastPayload = {
            items: opts.items,
            seek: opts.seek,
            duration: opts.duration,
            fontSize: 0,      // 0 = 渲染端按窗口高度自适应
            opacity: 0.9,
            scrollDur: 9000,
            fixDur: 4500,
        };

        if (!this.win) {
            this.win = new BrowserWindow({
                width: 800,
                height: 450,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                alwaysOnTop: true,
                skipTaskbar: true,
                resizable: false,
                hasShadow: false,
                focusable: false,
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: false,
                    preload: path.join(__dirname, 'overlayPreload.js'),
                },
            });
            this.ready = false;
            this.win.setIgnoreMouseEvents(true); // 鼠标穿透，点击落到 PotPlayer
            this.win.loadFile(this.htmlPath);
            this.win.webContents.once('did-finish-load', () => {
                this.ready = true;
                if (this.lastPayload) this.win?.webContents.send('danmaku-init', this.lastPayload);
            });
            this.win.webContents.on('did-fail-load', () => {
                log.warn('[overlay] 弹幕层页面加载失败');
            });
            this.win.on('closed', () => { this.win = null; this.ready = false; });
        } else if (this.ready) {
            // 已加载：直接复用窗口重新下发（连播切集）
            this.win.webContents.send('danmaku-init', this.lastPayload);
        }

        if (this.win) {
            this.win.showInactive();               // 不抢焦点，PotPlayer 保持前台
            // 'screen-saver' 是最高常用层级，压过 PotPlayer 播放时的置顶；
            // 默认 setAlwaysOnTop(true) 层级不足会被 PotPlayer 盖住/压到最底。
            this.win.setAlwaysOnTop(true, 'screen-saver');
            try { this.win.setVisibleOnAllWorkspaces(true); } catch (_) { /* ignore */ }
            this.win.moveTop();
        }
        this.positionOnce();
        this.startPoll();
    }

    hide(): void {
        this.stopPoll();
        if (this.win && !this.win.isDestroyed()) {
            try { this.win.webContents.send('danmaku-hide'); } catch (_) { /* ignore */ }
            const w = this.win;
            this.win = null;
            this.ready = false;
            try { w.close(); } catch (_) { /* ignore */ }
        }
    }

    private ensureHtml(): void {
        const dir = path.join(os.tmpdir(), 'fnos-danmaku-overlay');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
        this.htmlPath = path.join(dir, 'overlay.html');
        try {
            fs.writeFileSync(this.htmlPath, getOverlayHtml(), 'utf-8');
        } catch (e) {
            log.warn('[overlay] 写出 HTML 失败:', e);
        }
    }

    private startPoll(): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this.poll(), 1000);
    }

    private stopPoll(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private poll(): void {
        if (!this.win || this.win.isDestroyed()) { this.stopPoll(); return; }
        this.queryPotctl().then((info) => {
            if (!this.win || this.win.isDestroyed()) return;
            if (info && info.found) {
                if (info.rect) {
                    this.applyPhysRect(info.rect as PlayerRect);
                }
                // 持续保持最高层级：PotPlayer 每次点击/切全屏可能重置 z-order
                try { this.win.setAlwaysOnTop(true, 'screen-saver'); this.win.moveTop(); } catch (_) { /* ignore */ }
                this.win.webContents.send('danmaku-sync', {
                    position: Math.floor((info.position || 0) / 1000),
                    state: info.state,
                });
            }
        }).catch(() => { /* ignore */ });
    }

    private positionOnce(): void {
        this.queryPotctl().then((info) => {
            if (!this.win || this.win.isDestroyed()) return;
            let rect: PlayerRect | null =
                (info && info.found && info.rect) ? (info.rect as PlayerRect) : null;
            if (!rect) {
                // 未拿到 PotPlayer 矩形时回退主屏（用 DIP 的 bounds，不需再转换）
                const b = screen.getPrimaryDisplay().bounds;
                try {
                    this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
                } catch (_) { /* ignore */ }
                return;
            }
            this.applyPhysRect(rect);
        }).catch(() => { /* ignore */ });
    }

    /**
     * 把 PotPlayer 的【物理像素】窗口矩形转成 Electron 需要的【逻辑像素(DIP)】再定位。
     * 关键坑：Windows GetWindowRect 返回物理像素，而 BrowserWindow.setBounds 用 DIP；
     * 若系统缩放≠100%（如 125%/150%），直接用物理值会把 overlay 放大到超出播放器、
     * 看起来就"全屏"了。用 screen.screenToDipRect 按窗口所在显示器的缩放换算。
     */
    private applyPhysRect(r: PlayerRect): void {
        if (!this.win || this.win.isDestroyed()) return;
        const pw = r.right - r.left;
        const ph = r.bottom - r.top;
        if (pw <= 0 || ph <= 0) return;

        // GetWindowRect 返回【物理像素】，setBounds 用【逻辑像素(DIP)】。
        // 4K + 175% 缩放下若直接用物理值，窗口会被放大到远超播放器（看起来"全屏"）。
        // 用矩形所在显示器的 scaleFactor 手动换算（比 screenToDipRect 在高分屏上更可靠、可预测）。
        const cx = r.left + pw / 2;
        const cy = r.top + ph / 2;
        let sf = 1;
        try {
            // 找出物理中心点所在的显示器：其 (bounds*scaleFactor) 覆盖该物理点
            const displays = screen.getAllDisplays();
            let hit = displays.find((d) => {
                const s = d.scaleFactor || 1;
                const bx = d.bounds.x * s, by = d.bounds.y * s;
                return cx >= bx && cx < bx + d.bounds.width * s &&
                       cy >= by && cy < by + d.bounds.height * s;
            });
            if (!hit) hit = screen.getPrimaryDisplay();
            sf = hit.scaleFactor || 1;
            const originPhysX = hit.bounds.x * sf;
            const originPhysY = hit.bounds.y * sf;
            const bounds = {
                x: Math.round(hit.bounds.x + (r.left - originPhysX) / sf),
                y: Math.round(hit.bounds.y + (r.top - originPhysY) / sf),
                width: Math.round(pw / sf),
                height: Math.round(ph / sf),
            };
            this.win.setBounds(bounds);
            return;
        } catch (_) { /* 回退：直接用物理值 */ }
        try { this.win.setBounds({ x: r.left, y: r.top, width: pw, height: ph }); } catch (_) { /* ignore */ }
    }

    private queryPotctl(): Promise<any | null> {
        return new Promise((resolve) => {
            if (!this.potctlPath) return resolve(null);
            try {
                const proc = spawn(this.potctlPath, ['info'], {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true,
                });
                let out = '';
                proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                proc.on('close', () => {
                    try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
                });
                proc.on('error', () => resolve(null));
            } catch (_) {
                resolve(null);
            }
        });
    }
}

export const danmakuOverlay = new DanmakuOverlay();
