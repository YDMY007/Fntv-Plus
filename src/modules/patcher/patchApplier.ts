import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import axios from 'axios';
import { getAppliedPatchVersion, setAppliedPatchVersion } from '../fn_config/config';
import log from '../logger';

/**
 * [lc-474] 一键热补丁应用器。
 *
 * 设计目标：用户点击「一键应用补丁」后，应用内直接拉取并应用小 bug 修复，
 * 绝不打开浏览器跳到 GitHub 手动下载（区别于原有「立即下载」按钮）。
 *
 * 补丁载体 = GitHub Release 上的一个 `patch-<version>.json` 资产（国内经镜像/代理下载，速度快）：
 *   {
 *     "version": "1.2.3",            // 与 Release tag 一致（去 v）
 *     "minAppVersion": "1.2.0",      // 最低适用的应用版本
 *     "files": [                     // 需填补的文件（相对 dest 目录的路径）
 *       { "target": "preload/plugins/embyWall.js", "b64": "<base64>" }
 *     ]
 *   }
 * preload/* 文件在「重载渲染端」后生效；main/* 文件需「重启应用」生效（应用器会标记 needsRestart）。
 *
 * 模块依赖回退：被填补的插件文件可能 require 同级模块（如 './core/hooks'），
 * 这些依赖仍在 asar 内原处，应用器写入时只覆盖被修文件，依赖由运行时的
 * Module._resolveFilename 回退机制（见 preload/index.ts 与 handlers/index.ts）解析。
 */

export interface PatchFile {
    target: string;
    b64: string;
}

export interface PatchManifest {
    version: string;
    minAppVersion?: string;
    files: PatchFile[];
}

export interface ApplyResult {
    ok: boolean;
    version?: string;
    filesApplied: number;
    needsRestart: boolean;
    message: string;
}

// 国内可达的 GitHub 镜像（与 updateChecker.ts 保持一致；主要用于拉取 Release JSON 与补丁资产）
const MIRRORS: Array<{ name: string; base: string; fullPrefix: boolean }> = [
    { name: 'github.dpik.top', base: 'https://github.dpik.top', fullPrefix: true },
    { name: 'mirror.ghproxy.com', base: 'https://mirror.ghproxy.com', fullPrefix: false },
    { name: 'ghproxy.com', base: 'https://ghproxy.com', fullPrefix: false },
    { name: 'github.moeyy.xyz', base: 'https://github.moeyy.xyz', fullPrefix: false },
];

const OWNER = 'YDMY007';
const REPO = 'Fntv-Plus';

// Gitee 源（国内直连，首选）。仓库名用小写 fntv-plus（与 GitHub 镜像发布流程一致）
const GITEE_OWNER = 'YDMY007';
const GITEE_REPO = 'fntv-plus';
const GITEE_RELEASES_URL = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases?per_page=1`;
const GITEE_TAG_RELEASE_URL = (tag: string) =>
    `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/tags/${tag}`;
const GITEE_CREATE_RELEASE_URL = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases`;

function getPatchesDir(): string {
    return process.env.FNTV_PATCHES_DIR
        || path.join(app.getPath('userData'), 'patches');
}

