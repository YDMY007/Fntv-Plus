import axios from 'axios';
import * as https from 'https';
import * as net from 'net';
import log from '../../modules/logger';
import * as proxyModule from '../../modules/proxyAgent';

// externalFetch.ts — [lc-1061] 外部 API 国内直连优选器（跳过功能数据链基建）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：AniSkip/Jikan/AniList 等外部数据 API 从国内直连时通时断（本地 DNS 污染/线路抖动），
//   而跳过片头片尾、MAL 映射链全依赖它们。TMDB 已有「免梯直连」（CheckTMDB 固定 IP + 自定义
//   lookup），但那些 IP 是 TMDB 专属快照——外部 API 需要通用方案：
//   ① DoH 解析：用国内可达的 DNS-over-HTTPS 服务（AliDNS 223.5.5.5 / DNSpod 1.12.12.12，
//      直接以 IP 访问不需要 DNS）拿到目标域名的真实 A 记录，绕过本地污染；
//   ② TCP 握手探速：对解析出的候选 IP 逐个 net.connect(:443) 计时，取最快可达者；
//   ③ SNI 直连：https.Agent 自定义 lookup 返回该 IP（TLS 仍用原域名，证书校验不受影响）；
//   ④ 回退链：直连域名 → DoH IP 直连 → 用户代理(HTTPS_PROXY/设置面板自定义, 复用 proxyAgent)。
// 结果按 host 记忆（内存 + 成功后 TTL 6h 内复用），失败自动降级重试下一策略。

const PROBE_TIMEOUT = 2500;
const STRATEGY_TTL = 6 * 60 * 60 * 1000; // 优选结果有效期 6h

/** 参与优选的外部 API 域名（其余域名直连不动） */
const MANAGED_HOSTS = new Set([
    'api.aniskip.com',
    'api.jikan.moe',
    'graphql.anilist.co',
    'api.bgm.tv',
    'api.theintrodb.org',
]);

type Strategy = 'direct' | 'doh-ip' | 'proxy';

/** host → { strategy, ip?, at } 成功记忆 */
const goodStrategy = new Map<string, { strategy: Strategy; ip?: string; at: number }>();
/** DoH 解析缓存： host → { ips, at }（2h） */
const dohCache = new Map<string, { ips: string[]; at: number }>();

/** 是否托管域名 */
function isManaged(host: string): boolean {
    return MANAGED_HOSTS.has(host);
}

/** DoH 解析（AliDNS / DNSpod，均为国内直连 IP 端点，查询本身不需要 DNS） */
async function dohResolve(host: string): Promise<string[]> {
    const cached = dohCache.get(host);
    if (cached && Date.now() - cached.at < 2 * 60 * 60 * 1000) return cached.ips;
    const endpoints = [
        `https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=A`,
        `https://1.12.12.12/resolve?name=${encodeURIComponent(host)}&type=A`,
    ];
    const ips: string[] = [];
    for (const ep of endpoints) {
        try {
            const r = await axios.get(ep, { timeout: 4000 });
            const answers = r.data?.Answer || [];
            for (const a of answers) {
                if (a.type === 1 && typeof a.data === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data)) {
                    if (!ips.includes(a.data)) ips.push(a.data);
                }
            }
            if (ips.length) break; // 第一家出结果就够
        } catch { /* 下一家 */ }
    }
    dohCache.set(host, { ips, at: Date.now() });
    return ips;
}

/** TCP 握手探速：返回按连接耗时升序的可达 IP */
function probeIps(ips: string[]): Promise<{ ip: string; ms: number }[]> {
    return new Promise((resolve) => {
        const results: { ip: string; ms: number }[] = [];
        let pending = ips.length;
        if (!pending) { resolve(results); return; }
        for (const ip of ips) {
            const started = Date.now();
            const sock = net.connect({ host: ip, port: 443, timeout: PROBE_TIMEOUT });
            const finish = (ok: boolean): void => {
                if (pending <= 0) return;
                pending--;
                sock.removeAllListeners();
                sock.destroy();
                if (ok) results.push({ ip, ms: Date.now() - started });
                if (pending === 0) resolve(results.sort((a, b) => a.ms - b.ms));
            };
            sock.once('connect', () => finish(true));
            sock.once('timeout', () => finish(false));
            sock.once('error', () => finish(false));
        }
    });
}

/** SNI 直连 agent：TLS 用原域名，连接用指定 IP */
function sniAgent(ip: string): https.Agent {
    return new https.Agent({
        keepAlive: false,
        lookup: (hostname: any, opts: any, cb: any) => {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            opts = opts || {};
            if (opts.all) return cb(null, [{ address: ip, family: 4 }]);
            return cb(null, ip, 4);
        },
    });
}

