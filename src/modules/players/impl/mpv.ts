import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMalId } from '../../../main/common/skipMalMap';
import {
    BasePlayer,
    Config,
    PlayStatusData,
    PlayerType,
    EventType,
    PlayErrorData,
    PlayExitData,
    PlayItem, // <-- Add PlayItem to the import list
    PlayerControlAction
} from '../types';
import { PlayerFactory } from '../factory';
import logger from '../../logger';
import { getMainWindow } from '../../../main/common/mainwin';
import { app } from 'electron';
const log = logger.component('mpv');
import NodeMpv, { TimePosition } from 'node-mpv-2';
import { title } from 'process';

export class MpvPlayer extends BasePlayer {
    private mpvInstance: NodeMpv | null = null;
    // 节流调用
    private lastProgressTime: number = 0;
    private throttleInterval: number = 15000; // 15秒间隔（毫秒）
    // 播放列表相关
    private playlistItems: PlayItem[] = [];
    private playlistFilePath: string = '';
    // [lc-1016] 字幕挂载链路的代次号：每次 path 事件递增。异步链路（取列表→下载→挂载→重试）
    // 在每个关键点检查代次号是否仍是最新，过期立即放弃——防止慢链路把新一集刚挂好的字幕删掉/盖掉。
    private subLoadSeq: number = 0;
    // mpv 日志文件 tail → 转发进 app.log（弹幕脚本日志可见性）
    private mpvLogPath: string = '';
    private mpvLogTailTimer: NodeJS.Timeout | null = null;
    private mpvLogOffset: number = 0;
    private mpvLogRemainder: string = '';

    constructor(config: Config) {
        super(config);
    }

