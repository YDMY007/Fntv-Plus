// Package proxy —— Fntv-Plus 影视增强的「反代 + 响应注入」核心。
//
// 链路（真实 fnOS 环境）：
//
//	用户点桌面图标「影视 Plus」
//	  → 官方网关把 /app/fntvplus/* 路由到本后端（127.0.0.1:22350）
//	  → 本处理器剥离 /app/fntvplus 前缀，回环请求影视网页服务 127.0.0.1:<webport>/v/...
//	  → text/html 响应注入 payload 引用块后返回；非 HTML（js/css/图片/视频 206）原样透传
//
// 设计取舍（对比 httputil.ReverseProxy）：
//   - 自己用 http.Transport.RoundTrip，精确控制「剥离哪个前缀」，不依赖 SingleHostReverseProxy 的路径拼接。
//   - Transport.DisableCompression=true + 请求去掉 Accept-Encoding，确保上游返回未压缩 HTML，
//     注入前无需先解 gzip，避免分块/gzip 导致的注入错位。
//   - 仅对 text/html 读体注入；视频 206 等非 HTML 直接流式透传（保留 Content-Range / Accept-Ranges）。
//   - 零系统文件改动：只读回环 + 响应注入，影视升级不失效、与 fndesk 不冲突、卸载零残留。
package proxy

import (
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"fntvplus/internal/admin"
	"fntvplus/internal/bridge"
	"fntvplus/internal/config"
	"fntvplus/internal/gateway"
	"fntvplus/internal/inject"
	"fntvplus/internal/stats"
)

// Deps 是构造 Server 所需的依赖。
type Deps struct {
	Upstream *url.URL // 回环上游（影视网页服务），如 http://127.0.0.1:5666
	Config   *config.Config
	Injector *inject.Injector
	Stats    *stats.Stats // 匿名使用统计（nil = 不挂统计路由）
	VarDir   string       // TRIM_PKGVAR（日志所在目录，供管理页日志查看）
	Version  string       // 应用版本（展示用）
}

// Server 持有全部路由与鉴权中间件。
type Server struct {
	mux *http.ServeMux
}

