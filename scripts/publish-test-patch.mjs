#!/usr/bin/env node
/**
 * [lc-patchfix] 发布「测试补丁」到 Gitee 测试仓库 YDMY007/fntv-plus-test。
 * 与正式发布不同：测试补丁覆盖 dev/dest 的全部 main+preload 插件（含 00_patchfix 修正解析器垫片），
 * 用于在没有重构 base 的旧 base(如 3.4.0) 上验证累积修复。
 *
 * 需要环境变量 GITEE_TOKEN（测试仓库写入权限）。
 * 用法: GITEE_TOKEN=xxx node scripts/publish-test-patch.mjs <version> <minAppVersion>
 *   例: GITEE_TOKEN=xxx node scripts/publish-test-patch.mjs 3.4.1-test2 3.4.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv;
const version = argv[2];
let minAppVersion = argv[3] || '3.4.0';
if (!version) {
    console.error('用法: node scripts/publish-test-patch.mjs <version> <minAppVersion>');
    process.exit(1);
}

const GITEE_TOKEN = process.env.GITEE_TOKEN || '';
if (!GITEE_TOKEN) {
    console.error('缺少 GITEE_TOKEN 环境变量（测试仓库写入权限）');
    process.exit(1);
}
const OWNER = 'YDMY007';
const REPO = 'fntv-plus-test';
const api = (p, opts = {}) => fetch(`https://gitee.com/api/v5/repos/${OWNER}/${REPO}/${p}`, {
    ...opts,
    headers: { 'User-Agent': 'fnos-tv-publish', 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const apiQ = (p) => `${p}${p.includes('?') ? '&' : '?'}access_token=${GITEE_TOKEN}`;

// 1) 收集 dest 下所有插件文件
const collected = [];
for (const sub of ['main/handlers/plugins', 'preload/plugins']) {
    const dir = path.join(root, 'dest', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.js')) {
            const abs = path.join(dir, f);
            const rel = `${sub}/${f}`.replace(/\\/g, '/');
            collected.push({ target: rel, b64: fs.readFileSync(abs).toString('base64') });
        }
    }
}
if (!collected.length) {
    console.error('未收集到任何插件文件');
    process.exit(1);
}

const manifest = { version, minAppVersion, files: collected };
const outName = `patch-${version}.json`;
const outPath = path.join(root, outName);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`[publish-test] 已生成 ${outName}（${collected.length} 个文件）`);

// 2) 创建/获取 Release（tag = v<version>）
const tag = version.startsWith('v') ? version : `v${version}`;
let release;
const relRes = await api(apiQ(`releases/tags/${tag}`));
if (relRes.ok) release = await relRes.json();
if (!release) {
    const cRes = await api(apiQ('releases'), {
        method: 'POST',
        body: JSON.stringify({ tag_name: tag, name: `测试补丁 ${tag}`, body: `测试补丁 ${version}`, prerelease: true, target_commitish: 'master' }),
    });
    if (cRes.ok) release = await cRes.json();
}
if (!release || !release.id) {
    console.error('[publish-test] 创建/获取 Release 失败');
    process.exit(1);
}
console.log(`[publish-test] Release: ${release.id} (${tag})`);

// 3) 上传资产（先删旧）
for (const a of (release.assets || [])) {
    if (a.name === outName) {
        await api(apiQ(`releases/${release.id}/attach_files/${a.id}`), { method: 'DELETE' });
        console.log(`[publish-test] 已删除旧资产 ${a.name}`);
    }
}
const buf = fs.readFileSync(outPath);
const form = new FormData();
form.append('file', new Blob([buf], { type: 'application/json' }), outName);
const upRes = await fetch(`https://gitee.com/api/v5/repos/${OWNER}/${REPO}/releases/${release.id}/attach_files?access_token=${GITEE_TOKEN}`, {
    method: 'POST',
    headers: { 'User-Agent': 'fnos-tv-publish' },
    body: form,
});
if (!upRes.ok) {
    console.error('[publish-test] 上传资产失败:', await upRes.text().catch(() => ''));
    process.exit(1);
}
console.log(`[publish-test] 已上传资产 ${outName}`);

// 4) 更新 test-index.json（追加/替换该 version 入口）
const patchUrl = `https://gitee.com/${OWNER}/${REPO}/releases/download/${tag}/${outName}`;
const idxPath = 'resource/wiki/test-index.json';
const idxRes = await api(apiQ(`contents/${idxPath}`));
let entries = [];
let idxSha = '';
if (idxRes.ok) {
    const j = await idxRes.json();
    idxSha = j.sha;
    try { entries = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8')); } catch { entries = []; }
}
const notes = `测试补丁 ${version}：累积修复覆盖（含主进程热补丁 require 解析修正垫片，兼容旧 base）。`;
const existing = entries.find((e) => e.version === version);
if (existing) { existing.patchUrl = patchUrl; existing.notes = notes; }
else entries.unshift({ version, patchUrl, notes });
const putRes = await api(apiQ(`contents/${idxPath}`), {
    method: 'PUT',
    body: JSON.stringify({
        content: Buffer.from(JSON.stringify(entries, null, 2), 'utf-8').toString('base64'),
        sha: idxSha,
        message: `test-index: add ${version}`,
    }),
});
if (!putRes.ok) {
    console.error('[publish-test] 更新 test-index.json 失败:', await putRes.text().catch(() => ''));
    process.exit(1);
}
console.log(`[publish-test] 已更新 test-index.json，新增/更新入口: ${version}`);
console.log(`[publish-test] 完成。用户端「获取测试更新」选择 ${version} 即可拉取。`);
