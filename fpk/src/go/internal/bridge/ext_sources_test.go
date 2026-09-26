// bridge/ext_sources_test.go — [v1.10.0] 扩展数据源（官方开放 API）单测。
// 覆盖四个新渠道的解析与 handler 语义：Fanart.tv（logo 解析/开关与 key 门禁/缓存）、
// TVMaze（summary 剥 HTML/标题剥季号/整季拉取与缓存）、OMDb（评分+千分位票数解析/缓存）、
// MAL 官方 v2（无 Client ID 时静默不请求；有 Client ID 时取 node.id）。
// 网络路径全部用 httptest 假服务器覆盖各 base var，CI 零外网依赖。
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

/* ── Fanart.tv ── */

func TestFanartParseLogosHDFirstThenLikes(t *testing.T) {
	resp := map[string]any{
		"hdmovielogo": []any{
			map[string]any{"url": "https://assets.fanart.tv/hd-low.png", "lang": "en", "likes": 1},
			map[string]any{"url": "https://assets.fanart.tv/hd-top.png", "lang": "en", "likes": 99},
		},
		"movielogo": []any{
			map[string]any{"url": "https://assets.fanart.tv/sd-top.png", "lang": "zh", "likes": 500},
		},
	}
	got := fanartParseLogos(resp, "hdmovielogo", "movielogo")
	if len(got) != 3 {
		t.Fatalf("应解析出 3 条: got %d", len(got))
	}
	// HD 键整体排在 SD 前；HD 内部按 likes 降序
	if !got[0].HD || got[0].URL != "https://assets.fanart.tv/hd-top.png" {
		t.Errorf("首条应为 likes 最高的 HD: %+v", got[0])
	}
	if got[1].URL != "https://assets.fanart.tv/hd-low.png" || got[2].URL != "https://assets.fanart.tv/sd-top.png" {
		t.Errorf("排序不符: %+v", got)
	}
	if got[2].Lang != "zh" {
		t.Errorf("lang 应透传: %+v", got[2])
	}
}

func TestFanartLogosHandlerGateAndFlow(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if !strings.HasPrefix(r.URL.Path, "/v3/movies/") {
			t.Errorf("应请求 /v3/movies/{tmdb_id}: %s", r.URL.Path)
		}
		if r.URL.Query().Get("api_key") != "k-test" {
			t.Errorf("api_key 未透传: %q", r.URL.Query().Get("api_key"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hdmovielogo": []any{map[string]any{"url": "https://assets.fanart.tv/a.png", "lang": "en", "likes": 3}},
			"movielogo":   []any{},
		})
	}))
	defer srv.Close()
	oldBase := fanartBase
	fanartBase = srv.URL
	defer func() { fanartBase = oldBase }()

	do := func() map[string]any {
		body := strings.NewReader(`{"mediaType":"movie","tmdbId":17645}`)
		req := httptest.NewRequest(http.MethodPost, "/x", body)
		rec := httptest.NewRecorder()
		b.fanartLogosHandler(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// ① 未开启 → 拒绝且零外网请求
	if out := do(); out["ok"] != false || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("未开启应拒绝且零请求: %v hits=%d", out, hits)
	}
	_ = cfg.SetSetting("fanartEnabled", true)
	// ② 开了但没 key → 拒绝
	if out := do(); out["ok"] != false || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("无 key 应拒绝且零请求: %v hits=%d", out, hits)
	}
	_ = cfg.SetSetting("fanartApiKey", "k-test")
	// ③ 正常：拿到 logo
	out := do()
	if out["ok"] != true || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("配置齐全应命中: %v hits=%d", out, hits)
	}
	// ④ 第二次走缓存（不再打外网）
	out = do()
	if out["ok"] != true || out["fromCache"] != true || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("第二次应缓存命中: %v hits=%d", out, hits)
	}
}

/* ── TVMaze ── */

func TestTvmazeStripHTMLTag(t *testing.T) {
	in := "<p>第 1 集：<b>终结</b>之始 &amp; 开端</p><div>　</div>"
	want := "第 1 集： 终结 之始 & 开端"
	if got := stripHTMLTag(in); got != want {
		t.Errorf("stripHTMLTag = %q, want %q", got, want)
	}
	if got := stripHTMLTag(""); got != "" {
		t.Errorf("空串应原样: %q", got)
	}
}

func TestTvmazeSeasonSuffixStrip(t *testing.T) {
	cases := map[string]string{
		"三体 第二季":  "三体",
		"Dark Season 2": "Dark",
		"Friends S3":    "Friends",
		"普通标题":      "普通标题",
	}
	for in, want := range cases {
		if got := reTVSeasonSuffix.ReplaceAllString(in, ""); got != want {
			t.Errorf("季号剥离 %q = %q, want %q", in, got, want)
		}
	}
}

