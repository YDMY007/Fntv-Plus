#!/usr/bin/env node
/**
 * [lc-474] 一键发布热补丁。
 *
 * 用法:
 *   node scripts/publish-patch.mjs <version> <dest文件1> [<dest文件2> ...]
 * 例(热补丁):
 *   node scripts/publish-patch.mjs 3.3.7-hotfix dest/preload/plugins/embyWall.js
 * 例(全量, 仅写更新日志通知, 安装包仍走 GitHub):
 *   node scripts/publish-patch.mjs 3.3.7-full
 *
 * 版本号 = 更新日志里的版本(带类型后缀), 不是 Git tag:
 *   - 热补丁: `3.3.7-hotfix` / `3.3.7-hotfix2`  → 应用内判定 hotfix, 弹窗「应用补丁」应用内拉取。
 *   - 全量:   `3.3.7-full`                       → 应用内判定 full, 弹窗引导去 GitHub 下载覆盖安装。
 *   - 测试:   `3.3.7-test` / `3.3.7-test2`       → 开发者自用测试版, 应用内绝不向用户弹窗推送(仅供「应用补丁」按钮手动拉取验证补丁机制)。
 *   - 普通:   `3.3.7`(无后缀)                    → 视为 full。
 * 类型信号 = 更新日志最新 heading 的版本后缀: `## v3.3.7-hotfix (2026-08-11)`。
 *
 * Git Release tag 保持干净(如 v3.3.6, 不带后缀):
 *   - 默认 Git tag = 当前应用版本(pkg.version), 即把补丁追加到"当前在发的那个 Release"上(用户保持 tag 原样);
 *   - 如需指定其它 tag, 设环境变量 GITEE_TAG(如 v3.3.7)。
 * 脚本会把更新日志顶部 heading 写成 `## v<version> (YYYY-MM-DD)`(已存在则替换首行), 供应用内检测。
 *
 * 行为:
 *   1. 读取各 dest 文件, base64 编码;
 *   2. 生成 patch-<version>.json(含 version / minAppVersion / files[]);
 *      - target 自动去掉开头的 dest/ 前缀(如 dest/preload/plugins/x.js -> preload/plugins/x.js)
 *   3. 上传(源优先级 = Gitee 优先, GitHub 次选):
 *      - Gitee: 设 GITEE_TOKEN 后, 自动查/建 Git tag 对应 Release, 把更新日志顶部 heading 写为
 *        `## v<version> (日期)`, 并上传 patch-<version>.json 附件(国内直连); 未设 token 则跳过。
 *      - GitHub: 检测到 gh CLI 且有 GITHUB_TOKEN 时, `gh release upload v<version>` 作次选保底。
 *      - 两者都不可用则仅把 json 写到项目根目录, 并打印手动上传说明。
 *
 * 说明: 本脚本只负责"出包+上传", 不自动 git push。
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

// ---------- Gitee 优先上传 ----------
const GITEE_OWNER = 'YDMY007';
const GITEE_REPO = 'fntv-plus';
const GITEE_TOKEN = process.env.GITEE_TOKEN || '';
const giteeApi = (p) => `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/${p}`;

async function giteeUpload(tag, filePath, fileName) {
    if (!GITEE_TOKEN) {
        console.log('[publish-patch] 未设置 GITEE_TOKEN 环境变量, 跳过 Gitee 上传(应用内拉包仍可走 GitHub 镜像)。');
        return false;
    }
    const H = { 'User-Agent': 'fnos-tv-publish' };
    // 更新日志 heading：## v<version> (YYYY-MM-DD)。应用内检测据此 heading 的版本后缀判定 hotfix/full，
    // Git Release tag 本身保持干净(如 v3.3.6，不带后缀)。
    const today = new Date().toISOString().slice(0, 10);
    const newHeading = `## v${version} (${today})`;
    const changelogBody = `${newHeading}\n\nFntv-Plus 热补丁 ${version}`;
    let release;
    try {
        const r = await fetch(giteeApi(`releases/tags/${tag}?access_token=${GITEE_TOKEN}`), { headers: H });
        if (r.ok) release = await r.json();
    } catch { /* ignore */ }
    if (!release) {
        try {
            const r = await fetch(giteeApi(`releases?access_token=${GITEE_TOKEN}`), {
                method: 'POST',
                headers: { ...H, 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag_name: tag, name: `热补丁 ${tag}`, body: changelogBody, prerelease: false, target_commitish: 'release' }),
            });
            if (r.ok) release = await r.json();
            else console.log(`[publish-patch] Gitee 创建 Release 失败(${r.status}), 可能标签 ${tag} 尚未推送到 Gitee`);
        } catch (e) { console.log('[publish-patch] Gitee 创建 Release 异常:', e.message); }
    } else {
        // Release 已存在(用户保持同一 Git tag 如 v3.3.6、仅更新更新日志)：把最新 heading 写到 body 顶部，
        // 使应用内检测读到新版本号/类型。已有 heading 则替换首行，否则 prepend。
        const prevBody = release.body || '';
        const newBody = /^##\s+/m.test(prevBody)
            ? prevBody.replace(/^##\s+.*$/m, newHeading)
            : `${newHeading}\n\n${prevBody}`.trim();
        if (newBody !== prevBody) {
            try {
                const r = await fetch(giteeApi(`releases/${release.id}?access_token=${GITEE_TOKEN}`), {
                    method: 'PATCH',
                    headers: { ...H, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body: newBody }),
                });
                if (r.ok) console.log(`[publish-patch] 已更新 Gitee Release ${tag} 更新日志顶部: ${newHeading}`);
                else console.log(`[publish-patch] Gitee 更新 Release body 失败(${r.status})`);
            } catch (e) { console.log('[publish-patch] Gitee PATCH Release 异常:', e.message); }
        }
    }
    if (!release || !release.id) {
        console.log(`[publish-patch] 未找到/未创建 Gitee Release ${tag}, 跳过 Gitee 上传。`);
        return false;
    }
    const existing = (release.assets || []).find((a) => a.name === fileName);
    if (existing && existing.id) {
        try {
            await fetch(giteeApi(`releases/${release.id}/attach_files/${existing.id}?access_token=${GITEE_TOKEN}`), { method: 'DELETE', headers: H });
            console.log(`[publish-patch] 已删除 Gitee 旧资产 ${fileName}`);
        } catch { /* ignore */ }
    }
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/json' }), fileName);
    const r = await fetch(giteeApi(`releases/${release.id}/attach_files?access_token=${GITEE_TOKEN}`), {
        method: 'POST', headers: H, body: form,
    });
    if (r.ok) {
        console.log(`[publish-patch] 已上传 Gitee Release ${tag}: ${fileName}`);
        return true;
    }
    console.log(`[publish-patch] Gitee 上传失败(${r.status}):`, await r.text().catch(() => ''));
    return false;
}

