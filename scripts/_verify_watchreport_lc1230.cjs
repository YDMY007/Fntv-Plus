// 验证 [lc-1230] 年度报告数据缺陷修复（纯函数直测，零外网依赖）。
// 用法: node scripts/_verify_watchreport_lc1230.cjs
//
// 缺陷背景（均有实测证据）：
//   飞牛 item.watched_ts 是**播放进度(秒)**，不是观看时间戳 —— log/ 下 672 条真实 item 中
//   watched_ts 与 ts 完全相等者 530 条，且从未大于 duration（最大 5397 == duration 5397）。
//   旧代码 `watched_ts * 1000` 把它当 epoch：进度 528 秒 → 1970-01-01，这才是「1970 年观看」源头。
//   → 条目级 last_played 全是脏值，年度报告的时间轴没有可用数据，只能靠「每日条数 × 30 分钟」编。
//
// 本文件用三层断言锁住修复：
//   A. watchedTsToMs：进度值不得被当成时间戳（1970 必须消失）
//   B. computeReportFromEvents：真实事件台账（含真实时长）算出的报告逐项正确
//   C. computeReport：条目级回退用「真实进度 × 时长」，且不再把去年看完的剧整段算进今年
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let n = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ' → 实际=' + JSON.stringify(a)); n++; };
const ok = (c, msg) => { assert.ok(c, msg); n++; };

// ── A. watched_ts 语义：进度值不得变成 1970（共享纯模块，零依赖直测）──
const { watchedTsToMs: toMs, hasWatchTrace, toValidMs } = require(path.join(ROOT, 'dest/main/common/watchTime.js'));
ok(typeof toMs === 'function', 'watchTime 导出 watchedTsToMs');
eq(toMs(528), 0, 'A1 进度 528 秒（真实样本）不得当成时间戳');
eq(toMs(1355), 0, 'A2 进度 1355 秒不得当成时间戳');
eq(toMs(5397), 0, 'A3 最大实测进度 5397 秒不得当成时间戳');
eq(toMs(0), 0, 'A4 无进度 → 0');
eq(toMs(undefined), 0, 'A5 缺字段 → 0');
eq(toMs(946684800), 946684800000, 'A6 真·秒级墙钟时间(2000-01-01) 正常换算');
eq(toMs(1758600000), 1758600000000, 'A7 真·秒级墙钟时间(2025) 正常换算');
eq(toMs(1758600000000), 1758600000000, 'A8 已是毫秒的墙钟时间原样返回');
ok(new Date(toMs(528) || 946684800000).getFullYear() >= 2000, 'A9 修复后不可能产出 1970 年');
// hasWatchTrace：进度非零 = 播过（与「什么时候播的」解耦，避免修好时间后丢掉观看痕迹）
eq(hasWatchTrace(528), true, 'A10 进度 528 → 播过（不能因时间不可用而丢痕迹）');
eq(hasWatchTrace(0), false, 'A11 进度 0 → 没播过');
eq(hasWatchTrace(undefined), false, 'A12 缺字段 → 没播过');
// toValidMs：ISO 字符串 / 秒级 / 毫秒级统一归一，脏值归零
eq(toValidMs('2025-03-10T21:00:00Z'), Date.parse('2025-03-10T21:00:00Z'), 'A13 ISO 字符串归一到 ms');
eq(toValidMs(1758600000), 1758600000000, 'A14 秒级归一');
eq(toValidMs('1970-01-01'), 0, 'A15 1970 字符串归零');
eq(toValidMs(''), 0, 'A16 空串归零');

