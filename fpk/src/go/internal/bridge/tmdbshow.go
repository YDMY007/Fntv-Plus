// Package bridge —— tmdbshow.go：剧集信息卡完整数据（tmdb:show / tmdb:season-episodes）。
// 忠实移植桌面版 tmdbSync.js 的 fetchShowDetails + normalizeShow + resolveShowId/tmdbSearchBest
// （append_to_response 聚合 + include_image_language + 长标题递进搜索 + 年份就近择优）。
package bridge

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// logf bridge 包日志（落 fntvplus.log，管理页「实时日志」可见）。
func logf(format string, args ...any) {
	log.Printf("[fntv-bridge] "+format, args...)
}

/* ===== 前端字段兼容类型 ===== */

// flexInt64 兼容「数字 或 数字字符串」。
//
// 由来（网页端「剧集信息：标题为空」的真因）：渲染层 extractTmdbId() 返回的是 **string**
// （如 "66732"），桌面版主进程 resolveShowId 用 /^\d+$/ 正则接受数字字符串；而本文件原先
// 用 `TmdbID int64` 接收 → JSON 反序列化报 "cannot unmarshal string into int64"，
// 该错误又被 `_ = json.NewDecoder(...).Decode(&req)` 直接丢弃 → tmdbId 静默变成 0
// → 只能退回「按标题搜索」，而季页（二级详情页）拿到的季对象往往没有独立标题
// → resolveShowID 返回 "标题为空"。桌面版从不报这个错，正因它接受字符串型 id。
//
// 注意：必须**宽容解析（不返回 error）**。encoding/json 在 object 内遇到字段级类型错误时
// 会记录错误并继续，但任何返回 error 的自定义 UnmarshalJSON 都可能让调用方整体放弃该请求体；
// 这里只把它归零，绝不因此丢掉同结构体的 title / seasonNumber 等关键字段。
type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		s = strings.TrimSpace(s[1 : len(s)-1]) // 引号内可能还带空格：" 66732 "
	}
	if s == "" || s == "null" || s == "undefined" {
		*f = 0
		return nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		*f = flexInt64(n)
		return nil
	}
	// 浮点写法（123.0）也接受
	if fl, err := strconv.ParseFloat(s, 64); err == nil {
		*f = flexInt64(int64(fl))
	}
	return nil
}

func (f flexInt64) Int64() int64 { return int64(f) }

/* ===== JSON 访问小工具 ===== */

func jArr(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return nil
}
func jMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}
func jStr(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}
func jNum(m map[string]any, k string) float64 {
	if m == nil {
		return 0
	}
	if f, ok := m[k].(float64); ok {
		return f
	}
	return 0
}
func jBool(m map[string]any, k string) bool {
	if m == nil {
		return false
	}
	if b, ok := m[k].(bool); ok {
		return b
	}
	return false
}

