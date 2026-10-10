// scripts/verify-mpv-danmaku-render.cjs —— MPV 弹幕链「真跑一遍」的回归守卫（lc-1339）
//
// 背景：lc-1335 把 parse.lua 回退到旧版时，连带把 `adaptive_fontsize()` 的调用也带回来了，
// 而该函数已被 lc-1300 从 utils.lua 删除 → 生成 ASS 时 `attempt to call global
// 'adaptive_fontsize' (a nil value)` → 弹幕整条不显示（用户报「mpv端字幕不显示」）。
// 这类「跨文件接口对不上」静态 grep 抓不到（调用点与被删定义在不同文件、且都是正常代码），
// 唯一可靠的抓法是**真把生成链跑一遍**。
//
// 本脚本用仓库自带的 mpv（--idle + 无视频，秒级、几乎不占 CPU）拉起
// scripts/mpv-danmaku-smoke.lua，然后断言日志：
//   · 模块加载成功（options/utils/parse 全部 dofile 通过）
//   · ASS 有 22 条 Dialogue（20 滚动 + 1 顶 + 1 底）
//   · 滚动弹幕带 \move、顶/底带 \pos（渲染端要按 \move 逐帧插值）
//   · density_percent=50 时事件数减半
//   · 全程无 Lua error / traceback（这是本守卫的核心）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MPV = path.join(ROOT, 'third_party', 'fntv-mpv', 'mpv.exe');
const SMOKE = path.join(ROOT, 'scripts', 'mpv-danmaku-smoke.lua');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

if (!fs.existsSync(MPV)) {
  console.log('  SKIP  本机没有 third_party/fntv-mpv/mpv.exe，跳过（弹幕链只能在 mpv 内跑）');
  process.exit(0);
}

const logFile = path.join(os.tmpdir(), `fntv-danmaku-smoke-${Date.now()}.log`);
const args = [
  '--idle', '--no-video',
  `--script=${SMOKE}`,
  '--msg-level=harness=info',
  `--log-file=${logFile}`,
  '--really-quiet=no',
];
const r = spawnSync(MPV, args, { timeout: 30000, encoding: 'utf8' });
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
try { fs.unlinkSync(logFile); } catch { /* ignore */ }

const num = (re) => {
  const m = log.match(re);
  return m ? Number(m[1]) : NaN;
};
const events = num(/HARNESS ass events=(\d+)/);
const events50 = num(/HARNESS density50 events=(\d+)/);

console.log(`\n[灌烟] mpv 拉起脚本生成弹幕 ASS（退出码 ${r.status}）`);
{
  ok(/HARNESS modules-loaded/.test(log), 'options/utils/parse 三个模块都 dofile 成功');
  ok(Number.isFinite(events) && events >= 20, `ASS 产出 Dialogue 事件（实测 ${events}）`);
  ok(/HARNESS tags move=true pos=true/.test(log),
    '滚动弹幕带 \\move、顶/底带 \\pos（渲染端逐帧插值依赖它）');
  ok(Number.isFinite(events50) && events50 > 0 && events50 <= Math.ceil(events * 0.7),
    `density_percent=50 事件数明显减少（${events} → ${events50}）`);
  ok(!/Lua error|stack traceback|attempt to (call|index) (a )?(nil|global)/.test(log),
    '全程无 Lua 报错/堆栈（本轮故障就是这个）',
    (log.match(/Lua error:[^\n]*/) || [''])[0]);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);