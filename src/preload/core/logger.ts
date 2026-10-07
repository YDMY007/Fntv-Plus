// preload/logger.ts - 渲染进程日志接口
import { ipcRenderer } from 'electron';
import type { Logger } from './types';

/**
 * 渲染进程日志模块
 * 通过IPC将日志发送到主进程进行处理
 * 主进程会自动进行数据脱敏，对渲染进程完全透明
 *
 * [lc-1283] 批量合流：原先每打一行就是一次 ipcRenderer.invoke 往返，主进程每行
 * 一次轮转检查(statSync)+一次同步写盘(appendFileSync)。现改为 500ms 尾随批量发送
 * （满 LOG_FLUSH_MAX 条提前冲刷，error 级不等窗口立即冲刷），主进程 'log-message-batch'
 * 收到后整批复用单条路由逻辑、只做一次落盘。主进程不识别批量通道（热补丁版本偏差等）
 * 时自动逐条回退老通道，宁慢不丢。
 */

type LogEntry = any[];

const LOG_FLUSH_MS = 500;
const LOG_FLUSH_MAX = 100;
let _logQueue: LogEntry[] = [];
let _logFlushTimer: ReturnType<typeof setTimeout> | null = null;

function _flushLogsFallbackPerLine(batch: LogEntry[]): void {
    for (const entry of batch) {
        try {
            ipcRenderer.invoke('log-message', ...entry).catch(() => { /* ignore */ });
        } catch (error) {
            // IPC 完全不可用：仅在开发环境回退 console（与单条版行为一致）
            if (process.env.NODE_ENV === 'development') {
                (console as any)[entry[0] === 'warn' ? 'warn' : entry[0] === 'error' ? 'error' : 'log'](...entry.slice(1));
            }
        }
    }
}

function _flushLogs(): void {
    if (_logFlushTimer !== null) {
        clearTimeout(_logFlushTimer);
        _logFlushTimer = null;
    }
    if (_logQueue.length === 0) return;
    const batch = _logQueue;
    _logQueue = [];
    try {
        ipcRenderer.invoke('log-message-batch', batch).catch(() => {
            // 主进程无批量通道（版本偏差）：逐条走老通道
            _flushLogsFallbackPerLine(batch);
        });
    } catch (error) {
        _flushLogsFallbackPerLine(batch);
    }
}

function _enqueueLog(level: string, args: any[], immediate: boolean): void {
    _logQueue.push([level, ...args]);
    if (immediate || _logQueue.length >= LOG_FLUSH_MAX) {
        _flushLogs();
        return;
    }
    if (_logFlushTimer === null) {
        _logFlushTimer = setTimeout(_flushLogs, LOG_FLUSH_MS);
    }
}

// 页面卸载前尽量把未落盘的日志带出去（尽力而为，卸载后 IPC 不保证送达）
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', _flushLogs);
}

const preloadLogger: Logger = {
    debug: (...args: any[]): void => {
        try {
            _enqueueLog('debug', args, false);
        } catch (error) {
            // 如果IPC不可用，回退到console（仅在开发环境）
            if (process.env.NODE_ENV === 'development') {
                console.debug(...args);
            }
        }
    },

    info: (...args: any[]): void => {
        try {
            _enqueueLog('info', args, false);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.info(...args);
            }
        }
    },

    warn: (...args: any[]): void => {
        try {
            _enqueueLog('warn', args, false);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.warn(...args);
            }
        }
    },

    error: (...args: any[]): void => {
        try {
            // error 级不等批量窗口：立即冲刷（连同队列中已有的低级别日志）
            _enqueueLog('error', args, true);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.error(...args);
            }
        }
    },

    log: (...args: any[]): void => {
        try {
            _enqueueLog('info', args, false);
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
