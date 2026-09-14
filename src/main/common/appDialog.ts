import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// appDialog.ts — [lc-1057] 主进程侧自定义弹窗（渐变玻璃风格，替代古老的 dialog.showMessageBox）
// ─────────────────────────────────────────────────────────────────────────────
// 用途：主进程需要弹窗但**没有可用渲染窗口**的场景——
//   · 「程序已在运行」(second-instance, 更新后旧进程未退出时用户会见到 = 更新退出弹窗)
//   · 「安装路径不兼容」(启动期主窗未建)
//   · 「Proxy 多次启动失败，应用即将退出」(proxyDaemon)
//   · 「官方中继连接失败」(fnid_login)
// 实现独立小窗：frameless+transparent 圆角卡（与渲染端 dialogUI.ts 同一套渐变玻璃视觉），
//   HTML 按调用参数即时生成写到临时目录，nodeIntegration 让内联脚本直接回传所选按钮。
// 生命周期：点击按钮 → 隐藏窗口并 resolve(index)，2s 后销毁（延迟销毁防止
//   window-all-closed 提前触发 app.quit 打断「继续运行」分支）；窗口被外部关闭 →
//   按 cancelId(缺省 defaultId) 兜底 resolve。
// ─────────────────────────────────────────────────────────────────────────────

export interface AppDialogOptions {
    title: string;
    message?: string;
    detail?: string;
    type?: 'info' | 'error' | 'warn' | 'question';
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
}

let ipcReady = false;
const pending = new Map<string, (index: number) => void>();
const fitWindows = new Map<string, BrowserWindow>();

function ensureIpc(): void {
    if (ipcReady) return;
    ipcReady = true;
    ipcMain.on('fntv-app-dialog:result', (_e: any, id: string, index: number) => {
        const r = pending.get(id);
        if (r) { pending.delete(id); r(index); }
    });
    // [lc-1158] 渲染层量得的卡片真实高度 → 重设窗口高度(内容自适应, 根治估算失准导致
    // 卡片被裁、按钮落到窗口外「点了没反应」)。夹在 220 ~ 屏幕workArea高-80; 一条消息只认一次。
    ipcMain.on('fntv-app-dialog:fit', (e: any, id: string, h: number) => {
        const win = fitWindows.get(id);
        if (!win || win.isDestroyed() || win.webContents.id !== e.sender.id) return;
        const maxH = Math.max(280, screen.getPrimaryDisplay().workAreaSize.height - 80);
        const target = Math.max(220, Math.min(maxH, Math.ceil(h)));
        const [w] = win.getSize();
        const cur = win.getContentSize()[1];
        // 高度差 ≥4 才动, 防 ResizeObserver 抖动来回重设
        if (Math.abs(cur - target) >= 4) win.setContentSize(w, target);
        fitWindows.delete(id);   // 自适应只做一轮; 超限走内部滚动
    });
}

const ICON: Record<string, { chr: string; color: string }> = {
    info: { chr: 'ℹ', color: '#5b8def' },
    question: { chr: '?', color: '#6d7ff2' },
    error: { chr: '⚠', color: '#e06a5b' },
    warn: { chr: '!', color: '#d4880a' },
};

