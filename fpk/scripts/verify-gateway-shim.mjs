// scripts/verify-gateway-shim.mjs —— [lc-1333] 网关路径翻译 shim 的双向验证（零 CPU）
//
// 背景（真机 MuMu 复现）：飞牛 App 里点开 Fntv-Plus 走的是网关地址
// /app/fntvplus/v/*；shim 启动时把地址剥成 /v/*（SPA 路由 basename 写死 /v），
// 原实现要等 `#root` **渲染出子节点**才把地址翻回网关前缀。弱网 / 公网中转下
// `#root` 会长时间空白（实测首帧 6s+，登录授权回来那次是空渲染）→ 地址栏停在
// 原生 /v/*，用户一刷新（或 App 菜单的「刷新页面」）就跳出增强、页面变回原生样式
// ——「有时候还是以前的样式」。同一类漏口还有硬导航：<a href="/v/..."> 与
// location.assign/replace 都不经 pushState 包装。
//
// 本脚本把 inject.go 里的 gatewayShimJS（**真产物**，不另抄）放进 vm 里跑，
// 用假 location/history/document 观察它把地址译成了什么：
//   A 启动剥前缀（原有行为，必须保持）
//   B pushState/replaceState 回填前缀（原有行为）
//   C 宽限期内空 #root 不回填（不能过早翻，免得 SPA 启动期读到带前缀的路径）
//   D 宽限期后空 #root 必须回填（lc-1333 修的正是这条）
//   E location.assign / replace 加前缀（新增）
//   F <a href="/v/..."> 点击被拦下并改走网关地址（新增）
//   G 跨域地址不动（不误改）
// 反向对照：用 lc-1333 之前的修订跑同一套断言 → D/E/F 必须 FAIL。
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src/go/internal/inject/inject.go');

/** 从 inject.go 里取出 gatewayShimJS 的原始字符串内容 */
function extractShim(goSrc) {
  const i = goSrc.indexOf('const gatewayShimJS = `');
  if (i < 0) throw new Error('找不到 gatewayShimJS');
  const start = goSrc.indexOf('`', i) + 1;
  const end = goSrc.indexOf('`', start);
  return goSrc.slice(start, end);
}

const shimNew = extractShim(readFileSync(SRC, 'utf8'));
const shimOld = (() => {
  try {
    const rev = execFileSync('git', ['log', '--format=%H', '--grep=^lc-1332', '-1'], { cwd: root })
      .toString('utf8').trim().split('\n')[0];
    if (!rev) return null;
    return extractShim(execFileSync('git', ['show', `${rev}:fpk/src/go/internal/inject/inject.go`], { cwd: root }).toString('utf8'));
  } catch { return null; }
})();

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`}`);
};

/** 搭一个最小仿真环境跑 shim */
function runShim(shim, { bootHref, rootChildren = 0, startTime = 1000 }) {
  const NAV = [];                          // 记录所有导航目标（assign/replace 的最终 url）
  const RS = [];                           // 记录 replaceState 的 url（地址栏翻译）
  let now = startTime;

  class FakeLocation {
    constructor(href) { this._href = href; }
    get href() { return this._href; }
    set href(_v) { throw new Error('location.href 是 [LegacyUnforgeable]，不可拦截（仿真一致）'); }
    get origin() { return new URL(this._href).origin; }
    get pathname() { return new URL(this._href).pathname; }
    get search() { return new URL(this._href).search; }
    get hash() { return new URL(this._href).hash; }
    assign(u) { const abs = new URL(String(u), this._href).href; NAV.push(abs); this._href = abs; }
    replace(u) { const abs = new URL(String(u), this._href).href; NAV.push(abs); this._href = abs; }
  }
  const location = new FakeLocation(bootHref);

  const history = {
    state: { k: 1 },
    pushState(_s, _t, u) { if (u != null) RS.push(new URL(String(u), location.href).href); },
    replaceState(_s, _t, u) { if (u != null) { RS.push(new URL(String(u), location.href).href); location._href = new URL(String(u), location.href).href; } },
  };

  const listeners = [];
  const rootEl = { childElementCount: rootChildren };
  const document = {
    documentElement: { classList: { contains: () => false } },
    getElementById: (id) => (id === 'root' ? rootEl : null),
    addEventListener: (t, fn, cap) => listeners.push({ t, fn, cap }),
  };

  const timers = [];
  const sandbox = {
    location, history, document, URL,
    Location: FakeLocation,                       // 让 shim 的 Location.prototype 包装有对象可包
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16; wv)' },
    console: { log() {}, warn() {} },
    Date: { now: () => now },                     // 可控时钟（宽限期判定读 Date.now）
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + (ms || 0), every: ms || 0 }); return timers.length; },
    clearInterval: () => {}, clearTimeout: () => {},
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
    URLSearchParams, JSON, Object, Array, String, Number, Math, Error, RegExp, Promise,
  };
  // shim 会调 window.addEventListener（popstate 等）
  const winListeners = [];
  sandbox.addEventListener = (t, fn) => winListeners.push({ t, fn });
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shim, sandbox, { filename: 'gatewayShim.js' });

  const advance = (ms) => {                          // 推进假时钟并跑到期定时器
    const until = now + ms;
    for (let g = 0; g < 200; g++) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.fn();
      if (due.every) { timers.splice(timers.indexOf(due), 1); timers.push({ fn: due.fn, at: now + due.every, every: due.every }); }
      else timers.splice(timers.indexOf(due), 1);
    }
    now = until;
  };
  const clickAnchor = (href) => {
    const a = { getAttribute: () => href, target: '' };
    const el = { closest: () => a };
    let prevented = false;
    const ev = { target: el, preventDefault: () => { prevented = true; } };
    listeners.filter((l) => l.t === 'click' && l.cap).forEach((l) => l.fn(ev));
    return prevented;
  };
  const last = (arr) => arr[arr.length - 1];
  return { NAV, RS, sandbox, location, advance, clickAnchor, last, winListeners, now: () => now };
}

