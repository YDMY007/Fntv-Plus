#!/usr/bin/env node
/**
 * [lc-474] 一键发布热补丁。
 *
 * 用法:
 *   node scripts/publish-patch.mjs <version> <dest文件1> [<dest文件2> ...]
 * 例:
 *   node scripts/publish-patch.mjs 1.2.3 dest/preload/plugins/embyWall.js dest/main/handlers/plugins/media.js
 *
 * 行为:
 *   1. 读取各 dest 文件, base64 编码;
 *   2. 生成 patch-<version>.json(含 version / minAppVersion / files[]);
 *      - target 自动去掉开头的 dest/ 前缀(如 dest/preload/plugins/x.js -> preload/plugins/x.js)
 *   3. 若检测到 gh CLI 且环境有 GITHUB_TOKEN, 自动 `gh release upload v<version>`;
 *      否则仅把 json 写到项目根目录, 并打印手动上传说明。
 *
 * 说明: 本脚本只负责"出包+上传", 不自动 git push。Release/标签需你已存在(或用 gh 创建)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

function fail(msg) {
    console.error('[publish-patch] ' + msg);
    process.exit(1);
}

const [, , version, ...files] = process.argv;
if (!version || files.length === 0) {
    fail('用法: node scripts/publish-patch.mjs <version> <dest文件1> [<dest文件2> ...]');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const minAppVersion = pkg.version || version;

const manifest = {
    version,
    minAppVersion,
    files: [],
};

for (const f of files) {
    const abs = path.resolve(root, f);
    if (!fs.existsSync(abs)) fail(`文件不存在: ${f}`);
    const rel = f.replace(/\\/g, '/').replace(/^dest\//, '');
    if (!/^(preload|main)\//.test(rel)) fail(`仅支持 dest/preload/... 或 dest/main/... 路径, 收到: ${f}`);
    const b64 = fs.readFileSync(abs).toString('base64');
    manifest.files.push({ target: rel, b64 });
    console.log(`[publish-patch] 已纳入: ${rel} (${(b64.length / 1024).toFixed(1)} KB base64)`);
}

const outName = `patch-${version}.json`;
const outPath = path.join(root, outName);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`[publish-patch] 已生成 ${outName}`);

// 尝试用 gh 上传到 Release(标签 v<version>)
let uploaded = false;
try {
    execSync('gh --version', { stdio: 'ignore' });
    const tag = version.startsWith('v') ? version : 'v' + version;
    console.log(`[publish-patch] 通过 gh 上传到 Release ${tag} ...`);
    execSync(`gh release upload ${tag} ${outName} --clobber`, { stdio: 'inherit', cwd: root });
    uploaded = true;
    console.log(`[publish-patch] 上传完成。应用内点「应用补丁」即可拉取 v${version}。`);
} catch (e) {
    console.log('[publish-patch] 未检测到 gh CLI 或上传失败, 改用手动上传。');
}

if (!uploaded) {
    console.log(`\n请手动把 ${outName} 上传为 GitHub Release(v${version}) 的附件:`);
    console.log(`  1. 打开 https://github.com/YDMY007/Fntv-Plus/releases/tag/v${version}`);
    console.log(`  2. 把 ${outName} 作为资产(Asset)上传;`);
    console.log(`  3. 应用内点「应用补丁」即可拉取。\n`);
    console.log(`(也可安装 gh CLI 并配置 GITHUB_TOKEN 后重跑本脚本自动上传)`);
}