function githubApiLatest(): string {
    return `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
}

function buildMirrorApiUrl(m: { base: string; fullPrefix: boolean }): string {
    const base = m.base.replace(/\/$/, '');
    return m.fullPrefix
        ? `${base}/${githubApiLatest()}`
        : `${base}/repos/${OWNER}/${REPO}/releases/latest`;
}

function buildMirrorAssetUrl(originalUrl: string, m: { base: string; fullPrefix: boolean }): string {
    const base = m.base.replace(/\/$/, '');
    return m.fullPrefix
        ? `${base}/${originalUrl}`
        : `${base}/${originalUrl}`;
}

async function fetchReleaseJson(): Promise<any> {
    // 1) Gitee 优先（国内直连，最快最稳；公开 API 无需 token 读最新 release）
    try {
        const r = await axios.get(GITEE_RELEASES_URL, {
            timeout: 10000,
            headers: { 'User-Agent': `fnos-tv/${app.getVersion()}` },
        });
        const arr = r.data;
        if (Array.isArray(arr) && arr.length) {
            log.info('[patch] 通过 Gitee 获取 Release 成功');
            return arr[0];
        }
    } catch (e) {
        log.warn('[patch] Gitee 获取 Release 失败, 回退 GitHub:', (e as Error).message);
    }
    // 2) 直连 GitHub
    try {
        const r = await axios.get(githubApiLatest(), {
            timeout: 10000,
            headers: { 'User-Agent': `fnos-tv/${app.getVersion()}` },
        });
        return r.data;
    } catch (e) {
        log.warn('[patch] 直连 GitHub 获取 Release 失败, 尝试镜像:', (e as Error).message);
    }
    // 3) 依次尝试镜像
    for (const m of MIRRORS) {
        try {
            const r = await axios.get(buildMirrorApiUrl(m), {
                timeout: 8000,
                headers: { 'User-Agent': `fnos-tv/${app.getVersion()}` },
            });
            log.info(`[patch] 通过镜像 ${m.name} 获取 Release 成功`);
            return r.data;
        } catch (e) {
            log.warn(`[patch] 镜像 ${m.name} 失败:`, (e as Error).message);
        }
    }
    throw new Error('无法获取 Release 信息（Gitee / 直连 / 镜像均失败）');
}

// Gitee 资产下载链接直连即可（国内快），GitHub 资产则走镜像。downloadText 已按 url 是否含
// github.com 决定是否加镜像前缀，这里无需额外处理。
function getAssetDownloadUrl(asset: any): string {
    return asset && (asset.browser_download_url || asset.url || asset.download_url);
}

async function downloadText(url: string): Promise<string> {
    // 先试直连，再逐镜像重写 URL
    const candidates: string[] = [url];
    for (const m of MIRRORS) {
        if (url.includes('github.com')) candidates.push(buildMirrorAssetUrl(url, m));
    }
    let lastErr: any = null;
    for (const u of candidates) {
        try {
            const r = await axios.get(u, { timeout: 15000, responseType: 'text' });
            return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`下载补丁失败: ${(lastErr && lastErr.message) || '未知错误'}`);
}

// 路径安全校验：仅允许 preload/ 或 main/ 下的相对路径，禁止 .. 与绝对路径
function sanitizeTarget(target: string): string | null {
    const t = (target || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/^(preload|main)\//.test(t)) return null;
    if (t.split('/').some((seg) => seg === '..' || seg === '')) return null;
    return t;
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

/**
 * 拉取并应用最新热补丁。
 * @returns 应用结果（是否成功、版本、填补文件数、是否需重启）
 */
export async function applyLatestPatch(): Promise<ApplyResult> {
    const applied = getAppliedPatchVersion();
    log.info(`[patch] 当前已应用补丁版本: ${applied || '(无)'}`);

    const release = await fetchReleaseJson();
    const latestVersion: string = String(release.tag_name || '').replace(/^v/, '');
    if (!latestVersion) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: 'Release 缺少版本号' };
    }
    log.info(`[patch] 最新补丁版本: ${latestVersion}`);

    if (applied && compareVersions(latestVersion, applied) <= 0) {
        return {
            ok: true, filesApplied: 0, needsRestart: false,
            version: latestVersion,
            message: `已是最新补丁（v${latestVersion}）`,
        };
    }

    // 在 assets 中找 patch-<version>.json（或首个 patch-*.json）
    const assets: any[] = release.assets || [];
    let asset: any = null;
    const exact = assets.find((a: any) => a.name === `patch-${latestVersion}.json`);
    if (exact) asset = exact;
    else asset = assets.find((a: any) => /^patch-.*\.json$/i.test(a.name));
    if (!asset) {
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: latestVersion,
            message: `v${latestVersion} 未提供热补丁包（patch-${latestVersion}.json）`,
        };
    }

    const raw = await downloadText(getAssetDownloadUrl(asset));
    let manifest: PatchManifest;
    try {
        manifest = JSON.parse(raw);
    } catch (e) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: `补丁清单解析失败: ${(e as Error).message}` };
    }

    if (manifest.minAppVersion && compareVersions(app.getVersion(), manifest.minAppVersion) < 0) {
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: latestVersion,
            message: `当前应用版本 v${app.getVersion()} 低于补丁要求 v${manifest.minAppVersion}，请先升级安装包`,
        };
    }

    const patchesDir = getPatchesDir();
    if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true });

    let count = 0;
    let needsRestart = false;
    for (const f of manifest.files || []) {
        const rel = sanitizeTarget(f.target);
        if (!rel) {
            log.warn(`[patch] 跳过非法路径: ${f.target}`);
            continue;
        }
        if (rel.startsWith('main/')) needsRestart = true;
        const dest = path.join(patchesDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.b64 || '', 'base64'));
        count++;
        log.info(`[patch] 已填补: ${rel}`);
    }

    if (count === 0) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: '补丁包内无有效文件' };
    }

    setAppliedPatchVersion(latestVersion);
    log.info(`[patch] 应用完成: v${latestVersion}, 共 ${count} 个文件, 需重启=${needsRestart}`);
    return {
        ok: true,
        version: latestVersion,
        filesApplied: count,
        needsRestart,
        message: needsRestart
            ? `已应用补丁 v${latestVersion}（${count} 个文件），需重启应用生效`
            : `已应用补丁 v${latestVersion}（${count} 个文件），即将重载生效`,
    };
}
