// preload/logger.ts - 渲染进程日志接口
import { ipcRenderer } from 'electron';
import type { Logger } from './types';

/**
 * 渲染进程日志模块
 * 通过IPC将日志发送到主进程进行处理
 * 主进程会自动进行数据脱敏，对渲染进程完全透明
 */
/** [lc-1333] 统一日志出口（可选）。web/diag 会注册一个 sink，把 payload 的每条日志
 *  一并回传到 client.log —— 飞牛 App 的 WebView 不可调试（release + 非 debuggable 进程），
 *  这是设备内唯一可读的日志通道（管理页「实时日志」直接看）。桌面端不注册。 */
type LogSink = (level: string, msg: string) => void;
let _sink: LogSink | null = null;
export function setLogSink(fn: LogSink | null): void { _sink = fn; }
function emitSink(level: string, args: any[]): void {
    if (!_sink) return;
    try {
        _sink(level, args.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
    } catch { /* ignore */ }
}

const preloadLogger: Logger = {
    debug: (...args: any[]): void => {
        emitSink('debug', args);
        try {
            ipcRenderer.invoke('log-message', 'debug', ...args);
        } catch (error) {
            // 如果IPC不可用，回退到console（仅在开发环境）
            if (process.env.NODE_ENV === 'development') {
                console.debug(...args);
            }
        }
    },
    
    info: (...args: any[]): void => {
        emitSink('info', args);
        try {
            ipcRenderer.invoke('log-message', 'info', ...args);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.info(...args);
            }
        }
    },
    
    warn: (...args: any[]): void => {
        emitSink('warn', args);
        try {
            ipcRenderer.invoke('log-message', 'warn', ...args);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.warn(...args);
            }
        }
    },
    
    error: (...args: any[]): void => {
        emitSink('error', args);
        try {
            ipcRenderer.invoke('log-message', 'error', ...args);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.error(...args);
            }
        }
    },
    
    log: (...args: any[]): void => {
        emitSink('info', args);
        try {
            ipcRenderer.invoke('log-message', 'info', ...args);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.log(...args);
            }
        }
    },
    
    // 方便的方法别名
    d: (...args: any[]): void => preloadLogger.debug(...args),   // debug简写
    i: (...args: any[]): void => preloadLogger.info(...args),    // info简写
    w: (...args: any[]): void => preloadLogger.warn(...args),    // warn简写
    e: (...args: any[]): void => preloadLogger.error(...args),   // error简写
};

export default preloadLogger;
