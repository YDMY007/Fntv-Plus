// Package bridge —— hot.go：「热门剧更新」浮层三个数据源（TMDB / 豆瓣 / 豆瓣海报代理）
// + Bangumi 每日放送。忠实移植桌面版：
//   - tmdbSync.ts fetchDiscover（tmdb:discover）
//   - doubanHot.ts fetchDiscover / fetchImageAsDataUrl（douban:discover / douban:image）
//   - bangumiSync.ts fetchCalendar（bangumi:calendar）
//
// 返回结构与桌面版完全对齐（{ok, items, warning?} / {ok, dataUrl}），hotUpdates.ts 渲染零改动复用。
// [lc-051] 网页端此前三个源全无数据：tmdb:discover / douban:discover 通道未移植（shim 兜底 undefined），
// bangumi:calendar 后端只透传原始数组、前端期望 {ok, items} 形状不匹配。
package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const tmdbImgBase = "https://image.tmdb.org/t/p/w500"

const doubanRexxar = "https://m.douban.com/rexxar/api/v2/subject_collection"
const doubanMobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
const doubanReferer = "https://m.douban.com/movie/"
const doubanDesktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const doubanWebReferer = "https://movie.douban.com/"

const bangumiUAWeb = "YDMY007/Fntv-Plus/Web (https://github.com/YDMY007/Fntv-Plus)"

/* ── 通用小工具 ── */

// jsStr 取字符串字段（非字符串返回空串）。
func jsStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// jsFirstStr 依次取第一个非空字符串。
func jsFirstStr(vals ...any) string {
	for _, v := range vals {
		if s := jsStr(v); s != "" {
			return s
		}
	}
	return ""
}

// jsNum 取数值字段（JSON 反序列化后数字均为 float64，其余类型返回 0）。
func jsNum(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return 0
}

// jsYearOf 从 YYYY-MM-DD 日期取年份。
func jsYearOf(date string) string {
	if len(date) >= 4 {
		return date[:4]
	}
	return ""
}

// jsSumNumeric collection 兼容数字 / 对象（{wish,collect,...} 所有数值求和）两种形态（桌面版 sumNumeric）。
func jsSumNumeric(raw json.RawMessage) float64 {
	if len(raw) == 0 {
		return 0
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err == nil {
		s := 0.0
		for _, v := range m {
			s += jsNum(v)
		}
		return s
	}
	return 0
}

// describeTmdbStatus 桌面版 describeTmdbError 的 Go 精简版（401/429/超时 → 用户友好文案）。
func describeTmdbStatus(status int, err error) string {
	switch status {
	case 401:
		return "TMDB Key 无效或无访问权限，请检查设置面板填写的 Key。"
	case 429:
		return "TMDB 请求过于频繁（触发限速），请稍后再试。"
	}
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "timeout") || strings.Contains(msg, "Timeout") || strings.Contains(msg, "Client.Timeout") {
			return "TMDB 请求超时：后端无法连接 api.themoviedb.org。可在设置开启「免梯子直连」或配置自定义代理后重试。"
		}
		return msg
	}
	return ""
}

/* ── TMDB 源 ── */

// hotNormalizeTMDB 归一化为与 Bangumi 卡片共享的渲染字段（桌面版 tmdbSync.ts normalize 同形状）。
func hotNormalizeTMDB(raw map[string]any, mediaType string) map[string]any {
	var title, date string
	if mediaType == "movie" {
		title = jsFirstStr(raw["title"], raw["original_title"])
		date = jsStr(raw["release_date"])
	} else {
		title = jsFirstStr(raw["name"], raw["original_name"])
		date = jsStr(raw["first_air_date"])
	}
	poster := ""
	if p := jsStr(raw["poster_path"]); p != "" {
		poster = tmdbImgBase + p
	}
	return map[string]any{
		"id":         raw["id"],
		"mediaType":  mediaType,
		"name":       title,
		"name_cn":    title,
		"images":     map[string]any{"common": poster},
		"rating":     jsNum(raw["vote_average"]),
		"year":       jsYearOf(date),
		"popularity": jsNum(raw["popularity"]),
		"overview":   jsStr(raw["overview"]),
		"url":        fmt.Sprintf("https://www.themoviedb.org/%s/%v", mediaType, raw["id"]),
	}
}

