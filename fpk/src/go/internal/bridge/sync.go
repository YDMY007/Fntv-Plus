// Package bridge —— sync.go：豆瓣观影记录/详情补全 + Bangumi 同步核心（桌面版忠实移植）。
package bridge

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// fnItem fnOS 媒体条目（只取用到的字段，JSON 容错解析）。
type fnItem struct {
	GUID              string  `json:"guid"`
	ParentGUID        string  `json:"parent_guid"`
	Title             string  `json:"title"`
	ParentTitle       string  `json:"parent_title"`
	TVTitle           string  `json:"tv_title"`
	Type              string  `json:"type"`
	TrimID            string  `json:"trim_id"`
	DoubanID          string  `json:"douban_id"`
	Watched           int     `json:"watched"`
	WatchedTS         float64 `json:"watched_ts"`
	Duration          float64 `json:"duration"`
	Runtime           float64 `json:"runtime"`
	SeasonNumber      int64   `json:"season_number"`
	EpisodeNumber     int64   `json:"episode_number"`
	ParentIndexNumber int64   `json:"parent_index_number"`
	IndexNumber       int64   `json:"index_number"`
	VoteAverage       float64 `json:"vote_average"`
	AirDate           string  `json:"air_date"`
	ReleaseDate       string  `json:"release_date"`
}

