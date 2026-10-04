import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import logger from '../../modules/logger';
import * as fnConfig from '../../modules/fn_config/config';
import { resolveProxyAgent } from '../../modules/proxyAgent';
import { splitSeason } from './danmuApi';
import type { BiliDanmakuResult, BiliCandidate } from './biliRunner';

const log = logger.component('dandanplay');

/**
 * [lc-1302] 弹弹play 官方开放 API 客户端 —— 网页播放器弹幕链路的【兜底源】。
 *
 * 移植自 fpk Go 版（fpk/src/go/internal/bridge/dandanplay.go），两端行为保持一致：
 *   - 链路位置：自建源（danmu_api 优选）→ 内置 B站 → 弹弹play。官方规约要求弹幕库
 *     按需使用（内置凭证是共享配额），故只在拿不到弹幕时才取，不自建源命中后再叠加。
 *   - 认证（签名模式，官方推荐客户端使用）：
 *       X-AppId / X-Timestamp(Unix 秒 UTC) / X-Signature = base64(sha256(AppId+Timestamp+Path+AppSecret))
 *       Path 为接口路径（以 / 开头，不含 query、不做 URL 编码）。
 *   - 凭证优先级：设置面板填的自定义 AppId/Secret（fnConfig）→ 内置凭证（密文常量，
 *     与 fpk secret 模块同源同算法；明文不进仓库/配置/日志）。
 *   - 三端点：/api/v2/search/episodes（条目搜索含部分分集）、/api/v2/bangumi/{id}
 *     （完整分集兜底）、/api/v2/comment/{id}?withRelated=true（弹幕，含第三方整合源）。
 *   - 官方规约要求缓存查询结果以减少请求：搜索/分集缓存 6h（进程内）；弹幕体本身
 *     由上层 danmaku:prepare 的磁盘缓存兜住，这里不做二级缓存。
 */

const BASE = 'https://api.dandanplay.net';
/** 手动搜索候选里弹弹play 集的伪 id 前缀（真 id 为 episodeId），与自建源 `dmapi:` 同约定。 */
export const ID_PREFIX = 'ddp:';
const SOURCE_LABEL = 'dandanplay';
const UA = 'Fntv-Plus/3.8';
const TIMEOUT_MS = 20000;
const MAX_BODY = 32 * 1024 * 1024;
const QUERY_TTL = 6 * 60 * 60 * 1000;

/* ── 内置凭证（密文常量与 fpk builtin.go 同源；解密 = Go secret.go 的 Node 移植） ── */

const ENC_PREFIX = 'enc:v1:';
// 根密钥掩码形态：真实根密钥 = masked ^ mask（4×u64 大端；拆掩码防连续明文静态数据）。
const ROOT_KEY_MASKED = [0xf010c23f9eb202e1n, 0x3311f77f2252a875n, 0xcaf704bc597a481cn, 0x4e52e841b1ba19efn];
const ROOT_KEY_MASKS = [0xbe42ecd482fcdc0dn, 0x8198532fcd2eb722n, 0x50103fbadc74de64n, 0x3a86a1704516f465n];

function rootKey(): Buffer {
    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) out.writeBigUInt64BE(ROOT_KEY_MASKED[i] ^ ROOT_KEY_MASKS[i], i * 8);
    return out;
}

/** 根密钥派生子密钥（域分隔：label + 附加材料，各段以 0 分隔避免歧义拼接）。 */
function derive(label: string, extra?: Buffer): Buffer {
    const h = crypto.createHash('sha256');
    h.update('fntvplus/secret/v1');
    h.update(Buffer.from([0]));
    h.update(rootKey());
    h.update(Buffer.from([0]));
    h.update(label, 'utf8');
    if (extra) {
        h.update(Buffer.from([0]));
        h.update(extra);
    }
    return h.digest();
}

