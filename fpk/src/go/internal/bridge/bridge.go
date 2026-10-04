// Package bridge —— 网页端服务桥：把桌面版主进程的网络能力搬到飞牛后端。
//
// 桌面版的账号同步/外部 API 依赖 Electron 主进程（Node axios + config 持久化）；
// FPK 网页端没有主进程，由本包在 Go 后端提供等价能力：
//
//	POST /app/fntvplus/api/bridge/fnos        通用 fnOS 签名桥（本地 Authx 签名 + 浏览器 cookie 转发）
//	POST /app/fntvplus/api/bridge/proxy       白名单外部代理（trakt/bgm/tmdb/douban 等域，解决 CORS）
//	GET  /app/fntvplus/api/bridge/tmdb/img    TMDB 图片代理（image.tmdb.org 直出）
//	POST /app/fntvplus/api/bridge/trakt/*     Trakt 设备授权/凭证/scrobble/同步
//	GET  /app/fntvplus/api/bridge/bangumi/calendar  Bangumi 日历
//	POST /app/fntvplus/api/bridge/bangumi/sync-progress  Bangumi 播放进度标记（在看/看过）
//	GET  /app/fntvplus/api/bridge/bangumi/sync-status    最近一次同步结果（面板展示失败原因）
//	GET  /app/fntvplus/api/bridge/bangumi/probe          连接诊断（网络链路 + Token 有效性）
//	POST /app/fntvplus/api/bridge/douban/status     豆瓣登录状态（网页端暂未适配登录）
//
// 安全边界：proxy 域名白名单；fnOS 桥只接受 /v/api/ 开头的路径；cookie 由前端显式转发。
package bridge

import (
	"context"
	"crypto/md5"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"fntvplus/internal/config"
	"fntvplus/internal/gateway"
)

// Authx 签名材料不再硬编码进二进制（审核红线：第三方应用内嵌官方签名密钥观感差、
// 也防泄漏扩散）。fnOS 上由 cmd/main 经环境变量注入（值与官方影视应用一致），
// 本地调试可用 FNTV_AUTHX_KEY / FNTV_AUTHX_SECRET 环境变量提供。
var (
	authxKey    = envOr("FNTV_AUTHX_KEY", "")
	authxSecret = envOr("FNTV_AUTHX_SECRET", "")
)

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// 白名单后缀：proxy 只放行这些外部域（含子域）。
var proxyAllowSuffix = []string{
	"trakt.tv", "api.trakt.tv", "auth.trakt.tv",
	"bgm.tv", "api.bgm.tv",
	"themoviedb.org", "api.themoviedb.org", "image.tmdb.org",
	"douban.com", "movie.douban.com", "frodo.douban.com",
	// [v1.10.0] 扩展数据源（官方开放 API）：Fanart.tv 图库（webservice=API/assets=图片CDN）、
	// TVMaze（分集英文兜底）、OMDb（IMDb 评分）、MyAnimeList 官方 v2（动漫映射链）
	"webservice.fanart.tv", "assets.fanart.tv",
	"api.tvmaze.com", "www.omdbapi.com", "api.myanimelist.net",
	"wj.qq.com", "qm.qq.com", "github.com",
}

// Bridge 持有配置与上游地址。
type Bridge struct {
	cfg      *config.Config
	upstream string
	client   *http.Client
}

// New 构造 Bridge。
func New(cfg *config.Config, upstream string) *Bridge {
	return &Bridge{
		cfg:      cfg,
		upstream: strings.TrimRight(upstream, "/"),
		client:   &http.Client{Timeout: 20 * time.Second},
	}
}

// Mount 注册全部 bridge 路由。
func (b *Bridge) Mount(mux *http.ServeMux) {
	mux.HandleFunc("/app/fntvplus/api/bridge/fnos", b.handleFnOS)
	mux.HandleFunc("/app/fntvplus/api/bridge/fnos/authx", b.handleFnOSAuthx)
	mux.HandleFunc("/app/fntvplus/api/bridge/proxy", b.handleProxy)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/img", b.handleTMDBImage)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/logo", b.tmdbLogo)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/show", b.tmdbShow)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/season-episodes", b.tmdbSeasonEpisodes)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/update-ip", b.tmdbUpdateIP)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/discover", b.tmdbDiscover)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/credentials", b.traktCredsHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/status", b.traktStatusHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/device/start", b.traktDeviceStart)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/device/cancel", b.traktDeviceCancel)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/disconnect", b.traktDisconnect)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/scrobble", b.traktScrobble)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/sync-watched", b.traktSyncWatched)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/credentials/clear", b.traktClearCreds)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/device/token", b.traktDeviceTokenPoll)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/token", b.traktTokenSave)
	mux.HandleFunc("/app/fntvplus/api/bridge/bangumi/calendar", b.bangumiCalendar)
	mux.HandleFunc("/app/fntvplus/api/bridge/bangumi/sync-progress", b.bangumiSyncProgress)
	mux.HandleFunc("/app/fntvplus/api/bridge/bangumi/sync-status", b.bangumiSyncStatus)
	mux.HandleFunc("/app/fntvplus/api/bridge/bangumi/probe", b.bangumiProbe)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/watched", b.doubanWatched)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/enrich", b.doubanEnrich)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/status", b.doubanStatus)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/discover", b.doubanDiscover)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/image", b.doubanImage)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/sync-progress", b.doubanSyncProgress)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/sync-watched", b.doubanSyncWatched)
	mux.HandleFunc("/app/fntvplus/api/bridge/person/credits", b.personCredits)
	mux.HandleFunc("/app/fntvplus/api/bridge/person/brief", b.personBrief)
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/qr-generate", b.biliQrGenerate)
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/qr-poll", b.biliQrPoll)
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/status", b.biliStatusHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/manual", b.biliManualCookie)
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/clear", b.biliClear)
	mux.HandleFunc("/app/fntvplus/api/bridge/bili/qr-lib", b.biliQrLib)
	mux.HandleFunc("/app/fntvplus/api/bridge/danmu/test", b.danmuTest)
	mux.HandleFunc("/app/fntvplus/api/bridge/danmu/diag", b.danmuDiag)
	// [v1.11.0] 弹弹play 开放 API（内置凭证 + 可选自定义凭证）：状态回显 / 连通自检
	mux.HandleFunc("/app/fntvplus/api/bridge/dandanplay/status", b.ddpStatusHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/dandanplay/test", b.ddpTestHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/logos/", b.handleLogoFile)
	mux.HandleFunc("/app/fntvplus/api/bridge/danmaku/prepare", b.danmakuPrepare)
	mux.HandleFunc("/app/fntvplus/api/bridge/skip/external", b.skipExternal)
	mux.HandleFunc("/app/fntvplus/api/bridge/danmaku/candidates", b.danmakuCandidates)
	mux.HandleFunc("/app/fntvplus/api/bridge/danmaku/pick", b.danmakuPick)
	mux.HandleFunc("/app/fntvplus/api/bridge/proxy/test", b.proxyTest)
	// [v1.10.0] 扩展数据源（官方开放 API）：Fanart.tv 高清 Logo / TVMaze 分集兜底 / OMDb IMDb 评分
	mux.HandleFunc("/app/fntvplus/api/bridge/fanart/logos", b.fanartLogosHandler)
	mux.HandleFunc("/app/fntvplus/api/bridge/tvmaze/show", b.tvmazeShowHandler)
	mux.HandleFunc("/app/fntvplus/api/bridge/omdb/rating", b.omdbRatingHandler)
	// [v1.10.x] Jav 番号刮削（个人库整理，默认关）：javbus 抓取 + 封面代理
	mux.HandleFunc("/app/fntvplus/api/bridge/jav/lookup", b.javLookupHandler)
	mux.HandleFunc("/app/fntvplus/api/bridge/jav/image", b.javImageHandler)
}

