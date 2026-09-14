// 临时验证脚本: 过渡版 update-check.json(version=3.7.0-full) 在新旧两套客户端规则下的判定
// 旧规则 = lc-1138 之前(51cbc98~1)的 updateChecker.ts 逐字复刻
// 新规则 = lc-1138(当前 HEAD)的 updateChecker.ts 逐字复刻
import { readFileSync } from 'fs';

// ── 旧规则(lc-1138 之前) ──
function oldTypeFromVersion(v) {
    if (/-hotfix\d*$/i.test(v)) return 'hotfix';
    if (/-full\d*$/i.test(v)) return 'full';
    if (/-test\d*$/i.test(v)) return 'test';
    return 'full';
}
function oldParseVersion(v) {
    const m = /^(.*?)-(?:hotfix|full|test)(\d*)$/i.exec(v || '');
    if (m) {
        const suffix = m[0].toLowerCase();
        const typeRank = suffix.includes('test') ? 1 : (suffix.includes('full') ? 3 : 2);
        const idx = m[2] === '' ? 1 : parseInt(m[2], 10);
        return { base: m[1], rank: typeRank * 100 + idx };
    }
    return { base: v || '0', rank: 0 };
}
function oldCmpBase(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}
function oldVersionGreater(latest, baseline) {
    const a = oldParseVersion(latest), b = oldParseVersion(baseline);
    const c = oldCmpBase(a.base, b.base);
    if (c !== 0) return c > 0;
    return a.rank > b.rank;
}
function oldCheck(ver, currentVersion, applied) {
    const updateType = oldTypeFromVersion(ver);
    const isTest = updateType === 'test';
    const baseline = (updateType === 'hotfix' && applied && /-hotfix\d*$/i.test(applied)) ? applied : currentVersion;
    const hasUpdate = !isTest && oldVersionGreater(ver, baseline);
    return { updateType, hasUpdate };
}

// ── 新规则(lc-1138) ──
function newStripSuffix(v) {
    return String(v || '0').replace(/^v/i, '').replace(/-(?:hotfix|full|test)\d*$/i, '');
}
function newTypeFromVersion(v, currentVersion) {
    if (/-test\d*$/i.test(v || '')) return 'test';
    const base = newStripSuffix(v);
    const cur = newStripSuffix(currentVersion);
    const a = base.split('.').map(Number), b = cur.split('.').map(Number);
    const major = (a[0] || 0) > (b[0] || 0);
    const minor = (a[0] || 0) === (b[0] || 0) && (a[1] || 0) > (b[1] || 0);
    return (major || minor) ? 'full' : 'hotfix';
}
function newCmpBase(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}
function newCheck(ver, currentVersion, applied) {
    const updateType = newTypeFromVersion(ver, currentVersion);
    const isTest = updateType === 'test';
    const appliedBase = newStripSuffix(applied);
    const curBase = newStripSuffix(currentVersion);
    const verBase = newStripSuffix(ver);
    const patchTrack = (updateType === 'hotfix') && (verBase.split('.')[0] === curBase.split('.')[0]) && (verBase.split('.')[1] === curBase.split('.')[1]);
    const baseline = (patchTrack && appliedBase && newCmpBase(appliedBase, curBase) > 0) ? appliedBase : curBase;
    const hasUpdate = !isTest && newCmpBase(verBase, baseline) > 0;
    return { updateType, hasUpdate };
}

const VER = process.argv[2] || '3.7.0-full';
let pass = 0, fail = 0;
function assert(name, cond) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name}`); }
}

console.log(`\n检测 version = "${VER}"\n── 旧规则客户端(lc-1138 前, 3.6.x 存量) ──`);
let r = oldCheck(VER, '3.6.1', '');            assert('3.6.1 安装包用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);
r = oldCheck(VER, '3.6.1-hotfix', '3.6.1-hotfix'); assert('3.6.1+已应用热补丁用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);
r = oldCheck(VER, '3.5.0', '');                assert('3.5.0 老用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);
r = oldCheck(VER, '3.3.6', '');                assert('3.3.6 远古用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);

console.log('── 新规则客户端(lc-1138+, 3.7.0 起发布) ──');
r = newCheck(VER, '3.6.1', '');                assert('3.6.1 用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);
r = newCheck(VER, '3.6.1-hotfix', '3.6.1-hotfix'); assert('3.6.1+已应用热补丁用户 → full 提示', r.updateType === 'full' && r.hasUpdate === true);
r = newCheck(VER, '3.7.0', '');                assert('3.7.0 用户 → 不重复提示', r.hasUpdate === false);
r = newCheck(VER, '3.7.0-full', '3.7.0-full'); assert('3.7.0(带过渡后缀, 不会存在此形态)→ 不提示', r.hasUpdate === false);

// 3.6.1-hotfix 用户的次级验证: 全量更新后 clearAllPatches 正常, 不因后缀走补丁轨道
console.log('\n── 对照组: 纯数字 3.7.0 在旧规则下的行为(应同样可收, 但后缀式更保险) ──');
r = oldCheck('3.7.0', '3.6.1-hotfix', '3.6.1-hotfix');
assert('旧规则+无后缀 3.7.0 → full 提示', r.updateType === 'full' && r.hasUpdate === true);

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