/** 解 `enc:v1:` 密文（AES-256-GCM，前 12 字节 nonce + 末 16 字节 authTag）；非密文按历史明文兼容返回。 */
function decryptToken(key: Buffer, token: string): string | null {
    try {
        if (!token.startsWith(ENC_PREFIX)) return token;
        const raw = Buffer.from(token.slice(ENC_PREFIX.length), 'base64');
        const nonceSize = 12;
        if (raw.length <= nonceSize + 16) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, nonceSize));
        d.setAuthTag(raw.subarray(raw.length - 16));
        return Buffer.concat([d.update(raw.subarray(nonceSize, raw.length - 16)), d.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// 与 fpk builtin.go 同源的密文常量（主 Secret 失效自动顺延到备用，无需同步发版）。
const BUILTIN_APPID_ENC = 'enc:v1:yOyM32FRf8Ea5v8Qacdbw2x6vXTu9GXgrflHDReyrKAh9Ka/6qs=';
const BUILTIN_SECRETS_ENC = [
    'enc:v1:Rv477mGixVH6joM+3XTurAhxR3D0BgraDAzNn2BDcdRUD4Va51T2PeGb4CVGeEc70d31KQ04dCvBb295',
    'enc:v1:wJOKsZapnYka0sdwwC0m3KtIaAfXqieG/kuQR4lExX6tVCFOKeRqg5C8as5oI5Q3ZCEnDW+Gl+7RVCmj',
];

let builtinCache: { appId: string; secrets: string[] } | null | undefined; // undefined=尚未解过

function builtinCreds(): { appId: string; secrets: string[] } | null {
    if (builtinCache !== undefined) return builtinCache;
    const key = derive('dandanplay-builtin-v1');
    const appId = (decryptToken(key, BUILTIN_APPID_ENC) || '').trim();
    const secrets: string[] = [];
    for (const ct of BUILTIN_SECRETS_ENC) {
        const s = (decryptToken(key, ct) || '').trim();
        if (s) secrets.push(s);
    }
    builtinCache = appId && secrets.length ? { appId, secrets } : null;
    if (!builtinCache) log.warn('内置凭证解密失败（常量被改动/版本不匹配），弹弹play 仅在配置自定义凭证时可用');
    return builtinCache;
}

/* ── 凭证解析：自定义（设置面板）优先，内置兜底 ── */

function customCreds(): { appId: string; secret: string } | null {
    const id = String(fnConfig.getDandanplayAppId() || '').trim();
    const sec = String(fnConfig.getDandanplayAppSecret() || '').trim();
    return id && sec ? { appId: id, secret: sec } : null;
}

function creds(): { appId: string; secrets: string[]; custom: boolean } | null {
    const c = customCreds();
    if (c) return { appId: c.appId, secrets: [c.secret], custom: true };
    const b = builtinCreds();
    return b ? { appId: b.appId, secrets: b.secrets, custom: false } : null;
}

/** 当前生效凭证来源（来源详情面板展示；绝不返回 Secret 本体）。 */
function credentialLabel(): string {
    const c = creds();
    if (!c) return '不可用';
    return c.custom ? '自定义凭证' : '内置凭证';
}

/* ── 签名与请求 ── */

function ddpSign(appId: string, appSecret: string, p: string, ts: number): string {
    return crypto.createHash('sha256').update(appId + ts + p + appSecret, 'utf8').digest('base64');
}

// 「哪个 Secret 可用」的进程内记忆：命中后固定用它；失效的 5 分钟内不再优先（fpk 同口径）。
const secretState = { idx: 0, badUntil: new Map<number, number>() };

function httpsGetJsonOnce(rawUrl: string, headers: Record<string, string>): Promise<
    { ok: true; status: number; json: any; errHeader: string; location: string } | { ok: false; error: string }
> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v: Parameters<typeof resolve>[0]) => { if (!done) { done = true; resolve(v); } };
        try {
            const u = new URL(rawUrl);
            const agent = resolveProxyAgent();
            const req = https.request({
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: 'GET',
                headers: { ...headers, 'Accept': 'application/json' },
                agent: agent as any,
            }, (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_BODY) { req.destroy(new Error('响应超过 32MB 上限')); return; }
                    chunks.push(c);
                });
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    let json: any = null;
                    try { json = body ? JSON.parse(body) : null; } catch { /* 保留 null，由调用方按失败处理 */ }
                    finish({
                        ok: true, status: res.statusCode || 0, json,
                        errHeader: String(res.headers['x-error-message'] || ''),
                        location: String(res.headers.location || ''),
                    });
                });
                res.on('error', (e) => finish({ ok: false, error: String((e as Error)?.message || e) }));
            });
            req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时(${TIMEOUT_MS}ms)`)));
            req.on('error', (e) => finish({ ok: false, error: String((e as Error)?.message || e) }));
            req.end();
        } catch (e: any) {
            finish({ ok: false, error: String(e?.message || e) });
        }
    });
}

/**
 * GET → JSON，自动跟随重定向。官方把弹幕请求 302 到就近 CAS 节点（Location 的 query 自带
 * sign/appId，Go 的默认 http.Client 同样自动跟随）；跳转后不再携带 X-* 签名头——签名按
 * 原路径计算，跨节点原样带上必然无效，节点认 URL 里的 sign。
 */
async function httpsGetJson(rawUrl: string, headers: Record<string, string>): Promise<
    { ok: true; status: number; json: any; errHeader: string } | { ok: false; error: string }
> {
    let current = rawUrl;
    let h = headers;
    for (let hop = 0; hop < 5; hop++) {
        const r = await httpsGetJsonOnce(current, h);
        if (!r.ok) return r;
        if ((r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) && r.location) {
            current = r.location;
            h = { 'User-Agent': UA };
            continue;
        }
        return { ok: true, status: r.status, json: r.json, errHeader: r.errHeader };
    }
    return { ok: false, error: '重定向次数过多' };
}

function isAuthErr(status: number, msg: string): boolean {
    if (status === 401 || status === 403 || status === 429 || status >= 500) return true;
    return /signature|appsecret|appid/i.test(msg);
}

/**
 * 带签名的 GET → JSON。逐个尝试可用 Secret，直到某个返回非认证错误；
 * 传输层失败直接返回（网络问题换 Secret 无意义，Go 同口径）。
 */
async function ddpCall(p: string, query?: Record<string, string>): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
    const c = creds();
    if (!c || !c.secrets.length) return { ok: false, error: '弹弹play 凭证不可用' };
    const qs = query ? new URLSearchParams(query).toString() : '';
    let lastErr = '未知错误';
    const n = c.secrets.length;
    for (let k = 0; k < n; k++) {
        const i = (secretState.idx + k) % n;
        if (k > 0 && (secretState.badUntil.get(i) || 0) > Date.now()) continue;
        const ts = Math.floor(Date.now() / 1000);
        const res = await httpsGetJson(BASE + p + (qs ? '?' + qs : ''), {
            'X-AppId': c.appId,
            'X-Timestamp': String(ts),
            'X-Signature': ddpSign(c.appId, c.secrets[i], p, ts),
        });
        if (!res.ok) return res;
        if (res.status === 200) {
            if (k > 0) {
                secretState.idx = i;
                log.info(`已切换到第 ${i + 1} 个内置 Secret（前序失效）`);
            }
            return { ok: true, json: res.json };
        }
        const msg = String(res.json?.errorMessage || '') || res.errHeader;
        lastErr = `HTTP ${res.status}: ${msg}`;
        if (isAuthErr(res.status, msg) && k + 1 < n) {
            secretState.badUntil.set(i, Date.now() + 5 * 60 * 1000);
            log.warn(`Secret #${i + 1} 认证失败（${msg}），尝试下一个`);
            continue;
        }
        return { ok: false, error: lastErr };
    }
    return { ok: false, error: lastErr };
}

