import { shell, app } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 应用信息 / 外部链接打开 插件
 * - app:open-external  → 用系统默认浏览器打开 URL
 * - app:info           → 返回应用名称、版本、仓库地址等
 * - app:qr-image       → 返回关于弹窗二维码图片(base64 data URI)
 */

const APP_REPO_URL = 'https://github.com/YDMY007/fnos-tv';
const APP_NAME = '飞牛影视';

/** 候选二维码图片路径(dev / 打包)，取首个存在者 */
function resolveQrImagePath(): string | null {
    const candidates: string[] = [];
    const appPath = app.getAppPath();
    candidates.push(path.join(appPath, 'build', 'qrcode.png'));
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'build', 'qrcode.png'));
    }
    // 编译产物位置回退: dest/main/handlers/plugins → 项目根
    candidates.push(path.join(__dirname, '..', '..', '..', 'build', 'qrcode.png'));
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function handleQrImage(_event: Electron.IpcMainInvokeEvent): { ok: boolean; dataUri?: string; error?: string } {
    const p = resolveQrImagePath();
    if (!p) return { ok: false, error: '未找到二维码图片(build/qrcode.png)' };
    try {
        const buf = fs.readFileSync(p);
        const dataUri = 'data:image/png;base64,' + buf.toString('base64');
        return { ok: true, dataUri };
    } catch (e: any) {
        return { ok: false, error: e.message || '读取二维码失败' };
    }
}

function handleOpenExternal(_event: Electron.IpcMainInvokeEvent, url: string): { ok: boolean; error?: string } {
    if (!url || typeof url !== 'string') {
        return { ok: false, error: '无效的 URL' };
    }
    try {
        shell.openExternal(url);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e.message || '打开链接失败' };
    }
}

function handleAppInfo(_event: Electron.IpcMainInvokeEvent): Record<string, string> {
    try {
        const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return {
            name: APP_NAME,
            version: pkg.version || 'unknown',
            repoUrl: APP_REPO_URL,
            description: pkg.description || '',
        };
    } catch {
        return {
            name: APP_NAME,
            version: 'unknown',
            repoUrl: APP_REPO_URL,
            description: '',
        };
    }
}

function init(): void {
    registerHandler('app:open-external', handleOpenExternal, { useHandle: true });
    registerHandler('app:info', handleAppInfo, { useHandle: true });
    registerHandler('app:qr-image', handleQrImage, { useHandle: true });
    log.info('应用信息插件已加载');
}

export {
    init
};
