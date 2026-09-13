// Package bridge —— jav.go：JAV 番号刮削（个人媒体库整理用，扩展数据源 ⑤）。
// 数据源为 javbus 网页端（无官方 API，与豆瓣链路同性质的非官方抓取）：
//   GET https://{javBusDomain}/{番号}                详情页直取（URL 即番号）
//   GET https://{javBusDomain}/search/{番号}&type=1  搜索兜底（变体番号）
// 解析字段：标题、大图封面（bigImage/cover img）、发行日期、类别（/genre/ 链接）、
// 演员列表（avatar-box：头像 + 名字）。全部宽容正则 + html 反转义，字段间独立容错。
// 防误识别：番号正则的字母段过黑名单（HDR10/VP9/CD1 等技术词/分段词不算番号）。
// 网络走 extHTTP（自定义代理 > 系统直连——javbus 国内直连不通，需代理或自定义域名）；
// 结果进程内缓存 24h；封面经 /jav/image 代理下载（仅放行所配置域名）。
// 安全开关：javEnabled 默认关闭（设置面板「Jav 刮削」卡），仅整理用户本地自有媒体库的元数据。
package bridge

import (
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// javBusDomain var 而非 const：单测用 httptest 覆盖（javDomain() 未配置设置时回退到此）。
// 值可为纯域名（www.javbus.com，默认补 https://）或带 scheme 完整地址（镜像/http 站点）。
var javBusDomain = "https://www.javbus.com"

func (b *Bridge) javOn() bool { return getSetting(b.cfg, "javEnabled") == "1" }

// javDomain 设置里的域名归一：剥 scheme/尾斜杠，返回纯 host（图片门禁用）。
func (b *Bridge) javDomain() string {
	d := strings.TrimSpace(strings.ToLower(getSetting(b.cfg, "javBusDomain")))
	if d == "" {
		d = javBusDomain
	}
	if u, err := url.Parse(d); err == nil && u.Host != "" && (strings.HasPrefix(d, "http://") || strings.HasPrefix(d, "https://")) {
		return strings.ToLower(u.Hostname())
	}
	return strings.ToLower(strings.TrimRight(d, "/"))
}

// javBase 抓取基地址：带 scheme 用原值，纯域名补 https://。
func (b *Bridge) javBase() string {
	raw := strings.TrimSpace(getSetting(b.cfg, "javBusDomain"))
	if raw == "" {
		raw = javBusDomain
	}
	raw = strings.TrimRight(raw, "/")
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	return "https://" + raw
}

/* ── 番号提取 ── */

// 字母段黑名单：视频技术词/分段词（HDR10、H265、CD1、PART2 这类不算番号）。
var javTechWords = map[string]bool{
	"HDR": true, "DV": true, "DD": true, "DDP": true, "DTS": true, "HD": true, "UHD": true,
	"CD": true, "BD": true, "DVD": true, "TV": true, "VC": true, "VP": true, "AV": true,
	"SD": true, "SE": true, "EP": true, "VOL": true, "PART": true, "PT": true,
	"NTSC": true, "PAL": true, "REMUX": true, "WEB": true, "MKV": true, "MP4": true,
	"AVC": true, "ATMOS": true, "HLG": true, "SDR": true, "VVC": true, "ISO": true,
	"DC": true, "IMAX": true, "DOLBY": true, "VISION": true, "COMPLETE": true,
	"EXTENDED": true, "REMASTER": true, "REMASTERED": true, "UNRATED": true, "PROPER": true,
}

var (
	reJavFC2 = regexp.MustCompile(`(?i)\b(FC2(?:-PPV)?)-?\s?(\d{6,10})\b`)
	reJavStd = regexp.MustCompile(`\b([A-Za-z]{2,6})-?\s?(\d{2,5})\b`)
)

// javExtractCode 从标题/文件名提取番号，归一为「ABCD-123」/「FC2-PPV-1234567」形态；
// 识别不到返回 ""。多个候选时取第一个非技术词命中。
func javExtractCode(title string) string {
	s := strings.TrimSpace(title)
	if m := reJavFC2.FindStringSubmatch(s); len(m) > 2 {
		prefix := "FC2-PPV"
		if !strings.Contains(strings.ToUpper(m[1]), "PPV") {
			prefix = "FC2"
		}
		return prefix + "-" + m[2]
	}
	for _, m := range reJavStd.FindAllStringSubmatch(s, -1) {
		letters := strings.ToUpper(m[1])
		if javTechWords[letters] {
			continue
		}
		return letters + "-" + m[2]
	}
	return ""
}

/* ── 抓取与解析 ── */

type javActress struct {
	Name  string `json:"name"`
	Photo string `json:"photo"`
}

type javMeta struct {
	Code      string       `json:"code"`
	Title     string       `json:"title"`
	Cover     string       `json:"cover"`
	Date      string       `json:"date"`
	Genres    []string     `json:"genres"`
	Actresses []javActress `json:"actresses"`
	URL       string       `json:"url"`
}

var (
	javCacheMu sync.Mutex
	javCache   = map[string]javCacheEntry{}
)

type javCacheEntry struct {
	meta javMeta
	exp  time.Time
}

var (
	reJavTitle   = regexp.MustCompile(`(?s)<h3[^>]*>(.*?)</h3>`)
	reJavBigImg  = regexp.MustCompile(`class="[^"]*bigImage[^"]*"[^>]*href="([^"]+)"`)
	reJavCover   = regexp.MustCompile(`<img[^>]*class="[^"]*\bcover\b[^"]*"[^>]*src="([^"]+)"`)
	reJavDate    = regexp.MustCompile(`(?:发行时间|發行日期|発売日)\s*[:：]?</span>\s*(?:<span[^>]*>)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})`)
	reJavDateAny = regexp.MustCompile(`([0-9]{4}-[0-9]{2}-[0-9]{2})`)
	reJavGenre   = regexp.MustCompile(`<a[^>]*href="[^"]*/genre/[^"]*"[^>]*>\s*([^<]+?)\s*</a>`)
	reJavStarImg = regexp.MustCompile(`(?s)<img[^>]*src="([^"]+)"`)
	reJavStarNm  = regexp.MustCompile(`(?s)<span[^>]*>([^<]+)</span>`)
	reJavTag     = regexp.MustCompile(`<[^>]+>`)
	reJavBox     = regexp.MustCompile(`class="movie-box"[^>]*href="([^"]+)"`)
)

// javStripTags 去内联标签 + 反转义（标题 h3 内可能有 <span> 等包裹）。
func javStripTags(s string) string {
	return strings.TrimSpace(html.UnescapeString(reJavTag.ReplaceAllString(s, " ")))
}

// javParseDetail 详情页 HTML → javMeta（各字段独立容错，失败留空）。
func javParseDetail(pageURL, htmlText, fallbackCode string) javMeta {
	meta := javMeta{Code: fallbackCode, URL: pageURL}
	if m := reJavTitle.FindStringSubmatch(htmlText); len(m) > 1 {
		meta.Title = javStripTags(m[1])
	}
	if m := reJavBigImg.FindStringSubmatch(htmlText); len(m) > 1 {
		meta.Cover = strings.TrimSpace(m[1])
	} else if m := reJavCover.FindStringSubmatch(htmlText); len(m) > 1 {
		meta.Cover = strings.TrimSpace(m[1])
	}
	if m := reJavDate.FindStringSubmatch(htmlText); len(m) > 1 {
		meta.Date = m[1]
	} else if m := reJavDateAny.FindStringSubmatch(htmlText); len(m) > 1 {
		meta.Date = m[1]
	}
	seen := map[string]bool{}
	for _, gm := range reJavGenre.FindAllStringSubmatch(htmlText, -1) {
		name := strings.TrimSpace(html.UnescapeString(gm[1]))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		meta.Genres = append(meta.Genres, name)
	}
	// 演员：avatar-box 块内 <img src> + <span>名字</span>
	for _, chunk := range strings.Split(htmlText, "avatar-box")[1:] {
		name := ""
		if nm := reJavStarNm.FindStringSubmatch(chunk); len(nm) > 1 {
			name = strings.TrimSpace(html.UnescapeString(nm[1]))
		}
		if name == "" {
			continue
		}
		photo := ""
		if am := reJavStarImg.FindStringSubmatch(chunk); len(am) > 1 {
			photo = strings.TrimSpace(am[1])
		}
		meta.Actresses = append(meta.Actresses, javActress{Name: name, Photo: photo})
	}
	return meta
}

// javAbsURL 相对路径 → 绝对地址（scheme/host 取自所在页面 URL）。
func javAbsURL(raw, pageURL string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	if u, err := url.Parse(pageURL); err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") {
		return u.Scheme + "://" + u.Host + raw
	}
	return "https://" + raw
}