func TestTvmazeShowHandlerFlow(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		switch {
		case r.URL.Path == "/search/shows":
			_ = json.NewEncoder(w).Encode([]any{
				map[string]any{"score": 0.9, "show": map[string]any{"id": 42, "name": "Dark"}},
			})
		case strings.HasPrefix(r.URL.Path, "/shows/42/episodes"):
			_ = json.NewEncoder(w).Encode([]any{
				map[string]any{"name": "Secrets", "season": 1, "number": 1, "airdate": "2017-12-01", "runtime": 53, "summary": "<p>Lies &amp; truth</p>"},
				map[string]any{"name": "TBD", "season": 1, "number": 2, "summary": "<p>未播出占位</p>"},
			})
		default:
			t.Errorf("意外路径: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	oldBase := tvmazeBase
	tvmazeBase = srv.URL
	defer func() { tvmazeBase = oldBase }()
	tvmazeEpCache = map[string]tvmazeCacheEntry{} // 清缓存防串

	do := func(body string) map[string]any {
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		rec := httptest.NewRecorder()
		b.tvmazeShowHandler(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// ① 未开启 → 拒绝且零外网
	if out := do(`{"title":"Dark 第二季","season":1}`); out["ok"] != false || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("未开启应拒绝: %v hits=%d", out, hits)
	}
	_ = cfg.SetSetting("tvmazeEnabled", true)

	out := do(`{"title":"Dark 第二季","season":1}`)
	if out["ok"] != true || atomic.LoadInt32(&hits) != 2 { // search + episodes
		t.Fatalf("开启后应命中: %v hits=%d", out, hits)
	}
	eps, _ := out["episodes"].([]any)
	if len(eps) != 2 {
		t.Fatalf("应返回 2 集: %v", out)
	}
	ep1, _ := eps[0].(map[string]any)
	if ep1["summary"] != "Lies & truth" {
		t.Errorf("summary 应剥 HTML 且还原实体: %v", ep1["summary"])
	}
	ep2, _ := eps[1].(map[string]any)
	if ep2["name"] != "TBD" {
		t.Errorf("TBD 透传给前端由其按占位处理: %v", ep2["name"])
	}
	// ② 第二次走缓存
	_ = do(`{"title":"Dark 第二季","season":1}`)
	if atomic.LoadInt32(&hits) != 2 {
		t.Fatalf("第二次应缓存命中不再请求: hits=%d", hits)
	}
}

/* ── OMDb ── */

func TestOmdbEnrichParsesVotesAndCaches(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.URL.Query().Get("i") != "tt0816692" || r.URL.Query().Get("apikey") != "omdb-k" {
			t.Errorf("参数不符: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Response": "True", "imdbRating": "8.2", "imdbVotes": "1,234,567",
		})
	}))
	defer srv.Close()
	oldBase := omdbBase
	omdbBase = srv.URL
	defer func() { omdbBase = oldBase }()
	omdbCache = map[string]omdbCacheEntry{}

	// ① 未开启/无 key → 静默 0
	if rating, _ := b.omdbEnrich("tt0816692"); rating != 0 || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("未开启应零请求零分: %v hits=%d", rating, hits)
	}
	_ = cfg.SetSetting("omdbEnabled", true)
	if rating, _ := b.omdbEnrich("tt0816692"); rating != 0 || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("无 key 应零请求零分: %v hits=%d", rating, hits)
	}
	// ② 正常：评分解析 + 千分位票数
	_ = cfg.SetSetting("omdbApiKey", "omdb-k")
	rating, votes := b.omdbEnrich("tt0816692")
	if rating != 8.2 || votes != 1234567 || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("解析不符: rating=%v votes=%v hits=%d", rating, votes, hits)
	}
	// ③ 缓存：第二次零请求
	if rating, votes := b.omdbEnrich("tt0816692"); rating != 8.2 || votes != 1234567 || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("缓存命中不符: %v %v hits=%d", rating, votes, hits)
	}
}

/* ── MAL 官方 v2 ── */

func TestMalOfficialID(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	var hits int32
	var gotClientID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		gotClientID = r.Header.Get("X-MAL-CLIENT-ID")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{"node": map[string]any{"id": 31964}}},
		})
	}))
	defer srv.Close()
	oldBase := malAPIBase
	malAPIBase = srv.URL
	defer func() { malAPIBase = oldBase }()

	// ① 未配置 Client ID → 不发请求静默 0
	if id := b.malOfficialID("葬送的芙莉莲"); id != 0 || atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("未配置 Client ID 应零请求: id=%v hits=%d", id, hits)
	}
	// ② 配置后：头带 Client ID，取 node.id
	_ = cfg.SetSetting("malClientId", "mal-cid")
	if id := b.malOfficialID("葬送的芙莉莲"); id != 31964 || gotClientID != "mal-cid" {
		t.Fatalf("官方 API 解析不符: id=%v cid=%q", id, gotClientID)
	}
}
