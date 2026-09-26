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
	"time"
)

const biliWebAPI = "https://api.bilibili.com"

// biliEncTable WBI mixin 重排表（B站官方算法，与桌面版 bili_danmaku.js ENC 一致）
var biliEncTable = [64]int{46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52}

var biliNavCache struct {
	mu      sync.Mutex
	ik, sk  string
	exp     time.Time
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
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	data = decompressDanmakuBody(data)
	if len(data) < 16 {
		return nil
	}
	return parseDanmakuXML(data)
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
		items = append(items, map[string]any{
			"time":  t,
			"type":  dmType,
			"color": color,
			"text":  unescape.Replace(m[2]),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["time"]) < jsNum(items[j]["time"])
	})
	return items
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
		if blockTypes[int(jsNum(it["type"]))] {
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

// danmuMinCount [v1.2.7] 自建源弹幕下限：命中条数（过滤后）低于该值时自动请求 B站补源，
// B 站拿到更多才换、否则保留自建源。0=不启用；未设置/非法值默认 20（设置页可改）。
func (b *Bridge) danmuMinCount() int64 {
	if n, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "danmuMinCount")), 10, 64); err == nil && n >= 0 {
		return n
	}
	return 20
}

// danmuServeResult [v1.2.7] 自建源结果落磁盘缓存并返回（danmakuPrepare 命中/补源回退共用）。
// note 非空时写进 meta.error —— 前端「来源详情→备注」行原样展示（换源/保留原因排障可见）。
func (b *Bridge) danmuServeResult(w http.ResponseWriter, title string, ep, season int64, isMovie bool,
	items, kept []map[string]any, note string) {
	meta := map[string]any{
		"searchTitle": title, "matchedTitle": title, "source": danmuSourceLabel,
		"ep": ep, "isMovie": isMovie, "season": season, "count": len(kept),
		"cookieStatus": cookieStatusOf(b.cfg),
	}
	if note != "" {
		meta["error"] = note
	}
	if base := b.cfg.Dir(); base != "" {
		dir := filepath.Join(base, "danmaku-cache")
		_ = os.MkdirAll(dir, 0o755)
		sum := md5.Sum([]byte(title + "|" + strconv.FormatInt(season, 10) + "|" + strconv.FormatInt(ep, 10)))
		dmPath := filepath.Join(dir, "dm_"+hex.EncodeToString(sum[:10])+".json")
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
	logf("[danmaku] ✅ 自建源弹幕就绪: title=%q count=%d", title, len(kept))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": ep, "isMovie": isMovie,
		"count": len(kept), "items": kept, "source": danmuSourceLabel,
		"meta": meta, "maxScreen": maxScreen,
	})
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

	// [v0.75.0] danmu_api 自建源优选：启用时最先尝试（命中直接返回；未命中降级下面的 B站链路）。
	// 自建源启用期间旧 B站缓存不命中（桌面 lc-1101 同语义：缓存来源要与当前设置匹配）。
	// [v0.81.0] 自建源尝试结论带进最终错误信息（供弹窗「备注」展示，排障可见）。
	// [v1.2.7] 自建源弹幕下限（danmuMinCount，默认 20）：命中但过滤后条数低于下限时不再直接返回，
	// 而是继续走下面的 B站链路补源——B 站拿到更多才换、否则保留自建源（备注写进 meta.error）。
	danmuReason := ""
	var danmuItems, danmuKept []map[string]any
	if b.danmuIsActive() {
		items, reason := b.danmuAutoFetch(title, req.Ep, req.Season)
		danmuReason = reason
		if len(items) > 0 {
			kept := b.biliFilterDanmaku(items)
			if minCnt := b.danmuMinCount(); minCnt > 0 && len(kept) < int(minCnt) {
				danmuItems, danmuKept = items, kept
				logf("[danmaku] 自建源仅 %d 条 < 下限 %d → 尝试 B站补源: title=%q", len(kept), minCnt, title)
			} else {
				b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, items, kept, "")
				return
			}
		}
	}

	// 磁盘缓存（title|season|ep 键；缓存存未过滤原始条目，屏蔽设置改动即时生效）
	var cachePath string
	if base := b.cfg.Dir(); base != "" {
		dir := filepath.Join(base, "danmaku-cache")
		_ = os.MkdirAll(dir, 0o755)
		sum := md5.Sum([]byte(title + "|" + strconv.FormatInt(req.Season, 10) + "|" + strconv.FormatInt(req.Ep, 10)))
		cachePath = filepath.Join(dir, "dm_"+hex.EncodeToString(sum[:10])+".json")
	}
	if data, err := os.ReadFile(cachePath); err == nil && len(data) > 8 {
		var cached struct {
			Items []map[string]any `json:"items"`
			Meta  map[string]any   `json:"meta"`
		}
		if json.Unmarshal(data, &cached) == nil && len(cached.Items) > 0 {
			kept := b.biliFilterDanmaku(cached.Items)
			sort.SliceStable(kept, func(i, j int) bool { return jsNum(kept[i]["time"]) < jsNum(kept[j]["time"]) })
			// [v1.2.7] 自建源补源中：B站缓存更多才用，否则保留自建源
			if len(danmuKept) > 0 && len(kept) <= len(danmuKept) {
				b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, danmuItems, danmuKept,
					fmt.Sprintf("自建源仅 %d 条（低于下限），B站缓存仅 %d 条未更多，保留自建源", len(danmuKept), len(kept)))
				return
			}
			logf("[danmaku] 缓存命中: %d 条 → 过滤后 %d 条", len(cached.Items), len(kept))
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": true, "title": title, "ep": req.Ep, "isMovie": req.IsMovie,
				"count": len(kept), "items": kept, "source": "bilibili",
				"meta": cached.Meta, "fromCache": true,
			})
			return
		}
	}

	if !biliSearch {
		// [v1.2.7] 自建源补源中但 B站弹幕搜索被关：不越权请求，保留自建源
		if len(danmuKept) > 0 {
			b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, danmuItems, danmuKept,
				fmt.Sprintf("自建源仅 %d 条（低于下限），B站弹幕搜索未启用，保留自建源", len(danmuKept)))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": "B站弹幕搜索未启用"})
		return
	}

	// ① WBI PGC 搜索（番剧 → 国创）→ season_id → 选集 → cid
	type hit struct {
		cid    int64
		aid    int64
		title  string
		source string
		sim    float64
		epid   any
	}
	var best *hit
	for _, st := range []string{"1", "4"} {
		for _, c := range b.biliSearchPGC(title, req.Season, st) {
			eps := b.biliSeasonEpisodes(c.ID)
			if len(eps) == 0 {
				continue
			}
			ep := biliPickEpisode(eps, req.Ep)
			if ep == nil {
				continue
			}
			cid := int64(jsNum(ep["cid"]))
			if cid <= 0 {
				continue
			}
			best = &hit{cid: cid, aid: int64(jsNum(ep["aid"])), title: c.Title, source: "bangumi", sim: c.Sim, epid: ep["id"]}
			break
		}
		if best != nil {
			break
		}
	}
	// ② B站 兜底：视频区（UP主搬运，弹幕主力）
	if best == nil {
		for _, v := range b.biliSearchVideos(title, 5) {
			cid := b.biliCidFromBvid(jsStr(v["bvid"]), req.Ep)
			if cid <= 0 {
				continue
			}
			best = &hit{cid: cid, title: jsStr(v["title"]), source: "video", sim: 0.6}
			break
		}
	}
	// [v1.3.0] 旧 media_ft 兜底删除：桌面端实测「media_ft 为影视分区，不予采用」，
	// 且 wbi/search/type 匿名必被风控（叠加旧版 nav 密钥失败缓存，该分支从未成功过）。
	// 视频区搜索已换 search/all/v2（biliSearchVideos），弹幕主力就是它。
	if best == nil {
		// [v1.2.7] 自建源补源中但 B站没找到匹配：保留自建源（总比没有强）
		if len(danmuKept) > 0 {
			b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, danmuItems, danmuKept,
				fmt.Sprintf("自建源仅 %d 条（低于下限），B站未找到匹配，保留自建源", len(danmuKept)))
			return
		}
		errMsg := "未找到匹配的B站弹幕"
		if danmuReason != "" {
			errMsg = "自建源(" + danmuReason + ")；" + errMsg
		}
		hasCookie := strings.TrimSpace(getSetting(b.cfg, "bili_cookie")) != ""
		if !hasCookie {
			errMsg += "；未登录B站——番剧/动漫需登录态搜索，请在设置→B站弹幕登录扫码后重试"
		}
		// [v0.85.0] 失败也带 meta（渲染端手动搜索的自动填标题取 meta.searchTitle）
		failMeta := map[string]any{
			"searchTitle": title, "matchedTitle": title, "source": "",
			"ep": req.Ep, "isMovie": req.IsMovie, "season": req.Season, "count": 0,
			"cookieStatus": cookieStatusOf(b.cfg),
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": errMsg, "meta": failMeta})
		return
	}

	// ③ 拉弹幕 → 过滤
	items := b.biliFetchDanmakuXML(best.cid)
	if len(items) == 0 {
		// [v1.2.7] 自建源补源中但 B站该集没弹幕：保留自建源
		if len(danmuKept) > 0 {
			b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, danmuItems, danmuKept,
				fmt.Sprintf("自建源仅 %d 条（低于下限），B站该集没有弹幕数据，保留自建源", len(danmuKept)))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": "该集没有弹幕数据"})
		return
	}
	kept := b.biliFilterDanmaku(items)
	// [v1.2.7] 补源裁决：B 站拿到比自建源更多才换，否则保留自建源（换/留原因都写进备注）
	if len(danmuKept) > 0 {
		if len(kept) <= len(danmuKept) {
			b.danmuServeResult(w, title, req.Ep, req.Season, req.IsMovie, danmuItems, danmuKept,
				fmt.Sprintf("自建源仅 %d 条（低于下限），B站「%s」仅 %d 条未更多，保留自建源", len(danmuKept), best.title, len(kept)))
			return
		}
		logf("[danmaku] B站补源生效: 自建源 %d 条 → B站 %d 条 (%s)", len(danmuKept), len(kept), best.title)
	}

	meta := map[string]any{
		"searchTitle": title, "matchedTitle": best.title, "source": best.source,
		"cid": best.cid, "sim": best.sim, "ep": req.Ep, "isMovie": req.IsMovie,
		"season": req.Season, "count": len(kept),
		"cookieStatus": cookieStatusOf(b.cfg),
	}
	if len(danmuKept) > 0 {
		meta["error"] = fmt.Sprintf("自建源仅 %d 条（低于下限），已改用 B站「%s」（%d 条）", len(danmuKept), best.title, len(kept))
	}
	// 成功结果落盘（存未过滤原始条目，屏蔽设置改动即时生效）
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
	logf("[danmaku] 弹幕就绪: title=%q cid=%d count=%d", title, best.cid, len(kept))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": req.Ep, "isMovie": req.IsMovie,
		"count": len(kept), "items": kept, "source": "bilibili",
		"meta": meta, "maxScreen": maxScreen,
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
	// ① 自建源候选（dmapi:<episodeId> 伪 id，sim=1）
	// [v1.2.7] 不再命中即短路：自建源候选排前、B站候选照常搜出附后。
	// 旧逻辑自建源命中直接 return → 手动搜索永远只回自建源候选，自建源弹幕太少时
	// 用户想搜 B站搬运，怎么搜都「没有 B站结果」，看起来就像搜索无反应。
	candidates := []map[string]any{}
	if cands := b.danmuCandidates(title, req.Ep, req.Season); cands != nil {
		candidates = append(candidates, cands...)
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
	logf("[danmaku] 手动搜索 keyword=%q: 自建源 %d 条 + B站 %d 条", title, len(candidates)-biliCount, biliCount)
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
	if strings.HasPrefix(bvid, danmuIDPrefix) {
		// 自建源：按 episodeId 直取。[v1.4.5] 解析改为整数字符串直解（旧 jsNum 只认
		// float64，字符串恒 0 → 历史/异构端生成的合法 id 一律报「自建源候选 id 无效」）。
		idStr := strings.TrimSpace(strings.TrimPrefix(bvid, danmuIDPrefix))
		id, perr := strconv.ParseInt(idStr, 10, 64)
		if perr != nil || id <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "自建源候选 id 无效"})
			return
		}
		items = b.danmuFetchItems(id)
		source = danmuSourceLabel
	} else {
		// B站：bvid → cid（view 接口，桌面 cid_from_bvid 同语义）→ list.so
		cid := b.biliCidFromBvid(bvid, req.Ep)
		if cid <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未找到视频 cid（视频可能已删除/充电视频，详情见服务日志）"})
			return
		}
		items = b.biliFetchDanmakuXML(cid)
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
	meta := map[string]any{
		"searchTitle": title, "matchedTitle": title, "source": source,
		"ep": req.Ep, "isMovie": req.IsMovie, "season": req.Season, "count": len(kept),
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
