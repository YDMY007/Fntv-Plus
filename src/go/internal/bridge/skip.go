// Package bridge —— skip.go：跳过片头/片尾外部数据链（网页端 skip:fetch-and-fill 的外网部分）。
// 移植桌面版 smartSkip.ts + skipMalMap.ts：
//   Step A  AniSkip（动漫社区库，区间绝对秒；需 MAL id → 标题映射链：
//           Bangumi v0 中文搜索取日文名 → MAL 官方 v2（配了 Client ID 时首选，扩展数据源 ④）→
//           Jikan / AniList 双路互备；映射缓存 30 天；
//           episodeLength 敏感，±1/±2 阶梯重试；含 recap 前情回顾透传）
//   Step B  theintrodb v3 兜底（非动画剧集；tmdb_id/imdb_id 查询 + duration_ms 匹配）
// fnOS 语义换算：skipStart = OP 结束秒 / intro.end 秒；skipEnd = 总时长 − ED 开始秒 / credits.start 秒
// （outro ≥ 总时长一半视为异常仅填片头）。fnOS skipinfo 的读/写由前端直连完成（httpOnly 断链绕开）。
package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const skipUA = "fntv-plus/web (https://github.com/YDMY007/Fntv-Plus)"
const skipHTTPTimeout = 12 * time.Second

/* ── MAL 映射缓存（30 天，进程内存；桌面为磁盘 30 天，后端常驻等效）── */

var malMapCache sync.Map // key → malEntry

type malEntry struct {
	malID int64
	exp   time.Time
}

func malCacheGet(key string) int64 {
	if v, ok := malMapCache.Load(key); ok {
		e := v.(malEntry)
		if time.Now().Before(e.exp) {
			return e.malID
		}
		malMapCache.Delete(key)
	}
	return 0
}

func malCacheSet(key string, malID int64) {
	malMapCache.Store(key, malEntry{malID: malID, exp: time.Now().Add(30 * 24 * time.Hour)})
}

// extGetJSON 通用外网 GET/POST JSON。
func extGetJSON(method, rawURL string, body any, headers map[string]string) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		bd, _ := json.Marshal(body)
		reader = strings.NewReader(string(bd))
	}
	req, err := http.NewRequest(method, rawURL, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", skipUA)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: skipHTTPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
	return out, nil
}

/* ── 标题 → MAL id 映射链 ── */

func bangumiNativeTitle(title string) string {
	out, err := extGetJSON(http.MethodPost, "https://api.bgm.tv/v0/search/subjects?limit=3",
		map[string]any{"keyword": title, "filter": map[string]any{"type": []int{2}}},
		map[string]string{"Content-Type": "application/json"})
	if err != nil || out == nil {
		return ""
	}
	if data, _ := out["data"].([]any); len(data) > 0 {
		if m, _ := data[0].(map[string]any); m != nil {
			return jsStr(m["name"])
		}
	}
	return ""
}

func jikanMalID(name string) int64 {
	out, err := extGetJSON(http.MethodGet, "https://api.jikan.moe/v4/anime?q="+url.QueryEscape(name)+"&limit=1", nil,
		map[string]string{})
	if err != nil || out == nil {
		return 0
	}
	if data, _ := out["data"].([]any); len(data) > 0 {
		if m, _ := data[0].(map[string]any); m != nil {
			return int64(jsNum(m["mal_id"]))
		}
	}
	return 0
}

// malOfficialID MAL 官方 API v2（扩展数据源 ④：api.myanimelist.net/v2，注册应用得 Client ID，
// 请求带 X-MAL-CLIENT-ID 头读公开数据——官方文档 myanimelist.net/apiconfig/references/api/v2）。
// 非官方 Jikan 的替代首选：配置了 malClientId 才参与映射链，未配置/失败不影响 Jikan/AniList 兜底。
// malAPIBase var 而非 const：单测用 httptest 覆盖指向本地假服务器。
var malAPIBase = "https://api.myanimelist.net"

func (b *Bridge) malOfficialID(name string) int64 {
	clientID := strings.TrimSpace(getSetting(b.cfg, "malClientId"))
	if clientID == "" {
		return 0
	}
	out, err := extGetJSON(http.MethodGet,
		malAPIBase+"/v2/anime?q="+url.QueryEscape(name)+"&limit=1&fields=id",
		nil, map[string]string{"X-MAL-CLIENT-ID": clientID})
	if err != nil || out == nil {
		return 0
	}
	if data, _ := out["data"].([]any); len(data) > 0 {
		if m, _ := data[0].(map[string]any); m != nil {
			if node, _ := m["node"].(map[string]any); node != nil {
				return int64(jsNum(node["id"]))
			}
		}
	}
	return 0
}