// NewServer 组装路由与处理器。
func NewServer(d Deps) *Server {
	s := &Server{mux: http.NewServeMux()}

	// 1) payload 端点：返回嵌入的前端脚本（带哈希版本，长缓存）。
	s.mux.Handle("/app/fntvplus/__payload__/", d.Injector.Handler())
	// 1b) 反馈弹窗二维码（桌面版由主进程读本地文件，网页端由后端内嵌直出）。
	s.mux.Handle("/app/fntvplus/qrcode.png", inject.QRHandler())
	// 1c) 服务桥：账号同步/外部 API 的后端网络层（fnOS 签名桥/白名单代理/Trakt/TMDB/Bangumi/豆瓣）。
	//     这些接口由增强页面（已过网关登录态）调用，同样要求网关身份。
	br := bridge.New(d.Config, d.Upstream.String())
	s.mux.Handle("/app/fntvplus/api/bridge/", br.Authed(br.MuxHandler()))

	// 2) 管理页 + 设置/状态/日志 API（管理页 GET 只读；设置/日志写入要求网关登录身份）。
	info := admin.Info{
		Version:   d.Version,
		VarDir:    d.VarDir,
		Upstream:  d.Upstream.String(),
		Injector:  d.Injector,
		StartTime: time.Now(), // 日志 API 只显示本次启动之后的行
	}
	// 管理页（含裸 /admin 调试入口）与全部管理 API：一律要求统一网关身份，
	// 无身份直连（含 127.0.0.1 回环）返回 401——不留免鉴权管理面。
	s.mux.Handle("/admin", gateway.RequireGatewayUser(admin.Page(d.Config)))
	s.mux.Handle("/admin/", gateway.RequireGatewayUser(admin.Page(d.Config)))
	s.mux.Handle("/app/fntvplus/admin", gateway.RequireGatewayUser(admin.Page(d.Config)))
	s.mux.Handle("/app/fntvplus/admin/", gateway.RequireGatewayUser(admin.Page(d.Config)))
	s.mux.Handle("/app/fntvplus/api/settings", gateway.RequireGatewayUser(admin.SettingsAPI(d.Config)))
	s.mux.Handle("/app/fntvplus/api/status", gateway.RequireGatewayUser(admin.StatusAPI(d.Config, info)))
	s.mux.Handle("/app/fntvplus/api/logs", gateway.RequireGatewayUser(admin.LogsAPI(info)))
	// 前端日志回传：虽只收文本，但写文件接口统一要求网关身份（增强页面经网关访问天然带头）。
	s.mux.Handle("/app/fntvplus/api/client-log", gateway.RequireGatewayUser(admin.ClientLogAPI(info)))

	// 2b) 匿名使用统计（设置面板「关于」页）：读状态 / 开关 / 立即上报 / 重置匿名 ID。
	//     与其它管理 API 同待遇——要求网关身份，无身份直连一律 401。
	if d.Stats != nil {
		s.mux.Handle("/app/fntvplus/api/stats", gateway.RequireGatewayUser(d.Stats.InfoHandler()))
		s.mux.Handle("/app/fntvplus/api/stats/enabled", gateway.RequireGatewayUser(d.Stats.EnabledHandler()))
		s.mux.Handle("/app/fntvplus/api/stats/ping", gateway.RequireGatewayUser(d.Stats.PingHandler()))
		s.mux.Handle("/app/fntvplus/api/stats/reset", gateway.RequireGatewayUser(d.Stats.ResetHandler()))
	}

	// 3) 白名单代理（M3 落地，M1 先占位返回 501，避免误开代理面）。
	s.mux.HandleFunc("/app/fntvplus/api/proxy", proxyAPIStub)

	// 4) 影视反代：优先 /app/fntvplus/v/**（桌面入口走这里），
	//    同时兼容裸 /v/**（SPA 内若用绝对路径 /v/... 也能命中，提升健壮性）。
	s.mux.HandleFunc("/app/fntvplus/v/", makeProxy(d, "/app/fntvplus"))
	s.mux.HandleFunc("/v/", makeProxy(d, ""))

	// 5) 兜底：/app/fntvplus 根 → 重定向到 /v/；
	//    其余全部路径（/libs、/static 等 SPA 资源，影视网页的静态资源不一定都在 /v/ 下）
	//    一律反代给上游——端口服务模式下浏览器直连本端口，本服务就是影视网页的完整镜像。
	s.mux.HandleFunc("/app/fntvplus", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/fntvplus/v/", http.StatusFound)
	})
	s.mux.HandleFunc("/", makeProxy(d, ""))

	return s
}