// muxHandler 返回内部路由表（挂好全部 bridge 子路由的 http.Handler），
// 供 proxy 层统一包鉴权中间件后注册到 /app/fntvplus/api/bridge/ 前缀。
func (b *Bridge) MuxHandler() http.Handler {
	mux := http.NewServeMux()
	b.Mount(mux)
	return mux
}

// Authed 给 handler 套上统一网关身份校验：fnOS 网关转发请求时注入 X-Trim-Userid/
// X-Trim-Username 头（网关已先校验 NAS 登录态）。缺身份头的请求一律 401——
// 防止回环端口的直连访问绕过登录调用 bridge（伪造头需先攻破网关所在的本机）。
func (b *Bridge) Authed(next http.Handler) http.Handler {
	return gateway.RequireGatewayUser(next)
}

/* ========== 通用工具 ========== */

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func genAuthx(path, dataJSON string) string {
	if authxKey == "" || authxSecret == "" {
		return "" // 未注入签名材料：不加 Authx 头，由上游按未签名请求处理
	}
	nonce := fmt.Sprintf("%d", 100000+rand.Intn(900000))
	ts := time.Now().UnixMilli()
	sign := md5hex(strings.Join([]string{authxKey, path, nonce, fmt.Sprintf("%d", ts), md5hex(dataJSON), authxSecret}, "_"))
	return fmt.Sprintf("nonce=%s&timestamp=%d&sign=%s", nonce, ts, sign)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func getSetting(cfg *config.Config, key string) string {
	v, _ := cfg.GetSetting(key)
	return v
}

// customProxyURL 生效中的自定义代理 URL（桌面版 proxyAgent.pickProxyUrl 同款语义）：
// 环境变量 HTTPS_PROXY/HTTP_PROXY 优先；否则须 customProxyEnabled=true 且 customProxy
// 为合法 http(s):// 地址才返回，未启用/非法/脏数据（如历史误存的 "1"）一律返回空串。
func (b *Bridge) customProxyURL() string {
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if s := strings.TrimSpace(os.Getenv(k)); s != "" {
			return s
		}
	}
	if getSetting(b.cfg, "customProxyEnabled") != "1" {
		return ""
	}
	raw := strings.TrimSpace(getSetting(b.cfg, "customProxy"))
	if raw == "" {
		return ""
	}
	if pu, err := url.Parse(raw); err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
		return ""
	}
	return raw
}

/* ========== fnOS 签名桥 ========== */

// handleFnOS 通用 fnOS 签名桥：{method, path, body, cookie}。
// path 必须以 /v/api/ 开头（白名单约束）；Authx 由后端本地签名；cookie 由前端转发。
func (b *Bridge) handleFnOS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Method string          `json:"method"`
		Path   string          `json:"path"`
		Body   json.RawMessage `json:"body"`
		Cookie string          `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 512*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	if !strings.HasPrefix(req.Path, "/v/api/") {
		writeErr(w, http.StatusForbidden, "path 必须以 /v/api/ 开头")
		return
	}
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	dataJSON := ""
	if len(req.Body) > 0 && string(req.Body) != "null" {
		bodyReader = strings.NewReader(string(req.Body))
		dataJSON = string(req.Body)
	}
	req2, err := http.NewRequest(method, b.effectiveUpstream()+req.Path, bodyReader)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	if authx := genAuthx(req.Path, dataJSON); authx != "" {
		req2.Header.Set("Authx", authx)
	}
	req2.Header.Set("Content-Type", "application/json")
	if req.Cookie != "" {
		req2.Header.Set("Cookie", req.Cookie)
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

// handleFnOSAuthx [lc-1275] 签名 oracle：网页端 Authx 材料靠「运行时从影视 SPA chunk 提取」，
// fnOS 前端更新导致特征失配后本地签名不可用，旧兜底「捕获回放」的 body 哈希与本次请求
// 不一致——所有带 nonce 的 fnOS POST（getEditDetail/saveEditDetail/image/temp/upload/person
// 等）一律 invalid sign 被拒（用户症状：jav 查询正常但回填失败）。
// 本端点用服务端 env 注入的材料（与官方影视应用一致，永不过期）按请求方送来的
// dataJson 原文计算 Authx 后返回；密钥不出服务端，浏览器仍以同源 fetch 自发请求
// （credentials 保住 httpOnly 会话）。path 白名单与 handleFnOS 同规。
func (b *Bridge) handleFnOSAuthx(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path     string `json:"path"`
		DataJSON string `json:"dataJson"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 512*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	if !strings.HasPrefix(req.Path, "/v/api/") {
		writeErr(w, http.StatusForbidden, "path 必须以 /v/api/ 开头")
		return
	}
	authx := genAuthx(req.Path, req.DataJSON)
	if authx == "" {
		writeErr(w, http.StatusServiceUnavailable, "服务端未注入 Authx 签名材料")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "authx": authx})
}

/* ========== 白名单外部代理 ========== */

