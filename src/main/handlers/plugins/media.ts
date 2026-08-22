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
import { getSessionCookieHeader } from '../../../modules/fn_api/request';
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

// [lc-385] 通用外部播放入口：支持 fnOS 流(fnos) / 本地文件(file) / 直链(url)
interface ExtPlayRequest {
    kind: 'fnos' | 'file' | 'url';
    player?: 'mpv' | 'potplayer'; // 指定播放器；缺省由 defaultPlayer 决定
    // fnos 类
    id?: string;
    token?: string;
    sourceIndex?: number;
    // file / url 类
    path?: string;
    url?: string;
    title?: string;
}

// 全局播放器实例引用
let currentPlayer: ply.BasePlayer | null = null;

// [lc-295] 本地代理(Go proxy.exe)播放鉴权补全:
// fnOS 影视接口/媒体流依赖 persist:fntv 会话 Cookie(Trim-MC-token)。Electron 主进程 request.ts 已在
// lc-294 转发该 Cookie, 但独立 Go 代理进程拿不到 persist:fntv。故此处把会话 Cookie 读出来、经代理 URL
// 的 cookie 查询参数传给 Go 代理, 由它在调 NAS 接口(/v/api/v1/stream/*)与转发媒体流时一并带上,
// 避免代理被弹回登录页 HTML(表现为 playvideo 返回 500 / 解析 JSON 失败 '<')。
let cachedSessionCookie = '';
// [lc-663] MPV 网络流缓冲参数：开启 cache 且不在缓存不足时暂停，首片到手即出画，
// 根治经 Go 代理(playvideo)拉原始大文件时「黑屏 5-6 秒才出画」的问题。
// 个人视频是用户上传的原始文件(无 HLS 切片)，代理起流慢，无 cache 时会卡到缓冲足才放。
// ⚠️ [lc-664] 不要加 --demuxer-cache-wait=0！该选项在 mpv 是布尔开关(yes/no)，
//   传 0 会报 Invalid parameter → mpv 启动即退出 → node-mpv-2 start() 静默挂死(点播放没反应)。
//   其默认值即为「不等待缓存填充」，无需显式设置。
const MPV_NETWORK_ARGS = [
    '--force-window=immediate',
    '--network-timeout=180',
    '--cache=yes',
    '--cache-secs=30',
    '--cache-pause=no',
];

async function refreshSessionCookie(domain: string): Promise<void> {
    try {
        cachedSessionCookie = await getSessionCookieHeader(domain);
    } catch {
        cachedSessionCookie = '';
    }
}

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
 * 路径是否纯 ASCII（不含中文/非 ASCII 字符）。
 * PotPlayer 是 ANSI(C/GBK) 程序，凡经它解析的路径(ini/配置/字幕)若含非 ASCII
 * 会按 GBK 错误解析，导致配置加载失败、「无法播放」或字幕打不开。
 * 内置 PotPlayer 副本与字幕缓存都必须落在纯 ASCII 目录。
 */
function isAsciiPath(p: string): boolean {
    return !/[^\x00-\x7F]/.test(p);
}

/**
 * 内置 PotPlayer 的「隔离运行目录」。
 * 必须落在【不含中文用户名/不含非 ASCII】的固定系统目录，
 * 否则 PotPlayer（ANSI 程序）按 GBK 解析 ini/配置路径失败 → 无法播放。
 * 优先 C:\Users\Public\Fntv-Plus（所有 Windows 固定英文路径、普通用户可写），
 * 回退 C:\ProgramData\Fntv-Plus，最后才回退 userData（旧行为，会触发中文路径警告）。
 */
