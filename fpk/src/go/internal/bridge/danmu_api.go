// Package bridge —— danmu_api.go：自建弹幕接口（danmu_api）客户端。
// [lc-1118] 完整复刻桌面版 common/danmuApi.ts：
//   三端点：/api/v2/search/anime?keyword=（条目搜索，只收「主名精确相等 + 季号一致」）
//          /api/v2/bangumi/{animeId}（分集列表）
//          /api/v2/comment/{episodeId}?format=xml（弹幕 XML，与 list.so 同构共用解析器）
//   候选 bvid 位为伪 id `dmapi:<episodeId>`；用户手选后按 id 直拉。自建源不做模糊匹配
//   （多平台条目极密，模糊必挂错，桌面 lc-1109 实机教训）。
package bridge

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const danmuSourceLabel = "自建源(danmu_api)"
const danmuIDPrefix = "dmapi:"

func (b *Bridge) danmuBase() string      { return strings.TrimSpace(getSetting(b.cfg, "danmuApiBase")) }
func (b *Bridge) danmuIsActive() bool    { return b.danmuBase() != "" }

var (
	reDanmuBracket  = regexp.MustCompile(`【[^】]*】`)
	reDanmuYear     = regexp.MustCompile(`[\[(（](?:19|20)\d{2}[\])）]`)
	reDanmuFromTail = regexp.MustCompile(`(?i)\s*from\s+[a-z0-9]+\s*$`)
	reDanmuPunct    = regexp.MustCompile(`[『』「」〔〕《》〈〉“”‘’（）()·:：!！?？,，.。、\-_—~～△▲★☆♥・\s]`)
	reSeasonMark    = regexp.MustCompile(`(?i)第\s*(0*[0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[季部]|season\s*0*([0-9]{1,2})|\bs\s*0*([0-9]{1,2})\b`)
	reEpFromTitle   = regexp.MustCompile(`第\s*([0-9]{1,4})\s*[话集期]`)
)

