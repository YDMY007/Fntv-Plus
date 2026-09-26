// Package bridge —— dandanplay.go：弹弹play 官方开放 API 客户端（内置凭证 + 可选自定义凭证）。
//
// 文档：https://doc.dandanplay.com/open/
//
// 认证（签名模式，官方推荐客户端使用）：
//
//	X-AppId:     AppId
//	X-Timestamp: Unix 秒（UTC）
//	X-Signature: base64(sha256(AppId + Timestamp + Path + AppSecret))
//
// Path 为接口路径（以 / 开头，**不含 query**、不做 URL 编码），如 /api/v2/search/episodes。
//
// 凭证来源（优先级从高到低）：
//  1. 设置面板填的自定义 AppId/Secret（密文存 config.json，见 internal/secret）
//  2. 编译进二进制的内置凭证（密文常量，见 internal/secret/builtin.go）
//
// 内置 AppId 配有两个 Secret：主 Secret 失效（轮换/被限）时自动顺延到备用并发起重试，
// 免去重新打包。命中编号在进程内缓存，避免每条请求都白试一次。
//
// 三端点：
//
//	/api/v2/search/episodes?anime=<标题>  条目搜索（含分集列表）
//	/api/v2/bangumi/{animeId}             完整分集（search/episodes 只回部分时兜底）
//	/api/v2/comment/{episodeId}?withRelated=true  弹幕（withRelated 含第三方整合源，实测条数远高于默认）
package bridge

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"fntvplus/internal/secret"
)

// dandanplayBase var 而非 const：单测用 httptest 覆盖指向本地假服务器。
var dandanplayBase = "https://api.dandanplay.net"

const ddpSourceLabel = "弹弹play"

// ddpIDPrefix 手动搜索候选里弹弹play 集的伪 id 前缀（真 id 为 episodeId）。
const ddpIDPrefix = "ddp:"

/* ── 凭证解析 ── */

// ddpCredsHook 单测注入凭证序列的测试接缝（生产恒为 nil）。
// 放在包级而非 Bridge 字段上：Bridge 是长期存活的生产结构，不掺测试字段。
var ddpCredsHook func() (string, []string, bool)

// ddpCreds 解析当前生效的凭证：自定义（面板填写）优先，否则回落内置。
// custom=true 表示用户自己填了凭证（面板状态文案要区分）。
func (b *Bridge) ddpCreds() (appID string, secrets []string, custom bool) {
	if ddpCredsHook != nil {
		return ddpCredsHook()
	}
	if id, sec := b.ddpCustomCreds(); id != "" && sec != "" {
		return id, []string{sec}, true
	}
	bid, bsec := secret.BuiltinDandanplay()
	return bid, bsec, false
}

// ddpCustomCreds 读取面板填的自定义凭证（appSecret 落盘为密文，解密失败按未配置处理）。
func (b *Bridge) ddpCustomCreds() (string, string) {
	id := strings.TrimSpace(getSetting(b.cfg, "dandanplayAppId"))
	raw := strings.TrimSpace(getSetting(b.cfg, "dandanplayAppSecret"))
	if id == "" || raw == "" {
		return "", ""
	}
	sec, err := secret.DecryptStored(raw)
	if err != nil {
		// 密钥不匹配（配置被换机器拷贝/盐文件丢失）：明确记日志，按未配置降级到内置凭证，
		// 不让「解密失败」表现成「弹幕源整个不可用」。
		logf("[dandanplay] 自定义 AppSecret 解密失败，回落内置凭证: %v", err)
		return "", ""
	}
	return id, strings.TrimSpace(sec)
}

// ddpEnabled 弹弹play 弹幕源是否启用（默认启用：装完即用是内置凭证的意义所在）。
// 面板显式关掉（存 false）才跳过；键不存在/值非法均为启用。
func (b *Bridge) ddpEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(getSetting(b.cfg, "dandanplayEnabled")))
	return v != "0" && v != "false"
}

/* ── 签名与请求 ── */

