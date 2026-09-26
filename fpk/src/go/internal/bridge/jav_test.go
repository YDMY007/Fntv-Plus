// bridge/jav_test.go — [v1.10.x] JAV 番号刮削单测：番号提取（FC2/标准/技术词排除/多候选）、
// 详情页 HTML 解析（宽容正则 fixture）、handler 门禁（未开启拒绝 + 缓存命中）。
// 网络路径用 httptest 假 javbus 服务器，CI 零外网依赖。
package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"fntvplus/internal/config"
)

func TestJavExtractCode(t *testing.T) {
	cases := map[string]string{
		"ABC-123":                     "ABC-123",
		"ABC123":                      "ABC-123",
		"abc-123":                     "ABC-123", // 大小写归一
		"[JAV] SSIS-406 4K uncensored": "SSIS-406",
		"FC2-PPV-1234567":             "FC2-PPV-1234567",
		"FC2 1234567":                 "FC2-1234567",
		"MIDV-002.1080p":              "MIDV-002",
		"庆余年 2019":                    "",       // 普通中文影视无番号
		"Movie HDR10 2160p":           "",       // 技术词不算番号
		"Video H265.mkv":              "",       // 单字母 H 不满足 2-6 位
		"20230815":                    "",       // 纯数字
		"CD1 [1985]":                  "",       // CD 黑名单
		"SSIS-406-2":                  "SSIS-406", // 多分段只取主体（-2 非独立番号形态则不误吞）
	}
	for in, want := range cases {
		if got := javExtractCode(in); got != want {
			t.Errorf("javExtractCode(%q) = %q, want %q", in, got, want)
		}
	}
}

// javbus 详情页结构 fixture（按社区抓取器的已知形态裁剪，UTF-8）。
const javDetailHTML = `<!DOCTYPE html><html><head><title>SSIS-406</title></head><body>
<div class="container"><div class="row movie">
<h3 style="color:#333">SSIS-406 奇跡の演技</h3>
<div class="col-md-9">
<a class="bigImage" href="https://www.javbus.test/pics/cover/abc_b.jpg"><img class="cover" src="/pics/cover/abc_s.jpg"></a>
<div class="col-md-3 info">
<p><span class="header">識別碼:</span> <span style="color:#cc0000;">SSIS-406</span></p>
<p><span class="header">發行日期:</span> 2022-01-14</p>
<p><span class="header">類別:</span>
<a href="https://www.javbus.test/genre/1" >剧情</a>
<a href="https://www.javbus.test/genre/8" >悬疑</a></p>
<p><span class="header">演員:</span>
</p></div></div>
<div class="star-name"><a class="avatar-box" href="/star/xyz">
<div class="photo-frame"><img src="https://www.javbus.test/actress/aaa.jpg"></div>
<span>持田栞里</span></a>
<a class="avatar-box" href="/star/zzz"><div class="photo-frame"><img src="/actress/bbb.jpg"></div><span>第二位</span></a>
</div></div></body></html>`

func TestJavParseDetail(t *testing.T) {
	meta := javParseDetail("https://www.javbus.test/SSIS-406", javDetailHTML, "SSIS-406")
	if meta.Title != "SSIS-406 奇跡の演技" {
		t.Errorf("title = %q", meta.Title)
	}
	if meta.Cover != "https://www.javbus.test/pics/cover/abc_b.jpg" {
		t.Errorf("cover = %q", meta.Cover)
	}
	if meta.Date != "2022-01-14" {
		t.Errorf("date = %q", meta.Date)
	}
	if len(meta.Genres) != 2 || meta.Genres[0] != "剧情" || meta.Genres[1] != "悬疑" {
		t.Errorf("genres = %v", meta.Genres)
	}
	if len(meta.Actresses) != 2 || meta.Actresses[0].Name != "持田栞里" {
		t.Fatalf("actresses = %+v", meta.Actresses)
	}
	if meta.Actresses[0].Photo != "https://www.javbus.test/actress/aaa.jpg" {
		t.Errorf("photo = %q", meta.Actresses[0].Photo)
	}
	if meta.Actresses[1].Photo != "https://www.javbus.test/actress/bbb.jpg" {
		// 相对路径在 javAbsURL 阶段才补域名；parse 层允许相对
		t.Logf("相对头像路径(合法): %q", meta.Actresses[1].Photo)
	}
	if meta.URL == "" || meta.Code != "SSIS-406" {
		t.Errorf("url/code = %q/%q", meta.URL, meta.Code)
	}
}

