import { IpcMainEvent, BrowserWindow, session } from 'electron';
import { getMainWindow } from '../../common/mainwin';
import * as fn from '../../../modules/fn_api/api';
import { restoreCookies } from '../../../modules/fn_config/cookie';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';
import { showCertificateTrustDialog, addTrustedHost } from '../../../modules/cert_trust';
import { isFnId, handleFnIdLogin } from './fnid_login';

/**
 * 用户认证插件
 * 处理登录、配置管理、历史记录等功能
 */

interface LoginData {
    domain: string;
    username: string;
    password: string;
    useHttps?: boolean;
    rememberPassword?: boolean;
}

interface HistoryItem {
    domain: string;
    account: string;
}

// 获取配置处理
function handleGetConfig(event: IpcMainEvent): void {
    try {
        const config = fnConfig.readConfig() || {};
        const history = fnConfig.getHistory() || [];
        event.reply('config-data', { config, history });
    } catch (error) {
        log.error('读取配置失败:', error);
        event.reply('config-data', { config: {}, history: [] });
    }
}

// 清除历史记录处理
function handleClearHistory(event: IpcMainEvent): void {
    try {
        fnConfig.clearHistory();
        event.reply('history-cleared');
    } catch (error) {
        log.error('清除历史记录失败:', error);
    }
}

// 删除单个历史记录处理
function handleDeleteHistoryItem(event: IpcMainEvent, { domain, account }: HistoryItem): void {
    try {
        const success = fnConfig.deleteHistoryItem({ domain, account });
        if (success) {
            event.reply('history-item-deleted');
        }
    } catch (error) {
        log.error('删除历史记录项失败:', error);
    }
}

