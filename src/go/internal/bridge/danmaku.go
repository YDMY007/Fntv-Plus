// Package bridge —— danmaku.go：网页端弹幕数据链（danmaku:prepare 的 Go 后端）。
// 移植桌面版 third_party/uosc_danmaku/bili_danmaku.js 的核心流程（第一版走经典稳态链）：
//
//	WBI 签名搜索 PGC（番剧 season_type=1 / 国创 4）→ season_id → pgc/view/web/season
//	→ 按 ep 选集（序号直取 → 标题含集数 → 首集）→ list.so?oid=cid 拉 XML 弹幕 → 解析
//	→ 屏蔽过滤（类型 + 黑名单）→ 磁盘缓存（config 同目录 danmaku-cache/）。
//
// 登录态：可选携带设置面板粘贴的 bili_cookie（SESSDATA），弹幕数量更全；匿名亦可用。
// 元数据（标题/集数/季）由前端直连 play/info 解析后传入（httpOnly 断链，见 lc-057/061）。
package bridge

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"fntvplus/internal/config"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// biliWebAPI B站 Web API 基址。var 而非 const：单测用 httptest 覆盖指向本地假服务器
// （额度保护测试要断言「B站 命中时是否还会请求弹弹play」，两侧上游都必须可替换）。
var biliWebAPI = "https://api.bilibili.com"

// biliEncTable WBI mixin 重排表（B站官方算法，与桌面版 bili_danmaku.js ENC 一致）
var biliEncTable = [64]int{46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52}

var biliNavCache struct {
	mu     sync.Mutex
	ik, sk string
	exp    time.Time
}