/* ── 查询结果缓存（6h；空结果不缓存：临时故障不应被锁定） ── */

interface QueryCacheEntry { val: any[]; exp: number }
const searchCache = new Map<string, QueryCacheEntry>();   // 归一化标题 → animes
const episodesCache = new Map<string, QueryCacheEntry>(); // animeId → episodes

function cacheGet(m: Map<string, QueryCacheEntry>, key: string): any[] | null {
    const e = m.get(key);
    if (e && e.exp > Date.now()) return e.val;
    if (e) m.delete(key);
    return null;
}

function cachePut(m: Map<string, QueryCacheEntry>, key: string, val: any[]): void {
    if (!val.length) return;
    m.set(key, { val, exp: Date.now() + QUERY_TTL });
}

/** 条目搜索（含各自部分分集列表）。 */
async function searchAnimes(title: string): Promise<any[]> {
    const key = String(title || '').trim().toLowerCase();
    if (!key) return [];
    const hit = cacheGet(searchCache, key);
    if (hit) {
        log.info(`搜索缓存命中 title=${JSON.stringify(title)}（免上游请求）`);
        return hit;
    }
    const r = await ddpCall('/api/v2/search/episodes', { anime: title.trim() });
    if (!r.ok) {
        log.warn(`搜索失败 title=${JSON.stringify(title)}: ${r.error}`);
        return [];
    }
    const j = r.json;
    if (j && j.success === false) {
        log.warn(`搜索 success=false title=${JSON.stringify(title)} msg=${j.errorMessage || ''}`);
        return [];
    }
    const out = Array.isArray(j?.animes) ? j.animes : [];
    cachePut(searchCache, key, out);
    return out;
}