// 用户登录处理
async function handleLogin(event: IpcMainEvent, loginData: LoginData): Promise<void> {
    log.info('Received loginData:', loginData);

    if (!loginData || !loginData.domain || !loginData.username || !loginData.password) {
        log.error('登录失败: 缺少必要的登录信息, loginData:', loginData);
        event.reply('login-error', {
            title: '登录失败',
            message: '请提供完整的登录信息。'
        });
        return;
    }

    // FN ID 登录分支
    if (isFnId(loginData.domain)) {
        log.info('检测到 FN ID 格式，使用 FN Connect OAuth 登录');
        log.key('登录方式 = FN ID (FN Connect OAuth)');
        return handleFnIdLogin(event, loginData);
    }

    // 构建服务器地址（直接使用用户填写的地址，不再猜测/兜底端口：
    // fnOS 影视端口因人而异，且访问码门禁会拦截接口返回 HTML，端口扫描会误判）
    const scheme = loginData.useHttps ? 'https' : 'http';
    const rawDomain = loginData.domain.trim().replace(/^[a-z]+:\/\//i, ''); // 去掉可能误带的协议头
    const server = `${scheme}://${rawDomain}`;
    log.key(`登录方式 = 本地账号 (服务器地址登录) | server=${server}`);

    const fnapi0 = new fn.ApiService(server);
    let response: any = await fnapi0.login(loginData.username, loginData.password);

    try {
        if (!response || !response.success) {
            // 检查是否为证书错误
            if (response && response.certificateError) {
                log.info('检测到证书验证错误，询问用户是否信任');

                // 显示证书信任对话框
                const mainWindow = getMainWindow();
                const shouldTrust = await showCertificateTrustDialog(
                    server,
                    response.message || '未知证书错误',
                    mainWindow
                );

                if (shouldTrust) {
                    // 用户选择信任，添加到信任列表并重试登录
                    addTrustedHost(server);
                    log.info('用户信任证书，重试登录');

                    // 递归调用重试登录
                    return handleLogin(event, loginData);
                } else {
                    // 用户不信任，返回错误
                    event.reply('login-error', {
                        title: '登录取消',
                        message: '用户取消信任证书，无法继续登录。'
                    });
                    return;
                }
            }

            // 访问码门禁：登录接口返回网页(HTML)而非 JSON，通常是服务器开了访问码，
            // 主进程接口调用没有交互网页输访问码导致。弹出真实浏览器窗口让用户输访问码后重试。
            if (response && response.htmlResponse) {
                log.key(`登录被访问码门禁拦截(返回HTML) | server=${server}`);
                return openAccessCodeFlow(event, loginData, server);
            }

            const msg = response ? response.message : '未知错误';
            log.error('登录失败:', msg);
            log.key(`登录失败 (本地账号) | server=${server} | ${msg}`);
            event.reply('login-error', {
                title: '登录失败',
                message: msg || '登录时发生未知错误，请稍后重试。'
            });
            return;
        }

        // 登录成功：提取 token 并收尾（统一封装，供访问码重试复用）
        return finalizeLocalLogin(event, loginData, server, response);
    } catch (error) {
        log.error('登录请求失败:', error);
        event.reply('login-error', {
            title: '连接失败',
            message: '无法连接到服务器，请检查域名是否正确或网络连接是否正常。'
        });
    }
}

/**
 * 本地账号登录成功后的统一收尾：提取 token、存配置/历史、恢复 cookie、加载 /v。
 * 同时处理「success 但无 token」(接口把 HTML 当 success 透传)的情况。
 * 供首次登录与访问码重试共用。
 */
async function finalizeLocalLogin(event: IpcMainEvent, loginData: LoginData, server: string, response: any): Promise<void> {
    server = response.moveUrl || server;
    const token = response.data?.token;
    if (!token) {
        // 详细记录服务端原始响应，便于定位"success 但无 token"的真实原因
        let dataPreview: string;
        try {
            dataPreview = typeof response.data === 'string'
                ? response.data.slice(0, 200)
                : JSON.stringify(response.data).slice(0, 500);
        } catch { dataPreview = '<无法序列化>'; }
        log.error('登录失败: 接口返回成功但缺少 token，无法恢复 cookies');
        log.error('登录失败详情 → success:', response.success,
            '| message:', response.message,
            '| moveUrl:', response.moveUrl,
            '| dataType:', typeof response.data,
            '| dataPreview:', dataPreview);

        let detail: string;
        if (typeof response.data === 'string') {
            // 接口把 HTML/错误页当 success 透传过来，data 是字符串。精准区分两类根因：
            const html = response.data.toLowerCase().slice(0, 2000);
            const isLoginPage = /(<input[^>]*type=["']?password|password|登录|sign\s*in|signin|fn\s*id|fnid|oauth|授权登录|账号|用户名)/.test(html);
            const isServerPage = /(404 not found|502 bad gateway|503 service|nginx|upstream|proxy error|网关|内部错误|服务器错误|<div[^>]*id=["'](app|root)["']|id=["']app["'])/.test(html);
            if (isLoginPage) {
                detail = '服务器返回的是登录页（HTML 网页），而非登录接口数据。原因几乎都是「未使用 FN ID 登录」或「FN ID 会话已过期」——飞牛影视接口需要 FN ID 会话 Cookie，用内网 IP 走本地账号登录拿不到它。👉 请在登录框填写你的 FN ID（6–30 位、不含点的飞牛 ID，不要填内网 IP）走 FN ID 登录；若之前能进现在报错，重新走一次 FN ID 登录即可。';
            } else if (isServerPage) {
                detail = '服务器返回的是网页首页/错误页（HTML），而非登录接口数据。说明服务器地址或端口填错，请求打到了网页而非飞牛影视接口。👉 请检查登录框里的「服务器地址」——内网应填 http://IP:端口（端口因人而异，请填你 NAS 上飞牛影视实际监听的端口，默认通常为 18888），确认 IP 正确、端口没漏填、没有多余的路径或域名后缀。';
            } else {
                detail = '服务器返回的不是接口数据（可能是登录页或错误网页）。请检查服务器地址/IP:端口 是否正确（接口应返回 JSON），以及是否应使用 FN ID 登录或重新登录（会话可能已过期）。';
            }
        } else if (response.message) {
            detail = response.message;
        } else {
            detail = '登录接口返回成功但未包含 token。可能该账号需要使用 FN ID 方式登录，或账号/密码有误。';
        }
        event.reply('login-error', { title: '登录失败', message: detail });
        return;
    }
    log.info('登录成功 token:', token);
    log.key(`登录成功 | server=${server}`);

    // 保存登录信息
    const { saveConfig, addHistory } = require('../../../modules/fn_config/config');

    // 保存配置
    saveConfig({
        account: loginData.username,
        domain: server,
        token: response.data.token,
        useHttps: loginData.useHttps
    });

    // 添加到登录历史（仅当用户勾选"记住密码"时持久化密码）
    addHistory({
        domain: loginData.domain,
        account: loginData.username,
        password: loginData.rememberPassword ? loginData.password : '',
        useHttps: loginData.useHttps
    });

    // 跳转到主页
    const mainWindow = getMainWindow();
    if (mainWindow) {
        log.info('恢复登录状态，即将跳转到主页面, domain:', server);
        const success = await restoreCookies(server, token, true);
        if (success) {
            mainWindow.loadURL(`${server}/v`);
            mainWindow.show();
            mainWindow.focus();
        } else {
            event.reply('login-error', {
                title: '登录失败',
                message: '无法恢复登录状态，请重新登录。'
            });
        }
    }
}

/**
 * [访问码门禁修复] 本地账号登录被访问码拦截(接口返回HTML)时，弹真实浏览器窗口让用户输访问码。
 * 用户在网页里输访问码 → 授权 cookie 写入 persist:fntv 会话(与主窗口共享) → 
 * 检测到 cookie 变化后立即关闭弹窗、直接导航主窗口到 /v(cookie 已在会话中, /v 应能加载)，
 * 后台继续用 Cookie 头重试 login API 拿 token(供后续 XHR 调用认证); 拿不到也不阻塞用户进影视页。
 */
async function openAccessCodeFlow(event: IpcMainEvent, loginData: LoginData, server: string): Promise<void> {
    log.info(`[访问码] 打开浏览器窗口让用户输入访问码: ${server}`);
    const accessWin = new BrowserWindow({
        width: 900,
        height: 720,
        title: '请输入访问码以登录飞牛影视',
        backgroundColor: '#ffffff',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: 'persist:fntv', // 与影视 webview / 主窗口同一会话，cookie 直接共享
        }
    });
    accessWin.loadURL(server);
    accessWin.once('ready-to-show', () => accessWin.show());

    const fntvSession = session.fromPartition('persist:fntv');
    const readCookieHeader = async (): Promise<string> => {
        const cookies = await fntvSession.cookies.get({ url: server });
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    };

    const baseline = await readCookieHeader();
    let lastSig = baseline;
    let done = false;
    let navigated = false; // 是否已导航主窗口到 /v
    let ticks = 0;
    const MAX_TICKS = 45; // ~90s 超时

    log.key(`[访问码] 已打开访问码输入窗口，请在浏览器中输入访问码，登录将自动继续`);

    // 后台尝试登录 API 拿 token（不阻塞主窗口导航）
    const tryLoginForToken = async (cookieHeader: string): Promise<boolean> => {
        try {
            const fnapi = new fn.ApiService(server);
            const resp = await fnapi.login(loginData.username, loginData.password, { Cookie: cookieHeader });
            if (resp && resp.success) {
                log.key(`[访问码] 登录 API 成功拿到 token，恢复登录状态`);
                // 异步收尾：存配置/历史 + restoreCookies + 重载 /v(带 token)
                finalizeLocalLogin(event, loginData, server, resp).catch(err => {
                    log.error('[访问码] finalizeLocalLogin 异步失败:', err);
                });
                return true;
            }
            if (!resp?.htmlResponse) {
                log.warn(`[访问码] 登录 API 返回业务错误(非 HTML): ${resp?.message}`);
            }
            return false;
        } catch (err) {
            log.error(`[访问码] 登录 API 异常:`, err);
            return false;
        }
    };

    const timer = setInterval(async () => {
        if (done) { clearInterval(timer); return; }
        if (accessWin.isDestroyed()) {
            finish('访问码输入窗口已关闭，登录取消。若服务器开了访问码，请重新登录并在弹窗中输入访问码，或改用 FN ID 登录。', '已取消');
            return;
        }
        ticks++;
        const sig = await readCookieHeader();
        if (sig === lastSig) {
            if (ticks >= MAX_TICKS) {
                finish('在浏览器中输入访问码后登录未能自动继续。请确认访问码正确，或改用 FN ID 登录。', '访问码输入超时');
            }
            return;
        }
        // ★ cookie 变化：用户已输入访问码
        lastSig = sig;
        log.key(`[访问码] 检测到 cookie 变化，开始处理...`);

        // 1. 立即关闭访问码弹窗
        if (!accessWin.isDestroyed()) accessWin.close();

        // 2. 立即导航主窗口到 /v（persist:fntv 会话已有授权 cookie，/v 应能直接加载）
        if (!navigated) {
            navigated = true;
            const mainWindow = getMainWindow();
            if (mainWindow) {
                log.info(`[访问码] 导航主窗口到 ${server}/v`);
                mainWindow.loadURL(`${server}/v`);
                mainWindow.show();
                mainWindow.focus();
            }
        }

        // 3. 后台尝试登录 API 拿 token（不阻塞）
        tryLoginForToken(sig);

        // 4. 再等几轮看 cookie 是否还有变化（可能 /v 加载后也设新 cookie），
        //    同时给登录 API 多次机会（每次 cookie 变化都重试）
        //    但不再卡住用户——主窗口已经去了 /v
        if (ticks >= MAX_TICKS) {
            // 超时但主窗口已导航，静默结束轮询（不弹错误打扰用户）
            done = true;
            clearInterval(timer);
            log.info('[访问码] 轮询超时，但主窗口已导航到 /v（若页面功能异常请用 FN ID 登录）');
        }
    }, 2000);

    function finish(message: string, title: string): void {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (!accessWin.isDestroyed()) accessWin.close();
        // 仅在未导航过主窗口时才报错（若已导航到 /v，不打扰用户）
        if (!navigated) {
            event.reply('login-error', { title, message });
        }
    }

    accessWin.on('closed', () => {
        if (!done) finish('访问码输入窗口已关闭，登录取消。若服务器开了访问码，请重新登录并在弹窗中输入访问码，或改用 FN ID 登录。', '已取消');
    });
}

// 注册认证相关处理器
function init(): void {
    registerHandler('get-config', handleGetConfig);
    registerHandler('clear-history', handleClearHistory);
    registerHandler('delete-history-item', handleDeleteHistoryItem);
    registerHandler('login', handleLogin);
}

export {
    init
};