// biliUA B站请求统一 UA（匿名/登录态均建议浏览器 UA）
const biliUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// biliNav 拉取 wbi_img 两个 key（带过期缓存）。
// [v1.3.0] 旧 sync.Once 版把失败（空 key）也永久缓存——一次网络抖动/风控后所有 WBI 签名全废
// 且进程内不可恢复。改为：成功缓存 1h，失败只放弃 30s，之后自动重试。
func biliNavKeys() (string, string) {
	biliNavCache.mu.Lock()
	defer biliNavCache.mu.Unlock()
	if time.Now().Before(biliNavCache.exp) {
		return biliNavCache.ik, biliNavCache.sk
	}
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, biliWebAPI+"/x/web-interface/nav", nil)
	req.Header.Set("User-Agent", biliUA)
	ik, sk := "", ""
	if resp, err := client.Do(req); err == nil {
		var out struct {
			Data struct {
				WbiImg struct {
					ImgURL string `json:"img_url"`
					SubURL string `json:"sub_url"`
				} `json:"wbi_img"`
			} `json:"data"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&out)
		resp.Body.Close()
		ik = path.Base(out.Data.WbiImg.ImgURL)
		if ext := filepath.Ext(ik); ext != "" {
			ik = strings.TrimSuffix(ik, ext)
		}
		sk = path.Base(out.Data.WbiImg.SubURL)
		if ext := filepath.Ext(sk); ext != "" {
			sk = strings.TrimSuffix(sk, ext)
		}
	}
	if ik != "" && sk != "" {
		biliNavCache.ik, biliNavCache.sk = ik, sk
		biliNavCache.exp = time.Now().Add(1 * time.Hour)
	} else {
		logf("[danmaku] WBI nav 密钥拉取失败（30s 后重试）")
		biliNavCache.exp = time.Now().Add(30 * time.Second)
	}
	return biliNavCache.ik, biliNavCache.sk
}

// biliWbiSign WBI 签名：params + wts 排序拼接 → md5(qs + mixinKey) → 返回含 w_rid 的 query 串。
func biliWbiSign(params map[string]string) string {
	ik, sk := biliNavKeys()
	mixinArr := make([]byte, 0, 64)
	all := ik + sk
	for _, i := range biliEncTable {
		if i < len(all) {
			mixinArr = append(mixinArr, all[i])
		}
	}
	mixin := string(mixinArr)
	if len(mixin) > 32 {
		mixin = mixin[:32]
	}
	keys := make([]string, 0, len(params)+1)
	for k := range params {
		keys = append(keys, k)
	}
	keys = append(keys, "wts")
	sort.Strings(keys)
	vals := map[string]string{}
	for k, v := range params {
		vals[k] = v
	}
	vals["wts"] = strconv.FormatInt(time.Now().Unix(), 10)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, url.QueryEscape(k)+"="+url.QueryEscape(vals[k]))
	}
	qs := strings.Join(pairs, "&")
	sum := md5.Sum([]byte(qs + mixin))
	return qs + "&w_rid=" + hex.EncodeToString(sum[:])
}

// biliGet 带 UA/cookie 的 B站 GET → JSON map。
func (b *Bridge) danmakuGetJSON(rawURL string) (int, map[string]any, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", biliUA)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	if ck := strings.TrimSpace(getSetting(b.cfg, "bili_cookie")); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&out)
	return resp.StatusCode, out, nil
}

var reEpInTitle = regexp.MustCompile(`(?i)(?:^|[^A-Za-z\d])(?:e\.?p\.?\s*|episode\s*|#\s*)\s*0*([0-9]+)`)

// reBiliHTMLTag 剥 B站搜索结果标题里的高亮标签（<em class="keyword"> 等，桌面端 /<[^>]+>/g 同款）。
var reBiliHTMLTag = regexp.MustCompile(`<[^>]+>`)

// biliSearchVideos 视频区（UP主搬运）搜索 → [{bvid,title}]（前 n 条）。
// [v1.3.0] 换桌面端同款 search/all/v2 综合搜索（bili_danmaku.js search_video 同接口同解析）：
// 无需 WBI 签名，匿名+UA+Referer 即可用。旧 wbi/search/type 对匿名请求风控极严（空 result/-412），
// 叠加旧版 nav 密钥失败永久缓存 → 手动搜索「从来没有可用的搜索结果」的根因。
func (b *Bridge) biliSearchVideos(title string, limit int) []map[string]any {
	u := biliWebAPI + "/x/web-interface/search/all/v2?keyword=" + url.QueryEscape(title) + "&search_type=video"
	code, out, err := b.danmakuGetJSON(u)
	if err != nil {
		logf("[danmaku] 视频区搜索请求失败: %v", err)
		return nil
	}
	if out == nil {
		logf("[danmaku] 视频区搜索 HTTP %d 无响应体", code)
		return nil
	}
	if c := int64(jsNum(out["code"])); c != 0 {
		logf("[danmaku] 视频区搜索 code=%d msg=%s", c, jsStr(out["message"]))
		return nil
	}
	var result []any
	if dm := jMap(out["data"]); dm != nil {
		result = jArr(dm["result"])
	}
	out2 := []map[string]any{}
	for _, it := range result {
		m := jMap(it)
		if m == nil || jsStr(m["result_type"]) != "video" {
			continue
		}
		for _, v := range jArr(m["data"]) {
			vm := jMap(v)
			if vm == nil {
				continue
			}
			bvid := jsStr(vm["bvid"])
			if bvid == "" {
				continue
			}
			out2 = append(out2, map[string]any{
				"bvid":  bvid,
				"title": reBiliHTMLTag.ReplaceAllString(jsStr(vm["title"]), ""),
			})
			if len(out2) >= limit {
				return out2
			}
		}
	}
	logf("[danmaku] 视频区搜索 keyword=%q 命中 %d 条", title, len(out2))
	return out2
}

var (
	reEpZh      = regexp.MustCompile(`第\s*0*([0-9]+)\s*[话集回話]`)
	reEpRange   = regexp.MustCompile(`\d\s*[~\-–至]\s*\d`)
	reEpPrefix  = regexp.MustCompile(`[^A-Za-z\d](?:e\.?p\.?\s*|episode\s*|#\s*)\s*0*([0-9]+)`)
	reDigitRuns = regexp.MustCompile(`[0-9]+`)
)

// epInTitle 桌面端 _ep_in_title 同语义：标题是否指向第 ep 集。
// 规则按序：第N话 → 含范围表达(1-12话)则排除裸数字 → EP/episode/# 前缀 → 裸数字(前后非数字)。
func epInTitle(t string, ep int64) bool {
	if ep <= 0 {
		return false
	}
	for _, m := range reEpZh.FindAllStringSubmatch(t, -1) {
		if n, err := strconv.ParseInt(m[1], 10, 64); err == nil && n == ep {
			return true
		}
	}
	if reEpRange.MatchString(t) {
		return false
	}
	for _, m := range reEpPrefix.FindAllStringSubmatch(t, -1) {
		if n, err := strconv.ParseInt(m[1], 10, 64); err == nil && n == ep {
			return true
		}
	}
	for _, loc := range reDigitRuns.FindAllStringIndex(t, -1) {
		s := strings.TrimLeft(t[loc[0]:loc[1]], "0")
		if s == "" {
			continue
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n == ep {
			return true
		}
	}
	return false
}

// biliCidFromBvid bvid → cid（view 接口，桌面端 cid_from_bvid 同语义）。
// [v1.3.1] 修复致命层级 bug：旧代码取响应顶层 vo["cid"]——view 的 cid 在 data 里，
// 顶层永远没有 → 自动加载视频区路径与手动选定永远报「未找到视频 cid」。
// 多 P 视频按 part 标题匹配集数（先行/预览命中只作兜底）；未指定集数取首 P。
func (b *Bridge) biliCidFromBvid(bvid string, epNum int64) int64 {
	_, vo, err := b.danmakuGetJSON(biliWebAPI + "/x/web-interface/view?bvid=" + url.QueryEscape(bvid))
	if err != nil || vo == nil {
		logf("[danmaku] view 请求失败 bvid=%s: %v", bvid, err)
		return 0
	}
	if c := int64(jsNum(vo["code"])); c != 0 {
		logf("[danmaku] view code=%d msg=%s bvid=%s", c, jsStr(vo["message"]), bvid)
		return 0
	}
	data := jMap(vo["data"])
	if data == nil {
		return 0
	}
	pages := jArr(data["pages"])
	rootCid := int64(jsNum(data["cid"]))
	// 多 P + 指定集数：按 part 标题匹配（先行/预览命中暂存兜底，不直接用）
	if len(pages) > 1 && epNum > 0 {
		fallback := int64(0)
		for _, v := range pages {
			pm := jMap(v)
			if pm == nil {
				continue
			}
			part := jsStr(pm["part"])
			if !epInTitle(part, epNum) {
				continue
			}
			cid := int64(jsNum(pm["cid"]))
			if cid <= 0 {
				continue
			}
			if strings.Contains(part, "先行") || strings.Contains(part, "预览") {
				if fallback == 0 {
					fallback = cid
				}
				continue
			}
			logf("[danmaku] cid_from_bvid bvid=%s 多P命中 part=%q cid=%d", bvid, part, cid)
			return cid
		}
		if fallback > 0 {
			logf("[danmaku] cid_from_bvid bvid=%s 多P仅先行/预览命中, 兜底 cid=%d", bvid, fallback)
			return fallback
		}
		logf("[danmaku] cid_from_bvid bvid=%s 多P未匹配第%d话, 兜底根 cid=%d", bvid, epNum, rootCid)
		return rootCid
	}
	// 单 P / 未指定集数：根 cid（=首 P），根缺失回退 pages[0]
	if rootCid <= 0 && len(pages) > 0 {
		if pm := jMap(pages[0]); pm != nil {
			rootCid = int64(jsNum(pm["cid"]))
		}
	}
	logf("[danmaku] cid_from_bvid bvid=%s pages=%d cid=%d", bvid, len(pages), rootCid)
	return rootCid
}

// cookieStatusOf 登录态摘要（渲染端「来源详情→登录状态」显示用；有 cookie 即 valid）。
func cookieStatusOf(cfg *config.Config) string {
	if strings.TrimSpace(getSetting(cfg, "bili_cookie")) != "" {
		return "valid"
	}
	return "missing"
}

// biliPickEpisode 选集（桌面版 _pick_episode 同逻辑）：序号直取 → 标题含集数 → 首集。
func biliPickEpisode(eps []map[string]any, epNum int64) map[string]any {
	if len(eps) == 0 {
		return nil
	}
	if epNum >= 1 && int(epNum) <= len(eps) {
		return eps[epNum-1]
	}
	if epNum > 0 {
		for _, e := range eps {
			tt := jsStr(e["title"]) + " " + jsStr(e["long_title"])
			loc := reEpInTitle.FindStringSubmatchIndex(tt)
			// Go regexp 不支持负向先行：手动校验捕获组之后不能再跟数字（等价 (?!...)
			if loc != nil && loc[3] >= len(tt)-0 {
				// 捕获组右邻是字符串末尾 → 数字完整
				if n, err := strconv.ParseInt(tt[loc[2]:loc[3]], 10, 64); err == nil && n == epNum {
					return e
				}
			} else if loc != nil {
				next := tt[loc[3]]
				if next < '0' || next > '9' {
					if n, err := strconv.ParseInt(tt[loc[2]:loc[3]], 10, 64); err == nil && n == epNum {
						return e
					}
				}
			}
		}
	}
	return eps[0]
}

// biliSearchPGC WBI 签名搜索 PGC（seasonType 1=番剧 4=国创），返回 season_id 候选（按标题相似度降序）。
func (b *Bridge) biliSearchPGC(title string, seasonNum int64, seasonType string) []struct {
	ID    int64
	Title string
	Sim   float64
} {
	// 桌面同语义：无登录态 Cookie 跳过官方番剧搜索（匿名 media_bangumi 必返回 0，白打两次请求）
	if strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) == "" {
		return nil
	}
	type cand struct {
		ID    int64
		Title string
		Sim   float64
	}
	q := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(title, "（", "("), "）", ")"))
	reYearTail := regexp.MustCompile(`\s*\(\d{4}\)\s*$`)
	q = strings.TrimSpace(reYearTail.ReplaceAllString(q, ""))
	if q == "" {
		return nil
	}
	signed := biliWbiSign(map[string]string{
		"keyword":     q,
		"search_type": seasonType,
		"page":        "1",
	})
	_, out, err := b.danmakuGetJSON(biliWebAPI + "/x/web-interface/wbi/search/type?" + signed)
	if err != nil || out == nil {
		return nil
	}
	result, _ := out["result"].([]any)
	qn := jsNormTitle(q)
	type Cand = struct {
		ID    int64
		Title string
		Sim   float64
	}
	var cands []Cand
	for _, v := range result {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		sid := int64(jsNum(m["season_id"]))
		if sid <= 0 {
			continue
		}
		t := jsStr(m["title"])
		// B站搜索结果标题里关键词带 <em class="keyword"> 高亮，先剥掉
		t = strings.ReplaceAll(strings.ReplaceAll(t, `<em class="keyword">`, ""), "</em>", "")
		tn := jsNormTitle(t)
		sim := 0.5
		switch {
		case tn == qn && qn != "":
			sim = 1.0
		case qn != "" && (strings.Contains(tn, qn) || strings.Contains(qn, tn)):
			sim = 0.8
		}
		// 季数精确匹配加权（season_title 形如「第 2 季」）
		if seasonNum > 0 {
			st := jsNormTitle(jsStr(m["season_title"]))
			if st != "" && strings.Contains(st, strconv.FormatInt(seasonNum, 10)+"季") {
				sim += 0.1
			}
		}
		cands = append(cands, Cand{ID: sid, Title: t, Sim: sim})
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].Sim > cands[j].Sim })
	return cands
}

