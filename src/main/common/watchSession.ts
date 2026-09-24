// watchSession.ts — [lc-1230] 观看会话时长累计（纯状态机，零依赖，可直测）
// ─────────────────────────────────────────────────────────────────────────────
// 解决什么：飞牛不提供「看了多久」——`watched_ts` 是播放进度(秒)不是时间戳（见 watchTime.ts），
//   条目级总时长(total_runtime_ms)又是「作品全长」而非「本次看了多久」。年度报告要算真实观看时长，
//   只能在本地按播放器进度事件累计。
//
// 计入口径（三条都直接影响报告数字，改动需同步回归脚本）：
//   · 只有相邻两次进度事件的间隔 ≤ IDLE_GAP 才算「在观看」；更长空档视为暂停/离开/挂机，整段跳过。
//   · 单会话累计上限 24h，防挂机累计出天量。
//   · 累计不足 MIN_KEEP(30s) 的碎片（误触、秒退）不落账，避免污染总量与「平均单次时长」。
// 只做计时，不碰 IPC/存储 —— 调用方(media.ts)负责把结果回传给渲染进程。
// ─────────────────────────────────────────────────────────────────────────────

/** 两次进度事件间隔超过此值视为暂停/离开，该段不计入观看时长。 */
export const SESSION_IDLE_GAP_MS = 5 * 60 * 1000;
/** 单会话累计上限（防挂机）。 */
export const SESSION_MAX_MS = 24 * 3600 * 1000;
/** 低于此值的碎片不落账（误触/秒退）。 */
export const SESSION_MIN_KEEP_MS = 30 * 1000;

export interface WatchSession {
    guid: string;
    title: string;
    accumulated: number;   // 已累计观看时长(ms)
    lastTickAt: number;    // 上次收到进度事件的时刻(ms)
    startedAt: number;     // 本段起播时刻(ms)：回填时长时据此对上渲染端的那条事件
}

export interface EndedSession {
    guid: string;
    title: string;
    ms: number;
    startedAt: number;     // 起播时刻，供渲染端精确对位事件
}

export class WatchSessionTracker {
    private cur: WatchSession | null = null;

    /** 收到进度事件：同一 guid 续计；切到别的 guid 先结算旧的。返回被结算的会话（若有）。 */
    tick(guid: string, title: string, now: number = Date.now()): EndedSession | null {
        if (!guid) return null;
        if (!this.cur || this.cur.guid !== guid) {
            const ended = this.flush();
            this.cur = { guid, title: title || '', accumulated: 0, lastTickAt: now, startedAt: now };
            return ended;
        }
        const gap = now - this.cur.lastTickAt;
        // 进度持续在推的间隔才算观看；空档（暂停/切走/挂机）整段跳过不计
        if (gap > 0 && gap <= SESSION_IDLE_GAP_MS) {
            this.cur.accumulated = Math.min(SESSION_MAX_MS, this.cur.accumulated + gap);
        }
        this.cur.lastTickAt = now;
        if (title && !this.cur.title) this.cur.title = title;
        return null;
    }

    /** 结算当前会话并清空。时长不足 MIN_KEEP 的碎片返回 null（不落账）。 */
    flush(): EndedSession | null {
        const s = this.cur;
        this.cur = null;
        if (!s || s.accumulated < SESSION_MIN_KEEP_MS) return null;
        return { guid: s.guid, title: s.title, ms: Math.round(s.accumulated), startedAt: s.startedAt };
    }

    /** 当前会话快照（测试/诊断用）。 */
    peek(): WatchSession | null {
        return this.cur ? { ...this.cur } : null;
    }
}
