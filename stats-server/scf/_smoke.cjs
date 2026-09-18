// 临时冒烟测试（内存 mock cos-nodejs-sdk-v5）：验证内存聚合落盘 / 去重 / 统计合并 / 鉴权
// 运行：node _smoke.cjs
const Module = require('module');

const store = new Map(); // key → object
let putCalls = 0;
let getCalls = 0;

class MockCOS {
  putObject({ Key, Body }, cb) {
    putCalls++;
    store.set(Key, JSON.parse(Body.toString('utf8')));
    setTimeout(() => cb(null, { ETag: 'mock' }), 0);
  }
  getObject({ Key }, cb) {
    getCalls++;
    const v = store.get(Key);
    setTimeout(() => (v === undefined ? cb({ statusCode: 404 }, null) : cb(null, { Body: Buffer.from(JSON.stringify(v)) })), 0);
  }
  getBucket({ Prefix, MaxKeys }, cb) {
    const keys = Array.from(store.keys()).filter((k) => k.startsWith(Prefix)).slice(0, MaxKeys || 1000);
    setTimeout(() => cb(null, { Contents: keys.map((k) => ({ Key: k })) }), 0);
  }
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'cos-nodejs-sdk-v5') return MockCOS;
  return origLoad.apply(this, arguments);
};

process.env.COS_BUCKET = 'mock-bucket-1250000000';
process.env.COS_REGION = 'ap-shanghai';
process.env.STATS_TOKEN = 'my-token';

const fn = require('./index.js');

const assert = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' → ' + extra : ''));
const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const aid = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;
const call = (p, method = 'POST', body = null, qs = {}) => fn.main_handler({
  path: p, httpMethod: method, body: body ? JSON.stringify(body) : '', queryString: qs,
});

(async () => {
  // 1. 50 个人上报 → 内存攒批触发一次落盘
  for (let i = 1; i <= 50; i++) {
    const r = await call('/ping', 'POST', { aid: aid(i), v: '3.7.0', os: 'Windows', arch: 'x64', d: day });
    if (r.statusCode !== 200) assert('ping #' + i, false, JSON.stringify(r));
  }
  const doc = store.get(`ping/${day}.json`);
  assert('50 次上报合并成 1 个文件', !!doc && doc.aids.length === 50, doc ? 'aids=' + doc.aids.length : 'no file');
  assert('落盘调用次数 = 1（GET+PUT 各一次）', putCalls === 1 && getCalls === 1, `put=${putCalls} get=${getCalls}`);

  // 2. 重复上报（内存去重）
  const before = putCalls + getCalls;
  const dup = await call('/ping', 'POST', { aid: aid(1), v: '3.7.0', os: 'Windows', arch: 'x64', d: day });
  assert('同实例重复上报被去重且零 IO', dup.statusCode === 200 && putCalls + getCalls === before);

  // 3. 再来 50 个不同用户 → 读改写累加
  for (let i = 51; i <= 100; i++) {
    await call('/ping', 'POST', { aid: aid(i), v: '3.7.0', os: 'Windows', arch: 'x64', d: day });
  }
  assert('第二批累加到 100（读-改-写生效）', store.get(`ping/${day}.json`).aids.length === 100, 'aids=' + store.get(`ping/${day}.json`).aids.length);

  // 4. 非法参数
  assert('拒绝非法 aid', (await call('/ping', 'POST', { aid: 'DROP', d: day })).statusCode === 400);
  assert('拒绝离谱日期', (await call('/ping', 'POST', { aid: aid(900), d: '1999-01-01' })).statusCode === 400);
  assert('未知路径 404', (await call('/nope', 'GET')).statusCode === 404);

  // 5. 反馈 + 日志
  const fb = await call('/feedback', 'POST', { aid: aid(1), v: '3.7.0', os: 'Windows', message: '播放闪退', log: 'line1\nline2' });
  const fbBody = JSON.parse(fb.body);
  assert('feedback 落盘', fbBody.ok === true && Array.from(store.keys()).some((k) => k.endsWith('-' + fbBody.id + '.json')));
  assert('取回日志', (await call('/stats/log', 'GET', null, { token: 'my-token', id: fbBody.id })).body === 'line1\nline2');
  assert('空描述被拒', (await call('/feedback', 'POST', { message: '   ' })).statusCode === 400);

  // 6. 统计
  const statsRes = await call('/stats', 'GET', null, { token: 'my-token', days: '7' });
  const st = JSON.parse(statsRes.body);
  assert('stats 去重人数 = 100', st.users.distinct === 100, JSON.stringify(st.users));
  assert('今日人次 = 100', st.users.today === 100, JSON.stringify(st.users));
  assert('系统分布', st.systems.length === 1 && st.systems[0].os === 'Windows', JSON.stringify(st.systems));
  assert('反馈计数 = 1', st.feedbackCount === 1 && st.recentFeedback[0].msg === '播放闪退', JSON.stringify(st.recentFeedback));
  assert('stats 错 token 403', (await call('/stats', 'GET', null, { token: 'x' })).statusCode === 403);
  assert('根路径健康检查', (await call('/', 'GET')).statusCode === 200);

  console.log(`\nIO 汇总：PUT ${putCalls} 次 / GET ${getCalls} 次，承载 102 次心跳 + 1 条反馈`);
})();