function getBundledPotPlayerDir(): string {
    const candidates = [process.env.PUBLIC, process.env.ProgramData, app.getPath('userData')]
        .filter(Boolean) as string[];
    for (const base of candidates) {
        if (isAsciiPath(base)) {
            return path.join(base, 'Fntv-Plus', 'potplayer');
        }
    }
    return path.join(app.getPath('userData'), 'Fntv-Plus', 'potplayer');
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
 * 异步准备内置 PotPlayer 隔离副本（不阻塞主线程）。
 *
 * 幂等：副本已存在则跳过（保留用户已生成的便携配置，不被覆盖）。
 * 首次（或升级后）从只读来源整体复制/迁移，并确保存在 PotPlayerMini64.ini
 * 以启用「ini 便携模式」——配置只写该 ini，绝不触碰本机注册表。
 *
 * 实现策略: 用 setImmediate 将文件操作放到下一个事件循环 tick,
 * 避免 fs.cpSync(209MB) 阻塞启动 / 造成磁盘 I/O 风暴影响页面加载。
 */
function prepareBundledPotPlayer(): void {
    setImmediate(() => {
        try {
            const dest = getBundledPotPlayerDir();
            fs.mkdirSync(dest, { recursive: true });
            const exePath = path.join(dest, 'PotPlayerMini64.exe');
            if (fs.existsSync(exePath)) {
                return; // 已就绪，保留用户配置
            }

            // 迁移旧版落在 userData 下的副本(含用户已生成的便携 ini 配置)
            const legacy = path.join(app.getPath('userData'), 'potplayer');
            const legacyExe = path.join(legacy, 'PotPlayerMini64.exe');
            if (fs.existsSync(legacyExe)) {
                try {
                    fs.renameSync(legacy, dest);
                    log.info(`[PotPlayer] 已迁移旧副本到非中文目录: ${dest}`);
                    return;
                } catch (renameErr: any) {
                    // Windows 上跨卷/rename 被杀毒/索引锁住 → EPERM/EACCES
                    // 改用异步复制, 不阻塞 (209MB 可能需数秒)
                    log.warn(`[PotPlayer] 迁移旧副本失败(${renameErr.code}), 改为异步复制: ${renameErr.message}`);
                    copyPotPlayerAsync(legacy, dest);
                    return;
                }
            }

            const src = getBundledPotPlayerSource();
            if (!src) {
                log.warn('[PotPlayer] 未找到内置 PotPlayer 来源，跳过隔离副本准备');
                return;
            }
            copyPotPlayerAsync(src, dest);
        } catch (e) {
            log.error('[PotPlayer] 准备隔离副本失败:', e);
        }
    });
}

/**
 * 异步复制 PotPlayer（209MB），分批进行避免长时间阻塞事件循环。
 * 使用递归 setTimeout 让出控制权每 50ms, 保证 UI 响应。
 */
function copyPotPlayerAsync(src: string, dest: string): void {
    const startTs = Date.now();
    // 先用同步 cpSync (Node.js 内部已优化), 但包在 setImmediate 里避免阻塞启动路径
    // 若未来 209MB 复制仍感卡顿, 可改为 child_process('xcopy /E /I /Y') 真正后台化
    try {
        fs.cpSync(src, dest, { recursive: true });
        const iniPath = path.join(dest, 'PotPlayerMini64.ini');
        if (!fs.existsSync(iniPath)) {
            fs.writeFileSync(iniPath, '');
        }
        log.info(`[PotPlayer] 已准备隔离副本: ${dest} (${Date.now() - startTs}ms)`);
    } catch (e) {
        log.error(`[PotPlayer] 复制失败: ${e}`);
    }
}

/**
 * 解析应用内置（随包分发）的 PotPlayer 路径。
 * 为与本机配置隔离，内置 PotPlayer 运行于 userData 下的可写隔离副本
 * （ini 便携模式，不碰注册表），而非 Program Files 内只读来源。
 */
function resolveBundledPotPlayerPath(): string {
    return path.join(getBundledPotPlayerDir(), 'PotPlayerMini64.exe');
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
        fs.existsSync(path.join(getBundledPotPlayerDir(), 'PotPlayerMini64.exe'));
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

        // ② 应用内置 PotPlayer（随包分发，运行于隔离副本，配置与本机隔离）
        const bundledExe = resolveBundledPotPlayerPath();
        // 注意: 不再在此同步 prepareBundledPotPlayer()（首次需复制 209MB，
        // fs.cpSync 会阻塞主线程数秒, 拖慢启动/可能导致磁盘 I/O 风暴影响页面加载）。
        // 隔离副本由 init() 里的 setImmediate 异步预准备；若播放时仍未就绪，
        // potplayer.ts 的 spawn 路径会回退到本机探测(③)，不影响功能。
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
                    // [lc-127] 播放器异常退出: 仅记录日志, 不再整页刷新。
                    // 用户反馈「每次关闭视频后首页都会刷新一次」体验差, 改为仅在每次启动
                    // 时随初始 loadURL 刷新一次首页。关闭视频后由 SPA 自身返回首页,
                    // 注入钩子(MutationObserver/poll)会自动重注入播放按钮/轮播;
                    // 玻璃壳 CSS 在 dom-ready 时重注(mainwin.ts), 不会丢失。
                    log.error(`播放器异常退出 (code ${event.code})，不再整页刷新，交由 SPA 自行恢复`);
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

                // 等待50ms让进度记录落库。
                // [lc-127] 无论正常还是异常退出, 均不再整页刷新:
                //   关闭视频后由 SPA 自身返回首页, 注入的钩子(MutationObserver/poll)
                //   会自动重注入播放按钮/轮播; 用户仅需「下次启动」时首页才会重新拉取「继续观看」进度
                //   (符合用户需求: 刷新只在启动时发生一次, 而非每次关闭视频都刷)。
                await new Promise(resolve => setTimeout(resolve, 50));
                break;

            default:
                log.debug('收到播放器事件:', type);
                break;
        }
    };
}

