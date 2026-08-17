import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import axios from 'axios';
import { getAppliedPatchVersion, setAppliedPatchVersion, getAppliedPatchSignature, setAppliedPatchSignature } from '../fn_config/config';
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

// [lc-492] 测试补丁列表项：一个 -test 版本及其对应补丁包资产
export interface TestPatchInfo {
    version: string;       // 如 3.3.8-test1
    assetName: string | null; // 对应 patch-<version>.json 资产名（未找到为 null）
    hasAsset: boolean;     // 是否存在对应补丁包（无包则不可选）
}
export interface TestPatchListResult {
    ok: boolean;
    message?: string;
    patches: TestPatchInfo[];
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

// [lc-506] 国内 Gitee 公开 raw 检测源（无 token，与 updateChecker 一致）：
// 直接读 update-check.json 拿到最新热补丁版本 + 补丁包直链(patchUrl)，避免 Gitee /releases API 强制 token 导致用户端 403。
const UPDATE_CHECK_RAW_URL = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/raw/release/resource/wiki/update-check.json`;

interface RawPatchInfo { version: string; patchUrl: string; notes: string; }

// 读 Gitee 公开 raw update-check.json（无 token 可访问），返回最新版本与补丁包直链；失败返回 null（交由旧 releases 路径回退）
async function fetchPatchInfoViaRaw(): Promise<RawPatchInfo | null> {
    try {
        const r = await axios.get(UPDATE_CHECK_RAW_URL, {
            timeout: 10000,
            headers: { 'User-Agent': `fnos-tv/${app.getVersion()}` },
        });
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        if (!data || !data.version) return null;
        return { version: String(data.version), patchUrl: data.patchUrl || '', notes: data.notes || '' };
    } catch (e) {
        log.warn('[patch] 读取 update-check.json 失败, 回退 releases:', (e as Error).message);
        return null;
    }
}

// [lc-493] 测试补丁专用仓库（独立于正式仓库 fntv-plus）。
// 正式仓库只承载「官方发布 / 安装包更新检测 / 官方热补丁」；开发者测试文件单独部署到此仓库，
// 互不影响：正式用户永不触达此仓库，测试也不会污染正式仓库的更新日志/资产。
// 仓库名可通过环境变量覆盖（如测试仓库取名不同）；默认约定为 fntv-plus-test。
const GITEE_TEST_OWNER = process.env.FNTV_TEST_REPO_OWNER || 'YDMY007';
const GITEE_TEST_REPO = process.env.FNTV_TEST_REPO_NAME || 'fntv-plus-test';
// [lc-509] 测试仓库列表改为读取公开 raw 索引文件（与正式仓库 update-check.json 同思路），
// 避开 Gitee /releases API 对 token 的强制要求（无 token=403）。索引就放在测试仓库自身（master 分支），
// 不污染正式仓库；位于 resource/wiki/ 目录（已验证匿名可访问）；其中每项 patchUrl 指向测试仓库可匿名下载的 releases/download/ 直链。
const GITEE_TEST_INDEX_URL = `https://gitee.com/${GITEE_TEST_OWNER}/${GITEE_TEST_REPO}/raw/master/resource/wiki/test-index.json`;

function getPatchesDir(): string {
    return process.env.FNTV_PATCHES_DIR
        || path.join(app.getPath('userData'), 'patches');
}

/**
 * [lc-511] 一键清除所有已应用补丁（回滚到原版）。
 * 删除 patches 覆盖目录（移除热补丁 / main 补丁的文件覆盖）并清空 appliedPatchVersion，
 * 使下次启动回退到安装包原始文件。供「回滚补丁」按钮与「下载全量包前清理」调用，
 * 确保正式版(全量包)安装后能真正盖过旧补丁（否则旧补丁文件会持续覆盖新包文件）。
 */
export function clearAllPatches(): void {
    try {
        const dir = getPatchesDir();
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            log.info(`[patch] 已删除补丁覆盖目录: ${dir}`);
        } else {
            log.info('[patch] 补丁覆盖目录不存在，无需删除');
        }
    } catch (e: any) {
        log.warn('[patch] 删除补丁覆盖目录失败:', e?.message || e);
    }
    try {
        setAppliedPatchVersion('');
        setAppliedPatchSignature('');
        log.info('[patch] 已清空 appliedPatchVersion / appliedPatchSignature');
    } catch (e: any) {
        log.warn('[patch] 清空 appliedPatchVersion 失败:', e?.message || e);
    }
}

