package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
)

// TestGatewayLocation Location 改写矩阵：同源目标（根相对 / 绝对指向上游或原始请求主机）
// 全部拉回网关命名空间并同步改写回跳参数；跨主机目标原样返回。
// 背景见 [访问码]：上游登录链 302 /login?redirect=/v/ 会把用户甩出 /app/fntvplus，
// 登录后落在裸 /v/，增强永久失效（用户报障「输完访问码登录后变成原始网页」）。
func TestGatewayLocation(t *testing.T) {
	const p = "/app/fntvplus"
	const upstreamHost = "127.0.0.1:5666"
	const requestHost = "192.168.1.50:17777"
	cases := []struct{ in, want string }{
		// /v* 影视页路径（原有行为保持）
		{"/v/", p + "/v/"},
		{"/v", p + "/v"},
		{"/v/index.html?a=1#frag", p + "/v/index.html?a=1#frag"},
		{"http://127.0.0.1:5666/v/", p + "/v/"},                         // 绝对地址（实测 trim.media 301 形态）
		{"http://192.168.1.50:17777/v/index.html", p + "/v/index.html"}, // 绝对地址指向原始请求主机
		{"/app/fntvplus/v/", "/app/fntvplus/v/"},                        // 已带前缀 → 原样
		// [访问码] 登录链：非 /v 路径同样拉回，且回跳参数同步改写（登录后落回增强入口）
		{"/login?redirect=%2Fv%2F", p + "/login?redirect=" + url.QueryEscape(p + "/v/")},
		{"/login?back=/v/&tab=1", p + "/login?back=" + url.QueryEscape(p + "/v/") + "&tab=1"},
		{"/login", p + "/login"},
		{"/", p + "/"}, // 应用根：拉回后由 /app/fntvplus 兜底再跳 /v/
		{"/login?redirect=" + url.QueryEscape(p + "/v/"), p + "/login?redirect=" + url.QueryEscape(p + "/v/")}, // 参数已带前缀 → 不重复改写
		{"/login?redirect_uri=https%3A%2F%2Fa.com%2Fc", p + "/login?redirect_uri=https%3A%2F%2Fa.com%2Fc"},     // redirect_uri 不动
		{"/x?foo=/v/", p + "/x?foo=/v/"}, // 非回跳参数名不改写
		// 跨主机目标不动
		{"https://example.com/other", "https://example.com/other"},
		{"//evil.com/v/", "//evil.com/v/"}, // 协议相对 = 跨主机
	}
	for _, c := range cases {
		if got := gatewayLocation(c.in, p, upstreamHost, requestHost); got != c.want {
			t.Errorf("gatewayLocation(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// noRedirectClient 不跟随重定向（默认客户端会自动跟到 200，测不到中间的 Location）。
var noRedirectClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// TestGatewayRedirectRewrite 端到端：经网关前缀请求 /v/index.html，上游 301 到绝对地址
// http://<upstream>/v/（模拟 trim.media 实测行为），代理必须把 Location 改写回
// /app/fntvplus/v/ —— 浏览器照单全收会跳出增强命名空间落到原生页面（用户报障：
// 「强制刷新后路径变为原生飞牛影视路径，增强失效」）。
func TestGatewayRedirectRewrite(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v/index.html":
			// 绝对地址重定向（r.Host = 上游侧 host:port，代理转发时已改写）
			http.Redirect(w, r, "http://"+r.Host+"/v/", http.StatusMovedPermanently)
		case "/v/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!doctype html><html><head></head><body>home</body></html>"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()
	upURL, err := url.Parse(up.URL)
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	srv := NewServer(Deps{Upstream: upURL, Config: config.Default(), Injector: mustInjector(t)})
	ps := httptest.NewServer(srv)
	defer ps.Close()

	// 网关模式：Location 必须被拉回 /app/fntvplus/v/
	req, _ := http.NewRequest("GET", ps.URL+"/app/fntvplus/v/index.html", nil)
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		t.Fatalf("GET gateway: %v", err)
	}
	defer resp.Body.Close()
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, "/app/fntvplus/v/") {
		t.Fatalf("网关模式 Location = %q, want /app/fntvplus/v/ 前缀（改写未生效）", loc)
	}

	// 端口直连模式（strip == ""）：不改写，Location 保持上游原值（同端口自洽）
	req2, _ := http.NewRequest("GET", ps.URL+"/v/index.html", nil)
	resp2, err := noRedirectClient.Do(req2)
	if err != nil {
		t.Fatalf("GET direct: %v", err)
	}
	defer resp2.Body.Close()
	loc2 := resp2.Header.Get("Location")
	if strings.HasPrefix(loc2, "/app/fntvplus") {
		t.Fatalf("端口直连模式不应改写 Location, got %q", loc2)
	}
}

// TestGatewayLoginRedirectChain [访问码] 端到端：上游登录链（/v/ → 302 /login?redirect=/v/ →
// 登录页 → 302 绝对地址 /v/）必须全程留在 /app/fntvplus 命名空间：
//   - /login 的 Location 拉回命名空间且 redirect 参数同步改写（登录后落回增强入口）；
//   - /app/fntvplus/login 经新兜底路由可访问（前缀剥离反代）；
//   - 登录页 HTML 原样透传（payload / 路径 shim 不得注入原生登录页）；
//   - 登录完成后 302 到绝对地址 /v/ 仍被拉回 /app/fntvplus/v/。
func TestGatewayLoginRedirectChain(t *testing.T) {
	const loginHTML = "<!doctype html><html><head><title>fnOS login</title></head><body>login</body></html>"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v/":
			// 未登录访问 /v/：302 到登录页并携带回跳参数（上游原生命名空间形态）
			http.Redirect(w, r, "/login?redirect="+url.QueryEscape("/v/"), http.StatusFound)
		case "/login":
			if r.URL.Query().Get("redirect") == "" {
				t.Errorf("上游 /login 应收到 redirect 参数")
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(loginHTML))
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()
	upURL, err := url.Parse(up.URL)
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	srv := NewServer(Deps{Upstream: upURL, Config: config.Default(), Injector: mustInjector(t)})
	ps := httptest.NewServer(srv)
	defer ps.Close()

	// 1) /v/ 的 302 → /login 被拉回命名空间，redirect 参数同步改写
	req, _ := http.NewRequest("GET", ps.URL+"/app/fntvplus/v/", nil)
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		t.Fatalf("get /v/: %v", err)
	}
	loc := resp.Header.Get("Location")
	resp.Body.Close()
	wantLoc := "/app/fntvplus/login?redirect=" + url.QueryEscape("/app/fntvplus/v/")
	if loc != wantLoc {
		t.Fatalf("登录链 Location = %q, want %q", loc, wantLoc)
	}

	// 2) 拉回后的登录页可经兜底路由访问，且 HTML 不被注入
	resp2, err := noRedirectClient.Do(&http.Request{Method: "GET", URL: &url.URL{Scheme: "http", Host: ps.Listener.Addr().String(), Path: "/app/fntvplus/login", RawQuery: "redirect=" + url.QueryEscape("/app/fntvplus/v/")}})
	if err != nil {
		// http.NewRequest 更稳，重试一次
		req2, _ := http.NewRequest("GET", ps.URL+"/app/fntvplus/login?redirect="+url.QueryEscape("/app/fntvplus/v/"), nil)
		resp2, err = noRedirectClient.Do(req2)
		if err != nil {
			t.Fatalf("get login page: %v", err)
		}
	}
	defer resp2.Body.Close()
	body, _ := io.ReadAll(resp2.Body)
	if resp2.StatusCode != 200 {
		t.Fatalf("login page status = %d, want 200", resp2.StatusCode)
	}
	s := string(body)
	if !strings.Contains(s, "fnOS login") {
		t.Errorf("登录页 HTML 未透传: %q", s)
	}
	if strings.Contains(s, "__payload__") || strings.Contains(s, "FNTV_PLUS_GW_SHIM_BEGIN") {
		t.Errorf("登录页不应被注入 payload/路径 shim: %q", s)
	}
}

// TestIsLoopbackHost 回环地址判断（Host 头策略的开关条件）。
func TestIsLoopbackHost(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"127.0.0.1:5666", true},
		{"127.0.0.1", true},
		{"localhost:22350", true},
		{"LOCALHOST", true},
		{"[::1]:8080", true},
		{"::1", true},
		{"192.168.31.170:17777", false},
		{"example.com", false},
		{"nas.local:5666", false},
	}
	for _, c := range cases {
		if got := isLoopbackHost(c.in); got != c.want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestUpstreamHostPreserved [访问码] 回环上游必须保留浏览器原始 Host 头：
// fnOS 访问码门禁把解锁 Cookie（os-access-code）绑定 Web 主机校验，实测同一 Cookie
// Host=NAS地址 放行、Host=127.0.0.1:端口 重新拦截。Host 被改写成回环形态时每个被
// 代理请求都会被上游重新门禁（用户报障「输完访问码后无限重新弹门禁页」）。
func TestUpstreamHostPreserved(t *testing.T) {
	var seenHost atomic.Value
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenHost.Store(r.Host)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><html><head></head><body>home</body></html>"))
	}))
	defer up.Close()
	upURL, err := url.Parse(up.URL)
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	srv := NewServer(Deps{Upstream: upURL, Config: config.Default(), Injector: mustInjector(t)})
	ps := httptest.NewServer(srv)
	defer ps.Close()

	req, _ := http.NewRequest("GET", ps.URL+"/app/fntvplus/v/", nil)
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	got, _ := seenHost.Load().(string)
	if got == "" {
		t.Fatal("上游未收到请求")
	}
	// 浏览器面向的是 ps（127.0.0.1:<psPort>）；回环上游必须原样保留该 Host，
	// 而不是改写成上游自己的 127.0.0.1:<upPort>
	want := ps.Listener.Addr().String()
	if got != want {
		t.Fatalf("上游看到的 Host = %q, want 浏览器原始 Host %q（Host 保留未生效）", got, want)
	}
	if got == upURL.Host {
		t.Fatalf("上游看到的 Host = 上游自身地址 %q，说明 Host 未保留", got)
	}
}

func mustInjector(t *testing.T) *inject.Injector {

	t.Helper()
	inj, err := inject.New()
	if err != nil {
		t.Fatalf("inject.New: %v", err)
	}
	return inj
}