// ── 加载 preload 的 watchReport（纯函数，stub 掉 hooks/watchHistory）──
function loadWatchReport() {
    const req = require('module').prototype.require;
    const src = require('fs').readFileSync(path.join(ROOT, 'dest/preload/plugins/watchReport.js'), 'utf8');
    const module = { exports: {} };
    const stubRequire = (name) => {
        if (name === '../core/hooks') return { registerHook: () => {}, HookType: { OnReady: 'onReady', OnDomChange: 'onDomChange' } };
        if (name === './watchHistory') {
            return {
                getWatchReportData: () => [],
                getSessionTs: (s) => {
                    const my = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
                    if (my) return new Date(+my[1], +my[2] - 1, +my[3], +my[4], +my[5], 0, 0).getTime();
                    const m = s.match(/^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
                    if (m) { const d = new Date(); d.setMonth(+m[1] - 1, +m[2]); d.setHours(+m[3], +m[4], 0, 0); return d.getTime(); }
                    return 0;
                },
                getWatchDayLedger: () => [],
                getWatchEvents: () => [],
                MIN_VALID_TS: 946684800000,
            };
        }
        return req.call(module, name);
    };
    const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', src);
    fn(stubRequire, module, module.exports, path.join(ROOT, 'dest/preload/plugins'), path.join(ROOT, 'dest/preload/plugins/watchReport.js'));
    return module.exports;
}

const wr = loadWatchReport();
ok(typeof wr.computeReportFromEvents === 'function', 'watchReport 暴露 computeReportFromEvents');
ok(typeof wr.computeReport === 'function', 'watchReport 暴露 computeReport');

// ── B. 事件级（首选数据源）：全部真实墙钟时间 + 真实时长 ──
// 构造跨年真实事件：2025 年 3 月剧A 两次(各 1h)、7 月剧B(1.5h)+电影C(3h，深夜开始)、2024 年一次(不得计入)
const ev2025 = [
    { ts: new Date(2025, 2, 10, 21, 0).getTime(), key: 'g1', name: '剧A', type: '剧集', ms: 3600000 },
    { ts: new Date(2025, 2, 11, 20, 30).getTime(), key: 'g1', name: '剧A', type: '剧集', ms: 3600000 },
    { ts: new Date(2025, 6, 5, 1, 30).getTime(), key: 'g2', name: '剧B', type: '动漫', ms: 5400000 },
    { ts: new Date(2025, 6, 6, 22, 0).getTime(), key: 'g3', name: '电影C', type: '电影', ms: 10800000 },
    { ts: new Date(2024, 11, 31, 23, 0).getTime(), key: 'g9', name: '去年剧', type: '剧集', ms: 9999999 },
];
const meta = [
    { name: '剧A', prog: 1, myRating: 5, type: '剧集' },
    { name: '剧B', prog: 0.5, myRating: 4, type: '动漫' },
    { name: '电影C', prog: 1, myRating: 0, type: '电影' },
];
const R = wr.computeReportFromEvents(ev2025, 2025, meta);
const TOTAL = 3600000 + 3600000 + 5400000 + 10800000;
eq(R.totalMs, TOTAL, 'B1 总时长 = 各段真实时长之和（跨年那段不计）');
eq(R.titles, 3, 'B2 部数 = 3（去年剧不入今年）');
eq(R.finished, 2, 'B3 看完数 = 2（剧A/电影C）');
eq(R.rated, 2, 'B4 打过分 = 2（剧A/剧B）');
eq(R.monthMs[2], 7200000, 'B5 3 月时长 = 2 次 × 1h');
eq(R.monthMs[6], 16200000, 'B6 7 月时长 = 1.5h + 3h');
eq(R.monthMs[11], 0, 'B7 12 月无记录（跨年事件未被错算）');
eq(R.activeDays, 4, 'B8 活跃天数 = 4（2025-03-10、03-11、07-05、07-06）');
ok(R.nightRatio > 0, 'B9 夜猫占比 > 0（7/5 01:30 属深夜段）');
eq(R.hourMs[1], 5400000, 'B10 01 点时段 = 1.5h 深夜（剧B 01:30 起播）');
eq(R.top.map((t) => t.name).join('>'), '电影C>剧A>剧B', 'B11 TOP 排序按真实时长降序');
eq(R.top[0].type, '电影', 'B11b 片单带回条目类型（用于展示/统计）');
eq(R.source, 'events', 'B12 数据源标记为 events（真实事件）');
eq(R.synthetic, undefined, 'B13 全部时长真实 → 不标估算');

// B14 未回填时长的事件：用历史真实均值补齐并如实标记估算（不是硬编码 30 分钟）
const evMixed = [
    { ts: new Date(2025, 4, 1, 20, 0).getTime(), key: 'a', name: 'A', ms: 3600000 },
    { ts: new Date(2025, 4, 2, 20, 0).getTime(), key: 'a', name: 'A' }, // 无 ms
];
const RM = wr.computeReportFromEvents(evMixed, 2025, []);
eq(RM.totalMs, 7200000, 'B14a 缺失时长的会话用真实均值(1h)补齐，而非 30 分钟');
eq(RM.synthetic, true, 'B14b 含补齐值时标记估算（封面如实告知）');

// B15 从未有带时长的事件 → 才退回 30 分钟默认值
const evNone = [{ ts: new Date(2025, 4, 3, 20, 0).getTime(), key: 'a', name: 'A' }];
eq(wr.computeReportFromEvents(evNone, 2025, []).totalMs, 1800000, 'B15 无任何历史时长 → 退回 30 分钟');

// ── C. 条目级回退：真实进度 × 时长；不把去年整段算进今年 ──
const tsOf = (s) => {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime() : 0;
};
// C1 有真实会话（带结束时间）→ 用真实时长
const rSession = wr.computeReport([{
    name: '有结束时间的剧', prog: 0.5, myRating: 4, totalRuntimeMs: 7200000,
    sessions: [['2025-03-10 21:00', '2025-03-10 22:00']], // 真实 1h
}], 2025, tsOf);
eq(rSession.totalMs, 3600000, 'C1 有结束时间 → 用真实时长 1h（不是 30 分钟默认值）');

// C2 看完但会话无结束时间 → 用真实进度折算（prog × runtime），不是硬编码 30 分钟
const rProg = wr.computeReport([{
    name: '看了一半的剧', prog: 0.5, myRating: 0, totalRuntimeMs: 7200000,
    lastPlayedAt: new Date(2025, 4, 1, 21, 0).getTime(),
}], 2025, tsOf);
eq(rProg.totalMs, 3600000, 'C2 无会话 → prog(0.5) × 总时长(2h) = 1h 真实折算');

// C2b 有会话串但**没有结束时间**（本模块自产会话的常态）→ 仍须用 prog × runtime，而不是 30 分钟
const rNoEnd = wr.computeReport([{
    name: '会话无结束时间', prog: 0.5, myRating: 0, totalRuntimeMs: 7200000,
    lastPlayedAt: new Date(2025, 4, 2, 21, 0).getTime(),
    sessions: [['2025-05-02 21:00', '']],   // 旧实现会按 30 分钟算
}], 2025, tsOf);
eq(rNoEnd.totalMs, 3600000, 'C2b 会话无结束时间 → 优先用真实进度折算(1h)，不是 30 分钟');
eq(rNoEnd.synthetic, undefined, 'C2c 进度折算属真实量 → 不标估算');

// C2d 极罕见：既无结束时间也无作品时长 → 才退回 30 分钟占位并标记估算
const rNoDur = wr.computeReport([{
    name: '无时长的条目', prog: 0, myRating: 0, totalRuntimeMs: 0,
    lastPlayedAt: new Date(2025, 4, 3, 21, 0).getTime(),
    sessions: [['2025-05-03 21:00', '']],
}], 2025, tsOf);
eq(rNoDur.totalMs, 1800000, 'C2d 无任何真实时长 → 退回 30 分钟占位（最后手段）');
eq(rNoDur.synthetic, true, 'C2e 占位值 → 标记估算');

// C3 去年看完的剧：整段不得算进今年（旧实现按 totalRuntimeMs 全额入账）
const rLastYear = wr.computeReport([{
    name: '去年看完的剧', prog: 1, myRating: 5, totalRuntimeMs: 36000000,
    lastPlayedAt: new Date(2024, 5, 1).getTime(),
}], 2025, tsOf);
eq(rLastYear.totalMs, 0, 'C3 最近播放在去年 → 不计入本年（旧实现会全额误入）');
eq(rLastYear.source, 'items', 'C4 条目级数据源标记正确');

// C5 脏数据（1970）依旧被剔除并计数
const rDirty = wr.computeReport([{
    name: '脏数据条目', prog: 1, myRating: 0, totalRuntimeMs: 3600000,
    sessions: [['1970-01-01 08:00', '1970-01-01 09:00']],
}], 2025, tsOf);
eq(rDirty.totalMs, 0, 'C5 1970 脏会话不入统计');
eq(rDirty.ignored, 1, 'C6 脏记录计数供封面明示');

// ── D. 端到端：修好的 watched_ts 不再产生「1970 年观看」 ──
// 模拟主进程 analyzeItem 对真实样本（进度 528 / watched=0）的处理
const lpFromRealSample = toMs(528);
const evFromSample = lpFromRealSample ? new Date(lpFromRealSample).getFullYear() : 0;
ok(evFromSample === 0 || evFromSample >= 2020, 'D1 真实进度样本不再产出 1970 年（当前=' + evFromSample + '）');

// ── E. 观看时长状态机（主进程真实时长采集，报告时长的源头）──
const { WatchSessionTracker, SESSION_IDLE_GAP_MS, SESSION_MIN_KEEP_MS } = require(path.join(ROOT, 'dest/main/common/watchSession.js'));
const t0 = new Date(2025, 2, 10, 21, 0).getTime();
const tr = new WatchSessionTracker();
eq(tr.tick('g1', '剧A', t0), null, 'E1 首次进度事件只开始计时，无结算');
for (let i = 1; i <= 60; i++) tr.tick('g1', '剧A', t0 + i * 60000); // 60 分钟，每分钟一次进度
const ended = tr.flush();
eq(ended.ms, 3600000, 'E2 连续 60 分钟进度 → 累计 1h');
eq(ended.guid, 'g1', 'E3 结算带正确 guid');
eq(ended.startedAt, t0, 'E3b 结算带起播时刻（供渲染端精确对位事件）');

// E4 暂停空档不计入：看 10 分钟后停 2 小时（超过 IDLE_GAP）再看 10 分钟
const tr2 = new WatchSessionTracker();
tr2.tick('g2', '剧B', t0);
for (let i = 1; i <= 10; i++) tr2.tick('g2', '剧B', t0 + i * 60000);
const resume = t0 + 10 * 60000 + 2 * 3600000; // 2 小时后恢复
tr2.tick('g2', '剧B', resume);
for (let i = 1; i <= 10; i++) tr2.tick('g2', '剧B', resume + i * 60000);
eq(tr2.flush().ms, 1200000, 'E4 中间 2 小时空档不计入（只看 20 分钟）');

// E5 切集自动结算上一段
const tr3 = new WatchSessionTracker();
tr3.tick('g3', '剧C', t0);
for (let i = 1; i <= 30; i++) tr3.tick('g3', '剧C', t0 + i * 60000);
const prev = tr3.tick('g4', '剧D', t0 + 30 * 60000); // 切到另一部
eq(prev.ms, 1800000, 'E5a 切集时自动结算上一段 30 分钟');
eq(prev.guid, 'g3', 'E5b 结算的是被切走的条目');

// E6 碎片不落账（误触/秒退 10 秒）
const tr4 = new WatchSessionTracker();
tr4.tick('g5', '剧E', t0);
tr4.tick('g5', '剧E', t0 + 10000);
eq(tr4.flush(), null, 'E6 不足 ' + (SESSION_MIN_KEEP_MS / 1000) + ' 秒的碎片不落账');

// E7 空 guid 忽略（播放器未解析出条目时不得起会话）
const tr5 = new WatchSessionTracker();
eq(tr5.tick('', '', t0), null, 'E7 空 guid 不起会话');
eq(tr5.flush(), null, 'E7b 空会话 flush 无副作用');

// ── F. 第三级兜底：每日台账 × 真实平均单次时长 ──
const baseEmpty = wr.computeReport([], 2025, tsOf);
const ledger = [
    { y: 2025, m0: 2, d: 10, count: 2 }, // 3/10 两次
    { y: 2025, m0: 2, d: 11, count: 1 }, // 3/11 一次
    { y: 2024, m0: 5, d: 1, count: 9 },  // 去年，不得入账
];
// 带上真实历史均值 1h 的事件（同年另一次观看）
const histEvents = [{ ts: new Date(2025, 0, 5, 20, 0).getTime(), key: 'h1', name: '历史剧', ms: 3600000 }];
const FL = wr.synthesizeFromLedger(ledger, histEvents, 2025, baseEmpty);
eq(FL.totalMs, 3 * 3600000, 'F1 台账 3 次 × 真实均值 1h = 3h（去年台账不计）');
eq(FL.monthMs[2], 3 * 3600000, 'F2 全部归 3 月');
eq(FL.monthMs[5], 0, 'F3 去年 6 月不参与');
eq(FL.activeDays, 2, 'F4 活跃天数 2');
eq(FL.maxStreak, 2, 'F5 3/10-3/11 连刷 2 天');
eq(FL.source, 'ledger', 'F6 标记数据源=ledger');
eq(FL.synthetic, true, 'F7 标记估算（封面/导出图如实告知）');
eq(FL.top.length, 0, 'F8 不传 facts 时不编造片单');
// 无任何历史时长 → 退回 30 分钟
const F0 = wr.synthesizeFromLedger(ledger, [], 2025, baseEmpty);
eq(F0.totalMs, 3 * 1800000, 'F9 从未有带时长事件 → 退回 30 分钟口径');
// 该年台账为空 → 原样返回基准（不伪造数据）
eq(wr.synthesizeFromLedger([], histEvents, 2030, baseEmpty).totalMs, 0, 'F10 无台账年份不伪造数据');

// ── G. [lc-1230b] 复现用户报障：飞牛无观看日期，但天数/连续天数正常，片单与看完率却空 ──
// 真实数据形状：24 部（看完 9 / 部分看 15），全部 last_played=0（日期不可用），
// 每日台账却有记录（所以天数/连续天数有值）。旧实现把 top/items 清空 → TOP5 与看完率一起 0。
const realItems = [
    { name: '剧A', prog: 1, myRating: 5, totalRuntimeMs: 24 * 3600000, lastPlayedAt: 0, type: '剧集' },
    { name: '剧B', prog: 0.5, myRating: 4, totalRuntimeMs: 20 * 3600000, lastPlayedAt: 0, type: '动漫' },
    { name: '电影C', prog: 1, myRating: 0, totalRuntimeMs: 2 * 3600000, lastPlayedAt: 0, type: '电影' },
    { name: '仅痕迹剧D', prog: 0, myRating: 0, totalRuntimeMs: 10 * 3600000, lastPlayedAt: 0, type: '剧集' },
];
// 无日期年份：条目级 computeReport 得 0 → 走第③级台账
const noDate = wr.computeReport(realItems, 2026, tsOf);
eq(noDate.totalMs, 0, 'G1 无观看日期时条目级无时长（复现报障前提）');
const facts = wr.computeItemFacts(realItems);
eq(facts.titles, 4, 'G2 作品级事实：4 部（不依赖日期）');
eq(facts.finished, 2, 'G3 看完 2 部（旧实现此处为 0 → 看完率 0%）');
eq(facts.rated, 2, 'G4 打过分 2 部（旧实现此处为 0）');
eq(facts.top[0].name, '剧A', 'G5 TOP1 = 剧A（24h 看完）');
eq(facts.top[1].name, '剧B', 'G6 TOP2 = 剧B（20h × 50% = 10h）');
eq(facts.top[2].name, '电影C', 'G7 TOP3 = 电影C（2h 看完）');
const G = wr.synthesizeFromLedger(ledger, histEvents, 2025, noDate, facts);
eq(G.top.length, 4, 'G8 台账模式回填真实片单（旧实现被清空 → TOP5 页空白）');
eq(G.finished, 2, 'G9 看完数不再为 0');
eq(G.titles, 4, 'G10 部数不再为 0');
eq(G.itemsScope, 'all', 'G11 明示口径=全库累计（飞牛无日期，不能冒充本年）');
ok(G.top[0].ms > 0, 'G12 片单时长按真实进度折算（非编造）');
// 看完率恢复（旧实现在此得 0%）
eq(Math.round((G.finished / G.titles) * 100), 50, 'G13 看完率 50% 而非 0%');
// 口径标记的契约：computeReport 只统计本年日期，故恒为 'year'（无数据时其结果会被层级选择丢弃）；
// 只有台账兜底那条路才会标 'all'。两者都不能含糊。
const noDate2 = wr.computeReport(realItems, 2026, tsOf);
eq(noDate2.totalMs, 0, 'G14a 无日期年份条目级无时长（该结果会被层级选择丢弃）');
eq(noDate2.itemsScope, 'year', 'G14b computeReport 恒为 year 口径（它只统计本年日期）');
ok(G.itemsScope === 'all' && noDate2.itemsScope === 'year', 'G14c all/year 两种口径严格区分，不互相冒充');
const withDate = wr.computeReport([{ name: 'X', prog: 1, myRating: 0, totalRuntimeMs: 3600000, lastPlayedAt: new Date(2026, 4, 1).getTime() }], 2026, tsOf);
eq(withDate.itemsScope, 'year', 'G15 有本年日期 → 口径标 year');
eq(wr.computeReportFromEvents([{ ts: new Date(2026, 4, 1).getTime(), key: 'k', name: 'Y', ms: 3600000 }], 2026, []).itemsScope, 'year', 'G16 事件级口径标 year');

// ── H. [lc-1230b] 「观影时刻」无小时数据：不得编造结论 ──
// 每日台账只有「当天看了几部」，没有小时维度 → hourMs 必然全零。
// 旧实现据此算出 nightRatio=0 → 页面显示「养生作息 ☀️ / 深夜占比 0.0%」并配一张空图（用户报障之一）。
const noHour = wr.synthesizeFromLedger(ledger, histEvents, 2025, noDate, facts);
eq(noHour.hourMs.reduce((a, b) => a + b, 0), 0, 'H1 台账模式无小时维度（hourMs 全零）');
eq(noHour.nightRatio, 0, 'H2 夜猫占比无数据时为 0');
// 关键：页面必须靠 hourMs 全零来识别「无数据」，而不是把 nightRatio=0 当结论
ok(noHour.hourMs.every((v) => v === 0), 'H3 页面据 hourMs 全零判定「暂无数据」而非输出养生作息');
// 对照：有真实事件时小时分布非空，页面才会给出夜猫结论
const withHour = wr.computeReportFromEvents([{ ts: new Date(2025, 4, 1, 1, 30).getTime(), key: 'k', name: 'Z', ms: 3600000 }], 2025, []);
ok(withHour.hourMs.reduce((a, b) => a + b, 0) > 0, 'H4 有真实事件时小时分布非空');
eq(withHour.nightRatio, 1, 'H5 深夜起播时夜猫占比 1（结论有据）');

// ── I. 用户实际看到的页面文案（pageHtml 是渲染入口，直接断言渲染结果）──
const noHourPage = wr.pageHtml(noHour, 2);
ok(/暂无可用的观看时刻数据/.test(noHourPage), 'I1 无小时数据 → 页面明说暂无，而不是给结论');
ok(!/养生作息/.test(noHourPage), 'I2 不得出现编造的「养生作息」');
ok(!/深夜时段\(00-05点\)观看占比/.test(noHourPage), 'I3 不得显示「深夜占比 0.0%」这种假指标');

// 月份全零时不得声称「最猛的是 1 月」（indexOf 返回 0 的假结论）
const emptyBase = wr.computeReport([], 2025, tsOf);
const noMonth = wr.synthesizeFromLedger([], histEvents, 2025, emptyBase, facts);
ok(noHour.monthMs.some((v) => v > 0), 'I4 该场景月份有值（下一条断言针对真的全零）');
const allZero = { ...emptyBase, totalMs: 0, monthMs: new Array(12).fill(0) };
const p2 = wr.pageHtml({ ...allZero, source: 'ledger', itemsScope: 'all' }, 1);
ok(!/最猛的一个月是/.test(p2), 'I5 月份全零 → 不声称「最猛的一个月是 1 月」');
const p2ok = wr.pageHtml(noHour, 1);
ok(/最猛的一个月是/.test(p2ok), 'I6 有月份数据时正常给出峰值月');

// 片单/看完率页：有 facts 时必须渲染真实条目与数值
const p4 = wr.pageHtml(noHour, 3);
ok(/剧A/.test(p4), 'I7 TOP5 页渲染出真实作品名（旧实现为空白提示）');
ok(/全库累计/.test(p4), 'I8 TOP5 页标注「全库累计」口径');
const p5 = wr.pageHtml(noHour, 4);
ok(!/>0%</.test(p5), 'I9 总结页看完率不再是 0%（旧实现 0%）');
ok(/50%/.test(p5), 'I10 总结页看完率为真实的 50%（2/4 部看完）');
const p1 = wr.pageHtml(noHour, 0);
ok(/部作品/.test(p1) && /全库累计/.test(p1), 'I11 封面标注部作品为全库累计');
ok(/飞牛未提供观看日期/.test(p1), 'I12 封面如实说明日期缺失原因');
// 有真实日期的年份不得出现「全库累计」字样
const yearPage = wr.pageHtml(wr.computeReportFromEvents([{ ts: new Date(2026, 4, 1).getTime(), key: 'k', name: 'Y', ms: 3600000 }], 2026, []), 0);
ok(!/全库累计/.test(yearPage), 'I13 有真实日期时不误标全库累计');

console.log('\n[lc-1230/1230b] 年度报告数据修复验证通过: ' + n + '/' + n + ' 断言');
