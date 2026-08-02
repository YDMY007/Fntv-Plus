import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as logger from '../../../modules/logger';
import * as fnConfig from '../../../modules/fn_config/config';

/**
 * MPV配置文件管理插件
 * 定时检查用户配置目录中的scripts文件夹，不存在则从应用中复制
 */

let configCheckInterval: NodeJS.Timeout | null = null;

// 获取用户MPV配置目录
function getMpvConfigDir(): string {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Roaming', 'mpv');
    } else {
        return path.join(homeDir, '.config', 'mpv');
    }
}

// 获取应用中的portable_config目录
// ⚠️ 关键：必须返回 MPV 实际读取的【可写】目录。
//   - 开发模式：app.getAppPath() = 项目根目录，CWD = 项目根目录 → 两者一致，可写。
//   - 打包模式：app.getAppPath() = resources/app.asar（只读虚拟路径！），
//     而 extraFiles 把 third_party/fntv-mpv 解压到【exe 同级目录】（可写），
//     MPV 以相对路径 + CWD=exe目录 启动 → 实际读取 exe 目录下的 portable_config。
//     故打包后必须用 path.dirname(app.getPath('exe')) 拼接，否则写 mpv-user.conf 会写进
//     只读 asar 导致静默失败（面板改了默认着色器但不生效）。
function getPortableConfigDir(): string {
    const sub = path.join('third_party', 'fntv-mpv', 'portable_config');
    if (process.platform === 'darwin') {
        // macOS: third_party目录在应用包的Contents目录下（extraFiles 解压到 Contents/）
        const appPath = app.getAppPath();
        const contentsPath = path.dirname(path.dirname(appPath)); // 从app.asar向上两级到Contents
        return path.join(contentsPath, 'third_party', 'fntv-mpv', 'portable_config');
    } else if (process.platform === 'win32') {
        // Windows: extraFiles 将 third_party/fntv-mpv 解压到 exe 同级目录
        if (app.isPackaged) {
            return path.join(path.dirname(app.getPath('exe')), sub);
        }
        return path.join(app.getAppPath(), sub);
    } else {
        // Linux: 同 Windows，extraFiles 解压到 exe 同级目录
        if (app.isPackaged) {
            return path.join(path.dirname(app.getPath('exe')), sub);
        }
        return path.join(app.getAppPath(), sub);
    }
}

// 递归复制目录
function copyDirectoryRecursive(source: string, destination: string): void {
    if (!fs.existsSync(source)) {
        logger.log(`Source directory does not exist: ${source}`);
        return;
    }

    // 创建目标目录
    if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
    }

    const items = fs.readdirSync(source);

    items.forEach(item => {
        const sourcePath = path.join(source, item);
        const destPath = path.join(destination, item);

        const stat = fs.statSync(sourcePath);

        if (stat.isDirectory()) {
            copyDirectoryRecursive(sourcePath, destPath);
        } else {
            fs.copyFileSync(sourcePath, destPath);
            logger.log(`Copied: ${sourcePath} -> ${destPath}`);
        }
    });
}

// 检查并复制配置文件
function checkAndCopyMpvConfig(): void {
    try {
        const mpvConfigDir = getMpvConfigDir();
        const scriptsDir = path.join(mpvConfigDir, 'scripts');
        const portableConfigDir = getPortableConfigDir();

        // 检查scripts目录是否存在
        if (!fs.existsSync(scriptsDir)) {
            logger.log(`Scripts directory not found, copying from portable config...`);

            // 确保MPV配置目录存在
            if (!fs.existsSync(mpvConfigDir)) {
                fs.mkdirSync(mpvConfigDir, { recursive: true });
                logger.log(`Created MPV config directory: ${mpvConfigDir}`);
            }

            // 复制portable_config目录中的所有内容到用户配置目录
            if (fs.existsSync(portableConfigDir)) {
                copyDirectoryRecursive(portableConfigDir, mpvConfigDir);
                logger.log(`MPV configuration copied successfully from ${portableConfigDir} to ${mpvConfigDir}`);
            } else {
                logger.log(`Portable config directory not found: ${portableConfigDir}`);
            }
        } else {
            logger.debug(`Scripts directory already exists: ${scriptsDir}`);
        }
    } catch (error) {
        logger.error('Error in checkAndCopyMpvConfig:', error);
    }
}

