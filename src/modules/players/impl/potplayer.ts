import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import {
    BasePlayer,
    Config,
    PlayStatusData,
    PlayerType,
    EventType,
    PlayErrorData,
    PlayExitData,
    PlayItem
} from '../types';
import { PlayerFactory } from '../factory';
import { getDanmakuAss, normalizeDanmakuTitle } from '../../danmaku/biliDanmaku';
import { isSyncableItemType } from '../../fn_api/types';
import { mergeSubtitleWithDanmaku } from '../../danmaku/subtitleMerge';
import logger from '../../logger';
const log = logger.component('potplayer');

/**
 * PotPlayer 播放器
 * PotPlayer 没有可供 Node 直接操控的富 IPC，因此本实现：
 *   1) 通过命令行参数支持「续播跳转 /sub 外挂字幕」（见 launchEpisode）
 *   2) 通过随包分发的 Go 助手 `potctl.exe` 周期查询 PotPlayer 播放进度，
 *      并 emit PROGRESS 事件（由 media.ts 写回 fnOS 续播记录）——即「功能二：实时进度回传」
 *   3) 采用「逐集拉起」而非单一 m3u8 连播：每集独立带 /sub 字幕 + /seek 续播点，
 *      由 potctl 轮询检测到本集播完即自动拉起下一集——顺带解决「多集连播只有首集带字幕」的限制
 *
 * 播放链接本身就是本地代理 URL(http://127.0.0.1:22346/...)，token 已编入，故无需额外传 header。
 */
export class PotPlayer extends BasePlayer {
    private proc: ChildProcess | null = null;
    private playlistFilePath: string = '';   // 仅 legacy m3u8 模式使用
    private subtitleFilePaths: string[] = []; // 当前集临时字幕（可能多条，与 MPV 一致全挂）
    private currentItem: PlayItem | null = null;

    private playlist: PlayItem[] = [];        // 全部集数
    private currentIndex: number = 0;         // 当前集索引
    private lastArgs: string[] = [];          // 透传的额外启动参数（逐集复用以保持行为一致）

    private potctlPath: string | null = null; // potctl.exe 路径
    private pollerTimer: NodeJS.Timeout | null = null;
    private polling: boolean = false;         // 防止上一轮查询未结束时重复发起
    private pendingAdvance: boolean = false;   // 正在逐集推进（避免 onProcExit 误判为结束）
    private isSwitching: boolean = false;      // 正在切集(switchTo)（旧进程退出不触发 EXIT/刷新）
    private currentProgress: { ts: number; duration: number } = { ts: 0, duration: 0 };
    private active: boolean = false;           // 处于「播放中」意图态（与 this.proc 解耦，抗 /current 进程重启造成的轮询中断）
    private exited: boolean = false;           // EXIT 事件是否已发出（幂等，避免重复刷新 fnOS）
    private missCount: number = 0;             // 连续未找到 PotPlayer 窗口次数（用于判定真实关闭 vs 瞬时丢失）

    constructor(config: Config) {
        super(config);
    }

    /**
     * 播放媒体列表
     * - 若 potctl 助手可用：逐集拉起（每集独立字幕/续播 + 自动连播），并周期回传进度
     * - 若 potctl 缺失：回退旧的单一 m3u8 连播（仅首集带字幕，无实时进度）
     */
    async playList(infos: PlayItem[], pos: number, args?: string[]): Promise<boolean> {
        try {
            if (!this.config.playerPath) {
                throw new Error('PotPlayer 路径未配置');
            }
            if (infos.length === 0) {
                throw new Error('播放列表为空');
            }

            this.playlist = infos;
            this.lastArgs = args && args.length > 0 ? args : [];

            // 解析 potctl 助手路径（随包分发于 third_party/proxy/potctl.exe）
            this.potctlPath = this.getPotctlPath();
            if (!this.potctlPath) {
                log.warn('potctl 助手缺失，回退到 m3u8 连播（仅首集带字幕、无实时进度）');
                return this.playListLegacy(infos, pos, this.lastArgs);
            }

            return await this.launchEpisode(pos);
        } catch (error: any) {
            log.error('PotPlayer 初始化失败:', error);
            const errorEvent: PlayErrorData = { message: error.message || error.toString() };
            this.emitEvent(EventType.ERROR, errorEvent);
            return false;
        }
    }