func hostAllowed(host string) bool {
	host = strings.ToLower(host)
	for _, suffix := range proxyAllowSuffix {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

// handleProxy 白名单外部代理：{url, method, body, headers}。不带本地 cookie。
func (b *Bridge) handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		URL     string            `json:"url"`
		Method  string            `json:"method"`
		Body    json.RawMessage   `json:"body"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		writeErr(w, http.StatusBadRequest, "bad url")
		return
	}
	if !hostAllowed(u.Hostname()) {
		writeErr(w, http.StatusForbidden, "域名不在白名单: "+u.Hostname())
		return
	}
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = strings.NewReader(string(req.Body))
	}
	req2, err := http.NewRequest(method, req.URL, bodyReader)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	for k, v := range req.Headers {
		if strings.HasPrefix(strings.ToLower(k), "cookie") {
			continue // 不转发本地凭证
		}
		req2.Header.Set(k, v)
	}
	if req2.Header.Get("User-Agent") == "" {
		req2.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "fetch error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

/* ========== TMDB 图片 ========== */

// handleTMDBImage GET ?url=https://image.tmdb.org/... → {ok, dataUrl}（对齐桌面版 tmdb:image 契约）。
// [lc-1274] TMDB 图片代理内存缓存：网页端强刷后轮播 logo/海报逐张重下（走多路网络，
// 慢路 12-20s 超时叠加时以十秒计），用户感知「标题停留很久才出 logo」。
// 命中直接回包不再发起下载。24h TTL + 总量上限（超限放弃缓存新条目，旧条目到期自然腾位）。
var tmdbImgCache sync.Map // string(raw url) → tmdbImgCacheEntry

type tmdbImgCacheEntry struct {
	contentType string
	data        []byte
	at          time.Time
}

const (
	tmdbImgCacheTTL    = 24 * time.Hour
	tmdbImgCacheMaxLen = 64 << 20 // 总字节上限 64MB（w500 logo ≈50KB、海报 ≈100KB，数百张余量）
)

func tmdbImgCachePut(key string, ct string, data []byte) {
	now := time.Now()
	total := int64(0)
	tmdbImgCache.Range(func(k, v any) bool {
		if e, ok := v.(tmdbImgCacheEntry); ok {
			if now.Sub(e.at) > tmdbImgCacheTTL {
				tmdbImgCache.Delete(k)
			} else {
				total += int64(len(e.data))
			}
		}
		return true
	})
	if total+int64(len(data)) > tmdbImgCacheMaxLen {
		return
	}
	tmdbImgCache.Store(key, tmdbImgCacheEntry{contentType: ct, data: data, at: now})
}

func (b *Bridge) handleTMDBImage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少图片地址"})
		return
	}
	// [v0.64.0] 放行为通用图片代理：image.tmdb.org（/t/p/ 路径）+ bgm.tv 系（每日放送
	// Bangumi 源海报 lainpic.bgm.tv 也经此通道，此前被域名白名单 400 拒 → Bangumi 无图）。
	// [v1.10.0] + assets.fanart.tv（Fanart.tv 官方 API 返回的高清 Logo/背景图 CDN 直链）。
	host := u.Hostname()
	allowed := host == "image.tmdb.org" || strings.HasSuffix(host, "bgm.tv") || host == "assets.fanart.tv"
	if !allowed || (host == "image.tmdb.org" && !strings.HasPrefix(u.Path, "/t/p/")) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "仅支持 image.tmdb.org/t/p/、bgm.tv 与 assets.fanart.tv 图片"})
		return
	}
	// [v0.63.0] 多路尝试：自定义代理 → 免梯子直连 IP → 系统直连，任一成功即返回。
	// 每日放送 TMDB 源海报此前单路失败即整批挂（代理对 image.tmdb.org 慢/失败时无兜底）。
	// [lc-1274] 缓存命中先回包（强刷后 logo 秒出，不再逐张重下）。
	if e, ok := tmdbImgCache.Load(raw); ok {
		if ce, ok2 := e.(tmdbImgCacheEntry); ok2 && time.Since(ce.at) < tmdbImgCacheTTL {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":      true,
				"dataUrl": "data:" + ce.contentType + ";base64," + b64encode(ce.data),
				"cached":  true,
			})
			return
		}
	}
	type imgAttempt struct {
		c   *http.Client
		via string
	}
	attempts := []imgAttempt{}
	if proxy := b.customProxyURL(); proxy != "" {
		pu, _ := url.Parse(proxy)
		attempts = append(attempts, imgAttempt{&http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}, "自定义代理"})
	}
	if dc := b.tmdbDirectClient(); dc != nil {
		attempts = append(attempts, imgAttempt{dc, "免梯子直连"})
	}
	attempts = append(attempts, imgAttempt{b.client, "系统直连"})
	var lastErr error
	for _, a := range attempts {
		req, _ := http.NewRequest(http.MethodGet, raw, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
		resp, err := a.c.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("%s：%v", a.via, err)
			continue
		}
		data, readErr := func() ([]byte, error) {
			defer resp.Body.Close()
			return io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
		}()
		if readErr != nil {
			lastErr = fmt.Errorf("%s：%v", a.via, readErr)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s upstream %d", a.via, resp.StatusCode)
			continue
		}
		ct := resp.Header.Get("Content-Type")
		if ct == "" {
			ct = "image/jpeg"
		}
		tmdbImgCachePut(raw, ct, data) // [lc-1274] 仅缓存 200 响应
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"dataUrl": "data:" + ct + ";base64," + b64encode(data),
		})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": lastErr.Error()})
}

/* ========== Trakt ========== */

const traktAPI = "https://api.trakt.tv"
const apiBaseTMDB = "https://api.themoviedb.org/3"
const traktAuth = "https://auth.trakt.tv"

func (b *Bridge) traktClientID() string  { return getSetting(b.cfg, "trakt_client_id") }
func (b *Bridge) traktSecret() string    { return getSetting(b.cfg, "trakt_client_secret") }
func (b *Bridge) traktToken() string     { return getSetting(b.cfg, "trakt_access_token") }
func (b *Bridge) traktRefresh() string   { return getSetting(b.cfg, "trakt_refresh_token") }
func (b *Bridge) traktExpiresAt() string { return getSetting(b.cfg, "trakt_expires_at") }

// traktReq 带凭证调用 trakt API；401 时尝试刷新一次。
func (b *Bridge) traktReq(method, path string, body any) (int, map[string]any, error) {
	call := func() (int, []byte, error) {
		bd, _ := json.Marshal(body)
		req, err := http.NewRequest(method, traktAPI+path, strings.NewReader(string(bd)))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("trakt-api-version", "2")
		req.Header.Set("trakt-api-key", b.traktClientID())
		if tk := b.traktToken(); tk != "" {
			req.Header.Set("Authorization", "Bearer "+tk)
		}
		resp, err := b.client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
		return resp.StatusCode, data, nil
	}
	st, data, err := call()
	if err != nil {
		return 0, nil, err
	}
	if st == http.StatusUnauthorized {
		if b.traktRefreshToken() {
			st, data, err = call()
			if err != nil {
				return 0, nil, err
			}
		}
	}
	var out map[string]any
	if len(data) > 0 {
		_ = json.Unmarshal(data, &out)
		if out == nil {
			out = map[string]any{}
		}
	} else {
		out = map[string]any{}
	}
	return st, out, nil
}

// traktRefreshToken 用 refresh_token 换新 token 并持久化。
func (b *Bridge) traktRefreshToken() bool {
	rt := b.traktRefresh()
	id, sec := b.traktClientID(), b.traktSecret()
	if rt == "" || id == "" || sec == "" {
		return false
	}
	body, _ := json.Marshal(map[string]any{
		"refresh_token": rt, "client_id": id, "client_secret": sec,
		"redirect_uri": "urn:ietf:wg:oauth:2.0:oob", "grant_type": "refresh_token",
	})
	resp, err := b.client.Post(traktAuth+"/oauth/token", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK || out["access_token"] == nil {
		return false
	}
	_ = b.cfg.SetSetting("trakt_access_token", out["access_token"])
	if v, ok := out["refresh_token"]; ok {
		_ = b.cfg.SetSetting("trakt_refresh_token", v)
	}
	if v, ok := out["expires_in"]; ok {
		_ = b.cfg.SetSetting("trakt_expires_at", fmt.Sprintf("%d", time.Now().Add(time.Duration(toInt64(v))*time.Second).UnixMilli()))
	}
	return true
}

// traktCredsHandler 凭证存取（POST 保存 / GET 查询状态）。
func (b *Bridge) traktCredsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			id, tk := b.traktClientID(), b.traktToken()
			// [v1.2.0] 返回明文（管理页同源可信，对齐桌面 get-credentials 回填语义）
			writeJSON(w, http.StatusOK, map[string]any{
				"configured":   id != "" && b.traktSecret() != "",
				"connected":    tk != "",
				"clientId":     id,
				"clientSecret": b.traktSecret(),
				"expiresAt":    toInt64(b.traktExpiresAt()),
			})
		case http.MethodPost:
			var req struct {
				ClientID     string `json:"client_id"`
				ClientSecret string `json:"client_secret"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErr(w, http.StatusBadRequest, "bad json")
				return
			}
			id := strings.TrimSpace(req.ClientID)
			sec := strings.TrimSpace(req.ClientSecret)
			if id == "" || sec == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Client ID 与 Secret 均必填"})
				return
			}
			// 换了应用（token 与 app 绑定）则丢弃旧 token
			if b.traktClientID() != "" && b.traktClientID() != id {
				_ = b.cfg.SetSetting("trakt_access_token", "")
				_ = b.cfg.SetSetting("trakt_refresh_token", "")
				_ = b.cfg.SetSetting("trakt_expires_at", "")
			}
			_ = b.cfg.SetSetting("trakt_client_id", id)
			_ = b.cfg.SetSetting("trakt_client_secret", sec)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func (b *Bridge) traktStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, tk := b.traktClientID(), b.traktToken()
		writeJSON(w, http.StatusOK, map[string]any{
			"configured": id != "" && b.traktSecret() != "",
			"connected":  tk != "",
			"expiresAt":  toInt64(b.traktExpiresAt()),
		})
	}
}

