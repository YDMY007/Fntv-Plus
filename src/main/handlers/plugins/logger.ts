import { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';

/**
 * 日志管理插件
 * 处理渲染进程的日志消息
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// 处理渲染进程日志消息
function handleLogMessage(event: IpcMainInvokeEvent, level: LogLevel, ...args: any[]): void {
    try {
        // EmbyWall 渲染日志：msg 以 [EmbyWall] 开头，走组件过滤(受 embywall 独立开关控制)
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[EmbyWall]')) {
            log.getLogger().logC('embywall', level as any, '[Renderer]', ...args);
            return;
        }
        // 根据级别调用对应的日志方法
        switch (level) {
            case 'debug':
                log.debug('[Renderer]', ...args);
                break;
            case 'info':
                log.info('[Renderer]', ...args);
                break;
            case 'warn':
                log.warn('[Renderer]', ...args);
                break;
            case 'error':
                log.error('[Renderer]', ...args);
                break;
            default:
                log.info('[Renderer]', ...args);
        }
    } catch (error) {
        // 如果日志记录失败，至少在控制台输出
        log.error('日志记录失败:', error);
        log.info('[Renderer]', level, ...args);
    }
}

// [lc-1283] 批量通道：渲染端 500ms 合流后一次发送（条目 = [level, ...args]）。
// 逐条复用单条路由逻辑（EmbyWall 组件过滤/级别分发不变），
// 整批经 beginBatch..endBatch 只做一次轮转检查 + 一次文件落盘。
// begin..end 之间全同步、无 await，不会与其它写入交错。
function handleLogMessageBatch(event: IpcMainInvokeEvent, batch: any[]): void {
    if (!Array.isArray(batch)) return;
    log.getLogger().beginBatch();
    try {
        for (const entry of batch) {
            if (!Array.isArray(entry) || entry.length === 0) continue;
            handleLogMessage(event, entry[0], ...entry.slice(1));
        }
    } finally {
        log.getLogger().endBatch();
    }
}

// 注册日志相关处理器
function init(): void {
    registerHandler('log-message', handleLogMessage, { useHandle: true });
    registerHandler('log-message-batch', handleLogMessageBatch, { useHandle: true });
}

export {
    init
};