// ddpSign 生成签名（纯函数，便于单测固定时间戳验证算法）。
func ddpSign(appID, appSecret, path string, ts int64) string {
	raw := appID + strconv.FormatInt(ts, 10) + path + appSecret
	sum := sha256.Sum256([]byte(raw))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// ddpSecretTry 缓存「哪个 Secret 可用」，避免每次请求都从第一个开始白试。
type ddpSecretTry struct {
	mu  sync.Mutex
	idx int
	bad map[int]time.Time // 失效编号 → 最近一次失效时刻
}

// ddpTry 当前应优先尝试的 Secret 序号。
func (t *ddpSecretTry) ddpTry(n int) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.idx >= 0 && t.idx < n {
		return t.idx
	}
	return 0
}

// ddpMarkBad 标记某序号失效（5 分钟内不再优先尝试）。
func (t *ddpSecretTry) ddpMarkBad(i int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.bad == nil {
		t.bad = map[int]time.Time{}
	}
	t.bad[i] = time.Now().Add(5 * time.Minute)
}

// ddpMarkGood 记住可用的序号。
func (t *ddpSecretTry) ddpMarkGood(i int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.idx = i
}

// ddpSkip 判断某序号是否处于「刚失效」冷却期。
func (t *ddpSecretTry) ddpSkip(i int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	until, ok := t.bad[i]
	return ok && time.Now().Before(until)
}

var ddpSecretState ddpSecretTry

// ddpCall 带签名的 GET → 解析后的 JSON map。逐个尝试可用 Secret，直到某个返回非认证错误。
// 返回 (HTTP 状态码, JSON, 错误)。401/403 且错误信息指向凭证时自动换下一个 Secret 重试。
func (b *Bridge) ddpCall(path string, query url.Values) (int, map[string]any, error) {
	appID, secrets, _ := b.ddpCreds()
	if appID == "" || len(secrets) == 0 {
		return 0, nil, fmt.Errorf("弹弹play 凭证不可用")
	}
	rawURL := dandanplayBase + path
	if len(query) > 0 {
		rawURL += "?" + query.Encode()
	}

	client := &http.Client{Timeout: 20 * time.Second}
	start := ddpSecretState.ddpTry(len(secrets))
	var lastCode int
	var lastBody map[string]any
	var lastErr error
	for n := 0; n < len(secrets); n++ {
		i := (start + n) % len(secrets)
		if n > 0 && ddpSecretState.ddpSkip(i) {
			continue
		}
		ts := time.Now().Unix()
		req, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("X-AppId", appID)
		req.Header.Set("X-Timestamp", strconv.FormatInt(ts, 10))
		req.Header.Set("X-Signature", ddpSign(appID, secrets[i], path, ts))
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", biliUA)

		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
		resp.Body.Close()

		var out map[string]any
		if len(body) > 0 {
			_ = json.Unmarshal(body, &out)
		}
		if resp.StatusCode == http.StatusOK {
			ddpSecretState.ddpMarkGood(i)
			if n > 0 {
				logf("[dandanplay] 已切换到第 %d 个内置 Secret（前序失效）", i+1)
			}
			return resp.StatusCode, out, nil
		}

		msg := resp.Header.Get("X-Error-Message")
		lastCode, lastBody, lastErr = resp.StatusCode, out, fmt.Errorf("HTTP %d: %s", resp.StatusCode, msg)
		if ddpAuthErr(resp.StatusCode, msg) && n+1 < len(secrets) {
			ddpSecretState.ddpMarkBad(i)
			logf("[dandanplay] Secret #%d 认证失败（%s），尝试下一个", i+1, msg)
			continue
		}
		return resp.StatusCode, out, lastErr
	}
	return lastCode, lastBody, lastErr
}

// ddpAuthErr 判断响应是否为「凭证类」失败（值得换 Secret 重试）。
// 429/5xx 也归入，属于服务侧瞬时状态，换 Secret 无害。
func ddpAuthErr(code int, msg string) bool {
	if code == http.StatusUnauthorized || code == http.StatusForbidden ||
		code == http.StatusTooManyRequests || code >= 500 {
		return true
	}
	m := strings.ToLower(msg)
	return strings.Contains(m, "signature") || strings.Contains(m, "appsecret") || strings.Contains(m, "appid")
}

/* ── 查询结果缓存 ── */

