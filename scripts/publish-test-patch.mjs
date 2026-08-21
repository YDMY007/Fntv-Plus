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

// 1) 收集 dest 下所有插件文件（modules/ 为子目录结构，需递归）
const collected = [];
const collectJs = (absDir, relPrefix) => {
    for (const f of fs.readdirSync(absDir)) {
        const abs = path.join(absDir, f);
        const rel = `${relPrefix}/${f}`.replace(/\\/g, '/');
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
            collectJs(abs, rel);
        } else if (f.endsWith('.js')) {
            collected.push({ target: rel, b64: fs.readFileSync(abs).toString('base64') });
        }
    }
};
for (const sub of ['main/handlers/plugins', 'preload/plugins', 'modules']) {
    const dir = path.join(root, 'dest', sub);
    if (!fs.existsSync(dir)) continue;
    collectJs(dir, sub);
}

// [lc-653] --include-proxy：附带 Go 代理二进制覆盖层（bin/proxy(.exe)），
// 使 Go 侧修复（如 m3u8 重写）也可经热补丁生效。二进制较大，默认不带。
const includeProxy = argv.includes('--include-proxy');
if (includeProxy) {
    const proxyCandidates = [
        path.join(root, 'third_party', 'proxy', 'proxy.exe'),
        path.join(root, 'third_party', 'proxy', 'proxy'),
    ];
    const proxyBin = proxyCandidates.find((p) => fs.existsSync(p));
    if (proxyBin) {
        const target = proxyBin.endsWith('.exe') ? 'bin/proxy.exe' : 'bin/proxy';
        collected.push({ target, b64: fs.readFileSync(proxyBin).toString('base64') });
        console.log(`[publish-test] 附带二进制覆盖层: ${target} (${fs.statSync(proxyBin).size} bytes)`);
    } else {
        console.warn('[publish-test] --include-proxy 但未找到 proxy 二进制，跳过');
    }
}

if (!collected.length) {
    console.error('未收集到任何插件文件');
    process.exit(1);
}

const manifest = { version, minAppVersion, files: collected };
const outName = `patch-${version}.json`;
const outPath = path.join(root, 'patches', outName);
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
