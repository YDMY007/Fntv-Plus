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

// [lc-483] 进度阶段：检查中 / 下载中 / 应用中 / 完成 / 失败
export type PatchPhase = 'checking' | 'downloading' | 'applying' | 'done' | 'error';

// [lc-483] 实时进度回报：渲染端弹窗根据 phase 切换 UI，percent=-1 表示未知总量（ indeterminate）
export interface PatchProgress {
    phase: PatchPhase;
    percent: number; // 0-100；-1=未知
    loaded?: number;
    total?: number;
    message?: string;
}

export interface PatchApplyOptions {
    onProgress?: (p: PatchProgress) => void;
}

// [lc-483] 仅检查（不下载）的返回结构：弹窗先用它判断是否弹「立即应用」
export interface PatchCheckInfo {
    hasUpdate: boolean;
    version: string;       // 最新补丁版本号（无则空串）
    currentVersion: string; // 当前已应用/基准版本
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
// [lc-482] 注意：Gitee 的 /releases 默认按创建时间「升序」(最旧在前)，per_page=1 会拿到最旧发布。
// 故一次拉全量(per_page=100)后由 pickLatestRelease 选出「版本号最高的非 test 发布」作为"最新"。
const GITEE_RELEASES_URL = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases?per_page=100`;
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
            const picked = pickLatestRelease(arr);
            if (picked) {
                log.info('[patch] 通过 Gitee 获取 Release 成功(已选最新版本发布)');
                return picked;
            }
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

async function downloadText(url: string, onProgress?: (loaded: number, total: number) => void): Promise<string> {
    // 先试直连，再逐镜像重写 URL
    const candidates: string[] = [url];
    for (const m of MIRRORS) {
        if (url.includes('github.com')) candidates.push(buildMirrorAssetUrl(url, m));
    }
    let lastErr: any = null;
    for (const u of candidates) {
        try {
            const r = await axios.get(u, {
                timeout: 15000,
                responseType: 'text',
                onDownloadProgress: (e: any) => {
                    if (onProgress && typeof e.loaded === 'number') {
                        onProgress(e.loaded, e.total || 0);
                    }
                },
            });
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

// 解析版本号类型/序号为可比较的 rank：无后缀=0；-test=1xx；-hotfix=2xx；-full=3xx（xx=序号, 如 -hotfix2=202）
// [lc-480] -test 权重低于真实 hotfix/full，使开发者先应用 test 后，真实 hotfix 仍判为"更新"
function parseVersion(v: string): { base: string; rank: number } {
    const m = /^(.*?)-(?:hotfix|full|test)(\d*)$/i.exec(v || '');
    if (m) {
        const suffix = m[0].toLowerCase();
        const typeRank = suffix.includes('test') ? 1 : (suffix.includes('hotfix') ? 2 : 3);
        const idx = m[2] === '' ? 1 : parseInt(m[2], 10);
        return { base: m[1], rank: typeRank * 100 + idx };
    }
    return { base: v || '0', rank: 0 };
}

// 版本比较：base 优先，base 相同比 rank（类型/序号）。-test 视为低于真实 hotfix/full，但高于无后缀同 base
function versionGreater(latest: string, baseline: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(baseline);
    const c = compareVersions(a.base, b.base);
    if (c !== 0) return c > 0;
    return a.rank > b.rank;
}

// 从发行说明(更新日志)取「版本号最高」的 ## vX.Y.Z(-hotfix|-full)? (date) heading；找不到回退 null
// 注意：仅匹配 hotfix|full，天然排除 -test，使默认检测/应用补丁永不落到测试版。
// (?=[\s（(]|$) 锚定：版本号后须为空白/半角或全角左括号/行尾，避免 `## v3.3.7-test` 被部分匹配成
// 基版本 `3.3.7`（那样会把测试版误判为普通版）；同时兼容更新日志里 `（2026-...）` 全角括号的写法。
// 取「最高版本」而非「首条」：兼容更新日志乱序/多次追加 hotfix 的情况（如 v3.3.7-hotfix 与 v3.3.8-hotfix）。
function parseLatestChangelogVersion(body: string): string | null {
    const lines = (body || '').split(/\r?\n/);
    let best: string | null = null;
    for (const line of lines) {
        const m = /^##\s+v?(\d+\.\d+\.\d+(?:-(?:hotfix|full)\d*)?)(?=[\s（(]|$)/i.exec(line.trim());
        if (!m) continue;
        const v = m[1];
        if (!best || versionGreater(v, best)) best = v;
    }
    return best;
}

// [lc-482] 从 Gitee 发布列表中选出「版本号最高的非 test 发布」作为"最新"。
// Gitee /releases 默认升序(最旧在前)，直接取 [0] 会拿到 v3.0.0 之类的旧版，故需自行择优。
// test 发布(更新日志含 -test heading 或 tag 带 -test)一律排除——普通检测/应用补丁只认 hotfix|full。
function pickLatestRelease(releases: any[]): any {
    let best: any = null;
    let bestVer = '0';
    for (const rel of (releases || [])) {
        const body = rel.body || rel.note || '';
        const v = parseLatestChangelogVersion(body)
            || String(rel.tag_name || '').replace(/^v/i, '');
        if (!v || /-test\d*$/i.test(v)) continue;
        if (versionGreater(v, bestVer)) { bestVer = v; best = rel; }
    }
    return best;
}

// [lc-481] 从更新日志取指定类型(hotfix|full|test)的最高版本号；找不到返回 null。
// 用于「开发者测试更新」按钮单独定位 -test 版本（普通检测已被 parseLatestChangelogVersion 排除）。
function findChangelogVersionByType(body: string, suffix: 'test' | 'hotfix' | 'full'): string | null {
    const lines = (body || '').split(/\r?\n/);
    const re = new RegExp(`-${suffix}\\d*$`, 'i');
    let best: string | null = null;
    for (const line of lines) {
        const m = /^##\s+v?(\d+\.\d+\.\d+(?:-(?:hotfix|full|test)\d*)?)/i.exec(line.trim());
        if (!m) continue;
        const v = m[1];
        if (!re.test(v)) continue;
        if (!best || versionGreater(v, best)) best = v;
    }
    return best;
}

/**
 * 应用结果返回后，延迟执行「重载渲染端 / 重启应用」使补丁生效。
 * 仅当实际填补了文件才刷新；"已是最新/无文件"无需刷新。
 * 延迟执行确保 IPC 响应已送达渲染端（用于弹窗提示）后再重启。
 */
async function finalizeAfterApply(result: ApplyResult): Promise<ApplyResult> {
    if (result.ok && result.filesApplied > 0) {
        setTimeout(() => {
            try {
                if (result.needsRestart) {
                    log.info('[patch] 热补丁含主进程文件，重启应用生效');
                    app.relaunch({ args: process.argv.slice(1) });
                    app.exit(0);
                } else {
                    // 延迟 require 避免与 main/common/mainwin 形成加载期循环依赖
                    const { getMainWindow } = require('../../main/common/mainwin');
                    const win = getMainWindow();
                    if (win && win.webContents) {
                        log.info('[patch] 重载渲染端使热补丁生效');
                        win.webContents.reload();
                    }
                }
            } catch (e) {
                log.error('[patch] 重载/重启失败:', (e as Error).message);
            }
        }, 1200);
    }
    return result;
}

/**
 * [lc-483] 仅检查是否有可用热补丁（不下载、不应用），供渲染端弹窗先展示版本号与确认按钮。
 * 逻辑与 applyLatestPatch 的「是否更新」判断保持一致：以更新日志最新 heading 为准，
 * 与已应用补丁版本比较；天然排除 -test（parseLatestChangelogVersion 只认 hotfix|full）。
 */
export async function checkLatestPatchInfo(): Promise<PatchCheckInfo> {
    const applied = getAppliedPatchVersion();
    const currentVersion = applied || app.getVersion();
    try {
        const release = await fetchReleaseJson();
        const body = release.body || release.note || '';
        const latestVersion: string = parseLatestChangelogVersion(body)
            || String(release.tag_name || '').replace(/^v/i, '')
            || '0';
        if (!latestVersion || latestVersion === '0') {
            return { hasUpdate: false, version: '', currentVersion, message: '未找到可用的热补丁' };
        }
        const hasUpdate = !applied || versionGreater(latestVersion, applied);
        return {
            hasUpdate,
            version: latestVersion,
            currentVersion,
            message: hasUpdate
                ? `发现新补丁 v${latestVersion}`
                : `已是最新补丁 v${latestVersion}`,
        };
    } catch (e: any) {
        return { hasUpdate: false, version: '', currentVersion, message: `检查失败: ${(e && e.message) || '未知错误'}` };
    }
}

/**
 * [lc-476] 拉取并应用最新热补丁（默认检测/应用补丁按钮共用），随后按需重载/重启。
 * @param opts.onProgress 实时进度回调（检查/下载/应用阶段）
 * @returns 应用结果（是否成功、版本、填补文件数、是否需重启）
 */
export async function applyLatestPatchAndReload(opts?: PatchApplyOptions): Promise<ApplyResult> {
    let result: ApplyResult;
    try {
        result = await applyLatestPatch(opts);
    } catch (e: any) {
        log.error('[patch] 应用失败:', e && e.message);
        if (opts && opts.onProgress) opts.onProgress({ phase: 'error', percent: -1, message: `应用失败: ${(e && e.message) || '未知错误'}` });
        result = { ok: false, filesApplied: 0, needsRestart: false, message: `应用失败: ${(e && e.message) || '未知错误'}` };
    }
    return finalizeAfterApply(result);
}

/**
 * [lc-481] 开发者手动拉取并应用 Gitee 上的 -test 测试补丁。
 * 与普通 applyLatestPatch 区别：
 *  - 从更新日志专门定位 -test 版本（普通检测默认跳过 test）；
 *  - 忽略「已应用」检查，开发者可重复覆盖应用同一 test 版本做验证；
 *  - 由设置页「获取测试更新」按钮在解锁码验证通过后调用。
 */
export async function applyTestPatch(opts?: PatchApplyOptions): Promise<ApplyResult> {
    const onProgress = opts && opts.onProgress;
    log.info('[patch] 开发者手动拉取 test 测试补丁');
    const release = await fetchReleaseJson();
    const body = release.body || release.note || '';
    const testVersion = findChangelogVersionByType(body, 'test');
    if (!testVersion) {
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: 'Gitee 未找到 -test 测试版补丁' });
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            message: 'Gitee 未找到 -test 测试版补丁（请确认更新日志含 ## vX.Y.Z-test 条目）',
        };
    }
    log.info(`[patch] 测试补丁版本(更新日志): ${testVersion}, Git tag: ${release.tag_name || '(无)'}`);

    // 在 assets 中找 patch-<testVersion>.json（优先精确名，再退首个 -test 补丁包）
    const assets: any[] = release.assets || [];
    const exact = assets.find((a: any) => a.name === `patch-${testVersion}.json`);
    const asset = exact || assets.find((a: any) => /^patch-.*-test\d*\.json$/i.test(a.name));
    if (!asset) {
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: `v${testVersion} 未提供热补丁包` });
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: testVersion,
            message: `v${testVersion} 未提供热补丁包（patch-${testVersion}.json）`,
        };
    }

    if (onProgress) onProgress({ phase: 'downloading', percent: 0, message: `正在下载测试补丁 v${testVersion}` });
    const raw = await downloadText(getAssetDownloadUrl(asset), (loaded, total) => {
        if (onProgress) onProgress({ phase: 'downloading', percent: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : -1, loaded, total });
    });
    let manifest: PatchManifest;
    try {
        manifest = JSON.parse(raw);
    } catch (e) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: `补丁清单解析失败: ${(e as Error).message}` };
    }

    if (manifest.minAppVersion && compareVersions(app.getVersion(), manifest.minAppVersion) < 0) {
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: testVersion,
            message: `当前应用版本 v${app.getVersion()} 低于补丁要求 v${manifest.minAppVersion}`,
        };
    }

    const patchesDir = getPatchesDir();
    if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true });

    if (onProgress) onProgress({ phase: 'applying', percent: 100, message: `正在应用测试补丁 v${testVersion}` });
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
        log.info(`[patch] 已填补(测试): ${rel}`);
    }

    if (count === 0) {
        return { ok: false, filesApplied: 0, needsRestart: false, message: '补丁包内无有效文件' };
    }

    setAppliedPatchVersion(testVersion);
    log.info(`[patch] 测试补丁应用完成: v${testVersion}, 共 ${count} 个文件, 需重启=${needsRestart}`);
    return {
        ok: true,
        version: testVersion,
        filesApplied: count,
        needsRestart,
        message: needsRestart
            ? `已应用测试补丁 v${testVersion}（${count} 个文件），需重启应用生效`
            : `已应用测试补丁 v${testVersion}（${count} 个文件），即将重载生效`,
    };
}

