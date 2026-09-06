// traktSync.ts — Trakt.tv 同步插件（观影记录 → Trakt history）
// ─────────────────────────────────────────────────────────────────────────────
// 认证（OAuth Device Flow，适合桌面端无回调地址）：
//   1) 用户在 https://trakt.tv/oauth/applications 注册应用取 Client ID + Secret，填入设置面板
//   2) POST https://auth.trakt.tv/oauth/device/code {client_id} → device_code/user_code/verification_url
//   3) 用户访问 verification_url 输入 user_code 授权
//   4) 主进程按 interval 轮询 POST auth.trakt.tv/oauth/device/token {code,client_id,client_secret}
//      200=授权成功存 token(access 7天) / 400=待授权 / 429=放慢 / 409已用 410过期 418拒绝=终止
// 同步：遍历飞牛媒体库（电影 watched=1 / 剧集钻 季→单集 watched=1），
//   Trakt /search 解析 ids（tmdb/trakt/imdb 整组透传），POST /sync/history 分批写入。
//   Trakt /sync/history 的 shows 条目支持 seasons[].episodes[].number + watched_at，
//   正好映射飞牛 季→单集 的 watched 标记（无需集级 id）。
// 存储：userData/trakt_auth.json（凭证+token；与本插件其他缓存同目录惯例）。
// ─────────────────────────────────────────────────────────────────────────────
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { registerHandler } from '../core/ipcHandler';
import { getMainWindow } from '../../common/mainwin';
import * as fnConfig from '../../../modules/fn_config/config';
import * as fn from '../../../modules/fn_api/api';
import * as logger from '../../../modules/logger';
const log = logger.component('trakt');

const API = 'https://api.trakt.tv';
const AUTH = 'https://auth.trakt.tv';
const AUTH_FILE = (() => { try { return path.join(app.getPath('userData'), 'trakt_auth.json'); } catch { return ''; } })();

interface TraktAuth {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;   // ms
}

let _auth: TraktAuth | null = null;

function loadAuth(): void {
    if (!AUTH_FILE) return;
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const obj = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
            if (obj && obj.clientId && obj.clientSecret) _auth = obj as TraktAuth;
        }
    } catch (e: any) { log.warn('读取凭证失败:', e && e.message); }
}
function saveAuth(): void {
    if (!AUTH_FILE || !_auth) return;
    try { fs.writeFileSync(AUTH_FILE, JSON.stringify(_auth, null, 2), 'utf8'); }
    catch (e: any) { log.warn('写入凭证失败:', e && e.message); }
}
function getCreds(): { clientId: string; clientSecret: string } | null {
    if (!_auth || !_auth.clientId || !_auth.clientSecret) return null;
    return { clientId: _auth.clientId, clientSecret: _auth.clientSecret };
}
function connected(): boolean {
    return !!(_auth && _auth.accessToken);
}

function broadcast(ch: string, payload?: any): void {
    try { const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send(ch, payload || null); } catch { /* ignore */ }
}

// ── HTTP ──
function apiClient(): any {
    const c = axios.create({
        baseURL: API,
        timeout: 30000,
        headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': (_auth && _auth.clientId) || '',
            'User-Agent': 'Fntv-Plus/1.0',
        },
    });
    if (connected()) c.defaults.headers.common['Authorization'] = 'Bearer ' + _auth!.accessToken;
    return c;
}

