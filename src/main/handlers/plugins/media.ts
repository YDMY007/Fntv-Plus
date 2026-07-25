import { app, BrowserWindow, dialog, IpcMainEvent } from 'electron';
import * as ply from '../../../modules/players';
import * as fn from '../../../modules/fn_api/api';
import * as fnConfig from '../../../modules/fn_config/config';
import { registerHandler } from '../core/ipcHandler';
import { registerAppHook } from '../core/appHook';
import * as logger from '../../../modules/logger';
const log = logger.component('media');
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { PlayStatusData, ItemListRequest } from '../../../modules/fn_api/types';
import { escape } from 'querystring';
import { isTrusted } from '../../../modules/cert_trust';
import { checkLibraryPageUrl } from '../../common/utils';
import { getMainWindow } from '../../common/mainwin';
import * as doubanSync from './doubanSync';
import * as bangumiSync from './bangumiSync';

/**
* 媒体播放插件
* 处理视频播放相关功能
*/
interface PlayRequest {
    id: string;
    token: string;
    sourceIndex: number; // 可选，播放源
    player?: 'mpv' | 'potplayer'; // 指定播放器；缺省由 defaultPlayer 决定
}

// 全局播放器实例引用
let currentPlayer: ply.BasePlayer | null = null;

// MPV播放器路径缓存
let cachedPlayerPath: string | null = null;

// 设置MPV播放器路径（用于覆盖默认路径）
export function setMpvPlayerPath(path: string | null): void {
    cachedPlayerPath = path;
}

// PotPlayer 播放器路径缓存
let cachedPotPlayerPath: string | null = null;

// 设置 PotPlayer 播放器路径（用于覆盖默认路径）
export function setPotPlayerPath(path: string | null): void {
    cachedPotPlayerPath = path;
}

/**
 * 获取MPV播放器路径（带缓存）
 * @returns 播放器路径或undefined
 */
function getMpvPlayerPath(): string | undefined {
    // 如果已经缓存了路径，直接返回
    if (cachedPlayerPath) {
        return cachedPlayerPath;
    }

    const platform = os.platform();

    if (platform === 'win32') {
        // Windows 平台使用本地文件路径
        cachedPlayerPath = 'third_party\\fntv-mpv\\mpv.exe';
        return cachedPlayerPath;
    } else if (platform === 'darwin') {
        // macOS 常用安装路径
        const macPaths = [
            '/opt/homebrew/bin/mpv',  // Apple Silicon Mac (M1/M2)
            '/usr/local/bin/mpv',     // Intel Mac 或手动安装
            '/Applications/mpv.app/Contents/MacOS/mpv', // App bundle
        ];

        for (const path of macPaths) {
            if (fs.existsSync(path)) {
                cachedPlayerPath = path;
                log.info(`找到MPV播放器路径: ${path}`);
                return cachedPlayerPath;
            }
        }

        // 未找到mpv播放器
        dialog.showErrorBox('错误', 'macOS平台未找到mpv播放器，请使用Homebrew安装mpv后重试: brew install mpv');
        log.error('macOS平台未找到mpv播放器，请使用Homebrew安装mpv后重试: brew install mpv');
        return undefined;
    } else if (platform === 'linux') {
        // Linux 常用安装路径
        const linuxPaths = [
            '/usr/bin/mpv',           // 系统包管理器安装
            '/usr/local/bin/mpv',     // 手动编译安装
            '/snap/bin/mpv',          // Snap 包
            '/usr/games/mpv',         // 某些发行版
            '/opt/mpv/bin/mpv',       // 可选安装位置
        ];

        for (const path of linuxPaths) {
            if (fs.existsSync(path)) {
                cachedPlayerPath = path;
                log.info(`找到MPV播放器路径: ${path}`);
                return cachedPlayerPath;
            }
        }

        // 未找到mpv播放器
        dialog.showErrorBox('错误', 'Linux平台未找到mpv播放器，请安装mpv播放器后重试');
        log.error('Linux平台未找到mpv播放器，请安装mpv播放器后重试');
        return undefined;
    }

    return undefined;
}

/**
 * 内置 PotPlayer 的「隔离运行目录」：放在 userData 下，确保有写权限，
 * 并通过 exe 同目录的 PotPlayerMini64.ini 启用「ini 便携模式」，
 * 完全脱离本机注册表（HKCU\Software\Daum\PotPlayer），
 * 从而与本机已安装的 PotPlayer 配置互不干扰。
 */
function getUserDataPotPlayerDir(): string {
    return path.join(app.getPath('userData'), 'potplayer');
}

