import * as http from 'http';
import * as url from 'url';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
import { runBiliDanmaku } from './biliRunner';
const log = logger.component('playbackShim');

/**
 * 本地流式代理层（解决 PotPlayer 的两难：续播 /seek 仅对「多 URL 参数」可靠，
 * 而播放列表可读名仅对 m3u8 的 EXTINF 生效——两者在 PotPlayer 命令行上互斥）。
 *
 * 做法：PotPlayer 启动参数里传的是本 shim 的 URL（http://127.0.0.1:22347/p/<id>/<可读名>.mp4），
 * shim 收到请求后把视频流【逐字节代理】给真正的 fnOS proxy（127.0.0.1:22346）。
 * 因为流由 shim 直接提供，PotPlayer 的播放列表只认识 shim 的可读名 URL —— 显示剧名；
 * 而续播 /seek 作用于第一个 shim URL（多 URL 方案），精准落在目标集内。
 *
 * 同时透传 HTTP Range 请求头，PotPlayer 的拖动/跳转（以及 /seek 启动跳转）均正常工作。
 */
class PlaybackShim {
    private server?: http.Server;
    private readonly map = new Map<string, string>();
    private counter = 0;
    private readonly port = 22347;
    private started = false;

    /** 启动 shim（幂等）。在 proxy 启动时一并拉起。 */
    async start(): Promise<void> {
        if (this.started) return;
        this.server = http.createServer((req, res) => this.handle(req, res));
        // 关闭 Node 默认的连接/请求超时：GB 级长视频流若被 5s keepAliveTimeout 或 300s
        // requestTimeout 掐断，PotPlayer 会拿到截断的 200 并重头拉全文件（日志里反复全量拉取的根源之一）
        this.server.keepAliveTimeout = 0;
        this.server.headersTimeout = 0;
        this.server.requestTimeout = 0;
        this.server.timeout = 0;
        await new Promise<void>((resolve, reject) => {
            this.server!.on('error', reject);
            this.server!.listen(this.port, '127.0.0.1', () => resolve());
        });
        this.started = true;
        app.once('quit', () => this.stop());
        log.info(`[playbackShim] 已启动，监听 127.0.0.1:${this.port}`);
    }

    stop(): void {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
        this.started = false;
        this.map.clear();
    }

    /**
     * 注册一个「可读名 → 真实 proxy URL」映射，返回 PotPlayer 应当使用的 shim URL。
     * displayName 会做 URL 编码，PotPlayer 解码后显示为可读剧名。
     */
    makeUrl(displayName: string, targetUrl: string): string {
        const id = String(++this.counter);
        this.map.set(id, targetUrl);
        const safeName = encodeURIComponent(
            (displayName || 'video').replace(/[\\/:*?"<>|]/g, '_')
        );
        return `http://127.0.0.1:${this.port}/p/${id}/${safeName}.mp4`;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '');
        const pathname = u.pathname || '';
        // B站弹幕端点：extra.lua 经 HTTP 触发主进程内运行 bili_danmaku.js（绕开外部 Python/node）
        // 用法: GET /danmaku?title=<番名>&ep=<集数>&out=<输出xml绝对路径>&threshold=<聚合阈值>
        if (pathname === '/danmaku') {
            this.handleDanmaku(req, res);
            return;
        }
        const m = pathname.match(/^\/p\/([^/]+)\//);
        if (!m) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
        }
        const target = this.map.get(m[1]);
        if (!target) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('unknown id');
            return;
        }
        // 诊断会话号：把「入站请求 / 上游请求 / 上游响应 / 结束 / 断开」五行日志串起来，便于一次性定位
        const sid = `${Date.now().toString(36)}.${this.counter.toString(36)}`;
        log.info(`[playbackShim][${sid}] ▶ PotPlayer 入站请求 | method=${req.method} range=${req.headers['range'] || '(无)'} ua=${req.headers['user-agent'] || '(无)'}`);
        this.proxy(target, req, res, sid);
    }

