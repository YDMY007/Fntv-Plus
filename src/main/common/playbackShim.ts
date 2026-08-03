import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
import { runBiliDanmaku } from './biliRunner';
import { ApiService } from '../../modules/fn_api/api';
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
     * 把请求代理到真实 proxy URL（Go proxy @127.0.0.1:22346），透传 Range 等头，逐字节回传。
     * 若 Go proxy 不可达（部分环境/杀软拦截 loopback 时常见），自动降级到 Node 主进程兜底代理
     * （直接调 fnOS API 解析流地址再反代），彻底去掉对 Go proxy 的硬依赖。
     */
    private proxy(target: string, req: http.IncomingMessage, res: http.ServerResponse, sid = ''): void {
        this.reverseProxyTo(target, req, res, sid, {}, false, 0, (err) => {
            // Go proxy 连接失败 -> 主进程兜底（解析流地址后直连 fnOS）
            log.info(`[playbackShim][${sid}] Go proxy 不可达(${err.code})，启用 Node 主进程兜底代理`);
            this.fallbackProxy(target, req, res, sid);
        });
    }

    /**
     * 通用反向代理核心：把请求透传到 targetUrl（Go proxy 或兜底解析出的 fnOS/云盘地址），
     * 回写 MIME、透传 Range、跟随一次重定向。onConnectFail 在「连接层失败且尚未写响应」时被调用，
     * 用于触发降级（如 Go proxy -> 主进程兜底）。
     */
    private reverseProxyTo(
        target: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        sid: string,
        extraHeaders: Record<string, string>,
        skipVerify: boolean,
        depth = 0,
        onConnectFail?: (err: NodeJS.ErrnoException) => void,
    ): void {
        const t = url.parse(target);
        const isHttps = (t.protocol || 'http:') === 'https:';
        const headers: any = { ...req.headers, host: t.host || '' };
        delete headers.origin;
        delete headers.referer;
        for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
        const options: any = {
            protocol: t.protocol || 'http:',
            host: t.hostname,
            port: t.port,
            path: t.path,
            method: req.method,
            headers,
            timeout: 30000,
        };
        if (isHttps) {
            // Node 的 https.request 直接读取顶层 rejectUnauthorized（没有 options.https 子对象）
            options.rejectUnauthorized = !skipVerify;
        }
        const range = req.headers['range'];

        // 客户端(PotPlayer)可能在兜底代理的异步解析过程中断开: 忽略 res 上的写入错误,
        // 避免 "write after end" / EPIPE 等未处理 error 事件导致主进程崩溃
        res.on('error', () => { /* 客户端已断开, 静默忽略 */ });
        log.info(`[playbackShim][${sid || '?'}]   代理到上游 | target=${target} range_forwarded=${range || '(无)'}`);

        let upstreamBytes = 0;
        let responded = false;
        const markResponded = () => { responded = true; };

        const requester = isHttps ? https : http;
        const p = requester.request(options, (pres) => {
            if (pres.statusCode && pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location && depth < 3) {
                const next = url.resolve(target, pres.headers.location);
                log.info(`[playbackShim][${sid || '?'}]   跟随上游重定向 -> ${next}`);
                pres.resume();
                markResponded();
                this.reverseProxyTo(next, req, res, sid, extraHeaders, skipVerify, depth + 1, onConnectFail);
                return;
            }
            const outHeaders: http.IncomingHttpHeaders = { ...pres.headers };
            delete (outHeaders as any).connection;
            delete (outHeaders as any)['keep-alive'];
            const upstreamType = pres.headers['content-type'];
            const mt = this.resolveContentType(target, req.url || '', upstreamType as string | undefined);
            const mimeRewritten = !!mt && mt !== upstreamType;
            if (mt) (outHeaders as any)['content-type'] = mt;
            const cl = pres.headers['content-length'];
            log.info(`[playbackShim][${sid || '?'}] ◀ 上游响应 | status=${pres.statusCode} type=${upstreamType || '(无)'} -> ${mt || '(不变)'} mimeRewritten=${mimeRewritten ? '是' : '否'} len=${cl || '(chunked)'} acceptRanges=${pres.headers['accept-ranges'] || '(无)'}`);
            markResponded();
            res.writeHead(pres.statusCode || 502, outHeaders as any);
            pres.on('data', (c: Buffer) => { upstreamBytes += c.length; });
            pres.on('end', () => {
                const complete = cl ? upstreamBytes >= Number(cl) : true;
                log.key(`[playbackShim][${sid || '?'}] ✓ 上游流结束 | 已转发 ${upstreamBytes} 字节 status=${pres.statusCode} ${cl ? `(目标 ${cl}, ${complete ? '完整' : '不完整'})` : '(流式)'}`);
            });
            pres.pipe(res);
        });

        const onClientGone = () => { try { p.destroy(); } catch { /* noop */ } };
        res.on('close', () => {
            if (!responded && !res.writableEnded) {
                log.warn(`[playbackShim][${sid || '?'}] ✗ PotPlayer 中途断开 | 已转发 ${upstreamBytes} 字节 range=${range || '(无)'}`);
                onClientGone();
            }
        });
        req.on('close', () => { if (!responded) onClientGone(); });

        p.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            const connectFail = code === 'ECONNRESET' || code === 'socket hang up' || code === 'ECONNREFUSED';
            if (connectFail) {
                log.debug(`[playbackShim][${sid || '?'}] 上游连接异常(${code}): ${err.message}`);
            } else {
                log.warn(`[playbackShim][${sid || '?'}] 代理请求失败: ${err.message} (${code})`);
            }
            if (responded) return;
            markResponded();
            if (connectFail && depth === 0 && onConnectFail && !res.headersSent) {
                onConnectFail(err as NodeJS.ErrnoException);
                return;
            }
            this.fail502(res, sid, `无法连接视频上游 (${code || 'unknown'})`);
        });
        req.pipe(p);
    }

    /**
     * Go proxy 不可达时的兜底：直接调 fnOS API 解析流地址，再反向代理到 fnOS/云盘，
     * 行为与 Go proxy 的 PlayVideoHandler 一致（本地 NAS 注入 Authorization+会话Cookie；云盘用直链+云盘Cookie）。
     */
    private async fallbackProxy(goTarget: string, req: http.IncomingMessage, res: http.ServerResponse, sid: string): Promise<void> {
        try {
            const u = url.parse(goTarget, true);
            const q = u.query as Record<string, string | undefined>;
            const itemGuid = (u.pathname || '').split('/').pop() || '';
            const token = (q.token as string) || '';
            const domain = q.domain ? decodeURIComponent(q.domain as string) : '';
            const account = (q.account as string) || '';
            const sourceIndex = parseInt((q.sourceIndex as string) || '0', 10) || 0;
            const cookie = (q.cookie as string) || '';
            let skipVerify = (q.skipVerify as string) === '1';
            const useNasLocal = (q.useNasLocal as string) === '1';
            if (!itemGuid || !token || !domain) {
                this.fail502(res, sid, '兜底代理缺少必要参数(itemGuid/token/domain)');
                return;
            }
            const api = new ApiService(domain, token);
            const list = await api.getStreamList(itemGuid);
            if (!list.success || !list.data || !(list.data as any).video_streams?.length) {
                this.fail502(res, sid, '兜底代理: 获取流列表失败 ' + (list.message || ''));
                return;
            }
            const streams = (list.data as any).video_streams;
            let mediaGuid = streams[0].media_guid;
            if (sourceIndex > 0 && sourceIndex < streams.length) mediaGuid = streams[sourceIndex].media_guid;
            const streamResp = await api.getStream(mediaGuid, account);
            if (!streamResp.success || !streamResp.data) {
                this.fail502(res, sid, '兜底代理: 获取流失败 ' + (streamResp.message || ''));
                return;
            }
            const data: any = streamResp.data;
            const cloud = data.cloud_storage_info;
            const useCloud = cloud && cloud.valid !== false && data.direct_link_qualities?.length > 0 && !useNasLocal;
            let targetUrl: string;
            const extraHeaders: Record<string, string> = {};
            if (useCloud) {
                targetUrl = data.direct_link_qualities[0].url;
                // 云盘直链：证书通常合法，强制不跳过验证（与 Go proxy 一致）
                skipVerify = false;
                if (data.header?.Cookie?.length) extraHeaders['Cookie'] = data.header.Cookie.join('; ');
                const ua = data.header?.['User-Agent'] || data.header?.['user-agent'];
                if (Array.isArray(ua) && ua.length) extraHeaders['User-Agent'] = ua[0];
                log.info(`[playbackShim][${sid}] 兜底代理: 云盘直链模式 target=${targetUrl.slice(0, 90)}`);
            } else {
                targetUrl = api.getVideoUrl(mediaGuid); // ${domain}/v/api/v1/media/range/${mediaGuid}
                extraHeaders['Authorization'] = token;
                extraHeaders['Cookie'] = (cookie || '') + '; mode=relay';
                log.info(`[playbackShim][${sid}] 兜底代理: 本地 NAS 模式 target=${targetUrl.slice(0, 90)}`);
            }
            this.reverseProxyTo(targetUrl, req, res, sid, extraHeaders, skipVerify, 0);
        } catch (e: any) {
            log.error(`[playbackShim][${sid}] 兜底代理异常: ${e?.message || e}`);
            this.fail502(res, sid, '兜底代理异常: ' + (e?.message || e));
        }
    }

    private fail502(res: http.ServerResponse, sid: string, detail: string): void {
        if (res.headersSent || res.writableEnded) { try { res.end(); } catch { /* noop */ } return; }
        log.warn(`[playbackShim][${sid || '?'}] ✗ 返回 502 | ${detail}`);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Gateway: ' + detail + '\n\n请检查:\n1. fnOS 服务是否正常运行\n2. 本机与 fnOS 网络是否连通、防火墙是否放行\n3. 重启应用后再试');
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