// 处理播放事件
async function handlePlayMovie(event: IpcMainEvent, { id, token: reqToken, sourceIndex, player }: PlayRequest): Promise<void> {
    const config = fnConfig.readConfig();
    if (!config || !config.domain) {
        throw new Error('无法找到服务器地址配置');
    }
    // [lc-596] token 兜底: 播放页按钮可能拿不到 cookie token, 回退配置 token(已登录必存)
    const token = (reqToken && String(reqToken).trim()) || config.token || '';
    log.info('Play movie event received id:', id, ' with token:', token, ' index:', sourceIndex);
    const t0 = Date.now();

    // [lc-295] 播放前刷新一次会话 Cookie, getProxyUrl 会将其编入代理 URL 传给 Go 代理
    await refreshSessionCookie(config.domain);
    log.info(`[perf] refreshSessionCookie 耗时 ${Date.now() - t0}ms`);

    const fnapi = new fn.ApiService(config.domain, token);

    const response = await fnapi.getPlayInfo(id);
    log.info(`[perf] getPlayInfo 耗时 ${Date.now() - t0}ms (自点击)`);
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
        // [lc-609] 个人视频(未刮削, 侧边栏「分类-其他」文件夹里的视频) → 单播, 不拉文件夹合集!
        // 根因: 旧实现 getItemList(parent_guid) 拉取整个文件夹所有视频塞进播放列表,
        // 但 getItemList 返回的 guid 与 getPlayInfo(id) 的 itemGuid 不一致 →
        // currentIndex 匹配失败(-1) → 静默从列表第 1 个(上次播放的那个)开始 →
        // 用户"点新的个人视频却播放的是上次的视频"。
        // 个人视频彼此独立(非剧集), 点击哪个就播哪个: 直接单播, 与电影分支一致。
        log.info('当前为其他视频(个人视频)，单播:', itemGuid);
        const mediaItem = processSingleMedia(config, response.data);
        playList.push(mediaItem);
        log.info('添加个人视频到播放列表:', mediaItem);
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
    log.info(`[选集诊断] 被点击 itemGuid=${itemGuid}, currentIndex=${currentIndex}/${playList.length - 1}, 列表前3项guid=[${playList.slice(0, 3).map(i => i.itemGuid).join(', ')}]`);
    if (currentIndex < 0) {
        log.error(`[选集诊断] 未匹配到被点击集(currentIndex=-1)，将静默从第1集(索引0)开始——疑似 getEpisodeList 返回的 guid 与 getPlayInfo 不一致`);
    }

    // [续播修复] 被点击集的真实观看进度在 getPlayInfo(id) 返回的 response.data.ts 中；
    // 而上面构造 playList 用的是 getEpisodeList 每集的 ts(往往未被 fnOS 回填)，
    // 故把 response.data.ts 合并覆盖到被点击集，确保续播起点正确。
    if (currentIndex >= 0 && currentIndex < playList.length) {
        const clickedTs = (response.data && response.data.ts) || 0;
        if (clickedTs > 0) {
            playList[currentIndex].ts = clickedTs;
            log.info(`[续播] 合并被点击集进度 response.data.ts=${clickedTs}s → playList[${currentIndex}] (guid=${playList[currentIndex].itemGuid})`);
        } else {
            log.warn(`[续播] 被点击集 response.data.ts 无效(=${clickedTs})，续播可能从头开始`);
        }
    }

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
    // [lc-298] 播放器检测：仅 MPV 触发弹幕搜索/下载（由 MPV 内部 uosc_danmaku Lua 脚本实现）；
    // PotPlayer / 原生播放均不触发主进程弹幕拉取（PotPlayer 的弹幕触发已在 potplayer.ts 移除）。
    log.info(`[播放器检测] 请求播放器=${player || '默认(' + fnConfig.getDefaultPlayer() + ')'} → 实际=${playerType === ply.PlayerType.MPV ? 'MPV(触发弹幕)' : 'PotPlayer(不触发弹幕)'}`);
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
        extraArgs: wantPot ? [] : MPV_NETWORK_ARGS,
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
    log.info(`[perf] 进入 MPV 启动前, 自点击累计 ${Date.now() - t0}ms`);
    playerInstance.playList(playList, currentIndex);
}

