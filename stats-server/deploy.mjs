/**
 * Fntv-Plus 统计/反馈服务端 —— Cloudflare 一键部署助手
 *
 * 用法（在普通终端里跑，不要在 AI 工具的沙箱终端里跑）：
 *   cd stats-server
 *   node deploy.mjs
 *
 * 它会依次：登录 → 建 D1 → 建表 → 建 R2 → 设口令 → 部署，
 * 并把自动解析出来的 database_id 写回 wrangler.toml、把 Worker 地址打印给你。
 * 需要交互的步骤（浏览器授权、输入口令）会直接把控制权交给你。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOML = path.join(HERE, 'wrangler.toml');
const DB_NAME = 'fntv-stats';
const BUCKET = 'fntv-stats-logs';

const step = (n, title) => console.log(`\n========== [${n}/6] ${title} ==========`);
const warn = (msg) => console.log(`\n⚠ ${msg}`);

/** 跑一条命令；inherit=true 时把终端交互（授权页/输入口令）交给用户 */
function run(args, { inherit = false, silent = false } = {}) {
  const r = spawnSync('npx', args, {
    cwd: HERE,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (!silent && !inherit && r.status !== 0) {
    console.log((r.stderr || '').trim().split('\n').slice(-8).join('\n'));
  }
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function hasD1Id() {
  if (!fs.existsSync(TOML)) return false;
  const t = fs.readFileSync(TOML, 'utf8');
  return !/database_id\s*=\s*"?在这里填/.test(t) && /database_id\s*=\s*"[0-9a-fA-F-]{8,}"/.test(t);
}

/** 从 `wrangler d1 create` 的输出里抓 database_id 并写回 wrangler.toml */
function applyDatabaseId(output) {
  const m = output.match(/database_id\s*=\s*"([0-9a-fA-F-]{8,})"/);
  if (!m) return null;
  let toml = fs.readFileSync(TOML, 'utf8');
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${m[1]}"`);
  fs.writeFileSync(TOML, toml, 'utf8');
  console.log(`✔ 已写入 wrangler.toml: database_id = ${m[1]}`);
  return m[1];
}

function askContinue(msg) {
  return new Promise((resolve) => {
    process.stdout.write(`\n${msg}\n按回车继续（Ctrl+C 中止）… `);
    process.stdin.once('data', () => resolve());
  });
}

(async () => {
  console.log('Fntv-Plus 匿名统计 / 反馈 —— Cloudflare 部署助手');
  console.log('全程免费额度；需要浏览器授权与一次口令输入，其余自动完成。\n');

  // 1. 登录
  step(1, '登录 Cloudflare（浏览器授权）');
  console.log('若已登录过会直接跳过。浏览器会打开授权页，点 Allow 即可。');
  run(['wrangler', 'login'], { inherit: true });

  // 2. D1
  step(2, `创建 D1 数据库 ${DB_NAME}`);
  if (hasD1Id()) {
    console.log('✔ wrangler.toml 里已有 database_id，跳过创建。');
  } else {
    const r = run(['wrangler', 'd1', 'create', DB_NAME]);
    const id = r.ok ? applyDatabaseId(r.out) : null;
    if (!id) {
      warn('没能自动拿到 database_id（可能已存在同名库，或需要手工处理）。');
      console.log(r.out.trim().split('\n').slice(-12).join('\n'));
      await askContinue(`请手动把 database_id 填进 ${TOML} 的 database_id 一行`);
    }
  }

  // 3. 建表
  step(3, '建表（schema.sql）');
  const t = run(['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file=schema.sql']);
  if (!t.ok) {
    warn('建表失败/已建过。若提示表已存在可以忽略，直接进下一步。');
    console.log(t.out.trim().split('\n').slice(-6).join('\n'));
  } else {
    console.log('✔ ping / feedback 两张表已就绪');
  }

  // 4. R2
  step(4, `创建 R2 桶 ${BUCKET}（存反馈日志）`);
  const b = run(['wrangler', 'r2', 'bucket', 'create', BUCKET]);
  if (!b.ok) {
    warn('R2 创建失败（新账号有时要求先验证账户）。');
    console.log('两条路：① 去控制台 R2 页面点创建同名桶；② 暂时不用日志存储 ——');
    console.log(`   把 ${path.basename(TOML)} 里的 [[r2_buckets]] 整段注释掉后重新跑本脚本，`);
    console.log('   统计功能不受影响，只是反馈日志存不下来。');
    await askContinue('处理好 R2 后');
  } else {
    console.log('✔ R2 桶已就绪');
  }

  // 5. 口令
  step(5, '设置查看统计的口令（STATS_TOKEN）');
  console.log('接下来会让你输入一个口令，自己想一个并记住 —— 看数据时要用。');
  run(['wrangler', 'secret', 'put', 'STATS_TOKEN'], { inherit: true });

  // 6. 部署
  step(6, '部署 Worker');
  const d = run(['wrangler', 'deploy']);
  console.log(d.out.trim().split('\n').slice(-16).join('\n'));

  const url = (d.out.match(/https:\/\/[a-zA-Z0-9._-]+\.workers\.dev/) || [])[0];
  if (url) {
    console.log('\n================ 部署完成 ================');
    console.log(`服务端地址： ${url}`);
    console.log(`看数据：     ${url}/stats?token=你刚设的口令`);
    console.log(`取反馈日志： ${url}/stats/log?id=反馈ID&token=你刚设的口令`);
    console.log('\n下一步：把这个地址填进 src/main/handlers/plugins/usageStats.ts 顶部的');
    console.log('        DEFAULT_ENDPOINT，或设环境变量 FNTV_STATS_ENDPOINT，然后 npx tsc。');
    console.log('=========================================');
  } else if (!d.ok) {
    warn('部署未成功，看上面输出排查（常见：database_id 没填、R2 桶不存在、未登录）。');
  }
})();