    /**
     * 逐集拉起 PotPlayer
     */
    private async launchEpisode(index: number): Promise<boolean> {
        if (index < 0 || index >= this.playlist.length) {
            this.finalize();
            return false;
        }

        // 关键优化：先只带「视频 + 续播点」立即拉起 PotPlayer（零网络阻塞，秒开，与 MPV 一致），
        // 字幕/弹幕在 launchEpisode 之后异步获取并挂上（见 resolveSubtitleArg / attachSubtitle）。
        const launchArgs = this.buildBaseLaunchArgs(index);

        log.info(`[第${index + 1}/${this.playlist.length}集] 启动 PotPlayer: ${this.config.playerPath} ${launchArgs.join(' ')}`);

        const proc = spawn(this.config.playerPath, launchArgs, {
            detached: false,
            stdio: 'ignore',
            windowsHide: false
        });
        this.proc = proc;
        // 切集已完成新进程拉起，复位切换标志（避免后续旧进程 close 误判）
        this.isSwitching = false;
        // 标记播放意图态（与进程解耦，供轮询/isPlaying 判断，抗 /current 重启）
        this.active = true;
        this.exited = false;
        this.missCount = 0;

        proc.on('error', (err) => {
            log.error('PotPlayer 启动失败:', err);
            const errorEvent: PlayErrorData = { message: `PotPlayer 启动失败: ${err.message}` };
            this.emitEvent(EventType.ERROR, errorEvent);
            this.handleExit(1);
        });

        // 仅当该进程仍是当前跟踪进程时才处理关闭，
        // 避免切集/连播时旧进程退出误清空 this.proc 或误触发 EXIT
        proc.on('close', (code) => {
            if (this.proc === proc) {
                this.handleExit(code === null ? 0 : code);
            }
        });

        // 立即上报一次续播起点（让 fnOS 记录本集起始位置）
        this.emitProgress(Math.floor(this.currentProgress.ts), Math.floor(this.currentProgress.duration));

        // 启动进度轮询（仅启动一次）
        this.startPoller();

        // 异步挂幕：先开播、后挂字幕/弹幕，避免网络请求阻塞启动（与 MPV 同款）
        this.resolveSubtitleArg(index)
            .then((subArgs) => { if (subArgs.length > 0) this.attachSubtitle(subArgs); })
            .catch((e: any) => log.warn('PotPlayer 字幕异步挂载失败(已忽略):', e?.message || e));

        return true;
    }

    /**
     * 构建「基础」启动参数（仅视频 URL + 续播跳转 + 透传参数），同步、零网络。
     * 用于【先立即拉起 PotPlayer 开播】，字幕/弹幕随后异步挂载，避免网络请求阻塞启动（见 resolveSubtitleArg / attachSubtitle）。
     * 抽取自 launchEpisode，供「逐集拉起」与「原地切换(switchTo)」共用。
     */
    private buildBaseLaunchArgs(index: number): string[] {
        const item = this.playlist[index];
        this.currentIndex = index;
        this.currentItem = item;

        const launchArgs: string[] = [item.playLink];

        // 续播跳转：/seek=<秒>（与 MPV 同样兜底：即将到达片尾不跳转）
        const duration = item.duration || 0;
        if (item.ts > 0 && duration > 0 && item.ts <= 0.98 * duration) {
            launchArgs.push(`/seek=${Math.floor(item.ts)}`);
            this.currentProgress = { ts: Math.floor(item.ts), duration };
        } else {
            this.currentProgress = { ts: 0, duration };
        }

        // 透传调用方额外参数
        if (this.lastArgs.length > 0) {
            launchArgs.push(...this.lastArgs);
        }

        return launchArgs;
    }