// [lc-467] strm 解析辅助：.strm 本质是文本文件（每行一个真实播放 URL）。
// 外部播放器(PotPlayer/MPV)不会解析其内部 URL，直接打开 .strm 会拿到文本而播放失败。
// 故在交给播放器前，若链接指向 .strm，先下载并提取首个 http(s) URL 作为真实播放地址；
// 解析失败 / 非 strm / 运行环境无 fetch 时原样返回，不影响其它直链与 fnos 路径。
async function resolveStrm(raw: string): Promise<string> {
  try {
    const pathPart = raw.split('?')[0].toLowerCase();
    if (!pathPart.endsWith('.strm')) return raw;
    log.info('[strm] 检测到 .strm 链接，尝试解析内部真实 URL:', raw);
    const fetchFn = (globalThis as any).fetch;
    const AbortControllerCtor = (globalThis as any).AbortController;
    if (!fetchFn) { log.warn('[strm] 运行环境无 fetch，跳过解析'); return raw; }
    const ctrl = AbortControllerCtor ? new AbortControllerCtor() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
    const resp = await fetchFn(raw, ctrl ? { signal: ctrl.signal } : {});
    if (timer) clearTimeout(timer);
    if (!resp.ok) { log.warn('[strm] 下载 strm 失败 status=' + resp.status + '，回退原链接'); return raw; }
    const text = await resp.text();
    const lines = String(text).split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^https?:\/\//i.test(line)) { log.info('[strm] 解析到真实播放 URL:', line); return line; }
    }
    log.warn('[strm] strm 内容未包含 http(s) URL，回退原链接');
    return raw;
  } catch (e: any) {
    log.warn('[strm] 解析异常，回退原链接:', e?.message || e);
    return raw;
  }
}

