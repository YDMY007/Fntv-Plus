import axios from 'axios';
import { BrowserWindow, shell, app } from 'electron';
import { fnosDialog } from '../../main/common/fnosDialog';
import { getUpdateDismissedAt, setUpdateDismissedAt, getAppliedPatchVersion } from '../fn_config/config';
import log from '../logger';

// 尝试获取semver模块
let semver: any;
try {
    semver = require('semver');
} catch (error) {
    // 如果没有semver，使用简单的版本比较
    semver = null;
}

// 类型定义
export interface UpdateInfo {
    hasUpdate: boolean;
    latestVersion?: string;
    // 更新类型：hotfix=国内 Gitee 应用内补丁；full=国外 GitHub 全量安装包覆盖安装；test=开发者自用测试版(绝不推送用户)
    updateType: 'hotfix' | 'full' | 'test';
    downloadUrl?: string | null;
    releaseNotes?: string;
    publishedAt?: string;
    htmlUrl?: string;
}

export interface DialogResult {
    response: number;
}

export class UpdateChecker {
    private owner: string;
    private repo: string;
    private currentVersion: string;
    private maxRetries: number;
    private baseRetryDelay: number;

    constructor(owner: string = 'YDMY007', repo: string = 'Fntv-Plus', currentVersion: string | null = null) {
        this.owner = owner;
        this.repo = repo;
        // 如果传入了版本号就使用传入的，否则尝试从app获取，最后使用默认值
        this.currentVersion = currentVersion || (app ? app.getVersion() : 'unknown');
        // 重试配置
        this.maxRetries = 3;
        this.baseRetryDelay = 1000; // 基础延迟1秒
    }

    /**
     * 检查是否有新版本（默认策略）。
     * [lc-476] 更新检测**只走国内 Gitee**（剥离旧版 GitHub 镜像检测路径）。
     * Gitee 不托管大文件，故：
     *  - hotfix 类更新：弹窗主按钮「应用补丁」(应用内 Gitee 拉取填补，明确提示无需下载全量包)；
     *  - full 类更新：弹窗主按钮「前往下载全量包安装新版本更新」(国外 GitHub 发行页，**不提供「应用补丁」**)；
     *  - test 类更新：开发者自用测试版，绝不向任何用户弹窗推送（仅供「应用补丁」按钮手动拉取测试）。
     * 手动/自动检查均走此入口。
     * @returns 更新信息
     */
    async checkForUpdates(): Promise<UpdateInfo> {
        return await this.checkForUpdatesViaGitee();
    }

    /**
     * 国内 Gitee 仓库地址（仓库名转小写，与 GitHub 仅大小写差异；如 Fntv-Plus → fntv-plus）。
     */
    private updateCheckUrl(): string {
        const giteeRepo = this.repo.toLowerCase();
        // [lc-505] 改用 Gitee 公开 raw 文件检测更新，无需 token（Gitee /releases API 与 contents API 均强制需 token，分发版不可用）。
        // 该文件随发版更新并 push 到 release 分支，内容为最新版本号(带 -full/-hotfix 后缀)、日期、下载链接、简述。
        return `https://gitee.com/${this.owner}/${giteeRepo}/raw/release/resource/wiki/update-check.json`;
    }

    /**
     * 解析更新类型标识。
     * 主信号 = 更新日志里最新 `## vX.Y.Z(-hotfix|-full|-test) (date)` heading 的版本后缀：
     *  - `-hotfix` / `-hotfixN` → 热补丁(hotfix)，应用内拉取 Gitee 补丁包；
     *  - `-full` / `-fullN`     → 全量包(full)，去 GitHub 下载覆盖安装；
     *  - `-test` / `-testN`     → 开发者自用测试版(test)，绝不向用户推送（仅供「应用补丁」按钮手动拉取测试）；
     *  - 无后缀的普通版本(如 `v3.3.6`) → 视为全量包(full)。
     * Git Release tag 本身保持干净(如 `v3.3.6`)，不带后缀。
     * 兼容旧发布：发行说明显式标识 `<!-- fntv:type:hotfix|full|test -->` 仍生效；
     * 再退按资产推断：含 `patch-<ver>.json` 视为 hotfix。
     */
    private parseUpdateType(body: string, assets: any[], latestVersion: string): 'hotfix' | 'full' | 'test' {
        if (/-hotfix\d*$/i.test(latestVersion || '')) return 'hotfix';
        if (/-full\d*$/i.test(latestVersion || '')) return 'full';
        // [lc-480] -test / -testN = 开发者自用测试版，绝不向用户推送更新
        if (/-test\d*$/i.test(latestVersion || '')) return 'test';
        const m = /fntv:type:\s*(hotfix|full|test)/i.exec(body || '');
        if (m) {
            const t = m[1].toLowerCase();
            return t === 'hotfix' ? 'hotfix' : (t === 'test' ? 'test' : 'full');
        }
        const hasPatch = Array.isArray(assets)
            && assets.some((a: any) => a && a.name === `patch-${latestVersion}.json`);
        return hasPatch ? 'hotfix' : 'full';
    }