/** 完整分集（search/episodes 只回部分集时兜底）。 */
async function animeEpisodes(animeId: number): Promise<any[]> {
    const key = String(animeId);
    const hit = cacheGet(episodesCache, key);
    if (hit) return hit;
    const r = await ddpCall(`/api/v2/bangumi/${animeId}`);
    if (!r.ok) return [];
    const eps = Array.isArray(r.json?.bangumi?.episodes) ? r.json.bangumi.episodes : [];
    cachePut(episodesCache, key, eps);
    return eps;
}

/* ── 弹幕 ── */

/**
 * 弹幕 p 属性 → item。p 形如 "2.52,5,16777215,ca76f2e6"：时间, 模式, **颜色**, 用户标识。
 * ⚠ 与 B站 XML 的 p 不同：B站是 time,mode,**size**,color,…（颜色在第 4 段），弹弹play 没有
 * size 段、颜色在第 3 段——按 B站 下标取会把末段用户标识当颜色（恒 0=黑色，实测全屏变黑）。
 * 文本不做 HTML 反转义：JSON 的 m 是纯文本，再反转义会改坏用户真实的 "&amp;" 字面量。
 */
function parseComment(p: string, text: string): { time: number; type: number; color: number; text: string } | null {
    if (!p) return null;
    const f = String(p).split(',');
    if (f.length < 3) return null;
    const time = parseFloat(String(f[0]).trim());
    if (!isFinite(time)) return null;
    const mode = parseInt(String(f[1]).trim(), 10) || 0;
    const color = parseInt(String(f[2]).trim(), 10) || 0;
    const type = (mode === 4 || mode === 5) ? mode : 1;
    return { time, type, color, text: String(text || '') };
}

/** 拉取指定集的弹幕（withRelated=true 含第三方整合源，实测条数远高于默认），按时间升序。 */
async function fetchItems(episodeId: number): Promise<Array<{ time: number; type: number; color: number; text: string }>> {
    const r = await ddpCall(`/api/v2/comment/${episodeId}`, { withRelated: 'true' });
    if (!r.ok) {
        log.warn(`弹幕拉取失败 episodeId=${episodeId}: ${r.error}`);
        return [];
    }
    const j = r.json;
    if (j && j.success === false) {
        log.warn(`弹幕 success=false episodeId=${episodeId} msg=${j.errorMessage || ''}`);
        return [];
    }
    const comments = Array.isArray(j?.comments) ? j.comments : [];
    const items: Array<{ time: number; type: number; color: number; text: string }> = [];
    for (const c of comments) {
        if (!c) continue;
        const it = parseComment(String(c.p || ''), String(c.m || ''));
        if (it) items.push(it);
    }
    items.sort((a, b) => a.time - b.time);
    return items;
}

/* ── 候选匹配 ── */

/**
 * 候选准入档位（越小越好，-1 = 不匹配）。与自建源「只认主名精确相等」不同，弹弹play 的
 * 条目名常带副标题（如「葬送的芙莉莲 第三季 黄金乡篇」），纯相等会把正确条目全拒掉。分三档：
 * 0 = 主名相等 + 季号一致（或都未标季 / 查询未标季而候选为第一季）
 * 1 = 主名相等但候选季号更高（查询未标季时的「后续季」条目，弱于 0 档）
 * 2 = 候选主名以查询主名开头（副标题场景，季号仍需一致或弱兼容）
 */
