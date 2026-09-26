// Package bridge —— person.go：演员页「TMDB 完整作品 + 简报」。
// 忠实移植桌面版 personTmdb.ts（lc-1033~1039）：
//   ① fnOS /v/api/v1/person/{guid}（签名请求，cookie 由前端转发）→ imdbId / name
//   ② fnOS /v/api/v1/person/item/list（job×5，page_size 200）→ 库内作品 owned 匹配键
//      （规范化中/英标题 + tmdb_id；imdb→tmdb 兜底换算）
//   ③ TMDB /find/{imdb} → person id → /person/{id}/combined_credits → 全量 cast
//   ④ owned 标记 + 库内 guid 回填 → {ok, name, items, ownedCount, total}
// TMDB 请求复用 tmdbGet（v3/v4 鉴权 + 代理/免梯子直连）。缓存为进程内存 TTL（桌面版是
// userData 磁盘缓存 7d/30d + SWR；NAS 后端常驻，内存 6h 等效防 TMDB 限流）。
package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var personGuidRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// jsNormTitle 标题归一化（桌面版 norm 同规则）：去大小写/空格/中英标点。
var jsNormRe = regexp.MustCompile(`[\s　·:：,，.。、!！?？'’"“”\-—_()（）[\]【】~～|/\\]`)

func jsNormTitle(s string) string {
	return jsNormRe.ReplaceAllString(strings.ToLower(s), "")
}

var deptCN = map[string]string{
	"Acting": "演员", "Directing": "导演", "Writing": "编剧", "Production": "制片",
	"Camera": "摄影", "Sound": "音效", "Art": "美术", "Editing": "剪辑", "Visual Effects": "视效",
}

// 内存缓存（成功结果才缓存；过期惰性删除）
var personCache sync.Map // key → personCacheEntry

type personCacheEntry struct {
	v   map[string]any
	exp time.Time
}

func personCacheGet(key string) map[string]any {
	if e, ok := personCache.Load(key); ok {
		en := e.(personCacheEntry)
		if time.Now().Before(en.exp) {
			return en.v
		}
		personCache.Delete(key)
	}
	return nil
}

func personCacheSet(key string, v map[string]any, ttl time.Duration) {
	personCache.Store(key, personCacheEntry{v: v, exp: time.Now().Add(ttl)})
}

type personReq struct {
	GUID   string `json:"guid"`
	Cookie string `json:"cookie"`
}

// decodePersonReq 解析并校验 guid（32 位 hex，桌面版同规则）。
func decodePersonReq(r *http.Request) (personReq, string) {
	var req personReq
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	guid := strings.ToLower(strings.TrimSpace(req.GUID))
	req.GUID = guid
	if !personGuidRe.MatchString(guid) {
		return req, "personGuid 无效"
	}
	return req, ""
}

// libMediaType 库内条目类型归一：tv/movie/空（桌面版同规则）。
func libMediaType(ty string) string {
	for _, k := range []string{"tv", "series", "show", "剧", "集"} {
		if strings.Contains(ty, k) {
			return "tv"
		}
	}
	for _, k := range []string{"movie", "film", "电影"} {
		if strings.Contains(ty, k) {
			return "movie"
		}
	}
	return ""
}