/**
 * 包内/开发时内置 PotPlayer 的「只读来源」目录：
 * 打包后位于 resources/third_party/potplayer（electron-builder extraFiles），
 * 开发时位于项目根 third_party/potplayer（copy-potplayer.js 复制）。
 */
function getBundledPotPlayerSource(): string | null {
    const candidates: string[] = [];
    try {
        candidates.push(path.join(process.resourcesPath || '', 'third_party', 'potplayer'));
    } catch (_) { /* ignore */ }
    candidates.push(path.resolve(process.cwd(), 'third_party', 'potplayer'));
    for (const c of candidates) {
        if (c && fs.existsSync(path.join(c, 'PotPlayerMini64.exe'))) return c;
    }
    return null;
}

/**
 * 将内置 PotPlayer 准备到 userData 下的可写隔离副本：
 * 首次（或升级后）从只读来源整体复制，并确保存在 PotPlayerMini64.ini
 * 以启用「ini 便携模式」——配置只写该 ini，绝不触碰本机注册表，
 * 因此本项目的 PotPlayer 拥有一套独立、全新的配置，与本机 PotPlayer 隔离。
 *
 * 幂等：副本已存在则跳过（保留用户已生成的便携配置，不被覆盖）。
 */
function prepareBundledPotPlayer(): void {
    const dest = getUserDataPotPlayerDir();
    const exePath = path.join(dest, 'PotPlayerMini64.exe');
    if (fs.existsSync(exePath)) {
        return; // 已就绪，保留用户配置
    }
    const src = getBundledPotPlayerSource();
    if (!src) {
        log.warn('[PotPlayer] 未找到内置 PotPlayer 来源，跳过隔离副本准备');
        return;
    }
    try {
        fs.cpSync(src, dest, { recursive: true });
        // 确保 ini 存在以触发便携模式（不读本机注册表）。
        // 空 ini 即可：PotPlayer 首次启动会自动生成完整默认配置，
        // 形成一套属于本项目、与本机隔离的独立配置。
        const iniPath = path.join(dest, 'PotPlayerMini64.ini');
        if (!fs.existsSync(iniPath)) {
            fs.writeFileSync(iniPath, '');
        }
        log.info(`[PotPlayer] 已准备隔离副本: ${dest}`);
    } catch (e) {
        log.error(`[PotPlayer] 准备隔离副本失败: ${e}`);
    }
}

/**
 * 解析应用内置（随包分发）的 PotPlayer 路径。
 * 为与本机配置隔离，内置 PotPlayer 运行于 userData 下的可写隔离副本
 * （ini 便携模式，不碰注册表），而非 Program Files 内只读来源。
 */
function resolveBundledPotPlayerPath(): string {
    return path.join(getUserDataPotPlayerDir(), 'PotPlayerMini64.exe');
}

/**
 * 判断当前是否使用「应用内置（随包分发）」的 PotPlayer。
 * 若用户显式配置了其它路径，则不视为内置。
 */
export function isPotPlayerBundled(): boolean {
    const configPath = fnConfig.getPotPlayerPath();
    if (configPath) return false; // 用户显式指定了覆盖路径 -> 非内置模式
    // 内置来源存在，或 userData 隔离副本已就绪
    return !!getBundledPotPlayerSource() ||
        fs.existsSync(path.join(getUserDataPotPlayerDir(), 'PotPlayerMini64.exe'));
}

/**
 * 获取 PotPlayer 播放器路径（带缓存）
 * 优先级：① 用户显式配置的路径（覆盖） ② 应用内置打包的 PotPlayer ③ 本机已安装路径（兜底）
 * @returns 播放器路径或undefined
 */
