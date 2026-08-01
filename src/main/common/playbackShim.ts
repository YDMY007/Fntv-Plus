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
            res.writeHead(pres.statusCode || 502, pres.headers as any);
            pres.pipe(res);
        });
        p.on('error', (err) => {
            log.warn('[playbackShim] 代理请求失败:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            res.end('bad gateway');
        });
        req.pipe(p);
    }
}

export const playbackShim = new PlaybackShim();
