import * as crypto from 'crypto';
import axios, { AxiosResponse } from 'axios';
import { setTimeout } from 'timers/promises';
import https from 'https';
import log from '../logger';
import { isTrusted, showCertificateTrustDialog, isCertificateError, addTrustedHost } from '../cert_trust';

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

    const headers = {
        "Content-Type": "application/json",
        "Authorization": token,
        "Cookie": "mode=relay",
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
                    const isLoginPage = /(<input[^>]*type=["']?password|password|登录|sign\s*in|signin|fn\s*id|fnid|oauth|授权登录|账号|用户名)/.test(htmlLower);
                    const isAppShell = /<div[^>]*id=["'](app|root)["']|id=["']app["']|id=["']root["']|__nuxt|__next|<script[^>]*\.js/.test(rawBody);
                    const isServerErrorPage = /(404 not found|502 bad gateway|503 service|nginx|upstream|proxy error|网关|内部错误|无法访问|服务器错误)/.test(htmlLower);

                    let message: string;
                    let diag: string;
                    if (isLoginPage) {
                        // 典型表现：未登录 / FN ID 会话过期，/v/api 被 302 到登录页。
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
                    return {
                        success: false,
                        message
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
                // 1) 连接层错误（网络不通/地址错/端口错）：按错误码给可操作建议
                const netHint = NETWORK_ERROR_HINTS[errorCode];
                if (netHint) {
                    return { success: false, message: `${netHint}（技术细节：${errorMsg}）` };
                }

                // 2) HTTP 4xx/5xx 但响应体是 HTML（如网关 502 错误页）：归为地址/服务问题
                const rdata = error.response && (error.response as any).data;
                if (typeof rdata === 'string' && rdata.toLowerCase().includes('html')) {
                    return {
                        success: false,
                        message: '服务器返回了错误页（HTML）。请检查服务器地址/IP:端口 是否正确（接口应返回 JSON），以及服务是否正常运行。'
                    };
                }

                // 3) 其它错误：保留原始 message 以便高级用户排查
                return { success: false, message: errorMsg };
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