// doubanWatched POST {cookie, force}：忠实移植桌面版 getWatchedItems——
// item/list 全库 → 6 并发逐项钻取（季→集，累加时长+统计已看）→ 仅保留有观看记录者 →
// buildLocalWatchItem 形状（列表页只展示本地播放记录，TMDB/豆瓣评分留给 enrich 按需查）。
func (b *Bridge) doubanWatched(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cookie string `json:"cookie"`
		Force  bool   `json:"force"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if req.Cookie == "" {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "libraryTotal": 0, "note": "缺少登录 cookie"})
		return
	}
	listBody, _ := json.Marshal(map[string]any{
		"parent_guid": "", "exclude_folder": 1,
		"sort_column": "sort_title", "sort_type": "ASC",
	})
	fnCall := browserFnOSCall(r, req.Cookie)
	resp, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", listBody, fnCall)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "libraryTotal": 0, "note": err.Error()})
		return
	}
	data, _ := resp["data"].(map[string]any)
	rawList, _ := data["list"].([]any)
	libraryTotal := len(rawList)
	if t, ok := data["total"].(float64); ok && int(t) > len(rawList) {
		libraryTotal = int(t)
	}
	type pair struct {
		it fnItem
		a  analyzeResult
	}
	results := make([]pair, len(rawList))
	// 6 并发钻取（与桌面版 mapLimit(list, 6) 一致）
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for i, raw := range rawList {
		wg.Add(1)
		var it fnItem
		bts, _ := json.Marshal(raw)
		_ = json.Unmarshal(bts, &it)
		go func(idx int, it fnItem) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[idx] = pair{it: it, a: b.analyzeItem(it, fnCall)}
		}(i, it)
	}
	wg.Wait()
	out := []map[string]any{}
	for _, p := range results {
		if p.a.AnyWatch {
			out = append(out, buildLocalWatchItem(p.it, p.a))
		}
	}
	done := 0
	for _, m := range out {
		if v, ok := m["progress"].(float64); ok && v >= 1 {
			done++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "items": out, "libraryTotal": libraryTotal, "watchedCount": done,
	})
}

// analyzeResult 单项观看分析结果。
type analyzeResult struct {
	TotalRuntimeMS int64
	Progress       float64
	AnyWatch       bool
	Started        bool
	LastPlayed     int64
}

// analyzeItem 忠实移植桌面版：电影看 watched/watched_ts；剧集钻取 季→集 累加时长+统计已看。
func (b *Bridge) analyzeItem(it fnItem, call fnOSCall) analyzeResult {
	empty := analyzeResult{}
	lpMs := int64(0)
	if it.WatchedTS > 0 {
		lpMs = int64(it.WatchedTS * 1000)
	}
	t := strings.ToLower(it.Type)
	if t == "movie" {
		totalSec := it.Duration
		if totalSec <= 0 && it.Runtime > 0 {
			totalSec = it.Runtime * 60
		}
		rtMS := int64(totalSec * 1000)
		if it.Watched == 1 {
			return analyzeResult{rtMS, 1, true, false, lpMs}
		}
		if it.WatchedTS > 0 {
			return analyzeResult{rtMS, 0, true, true, lpMs}
		}
		return empty
	}
	totalSec, totalEp, watchedEp := 0.0, 0, 0
	addLeaf := func(leaf fnItem) {
		if leaf.Duration > 0 {
			totalSec += leaf.Duration
		} else if leaf.Runtime > 0 {
			totalSec += leaf.Runtime * 60
		}
		totalEp++
		if leaf.Watched == 1 {
			watchedEp++
		}
	}
	childrenBody, _ := json.Marshal(map[string]any{
		"parent_guid": it.GUID, "exclude_folder": 1,
		"sort_column": "sort_title", "sort_type": "ASC",
	})
	if children, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", childrenBody, call); err == nil {
		if cd, ok := children["data"].(map[string]any); ok {
			if cl, ok := cd["list"].([]any); ok {
				for _, raw := range cl {
					bts, _ := json.Marshal(raw)
					var c fnItem
					_ = json.Unmarshal(bts, &c)
					ct := strings.ToLower(c.Type)
					if ct == "episode" || ct == "movie" {
						addLeaf(c)
					} else if eps, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/episode/list/"+c.GUID, nil, call); err == nil {
						if el, ok := eps["data"].([]any); ok {
							for _, er := range el {
								b2, _ := json.Marshal(er)
								var leaf fnItem
								_ = json.Unmarshal(b2, &leaf)
								addLeaf(leaf)
							}
						}
					}
				}
			}
		}
	}
	// 兜底：单层剧集结构（子级钻取无果时 episode/list/{本条目}）
	if totalEp == 0 {
		if eps, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/episode/list/"+it.GUID, nil, call); err == nil {
			if el, ok := eps["data"].([]any); ok {
				for _, er := range el {
					b2, _ := json.Marshal(er)
					var leaf fnItem
					_ = json.Unmarshal(b2, &leaf)
					addLeaf(leaf)
				}
			}
		}
	}
	rtMS := int64(0)
	if totalSec > 0 {
		rtMS = int64(totalSec * 1000)
	} else if it.Runtime > 0 {
		rtMS = int64(it.Runtime * 60)
	}
	if it.Watched == 1 || (totalEp > 0 && watchedEp == totalEp) {
		return analyzeResult{rtMS, 1, true, false, lpMs}
	}
	if watchedEp > 0 {
		p := 0.0
		if totalEp > 0 {
			p = float64(watchedEp) / float64(totalEp)
		}
		return analyzeResult{rtMS, p, true, true, lpMs}
	}
	return empty
}

// buildLocalWatchItem 桌面版同形状条目（仅本地播放字段，评分留给 enrich 按需查）。
func buildLocalWatchItem(it fnItem, a analyzeResult) map[string]any {
	return map[string]any{
		"guid": it.GUID, "parent_guid": it.ParentGUID,
		"douban_id": it.DoubanID, "title": it.Title,
		"tv_title": it.TVTitle, "parent_title": it.ParentTitle,
		"type": it.Type, "category": "", "genres": []any{},
		"air_date": it.AirDate, "release_date": it.ReleaseDate,
		"watched": it.Watched, "started": boolToInt(a.Started),
		"last_played": a.LastPlayed, "progress": a.Progress,
		"total_runtime_ms": a.TotalRuntimeMS,
		"fnos_rating":      it.VoteAverage,
		"tmdb_rating":      0, "tmdb_votes": 0,
		"douban_rating": 0, "douban_votes": 0,
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// doubanEnrich {item}：TMDB 分类/类型/评分（+ 有 douban_id 时尽力抓豆瓣评分）。
// 精简移植 enrichWithTmdb + fetchDoubanRating（豆瓣无 cookie 常被拒，失败静默 0）。
func (b *Bridge) doubanEnrich(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Item fnItem `json:"item"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req)
	it := req.Item
	mt := "tv"
	if strings.ToLower(it.Type) == "movie" {
		mt = "movie"
	}
	category := "剧集"
	if mt == "movie" {
		category = "电影"
	}
	year := it.ReleaseDate
	if year == "" {
		year = it.AirDate
	}
	if len(year) > 4 {
		year = year[:4]
	}
	out := map[string]any{
		"category": category, "genres": []any{},
		"tmdb_rating": 0, "tmdb_votes": 0,
		"douban_rating": 0, "douban_votes": 0,
	}
	if b.tmdbAPIKey() == "" {
		out["note"] = "未配置 TMDB API Key，仅返回基础分类"
		writeJSON(w, http.StatusOK, out)
		return
	}
	params := map[string]string{"query": it.Title}
	if year != "" {
		if mt == "movie" {
			params["year"] = year
		} else {
			params["first_air_date_year"] = year
		}
	}
	st, res, err := b.tmdbGet("/search/"+mt, params)
	if err != nil || st != http.StatusOK {
		note := "TMDB 搜索失败"
		if err != nil {
			note += "（" + err.Error() + "）"
		} else {
			note += fmt.Sprintf("（%d）", st)
		}
		out["note"] = note
		writeJSON(w, http.StatusOK, out)
		return
	}
	results, _ := res["results"].([]any)
	if len(results) == 0 {
		out["note"] = "TMDB 搜索无结果"
		writeJSON(w, http.StatusOK, out)
		return
	}
	first, _ := results[0].(map[string]any)
	if gid, ok := first["genre_ids"].([]any); ok {
		gl := out["genres"].([]any)
		for _, g := range gid {
			gl = append(gl, tmdbGenreName(mt, toInt64(g)))
		}
		out["genres"] = gl
		// 动漫判定（TV + Animation genre 16）
		if mt == "tv" {
			for _, g := range gid {
				if toInt64(g) == 16 {
					out["category"] = "动漫"
				}
			}
		}
	}
	if va, ok := first["vote_average"].(float64); ok {
		out["tmdb_rating"] = va
	}
	if vc, ok := first["vote_count"].(float64); ok {
		out["tmdb_votes"] = int64(vc)
	}
	if mt == "tv" {
		if st2, det, err := b.tmdbGet("/tv/"+fmt.Sprintf("%d", toInt64(first["id"])), nil); err == nil && st2 == http.StatusOK {
			if status, ok := det["status"].(string); ok {
				out["air_status"] = tmdbAirStatusCN(status)
			}
		}
	}
	// [v1.10.0] OMDb（扩展数据源 ③）：开关开启时经 TMDB external_ids 拿 IMDb id → 补 IMDb 评分/票数。
	// 观影记录详情浮层据此渲染第三格「IMDb」评分（watchHistory.ts renderRatings）。尽力而为，失败静默。
	if b.omdbOn() {
		if _, ext, err := b.tmdbGet("/"+mt+"/"+fmt.Sprintf("%d", toInt64(first["id"]))+"/external_ids", nil); err == nil && ext != nil {
			if imdb := strings.TrimSpace(jsFirstStr(ext["imdb_id"], ext["imdbId"])); imdb != "" {
				if rating, votes := b.omdbEnrich(imdb); rating > 0 {
					out["imdb_rating"] = rating
					out["imdb_votes"] = votes
				}
			}
		}
	}
	if id := strings.TrimSpace(it.DoubanID); isAllDigits(id) {
		if rating, votes := b.fetchDoubanRating(id); rating > 0 {
			out["douban_rating"] = rating
			out["douban_votes"] = votes
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// fetchDoubanRating 抓 movie.douban.com 条目页正则取评分/人数。豆瓣对无 cookie 请求
// 常拒（418/登录页），[v0.51.0] 起带设置面板粘贴的 doubanCookie（有则大幅提升成功率），失败静默 0。
func (b *Bridge) fetchDoubanRating(doubanID string) (float64, int64) {
	req, _ := http.NewRequest(http.MethodGet, "https://movie.douban.com/subject/"+doubanID+"/", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://movie.douban.com/")
	if ck := strings.TrimSpace(getSetting(b.cfg, "doubanCookie")); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	html := string(data)
	re := regexp.MustCompile(`v:average">([0-9.]+)`)
	votesRe := regexp.MustCompile(`v:votes">(\d+)`)
	rating := 0.0
	if m := re.FindStringSubmatch(html); len(m) > 1 {
		_, _ = fmt.Sscanf(m[1], "%f", &rating)
	}
	votes := int64(0)
	if m := votesRe.FindStringSubmatch(html); len(m) > 1 {
		_, _ = fmt.Sscanf(m[1], "%d", &votes)
	}
	return rating, votes
}

/* ========== Bangumi 同步核心 ========== */

const bangumiAPI = "https://api.bgm.tv"

// [v1.4.2] bgm.tv 传输多路化（桌面版 withTransport 同语义：代理 > 公共 DNS 直连 > 系统直连）。
// 实测背景（2026-09-11）：国内家宽系统 DNS 对 api.bgm.tv 返回污染 IP（128.242.240.91，
// TLS 握手超时），旧 bangumiReq 只走 b.client（系统 DNS）→ 搜索恒失败(0)，同步整链必挂。
// 桌面版有两路兜底（proxyAgent + bangumiDirectLookup 公共 DNS 覆盖解析），网页版两路全无。
//
// 公共 DNS 直连实现：UDP 询问 223.5.5.5 / 119.29.29.29（阿里/腾讯，国内快且稳）解析 A 记录，
// 命中后 DialTLS 直连该 IP + SNI 保持域名（证书校验不受影响）。结果缓存 10 分钟
// （BGM_DNS_TTL，桌面同值），解析失败回退系统 DNS（多路尝试里第三路兜底）。
const (
	bgmDNSCacheTTL = 10 * time.Minute
)

var (
	bgmDnsMu      sync.Mutex
	bgmDnsCacheIP string
	bgmDnsCacheAt time.Time
)

// resolveBangumiPublicIP 公共 DNS 解析 api.bgm.tv 的 A 记录（带缓存）；失败返回 ""。
func resolveBangumiPublicIP() string {
	bgmDnsMu.Lock()
	defer bgmDnsMu.Unlock()
	if bgmDnsCacheIP != "" && time.Since(bgmDnsCacheAt) < bgmDNSCacheTTL {
		return bgmDnsCacheIP
	}
	ip := dnsQueryA("api.bgm.tv")
	if ip != "" {
		bgmDnsCacheIP = ip
		bgmDnsCacheAt = time.Now()
	}
	return ip
}

// dnsQueryA 向公共 DNS 服务器发 UDP A 查询（3s 超时），返回首个 A 记录；失败 ""。
func dnsQueryA(name string) string {
	for _, server := range []string{"223.5.5.5:53", "119.29.29.29:53"} {
		if ip := dnsQueryAFrom(name, server, 3*time.Second); ip != "" {
			return ip
		}
	}
	return ""
}

// server 为 "host:port" 完整 UDP 地址（生产 "223.5.5.5:53"；测试注入本机随机端口）。
func dnsQueryAFrom(name, server string, timeout time.Duration) string {
	// 手工组 DNS 报文（标准库无轻量单查 API；net.Resolver 也可但绑定 GOOS 行为多）。
	id := uint16(time.Now().UnixNano() & 0xffff)
	msg := make([]byte, 12)
	binary.BigEndian.PutUint16(msg[0:], id)
	binary.BigEndian.PutUint16(msg[2:], 0x0100) // RD
	binary.BigEndian.PutUint16(msg[4:], 1)      // QDCOUNT
	for _, part := range strings.Split(name, ".") {
		msg = append(msg, byte(len(part)))
		msg = append(msg, part...)
	}
	msg = append(msg, 0, 0, 1, 0, 1) // QNAME 结尾 + QTYPE=A + QCLASS=IN

	udp, err := net.DialTimeout("udp", server, timeout)
	if err != nil {
		return ""
	}
	defer udp.Close()
	_ = udp.SetDeadline(time.Now().Add(timeout))
	if _, err := udp.Write(msg); err != nil {
		return ""
	}
	buf := make([]byte, 512)
	n, err := udp.Read(buf)
	if err != nil || n < 12 {
		return ""
	}
	if binary.BigEndian.Uint16(buf[0:]) != id {
		return ""
	}
	anCount := int(binary.BigEndian.Uint16(buf[6:]))
	// 跳过 Question 区
	idx := 12
	for idx < n && buf[idx] != 0 {
		idx += int(buf[idx]) + 1
	}
	idx += 5
	// 解析 Answer 区
	for i := 0; i < anCount && idx+2 <= n; i++ {
		if buf[idx]&0xC0 == 0xC0 {
			idx += 2 // 压缩指针
		} else {
			for idx < n && buf[idx] != 0 {
				idx += int(buf[idx]) + 1
			}
			idx++
		}
		if idx+10 > n {
			return ""
		}
		rdType := binary.BigEndian.Uint16(buf[idx:])
		rdLen := int(binary.BigEndian.Uint16(buf[idx+8:]))
		idx += 10
		if rdType == 1 && rdLen == 4 && idx+4 <= n {
			return net.IP(buf[idx : idx+4]).String()
		}
		idx += rdLen
	}
	return ""
}

// bangumiClient 按优先级返回 bgm.tv 传输客户端：自定义代理 > 公共 DNS 直连 > 系统直连。
// 恒返回非 nil（系统直连路径返回 b.client）——调用方不再需要判空。
func (b *Bridge) bangumiClient() (*http.Client, string) {
	if proxy := b.customProxyURL(); proxy != "" {
		if pu, err := url.Parse(proxy); err == nil && pu.Scheme != "" && pu.Host != "" {
			return &http.Client{
				Timeout:   20 * time.Second,
				Transport: &http.Transport{Proxy: http.ProxyURL(pu)},
			}, "自定义代理"
		}
	}
	if ip := resolveBangumiPublicIP(); ip != "" {
		dialer := &net.Dialer{Timeout: 12 * time.Second}
		tr := &http.Transport{
			DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				raw, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip, port))
				if err != nil {
					return nil, err
				}
				return tls.Client(raw, &tls.Config{ServerName: host}), nil // SNI/校验用域名
			},
		}
		return &http.Client{Timeout: 20 * time.Second, Transport: tr}, "公共DNS直连"
	}
	return b.client, "系统直连"
}

