/**
 * Proxy守护程序模块
 * 负责管理proxy进程的生命周期，防止异常中断和休眠导致进程被杀
 */

import { ChildProcess } from 'child_process';
import { app, dialog } from 'electron';
import * as log from '../../modules/logger';

interface ProxyDaemonConfig {
    restartDelay?: number;           // 重启延迟（毫秒），默认3秒
    maxRestartAttempts?: number;     // 最大重启次数，默认5次
    restartAttemptResetTime?: number; // 重启计数重置时间（毫秒），默认60秒
    enableHeartbeat?: boolean;       // 是否启用心跳检测，默认true
    heartbeatInterval?: number;      // 心跳检测间隔（毫秒），默认5秒
}

export class ProxyDaemon {
    private proxyProcess: ChildProcess | null = null;
    private isShuttingDown: boolean = false;
    private restartAttempts: number = 0;
    private lastRestartTime: number = 0;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private restartResetTimer: NodeJS.Timeout | null = null;
    private config: Required<ProxyDaemonConfig>;
    private onRestart?: (attempts: number) => void;
    /** 同一个进程的退出只处理一次：'exit' 监听器与心跳轮询可能对同一具死进程各触发一次 */
    private exitHandled = new WeakSet<ChildProcess>();

    constructor(config: ProxyDaemonConfig = {}) {
        this.config = {
            restartDelay: config.restartDelay ?? 3000,
            maxRestartAttempts: config.maxRestartAttempts ?? 5,
            restartAttemptResetTime: config.restartAttemptResetTime ?? 60000,
            enableHeartbeat: config.enableHeartbeat ?? true,
            heartbeatInterval: config.heartbeatInterval ?? 5000,
        };
    }

    /**
     * 设置proxy进程实例并启动守护
     */
    public watchProcess(process: ChildProcess, onRestart?: (attempts: number) => void): void {
        this.proxyProcess = process;
        this.onRestart = onRestart;

        // 监听进程异常退出
        const p = process;
        p.on('exit', (code, signal) => {
            this.handleProcessExit(code, signal, p);
        });

        p.on('error', (error) => {
            log.error('Proxy进程错误:', error.message);
        });

        // 启动心跳检测
        if (this.config.enableHeartbeat) {
            this.startHeartbeat();
        }

        log.info('Proxy守护程序已启动');
    }

    /**
     * 处理进程退出事件
     */
    private handleProcessExit(code: number | null, signal: string | null, proc?: ChildProcess | null): void {
        if (this.isShuttingDown) {
            log.info('Proxy进程正常关闭，退出码:', code);
            return;
        }

        if (proc) {
            if (this.exitHandled.has(proc)) return;
            this.exitHandled.add(proc);
        }

        log.warn(`Proxy进程意外退出 - 退出码: ${code}, 信号: ${signal}`);

        // 检查是否超过最大重启次数
        if (this.restartAttempts >= this.config.maxRestartAttempts) {
            const errorMsg = `Proxy进程频繁异常退出，已达到最大重启次数 (${this.config.maxRestartAttempts})，应用即将退出`;
            log.error(errorMsg);
            
            // 显示用户友好的错误提示
            dialog.showMessageBox({
                type: 'error',
                title: '应用即将退出',
                message: '飞牛影视的核心服务（Proxy）多次启动失败，无法继续运行。',
                buttons: ['退出应用']
            }).then(() => {
                // 延迟退出，确保日志和清理操作能够完成
                setTimeout(() => {
                    log.info('执行主进程退出');
                    app.quit();
                }, 500);
            }).catch(() => {
                // 如果弹窗显示失败，直接退出
                setTimeout(() => {
                    log.info('执行主进程退出');
                    app.quit();
                }, 500);
            });
            return;
        }

        // 增加重启计数
        this.restartAttempts++;

        // 重置重启计数器定时器
        this.resetRestartAttemptCounter();

        // 回调通知应用尝试重启
        if (this.onRestart) {
            log.info(`准备重启Proxy进程 (第 ${this.restartAttempts} 次尝试)...`);
            this.onRestart(this.restartAttempts);
        }

        this.lastRestartTime = Date.now();
    }