    /**
     * 播放媒体列表
     */
    async playList(infos: PlayItem[], pos: number, args?: string[]): Promise<boolean> {
        try {
            const t0 = Date.now();
            // 构建 MPV 参数
            const mpvArgs: string[] = [];

            // 添加请求头
            const headerArgs: string[] = [];
            for (const [key, value] of Object.entries(this.config.headers)) {
                headerArgs.push(`${key}: ${value}`);
            }
            if (headerArgs.length > 0) {
                mpvArgs.push(`--http-header-fields=${headerArgs.join(',')}`);
            }

            // 添加其他参数
            mpvArgs.push(
                ...this.config.extraArgs,
                ...args || []
            );

            // 让 mpv 写日志文件到 app.log 同目录（mpv.log）。
            // 注意：node-mpv-2 默认传 --msg-level=all=no（终端全静默），但 --log-file
            // 恒定以 verbose 级别写文件、不受 msg-level 影响，因此弹幕脚本(uosc_danmaku)
            // 的 msg.info 日志只有这里才能看到。之后 tail 该文件把弹幕相关行转发进 app.log。
            try {
                const logDir = logger.getLogDir();
                this.mpvLogPath = path.join(logDir, 'mpv.log');
                mpvArgs.push(`--log-file=${this.mpvLogPath}`);
            } catch (e) {
                log.warn('计算 mpv.log 路径失败，跳过 mpv 日志转发:', e);
                this.mpvLogPath = '';
            }

            let mpvOptions = {
                debug: this.config.debug,
                binary: this.config.playerPath.length > 0 ? this.config.playerPath : undefined,
            };

            // [lc-201] 让 mpv 子进程(Lua 弹幕脚本)能定位 Electron userData 目录，用于写"打开设置面板"的文件信号
            try { process.env.FNTV_USERDATA = app.getPath('userData'); } catch {}

            this.mpvInstance = new NodeMpv(mpvOptions, mpvArgs);

            // 设置事件监听器
            this.setupEventListeners();

            // 启动 MPV 并加载媒体
            await this.mpvInstance.start()
            log.info(`[perf] MPV 进程启动耗时 ${Date.now() - t0}ms`);

            // 开始 tail mpv.log，把弹幕脚本日志转发进 app.log
            this.startMpvLogTail();

            // [skip] 向 MPV 注入 theintrodb 兜底所需的元数据（guid -> tmdb/season/episode）
            // 必须在 loadPlaylistItems 之前发送，确保 smart_skip 脚本在 file-loaded 时已拿到映射
            try {
                const skipMeta: Record<string, { tmdb: string; season?: number; episode?: number; mal?: number }> = {};
                for (const it of infos) {
                    if (it.trimId) {
                        skipMeta[it.itemGuid] = {
                            tmdb: it.trimId,
                            season: it.seasonNumber > 0 ? it.seasonNumber : undefined,
                            episode: it.episodeNumber > 0 ? it.episodeNumber : undefined,
                        };
                    }
                }
                if (this.mpvInstance && Object.keys(skipMeta).length > 0) {
                    this.mpvInstance.command('script-message', ['skip-metadata', JSON.stringify(skipMeta)]);
                    log.debug('已发送 skip 元数据, 条目数:', Object.keys(skipMeta).length);
                    // [lc-1059] AniSkip 需要 MAL id：后台跑标题映射链(Bangumi→Jikan/AniList, 缓存 30 天)，
                    //   拿到后补发完整 skip-metadata(带 mal 字段)，Lua 端据此触发 AniSkip 兜底
                    void (async () => {
                        try {
                            const malByTmdb = new Map<string, number>();
                            for (const it of infos) {
                                if (!it.trimId || !it.tvTitle || malByTmdb.has(it.trimId)) continue;
                                const mal = await resolveMalId(it.trimId, it.tvTitle).catch(() => null);
                                if (mal) malByTmdb.set(String(it.trimId).replace(/^tt/i, ''), mal);
                            }
                            if (malByTmdb.size === 0) return;
                            let updated = 0;
                            for (const key of Object.keys(skipMeta)) {
                                const entry = skipMeta[key];
                                const tmdb = String(entry.tmdb || '').replace(/^tt/i, '');
                                const mal = malByTmdb.get(tmdb);
                                if (mal) { entry.mal = mal; updated++; }
                            }
                            if (updated > 0 && this.mpvInstance) {
                                this.mpvInstance.command('script-message', ['skip-metadata', JSON.stringify(skipMeta)]);
                                log.info(`已补发 skip 元数据(含 MAL), 条目数: ${updated}`);
                            }
                        } catch (e) {
                            log.warn('AniSkip MAL 映射失败:', e);
                        }
                    })();
                }
            } catch (e) {
                log.warn('发送 skip 元数据失败:', e);
            }

            // 将所有的infos按顺序加入播放列表，并且播放第pos个视频
            await this.loadPlaylistItems(infos, pos);
            log.info(`[perf] MPV 播放列表加载完成, 启动流程共耗时 ${Date.now() - t0}ms`);

            if (this.config.debug) {
                log.debug('MPV 实例启动成功');
            }

            return true;

        } catch (error: any) {
            log.error('MPV 初始化失败:', error);
            const errorEvent: PlayErrorData = {
                message: error.message || error.toString()
            };
            this.emitEvent(EventType.ERROR, errorEvent);
            return false;
        }
    }

    /**
     * 生成并加载播放列表文件
     */
    private async loadPlaylistItems(infos: PlayItem[], pos: number): Promise<void> {
        if (!this.mpvInstance || infos.length === 0) {
            throw new Error('MPV实例未启动或播放列表为空');
        }

        try {
            // 保存播放列表信息
            this.playlistItems = infos;

            // 生成 M3U8 播放列表文件
            const playlistContent = this.generateM3U8Playlist(infos);
            this.playlistFilePath = path.join(os.tmpdir(), `mpv_playlist_${Date.now()}.m3u8`);

            await fs.promises.writeFile(this.playlistFilePath, playlistContent, 'utf-8');

            if (this.config.debug) {
                log.debug(`生成播放列表文件: ${this.playlistFilePath}`);
                log.debug(`播放列表内容:\n${playlistContent}`);
            }

            // 加载播放列表文件
            await this.mpvInstance.loadPlaylist(this.playlistFilePath, 'replace');

            // 跳转到指定位置
            if (pos > 0) {
                // 更新全局状态
                this.updateCurrentItemStatus(pos);
                // 这个函数如果await的话有可能会卡死，有点坑
                this.mpvInstance.jump(pos);
                if (this.config.debug) {
                    log.debug(`跳转到播放列表位置: ${pos} (${infos[pos].title})`);
                }
            }

            if (this.config.debug) {
                log.debug(`播放列表加载完成，当前播放: ${infos[pos].title}`);
            }
        } catch (error: any) {
            log.error('加载播放列表失败:', error);
            throw error;
        }
    }

