/**
 * 日志级别枚举
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NOFORMAT = 4 // 不格式化，直接输出
}

/**
 * 日志配置接口
 */
interface LogConfig {
    // 默认日志级别
    defaultLevel: LogLevel;
    
    // 开发环境日志级别
    developmentLevel: LogLevel;
    
    // 生产环境日志级别
    productionLevel: LogLevel;
    
    // 最大文件大小 (字节)
    maxFileSize: number;
    
    // 最大文件数量
    maxFiles: number;
    
    // 是否在控制台也输出日志（开发环境）
    consoleOutput: boolean;
    
    // 日志格式配置
    format: {
        timestamp: boolean;
        level: boolean;
        colors: boolean; // 文件日志不使用颜色
    };
}

/**
 * 日志配置
 */
export const logConfig: LogConfig = {
    // 默认日志级别
    defaultLevel: LogLevel.INFO,
    
    // 开发环境日志级别
    developmentLevel: LogLevel.DEBUG,
    
    // 生产环境日志级别
    productionLevel: LogLevel.INFO,
    
    // 最大文件大小 (字节)
    // 单文件越小，打开越流畅、报错越好定位。之前 10MB 打开很卡，降到 2MB。
    maxFileSize: 2 * 1024 * 1024, // 2MB

    // 最大文件数量（每个前缀：当前文件 + 历史轮转文件）。适当提高到 5，保留更多排查历史。
    maxFiles: 5,
    
    // 是否在控制台也输出日志（开发环境）
    consoleOutput: true,
    
    // 日志格式配置
    format: {
        timestamp: true,
        level: true,
        colors: false // 文件日志不使用颜色
    }
};

/**
 * 根据环境获取适当的日志级别
 */
export function getLogLevel(): LogLevel {
    // 首先检查环境变量
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
        return logConfig.productionLevel;
    }
    
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
        return logConfig.developmentLevel;
    }
    
    // 尝试获取app模块来判断是否为打包环境
    let isPackaged = false;
    try {
        const electron = require('electron');
        const { app } = electron;
        isPackaged = app ? app.isPackaged : false;
        
        // 如果成功获取到app对象，则使用isPackaged判断
        return isPackaged ? logConfig.productionLevel : logConfig.developmentLevel;
    } catch (error) {
        // 在非Electron环境中，如果没有明确的环境变量，默认为开发环境
        return logConfig.developmentLevel;
    }
}