// javHTTP 复用扩展数据源通用客户端（自定义代理 > 系统直连）。
func (b *Bridge) javHTTP() *http.Client { return b.extHTTP() }

type javStatusError struct{ Code int }

func (e *javStatusError) Error() string { return "javbus HTTP " + strconv.Itoa(e.Code) }

// javGet 抓单页并解析（标题为空视为非详情页，返回 404 语义错误）。
func (b *Bridge) javGet(pageURL, domain, code string) (javMeta, error) {
	req, _ := http.NewRequest(http.MethodGet, pageURL, nil)
	req.Header.Set("User-Agent", skipUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("Referer", "https://"+domain+"/")
	resp, err := b.javHTTP().Do(req)
	if err != nil {
		return javMeta{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode != http.StatusOK {
		return javMeta{}, &javStatusError{Code: resp.StatusCode}
	}
	meta := javParseDetail(pageURL, string(data), code)
	meta.Code = code
	meta.Cover = javAbsURL(meta.Cover, pageURL)
	if meta.Title == "" {
		return meta, &javStatusError{Code: 404}
	}
	return meta, nil
}

// javFetchDetail 番号 → javMeta：详情页直取 → 404/非详情 → 搜索页兜底（首个 movie-box 结果）。
func (b *Bridge) javFetchDetail(code string) (javMeta, error) {
	domain := b.javDomain()
	base := b.javBase()
	detail, err := b.javGet(base+"/"+url.PathEscape(code), domain, code)
	if err == nil && detail.Title != "" {
		return detail, nil
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/search/"+url.PathEscape(code)+"&type=1", nil)
	req.Header.Set("User-Agent", skipUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	resp, err := b.javHTTP().Do(req)
	if err != nil {
		return javMeta{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode != http.StatusOK {
		return javMeta{}, &javStatusError{Code: resp.StatusCode}
	}
	m := reJavBox.FindStringSubmatch(string(data))
	if len(m) < 2 {
		return javMeta{}, &javStatusError{Code: 404}
	}
	return b.javGet(m[1], domain, code)
}

/* ── Handlers ── */

// javLookupHandler POST {code?, title?, guid?} → {ok, meta:{code,title,cover,date,genres,actresses,url}}
// 未开启/未识别番号/查询失败均 ok:false + error（前端按钮态反馈，不弹错）。
func (b *Bridge) javLookupHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code  string `json:"code"`
		Title string `json:"title"`
		GUID  string `json:"guid"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if !b.javOn() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Jav 刮削未开启（设置→账号与网络→Jav 刮削）"})
		return
	}
	code := javExtractCode(req.Code)
	if code == "" {
		code = javExtractCode(req.Title)
	}
	if code == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未识别到番号（标题需含如 ABC-123 / FC2-PPV-1234567）"})
		return
	}
	javCacheMu.Lock()
	if e, ok := javCache[code]; ok && time.Now().Before(e.exp) {
		javCacheMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "meta": e.meta, "fromCache": true})
		return
	}
	javCacheMu.Unlock()
	meta, err := b.javFetchDetail(code)
	if err != nil || meta.Title == "" {
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "javbus 查询失败：" + msg + "（检查网络/代理，或设置里更换 javbus 域名）"})
		return
	}
	javCacheMu.Lock()
	javCache[code] = javCacheEntry{meta: meta, exp: time.Now().Add(24 * time.Hour)}
	javCacheMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "meta": meta})
}

// javImageHandler GET ?url=https://{javBusDomain}/... → {ok, dataUrl}。
// 域名白名单=设置里的 javBusDomain（含子域），封面取回后换 hero 海报展示。
func (b *Bridge) javImageHandler(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少图片地址"})
		return
	}
	domain := b.javDomain()
	host := strings.ToLower(u.Hostname())
	if host != domain && !strings.HasSuffix(host, "."+domain) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "仅支持 javbus 域名图片: " + domain})
		return
	}
	req, _ := http.NewRequest(http.MethodGet, raw, nil)
	req.Header.Set("User-Agent", skipUA)
	req.Header.Set("Referer", "https://"+domain+"/")
	resp, err := b.javHTTP().Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": strconv.Itoa(resp.StatusCode)})
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/jpeg"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dataUrl": "data:" + ct + ";base64," + b64encode(data)})
}
