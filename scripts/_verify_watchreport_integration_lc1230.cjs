// 验证 [lc-1230] 跨模块集成：watchHistory 的真实台账读写 → 报告聚合（用真实导出，非打桩）。
// 用法: node scripts/_verify_watchreport_integration_lc1230.cjs
//
// 与 _verify_watchreport_lc1230.cjs 的分工：
//   前者直测纯函数（watchTime / computeReport*）；
//   本文件把**真实编译产物**装进桩化的 DOM/electron 环境，走一遍完整链路：
//     IPC「开始播放」→ 台账落盘 → 导出事件 → 会话串生成 → 报告聚合，
//   确保模块间的字段名/时序/年份口径真的对得上（单测覆盖不到的部分）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let n = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ' → 实际=' + JSON.stringify(a)); n++; };
const ok = (c, msg) => { assert.ok(c, msg); n++; };

// ── 桩：localStorage（跨「重启」复用同一份底层数据）──
const disk = new Map();
const localStorage = {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    removeItem: (k) => { disk.delete(k); },
};
// ── 桩：DOM / electron ──
const ipcHandlers = new Map();
const ipcRenderer = {
    on: (ch, fn) => { ipcHandlers.set(ch, fn); },
    invoke: async () => null,
    send: () => {},
};
function makeDocument() {
    const el = () => ({
        style: {}, classList: { add() {}, remove() {}, contains: () => false },
        addEventListener() {}, appendChild() {}, remove() {}, querySelector: () => null,
        querySelectorAll: () => [], setAttribute() {}, closest: () => null,
        dataset: {}, innerHTML: '', textContent: '', children: [], insertBefore() {},
        parentElement: null, nextSibling: null, prepend() {},
    });
    return {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: el,
        addEventListener() {},
        removeEventListener() {},
        body: el(),
        documentElement: el(),
    };
}
globalThis.localStorage = localStorage;
globalThis.document = makeDocument();
globalThis.window = { addEventListener() {}, setInterval: () => 0, dispatchEvent() {}, location: { origin: 'http://localhost', pathname: '/v' } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const Module = require('module');
const stubs = {
    electron: { ipcRenderer },
    '../core/hooks': { registerHook: () => {}, HookType: { OnReady: 'onReady', OnDomChange: 'onDomChange' } },
    '../core/logger': { default: new Proxy({}, { get: () => () => {} }), __esModule: true },
    '../core/pageMode': { isFntvTvPage: () => true },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (stubs[request]) return request;
    return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    return origLoad.call(this, request, parent, isMain);
};

const wh = require(path.join(ROOT, 'dest/preload/plugins/watchHistory.js'));
const wr = require(path.join(ROOT, 'dest/preload/plugins/watchReport.js'));
Module._load = origLoad;
Module._resolveFilename = origResolve;

ok(typeof wh.getWatchEvents === 'function', 'watchHistory 导出 getWatchEvents');
ok(typeof wh.getSessionTs === 'function', 'watchHistory 导出 getSessionTs');

const onRecorded = ipcHandlers.get('fntv:watch-recorded');
const onEnded = ipcHandlers.get('fntv:watch-session-ended');
ok(typeof onRecorded === 'function', '已注册 fntv:watch-recorded IPC 监听');
ok(typeof onEnded === 'function', '已注册 fntv:watch-session-ended IPC 监听');

// ── 1. 模拟真实播放：起播两次（同剧不同集）+ 一次电影，随后回填真实时长 ──
const T = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
onRecorded(null, { guid: 'guidA', title: '剧A', type: 'series', player: 'mpv', ts: T(2025, 3, 10, 21, 0) });
onEnded(null, { guid: 'guidA', title: '剧A', ms: 3600000, startedAt: T(2025, 3, 10, 21, 0) });   // 真实看了 1h
onRecorded(null, { guid: 'guidA', title: '剧A', type: 'series', player: 'mpv', ts: T(2025, 3, 11, 21, 0) });
onEnded(null, { guid: 'guidA', title: '剧A', ms: 2400000, startedAt: T(2025, 3, 11, 21, 0) });   // 40min
onRecorded(null, { guid: 'guidB', title: '电影B', type: 'movie', player: 'potplayer', ts: T(2026, 1, 5, 23, 30) });
onEnded(null, { guid: 'guidB', title: '电影B', ms: 5400000, startedAt: T(2026, 1, 5, 23, 30) }); // 1.5h（跨年）

const evs = wh.getWatchEvents();
eq(evs.length, 3, '1a 三次起播 → 台账 3 条事件');
const evA = evs.filter((e) => e.key === 'guidA');
eq(evA.length, 2, '1b 同剧两次会话各自成条');
eq(evA[0].ms, 3600000, '1c 第一条回填真实时长 1h');
eq(evA[1].ms, 2400000, '1d 第二条回填真实时长 40min（未串到第一条）');
const evB = evs.find((e) => e.key === 'guidB');
eq(evB.ms, 5400000, '1e 电影时长回填正确');
ok(evB.ts >= 946684800000, '1f 事件时间戳为真实墙钟时间（非 1970）');

// ── 2. 台账已落盘（跨重启不丢）──
const raw = localStorage.getItem('fntv_wh_events_v1');
ok(!!raw, '2a 事件台账已写入 localStorage');
const parsed = JSON.parse(raw);
eq(parsed.length, 3, '2b 落盘条数一致');
eq(parsed.find((e) => e.key === 'guidA' && e.ms === 2400000).ms, 2400000, '2c 落盘保留时长字段');
ok(typeof parsed[0].ts === 'number' && parsed[0].ts > 946684800000, '2d 落盘时间为 ms 数值（可无损回读，非字符串）');

// ── 3. 会话串（面板「分段记录」）用真实事件，且时间戳带年份 ──
// 直接用真实导出的事件 + 真实 parseSessionDate 做一次端到端解析
const tsOf = wh.getSessionTs;
const parsedTs = tsOf(`${new Date(evA[0].ts).getFullYear()}-03-10 21:00`);
eq(new Date(parsedTs).getFullYear(), 2025, '3a 带年份的时间串解析回 2025（旧格式会丢年份算成今年）');
eq(new Date(parsedTs).getMonth() + 1, 3, '3b 月份正确');
eq(new Date(parsedTs).getDate(), 10, '3c 日期正确');
eq(new Date(parsedTs).getHours(), 21, '3d 时刻正确（本地时区）');

// ── 4. 报告聚合：跨年正确切分（真实模块 + 真实台账）──
const R2025 = wr.computeReportFromEvents(evs, 2025, [{ name: '剧A', prog: 0.5, myRating: 4, type: '剧集' }]);
eq(R2025.totalMs, 3600000 + 2400000, '4a 2025 总时长 = 2 次真实会话之和（不含 2026 那部）');
eq(R2025.titles, 1, '4b 2025 只含剧A');
eq(R2025.monthMs[2], 6000000, '4c 3 月时长正确');
eq(R2025.monthMs[0], 0, '4d 1 月无记录（2026 的没串过来）');
eq(R2025.activeDays, 2, '4e 活跃天数 2');
eq(R2025.maxStreak, 2, '4f 3/10 与 3/11 连刷 2 天');
eq(R2025.source, 'events', '4g 数据源=events（真实事件）');
eq(R2025.synthetic, undefined, '4h 时长全真实 → 不标估算');

const R2026 = wr.computeReportFromEvents(evs, 2026, [{ name: '电影B', prog: 1, myRating: 5, type: '电影' }]);
eq(R2026.totalMs, 5400000, '4i 2026 只含电影B 1.5h');
eq(R2026.finished, 1, '4j 看完数 1');
eq(R2026.hourMs[23], 5400000, '4k 23 点起播归 23 点时段');
eq(R2026.nightRatio, 0, '4l 夜猫段定义为 00-05 点起播，23:30 不算深夜（口径与页面文案一致）');
const Rnight = wr.computeReportFromEvents(
    [{ ts: T(2026, 2, 3, 1, 30), key: 'n1', name: '深夜剧', ms: 3600000 }], 2026, []);
eq(Rnight.nightRatio, 1, '4m 01:30 起播计为深夜（夜猫指数生效）');
eq(Rnight.hourMs[1], 3600000, '4n 深夜时长归 1 点时段');

// ── 5. 反复起播去重：同一条目 3 分钟内重复上报只记一次 ──
const before = wh.getWatchEvents().length;
onRecorded(null, { guid: 'guidC', title: '剧C', type: 'series', player: 'mpv', ts: T(2026, 2, 1, 20, 0) });
onRecorded(null, { guid: 'guidC', title: '剧C', type: 'series', player: 'mpv', ts: T(2026, 2, 1, 20, 1) }); // 1 分钟后
eq(wh.getWatchEvents().length, before + 1, '5a 同条目 3 分钟内重复上报去重（切集/重试不翻倍）');
onRecorded(null, { guid: 'guidC', title: '剧C', type: 'series', player: 'mpv', ts: T(2026, 2, 1, 22, 0) }); // 2 小时后
eq(wh.getWatchEvents().length, before + 2, '5b 隔 2 小时再次观看正常计一条');

// ── 5c. startedAt 精确对位：同一部剧两次观看，时长各自回填到对应那一次 ──
// 面板侧验证：先起播两次（间隔 >2h），第二次结束后回填，必须落在第二条而非第一条
const evC = wh.getWatchEvents().filter((e) => e.key === 'guidC');
eq(evC.length, 2, '5c1 剧C 两条独立事件');
onEnded(null, { guid: 'guidC', title: '剧C', ms: 900000, startedAt: evC[1].ts });
const evC2 = wh.getWatchEvents().filter((e) => e.key === 'guidC');
eq(evC2[0].ms, undefined, '5c2 第一条（较早那次）未被误填');
eq(evC2[1].ms, 900000, '5c3 时长按 startedAt 精确落到第二次观看');

// ── 5d. 同名不同作品不串记录（有 guid 时只按 guid 匹配）──
onRecorded(null, { guid: 'guidSame1', title: '同名剧', type: 'series', player: 'mpv', ts: T(2026, 3, 1, 20, 0) });
onRecorded(null, { guid: 'guidSame2', title: '同名剧', type: 'series', player: 'mpv', ts: T(2026, 3, 2, 20, 0) });
onEnded(null, { guid: 'guidSame2', title: '同名剧', ms: 3000000, startedAt: T(2026, 3, 2, 20, 0) });
const same1 = wh.getWatchEvents().filter((e) => e.key === 'guidSame1');
const same2 = wh.getWatchEvents().filter((e) => e.key === 'guidSame2');
eq(same1.length, 1, '5d1 同名两部作品各自成条');
eq(same1[0].ms, undefined, '5d2 另一部同名作品未被回填（不串记录）');
eq(same2[0].ms, 3000000, '5d3 回填落在正确的 guid 上');

// ── 6. 无时长回填的会话（播放器崩溃）：用**同批事件的真实均值**补齐并如实标记 ──
const Rmix = wr.computeReportFromEvents(
    [
        { ts: T(2026, 2, 1, 20, 0), key: 'guidC', name: '剧C', ms: 6000000 },  // 100min
        { ts: T(2026, 2, 2, 20, 0), key: 'guidC', name: '剧C', ms: 2400000 },  // 40min
        { ts: T(2026, 2, 3, 20, 0), key: 'guidC', name: '剧C' },               // 没回填
    ], 2026, []);
// 均值 = (100 + 40) / 2 = 70min，既不是硬编码 30min，也不是随便借一个值
eq(Rmix.totalMs, 6000000 + 2400000 + 4200000, '6a 缺失时长按真实均值 70min 补齐（非硬编码 30 分钟）');
ok(Rmix.totalMs !== 6000000 + 2400000 + 1800000, '6a2 明确不是旧的 30 分钟口径');
eq(Rmix.synthetic, true, '6b 含补齐值 → 标记估算供封面如实说明');

// ── 7. 脏数据防护：1970 事件永不入账 ──
onRecorded(null, { guid: 'guidDirty', title: '脏', type: 'movie', player: 'mpv', ts: 0 });
onRecorded(null, { guid: 'guidDirty', title: '脏', type: 'movie', player: 'mpv', ts: 528 * 1000 }); // 主进程已不再产出，仍双重防护
const dirty = wh.getWatchEvents().filter((e) => e.key === 'guidDirty');
eq(dirty.length, 0, '7a 早于 2000 的事件被台账拒收（不可能再出现 1970）');

console.log('\n[lc-1230] 跨模块集成验证通过: ' + n + '/' + n + ' 断言');