// ServeHTTP 实现 http.Handler。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// makeProxy 返回一个反代处理器：
//   - strip 为要从请求路径中剥离的前缀（"/app/fntvplus" 或 ""）。
//   - 回环请求 upstream + 剩余路径；HTML 注入 payload，非 HTML 透传。
func makeProxy(d Deps, strip string) http.HandlerFunc {
	transport := &http.Transport{
		DisableCompression: true, // 上游不压缩，注入更稳
		DisableKeepAlives:  true, // 不复用回环连接，规避嵌套服务间的 keep-alive 死锁
		MaxIdleConns:       100,
		IdleConnTimeout:    90 * time.Second,
		// 直连回环，不使用系统 HTTP 代理：
		Proxy: nil,
	}

	return func(w http.ResponseWriter, r *http.Request) {
		// 上游支持运行时热更新（管理页可改），每个请求取当前生效值。
		upstream := effectiveUpstream(d)

		// 剥离前缀，得到上游路径（如 /v/index.html）。
		rest := strings.TrimPrefix(r.URL.Path, strip)
		if rest == "" {
			rest = "/"
		}

		target := *upstream
		target.Path = singleJoiningSlash(upstream.Path, rest)
		target.RawQuery = r.URL.RawQuery

		// 克隆请求并改写目标。
		outReq := r.Clone(r.Context())
		outReq.URL = &target
		outReq.Host = upstream.Host
		outReq.RequestURI = "" // 必须清空，否则 RoundTrip 报错
		outReq.Header.Del("Accept-Encoding")
		outReq.Header.Del("Connection")
		// 去掉逐跳头，避免透传到上游。
		for _, h := range hopHeaders {
			outReq.Header.Del(h)
		}

		resp, err := transport.RoundTrip(outReq)
		if err != nil {
			log.Printf("[fntv-proxy] upstream error for %s: %v", target.String(), err)
			// 出错页直接内置上游设置框：填对端口当场保存当场生效，不用去设置页找。
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusBadGateway)
			cur := d.Config.Get().Upstream
			if cur == "" {
				cur = d.Upstream.String()
			}
			fmt.Fprintf(w, upstreamErrorHTML,
				html.EscapeString(err.Error()),
				html.EscapeString(cur))
			return
		}
		defer resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		enhance := d.Config.Get().EnhancementEnabled

		// 非 HTML，或增强关闭 → 原样透传（含视频 206 / Range / 分块）。
		if !enhance || !strings.Contains(strings.ToLower(ct), "text/html") {
			copyHeader(w.Header(), resp.Header)
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
			return
		}

		// HTML：读体（DisableCompression 保证未压缩）。
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			http.Error(w, "read upstream body: "+err.Error(), http.StatusBadGateway)
			return
		}
		html := string(body)
		if d.Injector.AlreadyInjected(html) {
			copyHeader(w.Header(), resp.Header)
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, strings.NewReader(html))
			return
		}
		newHTML, ok := d.Injector.Inject(html)
		if !ok {
			copyHeader(w.Header(), resp.Header)
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, strings.NewReader(html))
			return
		}

		// 写回注入后的 HTML。
		copyHeader(w.Header(), resp.Header)
		w.Header().Del("Content-Encoding")
		w.Header().Del("Transfer-Encoding")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store") // 防浏览器缓存旧 HTML
		w.Header().Set("Content-Length", strconv.Itoa(len(newHTML)))
		w.Header().Set("X-Fntv-Plus", "injected/"+d.Injector.Hash())
		log.Printf("[fntv-proxy] injected %s (payload %s)", rest, d.Injector.Hash())
		// 匿名统计的「真实使用」触发点：增强页面今天第一次被真正打开（而不是进程启动）。
		// 异步、静默：只写一条本地使用记录，不在这里发网络请求。
		if d.Stats != nil {
			go d.Stats.MarkUsed()
		}
		w.WriteHeader(resp.StatusCode)
		w.Write([]byte(newHTML))
	}
}

// effectiveUpstream 返回当前生效的上游：配置里的 upstream 优先（管理页可热改），为空/非法时回退启动推导值。
func effectiveUpstream(d Deps) *url.URL {
	if raw := strings.TrimSpace(d.Config.Get().Upstream); raw != "" {
		if u, err := url.Parse(raw); err == nil && u.Host != "" {
			return u
		}
	}
	return d.Upstream
}

// upstreamErrorHTML 是上游不可用时的自助修复页：内置上游地址输入框，保存后立即重试。
// 两个 %s 占位依次为：错误信息、当前生效上游（用于预填输入框）。
const upstreamErrorHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>影视 Plus · 上游不可用</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 560px; margin: 60px auto; padding: 0 16px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 20px 24px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .err { color: #c44; font-size: 13px; word-break: break-all; }
  .row { display: flex; gap: 8px; margin-top: 14px; }
  input { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
  button { padding: 8px 16px; border-radius: 8px; border: 1px solid #2a8; color: #2a8; background: transparent; cursor: pointer; }
  .hint { color: #888; font-size: 13px; margin-top: 10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>连不上飞牛影视网页服务</h1>
    <div class="err">%s</div>
    <div class="row">
      <input id="up" value="%s" placeholder="http://127.0.0.1:端口">
      <button onclick="save()">保存并重试</button>
    </div>
    <div class="hint">填飞牛影视网页的真实回环地址（常见：浏览器平时打开飞牛的地址）。保存后本页自动刷新；更多设置见 <a href="/app/fntvplus/admin/">管理页</a>。</div>
  </div>
  <script>
    async function save() {
      const v = document.getElementById('up').value.trim();
      await fetch('/app/fntvplus/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upstream: v })
      });
      location.reload();
    }
  </script>
</body>
</html>`

// proxyAPIStub 是白名单代理的占位（M3 落地）。M1 阶段返回 501，避免误开代理面。
func proxyAPIStub(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "proxy API not implemented yet (planned M3)", http.StatusNotImplemented)
}

// singleJoiningSlash 拼接两段路径，保证恰好一个斜杠。
func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	}
	return a + b
}

// copyHeader 浅拷贝所有响应头（逐跳头由调用方按需删除）。
func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// hopHeaders 是必须去除的逐跳头。
var hopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}