// biliSeasonEpisodes season_id → 全集列表（main_section episodes）。
func (b *Bridge) biliSeasonEpisodes(seasonID int64) []map[string]any {
	_, out, err := b.danmakuGetJSON(fmt.Sprintf("%s/pgc/view/web/season?season_id=%d", biliWebAPI, seasonID))
	if err != nil || out == nil {
		return nil
	}
	if res, _ := out["result"].(map[string]any); res != nil {
		if eps, _ := res["episodes"].([]any); len(eps) > 0 {
			return toMapSlice(eps)
		}
		if ms, _ := res["main_section"].(map[string]any); ms != nil {
			if eps, _ := ms["episodes"].([]any); len(eps) > 0 {
				return toMapSlice(eps)
			}
		}
	}
	return nil
}

func toMapSlice(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, v := range arr {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// biliFetchDanmakuXML cid → 经典 list.so XML → 解析为 items（time/type/color/text），按 time 升序。
// [v1.4.4] ⚠ 该端点无视 Accept-Encoding 直接回 **raw deflate** 压缩体（本地全链实测：
// 37KB 二进制，zlib raw inflate 后 99KB 正常 XML；前 2 字节 0x84bd 非 gzip 魔数 1f8b）。
// Go http.Transport 只自动解 gzip → 旧版 parseDanmakuXML 收到二进制 → 正则 0 命中 →
// 手动选定候选报「该条目没有弹幕」（自动加载同断）。检测 gzip / zlib / raw deflate 逐一解压。
func (b *Bridge) biliFetchDanmakuXML(cid int64) []map[string]any {
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/x/v1/dm/list.so?oid=%d", biliWebAPI, cid), nil)
	req.Header.Set("User-Agent", biliUA)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	if ck := strings.TrimSpace(getSetting(b.cfg, "bili_cookie")); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	// [v1.11.1] 风控识别：B站 对高频 list.so 返回 412 + HTML 错误页（实测连续请求后触发）。
	// 旧实现直接交给 XML 解析器 → 0 命中 → 上层报「该集没有弹幕数据」（误导），
	// 且会连带触发弹弹play 兜底白耗配额。这里显式识别并标记限流，让上层能正确归因。
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	biliRateLimited.Store(false)
	if resp.StatusCode == http.StatusPreconditionFailed || resp.StatusCode == http.StatusTooManyRequests {
		biliRateLimited.Store(true)
		logf("[danmaku] B站 弹幕接口限流（HTTP %d）cid=%d —— 建议降低请求频率或配置登录 Cookie", resp.StatusCode, cid)
		return nil
	}
	data = decompressDanmakuBody(data)
	if len(data) < 16 {
		return nil
	}
	// HTML 错误页（412 的另一种形态：状态码 200 但内容是网页）同样不算弹幕
	if bytes.HasPrefix(bytes.TrimSpace(data), []byte("<!DOCTYPE")) ||
		bytes.HasPrefix(bytes.TrimSpace(data), []byte("<html")) {
		biliRateLimited.Store(true)
		logf("[danmaku] B站 弹幕接口返回 HTML 错误页（疑似风控）cid=%d", cid)
		return nil
	}
	return parseDanmakuXML(data)
}

// biliRateLimited 最近一次 list.so 是否被风控（供上层把「无弹幕」与「被限流」区分开）。
var biliRateLimited atomic.Bool

// biliNoDataReason 区分「该集真没弹幕」与「被 B站 限流」——后者是可恢复的（稍后重试/登录），
// 若统一报「没有弹幕数据」会让用户误以为内容缺失，也会掩盖限流问题。
func biliNoDataReason() string {
	if biliRateLimited.Load() {
		return "B站 接口限流（稍后重试，或登录 B站 账号提高额度）"
	}
	return "该集没有弹幕数据"
}

// decompressDanmakuBody 按魔数识别并解压弹幕体：gzip(1f 8b) / zlib(78 xx) / raw deflate；
// 已是明文（如 `<` 开头的 XML）原样返回。解压失败原样返回（交给上层按明文尝试）。
func decompressDanmakuBody(data []byte) []byte {
	if len(data) < 3 {
		return data
	}
	// 明文 XML 快速路径
	if data[0] == '<' {
		return data
	}
	readAll := func(r io.Reader) ([]byte, bool) {
		out, err := io.ReadAll(io.LimitReader(r, 32*1024*1024))
		if err != nil && len(out) == 0 {
			return nil, false
		}
		return out, len(out) > 0
	}
	switch {
	case data[0] == 0x1f && data[1] == 0x8b: // gzip
		if zr, err := gzip.NewReader(bytes.NewReader(data)); err == nil {
			if out, ok := readAll(zr); ok {
				return out
			}
		}
	case data[0] == 0x78: // zlib（78 01/9C/DA…）
		zr, zerr := zlib.NewReader(bytes.NewReader(data))
		if zerr == nil {
			if out, ok := readAll(zr); ok {
				return out
			}
		}
	default:
		// raw deflate（实测 list.so 形态，0x84 开头）：zlib 头解析不过 → 裸 flate
		if out, ok := readAll(flate.NewReader(bytes.NewReader(data))); ok {
			return out
		}
	}
	return data
}

// parseDanmakuXML 解析 B站/danmu_api 弹幕 XML（<d p="time,mode,size,color,...">text</d>），
// 按 time 升序。danmu_api 的 format=xml 输出同构，共用此解析器。
func parseDanmakuXML(data []byte) []map[string]any {
	reD := regexp.MustCompile(`<d p="([^"]+)"[^>]*>(.*?)</d>`)
	unescape := strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'", "&apos;", "'", "&amp;", "&")
	items := []map[string]any{}
	for _, m := range reD.FindAllStringSubmatch(string(data), -1) {
		p := strings.Split(m[1], ",")
		if len(p) < 5 {
			continue
		}
		t, perr := strconv.ParseFloat(p[0], 64)
		if perr != nil {
			continue
		}
		mode, _ := strconv.Atoi(p[1])
		color, _ := strconv.ParseInt(p[3], 10, 64)
		// 桌面 DanmakuItem.type 语义：1/2/3=滚动 4=底部 5=顶部（B站 mode 同义，6/7+ 归滚动）
		dmType := mode
		if dmType != 4 && dmType != 5 {
			dmType = 1
		}
		// type/color 一律存 float64：与 JSON 反序列化后的形态保持一致，
		// 否则同一份数据「刚拉取」与「缓存回读」两种形态字段类型不同（见 jsInt 注释）。
		items = append(items, map[string]any{
			"time":  t,
			"type":  float64(dmType),
			"color": float64(color),
			"text":  unescape.Replace(m[2]),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["time"]) < jsNum(items[j]["time"])
	})
	return items
}

// jsInt 宽容读取整数字段：JSON 反序列化后是 float64，但进程内构造的条目可能是 int。
// [v1.11.0] 修 bug：屏蔽类型用 jsNum 读取，而 jsNum 只认 float64——parseDanmakuXML 存 int
// 的 type 恒被读成 0，「按类型屏蔽」对刚拉取的 B站 弹幕静默失效（只有落盘缓存回读后才偶然生效）。
func jsInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	default:
		return 0
	}
}

// biliFilterDanmaku 屏蔽过滤：类型（1/2/3 滚动 4 底部 5 顶部，逗号分隔）+ 黑名单（每行一个子串）。
func (b *Bridge) biliFilterDanmaku(items []map[string]any) []map[string]any {
	blockTypes := map[int]bool{}
	for _, s := range strings.Split(getSetting(b.cfg, "biliDanmakuBlockTypes"), ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			blockTypes[n] = true
		}
	}
	var blacklist []string
	for _, ln := range strings.Split(getSetting(b.cfg, "biliDanmakuBlacklist"), "\n") {
		if s := strings.TrimSpace(ln); s != "" {
			blacklist = append(blacklist, s)
		}
	}
	if len(blockTypes) == 0 && len(blacklist) == 0 {
		return items
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if blockTypes[jsInt(it["type"])] {
			continue
		}
		text := jsStr(it["text"])
		blocked := false
		for _, kw := range blacklist {
			if kw != "" && strings.Contains(text, kw) {
				blocked = true
				break
			}
		}
		if !blocked {
			out = append(out, it)
		}
	}
	return out
}