var danmuCNNum = map[string]int{"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

func danmuNormalizeTitle(s string) string {
	s = reDanmuBracket.ReplaceAllString(s, "")
	s = reDanmuYear.ReplaceAllString(s, "")
	s = reDanmuFromTail.ReplaceAllString(s, "")
	s = reDanmuPunct.ReplaceAllString(s, "")
	return strings.ToLower(s)
}

func danmuSeasonToInt(s string) int {
	t := strings.TrimSpace(s)
	if regexp.MustCompile(`^[0-9]+$`).MatchString(t) {
		n, _ := strconv.Atoi(t)
		return n
	}
	r := []rune(t)
	if len(r) == 1 {
		return danmuCNNum[t]
	}
	if r[0] == '十' {
		return 10 + danmuCNNum[string(r[1])]
	}
	if r[len(r)-1] == '十' {
		return danmuCNNum[string(r[0])] * 10
	}
	return 0
}

// danmuSplitSeason 拆「作品主名 + 季号」（「最终季」等非数字写法不当季号，桌面同语义）。
func danmuSplitSeason(raw string) (string, int) {
	season := 0
	body := reSeasonMark.ReplaceAllStringFunc(raw, func(m string) string {
		sub := reSeasonMark.FindStringSubmatch(m)
		if season == 0 {
			season = danmuSeasonToInt(sub[1] + sub[2] + sub[3])
		}
		return " "
	})
	return danmuNormalizeTitle(body), season
}

// danmuExactMatchTier 自建源准入 = 精确匹配：主名归一化完全相等 + 季号一致。
// 命中返回档位（0=季一致 1=隐含第一季 2=未标季），不匹配 -1。
func (b *Bridge) danmuExactMatchTier(query string, querySeason int64, candTitle string) int {
	qName, qSeason := danmuSplitSeason(query)
	cName, cSeason := danmuSplitSeason(candTitle)
	if qName == "" || qName != cName {
		return -1
	}
	want := qSeason
	if querySeason > 0 {
		want = int(querySeason)
	}
	if cSeason > 0 {
		if cSeason == want {
			return 0
		}
		if want == 0 && cSeason == 1 {
			return 1
		}
		return -1
	}
	if want <= 1 {
		return 2
	}
	return -1
}

// danmuKeywordCandidates 搜索关键词候选：整串优先，失败回退番名首段（lc-1101 实测必须回退）。
func danmuKeywordCandidates(title string) []string {
	raw := strings.TrimSpace(title)
	if raw == "" {
		return nil
	}
	segs := strings.FieldsFunc(raw, func(r rune) bool {
		return r == '-' || r == '–' || r == '—' || r == ':' || r == '：'
	})
	head := ""
	if len(segs) > 0 {
		head = strings.TrimSpace(segs[0])
	}
	if head != "" && head != raw {
		return []string{raw, head}
	}
	return []string{raw}
}

type danmuCacheEntry struct {
	val []any
	exp time.Time
}

var danmuSearchCache sync.Map

func (b *Bridge) danmuSearchAnimes(title string, season int64) []map[string]any {
	base := b.danmuBase()
	var hits []map[string]any
	for _, keyword := range danmuKeywordCandidates(title) {
		key := danmuNormalizeTitle(keyword)
		var animes []any
		if v, ok := danmuSearchCache.Load(key); ok {
			if e, ok2 := v.(danmuCacheEntry); ok2 && time.Now().Before(e.exp) {
				animes = e.val
			}
		}
		if animes == nil {
			_, j, err := b.danmakuGetJSON(base + "/api/v2/search/anime?keyword=" + url.QueryEscape(keyword))
			if err != nil || j == nil {
				continue
			}
			// 桌面同语义：success 明确为 false 才算失败（服务正常响应 success=true 或无此字段）
			if succ, ok := j["success"].(bool); ok && !succ {
				break // success=false：服务异常
			}
			list, _ := j["animes"].([]any)
			animes = list
			if animes != nil {
				danmuSearchCache.Store(key, danmuCacheEntry{animes, time.Now().Add(5 * time.Minute)})
			}
		}
		type animeHit struct {
			m      map[string]any
			tier   int
			isBili bool
		}
		var ranked []animeHit
		for _, v := range animes {
			a, ok := v.(map[string]any)
			if !ok {
				continue
			}
			id := jsNum(a["animeId"])
			if id <= 0 {
				continue
			}
			animeTitle := jsStr(a["animeTitle"])
			tier := b.danmuExactMatchTier(keyword, season, animeTitle)
			if tier < 0 {
				continue
			}
			ranked = append(ranked, animeHit{a, tier, jsStr(a["source"]) == "bilibili"})
		}
		sort.SliceStable(ranked, func(i, j int) bool {
			if ranked[i].tier != ranked[j].tier {
				return ranked[i].tier < ranked[j].tier
			}
			return ranked[i].isBili
		})
		if len(ranked) > 0 {
			for _, r := range ranked {
				hits = append(hits, r.m)
			}
			return hits
		}
	}
	return hits
}

func (b *Bridge) danmuEpisodesOf(animeID float64) []map[string]any {
	_, j, err := b.danmakuGetJSON(b.danmuBase() + fmt.Sprintf("/api/v2/bangumi/%v", animeID))
	if err != nil || j == nil {
		return nil
	}
	if bg, _ := j["bangumi"].(map[string]any); bg != nil {
		if eps, _ := bg["episodes"].([]any); eps != nil {
			return toMapSlice(eps)
		}
	}
	return nil
}

func (b *Bridge) danmuPickEpisode(hit map[string]any, ep int64) map[string]any {
	eps := b.danmuEpisodesOf(jsNum(hit["animeId"]))
	if len(eps) == 0 {
		return nil
	}
	if ep <= 0 {
		if len(eps) == 1 {
			return eps[0]
		}
		return nil // 多集条目宁可判未命中也不瞎选第 1 集（挂错集比没弹幕更糟）
	}
	for _, e := range eps {
		id := jsNum(e["episodeId"])
		if id <= 0 {
			continue
		}
		num := jsNum(e["episodeNumber"])
		if num == float64(ep) {
			return e
		}
		if num == 0 {
			if m := reEpFromTitle.FindStringSubmatch(jsStr(e["episodeTitle"])); len(m) > 1 {
				if n, err := strconv.ParseInt(m[1], 10, 64); err == nil && n == ep {
					return e
				}
			}
		}
	}
	return nil
}

func (b *Bridge) danmuFetchItems(episodeID int64) []map[string]any {
	client := &http.Client{Timeout: 30 * time.Second}
	// [v1.4.5] 参数改 int64：%v 对 float64 出科学计数法（id≥1e7），URL 会被弹幕服务 404
	req, _ := http.NewRequest(http.MethodGet, b.danmuBase()+fmt.Sprintf("/api/v2/comment/%d?format=xml", episodeID), nil)
	req.Header.Set("User-Agent", biliUA)
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if len(data) < 16 {
		return nil
	}
	return parseDanmakuXML(data)
}

// danmuAutoFetch 自建源自动路径：番名+集数 → 搜索 → 定位集 → 拉弹幕。
// [v0.81.0] 返回带原因（供面板排障）：未启用 / 搜索无精确匹配条目 / 候选均无弹幕 / 命中。
func (b *Bridge) danmuAutoFetch(title string, ep int64, season int64) ([]map[string]any, string) {
	if !b.danmuIsActive() {
		return nil, "自建源未启用"
	}
	hits := b.danmuSearchAnimes(title, season)
	if len(hits) == 0 {
		return nil, "自建源搜索无精确匹配条目"
	}
	tries := 3
	for _, hit := range hits {
		if tries <= 0 {
			break
		}
		tries--
		e := b.danmuPickEpisode(hit, ep)
		if e == nil {
			continue
		}
		id := jsNum(e["episodeId"])
		if id <= 0 {
			continue
		}
		if items := b.danmuFetchItems(int64(id)); len(items) > 0 {
			return items, "命中"
		}
	}
	return nil, "自建源候选均无弹幕"
}

// danmuCandidates 自建源候选（bvid 位为 dmapi:<episodeId> 伪 id）。未启用/未命中返回 nil → 降级 B站。
func (b *Bridge) danmuCandidates(title string, ep int64, season int64) []map[string]any {
	if !b.danmuIsActive() {
		return nil
	}
	hits := b.danmuSearchAnimes(title, season)
	out := []map[string]any{}
	tries := 5
	for _, hit := range hits {
		if tries <= 0 || len(out) >= 5 {
			break
		}
		tries--
		e := b.danmuPickEpisode(hit, ep)
		if e == nil {
			continue
		}
		id := jsNum(e["episodeId"])
		if id <= 0 {
			continue
		}
		epTitle := jsStr(e["episodeTitle"])
		full := jsStr(hit["animeTitle"])
		if epTitle != "" {
			full += " · " + epTitle
		}
		// [v1.4.5] ⚠ 必须整数化字符串：%v 对 float64 走 %g，id≥1e7 时输出科学计数法
		// （如 "1.2345678e+07"）→ pick 端解析必败报「自建源候选 id 无效」（用户实测踩过）。
		out = append(out, map[string]any{
			"bvid":           danmuIDPrefix + strconv.FormatInt(int64(id), 10),
			"title":          full,
			"source":         "自建源",
			"is_compilation": false,
			"sim":            1,
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
