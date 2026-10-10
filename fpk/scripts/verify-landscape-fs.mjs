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
import { execSync, execFileSync } from 'child_process';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_PAYLOAD = path.join(root, 'dist', 'fntv-plus.user.js');

/** 从构建产物里切出被测代码：伪横屏模块（lc-1334）+ 全屏模块（lc-1329）。
 *  两者相邻可寻（伪横屏模块以 var ROT_CLASS 开头，全屏模块到 function bindVideoFullscreenFix 结束）。 */
function extractRegion(text, startMarks = [
  'var ROT_CLASS = "xgplayer-rotate-fullscreen";',
  'var _landscapeBound = false;',
  'let _landscapeBound = false;',
]) {
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
    const rev = execFileSync('git', ['log', '--format=%H', '--grep=^lc-1328', '-1'], { cwd: root })
      .toString('utf8').trim().split('\n')[0];
    if (!rev) return null;
    console.log(`反向对照版本：${rev.slice(0, 7)}（lc-1328，横屏修复前）`);
    return execSync(`git show ${rev}:fpk/src/go/internal/inject/payload/fntv-plus.user.js`, {
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
    _attrs: {},
    style: { width: '', height: '' },
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    },
  };
  rootEl['__reactFiber$test'] = null;

  const fakeVideo = { closest: () => rootEl };
  const canvasEl = {
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  };
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
      if (sel === '[class*=xgplayer]' || sel === '.xgplayer') return rootEl;
      if (sel === 'video') return fakeVideo;
      if (sel === '.xgplayer-rotate-fullscreen') return rootEl.classList.contains('xgplayer-rotate-fullscreen') ? rootEl : null;
      if (sel === '[data-fntv-pseudo-rot="1"]') return rootEl.getAttribute('data-fntv-pseudo-rot') === '1' ? rootEl : null;
      return null;
    },
    getElementById(id) { return id === 'fntv-danmaku-canvas' ? canvasEl : null; },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener() {},
    fullscreenElement: null,
  };

  const sandbox = {
    window: win, document: doc, registerHook: () => {}, HookType: { OnReady: 'onReady', OnDomChange: 'onDomChange' },
    navigator: { userAgent: ua, maxTouchPoints: touch ? 5 : 0 },
    log: { info() {}, warn() {} },
    // esbuild 把 logger 模块初始化拆成 helper（init_logger/logger_default），补桩
    init_logger: () => {},
    logger_default: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
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

  /** 真实点击全屏按钮：document 捕获阶段 → （未被 stopPropagation 拦下才跑）target 上的 xgplayer handler */
  const tapFullscreen = () => {
    const ev = {
      target: fsIcon, type: 'touchend', prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    for (const l of listeners.filter((x) => x.capture)) {
      l.fn(ev);
      if (ev.stopped) return ev;                 // 目标上的处理器不会再跑（原生全屏/插件 rotate 都不进）
    }
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
    return ev;
  };

  return { calls, init, tapFullscreen, runTimers, plugin, player, sandbox, win, rootEl, canvasEl, htmlClasses: rootEl.classList, listeners };
}

// ────────────────────────── 跑用例 ──────────────────────────
const newRegion = extractRegion(readFileSync(NEW_PAYLOAD, 'utf8'));
const oldRegion = OLD_PAYLOAD ? extractRegion(OLD_PAYLOAD) : null;

// ─────────── 用例（lc-1334：改为「我们自己转」）───────────
const BASE = { ua: 'Mozilla/5.0 (Linux; Android 16; PLT140) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' };
const WV = { ua: 'Mozilla/5.0 (Linux; Android 16; PLT140 Build/BP2A; wv) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' };

function scenario(title, opts, fn) {
  console.log(`
${title}`);
  fn(makeEnv({ region: newRegion, ...opts }));
}

const ROT = 'xgplayer-rotate-fullscreen';
const CSS_LOCK = 'fntv-pseudo-rot';

scenario('A 触摸 + 竖屏 + 横向内容（手机浏览器 / 飞牛 App 都算这一类）→ 点击由我们自己转', {
  ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: true,
}, (env) => {
  env.init();
  const ev = env.tapFullscreen();
  check('A1 拦下按钮自身的处理器（preventDefault）', ev.prevented, true);
  check('A2 阻断冒泡（stopPropagation → 原生全屏不进）', ev.stopped, true);
  check('A3 未走原生全屏', env.calls.native, 0);
  check('A4 播放器根节点挂上旋转类', env.rootEl.classList.contains(ROT), true);
  check('A5 行内宽按 xgplayer 口径 = innerHeight', env.rootEl.style.width, '915px');
  check('A6 弹幕画布同步旋转', env.canvasEl.classList.contains('fntv-dm-rotate'), true);
  check('A7 html 门控类（锁滚动）', env.htmlClasses.contains(CSS_LOCK), true);

  // 再点一次 = 退出
  const ev2 = env.tapFullscreen();
  check('A8 二次点击退出旋转类', env.rootEl.classList.contains(ROT), false);
  check('A9 行内尺寸已还原', `${env.rootEl.style.width}|${env.rootEl.style.height}`, '|');
  check('A10 画布还原', env.canvasEl.classList.contains('fntv-dm-rotate'), false);
  check('A11 两次点击都被拦（不进原生）', `${ev2.prevented}/${env.calls.native}`, 'true/0');
});

scenario('B 桌面（无触摸）→ 不拦不转，仍走原分派', {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  touch: false, portrait: false, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: false,
}, (env) => {
  env.init();
  const ev = env.tapFullscreen();
  check('B1 未拦（鼠标环境交回原生）', ev.prevented, false);
  check('B2 未进自建旋转', env.rootEl.classList.contains(ROT), false);
  check('B3 走原生全屏', env.calls.native, 1);
});

scenario('C 竖向内容（aspectRatio<1）→ 不转 90°', {
  ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 0.7, nativeFsWorks: true, lockWorks: false,
}, (env) => {
  env.init();
  const ev = env.tapFullscreen();
  check('C1 未拦', ev.prevented, false);
  check('C2 未旋转', env.rootEl.classList.contains(ROT), false);
});

console.log('\n──── 反向对照：lc-1333 版载荷（无伪横屏模块）→ A 组必须不成立 ────');
if (!oldRegion) {
  console.log('  SKIP  取不到 lc-1333 版载荷');
} else {
  const env = makeEnv({ region: oldRegion, ...BASE, touch: true, portrait: true, fullscreenEnabled: true, aspect: 16 / 9, nativeFsWorks: true, lockWorks: true });
  env.init();
  const ev = env.tapFullscreen();
  check('旧版：点击不会被我们拦住（没有自建旋转）', ev.prevented, false);
  check('旧版：根节点没有旋转类（真机现象：进了原生全屏但不转）', env.rootEl.classList.contains(ROT), false);
}

const failed = results.filter((r) => !r.ok);
console.log(`
${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