export function getPotPlayerPath(): string | undefined {
    if (cachedPotPlayerPath) {
        return cachedPotPlayerPath;
    }

    const platform = os.platform();
    if (platform === 'win32') {
        // ① 用户显式配置的路径优先（允许覆盖内置版本）
        const configPath = fnConfig.getPotPlayerPath();
        if (configPath && fs.existsSync(configPath)) {
            cachedPotPlayerPath = configPath;
            log.info(`使用配置的 PotPlayer 路径: ${configPath}`);
            return cachedPotPlayerPath;
        }

        // ② 应用内置 PotPlayer（随包分发，运行于 userData 隔离副本，配置与本机隔离）
        const bundledExe = resolveBundledPotPlayerPath();
        // 若隔离副本尚未就绪则先同步准备（首次会复制，后续幂等直接返回）
        if (!fs.existsSync(bundledExe)) {
            prepareBundledPotPlayer();
        }
        if (fs.existsSync(bundledExe)) {
            cachedPotPlayerPath = bundledExe;
            log.info(`使用应用内置 PotPlayer（隔离副本）: ${bundledExe}`);
            return cachedPotPlayerPath;
        }

        // ③ 兜底：探测本机已安装的 PotPlayer
        const commonPaths = [
            'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
            'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
            `${process.env['LOCALAPPDATA'] || ''}\\PotPlayer\\PotPlayerMini64.exe`,
        ];
        for (const p of commonPaths) {
            if (p && fs.existsSync(p)) {
                cachedPotPlayerPath = p;
                log.info(`自动探测到 PotPlayer 路径: ${p}`);
                return cachedPotPlayerPath;
            }
        }

        log.warn('未找到 PotPlayer（请确认安装包已自带，或在设置中指定路径）');
        return undefined;
    }

    // macOS / Linux 下 PotPlayer 不可用，仅支持用户显式配置的路径
    const configPath = fnConfig.getPotPlayerPath();
    if (configPath && fs.existsSync(configPath)) {
        cachedPotPlayerPath = configPath;
        return cachedPotPlayerPath;
    }
    return undefined;
}

// 刷新窗口
async function refreshWindow(): Promise<void> {
    const currentURL = getMainWindow().webContents.getURL() || '';
    // 如果是资源库页面则不刷新
    if (checkLibraryPageUrl(currentURL)) {
        return;
    }

    log.info('刷新当前窗口');
    getMainWindow().webContents.reloadIgnoringCache();
}

/**
 * 创建播放器事件处理器
 * @param fnapi - API服务实例
 * @param itemGuid - 当前播放项的GUID
 * @returns 事件处理函数
 */
function eventHandler(fnapi: fn.ApiService) {
    return async (type: ply.EventType, data: ply.EventData) => {
        switch (type) {
            case ply.EventType.PROGRESS:
                const progressData = data as ply.PlayStatusData;

                if (progressData.itemGuid.length === 0) {
                    log.info("process itemguid is empty")
                    return;
                }

                // if (progressData.percentage > 90) {
                //     log.info('视频播放接近结束，更新状态...');
                //     await fnapi.setWatched(progressData.itemGuid);
                //     return;
                // }
                // 优先从缓存查询播放信息
                const resp = await fnapi.getPlayInfoCached(progressData.itemGuid);
                if (!resp.success || !resp.data) {
                    log.error('获取播放信息失败:', resp ? resp.message : '未知错误');
                    return;
                }

                const info = resp.data;

                const record: fn.PlayStatusData = {
                    item_guid: progressData.itemGuid,
                    media_guid: info.media_guid,
                    video_guid: info.video_guid,
                    audio_guid: info.audio_guid,
                    subtitle_guid: info.subtitle_guid,
                    play_link: new URL(fnapi.getVideoUrl(info.media_guid)).hostname,
                    ts: progressData.ts,
                    duration: progressData.duration,
                };

                log.info('播放进度更新:', record);

                await fnapi.recordPlayStatus(record);

                // [豆瓣同步] 首播标"在看"（内部节流，不阻塞播放）；传入 ts/duration 以便
                // 在「媒体有效」时即标在看，不受 percentage=floor(ts/duration*100) 开播前恒为 0 的影响
                void doubanSync.syncOnProgress(progressData.itemGuid, info, progressData.percentage, fnapi, progressData.ts, progressData.duration);
                // [Bangumi 同步] 进度达阈值(默认80%)时把该集标为 Bangumi「看过」（集数级，内部节流去重，不阻塞播放）
                void bangumiSync.syncOnProgress(progressData.itemGuid, info, progressData.percentage, fnapi, progressData.ts, progressData.duration);
                break;

            case ply.EventType.ERROR:
                const errorData = data as ply.PlayErrorData;
                log.error('MPV error:', String(errorData.message));
                break;

            case ply.EventType.EXIT:
                const event = data as ply.PlayExitData;
                if (event.code !== 0) {
                    log.error(`播放器异常退出 (code ${event.code})`);
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await refreshWindow();
                    return;
                }

                if (event.status.itemGuid.length === 0) {
                    return;
                }

                log.info('MPV exited with code:', event.code);
                log.info('最后播放位置:', event.status);

                // if (event.status.percentage > 90) {
                //     log.info('视频播放接近结束，更新状态...');
                //     await fnapi.setWatched(event.status.itemGuid);
                // } else {
                // 优先从缓存查询播放信息
                {
                    const resp = await fnapi.getPlayInfoCached(event.status.itemGuid);
                    if (!resp.success || !resp.data) {
                        log.error('获取播放信息失败:', resp ? resp.message : '未知错误');
                        return;
                    }

                    const info = resp.data;

                    const record: fn.PlayStatusData = {
                        item_guid: event.status.itemGuid,
                        media_guid: info.media_guid,
                        video_guid: info.video_guid,
                        audio_guid: info.audio_guid,
                        subtitle_guid: info.subtitle_guid,
                        play_link: new URL(fnapi.getVideoUrl(info.media_guid)).hostname,
                        ts: event.status.ts,
                        duration: event.status.duration,
                    };

                    log.debug('记录播放状态start');
                    await fnapi.recordPlayStatus(record);
                    log.debug('记录播放状态end');
                }

                // 等待50ms
                await new Promise(resolve => setTimeout(resolve, 50));
                await refreshWindow();
                break;

            default:
                log.debug('收到播放器事件:', type);
                break;
        }
    };
}

