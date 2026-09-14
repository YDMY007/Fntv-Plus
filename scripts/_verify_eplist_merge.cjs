// 临时验证脚本(lc-1147 v2 分区版): 撑大视口全量挂载当前分区 + 原生锚点切换分区
// 用法: node scripts/_verify_eplist_merge.cjs
const { chromium } = require('playwright');
const Fs = require('fs');
const Path = require('path');

const SEASON_URL = 'http://100.66.1.2:22350/v/tv/season/5ffeacb03e7b4886abd6b7c8c33703d9';
const ROOT = 'D:/GitHub/Fntv-Plus/dest/preload/plugins/embyWall/detail';

(async () => {
  const cfg = JSON.parse(Fs.readFileSync('C:/Users/24305/AppData/Roaming/fntv/config.json', 'utf8'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  const page = await ctx.newPage();
  const u = new URL(SEASON_URL);
  await ctx.addCookies([{ name: 'Trim-MC-token', value: cfg.token, domain: u.hostname, path: '/' }]);
  await page.goto(SEASON_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const waitList = async () => {
    for (let i = 0; i < 5; i++) {
      const has = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ms-container[class*="overflow-x-scroll"]'))
          .some(m => m.querySelector('[data-id="details"] a[href*="/v/tv/episode/"]')));
      if (has) return true;
      await page.waitForTimeout(4000);
    }
    return false;
  };
  let loaded = false;
  for (let attempt = 1; attempt <= 4 && !loaded; attempt++) {
    loaded = await waitList();
    if (loaded) break;
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (!loaded) {
    try { await page.locator('[title="切换为卡片视图"]').first().click({ timeout: 2000 }); } catch (e) {}
    await page.waitForTimeout(3000);
    loaded = await waitList();
  }
  if (!loaded) {
    console.log('still stuck');
    await page.screenshot({ path: 'C:/Users/24305/AppData/Local/Temp/eplist-stuck.png' });
    await browser.close();
    process.exit(2);
  }

  // 注入编译产物(CJS shim: ../log 桩, ./glass 真件)
  const glassSrc = Fs.readFileSync(Path.join(ROOT, 'glass.js'), 'utf8');
  const mergeSrc = Fs.readFileSync(Path.join(ROOT, 'epListMerge.js'), 'utf8');
  await page.evaluate(({ glassSrc, mergeSrc }) => {
    const mods = {};
    const __req = (name) => {
      if (name === './glass') {
        if (!mods.glass) {
          const m = { exports: {} }; mods.glass = m;
          new Function('require', 'module', 'exports', glassSrc)(__req, m, m.exports);
        }
        return mods.glass.exports;
      }
      if (name === '../log') return { dlog: (...a) => console.log('[dlog]', ...a), log: () => {} };
      throw new Error('no shim for ' + name);
    };
    const m = { exports: {} };
    new Function('require', 'module', 'exports', mergeSrc)(__req, m, m.exports);
    window.__epListMerge = m.exports;
    document.body.classList.add('fnos-beautify');
  }, { glassSrc, mergeSrc });

  await page.evaluate(() => { window.__epListMerge.ensureEpListMerge(true); });
  // 重试链模拟: 再打两枪 hard
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__epListMerge.ensureEpListMerge(true); window.__epListMerge.ensureEpListMerge(true); });
  await page.waitForTimeout(4000);

  const grab = () => page.evaluate(() => {
    const ms = Array.from(document.querySelectorAll('.ms-container[class*="overflow-x-scroll"]'))
      .find(m => m.querySelector('[data-id="details"] a[href*="/v/tv/episode/"]'));
    if (!ms) return { ok: false };
    const cards = ms.querySelectorAll('[data-id="details"]');
    const nums = Array.from(cards).map(c => {
      const a = c.querySelector('a[href*="/v/tv/episode/"]');
      const p = c.querySelector('p');
      return { href: a ? a.getAttribute('href') : null, t: p ? (p.textContent || '').trim().slice(0, 8) : '' };
    });
    return {
      ok: true, n: cards.length,
      uniq: new Set(nums.map(x => x.href)).size,
      first: nums[0] ? nums[0].t : null, last: nums.length ? nums[nums.length - 1].t : null,
      numsOnly: nums.map(x => (x.t.match(/第 (\d+) 集/) || [])[1]).filter(Boolean),
      ovX: ms.style.overflowX, sw: ms.scrollWidth, cw: ms.clientWidth, sl: ms.scrollLeft,
    };
  });

  const p1 = await grab();
  console.log('partition1:', JSON.stringify(p1));
  await page.screenshot({ path: 'C:/Users/24305/AppData/Local/Temp/eplist-p1.png' });

  // 点「31 - 48」锚点(真实 click, 我们的 capture 放行 + React onClick 都要跑)
  const clicked = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span')).filter(e => /^31 - 48$/.test((e.textContent || '').trim()));
    if (!spans.length) return { ok: false };
    let e = spans[0];
    for (let k = 0; k < 5 && e; k++) {
      const props = Object.keys(e).find(k2 => k2.startsWith('__reactProps'));
      if (props && typeof e[props].onClick === 'function') {
        const el = e;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true, cls: String(el.className).slice(0, 40) };
      }
      e = e.parentElement;
    }
    return { ok: false };
  });
  console.log('click31-48:', JSON.stringify(clicked));
  await page.waitForTimeout(4500);
  const p2 = await grab();
  console.log('partition2:', JSON.stringify(p2));
  await page.screenshot({ path: 'C:/Users/24305/AppData/Local/Temp/eplist-p2.png' });

  // 切回 1 - 30
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span')).filter(e => /^1 - 30$/.test((e.textContent || '').trim()));
    let e = spans[0];
    for (let k = 0; k < 5 && e; k++) {
      const props = Object.keys(e).find(k2 => k2.startsWith('__reactProps'));
      if (props && typeof e[props].onClick === 'function') { e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return; }
      e = e.parentElement;
    }
  });
  await page.waitForTimeout(4500);
  const p1b = await grab();
  console.log('back-to-1:', JSON.stringify(p1b));
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