/**
 * [lc-520] 计算当前安装包签名（仅打包版有效）：取可执行文件(process.execPath)的修改时间(mtimeMs)。
 * 重装/升级会重写 exe → mtime 变化 → 签名变化；普通重启/热补丁重载不改写 exe → 签名不变。
 * 用于启动对账：若当前签名与应用补丁时记录的签名不同，说明安装包被替换，旧补丁覆盖层已失效，应清除。
 */
function computeInstallSignature(): string {
    try {
        if (!app.isPackaged) return '';
        const st = fs.statSync(process.execPath);
        return String(st.mtimeMs);
    } catch (e: any) {
        log.warn('[patch] 读取安装包签名失败:', e?.message || e);
        return '';
    }
}

/**
 * [lc-520] 启动期补丁对账：保证"覆盖安装官方版"能正确回退到安装包真实版本，不再残留旧 hotfix 版本号。
 * 机制：
 *  - 应用补丁时记录当时的安装包签名(appliedPatchSignature)；
 *  - 每次启动(packaged 版)比对当前安装包签名：
 *      · 一致 → 补丁仍有效，保留；
 *      · 不一致(重装/升级) → 旧补丁覆盖层已失效，clearAllPatches() 回退到安装包版本；
 *      · 缺失(appliedPatchSignature 为空，即修复前旧版应用的补丁) → 视为未知安装状态，清除以保证官方版优先。
 * dev 版(isPackaged=false)不处理（dev 用独立 config 且不涉及"覆盖安装"场景）。
 * 必须在窗口/版本显示读取 appliedPatchVersion 之前调用。
 */