function esc(s: string): string {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 按调用参数生成完整弹窗页（独立可测：playwright 直接渲染本输出做视觉验证） */
export function buildAppDialogHtml(opts: AppDialogOptions, id: string): string {
    const type = opts.type || 'info';
    const icon = ICON[type] || ICON.info;
    const buttons = opts.buttons && opts.buttons.length ? opts.buttons : ['确定'];
    const defaultId = opts.defaultId ?? 0;
    const btns = buttons.map((label, index) => {
        const isDefault = index === defaultId;
        return `<button data-index="${index}" style="
            border:${isDefault ? 'none' : '1px solid rgba(109,127,242,.45)'};
            background:${isDefault ? 'linear-gradient(135deg,#6d7ff2,#8a63e8)' : 'rgba(255,255,255,.6)'};
            color:${isDefault ? '#fff' : '#3d4a6e'};
            font-size:13px;font-weight:600;padding:9px 18px;border-radius:10px;cursor:pointer;outline:none;
            transition:transform .12s ease, box-shadow .12s ease;
            box-shadow:${isDefault ? '0 6px 16px rgba(109,127,242,.4)' : 'none'};
            font-family:inherit;">${esc(label)}</button>`;
    }).join('');
    const detail = opts.detail
        ? `<div style="font-size:12.5px;color:#737d99;line-height:1.6;max-height:170px;overflow-y:auto;
            white-space:pre-line;background:rgba(255,255,255,.55);border-radius:10px;padding:10px 12px;
            margin-bottom:6px;">${esc(opts.detail)}</div>`
        : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html { background:transparent; }
        /* [lc-1158] 窗口被屏幕高度封顶后内容可内部滚动(按钮必须始终可达) */
        body { background:transparent; overflow-y:auto; overflow-x:hidden;
            font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif; }
        body { display:flex; align-items:center; justify-content:center; height:100vh; }
        .card { position:relative; width:calc(100vw - 28px);
            background:linear-gradient(165deg,rgba(250,251,254,.98),rgba(240,243,250,.99));
            border-radius:16px; padding:22px 22px 18px; color:#2f3550;
            box-shadow:0 18px 50px rgba(40,52,110,.30), inset 0 0 0 1px rgba(255,255,255,.6), inset 0 1px 0 rgba(255,255,255,.85);
            animation:fntv-ad-in .18s cubic-bezier(.22,.61,.36,1) both; }
        @keyframes fntv-ad-in { from { opacity:0; transform:scale(.96); } to { opacity:1; transform:scale(1); } }
        .head { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
        .ic { flex:0 0 auto; width:34px; height:34px; border-radius:50%; display:flex;
            align-items:center; justify-content:center; font-size:19px; font-weight:700; color:#fff;
            background:${icon.color}; box-shadow:0 4px 12px ${icon.color}55; }
        .title { font-size:17px; font-weight:700; color:#262c44; line-height:1.3; }
        .msg { font-size:14px; color:#3d445e; line-height:1.55; margin-bottom:6px; white-space:pre-line; }
        .foot { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
        .foot button:hover { transform:translateY(-1px); }
    </style></head><body>
        <div class="card">
            <button id="fntv-ad-x" title="关闭（等同 Esc）" style="
                position:absolute; top:8px; right:10px; width:26px; height:26px; padding:0;
                border:none; border-radius:8px; background:transparent; color:#8a93ad;
                font-size:15px; line-height:1; cursor:pointer; font-family:inherit;">✕</button>
            <div class="head">
                <div class="ic">${icon.chr}</div>
                <div class="title">${esc(opts.title)}</div>
            </div>
            ${opts.message ? `<div class="msg">${esc(opts.message)}</div>` : ''}
            ${detail}
            <div class="foot">${btns}</div>
        </div>
        <script>
            const { ipcRenderer } = require('electron');
            const buttons = document.querySelectorAll('button[data-index]');
            const send = (i) => { try { ipcRenderer.send('fntv-app-dialog:result', '${id}', i); } catch (e) {} };
            buttons.forEach((b) => b.addEventListener('click', () => send(Number(b.dataset.index))));
            // [lc-1159] 本窗口 frame:false 没有系统关闭钮, 且 alwaysOnTop+skipTaskbar 让任务栏
            // 也找不到它 → 补一个显式「✕」入口, 语义等同 Esc / cancelId。
            const x = document.getElementById('fntv-ad-x');
            if (x) x.addEventListener('click', () => send(${opts.cancelId ?? opts.defaultId ?? 0}));
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') send(${opts.cancelId ?? opts.defaultId ?? 0});
            });
            // [lc-1158] 内容自适应回传: 估算高度在很多环境(高 DPI 字体缩放/不同 fallback 字体)
            // 下会低估, 卡片被垂直居中裁切 → 按钮落到窗口外 → 「按钮点击无反应」。
            // 渲染层量出卡片真实高度后回传, 主进程据此重设窗口高度(夹在 220~屏高-80)。
            new ResizeObserver(() => {
                try {
                    const h = Math.ceil(document.querySelector('.card').getBoundingClientRect().height) + 28;
                    ipcRenderer.send('fntv-app-dialog:fit', '${id}', h);
                } catch (e) {}
            }).observe(document.querySelector('.card'));
        </script>
    </body></html>`;
}

/** 高度按文案行数粗估：标题/按钮固定开销 + message/detail 行数（clamp 260~620） */
function estimateHeight(opts: AppDialogOptions): number {
    const wrapLines = (text: string | undefined, perLine: number): number =>
        !(text || '').trim() ? 0 : text!.split('\n')
            .reduce((acc, seg) => acc + Math.max(1, Math.ceil(seg.length / perLine)), 0);
    const msgLines = wrapLines(opts.message, 28);
    const detailLines = opts.detail ? wrapLines(opts.detail, 46) : 0;
    const h = 150 + msgLines * 22 + (opts.detail ? Math.min(170, detailLines * 19 + 24) : 0) + 62;
    return Math.max(260, Math.min(620, h));
}

/** 弹出主进程侧渐变玻璃弹窗，resolve 用户所选按钮 index（窗口被外部关闭 = cancelId ?? defaultId）
 *  [lc-1158] 逃生口（按钮失灵时不许把用户锁死）：标题栏关闭钮(weak closable=true) +
 *  Esc(页面内) + Alt+F4/系统关闭 全部按 cancelId ?? defaultId 兜底 resolve；
 *  超时保险 120s 自动按 cancelId 关闭——弹窗永远不能成为永久锁。 */
export function appDialog(opts: AppDialogOptions): Promise<number> {
    return new Promise<number>((resolve) => {
        ensureIpc();
        const id = `dlg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let win: BrowserWindow | null = null;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        const done = (index: number): void => {
            if (!pending.has(id)) return; // 已 resolve 过
            pending.delete(id);
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            fitWindows.delete(id);
            try { if (win && !win.isDestroyed()) { win.hide(); win.destroy(); } } catch { /* ignore */ }
            resolve(index);
        };
        pending.set(id, (index) => done(index));

        const html = buildAppDialogHtml(opts, id);
        const file = path.join(app.getPath('temp'), `fntv-app-dialog-${id}.html`);
        try { fs.writeFileSync(file, html); } catch (e) {
            // 临时文件写失败（极端）→ 原生 dialog 兜底
            const { dialog } = require('electron');
            dialog.showMessageBox({ type: 'info', title: opts.title, message: opts.message || opts.title, detail: opts.detail, buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId })
                .then((r: any) => resolve(r.response));
            return;
        }

        win = new BrowserWindow({
            width: 470,
            height: estimateHeight(opts),
            useContentSize: true,
            frame: false,
            transparent: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            show: false,
            center: true,
            backgroundColor: '#00000000',
            // [lc-1158] closable=true: Win11 任务栏悬停/Alt+F4 走原生关闭路径 → 'close' 事件
            // (frameless 下系统关不掉无框窗? 实测 closable 仍允许任务管理器之外的常规关闭消息到达)
            closable: true,
            // [lc-1159] sandbox 必须显式关掉！Electron 20+ 渲染进程默认 sandbox=true,
            // 而沙箱下 nodeIntegration 会被**静默忽略** → 页内脚本的 require('electron')
            // 直接抛错(被 catch 吞掉), 表现为「两个按钮点了都没反应 + Esc 无效 + 关不掉」。
            // 本弹窗没有 preload(HTML 即时生成写临时文件), 只能靠 nodeIntegration 回传结果,
            // 所以这里必须 sandbox:false。(主窗口有 preload, 走的是 preload 通道, 不受影响)
            webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
        });
        // [lc-1158] 原生 close 拦截 → 按 cancel 兜底 resolve(等效于页面 Esc)。
        // 之前只在 'closed'(窗口已销毁) 兜底, 而 closable=false 时系统根本发不出关闭,
        // closable=true 后 'close' 才是真正的逃生通道; preventDefault 后自己走 done。
        win.on('close', (e: any) => {
            if (pending.has(id)) {
                e.preventDefault();
                done(opts.cancelId ?? opts.defaultId ?? 0);
            }
        });
        win.on('closed', () => {
            // 窗口被外部手段强杀（任务管理器等，'close' 没机会拦）→ 按 cancel 兜底
            if (pending.has(id)) { pending.delete(id); resolve(opts.cancelId ?? opts.defaultId ?? 0); }
        });
        fitWindows.set(id, win);
        void win.loadFile(file);
        win.once('ready-to-show', () => { win.show(); win.focus(); });
        // [lc-1158] 超时保险: 120s 无选择自动按 cancelId 关闭(按钮失灵/渲染层挂死也不锁死用户)
        timeoutTimer = setTimeout(() => {
            if (pending.has(id)) {
                try { if (win && !win.isDestroyed()) { win.hide(); win.destroy(); } } catch { /* ignore */ }
                pending.delete(id);
                resolve(opts.cancelId ?? opts.defaultId ?? 0);
            }
        }, 120 * 1000);
    });
}
