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
	"strings"
	"time"

	"fntvplus/internal/config"
)

const authxKey = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
const authxSecret = "16CCEB3D-AB42-077D-36A1-F355324E4237"

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

/* ========== 通用工具 ========== */

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func genAuthx(path, dataJSON string) string {
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
	req2.Header.Set("Authx", genAuthx(req.Path, dataJSON))
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
	req2.Header.Set("Authx", genAuthx("/v/api/v1/play/info", string(body)))
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
	list, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", json.RawMessage(body), req.Cookie)
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
//（如 18888）只作用于反代主链路 → fnOS 桥（演员作品/跳过片头/播放同步等）连错端口被拒。
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
	key := b.tmdbAPIKey()
	bearer, queryKey := authForKey(key)
	u, _ := url.Parse("https://api.themoviedb.org/3" + path)
	q := u.Query()
	q.Set("language", "zh-CN")
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

// tmdbLogo {mediaType, id|title} → {ok, logoPaths:[...]}（/images logos，zh/en/null 语言）。
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
	id := req.ID
	if id <= 0 && req.Title != "" {
		st, out, err := b.tmdbGet("/search/"+mt, map[string]string{"query": req.Title})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if st != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("search %d", st)})
			return
		}
		results, _ := out["results"].([]any)
		if len(results) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "搜索无结果"})
			return
		}
		first, _ := results[0].(map[string]any)
		id = toInt64(first["id"])
	}
	if id <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少 id/title"})
		return
	}
	st, out, err := b.tmdbGet("/"+mt+"/"+fmt.Sprintf("%d", id)+"/images", map[string]string{"include_image_language": "zh,en,null"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if st != http.StatusOK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("images %d", st)})
		return
	}
	logos, _ := out["logos"].([]any)
	paths := []string{}
	for _, raw := range logos {
		l, _ := raw.(map[string]any)
		if fp, ok := l["file_path"].(string); ok && fp != "" {
			paths = append(paths, fp)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": len(paths) > 0, "logoPaths": paths})
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
func (b *Bridge) callFnOSJSON(method, path string, body json.RawMessage, cookie string) (map[string]any, error) {
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
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
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
