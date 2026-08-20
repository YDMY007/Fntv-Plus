import * as fs from 'fs';
import * as path from 'path';
import { logConfig, getLogLevel, LogLevel } from './config';
import { maskLogArguments, maskError } from './masking';

// 尝试获取app模块，在非Electron环境中可能失败
let app: any;
try {
    const electron = require('electron');
    app = electron.app;
} catch (error) {
    // 在非Electron环境中使用备用方案
    app = null;
}

/**
 * 日志级别名称映射
 */
const LogLevelNames: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.NOFORMAT]: 'NOFORMAT'
};

/**
 * 文件信息接口
 */
interface FileInfo {
    name: string;
    path: string;
    mtime: Date;
}

/**
 * 日志模块类
 */
export class Logger {
    private logLevel: LogLevel;
    private maxFileSize: number;
    private maxFiles: number;
    private logDir: string;
    private currentLogFile: string;
    private errorLogFile: string; // 仅含 WARN/ERROR 的精简日志，便于快速定位报错
    // 调试日志过滤：总开关 + 各组件开关（仅影响控制台输出，不影响文件）
    private debugEnabled = false;
    private debugComponents: Record<string, boolean> = {};

    // 重复日志合并：相同 (级别+内容) 在窗口内只记一次，其余合并为摘要
    private dedupEnabled: boolean;
    private dedupWindowMs: number;
    private dedupMap: Map<string, { count: number; firstTs: number; lastTs: number; level: LogLevel; content: string }> = new Map();
    private dedupTimer: any = null;

    constructor() {
        this.logLevel = getLogLevel(); // 使用配置获取日志级别
        this.maxFileSize = logConfig.maxFileSize;
        this.maxFiles = logConfig.maxFiles;
        this.logDir = this.getLogDirectory();
        this.currentLogFile = path.join(this.logDir, 'app.log');
        this.errorLogFile = path.join(this.logDir, 'app-error.log');

        // 确保日志目录存在
        this.ensureLogDirectory();

        // 初始化时检查并清理旧的日志文件
        this.cleanupOldLogs();

        // 清理过旧的应用版本日志目录（仅保留最近几个版本）
        this.cleanupOldVersionDirs();

        // 迁移升级前遗留的旧格式日志（基础目录根下的 app*.log / mpv.log）到 v-legacy/
        this.migrateLegacyLogs();

        // 重复日志合并定时器：窗口结束后若停止写入则结算摘要；unref 避免阻止进程退出
        this.dedupEnabled = logConfig.dedupEnabled;
        this.dedupWindowMs = logConfig.dedupWindowMs || 3000;
        if (this.dedupEnabled) {
            this.dedupTimer = setInterval(() => this.flushStaleBursts(), Math.max(1000, Math.floor(this.dedupWindowMs / 2)));
            if (this.dedupTimer && typeof this.dedupTimer.unref === 'function') this.dedupTimer.unref();
        }
    }

    /**
     * 获取日志基础目录路径（不含版本子目录）
     */
    private getBaseLogDirectory(): string {
        if (app) {
            // 在Electron环境中，优先使用用户数据目录，这样重装不会丢失日志
            const isPackaged = app.isPackaged;

            if (isPackaged) {
                // 打包后，使用用户数据目录的logs子文件夹
                // 这样日志文件不会在重新安装时被删除
                const userDataPath = app.getPath('userData');
                return path.join(userDataPath, 'logs');
            } else {
                // 开发环境，使用项目根目录的log文件夹
                const appPath = app.getAppPath();
                return path.join(appPath, 'log');
            }
        } else {
            // 非Electron环境，使用当前工作目录的log文件夹
            return path.join(process.cwd(), 'log');
        }
    }