// danmuMinCountDefault 弹幕下限默认值：命中条数（过滤后）低于该值就继续往下探源。
//
// [v1.11.1] 由 20 提到 100：源链改为「自建源 → B站 → 弹弹play 兜底」后，这个阈值同时决定
// 「多少条算够用、不必再找更全的源」。提到 100 后，B站 只拿到零星几条（低活跃搬运/剪辑）
// 的集也会继续往弹弹play 探一次，弹幕体验更稳。0=不启用（拿到多少算多少）。
const danmuMinCountDefault = 100

// danmuMinCount 弹幕下限：命中条数（过滤后）低于该值时继续尝试下一个源补源。
// 0=不启用；未设置/非法值用 danmuMinCountDefault（设置页可改）。
func (b *Bridge) danmuMinCount() int64 {
	if n, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "danmuMinCount")), 10, 64); err == nil && n >= 0 {
		return n
	}
	return danmuMinCountDefault
}

// danmuServeResult [v1.2.7] 优选源结果落磁盘缓存并返回（danmakuPrepare 命中/补源回退共用）。
// srcKey/srcLabel 为弹幕来源（key 用于标记 used，label 为展示名）。
// note 非空时写进 meta.error —— 前端「来源详情→备注」行原样展示（换源/保留原因排障可见）。
// sources 为三源各自的溯源明细（网页端「来源详情」按源分列展示）。
//
// ⚠ 不回 cookieStatus：那是 B站 登录态，只对 B站 链路有意义。优选源（自建/弹弹play）与
// B站 Cookie 无关，带上会让网页端来源弹窗显示「未登录」并弹红色警告横幅（用户看着满屏
// 正常弹幕却被提示「弹幕数量受限」）。渲染端在 cookieStatus 缺失时不显示该行。
func (b *Bridge) danmuServeResult(w http.ResponseWriter, title string, ep, season int64, isMovie bool,
	srcKey, srcLabel string, items, kept []map[string]any, note string,
	sources []danmuSourceDetail) {
	sources = danmuMarkUsed(sources, srcKey, len(items), len(kept))
	meta := map[string]any{
		"searchTitle": title, "matchedTitle": title, "source": srcLabel,
		"ep": ep, "isMovie": isMovie, "season": season, "count": len(kept),
		"sources": danmuSortSources(sources),
		// checkedAt：本次已跑完整链路（含全部优选源）的时刻。缓存条数低于下限时，
		// danmakuPrepare 靠它判断 TTL 内是否需要重跑上游（避免反复探测）。
		"checkedAt": float64(time.Now().Unix()),
	}
	if note != "" {
		meta["error"] = note
	}
	if dmPath := b.danmuCachePath(title, season, ep); dmPath != "" {
		if data, err := json.Marshal(map[string]any{"items": items, "meta": meta}); err == nil {
			tmp := dmPath + ".tmp"
			if os.WriteFile(tmp, data, 0o644) == nil {
				_ = os.Rename(tmp, dmPath)
			}
		}
	}
	maxScreen := int64(0)
	if ms, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "biliDanmakuMaxScreen")), 10, 64); err == nil && ms >= 0 {
		maxScreen = ms
	}
	logf("[danmaku] ✅ %s弹幕就绪: title=%q count=%d", srcLabel, title, len(kept))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": ep, "isMovie": isMovie,
		"count": len(kept), "items": kept, "source": srcLabel,
		"meta": meta, "maxScreen": maxScreen,
	})
}

// danmuSourceDetail 单个弹幕源「本次尝试」的溯源信息。
//
// [v1.11.0] 网页端「来源详情」按源分列展示（三个源各自的匹配结果都可见）：
// 此前只回最终采用的那个源，另两个源匹配到什么都丢失了 —— 用户看不到「弹弹play 命中了
// 哪一集」「自建源为什么没被采用」「B站 是否登录」，排障只能靠 meta.error 一句话备注。
//
// 字段分两类：身份（各源专属：episodeId / bvid / cid / 凭证来源）与结果（条数 / 是否采用 / 原因）。
type danmuSourceDetail struct {
	Key   string `json:"key"`   // bilibili | dandanplay | danmu_api
	Label string `json:"label"` // 展示名（与 meta.source 同源，保证一致）
	// Enabled=false 表示该源本次未参与（开关关掉/未配置）。
	Enabled bool `json:"enabled"`
	// Used 表示最终采用的就是这个源。
	Used bool `json:"used"`
	// RawCount=拉取原始条数；Count=屏蔽过滤后条数；Blocked=被屏蔽规则挡掉的条数。
	RawCount int `json:"rawCount"`
	Count    int `json:"count"`
	Blocked  int `json:"blocked"`
	// Note 为未采用/失败原因（人话，直接展示）。
	Note string `json:"note,omitempty"`
	// 以下为各源专属身份字段（不适用则省略）。
	MatchedTitle string  `json:"matchedTitle,omitempty"`
	EpisodeTitle string  `json:"episodeTitle,omitempty"`
	EpisodeID    int64   `json:"episodeId,omitempty"`
	Bvid         string  `json:"bvid,omitempty"`
	Cid          int64   `json:"cid,omitempty"`
	Sim          float64 `json:"sim,omitempty"`
	Credential   string  `json:"credential,omitempty"` // 弹弹play：内置 / 自定义
	Base         string  `json:"base,omitempty"`       // 自建源：服务地址（脱敏）
}

// loginLabel B站 登录态的中文标签（来源详情展示用）。
func loginLabel(hasCookie bool) string {
	if hasCookie {
		return "已登录（SESSDATA）"
	}
	return "未登录（匿名）"
}

// biliNote B站 源未参与时的原因文案。
func biliNote(biliSearch bool) string {
	if !biliSearch {
		return "已关闭（网页播放器内开关）"
	}
	return ""
}

// pickNote 三源全空时 B站 明细的备注（把实际卡在哪一步写清楚）。
func pickNote(biliSearch bool, res *biliResolveResult) string {
	if !biliSearch {
		return "已关闭（网页播放器内开关）"
	}
	if res == nil {
		return "搜索无匹配条目"
	}
	if res.reason != "" {
		return res.reason
	}
	return "未拿到弹幕"
}

// upsertSource 用实际查到的源明细替换占位项（按 key 定位），不存在则追加。
// 占位项已有的 note 在新明细未带时保留 —— 如「已关闭/未启用」这类状态不该被抹掉。
func upsertSource(list []danmuSourceDetail, d danmuSourceDetail) []danmuSourceDetail {
	for i := range list {
		if list[i].Key == d.Key {
			if d.Note == "" {
				d.Note = list[i].Note
			}
			list[i] = d
			return list
		}
	}
	return append(list, d)
}

// danmuSourceKeys 三个源的展示顺序：与源链优先级一致（自建源 → B站 → 弹弹play 兜底）。
// 未参与的源也占位说明，用户在来源详情里能看到「这个源存在但没开/没命中」。
var danmuSourceKeys = []string{"danmu_api", "bilibili", "dandanplay"}

// danmuSortSources 按固定顺序排列源详情，保证同一次响应内顺序稳定。
func danmuSortSources(in []danmuSourceDetail) []danmuSourceDetail {
	if len(in) <= 1 {
		return in
	}
	order := map[string]int{}
	for i, k := range danmuSourceKeys {
		order[k] = i
	}
	out := make([]danmuSourceDetail, len(in))
	copy(out, in)
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Key] < order[out[j].Key] })
	return out
}

