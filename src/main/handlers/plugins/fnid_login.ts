import { BrowserWindow, IpcMainEvent, session, dialog } from 'electron';
import * as net from 'net';
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
 * 反向拷贝: 将主窗口 persist:fntv session 的全部 cookie 复制到 oauthWindow 的 persist:fnid-oauth session.
 *
 * 修复「访问码(防伪码)门禁导致 FN ID 登录失败 / 卡桌面」:
 *   fnOS 新增的系统级「应用访问码」门禁, 验证通过会写授权 cookie 到 persist:fntv
 *   (用户在主窗口 webview 里输访问码时落在此 session). 而 oauthWindow 用独立的 persist:fnid-oauth session,
 *   没有该授权 cookie → 它向 NAS 发 /v/api/v1/sys/config 时被门禁拦截, 返回访问码门户 HTML 而非 JSON
 *   → FN ID 登录报「中继连接失败 / sys/config 持续返回门户 HTML」→ 卡在桌面.
 *   登录前把 persist:fntv 的 cookie(含访问码授权)复制到 oauth session, 让 oauthWindow 的请求带上授权 cookie,
 *   sys/config 即返回 JSON, 登录流程得以继续.
 */
async function copyFntvCookiesToOauthSession(): Promise<number> {
    try {
        const fntvSession = session.fromPartition('persist:fntv');
        const oauthSession = session.fromPartition('persist:fnid-oauth');
        const cookies = await fntvSession.cookies.get({});
        let copied = 0;
        for (const c of cookies) {
            try {
                // 按每条 cookie 自身 domain 构造 url(去前导点), 跨域 set 才不会报错
                const host = (c.domain || '').replace(/^\./, '') || 'localhost';
                const url = `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`;
                await oauthSession.cookies.set({
                    url,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    secure: c.secure ?? false,
                    httpOnly: c.httpOnly ?? false,
                    expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 86400 * 365),
                    sameSite: c.sameSite || 'no_restriction',
                });
                copied++;
            } catch (e) {
                log.warn('[FN ID] fntv→oauth cookie 复制失败:', c.name, e);
            }
        }
        log.info(`[FN ID] 已复制 ${copied} 个 persist:fntv cookie → persist:fnid-oauth (含访问码授权)`);
        return copied;
    } catch (err) {
        log.error('[FN ID] fntv→oauth cookie 批量复制失败:', err);
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
    rememberPassword?: boolean;
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
 * 快速 TCP 可达性预检: 对 url 的 host:port 发起一次 TCP connect, 超时即判不可达.
 * 用于 FN ID 登录时决定 baseUrl 优先用「NAS 内网 IP 直连」还是「5ddd 代理基址」:
 *   - 同局域网下 NAS 内网 IP 可达 → 直连(恢复 3.3.1 行为, 避免代理对 /v/api/v1/auth 返回 HTML).
 *   - 外网/不可达 → 回退代理基址(走 3.3.3 中继修复).
 */
function isUrlReachable(url: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            resolve(false);
            return;
        }
        const host = u.hostname;
        const port = u.port
            ? parseInt(u.port, 10)
            : u.protocol === 'https:' ? 443 : 80;
        const socket = new net.Socket();
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            try {
                socket.destroy();
            } catch {
                /* ignore */
            }
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        try {
            socket.connect(port, host);
        } catch {
            done(false);
        }
    });
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

            // 在 /login 页面自动填充用户名密码并提交
            // 多选择器兼容: fnOS 不同版本/部署方式的 input id/name/placeholder 可能不同.
            // 轮询重试: 外网中继跳转后页面加载比内网慢, 单次 setTimeout 200ms 不够.
            (function tryAutoLogin() {
                if (window.location.href.indexOf('/login') === -1 &&
                    window.location.href.indexOf('/signin') === -1) return;

                var attempts = 0;
                var maxAttempts = 20; // 最多试 4 秒(20 × 200ms)
                var timer = setInterval(function() {
                    attempts++;
                    // 多级选择器: id → name → placeholder → type+顺序
                    var uInput = document.getElementById('username')
                        || document.querySelector('input[name="username"]')
                        || document.querySelector('input[placeholder*="用户名"]')
                        || document.querySelector('input[placeholder*="账号"]')
                        || (function() { var inputs = document.querySelectorAll('input[type="text"], input:not([type])'); return inputs.length > 0 ? inputs[0] : null; })();
                    var pInput = document.getElementById('password')
                        || document.querySelector('input[name="password"]')
                        || document.querySelector('input[placeholder*="密码"]')
                        || (function() { var inputs = document.querySelectorAll('input[type="password"]'); return inputs.length > 0 ? inputs[0] : null; })();

                    if (uInput && AUTO_LOGIN_USER) {
                        clearInterval(timer);
                        console.log("[fntv-electron] 找到登录框, 自动填充用户名 (第 " + attempts + " 次尝试)");
                        triggerInput(uInput, AUTO_LOGIN_USER);
                        if (AUTO_LOGIN_PASS && pInput) {
                            triggerInput(pInput, AUTO_LOGIN_PASS);
                            console.log("[fntv-electron] 密码已填充, 准备自动点击登录");
                            // 自动点击登录按钮(多种选择器)
                            setTimeout(function() {
                                var btn = document.querySelector('button[type="submit"]')
                                    || Array.from(document.querySelectorAll('button')).find(function(b) { return b.innerText.indexOf('登录') !== -1 || b.innerText.indexOf('登 录') !== -1; })
                                    || document.querySelector('input[type="submit"]');
                                if (btn) { btn.click(); console.log("[fntv-electron] 已点击登录按钮"); }
                                else { console.warn("[fntv-electron] 未找到登录按钮"); }
                            }, 300);
                        }
                        return;
                    }

                    if (attempts >= maxAttempts) {
                        clearInterval(timer);
                        console.warn("[fntv-electron] 自动填充超时: " + maxAttempts + " 次尝试未找到登录框, URL=" + window.location.href);
                    }
                }, 200);
            })();

            // 在 /signin 页面自动点击授权按钮(轮询重试, 同上)
            (function tryAutoAuthorize() {
                if (window.location.href.indexOf('/signin') === -1) return;
                var attempts = 0;
                var timer = setInterval(function() {
                    attempts++;
                    var btns = document.querySelectorAll('button');
                    for (var i = 0; i < btns.length; i++) {
                        if (btns[i].innerText.indexOf('授权') !== -1) {
                            clearInterval(timer);
                            btns[i].click();
                            console.log("[fntv-electron] 已点击授权按钮 (第 " + attempts + " 次尝试)");
                            return;
                        }
                    }
                    if (attempts >= 20) { clearInterval(timer); console.warn("[fntv-electron] 授权按钮查找超时"); }
                }, 200);
            })();

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
            // 改进: ① 5ddd.com 落地页无 NAS app, 不在此拉取(避免误报 HTML);
            //       ② 官方中继(.fnos.net)隧道建立可能慢于内网, 采用退避重试;
            //       ③ 重试耗尽仍只拿到 HTML → 发 SysConfigFailed 让主进程快速明确报错,
            //         而非静默卡死等 120s 超时.
            function fetchSysConfigOnce() {
                try {
                    if (window.__fntv_sys_config_requested) return;
                    var host = (window.location.hostname || '').toLowerCase();
                    if (host.indexOf('5ddd.com') !== -1) return;        // 落地页无 NAS, 跳过
                    if (host === 'fnos.net') return;                    // 官方中继门户根(fnos.net/{fnId})只返回门户HTML; 真实 NAS 在 {fnId}.fnos.net 子域, 导航到子域后脚本会重新注入并执行
                    if (window.location.href.indexOf('/login') !== -1) return;
                    window.__fntv_sys_config_requested = true;

                    // 官方中继子域(ydmy007.fnos.net)本身即 NAS, 但其隧道建立可能较慢(实测可达数十秒),
                    // 需较长轮询; 直连/IPv6/5ddd 代理则快速判定.
                    var isRelaySub = host.endsWith('.fnos.net');
                    var maxAttempts = isRelaySub ? 40 : 6;   // 中继: 40×1.5s≈60s; 其余: 6×~0.7s≈11s
                    var delayBase = isRelaySub ? 1500 : 700;
                    var attempt = 0;
                    function tryFetch() {
                        attempt++;
                        fetch('/v/api/v1/sys/config', { credentials: 'include' })
                            .then(function(r) { return r.text(); })
                            .then(function(text) {
                                var t = (text || '').trim();
                                var isJson = t.charAt(0) === '{';
                                // 每次轮询都打日志, 便于 F12 直接观察轮询进度与响应内容
                                console.log('[fntv-electron] sys/config 轮询 ' + attempt + '/' + maxAttempts + ': ' + (isJson ? 'JSON-OK' : ('非JSON: ' + t.slice(0, 60).replace(/\\s+/g, ' '))));
                                if (isJson) {
                                    postMessage({
                                        type: "SysConfig",
                                        url: "/v/api/v1/sys/config",
                                        body: t,
                                        pageUrl: String(window.location.href || "")
                                    });
                                    return;
                                }
                                if (attempt < maxAttempts) {
                                    // 任何非 JSON(隧道引导页/门户 HTML/空响应)都重试, 不再提前判死
                                    setTimeout(tryFetch, delayBase * Math.min(attempt, 6));
                                    return;
                                }
                                // 重试耗尽仍非 JSON → 明确告知主进程
                                postMessage({
                                    type: "SysConfigFailed",
                                    url: "/v/api/v1/sys/config",
                                    body: t,
                                    pageUrl: String(window.location.href || "")
                                });
                            })
                            .catch(function() {
                                if (attempt < maxAttempts) { setTimeout(tryFetch, delayBase * Math.min(attempt, 6)); return; }
                                postMessage({
                                    type: "SysConfigFailed",
                                    url: "/v/api/v1/sys/config",
                                    body: "",
                                    pageUrl: String(window.location.href || "")
                                });
                            });
                    }
                    setTimeout(tryFetch, 800);
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
    let loginTimeout: NodeJS.Timeout | null = null;
    let loginReject: ((reason?: any) => void) | null = null;
    let relayWatchdog: NodeJS.Timeout | null = null; // 官方中继(.fnos.net)配置看门狗
    let relayPollTimer: NodeJS.Timeout | null = null; // 官方中继子域主进程轮询定时器
        let relayPollStarted = false;
        let relayFailedNotified = false; // 官方中继失败弹窗去重, 只弹一次
        let deskMonitor: NodeJS.Timeout | null = null; // [lc-210] oauthWindow 桌面→/v 兜底定时器

    // 官方中继连接失败 → 弹原生错误框(lc-116 曾因挡 F12 诊断临时关闭, lc-126 恢复).
    // 用原生 dialog 而非 fnosDialog: FN ID 登录期间 oauthWindow 浮在上层,
    // fnosDialog 渲染在登录页主窗口可能被遮挡; 原生框为 OS 级模态, 保证置顶可见.
    // 仅在「主进程轮询耗尽 + 注入脚本也失败」后才触发(最坏约 60s), 不会误伤正常登录.
    const notifyRelayFailed = (reason: string): void => {
        if (relayFailedNotified) return;
        relayFailedNotified = true;
        if (relayWatchdog) { clearTimeout(relayWatchdog); relayWatchdog = null; }
        if (relayPollTimer) { clearTimeout(relayPollTimer); relayPollTimer = null; }
        log.error(`[FN ID] 官方中继连接失败: ${reason}`);
        dialog.showMessageBox({
            type: 'error',
            title: '官方中继连接失败',
            message: '无法通过官方中继完成飞牛 ID 登录',
            detail: `${reason}\n\n可稍后重试，或改用「IPv6 / 公网 IP」方式直连。`,
            buttons: ['确定'],
            defaultId: 0,
            cancelId: 0,
        }).then(() => {
            if (loginReject) {
                loginReject(new Error('官方中继连接失败'));
                loginReject = null;
            }
        });
    };

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

        // [lc-208] 访问码门禁修复: 登录前把主窗口 persist:fntv 的 cookie(含访问码授权)复制到 oauth session,
        // 否则 oauthWindow 向 NAS 发 sys/config 会被访问码门禁拦截返回门户 HTML, 导致 FN ID 登录失败/卡桌面.
        await copyFntvCookiesToOauthSession();

        // [lc-210] 桌面→/v 兜底: 主窗口(preload embyWall)已有桌面纠正, 但桌面可能渲染在 oauthWindow(独立 session,
        // 无 embyWall)——登录卡住时桌面停在弹窗里, 主窗口纠正不触发. 此处在主进程侧检测 oauthWindow 是否停在
        // fnOS 桌面(且 OAuth 尚未完成), 是则让主窗口 loadURL(/v) 并关闭弹窗, 实现"检测到首页就跳影视页".
        deskMonitor = setInterval(async () => {
            if (!oauthWindow || oauthWindow.isDestroyed() || authRequested || sysConfigLoaded) return;
            try {
                const isDesk = await oauthWindow.webContents.executeJavaScript(
                    "(function(){var p=location.pathname;if(p!=='/'&&p!=='/v'&&p!=='/v/')return false;" +
                    "var t=(document.body&&document.body.innerText||'').replace(/\\s+/g,'');" +
                    "var h=['系统设置','应用中心','文件管理','影视','相册','商店','虚拟机','终端','下载','备份','安全中心','回收站','远程助手','飞牛同步'];" +
                    "return h.filter(function(x){return t.indexOf(x)>=0;}).length>=2;})()"
                );
                if (isDesk) {
                    log.info('[FN ID] oauthWindow 检测到 fnOS 桌面(登录卡住), 主窗口跳 /v 并关闭弹窗');
                    const mw = getMainWindow();
                    const origin = (() => { try { return new URL(oauthWindow!.webContents.getURL()).origin; } catch { return ''; } })();
                    if (mw && !mw.isDestroyed() && origin) mw.loadURL(`${origin}/v`);
                    oauthWindow.close();
                    oauthWindow = null;
                    if (deskMonitor) { clearInterval(deskMonitor); deskMonitor = null; }
                }
            } catch { /* ignore */ }
        }, 3000);

        // 拦截 target="_blank" / window.open: 不开新窗, 改为在 oauthWindow 内导航.
        // 原因: 5ddd.com 中继选择页的三个选项(中继转发/公网IP)通过 window.open 或 target=_blank 跳转,
        //       若直接 deny 则用户点击无反应(看起来像"无法点击").
        //       授权流程(/signin)完成后的回跳由 will-navigate 守卫(isOauthResultUrl)拦截, 不会泄露到系统浏览器.
        oauthWindow.webContents.setWindowOpenHandler((details) => {
            const url = details.url;
            log.info('[FN ID] 弹窗导航(合并到 oauthWindow 内处理):', url);
            // 安全检查: 只允许导航到 http/https 地址, 防止 javascript:/data: 等协议注入
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                oauthWindow?.loadURL(url);
                // 目标是官方中继子域({fnId}.fnos.net) → 立即启动主进程配置轮询, 不等页面加载完成
                try {
                    const h = new URL(url).hostname.toLowerCase();
                    if (h.endsWith('.fnos.net')) startRelaySubPoll(`https://${h}`);
                } catch { /* ignore */ }
            } else {
                log.warn('[FN ID] 拒绝非 http/https 弹窗:', url);
            }
            return { action: 'deny' };
        });

        // ★ 外网诊断: 授权页(/signin)导航失败时给出明确错误, 而不是静默白屏等用户关窗后报"用户关闭了登录窗口".
        oauthWindow.webContents.on('did-fail-load', (_e: any, errorCode: number, errorDescription: string, validatedURL: string) => {
            // 仅关注真正的授权跳转失败(非初始 5ddd 加载), 避免误报
            if (validatedURL.includes('/signin') || (baseUrl && validatedURL.startsWith(baseUrl))) {
                log.error(`[FN ID] 授权页加载失败: ${validatedURL} (${errorCode}: ${errorDescription})`);
                if (!authRequested && loginReject) {
                    authRequested = true; // 防止 closed 事件重复 reject
                    if (loginTimeout) { clearTimeout(loginTimeout); loginTimeout = null; }
                    if (relayWatchdog) { clearTimeout(relayWatchdog); relayWatchdog = null; }
                    loginReject(new Error(`FN ID 授权页无法加载（${errorDescription}）。外网请确认 FN Connect/远程访问已开启；内网请确认设备在线且地址可达。`));
                }
            }
        });

        // ★ lc-118 根治: 官方中继子域「主进程」轮询 sys/config.
        //   F12 实证: 对 {fnId}.fnos.net/v/api/v1/sys/config 发普通 HTTP 请求即返回 JSON
        //   (边缘服务器侧中继, NAS 与 fnos.net 保持长连接, 不依赖浏览器内隧道).
        //   而子域根页面本身是 FN Connect 隧道引导 SPA(isUseSTUN/WebRTC),
        //   页面内 fetch 在隧道就绪前只能拿到引导 HTML → 页面内轮询可能永远等不到 JSON.
        //   因此由主进程直接轮询该 API, 拿到配置立即跳授权页, 完全绕开页面内隧道.
        const startRelaySubPoll = (subBase: string) => {
            if (relayPollStarted) return;
            relayPollStarted = true;
            let attempts = 0;
            const maxAttempts = 30; // 30 × 2s ≈ 60s
            const tick = async () => {
                relayPollTimer = null;
                if (sysConfigLoaded || authRequested || !oauthWindow || oauthWindow.isDestroyed()) return;
                attempts++;
                try {
                    const resp = await request(
                        subBase,
                        '/v/api/v1/sys/config',
                        HttpMethod.GET,
                        '',
                        undefined,
                        cookieString ? { 'Cookie': cookieString + '; mode=relay' } : undefined,
                        undefined,
                        8000,
                        0
                    );
                    const data = resp?.data as any;
                    const oauth = data && typeof data === 'object' ? data.nas_oauth : null;
                    if (resp?.success && oauth && oauth.app_id) {
                        if (sysConfigLoaded || authRequested) return;
                        sysConfigLoaded = true;
                        baseUrl = subBase;
                        const redirectUri = `${subBase}/v/oauth/result`;
                        const targetUrl = `${subBase}/signin?client_id=${oauth.app_id}&redirect_uri=${encodeURIComponent(redirectUri)}`;
                        log.info(`[FN ID] 主进程轮询获取中继子域 OAuth 配置成功(第 ${attempts} 次), 跳转授权页: ${targetUrl}`);
                        try {
                            await oauthSession.cookies.set({ url: subBase, name: 'mode', value: 'relay', path: '/' });
                        } catch { /* ignore */ }
                        if (oauthWindow && !oauthWindow.isDestroyed()) {
                            oauthWindow.loadURL(targetUrl);
                        }
                        return;
                    }
                    const brief = typeof data === 'string'
                        ? data.slice(0, 60).replace(/\s+/g, ' ')
                        : (data ? JSON.stringify(data).slice(0, 60) : String(resp?.message || ''));
                    log.info(`[FN ID] 中继子域配置轮询 ${attempts}/${maxAttempts}: 未就绪 (success=${resp?.success}, resp=${brief})`);
                } catch (e: any) {
                    log.info(`[FN ID] 中继子域配置轮询 ${attempts}/${maxAttempts} 异常: ${e?.message || e}`);
                }
                if (attempts < maxAttempts && !sysConfigLoaded && !authRequested) {
                    relayPollTimer = setTimeout(tick, 2000);
                } else if (!sysConfigLoaded && !authRequested) {
                    log.warn('[FN ID] 中继子域配置主进程轮询耗尽(约60s), 触发失败弹窗');
                    notifyRelayFailed('中继子域在约 60 秒内未返回有效的系统配置（主进程轮询 /v/api/v1/sys/config 始终未就绪）');
                }
            };
            tick();
        };

        // ★ 官方中继(.fnos.net)配置看门狗: 中继隧道建立可能较慢(实测可达数十秒),
        //   注入脚本已改为最长 60s 轮询; 此处仅作兜底日志(不弹窗), 防止消息丢失时永久卡死.
        oauthWindow.webContents.on('did-navigate', (_e: any, navUrl: string) => {
            try {
                const navHost = new URL(navUrl).hostname.toLowerCase();
                if (navHost.endsWith('.fnos.net')) {
                    // 官方中继子域(非门户根 fnos.net) → 启动主进程配置轮询
                    startRelaySubPoll(`https://${navHost}`);
                    if (relayWatchdog) clearTimeout(relayWatchdog);
                    relayWatchdog = setTimeout(() => {
                        if (!authRequested && !sysConfigLoaded) {
                            notifyRelayFailed('官方中继（.fnos.net）在约 65 秒内未完成 OAuth 配置获取，中继隧道可能尚未建立');
                            if (relayWatchdog) { relayWatchdog = null; }
                        }
                    }, 65000);
                }
            } catch { /* ignore */ }
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
            loginReject = reject;
            loginTimeout = setTimeout(() => {
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
                    log.key('[FN ID] 登录成功 (已获取 token)');

                    // 统一收尾(关窗/复制cookie/保存配置/加载主窗口)
                    await finalizeLogin(token);
                    if (loginTimeout) { clearTimeout(loginTimeout); loginTimeout = null; }
                    if (relayWatchdog) { clearTimeout(relayWatchdog); relayWatchdog = null; }
                    if (relayPollTimer) { clearTimeout(relayPollTimer); relayPollTimer = null; }
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
                        password: loginData.rememberPassword ? loginData.password : '',
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
                    // ★ 排除 file:// 协议(我们自己的 resource/login/index.html 登录页),
                    //   其 pathname 含 "/login" 但不应被强制白底(已有 ACRYLIC 注入背景图).
                    let opaqueApplied = false;
                    const syncOpaqueBg = () => {
                        try {
                            const u = new URL(mainWindow!.webContents.getURL());
                            if (u.protocol === 'file:') return; // 自身登录页, 跳过
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
                    // 用 includes 而非 endsWith: 外网代理下路径可能带 /{fnId} 前缀
                    // (如 https://5ddd.com/{fnId}/v/oauth/result)
                    return new URL(u).pathname.includes(REDIRECT_PATH);
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
                            // ★ 外网修复: 当前在 5ddd.com 代理下(外网访问 fnOS 的通道)时,
                            //   nas_oauth.url 通常是 NAS 内网 IP(如 http://192.168.x.x:18888),
                            //   外网不可达 → 必须改用「当前代理页真实基址」(去掉 /v/api/v1/sys/config 后缀,
                            //   保留可能的 /{fnId} 路径前缀), 才能走通授权流程.
                            //   内网场景(当前页非 5ddd.com)维持原逻辑用 nas_oauth.url, 不受影响.
                            const pageUrl = messageData.pageUrl || '';
                            const onExternalRelay = /5ddd\.com/i.test(pageUrl);
                            const onRelaySub = (() => { try { return /\.fnos\.net$/i.test(new URL(pageUrl).hostname); } catch { return false; } })();

                            // ★ 回归修复(lc-193): 3.3.1 用 nas_oauth.url(NAS 内网 IP)直连完成 token 交换与 /v 加载,
                            //   3.3.3 改为强制走 5ddd 代理基址。若代理对 /v/api/v1/auth 等返回 HTML(落地页, HTTP200),
                            //   则 completeLogin 的 fnapi.auth(code) 拿到 HTML → request.ts 新诊断报"服务器返回了网页"。
                            //   现改为: 当 NAS 内网 IP 直接可达(同局域网)时优先直连(oauthUrl), 不可达(外网)才回退代理/中继子域。
                            const nasReachable = !!(
                                oauthUrl &&
                                oauthUrl !== '://' &&
                                (await isUrlReachable(oauthUrl))
                            );

                            let chosenBase = '';
                            if (nasReachable) {
                                // 同局域网: 直连 NAS IP(恢复 3.3.1 行为)
                                chosenBase = oauthUrl;
                            } else if (onExternalRelay && pageUrl) {
                                chosenBase = pageUrl.replace(/\/v\/api\/v1\/sys\/config(\?.*)?$/i, '');
                            } else if (onRelaySub && pageUrl) {
                                // 官方中继子域(ydmy007.fnos.net)本身即 NAS 基址
                                chosenBase = pageUrl.replace(/\/v\/api\/v1\/sys\/config(\?.*)?$/i, '');
                            } else if (oauthUrl && oauthUrl !== '://') {
                                chosenBase = oauthUrl;
                            } else if (pageUrl) {
                                const parsed = new URL(pageUrl);
                                chosenBase = `${parsed.protocol}//${parsed.host}`;
                            }

                            if (chosenBase) {
                                baseUrl = chosenBase;
                                log.info(`[FN ID] baseUrl=${baseUrl} | onExternalRelay=${onExternalRelay} onRelaySub=${onRelaySub} nasReachable=${nasReachable} (nas_oauth.url=${oauthUrl})`);
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

                    // 处理 SysConfig 彻底失败（注入脚本重试耗尽仍只拿到 HTML）
                    // ★ 官方中继(.fnos.net)典型表现: /v/api/v1/sys/config 返回门户 HTML
                    // 暂时只记日志不弹窗(给用户留出 F12 诊断时间), 等 F12 诊断结果回来后再根治.
                    if (type === 'SysConfigFailed') {
                        log.error(`[FN ID] SysConfig 重试耗尽仍非 JSON(中继不支持该 API), pageUrl=${messageData.pageUrl || ''}`);
                        notifyRelayFailed('中继服务器未返回有效的系统配置（/v/api/v1/sys/config 持续返回门户 HTML 而非 JSON）');
                        return;
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
                // ★ 外网修复: 当前在 5ddd.com 代理下时, 用「代理页真实基址」(保留 /{fnId} 路径前缀),
                //   而非仅 origin; 内网则维持 origin(无路径前缀).
                const onExternalRelay = /5ddd\.com/i.test(currentUrl);
                const onRelaySub = /\.fnos\.net$/i.test(parsed.hostname);
                const currentBaseUrl = onExternalRelay
                    ? currentUrl.replace(/\/v\/api\/v1\/sys\/config(\?.*)?$/i, '')
                    : `${parsed.protocol}//${parsed.host}`;

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
                        // ★ 回归修复(lc-193): 同局域网下 NAS IP 直连优先(恢复 3.3.1), 不可达才回退当前(代理/子域)基址
                        let targetBaseUrl = currentBaseUrl;
                        const nasReachable = !!(
                            oauth.url &&
                            oauth.url !== '://' &&
                            (await isUrlReachable(oauth.url))
                        );
                        if (nasReachable) {
                            targetBaseUrl = oauth.url;
                        } else if (!onExternalRelay && !onRelaySub && oauth.url && oauth.url !== '://') {
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
                if (loginTimeout) { clearTimeout(loginTimeout); loginTimeout = null; }
                if (relayWatchdog) { clearTimeout(relayWatchdog); relayWatchdog = null; }
                if (relayPollTimer) { clearTimeout(relayPollTimer); relayPollTimer = null; }
                // [lc-210] 停止桌面检测兜底定时器, 避免窗口已关闭后仍空转
                if (deskMonitor) { clearInterval(deskMonitor); deskMonitor = null; }
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
        log.key(`[FN ID] 登录失败: ${(error && error.message) || error}`);

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