    /**
     * 计算字幕挂载参数（-sub=...），并登记临时文件供退出时清理。
     * 抽出自 pushSubtitles，便于「先开播、后挂幕」的异步路径复用（返回 string[] 而非直接 push）。
     */
    private computeSubArgs(subPaths: string[], dmAss: string | null): string[] {
        if (subPaths.length > 0 && dmAss) {
            const merged = mergeSubtitleWithDanmaku(subPaths[0], dmAss);
            if (merged) {
                // 合并文件 + 翻译原文件都进清理列表；弹幕 ASS 走缓存不删
                this.subtitleFilePaths = [merged, ...subPaths];
                log.info('[PotPlayer] 字幕(合并轨·最稳): ' + merged);
                return [`-sub=${merged}`];
            }
            // 合并失败：退回「仅弹幕单轨」（保住弹幕，绝不退回需手动开双字幕的多轨）。
            this.subtitleFilePaths = subPaths;
            log.warn('[PotPlayer] 字幕(合并失败·退回仅弹幕单轨): ' + dmAss);
            return [`-sub=${dmAss}`];
        }
        if (subPaths.length > 0) {
            this.subtitleFilePaths = subPaths;
            const args = this.buildSubtitleArgs(subPaths);
            log.info('[PotPlayer] 字幕(仅翻译): ' + subPaths.join(' | '));
            return args;
        }
        if (dmAss) {
            log.info('[PotPlayer] 字幕(仅弹幕): ' + dmAss);
            return [`-sub=${dmAss}`];
        }
        return [];
    }

    /**
     * 异步解析字幕 + 弹幕，返回 -sub 参数数组（可能为空）。
     * 关键优化：与 MPV 同款——【先开播、后挂幕】，这里的所有网络请求都不阻塞 PotPlayer 启动。
     * 带 6s 超时保护：即便 B 站弹幕 API 卡住，也绝不拖延（视频已在播），超时则本轮不挂字幕。
     */
    private async resolveSubtitleArg(index: number): Promise<string[]> {
        const item = this.playlist[index];
        // 清理上一轮残留临时字幕，避免新旧集字幕叠加
        this.cleanupSubtitleFile();
        const subPaths: string[] = [];
        let dmAss: string | null = null;

        const subChain = (async () => {
            try {
                const fnapi = this.getFnApi();
                const subs = await fnapi.getSubtitle(item.itemGuid, this.getTitle(item));
                if (subs && subs.length > 0) {
                    log.info('[PotPlayer] 获取到字幕流:', subs.map(s => `${s.name || s.id}(${s.format})`).join(' | '));
                    const paths = await fnapi.downloadSubtitle(subs);
                    if (paths && paths.length > 0) subPaths.push(...paths);
                }
            } catch (subErr: any) {
                log.warn('PotPlayer 获取外挂字幕失败(已忽略):', subErr?.message || subErr);
            }
        })();

        const dmChain = (async () => {
            try {
                const dmTitle = normalizeDanmakuTitle(item.tvTitle || item.title);
                const dmEp = item.episodeNumber || 0;
                if (!isSyncableItemType(item.type)) {
                    log.info(`[PotPlayer] 媒体类型 "${item.type || 'null'}" 不在弹幕匹配范围(仅电影/电视节目/混合影片)，跳过弹幕`);
                    return;
                }
                log.info(`[PotPlayer] === 弹幕 ASS 获取开始 ===`);
                log.info(`[PotPlayer] dmTitle="${dmTitle}", dmEp=${dmEp}, tvTitle="${item.tvTitle}", title="${item.title}"`);
                if (dmTitle) {
                    dmAss = await getDanmakuAss(dmTitle, dmEp);
                    log.info(`[PotPlayer] getDanmakuAss 返回: ${dmAss || 'null'}`);
                } else {
                    log.warn('[PotPlayer] ⚠️ dmTitle 为空，跳过弹幕');
                }
            } catch (dmErr: any) {
                log.warn('PotPlayer 弹幕 ASS 获取异常(已忽略):', dmErr?.message || dmErr);
            }
        })();

        // 6s 超时保护：字幕/弹幕未就绪也不阻塞（视频已在播），超时则本轮不挂字幕
        const guard = new Promise<void>((resolve) => setTimeout(resolve, 6000));
        await Promise.race([Promise.all([subChain, dmChain]), guard]);

        return this.computeSubArgs(subPaths, dmAss);
    }

