// Package bridge —— danmu_diag.go：自建弹幕接口分层诊断。
// [lc-1115/1116] 复刻桌面版 danmuApi.ts 的 diagnose：把「连不上」逐层归因——
//   地址形态 → DNS → TCP → TLS（证书错误归因）→ 服务应答（httptrace 分段耗时 dns/tcp/tls/首字节）。
// 诊断从 NAS 后端发出，与实际弹幕拉取同网络位置，结论真实。
// 诊断结果会被用户整段截图转贴：base 一律脱敏成「协议+host:port+有无路径前缀」（TOKEN 在路径段）。
package bridge

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type diagStep struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	State  string `json:"state"` // ok | warn | fail | skip
	MS     int64  `json:"ms"`
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

// danmuMaskBase base 脱敏：协议+host:port+有无路径前缀（TOKEN 在路径段，绝不一字回显）。
func danmuMaskBase(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return "(无法解析的地址)"
	}
	prefix := strings.TrimRight(u.Path, "/")
	if prefix != "" {
		return u.Scheme + "://" + u.Host + "/<路径前缀·已隐藏>"
	}
	return u.Scheme + "://" + u.Host
}

// danmuClassifyHost 地址分类（回环/私网/CGNAT/公网/域名）——决定「公网连不上」是否「填了仅局域网有效的地址」。
func danmuClassifyHost(host string) string {
	ip := net.ParseIP(host)
	if ip == nil {
		return "域名"
	}
	if ip.IsLoopback() {
		return "回环(仅本机)"
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 169 && v4[1] == 254 {
			return "链路本地(169.254/16)"
		}
		if v4[0] == 10 || (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] == 192 && v4[1] == 168) {
			return "私网(局域网)"
		}
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
			return "CGNAT/隧道段(100.64/10)"
		}
		if v4[0] == 0 {
			return "保留地址"
		}
		return "公网 IP"
	}
	if ip.IsLinkLocalUnicast() {
		return "链路本地(IPv6)"
	}
	return "IPv6 地址"
}

// danmuErrHint 网络层/TLS 错误 → 人话（归因字典，桌面 NET_ERR_HINT/TLS_ERR_HINT 精选）。
func danmuErrHint(errStr string) string {
	type pair struct{ code, hint string }
	table := []pair{
		{"connection refused", "对端明确拒绝：该端口上没有在监听的服务（容器没起 / 端口没映射 / 防火墙 REJECT）。"},
		{"connection reset", "连上就被掐断：端口上跑的可能是别的服务，或反代不认这个 Host/IP。"},
		{"i/o timeout", "包被静默丢弃：公网端口未开放 / 云安全组 / 防火墙 DROP / 路由不可达。"},
		{"no such host", "域名解析不到：域名写错 / 未托管 / DDNS 记录没更新。"},
		{"temporary failure", "DNS 临时失败：本机 DNS 无响应或抖动——这类失败天然是间歇性的。"},
		{"certificate is valid for", "证书里的名字与所连地址不符。"},
		{"self-signed certificate", "自签证书：证书不是任何 CA 签发的（NAS/反代用 openssl 自签常见）。"},
		{"certificate signed by unknown authority", "签发 CA 不被本机信任 / 证书链不完整。"},
		{"certificate has expired", "证书已过期。"},
		{"no route to host", "本机没有到该地址的路由：不在同一网段且没有可达网关。"},
		{"network is unreachable", "本机对应网络接口未启用：断网 / VPN 或 Tailscale 未连接。"},
	}
	lower := strings.ToLower(errStr)
	for _, p := range table {
		if strings.Contains(lower, p.code) {
			return p.hint
		}
	}
	return ""
}