export function reconcilePatchStateOnStartup(): void {
    // [lc-521] dev 版不自动清除覆盖层(以免清掉本次会话刚应用的测试/热补丁, 破坏测试流程),
    // 但残留覆盖层会影子覆盖 dest 源码, 导致"跑的其实不是最新 dev 版"。
    // 故在启动时给出明确告警, 提示用户清空该目录以回到最新 dev 代码(符合用户"最新 dev 版"铁律)。
    if (!app.isPackaged) {
        try {
            const dir = getPatchesDir();
            const hasOverlay = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
            if (hasOverlay) {
                const applied = getAppliedPatchVersion();
                log.warn(`[patch][dev] 检测到 dev 覆盖层(${dir}), appliedPatchVersion=${applied || '(无)'}，`
                    + `它将影子覆盖 dest 源码, 使 dev 实际并非最新代码。`
                    + `如需回到最新 dev 代码, 请清空该目录(删除 ${dir}) 并重启。`);
            }
        } catch (e: any) {
            log.warn('[patch][dev] 检测 dev 覆盖层失败:', e?.message || e);
        }
        return;
    }
    try {
        const sig = computeInstallSignature();
        if (!sig) return;
        const applied = getAppliedPatchVersion();
        if (!applied) return; // 无已应用补丁，无需处理
        const appliedSig = getAppliedPatchSignature();
        if (appliedSig) {
            if (appliedSig !== sig) {
                log.info(`[patch] 检测到安装包已变更(重装/升级): 旧签名=${appliedSig} 新签名=${sig} → 清除已应用热补丁 ${applied}，回退到安装包版本 ${app.getVersion()}`);
                clearAllPatches();
            } else {
                log.info(`[patch] 安装包签名一致(${sig})，已应用热补丁 ${applied} 仍然有效`);
            }
        } else {
            // 修复前旧版应用的补丁无签名：本次为签名感知构建首次启动，清除以保证官方安装包版本优先显示
            log.info(`[patch] 检测到修复前应用的热补丁(${applied})无安装签名，清除以回退到安装包版本 ${app.getVersion()}`);
            clearAllPatches();
        }
    } catch (e: any) {
        log.warn('[patch] 启动补丁对账失败:', e?.message || e);
    }
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

// [lc-509] 读取测试仓库的公开 raw 索引文件（test-index.json），列出全部 -test 补丁版本 + 直链。
// 与 Gitee /releases API 不同，raw 文件无需 token 即可匿名读取，分发版也能用。
async function fetchTestIndex(): Promise<any[]> {
    const r = await axios.get(GITEE_TEST_INDEX_URL, {
        timeout: 10000,
        headers: { 'User-Agent': `fnos-tv/${app.getVersion()}` },
    });
    const list = Array.isArray(r.data) ? r.data : JSON.parse(typeof r.data === 'string' ? r.data : '[]');
    return list;
}

// [lc-493] 拉取测试仓库的全部 -test 发布（映射成与 Gitee releases API 兼容的结构）。
// [lc-509] 改为读公开 raw 索引文件，不再走需 token 的 /releases API。
async function fetchTestReleases(): Promise<any[]> {
    try {
        const list = await fetchTestIndex();
        return list.map((e: any) => ({
            tag_name: e.version,
            assets: [{ name: `patch-${e.version}.json`, browser_download_url: e.patchUrl }],
        }));
    } catch (e) {
        log.warn('[patch] 测试仓库读取索引失败:', (e as Error).message);
        throw new Error('无法获取测试仓库 Release（请确认已创建并公开测试仓库 ' +
            `${GITEE_TEST_OWNER}/${GITEE_TEST_REPO}）`);
    }
}

// [lc-493] 按 version 在测试仓库索引中定位某个具体 -test 发布的 patch 资产。
// [lc-509] 改为读公开 raw 索引文件并按 version 查找，不再走需 token 的 /releases/tags API。
async function fetchTestReleaseByTag(version: string): Promise<any> {
    const norm = version.replace(/^v/i, '');
    try {
        const list = await fetchTestIndex();
        const entry = list.find((e: any) => String(e.version).replace(/^v/i, '') === norm);
        if (entry) {
            return {
                tag_name: entry.version,
                assets: [{ name: `patch-${entry.version}.json`, browser_download_url: entry.patchUrl }],
            };
        }
    } catch (e) {
        log.warn('[patch] 测试仓库读取索引失败:', (e as Error).message);
    }
    throw new Error('未找到对应的测试发布');
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

// 解析版本号类型/序号为可比较的 rank：无后缀=0；-test=1xx；-full=2xx；-hotfix=3xx（xx=序号, 如 -hotfix2=302）
// [lc-501] hotfix rank > full rank：同 base 下热补丁优先于全量包，避免全量发布盖掉热补丁导致已装用户收不到热补丁提示
function parseVersion(v: string): { base: string; rank: number } {
    const m = /^(.*?)-(?:hotfix|full|test)(\d*)$/i.exec(v || '');
    if (m) {
        const suffix = m[0].toLowerCase();
        // hotfix=3 > full=2 > test=1：同 base 下热补丁优先
        const typeRank = suffix.includes('test') ? 1 : (suffix.includes('full') ? 2 : 3);
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
    // [fix] 基线取「已应用补丁版本」或「应用安装版本」，不可为空。
    //   原逻辑 applied 为空时 `!applied` 直接判有新更新，且 versionGreater 把空基线当 0，
    //   导致「从未应用过补丁」也误报「发现新热补丁」。
    const baseline = applied || app.getVersion();
    const currentVersion = baseline;
    try {
        // [lc-506] 优先走国内 Gitee 公开 raw（无 token）
        const rawInfo = await fetchPatchInfoViaRaw();
        if (rawInfo && rawInfo.version) {
            const latestVersion = rawInfo.version;
            const hasUpdate = versionGreater(latestVersion, baseline);
            return {
                hasUpdate,
                version: latestVersion,
                currentVersion,
                message: hasUpdate
                    ? `发现新补丁 v${latestVersion}`
                    : `已是最新补丁 v${latestVersion}`,
            };
        }
    } catch (e) {
        log.warn('[patch] raw 检测失败, 回退 releases:', (e as Error).message);
    }
    // [回退] 旧 Gitee releases API / GitHub / 镜像
    try {
        const release = await fetchReleaseJson();
        const body = release.body || release.note || '';
        const latestVersion: string = parseLatestChangelogVersion(body)
            || String(release.tag_name || '').replace(/^v/i, '')
            || '0';
        if (!latestVersion || latestVersion === '0') {
            return { hasUpdate: false, version: '', currentVersion, message: '未找到可用的热补丁' };
        }
        const hasUpdate = versionGreater(latestVersion, baseline);
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
 * [lc-492] 列出 Gitee 上所有 -test 测试补丁版本（开发者测试通道「选择 + 应用」流程用）。
 * 解析更新日志中所有 `## vX.Y.Z-testN` heading，并在同一 Release 的 assets 中查找对应
 * `patch-<version>.json` 资产。渲染端据此展示可选择的测试补丁列表（无补丁包的版本不可选）。
 */
export async function listTestPatches(): Promise<TestPatchListResult> {
    try {
        // [lc-493] 改从独立的测试仓库读取，不再依赖正式仓库的更新日志/资产
        const releases = await fetchTestReleases();
        const re = /-test\d*$/i;
        const patches: TestPatchInfo[] = [];
        for (const rel of releases) {
            const tag = String(rel.tag_name || '').replace(/^v/i, '');
            if (!re.test(tag)) continue; // 仅纳入 -test 发布
            const assets: any[] = rel.assets || [];
            const exact = assets.find((a: any) => a.name === `patch-${tag}.json`);
            patches.push({
                version: tag,
                assetName: exact ? exact.name : null,
                hasAsset: !!exact,
            });
        }
        // 降序（最新在前）：先比 base 版本，再比 rank（类型/序号）
        patches.sort((a, b) => {
            if (versionGreater(a.version, b.version)) return -1;
            if (versionGreater(b.version, a.version)) return 1;
            return 0;
        });
        return { ok: true, patches };
    } catch (e: any) {
        return { ok: false, message: `检测失败: ${(e && e.message) || '未知错误'}`, patches: [] };
    }
}

/**
 * [lc-493] 开发者手动拉取并应用「测试仓库」上的 -test 测试补丁。
 * 与普通 applyLatestPatch 区别：
 *  - 数据来自独立的测试仓库（GITEE_TEST_OWNER/GITEE_TEST_REPO），与正式仓库互不干扰；
 *  - 忽略「已应用」检查，开发者可重复覆盖应用同一 test 版本做验证；
 *  - 由设置页「获取测试更新」按钮在解锁码验证通过后调用。
 */
export async function applyTestPatch(opts?: PatchApplyOptions, targetVersion?: string): Promise<ApplyResult> {
    const onProgress = opts && opts.onProgress;
    log.info(`[patch] 开发者手动拉取 test 测试补丁${targetVersion ? ` (指定版本 ${targetVersion})` : ''}`);

    // 1) 定位目标 test 版本：指定版本直接用；否则取测试仓库最新（降序首个且有补丁包）
    let testVersion: string;
    if (targetVersion) {
        testVersion = targetVersion.replace(/^v/i, '');
    } else {
        const list = await listTestPatches();
        const selectable = list.patches.filter((p) => p.hasAsset);
        if (!selectable.length) {
            const msg = '测试仓库未找到可用的 -test 补丁包';
            if (onProgress) onProgress({ phase: 'error', percent: -1, message: msg });
            return { ok: false, filesApplied: 0, needsRestart: false, message: msg };
        }
        testVersion = selectable[0].version; // listTestPatches 已按降序
    }
    if (!/-test\d*$/i.test(testVersion)) {
        const msg = `版本 ${testVersion} 不是合法的 -test 版本`;
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: msg });
        return { ok: false, filesApplied: 0, needsRestart: false, message: msg };
    }

    // 2) 按 tag 拉取该 test 发布的 release，定位 patch-<version>.json 资产
    let release: any;
    try {
        release = await fetchTestReleaseByTag(testVersion);
    } catch (e: any) {
        const msg = `未找到测试发布 v${testVersion}：${(e && e.message) || ''}`;
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: msg });
        return { ok: false, filesApplied: 0, needsRestart: false, version: testVersion, message: msg };
    }
    const assets: any[] = release.assets || [];
    const asset = assets.find((a: any) => a.name === `patch-${testVersion}.json`);
    if (!asset) {
        const msg = `v${testVersion} 未提供热补丁包（patch-${testVersion}.json）`;
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: msg });
        return {
            ok: false, filesApplied: 0, needsRestart: false,
            version: testVersion,
            message: msg,
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
    setAppliedPatchSignature(computeInstallSignature());
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
export async function applyTestPatchAndReload(opts?: PatchApplyOptions, targetVersion?: string): Promise<ApplyResult> {
    let result: ApplyResult;
    try {
        result = await applyTestPatch(opts, targetVersion);
    } catch (e: any) {
        log.error('[patch] 测试补丁应用失败:', e && e.message);
        if (opts && opts.onProgress) opts.onProgress({ phase: 'error', percent: -1, message: `应用失败: ${(e && e.message) || '未知错误'}` });
        result = { ok: false, filesApplied: 0, needsRestart: false, message: `应用失败: ${(e && e.message) || '未知错误'}` };
    }
    return finalizeAfterApply(result);
}

// [lc-506] 提取「写补丁文件 + 标记已应用」的公共逻辑，供 raw 直链与旧 releases 两条路径共用
async function applyManifestFiles(manifest: PatchManifest, version: string, onProgress?: (p: PatchProgress) => void): Promise<ApplyResult> {
    if (manifest.minAppVersion && compareVersions(app.getVersion(), manifest.minAppVersion) < 0) {
        const msg = `当前应用版本 v${app.getVersion()} 低于补丁要求 v${manifest.minAppVersion}`;
        if (onProgress) onProgress({ phase: 'error', percent: -1, message: msg });
        return { ok: false, filesApplied: 0, needsRestart: false, version, message: msg };
    }
    const patchesDir = getPatchesDir();
    if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true });
    if (onProgress) onProgress({ phase: 'applying', percent: 100, message: `正在应用补丁 v${version}` });
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
    setAppliedPatchVersion(version);
    setAppliedPatchSignature(computeInstallSignature());
    log.info(`[patch] 应用完成: v${version}, 共 ${count} 个文件, 需重启=${needsRestart}`);
    if (onProgress) onProgress({ phase: 'done', percent: 100, message: needsRestart ? '补丁已应用，正在重启应用…' : '补丁已应用，正在重载…' });
    return {
        ok: true,
        version,
        filesApplied: count,
        needsRestart,
        message: needsRestart
            ? `已应用补丁 v${version}（${count} 个文件），需重启应用生效`
            : `已应用补丁 v${version}（${count} 个文件），即将重载生效`,
    };
}