    /**
     * 字幕就绪后，把字幕挂到【正在播放】的 PotPlayer 上。
     * 做法：用 /current 在当前窗口内重载同一文件并带上 -sub=（与 switchTo 同机制）。
     * 为避免重载后回到片头，先查实时进度再 /seek 回当前位置。
     */
    private async attachSubtitle(subArgs: string[]): Promise<void> {
        if (!this.config.playerPath || !this.currentItem || subArgs.length === 0 || !this.active) return;

        // 切集/重载窗口期内屏蔽原进程 EXIT 事件（与 switchTo 同机制）
        this.isSwitching = true;

        const livePos = await this.getLivePosition();
        const base = this.buildBaseLaunchArgs(this.currentIndex); // 视频 + 续播点/时长
        // 用实时位置覆盖续播点，避免重载后回退
        const args = base.filter(a => !a.startsWith('/seek='));
        args.push(`/seek=${Math.floor(livePos)}`);
        args.push(...subArgs, '/current');

        log.info(`[attachSubtitle] 重载并挂载字幕: ${this.config.playerPath} ${args.join(' ')}`);
        const fwd = spawn(this.config.playerPath, args, {
            detached: false,
            stdio: 'ignore',
            windowsHide: false
        });
        fwd.on('error', (err) => {
            log.warn('[attachSubtitle] 转发进程异常(忽略):', err.message);
        });
        fwd.unref?.();

        setTimeout(() => { this.isSwitching = false; }, 2500);
    }

    /**
     * 查询 PotPlayer 当前播放位置（秒），失败回退到上次已知进度。
     * 用于 attachSubtitle 重载字幕时把进度 seek 回当前位置，避免回退到片头。
     */
    private getLivePosition(): Promise<number> {
        const potctl = this.potctlPath;
        if (!potctl) return Promise.resolve(this.currentProgress.ts);
        return new Promise<number>((resolve) => {
            try {
                const proc = spawn(potctl, ['info'], {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true
                });
                let out = '';
                proc.stdout?.on('data', (d: any) => { out += d.toString(); });
                proc.on('close', () => {
                    try {
                        const info = JSON.parse(out.trim());
                        resolve(info.found ? Math.floor((Number(info.position) || 0) / 1000) : this.currentProgress.ts);
                    } catch {
                        resolve(this.currentProgress.ts);
                    }
                });
            } catch {
                resolve(this.currentProgress.ts);
            }
        });
    }

    /**
     * 切集（点哪个播哪个）：在【已运行的 PotPlayer 窗口】内直接切到新内容，不关闭/重建窗口。
     *
     * 采用 PotPlayer 官方 /current 开关：把新文件转发给现有实例播放，
     * 现有窗口直接切换、不重新加载、不重新拉起页面——这正是用户要的「按需加载」：
     * 不会像「停止+重建」那样关闭再重开导致整段视频从头重新缓冲一遍。
     *
     * 进度回传为何仍可靠（相比旧版 /current 实现）：
     *   旧版 /current 实现里，this.proc 始终指向【原进程】，而 PotPlayer 收到 /current
     *   在部分情况下会【内部重启自身进程】套用新命令行参数 → 原进程被 kill →
     *   pollOnce 守卫 if(this.proc.killed) return 永久停掉轮询 → 切集后进度再也不回传。
     *   本版把轮询与 this.proc 解耦：轮询只依赖【窗口是否存在(potctl info.found)】+
     *   我们自己的 active 意图标志，进程重启也不影响轮询；原进程退出期间用 isSwitching
     *   守卫屏蔽其 EXIT 事件（不刷新 fnOS 页面），重启完成后新窗口照常被 potctl 找到并回传进度。
     *
     * 上层契约：switchTo 返回 true 时，currentPlayer 仍为同一实例，事件处理器(进度写回)保持连接。
     */
    async switchTo(infos: PlayItem[], index: number): Promise<boolean> {
        if (index < 0 || index >= infos.length) {
            log.warn('[switchTo] 索引越界');
            return false;
        }

        // 1) 切走前先把当前(A)进度回传 fnOS，避免丢失
        if (this.currentItem && this.currentProgress.duration > 0) {
            this.emitProgress(this.currentProgress.ts, this.currentProgress.duration);
        }

        // 2) 标记切换中：旧进程若在切换窗口期内退出（/current 重启），屏蔽其 EXIT 事件
        this.isSwitching = true;

        // 3) 用新播放列表(A 被 B 取代)构建 B 的基础启动参数（仅视频+续播点，零网络阻塞）
        this.playlist = infos;
        const launchArgs = this.buildBaseLaunchArgs(index);

        // 立即上报 B 的续播起点（让 fnOS 记录本集起始位置）
        this.emitProgress(this.currentProgress.ts, this.currentProgress.duration);

        // 关键：/current 让 PotPlayer 在【现有窗口】内播放 B（替换 A 的播放），先无字幕秒切，字幕随后异步挂上
        launchArgs.push('/current');

        log.info(`[switchTo] 复用现有 PotPlayer 窗口切换到: ${this.config.playerPath} ${launchArgs.join(' ')}`);

        // 转发进程：把 B 交给现有实例后自行退出；不覆盖 this.proc（仍指向原运行实例，仅留作 kill 句柄）
        const fwd = spawn(this.config.playerPath, launchArgs, {
            detached: false,
            stdio: 'ignore',
            windowsHide: false
        });
        fwd.on('error', (err) => {
            log.warn('[switchTo] 转发进程异常(忽略):', err.message);
        });
        fwd.unref?.();

        // 4) 确保进度轮询持续运行（复用同一窗口，potctl 仍按窗口类查找，进度照常回传）
        this.startPoller();

        // 5) 切集窗口期结束（无论是否发生进程重启），复位 isSwitching，恢复真实关闭判定
        setTimeout(() => { this.isSwitching = false; }, 2500);

        // 异步挂幕到新集：先秒切、后挂字幕/弹幕（与 launchEpisode 同机制，避免阻塞切集）
        this.resolveSubtitleArg(index)
            .then((subArgs) => { if (subArgs.length > 0) this.attachSubtitle(subArgs); })
            .catch((e: any) => log.warn('[switchTo] 字幕异步挂载失败(已忽略):', e?.message || e));

        log.info(`✅ 已切换到新内容（复用窗口 /current，未重新加载视频）`);
        return true;
    }