// 官方规约要求「请缓存 API 返回的数据，以减少对服务器的请求次数」，并给出参考缓存时长：
// 一般数据 2–6 小时，热播 0.5–1 小时，非当季老番 12–24 小时，老番 2–7 天。
//
// 本客户端缓存两类「查询型」结果（弹幕体本身另由 danmakuPrepare 的磁盘缓存兜住）：
//
//	搜索（/search/episodes）  —— 同一番剧换集播放时复用，避免每集重搜
//	分集（/bangumi/{id}）     —— 同上；条目分集表短期内不会变
//
// 取中间值 6 小时：老番偏保守（可再长），当季新番每 6 小时刷新一次足够跟上更新。
// 缓存键归一化标题/集 id，进程内 map + 过期时间，与 danmu_api 侧同构。
const ddpQueryCacheTTL = 6 * time.Hour

type ddpCacheEntry struct {
	val []map[string]any
	exp time.Time
}

var (
	ddpSearchCache   sync.Map // 归一化标题 → ddpCacheEntry
	ddpEpisodesCache sync.Map // animeId → ddpCacheEntry
)

// ddpCacheGet 读未过期缓存（命中返回副本，避免调用方改动污染缓存）。
func ddpCacheGet(m *sync.Map, key string) ([]map[string]any, bool) {
	if v, ok := m.Load(key); ok {
		if e, ok2 := v.(ddpCacheEntry); ok2 && time.Now().Before(e.exp) {
			out := make([]map[string]any, len(e.val))
			copy(out, e.val)
			return out, true
		}
	}
	return nil, false
}

// ddpCachePut 写缓存。
func ddpCachePut(m *sync.Map, key string, val []map[string]any) {
	if len(val) == 0 {
		return // 空结果不缓存：下次仍可重试（网络抖动/临时故障不应被锁定 6 小时）
	}
	cp := make([]map[string]any, len(val))
	copy(cp, val)
	m.Store(key, ddpCacheEntry{val: cp, exp: time.Now().Add(ddpQueryCacheTTL)})
}

// ddpSearchAnimes 条目搜索：/api/v2/search/episodes?anime=<关键词>
// 返回 animes（含各自 episodes 列表，只含部分集）。命中进程内缓存则不打上游。
func (b *Bridge) ddpSearchAnimes(title string) []map[string]any {
	key := strings.ToLower(strings.TrimSpace(title))
	if v, ok := ddpCacheGet(&ddpSearchCache, key); ok {
		logf("[dandanplay] 搜索缓存命中 title=%q（免上游请求）", title)
		return v
	}
	q := url.Values{}
	q.Set("anime", strings.TrimSpace(title))
	code, j, err := b.ddpCall("/api/v2/search/episodes", q)
	if err != nil {
		logf("[dandanplay] 搜索失败 title=%q code=%d: %v", title, code, err)
		return nil
	}
	if j == nil {
		return nil
	}
	if succ, ok := j["success"].(bool); ok && !succ {
		logf("[dandanplay] 搜索 success=false title=%q msg=%s", title, jsStr(j["errorMessage"]))
		return nil
	}
	out := toMapSlice(jArr(j["animes"]))
	ddpCachePut(&ddpSearchCache, key, out)
	return out
}

// ddpAnimeEpisodes 完整分集：/api/v2/bangumi/{animeId}（search/episodes 只回部分集时兜底）。
// 命中进程内缓存则不打上游。
func (b *Bridge) ddpAnimeEpisodes(animeID int64) []map[string]any {
	key := strconv.FormatInt(animeID, 10)
	if v, ok := ddpCacheGet(&ddpEpisodesCache, key); ok {
		return v
	}
	_, j, err := b.ddpCall(fmt.Sprintf("/api/v2/bangumi/%d", animeID), nil)
	if err != nil || j == nil {
		return nil
	}
	bg := jMap(j["bangumi"])
	if bg == nil {
		return nil
	}
	out := toMapSlice(jArr(bg["episodes"]))
	ddpCachePut(&ddpEpisodesCache, key, out)
	return out
}

