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
    // 调试日志过滤：总开关 + 各组件开关（仅影响控制台输出，不影响文件）
    private debugEnabled = false;
    private debugComponents: Record<string, boolean> = {};

    constructor() {
        this.logLevel = getLogLevel(); // 使用配置获取日志级别
        this.maxFileSize = logConfig.maxFileSize;
        this.maxFiles = logConfig.maxFiles;
        this.logDir = this.getLogDirectory();
        this.currentLogFile = path.join(this.logDir, 'app.log');

        // 确保日志目录存在
        this.ensureLogDirectory();

        // 初始化时检查并清理旧的日志文件
        this.cleanupOldLogs();
    }

    /**
     * 获取日志目录路径
     */
    private getLogDirectory(): string {
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
     * 检查并轮转日志文件
     */
    private checkLogRotation(): void {
        try {
            if (fs.existsSync(this.currentLogFile)) {
                const stats = fs.statSync(this.currentLogFile);
                if (stats.size >= this.maxFileSize) {
                    this.rotateLogFile();
                }
            }
        } catch (error) {
            console.error('检查日志轮转失败:', (error as Error).message);
        }
    }

    /**
     * 轮转日志文件
     */
    private rotateLogFile(): void {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedFile = path.join(this.logDir, `app-${timestamp}.log`);

            // 移动当前日志文件
            if (fs.existsSync(this.currentLogFile)) {
                fs.renameSync(this.currentLogFile, rotatedFile);
            }

            // 清理超过限制的旧日志文件
            this.cleanupOldLogs();
        } catch (error) {
            console.error('轮转日志文件失败:', (error as Error).message);
        }
    }

    /**
     * 清理旧的日志文件，只保留最近的几个
     */
    private cleanupOldLogs(): void {
        try {
            const files: FileInfo[] = fs.readdirSync(this.logDir)
                .filter(file => file.startsWith('app-') && file.endsWith('.log'))
                .map(file => ({
                    name: file,
                    path: path.join(this.logDir, file),
                    mtime: fs.statSync(path.join(this.logDir, file)).mtime
                }))
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // 按修改时间降序排列

            // 删除超过保留数量的文件
            if (files.length > this.maxFiles - 1) { // -1 因为当前日志文件不在这个列表中
                const filesToDelete = files.slice(this.maxFiles - 1);
                filesToDelete.forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                    } catch (error) {
                        console.error(`删除旧日志文件失败: ${file.name}`, (error as Error).message);
                    }
                });
            }
        } catch (error) {
            console.error('清理旧日志文件失败:', (error as Error).message);
        }
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
    private writeToFile(formattedMessage: string): void {
        try {
            // 检查是否需要轮转日志
            this.checkLogRotation();

            // 写入日志
            fs.appendFileSync(this.currentLogFile, formattedMessage + '\n', 'utf8');
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
            let formattedMessage = message;
            if (level != LogLevel.NOFORMAT) {
                formattedMessage = this.formatMessage(level, message, ...args);
            }

            // 写入文件（始终记录，便于事后排查）
            this.writeToFile(formattedMessage);

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
}

// 创建全局日志实例
export const logger = new Logger();

export { LogLevel };
