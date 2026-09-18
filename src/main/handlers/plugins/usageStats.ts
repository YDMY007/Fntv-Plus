import { app } from 'electron';
import axios from 'axios';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';

/**
 * [lc-1196] 匿名使用统计（主进程）
 *
 * 目标：知道「有多少人在用」，同时尽可能少地知道「是谁」。
 *
 * 隐私设计（最小化采集，四条硬约束）：
 *  1. 匿名 ID 在本机用 crypto.randomUUID() 随机生成，与账号 / 设备 / 机器码 / 安装路径
 *     全部无关联；用户在「关于」页可一键重置，重置后新旧数据即断开。
 *  2. 上报字段只有四个：匿名 ID、应用版本号、操作系统、CPU 架构。
 *     不含 IP（服务端代码里连 request.headers 都不读）、不含账号、不含媒体库 /
 *     文件路径 / 设备名 / 窗口尺寸等任何其它信息。
 *  3. 每天最多上报一次；服务端按 (匿名ID, 日期) 主键去重 —— 只能聚合成「人数」，
 *     反推不出「某个人某天干了什么」。
 *  4. 服务端地址未配置时不发任何请求；用户关闭开关后立即停止；开发模式默认不上报
 *     （避免作者自测把数据灌水）。
 *
 * 上报失败一律静默（记 debug 日志即可），绝不影响启动与使用体验。
 */

// 统计服务端地址：部署完 stats-server/ 后把 Worker 域名填到这里，
// 或用环境变量 FNTV_STATS_ENDPOINT 覆盖（便于本地调试）。
// 留空 = 功能静默关闭，一个字节都不会往外发。
const DEFAULT_ENDPOINT = '';

const PING_PATH = '/ping';
const TIMEOUT_MS = 6000;
const BOOT_DELAY_MS = 20000;           // 启动 20s 后再报，避开启动高峰
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 之后每 6 小时检查一次（跨天才补报）

/** 取统计服务端根地址（已去掉结尾斜杠）；空串表示未部署 */
export function getEndpoint(): string {
    const raw = (process.env.FNTV_STATS_ENDPOINT || DEFAULT_ENDPOINT || '').trim();
    return raw.replace(/\/+$/, '');
}

/** 本地日期 YYYY-MM-DD（按用户所在时区算「一天」，比 UTC 更贴近真实活跃） */
function todayStr(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/** 上报渠道是否可用（供反馈插件与 UI 复用，避免重复判断） */
export function isEndpointConfigured(): boolean {
    return getEndpoint().length > 0;
}

/**
 * 发一次「今日在线」心跳。
 * force=true 时忽略「今日已报」限速（用于面板手动测试）。
 */
export async function sendPing(force: boolean = false): Promise<{ ok: boolean; skipped?: string; error?: string }> {
    const endpoint = getEndpoint();
    if (!endpoint) return { ok: false, skipped: '未配置统计服务端地址' };
    if (!fnConfig.getStatsEnabled()) return { ok: false, skipped: '匿名统计已关闭' };
    if (!app.isPackaged && process.env.FNTV_STATS_FORCE !== '1') {
        return { ok: false, skipped: '开发模式默认不上报（设 FNTV_STATS_FORCE=1 可强制）' };
    }
    const today = todayStr();
    if (!force && fnConfig.getStatsLastPingDay() === today) {
        return { ok: false, skipped: '今日已上报' };
    }

    // ⚠ 这里是全部会被送出本机的内容，新增字段前请先想清楚是否必要
    const payload = {
        aid: fnConfig.getStatsAnonId(),
        v: appVersion(),
        os: osName(),
        arch: process.arch,
        d: today,
    };

    try {
        await axios.post(endpoint + PING_PATH, payload, {
            timeout: TIMEOUT_MS,
            headers: { 'content-type': 'application/json' },
        });
        fnConfig.setStatsLastPing(today, true);
        log.debug('[stats] 匿名心跳上报成功');
        return { ok: true };
    } catch (e: any) {
        fnConfig.setStatsLastPing(today, false);
        log.debug(`[stats] 匿名心跳上报失败（静默忽略）: ${e?.message || e}`);
        return { ok: false, error: String(e?.message || e) };
    }
}

/** 面板读取当前统计状态（匿名 ID 只回传前 8 位，够用户核对又不至于被复制滥用） */
async function handleGetStatsInfo(): Promise<any> {
    const id = fnConfig.getStatsAnonId();
    return {
        enabled: fnConfig.getStatsEnabled(),
        configured: isEndpointConfigured(),
        endpoint: getEndpoint(),
        lastDay: fnConfig.getStatsLastPingDay(),
        lastOk: fnConfig.getStatsLastPingOk(),
        anonIdShort: id ? id.slice(0, 8) : '',
        devMode: !app.isPackaged,
    };
}

async function handleSetStatsEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setStatsEnabled(!!enabled);
    log.info(`[stats] 匿名使用统计开关: ${!!enabled}`);
}

async function handleResetStatsId(): Promise<{ ok: boolean; id: string }> {
    const id = fnConfig.resetStatsAnonId();
    log.info('[stats] 匿名 ID 已重置');
    return { ok: true, id: id.slice(0, 8) };
}

async function handlePingNow(): Promise<any> {
    return await sendPing(true);
}

function init(): void {
    registerHandler('stats:get-info', handleGetStatsInfo, { useHandle: true });
    registerHandler('stats:set-enabled', handleSetStatsEnabled, { useHandle: true });
    registerHandler('stats:reset-id', handleResetStatsId, { useHandle: true });
    registerHandler('stats:ping-now', handlePingNow, { useHandle: true });

    if (!isEndpointConfigured()) {
        log.info('[stats] 未配置统计服务端地址（FNTV_STATS_ENDPOINT），匿名统计功能处于关闭状态');
        return;
    }
    // 启动后延时一次，随后每 6 小时检查（跨天自动补报当天）
    setTimeout(() => { void sendPing(false); }, BOOT_DELAY_MS);
    setInterval(() => { void sendPing(false); }, CHECK_INTERVAL_MS);
}

export { init };