// tmdbDiscover 每日放送 TMDB 源（桌面版 fetchDiscover）：/discover/movie + /discover/tv 并行，
// 合并去重按 popularity 排序 → {ok, items, warning?}。需已配置 TMDB Key（v3/v4 双格式自动适配）。
func (b *Bridge) tmdbDiscover(w http.ResponseWriter, r *http.Request) {
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key，请在设置面板填写。"})
		return
	}
	type resT struct {
		raws   []map[string]any
		status int
		err    error
	}
	ch := make(chan resT, 2)
	fetch := func(path string) {
		// [v0.63.0] 每路失败重试一次（经代理偶发超时/限流；桌面版 getWithRetry 同语义）
		var raws []map[string]any
		var status int
		var err error
		for attempt := 0; attempt < 2; attempt++ {
			st, out, e := b.tmdbGet(path, map[string]string{"sort_by": "popularity.desc", "page": "1"})
			if e == nil {
				list, _ := out["results"].([]any)
				raws = make([]map[string]any, 0, len(list))
				for _, v := range list {
					if m, ok := v.(map[string]any); ok {
						raws = append(raws, m)
					}
				}
				ch <- resT{raws, st, nil}
				return
			}
			status, err = st, e
			if attempt == 0 {
				time.Sleep(600 * time.Millisecond)
			}
		}
		ch <- resT{nil, status, err}
	}
	go fetch("/discover/movie")
	go fetch("/discover/tv")
	movie := <-ch
	tv := <-ch

	items := []map[string]any{}
	seen := map[string]bool{}
	add := func(raws []map[string]any, mt string) {
		for _, m := range raws {
			if m["id"] == nil {
				continue
			}
			key := fmt.Sprintf("%v_%s", m["id"], mt)
			if seen[key] {
				continue
			}
			seen[key] = true
			items = append(items, hotNormalizeTMDB(m, mt))
		}
	}
	add(movie.raws, "movie")
	add(tv.raws, "tv")

	if len(items) == 0 {
		// 两源全失败 → 细化错误（Key 无效 / 限速 / 网络超时）
		err := movie.err
		st := movie.status
		if err == nil {
			err = tv.err
			st = tv.status
		}
		msg := describeTmdbStatus(st, err)
		if msg == "" {
			msg = "TMDB 数据获取失败。"
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	out := map[string]any{"ok": true, "items": items}
	if movie.err != nil || tv.err != nil {
		out["warning"] = "部分数据源（电影 / 剧集）获取失败，已显示可用部分。"
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["popularity"]) > jsNum(items[j]["popularity"])
	})
	writeJSON(w, http.StatusOK, out)
}

/* ── 豆瓣源 ── */

// hotNormalizeDouban 归一化为与 TMDB 卡片共享的渲染字段（桌面版 doubanHot.ts normalize 同形状）。
func hotNormalizeDouban(raw map[string]any, mediaType string) map[string]any {
	title := jsFirstStr(raw["title"], raw["original_title"], raw["name"])
	// 封面字段名不一致：电影用 cover.url；剧集用 pic.large / pic.normal（Rexxar 不同 collection 字段不同）
	cover := ""
	if m, ok := raw["cover"].(map[string]any); ok {
		cover = jsStr(m["url"])
	}
	if cover == "" {
		switch pic := raw["pic"].(type) {
		case map[string]any:
			cover = jsFirstStr(pic["large"], pic["normal"])
		case string:
			cover = pic
		}
	}
	rating, pop := 0.0, 0.0
	if m, ok := raw["rating"].(map[string]any); ok {
		rating = jsNum(m["value"])
		pop = jsNum(m["count"]) // Rexxar 无 popularity，用评价人数近似热度
	}
	return map[string]any{
		"id":        raw["id"],
		"mediaType": mediaType,
		"name":      title,
		"name_cn":   title,
		"images":    map[string]any{"common": cover},
		"rating":    rating,
		"year":      jsStr(raw["year"]),
		"popularity": pop,
		"overview":  "",
		"url":       fmt.Sprintf("https://movie.douban.com/subject/%v", raw["id"]),
	}
}

