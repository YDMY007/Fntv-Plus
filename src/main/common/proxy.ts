import { app, BrowserWindow, dialog, Notification } from 'electron';
import { spawn, execSync, ChildProcess } from 'child_process';
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

/** 子进程是否还没退出（.killed 只表示"我们主动 kill 过"，进程自己崩溃时恒为 false） */
function isAlive(p: ChildProcess): boolean {
    return p.exitCode === null && p.signalCode === null;
}

/** 找出正在监听 port 的进程 PID；端口空闲或查询失败返回 null。
 *  返回值一定是正整数 —— 它会被拼进 execSync 的命令串，必须从源头杜绝 shell 元字符。 */
function findPortOwnerPid(port: number): number | null {
    const run = (cmd: string): string => {
        try {
            return execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '';
        } catch {
            return ''; // 端口空闲时 lsof 会非零退出，属正常
        }
    };
    const toPid = (v: number): number | null => (Number.isInteger(v) && v > 0 ? v : null);
    if (process.platform === 'win32') {
        for (const line of run('netstat -ano -p tcp').split(/\r?\n/)) {
            // TCP    127.0.0.1:22346        0.0.0.0:0              LISTENING       12345
            const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
            if (m && Number(m[1]) === port) return toPid(Number(m[2]));
        }
        return null;
    }
    const pid = parseInt(run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).trim().split(/\r?\n/)[0] || '', 10);
    return toPid(pid);
}

/** 取 PID 的进程名（小写）；查不到返回空串 */
function processNameOf(pid: number): string {
    if (!Number.isInteger(pid) || pid <= 0) return '';
    try {
        if (process.platform === 'win32') {
            const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
                { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '';
            const m = /^"([^"]+)"/.exec(out.trim());
            return m ? m[1].toLowerCase() : '';
        }
        const out = execSync(`ps -p ${pid} -o comm=`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '';
        return out.trim().toLowerCase();
    } catch {
        return '';
    }
}

/**
 * [lc-1004] 启动前清理占着 PROXY_PORT 的孤儿 proxy 进程。
 *
 * 为什么必须清：Windows 不传播 SIGTERM，主进程被强杀（任务管理器结束、崩溃、断电）时
 * 子进程 proxy.exe 会变孤儿继续监听 22346。下一次启动时：
 *   ① 新 proxy.exe bind 失败 → panic（main.go:14），但它的 stderr 要被 waitProxyReady 收到才算数；
 *   ② 而 probePort 只回答"端口有没有人监听"，孤儿在听 → 立刻判定"就绪"；
 *   ③ 于是应用认为代理正常，实际所有播放请求都打到那个孤儿上 —— 它的 stdout 读端已随旧主进程
 *      消失，Go 一写日志就阻塞，请求全部无响应（实测形态：连接建立后读 0 字节直到超时）。
 * 应用是单实例的（main.ts requestSingleInstanceLock），所以此刻还在监听的必然是孤儿，
 * 与 main.ts 启动时 taskkill 清理残留 FNMedia.exe 是同一套思路。
 *
 * 只在确认进程名就是我们自己的 proxy 时才动手，避免误杀恰好占用该端口的无关程序。
 */
