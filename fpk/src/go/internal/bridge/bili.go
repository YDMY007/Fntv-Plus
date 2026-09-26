// Package bridge —— bili.go：B站扫码登录（cookie 持久化）+ 弹幕接口测试 + 自定义代理测试。
// 忠实移植桌面版 biliCookie.js（QR generate/poll/cookie）与 settings.js 的两个 test handler。
package bridge

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

//go:embed qrcode.min.js
var qrcodeLibJS []byte

const biliPassport = "https://passport.bilibili.com/x/passport-login/web/qrcode"

// B站请求头（与桌面版一致：极简 UA + Referer）。
func biliHeaders() map[string]string {
	return map[string]string{
		"User-Agent": "Mozilla/5.0",
		"Referer":    "https://www.bilibili.com",
	}
}

var biliCookieKeys = []string{"SESSDATA", "bili_jct", "buvid3", "buvid4", "DedeUserID", "DedeUserID__ckMd5", "sid", "ac_time_value"}

func (b *Bridge) biliCookie() string      { return getSetting(b.cfg, "bili_cookie") }
func (b *Bridge) biliJar() string         { return getSetting(b.cfg, "bili_jar") }
func (b *Bridge) biliSaveJar(j string)    { _ = b.cfg.SetSetting("bili_jar", j) }
func (b *Bridge) biliSaveCookie(c string) { _ = b.cfg.SetSetting("bili_cookie", c) }

// biliGet 带 UA/Referer/jar 的 GET，返回 (status, body, setCookieHeaders)。
func (b *Bridge) biliGet(rawURL string) (int, []byte, []string) {
	req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	for k, v := range biliHeaders() {
		req.Header.Set(k, v)
	}
	if jar := b.biliJar(); jar != "" {
		req.Header.Set("Cookie", jar)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, nil, nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	return resp.StatusCode, data, resp.Header.Values("Set-Cookie")
}

// harvestSetCookie 从 Set-Cookie 头收集 name=value 片段。
func harvestSetCookie(setCookies []string) string {
	parts := []string{}
	seen := map[string]bool{}
	for _, sc := range setCookies {
		kv := strings.SplitN(sc, ";", 2)[0]
		if kv == "" || strings.HasSuffix(kv, "=") {
			continue
		}
		name := strings.SplitN(kv, "=", 2)[0]
		if !seen[name] {
			seen[name] = true
			parts = append(parts, kv)
		}
	}
	return strings.Join(parts, "; ")
}

// mergeCookie 把新增片段合并进已有 cookie 串（按 name 覆盖，保持原顺序）。
func mergeCookie(base, add string) string {
	if add == "" {
		return base
	}
	values := map[string]string{}
	order := []string{}
	for _, part := range strings.Split(base, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name := strings.SplitN(part, "=", 2)[0]
		if _, ok := values[name]; !ok {
			order = append(order, name)
		}
		values[name] = part
	}
	for _, part := range strings.Split(add, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name := strings.SplitN(part, "=", 2)[0]
		if _, ok := values[name]; !ok {
			order = append(order, name)
		}
		values[name] = part
	}
	out := []string{}
	for _, name := range order {
		out = append(out, values[name])
	}
	return strings.Join(out, "; ")
}

// parseCookieFromUrl 从轮询返回的 url 查询参数里提取 cookie 键值。
func parseCookieFromUrl(u string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return ""
	}
	q := pu.Query()
	parts := []string{}
	for _, k := range biliCookieKeys {
		if v := q.Get(k); v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	return strings.Join(parts, "; ")
}

// cookieUID 从 cookie 串提取 DedeUserID。
func cookieUID(cookie string) string {
	for _, part := range strings.Split(cookie, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "DedeUserID=") {
			return strings.TrimPrefix(part, "DedeUserID=")
		}
	}
	return ""
}

/* ===== Handlers ===== */

// biliQrGenerate POST {} → 获取二维码（返回 {ok, key, url}）。
func (b *Bridge) biliQrGenerate(w http.ResponseWriter, r *http.Request) {
	st, data, setCookies := b.biliGet(biliPassport + "/generate")
	if st == 0 {
		writeErr(w, http.StatusBadGateway, "网络错误：无法访问 B 站")
		return
	}
	if len(setCookies) > 0 {
		b.biliSaveJar(mergeCookie(b.biliJar(), harvestSetCookie(setCookies)))
	}
	var j struct {
		Code int `json:"code"`
		Data struct {
			QrcodeKey string `json:"qrcode_key"`
			URL       string `json:"url"`
		} `json:"data"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(data, &j)
	if j.Code != 0 || j.Data.QrcodeKey == "" {
		msg := j.Message
		if msg == "" {
			msg = fmt.Sprintf("code %d", j.Code)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "key": j.Data.QrcodeKey, "url": j.Data.URL})
}

// biliQrPoll POST {key} → 轮询扫码状态；成功时保存 cookie（{code, status, cookie}）。
func (b *Bridge) biliQrPoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req)
	k := strings.TrimSpace(req.Key)
	if k == "" {
		writeJSON(w, http.StatusOK, map[string]any{"code": -1, "status": "未初始化，请先获取二维码"})
		return
	}
	st, data, setCookies := b.biliGet(biliPassport + "/poll?qrcode_key=" + url.QueryEscape(k))
	if st == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"code": -2, "status": "网络错误"})
		return
	}
	if len(setCookies) > 0 {
		b.biliSaveJar(mergeCookie(b.biliJar(), harvestSetCookie(setCookies)))
	}
	var j struct {
		Code int `json:"code"`
		Data struct {
			Code int    `json:"code"`
			URL  string `json:"url"`
		} `json:"data"`
	}
	_ = json.Unmarshal(data, &j)
	c := j.Data.Code
	switch c {
	case 0:
		ck := parseCookieFromUrl(j.Data.URL)
		if ck == "" {
			ck = harvestSetCookie(setCookies)
		}
		if ck != "" {
			b.biliSaveCookie(mergeCookie(b.biliCookie(), ck))
			writeJSON(w, http.StatusOK, map[string]any{"code": 0, "status": "登录成功，Cookie 已保存", "cookie": ck})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"code": 0, "status": "登录成功但未能解析 Cookie，请重试"})
	case 86038, 86039:
		writeJSON(w, http.StatusOK, map[string]any{"code": c, "status": "二维码已过期，请刷新", "expired": true})
	case 86090, 86101:
		writeJSON(w, http.StatusOK, map[string]any{"code": c, "status": "已扫码，请在手机上点确认"})
	case 86091:
		writeJSON(w, http.StatusOK, map[string]any{"code": c, "status": "请用手机 B站 APP 扫码"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"code": c, "status": fmt.Sprintf("等待中… (状态 %d)", c)})
	}
}

// biliStatusHandler GET → {exists, uid, raw}（与桌面版 handleCookieStatus 对齐）。
func (b *Bridge) biliStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ck := b.biliCookie()
		if ck == "" {
			writeJSON(w, http.StatusOK, map[string]any{"exists": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"exists": true, "uid": cookieUID(ck), "raw": ck})
	}
}

// biliManualCookie POST {raw} → 手动粘贴 cookie 保存。
func (b *Bridge) biliManualCookie(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Raw string `json:"raw"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req)
	raw := strings.TrimSpace(req.Raw)
	if raw == "" {
		writeErr(w, http.StatusBadRequest, "cookie 为空")
		return
	}
	b.biliSaveCookie(raw)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "uid": cookieUID(raw)})
}

