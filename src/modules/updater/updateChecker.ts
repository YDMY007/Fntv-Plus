import axios from 'axios';
import { shell, app } from 'electron';
import { fnosDialog } from '../../main/common/fnosDialog';
import { getUpdateDismissedAt, setUpdateDismissedAt, getAppliedPatchVersion } from '../fn_config/config';
import { applyLatestPatchAndReload } from '../patcher/patchApplier';
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
    // 更新类型：hotfix=国内 Gitee 应用内补丁；full=国外 GitHub 全量安装包覆盖安装
    updateType: 'hotfix' | 'full';
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
     *  - hotfix 类更新：弹窗主按钮「应用补丁」(应用内 Gitee 拉取填补)；
     *  - full 类更新：弹窗主按钮「下载全量安装包」(国外 GitHub 发行页)。
     * 手动/自动检查均走此入口。
     * @returns 更新信息
     */
    async checkForUpdates(): Promise<UpdateInfo> {
        return await this.checkForUpdatesViaGitee();
    }

    /**
     * 国内 Gitee 仓库地址（仓库名转小写，与 GitHub 仅大小写差异；如 Fntv-Plus → fntv-plus）。
     */
    private giteeLatestUrl(): string {
        const giteeRepo = this.repo.toLowerCase();
        return `https://gitee.com/api/v5/repos/${this.owner}/${giteeRepo}/releases/latest`;
    }

    /**
     * 解析发行说明里的更新类型标识。
     * 优先读显式标识 `<!-- fntv:type:hotfix -->` / `<!-- fntv:type:full -->`；
     * 否则按资产推断：含 `patch-<ver>.json` 视为 hotfix；缺省 full。
     */
    private parseUpdateType(body: string, assets: any[], latestVersion: string): 'hotfix' | 'full' {
        const m = /fntv:type:\s*(hotfix|full)/i.exec(body || '');
        if (m) return m[1].toLowerCase() === 'hotfix' ? 'hotfix' : 'full';
        const hasPatch = Array.isArray(assets)
            && assets.some((a: any) => a && a.name === `patch-${latestVersion}.json`);
        return hasPatch ? 'hotfix' : 'full';
    }

    /**
     * 通过国内 Gitee 检测最新版本（唯一检测源）。
     *  - 版本号取 `tag_name`（去 v 前缀）；
     *  - 发布时间取 `created_at`（Gitee 用 created_at，非 published_at）；
     *  - 更新类型取发行说明标识 / 资产推断（hotfix|full）；
     *  - 下载/详情链接统一指向国外 GitHub 发行版最新下载页。
     * @returns 更新信息
     */
    async checkForUpdatesViaGitee(): Promise<UpdateInfo> {
        const url = this.giteeLatestUrl();
        log.info(`通过国内 Gitee 检测更新: ${url}`);

        const response = await axios.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': `fnos-tv/${this.currentVersion}` }
        });

        const r = response.data;
        const latestVersion = String(r.tag_name || '').replace(/^v/, '');
        // 不论类型，详情/全量包下载均指向国外 GitHub 发行版最新下载页（国内 Gitee 不托管大文件）
        const githubReleaseUrl = `https://github.com/${this.owner}/${this.repo}/releases/latest`;

        // [lc-476] hotfix 类以「已应用补丁版本」为比较基准，避免重复提示
        const updateType = this.parseUpdateType(r.body || '', r.assets, latestVersion);
        log.info(`Gitee 最新标签: ${latestVersion}, 类型: ${updateType}`);

        const applied = getAppliedPatchVersion();
        const baseForCompare = (updateType === 'hotfix' && applied && this.compareVersions(applied, this.currentVersion) > 0)
            ? applied
            : this.currentVersion;

        let hasUpdate: boolean;
        if (semver) {
            hasUpdate = semver.gt(latestVersion, baseForCompare);
        } else {
            hasUpdate = this.compareVersions(latestVersion, baseForCompare) > 0;
        }

        return {
            hasUpdate,
            latestVersion,
            updateType,
            // 即便 Gitee 无 assets，也明确指向 GitHub 发行版页面（立即下载/查看详情均跳转此处）
            downloadUrl: githubReleaseUrl,
            releaseNotes: r.body || '',
            publishedAt: r.created_at || '',
            htmlUrl: githubReleaseUrl
        };
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
                message: `飞牛影视有热补丁可用！`,
                detail: `当前版本: ${this.currentVersion}\n热补丁版本: ${latestVersion}`,
                // 更新日志记录以 Markdown 传入，弹窗按 .md-body 富文本渲染（含标题/列表/加粗/链接）
                markdown: releaseNotes || '暂无更新说明',
                buttons: ['应用补丁', '下载全量安装包', '稍后提醒'],
                defaultId: 0,
                cancelId: 2,
            });

            switch (response) {
                case 0: // 应用补丁（应用内 Gitee 拉取，不跳浏览器）
                    setUpdateDismissedAt(Date.now());
                    await applyLatestPatchAndReload();
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
        const { response } = await fnosDialog(null, {
            type: 'info',
            title: '发现新版本',
            message: `飞牛影视有新版本可用！`,
            detail: `当前版本: ${this.currentVersion}\n最新版本: ${latestVersion}`,
            // 更新日志记录以 Markdown 传入，弹窗按 .md-body 富文本渲染（含标题/列表/加粗/链接）
            markdown: releaseNotes || '暂无更新说明',
            buttons: ['下载全量安装包', '查看详情', '稍后提醒'],
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
