import HttpsProxyAgentMod = require('https-proxy-agent');
import * as logger from './logger';
import * as fnConfig from './fn_config/config';

const log = logger.component('proxy');

/**
 * 统一代理出口：让 Bangumi 每日放送、TMDB 等数据源走用户自定义 HTTP/HTTPS 代理。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量（HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy）—— 已有的梯子变量，最高优先。
 *   2. 设置面板「自定义代理」(fnConfig.customProxyEnabled + customProxy) —— 用户填写的代理入口。
 *
 * 仅支持 HTTP/HTTPS 代理；SOCKS 需改用梯子的「HTTP 代理端口」（与历史 TMDB 逻辑一致）。
 * 返回 axios 可用的 httpsAgent（已禁用 axios 自带代理逻辑由调用方设置 proxy:false），无可用代理则 undefined。
 */

/** 校验代理地址是否可用（HTTP/HTTPS 协议，非 SOCKS），返回清洗后的 URL 或 null */
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

/** 校验 + 脱敏日志辅助；非法（如 SOCKS）返回 null */
function sanitizeProxy(raw: string, src: string): string | null {
    if (/^socks/i.test(raw)) {
        log.warn('检测到 SOCKS 代理（' + src + '），但当前内置仅支持 HTTP/HTTPS 代理；' +
            '请在梯子设置里改用「HTTP 代理端口」，或在设置面板填写 HTTP 类代理地址。');
        return null;
    }
    if (!/^https?:\/\//i.test(raw)) {
        log.warn('代理地址格式不合法（须以 http:// 或 https:// 开头）：' + src + '=' + raw);
        return null;
    }
    return raw;
}

/**
 * 解析当前应当使用的代理 agent（无代理则 undefined）。
 * 调用方拿到非 undefined 后应：把 agent 设为 httpsAgent，并关闭 axios 自带代理（proxy:false）。
 */
export function resolveProxyAgent(): HttpsProxyAgentMod.HttpsProxyAgent | undefined {
    const raw = pickProxyUrl();
    if (!raw) return undefined;
    try {
        const agent = new HttpsProxyAgentMod.HttpsProxyAgent(raw);
        const masked = raw.replace(/\/\/[^@]+@/, '//***@');
        log.info('已启用代理 ' + masked);
        return agent;
    } catch (e: any) {
        log.warn('代理初始化失败：' + String(e && e.message));
        return undefined;
    }
}

// CommonJS 导出，确保与现有代码兼容
module.exports = { resolveProxyAgent };
