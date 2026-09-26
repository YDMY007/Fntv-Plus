// Package bridge —— tvmaze.go：TVMaze 官方 REST API 客户端（扩展数据源 ②）。
// 官方文档（api.tvmaze.com，2026-09 核实）：完全免费、无需 key、CC BY-SA（需署名），
// 限速 20 次/10 秒/IP，官方建议客户端缓存（本端进程内 24h）。
//
//	GET https://api.tvmaze.com/lookup/shows?imdb={ttID} | ?thetvdb={tvdbID} → show 对象直出
//	GET https://api.tvmaze.com/search/shows?q={title}       → [{score, show}]（模糊搜索兜底）
//	GET https://api.tvmaze.com/shows/{id}/episodes?specials=1 → 分集数组
//
// 分集字段：{name, season, number, airdate, runtime, summary(HTML)} —— summary 剥 HTML 后透出。
// 用途：「补全集信息」在 TMDB 缺英文（或整集缺失）时的英文标题/简介兜底（epBackfill）。
package bridge

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// tvmazeBase var 而非 const：单测用 httptest 覆盖指向本地假服务器。
var tvmazeBase = "https://api.tvmaze.com"

var reTVSeasonSuffix = regexp.MustCompile(`(?i)\s*(第\s*[0-9一二三四五六七八九十百]+\s*季|season\s*\d{1,3}|s\s*\d{1,3})\s*$`)

func (b *Bridge) tvmazeOn() bool { return getSetting(b.cfg, "tvmazeEnabled") == "1" }

// tvmazeShow 归一化剧集（仅取用到的字段）。
type tvmazeShow struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Tvdb string `json:"tvdb"`
	Imdb string `json:"imdb"`
}

// tvmazeEp 归一化分集（summary 已剥 HTML）。
type tvmazeEp struct {
	Season  int64  `json:"season"`
	Number  int64  `json:"number"`
	Name    string `json:"name"`
	Airdate string `json:"airdate"`
	Runtime int64  `json:"runtime"`
	Summary string `json:"summary"`
}

var (
	tvmazeMu      sync.Mutex
	tvmazeEpCache = map[string]tvmazeCacheEntry{} // key: showID → 24h
)

type tvmazeCacheEntry struct {
	showID   int64
	showName string
	episodes []tvmazeEp
	exp      time.Time
}

// tvmazeHTTP 自定义代理 > 系统直连。
func (b *Bridge) tvmazeHTTP() *http.Client {
	if proxy := b.customProxyURL(); proxy != "" {
		if pu, err := url.Parse(proxy); err == nil && pu.Scheme != "" {
			return &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}
		}
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// tvmazeGetJSON GET 并解析 JSON（非 200 返回错误）。
func (b *Bridge) tvmazeGetJSON(path string, out any) error {
	req, _ := http.NewRequest(http.MethodGet, tvmazeBase+path, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", skipUA)
	resp, err := b.tvmazeHTTP().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("TVMaze HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(data, out)
}

// stripHTMLTag 剥summary 里的 <p>/<br> 等 HTML 标签并还原实体。
func stripHTMLTag(s string) string {
	if s == "" {
		return ""
	}
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

// tvmazeLookupShow imdb/tvdb/title 三路定位 show（标题搜索剥季号后缀，取首个命中）。
func (b *Bridge) tvmazeLookupShow(imdbID, tvdbID, title string) (*tvmazeShow, error) {
	if s := strings.TrimSpace(imdbID); s != "" {
		var sh tvmazeShow
		if err := b.tvmazeGetJSON("/lookup/shows?imdb="+url.QueryEscape(s), &sh); err == nil && sh.ID > 0 {
			return &sh, nil
		}
	}
	if s := strings.TrimSpace(tvdbID); s != "" {
		var sh tvmazeShow
		if err := b.tvmazeGetJSON("/lookup/shows?thetvdb="+url.QueryEscape(s), &sh); err == nil && sh.ID > 0 {
			return &sh, nil
		}
	}
	q := strings.TrimSpace(title)
	if q == "" {
		return nil, fmt.Errorf("缺少 imdb/tvdb/标题")
	}
	q = reTVSeasonSuffix.ReplaceAllString(q, "")
	var hits []struct {
		Score float64    `json:"score"`
		Show  tvmazeShow `json:"show"`
	}
	if err := b.tvmazeGetJSON("/search/shows?q="+url.QueryEscape(q), &hits); err != nil {
		return nil, err
	}
	if len(hits) == 0 || hits[0].Show.ID <= 0 {
		return nil, fmt.Errorf("TVMaze 搜索无结果: %s", q)
	}
	sh := hits[0].Show
	return &sh, nil
}

// tvmazeShowHandler POST {imdbId, tvdbId, title, season} →
// {ok, show:{id,name,tvdb,imdb}, episodes:[{season,number,name,airdate,runtime,summary}]}
func (b *Bridge) tvmazeShowHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ImdbID string  `json:"imdbId"`
		TvdbID string  `json:"tvdbId"`
		Title  string  `json:"title"`
		Season float64 `json:"season"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if !b.tvmazeOn() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "TVMaze 未开启"})
		return
	}
	titleKey := strings.TrimSpace(req.Title)
	if n := reTVSeasonSuffix.ReplaceAllString(titleKey, ""); n != "" {
		titleKey = n
	}
	cacheKey := strings.ToLower(titleKey) + "|" + strings.TrimSpace(req.ImdbID) + "|" + strings.TrimSpace(req.TvdbID)
	tvmazeMu.Lock()
	if e, ok := tvmazeEpCache[cacheKey]; ok && time.Now().Before(e.exp) {
		tvmazeMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "fetchedAt": time.Now().UnixMilli(),
			"show": tvmazeShow{ID: e.showID, Name: e.showName}, "episodes": e.episodes,
		})
		return
	}
	tvmazeMu.Unlock()

	sh, err := b.tvmazeLookupShow(req.ImdbID, req.TvdbID, req.Title)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var rawEps []struct {
		Name    string `json:"name"`
		Season  int64  `json:"season"`
		Number  int64  `json:"number"`
		Airdate string `json:"airdate"`
		Runtime int64  `json:"runtime"`
		Summary string `json:"summary"`
	}
	if err := b.tvmazeGetJSON(fmt.Sprintf("/shows/%d/episodes?specials=1", sh.ID), &rawEps); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	eps := make([]tvmazeEp, 0, len(rawEps))
	for _, e := range rawEps {
		eps = append(eps, tvmazeEp{
			Season: e.Season, Number: e.Number, Name: e.Name,
			Airdate: e.Airdate, Runtime: e.Runtime, Summary: stripHTMLTag(e.Summary),
		})
	}
	tvmazeMu.Lock()
	tvmazeEpCache[cacheKey] = tvmazeCacheEntry{showID: sh.ID, showName: sh.Name, episodes: eps, exp: time.Now().Add(24 * time.Hour)}
	tvmazeMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "fetchedAt": time.Now().UnixMilli(),
		"show": sh, "episodes": eps,
	})
}