// danmuSourceOf 取某个 key 的详情（不存在返回零值 + false）。
func danmuSourceOf(list []danmuSourceDetail, key string) (danmuSourceDetail, bool) {
	for _, d := range list {
		if d.Key == key {
			return d, true
		}
	}
	return danmuSourceDetail{}, false
}

// danmuMarkUsed 标记最终采用的源并写入其条数（其余源保持未采用）。
func danmuMarkUsed(list []danmuSourceDetail, key string, raw, count int) []danmuSourceDetail {
	for i := range list {
		if list[i].Key == key {
			list[i].Used = true
			list[i].RawCount = raw
			list[i].Count = count
			list[i].Blocked = raw - count
			list[i].Note = ""
			break
		}
	}
	return list
}

// danmuProbeTTL 「补源探测」的最小间隔。
//
// 缓存条数低于下限（danmuMinCount，默认 100）时会继续跑源链找更全的源 —— 这是有意义的（用户可能刚
// 配好自建源）。但旧实现每次播放都重跑，薄弹幕集反复播放会反复打上游弹幕接口，与规约
// 「缓存数据以减少请求次数」相悖。故记录上次探测时刻，TTL 内不再重复探测，直接用缓存。
const danmuProbeTTL = 6 * time.Hour

// danmuCacheCheckedRecently 缓存是否在探测 TTL 内已跑过完整链路。
// checkedAt 由 danmuServeResult / B站写缓存分支打点（走完链路才写）。
func danmuCacheCheckedRecently(meta map[string]any) bool {
	ts, ok := meta["checkedAt"].(float64)
	if !ok || ts <= 0 {
		return false
	}
	return time.Since(time.Unix(int64(ts), 0)) < danmuProbeTTL
}

// danmuCacheKey 磁盘缓存文件路径（title|season|ep 键；空配置目录返回空串）。
func (b *Bridge) danmuCachePath(title string, season, ep int64) string {
	base := b.cfg.Dir()
	if base == "" {
		return ""
	}
	dir := filepath.Join(base, "danmaku-cache")
	_ = os.MkdirAll(dir, 0o755)
	sum := md5.Sum([]byte(title + "|" + strconv.FormatInt(season, 10) + "|" + strconv.FormatInt(ep, 10)))
	return filepath.Join(dir, "dm_"+hex.EncodeToString(sum[:10])+".json")
}

// danmuReadCache 读磁盘缓存 → (原始条目, 过滤后条目, meta)。无缓存/损坏返回 nil。
func (b *Bridge) danmuReadCache(cachePath string) ([]map[string]any, []map[string]any, map[string]any) {
	if cachePath == "" {
		return nil, nil, nil
	}
	data, err := os.ReadFile(cachePath)
	if err != nil || len(data) <= 8 {
		return nil, nil, nil
	}
	var cached struct {
		Items []map[string]any `json:"items"`
		Meta  map[string]any   `json:"meta"`
	}
	if json.Unmarshal(data, &cached) != nil || len(cached.Items) == 0 {
		return nil, nil, nil
	}
	kept := b.biliFilterDanmaku(cached.Items)
	sort.SliceStable(kept, func(i, j int) bool { return jsNum(kept[i]["time"]) < jsNum(kept[j]["time"]) })
	return cached.Items, kept, cached.Meta
}

// danmuCacheSource 从缓存 meta 反解来源 key/label（缓存可能是任一源写入的）。
func danmuCacheSource(meta map[string]any) (key, label string) {
	switch s := jsStr(meta["source"]); s {
	case ddpSourceLabel:
		return "dandanplay", ddpSourceLabel
	case danmuSourceLabel:
		return "danmu_api", danmuSourceLabel
	case "":
		return "bilibili", "B站"
	default:
		// B站 链路写入的是 "bangumi"/"video"（来源区域），统一归到 bilibili
		return "bilibili", "B站"
	}
}

// danmuServeCacheOnly 纯缓存命中直接返回（不跑任何上游链路）。
//
// [v1.11.0] 官方规约要求「缓存 API 返回的数据，以减少对服务器的请求次数」。旧实现把缓存判断
// 放在优选源链之后 —— 每次播放同一集都会重新调自建源/弹弹play，缓存形同虚设（实测二次
// prepare 上游弹幕请求 +1）。改为链前判断：命中且条数达标即零上游请求返回。
func (b *Bridge) danmuServeCacheOnly(w http.ResponseWriter, title string, ep, season int64, isMovie bool,
	items, kept []map[string]any, meta map[string]any) {
	key, label := danmuCacheSource(meta)
	logf("[danmaku] 缓存命中（零上游请求）: %d 条 → 过滤后 %d 条 source=%s", len(items), len(kept), label)
	srcs := []danmuSourceDetail{
		{Key: "danmu_api", Label: danmuSourceLabel, Enabled: b.danmuIsActive(), Note: "未参与本次播放（命中缓存）"},
		{Key: "dandanplay", Label: ddpSourceLabel, Enabled: b.ddpEnabled(),
			Credential: ddpCredentialLabel(b), Note: "未参与本次播放（命中缓存）"},
		{Key: "bilibili", Label: "B站", Enabled: true,
			Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""),
			Note:       "未参与本次播放（命中缓存）"},
	}
	for i := range srcs {
		if srcs[i].Key == key {
			srcs[i].Enabled = true
			srcs[i].Note = "命中本地缓存"
			srcs[i].MatchedTitle = jsStr(meta["matchedTitle"])
			if v, ok := meta["episodeId"].(float64); ok && v > 0 {
				srcs[i].EpisodeID = int64(v)
			}
			if b := jsStr(meta["bvid"]); b != "" {
				srcs[i].Bvid = b
			}
			if v, ok := meta["cid"].(float64); ok && v > 0 {
				srcs[i].Cid = int64(v)
			}
		}
	}
	meta["sources"] = danmuSortSources(danmuMarkUsed(srcs, key, len(items), len(kept)))
	meta["fromCache"] = true
	maxScreen := int64(0)
	if ms, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "biliDanmakuMaxScreen")), 10, 64); err == nil && ms >= 0 {
		maxScreen = ms
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": ep, "isMovie": isMovie,
		"count": len(kept), "items": kept, "source": label,
		"meta": meta, "maxScreen": maxScreen, "fromCache": true,
	})
}

// danmuPreferred 优选源裁决状态：未被 B站 顶替时保留「条数最多」的那个优选源结果。
// [v1.11.0] 优选源从单一 danmu_api 扩为 danmu_api → 弹弹play 链：逐个尝试，
// 低于下限则往下试（后面的源可能更全），B站仍作为最后补源。
type danmuPreferred struct {
	key   string
	label string
	items []map[string]any
	kept  []map[string]any
}

// consider 记录候选：条数多者胜出（同级保留先到者，尊重源优先级）。
func (p *danmuPreferred) consider(key, label string, items, kept []map[string]any) {
	if p == nil || len(kept) == 0 {
		return
	}
	if len(kept) > len(p.kept) {
		p.key, p.label, p.items, p.kept = key, label, items, kept
	}
}

// biliResolveResult B站 解析结果（供 danmakuPrepare 按新链序编排）。
type biliResolveResult struct {
	items  []map[string]any // 未过滤原始条目
	kept   []map[string]any // 屏蔽过滤后
	detail danmuSourceDetail
	title  string  // 命中的条目名（B站 标题）
	bvid   string  // 视频区命中时的 bvid
	cid    int64   // 弹幕库 id
	sim    float64 // 匹配相似度（视频区固定 0.6）
	source string  // bangumi | video（来源区域）
	reason string  // 未命中原因（人话，用于来源详情）
}