// 处理播放事件
async function handlePlayMovie(event: IpcMainEvent, { id, token, sourceIndex, player }: PlayRequest): Promise<void> {
    log.info('Play movie event received id:', id, ' with token:', token, ' index:', sourceIndex);

    const config = fnConfig.readConfig();
    if (!config || !config.domain) {
        throw new Error('无法找到服务器地址配置');
    }

    const fnapi = new fn.ApiService(config.domain, token);

    const response = await fnapi.getPlayInfo(id);
    if (!response.success || !response.data) {
        log.error('获取播放信息失败:', response ? response.message : '未知错误');
        return;
    }

    log.info('获取播放信息成功:', response.data);

    const type = response.data.type;
    const parentGuid = response.data.parent_guid;
    const itemGuid = response.data.guid;

    let playList: ply.PlayItem[] = [];
    if (type === 'Episode' && parentGuid) {
        log.info('当前为剧集，尝试获取系列下的所有剧集进行播放');
        const episodeList = await fnapi.getEpisodeList(parentGuid);
        if (!episodeList.success || !episodeList.data) {
            log.error('获取剧集列表失败:', episodeList ? episodeList.message : '未知错误');
            return;
        }

        for (const episode of episodeList.data) {
            const mediaItem = processEpisodeMedia(config, episode);
            playList.push(mediaItem);
            log.info('添加剧集到播放列表:', mediaItem);
        }
    } 
    else if (type === 'Video' && parentGuid) {
        log.info('当前为其他视频，添加到播放列表');
        const req: ItemListRequest = {
            parent_guid: parentGuid,
            exclude_folder: 1,
            sort_column: 'sort_title',
            sort_type: 'ASC',
        };

        const mediaList = await fnapi.getItemList(req);
        log.info('获取媒体列表响应:', mediaList);
        if (!mediaList.success || !mediaList.data || !mediaList.data.list) {
            log.error('获取媒体列表失败:', mediaList ? mediaList.message : '未知错误');
            return;
        }

        for (const media of mediaList.data.list) {
            const mediaItem = processEpisodeMedia(config, media);
            playList.push(mediaItem);
            log.info('添加剧集到播放列表:', mediaItem);
        }
    }
    else {
        const mediaItem = processSingleMedia(config, response.data);
        playList.push(mediaItem);
        log.info('添加单集到播放列表:', mediaItem);
    }

    if (playList.length === 0) {
        log.warn('播放列表为空');
        return;
    }

    // 寻找当前播放的媒体在数组中的位置
    const currentIndex = playList.findIndex(item => item.itemGuid === itemGuid);

    // 检查是否选择了特定的播放源索引
    if (sourceIndex > 0) {
        log.info(`使用指定的播放源索引: ${sourceIndex}`);
        // 修改播放列表中的源索引
        playList[currentIndex].playLink = getProxyUrl(config, playList[currentIndex].itemGuid, sourceIndex);
    }

    // 决定使用的播放器类型与路径
    const wantPot = (player || fnConfig.getDefaultPlayer()) === 'potplayer';
    const playerType = wantPot ? ply.PlayerType.POTPLAYER : ply.PlayerType.MPV;
    const playerPath = wantPot ? getPotPlayerPath() : getMpvPlayerPath();
    if (!playerPath) {
        if (wantPot) {
            log.error('无法找到 PotPlayer 播放器路径（请在设置中指定）');
        } else {
            log.error('无法找到 MPV 播放器路径');
        }
        return;
    }

    let playConfig: ply.Config = {
        fnapi: fnapi,
        playerPath: playerPath,
        // headers: {
        //     Authorization: token,
        // },
        extraArgs: wantPot ? [] : [
            '--force-window=immediate',
            '--network-timeout=180',
            // "--user-agent=Lavf/59.27.100",
        ],
        debug: true,
        onEvent: eventHandler(fnapi)
    };

    // === 切换 / 抢占逻辑：实现「点哪个播哪个」 ===
    // 若已有播放器在播，先尝试【原地切换】到新内容；切换失败或类型不同则停止当前再重建。
    if (currentPlayer && currentPlayer.isPlaying()) {
        if (wantPot && currentPlayer instanceof ply.PotPlayer) {
            // 同类型 PotPlayer → 复用现有窗口（/current 开关），不重新拉起页面，切换更快
            log.info('已有 PotPlayer 在播放，尝试原地切换(复用窗口)');
            try {
                const ok = await currentPlayer.switchTo(playList, currentIndex);
                if (ok) {
                    log.info('✅ 已原地切换到新内容（未重新拉起 PotPlayer 窗口）');
                    return;
                }
                log.warn('[PotPlayer] 原地切换失败，回退为停止后重新播放');
            } catch (swErr: any) {
                log.warn('[PotPlayer] 原地切换异常，回退为停止后重新播放:', swErr?.message || swErr);
            }
        } else {
            log.info('已有播放器在播放(非 PotPlayer 或类型不同)，先停止当前再切换');
        }
        // 兜底：停止当前播放器，下方重建新实例
        currentPlayer.stop();
        currentPlayer = null;
    }

    // 创建播放器实例
    const playerInstance = ply.PlayerFactory.createPlayer(playerType, playConfig);

    // 保存全局引用
    currentPlayer = playerInstance;

    // 开始播放
    playerInstance.playList(playList, currentIndex);
}

