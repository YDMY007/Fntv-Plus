import * as http from 'http';
import * as url from 'url';
import { app } from 'electron';
import logger from '../../modules/logger';
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
        const m = (u.pathname || '').match(/^\/p\/([^/]+)\//);
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
        this.proxy(target, req, res);
    }

    /**
     * 把请求代理到真实 proxy URL，透传 Range 等头，并逐字节回传响应。
     * 若真实 proxy 返回 3xx 重定向，则在 shim 内跟随一次（避免 PotPlayer 直接连到 guid URL）。
     */
    private proxy(target: string, req: http.IncomingMessage, res: http.ServerResponse, depth = 0): void {
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

        const p = http.request(options, (pres) => {
            // 跟随一次重定向（proxy 偶尔 302）
            if (pres.statusCode && pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location && depth < 3) {
                const next = url.resolve(target, pres.headers.location);
                pres.resume(); // 消耗掉原响应体
                this.proxy(next, req, res, depth + 1);
                return;
            }
            // 过滤逐跳头，避免把上游的 connection/keep-alive 透传给 PotPlayer 造成协议混乱
            const headers: http.IncomingHttpHeaders = { ...pres.headers };
            delete headers.connection;
            delete (headers as any)['keep-alive'];
            // 回写 MIME：PotPlayer 对 application/octet-stream 敏感，可能直接「打不开」
            const mt = this.resolveContentType(target, req.url || '', pres.headers['content-type']);
            if (mt) headers['content-type'] = mt;

            res.writeHead(pres.statusCode || 502, headers as any);
            pres.pipe(res);
        });
        // 客户端（PotPlayer）断开或中止时，及时销毁到上游的连接，
        // 避免挂起的 socket 与 `read ECONNRESET` 噪音，并释放 Go 代理侧资源
        const onClientGone = () => { try { p.destroy(); } catch { /* noop */ } };
        res.on('close', onClientGone);
        req.on('close', onClientGone);

        p.on('error', (err) => {
            // 客户端断开导致的上游读取重置属正常生命周期，静默处理
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
                log.debug('[playbackShim] 上游连接被重置（客户端可能已断开）:', err.message);
            } else {
                log.warn('[playbackShim] 代理请求失败:', err.message);
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
}

export const playbackShim = new PlaybackShim();
