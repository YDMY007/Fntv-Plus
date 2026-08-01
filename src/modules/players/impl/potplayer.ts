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
    PlayItem,
    PlayerControlAction
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
    private resumeTarget: number = 0;          // [续播] 启动续播目标秒数
    private resumePending: boolean = false;     // [续播] 等待 PotPlayer 真正跳到 resumeTarget 前，抑制进度回写(避免把真实进度覆盖成 0~12s)
    private resumeStartedAt: number = 0;        // [续播] resumePending 起始时间(超时兜底清除)
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

            // 重排播放列表：把用户点击的那一集(pos)循环移到索引 0，
            // 使 PotPlayer 从正确集开始播，且 this.playlist 顺序与 PotPlayer 内部列表、
            // 应用层自动连播(advanceEpisode 用 currentIndex+1)三者完全统一。
            // 仅首次拉起时重排一次；切集/自动连播(launchEpisode/switchTo)不再重排，避免二次错位。
            let startPos = pos;
            if (pos > 0 && pos < infos.length) {
                const reordered = infos.slice(pos).concat(infos.slice(0, pos));
                this.playlist = reordered;
                infos = reordered;   // legacy 路径也用重排后列表
                startPos = 0;        // 重排后目标集在索引 0
                log.info(`[playList] 重排播放列表: 目标集原索引=${pos}, 重排后首位 guid=${reordered[0]?.itemGuid}, 总集数=${reordered.length}`);
            } else {
                log.info(`[playList] 未重排(目标集已是首集或索引越界): pos=${pos}, 首位 guid=${infos[0]?.itemGuid}`);
            }

            // 解析 potctl 助手路径（随包分发于 third_party/proxy/potctl.exe）
            this.potctlPath = this.getPotctlPath();
            if (!this.potctlPath) {
                log.warn('potctl 助手缺失，回退到 m3u8 连播（仅首集带字幕、无实时进度）');
                return this.playListLegacy(infos, startPos, this.lastArgs);
            }

            return await this.launchEpisode(startPos, true);
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
    private async launchEpisode(index: number, fresh: boolean = false): Promise<boolean> {
        if (index < 0 || index >= this.playlist.length) {
            this.finalize();
            return false;
        }

        // [续播/起播修复] 全新起播(fresh=true, 由 playList 调用)时，若系统已有残留 PotPlayer 窗口
        // (PotPlayer 单实例会把新启动参数当作"追加"而非"替换"，从而仍停在旧的第1集)，
        // 先关闭残留并等待退出，再干净启动 —— 确保从目标集开始。
        // 自动连播(advanceEpisode)传 fresh=false，复用当前正在播的 PotPlayer 实例，不关闭。
        if (fresh) {
            const wasRunning = await this.closeStrayPotPlayer();
            log.info(`[launchEpisode] fresh 起播，启动前已有 PotPlayer 残留=${wasRunning}`);
        }

        // 生成 m3u8 播放列表文件（含全部集、可读标题、原始 proxy URL —— 不经 shim，启动快）
        const launchArgs = this.buildFullPlaylistLaunchArgs(index);

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

        // [续播修复] PotPlayer 运行后无法用 CLI(/Current /seek) 动态 seek(官方命令行仅支持启动时 /seek)，
        // 故续播改由【启动时 /seek=ts】完成(buildFullPlaylistLaunchArgs 已写入启动参数)，
        // 此处仅标记 resumePending 以在 PotPlayer 真正跳到目标点前抑制进度回写(防止覆盖真实续播点)。
        if (fresh) {
            const item = this.playlist[index];
            const dur = item.duration || 0;
            if (item.ts > 0 && dur > 0 && item.ts <= 0.98 * dur) {
                this.resumeTarget = Math.floor(item.ts);
                this.resumePending = true;
                this.resumeStartedAt = Date.now();
                log.info(`[launchEpisode] 安排启动续播: ts=${this.resumeTarget}s`);
            } else {
                this.resumePending = false;
                this.resumeTarget = 0;
                log.info(`[launchEpisode] 无需续播跳转: ts=${item.ts}, dur=${dur}`);
            }
        } else {
            this.resumePending = false;
            this.resumeTarget = 0;
        }

        return true;
    }

    /**
     * 检测当前是否有 PotPlayer 进程在运行。
     * 主检测：系统进程列表（tasklist / pgrep），可靠且不依赖 potctl 的窗口探测。
     * 辅检测：potctl info.found（potctl 存在时才用）。
     * 用于全新起播前判断是否存在"残留单实例"，避免新启动参数被当作追加。
     */
    private async isPotPlayerRunning(): Promise<boolean> {
        // 1) 系统进程列表检测（最可靠，跨 potctl 能否探测到窗口）
        if (await this.isPotPlayerRunningByTasklist()) return true;
        // 2) potctl 辅助检测（仅当 potctl 可用）
        if (!this.potctlPath) return false;
        try {
            const out = await new Promise<string>((resolve) => {
                const proc = spawn(this.potctlPath!, ['info'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                let s = '';
                proc.stdout?.on('data', (d: any) => { s += d.toString(); });
                proc.on('close', () => resolve(s));
            });
            const info = JSON.parse(out.trim());
            return !!info.found;
        } catch {
            return false;
        }
    }

    /**
     * 基于系统进程列表检测 PotPlayer 是否在运行（不依赖 potctl 窗口探测）。
     * Windows 用 tasklist；其它平台用 pgrep。
     */
    private isPotPlayerRunningByTasklist(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const exeName = this.config.playerPath ? path.basename(this.config.playerPath) : '';
            if (!exeName) { resolve(false); return; }
            try {
                if (process.platform === 'win32') {
                    const proc = spawn('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                    let s = '';
                    proc.stdout?.on('data', (d: any) => { s += d.toString(); });
                    proc.on('close', () => { resolve(s.toUpperCase().includes(exeName.toUpperCase())); });
                    proc.on('error', () => resolve(false));
                } else {
                    const proc = spawn('pgrep', ['-f', exeName], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                    let s = '';
                    proc.stdout?.on('data', (d: any) => { s += d.toString(); });
                    proc.on('close', () => { resolve(s.trim().length > 0); });
                    proc.on('error', () => resolve(false));
                }
            } catch {
                resolve(false);
            }
        });
    }

    /**
     * 关闭系统中残留的 PotPlayer 窗口并等待其退出（最多 ~0.8s）。
     * 仅用于全新起播(fresh)前，确保 PotPlayer 单实例从目标集干净启动。
     * 返回启动前是否检测到已有 PotPlayer 在运行。
     *
     * 关键坑：PotPlayer 单实例，若残留窗口未清，新启动参数会被当成"追加"而非"替换"，从而仍停在旧的第1集
     * （用户反复报"选第4集却播第1集"的根因）。PotPlayer 没有可靠的「/close」CLI 命令
     * （/Current /close 常被静默忽略，且 /Current 会把最小化窗口拉到前台造成弹窗），
     * 故这里【直接按进程名强制结束】，不尝试 /close，干净退出后再启动新实例。
     *
     * [lc-256 速度优化] 等待间隔从 200ms 缩减到 100ms、循环次数减半（原 6+10=16 次→3+5=8 次），
     * 最坏等待从 3.2s 降到 0.8s。PotPlayer 被 taskkill /F 后通常在 100~300ms 内退出，
     * 原来每次等 200ms 过于保守；即使偶发未退尽，新 PotPlayer 单实例启动也会接管。
     */
    private async closeStrayPotPlayer(): Promise<boolean> {
        if (!this.config.playerPath) return false;
        // 检测到残留：potctl 能看到窗口，或我们自己上次拉起的进程仍存活（/current 重启后 potctl 可能短暂滞后）
        const running = (await this.isPotPlayerRunning()) || (this.proc != null && !this.proc.killed);
        if (!running) return false;

        // 1) 优先结束我们自己上次拉起的进程（精准，不误伤用户其它 PotPlayer）
        if (this.proc && !this.proc.killed) {
            try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
        }

        // 2) 轮询等待退出（最多 ~300ms，原 1.2s）
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (!(await this.isPotPlayerRunning())) {
                log.info('[closeStrayPotPlayer] 已关闭残留 PotPlayer');
                return true;
            }
        }

        // 3) 仍残留 → 按进程名强制结束（PotPlayer 单实例必须干净退出，否则新参数被当"追加"仍播旧集）
        const exeName = path.basename(this.config.playerPath);
        log.warn(`[closeStrayPotPlayer] 常规关闭无效，强制结束进程: ${exeName}`);
        this.forceKillPotPlayer(exeName);

        // 4) 再轮询确认已退出（最多 ~500ms，原 2s）
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (!(await this.isPotPlayerRunning())) return true;
        }
        log.warn('[closeStrayPotPlayer] 强制结束后仍检测到 PotPlayer（可能权限不足或被快速重启），继续启动新实例');
        return true;
    }

    /**
     * 按可执行文件名强制结束进程（跨平台兜底）。Windows 用 taskkill，其他平台用 pkill。
     * 用于 closeStrayPotPlayer 温和关闭失败时，确保 PotPlayer 单实例被干净终止。
     */
    private forceKillPotPlayer(exeName: string): void {
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/IM', exeName, '/F'], { stdio: 'ignore', windowsHide: true });
            } else {
                spawn('pkill', ['-f', exeName], { stdio: 'ignore', windowsHide: true });
            }
        } catch (e: any) {
            log.warn('[forceKillPotPlayer] 失败:', e?.message || e);
        }
    }

    /**
     * 构建「基础」启动参数（仅视频 URL + 续播跳转 + 透传参数），同步、零网络。
     * 用于【先立即拉起 PotPlayer 开播】，字幕/弹幕随后异步挂载，避免网络请求阻塞启动（见 resolveSubtitleArg / attachSubtitle）。
     * 抽取自 launchEpisode，供「逐集拉起」与「原地切换(switchTo)」共用。
     */
    /**
     * 把秒数格式化为 PotPlayer /seek 需要的 HH:MM:SS。
     * PotPlayer 官方语法为 /seek=hh:mm:ss.ms，部分版本不识别纯秒数，故统一转换。
     */
    private formatSeekTime(seconds: number): string {
        const s = Math.max(0, Math.floor(seconds));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    }

    private buildBaseLaunchArgs(index: number): string[] {
        const item = this.playlist[index];
        this.currentIndex = index;
        this.currentItem = item;

        // 直接用 proxy 原始 URL（不经 shim 代理层，避免额外 HTTP 转发导致卡顿）
        const launchArgs: string[] = [item.playLink];

        // 续播跳转：/seek=<秒>（与 MPV 同样兜底：即将到达片尾不跳转）
        const duration = item.duration || 0;
        if (item.ts > 0 && duration > 0 && item.ts <= 0.98 * duration) {
            launchArgs.push(`/seek=${this.formatSeekTime(item.ts)}`);
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
     * 构建「完整播放列表」启动参数：生成临时 .m3u8 播放列表文件（含可读标题 + 极速标签），
     * 作为【单一启动参数】传给 PotPlayer。
     *
     * 为什么用 m3u8（而不是多文件命令行参数）：
     *   - 多文件参数 + shim 代理层 → 每个视频多一次 HTTP 转发握手，PotPlayer 启动时预扫描所有文件
     *     元数据导致严重卡顿(lc-253 用户实测"即将播放..."卡死)
     *   - 多文件参数（即使不用 shim）→ PotPlayer 把首个 URL 额外计入一次 → 列表重复(lc-249/250/251 反复验证)
     *   - m3u8 是单一文件参数 → PotPlayer 解析后列表项 = 文件内 #EXTINF 条目数，精确等于集数，
     *     物理上不可能重复，且启动快（只打开 1 个文件）
     *
     * 播放列表显示：#EXTINF 标题 = 可读剧名「剧名 - S01E04: 集标题 [极速]」。
     * 续播：#EXT-X-START 标签(目标集已重排到 m3u8 首项，TIME-OFFSET=ts 即落在目标集内)。
     *   注：命令行 /seek 对 m3u8 文件无效(lc-247)；EXT-X-START 是 HLS 标准标签，PotPlayer 可能尊重也可能不尊重。
     *   若 EXT-X-START 不生效，续播会从头开始——这是 PotPlayer 对 m3u8 的限制，非代码 bug。
     *
     * 仅用于 launchEpisode（首次拉起）；switchTo 仍用 buildBaseLaunchArgs + /current。
     */
    private buildFullPlaylistLaunchArgs(index: number): string[] {
        const item = this.playlist[index];
        this.currentIndex = index;
        this.currentItem = item;

        // 续播偏移：目标集已重排到 this.playlist[0](playList 入口重排)，m3u8 首项即目标集
        const duration = item.duration || 0;
        const resumeTs = (item.ts > 0 && duration > 0 && item.ts <= 0.98 * duration) ? Math.floor(item.ts) : 0;
        this.currentProgress = { ts: resumeTs, duration };

        // 生成 .m3u8 播放列表文件（含全部集、可读标题、续播偏移、原始 proxy URL —— 不经 shim，直接连 proxy）
        const content = this.generateM3U8Playlist(this.playlist, resumeTs);
        this.playlistFilePath = path.join(os.tmpdir(), `potplayer_playlist_${Date.now()}.m3u8`);
        fs.writeFileSync(this.playlistFilePath, content, 'utf-8');
        log.info(`[playlist] 生成 m3u8(${this.playlist.length} 集, 续播=${resumeTs}s): ${this.playlistFilePath}`);

        // 仅传 m3u8 文件路径（单一参数，启动快、无重复）
        const launchArgs: string[] = [this.playlistFilePath];

        // 透传调用方额外参数
        if (this.lastArgs.length > 0) {
            launchArgs.push(...this.lastArgs);
        }

        return launchArgs;
    }

    /**
     * 计算字幕挂载参数（-sub=...），并登记临时文件供退出时清理。
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

                    // [续播] PotPlayer 真正跳到续播目标点之前，抑制进度回写：
                    // 否则起播瞬间(0~十余秒)会把 fnOS「继续观看」里用户真实的续播进度覆盖成小值，
                    // 造成"越看越靠前 / 进度存取错乱"。
                    if (this.resumePending) {
                        const elapsed = Date.now() - this.resumeStartedAt;
                        if (posSec >= this.resumeTarget - 8) {
                            // 已到达续播点：解除抑制，恢复正常回写
                            this.resumePending = false;
                            log.info(`[poll] 续播到位: potctl 位置=${posSec}s ≈ 目标=${this.resumeTarget}s`);
                        } else if (elapsed < 90000) {
                            // 仍在跳转窗口内：跳过本次回写（当前进度保留为续播目标点，不写小值）
                            return;
                        } else {
                            // 超时兜底：放弃抑制，恢复正常回写（避免永久不回写）
                            this.resumePending = false;
                            log.warn(`[poll] 续播未在 90s 内到位(posSec=${posSec}, 目标=${this.resumeTarget})，解除抑制`);
                        }
                    }

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
        // [lc-237] 复位 pendingAdvance: launchEpisode 内 this.proc 已指向新进程,
        // 旧进程 close 由 launchEpisode 的 `this.proc === proc` 守卫忽略(不会误判为结束),
        // 故 pendingAdvance 不再需要。若不复位, pollOnce 会因 `|| this.pendingAdvance` 永久停轮询
        // → 进度不再回传 + 后续再也触发不了自动连播(本集结束判定失效)。
        this.pendingAdvance = false;
        if (this.proc) {
            try { this.proc.kill(); } catch (_) { /* ignore */ }
        }
        this.launchEpisode(next, false);
        // [lc-237] 切集间隙保护: 旧进程已 kill、新 PotPlayer 窗口尚未出现的瞬间轮询可能短时间
        // miss(连续 2 次即判关闭), 用 isSwitching 守卫避免被误判为用户关闭 → 错误结束播放。
        this.isSwitching = true;
        setTimeout(() => { this.isSwitching = false; }, 2500);
    }

    /**
     * 处理退出事件
     */
    private handleExit(code: number): void {
        // 复位续播抑制标志（退出后下次起播重新判断）
        this.resumePending = false;
        this.resumeTarget = 0;

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
        this.resumePending = false;
        this.resumeTarget = 0;
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
        this.resumePending = false;
        this.resumeTarget = 0;
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
     * 统一控制入口（全局快捷键转发）。
     * 通过 PotPlayer 的「/Current」命令行控制已运行的实例：
     *   /Current /play  → 播放
     *   /Current /pause → 暂停
     * 其余动作（快进/快退/倍速/上下集）PotPlayer CLI 不支持对运行实例精确控制，返回 false 由上层忽略。
     */
    control(action: PlayerControlAction): boolean {
        if (!this.active || !this.config.playerPath) {
            log.warn(`[control] PotPlayer 未运行，忽略动作: ${action}`);
            return false;
        }
        const exe = this.config.playerPath;
        const run = (cmd: string): boolean => {
            try {
                spawn(exe, ['/Current', cmd], { stdio: 'ignore', windowsHide: true });
                return true;
            } catch (e: any) {
                log.warn(`[control] PotPlayer /Current ${cmd} 失败:`, e?.message || e);
                return false;
            }
        };
        switch (action) {
            case 'playpause':
            case 'play':
                return run('/play');
            case 'pause':
            case 'stop':
                return run('/pause');
            case 'next': {
                const n = this.currentIndex + 1;
                if (n >= 0 && n < this.playlist.length) {
                    log.info(`[control] PotPlayer 手动下一集 -> 第 ${n + 1}/${this.playlist.length} 集`);
                    void this.switchTo(this.playlist, n);
                    return true;
                }
                log.info(`[control] PotPlayer 已是最后一集，忽略 next`);
                return false;
            }
            case 'prev': {
                const p = this.currentIndex - 1;
                if (p >= 0 && p < this.playlist.length) {
                    log.info(`[control] PotPlayer 手动上一集 -> 第 ${p + 1}/${this.playlist.length} 集`);
                    void this.switchTo(this.playlist, p);
                    return true;
                }
                log.info(`[control] PotPlayer 已是第一集，忽略 prev`);
                return false;
            }
            default:
                log.info(`[control] PotPlayer 不支持动作: ${action}`);
                return false;
        }
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
     * 生成 M3U8 播放列表内容（含可读标题 + 极速标签）
     * 标题格式：getTitle() 返回的「剧名 - S01E04: 集标题」+ [极速]
     */
    private generateM3U8Playlist(infos: PlayItem[], resumeTs: number = 0): string {
        let content = '#EXTM3U\n';
        // [续播] HLS 标准起始偏移标签：PotPlayer 作为 HLS 客户端应尊重，从目标集 ts 秒开始播。
        // （命令行 /seek 对 m3u8 文件整体无效，见 lc-247；EXT-X-START 是 m3u8 内部标签，PotPlayer 应当尊重）
        if (resumeTs > 0) {
            content += `#EXT-X-START:ENABLED=YES,TIME-OFFSET=${resumeTs.toFixed(3)}\n`;
        }
        for (const item of infos) {
            const duration = item.duration || -1;
            const title = `${this.getTitle(item)} [极速]`;
            // 直接用原始 proxy URL（不经 shim，避免额外 HTTP 转发导致 PotPlayer 启动卡顿）
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

        // 续播偏移交给 m3u8 的 EXT-X-START 标签（命令行 /seek 对 m3u8 文件无效，见 lc-247）
        const duration = startItem.duration || 0;
        const resumeTs = (startItem.ts > 0 && duration > 0 && startItem.ts <= 0.98 * duration) ? Math.floor(startItem.ts) : 0;
        const playlistContent = this.generateM3U8Playlist(infos, resumeTs);
        this.playlistFilePath = path.join(os.tmpdir(), `potplayer_playlist_${Date.now()}.m3u8`);
        await fs.promises.writeFile(this.playlistFilePath, playlistContent, 'utf-8');

        const launchArgs: string[] = [this.playlistFilePath];

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