// namesOf 取数组元素指定字段（去重、去空白），默认 name。
func namesOf(list []any, field string) []string {
	if field == "" {
		field = "name"
	}
	seen := map[string]bool{}
	out := []string{}
	for _, it := range list {
		m := jMap(it)
		v := jStr(m, field)
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// yearOfAny 取日期字符串前 4 位年份。
func yearOfAny(date any) string {
	s, _ := date.(string)
	if len(s) >= 4 {
		return s[:4]
	}
	return ""
}

/* ===== 搜索：长标题递进候选 + 年份就近 ===== */

var seasonSuffixRe = regexp.MustCompile(`(?i)\s*(第\s*[0-9一二三四五六七八九十百]+\s*季|season\s*\d{1,3}|s\s*\d{1,3})\s*$`)

// normPunct 全角标点归一化（与桌面版一致）。
func normPunct(s string) string {
	rep := strings.NewReplacer(
		"，", ",", "、", ",", "；", ";", "：", ":", "！", "!", "？", "?",
		"—", "-", "…", "...", "・", "·", "･", "·", "　", " ",
	)
	return rep.Replace(s)
}

// buildRelaxedTitles 长描述性中文标题的递进缩短候选。
func buildRelaxedTitles(title string) []string {
	out := []string{}
	segs := []string{}
	for _, s := range regexp.MustCompile(`[，,、；;：:！!？?。.\s…—\-]`).Split(title, -1) {
		if t := strings.TrimSpace(s); t != "" {
			segs = append(segs, t)
		}
	}
	if len(segs) > 1 {
		out = append(out, segs[0])
		if len(segs) >= 2 && len([]rune(segs[0]))+len([]rune(segs[1])) <= 20 {
			out = append(out, segs[0]+segs[1])
		}
	}
	runeTitle := []rune(title)
	for _, n := range []int{16, 12, 8} {
		if len(runeTitle) > n {
			out = append(out, string(runeTitle[:n]))
		}
	}
	return out
}

// tmdbSearchBest 候选查询逐个搜索（带年份 → 无年份），命中后取年份差最小的结果。
func (b *Bridge) tmdbSearchBest(mt, title, year string) (int64, error) {
	client := b.tmdbClient()
	key := b.tmdbAPIKey()
	bearer, queryKey := authForKey(key)
	doSearch := func(q, y string) []any {
		u, _ := url.Parse(apiBaseTMDB + "/search/" + mt)
		qq := u.Query()
		qq.Set("language", "zh-CN")
		qq.Set("query", q)
		qq.Set("page", "1")
		if queryKey != "" {
			qq.Set("api_key", queryKey)
		}
		if y != "" {
			if mt == "movie" {
				qq.Set("year", y)
			} else {
				qq.Set("first_air_date_year", y)
			}
		}
		u.RawQuery = qq.Encode()
		req, _ := http.NewRequest(http.MethodGet, u.String(), nil)
		req.Header.Set("Accept", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
		return jArr(out["results"])
	}
	tryQuery := func(q string) []any {
		a := doSearch(q, year)
		if len(a) > 0 {
			return a
		}
		return doSearch(q, "")
	}
	queries := []string{}
	norm := normPunct(title)
	if norm != title {
		queries = append(queries, norm)
	}
	queries = append(queries, title)
	for _, q := range buildRelaxedTitles(title) {
		if q != title && q != norm {
			found := false
			for _, exist := range queries {
				if exist == q {
					found = true
					break
				}
			}
			if !found {
				queries = append(queries, q)
			}
		}
	}
	var all []any
	for _, q := range queries {
		r := tryQuery(q)
		if len(r) > 0 {
			all = r
			break
		}
	}
	if len(all) == 0 {
		return 0, fmt.Errorf("TMDB 搜索无果: %s", title)
	}
	yearNum := 0
	_, _ = fmt.Sscanf(year, "%d", &yearNum)
	yearGap := func(m map[string]any) int {
		if yearNum == 0 {
			return 0
		}
		rd := jStr(m, "release_date")
		if mt != "movie" {
			rd = jStr(m, "first_air_date")
		}
		ry := 0
		if len(rd) >= 4 {
			_, _ = fmt.Sscanf(rd[:4], "%d", &ry)
		}
		if ry == 0 {
			return 4
		}
		g := ry - yearNum
		if g < 0 {
			g = -g
		}
		return g
	}
	best := jMap(all[0])
	bestGap := yearGap(best)
	for _, raw := range all {
		m := jMap(raw)
		if m == nil {
			continue
		}
		if g := yearGap(m); g < bestGap {
			bestGap = g
			best = m
		}
	}
	if best == nil || jNum(best, "id") <= 0 {
		return 0, fmt.Errorf("TMDB 搜索无有效结果")
	}
	return int64(jNum(best, "id")), nil
}

// resolveShowID tmdbId 直取；否则去季号后缀走递进搜索。
func (b *Bridge) resolveShowID(mt string, tmdbID int64, title, year string) (int64, error) {
	if tmdbID > 0 {
		return tmdbID, nil
	}
	title = strings.TrimSpace(title)
	title = seasonSuffixRe.ReplaceAllString(title, "")
	if title == "" {
		// 错误信息必须自带诊断信息：用户只看到「标题为空」四个字时无从判断是
		// 「元数据没有 tmdbId」还是「tmdbId 传了但后端没吃下」。带上 mediaType 便于定位。
		return 0, fmt.Errorf("缺少标题且无 TMDB id（mediaType=%s）——季页元数据通常不带标题，"+
			"请确认该剧在飞牛刮削时已写入 TMDB 编号", mt)
	}
	return b.tmdbSearchBest(mt, title, year)
}

/* ===== normalizeShow 完整形状移植 ===== */

// crewByJob 按 CREW_JOBS 别名组筛主创（去重，保序）。
func crewByJob(crew []any, jobs []string) []string {
	want := map[string]bool{}
	for _, j := range jobs {
		j = strings.TrimSpace(j)
		if j != "" {
			want[j] = true
		}
	}
	if len(want) == 0 {
		return []string{}
	}
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range crew {
		c := jMap(raw)
		if c == nil {
			continue
		}
		name := jStr(c, "name")
		if name == "" || seen[name] {
			continue
		}
		hit := false
		if j := jStr(c, "job"); want[strings.TrimSpace(j)] {
			hit = true
		}
		if !hit {
			for _, r := range jArr(c["jobs"]) {
				if j, ok := r.(string); ok && want[strings.TrimSpace(j)] {
					hit = true
					break
				}
			}
		}
		if hit {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// epBrief 播放条目摘要（上一集/下一集）。
func epBrief(e any) any {
	m := jMap(e)
	if m == nil || jNum(m, "id") == 0 {
		return nil
	}
	return map[string]any{
		"seasonNumber":  int64(jNum(m, "season_number")),
		"episodeNumber": int64(jNum(m, "episode_number")),
		"name":          jStr(m, "name"),
		"airDate":       jStr(m, "air_date"),
		"overview":      jStr(m, "overview"),
		"runtime":       int64(jNum(m, "runtime")),
		"voteAverage":   jNum(m, "vote_average"),
		"stillPath":     jStr(m, "still_path"),
	}
}

var crewJobs = map[string][]string{
	"director": {"Director", "Series Director", "Co-Director", "Assistant Director", "Episode Director"},
	"writer":   {"Writer", "Screenplay", "Story", "Original Story", "Series Composition", "Scenario Writer", "Script Editor", "Novel", "Comic Book", "Head Writer", "Storyboard"},
	"composer": {"Original Music Composer", "Music Director", "Music Producer", "Music", "Theme Song Performance", "Sound Director"},
	"producer": {"Producer", "Executive Producer", "Co-Producer", "Co-Executive Producer", "Line Producer", "Supervising Producer", "Animation Producer", "Production Supervisor", "Associate Producer"},
	"designer": {"Character Designer", "Chief Animation Director", "Animation Director", "Color Designer", "Art Direction", "Production Design", "Art Department Coordinator", "Background Designer", "Set Decoration", "Costume Design", "VFX Supervisor", "3D Director", "CGI Director"},
}

// normalizeShow 归一化详情 + append_to_response 各子响应（完整字段形状与桌面版一致）。
func normalizeShow(d map[string]any, mt string, id int64, season any) map[string]any {
	titleKey, origKey := "name", "original_name"
	if mt == "movie" {
		titleKey, origKey = "title", "original_title"
	}
	title := firstNonEmpty(jStr(d, titleKey), jStr(d, origKey))
	original := jStr(d, origKey)
	airDate := jStr(d, "first_air_date")
	if mt == "movie" {
		airDate = jStr(d, "release_date")
	}
	agg := jMap(d["aggregate_credits"])
	credits := jMap(d["credits"])
	crew := jArr(credits["crew"])
	if len(crew) == 0 {
		crew = jArr(agg["crew"])
	}
	castRaw := jArr(agg["cast"])
	if len(castRaw) == 0 {
		castRaw = jArr(credits["cast"])
	}
	if len(castRaw) > 20 {
		castRaw = castRaw[:20]
	}
	cast := []map[string]any{}
	for _, raw := range castRaw {
		c := jMap(raw)
		character := jStr(c, "character")
		if character == "" {
			if roles := jArr(c["roles"]); len(roles) > 0 {
				if r0 := jMap(roles[0]); r0 != nil {
					character = jStr(r0, "character")
				}
			}
		}
		order := jNum(c, "order")
		cast = append(cast, map[string]any{
			"name": jStr(c, "name"), "character": character,
			"profile": jStr(c, "profile_path"), "order": order,
		})
	}
	for i := 1; i < len(cast); i++ {
		for j := i; j > 0 && jNum(cast[j], "order") < jNum(cast[j-1], "order"); j-- {
			cast[j], cast[j-1] = cast[j-1], cast[j]
		}
	}
	runtimes := []float64{}
	for _, r := range jArr(d["episode_run_time"]) {
		if f, ok := r.(float64); ok && f > 0 {
			runtimes = append(runtimes, f)
		}
	}
	if len(runtimes) == 0 && mt == "movie" && jNum(d, "runtime") > 0 {
		runtimes = append(runtimes, jNum(d, "runtime"))
	}
	runtimeAvg := 0
	if len(runtimes) > 0 {
		sum := 0.0
		for _, r := range runtimes {
			sum += r
		}
		runtimeAvg = int(sum/float64(len(runtimes)) + 0.5)
	}
	certification := ""
	certifications := []map[string]any{}
	if mt == "tv" {
		cr := jArr(jMap(d["content_ratings"])["results"])
		for _, raw := range cr {
			m := jMap(raw)
			region := jStr(m, "iso_3166_1")
			rating := jStr(m, "rating")
			if certification == "" && (region == "US" || len(cr) > 0 && false) {
				certification = rating
			}
			if region != "" && rating != "" {
				certifications = append(certifications, map[string]any{"region": region, "rating": rating})
			}
		}
		// US 优先，缺失取第一个
		for _, raw := range cr {
			m := jMap(raw)
			if jStr(m, "iso_3166_1") == "US" {
				certification = jStr(m, "rating")
				break
			}
		}
	} else {
		rd := jArr(jMap(d["release_dates"])["results"])
		for _, raw := range rd {
			m := jMap(raw)
			region := jStr(m, "iso_3166_1")
			for _, dr := range jArr(m["release_dates"]) {
				dm := jMap(dr)
				c := jStr(dm, "certification")
				if certification == "" && region == "US" {
					certification = c
				}
				if region != "" && c != "" {
					certifications = append(certifications, map[string]any{"region": region, "rating": c})
				}
			}
		}
	}
	backdropPath := jStr(d, "backdrop_path")
	backdrops := []string{}
	bds := jArr(jMap(d["images"])["backdrops"])
	// 按 vote_average 降序
	for i := 1; i < len(bds); i++ {
		for j := i; j > 0 && jNum(jMap(bds[j]), "vote_average") > jNum(jMap(bds[j-1]), "vote_average"); j-- {
			bds[j], bds[j-1] = bds[j-1], bds[j]
		}
	}
	for _, raw := range bds {
		m := jMap(raw)
		fp := jStr(m, "file_path")
		if fp == "" || fp == backdropPath {
			continue
		}
		if w := jNum(m, "width"); w > 0 && w < 400 {
			continue
		}
		backdrops = append(backdrops, fp)
		if len(backdrops) >= 6 {
			break
		}
	}
	recRaw := jArr(jMap(d["recommendations"])["results"])
	recommendations := []map[string]any{}
	for _, raw := range recRaw {
		m := jMap(raw)
		if m == nil {
			continue
		}
		t := jStr(m, "name")
		if mt == "movie" {
			t = firstNonEmpty(jStr(m, "title"), jStr(m, "original_title"))
		}
		rid := int64(jNum(m, "id"))
		if rid > 0 && t != "" {
			recommendations = append(recommendations, map[string]any{
				"tmdbId": rid, "title": t, "year": yearOfAny(firstNonEmpty(jStr(m, "release_date"), jStr(m, "first_air_date"))),
				"url": fmt.Sprintf("https://www.themoviedb.org/%s/%d", mt, rid),
			})
		}
		if len(recommendations) >= 8 {
			break
		}
	}
	vids := jArr(jMap(d["videos"])["results"])
	trailerKey, trailerName := "", ""
	for _, raw := range vids {
		v := jMap(raw)
		if jStr(v, "site") != "YouTube" {
			continue
		}
		if jStr(v, "type") == "Trailer" || trailerKey == "" {
			trailerKey = jStr(v, "key")
			trailerName = jStr(v, "name")
			if jStr(v, "type") == "Trailer" {
				break
			}
		}
	}
	altRaw := jArr(jMap(d["alternative_titles"])["results"])
	if mt == "movie" {
		altRaw = jArr(jMap(d["alternative_titles"])["titles"])
	}
	aliases := []string{}
	for _, a := range namesOf(altRaw, "title") {
		if a != title && a != original {
			aliases = append(aliases, a)
			if len(aliases) >= 8 {
				break
			}
		}
	}
	wp := jMap(d["watch/providers"])
	wpResults := jMap(wp["results"])
	provSeen := map[string]bool{}
	providers := []string{}
	for _, region := range []string{"CN", "HK", "TW", "JP", "KR", "US"} {
		flatrate := jArr(jMap(wpResults[region])["flatrate"])
		for _, n := range namesOf(flatrate, "provider_name") {
			if strings.HasSuffix(strings.ToLower(n), " with ads") {
				continue
			}
			if !provSeen[n] {
				provSeen[n] = true
				providers = append(providers, n)
			}
		}
	}
	kwRaw := jArr(jMap(d["keywords"])["results"])
	if mt == "movie" {
		kwRaw = jArr(jMap(d["keywords"])["keywords"])
	}
	keywords := namesOf(kwRaw, "name")
	if len(keywords) > 16 {
		keywords = keywords[:16]
	}
	countries := namesOf(jArr(d["production_countries"]), "name")
	if len(countries) > 6 {
		countries = countries[:6]
	}
	countryCodes := []string{}
	for _, raw := range jArr(d["origin_country"]) {
		if s, ok := raw.(string); ok && s != "" {
			countryCodes = append(countryCodes, s)
		}
	}
	languages := []string{}
	languageCodes := []string{}
	for _, raw := range jArr(d["spoken_languages"]) {
		l := jMap(raw)
		if en := firstNonEmpty(jStr(l, "english_name"), jStr(l, "name")); en != "" && len(languages) < 8 {
			languages = append(languages, en)
		}
		if iso := jStr(l, "iso_639_1"); iso != "" && len(languageCodes) < 8 {
			languageCodes = append(languageCodes, iso)
		}
	}
	createdBy := namesOf(jArr(d["created_by"]), "name")
	if len(createdBy) > 6 {
		createdBy = createdBy[:6]
	}
	extIDs := jMap(d["external_ids"])
	imdb := firstNonEmpty(jStr(extIDs, "imdb_id"), jStr(d, "imdb_id"))
	tvdb := jStr(extIDs, "tvdb_id")
	if tvdb != "" {
		tvdb = fmt.Sprintf("%v", stripQuotes(tvdb))
	}
	runtimeMin, runtimeMax := 0, 0
	if len(runtimes) > 0 {
		runtimeMin = int(runtimes[0])
		runtimeMax = int(runtimes[0])
		for _, r := range runtimes {
			if int(r) < runtimeMin {
				runtimeMin = int(r)
			}
			if int(r) > runtimeMax {
				runtimeMax = int(r)
			}
		}
	}
	return map[string]any{
		"tmdbId": id, "mediaType": mt,
		"url":   fmt.Sprintf("https://www.themoviedb.org/%s/%d", mt, id),
		"title": title, "originalTitle": original,
		"tagline": jStr(d, "tagline"), "overview": jStr(d, "overview"),
		"year": yearOfAny(airDate), "airDate": airDate,
		"lastAirDate": jStr(d, "last_air_date"), "status": jStr(d, "status"),
		"inProduction": jBool(d, "in_production"),
		"seasons":      int64(jNum(d, "number_of_seasons")), "episodes": int64(jNum(d, "number_of_episodes")),
		"runtimeAvg": runtimeAvg, "runtimeMin": runtimeMin, "runtimeMax": runtimeMax,
		"genres":   namesOf(jArr(d["genres"]), "name"),
		"showType": jStr(d, "type"), "originalLanguage": jStr(d, "original_language"),
		"countries": countries, "countryCodes": countryCodes, "languages": languages,
		"networks":  namesOf(jArr(d["networks"]), "name"),
		"companies": capSlice(namesOf(jArr(d["production_companies"]), "name"), 8),
		"createdBy": capSlice(createdBy, 6),
		"directors": capSlice(crewByJob(crew, crewJobs["director"]), 6),
		"writers":   capSlice(crewByJob(crew, crewJobs["writer"]), 8),
		"composers": capSlice(crewByJob(crew, crewJobs["composer"]), 4),
		"producers": capSlice(crewByJob(crew, crewJobs["producer"]), 6),
		"designers": capSlice(crewByJob(crew, crewJobs["designer"]), 6),
		"cast":      cast,
		"rating":    jNum(d, "vote_average"), "votes": int64(jNum(d, "vote_count")),
		"popularity":    jNum(d, "popularity"),
		"certification": certification, "certifications": certifications,
		"languageCodes": languageCodes, "homepage": jStr(d, "homepage"),
		"externalIds": map[string]any{
			"imdb":      imdb,
			"tvdb":      tvdb,
			"wikidata":  jStr(extIDs, "wikidata_id"),
			"instagram": jStr(extIDs, "instagram_id"),
			"twitter":   jStr(extIDs, "twitter_id"),
			"facebook":  jStr(extIDs, "facebook_id"),
		},
		"trailerKey": trailerKey, "trailerName": trailerName,
		"posterPath": jStr(d, "poster_path"), "backdropPath": backdropPath,
		"backdrops": backdrops, "keywords": keywords, "aliases": aliases,
		"providers":       capSlice(providers, 8),
		"recommendations": recommendations,
		"lastEpisode":     epBrief(d["last_episode_to_air"]),
		"nextEpisode":     epBrief(d["next_episode_to_air"]),
		"season":          season,
	}
}

func stripQuotes(v any) string {
	if s, ok := v.(string); ok {
		return strings.Trim(s, `"`)
	}
	return fmt.Sprintf("%v", v)
}

func capSlice(in []string, n int) []string {
	if len(in) > n {
		return in[:n]
	}
	return in
}

// normalizeSeason 季摘要。
func normalizeSeason(s map[string]any, seasonNumber int64) any {
	if s == nil || jNum(s, "id") == 0 {
		return nil
	}
	epCount := len(jArr(s["episodes"]))
	if epCount == 0 {
		epCount = int(jNum(s, "episode_count"))
	}
	return map[string]any{
		"seasonNumber": seasonNumber,
		"name":         jStr(s, "name"),
		"overview":     jStr(s, "overview"),
		"airDate":      jStr(s, "air_date"),
		"episodeCount": epCount,
		"posterPath":   jStr(s, "poster_path"),
		"voteAverage":  jNum(s, "vote_average"),
		"voteCount":    int64(jNum(s, "vote_count")),
	}
}

/* ===== Handler：tmdb:show 完整聚合 ===== */

/* ===== 磁盘持久化缓存 [v0.62.0] =====
 * 对齐桌面版 lc-926：详情/分集首次拉取后落盘（config 同目录 tmdb-cache/），之后一律读缓存；
 * 只有请求带 force=true（卡片「刷新」按钮）才重拉。TMDB 内容基本静态 → 缓存永久有效
 * （桌面版 TTL 10 年等效）。失败结果不落盘。缓存键含媒体类型/ID(或标题哈希)/季号。 */

const tmdbCacheVer = "v1"

func (b *Bridge) tmdbCachePath(kind string, keyParts ...string) string {
	base := b.cfg.Dir()
	if base == "" {
		return ""
	}
	sum := md5.Sum([]byte(strings.Join(keyParts, "|")))
	dir := filepath.Join(base, "tmdb-cache")
	_ = os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, kind+"_"+tmdbCacheVer+"_"+hex.EncodeToString(sum[:10])+".json")
}

func tmdbCacheRead(path string) (map[string]any, bool) {
	if path == "" {
		return nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 8 {
		return nil, false
	}
	var out map[string]any
	if json.Unmarshal(data, &out) != nil || out["data"] == nil {
		return nil, false
	}
	return out, true
}

func tmdbCacheWrite(path string, payload map[string]any) {
	if path == "" {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

// tmdbFetchMulti [v1.2.6] 多路兜底 GET TMDB（tmdbGet 同款语义，服务聚合大请求）：
// 自定义代理 → 免梯子直连 IP → 系统直连，网络层错误（EOF/超时/重置——国内直连 TMDB 的常态）
// 自动换下一路；服务器有响应（401/404/429 等）不换路，原样返回状态与解析体。
// 由来：tmdbShow/tmdbSeasonEpisodes 的详情/季请求此前是**单路单次**（tmdbClient().Do 一次即弃），
// tmdbGet 早已多路兜底（v0.74.0）但聚合请求没享受到 → 用户季页频繁看到裸 `Get "https://...": EOF`。
// 超时 30s：聚合响应（aggregate_credits 等）比普通端点大得多。
func (b *Bridge) tmdbFetchMulti(urlStr, bearer string) (int, map[string]any, error) {
	type tmAttempt struct {
		c   *http.Client
		via string
	}
	attempts := []tmAttempt{}
	if proxy := b.customProxyURL(); proxy != "" {
		if pu, perr := url.Parse(proxy); perr == nil && pu.Scheme != "" {
			attempts = append(attempts, tmAttempt{&http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}, "自定义代理"})
		}
	}
	if dc := b.tmdbDirectClient(); dc != nil {
		attempts = append(attempts, tmAttempt{dc, "免梯子直连"})
	}
	attempts = append(attempts, tmAttempt{b.client, "系统直连"})

	var lastNetErr error
	for _, a := range attempts {
		req, _ := http.NewRequest(http.MethodGet, urlStr, nil)
		req.Header.Set("Accept", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		resp, err := a.c.Do(req)
		if err != nil {
			lastNetErr = fmt.Errorf("%s：%v", a.via, err)
			logf("[tmdb] multi %s 失败: %v", a.via, err)
			continue
		}
		var out map[string]any
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 32*1024*1024)).Decode(&out)
		resp.Body.Close()
		if decodeErr != nil {
			lastNetErr = fmt.Errorf("%s：响应解析失败 %v", a.via, decodeErr)
			continue
		}
		return resp.StatusCode, out, nil
	}
	return 0, nil, lastNetErr
}

// tmdbShow 完整详情（append_to_response 聚合 + include_image_language + 季摘要）。
func (b *Bridge) tmdbShow(w http.ResponseWriter, r *http.Request) {
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key，请在设置面板填写。"})
		return
	}
	var req struct {
		// flexInt64：前端 extractTmdbId() 返回字符串（"66732"），必须兼容（详见类型注释）。
		// 用 int64 会把字符串型 id 静默吞成 0 → 退化为「按标题搜索」→ 季页无标题即报错。
		TmdbID       flexInt64  `json:"tmdbId"`
		Title        string     `json:"title"`
		Year         string     `json:"year"`
		MediaType    string     `json:"mediaType"`
		SeasonNumber *flexInt64 `json:"seasonNumber"`
		Force        bool       `json:"force"`
	}
	// 解析错误不再静默丢弃：字段类型不匹配曾导致「tmdbId 变 0」这类问题完全无迹可寻。
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		logf("[tmdb] show 请求体解析失败: %v", err)
	}
	mt := req.MediaType
	if mt != "movie" && mt != "tv" {
		mt = "tv"
	}
	logf("[tmdb] show req: tmdbId=%d title=%q year=%q mt=%s season=%v",
		req.TmdbID.Int64(), req.Title, req.Year, mt, req.SeasonNumber != nil)
	// [v0.62.0] 磁盘缓存：key = mt + id(或标题/年份哈希) + 季号；force 绕过
	seasonPart := "s-1"
	if req.SeasonNumber != nil {
		seasonPart = "s" + strconv.FormatInt(req.SeasonNumber.Int64(), 10)
	}
	var keyParts []string
	keyParts = append(keyParts, mt)
	if idv := req.TmdbID.Int64(); idv > 0 {
		keyParts = append(keyParts, "id", strconv.FormatInt(idv, 10))
	} else {
		keyParts = append(keyParts, "t", strings.TrimSpace(req.Title), strings.TrimSpace(req.Year))
	}
	cachePath := b.tmdbCachePath("show", append(keyParts, seasonPart)...)
	if !req.Force {
		if cached, ok := tmdbCacheRead(cachePath); ok {
			cached["fromCache"] = true
			writeJSON(w, http.StatusOK, cached)
			logf("[tmdb] show 缓存命中 (%s)", seasonPart)
			return
		}
	}
	bearer, queryKey := authForKey(b.tmdbAPIKey())
	id, err := b.resolveShowID(mt, req.TmdbID.Int64(), req.Title, req.Year)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	appendList := "credits,external_ids,keywords,alternative_titles,images,videos,release_dates,watch/providers,recommendations"
	if mt == "tv" {
		appendList = "aggregate_credits,credits,external_ids,keywords,content_ratings,alternative_titles,images,videos,watch/providers,recommendations"
	}
	u, _ := url.Parse(fmt.Sprintf("https://api.themoviedb.org/3/%s/%d", mt, id))
	q := u.Query()
	q.Set("language", "zh-CN")
	q.Set("append_to_response", appendList)
	q.Set("include_image_language", "zh-CN,en,null")
	if queryKey != "" {
		q.Set("api_key", queryKey)
	}
	u.RawQuery = q.Encode()
	// [v1.2.6] 单路单次 → 多路兜底（tmdbFetchMulti）：此前这里一次 EOF 就把裸错误甩给前端
	status, d, ferr := b.tmdbFetchMulti(u.String(), bearer)
	if ferr != nil {
		logf("[tmdb] show 详情拉取失败: %v", ferr)
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "TMDB 连接失败（已自动尝试 代理/直连IP/系统直连 三路）：" + ferr.Error() + "。可在设置→TMDB 直连点「更新 IP」后重试，或检查 NAS 网络/代理。"})
		return
	}
	if status != http.StatusOK || d == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("详情 %d", status)})
		return
	}
	var season any
	if mt == "tv" && req.SeasonNumber != nil {
		sn := req.SeasonNumber.Int64()
		if sn < 0 {
			sn = -1 // 负季号无意义，跳过分季请求
		}
		if sn >= 0 {
			su := fmt.Sprintf("https://api.themoviedb.org/3/tv/%d/season/%d", id, sn)
			sq, _ := url.Parse(su)
			sqq := sq.Query()
			sqq.Set("language", "zh-CN")
			if queryKey != "" {
				sqq.Set("api_key", queryKey)
			}
			sq.RawQuery = sqq.Encode()
			if sstatus, sd, serr := b.tmdbFetchMulti(sq.String(), bearer); serr == nil && sstatus == http.StatusOK && sd != nil {
				season = normalizeSeason(sd, sn)
			} else if serr != nil {
				logf("[tmdb] show 季摘要拉取失败: %v", serr)
			}
		}
	}
	out := map[string]any{
		"ok": true, "data": normalizeShow(d, mt, id, season),
		"fetchedAt": time.Now().UnixMilli(),
	}
	// [v1.10.0] OMDb（扩展数据源 ③）：开关开启且有 IMDb id 时补 IMDb 评分/票数，
	// 剧集信息卡评分块渲染「IMDb ★x.x」（tmdbCard.ts）。随 TMDB 磁盘缓存落盘（刷新按钮可更新）。
	if data, ok := out["data"].(map[string]any); ok && b.omdbOn() {
		if ext, ok2 := data["externalIds"].(map[string]any); ok2 {
			if imdb := strings.TrimSpace(jStr(ext, "imdb")); imdb != "" {
				if rating, votes := b.omdbEnrich(imdb); rating > 0 {
					data["imdbRating"] = rating
					data["imdbVotes"] = votes
				}
			}
		}
	}
	tmdbCacheWrite(cachePath, out) // [v0.62.0] 成功结果落盘
	writeJSON(w, http.StatusOK, out)
}

