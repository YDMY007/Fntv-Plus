package bridge

// danmaku_clear_test.go — [lc-1307] 「清除弹幕」后端单测（vm 思路：真造缓存文件、真调端点）。
// 双向验证：匹配 title 的缓存必须被删；不同 title 的必须保留；缺 title 必须 400 语义拒绝。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fntvplus/internal/config"
)

// writeCacheFile 在 bridge 的 danmaku-cache 目录造一个真实缓存文件（与 danmuServeResult 落盘同构）。
func writeCacheFile(t *testing.T, b *Bridge, searchTitle, matchedTitle string, season, ep int64) string {
	t.Helper()
	base := b.cfg.Dir()
	if base == "" {
		t.Fatal("cfg.Dir() 为空，无法落缓存")
	}
	dir := filepath.Join(base, "danmaku-cache")
	_ = os.MkdirAll(dir, 0o755)
	meta := map[string]any{
		"searchTitle": searchTitle, "matchedTitle": matchedTitle,
		"ep": ep, "season": season, "count": 3, "source": "B站",
	}
	data, _ := json.Marshal(map[string]any{"items": []map[string]any{{"time": 1.0, "text": "x"}}, "meta": meta})
	path := filepath.Join(dir, "dm_test_"+searchTitle+"_"+string(rune('a'+ep))+"_s"+string(rune('0'+season))+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func callClear(b *Bridge, title string) map[string]any {
	body := `{}`
	if title != "" {
		bb, _ := json.Marshal(map[string]any{"title": title})
		body = string(bb)
	}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	req.Header.Set("X-Trim-Userid", "1000")
	rec := httptest.NewRecorder()
	b.danmakuClear(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

// TestDanmakuClearDeletesMatchingTitlesOnly 命中剧的全部缓存删除，别剧的保留。
func TestDanmakuClearDeletesMatchingTitlesOnly(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	b := New(cfg, "http://127.0.0.1:5666")

	// 同一剧三集（searchTitle 命中）+ 手动 pick 后 matchedTitle 命中但 searchTitle 不同的 1 条
	// + 另一部剧 1 条（必须保留）。
	p1 := writeCacheFile(t, b, "某番", "某番", 1, 1)
	p2 := writeCacheFile(t, b, "某番", "某番", 1, 2)
	p3 := writeCacheFile(t, b, "某番", "某番 第二季", 2, 1)          // 手动选定后规范名不同 → matchedTitle 也要命中
	pKeep := writeCacheFile(t, b, "别的剧", "别的剧", 1, 1)

	out := callClear(b, "某番")
	if out["ok"] != true {
		t.Fatalf("clear 应成功: %v", out)
	}
	files, _ := out["files"].(float64)
	// p1/p2/p3 都该删（p3 靠 matchedTitle 命中）
	if int(files) != 3 {
		t.Errorf("files = %v, want 3", out["files"])
	}
	for _, p := range []string{p1, p2, p3} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("缓存应已删除: %s", filepath.Base(p))
		}
	}
	if _, err := os.Stat(pKeep); err != nil {
		t.Errorf("别剧的缓存不该被删: %s", filepath.Base(pKeep))
	}
}

// TestDanmakuClearRequiresTitle 缺 title 必须拒绝（防御空匹配删光整个缓存目录）。
func TestDanmakuClearRequiresTitle(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	b := New(cfg, "http://127.0.0.1:5666")
	keep := writeCacheFile(t, b, "某番", "某番", 1, 1)

	out := callClear(b, "")
	if out["ok"] != false {
		t.Fatalf("缺 title 应失败: %v", out)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("拒绝时不得删任何缓存")
	}
}