function ddpTier(query: string, querySeason: number, candTitle: string): number {
    const q = splitSeason(query);
    const c = splitSeason(candTitle);
    if (!q.name || !c.name) return -1;
    const want = querySeason > 0 ? querySeason : q.season;
    let seasonOK = false;
    let higher = false;
    if (c.season > 0 && want > 0) seasonOK = c.season === want;
    else if (c.season > 0 && want <= 0) { seasonOK = true; higher = c.season > 1; }
    else if (c.season === 0 && want <= 1) seasonOK = true;
    if (!seasonOK) return -1;
    if (c.name === q.name) return higher ? 1 : 0;
    if (c.name.startsWith(q.name)) {
        if (higher) return 2;
        if (c.season === 0 && want <= 1) return 2;
        return 1;
    }
    return -1;
}

/** 在分集列表里定位第 ep 集。ep<=0 取首集；优先分集标题集数解析，其次 episodeNumber，最后按列表序号。 */
function pickEpisode(eps: any[], ep: number): any | null {
    if (!eps || !eps.length) return null;
    if (ep <= 0) return eps[0];
    for (const e of eps) {
        const m = String(e?.episodeTitle || '').match(/第\s*([0-9]{1,4})\s*[话集期]/);
        if (m && parseInt(m[1], 10) === ep) return e;
    }
    for (const e of eps) {
        const s = String(e?.episodeNumber ?? '').trim();
        if (s && parseInt(s, 10) === ep) return e;
    }
    if (ep >= 1 && ep <= eps.length) return eps[ep - 1];
    return null;
}

export interface DdpAutoResult {
    items: Array<{ time: number; type: number; color: number; text: string }> | null;
    matchedTitle: string;
    episodeId: number;
    episodeTitle: string;
    credential: string;
    /** 未命中原因（命中为空串），供来源详情面板展示 */
    error: string;
}

/** 弹弹play 自动路径：标题+集数 → 搜索 → 定位集 → 拉弹幕。尝试前 3 个过档位候选。 */
export async function autoFetch(title: string, ep: number, season = 0): Promise<DdpAutoResult> {
    const credential = credentialLabel();
    const c = creds();
    if (!c) return { items: null, matchedTitle: '', episodeId: 0, episodeTitle: '', credential, error: '弹弹play 凭证不可用' };
    const animes = await searchAnimes(title);
    if (!animes.length) {
        return { items: null, matchedTitle: '', episodeId: 0, episodeTitle: '', credential, error: '弹弹play 搜索无结果' };
    }
    const ranked: Array<{ a: any; tier: number }> = [];
    for (const a of animes) {
        if (!(Number(a?.animeId) > 0)) continue;
        const tier = ddpTier(title, season, String(a.animeTitle || ''));
        if (tier >= 0) ranked.push({ a, tier });
    }
    if (!ranked.length) {
        return { items: null, matchedTitle: '', episodeId: 0, episodeTitle: '', credential, error: '弹弹play 无匹配条目' };
    }
    ranked.sort((x, y) => x.tier - y.tier);
    let tries = 3;
    for (const cand of ranked) {
        if (tries <= 0) break;
        tries--;
        const animeTitle = String(cand.a.animeTitle || '');
        let eps = Array.isArray(cand.a.episodes) ? cand.a.episodes : [];
        let pick = pickEpisode(eps, ep);
        if (!pick) {
            // search/episodes 只回部分集 → 换 bangumi 端点取完整分集
            eps = await animeEpisodes(Number(cand.a.animeId));
            pick = pickEpisode(eps, ep);
        }
        if (!pick) continue;
        const id = Number(pick.episodeId);
        if (!(id > 0)) continue;
        const items = await fetchItems(id);
        if (items.length) {
            return { items, matchedTitle: animeTitle, episodeId: id, episodeTitle: String(pick.episodeTitle || ''), credential, error: '' };
        }
    }
    return { items: null, matchedTitle: '', episodeId: 0, episodeTitle: '', credential, error: '弹弹play 候选均无弹幕' };
}

