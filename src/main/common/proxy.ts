import { app, BrowserWindow, dialog, Notification } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { registerAllPlugins } from '../handlers';
import { getInstance as getUpdateChecker } from '../../modules/updater/updateChecker';
import * as winctrl from './winctrl';
import { createTray, showTrayNotification, destroyTray } from './tray';
import { getMacCloseAction, setMacCloseAction, getTrayNotificationShown, setTrayNotificationShown } from './preferences';
import * as log from '../../modules/logger';
import { getDaemonInstance, ProxyDaemon } from './proxyDaemon';
import { playbackShim } from './playbackShim';


// 全局守护程序实例
let proxyDaemon: ProxyDaemon | null = null;
let restartScheduled = false;

// Go proxy 实际监听的端口（与 proxy/pkg/fnapi、main.go 中 RunApiServer("127.0.0.1:22346") 一致）
const PROXY_PORT = 22346;

/**
 * 探测本地端口是否在监听（用于确认 Go proxy 真正就绪，而非仅凭进程对象存在就误判为成功）。
 * 成功返回 true，timeoutMs 内都连不上返回 false。
 */
function probePort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        const attempt = () => {
            const sock = net.connect(port, '127.0.0.1');
            let done = false;
            const finish = (ok: boolean) => {
                if (done) return;
                done = true;
                sock.destroy();
                resolve(ok);
            };
            sock.once('connect', () => finish(true));
            sock.once('error', () => {
                sock.destroy();
                if (Date.now() - start >= timeoutMs) finish(false);
                else setTimeout(attempt, 250);
            });
        };
        attempt();
    });
}

// 获取应用中的proxy可执行文件路径
function getProxyExecPath(): string {
    // [lc-653] 二进制覆盖层：热补丁若写入 userData/patches/bin/proxy(.exe)，
    // 优先使用覆盖层版本（Go 代理修复可经热补丁生效，无需全量包）。
    try {
        const overlayBin = process.env.FNTV_PATCHES_DIR
            || path.join(app.getPath('userData'), 'patches');
        const overlayExe = process.platform === 'win32'
            ? path.join(overlayBin, 'bin', 'proxy.exe')
            : path.join(overlayBin, 'bin', 'proxy');
        if (fs.existsSync(overlayExe)) {
            log.info(`[proxy] 使用覆盖层二进制: ${overlayExe}`);
            return overlayExe;
        }
    } catch { /* 覆盖层不可用时回退安装目录 */ }

    // 检查是否在开发环境（未打包）
    if (!app.isPackaged) {
        // 未打包时使用相对路径
        return process.platform === 'win32' 
            ? ".\\third_party\\proxy\\proxy.exe"
            : "./third_party/proxy/proxy";
    }

    // 已打包情况下的路径处理
    if (process.platform === 'darwin') {
        // macOS: third_party目录在应用包的Contents目录下，而不是在app.asar内
        const appPath = app.getAppPath();
        const contentsPath = path.dirname(path.dirname(appPath)); // 从app.asar向上两级到Contents
        return path.join(contentsPath, 'third_party', 'proxy', 'proxy');
    } else if (process.platform === 'win32') {
        // Windows: extraFiles 把 third_party 复制到了 exe 同级目录。
        // 必须用 exe 所在目录拼【绝对路径】，否则从开始菜单/快捷方式/UAC 启动时
        // 进程 cwd 未必是安装目录，相对路径 ".\\third_party\\proxy\\proxy.exe"
        // 会解析失败 -> existsSync=false -> 代理启动抛错 -> 主进程在创建窗口前即退出(表现为"打不开")。
        return path.join(path.dirname(app.getPath('exe')), 'third_party', 'proxy', 'proxy.exe');
    } else {
        // Linux: 构建时只复制了proxy目录内容到third_party/proxy
        const appPath = app.getAppPath();
        const contentsPath = path.dirname(path.dirname(appPath));
        return path.join(contentsPath, 'third_party', 'proxy', 'proxy');
    }
}

