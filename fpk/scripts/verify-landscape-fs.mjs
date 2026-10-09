// scripts/verify-landscape-fs.mjs —— [lc-1329] 横屏全屏「点击前判定 + 原生失败自愈降级」的双向验证
//
// 为什么要这么验：真机复现成本高（要装 fpk、连手机、点全屏），而本改动的核心是
// **分支判定逻辑**，完全可以在 vm 里跑。手法沿用仓库既有约定（3D-Breakout 的
// verify_*.js）：把真实产物里的函数抽出来跑，**未修复版本必须 FAIL、修复版本必须 PASS**，
// 否则测试是空转的。
//
// 取数方式：直接从「已构建的 payload」里按行切出那段函数（esbuild 不混淆函数名），
// 而不是从 .ts 抄一份 —— 抄一份就成了用测试证明测试。
//
// 用例（环境 → 期望）：
//   A 手机 Chrome（无 wv、触摸、竖屏、原生全屏+锁屏都有效）→ 保持 useScreenOrientation 真转屏，不进伪横屏
//   B 飞牛 App（UA 含 wv）→ 点全屏直接走 rotateFullscreen 伪横屏
//   C 飞牛 App（**自定义 UA 无 wv** + 原生全屏被拒）→ 先试原生、400ms 后自愈降级伪横屏（真机现场）
//   C2 承 C：结论粘住 —— 第二次点击直接伪横屏，不再试原生
//   D 桌面浏览器（无触摸、横向窗口）→ 不转、不自愈（不能把桌面窗口转 90°）
//   E 竖向视频（aspectRatio<1）→ 不自愈
//   对照：同一用例 C 用 git HEAD（lc-1328 版）的载荷跑 → 必须 FAIL（不转）
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_PAYLOAD = path.join(root, 'dist', 'fntv-plus.user.js');

/** 从构建产物里切出「横屏全屏」那段（含模块级策略变量 + 全部相关函数）。
 *  startMark 按版本给候选：新版有 _fsIntentBound，lc-1328 版从 _landscapeBound 起。 */
function extractRegion(text, startMarks = ['var _landscapeBound = false;', 'let _landscapeBound = false;', 'var _fsIntentBound = false;']) {
  const endMark = 'function bindVideoFullscreenFix';
  const startMark = startMarks.find((m) => text.includes(m));
  if (!startMark) throw new Error(`切不出起点：${startMarks.join(' | ')}`);
  const i = text.indexOf(startMark);
  const j = text.indexOf(endMark, i);
  if (j < 0) throw new Error(`切不出终点：${endMark}`);
  return text.slice(i, j);
}

const OLD_PAYLOAD = (() => {
  try {
    return execSync('git show HEAD:fpk/src/go/internal/inject/payload/fntv-plus.user.js', {
      cwd: root, maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
  } catch { return null; }
})();

// ────────────────────────── 仿真环境 ──────────────────────────
const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push({ name, ok, got, want });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`}`);
}

