import * as fs from 'fs';
import * as path from 'node:path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { USER_DATA_PATH } from '../../public/constants';

const HISTORY_LIMIT = 5;
const ENCRYPTION_KEY = 'U2XDcFsV6rdTE9wB5ZHvy6BW9hBTKJ1H'; // 32 chars for aes-256
const IV = Buffer.alloc(16, 0); // Initialization vector

// userData 覆盖策略：
//  - 开发模式(unpackaged, 即 `npx electron .` / dev.cmd)：使用独立的 .fntv-dev 目录，
//    与已安装的生产版本完全隔离(配置/缓存/日志互不干扰)。
//  - 生产模式(packaged, 即安装后的 Fntv-Plus.exe)：使用 Electron 默认目录
//    (AppData/Roaming/Fntv-Plus)。
// 关键点：开发版与生产版必须位于【不同】的 userData，否则二者共用同一单实例锁，
//         运行 dev.cmd 时会被已安装的 Fntv-Plus.exe 接管(表现为「打开的是已安装版」)。
// 历史兼容：早期版本曾把生产版也指向 .fntv-dev，这里做一次迁移，
//          把 .fntv-dev 里的真实用户配置搬到生产默认目录，避免老用户登录/同步配置丢失。
const DEV_USER_DATA = USER_DATA_PATH;
const PROD_USER_DATA = app.getPath('userData'); // 默认 AppData/Roaming/Fntv-Plus

if (app.isPackaged) {
    // 生产模式：以默认目录为准；若默认目录尚无配置而 .fntv-dev 有，则迁移过去
    migrateLegacyUserData(DEV_USER_DATA, PROD_USER_DATA);
} else {
    app.setPath('userData', DEV_USER_DATA);
}
/**
 * 【lc-418】迁移彻底作废，原地置为无操作。
 *
 * 历史背景：早期版本曾把生产配置误存到 .fntv-dev，这段代码本意是把那份配置"搬回"生产目录。
 * 但当前架构下 .fntv-dev 已经是【开发版的永久专属 userData】（dev/生产严格隔离，否则会被单实例锁接管），
 * 它里面装的是开发版自己的配置，绝不是"该迁移给生产版的旧数据"。
 *
 * 惨痛教训：即便 lc-417 把 rename 改成 copy，只要【已安装的旧二进制】仍带着 rename 版本，
 * 用户每次打开安装版都会把开发版 .fntv-dev 整目录改名搬走 → 开发版配置清零、开关/账号全丢。
 * 所以这里直接 no-op：开发版的 .fntv-dev 永不被读取/移动/复制，彻底斩断"安装版偷开发版配置"的链路。
 * 任何「把 .fntv-dev 内容并入生产目录」的需求都不再成立（二者本就该独立）。
 */
function migrateLegacyUserData(_legacy: string, _target: string): void {
    // 故意空实现：.fntv-dev 是开发版永久家目录，禁止任何迁移/搬动。
}

/**
 * 配置接口
 */
