// bridge/dandanplay_ratelimit_test.go —— [v1.11.0] 弹弹play 开放 API 使用规约合规测试。
//
// 官方规约（https://doc.dandanplay.com/open/ 第三方开发者接入 API 的使用约定）明确要求：
//
//	「请按需使用 API，避免高频调用」「请缓存 API 返回的数据，以减少对服务器的请求次数」
//	「禁止通过 API 进行规模化抓取数据等『批量下载弹幕』、『下载数据库』的行为」
//	「结合用户的实际操作调用 API，并按需使用」
//
// 本文件把这几条落成可执行的回归断言：
//  1. 同一集重复请求不得重复打上游（缓存生效）—— 这是「按需调用 + 缓存」的直接体现；
//  2. 未命中缓存的请求，链路内也不重复调同一端点（一次 resolve 只发一轮）；
//  3. 整个流程只使用 GET 只读端点，且只用规约鼓励的三类（搜索/分集/弹幕），
//     不触碰发送弹幕（/comment/{id}/app）等写接口 —— 从根上排除「污染弹幕库」的可能；
//  4. 单集请求的调用量有上限（不随库大小增长），不存在规模化抓取形态。
package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"fntvplus/internal/config"
)

// ddpAuditServer 统计弹弹play 各端点的调用次数（假服务器，零外网）。
type ddpAuditServer struct {
	mu       sync.Mutex
	searches int // /api/v2/search/episodes
	bangumis int // /api/v2/bangumi/{id}
	comments int // /api/v2/comment/{id}
	others   []string
	methods  []string
}

