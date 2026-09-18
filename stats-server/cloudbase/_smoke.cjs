// 临时冒烟测试（内存 mock @cloudbase/node-sdk）：验证聚合落库 / 去重 / 鉴权 / 反馈取回
// 运行：node _smoke.cjs   （不需要真的云开发环境）
const Module = require('module');

const store = { ping: [], feedback: [] };
let addCalls = 0; // 统计数据库写入「调用次数」（省钱关键指标）

function mkAgg(name) {
  const self = {
    match() { return self; },
    group() { return self; },
    sort() { return self; },
    limit() { return self; },
    async end() { return { data: [] }; },
  };
  return self;
}

function mkCollection(name) {
  const col = {
    async add(docs) {
      addCalls++;
      const arr = Array.isArray(docs) ? docs : [docs];
      const dup = arr.some((d) => store[name].some((x) => x._id === d._id));
      if (dup) throw new Error('duplicate _id');
      store[name].push(...arr);
      return { ids: arr.map((d) => d._id) };
    },
    async count() { addCalls++; return { total: store[name].length }; },
    doc(id) {
      return { async get() { addCalls++; return { data: store[name].filter((x) => x._id === id) }; } };
    },
    aggregate() { addCalls++; return mkAgg(name); },
    orderBy() { return col; },
    limit() { return col; },
    field() { return col; },
    async get() { addCalls++; return { data: [] }; },
  };
  return col;
}

const mockSdk = {
  SYMBOL_CURRENT_ENV: 'mock-env',
  init() {
    return {
      database() {
        return {
          collection: (n) => mkCollection(n),
          command: {
            aggregate: { sum: (v) => ({ sum: v }) },
            gte: (v) => ({ gte: v }),
          },
        };
      },
    };
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@cloudbase/node-sdk') return mockSdk;
  return origLoad.apply(this, arguments);
};

const fn = require('./functions/fntv-stats/index.js');

const assert = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' → ' + extra : ''));
const call = (p, method = 'POST', body = null, qs = {}) => fn.main({
  path: p, httpMethod: method, body: body ? JSON.stringify(body) : '', queryStringParameters: qs,
});

process.env.STATS_TOKEN = 'my-token'; // 真实部署在云函数环境变量里配

(async () => {
  const day = new Date().toISOString().slice(0, 10);
  const aid = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;

  // 1. 50 次不同用户 → 攒够 50 条触发一次批量落库
  for (let i = 1; i <= 50; i++) {
    const r = await call('/ping', 'POST', { aid: aid(i), v: '3.7.0', os: 'Windows', arch: 'x64', d: day });
    if (r.statusCode !== 200) assert('ping 第 ' + i + ' 次', false, JSON.stringify(r));
  }
  assert('50 次上报落库 50 条', store.ping.length === 50, '实际 ' + store.ping.length);
  assert('数据库写入调用次数 ≤ 2（聚合生效）', addCalls <= 2, '实际 ' + addCalls + ' 次（不聚合会是 50 次）');

  // 2. 重复上报（同实例内命中内存去重 → 0 成本）
  const before = addCalls;
  const dup = await call('/ping', 'POST', { aid: aid(1), v: '3.7.0', os: 'Windows', arch: 'x64', d: day });
  assert('重复上报被内存去重', dup.statusCode === 200 && addCalls === before, '调用次数 ' + before + '→' + addCalls);
  assert('重复未产生新记录', store.ping.filter((x) => x._id === aid(1) + '_' + day).length === 1);

  // 3. 非法数据
  assert('拒绝非法 aid', (await call('/ping', 'POST', { aid: 'DROP', d: day })).statusCode === 400);
  assert('拒绝离谱日期', (await call('/ping', 'POST', { aid: aid(99), d: '1999-01-01' })).statusCode === 400);
  assert('未知路径 404', (await call('/nope', 'GET')).statusCode === 404);

  // 4. 反馈 + 日志
  const fb = await call('/feedback', 'POST', { aid: aid(1), v: '3.7.0', os: 'Windows', message: '播放闪退', log: 'line1\nline2' });
  const fbBody = JSON.parse(fb.body);
  assert('feedback 提交', fb.ok !== false && fbBody.ok === true && !!fbBody.id, fb.body);
  assert('日志入库', store.feedback[0] && store.feedback[0].log === 'line1\nline2');
  assert('反馈 id 可取回日志', (await call('/stats/log', 'GET', null, { token: 'my-token', id: fbBody.id })).body === 'line1\nline2');
  assert('空描述被拒', (await call('/feedback', 'POST', { message: '  ' })).statusCode === 400);

  // 5. 鉴权
  assert('stats 错 token 403', (await call('/stats', 'GET', null, { token: 'wrong' })).statusCode === 403);
  assert('stats 正确 token 200', (await call('/stats', 'GET', null, { token: 'my-token' })).statusCode === 200);
  assert('stats/log 错 token 403', (await call('/stats/log', 'GET', null, { token: 'wrong', id: fbBody.id })).statusCode === 403);

  console.log('\n数据库调用总次数（mock 口径）：' + addCalls + '，其中 50 次心跳只占 ≤2 次');
})();
