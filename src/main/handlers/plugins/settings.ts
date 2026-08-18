import { BrowserWindow, dialog, shell, app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as fnConfig from '../../../modules/fn_config/config';
import * as proxyModule from '../../../modules/proxyAgent';
import { registerHandler } from '../core/ipcHandler';
import { getMainWindow } from '../../common/mainwin';
import { fnosDialog } from '../../common/fnosDialog';
import { getInstance as getUpdateChecker } from '../../../modules/updater/updateChecker';
import { clearAllPatches } from '../../../modules/patcher/patchApplier';
import { setMpvPlayerPath, setPotPlayerPath } from './media';
import { writeMpvUserConfig, writeBiliSearchEnabled, writeBiliAggregateThreshold, writeBiliDanmakuStyle, writeInterpConfig, getPortableConfigDir } from './mpvConfig';
import * as log from '../../../modules/logger';

/**
 * 设置面板 IPC 插件
 * 把原托盘右键菜单里的设置项迁移到侧栏"设置"按钮弹出的面板中。
 * 全部使用 ipcMain.handle（前端用 ipcRenderer.invoke 调用，可 await 返回值）。
 */

// 读取所有设置项，供前端初始化面板
async function handleGetSettings(): Promise<any> {
    return {
        downloadProxy: fnConfig.getDownloadProxyConfig(),
        // 自定义代理（让 Bangumi 每日放送、TMDB 等走用户自建代理入口；环境变量优先于它）
        customProxy: fnConfig.getCustomProxyConfig(),
        hideOriginalPlayButton: fnConfig.getHideOriginalPlayButton(),
        nasProxyEnabled: fnConfig.getNasProxyEnabled(),
        mpvPath: fnConfig.getMpvPlayerPath() || '',
        potPath: fnConfig.getPotPlayerPath() || '',
        defaultPlayer: fnConfig.getDefaultPlayer(),
        exitMode: fnConfig.getExitMode(),
        mpvDefaultShader: fnConfig.getMpvDefaultShader(),
        mpvIccEnabled: fnConfig.getMpvIccEnabled(),
        doubanSyncEnabled: fnConfig.getDoubanSyncEnabled(),
        doubanLoggedIn: !!fnConfig.getDoubanCookie(),
        debugEnabled: fnConfig.getDebugEnabled(),
        debugComponents: fnConfig.getDebugComponents(),
        bangumiToken: fnConfig.getBangumiToken(),
        tmdbApiKey: fnConfig.getTmdbApiKey(),
        tmdbDirectConnect: fnConfig.getTmdbDirectConnect(),
        tmdbDirectIp: fnConfig.getTmdbDirectIp(),
        // 热门剧更新数据源（默认 'douban'：国内直连、免 Key、零配置）
        hotSource: fnConfig.getHotSource(),
        bangumiSyncEnabled: fnConfig.getBangumiSyncEnabled(),
        bangumiSyncThreshold: fnConfig.getBangumiSyncThreshold(),
        mpvBiliSearchEnabled: fnConfig.getMpvBiliSearchEnabled(),
        mpvBiliAggregateThreshold: fnConfig.getMpvBiliAggregateThreshold(),
        detailBoxless: fnConfig.getDetailBoxless(),
        // 鼠标滚轮横向滚动开关（默认开启=true；关闭=false 恢复飞牛原生上下滚动）
        wheelHScroll: fnConfig.getWheelHScroll(),
        // 轮播图标题替换为 TMDB 透明 Logo 开关（默认开启=true；false=保留文字标题）
        carouselLogoEnabled: fnConfig.getCarouselLogoEnabled(),
        // ===== B站弹幕样式与过滤 =====
        biliDanmakuOpacity: fnConfig.getBiliDanmakuOpacity(),
        biliDanmakuFontSize: fnConfig.getBiliDanmakuFontSize(),
        biliDanmakuOutline: fnConfig.getBiliDanmakuOutline(),
        biliDanmakuShadow: fnConfig.getBiliDanmakuShadow(),
        biliDanmakuBold: fnConfig.getBiliDanmakuBold(),
        biliDanmakuDisplayArea: fnConfig.getBiliDanmakuDisplayArea(),
        biliDanmakuMaxScreen: fnConfig.getBiliDanmakuMaxScreen(),
        biliDanmakuBlacklist: fnConfig.getBiliDanmakuBlacklist(),
        biliDanmakuBlockTypes: fnConfig.getBiliDanmakuBlockTypes(),
        // 防御性兜底：若某次构建 dest 与 src 不同步导致该函数缺失，绝不能让登录页 preload 抛错白屏
        loginBg: (typeof (fnConfig as any).getLoginBgPath === 'function') ? ((fnConfig as any).getLoginBgPath() || '') : ''
    };
}

async function handleSetDownloadProxy(_event: any, enabled: boolean): Promise<void> {
    const cur = fnConfig.getDownloadProxyConfig();
    fnConfig.setDownloadProxyConfig({ enabled: !!enabled, proxyUrl: cur.proxyUrl });
    log.info('[开关保存-MAIN] downloadProxy.enabled=' + (!!enabled) + ' path=' + fnConfig.getConfigPath());
}

// 自定义代理：获取当前配置
async function handleGetCustomProxy(): Promise<any> {
    return fnConfig.getCustomProxyConfig();
}

// 自定义代理：开关 + 地址一起设置（enabled 默认 false，proxyUrl 默认空串）
async function handleSetCustomProxy(_event: any, enabled: boolean, proxyUrl?: string): Promise<void> {
    fnConfig.setCustomProxyConfig({ enabled: !!enabled, proxyUrl: (typeof proxyUrl === 'string' ? proxyUrl : '') });
}

// 自定义代理：测试连通性（不依赖已保存配置，直接拿传入的地址试连 Bangumi）
async function handleTestCustomProxy(_event: any, enabled: boolean, proxyUrl?: string): Promise<any> {
    const url = (typeof proxyUrl === 'string' ? proxyUrl : '').trim();
    if (!enabled || !url) return { ok: false, error: '未启用或未填写地址' };
    return await proxyModule.testProxyConnection(url);
}

async function handleSetHidePlay(_event: any, hide: boolean): Promise<void> {
    fnConfig.setHideOriginalPlayButton(!!hide);
    log.info('[开关保存-MAIN] hideOriginalPlayButton=' + (!!hide) + ' path=' + fnConfig.getConfigPath());
}

async function handleSetNasProxy(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setNasProxyEnabled(!!enabled);
    log.info('[开关保存-MAIN] nasProxyEnabled=' + (!!enabled) + ' path=' + fnConfig.getConfigPath());
}

async function handleSetDetailBoxless(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setDetailBoxless(!!enabled);
    log.info('[开关保存-MAIN] detailBoxless=' + (!!enabled) + ' path=' + fnConfig.getConfigPath());
}

// 鼠标滚轮横向滚动开关：开启=竖向滚轮在横向容器内转左右滑动；关闭=恢复飞牛原生（鼠标只上下滚）
async function handleSetWheelHScroll(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setWheelHScroll(!!enabled);
    log.info('[开关保存-MAIN] wheelHScroll=' + (!!enabled) + ' path=' + fnConfig.getConfigPath());
}

// 设置「轮播图标题替换为 TMDB 透明 Logo」开关（true=替换，false=保留文字标题）
async function handleSetCarouselLogoEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setCarouselLogoEnabled(!!enabled);
    log.info('轮播图标题替换为 Logo 开关 →', !!enabled);
}