// ddpFetchItems 拉取指定集的弹幕 → 与 B站 XML 同构的 items（time/type/color/text）。
// withRelated=true：含第三方整合弹幕，实测条数远高于默认（芙莉莲首集 7310 vs 131）。
func (b *Bridge) ddpFetchItems(episodeID int64) []map[string]any {
	q := url.Values{}
	q.Set("withRelated", "true")
	code, j, err := b.ddpCall(fmt.Sprintf("/api/v2/comment/%d", episodeID), q)
	if err != nil {
		logf("[dandanplay] 弹幕拉取失败 episodeId=%d code=%d: %v", episodeID, code, err)
		return nil
	}
	if j == nil {
		return nil
	}
	if succ, ok := j["success"].(bool); ok && !succ {
		logf("[dandanplay] 弹幕 success=false episodeId=%d msg=%s", episodeID, jsStr(j["errorMessage"]))
		return nil
	}
	items := make([]map[string]any, 0, len(jArr(j["comments"])))
	for _, v := range jArr(j["comments"]) {
		m := jMap(v)
		if m == nil {
			continue
		}
		it := ddpParseComment(jsStr(m["p"]), jsStr(m["m"]))
		if it != nil {
			items = append(items, it)
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["time"]) < jsNum(items[j]["time"])
	})
	return items
}

// ddpParseComment 弹幕 p 属性 → item。
//
// p 形如 "2.52,5,16777215,ca76f2e6"，四段固定为：时间, 模式, **颜色**, 用户标识。
//
//	⚠ 与 B站 XML 的 p 不同：B站是 time,mode,**size**,color,uid…（颜色在第 4 段）。
//	弹弹play 没有 size 段（字号由播放器定），颜色在第 3 段 —— 按 B站 下标取会把
//	末段的十六进制用户标识当颜色解析（ParseInt 失败恒得 0=黑色，实测全屏弹幕变黑）。
//
// 文本不做 HTML 反转义：弹弹play JSON 的 m 是纯文本（实测 "D&D客串" 原样返回），
// 再反转义会把用户真实的 "&amp;" 等字面量改坏（与 parseDanmakuXML 的差异就在此）。
func ddpParseComment(p, text string) map[string]any {
	if p == "" {
		return nil
	}
	f := strings.Split(p, ",")
	if len(f) < 3 {
		return nil
	}
	t, err := strconv.ParseFloat(strings.TrimSpace(f[0]), 64)
	if err != nil {
		return nil
	}
	mode, _ := strconv.Atoi(strings.TrimSpace(f[1]))
	color, _ := strconv.ParseInt(strings.TrimSpace(f[2]), 10, 64)
	dmType := mode
	if dmType != 4 && dmType != 5 {
		dmType = 1
	}
	// type/color 存 float64：biliFilterDanmaku 用 jsNum 读取，而 jsNum 只认 float64——
	// 存 int 会让「屏蔽类型」对刚拉取的条目静默失效。
	return map[string]any{"time": t, "type": float64(dmType), "color": float64(color), "text": text}
}

/* ── 候选匹配 ── */

// ddpTier 弹弹play 候选准入档位（越小越好，-1 = 不匹配）。
//
// 与自建源（danmu_api）「只认主名精确相等」不同，弹弹play 的条目名常带副标题
// （如「葬送的芙莉莲 第三季 黄金乡篇」），纯相等会把正确条目全部拒掉。故分三档：
//
//	0 = 主名相等 + 季号一致（或都未标季 / 查询未标季而候选为第一季）
//	1 = 主名相等但候选季号更高（查询未标季时的「后续季」条目，弱于 0 档）
//	2 = 候选主名以查询主名开头（副标题场景，季号仍需一致或弱兼容）
func ddpTier(query string, querySeason int64, candTitle string) int {
	qName, qSeason := danmuSplitSeason(query)
	cName, cSeason := danmuSplitSeason(candTitle)
	if qName == "" || cName == "" {
		return -1
	}
	want := qSeason
	if querySeason > 0 {
		want = int(querySeason)
	}
	// 季号兼容：一致 → ok；候选未标季且要求的第一季/未指定 → ok(隐含第一季)；
	// 要求未指定而候选标了季 → 弱兼容（记 higher，由档位体现）
	seasonOK, higher := false, false
	switch {
	case cSeason > 0 && want > 0:
		seasonOK = cSeason == want
	case cSeason > 0 && want <= 0:
		seasonOK, higher = true, cSeason > 1
	case cSeason == 0 && want <= 1:
		seasonOK = true
	}
	if !seasonOK {
		return -1
	}
	switch {
	case cName == qName:
		if higher {
			return 1
		}
		return 0
	case strings.HasPrefix(cName, qName):
		// 副标题场景降一档（前缀相等弱于完全相等）
		if higher {
			return 2
		}
		if cSeason == 0 && want <= 1 {
			return 2
		}
		return 1
	}
	return -1
}

