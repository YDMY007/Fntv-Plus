// bridge/dandanplay_test.go — [v1.11.0] 弹弹play 开放 API 客户端单测。
//
// 覆盖：签名算法（固定时间戳对照官方文档步骤）、凭证回落链（自定义 → 内置，
// 主 Secret 失效自动顺延备用）、响应解析（search/episodes、comment、p 属性）、
// 候选档位匹配（季号/副标题）、集定位（标题集数 → episodeNumber → 序号兜底）。
// 网络路径全部用 httptest 假服务器覆盖 dandanplayBase，CI 零外网依赖。
package bridge

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"fntvplus/internal/config"
	"fntvplus/internal/secret"
)

/* ── 签名 ── */

// TestDDPSignMatchesDocAlgorithm 按官方文档步骤手算一遍对照。
// 用示例值（文档举例形式），不写真实 AppId —— 仓库源码里不留任何可用凭证。
func TestDDPSignMatchesDocAlgorithm(t *testing.T) {
	const appID, secret = "example0app", "example-secret"
	// 文档：base64(sha256(AppId + Timestamp + Path + AppSecret))，Path 不含 query
	got := ddpSign(appID, secret, "/api/v2/comment/123450001", 1700000000)
	// 独立复算（不复用 ddpSign 内部实现）
	sum := sha256.Sum256([]byte(appID + "1700000000" + "/api/v2/comment/123450001" + secret))
	want := base64.StdEncoding.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("签名不符:\n got=%s\nwant=%s", got, want)
	}
	if len(got) != 44 {
		t.Errorf("sha256 的 base64 应为 44 字符: %d", len(got))
	}
}

// TestDDPSignPathExcludesQuery 签名用的 path 绝不能把 query 拼进去（含查表则必 403）。
func TestDDPSignPathExcludesQuery(t *testing.T) {
	withQuery := ddpSign("id", "sec", "/api/v2/comment/123?withRelated=true", 1700000000)
	plainPath := ddpSign("id", "sec", "/api/v2/comment/123", 1700000000)
	if withQuery == plainPath {
		t.Fatal("带 query 的 path 不应与纯 path 同签名")
	}
	// 调用方传的是纯 path：验证 ddpCall 实际拼 URL 时 query 走 url.Values 而非 path
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{"animes": []any{}})
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id-test", "sec-test")
	b.ddpFetchItems(123)
	if gotPath != "/api/v2/comment/123" {
		t.Errorf("path 不符: %q", gotPath)
	}
	if !strings.Contains(gotQuery, "withRelated=true") {
		t.Errorf("query 应带 withRelated: %q", gotQuery)
	}
}

func base64Std256(s string) string {
	// 独立实现（不复用 ddpSign 内部）
	h := sha256.Sum256([]byte(s))
	return base64.StdEncoding.EncodeToString(h[:])
}

// mustTS 取请求头时间戳（签名复算用）。
func mustTS(r *http.Request) int64 {
	n, _ := strconv.ParseInt(r.Header.Get("X-Timestamp"), 10, 64)
	return n
}

/* ── 凭证回落 ── */

// TestDDPBuiltinCredsDecrypt 内置凭证密文可解且形状正确。
func TestDDPBuiltinCredsDecrypt(t *testing.T) {
	id, secs := secret.BuiltinDandanplay()
	if id == "" {
		t.Fatal("内置 AppId 解密失败（builtin.go 密文与 secret 包密钥不匹配）")
	}
	if len(secs) < 2 {
		t.Fatalf("内置 Secret 应有 2 个（主 + 备用），got %d", len(secs))
	}
	for i, s := range secs {
		if len(s) < 16 {
			t.Errorf("Secret #%d 长度异常: %d", i+1, len(s))
		}
	}
	if secs[0] == secs[1] {
		t.Error("两个内置 Secret 不应相同（备用无意义）")
	}
}

// TestDDPCredsPrefersCustom 面板填了自定义凭证时优先用自定义。
func TestDDPCredsPrefersCustom(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	b.cfg.SetSetting("dandanplayAppId", "my-app-id")
	b.cfg.SetSetting("dandanplayAppSecret", "my-secret-val")

	id, secs, custom := b.ddpCreds()
	if !custom {
		t.Error("应识别为自定义凭证")
	}
	if id != "my-app-id" || len(secs) != 1 || secs[0] != "my-secret-val" {
		t.Fatalf("自定义凭证未生效: id=%q secs=%v", id, secs)
	}
}