// 弹出系统文件选择框，选中后写回配置并刷新 media 模块缓存
async function handlePickMpvPath(): Promise<string | null> {
    const win = getMainWindow();
    try {
        const result = await dialog.showOpenDialog(win ?? undefined, {
            title: '选择 MPV 播放器',
            properties: ['openFile'],
            filters: [
                { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : [] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            fnConfig.setMpvPlayerPath(selectedPath);
            setMpvPlayerPath(selectedPath);
            log.info(`MPV 播放器路径已设置为: ${selectedPath}`);
            return selectedPath;
        }
    } catch (error) {
        log.error('选择 MPV 路径失败:', error);
    }
    return null;
}

async function handleClearMpvPath(): Promise<void> {
    fnConfig.setMpvPlayerPath('');
    setMpvPlayerPath(null);
    log.info('MPV 播放器路径已清空，将使用自动检测');
}

// 弹出系统文件选择框，选中后写回配置并刷新 media 模块缓存
async function handlePickPotPath(): Promise<string | null> {
    const win = getMainWindow();
    try {
        const result = await dialog.showOpenDialog(win ?? undefined, {
            title: '选择 PotPlayer 播放器',
            properties: ['openFile'],
            filters: [
                { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : [] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            fnConfig.setPotPlayerPath(selectedPath);
            setPotPlayerPath(selectedPath);
            log.info(`PotPlayer 播放器路径已设置为: ${selectedPath}`);
            return selectedPath;
        }
    } catch (error) {
        log.error('选择 PotPlayer 路径失败:', error);
    }
    return null;
}

async function handleClearPotPath(): Promise<void> {
    fnConfig.setPotPlayerPath('');
    setPotPlayerPath(null);
    log.info('PotPlayer 播放器路径已清空');
}

// 把任意本地图片复制进 userData/login-bg/，返回可移植路径（不再依赖原始绝对路径，换电脑/移动文件也不会失效）
function copyLoginBgToUserData(src: string): string | null {
    try {
        const dir = path.join(app.getPath('userData'), 'login-bg');
        fs.mkdirSync(dir, { recursive: true });
        const ext = (path.extname(src) || '.jpg').toLowerCase();
        const dest = path.join(dir, 'custom' + ext);
        fs.copyFileSync(src, dest);
        return dest;
    } catch (e) {
        log.error('复制登录背景图到用户数据目录失败:', e);
        return null;
    }
}

// 弹出系统文件选择框，选择自定义登录页背景图（默认打开 resource/login/image 目录）
async function handlePickLoginBg(): Promise<string | null> {
    const win = getMainWindow();
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
    const defaultPath = path.join(base, 'resource', 'login', 'image');
    try {
        const result = await dialog.showOpenDialog(win ?? undefined, {
            title: '选择登录页背景图',
            defaultPath: fs.existsSync(defaultPath) ? defaultPath : undefined,
            properties: ['openFile'],
            filters: [
                { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            // 复制进 userData，存可移植路径（而非原始绝对路径）
            const portable = copyLoginBgToUserData(selectedPath) || selectedPath;
            fnConfig.setLoginBgPath(portable);
            log.info(`登录页背景图已设置为: ${portable}${portable !== selectedPath ? ` (源: ${selectedPath})` : ''}`);
            return portable;
        }
    } catch (error) {
        log.error('选择登录页背景图失败:', error);
    }
    return null;
}

// 手动输入路径设置登录页背景图（校验文件存在；不存在则回滚到当前已存值）
async function handleSetLoginBg(_event: any, p: string): Promise<{ ok: boolean; existing?: string }> {
    const existing = (typeof (fnConfig as any).getLoginBgPath === 'function') ? ((fnConfig as any).getLoginBgPath() || '') : '';
    const v = (p || '').trim();
    if (!v || !fs.existsSync(v)) {
        return { ok: false, existing };
    }
    // 已在 userData/login-bg 内的视为已可移植；否则先复制再存可移植路径
    const loginBgDir = path.join(app.getPath('userData'), 'login-bg');
    const portable = v.startsWith(loginBgDir) ? v : (copyLoginBgToUserData(v) || v);
    fnConfig.setLoginBgPath(portable);
    log.info(`登录页背景图已设置为: ${portable}`);
    return { ok: true };
}

// 清空登录页背景图，恢复默认（并删除已复制的自定义图）
async function handleClearLoginBg(): Promise<{ ok: boolean }> {
    const cur = (typeof (fnConfig as any).getLoginBgPath === 'function') ? ((fnConfig as any).getLoginBgPath() || '') : '';
    if (cur && cur.includes(path.join(app.getPath('userData'), 'login-bg'))) {
        try { fs.unlinkSync(cur); } catch (e) { /* 忽略删除失败 */ }
    }
    fnConfig.setLoginBgPath('');
    log.info('登录页背景图已清空，恢复默认');
    return { ok: true };
}

// 设置默认播放器（直接播放时使用）
async function handleSetDefaultPlayer(_event: any, player: 'mpv' | 'potplayer'): Promise<void> {
    fnConfig.setDefaultPlayer(player === 'potplayer' ? 'potplayer' : 'mpv');
    log.info(`默认播放器已设置为: ${player}`);
}

async function handleSetExitMode(_event: any, mode: string): Promise<void> {
    fnConfig.setExitMode(mode as 'direct' | 'minimize' | 'ask');
}

// 设置豆瓣同步总开关
async function handleSetDoubanEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setDoubanSyncEnabled(!!enabled);
    log.info(`豆瓣同步开关已设置为: ${enabled}`);
}

// 设置 Bangumi Access Token（保存/清除）
async function handleSetBangumiToken(_event: any, token: string): Promise<{ ok: boolean }> {
    fnConfig.setBangumiToken(token ? String(token) : null);
    log.info('Bangumi Access Token 已更新');
    return { ok: true };
}

// 设置 TMDB API Key / Read Access Token（保存/清除）
async function handleSetTmdbApiKey(_event: any, key: string): Promise<{ ok: boolean }> {
    fnConfig.setTmdbApiKey(key ? String(key) : null);
    log.info('TMDB API Key 已更新');
    return { ok: true };
}

// 设置 TMDB 免梯子直连开关 + 自定义 IP（与 HTTPS_PROXY 互斥，开启后用 IP 覆盖 DNS 解析）
async function handleSetTmdbDirect(_event: any, payload: { enabled?: boolean; ip?: { api?: string; img?: string } }): Promise<{ ok: boolean }> {
    if (payload && typeof payload.enabled === 'boolean') fnConfig.setTmdbDirectConnect(payload.enabled);
    if (payload && payload.ip) fnConfig.setTmdbDirectIp(payload.ip);
    log.info('TMDB 免梯子直连已更新', JSON.stringify(payload));
    return { ok: true };
}

// 「热门剧更新」数据源读写（'tmdb' / 'douban'）
async function handleGetHotSource(): Promise<'tmdb' | 'douban'> {
    return fnConfig.getHotSource();
}
async function handleSetHotSource(_event: any, source: 'tmdb' | 'douban'): Promise<{ ok: boolean }> {
    fnConfig.setHotSource(source === 'tmdb' ? 'tmdb' : 'douban');
    log.info('热门剧更新数据源 →', source);
    return { ok: true };
}

// 读取 fnOS 系统桌面地址（切换系统页面跳转目标；留空=自动）
async function handleGetSystemPageUrl(): Promise<{ url: string }> {
    return { url: fnConfig.getSystemPageUrl() };
}

// 设置 fnOS 系统桌面地址（留空/undefined/null=恢复自动）
async function handleSetSystemPageUrl(_event: any, url: string | null): Promise<{ ok: boolean }> {
    fnConfig.setSystemPageUrl(typeof url === 'string' ? url : null);
    log.info('fnOS 系统桌面地址 →', fnConfig.getSystemPageUrl() || '(自动)');
    return { ok: true };
}

// 设置 Bangumi 集数级同步开关
async function handleSetBangumiSyncEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setBangumiSyncEnabled(!!enabled);
    log.info('Bangumi 同步开关 →', !!enabled);
}

// 设置 Bangumi 同步阈值百分比（0-100，默认80）
async function handleSetBangumiSyncThreshold(_event: any, threshold: number): Promise<void> {
    fnConfig.setBangumiSyncThreshold(Number(threshold) || 80);
    log.info('Bangumi 同步阈值 →', fnConfig.getBangumiSyncThreshold());
}

// 设置 MPV B站弹幕搜索开关（写 config + 同步到 MPV 的 script-opts/uosc_danmaku.conf）
async function handleSetMpvBiliSearchEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setMpvBiliSearchEnabled(!!enabled);
    writeBiliSearchEnabled(!!enabled);
    log.info('MPV B站弹幕搜索开关 →', !!enabled);
}

// 设置 B站弹幕聚合阈值（写 config + 同步到 MPV 的 script-opts/uosc_danmaku.conf）
async function handleSetMpvBiliAggregateThreshold(_event: any, threshold: number): Promise<void> {
    const t = Number(threshold) || 0;
    fnConfig.setMpvBiliAggregateThreshold(t);
    writeBiliAggregateThreshold(t);
    log.info('B站弹幕聚合阈值 →', t);
}

// 用系统默认浏览器打开外部链接（设置面板内的可点击链接用）
async function handleOpenExternal(_event: any, url: string): Promise<void> {
    if (url && /^https?:\/\//i.test(url)) {
        try { await shell.openExternal(url); }
        catch (e) { log.error('打开外部链接失败:', e); }
    }
}

// 应用调试日志过滤（读取配置并同步给 logger 单例）
function applyDebugFilter(): void {
    const enabled = fnConfig.getDebugEnabled();
    const components = fnConfig.getDebugComponents();
    log.getLogger().setDebugFilter(enabled, components);
    // 下发到渲染进程(供 EmbyWall 等渲染侧日志按组件独立开关控制)
    const win = getMainWindow();
    if (win && win.webContents) {
        win.webContents.send('debug-filter', { enabled, components });
    }
    log.info(`调试日志过滤已应用: enabled=${enabled}, components=${JSON.stringify(components)}`);
}

// 设置调试日志总开关
async function handleSetDebugEnabled(_event: any, enabled: boolean): Promise<void> {
    fnConfig.setDebugEnabled(!!enabled);
    applyDebugFilter();
}

// 设置各组件日志开关
async function handleSetDebugComponents(_event: any, components: Record<string, boolean>): Promise<void> {
    fnConfig.setDebugComponents(components || {});
    applyDebugFilter();
}

// 设置默认 MPV 着色器预设 + ICC 校色，并写入 portable_config/mpv-user.conf
async function handleSetMpvShaderConfig(_event: any, payload: { shader?: string; icc?: boolean }): Promise<void> {
    const shader = (payload && payload.shader) || 'off';
    const icc = payload && payload.icc !== false;
    fnConfig.setMpvDefaultShader(shader);
    fnConfig.setMpvIccEnabled(icc);
    writeMpvUserConfig(shader, icc);
    log.info(`默认 MPV 着色器已设置为: ${shader}（ICC=${icc}）`);
}

// 设置 B站弹幕样式与过滤（写入 script-opts/uosc_danmaku.conf + 屏蔽词文件）
async function handleSetBiliDanmakuStyle(_event: any, payload: any): Promise<void> {
    const p = payload || {};
    if (typeof p.opacity === 'number') fnConfig.setBiliDanmakuOpacity(p.opacity);
    if (typeof p.fontSize === 'number') fnConfig.setBiliDanmakuFontSize(p.fontSize);
    if (typeof p.outline === 'number') fnConfig.setBiliDanmakuOutline(p.outline);
    if (typeof p.shadow === 'number') fnConfig.setBiliDanmakuShadow(p.shadow);
    if (typeof p.bold === 'boolean') fnConfig.setBiliDanmakuBold(p.bold);
    if (typeof p.displayArea === 'number') fnConfig.setBiliDanmakuDisplayArea(p.displayArea);
    if (typeof p.maxScreen === 'number') fnConfig.setBiliDanmakuMaxScreen(p.maxScreen);
    if (typeof p.blacklist === 'string') fnConfig.setBiliDanmakuBlacklist(p.blacklist);
    if (Array.isArray(p.blockTypes)) fnConfig.setBiliDanmakuBlockTypes(p.blockTypes);
    writeBiliDanmakuStyle();
    log.info('B站弹幕样式与过滤已更新');
}

// [lc-486] 设置 MPV 插帧（AI 补帧）：写 config + 同步到 script-opts/fntv_interp.conf（供 fntv_interp.lua 读取）
async function handleSetInterp(_event: any, payload: any): Promise<void> {
    const p = payload || {};
    const enabled = !!p.enabled;
    const engine = (p.engine === 'svp' || p.engine === 'rife' || p.engine === 'builtin') ? p.engine : 'auto';
    const enginePath = typeof p.path === 'string' ? p.path : '';
    fnConfig.setMpvInterpEnabled(enabled);
    fnConfig.setMpvInterpEngine(engine);
    fnConfig.setMpvInterpEnginePath(enginePath);
    writeInterpConfig(enabled, engine, enginePath);
    log.info(`[插帧] 已设置: enabled=${enabled}, engine=${engine}, path=${enginePath || '(空)'}`);
}

// [lc-486] 读取 MPV 插帧当前设置（供设置面板初始渲染）
async function handleGetInterp(): Promise<any> {
    return {
        enabled: fnConfig.getMpvInterpEnabled(),
        engine: fnConfig.getMpvInterpEngine(),
        path: fnConfig.getMpvInterpEnginePath()
    };
}

// 诊断信息：汇总当前运行态关键数据，供设置面板「诊断」页展示，减少"用户反馈→查日志"往返
function readFileSafe(p: string): string {
    try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '(文件不存在)'; } catch (e) { return '(读取失败)'; }
}

async function handleGetDiagnostics(): Promise<any> {
    try {
        const c: any = fnConfig.readConfig ? fnConfig.readConfig() : null;
        const cfg = c || {};
        const portableDir = getPortableConfigDir();
        const mpvUserConf = readFileSafe(path.join(portableDir, 'mpv-user.conf'));
        const danmakuConf = readFileSafe(path.join(portableDir, 'script-opts', 'uosc_danmaku.conf'));
        let version = '';
        try { version = fnConfig.getAppliedPatchVersion() || app.getVersion(); } catch (e) { version = ''; }
        return {
            ok: true,
            version,
            appPath: app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath(),
            isPackaged: app.isPackaged,
            // 登录态
            domain: cfg.domain || '(未设置)',
            account: cfg.account || '(未设置)',
            loginType: cfg.loginType || '(未知)',
            hasToken: !!cfg.token,
            // 播放器
            defaultPlayer: fnConfig.getDefaultPlayer(),
            mpvPath: fnConfig.getMpvPlayerPath() || '(自动检测)',
            potPath: fnConfig.getPotPlayerPath() || '(自动检测)',
            mpvConfigDir: portableDir,
            mpvUserConf,
            danmakuConf,
            // 弹幕/同步状态
            biliSearchEnabled: fnConfig.getMpvBiliSearchEnabled(),
            biliAggregateThreshold: fnConfig.getMpvBiliAggregateThreshold(),
            doubanEnabled: fnConfig.getDoubanSyncEnabled(),
            doubanLoggedIn: !!fnConfig.getDoubanCookie(),
            bangumiEnabled: fnConfig.getBangumiSyncEnabled(),
            bangumiHasToken: !!fnConfig.getBangumiToken(),
            // 弹幕屏蔽（lc-215 新增，排障关键）
            danmakuBlockTypes: fnConfig.getBiliDanmakuBlockTypes(),
            danmakuBlacklist: fnConfig.getBiliDanmakuBlacklist() || '',
            // MPV 渲染（着色器 / ICC 校色）
            mpvShader: fnConfig.getMpvDefaultShader(),
            mpvIcc: fnConfig.getMpvIccEnabled() !== false,
            // 界面 / 其它开关
            wheelHScroll: fnConfig.getWheelHScroll() !== false,
            detailBoxless: fnConfig.getDetailBoxless() === true,
            loginBgPath: fnConfig.getLoginBgPath() || '(默认)',
            updateDismissedAt: (c && c.updateDismissedAt) || 0
        };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

async function handleCheckUpdate(): Promise<void> {
    try {
        await getUpdateChecker().manualCheckForUpdates();
    } catch (error) {
        log.error('手动检查更新失败:', error);
    }
}

/**
 * [lc-511] 回滚补丁：清除已应用的热补丁覆盖文件并重启应用，使软件回到安装包原版。
 * 先确认当前确有已应用补丁；若无则提示无需回滚。二次确认后执行清除并重启（与补丁应用后重启同机制，
 * 确保 main 端补丁也一并失效）。
 */
async function handleRollbackPatch(): Promise<void> {
    if (!fnConfig.getAppliedPatchVersion()) {
        await fnosDialog(getMainWindow(), {
            type: 'info',
            title: '回滚补丁',
            message: '当前没有已应用的补丁，无需回滚。',
            buttons: ['确定'],
            defaultId: 0,
        });
        return;
    }
    const { response } = await fnosDialog(getMainWindow(), {
        type: 'question',
        title: '回滚补丁',
        message: '确定要回滚到原版（清除已应用的热补丁）吗？\n此操作会删除补丁覆盖文件并重启应用。',
        buttons: ['确定回滚', '取消'],
        defaultId: 1,
        cancelId: 1,
    });
    if (response !== 0) return;
    clearAllPatches();
    // 重启应用，使 main 端补丁也失效（与 patchApplier 应用补丁后重启同机制）
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
}

async function handleShowMain(): Promise<void> {
    const win = getMainWindow();
    if (win) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
    }
}

/**
 * 用系统默认方式打开日志文件（Windows 下优先直接用资源管理器/记事本打开）。
 * 比 spawn cmd 稳定，不依赖引号、start、控制台窗口等玄学。
 */
async function handleOpenLog(): Promise<{ ok: boolean; error?: string }> {
    try {
        const logFile = log.getLogFile();
        if (!logFile) return { ok: false, error: '无法定位日志文件路径' };
        if (!fs.existsSync(logFile)) return { ok: false, error: '日志文件尚未生成' };
        // Electron 原生：用系统默认程序打开文件；失败则回退 notepad
        const errMsg = await shell.openPath(logFile);
        if (errMsg) {
            log.warn('shell.openPath 打开日志失败，回退 notepad:', errMsg);
            spawn('notepad.exe', [logFile], { windowsHide: false });
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 打开精简报错日志(app-error.log)：仅含 WARN/ERROR，体积小、便于快速定位问题。
 * 若报错日志尚未生成（还没写过任何 WARN/ERROR），则回退打开全量日志。
 */
async function handleOpenErrorLog(): Promise<{ ok: boolean; error?: string }> {
    try {
        const errFile = log.getErrorLogFile();
        if (!errFile) return { ok: false, error: '无法定位日志文件路径' };
        const target = fs.existsSync(errFile) ? errFile : log.getLogFile();
        if (!target || !fs.existsSync(target)) return { ok: false, error: '日志文件尚未生成' };
        const errMsg = await shell.openPath(target);
        if (errMsg) {
            log.warn('shell.openPath 打开报错日志失败，回退 notepad:', errMsg);
            spawn('notepad.exe', [target], { windowsHide: false });
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 打开 MPV 播放器日志(mpv.log)：弹幕脚本(uosc_danmaku)的全部 verbose 日志落盘于此，
 * 与 app.log 同目录(log.getLogDir())。仅在 MPV 至少播放过一次后才存在
 * （播放器启动时通过 --log-file 创建，播放退出时截断并续写）。
 * 若尚未生成，提示用户先播放一次；打开失败回退 notepad。
 */
async function handleOpenMpvLog(): Promise<{ ok: boolean; error?: string }> {
    try {
        const logDir = log.getLogDir();
        if (!logDir) return { ok: false, error: '无法定位日志目录' };
        const mpvLogFile = path.join(logDir, 'mpv.log');
        if (!fs.existsSync(mpvLogFile)) {
            return { ok: false, error: 'MPV 日志尚未生成（请先用 MPV 播放一次后再试）' };
        }
        const errMsg = await shell.openPath(mpvLogFile);
        if (errMsg) {
            log.warn('shell.openPath 打开 MPV 日志失败，回退 notepad:', errMsg);
            spawn('notepad.exe', [mpvLogFile], { windowsHide: false });
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 导出日志文件：弹出"另存为"对话框，把当前日志复制到用户指定位置。
 */
async function handleExportLog(): Promise<{ ok: boolean; error?: string; savedPath?: string }> {
    try {
        const logFile = log.getLogFile();
        if (!logFile) return { ok: false, error: '无法定位日志文件路径' };
        if (!fs.existsSync(logFile)) return { ok: false, error: '日志文件尚未生成' };
        const win = getMainWindow();
        const ext = path.extname(logFile) || '.log';
        const base = path.basename(logFile, ext);
        const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const defaultName = `${base}-${stamp}${ext}`;
        const result = await dialog.showSaveDialog(win || (undefined as any), {
            title: '导出日志文件',
            defaultPath: defaultName,
            filters: [{ name: '日志文件', extensions: ['log', 'txt'] }]
        });
        if (result.canceled || !result.filePath) {
            return { ok: false, error: '已取消' };
        }
        fs.copyFileSync(logFile, result.filePath);
        return { ok: true, savedPath: result.filePath };
    } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// ===== 历史版本：列出并读取 resource/wiki 下的 MD 文件（设置面板「历史版本」按钮用）=====
function getWikiDir(): string {
    // dev: 项目根/resource/wiki；打包: asar 内 resource/wiki（需在 package.json files 含 resource/wiki）
    return path.join(app.getAppPath(), 'resource', 'wiki');
}

// 防目录穿越：仅允许文件名（字母/数字/下划线/中文/连字符/点号），解析后必须仍在 wikiDir 内
function safeWikiFile(name: string): string | null {
    if (!/^[A-Za-z0-9_一-龥.\-]+\.md$/i.test(name)) return null;
    const wikiDir = getWikiDir();
    const full = path.join(wikiDir, name);
    const rel = path.relative(wikiDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return full;
}

// 从文件名提取版本号（CHANGELOG_v3.3.2.md -> [3,3,2]），无则返回 null
function parseVersion(name: string): number[] | null {
    const m = name.match(/v(\d+)\.(\d+)\.(\d+)/i);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function extractTitle(name: string, firstLine: string): string {
    // 更新日志类文件：始终以版本号显示（vX.Y.Z），不显示「更新日志」字样，方便对照查看
    const ver = parseVersion(name);
    if (ver && /changelog/i.test(name)) return `v${ver.join('.')}`;
    const line = (firstLine || '').trim();
    if (line.startsWith('#')) return line.replace(/^#+\s*/, '').trim() || name;
    return name.replace(/\.md$/i, '');
}

async function handleListChangelogs(): Promise<{ name: string; title: string; mtime: number }[]> {
    try {
        const wikiDir = getWikiDir();
        if (!fs.existsSync(wikiDir)) return [];
        const files = fs.readdirSync(wikiDir).filter(f => f.toLowerCase().endsWith('.md'));
        // 固定钉位：0=用户使用手册(置顶) 1=Fntv-Plus Wiki(Home.md) 2=其余(按版本号/时间)
        // 固定钉位：0=插件开发与使用文档(置顶) 1=用户使用手册 2=Fntv-Plus Wiki(Home.md) 其余(版本号/时间)排其后
        const PIN: { [k: string]: number } = { '插件开发与使用文档.md': 0, '用户使用手册.md': 1, 'Home.md': 2 };
        const pinRank = (n: string): number => (PIN[n] !== undefined ? PIN[n] : 3);
        const list = files.map(f => {
            let title = f.replace(/\.md$/i, '');
            let mtime = 0;
            try {
                const fp = path.join(wikiDir, f);
                mtime = fs.statSync(fp).mtimeMs;
                const head = fs.readFileSync(fp, 'utf8').split('\n')[0] || '';
                title = extractTitle(f, head);
            } catch (e) { /* 单文件错误忽略，保留文件名兜底 */ }
            return { name: f, title, mtime };
        });
        list.sort((a, b) => {
            // 1) 固定钉位：用户使用手册置顶，Fntv-Plus Wiki 次之
            const ra = pinRank(a.name), rb = pinRank(b.name);
            if (ra !== rb) return ra - rb;
            // 2) 其余按版本号倒序（v3.3.2 > v3.3.1 > ...）；无版本号的文件按修改时间倒序兜底
            const av = parseVersion(a.name);
            const bv = parseVersion(b.name);
            if (av && bv) {
                for (let i = 0; i < 3; i++) {
                    if (av[i] !== bv[i]) return bv[i] - av[i]; // 倒序
                }
                return 0;
            }
            if (av) return -1; // 有版本号的排前面
            if (bv) return 1;
            return b.mtime - a.mtime;
        });
        return list;
    } catch (e: any) {
        log.error('列出历史版本失败:', e);
        return [];
    }
}

async function handleReadChangelog(_event: any, name: string): Promise<{ ok: boolean; name: string; title: string; content: string; error?: string }> {
    const full = safeWikiFile(name);
    if (!full) return { ok: false, name, title: name, content: '', error: '非法文件名' };
    try {
        if (!fs.existsSync(full)) return { ok: false, name, title: name, content: '', error: '文件不存在' };
        const raw = fs.readFileSync(full, 'utf8');
        const title = extractTitle(name, raw.split('\n')[0] || '');
        return { ok: true, name, title, content: raw };
    } catch (e: any) {
        return { ok: false, name, title: name, content: '', error: String((e && e.message) || e) };
    }
}

function init(): void {
    // 启动时应用已保存的调试日志过滤，确保控制台日志开关在用户打开设置前即生效
    applyDebugFilter();
    // 启动时把 MPV B站弹幕搜索开关同步到 script-opts/uosc_danmaku.conf（保证 MPV 读取到最新状态）
    try { writeBiliSearchEnabled(fnConfig.getMpvBiliSearchEnabled()); } catch (e) { log.warn('启动同步 bili_search_enabled 失败', e); }
    // 启动时把 B站弹幕聚合阈值同步到 script-opts/uosc_danmaku.conf
    try { writeBiliAggregateThreshold(fnConfig.getMpvBiliAggregateThreshold()); } catch (e) { log.warn('启动同步 aggregate_threshold 失败', e); }
    // 启动时把已保存的「默认 MPV 着色器 / ICC 校色」重新写回活动配置目录。
    // 关键修复：旧实现只在面板改着色器时写 portable_config 单一目录，而 MPV 在 Windows 标准模式下
    // 读的是用户配置目录(AppData/Roaming/mpv)；加上 writeMpvUserConfig 现双写到两个目录，
    // 这里再在启动时补一次重放，确保用户「之前已选过但没生效」的着色器立即生效（无需重新手动选择）。
    try { writeMpvUserConfig(fnConfig.getMpvDefaultShader(), fnConfig.getMpvIccEnabled() !== false); } catch (e) { log.warn('启动重放默认着色器失败', e); }
    registerHandler('settings:get', handleGetSettings, { useHandle: true });
    registerHandler('settings:set-download-proxy', handleSetDownloadProxy, { useHandle: true });
    registerHandler('settings:set-hide-play', handleSetHidePlay, { useHandle: true });
    registerHandler('settings:set-nas-proxy', handleSetNasProxy, { useHandle: true });
    registerHandler('settings:pick-mpv-path', handlePickMpvPath, { useHandle: true });
    registerHandler('settings:clear-mpv-path', handleClearMpvPath, { useHandle: true });
    registerHandler('settings:pick-pot-path', handlePickPotPath, { useHandle: true });
    registerHandler('settings:clear-pot-path', handleClearPotPath, { useHandle: true });
    registerHandler('settings:pick-login-bg', handlePickLoginBg, { useHandle: true });
    registerHandler('settings:set-login-bg', handleSetLoginBg, { useHandle: true });
    registerHandler('settings:clear-login-bg', handleClearLoginBg, { useHandle: true });
    registerHandler('settings:set-default-player', handleSetDefaultPlayer, { useHandle: true });
    registerHandler('settings:set-exit-mode', handleSetExitMode, { useHandle: true });
    registerHandler('settings:set-douban-enabled', handleSetDoubanEnabled, { useHandle: true });
    registerHandler('settings:set-debug-enabled', handleSetDebugEnabled, { useHandle: true });
    registerHandler('settings:set-debug-components', handleSetDebugComponents, { useHandle: true });
    registerHandler('settings:set-bangumi-token', handleSetBangumiToken, { useHandle: true });
    registerHandler('settings:set-tmdb-key', handleSetTmdbApiKey, { useHandle: true });
    registerHandler('settings:set-tmdb-direct', handleSetTmdbDirect, { useHandle: true });
    registerHandler('settings:set-hot-source', handleSetHotSource, { useHandle: true });
    registerHandler('settings:get-hot-source', handleGetHotSource, { useHandle: true });
    registerHandler('settings:get-system-page-url', handleGetSystemPageUrl, { useHandle: true });
    registerHandler('settings:set-system-page-url', handleSetSystemPageUrl, { useHandle: true });
    // 自定义代理（让 Bangumi 每日放送、TMDB 走用户自建代理入口）
    registerHandler('settings:get-custom-proxy', handleGetCustomProxy, { useHandle: true });
    registerHandler('settings:set-custom-proxy', handleSetCustomProxy, { useHandle: true });
    registerHandler('settings:test-custom-proxy', handleTestCustomProxy, { useHandle: true });
    registerHandler('settings:set-bangumi-sync-enabled', handleSetBangumiSyncEnabled, { useHandle: true });
    registerHandler('settings:set-bangumi-sync-threshold', handleSetBangumiSyncThreshold, { useHandle: true });
    registerHandler('settings:set-mpv-bili-search-enabled', handleSetMpvBiliSearchEnabled, { useHandle: true });
    registerHandler('settings:set-mpv-bili-aggregate-threshold', handleSetMpvBiliAggregateThreshold, { useHandle: true });
    registerHandler('settings:set-detail-boxless', handleSetDetailBoxless, { useHandle: true });
    registerHandler('settings:set-wheel-hscroll', handleSetWheelHScroll, { useHandle: true });
    registerHandler('settings:set-carousel-logo', handleSetCarouselLogoEnabled, { useHandle: true });
    registerHandler('settings:open-external', handleOpenExternal, { useHandle: true });
    // 渲染进程(EmbyWall 墙)主动索取当前调试过滤 → 回传，使其渲染侧日志开关即时生效
    registerHandler('debug-filter-request', (event: any) => {
        event.sender.send('debug-filter', {
            enabled: fnConfig.getDebugEnabled(),
            components: fnConfig.getDebugComponents()
        });
    }, { useHandle: false });
    registerHandler('settings:set-mpv-shader-config', handleSetMpvShaderConfig, { useHandle: true });
    registerHandler('settings:set-bili-danmaku-style', handleSetBiliDanmakuStyle, { useHandle: true });
    registerHandler('settings:set-interp', handleSetInterp, { useHandle: true });
    registerHandler('settings:get-interp', handleGetInterp, { useHandle: true });
    registerHandler('settings:diagnostics', handleGetDiagnostics, { useHandle: true });
    registerHandler('settings:check-update', handleCheckUpdate, { useHandle: true });
    registerHandler('settings:rollback-patch', handleRollbackPatch, { useHandle: true });
    registerHandler('settings:show-main', handleShowMain, { useHandle: true });
    registerHandler('settings:open-log', handleOpenLog, { useHandle: true });
    registerHandler('settings:open-error-log', handleOpenErrorLog, { useHandle: true });
    registerHandler('settings:open-mpv-log', handleOpenMpvLog, { useHandle: true });
    registerHandler('settings:export-log', handleExportLog, { useHandle: true });
    registerHandler('settings:list-changelogs', handleListChangelogs, { useHandle: true });
    registerHandler('settings:read-changelog', handleReadChangelog, { useHandle: true });
}

export {
    init
};