    /**
     * 启动进度轮询：周期调用 potctl 查询 PotPlayer 位置/时长，回传进度并检测本集结束自动连播
     */
    private startPoller(): void {
        if (this.pollerTimer) return;
        this.pollerTimer = setInterval(() => {
            this.pollOnce();
        }, 5000);
    }

    private stopPoller(): void {
        if (this.pollerTimer) {
            clearInterval(this.pollerTimer);
            this.pollerTimer = null;
        }
    }

    /**
     * 单次轮询：查询 PotPlayer 当前进度，emit PROGRESS，并检测本集结束
     */
    private pollOnce(): void {
        // 轮询只依赖「播放意图态 + potctl 可用」，与 this.proc 是否存活解耦，
        // 从而 /current 切换导致进程重启时轮询不中断，进度持续回传。
        if (!this.active || !this.potctlPath || this.pendingAdvance) return;
        if (this.polling) return;
        this.polling = true;

        try {
            const proc = spawn(this.potctlPath, ['info'], {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true
            });
            let out = '';
            proc.stdout?.on('data', (d) => { out += d.toString(); });
            proc.on('close', () => {
                this.polling = false;
                try {
                    const info = JSON.parse(out.trim());
                    if (!this.currentItem) return;
                    // 窗口连续两次未找到 → 判定用户已关闭 PotPlayer，结束播放
                    // （单次未找到可能是切换/瞬时丢失，需连续确认，避免误判关闭）
                    if (!info.found) {
                        this.missCount++;
                        if (this.missCount >= 2) {
                            log.info('[poll] PotPlayer 窗口已关闭（连续未找到），结束播放');
                            this.handleExit(0);
                        }
                        return;
                    }
                    this.missCount = 0;

                    const posMs = Number(info.position) || 0;
                    const durMs = Number(info.duration) || 0;
                    const state = Number(info.state);
                    const posSec = Math.floor(posMs / 1000);
                    const durSec = Math.floor(durMs / 1000);

                    if (durSec <= 0) return;

                    this.currentProgress = { ts: posSec, duration: durSec };
                    this.emitProgress(posSec, durSec);

                    // 本集结束判定：位置接近片尾，或 PotPlayer 已停止(播完停在片尾)且已播放过一段时间
                    // PotPlayer 状态语义：-1=停止 1=暂停 2=播放中（注意 state===2 是「播放中」而非停止）
                    const nearEnd = posSec >= durSec - 4;
                    const stoppedAtEnd = state === -1 && posSec > 10;
                    if (nearEnd || stoppedAtEnd) {
                        this.advanceEpisode();
                    }
                } catch (_) {
                    // 解析失败（potctl 输出异常）忽略本轮
                }
            });
        } catch (_) {
            this.polling = false;
        }
    }