// TestDDPCredsFallsBackToBuiltin 未配置自定义凭证时回落内置。
func TestDDPCredsFallsBackToBuiltin(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	id, secs, custom := b.ddpCreds()
	if custom {
		t.Error("未配置自定义凭证时不应标记为 custom")
	}
	if id == "" || len(secs) == 0 {
		t.Fatal("应回落到内置凭证")
	}
}

// TestDDPSecretFailover 主 Secret 认证失败时自动顺延到备用，并记住可用序号。
func TestDDPSecretFailover(t *testing.T) {
	resetDDPSecretState()
	var primary, backup int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 用签名反推是哪个 Secret（逐个试算对照）
		switch r.Header.Get("X-Signature") {
		case ddpSign("app", "GOOD", r.URL.Path, mustTS(r)):
			atomic.AddInt32(&backup, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{"animes": []any{}})
		case ddpSign("app", "BAD", r.URL.Path, mustTS(r)):
			atomic.AddInt32(&primary, 1)
			w.Header().Set("X-Error-Message", "Invalid Signature")
			w.WriteHeader(http.StatusForbidden)
		default:
			t.Errorf("签名无法匹配任何 Secret")
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old; resetDDPSecretState() }()

	b := newDDPTestBridge(t, "", "")
	// 注入「主坏备好」的凭证序列
	stubDDPCreds(t, "app", []string{"BAD", "GOOD"})

	if got := b.ddpSearchAnimes("测试"); got == nil {
		t.Fatal("备用 Secret 应能拿到结果（搜索返回空数组也算成功）")
	}
	if atomic.LoadInt32(&backup) == 0 {
		t.Error("备用 Secret 从未被使用")
	}
	if atomic.LoadInt32(&primary) == 0 {
		t.Error("主 Secret 应至少尝试一次")
	}
	// 第二次调用应直接用记住的备用（primary 不再增长）
	p1 := atomic.LoadInt32(&primary)
	_ = b.ddpSearchAnimes("测试2")
	if atomic.LoadInt32(&primary) != p1 {
		t.Errorf("已记住可用 Secret，不应再试主 Secret: before=%d after=%d", p1, atomic.LoadInt32(&primary))
	}
}

/* ── 解析 ── */

func TestDDPParseCommentModes(t *testing.T) {
	cases := []struct {
		p    string
		want int
	}{
		{"2.52,5,16777215,ca76f2e6", 5}, // 顶部
		{"1.00,4,16777215,abc", 4},      // 底部
		{"3.00,1,16777215,abc", 1},      // 滚动
		{"4.00,6,16777215,abc", 1},      // 逆向 → 归滚动
		{"5.00,7,16777215,abc", 1},      // 高级 → 归滚动
	}
	for _, c := range cases {
		it := ddpParseComment(c.p, "文本")
		if it == nil {
			t.Fatalf("解析失败: %q", c.p)
		}
		if int(jsNum(it["type"])) != c.want {
			t.Errorf("p=%q type: got %v want %d", c.p, it["type"], c.want)
		}
	}
}

func TestDDPParseCommentInvalid(t *testing.T) {
	for _, p := range []string{"", "1.0", "1.0,1", "abc,1,2", "1.0,1,x"} {
		it := ddpParseComment(p, "x")
		if p == "1.0,1,x" {
			// 颜色段非数字：ParseInt 失败得 0（黑），条目仍应保留
			if it == nil {
				t.Errorf("颜色非法不应整条丢弃: %q", p)
			}
			continue
		}
		if it != nil {
			t.Errorf("非法 p 应返回 nil: %q → %+v", p, it)
		}
	}
}

// TestDDPParseCommentColorIndex 弹弹play 的颜色在第 3 段（index 2），
// 与 B站 XML（time,mode,size,color,…，颜色在 index 3）**布局不同**。
// 回归保护：按 B站 下标取会把十六进制 uid 当颜色 → ParseInt 失败恒得 0（全屏变黑）。
func TestDDPParseCommentColorIndex(t *testing.T) {
	// 真实样本：颜色 15138835（紫红），末段是十六进制用户标识
	it := ddpParseComment("1216.68,5,15138835,9896384e", "彩色弹幕")
	if it == nil {
		t.Fatal("解析失败")
	}
	if got := int64(jsNum(it["color"])); got != 15138835 {
		t.Errorf("颜色应为 index2 的 15138835，got %d（0 说明取了 uid 段）", got)
	}
	// 白色弹幕
	it2 := ddpParseComment("2.52,5,16777215,ca76f2e6", "白")
	if got := int64(jsNum(it2["color"])); got != 16777215 {
		t.Errorf("白色弹幕 color 应为 16777215，got %d", got)
	}
	// 对照：B站 XML 布局颜色在 index 3，两者不可互换
	if got := int64(jsNum(it2["color"])); got == 0 {
		t.Error("颜色解析为 0（黑色）—— 说明按 B站 下标取到了 uid 段")
	}
}