// traktDeviceStart 用已存凭证向 auth.trakt.tv 申请设备码（返回原文给页面展示）。
func (b *Bridge) traktDeviceStart(w http.ResponseWriter, r *http.Request) {
	id := b.traktClientID()
	if id == "" || b.traktSecret() == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写 Trakt Client ID 与 Secret"})
		return
	}
	body, _ := json.Marshal(map[string]any{"client_id": id})
	resp, err := b.client.Post(traktAuth+"/oauth/device/code", "application/json", strings.NewReader(string(body)))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK {
		out["error"] = fmt.Sprintf("device/code %d", resp.StatusCode)
	}
	writeJSON(w, resp.StatusCode, out)
}

// traktDeviceCancel 前端停止轮询即可（后端无持久轮询状态），占位幂等。
func (b *Bridge) traktDeviceCancel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktDisconnect 吊销 token 并清空凭证。
func (b *Bridge) traktDisconnect(w http.ResponseWriter, r *http.Request) {
	if tk := b.traktToken(); tk != "" {
		body, _ := json.Marshal(map[string]any{"access_token": tk, "client_id": b.traktClientID(), "client_secret": b.traktSecret()})
		resp, err := b.client.Post(traktAuth+"/oauth/revoke", "application/json", strings.NewReader(string(body)))
		if err == nil {
			_ = resp.Body.Close()
		}
	}
	for _, k := range []string{"trakt_access_token", "trakt_refresh_token", "trakt_expires_at"} {
		_ = b.cfg.SetSetting(k, "")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktClearCreds [v1.2.0] 清空 Trakt 凭据（网页版 trakt:clear-credentials）。
func (b *Bridge) traktClearCreds(w http.ResponseWriter, r *http.Request) {
	_ = b.cfg.SetSetting("trakt_client_id", "")
	_ = b.cfg.SetSetting("trakt_client_secret", "")
	_ = b.cfg.SetSetting("trakt_access_token", "")
	_ = b.cfg.SetSetting("trakt_refresh_token", "")
	_ = b.cfg.SetSetting("trakt_expires_at", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktDeviceTokenPoll [v1.2.0] 透传一次 device/token 轮询（前端按 interval 调用；
// 400=待授权 200=成功 429=放慢 410=过期 418=拒绝）。
func (b *Bridge) traktDeviceTokenPoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceCode string `json:"device_code"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req)
	id, sec := b.traktClientID(), b.traktSecret()
	if id == "" || sec == "" || req.DeviceCode == "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "缺少凭据或设备码"})
		return
	}
	body, _ := json.Marshal(map[string]any{"code": req.DeviceCode, "client_id": id, "client_secret": sec})
	resp, err := b.client.Post(traktAuth+"/oauth/device/token", "application/json", strings.NewReader(string(body)))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out == nil {
		out = map[string]any{}
	}
	writeJSON(w, resp.StatusCode, out)
}

// traktTokenSave [v1.2.0] 保存设备授权成功的 token（前端轮询到 200 后调用）。
func (b *Bridge) traktTokenSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    any    `json:"expires_in"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&req)
	if strings.TrimSpace(req.AccessToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "缺少 access_token"})
		return
	}
	_ = b.cfg.SetSetting("trakt_access_token", req.AccessToken)
	if req.RefreshToken != "" {
		_ = b.cfg.SetSetting("trakt_refresh_token", req.RefreshToken)
	}
	if ei := toInt64(req.ExpiresIn); ei > 0 {
		_ = b.cfg.SetSetting("trakt_expires_at", fmt.Sprintf("%d", time.Now().Add(time.Duration(ei)*time.Second).UnixMilli()))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktScrobble {action, guid, progress, cookie}：
// 后端用转发的 cookie + 本地 Authx 调 fnOS play/info 解析 trim_id → tmdb id → 调 trakt scrobble。
func (b *Bridge) traktScrobble(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action   string  `json:"action"`
		GUID     string  `json:"guid"`
		Progress float64 `json:"progress"`
		Cookie   string  `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	if b.traktToken() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Trakt 未连接"})
		return
	}
	pct := int(req.Progress + 0.5)
	if pct < 0 {
		pct = 0
	} else if pct > 100 {
		pct = 100
	}
	// fnOS play/info（签名 + cookie 转发）
	body, _ := json.Marshal(map[string]any{"item_guid": req.GUID})
	req2, _ := http.NewRequest(http.MethodPost, b.effectiveUpstream()+"/v/api/v1/play/info", strings.NewReader(string(body)))
	if authx := genAuthx("/v/api/v1/play/info", string(body)); authx != "" {
		req2.Header.Set("Authx", authx)
	}
	req2.Header.Set("Content-Type", "application/json")
	if req.Cookie != "" {
		req2.Header.Set("Cookie", req.Cookie)
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	var pr map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&pr)
	resp.Body.Close()
	data, _ := pr["data"].(map[string]any)
	item, _ := data["item"].(map[string]any)
	if item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败"})
		return
	}
	trimID, _ := item["trim_id"].(string)
	tmdbID := trimToTmdb(trimID)
	isEpisode := fmt.Sprintf("%v", item["type"]) == "Episode"
	var traktBody map[string]any
	if isEpisode {
		if tmdbID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "剧集缺少 TMDB id，无法 scrobble"})
			return
		}
		traktBody = map[string]any{
			"progress": pct,
			"show":     map[string]any{"ids": map[string]any{"tmdb": tmdbID}},
			"episode": map[string]any{
				"season": toInt64(item["season_number"]), "number": toInt64(item["episode_number"]),
			},
		}
	} else {
		if tmdbID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "电影缺少 TMDB id，无法 scrobble"})
			return
		}
		traktBody = map[string]any{"progress": pct, "movie": map[string]any{"ids": map[string]any{"tmdb": tmdbID}}}
	}
	st, _, err := b.traktReq(http.MethodPost, "/scrobble/"+req.Action, traktBody)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	if st >= 400 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "code": st, "message": fmt.Sprintf("scrobble %d", st)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": st})
}

// traktSyncWatched {cookie}：item/list 拉已识别作品 → 逐个解析 tmdb id → /sync/history 批量标记。
// 桌面版同名功能的精简移植（搜索匹配/进度细节后续补全）。
func (b *Bridge) traktSyncWatched(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cookie string `json:"cookie"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if b.traktToken() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Trakt 未连接"})
		return
	}
	body, _ := json.Marshal(map[string]any{
		"tags":      map[string]any{"type": []string{"Movie", "TV"}},
		"sort_type": "DESC", "sort_column": "create_time",
		"exclude_grouped_video": 1, "page": 1, "page_size": 200,
	})
	list, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", json.RawMessage(body), browserFnOSCall(r, req.Cookie))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "item/list 失败: " + err.Error()})
		return
	}
	data, _ := list["data"].(map[string]any)
	rawItems, _ := data["list"].([]any)
	movies, shows := []any{}, []any{}
	for _, raw := range rawItems {
		it, _ := raw.(map[string]any)
		tmdbID := trimToTmdb(fmt.Sprintf("%v", it["trim_id"]))
		if tmdbID <= 0 {
			continue
		}
		if fmt.Sprintf("%v", it["type"]) == "Episode" {
			continue
		}
		if fmt.Sprintf("%v", it["type"]) == "Movie" {
			movies = append(movies, map[string]any{"ids": map[string]any{"tmdb": tmdbID}})
		} else {
			shows = append(shows, map[string]any{"ids": map[string]any{"tmdb": tmdbID}})
		}
	}
	st, _, err := b.traktReq(http.MethodPost, "/sync/history", map[string]any{"movies": movies, "shows": shows})
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": st < 400, "code": st,
		"movies": len(movies), "shows": len(shows),
		"message": fmt.Sprintf("已提交 %d 部电影 / %d 部剧集", len(movies), len(shows)),
	})
}

