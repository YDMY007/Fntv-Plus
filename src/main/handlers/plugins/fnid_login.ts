import { BrowserWindow, IpcMainEvent, session } from 'electron';
import { getMainWindow } from '../../common/mainwin';
import { ApiService } from '../../../modules/fn_api/api';
import { request, HttpMethod } from '../../../modules/fn_api/request';
import { isTrusted } from '../../../modules/cert_trust';
import { restoreCookies } from '../../../modules/fn_config/cookie';
import * as fnConfig from '../../../modules/fn_config/config';
import * as log from '../../../modules/logger';

/**
 * 将 oauthSession 中指定域名的所有 cookie 批量复制到主窗口 fntv session.
 *
 * 为什么需要这个函数:
 *   restoreCookies() 只设置 Trim-MC-token + mode=relay 两个 cookie,
 *   但飞牛 OS 的真实会话需要一整套 cookie(session ID, CSRF token 等).
 *   OAuth 流程中 oauthSession(persist:fnid-oauth) 在用户于 NAS /signin 授权后,
 *   自然积累了完整 cookie, 必须全部复制到 fntv session, 否则 /v 会被重定向到登录页.
 */
async function copyAllCookiesToMainSession(
    oauthSession: Electron.Session,
    targetBaseUrl: string
): Promise<number> {
    try {
        const mainSession = session.fromPartition('persist:fntv');
        const cookies = await oauthSession.cookies.get({ domain: '' });
        const targetUrl = new URL(targetBaseUrl);
        const targetHost = targetUrl.hostname;
        let copied = 0;
        for (const c of cookies) {
            const cookieDomain = c.domain?.replace(/^\./, '') || '';
            if (cookieDomain !== targetHost && !targetHost.endsWith('.' + cookieDomain)) {
                continue;
            }
            try {
                await mainSession.cookies.set({
                    url: targetBaseUrl,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    secure: c.secure ?? targetUrl.protocol === 'https:',
                    httpOnly: c.httpOnly ?? false,
                    expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 86400 * 365),
                    sameSite: c.sameSite || 'no_restriction',
                });
                copied++;
            } catch (e) {
                log.warn('[FN ID] cookie 复制失败:', c.name, e);
            }
        }
        log.info(`[FN ID] cookie 批量复制完成: ${copied} 个 (${targetHost} → persist:fntv)`);
        return copied;
    } catch (err) {
        log.error('[FN ID] cookie 批量复制失败:', err);
        return 0;
    }
}

/**
 * FN ID 登录插件
 * 通过 FN Connect OAuth 流程实现 FN ID 登录
 */

interface LoginData {
    domain: string;
    username: string;
    password: string;
    useHttps?: boolean;
}

/**
 * 判断输入是否为 FN ID
 * 规则：不包含 '.'，长度 6-30 位
 */
export function isFnId(domain: string): boolean {
    if (!domain) return false;
    const trimmed = domain.trim();
    return !trimmed.includes('.') && trimmed.length >= 6 && trimmed.length <= 30;
}

/**
 * 构建 FN Connect URL
 * FN ID 归一化为 https://5ddd.com/{fnid}
 */
function buildFnConnectUrl(fnId: string): string {
    return `https://5ddd.com/${fnId.trim()}`;
}

/**
 * 生成注入 WebView 的 JavaScript 脚本
 * 功能：
 * 1. Hook XHR 和 Fetch，拦截 /oauthapi/authorize 响应获取 code
 * 2. 拦截 /sac/rpcproxy/v1/new-user-guide/status 获取 Cookie
 * 3. 在 /login 页面自动填充用户名密码并提交
 * 4. 在 /signin 页面自动点击授权按钮
 * 5. 在非 /login 页面获取 sys_config
 */
