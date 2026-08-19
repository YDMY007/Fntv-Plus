import * as fs from 'fs';
import * as path from 'node:path';
import { app } from 'electron';

/**
 * 每日磁盘缓存（限流保护）
 * ------------------------------------------------------------------
 * 「热门剧更新」浮层会拉取 Bangumi / TMDB / 豆瓣的列表数据。这些第三方接口
 * 都有请求频率上限，频繁调用极易被限流甚至封禁 IP。本模块保证：
 *
 *   1. 同一 key 在 TTL（默认 24h）内只真正抓取一次，其余请求直接返回本地磁盘缓存；
 *   2. 缓存落盘在 userData/cache/，跨软件重启持久化（关掉再开不重复抓）；
 *   3. 抓取失败时若本地有旧缓存，则降级返回旧缓存（网络抖动时浮窗仍有数据），
 *      否则才把错误向上抛；
 *   4. 「抓取失败」的结果本身【不缓存】，避免把错误状态当成有效数据存下来。
 *
 * 用法：
 *   const r = await getDailyCached('douban_hot', () => fetchDiscover());
 *   r.data        —— 真正的数据
 *   r.fromCache   —— true=本次来自本地缓存（未发网络请求）
 *   r.fetchedAt   —— 数据实际抓取时间戳（ms）
 */

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

function cacheDir(): string {
    const dir = path.join(app.getPath('userData'), 'cache');
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch { /* 忽略目录创建失败，调用方会走网络抓取分支 */ }
    return dir;
}

function cacheFile(key: string): string {
    // key 只允许安全字符，避免路径穿越
    const safe = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(cacheDir(), `${safe}.json`);
}

export interface DailyCacheResult<T> {
    data: T;
    fromCache: boolean;
    fetchedAt: number;
    /** [lc-581] true = 本次返回的是【过期】缓存(立即显示, 后台正在异步刷新新数据) */
    stale?: boolean;
}

/** 读取未过期的缓存；不存在 / 损坏 / 已过期则返回 null */
function readFresh<T>(file: string, ttlMs: number, now: number): DailyCacheResult<T> | null {
    try {
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!raw || typeof raw.fetchedAt !== 'number' || typeof raw.data === 'undefined') return null;
        if (now - raw.fetchedAt >= ttlMs) return null; // 过期
        return { data: raw.data as T, fromCache: true, fetchedAt: raw.fetchedAt };
    } catch { return null; } // 缓存损坏，当作未命中
}

/** 读取任意旧缓存（用于抓取失败时的降级兜底），过期也接受 */
function readAny<T>(file: string): DailyCacheResult<T> | null {
    try {
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!raw || typeof raw.data === 'undefined') return null;
        return { data: raw.data as T, fromCache: true, fetchedAt: raw.fetchedAt || 0 };
    } catch { return null; }
}

function writeCache(file: string, data: unknown, now: number): void {
    try {
        fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, data }), 'utf-8');
    } catch { /* 忽略写盘失败，不影响本次返回 */ }
}

/**
 * 取缓存或抓取。fetchFn 返回的数据若代表「失败」（调用方自行判断），
 * 应通过 throw 抛出，本函数据此区分「成功结果」与「失败」，仅缓存成功结果。
 * [lc-581] stale-while-revalidate: 缓存过期但有旧缓存(且非 force)时,
 * 立即返回旧缓存(用户秒见数据), 后台异步刷新新数据, 成功后回调 onRefreshed(data)。
 */
export async function getDailyCached<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlMs: number = DEFAULT_TTL_MS,
    force: boolean = false,
    onRefreshed?: (data: T) => void,
): Promise<DailyCacheResult<T>> {
    const file = cacheFile(key);
    const now = Date.now();

    // 1) 命中未过期缓存且非强制刷新 → 直接返回（不发任何网络请求）
    if (!force) {
        const fresh = readFresh<T>(file, ttlMs, now);
        if (fresh) return fresh;
    }

    // [lc-581] 2) stale-while-revalidate: 缓存过期/缺失但有旧缓存(非强制) →
    // 立即返回旧缓存, 后台 fire-and-forget 刷新(成功后写盘 + onRefreshed), 用户不用干等
    if (!force) {
        const old = readAny<T>(file);
        if (old) {
            void (async () => {
                try {
                    const data = await fetchFn();
                    writeCache(file, data, Date.now());
                    if (onRefreshed) { try { onRefreshed(data); } catch { /* ignore */ } }
                } catch { /* 后台刷新失败: 保持旧数据展示, 下次打开再试 */ }
            })();
            return { data: old.data, fromCache: true, fetchedAt: old.fetchedAt, stale: true };
        }
    }

    // 3) 无缓存(或 force) → 真正抓取
    let data: T;
    try {
        data = await fetchFn();
    } catch (e) {
        // 4) 抓取失败 → 降级返回旧缓存（过期也接受），没有旧缓存才把错误上抛
        const old = readAny<T>(file);
        if (old) return old;
        throw e;
    }

    // 5) 抓取成功 → 写回磁盘缓存
    writeCache(file, data, now);
    return { data, fromCache: false, fetchedAt: now };
}