    /**
     * 从发行说明(更新日志)里取「最新一条」`## vX.Y.Z(-hotfix|-full)? (date)` heading 的版本号。
     * 更新日志 newest-first，取第一个 `## ` heading 即为当前发布版本。
     * 找不到则返回 null（调用方回退到 Git tag_name）。
     */
    private parseLatestChangelogVersion(body: string): string | null {
        const lines = (body || '').split(/\r?\n/);
        let best: string | null = null;
        for (const line of lines) {
            // 仅匹配 hotfix|full（排除 -test），使 test 更新日志永不触发用户更新；取最高版本非首条。
            // (?=[\s（(]|$) 兼容全角括号 `（2026-...）` 写法，并防止 `v3.3.7-test` 被部分匹配成 `3.3.7`。
            const m = /^##\s+v?(\d+\.\d+\.\d+(?:-(?:hotfix|full)\d*)?)(?=[\s（(]|$)/i.exec(line.trim());
            if (!m) continue;
            const v = m[1];
            if (!best || this.versionGreater(v, best)) best = v;
        }
        return best;
    }

    /**
     * [lc-482] 从 Gitee 发布列表中选出「版本号最高的非 test 发布」作为"最新"。
     * Gitee /releases 默认升序(最旧在前)，取 [0] 会拿到 v3.0.0 之类的旧版；test 发布一律排除。
     */
    private pickLatestRelease(releases: any[]): any {
        let best: any = null;
        let bestVer = '0';
        for (const rel of (releases || [])) {
            const body = rel.body || rel.note || '';
            const v = this.parseLatestChangelogVersion(body)
                || String(rel.tag_name || '').replace(/^v/i, '');
            if (!v || /-test\d*$/i.test(v)) continue;
            if (this.versionGreater(v, bestVer)) { bestVer = v; best = rel; }
        }
        return best;
    }

    /**
     * 通过国内 Gitee 检测最新版本（唯一检测源）。
     *  - 版本号/类型以「更新日志最新 heading」为准：`## vX.Y.Z(-hotfix|-full) (date)`（newest-first 取第一条）；
     *    Git Release tag 保持干净(如 v3.3.6)，仅作兜底；
     *  - 发布时间取 `created_at`（Gitee 用 created_at，非 published_at）；
     *  - 更新类型由 heading 版本后缀决定(-hotfix=应用内补丁 / -full 或无后缀=GitHub 全量包)；
     *  - 下载/详情链接统一指向国外 GitHub 发行版最新下载页。
     * @returns 更新信息
     */
    async checkForUpdatesViaGitee(): Promise<UpdateInfo> {
        const url = this.updateCheckUrl();
        log.info(`通过国内 Gitee 检测更新(公开 raw, 无 token): ${url}`);

        // 不论类型，详情/全量包下载均指向国外 GitHub 发行版最新下载页（国内 Gitee 不托管大文件）
        const githubReleaseUrl = `https://github.com/${this.owner}/${this.repo}/releases/latest`;

        let resp: any;
        try {
            resp = await axios.get(url, {
                timeout: 10000,
                responseType: 'text',
                headers: { 'User-Agent': `fnos-tv/${this.currentVersion}` }
            });
        } catch (e: any) {
            // raw 文件不可达(未发布/网络异常) → 静默视为无更新，不弹「检查失败」打扰用户
            log.warn(`Gitee 更新检测文件不可达: ${e?.message || e}`);
            return {
                hasUpdate: false,
                updateType: 'full',
                downloadUrl: githubReleaseUrl,
                releaseNotes: '',
                publishedAt: '',
                htmlUrl: githubReleaseUrl,
            };
        }

        let data: any;
        try {
            data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
        } catch {
            log.warn('Gitee 更新检测文件解析失败(非 JSON)');
            return { hasUpdate: false, updateType: 'full', downloadUrl: githubReleaseUrl, releaseNotes: '', publishedAt: '', htmlUrl: githubReleaseUrl };
        }

        const ver = String(data.version || data.tag_name || '0').replace(/^v/i, '');
        const updateType = this.typeFromVersion(ver);
        const isTest = updateType === 'test';
        log.info(`Gitee 检测版本: ${ver}, 类型: ${updateType}${isTest ? ' (test 开发版, 不推送用户)' : ''}`);

        const applied = getAppliedPatchVersion();
        // hotfix 以「已应用补丁版本」为比较基准，避免重复提示；full 直接比当前安装版本；test 不推送
        const baseline = (updateType === 'hotfix' && applied) ? applied : this.currentVersion;

        // 注意: semver 把 -hotfix 当预发布, gt('1.2.3-hotfix','1.2.3') 会返回 false，
        // 故统一走自定义 versionGreater(把 -hotfix 后缀视为高于同 base 的正式版)。
        const hasUpdate = !isTest && this.versionGreater(ver, baseline);

        return {
            hasUpdate,
            latestVersion: ver,
            updateType,
            // 即便未配 downloadUrl，也明确指向 GitHub 发行版页面（立即下载/查看详情均跳转此处）
            downloadUrl: data.downloadUrl || githubReleaseUrl,
            releaseNotes: data.notes || data.changelog || '',
            publishedAt: data.date || '',
            htmlUrl: data.downloadUrl || githubReleaseUrl
        };
    }