    /**
     * 获取视频标题
     */
    private getTitle(info: PlayItem): string {
        // 构建标题
        let title = info.title || '';
        if (info.tvTitle) {
            title = `${info.tvTitle || 'noTVTitle'} - S${info.seasonNumber || '0'}E${info.episodeNumber || '0'}: ${info.title || 'noTitle'}`;
        }

        // 补充一个item_id用于区分当前是哪个视频
        // title = `${title}@${info.itemGuid}`;
        return title;
    }

    /**
     * 生成 M3U8 播放列表内容
     */
    private generateM3U8Playlist(infos: PlayItem[]): string {
        let content = '#EXTM3U\n';

        for (let i = 0; i < infos.length; i++) {
            const item = infos[i];
            const title = this.getTitle(item);

            // 使用实际时长，如果没有则使用 -1
            const duration = item.duration || -1;

            // 添加扩展信息，包含播放进度
            content += `#EXTINF:${duration},${title}\n`;
            content += `${item.playLink}\n`;
        }

        return content;
    }

    /**
     * 更新当前播放项状态
     */
    private updateCurrentItemStatus(index: number): void {
        if (index >= 0 && index < this.playlistItems.length) {
            const currentItem = this.playlistItems[index];

            let st = this.getStatus();
            st.itemGuid = currentItem.itemGuid;
            st.ts = currentItem.ts;
            st.duration = currentItem.duration;
            st.percentage = currentItem.duration > 0 ? Math.floor((currentItem.ts / currentItem.duration) * 100) : 0;
            this.updateGlobalStatus(st);
        }
    }

    /**
     * 保存当前播放项状态
     * @param status 播放状态数据
     * @param itemGuid 当前播放项 GUID
     */
    private saveCurrentItemStatus(status: PlayStatusData): void {
        const item = this.playlistItems.find(i => i.itemGuid === status.itemGuid);
        if (item) {
            item.ts = status.ts;
        }
    }