/* ========== TMDB API（logo / show 详情 / 免梯子直连）========== */

// tmdbAPIKey 设置面板填的 TMDB API Key（v3）。
func (b *Bridge) tmdbAPIKey() string { return getSetting(b.cfg, "tmdbApiKey") }

// tmdbDirectOn 「免梯子直连」开关是否开启（面板存 tmdbDirectConnect bool；兼容 "1"/"true" 存法）。
func (b *Bridge) tmdbDirectOn() bool {
	v := strings.ToLower(getSetting(b.cfg, "tmdbDirectConnect"))
	return v == "1" || v == "true"
}

// tmdbDirectIPs 读取存的直连 IP（面板存 tmdbDirectIp 对象 {api, img}；兼容内存 RawMessage/字符串/重启后 map 三种形态）。
func (b *Bridge) tmdbDirectIPs() (apiIP, imgIP string) {
	m := b.cfg.GetMap()
	var parse func(v any) (string, string)
	parse = func(v any) (string, string) {
		switch raw := v.(type) {
		case map[string]any:
			api, _ := raw["api"].(string)
			img, _ := raw["img"].(string)
			return api, img
		case json.RawMessage:
			var out map[string]any
			_ = json.Unmarshal(raw, &out)
			return parse(out)
		case string:
			if strings.HasPrefix(raw, "{") {
				var out map[string]any
				_ = json.Unmarshal([]byte(raw), &out)
				return parse(out)
			}
		}
		return "", ""
	}
	return parse(m["tmdbDirectIp"])
}

// effectiveUpstream 当前生效的 fnOS 上游：config 覆盖值优先（管理页可热改），回退启动推导值。
// [v0.73.0] 修复：bridge 此前固定用启动推导值（如 127.0.0.1:5666），而用户配置的上游覆盖
// （如 18888）只作用于反代主链路 → fnOS 桥（演员作品/跳过片头/播放同步等）连错端口被拒。
func (b *Bridge) effectiveUpstream() string {
	if s := strings.TrimSpace(b.cfg.Get().Upstream); s != "" {
		return strings.TrimRight(s, "/")
	}
	return strings.TrimRight(b.upstream, "/")
}

