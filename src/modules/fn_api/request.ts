import * as crypto from 'crypto';
import axios, { AxiosResponse } from 'axios';
import { setTimeout } from 'timers/promises';
import https from 'https';
import { session } from 'electron';
import log from '../logger';
import { isTrusted, showCertificateTrustDialog, isCertificateError, addTrustedHost } from '../cert_trust';

/**
 * [lc-294] 主进程 API 鉴权补全: 转发 persist:fntv 会话里的 fnOS 鉴权 Cookie(如 Trim-MC-token)。
 *
 * 根因: fnOS 影视接口的鉴权依赖浏览器会话 Cookie(restoreCookies 写入 persist:fntv 的
 *   Trim-MC-token), webview 靠它才能加载首页/调接口。但主进程此前只用 `Authorization: token`
 *   头 + 硬编码 `Cookie: mode=relay` 发请求, 直连 NAS 时接口不认 Authorization 头,
 *   于是把请求弹回 HTML 登录/错误页 —— 表现为「获取播放信息失败: 接口返回HTML 判定=地址/端口错误」。
 *   (webview 能开首页正是因为它带着真实会话 Cookie, 反证主进程缺的就是这个 Cookie。)
 *
 * 修复: 每次 API 请求前, 从 persist:fntv 分区读回 baseUrl 对应主机的会话 Cookie 并并入
 *   Cookie 头(保留 mode=relay 以兼容 FN Connect 外网中继)。这样主进程与 webview 使用同一套
 *   会话鉴权, 所有主进程 API(播放信息/进度/元数据等) 不再因缺 Cookie 而失败。
 *
 * 性能: 同一 baseUrl 的 Cookie 做 60s TTL 内存缓存, 避免高频进度上报时反复读磁盘。
 */
const cookieCache = new Map<string, { value: string; ts: number }>();
const COOKIE_CACHE_TTL = 60000;

export async function getSessionCookieHeader(baseUrl: string): Promise<string> {
    try {
        const u = new URL(baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        const cached = cookieCache.get(baseUrl);
        if (cached && Date.now() - cached.ts < COOKIE_CACHE_TTL) {
            return cached.value;
        }
        const ses = session.fromPartition('persist:fntv');
        const cookies = await ses.cookies.get({ url: `${u.protocol}//${u.host}` });
        const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        cookieCache.set(baseUrl, { value: header, ts: Date.now() });
        return header;
    } catch {
        return '';
    }
}

// 全局配置
const api_key = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const api_secret = '16CCEB3D-AB42-077D-36A1-F355324E4237';

// 类型定义
export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    certificateError?: boolean; // 标识是否为证书错误
    moveUrl?: string; // 重定向URL
    htmlResponse?: boolean;     // 命中网页(HTML)而非接口 JSON —— 多为地址/端口填错
    networkError?: boolean;     // 连接层失败(无 HTTP 响应: DNS/端口/网络不可达) —— 与业务报错区分
}

export interface FnApiResponseData<T = any> {
    code: number;
    msg: string;
    data: T;
}

export enum HttpMethod {
    GET = 'get',
    POST = 'post',
    PUT = 'put',
    DELETE = 'delete'
}

