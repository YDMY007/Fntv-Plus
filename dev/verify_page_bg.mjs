// dev/verify_page_bg.mjs — [v1.11.0] 页面背景自定义 E2E。
// 断言：①「页面背景」卡挂载于「通用」分类且四模式分段齐全；②点「图片」+填 URL →
// html 打上 data-fntv-bg-mode="image"、#fntv-page-bg-layer 固定层创建、body 透明；
// ③点「纯色」+改色 → body 计算背景色变更为所选色（穿透原生 token/glass/性能兜底规则的
// 特异性生效证明）、图片层移除；④全部键落入模拟后端 settingsStore。
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostPage = path.join(root, 'demo/host.html');
const payload = path.join(root, 'dist/fntv-plus.user.js');

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

const settingsStore = {};
await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.includes('/app/fntvplus/api/settings')) {
    if (route.request().method() === 'POST') {
      try { Object.assign(settingsStore, route.request().postDataJSON()); } catch { /* ignore */ }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(settingsStore) });
  }
  if (url.endsWith('.js')) route.fulfill({ path: payload, contentType: 'text/javascript' });
  else route.fulfill({ path: hostPage, contentType: 'text/html' });
});
await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4500);

// 1) 打开设置 → 通用
await page.evaluate(() => document.getElementById('fnos-settings-btn')?.click());
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  const el = Array.from(panel.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '通用')
    || Array.from(panel.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '通用');
  el.click();
});
await page.waitForTimeout(400);

// 2) 找「页面背景」卡，断言分段按钮，点「图片」
const segInfo = await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  for (const body of bodies) {
    const txt = body.parentElement ? (body.parentElement.textContent || '') : '';
    if (!txt.includes('页面背景')) continue;
    const seg = Array.from(body.querySelectorAll('button')).filter((b) => /原生|纯色|渐变|图片/.test((b.textContent || '').trim()));
    const imgBtn = seg.find((b) => (b.textContent || '').trim() === '图片');
    if (imgBtn) imgBtn.click();
    return { segCount: seg.length, clicked: !!imgBtn };
  }
  return { segCount: 0, clicked: false };
});
await page.waitForTimeout(400);

// 3) 图片模式：填 URL 触发 change → 断言 html 属性 + 固定层
const imgState = await page.evaluate(() => {
  const html = document.documentElement;
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  let body = null;
  for (const b of bodies) {
    const txt = b.parentElement ? (b.parentElement.textContent || '') : '';
    if (txt.includes('页面背景')) { body = b; break; }
  }
  if (!body) return { error: 'no card body' };
  const urlInput = Array.from(body.querySelectorAll('input[type="text"]'))[0];
  urlInput.value = 'https://example.test/bg.jpg';
  urlInput.dispatchEvent(new Event('change'));
  return {
    modeAttr: html.getAttribute('data-fntv-bg-mode'),
    activeAttr: html.getAttribute('data-fntv-bg-active'),
    layerExists: !!document.getElementById('fntv-page-bg-layer'),
    layerBg: (document.getElementById('fntv-page-bg-layer') || {}).style ? document.getElementById('fntv-page-bg-layer').style.background.slice(0, 60) : '',
    bodyBgColor: getComputedStyle(document.body).backgroundColor,
  };
});
await page.waitForTimeout(300);

// 4) 纯色模式：改色 → 断言 body 计算背景色 + 图片层移除
const solidState = await page.evaluate(() => {
  const html = document.documentElement;
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  let body = null;
  for (const b of bodies) {
    const txt = b.parentElement ? (b.parentElement.textContent || '') : '';
    if (txt.includes('页面背景')) { body = b; break; }
  }
  const solidBtn = Array.from(body.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '纯色');
  solidBtn.click();
  const colorInp = body.querySelector('input[type="color"]');
  colorInp.value = '#123456';
  colorInp.dispatchEvent(new Event('input'));
  return {
    modeAttr: html.getAttribute('data-fntv-bg-mode'),
    layerGone: !document.getElementById('fntv-page-bg-layer'),
    bodyBgColor: getComputedStyle(document.body).backgroundColor,
    styleText: (() => { const st = document.getElementById('fntv-page-bg-style'); return st ? st.textContent.substring(0, 120) : 'NO-STYLE'; })(),
    styleCount: document.querySelectorAll('#fntv-page-bg-style').length,
  };
});
await page.waitForTimeout(300);

console.log('SEG=' + JSON.stringify(segInfo));
console.log('IMAGE=' + JSON.stringify(imgState));
console.log('SOLID=' + JSON.stringify(solidState));
console.log('STORE=' + JSON.stringify({
  mode: settingsStore.pageBgMode, color: settingsStore.pageBgColor, image: (settingsStore.pageBgImage || '').substring(0, 40),
}));
console.log('ERRORS=' + (errs.length ? errs.join(' | ') : 'none'));

const ok = segInfo.segCount === 4 && segInfo.clicked
  && imgState.modeAttr === 'image' && imgState.activeAttr === '1' && imgState.layerExists
  && String(imgState.bodyBgColor).replace(/\s/g, '') === 'rgba(0,0,0,0)'
  && solidState.modeAttr === 'solid' && solidState.layerGone
  && solidState.bodyBgColor === 'rgb(18, 52, 86)'
  && settingsStore.pageBgMode === 'solid' && settingsStore.pageBgColor === '#123456'
  && String(settingsStore.pageBgImage) === 'https://example.test/bg.jpg';
console.log(ok ? '✅ E2E PASS' : '❌ E2E FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