// 启动定时检查
function startConfigCheck(): void {
    // 立即执行一次检查
    checkAndCopyMpvConfig();

    // 设置定时检查（每分钟检查一次）
    configCheckInterval = setInterval(() => {
        checkAndCopyMpvConfig();
    }, 60 * 1000);

    logger.info('MPV config check started, checking every 1 minute');
}

// 停止定时检查
function stopConfigCheck(): void {
    if (configCheckInterval) {
        clearInterval(configCheckInterval);
        configCheckInterval = null;
        logger.info('MPV config check stopped');
    }
}

/**
 * MPV 默认着色器预设映射表（key → glsl-shaders 文件名列表）
 * 与 input.conf 中 Ctrl+1~9 的临时切换列表保持一致。
 */
const MPV_SHADER_PRESETS: Record<string, string[]> = {
    off: [],
    // 模式A：大多数1080p动画
    a: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_M.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl'
    ],
    // 模式B：大多数720p动画
    b: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_Soft_M.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl'
    ],
    // 模式A+A：高质量1080p
    aa: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Restore_CNN_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl'
    ],
    // 模式B+B：高质量720p
    bb: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_Soft_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Restore_CNN_Soft_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl'
    ],
    // 轻量模式：低配置设备
    lite: [
        'Anime4K_Restore_CNN_S.glsl',
        'Anime4K_Upscale_CNN_x2_S.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Upscale_CNN_x2_S.glsl'
    ],
    // 仅降噪
    denoise: [
        'Anime4K_Denoise_Bilateral_Mode.glsl'
    ],
    // 真实系：真人/纪录片
    real: [
        'CAS.glsl',
        'ColorVibrance.glsl'
    ],
    // 电影感：动画 + 胶片粒度 + 色彩
    cinema: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_M.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'FilmGrain.glsl',
        'ColorVibrance.glsl'
    ],
    // 全增强：极致画质
    ultra: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_AutoDownscalePre_x2.glsl',
        'Anime4K_Restore_CNN_L.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'CAS.glsl',
        'FilmGrain.glsl',
        'ColorVibrance.glsl'
    ]
};

/**
 * 将「默认 MPV 着色器 + ICC 校色」写入 portable_config/mpv-user.conf。
 * 该文件被 mpv.conf 通过 `include=~~/mpv-user.conf` 加载，作为 MPV 启动默认。
 * @param shaderKey 预设 key（'off' 表示不启用任何着色器）
 * @param iccEnabled 是否开启 ICC 自动校色
 */
function writeMpvUserConfig(shaderKey: string, iccEnabled: boolean): void {
    try {
        const shaders = MPV_SHADER_PRESETS[shaderKey] || [];
        const lines: string[] = [
            '# 本文件由「应用设置面板」自动生成（默认着色器 / ICC 校色）。',
            '# 修改后会被重写，请勿手动编辑。',
            ''
        ];
        for (const s of shaders) {
            lines.push('glsl-shaders-append=~~/shaders/' + s);
        }
        lines.push('icc-profile-auto=' + (iccEnabled ? 'yes' : 'no'));
        const content = lines.join('\n') + '\n';

        // ⚠️ 关键修复：同时写入两个目录，确保无论 MPV 处于哪种模式都能生效：
        //   - 便携模式（mpv.exe 同级 portable_config，Windows/macOS 打包态）：读 portable_config/mpv-user.conf
        //   - 标准模式（读系统用户配置目录 AppData/Roaming/mpv 等）：读该目录下的 mpv-user.conf
        // 旧实现只写 portable_config，而 checkAndCopyMpvConfig 仅在首次运行拷贝一次，
        // 之后面板改的着色器写进死目录、正在运行的 MPV 读的是首次拷贝的旧文件 → 「选了不生效」。
        const dirs = [getPortableConfigDir(), getMpvConfigDir()];
        for (const dir of dirs) {
            try {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                const target = path.join(dir, 'mpv-user.conf');
                fs.writeFileSync(target, content, 'utf-8');
                logger.info(`MPV 默认配置已写入: ${target} (shader=${shaderKey || 'off'}, icc=${iccEnabled})`);
            } catch (e) {
                logger.error(`写入 mpv-user.conf 失败: ${dir}`, e);
            }
        }
    } catch (error) {
        logger.error('写入 mpv-user.conf 失败:', error);
    }
}

