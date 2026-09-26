// Package bridge —— doubansync.go：豆瓣「在看/看过」标记同步。
// 忠实移植桌面版 doubanSync.ts 的写入链：
//   - markInterest：POST movie.douban.com/j/subject/{id}/interest（ck CSRF + interest=do/collect）
//   - ck 获取：cookie 内 ck → 会话缓存 → 拉条目页从 Set-Cookie/HTML 解析
//   - douban_id 解析：条目自带 douban_id → 标题搜索（subject_suggest JSON + 搜索页 HTML 兜底，
//     标题包含+年份+类型打分取最优），系列级缓存（剧名|类型|年代 → id）防风控限流
//   - 进度同步语义：首次有效进度（媒体有真实时长）标"在看"；飞牛侧已观看则直接标"看过"
//     且绝不降级；"标记为已观看"动作 → 标"看过"
// cookie 来自设置面板手动粘贴的 doubanCookie（网页端无内嵌浏览器登录途径）。
// 触发器：preload/web/playSync.ts 拦截页面自身 /v/api/v1/play/record 与 /v/api/v1/item/watched。
package bridge

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* ── 会话状态（进程内存；重启即清，豆瓣端重复标记幂等无害）── */

var (
	doubanStateMu  sync.RWMutex
	doubanStateMap = map[string]string{}   // itemGuid → "doing" | "collect"
	doubanSeriesMu sync.RWMutex
	doubanSeriesMuCache = map[string]string{} // "剧名|类型|年代" → douban_id（系列级，防每集搜索触发风控）
	doubanCkMu      sync.Mutex
	doubanCkCached  string                  // 会话内 ck 缓存
	doubanGateCh    = make(chan struct{}, 2) // 豆瓣请求并发闸门（防风控限流）
)

func doubanStateGet(guid string) string {
	doubanStateMu.RLock()
	defer doubanStateMu.RUnlock()
	return doubanStateMap[guid]
}

func doubanStateSet(guid, st string) {
	doubanStateMu.Lock()
	defer doubanStateMu.Unlock()
	doubanStateMap[guid] = st
}

func doubanSeriesGet(key string) string {
	doubanSeriesMu.RLock()
	defer doubanSeriesMu.RUnlock()
	return doubanSeriesMuCache[key]
}

func doubanSeriesSet(key, id string) {
	doubanSeriesMu.Lock()
	defer doubanSeriesMu.Unlock()
	doubanSeriesMuCache[key] = id
}

/* ── 豆瓣 HTTP 工具 ── */

const doubanWebUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

// doubanGet 带登录 cookie 的豆瓣 GET（过并发闸门）。
func doubanGet(url string, cookie string) (int, string, http.Header, error) {
	doubanGateCh <- struct{}{}
	defer func() { <-doubanGateCh }()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("User-Agent", doubanWebUA)
	req.Header.Set("Referer", "https://movie.douban.com/")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	return resp.StatusCode, string(data), resp.Header, nil
}

// doubanPostForm 带登录 cookie 的豆瓣 POST（表单）。
func doubanPostForm(url string, body string, cookie string, referer string) (int, string, error) {
	doubanGateCh <- struct{}{}
	defer func() { <-doubanGateCh }()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	req.Header.Set("Referer", referer)
	req.Header.Set("Cookie", cookie)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("User-Agent", doubanWebUA)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	return resp.StatusCode, string(data), nil
}

/* ── ck（CSRF 令牌）── */

var reCkFromCookie = regexp.MustCompile(`(?i)(?:^|;\s*)ck=([^;]+)`)
var reCkMeta = regexp.MustCompile(`(?i)<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']`)
var reCkInput = regexp.MustCompile(`(?i)name=["']ck["'][^>]*value=["']([^"']+)["']`)
var reCkInline = regexp.MustCompile(`["']ck["']\s*[:=]\s*["']([a-zA-Z0-9_\-]+)["']`)

// doubanExtractCk 从 cookie 字符串提取 ck。
func doubanExtractCk(cookie string) string {
	if m := reCkFromCookie.FindStringSubmatch(cookie); len(m) > 1 {
		return m[1]
	}
	return ""
}