    /**
     * 重置重启尝试计数
     */
    private resetRestartAttemptCounter(): void {
        // 清除旧的定时器
        if (this.restartResetTimer) {
            clearTimeout(this.restartResetTimer);
        }

        // 在指定时间后重置计数
        this.restartResetTimer = setTimeout(() => {
            if (this.restartAttempts > 0) {
                log.info(`重启计数已重置 (之前: ${this.restartAttempts} 次)`);
                this.restartAttempts = 0;
            }
        }, this.config.restartAttemptResetTime);
    }

    /**
     * 启动心跳检测
     * [lc-1004] 原来判据是 proxyProcess.killed —— 该字段只有「我们自己调过 kill()」才为 true，
     * proxy.exe 崩溃 / 被外部（任务管理器、杀软）杀掉时恒为 false，心跳等于形同虚设，
     * 22346 死了也永不重启。改为查真实退出状态 exitCode / signalCode。
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();

        this.heartbeatTimer = setInterval(() => {
            const p = this.proxyProcess;
            if (!p || this.isShuttingDown) return;
            if (p.exitCode !== null || p.signalCode !== null) {
                log.warn(`心跳检测：Proxy进程已退出 (exitCode=${p.exitCode}, signalCode=${p.signalCode})`);
                this.handleProcessExit(p.exitCode, p.signalCode, p);
            }
        }, this.config.heartbeatInterval);
    }

    /**
     * 停止心跳检测
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 更新进程实例（用于重启后）
     */
    public updateProcess(process: ChildProcess, onRestart?: (attempts: number) => void): void {
        if (this.proxyProcess) {
            this.proxyProcess.removeAllListeners();
        }

        this.watchProcess(process, onRestart ?? this.onRestart);
        log.info('Proxy进程实例已更新');
    }

    /**
     * 正常关闭守护程序和proxy进程
     */
    public async shutdown(): Promise<void> {
        log.info('Proxy守护程序正在关闭...');
        this.isShuttingDown = true;

        this.stopHeartbeat();

        if (this.restartResetTimer) {
            clearTimeout(this.restartResetTimer);
        }

        // [lc-1004] 用真实退出状态判活。原来用 !killed：进程已崩溃时 killed 仍为 false，
        // 会挂一个永不触发的 'exit' 监听、白等满 5s 超时再去 kill 一具死进程，拖慢退出。
        const alive = this.proxyProcess && this.proxyProcess.exitCode === null && this.proxyProcess.signalCode === null;
        if (alive) {
            const proc = this.proxyProcess!;
            return new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    log.warn('Proxy进程关闭超时，强制杀死进程');
                    proc.kill('SIGKILL');
                    resolve();
                }, 5000);

                proc.on('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });

                // 先尝试温和关闭
                proc.kill('SIGTERM');
            });
        }

        log.info('Proxy守护程序已关闭');
    }

    /**
     * 获取当前代理进程
     */
    public getProcess(): ChildProcess | null {
        return this.proxyProcess;
    }

    /**
     * 获取重启尝试次数
     */
    public getRestartAttempts(): number {
        return this.restartAttempts;
    }

    /**
     * 获取是否正在关闭
     */
    public isShutdownInProgress(): boolean {
        return this.isShuttingDown;
    }
}

// 全局实例
let daemonInstance: ProxyDaemon | null = null;

/**
 * 获取或创建守护程序实例
 */
export function getDaemonInstance(config?: ProxyDaemonConfig): ProxyDaemon {
    if (!daemonInstance) {
        daemonInstance = new ProxyDaemon(config);
    }
    return daemonInstance;
}

/**
 * 重置全局实例（主要用于测试和重启场景）
 */
export function resetDaemonInstance(): void {
    if (daemonInstance) {
        daemonInstance.shutdown().catch((error) => {
            log.error('关闭守护程序时出错:', error);
        });
    }
    daemonInstance = null;
}