// 写入 MPV B站弹幕搜索开关到 script-opts/uosc_danmaku.conf
// 同时控制 bili_search_enabled(手动搜索门控) 与 auto_load_extra(自动补源/B站自动搜索)，
// 两者同开同关，确保关闭开关后既不能手动搜、也不会自动加载 B站弹幕。
// ⚠️ 双写：同时写入 getPortableConfigDir() 与 getMpvConfigDir()（用户配置目录 AppData/Roaming/mpv）。
//   mpv 在「便携模式」(CWD=exe目录) 读 portable_config，在「标准模式」读用户配置目录；
//   只写一处会导致另一模式下 auto_load_extra 不生效（典型表现：换台机器/某些环境 B站 永不自动搜索）。
//   这与 writeMpvUserConfig / writeBiliDanmakuStyle 的双写策略一致（lc-094 教训：着色器单写导致不生效）。
// 保留 conf 中其他选项，仅替换/追加这两个键。
function writeBiliSearchEnabled(enabled: boolean): void {
    try {
        const val = enabled ? 'yes' : 'no';
        const dirs = [getPortableConfigDir(), getMpvConfigDir()];
        for (const dir of dirs) {
            try {
                const scriptOptsDir = path.join(dir, 'script-opts');
                if (!fs.existsSync(scriptOptsDir)) {
                    fs.mkdirSync(scriptOptsDir, { recursive: true });
                }
                const target = path.join(scriptOptsDir, 'uosc_danmaku.conf');
                let lines: string[] = [];
                if (fs.existsSync(target)) {
                    lines = fs.readFileSync(target, 'utf-8').split(/\r?\n/);
                }
                // 移除已存在的 bili_search_enabled / auto_load_extra 行，以及旧的开关注释行（防止注释无限堆叠）
                lines = lines.filter(l => !/^\s*(bili_search_enabled|auto_load_extra)\s*=/.test(l)
                    && !/^#\s*B站弹幕搜索开关/.test(l));
                // 去掉末尾多余空行
                while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
                lines.push('# B站弹幕搜索开关（由应用设置面板控制，同时控制自动补源 auto_load_extra）');
                lines.push('bili_search_enabled=' + val);
                lines.push('auto_load_extra=' + val);
                fs.writeFileSync(target, lines.join('\n') + '\n', 'utf-8');
                logger.info(`MPV B站弹幕搜索开关已写入: ${target} (enabled=${enabled}, auto_load_extra=${val})`);
            } catch (e) {
                logger.error(`写入 uosc_danmaku.conf (B站弹幕搜索开关) 失败: ${dir}`, e);
            }
        }
    } catch (error) {
        logger.error('写入 B站弹幕搜索开关失败:', error);
    }
}

// 写入 B站弹幕聚合阈值到 script-opts/uosc_danmaku.conf（由应用设置面板控制）
function writeBiliAggregateThreshold(threshold: number): void {
    try {
        const dir = getPortableConfigDir();
        const scriptOptsDir = path.join(dir, 'script-opts');
        if (!fs.existsSync(scriptOptsDir)) {
            fs.mkdirSync(scriptOptsDir, { recursive: true });
        }
        const target = path.join(scriptOptsDir, 'uosc_danmaku.conf');
        let lines: string[] = [];
        if (fs.existsSync(target)) {
            lines = fs.readFileSync(target, 'utf-8').split(/\r?\n/);
        }
        // 移除已存在的 aggregate_threshold 行及旧注释，避免重复堆叠
        lines = lines.filter(l => !/^\s*aggregate_threshold\s*=/.test(l)
            && !/^#\s*B站弹幕聚合阈值/.test(l));
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        const t = Number(threshold) || 0;
        lines.push('# B站弹幕聚合阈值（单视频弹幕<此值时合并同类候选；0=禁用）');
        lines.push('aggregate_threshold=' + t);
        fs.writeFileSync(target, lines.join('\n') + '\n', 'utf-8');
        logger.info(`MPV B站弹幕聚合阈值已写入: ${target} (threshold=${t})`);
    } catch (error) {
        logger.error('写入 uosc_danmaku.conf (aggregate_threshold) 失败:', error);
    }
}

// 写入 B站弹幕「样式与过滤」到 script-opts/uosc_danmaku.conf（覆盖 fontsize/opacity/outline/shadow/bold/displayarea/max_screen_danmaku/blacklist_path）
// 同时把屏蔽词写入 <portable_config>/danmaku_blacklist.txt（用 ~~ 相对路径引用，MPV 自动解析到当前配置目录），
// 把弹幕屏蔽类型写入 <portable_config>/scripts/uosc_danmaku/danmaku_block_types.json（bili_danmaku.py 启动时读取并过滤）。
// 保留 conf 中其他选项（bili_search_enabled / auto_load_extra / aggregate_threshold 等由各自函数管理）。
function writeBiliDanmakuStyle(): void {
    try {
        const opacity = fnConfig.getBiliDanmakuOpacity();
        const fontsize = fnConfig.getBiliDanmakuFontSize();
        const outline = fnConfig.getBiliDanmakuOutline();
        const shadow = fnConfig.getBiliDanmakuShadow();
        const bold = fnConfig.getBiliDanmakuBold();
        const displayarea = fnConfig.getBiliDanmakuDisplayArea();
        const maxScreen = fnConfig.getBiliDanmakuMaxScreen();
        const blacklist = fnConfig.getBiliDanmakuBlacklist() || '';

        const dirs = [getPortableConfigDir(), getMpvConfigDir()];
        for (const dir of dirs) {
            try {
                const scriptOptsDir = path.join(dir, 'script-opts');
                if (!fs.existsSync(scriptOptsDir)) fs.mkdirSync(scriptOptsDir, { recursive: true });
                const target = path.join(scriptOptsDir, 'uosc_danmaku.conf');
                let lines: string[] = [];
                if (fs.existsSync(target)) {
                    lines = fs.readFileSync(target, 'utf-8').split(/\r?\n/);
                }
                // 移除已存在的相关键及旧注释，避免堆叠
                lines = lines.filter(l => !/^\s*(fontsize|opacity|outline|shadow|bold|displayarea|max_screen_danmaku|blacklist_path)\s*=/.test(l)
                    && !/^#\s*B站弹幕(样式|透明度|字号|描边|阴影|粗体|显示区域|同屏上限|屏蔽词)/.test(l));
                while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

                const blacklistFile = path.join(dir, 'danmaku_blacklist.txt');
                // 屏蔽词：按行写入（支持 lua 正则）；空则清空文件引用
                const words = blacklist.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
                fs.writeFileSync(blacklistFile, words.join('\n') + (words.length ? '\n' : ''), 'utf-8');

                const push = (label: string, key: string, val: string) => {
                    lines.push(`# B站弹幕${label}`);
                    lines.push(`${key}=${val}`);
                };
                push('透明度', 'opacity', String(opacity));
                push('字号', 'fontsize', String(fontsize));
                push('描边', 'outline', String(outline));
                push('阴影', 'shadow', String(shadow));
                push('粗体', 'bold', bold ? 'yes' : 'no');
                push('显示区域', 'displayarea', String(displayarea));
                push('同屏上限', 'max_screen_danmaku', String(maxScreen));
                push('屏蔽词', 'blacklist_path', '~~/danmaku_blacklist.txt');
                fs.writeFileSync(target, lines.join('\n') + '\n', 'utf-8');
                logger.info(`B站弹幕样式已写入: ${target} (opacity=${opacity},size=${fontsize},outline=${outline},shadow=${shadow},bold=${bold},area=${displayarea},max=${maxScreen},blacklist=${words.length}词)`);
                // 弹幕屏蔽类型：写入 scripts/uosc_danmaku/danmaku_block_types.json（bili_danmaku.py 启动时读取并过滤）
                const blockTypes = fnConfig.getBiliDanmakuBlockTypes();
                const uoscDir = path.join(dir, 'scripts', 'uosc_danmaku');
                if (!fs.existsSync(uoscDir)) fs.mkdirSync(uoscDir, { recursive: true });
                fs.writeFileSync(path.join(uoscDir, 'danmaku_block_types.json'), JSON.stringify(blockTypes), 'utf-8');
            } catch (e) {
                logger.error(`写入 uosc_danmaku.conf 失败: ${dir}`, e);
            }
        }
    } catch (error) {
        logger.error('写入 B站弹幕样式失败:', error);
    }
}

// 插件初始化函数
function init(): void {
    logger.info('Initializing MPV Config Plugin...');
    // 只在macOS上执行
    if (process.platform === 'win32' || process.platform === 'linux') {
        return;
    }

    startConfigCheck();
    // 应用退出前停止检查
    app.on('before-quit', () => {
        stopConfigCheck();
    });
}

export {
    init,
    getPortableConfigDir,
    writeMpvUserConfig,
    writeBiliSearchEnabled,
    writeBiliAggregateThreshold,
    writeBiliDanmakuStyle
};