    /** 从版本号后缀解析更新类型（与 parseUpdateType 后缀规则一致）：-hotfix=补丁 / -full=全量包 / -test=开发者版 / 无后缀=full。 */
    private typeFromVersion(v: string): 'hotfix' | 'full' | 'test' {
        if (/-hotfix\d*$/i.test(v)) return 'hotfix';
        if (/-full\d*$/i.test(v)) return 'full';
        if (/-test\d*$/i.test(v)) return 'test';
        return 'full';
    }

    /**
     * 简单的版本比较函数（用作semver的备用方案）
     * @param version1
     * @param version2
     * @returns 1 if version1 > version2, -1 if version1 < version2, 0 if equal
     */
    compareVersions(version1: string, version2: string): number {
        const v1Parts = version1.split('.').map(Number);
        const v2Parts = version2.split('.').map(Number);

        const maxLength = Math.max(v1Parts.length, v2Parts.length);

        for (let i = 0; i < maxLength; i++) {
            const v1Part = v1Parts[i] || 0;
            const v2Part = v2Parts[i] || 0;

            if (v1Part > v2Part) return 1;
            if (v1Part < v2Part) return -1;
        }

        return 0;
    }

    /**
     * 解析版本号中的类型后缀为可比较的 rank。
     * 无后缀=0；`-test`/`-testN`=1xx；`-full`/`-fullN`=2xx；`-hotfix`/`-hotfixN`=3xx（xx=序号）。
     * 关键：[lc-501] `-hotfix` 权重高于 `-full`：同一 base 版本下，
     *   已装该 base 的用户应优先收到「热补丁」提示（无需重下全量包），
     *   而不是被全量发布盖掉导致热补丁永远推不到。
     *   跨版本升级仍由 base 比较决定（base 高者优先），不受 rank 影响。
     *   `-test` 权重最低，开发者测试版绝不向普通用户推送。
     */
    private parseVersion(v: string): { base: string; rank: number } {
        const m = /^(.*?)-(?:hotfix|full|test)(\d*)$/i.exec(v || '');
        if (m) {
            const suffix = m[0].toLowerCase();
            // hotfix=3 > full=2 > test=1：同 base 下热补丁优先于全量包
            const typeRank = suffix.includes('test') ? 1 : (suffix.includes('full') ? 2 : 3);
            const idx = m[2] === '' ? 1 : parseInt(m[2], 10);
            return { base: m[1], rank: typeRank * 100 + idx };
        }
        return { base: v || '0', rank: 0 };
    }

    /** 仅比较 base 部分（semver 优先，失败回落到数字比较）。 */
    private cmpBase(a: string, b: string): number {
        if (semver) {
            try {
                if (semver.gt(a, b)) return 1;
                if (semver.lt(a, b)) return -1;
                return 0;
            } catch { /* fallthrough */ }
        }
        return this.compareVersions(a, b);
    }