// biliResolve 跑完整 B站 链路：PGC 搜索（番剧/国创）→ 选集 → cid → 拉弹幕 → 过滤。
// 抽成函数是为了让 danmakuPrepare 能自由编排源序（弹弹play 降为兜底后需把 B站 提前）。
// 返回 nil 表示未找到匹配（reason 说明原因）。
func (b *Bridge) biliResolve(title string, ep, season int64) *biliResolveResult {
	login := loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != "")

	// ① 视频区（UP主搬运，弹幕主力，匿名即可用）
	//
	// [v1.11.1] 候选改为「逐个试到有弹幕为止」：搜索结果首位常是低活跃 reaction/剪辑
	// （实测「葬送的芙莉莲」首位仅 2 条弹幕），旧实现取首个候选就定案 → 白落到弹弹play 兜底，
	// 白白消耗配额。B站 免费、弹弹play 有配额，故宁可多试两个 B站 候选。
	// [v1.3.0] 旧 media_ft 兜底删除：桌面端实测「media_ft 为影视分区，不予采用」。
	minCnt := b.danmuMinCount()
	var fallback *biliResolveResult // 试遍都很少：留条数最多的那个，仍交给上层裁决
	tried := 0
	for _, v := range b.biliSearchVideos(title, 5) {
		if tried >= 3 { // 上限 3 个候选：够覆盖「首位是剪辑」的常见情形，又不至于放大请求
			break
		}
		bvid := jsStr(v["bvid"])
		cid := b.biliCidFromBvid(bvid, ep)
		if cid <= 0 {
			continue
		}
		tried++
		cand := &biliResolveResult{
			title: jsStr(v["title"]), bvid: bvid, cid: cid, sim: 0.6, source: "video",
			detail: danmuSourceDetail{
				Key: "bilibili", Label: "B站", Enabled: true,
				MatchedTitle: jsStr(v["title"]), Bvid: bvid, Cid: cid, Sim: 0.6,
				Credential: login,
			},
		}
		cand.items = b.biliFetchDanmakuXML(cid)
		if len(cand.items) == 0 {
			cand.reason = biliNoDataReason()
			cand.detail.Note = cand.reason
			if fallback == nil {
				fallback = cand
			}
			continue
		}
		cand.kept = b.biliFilterDanmaku(cand.items)
		cand.detail.RawCount = len(cand.items)
		cand.detail.Count = len(cand.kept)
		cand.detail.Blocked = len(cand.items) - len(cand.kept)
		if minCnt <= 0 || len(cand.kept) >= int(minCnt) {
			logf("[danmaku] B站 候选命中（第 %d 个）: %q %d 条", tried, cand.title, len(cand.kept))
			return cand
		}
		// 条数不足：记下当前最好的，继续试下一个候选
		if fallback == nil || len(cand.kept) > len(fallback.kept) {
			fallback = cand
		}
	}
	if fallback != nil && len(fallback.kept) > 0 {
		// 有弹幕但都低于下限：返回条数最多的那个，交给上层与弹弹play 裁决
		logf("[danmaku] B站 候选均低于下限，取最多者: %q %d 条", fallback.title, len(fallback.kept))
		return fallback
	}
	if fallback != nil && fallback.reason != "" && tried > 0 {
		// 候选都无弹幕（含被限流）：保留明细与原因，让来源详情能说明卡在哪一步，
		// 而不是让上层只看到「搜索无匹配条目」（会把限流误报成内容缺失）。
		logf("[danmaku] B站 候选均未取到弹幕（试了 %d 个）: %s", tried, fallback.reason)
		return fallback
	}

	// ② PGC 番剧区（需登录态：匿名搜索恒空）
	// ⚠ 必须放在「视频区一个弹幕都没拿到」之后才可达：视频区命中但该集无弹幕时**不能提前返回**，
	// 否则登录态用户的 PGC 正版番剧链路永远走不到（正片弹幕恰恰在那里）。
	for _, st := range []string{"1", "4"} {
		for _, c := range b.biliSearchPGC(title, season, st) {
			eps := b.biliSeasonEpisodes(c.ID)
			if len(eps) == 0 {
				continue
			}
			e := biliPickEpisode(eps, ep)
			if e == nil {
				continue
			}
			cid := int64(jsNum(e["cid"]))
			if cid <= 0 {
				continue
			}
			out := &biliResolveResult{
				title: c.Title, cid: cid, sim: c.Sim, source: "bangumi",
				detail: danmuSourceDetail{
					Key: "bilibili", Label: "B站", Enabled: true,
					MatchedTitle: c.Title, Cid: cid, Sim: c.Sim, Credential: login,
				},
			}
			out.items = b.biliFetchDanmakuXML(cid)
			if len(out.items) == 0 {
				out.reason = biliNoDataReason()
				out.detail.Note = out.reason
				return out
			}
			out.kept = b.biliFilterDanmaku(out.items)
			out.detail.RawCount = len(out.items)
			out.detail.Count = len(out.kept)
			out.detail.Blocked = len(out.items) - len(out.kept)
			logf("[danmaku] B站 番剧区命中: %q %d 条", out.title, len(out.kept))
			return out
		}
	}
	return nil
}

