// Package bridge —— fanart.go：Fanart.tv 官方 API v3 客户端（扩展数据源 ①）。
// 官方文档（webservice.fanart.tv，2026-09 核实）：
//
//	GET https://webservice.fanart.tv/v3/movies/{tmdb_id 或 imdb_id}?api_key={项目key}[&client_key={个人key}]
//	GET https://webservice.fanart.tv/v3/tv/{tvdb_id}?...
//	- 电影分类接受 TMDB 数字 ID / IMDb tt ID；**剧集分类只认 TVDB ID**（无 TMDB 直查）→
//	  前端只有 tmdbId 时由本端经 TMDB /tv/{id}/external_ids 换算 tvdb_id（tmdbshow 同链）。
//	- 响应按艺术类型分键，条目 {id,url,lang,likes}（v3.1 起加 added，v3.2 加宽高）：
//	  电影 logo = hdmovielogo + movielogo；剧集 logo = hdtvlogo + clearlogo。
//	- 项目 key 免费（fanart.tv 注册应用），个人 client_key 可选（新图延迟 7 天→2 天）。
//
// 图片本体在 assets.fanart.tv CDN，前端经 /bridge/tmdb/img 通用图片代理下载（bridge.go 放行该域）。
package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// fanartBase var 而非 const：单测用 httptest 覆盖指向本地假服务器。
var fanartBase = "https://webservice.fanart.tv"

// fanartOn 「Fanart.tv 高清 Logo 兜底」开关（面板布尔存 "1"/"0"）。
func (b *Bridge) fanartOn() bool {
	return getSetting(b.cfg, "fanartEnabled") == "1"
}

func (b *Bridge) fanartAPIKey() string { return strings.TrimSpace(getSetting(b.cfg, "fanartApiKey")) }
func (b *Bridge) fanartClientKey() string {
	return strings.TrimSpace(getSetting(b.cfg, "fanartClientKey"))
}

// fanartLogo 条目归一化（url 直出 CDN 全链，lang 可空）。
type fanartLogo struct {
	URL   string `json:"url"`
	Lang  string `json:"lang"`
	Likes int64  `json:"likes"`
	HD    bool   `json:"hd"`
}

// fanartCache 磁盘外进程内缓存（key → 响应）；Fanart 内容更新慢，6h 足够新鲜且省额度。
var (
	fanartCacheMu sync.Mutex
	fanartCache   = map[string]fanartCacheEntry{}
)

type fanartCacheEntry struct {
	logos []fanartLogo
	exp   time.Time
}

