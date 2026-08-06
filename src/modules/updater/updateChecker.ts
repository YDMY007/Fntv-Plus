import axios, { AxiosResponse } from 'axios';
import { shell, app } from 'electron';
import { fnosDialog } from '../../main/common/fnosDialog';
import { getDownloadProxyConfig } from '../fn_config/config';
import { getUpdateDismissedAt, setUpdateDismissedAt } from '../fn_config/config';
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
    downloadUrl?: string | null;
    releaseNotes?: string;
    publishedAt?: string;
    htmlUrl?: string;
}

export interface GitHubRelease {
    tag_name: string;
    body: string;
    published_at: string;
    html_url: string;
    assets: GitHubAsset[];
}

export interface GitHubAsset {
    name: string;
    browser_download_url: string;
}

export interface DialogResult {
    response: number;
}

/**
 * 镜像源定义。
 * - fullPrefix=false（ghproxy 风格）：API 走 `镜像/repos/owner/repo/releases/latest` 路径式；
 * - fullPrefix=true（github.dpik.top 等）：API 与下载均走 `镜像/https://原始完整URL` 前置式。
 * 下载链接两种风格都接受「镜像 + 完整 URL」拼接（ghproxy 亦兼容）。
 */
export interface MirrorSource {
    name: string;
    base: string;
    fullPrefix: boolean;
}

