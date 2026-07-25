import * as fn from "./request";
import { HttpMethod } from "./request";
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { app } from 'electron';
import log from '../logger';
import * as types from './types';
import { isTrusted } from '../cert_trust';

// 字幕相关日志归到 'subtitle' 组件，可在设置面板单独开关
const subLog = log.component('subtitle');
import NodeCache from 'node-cache';

export class ApiService {
    private baseURL: string;
    private tempDir: string;
    private token: string;
    private static cache: NodeCache = new NodeCache({ stdTTL: 300 }); // 静态缓存实例，类共享

    /**
     * 创建api服务实例
     * @param baseURL - API基础URL
     * @param token - 授权令牌
     */
    constructor(baseURL: string, token: string = '') {
        this.baseURL = baseURL;
        this.tempDir = path.join(app.getPath('temp'), 'fntv_subtitles');
        this.token = token;

        this.downloadSubtitle = this.downloadSubtitle.bind(this);
    }

    /** 获取当前API基础URL
     * @returns 返回基础URL字符串
     */
    getBaseURL(): string {
        return this.baseURL;
    }

    /**
     * 创建带缓存的函数版本
     * @param fn - 要缓存的函数
     * @param defaultTtl - 默认缓存过期时间（秒），默认为300秒（5分钟）
     * @returns 返回带缓存的函数，支持可选的 options 参数
     */
    private createCachedFunction<T extends (...args: any[]) => Promise<any>>(
        fn: T,
        defaultTtl: number = 300
    ): (...args: [...Parameters<T>, options?: { ttl?: number, forceRefresh?: boolean }]) => ReturnType<T> {
        const originalName = fn.name.replace(/^bound /, ''); // 移除bind前缀
        return ((...allArgs: any[]) => {
            const lastArg = allArgs[allArgs.length - 1];
            let options = { ttl: defaultTtl, forceRefresh: false };
            let args: Parameters<T>;
            if (lastArg && typeof lastArg === 'object' && (lastArg.ttl !== undefined || lastArg.forceRefresh !== undefined)) {
                options = { ...options, ...lastArg };
                args = allArgs.slice(0, -1) as Parameters<T>;
            } else {
                args = allArgs as Parameters<T>;
            }
            if (options.forceRefresh) {
                return fn(...args);
            }
            // 缓存key包含baseURL，确保不同实例的缓存不会冲突
            const key = `${this.baseURL}_${originalName}_${JSON.stringify(args)}`;
            const cached = ApiService.cache.get(key);
            if (cached !== undefined) {
                log.debug(`缓存命中: ${key}`);
                return Promise.resolve(cached);
            }

            // 使用缓存的promise来避免并发竞争条件
            const cachePromiseKey = `promise_${key}`;
            const existingPromise = ApiService.cache.get(cachePromiseKey) as Promise<any> | undefined;

            if (existingPromise) {
                log.info(`使用现有请求: ${key}`);
                return existingPromise;
            }

            const promise = fn(...args).then(result => {
                ApiService.cache.set(key, result, options.ttl);
                ApiService.cache.del(cachePromiseKey); // 清理promise缓存
                log.info(`缓存设置: ${key}, TTL: ${options.ttl}s`);
                return result;
            }).catch(error => {
                ApiService.cache.del(cachePromiseKey); // 清理promise缓存
                throw error;
            });

            // 临时缓存promise以避免并发重复请求
            ApiService.cache.set(cachePromiseKey, promise, 30); // promise缓存30秒
            return promise;
        }) as any;
    }