    /**
     * 上报进度（emit PROGRESS，由 media.ts 写回 fnOS 续播记录）
     */
    private emitProgress(ts: number, duration: number): void {
        if (!this.currentItem) return;
        const percentage = duration > 0 ? Math.floor((ts / duration) * 100) : 0;
        const progressData: PlayStatusData = {
            ...this.getStatus(),
            itemGuid: this.currentItem.itemGuid,
            ts,
            duration,
            percentage
        };
        this.updateGlobalStatus(progressData);
        this.emitEvent(EventType.PROGRESS, progressData);
    }

    /**
     * 自动连播下一集（逐集各自带字幕 + 续播点）
     */
    private advanceEpisode(): void {
        const next = this.currentIndex + 1;
        if (next >= this.playlist.length) {
            // 已是最后一集：上报 100% 并结束
            if (this.currentProgress.duration > 0) {
                this.emitProgress(this.currentProgress.duration, this.currentProgress.duration);
            }
            this.finalize();
            return;
        }

        log.info(`本集播放结束，自动连播第 ${next + 1} 集`);
        // 先上报本集完整进度
        if (this.currentProgress.duration > 0) {
            this.emitProgress(this.currentProgress.duration, this.currentProgress.duration);
        }
        this.pendingAdvance = true;
        if (this.proc) {
            try { this.proc.kill(); } catch (_) { /* ignore */ }
        }
        // onProcExit 收到 close 后会因 pendingAdvance 重置并返回，不误判为结束
        this.launchEpisode(next);
    }

    /**
     * 处理退出事件
     */
    private handleExit(code: number): void {
        // 幂等：EXIT 已发出则忽略后续重复触发（进程重启/多次 close）
        if (this.exited) return;

        // 逐集推进导致的退出：仅重置标志，不当作播放结束
        if (this.pendingAdvance) {
            this.pendingAdvance = false;
            this.proc = null;
            return;
        }

        // 切集(switchTo)导致的旧进程退出：仅清引用，不当作播放结束、不刷新 fnOS 页面
        if (this.isSwitching) {
            this.proc = null;
            this.isSwitching = false;
            return;
        }

        this.exited = true;
        this.active = false;
        this.missCount = 0;
        this.stopPoller();

        // 上报最终进度（若轮询已拿到过位置）
        if (this.currentItem && this.currentProgress.duration > 0) {
            this.emitProgress(this.currentProgress.ts, this.currentProgress.duration);
        }

        this.cleanupPlaylistFile();
        this.cleanupSubtitleFile();

        const event: PlayExitData = { code, status: this.getStatus() };
        this.emitEvent(EventType.EXIT, event);
        this.proc = null;
    }

    /**
     * 播放完全结束（最后一集播完）
     */
    private finalize(): void {
        if (this.exited) return;
        this.exited = true;
        this.active = false;
        this.missCount = 0;
        this.stopPoller();
        this.cleanupPlaylistFile();
        this.cleanupSubtitleFile();
        if (this.currentItem && this.currentProgress.duration > 0) {
            this.emitProgress(this.currentProgress.duration, this.currentProgress.duration);
        }
        const event: PlayExitData = { code: 0, status: this.getStatus() };
        this.emitEvent(EventType.EXIT, event);
        this.proc = null;
    }

    /**
     * 清理临时字幕文件（可能多条）
     */
    private cleanupSubtitleFile(): void {
        for (const f of this.subtitleFilePaths) {
            if (f && fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
            }
        }
        this.subtitleFilePaths = [];
    }

    /**
     * 清理 m3u8 播放列表文件（legacy 模式）
     */
    private cleanupPlaylistFile(): void {
        if (this.playlistFilePath && fs.existsSync(this.playlistFilePath)) {
            try { fs.unlinkSync(this.playlistFilePath); } catch (_) { /* ignore */ }
        }
        this.playlistFilePath = '';
    }

    /**
     * 停止播放
     */
    stop(): void {
        this.active = false;
        this.missCount = 0;
        this.stopPoller();
        if (this.proc) {
            try { this.proc.kill(); } catch (_) { /* ignore */ }
            this.handleExit(0);
        } else {
            this.cleanupPlaylistFile();
            this.cleanupSubtitleFile();
        }
    }