/**
 * [lc-481] 拉取并应用 test 测试补丁，随后按需重载/重启（与 finalizeAfterApply 共用）。
 */
export async function applyTestPatchAndReload(opts?: PatchApplyOptions): Promise<ApplyResult> {
    let result: ApplyResult;
    try {
        result = await applyTestPatch(opts);
    } catch (e: any) {
        log.error('[patch] 测试补丁应用失败:', e && e.message);
        if (opts && opts.onProgress) opts.onProgress({ phase: 'error', percent: -1, message: `应用失败: ${(e && e.message) || '未知错误'}` });
        result = { ok: false, filesApplied: 0, needsRestart: false, message: `应用失败: ${(e && e.message) || '未知错误'}` };
    }
    return finalizeAfterApply(result);
}

/**
 * [lc-483] 拉取并应用最新热补丁。
 * @param opts.onProgress 实时进度回调（检查/下载/应用阶段），供渲染端弹窗展示
 * @returns 应用结果（是否成功、版本、填补文件数、是否需重启）
 */
export async function applyLatestPatch(opts?: PatchApplyOptions): Promise<ApplyResult> {
    const onProgress = opts && opts.onProgress;
    const applied = getAppliedPatchVersion();
    log.info(`[patch] 当前已应用补丁版本: ${applied || '(无)'}`);

    const release = await fetchReleaseJson();
    // [lc-477] 版本号以更新日志最新 heading 为准(## vX.Y.Z(-hotfix)? (date))，Git tag 仅兜底
    const body = release.body || release.note || '';
    const latestVersion: string = parseLatestChangelogVersion(body)
        || String(release.tag_name || '').replace(/^v/i, '')
        || '0';
    if (!latestVersion || latestVersion === '0') {
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: 'Release 缺少版本号' });
        return { ok: false, filesApplied: 0, needsRestart: false, message: 'Release 缺少版本号' };
    }
    log.info(`[patch] 最新补丁版本(更新日志): ${latestVersion}, Git tag: ${release.tag_name || '(无)'}`);

    if (applied && !versionGreater(latestVersion, applied)) {
        if (onProgress) onProgress({ phase: 'done', percent: 100, message: `已是最新补丁（v${latestVersion}）` });
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
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: `v${latestVersion} 未提供热补丁包` });
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: latestVersion,
            message: `v${latestVersion} 未提供热补丁包（patch-${latestVersion}.json）`,
        };
    }

    if (onProgress) onProgress({ phase: 'downloading', percent: 0, message: `正在下载补丁 v${latestVersion}` });
    const raw = await downloadText(getAssetDownloadUrl(asset), (loaded, total) => {
        if (onProgress) onProgress({ phase: 'downloading', percent: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : -1, loaded, total });
    });
    let manifest: PatchManifest;
    try {
        manifest = JSON.parse(raw);
    } catch (e) {
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: `补丁清单解析失败: ${(e as Error).message}` });
        return { ok: false, filesApplied: 0, needsRestart: false, message: `补丁清单解析失败: ${(e as Error).message}` };
    }

    if (manifest.minAppVersion && compareVersions(app.getVersion(), manifest.minAppVersion) < 0) {
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: `当前版本过低，请先升级安装包` });
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: latestVersion,
            message: `当前应用版本 v${app.getVersion()} 低于补丁要求 v${manifest.minAppVersion}，请先升级安装包`,
        };
    }

    const patchesDir = getPatchesDir();
    if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true });

    if (onProgress) onProgress({ phase: 'applying', percent: 100, message: `正在应用补丁 v${latestVersion}` });
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
    if (onProgress) onProgress({ phase: 'done', percent: 100, message: needsRestart ? '补丁已应用，正在重启应用…' : '补丁已应用，正在重载…' });
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
