// dev/verify_ext_sources.mjs — [v1.10.0] 扩展数据源四张独立设置卡 + shim 设置链路验证。
// route 拦截喂 host.html + payload（无端口依赖，域名 fntv.test 不落网）→ 打开设置 →
// 切「账号与网络」→ 断言 Fanart.tv / TVMaze / OMDb / MyAnimeList 四张卡各自挂载、控件齐全 →
// ① Fanart 开关 change（即时持久化）②填 api_key 点保存 → 断言键已落模拟后端 + 输入框掩码只读。
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

// 模拟后端 settings API（离线环境无 Go 服务）：POST 合并、GET 全量回吐，
// 让 shim 的「服务端持久化 + localStorage 镜像」两条链都真实走通。
// 注意 Playwright 路由后注册先执行 → settings 分支必须并进同一条 '**/*' 里最先判断。
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
// 与 test-panel 同款：payload 的 pageMode 判定依赖 /v/ 路径，须以 fntv.test/v/ 访问
await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4500);

// 1) 打开设置面板（与 scripts/test-panel.mjs 同款定位）
const btnThere = await page.evaluate(() => !!document.getElementById('fnos-settings-btn'));
await page.evaluate(() => document.getElementById('fnos-settings-btn')?.click());
await page.waitForTimeout(1200);
const panelThere = await page.evaluate(() => {
  const p = document.getElementById('fnos-settings-panel');
  return p ? 'panel:' + p.style.display : 'no-panel';
});

// 2) 切到「账号与网络」分类
const switched = await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  if (!panel) return false;
  const navBtns = Array.from(panel.querySelectorAll('button'));
  let el = navBtns.find((b) => (b.textContent || '').trim() === '账号与网络');
  if (!el) el = Array.from(panel.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '账号与网络');
  if (!el) return false;
  el.click();
  return true;
});
await page.waitForTimeout(500);

// 3) 按 channel 关键字找四张卡的 body，断言各自控件齐全
const cards = await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  if (!panel) return {};
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  // 关键字对「卡根元素」文本匹配（分组标题在 body 外层，body 文本不含标题）
  const probe = (kws) => {
    for (const body of bodies) {
      const txt = body.parentElement ? (body.parentElement.textContent || '') : (body.textContent || '');
      if (!kws.every((k) => txt.includes(k))) continue;
      return {
        found: true,
        toggles: body.querySelectorAll('input[type="checkbox"]').length,
        inputs: body.querySelectorAll('input[type="text"]').length,
        saveBtn: !!Array.from(body.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存'),
        clearBtn: !!Array.from(body.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '清除'),
        links: Array.from(body.querySelectorAll('a')).map((a) => a.href),
      };
    }
    return { found: false };
  };
  return {
    fanart: probe(['Fanart.tv 高清 Logo']),
    tvmaze: probe(['TVMaze 分集兜底']),
    omdb: probe(['OMDb IMDb 评分']),
    mal: probe(['MyAnimeList 官方']),
    jav: probe(['Jav 刮削']),
  };
});

// 4) 四个开关 change（即时持久化：fanart/tvmaze/omdb/jav）
await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  for (const body of bodies) {
    const txt = body.parentElement ? (body.parentElement.textContent || '') : '';
    if (!/Fanart\.tv 高清 Logo|TVMaze 分集兜底|OMDb IMDb 评分|Jav 刮削/.test(txt)) continue;
    const sw = body.querySelector('input[type="checkbox"]');
    if (!sw) continue;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
  }
});
await page.waitForTimeout(400);

// 5) 填 Fanart api_key → 点该卡「保存」→ 断言落库 + 掩码只读
const savedState = await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  for (const body of bodies) {
    if (!(body.textContent || '').includes('Fanart.tv')) continue;
    const keyInput = Array.from(body.querySelectorAll('input')).find((i) => (i.placeholder || '').includes('Fanart.tv api_key'));
    if (!keyInput) return { filled: false };
    keyInput.readOnly = false;
    keyInput.value = 'k-e2e-test';
    const saveBtn = Array.from(body.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存');
    saveBtn.click();
    return { filled: true };
  }
  return { filled: false };
});
await page.waitForTimeout(600);
const maskState = await page.evaluate(() => {
  const panel = document.querySelector('#fnos-settings-panel');
  const bodies = Array.from(panel.querySelectorAll('[data-sec-body="1"]'));
  for (const body of bodies) {
    if (!(body.textContent || '').includes('Fanart.tv')) continue;
    const keyInput = Array.from(body.querySelectorAll('input')).find((i) => (i.placeholder || '').includes('Fanart.tv api_key'));
    return { value: keyInput ? keyInput.value : '', readOnly: keyInput ? keyInput.readOnly : null };
  }
  return {};
});

console.log('BTN=' + btnThere + ' PANEL=' + panelThere);
// 6) 电影详情路由深链：javEnabled 已存 → patch seed + 导航钩子应自动挂「⟳ jav 刮削」浮动按钮
await page.goto('http://fntv.test/v/movie/0123456789abcdef0123456789abcdef', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4500);
const javBtn = await page.evaluate(() => {
  const b = document.getElementById('fnos-jav-btn');
  return b ? { found: true, text: (b.textContent || '').trim() } : { found: false };
});
console.log('JAV_BTN=' + JSON.stringify(javBtn));

console.log('NAV_SWITCHED=' + switched);
console.log('CARDS=' + JSON.stringify(cards));
console.log('SAVED=' + JSON.stringify(savedState) + ' MASK=' + JSON.stringify(maskState));
console.log('STORE=' + JSON.stringify(settingsStore));
console.log('ERRORS=' + (errs.length ? errs.join(' | ') : 'none'));

const ok = btnThere && panelThere === 'panel:flex' && switched
  && ['fanart', 'tvmaze', 'omdb', 'mal', 'jav'].every((k) => cards[k] && cards[k].found)
  && cards.fanart.toggles === 1 && cards.fanart.inputs === 2 && cards.fanart.saveBtn && cards.fanart.clearBtn
  && cards.tvmaze.toggles === 1 && cards.tvmaze.inputs === 0
  && cards.omdb.toggles === 1 && cards.omdb.inputs === 1
  && cards.mal.toggles === 0 && cards.mal.inputs === 1
  && cards.jav.toggles === 1 && cards.jav.inputs === 1
  && savedState.filled
  && settingsStore.fanartEnabled === true && settingsStore.tvmazeEnabled === true
  && settingsStore.omdbEnabled === true && settingsStore.javEnabled === true
  && settingsStore.fanartApiKey === 'k-e2e-test'
  && typeof maskState.value === 'string' && /^\*+$/.test(maskState.value) && maskState.readOnly === true
  && javBtn.found && /jav 刮削/.test(javBtn.text);
console.log(ok ? '✅ E2E PASS' : '❌ E2E FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
