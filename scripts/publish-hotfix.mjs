#!/usr/bin/env node
/**
 * [lc-patchfix] 发布「正式热补丁」到国内 Gitee 主仓库 YDMY007/fntv-plus。
 *
 * 与测试仓库不同：正式热补丁面向普通用户「应用补丁」按钮，
 * 读取源是 Gitee raw(update-check.json) -> patchUrl -> patch-<version>.json。
 *
 * 需要环境变量 GITEE_TOKEN（主仓库写入权限）。
 * 用法: GITEE_TOKEN=xxx node scripts/publish-hotfix.mjs <version> <minAppVersion>
 *   例: GITEE_TOKEN=xxx node scripts/publish-hotfix.mjs 3.4.1-hotfix 3.4.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv;
const version = argv[2];
let minAppVersion = argv[3] || '3.4.0';
if (!version) {
    console.error('用法: node scripts/publish-hotfix.mjs <version> <minAppVersion>');
    process.exit(1);
}

const GITEE_TOKEN = process.env.GITEE_TOKEN || '';
if (!GITEE_TOKEN) {
    console.error('缺少 GITEE_TOKEN 环境变量（主仓库写入权限）');
    process.exit(1);
}
const OWNER = 'YDMY007';
const REPO = 'fntv-plus';
const BRANCH = 'release';
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
console.log(`[publish-hotfix] 已生成 ${outName}（${collected.length} 个文件）`);

// 2) 创建/获取 Release（tag = v<version>）
const tag = version.startsWith('v') ? version : `v${version}`;
let release;
const relRes = await api(apiQ(`releases/tags/${tag}`));
if (relRes.ok) release = await relRes.json();
if (!release) {
    const cRes = await api(apiQ('releases'), {
        method: 'POST',
        body: JSON.stringify({ tag_name: tag, name: `热补丁 ${tag}`, body: `热补丁 ${version}`, prerelease: true, target_commitish: BRANCH }),
    });
    if (cRes.ok) release = await cRes.json();
}
if (!release || !release.id) {
    console.error('[publish-hotfix] 创建/获取 Release 失败');
    process.exit(1);
}
console.log(`[publish-hotfix] Release: ${release.id} (${tag})`);

// 3) 上传资产（先删旧）
for (const a of (release.assets || [])) {
    if (a.name === outName) {
        await api(apiQ(`releases/${release.id}/attach_files/${a.id}`), { method: 'DELETE' });
        console.log(`[publish-hotfix] 已删除旧资产 ${a.name}`);
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
    console.error('[publish-hotfix] 上传资产失败:', await upRes.text().catch(() => ''));
    process.exit(1);
}
console.log(`[publish-hotfix] 已上传资产 ${outName}`);

// 4) 更新 update-check.json（version + patchUrl）并推到 release 分支
const patchUrl = `https://gitee.com/${OWNER}/${REPO}/releases/download/${tag}/${outName}`;
const ucPath = path.join(root, 'resource', 'wiki', 'update-check.json');
let uc;
try { uc = JSON.parse(fs.readFileSync(ucPath, 'utf-8')); }
catch { uc = {}; }
uc.version = version;
uc.patchUrl = patchUrl;
fs.writeFileSync(ucPath, JSON.stringify(uc, null, 2));
console.log(`[publish-hotfix] 本地 update-check.json 已写入 patchUrl`);

const idxRes = await api(apiQ(`contents/resource/wiki/update-check.json`));
if (idxRes.ok) {
    const j = await idxRes.json();
    const putRes = await api(apiQ(`contents/resource/wiki/update-check.json`), {
        method: 'PUT',
        body: JSON.stringify({
            content: Buffer.from(JSON.stringify(uc, null, 2), 'utf-8').toString('base64'),
            sha: j.sha,
            message: `update-check: ${version}`,
            branch: BRANCH,
        }),
    });
    if (!putRes.ok) {
        console.error('[publish-hotfix] 更新 update-check.json 失败:', await putRes.text().catch(() => ''));
        process.exit(1);
    }
    console.log(`[publish-hotfix] 已推送 update-check.json 到 ${BRANCH} 分支`);
} else {
    console.error('[publish-hotfix] 读取 update-check.json 失败（无法推送）');
    process.exit(1);
}

console.log(`[publish-hotfix] 完成。普通用户「应用补丁」将拉取 v${version}。`);