/**
 * [lc-483] 拉取并应用最新热补丁。
 * @param opts.onProgress 实时进度回调（检查/下载/应用阶段），供渲染端弹窗展示
 * @returns 应用结果（是否成功、版本、填补文件数、是否需重启）
 */
export async function applyLatestPatch(opts?: PatchApplyOptions): Promise<ApplyResult> {
    const onProgress = opts && opts.onProgress;
    const applied = getAppliedPatchVersion();
    // [fix] 与 checkLatestPatchInfo 一致：基线取已应用版本或安装版本，避免空基线误判
    const baseline = applied || app.getVersion();
    log.info(`[patch] 当前已应用补丁版本: ${applied || '(无)'}, 基线版本: ${baseline}`);

    // [lc-506] 优先走国内 Gitee 公开 raw（无 token）：读 update-check.json 拿版本 + 补丁包直链
    const rawInfo = await fetchPatchInfoViaRaw();
    if (rawInfo && rawInfo.version) {
        const latestVersion: string = rawInfo.version;
        log.info(`[patch] raw 检测版本(更新日志): ${latestVersion}`);
        if (!versionGreater(latestVersion, baseline)) {
            if (onProgress) onProgress({ phase: 'done', percent: 100, message: `已是最新补丁（v${latestVersion}）` });
            return { ok: true, filesApplied: 0, needsRestart: false, version: latestVersion, message: `已是最新补丁（v${latestVersion}）` };
        }
        if (!rawInfo.patchUrl) {
            if (onProgress) onProgress({ phase: 'error', percent: -1, message: `v${latestVersion} 未提供补丁包直链` });
            return { ok: false, filesApplied: 0, needsRestart: false, version: latestVersion, message: `v${latestVersion} 未提供补丁包直链（patchUrl）` };
        }
        if (onProgress) onProgress({ phase: 'downloading', percent: 0, message: `正在下载补丁 v${latestVersion}` });
        const raw = await downloadText(rawInfo.patchUrl, (loaded, total) => {
            if (onProgress) onProgress({ phase: 'downloading', percent: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : -1, loaded, total });
        });
        let manifest: PatchManifest;
        try {
            manifest = JSON.parse(raw);
        } catch (e) {
            if (onProgress) onProgress({ phase: 'error', percent: -1, message: `补丁清单解析失败: ${(e as Error).message}` });
            return { ok: false, filesApplied: 0, needsRestart: false, message: `补丁清单解析失败: ${(e as Error).message}` };
        }
        return applyManifestFiles(manifest, latestVersion, onProgress);
    }

    // [回退] 旧 Gitee releases API / GitHub / 镜像（Gitee 需 token，仅供有 token 场景；GitHub 公开可读作为兜底）
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

    if (!versionGreater(latestVersion, baseline)) {
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