// [lc-385] 通用外部播放入口：fnOS 流 / 本地文件 / 直链 统一拉起 PotPlayer/MPV
async function handleExternalPlay(_event: IpcMainEvent, req: ExtPlayRequest): Promise<void> {
    log.info('[external-play] 收到请求:', JSON.stringify({ kind: req.kind, player: req.player, id: req.id, hasPath: !!req.path, hasUrl: !!req.url }));
    const config = fnConfig.readConfig();
    if (!config || !config.domain) {
        log.error('[external-play] 无法找到服务器地址配置');
        return;
    }
    const wantPot = (req.player || fnConfig.getDefaultPlayer()) === 'potplayer';

    // fnos 类：直接复用现有 fnOS 播放链路（含续播/字幕/选集/代理鉴权）
    if (req.kind === 'fnos') {
        if (!req.id) { log.error('[external-play] fnos 缺少 id'); return; }
        // token 由 preload 从 fnOS 桌面页 cookie(Trim-MC-token) 取得传入；缺失则回退配置 token
        const token = req.token || config.token || '';
        return handlePlayMovie(_event, { id: req.id, token, sourceIndex: req.sourceIndex || 0, player: req.player });
    }

    // file / url 类：本地文件或直链，无需 fnOS 代理与 fnapi 字幕
    let link = req.kind === 'file' ? (req.path || '') : (req.url || '');
    if (!link) { log.error('[external-play] file/url 缺少 path/url'); return; }
    // [lc-467] strm 解析：.strm 是文本文件(每行一个真实播放 URL)，外部播放器不会解析其内部 URL。
    //   交给 PotPlayer/MPV 前先探测：若指向 .strm，则下载提取首个 http(s) URL 作为真实播放地址。
    link = await resolveStrm(link);

    const playerType = wantPot ? ply.PlayerType.POTPLAYER : ply.PlayerType.MPV;
    const playerPath = wantPot ? getPotPlayerPath() : getMpvPlayerPath();
    if (!playerPath) {
        log.error(wantPot ? '[external-play] 无法找到 PotPlayer 路径（请在设置中指定）' : '[external-play] 无法找到 MPV 路径');
        return;
    }

    const fnapi = new fn.ApiService(config.domain, config.token || '');
    const itemGuid = req.kind === 'file' ? ('file://' + link) : ('url://' + link);
    const title = req.title || (req.kind === 'file' ? path.basename(link) : link);
    const playList: ply.PlayItem[] = [{
        itemGuid, title, tvTitle: '', seasonNumber: 0, episodeNumber: 0,
        ts: 0, duration: 0, playLink: link, rawLink: true,
    }];

    // 复用「抢占 / 原地切换 + 创建 + 播放」逻辑（与 handlePlayMovie 一致）
    if (currentPlayer && currentPlayer.isPlaying()) {
        if (wantPot && currentPlayer instanceof ply.PotPlayer) {
            try {
                const ok = await currentPlayer.switchTo(playList, 0);
                if (ok) { log.info('[external-play] PotPlayer 原地切换到外部文件/URL'); return; }
            } catch (e: any) { log.warn('[external-play] 原地切换失败:', e?.message || e); }
        }
        currentPlayer.stop();
        currentPlayer = null;
    }
    const playerInstance = ply.PlayerFactory.createPlayer(playerType, {
        fnapi, playerPath,
        extraArgs: wantPot ? [] : MPV_NETWORK_ARGS,
        debug: true, onEvent: eventHandler(fnapi),
    } as ply.Config);
    currentPlayer = playerInstance;
    playerInstance.playList(playList, 0);
}

// 生成代理URL
function getProxyUrl(cfg: fnConfig.Config, itemGuid: string, sourceIndex: number = 0): string {
    const skipVerify = isTrusted(cfg.domain || '') ? '1' : '0';
    const useNasLocal = cfg.nasProxyEnabled === true ? '1' : '0';
    // urlencode
    const domain = escape(cfg.domain || '');
    // [lc-295] 把 persist:fntv 会话 Cookie 经查询参数传给 Go 代理(MPV/PotPlayer 链路均经此 URL),
    // 由代理注入 NAS 请求鉴权; 为空(未登录/登录中)时退化为不带 cookie(原行为)。
    const cookieParam = cachedSessionCookie ? `&cookie=${encodeURIComponent(cachedSessionCookie)}` : '';
    // const skipVerify = '1'; // 永远跳过证书验证
    return `http://127.0.0.1:22346/api/v1/playvideo/${itemGuid}?token=${cfg.token}&skipVerify=${skipVerify}&account=${cfg.account}&domain=${domain}&useNasLocal=${useNasLocal}&sourceIndex=${sourceIndex}${cookieParam}`;
}

// 处理当前播放的媒体信息
function processEpisodeMedia(cfg: fnConfig.Config, info: fn.PlayListItem): ply.PlayItem {
    return {
        itemGuid: info.guid,
        title: info.title,
        tvTitle: info.tv_title,
        seasonNumber: info.season_number,
        episodeNumber: info.episode_number,
        // [续播修复] fnOS 的 episode/list 返回每集的 ts 往往未被回填观看进度(只有 watched 标记)，
        // 故优先用 info.ts；若其为 0 再用兼容字段 watched_ts 兜底，避免续播点丢失。
        ts: info.ts > 0 ? info.ts : (info.watched_ts || 0),
        duration: info.duration,
        playLink: getProxyUrl(cfg, info.guid),
        trimId: info.trim_id,
        type: info.type,
    };
}