// doubanFetchCk 拉条目页，从 Set-Cookie 或 HTML 解析 ck（扫码 cookie 常不含 ck 的兜底）。
func doubanFetchCk(subjectID, cookie string) string {
	st, _, header, err := doubanGet("https://movie.douban.com/subject/"+subjectID+"/", cookie)
	if err != nil {
		return ""
	}
	_ = st
	if sc := header.Values("Set-Cookie"); len(sc) > 0 {
		for _, c := range sc {
			if m := regexp.MustCompile(`ck=([^;]+)`).FindStringSubmatch(c); len(m) > 1 {
				if dec, derr := url.QueryUnescape(m[1]); derr == nil {
					return dec
				}
				return m[1]
			}
		}
	}
	return ""
}

// doubanGetCk ck 获取：① 会话缓存 ② cookie 内 ③ 拉条目页解析。
func (b *Bridge) doubanGetCk(subjectID, cookie string) string {
	doubanCkMu.Lock()
	defer doubanCkMu.Unlock()
	if doubanCkCached != "" {
		return doubanCkCached
	}
	if ck := doubanExtractCk(cookie); ck != "" {
		doubanCkCached = ck
		return ck
	}
	fetched := doubanFetchCk(subjectID, cookie)
	if fetched != "" {
		doubanCkCached = fetched
	}
	return fetched
}

/* ── 标记（在看/看过）── */

// doubanMarkInterest POST /j/subject/{id}/interest。
func (b *Bridge) doubanMarkInterest(subjectID, interest, cookie string) (bool, string, bool) {
	ck := b.doubanGetCk(subjectID, cookie)
	body := "ck=" + url.QueryEscape(ck) + "&interest=" + interest + "&rating=&foldcollect=F&tags=&comment="
	st, data, err := doubanPostForm(
		"https://movie.douban.com/j/subject/"+subjectID+"/interest",
		body, cookie, "https://movie.douban.com/subject/"+subjectID+"/")
	if err != nil {
		return false, err.Error(), false
	}
	// 豆瓣异常时可能返回登录页/错误页 HTML（HTTP 200），按失败处理
	if strings.Contains(data, "<html") || strings.Contains(data, "<body") {
		return false, "豆瓣返回 HTML（疑似 cookie 失效或风控）", false
	}
	var out map[string]any
	if jerr := json.Unmarshal([]byte(data), &out); jerr == nil {
		if s, _ := out["status"].(string); s == "success" {
			return true, "", false
		}
		if r, ok := out["r"].(float64); ok && r == 0 {
			return true, "", false
		}
		// [v1.4.3] {"r":1,"code":403}（HTTP 200）= ck 无效/风控拒——实测假 ck 即此形态。
		// 旧版落到"HTTP 200 ..."当作普通失败还重试一次；识别为 cookie 失效立即止损。
		if r, ok := out["r"].(float64); ok && r != 0 {
			if code, ok := out["code"].(float64); ok && code == 403 {
				doubanCkMu.Lock()
				doubanCkCached = ""
				doubanCkMu.Unlock()
				return false, "cookie 失效（豆瓣 code 403），请重新粘贴", true
			}
		}
		if st == http.StatusUnauthorized || st == http.StatusForbidden || strings.Contains(data, "please login") || strings.Contains(data, "please_login") {
			doubanCkMu.Lock()
			doubanCkCached = ""
			doubanCkMu.Unlock()
			return false, "cookie 失效，请重新粘贴", true
		}
		raw := data
		if len(raw) > 300 {
			raw = raw[:300]
		}
		if msg, ok := out["message"].(string); ok && msg != "" {
			return false, msg, false
		}
		if msg, ok := out["msg"].(string); ok && msg != "" {
			return false, msg, false
		}
		return false, "HTTP " + strconv.Itoa(st) + " " + raw, false
	}
	// 非 JSON（字符串体）
	if strings.Contains(data, "success") {
		return true, "", false
	}
	return false, "HTTP " + strconv.Itoa(st) + " " + data[:minInt(len(data), 200)], false
}