// danmakuPrepare POST {title, ep, season, isMovie, biliSearch} → B站弹幕搜索+拉取。
// 元数据（标题/集数/季）由前端直连 play/info 解析后传入；返回桌面版 danmaku:prepare 同形状。
func (b *Bridge) danmakuPrepare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title      string `json:"title"`
		Ep         int64  `json:"ep"`
		Season     int64  `json:"season"`
		IsMovie    bool   `json:"isMovie"`
		BiliSearch *bool  `json:"biliSearch"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少标题"})
		return
	}
	biliSearch := req.BiliSearch == nil || *req.BiliSearch

	// [v1.11.0] 磁盘缓存前置：命中即零上游请求返回。
	// 官方规约明确要求「缓存 API 返回的数据，以减少对服务器的请求次数」；旧实现把缓存判断
	// 放在优选源链之后，导致每次播放同一集都重新搜索+拉取上游（实测二次 prepare 上游弹幕 +1），
	// 缓存等于没生效。缓存存的是未过滤原始条目，故屏蔽设置改动仍即时生效。
	cachePath := b.danmuCachePath(title, req.Season, req.Ep)
	if cachedItems, cachedKept, cachedMeta := b.danmuReadCache(cachePath); cachedItems != nil {
		if minCnt := b.danmuMinCount(); minCnt <= 0 || len(cachedKept) >= int(minCnt) {
			b.danmuServeCacheOnly(w, title, req.Ep, req.Season, req.IsMovie, cachedItems, cachedKept, cachedMeta)
			return
		}
		// 薄弹幕集（低于下限）：只在探测 TTL 过后才重跑链路找更全的源，
		// 否则直接用缓存 —— 避免反复播放同一集时反复打上游弹幕接口。
		if minCnt := b.danmuMinCount(); minCnt > 0 && danmuCacheCheckedRecently(cachedMeta) {
			logf("[danmaku] 缓存 %d 条低于下限但近期已探测过上游（%s 内）→ 直接用缓存",
				len(cachedKept), danmuProbeTTL)
			b.danmuServeCacheOnly(w, title, req.Ep, req.Season, req.IsMovie, cachedItems, cachedKept, cachedMeta)
			return
		}
		logf("[danmaku] 缓存仅 %d 条 < 下限 %d → 尝试上游补源", len(cachedKept), b.danmuMinCount())
	}

	// 弹幕源链（按优先级依次尝试）：自建源 danmu_api → B站 → 弹弹play（兜底）。
	//
	// [v1.11.1] 弹弹play 降为兜底源：其开放 API 有配额限制（用户额度不多），
	// 而 B站 链路免费且是本站弹幕主力。改为「只在前面都没拿到足量弹幕时才消耗弹弹play 额度」：
	//   ① 自建源命中且达标 → 直接用（不碰 B站/弹弹play）
	//   ② B站 命中且达标 → 直接用（不碰弹弹play）—— 绝大多数播放走这条
	//   ③ 前面都失败/条数不足 → 才请求弹弹play 兜底
	// 命中且过滤后条数达标即返回；低于下限（danmuMinCount，默认 100）则继续试下一个源。
	// [v0.81.0] 各源尝试结论带进最终错误信息（供弹窗「备注」展示，排障可见）。
	// [v1.11.0] 三源明细全部收集进 sources（网页端「来源详情」按源分列，未参与的源也占位说明）。
	var reasons []string
	var pref danmuPreferred
	sources := []danmuSourceDetail{

		{Key: "bilibili", Label: "B站",
			Enabled:    biliSearch,
			Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""),
			Note:       biliNote(biliSearch)},
	}
	if b.danmuIsActive() {
		items, reason, detail := b.danmuAutoFetch(title, req.Ep, req.Season)
		if len(items) > 0 {
			kept := b.biliFilterDanmaku(items)
			if minCnt := b.danmuMinCount(); minCnt <= 0 || len(kept) >= int(minCnt) {
				detail.Note = ""
				b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, "danmu_api", danmuSourceLabel,
					items, kept, "", upsertSource(sources, detail))
				return
			}
			pref.consider("danmu_api", danmuSourceLabel, items, kept)
			logf("[danmaku] 自建源仅 %d 条 < 下限 %d → 尝试下一个源: title=%q", len(kept), b.danmuMinCount(), title)
			reasons = append(reasons, fmt.Sprintf("自建源 %d 条", len(kept)))
			detail.Note = fmt.Sprintf("命中 %d 条，低于下限 %d，未采用", len(kept), b.danmuMinCount())
		} else if reason != "" {
			reasons = append(reasons, "自建源("+reason+")")
		}
		sources = append(sources, detail)
	} else {
		// 未启用也要占位：用户在来源详情里能看到「这个源存在但没开」
		sources = append(sources, danmuSourceDetail{Key: "danmu_api", Label: danmuSourceLabel, Note: "未启用"})
	}
	// ② B站（免费链路，优先于弹弹play）
	var biliRes *biliResolveResult
	if biliSearch {
		biliRes = b.biliResolve(title, req.Ep, req.Season)
		switch {
		case biliRes == nil:
			sources = upsertSource(sources, danmuSourceDetail{
				Key: "bilibili", Label: "B站", Enabled: true,
				Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""),
				Note:       "搜索无匹配条目",
			})
			reasons = append(reasons, "B站(搜索无匹配条目)")
		case len(biliRes.kept) > 0:
			if minCnt := b.danmuMinCount(); minCnt <= 0 || len(biliRes.kept) >= int(minCnt) {
				b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, "bilibili", "B站",
					biliRes.items, biliRes.kept, "", upsertSource(sources, biliRes.detail))
				return
			}
			// 条数不足：记入候选并继续往弹弹play 兜底探一次（可能更全）
			pref.consider("bilibili", "B站", biliRes.items, biliRes.kept)
			biliRes.detail.Note = fmt.Sprintf("命中 %d 条，低于下限 %d", len(biliRes.kept), b.danmuMinCount())
			sources = upsertSource(sources, biliRes.detail)
			reasons = append(reasons, fmt.Sprintf("B站 %d 条", len(biliRes.kept)))
			logf("[danmaku] B站仅 %d 条 < 下限 %d → 尝试弹弹play 兜底: title=%q",
				len(biliRes.kept), b.danmuMinCount(), title)
		default:
			// 命中条目但该集无弹幕 / 无匹配：继续往弹弹play 兜底
			sources = upsertSource(sources, biliRes.detail)
			if biliRes.reason != "" {
				reasons = append(reasons, "B站("+biliRes.reason+")")
			}
			logf("[danmaku] B站未拿到弹幕（%s）→ 尝试弹弹play 兜底: title=%q", biliRes.reason, title)
		}
	}

	// ③ 弹弹play 开放 API（兜底源：有配额限制，仅当前序源都没拿到足量弹幕时才请求）
	if b.ddpEnabled() {
		items, matched, _, reason, detail := b.ddpAutoFetch(title, req.Ep, req.Season)
		if len(items) > 0 {
			kept := b.biliFilterDanmaku(items)
			if minCnt := b.danmuMinCount(); minCnt <= 0 || len(kept) >= int(minCnt) {
				logf("[danmaku] 弹弹play 命中: title=%q matched=%q count=%d", title, matched, len(kept))
				detail.Note = ""
				b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, "dandanplay", ddpSourceLabel,
					items, kept, "", upsertSource(sources, detail))
				return
			}
			pref.consider("dandanplay", ddpSourceLabel, items, kept)
			logf("[danmaku] 弹弹play 仅 %d 条 < 下限 %d（兜底未更优）: title=%q", len(kept), b.danmuMinCount(), title)
			reasons = append(reasons, fmt.Sprintf("弹弹play %d 条", len(kept)))
			detail.Note = fmt.Sprintf("命中 %d 条，低于下限 %d，未采用", len(kept), b.danmuMinCount())
		} else if reason != "" {
			reasons = append(reasons, "弹弹play("+reason+")")
		}
		sources = append(sources, detail)
	} else {
		sources = append(sources, danmuSourceDetail{Key: "dandanplay", Label: ddpSourceLabel, Note: "已关闭"})
	}
	// 兜底裁决：走到这里说明前序源都没拿到「达标」的弹幕。
	// 三种情况：① 无缓存且三源皆空；② 有候选但都低于下限；③ 缓存条数低于下限。
	// 统一规则：谁条数最多用谁（pref 已按条数择优），并在备注里写清为何换源。
	prefNote := strings.Join(reasons, "、")

	// 缓存存在且不比候选差 → 沿用缓存（避免白跑一趟上游还变差）
	if cachedItems, cachedKept, cachedMeta := b.danmuReadCache(cachePath); cachedItems != nil && len(pref.kept) > 0 {
		if len(cachedKept) >= len(pref.kept) {
			b.danmuServeCacheOnly(w, title, req.Ep, req.Season, req.IsMovie, cachedItems, cachedKept, cachedMeta)
			return
		}
		logf("[danmaku] 缓存 %d 条 < 候选 %d 条 → 采用候选", len(cachedKept), len(pref.kept))
	}

	if len(pref.kept) > 0 {
		note := fmt.Sprintf("%s，保留条数最多的%s（%d 条）", prefNote, pref.label, len(pref.kept))
		b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, pref.key, pref.label,
			pref.items, pref.kept, note, sources)
		return
	}

	// 三源皆空：给出可操作的失败原因
	errMsg := "未找到匹配的弹幕"
	if prefNote != "" {
		errMsg = prefNote + "；" + errMsg
	}
	if !biliSearch {
		errMsg += "；B站弹幕搜索已在播放器内关闭"
	} else if strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) == "" {
		errMsg += "；未登录B站——番剧/动漫需登录态搜索，可在设置→B站弹幕登录扫码"
	}
	sources = upsertSource(sources, danmuSourceDetail{Key: "bilibili", Label: "B站", Enabled: biliSearch,
		Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""),
		Note:       pickNote(biliSearch, biliRes)})
	logf("[danmaku] 三源均未命中: title=%q %s", title, errMsg)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0,
		"error": errMsg,
		"meta": map[string]any{
			"searchTitle": title, "matchedTitle": title, "source": "",
			"ep": req.Ep, "isMovie": req.IsMovie, "season": req.Season, "count": 0,
			"cookieStatus": cookieStatusOf(b.cfg),
			"checkedAt":    float64(time.Now().Unix()),
			"sources":      danmuSortSources(sources),
		},
	})
}

// danmakuCandidates / danmakuPick 手动搜索与选定：网页端暂未实现（占位明确报错）。
// danmakuCandidates POST {title, ep, season} → 手动搜索候选（danmu_api 优选 → B站视频区兜底）。
// [lc-1118] 复刻：只回可直接拉取的（bvid 非空）前 5 条；番剧区（无 bvid）不进候选。
func (b *Bridge) danmakuCandidates(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title  string `json:"title"`
		Ep     int64  `json:"ep"`
		Season int64  `json:"season"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少搜索关键词"})
		return
	}
	// ① 优选源候选（dmapi:<episodeId> / ddp:<episodeId> 伪 id）
	// [v1.2.7] 不再命中即短路：优选源候选排前、B站候选照常搜出附后。
	// 旧逻辑自建源命中直接 return → 手动搜索永远只回自建源候选，自建源弹幕太少时
	// 用户想搜 B站搬运，怎么搜都「没有 B站结果」，看起来就像搜索无反应。
	candidates := []map[string]any{}
	prefCount := 0
	if cands := b.danmuCandidates(title, req.Ep, req.Season); cands != nil {
		candidates = append(candidates, cands...)
		prefCount += len(cands)
	}
	// [v1.11.0] 弹弹play 候选：与自建源并列（未启用/无匹配则不占位）
	if cands := b.ddpCandidates(title, req.Ep, req.Season); cands != nil {
		candidates = append(candidates, cands...)
		prefCount += len(cands)
	}
	// ② B站候选：视频区（UP主搬运，主力）——[v1.3.0] search/all/v2（桌面端同款）
	// 旧的 media_ft 兜底删除：桌面端实测结论「media_ft 为影视分区、不含国创，不予采用」，
	// 且 wbi/search/type 匿名必被风控，纯浪费一次请求。
	biliCount := 0
	for _, v := range b.biliSearchVideos(title, 5) {
		candidates = append(candidates, map[string]any{
			"bvid":           jsStr(v["bvid"]),
			"title":          jsStr(v["title"]),
			"source":         "video",
			"is_compilation": false,
			"sim":            nil,
		})
		biliCount++
		if biliCount >= 5 {
			break
		}
	}
	logf("[danmaku] 手动搜索 keyword=%q: 优选源 %d 条 + B站 %d 条", title, prefCount, biliCount)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "candidates": candidates})
}