/**
 * 延时函数
 * @param ms - 延时毫秒数
 * @returns Promise<void>
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class UpdateChecker {
    private owner: string;
    private repo: string;
    private currentVersion: string;
    private maxRetries: number;
    private baseRetryDelay: number;
    private mirrorMaxRetries: number;
    private mirrorTimeout: number;

    constructor(owner: string = 'YDMY007', repo: string = 'Fntv-Plus', currentVersion: string | null = null) {
        this.owner = owner;
        this.repo = repo;
        // 如果传入了版本号就使用传入的，否则尝试从app获取，最后使用默认值
        this.currentVersion = currentVersion || (app ? app.getVersion() : 'unknown');
        // 重试配置
        this.maxRetries = 3;
        this.baseRetryDelay = 1000; // 基础延迟1秒
        // 镜像专用：镜像通常网络通顺, 不可达时宜快速失败以尽快回退 GitHub 直链,
        // 故缩短超时(10s→6s)并降低重试(3→1), 避免 4 个镜像全挂时长时间阻塞。
        this.mirrorMaxRetries = 1;
        this.mirrorTimeout = 6000;
    }

    /**
     * 检查是否有新版本（默认策略）。
     * [2026-08-06] 「是否有更新」**只通过国内 Gitee 检测**，绝不回退国外 GitHub。
     * Gitee 国内访问稳定可达（实测连续 HTTP 200，无需兜底）；若 Gitee 偶发失败，
     * 错误直接向上抛出，由手动检查(提示失败) / 自动检查(静默) 各自处理。
     * 不论从哪检测到更新，下载/详情链接都指向**国外 GitHub 发行版最新下载页**
     * （国内 Gitee 不托管大文件，仅放源码与 Release 说明）。
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
     * 通过国内 Gitee 检测最新版本（仅用于「是否有更新」的判定）。
     * Gitee 不返回 html_url、且无大文件 assets，因此：
     *  - 版本号取 `tag_name`（去 v 前缀）；
     *  - 发布时间取 `created_at`（Gitee 用 created_at，非 published_at）；
     *  - 下载/详情链接**统一指向国外 GitHub 发行版最新下载页**
     *    （https://github.com/{owner}/{repo}/releases/latest），保证点击下载跳转国外仓库。
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
        // 下载 / 详情始终指向国外 GitHub 发行版最新下载页（国内 Gitee 不托管大文件）
        const githubReleaseUrl = `https://github.com/${this.owner}/${this.repo}/releases/latest`;

        log.info(`Gitee 最新标签: ${latestVersion}`);

        let hasUpdate: boolean;
        if (semver) {
            hasUpdate = semver.gt(latestVersion, this.currentVersion);
        } else {
            hasUpdate = this.compareVersions(latestVersion, this.currentVersion) > 0;
        }

        return {
            hasUpdate,
            latestVersion,
            // 即便 Gitee 无 assets，也明确指向 GitHub 发行版页面（立即下载/查看详情均跳转此处）
            downloadUrl: githubReleaseUrl,
            releaseNotes: r.body || '',
            publishedAt: r.created_at || '',
            htmlUrl: githubReleaseUrl
        };
    }

    /**
     * 实际抓取并解析 GitHub Release（直连或镜像共用）。
     * @param apiUrl - 完整 API 地址（直连或经镜像重写）
     * @param downloadBase - 镜像根地址，用于重写下载链接；为空则走用户配置的下载代理
     * @param retryCount - 当前重试次数
     * @returns 更新信息
     */
    async fetchRelease(apiUrl: string, downloadBase: string | undefined, retryCount: number = 0, opts?: { timeout?: number; maxRetries?: number }): Promise<UpdateInfo> {
        const timeout = opts?.timeout ?? 10000;
        const maxRetries = opts?.maxRetries ?? this.maxRetries;
        try {
            log.info(`检查更新: 当前版本 ${this.currentVersion}${retryCount > 0 ? ` (重试 ${retryCount}/${maxRetries})` : ''}${downloadBase ? ` [镜像 ${downloadBase}]` : ''}`);

            const response: AxiosResponse<GitHubRelease> = await axios.get(apiUrl, {
                timeout,
                headers: {
                    'User-Agent': `fnos-tv/${this.currentVersion}`
                }
            });

            const release = response.data;
            const latestVersion = release.tag_name.replace(/^v/, ''); // 移除 'v' 前缀
            const downloadUrl = this.getDownloadUrl(release.assets, downloadBase);

            log.info(`最新版本: ${latestVersion}`);

            // 使用 semver 比较版本，如果没有semver则使用简单比较
            let hasUpdate: boolean;
            if (semver) {
                hasUpdate = semver.gt(latestVersion, this.currentVersion);
            } else {
                // 简单的版本比较（仅用于测试）
                hasUpdate = this.compareVersions(latestVersion, this.currentVersion) > 0;
            }

            return {
                hasUpdate,
                latestVersion,
                downloadUrl,
                releaseNotes: release.body,
                publishedAt: release.published_at,
                htmlUrl: release.html_url
            };
        } catch (error: any) {
            log.error(`检查更新失败 (尝试 ${retryCount + 1}/${maxRetries + 1}):`, error.message);

            // 如果还有重试次数，则等待后重试
            if (retryCount < maxRetries) {
                // 梯度延迟
                const retryDelay = this.baseRetryDelay * Math.pow(2, retryCount);
                log.info(`等待 ${retryDelay}ms 后重试...`);
                await delay(retryDelay);
                return await this.fetchRelease(apiUrl, downloadBase, retryCount + 1, opts);
            }

            // 所有重试都失败了，抛出错误
            throw new Error(`检查更新失败: ${error.message} (已重试 ${maxRetries} 次)`);
        }
    }

    /**
     * 通过国内可达的 GitHub 镜像依次检查更新（主接口 403 / 限流时的备选方案）。
     * 依次尝试一组镜像，命中即用该镜像重写下载链接；全部失败则抛错。
     *
     * 镜像有两种 URL 风格，必须分别处理，否则必定失败：
     *  - ghproxy 风格（fullPrefix=false）：API 用「镜像/repos/owner/repo/releases/latest」路径式；
     *  - 前置式（fullPrefix=true，如 github.dpik.top）：API 与下载都用「镜像/https://原始完整URL」。
     *    若对 dpik 用路径式「镜像/repos/...」会拿到 404，这是旧版"镜像检查有问题"的根因。
     * @returns 更新信息
     */
    async checkForUpdatesViaMirror(): Promise<UpdateInfo> {
        const mirrors: MirrorSource[] = [
            { name: 'github.dpik.top', base: 'https://github.dpik.top', fullPrefix: true },
            { name: 'mirror.ghproxy.com', base: 'https://mirror.ghproxy.com', fullPrefix: false },
            { name: 'ghproxy.com', base: 'https://ghproxy.com', fullPrefix: false },
            { name: 'github.moeyy.xyz', base: 'https://github.moeyy.xyz', fullPrefix: false },
        ];
        let lastErr: any = null;
        for (const m of mirrors) {
            const base = m.base.replace(/\/$/, '');
            const apiUrl = m.fullPrefix
                ? `${base}/https://api.github.com/repos/${this.owner}/${this.repo}/releases/latest`
                : `${base}/repos/${this.owner}/${this.repo}/releases/latest`;
            try {
                log.info(`尝试通过镜像检查更新: ${m.name}`);
                return await this.fetchRelease(apiUrl, base, 0, { timeout: this.mirrorTimeout, maxRetries: this.mirrorMaxRetries });
            } catch (e: any) {
                lastErr = e;
                log.warn(`镜像 ${m.name} 检查失败: ${e && e.message}`);
            }
        }
        throw new Error(`所有镜像均不可用: ${(lastErr && lastErr.message) || '未知错误'}`);
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
     * 从 release assets 中获取适合当前平台的下载链接
     * @param assets - GitHub release assets
     * @returns 下载链接
     */
    getDownloadUrl(assets: GitHubAsset[], mirrorBase?: string): string | null {
        if (!assets || assets.length === 0) {
            return null;
        }

        // 获取当前平台和架构信息
        const platform = process.platform;
        const arch = process.arch;
        
        log.info(`当前平台: ${platform}, 架构: ${arch}`);

        // 根据实际构建配置选择合适的安装包
        // 文件命名格式: Fntv-Plus_${version}_${os}_${arch}.${ext}（旧版为 FNMedia_ 前缀，正则同时兼容）
        let patterns: RegExp[] = [];

        switch (platform) {
            case 'win32':
                // Windows: 仅支持 x64
                if (arch === 'x64') {
                    patterns = [
                        /(?:FNMedia|Fntv-Plus)_.*_win_x64\.exe$/i,
                        /_win_x64\.exe$/i,
                        /win.*x64.*\.exe$/i
                    ];
                } else {
                    log.warn(`Windows 平台不支持架构: ${arch}, 仅支持 x64`);
                    return null;
                }
                break;
                
            case 'darwin':
                // macOS: 支持 x64 和 arm64
                if (arch === 'arm64') {
                    patterns = [
                        /(?:FNMedia|Fntv-Plus)_.*_mac_arm64\.dmg$/i,
                        /_mac_arm64\.dmg$/i,
                        /mac.*arm64.*\.dmg$/i
                    ];
                } else if (arch === 'x64') {
                    patterns = [
                        /(?:FNMedia|Fntv-Plus)_.*_mac_x64\.dmg$/i,
                        /_mac_x64\.dmg$/i,
                        /mac.*x64.*\.dmg$/i
                    ];
                } else {
                    log.warn(`macOS 平台不支持架构: ${arch}, 仅支持 x64 和 arm64`);
                    return null;
                }
                break;
                
            case 'linux':
                // Linux: 支持 x64 和 arm64
                if (arch === 'x64') {
                    patterns = [
                        /(?:FNMedia|Fntv-Plus)_.*_linux_x64\.AppImage$/i,
                        /_linux_x64\.AppImage$/i,
                        /linux.*x64.*\.AppImage$/i
                    ];
                } else if (arch === 'arm64') {
                    patterns = [
                        /(?:FNMedia|Fntv-Plus)_.*_linux_arm64\.AppImage$/i,
                        /_linux_arm64\.AppImage$/i,
                        /linux.*arm64.*\.AppImage$/i
                    ];
                } else {
                    log.warn(`Linux 平台不支持架构: ${arch}, 仅支持 x64 和 arm64`);
                    return null;
                }
                break;
                
            default:
                log.warn(`不支持的平台: ${platform}`);
                return null;
        }

        // 按优先级查找匹配的资源
        for (const pattern of patterns) {
            const asset = assets.find(asset => pattern.test(asset.name));
            if (asset) {
                log.info(`找到匹配的安装包: ${asset.name}`);
                
                // 获取原始下载链接
                const originalUrl = asset.browser_download_url;

                // 1) 若走镜像检查更新，优先用镜像重写下载链接（github.com → 镜像/https://github.com/...）
                if (mirrorBase && originalUrl.includes('github.com')) {
                    const proxiedUrl = `${mirrorBase.replace(/\/$/, '')}/${originalUrl}`;
                    log.info(`使用镜像下载链接: ${proxiedUrl}`);
                    return proxiedUrl;
                }

                // 2) 否则尝试获取用户配置的下载代理
                try {
                    const proxyConfig = getDownloadProxyConfig();
                    if (proxyConfig.enabled && proxyConfig.proxyUrl && proxyConfig.proxyUrl.trim() !== '') {
                        // 如果原始URL包含github.com，则使用代理
                        if (originalUrl.includes('github.com')) {
                            const proxiedUrl = `${proxyConfig.proxyUrl.replace(/\/$/, '')}/${originalUrl}`;
                            log.info(`使用代理下载链接: ${proxiedUrl}`);
                            return proxiedUrl;
                        }
                    }
                } catch (error: any) {
                    log.warn('获取代理配置失败，使用原始下载链接:', error.message);
                }
                
                log.info(`使用原始下载链接: ${originalUrl}`);
                return originalUrl;
            }
        }

        log.warn(`未找到适合当前平台 ${platform} (${arch}) 的安装包`);
        log.info('可用的安装包:', assets.map(asset => asset.name));
        return null;
    }

    /**
     * 显示更新对话框
     * @param updateInfo - 更新信息
     * @returns 用户是否选择立即更新
     */
    async showUpdateDialog(updateInfo: UpdateInfo): Promise<boolean> {
        const { latestVersion, releaseNotes, downloadUrl, htmlUrl } = updateInfo;

        const { response } = await fnosDialog(null, {
            type: 'info',
            title: '发现新版本',
            message: `飞牛影视有新版本可用！`,
            detail: `当前版本: ${this.currentVersion}\n最新版本: ${latestVersion}`,
            // 更新日志记录以 Markdown 传入，弹窗按 .md-body 富文本渲染（含标题/列表/加粗/链接）
            markdown: releaseNotes || '暂无更新说明',
            buttons: ['立即下载', '查看详情', '稍后提醒'],
            defaultId: 0,
            cancelId: 2,
        });

        switch (response) {
            case 0: // 立即下载
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
     * 显示没有更新的提示
     */
    async showNoUpdateDialog(): Promise<void> {
        await fnosDialog(null, {
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本',
            detail: `当前版本: ${this.currentVersion}`,
            buttons: ['确定'],
        });
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
                await this.showNoUpdateDialog();
            }
        } catch (error: any) {
            await this.showUpdateErrorDialog(error.message);
        }
    }

    /**
     * 通过镜像手动检查更新（GitHub 主接口 403 / 国内不可达时的备选）
     */
    async manualCheckForUpdatesViaMirror(): Promise<void> {
        try {
            const updateInfo = await this.checkForUpdatesViaMirror();

            if (updateInfo.hasUpdate) {
                await this.showUpdateDialog(updateInfo);
            } else {
                await this.showNoUpdateDialog();
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