// tmdbDirectClient 免梯子直连专属客户端（CheckTMDB IP + 域名 SNI）。
// 未开启直连或缺 IP 时返回 nil（供多路兜底探测可用性）。
func (b *Bridge) tmdbDirectClient() *http.Client {
	if !b.tmdbDirectOn() {
		return nil
	}
	apiIP, imgIP := b.tmdbDirectIPs()
	if apiIP == "" && imgIP == "" {
		return nil
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	tr := &http.Transport{
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ip := host
			if host == "api.themoviedb.org" && apiIP != "" {
				ip = apiIP
			} else if host == "image.tmdb.org" && imgIP != "" {
				ip = imgIP
			}
			tlsCfg := &tls.Config{ServerName: host} // SNI/校验用域名
			rawConn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip, port))
			if err != nil {
				return nil, err
			}
			return tls.Client(rawConn, tlsCfg), nil
		},
	}
	return &http.Client{Timeout: 20 * time.Second, Transport: tr}
}

// tmdbClient 返回 TMDB 专用 HTTP 客户端：自定义代理 > 免梯子直连 > 系统 DNS
// （桌面版 withTransport 语义，[lc-052] 补代理优先分支）。
func (b *Bridge) tmdbClient() *http.Client {
	if proxy := b.customProxyURL(); proxy != "" {
		pu, _ := url.Parse(proxy)
		return &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}
	}
	if c := b.tmdbDirectClient(); c != nil {
		return c
	}
	return b.client
}

// tmdbUpdateIP {force}：拉 CheckTMDB hosts 片段 → 抠 api/image 两域最新 IPv4 → 存直连配置。
// force=true（手动点「更新 IP」）强制覆盖；自动刷新语义下尊重手动值（此处仅手动入口）。
func (b *Bridge) tmdbUpdateIP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Force *bool `json:"force"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req)
	force := req.Force == nil || *req.Force

	const ipURL = "https://raw.githubusercontent.com/cnwikee/CheckTMDB/refs/heads/main/Tmdb_host_ipv4"
	req2, _ := http.NewRequest(http.MethodGet, ipURL, nil)
	req2.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	// raw.githubusercontent.com 国内可能被墙：若用户配了自定义代理则走代理
	if proxy := b.customProxyURL(); proxy != "" {
		if pu, err := url.Parse(proxy); err == nil && pu.Scheme != "" {
			tr := &http.Transport{Proxy: http.ProxyURL(pu)}
			client := &http.Client{Timeout: 20 * time.Second, Transport: tr}
			resp, err := client.Do(req2)
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "拉取 CheckTMDB 失败（raw.githubusercontent.com 在国内可能被墙，请手动填 IP 或先开梯子）：" + err.Error()})
				return
			}
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
			_ = resp.Body.Close()
			b.saveDirectIPs(w, string(data), force)
			return
		}
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "拉取 CheckTMDB 失败（raw.githubusercontent.com 在国内可能被墙，请手动填 IP 或先开梯子）：" + err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	b.saveDirectIPs(w, string(data), force)
}

// saveDirectIPs 解析 hosts 片段并持久化直连 IP。
func (b *Bridge) saveDirectIPs(w http.ResponseWriter, text string, force bool) {
	apiIP := pickHostIP(text, "api.themoviedb.org")
	imgIP := pickHostIP(text, "image.tmdb.org")
	if apiIP == "" && imgIP == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未能从 CheckTMDB 解析出 IP（可能返回格式变化）"})
		return
	}
	curAPI, curImg := b.tmdbDirectIPs()
	nextAPI, nextImg := apiIP, imgIP
	if !force { // 非强制：尊重手动值，仅补齐未设字段
		if curAPI != "" {
			nextAPI = curAPI
		}
		if curImg != "" {
			nextImg = curImg
		}
	}
	ipJSON, _ := json.Marshal(map[string]any{"api": nextAPI, "img": nextImg})
	_ = b.cfg.SetSetting("tmdbDirectIp", json.RawMessage(ipJSON))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "api": nextAPI, "img": nextImg})
}

// pickHostIP 从 hosts 片段文本抠指定域名的 IPv4。
func pickHostIP(text, host string) string {
	re := regexp.MustCompile(`(\d{1,3}(?:\.\d{1,3}){3})\s+` + strings.ReplaceAll(host, ".", `.`) + `\b`)
	if m := re.FindStringSubmatch(text); len(m) > 1 {
		return m[1]
	}
	return ""
}

// authForKey TMDB 双格式鉴权（与桌面版一致）：
//   - v4 Read Access Token（JWT，形如 eyJ...）→ Authorization: Bearer 头
//   - v3 API Key（32 位十六进制）→ ?api_key= 查询参数
func authForKey(key string) (bearer string, queryKey string) {
	k := strings.TrimSpace(key)
	if strings.HasPrefix(k, "eyJ") {
		return "Bearer " + k, ""
	}
	return "", k
}

func (b *Bridge) tmdbGet(path string, params map[string]string) (int, map[string]any, error) {
	return b.tmdbGetOpts(path, params, false)
}

// tmdbGetOpts：tmdbGet 的多语言变体。[lc-1274] noLang=true 时不带 language 参数——TMDB 会按
// 原始语言检索，长中文描述性标题在 zh-CN 偏向下常 0 结果（对齐桌面版 lc-1176 无语言兜底）。
func (b *Bridge) tmdbGetOpts(path string, params map[string]string, noLang bool) (int, map[string]any, error) {
	key := b.tmdbAPIKey()
	bearer, queryKey := authForKey(key)
	u, _ := url.Parse("https://api.themoviedb.org/3" + path)
	q := u.Query()
	if !noLang {
		q.Set("language", "zh-CN")
	}
	for k, v := range params {
		q.Set(k, v)
	}
	if queryKey != "" {
		q.Set("api_key", queryKey)
	}
	u.RawQuery = q.Encode()

	// [v0.74.0] 多路尝试：自定义代理 → 免梯子直连 IP → 系统直连。
	// 网络层错误（EOF/超时/重置——典型为代理 keep-alive 复用了已被服务端关闭的连接，
	// 表现为「第一个请求成功、紧接着的下一个请求 EOF」）自动换下一路；服务器有响应
	//（401/429 等）不换路，原样返回状态与错误。
	type tmAttempt struct {
		c   *http.Client
		via string
	}
	attempts := []tmAttempt{}
	if proxy := b.customProxyURL(); proxy != "" {
		pu, _ := url.Parse(proxy)
		attempts = append(attempts, tmAttempt{&http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}, "自定义代理"})
	}
	if dc := b.tmdbDirectClient(); dc != nil {
		attempts = append(attempts, tmAttempt{dc, "免梯子直连"})
	}
	attempts = append(attempts, tmAttempt{b.client, "系统直连"})

	var lastNetErr error
	for _, a := range attempts {
		req, _ := http.NewRequest(http.MethodGet, u.String(), nil)
		req.Header.Set("Accept", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		resp, err := a.c.Do(req)
		if err != nil {
			lastNetErr = fmt.Errorf("%s：%v", a.via, err)
			continue
		}
		var out map[string]any
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&out)
		resp.Body.Close()
		if decodeErr != nil {
			lastNetErr = fmt.Errorf("%s：响应解析失败 %v", a.via, decodeErr)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			format := "未配置"
			if key != "" {
				if bearer != "" {
					format = "v4长Token(JWT Bearer)"
				} else {
					format = "v3短Key(api_key)"
				}
			}
			return resp.StatusCode, out, fmt.Errorf("Key格式=%s", format)
		}
		return resp.StatusCode, out, nil
	}
	return 0, nil, lastNetErr
}

// [lc-1274] tmdb logo 查询结果内存缓存（24h TTL，对齐桌面版 getDailyCached 默认时长）。
// 轮播每次重建/翻页都会为每个条目请求一次 logo，无缓存时反复打 TMDB（慢 + 429 风险）。
// 仅缓存「有结果」的查询（与桌面版语义一致：失败/无结果不缓存，允许后续重试）。
var tmdbLogoCache sync.Map // string → tmdbLogoCacheEntry

type tmdbLogoCacheEntry struct {
	paths []string
	at    time.Time
}

const tmdbLogoCacheTTL = 24 * time.Hour

// tmdbLogo {mediaType, id|title} → {ok, logoPaths:[...]}（/images logos）。
// [lc-1274] 修复「fpk 版首页轮播图获取不到 logo」：用户动漫库在 TMDB 上的 logo 大多只有
// 日语版，而本桥此前 include_image_language 只请求 zh,en,null → 大面积落空。对齐桌面版
// getTmdbLogo（lc-413/lc-947/lc-1176）四点：
//  ①语言集补上 ja（zh,ja,en,null）——动漫 logo 缺失的主根因；
//  ②横屏筛选（width>height，缺失宽高时 aspect_ratio>1，皆缺保守保留）+ 语言优先级排序
//    zh>ja>en>其他、同语言按 vote_average 降序（旧版原样返回未排序数组，首候选可能是
//    竖版/小语种 logo，配合前端「取首个非纯白」逻辑会选错）；
//  ③标题搜索多策略：全角标点归一 → 原文 → 递进截断（首段/两段/16/12/8 字）→
//    无 language 兜底（长中文描述性标题单策略全落空）；
//  ④查询结果内存缓存 24h。
func (b *Bridge) tmdbLogo(w http.ResponseWriter, r *http.Request) {
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key"})
		return
	}
	var req struct {
		MediaType string `json:"mediaType"`
		ID        int64  `json:"id"`
		Title     string `json:"title"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	mt := req.MediaType
	if mt != "movie" && mt != "tv" {
		mt = "tv"
	}
	cacheKey := fmt.Sprintf("logo_%s_%d_%s", mt, req.ID, req.Title)
	if e, ok := tmdbLogoCache.Load(cacheKey); ok {
		if ce, ok2 := e.(tmdbLogoCacheEntry); ok2 && time.Since(ce.at) < tmdbLogoCacheTTL {
			writeJSON(w, http.StatusOK, map[string]any{"ok": len(ce.paths) > 0, "logoPaths": ce.paths, "cached": true})
			return
		}
	}
	id := req.ID
	if id <= 0 && req.Title != "" {
		found, err := b.tmdbSearchID(mt, req.Title)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if found <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "搜索无结果"})
			return
		}
		id = found
	}
	if id <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少 id/title"})
		return
	}
	st, out, err := b.tmdbGet("/"+mt+"/"+fmt.Sprintf("%d", id)+"/images", map[string]string{"include_image_language": "zh,ja,en,null"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if st != http.StatusOK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("images %d", st)})
		return
	}
	logos, _ := out["logos"].([]any)
	paths := tmdbRankLogoPaths(logos)
	if len(paths) > 0 {
		tmdbLogoCache.Store(cacheKey, tmdbLogoCacheEntry{paths: paths, at: time.Now()})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": len(paths) > 0, "logoPaths": paths})
}