    /**
     * 设置事件监听器
     */
    private setupEventListeners(): void {
        if (!this.mpvInstance) return;

        // 开始进度监控
        this.startProgressMonitoring();

        // 监听播放结束事件
        this.mpvInstance.on('stopped', () => {
            // this.handleExit(0);
            log.info('MPV 播放结束');
        });

        // 监听错误事件
        this.mpvInstance.on('crashed', () => {
            log.error('MPV 播放器崩溃');
            const errorEvent: PlayErrorData = {
                message: 'MPV 播放器崩溃'
            };
            this.emitEvent(EventType.ERROR, errorEvent);
            this.handleExit(1);
        });

        // 监听退出事件
        this.mpvInstance.on('quit', () => {
            this.handleExit(0);
        });

        // 监听状态变化
        this.mpvInstance.on('status', (status: any) => {
            if (this.config.debug) {
                log.debug('MPV 状态变化:', status);
            }

            if (status.property === 'playlist-pos' && typeof status.value === 'number') {
                // 更新当前播放项状态
                this.updateCurrentItemStatus(status.value);
            }

            // 监听播放路径位置
            if (status.property === 'path' && typeof status.value === 'string') {
                // 解析url中的itemid
                const itemGuid = this.getItemIdFromFilename(status.value);
                if (!itemGuid) {
                    if (this.config.debug) {
                        log.debug('path changed: 无法从路径中解析出 itemGuid:', status.value);
                    }
                    return;
                }

                const currentItem = this.playlistItems.find(item => item.itemGuid === itemGuid);
                const videoTitle = currentItem ? this.getTitle(currentItem) : undefined;
                if (currentItem) {
                    // 设置窗口标题：剥掉 CJK 直角引号/书名号(『』「」《》等)，
                    // 避免这些字符在 MPV OSC/字幕字体里无字形而显示成乱码框；
                    // 注意：getSubtitle 仍用原始 videoTitle 以保留字幕标题匹配精度
                    const displayTitle = (videoTitle || '').replace(/[『』「」【】〔〕《》〈〉""'']/g, '').trim();
                    this.mpvInstance?.setProperty('force-media-title', displayTitle).catch(err => {
                        if (this.config.debug) {
                            log.debug('设置窗口标题失败:', err);
                        }
                    });

                    // 尝试跳转到上次播放位置, 即将到达片尾不跳转
                    if (currentItem.ts > 0 && currentItem.ts <= 0.98 * currentItem.duration) {
                        // 使用重试机制进行跳转, 这里粗暴了点, 视频没加载没法跳，只能重试
                        this.seekWithRetry(currentItem.ts, 50000, 10);
                    }
                }

                // [lc-1016] 获取并挂载 fnOS 外挂字幕（防陈旧竞态 + 空结果退避重试，见方法注释）
                this.mountSubtitlesWithRetry(itemGuid, videoTitle);
            }
        });

        // 监听跳转事件
        this.mpvInstance.on('seek', (t: TimePosition) => {
            // Handle seek events
            if (this.config.debug) {
                log.debug('Seek event detected, new position:', t);
            }

            // 通知更新跳转
            const st = this.getStatus();
            st.ts = Math.floor(t.end);

            // 保存到全局的playlist
            this.saveCurrentItemStatus(st);
            this.emitEvent(EventType.PROGRESS, st);
        });
    }