    /**
     * 检查是否正在播放
     */
    isPlaying(): boolean {
        // 与进程解耦：只要仍处于播放意图态即视为在播（抗 /current 进程重启造成的 this.proc.killed）
        return this.active;
    }

    /**
     * 解析 potctl.exe 路径。
     * 打包后位于 exe 同级目录 third_party/proxy/potctl.exe（由 extraFiles 复制）。
     * 同时兜底 resources / app 路径，兼容不同运行形态。
     */
    private getPotctlPath(): string | null {
        const candidates: string[] = [];
        try {
            candidates.push(path.join(path.dirname(app.getPath('exe')), 'third_party', 'proxy', 'potctl.exe'));
        } catch (_) { /* ignore */ }
        candidates.push(path.join(process.resourcesPath || '', 'third_party', 'proxy', 'potctl.exe'));
        candidates.push(path.join(app.getAppPath(), 'third_party', 'proxy', 'potctl.exe'));
        for (const c of candidates) {
            if (c && fs.existsSync(c)) return c;
        }
        return null;
    }

    /**
     * 生成 M3U8 播放列表内容（legacy 回退模式）
     */
    private generateM3U8Playlist(infos: PlayItem[]): string {
        let content = '#EXTM3U\n';
        for (const item of infos) {
            const duration = item.duration || -1;
            const title = this.getTitle(item);
            content += `#EXTINF:${duration},${title}\n`;
            content += `${item.playLink}\n`;
        }
        return content;
    }

    /**
     * legacy 回退：单一 m3u8 连播（potctl 缺失时使用，仅首集带字幕）
     */
    private async playListLegacy(infos: PlayItem[], pos: number, args: string[]): Promise<boolean> {
        const startItem = infos[pos] || infos[0];
        this.currentItem = startItem;

        const playlistContent = this.generateM3U8Playlist(infos);
        this.playlistFilePath = path.join(os.tmpdir(), `potplayer_playlist_${Date.now()}.m3u8`);
        await fs.promises.writeFile(this.playlistFilePath, playlistContent, 'utf-8');

        const launchArgs: string[] = [this.playlistFilePath];

        const duration = startItem.duration || 0;
        if (startItem.ts > 0 && duration > 0 && startItem.ts <= 0.98 * duration) {
            launchArgs.push(`/seek=${Math.floor(startItem.ts)}`);
        }

        const subPaths: string[] = [];
        try {
            const fnapi = this.getFnApi();
            const subs = await fnapi.getSubtitle(startItem.itemGuid, this.getTitle(startItem));
            if (subs && subs.length > 0) {
                log.info('[PotPlayer] 获取到字幕流:', subs.map(s => `${s.name || s.id}(${s.format})`).join(' | '));
                const paths = await fnapi.downloadSubtitle(subs);
                if (paths && paths.length > 0) subPaths.push(...paths);
            }
        } catch (subErr: any) {
            log.warn('PotPlayer 获取外挂字幕失败(已忽略):', subErr?.message || subErr);
        }

        // B站弹幕（legacy 兜底模式同样走合并轨方案，与逐集模式一致）
        let dmAss: string | null = null;
        try {
            const dmTitle = startItem.tvTitle || startItem.title;
            const dmEp = startItem.episodeNumber || 0;
            if (!isSyncableItemType(startItem.type)) {
                log.info(`[PotPlayer][legacy] 媒体类型 "${startItem.type || 'null'}" 不在弹幕匹配范围(仅电影/电视节目/混合影片)，跳过弹幕`);
            } else {
                log.info(`[PotPlayer][legacy] === 弹幕 ASS 获取开始 ===`);
                log.info(`[PotPlayer][legacy] dmTitle="${dmTitle}", dmEp=${dmEp}, tvTitle="${startItem.tvTitle}", title="${startItem.title}"`);
                if (dmTitle) {
                    dmAss = await getDanmakuAss(dmTitle, dmEp);
                    log.info(`[PotPlayer][legacy] getDanmakuAss 返回: ${dmAss || 'null'}`);
                } else {
                    log.warn('[PotPlayer][legacy] ⚠️ dmTitle 为空，跳过弹幕');
                }
            }
        } catch (dmErr: any) {
            log.warn('PotPlayer[legacy] 弹幕 ASS 获取异常(已忽略):', dmErr?.message || dmErr);
        }

        // 字幕（翻译 + 弹幕）挂载：同逐集模式，合并优先（见 launchEpisode 注释）
        this.pushSubtitles(launchArgs, subPaths, dmAss);

        if (args && args.length > 0) {
            launchArgs.push(...args);
        }

        log.info(`启动 PotPlayer(legacy m3u8): ${this.config.playerPath} ${launchArgs.join(' ')}`);

        this.proc = spawn(this.config.playerPath, launchArgs, {
            detached: false,
            stdio: 'ignore',
            windowsHide: false
        });

        this.proc.on('error', (err) => {
            log.error('PotPlayer 启动失败:', err);
            const errorEvent: PlayErrorData = { message: `PotPlayer 启动失败: ${err.message}` };
            this.emitEvent(EventType.ERROR, errorEvent);
            this.handleExit(1);
        });

        this.proc.on('close', (code) => {
            this.handleExit(code === null ? 0 : code);
        });

        this.active = true;
        this.exited = false;
        this.missCount = 0;

        const st = this.getStatus();
        st.itemGuid = this.currentItem.itemGuid;
        st.ts = this.currentItem.ts;
        st.duration = this.currentItem.duration;
        st.percentage = this.currentItem.duration > 0
            ? Math.floor((this.currentItem.ts / this.currentItem.duration) * 100)
            : 0;
        this.updateGlobalStatus(st);

        return true;
    }