function getInjectionScript(username: string, password: string): string {
    return `
        (function() {
            console.log("[fntv-electron] Injecting FN ID Login Interceptor...");

            var AUTO_LOGIN_USER = ${JSON.stringify(username)};
            var AUTO_LOGIN_PASS = ${JSON.stringify(password)};

            function postMessage(payload) {
                try {
                    payload = payload || {};
                    payload.cookie = document.cookie;
                    window.__fntvBridge(JSON.stringify(payload));
                } catch (e) {
                    console.error("[fntv-electron] postMessage error:", e);
                }
            }

            function triggerInput(input, value) {
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                nativeInputValueSetter.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // 在 /login 页面自动填充用户名密码
            if (window.location.href.indexOf('/login') !== -1) {
                setTimeout(function() {
                    var uInput = document.getElementById('username');
                    var pInput = document.getElementById('password');
                    if (uInput && AUTO_LOGIN_USER) {
                        triggerInput(uInput, AUTO_LOGIN_USER);
                        if (AUTO_LOGIN_PASS && pInput) {
                            triggerInput(pInput, AUTO_LOGIN_PASS);
                            // 自动点击登录按钮
                            setTimeout(function() {
                                var btn = document.querySelector('button[type="submit"]');
                                if (btn) btn.click();
                            }, 200);
                        }
                    }
                }, 200);
            }

            // 在 /signin 页面自动点击授权按钮
            if (window.location.href.indexOf('/signin') !== -1) {
                setTimeout(function() {
                    var btns = document.querySelectorAll('button');
                    for (var i = 0; i < btns.length; i++) {
                        if (btns[i].innerText.indexOf('授权') !== -1) {
                            btns[i].click();
                            break;
                        }
                    }
                }, 200);
            }

            // Hook XMLHttpRequest
            var originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                this._method = method;
                this._url = url;
                this._headers = {};
                return originalOpen.apply(this, arguments);
            };

            var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
                this._headers[header] = value;
                return originalSetRequestHeader.apply(this, arguments);
            };

            var originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(body) {
                var self = this;
                var originalOnReadyStateChange = self.onreadystatechange;
                self.onreadystatechange = function() {
                    if (self.readyState === 4) {
                        if (self._url && self._url.indexOf("/oauthapi/authorize") !== -1) {
                            try {
                                var json = JSON.parse(self.responseText || "{}");
                                var code = json && json.data ? json.data.code : null;
                                if (code) {
                                    postMessage({ type: "Response", url: self._url, code: String(code) });
                                } else {
                                    postMessage({ type: "Response", url: self._url, body: self.responseText || "" });
                                }
                            } catch (e) {
                                postMessage({ type: "Response", url: self._url, body: self.responseText || "" });
                            }
                        }
                    }
                    if (originalOnReadyStateChange) {
                        originalOnReadyStateChange.apply(this, arguments);
                    }
                };

                if (this._url && this._url.indexOf("/sac/rpcproxy/v1/new-user-guide/status") !== -1) {
                    postMessage({ type: "XHR", url: this._url, headers: (this._headers || {}) });
                }
                return originalSend.apply(this, arguments);
            };

            // Hook Fetch
            var originalFetch = window.fetch;
            window.fetch = function(input, init) {
                var url = input;
                if (typeof input === 'object' && input.url) {
                    url = input.url;
                }

                if (url && url.indexOf("/sac/rpcproxy/v1/new-user-guide/status") !== -1) {
                    var headers = {};
                    if (init && init.headers) {
                        var h = init.headers;
                        if (h instanceof Headers) {
                            h.forEach(function(value, key) { headers[key] = value; });
                        } else {
                            for (var key in h) {
                                if (h.hasOwnProperty(key)) headers[key] = h[key];
                            }
                        }
                    }
                    postMessage({ type: "XHR", url: url, headers: headers });
                }

                return originalFetch.apply(this, arguments).then(function(response) {
                    if (url && url.indexOf("/oauthapi/authorize") !== -1) {
                        var clone = response.clone();
                        clone.text().then(function(text) {
                            try {
                                var json = JSON.parse(text || "{}");
                                var code = json && json.data ? json.data.code : null;
                                if (code) {
                                    postMessage({ type: "Response", url: url, code: String(code) });
                                } else {
                                    postMessage({ type: "Response", url: url, body: text || "" });
                                }
                            } catch (e) {
                                postMessage({ type: "Response", url: url, body: text || "" });
                            }
                        });
                    }
                    return response;
                });
            };

            // 获取 sys_config（在非 /login 页面执行）
            function fetchSysConfigOnce() {
                try {
                    if (window.__fntv_sys_config_requested) return;
                    if (window.location.href.indexOf('/login') !== -1) return;
                    window.__fntv_sys_config_requested = true;
                    fetch('/v/api/v1/sys/config', { credentials: 'include' })
                        .then(function(r) { return r.text(); })
                        .then(function(text) {
                            postMessage({
                                type: "SysConfig",
                                url: "/v/api/v1/sys/config",
                                body: text || "",
                                pageUrl: String(window.location.href || "")
                            });
                        })
                        .catch(function() {
                            window.__fntv_sys_config_requested = false;
                        });
                } catch (e) {
                    window.__fntv_sys_config_requested = false;
                }
            }

            setTimeout(fetchSysConfigOnce, 800);
            console.log("[fntv-electron] FN ID Login Interceptor Injected.");
        })();
    `;
}