// ddpPickEpisode 在分集列表里定位第 ep 集。ep<=0（电影/未指定）取首集。
// 优先按 episodeTitle 里的集数解析（「第3话 xxx」），其次按 episodeNumber，最后按列表序号。
func ddpPickEpisode(eps []map[string]any, ep int64) map[string]any {
	if len(eps) == 0 {
		return nil
	}
	if ep <= 0 {
		return eps[0]
	}
	// ① episodeTitle 解析
	for _, e := range eps {
		if m := reEpFromTitle.FindStringSubmatch(jsStr(e["episodeTitle"])); len(m) > 1 {
			if n, err := strconv.ParseInt(m[1], 10, 64); err == nil && n == ep {
				return e
			}
		}
	}
	// ② episodeNumber（bangumi 端点回字符串型数字）
	for _, e := range eps {
		if s := jsStr(e["episodeNumber"]); s != "" {
			if n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil && n == ep {
				return e
			}
		}
	}
	// ③ 列表序号兜底（标题无集数信息时，dandanplay 返回顺序即集数顺序）
	if ep >= 1 && int(ep) <= len(eps) {
		return eps[int(ep)-1]
	}
	return nil
}

// ddpCredentialLabel 当前生效的凭证来源（面板与来源详情展示用）。
func ddpCredentialLabel(b *Bridge) string {
	appID, secrets, custom := b.ddpCreds()
	if appID == "" || len(secrets) == 0 {
		return "不可用"
	}
	if custom {
		return "自定义凭证"
	}
	return "内置凭证"
}

// ddpAutoFetch 弹弹play 自动路径：标题+集数 → 搜索 → 定位集 → 拉弹幕。
// 返回（items, 实际匹配标题, 集 id, 未命中原因, 溯源明细）。尝试前 3 个候选条目。
func (b *Bridge) ddpAutoFetch(title string, ep, season int64) ([]map[string]any, string, int64, string, danmuSourceDetail) {
	d := danmuSourceDetail{Key: "dandanplay", Label: ddpSourceLabel}
	appID, secrets, custom := b.ddpCreds()
	if appID == "" || len(secrets) == 0 {
		d.Note = "凭证不可用"
		return nil, "", 0, "弹弹play 凭证不可用", d
	}
	d.Enabled = true
	if custom {
		d.Credential = "自定义凭证"
	} else {
		d.Credential = "内置凭证"
	}
	animes := b.ddpSearchAnimes(title)
	if len(animes) == 0 {
		d.Note = "搜索无结果"
		return nil, "", 0, "弹弹play 搜索无结果", d
	}
	type cand struct {
		m    map[string]any
		tier int
	}
	var ranked []cand
	for _, a := range animes {
		id := int64(jsNum(a["animeId"]))
		if id <= 0 {
			continue
		}
		tier := ddpTier(title, season, jsStr(a["animeTitle"]))
		if tier < 0 {
			continue
		}
		ranked = append(ranked, cand{a, tier})
	}
	if len(ranked) == 0 {
		d.Note = "无匹配条目"
		return nil, "", 0, "弹弹play 无匹配条目", d
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].tier < ranked[j].tier })

	tries := 3
	for _, c := range ranked {
		if tries <= 0 {
			break
		}
		tries--
		animeTitle := jsStr(c.m["animeTitle"])
		eps := toMapSlice(jArr(c.m["episodes"]))
		pick := ddpPickEpisode(eps, ep)
		if pick == nil {
			// search/episodes 只回部分集 → 换 bangumi 端点取完整分集
			eps = b.ddpAnimeEpisodes(int64(jsNum(c.m["animeId"])))
			pick = ddpPickEpisode(eps, ep)
		}
		if pick == nil {
			continue
		}
		id := int64(jsNum(pick["episodeId"]))
		if id <= 0 {
			continue
		}
		if items := b.ddpFetchItems(id); len(items) > 0 {
			d.MatchedTitle = animeTitle
			d.EpisodeTitle = jsStr(pick["episodeTitle"])
			d.EpisodeID = id
			d.RawCount = len(items)
			return items, animeTitle, id, "", d
		}
	}
	d.Note = "候选均无弹幕"
	return nil, "", 0, "弹弹play 候选均无弹幕", d
}

