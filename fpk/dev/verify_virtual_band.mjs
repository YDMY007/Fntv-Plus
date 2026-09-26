// dev/verify_virtual_band.mjs — [v1.10.2] 选集竖排「虚拟窗口」全量渲染修复验证。
// 复刻页内置 mini 虚拟器（逐行仿 fnOS RH 组件：ceil(clientWidth/条距)+2×overscan 窗口、
// items.slice(l,d+1) 渲染、resize 100ms 去抖重测、before/after h-px 垫条）+ 假 __reactFiber$
// 链（scroller → RH props.virtualList），注入 dist/fntv-plus.user.js 后断言：
//   ① 美化启用 ② 修复前窗口冻结：选集 11/48、演员 18/25（数学复现用户报障数字）
//   ③ 修复后全量：选集 48/48、演员 25/25（slice 覆盖 + 预热重测生效）
//   ④ 竖排样式保留：卡宽=列宽（非 260px）、缩略图 16:9（~101px）、垫条隐藏
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EPS = 48, ACTORS = 25;
// mini 虚拟器参数与 fnOS 一致：选集 itemWidth:260/itemGap:20/overscan:3，演员 120/20/4
const miniVirtualizer = `
(function () {
  function makeBand(bandId, scrollerId, count, itemWidth, itemGap, overscan, renderCard, renderLabel) {
    var items = [];
    for (var i = 1; i <= count; i++) items.push({ guid: 'g' + bandId + i, no: i });
    var sc = document.getElementById(scrollerId);
    var wrap = sc.firstElementChild;
    var s = 0, u = 0, lastL = -1, lastD = -1;
    // 假 React fiber 链：scroller(pi props) → RH props.virtualList —— 与真实结构同形
    sc['__reactFiber$verify'] = { memoizedProps: { onScroll: function () {} },
      return: { memoizedProps: { virtualList: { items: items, itemWidth: itemWidth, itemGap: itemGap, overscan: overscan } }, return: null } };
    function compute() {
      var stride = itemWidth + itemGap;
      var o = Math.ceil(Math.max(1, u) / stride);
      var c = Math.max(1, o + overscan * 2);
      var l = Math.max(0, Math.floor(s / stride) - overscan);
      var d = Math.min(items.length - 1, l + c - 1);
      return { l: l, d: d };
    }
    function render() {
      var w = compute();
      if (w.l === lastL && w.d === lastD) return; // 仿 React memo：窗口没变不重渲染
      lastL = w.l; lastD = w.d;
      var html = '';
      if (w.l > 0) html += '<div class="h-px shrink-0" style="width:' + (w.l * (itemWidth + itemGap) - itemGap) + 'px"></div>';
      var shown = items.slice(w.l, w.d + 1);   // ← 被 payload 覆盖后返回全量
      for (var i = 0; i < shown.length; i++) html += renderCard(shown[i]);
      if (items.length - 1 - w.d > 0) html += '<div class="h-px shrink-0" style="width:' + ((items.length - 1 - w.d) * (itemWidth + itemGap)) + 'px"></div>';
      wrap.innerHTML = html;
      window.__vbandInit = window.__vbandInit || {};
      if (!window.__vbandInit[bandId]) window.__vbandInit[bandId] = shown.length; // 仅首帧（修复前快照）
    }
    var tmr = 0;
    function measure() {
      u = sc.clientWidth;
      render();
    }
    window.addEventListener('resize', function () { clearTimeout(tmr); tmr = setTimeout(measure, 100); });
    measure();
    // 调试探针：暴露窗口内部状态（lastL/lastD/u/渲染数）
    window.__bands = window.__bands || {};
    window.__bands[bandId] = {
      get u() { return u; }, get lastL() { return lastL; }, get lastD() { return lastD; },
      get rendered() { return wrap.querySelectorAll('[data-id="details"], a[href*="/v/person/"], button').length; },
      get marked() { return !!items.__fntvFullSlice; },
      get dom() { return sc.isConnected ? 'attached' : 'detached'; },
    };
  }
  function epCard(it) {
    return '<div data-id="details" class="box-border w-full">' +
      '<div class="rounded-lg relative mb-3 flex h-[146px] w-full shrink-0 overflow-hidden" style="background:#233">' +
      '<div class="box-border"><div class="relative size-full"><div class="size-full"><picture>' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" class="object-cover absolute inset-0" style="position:absolute;width:100%;height:100%">' +
      '</picture></div></div></div></div>' +
      '<p class="truncate">第 ' + it.no + ' 集 标题</p></div>';
  }
  function actorCard(it) {
    return '<div class="group" style="width:120px;height:145px"><a href="/v/person/x" class="no-underline">' +
      '<div class="size-[90px] rounded-full" style="width:90px;height:90px;background:#345"></div>' +
      '<p class="text-base">演员 ' + it.no + '</p></a></div>';
  }
  makeBand('ep', 'ep-band', ${EPS}, 260, 20, 3, epCard);
  makeBand('ac', 'ac-band', ${ACTORS}, 120, 20, 4, actorCard);
  // 模拟「点按钮/切视图」后 React 整带重建：全新滚动容器 + 全新 items 数组 + 全新 fiber
  window.__rebuildEpBand = function () {
    var block = document.getElementById('eps-block');
    block.innerHTML = '<p class="semi-typography">选集</p>' +
      '<div class="ms-container overflow-x-scroll whitespace-nowrap" id="ep-band"><div class="flex w-max"></div></div>';
    makeBand('ep', 'ep-band', ${EPS}, 260, 20, 3, epCard);
  };
})();
`;

const replicaHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#eef1f6;font-family:system-ui}
  .semi-always-dark{position:relative}
  .mb-\[46px\]{margin-bottom:46px}.flex{display:flex}.flex-col{flex-direction:column}
  .gap-3{gap:12px}.w-full{width:100%}.relative{position:relative}.my-10{margin:40px 0}
  .overflow-x-scroll{overflow-x:scroll}.ms-container{display:block;height:auto}
  .semi-typography{font-size:16px;font-weight:600;margin:0}
  .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .no-underline{text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center}
  .rounded-full{border-radius:50%} .size-\[90px\]{width:90px;height:90px}
  .text-base{font-size:16px} .group{flex:0 0 auto}
  #hero{height:220px;background:linear-gradient(120deg,#22304a,#31456b);border-radius:12px}
  #col{width:1760px}  /* 列宽 1760 → 选集窗口 ceil(1760/280)+6=12+6... 取 1680: 6+6=12；用 1540: ceil(1540/280)=6 → 12 */
</style></head><body>
<div class="trim-ui__cache-outlet--exclude" style="display:block;padding:0 46px">
  <div class="mb-[46px] flex flex-col gap-3 w-full" id="col" style="width:1540px">
    <div class="semi-always-dark h-[470px]" id="hero"></div>
    <div id="eps-block"><p class="semi-typography">选集</p>
      <div class="ms-container overflow-x-scroll whitespace-nowrap" id="ep-band"><div class="flex w-max"></div></div>
    </div>
    <div class="relative flex w-full flex-col my-10" id="bh-root"><p class="semi-typography">演职人员</p>
      <div class="ms-container overflow-x-scroll whitespace-nowrap" id="ac-band"><div class="flex w-max"></div></div>
    </div>
  </div>
