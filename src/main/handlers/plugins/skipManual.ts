// main/handlers/plugins/skipManual.ts
//
// [skip-manual] 片头/片尾手动标记插件（存储 + 配置 + 写回服务端）。
//
// 数据链路：
//   网页播放器「标记」面板（preload/plugins/skipMarker.ts）→ 本插件 IPC：
//     set       本地保存（userData/skip-manual.json，version=1）+ 保存即写回飞牛服务端
//               （复用 smartSkip 的 POST /api/v1/skipinfo 通道；整季=枚举全季集逐个写回，200ms 限速）
//     clear     「恢复自动」：清本地标记 → 服务端清零（best-effort）→ preload 以 force 重跑自动链
//     effective 「标记不准」入口显示判据：无手动标记 且 服务端已有跳过数据
//
// 优先级（人工 > 获取，用户已确认）：手动(本集) > 手动(季) > 飞牛服务端 > AniSkip > theintrodb；
//   smartSkip.handleFetchAndFill 的 Step 0 调 resolveManualSkip() 短路实现。
//
// 语义映射（飞牛 skipinfo 只有 2 值，手动标记是 4 值）：
//   fnSkipStart = introEnd（片头起点视为 0）
//   fnSkipEnd   = totalDuration - outroStart（片尾从结尾倒数的秒数）
// 本地 4 值全量保存；写回用 2 值派生值；自绘兜底按钮用精确 4 值。
//
// 红线：不碰播放器样式/窗口配置/GPU/DevTools（用户明确禁止）；本文件纯数据管道，
// 自有 UI 全部在 preload 侧（skipMarker.ts）。