    /**
     * 获取应用版本号（用于日志按版本分目录）；获取失败时回退 'unknown'
     */
    private getAppVersion(): string {
        try {
            if (app && typeof app.getVersion === 'function') {
                const v = app.getVersion();
                if (v) return v;
            }
        } catch { /* ignore */ }
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
            if (pkg && pkg.version) return pkg.version;
        } catch { /* ignore */ }
        return 'unknown';
    }

    /**
     * 获取日志目录路径：基础目录 + 版本子目录（如 <base>/v3.4.1/），
     * 不同版本日志互不混杂，便于按版本排查问题。
     */
    private getLogDirectory(): string {
        const baseDir = this.getBaseLogDirectory();
        return path.join(baseDir, `v${this.getAppVersion()}`);
    }

    /**
     * 确保日志目录存在
     */
    private ensureLogDirectory(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (error) {
            console.error('创建日志目录失败:', (error as Error).message);
        }
    }

    /**
     * 检查并轮转日志文件（app.log 与 app-error.log 各自独立判断）
     */
    private checkLogRotation(): void {
        try {
            if (this.fileSizeReached(this.currentLogFile, this.maxFileSize)) {
                this.rotateLogFile(this.currentLogFile, 'app');
            }
            if (this.fileSizeReached(this.errorLogFile, this.maxFileSize)) {
                this.rotateLogFile(this.errorLogFile, 'app-error');
            }
        } catch (error) {
            console.error('检查日志轮转失败:', (error as Error).message);
        }
    }

    private fileSizeReached(file: string, limit: number): boolean {
        try {
            if (fs.existsSync(file)) {
                return fs.statSync(file).size >= limit;
            }
        } catch { /* ignore */ }
        return false;
    }

    /**
     * 轮转单个日志文件（按 prefix 生成历史文件名 app-<ts>.log / app-error-<ts>.log）
     */
    private rotateLogFile(currentPath: string, prefix: string): void {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedFile = path.join(this.logDir, `${prefix}-${timestamp}.log`);

            // 移动当前日志文件
            if (fs.existsSync(currentPath)) {
                fs.renameSync(currentPath, rotatedFile);
            }

            // 清理超过限制的旧日志文件
            this.cleanupOldLogs();
        } catch (error) {
            console.error('轮转日志文件失败:', (error as Error).message);
        }
    }

    /**
     * 清理旧的日志文件，只保留最近的几个（按前缀分别清理，互不干扰）
     */
    private cleanupOldLogs(): void {
        try {
            const groups: { prefix: string; current: string }[] = [
                { prefix: 'app-', current: 'app.log' },
                { prefix: 'app-error-', current: 'app-error.log' },
            ];
            for (const g of groups) {
                const files: FileInfo[] = fs.readdirSync(this.logDir)
                    .filter(file => file.startsWith(g.prefix) && file.endsWith('.log') && file !== g.current)
                    // 避免 'app-' 前缀把 'app-error-*' 也算进来
                    .filter(file => !(g.prefix === 'app-' && file.startsWith('app-error-')))
                    .map(file => ({
                        name: file,
                        path: path.join(this.logDir, file),
                        mtime: fs.statSync(path.join(this.logDir, file)).mtime
                    }))
                    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // 按修改时间降序排列

                // 删除超过保留数量的文件（当前文件不在列表中，故保留 maxFiles-1 个历史）
                if (files.length > this.maxFiles - 1) {
                    const filesToDelete = files.slice(this.maxFiles - 1);
                    filesToDelete.forEach(file => {
                        try {
                            fs.unlinkSync(file.path);
                        } catch (error) {
                            console.error(`删除旧日志文件失败: ${file.name}`, (error as Error).message);
                        }
                    });
                }
            }
        } catch (error) {
            console.error('清理旧日志文件失败:', (error as Error).message);
        }
    }

    /**
     * 清理过旧的「版本日志目录」（如 v3.3.4/ v3.4.0/ v3.4.1/），
     * 仅保留最近 maxVersionDirs 个，避免长期升级后目录无限堆积。
     * 目录名形如 vX.Y.Z（可能带后缀如 v3.4.1-hotfix），按 mtime 新旧判断。
     */
    private cleanupOldVersionDirs(): void {
        try {
            const baseDir = this.getBaseLogDirectory();
            if (!fs.existsSync(baseDir)) return;
            const maxVersionDirs = 5; // 保留最近 5 个版本目录

            const dirs: FileInfo[] = fs.readdirSync(baseDir)
                .filter(name => /^v\d+\.\d+\.\d+/.test(name)) // 仅版本目录（v3.4.1 / v3.4.1-hotfix 等）
                .map(name => {
                    try {
                        const full = path.join(baseDir, name);
                        const stat = fs.statSync(full);
                        if (!stat.isDirectory()) return null;
                        return { name, path: full, mtime: stat.mtime };
                    } catch { return null; }
                })
                .filter((d): d is FileInfo => d !== null)
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // 新的在前

            if (dirs.length > maxVersionDirs) {
                const toDelete = dirs.slice(maxVersionDirs);
                toDelete.forEach(dir => {
                    try {
                        fs.rmSync(dir.path, { recursive: true, force: true });
                        console.log(`[logger] 已清理过旧版本日志目录: ${dir.name}`);
                    } catch (error) {
                        console.error(`删除旧版本日志目录失败: ${dir.name}`, (error as Error).message);
                    }
                });
            }
        } catch (error) {
            console.error('清理旧版本日志目录失败:', (error as Error).message);
        }
    }

    /**
     * 迁移升级前遗留的旧格式日志：基础目录根下的 app*.log / mpv.log（旧版本直接写在 logs/ 根目录）
     * 统一收进 v-legacy/ 子目录，避免与新版版本目录混在一起。
     */
    private migrateLegacyLogs(): void {
        try {
            const baseDir = this.getBaseLogDirectory();
            if (!baseDir || baseDir === this.logDir || !fs.existsSync(baseDir)) return;
            const legacyDir = path.join(baseDir, 'v-legacy');
            const legacyFiles = fs.readdirSync(baseDir).filter(f => {
                if (f === 'mpv.log') return true;
                return /^app(-error)?(-[0-9TZ:-]+)?\.log$/.test(f);
            });
            if (legacyFiles.length === 0) return;
            fs.mkdirSync(legacyDir, { recursive: true });
            for (const f of legacyFiles) {
                try {
                    fs.renameSync(path.join(baseDir, f), path.join(legacyDir, f));
                } catch { /* 文件被占用等，跳过，下次再试 */ }
            }
        } catch { /* ignore */ }
    }

    /**
     * 格式化北京时间
     */
    private formatBeijingTime(): string {
        const now = new Date();
        // 北京时间 = UTC + 8小时
        const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);

        const year = beijingTime.getUTCFullYear();
        const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
        const day = String(beijingTime.getUTCDate()).padStart(2, '0');
        const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
        const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
        const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
        const milliseconds = String(beijingTime.getUTCMilliseconds()).padStart(3, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    /**
     * 格式化日志消息
     */
    private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
        const timestamp = this.formatBeijingTime();
        const levelName = LogLevelNames[level];

        // 对参数进行脱敏处理
        const maskedArgs = maskLogArguments(message, ...args);
        const [maskedMessage, ...restMaskedArgs] = maskedArgs;

        const formattedArgs = restMaskedArgs.length > 0 ? ' ' + restMaskedArgs.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ') : '';

        return `[${timestamp}] [${levelName}] ${maskedMessage}${formattedArgs}`;
    }

    /**
     * 写入日志到文件
     */
    private writeToFile(level: LogLevel, formattedMessage: string): void {
        try {
            // 检查是否需要轮转日志（app.log 与 app-error.log 各自独立轮转）
            this.checkLogRotation();

            // 写入全量日志
            fs.appendFileSync(this.currentLogFile, formattedMessage + '\n', 'utf8');

            // WARN/ERROR 额外写入精简报错日志，便于快速定位问题
            // 注意：排除 NOFORMAT（级别更高，常用于转发 mpv 等外部大日志），避免 error 文件变大
            if (level >= LogLevel.WARN && level <= LogLevel.ERROR) {
                fs.appendFileSync(this.errorLogFile, formattedMessage + '\n', 'utf8');
            }
        } catch (error) {
            console.error('写入日志文件失败:', (error as Error).message);
        }
    }

    /**
     * 设置调试日志过滤（仅影响控制台输出）
     * @param enabled 调试总开关：开 → INFO/DEBUG 按组件开关显示；关 → 控制台仅 WARN/ERROR
     * @param components 各组件开关表（组件 key → 是否显示）；缺省则全部显示
     */
    public setDebugFilter(enabled: boolean, components?: Record<string, boolean>): void {
        this.debugEnabled = !!enabled;
        if (components && typeof components === 'object') {
            this.debugComponents = components;
        }
    }

    /**
     * 通用日志方法（无组件标记，归入 core，调试开时显示）
     */
    public log(level: LogLevel, message: string, ...args: any[]): void {
        this.emit(level, undefined, message, ...args);
    }

    /**
     * 带组件标记的日志方法（用于按组件过滤控制台输出）
     */
    public logC(component: string, level: LogLevel, message: string, ...args: any[]): void {
        this.emit(level, component, message, ...args);
    }

    /**
     * 是否应输出到控制台：WARN/ERROR 始终显示；INFO/DEBUG 受调试总开关与各组件开关控制
     */
    private shouldConsole(level: LogLevel, component: string | undefined): boolean {
        if (!logConfig.consoleOutput) return false;
        if (app && app.isPackaged) return false; // 与原有行为一致：仅非打包(开发/CMD)时输出
        if (level >= LogLevel.WARN) return true;  // 警告/错误始终显示，便于排查
        // INFO / DEBUG
        if (!this.debugEnabled) return false;     // 调试总开关关闭 → 不显示详细日志
        if (!component) return true;              // 无组件标记 → 调试开时显示
        const setting = this.debugComponents[component];
        return setting !== false;                 // 组件未显式关闭(默认开启)则显示
    }

    /**
     * 内部统一输出：写文件 + 按过滤规则决定是否输出到控制台
     */
    private emit(level: LogLevel, component: string | undefined, message: string, ...args: any[]): void {
        if (level >= this.logLevel) {
            // 脱敏（供去重键与格式化复用）
            const maskedArgs = maskLogArguments(message, ...args);
            const [maskedMessage, ...restMaskedArgs] = maskedArgs;

            // 重复日志合并：相同 (级别+内容) 在窗口内只记一次，其余合并为摘要
            if (this.dedupEnabled && level != LogLevel.NOFORMAT) {
                const now = Date.now();
                const key = this.buildDedupKey(level, maskedMessage, restMaskedArgs);
                const existing = this.dedupMap.get(key);
                if (existing) {
                    if (now - existing.firstTs <= this.dedupWindowMs) {
                        // 窗口内连续重复 → 抑制，仅计数
                        existing.count++;
                        existing.lastTs = now;
                        // 持续高频时给出阶段性摘要，避免延迟太久才看到汇总
                        if (existing.count % 100 === 0) {
                            this.flushDedupEntry(key, existing, true);
                            existing.count = 0;
                            existing.firstTs = now;
                        }
                        return;
                    } else {
                        // 窗口已过的旧突发：先结算，再开始新一轮
                        this.flushDedupEntry(key, existing);
                        this.dedupMap.delete(key);
                    }
                }
                const content = (maskedMessage + (restMaskedArgs.length ? ' ' + restMaskedArgs.map(a =>
                    a instanceof Error ? `${a.name}:${a.message}`
                        : (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))
                ).join(' ') : '')).slice(0, 300);
                this.dedupMap.set(key, { count: 1, firstTs: now, lastTs: now, level, content });
            }

            let formattedMessage = message;
            if (level != LogLevel.NOFORMAT) {
                formattedMessage = this.formatMessage(level, message, ...args);
            }

            // 写入文件（始终记录，便于事后排查）
            this.writeToFile(level, formattedMessage);

            // 同时输出到控制台（受调试/组件过滤影响）
            if (this.shouldConsole(level, component)) {
                switch (level) {
                    case LogLevel.DEBUG:
                        console.log(formattedMessage);
                        break;
                    case LogLevel.INFO:
                    case LogLevel.NOFORMAT:
                        console.info(formattedMessage);
                        break;
                    case LogLevel.WARN:
                        console.warn(formattedMessage);
                        break;
                    case LogLevel.ERROR:
                        console.error(formattedMessage);
                        break;
                }
            }
        }
    }

    /**
     * 计算重复日志合并用的去重键（级别 + 脱敏后的内容，不含时间戳）
     */
    private buildDedupKey(level: LogLevel, maskedMessage: string, restMaskedArgs: any[]): string {
        const argStr = restMaskedArgs.map(a => {
            if (a instanceof Error) return `${a.name}:${a.message}`;
            if (typeof a === 'object' && a !== null) {
                try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
        }).join(' ');
        return `${level} ${maskedMessage} ${argStr}`;
    }

    /**
     * 结算一条重复日志突发，写出摘要（仅当重复次数 > 1 才有意义）
     */
    private flushDedupEntry(key: string, entry: { count: number; firstTs: number; lastTs: number; level: LogLevel; content: string }, ongoing = false): void {
        if (entry.count <= 1) return;
        const dur = entry.lastTs - entry.firstTs;
        const tail = ongoing ? '（持续中）' : '';
        const summary = `⏱️ 重复日志合并: 相同内容在 ${dur}ms 内出现 ${entry.count} 次${tail} | [${LogLevelNames[entry.level]}] ${entry.content}`;
        this.writeToFile(LogLevel.WARN, this.formatMessage(LogLevel.WARN, summary));
    }

    /**
     * 定时结算已停止（超过窗口无新相同日志）的突发，避免摘要永远不落盘
     */
    private flushStaleBursts(): void {
        if (!this.dedupEnabled) return;
        const now = Date.now();
        for (const [key, entry] of this.dedupMap) {
            if (now - entry.lastTs >= this.dedupWindowMs) {
                this.flushDedupEntry(key, entry);
                this.dedupMap.delete(key);
            }
        }
    }

    /**
     * Debug级别日志
     */
    public debug(message: string, ...args: any[]): void {
        this.log(LogLevel.DEBUG, message, ...args);
    }

    /**
     * Info级别日志
     */
    public info(message: string, ...args: any[]): void {
        this.log(LogLevel.INFO, message, ...args);
    }

    /**
     * Warn级别日志
     */
    public warn(message: string, ...args: any[]): void {
        this.log(LogLevel.WARN, message, ...args);
    }

    /**
     * Error级别日志
     */
    public error(message: string, ...args: any[]): void {
        // 特殊处理错误对象
        const processedArgs = args.map(arg => {
            if (arg instanceof Error) {
                return maskError(arg);
            }
            return arg;
        });

        this.log(LogLevel.ERROR, message, ...processedArgs);
    }

    /** Noformat级别日志，直接输出不格式化
     */
    public noformat(message: string): void {
        this.log(LogLevel.NOFORMAT, message);
    }

    /**
     * 关键诊断日志：同时写入全量日志(app.log)与精简报错日志(app-error.log)。
     * 用于记录「高层结论 / 关键上下文」（如接口诊断结论、登录成败与方式）。
     * 以 INFO 形式写入 app.log（受日志级别/调试开关影响控制台展示），并镜像进 app-error.log，
     * 便于在精简报错日志里快速看到问题结论，又不会像 NOFORMAT 那样被 mpv 等大日志撑大。
     */
    public key(message: string, ...args: any[]): void {
        const formatted = this.formatMessage(LogLevel.INFO, message, ...args);
        this.appendToBothLogs(formatted);
    }

    /**
     * 同时写入全量日志与报错日志（含各自独立的轮转判断）
     */
    private appendToBothLogs(formatted: string): void {
        try {
            this.checkLogRotation();
            fs.appendFileSync(this.currentLogFile, formatted + '\n', 'utf8');
            fs.appendFileSync(this.errorLogFile, formatted + '\n', 'utf8');
        } catch (error) {
            console.error('写入关键日志失败:', (error as Error).message);
        }
    }

    /**
     * 设置日志级别
     */
    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * 获取当前日志文件路径
     */
    public getCurrentLogFile(): string {
        return this.currentLogFile;
    }

    /**
     * 获取日志目录路径
     */
    public getLogDir(): string {
        return this.logDir;
    }

    /**
     * 获取精简报错日志(app-error.log)路径：仅含 WARN/ERROR，便于快速定位问题
     */
    public getErrorLogFile(): string {
        return this.errorLogFile;
    }
}

// 创建全局日志实例
export const logger = new Logger();

export { LogLevel };
