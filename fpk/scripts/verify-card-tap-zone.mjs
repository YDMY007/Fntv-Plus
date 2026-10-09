// scripts/verify-card-tap-zone.mjs —— [lc-1331] 卡片浮层圆钮「命中区收窄」功能验证
//
// 为什么要真浏览器：这一版改的是**事件命中（hit-testing）**——「点在外壳 padding 区
// 是否会穿透到下面的播放遮罩」。这只有真实合成布局 + 真实事件分派才验得了：
// 假 DOM 里 getBoundingClientRect 全是 0，穿透与否根本不可观测。
//
// 手法沿用仓库既有约定：被测代码从**已构建产物**里切出来（不另抄一份），
// 并在**同一个页面**里做双向对照：
//   A 未执行 apply()：点外壳 padding 区 → 期望「误触圆钮」（复现用户报障）
//   B 执行 apply() 后：同一点 → 期望「穿透到播放遮罩」（修复生效）
//   C 点在图标上 → 期望圆钮自己的功能照旧触发（不能把按钮弄坏）
//   D 居中播放圆钮 → 命中区不被收窄
// 只有 A 复现、B/C/D 通过，才说明「修的是那个问题、且没修坏别的」。
//
// 依赖：仓库根 node_modules 的 playwright（单页静态，无 WebGL）。
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payload = readFileSync(path.join(root, 'dist', 'fntv-plus.user.js'), 'utf8');

/** 从产物切出 cardTapZone 那段（const CARD_SEL ... 到 registerHook 之前） */
function extractRegion(src) {
  const start = src.indexOf("var CARD_SEL = '.ms-container [class*=\"card-root\"]'");
  if (start < 0) throw new Error('产物里找不到 CARD_SEL 起点');
  const end = src.indexOf('registerHook(', start);
  if (end < 0) throw new Error('产物里找不到 registerHook 终点');
  return src.slice(start, end);
}
const region = extractRegion(payload);