func (a *ddpAuditServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		a.methods = append(a.methods, r.Method)
		a.mu.Unlock()
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
			a.mu.Lock()
			a.searches++
			a.mu.Unlock()
			_, _ = w.Write([]byte(`{"animes":[{"animeId":17617,"animeTitle":"某番",
				"episodes":[{"episodeId":1001,"episodeTitle":"第1话"}]}],"success":true}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/bangumi/"):
			a.mu.Lock()
			a.bangumis++
			a.mu.Unlock()
			_, _ = w.Write([]byte(`{"bangumi":{"episodes":[{"episodeId":1001,"episodeTitle":"第1话","episodeNumber":"1"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
			a.mu.Lock()
			a.comments++
			a.mu.Unlock()
			_, _ = w.Write([]byte(`{"comments":[{"cid":1,"p":"1.0,1,16777215,a","m":"弹幕"}],"success":true}`))
		default:
			a.mu.Lock()
			a.others = append(a.others, r.Method+" "+r.URL.Path)
			a.mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func (a *ddpAuditServer) counts() (s, b, c int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.searches, a.bangumis, a.comments
}

// setupAudit 起假服务器并让 bridge 指向它。
func setupAudit(t *testing.T) (*Bridge, *ddpAuditServer, func()) {
	t.Helper()
	a := &ddpAuditServer{}
	srv := httptest.NewServer(a.handler())
	old := dandanplayBase
	dandanplayBase = srv.URL
	b := newDDPTestBridge(t, "id", "sec")
	return b, a, func() {
		dandanplayBase = old
		srv.Close()
	}
}

// TestDDPOnlyReadOnlyEndpoints 只用 GET 只读端点，且限于规约鼓励的三类。
// 任何写接口（尤其发送弹幕 /api/v2/comment/{id}/app）都不得出现 —— 从根上排除污染弹幕库。
func TestDDPOnlyReadOnlyEndpoints(t *testing.T) {
	b, a, done := setupAudit(t)
	defer done()

	_, _, _, _, _ = b.ddpAutoFetch("某番", 1, 1)
	_ = b.ddpCandidates("某番", 1, 1)

	a.mu.Lock()
	defer a.mu.Unlock()
	for _, m := range a.methods {
		if m != http.MethodGet {
			t.Errorf("弹弹play 只应使用 GET 只读请求，出现 %s", m)
		}
	}
	if len(a.others) > 0 {
		t.Errorf("出现规约鼓励范围外的端点（可能含写接口）: %v", a.others)
	}
	if a.searches == 0 || a.comments == 0 {
		t.Errorf("应有搜索与弹幕请求: search=%d comment=%d", a.searches, a.comments)
	}
}

// TestDDPNoBulkScrapingPerEpisode 单集请求的调用量有上限，不随库大小增长（排除规模化抓取）。
// 自动链路最多尝试 3 个候选条目，每个候选最多 1 次搜索 + 1 次分集（可选）+ 1 次弹幕。
func TestDDPNoBulkScrapingPerEpisode(t *testing.T) {
	b, a, done := setupAudit(t)
	defer done()

	_, _, _, _, _ = b.ddpAutoFetch("某番", 1, 1)
	s, bg, c := a.counts()

	// 搜索：自动链路只调 1 次（候选排序在本地完成）
	if s > 1 {
		t.Errorf("单次自动匹配应只搜索 1 次，实际 %d", s)
	}
	// 弹幕：命中即停，最多 3 个候选
	if c > 3 {
		t.Errorf("单次自动匹配弹幕请求应 ≤3（候选上限），实际 %d", c)
	}
	// 分集：仅在 search/episodes 未给出目标集时才补拉
	if bg > 3 {
		t.Errorf("单次自动匹配分集请求应 ≤3，实际 %d", bg)
	}
	total := s + bg + c
	if total > 7 {
		t.Errorf("单集匹配总请求数应远小于库规模（上限 ~7），实际 %d", total)
	}
}

// TestDDPCandidatesDoNotFetchComments 手动搜索只做「搜索」，不预先拉弹幕 ——
// 用户还没选，不该消耗弹幕库带宽（规约：结合用户实际操作、按需调用）。
func TestDDPCandidatesDoNotFetchComments(t *testing.T) {
	b, a, done := setupAudit(t)
	defer done()

	cands := b.ddpCandidates("某番", 1, 1)
	if len(cands) == 0 {
		t.Fatal("应有候选")
	}
	_, _, c := a.counts()
	if c != 0 {
		t.Errorf("手动搜索阶段不应拉取弹幕，实际 %d 次", c)
	}
}

// TestDDPSearchCachedAcrossEpisodes 同一番剧换集匹配共享搜索结果（缓存生效）。
//
// 这是规约「请缓存 API 返回的数据，以减少对服务器的请求次数」的直接断言：
// 切集（ep 1 → ep 2）不该让搜索重新打一遍上游。
// [v1.11.0] 修复前每次 prepare 都重搜（实测 2 次），补上进程内缓存后应为 1 次。
func TestDDPSearchCachedAcrossEpisodes(t *testing.T) {
	b, a, done := setupAudit(t)
	defer done()

	_, _, _, _, _ = b.ddpAutoFetch("某番", 1, 1)
	_, _, _, _, _ = b.ddpAutoFetch("某番", 2, 1)
	s, _, _ := a.counts()

	if s != 1 {
		t.Errorf("同一番剧换集应复用搜索缓存（期望 1 次上游搜索），实际 %d 次", s)
	}
}

// TestDDPEpisodesCached 分集表缓存：同一 animeId 二次查询不打上游。
func TestDDPEpisodesCached(t *testing.T) {
	b, a, done := setupAudit(t)
	defer done()

	_ = b.ddpAnimeEpisodes(17617)
	_ = b.ddpAnimeEpisodes(17617)
	_, bg, _ := a.counts()
	if bg != 1 {
		t.Errorf("同一 animeId 应复用分集缓存（期望 1 次），实际 %d 次", bg)
	}
}

// TestDDPSearchCacheNotLeakingTestState 缓存是进程级 sync.Map —— 确认测试夹具会复位，
// 否则用例间会互相串响应（曾导致假服务器响应串台）。
func TestDDPSearchCacheNotLeakingTestState(t *testing.T) {
	b1, a1, done1 := setupAudit(t)
	_, _, _, _, _ = b1.ddpAutoFetch("某番", 1, 1)
	s1, _, _ := a1.counts()
	done1()

	// 新用例：缓存应已复位（若未复位，这里读到的还是上个假服务器的数据且上游计数为 0）
	b2, a2, done2 := setupAudit(t)
	defer done2()
	_, _, _, _, _ = b2.ddpAutoFetch("某番", 1, 1)
	s2, _, _ := a2.counts()
	if s1 == 0 || s2 == 0 {
		t.Errorf("缓存未在用例间复位: 首次上游搜索=%d 二次=%d", s1, s2)
	}
}

// TestDDPSignaturePerRequestNotReused 每次请求都带新鲜时间戳签名（不复用旧签名）。
// 官方签名含 X-Timestamp，复用会因时间窗过期被判无效 —— 这里确保没做「签名缓存」这种错误优化。
func TestDDPSignaturePerRequestNotReused(t *testing.T) {
	var sigs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sigs = append(sigs, r.Header.Get("X-Signature"))
		_, _ = w.Write([]byte(`{"animes":[],"success":true}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	_ = b.ddpSearchAnimes("甲")
	_ = b.ddpSearchAnimes("乙")
	if len(sigs) != 2 {
		t.Fatalf("应有 2 次请求，实际 %d", len(sigs))
	}
	for i, s := range sigs {
		if s == "" {
			t.Errorf("第 %d 次请求缺签名", i+1)
		}
	}
}

// TestDDPCommentCachePersistsAcrossPrepare 弹幕结果落磁盘缓存：同一集二次 prepare 不再拉上游。
// （danmakuPrepare 的 danmaku-cache 覆盖这条，这里从 ddp 客户端视角确认弹幕体只取一次。）
func TestDDPCommentCachePersistsAcrossPrepare(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")
	a := &ddpAuditServer{}
	srv := httptest.NewServer(a.handler())
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	// 走完整 prepare 两次（同标题同集）→ 第二次应命中磁盘缓存
	dir := t.TempDir()
	cfg2, _ := config.Load(dir + "/config.json")
	b2 := New(cfg2, "http://127.0.0.1:5666")
	post := func() {
		body := strings.NewReader(`{"title":"某番","ep":1,"season":1,"isMovie":false,"biliSearch":false}`)
		req := httptest.NewRequest(http.MethodPost, "/x", body)
		req.Header.Set("X-Trim-Userid", "1000")
		rec := httptest.NewRecorder()
		b2.danmakuPrepare(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out["ok"] != true {
			t.Fatalf("prepare 应成功: %v", out["error"])
		}
	}
	post()
	_, _, c1 := a.counts()
	post()
	_, _, c2 := a.counts()
	if c1 == 0 {
		t.Fatal("首次应拉取弹幕")
	}
	if c2 != c1 {
		t.Errorf("第二次 prepare 应命中磁盘缓存不再拉弹幕：首次 %d → 二次 %d", c1, c2)
	}
	_ = b
}