/** 记住/读取某 host 的优选策略 */
function rememberGood(host: string, strategy: Strategy, ip?: string): void {
    goodStrategy.set(host, { strategy, ip, at: Date.now() });
}
function recallGood(host: string): { strategy: Strategy; ip?: string; at: number } | null {
    const g = goodStrategy.get(host);
    if (!g) return null;
    if (Date.now() - g.at > STRATEGY_TTL) { goodStrategy.delete(host); return null; }
    return g;
}

/** 单次 axios 请求（按策略构造 agent/proxy） */
async function axiosOnce(url: string, strategy: Strategy, ip: string | undefined,
    method: 'GET' | 'POST', opts: { timeout?: number; headers?: any; data?: any }): Promise<any> {
    const cfg: any = {
        method,
        url,
        timeout: opts.timeout || 8000,
        headers: opts.headers,
        data: opts.data,
        proxy: false, // agent/代理由本模块接管，关闭 axios 环境代理探测
    };
    if (strategy === 'doh-ip' && ip) cfg.httpsAgent = sniAgent(ip);
    if (strategy === 'proxy') {
        const agent = proxyModule.resolveProxyAgent();
        if (agent) cfg.httpsAgent = agent;
    }
    return axios(cfg);
}

/**
 * 外部 API 请求统一入口：按「记忆策略 → 直连 → DoH IP 直连 → 用户代理」顺序尝试，
 * 全部失败才 throw。仅托管域名启用优选，其余直连透传。
 */
export async function extRequestJson(method: 'GET' | 'POST', url: string,
    opts: { timeout?: number; headers?: any; data?: any } = {}): Promise<any> {
    const host = new URL(url).hostname;
    if (!isManaged(host)) {
        const r = await axiosOnce(url, 'direct', undefined, method, opts);
        return r.data;
    }

    // 0) 记忆中的可用策略直接先用
    const remembered = recallGood(host);
    if (remembered) {
        try {
            const r = await axiosOnce(url, remembered.strategy, remembered.ip, method, opts);
            rememberGood(host, remembered.strategy, remembered.ip);
            return r.data;
        } catch { /* 记忆失效 → 走完整链 */ }
    }

    // 1) 直连域名
    try {
        const r = await axiosOnce(url, 'direct', undefined, method, opts);
        rememberGood(host, 'direct');
        log.info(`[extFetch] ${host} 直连可用`);
        return r.data;
    } catch { /* 下一步 */ }

    // 2) DoH 解析 + 探速 → 最快 IP 直连
    try {
        const ips = await dohResolve(host);
        const probed = await probeIps(ips);
        if (probed.length) {
            const best = probed[0];
            const r = await axiosOnce(url, 'doh-ip', best.ip, method, opts);
            rememberGood(host, 'doh-ip', best.ip);
            log.info(`[extFetch] ${host} DoH 直连可用 ip=${best.ip} (${best.ms}ms，候选 ${probed.length} 个)`);
            return r.data;
        }
    } catch { /* 下一步 */ }

    // 3) 用户代理（HTTPS_PROXY / 设置面板自定义）
    try {
        const agent = proxyModule.resolveProxyAgent();
        if (agent) {
            const r = await axiosOnce(url, 'proxy', undefined, method, opts);
            rememberGood(host, 'proxy');
            log.info(`[extFetch] ${host} 经用户代理可用`);
            return r.data;
        }
    } catch { /* 落到最终失败 */ }

    throw new Error(`外部 API 全部策略失败: ${host}`);
}

export async function extGetJson(url: string, opts: { timeout?: number; headers?: any } = {}): Promise<any> {
    return extRequestJson('GET', url, opts);
}
export async function extPostJson(url: string, data: any, opts: { timeout?: number; headers?: any } = {}): Promise<any> {
    return extRequestJson('POST', url, Object.assign({ data }, opts));
}

/** 诊断：对全部托管域名做一次优选并返回结果（设置面板/日志用） */
export async function probeAllHosts(): Promise<{ host: string; ok: boolean; via?: string; ms?: number }[]> {
    const out: { host: string; ok: boolean; via?: string; ms?: number }[] = [];
    for (const host of MANAGED_HOSTS) {
        const started = Date.now();
        try {
            await extGetJson(`https://${host}/`, { timeout: 6000 });
            out.push({ host, ok: true, via: recallGood(host)?.strategy, ms: Date.now() - started });
        } catch (e) {
            const httpReachable = !!(e as any).response; // 4xx/5xx = 网络层可达(应用层错误另算)
            out.push({ host, ok: httpReachable, via: (recallGood(host)?.strategy || 'direct') + (httpReachable ? '(http层)' : ''), ms: Date.now() - started });
        }
    }
    return out;
}