// MD5哈希计算
export function getMd5(text: string): string {
    return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

// 生成随机数字字符串
export function generateRandomDigits(start: number = 100000, end: number = 1000000): string {
    return Math.floor(Math.random() * (end - start) + start).toString();
}

// 生成授权签名
export function genFnAuthx(url: string, data?: any): string {
    const nonce = generateRandomDigits();
    const timestamp = Date.now();
    const dataJson = data ? JSON.stringify(data) : '';
    const dataJsonMd5 = getMd5(dataJson);

    const signArray = [
        api_key,
        url,
        nonce,
        timestamp.toString(),
        dataJsonMd5,
        api_secret
    ];

    const signStr = signArray.join('_');
    return `nonce=${nonce}&timestamp=${timestamp}&sign=${getMd5(signStr)}`;
}

// 默认超时时间（毫秒）
export const DEFAULT_TIMEOUT = 10000;

// 连接层错误的精准中文提示（按 Node 错误码映射）。用于把「网络不通」从模糊的
// 原始 error.message 转成用户可操作的处理建议。
const NETWORK_ERROR_HINTS: Record<string, string> = {
    ECONNREFUSED: '无法连接服务器（连接被拒绝）：目标 IP:端口 当前没有服务在监听。请确认服务器地址和端口是否填写正确、飞牛影视/NAS 服务是否正在运行。',
    ETIMEDOUT: '连接超时：网络可能不可达，或防火墙拦截了该端口。请检查本机与服务器是否在同一网络、防火墙是否放行此端口。',
    ECONNABORTED: '连接超时或被中止：网络不稳定或服务器迟迟未响应。请检查网络连通性后重试。',
    ENOTFOUND: '无法解析主机名：地址拼写有误。内网请直接填 IP（如 192.168.31.170:18888），不要带域名后缀或协议头之外的多余字符。',
    EAI_AGAIN: 'DNS 解析失败：地址无法解析。请确认填写的是正确的内网 IP，而不是无法解析的名称。',
    ECONNRESET: '连接被服务器重置：服务器可能中途中断了连接。请稍后重试或检查服务状态。',
    ERR_NETWORK: '网络错误：请求未能成功发出或被拦截。请检查网络连通性与代理/防火墙设置。'
};

// API请求函数
export async function request<T = any>(
    baseUrl: string,
    url: string,
    method: HttpMethod,
    token: string,
    data?: any,
    extraHeaders?: Record<string, string>,
    axiosConfig?: Record<string, any>, // 外部传入的 axios 配置
    timeout: number = DEFAULT_TIMEOUT,
    tryTimes: number = 5,
): Promise<ApiResponse<T>> {
    const fullUrl = baseUrl + url;
    if (method === HttpMethod.POST || method === HttpMethod.PUT) {
        data = data || {};
        data["nonce"] = generateRandomDigits(); // POST/PUT请求添加随机数防重放
    }

    const authx = genFnAuthx(url, data);

    // [lc-294] 转发 persist:fntv 会话 Cookie(含 Trim-MC-token 鉴权), 与 webview 同源鉴权.
    // 保留 mode=relay 以兼容 FN Connect 外网中继; 会话 Cookie 为空(未登录/登录中)时退化为仅 mode=relay.
    const sessionCookieHeader = await getSessionCookieHeader(baseUrl);
    const cookieParts = ['mode=relay'];
    if (sessionCookieHeader) cookieParts.push(sessionCookieHeader);
    const cookieHeader = cookieParts.join('; ');

    const headers = {
        "Content-Type": "application/json",
        "Authorization": token,
        "Cookie": cookieHeader,
        "Authx": authx,
        ...extraHeaders
    };

    // 根据URL是否已被信任来决定是否验证证书
    const shouldIgnoreCert = isTrusted(baseUrl);

    const config = {
        headers,
        timeout: timeout,
        // 禁止 Axios 自动处理重定向，手动处理
        maxRedirects: 0,
        // 允许 3xx 状态码进入 .then() 而不是 .catch()
        validateStatus: (status: number) => status >= 200 && status < 400,
        httpsAgent: new https.Agent({
            rejectUnauthorized: !shouldIgnoreCert,
            keepAlive: true,
            timeout: timeout,
            maxSockets: 10,
        }),
        ...axiosConfig
    };

    for (let attempt = 0; attempt <= tryTimes; attempt++) {
        try {
            let response: AxiosResponse<FnApiResponseData<T>>;

            switch (method) {
                case HttpMethod.GET: response = await axios.get(fullUrl, config); break;
                case HttpMethod.POST: response = await axios.post(fullUrl, data, config); break;
                case HttpMethod.PUT: response = await axios.put(fullUrl, data, config); break;
                case HttpMethod.DELETE: response = await axios.delete(fullUrl, config); break;
                default: throw new Error(`Unsupported method: ${method}`);
            }

            if ([301, 302, 307, 308].includes(response.status)) {
                const location = response.headers.location;
                log.warn(`检测到重定向 (${response.status}) -> ${location}`);

                if (location) {
                    // 1. 解析新地址
                    let newBaseUrl = baseUrl;
                    let newUrlPath = location;

                    // 如果是绝对路径 (http开头)，重新拆解 baseUrl 和 path
                    if (location.startsWith('http')) {
                        const parsedUrl = new URL(location);
                        newBaseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
                        newUrlPath = parsedUrl.pathname + parsedUrl.search;
                    }

                    const recursiveResult = await request<T>(
                        newBaseUrl,
                        newUrlPath,
                        method,
                        token,
                        data,
                        extraHeaders,
                        axiosConfig,
                        timeout,
                        tryTimes - 1
                    );

                    return {
                        ...recursiveResult,
                        moveUrl: recursiveResult.moveUrl || newBaseUrl
                    };
                }
            }

            // 不是json直接返回二进制文件
            const contentType = response.headers['content-type'];
            if (contentType && typeof contentType === 'string') {
                // 服务器返回了网页(HTML)而非接口数据：几乎一定是地址/网络/代理问题
                // (如 404/502/登录页/重定向页)。对二进制下载(text/html 不会是字幕/图片)安全判失败，
                // 避免上层把 HTML 字符串误当成 success 并进一步读取不存在的 data.token。
                if (contentType.includes('text/html')) {
                    // ═══ 诊断日志: 记录实际返回内容, 方便定位"打到了什么页面" ═══
                    const rawBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                    const bodyPreview = rawBody.slice(0, 500);
                    log.error(`[HTML响应诊断] URL=${fullUrl} | status=${response.status} | content-type=${contentType}`);
                    log.error(`[HTML响应诊断] 响应体前500字符: ${bodyPreview}`);

                    // 精准区分「需 FN ID 登录」与「服务器地址/端口错误」：
                    // 能拿到 HTML 说明网络是通的，所以"网络不通"已排除，只剩下面两类。
                    const htmlLower = rawBody.toLowerCase().slice(0, 2000);
                    const isApiPath = /\/v\/api\//i.test(fullUrl); // 当前请求是否为接口路径
                    const isLoginPage = /(<input[^>]*type=["']?password|password|登录|sign\s*in|signin|fn\s*id|fnid|oauth|授权登录|账号|用户名)/.test(htmlLower);
                    const isAppShell = /<div[^>]*id=["'](app|root)["']|id=["']app["']|id=["']root["']|__nuxt|__next|<script[^>]*\.js/.test(rawBody);
                    const isServerErrorPage = /(404 not found|502 bad gateway|503 service|nginx|upstream|proxy error|网关|内部错误|无法访问|服务器错误)/.test(htmlLower);

                    let message: string;
                    let diag: string;
                    if (isApiPath) {
                        // ★ 关键修正(lc-193): 接口路径(/v/api/...)返回 HTML, 几乎一定是「地址/代理填错」
                        //   ——请求没打到飞牛影视接口(正确形如 /v/api/v1/...), 而是命中了某个网页/代理落地页。
                        //   这绝不可能是"FN ID 会话过期"(会话过期只会让非接口页面重定向到登录页, 不会让接口返回 HTML)。
                        //   典型场景: FN ID/中继时把代理落地页地址当成了接口基址。
                        diag = '地址/端口错误';
                        message = '接口路径返回了网页(HTML)而非 JSON 数据。'
                            + '这通常意味着「地址/代理填错」——请求没有打到飞牛影视接口（正确接口路径形如 /v/api/v1/...），'
                            + '而是命中了某个网页或代理落地页。'
                            + '👉 请检查：① 服务器地址/IP:端口 是否正确；② 若通过 FN ID / 中继访问，确认中继地址无误、不要在地址后多带路径或后缀。';
                    } else if (isLoginPage) {
                        // 典型表现：未登录 / FN ID 会话过期，非接口页面被重定向到登录页。
                        diag = '登录页(FN ID)';
                        message = '请求被重定向到了登录页（返回的是 HTML 网页而非接口数据）。'
                            + '原因几乎都是「未使用 FN ID 登录」或「FN ID 会话已过期」——飞牛影视接口需要 FN ID 会话 Cookie，用内网 IP 走本地账号登录拿不到它。'
                            + '👉 请这样做：在登录框填写你的 FN ID（6–30 位、不含点的飞牛 ID，例如 abc123，不要填内网 IP）走 FN ID 登录；'
                            + '如果之前能进、现在突然报错，说明 NAS 侧会话已过期，重新走一次 FN ID 登录即可。';
                    } else if (isAppShell || isServerErrorPage) {
                        // 典型表现：地址/端口填错，请求打到了网页首页或网关错误页。
                        diag = '地址/端口错误';
                        message = '服务器返回的是网页首页/错误页（HTML），而不是接口数据。'
                            + '说明填写的地址或端口不对，请求打到了网页而非飞牛影视接口（正确接口路径形如 /v/api/v1/...）。'
                            + '👉 请这样做：检查登录框里的「服务器地址」——内网应填 http://IP:端口（默认端口 18888，例如 http://192.168.31.170:18888），'
                            + '确认 IP 正确、端口没漏填、没有多余的路径或域名后缀。';
                    } else {
                        // 兜底：正文特征不明显，两种情况都有可能。
                        diag = '未知';
                        message = `服务器返回了网页(HTML)而非接口数据（HTTP ${response.status}）。`
                            + '这可能是地址填错（请求打到了网页）或未登录（被重定向到登录页）。'
                            + '👉 请检查：① 服务器地址/IP:端口 是否正确（接口应返回 JSON）；② 是否应使用 FN ID 登录或重新登录（会话可能已过期）。';
                    }

                    log.error(`[HTML响应诊断] 判定=${diag}`);
                    // 关键结论写进精简报错日志，方便用户一眼看到「是什么问题、该怎么做」
                    log.key(`[接口诊断结论] 判定=${diag} | URL=${fullUrl} | HTTP ${response.status}`);
                    log.key(`[接口诊断结论] 处理建议: ${message}`);
                    return {
                        success: false,
                        message,
                        htmlResponse: true
                    };
                }
                if (!contentType.includes('application/json')) {
                    return {
                        success: true,
                        data: response.data as any, // 直接返回原始数据(二进制等)
                    };
                }
            }

            const res = response.data;

            // 处理签名错误的重试逻辑
            if (res.code === 5000 && res.msg === 'invalid sign') {
                if (attempt >= tryTimes) {
                    return {
                        success: false,
                        message: `尝试次数过多 try_times = ${attempt + 1}`
                    };
                }

                log.warn(`fn_api 请求时签名错误，重试中 attempt = ${attempt + 1}, url: ${fullUrl}`);
                await setTimeout(100); // 等待100ms
                continue; // 继续下一次循环
            }

            // 处理业务错误
            if (res.code !== 0) {
                // 注意：如果重定向返回 HTML，res.code 会是 undefined，这里要小心
                log.error(`fn_api 请求失败`, res);
                return { success: false, message: res.msg || `HTTP Error ${response.status}` };
            }

            return {
                success: true,
                data: res.data
            };

        } catch (error: any) {
            const errorCode = error.code || 'UNKNOWN';
            // 优先获取 error.message，因为 connection error 没有 response
            const errorMsg = error.message;
            const respData = error.response ? JSON.stringify(error.response.data) : 'No Response Data';

            log.error(`请求异常: [${errorCode}] ${errorMsg} | Resp: ${respData} | URL: ${fullUrl}`);

            // 检查是否为证书验证错误且URL未被信任
            if (isCertificateError(error) && !isTrusted(baseUrl)) {
                log.warn(`检测到证书验证错误: code: ${errorCode}, msg: ${errorMsg}, URL: ${fullUrl}`);

                // 返回特殊的证书错误响应，让上层处理
                return {
                    success: false,
                    message: errorMsg,
                    // 添加一个特殊标识表示这是证书错误
                    certificateError: true
                } as ApiResponse<T> & { certificateError?: boolean };
            }

            // 如果是最后一次尝试，返回精准错误提示
            if (attempt >= tryTimes) {
                // 无 HTTP 响应 = 连接层失败(DNS/端口无监听/网络不可达)，与业务报错区分
                const isConnErr = !error.response;

                // 1) 连接层错误（网络不通/地址错/端口错）：按错误码给可操作建议
                const netHint = NETWORK_ERROR_HINTS[errorCode];
                if (netHint) {
                    log.key(`[网络诊断结论] ${netHint}（技术细节：${errorMsg}）| URL=${fullUrl}`);
                    return { success: false, message: `${netHint}（技术细节：${errorMsg}）`, networkError: isConnErr };
                }

                // 2) HTTP 4xx/5xx 但响应体是 HTML（如网关 502 错误页）：归为地址/服务问题
                const rdata = error.response && (error.response as any).data;
                if (typeof rdata === 'string' && rdata.toLowerCase().includes('html')) {
                    log.key(`[接口诊断结论] 服务器返回错误页(HTML)，地址/服务问题 | URL=${fullUrl}`);
                    return {
                        success: false,
                        message: '服务器返回了错误页（HTML）。请检查服务器地址/IP:端口 是否正确（接口应返回 JSON），以及服务是否正常运行。'
                    };
                }

                // 3) 其它错误：保留原始 message 以便高级用户排查
                log.key(`[请求异常结论] ${errorMsg} | URL=${fullUrl}`);
                return { success: false, message: errorMsg, networkError: isConnErr };
            }

            await setTimeout(100);
        }
    }

    // 这行代码理论上不会执行到，但为了类型安全加上
    return {
        success: false,
        message: '重试逻辑异常'
    };
}
