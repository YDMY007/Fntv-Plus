import { BrowserWindow, ipcMain, dialog } from 'electron';

// 自定义对话框（粉紫亚克力浮层）主进程辅助函数。
// 通过 webContents.send('fnos-dialog:open') 唤起渲染进程浮层，
// 渲染进程 ipcRenderer.send('fnos-dialog:result', id, index, checkboxChecked) 回传结果。

export interface FnosDialogOptions {
    title?: string;
    message?: string;
    detail?: string;
    /** Markdown 更新日志（渲染进程会按 .md-body 样式渲染，优于纯文本 detail） */
    markdown?: string;
    type?: 'none' | 'info' | 'question' | 'error';
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
}

export interface FnosDialogResult {
    response: number;
    checkboxChecked: boolean;
}

type Resolver = (index: number, checked: boolean) => void;

const pending = new Map<string, Resolver>();
let ipcRegistered = false;

/** 注册回传通道，必须在 app ready 后、首次 fnosDialog 调用前调用一次 */
export function initFnosDialogIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.on('fnos-dialog:result', (_event: any, id: string, index: number, checkboxChecked: boolean) => {
        const resolve = pending.get(id);
        if (resolve) {
            pending.delete(id);
            resolve(index, !!checkboxChecked);
        }
    });
}

/** 弹出自定义对话框，返回用户所选按钮 index 与 checkbox 状态 */
export function fnosDialog(win: BrowserWindow | null, opts: FnosDialogOptions): Promise<FnosDialogResult> {
    return new Promise<FnosDialogResult>((resolve) => {
        const id = `dlg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pending.set(id, (index, checked) => resolve({ response: index, checkboxChecked: checked }));

        const target = (win && !win.isDestroyed())
            ? win
            : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;

        if (!target) {
            // 兜底：无可用窗口时用原生 dialog
            dialog.showMessageBox({
                type: opts.type,
                title: opts.title,
                message: opts.message ?? '',
                detail: opts.detail,
                buttons: opts.buttons,
                defaultId: opts.defaultId,
                cancelId: opts.cancelId,
                checkboxLabel: opts.checkboxLabel,
                checkboxChecked: opts.checkboxChecked,
            }).then((r) => resolve({ response: r.response, checkboxChecked: !!r.checkboxChecked }));
            return;
        }

        target.webContents.send('fnos-dialog:open', { id, ...opts });
    });
}