    /**
     * 版本比较：base 优先，base 相同则比 rank（类型/序号）。
     * 关键修正：`-hotfix` 视为高于同 base 的正式版；`-test` 低于真实 hotfix/full 但高于无后缀同 base。
     * 例：versionGreater('1.2.3-hotfix','1.2.3') === true；versionGreater('1.2.3-hotfix','1.2.3-test') === true。
     */
    private versionGreater(latest: string, baseline: string): boolean {
        const a = this.parseVersion(latest);
        const b = this.parseVersion(baseline);
        const c = this.cmpBase(a.base, b.base);
        if (c !== 0) return c > 0;
        return a.rank > b.rank;
    }

    /**
     * 显示更新对话框（按 hotfix / full 分流）。
     * @param updateInfo - 更新信息
     * @returns 用户是否选择立即更新
     */
    async showUpdateDialog(updateInfo: UpdateInfo): Promise<boolean> {
        const { latestVersion, releaseNotes, downloadUrl, htmlUrl, updateType } = updateInfo;

        // ===== hotfix：应用内补丁（国内 Gitee 拉取填补）=====
        if (updateType === 'hotfix') {
            const { response } = await fnosDialog(null, {
                type: 'info',
                title: '发现热补丁',
                // [lc-510] 明显提示用户：推荐直接应用补丁，无需下载全量包（应用内即可完成）
                message: `飞牛影视有热补丁可用！\n✅ 推荐直接「应用补丁」——应用内即可完成更新，无需下载全量安装包。`,
                detail: `当前版本: ${this.currentVersion}\n热补丁版本: ${latestVersion}`,
                // 更新日志记录以 Markdown 传入，弹窗按 .md-body 富文本渲染（含标题/列表/加粗/链接）
                markdown: releaseNotes || '暂无更新说明',
                buttons: ['应用补丁', '下载全量安装包', '稍后提醒'],
                defaultId: 0,
                cancelId: 2,
            });

            switch (response) {
                case 0: // 应用补丁（应用内 Gitee 拉取，不跳浏览器）
                    // [lc-507] 不再主进程静默应用(无进度/无反馈)，改为唤起渲染端补丁向导：
                    //   带下载进度条 + "✓ 补丁已应用"完成提示 + 自动重载，autoApply 跳过二次确认。
                    setUpdateDismissedAt(Date.now());
                    const target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
                    if (target) target.webContents.send('fntv:open-patch-wizard', { autoApply: true });
                    return true;
                case 1: // 仍可选择去 GitHub 下载全量包覆盖安装
                    if (downloadUrl) shell.openExternal(downloadUrl);
                    else if (htmlUrl) shell.openExternal(htmlUrl);
                    return false;
                default: // 稍后提醒
                    return false;
            }
        }

        // ===== full：前往国外 GitHub 下载全量安装包覆盖安装 =====
        // [lc-510] 全量包不提供「应用补丁」按钮（补丁仅适用于热补丁），主按钮直接引导下载全量包
        const { response } = await fnosDialog(null, {
            type: 'info',
            title: '发现新版本',
            message: `飞牛影视有新版本可用！请下载全量安装包覆盖安装。`,
            detail: `当前版本: ${this.currentVersion}\n最新版本: ${latestVersion}`,
            // 更新日志记录以 Markdown 传入，弹窗按 .md-body 富文本渲染（含标题/列表/加粗/链接）
            markdown: releaseNotes || '暂无更新说明',
            buttons: ['前往下载全量包安装新版本更新', '查看详情', '稍后提醒'],
            defaultId: 0,
            cancelId: 2,
        });

        switch (response) {
            case 0: // 下载全量安装包（国外 GitHub）
                // 记录时间戳：7 天内不再自动弹窗更新提醒
                setUpdateDismissedAt(Date.now());
                if (downloadUrl) {
                    shell.openExternal(downloadUrl);
                } else if (htmlUrl) {
                    shell.openExternal(htmlUrl);
                }
                return true;
            case 1: // 查看详情
                if (htmlUrl) {
                    shell.openExternal(htmlUrl);
                }
                return false;
            default: // 稍后提醒
                return false;
        }
    }