</div>
<script>${miniVirtualizer}<\/script>
<script src="/fntv-plus.user.js"><\/script></body></html>`;

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1990, height: 1020 } });
const errs = [];
const vlogs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { const t = m.text(); if (t.includes('vband')) vlogs.push(t); });

await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.endsWith('.js')) return route.fulfill({ path: path.join(root, 'dist/fntv-plus.user.js'), contentType: 'text/javascript' });
  return route.fulfill({ contentType: 'text/html', body: replicaHtml });
});
// payload 的 pageMode 判定依赖 /v/ 路径 → 直接以 /v/tv/season/<id> 访问（路由全拦，同 verify_ext_sources）
await page.goto('http://fntv.test/v/tv/season/0ae81abecafe0ae81abecafe0ae81abe', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(800);

const before = await page.evaluate(() => ({
  beautify: document.body.classList.contains('fnos-beautify'),
  initEps: (window.__vbandInit || {}).ep,     // 首窗渲染数（payload 生效前，mini 虚拟器自记）
  initActors: (window.__vbandInit || {}).ac,
  epsNow: document.querySelectorAll('#ep-band [data-id="details"]').length,
  actorsNow: document.querySelectorAll('#ac-band .group').length,
}));

await page.waitForTimeout(4500); // 等 scheduleVirtualBandFix 重试链 + 预热收敛

const after = await page.evaluate(() => {
  const epSc = document.getElementById('ep-band');
  const epCard = document.querySelector('#ep-band [data-id="details"]');
  const thumb = epCard ? epCard.querySelector('[class*="h-[146px]"], .rounded-lg.relative') : null;
  const spacer = document.querySelector('#ep-band .h-px');
  return {
    eps: document.querySelectorAll('#ep-band [data-id="details"]').length,
    actors: document.querySelectorAll('#ac-band .group').length,
    epMarked: !!(function () { const fk = Object.keys(epSc).find(k => k.startsWith('__reactFiber$')); let f = epSc[fk]; for (let d = 0; f && d < 60; d++) { const vl = f.memoizedProps && f.memoizedProps.virtualList; if (vl) return vl.items.__fntvFullSlice === true; f = f.return; } return false; })(),
    cardWidth: epCard ? Math.round(epCard.getBoundingClientRect().width) : 0,
    thumbH: thumb ? Math.round(thumb.getBoundingClientRect().height) : 0,
    colWidth: Math.round(document.getElementById('col').getBoundingClientRect().width),
    spacerHidden: spacer ? getComputedStyle(spacer).display === 'none' : 'no-spacer',
  };
});

// 数据刷新换新数组实例（仿 fnOS 标记看过 → setEpisodeList）：watcher 应自动补覆盖
const refreshed = await page.evaluate(async () => {
  const epSc = document.getElementById('ep-band');
  const fk = Object.keys(epSc).find(k => k.startsWith('__reactFiber$'));
  let f = epSc[fk];
  for (let d = 0; f && d < 60; d++) {
    const vl = f.memoizedProps && f.memoizedProps.virtualList;
    if (vl) { vl.items = [{ guid: 'new', no: 1 }].concat(Array.from(vl.items).slice(1)); break; } // 换新未标记数组（Array.from 绕过已覆盖的 slice）
    f = f.return;
  }
  const c = document.createComment('rerender'); // 仿 React 重渲染的 DOM 突变 → 唤醒 watcher
  epSc.appendChild(c); c.remove();
  await new Promise((r) => setTimeout(r, 1200)); // watcher 防抖 350ms + patch + 预热
  let marked = false;
  f = epSc[fk];
  for (let d = 0; f && d < 60; d++) {
    const vl = f.memoizedProps && f.memoizedProps.virtualList;
    if (vl) { marked = vl.items.__fntvFullSlice === true; break; }
    f = f.return;
  }
  return { marked, eps: document.querySelectorAll('#ep-band [data-id="details"]').length };
});

// 整带重建（仿点按钮/切视图：React 换掉整个滚动容器 + 新数组）：_detailObs → ensure 应补挂
const rebuilt = await page.evaluate(async () => {
  window.__rebuildEpBand();
  const snap = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const b = window.__bands.ep;
    snap.push(b.u + '/' + b.lastL + '-' + b.lastD + '/' + b.rendered + '/' + (b.marked ? 'P' : 'n') + '/' + b.dom);
  }
  return { snap, eps: document.querySelectorAll('#ep-band [data-id="details"]').length };
});

console.log('BEFORE=' + JSON.stringify(before));
console.log('AFTER=' + JSON.stringify(after));
console.log('REFRESHED=' + JSON.stringify(refreshed));
console.log('REBUILT=' + JSON.stringify(rebuilt));
console.log('REBUILT_SNAP=' + JSON.stringify(rebuilt.snap || []));
console.log('VBLOGS=' + JSON.stringify(vlogs.slice(-12)));
console.log('ERRORS=' + (errs.length ? errs.join(' | ') : 'none'));

// ② 修复前窗口冻结 = 用户报障复现：beautify padding 生效前 clientWidth=1540
//    → 选集 ceil(1540/280)+6 = 12，演员 ceil(1540/140)+8 = 19（用户窗口较窄时即 11）
const windowEps = Math.ceil(1540 / 280) + 6;
const windowActors = Math.ceil(1540 / 140) + 8;
const ok = before.beautify === true
  && before.initEps === windowEps && before.initActors === windowActors  // 复现冻结（首窗数）
  && after.eps === EPS && after.actors === ACTORS                        // 全量渲染
  && after.epMarked === true
  && after.cardWidth > 1000 && after.cardWidth <= 1540            // 竖排卡宽=列宽（原样式）
  && after.thumbH >= 95 && after.thumbH <= 110                     // 16:9 缩略图(~101px)
  && after.spacerHidden === true                                   // 垫条隐藏
  && refreshed.marked === true && refreshed.eps === EPS            // 换新数组后 watcher 自动补覆盖
  && rebuilt.eps === EPS                                           // 整带重建后 _detailObs 链路补挂
  && errs.length === 0;
console.log('WINDOW_MATH=' + windowEps + '/' + windowActors);
console.log(ok ? '✅ E2E PASS' : '❌ E2E FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