// [lc-1274 对齐桌面 lc-413] logo 候选处理：横屏筛选 + 语言优先级排序（zh>ja>en>其他，同语言
// 按票数降序），返回 file_path 列表。独立成纯函数便于单测。
func tmdbRankLogoPaths(logos []any) []string {
	type tmLogoCand struct {
		path string
		lang string
		vote float64
		w, h int
		ar   float64
	}
	// json 解码数字恒为 float64；测试/其他调用方可能传 int，这里都宽容收下
	toF := func(v any) (float64, bool) {
		switch n := v.(type) {
		case float64:
			return n, true
		case int:
			return float64(n), true
		}
		return 0, false
	}
	cands := []tmLogoCand{}
	for _, raw := range logos {
		l, _ := raw.(map[string]any)
		fp, _ := l["file_path"].(string)
		if fp == "" {
			continue
		}
		c := tmLogoCand{path: fp}
		c.lang, _ = l["iso_639_1"].(string)
		if v, ok := toF(l["vote_average"]); ok {
			c.vote = v
		}
		if v, ok := toF(l["width"]); ok {
			c.w = int(v)
		}
		if v, ok := toF(l["height"]); ok {
			c.h = int(v)
		}
		if v, ok := toF(l["aspect_ratio"]); ok {
			c.ar = v
		}
		cands = append(cands, c)
	}
	// 横屏筛选：width>height；缺失宽高退用 aspect_ratio>1；二者皆缺保守保留（交渲染端像素复核）
	landscape := make([]tmLogoCand, 0, len(cands))
	for _, c := range cands {
		ls := true
		if c.w > 0 && c.h > 0 {
			ls = c.w > c.h
		} else if c.ar > 0 {
			ls = c.ar > 1
		}
		if ls {
			landscape = append(landscape, c)
		}
	}
	rank := func(lang string) int {
		if strings.HasPrefix(lang, "zh") {
			return 3
		}
		if lang == "ja" {
			return 2
		}
		if lang == "en" {
			return 1
		}
		return 0
	}
	sort.SliceStable(landscape, func(i, j int) bool {
		ri, rj := rank(landscape[i].lang), rank(landscape[j].lang)
		if ri != rj {
			return ri > rj
		}
		return landscape[i].vote > landscape[j].vote
	})
	paths := make([]string, 0, len(landscape))
	for _, c := range landscape {
		paths = append(paths, c.path)
	}
	return paths
}

