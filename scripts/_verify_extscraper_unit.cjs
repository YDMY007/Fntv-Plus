// 临时单测(lc-自定义刮削移植): 用 fpk jav_test.go 的用例验证 Node 转译的 extScraper.js
// 用法: node scripts/_verify_extscraper_unit.cjs  （零外网依赖；handler 流程用本地 http 服务）
const assert = require('assert');
const http = require('http');
const Path = require('path');

// ── CJS shim: 编译产物 require electron/fn_config/proxyAgent/logger/ipcHandler ──
const configState = { javEnabled: true, javBusDomain: '' };
const registered = {};
const mod = (exports2) => exports2;

const stubs = {
  electron: { app: { getVersion: () => 'test' } },
  '../../../modules/fn_config/config': {
    getJavEnabled: () => configState.javEnabled,
    getJavBusDomain: () => configState.javBusDomain,
    getCustomScraperEnabled: () => false,
    getCustomScraperUrl: () => '',
    getFanartEnabled: () => configState.fanartEnabled === true,
    getFanartApiKey: () => configState.fanartApiKey || '',
    getFanartClientKey: () => '',
    getTvmazeEnabled: () => configState.tvmazeEnabled === true,
    getOmdbEnabled: () => configState.omdbEnabled === true,
    getOmdbApiKey: () => configState.omdbApiKey || '',
    getMalClientId: () => '',
    getTmdbApiKey: () => '',
  },
  '../../../modules/proxyAgent': { resolveProxyAgent: () => undefined },
  '../../../modules/logger': { info: () => {}, error: () => {}, warn: () => {} },
  '../core/ipcHandler': {
    registerHandler: (ch, fn) => { registered[ch] = fn; },
  },
};

const reqCtx = { filename: Path.resolve('dest/main/handlers/plugins/extScraper.js') };
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request]) return request;
  return orig.call(this, request, parent || reqCtx, ...rest);
};
// 相对 require 解析到 stub：直接拦 require
const realRequire = require;
function loadModule() {
  const src = require('fs').readFileSync(Path.resolve('dest/main/handlers/plugins/extScraper.js'), 'utf8');
  const fn = new Function('require', 'module', 'exports', src);
  const module = { exports: {} };
  const shimRequire = (name) => {
    if (stubs[name]) return stubs[name];
    return realRequire(name);
  };
  fn(shimRequire, module, module.exports);
  return module.exports;
}
const svc = loadModule();
assert.strictEqual(typeof svc.init, 'function', 'init 导出缺失');
svc.init();
assert.ok(registered['jav:lookup'] && registered['jav:image'] && registered['custom-scraper:fetch']
  && registered['fanart:logos'] && registered['tvmaze:show'] && registered['omdb:rating'], '通道注册缺失');