// danmakuPick POST {title, ep, season, isMovie, bvid} → 用户选定条目直接拉弹幕并落缓存。
// bvid 支持 `dmapi:<episodeId>`（自建源）与 B站 bvid；选定结果落缓存后下次自动加载直接命中。
func (b *Bridge) danmakuPick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title   string `json:"title"`
		Ep      int64  `json:"ep"`
		Season  int64  `json:"season"`
		IsMovie bool   `json:"isMovie"`
		Bvid    string `json:"bvid"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	title := strings.TrimSpace(req.Title)
	bvid := strings.TrimSpace(req.Bvid)
	if title == "" || bvid == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少 title/bvid"})
		return
	}
	var items []map[string]any
	source := "bilibili"
	// [v1.11.0] 手选场景也要有溯源明细：用户从候选里选定的那条属于哪个源、命中什么，弹窗照常展示。
	var detail danmuSourceDetail
	// parsePseudoID 解析优选源伪 id（dmapi:<episodeId> / ddp:<episodeId>）为整数集 id。
	parsePseudoID := func(prefix string) (int64, bool) {
		s := strings.TrimSpace(strings.TrimPrefix(bvid, prefix))
		id, err := strconv.ParseInt(s, 10, 64)
		return id, err == nil && id > 0
	}
	switch {
	case strings.HasPrefix(bvid, danmuIDPrefix):
		// 自建源：按 episodeId 直取。[v1.4.5] 解析改为整数字符串直解（旧 jsNum 只认
		// float64，字符串恒 0 → 历史/异构端生成的合法 id 一律报「自建源候选 id 无效」）。
		id, ok := parsePseudoID(danmuIDPrefix)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "自建源候选 id 无效"})
			return
		}
		items = b.danmuFetchItems(id)
		source = danmuSourceLabel
		detail = danmuSourceDetail{
			Key: "danmu_api", Label: danmuSourceLabel, Enabled: true, EpisodeID: id,
			Base: danmuMaskBase(b.danmuBase()), Note: "手动选定",
		}
	case strings.HasPrefix(bvid, ddpIDPrefix):
		// [v1.11.0] 弹弹play：按 episodeId 直取
		id, ok := parsePseudoID(ddpIDPrefix)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "弹弹play 候选 id 无效"})
			return
		}
		items = b.ddpFetchItems(id)
		source = ddpSourceLabel
		detail = danmuSourceDetail{
			Key: "dandanplay", Label: ddpSourceLabel, Enabled: true, EpisodeID: id,
			Credential: ddpCredentialLabel(b), Note: "手动选定",
		}
	default:
		// B站：bvid → cid（view 接口，桌面 cid_from_bvid 同语义）→ list.so
		cid := b.biliCidFromBvid(bvid, req.Ep)
		if cid <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未找到视频 cid（视频可能已删除/充电视频，详情见服务日志）"})
			return
		}
		items = b.biliFetchDanmakuXML(cid)
		detail = danmuSourceDetail{
			Key: "bilibili", Label: "B站", Enabled: true, Bvid: bvid, Cid: cid,
			Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""),
			Note:       "手动选定",
		}
	}
	if len(items) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "error": "该条目没有弹幕"})
		return
	}
	kept := b.biliFilterDanmaku(items)
	// 落缓存（与 prepare 同键：title|season|ep → 下次自动加载直接命中用户选定）
	var cachePath string
	if base := b.cfg.Dir(); base != "" {
		dir := filepath.Join(base, "danmaku-cache")
		_ = os.MkdirAll(dir, 0o755)
		sum := md5.Sum([]byte(title + "|" + strconv.FormatInt(req.Season, 10) + "|" + strconv.FormatInt(req.Ep, 10)))
		cachePath = filepath.Join(dir, "dm_"+hex.EncodeToString(sum[:10])+".json")
	}
	// [v1.11.0] 手动选定：三源都占位（与 prepare 同形），仅选定的那个标 used 并带明细。
	// 只回一个源会让「来源详情」在手动选定后丢掉另外两源的状态，展示与自动命中不一致。
	danmuOn := b.danmuIsActive()
	ddpOn := b.ddpEnabled()
	danmuNote, ddpNote := "未启用", "已关闭"
	danmuBase := ""
	if danmuOn {
		danmuNote = "未参与本次手动选定"
		danmuBase = danmuMaskBase(b.danmuBase())
	}
	if ddpOn {
		ddpNote = "未参与本次手动选定"
	}
	all := []danmuSourceDetail{
		{Key: "danmu_api", Label: danmuSourceLabel, Enabled: danmuOn,
			Base: danmuBase, Note: danmuNote},
		{Key: "dandanplay", Label: ddpSourceLabel, Enabled: ddpOn,
			Credential: ddpCredentialLabel(b), Note: ddpNote},
		{Key: "bilibili", Label: "B站", Enabled: true,
			Credential: loginLabel(strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != "")},
	}
	all = upsertSource(all, detail)
	meta := map[string]any{
		"searchTitle": title, "matchedTitle": title, "source": source,
		"ep": req.Ep, "isMovie": req.IsMovie, "season": req.Season, "count": len(kept),
		"sources": danmuSortSources(danmuMarkUsed(all, detail.Key, len(items), len(kept))),
	}
	if cachePath != "" {
		if data, err := json.Marshal(map[string]any{"items": items, "meta": meta}); err == nil {
			tmp := cachePath + ".tmp"
			if os.WriteFile(tmp, data, 0o644) == nil {
				_ = os.Rename(tmp, cachePath)
			}
		}
	}
	maxScreen := int64(0)
	if ms, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "biliDanmakuMaxScreen")), 10, 64); err == nil && ms >= 0 {
		maxScreen = ms
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": req.Ep, "isMovie": req.IsMovie,
		"count": len(kept), "items": kept, "source": source,
		"meta": meta, "maxScreen": maxScreen,
	})
}