// [lc-1274] 多策略标题搜索（对齐桌面版 tmdbSearchBest lc-947/lc-1176），返回首个命中的 tmdb id。
// 返回 (0, nil) = 全部策略无结果；返回 (0, err) = 网络层失败（上游转 502）。
func (b *Bridge) tmdbSearchID(mt, title string) (int64, error) {
	queries := []string{}
	norm := tmdbNormPunct(title)
	if norm != title {
		queries = append(queries, norm)
	}
	queries = append(queries, title)
	for _, q := range tmdbRelaxedTitles(title) {
		dup := false
		for _, have := range queries {
			if have == q {
				dup = true
				break
			}
		}
		if !dup {
			queries = append(queries, q)
		}
	}
	searchOnce := func(q string, noLang bool) (int64, error) {
		st, out, err := b.tmdbGetOpts("/search/"+mt, map[string]string{"query": q, "page": "1"}, noLang)
		if err != nil {
			return 0, err
		}
		if st != http.StatusOK {
			return 0, nil // 服务器有响应（401/429 等）：视为无结果，不中断多策略
		}
		results, _ := out["results"].([]any)
		if len(results) == 0 {
			return 0, nil
		}
		first, _ := results[0].(map[string]any)
		return toInt64(first["id"]), nil
	}
	var lastErr error
	for _, q := range queries {
		id, err := searchOnce(q, false)
		if id > 0 {
			return id, nil
		}
		if err != nil {
			lastErr = err
		}
	}
	// [lc-1176 对齐] 全部策略无果时，去 language 再试前两个查询（TMDB 按原始语言检索）
	retryN := len(queries)
	if retryN > 2 {
		retryN = 2
	}
	for _, q := range queries[:retryN] {
		id, err := searchOnce(q, true)
		if id > 0 {
			return id, nil
		}
		if err != nil {
			lastErr = err
		}
	}
	if lastErr != nil {
		return 0, lastErr
	}
	return 0, nil
}

// [lc-947 对齐] 全角标点归一（修「X，Y」vs TMDB「X,Y」标点形态不同整句匹配失败）
func tmdbNormPunct(s string) string {
	return strings.NewReplacer(
		"，", ",", "、", ",", "；", ";", "：", ":",
		"！", "!", "？", "?", "—", "-", "…", "...",
		"・", "·", "･", "·", "　", " ",
	).Replace(s)
}

// [lc-947 对齐] 递进放宽标题：首段 / 首两段 / 16/12/8 字截断（去描述性后缀兜底）
func tmdbRelaxedTitles(title string) []string {
	out := []string{}
	re := regexp.MustCompile(`[，,、；;：:！!？?。\s…—\-]`)
	segs := []string{}
	for _, s := range re.Split(title, -1) {
		if s = strings.TrimSpace(s); s != "" {
			segs = append(segs, s)
		}
	}
	rcLen := func(s string) int { return len([]rune(s)) }
	if len(segs) > 1 {
		out = append(out, segs[0])
		if len(segs) >= 2 && rcLen(segs[0])+rcLen(segs[1]) <= 20 {
			out = append(out, segs[0]+segs[1])
		}
	}
	runes := []rune(title)
	for _, n := range []int{16, 12, 8} {
		if rcLen(title) > n {
			t := strings.TrimSpace(string(runes[:n]))
			if t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

/* ========== Bangumi / 豆瓣 ========== */

// bangumiCalendar 代理 api.bgm.tv/calendar（bgm.tv 要求自定义 UA）。
// bangumiCalendar 已迁移至 hot.go（[lc-051] 重写为桌面版 fetchCalendar 同款 {ok, items} 形状）。

// doubanStatus 登录状态：[v0.51.0] 改按设置面板粘贴的 doubanCookie 判定（网页端无内嵌
// 浏览器登录途径，桌面版扫码/内嵌会话在网页端不可用）。enabled 同步回传供面板开关回填。
func (b *Bridge) doubanStatus(w http.ResponseWriter, r *http.Request) {
	loggedIn := strings.TrimSpace(getSetting(b.cfg, "doubanCookie")) != ""
	note := "未配置豆瓣 Cookie（在设置面板「手动粘贴 Cookie」）"
	if loggedIn {
		note = "已配置豆瓣 Cookie（网页端手动粘贴）"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "loggedIn": loggedIn,
		"enabled": getSetting(b.cfg, "doubanEnabled") == "1",
		"note":    note,
	})
}

/* ========== 内部工具 ========== */

// callFnOSJSON 带签名 + cookie 的 fnOS 调用，解析 JSON 返回。
// fnOSCall 是服务端调用 fnOS 上游所需的浏览器侧凭证（[访问码] 门禁适配）。
// 门禁开启时上游按 Web 主机校验解锁 Cookie（os-access-code，HttpOnly）——
// document.cookie 里拿不到它，必须用浏览器 fetch 自动附带的全量 Cookie 头；
// 且校验绑定 Host，回环上游请求若带 127.0.0.1 形态 Host 会被重新门禁
// （与 makeProxy 的 Host 保留同一教训，用户报障「输完访问码后无限弹门禁页」）。
type fnOSCall struct {
	Cookie string
	Host   string
}

// browserFnOSCall 从入站请求构建 fnOSCall：优先浏览器自动附带的全量 Cookie 头
// （含 HttpOnly 门禁/会话 Cookie），缺失时回落 body 里带来的 cookie（老 payload 兼容）。
func browserFnOSCall(r *http.Request, fallbackCookie string) fnOSCall {
	c := r.Header.Get("Cookie")
	if c == "" {
		c = fallbackCookie
	}
	return fnOSCall{Cookie: c, Host: r.Host}
}

func (b *Bridge) callFnOSJSON(method, path string, body json.RawMessage, call fnOSCall) (map[string]any, error) {
	var bodyReader io.Reader
	dataJSON := ""
	if len(body) > 0 {
		bodyReader = strings.NewReader(string(body))
		dataJSON = string(body)
	}
	req, err := http.NewRequest(method, b.effectiveUpstream()+path, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authx", genAuthx(path, dataJSON))
	req.Header.Set("Content-Type", "application/json")
	if call.Cookie != "" {
		req.Header.Set("Cookie", call.Cookie)
	}
	// [访问码] 保留浏览器原始 Host：上游按 Web 主机校验解锁 Cookie（同 makeProxy）
	if call.Host != "" {
		req.Host = call.Host
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
	return out, nil
}

// trimToTmdb trim_id（形如 tt123456 / 纯数字）→ TMDB 数字 id；解析失败返回 0。
func trimToTmdb(trimID string) int64 {
	s := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(trimID), "tt"), "TT")
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int64(s[i]-'0')
		if n > 1<<62 {
			return 0
		}
	}
	return n
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		var n int64
		_, _ = fmt.Sscanf(strings.TrimSpace(t), "%d", &n)
		return n
	}
	return 0
}

func b64encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