// 处理单个待播放媒体信息
// [lc-630] 防御: 电视直播(Live)等类型的 play/info 返回的 item 可能为 null 或字段不全
// (直播无刮削元数据), 用 info 顶层字段兜底, 避免 info.item.title 抛 TypeError 导致播放静默失败。
// [lc-631] 直播(LiveChannel)特殊处理: play/info 返回 live_channels[].path(如
//   http://192.168.31.170:1905/{streamId}, 网关 302 → 外部 CDN HLS m3u8)。
//   直播不走 Go 代理 playvideo(Go 代理对直播 500 失败, 见 playvideo.go:91 获取播放信息失败),
//   MPV/PotPlayer 直接播 path 即可。选第一条 can_play=1 的线路。
function processSingleMedia(cfg: fnConfig.Config, info: fn.PlayInfo): ply.PlayItem {
    const it: any = (info && info.item) || {};
    // [lc-631] 直播: 优先用 live_channels 可播线路的 path 作为播放链接
    let playLink = getProxyUrl(cfg, info.guid);
    let rawLink = false;
    const chans = (info && info.live_channels) || [];
    if (chans.length > 0) {
        const usable = chans.find((c) => (c.can_play === undefined || c.can_play === 1) && c.path) || chans[0];
        if (usable && usable.path) {
            playLink = usable.path;
            rawLink = true; // [lc-632] 直播: 直链(1905 网关 + 外部 CDN m3u8)绕过 PotPlayer shim 反代
            log.info(`[lc-631] 直播线路: ${usable.file_name || '线路'} → ${String(usable.path).substring(0, 90)}`);
        }
    }
    return {
        itemGuid: info.guid,
        title: it.title || it.name || '',
        tvTitle: it.tv_title || '',
        seasonNumber: it.season_number || 0,
        episodeNumber: it.episode_number || 0,
        ts: info.ts || 0,
        duration: it.duration || 0,
        playLink,
        rawLink,
        trimId: it.trim_id || '',
        type: it.type || info.type || '',
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
    registerHandler('external-play', handleExternalPlay);
    // [lc-655] 手柄/远程控制统一入口：转发到 controlCurrentPlayer(action)
    registerHandler('media:control', handleMediaControl, { useHandle: true });

    registerAppHook('beforeQuit', handleBeforeQuit);

    // 异步预准备内置 PotPlayer 的隔离副本（首次复制 209MB，避免播放时阻塞）
    setImmediate(prepareBundledPotPlayer);
}

/**
 * [lc-655] 手柄/远程控制 IPC：media:control <action> → controlCurrentPlayer(action)。
 * 白名单校验 action，防止任意字符串注入播放器命令。
 */
const CONTROL_ACTIONS: ply.PlayerControlAction[] = [
    'playpause', 'play', 'pause', 'seek-back', 'seek-fwd',
    'speed-up', 'speed-down', 'next', 'prev', 'stop',
];
async function handleMediaControl(_event: any, action: string): Promise<{ ok: boolean; handled?: boolean }> {
    if (!CONTROL_ACTIONS.includes(action as ply.PlayerControlAction)) {
        log.warn(`[media:control] 非法动作: ${action}`);
        return { ok: false };
    }
    const handled = controlCurrentPlayer(action as ply.PlayerControlAction);
    return { ok: true, handled };
}

/**
 * 统一控制当前播放器（全局快捷键/远程控制入口）。
 * 转发到 currentPlayer.control(action)；无播放器在播时返回 false。
 */
export function controlCurrentPlayer(action: ply.PlayerControlAction): boolean {
    if (!currentPlayer || !currentPlayer.isPlaying()) {
        log.warn(`[controlCurrentPlayer] 当前无播放器在播，忽略动作: ${action}`);
        return false;
    }
    try {
        return currentPlayer.control(action);
    } catch (e: any) {
        log.warn(`[controlCurrentPlayer] 动作 ${action} 失败:`, e?.message || e);
        return false;
    }
}

export {
    init
};
