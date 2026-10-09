// scripts/verify-rotate-css.mjs —— [lc-1329] rotateFullscreen 伪横屏 CSS 几何实测（真实浏览器渲染）
//
// 为什么需要这一步：verify-landscape-fs.mjs 验的是「该不该进伪横屏」的分支逻辑，
// 验不到 CSS —— 而真机第二轮报障恰恰出在 CSS：lc-1328 的 rotate 样式挂在
// `html.fnos-touch-narrow` 上，飞牛 App 是**桌面模式 + 手机屏**，那个类不存在 →
// 样式一条都没命中 → 点了全屏「还是竖屏」。这里用真浏览器把两种作用域都渲染一遍。
//
// 依赖：仓库根 node_modules 里的 playwright（fpk/scripts 向上查找可解析）。
// 用系统 Chromium（无 WebGL/无软渲染），单页单次，跑完即关。
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 从构建产物里取「现行」rotate 规则（保证测的是真产物，不是另抄一份）
const payload = readFileSync(path.join(root, 'dist', 'fntv-plus.user.js'), 'utf8');
const CSS_NEW = [...payload.matchAll(/html:has\(\.xgplayer-rotate-fullscreen\)[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
if (!CSS_NEW.includes('height:100vw')) throw new Error('产物里取不到 rotate 新样式（height:100vw）');

// 还原 lc-1328 的作用域（旧版）：选择器改挂布局标记、且没有 height
const CSS_OLD = CSS_NEW
  .replace(/html:has\(\.xgplayer-rotate-fullscreen\)/g, 'html.fnos-touch-narrow')
  .replace(/^\s*height:100vw !important;\s*$/gm, '');

// 模拟飞牛播放页：容器是竖向的播放器盒子，root 由 getRotateFullscreen 挂类 + 写行内 width=innerHeight
const pageHtml = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#222}
  #parent{width:412px;height:219px;overflow:hidden;background:#333}
  #root{background:#000}
  video{background:#000}
</style>
<style id="s-old">${CSS_OLD}</style>
<style id="s-new">${CSS_NEW}</style>
</head><body>
  <div id="parent"><div id="root" class="xgplayer"><video></video></div></div>
</body></html>`;

const results = [];
const check = (name, got, want, tol = 1.5) => {
  const ok = Math.abs(got - want) <= tol;
  results.push({ name, ok, got, want });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  (got=${got} want=${want})`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
await page.setContent(pageHtml);

const measure = () => page.evaluate(() => {
  const r = document.getElementById('root').getBoundingClientRect();
  const cs = getComputedStyle(document.getElementById('root'));
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pos: cs.position, tf: cs.transform !== 'none' };
});

const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
console.log(`视口 ${viewport.w}×${viewport.h}（竖屏手机）`);

// ── S1：桌面模式 + 手机屏（飞牛 App 现场）—— 只启用新样式
await page.evaluate(() => {
  document.getElementById('s-old').disabled = true;
  document.getElementById('s-new').disabled = false;
  document.documentElement.classList.remove('fnos-touch-narrow');
  const rootEl = document.getElementById('root');
  rootEl.className = 'xgplayer xgplayer-rotate-fullscreen';
  rootEl.style.width = window.innerHeight + 'px';   // getRotateFullscreen 的写法
});
console.log('\nS1 新样式 · 桌面模式（无 fnos-touch-narrow）—— 真机现场');
{
  const m = await measure();
  check('旋转盒铺满视口（x）', m.x, 0);
  check('旋转盒铺满视口（y）', m.y, 0);
  check('旋转盒宽度 = 屏宽', m.w, viewport.w);
  check('旋转盒高度 = 屏高', m.h, viewport.h);
  check('position 为 fixed', m.pos === 'fixed' ? 1 : 0, 1);
}

// ── S2：同一现场，但用 lc-1328 的旧作用域（挂 fnos-touch-narrow）—— 必须不生效（= 用户报障的原因）
await page.evaluate(() => {
  document.getElementById('s-new').disabled = true;
  document.getElementById('s-old').disabled = false;
});
console.log('\nS2 旧样式（挂 html.fnos-touch-narrow）· 桌面模式 —— 期望「样式一条都没命中」');
{
  const m = await measure();
  // 样式没接管 → 元素还是 getRotateFullscreen 写的行内宽度（= innerHeight），不是屏宽
  check('未铺满：宽度仍是行内宽度（=innerHeight，非屏宽）', m.w, viewport.h);
  check('未旋转：无 transform', m.tf ? 1 : 0, 0);
  check('未定位：position 仍是 static', m.pos === 'static' ? 1 : 0, 1);
}

// ── S3：旧样式 + 手机模式（有 fnos-touch-narrow）—— 证明「旧版在手机模式下能转，但缺 height」
await page.evaluate(() => {
  document.documentElement.classList.add('fnos-touch-narrow');
});
console.log('\nS3 旧样式 · 手机模式（有标记）—— 旧版能转但缺 height 会出问题');
{
  const m = await measure();
  check('位置生效（fixed）', m.pos === 'fixed' ? 1 : 0, 1);
  check('旋转生效（有 transform）', m.tf ? 1 : 0, 1);
  check('高度未铺满视口（缺 height:100vw，= 一条窄带）', m.h < viewport.h - 5 ? 1 : 0, 1);
}

// ── S4：新样式 + 祖先带 transform（containing block 陷阱）—— 记录降级表现，不作硬断言
await page.evaluate(() => {
  document.documentElement.classList.remove('fnos-touch-narrow');
  document.getElementById('s-old').disabled = true;
  document.getElementById('s-new').disabled = false;
  document.getElementById('parent').style.transform = 'translateZ(0)';
});
console.log('\nS4 新样式 · 祖先有 transform（filter/transform 会构成 containing block）—— 记录用');
{
  const m = await measure();
  console.log(`  记录：rect=(${m.x},${m.y},${m.w}×${m.h})；视口 ${viewport.w}×${viewport.h}` +
    (m.w === viewport.w && m.h === viewport.h ? '（仍铺满）' : '（未铺满 → 位置相对该祖先，属已知降级）'));
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
