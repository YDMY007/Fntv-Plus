// Package bridge —— omdb.go：OMDb API 客户端（扩展数据源 ③）。
// 官方文档（www.omdbapi.com，2026-09 核实）：GET https://www.omdbapi.com/?apikey={key}&i={imdbID}
//
//	免费档 1000 次/天（邮箱领 key），$1/月 Patreon 解除；非商业许可（CC BY-NC 4.0）。
//	响应 {"Response":"True","imdbRating":"7.6","imdbVotes":"12,345",...}（imdbVotes 带千分位逗号）。
//
// 用途：TMDB 详情卡（tmdb:show）与观影记录 enrich 补 IMDb 评分列——IMDb 自身无官方公开 API，
// OMDb 是事实上的间接官方渠道。评分变化慢 → 进程内缓存 7 天，省免费额度。
package bridge

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// omdbBase var 而非 const：单测用 httptest 覆盖指向本地假服务器。
var omdbBase = "https://www.omdbapi.com"

func (b *Bridge) omdbOn() bool       { return getSetting(b.cfg, "omdbEnabled") == "1" }
func (b *Bridge) omdbAPIKey() string { return strings.TrimSpace(getSetting(b.cfg, "omdbApiKey")) }

var (
	omdbMu    sync.Mutex
	omdbCache = map[string]omdbCacheEntry{} // imdbID → 7d
)

type omdbCacheEntry struct {
	rating float64
	votes  int64
	exp    time.Time
}

// omdbEnrich 查 IMDb 评分/票数（未开启/未配 key/失败一律返回 0,0 静默降级）。
// 与豆瓣 fetchDoubanRating 同语义：尽力而为，绝不影响主数据。
func (b *Bridge) omdbEnrich(imdbID string) (float64, int64) {
	id := strings.TrimSpace(imdbID)
	if id == "" || !b.omdbOn() {
		return 0, 0
	}
	key := b.omdbAPIKey()
	if key == "" {
		return 0, 0
	}
	omdbMu.Lock()
	if e, ok := omdbCache[strings.ToLower(id)]; ok && time.Now().Before(e.exp) {
		omdbMu.Unlock()
		return e.rating, e.votes
	}
	omdbMu.Unlock()

	u := omdbBase + "/?" + url.Values{"apikey": {key}, "i": {id}}.Encode()
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", skipUA)
	resp, err := b.extHTTP().Do(req) // 复用「自定义代理 > 系统直连」客户端
	if err != nil {
		return 0, 0
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	_ = resp.Body.Close()
	var out struct {
		Response   string `json:"Response"`
		Error      string `json:"Error"`
		ImdbRating string `json:"imdbRating"`
		ImdbVotes  string `json:"imdbVotes"`
	}
	if json.Unmarshal(data, &out) != nil || out.Response != "True" {
		return 0, 0
	}
	rating, _ := strconv.ParseFloat(strings.TrimSpace(out.ImdbRating), 64)
	votes, _ := strconv.ParseInt(strings.ReplaceAll(strings.TrimSpace(out.ImdbVotes), ",", ""), 10, 64)
	if rating <= 0 {
		return 0, 0
	}
	omdbMu.Lock()
	omdbCache[strings.ToLower(id)] = omdbCacheEntry{rating: rating, votes: votes, exp: time.Now().Add(7 * 24 * time.Hour)}
	omdbMu.Unlock()
	return rating, votes
}

// omdbRatingHandler POST {imdbId} → {ok, imdbRating, imdbVotes}（管理页/前端直查用）。
func (b *Bridge) omdbRatingHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ImdbID string `json:"imdbId"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req)
	if !b.omdbOn() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "OMDb 未开启"})
		return
	}
	if b.omdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 OMDb API Key（omdbapi.com/apikey.aspx 免费领取）"})
		return
	}
	rating, votes := b.omdbEnrich(req.ImdbID)
	if rating <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "查询失败或无评分（检查 key/额度/IMDb id）"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "imdbRating": rating, "imdbVotes": votes})
}