// danmuDiag POST {base, timeoutMs, repeats, keyword} → 逐层诊断报告 {ok, steps, summary, maskedBase}。
func (b *Bridge) danmuDiag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Base      string `json:"base"`
		TimeoutMs int64  `json:"timeoutMs"`
		Repeats   int64  `json:"repeats"`
		Keyword   string `json:"keyword"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	base := strings.TrimSpace(req.Base)
	steps := []diagStep{}
	add := func(id, label, state string, ms int64, detail, hint string) {
		steps = append(steps, diagStep{ID: id, Label: label, State: state, MS: ms, Detail: detail, Hint: hint})
	}
	if base == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "steps": steps, "summary": "缺少服务地址"})
		return
	}
	u, perr := url.Parse(base)
	masked := danmuMaskBase(base)
	if perr != nil || u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "steps": steps, "summary": "地址无法解析（应为 http://IP:端口）"})
		return
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	keyword := strings.TrimSpace(req.Keyword)
	if keyword == "" {
		keyword = "测试"
	}
	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 || timeoutMs > 30000 {
		timeoutMs = 8000
	}
	repeats := req.Repeats
	if repeats <= 0 || repeats > 5 {
		repeats = 3
	}

	// Step 1 地址形态
	add("addr", "地址形态", "ok", 0, danmuClassifyHost(host)+" · "+u.Scheme+" · 端口 "+port, "")

	// Step 2 DNS
	t0 := time.Now()
	ips, dnsErr := net.LookupHost(host)
	dnsMs := time.Since(t0).Milliseconds()
	if dnsErr != nil || len(ips) == 0 {
		add("dns", "DNS 解析", "fail", dnsMs, "解析失败："+dnsErr.Error(), danmuErrHint(dnsErr.Error()))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "steps": steps, "summary": "DNS 解析失败：" + masked})
		return
	}
	add("dns", "DNS 解析", "ok", dnsMs, strings.Join(ips, ", "), "")

	// Step 3 TCP
	t0 = time.Now()
	tcpConn, tcpErr := net.DialTimeout("tcp", net.JoinHostPort(ips[0], port), time.Duration(timeoutMs)*time.Millisecond)
	tcpMs := time.Since(t0).Milliseconds()
	if tcpErr != nil {
		add("tcp", "TCP 连接", "fail", tcpMs, tcpErr.Error()+"（连 "+ips[0]+":"+port+"）", danmuErrHint(tcpErr.Error()))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "steps": steps, "summary": "TCP 连不上：" + masked})
		return
	}
	tcpRemote := tcpConn.RemoteAddr().String()
	tcpConn.Close()
	add("tcp", "TCP 连接", "ok", tcpMs, "已连上 "+tcpRemote, "")

	// Step 4 TLS（https 才有）
	if u.Scheme == "https" {
		t0 = time.Now()
		tlsConn, tlsErr := tls.DialWithDialer(&net.Dialer{Timeout: time.Duration(timeoutMs) * time.Millisecond},
			"tcp", net.JoinHostPort(ips[0], port), &tls.Config{ServerName: host, InsecureSkipVerify: false})
		tlsMs := time.Since(t0).Milliseconds()
		if tlsErr != nil {
			add("tls", "TLS 握手", "fail", tlsMs, tlsErr.Error(), danmuErrHint(tlsErr.Error()))
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "steps": steps, "summary": "TLS 握手失败：" + masked})
			return
		}
		cn := ""
		if state := tlsConn.ConnectionState(); len(state.PeerCertificates) > 0 {
			cn = state.PeerCertificates[0].Subject.CommonName
		}
		tlsConn.Close()
		add("tls", "TLS 握手", "ok", tlsMs, "证书 CN="+cn, "")
	} else {
		add("tls", "TLS 握手", "skip", 0, "http 明文，无 TLS", "")
	}

	// Step 5 服务应答（httptrace 分段：dns/tcp/tls/首字节，repeats 次抖动观察）
	type segTiming struct {
		dns, connect, tls, first int64
	}
	var timings []segTiming
	var httpStates []string
	searchURL := strings.TrimRight(base, "/") + "/api/v2/search/anime?keyword=" + url.QueryEscape(keyword)
	okCount := 0
	firstMs := int64(-1)
	for rep := int64(0); rep < repeats; rep++ {
		var seg segTiming
		t0 := time.Now()
		trace := &httptrace.ClientTrace{
			DNSStart: func(httptrace.DNSStartInfo) { seg.dns = time.Since(t0).Milliseconds() },
			ConnectStart: func(_, _ string) {
				if seg.connect == 0 {
					seg.connect = time.Since(t0).Milliseconds()
				}
			},
			ConnectDone: func(_, _ string, err error) {
				if err == nil && seg.tls == 0 {
					seg.tls = time.Since(t0).Milliseconds()
				}
			},
			GotFirstResponseByte: func() { seg.first = time.Since(t0).Milliseconds() },
		}
		req, _ := http.NewRequest(http.MethodGet, searchURL, nil)
		req.Header.Set("User-Agent", biliUA)
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
		client := &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}
		resp, err := client.Do(req)
		ms := time.Since(t0).Milliseconds()
		timings = append(timings, seg)
		repN := strconv.FormatInt(rep+1, 10)
		if err != nil {
			httpStates = append(httpStates, "第"+repN+"次失败："+err.Error())
			continue
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 256*1024))
		resp.Body.Close()
		if firstMs < 0 || ms < firstMs {
			firstMs = ms
		}
		if resp.StatusCode < 500 {
			okCount++
			httpStates = append(httpStates, "第"+repN+"次 HTTP "+strconv.Itoa(resp.StatusCode)+"（"+strconv.FormatInt(ms, 10)+"ms）")
		} else {
			httpStates = append(httpStates, "第"+repN+"次 HTTP "+strconv.Itoa(resp.StatusCode))
		}
	}
	if okCount > 0 {
		segDetail := "无分段数据"
		if len(timings) > 0 && timings[0].first > 0 {
			s := timings[0]
			segDetail = fmt.Sprintf("dns=%dms tcp=%dms tls=%dms 首字节=%dms（最快 %dms）",
				s.dns, s.connect, s.tls, s.first, firstMs)
		}
		state := "ok"
		if okCount < int(repeats) {
			state = "warn"
		}
		add("http", "服务应答", state, firstMs, strings.Join(httpStates, "；")+" ｜ "+segDetail, "")
	} else {
		detail := strings.Join(httpStates, "；")
		add("http", "服务应答", "fail", 0, detail, danmuErrHint(detail))
	}

	failCount := 0
	for _, s := range steps {
		if s.State == "fail" {
			failCount++
		}
	}
	summary := "全部 " + strconv.Itoa(len(steps)) + " 层通过（" + masked + "）"
	if failCount > 0 {
		summary = fmt.Sprintf("诊断完成：%d 层未通过（%s）", failCount, masked)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "steps": steps, "summary": summary, "maskedBase": masked,
	})
}