function makeEnv({ ua, touch, portrait, fullscreenEnabled, aspect, nativeFsWorks, lockWorks, region }) {
  const calls = { rotate: 0, native: 0, lock: 0, exit: 0 };
  const listeners = [];              // document 上的监听（含 capture 标记）
  const timers = [];                 // 假时钟
  let now = 0;

  const rootEl = {
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    },
  };
  rootEl['__reactFiber$test'] = null;

  const fsIcon = {
    tag: 'xg-icon',
    classList: { contains: (c) => c === 'xgplayer-fullscreen', add() {}, remove() {} },
    closest(sel) { return sel === '.xgplayer-fullscreen' ? this : null; },
  };

  const plugin = {
    config: { useCssFullscreen: false, rotateFullscreen: false, useScreenOrientation: false, lockOrientationType: 'landscape' },
    fullscreen: false,
    isRotateFullscreen: false,
    getRotateFullscreen() {
      calls.rotate++;
      this.isRotateFullscreen = true;
      this.fullscreen = true;
      rootEl.classList.add('xgplayer-rotate-fullscreen');
    },
    exitFullscreen() { calls.exit++; this.fullscreen = false; this.isRotateFullscreen = false; rootEl.classList.remove('xgplayer-rotate-fullscreen'); },
  };

  const player = {
    config: {},
    aspectRatio: aspect,
    fullscreen: false,
    plugins: { fullscreen: plugin },
    getPlugin: () => plugin,
    exitFullscreen() { player.fullscreen = false; plugin.exitFullscreen(); },
    getRotateFullscreen() { plugin.getRotateFullscreen(); },
  };
  rootEl['__reactFiber$test'] = { memoizedProps: { player }, return: null };

  const win = {
    innerWidth: portrait ? 412 : 915,
    innerHeight: portrait ? 915 : 412,
    addEventListener() {},
  };
  const doc = {
    fullscreenEnabled,
    documentElement: { classList: rootEl.classList },
    querySelector(sel) {
      if (sel === '[class*=xgplayer]') return rootEl;
      if (sel === '.xgplayer-rotate-fullscreen') return rootEl.classList.contains('xgplayer-rotate-fullscreen') ? rootEl : null;
      return null;
    },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener() {},
    fullscreenElement: null,
  };

  const sandbox = {
    window: win, document: doc,
    navigator: { userAgent: ua, maxTouchPoints: touch ? 5 : 0 },
    log: { info() {}, warn() {} },
    isPlayerPage: () => true,
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout() {},
    console,
  };
  sandbox.globalThis = sandbox;
  // 产物里的 logger 会被 esbuild 改名（log → log6 之类），按「谁在被当 logger 用」自动补桩
  for (const m of region.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:info|warn|error|debug)\s*\(/g)) {
    const name = m[1];
    if (!(name in sandbox)) sandbox[name] = { info() {}, warn() {}, error() {}, debug() {} };
  }
  // 旧版载荷用 `patch()` 直改配置；新版多了 document 监听与假时钟
  vm.createContext(sandbox);
  vm.runInContext(region, sandbox, { filename: 'danmakuWeb.region.js' });

  const runTimers = (ms) => {
    const until = now + ms;
    for (let guard = 0; guard < 50; guard++) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = until;
  };

  /** 第一次进入播放页时的预置（新版：绑监听 + 预写配置；旧版：直接 patch） */
  const init = () => { sandbox.enableLandscapeFullscreen(); runTimers(4000); };

  /** 真实点击全屏按钮：document 捕获阶段 → target 上的 xgplayer handler（bundle 实测的分支） */
  const tapFullscreen = () => {
    const ev = { target: fsIcon, type: 'touchend' };
    listeners.filter((l) => l.capture).forEach((l) => l.fn(ev));   // 捕获阶段（先于 target 绑定）
    // xgplayer 自己绑在按钮上的 handler = afterCreate 时 hook() 捕获的 toggleFullScreen 闭包
    const c = plugin.config;
    if (c.useCssFullscreen) { /* 未用 */ }
    else if (c.rotateFullscreen) { plugin.getRotateFullscreen(); }
    else {
      if (nativeFsWorks) {
        calls.native++;
        player.fullscreen = true; plugin.fullscreen = true;
        if (c.useScreenOrientation && lockWorks) { calls.lock++; win.innerWidth = 915; win.innerHeight = 412; }
      } else {
        calls.native++;   // requestFullscreen() 被拒：Promise reject 被 .catch 吞掉，界面无变化
      }
    }
  };

  return { calls, init, tapFullscreen, runTimers, plugin, player, sandbox, win, rootEl };
}

// ────────────────────────── 跑用例 ──────────────────────────
const newRegion = extractRegion(readFileSync(NEW_PAYLOAD, 'utf8'));
const oldRegion = OLD_PAYLOAD ? extractRegion(OLD_PAYLOAD) : null;

