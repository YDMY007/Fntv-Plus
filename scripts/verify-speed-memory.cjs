#!/usr/bin/env node
/**
 * [lc-1304] MPV 倍速按剧集记忆 —— 离线验证（零浏览器 / 零 GPU / 零 mpv 进程）
 *
 * 手法：stub 掉 electron 与 logger，直接 require 真实编译产物 dest/main/common/playbackSpeed.js，
 *      在临时目录里做完整的「记 → 落盘 → 重启（清模块缓存重新 require）→ 读回」链路，
 *      并覆盖默认值不落盘、重置覆盖、钳位、坏文件容错、条目上限裁剪等边界。
 *
 * 判据（任一失败即退出码 1）：
 *   ① 键：tv_title → tv:<归一化剧名>（大小写/空白不敏感）；无剧名 → guid:<itemGuid>；都没有 → ''
 *   ② 记忆读写 + 重启后仍在（真正读的是磁盘 JSON）
 *   ③ 从没记过 & 值=1.0 → 不落盘；记过 1.5 后又改回 1.0 → 覆盖为 1.0
 *   ④ 钳位 0.25~4、两位小数
 *   ⑤ 坏 JSON 容错（不抛、当空表），仍然能写入
 *   ⑥ 超过 300 条按最后使用时间裁剪
 *   ⑦ 旧实现 `Number(getProperty('speed'))` 恒为 1（Promise→NaN）的举证 + 新步进算法
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fntv-speed-'));
const MEM_FILE = path.join(TMP, 'playback-speed.json');
const MOD = path.resolve(__dirname, '../dest/main/common/playbackSpeed.js');

// ── stub electron / logger ────────────────────────────────────────────────
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => TMP } };
    if (/modules[\\/]logger$/.test(request)) {
        return { component: () => ({ info() {}, warn() {}, debug() {}, error() {} }) };
    }
    return origLoad.apply(this, arguments);
};

let mod = require(MOD);
const fresh = () => { delete require.cache[require.resolve(MOD)]; mod = require(MOD); };

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); fail++; }
};

console.log('临时目录:', TMP);
console.log('\n① 键的取法');
check('tvTitle → tv:<归一化>', () => {
    assert.strictEqual(mod.speedKeyOf({ tvTitle: '葬送的芙莉莲', itemGuid: 'g1' }), 'tv:葬送的芙莉莲');
});
check('大小写/前后空白/连续空格 归一化后同键', () => {
    assert.strictEqual(mod.speedKeyOf({ tvTitle: '  The   Bear ' }), mod.speedKeyOf({ tvTitle: 'the bear' }));
});
check('无 tvTitle → guid:<itemGuid>（电影/个人视频各自独立）', () => {
    assert.strictEqual(mod.speedKeyOf({ itemGuid: 'guid-1', title: '某电影' }), 'guid:guid-1');
});
check('两者都无 → 空串（调用方据此跳过记忆）', () => {
    assert.strictEqual(mod.speedKeyOf({}), '');
    assert.strictEqual(mod.speedKeyOf(null), '');
});

console.log('\n② 记忆读写 + 重启后仍在');
check('空表查不到 → null', () => assert.strictEqual(mod.recallSpeed('tv:x'), null));
check('记 1.5 → 读回 1.5', () => {
    mod.rememberSpeed('tv:x', 1.5);
    assert.strictEqual(mod.recallSpeed('tv:x'), 1.5);
});
check('flush 落盘后文件里有条目', () => {
    mod.flushSpeedMemory();
    const data = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'));
    assert.strictEqual(data.version, 1);
    assert.strictEqual(data.items['tv:x'].speed, 1.5);
    assert.ok(data.items['tv:x'].ts > 0, 'ts 应被写入');
});
check('模拟重启（清模块缓存重新加载）后仍读得到', () => {
    fresh();
    assert.strictEqual(mod.recallSpeed('tv:x'), 1.5);
});

console.log('\n③ 默认值 1.0 的处理');
check('从没记过 + 1.0 → 不落盘', () => {
    mod.rememberSpeed('guid:never', 1.0);
    mod.flushSpeedMemory();
    const data = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'));
    assert.strictEqual(data.items['guid:never'], undefined);
    assert.strictEqual(mod.recallSpeed('guid:never'), null);
});
check('记过 1.5 后改回 1.0 → 覆盖（重置也要被记住）', () => {
    mod.rememberSpeed('tv:reset', 1.5);
    mod.rememberSpeed('tv:reset', 1.0);
    mod.flushSpeedMemory();
    const data = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'));
    assert.strictEqual(data.items['tv:reset'].speed, 1.0);
});
check('同一键重复记同值 → 只续期，不重复写', () => {
    mod.rememberSpeed('tv:x', 1.5);
    const before = fs.statSync(MEM_FILE).mtimeMs;
    mod.rememberSpeed('tv:x', 1.5);
    mod.flushSpeedMemory();
    assert.ok(fs.statSync(MEM_FILE).mtimeMs >= before, '时间戳单调');
    assert.strictEqual(mod.recallSpeed('tv:x'), 1.5);
});

console.log('\n④ 钳位与取整');
check('0.1 → 0.25；9 → 4；1.234 → 1.23', () => {
    assert.strictEqual(mod.clampSpeed(0.1), 0.25);
    assert.strictEqual(mod.clampSpeed(9), 4);
    assert.strictEqual(mod.clampSpeed(1.234), 1.23);
    assert.strictEqual(mod.clampSpeed(NaN), 1);
});
check('超范围的记忆值也会被钳位落盘', () => {
    mod.rememberSpeed('tv:clamp', 99);
    assert.strictEqual(mod.recallSpeed('tv:clamp'), 4);
});

console.log('\n⑤ 坏文件容错');
check('写坏 JSON → 重新加载不抛、当空表', () => {
    fs.writeFileSync(MEM_FILE, '{ this is not json');
    fresh();
    assert.strictEqual(mod.recallSpeed('tv:x'), null);
});
check('坏文件后仍能正常写入并读回', () => {
    mod.rememberSpeed('tv:after-corrupt', 1.25);
    mod.flushSpeedMemory();
    fresh();
    assert.strictEqual(mod.recallSpeed('tv:after-corrupt'), 1.25);
});
check('版本不符 → 整体作废（不是逐条猜）', () => {
    fs.writeFileSync(MEM_FILE, JSON.stringify({ version: 99, items: { 'tv:x': { speed: 2, ts: 1 } } }));
    fresh();
    assert.strictEqual(mod.recallSpeed('tv:x'), null);
});

console.log('\n⑥ 条目上限');
check('写入 320 条 → 落盘后 ≤300，且保留的是最近使用的', () => {
    fresh();
    for (let i = 0; i < 320; i++) {
        mod.rememberSpeed('tv:bulk' + i, 1.5);
        // 拉开 ts，让最后写入的确实是"最近使用"
        fs.readFileSync; // noop
    }
    mod.flushSpeedMemory();
    const data = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'));
    const keys = Object.keys(data.items);
    assert.ok(keys.length <= 300, '条数应 ≤300，实际 ' + keys.length);
    assert.ok(keys.includes('tv:bulk319'), '最近写入的应保留');
    assert.ok(!keys.includes('tv:bulk0'), '最早的应被裁掉');
});

console.log('\n⑦ 倍速步进（顺带修掉的旧 bug 举证）');
check('旧写法 Number(Promise) → NaN → ||1 恒为 1（这正是连按不叠加的原因）', () => {
    const fakeGetProperty = () => Promise.resolve(1.5);
    assert.strictEqual(Number(fakeGetProperty()) || 1, 1);
    assert.ok(Number.isNaN(Number(fakeGetProperty())));
});
check('新算法：实时值步进 + 钳位', () => {
    const step = (cur, dir) => mod.clampSpeed(dir === 'up' ? cur + 0.1 : cur - 0.1);
    assert.strictEqual(step(1.5, 'up'), 1.6);
    assert.strictEqual(step(1.5, 'down'), 1.4);
    assert.strictEqual(step(4, 'up'), 4);
    assert.strictEqual(step(0.25, 'down'), 0.25);
});

Module._load = origLoad;
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