// doubanDiscover 每日放送豆瓣源（桌面版 doubanHot.ts fetchDiscover）：
// Rexxar 半公开接口（免 Key、国内直连），movie_hot_gaia + tv_hot 并行合并 → {ok, items, warning?}。
func (b *Bridge) doubanDiscover(w http.ResponseWriter, r *http.Request) {
	type resT struct {
		raws []map[string]any
		err  error
	}
	ch := make(chan resT, 2)
	client := &http.Client{Timeout: 20 * time.Second}
	fetch := func(col string) {
		req, _ := http.NewRequest(http.MethodGet, doubanRexxar+"/"+col+"/items?start=0&count=20", nil)
		req.Header.Set("User-Agent", doubanMobileUA)
		req.Header.Set("Referer", doubanReferer)
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			ch <- resT{nil, err}
			return
		}
		defer resp.Body.Close()
		var out struct {
			Items []map[string]any `json:"subject_collection_items"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out); err != nil {
			ch <- resT{nil, fmt.Errorf("HTTP %d：%v", resp.StatusCode, err)}
			return
		}
		ch <- resT{out.Items, nil}
	}
	go fetch("movie_hot_gaia")
	go fetch("tv_hot")
	movie := <-ch
	tv := <-ch

	items := []map[string]any{}
	seen := map[string]bool{}
	add := func(raws []map[string]any, mt string) {
		for _, m := range raws {
			if m["id"] == nil {
				continue
			}
			key := fmt.Sprintf("%v", m["id"])
			if seen[key] {
				continue
			}
			seen[key] = true
			items = append(items, hotNormalizeDouban(m, mt))
		}
	}
	add(movie.raws, "movie")
	add(tv.raws, "tv")

	if len(items) == 0 {
		err := movie.err
		if err == nil {
			err = tv.err
		}
		msg := "豆瓣数据获取失败。"
		if err != nil {
			msg = "豆瓣数据获取失败：" + err.Error()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	out := map[string]any{"ok": true, "items": items}
	if movie.err != nil || tv.err != nil {
		out["warning"] = "部分数据源（电影 / 剧集）获取失败，已显示可用部分。"
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["popularity"]) > jsNum(items[j]["popularity"])
	})
	writeJSON(w, http.StatusOK, out)
}

// doubanImage 豆瓣海报代理（桌面版 fetchImageAsDataUrl）：imgX.doubanio.com 有防盗链（缺 Referer 返回 418），
// 带桌面 UA + Referer 拉图转 dataUrl，仅允许 doubanio.com 域名。
func (b *Bridge) doubanImage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || !strings.HasSuffix(strings.ToLower(u.Hostname()), "doubanio.com") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "仅支持豆瓣图片域名（doubanio.com）"})
		return
	}
	req, _ := http.NewRequest(http.MethodGet, raw, nil)
	req.Header.Set("User-Agent", doubanDesktopUA)
	req.Header.Set("Referer", doubanWebReferer)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": fmt.Sprintf("upstream %d", resp.StatusCode)})
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/jpeg"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"dataUrl": "data:" + ct + ";base64," + b64encode(data),
	})
}

/* ── Bangumi 每日放送 ── */

// fetchWithTransport 桌面版 withTransport 的 Go 版（代理 > 直连）：
// 配置了自定义代理(http/https)则先走代理（NAS 直连 bgm.tv 等外网源常超时），失败再用直连兜底重试。
// 非 200 也视为该路失败继续尝试下一路；返回 body 字节或带传输方式的错误。
func (b *Bridge) fetchWithTransport(rawURL, ua string) ([]byte, error) {
	type attempt struct {
		c   *http.Client
		via string
	}
	attempts := []attempt{{&http.Client{Timeout: 8 * time.Second}, "直连"}}
	if proxy := b.customProxyURL(); proxy != "" {
		pu, _ := url.Parse(proxy)
		attempts = append([]attempt{{&http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}, "自定义代理"}}, attempts...)
	}
	var lastErr error
	for _, a := range attempts {
		req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
		if ua != "" {
			req.Header.Set("User-Agent", ua)
		}
		resp, err := a.c.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("%s：%v", a.via, err)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("%s：%v", a.via, readErr)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s返回 HTTP %d", a.via, resp.StatusCode)
			continue
		}
		return data, nil
	}
	return nil, lastErr
}

// bangumiCalendar 每日放送 Bangumi 源（桌面版 fetchCalendar 同款）：
// 拉 /calendar（fetchWithTransport：代理优先+直连兜底，对齐桌面版 withTransport）→ 展平
// → 过滤（动画 type=2 / 三次元 type=6）→ 组装 → 同 id 去重（保留收藏更高）
// → 按收藏数+评分排序 → {ok, items}。此前只透传原始数组，前端期望 {ok, items} 形状不匹配致无数据。
func (b *Bridge) bangumiCalendar(w http.ResponseWriter, r *http.Request) {
	data, err := b.fetchWithTransport("https://api.bgm.tv/calendar", bangumiUAWeb)
	if err != nil {
		msg := "Bangumi 请求失败：" + err.Error()
		if b.customProxyURL() == "" {
			msg += "。NAS 直连 api.bgm.tv 超时，可在设置「自定义代理」配置 http(s) 代理并保存后重试。"
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	var days []bgmDay
	if err := json.Unmarshal(data, &days); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Bangumi 数据解析失败：" + err.Error()})
		return
	}
	items := []map[string]any{}
	idx := map[int64]int{}
	for _, day := range days {
		for _, it := range day.Items {
			if it.ID == 0 {
				continue
			}
			if it.Type != nil && *it.Type != 2 && *it.Type != 6 {
				continue // 只要动画 / 三次元剧集
			}
			var score float64
			var total int
			if it.Rating != nil {
				if it.Rating.Score != nil {
					score = *it.Rating.Score
				}
				if it.Rating.Total != nil {
					total = *it.Rating.Total
				}
			}
			wd := day.Weekday.ID
			if it.AirWeekday != nil {
				wd = *it.AirWeekday
			}
			m := map[string]any{
				"id": it.ID, "name": it.Name, "name_cn": it.NameCN,
				"images": it.Images, "summary": it.Summary, "air_date": it.AirDate,
				"air_weekday": wd, "weekdayCn": day.Weekday.CN, "eps": it.Eps,
				"rating": score, "ratingTotal": total,
				"collectionTotal": jsSumNumeric(it.Collection),
				"url":             fmt.Sprintf("https://bgm.tv/subject/%d", it.ID),
			}
			if i, ok := idx[it.ID]; ok {
				// 同条目可能出现在多天（罕见），保留收藏数更高的版本
				if jsNum(m["collectionTotal"]) > jsNum(items[i]["collectionTotal"]) {
					items[i] = m
				}
			} else {
				idx[it.ID] = len(items)
				items = append(items, m)
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		ci, cj := jsNum(items[i]["collectionTotal"]), jsNum(items[j]["collectionTotal"])
		if ci != cj {
			return ci > cj
		}
		return jsNum(items[i]["rating"]) > jsNum(items[j]["rating"])
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": items})
}

type bgmDay struct {
	Weekday struct {
		ID int    `json:"id"`
		CN string `json:"cn"`
	} `json:"weekday"`
	Items []bgmItem `json:"items"`
}

type bgmItem struct {
	ID         int64           `json:"id"`
	Type       *int            `json:"type"`
	Name       string          `json:"name"`
	NameCN     string          `json:"name_cn"`
	Images     json.RawMessage `json:"images"`
	Summary    string          `json:"summary"`
	AirDate    string          `json:"air_date"`
	AirWeekday *int            `json:"air_weekday"`
	Eps        *int            `json:"eps"`
	Rating     *struct {
		Score *float64 `json:"score"`
		Total *int     `json:"total"`
	} `json:"rating"`
	Collection json.RawMessage `json:"collection"`
}