    /**
     * 把翻译字幕 + 弹幕 ASS 挂到 PotPlayer 启动参数。
     * 优先【合并成同一个 ASS 轨道】用单个 -sub 加载（最稳，不依赖 PotPlayer 双字幕开关）；
     * 合并失败则退回【重复 -sub=】多轨道加载（此时弹幕需 PotPlayer 手动开次字幕输出）。
     * @param launchArgs 启动参数数组（直接 push）
     * @param subPaths   已下载的翻译字幕路径数组
     * @param dmAss      弹幕 ASS 路径（可能为 null）
     */
    private pushSubtitles(launchArgs: string[], subPaths: string[], dmAss: string | null): void {
        const args = this.computeSubArgs(subPaths, dmAss);
        if (args.length > 0) launchArgs.push(...args);
    }

    /**
     * 生成 PotPlayer 多字幕命令行参数（本地字幕文件，含翻译字幕与弹幕 ASS）。
     * PotPlayer 多字幕语法 =【重复 -sub=】（每多一个字幕文件就再给一个 -sub=），
     * 所有文件被加载为各自独立的字幕轨道，再由 PotPlayer 原生「双字幕 / 次字幕输出」同时显示。
     *
     * 关键①：【千万不要手动给路径加引号】！Node 在 Windows 上 spawn 时，会把参数内的 `"` 转义成 `\"`，
     * 导致 PotPlayer 实际收到的路径变成 `-sub=\"C:\...\file.ass\"`（引号成了路径里的字面字符），
     * 从而打不开字幕文件。正确做法：只写 `-sub=<path>`，让 Node 在路径确实含空格时自动加最外层引号。
     * 关键②：PotPlayer 字幕参数官方前缀是【横杠 `-sub=`】，不是斜杠 `/sub=`（斜杠常被静默忽略）；
     *         且【PotPlayer 根本没有 /sub2 参数】，之前用 -sub2= 会被直接忽略，弹幕轨根本不加载。
     *
     * @param subPaths 全部字幕文件路径（翻译字幕在前、弹幕 ASS 在后）
     * @returns 如 ['-sub=C:\\a.vtt', '-sub=D:\\b.ass']
     */
    private buildSubtitleArgs(subPaths: string[]): string[] {
        return subPaths.map((sp) => `-sub=${sp}`);
    }

    /**
     * 获取视频标题
     */
    private getTitle(info: PlayItem): string {
        let title = info.title || '';
        if (info.tvTitle) {
            title = `${info.tvTitle || 'noTVTitle'} - S${info.seasonNumber || '0'}E${info.episodeNumber || '0'}: ${info.title || 'noTitle'}`;
        }
        return title;
    }
}

// 注册 PotPlayer 播放器到工厂
PlayerFactory.registerPlayer(PlayerType.POTPLAYER, PotPlayer);