export interface Config {
    account?: string;
    domain?: string;
    token?: string;
    useHttps?: boolean;
    loginType?: 'fnid' | 'normal';
    history?: HistoryItem[];
    downloadProxyEnabled?: boolean;
    downloadProxy?: string;
    // 全局自定义 HTTP/HTTPS 代理（让 Bangumi 每日放送、TMDB 等走用户自建代理入口）
    // 区别于 downloadProxy（仅 ghfast.top 下载加速）与 tmdbDirectConnect（DNS 覆盖式免梯子直连）
    customProxyEnabled?: boolean;
    customProxy?: string;
    hideOriginalPlayButton?: boolean;
    macCloseAction?: 'minimize' | 'quit' | 'ask';
    trayNotificationShown?: boolean;
    nasProxyEnabled?: boolean;
    mpvPlayerPath?: string;
    potPlayerPath?: string;
    defaultPlayer?: 'mpv' | 'potplayer';
    exitMode?: 'direct' | 'minimize' | 'ask';
    // MPV 默认着色器预设 key（由应用「设置面板 > 播放器 > 默认 MPV 着色器」管理）
    // 'off' | 'a' | 'b' | 'aa' | 'bb' | 'lite' | 'denoise' | 'real' | 'cinema' | 'ultra'
    mpvDefaultShader?: string;
    // MPV 默认 ICC 校色开关（默认开启，固化到 mpv-user.conf）
    mpvIccEnabled?: boolean;
    // 豆瓣同步总开关（影视进度同步到豆瓣"在看/看过"）
    doubanSyncEnabled?: boolean;
    // 豆瓣登录态 Cookie（AES-256 加密存储；含 dbcl2/ck/bid 等）
    doubanCookie?: string;
    // 已观看列表→豆瓣"看过" 的自动同步间隔（分钟，0 或缺失=关闭；下限 10 分钟）
    doubanWatchedScanIntervalMin?: number;
    // 调试日志总开关：开=按组件显示详细日志(INFO/DEBUG)；关=控制台仅显示 WARN/ERROR
    debugEnabled?: boolean;
    // 各组件日志开关（仅当 debugEnabled 为 true 时生效）：组件 key -> 是否显示
    // key 取值：douban(豆瓣同步) / subtitle(字幕) / danmaku(B站弹幕) / mpv(MPV) / potplayer(PotPlayer) / media(播放器/媒体) / embywall(EmbyWall 墙渲染日志)
    debugComponents?: Record<string, boolean>;
    // Bangumi Access Token（明文存于本地 config.json；用于 Bangumi 关联/同步）
    bangumiToken?: string;
    // TMDB API Key / Read Access Token（明文存于本地 config.json；用于「热门剧更新」TMDB 数据源；默认空，由用户各自填写）
    tmdbApiKey?: string;
    // TMDB 免梯子直连开关（实验）：开启后用固定 IP 覆盖 DNS 解析，绕过污染直连 TMDB，无需梯子
    tmdbDirectConnect?: boolean;
    // [lc-474] 已应用的热补丁版本号（由「一键应用补丁」写入，用于判定是否有更新的补丁可拉取）
    appliedPatchVersion?: string;
    // [lc-520] 应用补丁时的安装包签名（可执行文件 mtime）：用于启动对账——若安装包被重装/升级(签名变化)，
    // 旧补丁覆盖层已失效，应清除以回退到安装包真实版本，避免"覆盖安装官方版仍显示旧 hotfix 版本"。
    appliedPatchSignature?: string;
    // [lc-634] 开发者「版号切换」自定义版本号（设置-通用-检查更新-版号切换，需解锁码 ydmy007）。
    // 非空时整个软件版本号/更新检测 baseline 都优先用它（用于测试更新检测、覆盖安装等）。
    // 空/undefined = 使用安装包真实版本(app.getVersion())。
    customVersion?: string;
    // TMDB 免梯子直连自定义 IP（可选覆盖内置快照）：api=api.themoviedb.org，img=image.tmdb.org
    tmdbDirectIp?: { api?: string; img?: string };
    // TMDB 免梯子直连 IP 上次更新时间戳（ms，自动/手动更新都会写入）：用于每日自动跟随 CheckTMDB 刷新判断
    tmdbDirectIpUpdatedAt?: number;
    // 「热门剧更新」数据源：'tmdb'（需 Key，海外站）/ 'douban'（免 Key，国内直连）。默认 'douban'
    hotSource?: 'tmdb' | 'douban';
    // Bangumi 集数级同步开关（观看进度达阈值时把该集标为 Bangumi「看过」）
    bangumiSyncEnabled?: boolean;
    // Bangumi 同步阈值百分比（0-100，默认 80）：播放进度达此比例才标记该集看过
    bangumiSyncThreshold?: number;
    mpvBiliSearchEnabled?: boolean;
    // 智能跳过片头片尾总开关（默认关闭：仅显示「跳过」按钮，不自动跳；开启后自动跳过）
    smartSkipEnabled?: boolean;
    traktScrobbleEnabled?: boolean;
    // B站弹幕聚合阈值（默认 1500）：单个视频弹幕数 >= 此值时直接用单源(弹幕最多者)，否则合并多个单集有效候选
    mpvBiliAggregateThreshold?: number;
    // [lc-1018] 弹弹play 开放 API 自定义凭证（两项都非空才启用；写入 script-opts/uosc_danmaku.conf。
    // 留空=脚本内置共享凭证——该共享凭证已被官方接口 403，仅作向后兼容保留）
    dandanplayAppId?: string;
    dandanplayAppSecret?: string;
    // 详情页「选集/演职人员/剧集卡片」玻璃背景框开关（默认关闭=保留背景框，与原版一致）
    detailBoxless?: boolean;
    // [lc-1014] 硬件加速开关（默认开启=true）：关闭时 app.disableHardwareAcceleration() 走软件合成，
    // 老核显/驱动异常机器的兜底；改动需重启应用生效（主进程启动期读 config 挂 GPU 开关）
    hwAccelEnabled?: boolean;
    // [lc-1014] 性能模式（默认关闭）：低配机兜底——渲染层 html.fnos-perf 总闸全局压动画/关磨砂，
    // pageAnim 入场/veil 过渡等 JS 动画路径查此类早退；即时生效无需重启
    perfModeEnabled?: boolean;
    // 鼠标滚轮横向滚动开关（默认开启=true：竖向滚轮在横向容器内转为左右滑动；
    // 关闭=false：恢复飞牛原生——鼠标只管上下滚动，横向靠左右箭头键/滚动条）
    wheelHScroll?: boolean;
    // 轮播图标题替换为 TMDB 透明 Logo 开关（默认开启=true：用 logo 图替换右侧文字标题；
    // false=保留文字标题）
    carouselLogoEnabled?: boolean;
    // ===== B站弹幕样式与过滤（写入 script-opts/uosc_danmaku.conf）=====
    biliDanmakuOpacity?: number;     // 透明度 0-1（默认 0.7）
    biliDanmakuFontSize?: number;    // 字号（默认 50）
    biliDanmakuOutline?: number;     // 描边 0-4（默认 1.0）
    biliDanmakuShadow?: number;      // 阴影（默认 0）
    biliDanmakuBold?: boolean;       // 粗体（默认 true）
    biliDanmakuDisplayArea?: number; // 显示区域 0-1（默认 0.85）
    biliDanmakuMaxScreen?: number;   // 同屏最大弹幕数 0=不限（默认 0）
    biliDanmakuBlacklist?: string;   // 屏蔽词（换行分隔，支持正则），写入 blacklist.txt
    biliDanmakuBlockTypes?: string[]; // 弹幕屏蔽类型（key: top/bottom/scroll/reverse/advanced/color），写入 danmaku_block_types.json
    // [lc-486] MPV 插帧（AI 补帧）设置：写入 script-opts/fntv_interp.conf 供 fntv_interp.lua 读取
    mpvInterpEnabled?: boolean;      // 默认开启插帧（启动即生效）
    mpvInterpEngine?: 'auto' | 'svp' | 'rife' | 'builtin' | 'nvidia'; // 插帧引擎
    mpvInterpEnginePath?: string;    // 引擎路径（SVP 目录 / rife-ncnn-vulkan 可执行文件路径）
    // 自定义登录页背景图路径（留空=使用默认 resource/login/image/bg-login.webp）
    loginBgPath?: string;
    // 用户点击「稍后提醒/应用补丁/下载」后不再自动弹窗更新的时间戳（毫秒）；缺失/0=未设置（每次启动都弹）
    // 热补丁(hotfix)使用此字段，免打扰 1 天
    updateDismissedAt?: number;
    // 全量包(full)专用免打扰时间戳；免打扰 7 天，与热补丁分开计，避免下载全量后热补丁也被长期屏蔽
    fullUpdateDismissedAt?: number;
    // fnOS 系统桌面地址（含端口）：点「切换系统页面」时跳转的目标。
    // 留空=自动，用当前 TV 连接的 origin 根路径（同端口场景）；
    // 若系统 Web 端口与媒体端口不同（每人各异），用户在此填完整地址如 https://192.168.1.50:5666
    systemPageUrl?: string;
}