// biliClear POST → 清除已存 cookie + 会话 jar。
func (b *Bridge) biliClear(w http.ResponseWriter, r *http.Request) {
	_ = b.cfg.SetSetting("bili_cookie", "")
	_ = b.cfg.SetSetting("bili_jar", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// biliQrLib GET → 返回内嵌的 qrcode.min.js 源码（面板注入后客户端渲染二维码）。
func (b *Bridge) biliQrLib(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(qrcodeLibJS)
}

/* ===== 弹幕接口测试 / 自定义代理测试 ===== */

var danmuBaseRe = regexp.MustCompile(`^https?://[a-z0-9._\-]+(:\d{1,5})?(/[a-z0-9._\-/]*)?$`)

// danmuTest POST {base} → 测试自建弹幕接口连通性（忠实移植桌面版 testConnection）。
func (b *Bridge) danmuTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Base string `json:"base"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	base := strings.TrimRight(strings.TrimSpace(req.Base), "/")
	if base == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "请先填写服务地址"})
		return
	}
	if !danmuBaseRe.MatchString(base) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "地址格式应为 http://IP:端口（如 http://192.168.1.10:9321）"})
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(base + "/api/v2/search/anime?keyword=" + url.QueryEscape("测试"))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "连不上（地址/端口/防火墙/Docker 未运行？）"})
		return
	}
	defer resp.Body.Close()
	var j struct {
		Success      *bool  `json:"success"`
		ErrorMessage string `json:"errorMessage"`
		Animes       []any  `json:"animes"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4*1024*1024)).Decode(&j)
	if j.Success != nil && !*j.Success {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "服务有响应但报错：" + strings.TrimSpace(j.ErrorMessage)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": fmt.Sprintf("连通正常（试搜「测试」返回 %d 条结果）", len(j.Animes))})
}

// proxyTest POST {proxyUrl} → 经代理访问真实数据源，验证代理是否可用。
// 自定义代理主要用于 TMDB（影视发现/海报，国内常需翻墙）与 Bangumi 每日放送；
// 依次尝试多个目标，任一能连通即视为代理有效，返回命中目标与目标延迟。
// 仅支持 http(s) 代理（socks5 需第三方库，已在 UI 层移除该选项）。
func (b *Bridge) proxyTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProxyURL string `json:"proxyUrl"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	raw := strings.TrimSpace(req.ProxyURL)
	if raw == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "地址为空"})
		return
	}
	pu, err := url.Parse(raw)
	if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "地址格式不合法（须 http(s):// 开头，且含主机:端口）"})
		return
	}
	// 代理真正要服务的目标：TMDB（主，常需翻墙）+ Bangumi（次，国内可直连作基准）
	targets := []struct {
		name string
		url  string
	}{
		{"TMDB", "https://api.themoviedb.org/3/trending/all/day"},
		{"Bangumi", "https://api.bgm.tv/calendar"},
	}
	tr := &http.Transport{Proxy: http.ProxyURL(pu)}
	client := &http.Client{Timeout: 10 * time.Second, Transport: tr}
	for _, t := range targets {
		start := time.Now()
		resp, e := client.Get(t.url)
		latency := time.Since(start).Milliseconds()
		if e != nil {
			continue // 该目标失败，尝试下一个
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 500 {
			info := fmt.Sprintf("经代理访问 %s 成功（延迟 %dms，HTTP %d）", t.name, latency, resp.StatusCode)
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": true, "status": resp.StatusCode, "latencyMs": latency, "target": t.name, "info": info,
			})
			return
		}
		info := fmt.Sprintf("经代理可连通 %s，但返回 HTTP %d", t.name, resp.StatusCode)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "status": resp.StatusCode, "latencyMs": latency, "target": t.name, "info": info,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "经代理访问 TMDB / Bangumi 均失败（检查代理地址、端口及可用性）"})
}