/**
 * 处理 FN ID OAuth 登录流程
 *
 * 设计要点（恢复 v3.0.0 基线链路，仅加不破坏流程的安全补丁）:
 *   1. oauthWindow(persist:fnid-oauth) 加载 5ddd.com/{fnId}
 *   2. 注入脚本 hook /sac/.../new-user-guide/status → 拿 cookie → 拉 sys_config
 *      → 确定 NAS 地址(baseUrl) → 在 oauthWindow 内导航到 NAS /signin
 *   3. /signin 页面注入脚本自动点"授权" → /oauthapi/authorize 返回 code
 *      → XHR hook 捕获 → completeLogin(code)
 *   4. (兜底) 若 code 通过 URL 回跳(/v/oauth/result?code=) 传递, will-navigate 守卫也会捕获
 *   5. completeLogin: 用 code 换 token → finalizeLogin(token)
 *   6. finalizeLogin: 关窗 + 复制 NAS cookie 到 fntv + 存配置/历史 + 加载 /v
 *
 * 不再使用"延迟兜底收尾"：那条链路会在 OAuth 未完成时以无 token 提前收尾,
 * 复制空 cookie, 导致 /v 弹登录页(密码错误/白页)。
 */
export async function handleFnIdLogin(event: IpcMainEvent, loginData: LoginData): Promise<void> {
    const fnId = loginData.domain.trim();
    const fnConnectUrl = buildFnConnectUrl(fnId);
    log.info(`[FN ID] 开始 FN ID 登录: fnId=${fnId}, url=${fnConnectUrl}`);

    let oauthWindow: BrowserWindow | null = null;
    let baseUrl = '';
    let cookieString = '';
    let sysConfigLoaded = false;
    let authRequested = false;

    try {
        // 创建 OAuth 登录窗口
        // 显式设置 backgroundColor, 避免 Windows 上继承主窗口 transparent 导致页面全透明.
        oauthWindow = new BrowserWindow({
            width: 800,
            height: 600,
            show: false, // Wait for ready-to-show
            title: 'FN ID 登录',
            backgroundColor: '#ffffff',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                // 使用独立 session 避免干扰主窗口
                partition: 'persist:fnid-oauth',
            }
        });

        // 平滑显示
        oauthWindow.once('ready-to-show', () => {
            oauthWindow?.show();
        });

        const oauthSession = oauthWindow.webContents.session;

        // 拦截 target="_blank" / window.open: 防止点击"飞牛影视APP"等产生裸窗或甩到系统浏览器.
        // 注意: 这里只 deny 弹窗, 不阻止 oauthWindow 内部正常导航(授权流程靠内部导航完成).
        oauthWindow.webContents.setWindowOpenHandler((details) => {
            log.info('[FN ID] 拦截弹窗(统一在 oauthWindow 内处理):', details.url);
            return { action: 'deny' };
        });

        // 为 FN Connect 域名设置 mode=relay Cookie
        await oauthSession.cookies.set({
            url: fnConnectUrl,
            name: 'mode',
            value: 'relay',
            path: '/',
            secure: true,
        });

        // 注册 JS bridge 用于 WebView 与主进程通信 + 安全检查
        oauthWindow.webContents.on('did-finish-load', () => {
            if (!oauthWindow || oauthWindow.isDestroyed()) return;
            const script = getInjectionScript(loginData.username, loginData.password);
            oauthWindow.webContents.executeJavaScript(`
                window.__fntvBridge = function(msg) {
                    // 通过 console 传递消息到主进程
                    console.log('__FNTV_BRIDGE__:' + msg);
                };
                ${script}
            `).catch(err => {
                log.error('[FN ID] JS 注入失败:', err);
            });
        });

        // 创建一个 Promise 来等待登录完成
        const loginPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('FN ID 登录超时（120秒）'));
            }, 120000);

            /**
             * 用授权码换取 token 后完成登录（XHR hook / 回跳守卫 共同调用）.
             */
            async function completeLogin(code: string): Promise<void> {
                if (authRequested) return;
                authRequested = true;
                log.info('[FN ID] 获取到授权码，开始换取 token');

                try {
                    if (!baseUrl) {
                        throw new Error('未能确定 NAS 地址（baseUrl 为空），无法完成登录');
                    }

                    const fnapi = new ApiService(baseUrl);
                    const authResponse = await fnapi.auth(code);

                    if (!authResponse || !authResponse.success || !authResponse.data?.token) {
                        const msg = authResponse?.message || '换取 token 失败';
                        log.error(`[FN ID] ${baseUrl} 授权失败: ${msg}, 完整响应: ${JSON.stringify(authResponse)}`);
                        authRequested = false;
                        reject(new Error(msg));
                        return;
                    }

                    const token = authResponse.data.token;
                    log.info('[FN ID] 获取 token 成功');

                    // 统一收尾(关窗/复制cookie/保存配置/加载主窗口)
                    await finalizeLogin(token);
                    clearTimeout(timeout);
                    resolve();
                } catch (err) {
                    authRequested = false;
                    log.error('[FN ID] Token 交换失败:', err);
                    reject(err);
                }
            }

            /**
             * 登录收尾逻辑(统一入口, 仅由 completeLogin 在有 token 时调用).
             */
            async function finalizeLogin(token: string): Promise<void> {
                // 1. 关闭 oauthWindow
                if (oauthWindow && !oauthWindow.isDestroyed()) {
                    log.info('[FN ID] finalizeLogin: 关闭 OAuth 登录窗');
                    oauthWindow.close();
                    oauthWindow = null;
                }

                if (!baseUrl) {
                    log.warn('[FN ID] finalizeLogin: baseUrl 为空，跳过 cookie 复制和配置保存');
                    return;
                }

                // 2. 批量复制 cookie
                try {
                    const oauthSes = session.fromPartition('persist:fnid-oauth');
                    const copied = await copyAllCookiesToMainSession(oauthSes, baseUrl);
                    log.info(`[FN ID] finalizeLogin: 已复制 ${copied} 个 cookie 到 fntv session`);
                } catch (err) {
                    log.error('[FN ID] finalizeLogin: cookie 复制失败:', err);
                }

                // 3. 保存配置 + 历史(标记 loginType:'fnid', 重启可免登录)
                try {
                    fnConfig.saveConfig({
                        account: loginData.username,
                        domain: baseUrl,
                        token: token,
                        useHttps: true,
                        loginType: 'fnid',
                    });

                    fnConfig.addHistory({
                        domain: baseUrl,
                        account: loginData.username || fnId,
                        password: loginData.password,
                        useHttps: true,
                        loginType: 'fnid',
                        fnId: fnId,
                    });
                    log.info('[FN ID] finalizeLogin: 配置和历史已保存');
                } catch (err) {
                    log.error('[FN ID] finalizeLogin: 配置保存失败:', err);
                }

                // 4. 额外确保 Trim-MC-token 和 mode=relay 存在(兜底)
                try {
                    await restoreCookies(baseUrl, token, true);
                } catch (err) {
                    log.warn('[FN ID] finalizeLogin: restoreCookies 兜底失败:', err);
                }

                // 5. 加载主界面
                const mainWindow = getMainWindow();
                if (mainWindow) {
                    log.info(`[FN ID] finalizeLogin: 跳转到主页面: ${baseUrl}/v`);
                    // 登录页(/login,/signin,/v/login)白底不可见 → 强制不透明背景.
                    // insertCSS 优先级高于页面内 <style> 与 ACRYLIC 玻璃壳, 且跨 SPA 路由持久.
                    // 仅在登录路径注入, 不影响主界面 /v 的玻璃效果.
                    let opaqueApplied = false;
                    const syncOpaqueBg = () => {
                        try {
                            const u = new URL(mainWindow!.webContents.getURL());
                            const p = u.pathname.toLowerCase();
                            if ((p.includes('/login') || p.includes('/signin')) && !opaqueApplied) {
                                mainWindow?.webContents.insertCSS(
                                    'html,body{background:#ffffff!important;background-color:#ffffff!important;}'
                                ).then(() => { opaqueApplied = true; }).catch(() => {});
                                log.info('[FN ID] finalizeLogin: 登录页强制白底 path=', p);
                            }
                        } catch { /* ignore */ }
                    };
                    mainWindow.webContents.once('dom-ready', syncOpaqueBg);
                    mainWindow.webContents.on('did-finish-load', syncOpaqueBg);
                    mainWindow.webContents.on('did-navigate-in-page', syncOpaqueBg);
                    mainWindow.loadURL(`${baseUrl}/v`);
                    if (!mainWindow.isVisible()) mainWindow.show();
                    mainWindow.focus();
                }
            }

            // ── OAuth 结果回跳地址拦截(原生飞牛界面必须拦截, 并作为 code 的兜底捕获) ──
            const REDIRECT_PATH = '/v/oauth/result';
            function isOauthResultUrl(u: string): boolean {
                try {
                    return new URL(u).pathname.endsWith(REDIRECT_PATH);
                } catch {
                    return false;
                }
            }
            function codeFromUrl(u: string): string | null {
                try {
                    const c = new URL(u).searchParams.get('code');
                    return c && c.length > 0 ? c : null;
                } catch {
                    return null;
                }
            }
            const guard = (event: any, url: string) => {
                if (!isOauthResultUrl(url)) return;
                event.preventDefault();
                log.info('[FN ID] 拦截 OAuth 结果页跳转（避免显示原生飞牛界面）:', url);
                const code = codeFromUrl(url);
                if (code && !authRequested) {
                    completeLogin(code);
                }
            };
            oauthWindow!.webContents.on('will-navigate', guard);
            oauthWindow!.webContents.on('will-redirect', guard);

            // 处理从 WebView 收到的消息
            async function handleMessage(messageData: any) {
                try {
                    const type = messageData.type;
                    const url = messageData.url || '';

                    // 处理 XHR 拦截（获取 Cookie）
                    if (type === 'XHR' && url.includes('/sac/rpcproxy/v1/new-user-guide/status')) {
                        const cookie = messageData.cookie;
                        if (cookie) {
                            cookieString = cookie;
                            log.info('[FN ID] 获取到 Cookie');

                            // 获取 sysConfig
                            if (!sysConfigLoaded) {
                                sysConfigLoaded = true;
                                try {
                                    await handleSysConfig(cookie);
                                } catch (err) {
                                    log.error('[FN ID] 获取系统配置失败:', err);
                                    sysConfigLoaded = false;
                                }
                            }
                        }
                    }

                    // 处理 SysConfig 响应（来自 WebView 内部 fetch）
                    if (type === 'SysConfig') {
                        if (sysConfigLoaded && baseUrl) return; // 已处理过
                        const body = messageData.body;
                        if (!body) return;

                        try {
                            const bodyJson = JSON.parse(body);
                            const data = bodyJson.data;
                            if (!data || !data.nas_oauth) return;

                            const appId = data.nas_oauth.app_id;
                            const oauthUrl = data.nas_oauth.url || '';

                            // 确定 baseUrl
                            if (oauthUrl && oauthUrl !== '://') {
                                baseUrl = oauthUrl;
                            } else if (messageData.pageUrl) {
                                const parsed = new URL(messageData.pageUrl);
                                baseUrl = `${parsed.protocol}//${parsed.host}`;
                            }

                            if (baseUrl && appId) {
                                sysConfigLoaded = true;
                                const redirectUri = `${baseUrl}/v/oauth/result`;
                                const targetUrl = `${baseUrl}/signin?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
                                log.info(`[FN ID] 跳转到 OAuth 授权页面: ${targetUrl}`);

                                // 转发 Cookie 到新域名
                                if (cookieString) {
                                    const domain = baseUrl.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
                                    const cookies = cookieString.split(';');
                                    for (const c of cookies) {
                                        const parts = c.trim().split('=');
                                        if (parts.length >= 2) {
                                            await oauthSession.cookies.set({
                                                url: baseUrl,
                                                name: parts[0].trim(),
                                                value: parts.slice(1).join('=').trim(),
                                                path: '/',
                                                domain: domain,
                                            }).catch(() => { });
                                        }
                                    }
                                    // 确保 mode=relay 被设置
                                    await oauthSession.cookies.set({
                                        url: baseUrl,
                                        name: 'mode',
                                        value: 'relay',
                                        path: '/',
                                    }).catch(() => { });
                                }

                                if (oauthWindow) {
                                    oauthWindow.loadURL(targetUrl);
                                }
                            }
                        } catch (err) {
                            log.error('[FN ID] 解析 SysConfig 失败:', err);
                        }
                    }

                    // 处理 OAuth 授权码响应（XHR hook 捕获的 code）
                    if (type === 'Response' && url.includes('/oauthapi/authorize')) {
                        let code = messageData.code;
                        if (!code && messageData.body) {
                            try {
                                const bodyJson = JSON.parse(messageData.body);
                                code = bodyJson.data?.code;
                            } catch (e) { }
                        }
                        if (code) {
                            await completeLogin(code);
                        }
                    }
                } catch (err) {
                    log.error('[FN ID] 消息处理错误:', err);
                }
            }

            // 通过 API 获取 sys_config（作为备选方案）
            async function handleSysConfig(cookie: string) {
                if (baseUrl && sysConfigLoaded) return;

                // 从当前 URL 获取 baseUrl
                const currentUrl = oauthWindow?.webContents.getURL() || '';
                if (!currentUrl) return;

                const parsed = new URL(currentUrl);
                const currentBaseUrl = `${parsed.protocol}//${parsed.host}`;

                // 使用获取到的 Cookie，通过 API 获取 sys_config
                const extraHeaders: Record<string, string> = { 'Cookie': cookie + '; mode=relay' };

                const configResponse = await request(
                    currentBaseUrl,
                    '/v/api/v1/sys/config',
                    HttpMethod.GET,
                    '',
                    undefined,
                    extraHeaders
                );

                if (configResponse.success && configResponse.data) {
                    const data = configResponse.data as any;
                    const oauth = data.nas_oauth;
                    if (oauth && oauth.app_id) {
                        let targetBaseUrl = currentBaseUrl;
                        if (oauth.url && oauth.url !== '://') {
                            targetBaseUrl = oauth.url;
                        }
                        baseUrl = targetBaseUrl;

                        const appId = oauth.app_id;
                        const redirectUri = `${targetBaseUrl}/v/oauth/result`;
                        const targetUrl = `${targetBaseUrl}/signin?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
                        log.info(`[FN ID] 通过 API 获取 OAuth 配置，跳转: ${targetUrl}`);

                        // 转发 Cookie
                        const domain = targetBaseUrl.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
                        const cookies = cookie.split(';');
                        for (const c of cookies) {
                            const parts = c.trim().split('=');
                            if (parts.length >= 2) {
                                await oauthSession.cookies.set({
                                    url: targetBaseUrl,
                                    name: parts[0].trim(),
                                    value: parts.slice(1).join('=').trim(),
                                    path: '/',
                                    domain: domain,
                                }).catch(() => { });
                            }
                        }
                        await oauthSession.cookies.set({
                            url: targetBaseUrl,
                            name: 'mode',
                            value: 'relay',
                            path: '/',
                        }).catch(() => { });

                        if (oauthWindow) {
                            oauthWindow.loadURL(targetUrl);
                        }
                    }
                }
            }

            // 监听 console 消息（JS bridge）
            oauthWindow!.webContents.on('console-message', (_event, _level, message) => {
                if (message.startsWith('__FNTV_BRIDGE__:')) {
                    const jsonStr = message.substring('__FNTV_BRIDGE__:'.length);
                    try {
                        const data = JSON.parse(jsonStr);
                        handleMessage(data);
                    } catch (err) {
                        log.error('[FN ID] 解析 bridge 消息失败:', err);
                    }
                }
            });

            // 窗口关闭时取消登录
            oauthWindow!.on('closed', () => {
                oauthWindow = null;
                clearTimeout(timeout);
                if (!authRequested) {
                    reject(new Error('用户关闭了登录窗口'));
                }
            });
        });

        // 加载 FN Connect URL
        oauthWindow.loadURL(fnConnectUrl);

        // 等待登录完成
        await loginPromise;

        // 关闭 OAuth 窗口
        if (oauthWindow && !oauthWindow.isDestroyed()) {
            oauthWindow.close();
        }

    } catch (error: any) {
        log.error('[FN ID] 登录失败:', error);

        // 关闭 OAuth 窗口
        if (oauthWindow && !oauthWindow.isDestroyed()) {
            oauthWindow.close();
        }

        event.reply('login-error', {
            title: 'FN ID 登录失败',
            message: error.message || '通过 FN ID 登录时发生错误，请检查 FN ID 和网络连接。'
        });
    }
}
