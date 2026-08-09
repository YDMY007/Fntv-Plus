import HttpsProxyAgentMod = require('https-proxy-agent');
import SocksProxyAgentMod = require('socks-proxy-agent');
import axios from 'axios';
import * as logger from './logger';
import * as fnConfig from './fn_config/config';

const log = logger.component('proxy');

/** 代理 agent 联合类型：HTTP/HTTPS 用 HttpsProxyAgent，SOCKS 用 SocksProxyAgent */
export type ProxyAgent = HttpsProxyAgentMod.HttpsProxyAgent | SocksProxyAgentMod.SocksProxyAgent;

/**
 * 统一代理出口：让 Bangumi 每日放送、TMDB 等数据源走用户自定义代理。
 *
 * 支持的协议（地址 scheme 决定）：
 *   - http://   / https://   → 走 HttpsProxyAgent（HTTP CONNECT 隧道，https 目标会自动 TLS）
 *   - socks5:// / socks5h:// / socks4:// / socks4a:// → 走 SocksProxyAgent
 * 鉴权：地址内可带 user:pass@host:port（如 http://user:pass@127.0.0.1:7890）；
 *       或在设置面板分别填写账号/密码，保存时拼入 URL。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量（HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy）—— 已有的梯子变量，最高优先。
 *   2. 设置面板「自定义代理」(fnConfig.customProxyEnabled + customProxy) —— 用户填写的代理入口。
 *
 * 返回 axios 可用的 httpsAgent（调用方须设 proxy:false 关闭 axios 自带代理逻辑），无可用代理则 undefined。
 */

/** 根据原始代理 URL 构造对应 agent（按 scheme 选 HttpsProxyAgent / SocksProxyAgent） */
function buildAgent(raw: string): ProxyAgent {
    const scheme = (raw.split('://')[0] || '').toLowerCase();
    if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks') {
        return new SocksProxyAgentMod.SocksProxyAgent(raw);
    }
    return new HttpsProxyAgentMod.HttpsProxyAgent(raw);
}

/** 校验代理地址可用（HTTP/HTTPS/SOCKS），返回清洗后的 URL 或 null */
function sanitizeProxy(raw: string, src: string): string | null {
    if (!/^(https?|socks[45]|socks5h|socks4a):\/\//i.test(raw)) {
        log.warn('代理地址格式不合法（须 http:// / https:// / socks5:// 开头且含主机:端口）：' + src + '=' + raw);
        return null;
    }
    return raw;
}

/** 取出当前应使用的代理 URL（环境变量优先，其次设置面板） */
function pickProxyUrl(): string | null {
    // 1) 环境变量优先
    const envRaw =
        process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy;
    if (envRaw && envRaw.trim()) {
        return sanitizeProxy(envRaw.trim(), '环境变量');
    }
    // 2) 设置面板自定义代理
    const cfg = fnConfig.getCustomProxyConfig();
    if (cfg.enabled && cfg.proxyUrl && cfg.proxyUrl.trim()) {
        return sanitizeProxy(cfg.proxyUrl.trim(), '自定义代理');
    }
    return null;
}

/**
 * 解析当前应当使用的代理 agent（无代理则 undefined）。
 * 调用方拿到非 undefined 后应：把 agent 设为 httpsAgent，并关闭 axios 自带代理（proxy:false）。
 */
export function resolveProxyAgent(): ProxyAgent | undefined {
    const raw = pickProxyUrl();
    if (!raw) return undefined;
    try {
        const agent = buildAgent(raw);
        log.info('已启用代理 ' + raw.replace(/\/\/[^@]+@/, '//***@'));
        return agent;
    } catch (e: any) {
        log.warn('代理初始化失败：' + String(e && e.message));
        return undefined;
    }
}

/**
 * 测试某代理地址连通性（不依赖已保存配置）：构造 agent 后请求 Bangumi 每日放送端点，
 * 返回是否可达。供设置面板「测试连接」按钮调用。
 */
export async function testProxyConnection(rawUrl: string): Promise<{ ok: boolean; info?: string; error?: string }> {
    const url = (rawUrl || '').trim();
    if (!url) return { ok: false, error: '地址为空' };
    const clean = sanitizeProxy(url, '测试');
    if (!clean) return { ok: false, error: '地址格式不合法（须 http(s):// 或 socks5:// 开头，且含主机:端口）' };
    let agent: ProxyAgent;
    try {
        agent = buildAgent(clean);
    } catch (e: any) {
        return { ok: false, error: '代理初始化失败：' + String(e && e.message) };
    }
    try {
        const resp = await axios.get('https://api.bgm.tv/calendar', {
            timeout: 12000,
            httpsAgent: agent,
            proxy: false,
        });
        const status = resp.status;
        if (status >= 200 && status < 400) {
            return { ok: true, info: '连接成功（HTTP ' + status + '）' };
        }
        // 4xx/5xx 也说明代理本身可达，只是端点返回了状态
        return { ok: true, info: '代理可达（端点返回 HTTP ' + status + '）' };
    } catch (e: any) {
        return { ok: false, error: '连接失败：' + String((e && e.message) || e) };
    }
}

// CommonJS 导出，确保与现有代码兼容
module.exports = { resolveProxyAgent, testProxyConnection };