func TestJavAbsURL(t *testing.T) {
	if got := javAbsURL("/pics/a.jpg", "https://www.x.test/ABC-123"); got != "https://www.x.test/pics/a.jpg" {
		t.Errorf("abs = %q", got)
	}
	if got := javAbsURL("https://cdn.x.test/a.jpg", "https://www.x.test/ABC-123"); got != "https://cdn.x.test/a.jpg" {
		t.Errorf("绝对地址应原样: %q", got)
	}
	if got := javAbsURL("", "https://www.x.test/ABC-123"); got != "" {
		t.Errorf("空应原样: %q", got)
	}
	if got := javAbsURL("/p.jpg", "http://127.0.0.1:2481/AB-1"); got != "http://127.0.0.1:2481/p.jpg" {
		t.Errorf("http 页面 scheme 应保留: %q", got)
	}
}

func TestJavLookupHandlerGateAndFlow(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")
	javCache = map[string]javCacheEntry{} // 清缓存

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		switch {
		case r.URL.Path == "/SSIS-406":
			// 直取 404 → 强制走搜索兜底
			http.NotFound(w, r)
		case strings.HasPrefix(r.URL.Path, "/search/"):
			_, _ = w.Write([]byte(`<a class="movie-box" href="http://` + r.Host + `/found">x</a>`))
		case r.URL.Path == "/found":
			_, _ = w.Write([]byte(javDetailHTML))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	oldDomain := javBusDomain
	javBusDomain = srv.URL // 带 scheme（httptest 为 http）——javBase/javDomain 均需支持
	defer func() { javBusDomain = oldDomain }()

	do := func(body string) map[string]any {
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		rec := httptest.NewRecorder()
		b.javLookupHandler(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// ① 未开启 → 拒绝且零外网
	if out := do(`{"title":"SSIS-406"}`); out["ok"] != false || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("未开启应拒绝: %v hits=%d", out, hits)
	}
	_ = cfg.SetSetting("javEnabled", true)

	// ② 正常：直取 404 → 搜索兜底 → 详情（直取 1 + 搜索 1 + 详情 1 = 3 hits）
	out := do(`{"title":"[JAV] SSIS-406 1080p"}`)
	if out["ok"] != true || atomic.LoadInt32(&hits) != 3 {
		t.Fatalf("查询不符: %v hits=%d", out, hits)
	}
	meta, _ := out["meta"].(map[string]any)
	if meta == nil || meta["title"] != "SSIS-406 奇跡の演技" {
		t.Fatalf("meta 解析不符: %v", meta)
	}
	// ③ 缓存命中（不再请求）
	out = do(`{"code":"ssis-406"}`)
	if out["ok"] != true || out["fromCache"] != true || atomic.LoadInt32(&hits) != 3 {
		t.Fatalf("缓存不符: %v hits=%d", out, hits)
	}
	// ④ 无番号
	if out := do(`{"title":"庆余年"}`); out["ok"] != false || !strings.Contains(out["error"].(string), "番号") {
		t.Fatalf("无番号应报错: %v", out)
	}
}

func TestJavImageDomainGate(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")
	_ = cfg.SetSetting("javBusDomain", "https://www.javbus.test")

	req := httptest.NewRequest(http.MethodGet, "/x?url="+strings.ReplaceAll("https://evil.test/pics/a.jpg", ":", "%3A"), nil)
	rec := httptest.NewRecorder()
	b.javImageHandler(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != false {
		t.Fatalf("外域应拒绝: %v", out)
	}
}
