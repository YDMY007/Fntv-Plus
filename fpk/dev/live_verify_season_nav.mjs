// dev/live_verify_season_nav.mjs — NAS 实机活体验证：一级详情页季选行左右切换圆钮。
// 流程：登录(22350 表单) → 打开 /v/tv/dd4e30a2… → page.route 把线上 payload 换成本地
// dist/fntv-plus.user.js（验证未安装的新代码）→ 断言圆钮挂载/点击步进/到端禁用 + 截图目检。
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://100.66.1.2:22350';
const TARGET = BASE + '/v/tv/dd4e30a283f14b02bcbc71b99f2be40d';
// 凭据走环境变量（NAS_USER / NAS_PASS），不落仓库
const NAS_USER = process.env.NAS_USER;
const NAS_PASS = process.env.NAS_PASS;

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

// ① 登录
await page.goto(BASE + '/v/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
const user = page.locator('input[type="text"], input[name="username"], input[placeholder*="账号"]').first();
await user.fill(NAS_USER);
const pass = page.locator('input[type="password"]').first();
await pass.fill(NAS_PASS);
await page.screenshot({ path: path.join(root, 'dev/live_login.png') });
await page.locator('button:has-text("登录")').first().click();
await page.waitForTimeout(4000);
console.log('AFTER_LOGIN_URL=', page.url());

// ② 打开目标剧集页，线上 payload 换成本地 dist
await page.route('**/__payload__/fntv-plus.*.user.js', (route) =>
  route.fulfill({ path: path.join(root, 'dist/fntv-plus.user.js'), contentType: 'text/javascript' }));
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6500); // settle + 重试链前几拍 + TMDB 卡

const probe = await page.evaluate(() => {
  const bodyCls = document.body.className;
  const panel = document.querySelector('div[class="relative box-border flex w-full flex-col px-[44px]"]');
  const row = panel ? panel.querySelector(':scope > div[class*="flex-wrap"]') : null;
  const nav = document.getElementById('fnos-season-nav');
  const out = { bodyCls: bodyCls.slice(0, 200), panel: !!panel, row: !!row, nav: !!nav };
  if (row) {
    const cards = row.querySelectorAll(':scope > [data-id="details"]');
    out.cardCount = cards.length;
    out.overflow = row.scrollWidth > row.clientWidth + 2;
    out.scrollW = row.scrollWidth; out.clientW = row.clientWidth;
  }
  if (nav) {
    const btns = nav.querySelectorAll('button');
    out.btnCount = btns.length;
    out.leftEnd = btns[0] && btns[0].getAttribute('data-end');
    out.rightEnd = btns[1] && btns[1].getAttribute('data-end');
    if (btns[0]) {
      const br = btns[0].getBoundingClientRect();
      const poster = row && row.querySelector('[data-id="details"] .poster-box');
      if (poster) {
        const pr = poster.getBoundingClientRect();
        out.alignErr = Math.round((br.top + br.height / 2) - (pr.top + pr.height / 2));
      }
    }
  }
  return out;
});
console.log('PROBE=' + JSON.stringify(probe));

let interact = null;
if (probe.nav && probe.btnCount === 2) {
  const sl0 = await page.evaluate(() => {
    const panel = document.querySelector('div[class="relative box-border flex w-full flex-col px-[44px]"]');
    return panel.querySelector(':scope > div[class*="flex-wrap"]').scrollLeft;
  });
  await page.evaluate(() => document.querySelectorAll('#fnos-season-nav button')[1].click());
  await page.waitForTimeout(800);
  interact = await page.evaluate((sl0) => {
    const panel = document.querySelector('div[class="relative box-border flex w-full flex-col px-[44px]"]');
    const row = panel.querySelector(':scope > div[class*="flex-wrap"]');
    const btns = document.querySelectorAll('#fnos-season-nav button');
    return { sl0, sl1: Math.round(row.scrollLeft), leftEnd: btns[0].getAttribute('data-end'), rightEnd: btns[1].getAttribute('data-end') };
  }, sl0);
  console.log('INTERACT=' + JSON.stringify(interact));
}

await page.screenshot({ path: path.join(root, 'dev/live_season_nav.png') });
console.log('ERRORS=' + (errs.length ? errs.join(' | ') : 'none'));

const ok = probe.panel && probe.row && probe.nav && probe.btnCount === 2 && probe.overflow === true
  && probe.leftEnd === '1' && probe.rightEnd === '0'
  && (probe.alignErr === undefined || Math.abs(probe.alignErr) <= 3)
  && interact && interact.sl1 > interact.sl0 && interact.leftEnd === '0'
  && errs.length === 0;
console.log(ok ? '✅ LIVE PASS' : '❌ LIVE FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