// bangumiReq 带可选 token 的 bgm.tv 调用。[v1.4.2] 传输多路化：自定义代理 > 公共 DNS
// 直连 > 系统直连（旧版只走系统 DNS，污染环境下整链必挂；桌面版 withTransport 同语义）。
func (b *Bridge) bangumiReq(method, path string, token string, body any) (int, map[string]any, error) {
	var reader io.Reader
	if body != nil {
		bd, _ := json.Marshal(body)
		reader = strings.NewReader(string(bd))
	}
	req, err := http.NewRequest(method, bangumiAPI+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client, via := b.bangumiClient()
	resp, err := client.Do(req)
	if err != nil {
		// 公共 DNS 直连失败且 IP 可能过期 → 清缓存，系统直连兜底重试一次
		if via == "公共DNS直连" {
			bgmDnsMu.Lock()
			bgmDnsCacheIP = ""
			bgmDnsMu.Unlock()
			if c2, _ := b.bangumiClient(); c2 != nil {
				if resp2, err2 := c2.Do(req.Clone(req.Context())); err2 == nil {
					return decodeBangumiResp(resp2)
				}
			}
		}
		return 0, nil, err
	}
	return decodeBangumiResp(resp)
}

func decodeBangumiResp(resp *http.Response) (int, map[string]any, error) {
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
	return resp.StatusCode, out, nil
}

// bangumiErrLabel 网络失败归类（对齐桌面版 classifyBgmError）：err != nil → 网络层细分；
// 否则按 HTTP 状态码归类。返回（中文标签, 简述）。
// 背景（2026-10-03 真机定位）：api.bgm.tv 已被墙——系统/公共 UDP DNS 均被注入假应答，
// 真实 IP 的 TLS 握手亦被 SNI 阻断，唯一出路是自定义代理。旧日志只打原始 error，
// 用户分不清网络还是 Token 问题；现在统一带标签落日志 + 面板展示。
func bangumiErrLabel(st int, err error) (string, string) {
	if err != nil {
		msg := strings.ToLower(err.Error())
		switch {
		case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
			return "网络", "连接超时(疑似被墙或网络不通)"
		case strings.Contains(msg, "reset") || strings.Contains(msg, "eof") || strings.Contains(msg, "broken pipe"):
			return "网络", "连接被重置(疑似 SNI 阻断)"
		case strings.Contains(msg, "no such host") || strings.Contains(msg, "dns"):
			return "网络", "DNS 解析失败(疑似污染)"
		case strings.Contains(msg, "refused"):
			return "网络", "连接被拒绝"
		case strings.Contains(msg, "tls") || strings.Contains(msg, "certificate") || strings.Contains(msg, "x509"):
			return "网络", "TLS 握手失败(疑似劫持)"
		}
		return "网络", "网络异常: " + err.Error()
	}
	switch {
	case st == 401 || st == 403:
		return "密钥", fmt.Sprintf("Token 失效/未授权(HTTP %d)", st)
	case st == 429:
		return "限流", "请求过于频繁(HTTP 429)"
	case st >= 500:
		return "服务", fmt.Sprintf("Bangumi 服务端异常(HTTP %d)", st)
	case st >= 400:
		return "请求", fmt.Sprintf("HTTP %d", st)
	}
	return "请求", "未知错误"
}

// ---- 最近同步状态（内存态；面板 GET bangumi/sync-status 展示，重启清零）----
var (
	bgmStatusMu   sync.Mutex
	bgmLastStatus map[string]any
)

func setBgmStatus(ok bool, stage, label, detail string) {
	bgmStatusMu.Lock()
	defer bgmStatusMu.Unlock()
	bgmLastStatus = map[string]any{
		"ts": time.Now().UnixMilli(), "ok": ok, "stage": stage, "label": label, "detail": detail,
	}
}

// bangumiSyncProgress {guid, percentage, item}：播放进度 → Bangumi 标记（在看/看过）。
// 忠实移植 syncOnProgress：TV → 搜索条目 → 定位集 → 标集看过；Movie → 标条目看过/在看。
// [v0.50.0] 入参变更：item 由前端直连 play/info 解析好后传入（原先后端自查 play/info，
// 但后端转发只有 document.cookie，fnOS 会话 token 为 httpOnly 拿不到 → 恒未登录，lc-057 同款断链）。
// 开关/阈值由后端读 settings 检查（bangumiSyncEnabled / bangumiSyncThreshold）。
// [2026-10-03] 端点全部换现行 v0 API：旧 GET /v0/search/subject、POST /v0/episode/{id}/status/watched、
// POST /v0/subject/{id}/status/do|watched 均已下线（OpenAPI 规范核实）——网络通了也必挂的隐患。
func (b *Bridge) bangumiSyncProgress(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GUID       string         `json:"guid"`
		Percentage float64        `json:"percentage"`
		Item       map[string]any `json:"item"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	if getSetting(b.cfg, "bangumiSyncEnabled") != "1" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Bangumi 同步未开启"})
		return
	}
	token := getSetting(b.cfg, "bangumiToken")
	if token == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "未配置 Bangumi Token"})
		return
	}
	threshold := 80.0
	if th, perr := strconv.ParseFloat(strings.TrimSpace(getSetting(b.cfg, "bangumiSyncThreshold")), 64); perr == nil && th > 0 && th <= 100 {
		threshold = th
	}
	if req.Percentage < threshold {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "进度未达阈值"})
		return
	}
	item := req.Item
	if item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少条目信息"})
		return
	}
	isEpisode := strings.EqualFold(fmt.Sprintf("%v", item["type"]), "Episode")
	showTitle := firstNonEmpty(str(item["parent_title"]), str(item["tv_title"]))
	epNum := toInt64(item["episode_number"])
	if epNum <= 0 {
		epNum = toInt64(item["index_number"])
	}
	movieTitle := str(item["title"])
	if isEpisode {
		if showTitle == "" || epNum <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少剧集标题/集号"})
			return
		}
		subjectID, failMsg := b.bangumiSearchSubject(token, showTitle)
		if failMsg != "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": failMsg})
			return
		}
		// 标集前必须先收藏条目（在看）；失败不拦——后续标集自会暴露真实原因（桌面同语义）
		b.bangumiCollect(token, subjectID, false)
		st, er, err := b.bangumiReq(http.MethodGet, fmt.Sprintf("/v0/episodes?subject_id=%d&type=0&limit=200", subjectID), token, nil)
		if err != nil || st != http.StatusOK {
			label, brief := bangumiErrLabel(st, err)
			logf("[bangumi][%s] 拉取集列表失败 subject=%d: %s", label, subjectID, brief)
			setBgmStatus(false, "episodes", label, fmt.Sprintf("%s 第 %d 集：拉取集列表失败 %s", showTitle, epNum, brief))
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("拉取集列表失败[%s] %s", label, brief)})
			return
		}
		epID := findBangumiEpisodeID(er, int(epNum))
		if epID <= 0 {
			setBgmStatus(false, "episodes", "未匹配", fmt.Sprintf("%s：条目内无第 %d 集（可能是 SP/特别篇）", showTitle, epNum))
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("未找到第 %d 集", epNum)})
			return
		}
		st, _, err = b.bangumiReq(http.MethodPut, fmt.Sprintf("/v0/users/-/collections/-/episodes/%d", epID), token, map[string]any{"type": 2})
		if err != nil || st >= 400 {
			label, brief := bangumiErrLabel(st, err)
			logf("[bangumi][%s] 标记单集失败 episode=%d: %s", label, epID, brief)
			setBgmStatus(false, "episode-watched", label, fmt.Sprintf("%s 第 %d 集：%s", showTitle, epNum, brief))
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("标记集失败[%s] %s", label, brief)})
			return
		}
		setBgmStatus(true, "episode-watched", "", fmt.Sprintf("%s 第 %d 集 → 已标看过", showTitle, epNum))
		logf("[bangumi] 已标记 %s 第 %d 集 (subject=%d episode=%d)", showTitle, epNum, subjectID, epID)
		if req.Percentage >= 100 {
			b.bangumiCollect(token, subjectID, true)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subject_id": subjectID, "episode_id": epID, "message": fmt.Sprintf("已标记 %s 第 %d 集", showTitle, epNum)})
		return
	}
	if movieTitle == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少影片标题"})
		return
	}
	subjectID, failMsg := b.bangumiSearchSubject(token, movieTitle)
	if failMsg != "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": failMsg})
		return
	}
	stage, name := "collect-doing", "在看"
	if req.Percentage >= 100 {
		stage, name = "collect-watched", "看过"
	}
	if st, _, err := b.bangumiReq(http.MethodPost, fmt.Sprintf("/v0/users/-/collections/%d", subjectID), token, map[string]any{"type": map[bool]int{false: 3, true: 2}[req.Percentage >= 100]}); err != nil || st >= 400 {
		label, brief := bangumiErrLabel(st, err)
		logf("[bangumi][%s] 标条目%s失败 subject=%d: %s", label, name, subjectID, brief)
		setBgmStatus(false, stage, label, fmt.Sprintf("「%s」标条目%s失败：%s", movieTitle, name, brief))
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("标记失败[%s] %s", label, brief)})
		return
	}
	setBgmStatus(true, stage, "", fmt.Sprintf("「%s」已标%s（电影）", movieTitle, name))
	logf("[bangumi] 已标记 %s → 条目%s (subject=%d)", movieTitle, name, subjectID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subject_id": subjectID, "message": "已标记 " + movieTitle})
}

// bangumiSearchSubject POST /v0/search/subjects（现行端点，须带 Token）。
// filter type=[2,6]（动画+三次元）对齐桌面版——旧版电影走 type=1 是「书」，属复制笔误。
// 失败返回面板/前端可直读的消息串（带归类标签），成功返回 subjectID（""）。
func (b *Bridge) bangumiSearchSubject(token, title string) (int64, string) {
	body := map[string]any{"keyword": title, "sort": "match", "filter": map[string]any{"type": []int{2, 6}}}
	st, sr, err := b.bangumiReq(http.MethodPost, "/v0/search/subjects?limit=5", token, body)
	if err != nil || st != http.StatusOK {
		label, brief := bangumiErrLabel(st, err)
		logf("[bangumi][%s] 搜索条目失败 %q: %s", label, title, brief)
		setBgmStatus(false, "search", label, fmt.Sprintf("「%s」搜索失败：%s", title, brief))
		return 0, fmt.Sprintf("Bangumi 搜索失败[%s] %s", label, brief)
	}
	id := findBangumiSubjectID(sr)
	if id <= 0 {
		setBgmStatus(false, "search", "未匹配", fmt.Sprintf("「%s」搜索无结果（标题差异过大？）", title))
		return 0, "Bangumi 未找到条目: " + title
	}
	return id, ""
}

// bangumiCollect POST /v0/users/-/collections/{id}（现行端点）：watched=false → 在看(3)，true → 看过(2)。
// 失败归类落日志 + 最近状态；返回是否成功供电影路径决定整体成败。
func (b *Bridge) bangumiCollect(token string, subjectID int64, watched bool) bool {
	t, stage, name := 3, "collect-doing", "在看"
	if watched {
		t, stage, name = 2, "collect-watched", "看过"
	}
	st, _, err := b.bangumiReq(http.MethodPost, fmt.Sprintf("/v0/users/-/collections/%d", subjectID), token, map[string]any{"type": t})
	if err != nil || st >= 400 {
		label, brief := bangumiErrLabel(st, err)
		logf("[bangumi][%s] 标条目%s失败 subject=%d: %s", label, name, subjectID, brief)
		setBgmStatus(false, stage, label, fmt.Sprintf("标条目%s失败(subject %d)：%s", name, subjectID, brief))
		return false
	}
	logf("[bangumi] 条目 %d → %s (HTTP %d)", subjectID, name, st)
	return true
}

// bangumiSyncStatus GET：最近一次同步结果（成功/失败 + 归类原因），供设置面板展示。
func (b *Bridge) bangumiSyncStatus(w http.ResponseWriter, _ *http.Request) {
	bgmStatusMu.Lock()
	s := bgmLastStatus
	bgmStatusMu.Unlock()
	if s == nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// bangumiProbe GET：连接诊断（面板「测试连接」）。① GET /calendar（公开端点）测网络链路，
// 并报出实际走的传输路（自定义代理/公共DNS直连/系统直连）；② 有 Token 再 GET /v0/me 测有效性。
func (b *Bridge) bangumiProbe(w http.ResponseWriter, _ *http.Request) {
	_, via := b.bangumiClient()
	t0 := time.Now()
	st, _, err := b.bangumiReq(http.MethodGet, "/calendar", "", nil)
	network := map[string]any{"via": via}
	if err != nil || st >= 400 {
		label, brief := bangumiErrLabel(st, err)
		if err == nil {
			brief = fmt.Sprintf("HTTP %d", st)
		}
		logf("[bangumi][%s] 探针：网络不通 %s", label, brief)
		network["ok"] = false
		network["detail"] = brief
		network["hint"] = "bgm.tv 需代理可达，请在设置里配置自定义代理"
	} else {
		network["ok"] = true
		network["detail"] = fmt.Sprintf("HTTP %d", st)
		network["latencyMs"] = time.Since(t0).Milliseconds()
	}
	tokenOut := map[string]any{}
	switch token := getSetting(b.cfg, "bangumiToken"); {
	case token == "":
		tokenOut["checked"] = false
		tokenOut["detail"] = "未配置 Token"
	case network["ok"] != true:
		tokenOut["checked"] = false
		tokenOut["detail"] = "网络不通，未验证（先解决网络）"
	default:
		st2, _, err2 := b.bangumiReq(http.MethodGet, "/v0/me", token, nil)
		if err2 != nil || st2 >= 400 {
			_, brief := bangumiErrLabel(st2, err2)
			if err2 == nil {
				brief = fmt.Sprintf("HTTP %d（401/403=Token 失效）", st2)
			}
			tokenOut["checked"] = true
			tokenOut["ok"] = false
			tokenOut["detail"] = brief
		} else {
			tokenOut["checked"] = true
			tokenOut["ok"] = true
			tokenOut["detail"] = "Token 有效"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"transport": via, "network": network, "token": tokenOut})
}

func findBangumiSubjectID(resp map[string]any) int64 {
	if data, ok := resp["data"].([]any); ok && len(data) > 0 {
		if first, ok := data[0].(map[string]any); ok {
			return toInt64(first["id"])
		}
	}
	if subs, ok := resp["subjects"].([]any); ok && len(subs) > 0 {
		if first, ok := subs[0].(map[string]any); ok {
			return toInt64(first["id"])
		}
	}
	return 0
}

func findBangumiEpisodeID(resp map[string]any, epNum int) int64 {
	if data, ok := resp["data"].([]any); ok {
		for _, raw := range data {
			if e, ok := raw.(map[string]any); ok {
				// 现行 v0 API 分集对象只有 ep/sort 字段（旧 API 的 number 已不存在）
				if toInt64(e["ep"]) == int64(epNum) || toInt64(e["sort"]) == int64(epNum) {
					return toInt64(e["id"])
				}
			}
		}
		if epNum <= len(data) {
			if e, ok := data[epNum-1].(map[string]any); ok {
				return toInt64(e["id"])
			}
		}
	}
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// tmdbGenreName TMDB genre_id → 中文名（静态映射，标准 ID 表）。
func tmdbGenreName(mediaType string, id int64) string {
	m := map[string]map[int64]string{
		"movie": {28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录片", 18: "剧情", 10751: "家庭", 14: "奇幻", 36: "历史", 27: "恐怖", 10402: "音乐", 9648: "悬疑", 10749: "爱情", 878: "科幻", 10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部"},
		"tv":    {10759: "动作冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录片", 18: "剧情", 10751: "家庭", 10762: "儿童", 9648: "悬疑", 10763: "新闻", 10764: "真人秀", 10765: "科幻奇幻", 10766: "肥皂剧", 10767: "脱口秀", 10768: "战争政治", 37: "西部"},
	}
	if m2, ok := m[mediaType]; ok {
		if name, ok := m2[id]; ok {
			return name
		}
	}
	return fmt.Sprintf("genre_%d", id)
}

// tmdbAirStatusCN TMDB status → 中文播出状态。
func tmdbAirStatusCN(status string) string {
	switch status {
	case "Returning Series":
		return "连载中"
	case "Planned":
		return "计划中"
	case "In Production":
		return "制作中"
	case "Ended":
		return "已完结"
	case "Canceled":
		return "已取消"
	}
	return status
}