async function killOrphanProxy(port: number): Promise<void> {
    const pid = findPortOwnerPid(port);
    if (!pid || pid === process.pid) return;

    const name = processNameOf(pid);
    if (!/(^|[\\/])proxy(\.exe)?$/.test(name)) {
        log.error(`[proxy] 端口 ${port} 被无关进程占用 (pid=${pid} name=${name || '未知'})，不会强杀；请手动释放该端口后重启应用`);
        return;
    }

    log.warn(`[proxy] 发现上次运行残留的孤儿 ${name} (pid=${pid}) 仍占着 ${port}，清理中`);
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch (e: any) {
        log.error(`[proxy] 清理孤儿进程失败: ${e?.message || e}`);
        return;
    }

    // 等端口真正释放，否则新进程照样 bind 失败
    for (let i = 0; i < 25; i++) {
        if (findPortOwnerPid(port) === null) {
            log.info(`[proxy] 孤儿进程已清理，${port} 已释放`);
            return;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    log.error(`[proxy] 孤儿进程已杀但 ${port} 仍被占用，新代理可能无法监听`);
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

/** 取得（必要时创建）全局守护实例 */
function ensureDaemon(): ProxyDaemon {
    if (!proxyDaemon) {
        proxyDaemon = getDaemonInstance({
            restartDelay: 3000,
            maxRestartAttempts: 5,
            restartAttemptResetTime: 60000,
            enableHeartbeat: true,
            heartbeatInterval: 5000,
        });
    }
    return proxyDaemon;
}

/**
 * 启动一个 proxy 子进程并等它真正就绪。首次启动与守护重启共用。
 *
 * [lc-1004] 就绪判定必须同时满足两条：**端口能连上** 且 **是我们自己 spawn 的这个进程还活着**。
 * 原先只看端口，于是上次运行残留的孤儿 proxy.exe 在听时会立刻被判为"就绪"，而新进程其实
 * bind 失败 panic 了 —— 应用以为代理正常，所有播放请求都打到那个孤儿上（见 killOrphanProxy）。
 */
async function spawnAndWaitReady(tag: string): Promise<ChildProcess> {
    const proxyPath = getProxyExecPath();

    // 端口被孤儿占着的话，新进程必定 bind 失败，先清掉
    await killOrphanProxy(PROXY_PORT);

    const proxyProcess = spawn(proxyPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, LANG: 'C.UTF-8' } // 设置UTF-8编码环境
    });

    log.info(`正在启动proxy进程${tag}... (pid=${proxyProcess.pid})`);

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const stderrBuf: string[] = [];
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(poll);
            fn();
        };
        const fail = (msg: string) => finish(() => {
            const detail = stderrBuf.join('').slice(-1000);
            reject(new Error(msg + (detail ? `\n--- proxy stderr ---\n${detail}` : '')));
        });

        const timeout = setTimeout(() => {
            fail(`Proxy进程启动超时: 10秒内未在 127.0.0.1:${PROXY_PORT} 监听到监听\n可执行文件: ${proxyPath}`);
        }, 10000); // 10秒超时

        // 进程直接报错（如文件损坏/无法执行）
        proxyProcess.on('error', (error) => {
            fail(`Proxy进程启动失败: ${error.message}\n可执行文件: ${proxyPath}`);
        });
        // [lc-1004] 就绪之后再退出也必须留痕：原先 fail() 里的 `if (settled) return` 会把它彻底吞掉，
        // 于是"进程早就死了但应用以为正常"这类故障在日志里毫无痕迹，只能靠猜。
        proxyProcess.on('exit', (code, signal) => {
            if (settled) {
                log.error(`[proxy] Proxy进程在就绪后退出 (code=${code} signal=${signal})`);
                return;
            }
            fail(`Proxy进程在就绪前退出 (code=${code} signal=${signal})，22346 不会由本进程监听`);
        });

        proxyProcess.stdout?.on('data', (data) => {
            log.noformat(data.toString('utf8'));
        });
        proxyProcess.stderr?.on('data', (data) => {
            const output = data.toString('utf8');
            stderrBuf.push(output);
            if (stderrBuf.length > 40) stderrBuf.shift(); // 只留最近的，长跑期不涨内存
            log.error('Proxy stderr:', output);
        });

        // 轮询端口就绪：真正连上、且进程还活着，才视为成功
        const poll = setInterval(() => {
            if (settled) { clearInterval(poll); return; }
            if (!isAlive(proxyProcess)) {
                fail('Proxy进程在就绪前退出，22346 不会由本进程监听');
                return;
            }
            probePort(PROXY_PORT, 800).then((ok) => {
                // 端口通了还要确认是**我们的**进程在听，而不是恰好还活着的孤儿
                if (ok && !settled && isAlive(proxyProcess)) finish(resolve);
            });
        }, 300);
    });

    return proxyProcess;
}

/** 守护回调：延迟重启 proxy，成功后把新进程交给 daemon 继续跟踪 */
function restartProxy(attempts: number): void {
    if (restartScheduled) return;
    restartScheduled = true;

    // 延迟重启，避免频繁重启
    setTimeout(async () => {
        try {
            log.info(`尝试重启Proxy进程 (第 ${attempts} 次)...`);
            const p = await spawnAndWaitReady('（重启）');
            ensureDaemon().watchProcess(p, restartProxy);
            restartScheduled = false;
            log.info('Proxy进程重启成功');
        } catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            log.error('Proxy进程重启失败:', errorObj.message);
            restartScheduled = false;
        }
    }, 3000);
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
        const proxyProcess = await spawnAndWaitReady('');
        log.info('Proxy模块启动成功');

        // [lc-1004] 守护必须在拿到进程后**立刻**挂上。原先放在 `await playbackShim.start()` 之后，
        // 那个 await 是个真实的时间窗口：proxy 若在此期间退出，exit 事件早在注册前就 emit 完毕，
        // daemon 便永远跟踪一个死进程（心跳又只查 .killed → 永不重启）。
        ensureDaemon().watchProcess(proxyProcess, restartProxy);

        // 启动本地播放 shim（PotPlayer 经可读名 URL 代理访问真实 proxy，兼顾续播与可读列表）
        try {
            await playbackShim.start();
        } catch (e: any) {
            log.warn('[playbackShim] 启动失败(已忽略，PotPlayer 列表将回退为原始 URL):', e?.message || e);
        }

        return proxyProcess;

    } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        // [lc-1004] 非致命：main.ts 会记日志并继续启动（PotPlayer/MPV 走 shim 的 Node 兜底代理）。
        // 不再弹模态框 —— 守护程序会自动重试，弹窗只会让用户以为整个应用坏了。
        log.error('启动proxy模块失败: ' + errorObj.message);
        restartProxy(1);
        throw error;
    }
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