    /**
     * 显示「已达最新版本」的弹窗：除提示已是最新外，
     * 同时展示该最新版本自身的更新介绍（changelog，来自 release body 的 Markdown），
     * 让用户知道「当前版本都更新了什么」。
     * @param updateInfo - 检测到的更新信息（含 releaseNotes）
     */
    async showLatestVersionDialog(updateInfo: UpdateInfo): Promise<void> {
        const { latestVersion, releaseNotes, htmlUrl } = updateInfo;

        const { response } = await fnosDialog(null, {
            type: 'info',
            title: '已是最新版本',
            // 先明确告知用户：已是最新版本、无需更新
            message: `您当前使用的已经是最新版本（${latestVersion || this.currentVersion}），无需更新。下面是本次版本的更新日志：`,
            detail: `当前版本: ${this.currentVersion}\n最新版本: ${latestVersion || this.currentVersion}`,
            // 复用最新版本的更新日志（Markdown 富文本渲染），并加"本次更新日志"小标题明确内容
            markdown: releaseNotes ? `## 本次更新日志\n\n${releaseNotes}` : '暂无更新说明',
            buttons: ['查看详情', '确定'],
            defaultId: 1,
            cancelId: 1,
        });

        // 用户点击「查看详情」则打开 GitHub 发行版页面
        if (response === 0 && htmlUrl) {
            shell.openExternal(htmlUrl);
        }
    }

    /**
     * 显示检查更新失败的提示
     * @param error - 错误信息
     */
    async showUpdateErrorDialog(error: string): Promise<void> {
        await fnosDialog(null, {
            type: 'error',
            title: '检查更新失败',
            message: '无法检查更新',
            detail: error,
            buttons: ['确定'],
        });
    }

    /**
     * 自动检查更新（静默检查，只在有更新时提示）
     */
    async autoCheckForUpdates(): Promise<void> {
        try {
            // 检查 7 天免打扰：用户点过「立即下载」后 7 天内不再自动弹窗
            const dismissedAt = getUpdateDismissedAt();
            const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
            if (dismissedAt > 0 && (Date.now() - dismissedAt) < SNOOZE_MS) {
                log.info('更新提醒在 7 天免打扰期内，跳过自动弹窗');
                return;
            }

            const updateInfo = await this.checkForUpdates();

            // [lc-480] test 开发版仅供开发者个人测试，绝不向用户推送（自动/手动检查均不弹窗）
            if (updateInfo.updateType === 'test') {
                log.info(`[更新检测] 最新为 test 开发版(${updateInfo.latestVersion})，不向用户推送，跳过提示`);
                return;
            }

            if (updateInfo.hasUpdate) {
                log.info('发现新版本，显示更新提示');
                await this.showUpdateDialog(updateInfo);
            } else {
                log.info('当前已是最新版本');
            }
        } catch (error: any) {
            log.error('自动检查更新失败:', error.message);
            // 自动检查失败时不显示错误提示，避免打扰用户
        }
    }

    /**
     * 手动检查更新（显示所有结果）
     */
    async manualCheckForUpdates(): Promise<void> {
        try {
            const updateInfo = await this.checkForUpdates();

            // [lc-480] test 开发版仅供开发者个人测试，绝不向用户推送（自动/手动检查均不弹窗）
            if (updateInfo.updateType === 'test') {
                log.info(`[更新检测] 最新为 test 开发版(${updateInfo.latestVersion})，不向用户推送，跳过提示`);
                return;
            }

            if (updateInfo.hasUpdate) {
                await this.showUpdateDialog(updateInfo);
            } else {
                await this.showLatestVersionDialog(updateInfo);
            }
        } catch (error: any) {
            await this.showUpdateErrorDialog(error.message);
        }
    }
}

// 单例实例
let instance: UpdateChecker | null = null;

/**
 * 获取 UpdateChecker 单例实例
 * @param owner - GitHub 仓库所有者，默认 'YDMY007'
 * @param repo - GitHub 仓库名称，默认 'Fntv-Plus'
 * @param currentVersion - 当前版本号，默认从 app.getVersion() 获取
 * @returns UpdateChecker 实例
 */
export function getInstance(owner: string = 'YDMY007', repo: string = 'Fntv-Plus', currentVersion: string | null = null): UpdateChecker {
    if (!instance) {
        instance = new UpdateChecker(owner, repo, currentVersion);
    }
    return instance;
}

/**
 * 重置单例实例（主要用于测试）
 */
export function resetInstance(): void {
    instance = null;
}