func anilistMalID(name string) int64 {
	out, err := extGetJSON(http.MethodPost, "https://graphql.anilist.co",
		map[string]any{"query": "query($s:String){Media(search:$s,type:ANIME){id idMal}}", "variables": map[string]string{"s": name}},
		map[string]string{"Content-Type": "application/json", "Accept": "application/json"})
	if err != nil || out == nil {
		return 0
	}
	if data, _ := out["data"].(map[string]any); data != nil {
		if media, _ := data["Media"].(map[string]any); media != nil {
			return int64(jsNum(media["idMal"]))
		}
	}
	return 0
}

// skipResolveMalID 标题 → MAL id：Bangumi(中文→日文名) → Jikan/AniList 双路互备；30 天缓存。
func (b *Bridge) skipResolveMalID(tmdbKey, title string) int64 {
	key := "skip_malmap_v1_"
	if regexp.MustCompile(`^\d+$`).MatchString(tmdbKey) {
		key += tmdbKey
	} else {
		key += "t_" + tmdbKey
	}
	if id := malCacheGet(key); id > 0 {
		return id
	}
	candidates := []string{}
	if n := bangumiNativeTitle(title); n != "" {
		candidates = append(candidates, n)
	}
	candidates = append(candidates, title)
	for _, name := range candidates {
		// MAL 官方 v2 首选（配了 Client ID 才生效），Jikan/AniList 非官方双路互备兜底
		if id := b.malOfficialID(name); id > 0 {
			malCacheSet(key, id)
			return id
		}
		if id := jikanMalID(name); id > 0 {
			malCacheSet(key, id)
			return id
		}
		if id := anilistMalID(name); id > 0 {
			malCacheSet(key, id)
			return id
		}
	}
	return 0
}

/* ── AniSkip 查询 ── */

type skipSeg struct {
	opStart, opEnd, edStart, edEnd, recapStart, recapEnd float64
}

// skipAniskipFetch episodeLength 敏感（差 1 秒都可能不命中），按 ±1/±2 阶梯重试。
func skipAniskipFetch(malID int64, episode int64, durationSec float64) *skipSeg {
	ladder := []float64{0}
	if durationSec > 0 {
		ladder = []float64{durationSec, durationSec + 1, durationSec - 1, durationSec + 2}
	}
	client := &http.Client{Timeout: skipHTTPTimeout}
	for _, ladderLen := range ladder {
		u := fmt.Sprintf("https://api.aniskip.com/v2/skip-times/%d/%d?types%%5B%%5D=op&types%%5B%%5D=ed&types%%5B%%5D=recap&episodeLength=%d",
			malID, episode, int64(ladderLen+0.5))
		req, _ := http.NewRequest(http.MethodGet, u, nil)
		req.Header.Set("appId", "fntv-plus")
		req.Header.Set("User-Agent", skipUA)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		var out struct {
			Found   bool `json:"found"`
			Results []struct {
				SkipType string `json:"skipType"`
				Interval struct {
					StartTime float64 `json:"startTime"`
					EndTime   float64 `json:"endTime"`
				} `json:"interval"`
			} `json:"results"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&out)
		resp.Body.Close()
		if out.Found != true || len(out.Results) == 0 {
			continue
		}
		seg := &skipSeg{}
		for _, x := range out.Results {
			switch x.SkipType {
			case "op":
				seg.opStart, seg.opEnd = x.Interval.StartTime, x.Interval.EndTime
			case "ed":
				seg.edStart, seg.edEnd = x.Interval.StartTime, x.Interval.EndTime
			case "recap":
				seg.recapStart, seg.recapEnd = x.Interval.StartTime, x.Interval.EndTime
			}
		}
		if seg.opEnd == 0 && seg.edEnd == 0 && seg.recapEnd == 0 {
			return nil
		}
		return seg
	}
	return nil
}

/* ── theintrodb v3 兜底 ── */

// skipIntroDbQueries trim_id → 查询参数候选（tmdb_id 优先，tt 前缀剥离 + imdb 兜底）。
func skipIntroDbQueries(raw string) []string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	if regexp.MustCompile(`^\d+$`).MatchString(s) {
		return []string{"tmdb_id=" + s}
	}
	if m := regexp.MustCompile(`(?i)^tt(\d+)$`).FindStringSubmatch(s); len(m) > 1 {
		return []string{"tmdb_id=" + m[1], "imdb_id=" + s}
	}
	return nil
}

// skipTheIntroDb theintrodb v3 /media：intro[0].end_ms → skipStart；credits[0].start_ms + 总时长 → skipEnd。
func skipTheIntroDb(trimID string, season, episode int64, durationSec float64) (skipStart, skipEnd float64) {
	for _, q := range skipIntroDbQueries(trimID) {
		u := "https://api.theintrodb.org/v3/media?" + q
		if season > 0 {
			u += "&season=" + strconv.FormatInt(season, 10)
			if episode > 0 {
				u += "&episode=" + strconv.FormatInt(episode, 10)
			}
		}
		if durationSec > 0 {
			u += "&duration_ms=" + strconv.FormatInt(int64(durationSec*1000), 10)
		}
		client := &http.Client{Timeout: skipHTTPTimeout}
		req, _ := http.NewRequest(http.MethodGet, u, nil)
		req.Header.Set("User-Agent", skipUA)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		var out struct {
			Error   string `json:"error"`
			Intro   []struct {
				EndMs float64 `json:"end_ms"`
			} `json:"intro"`
			Credits []struct {
				StartMs float64 `json:"start_ms"`
			} `json:"credits"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&out)
		resp.Body.Close()
		if out.Error != "" {
			continue
		}
		if len(out.Intro) > 0 && out.Intro[0].EndMs > 0 {
			skipStart = out.Intro[0].EndMs / 1000
		}
		if len(out.Credits) > 0 && out.Credits[0].StartMs > 0 {
			if durationSec > 0 {
				outro := durationSec - out.Credits[0].StartMs/1000
				if outro > 0 && outro < durationSec/2 {
					skipEnd = outro
				}
			}
		}
		if skipStart > 0 || skipEnd > 0 {
			return skipStart, skipEnd
		}
	}
	return 0, 0
}