// TestDDPCommentTextNotUnescaped 弹弹play 的 m 是纯文本，绝不能做 HTML 反转义
// （否则用户真实输入的字面量 "&amp;" 会被改成 "&"）。
func TestDDPCommentTextNotUnescaped(t *testing.T) {
	it := ddpParseComment("1.0,1,16777215,abc", "A&amp;B &lt;tag&gt;")
	if it == nil {
		t.Fatal("解析失败")
	}
	if got := jsStr(it["text"]); got != "A&amp;B &lt;tag&gt;" {
		t.Errorf("文本被错误反转义: %q", got)
	}
}

func TestDDPSearchAnimesShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes") {
			t.Errorf("path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("anime") != "芙莉莲" {
			t.Errorf("anime 参数: %q", r.URL.Query().Get("anime"))
		}
		_, _ = w.Write([]byte(`{"hasMore":false,"animes":[
			{"animeId":17617,"animeTitle":"葬送的芙莉莲","type":"tvseries",
			 "episodes":[{"episodeId":176170001,"episodeTitle":"第1话 冒险结束"}]}],
			"errorCode":0,"success":true}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	got := b.ddpSearchAnimes("芙莉莲")
	if len(got) != 1 {
		t.Fatalf("应解析 1 条: %d", len(got))
	}
	if int64(jsNum(got[0]["animeId"])) != 17617 {
		t.Errorf("animeId: %v", got[0]["animeId"])
	}
	if eps := jArr(got[0]["episodes"]); len(eps) != 1 {
		t.Errorf("episodes: %d", len(eps))
	}
}

func TestDDPFetchItemsParsesAndSorts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"count":3,"comments":[
			{"cid":1,"p":"9.00,1,16777215,a","m":"后"},
			{"cid":2,"p":"1.00,5,16777215,b","m":"先"},
			{"cid":3,"p":"5.00,4,16777215,c","m":"中"}],"success":true}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	items := b.ddpFetchItems(176170001)
	if len(items) != 3 {
		t.Fatalf("应解析 3 条: %d", len(items))
	}
	// 必须按时间升序
	for i := 1; i < len(items); i++ {
		if jsNum(items[i-1]["time"]) > jsNum(items[i]["time"]) {
			t.Fatalf("未按时间升序: %v", items)
		}
	}
	if jsStr(items[0]["text"]) != "先" {
		t.Errorf("首条应为时间最早的: %+v", items[0])
	}
}

// TestDDPFetchItemsSuccessFalse success=false 视为失败（返回 nil，不塞空结果）。
func TestDDPFetchItemsSuccessFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"errorCode":1,"errorMessage":"服务器内部错误"}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	if items := b.ddpFetchItems(1); len(items) != 0 {
		t.Errorf("success=false 应返回空: %d", len(items))
	}
}

/* ── 候选匹配档位 ── */

func TestDDPTierMatching(t *testing.T) {
	cases := []struct {
		name        string
		query       string
		querySeason int64
		cand        string
		wantMin     int // 期望档位下界（-1 = 不匹配）
		wantMax     int // 期望档位上界
	}{
		{"主名相等无季", "葬送的芙莉莲", 0, "葬送的芙莉莲", 0, 0},
		{"主名相等+季一致", "葬送的芙莉莲", 1, "葬送的芙莉莲", 0, 0},
		// 副标题但未标季：主名前缀命中（弹弹play 常把「XX篇」并进条目标题）
		{"副标题条目未标季", "葬送的芙莉莲", 0, "葬送的芙莉莲 黄金乡篇", 1, 2},
		// 候选标了第三季、查询要第一季 → 不同季，必须拒绝（挂错季比没弹幕更糟）
		{"候选项为后续季", "葬送的芙莉莲", 1, "葬送的芙莉莲 第三季 黄金乡篇", -1, -1},
		{"季号不符", "葬送的芙莉莲", 1, "葬送的芙莉莲 第二季", -1, -1},
		{"无关标题", "葬送的芙莉莲", 0, "咒术回战", -1, -1},
		{"查询与候选同标季一致", "某番 第2季", 0, "某番 第2季", 0, 0},
		{"主名相等+候选季更高(未指定季)", "某番", 0, "某番 第3季", 1, 1},
		{"前缀但候选项为后续季", "葬送的芙莉莲 第1季", 0, "葬送的芙莉莲 第3季 黄金乡篇", -1, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ddpTier(c.query, c.querySeason, c.cand)
			if got < c.wantMin || got > c.wantMax {
				t.Errorf("ddpTier(%q,%d,%q)=%d, want in [%d,%d]",
					c.query, c.querySeason, c.cand, got, c.wantMin, c.wantMax)
			}
		})
	}
}

/* ── 集定位 ── */

func TestDDPPickEpisode(t *testing.T) {
	eps := []map[string]any{
		{"episodeId": float64(101), "episodeTitle": "第1话 冒险结束", "episodeNumber": "1"},
		{"episodeId": float64(102), "episodeTitle": "第2话 不见得一定是靠魔法", "episodeNumber": "2"},
		{"episodeId": float64(103), "episodeTitle": "第3话 杀人魔法", "episodeNumber": "3"},
	}
	cases := []struct {
		ep   int64
		want float64
	}{
		{1, 101}, {2, 102}, {3, 103},
		{0, 101}, // 电影/未指定 → 首集
		{99, 0},  // 越界 → nil（不瞎选）
	}
	for _, c := range cases {
		got := ddpPickEpisode(eps, c.ep)
		if c.want == 0 {
			if got != nil {
				t.Errorf("ep=%d 应返回 nil: %+v", c.ep, got)
			}
			continue
		}
		if got == nil {
			t.Fatalf("ep=%d 应命中", c.ep)
		}
		if jsNum(got["episodeId"]) != c.want {
			t.Errorf("ep=%d → episodeId=%v want %v", c.ep, got["episodeId"], c.want)
		}
	}
}

// TestDDPPickEpisodeNumberFallback 标题无集数信息时按 episodeNumber 命中；
// 两者都无则按列表序号兜底。
func TestDDPPickEpisodeNumberFallback(t *testing.T) {
	// 标题无「第N话」，靠 episodeNumber
	byNum := []map[string]any{
		{"episodeId": float64(201), "episodeTitle": "序章", "episodeNumber": "1"},
		{"episodeId": float64(202), "episodeTitle": "终章", "episodeNumber": "2"},
	}
	if got := ddpPickEpisode(byNum, 2); got == nil || jsNum(got["episodeId"]) != 202 {
		t.Errorf("episodeNumber 兜底失败: %+v", got)
	}
	// 两者都无 → 序号兜底
	byIdx := []map[string]any{
		{"episodeId": float64(301)},
		{"episodeId": float64(302)},
	}
	if got := ddpPickEpisode(byIdx, 2); got == nil || jsNum(got["episodeId"]) != 302 {
		t.Errorf("序号兜底失败: %+v", got)
	}
}

/* ── 自动链路与候选 ── */

// TestDDPAutoFetchHappyPath 搜索 → 定位集 → 拉弹幕 全链路（假服务器）。
func TestDDPAutoFetchHappyPath(t *testing.T) {
	var commentHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
			_, _ = w.Write([]byte(`{"animes":[{"animeId":17617,"animeTitle":"葬送的芙莉莲",
				"episodes":[{"episodeId":176170002,"episodeTitle":"第2话 不见得一定是靠魔法…"}]}],"success":true}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
			atomic.AddInt32(&commentHits, 1)
			if !strings.HasSuffix(r.URL.Path, "/176170002") {
				t.Errorf("应拉第2集的弹幕: %s", r.URL.Path)
			}
			_, _ = w.Write([]byte(`{"comments":[{"cid":1,"p":"1.0,1,16777215,a","m":"弹幕"}],"success":true}`))
		default:
			t.Errorf("意外请求: %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	items, matched, epID, reason, _ := b.ddpAutoFetch("葬送的芙莉莲", 2, 1)
	if reason != "" {
		t.Fatalf("不应有失败原因: %s", reason)
	}
	if len(items) != 1 || jsStr(items[0]["text"]) != "弹幕" {
		t.Fatalf("弹幕不符: %+v", items)
	}
	if matched != "葬送的芙莉莲" || epID != 176170002 {
		t.Errorf("matched=%q epID=%d", matched, epID)
	}
	if atomic.LoadInt32(&commentHits) != 1 {
		t.Errorf("弹幕请求次数: %d", atomic.LoadInt32(&commentHits))
	}
}

// TestDDPAutoFetchEpisodeListFallback search/episodes 只回部分集时换 bangumi 端点取全集。
func TestDDPAutoFetchEpisodeListFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/search/episodes"):
			// 只回第 1 集
			_, _ = w.Write([]byte(`{"animes":[{"animeId":17617,"animeTitle":"葬送的芙莉莲",
				"episodes":[{"episodeId":176170001,"episodeTitle":"第1话 冒险结束"}]}],"success":true}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/bangumi/"):
			_, _ = w.Write([]byte(`{"bangumi":{"episodes":[
				{"episodeId":176170001,"episodeTitle":"第1话 冒险结束","episodeNumber":"1"},
				{"episodeId":176170005,"episodeTitle":"第5话 死者的幻影","episodeNumber":"5"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/api/v2/comment/"):
			if !strings.HasSuffix(r.URL.Path, "/176170005") {
				t.Errorf("应拉第5集: %s", r.URL.Path)
			}
			_, _ = w.Write([]byte(`{"comments":[{"cid":1,"p":"1.0,1,16777215,a","m":"第五集弹幕"}],"success":true}`))
		default:
			t.Errorf("意外请求: %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	items, _, epID, reason, _ := b.ddpAutoFetch("葬送的芙莉莲", 5, 1)
	if reason != "" {
		t.Fatalf("不应失败: %s", reason)
	}
	if len(items) != 1 || epID != 176170005 {
		t.Fatalf("bangumi 兜底未生效: items=%d epID=%d", len(items), epID)
	}
}

func TestDDPCandidatesPseudoID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"animes":[{"animeId":17617,"animeTitle":"葬送的芙莉莲",
			"episodes":[{"episodeId":176170001,"episodeTitle":"第1话 冒险结束"}]}],"success":true}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	cands := b.ddpCandidates("葬送的芙莉莲", 1, 1)
	if len(cands) == 0 {
		t.Fatal("应有候选")
	}
	id := jsStr(cands[0]["bvid"])
	if !strings.HasPrefix(id, ddpIDPrefix) {
		t.Fatalf("候选 id 应带 %s 前缀: %q", ddpIDPrefix, id)
	}
	// 伪 id 必须能被 pick 端解析（整数、无科学计数法）
	numStr := strings.TrimPrefix(id, ddpIDPrefix)
	if strings.ContainsAny(numStr, "eE.") {
		t.Errorf("伪 id 出现非整数写法: %q", numStr)
	}
	if jsStr(cands[0]["source"]) != ddpSourceLabel {
		t.Errorf("source: %q", cands[0]["source"])
	}
}

// TestDDPCandidatesDisabled 开关关掉时零外网请求。
func TestDDPCandidatesDisabled(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(`{"animes":[]}`))
	}))
	defer srv.Close()
	old := dandanplayBase
	dandanplayBase = srv.URL
	defer func() { dandanplayBase = old }()

	b := newDDPTestBridge(t, "id", "sec")
	b.cfg.SetSetting("dandanplayEnabled", "false")
	if got := b.ddpCandidates("x", 1, 1); got != nil {
		t.Errorf("关掉后不应返回候选: %+v", got)
	}
	if atomic.LoadInt32(&hits) != 0 {
		t.Errorf("关掉后不应发请求，hits=%d", atomic.LoadInt32(&hits))
	}
	if b.ddpEnabled() {
		t.Error("ddpEnabled 应为 false")
	}
}

/* ── 优选源结果的网页端渲染契约 ── */

// TestDDPPreferredSourceOmitsBiliCookieStatus 优选源（弹弹play/自建源）结果不得带 cookieStatus。
//
// 回归保护：cookieStatus 是 B站 登录态。网页原生播放器把它渲染成「登录状态」行 + 未登录时
// 弹红色警告横幅 —— 弹弹play 命中满屏弹幕却被提示「未登录、弹幕数量受限」。
func TestDDPPreferredSourceOmitsBiliCookieStatus(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	items := []map[string]any{{"time": 1.0, "type": 1.0, "color": 16777215.0, "text": "x"}}
	kept := b.biliFilterDanmaku(items)

	rec := httptest.NewRecorder()
	b.danmuServeResult(rec, "某番", 1, 1, false, "dandanplay", ddpSourceLabel, items, kept, "",
		[]danmuSourceDetail{{Key: "dandanplay", Label: ddpSourceLabel, Enabled: true}})
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	meta, _ := out["meta"].(map[string]any)
	if meta == nil {
		t.Fatal("缺少 meta")
	}
	if _, has := meta["cookieStatus"]; has {
		t.Error("优选源 meta 不应带 cookieStatus（会让网页端误报未登录并弹红色警告）")
	}
	if out["source"] != ddpSourceLabel {
		t.Errorf("source 应为 %q: %v", ddpSourceLabel, out["source"])
	}
	if out["ok"] != true {
		t.Errorf("ok 应为 true: %v", out["ok"])
	}
}

/* ── 状态 / 测试端点 ── */

// TestDDPStatusNeverLeaksSecret 状态端点只回 AppId 与布尔，绝不回 Secret 明文。
func TestDDPStatusNeverLeaksSecret(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	b.cfg.SetSetting("dandanplayAppId", "my-app")
	b.cfg.SetSetting("dandanplayAppSecret", "SUPER-SECRET-VALUE")

	rec := httptest.NewRecorder()
	b.ddpStatusHandler()(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	body := rec.Body.String()
	if strings.Contains(body, "SUPER-SECRET-VALUE") {
		t.Fatal("状态端点泄露了 Secret 明文")
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(body), &out)
	if out["credential"] != "custom" {
		t.Errorf("credential: %v", out["credential"])
	}
	if out["appId"] != "my-app" {
		t.Errorf("appId 应可下发: %v", out["appId"])
	}
	if out["configured"] != true || out["enabled"] != true {
		t.Errorf("configured/enabled: %v/%v", out["configured"], out["enabled"])
	}
}

// TestDDPBuiltinStatusWhenNoCustom 未配置自定义时状态显示 builtin。
func TestDDPBuiltinStatusWhenNoCustom(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	rec := httptest.NewRecorder()
	b.ddpStatusHandler()(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["credential"] != "builtin" {
		t.Errorf("应显示内置凭证: %v", out["credential"])
	}
	if out["configured"] != true {
		t.Errorf("内置凭证应视为已配置: %v", out["configured"])
	}
	// 内置凭证有两个 Secret，面板可据此提示「含备用密钥」
	if n, _ := out["secretCount"].(float64); int(n) < 2 {
		t.Errorf("内置 Secret 数应 ≥2: %v", out["secretCount"])
	}
}

// TestDDPStatusDisabled 显式关掉时 enabled=false（面板据此回显开关）。
func TestDDPStatusDisabled(t *testing.T) {
	b := newDDPTestBridge(t, "", "")
	b.cfg.SetSetting("dandanplayEnabled", "false")
	rec := httptest.NewRecorder()
	b.ddpStatusHandler()(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["enabled"] != false {
		t.Errorf("enabled 应为 false: %v", out["enabled"])
	}
}

/* ── 测试夹具 ── */

// resetDDPSecretState 清空「哪个 Secret 可用」与查询缓存的进程级状态（用例间隔离）。
// 缓存是进程级 sync.Map：不清会让上一个用例的假服务器响应串到下一个用例。
func resetDDPSecretState() {
	ddpCredsHook = nil
	ddpSecretState.mu.Lock()
	ddpSecretState.idx = 0
	ddpSecretState.bad = nil
	ddpSecretState.mu.Unlock()
	ddpSearchCache = sync.Map{}
	ddpEpisodesCache = sync.Map{}
}

// stubDDPCreds 注入指定凭证序列（生产恒为 nil 走内置/自定义解析）。
func stubDDPCreds(t *testing.T, appID string, secrets []string) {
	t.Helper()
	ddpCredsHook = func() (string, []string, bool) { return appID, secrets, true }
	t.Cleanup(func() { ddpCredsHook = nil })
}

// newDDPTestBridge 构造临时目录配置的 bridge（不走 secret 盐文件，用内置域密钥兜底）。
func newDDPTestBridge(t *testing.T, appID, appSecret string) *Bridge {
	t.Helper()
	cfg := config.Default()
	if appID != "" {
		_ = cfg.SetSetting("dandanplayAppId", appID)
	}
	if appSecret != "" {
		_ = cfg.SetSetting("dandanplayAppSecret", appSecret)
	}
	b := New(cfg, "http://127.0.0.1:5666")
	resetDDPSecretState()
	t.Cleanup(resetDDPSecretState)
	return b
}