// ddpStatusHandler GET /api/bridge/dandanplay/status → 面板状态回显。
//
// 只回「是否可用 / 用的是哪套凭证 / 凭证来源」，**绝不回明文凭证**：
// AppId 是可下发标识符（每请求头都带），Secret 一律只回是否存在。
func (b *Bridge) ddpStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID, secrets, custom := b.ddpCreds()
		out := map[string]any{
			"enabled":     b.ddpEnabled(),
			"configured":  appID != "" && len(secrets) > 0,
			"credential":  "none",
			"secretCount": len(secrets),
		}
		switch {
		case custom:
			out["credential"] = "custom"
		case appID != "" && len(secrets) > 0:
			out["credential"] = "builtin"
		}
		if appID != "" {
			// AppId 非密钥材料：面板要按长度渲染掩码星号，故下发（Secret 不下发）
			out["appId"] = appID
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// ddpTestHandler POST /api/bridge/dandanplay/test {keyword?} → 连通性自检。
//
// 给设置面板「测试连接」用：真发一次搜索请求（默认取 panel 标题或内置样例），
// 把签名/凭证/网络三类失败分别归因 —— 用户不用靠「弹幕不出来」反推是哪一层坏了。
func (b *Bridge) ddpTestHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Keyword string `json:"keyword"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req)
		kw := strings.TrimSpace(req.Keyword)
		if kw == "" {
			kw = "葬送的芙莉莲"
		}
		appID, secrets, custom := b.ddpCreds()
		if appID == "" || len(secrets) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": false, "error": "凭证不可用（内置凭证解密失败且未配置自定义凭证）",
			})
			return
		}
		start := time.Now()
		animes := b.ddpSearchAnimes(kw)
		ms := time.Since(start).Milliseconds()
		src := "内置凭证"
		if custom {
			src = "自定义凭证"
		}
		if animes == nil {
			// ddpSearchAnimes 失败时已记日志；此处给出面向用户的分层判断
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": false, "credential": src, "keyword": kw, "costMs": ms,
				"error": "请求失败：凭证被拒或网络不可达（详见实时日志 [dandanplay] 行）",
			})
			return
		}
		titles := make([]string, 0, 3)
		for _, a := range animes {
			if len(titles) >= 3 {
				break
			}
			if t := jsStr(a["animeTitle"]); t != "" {
				titles = append(titles, t)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "credential": src, "keyword": kw, "costMs": ms,
			"hits": len(animes), "sample": titles,
			"appId": appID,
		})
	}
}

// ddpCandidates 弹弹play 手动搜索候选（bvid 位为 ddp:<episodeId> 伪 id，与自建源同约定）。
func (b *Bridge) ddpCandidates(title string, ep, season int64) []map[string]any {
	if !b.ddpEnabled() {
		return nil
	}
	animes := b.ddpSearchAnimes(title)
	if len(animes) == 0 {
		return nil
	}
	type cand struct {
		m    map[string]any
		tier int
	}
	var ranked []cand
	for _, a := range animes {
		if int64(jsNum(a["animeId"])) <= 0 {
			continue
		}
		if tier := ddpTier(title, season, jsStr(a["animeTitle"])); tier >= 0 {
			ranked = append(ranked, cand{a, tier})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].tier < ranked[j].tier })

	out := []map[string]any{}
	for _, c := range ranked {
		if len(out) >= 5 {
			break
		}
		eps := toMapSlice(jArr(c.m["episodes"]))
		pick := ddpPickEpisode(eps, ep)
		if pick == nil {
			eps = b.ddpAnimeEpisodes(int64(jsNum(c.m["animeId"])))
			pick = ddpPickEpisode(eps, ep)
		}
		if pick == nil {
			continue
		}
		id := int64(jsNum(pick["episodeId"]))
		if id <= 0 {
			continue
		}
		full := jsStr(c.m["animeTitle"])
		if t := jsStr(pick["episodeTitle"]); t != "" {
			full += " · " + t
		}
		out = append(out, map[string]any{
			"bvid":           ddpIDPrefix + strconv.FormatInt(id, 10),
			"title":          full,
			"source":         ddpSourceLabel,
			"is_compilation": false,
			"sim":            nil,
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