// personCreditsUncached 全量作品真抓取（桌面版 collectCreditsUncached 同逻辑）。
func (b *Bridge) personCreditsUncached(guid, cookie string) map[string]any {
	// ① person 详情 → imdbId / name
	pd, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/person/"+guid, nil, cookie)
	if err != nil {
		return map[string]any{"error": "fnOS 请求失败：" + err.Error()}
	}
	person, _ := pd["data"].(map[string]any)
	if person == nil {
		return map[string]any{"error": "未找到该演员（" + guid + "）"}
	}
	name := jsFirstStr(person["name"], person["title"])
	imdbId := jsFirstStr(person["imdbId"], person["imdb_id"])

	// ② 库内作品（job 过滤；与桌面版一致）
	type libRow struct {
		title string
		ty    string
		guid  string
		tid   float64
		imdb  string
	}
	var libItems []libRow
	for _, job := range []string{"Actor", "Director", "Writer", "Screenplay", "Producer"} {
		body, _ := json.Marshal(map[string]any{
			"person_guid": guid, "page": 1, "page_size": 200, "job": job,
			"sort_column": "update_time", "sort_type": "desc",
		})
		j, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/person/item/list", body, cookie)
		if err != nil {
			continue // 单 job 失败忽略
		}
		data, _ := j["data"].(map[string]any)
		list, _ := data["list"].([]any)
		for _, v := range list {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			tid := jsNum(m["tmdb_id"])
			if tid == 0 {
				tid = jsNum(m["tmdbId"])
			}
			libItems = append(libItems, libRow{
				title: jsFirstStr(m["title"], m["name"], m["original_title"], m["original_name"]),
				ty:    strings.ToLower(jsFirstStr(m["type"], m["media_type"])),
				guid:  jsStr(m["guid"]),
				tid:   tid,
				imdb:  jsFirstStr(m["imdb_id"], m["imdbId"]),
			})
		}
	}
	ownedTmdb := map[string]bool{}
	ownedTitles := map[string]bool{}
	type guidType struct{ g, t string }
	guidByTitle := map[string]guidType{}
	for _, it := range libItems {
		ty := libMediaType(it.ty)
		if it.title != "" {
			key := jsNormTitle(it.title)
			ownedTitles[key] = true
			if it.guid != "" {
				if _, ok := guidByTitle[key]; !ok {
					guidByTitle[key] = guidType{it.guid, ty}
				}
			}
		}
		if it.tid != 0 {
			if ty != "" {
				ownedTmdb[ty+fmt.Sprintf("%v", int64(it.tid))] = true
			} else { // 类型未知时两侧都记（桌面版同款兜底）
				ownedTmdb["tv"+fmt.Sprintf("%v", int64(it.tid))] = true
				ownedTmdb["movie"+fmt.Sprintf("%v", int64(it.tid))] = true
			}
		}
	}
	// imdb→tmdb 兜底（库内记录带 imdb_id 而标题没对上时的保险）
	for _, it := range libItems {
		if it.imdb == "" {
			continue
		}
		_, out, err := b.tmdbGet("/find/"+it.imdb, map[string]string{"external_source": "imdb_id"})
		if err != nil || out == nil {
			continue
		}
		for _, mk := range []string{"movie_results", "tv_results"} {
			arr, _ := out[mk].([]any)
			prefix := "movie"
			if mk == "tv_results" {
				prefix = "tv"
			}
			for _, x := range arr {
				if xm, ok := x.(map[string]any); ok && xm["id"] != nil {
					ownedTmdb[prefix+fmt.Sprintf("%v", int64(jsNum(xm["id"])))] = true
				}
			}
		}
	}

	// ③ TMDB 全量 cast
	if imdbId == "" {
		return map[string]any{"ok": true, "name": name, "noImdb": true, "items": []any{}, "ownedCount": 0}
	}
	_, find, err := b.tmdbGet("/find/"+imdbId, map[string]string{"external_source": "imdb_id"})
	if err != nil {
		return map[string]any{"error": "TMDB find 失败：" + err.Error()}
	}
	pid := ""
	if pr, _ := find["person_results"].([]any); len(pr) > 0 {
		if pm, ok := pr[0].(map[string]any); ok && pm["id"] != nil {
			pid = fmt.Sprintf("%v", int64(jsNum(pm["id"])))
		}
	}
	if pid == "" {
		return map[string]any{"ok": true, "name": name, "noImdb": true, "items": []any{}, "ownedCount": 0}
	}
	_, cr, err := b.tmdbGet("/person/"+pid+"/combined_credits", nil)
	if err != nil {
		return map[string]any{"error": "TMDB combined_credits 失败：" + err.Error()}
	}
	cast, _ := cr["cast"].([]any)
	seen := map[string]bool{}
	items := []map[string]any{}
	for _, v := range cast {
		m, ok := v.(map[string]any)
		if !ok || m["id"] == nil {
			continue
		}
		mt := jsStr(m["media_type"])
		if mt != "tv" {
			mt = "movie"
		}
		k := mt + fmt.Sprintf("%v", int64(jsNum(m["id"])))
		if seen[k] {
			continue
		}
		seen[k] = true
		title := jsFirstStr(m["title"], m["name"])
		if title == "" {
			title = "未知"
		}
		items = append(items, map[string]any{
			"id":        int64(jsNum(m["id"])),
			"title":     title,
			"en":        jsFirstStr(m["original_title"], m["original_name"]),
			"date":      jsFirstStr(m["release_date"], m["first_air_date"]),
			"character": jsStr(m["character"]),
			"score":     jsNum(m["vote_average"]),
			"poster":    jsStr(m["poster_path"]),
			"overview":  jsStr(m["overview"]),
			"media":     mt,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsStr(items[i]["date"]) > jsStr(items[j]["date"])
	})

	// ④ owned 标记 + 库内 guid 回填
	ownedCount := 0
	for _, m := range items {
		tKey := m["media"].(string) + fmt.Sprintf("%v", m["id"].(int64))
		nZh := jsNormTitle(m["title"].(string))
		en := m["en"].(string)
		if ownedTmdb[tKey] || ownedTitles[nZh] || (en != "" && ownedTitles[jsNormTitle(en)]) {
			m["owned"] = true
			if g, ok := guidByTitle[nZh]; ok {
				m["guid"] = g.g
			} else if en != "" {
				if g, ok := guidByTitle[jsNormTitle(en)]; ok {
					m["guid"] = g.g
				}
			}
			ownedCount++
		}
	}
	return map[string]any{"ok": true, "name": name, "items": items, "ownedCount": ownedCount, "total": len(items)}
}

// personBriefUncached 演员简报（职业分类/生日/出生地/代表作前二；桌面版 fetchBriefUncached 同逻辑）。
func (b *Bridge) personBriefUncached(guid, cookie string) map[string]any {
	pd, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/person/"+guid, nil, cookie)
	if err != nil {
		return map[string]any{"error": "fnOS 请求失败：" + err.Error()}
	}
	person, _ := pd["data"].(map[string]any)
	imdbId := ""
	name := ""
	if person != nil {
		imdbId = jsFirstStr(person["imdbId"], person["imdb_id"])
		name = jsStr(person["name"])
	}
	brief := map[string]any{"ok": true, "name": name}
	if imdbId == "" {
		return brief
	}
	_, find, err := b.tmdbGet("/find/"+imdbId, map[string]string{"external_source": "imdb_id"})
	if err != nil {
		return brief // 简报尽力而为，失败不报错（桌面版同）
	}
	pid := ""
	if pr, _ := find["person_results"].([]any); len(pr) > 0 {
		if pm, ok := pr[0].(map[string]any); ok && pm["id"] != nil {
			pid = fmt.Sprintf("%v", int64(jsNum(pm["id"])))
		}
	}
	if pid == "" {
		return brief
	}
	_, per, err := b.tmdbGet("/person/"+pid, nil)
	if err == nil && per != nil {
		dep := jsStr(per["known_for_department"])
		if cn, ok := deptCN[dep]; ok {
			dep = cn
		}
		if dep != "" {
			brief["dept"] = dep
		}
		if v := jsStr(per["birthday"]); v != "" {
			brief["birthday"] = v
		}
		if v := jsStr(per["place_of_birth"]); v != "" {
			brief["place"] = v
		}
	}
	if _, cr, err := b.tmdbGet("/person/"+pid+"/combined_credits", nil); err == nil && cr != nil {
		if cast, _ := cr["cast"].([]any); len(cast) > 0 {
			type vc struct {
				title string
				count float64
			}
			var arr []vc
			for _, v := range cast {
				if m, ok := v.(map[string]any); ok {
					arr = append(arr, vc{jsFirstStr(m["title"], m["name"]), jsNum(m["vote_count"])})
				}
			}
			sort.SliceStable(arr, func(i, j int) bool { return arr[i].count > arr[j].count })
			if len(arr) > 2 {
				arr = arr[:2]
			}
			var top []string
			for _, it := range arr {
				if it.title == "" {
					continue
				}
				dup := false
				for _, t := range top {
					if t == it.title {
						dup = true
						break
					}
				}
				if !dup {
					top = append(top, it.title)
				}
			}
			if len(top) > 0 {
				brief["top"] = top
			}
		}
	}
	return brief
}

const personCreditsTTL = 6 * time.Hour
const personBriefTTL = 6 * time.Hour

// personCredits 演员页「TMDB 完整作品」POST {guid, cookie} → {ok, name, items, ownedCount, total}。
func (b *Bridge) personCredits(w http.ResponseWriter, r *http.Request) {
	req, errMsg := decodePersonReq(r)
	if errMsg != "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": errMsg})
		return
	}
	key := "ptmdb_credits_v1_" + req.GUID
	if c := personCacheGet(key); c != nil {
		writeJSON(w, http.StatusOK, c)
		return
	}
	out := b.personCreditsUncached(req.GUID, req.Cookie)
	if out["error"] == nil {
		personCacheSet(key, out, personCreditsTTL) // 失败结果不缓存（桌面版同语义）
	}
	writeJSON(w, http.StatusOK, out)
}

// personBrief 演员简报 POST {guid, cookie} → {ok, name, dept?, birthday?, place?, top?}。
func (b *Bridge) personBrief(w http.ResponseWriter, r *http.Request) {
	req, errMsg := decodePersonReq(r)
	if errMsg != "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": errMsg})
		return
	}
	key := "ptmdb_brief_v1_" + req.GUID
	if c := personCacheGet(key); c != nil {
		writeJSON(w, http.StatusOK, c)
		return
	}
	out := b.personBriefUncached(req.GUID, req.Cookie)
	if out["error"] == nil {
		personCacheSet(key, out, personBriefTTL)
	}
	writeJSON(w, http.StatusOK, out)
}