/* ===== Handler：tmdb:season-episodes 双语分集 ===== */

// tmdbSeasonEpisodes {tmdbId?, title?, seasonNumber, force} → 双语分集（zh 主 + en 补）。
func (b *Bridge) tmdbSeasonEpisodes(w http.ResponseWriter, r *http.Request) {
	var req struct {
		// 同 tmdbShow：前端的 tmdbId 是字符串，必须兼容（int64 会静默丢成 0）
		TmdbID       flexInt64  `json:"tmdbId"`
		Title        string     `json:"title"`
		SeasonNumber *flexInt64 `json:"seasonNumber"`
		Force        bool       `json:"force"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		logf("[tmdb] season-episodes 请求体解析失败: %v", err)
	}
	if req.SeasonNumber == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少季号，无法定位 TMDB 分季。"})
		return
	}
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key，请在设置面板填写。"})
		return
	}
	mt := "tv"
	sn := req.SeasonNumber.Int64()
	// [v0.62.0] 磁盘缓存：key = 标题/ID + 季号；force 绕过
	var keyParts []string
	if idv := req.TmdbID.Int64(); idv > 0 {
		keyParts = append(keyParts, "id", strconv.FormatInt(idv, 10))
	} else {
		keyParts = append(keyParts, "t", strings.TrimSpace(req.Title))
	}
	cachePath := b.tmdbCachePath("season", append(keyParts, "s"+strconv.FormatInt(sn, 10))...)
	if !req.Force {
		if cached, ok := tmdbCacheRead(cachePath); ok {
			cached["fromCache"] = true
			writeJSON(w, http.StatusOK, cached)
			logf("[tmdb] season-episodes 缓存命中 (s%d)", sn)
			return
		}
	}
	id, err := b.resolveShowID(mt, req.TmdbID.Int64(), req.Title, "")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	bearer, queryKey := authForKey(b.tmdbAPIKey())
	pull := func(lang string) []map[string]any {
		u := fmt.Sprintf("https://api.themoviedb.org/3/tv/%d/season/%d?language=%s", id, sn, url.QueryEscape(lang))
		if queryKey != "" {
			u += "&api_key=" + url.QueryEscape(queryKey)
		}
		// [v1.2.6] 单路单次 → 多路兜底（tmdbFetchMulti）；失败保持原语义：静默 nil，不影响主流程
		_, out, ferr := b.tmdbFetchMulti(u, bearer)
		if ferr != nil || out == nil {
			return nil
		}
		raw := jArr(out["episodes"])
		eps := []map[string]any{}
		for _, e := range raw {
			if m := jMap(e); m != nil && jNum(m, "episode_number") > 0 {
				eps = append(eps, m)
			}
		}
		return eps
	}
	zhEps := pull("zh-CN")
	enEps := pull("en-US")
	enByNum := map[int64]map[string]any{}
	for _, e := range enEps {
		enByNum[int64(jNum(e, "episode_number"))] = e
	}
	episodes := []map[string]any{}
	for _, e := range zhEps {
		num := int64(jNum(e, "episode_number"))
		en := enByNum[num]
		nameEn, overviewEn := "", ""
		if en != nil {
			nameEn = jStr(en, "name")
			overviewEn = jStr(en, "overview")
		}
		episodes = append(episodes, map[string]any{
			"episodeNumber": num,
			"nameZh":        jStr(e, "name"),
			"overviewZh":    jStr(e, "overview"),
			"nameEn":        nameEn,
			"overviewEn":    overviewEn,
		})
	}
	out := map[string]any{
		"ok": true,
		"data": map[string]any{
			"showTmdbId": id, "seasonNumber": sn, "episodes": episodes,
		},
		"fetchedAt": time.Now().UnixMilli(),
	}
	tmdbCacheWrite(cachePath, out) // [v0.62.0] 成功结果落盘
	writeJSON(w, http.StatusOK, out)
}