    /**
     * 把请求代理到真实 proxy URL，透传 Range 等头，并逐字节回传响应。
     * 若真实 proxy 返回 3xx 重定向，则在 shim 内跟随一次（避免 PotPlayer 直接连到 guid URL）。
     * sid 为诊断会话号，用于把同一请求的多行日志串联起来。
     */
    private proxy(target: string, req: http.IncomingMessage, res: http.ServerResponse, sid = '', depth = 0): void {
        const t = url.parse(target);
        const options: http.RequestOptions = {
            protocol: t.protocol || 'http:',
            host: t.hostname,
            port: t.port,
            path: t.path,
            method: req.method,
            headers: { ...req.headers, host: t.host || '' },
        };
        // 丢弃可能触发跨域/来源校验的头，避免 proxy 拒绝
        delete (options.headers as any).origin;
        delete (options.headers as any).referer;

        const range = req.headers['range'];
        log.info(`[playbackShim][${sid || '?'}]   代理到上游 | target=${target} range_forwarded=${range || '(无)'}`);

        let upstreamBytes = 0;
        const p = http.request(options, (pres) => {
            // 跟随一次重定向（proxy 偶尔 302）
            if (pres.statusCode && pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location && depth < 3) {
                const next = url.resolve(target, pres.headers.location);
                log.info(`[playbackShim][${sid || '?'}]   跟随上游重定向 -> ${next}`);
                pres.resume(); // 消耗掉原响应体
                this.proxy(next, req, res, sid, depth + 1);
                return;
            }
            // 过滤逐跳头，避免把上游的 connection/keep-alive 透传给 PotPlayer 造成协议混乱
            const headers: http.IncomingHttpHeaders = { ...pres.headers };
            delete headers.connection;
            delete (headers as any)['keep-alive'];
            // 回写 MIME：PotPlayer 对 application/octet-stream 敏感，可能直接「打不开」
            const upstreamType = pres.headers['content-type'];
            const mt = this.resolveContentType(target, req.url || '', upstreamType);
            const mimeRewritten = !!mt && mt !== upstreamType;
            if (mt) headers['content-type'] = mt;

            const cl = pres.headers['content-length'];
            log.info(`[playbackShim][${sid || '?'}] ◀ 上游响应 | status=${pres.statusCode} upstreamType=${upstreamType || '(无)'} -> rewrittenType=${mt || '(不变)'} mimeRewritten=${mimeRewritten ? '是' : '否'} contentLength=${cl || '(无/chunked)'} acceptRanges=${pres.headers['accept-ranges'] || '(无)'}`);

            res.writeHead(pres.statusCode || 502, headers as any);
            pres.on('data', (c: Buffer) => { upstreamBytes += c.length; });
            pres.on('end', () => {
                const complete = cl ? upstreamBytes >= Number(cl) : true;
                // key 级日志同时进 app.log 与 app-error.log，便于在精简报错日志里一眼看到本次播放结论
                log.key(`[playbackShim][${sid || '?'}] ✓ 上游流结束 | 已转发 ${upstreamBytes} 字节 status=${pres.statusCode} ${cl ? `(目标 ${cl}, ${complete ? '完整' : '不完整'})` : '(流式/chunked)'}`);
            });
            pres.pipe(res);
        });
        // 客户端（PotPlayer）在流未结束前断开：可能是拖动(正常)/主动放弃/传输中断(异常)。
        // 及时销毁到上游的连接，避免挂起 socket 与 read ECONNRESET 噪音，并释放 Go 代理侧资源。
        const onClientGone = () => { try { p.destroy(); } catch { /* noop */ } };
        res.on('close', () => {
            if (!res.writableEnded) {
                log.warn(`[playbackShim][${sid || '?'}] ✗ PotPlayer 中途断开(流未结束) | 已转发 ${upstreamBytes} 字节 range=${range || '(无)'} —— 可能为拖动/主动放弃或传输中断`);
                onClientGone();
            }
        });
        req.on('close', onClientGone);

        p.on('error', (err) => {
            // 客户端断开导致的上游读取重置属正常生命周期，静默处理
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
                log.debug(`[playbackShim][${sid || '?'}] 上游连接被重置（客户端可能已断开）: ${err.message}`);
            } else {
                log.warn(`[playbackShim][${sid || '?'}] 代理请求失败 target=${target}: ${err.message}`);
            }
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            if (!res.writableEnded) res.end('bad gateway');
        });
        req.pipe(p);
    }

    /**
     * 解析应回写给 PotPlayer 的 Content-Type。
     * - 上游已给出明确的 video/* 时原样保留；
     * - 否则按 URL 扩展名（shim URL 恒为 .mp4）回写为标准 video/* MIME，
     *   规避 fnOS 返回 application/octet-stream 时 PotPlayer 拒绝打开的问题。
     */
    private resolveContentType(targetUrl: string, reqPath: string, upstreamType?: string): string | undefined {
        if (upstreamType && /^video\//i.test(upstreamType as string)) {
            return upstreamType as string;
        }
        const path = reqPath || targetUrl;
        const ext = (path.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
        const map: Record<string, string> = {
            mp4: 'video/mp4',
            m4v: 'video/mp4',
            mov: 'video/quicktime',
            mkv: 'video/x-matroska',
            avi: 'video/x-msvideo',
            ts: 'video/mp2t',
            m2ts: 'video/mp2t',
            webm: 'video/webm',
            flv: 'video/x-flv',
            wmv: 'video/x-ms-wmv',
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            aac: 'audio/aac',
            flac: 'audio/flac',
        };
        return ext ? map[ext] : undefined;
    }

    // ===================== B站弹幕端点（/danmaku）=====================

    /**
     * 处理 /danmaku 请求：在主进程内运行 bili_danmaku.js 获取弹幕并写出 XML。
     * 仅接受 out 落在安全缓存目录（PUBLIC/ProgramData/tmp 下的 fnos-danmaku）内的请求，
     * 防止通过 out 参数做路径穿越写任意文件。
     */
    private handleDanmaku(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '', true);
        const q = (u.query || {}) as Record<string, string | undefined>;
        const title = (q.title || '').toString();
        const ep = parseInt((q.ep || '0').toString(), 10) || 0;
        const out = (q.out || '').toString();
        const threshold = q.threshold ? parseInt(q.threshold.toString(), 10) : undefined;

        if (!title || !out) {
            this.json(res, 400, { ok: false, error: '缺少 title 或 out 参数' });
            return;
        }
        if (!this.isSafeDanmakuPath(out)) {
            log.warn(`[playbackShim][danmaku] ❌ 拒绝非安全输出路径: ${out}`);
            this.json(res, 403, { ok: false, error: 'out 路径不在允许的弹幕缓存目录内' });
            return;
        }
        log.info(`[playbackShim][danmaku] ▶ 请求弹幕 | title=${JSON.stringify(title)} ep=${ep} out=${out} threshold=${threshold ?? '(默认)'}`);
        runBiliDanmaku(title, ep, out, threshold).then((r) => {
            if (r.ok) {
                log.info(`[playbackShim][danmaku] ✅ 弹幕就绪 | count=${r.danmaku_count} source=${r.source} cid=${r.cid}`);
                this.json(res, 200, { ok: true, danmaku_count: r.danmaku_count, source: r.source, cid: r.cid });
            } else {
                log.warn(`[playbackShim][danmaku] ❌ 弹幕获取失败: ${r.error}`);
                this.json(res, 200, { ok: false, error: r.error });
            }
        }).catch((e) => {
            log.warn(`[playbackShim][danmaku] 异常: ${e?.message || e}`);
            this.json(res, 500, { ok: false, error: String(e?.message || e) });
        });
    }

    /** 校验 out 是否落在允许的弹幕缓存目录内（防路径穿越）。 */
    private isSafeDanmakuPath(out: string): boolean {
        let resolved: string;
        try {
            resolved = path.resolve(out);
        } catch (_) {
            return false;
        }
        const bases = this.resolveSafeDanmakuBases();
        return bases.some((b) => {
            const rb = path.resolve(b);
            return resolved === rb || resolved.startsWith(rb + path.sep);
        });
    }

    /** 允许的弹幕 XML 输出根目录（与 uosc_danmaku/main.lua 的 DANMAKU_PATH 对齐）。 */
    private resolveSafeDanmakuBases(): string[] {
        const roots = [process.env.PUBLIC, process.env.ProgramData, os.tmpdir()].filter(Boolean) as string[];
        const dirs = roots.map((r) => path.join(r, 'fnos-danmaku'));
        if (process.platform !== 'win32') {
            dirs.push(path.join(os.homedir(), '.config', 'mpv', 'scripts', 'uosc_danmaku'));
        }
        return dirs;
    }

    private json(res: http.ServerResponse, code: number, obj: any): void {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
    }
}

export const playbackShim = new PlaybackShim();
