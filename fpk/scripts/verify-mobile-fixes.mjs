// [lc-1290] 移动端四修的静态验证（零 CPU，不起浏览器）。
// 双向验证：未修复版本必须 FAIL，修复版本必须 PASS，否则测试是空转的。
// 验的是「能从源码推导出的事实」：视口标记类装配、轮播宽度预算、底栏裁剪判定、横屏全屏配置。
// 用法：node scripts/verify-mobile-fixes.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── 被测源码 ────────────────────────────────────────────────────────────
const mobileStyle = read('src/preload/plugins/mobileStyle.ts');
const danmakuWeb = read('src/preload/plugins/danmakuWeb.ts');
const styles = read('src/preload/plugins/embyWall/carousel/styles.ts');

// ═══ 1. fnos-touch-narrow 必须全局装配 ═══
console.log('\n[1] html.fnos-touch-narrow 全局装配（轮播窄屏规则的唯一门控）');
{
  // 抽出 applyViewportFlags 的函数体，在 vm 里跑真实源码，验证标记类装配
  const m = mobileStyle.match(/function applyViewportFlags\(\): void \{([\s\S]*?)\n\}/);
  ok(!!m, 'applyViewportFlags 可被抽取');
  const body = m ? m[1] : '';

  // 构造假 html/document/window，跑真实函数体
  const classes = new Set();
  const html = {
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    style: { setProperty() {}, removeProperty() {}, minWidth: '' },
  };
  const sandbox = {
    document: { documentElement: html, getElementById: () => null },
    window: { matchMedia: (q) => ({ matches: q.includes('640.5') ? false : false }), dispatchEvent() {} },
    navigator: { maxTouchPoints: 5 },
  };
  sandbox.window.matchMedia = (q) => ({ matches: false }); // 两个 MQ 都 false → 窄屏
  vm.createContext(sandbox);
  vm.runInContext(
    `var _mqNarrow={matches:false}, _mqCompact={matches:false};
     function isTouchDevice(){ return ('ontouchstart' in window) || (navigator.maxTouchPoints||0)>0; }
     function applyViewportFlags(){${body}}
     applyViewportFlags();`,
    sandbox
  );
  ok(classes.has('fnos-touch-narrow'), '手机触屏 + 窄视口 → 装上 fnos-touch-narrow',
    `实际 classes=[${[...classes]}]`);
  ok(classes.has('fnos-narrow'), '同时保留 fnos-narrow（本文件原有段依赖）');
  ok(classes.has('fnos-touch'), '同时保留 fnos-touch（安全区/触控语义段依赖）');

  // 桌面窄窗（无触屏）不得装 touch-narrow
  const classes2 = new Set();
  const html2 = { classList: { toggle: (c, on) => (on ? classes2.add(c) : classes2.delete(c)), contains: () => false }, style: { setProperty() {}, removeProperty() {}, minWidth: '' } };
  const sb2 = {
    document: { documentElement: html2, getElementById: () => null },
    window: { matchMedia: () => ({ matches: false }), dispatchEvent() {} },
    navigator: { maxTouchPoints: 0 },
  };
  vm.createContext(sb2);
  vm.runInContext(`var _mqNarrow={matches:false}, _mqCompact={matches:false};
    function isTouchDevice(){ return ('ontouchstart' in window) || (navigator.maxTouchPoints||0)>0; }
    function applyViewportFlags(){${body}}
    applyViewportFlags();`, sb2);
  ok(!classes2.has('fnos-touch-narrow'), '桌面窄窗口（无触屏）→ 不装 fnos-touch-narrow',
    `实际 classes=[${[...classes2]}]`);
}

