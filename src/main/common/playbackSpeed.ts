/**
 * [lc-1304] MPV 倍速的「按剧集」记忆
 * ─────────────────────────────────────────────────────────────────────────
 * 用户要求：「mpv 的倍速调节按剧集来持久化保存上次速度」——在某集里调到 1.5×，
 * 下次播同一部剧（换集、换季、甚至重启应用后）自动回到 1.5×。
 *
 * 键怎么取：
 *   · 有 tv_title（剧集）→ `tv:<剧名归一化>`：同一部剧的所有季/集共用一个键，
 *     换集/换季/跨设备改标题大小写都能对上；
 *   · 没有 tv_title（电影、个人视频、直播）→ `guid:<itemGuid>`：各自独立记忆；
 *   · 都没有 → 不用标题兜底（电影标题跨片重复概率高，误串记忆比不记更烦人）。
 *
 * 值：0.25~4（与播放器控制的钳位范围一致），保留两位小数。
 * 落盘：userData/playback-speed.json（version + items），按最后使用时间保留最近 300 条。
 * 写盘节流 800ms（uosc 速度菜单可被连续点），退出前 flushSpeedMemory() 兜底。
 *
 * 不记默认值：从没记过、且值是 1.0 的条目**不落盘**——否则每播一条就多一条 1.0 记录；
 * 但「本来记着 1.5、用户又改回 1.0」会正常覆盖（重置也要被记住）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';

const log = logger.component('speedMem');

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** 记忆条目的最小输入面（PlayItem 兼容子集） */
export interface SpeedKeySource {
    itemGuid?: string;
    tvTitle?: string;
    title?: string;
}

interface SpeedEntry {
    speed: number;
    ts: number;
}

const MEM_VERSION = 1;
const MEM_MAX = 300;
const SAVE_DEBOUNCE_MS = 800;

let loaded = false;
const mem = new Map<string, SpeedEntry>();
let saveTimer: NodeJS.Timeout | null = null;

function memFile(): string {
    return path.join(app.getPath('userData'), 'playback-speed.json');
}

function loadMem(): void {
    if (loaded) return;
    loaded = true;
    try {
        const data = JSON.parse(fs.readFileSync(memFile(), 'utf-8')) as { version?: number; items?: Record<string, SpeedEntry> };
        if (data && data.version === MEM_VERSION && data.items && typeof data.items === 'object') {
            for (const [k, v] of Object.entries(data.items)) {
                const sp = Number(v && v.speed);
                if (k && Number.isFinite(sp) && sp >= SPEED_MIN && sp <= SPEED_MAX) {
                    mem.set(k, { speed: clampSpeed(sp), ts: Number(v.ts) || 0 });
                }
            }
        }
    } catch { /* 文件不存在 / 损坏 / 版本变更 → 空表重新攒 */ }
}

function saveMem(): void {
    try {
        // 按最后使用时间裁剪；ts 相同（同一毫秒内连续写入）时用写入次序兜底 ——
        // 否则排序未定义，可能把刚写进来的裁掉、留下旧的。
        const ordered = [...mem.entries()].map((e, i) => [e[0], e[1], i] as const)
            .sort((a, b) => (b[1].ts - a[1].ts) || (b[2] - a[2]))
            .slice(0, MEM_MAX);
        mem.clear();
        for (const [k, v] of ordered) mem.set(k, v);
        fs.mkdirSync(path.dirname(memFile()), { recursive: true });
        fs.writeFileSync(memFile(), JSON.stringify({ version: MEM_VERSION, items: Object.fromEntries(mem) }, null, 2));
    } catch (e: any) {
        log.warn('写倍速记忆失败:', e && e.message);
    }
}

function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveMem();
    }, SAVE_DEBOUNCE_MS);
    // 别因为这个定时器拖住进程退出（真正退出前有 flush 兜底）
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** 倍速钳位 + 两位小数（与 control 动作同口径，防止 1.3000000000000003 落盘） */
export function clampSpeed(v: number): number {
    if (!Number.isFinite(v)) return 1;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v * 100) / 100));
}

/** 由播放项取记忆键；取不到返回空串（调用方据此跳过记忆） */
export function speedKeyOf(item: SpeedKeySource | null | undefined): string {
    if (!item) return '';
    const tv = String(item.tvTitle || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (tv) return 'tv:' + tv;
    const guid = String(item.itemGuid || '').trim();
    if (guid) return 'guid:' + guid;
    return '';
}

/** 查记忆倍速；没有记忆返回 null（调用方保持播放器当前/配置默认值） */
export function recallSpeed(key: string): number | null {
    if (!key) return null;
    loadMem();
    const hit = mem.get(key);
    return hit ? hit.speed : null;
}

/** 记下某剧集这次用的倍速 */
export function rememberSpeed(key: string, speed: number): void {
    if (!key) return;
    const sp = clampSpeed(speed);
    loadMem();
    const prev = mem.get(key);
    if (prev && prev.speed === sp) {
        prev.ts = Date.now(); // 值没变：只续期，不写盘
        return;
    }
    // 从没记过 + 默认 1.0 → 不落盘，避免给每条播放记录都建一条 1.0 记忆
    if (!prev && sp === 1) return;
    mem.set(key, { speed: sp, ts: Date.now() });
    scheduleSave();
}

/** 退出/停止播放前把待写盘落盘（无待写则为空操作） */
export function flushSpeedMemory(): void {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        saveMem();
    }
}