// extHTTP 扩展数据源通用外网客户端：自定义代理 > 系统直连。
// （Fanart/OMDb/Jav 等新渠道共用；TMDB 直连客户端不适用——SNI 绑定 tmdb 域名。）
func (b *Bridge) extHTTP() *http.Client {
	if proxy := b.customProxyURL(); proxy != "" {
		if pu, err := url.Parse(proxy); err == nil && pu.Scheme != "" {
			return &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}
		}
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// fanartResolveTvdb 剧集：tmdbId → tvdb_id（经 TMDB external_ids）。无 TMDB Key 或查询失败返回 ""。
func (b *Bridge) fanartResolveTvdb(tmdbID int64) string {
	if tmdbID <= 0 || b.tmdbAPIKey() == "" {
		return ""
	}
	_, out, err := b.tmdbGet("/tv/"+fmt.Sprintf("%d", tmdbID)+"/external_ids", nil)
	if err != nil || out == nil {
		return ""
	}
	tvdb := strings.TrimSpace(jStr(out, "tvdb_id"))
	if tvdb == "" { // 数字型 JSON 响应兜底
		if n := jNum(out, "tvdb_id"); n > 0 {
			tvdb = fmt.Sprintf("%d", int64(n))
		}
	}
	return tvdb
}

// fanartParseLogos 从 v3 响应抠 logo 两键（电影/剧键名不同），HD 键排前、likes 降序。
func fanartParseLogos(resp map[string]any, keys ...string) []fanartLogo {
	out := []fanartLogo{}
	for _, k := range keys {
		arr, _ := resp[k].([]any)
		for _, raw := range arr {
			m, _ := raw.(map[string]any)
			if m == nil {
				continue
			}
			u := strings.TrimSpace(jsStr(m["url"]))
			if u == "" {
				continue
			}
			out = append(out, fanartLogo{
				URL:   u,
				Lang:  jsStr(m["lang"]),
				Likes: toInt64(m["likes"]),
				HD:    strings.HasPrefix(k, "hd"),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].HD != out[j].HD {
			return out[i].HD
		}
		return out[i].Likes > out[j].Likes
	})
	return out
}

// fanartLogosHandler POST {mediaType, tmdbId, imdbId, tvdbId} →
// {ok, logos:[{url,lang,likes,hd}], resolvedTvdb, error}
// 未开启/未配 key 返回 ok:false + 原因（前端静默跳过，不弹错）。
func (b *Bridge) fanartLogosHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MediaType string `json:"mediaType"`
		TmdbID    int64  `json:"tmdbId"`
		ImdbID    string `json:"imdbId"`
		TvdbID    string `json:"tvdbId"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if !b.fanartOn() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Fanart.tv 未开启"})
		return
	}
	apiKey := b.fanartAPIKey()
	if apiKey == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 Fanart.tv api_key（fanart.tv 注册免费领取）"})
		return
	}
	mt := strings.ToLower(req.MediaType)
	if mt != "movie" && mt != "tv" {
		mt = "tv"
	}

	// 定位 fanart 主键：电影 tmdb/imdb 直查；剧必须 tvdb（缺则经 TMDB 换算）
	fanartID := ""
	section := ""
	switch mt {
	case "movie":
		if req.TmdbID > 0 {
			fanartID = fmt.Sprintf("%d", req.TmdbID)
		} else if s := strings.TrimSpace(req.ImdbID); s != "" {
			fanartID = s
		}
		section = "movies"
	default:
		if s := strings.TrimSpace(req.TvdbID); s != "" {
			fanartID = s
		} else if req.TmdbID > 0 {
			fanartID = b.fanartResolveTvdb(req.TmdbID)
		}
		section = "tv"
	}
	if fanartID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少可用的 Fanart.tv 主键（剧集需 TVDB id，或已配置 TMDB Key 供换算）"})
		return
	}

	cacheKey := section + "|" + fanartID
	fanartCacheMu.Lock()
	if e, ok := fanartCache[cacheKey]; ok && time.Now().Before(e.exp) {
		logos := e.logos
		fanartCacheMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": len(logos) > 0, "logos": logos, "resolvedTvdb": fanartID, "fromCache": true})
		return
	}
	fanartCacheMu.Unlock()

	q := url.Values{}
	q.Set("api_key", apiKey)
	if ck := b.fanartClientKey(); ck != "" {
		q.Set("client_key", ck)
	}
	u := fanartBase + "/v3/" + section + "/" + url.PathEscape(fanartID) + "?" + q.Encode()
	req2, _ := http.NewRequest(http.MethodGet, u, nil)
	req2.Header.Set("Accept", "application/json")
	req2.Header.Set("User-Agent", skipUA)
	resp, err := b.extHTTP().Do(req2)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	_ = resp.Body.Close()
	var out map[string]any
	if json.Unmarshal(data, &out) != nil || out == nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": fmt.Sprintf("Fanart.tv 响应解析失败（HTTP %d）", resp.StatusCode)})
		return
	}
	// 官方错误形态：{"status":"error","error message":"..."} / 401 {"error":"..."}
	if st := jsStr(out["status"]); st == "error" {
		msg := jsStr(out["error message"])
		if msg == "" {
			msg = jsStr(out["error"])
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Fanart.tv: " + msg})
		return
	}
	if resp.StatusCode != http.StatusOK {
		msg := jsStr(out["error message"])
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Fanart.tv: " + msg})
		return
	}
	keys := []string{"hdtvlogo", "clearlogo"}
	if mt == "movie" {
		keys = []string{"hdmovielogo", "movielogo"}
	}
	logos := fanartParseLogos(out, keys...)
	fanartCacheMu.Lock()
	fanartCache[cacheKey] = fanartCacheEntry{logos: logos, exp: time.Now().Add(6 * time.Hour)}
	fanartCacheMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": len(logos) > 0, "logos": logos, "resolvedTvdb": fanartID})
}
