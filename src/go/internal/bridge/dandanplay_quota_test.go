package bridge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"fntvplus/internal/config"
)

// ddpQuotaGuard 额度保护测试：弹弹play 额度有限，必须只在前面源没拿到足量弹幕时才被调用。
//
// 源链（v1.11.1）：自建源 danmu_api → B站 → 弹弹play（兜底）
// 断言的是「每种场景下弹弹play 是否被调用」，直接对应额度消耗。

// scenario 一次 prepare 场景的假上游与期望。
type scenario struct {
	name string
	// B站 侧：视频区搜索是否命中、命中集弹幕条数（0=该集无弹幕）、是否让搜索无结果
	biliHit      bool
	biliComments int
	// 自建源：未配置（本组测试聚焦 B站 与弹弹play 的关系）
	// 弹弹play：命中时弹幕条数
	ddpComments int
	// 期望弹弹play 是否被调用
	wantDDPCalled bool
	wantUsed      string
}

func TestDDPQuotaGuardOnlyCalledAsFallback(t *testing.T) {
	cases := []scenario{
		{
			name:    "B站 足量命中 → 不应消耗弹弹play 额度",
			biliHit: true, biliComments: 500, ddpComments: 9999,
			wantDDPCalled: false, wantUsed: "B站",
		},
		{
			name:    "B站 命中但条数不足 → 才用弹弹play 兜底",
			biliHit: true, biliComments: 5, ddpComments: 8000,
			wantDDPCalled: true, wantUsed: "弹弹play",
		},
		{
			name:    "B站 该集无弹幕 → 用弹弹play 兜底",
			biliHit: true, biliComments: 0, ddpComments: 6000,
			wantDDPCalled: true, wantUsed: "弹弹play",
		},
		{
			name:    "B站 搜索无匹配 → 用弹弹play 兜底",
			biliHit: false, biliComments: 0, ddpComments: 7000,
			wantDDPCalled: true, wantUsed: "弹弹play",
		},
		{
			name:    "B站 无匹配且弹弹play 也无 → 失败但不崩溃",
			biliHit: false, biliComments: 0, ddpComments: 0,
			wantDDPCalled: true, wantUsed: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var ddpCalls int32
			var biliCalls int32

			// 假 B站
			biliSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&biliCalls, 1)
				switch {
				case strings.Contains(r.URL.Path, "search/all/v2"):
					if !c.biliHit {
						_, _ = w.Write([]byte(`{"code":0,"data":{"result":[]}}`))
						return
					}
					_, _ = w.Write([]byte(`{"code":0,"data":{"result":[{"result_type":"video",
						"data":[{"bvid":"BV1test","title":"某番搬运"}]}]}}`))
				case strings.Contains(r.URL.Path, "/x/web-interface/view"):
					_, _ = w.Write([]byte(`{"code":0,"data":{"cid":555,"pages":[{"cid":555,"part":"第1话"}]}}`))
				case strings.Contains(r.URL.Path, "list.so"):
					var sb strings.Builder
					sb.WriteString(`<i><d p="1.0,1,25,16777215,0,0,0,0">弹幕</d>`)
					for i := 1; i < c.biliComments; i++ {
						fmt.Fprintf(&sb, `<d p="%d.0,1,25,16777215,0,0,0,0">弹幕</d>`, i+1)
					}
					sb.WriteString(`</i>`)
					_, _ = w.Write([]byte(sb.String()))
				default:
					w.WriteHeader(404)
				}
			}))
			defer biliSrv.Close()

			// 假弹弹play（计数即为额度消耗）
			ddpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&ddpCalls, 1)
				switch {
				case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
					_, _ = w.Write([]byte(`{"animes":[{"animeId":1,"animeTitle":"某番",
						"episodes":[{"episodeId":11,"episodeTitle":"第1话"}]}],"success":true}`))
				case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
					var sb strings.Builder
					sb.WriteString(`{"comments":[`)
					for i := 0; i < c.ddpComments; i++ {
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
			defer ddpSrv.Close()

			// 注入假上游：B站 基址与弹弹play base 都可替换
			oldBili, oldDDP := biliWebAPI, dandanplayBase
			biliWebAPI = biliSrv.URL
			dandanplayBase = ddpSrv.URL
			defer func() {
				biliWebAPI = oldBili
				dandanplayBase = oldDDP
			}()

			dir := t.TempDir()
			cfg, _ := config.Load(dir + "/config.json")
			b := New(cfg, "http://127.0.0.1:5666")
			resetDDPSecretState()

			req := httptest.NewRequest(http.MethodPost, "/x",
				strings.NewReader(`{"title":"某番","ep":1,"season":1,"isMovie":false,"biliSearch":true}`))
			req.Header.Set("X-Trim-Userid", "1000")
			rec := httptest.NewRecorder()
			b.danmakuPrepare(rec, req)

			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)

			called := atomic.LoadInt32(&ddpCalls) > 0
			if called != c.wantDDPCalled {
				t.Errorf("弹弹play 调用=%v，期望 %v（上游命中 %d 条）",
					called, c.wantDDPCalled, atomic.LoadInt32(&ddpCalls))
			}
			if c.wantUsed != "" && out["ok"] == true {
				if got := jsStr(out["source"]); got != c.wantUsed {
					t.Errorf("采用来源=%q，期望 %q", got, c.wantUsed)
				}
			}
			t.Logf("B站调用 %d 次、弹弹play调用 %d 次 → source=%v ok=%v",
				atomic.LoadInt32(&biliCalls), atomic.LoadInt32(&ddpCalls), out["source"], out["ok"])
		})
	}
}

// TestDDPQuotaNotConsumedWhenCacheHits 命中缓存时绝不消耗弹弹play 额度。
func TestDDPQuotaNotConsumedWhenCacheHits(t *testing.T) {
	var ddpCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&ddpCalls, 1)
		_, _ = w.Write([]byte(`{"animes":[],"success":true}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	dir := t.TempDir()
	cfg, _ := config.Load(dir + "/config.json")
	b := New(cfg, "http://127.0.0.1:5666")
	resetDDPSecretState()

	// 预置磁盘缓存（足量）
	cachePath := b.danmuCachePath("某番", 1, 1)
	items := make([]map[string]any, 0, 300)
	for i := 0; i < 300; i++ {
		items = append(items, map[string]any{"time": float64(i), "type": 1.0, "color": 16777215.0, "text": "缓存弹幕"})
	}
	data, _ := json.Marshal(map[string]any{
		"items": items,
		"meta": map[string]any{
			"searchTitle": "某番", "matchedTitle": "某番", "source": "bilibili",
			"ep": 1, "season": 1, "isMovie": false, "count": len(items),
			"checkedAt": float64(time.Now().Unix()),
		},
	})
	if err := os.WriteFile(cachePath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"title":"某番","ep":1,"season":1,"isMovie":false,"biliSearch":true}`))
	req.Header.Set("X-Trim-Userid", "1000")
	rec := httptest.NewRecorder()
	b.danmakuPrepare(rec, req)

	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != true {
		t.Fatalf("应命中缓存成功: %v", out["error"])
	}
	if n := atomic.LoadInt32(&ddpCalls); n != 0 {
		t.Errorf("命中缓存时不应调用弹弹play（额度消耗），实际 %d 次", n)
	}
}