// Git Release tag 保持干净(如 v3.3.6)，不带 -hotfix/-full 后缀：
// 默认 = 当前应用版本(pkg.version)，即把补丁追加到"当前在发的那个 Release"上(用户保持 tag 原样)；
// 如需新建/指定其它 tag，可设环境变量 GITEE_TAG(如 v3.3.7)。版本参数(version)始终是更新日志里的版本号。
const tag = process.env.GITEE_TAG
    ? (process.env.GITEE_TAG.startsWith('v') ? process.env.GITEE_TAG : 'v' + process.env.GITEE_TAG)
    : 'v' + pkg.version;
let uploaded = await giteeUpload(tag, outPath, outName);

// ---------- GitHub 次选保底 ----------
if (!uploaded) {
    try {
        execSync('gh --version', { stdio: 'ignore' });
        console.log(`[publish-patch] 通过 gh 上传到 Release ${tag} ...`);
        execSync(`gh release upload ${tag} ${outName} --clobber`, { stdio: 'inherit', cwd: root });
        uploaded = true;
        console.log(`[publish-patch] 上传完成(GitHub)。应用内点「应用补丁」即可拉取 v${version}。`);
    } catch (e) {
        console.log('[publish-patch] 未检测到 gh CLI 或上传失败, 改用手动上传。');
    }
}

if (!uploaded) {
    console.log(`\n请手动把 ${outName} 上传为 Release(v${version}) 的附件:`);
    console.log(`  Gitee: https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases/tag/${tag}`);
    console.log(`  GitHub: https://github.com/YDMY007/Fntv-Plus/releases/tag/${tag}`);
    console.log(`  把 ${outName} 作为资产(Asset)上传; 应用内点「应用补丁」即可拉取。\n`);
    console.log(`(Gitee 自动上传需 GITEE_TOKEN 环境变量; GitHub 需 gh CLI + GITHUB_TOKEN)`);
}