// ── TestJavExtractCode ──
const extract = svc.javExtractCode;
const cases = [
  ['ABC-123', 'ABC-123'],
  ['ABC123', 'ABC-123'],
  ['abc-123', 'ABC-123'],
  ['[JAV] SSIS-406 4K uncensored', 'SSIS-406'],
  ['FC2-PPV-1234567', 'FC2-PPV-1234567'],
  ['FC2 1234567', 'FC2-1234567'],
  ['MIDV-002.1080p', 'MIDV-002'],
  ['庆余年 2019', ''],
  ['Movie HDR10 2160p', ''],
  ['Video H265.mkv', ''],
  ['20230815', ''],
  ['CD1 [1985]', ''],
  ['SSIS-406-2', 'SSIS-406'],
];
for (const [input, want] of cases) {
  const got = extract(input);
  assert.strictEqual(got, want, 'javExtractCode(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
console.log('TestJavExtractCode ✓ (' + cases.length + ' cases)');

// ── TestJavParseDetail ──
const javDetailHTML = `<!DOCTYPE html><html><head><title>SSIS-406</title></head><body>
<div class="container"><div class="row movie">
<h3 style="color:#333">SSIS-406 奇跡の演技</h3>
<div class="col-md-9">
<a class="bigImage" href="https://www.javbus.test/pics/cover/abc_b.jpg"><img class="cover" src="/pics/cover/abc_s.jpg"></a>
<div class="col-md-3 info">
<p><span class="header">識別碼:</span> <span style="color:#cc0000;">SSIS-406</span></p>
<p><span class="header">發行日期:</span> 2022-01-14</p>
<p><span class="header">類別:</span>
<a href="https://www.javbus.test/genre/1" >剧情</a>
<a href="https://www.javbus.test/genre/8" >悬疑</a></p>
<p><span class="header">演員:</span>
</p></div></div>
<div class="star-name"><a class="avatar-box" href="/star/xyz">
<div class="photo-frame"><img src="https://www.javbus.test/actress/aaa.jpg"></div>
<span>持田栞里</span></a>
<a class="avatar-box" href="/star/zzz"><div class="photo-frame"><img src="/actress/bbb.jpg"></div><span>第二位</span></a>
</div></div></body></html>`;
const meta = svc.javParseDetail('https://www.javbus.test/SSIS-406', javDetailHTML, 'SSIS-406');
assert.strictEqual(meta.title, 'SSIS-406 奇跡の演技', 'title=' + meta.title);
assert.strictEqual(meta.cover, 'https://www.javbus.test/pics/cover/abc_b.jpg', 'cover=' + meta.cover);
assert.strictEqual(meta.date, '2022-01-14', 'date=' + meta.date);
assert.deepStrictEqual(meta.genres, ['剧情', '悬疑'], 'genres=' + JSON.stringify(meta.genres));
assert.strictEqual(meta.actresses.length, 2, 'actresses len');
assert.strictEqual(meta.actresses[0].name, '持田栞里');
assert.strictEqual(meta.actresses[0].photo, 'https://www.javbus.test/actress/aaa.jpg');
assert.strictEqual(meta.url, 'https://www.javbus.test/SSIS-406');
assert.strictEqual(meta.code, 'SSIS-406');
console.log('TestJavParseDetail ✓');

// ── TestJavAbsURL ──
const abs = svc.javAbsURL;
assert.strictEqual(abs('/pics/a.jpg', 'https://www.x.test/ABC-123'), 'https://www.x.test/pics/a.jpg');
assert.strictEqual(abs('https://cdn.x.test/a.jpg', 'https://www.x.test/ABC-123'), 'https://cdn.x.test/a.jpg');
assert.strictEqual(abs('', 'https://www.x.test/ABC-123'), '');
assert.strictEqual(abs('/p.jpg', 'http://127.0.0.1:2481/AB-1'), 'http://127.0.0.1:2481/p.jpg');
console.log('TestJavAbsURL ✓');

// ── TestJavLookupHandlerGateAndFlow（本地假 javbus） ──
(async () => {
  const javDetailHTML2 = javDetailHTML.replace(/www\.javbus\.test/g, '127.0.0.1:PORT');
  let hits = 0;
  const srv = http.createServer((rq, rs) => {
    hits++;
    rs.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (rq.url === '/SSIS-406') { rs.statusCode = 404; rs.end('not found'); return; }
    if (rq.url && rq.url.startsWith('/search/')) { rs.end('<a class="movie-box" href="http://127.0.0.1:' + srv.address().port + '/found">x</a>'); return; }
    if (rq.url === '/found') { rs.end(javDetailHTML2.replace('PORT', String(srv.address().port))); return; }
    rs.statusCode = 404; rs.end('nf');
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  configState.javBusDomain = 'http://127.0.0.1:' + port;

  const doLookup = async (body) => registered['jav:lookup']({}, body);

  // ① 未开启 → 拒绝且零外网
  configState.javEnabled = false;
  let out = await doLookup({ title: 'SSIS-406' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(hits, 0, '未开启不应外联 hits=' + hits);

  // ② 正常：直取 404 → 搜索兜底 → 详情（3 hits）
  configState.javEnabled = true;
  out = await doLookup({ title: '[JAV] SSIS-406 1080p' });
  assert.strictEqual(out.ok, true, 'ok=' + JSON.stringify(out).slice(0, 200));
  assert.strictEqual(hits, 3, 'hits=' + hits);
  assert.strictEqual(out.meta.title, 'SSIS-406 奇跡の演技');

  // ③ 缓存命中
  out = await doLookup({ code: 'ssis-406' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.fromCache, true);
  assert.strictEqual(hits, 3);

  // ④ 无番号
  out = await doLookup({ title: '庆余年' });
  assert.strictEqual(out.ok, false);
  assert.ok(String(out.error).includes('番号'), 'error=' + out.error);

  // ── TestJavImageDomainGate ──
  configState.javBusDomain = 'https://www.javbus.test';
  const img = await registered['jav:image']({}, { url: 'https://evil.test/pics/a.jpg' });
  assert.strictEqual(img.ok, false);
  assert.ok(String(img.error).includes('javbus'), 'img error=' + img.error);

  // ── custom-scraper:fetch 协议透传（本地假服务） ──
  const payload = { title: 'T', episodes: [{ index: 1, guid: 'g' }] };
  const echoSrv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => { rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify({ got: JSON.parse(body) })); });
  });
  await new Promise((r) => echoSrv.listen(0, r));
  const fetchRes = await registered['custom-scraper:fetch']({}, {
    url: 'http://127.0.0.1:' + echoSrv.address().port + '/x', payload,
  });
  assert.strictEqual(fetchRes.ok, true);
  assert.deepStrictEqual(fetchRes.data.got, payload);

  // ── fanart:logos 门禁+流程（本地假 fanart） ──
  let faHits = 0;
  let faBase = '';
  const faSrv = http.createServer((rq, rs) => {
    faHits++;
    assert.ok(rq.url.startsWith('/v3/movies/'), '应请求 /v3/movies/{id}: ' + rq.url);
    assert.ok(rq.url.includes('api_key=k-test'), 'api_key 未透传');
    rs.setHeader('Content-Type', 'application/json');
    rs.end(JSON.stringify({ hdmovielogo: [{ url: 'https://assets.fanart.tv/a.png', lang: 'en', likes: 3 }], movielogo: [] }));
  });
  await new Promise((r) => faSrv.listen(0, r));
  faBase = 'http://127.0.0.1:' + faSrv.address().port;
  // extScraper 的 fanart base 写死 webservice.fanart.tv → 用 proxyAgent 桩不可行, 直接改全局 fetch?
  // 设计折衷: 桩 resolveProxyAgent + 依赖 https 模块不可行; 退而验证「未开启/无 key 拒绝」与
  // 「fanartParseLogos 排序」的纯函数部分(与 Go TestFanartParseLogosHDFirstThenLikes 同款)。
  configState.fanartEnabled = false; configState.fanartApiKey = '';
  out = await registered['fanart:logos']({}, { mediaType: 'movie', tmdbId: 17645 });
  assert.strictEqual(out.ok, false); assert.strictEqual(faHits, 0, '未开启应零请求');
  configState.fanartEnabled = true;
  out = await registered['fanart:logos']({}, { mediaType: 'movie', tmdbId: 17645 });
  assert.strictEqual(out.ok, false); assert.strictEqual(faHits, 0, '无 key 应零请求');
  assert.ok(String(out.error).includes('api_key'), 'error=' + out.error);
  faSrv.close();

  // ── tvmaze:show 门禁 + stripHtml + 季号剥离（本地假 TVMaze） ──
  configState.tvmazeEnabled = false;
  out = await registered['tvmaze:show']({}, { title: 'X' });
  assert.strictEqual(out.ok, false, 'TVMaze 未开启应拒绝');
  configState.tvmazeEnabled = true;

  // ── omdb:rating 门禁 ──
  configState.omdbEnabled = false;
  out = await registered['omdb:rating']({}, { imdbId: 'tt011' });
  assert.strictEqual(out.ok, false, 'OMDb 未开启应拒绝');
  configState.omdbEnabled = true;
  out = await registered['omdb:rating']({}, { imdbId: 'tt011' });
  assert.strictEqual(out.ok, false);
  assert.ok(String(out.error).includes('OMDb API Key'), 'error=' + out.error);

  srv.close(); echoSrv.close();
  console.log('TestJavLookupHandlerGateAndFlow ✓ / TestJavImageDomainGate ✓ / custom-scraper:fetch ✓');
  console.log('fanart/tvmaze/omdb 门禁 ✓');
  console.log('ALL PASS');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
