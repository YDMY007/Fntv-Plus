import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import logger from '../../modules/logger';
import { runBiliDanmaku, runBiliDanmakuCandidates, runBiliDanmakuByBvid } from './biliRunner';
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
    /** [lc-996] HLS 播放列表缓冲上限。正常只有几十~几百 KB（实测夸克 79215 字节 / 161 个分片）。 */
    private static readonly PLAYLIST_MAX = 8 * 1024 * 1024;

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
        // 候选搜索：仅返回候选视频列表（标题/bvid/来源/是否合集），供 MPV 手动搜索 UI 展示
        if (pathname === '/danmaku-candidates') {
            this.handleDanmakuCandidates(req, res);
            return;
        }
        // 用户选定 bvid 后，直接拉取该视频弹幕
        if (pathname === '/danmaku-by-bvid') {
            this.handleDanmakuByBvid(req, res);
            return;
        }
        // [lc-1096] NAS 外挂字幕列表：MPV「加载字幕」菜单经此取当前集的 fnOS 外挂字幕（与原生网页字幕菜单同源）
        if (pathname === '/nas-subtitles') {
            this.handleNasSubtitles(req, res);
            return;
        }
        // [lc-1096] 用户选定某条字幕后，主进程下载/复用本地临时文件并回传路径，供 mpv sub-add 挂载
        if (pathname === '/nas-subtitle-file') {
            this.handleNasSubtitleFile(req, res);
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
        // [lc-1001] 请求头也可能含非 ASCII（如客户端传入的非 ASCII 字段），Node http.request 同样会抛错；
        // 统一按响应头同套规则清洗（content-disposition 在此路径几乎不出现，仅剔除非 ASCII/控制字符）。
        for (const k of Object.keys(headers)) {
            const v = headers[k];
            if (Array.isArray(v)) headers[k] = v.map((x: any) => this.sanitizeHeaderValue(k, String(x)));
            else if (typeof v === 'string') headers[k] = this.sanitizeHeaderValue(k, v);
        }
        const options: any = {
            protocol: t.protocol || 'http:',
            host: t.hostname,
            port: t.port,
            path: t.path,
            method: req.method,
            headers,
            timeout: 30000,
            // [lc-1004] 不复用 http.globalAgent：视频流是单个长请求，连接池没有收益可拿，
            // 而这一跳是 loopback、握手开销可忽略；独占连接也避免与主进程其它请求共用池、
            // 被彼此的空闲回收策略干扰。（注：曾经出现的 socket hang up 不是这里造成的，
            // 真根因是下面 req 的 'close' 误杀上游 socket。）
            agent: false,
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
            // [lc-1001] 上游响应头可能含非 ASCII（如百度/115 的中文 Content-Disposition），
            // 直接展开会在 writeHead 抛 ERR_INVALID_CHAR 导致响应写不出、PotPlayer 转圈。
            // 先统一清洗（中文文件名按 RFC 5987 编码保留，其余剔除非 ASCII/控制字符）。
            const outHeaders: any = this.sanitizeOutgoingHeaders(pres.headers);
            delete outHeaders.connection;
            delete outHeaders['keep-alive'];
            const upstreamType = pres.headers['content-type'];
            const mt = this.resolveContentType(target, req.url || '', upstreamType as string | undefined,
                pres.headers['content-disposition'] as string | undefined);
            let mimeRewritten = !!mt && mt !== upstreamType;
            if (mt) (outHeaders as any)['content-type'] = mt;
            const cl = pres.headers['content-length'];
            log.info(`[playbackShim][${sid || '?'}] ◀ 上游响应 | status=${pres.statusCode} type=${upstreamType || '(无)'} -> ${mt || '(不变)'} mimeRewritten=${mimeRewritten ? '是' : '否'} len=${cl || '(chunked)'} acceptRanges=${pres.headers['accept-ranges'] || '(无)'}`);
            // [lc-996] HLS 播放列表不能直筒透传：其中的分片是相对地址，播放器会拿 shim 自身 URL 当 base
            // 回来请求分片，而 shim 路由只认 id、忽略其后路径 → 又把整份播放列表回给它，永远开不了播。
            if (this.isRewritablePlaylist(mt, target, pres.statusCode)) {
                this.rewritePlaylist(pres, res, outHeaders, target, sid, markResponded, (n) => { upstreamBytes += n; });
                return;
            }

            const endLog = (): void => {
                const complete = cl ? upstreamBytes >= Number(cl) : true;
                log.key(`[playbackShim][${sid || '?'}] ✓ 上游流结束 | 已转发 ${upstreamBytes} 字节 status=${pres.statusCode} ${cl ? `(目标 ${cl}, ${complete ? '完整' : '不完整'})` : '(流式)'}`);
            };

            // [lc-997] 上游未给出可信 media 类型时，先扣住响应头，用首包魔数嗅探真实容器再回写。
            //   仅当 Range 从 0 开始(能拿到文件头)时可行；拖动产生的后续 Range 请求沿用既有判定。
            const ut0 = (upstreamType || '').toLowerCase();
            const upstreamTrustworthy = /^(video|audio)\//.test(ut0) || /mpegurl/.test(ut0);
            const rangeStart = (() => {
                const m = /bytes=(\d+)-/.exec(String(req.headers['range'] || ''));
                return m ? parseInt(m[1], 10) : 0;
            })();
            if (upstreamTrustworthy || rangeStart !== 0) {
                markResponded();
                res.writeHead(pres.statusCode || 502, outHeaders as any);
                pres.on('data', (c: Buffer) => { upstreamBytes += c.length; });
                pres.on('end', endLog);
                pres.pipe(res);
                return;
            }

            let headSent = false;
            const startStream = (sniffed?: string): void => {
                if (headSent) return;
                headSent = true;
                if (sniffed) {
                    (outHeaders as any)['content-type'] = sniffed;
                    mimeRewritten = sniffed !== upstreamType;
                    log.info(`[playbackShim][${sid || '?'}] 🔍 魔数嗅探 | 真实容器=${sniffed} (上游 type=${upstreamType || '无'}，已覆盖)`);
                } else {
                    log.info(`[playbackShim][${sid || '?'}] 🔍 魔数嗅探 | 未识别，沿用 ${(outHeaders as any)['content-type'] || '(无)'}`);
                }
                markResponded();
                res.writeHead(pres.statusCode || 502, outHeaders as any);
            };
            // 首包通常数十 KB，远大于魔数所需的十几字节；流极短(未触发 data)时由 end 分支兜底，不丢数据。
            const onFirstChunk = (c: Buffer): void => {
                pres.removeListener('data', onFirstChunk);
                upstreamBytes += c.length;
                startStream(this.sniffMime(c));
                res.write(c);
                pres.on('data', (d: Buffer) => {
                    upstreamBytes += d.length;
                    if (res.write(d) === false) { // 背压：暂停上游，等客户端排空再继续
                        pres.pause();
                        res.once('drain', () => { try { pres.resume(); } catch { /* noop */ } });
                    }
                });
            };
            pres.on('data', onFirstChunk);
            pres.on('end', () => {
                startStream();
                endLog();
                res.end();
            });
        });

        const onClientGone = () => { try { p.destroy(); } catch { /* noop */ } };
        res.on('close', () => {
            if (!responded && !res.writableEnded) {
                log.warn(`[playbackShim][${sid || '?'}] ✗ PotPlayer 中途断开 | 已转发 ${upstreamBytes} 字节 range=${range || '(无)'}`);
                onClientGone();
            }
        });
        // [lc-1004] req 的 'close' 在 Node ≥16 是「请求已完整接收」，不是「客户端跑了」：
        // 无 body 的 GET 收到后 ~1ms 就触发，把还在等上游响应的 socket destroy 掉，
        // 于是每发必 ECONNRESET(socket hang up) → 误判「Go proxy 不可达」→ 恒定降级到
        // Node 兜底代理，PotPlayer 起播 5~8s 且 Go 侧优化全部失效。
        // 只在请求真的被中途 abort（未收完）时才收手；客户端断开由上面的 res 'close' 负责。
        req.on('close', () => { if (!responded && !req.complete) onClientGone(); });

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
            // [lc-1004] 用带缓存的版本。兜底路径下 PotPlayer 的每个 Range/续传请求都会进到这里，
            // 原先每次都重新串行解析直链（夸克实测单次 3.10s），而 ApiService.cache 是类级静态的、
            // TTL 300s（与 Go 侧 GetStreamCached 一致），换用 cached 版本后重复请求直接命中。
            const list = await api.getStreamListCached(itemGuid);
            if (!list.success || !list.data || !(list.data as any).video_streams?.length) {
                this.fail502(res, sid, '兜底代理: 获取流列表失败 ' + (list.message || ''));
                return;
            }
            const streams = (list.data as any).video_streams;
            let mediaGuid = streams[0].media_guid;
            if (sourceIndex > 0 && sourceIndex < streams.length) mediaGuid = streams[sourceIndex].media_guid;
            const streamResp = await api.getStreamCached(mediaGuid, account);
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
     * [lc-1001] 清洗上游响应头，杜绝 Node res.writeHead 因非 ASCII / 控制字符抛
     * ERR_INVALID_CHAR（百度/115 等云盘常返回含中文文件名的 Content-Disposition，
     * 未清洗会让 PotPlayer 响应写不出、一直转圈）。
     * - content-disposition：中文文件名按 RFC 5987 编码为 filename*=UTF-8''<percent>，ASCII 安全且保留原名
     * - 其余头值：剔除非 ASCII 与控制字符，确保 writeHead 不抛错
     */
    private sanitizeOutgoingHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
        const out: Record<string, string | string[]> = {};
        for (const key of Object.keys(headers)) {
            const raw = (headers as any)[key];
            if (raw === undefined) continue;
            if (Array.isArray(raw)) {
                out[key] = raw.map((v: any) => this.sanitizeHeaderValue(key, String(v)));
            } else {
                out[key] = this.sanitizeHeaderValue(key, String(raw));
            }
        }
        return out;
    }

    private sanitizeHeaderValue(name: string, value: string): string {
        if (name.toLowerCase() === 'content-disposition') {
            const enc = this.encodeDispositionFilename(value);
            if (enc) return enc;
        }
        // 其余头值：仅保留可打印 ASCII（0x20-0x7e），剔除非 ASCII 与控制字符，避免 writeHead 抛错
        return value.replace(/[^\x20-\x7e]/g, '');
    }

    /** 把 content-disposition 的中文文件名按 RFC 5987 编码；无文件名或本就纯 ASCII 时返回原值清洗版。 */
    private encodeDispositionFilename(value: string): string | null {
        const m = /filename\*?=(?:"([^"]*)"|'([^']*)'|([^;]+))/i.exec(value);
        if (!m) return null;
        const fname = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (!fname) return null;
        if (/^[\x20-\x7e]*$/.test(value)) return value; // 已是纯 ASCII，无需编码
        const encoded = encodeURIComponent(fname);
        const base = value.replace(/filename\*?=(?:"[^"]*"|'[^']*'|[^;]+)/i, '').replace(/;\s*$/, '').trim();
        const prefix = base ? base + '; ' : '';
        return `${prefix}filename*=UTF-8''${encoded}`;
    }

    /**
     * 解析应回写给 PotPlayer 的 Content-Type。
     * - 上游已给出明确的 video/* 或 HLS 播放列表(application/vnd.apple.mpegurl 等)时原样保留；
     * - 否则（如 fnOS 本地 NAS range 返回 application/octet-stream）才按 shim URL 扩展名（恒为 .mp4）
     *   回写为标准 video/* MIME，规避 PotPlayer 因 octet-stream 拒绝打开。
     * ⚠️ 不能因为 shim 自身 URL 恒为 .mp4 就把上游真实的 HLS 播放列表(m3u8)改写成 video/mp4：
     *   PotPlayer 信任 Content-Type，看到 video/mp4 会把播放列表当单文件解封装而失败；
     *   MPV 按内容探测故不受影响——这正是「strm(MPV 能播 / PotPlayer 失败)」的根因(lc-995)。
     */
    private resolveContentType(targetUrl: string, reqPath: string, upstreamType?: string, disposition?: string): string | undefined {
        const ut = (upstreamType || '').toLowerCase();
        const isHls = /mpegurl|mpeg\+url|x-mpegurl|vnd\.apple\.mpegurl/i.test(ut)
            || /\.m3u8?(\?|#|$)/i.test(targetUrl || '');
        if ((ut && /^video\//i.test(ut)) || isHls) {
            return upstreamType || 'application/vnd.apple.mpegurl';
        }
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
        // [lc-997] 兜底扩展名的取值顺序：Content-Disposition 文件名 > 真实上游地址 > shim 自身路径。
        //   ⚠️ 绝不能再把 shim 自身路径(恒为 /p/<id>/xxx.mp4)当首选：那会让 MKV/AVI/TS 一律被标成
        //   video/mp4，PotPlayer 信任 Content-Type 按 MP4 解封装 → 直接打开失败
        //   (MPV 按内容探测故不受影响，正是「云盘视频 MPV 能播 / PotPlayer 失败」的根因)。
        //   真实容器改由 sniffMime 按流魔数判定，这里只是嗅探也失败时的次级兜底。
        const fname = (() => {
            const m = /filename\*?=(?:[A-Za-z0-9-]+'')?"?([^";]+)"?/i.exec(disposition || '');
            return m ? m[1] : '';
        })();
        for (const src of [fname, targetUrl, reqPath]) {
            if (!src) continue;
            const e = (src.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
            if (e && map[e]) return map[e];
        }
        return undefined;
    }

    /**
     * [lc-997] 按流头部魔数嗅探真实容器格式（content sniffing）。
     *
     * 为什么必须有它：云盘直链（115 / 夸克等）普遍返回 `application/octet-stream`，
     * 且经 Go proxy 时 URL 形如 `/api/v1/playvideo/<guid>?...` —— **没有任何扩展名可用**。
     * 于是「按扩展名兜底」只能拿到 shim 自身路径的 .mp4，把 MKV/AVI/TS/FLV 一律标成 video/mp4；
     * PotPlayer 信任 Content-Type，按 MP4 解封装非 MP4 容器即失败，而 MPV 按内容探测完全不受影响。
     * 流的前若干字节是唯一跨路径可靠（Go proxy / Node 兜底 / 直链 都成立）的判据。
     *
     * 仅在「上游未给出可信 video|audio|HLS 类型」且「Range 从 0 开始（能拿到文件头）」时调用。
     */
    private sniffMime(head: Buffer): string | undefined {
        if (!head || head.length < 12) return undefined;
        const at = (o: number, n: number) => head.toString('latin1', o, o + n);
        // Matroska / WebM：EBML magic
        if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/x-matroska';
        // MP4 / MOV：box 长度(4B) 之后是 'ftyp'
        if (at(4, 4) === 'ftyp') return 'video/mp4';
        // AVI：RIFF....AVI␠
        if (at(0, 4) === 'RIFF' && at(8, 4) === 'AVI ') return 'video/x-msvideo';
        // FLV
        if (at(0, 3) === 'FLV') return 'video/x-flv';
        // RealMedia / RMVB
        if (at(0, 4) === '.RMF') return 'application/vnd.rn-realmedia-vbr';
        // MPEG-TS：188 字节定长包，同步字节 0x47 每包重复
        if (head[0] === 0x47 && head.length >= 189 && head[188] === 0x47) return 'video/mp2t';
        // ASF / WMV / WMA 头部 GUID
        if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return 'video/x-ms-wmv';
        // Ogg
        if (at(0, 4) === 'OggS') return 'video/ogg';
        // MP3：ID3 标签或帧同步
        if (at(0, 3) === 'ID3') return 'audio/mpeg';
        if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
        return undefined;
    }

    /**
     * [lc-996] 这份响应是否是「可由我们重写分片地址的 HLS 播放列表」。
     *
     * 上游为本机 Go proxy(127.0.0.1:22346) 时不重写：Go 侧已把 m3u8 里的相对分片 URI
     * 重写成指向自己的绝对 URL（日志 [m3u8] 已重写 N 行），本层再改只会把正确地址改坏。
     * 只有走 Node 兜底直连云盘时，相对分片才需要在本层按真实云盘地址重写。
     */
    private isRewritablePlaylist(mt: string | undefined, target: string, status?: number): boolean {
        if (!mt || !/mpegurl/i.test(mt)) return false;
        if (status !== undefined && status !== 200) return false;
        const h = (url.parse(target).hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1';
    }

    /**
     * [lc-996] 缓冲整份播放列表 → 重写分片地址 → 重算 Content-Length 后一次性回给播放器。
     * 播放列表是小文件（实测 79215 字节），缓冲不影响起播；超过 PLAYLIST_MAX 说明体积异常，
     * 放弃重写、把已收部分原样写出后转为直筒透传，避免无上限吃内存。
     */
    private rewritePlaylist(
        pres: http.IncomingMessage,
        res: http.ServerResponse,
        outHeaders: http.IncomingHttpHeaders,
        baseUrl: string,
        sid: string,
        markResponded: () => void,
        onBytes: (n: number) => void,
    ): void {
        const chunks: Buffer[] = [];
        let total = 0;
        let passthrough = false;
        const onData = (c: Buffer) => {
            onBytes(c.length);
            if (passthrough) return; // 已转直筒，数据由 pipe 负责
            total += c.length;
            if (total > PlaybackShim.PLAYLIST_MAX) {
                passthrough = true;
                pres.removeListener('data', onData);
                log.warn(`[playbackShim][${sid}] ⚠ 播放列表超 ${PlaybackShim.PLAYLIST_MAX >> 20}MB，跳过重写直接透传`);
                markResponded();
                res.writeHead(pres.statusCode || 200, outHeaders as any);
                res.write(Buffer.concat(chunks));
                pres.pipe(res);
                return;
            }
            chunks.push(c);
        };
        pres.on('data', onData);
        pres.on('end', () => {
            if (passthrough) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            const rw = this.rewriteHlsPlaylist(raw, baseUrl);
            const body = Buffer.from(rw.body, 'utf8');
            const h: any = { ...outHeaders };
            h['content-length'] = String(body.length); // 重写后长度必变，沿用上游值会被播放器判定为截断
            delete h['transfer-encoding'];
            markResponded();
            res.writeHead(pres.statusCode || 200, h);
            res.end(body);
            log.key(`[playbackShim][${sid}] ✓ HLS 播放列表已重写 | ${rw.n} 条分片相对地址 → 绝对上游地址 | ${raw.length} → ${body.length} 字节`);
        });
        pres.on('error', (e: Error) => {
            if (passthrough) return;
            markResponded();
            log.warn(`[playbackShim][${sid}] ✗ 播放列表读取中断: ${e.message}`);
            this.fail502(res, sid, '播放列表读取中断');
        });
    }

    /**
     * [lc-996] 把播放列表里的相对分片 URI 解析成绝对上游地址。
     *
     * 为什么必须重写：shim 路由只取 /p/<id>/ 里的 id、忽略其后路径。播放器识别出 HLS 后按相对 URI
     * 回来请求 /p/<id>/media-xxx-0.ts，shim 会把它当成同一个 id 的播放列表请求 → 再次解析上游 →
     * 又回一份 79215 字节的 m3u8 给它。实测 PotPlayer 如此连发 176 次分片请求、duration 恒为 0。
     * 重写成绝对地址后播放器直连云盘拉分片，实测 duration=794680ms、position 正常递增；
     * 云盘分片不校验 UA/Referer（无 UA 亦 200）且支持 Range（→206），故拖动同样可用。
     */
    private rewriteHlsPlaylist(text: string, baseUrl: string): { body: string; n: number } {
        let n = 0;
        const isAbs = (u: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('//');
        const abs = (u: string) => { try { return new URL(u, baseUrl).href; } catch { return u; } };
        const body = text.split(/\r?\n/).map((line) => {
            const t = line.trim();
            if (!t) return line;
            if (t.charAt(0) === '#') {
                // #EXT-X-KEY / #EXT-X-MAP 的 URI="..."（加密流密钥、fMP4 初始化段）同样可能是相对地址
                return line.replace(/URI="([^"]+)"/g, (m, u: string) => {
                    if (isAbs(u)) return m;
                    n++;
                    return 'URI="' + abs(u) + '"';
                });
            }
            if (isAbs(t)) return line;
            n++;
            return abs(t);
        }).join('\n');
        return { body, n };
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
        const season = q.season ? parseInt(q.season.toString(), 10) : 0;

        if (!title || !out) {
            this.json(res, 400, { ok: false, error: '缺少 title 或 out 参数' });
            return;
        }
        if (!this.isSafeDanmakuPath(out)) {
            log.warn(`[playbackShim][danmaku] ❌ 拒绝非安全输出路径: ${out}`);
            this.json(res, 403, { ok: false, error: 'out 路径不在允许的弹幕缓存目录内' });
            return;
        }
        log.info(`[playbackShim][danmaku] ▶ 请求弹幕 | title=${JSON.stringify(title)} ep=${ep} season=${season || 0} out=${out} threshold=${threshold ?? '(默认)'}`);
        runBiliDanmaku(title, ep, out, threshold, season).then((r) => {
            if (r.ok) {
                log.info(`[playbackShim][danmaku] ✅ 弹幕就绪 | count=${r.danmaku_count} source=${r.source} cid=${r.cid}`);
                // [lc-607] 透传 bvid/matched_title: MPV 配置面板「匹配来源」需显示 BV(视频区)/标题,
                //   之前只回 source/cid → 显示"UP主搬运 (cid:xxx)"而非"UP主搬运 (BV:xxx)"
                this.json(res, 200, {
                    ok: true,
                    danmaku_count: r.danmaku_count,
                    source: r.source,
                    cid: r.cid,
                    bvid: r.bvid || null,
                    title: r.title || title,
                    matched_title: r.matched_title || null,
                    season_id: r.season_id || null,
                    epid: r.epid || null,
                });
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

    // ===================== 候选搜索端点（/danmaku-candidates）=====================

    /**
     * 处理 /danmaku-candidates 请求：搜索 B站 候选视频列表（不拉取弹幕、不写 XML）。
     * 供 MPV 手动搜索 UI 展示候选列表，由用户选定具体视频。
     */
    private handleDanmakuCandidates(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '', true);
        const q = (u.query || {}) as Record<string, string | undefined>;
        const title = (q.title || '').toString();
        const ep = parseInt((q.ep || '0').toString(), 10) || 0;
        const season = q.season ? parseInt(q.season.toString(), 10) : 0;
        if (!title) {
            this.json(res, 400, { ok: false, error: '缺少 title 参数' });
            return;
        }
        log.info(`[playbackShim][danmaku-candidates] ▶ 请求候选 | title=${JSON.stringify(title)} ep=${ep} season=${season || 0}`);
        runBiliDanmakuCandidates(title, ep, season).then((r) => {
            if (r.ok) {
                log.info(`[playbackShim][danmaku-candidates] ✅ 候选 ${r.candidates ? r.candidates.length : 0} 个`);
                this.json(res, 200, { ok: true, candidates: r.candidates || [] });
            } else {
                log.warn(`[playbackShim][danmaku-candidates] ❌ 候选搜索失败: ${r.error}`);
                this.json(res, 200, { ok: false, error: r.error });
            }
        }).catch((e) => {
            log.warn(`[playbackShim][danmaku-candidates] 异常: ${e?.message || e}`);
            this.json(res, 500, { ok: false, error: String(e?.message || e) });
        });
    }

    // ===================== 指定 bvid 拉取端点（/danmaku-by-bvid）=====================

    /**
     * 处理 /danmaku-by-bvid 请求：由用户选定的 bvid 直接拉取该视频弹幕并写出 XML。
     */
    private handleDanmakuByBvid(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '', true);
        const q = (u.query || {}) as Record<string, string | undefined>;
        const title = (q.title || '').toString();
        const bvid = (q.bvid || '').toString();
        const out = (q.out || '').toString();
        const threshold = q.threshold ? parseInt(q.threshold.toString(), 10) : undefined;
        if (!title || !bvid || !out) {
            this.json(res, 400, { ok: false, error: '缺少 title / bvid / out 参数' });
            return;
        }
        if (!this.isSafeDanmakuPath(out)) {
            log.warn(`[playbackShim][danmaku-by-bvid] ❌ 拒绝非安全输出路径: ${out}`);
            this.json(res, 403, { ok: false, error: 'out 路径不在允许的弹幕缓存目录内' });
            return;
        }
        log.info(`[playbackShim][danmaku-by-bvid] ▶ 请求弹幕 | title=${JSON.stringify(title)} bvid=${bvid} out=${out} threshold=${threshold ?? '(默认)'}`);
        runBiliDanmakuByBvid(title, bvid, out, threshold).then((r) => {
            if (r.ok) {
                log.info(`[playbackShim][danmaku-by-bvid] ✅ 弹幕就绪 | count=${r.danmaku_count} bvid=${r.bvid}`);
                this.json(res, 200, { ok: true, danmaku_count: r.danmaku_count, source: r.source, bvid: r.bvid, cid: r.cid });
            } else {
                log.warn(`[playbackShim][danmaku-by-bvid] ❌ 弹幕获取失败: ${r.error}`);
                this.json(res, 200, { ok: false, error: r.error });
            }
        }).catch((e) => {
            log.warn(`[playbackShim][danmaku-by-bvid] 异常: ${e?.message || e}`);
            this.json(res, 500, { ok: false, error: String(e?.message || e) });
        });
    }

    // ===================== NAS 字幕端点（/nas-subtitles、/nas-subtitle-file）=====================

    /** [lc-1096] 解析 lua 从播放 URL 透传来的 fnOS 连接参数；缺参直接回 400 并返回 null。 */
    private nasFnParams(res: http.ServerResponse, q: Record<string, string | undefined>): { api: ApiService; itemGuid: string } | null {
        const itemGuid = (q.itemGuid || '').toString();
        const token = (q.token || '').toString();
        const domain = (q.domain || '').toString();
        if (!itemGuid || !token || !domain) {
            this.json(res, 400, { ok: false, error: '缺少 itemGuid / token / domain 参数' });
            return null;
        }
        return { api: new ApiService(domain, token), itemGuid };
    }

    /**
     * [lc-1096] 处理 /nas-subtitles：返回当前集的外挂字幕清单（guid/title/format/language/is_default）。
     * 只列 extra_file=1（或旧版 is_external=1）的独立字幕文件——内封轨播放器自己会读，不该在这里重复挂。
     */
    private handleNasSubtitles(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '', true);
        const q = (u.query || {}) as Record<string, string | undefined>;
        const p = this.nasFnParams(res, q);
        if (!p) return;
        p.api.getStreamList(p.itemGuid).then((r) => {
            const streams: any[] = (r.success && r.data && (r.data as any).subtitle_streams) || [];
            const items = streams
                .filter((s) => Number(s.extra_file) === 1 || Number(s.is_external) === 1)
                .map((s, i) => {
                    const lang = String(s.language || '').trim();
                    // fnOS 外挂字幕的 title 常是空串/纯语言标签(lc-1093 实测)，不兜底菜单里全是 guid
                    const title = String(s.title || '').trim() || [lang && lang !== 'und' ? lang : '', `字幕#${i + 1}`].filter(Boolean).join(' ');
                    return {
                        guid: String(s.guid || ''),
                        title,
                        format: String(s.format || 'srt'),
                        language: lang,
                        is_default: Number(s.is_default) || 0,
                    };
                });
            log.info(`[playbackShim][nas-subtitles] itemGuid=${p.itemGuid} 外挂字幕 ${items.length} 条(流共 ${streams.length} 条)`);
            this.json(res, 200, { ok: true, items });
        }).catch((e) => {
            log.warn(`[playbackShim][nas-subtitles] 异常: ${e?.message || e}`);
            this.json(res, 500, { ok: false, error: String(e?.message || e) });
        });
    }

    /**
     * [lc-1096] 处理 /nas-subtitle-file：下载（或复用已缓存的）指定 guid 字幕到本地临时目录，回传绝对路径。
     * 标题/格式不回传自 lua（含中文，拼 URL 易错），而是用 getStreamListCached 反查；downloadSubtitle
     * 自身带「已存在即跳过」缓存，菜单里反复选同一条不会重复下载。
     */
    private handleNasSubtitleFile(req: http.IncomingMessage, res: http.ServerResponse): void {
        const u = url.parse(req.url || '', true);
        const q = (u.query || {}) as Record<string, string | undefined>;
        const p = this.nasFnParams(res, q);
        if (!p) return;
        const guid = (q.guid || '').toString();
        if (!guid) {
            this.json(res, 400, { ok: false, error: '缺少 guid 参数' });
            return;
        }
        p.api.getStreamListCached(p.itemGuid).then((r) => {
            const streams: any[] = (r.success && r.data && (r.data as any).subtitle_streams) || [];
            const idx = streams.findIndex((s) => String(s.guid) === guid);
            const hit = idx >= 0 ? streams[idx] : undefined;
            const lang = String(hit?.language || '').trim();
            const name = String(hit?.title || '').trim() || [lang && lang !== 'und' ? lang : '', `字幕#${idx + 1}`].filter(Boolean).join(' ');
            const sub = { id: guid, name: name || guid, format: hit?.format || 'srt' };
            return p.api.downloadSubtitle([sub]).then((paths) => {
                if (!paths || paths.length === 0) {
                    log.warn(`[playbackShim][nas-subtitle-file] 下载失败 guid=${guid}`);
                    this.json(res, 200, { ok: false, error: '字幕下载失败(NAS 上不存在或无权限)' });
                    return;
                }
                log.info(`[playbackShim][nas-subtitle-file] 就绪 guid=${guid} -> ${paths[0]}`);
                this.json(res, 200, { ok: true, path: paths[0], title: sub.name });
            });
        }).catch((e) => {
            log.warn(`[playbackShim][nas-subtitle-file] 异常: ${e?.message || e}`);
            this.json(res, 500, { ok: false, error: String(e?.message || e) });
        });
    }
}

export const playbackShim = new PlaybackShim();
