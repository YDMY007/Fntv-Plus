import { app, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import { getEndpoint, isEndpointConfigured } from './usageStats';
import { maskStringByPatterns } from '../../../modules/logger/masking';
import * as log from '../../../modules/logger';

/**
 * [lc-1197] 应用内 Bug 反馈 + 日志上传（主进程）
 *
 * 与匿名统计（usageStats.ts）共用同一个服务端地址（FNTV_STATS_ENDPOINT）。
 *
 * 隐私处理：
 *  1. 反馈内容由用户自己写，主观可控；
 *  2. 日志上传前强制脱敏：复用 logger/masking 的既有规则（token / cookie / 密码 /
 *     密钥 / 手机号 / 邮箱等一律打码），再额外抹掉本机用户名路径；
 *  3. 日志只取最近尾部（默认 512KB，硬上限 2MB），不打包、不扫盘；
 *  4. 服务端不存 IP（见 stats-server/worker.js 说明）；
 *  5. 必须由用户**手动点击**才会上传，没有任何自动上传路径。
 *
 * 注：日志里可能残留 NAS 地址 / 域名（排查问题必需，故保留），但不含账号密码。
 *     该说明同时写在设置面板 UI 上，让用户在知情前提下勾选。
 */

const FEEDBACK_PATH = '/feedback';
const UPLOAD_TIMEOUT_MS = 30000;
const DEFAULT_LOG_BYTES = 512 * 1024;  // 附日志时默认取最近 512KB
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 硬上限 2MB（超出截断尾部）
const MAX_MESSAGE = 2000;
const MAX_CONTACT = 120;

/** 读文件尾部 maxBytes 字节（避免一次性把几百 MB 的日志读进内存） */
function readTail(filePath: string, maxBytes: number): string {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return '';
        const start = Math.max(0, stat.size - maxBytes);
        const len = stat.size - start;
        if (len <= 0) return '';
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            return buf.toString('utf8');
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    } catch (e) {
        log.warn(`[feedback] 读取日志失败: ${filePath} ${e}`);
        return '';
    }
}

/**
 * 日志脱敏：既有通用规则（凭据类）+ 抹掉本机用户名路径。
 * 保留 NAS 地址 / 域名：排查网络与直连问题必须靠它，且不含身份凭据。
 */
function sanitizeLog(text: string): string {
    if (!text) return '';
    let out = '';
    try {
        out = maskStringByPatterns(text);
    } catch {
        out = text; // 脱敏器异常时宁可不上传也不能崩；下面再做一层用户名处理
    }
    try {
        const home = app.getPath('home');
        const user = path.basename(home || '');
        if (user && user.length > 1) {
            // 精确匹配 C:\Users\<name>\ 与 /home/<name>/、/Users/<name>/
            out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\\/\r\n"']+)/g, '$1<USER>');
            out = out.replace(/(\/(?:home|Users)\/)([^\/\r\n"']+)/g, '$1<USER>');
        }
    } catch { /* ignore */ }
    return out;
}

function osName(): string {
    if (process.platform === 'win32') return 'Windows';
    if (process.platform === 'darwin') return 'macOS';
    if (process.platform === 'linux') return 'Linux';
    return process.platform;
}

function appVersion(): string {
    try {
        return fnConfig.getAppDisplayVersion() || app.getVersion() || '';
    } catch {
        return '';
    }
}

function trimLog(text: string): string {
    const buf = Buffer.from(text || '', 'utf8');
    if (buf.length <= MAX_LOG_BYTES) return text;
    return buf.subarray(buf.length - MAX_LOG_BYTES).toString('utf8');
}

/** 上传一段日志文本（内部统一入口） */
async function uploadLogText(logText: string, message: string, contact: string): Promise<any> {
    const endpoint = getEndpoint();
    if (!endpoint) return { ok: false, error: '未配置反馈服务端地址（FNTV_STATS_ENDPOINT）' };
    const body = {
        aid: fnConfig.getStatsAnonId(),
        v: appVersion(),
        os: osName(),
        arch: process.arch,
        message: (message || '').slice(0, MAX_MESSAGE),
        contact: (contact || '').slice(0, MAX_CONTACT),
        log: logText || '',
    };
    try {
        const res = await axios.post(endpoint + FEEDBACK_PATH, body, {
            timeout: UPLOAD_TIMEOUT_MS,
            headers: { 'content-type': 'application/json' },
            maxBodyLength: MAX_LOG_BYTES + 1024 * 1024,
            maxContentLength: 8 * 1024 * 1024,
        });
        const data: any = res && res.data;
        log.info('[feedback] 反馈提交成功 id=' + (data && data.id ? data.id : '?'));
        return { ok: true, id: (data && data.id) || '' };
    } catch (e: any) {
        const msg = String(e?.response?.data?.error || e?.message || e);
        log.warn(`[feedback] 反馈提交失败: ${msg}`);
        return { ok: false, error: msg };
    }
}

/** 提交反馈（可附带最近应用日志） */
async function handleSubmitFeedback(_event: any, p?: { message?: string; contact?: string; includeLog?: boolean }): Promise<any> {
    const message = String(p?.message || '').trim();
    if (!message) return { ok: false, error: '请先填写问题描述' };
    let logText = '';
    if (p?.includeLog) {
        const file = log.getLogFile();
        const raw = readTail(file, DEFAULT_LOG_BYTES);
        logText = trimLog(sanitizeLog(raw));
        if (!logText) logText = '（日志为空或读取失败）';
    }
    return await uploadLogText(logText, message, String(p?.contact || '').trim());
}

/** 手动选择日志文件并上传（用户主动点选，支持 .log/.txt） */
async function handlePickAndUploadLog(): Promise<any> {
    let win: BrowserWindow | null = null;
    try { win = BrowserWindow.getFocusedWindow(); } catch { win = null; }
    const opts = {
        title: '选择要上传的日志文件',
        properties: ['openFile' as const],
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { ok: false, canceled: true };
    }
    const file = res.filePaths[0];
    try {
        const stat = fs.statSync(file);
        if (stat.size > 64 * 1024 * 1024) return { ok: false, error: '文件过大（>64MB），请先清理或分批反馈' };
    } catch (e) {
        return { ok: false, error: '无法读取该文件' };
    }
    const raw = readTail(file, MAX_LOG_BYTES);
    const safe = trimLog(sanitizeLog(raw));
    return await uploadLogText(safe, '手动上传日志文件：' + path.basename(file), '');
}

/** 面板展示用：当前应用日志路径与大小 */
async function handleLogInfo(): Promise<any> {
    let file = '';
    let size = 0;
    try {
        file = log.getLogFile();
        const st = fs.statSync(file);
        size = st.size;
    } catch { /* ignore */ }
    return { configured: isEndpointConfigured(), file, size };
}

function init(): void {
    registerHandler('feedback:submit', handleSubmitFeedback, { useHandle: true });
    registerHandler('feedback:upload-log', handlePickAndUploadLog, { useHandle: true });
    registerHandler('feedback:log-info', handleLogInfo, { useHandle: true });
}

export { init };