/**
 * 历史记录项接口
 */
export interface HistoryItem {
    domain: string;
    account: string;
    password: string;
    useHttps?: boolean;
    loginType?: 'fnid' | 'normal';
    fnId?: string;
}

/**
 * 保存配置参数接口
 */
export interface SaveConfigParams {
    account: string;
    domain: string;
    token: string;
    useHttps?: boolean;
    loginType?: 'fnid' | 'normal';
}

/**
 * 添加历史记录参数接口
 */
export interface AddHistoryParams {
    domain: string;
    account: string;
    password: string;
    useHttps?: boolean;
    loginType?: 'fnid' | 'normal';
    fnId?: string;
}

/**
 * 删除历史记录参数接口
 */
export interface DeleteHistoryParams {
    domain: string;
    account: string;
}

/**
 * 下载代理配置接口
 */
export interface DownloadProxyConfig {
    enabled: boolean;
    proxyUrl: string;
}

/**
 * 设置下载代理配置参数接口
 */
export interface SetDownloadProxyConfigParams {
    enabled?: boolean;
    proxyUrl?: string;
}

export function getConfigPath(): string {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'config.json');
}

// 加密密码
function encrypt(text: string): string {
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), IV);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

// 解密密码
function decrypt(encrypted: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), IV);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// 读取配置
export function readConfig(): Config | null {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf-8')) as Config;
        } catch {
            return null;
        }
    }
    // 兼容兜底: lc-091 把 userData 拆分为「开发(.fntv-dev) / 生产(AppData/Roaming/fntv)」两套,
    // 若当前 userData 下没有配置, 尝试从另一个隔离目录读取, 避免登录配置"丢失"
    // 导致白屏/被强制跳回登录页(尤其开发版与生产版共用同一 fnOS 账号时)。
    try {
        const alt = path.join(DEV_USER_DATA, 'config.json');
        if (fs.existsSync(alt)) {
            return JSON.parse(fs.readFileSync(alt, 'utf-8')) as Config;
        }
    } catch { /* ignore */ }
    return null;
}

// 保存配置（账号、域名、token、HTTPS设置）
export function saveConfig({ account, domain, token, useHttps, loginType }: SaveConfigParams): void {
    const config: Config = readConfig() || {};
    config.account = account;
    config.domain = domain;
    config.token = token;
    config.useHttps = useHttps || false;
    if (loginType) config.loginType = loginType;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-474] 读取已应用的热补丁版本号
export function getAppliedPatchVersion(): string {
    const config = readConfig();
    return (config && config.appliedPatchVersion) || '';
}

// [lc-474] 写入已应用的热补丁版本号（合并写入，不动其它配置字段）
export function setAppliedPatchVersion(version: string): void {
    const config: Config = readConfig() || {};
    config.appliedPatchVersion = version;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-520] 读取/写入应用补丁时的安装包签名（用于启动对账识别重装/升级）
export function getAppliedPatchSignature(): string {
    const config = readConfig();
    return (config && config.appliedPatchSignature) || '';
}

export function setAppliedPatchSignature(signature: string): void {
    const config: Config = readConfig() || {};
    config.appliedPatchSignature = signature;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-634] 读取/写入开发者自定义版本号（设置-通用-检查更新-版号切换，需解锁码）
// 非空时更新检测 baseline / 版本显示优先用它；空 = 恢复安装包真实版本
export function getCustomVersion(): string {
    const config = readConfig();
    return (config && config.customVersion) || '';
}