/* ── Handler：skip/external（外网三级链；fnOS skipinfo 读写由前端直连）── */

// skipExternal POST {trimId, season, episode, duration, title} →
// {ok, skipStart, skipEnd, source:'aniskip'|'theintrodb'|'none', recapStart, recapEnd}
func (b *Bridge) skipExternal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TrimID    string  `json:"trimId"`
		Season    int64   `json:"season"`
		Episode   int64   `json:"episode"`
		Duration  float64 `json:"duration"`
		Title     string  `json:"title"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	empty := map[string]any{"ok": false, "skipStart": 0, "skipEnd": 0, "source": "none", "recapStart": 0, "recapEnd": 0}

	skipStart, skipEnd, recapStart, recapEnd := 0.0, 0.0, 0.0, 0.0
	source := "none"

	// Step A：AniSkip（动漫；需 MAL id）
	if req.Episode > 0 {
		trimKey := strings.TrimSpace(req.TrimID)
		showTitle := strings.TrimSpace(strings.ReplaceAll(req.Title, "^第\\s*\\d+\\s*[集话話期]\\s*", ""))
		if trimKey != "" && showTitle != "" {
			if malID := b.skipResolveMalID(trimKey, showTitle); malID > 0 {
				if seg := skipAniskipFetch(malID, req.Episode, req.Duration); seg != nil {
					if seg.recapStart > 0 && seg.recapEnd > seg.recapStart && (req.Duration <= 0 || seg.recapEnd < req.Duration) {
						recapStart, recapEnd = seg.recapStart, seg.recapEnd
					}
					if seg.opEnd > 0 && seg.opEnd < req.Duration {
						skipStart = seg.opEnd
					}
					if seg.edStart > 0 && req.Duration > 0 {
						outro := req.Duration - seg.edStart
						if outro > 0 && outro < req.Duration/2 {
							skipEnd = outro
						}
					}
					if skipStart > 0 || skipEnd > 0 {
						source = "aniskip"
					}
				}
			}
		}
	}

	// Step B：theintrodb 兜底
	if source == "none" {
		s, e := skipTheIntroDb(strings.TrimSpace(req.TrimID), req.Season, req.Episode, req.Duration)
		if s > 0 || e > 0 {
			skipStart, skipEnd = s, e
			source = "theintrodb"
		}
	}

	if source == "none" {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "skipStart": int64(skipStart), "skipEnd": int64(skipEnd),
		"source": source, "recapStart": int64(recapStart), "recapEnd": int64(recapEnd),
	})
}