/** 弹幕 XML 落盘（B站 兼容格式 `<i><d p="time,mode,size,color,…">`；0 条返回 0 且不写）。 */
export function writeXml(out: string, items: Array<{ time: number; type: number; color: number; text: string }>): number {
    if (!items.length) return 0;
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = items.map((d) => `<d p="${d.time},${d.type},25,${d.color},0,0,0,0">${esc(d.text)}</d>`);
    const body = ['<?xml version="1.0" encoding="UTF-8"?>', '<i>', ...lines, '</i>'].join('\n');
    try {
        const dir = path.dirname(out);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(out, body, 'utf8');
    } catch (e: any) {
        log.warn(`写 XML 失败: ${e?.message || e} | out=${out}`);
        return 0;
    }
    return items.length;
}

function okResult(count: number, title: string, matchedTitle: string, bvid: string, epid: number): BiliDanmakuResult {
    return {
        ok: true,
        danmaku_count: count,
        source: SOURCE_LABEL,
        title: matchedTitle || title,
        matched_title: matchedTitle || title,
        sim: null,
        bvid,
        cid: null,
        season_id: null,
        epid,
    };
}

/**
 * 自动路径的 BiliDanmakuResult 封装：命中即写 XML 到调用方给定的 out（与 danmu_api 同契约，
 * XML 为 B站 兼容格式，parseDanmakuXml/parse.lua 两个解析器零改动）；未命中返回 ok:false
 * 并带原因（调用方记入溯源明细后原样降级）。
 */
export async function autoFetchBili(title: string, ep: number, season: number, out: string): Promise<BiliDanmakuResult> {
    const r = await autoFetch(title, ep, season);
    if (!r.items || !r.items.length) {
        log.info(`未命中: ${r.error}（凭证=${r.credential}）`);
        return { ok: false, error: r.error || '弹弹play 未命中' };
    }
    const count = writeXml(out, r.items);
    if (!count) return { ok: false, error: '弹幕 XML 写盘失败' };
    log.info(`✅ 命中《${r.matchedTitle}》${r.episodeTitle ? ` · ${r.episodeTitle}` : ''} -> ${count} 条（凭证=${r.credential}）`);
    return okResult(count, title, r.matchedTitle, ID_PREFIX + r.episodeId, r.episodeId);
}

/** 手动搜索候选（bvid 位为 `ddp:<episodeId>` 伪 id，与自建源 dmapi: 同约定），按准入档位取前 5。 */
export async function candidates(title: string, ep: number, season = 0): Promise<BiliCandidate[]> {
    const animes = await searchAnimes(title);
    if (!animes.length) return [];
    const ranked: Array<{ a: any; tier: number }> = [];
    for (const a of animes) {
        if (!(Number(a?.animeId) > 0)) continue;
        const tier = ddpTier(title, season, String(a.animeTitle || ''));
        if (tier >= 0) ranked.push({ a, tier });
    }
    ranked.sort((x, y) => x.tier - y.tier);
    const out: BiliCandidate[] = [];
    for (const cand of ranked) {
        if (out.length >= 5) break;
        let eps = Array.isArray(cand.a.episodes) ? cand.a.episodes : [];
        let pick = pickEpisode(eps, ep);
        if (!pick) {
            eps = await animeEpisodes(Number(cand.a.animeId));
            pick = pickEpisode(eps, ep);
        }
        if (!pick) continue;
        const id = Number(pick.episodeId);
        if (!(id > 0)) continue;
        const full = String(cand.a.animeTitle || '') + (pick.episodeTitle ? ' · ' + pick.episodeTitle : '');
        out.push({ index: out.length, cid: null, bvid: ID_PREFIX + id, title: full, source: SOURCE_LABEL, season: 0, is_compilation: false, sim: null });
    }
    return out;
}

/** 用户从候选列表选定（`ddp:<episodeId>`）后按 id 直取弹幕并落 XML。 */
export async function fetchById(id: number, title: string, out: string): Promise<BiliDanmakuResult> {
    const items = await fetchItems(id);
    if (!items.length) {
        return { ok: false, error: '该条目没有弹幕' };
    }
    const count = writeXml(out, items);
    if (!count) return { ok: false, error: '弹幕 XML 写盘失败' };
    log.info(`✅ 手动选定弹幕就绪: episodeId=${id} -> ${count} 条（凭证=${credentialLabel()}）`);
    return okResult(count, title, title, ID_PREFIX + id, id);
}