// 启动proxy模块的函数
export async function startProxyProcess(): Promise<ChildProcess> {
    const proxyPath = getProxyExecPath();

    // 检查可执行文件是否存在
    if (!fs.existsSync(proxyPath)) {
        const errorMsg = `Proxy可执行文件不存在`;
        const detailMsg = `文件路径: ${proxyPath}\n\n请确保已正确编译proxy模块。\n编译命令: npm run build:proxy`;
        log.error(errorMsg + ': ' + proxyPath);
        dialog.showErrorBox('启动失败 - 文件不存在', errorMsg + '\n\n' + detailMsg);
        throw new Error(errorMsg);
    }

    try {
        // 启动proxy进程
        const proxyProcess = spawn(proxyPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
            env: { ...process.env, LANG: 'C.UTF-8' } // 设置UTF-8编码环境
        });

        log.info('正在启动proxy进程...');

        // 等待proxy进程真正在 22346 监听就绪（不再仅凭"进程对象存在"误判为成功）
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const stderrBuf: string[] = [];
            const fail = (msg: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearInterval(poll);
                const detail = stderrBuf.join('').slice(-1000);
                reject(new Error(msg + (detail ? `\n--- proxy stderr ---\n${detail}` : '')));
            };
            const timeout = setTimeout(() => {
                fail(`Proxy进程启动超时: 10秒内未在 127.0.0.1:${PROXY_PORT} 监听到监听\n可执行文件: ${proxyPath}`);
            }, 10000); // 10秒超时

            // 进程直接报错（如文件损坏/无法执行）
            proxyProcess.on('error', (error) => {
                fail(`Proxy进程启动失败: ${error.message}\n可执行文件: ${proxyPath}`);
            });
            // 进程在就绪前退出（崩溃）—— 此前被 2 秒 !killed 兜底掩盖为"成功"，正是播放 22346 全 reset 的根因
            proxyProcess.on('exit', (code, signal) => {
                if (!settled) fail(`Proxy进程在就绪前退出 (code=${code} signal=${signal})，22346 不会监听`);
            });

            proxyProcess.stdout?.on('data', (data) => {
                log.noformat(data.toString('utf8'));
            });
            proxyProcess.stderr?.on('data', (data) => {
                const output = data.toString('utf8');
                stderrBuf.push(output);
                log.error('Proxy stderr:', output);
            });

            // 轮询端口就绪：真正连上才视为成功，避免"日志早于 bind"或"进程已死却误判成功"
            const poll = setInterval(() => {
                if (settled) { clearInterval(poll); return; }
                probePort(PROXY_PORT, 800).then((ok) => {
                    if (ok && !settled) {
                        settled = true;
                        clearTimeout(timeout);
                        clearInterval(poll);
                        resolve();
                    }
                });
            }, 300);
        });

        log.info('Proxy模块启动成功');

        // 启动本地播放 shim（PotPlayer 经可读名 URL 代理访问真实 proxy，兼顾续播与可读列表）
        try {
            await playbackShim.start();
        } catch (e: any) {
            log.warn('[playbackShim] 启动失败(已忽略，PotPlayer 列表将回退为原始 URL):', e?.message || e);
        }

        // 初始化或更新守护程序
        if (!proxyDaemon) {
            proxyDaemon = getDaemonInstance({
                restartDelay: 3000,
                maxRestartAttempts: 5,
                restartAttemptResetTime: 60000,
                enableHeartbeat: true,
                heartbeatInterval: 5000,
            });
        }

        // 设置重启回调
        const handleProxyRestart = async (attempts: number) => {
            if (restartScheduled) return;
            restartScheduled = true;

            // 延迟重启，避免频繁重启
            setTimeout(async () => {
                try {
                    log.info(`尝试重启Proxy进程 (第 ${attempts} 次)...`);
                    const newProxyProcess = await startProxyProcessInternal();
                    if (proxyDaemon) {
                        proxyDaemon.updateProcess(newProxyProcess);
                    }
                    restartScheduled = false;
                } catch (error) {
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    log.error('Proxy进程重启失败:', errorObj.message);
                    restartScheduled = false;
                }
            }, 3000);
        };

        // 启用守护程序监控
        proxyDaemon.watchProcess(proxyProcess, handleProxyRestart);

        return proxyProcess;

    } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const errorMsg = `启动proxy模块失败`;
        const detailMsg = `错误详情: ${errorObj.message}\n\n这通常表示:\n• Proxy程序无法正常启动\n• 网络或端口配置问题\n• 系统环境配置错误\n\n请检查上述错误详情并尝试解决。\n如果问题持续，请查看应用程序日志获取更多信息。`;
        log.error(errorMsg + ': ' + errorObj.message);
        dialog.showErrorBox('启动失败', errorMsg + '\n\n' + detailMsg);
        throw error;
    }
}

/**
 * 内部启动函数（用于重启）
 */
async function startProxyProcessInternal(): Promise<ChildProcess> {
    const proxyPath = getProxyExecPath();

    // 启动proxy进程
    const proxyProcess = spawn(proxyPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, LANG: 'C.UTF-8' }
    });

    log.info('正在启动proxy进程（重启）...');

    // 等待proxy进程真正在 22346 监听就绪（与 startProxyProcess 一致：端口探测 + 退出检测）
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const stderrBuf: string[] = [];
        const fail = (msg: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(poll);
            const detail = stderrBuf.join('').slice(-1000);
            reject(new Error(msg + (detail ? `\n--- proxy stderr ---\n${detail}` : '')));
        };
        const timeout = setTimeout(() => {
            fail(`Proxy进程重启启动超时: 10秒内未在 127.0.0.1:${PROXY_PORT} 监听到监听`);
        }, 10000);

        proxyProcess.on('error', (error) => fail(`Proxy进程重启启动失败: ${error.message}`));
        proxyProcess.on('exit', (code, signal) => {
            if (!settled) fail(`Proxy进程在就绪前退出 (code=${code} signal=${signal})，22346 不会监听`);
        });

        proxyProcess.stdout?.on('data', (data) => {
            log.noformat(data.toString('utf8'));
        });
        proxyProcess.stderr?.on('data', (data) => {
            const output = data.toString('utf8');
            stderrBuf.push(output);
            log.error('Proxy stderr:', output);
        });

        const poll = setInterval(() => {
            if (settled) { clearInterval(poll); return; }
            probePort(PROXY_PORT, 800).then((ok) => {
                if (ok && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    clearInterval(poll);
                    resolve();
                }
            });
        }, 300);
    });

    return proxyProcess;
}

/**
 * 优雅关闭Proxy进程（用于应用退出）
 */
export async function shutdownProxyProcess(): Promise<void> {
    if (proxyDaemon) {
        await proxyDaemon.shutdown();
        proxyDaemon = null;
    }
    playbackShim.stop();
}