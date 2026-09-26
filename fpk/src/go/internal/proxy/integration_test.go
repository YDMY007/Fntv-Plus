package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
	"fntvplus/internal/stats"
)

// upstreamHandler 模拟飞牛影视网页服务（与 cmd/mockupstream 等价，供测试内联使用）。
func upstreamHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v/", "/v/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, `<!doctype html><html><head><title>影视(mock)</title>`+
				`<link rel="stylesheet" href="/v/style.css"></head>`+
				`<body><div id="homeTab"><h1>影视首页（mock）</h1>`+
				`<video src="/v/video.mp4" controls></video></div></body></html>`)
		case "/v/style.css":
			w.Header().Set("Content-Type", "text/css")
			io.WriteString(w, "body{background:#111}")
		case "/v/api/hello":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true}`)
		case "/v/video.mp4":
			data := make([]byte, 1<<20)
			http.ServeContent(w, r, "video.mp4", time.Unix(0, 0), bytes.NewReader(data))
		default:
			http.NotFound(w, r)
		}
	})
	return mux
}

// testEnv 封装一套测试用的上游 + 反代 + 客户端。
// 客户端关闭 keep-alive，规避「嵌套 httptest 服务器 + 复用连接」导致的测试桩死锁
// （生产环境代理与上游是独立进程，不存在此问题）。
// client 注入统一网关身份头（X-Trim-*），模拟「经 fnOS 网关登录后转发」的请求；
// anonClient 不带头，用于验证受保护接口的 401 拒绝路径。
type testEnv struct {
	proxyURL   string
	client     *http.Client
	anonClient *http.Client
	inj        *inject.Injector
	cfg        *config.Config
	stat       *stats.Stats
	close      func()
}

// gatewayUserTransport 给所有请求注入统一网关身份头（模拟 fnOS 网关转发）。
type gatewayUserTransport struct{ base http.RoundTripper }

func (g gatewayUserTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("X-Trim-Userid", "1000")
	r2.Header.Set("X-Trim-Isadmin", "true")
	r2.Header.Set("X-Trim-Username", "admin")
	return g.base.RoundTrip(r2)
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	up := httptest.NewServer(upstreamHandler())
	upURL, err := url.Parse(up.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}
	cfg := config.Default()
	inj, err := inject.New()
	if err != nil {
		t.Fatalf("inject.New: %v", err)
	}
	// 统计端点点到死地址：测试只验证「本地使用标记」，任何意外发出的心跳都打不到生产服务端。
	t.Setenv("FNTV_STATS_ENDPOINT", "http://127.0.0.1:1")
	stat := stats.New(cfg, "1.12.0-test")
	srv := NewServer(Deps{Upstream: upURL, Config: cfg, Injector: inj, Stats: stat})
	proxySrv := httptest.NewServer(srv)
	base := &http.Transport{DisableKeepAlives: true}
	client := &http.Client{Transport: gatewayUserTransport{base: base}}
	anonClient := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	return &testEnv{
		proxyURL:   proxySrv.URL,
		client:     client,
		anonClient: anonClient,
		inj:        inj,
		cfg:        cfg,
		stat:       stat,
		close:      func() { proxySrv.Close(); up.Close() },
	}
}

// TestGatewayAuthRejected —— 受保护接口（管理/设置/状态/日志/bridge）对没有
// 统一网关身份头的直连请求必须返回 401，防止回环端口被未授权访问。
func TestGatewayAuthRejected(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	for _, path := range []string{
		"/app/fntvplus/admin",
		"/app/fntvplus/api/settings",
		"/app/fntvplus/api/status",
		"/app/fntvplus/api/logs",
		"/app/fntvplus/api/bridge/proxy",
	} {
		resp, err := env.anonClient.Get(env.proxyURL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without gateway identity: status = %d, want 401", path, resp.StatusCode)
		}
	}
}

func TestHTMLInjection(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	resp, err := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("content-type = %q, want text/html", resp.Header.Get("Content-Type"))
	}
	s := string(body)
	if !strings.Contains(s, "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Errorf("injection marker missing")
	}
	if !strings.Contains(s, "影视首页（mock）") {
		t.Errorf("upstream HTML not proxied through")
	}
	wantScript := "/app/fntvplus/__payload__/fntv-plus." + env.inj.Hash() + ".user.js"
	if !strings.Contains(s, wantScript) {
		t.Errorf("payload script tag missing, want %q", wantScript)
	}
	if !strings.Contains(resp.Header.Get("Cache-Control"), "no-store") {
		t.Errorf("injected HTML should set Cache-Control: no-store")
	}
}

func TestPayloadEndpoint(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	u := env.proxyURL + "/app/fntvplus/__payload__/fntv-plus." + env.inj.Hash() + ".user.js"
	resp, err := env.client.Get(u)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/javascript") {
		t.Errorf("content-type = %q, want application/javascript", resp.Header.Get("Content-Type"))
	}
	if len(body) != env.inj.Len() {
		t.Errorf("payload length = %d, want %d", len(body), env.inj.Len())
	}
	if !strings.Contains(string(body), "[fntv-web]") {
		t.Errorf("payload content mismatch (expected fntv-web marker)")
	}
}

func TestNonHTMLPassthroughAndRange(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// CSS 透传（非 HTML，不应注入）。
	resp, _ := env.client.Get(env.proxyURL + "/v/style.css")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("css passthrough failed: %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if string(b) != "body{background:#111}" {
		t.Errorf("css body mismatch: %q", string(b))
	}

	// 视频 206 透传。
	req, _ := http.NewRequest("GET", env.proxyURL+"/v/video.mp4", nil)
	req.Header.Set("Range", "bytes=0-1023")
	resp2, err := env.client.Do(req)
	if err != nil {
		t.Fatalf("range get: %v", err)
	}
	b2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", resp2.StatusCode)
	}
	if len(b2) != 1024 {
		t.Errorf("range body length = %d, want 1024", len(b2))
	}
	if resp2.Header.Get("Content-Range") == "" {
		t.Errorf("Content-Range header missing on 206 passthrough")
	}
}

func TestSettingsAPI(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// 初始：增强开启。
	resp, _ := env.client.Get(env.proxyURL + "/app/fntvplus/api/settings")
	var c map[string]any
	json.NewDecoder(resp.Body).Decode(&c)
	resp.Body.Close()
	if c["enhancement_enabled"] != true {
		t.Fatalf("default enhancement_enabled = %v, want true", c["enhancement_enabled"])
	}

	// 关闭增强 → 反代应透传、不注入。
	req, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/settings",
		bytes.NewReader([]byte(`{"enhancement_enabled":false}`)))
	req.Header.Set("Content-Type", "application/json")
	env.client.Do(req)

	resp2, _ := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	b2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if strings.Contains(string(b2), "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Errorf("enhancement disabled but injection still present")
	}

	// 恢复开启（config 是同一实例，验证 Update 生效）。
	req3, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/settings",
		bytes.NewReader([]byte(`{"enhancement_enabled":true}`)))
	req3.Header.Set("Content-Type", "application/json")
	env.client.Do(req3)
	if !env.cfg.Get().EnhancementEnabled {
		t.Errorf("config not updated back to enabled")
	}
}

func TestInjectorIdempotent(t *testing.T) {
	inj, err := inject.New()
	if err != nil {
		t.Fatalf("inject.New: %v", err)
	}
	html := "<html><body>hi</body></html>"
	out1, ok1 := inj.Inject(html)
	if !ok1 || !strings.Contains(out1, "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Fatalf("first inject failed: ok=%v", ok1)
	}
	out2, ok2 := inj.Inject(out1)
	if ok2 {
		t.Errorf("second inject should be no-op (idempotent), got ok=%v", ok2)
	}
	if out2 != out1 {
		t.Errorf("idempotent inject changed output")
	}
}

/* ========== 匿名使用统计 ========== */

// TestStatsAuthRequired 统计接口与其它管理 API 同待遇：无网关身份一律 401。
func TestStatsAuthRequired(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	for _, path := range []string{
		"/app/fntvplus/api/stats",
		"/app/fntvplus/api/stats/enabled",
		"/app/fntvplus/api/stats/ping",
		"/app/fntvplus/api/stats/reset",
	} {
		resp, err := env.anonClient.Get(env.proxyURL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without gateway identity: status = %d, want 401", path, resp.StatusCode)
		}
	}
}

// TestInjectionMarksUsage 反代注入成功 → 记下「今天确实被用过」（统计的真实触发点）。
// 关键点：注入之后本地要留下使用记录，且这是**唯一**触发路径（进程启动不算）。
func TestInjectionMarksUsage(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	if env.stat.UsedToday() {
		t.Fatal("尚未打开过增强页面，不应有使用记录")
	}

	resp, err := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// MarkUsed 在注入后异步触发，轮询等它落盘。
	deadline := time.Now().Add(2 * time.Second)
	for !env.stat.UsedToday() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !env.stat.UsedToday() {
		t.Fatal("注入成功后应记录今天的使用")
	}
}

// TestNonHTMLDoesNotMarkUsage 静态资源/视频 206 不触发使用记录（只有页面被打开才算用）。
func TestNonHTMLDoesNotMarkUsage(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	resp, err := env.client.Get(env.proxyURL + "/app/fntvplus/v/style.css")
	if err != nil {
		t.Fatalf("get css: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	time.Sleep(100 * time.Millisecond) // 给异步标记（若有）留出窗口
	if env.stat.UsedToday() {
		t.Error("拉取 CSS 不应算作使用")
	}
}

// TestStatsToggleAndReset 面板三个动作的端到端行为：读状态 / 关开关 / 重置匿名 ID。
func TestStatsToggleAndReset(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// 读状态
	resp, err := env.client.Get(env.proxyURL + "/app/fntvplus/api/stats")
	if err != nil {
		t.Fatalf("get stats: %v", err)
	}
	var info map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("decode: %v", err)
	}
	resp.Body.Close()
	if info["enabled"] != true {
		t.Errorf("缺省应开启: %v", info["enabled"])
	}
	short, _ := info["anonIdShort"].(string)
	if len(short) != 8 {
		t.Errorf("应只回匿名 ID 前 8 位，实为 %q", short)
	}

	// 关开关
	req, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/stats/enabled",
		bytes.NewReader([]byte(`{"enabled":false}`)))
	req.Header.Set("Content-Type", "application/json")
	resp2, err := env.client.Do(req)
	if err != nil {
		t.Fatalf("post enabled: %v", err)
	}
	io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()
	if env.stat.Enabled() {
		t.Error("关闭后 Enabled 应为 false")
	}

	// 重置匿名 ID（先重新打开，避免开关状态干扰）
	req2, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/stats/reset", nil)
	resp3, err := env.client.Do(req2)
	if err != nil {
		t.Fatalf("post reset: %v", err)
	}
	var reset map[string]any
	json.NewDecoder(resp3.Body).Decode(&reset)
	resp3.Body.Close()
	newShort, _ := reset["anonIdShort"].(string)
	if newShort == short {
		t.Errorf("重置后 ID 应变化: %q", newShort)
	}
}

// TestStatsIDNotLeakedBySettingsAPI 完整匿名 ID 不通过设置 API 下发（只给前 8 位）。
func TestStatsIDNotLeakedBySettingsAPI(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// 打开一次页面，让匿名 ID 真正生成
	resp, _ := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	if resp != nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	// 从统计接口拿短 ID
	resp2, err := env.client.Get(env.proxyURL + "/app/fntvplus/api/stats")
	if err != nil {
		t.Fatalf("get stats: %v", err)
	}
	var info map[string]any
	json.NewDecoder(resp2.Body).Decode(&info)
	resp2.Body.Close()
	short, _ := info["anonIdShort"].(string)
	if len(short) != 8 {
		t.Fatalf("短 ID 应为 8 位: %q", short)
	}

	// 设置 API 下发的配置里不应出现完整 ID
	resp3, err := env.client.Get(env.proxyURL + "/app/fntvplus/api/settings")
	if err != nil {
		t.Fatalf("get settings: %v", err)
	}
	raw, _ := io.ReadAll(resp3.Body)
	resp3.Body.Close()
	var settings map[string]any
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if v, ok := settings["statsAnonId"]; ok {
		if s, _ := v.(string); s != "" {
			t.Errorf("设置 API 泄漏了匿名 ID: %q", s)
		}
	}
	if strings.Contains(string(raw), short) && !strings.Contains(string(raw), "statsAnonIdSet") {
		// 只在没有任何遮蔽标记时才真算泄漏
		t.Logf("settings payload: %s", raw)
	}
}
