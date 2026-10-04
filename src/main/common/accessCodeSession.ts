import { net, session, Session } from 'electron';
import log from '../../modules/logger';

// accessCodeSession.ts — [访问码] fnOS 网关「应用访问码」会话建立（移植自上游 fntv-electron
// PR #157 codex/access-code-login 的 accessCodeSession.ts，按本项目架构适配）。
//
// 与上游的差异：
//   1. 不引入 accessGrant 内存授权表 —— 本项目 request.ts 的 lc-294 已把 persist:fntv
//      会话 Cookie 全量转发给主进程 API，lc-295 已把会话 Cookie 传给 Go 代理/兜底代理，
//      网关 Cookie 落入 persist:fntv 后自动搭车，无需单独的授权表与 Go 侧传参。
//   2. 404 宽容：fnOS 未开启访问码门禁（或 FN ID 中继域名）时网关可能没有
//      /access_code_verify 端点 → 视为「无门禁」直接放行，不算失败（上游一律报错，
//      会让没开门禁却填了访问码的用户登录被卡死）。
//
// 契约（与上游 PRD 一致）：
//   - 验证端点 GET /access_code_verify，头部 x-access-code = base64(访问码)、x-access-source: web；
//   - 手动跟随同主机重定向（禁 https→http 降级），解析出的真实 origin 回传给调用方
//     （顺带修正 80 端口重定向场景的域名）；
//   - 401/403/429 = 访问码被拒（reason:'rejected'），其余失败 = 网络/服务异常（reason:'network'）；
//   - 网关授权 Cookie 由 persist:fntv 会话持有（net.request 绑定该会话 + useSessionCookies）；
//   - 明文访问码只出现在内存参数里，绝不落日志/URL/磁盘明文（磁盘用 config.ts 的 AES 加密）。

const MAX_REDIRECTS = 5;
const VERIFY_TIMEOUT_MS = 10000;
// 访问码被网关明确拒绝的状态码（上游同款）
const REJECTED_STATUS_CODES = new Set([401, 403, 429]);

export type AccessCodeSessionResult = {
    /** 验证过程跟随重定向后解析出的真实源（形如 https://ip:5667）；调用方应把它回写到 server */
    baseUrl: string;
};

export class AccessCodeVerificationError extends Error {
    readonly reason: 'rejected' | 'network';

    constructor(reason: 'rejected' | 'network', message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'AccessCodeVerificationError';
        this.reason = reason;
    }
}

function parseBaseUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AccessCodeVerificationError('network', '访问码验证地址无效');
    }
    return url;
}

/** 校验并解析重定向目标：仅允许同主机、禁 https→http 降级（防止把访问码带去别的主机） */
export function resolveAccessCodeRedirect(sourceValue: string, targetValue: string): URL {
    const source = parseBaseUrl(sourceValue);
    const target = new URL(targetValue, source);
    const isWebProtocol = target.protocol === 'http:' || target.protocol === 'https:';
    const isSameHost = source.hostname === target.hostname;
    const isSecureTransition = !(source.protocol === 'https:' && target.protocol === 'http:');
    if (!isWebProtocol || !isSameHost || !isSecureTransition) {
        throw new AccessCodeVerificationError('network', '访问码验证拒绝跨主机或不安全重定向');
    }
    return target;
}

export function encodeAccessCode(accessCode: string): string {
    return Buffer.from(accessCode, 'utf8').toString('base64');
}

type GatewayRequestResult = { status: number; url: string };

/**
 * 用 Electron net 模块（绑定 persist:fntv 会话 + useSessionCookies）GET 验证端点，
 * 手动跟随重定向。响应头里的 Set-Cookie 会直接写进 persist:fntv 会话 —— 网关授权即建立。
 */
function requestAccessCode(gatewaySession: Session, url: string, headers: Record<string, string>): Promise<GatewayRequestResult> {
    return new Promise((resolve, reject) => {
        let currentUrl = parseBaseUrl(url);
        let redirects = 0;
        let settled = false;
        const request = net.request({
            method: 'GET',
            url: currentUrl.toString(),
            session: gatewaySession,
            useSessionCookies: true,
            redirect: 'manual',
        });
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            request.abort();
            reject(new AccessCodeVerificationError('network', '访问码验证请求超时'));
        }, VERIFY_TIMEOUT_MS);
        const finish = (err: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            request.abort();
            reject(err);
        };

        for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);

        request.on('redirect', (_statusCode: number, _method: string, redirectUrl: string) => {
            try {
                redirects++;
                if (redirects > MAX_REDIRECTS) {
                    throw new AccessCodeVerificationError('network', '访问码验证重定向次数过多');
                }
                currentUrl = resolveAccessCodeRedirect(currentUrl.toString(), redirectUrl);
                request.followRedirect();
            } catch (error) {
                finish(error);
            }
        });
        request.on('response', (response) => {
            response.on('data', () => undefined); // 只关心状态码，丢弃响应体
            response.on('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ status: response.statusCode, url: currentUrl.toString() });
            });
            response.on('error', (error) => finish(error));
        });
        request.on('error', (error) => finish(error));
        request.end();
    });
}

/**
 * 建立 fnOS 访问码网关会话。
 * @param baseUrl 服务器地址（含协议，可带端口）
 * @param accessCode 用户填写的访问码（调用方保证非空 trim）
 * @returns 解析后的真实源 origin
 * @throws AccessCodeVerificationError reason='rejected'（码错）| 'network'（连不上/服务异常）
 */
export async function establishAccessCodeSession(
    baseUrl: string,
    accessCode: string,
    gatewaySession: Session = session.fromPartition('persist:fntv'),
): Promise<AccessCodeSessionResult> {
    const initialUrl = parseBaseUrl(baseUrl);
    const normalizedCode = accessCode.trim();
    if (!normalizedCode) {
        // 原样返回（保留 FN ID 中继域名可能携带的路径），调用方按字符串比较决定是否回写
        return { baseUrl };
    }

    const verificationUrl = new URL('/access_code_verify', initialUrl);
    let response: GatewayRequestResult;
    try {
        response = await requestAccessCode(gatewaySession, verificationUrl.toString(), {
            'x-access-code': encodeAccessCode(normalizedCode),
            'x-access-source': 'web',
        });
    } catch (error) {
        if (error instanceof AccessCodeVerificationError) throw error;
        throw new AccessCodeVerificationError('network', '无法连接到访问码验证服务', { cause: error });
    }

    if (REJECTED_STATUS_CODES.has(response.status)) {
        throw new AccessCodeVerificationError('rejected', '访问码错误');
    }
    // [适配] 404 = 网关没有验证端点：未开启访问码门禁的 fnOS / FN ID 中继域名。
    // 视为「无门禁」放行（Cookie 会话此刻无从建立，后续门禁若真存在会由登录接口的
    // HTML 响应兜底流程接管），不应让多填了访问码的用户登录失败。
    // 原样返回输入值（保留中继域名路径），不得返回 origin 丢掉路径。
    if (response.status === 404) {
        log.info(`[访问码] 网关无验证端点(${response.url})，视为未开启门禁，跳过会话建立`);
        return { baseUrl };
    }
    if (response.status < 200 || response.status >= 300) {
        throw new AccessCodeVerificationError('network', `访问码验证服务返回 HTTP ${response.status}`);
    }

    const resolvedUrl = parseBaseUrl(response.url);
    log.key(`[访问码] 网关验证通过，会话已写入 persist:fntv | 真实源=${resolvedUrl.origin}`);
    return { baseUrl: resolvedUrl.origin };
}
