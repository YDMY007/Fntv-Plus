package bridge

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fntvplus/internal/config"
)

// TestBiliRateLimitDetected B站 list.so 被风控（HTTP 412 + HTML 错误页）时必须被识别为限流，
// 而不是当作「该集没有弹幕数据」。
//
// 由来：源链改为 自建源 → B站 → 弹弹play 后，B站 成为主路径；连续请求会让 B站 返回
// 412 + HTML 错误页（实测），旧实现丢给 XML 解析器 → 0 命中 → 误报「没有弹幕」并触发
// 弹弹play 兜底白耗配额。此测试钉住「能区分限流与真的没弹幕」。
func TestBiliRateLimitDetected(t *testing.T) {
	const htmlPage = "<!DOCTYPE html>\n<html lang=\"zh-cn\"><head><title>412</title></head><body>风控</body></html>"

	cases := []struct {
		name       string
		status     int
		body       string
		wantItems  int
		wantLimit  bool
		wantReason string
	}{
		{
			name: "HTTP 412 风控", status: http.StatusPreconditionFailed, body: htmlPage,
			wantItems: 0, wantLimit: true, wantReason: "B站 接口限流（稍后重试，或登录 B站 账号提高额度）",
		},
		{
			name: "HTTP 200 但返回 HTML 错误页", status: http.StatusOK, body: htmlPage,
			wantItems: 0, wantLimit: true, wantReason: "B站 接口限流（稍后重试，或登录 B站 账号提高额度）",
		},
		{
			name: "正常 XML（含 1 条弹幕）", status: http.StatusOK,
			body:      `<i><d p="1.0,1,25,16777215,0,0,0,0">弹幕</d></i>`,
			wantItems: 1, wantLimit: false, wantReason: "该集没有弹幕数据",
		},
		{
			name: "真空 XML（无弹幕节点）", status: http.StatusOK, body: `<i></i>`,
			wantItems: 0, wantLimit: false, wantReason: "该集没有弹幕数据",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			old := biliWebAPI
			biliWebAPI = srv.URL
			defer func() { biliWebAPI = old; biliRateLimited.Store(false) }()

			cfg := config.Default()
			b := New(cfg, "http://127.0.0.1:5666")
			items := b.biliFetchDanmakuXML(123)

			if len(items) != c.wantItems {
				t.Errorf("弹幕条数=%d，期望 %d", len(items), c.wantItems)
			}
			if got := biliRateLimited.Load(); got != c.wantLimit {
				t.Errorf("限流标记=%v，期望 %v", got, c.wantLimit)
			}
			if got := biliNoDataReason(); got != c.wantReason {
				t.Errorf("原因文案=%q，期望 %q", got, c.wantReason)
			}
		})
	}
}

// TestBiliRateLimitNotLeakingAcrossCalls 限流标记按「最近一次请求」重置，不会粘住。
func TestBiliRateLimitNotLeakingAcrossCalls(t *testing.T) {
	var limited bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if limited {
			w.WriteHeader(http.StatusPreconditionFailed)
			_, _ = w.Write([]byte("<!DOCTYPE html><html></html>"))
			return
		}
		_, _ = w.Write([]byte(`<i><d p="1.0,1,25,16777215,0,0,0,0">弹幕</d></i>`))
	}))
	defer srv.Close()
	old := biliWebAPI
	biliWebAPI = srv.URL
	defer func() { biliWebAPI = old; biliRateLimited.Store(false) }()

	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	// 先成功一次
	if items := b.biliFetchDanmakuXML(1); len(items) != 1 {
		t.Fatalf("首次应成功: %d", len(items))
	}
	if biliRateLimited.Load() {
		t.Error("成功后不应标记限流")
	}
	// 再限流
	limited = true
	if items := b.biliFetchDanmakuXML(2); len(items) != 0 {
		t.Fatalf("限流时应为 0 条: %d", len(items))
	}
	if !biliRateLimited.Load() {
		t.Error("应标记限流")
	}
	// 恢复
	limited = false
	if items := b.biliFetchDanmakuXML(3); len(items) != 1 {
		t.Fatalf("恢复后应成功: %d", len(items))
	}
	if biliRateLimited.Load() {
		t.Error("恢复后不应仍标记限流（标记按最近一次请求重置）")
	}
}

// TestBiliRateLimitSurfacesInSourceNote 限流经 biliResolve 反映到来源详情备注。
func TestBiliRateLimitSurfacesInSourceNote(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "search/all/v2"):
			_, _ = w.Write([]byte(`{"code":0,"data":{"result":[{"result_type":"video",
				"data":[{"bvid":"BV1test","title":"某番搬运"}]}]}}`))
		case strings.Contains(r.URL.Path, "/x/web-interface/view"):
			_, _ = w.Write([]byte(`{"code":0,"data":{"cid":555,"pages":[{"cid":555,"part":"第1话"}]}}`))
		default: // list.so → 412
			w.WriteHeader(http.StatusPreconditionFailed)
			_, _ = w.Write([]byte("<!DOCTYPE html><html></html>"))
		}
	}))
	defer srv.Close()
	old := biliWebAPI
	biliWebAPI = srv.URL
	defer func() { biliWebAPI = old; biliRateLimited.Store(false) }()

	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")
	res := b.biliResolve("某番", 1, 1)
	if res == nil {
		t.Fatal("应返回结果（命中条目但限流）")
	}
	if !strings.Contains(res.reason, "限流") {
		t.Errorf("原因应说明限流，实际 %q", res.reason)
	}
	if !strings.Contains(res.detail.Note, "限流") {
		t.Errorf("来源详情备注应说明限流，实际 %q", res.detail.Note)
	}
}