    /**
     * 清理字幕临时目录（当超过100MB时）
     */
    private async cleanupSubtitleDirectory(): Promise<void> {
        try {
            let totalSize = 0;
            const files = fs.readdirSync(this.tempDir);

            // 计算目录总大小
            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                const stats = fs.lstatSync(filePath);
                if (stats.isFile()) {
                    totalSize += stats.size;
                }
            }

            // 如果超过100MB（104857600字节），清理目录
            const maxSize = 100 * 1024 * 1024; // 100MB
            if (totalSize > maxSize) {
                log.info(`字幕目录大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB 超过限制，开始清理...`);

                files.forEach(file => {
                    const filePath = path.join(this.tempDir, file);
                    if (fs.lstatSync(filePath).isFile()) {
                        fs.unlinkSync(filePath);
                    }
                });

                log.info('字幕目录清理完成');
            } else {
                log.info(`字幕目录大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB，无需清理`);
            }
        } catch (error) {
            log.error('清理字幕目录时发生错误:', error);
        }
    }

    /**
    * 用户登录
    */
    login(username: string, password: string): Promise<fn.ApiResponse<any>> {
        return fn.request(this.baseURL, '/v/api/v1/login', HttpMethod.POST, this.token, {
            app_name: "trimemedia-web",
            username: username,
            password: password,
        } as types.LoginData);
    }

    /**
     * 获取系统配置（含 OAuth 信息）
     */
    getSysConfig(): Promise<fn.ApiResponse<types.SysConfigResponse>> {
        return fn.request(this.baseURL, '/v/api/v1/sys/config', HttpMethod.GET, this.token);
    }

    /**
     * OAuth 授权码换取令牌
     */
    auth(code: string): Promise<fn.ApiResponse<types.AuthResponse>> {
        return fn.request(this.baseURL, '/v/api/v1/auth', HttpMethod.POST, this.token, {
            source: "Trim-NAS",
            code: code,
        } as types.AuthRequest);
    }

    /**
     * 用户登出
     */
    logout(): Promise<fn.ApiResponse<any>> {
        return fn.request(this.baseURL, '/v/api/v1/logout', HttpMethod.POST, this.token);
    }

    /**
     * 获取用户信息
     */
    getUserInfo(timeout?: number, tryTimes?: number): Promise<fn.ApiResponse<types.UserInfo>> {
        return fn.request(this.baseURL, '/v/api/v1/user/info', HttpMethod.GET, this.token, undefined, undefined, undefined, timeout, tryTimes);
    }

    /**
     * 获取视频播放信息
     * @param itemGuid - 视频项目的唯一标识符
     * @param options - 可选参数，包括媒体、音频、字幕、视频流的GUID
     * @returns 返回播放信息的Promise
     */
    getPlayInfo(itemGuid: string): Promise<fn.ApiResponse<types.PlayInfo>> {
        const data: types.PlayInfoData = {
            item_guid: itemGuid,
        };
        return fn.request(this.baseURL, '/v/api/v1/play/info', HttpMethod.POST, this.token, data);
    }

    /**
     * 获取播放质量列表
     * @param mediaGuid - 媒体文件的唯一标识符
     * @returns 返回播放质量列表的Promise
     */
    getPlayQuality(mediaGuid: string): Promise<fn.ApiResponse<types.PlayQualityResponse>> {
        return fn.request(this.baseURL, '/v/api/v1/play/quality', HttpMethod.POST, this.token, {
            media_guid: mediaGuid,
        });
    }


    /**
     * 获取流列表（包括视频、音频、字幕流）
     * @param itemGuid - 视频项目的唯一标识符
     * @returns 返回流列表的Promise
     */
    getStreamList(itemGuid: string): Promise<fn.ApiResponse<types.StreamListResponse>> {
        return fn.request(this.baseURL, `/v/api/v1/stream/list/${itemGuid}`, HttpMethod.GET, this.token);
    }

    /**
     * 获取播放列表（带缓存）
     */
    getEpisodeListCached = (() => {
        const cachedFn = this.createCachedFunction(this.getEpisodeList.bind(this), 600);
        Object.defineProperty(cachedFn, 'name', { value: 'getEpisodeList' });
        return cachedFn;
    })(); // 10分钟缓存

    /**
     * 获取播放列表
     * @returns 返回播放列表的Promise
     */
    getEpisodeList(id: string): Promise<fn.ApiResponse<types.PlayListItem[]>> {
        return fn.request(this.baseURL, `/v/api/v1/episode/list/${id}`, HttpMethod.GET, this.token);
    }

    /**
     * 获取其他视频列表
     * @param req - 项目列表请求参数
     * @returns 返回项目列表的Promise
     */
    getItemList(req: types.ItemListRequest): Promise<fn.ApiResponse<types.ItemListResponse>> {
        return fn.request(this.baseURL, '/v/api/v1/item/list', HttpMethod.POST, this.token, req);
    }

    /** 获取其他视频列表（带缓存）
     */
    getItemListCached = (() => {
        const cachedFn = this.createCachedFunction(this.getItemList.bind(this), 600);
        Object.defineProperty(cachedFn, 'name', { value: 'getItemList' });
        return cachedFn;
    })(); // 10分钟缓存

    /**
     * 判断字幕流是否为中文（简体/繁体/国语/普通话）
     */
    private isChineseSubtitle(stream: types.SubtitleStreamExtended): boolean {
        const lang = (stream.language || '').toLowerCase();
        if (/^(zh|chi|zho|cmn|yue)/.test(lang)) return true;
        if (/chinese|中文|国语|普通话|简体|繁体/.test(lang)) return true;
        const title = stream.title || '';
        if (/[一-鿿]/.test(title)) return true; // 标题含中文字符
        if (/中字|简体|繁体|国语|中文|字幕|chs|cht|gb|big5/i.test(title)) return true;
        return false;
    }

    /**
     * 计算字幕标题与影片中文标题的匹配度（0~2）：用于挑出"同剧同集"的正确字幕
     * 归一化会去掉季/集号/SxxExx 等噪声，仅比较核心片名是否相互包含
     */
    private scoreSubtitleTitle(stream: types.SubtitleStreamExtended, videoTitle?: string): number {
        if (!videoTitle) return 0;
        const norm = (s: string): string =>
            (s || '')
                .replace(/[[\]()（）【】\s._\-]/g, '')
                .replace(/(notitle|notvtitle)/gi, '') // 去掉 getTitle 的占位符噪声
                .replace(/第?\d+[集话話]/g, '')
                .replace(/s\d+e?\d+/gi, '')
                .toLowerCase();
        const a = norm(stream.title);
        const b = norm(videoTitle);
        if (!a || !b) return 0;
        if (a === b) return 2;
        if (a.includes(b) || b.includes(a)) return 1;
        return 0;
    }

    /**
     * 获取字幕文件列表（中文优先 + 标题匹配）
     * @param itemGuid - 视频项目的唯一标识符
     * @param videoTitle - 可选，影片中文标题，用于挑选同剧同集的正确字幕
     * @returns 返回字幕对象数组（已按"最应该显示"排序，第一个为最佳）
     */
    async getSubtitle(itemGuid: string, videoTitle?: string): Promise<types.Subtitle[]> {
        const log = subLog; // 本函数内日志归入 subtitle 组件
        try {
            const response = await this.getStreamList(itemGuid);

            if (response.success && response.data) {
                const streams: types.SubtitleStreamExtended[] =
                    (response.data.subtitle_streams as types.SubtitleStreamExtended[]) || [];
                const external = streams.filter(stream => stream.is_external);

                if (external.length === 0) {
                    log.info('没有找到外挂字幕文件');
                    return [];
                }

                // 优先中文外挂字幕；若服务端未提供任何中文，则回退到全部外挂（避免无字幕可用）
                const chinese = external.filter(s => this.isChineseSubtitle(s));
                const pool = chinese.length > 0 ? chinese : external;

                // 计算每条字幕标题与影片标题的匹配度，用于剔除错配
                // （飞牛偶发把别的剧字幕元数据挂到本集，如本集返回「佐罗」字幕）
                pool.forEach(s => { (s as any).__score = this.scoreSubtitleTitle(s, videoTitle); });
                const matched = pool.filter(s => (s as any).__score > 0);

                // 是否为分集内容（电视剧/综艺）：视频标题含 SxxExx 即视为剧集
                const isEpisode = /s\d+e\d+/i.test(videoTitle || '');

                let usePool: types.SubtitleStreamExtended[];
                let forcedFallback = false;
                if (matched.length > 0) {
                    usePool = matched; // 有匹配项：仅用匹配项，避免混入错配字幕
                } else if (!isEpisode) {
                    // 电影/单集：标题无法确认匹配时仍退化为挂载最佳一条，避免无字幕可用
                    // （电影通常只有一份正确字幕，且往往无分集名可供严格匹配）
                    usePool = pool;
                    forcedFallback = pool.length > 0;
                } else {
                    // 剧集且无一匹配：极可能是飞牛字幕元数据错配，不挂载，避免乱匹配
                    usePool = [];
                }

                if (usePool.length === 0) {
                    if (matched.length === 0 && isEpisode && pool.length > 0) {
                        log.warn(`字幕标题均不与当前剧集匹配(videoTitle=${videoTitle})，疑似飞牛字幕元数据错配，` +
                            `已跳过挂载避免乱匹配；候选字幕:`, pool.map(p => p.title));
                    } else {
                        log.info('没有可用外挂字幕(匹配后为空)');
                    }
                    return [];
                }

                // 排序：默认字幕优先 → 与影片标题匹配度高者优先 → 标题字母序
                usePool.sort((x, y) => {
                    const d = (y.is_default || 0) - (x.is_default || 0);
                    if (d !== 0) return d;
                    const m = ((y as any).__score || 0) - ((x as any).__score || 0);
                    if (m !== 0) return m;
                    return (x.title || '').localeCompare(y.title || '');
                });

                // 只选用「最佳匹配」的一条，避免一次性挂载多条字幕
                const best = usePool[0];
                const subtitle: types.Subtitle = {
                    id: best.guid,
                    format: best.format,
                    name: best.title
                };
                if (forcedFallback) {
                    log.warn(`字幕标题未与影片(${videoTitle})匹配，已退化挂载最佳一条(可能不准确):`,
                        subtitle.name, `(score=0, guid=${best.guid})`);
                } else {
                    log.info(`获取到字幕(最佳匹配):`, subtitle.name,
                        `(score=${(best as any).__score}, 中文优先 ${chinese.length}/${external.length}, guid=${best.guid}, format=${subtitle.format})`);
                }
                return [subtitle];
            } else {
                log.error('获取字幕列表失败:', response.message);
                return [];
            }
        } catch (error) {
            log.error('获取字幕列表时发生错误:', error);
            return [];
        }
    }

    /**
     * 下载字幕文件
     * @param subs - 字幕对象数组
     * @returns 返回下载成功的字幕文件路径数组
     */
    async downloadSubtitle(subs: types.Subtitle[]): Promise<string[]> {
        const log = subLog; // 本函数内日志归入 subtitle 组件
        // 确保临时目录存在
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        } else {
            // 检查文件夹大小，超过100MB时清理
            await this.cleanupSubtitleDirectory();
        }

        // 准备下载任务
        const downloadTasks = subs.map(sub => {
            const { id, name = id, format = 'srt' } = sub;
            // 仅剔除文件系统非法字符，保留中文，使字幕显示名可读（MPV 内不再全是"___"）
            const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
            const filePath = path.join(this.tempDir, `${safeName}@${id}.${format}`);

            // 检查文件是否已存在
            if (fs.existsSync(filePath)) {
                log.info(`⏭️  字幕文件已存在，跳过下载: ${filePath}`);
                return Promise.resolve({ id, filePath, success: true } as types.SubtitleDownloadResult);
            }

            return fn.request(this.baseURL, `/v/api/v1/subtitle/dl/${id}`, HttpMethod.GET, this.token)
                .then(response => {
                    if (response.success && response.data) {
                        return fs.promises.writeFile(filePath, response.data)
                            .then(() => {
                                log.info(`✅ 字幕文件已下载到: ${filePath}`);
                                return { id, filePath, success: true } as types.SubtitleDownloadResult;
                            });
                    } else {
                        log.error(`❌ 服务端错误: ${response.message} (ID: ${id})`);
                        return { id, filePath, success: false, error: `HTTP ${response.message}` } as types.SubtitleDownloadResult;
                    }
                })
                .catch((error: any) => {
                    let errorMsg = '未知错误';
                    if (error.response) {
                        errorMsg = `服务端错误: ${error.response.status}`;
                    } else if (error.request) {
                        errorMsg = '网络错误: 无响应';
                    } else {
                        errorMsg = `请求错误: ${error.message}`;
                    }
                    log.error(`❌ ID ${id} 下载失败: ${errorMsg}`);
                    return { id, filePath, success: false, error: errorMsg } as types.SubtitleDownloadResult;
                });
        });

        // 执行所有下载任务
        const results = await Promise.allSettled(downloadTasks);

        // 处理结果
        const successfulDownloads = results
            .filter((result): result is PromiseFulfilledResult<types.SubtitleDownloadResult> =>
                result.status === 'fulfilled' && result.value.success)
            .map(result => result.value.filePath);

        const failedCount = results.length - successfulDownloads.length;
        const skippedCount = subs.filter(sub => {
            const safeName = String(sub.name || sub.id).replace(/[\\/:*?"<>|]/g, '_');
            const filePath = path.join(this.tempDir, `${safeName}@${sub.id}.${sub.format || 'srt'}`);
            return fs.existsSync(filePath);
        }).length;
        const downloadedCount = successfulDownloads.length - skippedCount;

        log.info('========================================');
        log.info('字幕下载摘要:');
        log.info(`🔹 总数: ${subs.length}`);
        log.info(`📥 新下载: ${downloadedCount}`);
        log.info(`⏭️  跳过: ${skippedCount}`);
        log.info(`❌ 失败: ${failedCount}`);
        log.info('========================================');

        log.info('成功下载的字幕文件:', successfulDownloads);
        return successfulDownloads;
    }

    /**
     * 获取视频直链地址
     * @param mediaGuid - 视频项目的唯一标识符
     * @returns 返回视频直链地址
     */
    getVideoUrl(mediaGuid: string): string {
        return `${this.baseURL}/v/api/v1/media/range/${mediaGuid}`;
    }

    /**
     * 设置视频为已观看状态
     * @param itemGuid - 视频项目的唯一标识符
     * @returns 返回设置结果的Promise
     */
    setWatched(itemGuid: string): Promise<fn.ApiResponse<any>> {
        return fn.request(this.baseURL, '/v/api/v1/item/watched', HttpMethod.POST, this.token, {
            item_guid: itemGuid,
        } as types.WatchedData);
    }

    /**
     * 记录播放状态
     * @param statusData - 播放状态数据
     * @returns 返回记录结果的Promise
     */
    recordPlayStatus(statusData: types.PlayStatusData): Promise<fn.ApiResponse<any>> {
        return fn.request(this.baseURL, '/v/api/v1/play/record', HttpMethod.POST, this.token, statusData);
    }

    /**
     * 获取流信息（包括视频、音频、字幕流和质量信息）
     * @param mediaGuid - 媒体文件的唯一标识符
     * @param ip - IP地址
     * @param nonce - 随机数
     * @returns 返回流信息的Promise
     */
    getStream(mediaGuid: string, ip: string): Promise<fn.ApiResponse<types.StreamResponse>> {
        const data: types.StreamRequestData = {
            header: {
                "User-Agent": ["trim_player"]
            },
            level: 1,
            media_guid: mediaGuid,
            ip: ip,
        };

        return fn.request(this.baseURL, '/v/api/v1/stream', HttpMethod.POST, this.token, data);
    }

    /**
     * 获取用户信息（带缓存）
     */
    getUserInfoCached = (() => {
        const cachedFn = this.createCachedFunction(this.getUserInfo.bind(this), 600);
        Object.defineProperty(cachedFn, 'name', { value: 'getUserInfo' });
        return cachedFn;
    })();

    /**
     * 获取视频播放信息（带缓存）
     */
    getPlayInfoCached = (() => {
        const cachedFn = this.createCachedFunction(this.getPlayInfo.bind(this), 300);
        Object.defineProperty(cachedFn, 'name', { value: 'getPlayInfo' });
        return cachedFn;
    })();

    /**
     * 获取播放质量列表（带缓存）
     */
    getPlayQualityCached = (() => {
        const cachedFn = this.createCachedFunction(this.getPlayQuality.bind(this), 300);
        Object.defineProperty(cachedFn, 'name', { value: 'getPlayQuality' });
        return cachedFn;
    })(); // 5分钟缓存

    /**
     * 获取流列表（带缓存）
     */
    getStreamListCached = (() => {
        const cachedFn = this.createCachedFunction(this.getStreamList.bind(this), 300);
        Object.defineProperty(cachedFn, 'name', { value: 'getStreamList' });
        return cachedFn;
    })(); // 5分钟缓存

    /**
     * 获取流信息（带缓存）
     */
    getStreamCached = (() => {
        const cachedFn = this.createCachedFunction(this.getStream.bind(this), 300);
        Object.defineProperty(cachedFn, 'name', { value: 'getStream' });
        return cachedFn;
    })(); // 5分钟缓存
}

// 重新导出类型定义，保持向后兼容
export * from './types';