export function setCustomVersion(version: string): void {
    const config: Config = readConfig() || {};
    if (version && String(version).trim()) {
        config.customVersion = String(version).trim();
    } else {
        delete config.customVersion; // 空值 = 清除恢复默认
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-661] 读取 package.json 的 appDisplayVersion（一键构建时写入）。
// 形如 3.4.1-full / 3.4.1-hotfix / 3.4.1（无后缀）；用作「应用内版本显示」与「更新检测基线」。
// 区别于 package.json.version（始终干净 x.y.z，作产物安装包版本与 git tag）。
// 存量旧包无此字段 → 返回 ''，调用方回退 app.getVersion()。
export function getAppDisplayVersion(): string {
    try {
        const pkgPath = path.join(app.getAppPath(), 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const v = pkg && pkg.appDisplayVersion;
        return (typeof v === 'string' && v.trim()) ? v.trim() : '';
    } catch {
        return '';
    }
}

// 添加历史记录（域名、账号、加密密码、HTTPS设置）
export function addHistory({ domain, account, password, useHttps, loginType, fnId }: AddHistoryParams): void {
    const config: Config = readConfig() || {};
    config.history = config.history || [];
    // 移除重复项
    config.history = config.history.filter(
        item => !(item.domain === domain && item.account === account)
    );
    // 添加新项
    const entry: HistoryItem = { domain, account, password: encrypt(password), useHttps: useHttps || false };
    if (loginType) entry.loginType = loginType;
    if (fnId) entry.fnId = fnId;
    config.history.unshift(entry);
    // 限制最多数量
    if (config.history.length > HISTORY_LIMIT) {
        config.history = config.history.slice(0, HISTORY_LIMIT);
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取历史记录（解密密码）
export function getHistory(): HistoryItem[] {
    const config: Config = readConfig() || {};
    if (!config.history) return [];
    return config.history.map(item => ({
        domain: item.domain,
        account: item.account,
        password: decrypt(item.password),
        useHttps: item.useHttps || false,
        loginType: item.loginType || undefined,
        fnId: item.fnId || undefined
    }));
}

// 清除历史记录
export function clearHistory(): void {
    const config: Config = readConfig() || {};
    config.history = [];
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 删除单个历史记录
export function deleteHistoryItem({ domain, account }: DeleteHistoryParams): boolean {
    const config: Config = readConfig() || {};
    if (!config.history) return false;
    
    const originalLength = config.history.length;
    config.history = config.history.filter(
        item => !(item.domain === domain && item.account === account)
    );
    
    if (config.history.length < originalLength) {
        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
        return true;
    }
    return false;
}

// 获取下载代理配置
export function getDownloadProxyConfig(): DownloadProxyConfig {
    const config: Config = readConfig() || {};
    return {
        enabled: config.downloadProxyEnabled !== false, // 默认开启
        proxyUrl: config.downloadProxy || 'https://ghfast.top'
    };
}

// 设置下载代理配置
export function setDownloadProxyConfig({ enabled = true, proxyUrl = 'https://ghfast.top' }: SetDownloadProxyConfigParams = {}): void {
    const config: Config = readConfig() || {};
    config.downloadProxyEnabled = enabled;
    config.downloadProxy = proxyUrl;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 全局自定义代理配置（HTTP/HTTPS 代理地址）
export interface CustomProxyConfig {
    enabled: boolean;
    proxyUrl: string;
}

// 设置自定义代理配置参数接口
export interface SetCustomProxyConfigParams {
    enabled?: boolean;
    proxyUrl?: string;
}

// 获取自定义代理配置（默认关闭；proxyUrl 留空时用空串，调用方需自行校验）
export function getCustomProxyConfig(): CustomProxyConfig {
    const config: Config = readConfig() || {};
    return {
        enabled: config.customProxyEnabled === true, // 默认关闭
        proxyUrl: (typeof config.customProxy === 'string' && config.customProxy.trim()) ? config.customProxy.trim() : ''
    };
}

// 设置自定义代理配置
export function setCustomProxyConfig({ enabled = false, proxyUrl = '' }: SetCustomProxyConfigParams = {}): void {
    const config: Config = readConfig() || {};
    config.customProxyEnabled = enabled;
    config.customProxy = (typeof proxyUrl === 'string' && proxyUrl.trim()) ? proxyUrl.trim() : '';
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取是否隐藏原有播放按钮配置
export function getHideOriginalPlayButton(): boolean {
    const config: Config = readConfig() || {};
    return config.hideOriginalPlayButton !== false; // 默认为隐藏（true）
}

// 设置是否隐藏原有播放按钮配置
export function setHideOriginalPlayButton(hide: boolean): void {
    const config: Config = readConfig() || {};
    config.hideOriginalPlayButton = hide;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-1014] 硬件加速开关（默认开启）：主进程启动期读取挂 GPU 开关；改动需重启生效
export function getHwAccelEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.hwAccelEnabled !== false; // 缺失/true = 开启
}

export function setHwAccelEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.hwAccelEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-1014] 性能模式（默认关闭）：渲染层 html.fnos-perf 总闸，即时生效
export function getPerfModeEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.perfModeEnabled === true;
}

export function setPerfModeEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.perfModeEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取NAS本地网盘代理配置
export function getNasProxyEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.nasProxyEnabled === true; // 默认关闭
}

// 设置NAS本地网盘代理配置
export function setNasProxyEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.nasProxyEnabled = enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 macOS 关闭行为偏好
export function getMacCloseAction(): 'minimize' | 'quit' | 'ask' {
    const config: Config = readConfig() || {};
    return config.macCloseAction || 'ask';
}

// 设置 macOS 关闭行为偏好
export function setMacCloseAction(action: 'minimize' | 'quit' | 'ask'): void {
    const config: Config = readConfig() || {};
    config.macCloseAction = action;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取托盘通知是否已显示过
export function getTrayNotificationShown(): boolean {
    const config: Config = readConfig() || {};
    return config.trayNotificationShown || false;
}

// 设置托盘通知已显示状态
export function setTrayNotificationShown(shown: boolean): void {
    const config: Config = readConfig() || {};
    config.trayNotificationShown = shown;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取MPV播放器路径配置
export function getMpvPlayerPath(): string | undefined {
    const config: Config = readConfig() || {};
    return config.mpvPlayerPath;
}

// 设置MPV播放器路径配置
export function setMpvPlayerPath(path: string | null): void {
    const config: Config = readConfig() || {};
    if (path === null || path === '') {
        delete config.mpvPlayerPath; // 清空配置
    } else {
        config.mpvPlayerPath = path;
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 PotPlayer 播放器路径配置
export function getPotPlayerPath(): string | undefined {
    const config: Config = readConfig() || {};
    return config.potPlayerPath;
}

// 获取自定义登录页背景图路径（留空=默认背景）
export function getLoginBgPath(): string {
    const config: Config = readConfig() || {};
    return config.loginBgPath || '';
}

// 设置自定义登录页背景图路径（空字符串=恢复默认）
export function setLoginBgPath(p: string): void {
    const config: Config = readConfig() || {};
    if (!p) {
        delete config.loginBgPath;
    } else {
        config.loginBgPath = p;
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 设置 PotPlayer 播放器路径配置
export function setPotPlayerPath(path: string | null): void {
    const config: Config = readConfig() || {};
    if (path === null || path === '') {
        delete config.potPlayerPath; // 清空配置
    } else {
        config.potPlayerPath = path;
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取默认播放器（直接播放时使用的外置/内置播放器）
export function getDefaultPlayer(): 'mpv' | 'potplayer' {
    const config: Config = readConfig() || {};
    return config.defaultPlayer === 'potplayer' ? 'potplayer' : 'mpv';
}

// 设置默认播放器
export function setDefaultPlayer(player: 'mpv' | 'potplayer'): void {
    const config: Config = readConfig() || {};
    config.defaultPlayer = player === 'potplayer' ? 'potplayer' : 'mpv';
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 MPV 默认着色器预设 key（'off' 表示不启用任何着色器）
export function getMpvDefaultShader(): string {
    const config: Config = readConfig() || {};
    return config.mpvDefaultShader || 'off';
}

// 设置 MPV 默认着色器预设 key
export function setMpvDefaultShader(shader: string): void {
    const config: Config = readConfig() || {};
    if (!shader || shader === 'off') {
        config.mpvDefaultShader = 'off';
    } else {
        config.mpvDefaultShader = shader;
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 MPV 默认 ICC 校色开关（默认开启）
export function getMpvIccEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.mpvIccEnabled !== false; // 未设置视为开启
}

// 设置 MPV 默认 ICC 校色开关
export function setMpvIccEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.mpvIccEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// ===== 字幕样式 getter/setter =====
function numOr(cfg: Config, key: keyof Config, dflt: number): number {
    const v = cfg[key];
    return (typeof v === 'number' && !isNaN(v)) ? v : dflt;
}

// ===== B站弹幕样式与过滤 getter/setter =====
export function getBiliDanmakuOpacity(): number { return numOr(readConfig() || {}, 'biliDanmakuOpacity', 0.7); }
export function setBiliDanmakuOpacity(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuOpacity = Math.min(1, Math.max(0, Number(v) || 0)); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuFontSize(): number { return numOr(readConfig() || {}, 'biliDanmakuFontSize', 50); }
export function setBiliDanmakuFontSize(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuFontSize = Math.max(1, Math.round(v)); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuOutline(): number { return numOr(readConfig() || {}, 'biliDanmakuOutline', 1.0); }
export function setBiliDanmakuOutline(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuOutline = Math.max(0, Number(v) || 0); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuShadow(): number { return numOr(readConfig() || {}, 'biliDanmakuShadow', 0); }
export function setBiliDanmakuShadow(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuShadow = Math.max(0, Number(v) || 0); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuBold(): boolean { const c = readConfig() || {}; return c.biliDanmakuBold !== false; }
export function setBiliDanmakuBold(v: boolean): void {
    const c = readConfig() || {}; c.biliDanmakuBold = !!v; fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuDisplayArea(): number { return numOr(readConfig() || {}, 'biliDanmakuDisplayArea', 0.85); }
export function setBiliDanmakuDisplayArea(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuDisplayArea = Math.min(1, Math.max(0, Number(v) || 0)); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuMaxScreen(): number { return numOr(readConfig() || {}, 'biliDanmakuMaxScreen', 0); }
export function setBiliDanmakuMaxScreen(v: number): void {
    const c = readConfig() || {}; c.biliDanmakuMaxScreen = Math.max(0, Math.round(v)); fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuBlacklist(): string { const c = readConfig() || {}; return c.biliDanmakuBlacklist || ''; }
export function setBiliDanmakuBlacklist(v: string): void {
    const c = readConfig() || {}; c.biliDanmakuBlacklist = v || ''; fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}
export function getBiliDanmakuBlockTypes(): string[] { const c = readConfig() || {}; return Array.isArray(c.biliDanmakuBlockTypes) ? c.biliDanmakuBlockTypes : []; }
export function setBiliDanmakuBlockTypes(v: string[]): void {
    const c = readConfig() || {}; c.biliDanmakuBlockTypes = Array.isArray(v) ? v : []; fs.writeFileSync(getConfigPath(), JSON.stringify(c, null, 2));
}

// 向后兼容的函数
export function getDownloadProxyUrl(): string {
    return getDownloadProxyConfig().proxyUrl;
}

export function setDownloadProxyUrl(proxyUrl: string): void {
    const current = getDownloadProxyConfig();
    setDownloadProxyConfig({ enabled: current.enabled, proxyUrl });
}

export function getExitMode(): 'direct' | 'minimize' | 'ask' {
    const config = readConfig();
    return config?.exitMode ?? 'ask';
}

export function setExitMode(mode: 'direct' | 'minimize' | 'ask'): void {
    const config = readConfig() ?? {};
    const updatedConfig = {
        ...config,
        exitMode: mode
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(updatedConfig, null, 2));
}

// 获取豆瓣同步总开关（默认关闭）
export function getDoubanSyncEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.doubanSyncEnabled === true;
}

// 设置豆瓣同步总开关
export function setDoubanSyncEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.doubanSyncEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取豆瓣登录态 Cookie（解密后的原始 cookie 字符串，未登录返回 null）
export function getDoubanCookie(): string | null {
    const config: Config = readConfig() || {};
    if (!config.doubanCookie) return null;
    try {
        return decrypt(config.doubanCookie);
    } catch {
        return null;
    }
}

// 设置/清除豆瓣登录态 Cookie（传 null/空串即清除）
export function setDoubanCookie(cookie: string | null): void {
    const config: Config = readConfig() || {};
    if (!cookie) {
        delete config.doubanCookie;
    } else {
        config.doubanCookie = encrypt(cookie);
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取"已观看列表→豆瓣看过"自动同步间隔（分钟），默认 0=关闭
export function getWatchedScanIntervalMin(): number {
    const config: Config = readConfig() || {};
    const v = Number(config.doubanWatchedScanIntervalMin);
    if (!isFinite(v) || v <= 0) return 0;
    return v;
}

// 设置自动同步间隔（分钟），<=0 表示关闭
export function setWatchedScanIntervalMin(min: number): void {
    const config: Config = readConfig() || {};
    config.doubanWatchedScanIntervalMin = Math.max(0, Math.floor(Number(min) || 0));
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取调试日志总开关（默认关闭 → 控制台只显示 WARN/ERROR）
export function getDebugEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.debugEnabled === true;
}

// 设置调试日志总开关
export function setDebugEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.debugEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取各组件日志开关（未设置返回空对象，调用方按"默认开启"处理）
export function getDebugComponents(): Record<string, boolean> {
    const config: Config = readConfig() || {};
    return config.debugComponents || {};
}

// 设置各组件日志开关
export function setDebugComponents(components: Record<string, boolean>): void {
    const config: Config = readConfig() || {};
    config.debugComponents = components || {};
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 Bangumi Access Token（未设置返回 null）
export function getBangumiToken(): string | null {
    const config: Config = readConfig() || {};
    return config.bangumiToken ? config.bangumiToken : null;
}

// 设置/清除 Bangumi Access Token（传 null/空串即清除）
export function setBangumiToken(token: string | null): void {
    const config: Config = readConfig() || {};
    if (!token) {
        delete config.bangumiToken;
    } else {
        config.bangumiToken = token.trim();
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 TMDB API Key / Read Access Token（未设置返回 null）
export function getTmdbApiKey(): string | null {
    const config: Config = readConfig() || {};
    return config.tmdbApiKey ? config.tmdbApiKey : null;
}

// 设置/清除 TMDB API Key（传 null/空串即清除）。支持 v3 api_key 与 v4 JWT Read Access Token 两种格式
export function setTmdbApiKey(key: string | null): void {
    const config: Config = readConfig() || {};
    if (!key) {
        delete config.tmdbApiKey;
    } else {
        config.tmdbApiKey = key.trim();
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 TMDB 免梯子直连开关（默认 false）
export function getTmdbDirectConnect(): boolean {
    const config: Config = readConfig() || {};
    return !!config.tmdbDirectConnect;
}

// 设置 TMDB 免梯子直连开关
export function setTmdbDirectConnect(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.tmdbDirectConnect = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 TMDB 免梯子直连自定义 IP（未设置返回 null，回退内置快照）
export function getTmdbDirectIp(): { api?: string; img?: string } | null {
    const config: Config = readConfig() || {};
    return config.tmdbDirectIp ? config.tmdbDirectIp : null;
}

// 设置/清除 TMDB 免梯子直连自定义 IP（传 null 或空即清除，回退内置快照）
export function setTmdbDirectIp(ip: { api?: string; img?: string } | null): void {
    const config: Config = readConfig() || {};
    if (!ip || (!ip.api && !ip.img)) {
        delete config.tmdbDirectIp;
    } else {
        config.tmdbDirectIp = { api: ip.api ? ip.api.trim() : undefined, img: ip.img ? ip.img.trim() : undefined };
    }
    // 无论手动还是自动更新 IP，都记录时间戳（用于每日自动刷新判断 / 避免重复覆盖手动值）
    if (config.tmdbDirectIp) {
        config.tmdbDirectIpUpdatedAt = Date.now();
    } else {
        delete config.tmdbDirectIpUpdatedAt;
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 TMDB 直连 IP 上次更新时间戳（ms）；从未更新过返回 0
export function getTmdbDirectIpUpdatedAt(): number {
    const config: Config = readConfig() || {};
    return typeof config.tmdbDirectIpUpdatedAt === 'number' ? config.tmdbDirectIpUpdatedAt : 0;
}

// 获取「热门剧更新」数据源（默认 'douban'：国内直连、免 Key、零配置）
export function getHotSource(): 'tmdb' | 'douban' {
    const config: Config = readConfig() || {};
    return config.hotSource === 'tmdb' ? 'tmdb' : 'douban';
}

// 设置「热门剧更新」数据源（'tmdb' / 'douban'）
export function setHotSource(s: 'tmdb' | 'douban'): void {
    const config: Config = readConfig() || {};
    config.hotSource = s === 'tmdb' ? 'tmdb' : 'douban';
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 Bangumi 同步开关
export function getBangumiSyncEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.bangumiSyncEnabled === true;
}

// 设置 Bangumi 同步开关
export function setBangumiSyncEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.bangumiSyncEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 Bangumi 同步阈值百分比（默认 80）
export function getBangumiSyncThreshold(): number {
    const config: Config = readConfig() || {};
    const t = config.bangumiSyncThreshold;
    if (typeof t === 'number' && t > 0 && t <= 100) return t;
    return 80;
}

// 设置 Bangumi 同步阈值百分比
export function setBangumiSyncThreshold(threshold: number): void {
    const config: Config = readConfig() || {};
    const t = Math.round(threshold);
    config.bangumiSyncThreshold = (t > 0 && t <= 100) ? t : 80;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 MPV B站弹幕搜索开关（默认开启）
export function getMpvBiliSearchEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.mpvBiliSearchEnabled !== false; // 未设置视为开启
}

// 设置 MPV B站弹幕搜索开关
export function setMpvBiliSearchEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.mpvBiliSearchEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-486] 获取 MPV 插帧（AI 补帧）设置（默认：关 / auto / 空路径）
export function getMpvInterpEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.mpvInterpEnabled === true; // 未设置视为关
}
export function getMpvInterpEngine(): 'auto' | 'svp' | 'rife' | 'builtin' | 'nvidia' {
    const config: Config = readConfig() || {};
    const e = config.mpvInterpEngine;
    if (e === 'svp' || e === 'rife' || e === 'builtin' || e === 'auto' || e === 'nvidia') return e;
    return 'auto';
}
export function getMpvInterpEnginePath(): string {
    const config: Config = readConfig() || {};
    return typeof config.mpvInterpEnginePath === 'string' ? config.mpvInterpEnginePath : '';
}
export function setMpvInterpEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.mpvInterpEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
export function setMpvInterpEngine(engine: 'auto' | 'svp' | 'rife' | 'builtin' | 'nvidia'): void {
    const config: Config = readConfig() || {};
    if (engine === 'svp' || engine === 'rife' || engine === 'builtin' || engine === 'auto' || engine === 'nvidia') {
        config.mpvInterpEngine = engine;
    } else {
        config.mpvInterpEngine = 'auto';
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
export function setMpvInterpEnginePath(p: string): void {
    const config: Config = readConfig() || {};
    config.mpvInterpEnginePath = typeof p === 'string' ? p : '';
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「B站弹幕聚合阈值」（默认 1500；<=0 表示禁用聚合）
export function getMpvBiliAggregateThreshold(): number {
    const config: Config = readConfig() || {};
    return typeof config.mpvBiliAggregateThreshold === 'number' ? config.mpvBiliAggregateThreshold : 1500;
}

// 设置「B站弹幕聚合阈值」
export function setMpvBiliAggregateThreshold(threshold: number): void {
    const config: Config = readConfig() || {};
    config.mpvBiliAggregateThreshold = Number(threshold) || 0;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// [lc-1018] 获取弹弹play 开放 API 自定义凭证（默认空串=用脚本内置共享凭证）
export function getDandanplayAppId(): string {
    const config: Config = readConfig() || {};
    return typeof config.dandanplayAppId === 'string' ? config.dandanplayAppId : '';
}
export function getDandanplayAppSecret(): string {
    const config: Config = readConfig() || {};
    return typeof config.dandanplayAppSecret === 'string' ? config.dandanplayAppSecret : '';
}

// [lc-1018] 设置弹弹play 自定义凭证（两项都 trim；任一为空视为清除，Lua 端回落内置共享凭证）
export function setDandanplayCredentials(appId: string, appSecret: string): void {
    const config: Config = readConfig() || {};
    config.dandanplayAppId = String(appId || '').trim();
    config.dandanplayAppSecret = String(appSecret || '').trim();
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「智能跳过片头片尾」总开关（默认关闭=false：仅显示按钮不自动跳）
export function getSmartSkipEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.smartSkipEnabled === true;
}

// 设置「智能跳过片头片尾」总开关
export function setSmartSkipEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.smartSkipEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
// 获取「Trakt 实时 scrobble」开关（[lc-1064] 未设置时默认开启）
export function getTraktScrobbleEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.traktScrobbleEnabled !== false;
}

// 设置「Trakt 实时 scrobble」开关
export function setTraktScrobbleEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.traktScrobbleEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「关闭详情页背景框」开关（默认关闭=false，保留玻璃背景框）
export function getDetailBoxless(): boolean {
    const config: Config = readConfig() || {};
    return config.detailBoxless === true; // 默认关闭
}

// 设置「关闭详情页背景框」开关
export function setDetailBoxless(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.detailBoxless = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「鼠标滚轮横向滚动」开关（默认关闭=false，恢复飞牛原生上下滚动）
export function getWheelHScroll(): boolean {
    const config: Config = readConfig() || {};
    // 字段缺失时默认为关闭（=false），只有显式 true 才开启鼠标横向滚动
    return config.wheelHScroll === true;
}

// 设置「鼠标滚轮横向滚动」开关
export function setWheelHScroll(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.wheelHScroll = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「轮播图标题替换为 TMDB 透明 Logo」开关（默认开启=true，与既有视觉一致；false=保留文字标题）
export function getCarouselLogoEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.carouselLogoEnabled !== false; // 默认开启
}

// 设置「轮播图标题替换为 TMDB 透明 Logo」开关
export function setCarouselLogoEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.carouselLogoEnabled = !!enabled;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「更新已打烊」时间戳（用户点过「立即下载」后 7 天内不再自动弹窗）
export function getUpdateDismissedAt(): number {
    const config: Config = readConfig() || {};
    return typeof config.updateDismissedAt === 'number' ? config.updateDismissedAt : 0;
}

// 设置「更新已打烊」时间戳（热补丁专用，免打扰 1 天）
export function setUpdateDismissedAt(ts: number): void {
    const config: Config = readConfig() || {};
    config.updateDismissedAt = ts;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取「全量包更新已打烊」时间戳（用户点过全量包「下载」/「稍后提醒」后 7 天内不再自动弹窗）
export function getFullUpdateDismissedAt(): number {
    const config: Config = readConfig() || {};
    return typeof config.fullUpdateDismissedAt === 'number' ? config.fullUpdateDismissedAt : 0;
}

// 设置「全量包更新已打烊」时间戳（全量包专用，免打扰 7 天）
export function setFullUpdateDismissedAt(ts: number): void {
    const config: Config = readConfig() || {};
    config.fullUpdateDismissedAt = ts;
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 获取 fnOS 系统桌面地址（留空=自动，用当前 TV 连接的 origin 根路径）
export function getSystemPageUrl(): string {
    const config: Config = readConfig() || {};
    return (typeof config.systemPageUrl === 'string' && config.systemPageUrl.trim()) ? config.systemPageUrl.trim() : '';
}

// 设置 fnOS 系统桌面地址（传 null/空串即恢复自动）
export function setSystemPageUrl(url: string | null): void {
    const config: Config = readConfig() || {};
    if (!url || !url.trim()) {
        delete config.systemPageUrl;
    } else {
        config.systemPageUrl = url.trim();
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// CommonJS导出，确保与现有代码兼容
// 注意：使用 Object.assign 合并而非整体覆盖，避免 `export function` 声明的函数被白名单遗漏
// （之前 getCarouselLogoEnabled 用了 export function 却漏加白名单，导致 settings:get 抛
//  "is not a function"，整屏设置回落默认，表现为「配置全丢失」）
Object.assign(module.exports, {
    saveConfig,
    readConfig,
    addHistory,
    getHistory,
    clearHistory,
    deleteHistoryItem,
    getDownloadProxyUrl,
    setDownloadProxyUrl,
    getDownloadProxyConfig,
    setDownloadProxyConfig,
    getCustomProxyConfig,
    setCustomProxyConfig,
    getHideOriginalPlayButton,
    setHideOriginalPlayButton,
    getNasProxyEnabled,
    setNasProxyEnabled,
    getMacCloseAction,
    setMacCloseAction,
    getTrayNotificationShown,
    setTrayNotificationShown,
    getMpvPlayerPath,
    setMpvPlayerPath,
    getPotPlayerPath,
    setPotPlayerPath,
    getDefaultPlayer,
    setDefaultPlayer,
    getExitMode,
    setExitMode,
    getMpvDefaultShader,
    setMpvDefaultShader,
    getMpvIccEnabled,
    setMpvIccEnabled,
    getDoubanSyncEnabled,
    setDoubanSyncEnabled,
    getDoubanCookie,
    setDoubanCookie,
    getWatchedScanIntervalMin,
    setWatchedScanIntervalMin,
    getDebugEnabled,
    setDebugEnabled,
    getDebugComponents,
    setDebugComponents,
    getBangumiToken,
    setBangumiToken,
    getTmdbApiKey,
    setTmdbApiKey,
    getTmdbDirectConnect,
    setTmdbDirectConnect,
    getTmdbDirectIp,
    setTmdbDirectIp,
    getTmdbDirectIpUpdatedAt,
    getBangumiSyncEnabled,
    setBangumiSyncEnabled,
    getBangumiSyncThreshold,
    setBangumiSyncThreshold,
    getMpvBiliSearchEnabled,
    setMpvBiliSearchEnabled,
    getMpvBiliAggregateThreshold,
    setMpvBiliAggregateThreshold,
    // [lc-1018] 弹弹play 开放 API 自定义凭证
    getDandanplayAppId, getDandanplayAppSecret, setDandanplayCredentials,
    // 智能跳过片头片尾
    getSmartSkipEnabled,
    setSmartSkipEnabled,
    getTraktScrobbleEnabled,
    setTraktScrobbleEnabled,
    getDetailBoxless,
    setDetailBoxless,
    getWheelHScroll,
    setWheelHScroll,
    // B站弹幕样式与过滤
    getBiliDanmakuOpacity, setBiliDanmakuOpacity,
    getBiliDanmakuFontSize, setBiliDanmakuFontSize,
    getBiliDanmakuOutline, setBiliDanmakuOutline,
    getBiliDanmakuShadow, setBiliDanmakuShadow,
    getBiliDanmakuBold, setBiliDanmakuBold,
    getBiliDanmakuDisplayArea, setBiliDanmakuDisplayArea,
    getBiliDanmakuMaxScreen, setBiliDanmakuMaxScreen,
    getBiliDanmakuBlacklist, setBiliDanmakuBlacklist,
    getBiliDanmakuBlockTypes, setBiliDanmakuBlockTypes,
    // [lc-486] MPV 插帧（AI 补帧）
    getMpvInterpEnabled, setMpvInterpEnabled,
    getMpvInterpEngine, setMpvInterpEngine,
    getMpvInterpEnginePath, setMpvInterpEnginePath,
    // 更新打烊时间戳
    getUpdateDismissedAt, setUpdateDismissedAt, getFullUpdateDismissedAt, setFullUpdateDismissedAt,
    // 热门剧更新数据源（TMDB / 豆瓣）
    getHotSource, setHotSource,
    // 登录背景图路径
    getLoginBgPath, setLoginBgPath,
    // fnOS 系统桌面地址（切换系统页面用，留空=自动）
    getSystemPageUrl, setSystemPageUrl,
    // [lc-661] 应用内显示版本号（构建时写入 package.json.appDisplayVersion）
    getAppDisplayVersion
});
