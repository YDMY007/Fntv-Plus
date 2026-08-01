import * as fn from '../fn_api/api';

// 播放器事件类型枚举
export enum EventType {
    PROGRESS = 'progress',
    ERROR = 'error',
    EXIT = 'exit',
    /** 当前集序号变化（手动切集 / 自动连播 / 原地切换均会触发），供主进程刷新悬浮控制条可用状态 */
    EPISODE = 'episode',
}

// 当前集变化数据（EPISODE 事件载荷）
export type EpisodeChangeData = {
    /** 当前集索引（0 基） */
    index: number;
    /** 总集数 */
    total: number;
}

// 单个播放源信息(非当前播放只需要传itemGuid)
export interface PlayItem {
    itemGuid: string;
    title: string;
    tvTitle: string;
    seasonNumber: number;
    episodeNumber: number;
    ts: number;
    duration: number;
    playLink: string;
    /** 飞牛媒体类型（"Movie"/"Episode"/"TvSeries"…），用于「仅作品类匹配弹幕」判断；缺省视为不可同步 */
    type?: string;
}

// 播放状态数据
export type PlayStatusData = {
    itemGuid: string;
    ts: number;
    duration: number;
    percentage: number;
}

// 播放器退出数据接口
export type PlayExitData = {
    code: number;
    status: PlayStatusData;
}

// 播放器错误数据接口
export type PlayErrorData = {
    message: string;
}

// 播放器事件数据类型
export type EventData = PlayStatusData | PlayExitData | PlayErrorData | EpisodeChangeData;

// 事件处理器类型
export type EventHandler = (type: EventType, data: EventData) => void;

// 播放器配置接口
export type Config = {
    headers?: Record<string, string>;
    debug?: boolean;
    extraArgs?: string[];
    playerPath?: string;
    fnapi: fn.ApiService;
    onEvent: EventHandler;
}

// 播放器类型枚举
export enum PlayerType {
    MPV = 'mpv',
    POTPLAYER = 'potplayer',
    // 可以扩展其他播放器类型
}

// 全局快捷键/统一控制动作（由 media.ts 的 controlCurrentPlayer 转发到当前播放器）
export type PlayerControlAction =
    | 'playpause'   // 播放/暂停切换
    | 'play'        // 播放
    | 'pause'       // 暂停
    | 'seek-back'   // 快退（相对 -5s）
    | 'seek-fwd'    // 快进（相对 +5s）
    | 'speed-up'    // 倍速 +
    | 'speed-down'  // 倍速 -
    | 'next'        // 下一集
    | 'prev'        // 上一集
    | 'stop';       // 停止（暂停）

// 播放器抽象基类
export abstract class BasePlayer {
    protected config: Required<Config>;
    protected globalStatus: PlayStatusData = {
        itemGuid: '',
        ts: 0,
        duration: 0,
        percentage: 0,
    };

    constructor(config: Config) {
        // 设置默认配置
        this.config = {
            headers: config.headers || {},
            debug: config.debug || false,
            extraArgs: config.extraArgs || [],
            playerPath: config.playerPath || '',
            onEvent: config.onEvent,
            fnapi: config.fnapi
        };
    }

    // 播放列表
    abstract playList(infos: PlayItem[], pos: number, args?: string[]): Promise<boolean>;

    // 停止播放
    abstract stop(): void;

    // 判断播放器是否正在播放
    abstract isPlaying(): boolean;

    // 统一控制入口（全局快捷键/远程控制转发）。默认无操作；各播放器根据自身能力覆写。
    // action 见 PlayerControlAction。返回是否"已处理"（未处理的动作由上层忽略）。
    control(_action: PlayerControlAction): boolean {
        return false;
    }

    // 原地切换播放内容：在已运行的「同类型」播放器窗口内直接切换，不重新拉起页面。
    // 默认不支持（返回 false）；PotPlayer 通过 /current 命令行复用现有窗口实现。
    // 上层（media.ts）据此决定：返回 true 即已完成切换，无需 stop+重建。
    switchTo(_infos: PlayItem[], _index: number): Promise<boolean> {
        return Promise.resolve(false);
    }

    // 获取当前播放状态
    protected getStatus(): PlayStatusData {
        return this.globalStatus;
    }

    // 发送播放事件
    protected emitEvent(type: EventType, event: EventData): void {
        this.config.onEvent(type, event);
    }

    // 更新全局播放状态
    protected updateGlobalStatus(status: PlayStatusData): void {
        this.globalStatus = status;
    }

    // 获取fnapi实例
    protected getFnApi(): fn.ApiService {
        return this.config.fnapi;
    }
}

// 播放器构造函数类型
export type PlayerConstructor = new (config: Config) => BasePlayer;

// 播放器注册表接口
export interface PlayerRegistry {
    [key: string]: PlayerConstructor;
}