// 生成代理URL
function getProxyUrl(cfg: fnConfig.Config, itemGuid: string, sourceIndex: number = 0): string {
    const skipVerify = isTrusted(cfg.domain || '') ? '1' : '0';
    const useNasLocal = cfg.nasProxyEnabled === true ? '1' : '0';
    // urlencode
    const domain = escape(cfg.domain || '');
    // const skipVerify = '1'; // 永远跳过证书验证
    return `http://127.0.0.1:22346/api/v1/playvideo/${itemGuid}?token=${cfg.token}&skipVerify=${skipVerify}&account=${cfg.account}&domain=${domain}&useNasLocal=${useNasLocal}&sourceIndex=${sourceIndex}`;
}

// 处理当前播放的媒体信息
function processEpisodeMedia(cfg: fnConfig.Config, info: fn.PlayListItem): ply.PlayItem {
    return {
        itemGuid: info.guid,
        title: info.title,
        tvTitle: info.tv_title,
        seasonNumber: info.season_number,
        episodeNumber: info.episode_number,
        ts: info.ts,
        duration: info.duration,
        playLink: getProxyUrl(cfg, info.guid),
    };
}

// 处理单个待播放媒体信息
function processSingleMedia(cfg: fnConfig.Config, info: fn.PlayInfo): ply.PlayItem {
    return {
        itemGuid: info.guid,
        title: info.item.title,
        tvTitle: info.item.tv_title,
        seasonNumber: info.item.season_number,
        episodeNumber: info.item.episode_number,
        ts: info.ts,
        duration: info.item.duration,
        playLink: getProxyUrl(cfg, info.guid),
    };
}

// 应用退出前清理播放器
function handleBeforeQuit(): void {
    if (currentPlayer) {
        log.info('应用退出前关闭播放器');
        currentPlayer.stop();
        currentPlayer = null;
    }

    // 清理播放器路径缓存
    cachedPlayerPath = null;
    cachedPotPlayerPath = null;
}

// 注册媒体播放处理器
function init(): void {
    // 从配置中读取MPV播放器路径并设置
    const configMpvPath = fnConfig.getMpvPlayerPath();
    if (configMpvPath) {
        setMpvPlayerPath(configMpvPath);
        log.info(`从配置中加载MPV播放器路径: ${configMpvPath}`);
    }

    // 从配置中读取 PotPlayer 播放器路径并设置
    const configPotPath = fnConfig.getPotPlayerPath();
    if (configPotPath) {
        setPotPlayerPath(configPotPath);
        log.info(`从配置中加载 PotPlayer 播放器路径: ${configPotPath}`);
    }

    registerHandler('play-movie', handlePlayMovie);
    registerAppHook('beforeQuit', handleBeforeQuit);

    // 异步预准备内置 PotPlayer 的隔离副本（首次复制 209MB，避免播放时阻塞）
    setImmediate(prepareBundledPotPlayer);
}

export {
    init
};