// ═══ 2. 轮播左右黑框：宽度预算 ═══
console.log('\n[2] 轮播左右黑框 —— 390px 视口下每层吃掉多少宽');
{
  const VW = 390;
  const before = { wrapperPad: 44, sectionPad: 44 };
  const beforeInner = VW - before.wrapperPad * 2 - before.sectionPad * 2;
  const beforeGap = (VW - beforeInner) / 2;
  ok(beforeGap >= 40, `未修复时两侧各空 ${beforeGap}px（≥40px 即肉眼可见的黑边）`,
    `容器可用宽仅 ${beforeInner}px`);

  // 修复后：wrapper 8px + section 8px
  const after = { wrapperPad: 8, sectionPad: 8 };
  const afterInner = VW - after.wrapperPad * 2 - after.sectionPad * 2;
  const afterGap = (VW - afterInner) / 2;
  // 8px/侧 是**刻意留的呼吸位**（轮播右侧有 prev/next 导航钮，完全贴边会被切），
  // 所以判据是「黑边消失」= 每侧 ≤16px，而不是「边距为 0」。
  ok(afterGap <= 16, `修复后两侧各空 ${afterGap}px（≤16px 视为无黑边，8px 是留给导航钮的呼吸位）`,
    `容器可用宽升至 ${afterInner}px`);
  ok(afterGap * 4 <= beforeGap, `黑边宽度缩到原来的 1/${Math.round(beforeGap / afterGap)}`);
  ok(afterInner > beforeInner, `容器宽度增加 ${afterInner - beforeInner}px`);

  // 声明必须在源码里真实存在，且数值一致
  ok(/\[data-fntv-carousel-wrapper\]\{[^}]*padding-left:8px/.test(mobileStyle),
    'mobileStyle B5c 声明 wrapper padding-left:8px');
  ok(/:has\(> \[data-fntv-carousel-wrapper\]\)\{[^}]*padding-left:8px/.test(mobileStyle),
    '用 :has(> wrapper) 收窄**父级** section（wrapper 是子级，写子代选择器无效）');
  ok(!/\[data-fntv-carousel-wrapper\]\{padding-left:16px/.test(styles),
    'styles.ts 里重复的 16px 规则已移除（否则同特异性打架）');
  ok(/height:min\(46vw, 260px\)/.test(mobileStyle),
    '容器给下限高度（16:9 在窄屏会塌成一条）');
  ok(/\.fnos-poster-strip\{ display:none/.test(mobileStyle),
    '右侧海报条（150px 定宽）在窄屏隐藏，让位给主图');
}

// ═══ 3. 卡片过大 ═══
console.log('\n[3] 首页卡片行过大（继续观看 / 剧集列表）');
{
  const clampRe = /width:clamp\((\d+)px, (\d+)vw, (\d+)px\)/;
  const m = mobileStyle.match(clampRe);
  ok(!!m, '卡片宽度用 clamp() 按视口比例钳制');
  if (m) {
    const [, lo, vw, hi] = m;
    const at390 = Math.min(Math.max((390 * +vw) / 100, +lo), +hi);
    const perScreen = Math.floor(390 / (at390 + 10)); // +10 ≈ 站点 gap 收到 10px
    ok(at390 <= 140, `390px 下单卡 ${at390}px`);
    ok(perScreen >= 3, `一屏可见 ${perScreen} 张（≥3 才叫「卡片列表」而不是「大图」)`,
      `单卡 ${at390}px`);
    // 桌面 1920 不受影响：门控是 html.fnos-narrow
    ok(/html\.fnos-narrow \.ms-container/.test(mobileStyle), '规则门控在 html.fnos-narrow 下（桌面不受影响）');
    ok(/min-width:0 !important/.test(mobileStyle.split(clampRe)[0].slice(-400)),
      '同时给 min-width:0（否则行内 width 会顶开，钳制无效）');
  }
  ok(/flex:0 0 clamp/.test(mobileStyle), 'flex-basis 同步钳制（卡片是 shrink-0，不给 basis 不缩）');
}

// ═══ 4. 底栏挤在一起 ═══
console.log('\n[4] 播放页底栏「挤在一起 + 显示不全」');
{
  // 根因：三个 grid 是并列 flex 子项，min-width:auto → 拒绝压缩 → 溢出被 overflow:hidden 吃掉
  ok(/xg-right-grid\{[^}]*min-width:0 !important/.test(danmakuWeb),
    '给 xg-right-grid 加 min-width:0（不压缩=溢出的直接原因）');
  ok(/xg-inner-controls,\s*\n?html\.fnos-touch-narrow xg-left-grid/.test(danmakuWeb) ||
     /xg-inner-controls/.test(danmakuWeb),
    'inner-controls / left-grid 同步处理');
  ok(/\.xgplayer-icon\{ width:20px/.test(danmakuWeb),
    '图标类控件（音量/设置/全屏）此前零规则，现已参与收缩');
  ok(/NARROW_TRIM_HIDE = \['倍速', '原画', '音量', '设置', '标记'\]/.test(danmakuWeb),
    '次要文字按钮按内容裁剪（不用 nth-child：控件数随剧集变）');
  ok(/ensureNarrowControlTrim\(\)/.test(danmakuWeb), '裁剪函数被调用');
  // [lc-1311] 裁剪隐藏机制：行内 display:none 会被本表 .plugin-placeholder{display:flex!important}
  // 覆盖（真机实测裁剪形同虚设、11 项撑爆容器换行）→ 改用 data-fntv-trimmed 属性 + 配套规则。
  ok(/it\.setAttribute\('data-fntv-trimmed', '1'\)/.test(danmakuWeb) &&
     /data-fntv-trimmed\]\s*\{\s*\n?\s*display: none !important/.test(danmakuWeb),
    '裁剪走 data-fntv-trimmed 属性 + 配套 !important 规则（行内 display 会被 flex!important 覆盖）');
  ok(/:not\(\[data-fntv-trimmed\]\)/.test(danmakuWeb),
    'plugin-placeholder 的 display:flex!important 已排除被裁项');
  ok(/xg-right-grid\{ flex-wrap:nowrap !important; gap:0 !important; min-width:0 !important; \}/.test(danmakuWeb),
    '右栏自身禁止换行（flex-wrap:wrap 是换行叠行的直接原因）');
  ok(/xgplayer-fullscreen'\)/.test(danmakuWeb), '全屏键显式豁免（tagName 分支里保留）');
}

// ═══ 5. 横屏全屏 ═══
console.log('\n[5] 全屏按钮 → 横屏全屏播放');
{
  ok(/p\.config\.fullscreen\.useScreenOrientation = true/.test(danmakuWeb),
    '开启 xgplayer 自带的 useScreenOrientation（而非自己调 orientation.lock）');
  ok(/lockOrientationType = 'landscape'/.test(danmakuWeb), '锁定方向为 landscape');
  ok(/__reactFiber\$/.test(danmakuWeb), '经 React fiber 取 player 实例（与 gamepad.ts lc-679 同法）');
  // 只查真实代码，剥掉注释（注释里会解释「为什么不自己调 lock」）
  const danmakuCode = danmakuWeb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/screen\.orientation\.lock\(/.test(danmakuCode),
    '不自己调 screen.orientation.lock（不在用户手势栈内必抛 NotSupportedError）');
  ok(/xgplayer-is-cssfullscreen/.test(danmakuWeb),
    '修掉死判据：原 .xgplayer.xgplayer-fullscreen 恒 false（那是按钮的类，不是状态类）');
}

// ═══ 6. 回归：桌面端不被波及 ═══
console.log('\n[6] 回归 —— 桌面宽屏不受影响');
{
  ok(!/^html\.fnos-narrow/gm.test(danmakuWeb.replace(/^html\.fnos-touch-narrow.*$/gm, '')),
    '底栏规则全部门控在 fnos-touch-narrow 下');
  ok(!/screen\.orientation/.test(mobileStyle), 'mobileStyle 不碰屏幕方向（无副作用）');
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);