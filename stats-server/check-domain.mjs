/**
 * 域名接入自检：查 Cloudflare zone 状态 / Pages 自定义域 / Worker 自定义域，
 * 并实测三个线上入口的 HTTP 状态。
 * 用法：node stats-server/check-domain.mjs
 */
import fs from 'node:fs';

const CFG = 'C:/Users/24305/AppData/Roaming/xdg.config/.wrangler/config/default.toml';
const ACCT = 'd630e2719eac750d3f039e7a54c9cece';
const DOMAIN = '690075.xyz';

let H = {};
try {
  const token = fs.readFileSync(CFG, 'utf8').match(/(?:oauth_token|api_token)\s*=\s*"([^"]+)"/)[1];
  H = { authorization: `Bearer ${token}` };
} catch {
  console.log('（读不到 wrangler 凭证，跳过 API 检查，只做连通性测试）');
}

async function api(path) {
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: H });
    const j = await r.json();
    return j.result;
  } catch (e) {
    return null;
  }
}

if (H.authorization) {
  const zones = await api(`/zones?name=${DOMAIN}`);
  const z = (zones || [])[0];
  console.log('zone 状态      :', z ? `${z.status}${z.status === 'active' ? '  ✅' : '  ⏳ 等 NS 生效'}` : '（域名未加入 Cloudflare）');
  if (z) console.log('  分配的 NS    :', (z.name_servers || []).join(', '));

  const pages = await api(`/accounts/${ACCT}/pages/projects/fntv-plus/domains`);
  console.log('Pages 自定义域 :', (pages || []).map((d) => `${d.name}(${d.status || 'pending'})`).join(', ') || '（无）');

  const workers = await api(`/accounts/${ACCT}/workers/domains`);
  console.log('Worker 自定义域:', (workers || []).map((d) => `${d.hostname}→${d.service}`).join(', ') || '（无）');
}

const targets = [
  ['官网(pages.dev)', 'https://fntv-plus.pages.dev/'],
  ['官网(自有域名)', `https://${DOMAIN}/`],
  ['统计(workers.dev)', 'https://fntv-stats.122983191.workers.dev/'],
  ['统计(自有域名)', 'https://stats.690075.xyz/'],
];
console.log('\n连通性实测：');
for (const [label, url] of targets) {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    console.log(`  ${label.padEnd(18, ' ')} HTTP ${r.status}`);
  } catch (e) {
    console.log(`  ${label.padEnd(18, ' ')} 不可达（${String(e.cause?.code || e.message).slice(0, 40)}）`);
  }
}
