// 临时冒烟测试（验证完即删）：用内存 SQLite 跑 worker.js 的三个接口
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker.js';

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const r2 = new Map();
const env = {
  STATS_TOKEN: 'test-token',
  DB: {
    async batch(list) { for (const s of list) { await s.run(); } },
    prepare(sql) {
      const api = {
        bind(...args) {
          return {
            async run() { db.prepare(sql).run(...args); },
            async first() { return db.prepare(sql).get(...args); },
            async all() { return { results: db.prepare(sql).all(...args) }; },
          };
        },
        async run() { db.prepare(sql).run(); },
        async first() { return db.prepare(sql).get(); },
        async all() { return { results: db.prepare(sql).all() }; },
      };
      return api;
    },
  },
  LOGS: {
    async put(k, v) { r2.set(k, v); },
    async get(k) { return r2.has(k) ? { async text() { return r2.get(k); } } : null; },
  },
};

const today = new Date().toISOString().slice(0, 10);
const post = (p, body) => worker.fetch(new Request('https://x' + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env);
const get = (p) => worker.fetch(new Request('https://x' + p), env);

const assert = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' → ' + extra : ''));

// 1. 正常上报
let r = await post('/ping', { aid: 'aaaaaaaa-1111-2222-3333-444444444444', v: '3.7.0', os: 'Windows', arch: 'x64', d: today });
assert('ping 首次', r.status === 200, 'status=' + r.status);
// 2. 同日重复上报（应被去重）
await post('/ping', { aid: 'aaaaaaaa-1111-2222-3333-444444444444', v: '3.7.0', os: 'Windows', arch: 'x64', d: today });
await post('/ping', { aid: 'aaaaaaaa-1111-2222-3333-444444444444', v: '3.7.0', os: 'Windows', arch: 'x64', d: today });
// 3. 另一个人
await post('/ping', { aid: 'bbbbbbbb-1111-2222-3333-444444444444', v: '3.7.0', os: 'macOS', arch: 'arm64', d: today });
// 4. 非法 payload
r = await post('/ping', { aid: 'DROP TABLE', d: today });
assert('ping 拒绝非法 aid', r.status === 400, 'status=' + r.status);
r = await post('/ping', { aid: 'cccccccc-1111-2222-3333-444444444444', d: '1999-01-01' });
assert('ping 拒绝离谱日期', r.status === 400, 'status=' + r.status);

// 5. 统计（去重后应为 2 人）
r = await get('/stats?token=test-token');
const s = await r.json();
assert('stats 鉴权通过', r.status === 200);
assert('总人数=2（同 ID 同日去重）', s.users.total === 2, JSON.stringify(s.users));
assert('今日活跃=2', s.users.today === 2, JSON.stringify(s.users));
assert('系统分布 2 类', s.systems.length === 2, JSON.stringify(s.systems));
r = await get('/stats?token=wrong');
assert('stats 错误 token 拒绝', r.status === 403, 'status=' + r.status);

// 5b. 补报：一次带多天（断网几天后网络恢复，客户端把欠报的日期一起发来）
const y1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const y2 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const back = await post('/ping', { aid: 'dddddddd-1111-2222-3333-444444444444', v: '3.7.0', os: 'Windows', d: today, days: [today, y1, y2] });
assert('补报 days 数组被接受', back.status === 200, 'status=' + back.status);
const rows = db.prepare("SELECT day FROM ping WHERE aid='dddddddd-1111-2222-3333-444444444444'").all();
assert('补报写入 3 天记录', rows.length === 3, JSON.stringify(rows.map((r) => r.day)));
const tooOld = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
assert('补报超过 7 天被拒', (await post('/ping', { aid: 'eeeeeeee-1111-2222-3333-444444444444', d: tooOld, days: [tooOld] })).status === 400);

// 6. 反馈 + 日志
r = await post('/feedback', { aid: 'aaaaaaaa-1111-2222-3333-444444444444', v: '3.7.0', os: 'Windows', message: '播放闪退', contact: 'me@qq.com', log: 'line1\nline2' });
const fb = await r.json();
assert('feedback 提交', fb.ok === true && !!fb.id, JSON.stringify(fb));
assert('日志进 R2', r2.has(`logs/${fb.id}.log`));
r = await get(`/stats/log?id=${fb.id}&token=test-token`);
assert('作者可取回日志', (await r.text()) === 'line1\nline2');
r = await post('/feedback', { message: '   ' });
assert('feedback 拒绝空描述', r.status === 400, 'status=' + r.status);
r = await get('/stats?token=test-token');
assert('统计里反馈计数=1', (await r.json()).feedbackCount === 1);

// 7. 404
r = await get('/nope');
assert('未知路径 404', r.status === 404, 'status=' + r.status);