const BASE = { ua: 'Mozilla/5.0 (Linux; Android 16; PLT140) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' };
const WV = { ua: 'Mozilla/5.0 (Linux; Android 16; PLT140 Build/BP2A; wv) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' };

function scenario(title, opts, fn) {
  console.log(`\n${title}`);
  fn(makeEnv({ region: newRegion, ...opts }));
}

scenario('A 手机 Chrome：触摸/竖屏/原生全屏与锁屏都有效 → 保持真转屏', {
  ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: true,
}, (env) => {
  env.init();
  check('预置：useScreenOrientation=true, rotate=false', `${env.plugin.config.useScreenOrientation}/${env.plugin.config.rotateFullscreen}`, 'true/false');
  env.tapFullscreen();
  check('点击后走原生全屏', env.calls.native, 1);
  check('锁屏被调用（真转屏）', env.calls.lock, 1);
  env.runTimers(600);
  check('未降级伪横屏', env.calls.rotate, 0);
});

scenario('B 飞牛 App（UA 含 wv）：直接伪横屏', {
  ...WV, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: false,
}, (env) => {
  env.init();
  check('预置即为伪横屏配置', env.plugin.config.rotateFullscreen, true);
  env.tapFullscreen();
  check('点击进入 rotateFullscreen', env.calls.rotate, 1);
  check('旋转状态类已挂上', env.rootEl.classList.contains('xgplayer-rotate-fullscreen'), true);
  env.runTimers(600);
  check('不重复进入', env.calls.rotate, 1);
});

scenario('C 飞牛 App（自定义 UA 无 wv + 原生全屏被拒）→ 400ms 自愈降级', {
  ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: false, lockWorks: false,
}, (env) => {
  env.init();
  check('预置仍按浏览器口径（无 wv）', env.plugin.config.useScreenOrientation, true);
  env.tapFullscreen();
  check('先试了原生全屏', env.calls.native, 1);
  check('此刻还没转', env.calls.rotate, 0);
  env.runTimers(600);
  check('400ms 后自愈：进入伪横屏', env.calls.rotate, 1);
  check('旋转状态类已挂上', env.rootEl.classList.contains('xgplayer-rotate-fullscreen'), true);
  check('结论粘住 _fsForceRotate', env.sandbox._fsForceRotate, true);

  // C2：退出后再点一次 → 直接伪横屏，不再折腾原生
  env.plugin.exitFullscreen();
  const before = env.calls.native;
  env.tapFullscreen();
  check('第二次点击不再试原生', env.calls.native, before);
  check('第二次点击直接伪横屏', env.calls.rotate, 2);
});

scenario('D 桌面浏览器（无触摸、横向窗口）→ 不转、不自愈', {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  touch: false, portrait: false, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: false,
}, (env) => {
  env.init();
  env.tapFullscreen();
  env.runTimers(600);
  check('未进伪横屏', env.calls.rotate, 0);
});

scenario('E 竖向视频（aspectRatio<1）→ 即便原生失败也不转 90°', {
  ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 0.7, nativeFsWorks: false, lockWorks: false,
}, (env) => {
  env.init();
  env.tapFullscreen();
  env.runTimers(600);
  check('未进伪横屏', env.calls.rotate, 0);
});

console.log('\n──── 反向对照：同一用例 C 用 lc-1328 版载荷（git HEAD）────');
if (!oldRegion) {
  console.log('  SKIP  取不到 git HEAD 载荷（非 git 仓库？）');
} else {
  console.log('C(旧) 飞牛 App（自定义 UA 无 wv + 原生全屏被拒）→ 期望「不转」，即旧版修不了');
  const env = makeEnv({
    region: oldRegion, ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: false, lockWorks: false,
  });
  env.init();
  check('旧版预置：无 wv → 走原生', env.plugin.config.useScreenOrientation, true);
  env.tapFullscreen();
  env.runTimers(600);
  check('旧版：点了全屏仍竖屏（= 用户报障现场）', env.calls.rotate, 0);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
