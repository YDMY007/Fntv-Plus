// watchTime.ts — [lc-1230] 飞牛观看时间字段的语义修正（共享纯函数，零依赖，可直测）
// ─────────────────────────────────────────────────────────────────────────────
// 背景（实测证据，见 scripts/_verify_watchreport_lc1226.cjs）：
//   飞牛 item/episode 的 `watched_ts` 字段**不是观看时间戳，而是播放进度(秒)**。
//   log/ 目录下 672 条真实 item 样本：
//     · watched_ts === ts（当前播放位置）者 530 条；
//     · 从未出现 watched_ts > duration 的情况（最大 5397，而同一条 duration 也是 5397）；
//     · 全部样本都远小于「秒级 epoch 时间戳」的量级（今天是 ~1.79e9）。
//   旧代码 `new Date(watched_ts * 1000)` 把进度当成 epoch：进度 528 秒 → 1970-01-01。
//   这就是年度观影报告里「1970 年观看」脏数据的真正源头 —— lc-1075 只在下游把 <2000 的
//   时间戳丢掉（治标），没有治根；修正后条目级 lastPlayed 基本为空，报告只能改用本地真实事件台账。
//
// 约定：本模块是「飞牛时间字段 → 墙钟 ms」的唯一判据，主进程各处一律引用，不再各写一份。
// ─────────────────────────────────────────────────────────────────────────────

/** 2000-01-01T00:00:00Z。早于此的「时间戳」必为脏数据（epoch 0 / 进度值 / 占位值）。 */
export const MIN_VALID_TS = 946684800000;
/** 同上，秒级表示（watched_ts 若是时间戳，应当是秒级）。 */
export const MIN_VALID_TS_SEC = 946684800;

/**
 * 飞牛 `watched_ts` → 墙钟毫秒。
 * 只有字段值本身像墙钟时间（秒级 ≥ 2000-01-01，或已是 ms）才返回时间；否则返回 0 = 未记录时间。
 * 进度值（528、1355、5397…）一律得 0，绝不换算成 1970。
 */
export function watchedTsToMs(v: any): number {
    const n = Number(v);
    if (!n || !isFinite(n) || n < MIN_VALID_TS_SEC) return 0;
    return n < 1e12 ? n * 1000 : n; // 秒级 → ms（已是 ms 的直接用）
}

/** 该字段是否表示「播放过」（进度非零即播过；与「什么时候播的」无关）。 */
export function hasWatchTrace(v: any): boolean {
    const n = Number(v);
    return !!n && isFinite(n) && n > 0;
}

/** 任意时间值（ISO 字符串 / 秒级 / 毫秒级）→ 墙钟毫秒，非法或早于 2000 年返回 0。 */
export function toValidMs(v: any): number {
    if (v === null || v === undefined || v === '') return 0;
    let ms = 0;
    if (typeof v === 'number') ms = v < 1e12 ? v * 1000 : v;
    else { const p = Date.parse(String(v)); if (!Number.isNaN(p)) ms = p; }
    return ms >= MIN_VALID_TS ? ms : 0;
}