// 卡片页：遮罩(整卡) + 居中播放圆钮 + 下缘两个 44px 外壳包 18px 图形
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#111}
  .ms-container{width:360px}
  .continue-card-root{position:relative;width:160px;height:90px;background:#333;overflow:hidden}
  .mask{position:absolute;inset:0}
  .playbtn{position:absolute;left:50%;top:50%;width:47px;height:47px;margin:-23.5px 0 0 -23.5px;
           border-radius:50%;background:rgba(255,255,255,.2)}
  .actwrap{position:absolute;bottom:0;width:44px;height:44px;display:flex;align-items:center;justify-content:center}
  .actwrap.l{left:0}
  .actwrap.r{right:0}
  .actwrap svg{width:18px;height:18px;display:block}
</style></head><body>
<div class="ms-container">
  <div class="continue-card-root">
    <div class="mask"></div>
    <div class="playbtn"><svg viewBox="0 0 18 18"><path d="M3 2l12 7-12 7z"/></svg></div>
    <div class="actwrap l"><svg viewBox="0 0 24 24"><path d="M2 12h20"/></svg></div>
    <div class="actwrap r"><svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg></div>
  </div>
</div>
</body></html>`;

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
await page.setContent(pageHtml);

// 计数桩 + 被测代码（把 log 补上；产物里 logger 名字可能被改名，统一用 log）
await page.evaluate(() => {
  window.__hits = { mask: 0, actL: 0, actR: 0, play: 0 };
  document.querySelector('.mask').addEventListener('click', () => window.__hits.mask++);
  document.querySelector('.actwrap.l').addEventListener('click', () => window.__hits.actL++);
  document.querySelector('.actwrap.r').addEventListener('click', () => window.__hits.actR++);
  document.querySelector('.playbtn').addEventListener('click', () => window.__hits.play++);
  document.documentElement.classList.add('fnos-touch');   // 插件只在触摸设备上跑
});
// 产物里的 logger 会被 esbuild 改名（log → log5 之类），按「谁在被当 logger 用」自动补桩
const loggerNames = [...new Set([...region.matchAll(/\b(log\d*)\s*\.\s*(?:info|warn|error)\s*\(/g)].map((m) => m[1]))];
const prelude = loggerNames.map((n) => `var ${n} = { info(){}, warn(){}, error(){} };`).join('\n') + '\n';
await page.addScriptTag({ content: prelude + region });

// 关键取点：外壳中心（= 图形中心）与「外壳 padding 区」（图形右侧 14px，仍在 44px 外壳内）
const pts = await page.evaluate(() => {
  const g = (s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, right: r.right, top: r.top, bottom: r.bottom, w: r.width };
  };
  const wrap = g('.actwrap.l');
  return {
    iconL: { x: Math.round(wrap.cx), y: Math.round(wrap.cy) },
    padL: { x: Math.round(wrap.right - 7), y: Math.round(wrap.cy) },   // 外壳内、图形外
    padR: (() => { const r = g('.actwrap.r'); return { x: Math.round(r.right - 7), y: Math.round(r.cy) }; })(),
    play: (() => { const r = g('.playbtn'); return { x: Math.round(r.cx), y: Math.round(r.cy) }; })(),
  };
});

const hit = async (p) => {
  await page.evaluate(() => { window.__hits = { mask: 0, actL: 0, actR: 0, play: 0 }; });
  await page.mouse.click(p.x, p.y);
  return page.evaluate(() => window.__hits);
};

console.log('\nA 未打补丁：点外壳 padding 区（图形外、外壳内）→ 期望误触圆钮（复现报障）');
{
  const h = await hit(pts.padL);
  check('外壳左钮被误触', h.actL, 1);
  check('播放遮罩未被触发', h.mask, 0);
}

console.log('\nB 执行 apply() 后：同一点 → 期望穿透到播放遮罩（修复生效）');
await page.evaluate(() => window.apply());
{
  const h = await hit(pts.padL);
  check('播放遮罩被触发', h.mask, 1);
  check('外壳左钮不再被误触', h.actL, 0);
  const h2 = await hit(pts.padR);
  check('右钮 padding 区同样穿透', h2.mask, 1);
  check('右钮未被误触', h2.actR, 0);
}

console.log('\nC 点在图标上 → 圆钮自身功能必须照旧');
{
  const h = await hit(pts.iconL);
  check('左钮功能照旧触发', h.actL, 1);
  check('未误触发播放', h.mask, 0);
}

console.log('\nD 居中播放圆钮 / 整卡遮罩 命中区不受影响');
{
  const h = await hit(pts.play);
  check('播放圆钮仍可点（命中它自己或遮罩）', h.play + h.mask, 1);
  const pe = await page.evaluate(() => ({
    play: getComputedStyle(document.querySelector('.playbtn')).pointerEvents,
    mask: getComputedStyle(document.querySelector('.mask')).pointerEvents,
    wrap: getComputedStyle(document.querySelector('.actwrap.l')).pointerEvents,
    icon: getComputedStyle(document.querySelector('.actwrap.l svg')).pointerEvents,
  }));
  check('播放圆钮未被收窄', pe.play, 'auto');
  check('遮罩仍是命中目标', pe.mask, 'auto');
  check('左钮外壳已关掉命中', pe.wrap, 'none');
  check('左钮图形保留命中', pe.icon, 'auto');
}

console.log('\nE 非触摸设备（无 fnos-touch）不介入');
await page.evaluate(() => {
  document.documentElement.classList.remove('fnos-touch');
  document.querySelectorAll('.continue-card-root').forEach((c) => c.removeAttribute('data-fntv-tapfix'));
  document.querySelector('.actwrap.l').style.pointerEvents = '';
  document.querySelector('.actwrap.l svg').style.pointerEvents = '';
});
await page.evaluate(() => window.apply());
{
  const pe = await page.evaluate(() => getComputedStyle(document.querySelector('.actwrap.l')).pointerEvents);
  check('桌面（无触摸标记）不动命中区', pe, 'auto');
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);