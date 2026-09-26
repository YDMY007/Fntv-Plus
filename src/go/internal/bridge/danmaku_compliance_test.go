package bridge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"fntvplus/internal/config"
)

// TestDanmakuPrepareNoRepeatUpstreamOnReplay 合规核心断言：
// 同一集反复播放（用户刷新页面/重进播放页）不得反复打上游。
//
// 官方规约：「请按需使用 API，避免高频调用」「请缓存 API 返回的数据，以减少对服务器的请求次数」。
// 修复前：缓存判断在优选源链之后 → 每次 prepare 都重跑弹弹play（实测 3 次播放 = 3 次上游弹幕请求）。
// 修复后：首次跑链路并落盘，后续直接从磁盘缓存返回，上游计数不再增长。
func TestDanmakuPrepareNoRepeatUpstreamOnReplay(t *testing.T) {
	var comments, searches int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
			atomic.AddInt32(&searches, 1)
			_, _ = w.Write([]byte(`{"animes":[{"animeId":1,"animeTitle":"某番",
				"episodes":[{"episodeId":11,"episodeTitle":"第1话"}]}],"success":true}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
			atomic.AddInt32(&comments, 1)
			// 返回足量弹幕（高于 danmuMinCount 默认 100），确保首次即被采用并落盘
			var sb strings.Builder
			sb.WriteString(`{"comments":[`)
			for i := 0; i < 150; i++ {
				if i > 0 {
					sb.WriteString(",")
				}
				sb.WriteString(`{"cid":1,"p":"1.0,1,16777215,a","m":"弹幕"}`)
			}
			sb.WriteString(`],"success":true}`)
			_, _ = w.Write([]byte(sb.String()))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	oldBase := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = oldBase }()

	dir := t.TempDir()
	cfg, err := config.Load(dir + "/config.json")
	if err != nil {
		t.Fatal(err)
	}
	// 关掉 B站 搜索：本用例只关心弹弹play 链路的上游调用
	cfg.SetSetting("biliDanmakuEnabled", "false")
	b := New(cfg, "http://127.0.0.1:5666")
	resetDDPSecretState()

	call := func() map[string]any {
		req := httptest.NewRequest(http.MethodPost, "/x",
			strings.NewReader(`{"title":"某番","ep":1,"season":1,"isMovie":false,"biliSearch":false}`))
		req.Header.Set("X-Trim-Userid", "1000")
		rec := httptest.NewRecorder()
		b.danmakuPrepare(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// 首次：跑链路
	out1 := call()
	if out1["ok"] != true {
		t.Fatalf("首次 prepare 应成功: %v", out1["error"])
	}
	c1, s1 := atomic.LoadInt32(&comments), atomic.LoadInt32(&searches)
	if c1 != 1 {
		t.Fatalf("首次应拉取 1 次弹幕，实际 %d", c1)
	}

	// 再播放 3 次：应全部命中磁盘缓存，零上游请求
	for i := 2; i <= 4; i++ {
		out := call()
		if out["ok"] != true {
			t.Fatalf("第 %d 次 prepare 应成功: %v", i, out["error"])
		}
		if out["fromCache"] != true {
			t.Errorf("第 %d 次 prepare 应标记 fromCache", i)
		}
	}
	c2, s2 := atomic.LoadInt32(&comments), atomic.LoadInt32(&searches)
	if c2 != c1 {
		t.Errorf("重复播放不应再拉弹幕：首次 %d → 4 次后 %d", c1, c2)
	}
	if s2 != s1 {
		t.Errorf("重复播放不应再搜索：首次 %d → 4 次后 %d", s1, s2)
	}
	t.Logf("上游调用：弹幕 %d 次、搜索 %d 次（4 次播放）", c2, s2)
}

// TestDanmakuPrepareSearchCacheAcrossEpisodes 切换集数时搜索走缓存（只有弹幕随集变化）。
func TestDanmakuPrepareSearchCacheAcrossEpisodes(t *testing.T) {
	var comments, searches int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
			atomic.AddInt32(&searches, 1)
			_, _ = w.Write([]byte(`{"animes":[{"animeId":1,"animeTitle":"某番",
				"episodes":[{"episodeId":11,"episodeTitle":"第1话"},{"episodeId":12,"episodeTitle":"第2话"}]}],"success":true}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
			atomic.AddInt32(&comments, 1)
			var sb strings.Builder
			sb.WriteString(`{"comments":[`)
			for i := 0; i < 150; i++ {
				if i > 0 {
					sb.WriteString(",")
				}
				sb.WriteString(`{"cid":1,"p":"1.0,1,16777215,a","m":"弹幕"}`)
			}
			sb.WriteString(`],"success":true}`)
			_, _ = w.Write([]byte(sb.String()))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	oldBase := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = oldBase }()

	dir := t.TempDir()
	cfg, _ := config.Load(dir + "/config.json")
	b := New(cfg, "http://127.0.0.1:5666")
	resetDDPSecretState()

	call := func(ep int) {
		body := fmt.Sprintf(`{"title":"某番","ep":%d,"season":1,"isMovie":false,"biliSearch":false}`, ep)
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		req.Header.Set("X-Trim-Userid", "1000")
		rec := httptest.NewRecorder()
		b.danmakuPrepare(rec, req)
	}
	call(1) // 第 1 集：搜索 + 弹幕
	call(2) // 第 2 集：搜索应命中缓存，只新增弹幕请求

	s, c := atomic.LoadInt32(&searches), atomic.LoadInt32(&comments)
	if s != 1 {
		t.Errorf("换集应复用搜索缓存（期望 1 次搜索），实际 %d 次", s)
	}
	if c != 2 {
		t.Errorf("两集各拉一次弹幕（期望 2 次），实际 %d 次", c)
	}
	t.Logf("换集上游调用：搜索 %d 次（缓存）、弹幕 %d 次", s, c)
}