// doubanMarkWithRetry 标记 + 失败重试 1 次（cookie 失效不重试）。
// [v1.4.3] 返回最终是否标记成功——调用方据实写状态/回报，不再失败也谎报成功。
func (b *Bridge) doubanMarkWithRetry(subjectID, interest, cookie string) bool {
	for i := 0; i <= 1; i++ {
		ok, _, expired := b.doubanMarkInterest(subjectID, interest, cookie)
		if ok {
			return true
		}
		if expired {
			return false
		}
		if i == 0 {
			time.Sleep(800 * time.Millisecond)
		}
	}
	return false
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

/* ── douban_id 解析 ── */

var reDoubanSubjectLink = regexp.MustCompile(`movie\.douban\.com/subject/(\d+)`)

// doubanBuildSearchQuery 标题（去尾部年代括号）。
func doubanBuildSearchQuery(item map[string]any) string {
	q := jsFirstStr(item["tv_title"], item["parent_title"], item["title"])
	q = strings.TrimSpace(q)
	re := regexp.MustCompile(`\s*[（(]\s*\d{4}\s*[）)]?\s*$`)
	q = strings.TrimSpace(re.ReplaceAllString(q, ""))
	return q
}

// doubanPickBestSubject 标题包含 + 年份 + 类型打分取最优（桌面版 pickBestSubject 同规则）。
func doubanPickBestSubject(arr []any, query, wantType, year string) string {
	q := strings.ToLower(query)
	bestID := ""
	bestScore := -1
	for _, v := range arr {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		s := 0
		t := strings.ToLower(jsStr(m["title"]))
		if t == q {
			s += 5
		} else if t != "" && (strings.Contains(t, q) || strings.Contains(q, t)) {
			s += 2
		}
		y := jsStr(m["year"])
		if y != "" && year != "" && y == year {
			s += 3
		}
		if mt := jsStr(m["type"]); mt != "" && mt == wantType {
			s += 2
		}
		if s > bestScore {
			bestScore = s
			bestID = jsStr(m["id"])
		}
	}
	if bestID != "" && bestScore >= 2 {
		return bestID
	}
	return ""
}

// doubanSearchByTitle 标题搜索：subject_suggest JSON → 搜索页 HTML 兜底。
func (b *Bridge) doubanSearchByTitle(query, wantType, year, cookie string) string {
	// 1) 自动补全接口（JSON）
	st, data, _, err := doubanGet("https://movie.douban.com/j/subject_suggest?q="+url.QueryEscape(query), cookie)
	if err == nil && st == http.StatusOK {
		var arr []any
		if json.Unmarshal([]byte(data), &arr) == nil {
			if id := doubanPickBestSubject(arr, query, wantType, year); id != "" {
				return id
			}
		}
	}
	// 2) 搜索页 HTML 兜底
	st2, html, _, err2 := doubanGet("https://www.douban.com/search?cat=1002&q="+url.QueryEscape(query), cookie)
	if err2 == nil && st2 == http.StatusOK {
		if m := reDoubanSubjectLink.FindStringSubmatch(html); len(m) > 1 {
			return m[1]
		}
	}
	return ""
}

// doubanBuildSeriesKey 系列级缓存 key：剧名|类型|年代。
func doubanBuildSeriesKey(item map[string]any) string {
	q := doubanBuildSearchQuery(item)
	if q == "" {
		return ""
	}
	wantType := "tv"
	if strings.EqualFold(jsStr(item["type"]), "Movie") {
		wantType = "movie"
	}
	year := jsFirstStr(item["release_date"], item["air_date"])
	if len(year) > 4 {
		year = year[:4]
	}
	return q + "|" + wantType + "|" + year
}

// doubanResolveID douban_id 解析：条目自带 → 系列缓存 → 标题搜索。
func (b *Bridge) doubanResolveID(item map[string]any, cookie string) string {
	seriesKey := doubanBuildSeriesKey(item)
	if seriesKey != "" {
		if id := doubanSeriesGet(seriesKey); id != "" {
			return id
		}
	}
	// 1) 条目直接字段（飞牛刮削到的豆瓣号）
	for _, k := range []string{"douban_id", "doubanId"} {
		if s := strings.TrimSpace(jsStr(item[k])); s != "" {
			if seriesKey != "" {
				doubanSeriesSet(seriesKey, s)
			}
			return s
		}
		if n := jsNum(item[k]); n > 0 {
			s := strconv.FormatInt(int64(n), 10)
			if seriesKey != "" {
				doubanSeriesSet(seriesKey, s)
			}
			return s
		}
	}
	// 2) 标题搜索兜底（需 cookie）
	if cookie == "" {
		return ""
	}
	query := doubanBuildSearchQuery(item)
	if query == "" {
		return ""
	}
	wantType := "tv"
	if strings.EqualFold(jsStr(item["type"]), "Movie") {
		wantType = "movie"
	}
	year := jsFirstStr(item["release_date"], item["air_date"])
	if len(year) > 4 {
		year = year[:4]
	}
	id := b.doubanSearchByTitle(query, wantType, year, cookie)
	if id != "" && seriesKey != "" {
		doubanSeriesSet(seriesKey, id)
	}
	return id
}

/* ── 同步入口（HTTP handler）── */

// doubanSyncProgress {guid, percentage, item, duration}：播放进度 → 豆瓣标「在看」；
// 飞牛侧已观看（is_watched=1）→ 直接标「看过」且绝不降级。语义对齐桌面版 syncOnProgress。
func (b *Bridge) doubanSyncProgress(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GUID       string         `json:"guid"`
		Percentage float64        `json:"percentage"`
		Duration   float64        `json:"duration"`
		Item       map[string]any `json:"item"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req)
	if getSetting(b.cfg, "doubanEnabled") != "1" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "豆瓣同步未开启"})
		return
	}
	cookie := strings.TrimSpace(getSetting(b.cfg, "doubanCookie"))
	if cookie == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "未配置豆瓣 Cookie"})
		return
	}
	if req.GUID == "" || req.Item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少条目信息"})
		return
	}
	state := doubanStateGet(req.GUID)
	if state == "collect" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标看过，跳过"})
		return
	}
	alreadyWatched := jsNum(req.Item["is_watched"]) == 1
	mediaValid := req.Duration > 0
	if !mediaValid {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "媒体时长无效，跳过"})
		return
	}
	subjectID := b.doubanResolveID(req.Item, cookie)
	if subjectID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "无法解析 douban_id（标题搜索无匹配或未配 Cookie）"})
		return
	}
	if alreadyWatched {
		if state != "collect" {
			if b.doubanMarkWithRetry(subjectID, "collect", cookie) {
				doubanStateSet(req.GUID, "collect")
				writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标记看过（飞牛侧已观看）", "subject_id": subjectID})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "标记看过失败（cookie 可能失效或被风控），稍后重试", "subject_id": subjectID})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标看过，跳过"})
		return
	}
	if state == "" {
		if b.doubanMarkWithRetry(subjectID, "do", cookie) {
			doubanStateSet(req.GUID, "doing")
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标记在看", "subject_id": subjectID})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "标记在看失败（cookie 可能失效或被风控），稍后重试", "subject_id": subjectID})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标在看，跳过"})
}

// doubanSyncWatched {guid, item}：飞牛「标记为已观看」→ 豆瓣标「看过」。
// 语义对齐桌面版 syncOnWatched（session 拦截 /v/api/v1/item/watched 后触发）。
func (b *Bridge) doubanSyncWatched(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GUID string         `json:"guid"`
		Item map[string]any `json:"item"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req)
	if getSetting(b.cfg, "doubanEnabled") != "1" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "豆瓣同步未开启"})
		return
	}
	cookie := strings.TrimSpace(getSetting(b.cfg, "doubanCookie"))
	if cookie == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "未配置豆瓣 Cookie"})
		return
	}
	if req.GUID == "" || req.Item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少条目信息"})
		return
	}
	if doubanStateGet(req.GUID) == "collect" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标看过，跳过"})
		return
	}
	subjectID := b.doubanResolveID(req.Item, cookie)
	if subjectID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "无法解析 douban_id（标题搜索无匹配或未配 Cookie）"})
		return
	}
	// [v1.4.3] 按真实结果写状态：失败不写 collect（换有效 cookie 后下次上报还能补标），
	// 且把失败如实回给前端（旧版失败也写状态+谎报"已标记看过"，状态被永久污染）。
	if b.doubanMarkWithRetry(subjectID, "collect", cookie) {
		doubanStateSet(req.GUID, "collect")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已标记看过", "subject_id": subjectID})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "标记看过失败（cookie 可能失效或被风控），稍后重试", "subject_id": subjectID})
}