    /**
     * [lc-1016] 为当前播放的媒体挂载 fnOS 外挂字幕（自愈 + 防陈旧竞态版）。
     *
     * 背景（用户反馈：字幕有时自动加载、有时要手动点字幕轨才有）：
     *   1. fnOS 刚开播时流元数据可能尚未就绪，stream/list 瞬时返回空 subtitle_streams；
     *      旧实现拿到空列表直接放弃，之后不再补挂 → 只能手动点字幕轨。
     *   2. 快速切集/带进度起播时（loadPlaylist 先载 item0 再 jump），多次 path 事件并行跑
     *      字幕链路；旧一集的慢链路返回后会执行 removeAllExternalSubtitles + addSubtitles，
     *      把当前集刚挂好的字幕删掉或盖成错误集的。
     *   3. 下载/挂载失败只记 debug 日志，用户反馈时日志无从排查。
     *
     * 方案：每次 path 事件递增 subLoadSeq，整条链路绑定本次代次号；在取列表/下载/清理/
     * 挂载每个关键点检查是否仍为最新代次，过期立即静默退出（不触碰 MPV 轨道）。
     * 空列表/下载失败按退避（3s → 8s）重试，最多 3 次；失败日志提升到 info。
     */
    private mountSubtitlesWithRetry(itemGuid: string, videoTitle: string | undefined): void {
        const fnapi = this.getFnApi();
        const seq = ++this.subLoadSeq;
        const isStale = () => seq !== this.subLoadSeq;
        const label = videoTitle || itemGuid;
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAYS_MS = [3000, 8000];

        (async () => {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const subs = await fnapi.getSubtitle(itemGuid, videoTitle);
                    if (isStale()) return;
                    if (subs.length > 0) {
                        const subPaths = await fnapi.downloadSubtitle(subs);
                        if (isStale()) return;
                        if (subPaths.length > 0) {
                            log.info(`[字幕] ${label} 下载到字幕:`, subPaths.map(p => path.basename(p).split('@')[0]));
                            // 切集/重挂前先清旧外部字幕，避免旧集字幕与弹幕残留叠加
                            await this.removeAllExternalSubtitles();
                            if (isStale()) return;
                            // 第一个为最佳匹配（已按中文优先 / 默认轨 / 标题匹配度排序），选中显示；
                            // 其余以 auto 方式加载，供用户在字幕菜单中手动切换
                            subPaths.forEach((subPath, idx) => {
                                const subName = path.basename(subPath).split("@")[0];
                                const flag = idx === 0 ? "select" : "auto";
                                if (idx === 0) log.info(`[字幕] 选中显示: ${subName}`);
                                this.mpvInstance?.addSubtitles(subPath, flag, subName).catch(err => {
                                    log.info('[字幕] 加载字幕失败:', err);
                                });
                            });
                            return;
                        }
                        log.info(`[字幕] ${label} 字幕下载失败(第${attempt}/${MAX_ATTEMPTS}次)`);
                    } else if (attempt === 1) {
                        log.info(`[字幕] ${label} 暂无外挂字幕流(可能 fnOS 元数据未就绪，稍后重试)`);
                    }
                } catch (err) {
                    // 字幕获取/下载失败不应影响播放；此处必须捕获以免产生 UnhandledPromiseRejection
                    if (isStale()) return;
                    log.info(`[字幕] ${label} 字幕获取/下载异常(第${attempt}/${MAX_ATTEMPTS}次):`, err);
                }
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]));
                    if (isStale()) return;
                }
            }
            log.info(`[字幕] ${label} 重试${MAX_ATTEMPTS}次后仍无外挂字幕(媒体可能确实没有外挂字幕)`);
        })().catch(() => { /* 不影响播放 */ });
    }

    /**
     * 移除所有外部字幕轨道（切集时调用，防止旧集数字幕/弹幕残留叠加）
     */
    private async removeAllExternalSubtitles(): Promise<void> {
        if (!this.mpvInstance || !this.mpvInstance.isRunning()) return;
        try {
            const raw = await this.mpvInstance.getProperty('track-list');
            const tracks: Array<{ type: string; id: number; external?: boolean }> = JSON.parse(raw as string);
            // 从后往前删（避免 id 偏移），只删 external 字幕
            const subIds = tracks
                .filter(t => t.type === 'sub' && t.external)
                .map(t => t.id)
                .sort((a, b) => b - a); // 降序：先删大 id
            for (const id of subIds) {
                await this.mpvInstance.removeSubtitles(id);
            }
            if (subIds.length > 0 && this.config.debug) {
                log.debug(`已移除 ${subIds.length} 个旧外部字幕轨道: [${subIds.join(', ')}]`);
            }
        } catch (err) {
            if (this.config.debug) {
                log.debug('清理旧字幕失败(可忽略):', err);
            }
        }
    }

    /**
     * 带重试机制的跳转函数
     * @param position 跳转位置（秒）
     * @param maxRetries 最大重试次数
     * @param delayMs 每次重试的延迟时间（毫秒）
     */
    private async seekWithRetry(position: number, maxRetries: number, delayMs: number): Promise<void> {
        let retryCount = 0;

        const attemptSeek = async (): Promise<void> => {
            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    if (!this.mpvInstance || !this.mpvInstance.isRunning()) {
                        reject(new Error('MPV 实例不存在或未运行'));
                        return;
                    }

                    try {
                        await this.mpvInstance.goToPosition(position);
                        if (this.config.debug) {
                            log.info(`跳转成功: 位置 ${position}s ${retryCount > 0 ? `(重试 ${retryCount} 次后成功)` : ''}`);
                        }
                        resolve();
                    } catch (error) {
                        retryCount++;
                        if (retryCount <= maxRetries) {
                            // 重试，使用固定延迟时间
                            setTimeout(() => {
                                attemptSeek().then(resolve).catch(reject);
                            }, delayMs);
                        } else {
                            log.info(`跳转失败，已达到最大重试次数 ${maxRetries} (位置: ${position}s):`, error);
                            reject(error);
                        }
                    }
                }, delayMs);
            });
        };

        try {
            await attemptSeek();
        } catch (error) {
            // 最终失败，记录错误但不抛出异常
            if (this.config.debug) {
                log.debug('path changed: 跳转到指定时间点最终失败:', error);
            }
        }
    }

    /**
     * 从 filename 中提取 itemId
     * @param filename 播放的文件名或 URL
     * @returns 提取的 itemId 或 null
     */
    public getItemIdFromFilename(filename: string): string | null {
        const url = new URL(filename);
        const itemGuid = url.pathname.split('/').pop();
        return itemGuid || null;
    }

    /**
     * 开始进度监控
     */
    private startProgressMonitoring(): void {
        this.mpvInstance?.on('timeposition', async (currentTime: number) => {
            if (!this.mpvInstance || !this.mpvInstance.isRunning()) {
                return;
            }

            const [duration, percentage, filename] = await Promise.all([
                this.mpvInstance.getDuration().catch(() => 0),
                this.mpvInstance.getPercentPosition().catch(() => 0),
                this.mpvInstance.getFilename().catch(() => 0)
            ]);

            if (duration === 0) {
                log.warn('视频时长为 0，无法获取进度信息');
                return;
            }

            // 从filename获取当前播放的itemGuid
            const itemGuid = this.getItemIdFromFilename(String(filename));
            if (!itemGuid) {
                log.warn('无法从文件名中解析出 itemGuid:', filename);
                return;
            }

            const progressData: PlayStatusData = this.getStatus();
            progressData.itemGuid = itemGuid;
            progressData.ts = Math.floor(currentTime);
            progressData.duration = Math.floor(duration);
            progressData.percentage = Math.floor(percentage);

            // 保存当前播放项状态
            this.saveCurrentItemStatus(progressData);
            // 更新全局状态
            this.updateGlobalStatus(progressData);
            // 节流处理
            const now = Date.now();
            if (now - this.lastProgressTime >= this.throttleInterval) {
                this.emitEvent(EventType.PROGRESS, progressData);
                this.lastProgressTime = now;
            }
        });
    }

    /**
     * 开始 tail mpv.log：定时增量读取，把弹幕脚本相关行转发进 app.log
     */
    private startMpvLogTail(): void {
        if (!this.mpvLogPath) return;
        this.stopMpvLogTail();
        // mpv 启动时会截断（truncate）--log-file 指定的文件，从头读即可
        this.mpvLogOffset = 0;
        this.mpvLogRemainder = '';
        this.mpvLogTailTimer = setInterval(() => this.pumpMpvLog(), 1000);
        log.info(`mpv 日志文件: ${this.mpvLogPath}（弹幕相关日志将转发到 app.log）`);
    }

    /**
     * 增量读取 mpv.log 新内容，过滤出弹幕脚本日志写入 app.log。
     * 只转发弹幕相关行：--log-file 是 verbose 级别，全量转发会刷爆 app.log。
     */
    private pumpMpvLog(): void {
        try {
            if (!this.mpvLogPath || !fs.existsSync(this.mpvLogPath)) return;
            const size = fs.statSync(this.mpvLogPath).size;
            if (size < this.mpvLogOffset) {
                // 文件被截断（mpv 重启），从头再读
                this.mpvLogOffset = 0;
                this.mpvLogRemainder = '';
            }
            if (size === this.mpvLogOffset) return;
            const fd = fs.openSync(this.mpvLogPath, 'r');
            const len = size - this.mpvLogOffset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, this.mpvLogOffset);
            fs.closeSync(fd);
            this.mpvLogOffset = size;
            const text = this.mpvLogRemainder + buf.toString('utf8');
            const lines = text.split(/\r?\n/);
            // 最后一段若不是完整行，留到下次拼接
            this.mpvLogRemainder = lines.pop() || '';
            for (const line of lines) {
                if (!line) continue;
                if (line.includes('uosc_danmaku') || line.includes('自动补源') ||
                    line.includes('番剧区') || line.includes('视频区') ||
                    line.includes('bili_danmaku') || line.includes('BILI_RESULT') ||
                    line.includes('弹弹play')) {
                    log.info('[mpv]', line);
                }
            }
        } catch {
            // 读日志失败不影响播放，静默忽略
        }
    }

    /**
     * 停止 tail mpv.log（播放器退出时调用；停止前做最后一次冲刷）
     */
    private stopMpvLogTail(): void {
        if (this.mpvLogTailTimer) {
            clearInterval(this.mpvLogTailTimer);
            this.mpvLogTailTimer = null;
            // 最后冲刷一次，避免丢失退出前的日志
            this.pumpMpvLog();
        }
    }

    /**
     * 处理退出事件
     */
    private handleExit(code: number): void {
        // 停止 mpv 日志转发
        this.stopMpvLogTail();

        // 清理播放列表文件
        this.cleanupPlaylistFile();

        // 发射退出事件
        const event: PlayExitData = {
            code: code,
            status: this.getStatus()
        };

        this.emitEvent(EventType.EXIT, event);

        if (this.config.debug) {
            if (code !== 0) {
                log.error(`播放异常结束 (code ${code})`);
            } else {
                log.info('播放器正常退出');
            }
        }

        // 清理实例引用
        this.mpvInstance = null;
    }

    /**
     * 清理播放列表文件
     */
    private cleanupPlaylistFile(): void {
        if (this.playlistFilePath && fs.existsSync(this.playlistFilePath)) {
            try {
                fs.unlinkSync(this.playlistFilePath);
                if (this.config.debug) {
                    log.debug(`已清理播放列表文件: ${this.playlistFilePath}`);
                }
            } catch (error) {
                if (this.config.debug) {
                    log.debug('清理播放列表文件失败:', error);
                }
            }
            this.playlistFilePath = '';
        }
    }

    /**
     * 停止播放
     */
    stop(): void {
        if (this.mpvInstance) {
            try {
                log.info('停止播放');
                this.mpvInstance.quit().catch((error: any) => {
                    if (this.config.debug) {
                        log.debug('停止播放时出错:', error);
                    }
                });
            } catch (error) {
                if (this.config.debug) {
                    log.debug('停止播放异常:', error);
                }
            }

            // 手动触发退出事件
            this.handleExit(0);
        } else {
            // 如果实例已经不存在，也要清理播放列表文件和当前播放项 GUID
            this.cleanupPlaylistFile();
        }
    }

    /**
     * 检查是否正在播放
     */
    isPlaying(): boolean {
        return this.mpvInstance !== null && this.mpvInstance.isRunning();
    }

    /**
     * 统一控制入口（全局快捷键/远程控制转发）。
     * 基于 node-mpv-2 实例方法实现；部分方法(node-mpv-2 类型未完全声明)用 any 强转。
     */
    control(action: PlayerControlAction): boolean {
        const mpv = this.mpvInstance as any;
        if (!mpv || !mpv.isRunning()) {
            log.warn(`[control] MPV 未运行，忽略动作: ${action}`);
            return false;
        }
        try {
            switch (action) {
                case 'playpause':
                    mpv.togglePause();
                    return true;
                case 'play':
                    mpv.resume();
                    return true;
                case 'pause':
                    mpv.pause();
                    return true;
                case 'seek-back':
                    mpv.seek(-5, 'relative');
                    return true;
                case 'seek-fwd':
                    mpv.seek(5, 'relative');
                    return true;
                case 'speed-up':
                case 'speed-down': {
                    const cur = Number(mpv.getProperty('speed')) || 1;
                    let next = action === 'speed-up' ? cur + 0.1 : cur - 0.1;
                    next = Math.min(4, Math.max(0.25, Math.round(next * 100) / 100));
                    mpv.setProperty('speed', next);
                    log.info(`[control] 倍速 -> ${next}`);
                    return true;
                }
                case 'next':
                    if (typeof mpv.command === 'function') { mpv.command('playlist-next', []); return true; }
                    return false;
                case 'prev':
                    if (typeof mpv.command === 'function') { mpv.command('playlist-prev', []); return true; }
                    return false;
                case 'stop':
                    mpv.pause();
                    return true;
                default:
                    return false;
            }
        } catch (e: any) {
            log.warn(`[control] MPV 动作 ${action} 失败:`, e?.message || e);
            return false;
        }
    }
}

// 注册 MPV 播放器到工厂
PlayerFactory.registerPlayer(PlayerType.MPV, MpvPlayer);