const BASE = 'https://nas.local:15555';
const GW = BASE + '/app/fntvplus/v/video/abc';
const NATIVE = BASE + '/v/video/abc';

function suite(label, shim) {
  console.log(`\n──── ${label} ────`);
  if (!shim) { console.log('  SKIP  取不到该修订的 shim'); return; }

  // A 启动剥前缀
  {
    const e = runShim(shim, { bootHref: GW });
    check('A 启动即把网关前缀剥掉（SPA 路由才能匹配）', e.location.pathname, '/v/video/abc');
  }
  // B pushState 回填前缀
  {
    const e = runShim(shim, { bootHref: NATIVE, rootChildren: 3 });
    e.sandbox.history.pushState({}, '', '/v/tv/xyz');
    check('B pushState 推入的原生路径被加回网关前缀', e.last(e.RS), BASE + '/app/fntvplus/v/tv/xyz');
  }
  // C 宽限期内、#root 空 → 不翻（避免 SPA 启动期读到带前缀路径）
  {
    const e = runShim(shim, { bootHref: NATIVE, rootChildren: 0 });
    e.advance(300);
    check('C 宽限期内空 #root 不回填', e.RS.length, 0);
  }
  // D 宽限期后、#root 仍空 → 必须回填（lc-1333 修的就是这条）
  {
    const e = runShim(shim, { bootHref: NATIVE, rootChildren: 0 });
    e.advance(2500);
    check('D 宽限期后即便 #root 空也回填（防刷新跳出增强）', e.last(e.RS), BASE + '/app/fntvplus/v/video/abc');
  }
  // E location.assign / replace 被加前缀
  {
    const e = runShim(shim, { bootHref: GW, rootChildren: 3 });
    e.sandbox.location.assign('/v/movie/def');
    check('E1 location.assign 的原生路径被加前缀', e.last(e.NAV), BASE + '/app/fntvplus/v/movie/def');
    e.sandbox.location.replace('/v/tv/ghi');
    check('E2 location.replace 的原生路径被加前缀', e.last(e.NAV), BASE + '/app/fntvplus/v/tv/ghi');
  }
  // F <a href> 硬导航被拦并改走网关
  {
    const e = runShim(shim, { bootHref: GW, rootChildren: 3 });
    const prevented = e.clickAnchor('/v/video/zzz');
    check('F1 原生链接点击被 preventDefault', prevented, true);
    check('F2 改走网关地址', e.last(e.NAV), BASE + '/app/fntvplus/v/video/zzz');
  }
  // G 跨域 / 已是网关地址 / 非影视路径 → 不动
  {
    const e = runShim(shim, { bootHref: GW, rootChildren: 3 });
    const prevented = e.clickAnchor('https://example.com/v/x');
    check('G1 跨域链接不拦不改', `${prevented}|${e.NAV.length}`, 'false|0');
    e.sandbox.location.assign(BASE + '/app/fntvplus/v/movie/keep');
    check('G2 已是网关地址原样放行（不重复加前缀）', e.last(e.NAV), BASE + '/app/fntvplus/v/movie/keep');
  }
}

suite('正向：当前 shim（含 lc-1333 修复）', shimNew);
suite('反向对照：lc-1332 版 shim（修复前）→ D/E/F 必须 FAIL', shimOld);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);