async function refreshToken(): Promise<boolean> {
    const cred = getCreds();
    if (!cred || !_auth || !_auth.refreshToken) return false;
    try {
        const r = await axios.post(API + '/oauth/token', {
            refresh_token: _auth.refreshToken,
            client_id: cred.clientId,
            client_secret: cred.clientSecret,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
            grant_type: 'refresh_token',
        }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
        _auth.accessToken = r.data.access_token;
        _auth.refreshToken = r.data.refresh_token;
        _auth.expiresAt = Date.now() + Number(r.data.expires_in || 0) * 1000;
        saveAuth();
        log.info('token 已刷新');
        return true;
    } catch (e: any) {
        log.warn('刷新 token 失败:', e && e.message);
        return false;
    }
}

/** 带鉴权的 GET/POST：401 自动刷新一次并重试 */
async function apiGet(url: string, params?: any): Promise<any> {
    try { return await apiClient().get(url, { params }); }
    catch (e: any) {
        if (e.response && e.response.status === 401 && (await refreshToken())) {
            return await apiClient().get(url, { params });
        }
        throw e;
    }
}
async function apiPost(url: string, body: any): Promise<any> {
    try { return await apiClient().post(url, body); }
    catch (e: any) {
        if (e.response && e.response.status === 401 && (await refreshToken())) {
            return await apiClient().post(url, body);
        }
        throw e;
    }
}

// ── Device Flow ──
let _pollTimer: NodeJS.Timeout | null = null;
let _pollAbort = false;

function stopPolling(): void {
    _pollAbort = true;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

async function pollDeviceToken(deviceCode: string, intervalSec: number, expiresAtMs: number, curInterval: number): Promise<void> {
    if (_pollAbort) return;
    const cred = getCreds();
    if (!cred) { broadcast('trakt:device-error', '缺少 Client ID/Secret'); return; }
    try {
        const r = await axios.post(AUTH + '/oauth/device/token', {
            code: deviceCode, client_id: cred.clientId, client_secret: cred.clientSecret,
        }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
        _auth!.accessToken = r.data.access_token;
        _auth!.refreshToken = r.data.refresh_token;
        _auth!.expiresAt = Date.now() + Number(r.data.expires_in || 0) * 1000;
        saveAuth();
        broadcast('trakt:connected', { expiresAt: _auth!.expiresAt });
        log.info('设备流授权成功');
        return;
        } catch (e: any) {
            const st = e.response && e.response.status;
            if (st === 400) { /* 待授权，继续轮询 */ }
            else if (st === 429) { curInterval = Math.min(curInterval * 2, 30); }
            else if (st === 401) { broadcast('trakt:device-error', 'Client ID/Secret 无效（invalid_client）'); return; }
            else if (st === 409) { broadcast('trakt:device-error', '该码已被使用'); return; }
            else if (st === 410) { broadcast('trakt:device-error', '设备码已过期，请重新连接'); return; }
            else if (st === 418) { broadcast('trakt:device-error', '用户拒绝了授权'); return; }
            else if (st === 404) { broadcast('trakt:device-error', '设备码无效'); return; }
            else { /* 网络错误：继续重试 */ }
        }
    if (Date.now() > expiresAtMs) { broadcast('trakt:device-error', '授权超时，请重新连接'); return; }
    _pollTimer = setTimeout(() => { void pollDeviceToken(deviceCode, intervalSec, expiresAtMs, curInterval); }, curInterval * 1000);
}

// ── 飞牛观影数据采集（遍历 季→单集，收集 watched 电影/单集） ──
interface MovieWatch { title: string; year: number; watchedAt?: string; tmdbId?: number }
interface EpWatch { season: number; episode: number; watchedAt?: string }
interface ShowWatch { title: string; year: number; eps: EpWatch[] }

function iso(tsSec: any): string | undefined {
    const n = Number(tsSec);
    if (!n || !isFinite(n)) return undefined;
    try { return new Date(n * 1000).toISOString().slice(0, 10); } catch { return undefined; }
}
function yearOf(it: any): number {
    const m = String(it.air_date || it.release_date || '').match(/(\d{4})/);
    return m ? Number(m[1]) : 0;
}
function epNoOf(leaf: any, fallbackSeq: number): number {
    const n = Number(leaf.index_number);
    if (n && isFinite(n)) return n;
    const m = String(leaf.title || '').match(/第\s*(\d+)\s*[集话]/);
    if (m) return Number(m[1]);
    return fallbackSeq;
}

async function collectWatched(): Promise<{ movies: MovieWatch[]; shows: ShowWatch[] }> {
    const cfg = fnConfig.readConfig();
    if (!cfg || !cfg.domain || !cfg.token) throw new Error('缺少 fnOS 配置（domain/token）');
    const fnapi = new fn.ApiService(cfg.domain, cfg.token);
    const movies: MovieWatch[] = [];
    const shows: ShowWatch[] = [];
    const resp: any = await fnapi.getItemList({ parent_guid: '', exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC' });
    const list: any[] = (resp && resp.success && resp.data && Array.isArray(resp.data.list)) ? resp.data.list : [];
    for (const it of list) {
        const type = String(it.type || '').toLowerCase();
        if (type === 'movie') {
            if (it.watched === 1) {
                movies.push({ title: String(it.title || ''), year: yearOf(it), watchedAt: iso(it.watched_ts), tmdbId: Number(it.tmdb_id) || undefined });
            }
            continue;
        }
        if (type !== 'tv' && type !== 'series') continue;
        const show: ShowWatch = { title: String(it.parent_title || it.tv_title || it.title || ''), year: yearOf(it), eps: [] };
        // 季→单集 钻取（与豆瓣同步 analyzeItem 同一模型），收集 watched 单集
        let curSeason = 1;
        try {
            const childResp: any = await fnapi.getItemList({ parent_guid: it.guid, exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC' });
            const children: any[] = (childResp && childResp.success && childResp.data && Array.isArray(childResp.data.list)) ? childResp.data.list : [];
            for (const c of children) {
                const ct = String(c.type || '').toLowerCase();
                if (ct === 'season') {
                    curSeason = Number(c.index_number) || curSeason;
                    const ep: any = await fnapi.getEpisodeListCached(c.guid);
                    const eps: any[] = (ep && ep.success && Array.isArray(ep.data)) ? ep.data : [];
                    for (const leaf of eps) {
                        if (leaf.watched !== 1) continue;
                        show.eps.push({ season: Number(leaf.parent_index_number) || curSeason, episode: epNoOf(leaf, show.eps.length + 1), watchedAt: iso(leaf.watched_ts) });
                    }
                } else if (ct === 'episode') {
                    if (c.watched === 1) {
                        show.eps.push({ season: Number(c.parent_index_number) || 1, episode: epNoOf(c, show.eps.length + 1), watchedAt: iso(c.watched_ts) });
                    }
                }
            }
        } catch (e: any) { log.warn('钻取失败 ' + show.title + ':', e && e.message); }
        if (show.eps.length) shows.push(show);
    }
    return { movies, shows };
}

// ── Trakt ids 解析（/search，按 标题(+年份) 取第一条） ──
async function resolveIds(kind: 'movie' | 'show', title: string, year: number, cache: Map<string, any | null>): Promise<any | null> {
    const key = kind + '|' + title + '|' + year;
    if (cache.has(key)) return cache.get(key) || null;
    let ids: any = null;
    try {
        const params: any = { query: title };
        if (year) params.year = year;
        const r = await apiGet('/search/' + kind, params);
        const arr: any[] = Array.isArray(r.data) ? r.data : [];
        const hit = arr.find((x) => x && x[kind] && x[kind].ids);
        if (hit) ids = hit[kind].ids;
    } catch (e: any) {
        log.warn('搜索 ' + kind + ' 失败 ' + title + ':', e && e.message);
    }
    cache.set(key, ids);
    await new Promise((r2) => setTimeout(r2, 120)); // 搜索限速礼貌间隔
    return ids;
}

// ── 同步主流程 ──
let _syncing = false;
async function syncWatched(): Promise<any> {
    if (_syncing) return { error: 'busy' };
    if (!connected()) return { error: '未连接 Trakt（请先完成设备授权）' };
    _syncing = true;
    try {
        const { movies, shows } = await collectWatched();
        const idCache = new Map<string, any | null>();
        const histMovies: any[] = [];
        let noIdMovies = 0;
        for (const m of movies) {
            const ids = m.tmdbId ? { tmdb: m.tmdbId } : await resolveIds('movie', m.title, m.year, idCache);
            if (!ids) { noIdMovies++; continue; }
            histMovies.push({ ids, watched_at: m.watchedAt });
        }
        const histShows: any[] = [];
        let noIdShows = 0;
        for (const s of shows) {
            const ids = await resolveIds('show', s.title, s.year, idCache);
            if (!ids) { noIdShows++; continue; }
            const bySeason = new Map<number, EpWatch[]>();
            for (const e of s.eps) {
                if (!bySeason.has(e.season)) bySeason.set(e.season, []);
                bySeason.get(e.season)!.push(e);
            }
            const seasons = Array.from(bySeason.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([number, eps]) => ({
                    number,
                    episodes: eps.sort((a, b) => a.episode - b.episode).map((e) => (e.watchedAt ? { number: e.episode, watched_at: e.watchedAt } : { number: e.episode })),
                }));
            histShows.push({ ids, seasons });
        }
        let addedMovies = 0, addedEpisodes = 0, notFound = 0;
        // 分批（每批 ≤ 50 电影 / 25 剧集，避免超大包体）
        for (let i = 0; i < Math.max(histMovies.length, histShows.length); i += 50) {
            const body = {
                movies: histMovies.slice(i, i + 50),
                shows: histShows.slice(Math.floor(i / 2), Math.floor(i / 2) + 25),
            };
            if (!body.movies.length && !body.shows.length) break;
            const r = await apiPost('/sync/history', body);
            const a = (r.data && r.data.added) || {};
            addedMovies += Number(a.movies) || 0;
            addedEpisodes += Number(a.episodes) || 0;
            const nf = (r.data && r.data.not_found) || {};
            notFound += (nf.movies ? nf.movies.length : 0) + (nf.shows ? nf.shows.length : 0);
        }
        const summary = {
            scannedMovies: movies.length, scannedShows: shows.length,
            addedMovies, addedEpisodes, notFound, noIdMovies, noIdShows,
        };
        log.info('同步完成: ' + JSON.stringify(summary));
        return { ok: true, ...summary };
    } catch (e: any) {
        const st = e.response && e.response.status;
        const msg = st === 401 ? '认证失效且刷新失败，请重新连接'
            : st === 420 ? 'Trakt 限流，请稍后再试'
            : String(e.message || e);
        log.warn('同步失败:', msg);
        return { error: msg };
    } finally {
        _syncing = false;
    }
}

// ── [lc-1064] 实时 scrobble：播放中实时同步观看状态到 Trakt ──
//   start=开始/进度打点 · pause=暂停 · stop=结束(≥80% 会计为已看)
//   body 组装：剧集 {show:{ids:{tmdb}}, episode:{season,number}}；电影 {movie:{ids:{tmdb}}}。
//   节流：start 每 10 分钟或进度 +5% 才发一次(Trakt 官方建议)，pause/stop 即时。
let _scrobbleLast: { guid: string; pct: number; at: number } | null = null;

function showTmdbFromTrim(trimId: string): number | null {
    const digits = String(trimId || '').replace(/^tt/i, '').match(/^(\d+)$/);
    return digits ? parseInt(digits[1], 10) : null;
}

export async function scrobble(action: 'start' | 'pause' | 'stop', guid: string, progressPct: number):
    Promise<{ ok: boolean; code?: number; message?: string }> {
    if (!fnConfig.getTraktScrobbleEnabled()) return { ok: false, message: 'scrobble 已关闭' };
    if (!connected()) return { ok: false, message: 'Trakt 未连接' };
    const pct = Math.max(0, Math.min(100, Math.round(progressPct)));

    // start 节流：同 guid 10 分钟内且进度推进 <5% → 跳过
    if (action === 'start' && _scrobbleLast && _scrobbleLast.guid === guid) {
        if (Date.now() - _scrobbleLast.at < 10 * 60 * 1000 && Math.abs(pct - _scrobbleLast.pct) < 5) {
            return { ok: true, message: '节流跳过' };
        }
    }

    try {
        const config = fnConfig.readConfig() || {};
        const domain = config.domain || '';
        const token = config.token || '';
        if (!domain || !token) return { ok: false, message: '未登录飞牛' };
        const fnapi = new fn.ApiService(domain, token);
        const playResp = await fnapi.getPlayInfo(guid);
        if (!playResp.success || !playResp.data) return { ok: false, message: '读取播放信息失败' };
        const info = playResp.data;
        const item = info.item;
        const showTmdb = showTmdbFromTrim(item.trim_id);
        const isEpisode = String(item.type || info.type || '') === 'Episode';

        let body: any;
        if (isEpisode) {
            if (!showTmdb) return { ok: false, message: '剧集缺少 TMDB id，无法 scrobble' };
            body = {
                progress: pct,
                show: { ids: { tmdb: showTmdb } },
                episode: { season: item.season_number || 1, number: item.episode_number || 1 },
            };
        } else {
            if (!showTmdb) return { ok: false, message: '电影缺少 TMDB id，无法 scrobble' };
            body = { progress: pct, movie: { ids: { tmdb: showTmdb } } };
        }

        const r = await apiPost('/scrobble/' + action, body);
        _scrobbleLast = { guid, pct, at: Date.now() };
        log.info('[trakt:scrobble] ' + action + ' ' + pct + '% guid=' + guid);
        return { ok: true, code: r.status };
    } catch (e: any) {
        const st = e.response && e.response.status;
        log.warn('[trakt:scrobble] 失败(' + action + '):', st || e.message);
        return { ok: false, code: st, message: String(e.message || e) };
    }
}

// ── IPC ──
// [lc-1088] 全部通道必须注册为 handle(useHandle:true): 渲染进程(embyWall 设置面板 / skipInject scrobble)
//   一律用 ipcRenderer.invoke 调用。旧代码只有 scrobble 与两个 scrobble-enabled 传了 useHandle,
//   其余 8 个落到 ipcMain.on → invoke 侧报 "No handler registered for 'trakt:get-credentials'"
//   (dev 实测日志), 各 handler 的返回值也被 on 语义丢弃 → Trakt 面板每个按钮都是死的。
export function init(): void {
    loadAuth();
    registerHandler('trakt:get-status', () => ({
        configured: !!getCreds(),
        connected: connected(),
        expiresAt: (_auth && _auth.expiresAt) || 0,
    }), { useHandle: true });
    registerHandler('trakt:save-credentials', (_e: any, clientId: string, clientSecret: string) => {
        const id = String(clientId || '').trim();
        const sec = String(clientSecret || '').trim();
        if (!id || !sec) return { error: 'Client ID 与 Secret 均必填' };
        // 同一应用的凭证更新保留已有 token；换了应用（token 与 app 绑定）则丢弃 token
        const prev = _auth && _auth.clientId === id
            ? { accessToken: _auth.accessToken, refreshToken: _auth.refreshToken, expiresAt: _auth.expiresAt }
            : {};
        _auth = { clientId: id, clientSecret: sec, ...prev };
        saveAuth();
        return { ok: true };
    }, { useHandle: true });
    registerHandler('trakt:get-credentials', () => {
        if (!_auth) return { configured: false };
        return { configured: true, clientId: _auth.clientId, clientSecret: _auth.clientSecret };
    }, { useHandle: true });
    registerHandler('trakt:clear-credentials', () => {
        _auth = null;
        stopPolling();
        if (AUTH_FILE && fs.existsSync(AUTH_FILE)) { try { fs.unlinkSync(AUTH_FILE); } catch { /* ignore */ } }
        return { ok: true };
    }, { useHandle: true });
    registerHandler('trakt:device-start', async () => {
        const cred = getCreds();
        if (!cred) return { error: '请先填写并保存 Client ID / Secret' };
        stopPolling(); _pollAbort = false;
        try {
            const r = await axios.post(AUTH + '/oauth/device/code', { client_id: cred.clientId },
                { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
            const d = r.data || {};
            const interval = Math.max(Number(d.interval) || 5, 3);
            const expiresAtMs = Date.now() + Number(d.expires_in || 600) * 1000;
            void pollDeviceToken(String(d.device_code), interval, expiresAtMs, interval);
            return { ok: true, user_code: d.user_code, verification_url: d.verification_url, expires_in: d.expires_in };
        } catch (e: any) {
            const st = e.response && e.response.status;
            const desc = e.response && e.response.data && (e.response.data.error_description || e.response.data.error);
            if (st === 401 && String(desc).indexOf('invalid_client') !== -1) {
                return { error: 'Client ID 无效（invalid_client）——请核对 Trakt 应用设置页的 Client ID' };
            }
            return { error: '获取设备码失败: ' + (st ? 'HTTP ' + st + (desc ? ' ' + desc : '') : String(e.message || e)) };
        }
    }, { useHandle: true });
    registerHandler('trakt:device-cancel', () => { stopPolling(); return { ok: true }; }, { useHandle: true });
    registerHandler('trakt:disconnect', () => {
        if (_auth) { _auth.accessToken = undefined; _auth.refreshToken = undefined; _auth.expiresAt = undefined; saveAuth(); }
        return { ok: true };
    }, { useHandle: true });
    registerHandler('trakt:sync-watched', async () => await syncWatched(), { useHandle: true });
    // [lc-1064] 实时 scrobble
    registerHandler('trakt:scrobble', (_e: any, p: { action: 'start' | 'pause' | 'stop'; guid: string; progress: number }) => {
        const act = String((p && p.action) || 'start') as 'start' | 'pause' | 'stop';
        return scrobble(act, String((p && p.guid) || ''), Number((p && p.progress) || 0));
    }, { useHandle: true });
    registerHandler('trakt:get-scrobble-enabled', () => ({ enabled: fnConfig.getTraktScrobbleEnabled() }), { useHandle: true });
    registerHandler('trakt:set-scrobble-enabled', (_e: any, v: boolean) => { fnConfig.setTraktScrobbleEnabled(!!v); return { ok: true, enabled: !!v }; }, { useHandle: true });
    log.info('Trakt 同步插件就绪');
}