import { app, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import log from '../../../modules/logger';
import * as fnConfig from '../../../modules/fn_config/config';
import { getSessionCookieHeader } from '../../../modules/fn_api/request';
import * as fn from '../../../modules/fn_api/api';
import { registerHandler } from '../core/ipcHandler';

const HTTP_TIMEOUT = 8000;
const PROXY_BASE = 'http://127.0.0.1:22346';
const STORE_VERSION = 1;
const SEASON_CACHE_TTL = 10 * 60 * 1000;   // 季 guid 解析内存缓存
const BATCH_WRITE_INTERVAL = 200;          // 整季批量写回限速(ms)

// ─── 数据模型 ───

export interface ManualSkipEntry {
    guid: string;
    scope: 'episode' | 'season';
    introStart: number;   // 秒；0 = 未标
    introEnd: number;
    outroStart: number;
    outroEnd: number;
    /** 飞牛语义派生值（保存时按当时总时长算好）：片头从 0 跳过的秒数 / 片尾结尾跳过的秒数 */
    fnSkipStart: number;
    fnSkipEnd: number;
    totalDuration: number;
    updatedAt: number;
}

interface ManualSkipFile {
    version: number;
    entries: Record<string, ManualSkipEntry>;
}

export interface ResolvedManualSkip {
    scope: 'episode' | 'season';
    introStart: number;
    introEnd: number;
    outroStart: number;
    outroEnd: number;
    skipStart: number;   // 飞牛语义：片头从 0 跳过的秒数
    skipEnd: number;     // 飞牛语义：片尾结尾跳过的秒数
}

// ─── 存储（userData/skip-manual.json；version 变更必须 +1 使旧缓存失效）───

function storePath(): string {
    return path.join(app.getPath('userData'), 'skip-manual.json');
}

function readStore(): ManualSkipFile {
    try {
        const raw = fs.readFileSync(storePath(), 'utf-8');
        const data = JSON.parse(raw) as ManualSkipFile;
        if (data && data.version === STORE_VERSION && data.entries && typeof data.entries === 'object') {
            return data;
        }
    } catch { /* 不存在/损坏 → 空库 */ }
    return { version: STORE_VERSION, entries: {} };
}

function writeStore(store: ManualSkipFile): void {
    try {
        fs.mkdirSync(path.dirname(storePath()), { recursive: true });
        fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
    } catch (e) {
        log.error('[skip-manual] 写本地存储失败:', (e as Error).message);
    }
}

function toResolved(e: ManualSkipEntry): ResolvedManualSkip {
    return {
        scope: e.scope,
        introStart: e.introStart || 0,
        introEnd: e.introEnd || 0,
        outroStart: e.outroStart || 0,
        outroEnd: e.outroEnd || 0,
        skipStart: e.fnSkipStart || 0,
        skipEnd: e.fnSkipEnd || 0,
    };
}

// ─── 季 guid 解析（10 分钟内存缓存；解析失败静默，降级为单集语义）───

const seasonGuidCache = new Map<string, { guid: string; at: number }>();

async function resolveSeasonGuid(guid: string): Promise<string | null> {
    const hit = seasonGuidCache.get(guid);
    if (hit && Date.now() - hit.at < SEASON_CACHE_TTL) return hit.guid || null;
    try {
        const config = fnConfig.readConfig() || {};
        const domain = config.domain || '';
        const token = config.token || '';
        if (!domain || !token) return null;
        const fnapi = new fn.ApiService(domain, token);
        const playResp = await fnapi.getPlayInfo(guid);
        if (!playResp.success || !playResp.data) return null;
        const info = playResp.data;
        const item = info.item;
        // 电影/单视频无季概念
        if (String(item.type || info.type || '') !== 'Episode') return null;
        const seasonGuid = String(info.parent_guid || item.parent_guid || '');
        seasonGuidCache.set(guid, { guid: seasonGuid, at: Date.now() });
        return seasonGuid || null;
    } catch (e) {
        log.warn('[skip-manual] 解析季 guid 失败:', (e as Error).message);
        return null;
    }
}

// ─── 手动标记解析（smartSkip.handleFetchAndFill Step 0 调用；人工真值最高优先）───

export async function resolveManualSkip(guid: string): Promise<ResolvedManualSkip | null> {
    if (!guid) return null;
    const store = readStore();
    const direct = store.entries[guid];
    if (direct) return toResolved(direct);
    const seasonGuid = await resolveSeasonGuid(guid);
    if (!seasonGuid) return null;
    const seasonEntry = store.entries[seasonGuid];
    if (seasonEntry && seasonEntry.scope === 'season') return toResolved(seasonEntry);
    return null;
}

// ─── 飞牛服务端读写（GET/POST 形状与 smartSkip 逐一对照，同一通道）───

function fnosConn(): { domain: string; token: string } | null {
    const config = fnConfig.readConfig() || {};
    const domain = config.domain || '';
    const token = config.token || '';
    if (!domain || !token) return null;
    return { domain, token };
}

async function readSkipFromFnos(guid: string): Promise<{ skipStart: number; skipEnd: number } | null> {
    try {
        const conn = fnosConn();
        if (!conn) return null;
        let cookie = '';
        try { cookie = await getSessionCookieHeader(conn.domain); } catch { /* 无 cookie 不阻断 */ }
        const getUrl = `${PROXY_BASE}/api/v1/skipinfo/${guid}?token=${encodeURIComponent(conn.token)}&domain=${encodeURIComponent(conn.domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
        const resp = await axios.get(getUrl, { timeout: HTTP_TIMEOUT });
        if (resp.data && resp.data.code === 0 && resp.data.data) {
            const d = resp.data.data;
            const skipStart = Number(d.skipStart) || 0;
            const skipEnd = Number(d.skipEnd) || 0;
            if (skipStart > 0 || skipEnd > 0) return { skipStart, skipEnd };
        }
        return null;
    } catch (e) {
        log.warn('[skip-manual] 读飞牛 skipinfo 失败:', (e as Error).message);
        return null;
    }
}

async function writeSkipToFnos(guid: string, skipStart: number, skipEnd: number): Promise<{ ok: boolean; message?: string }> {
    try {
        const conn = fnosConn();
        if (!conn) return { ok: false, message: '未配置飞牛连接' };
        let cookie = '';
        try { cookie = await getSessionCookieHeader(conn.domain); } catch { /* ignore */ }
        const postUrl = `${PROXY_BASE}/api/v1/skipinfo?token=${encodeURIComponent(conn.token)}&domain=${encodeURIComponent(conn.domain)}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`;
        await axios.post(postUrl, { guid, skipStart, skipEnd }, { timeout: HTTP_TIMEOUT });
        return { ok: true };
    } catch (e) {
        return { ok: false, message: (e as Error).message };
    }
}

async function listSeasonEpisodes(seasonGuid: string): Promise<string[]> {
    try {
        const conn = fnosConn();
        if (!conn) return [];
        const fnapi = new fn.ApiService(conn.domain, conn.token);
        const resp = await fnapi.getItemListCached({
            parent_guid: seasonGuid,
            exclude_folder: 1,
            sort_column: 'index_number',
            sort_type: 'ASC',
        });
        const list: any[] = (resp && resp.data && resp.data.list) || [];
        return list
            .filter((it: any) => String(it.type || '').toLowerCase() === 'episode' && it.guid)
            .map((it: any) => String(it.guid));
    } catch (e) {
        log.warn('[skip-manual] 枚举整季集失败:', (e as Error).message);
        return [];
    }
}

// ─── IPC 处理器 ───

async function handleGet(_event: IpcMainInvokeEvent, params: { guid?: string }): Promise<ManualSkipEntry | null> {
    const guid = String((params && params.guid) || '').trim();
    if (!guid) return null;
    return readStore().entries[guid] || null;
}

interface SetManualParams {
    guid?: string;
    scope?: 'episode' | 'season';
    introStart?: number;
    introEnd?: number;
    outroStart?: number;
    outroEnd?: number;
    totalDuration?: number;
}

interface SetManualResult {
    saved: boolean;
    writtenBack: boolean;
    written: number;
    total: number;
    message?: string;
}

async function handleSet(_event: IpcMainInvokeEvent, params: SetManualParams): Promise<SetManualResult> {
    const guid = String((params && params.guid) || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(guid)) {
        return { saved: false, writtenBack: false, written: 0, total: 0, message: 'guid 非法' };
    }
    const cfg = fnConfig.getSkipManualConfig();
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : 0);
    const introStart = num(params && params.introStart);
    const introEnd = num(params && params.introEnd);
    const outroStart = num(params && params.outroStart);
    const outroEnd = num(params && params.outroEnd);
    const totalDuration = num(params && params.totalDuration);
    const wantSeason = !!(params && params.scope === 'season');

    // 区间合法性（止为 0 视为未标）
    if (introEnd > 0 && introEnd <= introStart) {
        return { saved: false, writtenBack: false, written: 0, total: 0, message: '片头区间非法（终点需大于起点）' };
    }
    if (outroEnd > 0 && outroEnd <= outroStart) {
        return { saved: false, writtenBack: false, written: 0, total: 0, message: '片尾区间非法（终点需大于起点）' };
    }
    if (introEnd === 0 && outroStart === 0) {
        return { saved: false, writtenBack: false, written: 0, total: 0, message: '至少标记片头或片尾' };
    }

    // 飞牛语义派生值（写回载荷用 2 值；本地 4 值全量保存）
    const fnSkipStart = introEnd > 0 ? Math.round(introEnd) : 0;
    const fnSkipEnd = outroStart > 0 && totalDuration > 0 ? Math.max(0, Math.round(totalDuration - outroStart)) : 0;

    // 本地保存：季级存季 guid（解析不到季则降级为单集语义）
    const store = readStore();
    let storeGuid = guid;
    let entryScope: 'episode' | 'season' = 'episode';
    if (wantSeason) {
        const seasonGuid = await resolveSeasonGuid(guid);
        if (seasonGuid) {
            storeGuid = seasonGuid;
            entryScope = 'season';
        }
    }
    store.entries[storeGuid] = {
        guid: storeGuid,
        scope: entryScope,
        introStart,
        introEnd,
        outroStart,
        outroEnd,
        fnSkipStart,
        fnSkipEnd,
        totalDuration,
        updatedAt: Date.now(),
    };
    writeStore(store);
    log.info(`[skip-manual] 已保存标记 guid=${storeGuid} scope=${entryScope} intro=${introStart}~${introEnd} outro=${outroStart}~${outroEnd}`);
    // 保存即写回（用户已确认写回语义）
    let writtenBack = false;
    let written = 0;
    let total = 0;
    let message = '';
    if (!cfg.writeBack) {
        message = '写回已关闭（仅本地生效）';
    } else if (fnSkipStart > 0 || fnSkipEnd > 0) {
        if (entryScope === 'season') {
            const eps = await listSeasonEpisodes(storeGuid);
            total = eps.length;
            for (const epGuid of eps) {
                const r = await writeSkipToFnos(epGuid, fnSkipStart, fnSkipEnd);
                if (r.ok) written += 1;
                await new Promise((res) => setTimeout(res, BATCH_WRITE_INTERVAL));
            }
            writtenBack = written > 0;
            if (total > 0 && written < total) message = `整季写回 ${written}/${total} 集`;
            log.info(`[skip-manual] 整季写回完成 ${written}/${total}`);
        } else {
            const r = await writeSkipToFnos(guid, fnSkipStart, fnSkipEnd);
            writtenBack = r.ok;
            total = 1;
            written = r.ok ? 1 : 0;
            if (!r.ok) message = '写回服务端失败：' + (r.message || '');
            else log.info(`[skip-manual] 已写回服务端 guid=${guid} start=${fnSkipStart} end=${fnSkipEnd}`);
        }
    }
    if (introEnd > cfg.introSoftLimit) {
        message = (message ? message + '；' : '') + `片头 ${Math.round(introEnd)}s 超过合理上限 ${cfg.introSoftLimit}s，请确认标记是否准确`;
    }
    return { saved: true, writtenBack, written, total, message: message || undefined };
}

async function handleClear(_event: IpcMainInvokeEvent, params: { guid?: string }): Promise<{
    cleared: boolean;
    zeroed: boolean;
    message?: string;
}> {
    const guid = String((params && params.guid) || '').trim();
    if (!guid) return { cleared: false, zeroed: false, message: '缺少 guid' };
    const store = readStore();
    // 清最贴合的一条：本集标记优先；无本集标记但命中季级标记时清季级（"恢复自动"的预期语义）
    let removed = false;
    if (store.entries[guid]) {
        delete store.entries[guid];
        removed = true;
    } else {
        const seasonGuid = await resolveSeasonGuid(guid);
        if (seasonGuid && store.entries[seasonGuid]) {
            delete store.entries[seasonGuid];
            removed = true;
        }
    }
    writeStore(store);
    log.info(`[skip-manual] 已清除标记 guid=${guid} removed=${removed}`);
    // 服务端清零（best-effort）：原生面板回到默认空值态；preload 随后以 force 重跑自动链重新填充
    const zero = await writeSkipToFnos(guid, 0, 0);
    return { cleared: removed, zeroed: zero.ok, message: zero.ok ? undefined : (zero.message || '服务端清零失败') };
}

async function handleEffective(_event: IpcMainInvokeEvent, params: { guid?: string }): Promise<{
    manual: ManualSkipEntry | null;
    server: { skipStart: number; skipEnd: number } | null;
}> {
    const guid = String((params && params.guid) || '').trim();
    if (!guid) return { manual: null, server: null };
    const store = readStore();
    const direct = store.entries[guid] || null;
    if (direct) return { manual: direct, server: null };   // 已手动修正 → 不再需要「标记不准」入口
    const seasonGuid = await resolveSeasonGuid(guid);
    const seasonEntry = seasonGuid ? store.entries[seasonGuid] : null;
    if (seasonEntry && seasonEntry.scope === 'season') return { manual: seasonEntry, server: null };
    // 无手动标记 → 查服务端（「标记不准」显示判据：服务端已有数据）
    const server = await readSkipFromFnos(guid);
    return { manual: null, server };
}

function handleGetConfig(): fnConfig.SkipManualConfig {
    return fnConfig.getSkipManualConfig();
}

async function handleSetConfig(_event: IpcMainInvokeEvent, params: { patch?: Partial<fnConfig.SkipManualConfig> }): Promise<fnConfig.SkipManualConfig> {
    return fnConfig.setSkipManualConfig((params && params.patch) || {});
}

// ─── 注册（handlers/index.ts 目录自动加载 + init() 调用）───

/** [lc-1257] MPV smart_skip 面板打点 → 本地 4 值存储同步（经 playbackShim POST /skip-manual 调用）。
 *  入参是 MPV 面板的 2 值语义（introEnd=片头结束秒、outroLen=片尾时长秒，outroEnd=视频总时长可选），
 *  换算：outroStart = totalDuration - outroLen。只写本地 store，不触发服务端写回——
 *  MPV 面板自己已 POST /api/v1/skipinfo（api.set_skip_time），双写会重复。
 *  本地有 4 值的目的是让网页端「标记不准」入口状态与兜底按钮（精确区间）跨端一致。 */
export function upsertFromMpv(params: {
    guid: string;
    introEnd: number;
    outroLen: number;
    totalDuration?: number;
}): { saved: boolean; message?: string } {
    const guid = String(params.guid || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(guid)) return { saved: false, message: 'guid 非法' };
    const introEnd = Math.max(0, Math.round(Number(params.introEnd) || 0));
    const outroLen = Math.max(0, Math.round(Number(params.outroLen) || 0));
    const totalDuration = Math.max(0, Math.round(Number(params.totalDuration) || 0));
    if (introEnd === 0 && outroLen === 0) {
        // 双零 = MPV 面板的「清空」动作 → 删除本集本地标记（服务端清零由 MPV 侧自行完成）
        const store = readStore();
        if (store.entries[guid]) {
            delete store.entries[guid];
            writeStore(store);
            log.info(`[skip-manual] MPV 清空本地标记 guid=${guid}`);
        }
        return { saved: true };
    }
    const outroStart = totalDuration > 0 ? Math.max(0, totalDuration - outroLen) : 0;
    const store = readStore();
    store.entries[guid] = {
        guid,
        scope: 'episode',
        introStart: 0,          // MPV 面板语义：片头起点恒为 0
        introEnd,
        outroStart,
        outroEnd: totalDuration,
        fnSkipStart: introEnd,
        fnSkipEnd: outroLen,
        totalDuration,
        updatedAt: Date.now(),
    };
    writeStore(store);
    log.info(`[skip-manual] MPV 打点同步 guid=${guid} introEnd=${introEnd} outroLen=${outroLen}`);
    return { saved: true };
}

export function init(): void {
    registerHandler('skip-manual:get', handleGet, { useHandle: true });
    registerHandler('skip-manual:set', handleSet, { useHandle: true });
    registerHandler('skip-manual:clear', handleClear, { useHandle: true });
    registerHandler('skip-manual:effective', handleEffective, { useHandle: true });
    registerHandler('skip-manual:get-config', handleGetConfig, { useHandle: true });
    registerHandler('skip-manual:set-config', handleSetConfig, { useHandle: true });
    log.info('[skip-manual] 片头片尾手动标记插件已注册');
}
