// dev/verify_season_nav.mjs — [v1.10.3] 一级详情页季选行「左右切换圆钮」验证。
// 复刻 Series 一级页最小结构（活跃视图 + Series hero + 内容面板 + 季行 6 卡）注入
// dist/fntv-plus.user.js 后断言：
//   ① 6 季溢出 → 圆钮对自动挂载（#fnos-season-nav 两枚按钮）
//   ② 初态：左钮到端禁用（data-end=1）、右钮可用；钮中线对准第一张海报竖版中线
//   ③ 点右钮 → 季行步进横滑一张卡宽；滑到最右后右钮 data-end=1
//   ④ 点左钮 → 退回；≤4 季对照页 → 不挂钮（不溢出）
//   ⑤ React 重建季行（换新节点）→ 面板 observer 去抖后钮重挂到新行后且点击仍生效
//   ⑥ 季行被删 → 钮自动摘除（守卫收敛）
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function replicaHtml(seasonCount) {
  const card = (i) => `
    <div class="card-root group box-border inline-block" data-id="details">
      <div class="relative mb-2 rounded-lg overflow-hidden">
        <div class="poster-box relative overflow-hidden" style="border-radius:8px">
          <div class="absolute" style="inset:0;background:linear-gradient(135deg,#3a4a63,#586a88)"></div>
        </div>
      </div>
      <a class="flex flex-col items-center" style="text-decoration:none;color:#fff">
        <p class="m-0">第 ${i} 季</p><p class="m-0">2024 · ${i + 6} 集</p>
      </a>
    </div>`;
  const cards = Array.from({ length: seasonCount }, (_, i) => card(i + 1)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#101319;font-family:system-ui;color:#fff}
  .relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.overflow-hidden{overflow:hidden}
  .flex{display:flex}.flex-col{flex-direction:column}.items-center{align-items:center}
  .w-full{width:100%}.gap-3{gap:12px}.box-border{box-sizing:border-box}
  .inline-block{display:inline-block}
  .gap-x-5{column-gap:20px}.gap-y-7{row-gap:28px}
  .mb-2{margin-bottom:8px}
  .rounded-lg{border-radius:8px}
  .card-root{width:128px}
  .mb-\\[46px\\]{margin-bottom:46px}
  .trim-ui__cache-outlet--exclude{display:block}
  .m-0{margin:0}
  </style></head><body>
  <div class="trim-ui__cache-outlet--exclude">
    <div class="mb-[46px] flex flex-col gap-3 w-full" id="col">
      <div class="relative w-full">
        <div class="trim-mc__details--key-version semi-always-dark relative left-0 top-0 box-border w-full px-[46px]" id="hero">
          <div class="gradient" style="position:absolute;inset:auto 0 0 0;height:40%"></div>
        </div>
      </div>
      <div class="relative box-border flex w-full flex-col px-[44px]" id="panel">
        <div class="text-justify" id="intro">这是一部有 ${seasonCount} 季的剧集简介，用于撑起面板左列的高度。</div>
        <div class="flex flex-wrap gap-x-5 gap-y-7 w-full" id="season-row">${cards}</div>
      </div>
    </div>
  </div>
  <script src="/fntv-plus.user.js"><\/script></body></html>`;
}

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const errs = [];
const slog = [];

async function runSeasonCase(count) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { const t = m.text(); if (t.includes('seasonNav')) slog.push(t); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('.js')) return route.fulfill({ path: path.join(root, 'dist/fntv-plus.user.js'), contentType: 'text/javascript' });
    return route.fulfill({ contentType: 'text/html', body: replicaHtml(count) });
  });
  await page.goto('http://fntv.test/v/tv/0ae81abecafe0ae81abecafe0ae81abe', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1600); // 重试链前两拍(0/350ms)足够命中——面板与 hero 同帧已在
  return page;
}

// ── 场景 A：6 季（溢出）──
const page = await runSeasonCase(6);
const initial = await page.evaluate(() => {
  const nav = document.getElementById('fnos-season-nav');
  if (!nav) return { nav: false };
  const btns = nav.querySelectorAll('button');
  const row = document.getElementById('season-row');
  const poster = row.querySelector('[data-id="details"] .poster-box');
  const br = btns[0].getBoundingClientRect();
  const pr = poster.getBoundingClientRect();
  return {
    nav: true,
    btnCount: btns.length,
    overflow: row.scrollWidth > row.clientWidth + 2,
    scrollW: row.scrollWidth, clientW: row.clientWidth,
    leftEnd: btns[0].getAttribute('data-end'),
    rightEnd: btns[1].getAttribute('data-end'),
    btnCenterY: Math.round(br.top + br.height / 2),
    posterCenterY: Math.round(pr.top + pr.height / 2),
    navAfterRow: nav.previousElementSibling === row,
    panelW: Math.round(document.getElementById('panel').getBoundingClientRect().width),
  };
});
if (!initial.nav) { console.log('INITIAL=' + JSON.stringify(initial)); console.log('❌ 圆钮未挂载'); process.exit(1); }

// 点右钮一步 → scrollLeft ≈ 卡步进
const step0 = await page.evaluate(() => document.getElementById('season-row').scrollLeft);
await page.evaluate(() => document.querySelectorAll('#fnos-season-nav button')[1].click());
await page.waitForTimeout(700); // smooth scroll 收敛
const afterRight1 = await page.evaluate(() => {
  const row = document.getElementById('season-row');
  const btns = document.querySelectorAll('#fnos-season-nav button');
  return { scrollLeft: Math.round(row.scrollLeft), leftEnd: btns[0].getAttribute('data-end'), rightEnd: btns[1].getAttribute('data-end') };
});
// 连点到最右 → 右钮到端
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => document.querySelectorAll('#fnos-season-nav button')[1].click());
  await page.waitForTimeout(320);
}
await page.waitForTimeout(500);
const afterRightMax = await page.evaluate(() => {
  const row = document.getElementById('season-row');
  const btns = document.querySelectorAll('#fnos-season-nav button');
  return { scrollLeft: Math.round(row.scrollLeft), max: row.scrollWidth - row.clientWidth, rightEnd: btns[1].getAttribute('data-end') };
});
// 点左钮一步 → 退回
await page.evaluate(() => document.querySelectorAll('#fnos-season-nav button')[0].click());
await page.waitForTimeout(700);
const afterLeft = await page.evaluate(() => {
  const row = document.getElementById('season-row');
  const btns = document.querySelectorAll('#fnos-season-nav button');
  return { scrollLeft: Math.round(row.scrollLeft), rightEnd: btns[1].getAttribute('data-end'), leftEnd: btns[0].getAttribute('data-end') };
});
await page.screenshot({ path: path.join(root, 'dev/verify_season_nav_6.png') });
await page.close();

// ── 场景 B：4 季（不溢出）──
const pageB = await runSeasonCase(4);
const fourSeasons = await pageB.evaluate(() => ({
  nav: !!document.getElementById('fnos-season-nav'),
  overflow: (() => { const r = document.getElementById('season-row'); return r.scrollWidth > r.clientWidth + 2; })(),
}));
await pageB.close();

// ── 场景 C：React 重建季行（换新节点）→ 钮重挂 + 点击仍生效；再删行 → 钮摘除 ──
const pageC = await runSeasonCase(6);
const rebuilt = await pageC.evaluate(async () => {
  const panel = document.getElementById('panel');
  const oldRow = document.getElementById('season-row');
  const oldNav = document.getElementById('fnos-season-nav');
  const wasAfterOld = oldNav && oldNav.previousElementSibling === oldRow;
  const newRow = oldRow.cloneNode(true); // 新节点实例（仿 React 重建）
  newRow.id = 'season-row';
  oldRow.replaceWith(newRow);
  await new Promise((r) => setTimeout(r, 700)); // observer 去抖 200ms + 收敛
  const nav = document.getElementById('fnos-season-nav');
  const row = document.getElementById('season-row');
  const afterRow = nav && nav.previousElementSibling === row;
  const sl0 = row.scrollLeft;
  const btns = nav ? nav.querySelectorAll('button') : [];
  if (btns[1]) btns[1].click();
  await new Promise((r) => setTimeout(r, 700));
  return {
    wasAfterOld, navAlive: !!nav, afterRow,
    scrolled: row.scrollLeft > sl0,
    leftEnd: btns[0] ? btns[0].getAttribute('data-end') : null,
  };
});
const removed = await pageC.evaluate(async () => {
  document.getElementById('season-row').remove();
  await new Promise((r) => setTimeout(r, 700));
  return { navAlive: !!document.getElementById('fnos-season-nav') };
});
await pageC.close();

await browser.close();

const okA = initial.nav === true && initial.btnCount === 2 && initial.overflow === true
  && initial.leftEnd === '1' && initial.rightEnd === '0'
  && Math.abs(initial.btnCenterY - initial.posterCenterY) <= 3
  && initial.navAfterRow === true
  && afterRight1.scrollLeft > step0 && Math.abs(afterRight1.scrollLeft - step0 - 143) <= 24
  && afterRight1.leftEnd === '0'
  && afterRightMax.rightEnd === '1' && afterRightMax.scrollLeft >= afterRightMax.max - 2
  && afterLeft.scrollLeft < afterRightMax.scrollLeft && afterLeft.rightEnd === '0';
const okB = fourSeasons.nav === false && fourSeasons.overflow === false;
const okC = rebuilt.wasAfterOld === true && rebuilt.navAlive === true && rebuilt.afterRow === true
  && rebuilt.scrolled === true && rebuilt.leftEnd === '0' && removed.navAlive === false;

console.log('INITIAL=' + JSON.stringify(initial));
console.log('AFTER_RIGHT1=' + JSON.stringify(afterRight1));
console.log('AFTER_RIGHT_MAX=' + JSON.stringify(afterRightMax));
console.log('AFTER_LEFT=' + JSON.stringify(afterLeft));
console.log('FOUR_SEASONS=' + JSON.stringify(fourSeasons));
console.log('REBUILT=' + JSON.stringify(rebuilt));
console.log('REMOVED=' + JSON.stringify(removed));
console.log('SNAVLOGS=' + JSON.stringify(slog.slice(-8)));
console.log('ERRORS=' + (errs.length ? errs.join(' | ') : 'none'));
console.log((okA && okB && okC && errs.length === 0) ? '✅ E2E PASS' : '❌ E2E FAIL');
process.exit((okA && okB && okC && errs.length === 0) ? 0 : 1);
